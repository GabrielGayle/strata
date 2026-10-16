import type { DepthFace } from '../autoDimension';
import { MASTER_SIZE_CLI_CANONICAL } from '../masterPresets';
import { PRESETS } from '../project';
import { speechParamPatch } from '../speechTuning';
import { wordsParamPatch } from '../chantWords';
import type { ParseContext, ProjectPatch, Span } from './types';
import { mergePatches } from './patch';
import { registerMapParserRules } from './mapRules';

export interface RuleMatch {
  start: number;
  end: number;
  patch: ProjectPatch;
  note?: string;
  priority: number;
}

type RuleMatchDraft = Omit<RuleMatch, 'priority'>;

export interface DesignRule {
  id: string;
  priority: number;
  run: (text: string, ctx: ParseContext) => RuleMatch[];
}

const PRESET_ALIASES: Record<string, string> = {};
for (const p of PRESETS) {
  PRESET_ALIASES[p.name.toLowerCase()] = p.name;
  PRESET_ALIASES[p.name.toLowerCase().replace(/\s+/g, '')] = p.name;
}
PRESET_ALIASES['image cliff'] = 'Image cliff';
PRESET_ALIASES['vermilion'] = 'Vermilion 40';
PRESET_ALIASES['mini vermilion'] = 'Mini Vermilion';

const MATERIALS: Record<string, string> = {
  steel: 'steel',
  'mild steel': 'steel',
  mild: 'steel',
  corten: 'corten',
  weathering: 'corten',
  aluminium: 'aluminium',
  aluminum: 'aluminium',
  alum: 'aluminium',
};

const BLUR_TYPES: Record<string, string> = {
  soft: 'box',
  box: 'box',
  even: 'box',
  lens: 'lens',
  camera: 'lens',
  surface: 'surface',
  edge: 'surface',
  motion: 'motion',
  directional: 'motion',
  streak: 'motion',
  radial: 'radial',
  spin: 'radial',
  zoom: 'zoom',
  'tilt-shift': 'tilt',
  tilt: 'tilt',
  'tilt shift': 'tilt',
};

const SLICE_MODES: Record<string, string> = {
  parallel: 'parallel',
  radial: 'radial',
  waffle: 'waffle',
  interlocking: 'waffle',
  flat: 'flat',
  stamped: 'flat',
  'flat stack': 'flat',
};

export function allMatches(text: string, re: RegExp, fn: (m: RegExpMatchArray) => RuleMatchDraft | null, priority: number): RuleMatch[] {
  const out: RuleMatch[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    const hit = fn(m);
    if (hit) out.push({ ...hit, priority });
  }
  return out;
}

function numParam(id: string, val: string | number): ProjectPatch {
  return { params: { [id]: String(val) } };
}

function choiceParam(id: string, val: string): ProjectPatch {
  return { params: { [id]: val } };
}

