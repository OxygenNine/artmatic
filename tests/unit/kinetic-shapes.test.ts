import { describe, expect, it } from 'vitest';
import {
  ANIM_TABLE,
  KS_ANIM_KEYS,
  KS_MAX_SHAPES,
  kineticShapesDef,
  layoutOf,
} from '../../src/algos/kinetic-shapes';
import type { SelectParam } from '../../src/effects/types';

/**
 * 跃动几何的两处纯逻辑。
 *
 * 它们在 shader 里都**没有守卫**：
 *
 * 1. `layoutOf` 的结果直接决定 `u_count` / `u_cols` / `u_rows` / `u_cell`。
 *    算错一格，画面不会报错 —— 只会「最后一列形状消失」（数量被循环上界截断）
 *    或者「格子被拉成长条」（行数没按宽高比取）。
 * 2. `ANIM_TABLE` 缺一条时，`setUniforms` 回落到硬切：**选项还在、拖了没反应**。
 *    这就是本项目最不能接受的失效形态，而它恰好只在选项表与映射表各写一份时出现。
 */

const animOptionsOf = (key: string): string[] => {
  const p = kineticShapesDef.params.find((q) => q.key === key);
  expect(p, `缺少参数 ${key}`).toBeDefined();
  expect(p!.type, `${key} 应当是 select`).toBe('select');
  return (p as SelectParam).options.map((o) => o.value);
};

describe('layoutOf：布局派生量', () => {
  it('网格的行列乘积就是形状数（不留半截行）', () => {
    for (const density of [1, 2, 3, 5, 6, 9, 12, 16]) {
      for (const aspect of [16 / 9, 4 / 3, 1, 9 / 16, 21 / 9]) {
        const lay = layoutOf('grid', density, aspect);
        expect(lay.cols * lay.rows, `density=${density} aspect=${aspect}`).toBe(lay.count);
        expect(lay.cell).toBeGreaterThan(0);
      }
    }
  });

  it('数量永远不超过循环上界（超出的形状渲不出来）', () => {
    for (const layout of ['grid', 'scatter', 'random']) {
      for (const aspect of [0.4, 1, 16 / 9, 3]) {
        const lay = layoutOf(layout, 16, aspect);
        expect(lay.count, `${layout} @ ${aspect}`).toBeLessThanOrEqual(KS_MAX_SHAPES);
        expect(lay.count).toBeGreaterThan(0);
      }
    }
  });

  it('横屏与竖屏都得到「接近正方」的格子', () => {
    /*
     * 判据是宽高比：格子的长边 / 短边不该超过 2。
     * 写死 cols=rows 的实现在 16:9 上是 1.78，正好被这条挡下。
     */
    for (const aspect of [16 / 9, 4 / 3, 1, 9 / 16]) {
      const lay = layoutOf('grid', 6, aspect);
      const w = aspect / lay.cols;
      const h = 1 / lay.rows;
      const ratio = Math.max(w, h) / Math.min(w, h);
      expect(ratio, `aspect=${aspect} 的格子被拉长：${w.toFixed(3)}×${h.toFixed(3)}`).toBeLessThan(2);
    }
  });

  it('random 的形状数是密度²（每轴的密度），按面积开方给格边长', () => {
    const lay = layoutOf('random', 6, 16 / 9);
    expect(lay.count).toBe(36);
    expect(lay.cell).toBeCloseTo(Math.sqrt((16 / 9) / 36), 6);
  });

  it('密度越界 / 非数字一律收口，不抛也不产生 0 个形状', () => {
    expect(layoutOf('grid', 0, 16 / 9).count).toBeGreaterThan(0);
    expect(layoutOf('grid', 99, 16 / 9).count).toBeLessThanOrEqual(KS_MAX_SHAPES);
    expect(layoutOf('grid', Number.NaN, 16 / 9).count).toBeGreaterThan(0);
    expect(layoutOf('grid', 6, 0).cell).toBeGreaterThan(0);
    // 认不出的布局（老工程）按网格算，而不是给出 0 个形状的黑屏
    expect(layoutOf('no-such-layout', 6, 16 / 9).count).toBeGreaterThan(0);
  });
});

describe('ANIM_TABLE：进出场动画映射', () => {
  it('进出场两张选项表的每个取值都有映射（缺一条 = 那个选项静默失效）', () => {
    for (const key of ['inMode', 'outMode']) {
      for (const value of animOptionsOf(key)) {
        expect(ANIM_TABLE[value], `${key} 的取值 ${value} 没有映射，会静默退回硬切`).toBeDefined();
      }
    }
  });

  it('映射表里没有选项表之外的孤儿键', () => {
    const known = new Set([...animOptionsOf('inMode')]);
    expect(KS_ANIM_KEYS.filter((k) => !known.has(k))).toEqual([]);
  });

  it('三个通道只取 0/1/2、0/1、0/1（着色器按这三个档位分支）', () => {
    for (const [k, v] of Object.entries(ANIM_TABLE)) {
      expect([0, 1, 2], `${k} 的缩放档`).toContain(v[0]);
      expect([0, 1], `${k} 的滑动通道`).toContain(v[1]);
      expect([0, 1], `${k} 的淡入淡出通道`).toContain(v[2]);
    }
  });

  it('默认的进场与出厂都要有实际动画（硬切不是缺省）', () => {
    const inMode = kineticShapesDef.params.find((p) => p.key === 'inMode')!;
    const outMode = kineticShapesDef.params.find((p) => p.key === 'outMode')!;
    expect(ANIM_TABLE[String(inMode.type === 'select' ? inMode.defaultValue : '')]).not.toEqual([0, 0, 0]);
    expect(ANIM_TABLE[String(outMode.type === 'select' ? outMode.defaultValue : '')]).not.toEqual([0, 0, 0]);
  });
});

describe('kinetic-shapes 的着色器约定', () => {
  it('#define KS_MAX 与 layoutOf 的上界同源', () => {
    expect(kineticShapesDef.kind).toBe('realtime');
    if (kineticShapesDef.kind !== 'realtime') return;
    expect(kineticShapesDef.fragment).toContain(`#define KS_MAX ${KS_MAX_SHAPES}`);
  });

  it('fragment 不含头（ALGO_HEAD 由运行时拼），也没有重复声明 u_time', () => {
    if (kineticShapesDef.kind !== 'realtime') return;
    expect(kineticShapesDef.fragment.includes('#version 300 es')).toBe(false);
    expect(/uniform\s+float\s+u_time\s*;/.test(kineticShapesDef.fragment)).toBe(false);
  });
});
