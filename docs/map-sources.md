# Map elevation data sources (Strata / Ectype)

Wave 1 (CLI) uses **AWS Terrain Tiles (Mapzen Terrarium)** only. Other source names are accepted on the CLI for forward compatibility but exit until their adapters land.

## AWS Terrain Tiles (Terrarium) — default / preview

| Field | Value |
|---|---|
| **URL template** | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| **Registry** | [registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/) |
| **Format** | PNG RGB; elevation `metres = R×256 + G + B/256 − 32768` |
| **Licence** | Free to use; attribute per [Tilezen/Joerd attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (mixed upstream DEMs). |
| **Strata attribution lines** | Stored on `MapSpec.attribution` (see `TERRARIUM_ATTRIBUTION` in `src/core/mapSpec.ts`). |

Tests use small recorded tiles under `test/fixtures/map/` (recorded once via `tools/record-map-fixtures.mjs`).

## British National Grid (reprojection)

| Field | Value |
|---|---|
| **EPSG** | 27700 (OSGB36 / British National Grid) |
| **Implementation** | [proj4](https://github.com/proj4js/proj4js) definition in `src/core/mapProject.ts` |
| **Reference** | [EPSG:27700](https://epsg.io/27700) |

Inside Great Britain bounding boxes, resampled depth grids use EPSG:27700; elsewhere a local WGS84 UTM zone is chosen automatically.

## Excluded in this product

Google, Cesium, and Mapbox terrain products are **not** used (licence / ToS).

## Planned (not in wave 1)

- **Copernicus GLO-30** — [registry.opendata.aws/copernicus-dem](https://registry.opendata.aws/copernicus-dem/)
- **EA LiDAR DTM/DSM (England)** — [Defra Data Services Platform](https://environment.data.gov.uk/) (OGL v3)
- **OpenStreetMap** engraving — [ODbL](https://www.openstreetmap.org/copyright) (later tickets)
