/**
 * grid-draw.ts — Canvas2D 标尺 / 网格 / 波形绘制。
 *
 * 网格间距与吸附步长同源：都读 core/time.ts 的 SNAP_MODES 步长。
 * 波形画在网格 canvas 的音频轨行区域里，片段 DOM 之上是透明的。
 *
 * **颜色全部来自 palette 参数**（`ui/tokens.ts` 的 `canvasPalette(spec)`）。
 * 这里曾经内联着一份与 CSS 变量同值的调色板副本——Canvas 写不了 `var(--x)`，
 * 于是改一次配色要改两处，改漏就是「面板变了、网格没变」的偏色。现在传参进来，
 * 物理上不可能不同步。
 *
 * ---------------------------------------------------------------------------
 * 【坐标系：content / canvas 两套，别混】
 *
 *   content  —— 工程时间轴自己的坐标，x = 0 是工程起点，右端是工程末尾。
 *   canvas   —— 画布位图自己的坐标，x = 0 是位图左边缘。
 *
 * 两者差一个 `origin`：`canvasX = contentX - origin`。
 * `view` 一律用 **content 坐标**传进来（调用方在工程空间里想事情更自然），
 * 本文件负责减掉 origin。拍号 x 的换算也按 content 走：
 * `contentX(b) = xOfTime(offset + b * beatDur)`。
 *
 * ⚠️ **offset 必须计入**。拍是「offset 之后」才开始数的（ADR-002），吸附也按这个
 * 定义（`beatAtTime`）。标尺曾经画在 `b * pxPerBeat`，offset ≠ 0 时线在第 0 拍、
 * 吸附却对齐到 offset 之后的拍 —— 表现是「播放头永远压不上刻度」，看起来像渲染
 * 错位，其实是两处各写了一份换算。现在统一走 `view-model.ts::xOfBeat`。
 *
 * ---------------------------------------------------------------------------
 * 【两条不变式】(2026-10-02)
 *
 * **① 单次绘制的工作量只与 `view.x1 - view.x0` 有关，与工程时长无关。**
 *   实测：315s 音频工程宽 17650 CSS px，波形按「每像素一个子路径、最后一次性
 *   stroke」画出来，`FinalizeFrame` 要 **1096ms**；同一块画布把波形摘掉只剩 8.4ms。
 *   成本随像素跨度超线性增长（1120px→12ms，4480px→140ms，17650px→618ms）。
 *   所以绘制一律 `clip` 到 `view`，拍线只从可见区左端起头。
 *
 * **② 位图面积只与视口有关，与工程时长和缩放都无关。**
 *   画布**只覆盖 `[origin, origin + canvasW)` 这一段**（调用方给它一块跟着视口走的
 *   窗口，见 `Timeline.svelte` 的 `windowFor`），不是整幅工程宽。
 *   为什么必须这样：整幅宽时内存 = 时长 × 缩放 × 轨道数 × dpr²，无上界——
 *   实测 950s@96px/beat 是 219MB，3000s@96px/beat 是 692MB，再往上会撞浏览器
 *   的 canvas 面积上限（实测 2^28 px），而**超限时 `canvas.width = …` 是静默失败的**，
 *   留下「位图宽 ≠ style.width」的错位、整幅画面被压扁。
 *   改成窗口后是常数（3 个视口宽 ≈ 4MB @dpr1.5 / 5 轨）。
 *
 * 契约：调用方负责
 *   1. 传 `canvasW` = 窗口宽、`origin` = 窗口左端的内容坐标；
 *   2. `view` 完整落在窗口内（否则会画出画布外，看不见）；
 *   3. 本文件返回 `true`（画布尺寸变了）时把自己记的「已绘制区间」作废
 *      —— `canvas.width = …` 会把整块位图清空。
 */

import { beatAtTime, beatDur, timeAtBeat, type BeatGrid } from '../core/time';
import type { Project } from '../core/schema';
import type { WaveformData } from '../audio/decode';
import { FONT_MONO, type CanvasPalette } from '../ui/tokens';
import { xOfBeat, xOfTime, RULER_HEIGHT, ROW_HEIGHT, type TimelineMode } from './view-model';

