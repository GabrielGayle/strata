// What a parameter formula can name: every number parameter, the model flags, the
// constants and the functions. The ƒ box's picker lists these, so it must match what
// evaluateParams accepts (test/formula-vars.test.ts checks it does).
import { CONST_VALUES, FUNC_NAMES } from './expr';
import { FLAG_NAMES, GROUPS, PARAMS, downstream, type Values } from './params';

export type FormulaVarKind = 'param' | 'flag' | 'const' | 'func';

export interface FormulaVar {
  name: string;
  label: string;
  /** Heading it is listed under: a parameter group, or Model / Constants / Functions. */
  group: string;
  kind: FormulaVarKind;
  value?: number;
  unit?: string;
  /** What clicking it types: the name, or `name(` for a function. */
  insert: string;
  /** Set when using it here would be refused (it already reads this setting). */
  blocked?: string;
}

export const FLAG_LABELS: Record<string, string> = {
  alongWidth: 'Slicing along the width (1 yes, 0 no)',
  isRadial: 'Radial slicing (1 yes, 0 no)',
  isWaffle: 'Waffle slicing (1 yes, 0 no)',
  imgAspect: 'Top image width ÷ height',
  frontAspect: 'Front image width ÷ height',
  sideAspect: 'Side image width ÷ height',
};

export const FUNC_LABELS: Record<string, string> = {
  floor: 'floor(x): round down',
  ceil: 'ceil(x): round up',
  round: 'round(x): nearest whole number',
  abs: 'abs(x): without the sign',
  sqrt: 'sqrt(x): square root',
  sin: 'sin(degrees)',
  cos: 'cos(degrees)',
  tan: 'tan(degrees)',
  atan: 'atan(x): angle in degrees',
  min: 'min(a, b, …): smallest',
  max: 'max(a, b, …): largest',
  clamp: 'clamp(x, lo, hi): keep x between lo and hi',
  lerp: 'lerp(a, b, t): a to b by t (0…1)',
  pow: 'pow(x, y): x to the power y',
  log: 'log(x): natural log',
  exp: 'exp(x): e to the power x',
};

const CONST_LABELS: Record<string, string> = { pi: 'π, 3.14159…', e: 'e, 2.71828…' };

export const MODEL_GROUP = 'Model';
export const CONST_GROUP = 'Constants';
export const FUNC_GROUP = 'Functions';

/**
 * Everything the formula for `selfId` can use, in panel order with its own group first.
 * `self` is left out (a formula can't refer to itself); settings that already read it
 * are kept but `blocked`, since using them would loop.
 */
export function formulaVars(selfId: string, values: Values, flags: Record<string, number> = {}, deps: Record<string, string[]> = {}): FormulaVar[] {
  const loops = downstream(selfId, deps);
  const own = PARAMS.find((p) => p.id === selfId)?.group;
  const groups = own ? [own, ...GROUPS.filter((g) => g !== own)] : [...GROUPS];
  const out: FormulaVar[] = [];
  for (const g of groups)
    for (const p of PARAMS)
      if (p.group === g && p.kind === 'number' && p.id !== selfId)
        out.push({
          name: p.id,
          label: p.label,
          group: g,
          kind: 'param',
          value: typeof values[p.id] === 'number' ? values[p.id] : undefined,
          unit: p.unit,
          insert: p.id,
          blocked: loops.has(p.id) ? `${p.label} already uses this setting` : undefined,
        });
  for (const f of FLAG_NAMES) out.push({ name: f, label: FLAG_LABELS[f] ?? f, group: MODEL_GROUP, kind: 'flag', value: flags[f], insert: f });
  // PI is the same as pi; list it once
  for (const c of Object.keys(CONST_VALUES).filter((c) => c !== 'PI'))
    out.push({ name: c, label: CONST_LABELS[c] ?? c, group: CONST_GROUP, kind: 'const', value: CONST_VALUES[c], insert: c });
  for (const f of FUNC_NAMES) out.push({ name: f, label: FUNC_LABELS[f] ?? `${f}(…)`, group: FUNC_GROUP, kind: 'func', insert: `${f}(` });
  return out;
}

/** The name being typed at the caret: the run of letters, digits and _ before it (and after it). */
export function wordAt(text: string, caret: number): { start: number; end: number; word: string } {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  const word = text.slice(start, caret);
  // a number isn't the start of a name
  if (/^[0-9.]/.test(word)) return { start: caret, end: caret, word: '' };
  return { start, end, word };
}

/**
 * Filter for what's typed so far. Names that start with it come first, then names that
 * contain it, then labels that contain it; each keeps its listed order.
 */
export function matchVars(vars: FormulaVar[], word: string): FormulaVar[] {
  const w = word.trim().toLowerCase();
  if (!w) return vars;
  const starts: FormulaVar[] = [];
  const inName: FormulaVar[] = [];
  const inLabel: FormulaVar[] = [];
  for (const v of vars) {
    const n = v.name.toLowerCase();
    if (n.startsWith(w)) starts.push(v);
    else if (n.includes(w)) inName.push(v);
    else if (v.label.toLowerCase().includes(w)) inLabel.push(v);
  }
  return [...starts, ...inName, ...inLabel];
}

/** Put `v` in at the caret, replacing the name being typed there (or the selection). */
export function insertVar(text: string, selStart: number, selEnd: number, v: Pick<FormulaVar, 'insert'>): { text: string; caret: number } {
  let start = selStart;
  let end = selEnd;
  if (selStart === selEnd) ({ start, end } = wordAt(text, selStart));
  // a function already followed by its bracket doesn't get a second one
  const ins = v.insert.endsWith('(') && text[end] === '(' ? v.insert.slice(0, -1) : v.insert;
  const next = text.slice(0, start) + ins + text.slice(end);
  return { text: next, caret: start + ins.length + (ins !== v.insert ? 1 : 0) };
}
