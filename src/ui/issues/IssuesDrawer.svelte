<script lang="ts">
  /**
   * IssuesDrawer — 左侧的「问题标记」汇总面板（rail 的 `message-circle` 打开）。
   *
   * 与媒体池 / Agent / 调制器共用左列（四者互斥，见 `appState.setIssuesOpen`），
   * 宽度也共用 `mediaPoolWidth`：同一列的内容不该有两套宽度记忆。
   *
   * 面板答复三件事（用户原话）：**跳转 / 修改 / 删除**。
   *   - 跳转 = 点条目（或时间轴上的彩色线）→ `jumpToIssue`；
   *   - 修改 = 就地改注释与颜色，写入走 `store.updateIssue`（一笔撤销）；
   *   - 删除 = 条目右侧的垃圾桶；「清空全部」走确认框（一次删一大片）。
   *
   * 注释框用 `onchange`（失焦 / 回车提交）而不是每个键都 commit：逐键写库会把
   * 撤销栈塞满中间态，用户按 Ctrl+Z 看到的是一字一字往回退。
   */
  import Icon from '../Icon.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Button from '../controls/Button.svelte';
  import ColorField from '../controls/ColorField.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import { appState } from '../app-state.svelte';
  import { jumpToIssue, resolveIssueColor } from './issue-actions';
  import { closeIssueNote } from './issue-state.svelte';
  import { issueDuration, type IssueMarker } from '../../core/issues';
  import { tr } from '../../i18n/index.svelte';

  const list = $derived.by<IssueMarker[]>(() => {
    void appState.version;
    void appState.activeProjectId;
    return appState.hasProject ? [...(appState.project.issues ?? [])] : [];
  });

  const selected = $derived(appState.selectedIssueId);
  /** 一帧的长度：时间段的钳制单位与默认时长都用它。 */
  const frame = $derived(1 / Math.max(1, appState.project.fps));

  /** 待确认的「清空全部」。 */
  let clearing = $state(false);
  let resizing = $state(false);

  /**
   * 拖宽：与媒体池 / 调制器同一条手势（热区在右边缘，往右拖变宽），写的是
   * **同一个** `mediaPoolWidth`。
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

  function remove(id: string): void {
    appState.store.removeIssue(id);
    if (appState.selectedIssueId === id) appState.selectIssue(null);
    closeIssueNote();
  }

  function clearAll(): void {
    clearing = false;
    appState.store.clearIssues();
    appState.selectIssue(null);
    closeIssueNote();
  }
</script>

<aside
  class="issues-drawer"
  class:resizing
  data-testid="issues-drawer"
  style:width={`${appState.mediaPoolWidth}px`}
  role="presentation"
>
  <div
    class="drawer-resize"
    role="separator"
    aria-label={tr('iss.resize')}
    aria-orientation="vertical"
    data-testid="issues-drawer-resize"
    onpointerdown={startResize}
  ></div>

  <div class="drawer-head">
    <span class="drawer-title">
      <Icon name="message-circle" size={12} />
      {tr('iss.title')}
      <span class="count">{tr('iss.count', { n: list.length })}</span>
    </span>
    <IconButton
      icon="x"
      label={tr('iss.close')}
      size="sm"
      testid="issues-drawer-close"
      onclick={() => appState.setIssuesOpen(false)}
    />
  </div>

  <div class="issue-list" role="list" data-testid="issue-list">
    {#if list.length === 0}
      <div class="empty">
        <p>{tr('iss.empty')}</p>
        <p class="dim">{tr('iss.emptyHint')}</p>
      </div>
    {/if}
    {#each list as it, i (it.id)}
      <div
        class="issue-item"
        class:is-sel={selected === it.id}
        role="listitem"
        data-testid="issue-item"
        data-issue-id={it.id}
        onpointerdown={(e) => {
          /*
           * 条目本体 = 跳转；里面的控件自己处理指针。
           * `[data-exempt]` 覆盖 NumberInput 的拖拽热区（它是 div，不是 input）——
           * 漏了它会让「按住起点数字框横向拖动」同时触发一次跳转。
           */
          if ((e.target as HTMLElement).closest('button, textarea, input, [data-exempt]')) return;
          jumpToIssue(it);
        }}
      >
        <div class="item-head">
          <span class="idx" style:--issue-color={it.color}>{i + 1}</span>
          <button
            type="button"
            class="time mono"
            data-testid="issue-jump"
            title={tr('iss.jump')}
            onclick={() => jumpToIssue(it)}
          >
            {it.start.toFixed(2)}s
          </button>
          <span class="grow"></span>
          <ColorField
            value={it.color}
            label={tr('iss.color')}
            testid="issue-item-color"
            onchange={(v) => appState.store.updateIssue(it.id, { color: resolveIssueColor(v) })}
          />
          <IconButton
            icon="corner-down-right"
            label={tr('iss.jump')}
            size="sm"
            testid="issue-item-jump"
            onclick={() => jumpToIssue(it)}
          />
          <IconButton
            icon="trash"
            label={tr('iss.remove')}
            size="sm"
            variant="danger"
            testid="issue-item-remove"
            onclick={() => remove(it.id)}
          />
        </div>
        <!--
          时间段：起点 + 时长。两个框都是**只改一端**，另一端由 store 钳制 ——
          「时长改小到 0」与「起点拖过结尾」都由 `normalizeIssueSpan` 保底为一帧，
          这里不需要第二套校验。
        -->
        <div class="item-time">
          <span class="lbl">{tr('iss.start')}</span>
          <NumberInput
            value={it.start}
            min={0}
            max={appState.project.duration}
            step={frame}
            precision={2}
            width={56}
            suffix="s"
            ariaLabel={tr('iss.start')}
            testid="issue-start"
            onchange={(v) => appState.store.updateIssue(it.id, { start: v, end: v + issueDuration(it) })}
          />
          <span class="lbl">{tr('iss.duration')}</span>
          <NumberInput
            value={issueDuration(it)}
            min={frame}
            max={appState.project.duration}
            step={frame}
            precision={2}
            width={56}
            suffix="s"
            ariaLabel={tr('iss.duration')}
            testid="issue-duration"
            onchange={(v) => appState.store.updateIssue(it.id, { end: it.start + Math.max(frame, v) })}
          />
        </div>
        <textarea
          class="note"
          data-testid="issue-item-note"
          placeholder={tr('iss.notePlaceholder')}
          value={it.note}
          onchange={(e) => appState.store.updateIssue(it.id, { note: e.currentTarget.value })}
          onkeydown={(e) => {
            // 单行语义：Enter 提交并失焦（批注通常是一句话；要换行用 Shift+Enter）。
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              appState.store.updateIssue(it.id, { note: e.currentTarget.value });
              e.currentTarget.blur();
            }
          }}
        ></textarea>
      </div>
    {/each}
  </div>

  <div class="drawer-foot">
    <Button
      label={tr('iss.clear')}
      icon="trash"
      variant="outline"
      testid="issues-clear"
      disabled={list.length === 0}
      onclick={() => (clearing = true)}
    />
  </div>
