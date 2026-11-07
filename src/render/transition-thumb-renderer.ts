/**
 * transition-thumb-renderer.ts — 转场缩略图的**离屏渲染器**。
 *
 * 与 `effect-thumb-renderer.ts` / `algo-thumb-renderer.ts` 是三兄弟，都服务于同一条
 * 路线：**缩略图是预先导出的静态资源**，运行时只贴 `<img>`，零渲染开销。
 *
 * ## 怎么渲出「两张图在 50% 进度的过渡状态」
 *
 * 不另写一套混合，而是**造一张最小工程让真转场跑出来**：
 *
 * ```
 *   轨道：[ from 源 (0→1s, transitionOut) , to 源 (1→1s 起) ]
 *   t = 1s（剪切点） ⇒ 窗口 = [0.5, 1.5) ⇒ progress 恰好 0.5
 * ```
 *
 * 于是它走的是**和预览完全同一条** `buildStack → compositor → runTransition` 路径 ——
 * 转场着色器的参数、`ratio`、clamp、甚至「这条转场编译失败会退化成 dissolve」的行为，
 * 缩略图里与时间轴上逐字一致。**这就是选择器里显示的东西**，不是另一套近似实现。
 *
 * ## 三个必须的细节
 *
 * 1. **两张底图必须同时在场。** 转场 op 要 `from` / `to` 两张全帧层，缺一侧
 *    `drawTransition` 会退化成「只剩一侧」。两个 `trthumb:` 伪 generator id 由
 *    本文件的 resolver 各自解析成一张底图。
 * 2. **`readPixels` 是自下而上的，要翻行**（GL 原点在左下，`ImageData` 第 0 行在顶部）。
 *    复用 `effect-thumb-renderer.ts` 的 `pixelsToCanvas`，全项目只有那一份实现。
 * 3. **两侧都是 `stretch` 铺满**，不留黑边 —— 否则擦除 / 滑移类转场对着黑边看不出位移。
 */

import {
  SCHEMA_VERSION,
  type Project,
  type SourceClip,
  type Track,
  type VisualTrack,
} from '../core/schema';
import type { Kit, Target } from '../engine/kit';
import type { SourceTexture } from '../engine/compositor';
import { createRenderCore, type RenderCore } from './render-core';
import { defaultTransitionValues, getTransition } from '../effects/transitions/registry';
import {
  TRANSITION_THUMB_PREFIX,
  isTransitionThumbGeneratorId,
  transitionThumbBase,
} from '../effects/transitions/thumbnails';
// 翻行 + 取偶尺寸只有一份实现，就在 effect-thumb-renderer 里（见那边头注）。
import { THUMB_ASPECT, pixelsToCanvas, thumbSize, type ThumbSize } from './effect-thumb-renderer';

export type { ThumbSize };
export { THUMB_ASPECT, thumbSize };

/** 缩略图的固定种子（硬约束 1.2：任何随机都要可复现，且不随会话变）。 */
const THUMB_SEED = 0x71ab33;
/** 帧率只用于 `u_delta` 与曲线上下文，与工程帧率无关。 */
const THUMB_FPS = 30;
/**
 * 单侧片段的长度 = 转场时长。窗口 = `[cut - d/2, cut + d/2)`，取 `t = cut`
 * ⇒ progress 恰好 0.5。两侧长度都 ≥ d 时 `transitionCut` 的钳制不会缩窗。
 */
const THUMB_SPAN = 1;
/** 窗口左端（= from.end − d/2）。progress 与渲染时刻的关系是 `t = 左端 + progress`。 */
const WINDOW_START = THUMB_SPAN - THUMB_SPAN / 2;
/**
 * 主选进度：**两张图各一半**的那个瞬间。
 *
 * 备用进度只在主选**退化成一张纯色**时才用 —— 有几条转场的中点本来就是退化状态：
 * `circle` / `CircleCrop` / `Rectangle` / `RectangleCrop` 在 progress=0.5 时半径恰好是 0
 * （整屏只剩底色），`SimpleFlip` 在 0.5 时只留中间一条缝，`StereoViewer` 在 0.48–0.52
 * 之间是纯黑。这些缩略图「看起来像坏了」，等于这张图白做 —— 所以宁可挪一点点。
 *
 * 候选按「离 0.5 由近到远」排，取第一个不纯色的；都不行就保留纯色里最不平的那张。
 *
 * `0.35` / `0.65` 是给 `Rectangle` / `RectangleCrop` 留的：它们的方框在 `|p−0.5| < 0.25`
 * 时已经铺满整帧（此时整帧就是一个底色），要退到 0.35 才重新露出边上的原图。
 */
