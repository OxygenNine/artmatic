/**
 * dims.ts — 尺寸规整的唯一真源。
 *
 * 只有一件事：**H.264 编码器只吃偶数宽高**。
 *
 * 为什么值得单独一个文件：宽高在本项目里常年来自布局像素（预览缓冲 1183×665、
 * 853×480 都很正常），而偶数这条约束同时约束着三个地方 —— 预览缓冲（离屏烘焙
 * 按它建目标）、缓存的编码尺寸、以及缓存条目里记的 `w/h`（键的一部分）。
 * 三处各写一遍 `n - (n % 2)` 的后果是「某一处忘了 ⇒ 缓存永远不命中」或
 * 「编码器四档全不支持 ⇒ 报成『本机没有 H.264』」，两种都不报错。
 */

/** 宽高向下取到 ≥2 的偶数；非有限值按 2 处理。幂等。 */
export function evenDims(w: number, h: number): { w: number; h: number } {
  const even = (v: number): number => {
    const n = Math.max(2, Math.round(Number.isFinite(v) ? v : 2));
    return n - (n % 2);
  };
  return { w: even(w), h: even(h) };
}
