/**
 * element-export.ts — 把排版里的元素**反向导出**成独立素材（PNG 位图 / SVG 矢量）。
 *
 * 正向链路是「素材 → 元素」（`ui/media-import.ts` 建素材、置入文档）；这里是
 * 反过来的那一条，也是「转为图片」之外唯一一个**把排版产物拿出去**的出口。
 *
 * ## 为什么 PNG 走「子文档 + 重新光栅化」，不是「整张画布裁一块」
 *
 * 裁剪整张位图会把**落在同一片区域里的其它元素**一起带出来（一个压在标题上的
 * 星形，裁出来带着背后的字），而用户右键的是**这个元素**。所以这里把选择集
 * 摘成一份独立文档（尺寸 = 包围盒、坐标平移到 0,0），再走那条唯一的
 * `rasterizeOnce` 通路 —— 与导出成片是同一份求值代码，只是文档更小。
 *
 * 代价（刻意接受，别当成 bug 修）：
 *  - 文档级 `background` **不导出**（透明底）。「导出这个图形」不该顺手把画布
 *    底色刷上去；要底板就选中那个底板元素。
 *  - `doc.size` 变了 ⇒ 读 `doc.size` 的文档脚本会看到不同的尺寸。
 *  - 组合底板**只在整组都在选择集里时**才带上（见 `groupIdOf`）。
 *
 * ## 为什么 SVG 只有图形
 *
 * 文字与图片没有矢量表达：文字要过 HarfBuzz 转路径（那是 `text-outline.ts`
 * 的另一个动作），图片是像素。所以 SVG 只对**整份选择都是图形**开放
 * （`canExportSvg`），混合选择只给 PNG —— 否则输出里会静默少一半东西。
 *
 * SVG 复用的是渲染层的 `syncShape`（几何 + 填充 / 描边 defs 的**唯一实现**），
 * 所以矢量产物与舞台上看到的是同一套路径与渐变。它**不含**元素动画的烘焙
 * （CSS 动画无法表达成静态矢量），也不含 3D 倾斜 / 四角；
 * 阴影与虚化降级成 CSS `filter`（浏览器与 Inkscape 都认）。
 */

import { depthOf, parallaxOf, screenFrame, type CameraDoc } from './camera';
import { isCameraChannel } from './camera-tracks';
import { elementFilter } from './css';
import type { ShapeElement, TypographyDocument, TypographyElement } from './document';
import { resolveImageAsset } from './image-assets';
import { syncShape } from './render-dom';
import type { TypographyTheme } from './theme';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 导出格式。`png` 是**位图快照**（烘焙当前帧、含动画 / 阴影 / 滤镜），
 * `svg` 是**矢量快照**（只有图形，见文件头）。
 */
export type ExportFormat = 'png' | 'svg';

/** 导出包围盒（文档像素，已整数化）。 */
export interface ExportBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportDoc {
  /** 只含选中元素、坐标已平移到 0,0 的文档视图。 */
  doc: TypographyDocument;
  box: ExportBox;
}

/** SVG 唯一能无损表达的那一类：**整份选择都是可见图形**。 */
export function canExportSvg(elements: readonly TypographyElement[]): boolean {
  const visible = elements.filter((el) => el.visible);
  return visible.length > 0 && visible.every((el) => el.kind === 'shape');
}

/**
 * 选择集里的可导出元素：**可见**的那些（隐藏元素在舞台上就没有，导出一个
 * 用户看不见的东西只会让他以为「这一项坏了」）。
 *
 * 顺序沿用文档顺序（= z 序），不是选择顺序 —— 输出里的叠放次序必须与舞台一致。
 */
export function elementsForExport(
  doc: TypographyDocument,
  ids: readonly string[],
): TypographyElement[] {
  if (!ids.length) return [];
  const want = new Set(ids);
  return doc.elements.filter((el) => el.visible && want.has(el.id));
}

/**
 * 描边 / 阴影 / 虚化会画到框**外面**，包围盒必须把它们算进去 ——
 * 少算的话导出的图形边缘被齐刷刷切掉一圈（`drop-shadow` 尤其明显）。
 */
