// The live regeneration pipeline. Each stage remembers its inputs and only
// re-runs when one of them changes, so editing a value regenerates exactly
// the stages downstream of it.
import type * as THREE from 'three';
import { evaluateParams, PARAMS, scaleFactorFor, type EvalResult, type Values } from './params';
import { buildForm, formSpec, meshVolume, toIndexedMesh, type Form, type IndexedMesh } from './forms';
import { blurSpec } from './blur';
import { processImage, rotate, silhouetteMask, type Gray } from './image';
import { buildHeightField, PLATE_FLOOR_MM, type HeightField } from './heightfield';
import { buildMapHeightField, isMapDepth } from './mapPlateHeight';
import { mapFaceParams } from './mapStack';
import { plateDefs, slice, type SliceResult } from './slicer';
import { attachMapPartEtch } from './mapPartEtch';
import { runChecks, type Issue } from './checks';
import { mountIssues, mountWeightIssue } from './mount';
import { layoutShelfResult, type SolveResult } from './shelfSolve';
import { reportShelfVisibility, shelfEye, shelfLayoutKey, shelfSight, shelfViewKey, type V3, type VisibilityReport } from './shelfView';
import { nest, nestFingerprint, nestGroups, nestMismatch, type NestGroup, type NestOptions, type NestResult, type SavedNest } from './nest';
import { materialKey, materialOf } from './appearance';
import { tuningActive } from './tuning';
import { modesOfOutline } from './beam';
import { buildMoulds, pourPlan, type MouldResult, type PourPlanRow } from './mould';
import { unfold, type UnfoldResult } from './unfold';
import { buildBom, type Bom } from './bom';
import { share } from './memo';
import { carveShadow, isCandle, type CarveResult, type ShadowInput, type ShadowReport } from './shadow';
import type { Project } from './project';
import { buildObjects, type ObjectBuild } from './objects';
import { candleObjects, chokeCircles, sitOnSurface, snapToPlates, surfaceTop } from './candles';
import { intersection, rect, shapeBBox, type Shape } from './geom2d';

/** Top of a plate shape between two u values (plate coordinates), or null where it has no steel. */
function topWithin(s: Shape, u0: number, u1: number): number | null {
  const cut = intersection(s, rect(u0, -20000, u1, 20000));
  return cut.length ? shapeBBox(cut).maxY : null;
}
import { originFrame, toWorld, type Frame } from './origin';
import { baseTop } from './slicer';
import { basePlan } from './base';
import { union } from './geom2d';
import { buildMapSunkenFrameLayout, type SunkenFrameLayout } from './mapSunkenFrame';

export interface Assets {
  sideImg: Gray | null;
  frontImg: Gray | null;
  topImg?: Gray | null;
  insMesh: THREE.BufferGeometry | null;
  srcMesh: THREE.BufferGeometry | null;
  /** Shadow pictures, decoded, in the order of project.shadow.frames. */
  shadowFrames?: (Gray | null)[];
}

/** Every asset the engine reads, in a fixed order. */
export const ASSET_KEYS = ['sideImg', 'frontImg', 'topImg', 'insMesh', 'srcMesh', 'shadowFrames'] as const satisfies readonly (keyof Assets)[];

export interface FormBuild {
  form: Form;
  mesh: IndexedMesh;
  volume: number;
}

export interface StageLog {
  name: string;
  ms: number;
  cached: boolean;
  /** Deferred stage still showing the previous result (fast mode). */
  stale?: boolean;
}

