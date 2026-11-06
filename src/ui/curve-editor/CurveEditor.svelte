<script lang="ts">
  /**
   * CurveEditor — 独立的关键帧曲线编辑器浮层。
   *
   * 为什么不是检查器里的一堆控件：曲线要同时看「时间 × 值」两个维度，
   * 而检查器是一列一维表单。塞进去的结果只能是「选一个关键帧 → 改一个数字」，
   * 看不到形状、也没法拖手柄。这里是一块**独立浮层**，与检查器零布局耦合。
   *
   * 呼出入口（都只调 `openCurveEditor`，不各自记状态）：
   *   · 检查器关键帧行右侧的曲线按钮（`KeyableField`）
   *   · 时间轴右键片段 →「编辑关键帧曲线…」
   *   · 选中片段后按 K
   *
   * 硬约定：
   *   · `interp` 是**出向**语义（见 core/curve.ts 的 Key 注释）。工具栏改的是
   *     「所选关键帧之后那一段」，所以选中一个中间关键帧时只出现它的出向手柄。
   *   · 拖动 = 一笔撤销（beginTx → 直改 + touch → endTx）。没拖动就 cancelTx，
   *     不留空撤销记录。
   *   · 时间吸附到帧（1/fps），按住 Alt 关掉；值不吸附（手柄要能过冲）。
   *   · 指针坐标全部经 boundingRect 归一化回 viewBox —— SVG 是缩放的，
   *     直接拿 clientX 减 viewBox 值会在大窗口下整体偏移。
   */
  import { tick } from 'svelte';
  import IconButton from '../controls/IconButton.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Checkbox from '../controls/Checkbox.svelte';
  import { appState } from '../app-state.svelte';
  import { activeElementOwnsSpace } from '../focus';
  import {
    bumpCurveEditor,
    closeCurveEditor,
    setCurveEditorKey,
    type CurveEditorTarget,
  } from './curve-editor-state.svelte';
  import { animatableParams, curveParamOf, type CurveParam } from './curve-meta';
  import {
    clamp,
    curvePath,
    diamondPath,
    fitDomain,
    snapToFrame,
    timeOfX,
    valueOfY,
    xOfTime,
    yOfValue,
    type GraphDomain,
    type PlotBox,
  } from './curve-geometry';
  import {
    autoHandles,
    segmentHandles,
    upsertKey,
    withInterp,
    type Interp,
    type Key,
  } from '../../core/curve';
  import { beatAtTime, snapBeat, timeAtBeat } from '../../core/time';
  import { upsertCurveKey } from '../clip-edit';
  import type { AnyClip } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';

  const VB_W = 540;
  const VB_H = 208;
  const PLOT: PlotBox = { left: 46, top: 12, width: 476, height: 172 };

  interface Props {
    target: CurveEditorTarget;
    /** 层叠序号（App 按数组顺序传）：后开的 / 刚点过的在上面。 */
    layer?: number;
  }
  const { target, layer = 0 }: Props = $props();

  let panelEl: HTMLDivElement | undefined = $state();
  let svgEl: SVGSVGElement | undefined = $state();
  /** 用户拖过标题栏之后的坐标；null = 还没拖过，走 CSS 的层叠默认位置。 */
  let pos = $state<{ x: number; y: number } | null>(null);
  /** 用户拖过右下角之后的尺寸；null = 跟随内容。 */
  let size = $state<{ w: number; h: number } | null>(null);
  let resizing = $state(false);
  /** 左侧参数表折叠（折叠后图占满整宽）。 */
  let sidebarOpen = $state(true);
  let selected = $state<number[]>([]);
  /** 图内框选矩形（viewBox 坐标）。null = 没在框选。 */
  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const clip = $derived.by(() => {
    void appState.version;
    const t = target;
    if (!t) return null;
    const found = appState.store.findClip(t.clipId);
    return found ? (found.clip as AnyClip) : null;
  });

  const clipId = $derived(target.clipId);

  // 片段被删 / 工程切换：这个面板自己退场，别让它指着一个不存在的对象。
  $effect(() => {
    if (!clip) closeCurveEditor(clipId);
  });

  const params = $derived.by(() => {
    void appState.version;
    return clip ? animatableParams(clip) : [];
  });

  const groups = $derived.by(() => {
    const map = new Map<string, CurveParam[]>();
    for (const p of params) {
      const list = map.get(p.group);
      if (list) list.push(p);
      else map.set(p.group, [p]);
    }
    return [...map.entries()];
  });

  const activeKey = $derived.by(() => {
    void appState.version;
    const t = target;
    if (!t || !clip) return null;
    if (t.curveKey && clip.curves[t.curveKey]) return t.curveKey;
    return Object.keys(clip.curves)[0] ?? null;
  });

  // 切片段 / 切曲线 = 清空选中集：下标属于上一条曲线，留着会指到别的 key 上。
  $effect(() => {
    void clipId;
    void activeKey;
    selected = [];
  });

  /*
   * 把「当前显示的属性」同步给时间轴。
   *
   * 包括**自动选第一条**这种情况：用户没有主动点参数表，但面板里看到的确实是
   * 那条曲线，时间轴片段上画的就必须是同一条。属性被删后 activeKey 会回落，
   * 这里也跟着回落。
   */
  $effect(() => {
    if (activeKey) setCurveEditorKey(clipId, activeKey);
  });

  const curve = $derived.by(() => {
    void appState.version;
    return clip && activeKey ? clip.curves[activeKey] ?? null : null;
  });

  const meta = $derived.by(() => {
    void appState.version;
    return clip && activeKey ? curveParamOf(clip, activeKey) : null;
  });

  const grid = $derived(appState.project.beatGrid);

  /** 曲线本地 t=0 对应的绝对时刻（无 anchor 时是片段起点）。 */
  const localOrigin = $derived.by(() => {
    void appState.version;
    if (!clip) return 0;
    if (curve?.beatAnchor) return timeAtBeat(curve.beatAnchor.beat, grid);
    return clip.start;
  });

  /** 绘图用的关键帧：t 换成绝对秒，其余字段（handles）平移不变。 */
  const absKeys = $derived.by(() => {
    void appState.version;
    if (!curve) return [] as Key[];
    const origin = localOrigin;
    return curve.keys.map((k) => ({ ...k, t: k.t + origin }));
  });

  const domain = $derived.by(() => {
    void appState.version;
    const seed: GraphDomain = {
      t0: clip?.start ?? 0,
      t1: clip?.end ?? 1,
      v0: meta?.min ?? 0,
      v1: meta?.max ?? 1,
    };
    return fitDomain(absKeys, seed);
  });

  const points = $derived(
    absKeys.map((k) => ({
      x: xOfTime(k.t, domain, PLOT),
      y: yOfValue(k.v, domain, PLOT),
    })),
  );

  const path = $derived(curvePath(absKeys, domain, PLOT));
  const playX = $derived(xOfTime(appState.playT, domain, PLOT));
  const frameSec = $derived(1 / Math.max(1, appState.project.fps));

  /*
   * ⚠️ 下面几个派生都必须显式读 `appState.version`。
   *
   * `curve` / `clip` 是**原地改的对象**：拖 key 时 `k.t` 变了，但对象引用没变，
   * Svelte 的 `$derived` 用 `===` 判等 ⇒ 不通知下游。表现是「数据改了、手柄和
   * 底部数字框不动」（与 `Inspector.svelte::found` 那条注释同源）。
   */
  const selIndices = $derived.by(() => {
    void appState.version;
    return selected.filter((i) => i >= 0 && i < absKeys.length);
  });
  const single = $derived(selIndices.length === 1 ? selIndices[0]! : -1);
  const singleT = $derived.by(() => {
    void appState.version;
    const k = single >= 0 ? curve?.keys[single] : null;
    return k ? k.t + localOrigin : 0;
  });
  const singleV = $derived.by(() => {
    void appState.version;
    return single >= 0 ? curve?.keys[single]?.v ?? 0 : 0;
  });
  /** 勾选框依赖的是标量，不能直接读原地改的 `curve.beatAnchor`。 */
  const anchorOn = $derived.by(() => {
    void appState.version;
    return !!curve?.beatAnchor;
  });

  const selInterp = $derived.by(() => {
    void appState.version;
    if (!curve || selIndices.length === 0) return null;
    const first = curve.keys[selIndices[0]!]?.interp ?? null;
    return selIndices.every((i) => curve.keys[i]?.interp === first) ? first : null;
  });

  const canAuto = $derived.by(() => {
    void appState.version;
    if (!curve) return false;
    return selIndices.some((i) => {
      if (curve.keys[i]?.interp === 'bezier') return true;
      const prev = curve.keys[i - 1];
      return prev?.interp === 'bezier';
    });
  });

  /* ------------------------------------------------------------ 坐标 */

  function toView(e: MouseEvent | PointerEvent): { x: number; y: number } {
    const el = svgEl;
    if (!el) return { x: PLOT.left, y: PLOT.top };
    const r = el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * VB_W,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * VB_H,
    };
  }

  function tAtPoint(p: { x: number }): number {
    return timeOfX(p.x, domain, PLOT);
  }

  function vAtPoint(p: { y: number }): number {
    return valueOfY(p.y, domain, PLOT);
  }

  function countOf(key: string): number {
    void appState.version;
    return clip?.curves[key]?.keys.length ?? 0;
  }

  /* ------------------------------------------------------------ 窗口拖动 */

  /**
   * 面板根上的指针：点标题栏 = 拖窗口，点按钮 = 让按钮自己处理，点空白 = 抢焦点。
   *
   * 拖拽不挂在 `<header>` 上，是因为静态元素带 pointerdown 会触发 a11y 警告，
   * 而给标题栏加一个假 role 只会让读屏多念一个「按钮」。根面板已经是 dialog，
   * 由它统一分派最干净。
   */
  /**
   * 面板的位置 / 尺寸 / 层叠。
   *
   * 没拖过时按 `slot` 层叠（多开时新面板往右下错开，否则完全重叠）；
   * 拖过之后坐标由面板自己记，`slot` 不再影响位置。
   */
  const panelStyle = $derived.by(() => {
    const parts: string[] = [];
    if (pos) {
      parts.push(`left:${pos.x}px`, `top:${pos.y}px`);
    } else {
      const dx = target.slot * 26;
      const dy = target.slot * 18;
      // 上限跟着视口走：层叠到第 6 个时也别把面板甩出右边。
      parts.push(`left:max(12px, min(calc(50% - 380px + ${dx}px), calc(100vw - 780px)))`);
      parts.push(`bottom:max(12px, calc(44px + ${dy}px))`);
    }
    if (size) parts.push(`width:${size.w}px`, `height:${size.h}px`);
    parts.push(`z-index:calc(var(--z-popover) + ${layer})`);
    return parts.join(';');
  });

  function onPanelPointerDown(e: PointerEvent): void {
    bumpCurveEditor(clipId);
    const t = e.target;
    if (!(t instanceof Element)) return;
    // 按钮 / 自研控件（带 data-exempt）自己处理焦点，别抢。
    if (t.closest('button') || t.closest('[data-exempt]')) return;
    if (t.closest('.head')) {
      startMove(e);
      return;
    }
    if (!(t instanceof HTMLInputElement)) panelEl?.focus();
  }

  function startMove(e: PointerEvent): void {
    if (e.button !== 0) return;
    const el = panelEl;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = r.left;
    const oy = r.top;
    const mv = (ev: PointerEvent): void => {
      pos = {
        x: clamp(ox + ev.clientX - startX, 4, window.innerWidth - r.width - 4),
        y: clamp(oy + ev.clientY - startY, 4, window.innerHeight - r.height - 4),
      };
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** 右下角拖拽改尺寸。最小 520×260，上限是「不超出视口」。 */
  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = panelEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w0 = size?.w ?? r.width;
    const h0 = size?.h ?? r.height;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const maxW = Math.max(520, window.innerWidth - r.left - 8);
    const maxH = Math.max(260, window.innerHeight - r.top - 8);
    resizing = true;
    const mv = (ev: PointerEvent): void => {
      size = {
        w: clamp(w0 + ev.clientX - x0, 520, maxW),
        h: clamp(h0 + ev.clientY - y0, 260, maxH),
      };
    };
    const up = (): void => {
      resizing = false;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /*
   * 面板出现时把焦点拿过来。
   *
   * 组件是**常驻挂载**的（内部 `{#if}` 决定显示），所以 onMount 跑的时候
   * 往往还没有面板 —— 在那里 focus 一次等于什么都没做，表现为「用 K 打开后
   * 按 1/2/3/4 没反应、按 Esc 也关不掉」。依赖 target/clip 的 effect 才踩在
   * 面板真正出现的那个 tick 上。
   */
  $effect(() => {
    if (target && clip) {
      void tick().then(() => panelEl?.focus());
    }
  });

  /* ------------------------------------------------------------ 手势 */

  interface KeySnap {
    index: number;
    t: number;
    v: number;
    lo: number;
    hi: number;
  }

  interface DragState {
    mode: 'keys' | 'out' | 'in';
    pointerId: number;
    x0: number;
    y0: number;
    domain: GraphDomain;
    origin: number;
    primary: number;
    keys: KeySnap[];
    moved: boolean;
    /** 手柄拖动的段跨度与起点（第一次移动时准备）。 */
    span: number;
    base: [number, number];
  }

  let drag: DragState | null = null;

  function beginGesture(): void {
    appState.store.beginTx();
    appState.registerGestureCancel(cancelDrag);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('keydown', onDragKey, true);
  }

  function cleanupGesture(): void {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', cancelDrag);
    window.removeEventListener('keydown', onDragKey, true);
    appState.registerGestureCancel(null);
  }

  function startKeyDrag(index: number, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      selected = selected.includes(index)
        ? selected.filter((i) => i !== index)
        : [...selected, index];
      return;
    }
    if (!selected.includes(index)) selected = [index];
    const cv = curve;
    const key = activeKey;
    if (!cv || !key) return;

    const sel = new Set(selIndices);
    const keys: KeySnap[] = selIndices.map((i) => {
      const k = cv.keys[i]!;
      const prev = cv.keys[i - 1];
      const next = cv.keys[i + 1];
      return {
        index: i,
        t: k.t,
        v: k.v,
        lo: prev && !sel.has(i - 1) ? prev.t + 1e-3 : -Infinity,
        hi: next && !sel.has(i + 1) ? next.t - 1e-3 : Infinity,
      };
    });
    const p = toView(e);
    drag = {
      mode: 'keys',
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      domain: { ...domain },
      origin: localOrigin,
      primary: index,
      keys,
      moved: false,
      span: 0,
      base: [0, 0],
    };
    beginGesture();
  }

  function startHandleDrag(index: number, side: 'out' | 'in', e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selected = [index];
    const p = toView(e);
    drag = {
      mode: side,
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      domain: { ...domain },
      origin: localOrigin,
      primary: index,
      keys: [],
      moved: false,
      span: 0,
      base: [0, 0],
    };
    beginGesture();
  }

  /**
   * 手柄第一次移动时的准备：smooth 的自动手柄先物化成 bezier，再取当前值当基准。
   * 返回 false = 这个手柄没有可编辑的段（例如最后一个 key 的出向）。
   */
  function prepareHandle(d: DragState): boolean {
    const cv = curve;
    if (!cv) return false;
    const owner = cv.keys[d.primary];
    if (!owner) return false;
    if (d.mode === 'out') {
      const next = cv.keys[d.primary + 1];
      if (!next) return false;
      const span = next.t - owner.t;
      if (span <= 1e-9) return false;
      if (owner.interp === 'smooth') {
        const h = segmentHandles(owner, next);
        owner.interp = 'bezier';
        if (h) {
          owner.hOut = [...h.out];
          next.hIn = [...h.in];
        }
      }
      if (!owner.hOut) owner.hOut = [span / 3, 0];
      if (!next.hIn) next.hIn = [-span / 3, 0];
      d.span = span;
      d.base = [owner.hOut[0], owner.hOut[1]];
      return true;
    }
    const prev = cv.keys[d.primary - 1];
    if (!prev) return false;
    const span = owner.t - prev.t;
    if (span <= 1e-9) return false;
    if (prev.interp === 'smooth') {
      const h = segmentHandles(prev, owner);
      prev.interp = 'bezier';
      if (h) {
        prev.hOut = [...h.out];
        owner.hIn = [...h.in];
      }
    }
    if (!prev.hOut) prev.hOut = [span / 3, 0];
    if (!owner.hIn) owner.hIn = [-span / 3, 0];
    d.span = span;
    d.base = [owner.hIn[0], owner.hIn[1]];
    return true;
  }

  function onDragMove(e: PointerEvent): void {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = toView(e);
    if (!d.moved) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) < 2) return;
      d.moved = true;
      if (d.mode !== 'keys' && !prepareHandle(d)) {
        cancelDrag();
        return;
      }
    }

    const dt = tAtPoint(p) - tAtPoint({ x: d.x0 });
    const dv = vAtPoint(p) - vAtPoint({ y: d.y0 });
    const cv = curve;
    if (!cv) return;

    if (d.mode === 'keys') {
      const snap = !e.altKey;
      const lo = d.domain.t0 - d.origin;
      const hi = d.domain.t1 - d.origin;
      for (const s of d.keys) {
        const k = cv.keys[s.index];
        if (!k) continue;
        let t = s.t + dt;
        if (snap) t = snapToFrame(t, frameSec);
        k.t = clamp(t, Math.max(s.lo, lo), Math.min(s.hi, hi));
        k.v = clamp(s.v + dv, d.domain.v0, d.domain.v1);
      }
    } else if (d.mode === 'out') {
      const owner = cv.keys[d.primary];
      if (!owner?.hOut) return;
      owner.hOut = [
        clamp(d.base[0] + dt, 0, d.span),
        d.base[1] + dv,
      ];
    } else {
      const owner = cv.keys[d.primary];
      if (!owner?.hIn) return;
      owner.hIn = [
        clamp(d.base[0] + dt, -d.span, 0),
        d.base[1] + dv,
      ];
    }
    appState.store.touch();
  }

  function endDrag(): void {
    const d = drag;
    if (!d) return;
    cleanupGesture();
    drag = null;
    if (!d.moved) {
      appState.store.cancelTx();
      return;
    }
    appState.store.touch();
    appState.store.endTx(
      tr(d.mode === 'keys' ? 'curve.moveKey' : 'curve.editHandles'),
    );
  }

  function cancelDrag(): void {
    if (!drag) return;
    cleanupGesture();
    drag = null;
    appState.store.cancelTx();
    appState.store.touch();
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDrag();
    }
  }

  /* ------------------------------------------------------------ 图内点击 */

  /**
   * 图空白处按下：拖出框 = 框选关键帧；没拖 = 清空选中并把播放头挪过去。
   *
   * 框选期间**不写工程**（选中的下标不是工程数据），所以没有事务、也没有撤销。
   * 关键帧与手柄自己 `stopPropagation`，不会走到这里。
   */
  function onGraphPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const start = toView(e);
    const pointerId = e.pointerId;
    let moved = false;
    selected = [];

    const mv = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const q = toView(ev);
      if (!moved && Math.hypot(q.x - start.x, q.y - start.y) < 3) return;
      moved = true;
      marquee = { x0: start.x, y0: start.y, x1: q.x, y1: q.y };
      const left = Math.min(start.x, q.x);
      const right = Math.max(start.x, q.x);
      const top = Math.min(start.y, q.y);
      const bottom = Math.max(start.y, q.y);
      selected = points
        .map((p, i) => (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom ? i : -1))
        .filter((i) => i >= 0);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      marquee = null;
      if (!moved) {
        /*
         * 左键单击 = **在点击处新增关键帧**（曲线编辑器最常见的动作）。
         * 只有点在绘图区内才新增；点时间刻度 / 左侧刻度只挪播放头，
         * 这样「想看某一刻的值」不必被迫留下一个 key。
         */
        const inside =
          start.x >= PLOT.left &&
          start.x <= PLOT.left + PLOT.width &&
          start.y >= PLOT.top &&
          start.y <= PLOT.top + PLOT.height;
        if (inside && activeKey) {
          addKeyAt(tAtPoint(start) - localOrigin, vAtPoint(start));
        }
        appState.seek(tAtPoint(start), { snap: false });
      }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const marqueeBox = $derived.by(() => {
    const m = marquee;
    if (!m) return null;
    return {
      left: Math.min(m.x0, m.x1),
      top: Math.min(m.y0, m.y1),
      width: Math.abs(m.x1 - m.x0),
      height: Math.abs(m.y1 - m.y0),
    };
  });

  function addKeyAt(t: number, v: number): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id) return;
    const domains = domain;
    const origin = localOrigin;
    const localT = clamp(t, domains.t0 - origin, domains.t1 - origin);
    const localV = clamp(v, domains.v0, domains.v1);
    appState.store.updateClip(id, tr('curve.addKey'), (c) => {
      const cv = c.curves[key];
      if (!cv) return;
      cv.keys = upsertKey(cv.keys, { t: localT, v: localV, interp: 'linear' });
    });
    const cv = appState.store.findClip(id)?.clip.curves[key];
    if (cv) {
      const i = cv.keys.findIndex((k) => Math.abs(k.t - localT) < 1e-3);
      if (i >= 0) selected = [i];
    }
  }

  /* ------------------------------------------------------------ 编辑 */

  function applyInterp(next: Interp): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id || selIndices.length === 0) return;
    const indices = [...selIndices];
    appState.store.updateClip(id, tr('curve.setInterp'), (c) => {
      const cv = c.curves[key];
      if (cv) cv.keys = withInterp(cv.keys, indices, next);
    });
  }

  function deleteSelected(): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id || selIndices.length === 0) return;
    const indices = new Set(selIndices);
    const n = selIndices.length;
    appState.store.updateClip(id, tr('curve.deleteKeys', { n }), (c) => {
      const cv = c.curves[key];
      if (!cv) return;
      cv.keys = cv.keys.filter((_, i) => !indices.has(i));
      if (cv.keys.length === 0) delete c.curves[key];
    });
    selected = [];
  }

  /** 双击关键帧 = 删掉它（左键单击图内是新增，删除只绑在双击上）。 */
  function deleteKeyAt(index: number): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id) return;
    appState.store.updateClip(id, tr('curve.deleteKeys', { n: 1 }), (c) => {
      const cv = c.curves[key];
      if (!cv) return;
      cv.keys = cv.keys.filter((_, i) => i !== index);
      if (cv.keys.length === 0) delete c.curves[key];
    });
    selected = [];
  }

  function applyAutoHandles(): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id || selIndices.length === 0) return;
    const indices = [...selIndices];
    appState.store.updateClip(id, tr('curve.autoHandles'), (c) => {
      const cv = c.curves[key];
      if (cv) cv.keys = autoHandles(cv.keys, indices);
    });
  }

  function moveSelected(dt: number, dv: number): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id || selIndices.length === 0) return;
    const set = new Set(selIndices);
    appState.store.updateClip(id, tr('curve.moveKey'), (c) => {
      const cv = c.curves[key];
      if (!cv) return;
      for (let i = 0; i < cv.keys.length; i += 1) {
        if (!set.has(i)) continue;
        const k = cv.keys[i]!;
        const prev = cv.keys[i - 1];
        const next = cv.keys[i + 1];
        const lo = prev && !set.has(i - 1) ? prev.t + 1e-3 : -Infinity;
        const hi = next && !set.has(i + 1) ? next.t - 1e-3 : Infinity;
        k.t = clamp(k.t + dt, lo, hi);
        k.v = clamp(k.v + dv, domain.v0, domain.v1);
      }
    });
  }

  function commitTime(index: number, absT: number): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id) return;
    const origin = localOrigin;
    appState.store.updateClip(id, tr('curve.moveKey'), (c) => {
      const cv = c.curves[key];
      const k = cv?.keys[index];
      if (!cv || !k) return;
      const prev = cv.keys[index - 1];
      const next = cv.keys[index + 1];
      k.t = clamp(
        absT - origin,
        prev ? prev.t + 1e-3 : -Infinity,
        next ? next.t - 1e-3 : Infinity,
      );
    });
  }

  function commitValue(index: number, v: number): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id) return;
    appState.store.updateClip(id, tr('curve.setValue'), (c) => {
      const k = c.curves[key]?.keys[index];
      if (k) k.v = v;
    });
  }

  function selectParam(p: CurveParam): void {
    const id = clipId;
    if (!id) return;
    if (clip?.curves[p.key]) {
      setCurveEditorKey(id, p.key);
      return;
    }
    if (!p.animatable || !clip) return;
    const at = Math.min(Math.max(appState.playT, clip.start), clip.end);
    appState.store.updateClip(id, tr('curve.addCurve'), (c) => {
      upsertCurveKey(c, p.key, p.base, at, null, appState.project.beatGrid);
    });
    setCurveEditorKey(id, p.key);
  }

  function toggleAnchor(checked: boolean): void {
    const key = activeKey;
    const id = clipId;
    if (!key || !id) return;
    appState.store.updateClip(id, tr('insp.toggleAnchor'), (c) => {
      const cv = c.curves[key];
      if (!cv) return;
      cv.beatAnchor = checked
        ? { beat: snapBeat(beatAtTime(appState.playT, grid), 'beat', grid.beatsPerBar) }
        : null;
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    const el = e.target;
    if (el instanceof Element) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    }

    /*
     * **面板内的单键不穿透到全局**：那里有 S（切分片段）、F2（改名）、
     * Delete（删片段）等。面板没挂 `data-exempt`（那样 Ctrl+Z 也会被挡掉），
     * 所以必须在这里显式切断冒泡。
     *
     * 修饰键组合例外：Ctrl+Z / Ctrl+Y / Ctrl+S 要能落到全局（撤销 / 重做 / 保存）。
     * Ctrl+C/X/V 例外地切断 —— 否则在曲线编辑器里按 Ctrl+C 会复制**片段**，
     * 而用户多半以为复制的是关键帧（关键帧复制本轮没做）。
     */
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'c' || k === 'x' || k === 'v') e.stopPropagation();
      return;
    }
    if (e.altKey) {
      // Alt+↑↓ = 移轨、Alt+拖动 = 关吸附，都不该在这里触发全局动作
      e.stopPropagation();
      return;
    }
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      closeCurveEditor(clipId);
      return;
    }
    if (e.code === 'Space') {
      // 焦点在按钮 / 复选框上时 Space 归它们（同全局 Space 的既有判据）。
      if (activeElementOwnsSpace()) return;
      e.preventDefault();
      appState.togglePlay();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (selIndices.length === 0) return;
    const k = e.key.toLowerCase();
    if (k === '1') applyInterp('linear');
    else if (k === '2') applyInterp('step');
    else if (k === '3') applyInterp('smooth');
    else if (k === '4') applyInterp('bezier');
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      moveSelected(dir * frameSec * (e.shiftKey ? 10 : 1), 0);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const step = meta?.step ?? 0.01;
      moveSelected(0, dir * step * (e.shiftKey ? 10 : 1));
    }
  }

  /* ------------------------------------------------------------ 手柄几何 */

  interface HandlePoint {
    x: number;
    y: number;
    kind: 'bezier' | 'smooth';
  }

  function outHandleAt(i: number): HandlePoint | null {
    const cv = curve;
    if (!cv) return null;
    const k = cv.keys[i];
    const next = cv.keys[i + 1];
    if (!k || !next) return null;
    if (k.interp !== 'bezier' && k.interp !== 'smooth') return null;
    const h = segmentHandles(k, next);
    if (!h) return null;
    return {
      x: xOfTime(k.t + localOrigin + h.out[0], domain, PLOT),
      y: yOfValue(k.v + h.out[1], domain, PLOT),
      kind: k.interp === 'smooth' ? 'smooth' : 'bezier',
    };
  }

  function inHandleAt(i: number): HandlePoint | null {
    const cv = curve;
    if (!cv) return null;
    const k = cv.keys[i];
    const prev = cv.keys[i - 1];
    if (!k || !prev) return null;
    if (prev.interp !== 'bezier' && prev.interp !== 'smooth') return null;
    const h = segmentHandles(prev, k);
    if (!h) return null;
    return {
      x: xOfTime(k.t + localOrigin + h.in[0], domain, PLOT),
      y: yOfValue(k.v + h.in[1], domain, PLOT),
      kind: prev.interp === 'smooth' ? 'smooth' : 'bezier',
    };
  }

  /* ------------------------------------------------------------ 刻度 */

  function timeTicks(): number[] {
    return [0, 1, 2, 3, 4].map((i) => domain.t0 + ((domain.t1 - domain.t0) * i) / 4);
  }

  function valueTicks(): number[] {
    return [0, 1, 2, 3, 4].map((i) => domain.v0 + ((domain.v1 - domain.v0) * i) / 4);
  }

  function fmtTick(v: number): string {
    // 位数跟着量程走：0..1 给两位、0..0.01 给四位，否则小量程会看到一串 0.00。
    const span = domain.v1 - domain.v0;
    const digits = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 4;
    return v.toFixed(digits);
  }

  const interpOptions: { id: Interp; labelKey: 'curve.interpLinear' | 'curve.interpStep' | 'curve.interpSmooth' | 'curve.interpBezier'; testid: string }[] = [
    { id: 'linear', labelKey: 'curve.interpLinear', testid: 'curve-interp-linear' },
    { id: 'step', labelKey: 'curve.interpStep', testid: 'curve-interp-step' },
    { id: 'smooth', labelKey: 'curve.interpSmooth', testid: 'curve-interp-smooth' },
    { id: 'bezier', labelKey: 'curve.interpBezier', testid: 'curve-interp-bezier' },
  ];
