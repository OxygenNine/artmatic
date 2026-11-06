<script lang="ts">
  /**
   * PluginApprovalCard — 插件安装的确认卡。
   *
   * 这是「插件是任意代码」这条安全边界的**唯一 UI 出口**（与 `PluginImportDialog`
   * 同一套告知；文案在 `agent.approval.*`，别弱化）。用户能展开看源码 ——
   * 批准一个自己没看过的可执行文件是这个流程里最不该发生的事。
   */
  import Icon from '../Icon.svelte';
  import Button from '../controls/Button.svelte';
  import { agentState } from './agent-state.svelte';
  import { tr } from '../../i18n/index.svelte';

  let source = $state<string | null>(null);
  let loading = $state(false);
  /** 「本次会话允许试挂」（只在 `kind === 'try'` 时出现）。 */
  let rememberTry = $state(false);

  function approve(): void {
    agentState.resolveApproval(true, rememberTry);
    rememberTry = false;
  }

  function reject(): void {
    agentState.resolveApproval(false);
    rememberTry = false;
  }

  async function toggleSource(): Promise<void> {
    if (source !== null) {
      source = null;
      return;
    }
    const id = agentState.pending?.pluginId;
    if (!id) return;
    loading = true;
    source = (await agentState.pluginSource(id)) ?? '';
    loading = false;
  }
</script>

{#if agentState.pending}
  {@const isTry = agentState.pending.kind === 'try'}
  {@const isMedia = agentState.pending.kind === 'media'}
  <div class="approval" data-testid="agent-approval" data-kind={agentState.pending.kind}>
    <div class="title">
      <Icon name="triangle-alert" size={13} />
      <span>
        {tr(
          isMedia
            ? 'agent.approval.mediaTitle'
            : isTry
              ? 'agent.approval.tryTitle'
              : 'agent.approval.title',
        )}
      </span>
      <code>{isMedia ? (agentState.pending.media?.op ?? '') : agentState.pending.pluginId}</code>
    </div>
    <p>
      {tr(
        isMedia
          ? 'agent.approval.mediaBody'
          : isTry
            ? 'agent.approval.tryBody'
            : 'agent.approval.body',
        isMedia
          ? {
              op: agentState.pending.media?.op ?? '',
              name: agentState.pending.media?.assetName ?? agentState.pending.media?.assetId ?? '—',
            }
          : {},
      )}
    </p>
    {#if isTry}
      <label class="remember">
        <input type="checkbox" data-testid="agent-approval-allow" bind:checked={rememberTry} />
        <span>{tr('agent.approval.allowTry')}</span>
      </label>
    {/if}
    <div class="row">
      {#if !isMedia}
        <Button
          label={tr('agent.approval.source')}
          variant="ghost"
          disabled={loading}
          testid="agent-approval-source"
          onclick={() => void toggleSource()}
        />
      {/if}
      <span class="spacer"></span>
      <Button
        label={tr('agent.approval.reject')}
        variant="outline"
        testid="agent-approval-reject"
        onclick={reject}
      />
      <Button
        label={tr(
          isMedia
            ? 'agent.approval.mediaRun'
            : isTry
              ? 'agent.approval.run'
              : 'agent.approval.install',
        )}
        variant="accent"
        testid="agent-approval-install"
        onclick={approve}
      />
    </div>
    {#if source !== null}
      <pre data-testid="agent-approval-code">{source || '—'}</pre>
    {/if}
  </div>
{/if}

<style>
  .approval {
    margin: 0 var(--sp-3) var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border);
    border-left: 2px solid var(--warning);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .title {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 500;
  }
  .title :global(svg) {
    color: var(--warning);
    flex-shrink: 0;
  }
  .title code {
    padding: 0 3px;
    border-radius: 3px;
    background: var(--surface-0);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  p {
    margin: var(--sp-2) 0;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
  }
  .remember {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-2);
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
    cursor: pointer;
  }
  .remember input {
    margin: 0;
    accent-color: var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .spacer {
    flex: 1;
  }
  pre {
    margin: var(--sp-2) 0 0;
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
</style>
