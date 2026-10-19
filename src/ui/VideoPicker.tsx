// Pull stills out of a video for the shadow kitchen: pick the stretch of the
// clip and how many frames, see them, then add them as shadow frames.
import { useEffect, useRef, useState } from 'react';
import { BusyNote } from './BusyWindow';

export interface Still {
  name: string;
  dataUrl: string;
}

/** Seek and grab one still, shrunk so the longest side is at most `max` px. */
function grab(video: HTMLVideoElement, t: number, max = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      const k = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * k));
      c.height = Math.max(1, Math.round(video.videoHeight * k));
      try {
        c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    };
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.01));
  });
}

/** Evenly spaced times from `a` to `b`, both ends included. */
export function stillTimes(a: number, b: number, n: number): number[] {
  if (n <= 1) return [(a + b) / 2];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

const secs = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

export default function VideoPicker({ file, onAdd, onClose }: { file: File; onAdd: (stills: Still[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [url] = useState(() => URL.createObjectURL(file));
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [count, setCount] = useState(8);
  const [stills, setStills] = useState<Still[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // grab the stills again whenever the stretch or count settles
  useEffect(() => {
    const video = ref.current;
    if (!video || !duration) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      const out: Still[] = [];
      const base = file.name.replace(/\.[^.]+$/, '');
      try {
        for (const [i, t] of stillTimes(range[0], range[1], count).entries()) {
          if (!alive) return;
          out.push({ name: `${base} ${String(i + 1).padStart(2, '0')}`, dataUrl: await grab(video, t) });
        }
        if (alive) setStills(out);
      } catch {
        if (alive) setError("Couldn't read frames from this video.");
      } finally {
        if (alive) setBusy(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [duration, range, count, file.name]);

  const [a, b] = range;
  return (
    <div className="window video-picker" role="dialog" aria-label="Stills from a video">
      <div className="title-bar vp-head">
        <div className="title-bar-text">Stills from {file.name}</div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={onClose}></button>
        </div>
      </div>
      <div className="window-body">
      <video
        ref={ref}
        src={url}
        muted
        playsInline
        preload="auto"
        className="vp-video"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (!Number.isFinite(d) || d <= 0) return setError("This browser can't tell how long the video is.");
          setDuration(d);
          setRange([0, d]);
        }}
        onError={() => setError("This browser can't play that video. Try an MP4 (H.264) or WebM file.")}
      />
      {error ? (
        <p className="note warn">{error}</p>
      ) : duration ? (
        <>
          <div className="vp-controls">
            <label>
              From <input type="range" min={0} max={duration} step={0.05} value={a} onChange={(e) => setRange([Math.min(Number(e.target.value), b), b])} aria-label="Start of the stretch" />{' '}
              <span className="mono">{secs(a)}</span>
            </label>
            <label>
              to <input type="range" min={0} max={duration} step={0.05} value={b} onChange={(e) => setRange([a, Math.max(Number(e.target.value), a)])} aria-label="End of the stretch" />{' '}
              <span className="mono">{secs(b)}</span>
            </label>
            <label>
              Stills <input type="number" min={1} max={24} value={count} onChange={(e) => setCount(Math.min(24, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
            </label>
          </div>
          <div className="vp-stills">
            {stills.map((s) => (
              <img key={s.name} src={s.dataUrl} alt={s.name} title={s.name} />
            ))}
            {busy && (
              <span className="note">
                <BusyNote>Reading frames…</BusyNote>
              </span>
            )}
          </div>
          <p className="note">6 to 8 frames read best in place; side by side takes more. Each still becomes a frame half an hour after the one before, which you can retime after.</p>
          <div className="vp-actions">
            <button className="btn" disabled={busy || !stills.length} onClick={() => onAdd(stills)}>
              Add {stills.length} frame{stills.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : (
        <p className="note">
          <BusyNote>Opening the video…</BusyNote>
        </p>
      )}
      </div>
    </div>
  );
}
