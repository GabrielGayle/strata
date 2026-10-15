// Sun study: the real sun for the site, date and time of day lights the 3D
// view, with its path across the sky, a compass on the ground and a time bar.
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { Model } from '../core/pipeline';
import { bearingToWorld, clock, siteOf, sunPosition, sunTimes, sunVector, type Site } from '../core/sun';
import { useStore } from '../state/store';
import { modelBounds } from './Scene';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassName = (bearing: number) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

/** Points of the sun's path for a date, every few minutes while it is up. */
function pathPoints(model: Model, site: Site, center: THREE.Vector3, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let m = 0; m <= 24 * 60; m += 5) {
    const p = sunPosition(site, m / 60);
    if (p.elevation < 0) continue;
    const [x, y, z] = sunVector(model.v, p);
    pts.push(new THREE.Vector3(center.x + x * r, y * r, center.z + z * r));
  }
  return pts;
}

function PathLine({ points, color, opacity, dashed }: { points: THREE.Vector3[]; color: string; opacity: number; dashed?: boolean }) {
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 30, gapSize: 20, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const l = new THREE.Line(g, mat);
    if (dashed) l.computeLineDistances();
    return l;
  }, [points, color, opacity, dashed]);
  useEffect(() => () => (line.geometry.dispose(), (line.material as THREE.Material).dispose()), [line]);
  return <primitive object={line} />;
}

/** The light itself: follows the sun, warm and dim near the horizon, off at night. */
function SunLight({ model, dir, elevation }: { model: Model; dir: THREE.Vector3; elevation: number }) {
  const { center, size } = modelBounds(model);
  const up = THREE.MathUtils.smoothstep(elevation, -1, 8);
  const warm = THREE.MathUtils.smoothstep(elevation, 0, 25);
  const color = new THREE.Color('#ff9a52').lerp(new THREE.Color('#fff4e6'), warm);
  const pos = dir.clone().multiplyScalar(size * 2.2);
  // long low-sun shadows reach well past the piece
  const r = size * 1.4 + center.length();
  return (
    <directionalLight
      position={pos}
      intensity={2.1 * up}
      color={color}
      castShadow={up > 0}
      shadow-mapSize={[4096, 4096]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.6}
      shadow-camera-left={-r}
      shadow-camera-right={r}
      shadow-camera-top={r}
      shadow-camera-bottom={-r}
      shadow-camera-near={1}
      shadow-camera-far={size * 6}
    />
  );
}

