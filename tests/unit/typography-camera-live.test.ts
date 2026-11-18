/**
 * 镜头下放到合成器（`docs/typography-perf.md` §B2）。
 *
 * 这一层最容易错、错了又**不报错**的是坐标空间：镜头活在文档坐标（y 向下），
 * placement 的 `u_center` 活在 GL 帧 uv（v 向上），而 `layerUvToFrameUv`
 * 的公开语义又是左上原点。桥接写错一次，画面会「平移方向反了」或
 * 「镜头一下降就往上飘」—— 而单看任何一半代码都是自洽的。
 *
 * 所以这里不比「形状像」，比的是**同一个文档点在两条路上的屏幕坐标**：
 *  - 旧路：先 `applyParallax`，再走一次 placement；
 *  - 新路：段位图（含留边）→ 一个新的 placement 参数。
 * 两者必须逐点相等。
 */

import { describe, expect, it } from 'vitest';
import {
  applyParallax,
  depthRuns,
  inverseParallax,
  parallaxMargin,
  parallaxOf,
} from '../../src/typography/camera';
import {
  cameraMarginOverTrack,
  upsertCameraKey,
  withCameraAt,
} from '../../src/typography/camera-tracks';
import {
  createTextElement,
  createTypographyDocument,
  defaultCamera,
  type Camera,
  type TypographyDocument,
} from '../../src/typography/document';
import { layerUvToFrameUv, type PlacementAffine } from '../../src/core/quad';
import { drawSizeFor } from '../../src/engine/placement.frag';

const SIZE = { w: 1000, h: 500 };

function docWith(depths: (number | undefined)[], camera?: Camera): TypographyDocument {
  const doc = createTypographyDocument(SIZE);
  doc.elements = depths.map((depth, i) =>
    createTextElement(doc.size, {
      id: `e${i}`,
      text: `T${i}`,
      frame: { x: 40 + i * 10, y: 60, w: 300, h: 80, rot: 0 },
      ...(depth === undefined ? {} : { depth }),
    }),
  );
  if (camera) doc.camera = camera;
  return doc;
}

function cam(over: Partial<Camera> = {}): Camera {
  return { ...defaultCamera(), ...over };
}

describe('分段（depthRuns）', () => {
  it('相邻同景深合成一段，顺序与 doc.elements 一致', () => {
    const doc = docWith([1, 1, 0, 0, 0.5]);
    const runs = depthRuns(doc);
    expect(runs.map((r) => r.ids)).toEqual([['e0', 'e1'], ['e2', 'e3'], ['e4']]);
    expect(runs.map((r) => r.depth)).toEqual([1, 0, 0.5]);
  });

  it('交错景深不合并 —— 分桶会改层叠顺序', () => {
    const runs = depthRuns(docWith([1, 0, 1]));
    expect(runs.map((r) => r.ids)).toEqual([['e0'], ['e1'], ['e2']]);
  });

  it('隐藏元素不占段', () => {
    const doc = docWith([1, 1, 1]);
    doc.elements[1]!.visible = false;
    expect(depthRuns(doc)).toEqual([{ ids: ['e0', 'e2'], depth: 1 }]);
  });

  it('缺省 depth 与 depth 0 是同一段', () => {
    const runs = depthRuns(docWith([undefined, 0, undefined]));
    expect(runs.length).toBe(1);
    expect(runs[0]!.depth).toBe(0);
  });
});