function spillOf(el: TypographyElement): number {
  let spill = 0;
  if (el.kind === 'shape' && el.stroke) spill = Math.max(spill, el.stroke.width / 2);
  for (const s of el.shadows ?? []) {
    spill = Math.max(spill, Math.abs(s.dx) + s.blur, Math.abs(s.dy) + s.blur);
  }
  if (el.blur && el.blur > 0) spill = Math.max(spill, el.blur * 2);
  return spill;
}

/**
 * 选择集的包围盒（含旋转后的四角与上面那圈外扩）。
 *
 * `view` 决定镜头算不算进去：PNG 传播放头时刻的文档视图（`withCameraAt` 的
 * 产物，视差由此**烘进** frame），SVG 传 `{ size }`（只要元素自身的框）。
 */
export function exportBoxOf(
  doc: TypographyDocument,
  ids: readonly string[],
  view: CameraDoc = doc,
): ExportBox | null {
  const els = elementsForExport(doc, ids);
  if (!els.length) return null;
  const picked = new Set(els.map((el) => el.id));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const f = screenFrame(view, el);
    const spill = spillOf(el);
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const cos = Math.cos(f.rot);
    const sin = Math.sin(f.rot);
    const hw = f.w / 2;
    const hh = f.h / 2;
    for (const [dx, dy] of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as const) {
      const x = cx + dx * cos - dy * sin;
      const y = cy + dx * sin + dy * cos;
      if (x - spill < minX) minX = x - spill;
      if (y - spill < minY) minY = y - spill;
      if (x + spill > maxX) maxX = x + spill;
      if (y + spill > maxY) maxY = y + spill;
    }
  }

  /*
   * 整组都在选择集里时，**组合底板也在导出范围里**：它比成员外接框大出
   * `padding`（外加描边半宽），不扩就会被包围盒裁掉一条边。
   *
   * 这里按**成员 AABB 再外扩**算，而不是照着 `groupBox`（未旋转外接框）重算：
   * 旋转过的成员会让结果比底板略大一点 —— 宁可多几个透明像素，也不裁掉一圈。
   * 缩放假手（`parallaxOf`）跟着底板自己的景深走，与渲染侧的 `groupDepthOf`
   * 同一口径（离镜头最近的那个成员）。
   */
  for (const g of doc.groups ?? []) {
    const members = doc.elements.filter((el) => el.groupId === g.id);
    if (!members.length || !members.every((el) => picked.has(el.id))) continue;
    const visible = members.filter((el) => el.visible);
    if (!visible.length) continue;
    let depth = 0;
    for (const el of visible) depth = Math.max(depth, depthOf(el));
    const pad = Math.max(0, g.padding) * parallaxOf(view, { depth }).scale;
    const half = Math.abs(g.stroke?.width ?? 0) / 2;
    if (pad + half <= 0) continue;
    minX -= pad + half;
    minY -= pad + half;
    maxX += pad + half;
    maxY += pad + half;
  }

  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { x, y, w: Math.max(1, Math.ceil(maxX) - x), h: Math.max(1, Math.ceil(maxY) - y) };
}

/**
 * 一份「只有这些元素」的文档。
 *
 * 三处必须一起做，少一处导出的画面就不等于舞台上看到的那一块：
 *  1. frame 换成**屏幕框**再平移（镜头视差是越界坐标的来源，不平移就会导出空白）；
 *  2. `camera` 与镜头轨道一起摘掉 —— 留着会被 `withCameraAt` 再算一遍视差，
 *     等于把镜头应用两次；
 *  3. `groupId` 只在**整组都在**时保留（见 `groupIdOf`）。
 */
export function buildExportDoc(
  doc: TypographyDocument,
  ids: readonly string[],
  view: CameraDoc = doc,
): ExportDoc | null {
  const els = elementsForExport(doc, ids);
  const box = exportBoxOf(doc, ids, view);
  if (!els.length || !box) return null;

  const picked = new Set(els.map((el) => el.id));
  const elements = els.map((el) => {
    const f = screenFrame(view, el);
    const next: TypographyElement = {
      ...el,
      frame: { x: f.x - box.x, y: f.y - box.y, w: f.w, h: f.h, rot: f.rot },
    };
    const groupId = groupIdOf(doc, el, picked);
    if (groupId) next.groupId = groupId;
    else delete next.groupId;
    return next;
  });

  const out: TypographyDocument = {
    ...doc,
    size: { w: box.w, h: box.h },
    // 透明底：导出的是元素，不是画布。
    background: { kind: 'none' },
    elements,
    animations: (doc.animations ?? []).filter((a) => !isCameraChannel(a.prop)),
  };
  delete out.camera;
  return { doc: out, box };
}

