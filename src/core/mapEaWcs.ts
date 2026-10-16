// Environment Agency LiDAR composite WCS 2.0.1 (EPSG:27700) — native 1 m DTM/DSM.
import { metricBounds } from './mapProject';
import type { MapSource, MapSpec } from './mapSpec';

export const EA_DTM_WCS_BASE =
  'https://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wcs';
export const EA_DTM_COVERAGE_ID =
  '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';

export const EA_DSM_WCS_BASE =
  'https://environment.data.gov.uk/geoservices/datasets/9ba4d5ac-d596-445a-9056-dae3ddec0178/wcs';
export const EA_DSM_COVERAGE_ID =
  '9ba4d5ac-d596-445a-9056-dae3ddec0178__Lidar_Composite_Elevation_LZ_DSM_1m';

const SUBSET_CRS = 'http://www.opengis.net/def/crs/EPSG/0/27700';

/** Native LiDAR cell size (metres). */
export const EA_LIDAR_NATIVE_M = 1;
/** Cap WCS output so the long edge stays near the depth-grid max (see pickOutputSize). */
export const EA_WCS_MAX_EDGE_PX = 512;

function wcsBaseFor(source: MapSource): { base: string; coverageId: string } | null {
  if (source === 'ea-dtm') return { base: EA_DTM_WCS_BASE, coverageId: EA_DTM_COVERAGE_ID };
  if (source === 'ea-dsm') return { base: EA_DSM_WCS_BASE, coverageId: EA_DSM_COVERAGE_ID };
  return null;
}

function formatScaleFactor(factor: number): string {
  return String(Number(factor.toPrecision(6)));
}

/**
 * WCS 2.0 scaling factor (native 1 m → `resM`, also capped at ~512 px).
 * Full Neasden at 1 m is ~3344×3638 / 57 MB and freezes the browser GeoTIFF path.
 */
export function eaWcsScaleFactor(bbox: MapSpec['bbox'], resM = 8): number {
  const b = metricBounds(bbox, 'EPSG:27700');
  const longM = Math.max(Math.abs(b.east - b.west), Math.abs(b.north - b.south));
  const wanted = Math.max(EA_LIDAR_NATIVE_M, Number.isFinite(resM) && resM > 0 ? resM : 8);
  const capM = longM / EA_WCS_MAX_EDGE_PX;
  const requestM = Math.max(wanted, capM);
  return Math.min(1, EA_LIDAR_NATIVE_M / requestM);
}

/** Build a WCS 2.0.1 GetCoverage URL for the bbox (metric subset in EPSG:27700). */
export function buildEaWcsGetCoverageUrl(source: MapSource, bbox: MapSpec['bbox'], resM = 8): string | null {
  const meta = wcsBaseFor(source);
  if (!meta) return null;
  const b = metricBounds(bbox, 'EPSG:27700');
  const e0 = Math.floor(Math.min(b.west, b.east));
  const e1 = Math.ceil(Math.max(b.west, b.east));
  const n0 = Math.floor(Math.min(b.south, b.north));
  const n1 = Math.ceil(Math.max(b.south, b.north));
  const params = new URLSearchParams({
    service: 'WCS',
    version: '2.0.1',
    request: 'GetCoverage',
    coverageId: meta.coverageId,
    format: 'image/tiff',
    subsettingCrs: SUBSET_CRS,
  });
  params.append('subset', `E(${e0},${e1})`);
  params.append('subset', `N(${n0},${n1})`);
  const factor = eaWcsScaleFactor(bbox, resM);
  if (factor < 0.999) params.set('SCALEFACTOR', formatScaleFactor(factor));
  return `${meta.base}?${params.toString()}`;
}

export function eaWcsUrlForSpec(source: MapSource, spec: Pick<MapSpec, 'bbox'> & { resM?: number }): string | null {
  return buildEaWcsGetCoverageUrl(source, spec.bbox, spec.resM ?? 8);
}
