/**
 * curve-meta.ts — 曲线编辑器里「这条曲线是什么参数、量纲是多少」的唯一来源。
 *
 * 曲线数据本身只有键名（`opacity` / `transform.x` / `${instanceId}.${param}`），
 * 量纲要从片段 + 特效/生成器定义表反推。检查器里这些值是**内联写死**在模板里
 * 的（`min={0} max={1}` 那一批），编辑器不能再抄一份 —— 抄了就是「滑杆能拖到 4，
 * 曲线编辑器只能拖到 1」这种静默不一致。
 *
 * 这里也负责「哪些参数能打关键帧」：判据与 `Inspector.svelte::keyframable` 相同
 * （渲染期读的参数才行；烘焙入参每帧重烘会卡死）。
 */

import type { AnyClip } from '../../core/schema';
import type { RangeParam } from '../../effects/types';
import { getGenerator } from '../../algos/registry';
import { getEffect } from '../../effects/registry';
import { resolveLabel } from '../../i18n/label';
import { tr } from '../../i18n/index.svelte';

export interface CurveParam {
  /** `clip.curves` 的键，也是本模块的唯一定位符。 */
  key: string;
  /** 已翻译的显示名。 */
  label: string;
  /** 分组（片段 / 生成器名 / 特效名 / 音频）。 */
  group: string;
  min: number;
  max: number;
  step: number;
  /** 没有曲线时这个参数的当前值 —— 新建关键帧的起点。 */
  base: number;
  /** 参数本身是否还能新增关键帧（已有曲线总是可以编辑）。 */
  animatable: boolean;
}

const CLIP_PARAMS: Omit<CurveParam, 'base' | 'animatable'>[] = [
  { key: 'opacity', label: '', group: '', min: 0, max: 1, step: 0.01 },
  { key: 'transform.x', label: '', group: '', min: 0, max: 1, step: 0.005 },
  { key: 'transform.y', label: '', group: '', min: 0, max: 1, step: 0.005 },
  { key: 'transform.sx', label: '', group: '', min: 0.05, max: 4, step: 0.01 },
  { key: 'transform.sy', label: '', group: '', min: 0.05, max: 4, step: 0.01 },
  { key: 'transform.rot', label: '', group: '', min: -3.1416, max: 3.1416, step: 0.01 },
];

const CLIP_LABELS: Record<string, 'insp.opacity' | 'insp.posX' | 'insp.posY' | 'insp.scaleX' | 'insp.scaleY' | 'insp.rotate'> = {
  opacity: 'insp.opacity',
  'transform.x': 'insp.posX',
  'transform.y': 'insp.posY',
  'transform.sx': 'insp.scaleX',
  'transform.sy': 'insp.scaleY',
  'transform.rot': 'insp.rotate',
};

/** 片段自身的基值（与 `ui/clip-edit.ts::baseOf` 同一份数据，但不依赖它）。 */
function clipBase(clip: AnyClip, key: string): number {
  if (clip.kind !== 'source') return 0;
  if (key === 'opacity') return clip.opacity;
  if (key.startsWith('transform.')) {
    const field = key.slice('transform.'.length) as keyof typeof clip.transform;
    return Number(clip.transform[field] ?? 0);
  }
  return 0;
}

/**
 * 一个片段上**全部**可关键帧参数（含尚未建曲线的）。
 *
 * 顺序 = 界面里的顺序：片段 → 生成器 → 特效链 → 音频。
 */
