/**
 * Boost: opt-in cloud jobs. Off by default; with it off nothing here touches the
 * network and the app does everything locally. With it on, /api/geo runs heavy
 * jobs on Modal (today: map terrain at 2048 px) and the local build stays the fallback.
 */
import { create } from 'zustand';
import {
  ARTIFACT_FILES,
  ARTIFACT_PART_BYTES,
  INPUT_PART_BYTES,
  MAX_INPUT_PARTS,
  type GeoJobRequest,
  type GeoJobStatus,
  type GeoRestReason,
  type HeroJobCamera,
  type HeroJobRequest,
  HERO_PX,
  type JobInput,
  type NestJobRequest,
  type PackJobRequest,
  type TerrainJobRequest,
} from '../../api/_lib/geoJob.js';
import { cleanSavedNest, nestFingerprint, nestMismatch, type SavedNest } from '../core/nest';
import { heroFingerprintOf, heroScene, readHeroPng, type SavedHero } from '../core/hero';
import { packMismatch } from '../core/packCheck';
import { nestGroupsOf, type Model } from '../core/pipeline';
import { materialOf } from '../core/appearance';
import { serialize, type Project } from '../core/project';
import type { PriceRates } from '../core/price';
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
  /** Hero renders started today (UTC) and the daily limit; missing on a worker from before hero renders. */
  heroToday?: number;
  heroLimit?: number;
}

interface CloudState {
  boost: boolean;
  phase: CloudPhase;
  /** 0..1 while working. */
  progress: number;
  /** Plain words for locked / resting. */
  reason?: string;
  /** The last pack's outcome: a download link, or a red error with no download. */
  notice?: CloudNotice;
  setBoost: (on: boolean) => void;
}

export interface CloudNotice {
  kind: 'ok' | 'error';
  title?: string;
  text: string;
  /** Object URL of a finished download, with its file name. */
  url?: string;
  name?: string;
}

/** Show a notice (revoking the last download link). */
export function setCloudNotice(notice: CloudNotice | undefined): void {
  const prev = useCloud.getState().notice;
  if (prev?.url) URL.revokeObjectURL(prev.url);
  useCloud.setState({ notice });
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
  'needs-input': 'uploading',
  limit: 'daily limit reached',
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
  const asset = await gunzipJson<ImageAsset>(await fetchArtifact(key, ARTIFACT_FILES.terrain, signal));
  if (!asset?.map || asset.map.kind !== 'map' || !asset.depth) throw new CloudUnavailableError('failed');
  return asset;
}

type DoneStatus = Extract<GeoJobStatus, { status: 'done' }>;

/** Thrown when a design is already in the cloud store under its checksum but a part is missing. */
class NeedsInputError extends Error {}

/**
 * Start a job and wait for it. Polls every second; the abort signal cancels the job on
 * the server too. `upload` is called once if the server says the design isn't there yet.
 */
async function startAndWait(req: GeoJobRequest, signal?: AbortSignal, upload?: () => Promise<void>): Promise<DoneStatus> {
  const start = async (): Promise<GeoJobStatus> => {
    const res = await geoFetch('jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal });
    const body = (await res.json().catch(() => ({}))) as GeoJobStatus & { reason?: string };
    if (res.status === 409 && body.reason === 'needs-input') throw new NeedsInputError();
    if (!res.ok) throw new CloudUnavailableError(body.reason ?? (res.status === 503 ? 'not-configured' : 'unreachable'));
    return body;
  };
  let status: GeoJobStatus;
  try {
    status = await start();
  } catch (e) {
    if (!(e instanceof NeedsInputError) || !upload) throw e;
    useCloud.setState({ phase: 'working', progress: 0 });
    await upload();
    status = await start();
  }
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
  if (status.status === 'failed') throw new CloudJobFailedError(status.reason ?? 'failed', status.error);
  return status;
}

/** A job that ran and failed: `detail` is the worker's own words (a fit error, a bad file). */
export class CloudJobFailedError extends CloudUnavailableError {
  constructor(reason: string, public detail?: string) {
    super(reason);
  }
}

/** A finished result's bytes by key and file, fetched in parts (each under the server's response limit). */
async function fetchArtifact(key: string, file: string, signal?: AbortSignal): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let total = 1;
  for (let i = 0; i < total; i++) {
    const path = file === ARTIFACT_FILES.terrain ? `artifacts/${key}?part=${i}` : `artifacts/${key}/${file}?part=${i}`;
    const res = await geoFetch(path, { signal });
    if (!res.ok) throw new CloudUnavailableError(res.status === 503 ? 'not-configured' : 'failed');
    total = Math.max(1, Number(res.headers.get('X-Strata-Parts')) || 1);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > ARTIFACT_PART_BYTES) throw new CloudUnavailableError('failed');
    parts.push(bytes);
  }
  return parts;
}

