/**
 * logo-sdf.test.ts — 距离场生成器的契约守卫。
 *
 * 这一层的错误形态**极其温和**：距离算偏 5%，轮廓只是略胖一圈、倒角略粗一点，
 * 没人能靠肉眼判定；而行数算反了，整张标牌上下颠倒，看起来像「贴图没对上」。
 * 两条都只能靠比对。
 *
 * 所以判据全部对着**独立的暴力实现**：精确 EDT 对暴力最小距离，方向对
 * 「这块墨在图像的哪一半」，比例对「长边固定为 2 世界单位」。
 */

import { describe, expect, it } from 'vitest';
import {
  FIELD_MAX_SIDE,
  FIELD_PAD,
  alphaFromRgba,
  buildLogoField,
  edt2dSquared,
  placeholderBitmap,
  type AlphaBitmap,
} from '../../src/algos/logo-sdf';

/** 造一张小掩码：`ink(x, y)` 返回该像素是否算墨（x/y 自左上角算）。 */
function mask(w: number, h: number, ink: (x: number, y: number) => boolean): AlphaBitmap {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = ink(x, y) ? 255 : 0;
  }
  return { data, w, h };
}

/** 暴力平方距离（对照用，O(n·m)）。 */
function bruteSquared(binary: Uint8Array, w: number, h: number, target: boolean): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if ((binary[j * w + i] !== 0) !== target) continue;
          const d = (i - x) * (i - x) + (j - y) * (j - y);
          if (d < best) best = d;
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

describe('精确 EDT', () => {
  const w = 23;
  const h = 17;
  const binary = new Uint8Array(w * h);
  // 一条斜线 + 一个孤点：足以让下界包络出现弹出与多段
  for (let i = 0; i < 12; i++) binary[(3 + i) * w + (2 + i)] = 1;
  binary[14 * w + 20] = 1;

  it.each([true, false])('可分离变换等于暴力最小距离（target=%s）', (target) => {
    const got = edt2dSquared(binary, w, h, target);
    const want = bruteSquared(binary, w, h, target);
    for (let i = 0; i < got.length; i++) {
      // 平方距离是整数，要求逐点相等（不是「差不多」）
      expect(got[i], `像素 ${i} 的平方距离`).toBe(want[i]);
    }
  });
});

