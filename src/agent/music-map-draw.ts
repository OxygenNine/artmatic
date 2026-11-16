/**
 * music-map-draw.ts — 把 `MusicMap` 画成一张**能看出来形状**的图。
 *
 * 为什么要有它：数字表说得出「第 23 小节能量 2.7」，说不出「这一段是平的」。
 * agent 是多模态的，给它一张图比给它三百行 JSON 有效得多 —— 这也是它「有没有
 * 耳朵」的分界线：能量弧线、频段平衡、onset 密度、新奇度峰必须能被**看见**。
 *
 * 布局与绘制分开：`layoutMusicMap` 是纯算术（可单测「色带首尾相接 / 泳道不重叠 /
 * 标签不出界」），`drawMusicMap` 才碰 canvas。两者混在一起时，唯一能做的断言
 * 就只剩「没抛错」。
 *
 * 文案一律用 ASCII（`RMS` / `BANDS` / `ONSET` / `NOVELTY`）：这是诊断图，
 * 与 DAW 的示波器同一类读法；走 i18n 反而会让同一张图在不同语言下排版不同。
 */

import type { MusicMap } from '../audio/structure';

export interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MusicMapLayout {
  w: number;
  h: number;
  /** 绘图区左右边界（左边留出泳道名）。 */
  x0: number;
  x1: number;
  title: MapRect;
  /** 段落色带（字母 + 能量）。 */
  ribbon: MapRect;
  /** 小节标尺。 */
  ruler: MapRect;
  lanes: { rms: MapRect; bands: MapRect; onset: MapRect; novelty: MapRect };
  timeAxis: MapRect;
  /** 每段在画布上的横向区间（与 `map.sections` 同序）。 */
  sections: MapRect[];
  /** 每个 drop 段落的顶条（与 `map.drops` 同序）。 */
  drops: MapRect[];
  /**
   * 每个小节列的左边界与宽度（与 `map.bars` 同序，首尾相接铺满 `x0..x1`）。
   *
   * 在这里一次算完而不是绘制时逐次累加：绘制时是「每条泳道 × 每个小节」的
   * 双重循环，每次都从头累加时长的话，一页 300 小节就是几十万次加法。
   */
  barX: number[];
  barW: number[];
  /**
   * 两条连续量泳道的**显示刻度**：`max`（带下限）。
   *
   * 按窗口内最大值归一，而不是按 0..1 的绝对刻度：`BarRow.rms` 是**小节内所有帧的
   * 均值**，而 `features.ts` 的归一化用的是**单帧最大**——于是小节级的最大值通常
   * 只有 0.2，按绝对刻度画出来是一条贴着底的线，读者会以为这一层没有数据。
   * 绝对数值写在泳道名旁边（`RMS .21`），形状与量级都在。
   */
  rmsScale: number;
  onsetScale: number;
  playheadX: number | null;
  /** novelty 判据线（`NOV_Z / NOV_FULL_Z` = 1/3）在画布上的 y。 */
  noveltyThresholdY: number;
  windowStart: number;
  windowEnd: number;
}

/** 顶部固定带：标题 + 色带 + 小节标尺。 */
const TOP = 104;
/** 底部固定带：时间标尺。 */
const BOTTOM = 30;
/** 左边距（泳道名）。 */
const LEFT = 56;
const RIGHT = 16;
/** 四条泳道的相对高度（会被拉伸到剩余空间）。 */
const LANE_WEIGHTS = [84, 84, 64, 84] as const;
/** novelty 判据线在 0..1 上的位置：`structure.ts` 的 `NOV_Z / NOV_FULL_Z`。 */
export const NOVELTY_THRESHOLD = 1 / 3;

export const MAP_COLORS = {
  bg: '#0b0b0f',
  text: '#e8e8e8',
  muted: '#9aa4b2',
  grid: 'rgba(255,255,255,0.10)',
  gridStrong: 'rgba(255,255,255,0.22)',
  rms: '#7cc8ff',
  onset: '#c8ff6a',
  novelty: '#ff7ad9',
  drop: '#ff5a5a',
  boundary: 'rgba(255,255,255,0.18)',
  playhead: '#ffffff',
  /** 五段从低到高。 */
  bands: ['#3b4a6b', '#4f6fa8', '#5fa8a0', '#d8a94a', '#e06c75'] as const,
  /** 段落配色（按簇号取模）。 */
  sections: [
    '#3f6fa8',
    '#8a5fa8',
    '#4f8a6b',
    '#a8803f',
    '#a8503f',
    '#3f8aa8',
    '#7a7a3f',
    '#a83f7a',
  ] as const,
};

