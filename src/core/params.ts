import { evaluate, identifiers, isLiteral, parse, type Node } from './expr';
import { CHORD_OPTIONS, SCALE_OPTIONS } from './tuning';

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
  /** Physical tolerance or stock size: never changed by Master size. */
  noScale?: boolean;
  /** A count that follows Master size (when "Scale plate count" is on). */
  scaleCount?: boolean;
  show?: (v: Values) => boolean;
}

export const GROUPS = [
  'Master',
  'Base',
  'Support',
  'Bracing',
  'Plates',
  'Slicer',
  'Strata',
  'Edges',
  'Insert',
  'Source form',
  'Image',
  'Margins',
  'Tuning',
  'Concrete',
  'Sun',
  'Shadow',
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

const hasSupport = (v: Values) => v.baseOn && v.supportMode !== 'off';
const isParallelish = (v: Values) => v.sliceMode !== 'radial';
const isUpright = (v: Values) => v.sliceMode !== 'radial' && v.sliceMode !== 'flat';
const isFlat = (v: Values) => v.sliceMode === 'flat';
const hasRods = (v: Values) => isUpright(v) && v.rodsOn;
const hasCross = (v: Values) => isUpright(v) && (v.spacerMode === 'cross' || v.spacerMode === 'both');
const hasTemplate = (v: Values) => isUpright(v) && (v.spacerMode === 'template' || v.spacerMode === 'both');
const hasSpacers = (v: Values) => hasCross(v) || hasTemplate(v);
const strataSource = (v: Values) => v.stackSource === 'strata';
const isTuned = (v: Values) => strataSource(v) && (v.sliceMode === 'parallel' || v.sliceMode === 'radial') && v.tuneMode !== 'off';

export const PARAMS: ParamDef[] = [
  // Master
  num('masterScale', 'Master size', 'Master', 1, 0.05, 4, {
    step: 0.01,
    unit: '×',
    noScale: true,
    help: 'Scales the whole piece: base, plates, heights, erosion, impression. Tolerances (kerf, clearance) and stock (sheet, ply) stay real.',
  }),
  { id: 'masterCount', label: 'Scale plate count', group: 'Master', kind: 'toggle', def: true, help: 'Fewer plates when smaller (pitch stays similar)' },
  { id: 'masterThickness', label: 'Scale plate thickness', group: 'Master', kind: 'toggle', def: true },

  // Base
  { id: 'baseOn', label: 'Concrete base', group: 'Base', kind: 'toggle', def: true },
  num('baseLength', 'Length', 'Base', 800, 20, 3000),
  num('baseWidth', 'Width', 'Base', 300, 20, 1500),
  num('baseHeight', 'Height', 'Base', 120, 5, 600),
  num('baseCornerChamfer', 'Corner chamfer', 'Base', 0, 0, 300, { show: (v) => v.baseOn, help: 'Cuts the four vertical corners of the base at 45° (leg length)' }),
  num('baseEdgeChamfer', 'Top edge chamfer', 'Base', 0, 0, 100, { show: (v) => v.baseOn, help: 'Bevels the top edge of the base at 45°. Formed by a chamfer strip fixed inside the top of the mould.' }),

  // Embedded support
  { id: 'supportOn', label: 'Embedded support on', group: 'Support', kind: 'toggle', def: true, show: (v) => v.baseOn },
  choice('supportMode', 'Embedded support', 'Support', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'radial', label: 'Radial ring' },
  ], { show: (v) => v.baseOn, help: 'A flat ring cut from the same sheet and cast into the concrete. Every plate drops a tenon through a slot in it, so the stack keeps its spacing and angles.' }),
  num('supportOuter', 'Ring outer radius', 'Support', 'max(5, min(baseLength, baseWidth)/2 - sideMargin - 20)', 5, 2000, { show: hasSupport }),
  num('supportInner', 'Ring inner radius', 'Support', 'isRadial ? radialHub + 10 : supportOuter * 0.5', 0, 2000, { show: hasSupport, help: '0 makes a solid disc' }),
  num('supportDepth', 'Depth below surface', 'Support', 'embedDepth + 15', 0, 600, { show: hasSupport, help: 'How far below the top of the concrete the ring\'s top face sits. Deeper than the plate embed gives the plates tenons that reach down to it; shallower trims the tabs to tenons at the ring.' }),
  num('supportThickness', 'Ring thickness', 'Support', 'thickness', 0.5, 25, { step: 0.5, show: hasSupport }),
  num('supportTail', 'Tenon tail', 'Support', 0, 0, 100, { show: hasSupport, help: 'How far each tenon pokes out under the ring (bend or pin the tails to lock the ring on)' }),
  num('supportLand', 'Slot end land', 'Support', 8, 0, 200, { show: hasSupport, help: 'Solid ring left beyond each end of every slot' }),
  num('supportClearance', 'Slot clearance', 'Support', 0.3, 0, 3, { step: 0.05, show: hasSupport, noScale: true, help: 'Added around each tenon in the ring slots' }),

  // Bracing: threaded rods through the embedded tabs + laser-cut spacers
  { id: 'bracingOn', label: 'Bracing on', group: 'Bracing', kind: 'toggle', def: true, show: isUpright },
  { id: 'rodsOn', label: 'Threaded rods', group: 'Bracing', kind: 'toggle', def: false, show: isUpright, help: 'Threaded rods run through every plate\'s embedded tab like rebar, with nuts locking the plates on them' },
  choice('rodSize', 'Rod size', 'Bracing', 'M5', ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'].map((m) => ({ value: m, label: m })), { show: hasRods }),
  choice('rodLayout', 'Rod layout', 'Bracing', 'row', [
    { value: 'row', label: 'One row' },
    { value: 'stagger', label: 'Staggered' },
    { value: 'grid', label: 'Rows (grid)' },
    { value: 'custom', label: 'Custom points' },
  ], { show: hasRods, help: 'Rods can sit in the concrete or up in the exposed steel; every plate gets a hole wherever a rod passes through it' }),
  num('rodCount', 'Rods per row', 'Bracing', 2, 1, 12, { int: true, unit: '', show: (v) => hasRods(v) && v.rodLayout !== 'custom', help: 'Spread evenly across the plate width' }),
  num('rodDepth', 'Rod depth', 'Bracing', 'embedDepth / 2', -3000, 400, { show: (v) => hasRods(v) && v.rodLayout !== 'custom', help: 'First row\'s centre below the top of the concrete. Negative puts it up in the exposed steel.' }),
  num('rodStagger', 'Stagger rise', 'Bracing', 30, -3000, 3000, { show: (v) => hasRods(v) && v.rodLayout === 'stagger', help: 'Every other rod sits this much higher' }),
  num('rodRows', 'Rows', 'Bracing', 2, 1, 12, { int: true, unit: '', show: (v) => hasRods(v) && v.rodLayout === 'grid' }),
  num('rodRowGap', 'Row spacing', 'Bracing', 60, -3000, 3000, { show: (v) => hasRods(v) && v.rodLayout === 'grid', help: 'Each row sits this much above the one before' }),
  { id: 'rodPoints', label: 'Rod points', group: 'Bracing', kind: 'text', def: '-60, -20; 60, -20; 0, 80', show: (v) => hasRods(v) && v.rodLayout === 'custom', help: '"u, y; u, y" in mm: across from the plate centre line, and height above the concrete (negative is in the concrete)' },
  num('rodClearance', 'Hole clearance', 'Bracing', 0.5, 0, 3, { step: 0.05, show: hasRods, noScale: true, help: 'Rod hole Ø = rod size + this' }),
  choice('nutPattern', 'Nuts', 'Bracing', 'ends', [
    { value: 'ends', label: 'Clamp the outer plates' },
    { value: 'every', label: 'Lock every plate' },
    { value: 'nth', label: 'Lock every Nth plate' },
  ], { show: hasRods, help: 'Locked plates get a nut and washer on both faces' }),
  num('nutEvery', 'Lock every', 'Bracing', 4, 2, 50, { int: true, unit: 'plates', show: (v) => hasRods(v) && v.nutPattern === 'nth' }),
  { id: 'rodTipNuts', label: 'Anchor nut at rod tips', group: 'Bracing', kind: 'toggle', def: true, show: hasRods, help: 'An extra nut near each end of every rod grips the concrete' },
  { id: 'rodStock', label: 'Stock lengths', group: 'Bracing', kind: 'text', def: '100, 150, 200, 250, 300, 400, 500, 1000', show: hasRods, help: 'Rod lengths you can buy (mm). Rods snap to the shortest that spans the stack and still stays inside the concrete; otherwise one is cut down.' },
  choice('spacerMode', 'Laser-cut spacers', 'Bracing', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'cross', label: 'Cross pieces (cast in)' },
    { value: 'template', label: 'Spacing template (lift off)' },
    { value: 'both', label: 'Both' },
  ], { show: isUpright, help: 'Cross pieces are combs cast in under the plates. The spacing template is a comb cut against the top profile that sits over the plates while the concrete cures.' }),
  num('crossPieces', 'Cross pieces', 'Bracing', 2, 1, 8, { int: true, unit: '', show: hasCross }),
  num('crossHeight', 'Cross piece height', 'Bracing', 30, 5, 300, { show: hasCross }),
  num('crossEngage', 'Cross slot depth', 'Bracing', 10, 1, 200, { show: hasCross, help: 'How far the teeth rise between the plates' }),
  num('crossAngle', 'Cross angle', 'Bracing', 0, -60, 60, { unit: '°', show: hasCross, help: '0 runs square to the plates; an angle braces them diagonally' }),
  num('templateCount', 'Templates', 'Bracing', 2, 1, 8, { int: true, unit: '', show: hasTemplate }),
  num('templateEngage', 'Template grip', 'Bracing', 15, 1, 200, { show: hasTemplate, help: 'How far the teeth hang down between the plates' }),
  num('templateSpine', 'Template spine', 'Bracing', 25, 5, 200, { show: hasTemplate, help: 'Solid strip above the tallest plate' }),
  num('templateLift', 'Template lift', 'Bracing', 5, 0, 200, { show: hasTemplate, help: 'Teeth stop this far above the concrete so the template lifts off clean' }),
  num('spacerClearance', 'Spacer slot clearance', 'Bracing', 0.2, 0, 3, { step: 0.05, show: hasSpacers, noScale: true }),
  num('braceCover', 'Concrete cover', 'Bracing', 10, 0, 100, { show: (v) => hasRods(v) || hasCross(v), help: 'Least concrete wanted around rods, nuts and cast-in cross pieces' }),

  // Plates
  choice('plateMaterial', 'Material', 'Plates', 'corten', [
    { value: 'steel', label: 'Mild steel' },
    { value: 'aluminium', label: 'Aluminium' },
    { value: 'corten', label: 'Corten' },
  ]),
  num('thickness', 'Thickness', 'Plates', 3, 0.5, 12, { step: 0.5, help: 'Common: 1.5, 3, 6 mm' }),
  choice('spacingMode', 'Spacing', 'Plates', 'fit', [
    { value: 'fit', label: 'Spread count over base' },
    { value: 'gap', label: 'Fixed gap, fill base' },
    { value: 'gapCount', label: 'Fixed gap, set count' },
  ], { show: isParallelish, help: 'Fixed gap sets the clear space between plate faces; the stack stays centred on the base' }),
  num('plateGap', 'Gap between plates', 'Plates', 10, 0.5, 500, { step: 0.5, show: (v) => isParallelish(v) && v.spacingMode !== 'fit', help: 'Clear space between neighbouring plate faces (pitch = thickness + gap)' }),
  num('plateCount', 'Plate count', 'Plates', 40, 2, 300, { int: true, unit: '', show: isParallelish, scaleCount: true }),
  num('stackLength', 'Stack run', 'Plates', 'alongWidth ? baseWidth : baseLength', 1, 5000, { show: isParallelish, help: 'Base length the plates are stacked along (alongWidth = 1 when slicing across)' }),
  num('acrossLength', 'Across run', 'Plates', 'alongWidth ? baseLength : baseWidth', 1, 5000, { show: isParallelish }),
  num('pitch', 'Pitch', 'Plates', '(stackLength - 2*endMargin) / (plateCount - 1)', 1, 500, { step: 0.1, show: isUpright }),
  num('plateWidth', 'Plate width', 'Plates', 'acrossLength - 2*sideMargin', 5, 3000, { show: isParallelish }),
  num('stackHeight', 'Plate height', 'Plates', 220, 10, 2000, { show: strataSource, help: 'Height of the plate tops above the concrete before erosion, crest and slope' }),
  num('embedDepth', 'Embed depth', 'Plates', 40, 0, 400, { show: (v) => !isFlat(v), help: 'How far each plate sinks into the concrete' }),
  num('tabInset', 'Embed tab inset', 'Plates', 0, 0, 200, { show: (v) => !isFlat(v), help: 'Narrows the embedded tab on each side' }),
  num('anchorHoles', 'Anchor holes', 'Plates', 2, 0, 12, { int: true, unit: '', show: (v) => !isFlat(v), help: 'Holes in the embedded tab that concrete flows through' }),
  num('anchorDia', 'Anchor hole Ø', 'Plates', 10, 2, 60, { show: (v) => !isFlat(v) }),

  // Slicer
  choice('sliceMode', 'Slicing', 'Slicer', 'parallel', [
    { value: 'parallel', label: 'Parallel stack' },
    { value: 'radial', label: 'Radial' },
    { value: 'waffle', label: 'Waffle (interlocking)' },
    { value: 'flat', label: 'Flat stack (face to face)' },
  ], { help: 'Flat stack lays the plates flat on top of each other (Plate count = layers); a top image is pressed down through the layers like a stamp' }),
  num('flatPins', 'Registration pins', 'Slicer', 2, 0, 8, { int: true, unit: '', show: isFlat, help: 'Holes through every layer they fit, for pins or threaded rod that line the stack up and fix it to the base' }),
  num('pinDia', 'Pin Ø', 'Slicer', 8, 2, 40, { show: (v) => isFlat(v) && v.flatPins > 0 }),
  { id: 'flatGuides', label: 'Etch glue-up guides', group: 'Slicer', kind: 'toggle', def: true, show: isFlat, help: 'Etches the outline of the layer above onto each layer' },
  choice('sliceAxis', 'Direction', 'Slicer', 'length', [
    { value: 'length', label: 'Along length (X)' },
    { value: 'width', label: 'Along width (Z)' },
  ], { show: isParallelish }),
  choice('stackSource', 'Slice what', 'Slicer', 'strata', [
    { value: 'strata', label: 'Eroded strata block' },
    { value: 'form', label: 'Source form' },
  ]),
  num('radialCount', 'Radial plates', 'Slicer', 24, 3, 180, { int: true, unit: '', show: (v) => v.sliceMode === 'radial', scaleCount: true }),
  num('radialHub', 'Hub radius', 'Slicer', 30, 0, 500, { show: (v) => v.sliceMode === 'radial' }),
  num('crossCount', 'Cross plates', 'Slicer', 'max(2, floor(plateWidth / 55))', 1, 200, { int: true, unit: '', show: (v) => v.sliceMode === 'waffle', scaleCount: true }),
  num('slotClearance', 'Slot allowance', 'Slicer', 0.2, 0, 3, { step: 0.05, show: (v) => v.sliceMode === 'waffle', help: 'Added to slot width (kerf allowance) for interlocking slots', noScale: true }),
  num('sampleStep', 'Profile resolution', 'Slicer', 2, 0.5, 20, { step: 0.5, noScale: true }),

  // Strata / erosion
  { id: 'strataOn', label: 'Strata erosion on', group: 'Strata', kind: 'toggle', def: true, show: strataSource, help: 'Off gives flat-topped plates at Plates › Plate height (images still apply)' },
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

  // Edges
  { id: 'edgesOn', label: 'Edge smoothing on', group: 'Edges', kind: 'toggle', def: true },
  num('edgeFlow', 'Strata flow', 'Edges', 0, 0, 120, {
    step: 0.5,
    show: strataSource,
    rand: true,
    help: 'Smooths the eroded top line itself into long, gentle curves (a window in mm along each plate)',
  }),
  num('edgeRound', 'Round all corners', 'Edges', 0, 0, 50, {
    step: 0.25,
    rand: true,
    help: 'Rounds every corner of every plate, image cuts included. The insert cavity, anchor holes and slots stay crisp so parts still fit.',
  }),

  // Insert
  { id: 'insertOn', label: 'Insert on', group: 'Insert', kind: 'toggle', def: true },
  ...formParams('ins', 'Insert', () => true, { shape: 'fin', length: 330, width: 56, height: 360, taper: 0.35, sweep: 90, camber: 22, bend: 18 }),
  choice('insMaterial', 'Material', 'Insert', 'concrete', [
    { value: 'concrete', label: 'Concrete (cast)' },
    { value: 'metal', label: 'Metal' },
    { value: 'void', label: 'Void (cut only)' },
  ], { show: (v) => v.insShape !== 'none' }),
  num('clearance', 'Fit clearance', 'Insert', 0.5, 0, 20, { step: 0.1, show: (v) => v.insShape !== 'none', help: 'Gap between the insert and each plate cavity', noScale: true }),
  choice('cavityMode', 'Cavity section', 'Insert', 'larger', [
    { value: 'larger', label: 'Larger of front/back (slides in)' },
    { value: 'smaller', label: 'Smaller of front/back (tight)' },
    { value: 'mid', label: 'Mid-plane section' },
  ], { show: (v) => v.insShape !== 'none' }),
  { id: 'insTint', label: 'Insert tint', group: 'Insert', kind: 'color', def: '#6f6a64', show: (v) => v.insShape !== 'none' && v.insMaterial === 'concrete' },

  // Source form
  ...formParams('src', 'Source form', (v) => v.stackSource === 'form', { shape: 'revolve', width: 260, height: 300, taper: 0.5, camber: 60, length: 600 }),

  // Image
  { id: 'imageOn', label: 'Image on', group: 'Image', kind: 'toggle', def: true, help: 'Off ignores every image (side, top, front and etching) without clearing them' },
  choice('imgSideMode', 'Side profile', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'heightmap', label: 'Image as height (strip per plate)' },
    { value: 'silhouette', label: 'Traced silhouette' },
  ], { show: strataSource }),
  num('imgMix', 'Strata ↔ image mix', 'Image', 0.6, 0, 1, { step: 0.01, unit: '', show: (v) => strataSource(v) && v.imgSideMode !== 'off', rand: true }),
  num('imgRange', 'Image height range', 'Image', 140, 0, 2000, { show: (v) => strataSource(v) && v.imgSideMode !== 'off' }),
  num('imgContrast', 'Contrast', 'Image', 1.2, 0.1, 5, { step: 0.05, unit: '×' }),
  num('imgSmooth', 'Image blur', 'Image', 1, 0, 10, { int: true, unit: 'px', help: 'Blurs the picture before it is read (softens detail, not the cut edges)' }),
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
  choice('topProfile', 'Impression profile', 'Image', 'tone', [
    { value: 'tone', label: 'Tone (depth follows darkness)' },
    { value: 'pillow', label: 'Pillow (rounded shoulders)' },
    { value: 'balloon', label: 'Balloon (fully inflated dome)' },
    { value: 'chamfer', label: 'Chamfer (straight bevel)' },
  ], { show: (v) => v.imgTopMode !== 'off', help: 'Shape of the impression across the picture: for flat PNGs, pillow and balloon inflate the silhouette from its edges' }),
  num('topBillow', 'Billow width', 'Image', 25, 1, 400, {
    show: (v) => v.imgTopMode !== 'off' && (v.topProfile === 'pillow' || v.topProfile === 'chamfer'),
    rand: true,
    help: 'How far in from the edge of the shape the rounded shoulder reaches',
  }),
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
  choice('topOutline', 'Shape outline', 'Image', 'alpha', [
    { value: 'off', label: 'Off (plates keep their full width)' },
    { value: 'alpha', label: 'Transparent PNG edge' },
    { value: 'matte', label: 'PNG edge or light background' },
  ], { show: (v) => v.imgTopMode !== 'off', help: 'Trims every plate to the silhouette of the top image seen from above, so the stack takes on the shape. Images without a background to cut away keep the plain outline.' }),
  num('topChoke', 'Outline choke', 'Image', 0, -200, 200, {
    step: 0.5,
    show: (v) => v.imgTopMode !== 'off' && v.topOutline !== 'off',
    help: 'Pulls the plate ends in from the silhouette edge (positive) or spreads them out past it (negative)',
  }),
  choice('imgFit', 'Fit stack to image', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'width', label: 'Keep length, set width from image' },
    { value: 'length', label: 'Keep width, set length from image' },
  ], { show: (v) => v.imgTopMode !== 'off' && v.sliceMode !== 'radial', help: 'Sizes the plate footprint (and base) to the top image proportions so the image fills the top' }),
  num('cutSmooth', 'Cut edge smoothing', 'Image', 0, 0, 25, {
    step: 0.25,
    show: (v) => v.imgTopMode !== 'off' || (v.sliceMode === 'parallel' && v.imgFrontMode !== 'off'),
    help: 'Rounds the edges of the image cuts only (steps, recess floors, pixel stair-steps). Outer plate edges are untouched: use Edges › Round all corners for those.',
  }),
  choice('imgFrontMode', 'Front view', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'layers', label: 'Layered cut-outs (depth = dark)' },
    { value: 'halftone', label: 'Halftone holes' },
  ], { show: (v) => v.sliceMode === 'parallel' }),
  num('imgFrontStrength', 'Front strength', 'Image', 0.5, 0, 1, { step: 0.01, unit: '', show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode !== 'off' }),
  num('frontDepth', 'Plates carrying image', 'Image', 10, 1, 300, { int: true, unit: '', show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode === 'layers' }),
  num('halftoneSpacing', 'Dot spacing', 'Image', 12, 3, 100, { show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode === 'halftone' }),
  choice('etchMode', 'Etched lines', 'Image', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'hatch', label: 'Hatch lines (line up plate to plate)' },
    { value: 'contour', label: 'Contour per plate' },
  ], { show: (v) => v.sliceMode === 'parallel' }),
  num('etchSpacing', 'Etch spacing', 'Image', 4, 0.5, 50, { step: 0.5, show: (v) => v.sliceMode === 'parallel' && v.etchMode !== 'off' }),

  // Margins: every inset from the base edge or plate edge, in one place
  num('endMargin', 'End margin', 'Margins', 40, 0, 1000, { show: isParallelish, help: 'Base end to the outer plate centre (the minimum when a fixed gap fills the base)' }),
  num('sideMargin', 'Side margin', 'Margins', 20, 0, 1000, { help: 'Base side to the plate edge' }),
  num('topMargin', 'Top image margin', 'Margins', 10, 0, 300, { show: (v) => v.imgTopMode !== 'off', help: 'Keeps the top image this far in from the plate footprint edge' }),
  num('frontMargin', 'Front image frame', 'Margins', 15, 0, 300, { show: (v) => v.sliceMode === 'parallel' && v.imgFrontMode !== 'off', help: 'Solid frame left round the front image cut-outs on each plate' }),

  // Tuning: plates cut to ring at chosen notes
  { id: 'tuneOn', label: 'Tuning on', group: 'Tuning', kind: 'toggle', def: true, show: (v) => strataSource(v) && (v.sliceMode === 'parallel' || v.sliceMode === 'radial') },
  choice('tuneMode', 'Tuned plates', 'Tuning', 'off', [
    { value: 'off', label: 'Off' },
    { value: 'scale', label: 'Climb a scale' },
    { value: 'chord', label: 'Spread a chord' },
    { value: 'notes', label: 'My notes' },
  ], {
    show: (v) => strataSource(v) && (v.sliceMode === 'parallel' || v.sliceMode === 'radial'),
    help: 'Each plate gets a flat top at the height that makes it ring at its note when struck: the plate is a steel tine clamped in the concrete. Uses Plates › Material and Thickness.',
  }),
  { id: 'tuneRoot', label: 'Lowest note', group: 'Tuning', kind: 'text', def: 'C3', show: (v) => isTuned(v) && v.tuneMode !== 'notes', help: 'Like C3, F#2 or Bb4 (A4 = 440 Hz)' },
  choice('tuneScale', 'Scale', 'Tuning', 'major', SCALE_OPTIONS, { show: (v) => isTuned(v) && v.tuneMode === 'scale' }),
  choice('tuneChord', 'Chord', 'Tuning', 'major', CHORD_OPTIONS, { show: (v) => isTuned(v) && v.tuneMode === 'chord', help: 'Chord tones repeat up through the octaves, one per plate' }),
  { id: 'tuneNotes', label: 'Notes', group: 'Tuning', kind: 'text', def: 'A2 C3 E3 G3 A3', show: (v) => isTuned(v) && v.tuneMode === 'notes', help: 'Space-separated, repeated if there are more plates than notes' },
  choice('tuneOrder', 'Layout', 'Tuning', 'up', [
    { value: 'up', label: 'Low to high (front to back / round the ring)' },
    { value: 'down', label: 'High to low' },
    { value: 'middle', label: 'Tallest in the middle' },
    { value: 'ends', label: 'Tallest at the ends' },
    { value: 'listed', label: 'As listed' },
  ], { show: isTuned }),
  num('tuneAllowance', 'Tuning allowance', 'Tuning', 2, 0, 15, {
    step: 0.5,
    unit: '%',
    noScale: true,
    show: isTuned,
    help: 'Cuts each plate this much taller than predicted, so it starts a little flat. Grinding the top down raises the pitch: trim to a tuner.',
  }),

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
  num('slotGap', 'Slot gap', 'Concrete', 1, 0, 10, { step: 0.1, show: (v) => v.embedMode === 'slot', help: 'Slot width = thickness + gap', noScale: true }),

  // Sun study: where the piece stands, for real sunlight and shadows in the 3D view
  { id: 'sunOn', label: 'Sun study', group: 'Sun', kind: 'toggle', def: false, help: 'Light the 3D view with the real sun for this place and date. Scrub the time of day at the bottom of the 3D view.' },
  num('sunLat', 'Latitude', 'Sun', 51.5, -89, 89, { unit: '°N', step: 0.1, noScale: true, help: 'Degrees north; negative for the southern hemisphere. London 51.5, Edinburgh 56.0' }),
  num('sunLon', 'Longitude', 'Sun', -0.1, -180, 180, { unit: '°E', step: 0.1, noScale: true, help: 'Degrees east; negative for west. Only shifts the clock times' }),
  num('sunUtc', 'Clock offset from UTC', 'Sun', 0, -12, 14, { unit: 'h', step: 0.5, noScale: true, help: 'UK: 0 in winter (GMT), 1 in summer (BST)' }),
  num('sunFacing', 'Front faces', 'Sun', 180, 0, 360, { unit: '°', step: 1, noScale: true, help: 'Compass bearing the front of the piece looks out to (the end the Front view looks at): 0 north, 90 east, 180 south, 270 west' }),
  choice('sunMonth', 'Month', 'Sun', '6', ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => ({ value: String(i + 1), label: m })), {}),
  num('sunDay', 'Day', 'Sun', 21, 1, 31, { unit: '', int: true, noScale: true }),
  { id: 'sunPath', label: 'Show sun path', group: 'Sun', kind: 'toggle', def: true, help: "Today's path across the sky, with midsummer and midwinter for reference, and a compass on the ground" },

  // Shadow carving: holes through the plates so the sun casts pictures on a wall behind
  { id: 'shadowOn', label: 'Shadow pictures', group: 'Shadow', kind: 'toggle', def: false, help: 'Carve the plates so the sun casts your pictures on a wall, the ground or the concrete behind the piece. Add pictures and their times in the Shadow view.' },
  choice('shadowExec', 'Execution', 'Shadow', 'frames', [
    { value: 'frames', label: 'Timed frames in place (a flip book)' },
    { value: 'side', label: 'Timed frames side by side (a film strip)' },
    { value: 'allday', label: 'One picture, all day' },
  ], { help: 'In place: each picture appears at its own time, all on the same patch of screen. Side by side: each picture sits where its own light comes straight through the plates, so they make a row along the screen (spaced by the sun) and light up in turn. All day: the first picture is carved for every hour of daylight (softer, but always there)' }),
  choice('shadowScreen', 'Screen', 'Shadow', 'wall', [
    { value: 'wall', label: 'Wall behind' },
    { value: 'ground', label: 'Ground behind' },
    { value: 'base', label: 'Top of the concrete' },
  ], { help: 'Where the shadow lands. The ground and the concrete top need the sun fairly high, and the ground picture usually sits well back from the base so the light clears it' }),
  num('shadowGap', 'Screen distance', 'Shadow', 30, -3000, 3000, {
    help: 'Wall: from the back plate to the wall (closer is crisper: the sun blurs shadows about 1 mm per 100 mm). Ground or concrete top: from the back plate to the near edge of the picture; negative starts it under the plates',
  }),
  num('shadowW', 'Picture width', 'Shadow', 180, 10, 3000, { help: 'Each picture, side by side or not' }),
  num('shadowH', 'Picture height', 'Shadow', 120, 10, 3000, { help: 'On the ground or the concrete, this runs away from the front of the piece' }),
  num('shadowX', 'Picture across', 'Shadow', 0, -3000, 3000, { help: 'Centre of the picture (or the row of pictures), right of the middle as you look from the front' }),
  num('shadowY', 'Picture bottom', 'Shadow', 'baseHeight + 20', 0, 3000, { show: (v) => v.shadowScreen === 'wall', help: 'Height of the bottom of the picture above the ground' }),
  num('shadowFade', 'Crossfade', 'Shadow', 0, 0, 100, {
    unit: '%',
    noScale: true,
    show: (v) => v.shadowExec !== 'allday',
    help: 'Stretches each frame toward its neighbours\' times so one fades out as the next fades in. 50% meets halfway; more overlaps. Softer pictures and more stray light',
  }),
  num('shadowBridge', 'Bridge width', 'Shadow', 'thickness', 0, 30, {
    step: 0.5,
    help: 'Loose bits inside the cut-outs are held in by bridges this wide, like a stencil. 0 cuts them away instead (cleaner plates, more stray light)',
  }),
  num('shadowRim', 'Solid rim', 'Shadow', 8, 0, 100, { help: 'Uncut border kept up both sides of every plate and above the concrete. The top edge may be notched where the low sun reaches over it' }),
  num('shadowCell', 'Resolution', 'Shadow', 3, 1, 10, { step: 0.5, noScale: true, help: 'Size of one picture pixel on the wall and in the plates. Finer is sharper but makes more, smaller holes' }),
  num('shadowThreshold', 'Light above', 'Shadow', 0.5, 0, 1, { unit: '', step: 0.01, noScale: true, help: 'Picture brightness above which the wall should be lit' }),
  { id: 'shadowInvert', label: 'Swap light and dark', group: 'Shadow', kind: 'toggle', def: false, help: 'Light the dark parts of the pictures instead' },

  // Mould
  { id: 'mouldOn', label: 'Generate moulds', group: 'Mould', kind: 'toggle', def: true },
  num('plyThickness', 'Plywood thickness', 'Mould', 18, 3, 50, { step: 0.5, noScale: true }),
  num('mouldWall', 'Wall thickness', 'Mould', 40, 3, 300),
  num('draft', 'Draft', 'Mould', 0.5, 0, 10, { unit: '°', step: 0.1 }),
  num('dowelDia', 'Dowel Ø', 'Mould', 8, 2, 30, { noScale: true }),
  num('tabsPerSide', 'Clamp tabs / side', 'Mould', 2, 0, 8, { int: true, unit: '' }),
  num('tabSize', 'Tab size', 'Mould', 40, 5, 200),
  choice('mouldSplit', 'Split rings', 'Mould', 'halves', [
    { value: 'none', label: 'Whole rings' },
    { value: 'halves', label: 'Halves (opens to release)' },
  ]),
  { id: 'jigOn', label: 'Plate jig board', group: 'Mould', kind: 'toggle', def: true, help: 'Board with slots that holds plates at pitch while concrete cures' },
  num('jigClearance', 'Jig slot clearance', 'Mould', 0.3, 0, 5, { step: 0.05, noScale: true }),
  num('plySheetW', 'Ply sheet length', 'Mould', 2440, 300, 5000, { noScale: true }),
  num('plySheetH', 'Ply sheet width', 'Mould', 1220, 300, 3000, { noScale: true }),

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
  num('kerf', 'Kerf', 'Fabrication', 0.15, 0, 3, { step: 0.01, help: 'Laser beam width; outlines are offset by half', noScale: true }),
  num('arcTolerance', 'Arc fit tolerance', 'Fabrication', 0.05, 0.005, 2, { step: 0.005, noScale: true }),
  num('minFeature', 'Min feature', 'Fabrication', 2, 0, 50, { step: 0.1, help: 'Narrowest web of material the laser can leave', noScale: true }),
  num('minPartSize', 'Min part size', 'Fabrication', 15, 0, 500, { noScale: true }),
  num('sheetW', 'Sheet length', 'Fabrication', 2500, 100, 6000, { noScale: true }),
  num('sheetH', 'Sheet width', 'Fabrication', 1250, 100, 3000, { noScale: true }),
  num('partSpacing', 'Part spacing', 'Fabrication', 6, 0, 100, { noScale: true }),
  num('labelHeight', 'Label height', 'Fabrication', 6, 2, 50, { step: 0.5, noScale: true }),
  { id: 'partPrefix', label: 'Part prefix', group: 'Fabrication', kind: 'text', def: 'S' },
  choice('dxfMode', 'DXF entities', 'Fabrication', 'polyline', [
    { value: 'polyline', label: 'Closed polylines with arcs' },
    { value: 'lines', label: 'Separate LINE + ARC' },
  ]),
];

