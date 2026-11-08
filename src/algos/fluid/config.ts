/**
 * config.ts — 流体模拟的**纯函数配置层**。
 *
 * 与 `particles/config.ts` 同一条纪律：这里不碰 GL / DOM，参数归一化、尺寸
 * 换算、喷嘴轨迹全都能在 Node 里单测。`FluidEngine` 只读这里产出的
 * `FluidConfig`，于是不存在「UI 夹一次、shader 又夹一次」的静默分叉。
 *
 * ## 模拟域是**固定 16:9**，不跟渲染尺寸走
 *
 * 模拟纹理的宽高比不能随输出变 —— 变速（`rate`）与可变域宽会让
 * 「同一 t 两渲逐字节相同」（硬约束 1.3）失效，也让拖动时反复重建。
 * 所以域恒为 16:9，显示时按 **cover** 映射到输出（铺满、裁切、不拉伸），
 * 见 `fluid/glsl.ts::DISPLAY_FRAG`。
 */

import {
  FLUID_SIM_STEPS,
  fluidCapacity,
  getLimits,
  type CapacityLimits,
  type FluidCapacity,
} from '../../core/capacity';
import { hexToRgb } from '../../core/color';
import type { ParamDef } from '../../effects/types';

/** 模拟域的宽高比常量。**唯一真源**：纹理尺寸、喷嘴坐标、display 的 cover 都读它。 */
export const FLUID_DOMAIN_ASPECT = 16 / 9;

/** 喷嘴轨迹。select 值在归一化时**显式映射成 int**（过 `floats()` 会静默变 0）。 */
export const FLUID_MOTIONS = ['orbit', 'lissajous', 'sweep', 'still'] as const;
export type FluidMotion = (typeof FLUID_MOTIONS)[number];

/** `simRes` 的档位（域高度）。与 `FLUID_SIM_STEPS` 同源 —— 拼错就落到最矮那档。 */
export const FLUID_SIM_RES_OPTIONS = FLUID_SIM_STEPS.map((h) => String(h));

/** 注入蒙版的取通道方式。0 = 亮度、1 = 不透明度（与粒子的 `spriteChannel` 同形）。 */
export const FLUID_MASK_CHANNELS = ['luma', 'alpha'] as const;

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const enumIndex = <T extends string>(list: readonly T[], raw: unknown): number => {
  const i = list.indexOf(raw as T);
  return i < 0 ? 0 : i;
};

/** `#rrggbb` → 0..1 三元组。坏值回落 `fallback`（与 `core/color.ts` 同一口径）。 */
export function fluidHexRgb(v: unknown, fallback: [number, number, number]): [number, number, number] {
  const c = typeof v === 'string' ? hexToRgb(v) : null;
  return c ? [c.r / 255, c.g / 255, c.b / 255] : fallback;
}

export interface FluidConfig {
  /** 模拟纹理宽（= `texH * 16/9`，向下取整不裁域）。 */
  texW: number;
  /** 模拟纹理高。 */
  texH: number;
  domainAspect: number;
  /** 固定步长（秒）= 1 / stepsPerSec。与渲染 fps 无关（硬约束 1.3）。 */
  dt: number;
  stepsPerSec: number;
  nozzles: number;
  /** 注入量（每步每喷嘴的染料浓度）。 */
  inject: number;
  /** 高斯半径，单位是「域高度」。 */
  radius: number;
  /** 注入动量，单位是「域高度/秒」。 */
  force: number;
  motion: number;
  pathScale: number;
  pathSpeed: number;
  curl: number;
  pressureIter: number;
  /** 每秒的速度衰减系数（Pavel 的 dissipation 口径，内部换成每步）。 */
  velDissipation: number;
  dyeDissipation: number;
  hue: number;
  hueSpread: number;
  saturation: number;
  brightness: number;
  shading: number;
  glow: number;
  hueShift: number;
  contrast: number;
  bgMode: number;
  colorBg: [number, number, number];
  maskOn: number;
  maskChannel: number;
  maskThreshold: number;
  capacity: FluidCapacity;
}

/** 每步的乘性衰减：`1 / (1 + d·dt)`（与 Pavel 的 `dissipation` 同口径）。 */
export function dissipationPerStep(d: number, dt: number): number {
  return 1 / (1 + Math.max(0, d) * dt);
}

