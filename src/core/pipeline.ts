// The live regeneration pipeline. Each stage remembers its inputs and only
// re-runs when one of them changes, so editing a value regenerates exactly
// the stages downstream of it.
import type * as THREE from 'three';
import { evaluateParams, PARAMS, type EvalResult, type Values } from './params';
import { buildForm, formSpec, meshVolume, toIndexedMesh, type Form, type IndexedMesh } from './forms';
import { processImage, rotate, silhouetteMask, type Gray } from './image';
import { buildHeightField, type HeightField } from './heightfield';
import { slice, type SliceResult } from './slicer';
import { runChecks, type Issue } from './checks';
import { nest, type NestResult } from './nest';
import { buildMoulds, pourPlan, type MouldResult, type PourPlanRow } from './mould';
import { unfold, type UnfoldResult } from './unfold';
import { buildBom, type Bom } from './bom';
import { share } from './memo';
import type { Project } from './project';

export interface Assets {
  sideImg: Gray | null;
  frontImg: Gray | null;
  topImg?: Gray | null;
  insMesh: THREE.BufferGeometry | null;
  srcMesh: THREE.BufferGeometry | null;
}

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
  issues: Issue[];
  nested: NestResult;
  moulds: MouldResult;
  mouldNest: NestResult;
  unfolded: UnfoldResult;
  pour: { rows: PourPlanRow[]; total: number; mismatch: number };
  bom: Bom;
  stages: StageLog[];
  totalMs: number;
  /** True when deferred stages (checks, nesting, moulds, BOM) are from an earlier state. */
  stale: boolean;
}

const formKeys = (p: string) => ['Shape', 'X', 'Y', 'Z', 'Rot', 'Length', 'Width', 'Height', 'Taper', 'Sweep', 'Camber', 'Bend', 'Twist', 'Scale'].map((k) => p + k);
const NON_SLICE = new Set([
  ...PARAMS.filter((p) => p.group === 'Mould' || p.group === 'Unfold').map((p) => p.id),
  'kerf', 'arcTolerance', 'sheetW', 'sheetH', 'partSpacing', 'dxfMode', 'minPartSize',
  'insTint', 'insMaterial', 'concreteTint', 'pourView', 'erodeAmount', 'slotGap',
]);
const SLICE_KEYS = PARAMS.map((p) => p.id).filter((id) => !NON_SLICE.has(id));
const STRATA_KEYS = ['baseLength', 'baseWidth', 'sliceMode', 'sliceAxis', 'pitch', 'stackHeight', 'erosionAmp', 'erosionScale', 'octaves', 'roughness', 'banding', 'bandHeight', 'coherence', 'crest', 'slope', 'seed', 'imgSideMode', 'imgMix', 'imgRange', 'stackSource'];
const IMG_KEYS = ['imgContrast', 'imgSmooth', 'imgInvert', 'imgRotate'];
const BASE_KEYS = ['baseOn', 'baseLength', 'baseWidth', 'baseHeight', 'baseCornerChamfer', 'baseEdgeChamfer'];
const CHECK_KEYS = ['minFeature', 'kerf', 'minPartSize', 'sheetW', 'sheetH', 'partSpacing', 'pitch', 'thickness', 'radialHub', 'radialCount', 'sliceMode', 'embedMode', ...BASE_KEYS];
const MOULD_KEYS = [...PARAMS.filter((p) => p.group === 'Mould').map((p) => p.id), ...BASE_KEYS, 'embedDepth', 'thickness', 'insMaterial', 'insShape', 'clearance', 'sliceMode'];
const UNFOLD_KEYS = PARAMS.filter((p) => p.group === 'Unfold').map((p) => p.id);

