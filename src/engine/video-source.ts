/**
 * video-source.ts — 视频素材的取帧器：mediabunny 解封装 + WebCodecs 解码。
 *
 * ## 为什么是 mediabunny 而不是 `<video>` 贴图
 *
 * 硬约束 1.1 要求「预览与导出走同一条求值路径，差别只在分辨率」，1.3 要求
 * 有状态的东西必须确定。`<video>` 的 seek 是异步且不保证落点的 —— 用它会
 * 直接破坏这两条（导出循环里没有办法「等一下 seek」而不引入第二个时钟）。
 *
 * `VideoSampleSink.getSample(t)` 是**按时间戳取帧**的：`t` 决定帧，顺序播放
 * 与随机 seek 走同一条路径，所以导出天然确定。代价是它异步，于是取帧沿用
 * 本项目已有的「异步就绪」约定（与 algo 烘焙、排版光栅化同构）：
 *
 * | 场景 | 行为 |
 * |---|---|
 * | 预览、目标帧还没解出来 | 返回**已解码的最近一帧**顶上（视频播放器的常规做法），没有就 null |
 * | 导出、每帧渲染前 | `prepare()` **await** 到目标帧精确就绪 —— 导出不走「顶上」那条路 |
 *
 * ## 性能上的三条硬措施（用户专门点了这一条）
 *
 * 1. **不在内存里摊开字节。** 素材只存 `Blob`/`File` 引用（浏览器的文件句柄
 *    是磁盘背书的），mediabunny 从它 seek 读。`AssetStore` 对视频只存
 *    `File` / 句柄（本地导入与打开工程都不读字节），保存也走流式 —— 这条约束
 *    现在是**全链路**的，不只是解码这一侧。
 * 2. **解出一帧就立刻 `close()`。** WebCodecs 的 `VideoFrame` 占的是解码器池，
 *    不 close 会让 `decode()` 在几十帧后**停住**（不报错，只是不再出帧）。
 *    所以流程是「解码 → 画进 canvas → 上传 → close」，缓存里只有纹理。
 * 3. **有界纹理缓存 + 上传宽度封顶。** 超过渲染宽度的像素是纯浪费，所以上传
 *    宽度取 `min(素材宽度, renderW, maxUploadWidth)`：预览（≈960）下比全分辨率
 *    小一个量级，导出（1920）时自动拿到全分辨率。
 *
 * ⚠️ **预算是「所有素材合起来」的一份**（`core/capacity.ts` 按机器派生）。
 * 这条曾经写错成一个**每素材**的数字（`new FrameCache(192MB)` 建在每条条目里）
 * 而注释写着「纹理缓存预算」—— 于是 N 个素材是 N × 192 MB，实测一次 4 秒的导出
 * 就用掉 398 MB 显存。显存超额的收场是整块卡变慢或丢上下文，**静默**。
 * 现在由 `rebalance()` 统一裁决，读数见 `stats()` 的 `budgetMB` / `overBudget`。
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  CustomSource,
  Input,
  VideoSampleSink,
  type Source,
  type VideoSample,
} from 'mediabunny';
import type { Kit } from './kit';
import type { SourceTexture } from './compositor';
import { buildStack, transitionSources, walkOps } from './stack';
import { videoMediaFor, type VideoMedia } from './media-assets';
import { planEviction } from './video-budget';
import { getLimits, mbToBytes } from '../core/capacity';
import { mediaTimeOf as mediaTimeAt } from '../core/speed';
import type { BeatGrid } from '../core/time';
import type { Project, SourceClip } from '../core/schema';

/**
 * 顺序访问窗口（秒）：请求的 ts 落在「已消费位置」之后这么远以内，就继续用常驻
 * 迭代器往前拉；超过就重开（重开要重建解码管线，所以窗口不能太小）。
 */
const STREAM_KEEP_SEC = 0.5;

/** 上传函数：由 `SourceManager.uploadImage` 注入（图片/视频共用同一条）。 */
export type UploadFn = (source: TexImageSource, w: number, h: number) => SourceTexture;

interface CachedFrame {
  tex: WebGLTexture;
  w: number;
  h: number;
  /** 该帧在素材里的覆盖区间 [ts, ts + dur)。 */
  ts: number;
  dur: number;
}

