/**
 * graph-model.ts — 表达式节点图的布局与改接（纯函数，可单测）。
 *
 * 积木视图**不是排版**：节点在画布上自由摆放，只有「谁接谁」由 AST 决定。
 * 所以这里只做两件事 —— 给每个节点算一个初始位置（树形分层），以及把
 * 「把这一枝拖到那个输入口上」翻译成一次 AST 变换。
 *
 * ## 为什么布局是自左向右
 *
 * 输入在左、输出在右，连线朝右流。这是节点编辑器的通用读法，也让「根在最右」
 * 这件事不需要额外说明 —— 画面里唯一没有出线的那个节点就是结果。
 *
 * ## 尺寸必须一处算
 *
 * `nodeSize()` 同时喂给布局与渲染（节点用内联宽高）。两边各估一份的形态是
 * 「连线接到节点外半米」——不报错，只是看着不对。
 */

import { slotAt, slotCount, withSlot, type ExprNode } from '../../core/expr';

/** 节点头行（种类 / 操作符 / 值编辑器）。 */
export const HEAD_H = 24;
/** 一个输入行。 */
export const ROW_H = 22;
export const PAD = 4;
/** 层间距 / 同层子节点间距。 */
export const GAP_X = 52;
export const GAP_Y = 12;

export interface NodeSize {
  w: number;
  h: number;
}

export function nodeSize(node: ExprNode): NodeSize {
  const rows = slotCount(node);
  const h = PAD * 2 + HEAD_H + rows * ROW_H;
  let w: number;
  switch (node.k) {
    case 'num':
      w = 150;
      break;
    case 'time':
    case 'beat':
      w = 104;
      break;
    case 'mod':
      w = 200;
      break;
    case 'bin':
      // 五个操作符按钮 + 菜单。
      w = 140;
      break;
    case 'un':
      w = 92;
      break;
    case 'call':
      w = Math.max(104, node.fn.length * 8 + 66);
      break;
    default:
      w = 168;
      break;
  }
  return { w, h };
}

export function pathKey(path: readonly number[]): string {
  return path.join('.');
}

export interface GraphNode {
  path: number[];
  key: string;
  node: ExprNode;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 根没有输入它的父节点，所以不画可拖出的输出口。 */
  root: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  slot: number;
  /** 输出口（父节点右缘）与输入口（子节点左缘）的世界坐标。 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byKey: Map<string, GraphNode>;
  width: number;
  height: number;
  /** 拖过的节点可能跑到负坐标：导线的 SVG 需要按这个原点铺开。 */
  minX: number;
  minY: number;
}

/** 输出口 = 节点头行的右缘中点。 */
export function outAnchor(n: GraphNode): { x: number; y: number } {
  return { x: n.x + n.w, y: n.y + PAD + HEAD_H / 2 };
}

/** 第 `slot` 个输入口 = 该行的左缘中点。 */
export function inAnchor(n: GraphNode, slot: number): { x: number; y: number } {
  return { x: n.x, y: n.y + PAD + HEAD_H + slot * ROW_H + ROW_H / 2 };
}

/**
 * 树形分层布局。返回的坐标已归一到左上角 (0,0)。
 *
 * `overrides` 是用户拖过之后的坐标（键 = `pathKey`）：命中的节点用拖出来的位置，
 * 其余仍由布局算。**子节点不跟着父节点走** —— 节点图里拖一个节点就该只动它自己，
 * 连线自己拉长。
 */
