/**
 * mp4-sink.ts — MP4 视频导出（WebCodecs 编码 + mediabunny 封装）。
 *
 * ADR-001 的 `webcodecs` 后端。**本机 Chrome 实测可用**（2026-10-02）：
 * `avc1.4d0028`（H.264 Main L4）在 1920×1080@60 下 `isConfigSupported` 为 true
 * 且实编出真实码流；`mp4a.40.2`（AAC-LC）同样能实编。
 *
 * > ⚠️ **`avc1.42001f`（baseline 3.1）不能当唯一探测串。**
 * > 它的 coded area 上限是 921600（= 1280×720），1080p 直接被拒，
 * > 报错原文 `the maximum coded area (921600) supported by the AVC level (3.1)`。
 * > 看到这一条不要误判成「H.264 不支持」——那是本项目自己踩过的坑，
 * > 连带把 ADR-001 的探测串写错了（已在该 ADR 加补注）。
 * >
 * > 2026-10-19 起改成**阶梯**（见 `MP4_CODEC_LADDER`）：硬件走 Main，
 * > 无硬编时退到 OpenH264 的 Constrained Baseline。1080p 的软件路径必须用
 * > **Baseline 4.0**（`avc1.42e028`），3.1 的那一档只覆盖 ≤720p。
 *
 * 硬约束 1.1：导出走 `runExport` 的紧循环，`submit` 每帧 await =
 * 编码器背压。mediabunny 的 `CanvasSource.add()` 内部已按 VideoEncoder 的
 * `encodeQueueSize` 做流控，这里不自己判队列长度。
 *
 * 音视频同步：视频帧时间戳是 `i / fps`，音频长度是 `project.duration`，
 * 两者共用同一个 `fps`，不存在两套换算。
 */

import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSource,
  type VideoEncodingConfig,
  type VideoSample,
} from 'mediabunny';
import type { FrameSink, FrameSinkConfigureOptions } from './frame-sink';
import type { MixedAudio } from './mixdown';
import type { SaveStream } from '../platform/types';
import { EXPORT_SAMPLE_RATE, toAudioBuffer } from './mixdown';
import { tr } from '../i18n/index.svelte';

/**
 * H.264 的 codec 阶梯。**从高到低逐档探测，第一个 `isConfigSupported`
 * 通过的档位就是这次导出的配置。**
 *
 * 为什么不是一档：没有硬件编码器的机器上 Chromium 会回退 OpenH264，而它
 * **只支持 Constrained Baseline**（`openh264_video_encoder.cc` 里
 * `profile != H264PROFILE_BASELINE` 直接 unsupported）。写死 Main 会让这类机器
 * 被误判成「不支持 WebCodecs」—— 其实能编，只是编不了 Main。
 *
 * 为什么 baseline 有两档：`avc1.42e01e` 是 **Level 3.1**，coded area 上限
 * 921600（= 720p），1080p 会被拒（见文件头那条实测）。软件路径要覆盖 1080p
 * 必须给 **Level 4.0 的 baseline**（`avc1.42e028`）。
 *
 * ```
 * avc1.4d0028  Main 4.0        ← 硬件主路径（1080p+）
 * avc1.4d401f  Main 3.1        ← 硬件 / 中等尺寸
 * avc1.42e028  Baseline 4.0    ← OpenH264 软件回退（1080p）
 * avc1.42e01e  Baseline 3.1    ← OpenH264 软件回退（≤720p）
 * ```
 *
 * 前两档（Main）默认走硬件；后两档（Baseline）意味着软件编码，导出会明显变慢。
 */
export const MP4_CODEC_LADDER = [
  'avc1.4d0028',
  'avc1.4d401f',
  'avc1.42e028',
  'avc1.42e01e',
] as const;

export type Mp4CodecString = (typeof MP4_CODEC_LADDER)[number];

