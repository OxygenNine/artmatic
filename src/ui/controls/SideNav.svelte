<script lang="ts" generics="Id extends string">
  /**
   * SideNav — 「navside + 内容」型 modal 的左侧分页条（设置 / 工程）。
   *
   * 为什么抽出来：同一套外观要在两个面板里各出现一次。分头写的话，宽度、
   * hover、选中态那点主题色迟早会漂移，而且是从「看起来差不多」慢慢变成
   * 「哪个才是对的」。这里只管导航本身，右侧内容列由调用方写 —— 内容列要能
   * 自己滚动，navside 独立滚动，两者都不该由这个组件决定。
   *
   * 它不认识任何 store，只吃 items + value，所以放在 controls/ 里。
   */
  interface Item {
    id: Id;
    label: string;
  }

  interface Props {
    items: Item[];
    value: Id;
    /** 无障碍名（通常是面板标题）。 */
    label: string;
    /** testid 前缀：nav 本身是 `<prefix>`，每项是 `<prefix>-<id>`。 */
    testidPrefix: string;
    onselect: (id: Id) => void;
  }
  const { items, value, label, testidPrefix, onselect }: Props = $props();
</script>

<nav class="sidenav" aria-label={label} data-testid={testidPrefix}>
  {#each items as it (it.id)}
    <button
      type="button"
      class="sidenav-item"
      class:active={value === it.id}
      aria-current={value === it.id ? 'page' : undefined}
      data-testid={`${testidPrefix}-${it.id}`}
      onclick={() => onselect(it.id)}
    >
      {it.label}
    </button>
  {/each}
</nav>

<style>
  .sidenav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: var(--sp-4) var(--sp-3);
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .sidenav-item {
    padding: 5px var(--sp-4);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .sidenav-item:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  /* 当前分页用主题色 —— 「主题色只出现在选中/激活」的一处。 */
  .sidenav-item.active {
    background: var(--surface-3);
    color: var(--text-primary);
    font-weight: 700;
  }
</style>