describe('留边（parallaxMargin）', () => {
  it('推近不需要留边（画布外的东西本来就出画）', () => {
    const doc = docWith([1], cam({ zoom: 2 }));
    const m = parallaxMargin(doc, parallaxOf(doc, { depth: 1 }));
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo(0, 9);
  });

  it('拉远按 1/s 外扩：zoom 0.5 ⇒ 每边半个画布', () => {
    const doc = docWith([1], cam({ zoom: 0.5 }));
    const m = parallaxMargin(doc, parallaxOf(doc, { depth: 1 }));
    expect(m.x).toBeCloseTo(SIZE.w / 2, 6);
    expect(m.y).toBeCloseTo(SIZE.h / 2, 6);
  });

  it('只摇不移也能算出来：x=100 需要右边 100px', () => {
    const doc = docWith([1], cam({ x: 100 }));
    const m = parallaxMargin(doc, parallaxOf(doc, { depth: 1 }));
    expect(m.x).toBeCloseTo(100, 6);
    expect(m.y).toBeCloseTo(0, 6);
  });

  it('depth 0 恒等 ⇒ 零留边', () => {
    const doc = docWith([0], cam({ zoom: 0.2, x: 400 }));
    expect(parallaxMargin(doc, parallaxOf(doc, { depth: 0 }))).toEqual({ x: 0, y: 0 });
  });

  it('整条轨道取最大：zoom 2 → 0.5 的段里每个采样点都被罩住', () => {
    const doc = docWith([1]);
    upsertCameraKey(doc, 'zoom', 0, 2);
    upsertCameraKey(doc, 'zoom', 2, 0.5);
    const m = cameraMarginOverTrack(doc, 2);
    for (let i = 0; i <= 20; i += 1) {
      const view = withCameraAt(doc, (2 * i) / 20);
      const need = parallaxMargin(view, parallaxOf(view, { depth: 1 }));
      expect(need.x).toBeLessThanOrEqual(m.x + 1e-6);
      expect(need.y).toBeLessThanOrEqual(m.y + 1e-6);
    }
  });
});

/**
 * 分段 placement 的完整参数（与 `compositor.ts::placeCameraLayers` 同一份算式）。
 *
 * 抽成函数不是为了复用，是为了**让测试跑的就是生产算式**：两处各写一遍的话，
 * 单测通过只能证明测试自己是对的。
 */
function camAffineOf(args: {
  doc: TypographyDocument;
  depth: number;
  frameW: number;
  frameH: number;
  transform: { x: number; y: number; sx: number; sy: number; rot: number };
  margin: { x: number; y: number };
}): { affine: PlacementAffine; coverW: number; coverH: number } {
  const { doc, depth, frameW, frameH, transform, margin } = args;
  const p = parallaxOf(doc, { depth });
  const docW = doc.size.w;
  const docH = doc.size.h;
  const [dw, dh] = drawSizeFor('contain', frameW, frameH, docW, docH, transform.sx, transform.sy);
  const k = dw / docW;
  const cd = Math.cos(transform.rot);
  const sd = Math.sin(transform.rot);
  const baseX = transform.x * frameW;
  const baseY = (1 - transform.y) * frameH;
  const coverW = docW + margin.x * 2;
  const coverH = docH + margin.y * 2;
  /*
   * 符号：placement 的 `u_rot` 在屏幕上**逆时针**为正（`layerUvToFrameUvGl` 的
   * `[[c,−s],[s,c]]` 作用在 GL y-up 上），而镜头 `φ` 与 CSS 一样**顺时针**为正。
   * 所以两者是「相减」而不是相加 —— 写成 `rot + φ` 时纯平移仍然对得上，
   * 只有带角度时才有一圈偏差。
   */
  const cxd = baseX + k * (cd * p.tx + sd * p.ty);
  const cyd = baseY + k * (-sd * p.tx + cd * p.ty);
  return {
    coverW,
    coverH,
    affine: {
      frameW,
      frameH,
      drawW: k * p.scale * coverW,
      drawH: k * p.scale * coverH,
      cx: cxd / frameW,
      cy: 1 - cyd / frameH,
      rot: transform.rot - p.rot,
    },
  };
}