describe('有符号距离场', () => {
  /** 32×32 的正中正方形：内容区与图像同大，所以字段里正好的位置是可算的。 */
  const bmp = mask(32, 32, (x, y) => x >= 10 && x < 22 && y >= 10 && y < 22);

  it('内容区按长边归一到 2 世界单位', () => {
    const f = buildLogoField(bmp);
    expect(Math.max(f.contentW, f.contentH)).toBe(32);
    expect(f.contentW).toBe(32);
    expect(f.contentH).toBe(32);
    // 长边 = 2 世界单位 ⇒ 1 texel = 2 / 32
    expect(f.texel).toBeCloseTo(2 / 32, 12);
    expect(f.w).toBe(32 + FIELD_PAD * 2);
    expect(f.h).toBe(32 + FIELD_PAD * 2);
  });

  it('直线边界处的幅度是精确像素距离（平滑核精确保留线性场）', () => {
    // 一条贯穿全高的竖直线：边界两侧的场是线性的，平滑不会改动它
    const half = mask(64, 64, (x) => x >= 32);
    const f = buildLogoField(half);
    const at = (tx: number, ty: number): number => f.data[(FIELD_PAD + ty) * f.w + FIELD_PAD + tx]!;
    // 边界落在 texel 31 与 32 之间 ⇒ 两侧中心各半格
    expect(at(31, 32)).toBeCloseTo(0.5, 6);
    expect(at(32, 32)).toBeCloseTo(-0.5, 6);
    expect(at(25, 32)).toBeCloseTo(6.5, 6);
    expect(at(40, 32)).toBeCloseTo(-8.5, 6);
  });

  it('内部为负、外部为正；幅度在平滑预算（≈1 texel）之内', () => {
    const f = buildLogoField(bmp);
    const at = (tx: number, ty: number): number => f.data[(FIELD_PAD + ty) * f.w + FIELD_PAD + tx]!;
    /*
     * 方块中心到边界 6 像素，但那里正是距离场的**中轴**（两侧边界的等距点），
     * 二阶导在这一点上不连续 —— 一次 `[1,4,6,4,1]` 平滑会把尖顶压圆约一格，
     * 数值因此从 -5.5 抬到 -4.8 左右。这是**低估**（|∇d| < 1），对步进安全；
     * 而且它是平滑这一步的固有代价，不是算错。所以判据取 1 texel 的预算。
     */
    const centre = at(16, 16);
    expect(centre).toBeLessThan(0);
    expect(centre).toBeGreaterThan(-6.5); // 真值 -5.5，平滑预算 1 texel
    expect(centre).toBeLessThan(-4.5);
    expect(at(10, 16)).toBeLessThan(0);
    expect(at(7, 16)).toBeGreaterThan(0);
    // 留白角上是**真实**的对角距离，不钳到 PAD（留白是余量，不是饱和值）
    const corner = f.data[0]!; // 纹理左下角 = 留白角落
    expect(corner).toBeGreaterThan(FIELD_PAD);
    const diag = Math.hypot(FIELD_PAD + 10, FIELD_PAD + 10) - 0.5;
    expect(Math.abs(corner - diag)).toBeLessThan(1); // 同样受平滑预算约束
  });

  it('行序是「第 0 行 = 图像底部」（源图第 0 行是顶部）', () => {
    // 只有上半部分有墨
    const top = mask(16, 16, (_x, y) => y < 6);
    const f = buildLogoField(top);
    const rowBottom = FIELD_PAD;
    const rowTop = FIELD_PAD + 16 - 1;
    const insideNearTop = f.data[rowTop * f.w + FIELD_PAD + 8]!;
    const insideNearBottom = f.data[rowBottom * f.w + FIELD_PAD + 8]!;
    expect(insideNearTop).toBeLessThan(0);
    expect(insideNearBottom).toBeGreaterThan(0);
  });

  it('缩小时做区域平均，不是最近邻（棋盘格应被平均成背景）', () => {
    /* 精确 2 倍缩小：FIELD_MAX_SIDE 是 768，输入 1536 正好缩放 0.5，于是每个
       输出 texel 覆盖一个完整的 2×2 源块。棋盘的每块平均下来恰好 127.5，
       二值化后应当**全是背景**；而最近邻会取到 (2x, 2y)，得到一个规则的棋盘
       —— 一半的 texel 变成墨。这条是两种采样方式唯一不会碰巧一致的判据。 */
    const size = FIELD_MAX_SIDE * 2;
    const checker = mask(size, size, (x, y) => (x + y) % 2 === 0);
    const f = buildLogoField(checker);
    expect(f.contentW).toBe(FIELD_MAX_SIDE);
    let ink = 0;
    for (let y = 0; y < f.contentH; y++) {
      const row = (FIELD_PAD + y) * f.w + FIELD_PAD;
      for (let x = 0; x < f.contentW; x++) if (f.data[row + x]! < 0) ink += 1;
    }
    expect(ink, '棋盘格被逐像素取样了（最近邻），不是区域平均').toBe(0);
  });

  it('超过最长边的图按比例缩下来', () => {
    const wide = mask(FIELD_MAX_SIDE * 2, FIELD_MAX_SIDE, (x, y) => x > 100 && y > 100);
    const f = buildLogoField(wide);
    expect(Math.max(f.contentW, f.contentH)).toBe(FIELD_MAX_SIDE);
    // 2:1 的图缩下来仍是 2:1（允许 1 texel 的取整误差）
    expect(Math.abs(f.contentW - f.contentH * 2)).toBeLessThanOrEqual(1);
  });
});

describe('素材适配', () => {
  const rgba = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = f(x, y);
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return data;
  };

  it('有透明通道就用 alpha', () => {
    const w = 10;
    const data = rgba(w, 10, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const bmp = alphaFromRgba(data, w, 10);
    expect(bmp.data[0]).toBe(255);
    expect(bmp.data[9]).toBe(0);
  });

  it('全不透明时退到亮度：黑字白底 ⇒ 墨是暗的', () => {
    const w = 10;
    const data = rgba(w, 10, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const bmp = alphaFromRgba(data, w, 10);
    expect(bmp.data[0]).toBe(255);
    expect(bmp.data[9]).toBe(0);
  });

  it('全不透明时退到亮度：白字黑底 ⇒ 墨是亮的（不能按「暗即墨」写死）', () => {
    const w = 10;
    const data = rgba(w, 10, (x) => (x < 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const bmp = alphaFromRgba(data, w, 10);
    expect(bmp.data[0]).toBe(255);
    expect(bmp.data[9]).toBe(0);
  });
});

describe('占位轮廓', () => {
  it('外框是一条闭合的细笔画，中间是空的', () => {
    const bmp = placeholderBitmap(128);
    expect(bmp.data.some((v) => v > 128)).toBe(true);
    const f = buildLogoField(bmp);
    const at = (nx: number, ny: number): number => {
      // 归一化 [-1,1]（y 向上）→ texel
      const tx = Math.round(((nx + 1) / 2) * f.contentW);
      const ty = Math.round(((ny + 1) / 2) * f.contentH);
      return f.data[(FIELD_PAD + ty) * f.w + FIELD_PAD + tx]!;
    };
    // 外框笔画的中线（0.84）上是墨；画面右上方是空的（山只占下半与中间）
    expect(at(0, 0.84)).toBeLessThan(0);
    expect(at(0.55, 0.55)).toBeGreaterThan(0);
    // 太阳（左上，y 向上）与山（下方）都是墨
    expect(at(-0.3, 0.34)).toBeLessThan(0);
    expect(at(0.1, -0.5)).toBeLessThan(0);
  });
});
