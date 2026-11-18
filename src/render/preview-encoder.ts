/**
 * preview-encoder.ts — 把一段工程烘成预览用的 MP4，**一帧一步**。
 *
 * 与导出的关系：共用 `Mp4Sink`（同一套 codec 阶梯 / 码率 / 封装），但**不共用驱动**。
 * 导出是紧循环 + 独占渲染器（`runExport`），而烘焙是后台任务：它必须能在两帧之间
 * 把主线程完全让出去，所以这里只提供 `step()`，由调用方（`ui/preview-cache.ts`）
 * 按 rAF 与预算一帧一帧地推。
 *
 * 三个不能省的约定：
 *
 * 1. **没有音轨**（预览的声音由播放器自己出，缓存里带声音只会多一份不同步的东西）。
 * 2. **时间戳从片头算起**（`(i - from) / fps`），解码侧 `getSample(t - 片首时刻)`
 *    就是直接对应的，两边都不必记偏移。
 * 3. **不碰可见画布**：帧从 `BakeSurface` 的离屏目标回读（见 `bake-surface.ts`）。
 *    这是「烘焙期间预览还能动」的全部理由 —— 早期版本走 `runExport` 的
 *    `setExportSize` + 可见画布，于是烘 4 秒、预览就冻 4 秒。
 *
 * 尺寸必须是偶数（H.264 的硬要求，见 `core/dims.ts`）；调用方给的预览尺寸已经
 * 取过偶，这里再取一次是幂等兜底。
 */

import { VideoSample } from 'mediabunny';
import { Mp4Sink, probeMp4Codec } from '../exporters/mp4-sink';
import { evenDims } from '../core/dims';
import { previewBitrate } from '../core/preview-cache';
import type { BakeSurface } from './bake-surface';
import type { Renderer } from '../engine/renderer';
import type { Project } from '../core/schema';

export interface BakeOptions {
  /** 输出尺寸（预览渲染尺寸；内部取偶）。 */
  size: { w: number; h: number };
  /** 帧区间（左闭右开，绝对帧号）。 */
  from: number;
  to: number;
  signal?: AbortSignal;
}

/** 一步的结果。`costMs` 是**主线程**成本（渲染 + 回读 + 构帧），不含编码器等待。 */
export interface BakeStep {
  more: boolean;
  costMs: number;
}

export interface BakeSession {
  readonly from: number;
  readonly to: number;
  /** 已烘好的帧数。 */
  readonly done: number;
  /** 烘下一帧。`more === false` 时调用方应转去 `finish()`。 */
  step(): Promise<BakeStep>;
  /** 收尾，返回 MP4；取消 / 失败 / 尺寸变了 → `null`。 */
  finish(): Promise<Blob | null>;
  /** 放弃这一片（编码器会话必须释放，见 `Mp4Sink.cancel`）。 */
  cancel(): Promise<void>;
}

/**
 * 开一段烘焙。返回 `null` 表示**本机编不了**（没有 WebCodecs / 四档 H.264 全不支持 /
 * 尺寸不合法）—— 调用方据此说话，**不静默变成没有缓存**。
 */
export async function openBake(
  renderer: Renderer,
  surface: BakeSurface,
  project: Project,
  opts: BakeOptions,
): Promise<BakeSession | null> {
  const fps = Math.max(1, project.fps);
  /*
   * 尺寸不合法就**不要问编码器**：`probeMp4Codec` 的结果按 (w,h,fps) 缓存，
   * 用 0×0 问一次会把「不支持」写进那一格。宁可这次不烘。
   */
  const { w, h } = evenDims(opts.size.w, opts.size.h);
  if (!(w >= 32) || !(h >= 32)) {
    console.warn('[preview-cache] bad render size', w, h);
    return null;
  }
  const codec = await probeMp4Codec({ w, h, fps });
  if (!codec) return null;

  const sink = new Mp4Sink({ audio: null, bitrate: previewBitrate(w, h), samples: true });
  // 样本模式不需要 canvas：帧由 `submitSample` 送进来（`Mp4SinkOptions.samples`）。
  await sink.configure({ w, h }, fps, codec.codec);

  // 这一段从干净的历史起步（与导出前的 `renderer.onSeek()` 同义）。
  surface.begin();

  let frame = opts.from;
  /** 尺寸在烘焙中途变了（窗口缩放）就作废：产物尺寸必须与配置一致。 */
  let broken = false;

  const release = async (cancel: boolean): Promise<void> => {
    if (cancel) {
      try {
        await sink.cancel();
      } catch {
        /* 已经结束（finalize 跑过）*/
      }
    }
    surface.release();
  };

  return {
    from: opts.from,
    to: opts.to,
    get done(): number {
      return frame - opts.from;
    },
    async step(): Promise<BakeStep> {
      if (opts.signal?.aborted || broken || frame >= opts.to) {
        return { more: false, costMs: 0 };
      }
      const i = frame;
      const t = i / fps;
      /*
       * 视频取帧 / 排版光栅化是异步的，必须在渲染之前 await ——
       * 与导出循环里那一行同一个理由（缺了就是「这一帧少了文字层」）。
       */
      await renderer.prepareFrame(project, t);
      if (opts.signal?.aborted) return { more: false, costMs: 0 };

      const start = performance.now();
      const baked = surface.renderFrame(project, t);
      if (baked.w !== w || baked.h !== h) {
        // 窗口在烘焙中途被缩放了：这一片的尺寸契约已经破了，整片作废。
        broken = true;
        return { more: false, costMs: performance.now() - start };
      }
      const sample = new VideoSample(baked.data, {
        format: 'RGBA',
        codedWidth: baked.w,
        codedHeight: baked.h,
        timestamp: (i - opts.from) / fps,
        duration: 1 / fps,
      });
      const costMs = performance.now() - start;
      try {
        // 背压在这里（与导出 `submit` 同义）：编码器队列满了就等。
        await sink.submitSample(sample);
      } finally {
        sample.close();
      }
      frame += 1;
      return { more: frame < opts.to, costMs };
    },
    async finish(): Promise<Blob | null> {
      if (broken || opts.signal?.aborted) {
        await release(true);
        return null;
      }
      try {
        const out = await sink.finalize();
        surface.release();
        return typeof out === 'string' ? null : out;
      } catch (err) {
        await release(true);
        throw err;
      }
    },
    async cancel(): Promise<void> {
      await release(true);
    },
  };
}
