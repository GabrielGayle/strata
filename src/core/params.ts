import { evaluate, identifiers, isLiteral, parse, type Node } from './expr';

export type ParamKind = 'number' | 'choice' | 'toggle' | 'color' | 'text';
export type RawValue = string | number | boolean;
export type Values = Record<string, any>;

export interface ParamDef {
  id: string;
  label: string;
  group: string;
  kind: ParamKind;
  /** Numbers store an expression string; others store their plain value. */
  def: RawValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  int?: boolean;
  options?: { value: string; label: string }[];
  help?: string;
  /** Included when "Randomise" is pressed (if unlocked and a literal). */
  rand?: boolean;
  show?: (v: Values) => boolean;
}

export const GROUPS = [
  'Base',
  'Plates',
  'Slicer',
  'Strata',
  'Insert',
  'Source form',
  'Image',
  'Concrete',
  'Mould',
  'Unfold',
  'Fabrication',
] as const;

const SHAPES = [
  { value: 'fin', label: 'Fin' },
  { value: 'cone', label: 'Cone' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'box', label: 'Box' },
  { value: 'loft', label: 'Loft (ellipses)' },
  { value: 'revolve', label: 'Revolve' },
  { value: 'extrude', label: 'Extruded profile' },
  { value: 'mesh', label: 'Imported mesh' },
];

const num = (
  id: string,
  label: string,
  group: string,
  def: string | number,
  min: number,
  max: number,
  extra: Partial<ParamDef> = {},
): ParamDef => ({ id, label, group, kind: 'number', def: String(def), min, max, step: extra.step ?? 1, unit: 'mm', ...extra });

const choice = (id: string, label: string, group: string, def: string, options: { value: string; label: string }[], extra: Partial<ParamDef> = {}): ParamDef => ({
  id,
  label,
  group,
  kind: 'choice',
  def,
  options,
  ...extra,
});

function formParams(prefix: 'ins' | 'src', group: string, show: (v: Values) => boolean, defaults: Record<string, string | number>): ParamDef[] {
  const s = (v: Values) => show(v) && v[`${prefix}Shape`] !== 'none';
  const shapeIs = (...shapes: string[]) => (v: Values) => s(v) && shapes.includes(v[`${prefix}Shape`]);
  return [
    choice(`${prefix}Shape`, 'Shape', group, String(defaults.shape), prefix === 'ins' ? [{ value: 'none', label: 'None' }, ...SHAPES] : SHAPES, { show }),
    num(`${prefix}X`, 'Position X', group, defaults.x ?? 0, -1500, 1500, { show: s, help: 'Along the base length' }),
    num(`${prefix}Z`, 'Position Z', group, defaults.z ?? 0, -1000, 1000, { show: s, help: 'Across the base width' }),
    num(`${prefix}Y`, 'Bottom height', group, defaults.y ?? 'baseHeight', -500, 2000, { show: s }),
    num(`${prefix}Rot`, 'Rotation', group, defaults.rot ?? 0, -180, 180, { unit: '°', show: s, rand: true }),
    num(`${prefix}Length`, 'Length', group, defaults.length ?? 300, 5, 3000, { show: shapeIs('fin', 'box', 'loft', 'extrude'), rand: true }),
    num(`${prefix}Width`, 'Width / diameter', group, defaults.width ?? 60, 2, 2000, { show: shapeIs('fin', 'box', 'loft', 'extrude', 'cone', 'cylinder', 'revolve'), rand: true }),
    num(`${prefix}Height`, 'Height', group, defaults.height ?? 300, 5, 3000, { show: shapeIs('fin', 'box', 'loft', 'extrude', 'cone', 'cylinder', 'revolve'), rand: true }),
    num(`${prefix}Taper`, 'Top scale', group, defaults.taper ?? 0.4, 0, 2, { unit: '×', step: 0.01, show: shapeIs('fin', 'cone', 'loft', 'revolve'), rand: true }),
    num(`${prefix}Sweep`, 'Sweep / lean', group, defaults.sweep ?? 60, -1000, 1000, { show: shapeIs('fin', 'loft', 'cone'), rand: true }),
    num(`${prefix}Camber`, 'Camber / bulge', group, defaults.camber ?? 20, -500, 500, { show: shapeIs('fin', 'revolve', 'extrude'), rand: true }),
    num(`${prefix}Bend`, 'Bend', group, defaults.bend ?? 0, -500, 500, { show: shapeIs('fin', 'loft'), rand: true, help: 'Bows the form along its height (curved rulings)' }),
    num(`${prefix}Twist`, 'Twist', group, defaults.twist ?? 0, -180, 180, { unit: '°', show: shapeIs('fin', 'loft', 'extrude'), rand: true }),
    num(`${prefix}Scale`, 'Mesh scale', group, 1, 0.01, 100, { unit: '×', step: 0.01, show: shapeIs('mesh') }),
  ];
}

