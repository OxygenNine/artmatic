/**
 * clip-factory.ts — 片段工厂（方案 §3.3 末段）。
 *
 * **为什么必须由控制平面提供**：`store.addClip` 需要一个字段完整的 `AnyClip`
 * （`id / start / end / label / fadeSec / curves / kind / source / blend /
 * opacity / transform / fit`）。让 agent 逐个填是又啰嗦又易错 —— 少一个
 * `fadeSec` 就会让 `validateProject` 在保存时报错，而报错点在离调用点很远的地方。
 *
 * **纯函数**：只依赖 `core/` 与 i18n。默认值取自 `core/schema.ts` 的
 * `defaultTransform` / `newId`；生成器的参数默认值与特效的 `defaultValues`
 * 由调用方（控制平面）先解析好传进来 —— 这一层不认识 `algos/` 与 `effects/`
 * 的注册表。
 */

import { defaultTransform, newId } from '../core/schema';
import type { BlendMode, EffectClip, EffectInstance, SourceClip } from '../core/schema';
import type { Curve } from '../core/curve';
import { tr } from '../i18n/index.svelte';
import { ControlFailure } from './types';

export interface SourceClipInput {
  kind: SourceClip['source']['type'];
  /** 秒。 */
  start: number;
  /** 秒。 */
  end: number;
  /**
   * 显式 id。默认生成一个随机 UUID。
   *
   * **允许指定是刻意的**：agent 写的脚本要能复跑，固定 id 是重放的前提之一
   * （方案 §3.3）。
   */
  id?: string;
  label?: string;
  /** `kind: 'algo'`。必须是注册表里存在的生成器 id（控制平面校验）。 */
  generator?: string;
  params?: Record<string, number | string>;
  /** `kind: 'solid'`。 */
  color?: string;
  /** `kind: 'image' | 'video'`。 */
  assetId?: string;
  /** `kind: 'video'` 的源内偏移（秒）与倍速。 */
  srcIn?: number;
  speed?: number;
  /** `kind: 'text'`。 */
  doc?: unknown;
  /** `kind: 'three'`。契约见 `three/code.ts`（控制平面已做过语法检查）。 */
  code?: string;
  blend?: BlendMode;
  opacity?: number;
  transform?: Partial<SourceClip['transform']>;
  fit?: SourceClip['fit'];
  fadeSec?: number;
  curves?: Record<string, Curve>;
  transitionIn?: SourceClip['transitionIn'];
  transitionOut?: SourceClip['transitionOut'];
  /** 视频内嵌音轨设置（v13，只有 video 源有意义）。 */
  audio?: SourceClip['audio'];
}

function checkSpan(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new ControlFailure('invalid-argument', tr('agent.clip.badSpanFinite'));
  }
  if (!(start >= 0)) {
    throw new ControlFailure('invalid-argument', tr('agent.clip.badSpanStart'), { start });
  }
  if (!(end > start)) {
    throw new ControlFailure('invalid-argument', tr('agent.clip.badSpanOrder'), { start, end });
  }
}

function sourceOf(input: SourceClipInput): SourceClip['source'] {
  switch (input.kind) {
    case 'algo': {
      if (!input.generator) {
        throw new ControlFailure('invalid-argument', tr('agent.clip.needGenerator'));
      }
      return { type: 'algo', generator: input.generator, params: { ...(input.params ?? {}) } };
    }
    case 'solid':
      return { type: 'solid', color: input.color ?? '#000000' };
    case 'image': {
      if (!input.assetId) {
        throw new ControlFailure('invalid-argument', tr('agent.clip.needAsset', { kind: 'image' }));
      }
      return { type: 'image', assetId: input.assetId };
    }
    case 'video': {
      if (!input.assetId) {
        throw new ControlFailure('invalid-argument', tr('agent.clip.needAsset', { kind: 'video' }));
      }
      return {
        type: 'video',
        assetId: input.assetId,
        srcIn: Math.max(0, input.srcIn ?? 0),
        // 与 `schema.ts` 的校验 / `ProjectStore.setClipSpeed` 同一区间：负速只走曲线。
        speed: (input.speed ?? 0) > 0 ? Math.min(100, Math.max(0.05, input.speed!)) : 1,
      };
    }
    case 'text': {
      if (!input.doc) {
        throw new ControlFailure('invalid-argument', tr('agent.clip.needDoc'));
      }
      return { type: 'text', doc: input.doc as never };
    }
    case 'three': {
      // 语法检查在控制平面做（这里不认识 `three/code.ts` 之外的任何东西，
      // 而不想为了一个错误消息把那段也拉进来）。
      return { type: 'three', code: input.code ?? '' };
    }
    default:
      throw new ControlFailure(
        'invalid-argument',
        tr('agent.clip.unknownSource', { kind: String(input.kind) }),
      );
  }
}

