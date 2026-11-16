/**
 * project-audio.ts — 主应用的**工程音频离线分析来源**：频谱 + 特征。
 *
 * 与 `lab/spectrum.ts` / `lab/features.ts` 的合成来源是同一个接口的两种实现，
 * 由 `render-core` 注入（所以 `render-core` 本身依然不 import `audio/`）。
 *
 * 频谱与特征**共用一趟 FFT 走查**（`computeSpectrum` 的 `onFrame` 钩子把
 * `audio/features.ts` 的累加器挂上去）—— 详见那两个文件的注释。
 *
 * 两条自愈逻辑（都不指望调用方记得调）：
 * - **换工程 → 重置**：比对 `getProject()` 返回的对象身份。归一化器是有状态的
 *   滚动窗，跨工程留着旧的地板/天花板会让新工程头几秒的高度全是错的。
 * - **拖动播放头 → 重置**：交给 `SpectrumFrames` 按时间跳变判定。
 */

import { SpectrumFrames } from '../audio/spectrum-frames';
import { analyzeAsset, forgetAnalysis, peekAnalysis, type AnalysisBuffer, type AssetAnalysis } from '../audio/analysis';
import { clearMusicMaps, momentAt, musicMapFor } from '../audio/music-store';
import { SPECTRUM_BINS } from '../audio/spectrum';
import { emptyFeatures, zeroFeatures, type AudioFeatures, type AudioFeatureSource } from '../algos/feature-source';
import type { MusicAudioSample } from '../core/expr';
import type { AudioClip, Project } from '../core/schema';

/** 找出覆盖工程时间 `t` 的音频片段（同一时刻有多条时取最靠后开始的那条）。 */
function audioClipAt(project: Project, t: number): AudioClip | null {
  let best: AudioClip | null = null;
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'audio') continue;
      if (t < clip.start || t >= clip.end) continue;
      if (!best || clip.start > best.start) best = clip;
    }
  }
  return best;
}

/**
 * 实现 `SpectrumSource` 与 `AudioFeatureSource` 两个接口。
 *
 * 两者都由**同一次** `computeSpectrum` 产出，所以合成一个类 —— 拆成两个类的话
 * 要么各算一遍（两倍的 FFT），要么为了共享而互相持有，两条都不如现在清楚。
 */
export class ProjectAudio implements AudioFeatureSource {
  private readonly frames = new SpectrumFrames(SPECTRUM_BINS, (t, out) => this.rawAt(t, out));
  /** 已经挂上「算完就重置归一化器」的那些素材。没有它，每帧都会挂一个新的微任务。 */
  private readonly hooked = new Set<string>();
  private lastProject: Project | null = null;
  /** `musicAt` 的出参（复用，与 `features.ts` 的 `at(t, out)` 同一约束）。 */
  private readonly musicScratch: MusicAudioSample = {
    rms: 0,
    sub: 0,
    bass: 0,
    mid: 0,
    high: 0,
    air: 0,
    flux: 0,
    centroid: 0,
    flat: 0,
    energy: 0,
    section: 0,
    sectionU: 0,
    novelty: 0,
  };
  /** 采样特征用的独立出参 —— 不能借调用方的，`at()` 与 `musicAt()` 会交错调用。 */
  private readonly featureScratch = emptyFeatures();
  /** 同一帧里每个参数都问一次，按 t 去掉重复计算。 */
  private lastMusicT = Number.NaN;

  constructor(
    private readonly getProject: () => Project,
    /**
     * 素材 id → 已解码缓冲。用 `AnalysisBuffer` 而不是 `AudioBuffer`：分析只读
     * `length` / `sampleRate` / `numberOfChannels` / `getChannelData`，而单测
     * 不该为了造一个 `AudioBuffer` 去起 WebAudio。
     */
    private readonly bufferFor: (assetId: string) => AnalysisBuffer | null,
  ) {}

  /* ------------------------------------------------------------ SpectrumSource */

  frameFor(instanceId: string, t: number, dt: number, smoothing: number): Uint8Array | null {
    const project = this.getProject();
    if (project !== this.lastProject) {
      this.lastProject = project;
      this.frames.reset();
    }
    return this.frames.frameFor(instanceId, t, dt, smoothing);
  }

  /** 实例消失时忘掉它的包络。 */
  drop(instanceId: string): void {
    this.frames.drop(instanceId);
  }

