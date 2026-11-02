<script lang="ts">
  /**
   * Scopes — 调色面板的示波器区（波形 / 分量 / 矢量 / 直方图）。
   *
   * 数据来自合成之后的探针（`compositor.captureScope`），**只在面板可见时**才采，
   * 而且限帧 10Hz。UI 自己按 100ms 的节奏取最新一帧重画 —— 逐帧拉只会让
   * Canvas2D 成为这个面板的开销主体，而示波器的读数是给人看的统计。
   *
   * 口径是**编码值**：直接读回 sRGB 字节，不做线性换算。示波器的意义在于和
   * 画面一致，不在于和别的软件一致。
   */
  import { onMount } from 'svelte';
  import { tr } from '../../i18n/index.svelte';
  import { appState } from '../app-state.svelte';
  import {
    renderHistogram,
    renderParade,
    renderVectorscope,
    renderWaveform,
    type ScopeMode,
  } from './scope-draw';

  const W = 256;
  const H = 144;

  interface Props {
    /**
     * 让波形屏**吃满容器高度**（右栏码头用）。
     *
     * 默认按 16:9 定高：在底部一横条里，16:9 是唯一不会把画面挤走的比例。
     * 但竖着的码头里 16:9 会留一大片空白，而波形是按列统计的 —— 高度越多，
     * 越能读出暗部层次。
     */
    fill?: boolean;
  }
  const { fill = false }: Props = $props();

  const MODES: { id: ScopeMode; labelKey: Parameters<typeof tr>[0] }[] = [
    { id: 'waveform', labelKey: 'grade.scopeWaveform' },
    { id: 'parade', labelKey: 'grade.scopeParade' },
    { id: 'vector', labelKey: 'grade.scopeVector' },
    { id: 'histogram', labelKey: 'grade.scopeHistogram' },
  ];

  /** 三种视图各自的线条色（数据可视化，不跟主题走 —— 跟随会让通道含义丢失）。 */
  const TRACE = { r: 'hsl(0 62% 60%)', g: 'hsl(140 45% 55%)', b: 'hsl(215 68% 65%)', l: 'hsl(0 0% 82%)' };

  let mode = $state<ScopeMode>('waveform');
  let canvas: HTMLCanvasElement | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  let empty = $state(true);

  function paint(): void {
    const cv = canvas;
    if (!cv) return;
    /*
     * `willReadFrequently`：这一页每 100ms 就要 `getImageData` 一次，
     * 不声明的话浏览器会把画布放在 GPU 侧回读（控制台里有性能警告）。
     */
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0)';

    const frame = appState.renderer?.scopeFrame() ?? null;
    empty = !frame;
    if (!frame) return;

    // 网格：0 / 25 / 50 / 75 / 100 IRE 的水平线（编码口径）
    g.strokeStyle = 'rgba(128,128,128,0.35)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = Math.round((i / 4) * (H - 1)) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }

    if (mode === 'vector') {
      // 先画刻度：十字 + 两道同心环 + 六个主色目标（与矢量示波器的常见读法一致）。
      drawVectorGraticule(g);
      drawDensity(g, renderVectorscope(frame, H), H, H, 0, 0, 'hsl(120 55% 65%)');
      return;
    }
    if (mode === 'histogram') {
      const h = renderHistogram(frame);
      drawSeries(g, h.l, TRACE.l);
      drawSeries(g, h.r, TRACE.r);
      drawSeries(g, h.g, TRACE.g);
      drawSeries(g, h.b, TRACE.b);
      return;
    }
    if (mode === 'parade') {
      const p = renderParade(frame, W, H);
      // 三条波形画在**同一张** ImageData 上：分别 getImageData/putImageData 会互相覆盖。
      drawDensityLayers(g, [
        { grid: p.r, color: TRACE.r },
        { grid: p.g, color: TRACE.g },
        { grid: p.b, color: TRACE.b },
      ], W, H);
      return;
    }
    drawDensity(g, renderWaveform(frame, W, H), W, H, 0, 0, TRACE.l);
  }

  /**
   * 矢量示波器的刻度。
   *
   * 只画「读图必需」的三样：原点十字（区分灰轴）、两道环（饱和度参考）、
   * 六个主色方向（判断偏色朝哪边推）。刻度是**中性灰**，不抢数据的颜色。
   */
  function drawVectorGraticule(g: CanvasRenderingContext2D): void {
    const size = H;
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    // 与 `renderVectorscope` 的 scale 一致：±0.6 占满
    const scale = (size - 1) / 1.2;
    g.save();
    g.translate((W - size) / 2, 0);
    g.strokeStyle = 'rgba(140,140,140,0.45)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, 0);
    g.lineTo(cx, size);
    g.moveTo(0, cy);
    g.lineTo(size, cy);
    g.stroke();
    for (const r of [0.25, 0.5]) {
      g.beginPath();
      g.arc(cx, cy, r * scale, 0, Math.PI * 2);
      g.stroke();
    }
    // 六个主色：红/黄/绿/青/蓝/品红，按 601 的 Cb/Cr 方向摆
    const targets: [number, number][] = [
      [-0.169, 0.5], // R
      [0.0, 0.5], // Y（Cb≈0，Cr≈0.5 的简化位置）
      [0.5, 0.0], // G
      [0.5, -0.5], // C
      [-0.5, 0.0], // B
      [0.0, -0.5], // M
    ];
    g.fillStyle = 'rgba(140,140,140,0.55)';
    for (const [cb, cr] of targets) {
      g.fillRect(cx + cb * scale - 1, cy - cr * scale - 1, 2, 2);
    }
    g.restore();
  }

  /** 多层密度：一次读、一次写，各层按自己的颜色混上去。 */
  function drawDensityLayers(
    g: CanvasRenderingContext2D,
    layers: { grid: Float32Array; color: string }[],
    gw: number,
    gh: number,
  ): void {
    const img = g.getImageData(0, 0, W, H);
    for (const layer of layers) {
      const rgb = parseColor(layer.color);
      for (let y = 0; y < gh; y += 1) {
        for (let x = 0; x < gw; x += 1) {
          const d = layer.grid[y * gw + x] ?? 0;
          if (d <= 0.02) continue;
          const i = (y * W + x) * 4;
          // 1.5 倍：极稀的格点（一列里只有几个像素经过）也要看得见，
          // 否则「画面偏暗」时整条波形会消失，看起来像没数据。
          const a = Math.min(1, Math.sqrt(d) * 1.5);
          img.data[i] = rgb[0] + (img.data[i]! - rgb[0]) * (1 - a);
          img.data[i + 1] = rgb[1] + (img.data[i + 1]! - rgb[1]) * (1 - a);
          img.data[i + 2] = rgb[2] + (img.data[i + 2]! - rgb[2]) * (1 - a);
          img.data[i + 3] = Math.max(img.data[i + 3]!, Math.round(255 * a));
        }
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** 密度网格 → 逐像素 alpha（亮度就是密度）。 */
  function drawDensity(
    g: CanvasRenderingContext2D,
    grid: Float32Array,
    gw: number,
    gh: number,
    ox: number,
    oy: number,
    color: string,
  ): void {
    const img = g.getImageData(0, 0, W, H);
    const rgb = parseColor(color);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        const d = grid[y * gw + x] ?? 0;
        if (d <= 0.06) continue;
        const px = ox + x;
        const py = oy + y;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const i = (py * W + px) * 4;
        // 平方根压缩：1 个像素的痕迹也要看得见，但满密度不许糊成一片
        const a = Math.min(1, Math.sqrt(d) * 1.5);
        img.data[i] = rgb[0] + (img.data[i]! - rgb[0]) * (1 - a);
        img.data[i + 1] = rgb[1] + (img.data[i + 1]! - rgb[1]) * (1 - a);
        img.data[i + 2] = rgb[2] + (img.data[i + 2]! - rgb[2]) * (1 - a);
        img.data[i + 3] = Math.max(img.data[i + 3]!, Math.round(255 * a));
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** 直方图折线。x 是 256 桶，y 是归一后的计数。 */
  function drawSeries(g: CanvasRenderingContext2D, series: Float32Array, color: string): void {
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < series.length; i += 1) {
      const x = (i / (series.length - 1)) * (W - 1);
      const y = (1 - series[i]!) * (H - 1);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  /** `hsl(...)` → [r,g,b]。用一次性 canvas 解析，免得手写 HSL 转换。 */
  const colorCache = new Map<string, [number, number, number]>();
  function parseColor(css: string): [number, number, number] {
    const hit = colorCache.get(css);
    if (hit) return hit;
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    let out: [number, number, number] = [255, 255, 255];
    if (g) {
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      out = [d[0]!, d[1]!, d[2]!];
    }
    colorCache.set(css, out);
    return out;
  }

  onMount(() => {
    appState.renderer?.setScopeProbe(true);
    // 100ms ≈ 10Hz：与探针的采集节奏同一档，拉得更勤只会重画同一帧。
    timer = setInterval(paint, 100);
    paint();
    return () => {
      if (timer) clearInterval(timer);
      appState.renderer?.setScopeProbe(false);
    };
  });

  // 切视图立刻重画，不等下一个 100ms 节拍。
  $effect(() => {
    void mode;
    paint();
  });
</script>

<div class="sc" class:sc-fill={fill}>
  <div class="sc-tabs" role="tablist" aria-label={tr('grade.colScopes')}>
    {#each MODES as m (m.id)}
      <button
        class="sc-tab"
        class:on={mode === m.id}
        type="button"
        role="tab"
        aria-selected={mode === m.id}
        data-testid={`grade-scope-${m.id}`}
        onclick={() => (mode = m.id)}
      >
        {tr(m.labelKey)}
      </button>
    {/each}
  </div>
  <div class="sc-stage">
    <canvas width={W} height={H} bind:this={canvas} data-testid="grade-scope-canvas"></canvas>
    {#if empty}
      <span class="sc-empty">{tr('grade.scopeEmpty')}</span>
    {/if}
  </div>
  <span class="sc-unit">{tr('grade.scopeEncoded')}</span>
</div>

<style>
  .sc {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-height: 0;
  }
  .sc-tabs {
    display: flex;
    gap: var(--sp-1);
  }
  .sc-tab {
    height: var(--control-h-sm);
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .sc-tab:hover {
    color: var(--text-secondary);
  }
  .sc-tab.on {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
  /*
   * 示波器的屏是**内容**，不是 chrome：波形是浅色细线，必须在深底上才读得出
   * 密度层次。跟随主题的话，浅色主题下整张图会白成一片（线还在，只是看不见）。
   */
  .sc-stage {
    position: relative;
    background: #0a0b0d;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    aspect-ratio: 16 / 9;
    overflow: hidden;
  }
  /* 码头里：不再按比例，改成吃掉剩余高度（其余元素都 `flex: none`）。 */
  .sc.sc-fill {
    height: 100%;
  }
  .sc.sc-fill .sc-stage {
    flex: 1;
    min-height: 0;
    aspect-ratio: auto;
  }
  .sc-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .sc-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .sc-unit {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
