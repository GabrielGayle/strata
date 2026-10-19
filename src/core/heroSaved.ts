// A hero render as the project saves it (see hero.ts). Kept apart so project.ts can read it
// without pulling in the GLB writer.

export type HeroLight = 'studio' | 'daylight' | 'candle';
export const HERO_LIGHTS: { id: HeroLight; label: string; title: string }[] = [
  { id: 'studio', label: 'Studio', title: 'Soft studio light on a plain backdrop' },
  { id: 'daylight', label: 'Daylight', title: 'Outdoors: sun and sky, with a long soft shadow' },
  { id: 'candle', label: 'Candlelight', title: 'A dark room lit by the candles in the design' },
];

/** A finished render saved in the project, used while the design still matches its fingerprint. */
export interface SavedHero {
  kind: 'hero';
  /** `heroFingerprint` of the design it shows. */
  fingerprint: string;
  /** data:image/png;base64,… */
  png: string;
  w: number;
  h: number;
  light: HeroLight;
  /** YYYY-MM-DD */
  date: string;
}

export function cleanSavedHero(raw: unknown): SavedHero | undefined {
  const o = raw as Partial<SavedHero> | null;
  if (!o || typeof o !== 'object' || o.kind !== 'hero') return undefined;
  if (typeof o.fingerprint !== 'string' || typeof o.png !== 'string' || !o.png.startsWith('data:image/png;base64,')) return undefined;
  if (!(Number(o.w) > 0) || !(Number(o.h) > 0)) return undefined;
  const light = HERO_LIGHTS.some((l) => l.id === o.light) ? (o.light as HeroLight) : 'studio';
  return { kind: 'hero', fingerprint: o.fingerprint, png: o.png, w: Number(o.w), h: Number(o.h), light, date: typeof o.date === 'string' ? o.date : '' };
}