export function createPipeline() {
  const cache = new Map<string, { deps: unknown[]; value: unknown; ms: number }>();
  /**
   * mode 'fast' recomputes what the 3D view needs (forms, strata, plates) and
   * reuses the last result of the deferred stages; 'full' brings everything up to date.
   */
  return function compute(project: Project, assets: Assets, mode: 'fast' | 'full' = 'full'): Model {
    const t0 = performance.now();
    const stages: StageLog[] = [];
    let stale = false;
    function stage<T>(name: string, deps: unknown[], fn: () => T, deferred = false): T {
      const prev = cache.get(name);
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        stages.push({ name, ms: prev.ms, cached: true });
        return prev.value as T;
      }
      if (deferred && mode === 'fast' && prev) {
        stale = true;
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
    const pick = (v: Values, keys: string[]) => keys.map((k) => v[k]);

    // the top image's on-surface aspect (width across the plates / length along the stack), for "Fit stack to image"
    const imgAspect = (() => {
      const g = assets.topImg;
      if (!g) return 1;
      const q = (id: string) => (((Math.round(Number(project.params[id] ?? 0) / 90) % 2) + 2) % 2);
      const swap = (q('imgRotate') + q('topRotate')) % 2 === 1;
      return swap ? g.h / g.w : g.w / g.h;
    })();
    const ev = stage('Parameters', [project.params, imgAspect], () => evaluateParams(project.params, { imgAspect }));
    const v = ev.values;

    const mkForm = (prefix: 'ins' | 'src', mesh: THREE.BufferGeometry | null): FormBuild | null => {
      const form = buildForm(formSpec(v, prefix), mesh);
      if (!form) return null;
      const im = toIndexedMesh(form.geometry);
      return { form, mesh: im, volume: meshVolume(im) };
    };
    const insert = stage('Insert form', [...pick(v, formKeys('ins')), assets.insMesh], () => mkForm('ins', assets.insMesh));
    const source = stage('Source form', [...pick(v, formKeys('src')), v.stackSource, assets.srcMesh], () =>
      v.stackSource === 'form' || v.unfoldTarget === 'source' ? mkForm('src', assets.srcMesh) : null,
    );
    const opts = () => ({ contrast: v.imgContrast, smooth: v.imgSmooth, invert: v.imgInvert, rotate: Number(v.imgRotate) });
    const sideImg = stage('Side image', [assets.sideImg, ...pick(v, IMG_KEYS)], () => (assets.sideImg ? processImage(assets.sideImg, opts()) : null));
    const frontImg = stage('Front image', [assets.frontImg, ...pick(v, IMG_KEYS)], () => (assets.frontImg ? processImage(assets.frontImg, opts()) : null));
    const topImg = stage('Top image', [assets.topImg ?? null, ...pick(v, IMG_KEYS)], () => (assets.topImg ? processImage(assets.topImg, opts()) : null));
    const topMask = stage('Top silhouette', [assets.topImg ?? null, v.topOutline, v.topThreshold, v.imgRotate], () =>
      assets.topImg && v.topOutline !== 'off' ? silhouetteMask(rotate(assets.topImg, Number(v.imgRotate)), String(v.topOutline), v.topThreshold) : null,
    );
    const hf = stage('Strata field', [...pick(v, STRATA_KEYS), sideImg], () => (v.stackSource === 'strata' ? buildHeightField(v, sideImg) : null));
    // parts that come out unchanged keep their identity, so checks, nesting and the 3D view skip them
    const sliced = stage('Slice plates', [...pick(v, SLICE_KEYS), hf, insert, source, frontImg, topImg, topMask, project.moves], () =>
      share(cache.get('Slice plates')?.value as SliceResult | undefined, slice({ v, hf, source: source?.mesh ?? null, insert: insert?.mesh ?? null, front: frontImg, top: topImg, topMask, moves: project.moves })),
    );
    const issues = stage('Fit checks', [sliced, ...pick(v, CHECK_KEYS)], () => runChecks(v, sliced), true);
    const nested = stage('Nest sheets', [sliced, v.sheetW, v.sheetH, v.partSpacing], () =>
      nest(
        sliced.parts.map((p) => ({ id: p.id, w: p.bbox.maxX - p.bbox.minX, h: p.bbox.maxY - p.bbox.minY, area: p.area })),
        v.sheetW,
        v.sheetH,
        v.partSpacing,
      ),
      true,
    );
    const moulds = stage('Moulds', [sliced, insert, ...pick(v, MOULD_KEYS)], () =>
      buildMoulds(v, sliced, insert?.mesh ?? null, insert ? { minY: insert.form.bbox.min.y, maxY: insert.form.bbox.max.y } : null),
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
    const unfolded = stage('Unfold', [...pick(v, UNFOLD_KEYS), insert, source], () => unfold(v.unfoldTarget === 'source' ? source?.form ?? null : insert?.form ?? null, v));
    const numScope = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
    const pour = stage('Pour plan', [project.pour, ...pick(v, BASE_KEYS)], () => pourPlan(v, project.pour, numScope));
    const bom = stage('Cut list + BOM', [sliced, nested, moulds, mouldNest, insert, pour, v.plateMaterial, v.insMaterial], () =>
      buildBom(v, sliced, nested, moulds, mouldNest, insert?.volume ?? 0, pour.rows),
      true,
    );
    return { ev, v, insert, source, sideImg, frontImg, topImg, hf, sliced, issues, nested, moulds, mouldNest, unfolded, pour, bom, stages, totalMs: performance.now() - t0, stale };
  };
}
