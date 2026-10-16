#!/usr/bin/env node
/** One-off: fetch terrarium tiles for Neasden bbox and a single known tile. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'map');

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

async function fetchTile(z, x, y) {
  const url = `${BASE}/${z}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const neasden = { w: -0.28, s: 51.543, e: -0.233, n: 51.575 };
const z = 13;
const tl = lonLatToTile(neasden.w, neasden.n, z);
const br = lonLatToTile(neasden.e, neasden.s, z);
const manifest = { kind: 'neasden-terrarium', z, bbox: [neasden.w, neasden.s, neasden.e, neasden.n], tiles: [] };
mkdirSync(join(root, 'neasden', String(z)), { recursive: true });

for (let x = tl.x; x <= br.x; x++) {
  for (let y = tl.y; y <= br.y; y++) {
    const buf = await fetchTile(z, x, y);
    const rel = `neasden/${z}/${x}_${y}.png`;
    writeFileSync(join(root, rel), buf);
    manifest.tiles.push({ x, y, file: rel, bytes: buf.length });
    process.stderr.write(`wrote ${rel} ${buf.length}\n`);
  }
}
writeFileSync(join(root, 'neasden-manifest.json'), JSON.stringify(manifest, null, 2));

// Single tile for decode AT (London area, z=15)
const z15 = 15;
const tx = 16384;
const ty = 10889;
const single = await fetchTile(z15, tx, ty);
mkdirSync(join(root, 'decode'), { recursive: true });
writeFileSync(join(root, 'decode', `${z15}_${tx}_${ty}.png`), single);
writeFileSync(
  join(root, 'decode-manifest.json'),
  JSON.stringify({ z: z15, x: tx, y: ty, file: `decode/${z15}_${tx}_${ty}.png`, bytes: single.length }, null, 2),
);
