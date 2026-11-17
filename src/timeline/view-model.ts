/**
 * view-model.ts — 时间轴坐标换算。
 *
 * 唯一的横向尺度是 pxPerBeat（缩放以拍为单位，跟着拍网格走——
 * 改了 BPM 布局不需要重新标定）。秒 ↔ 像素的换算都必须经过这里，
 * 不许在组件里另写一套。
 */

import { beatDur, type BeatGrid, type SnapMode } from '../core/time';
import { DENSITY } from '../ui/tokens';

export function pxPerSec(pxPerBeat: number, grid: BeatGrid): number {
  return pxPerBeat / beatDur(grid);
}

export function xOfTime(t: number, pxPerBeat: number, grid: BeatGrid): number {
  return t * pxPerSec(pxPerBeat, grid);
}

export function timeAtX(x: number, pxPerBeat: number, grid: BeatGrid): number {
  return x / pxPerSec(pxPerBeat, grid);
}

/**
 * 第 `b` 拍的内容 x。**offset 必须在这里计入**。
 *
 * 拍线位置 = `offset 秒的 x + b × pxPerBeat`。标尺与网格线都走它：以前两处
 * 各自写 `b * pxPerBeat`，`offset ≠ 0` 时线画在第 0 拍的位置、吸附却对齐
 * 「offset 之后」的拍 —— 表现是播放头永远压不上刻度，而看起来像渲染错位。
 */
export function xOfBeat(b: number, pxPerBeat: number, grid: BeatGrid): number {
  return xOfTime(grid.offset + b * beatDur(grid), pxPerBeat, grid);
}

/**
 * 行高与标尺高。数值来自 ui/tokens.ts 的 DENSITY——Canvas 数学要的是数字，
 * CSS 要的是 `--row-h: 28px`，两边必须同一个源，否则网格线和片段 DOM 会错位。
 */
export const RULER_HEIGHT = DENSITY.rulerH;
export const ROW_HEIGHT = DENSITY.rowH;

/**
 * 标尺上方的段落带高度（px）。
 *
 * **不是画在 `canvas.ruler` 里**：段落带要做双击改名、右键菜单、拖动落点，
 * 这些都得有 DOM；而 12px 高的画布条带里既放不下输入框，也没有 title 可读。
 * 所以带子是标尺上方一条独立的 DOM 层，标尺本身（`drawRuler`）一行不改 ——
 * 「不改画布结构」这条要求因此仍然成立。
 */
export const SECTION_BAND_HEIGHT = 12;

/**
 * 时间轴形态：同一份数据、同一套片段几何，只有标尺文案与吸附默认值不同。
 * 值存 `UiPrefs.timelineMode`（跟着人走，不进工程 —— 换台机器打开同一份工程
 * 不该被别人的阅读习惯影响）。
 */
export type TimelineMode = 'beat' | 'standard';

/** 形态的图标（工具条上的两态按钮按当前形态取一个）。 */
export const TIMELINE_MODE_ICONS: Record<TimelineMode, 'activity' | 'timer'> = {
  beat: 'activity',
  standard: 'timer',
};

/**
 * 每个形态下**可选**的吸附档位（顺序即工具条里的顺序）。
 *
 * 为什么必须分：半拍 / 拍 / 小节都是**拍单位**，标准模式的标尺上根本没有拍
 * （只有时间码），列出来只会让人选到一个「吸附到哪里看不出来」的格子。
 * 标准模式给「自由 / 帧」——帧是那个形态的原子单位，与时间码小数位同源。
 *
 * `magnet` 两个形态都有：它吸的是**元素**（片段边界 / 段落 / 节奏点），
 * 与标尺怎么读数无关 —— 标准模式下它同样有意义（「贴着片段剪」）。
 */
export const SNAP_MODES_FOR: Record<TimelineMode, readonly SnapMode[]> = {
  beat: ['bar', 'beat', 'half', 'magnet', 'free'],
  standard: ['magnet', 'free', 'frame'],
};

export function snapFitsMode(mode: SnapMode, timeline: TimelineMode): boolean {
  return SNAP_MODES_FOR[timeline].includes(mode);
}

/** 形态的默认吸附档位：节奏贴小节、标准不吸附。 */
export function defaultSnapForMode(mode: TimelineMode): SnapMode {
  return mode === 'beat' ? 'bar' : 'free';
}
