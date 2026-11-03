<script lang="ts">
  /**
   * BlockNode — 表达式树的一个节点，渲染成一块积木（递归）。
   *
   * 结构：标题行（这块是什么 + 就地可编辑的字段）／子表达式（缩进的插槽）。
   * 每个插槽里一定有一块积木 —— AST 里没有 null，空洞用「数值 0」占位，
   * 所以「这块还没填」和「这块填了 0」在视觉上必须区分开：占位块画成虚线。
   *
   * 换块：标题行的 ⋯ 打开调色板，选中即整块替换（当前子树会被丢掉，这一条
   * 是刻意的 —— 让「换类型」与「改这个值」是同一个位置上的一件事，而不是
   * 先去删、再去加）。
   *
   * **超出积木词汇表的子树**（`param` / 条件 / 比较）整块渲染成只读的「文本」
   * 块，显示它自己的源码。不假装能编辑：能编辑的形状必须是能打印回去的。
   */
  import BlockNode from './BlockNode.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Menu from '../controls/Menu.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Select from '../controls/Select.svelte';
  import { fitsBlocks, printExpr, slotAt, slotCount, type ExprNode } from '../../core/expr';
  import type { Modulator } from '../../core/modulation';
  import type { MenuItem } from '../controls/menu-model';
  import { blockGroups } from './block-palette';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    node: ExprNode;
    path: number[];
    mods: readonly Modulator[];
    /** 当前调制器自己的 id：不出现在「引用调制器」的候选里（自引用恒为环）。 */
    selfId: string | null;
    onpatch: (path: number[], next: ExprNode) => void;
  }
  const { node, path, mods, selfId, onpatch }: Props = $props();

  let anchor = $state<HTMLElement | null>(null);
  let menuOpen = $state(false);

  const slots = $derived(slotCount(node));
  const editable = $derived(fitsBlocks(node));

  /** 别的调制器（不含自己）。 */
  const refs = $derived(mods.filter((m) => m.id !== selfId));
  const modOptions = $derived(
    refs.map((m) => ({ value: m.id, label: m.name })),
  );

  const kindLabel = $derived.by(() => {
    switch (node.k) {
      case 'num':
        return tr('mod.blk.num');
      case 'time':
        return tr('mod.blk.time');
      case 'beat':
        return tr('mod.blk.beat');
      case 'mod':
        return tr('mod.blk.mod');
      case 'un':
        return tr('mod.blk.unary');
      case 'bin':
        return tr('mod.blk.add');
      case 'call':
        return node.fn;
      default:
        return tr('mod.blk.text');
    }
  });

  /**
   * 调色板。用二级菜单按组分开：一次平铺二十几项，长度不可预期，
   * 而「值 / 时间 / 引用 / 数学 / 波形」这个分组就是用户心里的索引。
   */
  const items = $derived.by<MenuItem[]>(() =>
    blockGroups().map((g) => ({
      id: g.id,
      label: tr(g.labelKey),
      testid: `mod-pal-group-${g.id}`,
      children: g.items.map((tpl) => ({
        id: tpl.id,
        testid: `mod-pal-${tpl.id}`,
        label: tpl.label ?? (tpl.labelKey ? tr(tpl.labelKey) : tpl.id),
        onselect: () => onpatch(path, tpl.make(refs[0]?.id)),
      })),
    })),
  );

  function patch(next: ExprNode): void {
    onpatch(path, next);
  }

  function child(i: number): ExprNode {
    return slotAt(node, i) ?? { k: 'num', v: 0 };
  }

  /**
   * 插槽的占位判定：子块是「数值 0」时画虚线，提示这里还没被填过。
   * 只看值不看语义 —— 用户主动想乘 0 的情况极罕见，而「没填」的视觉提示值钱。
   */
  function isPlaceholder(i: number): boolean {
    const c = slotAt(node, i);
    return !!c && c.k === 'num' && c.v === 0;
  }

  /** 二元运算的操作符也允许就地换（乘改加不该要重开调色板）。 */
  const binOps = ['+', '-', '*', '/', '%'] as const;
</script>

<div class="blk" class:dash={node.k === 'num' && node.v === 0} data-testid="mod-block">
  <div class="row">
    <span class="chip" data-testid="mod-block-kind">{kindLabel}</span>

    {#if node.k === 'num'}
      <NumberInput
        value={node.v}
        step={0.01}
        width={78}
        ariaLabel={tr('mod.blk.num')}
        onchange={(v) => patch({ k: 'num', v })}
      />
    {:else if node.k === 'mod'}
      {#if modOptions.length > 0}
        <Select
          value={node.id}
          options={modOptions}
          ariaLabel={tr('mod.blk.mod')}
          testid="mod-block-ref"
          onchange={(v) => patch({ k: 'mod', id: String(v) })}
        />
      {:else}
        <span class="note">{tr('mod.blk.noMod')}</span>
      {/if}
    {:else if node.k === 'bin'}
      <!-- 操作符做成一段小按钮组：五个字符，比下拉更快点到。 -->
      <span class="ops">
        {#each binOps as op (op)}
          <button
            type="button"
            class="op"
            class:on={node.op === op}
            data-testid={`mod-block-op-${op}`}
            onclick={() => node.k === 'bin' && patch({ ...node, op })}
          >
            {op}
          </button>
        {/each}
      </span>
    {/if}

    <span class="grow"></span>
    <span bind:this={anchor}>
      <IconButton
        icon="ellipsis-vertical"
        label={tr('mod.blk.pick')}
        size="sm"
        testid="mod-block-menu"
        onclick={() => (menuOpen = true)}
      />
    </span>
  </div>

  {#if slots > 0}
    <div class="kids">
      {#each Array.from({ length: slots }, (_, i) => i) as i (i)}
        <div class="kid" class:ph={isPlaceholder(i)}>
          <BlockNode
            node={child(i)}
            path={[...path, i]}
            {mods}
            {selfId}
            {onpatch}
          />
        </div>
      {/each}
    </div>
  {/if}

  {#if !editable}
    <div class="raw mono" data-testid="mod-block-raw">{printExpr(node)}</div>
    <div class="note">{tr('mod.blocksUnsupported')}</div>
  {/if}
</div>

{#if menuOpen}
  <Menu {items} anchorEl={anchor} testid="mod-block-palette" onclose={() => (menuOpen = false)} />
{/if}

<style>
  .blk {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    min-width: 0;
  }
  /* 占位块：虚线边框。它是「这里还没填」，与「填了 0」是两个意思。 */
  .blk.dash {
    background: transparent;
    border-style: dashed;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .chip {
    flex: none;
    padding: 0 5px;
    height: 18px;
    line-height: 18px;
    background: var(--surface-3, var(--surface-2));
    border-radius: 3px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .kids {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* 缩进 + 一条竖线：一条线就够表达「这些是上一块的子项」。 */
    margin-left: 3px;
    padding-left: 10px;
    border-left: 1px solid var(--border);
  }
  .kid {
    min-width: 0;
  }
  .ops {
    display: inline-flex;
    gap: 1px;
  }
  .op {
    width: 20px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--input-border);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .op.on {
    color: var(--accent-contrast, #fff);
    background: var(--accent);
    border-color: var(--accent);
  }
  .note {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .mono {
    font-family: 'Cascadia Code', Consolas, monospace;
  }
  .raw {
    padding: 3px 5px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    overflow-x: auto;
    white-space: pre;
  }
</style>
