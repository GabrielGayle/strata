import { useEffect, useRef } from 'react';
import type { MapSpec } from '../core/mapSpec';

const OSM_TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© OpenStreetMap contributors';

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function pickZoom(bbox: MapSpec['bbox']): number {
  const [w, s, e, n] = bbox;
  const span = Math.max(Math.abs(e - w), Math.abs(n - s));
  if (span > 0.5) return 10;
  if (span > 0.1) return 12;
  if (span > 0.02) return 14;
  return 15;
}

export default function MapPreviewPane({ bbox, title }: { bbox: MapSpec['bbox'] | undefined; title?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !bbox) return;

    const paint = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(120, Math.floor(rect.height));
      if (w < 8 || h < 8) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#1a2332';
      ctx.fillRect(0, 0, w, h);

      const [west, south, east, north] = bbox;
      const z = pickZoom(bbox);
      const x0 = lonToTileX(west, z);
      const x1 = lonToTileX(east, z);
      const y0 = latToTileY(north, z);
      const y1 = latToTileY(south, z);
      const tiles: { x: number; y: number; img: HTMLImageElement }[] = [];
      let pending = 0;
      let drawn = false;

      const finish = () => {
        if (drawn || pending > 0) return;
        drawn = true;
        ctx.fillStyle = '#1a2332';
        ctx.fillRect(0, 0, w, h);
        const n = 2 ** z;
        for (const t of tiles) {
          const lonW = (t.x / n) * 360 - 180;
          const lonE = ((t.x + 1) / n) * 360 - 180;
          const latN = (Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))) * 180) / Math.PI;
          const latS = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / n))) * 180) / Math.PI;
          const px0 = ((lonW - west) / (east - west)) * w;
          const px1 = ((lonE - west) / (east - west)) * w;
          const py0 = ((north - latN) / (north - south)) * h;
          const py1 = ((north - latS) / (north - south)) * h;
          ctx.drawImage(t.img, px0, py0, px1 - px0, py1 - py0);
        }
        ctx.strokeStyle = 'rgba(255,200,80,0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
        if (title) {
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(4, h - 22, Math.min(w - 8, ctx.measureText(title).width + 12), 18);
          ctx.fillStyle = '#fff';
          ctx.font = '11px sans-serif';
          ctx.fillText(title, 8, h - 8);
        }
      };

      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          pending += 1;
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            tiles.push({ x, y, img });
            pending -= 1;
            finish();
          };
          img.onerror = () => {
            pending -= 1;
            finish();
          };
          img.src = OSM_TILE.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        }
      }
      finish();
    };

    paint();
    const ro = new ResizeObserver(() => paint());
    ro.observe(host);
    const vis = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) paint();
    });
    vis.observe(host);
    return () => {
      ro.disconnect();
      vis.disconnect();
    };
  }, [bbox, title]);

  return (
    <div className="map-preview-pane" ref={hostRef} aria-label="Map preview">
      {bbox ? (
        <>
          <canvas ref={canvasRef} className="map-preview-canvas" />
          <a className="map-preview-attrib" href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">
            {OSM_ATTR}
          </a>
        </>
      ) : (
        <p className="map-preview-empty">Set a bbox to preview the map extent.</p>
      )}
    </div>
  );
}
