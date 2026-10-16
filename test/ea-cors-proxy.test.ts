import { describe, expect, it } from 'vitest';
import { isAllowedEaDataGovHost, parseAllowedEaProxyTarget } from '../src/server/eaCorsProxy';

describe('EA CORS proxy allowlist (T6)', () => {
  it('allows environment.data.gov.uk and subdomains only', () => {
    expect(isAllowedEaDataGovHost('environment.data.gov.uk')).toBe(true);
    expect(isAllowedEaDataGovHost('spatial.environment.data.gov.uk')).toBe(true);
    expect(isAllowedEaDataGovHost('srsp-ows.jncc.gov.uk')).toBe(false);
    expect(isAllowedEaDataGovHost('evil.com')).toBe(false);
  });

  it('parses allowed HTTPS targets', () => {
    const u = parseAllowedEaProxyTarget('https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m');
    expect(u.hostname).toBe('environment.data.gov.uk');
  });

  it('rejects other hosts', () => {
    expect(() => parseAllowedEaProxyTarget('https://example.com/secret')).toThrow(/not allowed/i);
  });
});
