import { useState } from 'react';
import { useStore } from '../state/store';
import { useModel } from './model';
import { newShelf, shelfThickness, type ShelfPlate } from '../core/shelfPlates';
import { DEFAULT_CANDLES, PRESETS } from '../core/candles';
import { placedSize, SURFACE_NAMES, type PlacedCandle } from '../core/surfaceCandles';

type NumKey = 'x' | 'y' | 'z' | 'len' | 'depth' | 'thick' | 'round' | 'fit';

interface Field {
  key: NumKey;
  label: string;
  step: number;
  min?: number;
  hint: string;
}

const FIELDS: Field[] = [
  { key: 'x', label: 'X', step: 1, hint: 'Left and right from the centre of the base (mm). Or drag the arrows in the 3D view.' },
  { key: 'y', label: 'Height', step: 1, hint: 'Height of the shelf top above the floor (mm). Drag the up arrow in the 3D view to raise or lower it.' },
  { key: 'z', label: 'Z', step: 1, hint: 'Forward and back from the centre of the base (mm).' },
  { key: 'len', label: 'Length', step: 5, min: 10, hint: 'How far the shelf runs across the plates (mm). Every plate it crosses gets a slot for it.' },
  { key: 'depth', label: 'Depth', step: 5, min: 10, hint: 'How far the shelf reaches along the plates (mm). Keep some plate beside it, or the plate is cut in two.' },
  { key: 'thick', label: 'Thick', step: 0.5, min: 0, hint: 'Shelf thickness (mm). 0 cuts it from the same sheet as the plates.' },
  { key: 'round', label: 'Corners', step: 1, min: 0, hint: 'Radius of the shelf corners (mm).' },
  { key: 'fit', label: 'Gap', step: 0.1, min: 0, hint: 'Gap round the shelf in every plate slot (mm), so it slides through. 0.2 to 0.4 for laser-cut steel.' },
];

const DEFAULT_HINT = 'A shelf is a flat plate that slides through slots in the plates it crosses, then is welded. Press Add shelf and click the plates where you want it, then drag its arrows. Candles go on it from the Candelabra tab.';

