<script lang="ts">
  /**
   * ToneCurveEditor — 色调曲线编辑区（主 / R / G / B 四张表）。
   *
   * 与 `curve-editor/CurveEditor.svelte`（关键帧曲线）**刻意不共用**：那边有
   * `interp` / `handles` / `mode`，这边只有单调性。共用会逼用户理解一堆与
   * 「亮度映射」无关的概念。
   *
   * ## 坐标系
   *
   * 画出来的是**编码刻度**（用户直觉），存的是**线性值**（shader 的域）。
   * 换算只在 `core/tone-curve.ts` 的 `pointToDisplay` / `pointFromDisplay` 里，
   * 这里不做第二份。
   *
   * 曲线本身也是**采样后画的**：同一份 1024 点表既喂纹理也喂这条 path，
   * 于是「编辑器画的样子」与「画面上的结果」不可能不一致。
   */
  import type { EffectInstance } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import {
    identityPoints,
    parseToneCurve,
    pointFromDisplay,
    pointToDisplay,
    sampleToneCurve,
    stringifyToneCurve,
    TONE_CURVE_WIDTH,
    type CurvePoint,
  } from '../../core/tone-curve';
  import { linearToSrgb } from '../../core/color';
  import type { MessageKey } from '../../i18n/locales';
  import { appState } from '../app-state.svelte';

  type Channel = 'master' | 'r' | 'g' | 'b';

  interface Props {
    inst: EffectInstance;
    onvalue: (mutate: (inst: EffectInstance) => void) => void;
    oncommit: () => void;
  }
  const { inst, onvalue, oncommit }: Props = $props();

  const CHANNELS: { id: Channel; labelKey: MessageKey }[] = [
    { id: 'master', labelKey: 'grade.curveMaster' },
    { id: 'r', labelKey: 'grade.curveChannelR' },
    { id: 'g', labelKey: 'grade.curveChannelG' },
    { id: 'b', labelKey: 'grade.curveChannelB' },
  ];

  /**
   * 曲线线的颜色。
   *
   * R/G/B 用**字面量色相**是对的：它们表示通道，不是界面 chrome ——
   * 跟着主题变会让「这是红通道」丢失。主曲线用文字色（中性）。
   */
  const STROKE: Record<Channel, string> = {
    master: 'var(--text-primary)',
    r: 'hsl(0 62% 55%)',
    g: 'hsl(140 45% 45%)',
    b: 'hsl(215 68% 60%)',
  };

  let channel = $state<Channel>('master');
  let dragIndex = $state<number | null>(null);

  const key = $derived(`curve#${channel}`);
  /*
   * 每个派生都要 `void appState.version`：`inst` 是 store 里的普通对象，
   * 原地改 `values` 不换引用 —— 不加这一句，拖完控制点曲线不会重画。
   */
  const points = $derived.by<CurvePoint[]>(() => {
    void appState.version;
    return parseToneCurve(String(inst.values[key] ?? ''));
  });
  const dirty = $derived.by(() => {
    void appState.version;
    return points.length > 2 || points.some((p) => Math.abs(p.y - p.x) > 1e-4);
  });

  /** 曲线 path：采样 → 转编码坐标 → 极坐标翻转成 SVG 的 y。 */
  const path = $derived.by(() => {
    void appState.version;
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

  const handles = $derived.by(() => {
    void appState.version;
    return points.map((p) => pointToDisplay(p));
  });

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

  function write(next: CurvePoint[]): void {
    onvalue((it) => {
      it.values[key] = stringifyToneCurve(next);
    });
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
    cur[i] = {
      x: isEnd ? p.x : Math.min(hi, Math.max(lo, raw.x)),
      y: raw.y,
    };
    write(cur);
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
    const next = [...points, pt].sort((a, b) => a.x - b.x);
    write(next);
    oncommit();
  }

  function removePoint(index: number): void {
    if (index === 0 || index === points.length - 1) return;
    write(points.filter((_, i) => i !== index));
    oncommit();
  }

  function straighten(): void {
    write(identityPoints());
    oncommit();
  }
</script>

<div class="tc">
  <div class="tc-head">
    <div class="tc-tabs" role="tablist" aria-label={tr('grade.colCurves')}>
      {#each CHANNELS as c (c.id)}
        <button
          class="tc-tab"
          class:on={channel === c.id}
          style:--tab-color={STROKE[c.id]}
          type="button"
          role="tab"
          aria-selected={channel === c.id}
          data-testid={`grade-curve-tab-${c.id}`}
          onclick={() => (channel = c.id)}
        >
          {tr(c.labelKey)}
        </button>
      {/each}
    </div>
    <button
      class="tc-flat"
      type="button"
      disabled={!dirty}
      title={tr('grade.curveReset')}
      data-testid="grade-curve-straighten"
      onclick={straighten}
    >
      {tr('grade.curveReset')}
    </button>
  </div>

  <svg
    class="tc-canvas"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
    role="img"
    aria-label={tr('grade.colCurves')}
    data-testid="grade-curve-canvas"
    bind:this={box}
    ondblclick={addPoint}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
  >
    <!-- 网格：编码域的 25% / 50% / 75%（0 与 100 由边框表达） -->
    {#each [25, 50, 75] as g (g)}
      <line class="tc-grid" x1={g} y1="0" x2={g} y2="100" vector-effect="non-scaling-stroke" />
      <line class="tc-grid" x1="0" y1={100 - g} x2="100" y2={100 - g} vector-effect="non-scaling-stroke" />
    {/each}
    <!-- 恒等参考线：判断「我到底有没有改过」最省事的读法 -->
    <line class="tc-ref" x1="0" y1="100" x2="100" y2="0" vector-effect="non-scaling-stroke" />
    <path class="tc-line" d={path} stroke={STROKE[channel]} vector-effect="non-scaling-stroke" />
    {#each handles as h, i (i)}
      <circle
        class="tc-pt"
        cx={h.x * 100}
        cy={100 - h.y * 100}
        r="2.2"
        stroke={STROKE[channel]}
        vector-effect="non-scaling-stroke"
        data-testid="grade-curve-point"
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

  <span class="tc-count">{tr('grade.curveCount', { n: points.length })}</span>
</div>

<style>
  .tc {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-height: 0;
  }
  .tc-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .tc-tabs {
    display: flex;
    gap: var(--sp-1);
  }
  /* 通道页签：选中时用该通道的颜色（这是内容色，唯一该出现彩色的地方）。 */
  .tc-tab {
    height: var(--control-h-sm);
    min-width: 28px;
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .tc-tab:hover {
    color: var(--text-secondary);
  }
  .tc-tab.on {
    border-color: var(--border-strong);
    color: var(--tab-color);
  }
  .tc-flat {
    margin-left: auto;
    height: var(--control-h-sm);
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .tc-flat:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .tc-flat:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  .tc-canvas {
    width: 100%;
    aspect-ratio: 1 / 1;
    max-height: 320px;
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    touch-action: none;
  }
  .tc-grid {
    stroke: var(--border);
    stroke-width: 1;
    opacity: 0.6;
  }
  .tc-ref {
    stroke: var(--border-strong);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    opacity: 0.7;
  }
  .tc-line {
    fill: none;
    stroke-width: 1.6;
  }
  .tc-pt {
    fill: var(--surface-3);
    stroke-width: 1.4;
    cursor: grab;
  }
  .tc-pt:active {
    cursor: grabbing;
  }
  .tc-count {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
