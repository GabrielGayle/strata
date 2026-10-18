// Postcard visibility: project each card face onto a view plane and measure
// how much of it is hidden by cards in front (2D polygon clipping).
import * as THREE from 'three';
import { circle, difference, intersection, shapeArea, shapeBBox, signedArea, unionShapes, type Path, type Shape, type Vec2 } from './geom2d';
import { objectMatrix, type CutObject } from './objects';
import type { Issue } from './checks';
import type { ShelfSpec } from './shelf';
import { planeToWorld, type Plane } from './section';
import { sightCard, sightSection, type SightCard } from './sightLine';

export type V3 = [number, number, number];

/** Iso camera offset from the 3D view (matches `snapDirection` iso). */
export const ISO_CAMERA_OFFSET: V3 = [0.95, 0.75, 1.25];

export function sphericalFromOffset(x: number, y: number, z: number): { azimuth: number; elevation: number } {
  const azimuth = (Math.atan2(x, z) * 180) / Math.PI;
  const elevation = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
  return { azimuth, elevation };
}

export const DEFAULT_VIEW_AZIMUTH = sphericalFromOffset(...ISO_CAMERA_OFFSET).azimuth;
export const DEFAULT_VIEW_ELEVATION = sphericalFromOffset(...ISO_CAMERA_OFFSET).elevation;

/** Corner nips of this size are still a clean look; bigger than that reads as one card covering another. */
export const DEFAULT_MAX_OVERLAP_MM = 2;
/** A couple of percent of the face can vanish at a corner without hiding the picture. */
export const DEFAULT_MAX_HIDDEN_PCT = 2;
/** Postcard stock can bow by about this much, so a neighbour may catch a corner. */
export const DEFAULT_FLEX_MM = 1.5;

export interface UnobstructedView {
  azimuth: number;
  elevation: number;
  maxOverlapMm: number;
  maxHiddenPct: number;
  flexMm: number;
  unobstructed: boolean;
}

/** Fill viewing numbers so they persist in the project file. */
export function withViewDefaults(s: ShelfSpec, live?: { azimuth: number; elevation: number }): ShelfSpec {
  return {
    ...s,
    viewAzimuth: s.viewAzimuth ?? live?.azimuth ?? DEFAULT_VIEW_AZIMUTH,
    viewElevation: s.viewElevation ?? live?.elevation ?? DEFAULT_VIEW_ELEVATION,
    maxOverlapMm: s.maxOverlapMm ?? DEFAULT_MAX_OVERLAP_MM,
    maxHiddenPct: s.maxHiddenPct ?? DEFAULT_MAX_HIDDEN_PCT,
    flexMm: s.flexMm ?? DEFAULT_FLEX_MM,
    tintHidden: s.tintHidden ?? false,
  };
}

/** Inline camera line from the project’s stored angle (not a leftover session note). */
export function formatCameraNote(
  spec?: Pick<ShelfSpec, 'viewAzimuth' | 'viewElevation'> | null,
  live?: { azimuth: number; elevation: number },
): string {
  const az = spec?.viewAzimuth ?? live?.azimuth ?? DEFAULT_VIEW_AZIMUTH;
  const el = spec?.viewElevation ?? live?.elevation ?? DEFAULT_VIEW_ELEVATION;
  return `Camera ${az.toFixed(0)}° az / ${el.toFixed(0)}° el.`;
}

export function viewSettings(s?: Pick<ShelfSpec, 'unobstructed' | 'viewAzimuth' | 'viewElevation' | 'maxOverlapMm' | 'maxHiddenPct' | 'flexMm'> | null): UnobstructedView {
  return {
    azimuth: s?.viewAzimuth ?? DEFAULT_VIEW_AZIMUTH,
    elevation: s?.viewElevation ?? DEFAULT_VIEW_ELEVATION,
    maxOverlapMm: s?.maxOverlapMm ?? DEFAULT_MAX_OVERLAP_MM,
    maxHiddenPct: s?.maxHiddenPct ?? DEFAULT_MAX_HIDDEN_PCT,
    flexMm: s?.flexMm ?? DEFAULT_FLEX_MM,
    unobstructed: !!s?.unobstructed,
  };
}

export interface ViewBasis {
  eye: V3;
  right: V3;
  up: V3;
}

/** Camera direction from the origin: azimuth 0 is +Z, elevation 0 is the horizon. */
export function viewBasis(azimuthDeg: number, elevationDeg: number): ViewBasis {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const eye: V3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  let right = cross([0, 1, 0], eye);
  if (len(right) < 1e-8) right = cross([0, 0, Math.sign(eye[1]) || 1], eye);
  right = norm(right);
  const up = norm(cross(eye, right));
  return { eye, right, up };
}