/** 本次要覆盖的区间（**content 坐标**，CSS px）。 */
export interface DrawRange {
  x0: number;
  x1: number;
}

/**
 * 按需改画布尺寸。**只在真的不一样时才写**——`canvas.width = …` 会重建整块
 * 位图（分配 + 清零），无谓地写一次就是一次可见卡顿。
 *
 * 比较必须用 `Math.round`：`canvas.width` 是整数，而 `w * dpr` 在 dpr=1.5
 * 遇到奇数 w 时是 `.5` 结尾，直接比较会**永远不等**，于是每次重绘都重建位图。
 */
function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): boolean {
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width === pw && canvas.height === ph) return false;
  canvas.width = pw;
  canvas.height = ph;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return true;
}

/** 把绘制裁到 content 区间 `[cx0, cx1)` 对应的画布区域。 */
function clipTo(
  ctx: CanvasRenderingContext2D,
  cx0: number,
  cx1: number,
  origin: number,
  h: number,
): void {
  ctx.beginPath();
  ctx.rect(cx0 - origin, 0, cx1 - cx0, h);
  ctx.clip();
}

/**
 * 可见区间内第一根拍线的拍号（content 坐标里第一根 ≥ cx0 的线）。
 *
 * `offsetPx` 是第 0 拍的 content x（offset 秒的位置）：拍线在
 * `offsetPx + b * pxPerBeat`，所以反解时要先减掉它。不传就会在 offset ≠ 0
 * 时把起点算偏一整段（可见区左边少画几根线，或者从负拍开始画）。
 */
function firstBeatIn(
  cx0: number,
  pxPerBeat: number,
  stepBeats: number,
  offsetPx: number,
): number {
  return Math.max(0, Math.floor((cx0 - offsetPx) / pxPerBeat / stepBeats) * stepBeats);
}

/** 拍线密度：缩得太小时只画 2/4/8 拍一格。ruler 的阈值更宽（44px），网格更密（22px）。 */
function beatStep(pxPerBeat: number, minPx: number): number {
  let s = 1;
  while (pxPerBeat * s < minPx) s *= 2;
  return s;
}

/**
 * 标准模式的刻度文案：`mm:ss.ff`（分:秒.帧）。
 *
 * 帧是**工程帧率**下的帧（`project.fps`），不是屏幕刷新 —— 与导出帧号同一个
 * 定义域，于是「标尺上写着 00:04.12」用 `frameAtTime` 换算出来就是第 132 帧。
 * 非整数帧率（29.97）下取 `floor`，只影响小数位，不影响定位。
 */
function timecode(t: number, fps: number): string {
  const rate = Math.max(1, fps);
  const whole = Math.max(0, Math.floor(t));
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  const ff = Math.min(99, Math.floor((t - whole) * rate + 1e-6));
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
}

/**
 * 某根拍线的刻度文案。**纯函数**（有单测）：它同时是「形态切换到底改了什么」
 * 唯一可以直接断言的产物 —— 标尺是 canvas，测试读不到文字。
 *
 * 节奏模式：`小节.拍`，都从 1 数起（音乐人的读法，不是程序员的下标）。
 * 标准模式：`分:秒.帧`，时间走 `timeAtBeat`（**offset 计入**，否则读数是错的）。
 */
export function rulerLabelAt(
  beat: number,
  grid: BeatGrid,
  fps: number,
  mode: TimelineMode,
): string {
  if (mode === 'standard') return timecode(timeAtBeat(beat, grid), fps);
  const bpb = Math.max(1, Math.floor(grid.beatsPerBar));
  const b = Math.max(0, Math.round(beat));
  return `${Math.floor(b / bpb) + 1}.${(b % bpb) + 1}`;
}