/**
 * 传给 mediabunny 的编码名。
 *
 * **不是 WebCodecs 的 codec 串。** mediabunny 要的是 `'avc'` / `'aac'` 这类
 * 家族名，level 串（`avc1.4d0028` 里的 `.4d0028`）由它自己按分辨率与帧率算。
 * 传 `avc1.4d0028` 会被 TS 拒绝 —— 这正好挡住了「照抄探测串」这个错误。
 *
 * 那条探测串仍然有意义：它是**探测**用的（本机 Chrome 认不认这一档 H.264），
 * 不是**配置**用的。要让阶梯真正生效，必须把选中的串交给 mediabunny 的
 * `fullCodecString`（否则它会自己拼一个 profile/level，等于把阶梯作废）。
 */
export const MP4_CODEC = MP4_CODEC_LADDER[0];
/** FrameSink.configure 的 codec 参数值 —— 用来做运行期校验（必须是阶梯里的一档）。 */
export const MP4_SINK_CODEC = MP4_CODEC;
const ENCODER_VIDEO_CODEC = 'avc';
const ENCODER_AUDIO_CODEC = 'aac';

/** 一档探测结果。`software` = 落在 baseline（软件编码器）上。 */
export interface Mp4CodecChoice {
  codec: Mp4CodecString;
  /** 命中的档位下标（0 = 硬件主路径，>= 2 = 软件回退）。 */
  rung: number;
  /** 只有 baseline 是软件路径：面板据此提示「会明显变慢」。 */
  software: boolean;
}

/**
 * 纯函数：从「每一档支不支持」里挑出第一档。
 *
 * 抽出来是为了能单测 —— `isConfigSupported` 在 Node 里不存在，
 * 而「跳过不支持、全 false 才放弃」这条逻辑恰恰是最容易写错的地方。
 */
export function pickMp4Codec(supported: readonly boolean[]): Mp4CodecChoice | null {
  for (let i = 0; i < MP4_CODEC_LADDER.length; i++) {
    if (!supported[i]) continue;
    return { codec: MP4_CODEC_LADDER[i]!, rung: i, software: i >= 2 };
  }
  return null;
}

export interface Mp4ProbeOptions {
  w: number;
  h: number;
  fps: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

/**
 * 探测结果缓存。键含尺寸 / 帧率 / 硬件偏好 —— level 的 coded area 与帧率都参与
 * 支持判定，只按 codec 缓存会在改分辨率后给出过期答案。
 *
 * 容量很小（8 条）就够了：一个页面里会变的组合通常只有「预览尺寸 / 导出尺寸」
 * 两三个，缓存只为避免每次开面板都再问一遍编码器。
 */
const PROBE_CACHE_MAX = 8;
const probeCache = new Map<string, Mp4CodecChoice | null>();

/**
 * 按当前导出尺寸逐档探测 H.264 能力。
 *
 * 配置形状必须和 mediabunny 真实下发的一致：带 `avc: { format: 'avc' }`
 * （MP4 走 AVCC 封装，不是 Annex B）。少了它，探测通过而编码失败是可能的。
 *
 * 返回 null = WebCodecs 不存在，或四档全不支持 —— 调用方应退回 PNG 序列，
 * 并按「没有可用 H.264 profile」而不是「不支持 WebCodecs」措辞。
 */
export async function probeMp4Codec(opts: Mp4ProbeOptions): Promise<Mp4CodecChoice | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const key = `${opts.w}x${opts.h}@${opts.fps}#${opts.hardwareAcceleration ?? 'no-preference'}`;
  const hit = probeCache.get(key);
  if (hit !== undefined) return hit;

