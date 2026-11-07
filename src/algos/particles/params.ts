/**
 * params.ts — 粒子生成器的参数表（**唯一真源**）。
 *
 * 「参数浩如烟海」靠三件事收住，不靠把参数藏起来：
 *   1. `group` 元数据 → 全屏编辑器按组折叠（`PARTICLE_COLLAPSED_GROUPS`）；
 *   2. `visibleWhen` → 当前模式不适用的项根本不出现（3D 镜头 / 素材子项）；
 *   3. 预设表 → 一次写入一组值，用户从「改得动的那一组」起步。
 *
 * `group` 是元数据而非第二套控件体系：检查器 / LabParams / 全屏编辑器
 * 都吃同一个 `visibleParams()`，只是排布不同。
 */

import type { ColorParam, ParamDef, RangeParam, SelectParam } from '../../effects/types';
import type { MessageKey } from '../../i18n/locales';
import { bgColorVisible, bgModeParam, intResParam } from '../shader-lib';
import {
  PARTICLE_CHANNELS,
  PARTICLE_DIMS,
  PARTICLE_SHAPES,
  PARTICLE_BLENDS,
  type ParticleGroupId,
} from './config';

const key = (k: string): MessageKey => `algo.particles.${k}` as MessageKey;

function range(
  k: string,
  group: ParticleGroupId,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  extra: Partial<RangeParam> = {},
): RangeParam {
  return { key: k, labelKey: key(k), type: 'range', min, max, step, defaultValue, group, ...extra };
}

function select(
  k: string,
  group: ParticleGroupId,
  values: readonly string[],
  defaultValue: string,
  extra: Partial<SelectParam> = {},
): SelectParam {
  return {
    key: k,
    labelKey: key(k),
    type: 'select',
    defaultValue,
    group,
    options: values.map((v) => ({ labelKey: key(`${k}.${v}`), value: v })),
    ...extra,
  };
}

function color(k: string, group: ParticleGroupId, defaultValue: string, extra: Partial<ColorParam> = {}): ColorParam {
  return { key: k, labelKey: key(k), type: 'color', defaultValue, group, ...extra };
}

/*
 * 谓词里的键一律写 `v.<key>`（**不用 `v['<key>']`**）：
 * `algo-params.test.ts` 的 `referencedKeys` 只认点号形式，写成方括号
 * 会让「visibleWhen 引用了不存在的键」这条守卫悄悄失效。
 */
/** 3D 投影专属的量：二维模式下藏起来，不留「拖了没反应」的控件。 */
const only3d = (v: Record<string, number | string>): boolean => v.dimension === '3d';
/** 只在绑定了精灵图时出现的子项。 */
const hasSprite = (v: Record<string, number | string>): boolean =>
  typeof v.spriteAsset === 'string' && v.spriteAsset.length > 0;
/** 只在绑定了发射密度图时出现的子项。 */
const hasEmit = (v: Record<string, number | string>): boolean =>
  typeof v.emitAsset === 'string' && v.emitAsset.length > 0;

/**
 * 完整参数表。`createParticleGenerator` 允许 spec 覆盖 / 追加，但**键空间
 * 只有这一份** —— 复用者不该另造同义键（那会让预设与 Agent 读回都漂）。
 */
