<script lang="ts">
  /**
   * TransitionPickerModal — 「设置出画转场」选择器。
   *
   * 换掉的是一个 `<select>`：转场到一百二十多条之后，下拉既不能搜、也看不见
   * 每条转场把两张图切成了什么样。这里给的是「搜索 + 两种视图 + 缩略图」的挑法，
   * 缩略图是**两张不同的底图在 50% 进度**的过渡状态（`gen-transition-thumbs.mjs`）。
   *
   * 与 `EffectPickerModal` 的三处不同，都是有理由的：
   *  1. **单选**（一个片段只有一条出画转场），所以是「选中 → 应用」而不是多选累积。
   *  2. **没有分类 / 标签筛选** —— 转场目录里没有这两项数据，硬造筛选是假选项。
   *  3. **带一个「无转场」磁贴**（对应旧下拉里的第一项「无」）：清除转场是一等操作，
   *     不该只能靠「找到一个 × 按钮」或重新打开下拉来完成。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import Icon from '../Icon.svelte';
  import Select from '../controls/Select.svelte';
  import TransitionCard from './TransitionCard.svelte';
  import { transitionThumbUrl } from './thumb-assets';
  import {
    TRANSITION_SORTS,
    buildItems,
    filterItems,
    labelOf,
    sortItems,
    type TransitionSort,
    type TransitionView,
  } from './picker-model';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';

  /** 排序选项的文案键（`TransitionSort` 是闭联合，索引结果仍是字面量键）。 */
  const SORT_LABEL_KEY: Record<TransitionSort, MessageKey> = {
    name: 'insp.transitionPickerSortName',
    author: 'insp.transitionPickerSortAuthor',
    id: 'insp.transitionPickerSortId',
  };

  interface Props {
    /** 工程里当前生效的转场 id；`null` = 没有转场。 */
    current: string | null;
    /** 确认：`''` 表示清除转场。 */
    onapply: (defId: string) => void;
    onclose: () => void;
  }
  const { current, onapply, onclose }: Props = $props();

  let query = $state('');
  let view = $state<TransitionView>('grid');
  let sort = $state<TransitionSort>('name');
  /**
   * 本次选择。`''` = 选中「无转场」。初值 = 当前生效的那条 ——
   * **只取挂载那一刻的快照**是刻意的：面板关闭即销毁，之后 store 再怎么变与这次
   * 选择无关（写成 derived 会让「打开后 store 恰好被撤销改动」时选择被冲掉）。
   */
  // svelte-ignore state_referenced_locally -- 只取挂载那一刻的快照，正是意图
  let selected = $state<string>(current ?? '');

  /**
   * 条目要写成 `$derived` 而不是普通 const：`buildItems(tr)` 会读语言状态，
   * 而 `tr()` 的 key 是模块加载时定的（见 AGENTS 的 i18n 一节）——
   * 冻结在初始化那一刻的形态是「切语言时这个面板不跟着变」。
   */
  const items = $derived(buildItems(tr));
  const visible = $derived(sortItems(filterItems(items, { query }), sort));
  const cards = $derived(visible.map((it) => ({ item: it, thumb: transitionThumbUrl(it.id) })));
  /** 搜索时把「无转场」磁贴收起来，让结果纯粹。 */
  const showNone = $derived(query.trim() === '');
  const selectedLabel = $derived(
    selected === '' ? tr('insp.transitionPickerNone') : (labelOf(items, selected) ?? selected),
  );

  const sortOptions = $derived(
    TRANSITION_SORTS.map((s) => ({ value: s, label: tr(SORT_LABEL_KEY[s]) })),
  );

  function apply(): void {
    onapply(selected);
  }
</script>

