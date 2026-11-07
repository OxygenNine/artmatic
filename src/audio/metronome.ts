/**
 * metronome.ts — 预览节拍器。
 *
 * 两件事：
 *   1. `metronomeClicks()` 是**纯函数**：给定一小段时间窗，算出该响的点击
 *      （等距拍 + 手动节奏点）。可以单测，不碰 WebAudio。
 *   2. `Metronome` 是调度器：跟着 `AudioPlayer` 的音频时钟**提前**把点击排进
 *      同一个 AudioContext。等 rAF 发现「已经跨过某一拍」再响会有 0–16 ms 抖动，
 *      卡点听得出来；提前 200 ms 排程让点击和音乐走同一条输出延迟。
 *
 * ## 为什么不是渲染时间源
 *
 * 这里读 `player.currentT()` 只用来知道「现在排到哪儿」；渲染仍然只认 `t`
 * （硬约束 1.1）。节拍器不进导出、不改工程。
 *
 * ## 节奏点与拍的撞车
 *
 * 两者相距 < 20 ms 时只发**节奏点**的音：同时发两个只会更响，听不出「这里在
 * 点上」。节奏点是用户亲手点的，优先于等距网格。
 */

import type { Project } from '../core/schema';
import type { BeatGrid } from '../core/time';
import type { AudioPlayer } from './player';

/** 拍与节奏点相距多近算「同一时刻」，只发节奏点的音（秒）。 */
export const METRONOME_MARK_MERGE_SEC = 0.02;

/** 一次窗口里最多排多少个点击（防止异常 BPM / 跳帧时突然爆一串）。 */
const MAX_CLICKS = 256;

const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.2;

export type MetronomeKind = 'beat' | 'mark';

export interface MetronomeClick {
  /** 工程时间（秒）。 */
  t: number;
  kind: MetronomeKind;
}

/**
 * `(from, to]` 窗口内该响的点击，按时间升序。
 *
 * `from` 是**开区间**：调度器把 frontier 设在 `now - 1 ms`，于是「正好落在
 * 播放头 / 起播点上的那一拍」也会响一次，而不会在同一边界重复。
 */
export function metronomeClicks(
  from: number,
  to: number,
  grid: BeatGrid,
  marks: readonly number[],
): MetronomeClick[] {
  if (!(to > from)) return [];
  const bpm = Number(grid.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return [];

  const beatDur = 60 / bpm;
  const offset = Number(grid.offset) || 0;
  const out: MetronomeClick[] = [];

  // 第一拍严格大于 from。
  let k = Math.floor((from - offset) / beatDur) + 1;
  for (let i = 0; i < MAX_CLICKS; i += 1) {
    const t = offset + k * beatDur;
    if (t > to) break;
    if (t >= 0) out.push({ t, kind: 'beat' });
    k += 1;
  }

  /*
   * marks 已升序（`sanitizeBeatMarks` 保证），二分找窗口起点再线性走完。
   * 录制密集的曲子可能有上万个点，每 25 ms 全表扫一遍是纯浪费。
   */
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]! <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < marks.length; i += 1) {
    const t = marks[i]!;
    if (t > to) break;
    out.push({ t, kind: 'mark' });
  }

  out.sort((a, b) => a.t - b.t);

  // 撞车合并：一个 20 ms 的窗口里只留一个，节奏点优先。
  const merged: MetronomeClick[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev && c.t - prev.t < METRONOME_MARK_MERGE_SEC) {
      if (c.kind === 'mark') prev.kind = 'mark';
      continue;
    }
    merged.push(c);
    if (merged.length >= MAX_CLICKS) break;
  }
  return merged;
}

/**
 * 节拍器调度器。
 *
 * 由 `appState` 在 play / pause / seek 后调 `onPlay()` / `onPause()` ——
 * 不自己轮询播放状态，避免「暂停后还剩 40 次/秒的空转定时器」。
 */
export class Metronome {
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  /** 已经排到哪个工程时间（排程前沿）。 */
  private frontier = Number.NEGATIVE_INFINITY;
  /*
   * 只盯**真正影响节拍**的三样东西：BPM、offset、节奏点数组。
   *
   * 不拿 `store.version` 当变化信号：`touch()` 每次重绘都会抬 version，
   * 播放中拖片段会让节拍器每帧取消并重排一次（听起来是漏拍）。
   */
  private lastBpm = Number.NaN;
  private lastOffset = Number.NaN;
  private lastMarks: readonly number[] | null = null;
  private readonly live = new Set<{ osc: OscillatorNode; gain: GainNode }>();