/** The wall the shadow pictures fall on: a pale panel behind the piece that catches the real shadow. */
function ShadowWall({ model }: { model: Model }) {
  const g = model.shadow!.geom;
  const pad = Math.max(g.w, g.h) * 0.35;
  const w = g.w + pad * 2;
  const top = g.y0 + g.h + pad;
  const a = g.x0 + g.w / 2;
  // centre of the panel, a hair in front of the wall so it never fights the grid
  const cx = g.s[0] * (g.wallS + 1) + g.right[0] * a;
  const cz = g.s[1] * (g.wallS + 1) + g.right[1] * a;
  // the panel's face looks back along the stack, toward the piece
  const rotY = Math.atan2(-g.s[0], -g.s[1]);
  return (
    <mesh position={[cx, top / 2, cz]} rotation={[0, rotY, 0]} receiveShadow>
      <planeGeometry args={[w, top]} />
      <meshStandardMaterial color="#efe9dd" roughness={0.95} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Everything the sun study adds to the 3D scene. */
export function SunStudy3D({ model }: { model: Model }) {
  const v = model.v;
  const time = useStore((s) => s.ui.sunTime);
  const site = siteOf(v);
  const pos = sunPosition(site, time);
  const dir = new THREE.Vector3(...sunVector(v, pos));
  const { center, size } = modelBounds(model);
  const r = Math.max(size * 1.1, 300);
  const ground = new THREE.Vector3(center.x, 0, center.z);
  const siteKey = `${site.lat}|${site.lon}|${site.utc}|${site.month}|${site.day}|${v.sunFacing}|${v.sliceAxis}|${v.sliceMode}`;
  const paths = useMemo(() => {
    if (!v.sunPath) return null;
    return {
      today: pathPoints(model, site, ground, r),
      summer: pathPoints(model, { ...site, month: 6, day: 21 }, ground, r),
      winter: pathPoints(model, { ...site, month: 12, day: 21 }, ground, r),
    };
  }, [siteKey, v.sunPath, r, ground.x, ground.z]); // eslint-disable-line react-hooks/exhaustive-deps
  const hours = useMemo(() => {
    if (!v.sunPath) return [];
    const out: { h: number; p: THREE.Vector3 }[] = [];
    for (let h = 0; h < 24; h++) {
      const sp = sunPosition(site, h);
      if (sp.elevation < 1) continue;
      const [x, y, z] = sunVector(v, sp);
      out.push({ h, p: new THREE.Vector3(ground.x + x * r, y * r, ground.z + z * r) });
    }
    return out;
  }, [siteKey, v.sunPath, r, ground.x, ground.z]); // eslint-disable-line react-hooks/exhaustive-deps
  const ring = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(ground.x + Math.cos(a) * r, 0.5, ground.z + Math.sin(a) * r));
    }
    return pts;
  }, [r, ground.x, ground.z]);
  const up = pos.elevation > 0;
  return (
    <>
      <SunLight model={model} dir={dir} elevation={pos.elevation} />
      {/* catches the shadows on the ground around the base */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ground.x, 0.3, ground.z]} receiveShadow>
        <planeGeometry args={[r * 8, r * 8]} />
        <shadowMaterial transparent opacity={0.32} depthWrite={false} />
      </mesh>
      {model.shadow && <ShadowWall model={model} />}
      {paths && (
        <>
          <PathLine points={ring} color="#8a8478" opacity={0.6} />
          {['N', 'E', 'S', 'W'].map((n, i) => {
            const [x, z] = bearingToWorld(v, i * 90);
            return (
              <Html key={n} position={[ground.x + x * r * 1.06, 1, ground.z + z * r * 1.06]} center zIndexRange={[2, 0]}>
                <span className={`sun-compass ${n === 'N' ? 'north' : ''}`}>{n}</span>
              </Html>
            );
          })}
          <PathLine points={paths.summer} color="#d99a1e" opacity={0.45} dashed />
          <PathLine points={paths.winter} color="#2f5f9e" opacity={0.45} dashed />
          <PathLine points={paths.today} color="#e0701c" opacity={0.95} />
          {hours.map(({ h, p }) => (
            <group key={h} position={p}>
              <mesh>
                <sphereGeometry args={[r * 0.008, 10, 8]} />
                <meshBasicMaterial color="#e0701c" />
              </mesh>
              <Html center position={[0, r * 0.035, 0]} zIndexRange={[2, 0]}>
                <span className="sun-hour">{clock(h).slice(0, 2)}</span>
              </Html>
            </group>
          ))}
        </>
      )}
      {up && (
        <mesh position={[ground.x + dir.x * r, dir.y * r, ground.z + dir.z * r]}>
          <sphereGeometry args={[r * 0.03, 20, 14]} />
          <meshBasicMaterial color="#ffc04a" />
        </mesh>
      )}
    </>
  );
}

/** Time of day: slider, play, and where the sun is. */
export function SunBar({ model }: { model: Model }) {
  const v = model.v;
  const time = useStore((s) => s.ui.sunTime);
  const playing = useStore((s) => s.ui.sunPlaying);
  const setUi = useStore((s) => s.setUi);
  const site = siteOf(v);
  const times = sunTimes(site);
  const pos = sunPosition(site, time);
  const lo = times.rise ?? 0;
  const hi = times.set ?? 24;
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    // the daylight hours play in about 20 seconds
    const rate = Math.max(1, hi - lo) / 20;
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const t = useStore.getState().ui.sunTime + dt * rate;
      setUi({ sunTime: t > hi ? lo : t < lo ? lo : t });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, lo, hi, setUi]);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][site.month - 1];
  return (
    <div className="overlay bc sunbar">
      <div className="sb-row">
        <button className={`btn sm ${playing ? 'on' : ''}`} onClick={() => setUi({ sunPlaying: !playing })} title="Play the day">
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={24}
          step={1 / 60}
          value={time}
          onChange={(e) => setUi({ sunTime: Number(e.target.value), sunPlaying: false })}
          aria-label="Time of day"
        />
        <span className="sb-time">{clock(time)}</span>
      </div>
      <div className="sb-info">
        {site.day} {month} ·{' '}
        {pos.elevation > 0 ? `sun ${pos.elevation.toFixed(0)}° up, from the ${compassName(pos.azimuth)} (${pos.azimuth.toFixed(0)}°)` : 'sun below the horizon'}
        {' · '}
        {times.rise !== null ? `rises ${clock(times.rise)}, sets ${clock(times.set!)}` : pos.elevation > 0 ? 'up all day' : 'down all day'}
      </div>
    </div>
  );
}
