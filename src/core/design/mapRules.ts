import { mapPresetSpec } from '../mapPresets';
import type { DesignRule } from './rules';
import { allMatches } from './rules';

/** Plain-language → MapSpec patches (ticket T18). */
export function registerMapParserRules(registry: DesignRule[]): void {
  registry.push({
    id: 'map-neasden',
    priority: 44,
    run: (text) =>
      allMatches(
        text,
        /\b(?:neasden\s+map|map\s+of\s+neasden|neasden\s+relief|neasden\s+terrain)\b/gi,
        (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { map: mapPresetSpec('neasden') },
          note: 'Neasden map preset',
        }),
        44,
      ),
  });

  registry.push({
    id: 'map-welsh-harp',
    priority: 43,
    run: (text) =>
      allMatches(text, /\binclude\s+(?:the\s+)?welsh\s+harp\b/gi, (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: { map: mapPresetSpec('neasden-welsh-harp') },
        note: 'expand bbox for Welsh Harp reservoir',
      }), 43),
  });
}
