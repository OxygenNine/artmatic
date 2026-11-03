/**
 * renderer.ts — 对外门面。
 *
 * renderFrame(project, t) 是预览与导出共用的唯一渲染入口（硬约束 1.1：
 * 两者走同一条求值路径，差别只在分辨率——分辨率是 renderer 的状态，
 * 不是参数分支）。导出前 setExportSize，导完 clearExportSize。
 */

import {
  Compositor,
  type EffectRunner,
  type SourceResolver,
  type SourceTexture,
  type TransitionRunner,
} from './compositor';
import { Kit } from './kit';
import type { BuildStackOptions } from './stack';
import type { SpectrumTextures } from './spectrum-texture';
import type { BoxTracker } from './box-tracker';
import type { GlyphAtlases } from './glyph-atlas';
import type { CurveTextures } from './curve-texture';
import type { LutTextures } from './lut-texture';
import type { ScopeFrame } from './compositor';
import { fitPreviewSize, measureDisplaySize } from './preview-size';
import type { Project } from '../core/schema';

export class Renderer {
  readonly kit: Kit;
  private readonly compositor: Compositor;
  private exportSize: { w: number; h: number } | null = null;
  private displayEl: Element | null = null;

  constructor(canvas: HTMLCanvasElement, resolve: SourceResolver, runEffect: EffectRunner) {
    this.kit = new Kit(canvas);
    this.compositor = new Compositor(this.kit, resolve, runEffect);
  }

  setResolver(resolve: SourceResolver): void {
    this.compositor.resolve = resolve;
  }

  setEffectRunner(runEffect: EffectRunner): void {
    this.compositor.runEffect = runEffect;
  }

  /** 转场执行器（`effects/transitions/runner.ts`）。未装配时 compositor 用降级实现。 */
  setTransitionRunner(runTransition: TransitionRunner): void {
    this.compositor.runTransition = runTransition;
  }

  /**
   * 频谱纹理（`u_spectrum`）。由 `render-core` 装配：
   * 主应用供工程音频的频谱，lab 供合成频谱，都没有时照样建 ——
   * 声明了 `u_spectrum` 的特效会读到一张零纹理（静音）而不是未绑定的 sampler。
   */
  setSpectrumTextures(spectrum: SpectrumTextures): void {
    this.compositor.spectrum = spectrum;
  }

  /**
   * 斑点追踪服务（`u_overlay` / `u_box*`）。同样由 `render-core` 装配；
   * 它持有**跨帧状态**，所以 `onSeek()` 时由装配层的 seekExtra 回调
   * `reset()`（本类不认识它，与 algos 的 `alignSims` 同一条路）。
   */
  setTracker(tracker: BoxTracker | null): void {
    this.compositor.tracker = tracker;
  }

  /**
   * 字形图集（`u_atlas`）。由 `render-core` 装配；它只按 (字符序列, 字体)
   * 缓存纹理，**不含跨帧状态**，所以 `onSeek()` 不需要清它。
   */
  setGlyphAtlases(glyphs: GlyphAtlases | null): void {
    this.compositor.glyphs = glyphs;
  }

  /**
   * 调色曲线表（`u_curve`）。由 `render-core` 装配；按表内容缓存，**不含跨帧
   * 状态**，所以 `onSeek()` 不需要清它。
   */
  setCurveTextures(curves: CurveTextures | null): void {
    this.compositor.curves = curves;
  }

  /** `.cube` 查找表（`u_lut`）。按素材 id 缓存，`onSeek()` 不需要清。 */
  setLutTextures(luts: LutTextures | null): void {
    this.compositor.luts = luts;
  }

  /**
   * 蒙版素材解析器（`MaskRef.kind === 'asset'`）。由 `render-core` 装配 ——
   * 「谁管素材登记」不是 engine 的知识。不装时素材类蒙版引用求值成「没有蒙版」。
   */
  setMaskAssetResolver(fn: ((assetId: string) => SourceTexture | null) | null): void {
    this.compositor.maskAsset = fn;
  }

  /**
   * 示波器探针开关。调色面板挂载时打开、卸载时关掉 —— `readPixels` 是同步
   * stall，不看着的时候一帧都不该花。
   */
  setScopeProbe(on: boolean): void {
    this.compositor.setScopeProbe(on);
  }

  /** 最近一帧探针数据（面板按自己的节奏取）。 */
  scopeFrame(): ScopeFrame | null {
    return this.compositor.scopeFrame();
  }

  /** 显式回收某个特效实例的追踪状态（片段随工程关闭/删除时用）。 */
  dropTrackerInstance(instanceId: string): void {
    this.compositor.tracker?.drop(instanceId);
  }

  /**
   * 斑点追踪的读数（E2E / 诊断）。与 `poolStats()` 同一理由：这一层的失败
   * 形态是「方框不出现」，没有读数就只能靠猜。
   */
  trackerStats(): ReturnType<BoxTracker['stats']> | null {
    return this.compositor.tracker?.stats() ?? null;
  }

