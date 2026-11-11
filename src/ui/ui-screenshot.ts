/**
 * ui-screenshot.ts — 把**整个 Artmatic 界面**截成一张 PNG（Agent 的 `ui_screenshot`）。
 *
 * 为什么是 snapDOM 而不是别的：
 *  - 浏览器没有「截我自己的 DOM」API。`getDisplayMedia` 要用户授权、还会把整个
 *    桌面拖进来；Electron 的 `desktopCapturer` 只在壳里存在（硬约束：内核必须是
 *    标准 Web 应用）。
 *  - snapDOM 已经是排版光栅化的后端，行为与坑都被踩过一轮（见
 *    `typography/backends/dom-snap.ts`）。这里复用它，不引第二个依赖。
 *
 * 三件必须知道的事：
 *  1. **WebGL 画布能截到**，因为 `Kit` 的上下文带 `preserveDrawingBuffer: true`
 *     （`engine/kit.ts` 的第一条红线）。少了它这里会得到一块空白预览。
 *  2. **只截 `#app`**。Modal / 菜单 / 提示条被 portal 到 `document.body`，
 *     它们不在这一棵子里 —— 那是刻意的：截图要回答「界面长什么样」，不是
 *     「某个对话框长什么样」（对话框的内容本来就有结构化读数）。
 *  3. **长边压在 1600 px**：截图是给模型读的，2K 屏原尺寸只会把 token 吃掉
 *     一倍多，而模型分辨不出多出来的那点像素。`scale` 让调用方再往下调。
 */

import { snapdom } from '@zumer/snapdom';

/** 长边上限。超过它按比例缩，`scale` 在这个上限之内仍可继续下调。 */
export const UI_SHOT_MAX_SIDE = 1600;

/** 允许的输出倍率范围（再大只是烧 token）。 */
export const UI_SHOT_SCALE_RANGE: [number, number] = [0.25, 2];

export interface UiScreenshot {
  bytes: Uint8Array;
  w: number;
  h: number;
  /** snapDOM 的降级记录（阴影 / 背景滤镜 / 跨域资源）。给模型一句话，不猜。 */
  warnings: string[];
}

/** 截一张整个界面的 PNG。失败时抛错（调用方负责翻译成 `ControlFailure`）。 */
export async function captureUiScreenshot(scale = 1): Promise<UiScreenshot> {
  const root = document.getElementById('app');
  if (!root) throw new Error('ui root not mounted');

  const rect = root.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) throw new Error('ui is not visible');

  const wanted = Number.isFinite(scale)
    ? Math.min(UI_SHOT_SCALE_RANGE[1], Math.max(UI_SHOT_SCALE_RANGE[0], scale))
    : 1;
  /*
   * 长边上限是**硬上限**，不是「按比例再乘一次」：2K 屏 + scale 2 会得到
   * 5000px 的图，模型既读不出更多信息，又要为它付几倍 token。
   * 所以取 `min(请求倍率, 上限/长边)` —— 窗口比上限小时倍率照常生效。
   */
  const effective = Math.min(wanted, UI_SHOT_MAX_SIDE / Math.max(rect.width, rect.height));

  /*
   * `dpr: 1` 是必须的：snapDOM 默认用 `devicePixelRatio`，同一份代码在 2K 屏
   * 上会产出两倍像素 —— 模型看到的图与这里声明的 w/h 对不上，而且换台机器才复现。
   */
  const shot = await snapdom(root, { scale: effective, dpr: 1, fast: false });
  const blob = await shot.toBlob({ format: 'png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    bytes,
    w: Math.max(1, Math.round(rect.width * effective)),
    h: Math.max(1, Math.round(rect.height * effective)),
    warnings: shot.warnings.map((w) => String(w.code ?? w.message)),
  };
}