/**
 * 出厂值。**唯一真源**：`params.ts` 的参数表与归一化的兜底都读它 ——
 * 两边各写一遍的失效形态是「工程里没有这个键时用 A，有键但值非法时用 B」，
 * 而那种差异只在手改过的工程文件上出现。
 *
 * 数值是实测调出来的，判据是「3~4 秒时墨流铺开、而 6 秒还没过曝」：
 * 注入量 × 亮度给出每步的浓度增量，染料衰减给出它的半衰期，两者的比决定
 * 稳态亮度。喷嘴走得慢（`pathSpeed` 小于 0.5）时墨会堆在一点上烧成白饼。
 */
export const FLUID_DEFAULTS = {
  nozzles: 3,
  inject: 0.9,
  radius: 0.05,
  force: 0.4,
  pathScale: 0.7,
  pathSpeed: 0.6,
  curl: 24,
  pressureIter: 16,
  velDissipation: 0.2,
  dyeDissipation: 0.7,
  hue: 0.58,
  hueSpread: 0.3,
  saturation: 0.9,
  brightness: 0.5,
  shading: 0.6,
  glow: 0.5,
  hueShift: 0,
  contrast: 1,
  maskThreshold: 0.1,
  rate: 60,
  simRes: '256',
} as const;

/**
 * 参数归一化。`simRes` 落在档位表里、且不超过本机预算派生出的上限。
 */
export function normalizeFluidConfig(
  values: Record<string, number | string>,
  limits: CapacityLimits = getLimits(),
): FluidConfig {
  const capacity = fluidCapacity(limits);
  const D = FLUID_DEFAULTS;
  const asked = Number(values['simRes']);
  // 档位表里「≤ 本机上限的最大一档」；asked 不认识就取缺省档，再夹到上限。
  const wanted = Number.isFinite(asked) && asked > 0 ? asked : Number(D.simRes);
  let texH: number = FLUID_SIM_STEPS[0];
  for (const h of FLUID_SIM_STEPS) if (h <= Math.min(wanted, capacity.maxSimH)) texH = h;
  const stepsPerSec = clampNum(values['rate'], 1, 240, D.rate);
  const maskAsset = typeof values['maskAsset'] === 'string' ? values['maskAsset'] : '';

  return {
    texH,
    texW: Math.max(2, Math.round(texH * FLUID_DOMAIN_ASPECT)),
    domainAspect: FLUID_DOMAIN_ASPECT,
    dt: 1 / stepsPerSec,
    stepsPerSec,
    nozzles: Math.round(clampNum(values['nozzles'], 1, 4, D.nozzles)),
    inject: clampNum(values['inject'], 0, 2, D.inject),
    radius: clampNum(values['radius'], 0.01, 0.25, D.radius),
    force: clampNum(values['force'], 0, 2, D.force),
    motion: enumIndex(FLUID_MOTIONS, values['motion']),
    pathScale: clampNum(values['pathScale'], 0, 1, D.pathScale),
    pathSpeed: clampNum(values['pathSpeed'], 0, 2, D.pathSpeed),
    curl: clampNum(values['curl'], 0, 60, D.curl),
    pressureIter: Math.round(clampNum(values['pressureIter'], 1, 32, D.pressureIter)),
    velDissipation: clampNum(values['velDissipation'], 0, 3, D.velDissipation),
    dyeDissipation: clampNum(values['dyeDissipation'], 0, 3, D.dyeDissipation),
    hue: clampNum(values['hue'], 0, 1, D.hue),
    hueSpread: clampNum(values['hueSpread'], 0, 1, D.hueSpread),
    saturation: clampNum(values['saturation'], 0, 1, D.saturation),
    brightness: clampNum(values['brightness'], 0, 2, D.brightness),
    shading: clampNum(values['shading'], 0, 1, D.shading),
    glow: clampNum(values['glow'], 0, 2, D.glow),
    hueShift: clampNum(values['hueShift'], -0.5, 0.5, D.hueShift),
    contrast: clampNum(values['contrast'], 0.2, 3, D.contrast),
    bgMode: values['bgMode'] === 'transparent' ? 1 : 0,
    colorBg: fluidHexRgb(values['colorBg'], [0.03, 0.035, 0.05]),
    maskOn: maskAsset.length > 0 ? 1 : 0,
    maskChannel: enumIndex(FLUID_MASK_CHANNELS, values['maskChannel']),
    maskThreshold: clampNum(values['maskThreshold'], 0, 1, D.maskThreshold),
    capacity,
  };
}

/* ------------------------------------------------------------- 喷嘴轨迹 */

export interface Jet {
  /** 注入点（uv）。 */
  x: number;
  y: number;
  /** 运动方向（已归一化）；速度为 0 时是 (0,0)。 */
  dx: number;
  dy: number;
}

