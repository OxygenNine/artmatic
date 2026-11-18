/**
 * preview-cache.ts（ui）— 预览渲染缓存的调度层：什么时候烘、什么时候放。
 *
 * 五条纪律，失效时的形态都是「用户以为缓存坏了」，所以每条都要在：
 *
 * 1. **只在空闲时烘**：播放头静止、距上次编辑 ≥ 1.5 s、且没在播放。
 * 2. **只有那一段的内容变了才作废**：失效判据是**每段自己的签名**
 *    （`core/preview-cache.ts::rangeSignature`），不是整份工程。在 50 s 处改一个
 *    片段，0–20 s 那段的缓存照旧命中 —— 那段的像素一个都没变。
 * 3. **播放中绝不回精确合成**（只要那一段有缓存）：队列一时没货就**重复上一帧**
 *    并继续追。精确合成一旦让帧率掉到 10 fps，播放头反而跑得更快，就更追不上
 *    —— 那是正反馈，不是抖动。缓存是「播放」的路径，精确合成是「暂停 / 停下来
 *    看」的路径。
 * 4. **拖动也用缓存**（画质是次要的）：拖动是定位，不是审片。停在原地之后由
 *    `tick` 走一次精确渲染给出锐利的那一帧。
 * 5. **出错一律当未命中**：这里的任何异常都不许冒到渲染路径上。`draw()` 只有
 *    两个返回值 —— 画了 / 没画。
 *
 * 烘焙侧：渲进离屏目标（`render/bake-surface.ts`），节奏由 `pump` 在每个 rAF
 * 末尾推进一帧并按实测成本让路 —— 所以烘焙期间预览既不冻也不占画布。
 */

import {
  cacheRanges,
  coversRange,
  rangeSignature,
  PREVIEW_BAKE_IDLE_FACTOR,
  PREVIEW_BAKE_MAX_FPS,
  PREVIEW_CACHE_VER,
  usableEntry,
  type PreviewCacheEntry,
} from '../core/preview-cache';
import { evenDims } from '../core/dims';
import { PreviewCacheStore } from '../project/preview-cache-store';
import { openBake, type BakeSession } from '../render/preview-encoder';
import { PreviewSlicePlayer } from '../render/preview-player';
import type { BakeSurface } from '../render/bake-surface';
import type { FsDirHandle } from '../project/fs';
import type { Kit } from '../engine/kit';
import type { Renderer } from '../engine/renderer';
import type { Project } from '../core/schema';
import type { SourceTexture } from '../engine/compositor';

/** 空闲多久才开始烘（ms）。太短会在「刚改完还在想」的时候抢主线程。 */
const IDLE_MS = 1500;
/** 解码前瞻深度（帧）。 */
const LOOKAHEAD = 3;
/** 落后超过这么多帧就先「跳过中间帧」再补前瞻（见 `fill`）。 */
const CATCHUP_FRAMES = LOOKAHEAD + 1;

export interface PreviewCacheHooks {
  /** 取当前工程（点访问：切工程后这里必须读到新的那份）。 */
  project: () => Project;
  /** 渲染器（烘焙帧要它的 `prepareFrame`：视频取帧 / 排版光栅化）。`null` = 还没装配好。 */
  renderer: () => Renderer | null;
  /** 离屏烘焙面（`render/render-core.ts` 装配）。`null` = 这个宿主没有缓存能力。 */
  surface: () => BakeSurface | null;
  /** 当前播放头（秒）。片段的轮转顺序按它定。 */
  playT: () => number;
  /** 播放头在走。**播放中绝不生成** —— 那会和预览抢主线程。 */
  playing: () => boolean;
  /**
   * 预览渲染尺寸（`kit.w × kit.h`），**原值返回即可**：缓存自己取偶
   * （H.264 只吃偶数宽高，见 `core/dims.ts`），调用方不必处理。
   */
  size: () => { w: number; h: number };
  /** 工程目录句柄。没有工程 / 没落到磁盘时返回 null。 */
  root: () => FsDirHandle | null;
  /** 素材指纹（台账内容哈希的哈希）。变了就换键。 */
  assetsRev: () => string;
  /** 缓存总预算（字节）。 */
  budget: () => number;
  /** 生成期间的用户可见状态（null = 空闲）。 */
  onStatus?: (s: { encoding: number; total: number } | null) => void;
}

