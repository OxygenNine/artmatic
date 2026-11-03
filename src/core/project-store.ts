/**
 * project-store.ts — 工程的唯一事实源。
 *
 * 所有对 Project 的修改都必须经过 store.commit / 手势事务，
 * 这样撤销栈才完整、version 计数才可信。version 是渲染与 UI 重绘的
 * 唯一订阅源（每次变化 +1）；选中态等 UI 状态不在这里——
 * splitter 的教训：select 触发全量重建会在拖拽中换掉 DOM。
 */

import {
  cloneProject,
  newId,
  type AnyClip,
  type AssetTrimRange,
  type AudioClip,
  type EffectClip,
  type OverlapBehavior,
  type Project,
  type Section,
  type SourceClip,
  type Track,
  type TransitionRef,
  type VisualTrack,
} from './schema';
import { nextSectionName, sortSections } from './sections';
import { MASK_INPUT_KEY, maskRefCreatesCycle, maskRefOf, maskRefTarget, type MaskRef } from './mask';
import {
  MIN_CLIP_LENGTH,
  applyTrimIn,
  earliestTrimStart,
  freeRangeAt,
  placeSpan,
  replaceSpan,
  resizeSpan,
  setTrimIn,
  sortSpans,
  spanAt,
  splitSpan,
  trimInOf,
  withTrimIn,
  type Span,
} from './clips';
import { clampTransitionDuration, transitionMaxDuration, type TransitionSide } from './transitions';
import { rippleShift } from './ripple';
import { evalCurve, type Curve } from './curve';
import { SPEED_CURVE_KEY, speedIntegralOf } from './speed';
import type { BeatGrid } from './time';
import { CommandStack } from './commands';
import { tr } from '../i18n/index.svelte';

/**
 * 切分段落时两侧各留的最小长度（秒）。
 *
 * 不是为了「听感」而是为了**点得中**：12px 的段落带上，再短的段就是一条
 * 抓不住的缝，双击改名、右键都落在邻居身上。0.02s 在 56px/s 下约 1px，
 * 已经小到看不出来，但足以让「切在端点」被判定成无效而不是切出一条 0 长的段。
 */
const MIN_SECTION_GAP = 0.02;

/** 淡变写入的钳制：`fadeIn + fadeOut ≤ 片段长度`，负数与非数字归 0。手柄与检查器共用。 */
function clampFade(clip: AudioClip, which: 'in' | 'out', seconds: number): number {
  const dur = Math.max(0, clip.end - clip.start);
  const other = which === 'in' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
  const room = Math.max(0, dur - Math.min(other, dur));
  return Math.min(Math.max(0, Number.isFinite(seconds) ? seconds : 0), room);
}

/**
 * 写入淡变，返回「是否真的变了」。
 *
 * 值归 0 时**删掉字段**而不是写 0：`undefined` 与 `0` 语义相同，但 JSON 快照
 * 不同 —— 否则拖回 0 会在撤销栈里留下一条「什么都没变」的记录。
 */
function writeFade(clip: AudioClip, which: 'in' | 'out', v: number): boolean {
  const key = which === 'in' ? 'fadeIn' : 'fadeOut';
  if ((clip[key] ?? 0) === v) return false;
  if (v === 0) delete clip[key];
  else clip[key] = v;
  return true;
}

/** 删除选项。`ripple` = 波纹删除（后面的片段前移补位），默认关。 */
export interface RemoveOptions {
  ripple?: boolean;
}

/** 被删掉的一段空白：哪条轨、起止多少秒。 */
interface RippleGap {
  trackId: string;
  start: number;
  end: number;
}

/**
 * 把被删片段留下的空洞合上：**只动被删片段所在的那几条轨**，且只扣掉被删的
 * 那几段长度（用户原本留的空隙保持原样）。
 *
 * 片段长度严格不变（`end - start` 原样带过去）：波纹删除搬的是位置，
 * 不是裁掉内容。
 */
function closeRippleGaps(p: Project, gaps: readonly RippleGap[]): void {
  if (!gaps.length) return;
  const byTrack = new Map<string, RippleGap[]>();
  for (const g of gaps) {
    const list = byTrack.get(g.trackId);
    if (list) list.push(g);
    else byTrack.set(g.trackId, [g]);
  }
  for (const t of p.tracks) {
    const removals = byTrack.get(t.id);
    if (!removals?.length) continue;
    for (const c of t.clips) {
      const shift = rippleShift(c.start, removals);
      if (!(shift > 0)) continue;
      const len = c.end - c.start;
      c.start = Math.max(0, c.start - shift);
      c.end = c.start + len;
    }
  }
}

export class ProjectStore {
  project: Project;
  version = 0;

  private stack: CommandStack;
  private listeners = new Set<() => void>();