/** Rules that can be extended when auto-dimension (#52) lands — see registerAutoDimensionRules. */
export const CORE_RULES: DesignRule[] = [
  {
    id: 'preset',
    priority: 100,
    run: (text) => {
      const names = [...new Set(Object.keys(PRESET_ALIASES))].sort((a, b) => b.length - a.length);
      const re = new RegExp(`\\b(?:preset\\s+)?(${names.map(escapeRe).join('|')})\\b`, 'gi');
      return allMatches(text, re, (m) => {
        const key = m[1].toLowerCase();
        const name = PRESET_ALIASES[key] ?? PRESET_ALIASES[key.replace(/\s+/g, '')];
        if (!name) return null;
        return { start: m.index!, end: m.index! + m[0].length, patch: { preset: name }, note: `preset ${name}` };
      }, 100);
    },
  },
  {
    id: 'master-size',
    priority: 95,
    run: (text) => {
      const sizes = MASTER_SIZE_CLI_CANONICAL.map(escapeRe).join('|');
      const re = new RegExp(
        `\\b(?:(?:size|format|sheet)\\s+)?(${sizes}|a3|a4|a5|a6|iphone(?:\\s*-?\\s*17)?)(?:\\s+(portrait|landscape))?\\b`,
        'gi',
      );
      return allMatches(text, re, (m) => {
        const size = m[1].replace(/\s+/g, '');
        const ori = m[2]?.toLowerCase();
        return {
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { masterSize: { id: size, orientation: ori === 'landscape' ? 'landscape' : ori === 'portrait' ? 'portrait' : undefined } },
          note: `master size ${size}${ori ? ` ${ori}` : ''}`,
        };
      }, 95);
    },
  },
  {
    id: 'plate-count',
    priority: 80,
    run: (text) =>
      allMatches(text, /\b(\d{1,3})\s*(?:plates?|layers?|slices?)\b/gi, (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: numParam('plateCount', m[1]),
      }), 80),
  },
  {
    id: 'thickness',
    priority: 80,
    run: (text) =>
      allMatches(text, /\b(\d+(?:\.\d+)?)\s*(?:mm|millimet(?:er|re)s?)\b/gi, (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: numParam('thickness', m[1]),
      }), 80),
  },
  {
    id: 'material',
    priority: 75,
    run: (text) => {
      const mats = Object.keys(MATERIALS).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
      return allMatches(text, new RegExp(`\\b(${mats})\\b`, 'gi'), (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: choiceParam('plateMaterial', MATERIALS[m[1].toLowerCase()]),
      }), 75);
    },
  },
  {
    id: 'slice-mode',
    priority: 70,
    run: (text) => {
      const modes = Object.keys(SLICE_MODES).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
      return allMatches(text, new RegExp(`\\b(${modes})(?:\\s+(?:stack|plates?|slicing))?\\b`, 'gi'), (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: choiceParam('sliceMode', SLICE_MODES[m[1].toLowerCase()]),
      }), 70);
    },
  },
  {
    id: 'radial-count',
    priority: 70,
    run: (text) =>
      allMatches(text, /\b(\d{1,3})\s*radial\s*plates?\b/gi, (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: mergePatches(choiceParam('sliceMode', 'radial'), numParam('radialCount', m[1])),
      }), 70),
  },
  {
    id: 'master-scale',
    priority: 65,
    run: (text) =>
      allMatches(text, /\b(?:master\s+)?(?:scale|size)\s*(?:×|x)?\s*(\d+(?:\.\d+)?)\s*(?:×|x)?\b/gi, (m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        patch: numParam('masterScale', m[1]),
      }), 65),
  },
  {
    id: 'erosion',
    priority: 60,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\b(?:more|extra|stronger)\s+erosion\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('erosionAmp', '80'),
          note: 'bumped erosion amplitude',
        }), 60),
      );
      out.push(
        ...allMatches(text, /\b(?:less|softer|gentler)\s+erosion\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('erosionAmp', '20'),
        }), 60),
      );
      out.push(
        ...allMatches(text, /\berosion\s+(?:amplitude|amp)\s*(\d+(?:\.\d+)?)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('erosionAmp', m[1]),
        }), 60),
      );
      out.push(
        ...allMatches(text, /\berosion\s+(?:wavelength|scale)\s*(\d+(?:\.\d+)?)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('erosionScale', m[1]),
        }), 60),
      );
      return out;
    },
  },
  {
    id: 'side-image',
    priority: 55,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\b(?:side|profile)\s+(?:from\s+)?(?:this\s+)?(?:photo|picture|image)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('imgSideMode', 'heightmap'),
        }), 55),
      );
      out.push(
        ...allMatches(text, /\bcliff\s+from\s+(?:this\s+)?(?:photo|picture|image)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: mergePatches({ preset: 'Image cliff' }, choiceParam('imgSideMode', 'heightmap')),
        }), 105),
      );
      out.push(
        ...allMatches(text, /\b(?:heightmap|height\s*map)\s+side\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('imgSideMode', 'heightmap'),
        }), 55),
      );
      return out;
    },
  },
  {
    id: 'front-top-image',
    priority: 55,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\bfront\s+(?:cut-?outs?|layers?)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('imgFrontMode', 'layers'),
        }), 55),
      );
      out.push(
        ...allMatches(text, /\b(?:carve|stamp)\s+top\b|\btop\s+carve\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('imgTopMode', 'carve'),
        }), 55),
      );
      out.push(
        ...allMatches(text, /\betch(?:ing)?\s+hatch\b|\bhatch\s+etch\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('etchMode', 'hatch'),
        }), 55),
      );
      return out;
    },
  },
  {
    id: 'blur',
    priority: 50,
    run: (text) => {
      const types = Object.keys(BLUR_TYPES).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, new RegExp(`\\b(${types})\\s+blur\\b`, 'gi'), (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('imgBlurType', BLUR_TYPES[m[1].toLowerCase()]),
        }), 50),
      );
      out.push(
        ...allMatches(text, /\bblur\s*(?:amount|level|radius)?\s*(\d+(?:\.\d+)?)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('imgSmooth', m[1]),
        }), 50),
      );
      return out;
    },
  },
  {
    id: 'tuning',
    priority: 45,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\bspeech[- ]?like\b|\bvowel\s+colou?rs?\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('tuneMode', 'speech'),
        }), 45),
      );
      out.push(
        ...allMatches(text, /\bchant\b|\bwords?\s+tuning\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('tuneMode', 'words'),
        }), 45),
      );
      out.push(
        ...allMatches(text, /\bphrase\s+["']([^"']+)["']/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { params: wordsParamPatch(m[1]) },
          note: 'tune phrase',
        }), 45),
      );
      out.push(
        ...allMatches(text, /\btune\s+["']([^"']+)["']/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { params: speechParamPatch(m[1]) },
        }), 45),
      );
      out.push(
        ...allMatches(text, /\b(?:climb|scale)\s+(?:a\s+)?(?:major|minor)\s+scale\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: choiceParam('tuneMode', 'scale'),
        }), 45),
      );
      return out;
    },
  },
  {
    id: 'fabrication',
    priority: 40,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\bkerf\s*(\d+(?:\.\d+)?)\s*mm\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('kerf', m[1]),
        }), 40),
      );
      out.push(
        ...allMatches(text, /\bsheet\s*(\d{3,4})\s*[×x]\s*(\d{3,4})\s*mm\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { params: { sheetWidth: m[1], sheetHeight: m[2] } },
        }), 40),
      );
      out.push(
        ...allMatches(text, /\bpart\s+prefix\s+["']?([A-Za-z0-9_-]+)["']?\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { params: { partPrefix: m[1] } },
        }), 40),
      );
      return out;
    },
  },
  {
    id: 'stack-dims',
    priority: 35,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\bplate\s+height\s*(\d+(?:\.\d+)?)\s*mm\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: numParam('stackHeight', m[1]),
        }), 35),
      );
      out.push(
        ...allMatches(text, /\bbase\s+(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { params: { baseLength: m[1], baseWidth: m[2] } },
        }), 35),
      );
      out.push(
        ...allMatches(text, /\bgap\s*(?:between\s+plates?)?\s*(\d+(?:\.\d+)?)\s*mm\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: mergePatches(choiceParam('spacingMode', 'gap'), numParam('plateGap', m[1])),
        }), 35),
      );
      return out;
    },
  },
  {
    id: 'toggles',
    priority: 30,
    run: (text) => {
      const out: RuleMatch[] = [];
      const onOff = (id: string, onRe: RegExp, offRe: RegExp) => {
        out.push(
          ...allMatches(text, onRe, (m) => ({
            start: m.index!,
            end: m.index! + m[0].length,
            patch: { params: { [id]: true } },
          }), 30),
        );
        out.push(
          ...allMatches(text, offRe, (m) => ({
            start: m.index!,
            end: m.index! + m[0].length,
            patch: { params: { [id]: false } },
          }), 30),
        );
      };
      onOff('baseOn', /\bconcrete\s+base\s+on\b/gi, /\bno\s+concrete\s+base\b|\bconcrete\s+base\s+off\b/gi);
      onOff('strataOn', /\berosion\s+on\b|\bstrata\s+on\b/gi, /\berosion\s+off\b|\bstrata\s+off\b|\bflat\s+topped\b/gi);
      onOff('imageOn', /\bimages?\s+on\b/gi, /\bimages?\s+off\b/gi);
      onOff('rodsOn', /\brods?\s+on\b|\bthreaded\s+rods?\b/gi, /\brods?\s+off\b/gi);
      return out;
    },
  },
];

