import type { Path, Vec2 } from './geom2d';
import type { MapSpec } from './mapSpec';

export type OsmEngraveKind = 'road' | 'water' | 'rail' | 'golf' | 'piste' | 'other';

export interface OsmEngraveLine {
  kind: OsmEngraveKind;
  path: Path;
}

export interface OsmEngraveText {
  text: string;
  /** Normalised 0..1 on the depth image (nx west→east, ny north-up / row 0 = north). Plate mapping flips nx so east sits at part minX. */
  nx: number;
  ny: number;
}

export interface MapEngraveArt {
  imageW: number;
  imageH: number;
  lines: OsmEngraveLine[];
  texts: OsmEngraveText[];
  /** ODbL attribution string to etch / BOM. */
  osmAttribution: string;
}

export interface SerializedMapEngraveArt {
  imageW: number;
  imageH: number;
  lines: { kind: OsmEngraveKind; path: [number, number][] }[];
  texts: OsmEngraveText[];
  osmAttribution: string;
}

export function serializeMapEngraveArt(art: MapEngraveArt): SerializedMapEngraveArt {
  return {
    imageW: art.imageW,
    imageH: art.imageH,
    lines: art.lines.map((l) => ({ kind: l.kind, path: l.path.map(([x, y]) => [tenth(x), tenth(y)]) })),
    texts: art.texts,
    osmAttribution: art.osmAttribution,
  };
}

/** Engrave art is in grid pixels; 0.1 px is 0.05 mm on a 500 mm, 1024 px map. */
function tenth(v: number): number {
  return Math.round(v * 10) / 10;
}

export function deserializeMapEngraveArt(raw: SerializedMapEngraveArt): MapEngraveArt {
  return {
    imageW: raw.imageW,
    imageH: raw.imageH,
    lines: raw.lines.map((l) => ({ kind: l.kind, path: l.path.map(([x, y]) => [x, y]) })),
    texts: raw.texts,
    osmAttribution: raw.osmAttribution,
  };
}

interface OsmWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

interface OsmResponse {
  elements?: OsmWay[];
}

function kindOf(tags: Record<string, string> | undefined): OsmEngraveKind {
  if (!tags) return 'other';
  if (tags.golf || tags.leisure === 'golf_course') return 'golf';
  if (tags['piste:type'] || tags.aerialway) return 'piste';
  if (tags.natural === 'water' || tags.waterway) return 'water';
  if (tags.railway) return 'rail';
  if (tags.highway) return 'road';
  return 'other';
}

function lonLatToNorm(lon: number, lat: number, bbox: MapSpec['bbox']): Vec2 {
  const [w, s, e, n] = bbox;
  const nx = (lon - w) / (e - w);
  const ny = (n - lat) / (n - s);
  return [nx, ny];
}

function labelsFromOsm(
  elements: OsmWay[],
  bbox: MapSpec['bbox'],
  want: Set<string>,
): OsmEngraveText[] {
  if (!want.has('labels') && !want.has('label')) return [];
  const cands: { text: string; nx: number; ny: number; score: number }[] = [];
  for (const el of elements) {
    const name = el.tags?.name?.trim();
    if (!name || name.length > 22) continue;
    const geom = el.geometry;
    if (!geom?.length) continue;
    const kind = kindOf(el.tags);
    if (kind === 'other' && !el.tags?.place) continue;
    const mid = geom[Math.floor(geom.length / 2)];
    const [nx, ny] = lonLatToNorm(mid.lon, mid.lat, bbox);
    if (nx < 0.06 || nx > 0.94 || ny < 0.12 || ny > 0.9) continue;
    cands.push({ text: name, nx, ny, score: geom.length + (kind === 'water' ? 6 : 0) });
  }
  cands.sort((a, b) => b.score - a.score);
  const texts: OsmEngraveText[] = [];
  for (const c of cands) {
    if (texts.some((t) => t.text === c.text)) continue;
    if (texts.some((t) => Math.hypot(t.nx - c.nx, t.ny - c.ny) < 0.12)) continue;
    texts.push({ text: c.text, nx: c.nx, ny: c.ny });
    if (texts.length >= 16) break;
  }
  return texts;
}

/** Convert Overpass JSON with `out geom` into normalised engrave linework. */
export function osmToEngraveArt(
  raw: unknown,
  bbox: MapSpec['bbox'],
  imageW: number,
  imageH: number,
  features: string[],
): MapEngraveArt {
  const want = new Set(features.map((f) => f.toLowerCase()));
  const allowRoads = want.has('roads') || want.has('road');
  const allowWater = want.has('water');
  const allowRail = want.has('rail') || want.has('roads');
  const allowGolf = want.has('golf') || want.has('fairway') || want.has('green');
  const allowPiste = want.has('ski') || want.has('piste') || want.has('alpine');
  const resp = raw as OsmResponse;
  const lines: OsmEngraveLine[] = [];
  for (const el of resp.elements ?? []) {
    if (el.type !== 'way' || !el.geometry?.length) continue;
    const kind = kindOf(el.tags);
    if (kind === 'road' && !allowRoads) continue;
    if (kind === 'water' && !allowWater) continue;
    if (kind === 'rail' && !allowRail) continue;
    if (kind === 'golf' && !allowGolf) continue;
    if (kind === 'piste' && !allowPiste) continue;
    if (kind === 'other') continue;
    const path: Path = el.geometry.map((g) => {
      const [nx, ny] = lonLatToNorm(g.lon, g.lat, bbox);
      return [nx * imageW, ny * imageH];
    });
    if (path.length >= 2) lines.push({ kind, path });
  }
  return {
    imageW,
    imageH,
    lines,
    texts: labelsFromOsm(resp.elements ?? [], bbox, want),
    osmAttribution: '© OpenStreetMap contributors (ODbL)',
  };
}
