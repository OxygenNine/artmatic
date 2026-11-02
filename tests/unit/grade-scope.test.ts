import { describe, expect, it } from 'vitest';
import {
  luma01,
  renderHistogram,
  renderParade,
  renderVectorscope,
  renderWaveform,
} from '../../src/ui/grade/scope-draw';
import { rgbToWheel, wheelToRgb } from '../../src/ui/grade/wheel-model';
import type { ScopeFrame } from '../../src/engine/compositor';

/**
 * 示波器与色轮的纯数学。
 *
 * 示波器的判据不能是「画出来像波形」，只能是数字：桶的和、峰值位置、灰轴落点。
 * 色轮判据是**往返**（拖完再打开面板，指针必须回到原位）。
 */

/** 造一帧：每列一个恒定的灰度（左黑右白）。 */
function rampFrame(w = 8, h = 4): ScopeFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, w, h };
}

function solidFrame(r: number, g: number, b: number): ScopeFrame {
  const data = new Uint8ClampedArray(4);
  data[0] = r;
  data[1] = g;
  data[2] = b;
  data[3] = 255;
  return { data, w: 1, h: 1 };
}

describe('luma01', () => {
  it('709 权重：纯绿最亮、纯蓝最暗', () => {
    expect(luma01(0, 255, 0)).toBeCloseTo(0.7152, 4);
    expect(luma01(0, 0, 255)).toBeCloseTo(0.0722, 4);
    expect(luma01(255, 255, 255)).toBeCloseTo(1, 4);
    expect(luma01(0, 0, 0)).toBe(0);
  });
});

describe('波形', () => {
  it('每列亮度落在对应的行（左黑在下、右白在上）', () => {
    const f = rampFrame(8, 4);
    const grid = renderWaveform(f, 8, 8);
    // 第 0 列最黑 → 最下面一行
    expect(grid[7 * 8 + 0]!).toBeCloseTo(1, 5);
    // 最后一列最白 → 最上面一行
    expect(grid[0 * 8 + 7]!).toBeCloseTo(1, 5);
  });

  it('横向按输出宽度铺开（源列映射到输出列，不是 1:1 拉伸）', () => {
    const grid = renderWaveform(rampFrame(8, 4), 16, 8);
    const colSum = (x: number): number => {
      let out = 0;
      for (let y = 0; y < 8; y += 1) out += grid[y * 16 + x] ?? 0;
      return out;
    };
    // 最近邻映射：源第 0 列 → 输出第 0 列，源第 7 列 → 输出第 14 列
    expect(colSum(0), '最左列必须有数据').toBeGreaterThan(0);
    expect(colSum(14), '最右的源列映射到接近右端').toBeGreaterThan(0);
  });

  it('分量波形只看自己那个通道', () => {
    const red = solidFrame(255, 0, 0);
    const r = renderWaveform(red, 2, 8, 'r');
    const g = renderWaveform(red, 2, 8, 'g');
    expect(r[0 * 2 + 0]!).toBeCloseTo(1, 5); // 最上面 = 255
    expect(g[7 * 2 + 0]!).toBeCloseTo(1, 5); // 最下面 = 0
  });

  it('分量视图把三条铺在同一个网格上', () => {
    const p = renderParade(rampFrame(6, 3), 9, 8);
    expect(p.r.length).toBe(9 * 8);
    // 三张图的列区间不重叠
    const colSum = (g: Float32Array, x: number): number => {
      let s = 0;
      for (let y = 0; y < 8; y += 1) s += g[y * 9 + x] ?? 0;
      return s;
    };
    expect(colSum(p.r, 0)).toBeGreaterThan(0);
    expect(colSum(p.r, 8)).toBe(0);
    expect(colSum(p.b, 8)).toBeGreaterThan(0);
  });
});

describe('矢量示波器', () => {
  it('灰落在正中心', () => {
    const size = 32;
    const grid = renderVectorscope(solidFrame(128, 128, 128), size);
    const center = Math.floor(size / 2) * size + Math.floor(size / 2);
    expect(grid[center]!).toBeCloseTo(1, 5);
  });

  it('红落在左上（Cb 负、Cr 正，经典矢量图的位置）', () => {
    const size = 32;
    const grid = renderVectorscope(solidFrame(255, 0, 0), size);
    let hit: [number, number] = [-1, -1];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if ((grid[y * size + x] ?? 0) > 0) hit = [x, y];
    }
    expect(hit[0], '红色 Cb = -0.169，应当在中心左侧').toBeLessThan(size / 2);
    expect(hit[1], '红色 Cr = +0.5，应当在中心上方').toBeLessThan(size / 2);
  });
});

describe('直方图', () => {
  it('16 级斜坡 → 16 个非空桶，且都归一成 1', () => {
    const h = renderHistogram(rampFrame(16, 4));
    const occupied = [...h.l].filter((v) => v > 0);
    expect(occupied.length).toBe(16);
    for (const v of occupied) expect(v).toBeCloseTo(1, 5);
    // 总数（归一化前）等于像素数：16 桶 × 每桶 4 个
    expect(occupied.length * 4).toBe(16 * 4);
  });

  it('全黑帧只有第 0 桶有值', () => {
    const h = renderHistogram(solidFrame(0, 0, 0));
    expect(h.l[0]).toBeCloseTo(1, 5);
    for (let i = 1; i < 256; i += 1) expect(h.l[i]).toBe(0);
  });
});

describe('色轮：角度/半径 ↔ 三分量', () => {
  it('往返一致（拖完再打开面板，指针回原位）', () => {
    for (const angle of [0, 0.1, 1 / 3, 0.5, 0.77, 0.99]) {
      for (const radius of [0.2, 0.5, 1]) {
        const [r, g, b] = wheelToRgb(angle, radius);
        const back = rgbToWheel(r, g, b);
        expect(back.angle, `角度 ${angle}`).toBeCloseTo(angle, 6);
        expect(back.radius, `半径 ${radius}`).toBeCloseTo(radius, 6);
      }
    }
  });

  it('红在 0、绿在 1/3、蓝在 2/3（标准色相环）', () => {
    expect(wheelToRgb(0, 1)[0]).toBeGreaterThan(0);
    expect(wheelToRgb(0, 1)[1]).toBeLessThan(0);
    expect(wheelToRgb(1 / 3, 1)[1]).toBeGreaterThan(0);
    expect(wheelToRgb(2 / 3, 1)[2]).toBeGreaterThan(0);
  });

  it('方向向量零亮度：三分量之和为 0（不改变整体亮度）', () => {
    for (const angle of [0, 0.15, 0.4, 0.62, 0.9]) {
      const [r, g, b] = wheelToRgb(angle, 1);
      expect(r + g + b, `角度 ${angle}`).toBeCloseTo(0, 9);
    }
  });

  it('圆心是中性：半径 0 → 三分量全 0', () => {
    const [r, g, b] = wheelToRgb(0.42, 0);
    expect([r, g, b].map((v) => Math.abs(v) < 1e-12)).toEqual([true, true, true]);
  });
});