export class PreviewCacheController {
  private enabled = false;
  private store: PreviewCacheStore | null = null;
  /** 按**段首帧号**索引。内容是否还有效由 `sigMemo` 判（见 `validEntryAt`）。 */
  private entries = new Map<number, PreviewCacheEntry>();
  /**
   * 区间 → 内容签名的记忆。**键含 docVersion 语义**：`refresh()` 一来就清空，
   * 所以「内容变了」这件事只会在下一次访问时重算一次，而不是每帧算一遍。
   */
  private sigMemo = new Map<string, string>();
  /** 打开 store 时用的目录（换工程要重开）。 */
  private storeRoot: FsDirHandle | null = null;

  private player: PreviewSlicePlayer | null = null;
  private playerIndex = -1;
  private queue: { ts: number; tex: SourceTexture }[] = [];
  private pumping = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次真正画出去（blit 或精确渲染）的帧号。队列空时用它当补帧锚点。 */
  private lastDrawnFrame = -1;
  /** 补前瞻队列的那一趟（见 `scheduleFill`：它必须排在当前帧上屏之后）。 */
  private fillTimer: ReturnType<typeof setTimeout> | null = null;
  /** 空闲计时器记下的 docVersion（内容变了就作废，见 `scheduleIdle`）。 */
  private idleDoc = -1;
  private disposed = false;

  /* ------------------------------------------------------------ 拖动侧状态 */

  /** 拖动最近一次解出来的那一帧（先铺它，避免整块空白 / 闪回精确合成）。 */
  private scrubTex: SourceTexture | null = null;
  /** 拖动时**最新**的请求（0 = 没有）。合并连发的指针事件，一次只解一张。 */
  private scrubWanted = 0;
  private scrubBusy = false;

  /* ------------------------------------------------------------ 烘焙侧状态 */

  private session: BakeSession | null = null;
  /**
   * 一段烘焙的固定元数据（写盘条目要用，窗口中途变了也不该写错尺寸）。
   *
   * `sig` 也在这里：这一段是按**开工那一刻**的内容签名烘的。收尾时若用户刚
   * 编辑过（签名已经变了），产物必须记在旧签名下 —— 记成新签名就等于把旧画面
   * 塞进新内容里，播放时会被当成「当前的精确画面」放出来。
   */
  private sessionMeta: { w: number; h: number; fps: number; sig: string } | null = null;
  /** 上一次 `step()` 还没回来（编码器背压可能跨好几帧）。 */
  private sessionBusy = false;
  /** 下一次允许烘的时刻（墙钟）。**这是唯一的让速旋钮**，见 `pump`。 */
  private nextBakeAt = 0;
  /** 单帧主线程成本（EMA，ms）。按它拉开间隔：内容越贵，烘得越慢。 */
  private bakeCostEma = 0;
  /** `encodeRange` 的完成信号：段结束（成功 / 取消 / 失败）都 resolve。 */
  private sessionDone: (() => void) | null = null;
  /** 生成中（时间轴的虚线用）。 */
  private activeRange: { from: number; to: number } | null = null;
  /** 当前这一段是被**主动取消**的：`step()` 抛错时不要当异常刷日志。 */
  private cancelled = false;

  constructor(
    private readonly kit: Kit,
    private readonly hooks: PreviewCacheHooks,
  ) {}

  /**
   * 缓存尺寸 = 预览渲染尺寸**取偶**（见 `core/dims.ts`）。
   *
   * 键、条目、编码尺寸、解码后的纹理全都用它 —— 只在一处取偶，
   * 任何一处漏掉都会让「条目尺寸 ≠ 当前尺寸」，表现是缓存永远不命中。
   */
  private cacheSize(): { w: number; h: number } {
    const s = this.hooks.size();
    return evenDims(s.w, s.h);
  }

