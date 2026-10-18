import { useStore } from '../state/store';
import { SPREAD_STEPS, TINT_LABELS, type PlateTint } from './viewAids';

const TINTS: PlateTint[] = ['off', 'alternate', 'rainbow', 'height'];

/** Edge aids for dense stacks: outlines, plate tint and spread. View only, nothing is cut differently. */
export default function ViewAidsToolbar() {
  const aids = useStore((s) => s.ui.viewAids);
  const set = useStore((s) => s.setViewAids);
  return (
    <div className="view-aids overlay" role="toolbar" aria-label="Edge view aids" data-testid="view-aids">
      <button
        type="button"
        className={`btn sm ${aids.outlines ? 'on' : ''}`}
        data-testid="view-aid-outlines"
        onClick={() => set({ outlines: !aids.outlines })}
        title="Draw a dark line round every plate face so each edge stands out (view only)"
      >
        Edges
      </button>
      <label className="view-aid-field" title="Colour the plates so neighbours differ (view only)">
        Tint
        <select data-testid="view-aid-tint" value={aids.tint} onChange={(e) => set({ tint: e.target.value as PlateTint })}>
          {TINTS.map((t) => (
            <option key={t} value={t}>
              {TINT_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="view-aid-field" title="Pull the plates apart to see between them (view only; off while moving a plate)">
        Spread
        <select data-testid="view-aid-spread" value={aids.spread} onChange={(e) => set({ spread: Number(e.target.value) })}>
          {SPREAD_STEPS.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? 'As built' : `×${s}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
