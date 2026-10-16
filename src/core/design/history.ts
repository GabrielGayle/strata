const KEY = 'strata.designHistory.v1';
const MAX = 40;

export interface DesignHistoryEntry {
  text: string;
  at: string;
}

export function historyKey(setupId: string): string {
  return `${KEY}.${setupId}`;
}

export function loadDesignHistory(setupId: string): DesignHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(setupId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DesignHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushDesignHistory(setupId: string, text: string): DesignHistoryEntry[] {
  const prev = loadDesignHistory(setupId).filter((e) => e.text !== text);
  const next = [{ text, at: new Date().toISOString() }, ...prev].slice(0, MAX);
  try {
    localStorage.setItem(historyKey(setupId), JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}
