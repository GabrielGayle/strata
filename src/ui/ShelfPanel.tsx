import { useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { DEFAULT_SHELF, LAYOUT_NAMES, parseCards, type ShelfLayout, type ShelfSpec } from '../core/shelf';
import { defaultAppearance, rainbowBuckets } from '../core/appearance';
import { baseTop } from '../core/slicer';

type NumKey = 'radius' | 'gap' | 'rows' | 'rowStep' | 'rowRise' | 'seat' | 'lean' | 'lift' | 'shoulder' | 'thick' | 'clearance' | 'x' | 'z' | 'turn';

interface Field {
  key: NumKey;
  label: string;
  step: number;
  hint: string;
  show?: (s: ShelfSpec) => boolean;
}

const FIELDS: Field[] = [
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

const DEFAULT_HINT =
  'Type one postcard per line as width × height in mm, with an optional name. The cards are laid edge to edge along the arc, each standing in a notch, and the plate tops step down so every card shows. Hover any value to see what it does.';

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
  const v = model.v;

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

  const shelfBuilds = model.objects.filter((o) => o.object.seat !== undefined);
  const fit = () => {
    if (!shelfBuilds.length) return;
    const top = baseTop(v);
    let need = 0;
    let ext = 0;
    let depth = 0;
    for (const b of shelfBuilds) {
      const bb = b.geometry.boundingBox!;
      need = Math.max(need, bb.min.y - top + s.seat + 2);
      ext = Math.max(ext, Math.abs(bb.min.x), Math.abs(bb.max.x));
      depth = Math.max(depth, Math.abs(bb.min.z), Math.abs(bb.max.z));
    }
    setParams(
      {
        strataOn: false,
        insShape: 'none',
        stackHeight: String(Math.ceil(need)),
        baseLength: String(Math.max(Math.ceil(2 * ext + 60), Number(v.baseLength))),
        baseWidth: String(Math.max(Math.ceil(2 * depth + 60), Number(v.baseWidth))),
      },
      'Fit plates to the postcard shelf',
    );
  };
  const rainbow = () => {
    const keys = model.sliced.plates.filter((p) => p.parts.length && p.def.family === 'P').map((p) => p.def.key);
    setAppearance(rainbowBuckets(appearance ?? defaultAppearance(), keys, bands), 'fill:rainbow');
  };

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
          <label key={f.key} className="ob-num" {...help(f.hint)}>
            <span>{f.label}</span>
            <input
              type="number"
              step={f.step}
              aria-label={f.hint}
              value={+s[f.key].toFixed(2)}
              onChange={(e) => {
                const x = parseFloat(e.target.value);
                if (Number.isFinite(x))
                  edit(
                    {
                      [f.key]: f.key === 'rows' ? Math.max(1, Math.round(x)) : x,
                    },
                    `shelf:${f.key}`,
                  );
              }}
            />
          </label>
        ))}
      </div>
      <div className="mp-info">
        {hint ??
          (s.on
            ? `${cards.length} card${cards.length === 1 ? '' : 's'}, ${fmt(cards.reduce((a, c) => a + c.w, 0) / 10, 1)} cm of card along the arc.${bad.length ? ` Couldn't read: ${bad.join(', ')}.` : ''} ${DEFAULT_HINT}`
            : 'The shelf is off.')}
      </div>
    </>
  );
}
