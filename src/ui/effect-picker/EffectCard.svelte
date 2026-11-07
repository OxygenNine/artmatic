<script lang="ts">
  /**
   * EffectCard — 选择器里的一张卡片（网格形态）或一行（列表形态）。
   *
   * 两种形态共用一份 DOM 结构与一份数据，只在 `view` 上分叉：
   *   · 网格：大缩略图在上，名称 + 说明在下。靠图认特效。
   *   · 列表：小缩略图在左，名称 + 说明 + **标签**在右。靠筛选与文字认特效 ——
   *     标签只在列表里出现是有意的：网格里塞标签会把名称挤成两行，反而更难扫。
   */
  import { tr } from '../../i18n/index.svelte';
  import ThumbPlaceholder from '../ThumbPlaceholder.svelte';
  import type { EffectItem, PickerView } from './picker-model';

  interface Props {
    item: EffectItem;
    view: PickerView;
    /** 缩略图 URL。null = 没有静态资源（新增特效 / 插件特效），显示品牌占位图。 */
    thumb: string | null;
    selected: boolean;
    onpick: (id: string) => void;
  }
  const { item, view, thumb, selected, onpick }: Props = $props();
</script>

<button
  type="button"
  class="fxp-card fxp-{view}"
  class:fxp-sel={selected}
  data-testid="effect-picker-item"
  data-effect-id={item.id}
  aria-pressed={selected}
  onclick={() => onpick(item.id)}
>
  <span class="fxp-thumb">
    {#if thumb}
      <!--
        `loading="lazy"` + `decoding="async"`：懒加载交给浏览器。
        之前是手写 IntersectionObserver 触发现渲 —— 现在图是静态资源，
        浏览器自己那一套比手写的更好（还能利用磁盘缓存），代码也少一层。
        容器已有 `aspect-ratio: 16/9`，所以解码前也不会跳版。
      -->
      <img src={thumb} alt="" draggable="false" loading="lazy" decoding="async" />
    {:else}
      <!-- 没有资源（新增特效还没导出 / 插件特效）：品牌占位图，与有图的卡片同高 -->
      <ThumbPlaceholder size={view === 'list' ? 20 : 34} />
    {/if}
    {#if selected}
      <span class="fxp-badge" data-testid="effect-picker-badge">{tr('insp.pickerSelected')}</span>
    {/if}
    {#if item.pluginId}
      <!--
        插件来源角标。放在左下角而不是右上角：右上角是「已选中」的位置，
        两者会同时出现（选中一个插件特效），叠在一起谁也看不清。
        插件特效没有预导出的缩略图（那是随应用一起发出去的静态资源），
        上面显示的是品牌占位图 —— 角标正好解释了「为什么这张不是画面」。
      -->
      <span class="fxp-plugin-badge" data-testid="effect-picker-plugin">{tr('fx.pluginBadge')}</span>
    {/if}
  </span>

  <span class="fxp-meta">
    <span class="fxp-name">{item.name}</span>
    <span class="fxp-desc">{item.desc}</span>
    {#if view === 'list'}
      <span class="fxp-tags">
        <span class="fxp-cat">{item.categoryLabel}</span>
        {#each item.tagLabels as label (label)}
          <span class="fxp-tag">{label}</span>
        {/each}
      </span>
    {/if}
  </span>
</button>

<style>
  .fxp-card {
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
  .fxp-card:hover {
    border-color: var(--border-strong, var(--border));
  }
  /* 选中态用主题色描边 + 角标两重提示：只靠描边在深色主题里不够醒目 */
  .fxp-card.fxp-sel {
    border-color: var(--accent);
  }

  /* ------------------------------------------------------------ 网格形态 */
  .fxp-card.fxp-grid .fxp-thumb {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    background: #000;
  }
  .fxp-card.fxp-grid .fxp-meta {
    display: block;
    padding: var(--sp-2) var(--sp-3) var(--sp-3);
  }

  /* ------------------------------------------------------------ 列表形态 */
  .fxp-card.fxp-list {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2);
  }
  .fxp-card.fxp-list .fxp-thumb {
    position: relative;
    display: block;
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: 2px;
    overflow: hidden;
    background: #000;
  }

  .fxp-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fxp-plugin-badge {
    position: absolute;
    bottom: 4px;
    left: 4px;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--surface-active);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .fxp-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }

  .fxp-meta {
    min-width: 0;
  }
  .fxp-name {
    display: block;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fxp-desc {
    display: block;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }
  .fxp-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: var(--sp-2);
  }
  .fxp-cat,
  .fxp-tag {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  /* 分类是「骨架」，标签是「属性」—— 用底色区分，不用颜色（配色纪律：颜色留给状态） */
  .fxp-cat {
    background: var(--surface-active);
    border-color: transparent;
  }
</style>
