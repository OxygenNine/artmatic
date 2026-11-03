<script lang="ts">
  /**
   * AgentRailButton — rail 上的 Agent 入口。
   *
   * 与其它 rail 图标共用 `.ic-btn` 的尺寸 / hover 规则（见 `controls.css`），
   * 额外承担一条**状态指示**：思考中一个旋转弧、调工具时右上角计数角标、
   * 等待确认时琥珀色慢脉冲、出错时变 danger。
   *
   * 全部动效是 CSS，`prefers-reduced-motion` 下只保留颜色变化 ——
   * 这个按钮在长时间思考时会一直转，动效必须能被关掉。
   */
  import Icon from '../Icon.svelte';
  import { agentState } from './agent-state.svelte';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import { tip } from '../tip';

  interface Props {
    /** 零工程时由 rail 传 true：Agent 的一切工具都作用在「当前工程」上。 */
    disabled?: boolean;
  }
  const { disabled = false }: Props = $props();

  const state = $derived.by(() => {
    // 插件审批与「模型在问你」都是「等你行动」，用同一个琥珀点。
    if (agentState.pending || agentState.pendingAsk) return 'approval';
    if (agentState.busy) return agentState.status === 'tool' ? 'tool' : 'thinking';
    const last = agentState.messages[agentState.messages.length - 1];
    if (last?.role === 'error' && !appState.agentOpen) return 'error';
    return 'idle';
  });

  const label = $derived.by(() => {
    switch (state) {
      case 'thinking':
        return tr('agent.status.thinking');
      case 'tool':
        return tr('agent.status.tool');
      case 'approval':
        return tr('agent.status.approval');
      case 'error':
        return tr('agent.status.error');
      default:
        return tr('agent.railTip');
    }
  });
</script>

<button
  type="button"
  class="ic-btn agent-rail"
  class:active={appState.agentOpen}
  data-state={state}
  data-testid="rail-agent"
  aria-label={label}
  aria-pressed={appState.agentOpen}
  {disabled}
  onclick={() => {
    // 收起面板时设置 modal 也跟着关：它挂在根级，不随抽屉卸载。
    if (appState.agentOpen) agentState.closeSettings();
    appState.toggleAgent();
  }}
  use:tip={{ text: label }}
>
  <span class="ring" aria-hidden="true"></span>
  <span class="glyph"><Icon name="sparkles" size={15} /></span>
  {#if agentState.busy && agentState.toolCalls > 0}
    <span class="badge" data-testid="rail-agent-count">{agentState.toolCalls}</span>
  {/if}
  {#if state === 'approval'}<span class="dot" aria-hidden="true"></span>{/if}
</button>

<style>
  .agent-rail {
    position: relative;
    overflow: visible;
  }
  .glyph {
    display: inline-flex;
  }
  /* 状态弧：默认不可见，思考时一段弧绕圈。 */
  .ring {
    position: absolute;
    inset: 4px;
    border: 1.5px solid transparent;
    border-radius: 50%;
    pointer-events: none;
  }
  .agent-rail[data-state='thinking'] .ring {
    border-top-color: var(--accent);
    border-right-color: var(--accent);
    animation: agent-spin 1.1s linear infinite;
  }
  .agent-rail[data-state='tool'] .glyph {
    color: var(--accent);
  }
  .agent-rail[data-state='error'] .glyph {
    color: var(--danger);
  }
  .badge {
    position: absolute;
    top: -2px;
    right: -3px;
    min-width: 12px;
    height: 12px;
    padding: 0 3px;
    border-radius: 6px;
    background: var(--text-secondary);
    color: var(--surface-0);
    font-size: 9px;
    line-height: 12px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .dot {
    position: absolute;
    top: 1px;
    right: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning, #d99a1f);
    animation: agent-pulse 1.6s ease-in-out infinite;
  }
  @keyframes agent-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes agent-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-rail[data-state='thinking'] .ring,
    .dot {
      animation: none;
    }
    .agent-rail[data-state='thinking'] .ring {
      border-color: var(--accent);
      opacity: 0.5;
    }
  }
</style>
