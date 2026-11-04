<script lang="ts">
  /**
   * GraphEditor — 表达式节点图：节点在画布上自由摆放，连线表示「谁接谁」。
   *
   * 为什么不是「div 套 div 的缩进树」：缩进树把结构压成一列，每一层都吃掉一行
   * 宽度，而「这一块属于谁」只能靠左边缘对齐去猜。表达式是**数据流**，画成图
   * 之后一眼能看出哪一枝喂给哪个输入口，也能直接把一枝拖到另一个口上。
   *
   * 交互（节点编辑器的通用手势，不发明新的）：
   *   - 拖节点头行 → 移动它自己（子节点不跟着走，连线自己拉长）；
   *   - 拖空白 → 平移；滚轮 → 以光标为中心缩放；
   *   - 从输出口（右缘小圆）拖到某个输入口（左缘小圆）→ 把这一枝改接到那里；
   *     从**已占用的输入口**拖出 = 把那一枝再挪走（同一个手势的反向）；
   *   - 节点 ⋯ → 换成别的块 / 清零。
   *
   * 三种坐标别混：**世界坐标**（节点位置）、**画布坐标**（`world` 层平移缩放后）、
   * **视口坐标**（`clientX/Y`）。指针事件给的是视口坐标；落点判定走
   * `elementFromPoint`（它在视口坐标系里工作，与 `world` 的变换无关）。
   */
  import Menu from '../controls/Menu.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Select from '../controls/Select.svelte';
  import {
    clearNode,
    layoutGraph,
    moveSubtree,
    outAnchor,
    pathKey,
    wirePath,
    type GraphNode,
  } from './graph-model';
  import { loadLayout, resetLayout, saveLayout } from './graph-layout';
  import { blockGroups } from './block-palette';
  import {
    fitsBlocks,
    printExpr,
    replaceAtPath,
    slotAt,
    slotCount,
    withSlot,
    type BinOp,
    type ExprNode,
  } from '../../core/expr';
  import type { Modulator } from '../../core/modulation';
  import type { MenuItem } from '../controls/menu-model';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    ast: ExprNode;
    /** 位置按它分别记住（调制器 id）。 */
    storageKey: string;
    mods: readonly Modulator[];
    selfId: string | null;
    onast: (next: ExprNode) => void;
  }
  const { ast, storageKey, mods, selfId, onast }: Props = $props();

  // 只取一次的初值：位置是这次会话里摆的，后面由拖动写回，不该跟着 prop 重算。
  // svelte-ignore state_referenced_locally
  let pos = $state<Record<string, { x: number; y: number }>>(loadLayout(storageKey));
  let pan = $state({ x: 0, y: 0 });
  let zoom = $state(1);
  let sel = $state<string | null>(null);
  /** 正在拖的导线：起点（世界坐标）+ 当前指针（世界坐标）。 */
  let wire = $state<{ x1: number; y1: number; x: number; y: number } | null>(null);
  /** 悬停中的输入口（`key|slot`），松手就是落点。 */
  let hover = $state<string | null>(null);
  let canvasEl = $state<HTMLDivElement | null>(null);
  let menuAnchor = $state<HTMLElement | null>(null);
  let menuPath = $state<number[] | null>(null);
  let menuOpen = $state(false);

  const layout = $derived(layoutGraph(ast, pos));
  const refs = $derived(mods.filter((m) => m.id !== selfId));
  const modOptions = $derived(refs.map((m) => ({ value: m.id, label: m.name })));

  /** 视口坐标 → 世界坐标。 */
  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = canvasEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  }

  /** 把整张图塞进画布。 */
  function fit(): void {
    const el = canvasEl;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw < 40 || ch < 40) return;
    const pad = 40;
    const w = Math.max(1, layout.width - layout.minX);
    const h = Math.max(1, layout.height - layout.minY);
    // 上限 1.25：简单表达式（三五个节点）在 100% 下只占半张画布，看得清才谈得上
    // 「随便拖」。下限 0.35 给深表达式留活路（十层的 fbm 嵌套也能整张塞进来）。
    const next = Math.max(0.35, Math.min(1.25, Math.min((cw - pad) / w, (ch - pad) / h)));
    zoom = next;
    pan = {
      x: (cw - w * next) / 2 - layout.minX * next,
      y: (ch - h * next) / 2 - layout.minY * next,
    };
  }

  /*
   * 首次挂载适配一次。
   *
   * **同步调一次**再挂 ResizeObserver：modal 的入场动画是 transform 缩放，
   * `clientWidth` 在挂载那一刻就是真的，所以这里能立刻算准。只靠 RO 的话适配会
   * 落到下一帧，而那一帧在自动化手势里正好是「量完坐标、还没点下去」的位置。
   */
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    let fitted = false;
    const tryFit = (): void => {
      if (fitted || el.clientWidth < 40) return;
      fitted = true;
      fit();
    };
    tryFit();
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => ro.disconnect();
  });

  /* 滚轮缩放：要 preventDefault 所以必须非 passive，只能手动挂。 */
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const next = Math.min(1.6, Math.max(0.35, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // 光标下的世界坐标保持不动，否则缩放手感是「画面在跑」。
      const wx = (px - pan.x) / zoom;
      const wy = (py - pan.y) / zoom;
      pan = { x: px - wx * next, y: py - wy * next };
      zoom = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /** 指针手势的通用接线（与抽屉拖宽同一手法）。 */
  function gesture(
    el: HTMLElement,
    e: PointerEvent,
    onMove: (ev: PointerEvent) => void,
    onUp: (ev: PointerEvent) => void,
  ): void {
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent): void => onMove(ev);
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      onUp(ev);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function startPan(e: PointerEvent): void {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const el = canvasEl;
    if (!el) return;
    const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    gesture(
      el,
      e,
      (ev) => {
        pan = { x: start.px + (ev.clientX - start.x), y: start.py + (ev.clientY - start.y) };
      },
      () => {},
    );
  }

  function startNodeDrag(e: PointerEvent, n: GraphNode): void {
    if (e.button !== 0) return;
    e.preventDefault();
    sel = n.key;
    const z = zoom;
    const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
    const el = e.currentTarget as HTMLElement;
    gesture(
      el,
      e,
      (ev) => {
        pos = {
          ...pos,
          [n.key]: { x: start.nx + (ev.clientX - start.x) / z, y: start.ny + (ev.clientY - start.y) / z },
        };
      },
      () => saveLayout(storageKey, pos),
    );
  }

  /** 从某个节点的输出口拉一根线。`fromPath` 是那一枝在 AST 里的路径。 */
  function beginWire(e: PointerEvent, fromKey: string, fromPath: readonly number[]): void {
    if (e.button !== 0) return;
    const src = layout.byKey.get(fromKey);
    const el = canvasEl;
    if (!src || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const a = outAnchor(src);
    wire = { x1: a.x, y1: a.y, x: a.x, y: a.y };
    gesture(
      el,
      e,
      (ev) => {
        const w = toWorld(ev.clientX, ev.clientY);
        if (wire) wire = { ...wire, x: w.x, y: w.y };
        hover = slotAtPoint(ev.clientX, ev.clientY)?.id ?? null;
      },
      (ev) => {
        const target = slotAtPoint(ev.clientX, ev.clientY);
        wire = null;
        hover = null;
        if (!target) return;
        const res = moveSubtree(ast, fromPath, target.path, target.slot);
        if (res.ok) onast(res.ast);
      },
    );
  }

  /**
   * 视口坐标 → 输入口。
   *
   * 用 `elementFromPoint` 而不是自己算矩形：节点被缩放 / 平移之后，逐个做命中
   * 测试要么把变换抄一遍、要么在缩放边界上差半格。DOM 已经知道答案。
   */
  function slotAtPoint(
    clientX: number,
    clientY: number,
  ): { path: number[]; slot: number; id: string } | null {
    const el = document.elementFromPoint(clientX, clientY);
    const hit = el?.closest<HTMLElement>('[data-in-slot]');
    if (!hit) return null;
    const key = hit.dataset.inPath ?? '';
    const slot = Number(hit.dataset.inSlot ?? '0');
    const path = key === '' ? [] : key.split('.').map(Number);
    return { path, slot, id: `${key}|${slot}` };
  }

  function replace(n: GraphNode, next: ExprNode): void {
    onast(replaceAtPath(ast, n.path, next));
  }

  const items = $derived.by<MenuItem[]>(() => {
    const out: MenuItem[] = blockGroups().map((g) => ({
      id: g.id,
      label: tr(g.labelKey),
      testid: `mod-pal-group-${g.id}`,
      children: g.items.map((tpl) => ({
        id: tpl.id,
        testid: `mod-pal-${tpl.id}`,
        label: tpl.label ?? (tpl.labelKey ? tr(tpl.labelKey) : tpl.id),
        onselect: () => {
          const path = menuPath;
          if (!path) return;
          onast(replaceAtPath(ast, path, tpl.make(refs[0]?.id)));
        },
      })),
    }));
    out.push({ id: 'sep', separator: true });
    out.push({
      id: 'clear',
      label: tr('mod.blk.clear'),
      icon: 'eraser',
      testid: 'mod-pal-clear',
      onselect: () => {
        if (menuPath) onast(clearNode(ast, menuPath));
      },
    });
    return out;
  });

  const BIN_OPS: BinOp[] = ['+', '-', '*', '/', '%'];

  function kindLabel(node: ExprNode): string {
    switch (node.k) {
      case 'num':
        return tr('mod.blk.num');
      case 'time':
        return tr('mod.blk.time');
      case 'beat':
        return tr('mod.blk.beat');
      case 'mod':
        return tr('mod.blk.mod');
      case 'un':
        return tr('mod.blk.unary');
      case 'bin':
        return tr('mod.blk.add');
      case 'call':
        return node.fn;
      default:
        return tr('mod.blk.text');
    }
  }
</script>

<div class="canvas" bind:this={canvasEl} role="presentation" data-testid="mod-graph" onpointerdown={startPan}>
  <div class="world" style:transform={`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}>
    <svg
      class="wires"
      style:left={`${layout.minX - 300}px`}
      style:top={`${layout.minY - 300}px`}
      width={Math.max(1, layout.width - layout.minX) + 600}
      height={Math.max(1, layout.height - layout.minY) + 600}
    >
      <g transform="translate(300, 300)">
        {#each layout.edges as e (e.to + '|' + e.slot)}
          <path class="wire" d={wirePath(e.x1, e.y1, e.x2, e.y2)} />
        {/each}
        {#if wire}
          <path class="wire live" d={wirePath(wire.x1, wire.y1, wire.x, wire.y)} />
        {/if}
      </g>
    </svg>

    {#each layout.nodes as n (n.key)}
      <div
        class="node"
        class:sel={sel === n.key}
        class:tree-root={n.root}
        style:left={`${n.x}px`}
        style:top={`${n.y}px`}
        style:width={`${n.w}px`}
        style:height={`${n.h}px`}
        data-testid="mod-node"
        data-key={n.key}
        data-root={n.root ? '1' : undefined}
      >
        <!--
          头行就是拖动手柄。里面的每一件控件都要拦住 pointerdown ——
          否则拖数字框会连节点一起拖走（两个手势都在同一个指针上）。
        -->
        <div class="head" role="presentation" onpointerdown={(e) => startNodeDrag(e, n)}>
          {#if n.node.k === 'bin'}
            <span class="ops" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
              {#each BIN_OPS as op (op)}
                <button
                  type="button"
                  class="op"
                  class:on={n.node.op === op}
                  data-testid={`mod-node-op-${op}`}
                  onclick={() => n.node.k === 'bin' && replace(n, { ...n.node, op })}
                >
                  {op}
                </button>
              {/each}
            </span>
          {:else}
            <span class="chip" data-testid="mod-node-kind">{kindLabel(n.node)}</span>
          {/if}

          <span class="grow"></span>

          {#if n.node.k === 'num'}
            <span class="ctl" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
              <NumberInput
                value={n.node.v}
                step={0.01}
                width={72}
                ariaLabel={tr('mod.blk.num')}
                onchange={(v) => replace(n, { k: 'num', v })}
              />
            </span>
          {:else if n.node.k === 'mod'}
            <span class="ctl wide" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
              {#if modOptions.length > 0}
                <Select
                  value={n.node.id}
                  options={modOptions}
                  ariaLabel={tr('mod.blk.mod')}
                  testid="mod-node-ref"
                  onchange={(v) => replace(n, { k: 'mod', id: String(v) })}
                />
              {:else}
                <span class="note">{tr('mod.blk.noMod')}</span>
              {/if}
            </span>
          {/if}

          <span class="ctl" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
            <IconButton
              icon="ellipsis-vertical"
              label={tr('mod.blk.pick')}
              size="sm"
              testid="mod-node-menu"
              onclick={(e) => {
                menuPath = n.path;
                menuAnchor = e.currentTarget as HTMLElement;
                menuOpen = true;
              }}
            />
          </span>

          {#if !n.root}
            <span
              class="out"
              role="presentation"
              data-out={n.key}
              onpointerdown={(e) => beginWire(e, n.key, n.path)}
            ></span>
          {/if}
        </div>

        {#each Array.from({ length: slotCount(n.node) }, (_, i) => i) as i (i)}
          <div class="row">
            <span
              class="in"
              class:hover={hover === `${n.key}|${i}`}
              role="presentation"
              data-in-path={n.key}
              data-in-slot={i}
              title={tr('mod.blk.port')}
              onpointerdown={(e) => {
                // 从已占用的口上按下 = 把那一枝再拖出去（改接的反向手势）。
                const childKey = pathKey([...n.path, i]);
                if (!slotAt(n.node, i)) return;
                beginWire(e, childKey, [...n.path, i]);
              }}
            ></span>
            <span class="idx">{i + 1}</span>
            <span class="grow"></span>
          </div>
        {/each}

        {#if !fitsBlocks(n.node)}
          <div class="raw mono" title={printExpr(n.node)}>{printExpr(n.node)}</div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="tools" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
    <IconButton icon="maximize" label={tr('mod.graph.fit')} size="sm" testid="mod-graph-fit" onclick={fit} />
    <IconButton
      icon="layout-grid"
      label={tr('mod.graph.tidy')}
      size="sm"
      testid="mod-graph-tidy"
      onclick={() => {
        pos = {};
        resetLayout(storageKey);
        queueMicrotask(fit);
      }}
    />
    <span class="zoom mono">{Math.round(zoom * 100)}%</span>
  </div>
</div>

{#if menuOpen}
  <Menu {items} anchorEl={menuAnchor} testid="mod-node-palette" onclose={() => (menuOpen = false)} />
{/if}

<style>
  /*
   * 点阵底：画布必须能「看得出自己动了」。纯平底上平移一个均匀的界面等于什么
   * 都没发生，而拖节点时人会以为拖的是背景。
   */
  .canvas {
    position: relative;
    height: min(50vh, 440px);
    min-height: 260px;
    overflow: hidden;
    background-color: var(--surface-2);
    background-image: radial-gradient(var(--tl-border) 1px, transparent 1px);
    background-size: 20px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: grab;
    touch-action: none;
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  .wires {
    position: absolute;
    pointer-events: none;
    overflow: visible;
  }
  .wire {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
  }
  .wire.live {
    stroke: var(--accent);
    stroke-dasharray: 4 3;
  }
  .node {
    position: absolute;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  /* 选中态只换描边：节点本身已经有两层颜色，再加填充就分不出前后了。 */
  .node.sel {
    border-color: var(--accent);
  }
  .node.tree-root {
    border-color: var(--text-muted);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    min-width: 0;
    cursor: grab;
  }
  .head:active {
    cursor: grabbing;
  }
  .chip {
    flex: none;
    max-width: 96px;
    padding: 0 5px;
    height: 18px;
    line-height: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--surface-2);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: var(--fs-xs);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .ctl {
    flex: none;
    display: inline-flex;
    cursor: default;
  }
  .ctl.wide {
    flex: 1;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding-left: 2px;
  }
  .idx {
    color: var(--text-muted);
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 10px;
  }
  /*
   * 输入口压左缘、输出口压右缘（负 margin 抵消节点的 4px 内边距）。
   * 命中区比视觉大一圈（`::after` 撑开），否则永远要瞄两个像素。
   */
  .in,
  .out {
    position: relative;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--surface-1);
    cursor: crosshair;
  }
  .in {
    margin-left: -9px;
    border: 1px solid var(--text-muted);
  }
  .out {
    margin-right: -9px;
    border: 1px solid var(--accent);
  }
  .in::after,
  .out::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .in:hover,
  .in.hover {
    background: var(--accent);
    border-color: var(--accent);
  }
  .out:hover {
    background: var(--accent);
  }
  .ops {
    display: inline-flex;
    flex: none;
    gap: 1px;
  }
  .op {
    width: 20px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--input-border);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .op.on {
    color: var(--accent-contrast, #fff);
    background: var(--accent);
    border-color: var(--accent);
  }
  .note {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  /* 超出词汇表的节点：只读源码，别假装能编。 */
  .raw {
    margin-top: 3px;
    padding: 2px 5px;
    overflow: hidden;
    background: var(--surface-2);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tools {
    position: absolute;
    left: 6px;
    bottom: 6px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .zoom {
    min-width: 34px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    text-align: right;
  }
  .mono {
    font-family: 'Cascadia Code', Consolas, monospace;
  }
</style>
