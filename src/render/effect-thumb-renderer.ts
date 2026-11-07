/**
 * effect-thumb-renderer.ts — 特效缩略图的**离屏渲染器**（缩略图与 lab 的批量导出共用）。
 *
 * 放在 `render/` 而不是 `effects/`：它要 `createRenderCore`（合成根），而
 * `render → effects` 是唯一合法的方向；放 `effects/` 会形成
 * `effects → render → effects` 的环。
 *
 * ## 为什么另起一个 render-core，而不是借预览那台
 *
 * 借预览那台要 `setExportSize` 改画布尺寸再还原，一不小心就把预览留在错的
 * 尺寸上；而且它要跟 rAF 抢同一批 ping-pong 目标。这里另起一台（lab 的同一
 * 手法：`createRenderCore` 是合成根，本来就为「多个宿主」设计）。
 *
 * 画面因此走**同一条**合成路径（placement / blend / ping-pong / 反馈池 /
 * pre-pass），所以它就是时间轴上会得到的东西，不是另一套近似实现 ——
 * 也就是说，**导出的缩略图与选择器里显示的是同一个东西**。
 *
 * ## 三个「必须」的细节
 *
 * 1. **`readPixels` 是自下而上的，要翻行。** GL 的帧缓冲原点在左下，
 *    而 `ImageData` 第 0 行是顶部。不翻的话每张都是倒的。
 *    守卫：E2E 拿 `pixelate`（底图 `ramp` 上半灰、下半彩）比上下两半的饱和度。
 * 2. **有历史的特效要连渲若干帧。** 只渲一帧的话，反馈类（echo / 隧道 / petri）
 *    与运动类（运动遮罩 / 融帧 / 数据融毁）的缩略图是黑或空 ——
 *    它们的画面本来就从「上一帧」里长出来。
 * 3. **必须给频谱。** `audio-bars` 的画面**全部**来自频谱，不给就只剩底图
 *    （第一版就是这样，格子上一根柱子都没有）。给一份固定的合成频谱即可 ——
 *    缩略图是定格画面，不需要它随时间动。这一类「不传也能跑」的注入点
 *    在这里全是**静默退化**，只能靠这条注释盯着。
 */

import {
  SCHEMA_VERSION,
  type EffectClip,
  type Project,
  type SourceClip,
  type Track,
  type VisualTrack,
} from '../core/schema';
import type { Kit, Program, Target } from '../engine/kit';
import type { SourceTexture } from '../engine/compositor';
import type { SpectrumSource } from '../engine/spectrum-texture';
import { SPECTRUM_BINS } from '../audio/spectrum';
import { createRenderCore, type RenderCore } from './render-core';
import { EFFECT_CATALOG } from '../effects/catalog';
import { getEffect } from '../effects/registry';
import {
  THUMB_PREFIX,
  isThumbGeneratorId,
  thumbBase,
  type ThumbBaseId,
} from '../effects/thumbnails/bases';

/** 缩略图的固定种子（硬约束 1.2：任何随机都要可复现，且不随会话变）。 */
const THUMB_SEED = 0x7a3f11;
/** 缩略图的时间基准。只用于「连渲几帧建历史」，与工程帧率无关。 */
const THUMB_FPS = 30;
/** 有历史的特效渲多少帧。0.4 s 足够让拖尾读得出来。 */
const HISTORY_FRAMES = 12;
/** 底图的宽高比。与工程默认一致。 */
export const THUMB_ASPECT = 16 / 9;

export interface ThumbSize {
  w: number;
  h: number;
}

/**
 * 由**高度**定尺寸（宽度按 16:9 推），并取偶。
 *
 * 取偶是刻意的：JPEG 的色度子采样在奇宽上没有好处，而下游（HTML 的
 * `width`/`height`、CSS 的 `aspect-ratio`）也更愿意拿整数。
 *
 * **先做 `isFinite` 兜底再取整**：`Math.max(16, Math.round(NaN))` 是 `NaN`
 * （`Math.max` 遇到 NaN 就传染），于是会造出一张 NaN 尺寸的 canvas ——
 * 导出静默得到一个 0 字节文件。输入来自下拉框与 URL 参数，挡一下不亏。
 */
export function thumbSize(height: number, aspect = THUMB_ASPECT): ThumbSize {
  const h = Math.max(16, Math.round(Number.isFinite(height) ? height : 0));
  const w = Math.max(16, Math.round((h * aspect) / 2) * 2);
  // 兜底保证 16 以上的宽度是偶数（`Math.max` 的夹取理论上不会破坏它，但别指望）
  return { w: w % 2 === 0 ? w : w + 1, h };
}

