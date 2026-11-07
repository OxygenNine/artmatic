/**
 * config.ts — 粒子内核的**纯函数配置层**。
 *
 * 这里不碰 GL / DOM：参数归一化、区间夹取、预设展开、状态纹理尺寸换算
 * 全都能在 Node 里单测。`ParticleEngine` 只读这里产出的 `ParticleConfig`，
 * 于是不存在「UI 夹了一次、shader 又夹一次、两边口径不同」这种静默失效。
 *
 * 参数是 `Record<string, number|string>`（工程里的原生形状），归一化后
 * 全部是数字 —— select 型在这里**显式映射成 int**，绝不走 `floats()`
 * （那条路径会把字符串静默变成 0，于是「选了球体却永远在画点」）。
 */

import { getLimits, particleCapacity, type CapacityLimits, type ParticleCapacity } from '../../core/capacity';
import { ASSET_PARAM_KEYS } from '../../core/asset-params';
import type { ParamDef } from '../../effects/types';

/* ------------------------------------------------------------ 分组 */

/** 分组是**展示元数据**：顺序即面板里的顺序，检查器仍平铺。 */
export const PARTICLE_GROUPS = [
  'emitter',
  'forces',
  'appearance',
  'assets',
  'projection',
  'system',
] as const;

export type ParticleGroupId = (typeof PARTICLE_GROUPS)[number];

/** 出厂折叠的分组（其余默认展开）。参数多的组不该一进来就占满三列。 */
export const PARTICLE_COLLAPSED_GROUPS: readonly ParticleGroupId[] = ['forces', 'projection', 'system'];

/* ------------------------------------------------------------ 枚举 */

/** select 值 → shader 里的 int。映射只有这一份（JS 与 GLSL 靠它对齐）。 */
export const PARTICLE_SHAPES = ['point', 'line', 'disc', 'ring', 'sphere', 'box'] as const;
export type ParticleShape = (typeof PARTICLE_SHAPES)[number];

export const PARTICLE_BLENDS = ['add', 'alpha'] as const;
export type ParticleBlend = (typeof PARTICLE_BLENDS)[number];

export const PARTICLE_DIMS = ['2d', '3d'] as const;
export type ParticleDim = (typeof PARTICLE_DIMS)[number];

export const PARTICLE_CHANNELS = ['luma', 'alpha'] as const;
export type ParticleChannel = (typeof PARTICLE_CHANNELS)[number];

/** 未声明 / 手改坏的工程文件一律回落第 0 项，不抛异常。 */
function enumIndex<T extends string>(list: readonly T[], raw: unknown): number {
  const i = list.indexOf(raw as T);
  return i < 0 ? 0 : i;
}

/* ------------------------------------------------------------ 归一化 */

/**
 * 每一步真正喂给 shader 的量。**全部是 number**，且与参数区间同源。
 *
 * `dt` 是固定步长（秒）= 1 / stepsPerSec，与渲染 fps 无关（硬约束 1.3）。
 * `life` 也换算成步数，于是「改 fps 不会改粒子活多久」。
 */
export interface ParticleConfig {
  count: number;
  texW: number;
  texH: number;
  dt: number;
  stepsPerSec: number;
  shape: number;
  emitterSize: number;
  lifeSteps: number;
  lifeVar: number;
  speed: number;
  speedVar: number;
  spread: number;
  direction: number;
  gravityX: number;
  gravityY: number;
  gravityZ: number;
  drag: number;
  turbulence: number;
  turbScale: number;
  vortex: number;
  attract: number;
  pointSize: number;
  sizeVar: number;
  colorStart: [number, number, number];
  colorEnd: [number, number, number];
  opacity: number;
  blend: number;
  spriteOn: number;
  spriteRotate: number;
  spriteChannel: number;
  emitOn: number;
  emitChannel: number;
  emitThreshold: number;
  dimension: number;
  perspective: number;
  camYaw: number;
  camPitch: number;
  camDist: number;
  depthSize: number;
  bgMode: number;
  colorBg: [number, number, number];
  capacity: ParticleCapacity;
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 夹取到 `[lo, hi]`，非有限数回落 `fallback`。 */
export function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = num(v, fallback);
  return Math.min(hi, Math.max(lo, n));
}

