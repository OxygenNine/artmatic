/**
 * camera.ts — 排版的 2.5D 镜头：相机参数 → 每个元素的视差变换（**纯函数**）。
 *
 * 这是镜头语义的唯一实现。舞台、光栅化、缓存键、命中测试都从这里取数，
 * 各写一份的形态是「编辑里对得上、导出对不上」，而且不会有任何报错。
 *
 * ## 语义
 *
 * 相机是在**文档平面之前**的一个取景点，`Camera` 的四个参数描述它的姿态
 * （见 `document.ts` 的 `Camera`）。元素按自己的 `depth` 吃这次变换：
 *
 * ```
 * o = 画布中心，c = (camera.x, camera.y)，z = camera.zoom，θ = camera.rot
 * d = depth（0..1）
 * 屏幕位置 A_d(p) = o + s·R(φ)·(p − o) + t
 *   s = 1 + (z − 1)·d      —— 近的东西放大得多
 *   φ = θ·d                —— 近的东西跟着镜头转
 *   t = −d·z·R(θ)·c        —— 镜头往右看，近的东西往左移
 * ```
 *
 * 三个端点因此是干净的：
 *  - **d = 0** ⇒ 恒等（`s = 1, φ = 0, t = 0`）⇒ 无穷远，一个像素都不动；
 *  - **d = 1** ⇒ `A(p) = o + z·R(θ)·(p − c − o)` ⇒ 与「整个文档被镜头推过去」
 *    完全等价（贴着镜头的一层）；
 *  - **没有 camera / 全元素 depth = 0** ⇒ 恒等 ⇒ 与加这个功能之前逐像素相同。
 *
 * ## 为什么是「位移 + 旋转 + 缩放」而不是矩阵
 *
 * `A_d` 是**相似变换**（uniform scale + rotation + translation）。这一点被三处
 * 依赖，换成一般的仿射矩阵会静默给错答案：
 *  1. `elementStyle` 把它拼成 `translate() rotate() scale()` 前缀 —— CSS 的
 *     `transform-origin` 只有一个，只能用「先把旋转中心算进平移」这个写法；
 *  2. `screenFrame` 把元素框当成「仍然是一个旋转矩形」（拖拽 / 命中 / 选择框）；
 *  3. 命中测试的逆变换就是「除以 s、反转 φ」，不需要求矩阵逆。
 *
 * ## 不做什么
 *
 * **镜头不改变图层的覆盖范围**：排版位图永远覆盖整个 `doc.size` 矩形
 * （`runtime.ts::rasterSizeFor` 与 `engine/placement.frag.ts::drawSizeFor` 的
 * 契约）。被视差推出画布的元素由画布边缘裁掉 —— 那就是「出画」，
 * 不是被哪个中间层裁掉了半边。
 */

import type { Camera, Size, TextureFrame, TypographyElement } from './document';
import { cameraIsIdentity, defaultCamera } from './document';

/**
 * 镜头计算只需要「画布尺寸 + 相机」。
 *
 * 单独一个窄类型是为了让 `css.ts` 这类只拿得到这两项的模块也能算视差，
 * 而不必把整份文档传下去（传整份的形态是「顺手读了 doc.elements」的开始）。
 */
export type CameraDoc = { size: Size; camera?: Camera };

/** 一个元素实际吃到的镜头变换（恒等时 `scale = 1, rot = 0, t = 0`）。 */
export interface Parallax {
  /** 绕画布中心的位移（文档 px）。 */
  tx: number;
  ty: number;
  /** 叠加在元素自身旋转之上的角度（**弧度**，与 `frame.rot` 同口径）。 */
  rot: number;
  /** 绕画布中心的缩放倍数。 */
  scale: number;
}

export const IDENTITY_PARALLAX: Parallax = { tx: 0, ty: 0, rot: 0, scale: 1 };

/** 元素深度（0..1，缺省 0）。脏值（NaN / 越界）在这里夹掉 —— 它是渲染输入。 */
export function depthOf(el: Pick<TypographyElement, 'depth'>): number {
  const d = Number(el.depth ?? 0);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(1, d));
}

