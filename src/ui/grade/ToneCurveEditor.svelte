<script lang="ts">
  /**
   * ToneCurveEditor — 色调曲线区：主 / R / G / B 四张表，**按可用宽度分页**。
   *
   * ## 为什么是分页而不是「永远四张」或滚动条
   *
   * 曲线是**形状**信息，图越小越读不出来。四张平摊在窄面板里时每张只有
   * 一百来像素，控制点都点不准；横向滚动条在这里最别扭 —— 拖曲线时手本来
   * 就在图里，滚轮/拖动会与「拖控制点」抢手势。
   *
   * 所以：**图始终是正方形、高度吃满面板**，能放几张放几张，放不下的左右翻页。
   * 窗口宽度变了只影响「一页几张」，不影响单张的大小。
   */
  import type { EffectInstance } from '../../core/schema';
  import { stringifyToneCurve, type CurvePoint } from '../../core/tone-curve';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import { appState } from '../app-state.svelte';
  import Icon from '../Icon.svelte';
  import ToneCurveChart from './ToneCurveChart.svelte';

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

  /** 图与图之间的缝，以及标题行（标签 + 拉直按钮）的高度 —— 分页要扣掉它们。 */
  const GAP = 8;
  const HEAD = 20;

  let boxW = $state(0);
  let boxH = $state(0);
  let page = $state(0);

  /**
   * 一页几张 + 单张多宽（正方形，边长 = 宽）。
   *
   * 判据不是「严格按满高能放几张」——那样 460px 宽、270px 高的面板一页只能放
   * **一张**，比较 R 与 G 要先翻页，比现在更糟。所以允许图缩到面板高度的
   * 2/3 来多放一张：两页变一页，而肉眼几乎看不出矮了几十像素。
   */
  const layout = $derived.by(() => {
    const avail = Math.max(72, boxH - HEAD);
    const fit = Math.floor((boxW + GAP) / (avail * (2 / 3) + GAP));
    const n = Math.max(1, Math.min(CHANNELS.length, fit));
    const side = Math.max(64, Math.min(avail, Math.floor((boxW - GAP * (n - 1)) / n)));
    return { n, side };
  });
  const perPage = $derived(layout.n);
  const pages = $derived(Math.max(1, Math.ceil(CHANNELS.length / perPage)));
  const current = $derived(Math.min(page, pages - 1));
  const visible = $derived(CHANNELS.slice(current * perPage, current * perPage + perPage));

  // 面板变宽会让页数变少：越界时退回最后一页（否则会停在一个空页上）。
  $effect(() => {
    if (page > pages - 1) page = pages - 1;
  });

  /**
   * 四条曲线的原始串。整块取一次而不是在模板里逐个读：`inst` 是 store 里的
   * 普通对象，必须在同一个派生里 `void appState.version`，否则拖完控制点
   * 曲线不会重画（父组件不会因为「值变了」而重跑）。
   */
  const values = $derived.by(() => {
    void appState.version;
    const map = {} as Record<Channel, string>;
    for (const c of CHANNELS) map[c.id] = String(inst.values[`curve#${c.id}`] ?? '');
    return map;
  });

  function write(channel: Channel, next: CurvePoint[]): void {
    onvalue((it) => {
      it.values[`curve#${channel}`] = stringifyToneCurve(next);
    });
  }
</script>

<div class="tce" bind:clientWidth={boxW} bind:clientHeight={boxH}>
  <div class="tce-page" style:grid-template-columns={`repeat(${perPage}, minmax(0, 1fr))`}>
    {#each visible as c (c.id)}
      <ToneCurveChart
        value={values[c.id]}
        color={STROKE[c.id]}
        label={tr(c.labelKey)}
        size={layout.side}
        testid={`grade-curve-canvas-${c.id}`}
        onpoints={(next) => write(c.id, next)}
        {oncommit}
      />
    {/each}
  </div>

  {#if pages > 1}
    <!--
      翻页做成压在两侧的浮层：面板高度是曲线最缺的东西，不能给翻页条再切一行。
      只在真的放不下时才出现。
    -->
    <button
      class="tce-nav prev"
      type="button"
      disabled={current === 0}
      aria-label={tr('grade.curvePrev')}
      data-testid="grade-curve-prev"
      onclick={() => (page = Math.max(0, current - 1))}
    >
      <Icon name="chevron-left" size={14} />
    </button>
    <button
      class="tce-nav next"
      type="button"
      disabled={current >= pages - 1}
      aria-label={tr('grade.curveNext')}
      data-testid="grade-curve-next"
      onclick={() => (page = Math.min(pages - 1, current + 1))}
    >
      <Icon name="chevron-right" size={14} />
    </button>
    <span class="tce-count" data-testid="grade-curve-page">{current + 1}/{pages}</span>
  {/if}
</div>

<style>
  .tce {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: 100%;
  }
  .tce-page {
    display: grid;
    gap: var(--sp-2);
    /* 竖直居中：图比可用高度矮时，多出来的那点空白上下平分，看起来是有意留的。 */
    align-content: center;
    align-items: center;
    height: 100%;
    min-height: 0;
  }
  /*
   * 翻页按钮：压在图的左右边缘上。半透明底是必须的 —— 曲线会从按钮底下穿过，
   * 纯图标在深色主题里会被线挡住。
   */
  .tce-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 40px;
    padding: 0;
    background: color-mix(in srgb, var(--surface-1) 82%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    z-index: 2;
  }
  .tce-nav.prev {
    left: -2px;
  }
  .tce-nav.next {
    right: -2px;
  }
  .tce-nav:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .tce-nav:disabled {
    color: var(--text-disabled);
    cursor: default;
    opacity: 0.5;
  }
  /* 页码：右下角一小块，不占布局（曲线图底下没有别的元素）。 */
  .tce-count {
    position: absolute;
    right: 4px;
    bottom: 2px;
    font-size: 9px;
    line-height: 1;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
</style>
