<script lang="ts">
  /**
   * TransitionCard — 选择器里的一张卡片（网格形态）或一行（列表形态）。
   *
   * 与 `effect-picker/EffectCard.svelte` 同构：网格 = 大缩略图 + 名称 + 一句话说明，
   * 列表 = 小缩略图 + 文字。列表里多一行 `id · 作者 · 许可` ——
   * **上游 id 是刻意保留的**：中文名让人扫得动，id 让人能回 gl-transitions 查这条
   * 转场到底怎么实现（那也是参数名不翻译的理由）。
   */
  import ThumbPlaceholder from '../ThumbPlaceholder.svelte';
  import type { TransitionItem, TransitionView } from './picker-model';

  interface Props {
    item: TransitionItem;
    view: TransitionView;
    /** 缩略图 URL。null = 还没导出（新增转场还没跑脚本），显示品牌占位图。 */
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
  class="trp-card trp-{view}"
  class:trp-sel={selected}
  data-testid="transition-picker-item"
  data-transition-id={item.id}
  aria-pressed={selected}
  onclick={() => onpick(item.id)}
>
  <span class="trp-thumb">
    {#if thumb}
      <img src={thumb} alt="" draggable="false" loading="lazy" decoding="async" />
    {:else}
      <!-- 没有资源（新增转场还没跑导出脚本）：品牌占位图，与有图的卡片同高 -->
      <ThumbPlaceholder size={view === 'list' ? 20 : 34} />
    {/if}
    {#if selected}
      <span class="trp-badge" data-testid="transition-picker-badge">✓</span>
    {:else if current}
      <!-- 当前生效的那条：用描边而不是角标，免得与「本次选择」的角标打架 -->
      <span class="trp-badge trp-badge-cur" data-testid="transition-picker-current">·</span>
    {/if}
  </span>

  <span class="trp-meta">
    <span class="trp-name">{item.name}</span>
    <span class="trp-desc">{item.desc}</span>
    {#if view === 'list'}
      <span class="trp-sub">
        <span class="trp-id" data-testid="transition-picker-id">{item.id}</span>
        <span class="trp-author">{item.author}</span>
        <span class="trp-lic">{item.license}</span>
      </span>
    {/if}
  </span>
</button>

<style>
  .trp-card {
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
  .trp-card:hover {
    border-color: var(--border-strong, var(--border));
  }
  .trp-card.trp-sel {
    border-color: var(--accent);
  }

  /* ------------------------------------------------------------ 网格形态 */
  .trp-card.trp-grid .trp-thumb {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    background: #000;
  }
  .trp-card.trp-grid .trp-meta {
    display: block;
    padding: var(--sp-2) var(--sp-3) var(--sp-3);
  }

  /* ------------------------------------------------------------ 列表形态 */
  .trp-card.trp-list {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2);
  }
  .trp-card.trp-list .trp-thumb {
    position: relative;
    display: block;
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: 2px;
    overflow: hidden;
    background: #000;
  }

  .trp-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .trp-badge {
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
  .trp-badge-cur {
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }

  .trp-meta {
    min-width: 0;
  }
  .trp-name {
    display: block;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trp-desc {
    display: block;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }
  .trp-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px var(--sp-2);
    margin-top: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  /* id 是英文，等宽更好扫（与 lab 右栏「显示名 + id」同一理由） */
  .trp-id {
    font-family: var(--font-mono);
  }
  .trp-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 12em;
  }
  .trp-lic {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
</style>