  constructor(project: Project) {
    this.project = project;
    /*
     * 快照 = 整工程 JSON，**没有例外字段**。
     *
     * 曾经这里要剔除 `agentSessions`（聊天记录不该进撤销栈）。历史搬去
     * `agent/sessions/` 之后这条特例消失了 —— 工程之外的日志一开始就不该
     * 出现在工程的快照里。**别把「跟工程一起保存」误读成「属于工程」**。
     */
    this.stack = new CommandStack(
      () => JSON.stringify(this.project),
      (json) => {
        this.project = JSON.parse(json) as Project;
      },
      () => this.bump(),
    );
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /* ------------------------------------------------------------ 原语 */

  commit(label: string, fn: (p: Project) => void): boolean {
    return this.stack.commit(label, () => fn(this.project));
  }

  beginTx(): void {
    this.stack.beginTx();
  }

  /**
   * 当前是否有手势 / 会话事务开着。
   *
   * 给「一次调用要写两笔」的调用方（控制平面的 `set_clip_props`：淡变走
   * `setFades`、其余字段走 `updateClip`）判断**要不要自己包一层** ——
   * `beginTx` 会直接覆盖上一个快照，嵌套调用会把外层事务的起点抹掉。
   */
  get inTx(): boolean {
    return this.stack.inTx;
  }

  /**
   * 手势事务内的实时变更通知：version++ 但不产生撤销记录。
   * 拖拽中每帧调用，让 UI 跟上鼠标的实时位置。
   */
  touch(): void {
    this.bump();
  }

  endTx(label: string): boolean {
    return this.stack.endTx(label);
  }

  /** 手势中止：回滚到事务起点。 */
  cancelTx(): void {
    this.stack.cancelTx();
    this.bump();
  }

  undo(): boolean {
    return this.stack.undo();
  }

  redo(): boolean {
    return this.stack.redo();
  }

  canUndo(): boolean {
    return this.stack.canUndo();
  }

  canRedo(): boolean {
    return this.stack.canRedo();
  }

  /* ------------------------------------------------------------ 查询 */

  track(id: string): Track | null {
    return this.project.tracks.find((t) => t.id === id) ?? null;
  }

  /**
   * 该轨道能不能装这个片段：音频片段只进音频轨，画面/特效片段只进视觉轨。
   * 跨轨拖拽与 Alt+↑↓ 共用这一条判据。
   */
  canHost(track: Track, clip: AnyClip): boolean {
    return track.kind === 'audio' ? clip.kind === 'audio' : clip.kind !== 'audio';
  }

  /** 轨道在工程里的下标（跨轨拖动判方向用）。 */
  trackIndex(id: string): number {
    return this.project.tracks.findIndex((t) => t.id === id);
  }

  findClip(clipId: string): { track: Track; clip: AnyClip } | null {
    for (const track of this.project.tracks) {
      const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  /* ------------------------------------------------------------ 轨道 */

  addTrack(kind: Track['kind'], name?: string): string {
    const id = newId();
    const kindLabel = kind === 'visual' ? tr('tl.trackKindVisual') : tr('tl.trackKindAudio');
    this.commit(tr('tl.newTrack', { kind: kindLabel }), (p) => {
      const n = p.tracks.filter((t) => t.kind === kind).length + 1;
      if (kind === 'visual') {
        p.tracks.push({ kind, id, name: name ?? `V${n}`, enabled: true, clips: [] } as VisualTrack);
      } else {
        p.tracks.push({ kind, id, name: name ?? `A${n}`, enabled: true, clips: [], bus: 'master' });
      }
    });
    return id;
  }

  removeTrack(id: string): void {
    this.commit(tr('tl.removeTrack'), (p) => {
      const gone = new Set<string>();
      for (const t of p.tracks) {
        if (t.id === id) for (const c of t.clips) gone.add(c.id);
      }
      p.tracks = p.tracks.filter((t) => t.id !== id);
      // 删轨 = 删它上面所有片段：指向它们的蒙版引用要一起回落（见 removeClipIds）。
      this.clearMaskRefs(p, gone);
    });
  }

  /**
   * 把第 from 条轨道挪到第 to 位（拖曳排序）。
   *
   * 轨道顺序是**有语义**的：`buildStack` 里 `tracks[0]` 是最前景，
   * 时间轴也从第 0 条往下画。所以这不是纯展示排序，而是一次真的画面改动 ——
   * 因此走 `commit`（一笔撤销），不走 touch。
   */
  moveTrack(from: number, to: number): void {
    const n = this.project.tracks.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    this.commit(tr('tl.moveTrack'), (p) => {
      const [moved] = p.tracks.splice(from, 1);
      if (moved) p.tracks.splice(to, 0, moved);
    });
  }

  /* ------------------------------------------------------- 轨道属性写入
   *
   * 这三个方法存在的原因是一个真 bug：轨道行的开关原来在组件里写
   * `track.enabled = …`，而那个 `track` 是 `$derived` 里 `.map(t => ({...t}))`
   * 出来的**浅拷贝**。commit 对比真实 project 的快照判定「无变化」，
   * 于是既不 bump version 也不入撤销栈——开关看着能点，其实从未落库。
   * 写库必须改 `commit(p => …)` 里的真实对象，这是唯一的正道。
   */

  setTrackEnabled(id: string, enabled: boolean): void {
    this.commit(enabled ? tr('tl.enableTrack') : tr('tl.disableTrack'), (p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) t.enabled = enabled;
    });
  }

  toggleTrackEnabled(id: string): void {
    const t = this.track(id);
    if (t) this.setTrackEnabled(id, !t.enabled);
  }

  /**
   * 轨道静音（v15，仅视觉轨）：只关视频片段的内嵌音轨，画面照常。
   *
   * 音频轨不接这一路 —— 它的 `enabled` 本来就是「这条轨出不出声」，再叠一个
   * muted 会出现两个开关描述同一件事（而导出只看其中一个）。
   */
  setTrackMuted(id: string, muted: boolean): void {
    this.commit(muted ? tr('tl.muteTrack') : tr('tl.unmuteTrack'), (p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (!t || t.kind !== 'visual') return;
      if (muted) t.muted = true;
      else delete t.muted;
    });
  }

  toggleTrackMuted(id: string): void {
    const t = this.track(id);
    if (t && t.kind === 'visual') this.setTrackMuted(id, !t.muted);
  }

  /** 改名。空名字不写库（否则轨道会变成一个点不到的空行）。 */
  renameTrack(id: string, name: string): void {
    const next = name.trim();
    if (!next) return;
    this.commit(tr('tl.renameTrack'), (p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) t.name = next;
    });
  }

  /* ------------------------------------------------------------ 片段 */

  addClip(trackId: string, clip: AnyClip): void {
    this.commit(tr('tl.addClip'), (p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) this.placeInto(track, clip, p);
    });
  }

  /**
   * 把一段片段落进某条轨。**落点几何的唯一实现** —— `addClip` 与
   * `pasteClips` 共用：两处各写一份的形态是「从池里插会压邻居、粘贴却不会」。
   *
   * 规则：落点被占时先尝试裁进所在空档；起点本身压在片段上时顺延到它的
   * 末尾再找空档（否则「新建」在占用区静默失败，用户会以为按钮坏了）。
   * 上界传 Infinity：工程时长不是片段的天花板，新片段超出当前时长就把工程撑长。
   * 返回 false = 放不下（调用方静默跳过或说明）。
   */
  private placeInto(track: Track, clip: AnyClip, p: Project): boolean {
    let start = clip.start;
    let free = freeRangeAt(track.clips as Span[], start, Number.POSITIVE_INFINITY);
    if (!free) {
      const covering = spanAt(track.clips as Span[], start);
      if (covering) {
        start = covering.end + 1e-6;
        free = freeRangeAt(track.clips, start, Number.POSITIVE_INFINITY);
      }
    }
    if (!free) return false;
    const s = Math.max(start, free.start);
    const e = Math.min(clip.end + (s - clip.start), free.end);
    if (e - s < MIN_CLIP_LENGTH) return false;
    (track.clips as AnyClip[]).push({ ...clip, start: s, end: e });
    track.clips.sort((a, b) => a.start - b.start);
    if (e > p.duration) p.duration = e;
    return true;
  }

  /**
   * 粘贴一批片段（复制 / 剪切 / 跨工程）：**一笔撤销**，不是 N 笔。
   *
   * 逐个 `addClip` 也能粘对，但撤销栈里会多出 N 条记录 —— 用户按一次
   * Ctrl+Z 只回来一个，看起来就是「撤销坏了」（与 `removeClips` 同一理由）。
   * 落点几何走 `placeInto`（与 `addClip` 同一份实现），同轨重叠时后粘的
   * 片段绕着先粘的走。
   *
   * @param items 每个片段的目标轨。clip.id 应由调用方换成**新 id**
   *              （同工程粘贴留下原 id 会让 findClip 找到源片段）。
   */
  pasteClips(items: readonly { trackId: string; clip: AnyClip }[], label: string): number {
    if (!items.length) return 0;
    let placed = 0;
    this.commit(label, (p) => {
      for (const it of items) {
        const track = p.tracks.find((t) => t.id === it.trackId);
        if (!track) continue;
        if (this.placeInto(track, it.clip, p)) placed += 1;
      }
    });
    return placed;
  }

  /**
   * 给片段改名。空名字不写库（与 `renameTrack` 同口径）——
   * 时间轴上的片段靠名字认人，改成一个点不到的空标签等于把它藏起来。
   *
   * 与检查器里那个 `updateClip(…, c => c.label = …)` 是同一件事、同一笔撤销；
   * 这里只是把它变成一个**有名字的入口**（就地改名与 F2 都走它）。
   */
  renameClip(clipId: string, label: string): void {
    const next = label.trim();
    if (!next) return;
    const found = this.findClip(clipId);
    if (!found || found.clip.label === next) return;
    this.commit(tr('tl.renameClip'), (p) => {
      for (const t of p.tracks) {
        for (const c of t.clips) if (c.id === clipId) c.label = next;
      }
    });
  }

  removeClip(clipId: string, opts: RemoveOptions = {}): void {
    this.commit(tr('tl.removeClip'), (p) => {
      // 删视频时把锁定 / 分离出来的音频一起删掉：只留一条无声的音频轨
      // 是「删了画面、声音还在响」，那几乎不会是用户想要的。
      const extra = this.linkedAudioIdIn(p, clipId);
      const ids = new Set(extra ? [clipId, extra] : [clipId]);
      const gaps = opts.ripple ? this.spansOf(p, ids) : [];
      this.removeClipIds(p, ids);
      closeRippleGaps(p, gaps);
    });
  }

  /**
   * 一次删掉多个片段（框选之后的 Delete）：**一笔撤销**，不是 N 笔。
   *
   * 逐个调 `removeClip` 也能删对，但撤销栈里会多出 N 条记录 ——
   * 用户按一次 Ctrl+Z 只回来一个，看起来就是「撤销坏了」。
   *
   * `ripple` = 波纹删除：删完把这些片段所在的每条轨上、排在它们之后的片段
   * 前移补位（规则见 `core/ripple.ts`）。**必须与删除同一笔提交**，
   * 否则撤销一次只回来一半，看起来像「撤销坏了」。
   */
  removeClips(clipIds: readonly string[], opts: RemoveOptions = {}): void {
    if (!clipIds.length) return;
    if (clipIds.length === 1) {
      this.removeClip(clipIds[0]!, opts);
      return;
    }
    const set = new Set(clipIds);
    for (const id of clipIds) {
      const extra = this.linkedAudioIdIn(this.project, id);
      if (extra) set.add(extra);
    }
    this.commit(tr('tl.removeClips', { n: clipIds.length }), (p) => {
      const gaps = opts.ripple ? this.spansOf(p, set) : [];
      this.removeClipIds(p, set);
      closeRippleGaps(p, gaps);
    });
  }

