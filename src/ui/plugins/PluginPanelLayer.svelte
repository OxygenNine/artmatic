<script lang="ts">
  /**
   * PluginPanelLayer — 插件面板的根级挂载层（浮窗 + 模态）。
   *
   * 挂在 `App.svelte` 的 shell **之外**：抽屉 / 检查器都带 `z-index`，是层叠
   * 上下文，浮窗落在里面会被它们的背景盖住（与 `controls/Modal` 的 portal
   * 同一个问题）。停靠列不在这里 —— 它是 `.body` 的一条网格轨道。
   *
   * 收敛（`prunePanelState`）也在这里做：插件被停用 / 移除 / 热重载后，
   * 会话里属于它的面板键要一起消失，否则下次打开会尝试渲染一个不存在的面板。
   */
  import Modal from '../controls/Modal.svelte';
  import PluginFloatingFrame from './PluginFloatingFrame.svelte';
  import PluginPanelMount from './PluginPanelMount.svelte';
  import { appState } from '../app-state.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { tr } from '../../i18n/index.svelte';
  import { closePanel, isPanelStateReady, panelKey, prunePanelState } from './plugin-panels';

  const items = $derived.by(() => {
    void appState.pluginRevision;
    void appState.pluginPanelRevision;
    const key = appState.activeProjectId;
    const open = appState.pluginPanels.open;
    return appState.plugins
      .panelsFor(key)
      .map((e) => ({
        pluginId: e.pluginId,
        def: e.panel,
        key: panelKey(e.pluginId, e.panel.id),
        title: resolveLabel(e.panel.name, tr),
      }))
      .filter((e) => open.includes(e.key));
  });

  const floats = $derived(items.filter((i) => i.def.kind === 'float'));
  const modals = $derived(items.filter((i) => i.def.kind === 'modal'));

  /*
   * 插件集合变化：把已经不存在于清单里的键从会话状态里摘掉。
   *
   * ⚠️ **插件挂完之前不能剪**：打开工程是「先读 session、再挂插件」。挂载完成
   * 之前 `panelsFor()` 是空的，剪一次就会把刚恢复的面板全删掉 —— 表现是
   * 「重开工程面板不见了」，而且不报错。就绪标记由 `project-actions` 在
   * `mountPlugins` 之后打（`markPanelStateReady`）。
   */
  $effect(() => {
    const project = appState.activeProjectId;
    void appState.pluginRevision;
    void appState.pluginPanelRevision;
    if (!isPanelStateReady(project)) return;
    prunePanelState(
      new Set(appState.plugins.panelsFor(project).map((e) => panelKey(e.pluginId, e.panel.id))),
    );
  });
</script>

{#each floats as item, i (item.key)}
  <PluginFloatingFrame
    panelKey={item.key}
    title={item.title}
    def={item.def}
    layer={i}
    onclose={() => closePanel(item.key)}
  >
    <PluginPanelMount pluginId={item.pluginId} def={item.def} />
  </PluginFloatingFrame>
{/each}

{#each modals as item (item.key)}
  <Modal
    title={item.title}
    width="normal"
    flushBody
    testid="plugin-panel-modal"
    onclose={() => closePanel(item.key)}
  >
    <div class="modal-body" data-plugin-panel={item.key}>
      <PluginPanelMount pluginId={item.pluginId} def={item.def} />
    </div>
  </Modal>
{/each}

<style>
  .modal-body {
    display: flex;
    /* 固定高度：插件的界面自己滚动，模态框不该随内容跳高。 */
    height: min(60vh, 520px);
    min-height: 240px;
  }
</style>