/** 该特效的缩略图要不要连渲若干帧建历史。 */
function needsHistory(defId: string): boolean {
  const entry = getEffect(defId);
  const meta = EFFECT_CATALOG[defId];
  if (!entry) return false;
  if (entry.shader.feedback) return true;
  // 不用 `u_feedback`、但自己持有跨帧状态（追踪叠加层）：一帧渲不出成形的东西。
  if (entry.shader.stateful) return true;
  if (entry.shader.prePasses?.some((p) => p.feedback || p.delayedInput)) return true;
  // 会动的底图：静止底图上运动量恒为 0，连渲才有东西可看
  return meta?.base === 'scroll';
}

/** 底图渲染器：与 `lab/patterns.ts` 同一手法，按名缓存 program，按尺寸池化目标。 */
class BaseRenderer {
  private readonly pool = new Map<string, Target>();

  constructor(private readonly kit: Kit) {}

  /** 只处理**内联 fragment** 的底图；走注册生成器的那种由调用方另行转交。 */
  render(baseId: ThumbBaseId, t: number): SourceTexture | null {
    const base = thumbBase(baseId);
    if (!base?.fragment) return null;
    const w = this.kit.w;
    const h = this.kit.h;
    const key = `${w}x${h}`;
    let out = this.pool.get(key);
    if (!out || out.w !== w || out.h !== h) {
      out = this.kit.target(w, h);
      this.pool.set(key, out);
    }
    const prog: Program = this.kit.quad(base.fragment, `thumb-base-${baseId}`);
    prog.use().u('u_time', t).u('u_resolution', [w, h]);
    this.kit.pass(prog, out);
    return { tex: out.tex, w, h };
  }
}

/** 缩略图用的**固定**频谱（见文件头第 3 条）。 */
function staticSpectrum(): SpectrumSource {
  const bins = SPECTRUM_BINS;
  const data = new Uint8Array(bins);
  for (let k = 1; k < bins; k += 1) {
    const f = k / (bins - 1);
    // 低频重、高频轻，叠两个峰 —— 读起来像一段有内容的音乐
    const env = Math.exp(-f * 5.5);
    const peak =
      0.35 * Math.exp(-Math.pow((f - 0.06) * 22, 2)) + 0.25 * Math.exp(-Math.pow((f - 0.22) * 14, 2));
    data[k] = Math.min(255, Math.round((0.12 + env * 0.55 + peak) * 255));
  }
  data[0] = 0; // 直流分量恒为 0
  // 定格画面，所以不随 t 变、也不做逐实例平滑（`smoothing` 与这里无关）。
  return { frameFor: () => data };
}

/**
 * 造一张缩略图用的最小工程。
 *
 * 轨道顺序沿用 `buildStack` 的约定：`tracks[0]` = 最前景，特效片段是
 * adjustment layer，必须排**在源轨之前**才盖得住（写反的表现是「特效完全
 * 无效且不报错」）。`stretch` 让底图铺满整帧，免得留黑边干扰观感。
 */
function thumbProject(defId: string, base: ThumbBaseId, size: ThumbSize, duration: number): Project {
  const clipBase = { start: 0, end: duration, fadeSec: 0, curves: {} };
  const fx: EffectClip = {
    ...clipBase,
    id: 'thumb-fx',
    label: 'fx',
    kind: 'effect',
    chain: [
      {
        // 每个特效一个 instanceId：反馈历史按 instanceId 池化，
        // 共用一个 id 的话上一条特效的历史会漏进下一条的第一帧。
        instanceId: `thumb-${defId}`,
        defId,
        enabled: true,
        // 默认值就能读出特效的走空表；时域那类要目录给配方（见 `EffectCatalogEntry.previewParams`）。
        values: { ...(EFFECT_CATALOG[defId]?.previewParams ?? {}) },
      },
    ],
  };
  const src: SourceClip = {
    ...clipBase,
    id: 'thumb-src',
    label: 'src',
    kind: 'source',
    source: { type: 'algo', generator: `${THUMB_PREFIX}${base}`, params: {} },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  };
  const fxTrack: VisualTrack = { kind: 'visual', id: 'thumb-t-fx', name: 'FX', enabled: true, clips: [fx] };
  const srcTrack: VisualTrack = { kind: 'visual', id: 'thumb-t-src', name: 'SRC', enabled: true, clips: [src] };
  // 特效轨在前 = z 更大 = 盖在源之上。
  const tracks: Track[] = [fxTrack, srcTrack];
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'thumb',
    seed: THUMB_SEED,
    fps: THUMB_FPS,
    resolution: { w: size.w, h: size.h },
    duration,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    overlapBehavior: 'reject',
    assets: {},
    tracks,
    // 缩略图工程不出段落带 / 节奏点（必填字段）。
    sections: [],
    beatMarks: [],
  };
}