export function layoutMusicMap(
  map: MusicMap,
  opt: { w: number; h: number; t?: number | null },
): MusicMapLayout {
  const w = Math.max(320, Math.round(opt.w));
  const h = Math.max(240, Math.round(opt.h));
  const x0 = LEFT;
  const x1 = Math.max(x0 + 16, w - RIGHT);
  const span = Math.max(1e-6, map.windowEnd - map.windowStart);
  const xOf = (t: number): number => x0 + ((t - map.windowStart) / span) * (x1 - x0);

  const laneSpace = Math.max(120, h - TOP - BOTTOM);
  const wSum = LANE_WEIGHTS.reduce((a, b) => a + b, 0);
  const heights = LANE_WEIGHTS.map((v) => (v / wSum) * laneSpace);
  const laneY: number[] = [];
  let cursor = TOP;
  for (const lh of heights) {
    laneY.push(cursor);
    cursor += lh;
  }

  const rect = (y: number, height: number): MapRect => ({ x: x0, y, w: x1 - x0, h: height });
  const lanes = {
    rms: rect(laneY[0]!, heights[0]!),
    bands: rect(laneY[1]!, heights[1]!),
    onset: rect(laneY[2]!, heights[2]!),
    novelty: rect(laneY[3]!, heights[3]!),
  };
  const noveltyThresholdY =
    lanes.novelty.y + lanes.novelty.h * (1 - NOVELTY_THRESHOLD);

  const sections: MapRect[] = map.sections.map((s) => {
    const x = clamp(xOf(s.start), x0, x1);
    const right = clamp(xOf(s.end), x0, x1);
    return { x, y: 40, w: Math.max(1, right - x), h: 44 };
  });

  const drops: MapRect[] = map.drops.map((d) => {
    const x = clamp(xOf(d.start), x0, x1);
    return { x, y: 40, w: 3, h: 44 };
  });

  // 小节列：按**时长**分配（首小节可能被窗口截断，按序号等分会把它拉宽）。
  const barX: number[] = [];
  const barW: number[] = [];
  const totalDur = map.bars.reduce((a, b) => a + Math.max(0, b.duration), 0);
  if (totalDur > 1e-9) {
    let acc = 0;
    for (const b of map.bars) {
      const d = Math.max(0, b.duration);
      barX.push(x0 + (acc / totalDur) * (x1 - x0));
      barW.push((d / totalDur) * (x1 - x0));
      acc += d;
    }
  }

  let rmsMax = 0;
  for (const b of map.bars) if (b.rms > rmsMax) rmsMax = b.rms;
  /*
   * 定标用 **p90** 而不是最大值：一个爆音就把其余小节压成贴底的一条线，而那正是
   * 读者最需要看清的部分（副歌前的克制）。超出 p90 的值被钳到顶，形状略被压平，
   * 但整体可读性明显更好。
   */
  const rmsScale = Math.max(1e-6, percentile(map.bars.map((b) => b.rms), 0.9), rmsMax * 0.35);
  const onsetScale = Math.max(0.5, percentile(map.bars.map((b) => b.onsetDensity), 0.9));

  return {
    w,
    h,
    x0,
    x1,
    title: { x: x0, y: 8, w: x1 - x0, h: 26 },
    ribbon: rect(40, 44),
    ruler: rect(84, 16),
    lanes,
    timeAxis: rect(h - BOTTOM + 4, BOTTOM - 8),
    sections,
    drops,
    barX,
    barW,
    rmsScale,
    onsetScale,
    playheadX: typeof opt.t === 'number' && Number.isFinite(opt.t) ? clamp(xOf(opt.t), x0, x1) : null,
    noveltyThresholdY,
    windowStart: map.windowStart,
    windowEnd: map.windowEnd,
  };
}

export function drawMusicMap(
  ctx: CanvasRenderingContext2D,
  map: MusicMap,
  layout: MusicMapLayout,
): void {
  const { x0, x1, w, h } = layout;
  ctx.save();
  ctx.fillStyle = MAP_COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  drawTitle(ctx, map, layout);
  drawLaneFrames(ctx, layout);
  drawRuler(ctx, map, layout);
  drawRibbon(ctx, map, layout, x0, x1);
  drawRms(ctx, map, layout);
  drawBands(ctx, map, layout);
  drawOnsets(ctx, map, layout);
  drawNovelty(ctx, map, layout);
  drawBoundaries(ctx, map, layout);
  drawTimeAxis(ctx, map, layout);
  drawPlayhead(ctx, layout);

  ctx.restore();
}

