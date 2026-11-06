<script lang="ts">
  /**
   * AlgoCard — 选择器里的一张卡片（网格形态）或一行（列表形态）。
   *
   * 与 `effect-picker/EffectCard.svelte` / `transition-picker/TransitionCard.svelte`
   * 同构：网格 = 大缩略图 + 名称 + 一句话说明，列表 = 小缩略图 + 文字。
   *
   * **没有缩略图时退化成「只有名字」**：插件生成器没有随应用一起发出的静态图，
   * `algoThumbUrl` 会返回 `null`。这里不画占位条，也不报错 —— 直接省略缩略图块，
   * 让文字独占卡片。
   */
  import type { AlgoItem, AlgoView } from './picker-model';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    item: AlgoItem;
    view: AlgoView;
    /** 缩略图 URL。null = 没有静态资源（插件生成器），只显示文字。 */
    thumb: string | null;
    selected: boolean;
    /** 工程里当前就是这条（与「本次选择」区分开：两者可以同时为真）。 */
    current: boolean;
    onpick: (id: string) => void;
  }
  const { item, view, thumb, selected, current, onpick }: Props = $props();
</script>

<button
  type="button"
  class="ap-card ap-{view}"
  class:ap-sel={selected}
  class:ap-plain={!thumb}
  data-testid="algo-picker-item"
  data-algo-id={item.id}
  aria-pressed={selected}
  onclick={() => onpick(item.id)}
>
  {#if thumb}
    <span class="ap-thumb">
      <img src={thumb} alt="" draggable="false" loading="lazy" decoding="async" />
      {#if selected}
        <span class="ap-badge" data-testid="algo-picker-badge">✓</span>
      {/if}
    </span>
  {/if}

  <span class="ap-meta">
    <!--
      「当前生效的那条」的标记放在 meta 里、**不依赖缩略图** —— 插件生成器没有
      静态缩略图，放缩略图上等于没有标记（点名不出来的状态）。

      标记与名称同在一个 flex 行里：名称原来是 `display: block`，标记又是它前面的
      独立块，于是「当前」自己占一行、名字另起一行 —— 卡片高度还会随有没有标记
      跳一格。行容器用 `baseline` 对齐，中文名与 11px 的小标签才在同一个基线上。
    -->
    <span class="ap-title">
      {#if current}
        <span class="ap-cur" data-testid="algo-picker-current">{tr('insp.algoPickerCurrent')}</span>
      {/if}
      <span class="ap-name">{item.name}</span>
    </span>
    {#if item.desc}<span class="ap-desc">{item.desc}</span>{/if}
    {#if view === 'list'}
      <span class="ap-sub">
        <span class="ap-id" data-testid="algo-picker-id">{item.id}</span>
        <span class="ap-kind">{item.kind}</span>
      </span>
    {/if}
  </span>
</button>

<style>
  .ap-card {
    display: block;
    width: 100%;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .ap-card:hover {
    border-color: var(--border-strong, var(--border));
  }
  .ap-card.ap-sel {
    border-color: var(--accent);
  }

  /* ------------------------------------------------------------ 网格形态 */
  .ap-card.ap-grid .ap-thumb {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    background: #000;
  }
  .ap-card.ap-grid .ap-meta {
    display: block;
    padding: var(--sp-2) var(--sp-3) var(--sp-3);
  }
  /* 无图（缩略图块缺席）：网格卡片靠上下内边距留出高度，不会塌成一条细线。 */
  .ap-card.ap-grid.ap-plain .ap-meta {
    padding: var(--sp-5) var(--sp-3);
  }

  /* ------------------------------------------------------------ 列表形态 */
  .ap-card.ap-list {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2);
  }
  .ap-card.ap-list.ap-plain {
    grid-template-columns: minmax(0, 1fr);
  }
  .ap-card.ap-list .ap-thumb {
    position: relative;
    display: block;
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: 2px;
    overflow: hidden;
    background: #000;
  }

  .ap-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ap-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 2px;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-size: var(--fs-xs);
    line-height: 16px;
    text-align: center;
  }
  /* 「当前」小标签：始终可见（不依赖缩略图）。 */
  .ap-title {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }
  .ap-cur {
    /* 名称过长时先压缩名称，标记本身不缩（缩了会看到「当…」）。 */
    flex-shrink: 0;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    line-height: 15px;
  }

  .ap-meta {
    min-width: 0;
  }
  .ap-name {
    display: block;
    min-width: 0;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ap-desc {
    display: block;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }
  .ap-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px var(--sp-2);
    margin-top: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  /* id 是英文，等宽更好扫（与 lab 右栏「显示名 + id」同一理由）。 */
  .ap-id {
    font-family: var(--font-mono);
  }
  .ap-kind {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
</style>
