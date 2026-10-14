// The predicted note of every tuned plate, with a play button and the honest caveat.
import { useModel, fmt } from './model';
import { useStore } from '../state/store';
import { hzToNote, MATERIALS, type PlateTune } from '../core/tuning';
import { playStrike } from './audio';

export function centsLabel(c: number): string {
  return c === 0 ? '±0¢' : `${c > 0 ? '+' : '−'}${Math.abs(c)}¢`;
}

/** "A3 +12¢" for the plate as cut. */
export function asCut(t: PlateTune): string {
  const n = hzToNote(t.cutHz);
  return `${n.name} ${centsLabel(n.cents)}`;
}

export default function TuningTable() {
  const model = useModel();
  const setUi = useStore((s) => s.setUi);
  const v = model.v;
  const tuning = model.sliced.tuning;
  if (!tuning) return null;
  const rows = model.sliced.plates.map((p, i) => ({ plate: p, tune: tuning[i] })).filter((r) => r.tune) as { plate: (typeof model.sliced.plates)[number]; tune: PlateTune }[];
  if (!rows.length) return null;
  const mat = MATERIALS[v.plateMaterial] ?? MATERIALS.steel;
  return (
    <div style={{ display: 'grid', gap: 6, padding: '4px 0 6px' }}>
      <table className="tbl" style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>Plate</th>
            <th>Note</th>
            <th className="num" title="Height cut above the concrete, with the tuning allowance (mm)">Cut</th>
            <th title="Predicted pitch of the plate as cut, before trimming">Rings</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ plate, tune }) => {
            const id = plate.parts[0]?.id ?? plate.def.key;
            return (
              <tr key={plate.def.key} className="click" onClick={() => setUi({ selected: id })} style={tune.clamped ? { color: 'var(--warn)' } : undefined}>
                <td className="mono">{id}</td>
                <td className="mono" title={`${fmt(tune.hz, 1)} Hz at ${fmt(tune.length, 1)} mm`}>
                  {tune.name}
                </td>
                <td className="num">{fmt(tune.cut, 1)}</td>
                <td className="mono">{asCut(tune)}</td>
                <td>
                  <button
                    className="btn sm"
                    style={{ padding: '0 6px' }}
                    title={`Hear roughly how ${tune.name} sounds struck`}
                    aria-label={`Play ${tune.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      playStrike(tune.hz);
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
      <div className="perr" style={{ color: 'var(--muted)' }}>
        Predicted for {fmt(v.thickness, 1)} mm {mat.label} clamped rigidly in the concrete. Real plates land off this, often by a semitone or more: the concrete grip
        gives a little, wide plates are stiffer than the simple model, and cut-outs change it. Plates are cut {fmt(v.tuneAllowance, 1)}% tall so they start flat: strike each one, check
        it with a tuner or by ear, and grind the top down a little at a time to bring it up to pitch.
      </div>
    </div>
  );
}
