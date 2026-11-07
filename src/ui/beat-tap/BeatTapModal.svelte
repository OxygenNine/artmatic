<script lang="ts">
  /**
   * BeatTapModal — 打点计时（v21）。
   *
   * 解决的问题：一首音乐不只有等距的重拍，旋律 / 鼓点的落点常常不在 BPM 网格上。
   * 自动 BPM 估计只能给一条等距网格，对不上这些音符。这里让用户**跟着音乐
   * 亲手把落点点下来**，得到一组 `Project.beatMarks`：
   *
   *   - 主时间轴把它们画成可吸附的虚线（`grid-draw.ts`），段落带画成刻度；
   *   - 数据是秒 + 升序，不参与任何渲染 / 音频求值（见 `core/beat-marks.ts`）。
   *
   * ## 录制的覆盖语义
   *
   * 从**播放头**起录。记下 `recordStart`，把现有节奏点分成两半：
   *   - `keep`：比起点早的点 —— 这轮永远不会经过，原样保留；
   *   - `carry`：起点及之后的点 —— 播放头走过哪个就清哪个，只接受新打的点。
   * 于是「移动播放头后再开始录制，播放头所过之处之前的标记均被清除」是
   * 逐帧成立的，而不是开录就把后半首全抹掉（那样停早了会丢还没走到的地方）。
   *
   * 全程**不暂停播放**：空格 / 左键只打点。停止录制、关闭弹窗才结算成一笔撤销。
   *
   * ## 为什么用 `currentTapT()`
   *
   * 人跟着**听到的**声音按下去，而 `playT` 是已经排进声卡的时间线。两者差一个
   * 输出延迟（10–40 ms，卡点听得出来）。`AudioPlayer.currentTapT()` 扣掉它；
   * 取不到（没在播）才退回 `playT`。
   *
   * ## 坐标：像素 = 秒 × zoom
   *
   * 弹窗里的时间线**不是**整首铺满一屏：几分钟的歌那样每个点会挤成一团。
   * 内容宽度 = `duration * zoom`，横向滚动；播放 / 录制时自动跟随播放头。
   * 缩放锚在视口中心（Ctrl+滚轮锚在指针），与主流时间轴一致。
   *
   * 非录制模式的手势：
   *   - 左键空白拖动 = 框选；单击空白 = 清空选择；
   *   - 左键拖圆点 = 移动（选中的一起动）；
   *   - **右键 = 菜单**（这是新增点的唯一入口；左键不再直接加点）。
   */
  import { tick } from 'svelte';
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Menu from '../controls/Menu.svelte';
  import type { MenuItem } from '../controls/menu-model';
  import { appState } from '../app-state.svelte';
  import { beatAtTime } from '../../core/time';
  import {
    BEAT_MARK_TAP_GUARD_SEC,
    insertBeatMark,
    mergeRecordedMarks,
    quantizeBeatTime,
    sanitizeBeatMarks,
  } from '../../core/beat-marks';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  /* ------------------------------------------------------------- 派生数据 */

  const duration = $derived.by(() => {
    void appState.version;
    return Math.max(0.01, appState.store.project.duration);
  });
  const grid = $derived.by(() => {
    void appState.version;
    return { ...appState.store.project.beatGrid };
  });
  const fps = $derived.by(() => {
    void appState.version;
    return Math.max(1, appState.store.project.fps);
  });
  const stored = $derived.by(() => {
    void appState.version;
    return [...appState.store.project.beatMarks];
  });
  /** 音乐块只用来给眼睛一个「歌走到哪」的参照，不参与打点。 */
  const audioClips = $derived.by(() => {
    void appState.version;
    const out: { id: string; label: string; start: number; end: number }[] = [];
    for (const track of appState.store.project.tracks) {
      if (track.kind !== 'audio') continue;
      for (const c of track.clips) out.push({ id: c.id, label: c.label, start: c.start, end: c.end });
    }
    return out.sort((a, b) => a.start - b.start);
  });
  const barBeat = $derived.by(() => {
    const b = Math.max(0, beatAtTime(appState.playT, grid));
    const bar = Math.floor(b / grid.beatsPerBar) + 1;
    const beat = Math.floor(b % grid.beatsPerBar) + 1;
    return `${bar}.${beat}`;
  });

  /* --------------------------------------------------------------- 状态 */

  let recording = $state(false);
  /** 录制起点之前、这轮永远走不到的点。 */
  let keep = $state<number[]>([]);
  /** 录制起点之后、播放头还没走到的旧点；走到的逐个剔除。 */
  let carry = $state<number[]>([]);
  /** 这一轮新打的点。 */
  let take = $state<number[]>([]);
  let recordStart = 0;

  /** 选中态用**时间**而不是下标：排序之后下标会变，时间不会（点已去重到 1 ms）。 */
  let selected = $state<number[]>([]);
  /** 拖动中的临时数组（松手才落库 = 一笔撤销）。 */
  let dragMarks = $state<number[] | null>(null);
  /** 框选框（秒区间）；`null` = 没在框选。 */
  let marquee = $state<{ from: number; to: number } | null>(null);
  /** 右键菜单：屏幕坐标 + 鼠标处的时间 + 命中的点（`null` = 空白）。 */
  let ctx = $state<{ x: number; y: number; time: number; hit: number | null } | null>(null);

  let laneEl = $state<HTMLDivElement | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);
  let viewW = $state(0);
  let scrollLeft = $state(0);
  /** 每秒多少像素。`0` = 还没初始化（等 `viewW` 量出来）。 */
  let zoom = $state(0);
  let centered = false;

  const visible = $derived.by(() => {
    if (dragMarks) return dragMarks;
    if (!recording) return stored;
    return [...keep, ...carry, ...take].sort((a, b) => a - b);
  });
  const contentW = $derived(Math.max(1, duration * (zoom || 1)));
  /** 整首铺满视口的缩放（最小缩放：不允许比它更小）。 */
  const fitZoom = $derived(viewW > 0 ? viewW / duration : 0);
  const zoomMultiple = $derived(fitZoom > 0 && zoom > 0 ? zoom / fitZoom : 1);
  /** 标尺刻度间隔（秒）：选第一个「间隔 ≥ 64px」的档。 */
  const tickStep = $derived.by(() => {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    if (!zoom) return 1;
    return steps.find((s) => s * zoom >= 64) ?? 600;
  });

  /*
   * 只渲染**视口附近**的刻度和点：一首 5 分钟的歌在 400px/s 下有几万个
   * 网格位置，全量 DOM 会把缩放拖成幻灯片。前后各多留一屏，滚动时不会
   * 出现「边缘空白一帧」。
   */
  const viewFrom = $derived(Math.max(0, (scrollLeft - viewW) / (zoom || 1)));
  const viewTo = $derived(Math.min(duration, (scrollLeft + viewW * 2) / (zoom || 1)));
  const shownMarks = $derived(
    zoom ? visible.filter((m) => m >= viewFrom && m <= viewTo) : visible,
  );
  const ticks = $derived.by(() => {
    const out: number[] = [];
    if (!zoom) return out;
    const step = tickStep;
    const from = Math.floor(viewFrom / step) * step;
    const to = Math.min(duration, viewTo);
    for (let t = from; t <= to + 1e-6; t += step) {
      if (t < 0 || t > duration) continue;
      out.push(Math.round(t * 1000) / 1000);
    }
    return out;
  });

  /* ------------------------------------------------------------- 播放 / 录制 */

  function finishRecording(): void {
    if (!recording) return;
    const merged = mergeRecordedMarks(keep, carry, take);
    // 选中这一轮**最后打的**点（不是整表最后一个：后面的旧点可能还在）。
    const lastNew = take.length ? take.reduce((a, b) => Math.max(a, b)) : null;
    recording = false;
    keep = [];
    carry = [];
    take = [];
    selected = lastNew !== null ? [lastNew] : [];
    appState.store.setBeatMarks(merged, tr('tl.recordBeatMarks'));
  }

  function startRecording(): void {
    if (recording) return;
    const startT = Math.max(0, appState.playT);
    const all = stored;
    recordStart = startT;
    keep = all.filter((m) => m < startT - 0.0005);
    carry = all.filter((m) => m >= startT - 0.0005);
    take = [];
    selected = [];
    dragMarks = null;
    marquee = null;
    ctx = null;
    recording = true;
    if (!appState.playing) {
      // 停在末尾时从 0 起播，否则「按录制」看起来什么都没发生。
      if (appState.playT >= duration - 1e-3) appState.seek(0);
      void appState.play();
    }
  }

  function toggleRecording(): void {
    if (recording) {
      finishRecording();
      if (appState.playing) appState.pause();
    } else {
      startRecording();
    }
  }

  function togglePlay(): void {
    if (appState.playing) {
      finishRecording();
      appState.pause();
    } else {
      if (appState.playT >= duration - 1e-3) appState.seek(0);
      void appState.play();
    }
  }

  /**
   * 播放头走过 `carry` 里的点时把它们剔掉。只在真的有点被走过时写状态。
   *
   * 用 `currentTapT()` 而不是 `playT`：剔除线与打点线必须是**同一个时刻**
   * （耳朵听到的那一帧）。用 `playT` 会提前一个输出延迟把「刚打过的位置」
   * 划进已走过区，表现为偶尔少一个点。`playT` 仍然读一次 —— 它是这个 effect
   * 的响应式驱动源。
   */
  $effect(() => {
    void appState.playT;
    if (!recording) return;
    const t = appState.player?.currentTapT?.() ?? appState.playT;
    if (!carry.some((m) => m <= t + 0.0005)) return;
    // 选中的旧点被剔除 → 选中态一起清掉（否则 Delete / 方向键会静默无效）。
    if (selected.some((m) => m <= t + 0.0005)) {
      selected = selected.filter((m) => m > t + 0.0005);
    }
    carry = carry.filter((m) => m > t + 0.0005);
  });

  /** 播到头 / 用户点了暂停 → 自动结算这一轮（不留一个永远开着的录制态）。 */
  $effect(() => {
    if (recording && !appState.playing) finishRecording();
  });

  function tapAt(t: number): void {
    if (!recording) return;
    const at = quantizeBeatTime(Math.max(recordStart, Math.min(duration, t)));
    const guard = BEAT_MARK_TAP_GUARD_SEC;
    /*
     * 只和 `keep + take` 去抖：`carry` 是**正在被覆盖**的旧点，它马上会被
     * 播放头剔掉。把它算进去的话，「旧点旁边重打一下」会被静默吞掉，等旧点
     * 被剔除后那个位置就空了 —— 用户看到的是「这一下没打上」。
     */
    const exists = [...keep, ...take].some((m) => Math.abs(m - at) < guard);
    if (exists) return;
    take = [...take, at];
    selected = [at];
  }

  /** 当前「听到的时刻」。没在播时退回播放头（此时打点没有音画同步可言）。 */
  function tapNow(): void {
    tapAt(appState.player?.currentTapT?.() ?? appState.playT);
  }

  /* ------------------------------------------------------------- 时间换算 */

  function fmt(t: number): string {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }

  function fmtTick(t: number): string {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const text = tickStep < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
    return `${m}:${text}`;
  }

  function clampTime(t: number): number {
    return Math.max(0, Math.min(duration, t));
  }

  /** 内容坐标 → 秒。元素是滚动内容的整宽，`rect.left` 已经含滚动偏移。 */
  function timeAtX(clientX: number, el: HTMLElement | null): number {
    if (!el || !zoom) return 0;
    const rect = el.getBoundingClientRect();
    return clampTime((clientX - rect.left) / zoom);
  }

  function xOf(t: number): number {
    return t * (zoom || 1);
  }

  function closestIn(list: readonly number[], t: number): number | null {
    if (!list.length) return null;
    return list.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  }

  /* --------------------------------------------------------------- 缩放 */

  function clampZoom(z: number): number {
    const lo = fitZoom || 1;
    return Math.max(lo, Math.min(400, z));
  }

  /** 缩放并保持 `clientX` 处的时间不动；不传 clientX 就锚在视口中心。 */
  function setZoom(next: number, clientX?: number): void {
    const el = scrollEl;
    if (!el || !zoom || !fitZoom) return;
    const target = clampZoom(next);
    if (Math.abs(target - zoom) < 1e-6) return;
    const rect = el.getBoundingClientRect();
    const anchorX =
      clientX === undefined ? rect.width / 2 : Math.max(0, Math.min(rect.width, clientX - rect.left));
    const anchorT = (el.scrollLeft + anchorX) / zoom;
    zoom = target;
    void tick().then(() => {
      if (!scrollEl) return;
      scrollEl.scrollLeft = Math.max(0, anchorT * target - anchorX);
      // 读回而不是写计算值：内容变窄时浏览器会钳制，状态必须跟着真实值走。
      scrollLeft = scrollEl.scrollLeft;
    });
  }

  // 首次量到宽度之后给一个舒服的初始缩放：跟随主时间轴的 px/beat，
  // 但不小于「整首铺满」、也不大于 400px/s。
  $effect(() => {
    if (!viewW || zoom) return;
    const beatDur = 60 / Math.max(1, grid.bpm);
    zoom = clampZoom(appState.pxPerBeat / beatDur);
  });

  // 打开时把播放头放到视口中间；之后不再自动跳（除了播放 / 录制跟随）。
  $effect(() => {
    if (centered || !zoom || !viewW) return;
    const el = scrollEl;
    if (!el) return;
    el.scrollLeft = Math.max(0, appState.playT * zoom - viewW / 2);
    scrollLeft = el.scrollLeft;
    centered = true;
  });

  // 播放 / 录制期间跟随播放头；留 10% ~ 90% 的舒适区，避免每帧都动。
  $effect(() => {
    const t = appState.playT;
    if (!appState.playing || !zoom) return;
    const el = scrollEl;
    if (!el) return;
    const x = t * zoom;
    const w = el.clientWidth;
    if (x < el.scrollLeft + w * 0.1 || x > el.scrollLeft + w * 0.9) {
      el.scrollLeft = Math.max(0, x - w / 2);
      scrollLeft = el.scrollLeft;
    }
  });

  // Ctrl+滚轮缩放（锚在指针）；普通滚轮把纵向滚动映射成横向滚动。
  // 必须非 passive —— Svelte 默认给 wheel 挂 passive，preventDefault 会失效。
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault();
        setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
        return;
      }
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /* ------------------------------------------------------------- 选择 / 手动编辑 */

  function nearestMark(t: number): number | null {
    if (!zoom) return null;
    let best: number | null = null;
    let bestPx = 7;
    for (const m of stored) {
      const px = Math.abs(m - t) * zoom;
      if (px <= bestPx) {
        best = m;
        bestPx = px;
      }
    }
    return best;
  }

  /** 成员判定走 Set：拖一整组 / 框选几百个点时，渲染里不能每次线性扫一遍。 */
  const selectedSet = $derived(new Set(selected));

  function isSelected(t: number): boolean {
    return selectedSet.has(t);
  }

  function toggleSelected(t: number): void {
    selected = isSelected(t) ? selected.filter((m) => Math.abs(m - t) >= 1e-6) : [...selected, t];
  }

  function addMark(t: number): void {
    const at = quantizeBeatTime(t);
    // 手动新增只按 1 ms 去重：右键点在哪就该落在哪（30 ms 是录制时的防手抖）。
    const next = insertBeatMark(stored, at, 0.001);
    if (next.length !== stored.length) {
      appState.store.setBeatMarks(next, tr('tl.addBeatMark'));
      selected = [at];
    } else {
      const near = nearestMark(at);
      selected = near !== null ? [near] : [];
    }
  }

  function deleteSelected(): void {
    if (recording || !selected.length) return;
    const drop = new Set(selected);
    const next = visible.filter((m) => !drop.has(m));
    selected = [];
    appState.store.setBeatMarks(next, tr('tl.removeBeatMark'));
  }

  /**
   * 方向键微调选中的点（1 帧 / Shift 10 帧）。整首歌缩到一屏时，1px 可能是
   * 几百毫秒 —— 拖动只够粗调，精调得有这条按帧走的路。
   */
  function nudgeSelected(dir: number, frames: number): void {
    if (recording || !selected.length) return;
    const set = new Set(selected);
    const delta = (dir * frames) / fps;
    // 整组不能有任何一个越过 0。
    const d = Math.max(delta, -Math.min(...selected));
    const next = sanitizeBeatMarks(
      visible.map((m) => (set.has(m) ? clampTime(m + d) : m)),
    );
    appState.store.setBeatMarks(next, tr('tl.moveBeatMark'));
    const targets = [...set].map((m) => quantizeBeatTime(clampTime(m + d)));
    selected = [...new Set(targets.map((t) => closestIn(next, t)).filter((t): t is number => t !== null))];
  }

  /**
   * 拖动点。**始终以按下时的数组为基准**，并且整组一起动：
   * 排序会让被拖的点换下标，按上一次结果继续拖会中途抓到邻居。
   */
  function startMarkDrag(e: PointerEvent, from: number): void {
    e.preventDefault();
    e.stopPropagation();
    const base = [...visible];
    const moving = selected.some((m) => Math.abs(m - from) < 1e-6) ? [...selected] : [from];
    if (!selected.some((m) => Math.abs(m - from) < 1e-6)) selected = [from];
    const indices = moving
      .map((t) => base.findIndex((m) => Math.abs(m - t) < 1e-6))
      .filter((i) => i >= 0);
    if (!indices.length) return;

    const startX = e.clientX;
    const minT = Math.min(...indices.map((i) => base[i]!));
    const maxT = Math.max(...indices.map((i) => base[i]!));
    let moved = false;
    let d = 0;

    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      if (!moved) return;
      d = (ev.clientX - startX) / (zoom || 1);
      d = Math.max(d, -minT);
      d = Math.min(d, duration - maxT);
      const next = base.slice();
      for (const i of indices) next[i] = quantizeBeatTime(base[i]! + d);
      dragMarks = sanitizeBeatMarks(next);
      selected = indices.map((i) => quantizeBeatTime(clampTime(base[i]! + d)));
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = (): void => {
      cleanup();
      const next = dragMarks;
      dragMarks = null;
      if (!moved || !next) {
        // 只是点了一下（没拖）：多选收敛到这一个点，与主流时间轴一致。
        selected = [from];
        return;
      }
      appState.store.setBeatMarks(next, tr('tl.moveBeatMark'));
      // 落库时可能因去重被并掉，选中态跟着这次的数组走（不要再去读 store 的
      // 派生值：它要等 Svelte 下一轮 flush 才是新的）。
      selected = [...new Set(
        selected.map((t) => closestIn(next, t)).filter((t): t is number => t !== null),
      )];
    };
    const onCancel = (): void => {
      cleanup();
      dragMarks = null;
      selected = moving;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /** 空白处左键拖动 = 框选；单击 = 清空选择。 */
  function startMarquee(e: PointerEvent): void {
    const startX = e.clientX;
    const from = timeAtX(e.clientX, laneEl);
    let moved = false;
    let to = from;

    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (!moved) return;
      to = timeAtX(ev.clientX, laneEl);
      marquee = { from, to };
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = (): void => {
      cleanup();
      marquee = null;
      if (!moved) {
        if (!e.shiftKey) selected = [];
        return;
      }
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const hit = visible.filter((m) => m >= lo && m <= hi);
      selected = e.shiftKey ? [...new Set([...selected, ...hit])] : hit;
    };
    const onCancel = (): void => {
      cleanup();
      marquee = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function laneDown(e: PointerEvent): void {
    if (e.button !== 0 || recording) return;
    e.preventDefault();
    const t = timeAtX(e.clientX, laneEl);
    const hit = nearestMark(t);
    if (hit !== null) {
      if (e.shiftKey) {
        toggleSelected(hit);
        return;
      }
      if (!isSelected(hit)) selected = [hit];
      startMarkDrag(e, hit);
      return;
    }
    startMarquee(e);
  }

  /* --------------------------------------------------------------- 右键菜单 */

  function laneContext(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (recording) return;
    const time = timeAtX(e.clientX, laneEl);
    const hit = nearestMark(time);
    // 右键点在未选中的点上 → 先只选它（多选时右键其中一个则保留整组）。
    if (hit !== null && !isSelected(hit)) selected = [hit];
    ctx = { x: e.clientX, y: e.clientY, time, hit };
  }

  const ctxItems = $derived.by<MenuItem[]>(() => {
    if (!ctx) return [];
    const time = ctx.time;
    if (ctx.hit === null) {
      return [
        {
          id: 'add',
          label: tr('tl.beatTapAddHere'),
          icon: 'plus',
          testid: 'beat-tap-menu-add',
          onselect: () => addMark(time),
        },
      ];
    }
    return [
      {
        id: 'delete',
        label:
          selected.length > 1
            ? tr('tl.beatTapDeleteSelected', { n: selected.length })
            : tr('tl.beatTapDelete'),
        icon: 'trash',
        danger: true,
        testid: 'beat-tap-menu-delete',
        onselect: deleteSelected,
      },
    ];
  });

  /* --------------------------------------------------------------- 标尺 */

  function scrubDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // 录制中左键是打点（交给 modal 的 body 处理器），不是定位播放头。
    if (recording) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const moveTo = (ev: PointerEvent): void => appState.seek(timeAtX(ev.clientX, el));
    moveTo(e);
    const mv = (ev: PointerEvent): void => moveTo(ev);
    const up = (): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /* ------------------------------------------------------------- 键盘 / 关闭 */

  function onKey(e: KeyboardEvent): void {
    // 菜单开着时方向 / Enter / Esc 归菜单（它是 capture 监听，见 Menu.svelte）。
    if (ctx) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    if (e.code === 'Space') {
      // 录制中空格 = 打点；否则 = 播放 / 暂停。**永远不冒泡**（modal 期间
      // 主界面的空格会切播放，见 appState.modalDepth 的注释）。
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (recording) tapNow();
      else togglePlay();
      return;
    }
    // 按住的自动重复不当作多次意图（R 会来回开关录制）。
    if (e.repeat) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (recording || !selected.length) return;
      e.preventDefault();
      deleteSelected();
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !recording && selected.length) {
      e.preventDefault();
      nudgeSelected(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey ? 10 : 1);
      return;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      toggleRecording();
    }
  }

  /** 录制中在弹窗任意空白处按下左键 = 打点（避开按钮 / 输入框 / 滚动条）。 */
  function onBodyDown(e: PointerEvent): void {
    if (e.button !== 0 || !recording) return;
    if (e.target === scrollEl) return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea, [data-no-tap]')) return;
    e.preventDefault();
    tapNow();
  }

  function close(): void {
    if (recording) finishRecording();
    if (appState.playing) appState.pause();
    ctx = null;
    onclose();
  }

  $effect(() => {
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

{#snippet footer()}
  {#if visible.length === 0}
    <span class="bt-hint">{tr('tl.beatTapEmpty')}</span>
  {/if}
  <span class="bt-actions">
    <IconButton
      icon="trash"
      label={tr('tl.beatTapDelete')}
      size="sm"
      disabled={recording || selected.length === 0}
      testid="beat-tap-delete"
      onclick={deleteSelected}
    />
    <Button label={tr('tl.beatTapDone')} testid="beat-tap-done" onclick={close} />
  </span>
{/snippet}

<Modal title={tr('tl.beatTapTitle')} width="wide" testid="beat-tap-modal" onclose={close} footer={footer}>
  <div class="bt" role="presentation" onpointerdown={onBodyDown}>
    <div class="bt-bar">
      <IconButton
        icon={appState.playing ? 'pause' : 'play'}
        label={appState.playing ? tr('tl.beatTapPauseTip') : tr('tl.beatTapPlayTip')}
        size="lg"
        testid="beat-tap-play"
        onclick={togglePlay}
      />
      <Button
        label={recording ? tr('tl.beatTapStop') : tr('tl.beatTapRecord')}
        icon="circle"
        variant={recording ? 'danger' : 'outline'}
        testid="beat-tap-record"
        tipText={tr('tl.beatTapRecordTip')}
        onclick={toggleRecording}
      />
      <span class="bt-time" data-testid="beat-tap-time">
        {fmt(appState.playT)}<em>{barBeat}</em>
      </span>
      {#if selected.length === 1 && !recording}
        <span class="bt-sel" data-testid="beat-tap-selected">{fmt(selected[0]!)}</span>
      {:else if selected.length > 1 && !recording}
        <span class="bt-sel" data-testid="beat-tap-selected">
          {tr('tl.beatTapSelectedMany', { n: selected.length })}
        </span>
      {/if}
      <span class="bt-count" data-testid="beat-tap-count">
        {tr('tl.beatTapCount', { n: visible.length })}
      </span>
      <span class="bt-zoom">
        <IconButton
          icon="minus"
          label={tr('tl.beatTapZoomOut')}
          size="sm"
          disabled={!zoom || zoom <= (fitZoom || 1) + 1e-6}
          testid="beat-tap-zoom-out"
          onclick={() => setZoom(zoom / 1.4)}
        />
        <span class="bt-zoom-x" data-testid="beat-tap-zoom">×{zoomMultiple.toFixed(1)}</span>
        <IconButton
          icon="plus"
          label={tr('tl.beatTapZoomIn')}
          size="sm"
          disabled={!zoom || zoom >= 400}
          testid="beat-tap-zoom-in"
          onclick={() => setZoom(zoom * 1.4)}
        />
        <IconButton
          icon="maximize"
          label={tr('tl.beatTapFit')}
          size="sm"
          disabled={!fitZoom || zoomMultiple <= 1.01}
          testid="beat-tap-fit"
          onclick={() => setZoom(fitZoom)}
        />
      </span>
    </div>

    <div
      class="bt-scroll"
      bind:this={scrollEl}
      bind:clientWidth={viewW}
      data-testid="beat-tap-scroll"
      onscroll={(e) => (scrollLeft = (e.currentTarget as HTMLElement).scrollLeft)}
    >
      <div class="bt-content" style:width={`${contentW}px`}>
        <!-- 标尺：定位播放头（录制中左键是打点，标尺也一样）。 -->
        <div
          class="bt-ruler"
          data-testid="beat-tap-ruler"
          title={tr('tl.beatTapRulerTip')}
          role="presentation"
          onpointerdown={scrubDown}
        >
          {#each ticks as t (t)}
            <span class="bt-tick" style:left={`${xOf(t)}px`}>
              <em>{fmtTick(t)}</em>
            </span>
          {/each}
          {#each shownMarks as m (m)}
            <span class="bt-ruler-mark" style:left={`${xOf(m)}px`} aria-hidden="true"></span>
          {/each}
          <div class="bt-playhead" style:left={`${xOf(appState.playT)}px`}></div>
        </div>

        <!-- 打点 / 编辑的主区域。 -->
        <div
          class="bt-lane"
          data-testid="beat-tap-lane"
          title={tr('tl.beatTapLaneTip')}
          role="presentation"
          bind:this={laneEl}
          onpointerdown={laneDown}
          oncontextmenu={laneContext}
        >
          <div class="bt-audio" aria-label={tr('tl.beatTapAudioLane')}>
            {#each audioClips as c (c.id)}
              <span
                class="bt-clip"
                title={c.label}
                style:left={`${xOf(c.start)}px`}
                style:width={`${Math.max(2, (c.end - c.start) * (zoom || 1))}px`}
              ></span>
            {/each}
          </div>
          {#if marquee}
            <span
              class="bt-marquee"
              style:left={`${xOf(Math.min(marquee.from, marquee.to))}px`}
              style:width={`${Math.abs(marquee.to - marquee.from) * (zoom || 1)}px`}
            ></span>
          {/if}
          {#each shownMarks as m (m)}
            <span
              class="bt-mark"
              class:on={isSelected(m)}
              data-testid="beat-tap-mark"
              role="presentation"
              style:left={`${xOf(m)}px`}
              onpointerdown={(e) => {
                if (e.button !== 0 || recording) return;
                if (e.shiftKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleSelected(m);
                  return;
                }
                if (!isSelected(m)) selected = [m];
                startMarkDrag(e, m);
              }}
            ></span>
          {/each}
          <div class="bt-playhead" style:left={`${xOf(appState.playT)}px`}></div>
        </div>
      </div>
    </div>

    <!--
      右键菜单必须渲染在 `<dialog>` **里面**：Modal 是 showModal() 的原生 dialog，
      外面的节点全在 inert 背景里（看得见、点不到）。这是「菜单在快照里存在但
      点击超时」的唯一原因。
    -->
    {#if ctx}
      <Menu
        items={ctxItems}
        at={{ x: ctx.x, y: ctx.y }}
        testid="beat-tap-menu"
        onclose={() => (ctx = null)}
      />
    {/if}
  </div>
</Modal>

<style>
  .bt {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .bt-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .bt-time {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-3);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .bt-time em {
    font-style: normal;
    color: var(--accent);
  }
  .bt-sel {
    margin-left: auto;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .bt-count {
    margin-left: auto;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  /* 同时出现时只有第一个吃 auto margin，其余贴着它。 */
  .bt-sel + .bt-count {
    margin-left: 0;
  }
  .bt-zoom {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: var(--sp-3);
  }
  .bt-zoom-x {
    min-width: 34px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  /*
   * 横向滚动容器。标尺与轨道在同一个内容层里一起滚 —— 分开滚的话
   * 「标尺上的时间」与「轨道上的点」会在任何一次滚动后错位。
   */
  .bt-scroll {
    position: relative;
    overflow-x: auto;
    overflow-y: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overscroll-behavior-x: contain;
  }
  .bt-content {
    position: relative;
    min-width: 100%;
  }
  /* 标尺：点击 / 拖动 = 定位；刻度是 DOM，跟着缩放重算。 */
  .bt-ruler {
    position: relative;
    height: 24px;
    border-bottom: 1px solid var(--border);
    cursor: ew-resize;
    user-select: none;
    /* 末尾刻度的文字会伸出内容宽度 → 给滚动容器多出 20px 的假滚动。 */
    overflow: hidden;
  }
  .bt-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
    pointer-events: none;
  }
  .bt-tick em {
    position: absolute;
    bottom: 1px;
    left: 3px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 9px;
    font-style: normal;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bt-ruler-mark {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1px dashed var(--accent);
    opacity: 0.55;
    pointer-events: none;
  }
  .bt-lane {
    position: relative;
    height: 120px;
    cursor: crosshair;
    touch-action: none;
    user-select: none;
    overflow: hidden;
  }
  /* 音乐块只是背景参照：打点落在哪比歌播到哪重要。 */
  .bt-audio {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .bt-clip {
    position: absolute;
    top: 8px;
    bottom: 8px;
    background: var(--clip-audio-bg);
    border-left: 1px solid var(--clip-audio-border);
    border-radius: 2px;
  }
  /*
   * 节奏点：8px 的透明抓手包着一条 1px 线，顶部方块是「这里能拖」的提示。
   * 只画 1px 线的话用户会以为它不可点。
   */
  .bt-mark {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    margin-left: -4px;
    cursor: grab;
  }
  .bt-mark::after {
    content: '';
    position: absolute;
    left: 3.5px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--accent);
    opacity: 0.7;
  }
  .bt-mark::before {
    content: '';
    position: absolute;
    left: 0.5px;
    top: 0;
    width: 7px;
    height: 7px;
    background: var(--accent);
  }
  .bt-mark:hover::after,
  .bt-mark.on::after {
    opacity: 1;
  }
  .bt-mark.on::before {
    width: 9px;
    height: 9px;
    left: -0.5px;
    outline: 1px solid var(--accent-on);
  }
  .bt-mark:active {
    cursor: grabbing;
  }
  .bt-marquee {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--accent);
    border-right: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    pointer-events: none;
  }
  .bt-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--accent);
    pointer-events: none;
  }
  .bt-hint {
    margin-right: auto;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .bt-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-3);
  }
</style>
