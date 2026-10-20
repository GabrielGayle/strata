import { useStore } from '../state/store';
import { RAKE_HEIGHTS, SPREAD_STEPS, TINT_LABELS, type PlateTint } from './viewAids';

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
      <button
        type="button"
        className={`btn sm ${aids.rake ? 'on' : ''}`}
        data-testid="view-aid-rake"
        aria-pressed={aids.rake}
        onClick={() => set({ rake: !aids.rake })}
        title="One low light skimming the surface, like a wall piece lit from the side, so a subtle relief shows its form (view only)"
      >
        Rake
      </button>
      {aids.rake && (
        <>
          <label className="view-aid-field" title="Turn the raking light round the piece (view only)">
            Turn
            <input
              type="range"
              data-testid="view-aid-rake-turn"
              min={0}
              max={345}
              step={15}
              value={aids.rakeTurn}
              onChange={(e) => set({ rakeTurn: Number(e.target.value) })}
              aria-label="Raking light direction"
              style={{ width: 84, minWidth: 84 }}
            />
          </label>
          <label className="view-aid-field" title="How low the raking light is: lower shows gentler forms (view only)">
            Height
            <select data-testid="view-aid-rake-height" value={aids.rakeHeight} onChange={(e) => set({ rakeHeight: Number(e.target.value) })}>
              {RAKE_HEIGHTS.map((h) => (
                <option key={h} value={h}>
                  {h}°
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
