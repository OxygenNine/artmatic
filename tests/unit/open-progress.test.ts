/**
 * open-progress.test.ts — 打开工程时那条进度条的数值。
 *
 * 只钉**不变量**，不钉具体百分比：权重表本来就是粗估，改估算是允许的；
 * 真正会坏的是「倒着走」「换阶段先跳满」「超 100」这三件事 —— 它们在界面上
 * 都只表现为「条子抖了一下」，只有这里能抓到。
 */

import { describe, expect, it } from 'vitest';
import { OPEN_STEP_ORDER, openProgressPercent } from '../../src/ui/open-progress';
import type { OpenProgress, OpenStep } from '../../src/ui/app-state.svelte';

function at(step: OpenStep, done = 0, total = 0): OpenProgress {
  return { name: 'demo', step, done, total };
}

describe('openProgressPercent', () => {
  it('没有在打开时是 0', () => {
    expect(openProgressPercent(null)).toBe(0);
  });

  it('四个阶段的起点严格递增', () => {
    const starts = OPEN_STEP_ORDER.map((s) => openProgressPercent(at(s)));
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!, `${OPEN_STEP_ORDER[i]} 的起点必须大于前一个`).toBeGreaterThan(starts[i - 1]!);
    }
  });

  it('total 为 0 时停在阶段起点，不许当成「已完成」', () => {
    // 把 total=0 算成 1/1 的写法会让条子在每次换阶段时先跳满再退回来。
    expect(openProgressPercent(at('assets', 0, 0))).toBeLessThan(
      openProgressPercent(at('assets', 1, 1)),
    );
    // 也不能推进到下一个阶段的起点去。
    expect(openProgressPercent(at('assets', 0, 0))).toBeLessThan(
      openProgressPercent(at('finalize', 0, 0)),
    );
  });

  it('同一阶段内按件数推进', () => {
    const a = openProgressPercent(at('assets', 10, 100));
    const b = openProgressPercent(at('assets', 90, 100));
    expect(b).toBeGreaterThan(a);
  });

  it('不越过 100，也不越过所在阶段的终点', () => {
    expect(openProgressPercent(at('finalize', 1, 1))).toBeLessThanOrEqual(100);
    // 件数超过 total（素材清单与实际不符时会发生）只钳到阶段终点。
    expect(openProgressPercent(at('assets', 200, 96))).toBe(
      openProgressPercent(at('assets', 96, 96)),
    );
  });

  it('一次真实的打开：全序列单调不减', () => {
    const seq = [
      at('read'),
      at('plugins'),
      at('assets', 0, 96),
      at('assets', 48, 96),
      at('assets', 96, 96),
      at('finalize'),
    ].map(openProgressPercent);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!, `第 ${i} 步倒退了：${seq.join(' → ')}`).toBeGreaterThanOrEqual(seq[i - 1]!);
    }
  });
});
