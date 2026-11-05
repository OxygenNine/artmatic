/**
 * hit-area.ts — 「这一下点在了元素的**实心**处吗」（只有这里碰 DOM）。
 *
 * 背景：元素的命中框是**未旋转外接矩形**（geometry.ts::hitTest 的注释说明了
 * 为什么用几何）。矩形对圆环 / 方框 / 星形这类**中空**图形是错的：面积一大，
 * 中间那一大片其实什么都没画，却把下面的元素全挡住了，用户点不到。
 *
 * 所以命中要过这道闸：图形元素按**路径几何**判断（`isPointInFill`），透明处
 * 一律让位给下一层。文本 / 图片按外框算实心 —— 字形的间隙（「口」字中间）、
 * 带 alpha 的 PNG 都能看穿，但那需要逐像素采样，成本与收益完全不成比例，
 * 而且用户的预期本来也是「这个框是我的」。
 *
 * ## 模糊判定（`PROBE_RADII_PX`）
 *
 * 严格按像素判定会把另一头推向荒谬：一条 2px 的细线、一个旋转 45° 的细长条，
 * 用户得把指针**精确压在**那几像素的墨迹上，鼠标根本做不到。所以中心没命中时
 * 在周围撒两圈探针（3px / 6px，八个方向），**只要附近有墨迹就算命中**。
 *
 * 这不会把「中空图形的洞」重新堵上：洞的直径远大于 6px，中心那一片仍然穿透。
 * 它只是让边缘附近的容错与其它设计工具一致（描边/细线的可点区域约 10px 宽）。
 *
 * ## 坐标系
 *
 *   · `docToLocal` 把文档坐标换算进元素自身（含 rot），与画把手用的是同一套；
 *   · `path.getCTM()` 再换算进路径的用户坐标 —— 自定义路径外面还套着一层
 *     `scale(w/100, h/100)`（见 render-dom.ts::syncShape），手算容易漏掉它，
 *     交给浏览器自己的矩阵不会再错。
 *
 * ⚠️ **不能用 `isPointInStroke` 补描边的容差**（实测）：Chrome 的实现在那里
 * 走的是 nonzero 缠绕规则，而圆环的内外圈是**同向**画出来的 —— 于是圆环正中心
 * （evenodd 下的洞）`isPointInFill` 为 false、`isPointInStroke` 却为 true，
 * 一眼看上去「洞里有东西」。这条错误恰好出现在本文件最想解决的那类图形上，
 * 所以描边不参与判定，容差改由探针实现。
 */

import { EL_ID_ATTR, type TypographyElement } from '../../typography/document';
import { docToLocal } from '../../typography/geometry';

/**
 * 探针半径（**屏幕** px）。两圈：3 覆盖「手抖一两像素」，6 覆盖细线的常见误差。
 * 再大就会与「点空白处开始框选」打架了。
 */
const PROBE_RADII_PX = [3, 6];

/** 每圈八个方向（45° 一档）。 */
const PROBE_DIRS = 8;

/** 属性选择器里的字符串转义（id 是我们自己生成的，但仍然不信任）。 */
function attrValue(id: string): string {
  return `"${id.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * 图形元素实际画出来的 `<path>`。
 *
 * 结构是固定的 `<svg><defs?><image?><g><path/></g></svg>`（render-dom.ts），
 * **不能**用 `querySelector('path')`：图片填充的 `<clipPath>` 里也有一个 path，
 * 而它在 DOM 里排在前面 —— 拿到它就会按裁剪路径判定，结果永远偏。
 */
function shapePath(root: HTMLElement, id: string): SVGGeometryElement | null {
  const shell = root.querySelector<HTMLElement>(`[${EL_ID_ATTR}=${attrValue(id)}]`);
  const svg = shell?.querySelector('svg');
  if (!svg) return null;
  for (const child of Array.from(svg.children)) {
    if (child.tagName.toLowerCase() !== 'g') continue;
    const path = child.firstElementChild;
    if (path && path.tagName.toLowerCase() === 'path') return path as SVGGeometryElement;
  }
  return null;
}

/**
 * 点是否落在元素**不透明**的区域上（含 6px 的模糊容差）。`undefined`（元素已经
 * 不在文档里）算实心，让上层继续按老规则处理而不是「点了没反应」。
 */
export function isOpaqueAt(
  root: HTMLElement | null,
  el: TypographyElement | undefined,
  p: { x: number; y: number },
  zoom: number,
  /**
   * 元素在**屏幕上**的框（镜头视差生效时与 `el.frame` 不是同一个）。
   * 缺省 = `el.frame`（没有镜头 / depth=0，逐像素行为不变）。
   */
  screenFrame?: { x: number; y: number; w: number; h: number; rot: number },
): boolean {
  if (!root || !el || el.kind !== 'shape') return true;
  // 图片填充时整条路径都被图片盖住了，路径的洞也会被裁出来 —— 按实心算。
  if (el.imageFill) return true;

  const path = shapePath(root, el.id);
  const ctm = path?.getCTM?.() ?? null;
  if (!path || !ctm) return true; // DOM 还没画出来：退回外框判定

  const inv = ctm.inverse();
  const local = docToLocal(screenFrame ?? el.frame, p);
  const inFill = (x: number, y: number): boolean =>
    path.isPointInFill(new DOMPoint(x, y).matrixTransform(inv));

  if (inFill(local.x, local.y)) return true;

  /*
   * 只描边的图形（直线、把填充关掉的空心框）退化为「整框可点」。
   *
   * 它们的可见部分只有几像素宽，按几何判定等于要求用户精确点在线上；而填充
   * 一旦关掉，用户对「这个框是透明的」本来就没有预期（看不见的填充不会让人
   * 觉得那里该穿过去）。例外只留给**有填充**的中空图形 —— 那才是抱怨的来源。
   */
  if (el.fill.kind === 'none') return true;

  // 模糊判定：周围两圈探针，任意一处有墨迹就算点中了这个元素。
  const scale = zoom > 0.01 ? zoom : 0.01;
  for (const rPx of PROBE_RADII_PX) {
    const r = rPx / scale;
    for (let i = 0; i < PROBE_DIRS; i++) {
      const a = (i / PROBE_DIRS) * Math.PI * 2;
      if (inFill(local.x + Math.cos(a) * r, local.y + Math.sin(a) * r)) return true;
    }
  }
  return false;
}
