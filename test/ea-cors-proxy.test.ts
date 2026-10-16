import { describe, expect, it, vi } from 'vitest';
import {
  fetchEaUpstream,
  isAllowedEaDataGovHost,
  parseAllowedEaProxyTarget,
  pickEaProxyResponseHeaders,
} from '../src/server/eaCorsProxy';

describe('EA CORS proxy allowlist (T6)', () => {
  it('allows environment.data.gov.uk and subdomains only', () => {
    expect(isAllowedEaDataGovHost('environment.data.gov.uk')).toBe(true);
    expect(isAllowedEaDataGovHost('spatial.environment.data.gov.uk')).toBe(true);
    expect(isAllowedEaDataGovHost('srsp-ows.jncc.gov.uk')).toBe(false);
    expect(isAllowedEaDataGovHost('evil.com')).toBe(false);
  });

  it('rejects host suffix tricks and non-allowlisted hosts', () => {
    expect(isAllowedEaDataGovHost('environment.data.gov.uk.evil.com')).toBe(false);
    expect(isAllowedEaDataGovHost('notenvironment.data.gov.uk')).toBe(false);
    expect(() => parseAllowedEaProxyTarget('https://environment.data.gov.uk.evil.com/x')).toThrow(/not allowed/i);
    expect(() => parseAllowedEaProxyTarget('https://example.com/secret')).toThrow(/not allowed/i);
  });

  it('rejects http targets', () => {
    expect(() =>
      parseAllowedEaProxyTarget('http://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m'),
    ).toThrow(/https/i);
  });

  it('parses allowed HTTPS targets', () => {
    const u = parseAllowedEaProxyTarget('https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m');
    expect(u.hostname).toBe('environment.data.gov.uk');
  });

  it('strips set-cookie and non-allowlisted response headers', () => {
    const h = new Headers({
      'content-type': 'application/json',
      'set-cookie': 'session=evil',
      'x-powered-by': 'secret',
      etag: '"abc"',
    });
    const picked = pickEaProxyResponseHeaders(h);
    expect(picked['content-type']).toBe('application/json');
    expect(picked.etag).toBe('"abc"');
    expect(picked['set-cookie']).toBeUndefined();
    expect(picked['x-powered-by']).toBeUndefined();
  });

  it('forwards range-related response headers for partial content', () => {
    const h = new Headers({
      'content-type': 'application/octet-stream',
      'content-range': 'bytes 0-1023/4096',
      'accept-ranges': 'bytes',
      'content-length': '1024',
    });
    const picked = pickEaProxyResponseHeaders(h);
    expect(picked['content-range']).toBe('bytes 0-1023/4096');
    expect(picked['accept-ranges']).toBe('bytes');
  });

  it('blocks redirects to a foreign host', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.com/steal' },
      }),
    );
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/safe');
    await expect(fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl })).rejects.toThrow(/not allowed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows redirects that stay on the allowlist', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (_input, _init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://spatial.environment.data.gov.uk/tile' },
        });
      }
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'set-cookie': 'nope=1' },
      });
    }) as typeof fetch;
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/start');
    const out = await fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl });
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('text/plain');
    expect(out.headers['set-cookie']).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchImpl).mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});