/**
 * 组合底板要不要跟着导出：**整组成员都在选择集里**才算「导出这一组」。
 *
 * 只选中一个成员时留着 `groupId` 会把组的底板（背景 / 边框 / 内边距）带出来
 * —— 那块底板比元素大一圈，导出的素材会凭空多出一圈底。只判「有没有 groupId」
 * 的话两种情形不可区分。
 */
function groupIdOf(
  doc: TypographyDocument,
  el: TypographyElement,
  picked: ReadonlySet<string>,
): string | undefined {
  const id = el.groupId;
  if (!id) return undefined;
  for (const other of doc.elements) {
    if (other.groupId === id && !picked.has(other.id)) return undefined;
  }
  return id;
}

/* ------------------------------------------------------------ SVG */

export interface SvgExportOptions {
  theme?: TypographyTheme;
  /** `imageFill` 的图源。缺省读 `image-assets` 的运行期 URL 表。 */
  resolveImage?: (assetId: string) => string | null;
}

/**
 * 图形选择 → 独立 SVG 文档（字符串）。
 *
 * 返回 null = 这份选择里没有可见图形（调用方应先过 `canExportSvg`）。
 * 图片填充的 `<image href>` 会被**内联成 data URL**：`blob:` 地址存到磁盘上
 * 之后就失效了，那样的 SVG 打开来是一块空框。
 */
export async function shapesToSvg(
  doc: TypographyDocument,
  ids: readonly string[],
  opts: SvgExportOptions = {},
): Promise<string | null> {
  const built = buildExportDoc(doc, ids, { size: doc.size });
  if (!built) return null;
  const shapes = built.doc.elements;
  if (!shapes.length || shapes.some((el) => el.kind !== 'shape')) return null;

  const { box } = built;
  const outer = document.createElementNS(SVG_NS, 'svg');
  outer.setAttribute('width', String(box.w));
  outer.setAttribute('height', String(box.h));
  outer.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);

  for (const el of shapes) {
    const shape = el as ShapeElement;
    const f = shape.frame;
    const g = document.createElementNS(SVG_NS, 'g');
    const deg = (f.rot * 180) / Math.PI;
    const move = `translate(${round(f.x)} ${round(f.y)})`;
    g.setAttribute(
      'transform',
      deg ? `${move} rotate(${round(deg)} ${round(f.w / 2)} ${round(f.h / 2)})` : move,
    );
    if (shape.opacity !== 1) g.setAttribute('opacity', String(shape.opacity));
    const style: string[] = [];
    const filter = elementFilter(shape, opts.theme);
    if (filter !== 'none') style.push(`filter: ${filter}`);
    if (shape.blend !== 'normal') style.push(`mix-blend-mode: ${shape.blend}`);
    if (style.length) g.setAttribute('style', `${style.join('; ')};`);

    const inner = document.createElementNS(SVG_NS, 'svg');
    inner.setAttribute('width', String(round(f.w)));
    inner.setAttribute('height', String(round(f.h)));
    const url = shape.imageFill
      ? await inlineImage(shape.imageFill.assetId, opts.resolveImage)
      : null;
    syncShape(inner, shape, opts.theme, url);
    g.appendChild(inner);
    outer.appendChild(g);
  }

  const xml = new XMLSerializer().serializeToString(outer);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * `imageFill` 的图源 → data URL。
 *
 * `fetch` 对 `blob:` 地址是可用的（同源），比再走一遍 FileReader 读素材仓省事。
 * 拿不到就返回 null（`syncImageFill` 会把那一层整个跳过，图形照常出）。
 */
async function inlineImage(
  assetId: string,
  resolve: ((assetId: string) => string | null) | undefined,
): Promise<string | null> {
  const url = (resolve ?? resolveImageAsset)(assetId);
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(String(reader.result));
      reader.onerror = () => rej(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