  /** 预览画布显示区域的容器元素（量设备像素尺寸用）。 */
  attachDisplay(el: Element): void {
    this.displayEl = el;
  }

  /** 预览尺寸跟随显示区域（适配输出宽高比，永不放大过输出尺寸）。 */
  syncSize(resolution: { w: number; h: number }): void {
    if (this.exportSize) {
      this.kit.size(this.exportSize.w, this.exportSize.h);
      return;
    }
    const display = this.displayEl
      ? measureDisplaySize(this.displayEl)
      : { width: 0, height: 0 };
    const fit = fitPreviewSize(resolution.w, resolution.h, display.width, display.height, {
      allowUpscale: this.allowUpscale,
    });
    if (!fit) return;

    /*
     * 预览降质：**只缩后备缓冲，不缩显示尺寸**。
     *
     * 这是用户报的那个「选 25% 画面也跟着变小」的根因：canvas 元素不设 CSS
     * 尺寸时，它的显示尺寸就等于 `width`/`height` 属性（= 后备缓冲的像素数），
     * 所以把缓冲缩到 1/4，画面就真的变成 1/4 大。
     *
     * 正确语义是「**同样的显示面积，用更少的像素去画**」—— 于是这里显式把
     * CSS 盒钉在**未缩放**的适配尺寸上（除以 dpr 换成 CSS px），缓冲照旧缩小。
     * 结果就是用户要的「放大到 100%、有点糊」。
     *
     * 降质不能走 `setExportSize`：那会让上面那行直接 return，窗口缩放、
     * 切工程、改分辨率全都不会再重新适配。
     */
    const s = this.previewScale;
    this.kit.size(
      Math.max(2, Math.round(fit.width * s)),
      Math.max(2, Math.round(fit.height * s)),
    );
    this.applyCanvasCssSize(fit.width, fit.height);
  }