export interface CardSight {
  id: string;
  name: string;
  faceArea: number;
  hiddenArea: number;
  hiddenPct: number;
  hiddenMm: number;
  over: boolean;
  /** Hidden region on the facing face, in the card's local XY (mm). */
  localHidden: Shape;
  faceZ: number;
}

export interface VisibilityReport {
  cards: CardSight[];
  hiddenCount: number;
  issues: Issue[];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: V3) {
  return Math.hypot(a[0], a[1], a[2]);
}
function norm(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function applyMat(m: THREE.Matrix4, p: V3): V3 {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
  return [v.x, v.y, v.z];
}

function projectPt(p: V3, b: ViewBasis): Vec2 {
  return [dot(p, b.right), dot(p, b.up)];
}

function convexHull(pts: Vec2[]): Path {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 2) return p;
  const cr = (o: Vec2, a: Vec2, c: Vec2) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const half = (dir: 1 | -1) => {
    const h: Vec2[] = [];
    const seq = dir === 1 ? p : [...p].reverse();
    for (const pt of seq) {
      while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], pt) <= 0) h.pop();
      h.push(pt);
    }
    h.pop();
    return h;
  };
  return half(1).concat(half(-1));
}

function asShape(path: Path): Shape {
  if (path.length < 3) return [];
  const a = signedArea(path);
  if (Math.abs(a) < 1e-6) return [];
  return [{ outer: a >= 0 ? path : [...path].reverse(), holes: [] }];
}

interface PreparedCard {
  object: CutObject;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  front: V3[];
  back: V3[];
  corners: V3[];
  frontN: V3;
  backN: V3;
  facing: 'front' | 'back';
  face: V3[];
  faceN: V3;
  faceZ: number;
  centroid: V3;
  depth: number;
}

function cardCorners(o: CutObject): { matrix: THREE.Matrix4; inverse: THREE.Matrix4; front: V3[]; back: V3[]; corners: V3[]; frontN: V3; backN: V3 } {
  const m = objectMatrix(o);
  const inv = m.clone().invert();
  const hw = o.w / 2;
  const hh = o.h / 2;
  const hd = o.d / 2;
  const localFront: V3[] = [
    [-hw, -hh, hd],
    [hw, -hh, hd],
    [hw, hh, hd],
    [-hw, hh, hd],
  ];
  const localBack: V3[] = [
    [hw, -hh, -hd],
    [-hw, -hh, -hd],
    [-hw, hh, -hd],
    [hw, hh, -hd],
  ];
  const front = localFront.map((p) => applyMat(m, p));
  const back = localBack.map((p) => applyMat(m, p));
  const rot = new THREE.Matrix3().setFromMatrix4(m);
  const nFront = new THREE.Vector3(0, 0, 1).applyMatrix3(rot).normalize();
  const nBack = new THREE.Vector3(0, 0, -1).applyMatrix3(rot).normalize();
  return {
    matrix: m,
    inverse: inv,
    front,
    back,
    corners: [...front, ...back],
    frontN: [nFront.x, nFront.y, nFront.z],
    backN: [nBack.x, nBack.y, nBack.z],
  };
}

function prepare(o: CutObject, b: ViewBasis): PreparedCard {
  const g = cardCorners(o);
  const frontDot = dot(g.frontN, b.eye);
  const backDot = dot(g.backN, b.eye);
  const facing: 'front' | 'back' = frontDot >= backDot ? 'front' : 'back';
  const face = facing === 'front' ? g.front : g.back;
  const faceN = facing === 'front' ? g.frontN : g.backN;
  const centroid: V3 = [
    face.reduce((s, p) => s + p[0], 0) / 4,
    face.reduce((s, p) => s + p[1], 0) / 4,
    face.reduce((s, p) => s + p[2], 0) / 4,
  ];
  return {
    object: o,
    ...g,
    facing,
    face,
    faceN,
    faceZ: facing === 'front' ? o.d / 2 : -o.d / 2,
    centroid,
    depth: dot(centroid, b.eye),
  };
}

function occluderShape(card: PreparedCard, b: ViewBasis): Shape {
  return asShape(convexHull(card.corners.map((p) => projectPt(p, b))));
}

/** Disks at the four face corners: nips this big may touch or catch a neighbour. */
function cornerAllowance(face: Shape, card: PreparedCard, b: ViewBasis, radius: number): Shape {
  if (radius <= 1e-6 || !face.length) return [];
  const pads = unionShapes(...card.face.map((p) => circle(projectPt(p, b)[0], projectPt(p, b)[1], radius)));
  return pads.length ? intersection(face, pads) : [];
}