  /** 这些片段此刻占的区间（按轨记账，波纹删除要用）。删之前算，删完就没有了。 */
  private spansOf(p: Project, ids: ReadonlySet<string>): RippleGap[] {
    const out: RippleGap[] = [];
    for (const t of p.tracks) {
      for (const c of t.clips) {
        if (ids.has(c.id)) out.push({ trackId: t.id, start: c.start, end: c.end });
      }
    }
    return out;
  }

  /** 视频片段分离出来的音频 id（没有 / 不是视频 → null）。 */
  private linkedAudioIdIn(p: Project, clipId: string): string | null {
    const c = this.findClipIn(p, clipId)?.clip;
    return c?.kind === 'source' ? (c.linkedAudioId ?? null) : null;
  }

  /** 按 id 集合删除片段，并清掉指向已删片段的所有链接（不留下悬空引用）。 */
  private removeClipIds(p: Project, ids: ReadonlySet<string>): void {
    for (const t of p.tracks) {
      t.clips = t.clips.filter((c) => !ids.has(c.id)) as typeof t.clips;
    }
    this.clearMaskRefs(p, ids);
    for (const t of p.tracks) {
      for (const c of t.clips) {
        if (c.kind === 'source') {
          if (c.linkedAudioId && !this.findClipIn(p, c.linkedAudioId)) delete c.linkedAudioId;
        } else if (c.kind === 'audio') {
          if (c.lockedTo && !this.findClipIn(p, c.lockedTo)) delete c.lockedTo;
          if (c.linkedVideoId && !this.findClipIn(p, c.linkedVideoId)) delete c.linkedVideoId;
        }
      }
    }
  }

  /**
   * 把所有指向 `gone` 的蒙版引用置成 `{ kind: 'none' }`。
   *
   * **不删 `inputs`、也不删 `mask` 键**：`undefined` 与 `none` 在渲染侧等价，
   * 但在撤销栈与检查器里不等价 —— 前者是「这个特效从来没有过蒙版」，后者是
   * 「它有过，被删掉了」。用户重新放回那个片段之后再接一次，看到的是同一张卡片。
   */
  private clearMaskRefs(p: Project, gone: ReadonlySet<string>): void {
    if (gone.size === 0) return;
    for (const t of p.tracks) {
      for (const c of t.clips) {
        if (c.kind !== 'effect') continue;
        for (const inst of c.chain) {
          const target = maskRefTarget(maskRefOf(inst));
          if (target?.kind === 'clip' && gone.has(target.id) && inst.inputs) {
            inst.inputs[MASK_INPUT_KEY] = { kind: 'none' };
          }
        }
      }
    }
  }

  /**
   * 蒙版引用（`EffectInstance.inputs.mask`，v19）。`null` = 摘掉引用。
   *
   * **返回 false = 被拒，工程一个字都没改**。拒的两种情况：目标不是一个画面
   * 片段（特效片段 / 音频 / 已删），以及会成环或超过 8 层（`core/mask.ts`）。
   * 环必须在**写入口**拒：渲染层发现环的时候只有两种结局 —— 白蒙版或者死循环，
   * 而渲染层跑在 rAF 与导出循环里，那里没有地方给用户一句话。
   *
   * 判据用**改之前的工程**算（`maskRefCreatesCycle` 自己把这一笔边加上再判），
   * 所以「A→B 已经存在、现在把 A 改成指向自己」这种一笔就能成环的写法也会被拒。
   */
  setEffectMaskRef(clipId: string, instanceId: string, ref: MaskRef | null): boolean {
    const found = this.findClip(clipId);
    if (!found || found.clip.kind !== 'effect') return false;
    const inst = found.clip.chain.find((i) => i.instanceId === instanceId);
    if (!inst) return false;

    const target = maskRefTarget(ref);
    if (target?.kind === 'clip') {
      const owner = this.findClip(target.id)?.clip;
      if (!owner || owner.kind !== 'source') return false;
      if (maskRefCreatesCycle(this.project, clipId, target.id)) return false;
    }
    this.commit(tr('insp.changeMask'), (p) => {
      for (const t of p.tracks) {
        for (const c of t.clips) {
          if (c.kind !== 'effect' || c.id !== clipId) continue;
          const it = c.chain.find((i) => i.instanceId === instanceId);
          if (!it) return;
          if (ref === null) {
            if (it.inputs) {
              delete it.inputs[MASK_INPUT_KEY];
              if (Object.keys(it.inputs).length === 0) delete it.inputs;
            }
          } else if (it.inputs) {
            it.inputs[MASK_INPUT_KEY] = ref;
          } else {
            it.inputs = { [MASK_INPUT_KEY]: ref };
          }
        }
      }
    });
    return true;
  }

  /* ------------------------------------------------ 手势：实时 vs 结算 */

  /**
   * 拖拽期间的实时移动：**不套用重叠策略**，允许视觉重叠。
   *
   * 为什么分两段（见 core/clips.ts 的时序约定）：trim/push 在 pointermove 里
   * 就生效的话，拖过去的瞬间邻居就被吃掉了，拖回来也恢复不了。
   * 策略统一由 settlePlacement 在松手时结算。
   *
   * 跨轨也走这里：目标轨不兼容（音频片段拖到视觉轨等）时原地不动。
   * 拖出工程末尾会把时长撑长——时长只增不减，缩短走 setDuration。
   */
  liveMoveClip(toTrackId: string, clipId: string, newStart: number): void {
    const found = this.findClip(clipId);
    const target = this.track(toTrackId);
    if (!found || !target || !this.canHost(target, found.clip)) return;
    const len = found.clip.end - found.clip.start;
    const start = Math.max(0, newStart);
    const end = start + len;
    if (end > this.project.duration) this.project.duration = end;
    const moved = { ...found.clip, start, end };
    if (found.track.id === target.id) {
      target.clips = replaceSpan(target.clips as AnyClip[], moved) as typeof target.clips;
      this.syncLockedAudio(this.project, clipId);
      return;
    }
    found.track.clips = (found.track.clips as AnyClip[]).filter((c) => c.id !== clipId) as typeof found.track.clips;
    target.clips = sortSpans([...(target.clips as AnyClip[]), moved]) as typeof target.clips;
    this.syncLockedAudio(this.project, clipId);
  }

  /** 拖拽期间的实时缩放：只在 0 / 末尾 / MIN_CLIP_LENGTH 上钳，不碰邻居。 */
  liveResizeClip(trackId: string, clipId: string, edge: 'start' | 'end', time: number): void {
    const track = this.track(trackId);
    if (!track) return;
    const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
    if (!clip) return;
    if (edge === 'start') {
      /*
       * trim-in：拖左边界改的是**长度 + 源内偏移**，不是整体平移。
       *
       * 下界是 `earliestTrimStart`（= start − srcIn/speed）：素材头部没有更多
       * 内容了，srcIn 不能为负。这条下界正是「裁掉 1 秒之后拖不回来」的正确
       * 含义，同时让裁剪可逆 —— 往右裁多少，往回就能拖多少。
       *
       * 增量式累加（每次 pointermove 挪一点）而不是按基准重算：拖动过程中
       * 会结算很多次，每次只知道自己这一次挪了多少。
       */
      const next = Math.max(earliestTrimStart(clip), Math.min(time, clip.end - MIN_CLIP_LENGTH));
      const delta = next - clip.start;
      if (delta === 0) return;
      const ti = trimInOf(clip);
      if (ti) {
        /*
         * 素材时间的增量是速度的**积分**（`core/speed.ts`）：有速度曲线时
         * `Δ × speed` 会算错 —— 拖回来的内容与裁掉的内容对不上，而且只在
         * 「曲线不是常数」时出现（画面错位，不报错）。
         */
        const moved =
          clip.kind === 'source' && clip.source.type === 'video'
            ? speedIntegralOf(clip, clip.start, next, this.project.beatGrid)
            : delta * ti.speed;
        setTrimIn(clip, ti.srcIn + moved);
      }
      clip.start = next;
      this.syncLockedAudio(this.project, clipId);
      return;
    }
    const end = Math.max(time, clip.start + MIN_CLIP_LENGTH);
    if (end > this.project.duration) this.project.duration = end;
    clip.end = end;
    this.syncLockedAudio(this.project, clipId);
  }

