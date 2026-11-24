/**
 * bake-surface.ts — 预览缓存的**离屏烘焙面**：一帧渲进 FBO，回读成 RGBA。
 *
 * ## 为什么要单独一面
 *
 * 预览缓存要把工程按预览尺寸顺序烘成一段 MP4。早期实现直接复用主渲染器
 * （`runExport` + 可见画布），于是烘焙期间**整块预览界面被征用**：画面冻在
 * 最后一帧、播放头一动就得取消、`tick` 里还要 `return` 掉整条预览路径。
 *
 * 这一面把输出搬到了离屏目标上：主画布一个像素都不会被动，预览照常按 rAF 画。
 *
 * ## 为什么是「第二台 Compositor + 第二台 AlgoRuntime」
 *
 * 与 `recall.ts` 同一条理由（那边的文件头写得更细）：
 *
 * 1. **不能借外层那台的 ping-pong / placedA**：两层交替走会把中间结果覆盖掉。
 * 2. **有状态模拟必须分开**：共用一个 `AlgoRuntime` 时，烘焙把 sim 拨到 t=k，
 *    下一帧预览又把它拨回播放头 —— 两边都在 seek，画面与产物同时错。
 *
 * 共用的是**不变量**：`SourceManager`（图片 / 视频 / 排版 / solid 的纹理）、
 * 烘焙客户端（按 hash 缓存的生成器纹理）、频谱 / 字形 / 曲线 / LUT、特效与转场
 * 执行器（它们本身无状态）。所以这一面既不会重复解码，也不会重复烘焙。
 *
 * ## 回读成本（实测 1234×694 @ RTX 4070 / Chrome 157）
 *
 * `renderFrame` 0.16 ms、`readPixels` 1.5 ms、`VideoSample` 0.14 ms —— 一帧
 * ≈2 ms 主线程。这个数字是 `PREVIEW_BAKE_MAX_FPS` 那条让速策略的依据。
 */

import { Compositor, type EffectRunner, type SourceResolver, type TransitionRunner } from '../engine/compositor';
import type { Kit, Target } from '../engine/kit';
import type { SourceManager } from '../engine/sources';
import type { SpectrumTextures } from '../engine/spectrum-texture';
import type { GlyphAtlases } from '../engine/glyph-atlas';
import type { CurveTextures } from '../engine/curve-texture';
import type { LutTextures } from '../engine/lut-texture';
import type { BakeClient } from '../algos/bake-client';
import { AlgoRuntime, type RecallProvider } from '../algos/runtime';
import type { AudioFeatureSource } from '../algos/feature-source';
import { modTable } from '../core/modulation';
import type { Project } from '../core/schema';

export interface BakeSurfaceArgs {
  kit: Kit;
  /** 点访问：烘焙用的工程快照由调用方给（缓存本身就是按工程内容建键的）。 */
  getProject: () => Project | null;
  sources: SourceManager;
  bake: BakeClient;
  features: AudioFeatureSource | null;
  spectrum: SpectrumTextures | null;
  glyphs: GlyphAtlases | null;
  curves: CurveTextures | null;
  luts: LutTextures | null;
  runEffect: EffectRunner;
  runTransition: TransitionRunner;
  /** 闪回出口（`createRecallService(...).provider`）。不传 = 烘焙帧里没有闪回。 */
  recall: RecallProvider | null;
  /** three 解析器，**烘焙面自己那一份**（理由同 `RecallArgs.three`）。 */
  three: SourceResolver | null;
}

/** 一帧回读结果。`data` 是 **RGBA、自上而下**的行序（可直接构造 `VideoFrame`）。 */
export interface BakedFrame {
  data: Uint8Array;
  w: number;
  h: number;
}

