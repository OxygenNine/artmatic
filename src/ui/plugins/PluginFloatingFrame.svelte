<script lang="ts">
  /**
   * PluginFloatingFrame — 插件浮窗的**外壳**（chrome）。
   *
   * 与曲线编辑器同一族视觉：28px 窄标题栏、1px 细边框、`--surface-3` 背景、
   * **唯一一层** `--shadow-float`。区别只有两处：
   *  - 标题左边一个 6px 圆点标记「这是插件画的东西」；
   *  - 几何（位置 + 尺寸）落在会话状态里，重开工程回到原处。
   *
   * 拖动 / 缩放的通用实现抽在 `ui/floating.ts`（曲线编辑器共用同一份）。
   */
  import type { Snippet } from 'svelte';
  import IconButton from '../controls/IconButton.svelte';
  import { startFloatingMove, startFloatingResize } from '../floating';
  import { panelBox, setPanelBox } from './plugin-panels';
  import { tr } from '../../i18n/index.svelte';
  import type { PluginPanelDef } from '../../plugins/api-types';
  import type { SessionPanelBox } from '../../project/session';

  interface Props {
    panelKey: string;
    title: string;
    def: PluginPanelDef;
    /** 层叠序号（后打开的在上），与曲线编辑器同一套 `--z-popover + layer`。 */
    layer?: number;
    onclose: () => void;
    children: Snippet;
  }
  const { panelKey, title, def, layer = 0, onclose, children }: Props = $props();

  const MIN_W = 240;
  const MIN_H = 160;

  let el: HTMLDivElement | undefined = $state();
  let resizing = $state(false);

  /**
   * 本地几何。打开时从会话状态取一次；之后由拖动 / 缩放更新。
   * **不每次重读 `panelBox()`**：拖到一半时它会跟会话状态互相覆盖。
   */
  let box = $state<SessionPanelBox>(box0());

  function box0(): SessionPanelBox {
    const saved = panelBox(panelKey);
    if (saved) return { ...saved };
    const w = def.width ?? 360;
    const h = def.height ?? 420;
    return { x: 96 + layer * 28, y: 88 + layer * 24, w, h };
  }

  const style = $derived(
    [
      // 视口很窄时用 `min()` 把窗口拉回可见区（几何是持久化的，换显示器后可能超出去）。
      `left:min(${box.x}px, calc(100vw - ${box.w}px - 8px))`,
      `top:min(${box.y}px, calc(100vh - ${box.h}px - 8px))`,
      `width:${box.w}px`,
      `height:${box.h}px`,
      `z-index:calc(var(--z-popover) + ${layer})`,
    ].join(';'),
  );

  /**
   * 拖动只从标题栏起：面板内容属于插件，在里面按下的手势（选框 / 拖动色块）
   * 不该被宿主当成「挪窗口」。挂在根节点上而不是 `<header>` 上，
   * 理由与曲线编辑器同一条：静态元素带 pointerdown 会触发 a11y 警告，
   * 而给标题栏编一个假 role 只会让读屏多念一个「按钮」。
   */
  function onPanelDown(e: PointerEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.head')) return;
    // 标题栏里的按钮自己处理；否则拖窗口。
    if (target.closest('button')) return;
    const node = el;
    if (!node) return;
    startFloatingMove({
      e,
      el: node,
      onMove: (p) => {
        box = { ...box, x: p.x, y: p.y };
      },
      onEnd: () => {
        setPanelBox(panelKey, box);
      },
    });
  }

  function onResizeDown(e: PointerEvent): void {
    const node = el;
    if (!node) return;
    startFloatingResize({
      e,
      el: node,
      minW: MIN_W,
      minH: MIN_H,
      onStart: () => {
        resizing = true;
      },
      onEnd: () => {
        resizing = false;
        setPanelBox(panelKey, box);
      },
      onMove: (s) => {
        box = { ...box, w: s.w, h: s.h };
      },
    });
  }
</script>

<div
  class="panel"
  class:resizing
  bind:this={el}
  style={style}
  role="dialog"
  aria-label={title}
  aria-modal="false"
  tabindex="-1"
  data-testid="plugin-panel"
  data-plugin-panel={panelKey}
  onpointerdown={onPanelDown}
>
  <header class="head">
    <span class="dot" aria-hidden="true"></span>
    <span class="title">{title}</span>
    <span class="grow"></span>
    <IconButton icon="x" label={tr('pl.panel.close')} size="sm" testid="plugin-panel-close" onclick={onclose} />
  </header>
  <div class="body">
    {@render children()}
  </div>
  <button
    type="button"
    class="resize"
    aria-label={tr('pl.panel.resize')}
    data-testid="plugin-panel-resize"
    onpointerdown={onResizeDown}
  ></button>
</div>

<style>
  .panel {
    position: fixed;
    display: flex;
    flex-direction: column;
    min-width: 240px;
    min-height: 160px;
    max-width: calc(100vw - 8px);
    max-height: calc(100vh - 8px);
    background: var(--surface-3);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-md);
    /* 浮层没有布局槽位，纯边框与背景分不开 —— 这是 shadow token 的唯一用途。 */
    box-shadow: var(--shadow-float);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    overflow: hidden;
  }
  .panel.resizing {
    user-select: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 28px;
    flex-shrink: 0;
    padding: 0 var(--sp-2) 0 var(--sp-4);
    background: var(--surface-2);
    border-bottom: 1px solid var(--input-border);
    cursor: move;
    user-select: none;
  }
  /* 来源标记：与内置浮窗（曲线编辑器）区分开的一个小圆点。 */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    overflow: hidden;
  }
  .resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    background: transparent;
    appearance: none;
    cursor: nwse-resize;
    z-index: 3;
  }
  .resize::after {
    content: '';
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 7px;
    height: 7px;
    border-right: 1px solid var(--text-muted);
    border-bottom: 1px solid var(--text-muted);
    opacity: 0.7;
  }
  .resize:hover::after {
    opacity: 1;
  }
</style>