  /**
   * 把 canvas 的 **CSS 盒**固定成适配尺寸（入参是设备像素）。
   *
   * 不这样做的话 CSS 尺寸会跟着后备缓冲走 —— 那正是降质时画面变小的原因。
   * `max-width/height: 100%` 仍然在外层兜着，避免浮点误差顶破容器。
   */
  private applyCanvasCssSize(deviceW: number, deviceH: number): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = `${Math.max(1, Math.round(deviceW / dpr))}px`;
    const cssH = `${Math.max(1, Math.round(deviceH / dpr))}px`;
    const el = this.kit.canvas;
    if (el.style.width !== cssW) el.style.width = cssW;
    if (el.style.height !== cssH) el.style.height = cssH;
  }

  /**
   * 预览质量的缩放系数（1 = 全质）。**只影响预览**：导出走 `setExportSize`，
   * 那条路完全不过这里。默认 1，装配时不需要显式调用。
   */
  private previewScale = 1;

  setPreviewScale(scale: number): void {
    const v = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
    if (v === this.previewScale) return;
    this.previewScale = v;
  }

  getPreviewScale(): number {
    return this.previewScale;
  }

  /**
   * 全屏预览的放大开关。默认 false（`fitPreviewSize` 只缩不放）。
   *
   * 只被全屏路径打开、退出时关回：屏幕比输出分辨率大时，不放大就是拿
   * 输出分辨率的像素去填满屏幕（糊）。上限在 `preview-size.ts` 的
   * `UPSCALE_CAP`（2×）—— 显存是导出的预算，不是预览的。
   *
   * ⚠️ 与 `setExportSize` 是两条路：那个会让 `syncSize` 永久短路
   * （窗口缩放、切工程、改分辨率全都不再适配），这个不会。
   */
  private allowUpscale = false;

  setAllowUpscale(on: boolean): void {
    if (this.allowUpscale === on) return;
    this.allowUpscale = on;
  }

  setExportSize(w: number, h: number): void {
    this.exportSize = { w, h };
    this.kit.size(w, h);
  }

  clearExportSize(): void {
    this.exportSize = null;
  }

  /**
   * 渲染一帧到画布。
   *
   * 默认只传 project 与 t；`opts`（可选）目前只用来「只渲染某条视觉轨」
   * （见 `BuildStackOptions`）。**必须是可选参数**：它是预览与导出共用的唯一
   * 渲染入口，加必选参数会改变既有调用行为。
   */
  renderFrame(project: Project, t: number, opts?: BuildStackOptions): void {
    this.currentProject = project;
    if (!this.exportSize) this.syncSize(project.resolution);
    this.compositor.render(project, t, opts);
  }

  /**
   * 最近一次 `renderFrame` 收到的工程 —— 闪回（`recall` 型生成器）重渲「过去的
   * 整帧」时要用的就是它。
   *
   * 为什么从这儿取而不是注入一个 `getProject()`：容器给的那个只保证拍网格 /
   * 种子 / 帧率（`render-core.ts` 的 `RenderCoreProject`），重渲却要整棵树
   * （轨道、素材、分辨率）。而 `renderFrame` 本来就每帧收到完整工程，它就是
   * 「眼下这一帧用的是哪份工程」的**唯一权威**——离屏缩略图那几台也自动正确。
   */
  currentProject: Project | null = null;

  /**
   * 注入「跳帧后必须跟着重新定位」的钩子。目前只有算法运行时
   * （`AlgoRuntime.alignSims`，有状态模拟的记账对齐）。
   *
   * 为什么做成钩子而不是让调用方自己记得调：`onSeek()` 有五类调用点
   * （跳播放头 / 切排版页 / 刷新预览 / 导出起止 / 缩略图），让每一处都各自
   * 记得调一次 `alignSims()` 是漏一处就坏一处的维护方式，而症状
   * （「某个入口进来之后同一 t 连渲两次画面不同」）不会报错、极难归因。
   *
   * Renderer 自己不认识 algos（层次是 `engine ← algos`），所以由装配层
   * `render/render-core.ts` 注入 —— 与 `setResolver` / `setEffectRunner` 同一条路。
   */
  setSeekExtra(fn: (() => void) | null): void {
    this.seekExtraFn = fn;
  }

  /** seek / 跳帧后调用：清掉所有反馈历史，并让有状态模拟重新定位。 */
  onSeek(): void {
    this.compositor.clearFeedback();
    this.seekExtraFn?.();
  }

  /**
   * 特效池的容量读数（预算、占用、在帧条目数、是否超支）。
   *
   * 暴露出来是因为这一层的失败模式是**静默**的（显存耗尽 → 上下文丢失）：
   * 没有读数就只能靠猜。E2E 与诊断用它。
   */
  poolStats(): ReturnType<Compositor['poolStats']> {
    return this.compositor.poolStats();
  }

  /**
   * 调色精度的读数：这一帧的中间缓冲是不是 16F、不是的话为什么。
   *
   * 与 `poolStats()` 同一类东西（静默降级 + 没有读数就只能靠猜），但它多一个
   * 消费者：调色面板的提示条。降级的三种原因都要能单独说出口，
   * 「本机没有浮点渲染目标」与「预算不够」对用户是两件不同的事。
   */
  gradeStats(): ReturnType<Compositor['gradeStats']> {
    return this.compositor.gradeStats();
  }

  /**
   * 「前 / 后对比」：让某个特效片段整条链不参与渲染（不改工程数据）。
   *
   * 调色面板的 A/B 用它。见 `Compositor.bypassEffectClip` 的注释为什么
   * 不去改 `inst.enabled`。
   */
  setBypassEffect(clipId: string | null): void {
    this.compositor.bypassEffectClip = clipId;
  }

  /* ---------------------------------------------------------- 导出预热
   *
   * 排版层的位图来自异步光栅化（与 algo 烘焙同构）。预览允许「这一帧缺席」，
   * 但导出不允许 —— 导出是顺序紧循环，缺席就是那一帧真的没有文字。
   * 所以循环里每帧渲染前要 await 一次 prepareFrame。
   *
   * 这不违反硬约束 1.1：1.1 禁止的是「用 rAF 驱动导出」，这里的 await
   * 与已有的 `await sink.submit` 同类（渲染前准备 + 协作式背压），
   * 没有引入第二个时钟。见 ADR-009。
   */

  private prewarmFrameFn: ((p: Project, t: number) => Promise<void>) | null = null;
  private prewarmFontsFn: ((p: Project) => Promise<void>) | null = null;
  private exportEnterFn: (() => void) | null = null;
  private exportExitFn: (() => void) | null = null;
  /** `onSeek()` 的附加动作。见 `setSeekExtra`。 */
  private seekExtraFn: (() => void) | null = null;

  setPrewarm(fn: ((p: Project, t: number) => Promise<void>) | null): void {
    this.prewarmFrameFn = fn;
  }

  setFontPrewarm(fn: ((p: Project) => Promise<void>) | null): void {
    this.prewarmFontsFn = fn;
  }

  setExportLifecycle(enter: (() => void) | null, exit: (() => void) | null): void {
    this.exportEnterFn = enter;
    this.exportExitFn = exit;
  }

  /** 本帧的文字层预热到当前渲染尺寸。没装排版运行时就是 no-op。 */
  async prepareFrame(project: Project, t: number): Promise<void> {
    await this.prewarmFrameFn?.(project, t);
  }

  /** ADR-003 规则 ③：等字体就绪。必须在导出循环之前调用。 */
  async prewarmFonts(project: Project): Promise<void> {
    await this.prewarmFontsFn?.(project);
  }

  enterExportMode(): void {
    this.exportEnterFn?.();
  }

  exitExportMode(): void {
    this.exportExitFn?.();
  }

  /** 测试钩子：读默认帧缓冲像素。 */
  readPixels(): { data: Uint8Array; w: number; h: number } {
    const gl = this.kit.gl;
    const w = this.kit.w;
    const h = this.kit.h;
    const data = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, w, h };
  }
}
