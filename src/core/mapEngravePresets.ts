/** Typographic preset ids (ticket 13). T21/T22 add golf/ski feature styles on top. */
export type MapEngravePresetId = 'survey' | 'nautical' | 'alpine' | 'city' | 'golf' | 'ski';

export interface MapEngraveTypography {
  id: MapEngravePresetId;
  label: string;
  /** Title cap height in mm on the master top face. */
  titleHeightMm: number;
  /** Feature / road label cap height in mm. */
  labelHeightMm: number;
  /** Road line width in mm. */
  roadWidthMm: number;
  waterWidthMm: number;
  railWidthMm: number;
  /** Title + label font pairing (strokefont scale factors). */
  titleScale: number;
  labelScale: number;
  /** Letter-spacing tweak (multiplier on strokefont advance). */
  titleTracking: number;
  labelTracking: number;
}

export const MAP_ENGRAVE_PRESETS: Record<MapEngravePresetId, MapEngraveTypography> = {
  survey: {
    id: 'survey',
    label: 'Survey plate',
    titleHeightMm: 9,
    labelHeightMm: 5,
    roadWidthMm: 0.35,
    waterWidthMm: 0.5,
    railWidthMm: 0.4,
    titleScale: 1.05,
    labelScale: 0.95,
    titleTracking: 1.1,
    labelTracking: 1,
  },
  nautical: {
    id: 'nautical',
    label: 'Nautical chart',
    titleHeightMm: 10,
    labelHeightMm: 4.5,
    roadWidthMm: 0.3,
    waterWidthMm: 0.65,
    railWidthMm: 0.35,
    titleScale: 1.15,
    labelScale: 0.9,
    titleTracking: 1.2,
    labelTracking: 0.95,
  },
  alpine: {
    id: 'alpine',
    label: 'Alpine trail',
    titleHeightMm: 8.5,
    labelHeightMm: 5.5,
    roadWidthMm: 0.4,
    waterWidthMm: 0.45,
    railWidthMm: 0.35,
    titleScale: 1,
    labelScale: 1.05,
    titleTracking: 1,
    labelTracking: 1.05,
  },
  city: {
    id: 'city',
    label: 'City plan',
    titleHeightMm: 8,
    labelHeightMm: 4,
    roadWidthMm: 0.45,
    waterWidthMm: 0.4,
    railWidthMm: 0.45,
    titleScale: 0.95,
    labelScale: 0.85,
    titleTracking: 0.95,
    labelTracking: 0.9,
  },
  golf: {
    id: 'golf',
    label: 'Golf yardage book',
    titleHeightMm: 9,
    labelHeightMm: 5,
    roadWidthMm: 0.25,
    waterWidthMm: 0.6,
    railWidthMm: 0.25,
    titleScale: 1.1,
    labelScale: 1,
    titleTracking: 1.05,
    labelTracking: 1,
  },
  ski: {
    id: 'ski',
    label: 'Ski trail map',
    titleHeightMm: 9,
    labelHeightMm: 5,
    roadWidthMm: 0.35,
    waterWidthMm: 0.5,
    railWidthMm: 0.35,
    titleScale: 1,
    labelScale: 1,
    titleTracking: 1,
    labelTracking: 1,
  },
};

export function resolveEngravePreset(id?: string): MapEngraveTypography {
  const key = (id?.trim().toLowerCase() ?? 'survey') as MapEngravePresetId;
  return MAP_ENGRAVE_PRESETS[key] ?? MAP_ENGRAVE_PRESETS.survey;
}
