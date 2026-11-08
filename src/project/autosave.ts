/**
 * autosave.ts — 自动保存的**调度器**。
 *
 * 本文件刻意不认识 appState / OPFS / 工程格式：它只回答「什么时候写、
 * 同时只允许写几份、失败怎么办」。真正的落点由注入的 `writeFormal` /
 * `writeDraft` 决定，所以整条编排可以在 Node 里用 `memoryRoot()` 测完
 * （`tests/unit/autosave.test.ts`）。
 *
 * ## 三条硬约定（缺一条都会让自动保存变成风险）
 *
 * 1. **不轮转 `.bak`**：`.bak` 只在手动保存时写。自动保存每两秒把 `.bak`
 *    刷成「两秒前」，它就不再是「上一次手动保存」的兜底。
 * 2. **不入撤销栈、不 bump version、不动 `savedDocVersion`**：自动保存是**磁盘**
 *    行为，不是编辑行为。工程在界面上必须继续显示「有未保存改动」——
 *    否则用户会以为 `.bak` 是最新的。
 * 3. **单飞**：同一工程同时只允许一个写入。后到的请求合并成**一次**，
 *    用完成那一刻的最新快照。手动保存会 `cancel()` 掉排队中的自动保存。
 *
 * ## 失败降级
 *
 * 正式工程写失败（磁盘满 / 权限失效 / 目录被移走）→ 转写本地草稿，并把
 * 状态置成 `degraded`（底栏常驻一条提示，带原因）。草稿也写失败才是
 * `error` —— 那意味着自动保存什么都没保住，界面必须说实话。
 */

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'degraded' | 'error';

export interface AutosaveSnapshot {
  /** 这一次写的目标身份（草稿文件名用它）。切换工程后必须变。 */
  key: string;
  /** 展示名（草稿横幅要显示「哪个工程」）。 */
  name: string;
  /** 快照时刻的工程对象。**不要**在这里序列化 —— 写入方各自决定格式。 */
  project: unknown;
  /** 有正式目录 → 写 `project.json`；否则写本地草稿。 */
  formal: boolean;
}

export interface AutosaveDeps {
  /** 当前快照。返回 null = 现在没有可写的工程。 */
  snapshot(): AutosaveSnapshot | null;
  /** 还有未保存改动吗？自动保存只写「脏」的工程（判据是内容版本，不含界面状态）。 */
  dirty(): boolean;
  /** 写正式工程（必须不轮转 `.bak`、不动 savedDocVersion）。失败要抛。 */
  writeFormal(snap: AutosaveSnapshot): Promise<void>;
  /** 写本地草稿。失败要抛。 */
  writeDraft(snap: AutosaveSnapshot): Promise<void>;
  /** 状态变化（界面同步用）。 */
  onStatus?(status: AutosaveStatus, detail?: string): void;
  /**
   * 现在方不方便写。返回 false 时本轮**跳过、不降级**，并在结束后重新排队。
   *
   * 唯一的使用者是「手动保存正在进行」：两者抢同一个 `project.json` 时，
   * 后到的会拿到 `NoModificationAllowedError`。把它当成写失败去降级是错的
   * —— 磁盘好得很，只是有人在前面用。
   */
  canWrite?(): boolean;
  /** 静默期。默认 2000 ms。 */
  delayMs?: number;
  /** 定时器注入（单测用假时钟，浏览器用全局 setTimeout）。 */
  timer?: AutosaveTimer;
}

export interface AutosaveTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: AutosaveTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Autosave {
  private readonly delayMs: number;
  private readonly timer: AutosaveTimer;

  private handle: unknown = null;
  private running = false;
  private again = false;
  private deferred = false;
  private cancelled = false;
  private disposed = false;
  private waiters: (() => void)[] = [];

  status: AutosaveStatus = 'idle';
  /** `degraded` / `error` 的原因（用户看得到的原始错误文本）。 */
  detail: string | null = null;

  constructor(private readonly deps: AutosaveDeps) {
    this.delayMs = deps.delayMs ?? 2000;
    this.timer = deps.timer ?? defaultTimer;
  }

  /**
   * 有一次「可能该保存」的变更。
   *
   * 防抖：每来一次就重置计时器（用户连续打字时不该每 2 s 写一次）。
   * 正在写时**不另起计时器**，只置 `again` —— 写完之后立刻用最新快照再写一次，
   * 这既是「合并后到请求」，也避免了「写入速度 < 变更速度」时的队列膨胀。
   */
  schedule(): void {
    if (this.disposed) return;
    if (!this.shouldWrite()) {
      this.cancel();
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.setStatus('pending');
    this.clearTimer();
    this.handle = this.timer.set(() => {
      this.handle = null;
      void this.run();
    }, this.delayMs);
  }

  /**
   * 手动保存前的「让路」：清掉排队中的自动保存，并置 `cancelled`
   * 让正在跑的那一轮**不再写第二遍**。调用方随后 `await idle()`。
   */
  cancel(): void {
    this.clearTimer();
    this.again = false;
    this.cancelled = true;
    if (!this.running && this.status === 'pending') this.setStatus('idle');
  }

  /** 等当前写入结束（没有在写就立刻返回）。手动保存用它排队。 */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 立即跑一轮（不防抖）。恢复草稿后「立刻把这份草稿重新落一遍」用它。 */
  async flushNow(): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    await this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  /* ------------------------------------------------------------ 内部 */

  private shouldWrite(): boolean {
    if (!this.deps.snapshot()) return false;
    return this.deps.dirty();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.deferred = false;
    try {
      do {
        this.again = false;
        const snap = this.deps.snapshot();
        if (!snap || !this.deps.dirty()) break;
        /*
         * 手动保存正在写同一个文件：让路，不写、不降级，等这一轮结束后
         * 重新排队。把它当成失败去写草稿会给出一个假的「降级」提示。
         */
        if (this.deps.canWrite && !this.deps.canWrite()) {
          this.deferred = true;
          break;
        }
        await this.write(snap);
      } while (this.again && !this.cancelled);
    } finally {
      this.running = false;
      if (this.deferred && !this.cancelled) this.schedule();
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async write(snap: AutosaveSnapshot): Promise<void> {
    this.setStatus('saving');
    let formalError: string | null = null;

    if (snap.formal) {
      try {
        await this.deps.writeFormal(snap);
        this.setStatus('saved');
        return;
      } catch (e) {
        formalError = errText(e);
      }
    }

    /*
     * 降级：正式目录写不进去（或本来就没有目录）→ 本地草稿。
     * 有目录却失败才叫「降级」，必须让用户知道磁盘上的工程不是最新的。
     */
    try {
      await this.deps.writeDraft(snap);
      if (formalError) this.setStatus('degraded', formalError);
      else this.setStatus('saved');
    } catch (e) {
      const draftError = errText(e);
      this.setStatus('error', formalError ? `${formalError} / ${draftError}` : draftError);
    }
  }

  private setStatus(status: AutosaveStatus, detail?: string): void {
    this.status = status;
    this.detail = status === 'degraded' || status === 'error' ? (detail ?? this.detail) : null;
    this.deps.onStatus?.(status, this.detail ?? undefined);
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.timer.clear(this.handle);
    this.handle = null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