/** 文档的有效镜头（缺省 = 恒等）。 */
export function cameraOf(doc: CameraDoc): Camera {
  return doc.camera ?? defaultCamera();
}

export function parallaxIsIdentity(p: Parallax): boolean {
  return p.scale === 1 && p.rot === 0 && p.tx === 0 && p.ty === 0;
}

/** 画布中心 —— 镜头缩放 / 旋转的固定点。 */
export function docCenter(doc: CameraDoc): { x: number; y: number } {
  return { x: doc.size.w / 2, y: doc.size.h / 2 };
}

/**
 * 一个元素的视差参数。`doc.camera` 缺省或 `depth = 0` 时返回恒等。
 *
 * 数值上刻意在恒等时**返回同一个常量对象**：调用方大量用 `parallaxIsIdentity`
 * 做短路，返回新对象会让「有没有镜头」变成一次逐元素分配。
 */
export function parallaxOf(doc: CameraDoc, el: Pick<TypographyElement, 'depth'>): Parallax {
  const cam = doc.camera;
  if (!cam || cameraIsIdentity(cam)) return IDENTITY_PARALLAX;
  const d = depthOf(el);
  if (d === 0) return IDENTITY_PARALLAX;
  const z = cam.zoom;
  const theta = (cam.rot * Math.PI) / 180;
  const phi = theta * d;
  // t = −d·z·R(θ)·c
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    tx: -d * z * (cosT * cam.x - sinT * cam.y),
    ty: -d * z * (sinT * cam.x + cosT * cam.y),
    rot: phi,
    scale: 1 + (z - 1) * d,
  };
}

/** 文档里「被放大的最多的那一层」的倍数（≥ 1）。超采样密度由它决定。 */
export function maxParallaxScale(doc: CameraDoc & { elements: readonly TypographyElement[] }): number {
  if (!doc.camera || cameraIsIdentity(doc.camera)) return 1;
  let max = 1;
  for (const el of doc.elements) {
    if (!el.visible) continue;
    const s = parallaxOf(doc, el).scale;
    if (s > max) max = s;
  }
  return max;
}

/**
 * 光栅化的超采样密度：`clamp(最大生效缩放, 1, 2)`。
 *
 * **只在真的有元素被放大时才 > 1**：全 depth = 0 的文档加一个镜头，
 * 位图尺寸与缓存键都逐字不变（否则「调一下 zoom」就会白白重烘一遍）。
 *
 * 上限 2 是硬要求：40× 的镜头若按 40× 密度光栅化，1080p 一帧是几十亿像素。
 * 超出 2× 的部分交给 GPU 放大（`typography/AGENTS.md` 的「超采样封顶」）。
 */
export function cameraDensity(doc: CameraDoc & { elements: readonly TypographyElement[] }): number {
  const s = maxParallaxScale(doc);
  return s <= 1 ? 1 : Math.min(2, s);
}

/** 相似变换 A_d 作用在点上（屏幕坐标 = 文档坐标，输出尺寸就是画布尺寸）。 */
export function applyParallax(
  doc: CameraDoc,
  p: Parallax,
  q: { x: number; y: number },
): { x: number; y: number } {
  if (parallaxIsIdentity(p)) return { x: q.x, y: q.y };
  const o = docCenter(doc);
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const rx = q.x - o.x;
  const ry = q.y - o.y;
  return {
    x: o.x + p.scale * (c * rx - s * ry) + p.tx,
    y: o.y + p.scale * (s * rx + c * ry) + p.ty,
  };
}

/**
 * `applyParallax` 的逆（屏幕点 → 元素所在的文档坐标）。
 *
 * 手势用它把指针换算回元素自己的空间：depth=1 + 镜头放大 2× 时，
 * 屏幕上拖 20px 只该改 10px 的 `frame.x`，否则元素跑得比指针快一倍。
 */
export function inverseParallax(
  doc: CameraDoc,
  p: Parallax,
  q: { x: number; y: number },
): { x: number; y: number } {
  if (parallaxIsIdentity(p)) return { x: q.x, y: q.y };
  const o = docCenter(doc);
  const c = Math.cos(-p.rot);
  const s = Math.sin(-p.rot);
  const rx = q.x - o.x - p.tx;
  const ry = q.y - o.y - p.ty;
  const k = 1 / p.scale;
  return {
    x: o.x + k * (c * rx - s * ry),
    y: o.y + k * (s * rx + c * ry),
  };
}

