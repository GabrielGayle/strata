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
| **Strata status** | Auto-pick selects `ea-dtm` in England; fetch **falls back to terrarium** with a warning until ticket T6 (EA adapter + proxy) ships. |

## Copernicus GLO-30 — `cop30`

| Field | Value |
|---|---|
| **Registry** | [registry.opendata.aws/copernicus-dem](https://registry.opendata.aws/copernicus-dem/) |
| **Resolution** | 30 m — **too coarse for golf-scale maps**; used only as an explicit source or documented fallback |
| **Strata status** | Not wired in wave 2 fetch path (stub warns + terrarium). |

## British National Grid (reprojection)

| Field | Value |
|---|---|
| **EPSG** | 27700 (OSGB36 / British National Grid) |
| **Implementation** | [proj4](https://github.com/proj4js/proj4js) definition in `src/core/mapProject.ts` |
| **Reference** | [EPSG:27700](https://epsg.io/27700) |

Inside Great Britain bounding boxes, resampled depth grids use EPSG:27700; elsewhere a local WGS84 UTM zone is chosen automatically.

## CORS proxy (design only — not deployed)

Browser fetches to `environment.data.gov.uk`, `remotesensingdata.gov.scot`, `datamap.gov.wales`, and ArcGIS tile hosts are often blocked by CORS. Ticket **T6** specifies a **Vercel edge/ serverless proxy** that:

- Whitelists only approved host suffixes (e.g. `environment.data.gov.uk`, `srsp-ows.jncc.gov.uk`, `dmwproductionblob.blob.core.windows.net`, `tiles-eu1.arcgis.com`).
- Streams GET range requests for COG/WMS tiles with cache headers.
- Injects no credentials; attribution remains on the client `MapSpec`.

**This repository does not deploy the proxy** in wave 2; CLI/tests use fixtures and terrarium fallback. See ticket T6 acceptance tests for the Neasden EA fixture path.

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
