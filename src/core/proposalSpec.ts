// What a client proposal says, kept with the project (and in its share link).
// No imports, so project.ts can read it back without pulling in the drawings.

/** What the proposal says, typed in by hand. Empty fields print as "[… to confirm]". */
export interface ProposalSpec {
  /** Who it is for: "YHA Buttermere". */
  client: string;
  /** The place, as a heading: "Buttermere". Empty: the map's title, else the project name. */
  place: string;
  /** A real local quotation about the place, and who said or wrote it. */
  quote: string;
  quoteBy: string;
  /** A sentence or two on the piece and why it suits them. */
  intro: string;
  /** Edition number in "ECTYPE No. 001 — Buttermere". */
  number: string;
  /** What the piece is struck from, after "Archetype:". Empty: the elevation source of a map. */
  archetype: string;
  /** Price band, as written: "£4,200–4,800". */
  price: string;
  /** Not backed by a live quote yet: printed est. */
  priceEst: boolean;
  timeline: string;
  finish: string;
  upkeep: string;
  /** Sign-off line: name, address, site. */
  contact: string;
}

export const DEFAULT_CONTACT = 'Gabriel Gayle · gabriel@cockpit.yoga · cockpit.yoga';

export function defaultProposal(): ProposalSpec {
  return { client: '', place: '', quote: '', quoteBy: '', intro: '', number: '', archetype: '', price: '', priceEst: true, timeline: '', finish: '', upkeep: '', contact: DEFAULT_CONTACT };
}

const TEXT_KEYS = ['client', 'place', 'quote', 'quoteBy', 'intro', 'number', 'archetype', 'price', 'timeline', 'finish', 'upkeep', 'contact'] as const;

/** A proposal read back from a file or link: unknown keys dropped, wrong types replaced, text capped. */
export function cleanProposal(raw: unknown): ProposalSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out = defaultProposal();
  for (const k of TEXT_KEYS) if (typeof o[k] === 'string') out[k] = (o[k] as string).slice(0, 2000);
  if (typeof o.priceEst === 'boolean') out.priceEst = o.priceEst;
  return out;
}