  /**
   * 松手结算：把片段按重叠策略落到 targetTrack 的 newStart。
   * 返回 false 表示落点被策略拒绝（调用方此时应整次手势作废）。
   */
  settlePlacement(targetTrackId: string, clipId: string, newStart: number): boolean {
    const found = this.findClip(clipId);
    const target = this.track(targetTrackId);
    if (!found || !target || !this.canHost(target, found.clip)) return false;
    const len = found.clip.end - found.clip.start;
    const start = Math.max(0, Math.min(newStart, Math.max(0, this.project.duration - len)));
    const cand = { ...found.clip, start, end: start + len };
    // placeSpan 自己会剔掉同 id 的旧几何，所以实时预览造成的重叠不影响结算
    const lane = placeSpan(target.clips as Span[], cand as Span, this.project.duration, this.project.overlapBehavior);
    if (!lane) return false;
    this.writeLane(target, lane as AnyClip[]);
    if (found.track.id !== target.id) {
      found.track.clips = (found.track.clips as AnyClip[]).filter((c) => c.id !== clipId) as typeof found.track.clips;
    }
    // 落点策略可能顺延 / 挤开了片段：以结算后的真实几何为准再拉齐一次。
    this.syncLockedAudio(this.project, clipId);
    return true;
  }

  /** 松手结算：按重叠策略定下这条边。缩放没有「拒绝」，最差也是钳制。 */
  settleResize(trackId: string, clipId: string, edge: 'start' | 'end', time: number): boolean {
    const track = this.track(trackId);
    if (!track) return false;
    const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
    if (!clip) return false;
    /*
     * 左边界要**再钳一次** trim-in 下界。
     *
     * 实时拖动已经钳过一次，但松手传进来的是**指针的原始时间**，可能比下界
     * 更靠左；不再钳的话 resizeSpan 会把 start 拖到素材头部之外，而 srcIn
     * 早已停在 0 —— 于是几何与内容对不上（表现是「松手后画面从第 1 秒重放」）。
     */
    const t = edge === 'start' ? Math.max(time, earliestTrimStart(clip)) : time;
    /*
     * 结算会让别的片段也动：trim 吃掉邻居头部（起点动、终点不动）需要同步
     * 推进它的 srcIn，push 挤开邻居（两端一起动）则**不能**动。判据在
     * `applyTrimIn` 里，这里只负责把「结算前」的 lane 留一份。
     */
    const before = (track.clips as AnyClip[]).map((c) => ({ ...c }));
    const lane = resizeSpan(
      track.clips as Span[],
      clipId,
      edge,
      t,
      this.project.duration,
      this.project.overlapBehavior,
    ) as AnyClip[];
    this.writeLane(track, applyTrimIn(before, lane, this.project.beatGrid));
    // trim / push 都可能改动锁定视频的几何（push 会把它挤开）。
    this.syncLockedAudio(this.project, clipId);
    return true;
  }

  /**
   * 实时预览的落点合法性：给被拖片段加「不可落」样式用。
   * 只对 reject 有信息量——push/trim 总能把落点解决掉。
   */
  placementAccepted(targetTrackId: string, clipId: string, newStart: number): boolean {
    const found = this.findClip(clipId);
    const target = this.track(targetTrackId);
    if (!found || !target || !this.canHost(target, found.clip)) return false;
    const len = found.clip.end - found.clip.start;
    const start = Math.max(0, Math.min(newStart, Math.max(0, this.project.duration - len)));
    const cand = { ...found.clip, start, end: start + len };
    return placeSpan(target.clips as Span[], cand as Span, this.project.duration, this.project.overlapBehavior) !== null;
  }

  /**
   * 把几何层产出的 lane 写回轨道：`#r` 后缀是 trim 裂段的临时 id（见 clips.ts），
   * 在这里换成真正的 id，免得同一个片段被拆出两半后 id 撞车。
   */
  private writeLane(track: Track, lane: AnyClip[]): void {
    track.clips = lane.map((c) => (c.id.endsWith('#r') ? { ...c, id: newId() } : c)) as typeof track.clips;
  }

  /* ------------------------------------------------------- 音频链接同步 */