/**
 * 第 `i` 个喷嘴在第 `step` 步的位置。**纯函数 of (i, step, cfg)**。
 *
 * ## 为什么进度是步号而不是秒
 *
 * `seek(f)` 重放时，运行时只告诉我们「推进到第几步」，不给那一步的 t
 * （`stepTo` 的语义是「补算中间每一步」）。用 `step` 做相位 ⇒ 重放逐位相同；
 * 用 `t` 会让回退重算的那一段落到错误的时间上，而且**不报错**。
 *
 * `pathSpeed` 的单位因此是「每秒走过多少个 `0.02π` 相位」，也就是
 * 「改 `rate` 会连带改注入点的移动速度」—— 与 `rate` 的语义（模拟步频）一致。
 *
 * ## 轨迹必须是连续的
 *
 * 所有模式都用 sin/cos（**不用 `fract`**）：位置跳变会让数值差分的方向爆掉，
 * 那一帧会朝随机方向喷出一股，视觉上是「偶发的尖刺」。
 */
export function jetAt(i: number, step: number, cfg: FluidConfig): Jet {
  const here = jetPath(i, step, cfg);
  // 数值差分取方向：只关心方向，量级由 `force` 给。
  const ahead = jetPath(i, step + 1, cfg);
  let dx = ahead.x - here.x;
  let dy = ahead.y - here.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    dx /= len;
    dy /= len;
  } else {
    dx = 0;
    dy = 0;
  }
  return { x: here.x, y: here.y, dx, dy };
}

/** 轨迹本身（`jetAt` 用它取两个相邻步做差分）。 */
function jetPath(i: number, step: number, cfg: FluidConfig): { x: number; y: number } {
  const n = Math.max(1, cfg.nozzles);
  const phase = (i / n) * Math.PI * 2;
  const s = cfg.pathScale * 0.42;
  const a = step * cfg.pathSpeed * 0.02;
  switch (cfg.motion) {
    case 1: // lissajous：两个方向的频率不同 ⇒ 轨迹不闭合
      return {
        x: 0.5 + Math.sin(a * 1.3 + phase) * s,
        y: 0.5 + Math.sin(a * 0.9 + phase * 1.7 + 1.1) * s * 0.8,
      };
    case 2: // sweep：水平往返 + 缓慢上下
      return {
        x: 0.5 + Math.sin(a * 0.8 + phase) * s,
        y: 0.5 + Math.sin(a * 0.23 + phase * 1.3) * s * 0.6,
      };
    case 3: // still：几个固定点（差分恒为 0 ⇒ 只染色不推流）
      return {
        x: 0.5 + Math.cos(phase * 1.6) * s * 0.9,
        y: 0.5 + Math.sin(phase * 1.6) * s * 0.9,
      };
    default: // orbit
      return { x: 0.5 + Math.cos(a + phase) * s, y: 0.5 + Math.sin(a + phase) * s };
  }
}

/**
 * 染料颜色：色相轮上的一个点 → RGB，再乘 `brightness`。
 *
 * 用 HSV（S=u_saturation、V=1）而不是从调色板插值：Pavel 的 demo 就是
 * 色相环，而「同一条墨流里出现两种颜色」在流体里会立刻混成一团脏灰。
 */
export function jetColor(hue: number, cfg: FluidConfig): [number, number, number] {
  const h = ((hue % 1) + 1) % 1;
  const s = cfg.saturation;
  const k = (n: number): number => {
    const t = (n + h * 6) % 6;
    return Math.min(1, Math.max(0, Math.min(t, 4 - t)));
  };
  const m = cfg.brightness;
  return [(k(5) * s + (1 - s)) * m, (k(3) * s + (1 - s)) * m, (k(1) * s + (1 - s)) * m];
}

/** 第 `i` 个喷嘴的色相（基色 + 等分展开）。 */
export function jetHue(i: number, cfg: FluidConfig): number {
  return cfg.hue + (i / Math.max(1, cfg.nozzles)) * cfg.hueSpread;
}

/* ---------------------------------------------------------- 哈希 / 参数键 */

/** 只影响渲染、不进构造哈希（改了不重放模拟）。 */
export const FLUID_VOLATILE_KEYS: readonly string[] = [
  'shading', 'glow', 'hueShift', 'contrast', 'bgMode', 'colorBg', 'rate', 'intRes',
];

/** 给单测与守卫用：确认参数表覆盖了归一化读到的每个键。 */
export function fluidParamKeys(params: ParamDef[]): Set<string> {
  return new Set(params.map((p) => p.key));
}