export const TRANSITION_THUMB_PROGRESS = 0.5;
const PROGRESS_CANDIDATES = [TRANSITION_THUMB_PROGRESS, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
/** 亮度极差（0..765）低于这个值 = 整张图一个颜色。 */
const FLAT_RANGE = 24;

/** 两张底图的渲染器：与 `effect-thumb-renderer.ts` 的 `BaseRenderer` 同构，按尺寸池化。 */
class BaseImages {
  private readonly pool = new Map<string, Target>();

  constructor(private readonly kit: Kit) {}

  render(id: string): SourceTexture | null {
    const base = transitionThumbBase(id);
    if (!base) return null;
    const w = this.kit.w;
    const h = this.kit.h;
    const key = `${id}:${w}x${h}`;
    let out = this.pool.get(key);
    if (!out || out.w !== w || out.h !== h) {
      out = this.kit.target(w, h);
      this.pool.set(key, out);
    }
    const prog = this.kit.quad(base.fragment, `trthumb-base-${id}`);
    prog.use().u('u_resolution', [w, h]);
    this.kit.pass(prog, out);
    return { tex: out.tex, w, h };
  }

  dispose(): void {
    for (const t of this.pool.values()) t.dispose();
    this.pool.clear();
  }
}

/**
 * 造一张缩略图用的最小工程。
 *
 * 一条视觉轨、两个紧邻的源片段，出画片段挂着被测的那条转场。
 * 轨道顺序在这里无所谓（只有一条轨），转场判断靠的是**同轨紧邻**。
 */
function thumbProject(defId: string, values: Record<string, number>, size: ThumbSize): Project {
  const from: SourceClip = {
    id: 'tr-from',
    label: 'from',
    kind: 'source',
    start: 0,
    end: THUMB_SPAN,
    fadeSec: 0,
    curves: {},
    source: { type: 'algo', generator: `${TRANSITION_THUMB_PREFIX}from`, params: {} },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    // 铺满：擦除 / 滑移类转场对着黑边看不出位移。
    fit: 'stretch',
    transitionOut: { defId, duration: THUMB_SPAN, values },
  };
  const to: SourceClip = {
    id: 'tr-to',
    label: 'to',
    kind: 'source',
    start: THUMB_SPAN,
    end: THUMB_SPAN * 2,
    fadeSec: 0,
    curves: {},
    source: { type: 'algo', generator: `${TRANSITION_THUMB_PREFIX}to`, params: {} },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  };
  const track: VisualTrack = { kind: 'visual', id: 'tr-t', name: 'TR', enabled: true, clips: [from, to] };
  const tracks: Track[] = [track];
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'transition-thumb',
    seed: THUMB_SEED,
    fps: THUMB_FPS,
    resolution: { w: size.w, h: size.h },
    duration: THUMB_SPAN * 2,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    overlapBehavior: 'reject',
    assets: {},
    tracks,
    // 缩略图工程不出段落带 / 节奏点（必填字段）。
    sections: [],
    beatMarks: [],
  };
}

/** 亮度极差（R+G+B，0..765）。整张一个颜色时接近 0。 */
function luminanceRange(data: Uint8Array): number {
  let min = 255 * 3;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const s = data[i]! + data[i + 1]! + data[i + 2]!;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return max - min;
}

/** 一张缩略图 + 它的实际采样进度（见 `PROGRESS_CANDIDATES`）。 */
export interface TransitionThumbShot {
  canvas: HTMLCanvasElement;
  /** 正常是 0.5；这一条的中点退化成纯色时是候选里的另一个值。 */
  progress: number;
}

/**
 * 离屏渲染「两张底图 + 某转场 @ 50%」的定格画面。
 *
 * 上下文**惰性创建**：只有真渲染时才多一个 WebGL 上下文（建不出时返回 null，
 * 调用方自行降级 —— 选择器里的卡片退化成「只有名字与说明」，功能仍可用）。
 */
export class TransitionThumbRenderer {
  private core: RenderCore | null = null;
  private bases: BaseImages | null = null;

  /**
   * 渲染一张。建不出上下文 / 目录里没有这个转场时返回 null。
   *
   * 先在 0.5 拍一张；**只有在那一张退化成纯色时**才换候选进度重拍
   * （判据与理由见 `PROGRESS_CANDIDATES`）。
   */
  renderShot(defId: string, size: ThumbSize): TransitionThumbShot | null {
    const core = this.ensureCore();
    if (!core || !getTransition(defId)) return null;

    core.renderer.setExportSize(size.w, size.h);
    const project = thumbProject(defId, defaultTransitionValues(defId), size);

    let best: TransitionThumbShot & { range: number } | null = null;
    for (const progress of PROGRESS_CANDIDATES) {
      // 先清历史：反馈池与转场无关，但保持与特效缩略图同一条纪律，也保证可重放。
      core.renderer.onSeek();
      core.renderer.renderFrame(project, WINDOW_START + progress);
      const px = core.renderer.readPixels();
      const range = luminanceRange(px.data);
      const canvas = pixelsToCanvas(px);
      if (!canvas) continue;
      if (!best || range > best.range) best = { canvas, progress, range };
      if (range >= FLAT_RANGE) break; // 0.5 就是好的，不必再试
    }
    return best ? { canvas: best.canvas, progress: best.progress } : null;
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
      // 与特效 / 生成器缩略图同一条降级。诊断用英文，与既有的 `[thumb-renderer]` 一致。
      console.warn('[transition-thumb] fallback: cannot create offscreen context', err);
      return null;
    }
  }

  private createCore(): RenderCore {
    const canvas = document.createElement('canvas');
    const core = createRenderCore(canvas, {
      getProject: () => ({ beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 }, seed: THUMB_SEED, fps: THUMB_FPS }),
      onAlgoReady: () => {},
    });
    const bases = new BaseImages(core.kit);

    /*
     * 拦截 `trthumb:` 前缀的伪 generator id：拿到 SourceManager 原本的 resolver
     * 作兜底，只把伪 id 换成两张底图。注册表与 schema 都不需要知道它存在。
     */
    const inner = core.sources.resolve;
    core.renderer.setResolver((clip, t, frame) => {
      const s = clip.source;
      if (s.type !== 'algo' || !isTransitionThumbGeneratorId(s.generator)) return inner(clip, t, frame);
      return bases.render(s.generator.slice(TRANSITION_THUMB_PREFIX.length));
    });

    this.core = core;
    this.bases = bases;
    return core;
  }
}