function faceShape(card: PreparedCard, b: ViewBasis): Shape {
  return asShape(card.face.map((p) => projectPt(p, b)));
}

function unprojectToLocal(poly: Shape, card: PreparedCard, b: ViewBasis): Shape {
  const n = card.faceN;
  const denom = dot(b.eye, n);
  if (Math.abs(denom) < 1e-6) return [];
  const C = card.face[0];
  const mapPt = (uv: Vec2): Vec2 | null => {
    const u = uv[0];
    const v = uv[1];
    const t = (dot(C, n) - u * dot(b.right, n) - v * dot(b.up, n)) / denom;
    const world: V3 = [u * b.right[0] + v * b.up[0] + t * b.eye[0], u * b.right[1] + v * b.up[1] + t * b.eye[1], u * b.right[2] + v * b.up[2] + t * b.eye[2]];
    const local = applyMat(card.inverse, world);
    return [local[0], local[1]];
  };
  const out: Shape = [];
  for (const e of poly) {
    const outer = e.outer.map(mapPt);
    if (outer.some((p) => !p)) continue;
    const holes = e.holes.map((h) => h.map(mapPt)).filter((h) => h.every(Boolean)) as Path[];
    out.push({ outer: outer as Path, holes });
  }
  return out;
}

function hiddenMmOf(hidden: Shape): number {
  if (!hidden.length) return 0;
  const bb = shapeBBox(hidden);
  return Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
}

function fmtPct(x: number) {
  if (x >= 10) return x.toFixed(0);
  if (x >= 1) return x.toFixed(1);
  return x.toFixed(2);
}

function fmtMm(x: number) {
  return x >= 10 ? x.toFixed(0) : x.toFixed(1);
}

export function hiddenMessage(c: CardSight): string {
  return `${c.name} is ${fmtPct(c.hiddenPct)}% hidden (${fmtMm(c.hiddenMm)} mm / ${fmtMm(c.hiddenArea)} mm²) from this viewing angle.`;
}

function issuesFor(report: Pick<VisibilityReport, 'cards' | 'hiddenCount'>, on: boolean): Issue[] {
  const issues: Issue[] = [];
  // A hidden face is a look, not a cut: warn when Unobstructed view is on so Export ZIP still runs.
  const sev: Issue['severity'] = on ? 'warn' : 'info';
  for (const c of report.cards) {
    if (!c.over) continue;
    issues.push({ partId: c.id, type: 'hidden', severity: sev, message: hiddenMessage(c) });
  }
  if (on && report.cards.length && report.hiddenCount === 0) {
    issues.push({ partId: null, type: 'hidden', severity: 'info', message: 'Unobstructed view: every postcard face is visible.' });
  }
  return issues;
}

/** A cut plate piece, for plate-in-front checks. */
export interface PlateSlab {
  plane: Plane;
  thickness: number;
  shape: Shape;
}

/** Plate material standing in a card's sight line, as seen from the eye. */
function plateOccluders(sight: SightCard, plates: PlateSlab[], b: ViewBasis): Shape[] {
  const out: Shape[] = [];
  for (const p of plates) {
    const sec = sightSection(sight, b.eye, p.plane, p.thickness);
    if (!sec.length) continue;
    const hit = intersection(p.shape, sec);
    if (shapeArea(hit) < 0.05) continue;
    for (const w of [-p.thickness / 2, p.thickness / 2]) {
      const map = (q: Vec2) => projectPt(planeToWorld(p.plane, q[0], q[1], w), b);
      out.push(hit.map((e) => ({ outer: e.outer.map(map), holes: e.holes.map((h) => h.map(map)) })));
    }
  }
  return out;
}

export interface VisibilityOptions {
  /** Cut plates: material between a card face and the eye hides it too. */
  plates?: PlateSlab[];
  /** Strip along each card's bottom edge the plates hold (mm); plates may cover it. */
  seat?: number;
}