const DEPTH_FACES = new Set<DepthFace>(['side', 'front', 'top']);

function parseFaceList(spec: string): DepthFace[] {
  const faces: DepthFace[] = [];
  for (const part of spec.split(/[,&]/).map((s) => s.trim()).filter(Boolean)) {
    const f = part.toLowerCase() as DepthFace;
    if (DEPTH_FACES.has(f) && !faces.includes(f)) faces.push(f);
  }
  return faces;
}

/** Auto-dimension / relief exaggeration (uses metric depth on project images at apply time). */
export function registerAutoDimensionRules(registry: DesignRule[]): void {
  registry.push({
    id: 'auto-dimension',
    priority: 58,
    run: (text) => {
      const out: RuleMatch[] = [];
      out.push(
        ...allMatches(text, /\bauto[- ]?dimension(?:\s+the)?\s+(side|front|top)\b/gi, (m) => ({
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { autoDimension: { faces: [m[1].toLowerCase() as DepthFace] } },
          note: `auto-dimension ${m[1].toLowerCase()}`,
        }), 58),
      );
      out.push(
        ...allMatches(text, /\bauto[- ]?dimension\s+((?:side|front|top)(?:\s*,\s*(?:side|front|top))*)\b/gi, (m) => {
          const faces = parseFaceList(m[1]);
          if (!faces.length) return null;
          return {
            start: m.index!,
            end: m.index! + m[0].length,
            patch: { autoDimension: { faces } },
            note: `auto-dimension ${faces.join(',')}`,
          };
        }, 58),
      );
      return out;
    },
  });
  registry.push({
    id: 'relief-exaggeration',
    priority: 57,
    run: (text) =>
      allMatches(text, /\b(?:exaggerate|boost)\s+relief\s*(?:(\d+(?:\.\d+)?)\s*(?:×|x|times)?|(\d+)\s*fold)\b/gi, (m) => {
        const n = Number(m[1] ?? m[2]);
        if (!Number.isFinite(n) || n <= 0) return null;
        return {
          start: m.index!,
          end: m.index! + m[0].length,
          patch: { autoDimension: { faces: [], reliefExaggeration: n } },
          note: `relief exaggeration ${n}×`,
        };
      }, 57),
  });
}

