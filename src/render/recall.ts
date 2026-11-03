/**
 * recall.ts — 「回放」服务：把工程在**过去某个时刻**的整帧渲出来，供闪回当源纹理。
 *
 * `recall` 型生成器（见 `algos/flashback.ts`）自身不算像素，它问这里要一张图：
 *
 *   AlgoRuntime.resolve
 *     → provider(clip, t, params)
 *       → recallWindowOf / recallTimeOf（纯函数，见 flashback.ts）
 *         → 本文件：另起一台 Compositor，把工程在 tPast 上重渲进一张目标
 *           → 那张纹理回到合成链，作为闪回这一层的源
 *
 * ## 为什么是「重渲」而不是「缓存过去渲染过的帧」
 *
 * 缓存听起来更省，实际上不成立：一条 3 秒的闪回盖在 30 秒的过去上，需要 90 张
 * **互不相邻**的过去帧（播放速度是 10×），而它们在图里互不相邻意味着要么全存
 * （1080p 下 720 MB）要么不存。重渲每帧只多一次整帧渲染、显存 O(1)，这是唯一
 * 在长片子上也成立的方案。代价要说清楚：**有闪回的帧，渲染成本大约翻倍**。
 *
 * ## 为什么另起一台 Compositor + AlgoRuntime
 *
 * 1. **不能借外层的**：外层正拿着自己的 ping-pong / placedA 在走路，重入会把
 *    它的中间结果覆盖掉（画面是「闪回里出现另一半画面」那种错）。
 * 2. **有状态模拟必须分开**：共用一个 `AlgoRuntime` 时，回放帧会把 sim 拨到过去，
 *    外层紧接着又要拨回 `t` —— 每帧重放几千步，预览直接卡死。分开之后回放侧
 *    总是**向后**走（闪回是倒放），快照环把它兜在十几步以内。
 * 3. **特效的反馈历史不跟着过来**（见下）。
 *
 * ## 两条刻意的近似（都是「顺序播放的产物，随机回跳时没有定义」）
 *
 * - **反馈类特效**（echo / 数据融毁 …）的历史在这里**每次清空**：正确的历史等于
 *   「从 0 播到 tPast 的全部帧」，按需重算的代价不可能承受。清空换来的是
 *   **确定性**——同一个 t 渲两次逐像素相同，这在导出里比拖尾重要。
 *   代价：回放帧里看不到反馈特效的拖尾。
 * - **斑点追踪**（`u_overlay`）在这里是 `null`：它持有跨帧探针状态，塞给回放帧
 *   会把主渲染的方框搅乱。声明了它的特效在回放帧里退化成「不叠方框」。
 *
 * 视频不一样：它由导出的预热显式解到精确帧（见 `prepare`），所以视频在回放里
 * 是准的 —— 只是贵（每帧一次随机 seek）。
 *
 * ## 递归
 *
 * 回放窗口被 `recallWindowOf` 夹在片段头之前，所以「闪回里套闪回」天然良基。
 * 仍然有 `MAX_RECALL_DEPTH` 兜底：每次嵌套都是一整帧重渲，让它无限展开等于
 * 让一帧渲几十次。超限时那一层缺席（透明）。
 */

import { recallFrameOf, recallTimeOf, recallWindowOf } from '../algos/flashback';
import { getGenerator } from '../algos/registry';
import { AlgoRuntime, type RecallProvider } from '../algos/runtime';
import type { BakeClient } from '../algos/bake-client';
import type { AudioFeatureSource } from '../algos/feature-source';
import type { Project, SourceClip } from '../core/schema';
import { Compositor, type EffectRunner, type SourceResolver, type TransitionRunner } from '../engine/compositor';
import type { GlyphAtlases } from '../engine/glyph-atlas';
import type { CurveTextures } from '../engine/curve-texture';
import type { LutTextures } from '../engine/lut-texture';
import type { Kit, Target } from '../engine/kit';
import type { SourceManager } from '../engine/sources';
import type { SpectrumTextures } from '../engine/spectrum-texture';
import { buildStack, transitionSources, walkOps } from '../engine/stack';
import { modTable } from '../core/modulation';
import type { VideoSourceManager } from '../engine/video-source';

