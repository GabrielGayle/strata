// The shadow kitchen: pictures and the times they appear, a live view of the
// wall through the day, and how well each frame comes out of the carved plates.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { renderWall, type ShadowFrame } from '../core/shadow';
import { clock, siteOf, sunTimes } from '../core/sun';
import { SunBar } from './SunStudy';

/** Read a picture file, shrunk so the longest side is at most `max` px (keeps the project small). */
function readPicture(file: File, max = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Not an image'));
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });
}

const toHHMM = (h: number) => clock(h);
const fromHHMM = (s: string) => {
  const [a, b] = s.split(':').map(Number);
  return Number.isFinite(a) ? a + (Number.isFinite(b) ? b : 0) / 60 : NaN;
};

/** The wall at the current time: sunlit where light gets through. */
function WallCanvas() {
  const model = useModel();
  const rep = model.shadow;
  const time = useStore((s) => s.ui.sunTime);
  const ref = useRef<HTMLCanvasElement>(null);
  const margin = rep ? Math.round(Math.max(rep.geom.cols, rep.geom.rows) * 0.15) : 0;
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !rep) return;
    const { lit, cols, rows, up } = renderWall(model.v, rep, time, margin);
    cv.width = cols;
    cv.height = rows;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = lit[r * cols + c];
        const k = ((rows - 1 - r) * cols + c) * 4; // row 0 is the bottom of the screen
        // sunlit, shadow, or not screen at all (inside the concrete or a plate), hatched
        const [cr, cg, cb] = x === 2 ? ((r + c) % 4 < 2 ? [120, 116, 108] : [104, 100, 94]) : up && x === 1 ? [250, 236, 205] : [70, 66, 62];
        img.data[k] = cr;
        img.data[k + 1] = cg;
        img.data[k + 2] = cb;
        img.data[k + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // the picture rectangle (one per frame side by side)
    ctx.strokeStyle = 'rgba(224,112,28,0.8)';
    ctx.lineWidth = 1;
    for (const sl of rep.geom.slots ?? [{ c0: 0, cols: rep.geom.cols }]) ctx.strokeRect(margin + sl.c0 + 0.5, margin + 0.5, sl.cols - 1, rep.geom.rows - 1);
  }, [rep, time, margin, model.v]);
  if (!rep) return null;
  return <canvas ref={ref} className="shadow-wall" aria-label="The screen behind the piece at this time" />;
}

