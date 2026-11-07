/**
 * drag.ts — 片段拖拽 / 边缘缩放手势。
 *
 * 手势 = 一个撤销事务：pointerdown 时 beginTx，pointermove 直接改
 * （coalesce），pointerup 时结算策略再 endTx 落成一条撤销记录。
 *
 * 【两段式：实时预览 ≠ 策略结算】2026-09-27 用户反馈后重做。
 *   - pointermove：只做「自由移动」——被拖片段跟着鼠标走，允许与邻居视觉重叠，
 *     跨轨拖拽也在这里实时生效。策略一律不动。
 *   - pointerup：调 store.settlePlacement / settleResize 结算一次：
 *       reject  落点非法 → 整次手势作废（cancelTx 回起点），拖动期间红框预告
 *       push    挤开邻居
 *       trim    吃掉邻居
 *   这样 trim 不再「拖过去就吃掉」，push 不再「拖过去就把整轨推走」。
 *   例外是 resize + reject：单边钳制、非破坏性，仍然实时生效。
 *
 * 【监听器挂在 window 上，不用 setPointerCapture】
 * 跨轨拖拽会让片段在两个 `{#each}` 块之间搬家，DOM 元素被重建、指针捕获随之失效。
 * 挂在 window 上就不依赖元素存活。
 *
 * 【组拖拽 = 同一份逻辑跑在 N 个成员上】
 * 框选出来的多个片段一起走（`peers`）。实现上**刻意不写第二条路径**：
 * 「组」= `ids` 有多个成员，「单片段」= `ids` 只有一个，走的是同一段循环。
 * 三条不变量让这件事成立：
 *   1. 位移 `dt` 由**指针**算，与成员无关 ⇒ 相对位置天然保持（不需要逐成员校正）；
 *   2. 换轨是**整组平移 d 格**（`legalDelta`），不是逐成员各找各的轨道；
 *   3. `canHost` 是唯一的兼容判据 —— 于是「组里有音频就不能上下跨轨」是它的
 *      推论（音频片段平移后会落到视觉轨上），不必再写一条「组里有没有音频」。
 * 缩放**不做组版本**（`peers` 传进来也会被忽略）：一组片段的「那条边」没有唯一定义。
 */

import { beatDur, type BeatGrid, type SnapMode } from '../core/time';
import { snapTimeWithSections } from '../core/sections';
import type { ProjectStore } from '../core/project-store';
import type { AnyClip, Section, Track } from '../core/schema';
import { tr } from '../i18n/index.svelte';
import { statusHint } from '../ui/status-hint.svelte';
import { dragHint, ILLEGAL_DROP_HINT } from '../ui/hints';
import { beginTrim, endTrim } from './live-trim.svelte';

/**
 * `fade-in` / `fade-out` 是音频片段两端的三角手柄：拖的是**淡变时长**（秒），
 * 不是片段几何 —— 所以它们不进 `settlePlacement` / `settleResize`，松手直接
 * `endTx`（一笔撤销），也没有重叠策略可言。
 */
export type DragMode = 'move' | 'resize-l' | 'resize-r' | 'fade-in' | 'fade-out';

/**
 * 与被按下的片段一起走的**其它**成员（框选出来的组）。
 *
 * 只需要这三样：id（改它）、原轨道（跨轨按「平移几格」算）、原起点（位移基准
 * 与「谁的形状」无关，组内所有成员共享同一个 `dt`，所以相对位置天然保持）。
 */
export interface DragPeer {
  clipId: string;
  trackId: string;
  start: number;
}

export interface DragOptions {
  track: Track;
  clip: AnyClip;
  mode: DragMode;
  pxPerBeat: number;
  snapMode: SnapMode;
  /**
   * 一起移动的其它片段。空（默认）= 只移动被按下的那一个。
   *
   * **只在 `move` 上生效**：缩放是「这条边的位置」，把它套用到一组片段上
   * 没有唯一定义（每组一条边？还是各自？），所以不做。
   */
  peers?: readonly DragPeer[];
  /**
   * 屏幕坐标 → 轨道 id。默认按 DOM 上的 data-track-id 找（Timeline 的行与
   * 侧栏行都带这个属性）；返回 null 表示鼠标不在任何轨道上（保持当前轨）。
   */
  trackIdAt?: (clientX: number, clientY: number) => string | null;
  /** 当前落点是否「不可落」——用于给被拖片段加提示样式。 */
  onHint?: (illegal: boolean) => void;
  /**
   * 按下但**没拖动**（一次真正的单击）时回调。
   *
   * 存在的理由与 `typography/gestures.ts` 里同名回调完全一样：按下已选中的
   * 片段时必须**先保持整个选中集**（否则整组拖动无从谈起），可是一次单击的
   * 语义又是「只选它一个」。这两件事只能靠「松手时有没有移动过」来分，
   * 而那个判断在拖拽层里才有。
   */
  onClick?: () => void;
}

