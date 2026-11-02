import type { ParamDef } from '../types';
import type { MessageKey } from '../../i18n/locales';

/** 四个轮盘组名（= 参数键前缀）。导出给 `ui/grade` 与测试共用一份。 */
export type WheelGroup = 'lift' | 'gamma' | 'gain' | 'offset';

/**
 * `grade-basic` 的参数表。
 *
 * 四个轮盘各自拆成「一个主量 + 三个方向分量」：`lift#m` 与 `lift#r/g/b`
 * 等等。分量存的是**零亮度方向向量**（值域 `-1..1`，见
 * `ui/grade/wheel-model.ts`），量纲由 shader 决定。
 *
 * 四个轮盘的分工（与达芬奇一致）：暗部 / 中间调 / 高光各管一段影调，**偏移**
 * 是「整体」（连黑位一起动）。参数表里它排最后（与调色台的界面同序），
 * shader 里它是第一步 —— 心智模型是「先整体、再分段」。
 *
 * 键名带 `#` 是既有约定（`transitions/params.ts` 已有 `foo#0` 的先例）：
 * 一个 UI 上的二维控件落成若干扁平标量，而 `values` 只认 `number | string`。
 * **不要**把它们改成三个独立滑杆组成的「色轮」—— 那样用户就无法把一个
 * 「红往青推」当成一个动作撤销。
 *
 * `labelKey` 必须是字面量（`MessageKey` 是字符串字面量联合），所以每个键
 * 单独写，不用模板串拼出来。
 */
function wheel(
  group: WheelGroup,
  labels: { m: MessageKey; r: MessageKey; g: MessageKey; b: MessageKey },
  master: { min: number; max: number; step: number; defaultValue: number },
): ParamDef[] {
  return [
    { key: `${group}#m`, labelKey: labels.m, type: 'range', ...master },
    { key: `${group}#r`, labelKey: labels.r, type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
    { key: `${group}#g`, labelKey: labels.g, type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
    { key: `${group}#b`, labelKey: labels.b, type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
  ];
}

export const id = 'grade-basic';
export const nameKey: MessageKey = 'fx.gradeBasic';
export const params: ParamDef[] = [
  // 暗部：加性偏移（线性域），主量 ±0.5 足够把黑位抬起或压死。
  ...wheel(
    'lift',
    {
      m: 'fx.gradeBasic.liftM',
      r: 'fx.gradeBasic.liftR',
      g: 'fx.gradeBasic.liftG',
      b: 'fx.gradeBasic.liftB',
    },
    { min: -0.5, max: 0.5, step: 0.01, defaultValue: 0 },
  ),
  // 中间调：gamma 乘数，1 = 不变。
  ...wheel(
    'gamma',
    {
      m: 'fx.gradeBasic.gammaM',
      r: 'fx.gradeBasic.gammaR',
      g: 'fx.gradeBasic.gammaG',
      b: 'fx.gradeBasic.gammaB',
    },
    { min: 0.2, max: 3, step: 0.01, defaultValue: 1 },
  ),
  // 亮部：EV（显示 `2^EV` 由色轮面板负责，参数存的就是 EV）。
  ...wheel(
    'gain',
    {
      m: 'fx.gradeBasic.gainM',
      r: 'fx.gradeBasic.gainR',
      g: 'fx.gradeBasic.gainG',
      b: 'fx.gradeBasic.gainB',
    },
    { min: -3, max: 3, step: 0.05, defaultValue: 0 },
  ),
  // 偏移：整体曝光 / 色偏（连黑位一起动），量纲与 gain 一样是 EV。
  ...wheel(
    'offset',
    {
      m: 'fx.gradeBasic.offsetM',
      r: 'fx.gradeBasic.offsetR',
      g: 'fx.gradeBasic.offsetG',
      b: 'fx.gradeBasic.offsetB',
    },
    { min: -2, max: 2, step: 0.05, defaultValue: 0 },
  ),
  { key: 'contrast', labelKey: 'fx.gradeBasic.contrast', type: 'range', min: 0.5, max: 2, step: 0.01, defaultValue: 1 },
  { key: 'saturation', labelKey: 'fx.gradeBasic.saturation', type: 'range', min: 0, max: 2, step: 0.01, defaultValue: 1 },
  { key: 'hue', labelKey: 'fx.gradeBasic.hue', type: 'range', min: -180, max: 180, step: 1, defaultValue: 0 },
  { key: 'temp', labelKey: 'fx.gradeBasic.temp', type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
  { key: 'tint', labelKey: 'fx.gradeBasic.tint', type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
];
