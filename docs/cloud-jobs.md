# Cloud jobs (Boost)

Boost is an opt-in switch in **Settings**, off by default. With it off, Strata makes no
network request for cloud work and does everything in the browser. With it on, heavy jobs
run on Modal and the local build is always the fallback.

There are four jobs.

**Terrain**: a map at up to 2048 px, built on the server with the
same engine as the browser and the CLI (`buildMapBundle`), with the server fetching EA LiDAR,
Terrarium and Overpass itself. Tick **High resolution (cloud)** in the Map tab to use it.
Environment Agency maps are cut at 0.25 mm per cell on the model (Buttermere at 4 m, Neasden
at 1.8 m); Terrarium stays at 512 px because its data is 30 m. Saved projects keep a 1024 px
copy; the full grid is fetched again from the cloud cache by key.

**Pack**: the fabrication zip, made by running `cli export --zip` on the uploaded design, so
it is the same bytes as the CLI at the same commit (the date on the build pack is part of the
request). **Export (cloud)** in the toolbar uploads the design, waits, downloads the zip and
checks it against the design on screen (plates, parts, part DXFs, plate numbering) before the
download link shows. A zip that doesn't match is a red error with no link. In development and
e2e builds, `localStorage['strata.cloudFault'] = 'drop-plate'` asks for a zip with one plate
missing; only a worker run with `STRATA_ALLOW_FAULTS=1` honours it (never the deployed one).

**Nest**: the app's own nester (`src/core/nest.ts`) given 30 s (**Tight nest (cloud, 30 s)**
in the Cut sheets tab) or 90 s. The worker checks every part is placed once and keeps the
gap (`src/core/nestCheck.ts`); the app checks the parts' fingerprint matches its own before
saving the nest in the project (`project.nest`). It is used while the parts still match, so it
travels into saves, the zip and the CLI; **Use local nest** drops it.

**Hero**: a photograph-style picture of the finished piece, rendered with Blender Cycles on an
L4 GPU (Modal app `strata-hero`). **Hero render** in the toolbar opens a small window: it
renders the 3D view as it is on screen, at 1600 px on the long edge, in **Studio**,
**Daylight** or (for designs with candles) **Candlelight**. The price shows before it runs:
about $0.05 a render, never more than $0.09, because the GPU stops at 5 minutes. Ten renders
can start each day (UTC); the window says how many are left, and a render already in the cloud
cache is free and doesn't count. The worker builds the design's `model.glb` with the same engine
(`src/core/hero.ts`; `cli --glb` writes the same file), Blender renders it
(`worker/hero_render.py`), and the PNG comes back stamped with the plates, parts and fingerprint
it shows. The app refuses a render whose stamp doesn't match the design on screen (a red
error, nothing saved). A render that matches is saved in the project (`project.hero`) and goes
into the build pack (on the cover, and `hero.png` in the zip, from the app, the CLI and the
cloud pack alike) for as long as the design still matches it; after a change the window says it
is out of date and the pack leaves it out.

## How it fits together

```
browser (src/state/cloud.ts)
  └─ /api/geo/* on Vercel (api/geo.ts → api/_lib/geoApi.ts)   owner passphrase on every route
       ├─ private Blob store, render-cache/v1/<key>/asset.json.gz   (cache hit: no Modal call)
       └─ Modal app "strata-cloud" (worker/app.py), proxy auth token
            ├─ run_job: node job.mjs (worker/job.ts bundled with src/core) → writes the result to Blob
            └─ run_hero: node job.mjs --hero-dir (model.glb) → Modal app "strata-hero" (worker/hero.py,
                 L4, Blender via the bpy module, worker/hero_render.py) → node job.mjs --store (hero.png)
```

- `POST /api/geo/inputs/:sha?part=n&parts=N` stores one part of a design for a pack or nest job
  (gzip of the project file, base64 in JSON, 2.5 MB a part, up to 16 parts). `POST jobs`
  answers 409 `needs-input` until every part is there.