/**
 * 嵌套回放的层数上限。实测一次回放 = 一次整帧渲染，4 层已经是「一帧渲 5 遍」；
 * 再多就不是慢，而是没法用。
 */
const MAX_RECALL_DEPTH = 4;

export interface RecallService {
  /** 交给 `AlgoRuntime.setRecallProvider`。 */
  readonly provider: RecallProvider;
  /**
   * 导出预热：把这一帧要回放的过去帧里的**视频**解到精确帧。
   *
   * 预览允许「缺帧时用最近的一帧顶上」，导出不允许 —— 不预热的话，闪回里的
   * 视频会拿到解码器碰巧缓存着的某一帧，而且每次导出都不一样。
   *
   * 只处理**第一层**回放（嵌套的回放帧不再递归预热）：每加一层就多一批随机
   * seek 的解码，导出会被拖到不可用；深层的视频退化成近似帧。
   */
  prepare(project: Project, t: number, renderW: number): Promise<void>;
  /**
   * 回收回放侧某个片段的模拟状态（关工程时逐个片段调，与 `AlgoRuntime.forget`
   * 同一条纪律：状态纹理装的是状态，只能显式回收，不能靠预算淘汰）。
   *
   * 不接这一步的后果是静默的：**在闪回的过去里出现过的 sim 片段**，每次打开
   * 工程都会在回放运行时里留下一份状态纹理，长会话里只增不减。
   */
  forget(clipId: string): void;
}

export interface RecallArgs {
  kit: Kit;
  /** 当前帧的完整工程（`Renderer.currentProject`）。为 null 时不回放。 */
  getProject: () => Project | null;
  /** 宿主的源管理器：图片 / 视频 / 排版 / solid 都复用它，algo 走本服务自己的运行时。 */
  sources: SourceManager;
  video: VideoSourceManager;
  bake: BakeClient;
  features: AudioFeatureSource | null;
  spectrum: SpectrumTextures | null;
  glyphs: GlyphAtlases | null;
  curves: CurveTextures | null;
  luts: LutTextures | null;
  runEffect: EffectRunner;
  runTransition: TransitionRunner;
}

/**
 * 回放帧里的闪回片段用的时间（秒），`null` = 没有过去 / 端口退化。
 *
 * `params` 由调用方给**求值好的**那一份（与 `setUniforms` 同一条纪律）：
 * 预览走 `AlgoRuntime.evalParams` 的结果，导出预热走片段上存的原值。
 */
function pastTimeOf(
  clip: SourceClip,
  t: number,
  fps: number,
  params: Record<string, number | string>,
): number | null {
  if (clip.source.type !== 'algo') return null;
  const win = recallWindowOf(clip.start, params);
  if (!win) return null;
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  // 量化后可能越过窗口端点半帧，夹回来 —— 越界会读到片段头之后的内容。
  let frame = Math.min(recallFrameOf(recallTimeOf(clip.start, clip.end, win, t), rate), Math.round(win.to * rate));
  /*
   * **回放永远取片段头之前的那一帧**。
   *
   * `gap = 0` 时窗口末端正好是片段头，而倒放的第一帧（进度 0）取的正是窗口
   * 末端 —— 不挪开的话，回放帧里就包含这个闪回片段自己，一路递归到深度上限。
   * 语义上也该是「紧挨着剪切点的那一张」：那才是「之前的画面」的最后一张。
   */
  frame = Math.min(frame, Math.round(clip.start * rate) - 1);
  return frame >= 0 ? frame / rate : null;
}

/**
 * 工程里有没有回放片段（只看启用轨）。导出预热的快路判据 —— 没有它的话，
 * 每个导出帧都要为「可能没有闪回」付一次 `buildStack`。
 */
