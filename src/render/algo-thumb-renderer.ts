/**
 * algo-thumb-renderer.ts — 算法生成器**预览缩略图**的离屏渲染器。
 *
 * 与 `effect-thumb-renderer.ts` 是一对：那个渲「底图 + 特效」，这个渲「单个生成器」。
 * 两者都是「**预先导出成静态图**」这条路线的一部分 —— 运行时只贴 `<img>`，
 * 零渲染开销（现渲实测会把帧数从 240 拉到 190）。
 *
 * ## 三个与特效那边不同的关键点
 *
 * 1. **必须在「长起来」的时刻截。** 元胞自动机、反应扩散、沙堆、雪花在第 0 秒
 *    是空屏（一个种子点），bake 型还要等生长前沿走完。所以采样时刻由
 *    `algos/catalog.ts` 的配方给，而不是固定 0。
 * 2. **烘焙是异步的，`renderFrame` 在它没就绪时返回空帧。** 所以这里**不**
 *    内部等 —— 它把「这一帧有多少非零像素」交回调用方，由调用方（Node 侧的
 *    批量脚本）轮询重试。这与 E2E 的 `waitForSourceReady` 是同一条纪律：
 *    **异步就绪从宿主侧轮询，不要在这里自旋**（自旋会把主线程占住，
 *    而 bake 的 Worker 需要主线程跑消息循环才会被唤醒）。
 * 3. **频谱与音频特征都要给。** 与特效那边一样：这些注入点「不传也能跑」，
 *    但全是**静默退化** —— `audio-bars` 会只剩底图，`scene-*` 会读到全零特征
 *    而变得又平又暗。缩略图是给人在菜单里挑东西用的，它必须代表**真实长相**。
 */

import {
  SCHEMA_VERSION,
  type Project,
  type SourceClip,
  type Track,
  type VisualTrack,
} from '../core/schema';
import { getGenerator } from '../algos/registry';
import type { SpectrumSource } from '../engine/spectrum-texture';
import { SPECTRUM_BINS } from '../audio/spectrum';
import type { AudioFeatureSource } from '../algos/feature-source';
import { createRenderCore, type RenderCore } from './render-core';
// 翻行 + 取偶尺寸这两件事**只有一份实现**，就在 effect-thumb-renderer 里。
// 抄第二份的下场是「特效缩略图是正的、生成器缩略图是倒的」，而且不报错。
import { THUMB_ASPECT, pixelsToCanvas, thumbSize, type ThumbSize } from './effect-thumb-renderer';

/** 缩略图的固定种子（硬约束 1.2：任何随机都要可复现，且不随会话变）。 */
const THUMB_SEED = 0x5eed11;
/** 帧率只用于 `u_delta` 与曲线上下文，与工程帧率无关。 */
const THUMB_FPS = 30;

export type { ThumbSize };
export { THUMB_ASPECT, thumbSize };

/** 一次渲染的结果。`lit === 0` 表示**还没长出来**（bake 未就绪 / 全黑画面）。 */
export interface AlgoThumbResult {
  /** 非零像素数。背景纯黑 + 无抗锯齿 ⇒ 非零即「有东西」。 */
  lit: number;
  total: number;
  /** 仅在 `lit > 0` 时给出（WebP 编码不便宜，没就绪就不编）。 */
  dataUrl: string | null;
}

/**
 * 缩略图用的**固定**频谱。与 `effect-thumb-renderer` 的 `staticSpectrum` 同一条
 * 理由：定格画面不需要它随时间动，但不给的话吃频谱的生成器会静默退化。
 */
function staticSpectrum(): SpectrumSource {
  const bins = SPECTRUM_BINS;
  const data = new Uint8Array(bins);
  for (let k = 1; k < bins; k += 1) {
    const f = k / (bins - 1);
    const env = Math.exp(-f * 5.5);
    const peak =
      0.35 * Math.exp(-Math.pow((f - 0.06) * 22, 2)) + 0.25 * Math.exp(-Math.pow((f - 0.22) * 14, 2));
    data[k] = Math.min(255, Math.round((0.12 + env * 0.55 + peak) * 255));
  }
  data[0] = 0;
  return { frameFor: () => data };
}

/**
 * 缩略图用的**合成**音频特征。
 *
 * 数值取向是「一段中等强度、低频偏重的音乐」：`rms` 0.62，频段从 sub 到 air
 * 递减，`centroid` 偏低，并给三个「刚发生过」的 onset 年龄 —— 冲量是闭式
 * `exp(-年龄/decay)`（kick .085 / hit .075 / bar .30 s），所以这三个年龄
 * 让画面带上一些正常的脉冲感，而不是一片死平。
 *
 * `travel` 按定义是 rms 的前缀积分，所以写成 `rms · t`。
 */
function staticFeatures(rms: number): AudioFeatureSource {
  const ages = [0.12, 0.55, 1.1, 2.0];
  return {
    at(t, out) {
      out.rms = rms;
      out.flux = 0.35;
      out.sub = 0.7;
      out.bass = 0.62;
      out.mid = 0.55;
      out.high = 0.42;
      out.air = 0.28;
      out.centroid = 0.35;
      out.flat = 0.3;
      out.travel = rms * t;
      // 就地写进 `out.ages`：它是复用对象上的数组，替换引用等于没写。
      for (let k = 0; k < 4; k += 1) out.ages[k] = ages[k]!;
    },
  };
}

