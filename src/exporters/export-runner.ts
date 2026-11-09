/**
 * export-runner.ts — 逐帧导出驱动。
 *
 * 硬约束 1.1：禁止 requestAnimationFrame 驱动导出。导出是
 * `for (let i = 0; i < totalFrames; i++)`，只受编码器背压约束
 * （每帧 await sink.submit）。每 10 帧 setTimeout(0) 让 UI 喘口气
 * （进度条重绘、取消按钮可点）——这不是时钟，只是协作式让渡。
 *
 * 渲染与预览同一条求值路径：renderFrame(project, t)，差别只在
 * renderer 的分辨率状态。
 *
 * `await renderer.prepareFrame(project, t)` 是本文件里唯一一处「新增的等待」，
 * 它来自排版层：文字位图是异步光栅化的，而导出没有「这一帧缺席」的余地。
 * 它与 `await sink.submit` 同类（渲染前准备 + 协作式背压），不是第二个时钟。
 * 见 AGENTS 的 ADR-009。
 */

import { timeOf } from '../engine/clock';
import type { Renderer } from '../engine/renderer';
import type { Project } from '../core/schema';
import type { FrameSink } from './frame-sink';

export class ExportCancelled extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'ExportCancelled';
  }
}

export interface ExportOptions {
  sink: FrameSink;
  codec?: string;
  /**
   * 输出尺寸覆盖，默认 `project.resolution`。
   *
   * 给「自带尺寸约定」的格式用（GIF 常导 480px 宽）。**渲染分辨率就是它** ——
   * 这里不做事后重采样：一来渲染到目标尺寸比缩一次更准（缩放是又一次采样），
   * 二来像素少一个量级，后面量化与 LZW 的成本跟着低。
   * 硬约束 1.1 的「预览与导出差别只在分辨率」依旧成立。
   */
  size?: { w: number; h: number };
  /**
   * 帧步进，默认 1。`n > 1` 时只渲 `t = timeOf(0) / timeOf(n) / timeOf(2n) …`。
   *
   * 只给**自身帧率低于工程帧率**的格式用（GIF：12.5fps 的产物没必要按 60fps 渲 4 倍）。
   * 每个被渲的帧仍然用**绝对帧号**求值，所以「seek(f) ≡ 顺序 step f 次」那套
   * （AGENTS §1.3）不受影响 —— 受影响的是**反馈类特效的帧历史**（`u_feedback` 的
   * ping-pong），它的步长会跟着变大。与预览的降帧率档位是同一件事，代价已知。
   */
  frameStep?: number;
  /**
   * 只渲工程时间轴上的一段，**单位是帧号**（左闭右开）。省略 = 整段。
   *
   * 用帧号而不是秒：秒 → 帧号的换算只该有一处（`gif-plan.ts`），否则
   * 「面板说 6 帧、实际渲出 7 帧」这类错位迟早出现。这里只负责再夹一次
   * （`runExport` 是公共入口，不能指望每个调用方都夹好）。
   */
  frameRange?: { from: number; to: number };
  /**
   * 只渲染这条视觉轨（其它视觉轨视为禁用）。省略 = 全部视觉轨。
   *
   * 透传到 `renderFrame` → `buildStack`（见 `BuildStackOptions`）。语义是「只渲染
   * 该轨道本身」，不是「只静音其它轨」—— 该轨的滤镜 / 混合 / 特效照常生效。
   * **音频不属视觉轨**：指定它时 MP4 的音轨照常混入。
   */
  onlyTrackId?: string;
  /**
   * 每渲多少帧让渡一次给 UI（`setTimeout(0)`），默认 10。
   *
   * 默认值是按「每帧几毫秒」的 GPU 路径定的 —— 让渡本身有 1–4ms 的 clamp，
   * 让得太勤会拖慢导出。**纯 CPU 编码的路径要调小**（GIF 传 1）：量化一帧就是
   * 几十毫秒，10 帧一次意味着取消按钮要等半秒才有反应。
   */
  yieldEvery?: number;
  onProgress?: (frac: number) => void;
  /**
   * 每帧耗时（毫秒，含 `prepareFrame` 的异步预热）。
   *
   * 存在的理由：视频素材的解码成本**只能**从这里量到。预览缺帧时会拿最近的
   * 帧顶上（很快），所以「连着渲 N 帧再计时」量的是渲染成本而不是解码成本 ——
   * 实测会得到 3 万 fps 这种荒谬数字。导出循环每帧都 `await prepareFrame`，
   * 那才是真实成本。性能探针与 E2E 用它，产品路径不读。
   */
  onFrame?: (ms: number, index: number) => void;
  signal?: AbortSignal;
}