class FrameCache {
  /** 按插入顺序（= 时间戳顺序）：淘汰永远从头部开始，那里是最旧的一帧。 */
  private frames: CachedFrame[] = [];
  private bytes = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** 逐帧字节数，最旧在前 —— 淘汰决策（`video-budget.ts`）的输入。 */
  sizes(): number[] {
    return this.frames.map((f) => f.w * f.h * 4);
  }

  /**
   * 命中判定是**区间包含**而不是等值：素材可以是变帧率的，
   * 「t 落在哪一帧的覆盖区间里」才是正确的取帧语义。
   *
   * 线性扫描而不是二分：条目数被字节预算压在几十以内，可读性更值钱。
   */
  get(ts: number, w: number): CachedFrame | null {
    for (const f of this.frames) {
      if (f.w !== w) continue;
      if (ts >= f.ts && ts < f.ts + f.dur) return f;
    }
    return null;
  }

  /** 已解码的、时间戳最接近 ts 的一帧（预览缺帧时顶上用）。 */
  nearest(ts: number, w: number): CachedFrame | null {
    let best: CachedFrame | null = null;
    let bestGap = Infinity;
    for (const f of this.frames) {
      if (f.w !== w) continue;
      const gap = Math.abs(f.ts - ts);
      if (gap < bestGap) {
        bestGap = gap;
        best = f;
      }
    }
    return best;
  }

  has(ts: number, w: number): boolean {
    return this.get(ts, w) !== null;
  }

  put(frame: CachedFrame): void {
    const dup = this.frames.findIndex((f) => f.ts === frame.ts && f.w === frame.w);
    if (dup >= 0) {
      const old = this.frames[dup]!;
      this.gl.deleteTexture(old.tex);
      this.bytes -= old.w * old.h * 4;
      this.frames.splice(dup, 1);
    }
    this.frames.push(frame);
    this.bytes += frame.w * frame.h * 4;
    // **不在这里淘汰**：预算现在是「所有素材合起来」的一份，单条缓存看不见全局，
    // 详见 VideoBudget。放进来的帧由 `rebalance()` 统一裁决。
  }

  /** 执行淘汰计划：从最旧的一端丢掉 `n` 帧。 */
  dropOldestN(n: number): void {
    for (let i = 0; i < n; i++) this.dropOldest();
  }

  /** 丢掉最旧的一帧，返回释放的字节数。只剩一帧时不动（返回 0）。 */
  dropOldest(): number {
    if (this.frames.length <= 1) return 0;
    const old = this.frames.shift()!;
    this.gl.deleteTexture(old.tex);
    const n = old.w * old.h * 4;
    this.bytes -= n;
    return n;
  }

