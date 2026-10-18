import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { DEFAULT_SHELF, LAYOUT_NAMES, parseCards, type ShelfLayout, type ShelfSpec } from '../core/shelf';
import { DEFAULT_ORIGIN, ORIGIN_NAMES, type OriginRef, type WorldOrigin } from '../core/origin';
import { FIELDS, fitShelf, rainbowPlates, ShelfFieldControl, type NumKey } from './ShelfPanel';

/**
 * The postcard shelf as a chain of nodes, read left to right, in the spirit of
 * Blender's geometry nodes: each node takes what flows in on its left, changes
 * it, and hands it on along a wire. Hovering a node lights up what it makes in
 * the 3D view and says what it does; the tour walks through them in order.
 */

type NodeId = 'origin' | 'cards' | 'objects' | 'arrange' | 'seat' | 'plates' | 'colours' | 'cut';

interface NodeInfo {
  id: NodeId;
  title: string;
  /** What lights up in the 3D view while this node is pointed at. */
  hl: string;
  teach: string;
}

const NODES: NodeInfo[] = [
  {
    id: 'origin',
    title: 'World origin',
    hl: 'origin',
    teach:
      'Every position is measured from here. Pick a spot on the base, nudge it and turn it, and everything wired out of this node moves with it. In Blender this is like the object origin, or a Transform node at the start of a tree.',
  },
  {
    id: 'cards',
    title: 'Postcards',
    hl: 'cards',
    teach: 'Your cards, one per line as width × height in mm. This is the data that flows into the tree: change a line and every node to the right rebuilds.',
  },
  {
    id: 'objects',
    title: 'Objects',
    hl: 'objects',
    teach: 'Anything else you place by hand: a box, a rod, a ball, a single postcard. Like the cards, each one is cut out of the plates it passes through.',
  },
  {
    id: 'arrange',
    title: 'Arrange on a curve',
    hl: 'cards',
    teach:
      'Lays the cards edge to edge along a curve, like Blender\'s Instance on Points following a curve. The layout picks the curve: a fan, rows rising behind each other, an arch standing up, or a climbing spiral.',
  },
  {
    id: 'seat',
    title: 'Seat and notch',
    hl: 'notches',
    teach:
      'The boolean step. Each card is cut out of every plate it crosses (a Difference, in Blender\'s Mesh Boolean), leaving a notch to stand in, and the plate tops step down to just above each card so none is hidden.',
  },
  {
    id: 'plates',
    title: 'Plates',
    hl: 'plates',
    teach: 'The waffle of steel the cards stand in, set on the concrete. Fit makes them flat-topped and tall enough to reach every card, on a base big enough to hold them.',
  },
  {
    id: 'colours',
    title: 'Colours',
    hl: 'colours',
    teach: 'Anodised aluminium in rainbow bands, red to violet along the plates. Each colour is a material bucket, so you can fine-tune any of them under Materials in the 3D view.',
  },
  {
    id: 'cut',
    title: 'Cut list',
    hl: 'plates',
    teach: 'The end of the tree, like Group Output: the flat parts that go to the laser cutter, nested on sheets, with a price estimate.',
  },
];

const WIRES: [NodeId, NodeId][] = [
  ['origin', 'arrange'],
  ['origin', 'objects'],
  ['cards', 'arrange'],
  ['arrange', 'seat'],
  ['objects', 'seat'],
  ['seat', 'plates'],
  ['plates', 'colours'],
  ['colours', 'cut'],
];

const COLUMNS: NodeId[][] = [['origin', 'cards'], ['objects', 'arrange'], ['seat'], ['plates'], ['colours', 'cut']];

const INTRO =
  'Read left to right. Each box is a node: it takes what flows in on its left, changes it, and hands it on along a wire. Change a value in any node and everything to its right rebuilds. Hover a node to light up what it makes in the 3D view (open Workspace › Nodes + 3D to see both).';