/** 缺省标签：有意义的那个值（生成器 id / 颜色 / 素材 id），而不是空串。 */
function defaultLabel(input: SourceClipInput): string {
  switch (input.kind) {
    case 'algo':
      return input.generator ?? 'algo';
    case 'solid':
      return input.color ?? 'solid';
    case 'image':
    case 'video':
      return input.assetId ?? input.kind;
    case 'three':
      return 'three.js';
    default:
      return 'text';
  }
}

/** 造一个字段完整的 `SourceClip`：其余字段一律走默认值。 */
export function makeSourceClip(input: SourceClipInput): SourceClip {
  checkSpan(input.start, input.end);
  return {
    kind: 'source',
    id: input.id ?? newId(),
    start: input.start,
    end: input.end,
    label: input.label ?? defaultLabel(input),
    fadeSec: Math.max(0, input.fadeSec ?? 0),
    curves: { ...(input.curves ?? {}) },
    source: sourceOf(input),
    blend: input.blend ?? 'normal',
    opacity: input.opacity ?? 1,
    transform: { ...defaultTransform(), ...(input.transform ?? {}) },
    /*
     * `solid` 的源是一张 **1×1 纹理**（`engine/sources.ts::solid`），所以
     * `contain` 会把它画成画面短边长的**正方形**（16:9 工程里只占中间一块）。
     * 纯色片段的意图几乎总是「铺满整个画面」，默认因此给 `stretch` ——
     * 与 UI 新建纯色片段同档（`ui/Timeline.svelte`）。
     */
    fit: input.fit ?? (input.kind === 'solid' ? 'stretch' : 'contain'),
    ...(input.transitionIn ? { transitionIn: input.transitionIn } : {}),
    ...(input.transitionOut ? { transitionOut: input.transitionOut } : {}),
    ...(input.kind === 'video' && input.audio ? { audio: { ...input.audio } } : {}),
  };
}

export interface EffectClipInput {
  start: number;
  end: number;
  id?: string;
  label?: string;
  /** 特效链。`defId` 由控制平面校验；`values` 缺省时由调用方补默认值。 */
  chain?: { defId: string; values?: Record<string, number | string>; instanceId?: string; enabled?: boolean }[];
  fadeSec?: number;
  curves?: Record<string, Curve>;
  /** 影响深度：只作用于下方最近的 N 条启用视觉轨；0 / 缺省 = 下方全部。 */
  affectDepth?: number;
  /** 绑定片段：链只作用在这个 SourceClip 的层上（与 `affectDepth` 互斥）。 */
  boundClipId?: string;
}

/** 造一个 `EffectClip`（adjustment layer 语义，只作用于 z 序在它之下的合成结果）。 */
export function makeEffectClip(input: EffectClipInput): EffectClip {
  checkSpan(input.start, input.end);
  if (input.affectDepth !== undefined && (!Number.isInteger(input.affectDepth) || input.affectDepth < 0)) {
    throw new ControlFailure('invalid-argument', tr('agent.args.affectDepth'));
  }
  if (input.boundClipId !== undefined && (typeof input.boundClipId !== 'string' || !input.boundClipId)) {
    throw new ControlFailure('invalid-argument', tr('agent.args.boundClip'), { boundClipId: input.boundClipId });
  }
  if (input.boundClipId !== undefined && input.affectDepth !== undefined) {
    // 互斥：绑定 = 「这一层的滤镜」，影响深度 = 「对下面几条轨做处理」。
    throw new ControlFailure('invalid-argument', tr('agent.args.boundVsDepth'));
  }
  const chain: EffectInstance[] = (input.chain ?? []).map((c) => ({
    instanceId: c.instanceId ?? newId(),
    defId: c.defId,
    enabled: c.enabled ?? true,
    values: { ...(c.values ?? {}) },
  }));
  return {
    kind: 'effect',
    id: input.id ?? newId(),
    start: input.start,
    end: input.end,
    label: input.label ?? 'effect',
    fadeSec: Math.max(0, input.fadeSec ?? 0),
    curves: { ...(input.curves ?? {}) },
    chain,
    ...(input.boundClipId ? { boundClipId: input.boundClipId } : {}),
    // 0 等同于缺省（下方全部），不写进工程里
    ...(input.affectDepth ? { affectDepth: input.affectDepth } : {}),
  };
}
