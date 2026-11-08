/**
 * index.ts — 粒子系统的**唯一对外复用 API**。
 *
 * 后续需要粒子效果的生成器不写 `ParticleEngine`、不拼 GLSL、不复制参数表：
 * 只写一份 `ParticleSpec`，调 `createParticleGenerator(spec)` 拿一个标准
 * `GeneratorDef`（kind: 'gpu-sim'），再进 `registry.ts` 登记即可。
 *
 * 复用有三层，按需取用：
 *   1. 只给 `id` / `nameKey` / `defaults` —— 换一组出厂值的新效果；
 *   2. `params` 按 key 覆盖或追加 —— 增减可调项，键空间仍只有一份；
 *   3. `shaders` + `hooks` —— 覆盖某一段 GLSL 并派发自己的 uniform。
 *
 * 内核只依赖 `core/` 与 `engine/`，不 import `ui/` `agent/` `project/`；
 * 素材解析与目录句柄全部走运行时注入。
 */

import { particleCapacity, PARTICLE_HARD_CAP } from '../../core/capacity';
import type { ParamDef } from '../../effects/types';
import type { Label } from '../../i18n/label';
import type { GeneratorDef } from '../types';
import {
  PARTICLE_VOLATILE_KEYS,
  PARTICLE_ASSET_KEYS,
  PARTICLE_GROUPS,
  PARTICLE_COLLAPSED_GROUPS,
  PARTICLE_PRESETS,
  applyParticlePreset,
  PARTICLE_SHAPES,
  PARTICLE_BLENDS,
  PARTICLE_DIMS,
  PARTICLE_CHANNELS,
  clampNum,
  expandParticlePreset,
  hexRgb,
  isParticlePresetId,
  normalizeParticleConfig,
  particleParamKeys,
  particleTexSize,
  type ParticleConfig,
  type ParticlePreset,
  type ParticleGroupId,
  type ParticleShape,
  type ParticleBlend,
  type ParticleDim,
  type ParticleChannel,
} from './config';
import { particleGroupLabel, particleParams } from './params';
import { particleProgramName } from './glsl';
import {
  PARTICLE_AUX_REFS,
  assetIdOf,
  clearParticleAssetRefs,
} from './assets';
import {
  DEFAULT_PARTICLE_SHADERS,
  ParticleEngine,
  type ParticleDiagnostics,
  type ParticleEngineOptions,
  type ParticleHooks,
  type ParticleShaders,
} from './engine';

/** 后续生成器交给工厂的那份说明书。 */
export interface ParticleSpec {
  /** 注册表 id。**同时是 program 名前缀** —— 不同 spec 必须不同名。 */
  id: string;
  /** 展示名（内置传文案键，插件传字面文本）。 */
  nameKey: Label;
  /** 一句话说明（内置一律不写，进 `algos/catalog.ts`）。 */
  desc?: Label;
  /** 按 `key` 覆盖或追加参数。缺省用完整参数表。 */
  params?: ParamDef[];
  /** 覆盖出厂值。与 `preset` 同时给时，`defaults` 后写（优先）。 */
  defaults?: Record<string, number | string>;
  /** 内置预设 id：直接以某组值为出厂值。 */
  preset?: string;
  /** 从参数表移除的键（后续生成器不需要的可调项）。 */
  omit?: readonly string[];
  /** 追加到 `volatile` 的键（只影响渲染、不进构造哈希）。 */
  volatile?: readonly string[];
  /** 按段覆盖 GLSL。缺省段仍走内置实现。 */
  shaders?: Partial<ParticleShaders>;
  /** 覆盖 GLSL 之后追加自定义 uniform。 */
  hooks?: ParticleHooks;
}

