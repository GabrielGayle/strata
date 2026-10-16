// Which parameters differ from their defaults, per panel, and the patch that puts a panel back.
import { PARAMS, PARAM_MAP, type ParamDef, type RawValue } from './params';
import { isLiteral } from './expr';

const asBool = (x: RawValue) => x === true || x === 'true' || x === 1 || x === '1';

/** Same value as the default, allowing for "120" vs "120.0", true vs "true" and colour case. */
export function isDefault(def: ParamDef, raw: RawValue | undefined): boolean {
  if (raw === undefined) return true;
  if (def.kind === 'toggle') return asBool(raw) === asBool(def.def);
  const a = String(raw).trim();
  const b = String(def.def).trim();
  if (def.kind === 'number' && isLiteral(a) && isLiteral(b)) return parseFloat(a) === parseFloat(b);
  if (def.kind === 'number') return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  if (def.kind === 'color') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Ids of every parameter (optionally in one group) whose stored value is not its default. */
export function changedIds(params: Record<string, RawValue>, group?: string): string[] {
  return PARAMS.filter((p) => (!group || p.group === group) && !isDefault(p, params[p.id])).map((p) => p.id);
}

/** Changed parameter ids keyed by group; groups with no changes are left out. */
export function changedByGroup(params: Record<string, RawValue>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of changedIds(params)) (out[PARAM_MAP[id].group] ??= []).push(id);
  return out;
}

/** The patch that puts every changed parameter in `group` back to its default (empty when nothing differs). */
export function resetGroupPatch(params: Record<string, RawValue>, group: string): Record<string, RawValue> {
  return Object.fromEntries(changedIds(params, group).map((id) => [id, PARAM_MAP[id].def]));
}