/**
 * 造一张缩略图用的最小工程：**只有一条源轨**，`stretch` 铺满整帧。
 *
 * 不加特效层（缩略图要展示的是生成器本身），所以不涉及 `buildStack` 的
 * adjustment-layer 排序问题。
 *
 * 回放型（闪回）是唯一的例外：它的画面来自「片段之前」，单条 0 起的轨上什么
 * 都没有（缩略图会是一张空图，而空图正是这条素材守卫要挡的东西）。所以给它
 * 一个靠后的片段头 + 下面垫一条彩条轨，让它有「之前」可倒放。
 */
function thumbProject(
  defId: string,
  params: Record<string, number | string>,
  size: ThumbSize,
  duration: number,
): Project {
  const isRecall = getGenerator(defId)?.kind === 'recall';
  const clip: SourceClip = {
    id: 'thumb-src',
    label: 'src',
    kind: 'source',
    /*
     * 回放型：片段头放在采样点**前一秒左右**。
     *
     * 倒放的进度 0 对应「最靠近片段头的过去」，进度 1 对应窗口开头 ——
     * 所以越靠近片段头截，回放到的画面越靠后、越有内容。放在 40% 处截会
     * 只看到垫底素材的第 0 秒（几乎什么都没有）。
     */
    start: isRecall ? Math.max(0.5, duration - 1.05) : 0,
    end: duration,
    fadeSec: 0,
    curves: {},
    source: { type: 'algo', generator: defId, params },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    // 铺满而不是 contain：缩略图里不要黑边，那会把「黑底 + 亮形体」这类
    // 生成器的覆盖面积算错（`lit / total` 是判「有没有长出来」的量）。
    fit: 'stretch',
  };
  const track: VisualTrack = { kind: 'visual', id: 'thumb-t', name: 'SRC', enabled: true, clips: [clip] };
  const tracks: Track[] = [track];
  if (isRecall) {
    tracks.push({
      kind: 'visual',
      id: 'thumb-feed',
      name: 'FEED',
      enabled: true,
      clips: [
        {
          ...clip,
          id: 'thumb-feed-clip',
          label: 'feed',
          start: 0,
          /*
           * 垫底素材要**明显不是另一张缩略图**：彩条与 `bars` 那张一模一样，
           * 并排看会以为闪回坏了。流场是「一段处理过的影像」的合理替身，
           * 且在 5 秒处已经有结构（它的采样时刻是 4 秒）。
           */
          source: { type: 'algo', generator: 'scene-flow', params: {} },
        },
      ],
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'algo-thumb',
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

/**
 * 离屏渲染单个生成器的定格画面。
 *
 * 上下文**惰性创建**：批量脚本只在真要渲染时才会多一个 WebGL 上下文。
 * `renderOnce` 是幂等的 —— 调用方可以对同一个 `(id, t)` 反复调，直到
 * `lit > 0`（bake 就绪）。
 */
export class AlgoThumbRenderer {
  private core: RenderCore | null = null;
  private lastCanvas: HTMLCanvasElement | null = null;

  /**
   * 渲一帧。参数不合法 / 建不出上下文时返回 `null`（调用方自行降级）。
   *
   * `params` 由调用方给（= 生成器默认值 + `catalog` 的配方覆盖），这里**不做**
   * 参数求值 —— 求值在 `AlgoRuntime.resolve` 里，`?? defaultValue` 的语义
   * 只能有一处。
   */
  renderOnce(
    defId: string,
    params: Record<string, number | string>,
    size: ThumbSize,
    t: number,
    quality = 0.84,
  ): AlgoThumbResult | null {
    const core = this.ensureCore();
    if (!core) return null;

    // 时长取到采样点之后：`t >= clip.end` 时源根本不会被解析（渲染是空的）。
    const project = thumbProject(defId, params, size, t + 1);
    core.renderer.setExportSize(size.w, size.h);
    // 缩略图必须落在**精确**帧上。`stepBudgetMs` 缺省就是 0，这里显式写一遍：
    // 哪天默认值变了，缩略图会静默渲出「落后一截」的模拟状态。
    core.algos.setStepBudget(0);
    core.renderer.onSeek();
    core.renderer.renderFrame(project, t);

    const px = core.renderer.readPixels();
    const total = px.w * px.h;
    let lit = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if (px.data[i]! | px.data[i + 1]! | px.data[i + 2]!) lit += 1;
    }
    this.lastCanvas = pixelsToCanvas(px);
    if (lit === 0 || !this.lastCanvas) return { lit, total, dataUrl: null };
    return { lit, total, dataUrl: this.lastCanvas.toDataURL('image/webp', quality) };
  }

  dispose(): void {
    // 离屏上下文不 dispose 会一直占一个 WebGL 上下文名额。
    this.core?.renderer.kit.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.core = null;
    this.lastCanvas = null;
  }

  private ensureCore(): RenderCore | null {
    if (this.core) return this.core;
    if (typeof document === 'undefined') return null;
    try {
      return this.createCore();
    } catch (err) {
      // 与特效那边同一条降级：建不出第二个 WebGL 上下文不该让整个脚本崩。
      console.warn('[algo-thumb] fallback: cannot create offscreen context', err);
      return null;
    }
  }

  private createCore(): RenderCore {
    const canvas = document.createElement('canvas');
    const core = createRenderCore(canvas, {
      getProject: () => ({ beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 }, seed: THUMB_SEED, fps: THUMB_FPS }),
      onAlgoReady: () => {},
      spectrum: staticSpectrum(),
      features: staticFeatures(0.62),
    });
    this.core = core;
    return core;
  }
}