export interface Model {
  ev: EvalResult;
  v: Values;
  insert: FormBuild | null;
  source: FormBuild | null;
  sideImg: Gray | null;
  frontImg: Gray | null;
  topImg: Gray | null;
  hf: HeightField | null;
  sliced: SliceResult;
  /** Placed objects that cut the plates (postcards, boxes…). */
  objects: ObjectBuild[];
  /** Postcard-shelf faces hidden from the viewing angle (undefined when there is no shelf). */
  cardVisibility?: VisibilityReport;
  /** Warnings about the strata field itself (the side picture cut flat by the floor). */
  fieldIssues?: Issue[];
  /** Unobstructed-view solver result (undefined when the flag is off). */
  shelfSolve?: SolveResult;
  /** Direction to the shelf's Unobstructed view eye (world, unit), when there is a shelf. */
  shelfEye?: V3;
  /** The world origin objects and the shelf are measured from. */
  origin: Frame;
  /** Shadow carving: the wall, carved plate grids and how well each frame comes out (null when off). */
  shadow: ShadowReport | null;
  /** The shadow carve is still running on another thread: the plates show uncarved until it lands. */
  shadowPending?: boolean;
  issues: Issue[];
  nested: NestResult;
  moulds: MouldResult;
  mouldNest: NestResult;
  unfolded: UnfoldResult;
  pour: { rows: PourPlanRow[]; total: number; mismatch: number };
  /** Cast tub the flat-stack plates sit in when Map › Sunken concrete frame is on. */
  sunkenFrame: SunkenFrameLayout | null;
  bom: Bom;
  /** Free-free partials of the finished outlines, from the deferred worker. Null when tuning is not free-free. */
  sounding: SoundingMode[] | null;
  stages: StageLog[];
  totalMs: number;
  /** True when deferred stages (checks, nesting, moulds, BOM) are from an earlier state. */
  stale: boolean;
}

export interface SoundingMode {
  key: string;
  /** f1, f2, f3 measured on the cut outline, Hz. */
  hz: number[];
  /** Node fractions from the low end. */
  nodes: number[];
  ms: number;
}

const formKeys = (p: string) => ['Shape', 'X', 'Y', 'Z', 'Rot', 'Length', 'Width', 'Height', 'Taper', 'Sweep', 'Camber', 'Bend', 'Twist', 'Scale'].map((k) => p + k);
const NON_SLICE = new Set([
  ...PARAMS.filter((p) => p.group === 'Mould' || p.group === 'Unfold' || p.group === 'Sun' || p.group === 'Shadow').map((p) => p.id),
  'kerf', 'arcTolerance', 'sheetW', 'sheetH', 'partSpacing', 'dxfMode', 'minPartSize',
  'insTint', 'insMaterial', 'concreteTint', 'pourView', 'erodeAmount', 'slotGap',
]);
const SLICE_KEYS = PARAMS.map((p) => p.id).filter((id) => !NON_SLICE.has(id));
const STRATA_KEYS = ['baseLength', 'baseWidth', 'sliceMode', 'sliceAxis', 'pitch', 'stackHeight', 'erosionAmp', 'erosionScale', 'octaves', 'roughness', 'banding', 'bandHeight', 'coherence', 'crest', 'slope', 'seed', 'imgSideMode', 'imgMix', 'imgRange', 'imgReliefSet', 'imgReliefBase', 'imgReliefDepth', 'imgCutLow', 'imgCutHigh', 'stackSource'];
const BLUR_KEYS = ['imgBlurType', 'imgBlurLength', 'imgBlurAngle', 'imgBlurSpin', 'imgBlurZoom', 'imgBlurX', 'imgBlurY', 'imgBlurFocus', 'imgBlurEdge'];
const IMG_KEYS = ['imgContrast', 'imgSmooth', 'imgInvert', 'imgRotate', ...BLUR_KEYS];
const BASE_KEYS = ['baseOn', 'baseLength', 'baseWidth', 'baseHeight', 'baseCornerChamfer', 'baseEdgeChamfer'];
const CHECK_KEYS = ['minFeature', 'kerf', 'minPartSize', 'sheetW', 'sheetH', 'partSpacing', 'pitch', 'thickness', 'radialHub', 'radialCount', 'sliceMode', 'embedMode', ...BASE_KEYS];
const MOULD_KEYS = [...PARAMS.filter((p) => p.group === 'Mould').map((p) => p.id), ...BASE_KEYS, 'embedDepth', 'thickness', 'insMaterial', 'insShape', 'clearance', 'sliceMode'];
// the wall's size only changes how it is drawn, so it doesn't re-carve
const SHADOW_KEYS = PARAMS.filter((p) => (p.group === 'Shadow' || p.group === 'Sun') && p.id !== 'shadowWallW' && p.id !== 'shadowWallH').map((p) => p.id);
const UNFOLD_KEYS = PARAMS.filter((p) => p.group === 'Unfold').map((p) => p.id);