  /**
   * 素材消失（关工程 / 删素材）时忘掉它的频谱分析。
   *
   * 这一条是**内存**而不是显存：频谱按 1025 bins × 50 字节/秒存，特征再加
   * 10 条 Float32 曲线，一首 5 分钟的歌 ≈ 15 MB 频谱 + 0.7 MB chroma。而缓存是
   * 按 assetId 记的、与「现在用不用它」无关 —— 不显式丢就会跟着页面一直长。
   *
   * 注意缓存是**进程级共享**的（`audio/analysis.ts`）：agent 的 `analyze_music`
   * 读的是同一份。丢在这里等于两边都丢，这正是我们要的。
   */
  forget(assetId: string): void {
    forgetAnalysis(assetId);
    this.hooked.delete(assetId);
    // 地图是从分析结果派生的，分析没了地图也必须重算。
    clearMusicMaps();
    this.lastMusicT = Number.NaN;
  }

  /** 显式重置（导出开始、素材重算之后）。 */
  reset(): void {
    this.frames.reset();
  }

  /* --------------------------------------------------------- AudioFeatureSource */

  /** 工程时间 `t` 处的特征。没有音频片段 / 还没算好时给静音特征。 */
  at(t: number, out: AudioFeatures): void {
    const clip = audioClipAt(this.getProject(), t);
    const track = clip ? this.analysisFor(clip.assetId)?.features : undefined;
    if (!clip || !track) {
      zeroFeatures(out);
      return;
    }
    // 工程时间 → 素材时间：片段的 srcIn 是它在素材里的入点。
    track.at(clip.srcIn + (t - clip.start), out);
  }

  /**
   * 工程时间 `t` 处的「音乐量」：连续特征 + 当前段落的位置。供调制器表达式用。
   *
   * 与 `at()` 分开而不是合并：`at()` 每帧每源读一次、要的是 uniform 那套形状；
   * 这里每帧每**参数**读一次、要的是段落位置。合成一个对象会让两条路径互相
   * 绑死，而它们的消费方完全不相干。
   *
   * 没有音频 / 还没分析好时全 0（不是 NaN）—— 表达式靠这个保持画面不动。
   */
  musicAt(t: number): MusicAudioSample {
    if (t === this.lastMusicT) return this.musicScratch;
    this.lastMusicT = t;
    const out = this.musicScratch;
    const project = this.getProject();
    const clip = audioClipAt(project, t);
    const track = clip ? this.analysisFor(clip.assetId)?.features : undefined;
    if (!clip || !track) {
      out.rms = 0;
      out.sub = 0;
      out.bass = 0;
      out.mid = 0;
      out.high = 0;
      out.air = 0;
      out.flux = 0;
      out.centroid = 0;
      out.flat = 0;
      out.energy = 0;
      out.section = 0;
      out.sectionU = 0;
      out.novelty = 0;
      return out;
    }
    // 工程时间 → 素材时间，与 `at()` 同一换算。
    track.at(clip.srcIn + (t - clip.start), this.featureScratch);
    const f = this.featureScratch;
    out.rms = f.rms;
    out.sub = f.sub;
    out.bass = f.bass;
    out.mid = f.mid;
    out.high = f.high;
    out.air = f.air;
    out.flux = f.flux;
    out.centroid = f.centroid;
    out.flat = f.flat;

    const map = musicMapFor(project, (id) => this.bufferFor(id));
    if (!map) {
      out.energy = 0;
      out.section = 0;
      out.sectionU = 0;
      out.novelty = 0;
      return out;
    }
    const m = momentAt(map, t);
    out.energy = m.energy;
    out.section = m.section;
    out.sectionU = m.sectionU;
    out.novelty = m.novelty;
    return out;
  }

  /* ------------------------------------------------------------------- internals */

  private rawAt(t: number, out: Uint8Array): void {
    const clip = audioClipAt(this.getProject(), t);
    if (!clip) {
      out.fill(0);
      return;
    }
    const track = this.analysisFor(clip.assetId)?.spectrum;
    if (!track) {
      // 还没算好（首次请求会触发计算）—— 这一帧当静音。
      out.fill(0);
      return;
    }
    track.at(clip.srcIn + (t - clip.start), out);
  }

  private analysisFor(assetId: string): AssetAnalysis | null {
    const buffer = this.bufferFor(assetId);
    // 素材还没解码完 —— **不要把这个结论缓存下来**，解码完成后再问就有了。
    if (!buffer) return null;
    const ready = peekAnalysis(assetId, buffer);
    if (ready) return ready;
    if (!this.hooked.has(assetId)) {
      this.hooked.add(assetId);
      // 频谱换了，归一化器要重新播种（旧的地板属于另一段素材）。
      void analyzeAsset(assetId, buffer).then(
        () => this.frames.reset(),
        () => this.hooked.delete(assetId),
      );
    }
    return null;
  }
}
