/**
 * render-core.ts — 合成根（composition root）：把「源解析 + 算法运行时 + 特效执行器
 * + 回放服务」装到一台 Renderer 上。
 *
 * 为什么单独一层：本模块 import `engine` + `algos` + `effects`，而
 * `algos/`、`effects/` 本就位于 `engine/` **之上**（见 effects/runner.ts、
 * algos/runtime.ts 的 import）。若把它塞进 `engine/`，就会形成
 * `engine → algos/effects → engine` 的层次倒挂。
 *
 *   core ← engine ← {effects, algos} ← render ← {ui, lab}
 *
 * 被两个宿主共用：
 *   - 主应用 `ui/app-state.svelte.ts::attachPreview`
 *   - 试炼场 `lab/lab-state.svelte.ts`
 * 所以这里的装配必须是**唯一真源**——两边各写一份的 bug 形态是
 * 「lab 里好好的，主应用里某类源不工作」，而且不会有任何报错。
 *
 * 刻意**不** import `typography/` `audio/` `exporters/`：
 * 那些是主应用专属，拉进来会把整棵排版/音频子树拖进 lab 的 bundle 图。
 * 主应用在自己的 attachPreview 里对返回的 renderer/sources 继续装它们。
 */

import { Renderer } from '../engine/renderer';
import { SourceManager } from '../engine/sources';
import { SpectrumTextures, type SpectrumSource } from '../engine/spectrum-texture';
import { BoxTracker } from '../engine/box-tracker';
import { GlyphAtlases } from '../engine/glyph-atlas';
import { CurveTextures } from '../engine/curve-texture';
import { LutTextures } from '../engine/lut-texture';
import { createVideoSourceManager, type VideoSourceManager } from '../engine/video-source';
import { BakeClient } from '../algos/bake-client';
import { AlgoRuntime } from '../algos/runtime';
import { createEffectRunner } from '../effects/runner';
import { createTransitionRunner } from '../effects/transitions/runner';
import { createRecallService, type RecallService } from './recall';
import type { AudioFeatureSource } from '../algos/feature-source';
import type { Kit } from '../engine/kit';
import type { Project } from '../core/schema';

/**
 * 装配只需要工程里的这几项：拍网格（曲线上下文）、种子（确定性随机）、
 * 帧率（`u_delta` = 1/fps）。
 */
export type RenderCoreProject = Pick<Project, 'beatGrid' | 'seed' | 'fps'>;

export interface RenderCoreOpts {
  /**
   * **点访问**，不是传值。两个理由：
   *   - 主应用：`store.project` 会随切换工程而变，装配时取一次就冻住了；
   *   - lab：project 每帧重新合成，根本没有一个稳定的对象可以提前给。
   */
  getProject: () => RenderCoreProject;
  /**
   * 异步就绪回调（algo 烘焙 / 视频取帧）。主应用 → `store.touch()`；
   * lab → 请求重绘一帧。
   */
  onAlgoReady: () => void;
  /**
   * 频谱来源（`u_spectrum`）。**数据以接口注入**，所以这个文件依然不 import
   * `audio/` —— 「谁供数」是宿主的事：主应用给工程音频的频谱，lab 给合成频谱。
   * 不传也能跑：声明了 `u_spectrum` 的特效会读到一张零纹理（静音）。
   */
  spectrum?: SpectrumSource | null;
  /**
   * 音频**特征**来源（rms / 分频 / onset 年龄 / 累积行程），供场景生成器读。
   * 与 `spectrum` 同样以接口注入（本文件依然不 import `audio/`）。
   * 不传也能跑：声明了这些 uniform 的场景会读到静音特征（画面偏暗、不脉动）。
   */
  features?: AudioFeatureSource | null;
  /**
   * 「这个 assetId 引用的媒体是不是**不存在**」的判据（「脱机媒体」占位符）。
   *
   * 与「素材还没加载好」必须分开：后者是每帧都在发生的正常状态（异步解码），
   * 给它画占位符会让正常加载满屏闪暗红。判据需要知道「仓里有没有这个素材」，
   * 那是宿主的知识（`engine` 不认识 `project/asset-store`），所以注入。
   * 不传 = 不画占位符（lab 的素材全是程序化生成，没有这个概念）。
   */
  isAssetOffline?: ((assetId: string) => boolean) | null;
}

export interface RenderCore {
  renderer: Renderer;
  sources: SourceManager;
  /** 视频取帧器。导出前要逐帧 `prepare()`，关闭工程时 `dispose()`。 */
  video: VideoSourceManager;
  kit: Kit;
  /** 频谱纹理池。宿主换音频来源时调 `setSource`。 */
  spectrumTextures: SpectrumTextures;
  /**
   * 斑点追踪服务（`u_overlay`）。宿主**必须**在关工程时 `clear()` ——
   * 它持有每实例的探针目标与叠层纹理（见 `src/core/AGENTS.md` 的生命周期一条）。
   */
  tracker: BoxTracker;
  /**
   * 字形图集（`u_atlas`）。按 (字符序列, 字体) 缓存纹理，宿主不需要管它；
   * 暴露出来只为了诊断与 `clear()`。
   */
  glyphs: GlyphAtlases;
  /** 调色曲线表（`u_curve`）。与 `glyphs` 同一形态：谁装核心，谁就有。 */
  curves: CurveTextures;
  /**
   * `.cube` 查找表（`u_lut`）。
   *
   * 这里**故意不给它读取器**：`render-core` 不许 import `project/`（那会把
   * 台账 / 文件系统拖进 lab 的 bundle）。宿主（`app-state`）装配完再
   * `luts.setLoader(...)`；没设之前所有 LUT 都退化成「没载入」，画面原样。
   */
  luts: LutTextures;
  /** 算法运行时。暴露出来是为了宿主能换特征来源（`setFeatureSource`）。 */
  algos: AlgoRuntime;
  /**
   * 回放服务（闪回 / `recall` 型生成器）。宿主只在导出预热里用到 ——
   * `prepare()` 要把回放帧里的视频解到精确帧（见 `recall.ts`）。
   */
  recall: RecallService;
}