{#snippet footer()}
  <!-- `data-selected-id` 是给 E2E 的稳定判据：显示的文本是中文名（会随文案变，
       也随语言变），而 id 是工程里真正落库的那个值。 -->
  <span
    class="trp-sel-label"
    data-testid="transition-picker-selected"
    data-selected-id={selected}
  >
    {tr('insp.transitionPickerSelected', { name: selectedLabel })}
  </span>
  <div class="trp-foot">
    <Button
      label={tr('common.cancel')}
      variant="outline"
      testid="transition-picker-cancel"
      onclick={onclose}
    />
    <Button
      label={tr('insp.transitionPickerApply')}
      icon="check"
      variant="accent"
      testid="transition-picker-confirm"
      onclick={apply}
    />
  </div>
{/snippet}

<Modal title={tr('insp.setTransition')} testid="modal-transition-picker" width="picker" flushBody {onclose} {footer}>
  <div class="trp">
    <!-- 工具栏 -->
    <div class="trp-bar">
      <label class="trp-search">
        <Icon name="search" size={14} />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          autofocus
          data-testid="transition-picker-search"
          placeholder={tr('insp.transitionPickerSearch')}
          bind:value={query}
        />
      </label>

      <Button
        label={view === 'grid' ? tr('insp.pickerViewGrid') : tr('insp.pickerViewList')}
        icon={view === 'grid' ? 'layout-grid' : 'list'}
        variant="outline"
        tipText={view === 'grid' ? tr('insp.pickerViewGridTip') : tr('insp.pickerViewListTip')}
        testid="transition-picker-view"
        onclick={() => (view = view === 'grid' ? 'list' : 'grid')}
      />

      <Select
        value={sort}
        options={sortOptions}
        minWidth={124}
        ariaLabel={tr('insp.pickerSort')}
        testid="transition-picker-sort"
        optionTestidPrefix="transition-picker-sort-opt"
        onchange={(v) => (sort = v as TransitionSort)}
      />
    </div>

    <!-- 主体 -->
    <div class="trp-body" class:trp-grid={view === 'grid'} class:trp-list={view === 'list'}>
      {#if showNone}
        <div class="trp-slot">
          <button
            type="button"
            class="trp-card trp-none trp-{view}"
            class:trp-sel={selected === ''}
            data-testid="transition-picker-none"
            aria-pressed={selected === ''}
            onclick={() => (selected = '')}
          >
            <span class="trp-none-thumb"><Icon name="x" size={22} /></span>
            <span class="trp-none-meta">
              <span class="trp-none-name">{tr('insp.transitionPickerNone')}</span>
              <span class="trp-none-hint">{tr('insp.transitionPickerNoneHint')}</span>
            </span>
          </button>
        </div>
      {/if}

      {#each cards as c (c.item.id)}
        <div class="trp-slot">
          <TransitionCard
            item={c.item}
            {view}
            thumb={c.thumb}
            selected={selected === c.item.id}
            current={current === c.item.id}
            onpick={(id) => (selected = id)}
          />
        </div>
      {/each}

      {#if cards.length === 0 && !showNone}
        <p class="trp-empty" data-testid="transition-picker-empty">
          {tr('insp.transitionPickerEmpty')}
          <br /><span class="trp-empty-hint">{tr('insp.pickerEmptyHint')}</span>
        </p>
      {/if}
    </div>

    <div class="trp-status" data-testid="transition-picker-hit">
      {tr('insp.transitionPickerHit', { n: visible.length })}
    </div>
  </div>
</Modal>

<style>
  /* flex 列 + 主体自己滚动：modal 已 flushBody（见 Modal.svelte 的 width='picker'）。 */
  .trp {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  /* -------------------------------------------------------------- 工具栏 */
  .trp-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-shrink: 0;
    padding: var(--sp-4) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }
  .trp-search {
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
  .trp-search:focus-within {
    border-color: var(--accent);
  }
  .trp-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    outline: none;
  }

  /* ---------------------------------------------------------------- 主体 */
  .trp-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5);
  }
  .trp-body.trp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--sp-4);
    align-content: start;
  }
  /*
   * 列表形态：**宽度够就并两列**。
   *
   * 一排到底在一张 920px 宽的模态里只用掉左边半幅、右边一片空白 —— 列表行本身
   * 只有「96px 缩略图 + 一两行字」，没必要占满整行。`auto-fill` + 最小 340px：
   * 模态宽度来自 `min(920px, 94vw)`，窄屏（窗口 < 约 720px）自然退回一列。
   * 用 `auto-fill` 而不是 `auto-fit`：条目少时不留一条空白列被拉伸。
   */
  .trp-body.trp-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--sp-2) var(--sp-4);
    align-content: start;
  }
  .trp-slot {
    min-width: 0;
  }

  /* ------------------------------------------------------------ 无转场磁贴 */
  .trp-none {
    display: block;
    width: 100%;
    padding: 0;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .trp-none.trp-sel {
    border-style: solid;
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .trp-none.trp-grid .trp-none-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 16 / 9;
    color: var(--text-muted);
  }
  .trp-none.trp-grid .trp-none-meta {
    display: block;
    padding: var(--sp-2) var(--sp-3) var(--sp-3);
  }
  .trp-none.trp-list {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2);
  }
  .trp-none.trp-list .trp-none-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96px;
    aspect-ratio: 16 / 9;
    color: var(--text-muted);
  }
  .trp-none-name {
    display: block;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .trp-none-hint {
    display: block;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }

  .trp-empty {
    grid-column: 1 / -1;
    margin: var(--sp-6) 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    text-align: center;
  }
  .trp-empty-hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  /* 命中数：固定在主体下方，滚动时不跟着走 —— 它是筛选器的读数。 */
  .trp-status {
    flex-shrink: 0;
    padding: var(--sp-2) var(--sp-5);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  /* -------------------------------------------------------------- 底栏 */
  .trp-sel-label {
    margin-right: auto;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trp-foot {
    display: flex;
    gap: var(--sp-3);
  }
</style>
