/**
 * Boost: opt-in cloud jobs. Off by default; with it off nothing here touches the
 * network and the app does everything locally. With it on, /api/geo runs heavy
 * jobs on Modal (today: map terrain at 2048 px) and the local build stays the fallback.
 */
import { create } from 'zustand';
import {
  ARTIFACT_PART_BYTES,
  type GeoJobStatus,
  type GeoRestReason,
  type TerrainJobRequest,
} from '../../api/_lib/geoJob.js';
import type { ImageAsset } from '../core/project';
import { ENGINE_BUILD } from '../core/resultCache';
import { readOwnerToken } from './ownerToken';

export const BOOST_KEY = 'strata.boost';

/** locked: no owner passphrase (or a wrong one); resting: set up but unavailable just now. */
export type CloudPhase = 'off' | 'checking' | 'locked' | 'ready' | 'working' | 'resting';

export interface CloudUsage {
  month: string;
  jobs: number;
  estimateUsd: number;
  workspaceUsd: number | null;
  grantUsd: number;
}

interface CloudState {
  boost: boolean;
  phase: CloudPhase;
  /** 0..1 while working. */
  progress: number;
  /** Plain words for locked / resting. */
  reason?: string;
  setBoost: (on: boolean) => void;
}

export function readBoost(ls?: Storage): boolean {
  try {
    return (ls ?? localStorage).getItem(BOOST_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeBoost(on: boolean): void {
  try {
    if (on) localStorage.setItem(BOOST_KEY, 'on');
    else localStorage.removeItem(BOOST_KEY);
  } catch {
    /* private mode */
  }
}

const startBoost = typeof localStorage !== 'undefined' && readBoost();

export const useCloud = create<CloudState>((set) => ({
  boost: startBoost,
  // App runs checkCloud() on start when Boost was left on
  phase: startBoost ? 'checking' : 'off',
  progress: 0,
  setBoost: (on) => {
    writeBoost(on);
    set({ boost: on, phase: on ? 'checking' : 'off', progress: 0, reason: undefined });
    if (on) void checkCloud();
  },
}));

const REST_WORDS: Record<GeoRestReason, string> = {
  'not-configured': 'not set up',
  unreachable: 'offline',
  'out-of-date': 'worker out of date',
  failed: 'job failed',
  busy: 'busy',
};

export function restWords(reason: string | undefined): string {
  return (reason && REST_WORDS[reason as GeoRestReason]) || reason || 'unavailable';
}

/** The status bar's Cloud field. */
export function cloudStatusText(s: Pick<CloudState, 'boost' | 'phase' | 'progress' | 'reason'>): string {
  if (!s.boost) return 'Cloud: off';
  switch (s.phase) {
    case 'checking':
      return 'Cloud: checking…';
    case 'locked':
      return 'Cloud: locked';
    case 'ready':
      return 'Cloud: ready';
    case 'working':
      return `Cloud: working ${Math.round(s.progress * 100)}%`;
    case 'resting':
      return `Cloud: resting: ${s.reason ?? 'unavailable'}`;
    default:
      return 'Cloud: off';
  }
}

/** Thrown for anything that should fall back to the local build. */
export class CloudUnavailableError extends Error {
  constructor(public reason: string) {
    super(`Cloud ${restWords(reason)}`);
    this.name = 'CloudUnavailableError';
  }
}

/** True while Boost is on and the cloud answered its health check. */
export function cloudReady(): boolean {
  const s = useCloud.getState();
  return s.boost && (s.phase === 'ready' || s.phase === 'working');
}

/** Every /api/geo request goes through here, and none leaves while Boost is off. */
async function geoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!useCloud.getState().boost) throw new CloudUnavailableError('off');
  const token = readOwnerToken();
  if (!token) {
    useCloud.setState({ phase: 'locked', reason: 'enter the owner passphrase in Projects' });
    throw new CloudUnavailableError('locked');
  }
  let res: Response;
  try {
    res = await fetch(`/api/geo/${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new CloudUnavailableError('unreachable');
  }
  if (res.status === 401) {
    useCloud.setState({ phase: 'locked', reason: 'owner passphrase not accepted' });
    throw new CloudUnavailableError('locked');
  }
  return res;
}

async function geoJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await geoFetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) {
    const reason = body.reason ?? (res.status === 503 ? 'not-configured' : 'unreachable');
    throw new CloudUnavailableError(reason);
  }
  return body;
}

function rest(reason: string): void {
  if (!useCloud.getState().boost) return;
  if (reason === 'locked') return; // geoFetch already said why
  useCloud.setState({ phase: 'resting', reason: restWords(reason), progress: 0 });
}

/** Ask the server whether the cloud is set up and awake. Sets the phase. */
export async function checkCloud(): Promise<void> {
  if (!useCloud.getState().boost) return;
  useCloud.setState({ phase: 'checking', reason: undefined });
  try {
    const h = await geoJson<{ ok: boolean; engine: string | null }>('health');
    if (h.engine && ENGINE_BUILD !== 'dev' && h.engine !== ENGINE_BUILD) {
      rest('out-of-date');
      return;
    }
    if (useCloud.getState().boost) useCloud.setState({ phase: 'ready', reason: undefined });
  } catch (e) {
    rest(e instanceof CloudUnavailableError ? e.reason : 'unreachable');
  }
}

export async function cloudUsage(): Promise<CloudUsage | null> {
  try {
    return await geoJson<CloudUsage>('usage');
  } catch {
    return null;
  }
}

const POLL_MS = 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function gunzipJson<T>(parts: Uint8Array[]): Promise<T> {
  const stream = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}

/** A finished result by key, fetched in parts (each under the server's response limit). */
export async function fetchCloudAsset(key: string, signal?: AbortSignal): Promise<ImageAsset> {
  const parts: Uint8Array[] = [];
  let total = 1;
  for (let i = 0; i < total; i++) {
    const res = await geoFetch(`artifacts/${key}?part=${i}`, { signal });
    if (!res.ok) throw new CloudUnavailableError(res.status === 503 ? 'not-configured' : 'failed');
    total = Math.max(1, Number(res.headers.get('X-Strata-Parts')) || 1);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > ARTIFACT_PART_BYTES) throw new CloudUnavailableError('failed');
    parts.push(bytes);
  }
  const asset = await gunzipJson<ImageAsset>(parts);
  if (!asset?.map || asset.map.kind !== 'map' || !asset.depth) throw new CloudUnavailableError('failed');
  return asset;
}

/**
 * Run a job and return its result. Polls every second; the abort signal cancels the
 * job on the server too. Throws CloudUnavailableError when the caller should build locally.
 */
export async function runCloudJob(req: TerrainJobRequest, signal?: AbortSignal): Promise<ImageAsset> {
  let status: GeoJobStatus & { key?: string };
  try {
    status = await geoJson('jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal });
    useCloud.setState({ phase: 'working', progress: 0 });
    const id = status.id;
    const onAbort = () => void geoFetch(`jobs/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (status.status === 'running') {
        await sleep(POLL_MS, signal);
        status = await geoJson(`jobs/${id}`, { signal });
        if (status.status === 'running') useCloud.setState({ progress: status.progress });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (status.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
    if (status.status === 'failed') throw new CloudUnavailableError(status.reason ?? 'failed');
    useCloud.setState({ progress: 0.97 });
    const asset = await fetchCloudAsset(status.key, signal);
    if (useCloud.getState().boost) useCloud.setState({ phase: 'ready', progress: 0, reason: undefined });
    return asset;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      if (useCloud.getState().phase === 'working') useCloud.setState({ phase: 'ready', progress: 0 });
      throw e;
    }
    rest(e instanceof CloudUnavailableError ? e.reason : 'failed');
    throw e instanceof CloudUnavailableError ? e : new CloudUnavailableError('failed');
  }
}
