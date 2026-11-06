<script lang="ts">
  /**
   * ModulatorDrawer — 左侧的调制器列表（窄侧栏那颗 `square-function` 打开的）。
   *
   * 它必须是**抽屉**而不是 modal：绑定手势是「从列表把条目拖到参数行上」，
   * 而参数行在右侧检查器里。modal 会把整屏盖住，那条手势就不成立了。
   *
   * 与媒体池 / Agent 共用左列（三者互斥，见 `appState.setModulatorOpen`），
   * 宽度也共用 `mediaPoolWidth` —— 同一列的两个内容不该有两套宽度记忆。
   */
  import Icon from '../Icon.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Button from '../controls/Button.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import { appState } from '../app-state.svelte';
  import { modulatorRefs, type Modulator } from '../../core/modulation';
  import { MOD_DRAG_TYPE } from './drag';
  import { tr } from '../../i18n/index.svelte';

  const list = $derived.by<Modulator[]>(() => {
    void appState.version;
    return appState.project.modulators ?? [];
  });

  /** 待确认删除的调制器（模态确认，与「关闭未保存工程」同一套）。 */
  let pending = $state<Modulator | null>(null);
  let resizing = $state(false);

  /**
   * 拖宽：与媒体池同一条手势（热区在右边缘，往右拖变宽），写的是**同一个**
   * `mediaPoolWidth` —— 左列两个内容共用一列宽度，分开记会让切换时画面跳一下。
   */
  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = appState.mediaPoolWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent): void => {
      appState.setMediaPoolWidth(startW + (ev.clientX - startX));
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      resizing = false;
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  const pendingRefs = $derived(
    pending ? modulatorRefs(list, appState.store.allClips(), pending.id) : [],
  );

  function refCount(id: string): number {
    return modulatorRefs(list, appState.store.allClips(), id).reduce((n, r) => n + r.slots, 0);
  }

  function create(): void {
    const id = appState.store.addModulator();
    if (!id) {
      appState.flash(tr('mod.tooMany', { max: 64 }));
      return;
    }
    appState.openModulatorEditor(id);
  }

  function confirmRemove(): void {
    const target = pending;
    pending = null;
    if (!target) return;
    appState.store.removeModulator(target.id);
    if (appState.modulatorEditId === target.id) appState.closeModulatorEditor();
  }

  function onDragStart(e: DragEvent, id: string): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(MOD_DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = 'copy';
  }
</script>

<aside
  class="mod-drawer"
  class:resizing
  data-testid="mod-drawer"
  style:width={`${appState.mediaPoolWidth}px`}
  role="presentation"
>
  <div
    class="drawer-resize"
    role="separator"
    aria-label={tr('mod.resize')}
    aria-orientation="vertical"
    data-testid="mod-drawer-resize"
    onpointerdown={startResize}
  ></div>

  <div class="drawer-head">
    <span class="drawer-title">
      <Icon name="square-function" size={12} />
      {tr('mod.title')}
    </span>
    <IconButton
      icon="x"
      label={tr('mod.close')}
      size="sm"
      testid="mod-drawer-close"
      onclick={() => appState.setModulatorOpen(false)}
    />
  </div>

  <div class="mod-list" role="list" data-testid="mod-list">
    {#if list.length === 0}
      <div class="empty">
        <p>{tr('mod.empty')}</p>
        <p class="dim">{tr('mod.emptyHint')}</p>
      </div>
    {/if}
    {#each list as m (m.id)}
      <!--
        `draggable` 走原生 HTML5 拖放：目标（检查器里的参数行）在另一个组件树里，
        指针手势要跨组件传递状态就得引入一份全局「正在拖谁」的临时状态，
        而那种状态会在 Esc / 窗口失焦时漏清理（拖影消失了但绑定还挂着）。
      -->
      <div
        class="mod-item"
        class:editing={appState.modulatorEditId === m.id}
        draggable="true"
        role="listitem"
        data-testid="mod-item"
        data-mod-id={m.id}
        ondragstart={(e) => onDragStart(e, m.id)}
      >
        <div class="mod-main">
          <span class="mod-name" data-testid="mod-item-name">{m.name}</span>
          <span class="mod-expr mono" title={m.expr}>{m.expr}</span>
        </div>
        <div class="mod-acts">
          <IconButton
            icon="pencil"
            label={tr('mod.edit')}
            size="sm"
            testid="mod-item-edit"
            onclick={() => appState.openModulatorEditor(m.id)}
          />
          <IconButton
            icon="trash"
            label={tr('mod.delete')}
            size="sm"
            variant="danger"
            testid="mod-item-delete"
            onclick={() => (pending = m)}
          />
        </div>
      </div>
      <div class="mod-refs">{tr('mod.refs', { n: refCount(m.id) })}</div>
    {/each}
  </div>

  <div class="drawer-foot">
    <Button
      label={tr('mod.new')}
      icon="plus"
      variant="outline"
      testid="mod-new"
      onclick={create}
    />
  </div>
</aside>

{#if pending}
  <ConfirmDialog
    title={tr('mod.deleteTitle')}
    message={pendingRefs.length > 0
      ? tr('mod.deleteBody', { name: pending.name, n: pendingRefs.reduce((n, r) => n + r.slots, 0) })
      : tr('mod.deleteFree', { name: pending.name })}
    confirmLabel={tr('mod.delete')}
    danger
    testid="mod-delete-confirm"
    onconfirm={confirmRemove}
    oncancel={() => (pending = null)}
  />
{/if}

<style>
  .mod-drawer {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
  }
  /* 拖宽热区：贴在右边界，整条高度都是命中区（与媒体池同一手法）。 */
  .drawer-resize {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -2px;
    width: 5px;
    z-index: 2;
    cursor: ew-resize;
  }
  .drawer-resize:hover {
    background: var(--accent);
  }
  :global(body:has(.mod-drawer.resizing)) {
    user-select: none;
  }
  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    flex: none;
    height: 32px;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    border-bottom: 1px solid var(--border);
  }
  .drawer-title {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .mod-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mod-item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: grab;
  }
  .mod-item:hover {
    background: var(--surface-hover);
    border-color: var(--border);
  }
  .mod-item.editing {
    border-color: var(--accent);
  }
  .mod-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .mod-name {
    color: var(--text-primary);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mod-expr {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mod-acts {
    display: inline-flex;
    gap: 1px;
    flex: none;
  }
  /* 引用数单占一行：挂在条目里会把表达式挤成两个字符宽。 */
  .mod-refs {
    padding: 0 6px 4px 6px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .empty {
    padding: var(--sp-5) var(--sp-3);
    text-align: center;
  }
  .empty p {
    margin: 0 0 var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .empty .dim {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .drawer-foot {
    flex: none;
    padding: var(--sp-2);
    border-top: 1px solid var(--border);
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
