<script lang="ts">
  /**
   * AlgoPickerModal — 「更换算法艺术」选择器。
   *
   * 检查器里原本只有一行只读的「算法生成器：{name}」，换不了生成器 —— 想换个
   * 图案只能删掉片段重新插一个（源参数与已调好的其它属性全丢）。这里给的是
   * 「搜索 + 缩略图网格 / 列表」的单选 Modal。
   *
   * 与 `EffectPickerModal` / `TransitionPickerModal` 同构，但有两点不同：
   *  1. **单选**（一个片段就是一个生成器），选中 → 确认。
   *  2. **会整份替换源**：换生成器 = 换一种算法，参数表完全不同，所以旧参数与
   *     已打的关键帧都不保留（旧值对新生成器没有意义）。这一点在面板里**明说**，
   *     而不是让用户按下去才发现。
   *
   * 缩略图是**预先导出的静态资源**（`ui/algo-thumb-assets.ts`），只贴
   * `<img loading="lazy">`：生成器只有二十多个，不需要特效选择器那套
   * IntersectionObserver 的懒渲染（那主要是给七十多个特效摊平重着色器的）。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import Icon from '../Icon.svelte';
  import Select from '../controls/Select.svelte';
  import AlgoCard from './AlgoCard.svelte';
  import { algoThumbUrl } from '../algo-thumb-assets';
  import {
    ALGO_SORTS,
    buildItems,
    filterItems,
    groupItems,
    labelOf,
    sortItems,
    type AlgoItem,
    type AlgoSort,
    type AlgoView,
  } from './picker-model';
  import type { AlgoGroupId } from '../../algos/catalog';
  import { ARCHIVE_ALGO_GROUP } from '../../algos/catalog';
  import { tr } from '../../i18n/index.svelte';
  import { registryRevision } from '../registry-revision.svelte';
  import type { MessageKey } from '../../i18n/locales';

  /** 排序选项的文案键（`AlgoSort` 是闭联合，索引结果仍是字面量键）。 */
  const SORT_LABEL_KEY: Record<AlgoSort, MessageKey> = {
    default: 'insp.algoPickerSortDefault',
    name: 'insp.pickerSortName',
  };

  interface Props {
    /** 工程里当前的生成器 id。 */
    current: string;
    /**
     * 面板标题。默认是检查器的「更换算法艺术」；从时间轴**新建**算法片段时
     * 传「算法片段」—— 那里没有任何东西被「更换」。
     */
    title?: string;
    /** 确认按钮文字。同样是「更换」与「插入」的区别。 */
    applyLabel?: string;
    /** 确认：整体替换成这个生成器。 */
    onapply: (defId: string) => void;
    onclose: () => void;
  }
  const {
    current,
    title = tr('insp.changeAlgo'),
    applyLabel = tr('insp.algoPickerApply'),
    onapply,
    onclose,
  }: Props = $props();

  let query = $state('');
  let view = $state<AlgoView>('grid');
  let sort = $state<AlgoSort>('default');
  /**
   * 本次选择。初值 = 当前生成器（进面板即高亮它）—— **只取挂载那一刻的快照**
   * 是刻意的：面板关闭即销毁，之后 store 再怎么变与这次选择无关。
   */
  // svelte-ignore state_referenced_locally -- 只取挂载那一刻的快照，正是意图
  let selected = $state<string>(current);

  // 依赖运行期注册表版本：插件在面板开着的时候挂载/卸载也要立刻反映出来。
  const items = $derived.by(() => {
    registryRevision();
    return buildItems(tr);
  });
  const visible = $derived(sortItems(filterItems(items, { query }), sort));
  /** 一组卡片 + 它的小标题（已翻译）。封面 URL 与条目一起算，模板里不再查表。 */
  interface GroupView {
    id: AlgoGroupId;
    label: string;
    cards: { item: AlgoItem; thumb: string | null }[];
  }

  /** 分组后的卡片。筛选与排序先完成，分组只负责切小标题（空组不出现）。 */
  const groups: GroupView[] = $derived(
    groupItems(visible, tr).map((g) => ({
      id: g.id,
      label: g.label,
      cards: g.items.map((it) => ({ item: it, thumb: algoThumbUrl(it.id) })),
    })),
  );
  /** 选中的还是当前那一个 → 没有任何改动，确认无意义。 */
  const unchanged = $derived(selected === current);
  const selectedLabel = $derived(labelOf(items, selected) ?? selected);

  const sortOptions = $derived(ALGO_SORTS.map((s) => ({ value: s, label: tr(SORT_LABEL_KEY[s]) })));

  /**
   * 归档组默认折叠。
   *
   * 例外：**当前的生成器就在归档里**（打开一份老工程）时展开 —— 否则用户
   * 进面板只看到高亮在别处的卡片，会以为「这个片段用的生成器已经不存在了」。
   * 只取挂载那一刻的快照（与 `selected` 同一条理由）：面板开着时用户自己
   * 折叠 / 展开的意图不该被后续计算顶回去。
   */
  // svelte-ignore state_referenced_locally -- 同上，挂载快照
  let archiveOpen = $state(items.find((i) => i.id === current)?.archived === true);

  function apply(): void {
    if (unchanged) return;
    onapply(selected);
  }
