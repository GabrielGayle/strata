import { useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { DEFAULT_SHELF, LAYOUT_NAMES, parseCards, SHELF_SOLVE_KEYS, clearShelfOverride, commitShelfLock, type ShelfLayout, type ShelfSolveKey, type ShelfSpec } from '../core/shelf';
import { formatSolverDelta } from '../core/shelfSolve';
import {
  DEFAULT_FLEX_MM,
  DEFAULT_MAX_HIDDEN_PCT,
  DEFAULT_MAX_OVERLAP_MM,
  formatCameraNote,
  viewSettings,
  withViewDefaults,
} from '../core/shelfView';
import { getLiveView } from './liveView';
import { defaultAppearance, rainbowBuckets, type Appearance } from '../core/appearance';
import type { Model } from '../core/pipeline';
import type { RawValue } from '../core/params';
import { baseTop } from '../core/slicer';

export type NumKey = 'radius' | 'gap' | 'rows' | 'rowStep' | 'rowRise' | 'seat' | 'lean' | 'lift' | 'shoulder' | 'thick' | 'clearance' | 'x' | 'z' | 'turn';

export interface Field {
  key: NumKey;
  label: string;
  step: number;
  hint: string;
  show?: (s: ShelfSpec) => boolean;
}

export const FIELDS: Field[] = [
  {
    key: 'radius',
    label: 'Radius',
    step: 10,
    hint: 'How tightly the arc curves (mm). Bigger is gentler and wider. For the arch it is how tall the rainbow stands.',
  },
  {
    key: 'gap',
    label: 'Gap',
    step: 1,
    hint: 'Space between neighbouring cards along the arc (mm).',
  },
  {
    key: 'rows',
    label: 'Rows',
    step: 1,
    hint: 'How many rows the cards are shared between. Each row stands further back.',
    show: (s) => s.layout === 'bands',
  },
  {
    key: 'rowStep',
    label: 'Row step',
    step: 5,
    hint: 'How far back each row stands from the one in front (mm). For the spiral, how much the curve widens.',
    show: (s) => s.layout === 'bands' || s.layout === 'spiral',
  },
  {
    key: 'rowRise',
    label: 'Row rise',
    step: 5,
    hint: 'How much higher each row behind stands (mm), so the back cards show over the front ones. For the spiral, the total climb.',
    show: (s) => s.layout === 'bands' || s.layout === 'spiral',
  },
  {
    key: 'lift',
    label: 'Lift',
    step: 5,
    hint: 'Height of the plate tops under the lowest cards, above the concrete (mm).',
  },
  {
    key: 'seat',
    label: 'Seat',
    step: 1,
    hint: 'How deep each card sits in its notch (mm). About 15 to 25 mm holds a postcard upright.',
  },
  {
    key: 'lean',
    label: 'Lean',
    step: 1,
    hint: 'Tip the cards back from upright (degrees), so they rest against their notches and are easier to read.',
  },
  {
    key: 'shoulder',
    label: 'Shoulder',
    step: 1,
    hint: 'Plate kept either side of each notch, rising to the card (mm). The rest of the plate steps down.',
  },
  {
    key: 'thick',
    label: 'Card',
    step: 0.05,
    hint: 'Postcard thickness (mm). Most are 0.3 to 0.5 mm.',
  },
  {
    key: 'clearance',
    label: 'Slack',
    step: 0.1,
    hint: 'Gap left either side of each card in its notch (mm), so it drops in and lifts out easily.',
  },
  {
    key: 'x',
    label: 'X',
    step: 10,
    hint: 'Slide the whole shelf left or right (mm).',
  },
  {
    key: 'z',
    label: 'Z',
    step: 10,
    hint: 'Slide the whole shelf forward or back (mm).',
  },
  {
    key: 'turn',
    label: 'Turn',
    step: 5,
    hint: 'Turn the whole shelf to face another way (degrees).',
  },
];

export const DEFAULT_HINT =
  'Type one postcard per line as width × height in mm, with an optional name. The cards are laid edge to edge along the arc, each standing in a notch, and the plate tops step down so every card shows. Hover any value to see what it does.';

function parseShelfField(field: Field, raw: string): number | null {
  const x = parseFloat(raw);
  if (!Number.isFinite(x)) return null;
  return field.key === 'rows' ? Math.max(1, Math.round(x)) : x;
}

/** Placement number: live value as you type; lock only on blur / Enter vs the value at focus. */
export function ShelfFieldControl({
  spec,
  field,
  className = 'ob-num',
  help,
}: {
  spec: ShelfSpec;
  field: Field;
  className?: string;
  help?: { onMouseEnter: () => void; onMouseLeave: () => void; title: string };
}) {
  const setShelf = useStore((st) => st.setShelf);
  const model = useModel();
  const from = useRef(Number(spec[field.key]));
  const solveKey = (SHELF_SOLVE_KEYS as string[]).includes(field.key) ? (field.key as ShelfSolveKey) : null;
  const locked = !!(solveKey && spec.overrides?.[solveKey]);
  const used = solveKey && model.shelfSolve?.spec ? Number(model.shelfSolve.spec[solveKey]) : undefined;
  const stored = Number(spec[field.key]);
  const delta = solveKey && used !== undefined && used !== stored ? formatSolverDelta(solveKey, stored, used) : null;
  const commitValue = (value: number) => {
    if (value === spec[field.key]) return spec;
    const next = { ...spec, [field.key]: value };
    setShelf(next, `shelf:${field.key}`);
    return next;
  };
  const commit = (raw: string) => {
    const value = parseShelfField(field, raw);
    if (value == null) return;
    if (!solveKey) {
      commitValue(value);
      return;
    }
    const withVal = spec[field.key] === value ? spec : { ...spec, [field.key]: value };
    const next = commitShelfLock(withVal, solveKey, from.current);
    if (next !== spec) setShelf(next, `shelf:${field.key}`);
  };
  return (
    <label className={className} data-locked={locked ? '1' : undefined} {...help}>
      <span>{field.label}</span>
      <input
        type="number"
        step={field.step}
        aria-label={field.hint}
        value={+spec[field.key].toFixed(2)}
        onFocus={() => {
          from.current = Number(spec[field.key]);
        }}
        onChange={(e) => {
          const value = parseShelfField(field, e.target.value);
          if (value == null) return;
          commitValue(value);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {delta && (
        <span className="shelf-solver evald" data-testid={`shelf-solver-${field.key}`}>
          {delta}
        </span>
      )}
      {locked && solveKey && (
        <button
          type="button"
          className="btn sm"
          aria-label={`Reset ${field.label} to auto`}
          title="Reset to auto: the unobstructed solver may adjust this number again"
          onClick={() => setShelf(clearShelfOverride(spec, [solveKey]), `shelf:${field.key}:auto`)}
        >
          auto
        </button>
      )}
    </label>
  );
}

/** Settings that make the plates flat-topped and tall enough for every shelf card, on a base big enough to hold them (null with no cards). */
export function fitShelf(model: Model, s: ShelfSpec): Record<string, RawValue> | null {
  const cards = model.objects.filter((o) => o.object.seat !== undefined);
  if (!cards.length) return null;
  const v = model.v;
  const top = baseTop(v);
  let need = 0;
  let ext = 0;
  let depth = 0;
  for (const b of cards) {
    const bb = b.geometry.boundingBox!;
    need = Math.max(need, bb.min.y - top + s.seat + 2);
    ext = Math.max(ext, Math.abs(bb.min.x), Math.abs(bb.max.x));
    depth = Math.max(depth, Math.abs(bb.min.z), Math.abs(bb.max.z));
  }
  return {
    strataOn: false,
    insShape: 'none',
    stackHeight: String(Math.ceil(need)),
    baseLength: String(Math.max(Math.ceil(2 * ext + 60), Number(v.baseLength))),
    baseWidth: String(Math.max(Math.ceil(2 * depth + 60), Number(v.baseWidth))),
  };
}

/** Rainbow anodised buckets over the main plates, in order along the stack. */
export function rainbowPlates(model: Model, appearance: Appearance | undefined, n: number): Appearance {
  const keys = model.sliced.plates.filter((p) => p.parts.length && p.def.family === 'P').map((p) => p.def.key);
  return rainbowBuckets(appearance ?? defaultAppearance(), keys, n);
}

/** Postcard shelf: the cards, the arc they follow, and how the plates hold them. */
export default function ShelfPanel() {
  const model = useModel();
  const stored = useStore((s) => s.project.shelf);
  const appearance = useStore((s) => s.project.appearance);
  const setShelf = useStore((s) => s.setShelf);
  const setParams = useStore((s) => s.setParams);
  const setAppearance = useStore((s) => s.setAppearance);
  const [hint, setHint] = useState<string | null>(null);
  const [bands, setBands] = useState(7);

  if (!stored)
    return (
      <div className="mp-row ap-edit">
        <button className="btn sm" onClick={() => setShelf({ ...DEFAULT_SHELF })} title="Start a postcard shelf with seven example cards; replace them with your own sizes">
          + Postcard shelf
        </button>
        <span className="ap-label">Lay a list of postcards along an arc, each held in a notch.</span>
      </div>
    );

  const s = stored;
  const edit = (patch: Partial<ShelfSpec>, key?: string) => setShelf({ ...s, ...patch }, key);
  const { cards, bad } = parseCards(s.cards);
  const help = (h: string) => ({
    onMouseEnter: () => setHint(h),
    onMouseLeave: () => setHint(null),
    title: h,
  });

  const fit = () => {
    const patch = fitShelf(model, s);
    if (patch) setParams(patch, 'Fit plates to the postcard shelf');
  };
  const rainbow = () => setAppearance(rainbowPlates(model, appearance, bands), 'fill:rainbow');

  return (
    <>
      <div className="mp-row ap-edit ob-edit shelf-edit">
        <label className="ob-num" {...help('Off keeps the list but takes the cards and their notches away.')}>
          <input type="checkbox" checked={s.on} onChange={(e) => edit({ on: e.target.checked })} /> <span>Shelf</span>
        </label>
        <textarea
          aria-label="Postcard sizes"
          rows={4}
          value={s.cards}
          onChange={(e) => edit({ cards: e.target.value }, 'shelf:cards')}
          onMouseEnter={() => setHint(DEFAULT_HINT)}
          onMouseLeave={() => setHint(null)}
          placeholder={'148 x 105 Venice\n150 x 100 Lisbon'}
        />
        <div className="shelf-side">
          <select
            aria-label="Layout"
            value={s.layout}
            onChange={(e) => edit({ layout: e.target.value as ShelfLayout })}
            {...help('Fan: one curved row. Bands: rows stepping up behind each other. Arch: a rainbow standing up. Spiral: a curve that widens and climbs.')}
          >
            {(Object.keys(LAYOUT_NAMES) as ShelfLayout[]).map((k) => (
              <option key={k} value={k}>
                {LAYOUT_NAMES[k]}
              </option>
            ))}
          </select>
          <label className="ob-num" {...help('Step the plate tops down to the cards. Off leaves the plates as they are, with just the notches cut.')}>
            <input type="checkbox" checked={s.trim} onChange={(e) => edit({ trim: e.target.checked })} /> <span>Step plates</span>
          </label>
          <button className="btn sm" onClick={fit} {...help('Make the plates flat-topped and tall enough to reach every card, the base big enough to stand them on, and take the insert out of the way. Undo puts it all back.')}>
            Fit plates
          </button>
          <span className="ap-nth">
            <button className="btn sm" onClick={rainbow} {...help('Anodised aluminium in rainbow bands, red to violet, along the plates. Fine-tune them under Materials.')}>
              Rainbow
            </button>
            <input type="number" aria-label="Rainbow colours" min={2} max={24} value={bands} onChange={(e) => setBands(Math.max(2, Math.min(24, Math.round(+e.target.value) || 7)))} />
          </span>
          <button className="btn sm" onClick={() => setShelf(undefined)} title="Take the shelf away (undo brings it back)">
            Remove
          </button>
        </div>
      </div>
      <div className="mp-row ap-edit ob-edit">
        {FIELDS.filter((f) => !f.show || f.show(s)).map((f) => (
          <ShelfFieldControl key={f.key} spec={s} field={f} help={help(f.hint)} />
        ))}
      </div>
      <UnobstructedToggle spec={s} edit={edit} setHint={setHint} />
      <div className="mp-info">
        {hint ??
          (s.on
            ? `${cards.length} card${cards.length === 1 ? '' : 's'}, ${fmt(cards.reduce((a, c) => a + c.w, 0) / 10, 1)} cm of card along the arc.${bad.length ? ` Couldn't read: ${bad.join(', ')}.` : ''} ${DEFAULT_HINT}`
            : 'The shelf is off.')}
      </div>
    </>
  );
}

function UnobstructedToggle({ spec, edit, setHint }: { spec: ShelfSpec; edit: (patch: Partial<ShelfSpec>, key?: string) => void; setHint: (h: string | null) => void }) {
  const open = useStore((st) => st.ui.shelfViewDevOpen);
  const setUi = useStore((st) => st.setUi);
  const live = getLiveView();
  const help = (h: string) => ({
    onMouseEnter: () => setHint(h),
    onMouseLeave: () => setHint(null),
    title: h,
  });
  return (
    <div className="shelf-dev" data-testid="shelf-unobstructed">
      <label
        className="ob-num"
        {...help('When on, the layout solver opens the gap, eases the lean and the other arc numbers just enough that every postcard face is fully visible from the viewing angle. Numbers you typed stay put.')}
      >
        <input
          type="checkbox"
          aria-label="Unobstructed view"
          checked={!!spec.unobstructed}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on) {
              edit({ unobstructed: false }, 'shelf:unobstructed');
              return;
            }
            const liveNow = getLiveView();
            edit({ ...withViewDefaults(spec, liveNow), unobstructed: true }, 'shelf:unobstructed');
          }}
        />
        <span>Unobstructed view</span>
      </label>
      {spec.unobstructed && (
        <span className="shelf-cam-note" data-testid="shelf-camera-note">
          {formatCameraNote(spec, live)}
        </span>
      )}
      <button
        className="btn sm"
        aria-expanded={open}
        aria-controls="shelf-unobstructed-body"
        onClick={() => setUi({ shelfViewDevOpen: !open })}
        {...help('Developer controls: a viewing angle and how much of a card face may be hidden before it counts. Opens at the bottom-left of the 3D view.')}
      >
        {open ? 'Hide' : 'Show'} Unobstructed view (dev)
      </button>
    </div>
  );
}