/** 把读回的像素画进一张 2D canvas。**要翻行** —— 见文件头第 1 条。 */
export function pixelsToCanvas(px: { data: Uint8Array; w: number; h: number }): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = px.w;
  canvas.height = px.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(px.w, px.h);
  const rowBytes = px.w * 4;
  for (let y = 0; y < px.h; y += 1) {
    const src = (px.h - 1 - y) * rowBytes;
    img.data.set(px.data.subarray(src, src + rowBytes), y * rowBytes);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * 离屏渲染「目录底图 + 某特效」的定格画面。
 *
 * 上下文**惰性创建**（第一次真渲染时才建）：选择器打开时不会凭空多一个 WebGL
 * 上下文，而这个类同时被 lab 的批量导出用，那条路径上是必然要用的。
 */
export class EffectThumbRenderer {
  private core: RenderCore | null = null;
  private bases: BaseRenderer | null = null;

  /** 渲染一张。建不出上下文 / 目录里没有这个特效时返回 null（调用方自行降级）。 */
  renderCanvas(defId: string, size: ThumbSize): HTMLCanvasElement | null {
    const core = this.ensureCore();
    const meta = EFFECT_CATALOG[defId];
    if (!core || !meta) return null;

    const frames = needsHistory(defId) ? HISTORY_FRAMES : 1;
    const project = thumbProject(defId, meta.base, size, frames / THUMB_FPS + 0.5);

    core.renderer.setExportSize(size.w, size.h);
    // 先清历史：同一条特效反复渲染（或换特效）时，反馈池里不该留着上一次的。
    core.renderer.onSeek();
    for (let i = 0; i < frames; i += 1) core.renderer.renderFrame(project, i / THUMB_FPS);
    return pixelsToCanvas(core.renderer.readPixels());
  }

  dispose(): void {
    // 离屏上下文不 dispose 的话会一直占着一个 WebGL 上下文的名额。
    this.core?.renderer.kit.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.core = null;
    this.bases = null;
  }

  private ensureCore(): RenderCore | null {
    if (this.core) return this.core;
    if (typeof document === 'undefined') return null;
    try {
      return this.createCore();
    } catch (err) {
      // 建不出第二个 WebGL 上下文（设备上限 / 驱动拒绝）不该让选择器开不出来 ——
      // 卡片退化成「只有名字与说明」，功能仍可用。这条路径只在异常时走到。
      // 诊断信息用英文：与 `[bake]` / `[shader]` 那些既有诊断同一约定，也免得
      // 进 i18n 的硬编码守卫（面向用户的文案才需要走文案表）。
      console.warn('[thumb-renderer] fallback: cannot create offscreen context', err);
      return null;
    }
  }

  private createCore(): RenderCore {
    const canvas = document.createElement('canvas');
    const core = createRenderCore(canvas, {
      // 缩略图是定格的：拍网格只影响「曲线上下文」，缩略图里没有曲线。
      getProject: () => ({ beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 }, seed: THUMB_SEED, fps: THUMB_FPS }),
      onAlgoReady: () => {},
      spectrum: staticSpectrum(),
    });
    const bases = new BaseRenderer(core.kit);

    /*
     * 拦截 `thumb:` 前缀的伪 generator id。与 lab 包装 `lab:` 完全同一手法：
     * 拿到 SourceManager 原本的 resolver 作兜底，只把伪 id 换成底图。
     * 注册表与 schema 都不需要知道它存在。
     *
     * 底图有两种：内联 fragment（自己渲）与**走注册生成器**的（`mandel` 就是 ——
     * 这样它自动跟随 `mandelbrot` 的默认值）。后者把 generator 换成真的名字，
     * 转交回内层 resolver。漏了这一条的表现是「整张底图是黑的」。
     */
    const inner = core.sources.resolve;
    core.renderer.setResolver((clip, t, frame) => {
      const s = clip.source;
      if (s.type !== 'algo' || !isThumbGeneratorId(s.generator)) return inner(clip, t, frame);
      const baseId = s.generator.slice(THUMB_PREFIX.length) as ThumbBaseId;
      const base = thumbBase(baseId);
      if (!base) return null;
      if (base.fragment) return bases.render(baseId, t);
      if (base.generator) {
        return inner(
          { ...clip, source: { ...s, generator: base.generator, params: base.params ?? {} } },
          t,
          frame,
        );
      }
      return null;
    });

    this.core = core;
    this.bases = bases;
    return core;
  }
}