export function createRenderCore(
  canvas: HTMLCanvasElement,
  opts: RenderCoreOpts,
): RenderCore {
  // resolve / runEffect 先给空实现：Renderer 的构造要求它们在场，
  // 真正的实现在下面几行装配完才有（renderFrame 之前必须装完）。
  const renderer = new Renderer(canvas, () => null, () => {});
  const sources = new SourceManager(renderer.kit);
  sources.setAssetOfflineProbe(opts.isAssetOffline ?? null);
  const bake = new BakeClient(renderer.kit, opts.onAlgoReady);
  const algos = new AlgoRuntime(renderer.kit, bake);
  // 音频特征：与频谱同一条注入路径（见 RenderCoreOpts 的两条注释）。
  algos.setFeatureSource(opts.features ?? null);

  sources.setAlgoResolver((clip, t, frame) => {
    const p = opts.getProject();
    // 渲染尺寸是 renderer 的状态（预览 ≈960、导出 1920），不是片段的属性。
    return algos.resolve(clip, t, frame, p.beatGrid, p.seed, p.fps, renderer.kit.w, renderer.kit.h);
  });

  /*
   * 视频：上传宽度取当前渲染宽度（预览 ≈960 时内存小一个量级，导出 1920
   * 时自动拿到全分辨率）。`kit.w` 是**取帧那一刻**的尺寸，不是装配时的。
   */
  const video = createVideoSourceManager(
    renderer.kit,
    (src, w, h) => sources.uploadImage(src, w, h),
    {
      onFrameReady: opts.onAlgoReady,
      // 速度曲线可以锚到拍：取帧要把网格带下去（见 core/speed.ts）。
      getGrid: () => opts.getProject().beatGrid,
    },
  );
  sources.setVideoResolver((clip, t) => video.frameFor(clip, t, renderer.kit.w));

  renderer.setResolver(sources.resolve);
  // 执行器本身无状态（历史都在 Compositor 的池子里），所以回放那台也复用它们。
  const runEffect = createEffectRunner(renderer.kit, () => opts.getProject().seed);
  const runTransition = createTransitionRunner(renderer.kit);
  renderer.setEffectRunner(runEffect);
  renderer.setTransitionRunner(runTransition);
  /*
   * 跳帧后让有状态模拟重新对齐（见 AlgoRuntime.alignSims），并清掉追踪状态。
   * 必须走 `Renderer.onSeek()` 这条唯一的路 —— 主应用与 lab 的每一个 seek
   * 入口都会经过它，各自记得调一次是不可能的维护方式。
   */
  const tracker = new BoxTracker(renderer.kit, () => opts.getProject().seed);
  renderer.setTracker(tracker);
  renderer.setSeekExtra(() => {
    algos.alignSims();
    tracker.reset();
  });

  const spectrumTextures = new SpectrumTextures(renderer.kit);
  spectrumTextures.setSource(opts.spectrum ?? null);
  renderer.setSpectrumTextures(spectrumTextures);

  /*
   * 字形图集（`u_atlas`）：无条件建。它是纯 CPU 数据 + 一张纹理，没有跨帧
   * 状态，所以不需要注入口，也不需要 `onSeek` 清理 —— 与频谱「谁供数」不同。
   */
  const glyphs = new GlyphAtlases(renderer.kit);
  renderer.setGlyphAtlases(glyphs);
  const curves = new CurveTextures(renderer.kit);
  renderer.setCurveTextures(curves);
  const luts = new LutTextures(renderer.kit, () => null);
  renderer.setLutTextures(luts);
  /*
   * 蒙版素材（`MaskRef.kind === 'asset'`）：素材是普通 image，解析走素材管理器。
   * 与 `u_spectrum` 同一条「谁供数」的注入路径 —— `engine/` 不认识素材台账。
   */
  renderer.setMaskAssetResolver((assetId) => sources.resolveAssetImage(assetId));

  /*
   * 回放（闪回）：`recall` 型生成器向它索取「时间轴上过去的整帧」。
   *
   * 装配在最后一步是必须的 —— 它要复用上面那一批（源管理器、视频、烘焙、
   * 频谱、字形），自己再起一台独立的 Compositor + AlgoRuntime（理由见
   * `recall.ts` 文件头）。工程从 `Renderer.currentProject` 取：那是「这一帧
   * 用的是哪份工程」的唯一权威。
   */
  const recall = createRecallService({
    kit: renderer.kit,
    getProject: () => renderer.currentProject,
    sources,
    video,
    bake,
    features: opts.features ?? null,
    spectrum: spectrumTextures,
    glyphs,
    curves,
    luts,
    runEffect,
    runTransition,
  });
  algos.setRecallProvider(recall.provider);

  return { renderer, sources, video, kit: renderer.kit, spectrumTextures, tracker, glyphs, curves, luts, algos, recall };
}
