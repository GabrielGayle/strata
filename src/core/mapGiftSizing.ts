// Gift sizing + size-aware map pricing (ticket T27).
import type { Bom } from './bom';
import type { MapSpec } from './mapSpec';
import { ORDER_AREA_CAP_M2 } from './chopchopRates';

/** Tunable: smaller map faces (fewer/smaller plates) reduce the Chop Chop order-area factor. */
export const MAP_GIFT_AREA_DISCOUNT_EXP = 1.15;

export function mapBboxAreaM2(bbox: MapSpec['bbox']): number {
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const widthM = (e - w) * 111_320 * Math.cos((lat * Math.PI) / 180);
  const heightM = (n - s) * 110_540;
  return Math.max(0, widthM * heightM);
}

export function mapPlateAreaMm2(bom: Bom): number {
  return bom.rows.reduce((a, r) => a + r.area, 0);
}

/** 0..1 multiplier — smaller total plate area → lower factor (cheaper small gifts). */
export function mapGiftPriceFactor(bom: Bom, map?: Pick<MapSpec, 'bbox' | 'giftSizeId'>): number {
  if (!map) return 1;
  const plateAreaM2 = mapPlateAreaMm2(bom) / 1e6;
  const used = Math.min(ORDER_AREA_CAP_M2, plateAreaM2);
  return Math.max(0.35, Math.min(1, (used / ORDER_AREA_CAP_M2) ** MAP_GIFT_AREA_DISCOUNT_EXP));
}