/** 构造一个 `gpu-sim` 生成器 def。纯组装，不碰 GL（可单测）。 */
export function createParticleGenerator(spec: ParticleSpec): GeneratorDef {
  const params = mergeParams(spec);
  const defaults = expandParticlePreset(spec.preset ?? '', defaultOf(params));
  const factoryDefaults = { ...defaults, ...(spec.defaults ?? {}) };
  const volatile = [...PARTICLE_VOLATILE_KEYS, ...(spec.volatile ?? [])];
  const shaders = spec.shaders;
  const hooks = spec.hooks;

  return {
    id: spec.id,
    nameKey: spec.nameKey,
    desc: spec.desc,
    kind: 'gpu-sim',
    params: params.map((p) => withDefault(p, factoryDefaults[p.key])),
    volatile,
    // 参数几十项 + 预设 + 发射器形状，检查器一列平铺放不下 ⇒ 有全屏编辑页。
    // 其它 `gpu-sim`（流体）不设这个字段，双击只开检查器。
    fullscreenEditor: true,
    auxTextures: [...PARTICLE_AUX_REFS],
    // 预编译清单：四段 program 的名字与 `ParticleEngine` 同源（`Kit.quad` 按名缓存）。
    programs: () => {
      const s = { ...DEFAULT_PARTICLE_SHADERS, ...shaders };
      return [
        { name: particleProgramName(spec.id, 'init'), fragment: s.init },
        { name: particleProgramName(spec.id, 'step-pos'), fragment: s.stepPos },
        { name: particleProgramName(spec.id, 'step-vel'), fragment: s.stepVel },
        { name: particleProgramName(spec.id, 'points'), fragment: s.pointFrag, vertex: s.pointVert },
      ];
    },
    create: (values, seed, kit) => new ParticleEngine(kit, {
      cfg: normalizeParticleConfig(values),
      values,
      seed,
      id: spec.id,
      shaders,
      hooks,
    }),
  };
}

function defaultOf(params: ParamDef[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of params) out[p.key] = p.defaultValue;
  return out;
}

/**
 * 覆盖默认值时**按参数类型收窄**：`range` 只吃 number，`select` / `asset`
 * 只吃 string。预设表写错类型就在这里被忽略（回落 def 的默认值），
 * 不会把 `range.defaultValue` 悄悄改成字符串 —— 那会让 `resolveParam`
 * 拿到 NaN，表现为「这个滑杆永远不动」。
 */
function withDefault(p: ParamDef, v: number | string | undefined): ParamDef {
  if (v === undefined) return p;
  if (p.type === 'range' || p.type === 'checkbox' || p.type === 'bitmask') {
    return typeof v === 'number' ? { ...p, defaultValue: v } : p;
  }
  return typeof v === 'string' ? { ...p, defaultValue: v } : p;
}

/**
 * 覆盖 / 追加 / 移除，按 `spec.params` 的顺序追加新键。
 * `omit` 最后生效，所以复用者可以先覆盖再整体删掉某项。
 */
function mergeParams(spec: ParticleSpec): ParamDef[] {
  const base = particleParams();
  if (!spec.params) return spec.omit ? base.filter((p) => !spec.omit!.includes(p.key)) : base;
  const extra = spec.params;
  const byKey = new Map(base.map((p) => [p.key, p]));
  const order = [...base.map((p) => p.key)];
  for (const p of extra) {
    if (!byKey.has(p.key)) order.push(p.key);
    byKey.set(p.key, p);
  }
  const omit = new Set(spec.omit ?? []);
  return order.filter((k) => !omit.has(k)).map((k) => byKey.get(k)!);
}

/** 单测 / 守卫用：确认 spec 追加的参数键没有撞上归一化读的内建键。 */
export function specConflicts(spec: ParticleSpec): string[] {
  const known = particleParamKeys(particleParams());
  const added = (spec.params ?? []).filter((p) => known.has(p.key) && p.type !== undefined);
  // 覆盖是允许的；这里只报「追加了一个同名但类型不同的键」这类真冲突。
  const baseTypes = new Map(particleParams().map((p) => [p.key, p.type]));
  return added.filter((p) => baseTypes.get(p.key) !== p.type).map((p) => p.key);
}

export {
  PARTICLE_GROUPS,
  PARTICLE_COLLAPSED_GROUPS,
  PARTICLE_PRESETS,
  PARTICLE_SHAPES,
  PARTICLE_BLENDS,
  PARTICLE_DIMS,
  PARTICLE_CHANNELS,
  PARTICLE_ASSET_KEYS,
  PARTICLE_HARD_CAP,
  applyParticlePreset,
  expandParticlePreset,
  isParticlePresetId,
  normalizeParticleConfig,
  particleCapacity,
  particleTexSize,
  clampNum,
  hexRgb,
  particleParams,
  particleGroupLabel,
  PARTICLE_AUX_REFS,
  assetIdOf,
  clearParticleAssetRefs,
  ParticleEngine,
  DEFAULT_PARTICLE_SHADERS,
  type ParticleConfig,
  type ParticlePreset,
  type ParticleGroupId,
  type ParticleShape,
  type ParticleBlend,
  type ParticleDim,
  type ParticleChannel,
  type ParticleShaders,
  type ParticleHooks,
  type ParticleEngineOptions,
  type ParticleDiagnostics,
};