/** Shelves through the plates: add one by clicking in the 3D view, then size and place it. */
export default function ShelvesPanel() {
  const model = useModel();
  const shelves = useStore((s) => s.project.shelves) ?? [];
  const placed = useStore((s) => s.project.placedCandles) ?? [];
  const setShelves = useStore((s) => s.setShelves);
  const setPlaced = useStore((s) => s.setPlacedCandles);
  const sel = useStore((s) => s.ui.objectSel);
  const placing = useStore((s) => s.ui.placing);
  const setUi = useStore((s) => s.setUi);
  const [hint, setHint] = useState<string | null>(null);
  const cur = shelves.find((s) => s.id === sel) ?? null;
  const flat = model.v.sliceMode === 'flat';

  const edit = (patch: Partial<ShelfPlate>, key?: string) => cur && setShelves(shelves.map((s) => (s.id === cur.id ? { ...s, ...patch } : s)), key);
  const remove = () => {
    if (!cur) return;
    const i = shelves.indexOf(cur);
    const rest = shelves.filter((s) => s !== cur);
    setShelves(rest);
    // candles standing on it go with it
    if (placed.some((c) => c.shelf === cur.id)) setPlaced(placed.filter((c) => c.shelf !== cur.id));
    setUi({ objectSel: rest[Math.min(i, rest.length - 1)]?.id ?? null });
  };
  const duplicate = () => {
    if (!cur) return;
    const copy = { ...newShelf(shelves, cur), x: cur.x, y: cur.y + 60, z: cur.z, len: cur.len, depth: cur.depth, thick: cur.thick, round: cur.round, fit: cur.fit };
    setShelves([...shelves, copy]);
    setUi({ objectSel: copy.id });
  };
  const help = (h: string) => ({ onMouseEnter: () => setHint(h), onMouseLeave: () => setHint(null), title: h });

  const num = (f: Field) => (
    <label key={f.key} className="ob-num" {...help(f.hint)}>
      <span>{f.label}</span>
      <input
        type="number"
        step={f.step}
        aria-label={f.hint}
        value={cur ? +cur[f.key].toFixed(2) : ''}
        onChange={(e) => {
          const x = parseFloat(e.target.value);
          if (!Number.isFinite(x)) return;
          edit({ [f.key]: Math.max(f.min ?? -Infinity, x) }, `shelf:${cur!.id}:${f.key}`);
        }}
      />
    </label>
  );

  const crossed = (s: ShelfPlate) => model.sliced.plates.filter((p) => p.parts.length && Math.abs(p.def.plane.normal[1]) < 0.5 && crosses(p.def.plane, s, model)).length;
  const onIt = cur ? placed.filter((c) => c.shelf === cur.id).length : 0;
  const placingShelf = placing?.kind === 'shelf';
  return (
    <>
      <div className="mp-row">
        {shelves.map((s) => (
          <button key={s.id} className={`btn sm bucket ${s.id === sel ? 'on' : ''} ${s.on ? '' : 'off'}`} data-testid={`shelf-pick-${s.id}`} onClick={() => setUi({ objectSel: s.id })} title={`${s.len} × ${s.depth} mm at ${s.y} mm. Click to edit (or click it in the 3D view).`}>
            {s.name}
          </button>
        ))}
        <button className={`btn sm ${placingShelf ? 'on' : ''}`} data-testid="shelf-add" disabled={flat} onClick={() => setUi({ placing: placingShelf ? null : { kind: 'shelf' } })} {...help(flat ? 'Shelves slide through upright plates: a flat stack has none.' : 'Then click the plates in the 3D view where the shelf should go (Esc cancels).')}>
          {placingShelf ? 'Click the plates…' : '+ Add shelf'}
        </button>
      </div>
      {cur && (
        <div className="mp-row ap-edit ob-edit">
          <input aria-label="Shelf name" value={cur.name} onChange={(e) => edit({ name: e.target.value }, `shelf:${cur.id}:name`)} />
          <label className="ob-num" {...help('Off keeps it in the list without cutting it or slotting the plates.')}>
            <input type="checkbox" checked={cur.on} onChange={(e) => edit({ on: e.target.checked })} /> <span>On</span>
          </label>
          <span className="ob-group">Place {FIELDS.slice(0, 3).map(num)}</span>
          <span className="ob-group">Size {FIELDS.slice(3, 6).map(num)}</span>
          {FIELDS.slice(6).map(num)}
          <button className="btn sm" onClick={duplicate} title="Copy it, 60 mm higher">
            Duplicate
          </button>
          <button className="btn sm" onClick={remove} title={onIt ? `Take it out, with the ${onIt} candle${onIt > 1 ? 's' : ''} on it` : 'Take it out; the plate slots close up again'}>
            Remove
          </button>
        </div>
      )}
      <div className="mp-info" data-testid="shelf-info">
        {hint ??
          (placingShelf
            ? 'Click a plate in the 3D view: the shelf top goes at the height you click. Esc cancels.'
            : cur
              ? `${cur.name}: ${cur.len} × ${cur.depth} × ${shelfThickness(cur, model.v)} mm, through ${crossed(cur)} plate${crossed(cur) === 1 ? '' : 's'}${onIt ? `, ${onIt} candle${onIt > 1 ? 's' : ''} on it` : ''}. Drag its arrows in the 3D view to move it.`
              : DEFAULT_HINT)}
      </div>
    </>
  );
}

/** Whether an upright plate's plane runs through a shelf in plan. */
function crosses(plane: { origin: [number, number, number]; normal: [number, number, number] }, s: ShelfPlate, model: ReturnType<typeof useModel>): boolean {
  const c = model.shelfCuts?.find((x) => x.id === s.id);
  if (!c) return false;
  const n = plane.normal;
  const d = (x: number, z: number) => (x - plane.origin[0]) * n[0] + (z - plane.origin[2]) * n[2];
  const ds = [d(c.x - c.sx / 2, c.z - c.sz / 2), d(c.x + c.sx / 2, c.z - c.sz / 2), d(c.x - c.sx / 2, c.z + c.sz / 2), d(c.x + c.sx / 2, c.z + c.sz / 2)];
  return Math.min(...ds) <= 0 && Math.max(...ds) >= 0;
}

