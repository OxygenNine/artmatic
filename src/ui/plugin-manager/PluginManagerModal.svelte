<script lang="ts">
  /**
   * PluginManagerModal — 插件管理面板。
   *
   * 三件事：看清单、导入、移除/启停。界面上刻意把**风险提示**放在导入的
   * 确认框里（而不是面板上）：它要在「用户已经选好文件、正要按下导入」那一刻
   * 出现才有人读；挂在面板顶部只会变成一段背景字。
   *
   * 数据流是「宿主 → 纯模型 → 这里画」：`plugin-panel-model` 负责把问题码
   * 翻成句子，本组件只管排版与交互。所以「某个坏插件显示成什么」能在单测里
   * 断言，不用开浏览器。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import PluginImportDialog from './PluginImportDialog.svelte';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import { buildPluginRows, summaryText } from './plugin-panel-model';
  import { beginImport, removePlugin, setPluginEnabled, type PickedPlugin } from '../plugin-actions';
  import {
    hookRegistryRevision,
    typoHookFailures,
  } from '../../typography/hook-registry';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  const rows = $derived.by(() => {
    // 依赖插件集合的版本号 —— 少了这一行，导入/移除之后列表不会重算。
    appState.pluginRevision;
    // 运行期钩子失败是另一份状态（不进 LoadedPlugin）：打开/保存/渲染时
    // 被拒绝的钩子记在 hook-registry 里，同样要在这里可见。
    void hookRegistryRevision();
    return buildPluginRows(appState.plugins.list(), tr, typoHookFailures());
  });
  const summary = $derived(summaryText(rows, tr));

  /** 选好了文件、等风险确认。 */
  let pending = $state<PickedPlugin | null>(null);
  /** 等移除确认的插件 id。 */
  let removing = $state<string | null>(null);
  /** 导入 / 移除进行中（按钮置灰，避免重复点）。 */
  let busy = $state(false);

  async function onPick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const pick = await beginImport();
      if (pick) pending = pick;
    } finally {
      busy = false;
    }
  }

  async function onConfirmRemove(): Promise<void> {
    const id = removing;
    removing = null;
    if (!id) return;
    await removePlugin(id);
  }

  /** 移除确认框上显示的名字（拿不到就退回 id）。 */
  const removingName = $derived(
    removing ? (appState.plugins.get(removing)?.name ?? removing) : '',
  );
</script>

<Modal title={tr('pl.title')} testid="modal-plugins" onclose={onclose}>
  <p class="lead">{tr('pl.subtitle')}</p>
  <p class="summary" data-testid="plugins-summary">{summary}</p>

  {#if rows.length === 0}
    <div class="empty" data-testid="plugins-empty">
      <p>{tr('pl.empty')}</p>
      <p class="hint">{tr('pl.emptyHint')}</p>
    </div>
  {/if}

  <ul class="list">
    {#each rows as row (row.id)}
      <li class="row" data-testid="plugin-row" data-plugin-id={row.id}>
        <div class="head">
          <span class="name" data-testid="plugin-name">{row.name}</span>
          <span class="chip tone-{row.tone}" data-testid="plugin-status">{row.statusLabel}</span>
          <span class="id mono">{row.id}</span>
        </div>

        {#if row.meta || row.counts}
          <div class="meta">
            {#if row.meta}<span>{row.meta}</span>{/if}
            {#if row.counts}<span>{row.counts}</span>{/if}
          </div>
        {/if}

        {#if row.disabledNote}
          <p class="note">{row.disabledNote}</p>
        {/if}

        {#if row.issues.length > 0}
          <ul class="issues" data-testid="plugin-issues">
            {#each row.issues as text, i (i)}
              <li>{text}</li>
            {/each}
          </ul>
        {/if}

        {#if row.runtimeIssues.length > 0}
          <ul class="issues" data-testid="plugin-hook-issues">
            {#each row.runtimeIssues as text, i (i)}
              <li>{text}</li>
            {/each}
          </ul>
        {/if}

        <div class="actions">
          <Button
            label={tr(row.enabled ? 'pl.disable' : 'pl.enable')}
            variant="outline"
            testid={`plugin-toggle-${row.id}`}
            onclick={() => void setPluginEnabled(row.id, !row.enabled)}
          />
          <Button
            label={tr('pl.remove')}
            variant="danger"
            testid={`plugin-remove-${row.id}`}
            onclick={() => (removing = row.id)}
          />
        </div>
      </li>
    {/each}
  </ul>

  <p class="foot-note">{tr('pl.note.scope')}</p>
  <p class="foot-note">{tr('pl.note.single')}</p>

  {#snippet footer()}
    <Button
      label={tr('pl.import')}
      icon="puzzle"
      variant="accent"
      disabled={busy}
      testid="plugins-import"
      onclick={() => void onPick()}
    />
    <Button label={tr('pl.close')} variant="outline" testid="plugins-close" onclick={onclose} />
  {/snippet}
</Modal>

{#if pending}
  <PluginImportDialog pick={pending} ondone={() => (pending = null)} />
{/if}

{#if removing}
  <ConfirmDialog
    title={tr('pl.removeConfirmTitle')}
    message={tr('pl.removeConfirmBody', { name: removingName })}
    confirmLabel={tr('pl.removeConfirmOk')}
    danger
    testid="plugin-remove-confirm"
    onconfirm={() => void onConfirmRemove()}
    oncancel={() => (removing = null)}
  />
{/if}

<style>
  .lead {
    margin: 0 0 var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    line-height: 1.6;
  }
  .summary {
    margin: 0 0 var(--sp-4);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .empty {
    padding: var(--sp-6) 0;
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .empty p {
    margin: 0;
  }
  .hint {
    margin-top: var(--sp-2) !important;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .name {
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  /*
   * 状态胶囊：**形状一致、只有颜色变**。用颜色区分是这里唯一合适的做法 ——
   * 四种状态的文字长短差得远（「正常」/「部分可用」/「加载失败」/「已停用」），
   * 靠位置或图标区分会随语言变。
   */
  .chip {
    padding: 1px 6px;
    border: 1px solid transparent;
    border-radius: 2px;
    background: var(--surface-active);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .chip.tone-ok {
    color: var(--success);
  }
  .chip.tone-warn {
    color: var(--warning);
  }
  .chip.tone-error {
    color: var(--danger);
  }
  .id {
    margin-left: auto;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .note {
    margin: var(--sp-2) 0 0;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .issues {
    margin: var(--sp-2) 0 0;
    padding-left: 1.1em;
    color: var(--danger);
    font-size: var(--fs-xs);
    line-height: 1.55;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }
  .foot-note {
    margin: var(--sp-4) 0 0;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
</style>