/**
 * 指针位移超过这个距离（px）才算「拖动」，以内算「单击」。
 *
 * 与框选（marquee.ts）同一档：两处不一样的话，「点一下」与「拖一点」之间会出现
 * 一段行为不一致的狭窄地带 —— 用户按下去轻轻动一下就会得到完全不同的结果。
 */
const DRAG_SLOP_PX = 4;

/** 默认的坐标 → 轨道映射：靠行元素上的 data-track-id，不依赖硬编码行高。 */
function trackIdAtPoint(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest('[data-track-id]')?.getAttribute('data-track-id') ?? null;
}

export function startClipDrag(e: PointerEvent, store: ProjectStore, opts: DragOptions): void {
  e.preventDefault();
  e.stopPropagation();

  const { clip, mode, pxPerBeat } = opts;
  const trackIdAt = opts.trackIdAt ?? trackIdAtPoint;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  /** 指针真的动过没有（区分「拖动」与「单击」，见 DragOptions.onClick）。 */
  let moved = false;
  /** 被按下那一个的原始几何（组的锚点，也是缩放的唯一对象）。 */
  const origStart = clip.start;
  const origEnd = clip.end;
  const gridAtStart = store.project.beatGrid;
  /**
   * 淡变手柄的**手势起点值**。
   *
   * 必须在 pointerdown 时快照一次：`clip` 是原地改的对象，若在 `onMove` 里读
   * `clip.fadeIn + dt`，每一帧的增量会叠到上一帧写进去的值上 —— 拖 56px 会得到
   * 0.125+0.25+…+1 = 4.5 秒（实测踩过），而且松手前完全看不出规律。
   */
  const origFadeIn = clip.kind === 'audio' ? (clip.fadeIn ?? 0) : 0;
  const origFadeOut = clip.kind === 'audio' ? (clip.fadeOut ?? 0) : 0;

  /**
   * 整组的成员 id（含被按下的那个）与各自的原始位置。
   *
   * `resize` 时 `peers` 一律为空（见 DragOptions.peers）—— 于是下面这些组逻辑
   * 对缩放是恒等的：`ids` 只有自己、`curD` 恒 0。
   */
  const peers = mode === 'move' ? (opts.peers ?? []) : [];
  const group = peers.length > 0;
  const ids = [clip.id, ...peers.map((p) => p.clipId)];
  const origIdx = new Map<string, number>();
  const origStarts = new Map<string, number>();
  for (const p of peers) {
    origIdx.set(p.clipId, store.trackIndex(p.trackId));
    origStarts.set(p.clipId, p.start);
  }
  origIdx.set(clip.id, store.trackIndex(opts.track.id));
  origStarts.set(clip.id, origStart);
  const anchorIdx = origIdx.get(clip.id) ?? 0;

  /**
   * 「整组平移 d 格」是否合法：每个成员平移后都必须落在**装得下它**的轨道上。
   *
   * 这条判据顺带就是「框选里含音频就不许上下跨轨」：音频片段只能进音频轨、
   * 视觉片段只能进视觉轨，混合组平移一格之后必然有成员落错类别的轨 —— 于是
   * `legalDelta` 回退到 0，整组只做水平移动。刻意**不**再单独判一次「组里有没有
   * 音频」：那是同一件事的第二份真源，两处迟早会不一致。
   */
  const deltaOk = (d: number): boolean =>
    d === 0 ||
    ids.every((id) => {
      const t = store.project.tracks[(origIdx.get(id) ?? 0) + d];
      const c = store.findClip(id)?.clip;
      return !!t && !!c && store.canHost(t, c);
    });

  /** 向 0 收敛到最近的合法格数：目的轨放不下时不要整组卡死，退到放得下的那一档。 */
  const legalDelta = (want: number): number => {
    let d = want;
    while (d !== 0 && !deltaOk(d)) d += d > 0 ? -1 : 1;
    return d;
  };

  /** 当前平移格数。鼠标离开轨道区时沿用上一帧的值（= 单片段时代的「保持当前轨」）。 */
  let curD = 0;

  /** 只有 `resize` 还在用它（缩放不换轨）；`move` 一律从工程里查片段的实际轨道。 */
  const curTrackId = opts.track.id;

  /*
   * 底栏提示（手势层）：手没松开时，底栏说的是「松开会发生什么」。
   *
   * 只在**真的动过之后**才出现 —— 按一下就松开的一次单击不该闪过一条「松开放置」。
   * 落点被拒收时换成「为什么不能放」（见 `ILLEGAL_DROP_HINT`）。
   */
  /** 淡变手柄没有「落点被拒」这回事，也就不需要手势提示（见文件头的 DragMode 注释）。 */
  const fadeMode = mode === 'fade-in' || mode === 'fade-out';
  const gestureHint = fadeMode ? null : dragHint(mode === 'move');
  const setIllegal = (illegal: boolean): void => {
    opts.onHint?.(illegal);
    if (moved && gestureHint) statusHint.setGesture(illegal ? ILLEGAL_DROP_HINT : gestureHint);
  };

  store.beginTx();
  setIllegal(false);

  /** 水平位移换算成秒；pxPerBeat 是按下那一刻的缩放（拖动中不缩放）。 */
  const dtSec = (clientX: number): number =>
    (clientX - startX) / (pxPerBeat / beatDur(gridAtStart));

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_SLOP_PX) {
      moved = true;
      if (gestureHint) statusHint.setGesture(gestureHint);
    }
    const p = store.project;
    const g: BeatGrid = p.beatGrid;

    if (fadeMode) {
      // 淡变**不吸附**：用户拖的是「多长的一段渐入」，秒级自由取值；
      // 它与拍网格没有关系（包络是连续的），吸到拍只会让手感变钝。
      const dur = Math.max(0, clip.end - clip.start);
      const dt = dtSec(ev.clientX);
      // 左端往右 = 淡入变长；右端往左 = 淡出变长（手柄跟着边界走）。
      const next = mode === 'fade-in' ? origFadeIn + dt : origFadeOut - dt;
      store.liveSetFade(clip.id, mode === 'fade-in' ? 'in' : 'out', Math.min(Math.max(0, next), dur));
      return;
    }

    if (mode === 'move') {
      const dt = dtSec(ev.clientX);
      /*
       * 换轨是**整组一起平移**：鼠标下的轨道只决定「平移几格」（锚点跟着它走），
       * 其余成员按同一格数搬 —— 组的相对结构在任何一帧都不被破坏。
       */
      const over = trackIdAt(ev.clientX, ev.clientY);
      const overIdx = over ? store.trackIndex(over) : -1;
      if (overIdx >= 0) curD = legalDelta(overIdx - anchorIdx);

      // 每个成员共享同一个 `dt`（这是「相对位置不变」的全部实现）。
      const cands = ids.map((id) => ({
        id,
        target: p.tracks[(origIdx.get(id) ?? 0) + curD],
        // 段落边界与手动节奏点也是吸附点（`core/sections.ts`）：与网格线比谁更近。
        start: Math.max(
          0,
          snapTimeWithSections(
            (origStarts.get(id) ?? 0) + dt,
            opts.snapMode,
            g,
            p.sections,
            p.fps,
            p.beatMarks,
          ),
        ),
      }));
      for (const c of cands) {
        if (c.target) store.liveMoveClip(c.target.id, c.id, c.start);
      }
      // 探针用鼠标下的轨道（可能是装不下的轨道）；整组**全部**能落才算合法。
      setIllegal(
        cands.some((c) => !c.target || !store.placementAccepted(c.target.id, c.id, c.start)),
      );
      store.touch();
      return;
    }

    const edge = mode === 'resize-l' ? 'start' : 'end';
    /*
     * 裁剪态：标签在拖动中以**手势起点的内容原点**定位，于是左边界右移时名字
     * 被左边界裁掉（而不是整块跟着片段平移 —— 后者看起来和移动片段一模一样）。
     */
    beginTrim(clip.id, edge, origStart);
    const raw = edge === 'start' ? origStart + dtSec(ev.clientX) : origEnd + dtSec(ev.clientX);
    const cand = snapTimeWithSections(raw, opts.snapMode, g, p.sections, p.fps, p.beatMarks);
    // 缩放不换轨；reject 实时钳制（非破坏性），其余策略先自由移动、松手才结算
    if (p.overlapBehavior === 'reject') store.settleResize(curTrackId, clip.id, edge, cand);
    else store.liveResizeClip(curTrackId, clip.id, edge, cand);
    store.touch();
  };

  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey);
    /*
     * 松手后标签回到新边界（用户要的「重新计算并渲染 display name 的位置」）。
     * 这一步同时是「边框恢复常态」的开关 —— 忘了清会让片段永远停在裁剪态。
     */
    endTrim();
    opts.onHint?.(false);
    // 手势提示必须跟着手势一起结束（忘了清 = 底栏永远停在「松开放置」上）。
    statusHint.clearGesture();
  };

  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (fadeMode) {
      // 没拖动就是一次误触（三角手柄只有 8px）：整次作废，不留一条空撤销。
      if (!moved) {
        store.cancelTx();
        return;
      }
      store.touch();
      store.endTx(tr(mode === 'fade-in' ? 'tl.setFadeIn' : 'tl.setFadeOut'));
      return;
    }
    if (mode === 'move' && !moved) {
      /*
       * 按下但没拖 = 一次单击：整次手势作废，把「点中的是选中集里的哪一个」
       * 交回调用方去收敛（见 DragOptions.onClick）。
       * 拖拽层刻意不自己改选中态 —— 它只认 peers，「单击 = 单选」是选中集的语义。
       */
      store.cancelTx();
      opts.onClick?.();
      return;
    }
    if (mode === 'move') {
      /*
       * 结算顺序：**从左到右**。push 策略下先落左边的成员，被挤开的邻居不会
       * 反过来盖到还没落的成员身上；而组内成员之间本来就不重叠（整组平移不改变
       * 相对位置），所以这个顺序只影响邻居被推向哪边，不影响组本身。
       *
       * 落点一律**从工程里读**、不重算：实时预览已经把每个成员放到了「0 与工程
       * 时长钳制之后」的位置，重算会引入第二份钳制逻辑（两份迟早不一致）。
       */
      const ordered = ids
        .map((id) => ({ id, at: store.findClip(id)?.clip.start ?? 0 }))
        .sort((a, b) => a.at - b.at);
      for (const m of ordered) {
        const found = store.findClip(m.id);
        if (!found) continue;
        if (!store.settlePlacement(found.track.id, m.id, found.clip.start)) {
          // reject：落点非法就整次不动（AGENTS.md §5 的语义）
          store.cancelTx();
          store.touch();
          return;
        }
      }
    } else {
      const edge = mode === 'resize-l' ? 'start' : 'end';
      const found = store.findClip(clip.id);
      if (found) store.settleResize(curTrackId, clip.id, edge, edge === 'start' ? found.clip.start : found.clip.end);
    }
    // touch 不能省：结算可能把状态改回事务起点（例如 reject 被钳回原位），
    // 此时 endTx 判定「无变化」不会 bump，UI 就会停在被作废的实时预览上。
    store.touch();
    store.endTx(
      mode === 'move'
        ? group
          ? tr('tl.moveClips', { n: ids.length })
          : tr('tl.moveClip')
        : tr('tl.resizeClip'),
    );
  };

  const onCancel = (): void => {
    cleanup();
    store.cancelTx();
    store.touch();
  };

  /** Esc 中止本次拖拽（撤销栈里的手势事务本来就是为这个准备的）。 */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    cleanup();
    store.cancelTx();
    store.touch();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey);
}

