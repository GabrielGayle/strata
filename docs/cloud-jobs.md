# Cloud jobs (Boost)

Boost is an opt-in switch in **Settings**, off by default. With it off, Strata makes no
network request for cloud work and does everything in the browser. With it on, heavy jobs
run on Modal and the local build is always the fallback.

There are three jobs.

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

## How it fits together

```
browser (src/state/cloud.ts)
  └─ /api/geo/* on Vercel (api/geo.ts → api/_lib/geoApi.ts)   owner passphrase on every route
       ├─ private Blob store, render-cache/v1/<key>/asset.json.gz   (cache hit: no Modal call)
       └─ Modal app "strata-cloud" (worker/app.py), proxy auth token
            └─ run_job: node job.mjs (worker/job.ts bundled with src/core) → writes the result to Blob
```

- `POST /api/geo/inputs/:sha?part=n&parts=N` stores one part of a design for a pack or nest job
  (gzip of the project file, base64 in JSON, 2.5 MB a part, up to 16 parts). `POST jobs`
  answers 409 `needs-input` until every part is there.
- `POST /api/geo/jobs` starts a job, `GET /api/geo/jobs/:id` is polled every second,
  `POST /api/geo/jobs/:id/cancel` stops it, `GET /api/geo/artifacts/:key?part=n` downloads the
  result in parts under Vercel's 4.5 MB response limit (`artifacts/:key/pack.zip` and
  `artifacts/:key/nest.json.gz` for the other jobs), `GET /api/geo/health` and `/usage`.
- A job's key is SHA-256 over the engine build and the request (`api/_lib/geoJob.ts`). The
  worker refuses a job from an app with a different engine build ("worker out of date").
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
cd ~/Projects/strata && git checkout claude/strata-app && git pull && npm install && npx tsx worker/build.ts && python3 -m venv .venv-modal && .venv-modal/bin/pip install -q modal==1.6.2 && .venv-modal/bin/modal deploy worker/app.py
```

## Measuring

`npx tsx scripts/bench-cloud-terrain.ts` builds Buttermere and Neasden at 1024 and 2048 px
(EA grid sizes, Terrarium heights) and prints grid, cell size, build time, result size, saved
project size and slice time at 93 plates. Tests: `test/geo-api.test.ts`, `test/cloud-terrain.test.ts`.

`npx tsx scripts/bench-nest.ts [--budget 30]` compares the old bounding-box nest, the
outline nest the app runs and the cloud's budgeted nest. Tests: `test/nest-outline.test.ts`,
`test/cloud-pack-nest.test.ts`, the cloud-nest case in `test/sheet-dxf-cut.test.ts`, and the
pack cases in `e2e/boost.spec.ts`.

Cost: one 2-core container is about $0.000035 a second, so a terrain job is well under a cent,
a 30 s nest about $0.001 and a pack about $0.0003. Each finished job reports its seconds and
cost, shown next to its result.
