import type { RawValue } from './params';
import type { Project } from './project';

export type UserParamOverrides = Record<string, true>;

export function markUserParamOverrides(prev: UserParamOverrides | undefined, ids: string[]): UserParamOverrides {
  const out: UserParamOverrides = { ...prev };
  for (const id of ids) out[id] = true;
  return out;
}

export function applyParamPatchRespectingOverrides(
  params: Record<string, RawValue>,
  patch: Record<string, RawValue>,
  overrides: UserParamOverrides | undefined,
): Record<string, RawValue> {
  if (!overrides || !Object.keys(overrides).length) return { ...params, ...patch };
  const out = { ...params };
  for (const [id, val] of Object.entries(patch)) {
    if (!overrides[id]) out[id] = val;
  }
  return out;
}

export function masterSizeBlocked(overrides: UserParamOverrides | undefined): boolean {
  return !!(overrides?.baseLength || overrides?.baseWidth || overrides?.masterScale);
}

export function withUserParamOverrides(project: Project, ids: string[]): Project {
  const userParamOverrides = markUserParamOverrides(project.userParamOverrides, ids);
  return userParamOverrides === project.userParamOverrides ? project : { ...project, userParamOverrides };
}
