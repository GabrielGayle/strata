import { useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import ShelfPanel from './ShelfPanel';
import CandlePanel from './CandlePanel';
import ShelvesPanel, { SurfaceCandles } from './ShelvesPanel';
import { Fold } from './Fold';
import type { ObjectsView } from './sidebarState';
import { isWall } from '../core/mount';
import { CARD_SIZES, KIND_NAMES, newObject, type CutObject, type ObjectKind } from '../core/objects';

type NumKey = 'w' | 'h' | 'd' | 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'clearance';

interface Field {
  key: NumKey;
  label: string;
  step: number;
  /** What the value does, shown in the line under the panel while the pointer is on it. */
  hint: string;
}

const SIZE: Field[] = [
  { key: 'w', label: 'W', step: 1, hint: 'Width across (mm). For a postcard, its long side if it stands landscape.' },
  { key: 'h', label: 'H', step: 1, hint: 'Height (mm). The part below the plate tops is what gets notched out.' },
  { key: 'd', label: 'D', step: 0.1, hint: 'Depth (mm). For a postcard, its thickness: about 0.3 to 0.5 mm.' },
];
/** On a wall the numbers are still spots on the piece, but its height runs out from the wall. */
const WALL_PLACE: Field[] = [
  { key: 'x', label: 'X', step: 1, hint: 'Along the base, across the face of the piece as it hangs (mm from the middle).' },
  { key: 'y', label: 'Out', step: 1, hint: 'How far out from the wall the object\'s centre is (mm). The base front is at the base thickness.' },
  { key: 'z', label: 'Z', step: 1, hint: 'Across the base, the other way over the face of the piece as it hangs (mm from the middle).' },
];
const WALL_TURN: Field[] = [
  { key: 'rx', label: '↻X', step: 1, hint: 'Tip forward or back (degrees), as it stands on the wall.' },
  { key: 'ry', label: '↻Y', step: 1, hint: 'Turn about the real vertical (degrees): it stays upright on the wall.' },
  { key: 'rz', label: '↻Z', step: 1, hint: 'Roll sideways (degrees), as it stands on the wall.' },
];
const PLACE: Field[] = [
  { key: 'x', label: 'X', step: 1, hint: 'Left and right from the centre of the base (mm).' },
  { key: 'y', label: 'Y', step: 1, hint: 'Height of the object\'s centre above the floor (mm). Lower it to sink it deeper into the plates.' },
  { key: 'z', label: 'Z', step: 1, hint: 'Forward and back from the centre of the base (mm).' },
];
const TURN: Field[] = [
  { key: 'rx', label: '↻X', step: 1, hint: 'Tip forward or back (degrees). Around 10° leans a postcard back so it rests in its slot.' },
  { key: 'ry', label: '↻Y', step: 1, hint: 'Turn on the spot (degrees), like turning a page to face another way.' },
  { key: 'rz', label: '↻Z', step: 1, hint: 'Roll sideways (degrees).' },
];
const GAP: Field = { key: 'clearance', label: 'Gap', step: 0.1, hint: 'Space left around the object in every plate (mm), so it slides in. Half a millimetre suits a postcard.' };

const DEFAULT_HINT = 'Objects are cut out of every plate they pass through, so the plates end up shaped to hold them. Hover any value to see what it does.';

/** Placed objects, the postcard shelf or the candelabra: one sidebar tab each in the 3D view. */
export default function ObjectsPanel({ view }: { view: ObjectsView }) {
  return (
    <div className="objects" role="group" aria-label={view === 'candles' ? 'Candelabra' : view === 'shelf' ? 'Postcard shelf' : view === 'shelves' ? 'Shelves' : 'Objects'}>
      {view !== 'shelves' && <ShowRow view={view} />}
      {view === 'shelves' ? (
        <Fold id="shelves:main" title="Shelves">
          <ShelvesPanel />
        </Fold>
      ) : (
        <>
          {view === 'candles' && (
            <Fold id="candles:surface" title="Add candle to surface">
              <SurfaceCandles />
            </Fold>
          )}
          <Fold id={`${view}:main`} title={view === 'candles' ? 'Candelabra' : view === 'shelf' ? 'Postcard shelf' : 'Placed objects'}>
            {view === 'shelf' ? <ShelfPanel /> : view === 'candles' ? <CandlePanel /> : <ObjectList />}
          </Fold>
        </>
      )}
    </div>
  );
}

/** A candle placed on a surface: pc1, pc2… (its well is pc1well). */
export const isPlacedCandle = (id: string) => /^pc\d+$/.test(id);

/** Which objects each tab owns, by id: placed ones are o1, o2…, cards shelf1…, candles candle1… and pc1… */
export function tabOwns(view: ObjectsView, o: CutObject): boolean {
  if (o.look === 'hidden') return false; // a candle holder's well, a shelf's plate slots: never drawn
  if (view === 'shelves') return false; // shelves are plates, not objects
  if (view === 'shelf') return o.id.startsWith('shelf');
  if (view === 'candles') return o.id.startsWith('candle') || isPlacedCandle(o.id);
  return !o.id.startsWith('shelf') && !o.id.startsWith('candle') && !o.id.startsWith('well') && !o.id.startsWith('pc');
}

/** Show or hide objects in the 3D view: all at once, or one by one. View only. */
function ShowRow({ view }: { view: ObjectsView }) {
  const model = useModel();
  const allOn = useStore((s) => s.ui.viewportLayers.objects !== false);
  const hidden = useStore((s) => s.ui.hiddenObjects);
  const toggleLayer = useStore((s) => s.toggleViewportLayer);
  const setUi = useStore((s) => s.setUi);
  const mine = model.objects.map((b) => b.object).filter((o) => tabOwns(view, o));
  if (!model.objects.length) return null;
  const flip = (id: string) => setUi({ hiddenObjects: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] });
  const ids = mine.map((o) => o.id);
  const someHidden = ids.some((id) => hidden.includes(id));
  return (
    <Fold id={`${view}:show`} title="Show in 3D">
      <div className="mp-row ob-show" data-testid="objects-show">
        <span title="Hiding only changes the 3D view: the object still cuts the plates and goes in exports.">Show</span>
        <button className={`btn sm ${allOn ? 'on' : ''}`} data-testid="objects-show-all" onClick={() => toggleLayer('objects')} title="Show or hide every object, card and candle in the 3D view (they still cut the plates)">
          All objects
        </button>
        {mine.map((o, i) => {
          const on = !hidden.includes(o.id);
          // candles and cards often share a name, so number them in path order
          const label = mine.some((x) => x !== o && x.name === o.name) ? `${i + 1} ${o.name}` : o.name;
          return (
            <button key={o.id} className={`btn sm ${on && allOn ? 'on' : ''}`} data-testid={`object-show-${o.id}`} disabled={!allOn} aria-pressed={on} onClick={() => flip(o.id)} title={`${on ? 'Hide' : 'Show'} ${o.name} in the 3D view (it still cuts the plates)`}>
              {on ? '●' : '○'} {label}
            </button>
          );
        })}
        {someHidden && (
          <button className="btn sm" onClick={() => setUi({ hiddenObjects: hidden.filter((x) => !ids.includes(x)) })} title="Show every one in this tab again">
            Show all
          </button>
        )}
      </div>
    </Fold>
  );
}