export function drawRuler(
  canvas: HTMLCanvasElement,
  project: Project,
  pxPerBeat: number,
  dpr: number,
  palette: CanvasPalette,
  /** 画布（窗口）宽。**不是工程宽** —— 见文件头的第二条不变式。 */
  canvasW: number,
  /** 画布左端对应的内容坐标。`canvasX = contentX - origin`。 */
  origin: number,
  view: DrawRange,
  /**
   * 时间轴形态：只改**刻度文案**（`3.2` 小节.拍 / `00:04.12` 分:秒.帧）与
   * 刻度的抽稀间距。拍线位置、缩放、吸附步长都不归它管。
   */
  mode: TimelineMode,
): boolean {
  const g = project.beatGrid;
  const resized = sizeCanvas(canvas, canvasW, RULER_HEIGHT, dpr);

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const x0 = Math.max(origin, Math.floor(view.x0));
  const x1 = Math.min(origin + canvasW, Math.ceil(view.x1));
  if (x1 <= x0) return resized;

  ctx.save();
  clipTo(ctx, x0, x1, origin, RULER_HEIGHT);
  const px0 = x0 - origin;
  ctx.clearRect(px0, 0, x1 - x0, RULER_HEIGHT);
  ctx.fillStyle = palette.rulerBg;
  ctx.fillRect(px0, 0, x1 - x0, RULER_HEIGHT);

  const bpb = g.beatsPerBar;
  /*
   * 刻度间距 = 文案需要的宽度。标准模式的时间码（`00:04.12`，8 个等宽字符）
   * 比小节的 `3.2` 宽一倍多，用同一个 44px 阈值会让相邻两个标签叠在一起。
   *
   * 两个阈值是按 10px 等宽（0.6em/字符）量出来的。换字体栈时要重新量一次：
   * 字宽变了而阈值不变，表现是标签互相叠字。
   */
  const stepBeats = beatStep(pxPerBeat, mode === 'standard' ? 84 : 44);
  /** 缩得太小时只在**小节线**上写字；否则每根画出来的刻度都标。 */
  const labelEvery = stepBeats < bpb;

  // 字体只能从 tokens 取：ctx.font 写不了 var(--font-mono)。
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  const offsetPx = xOfBeat(0, pxPerBeat, g);
  const lastBeat = Math.max(0, Math.ceil(beatAtTime(project.duration, g)));

  // 只从可见区间左端起头，不再从 0 一路画到工程末尾
  for (let b = firstBeatIn(x0, pxPerBeat, stepBeats, offsetPx); b <= lastBeat; b += stepBeats) {
    const t = timeAtBeat(b, g);
    if (t > project.duration) break;
    const bx = offsetPx + b * pxPerBeat;
    if (bx > x1) break;
    const x = Math.round(bx - origin) + 0.5;
    const isBar = b % bpb === 0;
    ctx.strokeStyle = isBar ? palette.barLine : palette.beatLine;
    ctx.beginPath();
    ctx.moveTo(x, isBar ? 6 : 16);
    ctx.lineTo(x, RULER_HEIGHT);
    ctx.stroke();
    if (isBar || labelEvery) {
      ctx.fillStyle = palette.rulerText;
      ctx.fillText(rulerLabelAt(b, g, project.fps, mode), x + 4, 4);
    }
  }

  // 工程起点（t=0 可能在第 0 拍之后，如果 offset<0）
  const originLine = Math.round(xOfTime(0, pxPerBeat, g) - origin) + 0.5;
  if (originLine >= px0 - 1 && originLine <= x1 - origin + 1) {
    ctx.strokeStyle = palette.originLine;
    ctx.beginPath();
    ctx.moveTo(originLine, 0);
    ctx.lineTo(originLine, RULER_HEIGHT);
    ctx.stroke();
  }
  ctx.restore();
  return resized;
}