  get count(): number {
    return this.frames.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  dispose(): void {
    for (const f of this.frames) this.gl.deleteTexture(f.tex);
    this.frames = [];
    this.bytes = 0;
  }
}

interface MediaEntry {
  assetId: string;
  input: Input<Source> | null;
  sink: VideoSampleSink | null;
  frames: FrameCache;
  /** 同一素材上的解码串行化：sink 内部只有一个解码器，并发调用会互相踩。 */
  chain: Promise<void>;
  /** 正在解一帧（`schedule` 的去重据此判断要不要只记待办）。 */
  busy: boolean;
  /** 待办解码，**只保留最新一个**（见 `schedule` 的注释）。 */
  pending: { ts: number; w: number } | null;
  /**
   * 常驻的顺序解码迭代器（见 `sampleAt`）。
   * `null` = 还没开，或者上一次拉到底了。
   */
  stream: { iter: AsyncGenerator<VideoSample>; at: number } | null;
  ready: boolean;
  failure: string | null;
  displayW: number;
  displayH: number;
  /**
   * 最近一次被取用的逻辑时刻（越大越新）。
   *
   * 全局淘汰的判据是**缓存的**新旧而不是帧的新旧：正在播的那个素材几乎每帧都被
   * 取用，而很久没上时间轴的那个素材整条都可以放掉 —— 这比「谁的帧更老」更贴近
   * 用户接下来会看什么。
   */
  used: number;
}

export interface VideoSourceStats {
  decodes: number;
  hits: number;
  misses: number;
  /** 预览里因为「已经有一帧在解」而被丢弃的过期请求（见 `schedule`）。 */
  dropped: number;
  /**
   * 重建了几次顺序解码迭代器（见 `sampleAt`）。
   *
   * **顺序播放时这个数应当接近 1**。它是「有没有退回到逐帧重建解码管线」的
   * 机制判据 —— 比解码数更可靠（后者会被区间去重同样压低）。
   */
  streams: number;
  cachedFrames: number;
  cachedBytes: number;
  /** 当前生效的全局预算（MB）与「连每条一帧都放不下」时的超额状态。 */
  budgetMB: number;
  overBudget: boolean;
  failures: { assetId: string; reason: string }[];
}

export interface VideoSourceManager {
  /** 同步取帧。未就绪返回 null；缺帧时用最近的已解码帧顶上。 */
  frameFor(clip: SourceClip, t: number, renderW: number): SourceTexture | null;
  /** 导出用：await 到目标帧精确就绪（含首次元数据初始化）。 */
  prepare(clip: SourceClip, t: number, renderW: number): Promise<void>;
  /**
   * 导出用：把工程在 t 时刻**所有会被画到的** video 片段都解到精确帧。
   *
   * 走 `buildStack` 而不是自己遍历 tracks，是因为转场会在片段自己的 span
   * 之外求值（窗口后半段的出画片段、前半段的入画片段）—— 自己遍历漏掉这条，
   * 导出的转场帧就会拿到「顶上的近似帧」，而那正是导出不允许的。
   */
  prepareProject(project: Project, t: number, renderW: number): Promise<void>;
  /** 素材没了/换了（删除素材、关闭工程）。 */
  forget(assetId: string): void;
  stats(): VideoSourceStats;
  dispose(): void;
}

/**
 * 片段的本地时间 → 素材内时间（秒）。与播放器 / mixdown 的 srcIn 语义一致。
 *
 * 变速（尤其速度曲线 / 倒放）的全部数学在 `core/speed.ts` —— 这里只是取帧器
 * 的入口。**`grid` 不能省**：速度曲线可以锚到拍（`Curve.beatAnchor`），没有
 * 网格就退回「相对片段起点」的解释，画面会整体错位一段。
 */
export function mediaTimeOf(clip: SourceClip, t: number, grid?: BeatGrid): number {
  if (clip.source.type !== 'video') return 0;
  return mediaTimeAt(clip, t, grid);
}

export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  /** 是否含音轨（v13）。媒体池据此决定要不要显示「分离音频」。 */
  hasAudio: boolean;
}

/**
 * `VideoMedia` → mediabunny 的 `Source`。
 *
 * 三条来源必须是三种 adapter，不能「都包成 Blob」：`path` 的整份包装等于
 * 把 2 GB 读进内存，正好是句柄化消灭的动作。`CustomSource` 只按请求的范围
 * 读，缓存上限 8 MiB（与 `BufferSource` 的量级一致）。
 */
export function videoSourceOf(media: VideoMedia): Source {
  if (media instanceof Blob) return new BlobSource(media);
  if (media instanceof Uint8Array) return new BufferSource(media);
  return new CustomSource({
    getSize: () => media.size,
    read: (start, end) => media.read(start, end),
    prefetchProfile: 'fileSystem',
    maxCacheSize: 8 * 1024 * 1024,
  });
}

/**
 * 读一次元数据（时长 + 显示尺寸）。导入时用来定片段的默认长度，
 * 以及写进 `Project.assets[id].durationSec / size`。
 *
 * 与 `createVideoSourceManager` 里那份各自持有自己的 `Input`：这里是一次性的，
 * 读完就 dispose；共用那份的话，导入时的 probe 会与播放期的解码器抢同一个实例。
 */
