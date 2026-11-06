/**
 * 排版镜头的视差数学（`typography/camera.ts`）。
 *
 * 这一层是**唯一**的镜头语义真源：舞台、光栅化、命中测试、缓存键都从它取数。
 * 所以这里断言的不是「大概对」，而是几个会被下游直接依赖的性质：
 *
 *  - depth 0 / 没有镜头 ⇒ **严格恒等**（加这个功能之前逐像素相同）；
 *  - depth 1 ⇒ 与「整个文档被镜头推过去」等价；
 *  - A_d 是相似变换 ⇒ 元素框仍是旋转矩形，逆变换存在且能往返；
 *  - 缓存键只跟「生效后」的变换走（全 depth 0 时摘要为空）。
 */

import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PARALLAX,
  applyParallax,
  cameraDensity,
  cameraOf,
  depthOf,
  inverseParallax,
  maxParallaxScale,
  parallaxCss,
  parallaxIsIdentity,
  parallaxOf,
  parallaxSignature,
  rasterDensity,
  screenFrame,
} from '../../src/typography/camera';
import {
  cameraIsIdentity,
  coerceCamera,
  coerceCameraPatch,
  createTextElement,
  createTypographyDocument,
  defaultCamera,
  mergeCamera,
  type Camera,
  type TypographyDocument,
} from '../../src/typography/document';
import { docHash, rasterKeyForDoc } from '../../src/typography/cache-key';

const SIZE = { w: 1000, h: 500 };
const CENTER = { x: 500, y: 250 };

function docWith(camera: Camera | undefined, depths: (number | undefined)[]): TypographyDocument {
  const doc = createTypographyDocument(SIZE);
  doc.elements = depths.map((depth, i) =>
    createTextElement(doc.size, {
      id: `e${i}`,
      text: `T${i}`,
      ...(depth === undefined ? {} : { depth }),
    }),
  );
  if (camera) doc.camera = camera;
  return doc;
}

function cam(over: Partial<Camera> = {}): Camera {
  return { ...defaultCamera(), ...over };
}

describe('缺省与恒等', () => {
  it('没有 camera ⇒ 恒等（parallaxCss 连字符串都不产出）', () => {
    const doc = docWith(undefined, [1]);
    const el = doc.elements[0]!;
    expect(parallaxIsIdentity(parallaxOf(doc, el))).toBe(true);
    expect(parallaxCss(doc, parallaxOf(doc, el), CENTER)).toBe('');
    expect(cameraDensity(doc)).toBe(1);
    expect(parallaxSignature(doc)).toBe('');
  });

  it('depth 0（缺省 / 显式 0）不吃镜头 —— 这是「没有 depth 的文档加镜头也一像素不变」', () => {
    const doc = docWith(cam({ zoom: 3, x: 240, rot: 20 }), [undefined, 0]);
    for (const el of doc.elements) {
      expect(parallaxIsIdentity(parallaxOf(doc, el))).toBe(true);
      expect(screenFrame(doc, el)).toEqual(el.frame);
    }
    expect(parallaxSignature(doc)).toBe('');
  });

  it('恒等镜头（显式写全默认值）与没有镜头等价', () => {
    const doc = docWith(cam(), [1]);
    expect(cameraIsIdentity(doc.camera)).toBe(true);
    expect(parallaxIsIdentity(parallaxOf(doc, doc.elements[0]!))).toBe(true);
  });
});

describe('深度加权', () => {
  it('depth 1 + zoom 2 ⇒ 绕画布中心放大 2 倍', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    const el = doc.elements[0]!;
    const p = parallaxOf(doc, el);
    expect(p.scale).toBe(2);
    // 画布中心不动，边角对称外扩。
    expect(applyParallax(doc, p, CENTER)).toEqual(CENTER);
    const f = screenFrame(doc, el);
    expect(f.w).toBe(el.frame.w * 2);
    expect(f.h).toBe(el.frame.h * 2);
    expect(f.x + f.w / 2).toBeCloseTo(el.frame.x + el.frame.w / 2 + (el.frame.x + el.frame.w / 2 - CENTER.x), 6);
  });

  it('depth 1 + 相机右移 100px ⇒ 元素左移 100px（镜头往右看）', () => {
    const doc = docWith(cam({ x: 100 }), [1]);
    const q = applyParallax(doc, parallaxOf(doc, doc.elements[0]!), { x: 500, y: 250 });
    expect(q.x).toBeCloseTo(400, 6);
    expect(q.y).toBeCloseTo(250, 6);
  });

  it('位移也按 zoom 放大（2× 的镜头移同样远，画面上挪的是两倍）', () => {
    const doc = docWith(cam({ x: 100, zoom: 2 }), [1]);
    const q = applyParallax(doc, parallaxOf(doc, doc.elements[0]!), { x: 500, y: 250 });
    expect(q.x).toBeCloseTo(500 - 200, 6);
  });

  it('depth 0.5 在「不动」与「完全跟随」之间线性插值', () => {
    const doc = docWith(cam({ x: 100, zoom: 3 }), [1, 0.5]);
    const [full, half] = doc.elements;
    expect(parallaxOf(doc, full!).scale).toBe(3);
    expect(parallaxOf(doc, half!).scale).toBe(2);
    const p0 = applyParallax(doc, parallaxOf(doc, half!), { x: 500, y: 250 });
    // 半深度：位移 −0.5·3·100 = −150。
    expect(p0.x).toBeCloseTo(350, 6);
  });

  it('depth 越界 / NaN 被夹住（它是渲染输入，不能把 transform 写成非法值）', () => {
    expect(depthOf({ depth: 3 })).toBe(1);
    expect(depthOf({ depth: -1 })).toBe(0);
    expect(depthOf({ depth: Number.NaN })).toBe(0);
    expect(depthOf({})).toBe(0);
  });
});

