<script lang="ts">
  /**
   * DockStack — 停靠列的**唯一容器**：一列里从上到下堆若干**分节**，
   * 每节一条标题栏，点一下就折叠成只剩标题栏。
   *
   * 为什么合成一个容器：分列并排时「插件面板 + 内置面板」会一起吃宽度，两块都
   * 只能看半截；而它们本来就是**同一类东西**（一个竖条里堆几块属性 / 工具），
   * 折叠成标题栏之后用户自己决定这一刻要看哪一块。
   *
   * 两侧的分节来源不同：
   *  - `side='right'`：检查器（Artmatic 自己的面板）+ 清单 `side: 'right'` 的插件面板；
   *    这一列整个就是 `.body` 的右列，宽度 = 用户拖出来的 `drawerWidth`。
   *  - `side='left'`：只有 `side: 'left'` 的插件面板。**本组件不画边框 / 背景**，
   *    因为它被塞进 `.left-col`（媒体池 / Agent / 调制器也住那里，见 `App.svelte`）——
   *    边框由那个容器画，不然会多出一条把「同一个容器」切成两半的竖线。
   *
   * 顺序：拖动标题栏上下换位置，`session.json` 的 `panels.order[side]` 记下来。
   *
   * ⚠️ **只在时间轴页渲染**：调色页与粒子页各自改写了 `.body` 的列模板，
   * 往那两套模板里塞轨道会一起改坏。切走时保留「哪些开着 / 哪些收着 / 什么顺序」，回来原样。
   */
  import Icon from '../Icon.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Inspector from '../Inspector.svelte';
  import { ICONS, type IconName } from '../icons';
  import PluginPanelMount from './PluginPanelMount.svelte';
  import { untrack } from 'svelte';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import {
    closePanel,
    dockItems,
    isPanelCollapsed,
    panelOrder,
    setPanelCollapsed,
    setPanelOrder,
  } from './plugin-panels';
  import type { PluginDockSide, PluginPanelDef } from '../../plugins/api-types';

  let { side = 'right' }: { side?: PluginDockSide } = $props();

  interface Section {
    key: string;
    kind: 'inspector' | 'plugin';
    title: string;
    icon: IconName;
    collapsed: boolean;
    pluginId?: string;
    def?: PluginPanelDef;
  }

  /** 检查器在会话顺序表里的键。它不是插件面板，所以不进 `SessionPanels.open`。 */
  const INSPECTOR_KEY = '@inspector';

  /**
   * 清单里的 `icon` 只是字符串（kebab-case Lucide 名）。不认识的降级成 `puzzle`：
   * 宿主挂载时已经记过一条 `unknown-meta`，这里再报只会让用户以为点了没反应。
   */
  function iconName(raw: string | null): IconName {
    return raw && raw in ICONS ? (raw as IconName) : 'puzzle';
  }

  /* 拖动换位置用到的状态。声明在 `sections` 之前：`$derived` 的求值函数里读它。 */
  let stackEl = $state<HTMLElement | null>(null);
  /** 正在拖的那一节（只用于视觉反馈）。 */
  let dragKey = $state<string | null>(null);
  /** 拖动中的临时顺序；null = 没在拖。 */
  let dragOrder = $state<string[] | null>(null);
  let press: { key: string; y: number; moved: boolean } | null = null;
  /** 拖完那一下还会来一次 click，要吃掉它 —— 否则一松手顺带把这一节折起来了。 */
  let swallowClick = false;

  /** 清单顺序的基准列表（还没套用户拖出来的顺序）。 */
  const baseSections = $derived.by<Section[]>(() => {
    const out: Section[] = [];
    if (side === 'right' && appState.drawerOpen) {
      out.push({
        key: INSPECTOR_KEY,
        kind: 'inspector',
        title: tr('insp.title'),
        icon: 'panel-right',
        collapsed: appState.drawerCollapsed,
      });
    }
    for (const it of dockItems(side)) {
      out.push({
        key: it.key,
        kind: 'plugin',
        title: it.title,
        icon: iconName(it.def.icon),
        collapsed: isPanelCollapsed(it.key),
        pluginId: it.pluginId,
        def: it.def,
      });
    }
    return out;
  });

  /**
   * 最终顺序 = 会话里记的顺序（缺的键排在后面，按清单顺序）。
   * 拖动过程中用 `dragOrder` 顶着 —— 松手才落盘，拖到一半关掉页面不该留下半套顺序。
   */
  const sections = $derived.by<Section[]>(() => {
    const order = dragOrder ?? panelOrder(side);
    if (order.length === 0) return baseSections;
    const rank = new Map(order.map((k, i) => [k, i]));
    const last = Number.MAX_SAFE_INTEGER;
    return [...baseSections].sort(
      (a, b) => (rank.get(a.key) ?? last) - (rank.get(b.key) ?? last),
    );
  });

  /*
   * 选中片段 → 自动展开这一列。
   *
   * ⚠️ 判据里的 `drawerOpen` 必须走 `untrack`：effect 若同时**读**它，那么
   * 用户一关这一列（`drawerOpen = false`）effect 就会重跑并把它又打开 ——
   * 有选中片段时「关不掉检查器」，而且不报错。手写这条注释是因为原
   * InspectorDrawer 就是这个形态，一直没人发现。
   *
   * 展开的是「列」，不是「检查器那一节」：用户按标题栏把它折起来是明确的
   * 意思，选个片段不该把它顶开。
   */
  $effect(() => {
    if (side !== 'right') return;
    const sel = appState.selectedClipId;
    if (sel && untrack(() => !appState.drawerOpen)) appState.drawerOpen = true;
  });

  function toggle(s: Section): void {
    if (s.kind === 'inspector') appState.toggleDrawerCollapsed();
    else setPanelCollapsed(s.key, !s.collapsed);
  }

  function close(s: Section): void {
    if (s.kind === 'inspector') appState.setDrawerOpen(false);
    else closePanel(s.key);
  }

  /* ------------------------------------------------ 拖标题栏换位置 */

  function onHeadDown(e: PointerEvent, s: Section): void {
    if (e.button !== 0) return;
    press = { key: s.key, y: e.clientY, moved: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragUp);
  }

  /** 指针当前落在第几节（用各节中线判断）。 */
  function targetIndex(y: number): number {
    const el = stackEl;
    if (!el) return 0;
    const rows = [...el.children].filter(
      (n): n is HTMLElement => n instanceof HTMLElement && n.tagName === 'SECTION',
    );
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return Math.max(0, rows.length - 1);
  }

  function onDragMove(e: PointerEvent): void {
    if (!press) return;
    if (!press.moved) {
      // 5px 阈值：小于它算「点了一下标题栏」，那要折叠，不是拖。
      if (Math.abs(e.clientY - press.y) < 5) return;
      press.moved = true;
      dragKey = press.key;
      dragOrder = sections.map((s) => s.key);
      e.preventDefault();
    }
    if (!dragOrder) return;
    const from = dragOrder.indexOf(press.key);
    const to = targetIndex(e.clientY);
    if (from < 0 || from === to) return;
    const next = [...dragOrder];
    next.splice(from, 1);
    next.splice(to, 0, press.key);
    dragOrder = next;
  }

  function onDragUp(): void {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragUp);
    const moved = press?.moved ?? false;
    const order = dragOrder;
    press = null;
    dragKey = null;
    dragOrder = null;
    if (!moved || !order) return;
    swallowClick = true;
    setPanelOrder(side, order);
  }

  function onHeadClick(s: Section): void {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    toggle(s);
  }

  /* ---------------------------------------------------- 右列拖宽 */

  let resizing = $state(false);
  let dragStartX = 0;
  let dragStartW = 0;

  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    dragStartX = e.clientX;
    dragStartW = appState.drawerWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const mv = (ev: PointerEvent): void => {
      // 往左拖变宽
      appState.setDrawerWidth(dragStartW - (ev.clientX - dragStartX));
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
</script>

{#if sections.length > 0 && appState.activeProject.view.kind === 'timeline'}
  <aside
    class="stack"
    class:is-left={side === 'left'}
    class:resizing
    class:dragging={dragKey !== null}
    bind:this={stackEl}
    data-side={side}
    data-testid={side === 'left' ? 'plugin-dock-left' : 'drawer'}
  >
    {#if side === 'right'}
      <!-- 拖宽热区：贴在左边界的一条窄带 -->
      <div
        class="stack-resize"
        role="separator"
        aria-label={tr('insp.resizeWidth')}
        aria-orientation="vertical"
        data-testid="drawer-resize"
        onpointerdown={startResize}
      ></div>
    {/if}

    {#each sections as s (s.key)}
      <section
        class="sec"
        class:collapsed={s.collapsed}
        class:lifted={dragKey === s.key}
        data-section={s.key}
        aria-label={s.title}
      >
        <header class="head">
          <button
            type="button"
            class="toggle"
            aria-expanded={!s.collapsed}
            data-testid="dock-section-toggle"
            onpointerdown={(e) => onHeadDown(e, s)}
            onclick={() => onHeadClick(s)}
          >
            <Icon name={s.collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
            <Icon name={s.icon} size={12} />
            <span class="title">{s.title}</span>
          </button>
          <IconButton
            icon="x"
            label={tr('pl.panel.close')}
            size="sm"
            testid="dock-section-close"
            onclick={() => close(s)}
          />
        </header>

        {#if !s.collapsed}
          <div class="body" class:plugin={s.kind === 'plugin'} data-testid="dock-section-body">
            {#if s.kind === 'inspector'}
              <Inspector />
            {:else if s.pluginId && s.def}
              <PluginPanelMount pluginId={s.pluginId} def={s.def} />
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </aside>
{/if}

<style>
  .stack {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    /*
     * 压住看板娘（`.stage` 里的绝对定位元素）并且**高过时间轴内部那一整套**
     * （`--z-ruler` 等 1..5）：从检查器里打开的 modal 是这一列的层叠上下文，
     * 给低了会被标尺 / 播放头盖住。原 InspectorDrawer 的注释与实测都在。
     */
    z-index: var(--z-drawer);
    background: var(--drawer-bg);
    border-left: 1px solid var(--drawer-border);
    /* 分节多于能放下的数量时整列滚动（每节自己还有 `min-height`）。 */
    overflow-y: auto;
  }
  /*
   * 左侧实例只是 `.left-col` 里的一段：**不画边框、不铺背景**。
   * 边框归那个容器 —— 两边各画一条会得到一条把同一列切成两半的竖线，
   * 这正是「左停靠面板与媒体池看起来还是两块」的来源。
   */
  .stack.is-left {
    z-index: auto;
    flex: 0 0 auto;
    background: transparent;
    border: none;
    overflow: visible;
  }
  .stack-resize {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: ew-resize;
    z-index: 1;
  }
  .stack-resize:hover,
  .resizing .stack-resize {
    background: var(--accent);
  }
  .resizing {
    user-select: none;
  }
  /* 拖动中禁止选中文本；整列不该跟着闪。 */
  .dragging {
    user-select: none;
  }

  /*
   * 分节：收起时只有一条标题栏（高度 = 一行）；展开的几节**平分**剩下的高度。
   *
   * 平分而不是「按内容长」：插件面板画自己的界面（常常是 `height: 100%` 的整块），
   * 按内容算会把它们压成 0 高；而只开一节时平分 = 吃满，与改造前的抽屉逐像素相同。
   * `min-height` 保证多节同开时每节都还能用（低于它就让这一列滚动）。
   */
  .sec {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    min-width: 0;
    min-height: 0;
  }
  .sec:not(.collapsed) {
    flex: 1 1 0;
    min-height: 140px;
  }
  /* 被拖起来的那一节：抬起一点，拖动时能看出自己在动哪一块。 */
  .lifted {
    position: relative;
    z-index: 2;
    background: var(--surface-2);
    box-shadow: 0 6px 16px rgb(0 0 0 / 35%);
  }
  .head {
    display: flex;
    align-items: center;
    flex: none;
    height: var(--topbar-h);
    padding-right: var(--sp-1);
    border-bottom: 1px solid var(--drawer-border);
    /* 整行高亮：默认按钮 reset 里的圆角会让它只填满中间一块，看着像贴歪的标签。 */
    border-radius: 0;
  }
  .head:hover {
    background: var(--surface-hover);
  }
  /*
   * 标题栏按钮：**透明、直角、不吃 hover 背景**。
   *
   * `app.css` 里有一条兜底的 `button:hover:not(:disabled) { background: … }`
   * （两个伪类，比这里的单个 `.toggle:hover` 更具体）—— 不显式压住它，
   * 高亮就只填满按钮那一块、还是个圆角矩形，看着像贴歪的标签。
   * 高亮由 `.head:hover` 整行给，× 那一段也跟着亮。
   */
  .toggle,
  .toggle:hover:not(:disabled) {
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    height: 100%;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    color: var(--text-muted);
    font-family: inherit;
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-align: left;
    cursor: grab;
  }
  /* 整行高亮时文字提一级；`background` 不在这里改（见上）。 */
  .head:hover .toggle {
    color: var(--text-primary);
  }
  .dragging .toggle {
    cursor: grabbing;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: uppercase;
  }
  .body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
  }
  /* 插件面板自己管滚动（它的 Shadow DOM 里是 `height:100%` 的一整块）。 */
  .body.plugin {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
