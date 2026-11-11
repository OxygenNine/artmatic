<script lang="ts">
  /**
   * PluginDock — 右侧常驻的插件面板列（多个 dock 面板共用一条 tab 条）。
   *
   * 只在**时间轴页**出现：调色页 / 粒子页各自改写了 `.body` 的
   * `grid-template-columns`，往那两套模板里塞第四列会一起改坏。切到那两个页面
   * 时本组件保留「哪些面板开着」的状态，只是不渲染 —— 回来时原样恢复。
   *
   * tab 条高 26px，与 Ribbon tab 同高；激活态文字转 accent + 底部 2px accent 线。
   */
  import IconButton from '../controls/IconButton.svelte';
  import PluginPanelMount from './PluginPanelMount.svelte';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { closePanel, dockKey, panelKey, setDockKey } from './plugin-panels';

  const items = $derived.by(() => {
    void appState.pluginRevision;
    void appState.pluginPanelRevision;
    const key = appState.activeProjectId;
    const open = appState.pluginPanels.open;
    return appState.plugins
      .panelsFor(key)
      .filter((e) => e.panel.kind === 'dock')
      .map((e) => ({
        pluginId: e.pluginId,
        def: e.panel,
        key: panelKey(e.pluginId, e.panel.id),
        title: resolveLabel(e.panel.name, tr),
      }))
      .filter((e) => open.includes(e.key));
  });

  /*
   * 当前 tab：会话里记的那个还在就用它，否则退回第一个。
   *
   * 不把「退回」写回状态 —— 那会在每次重建时推一次会话落盘（而且用户可能只是
   * 暂时关掉了那个面板）。
   */
  const active = $derived.by(() => {
    const saved = dockKey();
    return items.find((i) => i.key === saved) ?? items[0] ?? null;
  });
</script>

{#if items.length > 0 && appState.activeProject.view.kind === 'timeline'}
  <aside class="dock plugin-dock" data-testid="plugin-dock">
    <div class="tabs" role="tablist">
      {#each items as item (item.key)}
        <button
          type="button"
          class="tab"
          class:on={active?.key === item.key}
          role="tab"
          aria-selected={active?.key === item.key}
          data-testid="plugin-dock-tab"
          data-plugin-panel={item.key}
          title={item.title}
          onclick={() => setDockKey(item.key)}
        >
          {item.title}
        </button>
      {/each}
      <span class="grow"></span>
      {#if active}
        <IconButton
          icon="x"
          label={tr('pl.panel.close')}
          size="sm"
          testid="plugin-dock-close"
          onclick={() => closePanel(active.key)}
        />
      {/if}
    </div>
    <div class="body">
      {#if active}
        <PluginPanelMount pluginId={active.pluginId} def={active.def} />
      {/if}
    </div>
  </aside>
{/if}

<style>
  .dock {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-1);
    border-left: 1px solid var(--input-border);
    overflow: hidden;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 26px;
    flex-shrink: 0;
    padding: 0 var(--sp-1) 0 var(--sp-2);
    background: var(--surface-2);
    border-bottom: 1px solid var(--input-border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    height: 26px;
    padding: 0 var(--sp-2);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: var(--fs-sm);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.on {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .grow {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
  }
</style>