  private findClipIn(p: Project, clipId: string): { track: Track; clip: AnyClip } | null {
    for (const track of p.tracks) {
      const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  /** 音频片段对齐到视频的几何与源内偏移（锁定时 / 视频被写之后）。 */
  private mirrorVideoGeometry(audio: AudioClip, video: SourceClip): void {
    audio.start = video.start;
    audio.end = video.end;
    const src = video.source;
    if (src.type === 'video') audio.srcIn = Math.max(0, src.srcIn);
  }

  /**
   * 视频几何变了 → 把锁定的音频拉齐。
   *
   * **每一条几何写操作里都要调**（拖动中也要，不能只等松手）：拖动中不同步的
   * 表现是「松手瞬间音频跳一下」，而那种跳变会让用户以为锁定没生效。
   * 通过 `linkedAudioId` O(1) 定位，不需要扫全工程找 `lockedTo`。
   */
  private syncLockedAudio(p: Project, videoClipId: string): void {
    const video = this.findClipIn(p, videoClipId)?.clip;
    if (!video || video.kind !== 'source' || video.source.type !== 'video') return;
    const audioId = video.linkedAudioId;
    if (!audioId) return;
    const audio = this.findClipIn(p, audioId)?.clip;
    if (!audio || audio.kind !== 'audio') return;
    if (audio.lockedTo !== video.id) return;
    this.mirrorVideoGeometry(audio, video);
  }

  /* ------------------------------------------------------------ 跨轨 */

  /**
   * 上/下移一轨（Alt+↑↓）：跳过装不下的轨道，起点保持不变。
   * 与拖拽共用 canHost 判据——两处都不能各写一套兼容规则。
   *
   * 返回值刻意区分「没轨可去」与「目标轨被占」，因为这两件事对用户
   * 意味完全不同的下一步动作（前者无解，后者改策略或先挪开邻居）。
   */
  shiftClipTrack(clipId: string, dir: -1 | 1): 'ok' | 'no-track' | 'blocked' {
    const found = this.findClip(clipId);
    if (!found) return 'no-track';
    const from = this.project.tracks.indexOf(found.track);
    let j = from + dir;
    while (j >= 0 && j < this.project.tracks.length) {
      if (this.canHost(this.project.tracks[j]!, found.clip)) break;
      j += dir;
    }
    if (j < 0 || j >= this.project.tracks.length) return 'no-track';
    const target = this.project.tracks[j]!;
    const start = found.clip.start;
    let moved = false;
    this.commit(dir < 0 ? tr('tl.moveTrackUp') : tr('tl.moveTrackDown'), () => {
      // settlePlacement 被拒时不会改动任何状态，片段留在原轨
      moved = this.settlePlacement(target.id, clipId, start);
    });
    return moved ? 'ok' : 'blocked';
  }

  /* ------------------------------------------------------------ 时长 */

  /**
   * 工程时长（秒）**不是**由素材长度决定的：它只约束画布导出的帧数范围，
   * 片段可以把它撑长（addClip / liveMoveClip / liveResizeClip），
   * 也可以由用户直接改小（setDuration）。音频长度只是新片段的默认长度。
   */
  setDuration(sec: number): void {
    this.commit(tr('tl.setDuration'), (p) => {
      p.duration = Math.max(0.1, sec);
    });
  }

  /** 改工程名（工程内容；不是文件路径 —— 落盘目录由宿主管）。 */
  setProjectName(name: string): void {
    const next = name.trim().slice(0, 120);
    if (!next || next === this.project.name) return;
    this.commit(tr('tl.renameProject'), (p) => {
      p.name = next;
    });
  }

  /** 时长收齐到内容末尾（只收不放：内容为空时保留 1 秒）。 */
  fitDurationToContent(): void {
    this.commit(tr('tl.fitDuration'), (p) => {
      let end = 0;
      for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.end);
      p.duration = Math.max(0.1, end);
    });
  }

  /**
   * 改工程分辨率。
   *
   * 同时约束到偶数：H.264 的 4:2:0 色度需要宽高都是偶数，
   * 奇数尺寸在编码器侧会静默报错或被悄悄裁掉一列 —— 前者在
   * `runExport` 里抛，后者更难查。UI 上没有改分辨率的入口
   * （不在范围内），但导出 E2E 需要小分辨率来控制产物体积。
   */
  setResolution(w: number, h: number): void {
    const W = Math.max(16, Math.round(w / 2) * 2);
    const H = Math.max(16, Math.round(h / 2) * 2);
    this.commit(tr('tl.setResolution'), (p) => {
      p.resolution = { w: W, h: H };
    });
  }

  /**
   * 改工程帧率。
   *
   * 允许小数（23.976 / 29.97 这类是真实存在的），但保留两位就够 ——
   * 再多位在 `frameOf` 的 Math.round 里也没有意义。
   *
   * ⚠️ 改帧率会改变 `frameOf(t, fps)`，而 `seedFor(seed, id, frame)` 用的就是
   * 帧号 —— 于是所有掺了逐帧随机的特效/生成器（slices 的切片位移、噪声类）
   * 画面会跟着变。这是**预期行为**（帧号是随机的定义域），UI 上有说明。
   */
  setFps(fps: number): void {
    const v = Math.max(1, Math.min(240, Math.round(fps * 100) / 100));
    if (!Number.isFinite(v) || v <= 0) return;
    this.commit(tr('tl.setFps'), (p) => {
      p.fps = v;
    });
  }

  /**
   * 在 at（秒）处切分片段。曲线的处理：
   *   beatAnchor 曲线 —— 原样复制给两半（锚是绝对的，两半各自正确）；
   *   相对曲线 —— 左半保留 t ≤ 切点的 keys，右半 keys 平移 -切点，
   *               并在 0 处补一个边界 key 保住切点处的值。
   */
  splitClipAt(trackId: string, clipId: string, at: number): boolean {
    const track = this.track(trackId);
    if (!track) return false;
    const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
    if (!clip) return false;
    const atRel = at - clip.start;
    /*
     * 右半段的源内偏移必须前进 atRel × speed。
     *
     * 漏掉这一步的症状很具体：把一段音频从中间切开，右半段会**从头重放**
     * （它继承了原来的 srcIn），于是后半段与前半段内容重叠、整段对不上拍。
     * 视频同理。这是与「拖左边界要改 srcIn」同一个道理的两处落点。
     */
    const ti = trimInOf(clip);
    return this.commit(tr('tl.splitClip'), (p) => {
      const curvesFor = (c: AnyClip, side: 'left' | 'right'): Record<string, Curve> => {
        const curves: Record<string, Curve> = {};
        for (const [k, curve] of Object.entries(c.curves)) {
          if (curve.beatAnchor) {
            curves[k] = structuredClone(curve);
            continue;
          }
          if (side === 'left') {
            curves[k] = { ...curve, keys: curve.keys.filter((key) => key.t <= atRel + 1e-9) };
          } else {
            const boundary = evalCurve(curve, atRel, {});
            const shifted = curve.keys
              .filter((key) => key.t > atRel + 1e-9)
              .map((key) => ({ ...key, t: key.t - atRel }));
            curves[k] = {
              ...curve,
              keys: [{ t: 0, v: boundary, interp: 'step' as const }, ...shifted],
            };
          }
        }
        return curves;
      };
      const leftCurves = curvesFor(clip, 'left');
      const rightCurves = curvesFor(clip, 'right');
      const split = splitSpan(track.clips as Span[], clipId, at, newId);
      if (!split) return;
      track.clips = split.map((c) => {
        if (c.id === clipId) return { ...c, curves: leftCurves };
        if (c.start === at) {
          const right = { ...c, curves: rightCurves };
          if (!ti) return right;
          /*
           * 右半段的起点要前进「切点之前消耗掉的素材」—— 有速度曲线时是
           * 积分而不是 `atRel × speed`（见 `core/speed.ts`）。
           */
          const consumed =
            clip.kind === 'source' && clip.source.type === 'video'
              ? speedIntegralOf(clip, clip.start, at, p.beatGrid)
              : atRel * ti.speed;
          return withTrimIn(right as AnyClip, ti.srcIn + consumed);
        }
        return c;
      }) as typeof track.clips;
      track.clips.sort((a, b) => a.start - b.start);
      // 锁定的音频跟着视频一起切开，右半段重新链接到右半段视频。
      this.splitLockedAudio(p, clipId, at);
    });
  }

  /**
   * 分裂视频时把锁定音频一起切开。
   *
   * 不切的话症状是「视频切成两段、声音还是完整一条」——时间轴上看着对齐，
   * 拖动右半段视频时声音留在原地（因为它仍锁在左半脚本身）。曲线不复制到右半：
   * 曲线的 keys 是相对片段起点的，照搬会整体前移（与视频曲线的处理不同 ——
   * 视频的 `curves` 由 `splitClipAt` 自己按 key 切）。
   */
  private splitLockedAudio(p: Project, videoClipId: string, at: number): void {
    const video = this.findClipIn(p, videoClipId)?.clip;
    if (!video || video.kind !== 'source' || video.source.type !== 'video') return;
    const audioId = video.linkedAudioId;
    if (!audioId) return;
    const found = this.findClipIn(p, audioId);
    if (!found || found.clip.kind !== 'audio' || found.clip.lockedTo !== videoClipId) return;
    const audio = found.clip;
    if (at <= audio.start + MIN_CLIP_LENGTH || at >= audio.end - MIN_CLIP_LENGTH) return;

    const rightVideoClip = p.tracks
      .filter((t): t is VisualTrack => t.kind === 'visual')
      .flatMap((t) => t.clips)
      .find((c): c is SourceClip => c.kind === 'source' && c.id !== videoClipId && Math.abs(c.start - at) <= 1e-6);

    const atRel = at - audio.start;
    const ti = trimInOf(audio);
    const right: AudioClip = {
      ...audio,
      id: newId(),
      start: at,
      end: audio.end,
      srcIn: (ti ? ti.srcIn : audio.srcIn) + atRel * (ti?.speed ?? 1),
      curves: {},
      linkedVideoId: rightVideoClip?.id,
      lockedTo: rightVideoClip?.id,
    };
    delete right.fadeIn;
    delete right.fadeOut;
    audio.end = at;
    delete audio.fadeOut;

    (found.track.clips as AudioClip[]).push(right);
    found.track.clips.sort((a, b) => a.start - b.start);
    if (rightVideoClip) rightVideoClip.linkedAudioId = right.id;
  }

  /* ------------------------------------------------------------ 属性 */

  updateClip(clipId: string, label: string, fn: (clip: AnyClip) => void): void {
    this.commit(label, () => {
      const found = this.findClip(clipId);
      if (found) fn(found.clip);
    });
  }

  /**
   * 视频片段的**常速**（`source.speed`）。1 = 原速，负值不接受 —— 倒放走
   * `curves.speed`（关键帧可以取负，见 `core/speed.ts`）。
   *
   * **保持片段长度**：变速改的是「同样的时间轴长度里塞多少素材」，不是
   * 片段本身。唯一的例外是素材不够 —— 加快后需要的素材超过「`srcIn` 到素材
   * 末尾」，片段就只能缩到用完为止（用户点名的「因速度过快导致可用时长不足」）。
   * 慢放不会缩：需要更少素材。
   *
   * 写入时**清掉速度曲线**：曲线是求值的唯一真源，留着它会让「改了速度但
   * 画面没变」（静默无效）—— 那比报错难查得多。
   */
  setClipSpeed(clipId: string, speed: number): void {
    const v = Number(speed);
    if (!Number.isFinite(v) || v <= 0) return;
    const next = Math.min(100, Math.max(0.05, v));
    this.commit(tr('insp.changeSpeed'), () => {
      const clip = this.findClip(clipId)?.clip;
      if (!clip || clip.kind !== 'source' || clip.source.type !== 'video') return;
      if (clip.source.speed === next && !clip.curves[SPEED_CURVE_KEY]) return;
      delete clip.curves[SPEED_CURVE_KEY];
      clip.source.speed = next;

      const durationSec = this.project.assets[clip.source.assetId]?.durationSec;
      if (typeof durationSec === 'number' && durationSec > 0) {
        const available = Math.max(0, durationSec - clip.source.srcIn);
        const maxLen = available / next;
        if (clip.end - clip.start > maxLen) {
          clip.end = clip.start + Math.max(MIN_CLIP_LENGTH, maxLen);
        }
      }
    });
  }

  /**
   * 影响深度（特效片段）：只作用于其下方最近的 N 条启用视觉轨；0 = 下方全部。
   *
   * 语义与边界规则在 `engine/stack.ts`（渲染侧的唯一真源），这里只负责把它写成一个
   * **非负整数** —— 小数与负数直接钳掉，别让它们穿透到 `validateProject` 那里变成
   * 「保存时报错、却不知道是哪个控件写坏的」。
   */
  setEffectAffectDepth(clipId: string, depth: number): void {
    const d = Math.max(0, Math.floor(Number(depth) || 0));
    this.commit(tr('insp.changeAffectDepth'), () => {
      const found = this.findClip(clipId);
      if (found && found.clip.kind === 'effect') {
        found.clip.affectDepth = d;
        // 与绑定片段互斥：写深度即解绑（两者同时存在是矛盾状态，
        // `validateProject` 也会以绑定为准把深度丢掉）。
        delete found.clip.boundClipId;
      }
    });
  }

  /**
   * 绑定片段：让这条特效只作用于某个具体 source 片段的层（`null` = 解绑）。
   *
   * 语义与实现都在 `engine/stack.ts` / `compositor.ts`（渲染侧唯一真源）：
   * 目标片段先 placement 成整帧层，链跑在这一层上，再按该片段自己的 blend 混入。
   * 与 `affectDepth` 互斥 —— 这里写绑定时把深度清掉。
   */
  setEffectBoundClip(clipId: string, boundClipId: string | null): void {
    this.commit(tr('insp.changeBoundClip'), () => {
      const found = this.findClip(clipId);
      if (!found || found.clip.kind !== 'effect') return;
      if (boundClipId) {
        found.clip.boundClipId = boundClipId;
        delete found.clip.affectDepth;
      } else {
        delete found.clip.boundClipId;
      }
    });
  }

  setOverlapBehavior(b: OverlapBehavior): void {
    this.commit(tr('tl.setOverlapBehavior'), (p) => {
      p.overlapBehavior = b;
    });
  }

  /* ------------------------------------------------------------ 转场 */

  /**
   * 转场只可能挂在**视觉轨的 SourceClip** 上（EffectClip 没有画面可以当 from）。
   * 返回数组下标是为了让调用方拿到轨道级上下文 —— `transitionMaxDuration`
   * 需要看邻居的转场，光有片段本身算不出来。
   */
  private transitionHost(clipId: string): { track: VisualTrack; index: number } | null {
    for (const track of this.project.tracks) {
      if (track.kind !== 'visual') continue;
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index < 0) continue;
      if (track.clips[index]!.kind !== 'source') return null;
      return { track, index };
    }
    return null;
  }

