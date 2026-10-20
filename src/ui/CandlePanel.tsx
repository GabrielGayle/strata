import { useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { addCandle, candleList, candlesCsv, candleShopping, CHOKE_NAMES, DEFAULT_CANDLES, FIN_JOIN_NAMES, type FinJoin, SIT_NAMES, SNAP_NAMES, type Choke, type Sit, type Snap, HOLDER_NAMES, parseCandles, PATH_NAMES, PRESETS, writeCandles, type CandlePath, type CandleRow, type CandleSize, type CandleSpec, type Holder } from '../core/candles';
import type { Model } from '../core/pipeline';
import type { RawValue } from '../core/params';
import { baseTop } from '../core/slicer';
import { download } from '../core/exporters';

type NumKey = 'size' | 'bend' | 'lift' | 'crown' | 'ramp' | 'grip' | 'cup' | 'fins' | 'reach' | 'spin' | 'engage' | 'pad' | 'cols' | 'gapX' | 'gapZ' | 'every' | 'slack' | 'shoulder' | 'x' | 'z' | 'turn';

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
const holderOf = (s: CandleSpec, c: ReturnType<typeof candleList>[number]) => (c.tealight ? c.holder ?? 'socket' : c.holder ?? s.holder);
const hasTarget = (s: CandleSpec) => candleList(s).some((c) => holderOf(s, c) !== 'socket');

// set while the panel renders: whether "auto" means sitting into a map
let mapDesign = false;
const sitsIn = (s: CandleSpec) => s.sit === 'surface' || (s.sit === 'auto' && mapDesign);
// sitting into the plates, target fins slot onto them like slotted fins (see candleObjects)
const slotsIn = (s: CandleSpec, c: ReturnType<typeof candleList>[number]) => holderOf(s, c) === 'slotted' || (sitsIn(s) && holderOf(s, c) === 'target');
const hasSlotted = (s: CandleSpec) => candleList(s).some((c) => slotsIn(s, c));

const FIELDS: Field[] = [
  { key: 'cols', label: 'Columns', step: 1, hint: 'Grid: how many candles in each row (across the plates). The rows fill up from the front as you add candles.', show: (s) => s.path === 'grid' },
  { key: 'gapX', label: 'Across', step: 5, hint: 'Grid: spacing between columns (mm).', show: (s) => s.path === 'grid' && s.snap === 'off' },
  { key: 'every', label: 'Every', step: 1, hint: 'Grid lined up with the plates: a column every this many plates, so the spacing follows the plate pitch exactly.', show: (s) => s.path === 'grid' && s.snap !== 'off' },
  { key: 'gapZ', label: 'Back', step: 5, hint: 'Grid: spacing between rows, front to back (mm).', show: (s) => s.path === 'grid' },
  { key: 'size', label: (s) => (s.path === 'circle' ? 'Across' : s.path === 'line' || s.path === 'wave' ? 'Length' : 'Width'), step: 10, hint: 'How big the path is (mm): its length for a line or wave, the diameter for a circle, the width for the other shapes.', show: (s) => s.path !== 'custom' && s.path !== 'grid' && s.path !== 'free' },
  { key: 'bend', label: (s) => BEND_LABEL[s.path] ?? 'Bend', step: 1, hint: (s) => BEND_HINT[s.path] ?? '', show: (s) => s.path in BEND_LABEL },
  { key: 'lift', show: (s) => !sitsIn(s), label: 'Lift', step: 5, hint: 'Height of the candle bottoms above the concrete (mm). The plates step up to meet them.' },
  { key: 'crown', show: (s) => !sitsIn(s), label: 'Crown', step: 5, hint: 'Extra height for the middle candles (mm), rising in a curve like a candelabra. Negative dips the middle. Rings and shapes have no middle, so it does nothing there.' },
  { key: 'ramp', show: (s) => !sitsIn(s), label: 'Climb', step: 5, hint: 'How much higher the last candle stands than the first (mm).' },
  { key: 'grip', label: 'Grip', step: 1, hint: 'How far up each candlestick its holder reaches (mm). 25 to 35 holds a dinner candle steady.', show: hasStick },
  { key: 'cup', label: 'Cup', step: 1, hint: 'How deep each tealight sits in its cup (mm). About half its height shows off the metal rim and keeps it safe.' },
  { key: 'fins', label: 'Fins', step: 1, hint: 'Fin holders: how many fins stand round each candlestick. 4 makes the crosshair target; 3 a tripod; 6 or 8 a star.', show: (s) => hasTarget(s) && s.finJoin !== 'cross' },
  { key: 'reach', label: 'Reach', step: 1, hint: 'Fin holders: how far each fin reaches out from the candle (mm). For target fins the plates are cleared a little wider than this.', show: hasTarget },
  { key: 'spin', label: 'Spin', step: 5, hint: 'Fin holders: turn the fins round the candle (degrees). 45 sets a 4-fin cross across the plates, which slotted fins need so every fin crosses them.', show: hasTarget },
  { key: 'engage', label: 'Slot', step: 1, hint: 'Slotted fins: how deep each fin and plate overlap where they slot together (mm). The plate is slotted from its top down half this, the fin from its bottom up the other half, so the fin drops on and locks square.', show: hasSlotted },
  { key: 'pad', label: 'Pad', step: 1, hint: 'Choked plates: how far the plates reach past each candle (and its fins) before they stop (mm).', show: (s) => s.choke !== 'off' },
  { key: 'slack', label: 'Slack', step: 0.1, hint: 'Gap left round each candle (mm), so it drops in. Candles vary, so 0.5 to 1 mm is safe.' },
  { key: 'shoulder', label: 'Shoulder', step: 1, hint: 'Plate kept either side of each cup or holder as it steps up (mm).' },
  { key: 'x', label: 'X', step: 10, hint: 'Slide the candelabra left or right (mm).' },
  { key: 'z', label: 'Z', step: 10, hint: 'Slide the candelabra forward or back (mm).' },
  { key: 'turn', label: 'Turn', step: 5, hint: 'Turn the whole candelabra to face another way (degrees).' },
];

const DEFAULT_HINT =
  'Click any candle in the 3D view and drag it to place it freely. Typed, it is one candle per line: a name like "5 taper", "tealight", "maxi", or diameter × height in mm like "24 x 300 stick". Add "cup", "slotted" or "target" to a line to pick its holder. Hover any value to see what it does.';

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
  mapDesign = useStore((s) => !!s.project.images.top?.map);

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
  const buy = candleShopping(s);
  const help = (h: string) => ({
    onMouseEnter: () => setHint(h),
    onMouseLeave: () => setHint(null),
    title: h,
  });

  const fit = () => {
    const patch = fitCandles(model, s);
    if (patch) setParams(patch, 'Fit plates to the candelabra');
  };

  // candles that stand between plates in a socket have nothing holding them
  const gripping = (b: (typeof model.objects)[number]) => model.sliced.plates.filter((p) => p.parts.length && crosses(p.def.plane.origin, p.def.plane.normal, b.geometry.boundingBox!)).length;
  const cups = model.objects.filter((b) => b.object.seat !== undefined && b.object.id.startsWith('candle'));
  const loose = cups.filter((b) => !gripping(b)).length;
  const wobbly = cups.filter((b) => b.object.look === 'candle' && gripping(b) === 1).length;
  const sticks = list.filter((c) => !c.tealight).length;
  const summary = `${list.length} candle${list.length === 1 ? '' : 's'}: ${sticks} candlestick${sticks === 1 ? '' : 's'}, ${list.length - sticks} tealight${list.length - sticks === 1 ? '' : 's'}.${loose ? ` ${loose} stand${loose === 1 ? 's' : ''} between plates with nothing holding ${loose === 1 ? 'it' : 'them'}: give ${loose === 1 ? 'it' : 'them'} fins or nudge the path.` : ''}${sitsIn(s) && list.some((c) => holderOf(s, c) === 'target') ? ' Sitting into the plates, target fins slot onto them instead of standing in the concrete, so the plates stay whole round each candle.' : ''}${wobbly ? ` ${wobbly} candlestick${wobbly === 1 ? ' is' : 's are'} gripped by only one plate and may wobble: closer plates, a deeper Grip or fins will steady ${wobbly === 1 ? 'it' : 'them'}.` : ''}${bad.length ? ` Couldn't read: ${bad.join(', ')}.` : ''}`;

  return (
    <>
      <CandlePicker s={s} edit={edit} help={help} setHint={setHint} />
      <div className="mp-row ap-edit ob-edit shelf-edit">
        <label className="ob-num" {...help('Off keeps the list but takes the candles and their holders away.')}>
          <input type="checkbox" checked={s.on} onChange={(e) => edit({ on: e.target.checked })} /> <span>Candles</span>
        </label>
        <div className="shelf-side">
          <select aria-label="Path" value={s.path} onChange={(e) => edit({ path: e.target.value as CandlePath })} {...help('The line the candles follow. They are spread evenly along it; round shapes share the gap back to the start too.')}>
            {(Object.keys(PATH_NAMES) as CandlePath[]).map((k) => (
              <option key={k} value={k}>
                {PATH_NAMES[k]}
              </option>
            ))}
          </select>
          <select aria-label="Holder" value={s.holder} onChange={(e) => edit({ holder: e.target.value as Holder })} {...help('How candlesticks are held. Target fins: fins stand round each one like crosshairs, set in the concrete, and the plates step up to meet them (candles sitting into the plates, as on a map, get them slotted onto the plates instead). Slotted fins: the same fins, but slotted onto the plates so the plates line them up. Cup: no fins; the plates it stands in are cut to grip it, like a tealight. Add "cup", "slotted" or "target" to a line to pick it for just that line.')}>
            {(Object.keys(HOLDER_NAMES) as Holder[]).map((k) => (
              <option key={k} value={k}>
                {HOLDER_NAMES[k]}
              </option>
            ))}
          </select>
          {hasTarget(s) && (
            <select aria-label="Fin pieces" data-hl="fin-pieces" value={s.finJoin} onChange={(e) => edit({ finJoin: e.target.value as FinJoin })} {...help('How the fins are cut. Separate fins: one part per fin, as many as Fins says. Two-piece cross: two fins each run right across under the candle and slot together through a halving slot in the middle, one from the top and one from the bottom, so four arms come from two parts. Fewer parts to cut and weld, and the cross squares itself.')}>
              {(Object.keys(FIN_JOIN_NAMES) as FinJoin[]).map((k) => (
                <option key={k} value={k}>
                  {FIN_JOIN_NAMES[k]}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Snap" data-hl="candle-snap" value={s.snap} onChange={(e) => edit({ snap: e.target.value as Snap })} {...help('Line the candles up with the plates. Onto plates: each candle slides along the stack to stand centred on the nearest plate. Between plates: centred in the gap between two. A grid then spaces its columns by whole plates (see Every).')}>
            {(Object.keys(SNAP_NAMES) as Snap[]).map((k) => (
              <option key={k} value={k}>
                {SNAP_NAMES[k]}
              </option>
            ))}
          </select>
          <select aria-label="Height" value={s.sit} onChange={(e) => edit({ sit: e.target.value as Sit })} {...help('Where the candles stand. Lift: at a set height above the concrete, with the plates stepping up to meet them. Sit into the plates: each candle sinks its Cup or Grip depth below the lowest plate top under it, so the plates keep their own shape (a map, a relief) and are just cut to hold it. Auto sits them into a map and lifts them otherwise.')}>
            {(Object.keys(SIT_NAMES) as Sit[]).map((k) => (
              <option key={k} value={k}>
                {SIT_NAMES[k]}
              </option>
            ))}
          </select>
          <select aria-label="Choke" value={s.choke} onChange={(e) => edit({ choke: e.target.value as Choke })} {...help('Stop the plates round the candles instead of running the full length of the base. Round each candle: every plate keeps just the length round the candles it crosses, plus Pad. Along the path: the plates follow the line of candles as one band, Pad wider than the candles each side. Plates that miss the candles are left out.')}>
            {(Object.keys(CHOKE_NAMES) as Choke[]).map((k) => (
              <option key={k} value={k}>
                {CHOKE_NAMES[k]}
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
      {s.path === 'free' && (
        <div className="mp-row ap-edit">
          <span className="ap-label">Click a candle in the 3D view and drag its arrows to move it. Every candle keeps its own spot.</span>
          <button className="btn sm" onClick={() => edit({ path: 'grid', spots: [] })} {...help('Lay the candles out in a grid again (their dragged spots are forgotten).')}>
            Back to a grid
          </button>
        </div>
      )}
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
                  if (Number.isFinite(x)) edit({ [f.key]: f.key === 'fins' ? Math.max(2, Math.min(8, Math.round(x))) : f.key === 'cols' || f.key === 'every' ? Math.max(1, Math.round(x)) : x }, `candles:${f.key}`);
                }}
              />
            </label>
          );
        })}
      </div>
      <div className="mp-info">{hint ?? (s.on ? `${summary}${s.path === "grid" || s.path === "free" ? "" : ` ${fmt(s.size / 10, 0)} cm path.`}` : 'The candelabra is off.')}</div>
      {buy.length > 0 && (
        <div className="mp-row candle-buy" data-testid="candle-buy">
          <span className="ap-label">
            To buy: {buy.map((b) => `${b.qty} × ${b.name} (Ø${fmt(b.d, 0)} × ${fmt(b.h, 0)} mm)`).join(', ')}
          </span>
          <button className="btn sm" onClick={() => download(`${(useStore.getState().project.name || 'strata').replace(/[^\w-]+/g, '-')}-candles.csv`, candlesCsv(buy), 'text/csv')} title="How many candles of each size to buy, what holds them and the hole each drops into">
            Candle list
          </button>
        </div>
      )}
    </>
  );
}

type Help = (h: string) => { onMouseEnter: () => void; onMouseLeave: () => void; title: string };

const HOLDER_OPTIONS: [Holder | '', string][] = [
  ['', 'Holder: as set below'],
  ['target', 'Target fins'],
  ['slotted', 'Slotted fins'],
  ['socket', 'Cup in the plates'],
];

const sizeText = (c: { d: number; h: number }) => `Ø${fmt(c.d, 0)} × ${fmt(c.h, 0)} mm`;

/** A candle drawn to scale in a small box: a tealight in its foil cup, or a candlestick with its wick and flame. */
export function CandleIcon({ d, h, tealight, box = 40 }: { d: number; h: number; tealight: boolean; box?: number }) {
  // fit the tallest candle (and the widest tealight) to the box, so sizes compare at a glance
  const k = Math.min((box - 12) / Math.max(h, 60), (box - 4) / Math.max(d, 70));
  const w = Math.max(3, d * k);
  const hh = Math.max(3, h * k);
  const x = (box - w) / 2;
  const y = box - 1 - hh;
  const fy = y - 1;
  return (
    <svg className="candle-icon" width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
      {tealight ? (
        <>
          <rect x={x} y={y} width={w} height={hh} fill="#f6efd9" stroke="#555" strokeWidth="1" />
          <rect x={x} y={y + hh * 0.35} width={w} height={hh * 0.65} fill="#b9bec4" stroke="#555" strokeWidth="1" />
        </>
      ) : (
        <rect x={x} y={y} width={w} height={hh} fill="#f6efd9" stroke="#555" strokeWidth="1" />
      )}
      <line x1={box / 2} y1={y} x2={box / 2} y2={fy - 1} stroke="#333" strokeWidth="1" />
      <path d={`M${box / 2} ${fy - 8} q3 4 0 7 q-3 -3 0 -7z`} fill="#f0a020" stroke="#b05a00" strokeWidth="0.75" />
    </svg>
  );
}

/** Pick candles from the catalogue, then set how many of each and in what order. The typed list is still there for power users. */
function CandlePicker({ s, edit, help, setHint }: { s: CandleSpec; edit: (patch: Partial<CandleSpec>, key?: string) => void; help: Help; setHint: (h: string | null) => void }) {
  const [typed, setTyped] = useState(false);
  const [own, setOwn] = useState({ d: 24, h: 300, tealight: false });
  const { lines: rows, bad } = parseCandles(s.candles);
  const write = (next: CandleRow[]) => edit({ candles: writeCandles(next, bad) });
  const add = (size: CandleSize) => edit({ candles: addCandle(s.candles, size) });
  const change = (i: number, row: CandleRow | null) => write(rows.flatMap((r, j) => (j === i ? (row ? [row] : []) : [r])));
  const swap = (i: number, j: number) => {
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };
  const total = rows.reduce((a, r) => a + r.count, 0);

  return (
    <>
      <div className="mp-row candle-pick" role="group" aria-label="Add a candle">
        <span className="cp-head">Add a candle</span>
        <div className="cp-cards">
          {Object.entries(PRESETS).map(([key, p]) => (
            <button
              key={key}
              className="cp-card"
              data-testid={`candle-add-${key}`}
              onClick={() => add({ d: p.d, h: p.h, tealight: p.tealight, name: p.label, preset: key })}
              {...help(`Add a ${p.label.toLowerCase()}: about ${p.d} mm across and ${p.h} mm tall. Sizes vary by maker, so add your own size below if yours differ.`)}
            >
              <CandleIcon d={p.d} h={p.h} tealight={p.tealight} box={34} />
              <span className="cp-name">{p.label.replace(/ \(taper\)$/, '')}</span>
              <span className="cp-size">{sizeText(p)}</span>
              <span className="cp-add">+ Add</span>
            </button>
          ))}
          <div className="cp-card cp-own" {...help('A candle of your own size: measure across and the height in mm. Tealight sits in a cup; candlestick is held by fins or a socket.')}>
            <CandleIcon d={own.d} h={own.h} tealight={own.tealight} box={34} />
            <span className="cp-name">Your own</span>
            <span className="cp-dims">
              <input type="number" min={5} max={400} step={1} aria-label="Your own candle: across (mm)" value={own.d} onChange={(e) => setOwn({ ...own, d: Number(e.target.value) || own.d })} />
              ×
              <input type="number" min={5} max={1000} step={1} aria-label="Your own candle: height (mm)" value={own.h} onChange={(e) => setOwn({ ...own, h: Number(e.target.value) || own.h })} />
            </span>
            <select aria-label="Your own candle: kind" value={own.tealight ? 'tea' : 'stick'} onChange={(e) => setOwn({ ...own, tealight: e.target.value === 'tea' })}>
              <option value="stick">Candlestick</option>
              <option value="tea">Tealight</option>
            </select>
            <button className="btn sm" data-testid="candle-add-own" onClick={() => add({ d: Math.min(400, Math.max(5, own.d)), h: Math.min(1000, Math.max(5, own.h)), tealight: own.tealight, name: '' })}>
              + Add
            </button>
          </div>
        </div>
      </div>
      <div className="mp-row candle-list" role="group" aria-label="Candles on the candelabra">
        <span className="cp-head">
          On the candelabra <small>{total ? `${total} candle${total === 1 ? '' : 's'}, laid along the path in this order${s.alternate ? ' (Mix spreads them through each other)' : ''}` : ''}</small>
        </span>
        {!rows.length && <p className="cp-empty">No candles yet. Add one above.</p>}
        {rows.length > 0 && (
          <ol className="cp-rows sunken-panel" data-testid="candle-rows">
            {rows.map((r, i) => {
              const name = r.size.preset ? PRESETS[r.size.preset].label : r.size.word || `${r.size.tealight ? 'Tealight' : 'Candlestick'}`;
              return (
                <li key={i} className="cp-row" data-testid="candle-row">
                  <CandleIcon d={r.size.d} h={r.size.h} tealight={r.size.tealight} box={28} />
                  <span className="cp-row-name">
                    {name}
                    <small>{sizeText(r.size)}</small>
                  </span>
                  <span className="cp-count">
                    <button className="btn sm" aria-label={`One fewer ${name}`} onClick={() => change(i, r.count > 1 ? { ...r, count: r.count - 1 } : null)} title={r.count > 1 ? 'One fewer' : 'Take this candle out'}>
                      −
                    </button>
                    <output aria-label={`How many ${name}`}>{r.count}</output>
                    <button className="btn sm" aria-label={`One more ${name}`} disabled={r.count >= 60} onClick={() => change(i, { ...r, count: r.count + 1 })} title="One more">
                      +
                    </button>
                  </span>
                  <select
                    aria-label={`Holder for ${name}`}
                    value={r.size.holder ?? ''}
                    onChange={(e) => change(i, { ...r, size: { ...r.size, holder: (e.target.value || undefined) as Holder | undefined } })}
                    {...help(r.size.tealight ? 'Tealights sit in a cup cut in the plates. Pick fins to stand this one in a ring of fins instead.' : 'How these candlesticks are held. "As set below" follows the Holder choice for the whole candelabra.')}
                  >
                    {HOLDER_OPTIONS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {v === '' && r.size.tealight ? 'Holder: cup' : label}
                      </option>
                    ))}
                  </select>
                  <span className="cp-move">
                    <button className="btn sm" aria-label={`Move ${name} earlier`} disabled={i === 0} onClick={() => swap(i, i - 1)} title="Earlier along the path">
                      ▲
                    </button>
                    <button className="btn sm" aria-label={`Move ${name} later`} disabled={i === rows.length - 1} onClick={() => swap(i, i + 1)} title="Later along the path">
                      ▼
                    </button>
                    <button className="btn sm" aria-label={`Remove ${name}`} onClick={() => change(i, null)} title="Take these candles out">
                      ✕
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {bad.length > 0 && <p className="cp-bad">Couldn't read: {bad.join(', ')}. Fix it in the typed list.</p>}
        <button className={`btn sm ${typed ? 'on' : ''}`} aria-expanded={typed} onClick={() => setTyped(!typed)} {...help('Type the list instead, one candle per line, e.g. "5 taper", "4 tealight", "24 x 300 stick target". The picker and the typed list are the same list.')}>
          {typed ? 'Hide typed list' : 'Type the list…'}
        </button>
        {typed && (
          <textarea aria-label="Candles, typed" rows={4} value={s.candles} onChange={(e) => edit({ candles: e.target.value }, 'candles:list')} onMouseEnter={() => setHint(DEFAULT_HINT)} onMouseLeave={() => setHint(null)} placeholder={'5 taper\n4 tealight\n58 x 24 maxi'} />
        )}
      </div>
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
