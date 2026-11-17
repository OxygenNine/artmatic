<script lang="ts">
  /**
   * IssueOverlay — 预览画面上的批注层（彩色矩形 + 注释框）。
   *
   * ## 坐标
   *
   * 与 `QuadHandles` 同一条纪律：**只读 canvas 的显示盒**（`getBoundingClientRect`），
   * 不在 UI 里另算分辨率 / 缩放。批注存的是归一化坐标（`core/issues.ts`），
   * 所以这里只做「百分比 → 层内绝对位置」，换分辨率 / 换预览尺寸都不漂。
   *
   * ## 手势
   *
   * 拖框身 = 移动、拖右下角 = 改大小，松手**一笔撤销**（`store.updateIssue`）。
   * 拖动期间只在本地 `draft` 上改，不碰工程 —— 每 move 都 commit 会往撤销栈里
   * 塞几十条中间态，用户按 Ctrl+Z 时看到的是「撤销一步只挪了一像素」。
   *
   * `pointerdown` 必须 `stopPropagation()`：Preview 的「横向拖 = 两帧并排」
   * 会把同一个手势抢走（与四角手柄同一条坑）。
   *
   * ## 为什么叠在 `<canvas>` 上而不画进 GL
   *
   * 批注**不参与出图**（导出里不该有它们），而且需要 DOM 的右键 / 双击 / 文本输入。
   * 画进 canvas 会把它们带进导出分辨率，并让「改注释」变成一次重新渲染。
   */
  import { onMount } from 'svelte';
  import { appState } from '../app-state.svelte';
  import {
    issueCovers,
    issueRectOf,
    ISSUE_MIN_SIZE,
    type IssueMarker,
  } from '../../core/issues';
  import { editingIssueId, closeIssueNote, openIssueNote } from './issue-state.svelte';
  import { resolveIssueColor } from './issue-actions';
  import { tr } from '../../i18n/index.svelte';
  import ColorField from '../controls/ColorField.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Button from '../controls/Button.svelte';

  interface Props {
    /** 预览 GL 画布与包住它的相对定位容器（与 QuadHandles 同一对）。 */
    canvas: HTMLCanvasElement | null;
    stage: HTMLElement | null;
  }
  const { canvas, stage }: Props = $props();

  /*
   * 尺寸 / 位置变化的计数（照抄 QuadHandles）：`bump()` 里**不许** `measured += 1`
   * —— 那会让下面的 effect 依赖自己写的状态，进入无限自触发。
   */
  let seq = 0;
  let measured = $state(0);

  $effect(() => {
    const c = canvas;
    const s = stage;
    if (!c || !s) return;
    const bump = (): void => {
      seq += 1;
      measured = seq;
    };
    bump();
    const ro = new ResizeObserver(bump);
    ro.observe(c);
    ro.observe(s);
    window.addEventListener('resize', bump);
    document.addEventListener('fullscreenchange', bump);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', bump);
      document.removeEventListener('fullscreenchange', bump);
    };
  });

  /** canvas 在 stage 坐标系里的显示盒。null = 画面还没有尺寸（隐藏 / 未布局）。 */
  const box = $derived.by(() => {
    void measured;
    const c = canvas;
    const s = stage;
    if (!c || !s) return null;
    const cr = c.getBoundingClientRect();
    const sr = s.getBoundingClientRect();
    if (cr.width <= 0 || cr.height <= 0) return null;
    return { left: cr.left - sr.left, top: cr.top - sr.top, w: cr.width, h: cr.height };
  });

  /**
   * 当前这一帧可见的标记。**时间是有意义的**：标记只覆盖它自己的时间段
   * （默认一帧），播放头移开就不该继续盖在画面上 —— 那会让人以为每个标记
   * 都永久生效，也没法判断「我现在看的是哪一条」。
   *
   * 读 `playT` 建立依赖：播放 / 拖动播放头时这一层跟着重新过滤。
   */
  const issues = $derived.by<IssueMarker[]>(() => {
    void appState.version;
    void appState.activeProjectId;
    if (!appState.hasProject) return [];
    const at = appState.playT;
    return (appState.project.issues ?? []).filter((it) => issueCovers(it, at));
  });

  const editing = $derived(editingIssueId());

  interface DragState {
    id: string;
    kind: 'move' | 'resize';
    /** 按下瞬间的矩形（归一化）。拖动是相对起点算的，不回读中途被改过的值。 */
    start: { x: number; y: number; w: number; h: number };
    /** 按下瞬间的指针位置（归一化）。 */
    from: { u: number; v: number };
  }
  let drag = $state<DragState | null>(null);
  /** 拖动中的临时矩形（只在这一层用，不落库）。 */
  let draft = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  /** 指针 → 归一化画面坐标。canvas 的显示盒才是用户看到的那块画面。 */
  function uvAt(clientX: number, clientY: number): { u: number; v: number } | null {
    const c = canvas;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const clamp = (n: number): number => Math.min(1, Math.max(0, n));
    return {
      u: clamp((clientX - r.left) / r.width),
      v: clamp((clientY - r.top) / r.height),
    };
  }

  /** 显示用的矩形：拖动中的那条用 `draft`，其余读工程。 */
  function displayOf(it: IssueMarker): { x: number; y: number; w: number; h: number } {
    return drag?.id === it.id && draft ? draft : it;
  }

  function begin(e: PointerEvent, it: IssueMarker, kind: 'move' | 'resize'): void {
    if (e.button !== 0) return;
    // 先吞事件：Preview 的横向拖会同时开一个「两帧并排」手势。
    e.preventDefault();
    e.stopPropagation();
    appState.selectIssue(it.id);
    const uv = uvAt(e.clientX, e.clientY);
    if (!uv) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    drag = {
      id: it.id,
      kind,
      start: { x: it.x, y: it.y, w: it.w, h: it.h },
      from: uv,
    };
    draft = { x: it.x, y: it.y, w: it.w, h: it.h };

    const mv = (ev: PointerEvent): void => {
      const d = drag;
      const p = uvAt(ev.clientX, ev.clientY);
      if (!d || !p) return;
      if (d.kind === 'move') {
        const x = Math.min(1 - d.start.w / 2, Math.max(d.start.w / 2, d.start.x + (p.u - d.from.u)));
        const y = Math.min(1 - d.start.h / 2, Math.max(d.start.h / 2, d.start.y + (p.v - d.from.v)));
        draft = { ...d.start, x, y };
        return;
      }
      // 改大小：**左上角不动**，右下角跟指针走（用户按住的就是右下角）。
      const left = d.start.x - d.start.w / 2;
      const top = d.start.y - d.start.h / 2;
      const w = Math.min(1 - left, Math.max(ISSUE_MIN_SIZE, p.u - left));
      const h = Math.min(1 - top, Math.max(ISSUE_MIN_SIZE, p.v - top));
      draft = { x: left + w / 2, y: top + h / 2, w, h };
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      const d = drag;
      const next = draft;
      drag = null;
      draft = null;
      if (d && next) appState.store.updateIssue(d.id, next);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /* ------------------------------------------------------------ 注释框 */

  let noteDraft = $state('');

  /** 新建标记后立刻能打字（注释框一出现就聚焦）。 */
  function autoFocus(node: HTMLElement): void {
    node.focus();
  }

  /*
   * 打开注释框时把落库的注释抄进来。
   *
   * 只依赖 `editing`（不读 `issues`）—— 读 `issues` 会让「改颜色 → version 变 →
   * issues 变」在打字途中重置输入框，用户会看到自己刚打的字消失。
   */
  $effect(() => {
    const id = editing;
    if (!id) return;
    const it = appState.store.project.issues?.find((x) => x.id === id);
    noteDraft = it?.note ?? '';
  });

  function commitNote(id: string): void {
    appState.store.updateIssue(id, { note: noteDraft });
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !editingIssueId()) return;
      // 注释框是画面上的一个小面板，Esc 的第一语义就是关掉它。
      e.stopPropagation();
      closeIssueNote();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

{#if box && issues.length > 0}
  <!--
    层本体 `pointer-events: none`：它铺满画面，若吞事件，整块预览就点不动了。
    只有矩形与拖角 `auto`（与 QuadHandles 同一条纪律）。
  -->
  <div
    class="issue-layer"
    style:left={`${box.left}px`}
    style:top={`${box.top}px`}
    style:width={`${box.w}px`}
    style:height={`${box.h}px`}
  >
    {#each issues as it, i (it.id)}
      {@const d = displayOf(it)}
      {@const r = issueRectOf(d)}
      <div
        class="issue-box"
        class:is-sel={appState.selectedIssueId === it.id}
        style:left={`${r.left * 100}%`}
        style:top={`${r.top * 100}%`}
        style:width={`${r.w * 100}%`}
        style:height={`${r.h * 100}%`}
        style:--issue-color={it.color}
        data-testid="pv-issue"
        data-issue-id={it.id}
        role="presentation"
        title={it.note || tr('iss.marker', { n: i + 1 })}
        onpointerdown={(e) => begin(e, it, 'move')}
        ondblclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          appState.selectIssue(it.id);
          openIssueNote(it.id);
        }}
      >
        <span class="issue-tag">{i + 1}</span>
        <span
          class="issue-grip"
          data-testid="pv-issue-grip"
          role="presentation"
          onpointerdown={(e) => begin(e, it, 'resize')}
        ></span>
      </div>

      {#if editing === it.id}
        <div
          class="issue-note"
          data-testid="issue-note"
          role="dialog"
          tabindex="-1"
          aria-label={tr('iss.note')}
          style:left={`${Math.min(r.left * 100, 62)}%`}
          style:top={`${Math.min((r.top + r.h) * 100, 66)}%`}
          onpointerdown={(e) => e.stopPropagation()}
        >
          <div class="note-head">
            <span class="note-dot" style:background={it.color}></span>
            <span class="note-time mono">{it.start.toFixed(2)}s</span>
            <ColorField
              value={it.color}
              label={tr('iss.color')}
              testid="issue-color"
              onchange={(v) => appState.store.updateIssue(it.id, { color: resolveIssueColor(v) })}
            />
            <span class="grow"></span>
            <IconButton
              icon="trash"
              label={tr('iss.remove')}
              size="sm"
              variant="danger"
              testid="issue-note-remove"
              onclick={() => {
                appState.store.removeIssue(it.id);
                closeIssueNote();
              }}
            />
          </div>
          <textarea
            class="note-input"
            data-testid="issue-note-input"
            placeholder={tr('iss.notePlaceholder')}
            use:autoFocus
            value={noteDraft}
            oninput={(e) => (noteDraft = e.currentTarget.value)}
            onblur={() => commitNote(it.id)}
            onkeydown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                commitNote(it.id);
                closeIssueNote();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitNote(it.id);
                closeIssueNote();
              }
            }}
          ></textarea>
          <div class="note-foot">
            <span class="note-hint">{tr('iss.sizeHint')}</span>
            <Button
              label={tr('iss.done')}
              size="sm"
              variant="accent"
              testid="issue-note-done"
              onclick={() => {
                commitNote(it.id);
                closeIssueNote();
              }}
            />
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .issue-layer {
    position: absolute;
    pointer-events: none;
    /* 与时间轴内部的「选中片段」同层：批注压在画面上，但注释框要在它上面。 */
    z-index: 4;
  }
  /*
   * 标记本体：彩色描边 + 很淡的填充。**不做纯色实心** —— 它盖住的正是用户
   * 要判断「这里有没有问题」的那块画面。
   */
  .issue-box {
    position: absolute;
    box-sizing: border-box;
    border: 1.5px solid var(--issue-color);
    background: color-mix(in srgb, var(--issue-color) 12%, transparent);
    border-radius: 2px;
    pointer-events: auto;
    cursor: move;
    /* 手柄与描边都在框外一点点，裁剪掉会让边角缩不回去。 */
    overflow: visible;
  }
  .issue-box:hover {
    background: color-mix(in srgb, var(--issue-color) 20%, transparent);
  }
  .issue-box.is-sel {
    border-width: 2px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--issue-color) 55%, transparent);
  }
  /* 序号：贴在左上角外侧，不遮住批注框圈住的内容。 */
  .issue-tag {
    position: absolute;
    left: -1px;
    top: -14px;
    min-width: 12px;
    height: 13px;
    padding: 0 3px;
    background: var(--issue-color);
    color: #fff;
    font-size: 9px;
    line-height: 13px;
    text-align: center;
    border-radius: 2px;
    pointer-events: none;
    user-select: none;
  }
  /* 右下角的改大小手柄。只在选中时显形 —— 未选中的框上那一点会像噪点。 */
  .issue-grip {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 9px;
    height: 9px;
    display: none;
    background: var(--issue-color);
    border: 1px solid var(--surface-0);
    border-radius: 1px;
    cursor: nwse-resize;
    pointer-events: auto;
  }
  .issue-box.is-sel .issue-grip {
    display: block;
  }

  /*
   * 注释框。它是画面之上的浮层：`--shadow-float` 是留给这类没有布局槽位的
   * 根级浮动面板的（见 ui/AGENTS.md 的视觉纪律）。
   */
  .issue-note {
    position: absolute;
    width: 232px;
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-float);
    pointer-events: auto;
    z-index: 1;
  }
  .note-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .note-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex: none;
  }
  .note-time {
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }
  .grow {
    flex: 1;
  }
  .note-input {
    width: 100%;
    min-height: 58px;
    max-height: 140px;
    resize: vertical;
    padding: var(--sp-2);
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-primary);
    background: var(--surface-0);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
  }
  .note-input:focus {
    outline: none;
    border-color: var(--border-focus);
  }
  .note-foot {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .note-hint {
    flex: 1;
    min-width: 0;
    color: var(--text-muted);
    font-size: 10px;
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
