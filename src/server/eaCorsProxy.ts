/** Re-export EA proxy helpers. Implementation lives in `api/_lib` for Vercel Node ESM. */
export {
  EA_ALLOWED_HOST,
  EA_PROXY_MAX_REDIRECTS,
  EA_PROXY_RESPONSE_HEADERS,
  EA_PROXY_TIMEOUT_MS,
  EA_PROXY_MAX_BYTES,
  EaProxyError,
  eaProxyErrorStatus,
  isAllowedEaDataGovHost,
  parseAllowedEaProxyTarget,
  buildEaUpstreamHeaders,
  pickEaProxyResponseHeaders,
  fetchEaUpstream,
} from '../../api/_lib/eaCorsProxy.js';
export type { EaProxyRequest, EaUpstreamResult } from '../../api/_lib/eaCorsProxy.js';