  /** 开/关。关掉就是**完全关掉**：不读不写不扫，已打开的解码器也放掉。 */
  async setEnabled(on: boolean): Promise<void> {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      await this.cancelEncoding();
      await this.closePlayer();
      this.store = null;
      this.storeRoot = null;
      this.entries.clear();
      this.sigMemo.clear();
      this.hooks.onStatus?.(null);
      return;
    }
    await this.refresh(false);
  }

  private lastDoc = -1;
  /**
   * 用户至少播放过一次。
   *
   * 生成的前提是「这段看过一遍了」。没有这道闸，「打开工程 → 静置 1.5 秒」
   * 就会开始烘一整片（≈10 s 的 CPU/GPU），而用户可能只是想看看时间轴。
   */
  private hasPlayed = false;

  /** 播放时调（每帧）。第一次放行生成闸，之后什么都不做。 */
  markPlayed(): void {
    if (this.hasPlayed) return;
    this.hasPlayed = true;
    this.scheduleIdle(this.hooks.project());
  }

  /**
   * 播放结束 / 用户停手：**重新排一次空闲烘焙**。
   *
   * 少了这一步，被播放打断的那一片就永远不会续上（`markPlayed` 只放行一次），
   * 表现是「有时候流畅、有时候不流畅」——取决于那一片有没有在第一次播放之前烘完。
   */
  noteIdle(): void {
    if (!this.enabled || this.disposed || !this.store) return;
    this.scheduleIdle(this.hooks.project());
  }

  /**
   * 每个 tick 调一次：`docVersion` 变了才真的重算。
   *
   * 不这么做的话每帧都要重算签名 / 扫盘 —— 那比它想省掉的渲染还贵。
   */
  noteDoc(version: number): void {
    if (version === this.lastDoc) return;
    this.lastDoc = version;
    void this.refresh();
  }

  /**
   * 工程 / 尺寸 / 素材变了之后调用（幂等）。`regen` = 是否允许顺手补烘一片。
   *
   * **注意：这里不清索引**。内容变了的条目由 `validEntryAt` 按签名判死
   * （并顺手删文件），没变的照旧命中 —— 这正是「改别处不炸这里」的实现点。
   */
  async refresh(regen = true): Promise<void> {
    if (!this.enabled || this.disposed) return;
    const root = this.hooks.root();
    if (!root) return;
    const project = this.hooks.project();
    // 内容可能变了：签名一律重算（懒算，见 `sigFor`）。
    this.sigMemo.clear();
    if (!this.store || this.storeRoot !== root) {
      try {
        this.store = await PreviewCacheStore.ensure(root);
        this.storeRoot = root;
        this.entries.clear();
        for (const e of this.store.entries()) this.entries.set(e.from, e);
      } catch {
        this.store = null;
        this.storeRoot = null;
        return;
      }
    }
    // 时间被剪掉的那些段永远不会再播：按几何回收（内容是否过期由访问时判）。
    await this.store.gc(this.hooks.budget(), cacheRanges(project));
    if (regen) this.scheduleIdle(project);
  }

  /**
   * 正在烘的帧区间。**它不再阻止预览渲染**（烘焙走离屏目标），
   * 只决定时间轴上那条线画在哪、画多长。
   */
  get encoding(): { from: number; to: number } | null {
    return this.activeRange;
  }

  /* ------------------------------------------------------------ 签名与命中 */

  /** 一段的内容签名（带记忆：同一 docVersion 内只算一次）。 */
  private sigFor(from: number, to: number): string {
    const key = `${from}-${to}`;
    const hit = this.sigMemo.get(key);
    if (hit !== undefined) return hit;
    const size = this.cacheSize();
    const sig = rangeSignature({
      project: this.hooks.project(),
      assetsRev: this.hooks.assetsRev(),
      w: size.w,
      h: size.h,
      from,
      to,
    });
    this.sigMemo.set(key, sig);
    return sig;
  }

  /** 这一条现在还能不能用（签名 / 尺寸 / 帧率全对）。 */
  private isFresh(e: PreviewCacheEntry): boolean {
    const size = this.cacheSize();
    return usableEntry(e, {
      sig: this.sigFor(e.from, e.to),
      fps: Math.max(1, this.hooks.project().fps),
      w: size.w,
      h: size.h,
      from: e.from,
      to: e.to,
    });
  }

  /**
   * 覆盖这一帧、且**内容仍然有效**的条目。
   *
   * 过期的条目在这里顺手删掉（GC 按几何回收，判不了内容），所以代价只落在
   * 「真的被播到的那一段」上。
   */
  private validEntryAt(frame: number): PreviewCacheEntry | null {
    for (const e of this.entries.values()) {
      if (frame < e.from || frame >= e.to) continue;
      if (this.isFresh(e)) return e;
      this.entries.delete(e.from);
      void this.store?.remove(e);
    }
    return null;
  }

  /** 当前**仍然有效**的全部缓存区间（时间轴的缓存条用它）。 */
  coverage(): { from: number; to: number; bytes: number }[] {
    const out: { from: number; to: number; bytes: number }[] = [];
    for (const e of this.entries.values()) {
      if (this.isFresh(e)) out.push({ from: e.from, to: e.to, bytes: e.bytes });
    }
    return out;
  }

  /**
   * 正在烘的帧区间 + 已经码到第几帧。`done` 是**段内帧数**，时间轴据此把
   * 「已烘好的那条线」画成实时增长的。
   */
  encodingRange(): { from: number; to: number; done: number } | null {
    const r = this.activeRange;
    if (!r) return null;
    return { from: r.from, to: r.to, done: this.session?.done ?? 0 };
  }

  /* ------------------------------------------------------------ 播放侧 */

  /**
   * 队列里「最接近且不晚于本帧」的那一条（升序，三条，线性扫）。
   *
   * 为什么允许「旧一帧」：播放时时间按音频钟走，而画面每次要干活，实际是
   * **每 tick 前进 1–2 帧**。死抠「必须精确等于本帧」会让「跳过的那一帧」变成
   * 一次未命中 —— 实测 20% 的帧因此掉回精确渲染，收益全被吃掉。
   * 容差 1.5 帧（30fps 下 50ms）与播放器的降帧策略同量级；**绝不取未来帧**
   * （d > 0.5 的不取），否则剪切点会提前露出下一个镜头。
   */
  private pickFromQueue(want: number, fps: number): number {
    // 明显过期的先丢，否则队列会被三条陈旧帧堵住、`fill` 永远不跑（实测卡死过）。
    while (this.queue.length > 0 && this.queue[0]!.ts * fps < want - 2) this.queue.shift();
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.queue.length; i += 1) {
      const d = this.queue[i]!.ts * fps - want;
      // 队列升序：越过「未来半帧」之后没必要再看了。
      if (d > 0.5) break;
      const ad = Math.abs(d);
      if (ad < bestD) {
        bestD = ad;
        best = i;
      }
    }
    return best >= 0 && bestD <= 1.5 ? best : -1;
  }

  /**
   * 这一帧能不能用缓存画。**同步**：`tick` 里不能 await。
   *
   * **不命中时不回精确合成**：只要这一段有缓存，就重复上一帧并继续追
   * （见文件头第 3 条）。只有「这一帧根本没有缓存覆盖」才返回 false。
   */
  draw(renderer: Renderer, t: number): boolean {
    if (!this.enabled) return false;
    const project = this.hooks.project();
    const fps = Math.max(1, project.fps);
    const want = Math.round(t * fps);
    const pick = this.pickFromQueue(want, fps);
    this.lastDrawnFrame = want;
    if (pick >= 0) {
      renderer.blitTexture(this.queue[pick]!.tex.tex);
      this.queue.splice(0, pick + 1);
      this.scheduleFill(project);
      return true;
    }
    const hold = this.player?.lastTex() ?? null;
    if (hold) {
      renderer.blitTexture(hold.tex);
      this.scheduleFill(project);
      return true;
    }
    this.scheduleFill(project);
    return false;
  }

  /**
   * **拖动播放头**时用缓存画（`tick` 在「暂停且刚刚动过播放头」时调）。
   *
   * 拖动是定位，不是审片：这里**只解码、不合成**，并且一定要给出上一张
   * （`scrubTex` / player 的最后一帧）—— 空白或闪一次精确合成都比「糊一帧」糟。
   * 停下来之后 `tick` 会走一次精确渲染，得到的才是锐利的那一帧。
   *
   * 返回 false 只有一种情况：这一帧没有任何有效缓存覆盖（那就只能精确合成）。
   */
  scrubbing(renderer: Renderer, t: number): boolean {
    if (!this.enabled) return false;
    const project = this.hooks.project();
    const fps = Math.max(1, project.fps);
    const frame = Math.round(t * fps);
    const entry = this.validEntryAt(frame);
    if (!entry) {
      if (this.playerIndex !== -1) void this.closePlayer();
      return false;
    }
    if (this.playerIndex !== entry.from || !this.player) {
      void this.openPlayer(entry, fps);
      return this.holdScrub(renderer);
    }
    this.requestScrub(t, renderer);
    return this.holdScrub(renderer);
  }

  private holdScrub(renderer: Renderer): boolean {
    const tex = this.scrubTex ?? this.player?.lastTex() ?? null;
    if (!tex) return false;
    renderer.blitTexture(tex.tex);
    return true;
  }

  /**
   * 拖动时的解码：**合并请求，一次只解一张**（拖动一秒能发 100 多个事件，
   * 而单次随机访问解码 10 ms 量级）。解完**立刻**铺上 —— 不在 rAF 里等，
   * 手上的那一下拖动就有即时反馈。
   */
  private requestScrub(t: number, renderer: Renderer): void {
    this.scrubWanted = t;
    if (this.scrubBusy) return;
    void this.pumpScrub(renderer);
  }

  private async pumpScrub(renderer: Renderer): Promise<void> {
    this.scrubBusy = true;
    try {
      while (this.scrubWanted > 0) {
        const t = this.scrubWanted;
        this.scrubWanted = 0;
        const player = this.player;
        if (!player) break;
        const tex = await player.decodeAt(t);
        if (!tex) continue;
        this.scrubTex = tex;
        renderer.blitTexture(tex.tex);
      }
    } finally {
      this.scrubBusy = false;
    }
  }

  /** 播放头进入某一段时打开它；离开就关。 */
  async prime(t: number): Promise<void> {
    if (!this.enabled || !this.store) return;
    const project = this.hooks.project();
    const fps = Math.max(1, project.fps);
    const entry = this.validEntryAt(Math.round(t * fps));
    const id = entry ? entry.from : -1;
    // 每帧都会调一次：已经在正确的那一段（含「本来就没有」）就立刻返回。
    if (this.playerIndex === id) return;
    if (!entry) {
      if (this.playerIndex !== -1) await this.closePlayer();
      return;
    }
    await this.openPlayer(entry, fps);
  }

  /** 打开一段：读 blob → 建解码器 → 打开时可以顺手补一次队列。 */
  private async openPlayer(entry: PreviewCacheEntry, fps: number): Promise<void> {
    const store = this.store;
    if (!store) return;
    if (this.playerIndex === entry.from && this.player) return;
    await this.closePlayer();
    const blob = await store.readBlob(entry);
    if (!blob) {
      this.entries.delete(entry.from);
      return;
    }
    const size = this.cacheSize();
    const player = await PreviewSlicePlayer.open(this.kit, blob, {
      fps,
      w: size.w,
      h: size.h,
      fromFrame: entry.from,
    });
    if (!player) return;
    this.player = player;
    this.playerIndex = entry.from;
    this.scheduleFill(this.hooks.project());
  }

  /**
   * 补前瞻队列，但**排到当前任务之后**（`setTimeout` 是新任务）。
   *
   * 为什么不能就地补：解码（含建帧、上传纹理）压在同一个 rAF 任务里就等于把
   * 这一帧的上屏往后推 —— 缓存开着反而更卡。
   */
  private scheduleFill(project: Project): void {
    if (this.fillTimer !== null || !this.player || this.disposed) return;
    if (this.queue.length >= LOOKAHEAD) return;
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null;
      void this.fill(project);
    }, 0);
  }

  /** 把前瞻窗口填满。同一时刻只有一趟（解码器不能被并发调用）。 */
  private async fill(project: Project): Promise<void> {
    if (!this.player || this.pumping || this.disposed) return;
    if (this.queue.length >= LOOKAHEAD) return;
    this.pumping = true;
    const player = this.player;
    try {
      const fps = Math.max(1, project.fps);
      const wantFrame = Math.round(this.hooks.playT() * fps);
      let tail = this.queue.length
        ? Math.round(this.queue[this.queue.length - 1]!.ts * fps)
        : this.lastDrawnFrame;
      /*
       * 落后太多（解码没跟上 / 页面被切走 / 刚拖动过）：**跳过中间帧**。
       * 那些帧根本不会上屏，但每帧都要付「构帧 + 上传 + GPU 同步」的钱。
       * 不跳的话队列会一直填着陈旧帧、`pickFromQueue` 一直丢，永远追不上。
       */
      if (wantFrame - tail > CATCHUP_FRAMES) {
        player.skipTo((wantFrame - 1) / fps);
        this.releaseQueue();
        tail = wantFrame - 1;
      }
      /*
       * 时间戳落在**帧栅格**上（`f / fps`）：命中判定于是变成整数比较。
       * 锚点取「队尾那一帧」而不是**当刻**播放头：播放头是活的（音频钟，
       * 两次读之间会走零点几帧），拿它 round 出来的起点会比队列多跳一帧，
       * 队列于是整体偏到未来 —— 表现是「每隔几帧漏一次」，而原因看不出来。
       */
      const anchor = Math.max(tail, wantFrame - 1);
      for (let f = anchor + 1; this.queue.length < LOOKAHEAD; f += 1) {
        const ts = f / fps;
        if (ts < 0) continue;
        const tex = await player.decode(ts);
        if (!tex) break;
        this.queue.push({ ts, tex });
      }
    } catch {
      /* 解不出来就不放缓存，这一帧重复上一张 */
    } finally {
      this.pumping = false;
    }
  }

  private releaseQueue(): void {
    for (const q of this.queue) this.kit.gl.deleteTexture(q.tex.tex);
    this.queue = [];
  }

  private async closePlayer(): Promise<void> {
    if (this.fillTimer !== null) clearTimeout(this.fillTimer);
    this.fillTimer = null;
    this.releaseQueue();
    this.playerIndex = -1;
    this.scrubTex = null;
    this.scrubWanted = 0;
    const p = this.player;
    this.player = null;
    if (p) await p.dispose();
  }

  /* ------------------------------------------------------------ 生成侧 */

  private scheduleIdle(project: Project): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.enabled || this.disposed) return;
    this.idleDoc = this.lastDoc;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.enabled || this.disposed) return;
      // 这 1.5 s 里改过内容就放弃（`refresh` 会重新排）。
      if (this.idleDoc !== this.lastDoc) return;
      void this.encodeNext(project);
    }, IDLE_MS);
  }

  /**
   * 烘**下一段没烘过的**：**从播放头所在段开始环形轮转**。
   *
   * 一次只烘一段：单片 20 s 内容 ≈ 15–30 s 生成时间，连着烘会让「刚想改个参数」
   * 等半分钟。下一段由下一次空闲（编辑、或播放结束）接着做。
   */
  private async encodeNext(project: Project): Promise<void> {
    if (!this.store || !this.enabled || !this.hasPlayed) return;
    // 播放中不生成：那正是这个功能要消除的卡顿来源。
    if (this.hooks.playing()) return;
    if (this.session) return;
    const size = this.cacheSize();
    const fps = Math.max(1, project.fps);
    const ranges = cacheRanges(project);
    if (ranges.length === 0) return;
    const cov = this.coverage();
    // 以播放头所在段为起点，向后轮转、绕回开头。
    const frame = Math.round(this.hooks.playT() * fps);
    const start = Math.max(
      0,
      ranges.findIndex((r) => frame >= r.from && frame < r.to),
    );
    for (let k = 0; k < ranges.length; k += 1) {
      const range = ranges[(start + k) % ranges.length]!;
      if (coversRange(cov, range.from, range.to)) continue;
      void this.startSlice(project, { w: size.w, h: size.h }, fps, range.from, range.to);
      return;
    }
  }

  /**
   * 手工烘一段（片段的右键菜单）。范围就是**这个片段**，不与自动切段对齐。
   *
   * 不要求「播放过」：这是用户明确要求的动作，不是后台猜测。同一时刻只烘一段；
   * 返回的 Promise 在**这一段结束**（成功 / 取消 / 失败）时 resolve。
   */
  async encodeRange(fromFrame: number, toFrame: number): Promise<void> {
    if (!this.enabled || this.session) return;
    // **先刷新再判 store**：装配时工程可能还没打开，`store` 那时是 null。
    await this.refresh(false);
    if (!this.store) return;
    const project = this.hooks.project();
    const fps = Math.max(1, project.fps);
    const total = Math.max(1, Math.ceil(project.duration * fps));
    const from = Math.max(0, Math.min(total, Math.round(fromFrame)));
    const to = Math.max(from + 1, Math.min(total, Math.round(toFrame)));
    if (to <= from) return;
    const size = this.cacheSize();
    await this.startSlice(project, { w: size.w, h: size.h }, fps, from, to);
  }

  /**
   * 起一段烘焙并**等到它结束**（`encodeRange` 的语义）。
   *
   * 真正的推进在 `pump` 里：这里只负责开会话与登记完成信号。
   */
  private async startSlice(
    project: Project,
    size: { w: number; h: number },
    fps: number,
    from: number,
    to: number,
  ): Promise<void> {
    const store = this.store;
    const renderer = this.hooks.renderer();
    const surface = this.hooks.surface();
    if (!store || !renderer || !surface || this.session) return;

    const ctrl = new AbortController();
    this.cancelled = false;
    this.activeRange = { from, to };
    this.sessionMeta = { w: size.w, h: size.h, fps, sig: this.sigFor(from, to) };
    this.hooks.onStatus?.({ encoding: 0, total: to - from });

    let session: BakeSession | null = null;
    try {
      /*
       * 工程**快照**：一段烘焙必须对应一份内容。中途编辑会让这一段失效，
       * 但快照保证「已经烘进去的帧」不会一半新一半旧。
       */
      session = await openBake(renderer, surface, structuredClone(project), {
        size,
        from,
        to,
        signal: ctrl.signal,
      });
    } catch (err) {
      console.warn('[preview-cache] bake failed to start', err);
    }

    if (!session) {
      if (this.cancelled || ctrl.signal.aborted) {
        // 在这几毫秒里被取消（编辑 / 播放）：不是「编不了」，不要乱报。
        this.activeRange = null;
        this.sessionMeta = null;
        this.hooks.onStatus?.(null);
        return;
      }
      /*
       * 编不了（尺寸不合法 / 无 WebCodecs / 四档 H.264 都不支持）：必须说话。
       * 带上尺寸 —— H.264 对奇数宽高的拒绝与「本机没有编码器」看起来一模一样。
       */
      console.warn(
        '[preview-cache] no usable H.264 encoder',
        `${size.w}×${size.h}`,
        '- cache disabled for this build',
      );
      this.activeRange = null;
      this.sessionMeta = null;
      this.hooks.onStatus?.(null);
      return;
    }

    // 开编码器的那几毫秒里被取消了：这一段不登记，直接把会话收掉。
    // （顺序很重要：`finishSlice` 在 `session` 还没登记时是空操作，
    //  若先建完成信号就会永远等不到 resolve。）
    if (this.cancelled || ctrl.signal.aborted || !this.activeRange) {
      await session.cancel();
      this.activeRange = null;
      this.sessionMeta = null;
      this.hooks.onStatus?.(null);
      return;
    }

    const done = new Promise<void>((resolve) => {
      this.sessionDone = resolve;
    });
    this.session = session;
    this.bakeCostEma = 0;
    // 第一帧立刻烘，不等让速间隔。
    this.nextBakeAt = 0;
    await done;
  }

  /**
   * **每个 rAF 调一次**（预览画完之后）。至多推进一帧烘焙。
   *
   * 为什么是 rAF 而不是 `setTimeout`：让速的对象是**帧**，不是毫秒。
   * 一帧烘焙的主线程成本实测 2–4 ms（渲 FBO 0.2 + 回读 1.5 + 构帧 0.2），
   * 240 Hz 屏幕上每帧预算只有 4.16 ms —— 每个 vsync 都烘一帧必然掉合成器的帧，
   * 而 JS 侧的 rAF 间隔看起来毫无异常（这正是「显示 240 fps 但体感很卡」）。
   *
   * 间隔取 `max(1000/MAX_FPS, 实测成本 × IDLE_FACTOR)`：把烘焙压到约 1/4 的
   * 占空比，剩下的时间全是预览与交互的。内容特别贵时它自动变慢，而不是把前台拖下去。
   */
  pump(now: number): void {
    const s = this.session;
    if (!s || this.sessionBusy || this.disposed || !this.enabled) return;
    if (this.hooks.playing()) {
      void this.cancelEncoding();
      return;
    }
    if (now < this.nextBakeAt) return;
    void this.stepBake(s);
  }

  private async stepBake(s: BakeSession): Promise<void> {
    this.sessionBusy = true;
    try {
      const { more, costMs } = await s.step();
      if (costMs > 0) {
        this.bakeCostEma = this.bakeCostEma === 0 ? costMs : this.bakeCostEma * 0.7 + costMs * 0.3;
      }
      this.nextBakeAt = performance.now() + this.bakeInterval();
      this.hooks.onStatus?.({ encoding: s.done, total: s.to - s.from });
      if (!more) await this.finishSlice(true);
    } catch (err) {
      // 取消是正常路径；其它失败要留痕 —— 静默吞掉的表现是「点了没反应」。
      if (!this.cancelled) console.warn('[preview-cache] encode failed', err);
      await this.finishSlice(false);
    } finally {
      this.sessionBusy = false;
    }
  }

  private bakeInterval(): number {
    const base = 1000 / PREVIEW_BAKE_MAX_FPS;
    return Math.max(base, this.bakeCostEma * PREVIEW_BAKE_IDLE_FACTOR);
  }

  /** 收尾：`save` = 产物有效，落盘。无论成败都要释放编码器与完成信号。 */
  private async finishSlice(save: boolean): Promise<void> {
    const s = this.session;
    const meta = this.sessionMeta;
    const range = this.activeRange;
    this.session = null;
    this.sessionMeta = null;
    this.activeRange = null;
    this.nextBakeAt = 0;
    const resolve = this.sessionDone;
    this.sessionDone = null;

    try {
      if (s && save && range && meta) {
        const blob = await s.finish();
        if (blob) await this.storeSlice(blob, range, meta);
        else await s.cancel();
      } else if (s) {
        await s.cancel();
      }
    } catch (err) {
      console.warn('[preview-cache] encode failed', err);
    } finally {
      /*
       * 「空闲」这条通知必须排在**落盘之后**：时间轴靠它触发重画，而重画读的是
       * `entries`。先报空闲再落盘的话，条子上永远少最后这一片（实测：一片烘完
       * 后条子纹丝不动，下一次烘焙开始才补上）。
       */
      this.hooks.onStatus?.(null);
      resolve?.();
    }
  }

  /** 落盘一段产物（条目 + 字节 + 回收）。 */
  private async storeSlice(
    blob: Blob,
    range: { from: number; to: number },
    meta: { w: number; h: number; fps: number; sig: string },
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const entry: PreviewCacheEntry = {
      ver: PREVIEW_CACHE_VER,
      // 签名取**开工那一刻**的那份（见 `sessionMeta`）。
      sig: meta.sig,
      from: range.from,
      to: range.to,
      fps: meta.fps,
      w: meta.w,
      h: meta.h,
      bytes: bytes.byteLength,
      at: Date.now(),
    };
    await store.write(entry, bytes);
    this.entries.set(entry.from, entry);
    this.sigMemo.set(`${entry.from}-${entry.to}`, entry.sig);
    const project = this.hooks.project();
    await store.gc(this.hooks.budget(), cacheRanges(project));
  }

  /** 清空整个缓存目录（设置页的按钮）。 */
  async clear(): Promise<void> {
    await this.cancelEncoding();
    await this.closePlayer();
    this.entries.clear();
    this.sigMemo.clear();
    try {
      await this.store?.clear();
    } catch {
      /* 删不掉不算错 */
    }
  }

  /** 换工程：句柄换了，索引与解码器都作废。 */
  async reset(): Promise<void> {
    await this.cancelEncoding();
    await this.closePlayer();
    this.store = null;
    this.storeRoot = null;
    this.entries.clear();
    this.sigMemo.clear();
    this.lastDoc = -1;
  }

  /** 放弃当前这一段（编辑 / 播放 / 关缓存 / 换工程都走它）。 */
  async cancelEncoding(): Promise<void> {
    if (!this.session && !this.activeRange) return;
    this.cancelled = true;
    await this.finishSlice(false);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelEncoding();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.closePlayer();
  }
}