type Cache = Map<string, { deps: unknown[]; value: unknown; ms: number }>;

/** Runs memoised stages against one cache, logging what each did. */
function stager(cache: Cache, mode: 'fast' | 'full') {
  const stages: StageLog[] = [];
  const out = { stages, stale: false, stage };
  function stage<T>(name: string, deps: unknown[], fn: () => T, deferred = false): T {
    const prev = cache.get(name);
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      stages.push({ name, ms: prev.ms, cached: true });
      return prev.value as T;
    }
    if (deferred && mode === 'fast' && prev) {
      out.stale = true;
      stages.push({ name, ms: prev.ms, cached: true, stale: true });
      return prev.value as T;
    }
    const s = performance.now();
    const value = fn();
    const ms = performance.now() - s;
    cache.set(name, { deps, value, ms });
    stages.push({ name, ms, cached: false });
    return value;
  }
  return out;
}

const pick = (v: Values, keys: string[]) => keys.map((k) => v[k]);

/** Everything the 3D view needs: parameters, forms, images, strata, plates, unfold, pour. */
export type FrontModel = Omit<Model, 'issues' | 'nested' | 'moulds' | 'mouldNest' | 'bom' | 'sounding' | 'stale'>;

/**
 * What the deferred stages read. Plain data only, so it can be posted to a
 * Web Worker (no THREE objects, no functions).
 */
export interface DeferredInput {
  v: Values;
  sliced: SliceResult;
  insert: { mesh: IndexedMesh; minY: number; maxY: number; volume: number } | null;
  pourRows: PourPlanRow[];
  appearance: Project['appearance'];
  /** The cloud's tight nest, used while the parts still match it. */
  savedNest?: SavedNest;
}

export interface DeferredModel {
  issues: Issue[];
  nested: NestResult;
  moulds: MouldResult;
  mouldNest: NestResult;
  bom: Bom;
  sounding: SoundingMode[] | null;
  stages: StageLog[];
  totalMs: number;
  stale: boolean;
}

// one plain insert per form build, so stages keyed on it stay cached
const plainInserts = new WeakMap<FormBuild, NonNullable<DeferredInput['insert']>>();
const plainInsert = (b: FormBuild) => {
  let p = plainInserts.get(b);
  if (!p) plainInserts.set(b, (p = { mesh: b.mesh, minY: b.form.bbox.min.y, maxY: b.form.bbox.max.y, volume: b.volume }));
  return p;
};

export const deferredInput = (f: FrontModel, project: Project): DeferredInput => ({
  v: f.v,
  sliced: f.sliced,
  insert: f.insert ? plainInsert(f.insert) : null,
  pourRows: f.pour.rows,
  appearance: project.appearance,
  ...(project.nest ? { savedNest: project.nest } : {}),
});

/** Profile resolution used while a slider or gizmo is held down (mm; finer settings are coarsened to it). */
export const PREVIEW_SAMPLE_STEP = 4;

/** A shadow carve to run, and what it depends on (compared one by one, by identity). */
export interface CarveJob {
  deps: unknown[];
  v: Values;
  sliced: SliceResult;
  frames: ShadowInput[];
}

export interface FrontOptions {
  /** The coarse pipeline used while dragging (see PREVIEW_SAMPLE_STEP); it doesn't carve shadows. */
  preview?: boolean;
  /**
   * Carves shadows somewhere else (the engine's shadow worker): returns the carve
   * when it is done, or undefined while it runs, and the plates show uncarved.
   * Without it the carve runs here.
   */
  carve?: (job: CarveJob) => CarveResult | undefined;
}

/**
 * The front stages. Fast enough to run on every edit.
 * A `preview` pipeline is the coarse one used while dragging: plate profiles
 * sampled every PREVIEW_SAMPLE_STEP mm at most, no minimum corner radius and no shadow carve.
 */
