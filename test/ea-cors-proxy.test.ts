import { describe, expect, it, vi } from 'vitest';
import {
  EA_PROXY_MAX_BYTES,
  eaProxyErrorStatus,
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
      parseAllowedEaProxyTarget('http://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wcs'),
    ).toThrow(/https/i);
  });

  it('parses allowed HTTPS targets', () => {
    const u = parseAllowedEaProxyTarget(
      'https://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wcs',
    );
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

  it('drops content-length when the upstream body was compressed', () => {
    const gz = pickEaProxyResponseHeaders(new Headers({ 'content-encoding': 'gzip', 'content-length': '100' }));
    expect(gz['content-length']).toBeUndefined();
    const plain = pickEaProxyResponseHeaders(new Headers({ 'content-length': '100' }));
    expect(plain['content-length']).toBe('100');
  });

  it('refuses a declared oversized response without reading it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetchImpl = vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-length': String(EA_PROXY_MAX_BYTES + 1) } }),
    ) as unknown as typeof fetch;
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/big.tif');
    const err = await fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl }).catch((e) => e);
    expect(eaProxyErrorStatus(err)).toBe(413);
    expect(String(err.message)).toMatch(/larger than 16 MB/);
    expect(cancel).toHaveBeenCalled();
  });

  it('stops reading a streamed response once it passes the cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 100) c.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/stream.tif');
    const err = await fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl, maxBytes: 4096 }).catch((e) => e);
    expect(eaProxyErrorStatus(err)).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('passes responses under the cap through intact', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(2048), { status: 200 })) as unknown as typeof fetch;
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/ok.tif');
    const out = await fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl, maxBytes: 4096 });
    expect(out.body?.byteLength).toBe(2048);
  });

  it('times out a hung upstream with 504', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    ) as unknown as typeof fetch;
    const url = parseAllowedEaProxyTarget('https://environment.data.gov.uk/slow');
    const err = await fetchEaUpstream(url, { method: 'GET', headers: {}, fetchImpl, timeoutMs: 20 }).catch((e) => e);
    expect(eaProxyErrorStatus(err)).toBe(504);
    expect(String(err.message)).toMatch(/did not answer/);
  });

  it('answers 502 for a plain upstream failure', () => {
    expect(eaProxyErrorStatus(new Error('ECONNRESET'))).toBe(502);
  });
});
