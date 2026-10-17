/** Neasden preset bbox (WGS84), shared by map CLI / terrarium tests. */
export const NEASDEN_BBOX: [number, number, number, number] = [-0.28, 51.543, -0.233, 51.575];

/** Tiny Neasden clip — still covered by `test/fixtures/map/neasden/13/*` tiles, much less terrarium mosaic work. */
export const NEASDEN_FAST_BBOX: [number, number, number, number] = [-0.262, 51.558, -0.252, 51.566];

/** Kingsbarns (St Andrews) — Scotland LiDAR acceptance bbox. */
export const KINGSBARNS_BBOX: [number, number, number, number] = [-2.655, 56.335, -2.628, 56.352];

/** Royal County Down — Northern Ireland LiDAR acceptance bbox. */
export const ROYAL_COUNTY_DOWN_BBOX: [number, number, number, number] = [-5.808, 54.215, -5.775, 54.238];

/** Buttermere / Crummock (WGS84 west, south, east, north) — orientation + water acceptance. */
export const BUTTERMERE_BBOX: [number, number, number, number] = [-3.34325, 54.51331, -3.21875, 54.58569];

/** EA DTM lake surfaces (m AMSL) for the Buttermere bbox. */
export const BUTTERMERE_LAKE_M = { buttermere: 101, crummock: 98 } as const;

/** Grasmoor (~851 m) sits in the NE of the Buttermere bbox; Crummock is ~98 m. */
export const BUTTERMERE_DEM_STATS = {
  trueReliefM: 753,
  robustReliefM: 700,
  /** Equirectangular width; `metricBounds` is within a few tens of metres. */
  mapWidthM: 8044,
  masterWidthMm: 800,
  plateCount: 40,
  thicknessMm: 3,
} as const;

/** Shooters Hill to Thames — decoded from Gabriel’s Woolwich project. */
export const WOOLWICH_BBOX: [number, number, number, number] = [-0.03, 51.465, 0.124, 51.505];

export const WOOLWICH_DEM_STATS = {
  trueReliefM: 125.47818595170975,
  robustReliefM: 108.90642626342506,
  mapWidthM: 10816.234576938907,
  mapHeightM: 4746.986988676013,
  zMinM: -0.39947348833084106,
  zMaxM: 125.0787124633789,
  masterWidthMm: 720,
  plateCount: 46,
  thicknessMm: 1.5,
} as const;
