<script lang="ts">
  /**
   * PluginPanelMount — 面板的「拿 API」薄壳。
   *
   * 面板可能在任何时刻被打开：插件刚挂上、预览还在装配、插件在后台工程里
   * 被激活过。这里负责把「确保激活 → 取 API」这一段异步补齐，再把 API 交给
   * 容器组件。取不到时什么都不画（不是错误：激活失败会在插件面板里记一条
   * `activate-failed`，那里才是排查的地方）。
   */
  import PluginPanelFrame from './PluginPanelFrame.svelte';
  import { appState } from '../app-state.svelte';
  import type { PluginApi, PluginPanelDef } from '../../plugins/api-types';

  interface Props {
    pluginId: string;
    def: PluginPanelDef;
  }
  const { pluginId, def }: Props = $props();

  let api = $state<PluginApi | null>(null);

  $effect(() => {
    let cancelled = false;
    const projectKey = appState.activeProjectId;
    // 实例会在 revision 变化时重建（热重载 / 停用再启用），那时要重新取 API。
    void appState.pluginRevision;

    /*
     * ⚠️ 这个 effect **只能读 `apiFor()`，不能读 `api`**。
     *
     * 写成 `api = apiFor(...); if (!api) { … }` 的话就是「effect 读写同一块
     * state」—— 每次打开面板都会抛 `effect_update_depth_exceeded`。
     * 判据用局部变量，结果照常写回 state。
     */
    const found = appState.plugins.apiFor(pluginId, projectKey);
    api = found;
    if (!found) {
      void appState.plugins.ensureActive(pluginId, projectKey).then((ok) => {
        if (!cancelled && ok) api = appState.plugins.apiFor(pluginId, projectKey);
      });
    }
    return () => {
      cancelled = true;
    };
  });

  function reportError(detail: string): void {
    appState.plugins.reportPanelFailure(pluginId, def.id, detail);
  }
</script>

{#if api}
  <PluginPanelFrame {def} {api} onerror={reportError} />
{/if}