export function createFrontPipeline(options: FrontOptions = {}) {
  const preview = !!options.preview;
  const cache: Cache = new Map();
  return function computeFront(project: Project, assets: Assets): FrontModel {
    const t0 = performance.now();
    const { stage, stages } = stager(cache, 'full');

    // the top image's on-surface aspect (width across the plates / length along the stack), for "Fit face to image"
    const imgAspect = (() => {
      const g = assets.topImg;
      if (!g) return 1;
      const q = (id: string) => (((Math.round(Number(project.params[id] ?? 0) / 90) % 2) + 2) % 2);
      const swap = (q('imgRotate') + q('topRotate')) % 2 === 1;
      return swap ? g.h / g.w : g.w / g.h;
    })();
    // front and side faces, for their "Fit face to image" options (Image rotate turns both)
    const faceAspect = (g: Gray | null) => {
      if (!g) return 1;
      const swap = (((Math.round(Number(project.params.imgRotate ?? 0) / 90) % 2) + 2) % 2) === 1;
      return swap ? g.h / g.w : g.w / g.h;
    };
    const frontAspect = faceAspect(assets.frontImg);
    const sideAspect = faceAspect(assets.sideImg);
    const mapTop = isMapDepth(project.images.top?.depth) && project.images.top?.map;
    const mapParams = mapTop ? mapFaceParams(project.params) : { raw: project.params, forced: false };
    const ev = stage('Parameters', [mapParams.raw, imgAspect, frontAspect, sideAspect], () => evaluateParams(mapParams.raw, { imgAspect, frontAspect, sideAspect }));
    const v = preview
      ? stage('Preview values', [ev], () =>
          ev.values.sampleStep < PREVIEW_SAMPLE_STEP || ev.values.curveStep < PREVIEW_SAMPLE_STEP || ev.values.minRadius > 0
            ? {
                ...ev.values,
                sampleStep: Math.max(PREVIEW_SAMPLE_STEP, ev.values.sampleStep),
                curveStep: Math.max(PREVIEW_SAMPLE_STEP, ev.values.curveStep),
                // sub-millimetre corner rounding can't be seen mid-drag; the full pass adds it
                minRadius: 0,
              }
            : ev.values,
        )
      : ev.values;

    const mkForm = (prefix: 'ins' | 'src', mesh: THREE.BufferGeometry | null): FormBuild | null => {
      const form = buildForm(formSpec(v, prefix), mesh);
      if (!form) return null;
      const im = toIndexedMesh(form.geometry);
      return { form, mesh: im, volume: meshVolume(im) };
    };
    const mapDepth = mapTop ? project.images.top!.depth : undefined;
    // Vermilion’s default fin insert is a 360 mm dark curve; it is not map terrain.
    const insert = stage('Insert form', [...pick(v, formKeys('ins')), assets.insMesh, !!mapTop], () =>
      mapTop ? null : mkForm('ins', assets.insMesh),
    );
    const source = stage('Source form', [...pick(v, formKeys('src')), v.stackSource, assets.srcMesh], () =>
      v.stackSource === 'form' || v.unfoldTarget === 'source' ? mkForm('src', assets.srcMesh) : null,
    );
    const opts = () => ({ contrast: v.imgContrast, smooth: v.imgSmooth, blur: blurSpec(v), invert: v.imgInvert, rotate: Number(v.imgRotate) });
    const processFace = (img: Gray | null, isMap: boolean, isDepth = false) => {
      if (!img) return null;
      if (isMap) return img;
      return processImage(img, { ...opts(), soft: isDepth });
    };
    const sideImg = stage('Side image', [assets.sideImg, ...pick(v, IMG_KEYS), !!project.images.side?.map, !!project.images.side?.depth], () =>
      processFace(assets.sideImg, !!project.images.side?.map, !!project.images.side?.depth),
    );
    const frontImg = stage('Front image', [assets.frontImg, ...pick(v, IMG_KEYS), !!project.images.front?.map, !!project.images.front?.depth], () =>
      processFace(assets.frontImg, !!project.images.front?.map, !!project.images.front?.depth),
    );
    const topImg = stage('Top image', [assets.topImg ?? null, ...pick(v, IMG_KEYS), !!mapTop, !!project.images.top?.depth], () => processFace(assets.topImg ?? null, !!mapTop, !!project.images.top?.depth));
    const topMask = stage('Top silhouette', [assets.topImg ?? null, v.topOutline, v.topThreshold, v.imgRotate, !!mapTop], () =>
      !mapTop && assets.topImg && v.topOutline !== 'off' ? silhouetteMask(rotate(assets.topImg, Number(v.imgRotate)), String(v.topOutline), v.topThreshold) : null,
    );
    const hf = stage('Strata field', [...pick(v, STRATA_KEYS), sideImg, mapDepth, !!project.userParamOverrides?.stackHeight], () => {
      if (mapDepth) {
        const capMm = project.userParamOverrides?.stackHeight && v.sliceMode !== 'flat' ? v.stackHeight : undefined;
        return buildMapHeightField(v, mapDepth, { capMm });
      }
      return v.stackSource === 'strata' ? buildHeightField(v, sideImg) : null;
    });
    // parts that come out unchanged keep their identity, so checks, nesting and the 3D view skip them
    // which metal each plate is: a string, so it only counts as changed when a plate's metal does
    const mats = materialKey(project.appearance, String(v.plateMaterial));
    const materialFor = (key: string) => materialOf(project.appearance, key, String(v.plateMaterial));
    // tuned plates ring by their own metal, so only then does the metal change the cut
    const origin = stage('World origin', [project.origin, v.baseLength, v.baseWidth, baseTop(v)], () => originFrame(project.origin, v));
    const laid = stage('Postcard shelf', [shelfLayoutKey(project.shelf), baseTop(v), project.shelf?.unobstructed ? origin : 0], () =>
      layoutShelfResult(project.shelf, baseTop(v), project.shelf?.unobstructed ? origin : undefined),
    );
    const onSurface = project.candles?.sit === 'surface' || (project.candles?.sit === 'auto' && !!mapTop);
    // the plates' planes, for candles that line up with them (they depend only on the settings)
    const stackPlanes = stage('Plate planes', [...pick(v, SLICE_KEYS)], () => plateDefs(v).filter((d) => d.family === 'P').map((d) => d.plane));
    const pitch = stackPlanes.length > 1 ? Math.abs((stackPlanes[1].origin[0] - stackPlanes[0].origin[0]) * stackPlanes[0].normal[0] + (stackPlanes[1].origin[2] - stackPlanes[0].origin[2]) * stackPlanes[0].normal[2]) : 0;
    const candles = stage('Candelabra', [project.candles, baseTop(v), onSurface, pitch], () => candleObjects(project.candles, baseTop(v), onSurface, pitch));
    const others = stage('Placed objects', [project.objects, laid, origin], () => [...(project.objects ?? []).map((o) => toWorld(o, origin)), ...laid.cards.map((o) => toWorld(o, origin, true))]);
    // candles sitting into the plates need the plates as they are without them first
    const bare = onSurface
      ? stage('Plate surface', [...pick(v, SLICE_KEYS), hf, insert, source, frontImg, topImg, topMask, project.moves, others, !!mapTop], () => {
          const b = buildObjects(others);
          return slice({ v, hf, source: source?.mesh ?? null, insert: insert?.mesh ?? null, front: frontImg, top: mapTop ? null : topImg, topMask: mapTop ? null : topMask, moves: project.moves, materialFor, objects: b.map((o) => ({ mesh: o.mesh, clearance: o.object.clearance, seat: o.object.seat, shoulder: o.object.shoulder, noCut: o.object.noCut })), mapTerrain: !!mapTop });
        })
      : null;
    const placedCandles = stage('Candles placed', [candles, origin, bare, stackPlanes], () => {
      const w = snapToPlates(
        candles.map((o) => toWorld(o, origin, true)),
        stackPlanes,
        project.candles?.snap ?? 'off',
      );
      return bare ? sitOnSurface(w, (x, z, r) => surfaceTop(bare.parts, x, z, r, topWithin)) : w;
    });
    const objects = stage('Objects', [others, placedCandles], () => buildObjects([...others, ...placedCandles]));
    const sight = stage('Sight lines', [objects, shelfViewKey(project.shelf), project.shelf?.seat], () => shelfSight(objects, project.shelf));
    const cutters = objects.map((o) => ({ mesh: o.mesh, clearance: o.object.clearance, seat: o.object.seat, shoulder: o.object.shoulder, noCut: o.object.noCut }));
    const choke = chokeCircles(objects.map((o) => o.object));
    const holders = objects.flatMap(({ object: o }) => (o.holder ? [{ x: o.x, z: o.z, r: o.w / 2, bottom: o.y - o.h / 2, ry: o.ry, slack: o.clearance, holder: o.holder }] : []));
    const sliced = stage('Slice plates', [...pick(v, SLICE_KEYS), hf, insert, source, frontImg, topImg, topMask, project.moves, tuningActive(v) ? mats : '', objects, sight, !!mapTop, mapParams.forced], () =>
      share(
        cache.get('Slice plates')?.value as SliceResult | undefined,
        slice({
          v,
          hf,
          source: source?.mesh ?? null,
          insert: insert?.mesh ?? null,
          front: frontImg,
          top: mapTop ? null : topImg,
          topMask: mapTop ? null : topMask,
          moves: project.moves,
          materialFor,
          objects: cutters,
          sight,
          candles: holders,
          choke,
          mapTerrain: !!mapTop,
          mapAxisForced: mapParams.forced,
        }),
      ),
    );
    attachMapPartEtch(sliced, project.images.top?.map);
    // checked against the cut plates, so a plate standing in front of a card counts as hiding it
    const cardVisibility = stage('Card visibility', [objects, shelfViewKey(project.shelf), project.shelf?.seat, sliced], () => reportShelfVisibility(objects, project.shelf, sliced.parts));
    // the preview shows the plates uncarved; the full pass that follows the drag carves them
    const shadowWanted = !!v.shadowOn && (!!v.sunOn || isCandle(v)) && v.sliceMode === 'parallel';
    if (preview && shadowWanted) stages.push({ name: 'Shadow carve', ms: 0, cached: true, stale: true });
    const carveDeps = [sliced, ...pick(v, SHADOW_KEYS), assets.shadowFrames, project.shadow];
    const carveFrames = () =>
      (project.shadow?.frames ?? []).flatMap((f, i) => {
        const gray = assets.shadowFrames?.[i];
        return gray ? [{ gray, time: f.time, hold: f.hold }] : [];
      });
    let shadowPending = false;
    const carveElsewhere = (): CarveResult | null => {
      const frames = shadowWanted ? carveFrames() : [];
      if (!frames.length) return null;
      const done = options.carve!({ deps: carveDeps, v, sliced, frames });
      stages.push({ name: 'Shadow carve', ms: done?.report.ms ?? 0, cached: true, stale: !done });
      shadowPending = !done;
      return done ?? null;
    };
    const carved = preview
      ? null
      : options.carve
        ? carveElsewhere()
        : stage('Shadow carve', carveDeps, () => {
            if (!shadowWanted) return null;
            const frames = carveFrames();
            return frames.length ? carveShadow(v, sliced, frames) : null;
          });
    const unfolded = stage('Unfold', [...pick(v, UNFOLD_KEYS), insert, source], () => unfold(v.unfoldTarget === 'source' ? source?.form ?? null : insert?.form ?? null, v));
    const numScope = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
    const pour = stage('Pour plan', [project.pour, ...pick(v, BASE_KEYS)], () => pourPlan(v, project.pour, numScope));
    const finalSliced = carved?.sliced ?? sliced;
    const mapFrame = project.images.top?.map?.sunkenFrame;
    const sunkenFrame = stage(
      'Sunken frame',
      [finalSliced, mapFrame, v.thickness, v.sliceMode, v.baseOn, v.baseLength, v.baseWidth, v.baseHeight, v.baseCornerChamfer],
      () =>
        v.sliceMode === 'flat'
          ? buildMapSunkenFrameLayout(finalSliced, { sunkenFrame: mapFrame }, v.thickness, baseTop(v), v.baseOn ? union([basePlan(v)]) : undefined)
          : null,
    );
    const mounted = mountIssues(v, { candles: placedCandles.some((o) => o.look === 'candle' || o.look === 'tealight'), shelf: !!project.shelf?.on, map: !!mapTop });
    const issuesHere = [...(hf?.floorClip ? [floorClipIssue(hf.floorClip, v, project)] : []), ...mounted];
    const fieldIssues = issuesHere.length ? issuesHere : undefined;
    return { ev, v, insert, source, sideImg, frontImg, topImg, hf, sliced: finalSliced, objects, cardVisibility: cardVisibility ?? undefined, ...(fieldIssues ? { fieldIssues } : {}), shelfSolve: laid.solve ?? undefined, shelfEye: project.shelf?.on ? shelfEye(project.shelf) : undefined, origin, shadow: carved?.report ?? null, ...(shadowPending ? { shadowPending } : {}), unfolded, pour, sunkenFrame, stages, totalMs: performance.now() - t0 };
  };
}

