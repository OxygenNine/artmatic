import { describe, expect, it } from 'vitest';
import { SuspendGate } from '../../src/agent/llm/suspend-gate';

/**
 * 挂起闸门是「切工程不掐断 Agent 任务」的唯一实现细节，所以它自己要钉住：
 * 关着时**必须**停住（否则工具会写进另一份工程），开闸 / 取消都必须
 * **立刻**把等待者放出来（否则停止按钮会失灵）。
 */
describe('SuspendGate', () => {
  it('开着时 wait 是空操作', async () => {
    const gate = new SuspendGate();
    const ctrl = new AbortController();
    await gate.wait(ctrl.signal);
    expect(gate.suspended).toBe(false);
    expect(gate.waiting).toBe(0);
  });

  it('关着时 wait 挂起，open 之后返回', async () => {
    const gate = new SuspendGate();
    const ctrl = new AbortController();
    gate.close();
    let done = false;
    const p = gate.wait(ctrl.signal).then(() => (done = true));
    // 一个微任务之后仍然挂着 —— 这正是「任务停在检查点」的形态。
    await Promise.resolve();
    expect(done).toBe(false);
    expect(gate.waiting).toBe(1);
    gate.open();
    await p;
    expect(done).toBe(true);
    expect(gate.waiting).toBe(0);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('等待中取消也立刻返回，由调用方看 aborted 决定抛什么', async () => {
    const gate = new SuspendGate();
    const ctrl = new AbortController();
    gate.close();
    const p = gate.wait(ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    await p;
    expect(ctrl.signal.aborted).toBe(true);
    // 闸门本身不变：任务是被取消的，不是被放行的。
    expect(gate.suspended).toBe(true);
    expect(gate.waiting).toBe(0);
  });

  it('多个等待者一起被唤醒（父会话 + 子代理）', async () => {
    const gate = new SuspendGate();
    const a = new AbortController();
    const b = new AbortController();
    gate.close();
    const pa = gate.wait(a.signal);
    const pb = gate.wait(b.signal);
    await Promise.resolve();
    expect(gate.waiting).toBe(2);
    gate.open();
    await Promise.all([pa, pb]);
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
  });

  it('close / open 幂等，重复 open 不会重复唤醒', async () => {
    const gate = new SuspendGate();
    const ctrl = new AbortController();
    gate.open(); // 本来就开着
    gate.close();
    gate.close();
    expect(gate.suspended).toBe(true);
    const p = gate.wait(ctrl.signal);
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    gate.open();
    gate.open();
    await p;
    expect(gate.suspended).toBe(false);
    expect(gate.waiting).toBe(0);
  });

  it('已取消的信号在关着的闸门上不会留下等待者', async () => {
    const gate = new SuspendGate();
    const ctrl = new AbortController();
    ctrl.abort();
    gate.close();
    // 已经中止：不等，直接把控制权交回调用方（它会在下一行抛 cancelled）。
    await gate.wait(ctrl.signal);
    expect(gate.waiting).toBe(0);
  });
});