/* ------------------------------------------------------------ 段落带 */

export interface SectionDragOptions {
  section: Section;
  pxPerBeat: number;
  snapMode: SnapMode;
  /** 单击（没拖动）= 把播放头挪到段落起点。 */
  onClick?: () => void;
}

/**
 * 拖动段落标记 = 改它的起点（一笔撤销）。
 *
 * 与片段拖拽同一套两段式：pointermove 直改（`liveMoveSection` + touch），
 * pointerup 结算成一条撤销。区别只有一条 —— **段落没有重叠约束**，
 * 所以不需要 `settlePlacement`（标记不是轨道，两段叠在一起是合法的：
 * 谁在前谁赢的是排序，不是画法）。
 *
 * 吸附用 `snapTimeWithSections`，但**把自己排除在外**：包含自己的话，
 * 「原来那个位置」永远是最新的候选点，段落会被粘在原地拖不动。
 */
export function startSectionDrag(
  e: PointerEvent,
  store: ProjectStore,
  opts: SectionDragOptions,
): void {
  e.preventDefault();
  e.stopPropagation();
  const { section } = opts;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  const origStart = section.start;
  const gridAtStart = store.project.beatGrid;
  let moved = false;

  const dtSec = (clientX: number): number =>
    (clientX - startX) / (opts.pxPerBeat / beatDur(gridAtStart));

  store.beginTx();

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_SLOP_PX) {
      moved = true;
    }
    if (!moved) return;
    const p = store.project;
    const others = p.sections.filter((s) => s.id !== section.id);
    const raw = origStart + dtSec(ev.clientX);
    store.liveMoveSection(
      section.id,
      Math.max(
        0,
        snapTimeWithSections(
          raw,
          opts.snapMode,
          gridAtStart,
          others,
          store.project.fps,
          store.project.beatMarks,
        ),
      ),
    );
  };

  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey);
  };

  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (!moved) {
      // 单击 = 定位播放头（段落是「这一段的起点」，点它就是跳到那儿）。
      store.cancelTx();
      opts.onClick?.();
      return;
    }
    store.touch();
    store.endTx(tr('tl.moveSection'));
  };

  const onCancel = (): void => {
    cleanup();
    store.cancelTx();
    store.touch();
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    cleanup();
    store.cancelTx();
    store.touch();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey);
}
