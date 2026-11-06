import type { ParamDef } from '../types';

export const id = 'hold-trail';
export const nameKey = 'fx.holdTrail';
export const params: ParamDef[] = [
  // 间隔按**帧**给（工程帧率）：用户说的是「每几帧盖一个」，不是「每秒盖几次」。
  { key: 'hold', labelKey: 'fx.holdTrail.hold', type: 'range', min: 1, max: 12, step: 1, defaultValue: 2 },
  /*
   * 叠法。缺省是「叠印」—— 新帧整帧盖在历史上，靠的是素材自己的 alpha。
   * 不透明素材（视频 / 满幅底图）没有 alpha 可用，整帧叠印等于原图，
   * 所以要给两条按亮度取一侧的路子。
   */
  {
    key: 'mode',
    labelKey: 'fx.holdTrail.mode',
    type: 'select',
    defaultValue: 'stamp',
    options: [
      { labelKey: 'fx.holdTrail.modeStamp', value: 'stamp' },
      { labelKey: 'fx.holdTrail.modeLighten', value: 'lighten' },
      { labelKey: 'fx.holdTrail.modeDarken', value: 'darken' },
    ],
  },
];