</aside>

{#if clearing}
  <ConfirmDialog
    title={tr('iss.clearTitle')}
    message={tr('iss.clearBody', { n: list.length })}
    confirmLabel={tr('iss.clear')}
    danger
    testid="issues-clear-confirm"
    onconfirm={clearAll}
    oncancel={() => (clearing = false)}
  />
{/if}

<style>
  .issues-drawer {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
  }
  /* 拖宽热区：贴在右边界，整条高度都是命中区（与媒体池 / 调制器同一手法）。 */
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
  :global(body:has(.issues-drawer.resizing)) {
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
    min-width: 0;
  }
  .count {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .issue-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .issue-item {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    cursor: pointer;
    /* 条目高度由内容决定：列表是滚动容器，撑满会让一条标记占掉整屏。
       类名也不能叫 `.sel` —— 那是下拉控件的全局类（带 flex:1 + 固定高度）。 */
    flex: none;
  }
  .issue-item.is-sel {
    border-color: var(--accent);
  }
  .item-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  /* 序号：与画面 / 时间轴上的编号同一个数字，颜色取标记自己的颜色。 */
  .idx {
    flex: none;
    min-width: 16px;
    height: 15px;
    padding: 0 3px;
    background: var(--issue-color);
    color: #fff;
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    border-radius: 2px;
  }
  .time {
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .time:hover {
    color: var(--accent);
  }
  .grow {
    flex: 1;
  }
  .item-time {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .lbl {
    flex: none;
    color: var(--text-muted);
    font-size: 10px;
  }
  .note {
    width: 100%;
    min-height: 38px;
    max-height: 120px;
    resize: vertical;
    padding: var(--sp-2);
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
  }
  .note:focus {
    outline: none;
    border-color: var(--border-focus);
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
