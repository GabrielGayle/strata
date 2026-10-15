// Appearance: material buckets and the smart clicker. With the panel open, a
// click on a plate in the 3D view puts it in the active bucket, a second click
// takes it back out, and shift-click fills the run of plates since the last
// click. Quick fills pattern a whole group at once.
import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import type { Model } from '../core/pipeline';
import {
  applyFill,
  assignPlates,
  defaultAppearance,
  FILLS,
  FINISHES,
  finishOf,
  MAIN,
  METAL_IDS,
  METAL_NAMES,
  newBucketId,
  pickPlates,
  removeBucket,
  runBetween,
  type Appearance,
  type FillPattern,
  type FillPlate,
} from '../core/appearance';
import { bucketLooks } from './Scene';

/** Groups of plates the quick fills work over, each in stack order. */
export function fillGroups(model: Model): { id: string; label: string; plates: FillPlate[] }[] {
  const height = (key: string) => Math.max(0, ...model.sliced.parts.filter((p) => p.plateKey === key).map((p) => p.bbox.maxY));
  const fam = (fs: string[]) => model.sliced.plates.filter((p) => fs.includes(p.def.family) && p.parts.length).map((p) => ({ key: p.def.key, height: height(p.def.key) }));
  const loose = (f: string) => [...new Set(model.sliced.parts.filter((p) => p.family === f).map((p) => p.plateKey))].map((key) => ({ key, height: height(key) }));
  const flat = model.v.sliceMode === 'flat';
  const groups = [
    { id: 'main', label: flat ? 'Layers' : 'Plates', plates: fam(['P', 'R']) },
    { id: 'cross', label: 'Cross slats', plates: fam(['X']) },
    { id: 'pieces', label: 'Cross pieces', plates: loose('C') },
  ].filter((g) => g.plates.length);
  const all = [...new Map(model.sliced.parts.map((p) => [p.plateKey, { key: p.plateKey, height: height(p.plateKey) }])).values()];
  if (groups.length > 1) groups.push({ id: 'all', label: 'Everything', plates: all });
  return groups;
}

/** Stack order of every plate key, and each key's family, for shift-click runs. */
export function paintOrder(model: Model): { order: string[]; family: Map<string, string> } {
  const family = new Map<string, string>();
  for (const p of model.sliced.parts) if (!family.has(p.plateKey)) family.set(p.plateKey, p.family);
  return { order: [...family.keys()], family };
}

let lastPainted: string | null = null;

/** What a click on a plate does while the panel is open. */
export function paintClick(model: Model, key: string, shift: boolean) {
  const st = useStore.getState();
  const app = st.project.appearance ?? defaultAppearance();
  const active = activeOf(app, st.ui.activeBucket);
  const { order, family } = paintOrder(model);
  let next: Appearance;
  if (shift && lastPainted && lastPainted !== key && family.get(lastPainted) === family.get(key)) {
    const run = runBetween(order.filter((k) => family.get(k) === family.get(key)), lastPainted, key);
    next = assignPlates(app, run, active);
  } else {
    const cur = app.assign[key] ?? MAIN;
    next = assignPlates(app, [key], cur === active && active !== MAIN ? MAIN : active);
  }
  lastPainted = key;
  st.setAppearance(next, `paint:${key}`);
}

const activeOf = (app: Appearance, id: string) => (id === MAIN || app.buckets.some((b) => b.id === id) ? id : (app.buckets[0]?.id ?? MAIN));