const isParallelish = (v: Values) => v.sliceMode !== 'radial';
const strataSource = (v: Values) => v.stackSource === 'strata';

export const PARAMS: ParamDef[] = [
  // Base
  { id: 'baseOn', label: 'Concrete base', group: 'Base', kind: 'toggle', def: true },
  num('baseLength', 'Length', 'Base', 800, 100, 3000),
  num('baseWidth', 'Width', 'Base', 300, 50, 1500),
  num('baseHeight', 'Height', 'Base', 120, 10, 600),

  // Plates
  choice('plateMaterial', 'Material', 'Plates', 'corten', [
    { value: 'steel', label: 'Mild steel' },
    { value: 'aluminium', label: 'Aluminium' },
    { value: 'corten', label: 'Corten' },
  ]),
  num('thickness', 'Thickness', 'Plates', 3, 0.5, 12, { step: 0.5, help: 'Common: 1.5, 3, 6 mm' }),
  num('plateCount', 'Plate count', 'Plates', 40, 2, 300, { int: true, unit: '', show: isParallelish }),
  num('endMargin', 'End margin', 'Plates', 40, 0, 1000, { show: isParallelish }),
  num('stackLength', 'Stack run', 'Plates', 'alongWidth ? baseWidth : baseLength', 1, 5000, { show: isParallelish, help: 'Base length the plates are stacked along (alongWidth = 1 when slicing across)' }),
  num('acrossLength', 'Across run', 'Plates', 'alongWidth ? baseLength : baseWidth', 1, 5000, { show: isParallelish }),
  num('pitch', 'Pitch', 'Plates', '(stackLength - 2*endMargin) / (plateCount - 1)', 1, 500, { step: 0.1, show: isParallelish }),
  num('sideMargin', 'Side margin', 'Plates', 20, 0, 1000),
  num('plateWidth', 'Plate width', 'Plates', 'acrossLength - 2*sideMargin', 5, 3000, { show: isParallelish }),
  num('embedDepth', 'Embed depth', 'Plates', 40, 0, 400, { help: 'How far each plate sinks into the concrete' }),
  num('tabInset', 'Embed tab inset', 'Plates', 0, 0, 200, { help: 'Narrows the embedded tab on each side' }),
  num('anchorHoles', 'Anchor holes', 'Plates', 2, 0, 12, { int: true, unit: '', help: 'Holes in the embedded tab that concrete flows through' }),
  num('anchorDia', 'Anchor hole Ø', 'Plates', 10, 2, 60),

  // Slicer
  choice('sliceMode', 'Slicing', 'Slicer', 'parallel', [
    { value: 'parallel', label: 'Parallel stack' },
    { value: 'radial', label: 'Radial' },
    { value: 'waffle', label: 'Waffle (interlocking)' },
  ]),
  choice('sliceAxis', 'Direction', 'Slicer', 'length', [
    { value: 'length', label: 'Along length (X)' },
    { value: 'width', label: 'Along width (Z)' },
  ], { show: isParallelish }),
  choice('stackSource', 'Slice what', 'Slicer', 'strata', [
    { value: 'strata', label: 'Eroded strata block' },
    { value: 'form', label: 'Source form' },
  ]),
  num('radialCount', 'Radial plates', 'Slicer', 24, 3, 180, { int: true, unit: '', show: (v) => v.sliceMode === 'radial' }),
  num('radialHub', 'Hub radius', 'Slicer', 30, 0, 500, { show: (v) => v.sliceMode === 'radial' }),
  num('crossCount', 'Cross plates', 'Slicer', 'max(2, floor(plateWidth / 55))', 1, 200, { int: true, unit: '', show: (v) => v.sliceMode === 'waffle' }),
  num('slotClearance', 'Slot allowance', 'Slicer', 0.2, 0, 3, { step: 0.05, show: (v) => v.sliceMode === 'waffle', help: 'Added to slot width (kerf allowance) for interlocking slots' }),
  num('sampleStep', 'Profile resolution', 'Slicer', 2, 0.5, 20, { step: 0.5 }),

  // Strata / erosion
  num('stackHeight', 'Plate height', 'Strata', 220, 10, 2000, { show: strataSource }),
  num('erosionAmp', 'Erosion amplitude', 'Strata', 45, 0, 500, { show: strataSource, rand: true }),
  num('erosionScale', 'Erosion wavelength', 'Strata', 170, 10, 2000, { show: strataSource, rand: true }),
  num('octaves', 'Octaves', 'Strata', 4, 1, 8, { int: true, unit: '', show: strataSource, rand: true }),
  num('roughness', 'Roughness', 'Strata', 0.5, 0, 1, { step: 0.01, unit: '', show: strataSource, rand: true }),
  num('banding', 'Banding', 'Strata', 0.65, 0, 1, { step: 0.01, unit: '', show: strataSource, rand: true, help: 'Terraces the edge into strata bands' }),
  num('bandHeight', 'Band height', 'Strata', 16, 1, 200, { show: strataSource, rand: true }),
  num('coherence', 'Neighbour follow', 'Strata', 0.85, 0, 1, { step: 0.01, unit: '', show: strataSource, rand: true, help: 'How closely neighbouring plates follow each other' }),
  num('crest', 'Crest', 'Strata', 40, -500, 500, { show: strataSource, rand: true, help: 'Rise towards the middle of the stack' }),
  num('slope', 'Slope', 'Strata', 0, -500, 500, { show: strataSource, rand: true, help: 'Height change from one end to the other' }),
  num('seed', 'Seed', 'Strata', 7, 0, 9999, { int: true, unit: '', rand: true }),

  // Insert
  ...formParams('ins', 'Insert', () => true, { shape: 'fin', length: 330, width: 56, height: 360, taper: 0.35, sweep: 90, camber: 22, bend: 18 }),
  choice('insMaterial', 'Material', 'Insert', 'concrete', [
    { value: 'concrete', label: 'Concrete (cast)' },
    { value: 'metal', label: 'Metal' },
    { value: 'void', label: 'Void (cut only)' },
  ], { show: (v) => v.insShape !== 'none' }),
  num('clearance', 'Fit clearance', 'Insert', 0.5, 0, 20, { step: 0.1, show: (v) => v.insShape !== 'none', help: 'Gap between the insert and each plate cavity' }),
  choice('cavityMode', 'Cavity section', 'Insert', 'larger', [
    { value: 'larger', label: 'Larger of front/back (slides in)' },
    { value: 'smaller', label: 'Smaller of front/back (tight)' },
    { value: 'mid', label: 'Mid-plane section' },
  ], { show: (v) => v.insShape !== 'none' }),
  { id: 'insTint', label: 'Insert tint', group: 'Insert', kind: 'color', def: '#6f6a64', show: (v) => v.insShape !== 'none' && v.insMaterial === 'concrete' },

  // Source form
  ...formParams('src', 'Source form', (v) => v.stackSource === 'form', { shape: 'revolve', width: 260, height: 300, taper: 0.5, camber: 60, length: 600 }),

  // Image
  choice('imgSideMode', 'Side profile', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'heightmap', label: 'Image as height (strip per plate)' },
    { value: 'silhouette', label: 'Traced silhouette' },
  ], { show: strataSource }),
  num('imgMix', 'Strata ↔ image mix', 'Image', 0.6, 0, 1, { step: 0.01, unit: '', show: (v) => strataSource(v) && v.imgSideMode !== 'off', rand: true }),
  num('imgRange', 'Image height range', 'Image', 140, 0, 2000, { show: (v) => strataSource(v) && v.imgSideMode !== 'off' }),
  num('imgContrast', 'Contrast', 'Image', 1.2, 0.1, 5, { step: 0.05, unit: '×' }),
  num('imgSmooth', 'Smoothing', 'Image', 1, 0, 10, { int: true, unit: 'px' }),
  { id: 'imgInvert', label: 'Invert', group: 'Image', kind: 'toggle', def: false },
  choice('imgRotate', 'Image direction', 'Image', '0', [
    { value: '0', label: 'As loaded' },
    { value: '90', label: 'Rotate 90°' },
    { value: '180', label: 'Rotate 180°' },
    { value: '270', label: 'Rotate 270°' },
  ]),
  choice('imgTopMode', 'Top surface', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'carve', label: 'Carve in (dark sinks)' },
    { value: 'raise', label: 'Raise (dark stands proud)' },
  ]),
  choice('topFloor', 'Impression floor', 'Image', 'flat', [
    { value: 'flat', label: 'Flat terraces (reads like a stamp)' },
    { value: 'follow', label: 'Follow the eroded surface' },
  ], { show: (v) => v.imgTopMode !== 'off' }),
  num('topDepth', 'Impression depth', 'Image', 18, 1, 300, { show: (v) => v.imgTopMode !== 'off', help: 'How far the darkest areas are cut down into the top surface' }),
  num('topSteps', 'Depth steps', 'Image', 4, 0, 20, { int: true, unit: '', show: (v) => v.imgTopMode !== 'off', help: '0 = smooth; N = crisp terraces like layered cut-outs' }),
  num('topThreshold', 'Ignore lighter than', 'Image', 0.15, 0, 0.95, { step: 0.01, unit: '', show: (v) => v.imgTopMode !== 'off', help: 'Darkness below this is left flat (keeps a white background uncut)' }),
  num('topScale', 'Image size', 'Image', 0.9, 0.1, 1, { step: 0.01, unit: '×', show: (v) => v.imgTopMode !== 'off' }),
  choice('topRotate', 'Turn image', 'Image', '0', [
    { value: '0', label: 'Upright from the front' },
    { value: '90', label: 'Turn 90° (runs along the stack)' },
    { value: '180', label: 'Turn 180°' },
    { value: '270', label: 'Turn 270°' },
  ], { show: (v) => v.imgTopMode !== 'off' }),
  num('topX', 'Image offset X', 'Image', 0, -1500, 1500, { show: (v) => v.imgTopMode !== 'off' }),
  num('topZ', 'Image offset Z', 'Image', 0, -1500, 1500, { show: (v) => v.imgTopMode !== 'off' }),
  num('topMargin', 'Top margin', 'Image', 10, 0, 300, { show: (v) => v.imgTopMode !== 'off' }),
  choice('imgFrontMode', 'Front view', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'layers', label: 'Layered cut-outs (depth = dark)' },
    { value: 'halftone', label: 'Halftone holes' },
  ], { show: (v) => v.sliceMode === 'parallel' }),
  num('imgFrontStrength', 'Front strength', 'Image', 0.5, 0, 1, { step: 0.01, unit: '', show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode !== 'off' }),
  num('frontDepth', 'Plates carrying image', 'Image', 10, 1, 300, { int: true, unit: '', show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode === 'layers' }),
  num('frontMargin', 'Frame margin', 'Image', 15, 0, 300, { show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode !== 'off' }),
  num('halftoneSpacing', 'Dot spacing', 'Image', 12, 3, 100, { show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode === 'halftone' }),
  choice('etchMode', 'Etched lines', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'hatch', label: 'Hatch lines (line up plate to plate)' },
    { value: 'contour', label: 'Contour per plate' },
  ], { show: (v) => v.sliceMode === 'parallel' }),
  num('etchSpacing', 'Etch spacing', 'Image', 4, 0.5, 50, { step: 0.5, show: (v) => v.sliceMode === 'parallel' && v.etchMode !== 'off' }),

  // Concrete
  { id: 'concreteTint', label: 'Base tint', group: 'Concrete', kind: 'color', def: '#a39e96' },
  choice('pourView', 'Pour preview', 'Concrete', 'layers', [
    { value: 'plain', label: 'Plain' },
    { value: 'layers', label: 'Strata layers' },
    { value: 'eroded', label: 'Sanded back / eroded' },
  ]),
  num('erodeAmount', 'Sanded wobble', 'Concrete', 6, 0, 60, { show: (v) => v.pourView === 'eroded' }),
  choice('embedMode', 'Plate fixing', 'Concrete', 'cast', [
    { value: 'cast', label: 'Cast in (anchor holes)' },
    { value: 'slot', label: 'Cast slots, fit later' },
  ]),
  num('slotGap', 'Slot gap', 'Concrete', 1, 0, 10, { step: 0.1, show: (v) => v.embedMode === 'slot', help: 'Slot width = thickness + gap' }),

  // Mould
  { id: 'mouldOn', label: 'Generate moulds', group: 'Mould', kind: 'toggle', def: true },
  num('plyThickness', 'Plywood thickness', 'Mould', 18, 3, 50, { step: 0.5 }),
  num('mouldWall', 'Wall thickness', 'Mould', 40, 10, 300),
  num('draft', 'Draft', 'Mould', 0.5, 0, 10, { unit: '°', step: 0.1 }),
  num('dowelDia', 'Dowel Ø', 'Mould', 8, 2, 30),
  num('tabsPerSide', 'Clamp tabs / side', 'Mould', 2, 0, 8, { int: true, unit: '' }),
  num('tabSize', 'Tab size', 'Mould', 40, 10, 200),
  choice('mouldSplit', 'Split rings', 'Mould', 'halves', [
    { value: 'none', label: 'Whole rings' },
    { value: 'halves', label: 'Halves (opens to release)' },
  ]),
  { id: 'jigOn', label: 'Plate jig board', group: 'Mould', kind: 'toggle', def: true, help: 'Board with slots that holds plates at pitch while concrete cures' },
  num('jigClearance', 'Jig slot clearance', 'Mould', 0.3, 0, 5, { step: 0.05 }),
  num('plySheetW', 'Ply sheet length', 'Mould', 2440, 300, 5000),
  num('plySheetH', 'Ply sheet width', 'Mould', 1220, 300, 3000),

  // Unfold / flatten
  choice('unfoldTarget', 'Unroll which form', 'Unfold', 'insert', [
    { value: 'insert', label: 'Insert' },
    { value: 'source', label: 'Source form' },
  ]),
  num('unfoldFacets', 'Facets (0 = rolled)', 'Unfold', 0, 0, 96, { int: true, unit: '', help: '0 rolls a smooth sheet; N folds it on a press brake with N bends' }),
  num('unfoldPieces', 'Split into pieces', 'Unfold', 1, 1, 8, { int: true, unit: '' }),
  num('unfoldThickness', 'Sheet thickness', 'Unfold', 'thickness', 0.3, 12, { step: 0.1 }),
  num('kFactor', 'K-factor', 'Unfold', 0.33, 0, 0.5, { step: 0.01, unit: '' }),
  num('bendRadius', 'Inside bend radius', 'Unfold', 'unfoldThickness', 0, 50, { step: 0.1 }),

  // Fabrication
  num('kerf', 'Kerf', 'Fabrication', 0.15, 0, 3, { step: 0.01, help: 'Laser beam width; outlines are offset by half' }),
  num('arcTolerance', 'Arc fit tolerance', 'Fabrication', 0.05, 0.005, 2, { step: 0.005 }),
  num('minFeature', 'Min feature', 'Fabrication', 2, 0, 50, { step: 0.1, help: 'Narrowest web of material the laser can leave' }),
  num('minPartSize', 'Min part size', 'Fabrication', 15, 0, 500),
  num('sheetW', 'Sheet length', 'Fabrication', 2500, 100, 6000),
  num('sheetH', 'Sheet width', 'Fabrication', 1250, 100, 3000),
  num('partSpacing', 'Part spacing', 'Fabrication', 6, 0, 100),
  num('labelHeight', 'Label height', 'Fabrication', 6, 2, 50, { step: 0.5 }),
  { id: 'partPrefix', label: 'Part prefix', group: 'Fabrication', kind: 'text', def: 'S' },
  choice('dxfMode', 'DXF entities', 'Fabrication', 'polyline', [
    { value: 'polyline', label: 'Closed polylines with arcs' },
    { value: 'lines', label: 'Separate LINE + ARC' },
  ]),
];

