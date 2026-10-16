import type { DesignParser, ParseContext, ParseResult } from './types';
import { buildRuleRegistry, resolveMatches, unrecognisedSpans } from './rules';

export function parseDesign(text: string, ctx: ParseContext, rules = buildRuleRegistry()): ParseResult {
  const raw = text.trim();
  if (!raw) {
    return { patch: {}, matched: [], unrecognised: [], notes: [] };
  }
  const matches = rules.flatMap((r) => r.run(raw, ctx));
  const { kept, patch, notes } = resolveMatches(matches);
  const matched = kept.map((m) => ({ start: m.start, end: m.end }));
  const unrecognised = unrecognisedSpans(raw, matched);
  return { patch, matched, unrecognised, notes };
}

export const defaultDesignParser: DesignParser = {
  parse: parseDesign,
};