export const PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.id, p]));

export interface GroupSwitch {
  /** Toggle parameter shown as the switch in the group's header. */
  id: string;
  /** Values the model sees while the switch is off. The stored settings are kept for when it goes back on. */
  forces?: Record<string, RawValue>;
  /** Keep the group's settings on show while off (they still shape the rest of the piece). */
  keepOpen?: boolean;
}

/** Groups with an on/off switch in their header. */
export const GROUP_SWITCHES: Partial<Record<(typeof GROUPS)[number], GroupSwitch>> = {
  Base: { id: 'baseOn', keepOpen: true },
  Support: { id: 'supportOn', forces: { supportMode: 'off' } },
  Bracing: { id: 'bracingOn', forces: { rodsOn: false, spacerMode: 'off' } },
  Strata: { id: 'strataOn', forces: { erosionAmp: '0', banding: '0', crest: '0', slope: '0' } },
  Edges: { id: 'edgesOn', forces: { edgeFlow: '0', edgeRound: '0' } },
  Insert: { id: 'insertOn', forces: { insShape: 'none' } },
  Image: { id: 'imageOn', forces: { imgSideMode: 'off', imgTopMode: 'off', imgFrontMode: 'off', etchMode: 'off', topOutline: 'off', imgFit: 'off' } },
  Tuning: { id: 'tuneOn', forces: { tuneMode: 'off' } },
  Mould: { id: 'mouldOn' },
  Sun: { id: 'sunOn' },
  Shadow: { id: 'shadowOn' },
};
const SLICE_NAME: Record<string, string> = { parallel: 'parallel', radial: 'radial', waffle: 'waffle', flat: 'flat stack' };