export function animatableParams(clip: AnyClip): CurveParam[] {
  const out: CurveParam[] = [];
  const seen = new Set<string>();
  const push = (p: CurveParam): void => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    out.push(p);
  };

  if (clip.kind === 'source') {
    const group = tr('curve.group.clip');
    for (const p of CLIP_PARAMS) {
      push({
        ...p,
        label: tr(CLIP_LABELS[p.key]!),
        group,
        base: clipBase(clip, p.key),
        animatable: true,
      });
    }
  }

  /*
   * 视频变速（v14）。允许负值（倒放），区间与检查器的 KeyableField 一致；
   * 没有曲线时它就是 `source.speed` 的基值。
   */
  if (clip.kind === 'source' && clip.source.type === 'video') {
    push({
      key: 'speed',
      label: tr('insp.speed'),
      group: tr('curve.group.clip'),
      min: -8,
      max: 8,
      step: 0.05,
      base: clip.source.speed,
      animatable: true,
    });
  }

  if (clip.kind === 'source' && clip.source.type === 'algo') {
    const def = getGenerator(clip.source.generator);
    const group = def ? resolveLabel(def.nameKey, tr) : tr('curve.group.algo');
    if (def) {
      for (const p of def.params) {
        if (p.type !== 'range') continue;
        /*
         * 与检查器同一条判据：bake 只有 speed 在渲染期读；sim 的入参每条都进
         * 构造哈希（改一次重建一次，不能逐帧变）。`gpu-sim` 虽然也是有状态
         * 模拟，但它的 `volatile` 已经把「只影响渲染」的键排除出哈希 ——
         * 剩下的 range 参数按帧求值不影响状态推进，所以与 realtime 同待遇。
         */
        const animatable =
          def.kind === 'realtime' || def.kind === 'gpu-sim' || (def.kind === 'bake' && p.key === 'speed');
        push({
          key: p.key,
          label: resolveLabel(p.labelKey, tr),
          group,
          min: p.min,
          max: p.max,
          step: p.step,
          base: Number(clip.source.params[p.key] ?? p.defaultValue),
          animatable,
        });
      }
    }
  }

  if (clip.kind === 'effect') {
    for (const [index, inst] of clip.chain.entries()) {
      const entry = getEffect(inst.defId);
      const name = entry ? resolveLabel(entry.nameKey, tr) : tr('curve.group.effect');
      // 同一条链里挂两个「像素化」时，两组参数的行名会一模一样 —— 加序号才分得清
      // 哪一组是关键帧编辑器里的哪一段。单实例时不加，免得平白多一个「1」。
      const group = clip.chain.length > 1 ? `${name} ${index + 1}` : name;
      for (const p of entry?.params ?? []) {
        if (p.type !== 'range') continue;
        push(rangeParam(p, group, `${inst.instanceId}.${p.key}`, Number(inst.values[p.key] ?? p.defaultValue)));
      }
    }
  }

  if (clip.kind === 'audio') {
    push({
      key: 'gain',
      label: tr('curve.gain'),
      group: tr('curve.group.audio'),
      min: 0,
      max: 2,
      step: 0.01,
      base: 1,
      animatable: true,
    });
  }

  /*
   * 已有曲线但参数已经不可编辑（换过生成器、删了特效实例、手改过 JSON）：
   * 仍然列出来 —— 否则那条曲线在界面上**完全消失**，用户既改不了也删不掉，
   * 只能去手改工程文件。量纲退回 0..1，只要能看到、能删掉就够。
   */
  for (const key of Object.keys(clip.curves)) {
    if (seen.has(key)) continue;
    const values = (clip.curves[key]?.keys ?? []).map((k) => k.v);
    const base = values.length ? values[0]! : 0;
    push({
      key,
      label: key,
      group: tr('curve.group.other'),
      min: Math.min(0, ...values),
      max: Math.max(1, ...values),
      step: 0.01,
      base,
      animatable: false,
    });
  }

  return out;
}

function rangeParam(p: RangeParam, group: string, key: string, base: number): CurveParam {
  return {
    key,
    label: resolveLabel(p.labelKey, tr),
    group,
    min: p.min,
    max: p.max,
    step: p.step,
    base,
    animatable: true,
  };
}

/** 按键名找参数定义；找不到时给一个 0..1 的兜底（与 `animatableParams` 的尾部一致）。 */
export function curveParamOf(clip: AnyClip, key: string | null): CurveParam | null {
  if (!key) return null;
  return animatableParams(clip).find((p) => p.key === key) ?? null;
}