/**
 * The deferred stages: fit checks, nesting, moulds and the BOM. They only read
 * plain data, so the app runs them in a Web Worker (see deferred.worker.ts).
 * Mode 'fast' reuses the last result of any stage whose inputs changed.
 */
/**
 * The metal parts to nest, one group per metal (a laser shop cuts each metal from its
 * own sheet), each with its outline so the nester can fit wavy edges together.
 */
export function nestGroupsOf(sliced: SliceResult, defaultMaterial: string, materialFor: (plateKey: string) => string): NestGroup[] {
  const groups = new Map<string, NestGroup>([[defaultMaterial, { material: defaultMaterial, items: [] }]]);
  // plates share one thickness; a part cut thicker (the steel base plate) goes on its own sheet
  const main = sliced.parts.find((p) => p.family !== 'B')?.thickness;
  for (const p of sliced.parts) {
    const m = materialFor(p.plateKey);
    const thick = main != null && Math.abs(p.thickness - main) > 1e-9 ? p.thickness : undefined;
    const k = thick != null ? `${m}@${thick}` : m;
    if (!groups.has(k)) groups.set(k, { material: m, items: [], ...(thick != null ? { thickness: thick } : {}) });
    groups.get(k)!.items.push({
      id: p.id,
      w: p.bbox.maxX - p.bbox.minX,
      h: p.bbox.maxY - p.bbox.minY,
      area: p.area,
      outline: p.shape.map((e) => e.outer),
      minX: p.bbox.minX,
      minY: p.bbox.minY,
    });
  }
  return [...groups.values()].filter((g, i) => i === 0 || g.items.length);
}

