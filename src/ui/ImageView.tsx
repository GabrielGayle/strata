import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import type { Gray } from '../core/image';
import { sampleCliff } from './sample';

function GrayCanvas({ g }: { g: Gray | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !g) return;
    cv.width = g.w;
    cv.height = g.h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(g.w, g.h);
    for (let i = 0; i < g.w * g.h; i++) {
      const c = g.data[i] * 255;
      img.data[i * 4] = c;
      img.data[i * 4 + 1] = c;
      img.data[i * 4 + 2] = c;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [g]);
  if (!g) return <div className="empty" style={{ padding: 30 }}>No image</div>;
  return <canvas ref={ref} className="thumb" style={{ aspectRatio: `${g.w} / ${g.h}` }} />;
}

async function readImage(): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      // downscale big photos before storing them in the project file
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 640 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k);
        cv.height = Math.round(img.height * k);
        cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve({ name: f.name, dataUrl: cv.toDataURL('image/jpeg', 0.88) });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    };
    inp.click();
  });
}

function ProfilePlot() {
  const model = useModel();
  const parts = model.sliced.parts.filter((p) => p.family === 'P');
  if (!parts.length) return null;
  const minX = Math.min(...parts.map((p) => p.bbox.minX));
  const maxX = Math.max(...parts.map((p) => p.bbox.maxX));
  const maxY = Math.max(...parts.map((p) => p.bbox.maxY));
  const W = maxX - minX;
  return (
    <svg viewBox={`${minX - W * 0.02} ${-maxY * 1.05} ${W * 1.04} ${maxY * 1.1}`} style={{ width: '100%', height: 160, display: 'block', background: 'var(--panel)' }} preserveAspectRatio="none">
      {parts.map((p, i) => {
        const outer = p.shape[0].outer.filter((q) => q[1] > 0.5);
        const d = outer.map((q, k) => `${k ? 'L' : 'M'}${q[0].toFixed(1)},${(-q[1]).toFixed(1)}`).join('');
        return <path key={p.id} d={d} fill="none" stroke={`color-mix(in srgb, var(--accent) ${20 + (60 * i) / parts.length}%, var(--ink))`} strokeWidth={W / 600} opacity={0.6} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

export default function ImageView() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const setAsset = useStore((s) => s.setAsset);
  const setParams = useStore((s) => s.setParams);
  const setUi = useStore((s) => s.setUi);
  const v = model.v;
  const slots: { slot: 'side' | 'front'; title: string; g: Gray | null; desc: string; enable: Record<string, string> }[] = [
    {
      slot: 'side',
      title: 'Side profile image',
      g: model.sideImg,
      desc: 'Each plate takes one strip of this image as its top-edge height (or the traced silhouette), mixed with the eroded strata.',
      enable: { imgSideMode: 'heightmap', stackSource: 'strata' },
    },
    {
      slot: 'front',
      title: 'Front view image',
      g: model.frontImg,
      desc: 'Spread across the stack: layered cut-outs get deeper where the image is dark, or halftone holes grow, with etched lines lining up plate to plate.',
      enable: { imgFrontMode: 'layers', sliceMode: 'parallel' },
    },
  ];
  return (
    <div className="scroll">
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        <div className="grid2">
          {slots.map((s) => {
            const asset = project.images[s.slot];
            return (
              <div className="box" key={s.slot}>
                <div className="box-head">
                  <span>{s.title}</span>
                  <span className="mono" style={{ fontWeight: 400, textTransform: 'none' }}>
                    {asset ? asset.name : 'empty'}
                  </span>
                </div>
                <GrayCanvas g={s.g} />
                <div className="note">{s.desc}</div>
                <div className="btnrow">
                  <button
                    className="btn"
                    onClick={async () => {
                      const img = await readImage();
                      if (!img) return;
                      setAsset('image', s.slot, img);
                      setParams(s.enable, `img-${s.slot}`);
                    }}
                  >
                    Load image…
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setAsset('image', s.slot, { name: 'sample-cliff.png', dataUrl: sampleCliff(Math.round(v.seed)) });
                      setParams(s.enable, `img-${s.slot}`);
                    }}
                  >
                    Use sample cliff
                  </button>
                  {asset && (
                    <button className="btn" onClick={() => setAsset('image', s.slot, null)}>
                      Remove
                    </button>
                  )}
                  <button className="btn" onClick={() => setUi({ tab: '3d', snap: { dir: s.slot === 'side' ? 'side' : 'front', n: Date.now() } })}>
                    Snap 3D to {s.slot === 'side' ? 'side' : 'front'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="box">
          <div className="box-head">
            <span>Plate top edges, overlaid (profile)</span>
            <span className="mono" style={{ fontWeight: 400, textTransform: 'none' }}>
              side: {v.imgSideMode} · mix {fmt(v.imgMix, 2)} · front: {v.imgFrontMode} · etch: {v.etchMode}
            </span>
          </div>
          <ProfilePlot />
          <div className="note">
            Controls live under Parameters › Image: contrast, smoothing, direction, the strata ↔ image mix, front strength and how many plates carry the image. Every image-derived edge still goes
            through the same arc fitting, minimum-feature, kerf and fit checks.
            {model.sliced.front && ` Front image window: ${fmt(model.sliced.front.u1 - model.sliced.front.u0, 0)} × ${fmt(model.sliced.front.v1 - model.sliced.front.v0, 0)} mm on each plate.`}
          </div>
        </div>
      </div>
    </div>
  );
}
