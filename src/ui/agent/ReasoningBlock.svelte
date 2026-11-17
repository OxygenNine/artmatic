<script lang="ts">
  /**
   * ReasoningBlock — 模型的思考过程（`delta.reasoning_content`）。
   *
   * 生成中默认展开（用户能看见它在干什么），整轮结束自动折叠。
   * 这是**内部推理**，样式上刻意比回答弱一档（muted + 左侧竖线），
   * 免得被误读成「已经做完的事」。
   *
   * 正文容器有 `max-height`（推理可以很长，不该把回复挤到屏幕外），所以**必须自己
   * 跟随底部**：文字一直在末尾追加，不跟随的话用户永远只看得见最开头那几行，
   * 还得手动往下拖。跟随用「松手即停」的开关而不是每帧强行贴底 —— 用户往上翻去读
   * 前面时不能被拽回来。整轮结束后再手动展开则**留在顶部**（那时用户是从头读）。
   */
  import Icon from '../Icon.svelte';
  import { agentState } from './agent-state.svelte';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    text: string;
  }
  const { text }: Props = $props();

  let open = $state(agentState.busy);
  let textEl = $state<HTMLDivElement | null>(null);
  /** 贴底跟随。用户手动往上翻时置 false，滚回底部再恢复。 */
  let stick = $state(true);

  $effect(() => {
    if (!agentState.busy) open = false;
  });

  $effect(() => {
    // 依赖正文长度与展开状态：折叠时元素不在 DOM 里，展开后要立刻补一次。
    void text.length;
    if (!open || !agentState.busy) return;
    const el = textEl;
    if (el && stick) el.scrollTop = el.scrollHeight;
  });

  function onScroll(): void {
    const el = textEl;
    if (!el) return;
    stick = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
  }
</script>

<div class="reasoning" data-testid="agent-reasoning">
  <button type="button" class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <Icon name="brain" size={11} />
    <span class="label">{tr('agent.reasoning')}</span>
    <span class="spacer"></span>
    <span class="caret"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
  </button>
  {#if open}
    <div class="text" data-testid="agent-reasoning-text" bind:this={textEl} onscroll={onScroll}>{text}</div>
  {/if}
</div>

<style>
  .reasoning {
    flex: 0 0 auto;
    border-left: 2px solid var(--border-strong, var(--border));
    padding-left: var(--sp-2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 0;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 10px;
    text-align: left;
    cursor: pointer;
  }
  .head:hover {
    color: var(--text-secondary);
  }
  .label {
    color: var(--text-secondary);
    letter-spacing: 0.04em;
  }
  .spacer {
    flex: 1;
  }
  .caret {
    display: inline-flex;
  }
  .text {
    max-height: 220px;
    overflow-y: auto;
    padding: 2px var(--sp-2) var(--sp-2) 0;
    color: var(--text-muted);
    font-size: 10px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