const ORIGIN_FIELDS: { key: 'x' | 'y' | 'z' | 'turn'; label: string; hint: string }[] = [
  { key: 'x', label: 'X', hint: 'Slide the origin left or right (mm). Everything measured from it slides too.' },
  { key: 'y', label: 'Y', hint: 'Raise or lower the origin (mm). Placed objects go with it; shelf cards keep sitting on the concrete.' },
  { key: 'z', label: 'Z', hint: 'Slide the origin forward or back (mm).' },
  { key: 'turn', label: 'Turn', hint: 'Turn the origin (degrees). The shelf and objects turn around it.' },
];

export default function NodesView() {
  const model = useModel();
  const shelf = useStore((s) => s.project.shelf);
  const origin = useStore((s) => s.project.origin) ?? DEFAULT_ORIGIN;
  const objects = useStore((s) => s.project.objects) ?? [];
  const appearance = useStore((s) => s.project.appearance);
  const setShelf = useStore((s) => s.setShelf);
  const setOrigin = useStore((s) => s.setOrigin);
  const setParams = useStore((s) => s.setParams);
  const setParam = useStore((s) => s.setParam);
  const setAppearance = useStore((s) => s.setAppearance);
  const setUi = useStore((s) => s.setUi);
  const [hover, setHover] = useState<NodeId | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const [bands, setBands] = useState(7);
  const focus: NodeId | null = tour !== null ? NODES[tour].id : hover;
  const info = NODES.find((n) => n.id === focus) ?? null;

  // light up what the pointed-at node makes, in the 3D view
  useEffect(() => {
    setUi({ highlight: info?.hl ?? null });
  }, [info, setUi]);
  useEffect(() => () => setUi({ highlight: null }), [setUi]);
  // the tour brings each node into view as it gets to it
  useEffect(() => {
    if (tour !== null) refs.current.get(NODES[tour].id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [tour]);

  // wires are drawn between the measured nodes
  const area = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<NodeId, HTMLDivElement>());
  const [ports, setPorts] = useState<Record<string, { l: [number, number]; r: [number, number] }>>({});
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const out: Record<string, { l: [number, number]; r: [number, number] }> = {};
      for (const [id, n] of refs.current) {
        const b = n.getBoundingClientRect();
        const y = b.top - box.top + el.scrollTop + 16;
        out[id] = { l: [b.left - box.left + el.scrollLeft, y], r: [b.right - box.left + el.scrollLeft, y] };
      }
      setPorts((p) => (JSON.stringify(p) === JSON.stringify(out) ? p : out));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const n of refs.current.values()) ro.observe(n);
    return () => ro.disconnect();
  }, [shelf === undefined]);

  const s: ShelfSpec | undefined = shelf;
  const editShelf = (patch: Partial<ShelfSpec>, key?: string) => s && setShelf({ ...s, ...patch }, key);
  const editOrigin = (patch: Partial<WorldOrigin>, key?: string) => setOrigin({ ...origin, ...patch }, key);
  const help = (h: string) => ({ onMouseEnter: () => setHint(h), onMouseLeave: () => setHint(null), title: h });
  const shelfNum = (key: NumKey) => {
    const f = FIELDS.find((x) => x.key === key)!;
    if (!s || (f.show && !f.show(s))) return null;
    return <ShelfFieldControl key={key} spec={s} field={f} className="nd-field" help={help(f.hint)} />;
  };
  const paramNum = (id: string, label: string, hint: string, step = 1) => (
    <label className="nd-field" {...help(hint)}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        aria-label={hint}
        value={+Number(model.v[id]).toFixed(2)}
        onChange={(e) => {
          const x = parseFloat(e.target.value);
          if (Number.isFinite(x)) setParam(id, String(x));
        }}
      />
    </label>
  );
  const needShelf = (
    <button className="btn sm" onClick={() => setShelf({ ...DEFAULT_SHELF })} {...help('Start a postcard shelf with seven example cards; replace them with your own sizes.')}>
      + Postcard shelf
    </button>
  );

  const parsed = s ? parseCards(s.cards) : null;
  const plates = model.sliced.plates.filter((p) => p.parts.length);
  const heights = model.sliced.parts.map((p) => p.bbox.maxY);
  const rainbowCount = (appearance?.buckets ?? []).filter((b) => b.id.startsWith('rb')).length;

  const body: Record<NodeId, ReactNode> = {
    origin: (
      <>
        <select aria-label="Origin" value={origin.ref} onChange={(e) => editOrigin({ ref: e.target.value as OriginRef })} {...help('The spot on the base the origin starts from.')}>
          {(Object.keys(ORIGIN_NAMES) as OriginRef[]).map((k) => (
            <option key={k} value={k}>
              {ORIGIN_NAMES[k]}
            </option>
          ))}
        </select>
        <div className="nd-grid">
          {ORIGIN_FIELDS.map((f) => (
            <label key={f.key} className="nd-field" {...help(f.hint)}>
              <span>{f.label}</span>
              <input
                type="number"
                step={f.key === 'turn' ? 5 : 10}
                aria-label={f.hint}
                value={origin[f.key]}
                onChange={(e) => {
                  const x = parseFloat(e.target.value);
                  if (Number.isFinite(x)) editOrigin({ [f.key]: x }, `origin:${f.key}`);
                }}
              />
            </label>
          ))}
        </div>
      </>
    ),
    cards: s ? (
      <>
        <textarea aria-label="Postcard sizes" rows={6} value={s.cards} onChange={(e) => editShelf({ cards: e.target.value }, 'shelf:cards')} {...help('One card per line: width × height in mm, then an optional name, like "148 x 105 Venice".')} />
        <div className="nd-out">
          {parsed!.cards.length} cards{parsed!.bad.length ? `, couldn't read ${parsed!.bad.length}` : ''}
        </div>
      </>
    ) : (
      needShelf
    ),
    objects: (
      <>
        <div className="nd-out">{objects.length ? objects.map((o) => o.name).join(', ') : 'None placed yet'}</div>
        <button className="btn sm" onClick={() => setUi({ tab: '3d', objectsMode: true })} {...help('Add and place objects in the 3D view.')}>
          Place in 3D
        </button>
      </>
    ),
    arrange: s ? (
      <>
        <select aria-label="Layout" value={s.layout} onChange={(e) => editShelf({ layout: e.target.value as ShelfLayout })} {...help('Fan: one curved row. Bands: rows stepping up behind each other. Arch: a rainbow standing up. Spiral: a curve that widens and climbs.')}>
          {(Object.keys(LAYOUT_NAMES) as ShelfLayout[]).map((k) => (
            <option key={k} value={k}>
              {LAYOUT_NAMES[k]}
            </option>
          ))}
        </select>
        <div className="nd-grid">{(['radius', 'gap', 'rows', 'rowStep', 'rowRise', 'x', 'z', 'turn'] as NumKey[]).map(shelfNum)}</div>
      </>
    ) : (
      needShelf
    ),
    seat: s ? (
      <>
        <div className="nd-grid">{(['seat', 'lift', 'lean', 'shoulder', 'thick', 'clearance'] as NumKey[]).map(shelfNum)}</div>
        <label className="nd-field" {...help('Step the plate tops down to the cards. Off leaves the plates as they are, with just the notches cut.')}>
          <input type="checkbox" checked={s.trim} onChange={(e) => editShelf({ trim: e.target.checked })} /> <span>Step plates</span>
        </label>
      </>
    ) : (
      <div className="nd-out">{objects.length ? 'Cuts the placed objects out of the plates.' : 'Nothing to cut yet.'}</div>
    ),
    plates: (
      <>
        <div className="nd-grid">
          {paramNum('stackHeight', 'Height', 'Plates › Plate height: how tall the plates stand above the concrete before any trimming (mm).', 5)}
          {paramNum('thickness', 'Thick', 'Plates › Thickness of the sheet the plates are cut from (mm).', 0.5)}
          {paramNum('pitch', 'Pitch', 'Plates › Pitch: distance from one plate to the next (mm). Closer plates hold the cards in more places.', 1)}
        </div>
        <div className="nd-out">
          {plates.length} plates, {fmt(Math.min(...heights), 0)} to {fmt(Math.max(...heights), 0)} mm tall
        </div>
        {s && (
          <button
            className="btn sm"
            onClick={() => {
              const patch = fitShelf(model, s);
              if (patch) setParams(patch, 'Fit plates to the postcard shelf');
            }}
            {...help('Make the plates flat-topped and tall enough to reach every card, the base big enough to hold them, and take the insert out of the way. Undo puts it all back.')}
          >
            Fit plates
          </button>
        )}
      </>
    ),
    colours: (
      <>
        <div className="nd-grid">
          <label className="nd-field" {...help('How many colours the rainbow is split into.')}>
            <span>Colours</span>
            <input type="number" min={2} max={24} value={bands} onChange={(e) => setBands(Math.max(2, Math.min(24, Math.round(+e.target.value) || 7)))} />
          </label>
        </div>
        <button className="btn sm" onClick={() => setAppearance(rainbowPlates(model, appearance, bands), 'fill:rainbow')} {...help('Anodised aluminium in rainbow bands, red to violet along the plates (replaces an earlier rainbow).')}>
          Rainbow
        </button>
        <div className="nd-out">{rainbowCount ? `${rainbowCount} rainbow buckets` : 'Plates in their main metal'}</div>
      </>
    ),
    cut: (
      <>
        <div className="nd-out">
          {model.sliced.parts.length} parts on {model.nested.sheets.length} sheet{model.nested.sheets.length === 1 ? '' : 's'}, {fmt(model.bom.cutLength, 1)} m of cutting
        </div>
        <button className="btn sm" onClick={() => setUi({ tab: 'plates' })} {...help('See every flat part.')}>
          Plates view
        </button>
      </>
    ),
  };

  const wired = (a: NodeId, b: NodeId) => focus !== null && (a === focus || b === focus);
  return (
    <div className="nodes-view">
      <div className="nd-intro">
        <span>{INTRO}</span>
        <button className="btn sm" onClick={() => setTour(tour === null ? 0 : null)}>
          {tour === null ? 'Take the tour' : 'End tour'}
        </button>
      </div>
      <div className="nd-area" ref={area}>
        <svg className="nd-wires">
          {WIRES.map(([a, b]) => {
            const p = ports[a]?.r;
            const q = ports[b]?.l;
            if (!p || !q) return null;
            const dx = Math.max(40, (q[0] - p[0]) / 2);
            return <path key={`${a}-${b}`} className={wired(a, b) ? 'on' : ''} d={`M${p[0]},${p[1]} C${p[0] + dx},${p[1]} ${q[0] - dx},${q[1]} ${q[0]},${q[1]}`} />;
          })}
        </svg>
        {COLUMNS.map((col, ci) => (
          <div className="nd-col" key={ci}>
            {col.map((id) => {
              const n = NODES.find((x) => x.id === id)!;
              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) refs.current.set(id, el);
                    else refs.current.delete(id);
                  }}
                  className={`nd-node ${focus === id ? 'focus' : ''} nd-${id}`}
                  onMouseEnter={() => setHover(id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="nd-head">
                    <i className="nd-port in" />
                    {n.title}
                    <i className="nd-port out" />
                  </div>
                  <div className="nd-body">{body[id]}</div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="nd-explain">
        {tour !== null && (
          <span className="nd-step">
            <button className="btn sm" disabled={tour === 0} onClick={() => setTour(tour - 1)}>
              Back
            </button>
            {tour + 1} of {NODES.length}
            <button className="btn sm" onClick={() => setTour(tour + 1 < NODES.length ? tour + 1 : null)}>
              {tour + 1 < NODES.length ? 'Next' : 'Done'}
            </button>
          </span>
        )}
        <span>{hint ?? (info ? <><b>{info.title}.</b> {info.teach}</> : 'Hover a node, or take the tour, to see what each step does.')}</span>
      </div>
    </div>
  );
}
