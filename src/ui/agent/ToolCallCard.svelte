<script lang="ts">
  /**
   * ToolCallCard — 一条工具调用的折叠卡。
   *
   * 三件不显然的事：
   *  1. **标题是显示名，不是工具 id**：用户看的是「设置轨道」而不是
   *     `set_track`（文案表 `agent.toolName.*`，缺键时回落到 id）。
   *  2. 状态用**名字前的一个小圆点**编码（绿 / 红 / 主题色脉冲），不靠左边框
   *     的色条 —— 那一列颜色在密集列表里几乎看不见。
   *  3. 默认折叠；失败时**在生成过程中**自动展开一次，整轮结束后统一折叠
   *     （用户要的是「过程收起来」，不是十几张卡片铺满面板）。
   */
  import Icon from '../Icon.svelte';
  import type { AgentMessage } from './agent-state.svelte';
  import { agentState } from './agent-state.svelte';
  import { toolLabel } from './tool-labels';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    msg: AgentMessage;
  }
  const { msg }: Props = $props();

  let open = $state(false);
  let autoOpened = false;

  $effect(() => {
    // 生成过程中失败 → 自动展开一次；用户手动折叠后不再强行拉开。
    if (!autoOpened && msg.toolStatus === 'error' && agentState.busy) {
      autoOpened = true;
      open = true;
    }
  });

  $effect(() => {
    // 整轮结束：把过程收起来（包括失败卡；用户想看再点开）。
    if (!agentState.busy && msg.toolStatus !== 'running') open = false;
  });

  const statusText = $derived(
    msg.toolStatus === 'running'
      ? tr('agent.tool.running')
      : msg.toolStatus === 'error'
        ? tr('agent.tool.error')
        : tr('agent.tool.ok'),
  );

  function pretty(v: unknown): string {
    if (v === undefined) return '';
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s;
    } catch {
      return String(v);
    }
  }
</script>

<div
  class="tool-card"
  class:running={msg.toolStatus === 'running'}
  class:error={msg.toolStatus === 'error'}
  class:ok={msg.toolStatus === 'ok'}
  data-testid="agent-tool-card"
  data-tool={msg.toolName}
  data-status={msg.toolStatus}
>
  <button type="button" class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="dot" aria-hidden="true"></span>
    <span class="name">{toolLabel(msg.toolName ?? '')}</span>
    <span class="status">{statusText}</span>
    {#if msg.code}<span class="code">{msg.code}</span>{/if}
    <span class="spacer"></span>
    {#if msg.ms !== undefined}
      <span class="ms">{msg.ms} ms</span>
    {/if}
    <span class="caret"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
  </button>

  {#if open}
    <div class="body">
      <div class="label">{tr('agent.tool.args')}</div>
      <pre>{pretty(msg.args)}</pre>
      {#if msg.text}
        <div class="label">{tr('agent.tool.result')}</div>
        <pre class:err={msg.toolStatus === 'error'}>{pretty(msg.text)}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-card {
    flex: 0 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    font-size: var(--fs-sm);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: 4px var(--sp-2);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .head:hover {
    background: var(--surface-hover);
  }
  /*
   * 状态点：成功绿、失败红、运行中主题色 + 呼吸。
   * 比左边框那一条色条更靠近文字，一眼能扫出一轮里哪一步坏了。
   */
  .dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .tool-card.ok .dot {
    background: var(--success);
  }
  .tool-card.error .dot {
    background: var(--danger);
  }
  .tool-card.running .dot {
    background: var(--accent);
    animation: tool-pulse 1s ease-in-out infinite;
  }
  .name {
    color: var(--text-primary);
    font-size: 11px;
  }
  .status {
    color: var(--text-muted);
    font-size: 10px;
  }
  .code {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .spacer {
    flex: 1;
  }
  .ms {
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .caret {
    display: inline-flex;
    color: var(--text-muted);
  }
  .body {
    padding: 0 var(--sp-2) var(--sp-2);
  }
  .label {
    margin: 4px 0 2px;
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  pre {
    margin: 0;
    padding: var(--sp-2);
    max-height: 180px;
    overflow: auto;
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre.err {
    color: var(--danger);
  }
  @keyframes tool-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tool-card.running .dot {
      animation: none;
    }
  }
</style>