  /**
   * 设 / 改一端转场（v13：`side` = 入场 / 出场）。`defId` 为空串 = 删除。
   *
   * `values` 由调用方给（core 不认识 effects/transitions 的注册表，
   * 默认参数得由 UI 侧先 `defaultTransitionValues(defId)` 取好）。
   */
  setTransition(
    clipId: string,
    side: TransitionSide,
    defId: string,
    duration: number,
    values: Record<string, number>,
  ): void {
    const host = this.transitionHost(clipId);
    if (!host) return;
    this.commit(tr('insp.setTransition'), () => {
      const clip = host.track.clips[host.index] as SourceClip;
      const key = side === 'out' ? 'transitionOut' : 'transitionIn';
      if (!defId) {
        delete clip[key];
        return;
      }
      // 先写一个占位值再算上限：`transitionMaxDuration` 会读到「同片段另一端」
      // 的存储值，而这一端此刻还没有值 —— 两端的相互钳制在下一帧由 UI 重算。
      clip[key] = { defId, duration: clampTransitionDuration(duration, 0), values: { ...values } };
      const max = transitionMaxDuration(host.track, host.index, side);
      clip[key]!.duration = clampTransitionDuration(duration, max);
    });
  }

  setTransitionOut(
    clipId: string,
    defId: string,
    duration: number,
    values: Record<string, number>,
  ): void {
    this.setTransition(clipId, 'out', defId, duration, values);
  }

  setTransitionIn(
    clipId: string,
    defId: string,
    duration: number,
    values: Record<string, number>,
  ): void {
    this.setTransition(clipId, 'in', defId, duration, values);
  }

  clearTransitionOut(clipId: string): void {
    this.setTransition(clipId, 'out', '', 0, {});
  }

  clearTransitionIn(clipId: string): void {
    this.setTransition(clipId, 'in', '', 0, {});
  }

  /** 改时长。钳制走同一个函数，UI 与这里不许各写一套。 */
  setTransitionDuration(clipId: string, seconds: number, side: TransitionSide = 'out'): void {
    const host = this.transitionHost(clipId);
    if (!host) return;
    this.commit(tr('insp.changeTransitionDuration'), () => {
      const clip = host.track.clips[host.index] as SourceClip;
      const ref = side === 'out' ? clip.transitionOut : clip.transitionIn;
      if (!ref) return;
      const max = transitionMaxDuration(host.track, host.index, side);
      ref.duration = clampTransitionDuration(seconds, max);
    });
  }

  /** 改转场参数。 */
  updateTransition(
    clipId: string,
    label: string,
    fn: (t: TransitionRef) => void,
    side: TransitionSide = 'out',
  ): void {
    const host = this.transitionHost(clipId);
    if (!host) return;
    this.commit(label, () => {
      const clip = host.track.clips[host.index] as SourceClip;
      const ref = side === 'out' ? clip.transitionOut : clip.transitionIn;
      if (ref) fn(ref);
    });
  }

  /* ---------------------------------------------------------- 素材（显示名） */

  /**
   * 改素材的**展示名**（`Project.assets[id].name`）。
   *
   * 只动这一份工程里的名字：台账里的 `originName`（决定落盘文件名与扩展名）、
   * 用户的磁盘文件、linked 素材的原文件路径**一个都不碰** —— 这条边界是
   * 需求点名的，也是「改名」与「重新链接 / 收集到工程」的分界。
   *
   * 空名字不写库（与 `renameTrack` / `renameClip` 同口径）：媒体池靠名字认人，
   * 变成一行空白等于把那条素材藏起来。已有片段 label 不跟着改 —— 片段名是
   * 另一份用户数据（用户可能已经按剪辑意图改过它）。
   */
  renameAsset(assetId: string, name: string): void {
    const next = name.trim();
    const asset = this.project.assets[assetId];
    if (!asset || !next || asset.name === next) return;
    this.commit(tr('pool.renameAsset'), (p) => {
      const a = p.assets[assetId];
      if (a) a.name = next;
    });
  }

  /* ------------------------------------------------------ 预剪辑范围（v13） */

  /** 新增或按 id 覆盖一条范围。第一条自动成为激活范围。 */
  setAssetRange(assetId: string, range: AssetTrimRange): void {
    this.commit(tr('preclip.saveRange'), (p) => {
      const asset = p.assets[assetId];
      if (!asset) return;
      const ranges = (asset.ranges ??= []);
      const i = ranges.findIndex((r) => r.id === range.id);
      if (i >= 0) ranges[i] = { ...range };
      else ranges.push({ ...range });
      // 新建的范围直接激活：用户刚保存一个范围，下一步多半就是插它。
      // 更新已有范围时不动激活项（否则「改一下别的范围」会把手上的落点换掉）。
      if (i < 0 || !asset.activeRangeId) asset.activeRangeId = range.id;
    });
  }