function hasRecallClip(project: Project): boolean {
  for (const track of project.tracks) {
    if (!track.enabled || track.kind !== 'visual') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'source' || clip.source.type !== 'algo') continue;
      if (getGenerator(clip.source.generator)?.kind === 'recall') return true;
    }
  }
  return false;
}

export function createRecallService(a: RecallArgs): RecallService {
  /*
   * 回放专用的算法运行时。**必须独立**（见文件头第 2 条）：它的 sims 会被拨到
   * 过去，共用会把外层每帧的 seek 变成一次长重放。
   *
   * 烘焙客户端**共用**：那是个按 (def, 参数, seed) 哈希的纹理缓存，
   * 两边拿到的是同一张纹理，没有状态。
   */
  const algos = new AlgoRuntime(a.kit, a.bake);
  algos.setFeatureSource(a.features);

  const resolve: SourceResolver = (clip, t, frame) => {
    // 非 algo 的源（图片 / 视频 / 排版 / solid）走宿主那一份 —— 它们都不带
    // 「当前帧」之外的状态，复用是安全的。
    if (clip.source.type !== 'algo') return a.sources.resolve(clip, t, frame);
    const p = a.getProject();
    if (!p) return null;
    return algos.resolve(
      clip,
      t,
      frame,
      p.beatGrid,
      p.seed,
      p.fps,
      a.kit.w,
      a.kit.h,
      modTable(p.modulators),
    );
  };

  const comp = new Compositor(a.kit, resolve, a.runEffect, a.runTransition);
  comp.spectrum = a.spectrum;
  comp.glyphs = a.glyphs;
  comp.curves = a.curves;
  comp.luts = a.luts;
  // 蒙版素材：回放帧里也可能有吃蒙版的特效，解析器与主链同一份。
  comp.maskAsset = (assetId) => a.sources.resolveAssetImage(assetId);
  // `comp.tracker` 刻意留在 null：它持有每实例的跨帧状态（见文件头）。

  /** 回放帧的落点。一次只服务一张：`resolve` 的消费方（placement）是同步的。 */
  let dst: Target | null = null;
  let depth = 0;

  const provider: RecallProvider = (clip, t, params) => {
    if (depth >= MAX_RECALL_DEPTH) return null;
    const project = a.getProject();
    if (!project) return null;

    const tPast = pastTimeOf(clip, t, project.fps, params);
    if (tPast === null) return null;

    const w = a.kit.w;
    const h = a.kit.h;
    if (!dst) dst = a.kit.target(w, h);
    else dst.resize(w, h);

    depth += 1;
    try {
      /*
       * 每次重渲前清掉反馈历史：回放是随机顺序的，留着上一张回放帧的拖尾
       * 会让「同一个 t 渲两次」不相等 —— 那是导出不允许的（见文件头）。
       */
      comp.clearFeedback();
      comp.render(project, tPast, undefined, dst);
      return { tex: dst.tex, w, h };
    } finally {
      depth -= 1;
    }
  };

  return {
    provider,
    forget(clipId) {
      algos.forget(clipId);
    },
    async prepare(project, t, renderW) {
      // 快路：工程里根本没有回放片段时不做任何分配（导出每帧都会来一次）。
      if (!hasRecallClip(project)) return;
      const jobs: Promise<void>[] = [];
      const seen = new Set<string>();
      walkOps(buildStack(project, t), (op) => {
        const clips =
          op.type === 'source'
            ? [op.source.clip]
            : op.type === 'transition'
              ? transitionSources(op).map((side) => side.clip)
              : [];
        for (const clip of clips) {
          if (clip.source.type !== 'algo' || seen.has(clip.id)) continue;
          if (getGenerator(clip.source.generator)?.kind !== 'recall') continue;
          seen.add(clip.id);
          const tPast = pastTimeOf(clip, t, project.fps, clip.source.params);
          if (tPast === null) continue;
          jobs.push(a.video.prepareProject(project, tPast, renderW));
        }
      });
      await Promise.all(jobs);
    },
  };
}
