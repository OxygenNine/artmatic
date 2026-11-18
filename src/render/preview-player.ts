/**
 * preview-player.ts — 播放预览渲染缓存：解码一段 MP4 → 一张纹理 → 上屏。
 *
 * 命中判据只有两条：这段区间有完整的缓存条目，且解出的帧时间戳与请求在**半帧
 * 以内**。第二条是「不许放旧画面」的唯一防线 —— 解码器给出相邻帧而画面停在
 * 上一帧，比卡顿更难察觉。
 *
 * ## 为什么是**顺序迭代器**而不是 `getSample(t)`
 *
 * 播放是严格单调前进的，而 mediabunny 的 `getSample(t)` 是随机访问：每一帧都要
 * 重新按关键帧定位再往前解（实测 p50 **11 ms**、p90 27 ms、峰值 250 ms）。
 * 那份成本比它想省掉的合成还贵 —— 缓存开着反而更卡，正是这个原因。
 * `samples(start)` 是「智能预解几帧」的顺序迭代器，前进一帧只付一帧的钱（实测
 * ~1 ms）。回跳（拖播放头）时才重开迭代器。
 *
 * 解码不复用 `engine/video-source.ts` 的管理器：那个是按 `SourceClip` 组织的
 * （速度曲线、拍网格、音轨），而这里只有一个 Blob 和一个时间点。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import type { Kit } from '../engine/kit';
import type { SourceTexture } from '../engine/compositor';

/** 与队列深度一致：队列里有几帧，就得有几张不同的纹理。 */
const RING = 3;

/** 顺序迭代器回退到随机访问的阈值：连这一步都失败就当成「解不出来」。 */
const NO_FRAME = null;

export interface OpenSliceOptions {
  /** 帧率（工程 fps）。半帧容差按它算。 */
  fps: number;
  /** 输出尺寸（纹理尺寸 = 预览缓冲尺寸）。 */
  w: number;
  h: number;
  /** 这一片的起始帧号：请求的工程时间要先减掉它。 */
  fromFrame: number;
}

export class PreviewSlicePlayer {
  private input: Input | null = null;
  private sink: VideoSampleSink | null = null;
  /**
   * 纹理环（3 张）。**不能用单张**：`decode` 把纹理交给队列，而队列最多持 3 帧；
   * 单张的话下一次 `upload` 会把队列里那几帧一起改掉 —— 表现是「播放出来的画面
   * 比播放头快一帧」，而所有时间戳判定都显示正常。
   */
  private ring: SourceTexture[] = [];
  private cursor = 0;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private disposed = false;

  /* ------------------------------------------------------------ 顺序解码状态 */

  private it: AsyncGenerator<VideoSample, void, unknown> | null = null;
  /** 迭代器**已经吐出**的最后一帧的起点（秒）。回跳判定用它。 */
  private itPos = Number.NaN;
  /** 当前候选帧（起点 ≤ 最近一次目标）。所有权在 player，换掉时 close。 */
  private held: VideoSample | null = null;
  /** 迭代器里预取的那一帧（比 `held` 更晚）。推进时要先看它。 */
  private peek: VideoSample | null = null;

  private constructor(
    private readonly kit: Kit,
    private readonly opts: OpenSliceOptions,
  ) {}

  /** 打开一段。解不出主视频轨（截断的文件 / 编不了码的机器）→ `null`。 */
  static async open(kit: Kit, blob: Blob, opts: OpenSliceOptions): Promise<PreviewSlicePlayer | null> {
    const p = new PreviewSlicePlayer(kit, opts);
    try {
      p.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      const track = await p.input.getPrimaryVideoTrack();
      if (!track) {
        await p.dispose();
        return null;
      }
      p.sink = new VideoSampleSink(track);
      return p;
    } catch {
      await p.dispose();
      return null;
    }
  }

  /** 这一帧的画面时间（秒，片内）。 */
  private local(t: number): number {
    return t - this.opts.fromFrame / this.opts.fps;
  }

  /**
   * 解一帧并上传，返回**所有权交给调用方**的纹理（队列持有、由队列释放）。
   *
   * 时间戳偏离超过半帧就返回 null：那是「解出来的是隔壁帧」，宁可不放。
   */
  async decode(t: number): Promise<SourceTexture | null> {
    if (this.disposed || !this.sink) return null;
    const localSec = this.local(t);
    if (!(localSec >= 0)) return null;
    const tolerance = 0.75 / this.opts.fps;
    let sample: VideoSample | null = null;
    try {
      sample = await this.sampleAt(localSec);
      if (!sample) return null;
      if (Math.abs(sample.timestamp - localSec) > tolerance) return null;
      const ok = this.upload(sample);
      if (!ok) return null;
      return this.last ? { ...this.last } : null;
    } catch {
      return null;
    }
  }

