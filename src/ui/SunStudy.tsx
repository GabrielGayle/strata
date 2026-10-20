// Sun study: the real sun for the site, date and time of day lights the 3D
// view, with its path across the sky, a compass on the ground and a time bar.
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { Model } from '../core/pipeline';
import { clock, siteOf, sunPosition, sunTimes, type Site } from '../core/sun';
import { bearingDir, sunBehindWall, sunDir, type MountFrame } from '../core/mount';
import { useMountFrame } from './useMount';
import { shadowGeom, wallPoint, type ShadowGeom } from '../core/shadow';
import { useStore } from '../state/store';
import { modelBounds } from './Scene';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassName = (bearing: number) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

/** Points of the sun's path for a date, every few minutes while it is up. */
function pathPoints(model: Model, f: MountFrame, site: Site, center: THREE.Vector3, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let m = 0; m <= 24 * 60; m += 5) {
    const p = sunPosition(site, m / 60);
    if (p.elevation < 0) continue;
    pts.push(center.clone().addScaledVector(new THREE.Vector3(...sunDir(model.v, p.azimuth, p.elevation, f)), r));
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

/**
 * The light itself: follows the sun, warm and dim near the horizon, off at night.
 * Its shadow camera hugs the piece (only the piece casts), so every texel of
 * the shadow map lands on the plates and the carved pictures stay sharp.
 */
function SunLight({ model, dir, elevation }: { model: Model; dir: THREE.Vector3; elevation: number }) {
  const { center, radius } = modelBounds(model);
  const up = THREE.MathUtils.smoothstep(elevation, -1, 8);
  const warm = THREE.MathUtils.smoothstep(elevation, 0, 25);
  const color = new THREE.Color('#ff9a52').lerp(new THREE.Color('#fff4e6'), warm);
  const r = radius * 1.08;
  const pos = center.clone().addScaledVector(dir, r * 3);
  const target = useMemo(() => new THREE.Object3D(), []);
  target.position.copy(center);
  return (
    <>
      <primitive object={target} />
      <directionalLight
        position={pos}
        target={target}
        intensity={2.1 * up}
        color={color}
        castShadow={up > 0}
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.4}
        shadow-camera-left={-r}
        shadow-camera-right={r}
        shadow-camera-top={r}
        shadow-camera-bottom={-r}
        shadow-camera-near={1}
        // far enough to reach a distant wall and long low-sun shadows on the ground
        shadow-camera-far={r * 4 + 30000}
      />
    </>
  );
}

/** Where the shadow screen and candle are, even before any picture is carved. */
export function screenGeom(model: Model): ShadowGeom {
  if (model.shadow) return model.shadow.geom;
  const plates = model.sliced.plates.filter((p) => p.def.family === 'P' && p.parts.length).map((p) => ({ plane: p.parts[0].plane, thickness: p.parts[0].thickness }));
  return shadowGeom(model.v, plates);
}

/**
 * The screen the shadow pictures fall on: a whole wall (room scale, centred
 * behind the piece, with the picture area outlined) or a pale patch of ground,
 * catching the real shadow.
 */
export function ShadowScreen({ model }: { model: Model }) {
  const g = screenGeom(model);
  const v = model.v;
  const outline = useMemo(() => {
    if (g.screen !== 'wall') return null;
    const pts = [
      [g.x0, g.y0],
      [g.x0 + g.w, g.y0],
      [g.x0 + g.w, g.y0 + g.h],
      [g.x0, g.y0 + g.h],
      [g.x0, g.y0],
    ].map(([a, b]) => {
      const p = wallPoint(g, a, b);
      // a hair in front of the wall
      return new THREE.Vector3(p[0] - g.s[0] * 1.5, p[1], p[2] - g.s[1] * 1.5);
    });
    return pts;
  }, [g]);
  if (g.screen === 'base') return null; // the concrete itself catches it
  const pad = Math.max(g.w, g.h) * 0.35;
  const w = g.w + pad * 2;
  const a = g.x0 + g.w / 2;
  if (g.screen === 'ground') {
    const len = g.h + pad * 2;
    const b = g.y0 + g.h / 2;
    const cx = g.right[0] * a + g.s[0] * b;
    const cz = g.right[1] * a + g.s[1] * b;
    return (
      <mesh position={[cx, 0.5, cz]} rotation={[-Math.PI / 2, 0, Math.atan2(-g.s[1], g.s[0])]} receiveShadow>
        <planeGeometry args={[len, w]} />
        <meshStandardMaterial color="#efe9dd" roughness={0.95} metalness={0} />
      </mesh>
    );
  }
  // the whole wall, centred behind the middle of the piece and tall enough for the picture
  const ww = Math.max(Number(v.shadowWallW) || 3000, g.w + 40);
  const wh = Math.max(Number(v.shadowWallH) || 2400, g.y0 + g.h + 40);
  // its face sits a hair behind the screen plane so the outline never fights it
  const at = g.wallS + 0.5;
  const edge = [
    [-ww / 2, 0],
    [ww / 2, 0],
    [ww / 2, wh],
    [-ww / 2, wh],
    [-ww / 2, 0],
  ].map(([a, b]) => new THREE.Vector3(g.s[0] * at + g.right[0] * a, b, g.s[1] * at + g.right[1] * a));
  // the face looks back along the stack, toward the piece; from behind it is see-through, so it never hides the piece
  const rotY = Math.atan2(-g.s[0], -g.s[1]);
  return (
    <>
      <mesh position={[g.s[0] * at, wh / 2, g.s[1] * at]} rotation={[0, rotY, 0]} receiveShadow>
        <planeGeometry args={[ww, wh]} />
        <meshStandardMaterial color="#efe4cc" roughness={0.95} metalness={0} side={THREE.FrontSide} />
      </mesh>
      {/* from behind, a faint sheet and its edge show where the wall is */}
      <mesh position={[g.s[0] * at, wh / 2, g.s[1] * at]} rotation={[0, rotY, 0]}>
        <planeGeometry args={[ww, wh]} />
        <meshBasicMaterial color="#d8d0c0" transparent opacity={0.22} depthWrite={false} side={THREE.BackSide} />
      </mesh>
      <PathLine points={edge} color="#8a8478" opacity={0.7} />
      {outline && <PathLine points={outline} color="#e0701c" opacity={0.55} />}
    </>
  );
}