export async function runExport(
  renderer: Renderer,
  project: Project,
  opts: ExportOptions,
): Promise<Blob | string> {
  // await 期间其它路径会原地改工程；快照保证一次导出只对应一份内容。
  project = structuredClone(project);
  const { w, h } = opts.size ?? project.resolution;
  const total = Math.max(1, Math.ceil(project.duration * project.fps));
  const from = Math.min(Math.max(0, Math.floor(opts.frameRange?.from ?? 0)), total - 1);
  const to = Math.min(Math.max(from + 1, Math.ceil(opts.frameRange?.to ?? total)), total);
  const step = Math.max(1, Math.floor(opts.frameStep ?? 1));
  const yieldEvery = Math.max(1, Math.floor(opts.yieldEvery ?? 10));
  // 「只导某轨」的渲染参数。循环外建一次，别每帧现造对象。
  const renderOpts = opts.onlyTrackId !== undefined ? { onlyTrackId: opts.onlyTrackId } : undefined;
  // 真正会渲的帧数。进度分母必须用它 —— 用 total 的话 step > 1 时进度条
  // 永远到不了 100%（抽帧导出会"卡在 25%"然后突然结束）。
  const passes = Math.max(1, Math.ceil((to - from) / step));

  // 尺寸必须先切到导出分辨率，才能把正确尺寸的 canvas 交给 sink：
  // mediabunny 的 CanvasSource 在构造时读尺寸并缓存 VideoFrame 工厂，
  // 顺序反了会产出一个错尺寸的文件且控制台无提示（见 mp4-sink.ts）。
  renderer.setExportSize(w, h);
  renderer.onSeek();
  renderer.enterExportMode();
  try {
    await opts.sink.configure({ w, h }, project.fps, opts.codec ?? 'png', {
      canvas: renderer.kit.canvas,
    });
    // ADR-003 规则 ③：字体没就绪就开渲，首帧会用回落字体量度，
    // 导出与预览不一致，而且「看起来都正常」，极难定位。
    await renderer.prewarmFonts(project);
    // i 是**源帧号**（决定 t），pass 是**本次第几个被渲的帧**（决定进度与让渡）。
    // 两者在 step > 1 或指定了区间时必须分开：sink 收到的帧号仍要能对上工程时间轴。
    for (let i = from, pass = 0; i < to; i += step, pass++) {
      if (opts.signal?.aborted) throw new ExportCancelled();
      const t = timeOf(i, project.fps);
      // 本帧的文字层预热到导出分辨率。命中缓存时是一次 Map 查询，
      // 未命中才真的光栅化 —— 静态文档整个片段只会在这里付一次代价。
      const frameStart = opts.onFrame ? performance.now() : 0;
      await renderer.prepareFrame(project, t);
      renderer.renderFrame(project, t, renderOpts);
      await opts.sink.submit(i, renderer.kit.canvas);
      if (opts.onFrame) opts.onFrame(performance.now() - frameStart, i);
      opts.onProgress?.((pass + 1) / passes);
      if (pass % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {
    // 取消或抛错都要把编码器放掉，否则硬件会话不会归还（见 Mp4Sink.cancel）。
    await opts.sink.cancel?.();
    throw e;
  } finally {
    renderer.clearExportSize();
    renderer.onSeek();
    renderer.exitExportMode();
  }
  // finalize 失败也要 cancel，否则编码器会话 / 流式写入不会释放。
  try {
    return await opts.sink.finalize();
  } catch (e) {
    try {
      await opts.sink.cancel?.();
    } catch {
      /* 清理失败不能掩盖真正的 finalize 错误 */
    }
    throw e;
  }
}