/** `#rrggbb` → 0..1 三元组；坏值回落黑色。与 `core/color.ts` 的口径一致。 */
export function hexRgb(v: unknown, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const s = typeof v === 'string' ? v : '';
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (!m) return fallback;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * 状态纹理尺寸：`texW` 固定 512，`texH = ceil(count / 512)`。
 *
 * 固定宽度而不是「尽量方」是为了让 `gl_VertexID → texel` 的换算在
 * vertex shader 里只需一次除法，且不同 `count` 下 `texW` 不变 ——
 * 于是 `count` 滑杆不会顺手改掉每个粒子的 hash 坐标（那会让整群粒子
 * 在调数量时集体换位置）。
 */
export const PARTICLE_TEX_W = 512;

export function particleTexSize(count: number): { texW: number; texH: number } {
  const n = Math.max(1, Math.floor(count));
  return { texW: PARTICLE_TEX_W, texH: Math.ceil(n / PARTICLE_TEX_W) };
}

/**
 * 把工程参数归一化成 shader 常量。
 *
 * `limits` 可注入是为了单测能钉住「小机器派生出更小上限」；缺省读当前预算
 * （`getLimits()` 每次取，不缓存 —— 探测结果异步到达时缓存住会永远用旧值）。
 */
export function normalizeParticleConfig(
  values: Record<string, number | string>,
  limits: CapacityLimits = getLimits(),
): ParticleConfig {
  const capacity = particleCapacity(limits);
  const count = Math.floor(clampNum(values['count'], 256, capacity.maxParticles, 16384));
  const { texW, texH } = particleTexSize(count);
  const stepsPerSec = clampNum(values['rate'], 1, 240, 60);
  const lifeSec = clampNum(values['life'], 0.1, 30, 3);
  const bgMode = values['bgMode'] === 'transparent' ? 1 : 0;
  const spriteOn = typeof values['spriteAsset'] === 'string' && values['spriteAsset'].length > 0 ? 1 : 0;
  const emitOn = typeof values['emitAsset'] === 'string' && values['emitAsset'].length > 0 ? 1 : 0;

  return {
    count,
    texW,
    texH,
    dt: 1 / stepsPerSec,
    stepsPerSec,
    shape: enumIndex(PARTICLE_SHAPES, values['shape']),
    emitterSize: clampNum(values['emitterSize'], 0, 2, 0.45),
    lifeSteps: Math.max(1, Math.round(lifeSec * stepsPerSec)),
    lifeVar: clampNum(values['lifeVar'], 0, 1, 0.6),
    speed: clampNum(values['speed'], 0, 4, 0.35),
    speedVar: clampNum(values['speedVar'], 0, 1, 0.5),
    spread: clampNum(values['spread'], 0, 1, 0.7),
    direction: clampNum(values['direction'], -180, 180, -90) * Math.PI / 180,
    gravityX: clampNum(values['gravityX'], -3, 3, 0),
    gravityY: clampNum(values['gravityY'], -3, 3, -0.12),
    gravityZ: clampNum(values['gravityZ'], -3, 3, 0),
    drag: clampNum(values['drag'], 0, 4, 0.35),
    turbulence: clampNum(values['turbulence'], 0, 3, 0.25),
    turbScale: clampNum(values['turbScale'], 0.1, 12, 2.2),
    vortex: clampNum(values['vortex'], -3, 3, 0),
    attract: clampNum(values['attract'], -3, 3, 0),
    pointSize: clampNum(values['pointSize'], 1, 96, 7),
    sizeVar: clampNum(values['sizeVar'], 0, 1, 0.5),
    colorStart: hexRgb(values['colorStart'], [1, 0.84, 0.45]),
    colorEnd: hexRgb(values['colorEnd'], [0.36, 0.48, 1]),
    opacity: clampNum(values['opacity'], 0, 1, 0.85),
    blend: enumIndex(PARTICLE_BLENDS, values['blend']),
    spriteOn,
    spriteRotate: clampNum(values['spriteRotate'], 0, 1, 0),
    spriteChannel: enumIndex(PARTICLE_CHANNELS, values['spriteChannel']),
    emitOn,
    emitChannel: enumIndex(PARTICLE_CHANNELS, values['emitChannel']),
    emitThreshold: clampNum(values['emitThreshold'], 0, 1, 0.15),
    dimension: enumIndex(PARTICLE_DIMS, values['dimension']),
    perspective: clampNum(values['perspective'], 0, 3, 1),
    camYaw: clampNum(values['camYaw'], -180, 180, 0) * Math.PI / 180,
    camPitch: clampNum(values['camPitch'], -89, 89, 12) * Math.PI / 180,
    camDist: clampNum(values['camDist'], 0.5, 10, 3),
    depthSize: clampNum(values['depthSize'], 0, 1, 0.5),
    bgMode,
    colorBg: hexRgb(values['colorBg'], [0.05, 0.06, 0.08]),
    capacity,
  };
}

/* ------------------------------------------------------------ 预设 */

export interface ParticlePreset {
  id: string;
  /** 预设名文案键段（完整键由 UI 拼 `algo.particles.preset.<id>`）。 */
  values: Record<string, number | string>;
}

/**
 * 内置预设 = **一组参数值**，不是 shader 分支。
 *
 * 与 `HORIZON_STYLES` 同一条纪律：换风格不该换一条代码路径，
 * 否则「预设 A 能调的参数在预设 B 里拖了没反应」会变成常态。
 */
export const PARTICLE_PRESETS: readonly ParticlePreset[] = [
  {
    id: 'dust',
    values: {
      shape: 'box', emitterSize: 1.2, count: 12000, life: 8, lifeVar: 0.9,
      speed: 0.08, spread: 1, gravityY: -0.02, drag: 0.12,
      turbulence: 0.35, turbScale: 1.4, pointSize: 3, sizeVar: 0.7,
      opacity: 0.55, blend: 'add', colorStart: '#ffd98a', colorEnd: '#6d7cff',
    },
  },
  {
    id: 'fountain',
    values: {
      shape: 'point', emitterSize: 0.05, count: 9000, life: 2.4, lifeVar: 0.25,
      speed: 0.95, spread: 0.28, direction: -90, gravityY: -1.1, drag: 0.15,
      turbulence: 0.08, pointSize: 5, sizeVar: 0.4, opacity: 0.9,
      blend: 'add', colorStart: '#fff0c2', colorEnd: '#ff5b6e',
    },
  },
  {
    id: 'galaxy',
    values: {
      shape: 'disc', emitterSize: 0.9, count: 262144, life: 14, lifeVar: 0.5,
      speed: 0.22, spread: 0.1, vortex: 1.5, attract: 0.35, drag: 0.02,
      turbulence: 0.05, pointSize: 2.2, sizeVar: 0.6, opacity: 0.5,
      blend: 'add', dimension: '3d', perspective: 1.2, depthSize: 0.7,
      colorStart: '#ffe9b0', colorEnd: '#7a5cff',
    },
  },
  {
    id: 'snow',
    values: {
      shape: 'box', emitterSize: 1.3, count: 6000, life: 9, lifeVar: 0.4,
      speed: 0.06, spread: 0.2, direction: 90, gravityY: -0.16, drag: 0.05,
      turbulence: 0.42, turbScale: 3.4, pointSize: 6, sizeVar: 0.8,
      opacity: 0.8, blend: 'alpha', colorStart: '#ffffff', colorEnd: '#b8d0ff',
    },
  },
  {
    id: 'spark',
    values: {
      shape: 'ring', emitterSize: 0.35, count: 16000, life: 0.9, lifeVar: 0.6,
      speed: 1.7, spread: 0.9, gravityY: -0.5, drag: 1.2,
      turbulence: 0.7, turbScale: 6, pointSize: 3.5, sizeVar: 0.9,
      opacity: 1, blend: 'add', colorStart: '#fff6d0', colorEnd: '#ff3b1f',
    },
  },
];

/** 预设展开：缺省值 + 覆盖。返回的是**新表**，不改入参。 */
export function expandParticlePreset(
  id: string,
  defaults: Record<string, number | string>,
): Record<string, number | string> {
  const preset = PARTICLE_PRESETS.find((p) => p.id === id);
  return preset ? { ...defaults, ...preset.values } : { ...defaults };
}

/** 预设名合法性（Agent 与 UI 共用，避免拼错静默无效果）。 */
export function isParticlePresetId(id: unknown): id is string {
  return typeof id === 'string' && PARTICLE_PRESETS.some((p) => p.id === id);
}

/**
 * 把预设**叠到当前参数表**上，只改预设声明过的键。
 *
 * 刻意不整表替换：用户可能已经调过二十个没在预设里的量，点一下「落雪」
 * 不该把它们悄悄打回出厂值。返回新表，不改入参。
 */
export function applyParticlePreset(
  id: string,
  current: Record<string, number | string>,
): Record<string, number | string> {
  const preset = PARTICLE_PRESETS.find((p) => p.id === id);
  return preset ? { ...current, ...preset.values } : { ...current };
}

/* ------------------------------------------------------------ 参数键 */

/** 哪些键只影响渲染、不进构造哈希（见 `GeneratorBase.volatile`）。 */
export const PARTICLE_VOLATILE_KEYS: readonly string[] = [
  'pointSize', 'sizeVar', 'colorStart', 'colorEnd', 'opacity', 'blend',
  'spriteAsset', 'spriteRotate', 'spriteChannel',
  'dimension', 'perspective', 'camYaw', 'camPitch', 'camDist', 'depthSize',
  'bgMode', 'colorBg', 'rate', 'intRes',
];

/**
 * 构造哈希里**必须**留下的键：它们改变状态的初始化或每一步的演化。
 * `emitAsset` / `emitChannel` / `emitThreshold` 也在其中 —— 发射密度图
 * 改了，粒子从哪儿出生就变了，不能靠「下一帧自然对齐」。
 */
export const PARTICLE_STATE_KEYS: readonly string[] = [
  'count', 'shape', 'emitterSize', 'life', 'lifeVar', 'speed', 'speedVar',
  'spread', 'direction', 'gravityX', 'gravityY', 'gravityZ', 'drag',
  'turbulence', 'turbScale', 'vortex', 'attract',
  'emitAsset', 'emitChannel', 'emitThreshold',
];

/** 声明过的 asset 型参数键。**真源在 `core/asset-params.ts`** —— 打开工程 / 删素材 / 控制平面共用。 */
export const PARTICLE_ASSET_KEYS = ASSET_PARAM_KEYS;

/** 给单测与守卫用：确认参数表覆盖了归一化读到的每个键。 */
export function particleParamKeys(params: ParamDef[]): Set<string> {
  return new Set(params.map((p) => p.key));
}