/**
 * A candle on a stand, lighting the scene at night. The light is a spotlight
 * from the flame, wide enough to light the whole wall, with its shadow map
 * narrowed to just the piece so the carved pictures cast sharp.
 */
export function Candle3D({ model }: { model: Model }) {
  const v = model.v;
  const g = screenGeom(model);
  const C = g.candle;
  const { center, radius } = modelBounds(model);
  const target = useMemo(() => new THREE.Object3D(), []);
  if (!C) return null;
  const flame = new THREE.Vector3(...C);
  target.position.copy(center);
  const axis = center.clone().sub(flame);
  const dist = axis.length() || 1;
  axis.divideScalar(dist);
  // the cone reaches every corner of the wall (or the picture on the ground)
  const ww = Math.max(Number(v.shadowWallW) || 3000, g.w);
  const wh = Math.max(Number(v.shadowWallH) || 2400, g.y0 + g.h);
  const corners: [number, number][] =
    g.screen === 'wall'
      ? [
          [-ww / 2, 0],
          [ww / 2, 0],
          [-ww / 2, wh],
          [ww / 2, wh],
          [g.x0, g.y0],
          [g.x0 + g.w, g.y0 + g.h],
        ]
      : [
          [g.x0, g.y0],
          [g.x0 + g.w, g.y0],
          [g.x0, g.y0 + g.h],
          [g.x0 + g.w, g.y0 + g.h],
        ];
  let angle = 0.2;
  let far = dist + radius;
  for (const [a, b] of corners) {
    const p = new THREE.Vector3(...wallPoint(g, a, b)).sub(flame);
    far = Math.max(far, p.length());
    angle = Math.max(angle, p.normalize().angleTo(axis));
  }
  angle = Math.min(1.5, angle + 0.05);
  // the shadow camera only needs to see the piece
  const piece = dist > radius ? Math.asin(Math.min(1, (radius * 1.1) / dist)) : Math.PI / 2;
  const focus = Math.min(1, piece / angle);
  const mid = new THREE.Vector3(...wallPoint(g, g.x0 + g.w / 2, g.y0 + g.h / 2));
  const reach = mid.distanceTo(flame);
  const size = Math.max(2, Number(v.candleFlame) || 12);
  const bodyH = 70;
  const bodyTop = C[1] - size * 0.6;
  const bodyBot = bodyTop - bodyH;
  return (
    <>
      <primitive object={target} />
      <spotLight
        position={flame}
        target={target}
        angle={angle}
        penumbra={0.15}
        decay={1}
        intensity={1.8 * reach}
        color="#ffb46b"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-focus={focus}
        shadow-bias={-0.0002}
        shadow-normalBias={0.4}
        shadow-camera-near={Math.max(1, size)}
        shadow-camera-far={far * 1.05}
      />
      {/* a little light all round, so the room isn't black behind the flame */}
      <pointLight position={flame} intensity={0.3 * reach} decay={1} color="#ff9a52" />
      <group position={[C[0], 0, C[2]]}>
        <mesh position={[0, C[1], 0]} scale={[1, 2, 1]}>
          <sphereGeometry args={[size / 2, 16, 12]} />
          <meshBasicMaterial color="#ffd27a" />
        </mesh>
        <mesh position={[0, bodyBot + bodyH / 2, 0]}>
          <cylinderGeometry args={[11, 11, bodyH, 24]} />
          <meshStandardMaterial color="#f3ead8" roughness={0.6} emissive="#5a3a10" emissiveIntensity={0.4} />
        </mesh>
        {bodyBot > 4 && (
          <>
            <mesh position={[0, bodyBot - 2, 0]}>
              <cylinderGeometry args={[24, 20, 4, 24]} />
              <meshStandardMaterial color="#3a3632" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, (bodyBot - 4) / 2, 0]}>
              <cylinderGeometry args={[3, 3, Math.max(0.1, bodyBot - 4), 12]} />
              <meshStandardMaterial color="#3a3632" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 2, 0]}>
              <cylinderGeometry args={[40, 46, 4, 32]} />
              <meshStandardMaterial color="#3a3632" metalness={0.6} roughness={0.4} />
            </mesh>
          </>
        )}
      </group>
      {/* catches the shadows on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, 0.3, center.z]} receiveShadow>
        <planeGeometry args={[Math.max(8000, ww * 2), Math.max(8000, ww * 2)]} />
        <shadowMaterial transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <ShadowScreen model={model} />
    </>
  );
}

/** Everything the sun study adds to the 3D scene. */
export function SunStudy3D({ model }: { model: Model }) {
  const v = model.v;
  const time = useStore((s) => s.ui.sunTime);
  // the sun is in the room: a wall piece is lit from above and in front, never through its wall
  const f = useMountFrame(v);
  const wall = f.mount === 'wall';
  const site = siteOf(v);
  const pos = sunPosition(site, time);
  const dir = new THREE.Vector3(...sunDir(v, pos.azimuth, pos.elevation, f));
  const behind = sunBehindWall(v, dir.toArray(), f);
  const { center, size } = modelBounds(model);
  const r = Math.max(size * 1.1, 300);
  // the middle of the floor under a table piece, or of the wall behind a wall piece
  const ground = new THREE.Vector3(center.x, 0, center.z);
  const up = new THREE.Vector3(...f.up);
  const siteKey = `${site.lat}|${site.lon}|${site.utc}|${site.month}|${site.day}|${v.sunFacing}|${v.sliceAxis}|${v.sliceMode}|${f.up.join(',')}|${f.facing.join(',')}`;
  const paths = useMemo(() => {
    if (!v.sunPath) return null;
    return {
      today: pathPoints(model, f, site, ground, r),
      summer: pathPoints(model, f, { ...site, month: 6, day: 21 }, ground, r),
      winter: pathPoints(model, f, { ...site, month: 12, day: 21 }, ground, r),
    };
  }, [siteKey, v.sunPath, r, ground.x, ground.z]); // eslint-disable-line react-hooks/exhaustive-deps
  const hours = useMemo(() => {
    if (!v.sunPath) return [];
    const out: { h: number; p: THREE.Vector3 }[] = [];
    for (let h = 0; h < 24; h++) {
      const sp = sunPosition(site, h);
      if (sp.elevation < 1) continue;
      out.push({ h, p: ground.clone().addScaledVector(new THREE.Vector3(...sunDir(v, sp.azimuth, sp.elevation, f)), r) });
    }
    return out;
  }, [siteKey, v.sunPath, r, ground.x, ground.z]); // eslint-disable-line react-hooks/exhaustive-deps
  const ring = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const a0 = new THREE.Vector3(...f.right);
    const b0 = new THREE.Vector3(...f.toward);
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(ground.clone().addScaledVector(a0, Math.cos(a) * r).addScaledVector(b0, Math.sin(a) * r).addScaledVector(up, 0.5));
    }
    return pts;
  }, [r, ground.x, ground.z, siteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lit = pos.elevation > 0 && !behind;
  return (
    <>
      <SunLight model={model} dir={dir} elevation={behind ? -5 : pos.elevation} />
      {/* catches the shadows on the ground around the base (a wall piece's wall catches its own) */}
      {!wall && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ground.x, 0.3, ground.z]} receiveShadow>
          <planeGeometry args={[r * 8, r * 8]} />
          <shadowMaterial transparent opacity={0.32} depthWrite={false} />
        </mesh>
      )}
      {!wall && v.shadowOn && v.sliceMode === 'parallel' && <ShadowScreen model={model} />}
      {paths && (
        <>
          <PathLine points={ring} color="#8a8478" opacity={0.6} />
          {['N', 'E', 'S', 'W'].map((n, i) => {
            const p = ground.clone().addScaledVector(new THREE.Vector3(...bearingDir(v, i * 90, f)), r * 1.06).addScaledVector(up, 1);
            return (
              <Html key={n} position={p} center zIndexRange={[2, 0]}>
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
              <Html center position={up.clone().multiplyScalar(r * 0.035)} zIndexRange={[2, 0]}>
                <span className="sun-hour">{clock(h).slice(0, 2)}</span>
              </Html>
            </group>
          ))}
        </>
      )}
      {lit && (
        <mesh position={ground.clone().addScaledVector(dir, r)}>
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
  const f = useMountFrame(v);
  const behind = pos.elevation > 0 && sunBehindWall(v, sunDir(v, pos.azimuth, pos.elevation, f), f);
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
        {pos.elevation > 0 ? `sun ${pos.elevation.toFixed(0)}° up, from the ${compassName(pos.azimuth)} (${pos.azimuth.toFixed(0)}°)${behind ? ', behind the wall' : ''}` : 'sun below the horizon'}
        {' · '}
        {times.rise !== null ? `rises ${clock(times.rise)}, sets ${clock(times.set!)}` : pos.elevation > 0 ? 'up all day' : 'down all day'}
      </div>
    </div>
  );
}