/* ------------------------------------------------------------------ 分段绘制 */

function drawTitle(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const { title } = layout;
  ctx.fillStyle = MAP_COLORS.text;
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const barCount = map.bars.length;
  const dur = Math.max(0, map.windowEnd - map.windowStart);
  const line =
    `${round(map.bpm)} BPM · ${map.beatsPerBar}/4 · ${barCount} bars · ` +
    `${mmss(dur)} · ${map.sections.length} sections`;
  ctx.fillText(line, title.x, title.y + title.h / 2);
}

function drawLaneFrames(ctx: CanvasRenderingContext2D, layout: MusicMapLayout): void {
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  // 绝对量级写在泳道名旁边：按窗口最大值归一之后，只靠形状读不出「有多响」。
  const labels: [keyof MusicMapLayout['lanes'], string][] = [
    ['rms', `RMS ${fmtScale(layout.rmsScale)}`],
    ['bands', 'BANDS'],
    ['onset', `ONSET ${fmtScale(layout.onsetScale)}`],
    ['novelty', 'NOVELTY'],
  ];
  for (const [key, text] of labels) {
    const lane = layout.lanes[key];
    ctx.fillStyle = MAP_COLORS.muted;
    ctx.fillText(text, layout.x0 - 6, lane.y + 1);
    ctx.strokeStyle = MAP_COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lane.x, lane.y + 0.5);
    ctx.lineTo(lane.x + lane.w, lane.y + 0.5);
    ctx.stroke();
  }
  ctx.textAlign = 'left';
}

function drawRuler(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const bars = map.bars;
  if (bars.length === 0) return;
  const { ruler } = layout;
  const barPx = ruler.w / bars.length;
  // 标签间距：从 1 起逐级翻倍，直到放得下。
  let step = 1;
  while (step * barPx < 34 && step < 64) step *= 2;

  ctx.strokeStyle = MAP_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < bars.length; i += 1) {
    const x = Math.round(layout.barX[i] ?? ruler.x);
    const y0 = i % step === 0 ? ruler.y : ruler.y + ruler.h / 2;
    ctx.moveTo(x + 0.5, y0);
    ctx.lineTo(x + 0.5, ruler.y + ruler.h);
  }
  ctx.stroke();

  ctx.fillStyle = MAP_COLORS.muted;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  for (let i = 0; i < bars.length; i += step) {
    ctx.fillText(String(bars[i]!.bar), (layout.barX[i] ?? ruler.x) + 2, ruler.y);
  }
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  map: MusicMap,
  layout: MusicMapLayout,
  x0: number,
  x1: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, layout.ribbon.y, x1 - x0, layout.ribbon.h);
  ctx.clip();

  map.sections.forEach((s, i) => {
    const box = layout.sections[i]!;
    ctx.fillStyle = MAP_COLORS.sections[s.cluster % MAP_COLORS.sections.length]!;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = MAP_COLORS.bg;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(0, box.w - 1), box.h - 1);

    if (box.w >= 18) {
      ctx.fillStyle = MAP_COLORS.text;
      ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(s.letter, box.x + 4, box.y + 3);
    }
    if (box.w >= 30) {
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(s.energy.toFixed(1), box.x + 4, box.y + 20);
    }
    if (box.w >= 46) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(s.roleHint === 'section' ? `${s.bars}b` : `${s.roleHint}`, box.x + 4, box.y + 32);
    }
  });

  // drop 顶条画在色带之上：它是「整首曲子里最该被看见的三四个点」。
  for (const d of layout.drops) {
    ctx.fillStyle = MAP_COLORS.drop;
    ctx.fillRect(d.x, d.y, d.w, d.h);
  }
  ctx.restore();
}