  removeAssetRange(assetId: string, rangeId: string): void {
    this.commit(tr('preclip.remove'), (p) => {
      const asset = p.assets[assetId];
      if (!asset?.ranges) return;
      asset.ranges = asset.ranges.filter((r) => r.id !== rangeId);
      if (!asset.ranges.length) delete asset.ranges;
      if (asset.activeRangeId === rangeId) {
        if (asset.ranges?.length) asset.activeRangeId = asset.ranges[0]!.id;
        else delete asset.activeRangeId;
      }
    });
  }

  setActiveRange(assetId: string, rangeId: string | null): void {
    this.commit(tr('preclip.saveRange'), (p) => {
      const asset = p.assets[assetId];
      if (!asset?.ranges?.length) return;
      if (rangeId && asset.ranges.some((r) => r.id === rangeId)) asset.activeRangeId = rangeId;
      else delete asset.activeRangeId;
    });
  }

  /** 视频是否含音轨（导入 / 打开工程时探测一次；null = 未知，删掉这个键）。 */
  setAssetHasAudio(assetId: string, hasAudio: boolean | null): void {
    this.commit(tr('preclip.saveRange'), (p) => {
      const asset = p.assets[assetId];
      if (!asset) return;
      if (hasAudio === null) delete asset.hasAudio;
      else asset.hasAudio = hasAudio;
    });
  }

  /* ------------------------------------------------------ 片段音频（v13） */

  /**
   * 把视频片段的内嵌音轨分离到一条**新建的音频轨**上。
   *
   * 一笔撤销做完四件事：建轨、建音频片段、把视频内嵌音轨静音、双向链接。
   * 默认 `lockedTo` = 视频片段，于是移动 / 裁剪 / 分裂视频时音频跟随
   * （`syncLockedAudio`）；用户在检查器里解锁后独立编辑。
   *
   * 返回新音频片段 id；不是视频片段时返回 null。
   */
  detachVideoAudio(clipId: string): string | null {
    const found = this.findClip(clipId);
    if (!found || found.clip.kind !== 'source' || found.clip.source.type !== 'video') return null;
    const video = found.clip;
    // 已经分离过：返回现有片段（重复点击不该造出第二条声音）。
    if (video.linkedAudioId) {
      const existing = this.findClip(video.linkedAudioId);
      if (existing?.clip.kind === 'audio') return existing.clip.id;
    }

    const audioId = newId();
    this.commit(tr('insp.audioDetach'), (p) => {
      const v = this.findClipIn(p, clipId)?.clip;
      if (!v || v.kind !== 'source' || v.source.type !== 'video') return;
      const n = p.tracks.filter((t) => t.kind === 'audio').length + 1;
      const trackId = newId();
      p.tracks.push({
        kind: 'audio',
        id: trackId,
        name: `A${n}`,
        enabled: true,
        clips: [],
        bus: 'master',
      });
      const audio: AudioClip = {
        kind: 'audio',
        id: audioId,
        start: v.start,
        end: v.end,
        label: tr('tl.audioOfClip', { name: v.label }),
        fadeSec: 0,
        curves: {},
        assetId: v.source.assetId,
        srcIn: v.source.srcIn,
        gainDb: v.audio?.gainDb,
        fadeIn: v.audio?.fadeIn,
        fadeOut: v.audio?.fadeOut,
        linkedVideoId: v.id,
        lockedTo: v.id,
      };
      v.audio = { ...v.audio, muted: true };
      v.linkedAudioId = audio.id;
      const track = p.tracks[p.tracks.length - 1]!;
      (track.clips as AudioClip[]).push(audio);
      track.clips.sort((a, b) => a.start - b.start);
    });
    return audioId;
  }

  /**
   * 锁定 / 解锁分离出来的音频。锁定时**立刻对齐**视频的几何与源内偏移 ——
   * 「锁上了但位置差半秒」比锁不上更难查。
   */
  setAudioLocked(audioClipId: string, locked: boolean): void {
    this.commit(locked ? tr('insp.audioLock') : tr('insp.audioUnlock'), (p) => {
      const found = this.findClipIn(p, audioClipId);
      if (!found || found.clip.kind !== 'audio') return;
      const audio = found.clip;
      const videoId = audio.linkedVideoId;
      const video = videoId ? this.findClipIn(p, videoId)?.clip : null;
      if (locked) {
        if (!video || video.kind !== 'source' || video.source.type !== 'video') {
          delete audio.lockedTo;
          return;
        }
        audio.lockedTo = video.id;
        video.linkedAudioId = audio.id;
        this.mirrorVideoGeometry(audio, video);
      } else {
        delete audio.lockedTo;
      }
    });
  }

  /** 音频片段 / 视频片段的静态增益（dB）。视频写进 `source` 的 audio 设置。 */
  setClipGainDb(clipId: string, db: number): void {
    const v = Math.min(12, Math.max(-60, Number.isFinite(db) ? db : 0));
    this.commit(tr('insp.audioGain'), () => {
      const clip = this.findClip(clipId)?.clip;
      if (!clip) return;
      if (clip.kind === 'audio') clip.gainDb = v === 0 ? undefined : v;
      else if (clip.kind === 'source' && clip.source.type === 'video') {
        clip.audio = { ...clip.audio, gainDb: v === 0 ? undefined : v };
      }
    });
  }

  /** 音频片段 / 视频片段内嵌音轨的渐入 / 渐出（秒）。 */
  setClipAudioFade(clipId: string, side: 'in' | 'out', seconds: number): void {
    const sec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    this.commit(tr(side === 'in' ? 'insp.audioFadeIn' : 'insp.audioFadeOut'), () => {
      const clip = this.findClip(clipId)?.clip;
      if (!clip) return;
      const dur = Math.max(0, clip.end - clip.start);
      if (clip.kind === 'audio') {
        const other = side === 'in' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
        const v = Math.min(sec, Math.max(0, dur - Math.min(other, dur)));
        if (side === 'in') {
          if (v === 0) delete clip.fadeIn;
          else clip.fadeIn = v;
        } else if (v === 0) delete clip.fadeOut;
        else clip.fadeOut = v;
        return;
      }
      if (clip.kind !== 'source' || clip.source.type !== 'video') return;
      const audio = (clip.audio ??= {});
      const other = side === 'in' ? (audio.fadeOut ?? 0) : (audio.fadeIn ?? 0);
      const v = Math.min(sec, Math.max(0, dur - Math.min(other, dur)));
      if (side === 'in') {
        if (v === 0) delete audio.fadeIn;
        else audio.fadeIn = v;
      } else if (v === 0) delete audio.fadeOut;
      else audio.fadeOut = v;
    });
  }

  /** 视频内嵌音轨静音开关（分离音频会自动置 true）。 */
  setVideoAudioMuted(clipId: string, muted: boolean): void {
    this.commit(tr(muted ? 'tl.muteAudioTrack' : 'tl.unmuteAudioTrack'), () => {
      const clip = this.findClip(clipId)?.clip;
      if (!clip || clip.kind !== 'source' || clip.source.type !== 'video') return;
      clip.audio = { ...clip.audio, muted: muted || undefined };
    });
  }

  setBeatGrid(grid: Partial<BeatGrid>): void {
    this.commit(tr('tl.setBeatGrid'), (p) => {
      Object.assign(p.beatGrid, grid);
    });
  }

  /* ------------------------------------------------------------ 段落（v8） */