const DRAWN_HINT = 'Off draws nothing in the 3D view, renders or AR, but it still cuts the plates: use it for a box that only opens a pocket or a slot.';

/** Placed objects: add postcards, boxes and so on, and set where each sits. */
function ObjectList() {
  const model = useModel();
  const objects = useStore((s) => s.project.objects) ?? [];
  const setObjects = useStore((s) => s.setObjects);
  const sel = useStore((s) => s.ui.objectSel);
  const setUi = useStore((s) => s.setUi);
  const [hint, setHint] = useState<string | null>(null);
  const cur = objects.find((o) => o.id === sel) ?? null;

  // a new object sinks 25 mm into the tallest plate so it starts out held
  const top = model.sliced.parts.reduce((m, p) => Math.max(m, p.plane.origin[1] + p.bbox.maxY), 0);
  const add = (kind: ObjectKind) => {
    const o = newObject(kind, objects, { y: Math.max(0, top - 25) });
    setObjects([...objects, o]);
    setUi({ objectSel: o.id });
  };
  const edit = (patch: Partial<CutObject>, key?: string) => cur && setObjects(objects.map((o) => (o.id === cur.id ? { ...o, ...patch } : o)), key);
  const remove = () => {
    if (!cur) return;
    const i = objects.indexOf(cur);
    const rest = objects.filter((o) => o !== cur);
    setObjects(rest);
    setUi({ objectSel: rest[Math.min(i, rest.length - 1)]?.id ?? null });
  };
  const duplicate = () => {
    if (!cur) return;
    const copy = { ...cur, id: newObject(cur.kind, objects, { y: 0 }).id, name: `${cur.name} copy`, x: cur.x + cur.w + 10 };
    setObjects([...objects, copy]);
    setUi({ objectSel: copy.id });
  };

  const num = (f: Field) => (
    <label key={f.key} className="ob-num" onMouseEnter={() => setHint(f.hint)} onMouseLeave={() => setHint(null)} title={f.hint}>
      <span>{f.label}</span>
      <input
        type="number"
        step={f.step}
        aria-label={f.hint}
        value={cur ? +cur[f.key].toFixed(2) : ''}
        onChange={(e) => {
          const x = parseFloat(e.target.value);
          if (!Number.isFinite(x)) return;
          const min = f.key === 'w' || f.key === 'h' || f.key === 'd' ? 0.1 : f.key === 'clearance' ? 0 : -Infinity;
          edit({ [f.key]: Math.max(min, x) }, `obj:${cur!.id}:${f.key}`);
        }}
      />
    </label>
  );

  // plates each object passes through, so it is clear what it is doing
  const cuts = (o: CutObject) => {
    const b = model.objects.find((x) => x.object === o);
    if (!b) return 0;
    const box = b.geometry.boundingBox!;
    return model.sliced.plates.filter((p) => p.parts.length && intersectsPlate(p.def.plane.origin, p.def.plane.normal, box)).length;
  };

  const n = cur ? cuts(cur) : 0;
  return (
    <>
      <div className="mp-row">
        {objects.map((o) => (
          <button key={o.id} className={`btn sm bucket ${o.id === sel ? 'on' : ''} ${o.on ? '' : 'off'}`} onClick={() => setUi({ objectSel: o.id })} title={`${KIND_NAMES[o.kind]}, ${fmt(o.w, 0)} × ${fmt(o.h, 0)} mm. Click to edit (or click it in the 3D view).`}>
            {o.name}
          </button>
        ))}
        {(Object.keys(KIND_NAMES) as ObjectKind[]).map((k) => (
          <button key={k} className="btn sm" onClick={() => add(k)} onMouseEnter={() => setHint(k === 'card' ? 'Add a postcard (A6, 148 × 105 mm). Set its real size, then lower it into the plates until it is held.' : `Add a ${KIND_NAMES[k].toLowerCase()} to cut out of the plates.`)} onMouseLeave={() => setHint(null)}>
            + {KIND_NAMES[k]}
          </button>
        ))}
      </div>
      {cur && (
        <div className="mp-row ap-edit ob-edit">
          <input aria-label="Object name" value={cur.name} onChange={(e) => edit({ name: e.target.value }, `obj:${cur.id}:name`)} />
          <label className="ob-num" title="Off keeps it in the list without cutting the plates" onMouseEnter={() => setHint('Off keeps it in the list without cutting the plates.')} onMouseLeave={() => setHint(null)}>
            <input type="checkbox" checked={cur.on} onChange={(e) => edit({ on: e.target.checked })} /> <span>Cuts</span>
          </label>
          <label className="ob-num" data-hl="object-drawn" title={DRAWN_HINT} onMouseEnter={() => setHint(DRAWN_HINT)} onMouseLeave={() => setHint(null)}>
            <input type="checkbox" checked={cur.look !== 'hidden'} onChange={(e) => edit(e.target.checked ? { look: undefined } : { look: 'hidden' })} /> <span>Drawn</span>
          </label>
          {cur.kind === 'card' && (
            <select
              data-hl="object-card-size"
              aria-label="Card size"
              title="Set a standard card size. It keeps the card standing the way it is (portrait or landscape)."
              value=""
              onChange={(e) => {
                const c = CARD_SIZES.find((x) => x.name === e.target.value);
                if (!c) return;
                const landscape = cur.w > cur.h;
                edit(landscape ? { w: c.h, h: c.w } : { w: c.w, h: c.h });
              }}
            >
              <option value="">Card size…</option>
              {CARD_SIZES.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}, {c.w} × {c.h} mm
                </option>
              ))}
            </select>
          )}
          <span className="ob-group">Size {SIZE.map(num)}</span>
          <span className="ob-group">Place {(isWall(model.v) ? WALL_PLACE : PLACE).map(num)}</span>
          <span className="ob-group">Turn {(isWall(model.v) ? WALL_TURN : TURN).map(num)}</span>
          {num(GAP)}
          <button className="btn sm" onClick={duplicate} title="Copy it, placed just to the right">
            Duplicate
          </button>
          <button className="btn sm" onClick={remove} title="Take it out; the plates close up again">
            Remove
          </button>
        </div>
      )}
      <div className="mp-info">
        {hint ?? (cur ? `${cur.name} ${cur.on ? `passes through ${n} plate${n === 1 ? '' : 's'}` : 'is off'}. ${DEFAULT_HINT}` : objects.length ? 'Pick an object to edit it, or click one in the 3D view.' : DEFAULT_HINT)}
      </div>
    </>
  );
}

/** Whether a plate's plane passes through an object's bounding box. */
function intersectsPlate(o: [number, number, number], n: [number, number, number], box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): boolean {
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