</script>

{#if target && clip}
  <div
    class="panel"
    data-paper=""
    class:moved={pos !== null}
    class:resizing
    bind:this={panelEl}
    role="dialog"
    aria-label={tr('curve.title')}
    aria-modal="false"
    tabindex="-1"
    data-testid="curve-editor"
    data-curve-clip={clipId}
    style={panelStyle}
    onkeydown={onKeyDown}
    onpointerdown={onPanelPointerDown}
  >
    <header class="head">
      <IconButton
        icon={sidebarOpen ? 'panel-left-close' : 'panel-left-open'}
        label={tr('curve.toggleParams')}
        size="sm"
        testid="curve-toggle-sidebar"
        onclick={() => (sidebarOpen = !sidebarOpen)}
      />
      <span class="title">{tr('curve.title')}</span>
      <span class="clip-name">{clip.label || clip.kind}</span>
      <span class="grow"></span>
      <IconButton
        icon="x"
        label={tr('curve.close')}
        size="sm"
        testid="curve-close"
        onclick={() => closeCurveEditor(clipId)}
      />
    </header>

    <div class="body">
      {#if sidebarOpen}
        <aside class="params" data-testid="curve-param-list">
          {#each groups as [group, list] (group)}
            <div class="group">{group}</div>
            {#each list as p (p.key)}
              {@const count = countOf(p.key)}
              <button
                type="button"
                class="param"
                class:on={activeKey === p.key}
                class:has={count > 0}
                data-testid="curve-param"
                data-curve-key={p.key}
                title={count > 0 ? p.label : tr('curve.addHint', { label: p.label })}
                disabled={count === 0 && !p.animatable}
                onclick={() => selectParam(p)}
              >
                <span class="dot"></span>
                <span class="name">{p.label}</span>
                {#if count > 0}<span class="count">{count}</span>{/if}
              </button>
            {/each}
          {/each}
        </aside>
      {/if}

      <div class="main">
        <div class="toolbar">
          <span class="seg" role="group" aria-label={tr('curve.interp')}>
            {#each interpOptions as o (o.id)}
              <button
                type="button"
                class:on={selInterp === o.id}
                data-testid={o.testid}
                disabled={selIndices.length === 0}
                title={tr('curve.interpTip')}
                onclick={() => applyInterp(o.id)}
              >
                {tr(o.labelKey)}
              </button>
            {/each}
          </span>
          <IconButton
            icon="rotate-ccw"
            label={tr('curve.autoHandles')}
            size="sm"
            testid="curve-auto-handles"
            disabled={!canAuto}
            onclick={applyAutoHandles}
          />
          <span class="grow"></span>
          {#if selIndices.length > 0}
            <span class="sel">{tr('curve.selected', { n: selIndices.length })}</span>
          {/if}
          <IconButton
            icon="trash"
            label={tr('curve.deleteKey')}
            size="sm"
            variant="danger"
            testid="curve-delete-key"
            disabled={selIndices.length === 0}
            onclick={deleteSelected}
          />
        </div>

        <div class="graph-wrap">
          <svg
            bind:this={svgEl}
            class="graph"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            role="application"
            aria-label={tr('curve.graphAria')}
            data-testid="curve-graph"
            onpointerdown={onGraphPointerDown}
          >
            {#each valueTicks() as v (v)}
              <line
                class="grid-line"
                x1={PLOT.left}
                x2={PLOT.left + PLOT.width}
                y1={yOfValue(v, domain, PLOT)}
                y2={yOfValue(v, domain, PLOT)}
              />
              <text
                class="grid-text"
                x={PLOT.left - 5}
                y={yOfValue(v, domain, PLOT) + 2.5}
                text-anchor="end">{fmtTick(v)}</text
              >
            {/each}
            {#each timeTicks() as t (t)}
              <line
                class="grid-line"
                x1={xOfTime(t, domain, PLOT)}
                x2={xOfTime(t, domain, PLOT)}
                y1={PLOT.top}
                y2={PLOT.top + PLOT.height}
              />
              <text
                class="grid-text"
                x={xOfTime(t, domain, PLOT)}
                y={PLOT.top + PLOT.height + 12}
                text-anchor="middle">{t.toFixed(2)}s</text
              >
            {/each}

            {#if playX > PLOT.left && playX < PLOT.left + PLOT.width}
              <line
                class="playhead"
                x1={playX}
                x2={playX}
                y1={PLOT.top}
                y2={PLOT.top + PLOT.height}
              />
            {/if}

            {#if marqueeBox}
              <rect
                class="marquee"
                x={marqueeBox.left}
                y={marqueeBox.top}
                width={marqueeBox.width}
                height={marqueeBox.height}
              />
            {/if}

            {#if !curve}
              <!-- 空状态：参数表本身是入口，这里只告诉用户「点左边那一下」 -->
              <text
                class="empty-hint"
                x={PLOT.left + PLOT.width / 2}
                y={PLOT.top + PLOT.height / 2}
                text-anchor="middle">{tr('curve.emptyHint')}</text
              >
            {/if}

            {#if curve && activeKey}
              <path class="curve" d={path} data-testid="curve-path" />

              {#each selIndices as i (i)}
                {@const p = points[i]}
                {#if p}
                  {@const oh = outHandleAt(i)}
                  {#if oh}
                    <line class="handle-line" x1={p.x} y1={p.y} x2={oh.x} y2={oh.y} />
                    <circle
                      class="handle {oh.kind}"
                      cx={oh.x}
                      cy={oh.y}
                      r="4"
                      role="button"
                      tabindex="-1"
                      aria-label={tr('curve.handleOut')}
                      data-testid="curve-handle-out"
                      data-key-index={i}
                      onpointerdown={(e) => startHandleDrag(i, 'out', e)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selected = [i];
                        }
                      }}
                    />
                  {/if}
                  {@const ih = inHandleAt(i)}
                  {#if ih}
                    <line class="handle-line" x1={p.x} y1={p.y} x2={ih.x} y2={ih.y} />
                    <circle
                      class="handle {ih.kind}"
                      cx={ih.x}
                      cy={ih.y}
                      r="4"
                      role="button"
                      tabindex="-1"
                      aria-label={tr('curve.handleIn')}
                      data-testid="curve-handle-in"
                      data-key-index={i}
                      onpointerdown={(e) => startHandleDrag(i, 'in', e)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selected = [i];
                        }
                      }}
                    />
                  {/if}
                {/if}
              {/each}

              {#each points as p, i (i)}
                {@const key = absKeys[i]!}
                <g
                  class="node"
                  class:selected={selIndices.includes(i)}
                  data-testid="curve-node"
                  data-key-index={i}
                  role="button"
                  tabindex="-1"
                  aria-label={tr('curve.keyAria', {
                    n: i + 1,
                    t: key.t.toFixed(2),
                    v: key.v.toFixed(3),
                  })}
                  onpointerdown={(e) => startKeyDrag(i, e)}
                  ondblclick={(e) => {
                    e.stopPropagation();
                    deleteKeyAt(i);
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selected = [i];
                    }
                  }}
                >
                  <circle class="hit" cx={p.x} cy={p.y} r="9" />
                  <path
                    class="diamond"
                    d={diamondPath(p.x, p.y, selIndices.includes(i) ? 5.5 : 4.5)}
                  />
                </g>
              {/each}
            {/if}
          </svg>
        </div>

        <div class="foot">
          {#if single >= 0}
            <span class="field">
              <span class="lbl">{tr('curve.time')}</span>
              <NumberInput
                value={singleT}
                min={domain.t0}
                max={domain.t1}
                step={frameSec}
                width={64}
                suffix="s"
                align="right"
                testid="curve-key-time"
                onchange={(v) => commitTime(single, v)}
              />
            </span>
            <span class="field">
              <span class="lbl">{tr('curve.value')}</span>
              <NumberInput
                value={singleV}
                min={domain.v0}
                max={domain.v1}
                step={meta?.step ?? 0.01}
                width={64}
                align="right"
                testid="curve-key-value"
                onchange={(v) => commitValue(single, v)}
              />
            </span>
          {:else}
            <span class="hint">{tr('curve.hint')}</span>
          {/if}
          <span class="grow"></span>
          {#if curve}
            <Checkbox
              checked={anchorOn}
              label={tr('insp.anchorBeat')}
              tipText={tr('insp.anchorTip')}
              testid="curve-anchor"
              onchange={toggleAnchor}
            />
          {/if}
        </div>
      </div>
    </div>

    <button
      type="button"
      class="resize"
      aria-label={tr('curve.resize')}
      data-testid="curve-resize"
      onpointerdown={startResize}
    ></button>
  </div>
{/if}

<style>
  .panel {
    position: fixed;
    /* 默认尺寸；`size` 由右下角手柄写进内联样式。 */
    width: min(760px, calc(100vw - 24px));
    min-width: 520px;
    min-height: 260px;
    max-width: calc(100vw - 8px);
    max-height: calc(100vh - 8px);
    display: flex;
    flex-direction: column;
    background: var(--surface-3);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-md);
    /* 浮层没有布局槽位，纯边框与背景分不开 —— 这是 shadow token 的唯一用途。 */
    box-shadow: var(--shadow-float);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    overflow: hidden;
  }
  .panel.moved {
    bottom: auto;
  }
  .panel.resizing {
    user-select: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 28px;
    padding: 0 var(--sp-2) 0 var(--sp-4);
    background: var(--surface-2);
    border-bottom: 1px solid var(--input-border);
    cursor: move;
    user-select: none;
  }
  .title {
    font-weight: 600;
  }
  .clip-name {
    color: var(--text-secondary);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .params {
    width: 178px;
    flex-shrink: 0;
    padding: var(--sp-2) var(--sp-1);
    border-right: 1px solid var(--input-border);
    overflow-y: auto;
    min-height: 0;
  }
  .group {
    padding: var(--sp-1) var(--sp-2) 2px;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    text-transform: none;
  }
  .param {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    height: 21px;
    padding: 0 var(--sp-2);
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: var(--fs-xs);
    text-align: left;
    cursor: pointer;
  }
  .param:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .param.on {
    background: var(--surface-active);
    color: var(--text-primary);
  }
  .param:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .param .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-disabled);
    flex-shrink: 0;
  }
  .param.has .dot {
    background: var(--accent);
  }
  .param .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .param .count {
    margin-left: auto;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 30px;
    padding: 0 var(--sp-3);
    border-bottom: 1px solid var(--input-border);
  }
  .seg {
    display: flex;
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .seg button {
    height: 21px;
    padding: 0 7px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--input-border);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .seg button:last-child {
    border-right: none;
  }
  .seg button:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .seg button.on {
    background: var(--surface-active);
    color: var(--text-primary);
  }
  .seg button:disabled {
    color: var(--text-disabled);
    cursor: default;
  }
  .sel {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .graph-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: var(--sp-2) var(--sp-3) 0;
  }
  .graph {
    display: block;
    flex: 1;
    width: 100%;
    min-height: 120px;
    height: auto;
    aspect-ratio: 540 / 208;
    background: var(--surface-2);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    cursor: crosshair;
    touch-action: none;
  }
  .grid-line {
    stroke: var(--input-border);
    stroke-width: 0.6;
  }
  .grid-text {
    fill: var(--text-muted);
    font-size: 8px;
    font-family: var(--font-mono);
  }
  .empty-hint {
    fill: var(--text-muted);
    font-size: 9px;
  }
  /* 右下角缩放手柄：按钮只为可聚焦 / 有 aria-label，视觉上只剩两条短线。 */
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
  .curve {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.6;
    pointer-events: none;
  }
  .playhead {
    stroke: var(--accent);
    stroke-width: 1;
    opacity: 0.45;
    pointer-events: none;
  }
  .node .hit {
    fill: transparent;
  }
  .node .diamond {
    fill: var(--surface-3);
    stroke: var(--accent);
    stroke-width: 1.2;
    pointer-events: none;
  }
  .node.selected .diamond {
    fill: var(--accent);
  }
  .node:hover .diamond {
    stroke-width: 2;
  }
  .handle-line {
    stroke: var(--text-muted);
    stroke-width: 0.8;
    stroke-dasharray: 2 2;
    pointer-events: none;
  }
  .handle {
    fill: var(--surface-3);
    stroke: var(--text-secondary);
    stroke-width: 1.2;
    cursor: grab;
  }
  .handle.smooth {
    stroke-dasharray: 2 1;
  }
  .marquee {
    fill: color-mix(in srgb, var(--accent) 12%, transparent);
    stroke: var(--accent);
    stroke-width: 0.8;
    stroke-dasharray: 3 2;
    pointer-events: none;
  }
  .handle:hover {
    stroke: var(--accent);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--sp-2) var(--sp-3);
    min-height: 30px;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .lbl,
  .hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
</style>