function drawRms(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const lane = layout.lanes.rms;
  if (map.bars.length === 0) return;
  const base = lane.y + lane.h;
  ctx.beginPath();
  ctx.moveTo(layout.x0, base);
  map.bars.forEach((b, i) => {
    const x = layout.barX[i] ?? lane.x;
    const next = x + (layout.barW[i] ?? 1);
    const y = base - clamp01(b.rms / layout.rmsScale) * lane.h;
    ctx.lineTo(x, y);
    ctx.lineTo(Math.max(x + 0.5, next), y);
  });
  ctx.lineTo(lane.x + lane.w, base);
  ctx.closePath();
  ctx.fillStyle = 'rgba(124,200,255,0.35)';
  ctx.fill();
  ctx.strokeStyle = MAP_COLORS.rms;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawBands(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const lane = layout.lanes.bands;
  if (map.bars.length === 0) return;
  const keys = ['sub', 'bass', 'mid', 'high', 'air'] as const;
  map.bars.forEach((b, i) => {
    const x = layout.barX[i] ?? lane.x;
    const next = x + (layout.barW[i] ?? 1);
    const width = Math.max(0.5, next - x);
    let cursor = lane.y + lane.h;
    keys.forEach((k, ki) => {
      const share = clamp01(b.band[k]);
      const hh = share * lane.h;
      if (hh <= 0) return;
      cursor -= hh;
      ctx.fillStyle = MAP_COLORS.bands[ki]!;
      ctx.fillRect(x, cursor, width, hh);
    });
  });
}

function drawOnsets(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const lane = layout.lanes.onset;
  if (map.bars.length === 0) return;
  const base = lane.y + lane.h;
  ctx.fillStyle = MAP_COLORS.onset;
  map.bars.forEach((b, i) => {
    const x = layout.barX[i] ?? lane.x;
    const next = x + (layout.barW[i] ?? 1);
    const width = Math.max(1, Math.min(6, next - x - 1));
    const hh = Math.min(1, b.onsetDensity / layout.onsetScale) * lane.h;
    if (hh <= 0) return;
    ctx.fillRect(x + 1, base - hh, width, hh);
  });
}

function drawNovelty(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const lane = layout.lanes.novelty;
  if (map.bars.length === 0) return;
  const yOf = (v: number): number => lane.y + lane.h * (1 - clamp01(v));

  ctx.beginPath();
  ctx.moveTo(layout.x0, lane.y + lane.h);
  map.bars.forEach((b, i) => {
    const x = layout.barX[i] ?? lane.x;
    const next = x + (layout.barW[i] ?? 1);
    ctx.lineTo(x, yOf(b.novelty));
    ctx.lineTo(Math.max(x + 0.5, next), yOf(b.novelty));
  });
  ctx.lineTo(lane.x + lane.w, lane.y + lane.h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,122,217,0.22)';
  ctx.fill();
  ctx.strokeStyle = MAP_COLORS.novelty;
  ctx.lineWidth = 1;
  ctx.stroke();

  // 判据线：过线的峰才是被采用的边界。
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(lane.x, layout.noveltyThresholdY + 0.5);
  ctx.lineTo(lane.x + lane.w, layout.noveltyThresholdY + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBoundaries(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  if (map.sections.length <= 1) return;
  const top = layout.ribbon.y;
  const bottom = layout.lanes.novelty.y + layout.lanes.novelty.h;
  ctx.strokeStyle = MAP_COLORS.boundary;
  ctx.lineWidth = 1;
  for (let i = 1; i < layout.sections.length; i += 1) {
    const x = Math.round(layout.sections[i]!.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
}

function drawTimeAxis(ctx: CanvasRenderingContext2D, map: MusicMap, layout: MusicMapLayout): void {
  const axis = layout.timeAxis;
  const span = Math.max(1e-6, map.windowEnd - map.windowStart);
  const pxPerSec = (layout.x1 - layout.x0) / span;
  const steps = [5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pxPerSec >= 70) ?? 600;

  ctx.fillStyle = MAP_COLORS.muted;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  const first = Math.ceil(map.windowStart / step) * step;
  for (let t = first; t <= map.windowEnd + 1e-6; t += step) {
    const x = layout.x0 + ((t - map.windowStart) / span) * (layout.x1 - layout.x0);
    ctx.strokeStyle = MAP_COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, axis.y - 4);
    ctx.lineTo(Math.round(x) + 0.5, axis.y + 2);
    ctx.stroke();
    ctx.fillText(mmss(t), x + 3, axis.y + 3);
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D, layout: MusicMapLayout): void {
  const x = layout.playheadX;
  if (x === null) return;
  ctx.strokeStyle = MAP_COLORS.playhead;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, layout.ribbon.y);
  ctx.lineTo(Math.round(x) + 0.5, layout.lanes.novelty.y + layout.lanes.novelty.h);
  ctx.stroke();
}

/* ------------------------------------------------------------------ 小工具 */

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 泳道刻度的显示：小量给两位，大量给一位（`RMS .21` / `ONSET 4.0`）。 */
function fmtScale(v: number): string {
  return v >= 1 ? v.toFixed(1) : v.toFixed(2);
}

/** 分位数，`p ∈ [0,1]`，取 `round(p·(n-1))` 处的值（不改动入参）。 */
function percentile(values: readonly number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))]!;
}

/** 秒 → `m:ss`。负数与非法值给 `0:00`。 */
function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