export interface BakeSurface {
  /**
   * 渲一帧并回读。尺寸恒为**当前** `kit.w × kit.h`（预览缓冲已取偶，见 `core/dims.ts`）。
   *
   * 同步：GL 命令 + 一次 `readPixels` 都在这里完成，调用方据此按实测耗时让路。
   */
  renderFrame(project: Project, t: number): BakedFrame;
  /**
   * 一段顺序烘焙开始：清掉反馈历史。
   *
   * 与导出的 `renderer.onSeek()` 同义 —— 烘焙是从 `from` 一拍一拍往上走的，
   * 若不从干净历史起步，这一段的第一帧会带着上一段（甚至预览）的拖尾。
   * **有状态模拟不在这里对齐**：那台运行时是独立的，`from` 之前没有历史。
   */
  begin(): void;
  /** 放掉目标与回读缓冲（烘焙停止时调；模拟状态按 `recall` 的先例常驻）。 */
  release(): void;
  /**
   * 回收某个片段的模拟状态纹理（关工程 / 删片段时调）。
   *
   * 与 `recall.forget` 同一条纪律：状态纹理装的是状态，**只能显式回收**，
   * 不接这一步的表现是「烘焙过的 sim 片段在长会话里只增不减」。
   */
  forget(clipId: string): void;
}

export function createBakeSurface(a: BakeSurfaceArgs): BakeSurface {
  /*
   * 独立的算法运行时（见文件头第 2 条）。烘焙客户端共用：那是按
   * (def, 参数, seed) 哈希的纹理缓存，两边拿到同一张纹理，没有状态。
   */
  const algos = new AlgoRuntime(a.kit, a.bake);
  algos.setFeatureSource(a.features);
  algos.setAssetResolver((assetId) => a.sources.resolveAssetImage(assetId));
  algos.setAssetPixelsResolver((assetId) => a.sources.resolveAssetPixels(assetId));
  // 闪回（`recall`）：烘焙帧里也可能有闪回片段。那台服务自己就是独立的，
  // 与预览互不干扰；漏装的表现是「缓存里那几帧闪回是黑的」。
  algos.setRecallProvider(a.recall);

  const resolve: SourceResolver = (clip, t, frame) => {
    /*
     * three 带着「上一次渲的是哪一帧」这个状态，而烘焙走的是另一时刻 ——
     * 与主链共用一份的形态是「缓存里那几帧混进播放头的内容」。所以它排在
     * 下面那条「非 algo 都复用」之前。
     */
    if (clip.source.type === 'three') return a.three?.(clip, t, frame) ?? null;
    /*
     * 非 algo 的源（图片 / 视频 / 排版 / solid）走宿主那一份 —— 它们都不带
     * 「当前帧」之外的状态，复用是安全的，也省掉一份解码与光栅化。
     */
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
  comp.maskAsset = (assetId) => a.sources.resolveAssetImage(assetId);
  // `comp.tracker` 刻意留在 null：斑点叠层是预览的辅助层（每实例跨帧状态），
  // 与 `recall.ts` 同一条取舍 —— 缓存里不该出现一条抖动的追踪框。

  let dst: Target | null = null;
  let buf = new Uint8Array(0);

  return {
    renderFrame(project: Project, t: number): BakedFrame {
      const w = a.kit.w;
      const h = a.kit.h;
      if (!dst) dst = a.kit.target(w, h);
      else dst.resize(w, h);
      /*
       * `flipY`：回读是自下而上的行序，在呈现时翻一次，
       * 出来的 buffer 就是自上而下、可直接当视频帧的那一份。
       */
      comp.render(project, t, undefined, dst, true);
      const bytes = w * h * 4;
      if (buf.length !== bytes) buf = new Uint8Array(bytes);
      const gl = a.kit.gl;
      dst.bind();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // 绑回默认帧缓冲：后面谁先渲都是它自己的事，但别把状态漏给别人。
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { data: buf, w, h };
    },
    begin(): void {
      comp.clearFeedback();
      algos.alignSims();
    },
    release(): void {
      dst?.dispose();
      dst = null;
      buf = new Uint8Array(0);
    },
    forget(clipId: string): void {
      algos.forget(clipId);
    },
  };
}
