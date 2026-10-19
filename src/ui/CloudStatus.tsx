import { useEffect, useState } from 'react';
import { checkCloud, cloudStatusText, cloudUsage, useCloud, type CloudUsage } from '../state/cloud';

/** Status bar Cloud field: off, checking, locked, ready, working n%, resting: reason. */
export function CloudField() {
  const cloud = useCloud();
  // Boost left on from last time: one health check on start
  useEffect(() => {
    if (useCloud.getState().boost) void checkCloud();
  }, []);
  const color =
    cloud.boost && cloud.phase === 'working' ? 'var(--accent)' : cloud.boost && (cloud.phase === 'resting' || cloud.phase === 'locked') ? 'var(--warn)' : undefined;
  return (
    <p
      className="status-bar-field"
      data-testid="cloud-status"
      style={{ color }}
      title={cloud.boost ? 'Boost runs heavy jobs in the cloud (Settings). The local build is always the fallback.' : 'Boost is off: everything runs in this browser (Settings to turn it on)'}
    >
      {cloudStatusText(cloud)}
    </p>
  );
}

function money(n: number): string {
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** Settings section: the Boost switch, where it stands, and this month's cost. */
export function BoostSettings() {
  const cloud = useCloud();
  const [usage, setUsage] = useState<CloudUsage | null | undefined>(undefined);
  useEffect(() => {
    if (!cloud.boost || cloud.phase !== 'ready') return;
    let alive = true;
    void cloudUsage().then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, [cloud.boost, cloud.phase]);
  return (
    <>
      <label title="Off: everything runs in this browser with no network. On: heavy jobs (high-resolution maps) run on the cloud, with the local build as the fallback.">
        <input type="checkbox" data-testid="boost-toggle" checked={cloud.boost} onChange={(e) => cloud.setBoost(e.target.checked)} /> Boost (cloud jobs)
      </label>
      <p className="note" data-testid="boost-status">
        {cloudStatusText(cloud)}
        {cloud.boost && cloud.phase === 'locked' ? '. Enter the owner passphrase in Projects first.' : ''}
      </p>
      {cloud.boost && usage && (
        <p className="note" data-testid="boost-usage">
          {usage.month}: {usage.jobs} job{usage.jobs === 1 ? '' : 's'}, about {money(usage.estimateUsd)}
          {usage.workspaceUsd != null ? ` (Modal bill so far ${money(usage.workspaceUsd)} of the ${money(usage.grantUsd)} grant)` : ` of the ${money(usage.grantUsd)} monthly grant`}
        </p>
      )}
      {cloud.boost && cloud.phase === 'resting' && (
        <div className="btnrow">
          <button className="btn sm" onClick={() => void checkCloud()}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}
