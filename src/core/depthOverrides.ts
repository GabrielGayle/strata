import type { DepthData, DepthSettingKey, DepthSettings, DepthSettingsOverrides } from './depth';
import { defaultDepthSettings } from './depth';

export type { DepthSettingKey, DepthSettingsOverrides };

export const DEPTH_SETTING_KEYS: DepthSettingKey[] = [
  'near',
  'far',
  'curve',
  'flatten',
  'spacing',
  'resolution',
  'matte',
  'invert',
  'squash',
  'detail',
  'outline',
  'outlineWidth',
  'feather',
];

/** Bas-relief shaping: user-only, so a rebuild keeps whatever was set. */
const BAS_RELIEF_KEYS = ['squash', 'detail', 'outline', 'outlineWidth', 'feather'] as const;

export function markDepthSettingOverrides(
  prev: DepthSettingsOverrides | undefined,
  patch: Partial<DepthSettings>,
): DepthSettingsOverrides {
  const out: DepthSettingsOverrides = { ...prev };
  for (const k of DEPTH_SETTING_KEYS) {
    if (patch[k] !== undefined) out[k] = true;
  }
  return out;
}

function applyOverridesToSettings(base: DepthSettings, prev: DepthSettings, overrides: DepthSettingsOverrides): DepthSettings {
  const out = { ...base };
  if (overrides.near) out.near = prev.near;
  if (overrides.far) out.far = prev.far;
  if (overrides.curve) out.curve = prev.curve;
  if (overrides.flatten) out.flatten = prev.flatten;
  if (overrides.spacing) out.spacing = prev.spacing;
  if (overrides.resolution) out.resolution = prev.resolution;
  if (overrides.matte) out.matte = prev.matte;
  if (overrides.invert) out.invert = prev.invert;
  for (const k of BAS_RELIEF_KEYS) if (overrides[k] && prev[k] !== undefined) out[k] = prev[k];
  return out;
}

/** Keep user-tuned depth window/settings when elevation data is rebuilt (map terrain, etc.). */
export function mergeDepthAfterRebuild(prev: DepthData | undefined, next: DepthData): DepthData {
  if (!prev?.settingsOverrides || !Object.keys(prev.settingsOverrides).length) return next;
  return {
    ...next,
    settings: applyOverridesToSettings(next.settings, prev.settings, prev.settingsOverrides),
    settingsOverrides: { ...prev.settingsOverrides },
  };
}

export function resetDepthSettingsToAuto(
  depth: DepthData,
  keys: DepthSettingKey[] = ['near', 'far', 'curve', 'flatten', 'spacing', 'matte'],
): DepthData {
  const auto = defaultDepthSettings(depth, depth.settings.invert);
  const settings = { ...depth.settings };
  const overrides = { ...depth.settingsOverrides };
  for (const k of keys) {
    if (k === 'near') settings.near = auto.near;
    else if (k === 'far') settings.far = auto.far;
    else if (k === 'curve') settings.curve = auto.curve;
    else if (k === 'flatten') settings.flatten = auto.flatten;
    else if (k === 'spacing') settings.spacing = auto.spacing;
    else if (k === 'resolution') settings.resolution = auto.resolution;
    else if (k === 'matte') settings.matte = auto.matte;
    else if (k === 'invert') settings.invert = auto.invert;
    delete overrides[k];
  }
  const settingsOverrides = Object.keys(overrides).length ? overrides : undefined;
  return { ...depth, settings, settingsOverrides };
}
