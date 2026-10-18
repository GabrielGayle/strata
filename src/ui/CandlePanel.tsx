import { useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { candleList, DEFAULT_CANDLES, HOLDER_NAMES, parseCandles, PATH_NAMES, PRESETS, type CandlePath, type CandleSpec, type Holder } from '../core/candles';
import type { Model } from '../core/pipeline';
import type { RawValue } from '../core/params';
import { baseTop } from '../core/slicer';

type NumKey = 'size' | 'bend' | 'lift' | 'crown' | 'ramp' | 'grip' | 'cup' | 'fins' | 'reach' | 'spin' | 'slack' | 'shoulder' | 'x' | 'z' | 'turn';

interface Field {
  key: NumKey;
  label: string | ((s: CandleSpec) => string);
  step: number;
  hint: string | ((s: CandleSpec) => string);
  show?: (s: CandleSpec) => boolean;
}

const BEND_LABEL: Partial<Record<CandlePath, string>> = { arc: 'Sweep', wave: 'Wave', spiral: 'Turns', star: 'Points' };
const BEND_HINT: Partial<Record<CandlePath, string>> = {
  arc: 'How far round the arc bends (degrees). 0 is nearly straight, 180 a half circle, 300 almost a ring.',
  wave: 'How far the wave swings forward and back (mm).',
  spiral: 'How many times the spiral turns.',
  star: 'How many points the star has.',
};
const hasStick = (s: CandleSpec) => candleList(s).some((c) => !c.tealight);
const hasTarget = (s: CandleSpec) => candleList(s).some((c) => (c.tealight ? c.holder === 'target' : (c.holder ?? s.holder) === 'target'));

const FIELDS: Field[] = [
  { key: 'size', label: (s) => (s.path === 'circle' ? 'Across' : s.path === 'line' || s.path === 'wave' ? 'Length' : 'Width'), step: 10, hint: 'How big the path is (mm): its length for a line or wave, the diameter for a circle, the width for the other shapes.', show: (s) => s.path !== 'custom' },
  { key: 'bend', label: (s) => BEND_LABEL[s.path] ?? 'Bend', step: 1, hint: (s) => BEND_HINT[s.path] ?? '', show: (s) => s.path in BEND_LABEL },
  { key: 'lift', label: 'Lift', step: 5, hint: 'Height of the candle bottoms above the concrete (mm). The plates step up to meet them.' },
  { key: 'crown', label: 'Crown', step: 5, hint: 'Extra height for the middle candles (mm), rising in a curve like a candelabra. Negative dips the middle. Rings and shapes have no middle, so it does nothing there.' },
  { key: 'ramp', label: 'Climb', step: 5, hint: 'How much higher the last candle stands than the first (mm).' },
  { key: 'grip', label: 'Grip', step: 1, hint: 'How far up each candlestick its holder reaches (mm). 25 to 35 holds a dinner candle steady.', show: hasStick },
  { key: 'cup', label: 'Cup', step: 1, hint: 'How deep each tealight sits in its cup (mm). About half its height shows off the metal rim and keeps it safe.' },
  { key: 'fins', label: 'Fins', step: 1, hint: 'Target holder: how many fins stand round each candlestick. 4 makes the crosshair target; 3 a tripod; 6 or 8 a star.', show: hasTarget },
  { key: 'reach', label: 'Reach', step: 1, hint: 'Target holder: how far each fin reaches out from the candle (mm). The plates are cleared a little wider than this.', show: hasTarget },
  { key: 'spin', label: 'Spin', step: 5, hint: 'Target holder: turn the fins round the candle (degrees). 45 sets a 4-fin cross across the plates.', show: hasTarget },
  { key: 'slack', label: 'Slack', step: 0.1, hint: 'Gap left round each candle (mm), so it drops in. Candles vary, so 0.5 to 1 mm is safe.' },
  { key: 'shoulder', label: 'Shoulder', step: 1, hint: 'Plate kept either side of each cup or holder as it steps up (mm).' },
  { key: 'x', label: 'X', step: 10, hint: 'Slide the candelabra left or right (mm).' },
  { key: 'z', label: 'Z', step: 10, hint: 'Slide the candelabra forward or back (mm).' },
  { key: 'turn', label: 'Turn', step: 5, hint: 'Turn the whole candelabra to face another way (degrees).' },
];

const DEFAULT_HINT =
  'Type one candle per line: a name like "5 taper", "tealight", "maxi", or diameter × height in mm like "24 x 300 stick". Add "socket" or "target" to a line to pick its holder. Hover any value to see what it does.';

/** Settings that make the plates flat-topped and tall enough to meet every candle, on a base big enough to hold them (null with no candles). */
export function fitCandles(model: Model, s: CandleSpec): Record<string, RawValue> | null {
  const held = model.objects.filter((o) => o.object.id.startsWith('candle') || o.object.id.startsWith('well'));
  if (!held.length) return null;
  const v = model.v;
  const top = baseTop(v);
  let need = 0;
  let ext = 0;
  let depth = 0;
  for (const b of held) {
    const o = b.object;
    const bb = b.geometry.boundingBox!;
    if (o.seat !== undefined) need = Math.max(need, bb.min.y - top + o.seat + 2);
    const r = o.w / 2 + (o.holder ? o.holder.reach + s.slack : 0) + s.shoulder;
    ext = Math.max(ext, Math.abs(o.x) + r);
    depth = Math.max(depth, Math.abs(o.z) + r);
  }
  return {
    strataOn: false,
    insShape: 'none',
    stackHeight: String(Math.ceil(Math.max(need, 10))),
    baseLength: String(Math.max(Math.ceil(2 * ext + 40), Number(v.baseLength))),
    baseWidth: String(Math.max(Math.ceil(2 * depth + 40), Number(v.baseWidth))),
  };
}

/** Candelabra: the candles, the path they follow, and how the plates hold them. */
export default function CandlePanel() {
  const model = useModel();
  const stored = useStore((s) => s.project.candles);
  const setCandles = useStore((s) => s.setCandles);
  const setParams = useStore((s) => s.setParams);
  const [hint, setHint] = useState<string | null>(null);

  if (!stored)
    return (
      <div className="mp-row ap-edit">
        <button className="btn sm" onClick={() => setCandles({ ...DEFAULT_CANDLES })} title="Start a candelabra: five dinner candles and four tealights along an arc">
          + Candelabra
        </button>
        <span className="ap-label">Lay candlesticks and tealights along a curve, a path or a shape, with the plates rising to hold them.</span>
      </div>
    );

  const s = stored;
  const edit = (patch: Partial<CandleSpec>, key?: string) => setCandles({ ...s, ...patch }, key);
  const { bad } = parseCandles(s.candles);
  const list = candleList(s);
  const help = (h: string) => ({
    onMouseEnter: () => setHint(h),
    onMouseLeave: () => setHint(null),
    title: h,
  });
  const addLine = (word: string) => edit({ candles: `${s.candles.replace(/\s+$/, '')}\n${word}`.replace(/^\n/, '') }, 'candles:list');

  const fit = () => {
    const patch = fitCandles(model, s);
    if (patch) setParams(patch, 'Fit plates to the candelabra');
  };

  // candles that stand between plates in a socket have nothing holding them
  const loose = model.objects.filter((b) => b.object.seat !== undefined && b.object.id.startsWith('candle') && !model.sliced.plates.some((p) => p.parts.length && crosses(p.def.plane.origin, p.def.plane.normal, b.geometry.boundingBox!))).length;
  const sticks = list.filter((c) => !c.tealight).length;
  const summary = `${list.length} candle${list.length === 1 ? '' : 's'}: ${sticks} candlestick${sticks === 1 ? '' : 's'}, ${list.length - sticks} tealight${list.length - sticks === 1 ? '' : 's'}.${loose ? ` ${loose} stand${loose === 1 ? 's' : ''} between plates with nothing holding ${loose === 1 ? 'it' : 'them'}: give ${loose === 1 ? 'it' : 'them'} a target holder or nudge the path.` : ''}${bad.length ? ` Couldn't read: ${bad.join(', ')}.` : ''}`;

  return (
    <>
      <div className="mp-row ap-edit ob-edit shelf-edit">
        <label className="ob-num" {...help('Off keeps the list but takes the candles and their holders away.')}>
          <input type="checkbox" checked={s.on} onChange={(e) => edit({ on: e.target.checked })} /> <span>Candles</span>
        </label>
        <textarea aria-label="Candles" rows={4} value={s.candles} onChange={(e) => edit({ candles: e.target.value }, 'candles:list')} onMouseEnter={() => setHint(DEFAULT_HINT)} onMouseLeave={() => setHint(null)} placeholder={'5 taper\n4 tealight\n58 x 24 maxi'} />
        <div className="shelf-side">
          <select aria-label="Path" value={s.path} onChange={(e) => edit({ path: e.target.value as CandlePath })} {...help('The line the candles follow. They are spread evenly along it; round shapes share the gap back to the start too.')}>
            {(Object.keys(PATH_NAMES) as CandlePath[]).map((k) => (
              <option key={k} value={k}>
                {PATH_NAMES[k]}
              </option>
            ))}
          </select>
          <select aria-label="Holder" value={s.holder} onChange={(e) => edit({ holder: e.target.value as Holder })} {...help('How candlesticks are held. Target: fins stand round each one like crosshairs, set in the concrete, and the plates step up to meet them. Socket: the plates it stands in are cut to grip it. Tealights always sit in a cup.')}>
            {(Object.keys(HOLDER_NAMES) as Holder[]).map((k) => (
              <option key={k} value={k}>
                {HOLDER_NAMES[k]}
              </option>
            ))}
          </select>
          <label className="ob-num" {...help('Spread the lines through each other (candle, tealight, candle…) rather than laying them one after another.')}>
            <input type="checkbox" checked={s.alternate} onChange={(e) => edit({ alternate: e.target.checked })} /> <span>Mix</span>
          </label>
          <label className="ob-num" {...help('Step the plate tops up to the candles. Off leaves the plates as they are, with just the cups and holders cut.')}>
            <input type="checkbox" checked={s.trim} onChange={(e) => edit({ trim: e.target.checked })} /> <span>Step plates</span>
          </label>
          <button className="btn sm" onClick={fit} {...help('Make the plates flat-topped and tall enough to meet every candle, the base big enough to hold them, and take the insert out of the way. Undo puts it all back.')}>
            Fit plates
          </button>
          <button className="btn sm" onClick={() => setCandles(undefined)} title="Take the candelabra away (undo brings it back)">
            Remove
          </button>
        </div>
      </div>
      <div className="mp-row ap-edit">
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} className="btn sm" onClick={() => addLine(k)} {...help(`Add a ${p.label.toLowerCase()}: about ${p.d} mm across and ${p.h} mm tall. Sizes vary by maker, so type your own as "${p.d} x ${p.h}" if yours differ.`)}>
            + {p.label}
          </button>
        ))}
      </div>
      {s.path === 'custom' && (
        <div className="mp-row ap-edit ob-edit">
          <input aria-label="Path points" style={{ width: 320 }} value={s.points} onChange={(e) => edit({ points: e.target.value }, 'candles:points')} {...help('Points the path runs through, as "x, z" in mm from the centre of the base, separated by semicolons. Forward is +z. The path curves smoothly through them.')} />
          <label className="ob-num" {...help('Join the last point back to the first, making a closed shape.')}>
            <input type="checkbox" checked={s.closed} onChange={(e) => edit({ closed: e.target.checked })} /> <span>Closed</span>
          </label>
        </div>
      )}
      <div className="mp-row ap-edit ob-edit">
        {FIELDS.filter((f) => !f.show || f.show(s)).map((f) => {
          const h = typeof f.hint === 'function' ? f.hint(s) : f.hint;
          return (
            <label key={f.key} className="ob-num" {...help(h)}>
              <span>{typeof f.label === 'function' ? f.label(s) : f.label}</span>
              <input
                type="number"
                step={f.step}
                aria-label={h}
                value={+s[f.key].toFixed(2)}
                onChange={(e) => {
                  const x = parseFloat(e.target.value);
                  if (Number.isFinite(x)) edit({ [f.key]: f.key === 'fins' ? Math.max(2, Math.min(8, Math.round(x))) : x }, `candles:${f.key}`);
                }}
              />
            </label>
          );
        })}
      </div>
      <div className="mp-info">{hint ?? (s.on ? `${summary} ${fmt(s.size / 10, 0)} cm path.` : 'The candelabra is off.')}</div>
    </>
  );
}

/** Whether a plate's plane passes through a box. */
function crosses(o: [number, number, number], n: [number, number, number], box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const d = (x - o[0]) * n[0] + (y - o[1]) * n[1] + (z - o[2]) * n[2];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
  return lo <= 0 && hi >= 0;
}