/**
 * 元素框在屏幕上的样子（**仍然是一个旋转矩形**，因为 A_d 是相似变换）。
 *
 * 命中测试、选择框、框选都用它。不这么做的话「镜头放大 2×」会让所有
 * 点击都落在元素原来的位置上 —— 点不中自己看得见的东西。
 */
export function screenFrame(doc: CameraDoc, el: Pick<TypographyElement, 'frame' | 'depth'>): TextureFrame {
  const p = parallaxOf(doc, el);
  if (parallaxIsIdentity(p)) return { ...el.frame };
  const f = el.frame;
  const center = applyParallax(doc, p, { x: f.x + f.w / 2, y: f.y + f.h / 2 });
  const w = f.w * p.scale;
  const h = f.h * p.scale;
  return { x: center.x - w / 2, y: center.y - h / 2, w, h, rot: f.rot + p.rot };
}

/* ------------------------------------------------------------ CSS 出口 */

/** 与 `css.ts` 的 px / deg / num 同一套三位小数口径。 */
function px(v: number): string {
  return `${Math.round(v * 1000) / 1000}px`;
}

/**
 * 视差 → 能**前缀**在元素自己那条 `transform` 上的 CSS 片段。
 *
 * `origin` 是 `transform-origin` 在**文档坐标**里的那个点（元素框右上角偏移，
 * 由 `css.ts` 按 `t3.origin` / 缺省 50% 50% 算出来）。为什么必须传它：
 * CSS 只有一个 `transform-origin`，而我们要绕**画布中心**转/缩 —— 于是把
 * 「绕画布中心」拆成「绕自身 origin 的同一变换 + 一段补偿平移」：
 *
 * ```
 * T = translate(o + t + s·R(φ)(origin − o) − origin) rotate(φ) scale(s)
 * ```
 *
 * 恒等时返回 `''`（调用方据此保持 `transform` 原样，连 `none` 都不改）。
 */
export function parallaxCss(doc: CameraDoc, p: Parallax, origin: { x: number; y: number }): string {
  if (parallaxIsIdentity(p)) return '';
  const o = docCenter(doc);
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const rx = origin.x - o.x;
  const ry = origin.y - o.y;
  const dx = o.x + p.tx + p.scale * (c * rx - s * ry) - origin.x;
  const dy = o.y + p.ty + p.scale * (s * rx + c * ry) - origin.y;
  const deg = (p.rot * 180) / Math.PI;
  const num = Math.round(p.scale * 1000) / 1000;
  return `translate(${px(dx)}, ${px(dy)}) rotate(${Math.round(deg * 1000) / 1000}deg) scale(${num})`;
}

/**
 * 「生效后的元素变换」摘要（进光栅化缓存键）。
 *
 * 为什么不是直接把相机参数拼进去：**没有被任何元素吃到的镜头不该击穿缓存**。
 * 全 depth = 0 的文档调 zoom、或者只改 `depth` 却仍是 0，摘要都保持空串，
 * 键与「没有镜头」逐字相同 —— 这是「调一下面板就整层重烘」的唯一防线。
 * 变换的每个输入（相机四参数 × 元素 depth / 框 / 3D 原点）都落在摘要里。
 */
export function parallaxSignature(doc: CameraDoc & { elements: readonly TypographyElement[] }): string {
  const cam = doc.camera;
  if (!cam || cameraIsIdentity(cam)) return '';
  const parts: string[] = [];
  for (const el of doc.elements) {
    const p = parallaxOf(doc, el);
    if (parallaxIsIdentity(p)) continue;
    const f = el.frame;
    const t3 = el.transform3d;
    const originX = f.x + f.w * (t3 ? t3.origin.x : 0.5);
    const originY = f.y + f.h * (t3 ? t3.origin.y : 0.5);
    parts.push(
      `${el.id}:${round(p.scale)}:${round(p.rot)}:${round(p.tx)}:${round(p.ty)}:${round(originX)}:${round(originY)}`,
    );
  }
  return parts.length ? parts.join(',') : '';
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