/** How much of each card face is occluded by cards (and plates) in front, from `view`. */
export function cardVisibility(cards: CutObject[], view: UnobstructedView, opts: VisibilityOptions = {}): VisibilityReport {
  const b = viewBasis(view.azimuth, view.elevation);
  const padR = view.maxOverlapMm + view.flexMm;
  const prepared = cards.filter((c) => c.on && c.kind === 'card').map((c) => prepare(c, b));
  const sights: CardSight[] = prepared.map((card, i) => {
    const face = faceShape(card, b);
    const faceArea = shapeArea(face);
    const edgeOn = faceArea < 1 || Math.abs(dot(card.faceN, b.eye)) < 0.02;
    if (edgeOn) {
      const over = 100 > view.maxHiddenPct;
      return {
        id: card.object.id,
        name: card.object.name,
        faceArea: Math.max(faceArea, card.object.w * card.object.h * 0.01),
        hiddenArea: card.object.w * card.object.h,
        hiddenPct: 100,
        hiddenMm: Math.min(card.object.w, card.object.h),
        over,
        localHidden: [],
        faceZ: card.faceZ,
      };
    }
    const occluders: Shape[] = [];
    for (let j = 0; j < prepared.length; j++) {
      if (j === i) continue;
      const other = prepared[j];
      if (other.depth <= card.depth + 0.05) continue;
      const occ = occluderShape(other, b);
      if (occ.length) occluders.push(occ);
    }
    const sight = opts.plates?.length ? sightCard(card.object, opts.seat ?? 0, 0) : null;
    if (sight) occluders.push(...plateOccluders(sight, opts.plates!, b));
    const mask = occluders.length ? unionShapes(...occluders) : [];
    const rawHidden = mask.length ? intersection(face, mask) : [];
    const allowed = cornerAllowance(face, card, b, padR);
    const excess = allowed.length && rawHidden.length ? difference(rawHidden, allowed) : rawHidden;
    const hiddenArea = shapeArea(excess);
    const hiddenPct = faceArea > 1e-6 ? (100 * hiddenArea) / faceArea : 0;
    const hiddenMm = hiddenMmOf(excess);
    const over = hiddenPct > view.maxHiddenPct + 1e-6 && hiddenArea > 0.25;
    return {
      id: card.object.id,
      name: card.object.name,
      faceArea,
      hiddenArea,
      hiddenPct,
      hiddenMm,
      over,
      localHidden: unprojectToLocal(excess, card, b),
      faceZ: card.faceZ,
    };
  });
  const hiddenCount = sights.filter((c) => c.over).length;
  const report = { cards: sights, hiddenCount, issues: [] as Issue[] };
  report.issues = issuesFor(report, view.unobstructed);
  return report;
}

function shelfCardsOf(objects: Array<CutObject | { object: CutObject }>): CutObject[] {
  return objects
    .map((o) => ('object' in o && o.object ? o.object : (o as CutObject)))
    .filter((o) => o.kind === 'card' && o.on && o.id.startsWith('shelf'));
}

/** Visibility of the postcard-shelf cards among placed objects (undefined when there is no shelf). */
export function reportShelfVisibility(objects: Array<CutObject | { object: CutObject }>, spec: ShelfSpec | undefined, plates?: PlateSlab[]): VisibilityReport | undefined {
  if (!spec?.on) return undefined;
  const cards = shelfCardsOf(objects);
  if (!cards.length) return undefined;
  return cardVisibility(cards, viewSettings(spec), { plates, seat: spec.seat });
}

/** Unit direction from the shelf toward its viewing eye. */
export function shelfEye(spec: ShelfSpec): V3 {
  const v = viewSettings(spec);
  return viewBasis(v.azimuth, v.elevation).eye;
}

/**
 * What Unobstructed view clears out of the plates: each shelf card's sight line above its seat,
 * toward the chosen eye (null when the tool is off).
 */
export function shelfSight(objects: Array<CutObject | { object: CutObject }>, spec: ShelfSpec | undefined): { eye: V3; cards: SightCard[] } | null {
  if (!spec?.on || !spec.unobstructed) return null;
  const cards = shelfCardsOf(objects).flatMap((o) => sightCard(o, spec.seat, o.clearance) ?? []);
  return cards.length ? { eye: shelfEye(spec), cards } : null;
}

/** Cache key: view numbers always; placement lives on the object list identity. */
export function shelfViewKey(spec: ShelfSpec | undefined): string {
  if (!spec?.on) return '';
  const v = viewSettings(spec);
  return [v.azimuth, v.elevation, v.maxOverlapMm, v.maxHiddenPct, v.flexMm, v.unobstructed ? 1 : 0].join('\0');
}

/** Cache key for placing cards: view numbers only matter while the solver is on. */
export function shelfLayoutKey(spec: ShelfSpec | undefined): string {
  if (!spec) return '';
  const place = [
    spec.on,
    spec.cards,
    spec.layout,
    spec.radius,
    spec.gap,
    spec.rows,
    spec.rowStep,
    spec.rowRise,
    spec.seat,
    spec.lean,
    spec.thick,
    spec.clearance,
    spec.shoulder,
    spec.x,
    spec.z,
    spec.turn,
    spec.lift,
    spec.trim,
    JSON.stringify(spec.overrides ?? {}),
  ].join('\0');
  if (!spec.unobstructed) return place;
  const v = viewSettings(spec);
  return `${place}\0${v.azimuth}\0${v.elevation}\0${v.maxOverlapMm}\0${v.maxHiddenPct}\0${v.flexMm}`;
}