export async function probeVideo(media: VideoMedia): Promise<VideoProbe | null> {
  let input: Input<Source> | null = null;
  try {
    const source = videoSourceOf(media);
    input = new Input({ formats: ALL_FORMATS, source });
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const [duration, width, height, audioTrack] = await Promise.all([
      input.computeDuration(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      input.getPrimaryAudioTrack().catch(() => null),
    ]);
    return { duration, width, height, hasAudio: audioTrack !== null };
  } catch (e) {
    console.warn('[video] probe 失败：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    input?.dispose();
  }
}

/** 缩略图宽度（媒体池那一行显示 40×26，160 够 HiDPI 了）。 */
const THUMB_WIDTH = 160;

/**
 * 取一帧画面做成缩略图（媒体池的素材行用）。取不到返回 null。
 *
 * 与 `probeVideo` 同一个套路：**开一份一次性的 `Input` / `sink`，用完就 dispose**
 * —— 与播放期那份解码器互不干扰（共用会把正在播的视频的解码器抢走，而用户
 * 只是拉开抽屉看一眼列表）。
 *
 * 这里刻意用 `getSample(t)` 而不是常驻迭代器：**一次性取一帧**，重建管线的
 * 代价只付一次（`sampleAt` 那条常驻迭代器是为逐帧渲染准备的，生命周期要额外管）。
 *
 * 为什么媒体池的图片素材不需要这一套：导入时 `registerImageBytes` 已经解出
 * 一张 canvas。视频只有 `Blob`/`File` 句柄（AGENTS 的硬要求：不摊开字节、不解码），
 * 所以「看得见的时候才解一帧」是唯一可行的做法。
 */
export async function videoThumbnail(
  media: VideoMedia,
  atSec: number,
  width = THUMB_WIDTH,
): Promise<Blob | null> {
  // 视频解码路径本来就依赖 OffscreenCanvas（`ctxFor`），这里不另开一条降级路。
  if (typeof OffscreenCanvas === 'undefined') return null;

  let input: Input<Source> | null = null;
  try {
    const source = videoSourceOf(media);
    input = new Input({ formats: ALL_FORMATS, source });
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sample = await new VideoSampleSink(track).getSample(Math.max(0, atSec));
    if (!sample) return null;
    try {
      const [dw, dh] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
      const w = Math.max(2, Math.round(Math.min(width, dw || width)));
      const h = Math.max(2, Math.round((w * (dh || w)) / (dw || w)));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // mediabunny 的 draw 会应用旋转与翻转元数据，与渲染路径同一套（不用自己算）
      sample.draw(ctx, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    } finally {
      // 不 close 会占住解码器池（见文件头第 2 条）
      sample.close();
    }
  } catch (e) {
    console.warn('[video] 缩略图取帧失败：', e);
    return null;
  } finally {
    input?.dispose();
  }
}

export interface VideoSourceOpts {
  /**
   * 新帧解码落地时回调（→ `store.invalidate()` 让下一帧重绘；不是内容改动）。
   * 没有它的话：预览停在某一帧时解码完成了，画面也不会更新。
   */
  onFrameReady?: () => void;
  /**
   * 当前工程的拍网格。速度曲线可以锚到拍，没有网格就解不出锚定曲线的
   * 折返点（见 `core/speed.ts::speedAt`）。缺省 = 没有锚定曲线。
   */
  getGrid?: () => BeatGrid;
}

export function createVideoSourceManager(
  kit: Kit,
  upload: UploadFn,
  opts: VideoSourceOpts = {},
): VideoSourceManager {
  const gl = kit.gl;
  const entries = new Map<string, MediaEntry>();
  const counters = { decodes: 0, hits: 0, misses: 0, dropped: 0, streams: 0 };
  /** 取用顺序的逻辑时钟（`MediaEntry.used`），只用于全局淘汰。 */
  let clock = 0;
  /** 上一次再平衡是否连「每条一帧」都放不下 —— 记在 `stats()` 里，别静默。 */
  let overBudget = false;

  /* ------------------------------------------------------------- 全局预算 */

  function totalBytes(): number {
    let n = 0;
    for (const e of entries.values()) n += e.frames.byteLength;
    return n;
  }

  /**
   * 全局再平衡：**预算是所有素材合起来的一份**。
   *
   * 这一点是这次修的核心：预算过去写在每条缓存里（`new FrameCache(BUDGET)`），
   * 于是「192 MB 预算」在 N 个素材上是 N × 192 MB —— 实测一次 4 秒的导出就用掉
   * 398 MB 显存，而代码看上去永远「很安全」。显存没有进程配额，超了的收场是
   * 整块卡一起变慢或直接丢上下文（**静默**）。
   *
   * 决策在 `video-budget.ts`（纯函数、有单测），这里只负责把计划执行掉 ——
   * 删纹理是副作用，而副作用是最不该藏逻辑的地方。
   */
  function rebalance(): void {
    const limits = getLimits();
    const list = [...entries.values()];
    const plan = planEviction(
      list.map((e) => ({ used: e.used, sizes: e.frames.sizes() })),
      mbToBytes(limits.videoPerAssetMB),
      mbToBytes(limits.videoTextureMB),
    );
    for (let i = 0; i < list.length; i++) {
      const n = plan.drop[i] ?? 0;
      if (n > 0) list[i]!.frames.dropOldestN(n);
    }
    if (plan.overBudget && !overBudget) {
      console.warn(
        `[video] 缓存连「每条一帧」都放不下全局预算 ${limits.videoTextureMB} MB，` +
          '这次不再继续淘汰（会删掉正在显示的画面）；' +
          '素材规格与机器能力不匹配，可在 artmatic.capacity.json 里调大 videoTextureMB。',
      );
    }
    overBudget = plan.overBudget;
  }

  /** 复用一个 2D canvas：每帧新建会持续制造 GC 压力。 */
  let scratch: OffscreenCanvas | null = null;
  let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

  function ctxFor(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    if (!scratch) {
      scratch = new OffscreenCanvas(w, h);
      scratchCtx = scratch.getContext('2d');
    } else if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    return scratchCtx;
  }

  function ensure(assetId: string): MediaEntry | null {
    const existing = entries.get(assetId);
    if (existing) return existing;

    const media = videoMediaFor(assetId);
    if (!media) return null; // 还没登记：这一帧缺席，登记后会通知重绘

    const entry: MediaEntry = {
      assetId,
      input: null,
      sink: null,
      frames: new FrameCache(gl),
      chain: Promise.resolve(),
      busy: false,
      pending: null,
      stream: null,
      ready: false,
      failure: null,
      displayW: 0,
      displayH: 0,
      used: ++clock,
    };
    entries.set(assetId, entry);

    try {
      // Blob → 磁盘背书（本地导入的 File 走这条，零内存）
      // Uint8Array → 零拷贝包住（打开工程时素材已在内存里，不再多一份）
      // path → CustomSource 按范围读（桌面版 linked，不整份进堆）
      const source = videoSourceOf(media);
      const input = new Input({ formats: ALL_FORMATS, source });
      entry.input = input;
      entry.chain = entry.chain.then(async () => {
        try {
          if (!(await input.canRead())) throw new Error('无法识别的容器格式');
          const track = await input.getPrimaryVideoTrack();
          if (!track) throw new Error('文件里没有视频轨');
          entry.displayW = await track.getDisplayWidth();
          entry.displayH = await track.getDisplayHeight();
          entry.sink = new VideoSampleSink(track);
          entry.ready = true;
        } catch (e) {
          // 失败是粘性的：容器/编解码不支持不是瞬态，不能每帧重试。
          entry.failure = e instanceof Error ? e.message : String(e);
          console.error(`[video ${assetId}] 打开失败：${entry.failure}`);
        }
      });
    } catch (e) {
      entry.failure = e instanceof Error ? e.message : String(e);
      console.error(`[video ${assetId}] 初始化失败：${entry.failure}`);
    }
    return entry;
  }

  /**
   * 上传宽度 = min(素材宽度, 渲染宽度, 上限)。
   *
   * 超过渲染宽度的像素是纯浪费；上限来自机器能力（`maxUploadWidth`，8K 素材在
   * 大显存机器上不再被无条件缩到 3840）。这条是**质量**旋钮，不是容量旋钮 ——
   * 一张纹理多大只影响清晰度，总占用由全局预算兜着。
   */
  function uploadWidthFor(entry: MediaEntry, renderW: number): number {
    const edge = getLimits().maxUploadWidth;
    const cap = Math.max(16, Math.min(renderW || edge, edge));
    return Math.max(1, Math.min(entry.displayW || cap, cap));
  }

  /**
   * 取到覆盖 `ts` 的那一帧，走**常驻的顺序解码迭代器**。
   *
   * 为什么不能用 `sink.getSample(t)`：它的实现是
   * `for await (… this.mediaSamplesAtTimestamps([t]) …)` —— **每次调用都新建一个
   * 只含一个时间戳的迭代器**，也就是把解码管线整个重建一遍（从最近的关键帧重新解起）。
   * 它自己的文档也写着：顺序访问应当用 `samples()`。
   * 这正是「渲染循环能跑 190fps、画面却只有十来帧」的根因 —— 渲染的是缓存纹理，
   * 而视频内容只在解码出新帧时才变。
   *
   * `samples(startTimestamp)` 的起点语义正好是我们要的：它的实现注释写明
   * 「the first first is the last first whose timestamp is less than or equal to
   * the start timestamp」，也就是**覆盖该时刻的那一帧** —— 与 `FrameCache` 的
   * 区间包含判定一致，不需要自己回退半帧。
   */
  async function sampleAt(entry: MediaEntry, ts: number): Promise<VideoSample | null> {
    const cur = entry.stream;
    if (cur && ts >= cur.at - 1e-6 && ts - cur.at < STREAM_KEEP_SEC) {
      for (;;) {
        const r = await cur.iter.next();
        if (r.done) {
          await closeStream(entry);
          return null;
        }
        const s = r.value;
        const end = s.timestamp + (s.duration > 0 ? s.duration : 1 / 60);
        cur.at = end;
        if (ts < end) return s;
        // 过期帧：解码器已经解了，只能丢掉（但必须 close，否则解码器池会卡死）
        s.close();
      }
    }
    await closeStream(entry);
    const iter = entry.sink!.samples(ts);
    entry.stream = { iter, at: ts };
    counters.streams++;
    const r = await iter.next();
    if (r.done) {
      await closeStream(entry);
      return null;
    }
    const s = r.value;
    entry.stream.at = s.timestamp + (s.duration > 0 ? s.duration : 1 / 60);
    return s;
  }

  /** 收掉常驻迭代器（释放它内部的解码器）。 */
  async function closeStream(entry: MediaEntry): Promise<void> {
    const s = entry.stream;
    if (!s) return;
    entry.stream = null;
    try {
      await s.iter.return(undefined);
    } catch {
      // 关闭失败无所谓：迭代器已经不会再被用到
    }
  }

  /**
   * 解一帧并上传。**上传完立刻 `sample.close()`** —— 见文件头第 2 条。
   * 区间已命中就直接返回，不重复解。
   */
  async function decodeAndUpload(entry: MediaEntry, ts: number, w: number): Promise<void> {
    if (entry.failure || !entry.sink) return;
    if (entry.frames.has(ts, w)) return;

    const sample: VideoSample | null = await sampleAt(entry, ts);
    if (!sample) return; // ts 早于素材第一帧：这一层缺席
    try {
      const scale = entry.displayW > w ? w / entry.displayW : 1;
      const outW = Math.max(1, Math.round(entry.displayW * scale));
      const outH = Math.max(1, Math.round(entry.displayH * scale));
      const ctx = ctxFor(outW, outH);
      if (!ctx) return;
      ctx.clearRect(0, 0, outW, outH);
      // mediabunny 的 draw 会应用旋转与翻转元数据，这里不用自己算
      sample.draw(ctx, 0, 0, outW, outH);
      const st = upload(ctx.canvas as unknown as TexImageSource, outW, outH);
      entry.frames.put({
        tex: st.tex,
        w: outW,
        h: outH,
        ts: sample.timestamp,
        dur: sample.duration > 0 ? sample.duration : 1 / 60,
      });
      counters.decodes++;
      // 新帧落地之后再裁决全局预算：淘汰的是**别的**素材里没人再看的帧，
      // 刚放进来这一帧一定是各缓存里最新的，不会被自己挤掉。
      rebalance();
      opts.onFrameReady?.();
    } finally {
      sample.close();
    }
  }

  /**
   * 把一次解码挂到该素材的串行链上。
   *
   * **同一素材同时只允许「一个在跑 + 一个待办」，而且待办只保留最新的那一个。**
   *
   * 为什么必须这样：sink 只有一个解码器，4K 解一帧要几十毫秒，而预览每渲染一帧
   * 都会请求一个**新的**时间戳（顺序播放时 ts 一直在变）。若每个请求都排队，
   * 队列会无限增长，而且每一项在轮到它时**早已过期** —— 表现是「解不完的废帧把
   * CPU/GPU 占满、主线程被饿死」，视频越播越落后，重特效下整个页面失去响应。
   *
   * 只留最新一个 = **解码器能跑多快就多快，过期请求直接丢**。
   * （导出不走这条：`prepare` 直接 await 精确帧。）
   */
  function schedule(entry: MediaEntry, ts: number, w: number): void {
    if (entry.busy) {
      if (entry.pending === null || entry.pending.ts !== ts) counters.dropped++;
      entry.pending = { ts, w };
      return;
    }
    entry.busy = true;
    entry.chain = entry.chain.then(async () => {
      let job: { ts: number; w: number } | null = { ts, w };
      while (job) {
        try {
          await decodeAndUpload(entry, job.ts, job.w);
        } catch (e) {
          entry.failure ??= e instanceof Error ? e.message : String(e);
          console.error(`[video ${entry.assetId}] 解码失败：${entry.failure}`);
        }
        // 跑到这里时，待办里可能已经堆了更新的请求 —— 只取最新那个。
        job = entry.pending;
        entry.pending = null;
      }
      entry.busy = false;
    });
  }

  const api: VideoSourceManager = {
    frameFor(clip, t, renderW) {
      if (clip.source.type !== 'video') return null;
      const entry = ensure(clip.source.assetId);
      if (!entry || entry.failure) return null;
      if (!entry.ready) {
        counters.misses++;
        return null;
      }
      const ts = mediaTimeOf(clip, t, opts.getGrid?.());
      const w = uploadWidthFor(entry, renderW);
      // 每次取用都刷新这个素材的「新旧」：全局淘汰全靠它判断谁可以先放掉。
      entry.used = ++clock;
      const hit = entry.frames.get(ts, w);
      if (hit) {
        counters.hits++;
        return { tex: hit.tex, w: hit.w, h: hit.h };
      }
      counters.misses++;
      schedule(entry, ts, w);
      const near = entry.frames.nearest(ts, w);
      return near ? { tex: near.tex, w: near.w, h: near.h } : null;
    },

    async prepare(clip, t, renderW) {
      if (clip.source.type !== 'video') return;
      const entry = ensure(clip.source.assetId);
      if (!entry || entry.failure) return;
      // 首次调用时 chain 就是元数据初始化那一段，await 它就等于等就绪
      await entry.chain;
      if (!entry.ready || entry.failure) return;
      const ts = mediaTimeOf(clip, t, opts.getGrid?.());
      const w = uploadWidthFor(entry, renderW);
      if (entry.frames.has(ts, w)) return;
      try {
        await decodeAndUpload(entry, ts, w);
      } catch (e) {
        entry.failure ??= e instanceof Error ? e.message : String(e);
      }
    },

    async prepareProject(project, t, renderW) {
      const clips: SourceClip[] = [];
      // 走 walkOps 而不是直接遍历：带影响深度的特效把它的作用域**折进**了 op 里
      // （见 engine/stack.ts），只看顶层会漏掉那些轨道上的视频源。
      walkOps(buildStack(project, t), (op) => {
        if (op.type === 'source') clips.push(op.source.clip);
        else if (op.type === 'transition') {
          for (const side of transitionSources(op)) clips.push(side.clip);
        }
      });
      await Promise.all(clips.map((c) => api.prepare(c, t, renderW)));
    },

    /**
     * 彻底放掉一个素材：顺序迭代器（内含解码器）、帧缓存纹理、容器 Input。
     *
     * **必须有人在恰当的时候调它**，否则这些资源会活到页面结束 —— 关掉一份
     * 2 GB 素材的工程再开一份，两份的显存叠在一起，而用户看不到任何提示。
     * 调用点见 `app-state.closeProject`（关工程 = 这份工程的所有素材）。
     */
    forget(assetId) {
      const entry = entries.get(assetId);
      if (!entry) return;
      void closeStream(entry);
      entry.frames.dispose();
      entry.input?.dispose();
      entries.delete(assetId);
      // 少了一条缓存，超预算的判断也该跟着重算（否则读数会一直停在旧结论上）。
      rebalance();
    },

    stats() {
      let frames = 0;
      let bytes = 0;
      const failures: { assetId: string; reason: string }[] = [];
      for (const e of entries.values()) {
        frames += e.frames.count;
        bytes += e.frames.byteLength;
        if (e.failure) failures.push({ assetId: e.assetId, reason: e.failure });
      }
      return {
        decodes: counters.decodes,
        hits: counters.hits,
        misses: counters.misses,
        dropped: counters.dropped,
        streams: counters.streams,
        cachedFrames: frames,
        cachedBytes: bytes,
        budgetMB: getLimits().videoTextureMB,
        overBudget,
        failures,
      };
    },

    dispose() {
      for (const id of [...entries.keys()]) api.forget(id);
    },
  };

  return api;
}