export default function ShadowView() {
  const model = useModel();
  const v = model.v;
  const frames = useStore((s) => s.project.shadow?.frames) ?? [];
  const setShadow = useStore((s) => s.setShadow);
  const setParams = useStore((s) => s.setParams);
  const setUi = useStore((s) => s.setUi);
  const time = useStore((s) => s.ui.sunTime);
  const rep = model.shadow;
  const site = siteOf(v);
  const noon = useMemo(() => sunTimes(site).noon, [site.lat, site.lon, site.utc, site.month, site.day]); // eslint-disable-line react-hooks/exhaustive-deps
  const fileRef = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const save = (next: ShadowFrame[], key?: string) => setShadow({ frames: next }, key);
  const patch = (id: string, p: Partial<ShadowFrame>, key?: string) => save(frames.map((f) => (f.id === id ? { ...f, ...p } : f)), key);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= frames.length) return;
    const next = [...frames];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const urls = await Promise.all(list.map((f) => readPicture(f).catch(() => null)));
    const step = 0.5;
    const start = frames.length ? frames[frames.length - 1].time + step : noon - ((list.length - 1) / 2) * step;
    const added: ShadowFrame[] = [];
    urls.forEach((u, k) => {
      if (u) added.push({ id: `f${Date.now().toString(36)}${k}`, name: list[k].name.replace(/\.[^.]+$/, ''), dataUrl: u, time: Math.min(23.9, Math.max(0.1, start + k * step)), hold: 2 });
    });
    setFailed(list.filter((_, k) => !urls[k]).map((f) => f.name));
    if (added.length) save([...frames, ...added]);
    if (fileRef.current) fileRef.current.value = '';
  };
  const spread = () => {
    const step = 0.5;
    save(frames.map((f, i) => ({ ...f, time: noon + (i - (frames.length - 1) / 2) * step })));
  };

  const needs = !v.sunOn ? 'sun' : !v.shadowOn ? 'shadow' : v.sliceMode !== 'parallel' ? 'parallel' : null;
  const allDay = v.shadowExec === 'allday';
  const allSide = v.shadowExec === 'side' && frames.length > 1;
  return (
    <div className="scroll shadow-view">
      <div className="panel-title">
        <span>Shadow pictures</span>
        <span className="mono" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {rep
            ? `${rep.cut} of ${rep.plates} plates cut · ${fmt(rep.removed * 100, 0)}% of the carvable steel cut away${rep.bridged ? ` · ${rep.bridged} loose bits held by bridges` : ''}${rep.islands - rep.bridged ? ` · ${rep.islands - rep.bridged} cut away` : ''} · ${fmt(rep.ms, 0)} ms`
            : ''}
        </span>
      </div>
      {needs && (
        <div className="note warn shadow-needs">
          {needs === 'sun' && (
            <>
              The pictures are carved for the real sun, so Sun study needs to be on (set the place, date and which way the piece faces in the Sun panel).{' '}
              <button className="btn sm" onClick={() => setParams({ sunOn: true }, 'Sun study on')}>
                Turn on Sun study
              </button>
            </>
          )}
          {needs === 'shadow' && (
            <>
              Shadow pictures are off.{' '}
              <button className="btn sm" onClick={() => setParams({ shadowOn: true }, 'Shadow pictures on')}>
                Turn on Shadow pictures
              </button>
            </>
          )}
          {needs === 'parallel' && <>Shadow pictures work with parallel plates for now. Set Slicer › Slicing to parallel.</>}
        </div>
      )}
      {rep && !needs && rep.cut > 0 && rep.cut < rep.plates / 3 && (
        <div className="note shadow-needs">
          Only the {rep.cut} plate{rep.cut === 1 ? '' : 's'} nearest the screen {rep.cut === 1 ? 'is' : 'are'} cut: the sun is high enough that its light drops through the back of the stack before it reaches the screen. A lower sun (winter months, or morning and evening times) uses more of the plates and makes each frame show for a shorter time.
        </div>
      )}
      {failed.length > 0 && (
        <div className="note warn shadow-needs">
          Couldn't read {failed.join(', ')}. Use PNG, JPEG, GIF or WebP (iPhone HEIC photos need converting first).{' '}
          <button className="btn sm" onClick={() => setFailed([])}>
            OK
          </button>
        </div>
      )}
      <div className="shadow-grid">
        <section className="shadow-frames">
          <div className="sf-head">
            <strong>{allDay ? 'Picture (all day)' : 'Frames'}</strong>
            <span className="sf-actions">
              <button className="btn sm" onClick={() => fileRef.current?.click()}>
                Add pictures
              </button>
              {!allDay && frames.length > 1 && (
                <button className="btn sm" onClick={spread} title="Half an hour apart, centred on solar noon">
                  Space round noon
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />
            </span>
          </div>
          {!frames.length && (
            <p className="note">
              Add one picture, or a numbered sequence (stills from a video work well). Bright parts become light on the wall. Each frame gets a time of day; the plates are carved so the sun casts it at that time.
            </p>
          )}
          {frames.map((f, i) => {
            const sc = rep?.scores[allDay ? 0 : i];
            const inactive = allDay && i > 0;
            return (
              <div key={f.id} className={`sf-row ${inactive ? 'inactive' : ''} ${!allDay && Math.abs(time - f.time) < 1 / 60 ? 'now' : ''}`}>
                <img src={f.dataUrl} alt="" className="sf-thumb" />
                <div className="sf-main">
                  <input className="sf-name" value={f.name} onChange={(e) => patch(f.id, { name: e.target.value }, `shadow:name:${f.id}`)} aria-label="Frame name" />
                  {!allDay && (
                    <div className="sf-times">
                      <label>
                        at <input type="time" value={toHHMM(f.time)} onChange={(e) => Number.isFinite(fromHHMM(e.target.value)) && patch(f.id, { time: fromHHMM(e.target.value) }, `shadow:time:${f.id}`)} />
                      </label>
                      <label title="Minutes it stays sharp, centred on its time. Longer holds are softer and leave more stray light.">
                        hold <input type="number" min={0} max={120} step={1} value={f.hold} onChange={(e) => patch(f.id, { hold: Math.max(0, Number(e.target.value) || 0) }, `shadow:hold:${f.id}`)} /> min
                      </label>
                    </div>
                  )}
                  <div className="sf-score">
                    {inactive
                      ? 'Not used: All day carves the first picture only'
                      : sc?.problem
                        ? <span className="err">{sc.problem}</span>
                        : sc
                          ? <>
                              <span className={sc.match >= 0.75 ? 'ok' : sc.match >= 0.5 ? 'warn' : 'err'}>{fmt(sc.match * 100, 0)}% match · {fmt(sc.stray * 100, 0)}% stray light</span>
                              {sc.hint && <span className="warn sf-hint">{sc.hint}</span>}
                            </>
                          : needs ? '' : 'Carving…'}
                  </div>
                </div>
                <div className="sf-btns">
                  {!allDay && (
                    <button className="btn sm" onClick={() => setUi({ sunTime: f.time, sunPlaying: false })} title="Show the wall at this frame's time">
                      Go
                    </button>
                  )}
                  <button className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </button>
                  <button className="btn sm" onClick={() => move(i, 1)} disabled={i === frames.length - 1} aria-label="Move down">
                    ↓
                  </button>
                  <button className="btn sm" onClick={() => save(frames.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </section>
        <section className="shadow-preview">
          <div className="sp-wall">
            {rep ? <WallCanvas /> : <div className="empty">{needs ? 'Nothing carved yet.' : frames.length ? 'Carving…' : 'Add a picture to start.'}</div>}
            {v.sunOn && <SunBar model={model} />}
          </div>
          <p className="note">
            {v.shadowScreen === 'ground' || v.shadowScreen === 'base' ? (
              <>
                The {v.shadowScreen === 'ground' ? 'ground' : 'top of the concrete'} behind the piece, seen from above with the front of the piece at the bottom. The picture starts {fmt(v.shadowGap, 0)} mm
                behind the back plate. Hatching is not screen (inside the concrete or a plate).
              </>
            ) : (
              <>
                The wall {fmt(v.shadowGap, 0)} mm behind the back plate, seen from the front of the piece, with the picture's bottom {fmt(v.shadowY, 0)} mm up.
              </>
            )}{' '}
            The orange box{allSide ? 'es are' : ' is'} the picture area ({fmt(v.shadowW, 0)} × {fmt(v.shadowH, 0)} mm{allSide ? ' each, placed where each frame\'s light comes straight through the plates' : ''}). Warm light is sun and dark is shadow. The carved
            plates are live in the 3D view, where the screen catches the real shadow.
          </p>
        </section>
      </div>
    </div>
  );
}
