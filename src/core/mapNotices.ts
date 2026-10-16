/** Non-fatal map build messages for UI / CLI (ticket: severity on sourceWarnings). */
export type MapSourceNotice = { severity: 'info' | 'warn'; message: string };

export function mapWarn(message: string): MapSourceNotice {
  return { severity: 'warn', message };
}

export function mapInfo(message: string): MapSourceNotice {
  return { severity: 'info', message };
}

export function noticeMessage(n: MapSourceNotice | string): string {
  return typeof n === 'string' ? n : n.message;
}

export function noticeSeverity(n: MapSourceNotice | string): 'info' | 'warn' {
  return typeof n === 'string' ? 'warn' : n.severity;
}

export function normalizeSourceNotices(raw: unknown): MapSourceNotice[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MapSourceNotice[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) out.push(mapWarn(item.trim()));
    else if (item && typeof item === 'object') {
      const o = item as { severity?: string; message?: string };
      const message = typeof o.message === 'string' ? o.message.trim() : '';
      if (!message) continue;
      const severity = o.severity === 'info' ? 'info' : 'warn';
      out.push({ severity, message });
    }
  }
  return out.length ? out : undefined;
}

export function mapNoticesMatching(notices: MapSourceNotice[] | undefined, re: RegExp, severity?: 'info' | 'warn'): boolean {
  return (notices ?? []).some((n) => re.test(n.message) && (severity == null || n.severity === severity));
}