describe('相似变换（框仍是旋转矩形）', () => {
  it('旋转按 depth 加权，叠加在元素自身角度之上', () => {
    const doc = docWith(cam({ rot: 30 }), [1, 0.5]);
    const [full, half] = doc.elements;
    const pf = parallaxOf(doc, full!);
    expect((pf.rot * 180) / Math.PI).toBeCloseTo(30, 9);
    expect((parallaxOf(doc, half!).rot * 180) / Math.PI).toBeCloseTo(15, 9);
    // frame.rot 是元素自己的角度，与视差角度相加。
    expect(screenFrame(doc, full!).rot).toBeCloseTo(full!.frame.rot + pf.rot, 9);
  });

  it('逆变换能往返（手势把指针换算回元素空间的前提）', () => {
    const doc = docWith(cam({ x: 37, y: -24, zoom: 1.83, rot: 21 }), [1]);
    const p = parallaxOf(doc, doc.elements[0]!);
    for (const q of [
      { x: 0, y: 0 },
      { x: 123.4, y: 456.7 },
      CENTER,
    ]) {
      const round = inverseParallax(doc, p, applyParallax(doc, p, q));
      expect(round.x).toBeCloseTo(q.x, 6);
      expect(round.y).toBeCloseTo(q.y, 6);
    }
  });

  it('parallaxCss 的位移补偿让「绕自身原点」等价于「绕画布中心」', () => {
    const doc = docWith(cam({ x: 50, zoom: 2, rot: 10 }), [1]);
    const p = parallaxOf(doc, doc.elements[0]!);
    const origin = { x: 300, y: 200 };
    const css = parallaxCss(doc, p, origin);
    expect(css).toMatch(/^translate\(/);
    // `translate(dx, dy)` 那一项 = A(origin) − origin。
    const m = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(css);
    expect(m).not.toBeNull();
    const a = applyParallax(doc, p, origin);
    expect(Number(m![1])).toBeCloseTo(a.x - origin.x, 2);
    expect(Number(m![2])).toBeCloseTo(a.y - origin.y, 2);
    expect(css).toContain('rotate(10deg)');
    expect(css).toContain('scale(2)');
  });
});

describe('光栅化参数', () => {
  it('密度只取「被放大的最多那一层」，并封顶 2×', () => {
    expect(cameraDensity(docWith(cam({ zoom: 1.3 }), [1]))).toBeCloseTo(1.3, 9);
    expect(maxParallaxScale(docWith(cam({ zoom: 40 }), [1, 0.2]))).toBe(40);
    expect(cameraDensity(docWith(cam({ zoom: 40 }), [1]))).toBe(2);
    // 缩小不超采样。
    expect(cameraDensity(docWith(cam({ zoom: 0.4 }), [1]))).toBe(1);
    // 隐藏元素不参与。
    const doc = docWith(cam({ zoom: 3 }), [1]);
    doc.elements[0]!.visible = false;
    expect(cameraDensity(doc)).toBe(1);
  });

  it('缓存键：镜头变了但没有任何元素吃它 ⇒ 键逐字不变', () => {
    const a = docWith(cam(), [0]);
    const b = docWith(cam({ zoom: 2, x: 300 }), [0]);
    expect(rasterKeyForDoc(a, 800, 400, null)).toBe(rasterKeyForDoc(b, 800, 400, null));
    // camera / depth 不进 docHash，它们的像素效果由 parallaxSignature 表达。
    expect(docHash(a)).toBe(docHash(b));
  });

  it('缓存键：有元素吃镜头时，镜头变了就换键（帧号仍不带 —— 静态文档不逐帧重烘）', () => {
    const a = docWith(cam({ zoom: 1.5 }), [1]);
    const b = docWith(cam({ zoom: 1.6 }), [1]);
    expect(rasterKeyForDoc(a, 800, 400, null)).not.toBe(rasterKeyForDoc(b, 800, 400, null));
    expect(rasterKeyForDoc(a, 800, 400, null)).toContain('|-|');
  });

  it('缓存键：depth 改了也换键（它同样只在生效时才有意义）', () => {
    const a = docWith(cam({ zoom: 1.5 }), [0.4]);
    const b = docWith(cam({ zoom: 1.5 }), [0.8]);
    expect(rasterKeyForDoc(a, 800, 400, null)).not.toBe(rasterKeyForDoc(b, 800, 400, null));
  });

  it('缓存键：超采样密度进盐（同一片内容、不同像素结果）', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    const plain = rasterKeyForDoc(doc, 800, 400, null, { density: 1 });
    const dense = rasterKeyForDoc(doc, 800, 400, null, { density: 2 });
    expect(plain).not.toBe(dense);
  });
});

