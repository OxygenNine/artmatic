/**
 * params.ts — 流体的参数表（**唯一真源**）。
 *
 * 顺序即检查器里的顺序：注入 → 流场 → 颜色 → 显示 → 蒙版 → 系统。
 * 文案键一律 `algo.fluid.<key>`（选项 `algo.fluid.<key>.<value>`），
 * 少了任一条会被 `tests/unit/algo-params.test.ts` 挡住。
 *
 * 出厂值一律读 `FLUID_DEFAULTS`（`config.ts`）：参数表与归一化兜底各写一遍的
 * 失效形态是「工程里没有这个键时用 A，有键但值非法时用 B」，只在手改过的
 * 工程文件上出现。`tests/unit/fluid.test.ts` 钉着两边一致。
 *
 * ⚠️ **除 `FLUID_VOLATILE_KEYS` 之外的每一键都进构造哈希** —— 改它们会把模拟
 * 从第 0 步重放。这是必须的：注入量、力、耗散、色相都**写进状态**（染料里
 * 已经有颜色了），不重放就会得到「同一 t 两渲不同」。
 */

import type { AssetParam, ColorParam, ParamDef, RangeParam, SelectParam } from '../../effects/types';
import type { MessageKey } from '../../i18n/locales';
import { bgColorVisible, bgModeParam, intResParam } from '../shader-lib';
import {
  FLUID_DEFAULTS as D,
  FLUID_MASK_CHANNELS,
  FLUID_MOTIONS,
  FLUID_SIM_RES_OPTIONS,
} from './config';

const key = (k: string): MessageKey => `algo.fluid.${k}` as MessageKey;

function range(
  k: string,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  extra: Partial<RangeParam> = {},
): RangeParam {
  return { key: k, labelKey: key(k), type: 'range', min, max, step, defaultValue, ...extra };
}

function select(
  k: string,
  values: readonly string[],
  defaultValue: string,
  extra: Partial<SelectParam> = {},
): SelectParam {
  return {
    key: k,
    labelKey: key(k),
    type: 'select',
    defaultValue,
    options: values.map((v) => ({ labelKey: key(`${k}.${v}`), value: v })),
    ...extra,
  };
}

function color(k: string, defaultValue: string, extra: Partial<ColorParam> = {}): ColorParam {
  return { key: k, labelKey: key(k), type: 'color', defaultValue, ...extra };
}

/** 只在绑定了蒙版图时出现的子项。谓词写 `v.<key>`（点号形式，见 algo-params.test）。 */
const hasMask = (v: Record<string, number | string>): boolean =>
  typeof v.maskAsset === 'string' && v.maskAsset.length > 0;

/** 只在喷嘴会动时出现的子项（`still` 下拖速度没有任何效果）。 */
const moves = (v: Record<string, number | string>): boolean => v.motion !== 'still';

export function fluidParams(): ParamDef[] {
  return [
    /* -------------------------------------------------------------- 注入 */
    // 喷嘴数是整数档位，用 range + step 1（select 也行，但这是「几个」不是「哪种」）。
    range('nozzles', 1, 4, 1, D.nozzles),
    // 注入量 × 注入亮度决定每步的浓度增量；`dyeDissipation` 决定它的半衰期。
    range('inject', 0, 2, 0.01, D.inject),
    range('radius', 0.01, 0.25, 0.002, D.radius),
    range('force', 0, 2, 0.01, D.force),
    select('motion', FLUID_MOTIONS, 'lissajous'),
    range('pathScale', 0, 1, 0.01, D.pathScale, { visibleWhen: moves }),
    range('pathSpeed', 0, 2, 0.01, D.pathSpeed, { visibleWhen: moves }),

    /* -------------------------------------------------------------- 流场 */
    // 涡量增强的单位是「texel/秒²」，看不出物理意义，所以文案只说「涡旋强度」。
    range('curl', 0, 60, 0.5, D.curl),
    // 迭代次数直接乘单步成本：16 次是 456×256 下单步 ≈0.6 ms 的档位。
    range('pressureIter', 1, 32, 1, D.pressureIter),
    range('velDissipation', 0, 3, 0.01, D.velDissipation),
    range('dyeDissipation', 0, 3, 0.01, D.dyeDissipation),

    /* -------------------------------------------------------------- 颜色 */
    range('hue', 0, 1, 0.005, D.hue),
    range('hueSpread', 0, 1, 0.005, D.hueSpread),
    range('saturation', 0, 1, 0.01, D.saturation),
    range('brightness', 0, 2, 0.01, D.brightness),

    /* -------------------------------------------------------------- 显示 */
    range('shading', 0, 1, 0.01, D.shading),
    range('glow', 0, 2, 0.01, D.glow),
    range('hueShift', -0.5, 0.5, 0.005, D.hueShift),
    range('contrast', 0.2, 3, 0.01, D.contrast),

    /* -------------------------------------------------------------- 蒙版 */
    {
      key: 'maskAsset', labelKey: key('maskAsset'), type: 'asset',
      defaultValue: '', accept: 'image',
    } satisfies AssetParam,
    select('maskChannel', FLUID_MASK_CHANNELS, 'luma', { visibleWhen: hasMask }),
    range('maskThreshold', 0, 1, 0.01, D.maskThreshold, { visibleWhen: hasMask }),

    /* -------------------------------------------------------------- 系统 */
    // 模拟分辨率是**质量档**而不是容量档：它只改纹理尺寸，不改构图。
    select('simRes', FLUID_SIM_RES_OPTIONS, D.simRes),
    // `rate` 是步/秒（sim 家族约定），`liveRate` 每帧从当前参数读它，不进构造哈希。
    range('rate', 1, 240, 1, D.rate),
    bgModeParam(),
    color('colorBg', '#08090d', { visibleWhen: bgColorVisible }),
    intResParam(),
  ];
}
