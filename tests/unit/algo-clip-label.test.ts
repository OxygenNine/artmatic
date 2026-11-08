/**
 * 生成器片段的名字（`algos/clip-label.ts`）。
 *
 * 判据只有一条：**用户改过名就不再动它**。所以这里钉的是边界：
 *  - 「默认」必须同时认**当前语言的译名**与**生成器 id**（agent 建片段写的是 id，
 *    `agent/clip-factory.ts` 刻意不给模型塞译文）；
 *  - 别的生成器的默认名**不算**默认（那是用户从别处搬过来的名字）；
 *  - 空串、带空白的名字都算「改过」。
 *
 * 判错了的形态是静默的：要么用户起的名字被算法名覆盖，要么换了算法名字停在旧算法上。
 */

import { describe, expect, it } from 'vitest';
import {
  defaultAlgoLabel,
  isDefaultAlgoLabel,
  labelAfterGeneratorChange,
} from '../../src/algos/clip-label';
import { tr } from '../../src/i18n/index.svelte';

const OLD = 'rule110';
const NEXT = 'mandelbrot';

describe('defaultAlgoLabel', () => {
  it('内置生成器 = 当前语言下的 def 名', () => {
    expect(defaultAlgoLabel(OLD, tr)).toBe(tr('algo.rule110'));
    expect(defaultAlgoLabel(NEXT, tr)).toBe(tr('algo.mandelbrot'));
    // 两个默认名必须真的不同，否则下面的「别的生成器的默认名不算默认」测了个寂寞
    expect(defaultAlgoLabel(OLD, tr)).not.toBe(defaultAlgoLabel(NEXT, tr));
  });

  it('找不到 def（插件被卸 / 手改过的工程）时退回 id，不给空串', () => {
    expect(defaultAlgoLabel('no-such-generator', tr)).toBe('no-such-generator');
  });
});

describe('isDefaultAlgoLabel', () => {
  it('译名与 id 两种默认都认', () => {
    expect(isDefaultAlgoLabel(OLD, tr('algo.rule110'), tr)).toBe(true);
    expect(isDefaultAlgoLabel(OLD, OLD, tr)).toBe(true);
  });

  it('别的生成器的默认名不算（名字被搬过来过）', () => {
    expect(isDefaultAlgoLabel(OLD, tr('algo.mandelbrot'), tr)).toBe(false);
  });

  it('用户起的名字（含空串 / 带空白）一律算改过名', () => {
    expect(isDefaultAlgoLabel(OLD, '片头', tr)).toBe(false);
    expect(isDefaultAlgoLabel(OLD, '', tr)).toBe(false);
    expect(isDefaultAlgoLabel(OLD, ` ${tr('algo.rule110')}`, tr)).toBe(false);
  });
});

describe('labelAfterGeneratorChange', () => {
  it('默认名跟着换成新生成器的默认名（译名与 id 两种起点都行）', () => {
    expect(labelAfterGeneratorChange(OLD, tr('algo.rule110'), NEXT, tr)).toBe(tr('algo.mandelbrot'));
    expect(labelAfterGeneratorChange(OLD, OLD, NEXT, tr)).toBe(tr('algo.mandelbrot'));
  });

  it('改过名的片段原样保留', () => {
    expect(labelAfterGeneratorChange(OLD, '我的片头', NEXT, tr)).toBe('我的片头');
  });

  it('换回原生成器时也成立（不是一次性匹配）', () => {
    expect(labelAfterGeneratorChange(NEXT, tr('algo.mandelbrot'), OLD, tr)).toBe(tr('algo.rule110'));
  });
});
