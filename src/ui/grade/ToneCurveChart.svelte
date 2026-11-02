<script lang="ts">
  /**
   * ToneCurveChart — 单通道的色调曲线（主 / R / G / B 各一张）。
   *
   * 四个通道**同时显示**而不是页签切换：调色时最常做的一件事是「提主曲线之后
   * R 偏了」，页签只能一次看一条，来回切两下就忘了上一条长什么样。四张并排
   * 的代价是每张更小，但曲线是**形状**信息，缩小仍然读得出来。
   *
   * ## 坐标系
   *
   * 画出来的是**编码刻度**（用户直觉），存的是**线性值**（shader 的域）。
   * 换算只在 `core/tone-curve.ts` 的 `pointToDisplay` / `pointFromDisplay` 里。
   * 曲线本身也是**采样后画的**：同一份 1024 点表既喂纹理也喂这条 path，
   * 于是「编辑器画的样子」与「画面上的结果」不可能不一致。
   */
  import type { CurvePoint } from '../../core/tone-curve';
  import {
    identityPoints,
    parseToneCurve,
    pointFromDisplay,
    pointToDisplay,
    sampleToneCurve,
    TONE_CURVE_WIDTH,
  } from '../../core/tone-curve';
  import { linearToSrgb } from '../../core/color';
  import { tr } from '../../i18n/index.svelte';
  import Icon from '../Icon.svelte';

  interface Props {
    /** 存下来的曲线串（`core/tone-curve.ts` 的格式，空串 = 恒等）。 */
    value: string;
    /** 图上那条线 / 控制点的颜色（通道语义色，不跟主题）。 */
    color: string;
    label: string;
    testid: string;
    onpoints: (next: CurvePoint[]) => void;
    oncommit: () => void;
  }
  const { value, color, label, testid, onpoints, oncommit }: Props = $props();

  let dragIndex = $state<number | null>(null);

  /*
   * `value` 由父组件从 store 派生（父组件已经 `void appState.version`），
   * 这里只负责解析 —— 不直接读 `inst.values`，于是「谁在响应谁」只有一处。
   */
  const points = $derived<CurvePoint[]>(parseToneCurve(value));
  const dirty = $derived(points.length > 2 || points.some((p) => Math.abs(p.y - p.x) > 1e-4));

  /** 曲线 path：采样 → 转编码坐标 → 翻转成 SVG 的 y。 */
  const path = $derived.by(() => {
    const table = sampleToneCurve(points, TONE_CURVE_WIDTH);
    const step = Math.max(1, Math.floor(TONE_CURVE_WIDTH / 96));
    const parts: string[] = [];
    for (let i = 0; i < TONE_CURVE_WIDTH; i += step) {
      const x = i / (TONE_CURVE_WIDTH - 1);
      const px = linearToSrgb(x) * 100;
      const py = 100 - linearToSrgb(table[i]!) * 100;
      parts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    }
    return `M${parts.join('L')}`;
  });

  const handles = $derived(points.map((p) => pointToDisplay(p)));

  let box: SVGSVGElement | undefined;

  /** 指针 → 编码域坐标（0..1，y 向上）。 */
  function local(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    };
  }

  function down(e: PointerEvent, index: number): void {
    e.stopPropagation();
    e.preventDefault();
    dragIndex = index;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function move(e: PointerEvent): void {
    const i = dragIndex;
    if (i === null) return;
    const at = local(e);
    if (!at) return;
    const cur = points.slice();
    const p = cur[i]!;
    // 端点只让上下动：x 钉在 0 / 1，否则曲线在定义域边上会留一段平线。
    const isEnd = i === 0 || i === cur.length - 1;
    const raw = pointFromDisplay(at.x, at.y);
    const lo = i === 0 ? 0 : cur[i - 1]!.x + 0.002;
    const hi = i === cur.length - 1 ? 1 : cur[i + 1]!.x - 0.002;
    cur[i] = { x: isEnd ? p.x : Math.min(hi, Math.max(lo, raw.x)), y: raw.y };
    onpoints(cur);
  }

  function up(): void {
    if (dragIndex === null) return;
    dragIndex = null;
    oncommit();
  }

  /** 空白处双击加一个点；点本身的双击删除它（端点除外）。 */
  function addPoint(e: MouseEvent): void {
    const at = local(e);
    if (!at) return;
    const pt = pointFromDisplay(at.x, at.y);
    if (points.some((p) => Math.abs(p.x - pt.x) < 0.004)) return;
    onpoints([...points, pt].sort((a, b) => a.x - b.x));
    oncommit();
  }

  function removePoint(index: number): void {
    if (index === 0 || index === points.length - 1) return;
    onpoints(points.filter((_, i) => i !== index));
    oncommit();
  }

  function straighten(): void {
    onpoints(identityPoints());
    oncommit();
  }
</script>

<div class="tcc">
  <div class="tcc-head">
    <span class="tcc-name" style:color>{label}</span>
    <button
      class="tcc-flat"
      type="button"
      disabled={!dirty}
      title={tr('grade.curveReset')}
      aria-label={`${label} · ${tr('grade.curveReset')}`}
      data-testid={`${testid}-reset`}
      onclick={straighten}
    >
      <Icon name="rotate-ccw" size={11} />
    </button>
  </div>

  <svg
    class="tcc-canvas"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
    role="img"
    aria-label={label}
    data-testid={testid}
    bind:this={box}
    ondblclick={addPoint}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
  >
    <!-- 网格：编码域的 25% / 50% / 75%（0 与 100 由边框表达） -->
    {#each [25, 50, 75] as g (g)}
      <line class="tcc-grid" x1={g} y1="0" x2={g} y2="100" vector-effect="non-scaling-stroke" />
      <line class="tcc-grid" x1="0" y1={100 - g} x2="100" y2={100 - g} vector-effect="non-scaling-stroke" />
    {/each}
    <!-- 恒等参考线：判断「我到底有没有改过」最省事的读法 -->
    <line class="tcc-ref" x1="0" y1="100" x2="100" y2="0" vector-effect="non-scaling-stroke" />
    <path class="tcc-line" d={path} stroke={color} vector-effect="non-scaling-stroke" />
    {#each handles as h, i (i)}
      <circle
        class="tcc-pt"
        cx={h.x * 100}
        cy={100 - h.y * 100}
        r="2.2"
        stroke={color}
        vector-effect="non-scaling-stroke"
        data-testid={`${testid}-point`}
        role="button"
        tabindex="-1"
        aria-label={tr('grade.curvePoint', { n: i + 1 })}
        onpointerdown={(e) => down(e, i)}
        ondblclick={(e) => {
          e.stopPropagation();
          removePoint(i);
        }}
      />
    {/each}
  </svg>
</div>

<style>
  .tcc {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 0;
  }
  .tcc-head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-1);
    min-height: 14px;
  }
  .tcc-name {
    font-size: var(--fs-xs);
    letter-spacing: 0.02em;
  }
  /* 拉直是每张图自己的动作（只影响这一通道），所以挂在图的标题上。 */
  .tcc-flat {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--motion-duration-hover) var(--motion-ease);
  }
  .tcc:hover .tcc-flat,
  .tcc-flat:focus-visible {
    opacity: 1;
  }
  .tcc-flat:hover:not(:disabled) {
    color: var(--accent);
  }
  .tcc-flat:disabled {
    cursor: default;
  }
  /*
   * 正方形：曲线编辑器的 45° 参考线只有在等比时才是 45°。拉伸成矩形会让
   * 「没改过」看起来像一条斜率的直线，读图的人会以为曲线已经偏了。
   */
  .tcc-canvas {
    width: 100%;
    aspect-ratio: 1 / 1;
    min-height: 0;
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    touch-action: none;
  }
  .tcc-grid {
    stroke: var(--border);
    stroke-width: 1;
    opacity: 0.6;
  }
  .tcc-ref {
    stroke: var(--border-strong);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    opacity: 0.7;
  }
  .tcc-line {
    fill: none;
    stroke-width: 1.6;
  }
  .tcc-pt {
    fill: var(--surface-3);
    stroke-width: 1.4;
    cursor: grab;
  }
  .tcc-pt:active {
    cursor: grabbing;
  }
</style>
