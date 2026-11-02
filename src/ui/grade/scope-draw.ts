/**
 * scope-draw.ts — 示波器的**纯计算**：探针帧 → 密度网格。
 *
 * 组件只负责把网格变成像素，所有数学都在这里，因为「读数对不对」只能靠断言
 * 数字来验（截图里一条绿线是看不出它是不是把暗部算到亮部的）。
 *
 * 四种读法共用一份输入：
 *  - 波形：x = 横向位置，y = 该列亮度；
 *  - 分量：三份波形并排，各看自己那个通道；
 *  - 矢量：Cb/Cr 平面上的密度；
 *  - 直方图：256 桶 × R/G/B/luma。
 *
 * 口径默认**编码值**（直接读回 sRGB 字节，0..100 IRE 的直觉），不换算线性 ——
 * 示波器的意义是「和画面上看到的一致」，不是和达芬奇的示波器一致。
 */

import type { ScopeFrame } from '../../engine/compositor';

export type ScopeMode = 'waveform' | 'parade' | 'vector' | 'histogram';

/** 709 亮度（与调色 shader 同一组系数）。 */
export function luma01(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 波形网格：`outW × outH` 的密度（0..1，已按最大值归一）。
 *
 * `channel` 决定纵轴取哪一路；`x0/xSpan` 允许把三条波形并排塞进同一张图
 * （分量视图用）。
 */
export function renderWaveform(
  frame: ScopeFrame,
  outW: number,
  outH: number,
  channel: 'luma' | 'r' | 'g' | 'b' = 'luma',
  x0 = 0,
  xSpan = outW,
): Float32Array {
  const grid = new Float32Array(outW * outH);
  const { data, w, h } = frame;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const v = channel === 'r' ? r / 255 : channel === 'g' ? g / 255 : channel === 'b' ? b / 255 : luma01(r, g, b);
      const col = x0 + Math.min(xSpan - 1, Math.floor((x / w) * xSpan));
      // 上往下：亮部在上（与示波器的习惯一致）
      const row = Math.min(outH - 1, Math.floor((1 - v) * (outH - 1)));
      grid[row * outW + col] = (grid[row * outW + col] ?? 0) + 1;
    }
  }
  return normalize(grid);
}

/** 分量视图：R / G / B 三条并排，各自占宽度的三分之一。 */
export function renderParade(frame: ScopeFrame, outW: number, outH: number): {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
} {
  const third = Math.max(1, Math.floor(outW / 3));
  return {
    r: renderWaveform(frame, outW, outH, 'r', 0, third),
    g: renderWaveform(frame, outW, outH, 'g', third, third),
    b: renderWaveform(frame, outW, outH, 'b', third * 2, third),
  };
}

/**
 * 矢量示波器：Cb/Cr 平面上的密度（`size × size`）。
 *
 * 用 BT.601 的 Cb/Cr 系数（与抠图的色度差同一族），因为「矢量示波器」在
 * 用户心里就是 601 的那张六角图。灰轴（Cb = Cr = 0）落在正中心。
 */
export function renderVectorscope(frame: ScopeFrame, size: number): Float32Array {
  const grid = new Float32Array(size * size);
  const { data, w, h } = frame;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  // ±0.6 的色度范围够放下整个可见域（601 的最大色度约 ±0.5）
  const scale = (size - 1) / 1.2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
      const px = Math.round(cx + cb * scale);
      // 屏幕 y 向下，Cr 向上 —— 与矢量图「红在右上」的读法一致
      const py = Math.round(cy - cr * scale);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      grid[py * size + px] = (grid[py * size + px] ?? 0) + 1;
    }
  }
  return normalize(grid);
}

/** 直方图：四组 256 桶（R / G / B / luma），按各自最大值归一。 */
export function renderHistogram(frame: ScopeFrame): {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  l: Float32Array;
} {
  const r = new Float32Array(256);
  const g = new Float32Array(256);
  const b = new Float32Array(256);
  const l = new Float32Array(256);
  const { data } = frame;
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]!] = (r[data[i]!] ?? 0) + 1;
    g[data[i + 1]!] = (g[data[i + 1]!] ?? 0) + 1;
    b[data[i + 2]!] = (b[data[i + 2]!] ?? 0) + 1;
    const y = Math.round(luma01(data[i]!, data[i + 1]!, data[i + 2]!) * 255);
    l[Math.min(255, y)] = (l[Math.min(255, y)] ?? 0) + 1;
  }
  return { r: normalize(r), g: normalize(g), b: normalize(b), l: normalize(l) };
}

/** 除以最大值；全零时原样返回（调用方画出来就是空的）。 */
function normalize(grid: Float32Array): Float32Array {
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  if (max <= 0) return grid;
  for (let i = 0; i < grid.length; i += 1) grid[i] = grid[i]! / max;
  return grid;
}