  constructor(
    private readonly player: AudioPlayer,
    private readonly getProject: () => Project,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on && this.player.isPlaying) this.onPlay();
    else this.onPause();
  }

  /** 播放（或播放中 seek）之后：丢掉旧前沿，从当前位置重新排。 */
  onPlay(): void {
    this.cancelScheduled();
    this.frontier = Number.NEGATIVE_INFINITY;
    this.forgetSignature();
    if (!this.enabled) return;
    this.startTimer();
    this.tick();
  }

  /** 暂停 / 停止：定时器停掉，还没响的点击也取消（否则暂停后还会响 200 ms）。 */
  onPause(): void {
    this.stopTimer();
    this.cancelScheduled();
    this.frontier = Number.NEGATIVE_INFINITY;
    this.forgetSignature();
  }

  dispose(): void {
    this.enabled = false;
    this.onPause();
  }

  private forgetSignature(): void {
    this.lastBpm = Number.NaN;
    this.lastOffset = Number.NaN;
    this.lastMarks = null;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(this.tick, TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private readonly tick = (): void => {
    const ctx = this.player.audioContext;
    const nowT = this.player.currentT();
    if (!this.enabled || !ctx || nowT === null) {
      // 播放被别处停掉了（自然结束 / 关闭工程）：不空转。
      this.onPause();
      return;
    }

    const project = this.getProject();
    const bpm = project.beatGrid.bpm;
    const offset = Number(project.beatGrid.offset) || 0;
    if (
      bpm !== this.lastBpm ||
      offset !== this.lastOffset ||
      project.beatMarks !== this.lastMarks
    ) {
      // 拍网格 / 节奏点被改了：旧网格排出去的还没响的点击作废。
      this.cancelScheduled();
      this.lastBpm = bpm;
      this.lastOffset = offset;
      this.lastMarks = project.beatMarks;
      this.frontier = nowT - 0.001;
    }

    // 往回 seek / 一下子跳太远：不要补放中间漏掉的几百拍。
    if (
      !Number.isFinite(this.frontier) ||
      nowT < this.frontier - 0.2 ||
      nowT > this.frontier + 0.6
    ) {
      this.cancelScheduled();
      this.frontier = nowT - 0.001;
    }

    const to = nowT + LOOKAHEAD_SEC;
    if (to <= this.frontier) return;

    const clicks = metronomeClicks(this.frontier, to, project.beatGrid, project.beatMarks);
    this.frontier = to;
    for (const c of clicks) {
      const when = this.player.audioTimeOf(c.t);
      if (when === null) continue;
      // 已经晚了：宁可少一下，也不要把一串过去的声音挤到现在。
      if (when < ctx.currentTime - 0.02) continue;
      this.click(Math.max(when, ctx.currentTime), c.kind);
    }
  };

  private click(when: number, kind: MetronomeKind): void {
    const ctx = this.player.audioContext;
    if (!ctx) return;
    const mark = kind === 'mark';
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    /*
     * 两种音色必须**一听就能分开**：拍是短促的三角波（节拍器），节奏点是
     * 更高、更长、带一点上滑的正弦（提示「这里有一个你标的点」）。
     */
    osc.type = mark ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(mark ? 1760 : 1046.5, when);
    if (mark) osc.frequency.exponentialRampToValueAtTime(2637, when + 0.018);

    const peak = mark ? 0.11 : 0.075;
    const tail = mark ? 0.1 : 0.045;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + tail);

    osc.connect(gain);
    gain.connect(ctx.destination);

    const node = { osc, gain };
    osc.onended = () => {
      this.live.delete(node);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* 已断开 */
      }
    };
    this.live.add(node);
    osc.start(when);
    osc.stop(when + tail + 0.01);
  }

  private cancelScheduled(): void {
    for (const node of this.live) {
      try {
        node.osc.stop();
      } catch {
        /* 已经停了 */
      }
      try {
        node.osc.disconnect();
        node.gain.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    this.live.clear();
  }
}