export const PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.id, p]));

export function defaultRaw(): Record<string, RawValue> {
  return Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
}

export interface EvalResult {
  values: Values;
  errors: Record<string, string>;
  clamped: Record<string, boolean>;
  deps: Record<string, string[]>;
  order: string[];
}

const parseCache = new Map<string, Node | Error>();
function cachedParse(src: string): Node {
  let n = parseCache.get(src);
  if (!n) {
    try {
      n = parse(src);
    } catch (e) {
      n = e as Error;
    }
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(src, n);
  }
  if (n instanceof Error) throw n;
  return n;
}

/** Read-only numeric flags derived from choice parameters, usable in expressions. */
export function flagsFor(raw: Record<string, RawValue>): Record<string, number> {
  const get = (id: string) => String(raw[id] ?? PARAM_MAP[id].def);
  return {
    alongWidth: get('sliceAxis') === 'width' ? 1 : 0,
    isRadial: get('sliceMode') === 'radial' ? 1 : 0,
    isWaffle: get('sliceMode') === 'waffle' ? 1 : 0,
  };
}
export const FLAG_NAMES = ['alongWidth', 'isRadial', 'isWaffle'];

/** Evaluate the whole parameter graph in dependency order. */
export function evaluateParams(raw: Record<string, RawValue>): EvalResult {
  const values: Values = {};
  const errors: Record<string, string> = {};
  const clamped: Record<string, boolean> = {};
  const deps: Record<string, string[]> = {};
  const nodes: Record<string, Node> = {};
  const numIds = PARAMS.filter((p) => p.kind === 'number').map((p) => p.id);
  const numSet = new Set(numIds);
  const flags = flagsFor(raw);

  for (const p of PARAMS) {
    const r = raw[p.id] ?? p.def;
    if (p.kind === 'number') {
      try {
        nodes[p.id] = cachedParse(String(r));
        const ids = [...identifiers(nodes[p.id])].filter((i) => !(i in flags));
        const unknown = ids.filter((i) => !numSet.has(i));
        if (unknown.length) throw new Error(`Unknown name '${unknown[0]}'`);
        if (ids.includes(p.id)) throw new Error('Refers to itself');
        deps[p.id] = ids;
      } catch (e) {
        errors[p.id] = (e as Error).message;
        nodes[p.id] = cachedParse(String(p.def));
        deps[p.id] = [...identifiers(nodes[p.id])].filter((i) => !(i in flags));
      }
    } else if (p.kind === 'toggle') {
      values[p.id] = r === true || r === 'true';
    } else {
      values[p.id] = String(r);
      if (p.kind === 'choice' && p.options && !p.options.some((o) => o.value === values[p.id])) values[p.id] = String(p.def);
    }
  }

  // Kahn topological sort
  const indeg: Record<string, number> = {};
  const users: Record<string, string[]> = {};
  for (const id of numIds) {
    indeg[id] = 0;
    users[id] = [];
  }
  for (const id of numIds) {
    for (const d of deps[id]) {
      indeg[id]++;
      users[d].push(id);
    }
  }
  const queue = numIds.filter((id) => indeg[id] === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const u of users[id]) if (--indeg[u] === 0) queue.push(u);
  }
  const cyclic = numIds.filter((id) => !order.includes(id));
  for (const id of cyclic) {
    errors[id] = 'Circular reference';
    deps[id] = [];
    const d = PARAM_MAP[id].def;
    nodes[id] = isLiteral(String(d)) ? cachedParse(String(d)) : cachedParse(String(PARAM_MAP[id].min ?? 0));
  }
  const fullOrder = [...cyclic, ...order];

  const scope: Record<string, number> = { ...flags };
  for (const id of fullOrder) {
    const p = PARAM_MAP[id];
    let v: number;
    try {
      v = evaluate(nodes[id], scope);
      if (!Number.isFinite(v)) throw new Error('Not a finite number');
    } catch (e) {
      errors[id] = errors[id] ?? (e as Error).message;
      try {
        v = evaluate(cachedParse(String(p.def)), scope);
      } catch {
        v = p.min ?? 0;
      }
      if (!Number.isFinite(v)) v = p.min ?? 0;
    }
    if (p.int) v = Math.round(v);
    const lo = p.min ?? -Infinity;
    const hi = p.max ?? Infinity;
    if (v < lo || v > hi) {
      clamped[id] = true;
      v = Math.min(hi, Math.max(lo, v));
    }
    scope[id] = v;
    values[id] = v;
  }
  return { values, errors, clamped, deps, order: fullOrder };
}

/** Parameters downstream of `id` (everything that depends on it, transitively). */
export function downstream(id: string, deps: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const [k, ds] of Object.entries(deps)) {
      if (ds.includes(cur) && !out.has(k)) {
        out.add(k);
        stack.push(k);
      }
    }
  }
  return out;
}