/** 旧路：镜头先作用在文档点上，再走一次 placement（= 镜头烘进位图）。 */
function exactScreenUv(
  doc: TypographyDocument,
  depth: number,
  frameW: number,
  frameH: number,
  transform: { x: number; y: number; sx: number; sy: number; rot: number },
  q: { x: number; y: number },
): [number, number] {
  const [dw, dh] = drawSizeFor(
    'contain',
    frameW,
    frameH,
    doc.size.w,
    doc.size.h,
    transform.sx,
    transform.sy,
  );
  const base: PlacementAffine = {
    frameW,
    frameH,
    drawW: dw,
    drawH: dh,
    cx: transform.x,
    cy: transform.y,
    rot: transform.rot,
  };
  const p = applyParallax(doc, parallaxOf(doc, { depth }), q);
  return layerUvToFrameUv(base, p.x / doc.size.w, p.y / doc.size.h);
}

describe('段位图 → placement 与「镜头烘进位图」逐点相等', () => {
  const cases: { label: string; camera: Camera; transform: { x: number; y: number; sx: number; sy: number; rot: number } }[] = [
    {
      label: '推近 + 平移',
      camera: cam({ zoom: 1.7, x: 40, y: -30 }),
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    },
    {
      label: '推近 + 旋转 + 片段自己也有旋转与非居中摆放',
      camera: cam({ zoom: 1.35, x: -55, y: 25, rot: 12 }),
      transform: { x: 0.42, y: 0.66, sx: 0.85, sy: 0.85, rot: 0.3 },
    },
    {
      label: '拉远（需要留边）',
      camera: cam({ zoom: 0.6, x: 10, y: 5, rot: -8 }),
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: -0.2 },
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const frameW = 640;
      const frameH = 480;
      const depth = 0.8;
      const doc = docWith([depth], c.camera);
      const margin = parallaxMargin(doc, parallaxOf(doc, { depth }));
      // 故意比需要的多留一圈：多留不该改变画面（placement 会把它摆回去）。
      const padded = { x: margin.x + 120, y: margin.y + 90 };
      const { affine, coverW, coverH } = camAffineOf({
        doc,
        depth,
        frameW,
        frameH,
        transform: c.transform,
        margin: padded,
      });

      const corners = [
        { x: 0, y: 0 },
        { x: doc.size.w, y: 0 },
        { x: 0, y: doc.size.h },
        { x: doc.size.w, y: doc.size.h },
        { x: doc.size.w * 0.37, y: doc.size.h * 0.62 },
      ];
      for (const q of corners) {
        const want = exactScreenUv(doc, depth, frameW, frameH, c.transform, q);
        const lu = (q.x + padded.x) / coverW;
        const lv = (q.y + padded.y) / coverH;
        const got = layerUvToFrameUv(affine, lu, lv);
        expect(got[0]).toBeCloseTo(want[0], 9);
        expect(got[1]).toBeCloseTo(want[1], 9);
      }
    });
  }

  it('留边够用时，镜头会把「画布矩形」的整块原像留在位图里', () => {
    /*
     * 判据是**画布矩形**的原像，不是画面四角：`fit: contain` 下画布比画面小，
     * 画面四角本来就在画布外（留边也补不到那儿）。真正需要保证的是：
     * 任何「镜头之后落进画布」的像素，在静置位图里都有对应位置。
     */
    const depth = 1;
    const doc = docWith([depth], cam({ zoom: 0.5, x: 60, y: -40, rot: 6 }));
    const p = parallaxOf(doc, { depth });
    const margin = parallaxMargin(doc, p);
    for (const q of [
      { x: 0, y: 0 },
      { x: doc.size.w, y: 0 },
      { x: 0, y: doc.size.h },
      { x: doc.size.w, y: doc.size.h },
    ]) {
      const src = inverseParallax(doc, p, q);
      expect(src.x).toBeGreaterThanOrEqual(-margin.x - 1e-6);
      expect(src.x).toBeLessThanOrEqual(doc.size.w + margin.x + 1e-6);
      expect(src.y).toBeGreaterThanOrEqual(-margin.y - 1e-6);
      expect(src.y).toBeLessThanOrEqual(doc.size.h + margin.y + 1e-6);
    }
  });
});
