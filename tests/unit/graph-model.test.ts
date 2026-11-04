import { describe, expect, it } from 'vitest';
import {
  clearNode,
  inAnchor,
  layoutGraph,
  moveSubtree,
  nodeSize,
  outAnchor,
  pathKey,
  wirePath,
} from '../../src/ui/modulator/graph-model';
import { parseCached, printExpr, slotCount, slotAt } from '../../src/core/expr';
import type { ExprNode } from '../../src/core/expr';

function ast(src: string): ExprNode {
  const r = parseCached(src);
  if (!r.ok) throw new Error(`parse failed: ${src}`);
  return r.ast;
}

describe('layoutGraph：分层布局', () => {
  const root = ast('sin(t * 2 * pi)');

  it('节点数 = AST 节点数，且路径唯一', () => {
    const g = layoutGraph(root);
    expect(g.nodes).toHaveLength(6);
    expect(new Set(g.nodes.map((n) => n.key)).size).toBe(6);
    // 根没有输出口可拖
    expect(g.nodes.filter((n) => n.root).map((n) => n.key)).toEqual(['']);
  });

  it('输入在左、输出在右：子节点整个落在父节点左侧', () => {
    const g = layoutGraph(root);
    const sin = g.byKey.get('')!;
    const mul = g.byKey.get('0')!;
    expect(mul.x + mul.w).toBeLessThanOrEqual(sin.x);
    // 导线朝右流：左端 x 小于右端 x。纵坐标**允许不同**（子树的头行没法和
    // 父节点的某一个输入行对齐 —— 节点高度是按行数定的，而子树可以更高；
    // 节点编辑器里导线因此是斜的，这正是贝塞尔存在的理由）。
    expect(inAnchor(sin, 0).x).toBeGreaterThan(outAnchor(mul).x);
    expect(outAnchor(mul).y).toBeGreaterThan(0);
  });

  it('兄弟节点竖直不重叠（同一父节点的两个输入口）', () => {
    const g = layoutGraph(root);
    const outer = g.byKey.get('0')!;
    const left = g.byKey.get('0.0')!; // t * 2
    const right = g.byKey.get('0.1')!; // pi
    expect(left.y + left.h).toBeLessThanOrEqual(right.y);
    // 两个输入口的纵坐标分别是子节点头行的高度
    expect(inAnchor(outer, 0).y).toBeLessThan(inAnchor(outer, 1).y);
  });

  it('拖过的节点用自己的坐标，其余仍按布局算', () => {
    const g = layoutGraph(root, { '0.1': { x: 400, y: -20 } });
    expect(g.byKey.get('0.1')!.x).toBe(400);
    expect(g.byKey.get('0.1')!.y).toBe(-20);
    expect(g.byKey.get('0.0')!.x).not.toBe(400);
  });

  it('尺寸由 nodeSize 一处给（渲染与布局同源）', () => {
    const g = layoutGraph(root);
    for (const n of g.nodes) {
      const s = nodeSize(n.node);
      expect([n.w, n.h]).toEqual([s.w, s.h]);
      expect(n.h).toBe(8 + 24 + slotCount(n.node) * 22);
    }
  });
});

describe('moveSubtree：改接', () => {
  const root = ast('clamp(t, 0, 1)');

  it('把一枝挪到另一个输入口，原位置留 0', () => {
    // 把 t（路径 [0]）挪到根的第三格上。
    const res = moveSubtree(root, [0], [], 2);
    expect(res.ok).toBe(true);
    expect(printExpr(res.ast)).toBe('clamp(0, 0, t)');
  });

  it('挪到另一个节点（非祖先）的输入口上也成立', () => {
    // (t + 1) * (sin(t) - 1) 里把右边的 sin(t) 挪到左边加法里
    const src = ast('(t + 1) * (sin(t) - 1)');
    const res = moveSubtree(src, [1, 0], [0], 1);
    expect(res.ok).toBe(true);
    expect(printExpr(res.ast)).toBe('(t + sin(t)) * (0 - 1)');
  });

  it('目标是自己的后代 ⇒ 拒绝（会成环）', () => {
    const deep = ast('clamp(sin(t), 0, 1)');
    const res = moveSubtree(deep, [0], [0, 0], 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cycle');
    expect(res.ast).toBe(deep);
  });

  it('拖回自己那一格 ⇒ 拒绝且不动', () => {
    const res = moveSubtree(root, [1], [1], 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('same');
    expect(printExpr(res.ast)).toBe('clamp(t, 0, 1)');
  });

  it('路径对不上 / 插槽越界 ⇒ 拒绝（文本模式刚改过表达式）', () => {
    expect(moveSubtree(root, [9], [], 0).reason).toBe('missing');
    expect(moveSubtree(root, [0], [], 9).reason).toBe('missing');
    // 目标是叶子节点：它没有输入口
    expect(moveSubtree(root, [0], [1], 0).reason).toBe('missing');
  });
});

describe('clearNode / 导线', () => {
  it('清零 = 换成数值 0，形状不变', () => {
    const out = clearNode(ast('clamp(t, 0, 1)'), [1]);
    expect(printExpr(out)).toBe('clamp(t, 0, 1)');
    expect(slotAt(out, 1)).toEqual({ k: 'num', v: 0 });
  });

  it('路径键：根是空串（CSS 选择器与 data 属性都用它）', () => {
    expect(pathKey([])).toBe('');
    expect(pathKey([0, 2])).toBe('0.2');
  });

  it('导线是三次贝塞尔，两端水平出入', () => {
    const d = wirePath(0, 10, 100, 40);
    expect(d.startsWith('M 0 10 C ')).toBe(true);
    expect(d.endsWith('100 40')).toBe(true);
  });
});