export interface DeferredOptions {
  /** Time and seed for the metal nest; the cloud's tight nest passes 30 or 90 seconds. */
  nest?: NestOptions;
}

export function createDeferredPipeline(opts: DeferredOptions = {}) {
  const cache: Cache = new Map();
  const nestOpts = opts.nest ?? {};
  return function computeDeferred(input: DeferredInput, mode: 'fast' | 'full' = 'full'): DeferredModel {
    const t0 = performance.now();
    const st = stager(cache, mode);
    const { stage } = st;
    const { v, sliced, insert, appearance } = input;
    const mats = materialKey(appearance, String(v.plateMaterial));
    const materialFor = (key: string) => materialOf(appearance, key, String(v.plateMaterial));
    const issues = stage('Fit checks', [sliced, ...pick(v, CHECK_KEYS)], () => runChecks(v, sliced), true);
    const nested = stage('Nest sheets', [sliced, v.sheetW, v.sheetH, v.partSpacing, mats, input.savedNest], () => {
      const groups = nestGroupsOf(sliced, String(v.plateMaterial), materialFor);
      const saved = input.savedNest;
      if (saved && saved.fingerprint === nestFingerprint(groups, v.sheetW, v.sheetH, v.partSpacing) && !nestMismatch(groups, saved.result)) return { ...saved.result, source: 'saved' as const };
      return nestGroups(groups, v.sheetW, v.sheetH, v.partSpacing, nestOpts);
    }, true);
    const moulds = stage('Moulds', [sliced, insert, ...pick(v, MOULD_KEYS)], () =>
      buildMoulds(v, sliced, insert?.mesh ?? null, insert ? { minY: insert.minY, maxY: insert.maxY } : null),
      true,
    );
    const mouldNest = stage('Nest plywood', [moulds, v.plySheetW, v.plySheetH, v.partSpacing], () =>
      nest(
        moulds.parts.map((p) => {
          const bb = p.shape[0].outer.reduce((a, [x, y]) => ({ minX: Math.min(a.minX, x), minY: Math.min(a.minY, y), maxX: Math.max(a.maxX, x), maxY: Math.max(a.maxY, y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
          return { id: p.id, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, area: p.area };
        }),
        v.plySheetW,
        v.plySheetH,
        Math.max(v.partSpacing, 8),
      ),
      true,
    );
    const bom = stage('Cut list + BOM', [sliced, nested, moulds, mouldNest, insert, input.pourRows, v.plateMaterial, v.insMaterial, appearance], () =>
      buildBom(v, sliced, nested, moulds, mouldNest, insert?.volume ?? 0, input.pourRows, appearance),
      true,
    );
    // the fast model also runs while slicing, so the length is already cut;
    // here it is run again on the finished outline (rounds, holes and all)
    const sounding = stage('Sounding modes', [sliced, v.tuneModel, v.thickness], () => {
      if (v.tuneModel !== 'free' || !sliced.tuning) return null;
      const out: SoundingMode[] = [];
      sliced.plates.forEach((plate, i) => {
        const tune = sliced.tuning?.[i];
        const shape = plate.parts[0]?.shape;
        if (!tune || tune.model !== 'free' || !shape?.length) return;
        const t1 = performance.now();
        try {
          const m = modesOfOutline(shape, v.thickness, tune.material);
          out.push({ key: plate.def.key, hz: m.hz, nodes: m.nodes, ms: performance.now() - t1 });
        } catch {
          /* the length was still chosen by the fast model during slicing */
        }
      });
      return out.length ? out : null;
    }, true);
    const heavy = mountWeightIssue(v, bom.plateMass + bom.concreteMass);
    return { issues: heavy ? [...issues, heavy] : issues, nested, moulds, mouldNest, bom, sounding, stages: st.stages, totalMs: performance.now() - t0, stale: st.stale };
  };
}

/** The side picture dips below the plate floor: say how much is cut flat and what Plate height clears it. */
function floorClipIssue(clip: NonNullable<HeightField['floorClip']>, v: Values, project: Project): Issue {
  const k = scaleFactorFor('stackHeight', project.params) || 1;
  const need = Math.ceil((v.stackHeight + clip.liftMm) / k);
  return {
    partId: null,
    type: 'general',
    severity: 'warn',
    message: `The side picture sinks below the ${PLATE_FLOOR_MM} mm floor on ${Math.round(clip.fraction * 100)}% of it, so those parts are cut flat. Raise Plates › Plate height to ${need} mm, lower Image › Image height range, or set Image › Side relief set by to Millimetres.`,
  };
}

/** Joins a front pass with a deferred result into the model the UI reads. */
export function assemble(f: FrontModel, d: Omit<DeferredModel, 'totalMs'> & { totalMs?: number }, stale = d.stale): Model {
  const extra = [...(f.fieldIssues ?? []), ...(f.cardVisibility?.issues ?? [])];
  return {
    ...f,
    issues: extra?.length ? [...d.issues, ...extra] : d.issues,
    nested: d.nested,
    moulds: d.moulds,
    mouldNest: d.mouldNest,
    bom: d.bom,
    sounding: d.sounding ?? null,
    stages: [...f.stages, ...d.stages],
    totalMs: f.totalMs + (d.totalMs ?? 0),
    stale,
  };
}

export function createPipeline(opts: DeferredOptions = {}) {
  const front = createFrontPipeline();
  const deferred = createDeferredPipeline(opts);
  /**
   * mode 'fast' recomputes what the 3D view needs (forms, strata, plates) and
   * reuses the last result of the deferred stages; 'full' brings everything up to date.
   */
  return function compute(project: Project, assets: Assets, mode: 'fast' | 'full' = 'full'): Model {
    const f = front(project, assets);
    return assemble(f, deferred(deferredInput(f, project), mode));
  };
}