/** Azimuth / overlap / tint — docked off the centre of the 3D view. */
export function UnobstructedDevDock() {
  const spec = useStore((st) => st.project.shelf);
  const open = useStore((st) => st.ui.shelfViewDevOpen);
  const objectsMode = useStore((st) => st.ui.objectsMode);
  const setShelf = useStore((st) => st.setShelf);
  const vis = useModel().cardVisibility;
  const live = getLiveView();
  if (!spec || !open || !objectsMode) return null;
  const view = viewSettings(spec);
  const az = spec.viewAzimuth ?? live.azimuth;
  const el = spec.viewElevation ?? live.elevation;
  const overlap = spec.maxOverlapMm ?? DEFAULT_MAX_OVERLAP_MM;
  const hiddenPct = spec.maxHiddenPct ?? DEFAULT_MAX_HIDDEN_PCT;
  const flex = spec.flexMm ?? DEFAULT_FLEX_MM;
  const hidden = vis?.hiddenCount ?? 0;
  const edit = (patch: Partial<ShelfSpec>, key?: string) => setShelf({ ...spec, ...patch }, key);
  const num = (label: string, aria: string, hint: string, value: number, step: number, patch: (x: number) => Partial<ShelfSpec>) => (
    <label className="ob-num" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        aria-label={aria}
        value={+value.toFixed(2)}
        onChange={(e) => {
          const x = parseFloat(e.target.value);
          if (Number.isFinite(x)) edit(withViewDefaults({ ...spec, ...patch(x) }, live), 'shelf:view');
        }}
      />
    </label>
  );
  return (
    <div className="overlay movepanel objects shelf-view-dock" data-testid="shelf-unobstructed-dev" id="shelf-unobstructed-body">
      <div className="mp-row ap-edit ob-edit">
        {num('Azimuth', 'Viewing azimuth', 'Horizontal viewing angle in degrees. 0 looks from +Z, the usual front of the shelf.', az, 1, (x) => ({ viewAzimuth: x }))}
        {num('Elevation', 'Viewing elevation', 'Vertical viewing angle in degrees. 0 is looking horizontally, 90 from above.', el, 1, (x) => ({ viewElevation: x }))}
        <button
          className="btn sm"
          onClick={() => {
            const now = getLiveView();
            edit({ ...withViewDefaults(spec, now), viewAzimuth: now.azimuth, viewElevation: now.elevation }, 'shelf:view');
          }}
          title="Copy the 3D camera’s current azimuth and elevation into these fields."
        >
          Use current camera
        </button>
      </div>
      <div className="mp-row ap-edit ob-edit">
        {num('Overlap', 'Maximum corner overlap', 'How much a neighbouring card may cover a corner, in millimetres, before it counts as hidden.', overlap, 0.1, (x) => ({ maxOverlapMm: Math.max(0, x) }))}
        <span className="ap-label">mm</span>
        {num('Hidden', 'Maximum hidden face', 'How much of a card’s face may be covered, as a percent of its area.', hiddenPct, 0.1, (x) => ({ maxHiddenPct: Math.max(0, x) }))}
        <span className="ap-label">%</span>
        {num('Flex', 'Allowed flex', 'Extra millimetres for card stock that can bend, so a corner may touch or catch a neighbour.', flex, 0.1, (x) => ({ flexMm: Math.max(0, x) }))}
        <span className="ap-label">mm</span>
      </div>
      <label className="ob-num" title="While this section is open, paint the hidden part of each card so you can see what the angle covers.">
        <input
          type="checkbox"
          aria-label="Tint hidden regions"
          checked={!!spec.tintHidden}
          onChange={(e) => edit({ ...withViewDefaults(spec, getLiveView()), tintHidden: e.target.checked }, 'shelf:view')}
        />
        <span>Tint hidden regions</span>
      </label>
      <div className="shelf-dev-readout" data-testid="shelf-unobstructed-readout">
        {spec.on
          ? hidden
            ? `${hidden} card${hidden === 1 ? '' : 's'} hidden from this angle (${view.unobstructed ? 'warning' : 'info'} in Fit checks).`
            : vis?.cards.length
              ? 'Every postcard face is visible from this angle.'
              : 'No cards on the shelf yet.'
          : 'The shelf is off.'}
      </div>
    </div>
  );
}
