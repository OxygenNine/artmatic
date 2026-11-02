/**
 * ring-math.ts — 「环形滚动条」的纯函数内核（极坐标 ↔ 值）。
 *
 * 控件本身是 `RingSlider.svelte`，这里只放能单测的部分：角度归一、半径钳制、
 * 指针位移 → 参数、键盘微调、色相环的 CSS 渐变串。
 *
 * ## 坐标约定（最容易写反的一处）
 *
 * 参数空间是**数学坐标系**：角度 0 在 +X（右），**逆时针**增大，取值 `[0,1)`。
 * 屏幕的 y 轴朝下，所以每次从指针位移算角度都要取负。
 * 写反的症状是「色轮上下镜像」—— 拖动看起来正常，但选出来的颜色与指针对不上，
 * 而且只有拿截图比对才发现。
 *
 * 半径是 `0..1` 的**归一化**距离（1 = 环），不是像素。这样控件尺寸变化不影响值，
 * 也不需要在拖动手势里记像素半径。
 */

export const TAU = Math.PI * 2;

/** 把任意实数收进 `[0,1)`；`1` 与 `0` 视为同一点。 */
export function wrap01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const w = v - Math.floor(v);
  // `-1e-17` 这类负零会被 `Math.floor` 收成 1，`1 % 1` 也得归零。
  return w >= 1 ? 0 : w;
}

/**
 * 指针相对圆心 → 极坐标。`dx` / `dy` 是**屏幕坐标**（y 向下）。
 *
 * 返回的角度已按上面的约定翻成逆时针；半径原样是「圆半径的倍数」，
 * 由调用方除以像素半径。
 */
export function xyToPolar(dx: number, dy: number): { angle: number; radius: number } {
  return {
    angle: wrap01(Math.atan2(-dy, dx) / TAU),
    radius: Math.hypot(dx, dy),
  };
}

/** 极坐标 → 屏幕偏移（y 向下），用于摆把手。 */
export function polarToXY(angle: number, radius: number): { x: number; y: number } {
  const a = wrap01(angle) * TAU;
  return { x: Math.cos(a) * radius, y: -Math.sin(a) * radius };
}

/** 值 → 角度 / 半径的反向换算（把扁平标量还原成轮盘位置时用）。 */
export function cartesianToPolar(x: number, y: number): { angle: number; radius: number } {
  return xyToPolar(x, y);
}

/**
 * 角度吸附：按 `step` 分格（`0` = 不吸附）。
 *
 * 吸附作用在**角度**上而不是屏幕坐标上，所以绕一圈会回到同一个值 ——
 * 「拖到接近正上方时微微吸住」是刻意的，色相环有六个主角，手不可能停准。
 */
export function snapAngle(angle: number, step: number): number {
  if (!(step > 0) || step >= 1) return wrap01(angle);
  return wrap01(Math.round(wrap01(angle) / step) * step);
}

/**
 * 键盘微调。`dir` 是 -1 / +1，`step` 是角度增量（例：`1/360` = 一度）。
 *
 * 不与 `snapAngle` 合并：键盘要的是**相对**增量（一格一格走），
 * 吸附是**绝对**对齐。混在一起会让「按住方向键」在第一格之后被吸回去。
 */
export function nudgeAngle(angle: number, dir: number, step: number): number {
  return wrap01(angle + dir * step);
}

/** 半径钳制到 `0..1`。NaN 归 0（指针事件在窗口外时可能给出无效值）。 */
export function clampRadius(r: number): number {
  if (!Number.isFinite(r)) return 0;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * 指针位移 → 值（控件与单测共用的唯一入口）。
 *
 * `rPx` 是**把手的活动半径**（不是容器半径）：控件的把手中心离圆心最多
 * `size/2 - inset`，所以「拖到最外圈」才会恰好给出 1.0。用容器半径会让最大值
 * 永远取不到，表现为「拖到边缘但强度只有 0.87」。
 */
export function angleOf(
  dx: number,
  dy: number,
  rPx: number,
  snap: boolean,
  snapStep: number,
): { angle: number; radius: number } {
  const p = xyToPolar(dx, dy);
  return {
    angle: snap ? snapAngle(p.angle, snapStep) : p.angle,
    radius: clampRadius(rPx > 0 ? p.radius / rPx : 0),
  };
}

/**
 * 色相环的 CSS 渐变串（`conic-gradient`）。
 *
 * 这里**写死 hsl 字面量是对的**：它不是界面 chrome，而是**内容** ——
 * 屏幕上显示的必须是 sRGB 色相环本身，跟着主题变才是错的（亮色主题下轮盘
 * 变浅会让人选错颜色）。同理，`from -90deg` 让十二点方向是红：与常见色轮一致。
 *
 * `segments` 决定平滑度：48 段在 100px 直径下已看不出折线，再多纯属无谓。
 */
export function hueRingGradient(segments = 48, from = -90): string {
  const n = Math.max(3, Math.round(segments));
  const stops: string[] = [];
  for (let i = 0; i <= n; i += 1) {
    const deg = (i / n) * 360;
    stops.push(`hsl(${deg} 100% 50%) ${deg.toFixed(2)}deg`);
  }
  return `conic-gradient(from ${from}deg, ${stops.join(', ')})`;
}

/**
 * 中性轮的渐变：没有色相语义的轮盘（例如只读的强度指示）用它，
 * 免得使用者以为「转一圈能选颜色」。
 */
export function neutralRingGradient(): string {
  return `conic-gradient(from -90deg, var(--surface-3), var(--border-strong) 50%, var(--surface-3))`;
}
