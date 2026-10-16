// The predicted note of every tuned plate, with a play button and the honest caveat.
import { useModel, fmt } from './model';
import { useStore } from '../state/store';
import { hzToNote, MATERIALS, type PlateTune } from '../core/tuning';
import type { SoundingMode } from '../core/pipeline';
import { playChant, playModes, playStrike } from './audio';

export function centsLabel(c: number): string {
  return c === 0 ? '±0¢' : `${c > 0 ? '+' : '−'}${Math.abs(c)}¢`;
}

/** "A3 +12¢" for the plate as cut. */
export function asCut(t: PlateTune): string {
  const n = hzToNote(t.cutHz);
  return `${n.name} ${centsLabel(n.cents)}`;
}

/** Partials to play: the worker's reading of the cut outline once it matches this edit, else the fast model. */
export function heardPartials(tune: PlateTune, sounding?: SoundingMode, stale = false): number[] {
  if (!stale && sounding?.hz?.length) return sounding.hz;
  return tune.partials?.length ? tune.partials : [tune.hz];
}

export default function TuningTable() {
  const model = useModel();
  const setUi = useStore((s) => s.setUi);
  const v = model.v;
  const tuning = model.sliced.tuning;
  if (!tuning) return null;
  const rows = model.sliced.plates.map((p, i) => ({ plate: p, tune: tuning[i] })).filter((r) => r.tune) as { plate: (typeof model.sliced.plates)[number]; tune: PlateTune }[];
  if (!rows.length) return null;
  const byKey = new Map((model.sounding ?? []).map((s) => [s.key, s]));
  const matLabel = [...new Set(rows.map((r) => r.tune.material ?? v.plateMaterial))].map((m) => (MATERIALS[m] ?? MATERIALS.steel).label).join(' and ');
  const free = rows.some((r) => r.tune.model === 'free');
  return (
    <div style={{ display: 'grid', gap: 6, padding: '4px 0 6px' }}>
      <table className="tbl" style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>Plate</th>
            <th>Note</th>
            <th className="num" title={free ? 'Bar length as cut (mm)' : 'Height cut above the concrete, with the tuning allowance (mm)'}>Cut</th>
            <th title="Predicted pitch of the plate as cut">Rings</th>
            {free && <th title="Second and third bending partials, Hz">Overtones</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ plate, tune }) => {
            const id = plate.parts[0]?.id ?? plate.def.key;
            const heard = heardPartials(tune, byKey.get(plate.def.key), model.stale);
            const nodeTitle = tune.nodes ? `Mounting holes at ${tune.nodes.map((s) => `${(s * 100).toFixed(1)}%`).join(' and ')} of the length` : `${fmt(tune.hz, 1)} Hz at ${fmt(tune.length, 1)} mm`;
            return (
              <tr key={plate.def.key} className="click" onClick={() => setUi({ selected: id })} style={tune.clamped ? { color: 'var(--warn)' } : undefined}>
                <td className="mono">{id}</td>
                <td className="mono" title={`${tune.label ? tune.label + ' · ' : ''}${fmt(tune.hz, 1)} Hz at ${fmt(tune.length, 1)} mm in ${(MATERIALS[tune.material] ?? MATERIALS.steel).label}`}>
                  {tune.label ?? tune.name}
                </td>
                <td className="num" title={nodeTitle}>{fmt(tune.cut, 1)}</td>
                <td className="mono">{asCut(tune)}</td>
                {free && (
                  <td className="mono" title={(tune.partials ?? heard).slice(0, 3).map((f) => `${fmt(f, 1)} Hz`).join(' · ')}>
                    {(tune.partials ?? []).slice(1, 3).map((f) => fmt(f, 0)).join(' · ')}
                  </td>
                )}
                <td>
                  <button
                    className="btn sm"
                    style={{ padding: '0 6px' }}
                    title={tune.partials ? `Hear ${tune.label ?? tune.name}: f1, f2 and f3` : `Hear roughly how ${tune.name} sounds struck`}
                    aria-label={`Play ${tune.label ?? tune.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tune.model === 'free') playModes(heard);
                      else playStrike(tune.hz);
                    }}
                  >
                    ▶
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {free && (
        <button
          className="btn"
          onClick={() => playChant(rows.map((r) => heardPartials(r.tune, byKey.get(r.plate.def.key), model.stale)))}
          title="Each plate in order, on the chant rhythm: quarter, two eighths, dotted quarter"
        >
          ▶ Play the chant
        </button>
      )}
      <div className="perr" style={{ color: 'var(--muted)' }}>
        {free
          ? `Predicted for ${fmt(v.thickness, 1)} mm ${matLabel} hung freely at the nodes of the first mode (about 22.4% of the length from each end — the holes on the plate). f1 is tuned to the note; the overtones are the bar's own, not harmonics. The face width is free, so an image can sit on it. A 2D plate is a little off this 1D beam: strike each one and trim the length if a tuner disagrees.`
          : `Predicted for ${fmt(v.thickness, 1)} mm ${matLabel} clamped rigidly in the concrete. Real plates land off this, often by a semitone or more: the concrete grip gives a little, wide plates are stiffer than the simple model, and cut-outs change it. Plates are cut ${fmt(v.tuneAllowance, 1)}% tall so they start flat: strike each one, check it with a tuner or by ear, and grind the top down a little at a time to bring it up to pitch.`}
      </div>
    </div>
  );
}
