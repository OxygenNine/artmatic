import { describe, expect, it } from 'vitest';
import { Autosave, type AutosaveSnapshot, type AutosaveStatus, type AutosaveTimer } from '../../src/project/autosave';
import { memoryRoot, readTextIfExists, writeBytesAtomic, type FsDirHandle } from '../../src/project/fs';

/**
 * 自动保存的编排守卫：**防抖合并 / 单飞 / 手动优先 / 失败降级**。
 *
 * 全部走 `memoryRoot()`（真写文件，不是 mock）：这些行为出错时的形态都是
 * 「多写一次」或「少写一次」，只有真的落盘才看得出区别。
 *
 * 时钟是注入的假计时器：自动保存的判据是「等 2 秒之后发生什么」，
 * 用真时间会让这几条要么慢、要么不稳。
 */

class FakeTimer implements AutosaveTimer {
  private fn: (() => void) | null = null;
  private seq = 0;

  set(fn: () => void): unknown {
    this.fn = fn;
    this.seq += 1;
    return this.seq;
  }

  clear(): void {
    this.fn = null;
  }

  get pending(): boolean {
    return this.fn !== null;
  }

  fire(): void {
    const fn = this.fn;
    this.fn = null;
    fn?.();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  autosave: Autosave;
  timer: FakeTimer;
  root: ReturnType<typeof memoryRoot>;
  formalDir: FsDirHandle;
  draftDir: FsDirHandle;
  log: string[];
  statuses: AutosaveStatus[];
  failures: { formal: boolean; draft: boolean };
  /** 让下一次写入挂起（测单飞与手动优先）。 */
  gate: { promise: Promise<void>; resolve: () => void } | null;
  set(form: { name?: string; dirty?: boolean; hasProject?: boolean; ready?: boolean }): void;
}

async function harness(): Promise<Harness> {
  const root = memoryRoot();
  const formalDir = await root.openDir('formal', { create: true });
  const draftDir = await root.openDir('drafts', { create: true });
  const timer = new FakeTimer();
  const log: string[] = [];
  const statuses: AutosaveStatus[] = [];
  const failures = { formal: false, draft: false };

  let name = 'v1';
  let dirty = true;
  let hasProject = true;
  let ready = true;
  let gate: Harness['gate'] = null;

  const h: Harness = {
    autosave: null as unknown as Autosave,
    timer,
    root,
    formalDir,
    draftDir,
    log,
    statuses,
    failures,
    get gate() {
      return gate;
    },
    set(patch) {
      if (patch.name !== undefined) name = patch.name;
      if (patch.dirty !== undefined) dirty = patch.dirty;
      if (patch.hasProject !== undefined) hasProject = patch.hasProject;
      if (patch.ready !== undefined) ready = patch.ready;
    },
  };

  const deps = {
    snapshot: (): AutosaveSnapshot | null =>
      hasProject ? { key: 'k1', name, project: { name }, formal: true } : null,
    dirty: () => dirty,
    canWrite: () => ready,
    async writeFormal(snap: AutosaveSnapshot): Promise<void> {
      if (gate) await gate.promise;
      if (failures.formal) throw new Error('disk full');
      const project = snap.project as { name: string };
      await writeBytesAtomic(formalDir, 'project.json', JSON.stringify(project), { backup: null });
      log.push(`formal:${project.name}`);
    },
    async writeDraft(snap: AutosaveSnapshot): Promise<void> {
      if (failures.draft) throw new Error('opfs unavailable');
      await writeBytesAtomic(draftDir, `${snap.key}.json`, JSON.stringify(snap.project));
      log.push('draft');
    },
    onStatus: (s: AutosaveStatus) => statuses.push(s),
    delayMs: 2000,
    timer,
  };

  h.autosave = new Autosave(deps);
  // 暴露一个方便测试改写 gate 的入口（getter 只读，写入走这里）。
  (h as { armGate?: () => void }).armGate = () => {
    gate = deferred();
  };
  return h;
}

/** 把 `armGate` 的返回句柄拿回来（上面那层 getter 只是给断言用）。 */
function arm(h: Harness): void {
  (h as unknown as { armGate: () => void }).armGate();
}

describe('Autosave：防抖', () => {
  it('连续变更只写一次，且写的是最后一次的快照', async () => {
    const h = await harness();
    h.autosave.schedule();
    h.set({ name: 'v2' });
    h.autosave.schedule();
    h.set({ name: 'v3' });
    h.autosave.schedule();

    expect(h.log).toEqual([]);
    h.timer.fire();
    await h.autosave.idle();

    expect(h.log).toEqual(['formal:v3']);
    expect(JSON.parse((await readTextIfExists(h.formalDir, 'project.json'))!)).toEqual({ name: 'v3' });
  });

  it('不脏就不写（自动保存不该把干净工程再刷一遍）', async () => {
    const h = await harness();
    h.set({ dirty: false });
    h.autosave.schedule();
    expect(h.timer.pending).toBe(false);
    await h.autosave.flushNow();
    expect(h.log).toEqual([]);
  });

  it('没有工程时什么都不做', async () => {
    const h = await harness();
    h.set({ hasProject: false });
    h.autosave.schedule();
    expect(h.timer.pending).toBe(false);
  });
});

describe('Autosave：单飞与手动优先', () => {
  it('写入期间的新变更合并成**一次**后续写入', async () => {
    const h = await harness();
    arm(h);
    h.autosave.schedule();
    h.timer.fire(); // 第一次写入挂起在 gate 上
    await Promise.resolve();

    h.set({ name: 'v2' });
    h.autosave.schedule();
    h.set({ name: 'v3' });
    h.autosave.schedule();

    expect(h.log, '第一笔还没写完，不许并发第二笔').toEqual([]);
    h.gate!.resolve();
    await h.autosave.idle();

    // 两次 schedule 合并成一次：v2 被 v3 覆盖。
    expect(h.log).toEqual(['formal:v1', 'formal:v3']);
  });

  it('手动保存 cancel + idle 之后，自动保存不再补写第二笔', async () => {
    const h = await harness();
    arm(h);
    h.autosave.schedule();
    h.timer.fire();
    await Promise.resolve();

    h.set({ name: 'v2' });
    h.autosave.schedule(); // 置 again
    h.autosave.cancel(); // 手动保存插进来
    h.gate!.resolve();
    await h.autosave.idle();

    expect(h.log).toEqual(['formal:v1']);
  });

  it('flushNow 在写入进行中要等当前写入结束', async () => {
    const h = await harness();
    arm(h);
    h.autosave.schedule();
    h.timer.fire();
    await Promise.resolve();

    let settled = false;
    const flushing = h.autosave.flushNow().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    h.gate!.resolve();
    await flushing;
    expect(settled).toBe(true);
  });

  it('cancel 会清掉排队中的计时器', async () => {
    const h = await harness();
    h.autosave.schedule();
    expect(h.timer.pending).toBe(true);
    h.autosave.cancel();
    expect(h.timer.pending).toBe(false);
  });

  it('手动保存进行中（canWrite=false）→ 让路重排，不写、不降级', async () => {
    const h = await harness();
    h.set({ ready: false });
    h.autosave.schedule();
    h.timer.fire();
    await h.autosave.idle();

    expect(h.log).toEqual([]);
    expect(h.autosave.status).not.toBe('degraded');
    expect(h.autosave.status).not.toBe('error');
    // 结束后重新排队：等手动保存放行、再点一次计时器才真的写。
    expect(h.timer.pending).toBe(true);

    h.set({ ready: true, name: 'v2' });
    h.timer.fire();
    await h.autosave.idle();
    expect(h.log).toEqual(['formal:v2']);
  });
});

describe('Autosave：失败降级', () => {
  it('正式工程写失败 → 写草稿，状态 degraded 带原因', async () => {
    const h = await harness();
    h.failures.formal = true;
    h.autosave.schedule();
    h.timer.fire();
    await h.autosave.idle();

    expect(h.log).toEqual(['draft']);
    expect(h.autosave.status).toBe('degraded');
    expect(h.autosave.detail).toBe('disk full');
    expect(h.statuses).toContain('degraded');
    expect(JSON.parse((await readTextIfExists(h.draftDir, 'k1.json'))!)).toEqual({ name: 'v1' });
  });

  it('草稿也写失败 → error（而不是假装成功）', async () => {
    const h = await harness();
    h.failures.formal = true;
    h.failures.draft = true;
    h.autosave.schedule();
    h.timer.fire();
    await h.autosave.idle();

    expect(h.autosave.status).toBe('error');
    expect(h.autosave.detail).toContain('disk full');
    expect(h.autosave.detail).toContain('opfs');
  });
});