  const supported: boolean[] = [];
  for (const codec of MP4_CODEC_LADDER) {
    try {
      const config = {
        codec,
        width: opts.w,
        height: opts.h,
        framerate: opts.fps,
        bitrate: defaultBitrate(opts.w, opts.h),
        avc: { format: 'avc' },
        ...(opts.hardwareAcceleration ? { hardwareAcceleration: opts.hardwareAcceleration } : {}),
      } as VideoEncoderConfig;
      const res = await VideoEncoder.isConfigSupported(config);
      supported.push(res.supported === true);
    } catch {
      // 某些构建对不认识的 codec 串直接抛，而不是回 supported:false。
      supported.push(false);
    }
  }
  const choice = pickMp4Codec(supported);
  if (probeCache.size >= PROBE_CACHE_MAX) {
    probeCache.delete(probeCache.keys().next().value as string);
  }
  probeCache.set(key, choice);
  return choice;
}

export interface Mp4SinkOptions {
  /**
   * 硬件加速偏好。默认不传（= `no-preference`）。
   *
   * 产品路径不要写死：只有 E2E / 诊断需要强制 `prefer-software` 去走基线路径。
   */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /**
   * 离线混流好的音频。为 null 时不带音轨（而不是塞一条静音轨）。
   *
   * **为什么音频在这里「已经混好」而不是现算**：混流要读 AudioBuffer，
   * 而 `FrameSink` 接口只收画布。混流放在 UI 层（`ui/export.ts`），
   * 那段纯逻辑可单测，sink 只做编码与封装。
   */
  audio?: MixedAudio | null;
  /** 码率（bps）。不传则按分辨率分档。 */
  bitrate?: number;
  /** 音频码率。默认 192 kbps，AAC-LC 的甜点。 */
  audioBitrate?: number;
  /**
   * 流式落盘出口；null/缺省 = 整份 MP4 驻留内存（`BufferTarget`）再交给调用方。
   *
   * 走流式时用 mediabunny 的 `StreamTarget`（官方点名兼容 FSA 的
   * `FileSystemWritableFileStream`）：它把 moov 放在内存里，其余边产边写，
   * 所以 `fastStart: 'in-memory'` 的语义不变而**内存占用与时长无关**。
   * 触发条件见 `ui/export.ts` 的 `pickOutput` —— 按 `limits.exportMemoryMB` 判。
   */
  stream?: SaveStream | null;
  /**
   * 从**内存样本**编码，而不是从一张画布（`VideoSampleSource` 而不是 `CanvasSource`）。
   *
   * 预览缓存的离屏烘焙用它：那一帧从来不出现在任何画布上（`render/bake-surface.ts`
   * 渲进 FBO 再回读），所以没有 canvas 可交。开了这个模式之后
   * `configure` 不再要 canvas、也不校验画布尺寸，帧由 `submitSample` 送进来。
   */
  samples?: boolean;
}

/** 码率默认表。按像素数分档：低分辨率下别浪费码率，高分辨率下别被压糊。 */
function defaultBitrate(w: number, h: number): number {
  const px = w * h;
  if (px <= 1280 * 720) return 8_000_000;
  if (px <= 1920 * 1080) return 16_000_000;
  return 32_000_000;
}

export class Mp4Sink implements FrameSink {
  private output: Output | null = null;
  private video: CanvasSource | null = null;
  /** 样本模式下的视频源（见 `Mp4SinkOptions.samples`）。与 `video` 二选一。 */
  private sampleSource: VideoSampleSource | null = null;
  private audioSource: AudioBufferSource | null = null;
  private target: BufferTarget | null = null;
  private fps = 30;
  private audio: MixedAudio | null;
  private bitrate: number | undefined;
  private audioBitrate: number | undefined;
  private started = false;
  private readonly stream: SaveStream | null;
  private readonly samples: boolean;
  /** `configure` 收到的、经阶梯选中的 codec 串。交给 mediabunny 的 `fullCodecString`。 */
  private codec: Mp4CodecString = MP4_CODEC;
  private readonly hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** 流式模式下已写出的字节数（`byteLength()` 的读数；`BufferTarget` 那条读 buffer）。 */
  private written = 0;

