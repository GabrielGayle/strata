/** EA Defra CORS proxy helpers (ticket T6). Not deployed from this repo — logic only. */

export const EA_ALLOWED_HOST = 'environment.data.gov.uk';

export function isAllowedEaDataGovHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === EA_ALLOWED_HOST || h.endsWith(`.${EA_ALLOWED_HOST}`);
}

/** Reject any target that is not on environment.data.gov.uk (no other map hosts). */
export function parseAllowedEaProxyTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid proxy URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) targets allowed');
  if (!isAllowedEaDataGovHost(url.hostname)) {
    throw new Error(`Host not allowed (only ${EA_ALLOWED_HOST}): ${url.hostname}`);
  }
  return url;
}

export interface EaProxyRequest {
  method: string;
  targetUrl: string;
  range?: string | null;
}

export function buildEaUpstreamHeaders(req: EaProxyRequest): Record<string, string> {
  const headers: Record<string, string> = { Accept: '*/*' };
  if (req.range) headers.Range = req.range;
  return headers;
}