const SIZES = ['taper', 'thin', 'pillar', 'votive', 'mini', 'tealight', 'maxi', 'jumbo'];

/** Add candle to surface: pick a size, then click a shelf, the plate tops or the concrete. */
export function SurfaceCandles() {
  const placed = useStore((s) => s.project.placedCandles) ?? [];
  const spec = useStore((s) => s.project.candles);
  const setPlaced = useStore((s) => s.setPlacedCandles);
  const placing = useStore((s) => s.ui.placing);
  const sel = useStore((s) => s.ui.objectSel);
  const setUi = useStore((s) => s.setUi);
  const model = useModel();
  const [size, setSize] = useState('taper');
  const cur = placed.find((c) => c.id === sel) ?? null;
  const active = placing?.kind === 'candle';
  const lost = new Set(model.lostCandles ?? []);
  const s = { ...DEFAULT_CANDLES, ...(spec ?? {}) };
  const label = (c: PlacedCandle) => placedSize(c).name;
  const edit = (patch: Partial<PlacedCandle>) => cur && setPlaced(placed.map((c) => (c.id === cur.id ? { ...c, ...patch } : c)));
  const remove = () => {
    if (!cur) return;
    setPlaced(placed.filter((c) => c !== cur));
    setUi({ objectSel: null });
  };
  return (
    <div className="ap-edit surface-candles" data-testid="surface-candles">
      <div className="mp-row">
        <select aria-label="Candle to add" value={size} onChange={(e) => setSize(e.target.value)} title="The candle to place">
          {SIZES.map((k) => (
            <option key={k} value={k}>
              {PRESETS[k].label} ({PRESETS[k].d} × {PRESETS[k].h})
            </option>
          ))}
        </select>
        <button className={`btn sm ${active ? 'on' : ''}`} data-testid="candle-place" onClick={() => setUi({ placing: active ? null : { kind: 'candle', size } })} title="Then click a shelf, a plate top or the concrete in the 3D view. The fins are worked out for that spot.">
          {active ? 'Click a surface…' : 'Place'}
        </button>
      </div>
      {placed.length > 0 && (
        <div className="mp-row">
          {placed.map((c) => (
            <button key={c.id} className={`btn sm bucket ${c.id === sel ? 'on' : ''} ${lost.has(c.id) ? 'off' : ''}`} data-testid={`placed-${c.id}`} onClick={() => setUi({ objectSel: c.id })} title={`${label(c)} ${SURFACE_NAMES[c.on]}${lost.has(c.id) ? ': nothing under it to stand on, so it is left out' : ''}`}>
              {label(c)}
            </button>
          ))}
        </div>
      )}
      {cur && (
        <div className="mp-row">
          <select aria-label="Placed candle size" value={SIZES.includes(cur.size) ? cur.size : ''} onChange={(e) => edit({ size: e.target.value })}>
            {!SIZES.includes(cur.size) && <option value="">{label(cur)}</option>}
            {SIZES.map((k) => (
              <option key={k} value={k}>
                {PRESETS[k].label}
              </option>
            ))}
          </select>
          <span className="ap-label">
            {SURFACE_NAMES[cur.on]}
            {cur.on === 'shelf' ? `, ${s.fins} fins with tabs through the shelf` : cur.on === 'plates' ? `, ${s.fins} fins slotted onto the plates` : `, ${s.fins} target fins set in the concrete`}
          </span>
          <button className="btn sm" onClick={remove} title="Take this candle out">
            Remove
          </button>
        </div>
      )}
      <div className="mp-info">
        {active
          ? 'Click where the candle should stand: a shelf, the top of the plates, or the concrete. Esc cancels.'
          : spec ? 'Placed candles use the candelabra\'s fin settings below (Fins, Reach, Grip, Spin, Slack). Drag one in the 3D view to move it along its surface.' : 'Placed candles get 4 fins reaching 18 mm. Start a candelabra below to change the fin settings. Drag one in the 3D view to move it along its surface.'}
      </div>
    </div>
  );
}
