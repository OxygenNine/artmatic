/**
 * suspend-gate.ts — 「这一轮先别动工程」的闸门。
 *
 * ## 它解决的问题
 *
 * Agent 一个工具循环里会反复「调模型 → 执行工具」。执行工具那一步改的是
 * **当前激活的工程**（控制平面是单实例、绑 `appState.activeProjectId`）。
 * 用户在任务跑到一半时切到另一份工程选项卡，属于**换工程容器**而不是
 * 取消任务 —— 但如果让它继续跑，下一步工具就会写进另一份工程里。
 *
 * 所以切走时不是 `abort()`（那会把已经花了钱的半轮扔掉），而是把闸门关上：
 * 循环会在**每一次模型调用之前**停在这里等，切回来再开闸继续。
 * 正在飞的那一个请求不打断 —— 让它自然结束，否则会白扔掉一段已经生成的回答。
 *
 * ## 边界
 *
 * - 闸门**只管「能不能继续跑」**，不认识工程、不认识 UI。谁在什么时候关它由
 *   `ui/agent/agent-state` 决定（它的 `park()` / `wake()`）。
 * - `wait()` 只在**循环的检查点**被 await，不持有任何锁，所以关闭期间主线程
 *   照常工作。
 * - `abort` 与开闸走同一条唤醒路径：被取消的会话必须在 `signal.aborted` 之后
 *   立刻抛出去，而不是等到用户切回来才肯收尾。
 */

export class SuspendGate {
  private closed = false;
  /** 正在等开闸的会话（通常是父会话一棵子树，各有一条）。 */
  private waiters = new Set<() => void>();

  /** 关着 = 现在不许推进工具循环。 */
  get suspended(): boolean {
    return this.closed;
  }

  /** 有几个会话正卡在这里（UI 用来显示「已暂停」的强度，不是必须）。 */
  get waiting(): number {
    return this.waiters.size;
  }

  /** 关闸。幂等 —— 同一个会话可能被连续 park 两次（切走再切走）。 */
  close(): void {
    this.closed = true;
  }

  /** 开闸并唤醒所有等待者。唤醒后它们自己会重新检查 `closed` 与 `signal`。 */
  open(): void {
    if (!this.closed) return;
    this.closed = false;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /**
   * 关着就等到开闸或被取消。
   *
   * 返回之后**调用方必须自己检查 `signal.aborted`** —— 这里不抛异常，是为了
   * 让 session 决定抛什么（它要用自己的 `LlmError('cancelled')` 文案与收尾流程）。
   */
  wait(signal: AbortSignal): Promise<void> {
    if (!this.closed || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        signal.removeEventListener('abort', wake);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}