export function particleParams(): ParamDef[] {
  return [
    /* ---------------------------------------------------------- 发射器 */
    /*
     * `count` 跨三个数量级（256…262144），**必须用对数刻度**：
     * 线性时「256 → 2000」只占轨道 0.7%（250px 里不到 2px），而用户九成时间
     * 待在这一段；换成对数后每翻一倍占 10% 行程，几百 ↔ 几千是几十个像素。
     * 步长取 1 而不是 256：对数刻度在低端每像素只走 ~7，步长 256 会形成
     * 30 多像素的「拖了没反应」死区。
     */
    range('count', 'emitter', 256, 262144, 1, 16384, { scale: 'log' }),
    select('shape', 'emitter', PARTICLE_SHAPES, 'disc'),
    range('emitterSize', 'emitter', 0, 2, 0.01, 0.45),
    range('life', 'emitter', 0.1, 30, 0.1, 3),
    range('lifeVar', 'emitter', 0, 1, 0.01, 0.6),
    range('speed', 'emitter', 0, 4, 0.01, 0.35),
    range('speedVar', 'emitter', 0, 1, 0.01, 0.5),
    range('spread', 'emitter', 0, 1, 0.01, 0.7),
    range('direction', 'emitter', -180, 180, 1, -90),

    /* ------------------------------------------------------------ 力场 */
    range('gravityX', 'forces', -3, 3, 0.01, 0),
    range('gravityY', 'forces', -3, 3, 0.01, -0.12),
    range('gravityZ', 'forces', -3, 3, 0.01, 0),
    range('drag', 'forces', 0, 4, 0.01, 0.35),
    range('turbulence', 'forces', 0, 3, 0.01, 0.25),
    range('turbScale', 'forces', 0.1, 12, 0.1, 2.2),
    range('vortex', 'forces', -3, 3, 0.01, 0),
    range('attract', 'forces', -3, 3, 0.01, 0),

    /* ------------------------------------------------------------ 外观 */
    range('pointSize', 'appearance', 1, 96, 0.5, 7),
    range('sizeVar', 'appearance', 0, 1, 0.01, 0.5),
    color('colorStart', 'appearance', '#ffd67a'),
    color('colorEnd', 'appearance', '#5c7aff'),
    range('opacity', 'appearance', 0, 1, 0.01, 0.85),
    select('blend', 'appearance', PARTICLE_BLENDS, 'add'),

    /* ------------------------------------------------------------ 素材 */
    {
      key: 'spriteAsset', labelKey: key('spriteAsset'), type: 'asset',
      defaultValue: '', accept: 'image', group: 'assets',
    },
    range('spriteRotate', 'assets', 0, 1, 0.01, 0, { visibleWhen: hasSprite }),
    select('spriteChannel', 'assets', PARTICLE_CHANNELS, 'alpha', { visibleWhen: hasSprite }),
    {
      key: 'emitAsset', labelKey: key('emitAsset'), type: 'asset',
      defaultValue: '', accept: 'image', group: 'assets',
    },
    select('emitChannel', 'assets', PARTICLE_CHANNELS, 'luma', { visibleWhen: hasEmit }),
    range('emitThreshold', 'assets', 0, 1, 0.01, 0.15, { visibleWhen: hasEmit }),

    /* ------------------------------------------------------------ 投影 */
    select('dimension', 'projection', PARTICLE_DIMS, '2d'),
    range('perspective', 'projection', 0, 3, 0.01, 1, { visibleWhen: only3d }),
    range('camYaw', 'projection', -180, 180, 1, 0, { visibleWhen: only3d }),
    range('camPitch', 'projection', -89, 89, 1, 12, { visibleWhen: only3d }),
    range('camDist', 'projection', 0.5, 10, 0.1, 3, { visibleWhen: only3d }),
    range('depthSize', 'projection', 0, 1, 0.01, 0.5, { visibleWhen: only3d }),

    /* ------------------------------------------------------------ 系统 */
    // `rate` 是步/秒（sim 家族约定），`liveRate` 每帧从当前参数读它，不进构造哈希。
    range('rate', 'system', 1, 240, 1, 60),
    bgModeParam(),
    color('colorBg', 'system', '#0c0f14', { visibleWhen: bgColorVisible }),
    intResParam(),
  ].map((p) => {
    // 家族共用参数没有 group，归入 system，避免编辑器里出现「其它」组。
    return p.group ? p : { ...p, group: 'system' as ParticleGroupId };
  }) as ParamDef[];
}

/** 分组标题的文案键（全屏编辑器用）。 */
export function particleGroupLabel(group: ParticleGroupId): MessageKey {
  return key(`group.${group}`);
}
