import type { MapSource } from './mapSpec';

export interface MapSourceMeta {
  id: MapSource;
  /** Nominal ground resolution in metres (best case). */
  resolutionM: number;
  portalUrl: string;
  licence: string;
  attribution: string[];
  /** WMS or COG entry point for adapters (browser may need CORS proxy). */
  serviceUrl?: string;
}

export const REGIONAL_LIDAR_SOURCES: MapSource[] = ['scot-dtm', 'wales-dtm', 'ni-dtm'];

export const MAP_SOURCE_REGISTRY: Record<MapSource, MapSourceMeta> = {
  auto: {
    id: 'auto',
    resolutionM: 1,
    portalUrl: 'https://github.com/GabrielGayle/strata/blob/claude/strata-app/docs/map-sources.md',
    licence: 'See resolved source',
    attribution: [],
  },
  'scot-dtm': {
    id: 'scot-dtm',
    resolutionM: 1,
    portalUrl: 'https://remotesensingdata.gov.scot/data#/list',
    serviceUrl: 'https://srsp-ows.jncc.gov.uk/ows?service=wms&version=1.3.0&request=GetCapabilities',
    licence: 'Open Government Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)',
    attribution: [
      'LiDAR DTM © Crown copyright Scottish Government / Fugro — Scottish Remote Sensing Portal (https://remotesensingdata.gov.scot/)',
      'Open Government Licence v3.0',
    ],
  },
  'wales-dtm': {
    id: 'wales-dtm',
    resolutionM: 1,
    portalUrl: 'https://datamap.gov.wales/maps/lidar-data-download/',
    serviceUrl: 'https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_dtm_32bit_cog.tif',
    licence: 'Open Government Licence v3.0 (Welsh Government / Natural Resources Wales)',
    attribution: [
      'LiDAR DTM © Natural Resources Wales / Welsh Government — DataMapWales (https://datamap.gov.wales/)',
      'Open Government Licence v3.0',
    ],
  },
  'ni-dtm': {
    id: 'ni-dtm',
    resolutionM: 1,
    portalUrl: 'https://www.opendatani.gov.uk/dataset/osni-open-data-river-basin-lidar-2009-dtms-and-dsms',
    serviceUrl: 'https://tiles-eu1.arcgis.com/kswen6BYexuc1SUk/arcgis/rest/services/Topographic_LiDAR_DTM_TPK/MapServer',
    licence: 'Open Government Licence v3.0 (Land & Property Services / OSNI open data)',
    attribution: [
      'LiDAR DTM © OSNI / DAERA — Open Data NI (https://www.opendatani.gov.uk/)',
      'Contains public sector information licensed under the Open Government Licence v3.0',
    ],
  },
  'ea-dtm': {
    id: 'ea-dtm',
    resolutionM: 1,
    portalUrl: 'https://environment.data.gov.uk/',
    serviceUrl: 'https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m',
    licence: 'Open Government Licence v3.0 (Defra / Environment Agency)',
    attribution: ['LiDAR DTM © Environment Agency — Defra Data Services Platform'],
  },
  'ea-dsm': {
    id: 'ea-dsm',
    resolutionM: 1,
    portalUrl: 'https://environment.data.gov.uk/',
    serviceUrl: 'https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDSM1m',
    licence: 'Open Government Licence v3.0',
    attribution: ['LiDAR DSM © Environment Agency — Defra Data Services Platform'],
  },
  cop30: {
    id: 'cop30',
    resolutionM: 30,
    portalUrl: 'https://registry.opendata.aws/copernicus-dem/',
    licence: 'Copernicus DEM licence (see registry)',
    attribution: ['Elevation © Copernicus DEM GLO-30'],
  },
  terrarium: {
    id: 'terrarium',
    resolutionM: 30,
    portalUrl: 'https://registry.opendata.aws/terrain-tiles/',
    licence: 'AWS Terrain Tiles / mixed upstream (see Tilezen attribution)',
    attribution: [],
  },
};

export const HIGH_RES_MAX_M = 2;

export function sourceMeta(id: MapSource): MapSourceMeta {
  return MAP_SOURCE_REGISTRY[id];
}