</script>

<!--
  一组的卡片网格。归档组与普通组只差外壳（`<details>` vs `<section>`），
  网格本身一模一样 —— 抄两份的下场是「归档那组的卡片大小 / 间距与别处不一样」，
  而它只在展开时才看得见。
-->
{#snippet tiles(g: GroupView)}
  <div class="ap-tiles" class:ap-tiles-grid={view === 'grid'} class:ap-tiles-list={view === 'list'}>
    {#each g.cards as c (c.item.id)}
      <div class="ap-slot">
        <AlgoCard
          item={c.item}
          {view}
          thumb={c.thumb}
          selected={selected === c.item.id}
          current={current === c.item.id}
          onpick={(id) => (selected = id)}
        />
      </div>
    {/each}
  </div>
{/snippet}

{#snippet footer()}
  <!-- `data-selected-id` 是给 E2E 的稳定判据：显示的文本是中文名（会随文案变，
       也随语言变），而 id 是工程里真正落库的那个值。 -->
  <span class="ap-sel-label" data-testid="algo-picker-selected" data-selected-id={selected}>
    {selected === ''
      ? tr('insp.algoPickerPick')
      : unchanged
        ? tr('insp.algoPickerUnchanged')
        : tr('insp.algoPickerSelected', { name: selectedLabel })}
  </span>
  <div class="ap-foot">
    <Button label={tr('common.cancel')} variant="outline" testid="algo-picker-cancel" onclick={onclose} />
    <Button
      label={applyLabel}
      icon="check"
      variant="accent"
      disabled={unchanged}
      tipText={tr('insp.algoPickerApplyTip')}
      testid="algo-picker-confirm"
      onclick={apply}
    />
  </div>
{/snippet}

<Modal {title} testid="modal-algo-picker" width="picker" flushBody {onclose} {footer}>
  <div class="ap">
    <!-- 工具栏 -->
    <div class="ap-bar">
      <label class="ap-search">
        <Icon name="search" size={14} />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          autofocus
          data-testid="algo-picker-search"
          placeholder={tr('insp.algoPickerSearch')}
          bind:value={query}
        />
      </label>

      <Button
        label={view === 'grid' ? tr('insp.pickerViewGrid') : tr('insp.pickerViewList')}
        icon={view === 'grid' ? 'layout-grid' : 'list'}
        variant="outline"
        tipText={view === 'grid' ? tr('insp.pickerViewGridTip') : tr('insp.pickerViewListTip')}
        testid="algo-picker-view"
        onclick={() => (view = view === 'grid' ? 'list' : 'grid')}
      />

      <Select
        value={sort}
        options={sortOptions}
        minWidth={124}
        ariaLabel={tr('insp.pickerSort')}
        testid="algo-picker-sort"
        optionTestidPrefix="algo-picker-sort-opt"
        onchange={(v) => (sort = v as AlgoSort)}
      />
    </div>

    <!--
      整份替换的后果：把话说在前面，而不是让用户按下去才发现。
      从时间轴**新建**片段时没有「旧源」可替换（current 为空串），这条提示不适用。
    -->
    {#if current}
      <p class="ap-warn" data-testid="algo-picker-warn">{tr('insp.algoPickerWarn')}</p>
    {/if}

    <!-- 主体：小标题 + 分隔线 + 该组自己的卡片网格 -->
    <div class="ap-body">
      {#if visible.length === 0}
        <p class="ap-empty" data-testid="algo-picker-empty">
          {tr('insp.algoPickerEmpty')}
          <br /><span class="ap-empty-hint">{tr('insp.pickerEmptyHint')}</span>
        </p>
      {:else}
        {#each groups as g (g.id)}
          {#if g.id === ARCHIVE_ALGO_GROUP}
            <!--
              归档组：默认折叠、永远排在最后。用原生 `<details>` 而不是自己写
              折叠状态 —— 键盘可达性、`aria-expanded`、点标题切换都是免费的，
              而这些东西自己写一遍，漏掉的永远是屏幕阅读器那一半。
            -->
            <details class="ap-group ap-archive" data-testid={`algo-picker-group-${g.id}`} open={archiveOpen}>
              <summary class="ap-group-head ap-archive-head">
                <span class="ap-archive-chevron" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
                <span class="ap-group-name">{g.label}</span>
                <span class="ap-group-n">{g.cards.length}</span>
              </summary>
              <p class="ap-archive-hint">{tr('insp.algoArchiveHint')}</p>
              {@render tiles(g)}
            </details>
          {:else}
            <section class="ap-group" data-testid={`algo-picker-group-${g.id}`}>
              <h3 class="ap-group-head">
                <span class="ap-group-name">{g.label}</span>
                <span class="ap-group-n">{g.cards.length}</span>
              </h3>
              {@render tiles(g)}
            </section>
          {/if}
        {/each}
      {/if}
    </div>

    <div class="ap-status" data-testid="algo-picker-hit">
      {tr('insp.algoPickerHit', { n: visible.length })}
    </div>
  </div>
</Modal>

<style>
  /* flex 列 + 主体自己滚动：modal 已 flushBody（见 Modal.svelte 的 width='picker'）。 */
  .ap {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  /* -------------------------------------------------------------- 工具栏 */
  .ap-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-shrink: 0;
    padding: var(--sp-4) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }
  .ap-search {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 0;
    height: var(--control-h);
    padding: 0 var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--text-muted);
  }
  .ap-search:focus-within {
    border-color: var(--accent);
  }
  .ap-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    outline: none;
  }

  /* ------------------------------------------------------------ 警告条 */
  .ap-warn {
    flex-shrink: 0;
    margin: 0;
    padding: var(--sp-2) var(--sp-5);
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--warning);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }

  /* ---------------------------------------------------------------- 主体 */
  .ap-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5);
  }

  /* 小标题：名称 + 条数 + 一条填满剩余宽度的分隔线。 */
  .ap-group-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-3);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    font-weight: 600;
    line-height: 1.4;
  }
  .ap-group-head::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .ap-group-n {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 400;
  }

  /* ------------------------------------------------------------ 归档组 */
  .ap-archive {
    margin-top: var(--sp-4);
    border-top: 1px solid var(--border);
    padding-top: var(--sp-3);
  }
  /* 原生三角换成图标：与其它小标题的排版对齐（默认那个三角会把文字推右）。 */
  .ap-archive-head {
    cursor: pointer;
    list-style: none;
    user-select: none;
    margin-bottom: 0;
  }
  .ap-archive-head::-webkit-details-marker {
    display: none;
  }
  .ap-archive[open] > .ap-archive-head {
    margin-bottom: var(--sp-3);
  }
  .ap-archive-chevron {
    display: inline-flex;
    transition: transform 0.15s ease;
  }
  .ap-archive[open] > .ap-archive-head .ap-archive-chevron {
    transform: rotate(90deg);
  }
  .ap-archive-hint {
    margin: 0 0 var(--sp-3);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }

  .ap-tiles {
    display: grid;
    align-content: start;
  }
  .ap-tiles.ap-tiles-grid {
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--sp-4);
  }
  /*
   * 列表形态：**宽度够就并两列**（与两个既有选择器同一个理由 —— 一排到底在
   * 920px 宽的模态里只用掉左半幅）。`auto-fill` + 最小 340px：窄屏自然退回一列。
   */
  .ap-tiles.ap-tiles-list {
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--sp-2) var(--sp-4);
  }
  .ap-slot {
    min-width: 0;
  }

  .ap-empty {
    margin: var(--sp-6) 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    text-align: center;
  }
  .ap-empty-hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  /* 命中数：固定在主体下方，滚动时不跟着走 —— 它是筛选器的读数。 */
  .ap-status {
    flex-shrink: 0;
    padding: var(--sp-2) var(--sp-5);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  /* -------------------------------------------------------------- 底栏 */
  .ap-sel-label {
    margin-right: auto;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ap-foot {
    display: flex;
    gap: var(--sp-3);
  }
</style>
