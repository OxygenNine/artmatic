/**
 * 元素反向导出（`typography/element-export.ts`）的纯函数层。
 *
 * 这里钉的是三个「导错了看不出来」的判据：
 *  - 包围盒要含**旋转后的四角**与描边 / 阴影的外扩（少算 = 边缘被切掉一圈）；
 *  - 子文档必须**只含选中元素**、坐标平移到 0,0、镜头**烘进 frame 后摘掉**
 *    （留着 camera 会被下游再算一遍视差 = 镜头应用两次）；
 *  - 组合底板只在**整组都在**时跟出来（否则导出的素材凭空多一圈底）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildExportDoc,
  canExportSvg,
  elementsForExport,
  exportBoxOf,
} from '../../src/typography/element-export';
import {
  createShapeElement,
  createTextElement,
  createTypographyDocument,
  defaultCamera,
  type TypographyDocument,
  type TypographyElement,
} from '../../src/typography/document';
import { createTracksAnimation } from '../../src/typography/animation';

const SIZE = { w: 1000, h: 500 };

function docWith(elements: TypographyElement[], extra: Partial<TypographyDocument> = {}): TypographyDocument {
  const doc = createTypographyDocument(SIZE);
  doc.elements = elements;
  return Object.assign(doc, extra);
}

function rect(id: string, over: Partial<Parameters<typeof createShapeElement>[2]> = {}) {
  return createShapeElement(SIZE, 'rect', { id, fill: { kind: 'solid', color: '#ffffff' }, stroke: null, ...over });
}

describe('exportBoxOf', () => {
  it('单个矩形 = 它自己的框（不扩不缩）', () => {
    const doc = docWith([rect('a', { frame: { x: 100, y: 50, w: 200, h: 100, rot: 0 } })]);
    expect(exportBoxOf(doc, ['a'])).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });

  it('旋转 45° 的正方形按**外接矩形**算，不是原框', () => {
    const doc = docWith([rect('a', { frame: { x: 0, y: 0, w: 100, h: 100, rot: Math.PI / 4 } })]);
    const box = exportBoxOf(doc, ['a'])!;
    // 对角线 100√2 ≈ 141.42 → 取整后 142（左右各含半个像素余量）
    expect(box.w).toBe(Math.ceil(100 * Math.SQRT2));
    expect(box.h).toBe(Math.ceil(100 * Math.SQRT2));
  });

  it('描边与阴影把框撑出去（否则导出边缘被切一圈）', () => {
    const doc = docWith([
      rect('a', {
        frame: { x: 100, y: 50, w: 100, h: 100, rot: 0 },
        stroke: { color: '#000000', width: 20 },
        shadows: [{ color: '#000000', dx: 0, dy: 12, blur: 28 }],
      }),
    ]);
    const box = exportBoxOf(doc, ['a'])!;
    // 外扩量 = max(描边半宽 10, 阴影 |12| + 28 = 40)
    expect(box).toEqual({ x: 60, y: 10, w: 180, h: 180 });
  });

  it('多个元素取并集；隐藏的与未选中的都不算', () => {
    const doc = docWith([
      rect('a', { frame: { x: 100, y: 100, w: 100, h: 100, rot: 0 } }),
      rect('b', { frame: { x: 300, y: 200, w: 100, h: 100, rot: 0 } }),
      rect('hidden', { frame: { x: 0, y: 0, w: 900, h: 400, rot: 0 }, visible: false }),
      rect('other', { frame: { x: -500, y: -500, w: 10, h: 10, rot: 0 } }),
    ]);
    expect(exportBoxOf(doc, ['a', 'b', 'hidden'])).toEqual({ x: 100, y: 100, w: 300, h: 200 });
  });

  it('全是隐藏元素 → null（没有可导出的东西）', () => {
    const doc = docWith([rect('a', { visible: false })]);
    expect(exportBoxOf(doc, ['a'])).toBeNull();
    expect(elementsForExport(doc, ['a'])).toEqual([]);
  });
});

describe('buildExportDoc', () => {
  it('坐标平移到 0,0，尺寸 = 包围盒，背景透明', () => {
    const doc = docWith([rect('a', { frame: { x: 100, y: 50, w: 200, h: 100, rot: 0 } })], {
      background: { kind: 'solid', color: '#112233' },
    });
    const built = buildExportDoc(doc, ['a'])!;
    expect(built.box).toEqual({ x: 100, y: 50, w: 200, h: 100 });
    expect(built.doc.size).toEqual({ w: 200, h: 100 });
    expect(built.doc.elements[0]!.frame).toEqual({ x: 0, y: 0, w: 200, h: 100, rot: 0 });
    expect(built.doc.background).toEqual({ kind: 'none' });
    // 原文档不受影响（子文档是视图拷贝）
    expect(doc.elements[0]!.frame.x).toBe(100);
  });

  it('镜头视差**烘进** frame，并把 camera / 镜头轨道一起摘掉', () => {
    const doc = docWith([rect('a', { frame: { x: 400, y: 200, w: 100, h: 100, rot: 0 }, depth: 1 })], {
      camera: { ...defaultCamera(), zoom: 2 },
      animations: [createTracksAnimation('camera-zoom', 'camera.zoom', [{ t: 0, v: 2 }])],
    });
    const built = buildExportDoc(doc, ['a'])!;
    // 画布中心 (500,250)：框中心 (450,250) 放大 2× ⇒ (400,250)，边长 200
    expect(built.box).toEqual({ x: 300, y: 150, w: 200, h: 200 });
    expect(built.doc.elements[0]!.frame).toEqual({ x: 0, y: 0, w: 200, h: 200, rot: 0 });
    expect(built.doc.camera).toBeUndefined();
    // 镜头轨道留着会被 `withCameraAt` 再算一遍视差
    expect(built.doc.animations).toEqual([]);
  });

  it('组合底板只在整组成员都在选择集里时才带上', () => {
    // `createShapeElement` 不收 `groupId`（它由成组动作写），所以这里手动挂。
    const a = rect('a');
    const b = rect('b');
    a.groupId = 'g1';
    b.groupId = 'g1';
    const doc = docWith([a, b, rect('c')]);
    expect(buildExportDoc(doc, ['a'])!.doc.elements[0]!.groupId).toBeUndefined();
    const whole = buildExportDoc(doc, ['a', 'b'])!.doc.elements;
    expect(whole.map((el) => el.groupId)).toEqual(['g1', 'g1']);
  });

  it('整组都选中时包围盒把组合内边距与描边算进去（否则底板被裁掉一圈）', () => {
    const a = rect('a', { frame: { x: 100, y: 100, w: 100, h: 100, rot: 0 } });
    const b = rect('b', { frame: { x: 200, y: 100, w: 100, h: 100, rot: 0 } });
    a.groupId = 'g1';
    b.groupId = 'g1';
    const doc = docWith([a, b], {
      groups: [{ id: 'g1', name: 'g', fill: { kind: 'none' }, stroke: null, radius: 0, padding: 10 }],
    });
    // 成员并集 200×100，底板各边再外扩 10
    expect(exportBoxOf(doc, ['a', 'b'])).toEqual({ x: 90, y: 90, w: 220, h: 120 });
    // 只选一个成员：不带底板，所以不扩
    expect(exportBoxOf(doc, ['a'])).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
});

describe('canExportSvg', () => {
  it('全是图形 → 可以', () => {
    expect(canExportSvg([rect('a'), rect('b')])).toBe(true);
  });

  it('混了文字 / 图片 → 不可以（矢量表达不了，静默丢一半更坏）', () => {
    expect(canExportSvg([rect('a'), createTextElement(SIZE, { id: 't' })])).toBe(false);
  });

  it('隐藏元素不参与判定；全隐藏 → 不可以', () => {
    const hiddenText = createTextElement(SIZE, { id: 't', visible: false });
    expect(canExportSvg([rect('a'), hiddenText])).toBe(true);
    expect(canExportSvg([hiddenText])).toBe(false);
    expect(canExportSvg([])).toBe(false);
  });
});
