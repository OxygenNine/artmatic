import type { ParamDef } from '../types';

export const id = 'soviet-quality';
export const nameKey = 'fx.sovietQuality';
export const params: ParamDef[] = [
  { key: 'lines', labelKey: 'fx.sovietQuality.lines', type: 'range', min: 40, max: 480, step: 1, defaultValue: 120 },
  { key: 'levels', labelKey: 'fx.sovietQuality.levels', type: 'range', min: 2, max: 32, step: 1, defaultValue: 8 },
  { key: 'chroma', labelKey: 'fx.sovietQuality.chroma', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
  { key: 'noise', labelKey: 'fx.sovietQuality.noise', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.3 },
  { key: 'tint', labelKey: 'fx.sovietQuality.tint', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
  { key: 'dither', labelKey: 'fx.sovietQuality.dither', type: 'checkbox', defaultValue: 0 },
];
