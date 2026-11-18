/**
 * preview-size.ts — 预览分辨率与输出分辨率的解耦。
 *
 * 移植自 openmosh gl/preview-size.ts（MIT，见 CREDITS.md）。
 * 预览画布按输出宽高比适配到显示区域（设备像素），**默认**永不超过输出尺寸
 * （`k = Math.min(1, scale)` —— 放得再大也只是插值，白烧显存）；
 * 导出时渲染器切到真实输出分辨率，导完切回。
 *
 * 唯一的例外是**全屏预览**（`allowUpscale`）：屏幕比输出分辨率还大时，
 * 允许放大到显示尺寸，否则「全屏」看到的是一张被放大过的小图。
 * 仍受 `UPSCALE_CAP` 约束 —— 4K 屏上放 1080p 工程不会去分一块 8 兆像素
 * 的缓冲（那正是导出才舍得花的钱）。
 *
 * UNMEASURED_MAX_PIXELS：显示尺寸还量不到时（元素隐藏也算 0），
 * 绝不能退回输出分辨率——4K 输出会在此刻按 8 兆像素分配画布、
 * ping-pong、present 和每个反馈缓冲，这是全应用最大的一笔 GPU 分配，
 * 偏偏发生在最不了解需求的时刻。
 */

import { evenDims } from '../core/dims';

export interface PreviewSize {
  width: number;
  height: number;
}

const UNMEASURED_MAX_PIXELS = 1280 * 720;

/** 全屏放大的上限（相对输出尺寸）。2× 已经是「屏幕比工程大一圈」的极限。 */
const UPSCALE_CAP = 2;

export interface FitPreviewOptions {
  /** true = 允许放大到显示尺寸（仍受 UPSCALE_CAP 约束）。默认 false = 只缩不放。 */
  allowUpscale?: boolean;
}

export function fitPreviewSize(
  outputWidth: number | undefined,
  outputHeight: number | undefined,
  displayWidth: number,
  displayHeight: number,
  opts: FitPreviewOptions = {},
): PreviewSize | null {
  if (!outputWidth || !outputHeight || outputWidth <= 0 || outputHeight <= 0) {
    return null;
  }
  const scale =
    displayWidth <= 0 || displayHeight <= 0
      ? Math.sqrt(UNMEASURED_MAX_PIXELS / (outputWidth * outputHeight))
      : Math.min(displayWidth / outputWidth, displayHeight / outputHeight);
  const k = opts.allowUpscale ? Math.min(scale, UPSCALE_CAP) : Math.min(1, scale);
  /*
   * 缓冲尺寸**取偶**（`core/dims.ts`）：预览缓冲不只是显示用的 —— 预览缓存的
   * 离屏烘焙按 `kit.w/h` 建渲染目标，而 H.264 对奇数宽高一律拒绝。
   * 最多差 1 像素，CSS 盒仍然按适配尺寸钉住（见 `renderer.applyCanvasCssSize`）。
   */
  const { w, h } = evenDims(
    Math.max(2, Math.round(outputWidth * k)),
    Math.max(2, Math.round(outputHeight * k)),
  );
  return { width: w, height: h };
}

export function measureDisplaySize(el: Element): { width: number; height: number } {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
}
