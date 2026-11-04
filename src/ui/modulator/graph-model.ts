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
/**
 * 节点描边宽度。**必须算进 `nodeSize`**：盒子是 `border-box`，少算 2px 会让
 * flex 把每个子项压 0.67px —— 输入口逐行往下漂，而导线端点仍在算出来的位置。
 */
export const BORDER = 1;

export interface NodeSize {
  w: number;
  h: number;
}

/** 等宽字 `--fs-xs` 下每个字符的近似宽度 + chip 的左右内边距。 */
const CHIP_CH = 7.2;
const CHIP_PAD = 14;
/** 头行的固定开销：左右 padding + 三处间距 + ⋯ 按钮。 */
const HEAD_FIXED = PAD * 2 + 4 * 3 + 18;

function chipWidth(text: string): number {
  return Math.min(150, text.length * CHIP_CH + CHIP_PAD);
}

export function nodeSize(node: ExprNode): NodeSize {
  const rows = slotCount(node);
  const h = BORDER * 2 + PAD * 2 + HEAD_H + rows * ROW_H;
  /*
   * 宽度按**内容**估。估窄了会怎样：`flex: none` 的 ⋯ 按钮被挤出盒子，
   * 输出口跟着跑出去 —— 而导线端点还按盒子算，于是「线接不到小圆」。
   * 所以 chip 一律 `flex: 0 1 auto` 可压缩（真挤了也是省略号，不是溢出）。
   */
  let w: number;
  switch (node.k) {
    case 'num':
      // 没有 chip：padding + 两处间距 + 数值框（fluid，96 的舒适宽度）+ ⋯。
      w = PAD * 2 + 4 * 2 + 18 + 96;
      break;
    case 'time':
    case 'beat':
      // chip 的文案来自 i18n，这里只留一个够用的固定宽度（chip 本身会省略号兜底）。
      w = 116;
      break;
    case 'mod':
      // chip + 下拉（最小 130）+ ⋯。
      w = 208;
      break;
    case 'bin':
      // 五个操作符按钮 + ⋯。
      w = 5 * 20 + 4 + HEAD_FIXED;
      break;
    case 'un':
      w = chipWidth('-') + HEAD_FIXED;
      break;
    case 'call':
      w = chipWidth(node.fn) + HEAD_FIXED;
      break;
    default:
      w = 172;
      break;
  }
  return { w: Math.max(88, w) + BORDER * 2, h };
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

/**
 * 一条边只描述**谁接谁**，坐标留给组件从 DOM 量。
 *
 * 早先这里带 `x1..y2`，是拿 `nodeSize` 的常数手算的 —— 结果是「字宽、边框、
 * flex 压缩」任何一处偏差都会让导线离开小圆，而且看不出来是哪儿错了。
 * 端口位置现在一律由 `measurePorts()` 读真实 DOM。
 */
export interface GraphEdge {
  from: string;
  to: string;
  slot: number;
}

/** 端口的世界坐标键：`out:<节点键>` / `in:<节点键>:<行>`。 */
export function portOutKey(nodeKey: string): string {
  return `out:${nodeKey}`;
}

export function portInKey(nodeKey: string, slot: number): string {
  return `in:${nodeKey}:${slot}`;
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

/**
 * 输出口 / 输入口的**兜底**坐标（还没量到 DOM 的第一帧用）。
 *
 * 真正的端点来自 `measurePorts()` —— 这两个函数只在「挂载后、首帧之前」生效，
 * 所以它们只需要近似正确，别拿它们当几何真源。
 */
export function outAnchor(n: GraphNode): { x: number; y: number } {
  return { x: n.x + n.w - BORDER, y: n.y + BORDER + PAD + HEAD_H / 2 };
}

export function inAnchor(n: GraphNode, slot: number): { x: number; y: number } {
  return {
    x: n.x + BORDER,
    y: n.y + BORDER + PAD + HEAD_H + slot * ROW_H + ROW_H / 2,
  };
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
      if (!byKey.has(childKey)) continue;
      edges.push({ from: childKey, to: n.key, slot: i });
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
