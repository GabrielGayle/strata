// Share links: a design's settings packed into the URL hash (#s=…) so it can
// be sent to someone. Only parameters and small state travel (pour, hand
// moves, materials, cut objects, postcard shelf, world origin, variants'
// settings); pictures, depth data, meshes and shadow pictures stay behind,
// because they would make the link enormous.
// The receiver is told what was left out.
import { inflateSync } from 'fflate';
import { deserialize, type Project } from './project';

export const SHARE_PARAM = 's';
/** Links longer than this may be cut off by chat apps, mail clients and some browsers. */
export const LONG_LINK = 8000;

/** What a share link carries. */
export interface ShareState {
  format: 'strata-share';
  v: 1;
  name: string;
  params: Project['params'];
  locks: Project['locks'];
  pour: Project['pour'];
  moves?: Project['moves'];
  appearance?: Project['appearance'];
  /** Cut objects, postcard shelf and world origin: plain numbers and text, so they travel. */
  objects?: Project['objects'];
  shelf?: Project['shelf'];
  candles?: Project['candles'];
  origin?: Project['origin'];
  /** Variants with their settings only (no pictures, composition or shadow pictures). */
  variants?: Pick<Project['variants'][number], 'id' | 'name' | 'params' | 'locks' | 'pour' | 'moves' | 'appearance' | 'objects' | 'shelf' | 'candles' | 'origin' | 'createdAt'>[];
  /** Plain-language list of what the sender had that the link leaves out. */
  omitted?: string[];
}

const SLOT_NAMES: Record<string, string> = { top: 'top', front: 'front', side: 'side' };

/** What a share link of this project leaves behind, in words. Empty when nothing is lost. */
export function omittedFrom(p: Project): string[] {
  const out: string[] = [];
  const slots = Object.entries(p.images).filter(([, a]) => a);
  if (slots.length) out.push(`${slots.map(([s]) => SLOT_NAMES[s] ?? s).join(', ')} image${slots.length > 1 ? 's' : ''}`);
  if (slots.some(([, a]) => a?.depth)) out.push('depth from photo');
  if (p.composition?.blocks.length) out.push('composer blocks');
  const meshes = Object.values(p.meshes).filter(Boolean).length;
  if (meshes) out.push(`${meshes} imported mesh${meshes > 1 ? 'es' : ''}`);
  if (p.shadow?.frames.length) out.push(`${p.shadow.frames.length} shadow picture${p.shadow.frames.length > 1 ? 's' : ''}`);
  if (p.variants.some((v) => (v.images && Object.values(v.images).some(Boolean)) || v.shadow?.frames.length)) out.push("variants' pictures");
  return out;
}

/** The parts of a project a share link carries. */
export function shareState(p: Project): ShareState {
  const s: ShareState = { format: 'strata-share', v: 1, name: p.name, params: { ...p.params }, locks: { ...p.locks }, pour: p.pour.map((x) => ({ ...x })) };
  if (p.moves && Object.keys(p.moves).length) s.moves = p.moves;
  if (p.appearance) s.appearance = p.appearance;
  if (p.objects?.length) s.objects = p.objects;
  if (p.shelf) s.shelf = p.shelf;
  if (p.candles) s.candles = p.candles;
  if (p.origin) s.origin = p.origin;
  if (p.variants.length) {
    s.variants = p.variants.map((v) => ({
      id: v.id,
      name: v.name,
      params: v.params,
      locks: v.locks,
      pour: v.pour,
      ...(v.moves ? { moves: v.moves } : {}),
      ...(v.appearance ? { appearance: v.appearance } : {}),
      ...(v.objects !== undefined ? { objects: v.objects } : {}),
      ...(v.shelf !== undefined ? { shelf: v.shelf } : {}),
      ...(v.candles !== undefined ? { candles: v.candles } : {}),
      ...(v.origin !== undefined ? { origin: v.origin } : {}),
      createdAt: v.createdAt,
    }));
  }
  const omitted = omittedFrom(p);
  if (omitted.length) s.omitted = omitted;
  return s;
}

/** A project from a share link, cleaned up the same way a project file is. */
export function projectFromShare(s: ShareState): Project {
  if (!s || s.format !== 'strata-share') throw new Error('Not a Strata share link');
  return deserialize(
    JSON.stringify({
      format: 'strata-project',
      version: 1,
      name: s.name,
      params: s.params,
      locks: s.locks,
      pour: s.pour,
      images: {},
      meshes: {},
      variants: s.variants ?? [],
      moves: s.moves,
      appearance: s.appearance,
      objects: s.objects,
      shelf: s.shelf,
      candles: s.candles,
      origin: s.origin,
    }),
  );
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('The share link is damaged');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  w.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const hasStreams = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

/**
 * Pack a share state for the URL: "z" + base64url of deflate-raw JSON when
 * the browser can compress, else "j" + base64url of the plain JSON.
 */
export async function encodeShare(s: ShareState, opts: { compress?: boolean } = {}): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  if (opts.compress ?? hasStreams()) {
    try {
      return 'z' + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
    } catch {
      /* fall back to plain */
    }
  }
  return 'j' + toBase64Url(json);
}

export async function decodeShare(code: string): Promise<ShareState> {
  const kind = code[0];
  const bytes = fromBase64Url(code.slice(1));
  let json: Uint8Array;
  if (kind === 'z') {
    try {
      json = typeof DecompressionStream !== 'undefined' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : inflateSync(bytes);
    } catch {
      throw new Error('The share link is damaged or cut short');
    }
  } else if (kind === 'j') json = bytes;
  else throw new Error('Not a Strata share link');
  let s: ShareState;
  try {
    s = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error('The share link is damaged or cut short');
  }
  if (!s || s.format !== 'strata-share') throw new Error('Not a Strata share link');
  return s;
}

/** The share code in a URL hash ("#s=…"), if there is one. */
export function shareCodeFromHash(hash: string): string | null {
  const h = hash.replace(/^#/, '');
  for (const part of h.split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === SHARE_PARAM && part.length > i + 1) return part.slice(i + 1);
  }
  return null;
}

/** A full link to this design, built on `base` (the page's address without its hash). */
export async function shareLink(p: Project, base: string, opts?: { compress?: boolean }): Promise<{ url: string; omitted: string[]; long: boolean }> {
  const s = shareState(p);
  const url = `${base.replace(/#.*$/, '')}#${SHARE_PARAM}=${await encodeShare(s, opts)}`;
  return { url, omitted: s.omitted ?? [], long: url.length > LONG_LINK };
}
