/**
 * extrude-trace.test.ts — `three-programs/extrude-three.js` 里那几个**纯函数**。
 *
 * 这一段是真几何的地基：轮廓错了不会报错，只会得到一块形状怪 / 洞变成实心 /
 * 侧壁朝里（背面剔除之后侧面是一个个空洞）的立体件。而它跑的是 raw 文本
 * （`new Function` 执行），没有类型检查，所以只能靠这里钉住。
 *
 * 只测不依赖 DOM 的部分：`traceMask`（二值掩码 → 闭合折线）、
 * `shapesFromLoops`（折线 → 层序 + 朝向 + 归一化）、`emblemLoops`。
 * `traceImage` 要 canvas，留给实跑。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CODE = readFileSync(
  new URL('../../src/algos/three-programs/extrude-three.js', import.meta.url),
  'utf8',
);

/** 最小 THREE 替身：只需要 Vector2 / Shape / Path 三个容器。 */
const fakeTHREE = {
  Vector2: class Vector2 {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  Shape: class Shape {
    holes: unknown[] = [];
    constructor(public points: unknown[]) {}
  },
  Path: class Path {
    constructor(public points: unknown[]) {}
  },
};

interface Pt {
  x: number;
  y: number;
}
interface FakeShape {
  points: Pt[];
  holes: { points: Pt[] }[];
}

const api = new Function(
  'THREE',
  `${CODE}\n;return { traceMask: traceMask, shapesFromLoops: shapesFromLoops, emblemLoops: emblemLoops, polyArea: polyArea };`,
)(fakeTHREE) as {
  traceMask: (mask: Uint8Array, w: number, h: number) => number[][][];
  shapesFromLoops: (THREE: unknown, loops: number[][][]) => FakeShape[];
  emblemLoops: () => number[][][];
  polyArea: (pts: number[][]) => number;
};

/** `[x0, x1) × [y0, y1)` 填 1 的矩形掩码。 */
function rectMask(w: number, h: number, spec: { x0: number; y0: number; x1: number; y1: number }): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = spec.y0; y < spec.y1; y += 1) {
    for (let x = spec.x0; x < spec.x1; x += 1) m[x + y * w] = 1;
  }
  return m;
}

describe('traceMask：二值掩码 → 闭合折线', () => {
  it('一块实心矩形给出一个闭合环：尺寸对得上，四角各被切掉 0.5×0.5', () => {
    const loops = api.traceMask(rectMask(10, 10, { x0: 2, y0: 3, x1: 8, y1: 7 }), 10, 10);
    expect(loops).toHaveLength(1);
    const pts = loops[0]!;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // 6×4 的填色区 → 6×4 的轮廓（整体内缩半像素，见 traceMask 头注）
    expect(maxX - minX).toBeCloseTo(6, 6);
    expect(maxY - minY).toBeCloseTo(4, 6);
    // 面积 = 24 − 4 × (0.5×0.5/2)
    expect(Math.abs(api.polyArea(pts))).toBeCloseTo(23.5, 6);
  });

  it('空白掩码没有环；整幅填满的掩码有一个贴边的环', () => {
    expect(api.traceMask(new Uint8Array(8 * 8), 8, 8)).toHaveLength(0);
    const full = api.traceMask(new Uint8Array(6 * 6).fill(1), 6, 6);
    expect(full).toHaveLength(1);
    // 6×6 减去四角的切角（4 × 0.125）
    expect(Math.abs(api.polyArea(full[0]!))).toBeCloseTo(35.5, 6);
  });

  it('镂空给出两个环：外环与内环，且内环面积对应洞', () => {
    const mask = rectMask(14, 14, { x0: 2, y0: 2, x1: 12, y1: 12 });
    for (let y = 5; y < 9; y += 1) for (let x = 5; x < 9; x += 1) mask[x + y * 14] = 0;
    const loops = api.traceMask(mask, 14, 14);
    expect(loops).toHaveLength(2);
    const areas = loops.map((l) => Math.abs(api.polyArea(l))).sort((a, b) => b - a);
    // 外环内缩半像素（10×10 → 99.5），内环同样内缩 ⇒ 洞反而大 0.5
    expect(areas[0]).toBeCloseTo(99.5, 6);
    expect(areas[1]).toBeCloseTo(15.5, 6);
  });

  it('斜边不会自交（鞍点拆成两段）—— 一格宽的斜线给出一条闭合环', () => {
    const w = 12;
    const mask = new Uint8Array(w * w);
    for (let i = 0; i < w - 1; i += 1) {
      mask[i + 1 + i * w] = 1;
      mask[i + 1 + 1 + i * w] = 1;
    }
    const loops = api.traceMask(mask, w, w);
    expect(loops.length).toBeGreaterThan(0);
    for (const l of loops) expect(l.length).toBeGreaterThanOrEqual(4);
  });
});

describe('shapesFromLoops：层序、朝向与归一化', () => {
  it('外环是实体、内环变成洞，而且朝向相反（侧壁靠它朝向外面）', () => {
    const mask = rectMask(14, 14, { x0: 2, y0: 2, x1: 12, y1: 12 });
    for (let y = 5; y < 9; y += 1) for (let x = 5; x < 9; x += 1) mask[x + y * 14] = 0;
    const shapes = api.shapesFromLoops(fakeTHREE, api.traceMask(mask, 14, 14));
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.holes).toHaveLength(1);

    const outer = shapes[0]!.points.map((p) => [p.x, p.y]);
    const hole = shapes[0]!.holes[0]!.points.map((p) => [p.x, p.y]);
    expect(api.polyArea(outer)).toBeGreaterThan(0); // 逆时针
    expect(api.polyArea(hole)).toBeLessThan(0); // 顺时针
  });

  it('归一化：内容最长边 = 2，且以内容包围盒居中（不是以画面居中）', () => {
    // 靠左上角的一块矩形：归一化之后必须仍然居中于原点
    const shapes = api.shapesFromLoops(
      fakeTHREE,
      api.traceMask(rectMask(16, 16, { x0: 1, y0: 1, x1: 5, y1: 9 }), 16, 16),
    );
    expect(shapes).toHaveLength(1);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of shapes[0]!.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // 最长边 = 2（这条是 8 高 4 宽，所以宽度是 1）
    expect(Math.max(maxX - minX, maxY - minY)).toBeCloseTo(2, 6);
    expect(minX).toBeCloseTo(-0.5, 6);
    expect(Math.abs(minX + maxX)).toBeLessThan(1e-9);
    expect(Math.abs(minY + maxY)).toBeLessThan(1e-9);
  });
});

describe('emblemLoops：没绑素材时的占位图形', () => {
  it('三层深度：外牌 + 圆洞 + 星形实体', () => {
    const loops = api.emblemLoops();
    expect(loops).toHaveLength(3);
    const shapes = api.shapesFromLoops(fakeTHREE, loops);
    // 外牌与内部星形各是一个实体，圆环是外牌上的洞
    expect(shapes).toHaveLength(2);
    expect(shapes[0]!.holes).toHaveLength(1);
    expect(shapes.every((s) => s.points.length >= 3)).toBe(true);
  });
});