export interface GridTrackRow {
  kind: 'visual' | 'audio';
  /**
   * 音频轨要画的片段（资产 → 波形）。
   *
   * `fadeIn` / `fadeOut` 只用来把淡变区压暗 —— **包络求值不在这里**
   * （`core/audio-envelope.ts` 是唯一真源），这里画的只是「结果会长这样」。
   */
  waveClips: {
    start: number;
    end: number;
    srcIn: number;
    assetId: string;
    fadeIn?: number;
    fadeOut?: number;
  }[];
}

export function drawGrid(
  canvas: HTMLCanvasElement,
  project: Project,
  pxPerBeat: number,
  rows: GridTrackRow[],
  waveforms: Record<string, WaveformData>,
  dpr: number,
  palette: CanvasPalette,
  /** 同 drawRuler：窗口宽，不是工程宽。 */
  canvasW: number,
  /** 同 drawRuler：画布左端的内容坐标。 */
  origin: number,
  view: DrawRange,
): boolean {
  const g = project.beatGrid;
  const h = rows.length * ROW_HEIGHT;
  const resized = sizeCanvas(canvas, canvasW, h, dpr);

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const x0 = Math.max(origin, Math.floor(view.x0));
  const x1 = Math.min(origin + canvasW, Math.ceil(view.x1));
  if (x1 <= x0) return resized;

  ctx.save();
  clipTo(ctx, x0, x1, origin, h);
  const px0 = x0 - origin;
  ctx.clearRect(px0, 0, x1 - x0, h);
  ctx.fillStyle = palette.gridBg;
  ctx.fillRect(px0, 0, x1 - x0, h);

  // 行底色与分隔线
  rows.forEach((row, i) => {
    const y = i * ROW_HEIGHT;
    ctx.fillStyle = row.kind === 'audio' ? palette.rowAudio : palette.rowVisual;
    ctx.fillRect(px0, y, x1 - x0, ROW_HEIGHT);
    ctx.strokeStyle = palette.rowLine;
    ctx.beginPath();
    ctx.moveTo(px0, y + ROW_HEIGHT - 0.5);
    ctx.lineTo(px0 + (x1 - x0), y + ROW_HEIGHT - 0.5);
    ctx.stroke();
  });

  // 波形（画在拍线之前，线叠在上面便于读格）
  drawWaveforms(
    ctx,
    rows,
    waveforms,
    pxPerBeat,
    g,
    pxPerBeat / beatDur(g),
    palette,
    origin,
    x0,
    x1,
  );

  // 拍线
  const bpb = g.beatsPerBar;
  const stepBeats = beatStep(pxPerBeat, 22);
  const offsetPx = xOfBeat(0, pxPerBeat, g);
  const lastBeat = Math.max(0, Math.ceil(beatAtTime(project.duration, g)));

  for (let b = firstBeatIn(x0, pxPerBeat, stepBeats, offsetPx); b <= lastBeat; b += stepBeats) {
    const t = timeAtBeat(b, g);
    if (t > project.duration) break;
    const bx = offsetPx + b * pxPerBeat;
    if (bx > x1) break;
    const x = Math.round(bx - origin) + 0.5;
    ctx.strokeStyle = b % bpb === 0 ? palette.barLine : palette.beatLine;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  ctx.restore();
  return resized;
}

/**
 * 波形：**每像素一个 min→max 竖条**，但不再是「每像素一个子路径 + 一次性 stroke」。
 *
 * 实测（同一台机器，含强制光栅化）：
 *   每像素子路径 + 单次 stroke   17650px → 618ms
 *   逐像素独立 stroke（子路径更小）17650px →  37ms
 *   单条闭合包络 + fill           17650px →  89ms
 *
 * 所以取闭合包络：一条子路径（max 正向 + min 反向 + closePath），语义与原来
 * 「每像素一根竖线」等价（画出来是同一块 min/max 包络），但子路径数从 N 降到 1，
 * 且 `fill` 的扫描线成本远低于超长子路径的 stroke 三角化。
 *
 * 同一行的多个片段合成**同一条路径**再 fill 一次：多个音频重叠时不会线性叠加
 * 成多次光栅化。
 *
 * `cx0/cx1` 是 content 坐标下的绘制区间，`origin` 用来换算到画布坐标。
 */
function drawWaveforms(
  ctx: CanvasRenderingContext2D,
  rows: GridTrackRow[],
  waveforms: Record<string, WaveformData>,
  pxPerBeat: number,
  g: BeatGrid,
  pxPerSec: number,
  palette: CanvasPalette,
  origin: number,
  cx0: number,
  cx1: number,
): void {
  rows.forEach((row, i) => {
    if (row.kind !== 'audio' || row.waveClips.length === 0) return;
    const yMid = i * ROW_HEIGHT + ROW_HEIGHT / 2;
    const amp = ROW_HEIGHT / 2 - 4;

    // 先铺中心线：静音段也能看出「这里有一个片段」
    ctx.fillStyle = palette.waveCenter;
    for (const clip of row.waveClips) {
      if (!waveforms[clip.assetId]) continue;
      const sx = Math.max(cx0, xOfTime(clip.start, pxPerBeat, g));
      const ex = Math.min(cx1, xOfTime(clip.end, pxPerBeat, g));
      if (ex > sx) ctx.fillRect(sx - origin, yMid, ex - sx, 1);
    }

    ctx.fillStyle = palette.waveBody;
    ctx.beginPath();
    let any = false;
    for (const clip of row.waveClips) {
      const wf = waveforms[clip.assetId];
      if (!wf) continue;
      const cxStart = xOfTime(clip.start, pxPerBeat, g);
      const cxEnd = xOfTime(clip.end, pxPerBeat, g);
      const sx = Math.max(cx0, Math.floor(cxStart));
      const ex = Math.min(cx1, Math.ceil(cxEnd));
      if (ex <= sx) continue;
      const last = wf.length - 1;
      // 桶号按「x 处的片段内时间」取；越界只可能来自边界取整，钳一下即可，
      // 不能 skip —— 留下空洞会把后面 closePath 的多边形拧成自交。
      const bucketAt = (x: number): number => {
        const b = Math.floor((clip.srcIn + (x - cxStart) / pxPerSec) / wf.bucketSec);
        return b < 0 ? 0 : b > last ? last : b;
      };
      for (let x = sx; x < ex; x++) {
        const b = bucketAt(x);
        const y = yMid - wf.buckets[b * 2 + 1]! * amp;
        if (x === sx) ctx.moveTo(x - origin, y);
        else ctx.lineTo(x - origin, y);
      }
      for (let x = ex - 1; x >= sx; x--) {
        const b = bucketAt(x);
        ctx.lineTo(x - origin, yMid - wf.buckets[b * 2]! * amp);
      }
      ctx.closePath();
      any = true;
    }
    if (any) ctx.fill();

    /*
     * 淡变区压暗：用**行底色**盖一层半透明，波形就退到背景里去了。
     * 不逐样本乘系数 —— 包络是逐样本的，而这里只需要「看得出这一段在淡」；
     * 用同一份底色还能保证亮暗主题下都自然（不写死黑色）。
     */
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = palette.rowAudio;
    for (const clip of row.waveClips) {
      const cs = xOfTime(clip.start, pxPerBeat, g);
      const ce = xOfTime(clip.end, pxPerBeat, g);
      const w = Math.max(0, ce - cs);
      let fi = Math.max(0, clip.fadeIn ?? 0) * pxPerSec;
      let fo = Math.max(0, clip.fadeOut ?? 0) * pxPerSec;
      // 与 core/audio-envelope 同一条钳制：两段相交时按比例收缩。
      const sum = fi + fo;
      if (sum > w && sum > 0) {
        const k = w / sum;
        fi *= k;
        fo *= k;
      }
      const y0 = i * ROW_HEIGHT;
      if (fi > 0.5) ctx.fillRect(cs - origin, y0, fi, ROW_HEIGHT);
      if (fo > 0.5) ctx.fillRect(ce - fo - origin, y0, fo, ROW_HEIGHT);
    }
    ctx.restore();
  });
}
