<script lang="ts">
  /**
   * SubagentCard — 一张子代理卡（折叠）。
   *
   * 与 `ToolCallCard` 同一套视觉语言，但多一层：**子代理自己的工具调用留在卡里**。
   * 父对话只看得到结论，过程需要展开才看得见 —— 这正是子代理省上下文的方式，
   * 所以「过程在哪」必须在界面上是明确的，而不是消失。
   *
   * 里层工具的 `callId` 只在**那个会话内**唯一，父子的 `call_0` 必然撞号，
   * 所以这里按数组顺序渲染，不参与全局索引。
   */
  import Icon from '../Icon.svelte';
  import ToolCallCard from './ToolCallCard.svelte';
  import type { AgentMessage } from './agent-state.svelte';
  import { agentState } from './agent-state.svelte';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    msg: AgentMessage;
  }
  const { msg }: Props = $props();

  let open = $state(false);

  $effect(() => {
    // 整轮结束就收起来（与工具卡同一条纪律：用户要的是结论，不是铺满面板的过程）。
    if (!agentState.busy && msg.subagent?.status !== 'running') open = false;
  });

  const sub = $derived(msg.subagent);
  const status = $derived(sub?.status ?? 'running');

  const presetLabel = $derived(
    sub?.preset === 'review'
      ? tr('agent.subagent.presetReview')
      : sub?.preset === 'code'
        ? tr('agent.subagent.presetCode')
        : tr('agent.subagent.presetExplore'),
  );

  const statusText = $derived(
    status === 'running'
      ? tr('agent.subagent.running')
      : status === 'cancelled'
        ? tr('agent.subagent.cancelled')
        : status === 'error'
          ? tr('agent.subagent.failed')
          : tr('agent.subagent.done'),
  );
</script>

<div
  class="sub-card"
  class:running={status === 'running'}
  class:error={status === 'error'}
  class:cancelled={status === 'cancelled'}
  data-testid="agent-subagent-card"
  data-agent={sub?.agentId}
  data-status={status}
>
  <button type="button" class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="dot" aria-hidden="true"></span>
    <span class="name">{presetLabel}</span>
    <span class="status">{statusText}</span>
    <span class="spacer"></span>
    {#if sub?.writes}
      <span class="badge">{tr('agent.subagent.writes', { n: sub.writes })}</span>
    {/if}
    {#if sub?.ms !== undefined}
      <span class="ms">{(sub.ms / 1000).toFixed(1)}s</span>
    {/if}
    <span class="caret"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
  </button>

  {#if sub}
    <p class="task">{sub.task}</p>

    {#if !open && sub.summary}
      <p class="summary">{sub.summary}</p>
    {/if}

    {#if open}
      <div class="body">
        {#each sub.tools as inner (inner.id)}
          {#if inner.role === 'tool'}
            <ToolCallCard msg={inner} />
          {:else if inner.role === 'image'}
            {#if inner.image}
              <img
                class="shot"
                src={`data:${inner.image.mimeType};base64,${inner.image.base64}`}
                alt={inner.text}
              />
            {/if}
          {:else if inner.role === 'notice'}
            <p class="notice">{inner.text}</p>
          {/if}
        {/each}
        {#if sub.text}
          <pre class="answer">{sub.text}</pre>
        {/if}
        {#if sub.summary}
          <div class="label">{tr('agent.subagent.result')}</div>
          <pre class="answer">{sub.summary}</pre>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .sub-card {
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
  .dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .sub-card.running .dot {
    background: var(--accent);
    animation: sub-pulse 1s ease-in-out infinite;
  }
  .sub-card.error .dot {
    background: var(--danger);
  }
  .sub-card.cancelled .dot {
    background: var(--warning, var(--text-muted));
  }
  .name {
    color: var(--text-primary);
    font-size: 11px;
  }
  .status {
    color: var(--text-muted);
    font-size: 10px;
  }
  .badge {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--text-secondary);
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
  .task {
    margin: 0;
    padding: 0 var(--sp-2) 4px;
    color: var(--text-muted);
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .summary {
    margin: 0;
    padding: 0 var(--sp-2) var(--sp-2);
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 0 var(--sp-2) var(--sp-2);
  }
  .label {
    margin: 4px 0 2px;
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .notice {
    margin: 0;
    color: var(--text-muted);
    font-size: 10px;
  }
  .shot {
    width: 100%;
    border-radius: 3px;
    border: 1px solid var(--border);
  }
  pre.answer {
    margin: 0;
    padding: var(--sp-2);
    max-height: 220px;
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
  @keyframes sub-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
