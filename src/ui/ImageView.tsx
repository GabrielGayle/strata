import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import type { Gray } from '../core/image';
import { planeToWorld } from '../core/section';
import { topAt } from '../core/slicer';
import type { Snap } from '../state/store';
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
  return <canvas ref={ref} className="thumb" style={{ aspectRatio: `${g.w} / ${g.h}`, maxHeight: 260, objectFit: 'contain' }} />;
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
        const ctx = cv.getContext('2d')!;
        ctx.fillStyle = '#fff'; // transparent PNGs read as white background
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve({ name: f.name, dataUrl: cv.toDataURL('image/jpeg', 0.9) });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    };
    inp.click();
  });
}

/** What you see looking straight down: every plate's top edge, shaded by height. */
function TopPreview() {
  const model = useModel();
  const ref = useRef<HTMLCanvasElement>(null);
  const parts = model.sliced.parts;
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !parts.length) return;
    const samples: { x: number; z: number; h: number; dx: number; dz: number }[] = [];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, h0 = Infinity, h1 = -Infinity;
    for (const p of parts) {
      const step = 1.5;
      for (let u = p.bbox.minX; u <= p.bbox.maxX; u += step) {
        const t = topAt(p.shape, u);
        if (t === null || t <= 0) continue;
        const w = planeToWorld(p.plane, u, 0);
        samples.push({ x: w[0], z: w[2], h: t, dx: p.plane.u[0], dz: p.plane.u[2] });
        x0 = Math.min(x0, w[0]);
        x1 = Math.max(x1, w[0]);
        z0 = Math.min(z0, w[2]);
        z1 = Math.max(z1, w[2]);
        h0 = Math.min(h0, t);
        h1 = Math.max(h1, t);
      }
    }
    if (!samples.length) return;
    const pad = 10;
    const W = cv.clientWidth || 600;
    const k = (W - 2 * pad) / Math.max(1, x1 - x0);
    const H = Math.round((z1 - z0) * k + 2 * pad);
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel-2') || '#eee';
    ctx.fillRect(0, 0, W, H);
    // draw each plate as wide as its pitch so the picture reads as one surface
    const t = (model.v.sliceMode === 'radial' ? model.v.thickness : Math.max(model.v.thickness, model.v.pitch * 0.92)) * k;
    for (const s of samples) {
      const g = Math.round(40 + 200 * ((s.h - h0) / Math.max(1e-6, h1 - h0)));
      ctx.fillStyle = `rgb(${g},${Math.round(g * 0.82)},${Math.round(g * 0.7)})`;
      const px = pad + (s.x - x0) * k, pz = pad + (s.z - z0) * k;
      // a short dash along the plate, one sheet thick
      const len = 1.6 * k;
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(Math.atan2(s.dz, s.dx));
      ctx.fillRect(-len / 2, -Math.max(0.8, t) / 2, len, Math.max(0.8, t));
      ctx.restore();
    }
  }, [parts, model.v.thickness, model.v.pitch, model.v.sliceMode]);
  return <canvas ref={ref} style={{ width: '100%', display: 'block', borderBottom: '1px solid var(--line)' }} />;
}

type Slot = 'top' | 'side' | 'front';

export default function ImageView() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const setAsset = useStore((s) => s.setAsset);
  const setParams = useStore((s) => s.setParams);
  const setUi = useStore((s) => s.setUi);
  const ui = useStore((s) => s.ui);
  const v = model.v;
  const slots: { slot: Slot; title: string; g: Gray | null; desc: string; enable: Record<string, string>; off: Record<string, string>; snap: Snap }[] = [
    {
      slot: 'top',
      title: 'Top surface image',
      g: model.topImg,
      desc: "Looking down on the stack: each plate's top edge is cut down where its strip of the image is dark, so the image reads as an impression across the whole top surface.",
      enable: { imgTopMode: 'carve' },
      off: { imgTopMode: 'off' },
      snap: 'top',
    },
    {
      slot: 'front',
      title: 'Front face image',
      g: model.frontImg,
      desc: 'On the end face of the stack: layered cut-outs get deeper where the image is dark (or halftone holes grow), with etched lines lining up plate to plate.',
      enable: { imgFrontMode: 'layers', sliceMode: 'parallel' },
      off: { imgFrontMode: 'off' },
      snap: 'front',
    },
    {
      slot: 'side',
      title: 'Side profile image',
      g: model.sideImg,
      desc: 'Each plate takes one strip of this image as its overall top-edge height (or the traced silhouette), blended with the eroded strata.',
      enable: { imgSideMode: 'heightmap', stackSource: 'strata' },
      off: { imgSideMode: 'off' },
      snap: 'side',
    },
  ];
  const open = (patch: Record<string, string>) => {
    setParams(patch, 'img');
    setUi({ collapsed: { ...ui.collapsed, Image: false } });
  };
  const topRes = v.sliceMode === 'radial' ? null : v.pitch;
  return (
    <div className="scroll">
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {slots.map((s) => {
            const asset = project.images[s.slot];
            const other = s.slot === 'top' ? project.images.front ?? project.images.side : null;
            return (
              <div className="box" key={s.slot}>
                <div className="box-head">
                  <span>{s.title}</span>
                  <span className="mono" style={{ fontWeight: 400, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
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
                      open(s.enable);
                    }}
                  >
                    Load image…
                  </button>
                  {other && !asset && (
                    <button
                      className="btn primary"
                      onClick={() => {
                        setAsset('image', 'top', other);
                        open(s.enable);
                      }}
                    >
                      Use {project.images.front ? 'front' : 'side'} image
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      setAsset('image', s.slot, { name: 'sample-cliff.png', dataUrl: sampleCliff(Math.round(v.seed)) });
                      open(s.enable);
                    }}
                  >
                    Sample
                  </button>
                  {asset && (
                    <button
                      className="btn"
                      onClick={() => {
                        setAsset('image', s.slot, null);
                        setParams(s.off, 'img-off');
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <button className="btn" onClick={() => setUi({ tab: '3d', snap: { dir: s.snap, n: Date.now() } })}>
                    View {s.snap}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="box">
          <div className="box-head">
            <span>Top view of the plate tops</span>
            <span className="mono" style={{ fontWeight: 400, textTransform: 'none' }}>
              darker = lower · top: {v.imgTopMode} · front: {v.imgFrontMode} · side: {v.imgSideMode}
            </span>
          </div>
          <TopPreview />
          <div className="note">
            {v.imgTopMode !== 'off' && model.topImg ? (
              <>
                Top impression: {v.imgTopMode === 'carve' ? 'dark areas sink' : 'dark areas stand proud'} up to {fmt(v.topDepth, 0)} mm in {v.topSteps > 0 ? `${v.topSteps} steps` : 'a smooth slope'}.
                Resolution is one plate per image row{topRes ? ` (${fmt(topRes, 1)} mm pitch)` : ''} by {fmt(Math.min(1, v.sampleStep), 1)} mm along each plate: more, thinner plates give a sharper picture.
                Size, position, depth and threshold are under Parameters › Image.
                {v.stackSource === 'strata' && v.erosionAmp > v.topDepth && (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}
                    Erosion ({fmt(v.erosionAmp, 0)} mm) is stronger than the impression ({fmt(v.topDepth, 0)} mm): lower Strata › Erosion amplitude or deepen the impression if the picture gets lost.
                  </span>
                )}
              </>
            ) : (
              <>Load an image into the top surface slot to press it into the plate tops. Every image-derived edge still goes through the same arc fitting, minimum-feature, kerf and fit checks.</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
