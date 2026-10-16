/** Coarse UK nation buckets from a WGS84 bbox centroid (auto source pick). */
export type UkNation = 'scotland' | 'wales' | 'northern-ireland' | 'england';

export function bboxCentroid(bbox: [number, number, number, number]): [number, number] {
  const [w, s, e, n] = bbox;
  return [(w + e) / 2, (s + n) / 2];
}

export function detectUkNation(bbox: [number, number, number, number]): UkNation | null {
  const [lon, lat] = bboxCentroid(bbox);
  if (lon < -5.35 && lat >= 54.0 && lat <= 55.45) return 'northern-ireland';
  if (lat >= 54.85 && lon >= -8.9 && lon <= -0.75) return 'scotland';
  if (lat >= 51.35 && lat <= 53.55 && lon >= -5.85 && lon <= -2.55) return 'wales';
  if (lat >= 49.9 && lat <= 55.95 && lon >= -6.5 && lon <= 2.0) return 'england';
  return null;
}
