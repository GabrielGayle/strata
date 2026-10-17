/** Cloud library sync status shown in the toolbar and Projects dialog. */

export type CloudSyncStatus = 'saved' | 'syncing' | 'offline' | 'error' | 'locked';

export interface CloudSyncState {
  status: CloudSyncStatus;
  detail: string | null;
}

let snapshot: CloudSyncState = { status: 'locked', detail: null };
let warning: string | null = null;
const listeners = new Set<() => void>();

export function getCloudSync(): CloudSyncState {
  return snapshot;
}

export function subscribeCloudSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setCloudSync(status: CloudSyncStatus, detail: string | null = null): void {
  if (snapshot.status === status && snapshot.detail === detail) return;
  snapshot = { status, detail };
  for (const fn of listeners) fn();
}

export function setCloudWarning(message: string): void {
  warning = message;
}

export function takeCloudWarning(): string | null {
  const w = warning;
  warning = null;
  return w;
}

export function cloudSyncLabel(status: CloudSyncStatus): string {
  if (status === 'saved') return 'Cloud saved';
  if (status === 'syncing') return 'Syncing…';
  if (status === 'offline') return 'Offline';
  if (status === 'error') return 'Cloud error';
  return 'Cloud locked';
}
