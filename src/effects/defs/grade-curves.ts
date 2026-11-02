import type { ParamDef } from '../types';
import type { MessageKey } from '../../i18n/locales';

/**
 * `grade-curves` 没有 `ParamDef`。
 *
 * 四条曲线存在 `values` 的保留键 `curve#master` / `curve#r` / `curve#g` /
 * `curve#b` 里（紧凑串）。这不是偷懒：检查器的一行一个滑杆只能表达标量，
 * 把一条曲线压成一个滑杆（「拉多少」）会把 S 曲线直接砍掉一半能力。
 * 编辑入口是调色面板的曲线区，见 `ui/grade/ToneCurveEditor.svelte`。
 */
export const id = 'grade-curves';
export const nameKey: MessageKey = 'fx.gradeCurves';
export const params: ParamDef[] = [];