  constructor(opts: Mp4SinkOptions = {}) {
    this.audio = opts.audio ?? null;
    this.bitrate = opts.bitrate;
    this.audioBitrate = opts.audioBitrate;
    this.stream = opts.stream ?? null;
    this.hardwareAcceleration = opts.hardwareAcceleration;
    this.samples = opts.samples === true;
  }

  async configure(
    size: { w: number; h: number },
    fps: number,
    codec: string,
    opts?: FrameSinkConfigureOptions,
  ): Promise<void> {
    if (!(MP4_CODEC_LADDER as readonly string[]).includes(codec)) {
      throw new Error(tr('err.export.sinkCodec', { want: MP4_CODEC_LADDER.join(' / '), got: codec }));
    }
    this.codec = codec as Mp4CodecString;
    if (!this.samples && !opts?.canvas) {
      // 不能静默建一个占位 canvas：CanvasSource 在构造时读尺寸并缓存
      // VideoFrame 工厂，尺寸错了症状是画面被 letterbox 或裁切，控制台无提示。
      throw new Error(tr('err.export.sinkNoCanvas'));
    }
    this.fps = fps;
    if (this.stream) {
      // 边编边写：`StreamTarget` 负责顺序与回填（moov 仍在内存里，语义同 fastStart）。
      const target = new StreamTarget(this.stream.writable as unknown as ConstructorParameters<typeof StreamTarget>[0]);
      target.on('write', ({ end }) => {
        if (end > this.written) this.written = end;
      });
      this.output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target,
      });
    } else {
      this.target = new BufferTarget();
      this.output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: this.target,
      });
    }

    /*
     * 编码配置：两条路（画布 / 内存样本）必须给出**同一份** codec 与码率配置，
     * 否则「导出能编、缓存编不了」这种分裂迟早出现。
     */
    const encoding: VideoEncodingConfig = {
      codec: ENCODER_VIDEO_CODEC,
      bitrate: this.bitrate ?? defaultBitrate(size.w, size.h),
      /*
       * **阶梯真正生效的唯一入口。** 不传它，mediabunny 会按分辨率/帧率自己拼
       * 一个 codec 串（多半是 Main），于是探测选出的 Baseline 被悄悄换掉 ——
       * 症状是「探测说能编，导出报 unsupported」。
       */
      fullCodecString: this.codec,
      ...(this.hardwareAcceleration
        ? { hardwareAcceleration: this.hardwareAcceleration }
        : {}),
    };

    if (this.samples) {
      this.sampleSource = new VideoSampleSource(encoding);
      this.output.addVideoTrack(this.sampleSource, { frameRate: fps });
    } else {
      const canvas = opts!.canvas!;
      // 交叉校验：传进来的 canvas 尺寸必须与声明的 size 一致。
      // 不一致说明调用方忘了先 setExportSize —— 直接报，不产出一个错尺寸的文件。
      if (canvas.width !== size.w || canvas.height !== size.h) {
        throw new Error(
          tr('err.export.canvasSizeMismatch', {
            cw: canvas.width,
            ch: canvas.height,
            dw: size.w,
            dh: size.h,
          }),
        );
      }
      this.video = new CanvasSource(canvas, encoding);
      this.output.addVideoTrack(this.video, { frameRate: fps });
    }

    // 音频轨必须在 output.start() 之前**建好**（mediabunny 硬约束），
    // 但 PCM 必须在 start() 之后**灌入**（`add()` 会断言已 started）。
    // 所以这里只建源 + 加轨，灌 PCM 挪到 `startIfNeeded()`。
    if (this.audio) {
      this.audioSource = new AudioBufferSource({
        codec: ENCODER_AUDIO_CODEC,
        bitrate: this.audioBitrate ?? 192_000,
      });
      this.output.addAudioTrack(this.audioSource);
    }
  }

  /**
   * mediabunny 的生命周期顺序：**加轨 → start() → add(样本) → finalize()**。
   *
   * `Output.start()` 只能在所有 track 都 addVideoTrack/addAudioTrack 之后调，
   * 而源的 `add()` 又要求已 started。所以 start 必须在「track 建完」与
   * 「第一帧灌入」之间 —— 也就是 `submit` 的第一次调用。
   *
   * 为什么不干脆把 start 放进 finalize：那样所有 `add()` 都会撞上
   * `Output has not started`（踩过）。为什么不在 configure 里 start：
   * 那时视频轨的源已建但还没有样本，start 本身允许，只是音频 PCM
   * 灌不进去 —— 真正的原因是 start 属于「产物生命周期」，
   * 放在第一次 submit 前语义更清楚。
   */
  private async startIfNeeded(): Promise<void> {
    if (this.started || !this.output) return;
    await this.output.start();
    this.started = true;
    if (this.audio && this.audioSource) {
      // OfflineAudioContext 只需一个「能建 buffer」的壳，不做渲染；
      // 真实 AudioContext 在用户未手势时是 suspended，反而会出问题。
      const ctx = new OfflineAudioContext(1, 1, EXPORT_SAMPLE_RATE);
      const buf = toAudioBuffer(this.audio, ctx);
      // startTimestamp 固定 0：混流已把 clip.start 折进 PCM 位置里了，
      // 这里再偏移会造成音轨整体平移。
      await this.audioSource.add(buf);
    }
  }

  async submit(frameIndex: number, _source: HTMLCanvasElement): Promise<void> {
    if (!this.video) throw new Error(tr('err.export.notConfigured'));
    await this.startIfNeeded();
    // 时间戳只在这里算一次：i / fps，duration 固定 1/fps。
    await this.video.add(frameIndex / this.fps, 1 / this.fps);
  }

  /**
   * 样本模式的送帧入口（见 `Mp4SinkOptions.samples`）。时间戳与时长由样本自带。
   *
   * `await` 是**编码器背压**（与 `submit` 同义）。样本的所有权仍在调用方：
   * mediabunny 不会替你 `close()` 它（`VideoSampleSource.add` 传的是 `close=false`），
   * 灌完自己关，否则每帧漏一张 `VideoFrame`（浏览器会先告警、再拒绝新建）。
   */
  async submitSample(sample: VideoSample): Promise<void> {
    if (!this.sampleSource) throw new Error(tr('err.export.notConfigured'));
    await this.startIfNeeded();
    await this.sampleSource.add(sample);
  }

  async finalize(): Promise<Blob | string> {
    if (!this.output) throw new Error(tr('err.export.notConfigured'));
    // 零帧的工程（duration 极短）不会走到 submit，start 得在这里补上。
    await this.startIfNeeded();
    await this.output.finalize();
    if (this.stream) {
      await this.stream.close();
      // 流式路没有 Blob 可交：返回文件名（`FrameSink.finalize` 的 `string` 分支）。
      return this.stream.name;
    }
    const buffer = this.target?.buffer;
    if (!buffer) throw new Error(tr('err.export.noBuffer'));
    return new Blob([buffer], { type: 'video/mp4' });
  }

  /**
   * 取消时释放编码器。
   *
   * **不留着会泄漏**：VideoEncoder 内部持有硬件编码会话，GC 之前不会归还。
   * 连续取消几次导出就能在任务管理器里看到 GPU 占用不降。
   * 判 `started` 是因为 `cancel()` 在 start 之前调会抛。
   */
  async cancel(): Promise<void> {
    // 流式路还要把目标丢掉：不 abort 的话 FSA 的 siloed 写入会一直占着临时文件
    // （而 abort 之后**目标文件保持原样**，这正是取消该有的语义）。
    await this.stream?.abort().catch(() => {});
    if (!this.output || !this.started) return;
    try {
      await this.output.cancel();
    } catch {
      /* 已经结束（finalize 跑过）*/
    }
  }

  /** 产物字节数。UI 用来提示「这次导出占多大」（流式路按已写出的范围计）。 */
  byteLength(): number {
    return this.stream ? this.written : (this.target?.buffer?.byteLength ?? 0);
  }
}