export default function AppearancePanel() {
  const model = useModel();
  const stored = useStore((s) => s.project.appearance);
  const setAppearance = useStore((s) => s.setAppearance);
  const setParam = useStore((s) => s.setParam);
  const activeId = useStore((s) => s.ui.activeBucket);
  const setUi = useStore((s) => s.setUi);
  const app = stored ?? defaultAppearance();
  const active = activeOf(app, activeId);
  const main = String(model.v.plateMaterial);
  const looks = bucketLooks(app, main);
  const groups = useMemo(() => fillGroups(model), [model]);
  const [groupId, setGroupId] = useState('main');
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const [nth, setNth] = useState(2);
  const [offset, setOffset] = useState(0);
  const [seed, setSeed] = useState(1);

  // plates per bucket, counting each plate once
  const keys = [...new Set(model.sliced.parts.map((p) => p.plateKey))];
  const count = (id: string) => keys.filter((k) => (app.assign[k] ?? MAIN) === id).length;
  const massBy = new Map<string, number>();
  for (const r of model.bom.rows) massBy.set(r.material, (massBy.get(r.material) ?? 0) + r.mass);

  const save = (a: Appearance, label?: string) => setAppearance(a, label);
  const bucket = app.buckets.find((b) => b.id === active);
  const material = bucket ? bucket.material : main;
  const finishes = FINISHES[material] ?? FINISHES.steel;
  const finish = finishOf(material, bucket ? bucket.finish : app.main?.finish);
  const color = bucket ? bucket.color : app.main?.color;
  const edit = (patch: { name?: string; material?: string; finish?: string; color?: string }) => {
    if (bucket) save({ ...app, buckets: app.buckets.map((b) => (b.id === bucket.id ? { ...b, ...patch } : b)) }, `bucket:${bucket.id}`);
    else if (patch.material) setParam('plateMaterial', patch.material);
    else save({ ...app, main: { ...app.main, ...patch } }, 'bucket:main');
  };
  const addBucket = () => {
    const id = newBucketId(app);
    const used = new Set([main, ...app.buckets.map((b) => b.material)]);
    const metal = METAL_IDS.find((m) => !used.has(m)) ?? 'aluminium';
    save({ ...app, buckets: [...app.buckets, { id, name: `${METAL_NAMES[metal].split(' ')[0]} ${app.buckets.length + 1}`, material: metal }] });
    setUi({ activeBucket: id });
  };
  const fill = (pattern: FillPattern) => {
    if (!group) return;
    const s = pattern === 'random' || pattern === 'fade' ? seed + 1 : seed;
    if (s !== seed) setSeed(s);
    const picked = pickPlates(group.plates, pattern, { n: nth, offset, seed: s * 7919 });
    save(applyFill(app, group.plates, active, picked), `fill:${pattern}`);
  };
  const clear = () => {
    if (!group) return;
    save(assignPlates(app, group.plates.map((p) => p.key).filter((k) => (app.assign[k] ?? MAIN) === active), MAIN), 'fill:clear');
  };

  const chips = [{ id: MAIN, name: 'Main', material: main }, ...app.buckets];
  return (
    <div className="overlay movepanel appearance">
      <div className="mp-row">
        {chips.map((b) => (
          <button key={b.id} className={`btn sm bucket ${active === b.id ? 'on' : ''}`} onClick={() => setUi({ activeBucket: b.id })} title={`${METAL_NAMES[b.material]}: click plates to put them here`}>
            <i className="swatch" style={{ background: looks[b.id]?.color }} /> {b.name} <small>{count(b.id)}</small>
          </button>
        ))}
        <button className="btn sm" onClick={addBucket} title="Add a material bucket">
          + Bucket
        </button>
      </div>
      <div className="mp-row ap-edit">
        {bucket ? (
          <input aria-label="Bucket name" value={bucket.name} onChange={(e) => edit({ name: e.target.value })} />
        ) : (
          <span className="ap-label">Main</span>
        )}
        <select aria-label="Metal" value={material} onChange={(e) => edit({ material: e.target.value, finish: undefined })} title={bucket ? 'What these plates are cut from' : 'Plates › Material: what every plate in no bucket is cut from'}>
          {METAL_IDS.map((m) => (
            <option key={m} value={m}>
              {METAL_NAMES[m]}
            </option>
          ))}
        </select>
        <select aria-label="Finish" value={finish.id} onChange={(e) => edit({ finish: e.target.value })}>
          {finishes.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {finish.coloured && <input type="color" aria-label="Finish colour" value={color ?? finish.look.color} onChange={(e) => edit({ color: e.target.value })} />}
        {bucket && (
          <button
            className="btn sm"
            onClick={() => {
              save(removeBucket(app, bucket.id));
              setUi({ activeBucket: MAIN });
            }}
            title="Remove this bucket; its plates go back to the main metal"
          >
            Remove
          </button>
        )}
      </div>
      {group && (
        <div className="mp-row ap-fill">
          <select aria-label="Fill over" value={group.id} onChange={(e) => setGroupId(e.target.value)} title="Which plates the quick fills pattern">
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label} ({g.plates.length})
              </option>
            ))}
          </select>
          {FILLS.map((f) =>
            f.id === 'nth' ? (
              <span key={f.id} className="ap-nth">
                <button className="btn sm" onClick={() => fill('nth')} title={f.title}>
                  Every
                </button>
                <input type="number" aria-label="Every Nth" min={2} max={50} value={nth} onChange={(e) => setNth(Math.max(2, Math.round(+e.target.value) || 2))} />
                <span>from</span>
                <input type="number" aria-label="Starting at" min={1} max={nth} value={offset + 1} onChange={(e) => setOffset(Math.max(0, Math.round(+e.target.value) - 1 || 0))} />
              </span>
            ) : (
              <button key={f.id} className="btn sm" onClick={() => fill(f.id)} title={f.title}>
                {f.label}
              </button>
            ),
          )}
          {active !== MAIN && (
            <button className="btn sm" onClick={clear} title="Send this group's plates in the active bucket back to the main metal">
              Clear
            </button>
          )}
        </div>
      )}
      <div className="mp-info">
        {active === MAIN ? 'Click plates to send them back to the main metal.' : `Click plates to put them in ${bucket?.name}; click again to take one out. Shift-click fills the run since the last click.`}
        {[...massBy].length > 1 && ` · ${[...massBy].map(([m, kg]) => `${METAL_NAMES[m] ?? m} ${fmt(kg, 1)} kg`).join(' + ')}`}
        {[...massBy].length > 1 && ' · each metal cuts on its own sheets'}
      </div>
    </div>
  );
}
