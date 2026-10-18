/** Browser / Vite dev fetch via the EA CORS proxy (`/api/ea-proxy`). */

export function eaProxyUrl(target: string): string {
  return `/api/ea-proxy?url=${encodeURIComponent(target)}`;
}

export async function fetchEaProxiedBytes(target: string, opts: { range?: string } = {}): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (opts.range) headers.Range = opts.range;
  const res = await fetch(eaProxyUrl(target), { headers });
  if (!res.ok) {
    // The proxy explains its own refusals (over 16 MB, timeout) in a JSON `error`.
    const reason = await res
      .json()
      .then((j: { error?: unknown }) => (typeof j.error === 'string' ? j.error : ''))
      .catch(() => '');
    throw new Error(`EA fetch failed (${res.status})${reason ? `: ${reason}` : `: ${target}`}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchEaBytes(target: string, opts: { range?: string; useProxy?: boolean } = {}): Promise<Uint8Array> {
  const useProxy = opts.useProxy ?? typeof window !== 'undefined';
  if (useProxy) return fetchEaProxiedBytes(target, opts);
  const headers: Record<string, string> = {};
  if (opts.range) headers.Range = opts.range;
  const res = await fetch(target, { headers });
  if (!res.ok) throw new Error(`EA fetch failed (${res.status}): ${target}`);
  return new Uint8Array(await res.arrayBuffer());
}
