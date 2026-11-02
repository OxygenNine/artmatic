/**
 * wheel-model.ts — 色轮 ↔ 三个扁平标量的换算（纯函数）。
 *
 * 色轮是 **UI**，不是数据结构：`EffectInstance.values` 的约定是
 * `Record<string, number | string>`，所以一个轮盘的「角度 + 强度」最终要落成
 * 三个数（`lift#r` / `lift#g` / `lift#b`）。这里就是那层换算，两向都要有：
 * 拖轮盘要写值，重新打开面板要能把值还原成指针位置。
 *
 * ## 为什么用「零亮度色度平面」而不是直接存 HSV
 *
 * 暗部 / 中间调 / 亮部三个轮盘要改的是**色平衡**，不是「把这层染成红」。
 * 所以方向向量取的是 rgb 减去自身均值（零亮度分量）：往红的方向推，就是
 * R 加、G/B 减，整体亮度不动。直接用 HSV 的 (1,0,0) 会让暗部整体变亮。
 *
 * 存的三个数就是那个方向向量的分量（在 `[-1,1]` 上），**缩放交给 shader**
 * （各处 spread 不同：lift 是加法、gamma 是乘性、gain 是 EV）。这样
 * shader 里每个模块只有一处常数，UI 不需要知道量纲。
 *
 * ## 逆换算是闭式的，不是查表
 *
 * 色度平面用一组正交基 `e1 = (2,-1,-1)/√6`、`e2 = (0,1,-1)/√2`：
 *
 *   dir(angle) = cos(angle)·e1 + sin(angle)·e2
 *
 * 这组基恰好让 **红 = 0°、绿 = 120°、蓝 = 240°**（标准 RGB 色相环），
 * 而反解只是两次点积 + atan2。查表（360 条）也能做，但表会与基向量漂掉。
 *
 * ## 纯通道值（1,0,0）不算「拉满」
 *
 * 基是**单位**的，而 (1,0,0) 不是零亮度向量（它整体偏亮），投到色度平面上
 * 只剩 0.816 → 数值写 1.00 时把手停在 82%。这是对的：轮盘调的是**色平衡**，
 * 与「把这一层染成红」不是一回事。想拉到最外圈就继续往外推（分量会到
 * ±1.22 之外），数值框会如实显示。
 */

/** 色度平面基：e1 指向红，e2 指向「绿-蓝」轴。 */
const E1: readonly [number, number, number] = [2 / Math.sqrt(6), -1 / Math.sqrt(6), -1 / Math.sqrt(6)];
const E2: readonly [number, number, number] = [0, 1 / Math.sqrt(2), -1 / Math.sqrt(2)];

export type Rgb3 = [number, number, number];

const dot = (a: Rgb3 | readonly [number, number, number], b: readonly [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 角度 + 强度 → 方向向量（三分量）。
 *
 * `angle` 是 `0..1`（0 = 红，逆时针），`radius` 是 `0..1`。
 * 返回值的模长就是 radius，方向与 `hueDirection` 一致。
 */
export function wheelToRgb(angle: number, radius: number): Rgb3 {
  const a = angle * Math.PI * 2;
  const c = Math.cos(a) * radius;
  const s = Math.sin(a) * radius;
  return [c * E1[0] + s * E2[0], c * E1[1] + s * E2[1], c * E1[2] + s * E2[2]];
}

/**
 * 方向向量 → 角度 + 强度。与 `wheelToRgb` 互为逆运算（往返误差在浮点噪声级）。
 *
 * 全零（中性）时角度无意义，返回 0 —— 指针停在圆心，位置本来就不表示色相。
 */
export function rgbToWheel(r: number, g: number, b: number): { angle: number; radius: number } {
  const v: Rgb3 = [r, g, b];
  const x = dot(v, E1);
  const y = dot(v, E2);
  const radius = Math.hypot(x, y);
  if (radius < 1e-6) return { angle: 0, radius: 0 };
  let a = Math.atan2(y, x) / (Math.PI * 2);
  if (a < 0) a += 1;
  return { angle: a, radius };
}

/** 单位方向向量（radius = 1）。给「只显示色相」的预览用。 */
export function hueDirection(angle: number): Rgb3 {
  return wheelToRgb(angle, 1);
}

/**
 * 把一个方向分量编码成 8 位 rgb，用于轮盘中心那个小色块。
 *
 * 加 `0.5 + 0.5·v` 只是把 `[-1,1]` 映射到 `[0,1]`：它是**指示器**，
 * 不是「这个颜色的样子」。真正被染成什么样由 shader 里的 spread 决定。
 */
export function directionSwatch(v: Rgb3): string {
  const to = (x: number): number => Math.round((Math.max(-1, Math.min(1, x)) + 1) * 127.5);
  return `rgb(${to(v[0])} ${to(v[1])} ${to(v[2])})`;
}
