/**
 * tone-curve.ts — 调色曲线（**色调映射表**，不是 `core/curve.ts` 的关键帧曲线）。
 *
 * 两者同形不同义：关键帧曲线是「时间 → 标量」，带 `interp` / `handles` / `mode`；
 * 这里是「亮度 → 亮度」，只有单调性这一个约束。共用一个编辑器会逼着用户在
 * 「我的曲线为什么有关键帧插值方式」这类问题上耗神。
 *
 * ## 定义域与值域都是**线性**
 *
 * 曲线住在调色的线性岛里，所以它的 x/y 都是线性光强。但用户看的是编码值——
 * 一条「中灰提亮」的曲线，在编码刻度上看起来才符合直觉。所以**存储用线性、
 * 显示用编码**：编辑器把点转成编码坐标画出来，拖动时再转回去。
 *
 * ## 采样成固定宽度的表，而不是在 GPU 端求值
 *
 * 参数变动频率极低（拖一个点），重建一张 1024×4 的 R16F 纹理比在 shader 里
 * 解三段 Hermite 便宜得多，也让「编辑器画出来的」与「画面上的」共用同一份表。
 */

import { linearToSrgb, srgbToLinear } from './color';

/** 曲线表宽度（每通道一行，共 4 行：主 / R / G / B）。 */
export const TONE_CURVE_WIDTH = 1024;
/** 曲线表的通道行数。 */
export const TONE_CURVE_ROWS = 4;

export interface CurvePoint {
  /** 线性域，`0..1`。 */
  x: number;
  /** 线性域，`0..1`。 */
  y: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** 恒等曲线的两个端点。新建一条曲线时用它。 */
export function identityPoints(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

/**
 * `"x,y;x,y;…"` → 控制点。**坏输入一律回落到恒等**，不抛异常。
 *
 * 曲线的来源是 `EffectInstance.values`（可被插件 / 旧工程 / 手改 JSON 写入），
 * 一条解析失败就整帧拒渲是更坏的结果。
 */
export function parseToneCurve(s: string | undefined | null): CurvePoint[] {
  if (!s) return identityPoints();
  const out: CurvePoint[] = [];
  for (const chunk of s.split(';')) {
    const parts = chunk.split(',');
    if (parts.length !== 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x: clamp01(x), y: clamp01(y) });
  }
  if (out.length < 2) return identityPoints();
  out.sort((a, b) => a.x - b.x);
  // 去重（x 相同）：Fritsch–Carlson 的分母会变成 0。
  const uniq: CurvePoint[] = [];
  for (const p of out) {
    if (uniq.length && Math.abs(uniq[uniq.length - 1]!.x - p.x) < 1e-6) {
      uniq[uniq.length - 1] = p;
    } else {
      uniq.push(p);
    }
  }
  return uniq.length >= 2 ? uniq : identityPoints();
}

const fmt = (v: number): string => {
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/** 控制点 → 存储串。恒等曲线存空串（省字节，也让「没调过」一眼看得出）。 */
export function stringifyToneCurve(points: readonly CurvePoint[]): string {
  if (isIdentity(points)) return '';
  return points.map((p) => `${fmt(clamp01(p.x))},${fmt(clamp01(p.y))}`).join(';');
}

/** 是不是恒等（所有点都在 y = x 上）。 */
export function isIdentity(points: readonly CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.y - p.x) < 1e-4);
}

/**
 * 单调三次插值（Fritsch–Carlson），采样成 `width` 个线性值。
 *
 * 为什么不用普通三次样条：它会在控制点之间**过冲**（把 0 压成负的、把 1 顶过头），
 * 于是「只抬中间调」的曲线会在暗部挖出一个坑。单调版本把切线按
 * `α² + β² ≤ 9` 收缩，过冲从数学上被排除。
 *
 * 首尾之外按端点延伸？不 —— **钳制**。曲线之外没有数据，猜一个斜率比直接
 * 用端点值更危险（负 lift 会把黑推到负值，而编码时又得再夹一次）。
 */
export function sampleToneCurve(points: readonly CurvePoint[], width = TONE_CURVE_WIDTH): Float32Array {
  const n = Math.max(2, Math.floor(width));
  const pts = points.length >= 2 ? [...points].sort((a, b) => a.x - b.x) : identityPoints();
  const out = new Float32Array(n);
  const m = pts.length;

  // 段斜率
  const delta: number[] = [];
  for (let i = 0; i < m - 1; i += 1) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    delta.push(dx > 1e-9 ? (pts[i + 1]!.y - pts[i]!.y) / dx : 0);
  }

  // 切线：内部取相邻两种斜率的均值，端点直接取邻段
  const slope: number[] = new Array(m);
  slope[0] = delta[0]!;
  slope[m - 1] = delta[m - 2]!;
  for (let i = 1; i < m - 1; i += 1) slope[i] = (delta[i - 1]! + delta[i]!) / 2;

  // 单调性修正
  for (let i = 0; i < m - 1; i += 1) {
    if (delta[i] === 0) {
      slope[i] = 0;
      slope[i + 1] = 0;
      continue;
    }
    const a = slope[i]! / delta[i]!;
    const b = slope[i + 1]! / delta[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      slope[i] = tau * a * delta[i]!;
      slope[i + 1] = tau * b * delta[i]!;
    }
  }

  let seg = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i / (n - 1);
    // 钳制到首尾点：曲线之外没有定义
    if (x <= pts[0]!.x) {
      out[i] = pts[0]!.y;
      continue;
    }
    if (x >= pts[m - 1]!.x) {
      out[i] = pts[m - 1]!.y;
      continue;
    }
    while (seg < m - 2 && x > pts[seg + 1]!.x) seg += 1;
    while (seg > 0 && x < pts[seg]!.x) seg -= 1;
    const x0 = pts[seg]!.x;
    const x1 = pts[seg + 1]!.x;
    const h = x1 - x0;
    if (h <= 1e-9) {
      out[i] = pts[seg + 1]!.y;
      continue;
    }
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite 基函数
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * pts[seg]!.y + h10 * h * slope[seg]! + h01 * pts[seg + 1]!.y + h11 * h * slope[seg + 1]!;
    out[i] = clamp01(y);
  }
  return out;
}

/** 单点求值（测试与编辑器的辅助读值）。与 `sampleToneCurve` 同一条算式。 */
export function evaluateToneCurve(points: readonly CurvePoint[], x: number): number {
  const table = sampleToneCurve(points, TONE_CURVE_WIDTH);
  const pos = clamp01(x) * (TONE_CURVE_WIDTH - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = table[i] ?? 0;
  const b = table[Math.min(TONE_CURVE_WIDTH - 1, i + 1)] ?? a;
  return a + (b - a) * f;
}

/* --------------------------------------------- 线性 ↔ 编码（只给编辑器用） */

/**
 * 线性控制点 → 编辑器坐标（编码域）。
 *
 * 这条换算只在画图时用。**存储永远是线性**：两套坐标各存一份的后果是
 * 「编辑器好看、画面不对」，而且改一次 srgb 常数就全错。
 */
export function pointToDisplay(p: CurvePoint): { x: number; y: number } {
  return { x: linearToSrgb(p.x), y: linearToSrgb(p.y) };
}

/** 编辑器坐标（编码域）→ 线性控制点。 */
export function pointFromDisplay(x: number, y: number): CurvePoint {
  return { x: clamp01(srgbToLinear(x)), y: clamp01(srgbToLinear(y)) };
}
