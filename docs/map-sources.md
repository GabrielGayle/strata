# Map elevation data sources (Strata / Ectype)

Wave 1 CLI defaults to **AWS Terrain Tiles (Mapzen Terrarium)** when no higher-resolution adapter is available. Wave 2 adds **UK regional LiDAR** source ids and auto-pick per bbox (ticket T23).

## AWS Terrain Tiles (Terrarium) — global fallback

| Field | Value |
|---|---|
| **URL template** | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| **Registry** | [registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/) |
| **Format** | PNG RGB; elevation `metres = R×256 + G + B/256 − 32768` |
| **Nominal resolution** | ~30 m (varies by latitude) |
| **Licence** | Free to use; attribute per [Tilezen/Joerd attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (mixed upstream DEMs). |
| **Strata attribution lines** | Stored on `MapSpec.attribution` (see `TERRARIUM_ATTRIBUTION` in `src/core/mapSpec.ts`). |

Tests use small recorded tiles under `test/fixtures/map/` (recorded once via `tools/record-map-fixtures.mjs`).

## Scottish Remote Sensing Portal — `scot-dtm`

| Field | Value |
|---|---|
| **Portal** | [remotesensingdata.gov.scot](https://remotesensingdata.gov.scot/data#/list) |
| **About / licence** | [About the portal](https://remotesensingdata.gov.scot/about) — **Open Government Licence v3.0** unless otherwise stated |
| **AWS open data** | [registry.opendata.aws/scottish-lidar](https://registry.opendata.aws/scottish-lidar/) |
| **WMS (example)** | `https://srsp-ows.jncc.gov.uk/ows?service=wms&version=1.3.0&request=GetCapabilities` (layer e.g. `scotland:scotland-lidar-5-dtm`) |
| **CRS** | EPSG:27700 (British National Grid) |
| **Nominal resolution** | 1 m DTM (≤2 m; phases include sub-metre in places) |
| **Strata id** | `scot-dtm` |

Offline tests: `test/fixtures/map/regional/kingsbarns-scot-dtm.json` (Kingsbarns bbox).

## Wales — NRW / Welsh Government LiDAR — `wales-dtm`

| Field | Value |
|---|---|
| **Download map** | [DataMapWales — LiDAR data download](https://datamap.gov.wales/maps/lidar-data-download/) |
| **Metadata** | [NRW dataset NRW_DS116814](https://metadata.naturalresources.wales/geonetwork/srv/api/records/NRW_DS116814) |
| **Licence** | **Open Government Licence v3.0** — acknowledge NRW / Welsh Government copyright |
| **COG example (mosaic)** | `https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_dtm_32bit_cog.tif` |
| **CRS** | EPSG:27700 |
| **Nominal resolution** | 1 m composite (25 cm–2 m tiles in catalogue) |
| **Strata id** | `wales-dtm` |

## Northern Ireland — OSNI / DAERA LiDAR — `ni-dtm`

| Field | Value |
|---|---|
| **River basin 1 m DTM (2009–10)** | [Open Data NI — OSNI River Basin LiDAR](https://www.opendatani.gov.uk/dataset/osni-open-data-river-basin-lidar-2009-dtms-and-dsms) |
| **OGL text** | [LPS Open Government Licence PDF](https://apps.spatialni.gov.uk/OpenData/OPEN_GOVERNMENT_LICENCE.pdf) |
| **Coastal 2021 DTM (ArcGIS)** | [Topographic LiDAR DTM MapServer](https://tiles-eu1.arcgis.com/kswen6BYexuc1SUk/arcgis/rest/services/Topographic_LiDAR_DTM_TPK/MapServer) (DAERA NI 3D Coastal Survey) |
| **Licence** | **Open Government Licence v3.0** for OGL-marked products |
| **Coverage note** | ~14% NI from river-basin survey; coastal strip from 2021 survey — auto-pick may warn and fall back where no tile exists |
| **Nominal resolution** | 1 m where survey exists |
| **Strata id** | `ni-dtm` |

Offline tests: `test/fixtures/map/regional/royal-county-down-ni-dtm.json`.

## England — Environment Agency (planned adapter) — `ea-dtm` / `ea-dsm`

| Field | Value |
|---|---|
| **Portal** | [environment.data.gov.uk](https://environment.data.gov.uk/) (Defra Data Services Platform) |
| **Licence** | **Open Government Licence v3.0** |
| **Nominal resolution** | 1 m where published |
| **Catalog (DTM 1 m)** | `https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m` |
| **Strata status** | Ticket **T6** reads EA tiles via the adapter (cached under `--map-cache`); offline tests use `test/fixtures/map/regional/neasden-ea-dtm.json`. Browser fetches may use the **EA-only** CORS proxy in `api/ea-proxy.ts` (deployed on Vercel). |

## Sunken concrete frame (ticket T28)

| Field | Value |
|---|---|
| **Spec** | `sunkenFrame.enabled` with optional `castToleranceMm` and `wallMm` |
| **Mould** | `buildMapSunkenFrameMould` derives plate seat depths and an outer cast ring from sliced plate outlines |

## Lake bathymetry (ticket T24)

| Field | Value |
|---|---|
| **Formats** | CSV soundings (`easting,northing,bed_m`), DXF contour Z parse helper, GeoTIFF stub (CLI later) |
| **Welsh Harp sample** | Synthetic offline fixture `test/fixtures/map/welsh-harp-soundings.csv` (not a third-party dataset) |
| **Open UK lake depth** | No suitable national open vector dataset verified for redistribution; user soundings are the primary path |

## Water handling (ticket T16)

| Field | Value |
|---|---|
| **MapSpec.water** | `flat` — OSM water polygons flattened to a single surface elevation; `bathy` — true depth when soundings exist (T24); `raw` — leave elevations unchanged |
| **Surface level** | Median-ish land sample (`estimateWaterSurfaceM`) unless bathymetry overrides |

## Buildings / DSM (ticket T15)

| Field | Value |
|---|---|
| **MapSpec.model** | `dtm` (bare ground), `dsm` (EA DSM / max-pool), `dtm+buildings` (DTM + OSM `height` / `building:levels×3`) |
| **Tower clamp** | `buildingClampM` (default **25 m**) limits DSM−DTM rise before exaggeration |
| **OSM** | Building ways via Overpass (`building` tag); ODbL attribution when engraved |

## Neasden preset (ticket T18)

| Field | Value |
|---|---|
| **Default bbox** | `NEASDEN_MAP_BBOX` in `src/core/mapPresets.ts` (matches `test/map-fixtures.ts`) |
| **Welsh Harp expansion** | Plain-language `include Welsh Harp` unions `WELSH_HARP_WATER_BBOX` for Brent Reservoir |
| **Design parser** | `registerMapParserRules()` in `src/core/design/mapRules.ts` via `buildRuleRegistry()` |

## Map cache (ticket T7)

| Field | Value |
|---|---|
| **CLI** | `--map-cache <dir>` — terrarium PNGs, COG/WMS bytes, Nominatim JSON (`mapNominatimCli.ts`), and Overpass JSON share one hashed layout (`src/core/mapCache.ts`). |
| **Browser** | Optional IndexedDB store (`src/core/mapCacheBrowser.ts`) for the map window when wired. |
| **Acceptance** | Second fetch for the same URL/query reads disk (or IDB) and does not call the network fetcher. |

## Nominatim (map UI geocoding) — ticket T8

| Field | Value |
|---|---|
| **API** | [Nominatim search](https://nominatim.openstreetmap.org/) (`https://nominatim.openstreetmap.org/search`) |
| **User-Agent** | `StrataMap/0.1` (see `STRATA_NOMINATIM_UA` in `src/core/mapNominatim.ts`) |
| **Rate limit** | Client throttled to **1 request per second** (`searchNominatim`) |
| **Licence** | ODbL — same attribution requirements as OSM engraving; place search results set `MapSpec.bbox` only (no bulk DB storage). |

## Copernicus GLO-30 — `cop30`

| Field | Value |
|---|---|
| **Registry** | [registry.opendata.aws/copernicus-dem](https://registry.opendata.aws/copernicus-dem/) |
| **Resolution** | 30 m — **too coarse for golf-scale maps**; used only as an explicit source or documented fallback |
| **COG base URL** | `https://copernicus-dem-30m.s3.amazonaws.com/` (see `COPERNICUS_DEM30_BASE` in `src/core/mapCopernicus.ts`) |
| **Licence** | [Copernicus DEM licence](https://registry.opendata.aws/copernicus-dem/) — attribute `Elevation © Copernicus DEM GLO-30` |
| **Strata status** | Ticket **T5** reads COG range requests (cached as `.cog.bin` under `--map-cache`); offline tests use `test/fixtures/map/cop30-neasden.json`. |

## British National Grid (reprojection)

| Field | Value |
|---|---|
| **EPSG** | 27700 (OSGB36 / British National Grid) |
| **Implementation** | [proj4](https://github.com/proj4js/proj4js) definition in `src/core/mapProject.ts` |
| **Reference** | [EPSG:27700](https://epsg.io/27700) |

Inside Great Britain bounding boxes, resampled depth grids use EPSG:27700; elsewhere a local WGS84 UTM zone is chosen automatically.

## EA CORS proxy (ticket T6 — live on Vercel)

Browser fetches to `environment.data.gov.uk` are often blocked by CORS. `api/ea-proxy.ts` (Vercel serverless handler) that:

- Whitelists **only** `environment.data.gov.uk` and its subdomains over **HTTPS** (`src/server/eaCorsProxy.ts`).
- Uses `redirect: manual` and re-checks the allowlist on every redirect hop.
- Forwards only `content-type`, `content-length`, `cache-control`, `etag`, and `last-modified` (never `set-cookie`).
- Proxies GET/HEAD with optional `Range` for COG/catalog range reads; no injected credentials.

Scotland/Wales/NI adapters still need separate proxy work or CLI-only fetch until a broader allowlist ships.

Other regional hosts (`remotesensingdata.gov.scot`, `datamap.gov.wales`, ArcGIS) remain CLI/fixture-only in the app until a future multi-host proxy is designed.

## Auto source selection

`--map-source auto` (default) uses `pickAutoMapSource()` (`src/core/mapSourcePick.ts`):

| Nation (heuristic) | Picked source | ≤2 m |
|---|---|---|
| Scotland | `scot-dtm` | yes |
| Wales | `wales-dtm` | yes |
| Northern Ireland | `ni-dtm` | yes (where surveyed) |
| England | `ea-dtm` | yes (when adapter live) |
| Outside UK | `terrarium` | no (warn) |

Resolved source and warnings are stored on `MapSpec.resolvedSource` and `MapSpec.sourceWarnings`.

## OpenStreetMap — map engraving (ticket T13+)

| Field | Value |
|---|---|
| **API** | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (`https://overpass-api.de/api/interpreter`) |
| **User-Agent** | `StrataMap/0.1` (see `STRATA_OVERPASS_UA` in `src/core/mapOverpass.ts`) |
| **Licence** | [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| **Attribution (required)** | **© OpenStreetMap contributors** — link [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright) |
| **Produced work** | Laser-engraved linework on plates is a *produced work*; the engraved product must carry ODbL attribution (etched on the back plate and listed in the build pack / BOM). |
| **Share-alike** | If you redistribute OSM-derived databases built from our extracts, ODbL share-alike may apply; the physical map product attribution requirement is separate from SA on databases. |
| **Cache** | `--map-cache <dir>` stores `{sha256}.overpass.json` tiles; tests use `test/fixtures/map/overpass-*.json` only. |

Strata stores the attribution line on `MapSpec.attribution` and in `MapEngraveArt.osmAttribution` when OSM linework is fetched.

**Golf (T21):** enable `golf` / `fairway` / `green` in `--engrave` to fetch `golf=*` ways; use preset `golf` for yardage-book line weights (fixture: `test/fixtures/map/overpass-golf.json`).

**Ski (T22):** enable `ski` / `piste` / `alpine` for `piste:type` and `aerialway` ways; preset `ski` / `alpine` (fixture: `test/fixtures/map/overpass-ski.json`).

**Attribution etch (T14):** `MapSpec.attribution` lines are etched on the **bottom** plate (`ETCH`) and listed in `build-pack.html` under **Map data credits**.

**Edition + archetype card (T25):** `--map-edition N` etches `Edition N` on the back plate; `--archetype-card path.json` is copied to `map/archetype-card.json` in the fabrication bundle.

**Commemorative text (T26):** `--commemorative "…"` etches on the back plate when it fits at the computed cap height; otherwise a warning is stored on `MapSpec.sourceWarnings`.

## Excluded in this product

Google, Cesium, and Mapbox terrain products are **not** used (licence / ToS).