  /**
   * 随机访问取一帧（**拖播放头**用）。
   *
   * 拖动是乱序的，顺序迭代器在这里没有意义（每一下都要重开），所以走
   * `getSample`：单次 p50 ≈ 11 ms，但拖动时一帧只解一次、中间帧丢掉，体感
   * 比「每一下都走精确合成」好得多。它会把顺序迭代器丢掉 —— 恢复播放时
   * `decode` 会自己重开。
   */
  async decodeAt(t: number): Promise<SourceTexture | null> {
    if (this.disposed || !this.sink) return null;
    const localSec = this.local(t);
    if (!(localSec >= 0)) return null;
    this.dropIterator();
    let sample: VideoSample | null = null;
    try {
      sample = await this.sink.getSample(localSec);
      if (!sample) return null;
      const ok = this.upload(sample);
      return ok ? this.lastTex() : null;
    } catch {
      return null;
    } finally {
      sample?.close();
    }
  }

  /**
   * 跳到 `t` 而**不上传**。
   *
   * 播放落后太多时（解码追不上 / 页面被切走）不要一帧帧补 —— 那些中间帧根本
   * 不会上屏，但每帧都要付「构帧 + 上传 + GPU 同步」的钱。跳过它们只花迭代器
   * 前进的成本。
   */
  skipTo(t: number): void {
    if (this.disposed || !this.sink) return;
    const localSec = this.local(t);
    if (!(localSec >= 0)) return;
    /*
     * 直接重开迭代器（对内是一次关键帧定位），**不要一帧帧拉过去**：
     * 落后 300 帧时逐帧解 = 300 次解码（几百毫秒的主线程），而定位一次就够。
     */
    this.restart(localSec);
  }

  /** 最近一次上传的那一格（拖动时先铺它，避免整块空白）。 */
  lastTex(): SourceTexture | null {
    return this.last ? { ...this.last } : null;
  }

  /**
   * 取「起点 ≤ `localSec` 的最后一帧」。**顺序前进时只付一帧的成本。**
   *
   * 返回的样本**不交给调用方**（所有权在本类），`upload` 之后仍然是 `held`，
   * 下一次目标更靠后时才会被关闭 —— 这正是避免每帧重新 seek 的关键。
   */
  private async sampleAt(localSec: number): Promise<VideoSample | null> {
    const half = 0.5 / this.opts.fps;
    // 目标落在迭代器当前位置之前（拖播放头 / 重播）：只能重开。
    if (!this.it || localSec < this.itPos - half) this.restart(localSec);

    if (!this.held) this.held = await this.pull();
    if (!this.peek) this.peek = await this.pull();
    // 推进到「下一帧的起点也越过目标」为止（`held` 是最后一个 ≤ 目标的）。
    while (this.peek && this.peek.timestamp <= localSec + 1e-6) {
      this.held?.close();
      this.held = this.peek;
      this.peek = await this.pull();
    }
    if (!this.held && this.sink) {
      // 迭代器从头就没给东西（片尾 / 损坏）：退回随机访问，一次就够。
      this.held = await this.sink.getSample(Math.max(0, localSec));
    }
    return this.held;
  }

  /** 从 `localSec` 前一帧起重开顺序迭代器（含 `localSec` 那一帧）。 */
  private restart(localSec: number): void {
    this.dropIterator();
    if (!this.sink) return;
    this.itPos = Number.NaN;
    this.it = this.sink.samples(Math.max(0, localSec - 0.5 / this.opts.fps));
  }

  private async pull(): Promise<VideoSample | null> {
    const it = this.it;
    if (!it) return NO_FRAME;
    try {
      const { value, done } = await it.next();
      if (done || !value) return NO_FRAME;
      this.itPos = value.timestamp;
      return value;
    } catch {
      return NO_FRAME;
    }
  }

  private dropIterator(): void {
    const it = this.it;
    this.it = null;
    this.held?.close();
    this.held = null;
    this.peek?.close();
    this.peek = null;
    if (it) void it.return?.(undefined);
  }

  private upload(sample: VideoSample): boolean {
    const w = this.opts.w;
    const h = this.opts.h;
    if (!this.canvas) {
      this.canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(w, h)
          : document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = (this.canvas as HTMLCanvasElement).getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
    }
    const ctx = this.ctx;
    if (!ctx) return false;
    ctx.clearRect(0, 0, w, h);
    sample.draw(ctx as CanvasRenderingContext2D, 0, 0, w, h);
    const gl = this.kit.gl;
    while (this.ring.length < RING) {
      const tex = gl.createTexture();
      if (!tex) return false;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.ring.push({ tex, w, h });
    }
    const slot = this.ring[this.cursor % RING]!;
    this.cursor += 1;
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    // 与其它源同一条方向纪律（见 `sources.ts::uploadImage`）：不翻的话画面上下颠倒。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.canvas as TexImageSource,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    slot.w = w;
    slot.h = h;
    this.last = slot;
    return true;
  }

  /** 最近一次 `upload` 落到的那一格。 */
  private last: SourceTexture | null = null;

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dropIterator();
    try {
      await this.input?.dispose?.();
    } catch {
      /* 关不掉不阻塞下一次打开 */
    }
    this.input = null;
    this.sink = null;
    for (const t of this.ring) this.kit.gl.deleteTexture(t.tex);
    this.ring = [];
    this.last = null;
    this.canvas = null;
    this.ctx = null;
  }
}