- `POST /api/geo/jobs` starts a job, `GET /api/geo/jobs/:id` is polled every second,
  `POST /api/geo/jobs/:id/cancel` stops it, `GET /api/geo/artifacts/:key?part=n` downloads the
  result in parts under Vercel's 4.5 MB response limit (`artifacts/:key/pack.zip`,
  `artifacts/:key/nest.json.gz` and `artifacts/:key/hero.png` for the other jobs), `GET /api/geo/health` and `/usage`.
- A job's key is SHA-256 over the engine build and the request (`api/_lib/geoJob.ts`). The
  worker refuses a job from an app with a different engine build ("worker out of date").
- `POST jobs` answers 429 with reason `limit` once ten hero renders have started that day.
- Status bar **Cloud** field: `off`, `checking…`, `locked` (no or wrong owner passphrase),
  `ready`, `working n%`, `resting: reason` (not set up, offline, worker out of date, job failed).

## Setting it up

Server-only environment variables (never `VITE_`-prefixed, never logged):

| Name | Where | What |
| --- | --- | --- |
| `STRATA_OWNER_TOKEN` | Vercel | already set for cloud projects |
| `MODAL_GEO_URL` | Vercel | the URL `modal deploy` prints for `api` (`https://…--strata-cloud-api.modal.run`) |
| `MODAL_KEY`, `MODAL_SECRET` | Vercel | a Modal proxy auth token (Modal dashboard → Settings → Proxy Auth Tokens) |
| `RENDER_CACHE_READ_WRITE_TOKEN` | Vercel and the Modal secret `strata-cloud` | private Blob store `strata-render-cache` (falls back to `BLOB_READ_WRITE_TOKEN`) |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | GitHub repository secrets (optional) | lets `.github/workflows/cloud-worker.yml` redeploy the worker when the engine changes |

Deploy the worker from a Mac with Modal logged in:

```
cd ~/Projects/strata && git checkout claude/strata-app && git pull && npm install && npx tsx worker/build.ts && python3 -m venv .venv-modal && .venv-modal/bin/pip install -q modal==1.6.2 && .venv-modal/bin/modal deploy worker/hero.py && .venv-modal/bin/modal deploy worker/app.py
```

`strata-hero` needs no secret and no engine bundle (the engine side of a render runs in
`strata-cloud`), so it only really changes when `worker/hero.py` or `worker/hero_render.py` does;
redeploying it unchanged is quick. The first deploy builds the Blender image (a few minutes,
once).

## Measuring

`npx tsx scripts/bench-cloud-terrain.ts` builds Buttermere and Neasden at 1024 and 2048 px
(EA grid sizes, Terrarium heights) and prints grid, cell size, build time, result size, saved
project size and slice time at 93 plates. Tests: `test/geo-api.test.ts`, `test/cloud-terrain.test.ts`.

`npx tsx scripts/bench-nest.ts [--budget 30]` compares the old bounding-box nest, the
outline nest the app runs and the cloud's budgeted nest. Tests: `test/nest-outline.test.ts`,
`test/cloud-pack-nest.test.ts`, the cloud-nest case in `test/sheet-dxf-cut.test.ts`, and the
pack cases in `e2e/boost.spec.ts`.

Hero renders: `npx tsx src/cli.ts <project> --zip /tmp/p.zip --glb model.glb` writes the model,
and `python worker/hero_render.py model.glb hero.png settings.json` (with `pip install bpy==5.2.2`)
renders it on this computer's CPU, for trying the lighting. Tests: `test/hero.test.ts` and the
hero cases in `e2e/boost.spec.ts`.

Cost: one 2-core container is about $0.000035 a second, so a terrain job is well under a cent,
a 30 s nest about $0.001 and a pack about $0.0003. A hero render is billed at the L4 rate
(about $0.00031 a second with its 4 cores and 16 GB), from the moment it is asked for, start-up
included. Each finished job reports its seconds and cost, shown next to its result.
