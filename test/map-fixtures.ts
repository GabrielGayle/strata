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