/**
 * 密度的**策略层**（`rasterDensity`）：不只是「最大缩放是多少」，还叠加
 * 「什么时候值得超采样」。四条都是会被静默破坏的：
 *
 *  - 播放中不降 ⇒ 白付 3–5ms/帧与一张 2× canvas（性能回退，画面不变）；
 *  - 导出 / 一次性烘焙跟着降 ⇒ **成片与「转为图片」的素材变糊**（更坏）；
 *  - 没人吃镜头时不为 1 ⇒ 位图尺寸与缓存键都变（老工程每帧重烘）。
 */
describe('超采样密度策略（rasterDensity）', () => {
  const EDGE = 4096;

  it('播放中降为 1；暂停（playing=false）回到完整密度', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    expect(rasterDensity(doc, 800, 400, { playing: true, edge: EDGE })).toBe(1);
    expect(rasterDensity(doc, 800, 400, { playing: false, edge: EDGE })).toBe(2);
  });

  it('导出永远不降（与 playing 同时为真时导出赢）', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    expect(rasterDensity(doc, 800, 400, { playing: true, exporting: true, edge: EDGE })).toBe(2);
  });

  it('一次性烘焙（转为图片 / 测试钩子）也不降', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    expect(rasterDensity(doc, 800, 400, { playing: true, oneShot: true, edge: EDGE })).toBe(2);
  });

  it('没人吃镜头 ⇒ 恒 1（播放与否都一样：位图尺寸与缓存键逐字不变）', () => {
    const doc = docWith(cam({ zoom: 2 }), [undefined, 0]);
    for (const playing of [true, false]) {
      expect(rasterDensity(doc, 800, 400, { playing, edge: EDGE })).toBe(1);
    }
  });

  it('按 rasterEdge 夹：目标边长已经贴上限时密度回落 1', () => {
    const doc = docWith(cam({ zoom: 2 }), [1]);
    // 800 宽只剩 1200 的余量 ⇒ 只能 1.5；1600 宽则一格都没有。
    expect(rasterDensity(doc, 800, 400, { playing: false, edge: 1200 })).toBe(1.5);
    expect(rasterDensity(doc, 1600, 900, { playing: false, edge: 1200 })).toBe(1);
  });

  it('缩放小于 1（cameraDensity 已是 1）不因策略变大', () => {
    const doc = docWith(cam({ zoom: 0.5 }), [1]);
    expect(rasterDensity(doc, 800, 400, { playing: false, edge: EDGE })).toBe(1);
  });
});

describe('输入归一化', () => {
  it('补丁只带出现过的键（只改 zoom 不会把平移 / 旋转重置）', () => {
    expect(coerceCameraPatch({ zoom: 2 })).toEqual({ zoom: 2 });
    expect(coerceCameraPatch({})).toBeNull();
    expect(coerceCameraPatch(null)).toBeNull();
    expect(coerceCameraPatch('x')).toBeNull();
  });

  it('合并到已有值上，越界夹取（zoom 0.05..40）', () => {
    const base = cam({ x: 12, y: -3, rot: 8 });
    expect(mergeCamera(base, { zoom: 100 })).toEqual({ x: 12, y: -3, rot: 8, zoom: 40 });
    expect(mergeCamera(base, { zoom: 0 })).toEqual({ x: 12, y: -3, rot: 8, zoom: 0.05 });
  });

  it('coerceCamera 从恒等起算（整份替换 / 读回形状用）', () => {
    expect(coerceCamera({ x: 5, rot: 12 })).toEqual({ x: 5, y: 0, zoom: 1, rot: 12 });
    expect(coerceCamera({})).toBeNull();
  });

  it('cameraOf 的缺省是恒等（面板拿到的永远是完整四个数）', () => {
    expect(cameraOf(createTypographyDocument(SIZE))).toEqual(defaultCamera());
    expect(IDENTITY_PARALLAX).toEqual({ tx: 0, ty: 0, rot: 0, scale: 1 });
  });
});