export function buildRuleRegistry(): DesignRule[] {
  const rules = [...CORE_RULES];
  registerAutoDimensionRules(rules);
  registerMapParserRules(rules);
  return rules;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function overlaps(a: RuleMatch, b: RuleMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

export function resolveMatches(matches: RuleMatch[]): { kept: RuleMatch[]; patch: ProjectPatch; notes: string[] } {
  const sorted = [...matches].sort((a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start));
  const kept: RuleMatch[] = [];
  for (const m of sorted) {
    if (kept.some((k) => overlaps(k, m))) continue;
    kept.push(m);
  }
  kept.sort((a, b) => a.start - b.start);
  let patch: ProjectPatch = {};
  const notes: string[] = [];
  for (const m of kept) {
    patch = mergePatches(patch, m.patch);
    if (m.note) notes.push(m.note);
  }
  return { kept, patch, notes };
}

export function unrecognisedSpans(text: string, matched: Span[]): Span[] {
  if (!text.length) return [];
  const ranges = [...matched].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) pushGap(text, pos, r.start, out);
    pos = Math.max(pos, r.end);
  }
  if (pos < text.length) pushGap(text, pos, text.length, out);
  return out;
}

function pushGap(text: string, start: number, end: number, out: Span[]) {
  const slice = text.slice(start, end);
  const trimmed = slice.replace(/^[\s,.;]+|[\s,.;]+$/g, '');
  if (!trimmed) return;
  const lead = slice.length - slice.trimStart().length;
  const trail = slice.length - slice.trimEnd().length;
  out.push({ start: start + lead, end: end - trail });
}

/** Param ids the rule set is intended to cover (for tests and PR notes). */
export const DESIGN_PARAM_COVERAGE = [
  'plateCount',
  'thickness',
  'plateMaterial',
  'sliceMode',
  'radialCount',
  'masterScale',
  'erosionAmp',
  'erosionScale',
  'imgSideMode',
  'imgFrontMode',
  'imgTopMode',
  'etchMode',
  'imgBlurType',
  'imgSmooth',
  'tuneMode',
  'tuneWords',
  'kerf',
  'sheetWidth',
  'sheetHeight',
  'partPrefix',
  'stackHeight',
  'baseLength',
  'baseWidth',
  'plateGap',
  'spacingMode',
  'baseOn',
  'strataOn',
  'imageOn',
  'rodsOn',
] as const;