  /**
   * 在 `start`（秒）处加一段。名字缺省「段落 N」，避开已有编号。
   *
   * `sections` **始终保持按 `start` 排序**（写入方只有本文件）：时间轴靠「下一段的
   * 起点」算这一段的宽度，排序散在 UI 里就会有一处忘排 —— 表现是段落带的宽度
   * 突然变成工程末尾（看起来像「段落丢了」）。
   */
  addSection(start: number, name?: string): string {
    const id = newId();
    this.commit(tr('tl.addSection'), (p) => {
      const section: Section = {
        id,
        name: name?.trim() || nextSectionName(p.sections, (n) => tr('tl.sectionN', { n })),
        start: Math.max(0, Number.isFinite(start) ? start : 0),
      };
      p.sections = sortSections([...p.sections, section]);
    });
    return id;
  }

  /**
   * 拖动中的实时位置。**不入撤销栈**：整段手势由 `beginTx` / `endTx` 记一笔
   * （与片段拖拽同一套，见 `timeline/drag.ts`）。
   */
  liveMoveSection(id: string, start: number): void {
    const section = this.project.sections.find((s) => s.id === id);
    if (!section) return;
    const next = Math.max(0, Number.isFinite(start) ? start : 0);
    if (section.start === next) return;
    section.start = next;
    this.project.sections = sortSections(this.project.sections);
    this.touch();
  }

  /**
   * 数值式的段落移动（一次调用 = 一笔撤销）。
   *
   * 拖动走 `liveMoveSection`（手势层自己 beginTx/endTx）；这里是控制平面那条
   * 路径 —— 没有指针可以结算，必须自己 `commit`，否则改动只 bump version、
   * 撤不回来。
   */
  moveSection(id: string, start: number): boolean {
    const section = this.project.sections.find((s) => s.id === id);
    if (!section) return false;
    const next = Math.max(0, Number.isFinite(start) ? start : 0);
    if (section.start === next) return false;
    this.commit(tr('tl.moveSection'), (p) => {
      const s = p.sections.find((x) => x.id === id);
      if (!s) return;
      s.start = next;
      p.sections = sortSections(p.sections);
    });
    return true;
  }

  renameSection(id: string, name: string): void {
    const next = name.trim().slice(0, 60);
    if (!next) return;
    this.commit(tr('tl.renameSection'), (p) => {
      const section = p.sections.find((s) => s.id === id);
      if (section) section.name = next;
    });
  }

  removeSection(id: string): void {
    this.commit(tr('tl.removeSection'), (p) => {
      p.sections = p.sections.filter((s) => s.id !== id);
    });
  }

  /**
   * 在 `t`（秒）处切分某一段：**只插入一个新的起点**（右半沿用同一颜色）。
   *
   * 为什么需要它：段落只存起点，所以「先标第一个点」等于把整首歌都标成第一段。
   * 让用户从后往前标是反直觉的，靠拖动去凑也不现实 —— 「在鼠标处切一刀」是
   * 唯一符合「顺序标记」直觉的操作。左半的终点自动变成新的起点，不需要改任何
   * 既有数据。
   *
   * 返回新段落的 id；`t` 落在段外（或离两端不足 `MIN_SECTION_GAP`）时返回 null
   * —— 菜单据此置灰，而不是让用户点了没反应。
   */
  splitSection(id: string, t: number): string | null {
    const hit = this.splitPoint(id, t);
    if (!hit) return null;
    const { at, color } = hit;
    const nid = newId();
    this.commit(tr('tl.splitSection'), (p) => {
      const section: Section = {
        id: nid,
        name: nextSectionName(p.sections, (n) => tr('tl.sectionN', { n })),
        start: at,
        ...(color ? { color } : {}),
      };
      p.sections = sortSections([...p.sections, section]);
    });
    return nid;
  }

  /** 这一刀切不切得动（菜单据此置灰）。与 `splitSection` 同一判据，不许各写一份。 */
  canSplitSection(id: string, t: number): boolean {
    return this.splitPoint(id, t) !== null;
  }

  /** 段的几何：`at` 已经钳进本段内；两侧太窄时返回 null。 */
  private splitPoint(id: string, t: number): { at: number; color?: string } | null {
    const all = this.project.sections;
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const sec = all[i]!;
    const end = i + 1 < all.length ? all[i + 1]!.start : this.project.duration;
    const at = Math.min(Math.max(Number.isFinite(t) ? t : sec.start, sec.start), end);
    if (at - sec.start < MIN_SECTION_GAP || end - at < MIN_SECTION_GAP) return null;
    return { at, color: sec.color };
  }

  /* ------------------------------------------------------ 音频淡变（v8） */

  /**
   * 拖三角手柄期间的实时淡变写入（一笔撤销由手势层结算）。
   *
   * 两个淡区**不许交叉**：`fadeIn + fadeOut <= 片段长度`。交叉不是「听感差一点」
   * 而是「中段被两条斜坡同时压住」——包络那边会按比例收缩，但手柄停在交叉位置
   * 会让人以为拖不动了。所以在写入处就钳住，手柄的位置与听到的声音永远一致。
   */
  liveSetFade(clipId: string, which: 'in' | 'out', seconds: number): void {
    const found = this.findClip(clipId);
    if (!found) return;
    const clip = found.clip;
    if (clip.kind !== 'audio') return;
    if (!writeFade(clip, which, clampFade(clip, which, seconds))) return;
    this.touch();
  }

  /**
   * 检查器里改「渐入 / 渐出」：与拖手柄**同一份钳制**，区别只是它是一笔撤销。
   * 两条写入路径共用 `clampFade` / `writeFade`，不各写一遍 0 与交叉的判断。
   */
  setFade(clipId: string, which: 'in' | 'out', seconds: number): void {
    const found = this.findClip(clipId);
    if (!found) return;
    const clip = found.clip;
    if (clip.kind !== 'audio') return;
    if ((clip[which === 'in' ? 'fadeIn' : 'fadeOut'] ?? 0) === clampFade(clip, which, seconds)) {
      return;
    }
    this.commit(tr(which === 'in' ? 'tl.setFadeIn' : 'tl.setFadeOut'), () => {
      writeFade(clip, which, clampFade(clip, which, seconds));
    });
  }

  /**
   * 一次写两条淡变（控制平面的 `set_clip_props` 用）。
   *
   * 与 `setFade` 共用同一份钳制，唯一区别是**一笔撤销**：逐条调 `setFade`
   * 会留下两条记录，一次工具调用撤不干净。顺序固定 in → out（与拖手柄一致），
   * 后面的钳制看得到前一条刚落的值。
   */
  setFades(clipId: string, patch: { fadeIn?: number; fadeOut?: number }): void {
    const found = this.findClip(clipId);
    if (!found) return;
    const clip = found.clip;
    if (clip.kind !== 'audio') return;
    const label = patch.fadeIn !== undefined ? tr('tl.setFadeIn') : tr('tl.setFadeOut');
    this.commit(label, () => {
      if (patch.fadeIn !== undefined) writeFade(clip, 'in', clampFade(clip, 'in', patch.fadeIn));
      if (patch.fadeOut !== undefined) writeFade(clip, 'out', clampFade(clip, 'out', patch.fadeOut));
    });
  }

  /* ------------------------------------------------------------ 序列化 */

  serialize(): string {
    return JSON.stringify(this.project, null, 2);
  }

  loadFrom(project: Project): void {
    this.commit(tr('tl.loadProject'), (p) => {
      Object.assign(p, cloneProject(project));
    });
  }

  /**
   * 换掉整份工程（打开工程 / 新建工程）。
   *
   * 与 `loadFrom` 的区别只有一条，但是关键的：**清空撤销栈**。
   * `loadFrom` 是「在当前工程里换内容」的语义（可撤销），
   * 而打开另一份工程之后撤销回上一份是错的 —— 那会让两份工程的片段混在
   * 一起，而且栈里的快照与 `savedVersion` 对不上，脏标记开始撒谎。
   */
  replaceProject(project: Project): void {
    this.project = cloneProject(project);
    this.stack.reset();
    this.bump();
  }
}

/* ---------------------------------------------------------- 类型收窄 */

export function isSourceClip(c: AnyClip): c is SourceClip {
  return c.kind === 'source';
}

export function isEffectClip(c: AnyClip): c is EffectClip {
  return c.kind === 'effect';
}

export function isAudioClip(c: AnyClip): c is AudioClip {
  return c.kind === 'audio';
}