/**
 * Groups that do nothing in the current setup, with the one-line reason shown
 * in their place (null while the group is in use). Their settings are kept.
 */
export const GROUP_IDLE: Partial<Record<(typeof GROUPS)[number], (v: Values) => string | null>> = {
  Support: (v) => (v.baseOn ? null : 'Not used while Base is off: the ring is cast into the concrete.'),
  Bracing: (v) => (isUpright(v) ? null : `Not used with ${SLICE_NAME[v.sliceMode] ?? v.sliceMode} slicing: rods and spacers brace upright parallel or waffle plates.`),
  Strata: (v) => (strataSource(v) ? null : 'Not used while Slicer › Slice what is Source form: plate edges come from the form.'),
  'Source form': (v) => (v.stackSource === 'form' ? null : 'Used only when Slicer › Slice what is Source form.'),
  Tuning: (v) =>
    !strataSource(v)
      ? 'Not used while Slicer › Slice what is Source form.'
      : v.sliceMode === 'parallel' || v.sliceMode === 'radial'
        ? null
        : `Not used with ${SLICE_NAME[v.sliceMode] ?? v.sliceMode} slicing: tuning works on parallel or radial plates.`,
  Shadow: (v) => (!v.shadowOn ? null : !v.sunOn ? 'Needs Sun study on: the pictures are carved for the real sun at its place and date.' : v.sliceMode !== 'parallel' ? `Works with parallel plates for now, not ${SLICE_NAME[v.sliceMode] ?? v.sliceMode} slicing.` : null),
};

