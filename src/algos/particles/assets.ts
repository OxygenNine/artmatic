/**
 * assets.ts — 粒子素材输入的**口径与缺席回退**（纯函数，可单测）。
 *
 * 两类输入，语义完全不同，别混：
 *   - `spriteAsset` 粒子精灵：每颗粒子贴一张图。影响**渲染**，不影响状态，
 *     所以它是 `volatile`（改它不该让跑了几千步的模拟从头重放）。
 *   - `emitAsset` 发射密度图：按 luma / alpha 决定「在哪儿、以多大概率出生」。
 *     影响**状态**，必须进构造哈希。
 *
 * 都只接受静态图片。视频会在任意 seek 上引入异步取帧，与
 * `seek(f) ≡ 顺序 step f 次` 冲突 —— 需要视频当纹理是独立一轮的事。
 */

import { clearAssetRefsInProject, validAssetParamValue } from '../../core/asset-params';
import type { AlgoAuxRef } from '../types';
import type { AlgoAuxTexture } from '../shader-lib';
import { PARTICLE_ASSET_KEYS } from './config';

/** 两个 sampler 的声明。运行时按 `assetParam` 从参数表读 assetId。 */
export const PARTICLE_AUX_REFS: readonly AlgoAuxRef[] = [
  { uniform: 'u_sprite', kind: 'asset-image', assetParam: 'spriteAsset' },
  { uniform: 'u_emitMask', kind: 'asset-image', assetParam: 'emitAsset' },
];

export type ParticleAssetKey = (typeof PARTICLE_ASSET_KEYS)[number];

/** 参数表里的 assetId。未绑定 / 坏值一律空串（不抛）。 */
export function assetIdOf(values: Record<string, number | string>, key: ParticleAssetKey): string {
  const v = values[key];
  return typeof v === 'string' ? v : '';
}

/** 本帧真正拿到的 aux 纹理；缺席返回 null。 */
export function auxOf(
  aux: ReadonlyMap<string, AlgoAuxTexture> | undefined,
  uniform: string,
): AlgoAuxTexture | null {
  return aux?.get(uniform) ?? null;
}

/**
 * 缺席回退的**策略表**。刻意写成数据而不是散落在 shader 里的 if：
 * 「素材还没解码好」与「用户没绑素材」在界面上是两种事，但渲染上必须是
 * 同一种可预期画面 —— 否则一帧空帧会被当成粒子系统坏了。
 */
export interface AssetFallback {
  /** 缺席时 shader 里的 `u_*On` 取值。 */
  on: number;
  /** 给状态栏的一句话（文案键段）。 */
  noticeKey: string;
}

export const SPRITE_FALLBACK: AssetFallback = { on: 0, noticeKey: 'spriteMissing' };
export const EMIT_FALLBACK: AssetFallback = { on: 0, noticeKey: 'emitMissing' };

/** 素材引用的形状校验（写入前置）。真源在 core，这里重导出给复用者。 */
export { validAssetParamValue };

/**
 * 供 `retire` 引用修复用：把单个参数表里指向该素材的引用置空。
 * 工程级的批量修复走 `clearAssetRefsInProject`（`appState.removeAsset`）。
 */
export function clearParticleAssetRefs(
  params: Record<string, number | string>,
  assetId: string,
): { params: Record<string, number | string>; changed: string[] } {
  const out = { ...params };
  const changed: string[] = [];
  for (const k of PARTICLE_ASSET_KEYS) {
    if (out[k] === assetId) {
      out[k] = '';
      changed.push(k);
    }
  }
  return { params: out, changed };
}

/** 工程级引用修复的重导出（纯函数）。 */
export { clearAssetRefsInProject };