export function layoutGraph(
  root: ExprNode,
  overrides: Readonly<Record<string, { x: number; y: number }>> = {},
): GraphLayout {
  const nodes: GraphNode[] = [];
  /** 子树占用的竖直高度（缓存按 path 键）。 */
  const heights = new Map<string, number>();

  function ownHeight(node: ExprNode): number {
    return nodeSize(node).h;
  }

  function subtreeHeight(node: ExprNode, path: number[]): number {
    const key = pathKey(path);
    const hit = heights.get(key);
    if (hit !== undefined) return hit;
    const rows = slotCount(node);
    let h = ownHeight(node);
    if (rows > 0) {
      let sum = 0;
      for (let i = 0; i < rows; i += 1) {
        sum += subtreeHeight(slotAt(node, i) ?? { k: 'num', v: 0 }, [...path, i]);
      }
      sum += (rows - 1) * GAP_Y;
      h = Math.max(h, sum);
    }
    heights.set(key, h);
    return h;
  }

  /** 节点右缘放在 `right`，竖直方向在 `top..top+subtree` 之间居中。 */
  function place(node: ExprNode, path: number[], right: number, top: number): void {
    const size = nodeSize(node);
    const sub = subtreeHeight(node, path);
    const x = right - size.w;
    const y = top + (sub - size.h) / 2;
    nodes.push({ path, key: pathKey(path), node, x, y, w: size.w, h: size.h, root: path.length === 0 });

    const rows = slotCount(node);
    let cy = top;
    for (let i = 0; i < rows; i += 1) {
      const child = slotAt(node, i) ?? { k: 'num', v: 0 };
      const childSub = subtreeHeight(child, [...path, i]);
      place(child, [...path, i], x - GAP_X, cy);
      cy += childSub + GAP_Y;
    }
  }

  place(root, [], 0, 0);

  // 归一：整张图挪到正坐标，画布才好算尺寸与适配。
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const dx = -minX;
  const dy = -minY;
  for (const n of nodes) {
    n.x += dx;
    n.y += dy;
    const o = overrides[n.key];
    if (o) {
      n.x = o.x;
      n.y = o.y;
    }
  }

  /*
   * 导线连接的是**子节点的输出口**与**父节点那一行的输入口**，不是两个节点的
   * 右侧。接成「父右缘 → 子右缘」的话，一条边会横穿自己的父节点。
   */
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    const rows = slotCount(n.node);
    for (let i = 0; i < rows; i += 1) {
      const childKey = pathKey([...n.path, i]);
      const child = byKey.get(childKey);
      if (!child) continue;
      const a = outAnchor(child);
      const b = inAnchor(n, i);
      edges.push({ from: childKey, to: n.key, slot: i, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }

  let minX2 = Infinity;
  let minY2 = Infinity;
  let w = 0;
  let h = 0;
  for (const n of nodes) {
    minX2 = Math.min(minX2, n.x);
    minY2 = Math.min(minY2, n.y);
    w = Math.max(w, n.x + n.w);
    h = Math.max(h, n.y + n.h);
  }
  return { nodes, edges, byKey, width: w, height: h, minX: minX2, minY: minY2 };
}

/* ------------------------------------------------------------ 改接 */

export type MoveReason = 'same' | 'cycle' | 'missing';

export interface MoveResult {
  ast: ExprNode;
  ok: boolean;
  reason?: MoveReason;
}

/**
 * 把 `from` 这一枝挪到 `to` 节点的第 `slot` 个输入口上（原位置留一个数值 0）。
 *
 * 三条拒绝理由都对应「画面上会看不懂」的形态：
 *   - `same`：拖回自己那一格，白写一笔撤销；
 *   - `cycle`：目标是自己的后代 —— 接上去这棵树就不再是树了；
 *   - `missing`：路径对不上（表达式刚被文本模式改过，画布还没跟上）。
 */
export function moveSubtree(
  root: ExprNode,
  from: readonly number[],
  to: readonly number[],
  slot: number,
): MoveResult {
  if (pathKey(from) === pathKey(to)) return { ast: root, ok: false, reason: 'same' };
  // 目标是自己的后代（含自身）⇒ 成环。
  if (to.length > from.length && from.every((v, i) => to[i] === v)) {
    return { ast: root, ok: false, reason: 'cycle' };
  }
  const branch = atPath(root, from);
  if (!branch) return { ast: root, ok: false, reason: 'missing' };

  // 先把源位置清零，再取目标 —— 目标可能是源的祖先，清零之后它的形状才稳定。
  const cleared = replaceAt(root, from, { k: 'num', v: 0 });
  const target = atPath(cleared, to);
  if (!target || slot < 0 || slot >= slotCount(target)) {
    return { ast: root, ok: false, reason: 'missing' };
  }
  return { ast: replaceAt(cleared, to, withSlot(target, slot, branch)), ok: true };
}

/** 把某节点换成数值 0（「删掉这一块」的唯一含义：输入口不能空着）。 */
export function clearNode(root: ExprNode, path: readonly number[]): ExprNode {
  return replaceAt(root, path, { k: 'num', v: 0 });
}

function atPath(root: ExprNode, path: readonly number[]): ExprNode | null {
  let cur: ExprNode | null = root;
  for (const i of path) {
    if (!cur) return null;
    cur = slotAt(cur, i);
  }
  return cur;
}

function replaceAt(root: ExprNode, path: readonly number[], next: ExprNode): ExprNode {
  if (path.length === 0) return next;
  const [i, ...rest] = path as [number, ...number[]];
  const child = slotAt(root, i);
  if (!child) return root;
  return withSlot(root, i, replaceAt(child, rest, next));
}

/** 三次贝塞尔导线（水平出入，节点图的标准形状）。 */
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
