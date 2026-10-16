import { useState } from 'react';
import { useModel } from './model';
import type { Shape } from '../core/geom2d';

/** Params whose adjustment opens the zoomed rounding preview. */
export const ROUND_PREVIEW_IDS = new Set(['edgeRound', 'edgeRoundIn']);

const W = 236;
const H = 150;

/**
 * A close-up of the spots where Round all corners moves a plate edge the furthest:
 * the plate before rounding as a dashed line, after it filled. Shown while the
 * rounding sliders are being adjusted.
 */
export default function RoundPreview({ onClose, keep, setKeep }: { onClose: () => void; keep: boolean; setKeep: (k: boolean) => void }) {
  const model = useModel();
  const v = model.v;
  const spots = model.sliced.roundSpots ?? [];
  const [pick, setPick] = useState(0);
  const idx = Math.min(pick, Math.max(0, spots.length - 1));
  const spot = spots[idx] ?? null;
  const r = Math.max(v.edgeRound, v.edgeRoundIn);
  const warnAt = Math.max(2, r * 3); // matches the warning in slicer.ts
  // the window: wide enough to see the round and what it took off
  const half = spot ? Math.max(6, 2.2 * r, 1.4 * spot.move) : 10;
  const sx = W / (2 * half), sy = sx;
  const cx = spot ? spot.at[0] : 0, cy = spot ? spot.at[1] : 0;
  const halfH = H / 2 / sy;
  const toPath = (sh: Shape) =>
    sh
      .flatMap((ex) => [ex.outer, ...ex.holes])
      .map((p) => 'M' + p.map(([x, y]) => `${((x - cx) * sx + W / 2).toFixed(1)},${(H / 2 - (y - cy) * sy).toFixed(1)}`).join('L') + 'Z')
      .join('');
  // only the parts of the plate near the spot (keeps the SVG light on big plates)
  const near = (sh: Shape) => sh.filter((ex) => ex.outer.some(([x, y]) => Math.abs(x - cx) < half * 4 && Math.abs(y - cy) < halfH * 4));
  const bad = !!spot && spot.move > warnAt;
  const split = model.sliced.warnings.find((w) => w.startsWith('Round all corners cuts through'));
  return (
    <div className="window round-preview" role="dialog" aria-label="Rounding close-up">
      <div className="title-bar">
        <div className="title-bar-text">Close-up{spot ? `: ${spot.label}` : ''}</div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={onClose} />
        </div>
      </div>
      <div className="window-body">
        {spot ? (
          <>
            <svg className="round-zoom" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${spot.label}: edge moves ${spot.move.toFixed(1)} mm`}>
              <rect width={W} height={H} fill="#fff" />
              <path d={toPath(near(spot.after))} fill="#9c4f24" fillRule="evenodd" />
              <path d={toPath(near(spot.before))} fill="none" stroke="#000080" strokeWidth={1.2} strokeDasharray="4 3" fillRule="evenodd" />
              <circle cx={W / 2} cy={H / 2} r={4} fill="none" stroke={bad ? '#c00000' : '#008000'} strokeWidth={1.5} />
              {/* 5 mm scale bar */}
              <line x1={8} y1={H - 8} x2={8 + 5 * sx} y2={H - 8} stroke="#000" strokeWidth={2} />
              <text x={8} y={H - 12} fontSize={10} fill="#000">
                5 mm
              </text>
            </svg>
            <p className={`round-note ${bad ? 'bad' : ''}`}>
              {bad ? '⚠ ' : ''}Edge moves {spot.move.toFixed(1)} mm here{idx === 0 ? ', the most along any plate (end corners aside)' : ''}.
              {bad ? ' That is more than rounding needs: detail is being flattened.' : ''}
            </p>
          </>
        ) : (
          <p className="round-note">Rounding is off. Drag the slider to see a close-up.</p>
        )}
        {spots.length > 1 && (
          <div className="field-row round-steps">
            <button onClick={() => setPick((idx + spots.length - 1) % spots.length)} aria-label="Previous spot">
              ◀
            </button>
            <span>
              Spot {idx + 1} of {spots.length}
            </span>
            <button onClick={() => setPick((idx + 1) % spots.length)} aria-label="Next spot">
              ▶
            </button>
          </div>
        )}
        {split && <p className="round-note bad">⚠ {split}</p>}
        <div className="field-row round-legend">
          <span className="key dashed" /> before
          <span className="key filled" /> after
          <input type="checkbox" id="round-keep" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <label htmlFor="round-keep">Keep open</label>
        </div>
      </div>
    </div>
  );
}