/** Run a job end to end, leaving the Cloud field ready (or resting, with the reason) afterwards. */
async function withCloud<T>(run: () => Promise<T>, jobErrorsKeepReady = true): Promise<T> {
  try {
    const out = await run();
    if (useCloud.getState().boost) useCloud.setState({ phase: 'ready', progress: 0, reason: undefined });
    return out;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      if (useCloud.getState().phase === 'working') useCloud.setState({ phase: 'ready', progress: 0 });
      throw e;
    }
    // a pack or nest that ran and failed on its own terms (or came back not matching) says why; the cloud itself is fine
    // so does the daily limit on hero renders
    if (e instanceof CloudUnavailableError && e.reason === 'limit') {
      useCloud.setState({ phase: 'ready', progress: 0 });
      throw e;
    }
    if (jobErrorsKeepReady && (e instanceof CloudPackMismatchError || (e instanceof CloudJobFailedError && e.detail && e.reason === 'failed'))) {
      useCloud.setState({ phase: 'ready', progress: 0 });
      throw e;
    }
    rest(e instanceof CloudUnavailableError ? e.reason : 'failed');
    throw e instanceof CloudUnavailableError ? e : new CloudUnavailableError('failed');
  }
}

/** Run a terrain job and return its asset. Throws CloudUnavailableError when the caller should build locally. */
export async function runCloudJob(req: TerrainJobRequest, signal?: AbortSignal): Promise<ImageAsset> {
  return withCloud(async () => {
    const status = await startAndWait(req, signal);
    useCloud.setState({ progress: 0.97 });
    return fetchCloudAsset(status.key, signal);
  }, false);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The design as the cloud sees it: its checksum, and an upload that sends it gzipped in parts. */
export async function designInput(project: Project): Promise<{ input: JobInput; upload: () => Promise<void> }> {
  const raw = new TextEncoder().encode(serialize(project));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const sha = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  const gz = await gzip(raw);
  const parts = Math.max(1, Math.ceil(gz.length / INPUT_PART_BYTES));
  if (parts > MAX_INPUT_PARTS) throw new CloudJobFailedError('failed', `the design is ${(gz.length / 1048576).toFixed(0)} MB zipped, over the cloud's ${(MAX_INPUT_PARTS * INPUT_PART_BYTES) / 1048576} MB`);
  const input = { sha, parts };
  const upload = async () => {
    for (let i = 0; i < parts; i++) {
      await geoJson(`inputs/${sha}?part=${i}&parts=${parts}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64(gz.subarray(i * INPUT_PART_BYTES, (i + 1) * INPUT_PART_BYTES)) }),
      });
      useCloud.setState({ progress: ((i + 1) / parts) * 0.1 });
    }
  };
  return { input, upload };
}

/** Only the rates the CLI reads; anything else saved in Settings stays home. */
function plainRates(r: PriceRates): Record<string, unknown> {
  const { perKg, waste, machinePerHour, setup, perPart, minimum, vat, hardware } = r;
  return { perKg, waste, machinePerHour, setup, perPart, minimum, vat, hardware: { rodPerM: hardware.rodPerM, nut: hardware.nut, washer: hardware.washer } };
}

/** The pack didn't match the design on screen: no download. */
export class CloudPackMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudPackMismatchError';
  }
}

export interface CloudPackResult {
  zip: Uint8Array;
  seconds?: number;
  costUsd?: number;
  cached?: boolean;
}

/**
 * Development and e2e builds only: `localStorage['strata.cloudFault'] = 'drop-plate'` asks a
 * worker run with STRATA_ALLOW_FAULTS=1 to drop a plate. Production builds never send it.
 */
function devFault(): PackJobRequest['fault'] | undefined {
  if (!import.meta.env?.DEV && import.meta.env?.VITE_E2E_MAP_FIXTURES !== '1') return undefined;
  try {
    return localStorage.getItem('strata.cloudFault') === 'drop-plate' ? 'drop-plate' : undefined;
  } catch {
    return undefined;
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The fabrication zip from the cloud, exactly `cli export --zip`, checked against the
 * model on screen: the same plates and parts, or CloudPackMismatchError and no zip.
 */
export async function cloudPack(project: Project, model: Pick<Model, 'sliced'>, rates: PriceRates, signal?: AbortSignal): Promise<CloudPackResult> {
  return withCloud(async () => {
    const { input, upload } = await designInput(project);
    const fault = devFault();
    const req: PackJobRequest = { kind: 'pack', engine: ENGINE_BUILD, input, date: today(), rates: plainRates(rates), ...(fault ? { fault } : {}) };
    const status = await startAndWait(req, signal, upload);
    useCloud.setState({ progress: 0.97 });
    const parts = await fetchArtifact(status.key, ARTIFACT_FILES.pack, signal);
    const zip = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    const wrong = packMismatch(zip, model);
    if (wrong) throw new CloudPackMismatchError(wrong);
    return { zip, seconds: status.seconds, costUsd: status.costUsd, cached: status.cached };
  });
}

export interface CloudNestResult {
  nest: SavedNest;
  seconds?: number;
  costUsd?: number;
  cached?: boolean;
}

/**
 * The cloud's tight nest, checked against the parts on screen (same fingerprint, every
 * part placed once at its size) before it can go into the project.
 */
export async function cloudNest(project: Project, model: Pick<Model, 'sliced' | 'v'>, budget: NestJobRequest['budget'], signal?: AbortSignal): Promise<CloudNestResult> {
  return withCloud(async () => {
    // the saved nest is what this replaces: leave it out of the upload so the key doesn't depend on it
    const { input, upload } = await designInput({ ...project, nest: undefined });
    const status = await startAndWait({ kind: 'nest', engine: ENGINE_BUILD, input, budget }, signal, upload);
    useCloud.setState({ progress: 0.97 });
    const nest = cleanSavedNest(await gunzipJson<unknown>(await fetchArtifact(status.key, ARTIFACT_FILES.nest, signal)));
    if (!nest) throw new CloudJobFailedError('failed', 'the cloud nest was unreadable');
    const v = model.v;
    const groups = nestGroupsOf(model.sliced, String(v.plateMaterial), (k) => materialOf(project.appearance, k, String(v.plateMaterial)));
    if (nest.fingerprint !== nestFingerprint(groups, v.sheetW, v.sheetH, v.partSpacing)) {
      throw new CloudJobFailedError('failed', 'the cloud cut the parts differently from this browser');
    }
    const wrong = nestMismatch(groups, nest.result);
    if (wrong) throw new CloudJobFailedError('failed', wrong);
    return { nest, seconds: status.seconds, costUsd: status.costUsd, cached: status.cached };
  });
}

/** A hero render that shows a different design from the one on screen: not saved. */
export class CloudHeroMismatchError extends CloudPackMismatchError {
  constructor(message: string) {
    super(message);
    this.name = 'CloudHeroMismatchError';
  }
}

export interface CloudHeroResult {
  hero: SavedHero;
  seconds?: number;
  costUsd?: number;
  cached?: boolean;
}

function dataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${base64(png)}`;
}

/**
 * A hero render of the design from `camera`, checked against the model on screen (the
 * worker stamps every PNG with the plates, parts and fingerprint it rendered) before it
 * can go into the project and the build pack.
 */
export async function cloudHero(project: Project, model: Model, camera: HeroJobCamera, light: HeroJobRequest['light'], signal?: AbortSignal): Promise<CloudHeroResult> {
  return withCloud(async () => {
    // the saved render is what this replaces: leave it out of the upload so the key doesn't depend on it
    const { input, upload } = await designInput({ ...project, hero: undefined });
    const status = await startAndWait({ kind: 'hero', engine: ENGINE_BUILD, input, camera, light, px: HERO_PX }, signal, upload);
    useCloud.setState({ progress: 0.97 });
    const png = new Uint8Array(await new Blob((await fetchArtifact(status.key, ARTIFACT_FILES.hero, signal)) as BlobPart[]).arrayBuffer());
    const stamp = readHeroPng(png);
    if (!stamp) throw new CloudJobFailedError('failed', 'the render came back without saying what it shows');
    const plates = model.sliced.plates.length;
    const parts = model.sliced.parts.length;
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    if (stamp.plates !== plates) throw new CloudHeroMismatchError(`the render shows ${n(stamp.plates, 'plate')} and this design has ${plates}`);
    if (stamp.parts !== parts) throw new CloudHeroMismatchError(`the render shows ${n(stamp.parts, 'part')} and this design has ${parts}`);
    if (stamp.fingerprint !== heroFingerprintOf(heroScene(model, project))) throw new CloudHeroMismatchError('the render shows the design differently from this browser');
    const hero: SavedHero = { kind: 'hero', fingerprint: stamp.fingerprint, png: dataUrl(png), w: stamp.w, h: stamp.h, light, date: today() };
    return { hero, seconds: status.seconds, costUsd: status.costUsd, cached: status.cached };
  });
}
