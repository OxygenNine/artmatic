import { describe, expect, it } from 'vitest';
import {
  GRADE_DEF_PREFIX,
  gradePlan,
  gradePrecision,
  gradeTargetBytes,
  gradeTargetCount,
  isGradeDef,
  type GradeScanOp,
} from '../../src/core/grade';
import { buildStack } from '../../src/engine/stack';
import { createDemoProject } from '../../src/core/demo-project';
import { mbToBytes } from '../../src/core/capacity';

/**
 * 「这一帧要不要 16F 中间缓冲」的守卫。
 *
 * 两段：结构扫描（假 op 树，手写）与**真 op 树**（`buildStack` 跑开箱 demo），
 * 后者证明这套形状确实吃真实产物 —— `GradeScanOp` 是结构化最小接口，而
 * `RenderOp` 能不能赋值给它只有在真类型上才验得出来（类型层面的那条由 tsc 管）。
 */

const item = (defId: string, enabled?: boolean): { defId: string; enabled?: boolean } =>
  enabled === undefined ? { defId } : { defId, enabled };

const effectOp = (
  defIds: string[],
  extra: { scope?: GradeScanOp[]; bound?: string[] } = {},
): GradeScanOp => ({
  type: 'effect',
  clip: {
    chain: defIds.map((d) => item(d)),
    ...(extra.scope ? { scope: extra.scope } : {}),
  },
});

const sourceOp = (bound: string[] = []): GradeScanOp =>
  bound.length
    ? { type: 'source', source: { bound: [{ chain: bound.map((d) => item(d)) }] } }
    : { type: 'source' };

describe('grade 前缀', () => {
  it('只认 `grade-`（`gradebook` 不是调色模块）', () => {
    expect(isGradeDef('grade-basic')).toBe(true);
    expect(isGradeDef(`${GRADE_DEF_PREFIX}lut`)).toBe(true);
    expect(isGradeDef('gradebook')).toBe(false);
    expect(isGradeDef('bleach')).toBe(false);
  });
});

describe('gradePlan：按这一帧的 op 列表扫', () => {
  it('没有调色 → 什么都不要求', () => {
    expect(gradePlan([sourceOp(), effectOp(['bleach', 'glow'])])).toEqual({
      requested: false,
      chain: false,
      bound: false,
      depth: 0,
    });
  });

  it('主链里的调色 ⇒ chain', () => {
    const plan = gradePlan([sourceOp(), effectOp(['grade-basic'])]);
    expect(plan.requested).toBe(true);
    expect(plan.chain).toBe(true);
    expect(plan.bound).toBe(false);
  });

  it('禁用的调色实例不算（不占浮点预算，也不产生调色）', () => {
    const plan = gradePlan([{ type: 'effect', clip: { chain: [item('grade-basic', false)] } }]);
    expect(plan.requested).toBe(false);
  });

  it('绑定在片段上的调色 ⇒ bound（走 placement 之后的那条路）', () => {
    const plan = gradePlan([sourceOp(['grade-curves'])]);
    expect(plan.requested).toBe(true);
    expect(plan.chain).toBe(false);
    expect(plan.bound).toBe(true);
  });

  it('转场两侧的绑定链也算', () => {
    const plan = gradePlan([
      { type: 'transition', from: { bound: [{ chain: [item('grade-basic')] }] }, to: null },
    ]);
    expect(plan.bound).toBe(true);
  });

  it('作用域里嵌的调色也算 chain，并把深度记下来（每层一对组目标）', () => {
    const plan = gradePlan([effectOp(['bleach'], { scope: [effectOp(['grade-basic'])] })]);
    expect(plan.chain).toBe(true);
    expect(plan.depth).toBe(1);
  });

  it('作用域深度按最深的算，与有没有调色无关（组目标一定会分配）', () => {
    const plan = gradePlan([
      effectOp(['bleach'], { scope: [effectOp(['glow'], { scope: [effectOp(['grade-basic'])] })] }),
    ]);
    expect(plan.depth).toBe(2);
  });
});

describe('gradePlan：真 op 树（开箱 demo 加一条调色）', () => {
  it('demo 工程里没有调色 → requested 为假（不白花 2× 显存）', () => {
    const plan = gradePlan(buildStack(createDemoProject(), 1));
    expect(plan.requested).toBe(false);
  });
});

describe('预算：目标个数与字节', () => {
  const base = { requested: true, chain: false, bound: false, depth: 0 };

  it('主链 2 张、每层作用域再加 2 张、绑定链再加 3 张', () => {
    expect(gradeTargetCount({ ...base, chain: true })).toBe(2);
    expect(gradeTargetCount({ ...base, chain: true, depth: 1 })).toBe(4);
    expect(gradeTargetCount({ ...base, bound: true })).toBe(3);
    expect(gradeTargetCount({ ...base, chain: true, bound: true, depth: 2 })).toBe(9);
  });

  it('没有调色就不占（判定为 idle 时一个字节都不算）', () => {
    expect(gradeTargetCount({ ...base, requested: false, chain: true })).toBe(0);
  });

  it('1080p 一张 RGBA16F 是 15.8 MiB，7 张约 111 MiB', () => {
    const bytes = gradeTargetBytes({ ...base, chain: true, bound: true, depth: 1 }, 1920, 1080);
    expect(bytes / (1024 * 1024)).toBeCloseTo(111, 0);
  });
});

describe('gradePrecision：三种降级原因各自说得出口', () => {
  const plan = { requested: true, chain: true, bound: false, depth: 0 };
  const budget = mbToBytes(384);

  it('没有调色 → idle（不是降级）', () => {
    expect(gradePrecision({ ...plan, requested: false }, 1920, 1080, budget, true)).toEqual({
      float: false,
      reason: 'idle',
    });
  });

  it('设备没有浮点渲染目标 → no-float', () => {
    expect(gradePrecision(plan, 1920, 1080, budget, false)).toEqual({
      float: false,
      reason: 'no-float',
    });
  });

  it('预算不够 → over-budget（不悄悄降精度，也不悄悄超支）', () => {
    expect(gradePrecision(plan, 3840, 2160, mbToBytes(32), true).reason).toBe('over-budget');
  });

  it('都满足 → ok', () => {
    expect(gradePrecision(plan, 1920, 1080, budget, true)).toEqual({ float: true, reason: 'ok' });
  });

  it('设备能力优先于预算：没浮点时不看预算也报 no-float', () => {
    expect(gradePrecision(plan, 3840, 2160, mbToBytes(32), false).reason).toBe('no-float');
  });
});
