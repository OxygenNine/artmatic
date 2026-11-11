<script lang="ts">
  /**
   * PluginPanelFrame — 插件面板的 **Shadow DOM 容器**。
   *
   * 三件事：
   *  1. 给插件一块干净的 DOM（`render(el, api)` 的 `el`），它的 CSS 出不去；
   *  2. 把 token 桥接进去（CSS 自定义属性天然继承进 shadow tree，所以四套主题
   *     对插件内容自动生效，插件不需要知道自己处在哪套主题里）；
   *  3. 插件代码抛错时**不炸整个应用**：面板体内显示错误 + 重试，宿主记一条
   *     `panel-failed`。
   *
   * ⚠️ Shadow DOM 隔离的是**样式**，不是权限。插件仍然跑在主 realm、
   * 仍然能拿 `document` / `window`（见 `plugins/AGENTS.md` 的安全边界）。
   */
  import { tr } from '../../i18n/index.svelte';
  import type { PluginApi, PluginPanelDef } from '../../plugins/api-types';

  interface Props {
    def: PluginPanelDef;
    api: PluginApi;
    /** 同一句错误也进插件面板的问题列表（宿主去重）。 */
    onerror?: (detail: string) => void;
  }
  const { def, api, onerror }: Props = $props();

  let hostEl: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  /** 重试 = 换一个代次让 effect 重新跑一次 `render`。 */
  let revision = $state(0);

  /**
   * shadow root 里的基线样式。
   *
   * 只做两件事：`box-sizing` 与 token 桥接。**不注入控件样式** ——
   * 插件画的是自己的界面，宿主不给它一套「看起来像内置控件」的默认值，
   * 那会让用户分不清哪块是应用、哪块是插件。
   */
  const BASE_CSS = `
:host {
  display: block;
  height: 100%;
  min-height: 0;
  color: var(--text-primary);
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: var(--fs-sm, 12px);
  line-height: 1.45;
}
*, *::before, *::after { box-sizing: border-box; }
`;

  $effect(() => {
    const host = hostEl;
    if (!host) return;
    // 显式依赖代次：重试按钮只改它。
    void revision;

    let cleanup: (() => void) | null = null;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadow.replaceChildren();

    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    shadow.append(style);

    const mount = document.createElement('div');
    mount.setAttribute('data-plugin-root', '');
    mount.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';
    shadow.append(mount);

    error = null;
    try {
      const out = def.render(mount, api);
      if (typeof out === 'function') cleanup = out as () => void;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      error = detail;
      onerror?.(detail);
    }

    return () => {
      try {
        cleanup?.();
      } catch {
        // 插件的清理函数抛错不该影响宿主拆 DOM。
      }
      shadow.replaceChildren();
    };
  });
</script>

<div class="frame">
  <div class="host" bind:this={hostEl} class:has-error={error !== null}></div>
  {#if error}
    <div class="err" role="alert">
      <span class="msg">{tr('pl.panel.renderFailed', { detail: error })}</span>
      <button type="button" class="retry" onclick={() => revision++}>{tr('pl.panel.retry')}</button>
    </div>
  {/if}
</div>

<style>
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .host {
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .host.has-error {
    visibility: hidden;
  }
  .err {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: var(--sp-2);
    padding: var(--sp-4);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }
  .msg {
    color: var(--danger);
    word-break: break-word;
  }
  .retry {
    height: 22px;
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .retry:hover {
    background: var(--surface-hover);
  }
</style>
