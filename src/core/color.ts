/**
 * color.ts — 颜色的纯函数工具（core 层：无 DOM / WebGL，可单测）。
 *
 * 从 `engine/sources.ts` 提到这里，因为三个地方要用同一份：源解析（solid
 * 贴图）、算法运行时的 tint、特效应 def 的 `setUniforms`。留一份实现在
 * engine 里会让 effects/algos 反过来为了一个十六进制解析去 import 整个
 * SourceManager。
 */

/** `#rrggbb` 或 `#rrggbbaa` → 0..255 的四分量。坏颜色返回品红（立刻可见）。 */
export function hexToRgba(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return [255, 0, 255, 255]; // 坏颜色画成品红，立刻可见
  const n = parseInt(m[1]!, 16);
  const a = m[2] ? parseInt(m[2], 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** 同上，但归一化到 0..1 且丢掉 alpha —— vec3 uniform 要的形状。 */
export function colorVec3(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgba(hex);
  return [r / 255, g / 255, b / 255];
}

/* ------------------------------------------------------- sRGB 传输函数
 *
 * 分段式（IEC 61966-2-1），**不是 2.2 幂**。两者在暗部差得很多：2.2 幂把
 * 8 位编码的 1/255 映射到 0.0025，分段式给 0.0003 —— 用错会让黑位整体抬起。
 *
 * 这里是**唯一真源**：`effects/shader-def.ts` 的 `TRANSFER_GLSL` 由这些常数
 * 拼出来，所以 GLSL 与 TS 不可能各写一份。改动只能从这里改。
 *
 * 编码域 = sRGB 存储值（0..1，就是贴图里那个字节除以 255）。
 * 线性域 = 光强，**只有调色 pass 内部才使用**，见 `core/grade.ts` 的说明。
 */
export const SRGB_TRANSFER = {
  /** 编码域折点：以下走斜率段。 */
  encodeBreak: 0.04045,
  /** 线性域折点：以下走斜率段。 */
  linearBreak: 0.0031308,
  slope: 12.92,
  offset: 0.055,
  scale: 1.055,
  gamma: 2.4,
} as const;

/** sRGB 编码值 → 线性光强。负值按 0（调色的负 lift 不该变成 NaN）。 */
export function srgbToLinear(v: number): number {
  const c = v > 0 ? v : 0;
  const t = SRGB_TRANSFER;
  return c <= t.encodeBreak ? c / t.slope : Math.pow((c + t.offset) / t.scale, t.gamma);
}

/** 线性光强 → sRGB 编码值。**不夹上界**：16F 中间缓冲允许 >1 的高光留给后面的模块。 */
export function linearToSrgb(v: number): number {
  const c = v > 0 ? v : 0;
  const t = SRGB_TRANSFER;
  return c <= t.linearBreak ? c * t.slope : t.scale * Math.pow(c, 1 / t.gamma) - t.offset;
}

/* ------------------------------------------------------------ HSL 工具
 *
 * 排版配色方案的**明暗变体**需要「只改亮度、不动色相/饱和度」——
 * 这是 Office 主题色变体的实测行为（见 typography/theme.ts 的说明）。
 *
 * `ui/tokens.ts` 的 `parseHex` 现在只是 `hexToRgb` 的别名（2026-10-19 收口）；
 * 它的 `rgbToHsl` / `hslToRgb` 仍是给界面主题派生用的独立实现（带自己的 clamp
 * 约定）。**新增的颜色数学一律放这里** —— core 层不依赖 UI，反过来才成立。
 * `algos/image-fx.ts::hexToRgb01` 刻意保留：它只认 `#rrggbb`、坏值回落黑，
 * 那是渲染路径的业务选择，不能合并成 `hexToRgba`（后者坏值画品红）。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

/**
 * `#rgb` / `#rrggbb` → RGB。**失败返回 null**（与 `hexToRgba` 的「坏值画品红」
 * 不同：那个是渲染路径，要立刻可见；这里是配色方案解析，必须能区分「不是颜色」）。
 */
export function hexToRgb(hex: string): Rgb | null {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(c: Rgb): string {
  // NaN / Infinity 一律落到 0：吸管读像素时 `data[i]` 可能越界（`?? 0` 只挡
  // undefined，不挡 NaN），让 `toString(16)` 产出 `NaN` 会写进文档的坏 hex。
  const h = (v: number): string =>
    (Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function rgbToHsl(c: Rgb): Hsl {
  const rn = c.r / 255;
  const gn = c.g / 255;
  const bn = c.b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((((h % 360) + 360) % 360) / 360);
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  if (ss === 0) {
    const v = ll * 255;
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: f(hh + 1 / 3) * 255, g: f(hh) * 255, b: f(hh - 1 / 3) * 255 };
}

/** 线性混合：t=0 → a，t=1 → b。 */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}