export const SWITCH_IDS = new Set(Object.values(GROUP_SWITCHES).map((s) => s!.id));

/** The raw values with every switched-off group's forced values laid over them. */
export function applySwitches(raw: Record<string, RawValue>): Record<string, RawValue> {
  let out = raw;
  for (const sw of Object.values(GROUP_SWITCHES)) {
    if (!sw!.forces || isOn(raw, sw!.id)) continue;
    if (out === raw) out = { ...raw };
    Object.assign(out, sw!.forces);
  }
  return out;
}

export function defaultRaw(): Record<string, RawValue> {
  return Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));
}

export interface EvalResult {
  values: Values;
  /** Parameters currently driven by "Fit stack to image", with the expression used. */
  overrides: Record<string, string>;
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
export function flagsFor(raw: Record<string, RawValue>, extra: Record<string, number> = {}): Record<string, number> {
  const get = (id: string) => String(raw[id] ?? PARAM_MAP[id].def);
  return {
    alongWidth: get('sliceAxis') === 'width' ? 1 : 0,
    isRadial: get('sliceMode') === 'radial' ? 1 : 0,
    isWaffle: get('sliceMode') === 'waffle' ? 1 : 0,
    imgAspect: 1,
    ...extra,
  };
}

function masterOf(raw: Record<string, RawValue>): number {
  const r = String(raw.masterScale ?? PARAM_MAP.masterScale.def);
  const x = isLiteral(r) ? parseFloat(r) : NaN;
  const d = PARAM_MAP.masterScale;
  return Number.isFinite(x) ? Math.min(d.max!, Math.max(d.min!, x)) : 1;
}

const isOn = (raw: Record<string, RawValue>, id: string) => {
  const r = raw[id] ?? PARAM_MAP[id].def;
  return r === true || r === 'true';
};

/** How much Master size multiplies this parameter's literal value. */
export function scaleFactorFor(id: string, raw: Record<string, RawValue>): number {
  const d = PARAM_MAP[id];
  if (!d || d.kind !== 'number' || d.noScale) return 1;
  const m = masterOf(raw);
  if (m === 1) return 1;
  if (d.scaleCount) return isOn(raw, 'masterCount') ? m : 1;
  if (id === 'thickness') return isOn(raw, 'masterThickness') ? m : 1;
  return d.unit === 'mm' ? m : 1;
}

/**
 * Expressions that replace a parameter while "Fit stack to image" is on. The
 * footprint is sized so (plate width - 2 margins) / (stack run - 2 margins)
 * equals the top image's on-surface aspect (imgAspect).
 */
export function fitOverrides(raw: Record<string, RawValue>): Record<string, string> {
  const fit = String(raw.imgFit ?? 'off');
  const top = String(raw.imgTopMode ?? 'off');
  if (fit === 'off' || top === 'off' || String(raw.sliceMode ?? 'parallel') === 'radial') return {};
  const alongWidth = String(raw.sliceAxis ?? 'length') === 'width';
  const run = alongWidth ? 'baseWidth' : 'baseLength'; // base side the plates stack along
  const across = alongWidth ? 'baseLength' : 'baseWidth';
  if (fit === 'width') return { [across]: `imgAspect * (${run} - 2*endMargin - 2*topMargin) + 2*topMargin + 2*sideMargin` };
  return { [run]: `(${across} - 2*sideMargin - 2*topMargin) / imgAspect + 2*topMargin + 2*endMargin` };
}

/**
 * Expressions that replace pitch (and plate count) while Plates › Spacing is a
 * fixed gap. "Fill base" fits as many plates as the stack run allows inside the
 * end margins; plates are always laid out symmetric about the base centre.
 */
export function spacingOverrides(raw: Record<string, RawValue>): Record<string, string> {
  const mode = String(raw.spacingMode ?? 'fit');
  if (mode === 'fit' || String(raw.sliceMode ?? 'parallel') === 'radial') return {};
  const out: Record<string, string> = { pitch: 'thickness + plateGap' };
  if (mode === 'gap') out.plateCount = 'floor((stackLength - 2*endMargin) / (thickness + plateGap)) + 1';
  return out;
}

/** Which setting drives each overridden parameter, for the panel's label. */
export function overrideSource(id: string): 'spacing' | 'image' {
  return id === 'pitch' || id === 'plateCount' ? 'spacing' : 'image';
}

export const FLAG_NAMES = ['alongWidth', 'isRadial', 'isWaffle', 'imgAspect'];

/** Evaluate the whole parameter graph in dependency order. */
export function evaluateParams(rawArg: Record<string, RawValue>, extra: Record<string, number> = {}): EvalResult {
  // switched-off groups (header switches) are evaluated with their features off
  const rawIn = applySwitches(rawArg);
  // Master size multiplies literal values; image fit swaps in expressions
  const overrides = { ...fitOverrides(rawIn), ...spacingOverrides(rawIn) };
  const raw: Record<string, RawValue> = { ...rawIn, ...overrides };
  for (const d of PARAMS) {
    if (d.kind !== 'number' || overrides[d.id]) continue;
    const r = String(raw[d.id] ?? d.def);
    const k = scaleFactorFor(d.id, rawIn);
    if (k !== 1 && isLiteral(r)) raw[d.id] = String(parseFloat(r) * k);
  }
  const values: Values = {};
  const errors: Record<string, string> = {};
  const clamped: Record<string, boolean> = {};
  const deps: Record<string, string[]> = {};
  const nodes: Record<string, Node> = {};
  const numIds = PARAMS.filter((p) => p.kind === 'number').map((p) => p.id);
  const numSet = new Set(numIds);
  const flags = flagsFor(raw, extra);

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
  return { values, overrides, errors, clamped, deps, order: fullOrder };
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
