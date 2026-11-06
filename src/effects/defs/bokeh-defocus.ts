import type { ParamDef } from '../types';

export const id = 'bokeh-defocus';
export const nameKey = 'fx.bokehDefocus';
export const params: ParamDef[] = [
  { key: 'threshold', labelKey: 'fx.bokehDefocus.threshold', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.65 },
  // 圆盘半径按**输出像素**给（与 tile-shuffle 的格子同理：与分辨率无关的观感）。
  // 去细节那两级高斯的半径跟着它走（见 glsl 里的 setUniforms），不单独开滑杆 ——
  // 两者脱钩只会得到「糊了但没有光斑」或「光斑飘在清晰的画面上」。
  { key: 'bokeh', labelKey: 'fx.bokehDefocus.bokeh', type: 'range', min: 4, max: 80, step: 1, defaultValue: 28 },
  { key: 'gain', labelKey: 'fx.bokehDefocus.gain', type: 'range', min: 0, max: 4, step: 0.05, defaultValue: 1 },
  { key: 'amount', labelKey: 'fx.bokehDefocus.amount', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 1 },
];
