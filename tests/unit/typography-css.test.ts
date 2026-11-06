import { describe, expect, it } from 'vitest';
import {
  animLayerStyle,
  docStyle,
  elementStyle,
  glyphStrokeStyle,
  imageStyle,
  paintCss,
  paintToBackground,
  shapePaintAttrs,
  spanStyle,
  strokePaintDefId,
  textBoxStyle,
  textFillBackgroundImage,
  textFillStyle,
  textStyle,
  textureMotifSpec,
} from '../../src/typography/css';
import {
  createShapeElement,
  createTextElement,
  createTypographyDocument,
  defaultTextStyle,
  defaultTransform3D,
} from '../../src/typography/document';
import type { Paint } from '../../src/typography/document';

const SIZE = { w: 1000, h: 500 };
const doc = createTypographyDocument(SIZE);

describe('paintCss', () => {
  it('none → transparent，solid → 颜色值', () => {
    expect(paintCss({ kind: 'none' })).toBe('transparent');
    expect(paintCss({ kind: 'solid', color: '#ff0000' })).toBe('#ff0000');
  });
});

describe('docStyle', () => {
  it('尺寸是文档的自然尺寸', () => {
    const s = docStyle(doc);
    expect(s.width).toBe('1000px');
    expect(s.height).toBe('500px');
    expect(s.position).toBe('relative');
  });

  it('必须 isolation: isolate —— 否则元素会与编辑器页面背景混合', () => {
    // 这条不加的话，预览里 mix-blend-mode 的基准是编辑器 UI，导出时是黑底，
    // 两边不一致，而且「看起来都正常」，极难定位。
    expect(docStyle(doc)['isolation']).toBe('isolate');
  });

  it('不注入背景色 —— 排版层是要叠到画面上的，自带底会把下面全盖住', () => {
    expect(docStyle(doc)).not.toHaveProperty('background');
    expect(docStyle(doc)).not.toHaveProperty('background-color');
  });

  it('显式声明 font-family —— 继承宿主界面字体的话，snapDOM 会把界面字体内联进每次捕获', () => {
    // 实测（2026-11-06）：根不写字体时，13 MB 的界面 CJK webfont 会进
    // snapDOM 的 embedFonts 清单，单次捕获 20ms → 500ms，每帧都付。
    expect(docStyle(doc)['font-family']).toBe('"Inter"');
  });
});

describe('elementStyle', () => {
  it('几何用 px、旋转用角度', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, { frame: { x: 10, y: 20, w: 300, h: 40, rot: Math.PI / 2 } });
    const s = elementStyle(el);
    expect(s.left).toBe('10px');
    expect(s.top).toBe('20px');
    expect(s.width).toBe('300px');
    expect(s.height).toBe('40px');
    expect(s.transform).toBe('rotate(90deg)');
  });

  it('没有旋转时 transform 是 none，不写 rotate(0deg)', () => {
    const d = createTypographyDocument(SIZE);
    expect(elementStyle(createTextElement(d.size)).transform).toBe('none');
  });

  it('不透明度传字符串、混合模式直传', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, { opacity: 0.5, blend: 'screen' });
    const s = elementStyle(el);
    expect(s.opacity).toBe('0.5');
    expect(s['mix-blend-mode']).toBe('screen');
  });

  it('外层不吃指针事件（选择由编辑器自己算，不让 DOM 抢）', () => {
    const d = createTypographyDocument(SIZE);
    expect(elementStyle(createTextElement(d.size))['pointer-events']).toBe('none');
  });

  it('没有 3D 时仍写出三个复位键（就地同步没有删除语义）', () => {
    const d = createTypographyDocument(SIZE);
    const s = elementStyle(createTextElement(d.size));
    // 只 set 不 delete ⇒ 从「启用 3D」切回关闭时，靠这三个默认值把上一份盖掉。
    expect(s['transform-origin']).toBe('50% 50%');
    expect(s['backface-visibility']).toBe('visible');
    expect(s['transform-style']).toBe('flat');
  });

  it('3D：固定顺序，frame.rot 合进 rotateZ', () => {
    const d = createTypographyDocument(SIZE);
    const t = defaultTransform3D();
    t.perspective = 1000;
    t.rotate.x = 20;
    t.rotate.y = 10;
    t.translate.z = 40;
    const el = createTextElement(d.size, {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: Math.PI / 2 },
      transform3d: t,
    });
    // 顺序是约定（见 document.ts::Transform3D）：改顺序 = 改已有工程的画面。
    expect(elementStyle(el).transform).toBe(
      'perspective(1000px) translate3d(0px, 0px, 40px) rotateX(20deg) rotateY(10deg) rotateZ(90deg)',
    );
  });

  it('3D：勾了启用但没调时只剩 perspective（单位矩阵，画面不变）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, { transform3d: defaultTransform3D() });
    // perspective() 单独存在时矩阵是单位矩阵；写出来是为了与面板上的 800 对得上。
    expect(elementStyle(el).transform).toBe('perspective(800px)');
  });

  it('3D：perspective 为 0 且其余恒等时 transform 是 none', () => {
    const d = createTypographyDocument(SIZE);
    const t = defaultTransform3D();
    t.perspective = 0;
    const el = createTextElement(d.size, { transform3d: t });
    expect(elementStyle(el).transform).toBe('none');
  });

  it('3D：原点走百分比，背面 / 保留 3D 直传', () => {
    const d = createTypographyDocument(SIZE);
    const t = defaultTransform3D();
    t.origin = { x: 0.2, y: 0.8 };
    t.backface = 'hidden';
    t.style = 'preserve-3d';
    const s = elementStyle(createTextElement(d.size, { transform3d: t }));
    expect(s['transform-origin']).toBe('20% 80%');
    expect(s['backface-visibility']).toBe('hidden');
    expect(s['transform-style']).toBe('preserve-3d');
  });

  it('3D：perspective 为 0 时不写 perspective()（近似正交）', () => {
    const d = createTypographyDocument(SIZE);
    const t = defaultTransform3D();
    t.perspective = 0;
    t.rotate.y = 15;
    const el = createTextElement(d.size, { transform3d: t });
    expect(elementStyle(el).transform).toBe('rotateY(15deg)');
  });
});

describe('animLayerStyle', () => {
  it('内层铺满并带中心变换原点', () => {
    const s = animLayerStyle();
    expect(s.width).toBe('100%');
    expect(s.height).toBe('100%');
    expect(s['transform-origin']).toBe('50% 50%');
  });
});

describe('textStyle', () => {
  const base = defaultTextStyle(SIZE);

  it('字号与字距是 px，行高是纯数字', () => {
    const s = textStyle({ ...base, fontSize: 48, letterSpacing: 2, lineHeight: 1.5 });
    expect(s['font-size']).toBe('48px');
    expect(s['letter-spacing']).toBe('2px');
    expect(s['line-height']).toBe('1.5');
  });

  it('垂直对齐映射到 flex 的 justify-content', () => {
    expect(textStyle({ ...base, vAlign: 'top' })['justify-content']).toBe('flex-start');
    expect(textStyle({ ...base, vAlign: 'middle' })['justify-content']).toBe('center');
    expect(textStyle({ ...base, vAlign: 'bottom' })['justify-content']).toBe('flex-end');
  });

  it('水平对齐直传 text-align', () => {
    expect(textStyle({ ...base, align: 'justify' })['text-align']).toBe('justify');
  });

  it('竖排时主轴翻转（垂直对齐在视觉上变成水平）', () => {
    const s = textStyle({ ...base, writingMode: 'vertical-rl' });
    expect(s['flex-direction']).toBe('row');
    expect(s['writing-mode']).toBe('vertical-rl');
  });

  it('横排时主轴是列', () => {
    expect(textStyle(base)['flex-direction']).toBe('column');
  });

  it('保留换行与长词折行（否则多行文本会挤成一行）', () => {
    const s = textStyle(base);
    expect(s['white-space']).toBe('pre-wrap');
    expect(s['word-break']).toBe('break-word');
  });

  it('撑满元素框', () => {
    const s = textStyle(base);
    expect(s.width).toBe('100%');
    expect(s.height).toBe('100%');
    expect(s.position).toBe('absolute');
  });

  it('族名必须加引号 —— 「HYPixel 11px」裸拼会让整条声明失效', () => {
    // 本机像素字体（汉仪像素 11px U / HYPixel 11px）的族名里带 `11px`：
    // 裸拼时 `11px` 被解析成 dimension 而不是 ident，`font-family: HYPixel 11px`
    // 整条声明被判非法 ⇒ 元素**静默**继承界面字体。字体下拉早就过 cssFamily，
    // 所以症状是「下拉里是像素字形、舞台上回退到系统字体」。
    expect(textStyle({ ...base, fontFamily: 'HYPixel 11px' })['font-family']).toBe('"HYPixel 11px"');
    // 通用族不能加引号（`"serif"` 是一个叫 serif 的具体字体）
    expect(textStyle({ ...base, fontFamily: 'serif' })['font-family']).toBe('serif');
    // 存的是族列表时只取第一个（与 text-outline / familyRenders 同口径）
    expect(textStyle({ ...base, fontFamily: '"Inter", sans-serif' })['font-family']).toBe('"Inter"');
  });
});

describe('spanStyle：行内覆盖', () => {
  it('行内换字体同样要加引号（否则只有那一段悄悄回退）', () => {
    expect(spanStyle({ fontFamily: 'HYPixel 11px' })['font-family']).toBe('"HYPixel 11px"');
    expect(spanStyle({ fontFamily: 'serif' })['font-family']).toBe('serif');
  });
});

describe('shapePaintAttrs', () => {
  it('无描边时 fill 生效、stroke 为 none', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      fill: { kind: 'solid', color: '#123456' },
    });
    const a = shapePaintAttrs(el);
    expect(a.fill).toBe('#123456');
    expect(a.stroke).toBe('none');
  });

  it('描边宽度直接用文档 px（viewBox 与元素盒等尺寸）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 200, h: 100, rot: 0 },
      stroke: { color: '#fff', width: 3 },
    });
    // 不做任何换算：非等比缩放时边框不会一边粗一边细
    expect(shapePaintAttrs(el)['stroke-width']).toBe('3');
  });

  it('虚线 / 点线映射到 dasharray', () => {
    const d = createTypographyDocument(SIZE);
    const dashed = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      stroke: { color: '#fff', width: 1, style: 'dashed' },
    });
    const dotted = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      stroke: { color: '#fff', width: 1, style: 'dotted' },
    });
    expect(shapePaintAttrs(dashed)['stroke-dasharray']).toBeTruthy();
    expect(shapePaintAttrs(dotted)['stroke-dasharray']).toBeTruthy();
    expect(shapePaintAttrs(dashed)['stroke-dasharray']).not.toBe(shapePaintAttrs(dotted)['stroke-dasharray']);
  });

  it('描边宽度与元素尺寸无关（所以不等比缩放不会把边框拉歪）', () => {
    const d = createTypographyDocument(SIZE);
    const mk = (w: number, h: number) =>
      createShapeElement(d.size, 'rect', {
        frame: { x: 0, y: 0, w, h, rot: 0 },
        stroke: { color: '#fff', width: 5 },
      });
    expect(shapePaintAttrs(mk(50, 50))['stroke-width']).toBe('5');
    expect(shapePaintAttrs(mk(500, 20))['stroke-width']).toBe('5');
  });

  it('负宽度的描边被钳到 0，不产生 NaN', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 0, h: 0, rot: 0 },
      stroke: { color: '#fff', width: -2 },
    });
    expect(shapePaintAttrs(el)['stroke-width']).toBe('0');
  });
});

describe('imageStyle', () => {
  it('无裁剪时图片铺满、fit 直传', () => {
    const d = createTypographyDocument(SIZE);
    const { wrapper, img } = imageStyle({
      kind: 'image', id: 'i', name: '', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      blend: 'normal', opacity: 1, visible: true, locked: false, animations: [],
      assetId: 'a', fit: 'contain',
    });
    expect(wrapper.overflow).toBe('hidden');
    expect(img.width).toBe('100%');
    expect(img.height).toBe('100%');
    expect(img['object-fit']).toBe('contain');
  });

  it('裁剪窗把源图放大并偏移，正好铺满元素框', () => {
    const d = createTypographyDocument(SIZE);
    const { img } = imageStyle({
      kind: 'image', id: 'i', name: '', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      blend: 'normal', opacity: 1, visible: true, locked: false, animations: [],
      assetId: 'a', fit: 'fill', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    });
    expect(img.width).toBe('200.0000%');
    expect(img.height).toBe('200.0000%');
    expect(img.left).toBe('-50.0000%');
    expect(img.top).toBe('-50.0000%');
  });

  it('退化的裁剪窗（宽或高为 0）走无裁剪分支，不产生 Infinity', () => {
    const d = createTypographyDocument(SIZE);
    const { img } = imageStyle({
      kind: 'image', id: 'i', name: '', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      blend: 'normal', opacity: 1, visible: true, locked: false, animations: [],
      assetId: 'a', fit: 'cover', crop: { x: 0, y: 0, w: 0, h: 0 },
    });
    expect(img.width).toBe('100%');
    expect(JSON.stringify(img)).not.toContain('Infinity');
    expect(JSON.stringify(img)).not.toContain('NaN');
  });

  it('圆角作用在裁窗上', () => {
    const d = createTypographyDocument(SIZE);
    const { wrapper } = imageStyle({
      kind: 'image', id: 'i', name: '', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      blend: 'normal', opacity: 1, visible: true, locked: false, animations: [],
      assetId: 'a', fit: 'cover', radius: 8,
    });
    expect(wrapper['border-radius']).toBe('8px');
  });
});

/*
 * 「舞台与光栅化必须同源」不在这里断言：同源是**结构性**的 —— 两条路径都调
 * `elementStyle` / `textStyle`，没有第二份声明表可以漂移。原先是拿
 * `expect(elementStyle(el)).toEqual(elementStyle(el))` 来"守"它，
 * 那条永远不可能红（纯函数两次调用必然相等），已删。
 */

describe('填充整体不透明度', () => {
  it('shapePaintAttrs：不透明时不写 fill-opacity（老工程渲染结果逐字节不变）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      fill: { kind: 'solid', color: '#123456' },
    });
    expect(shapePaintAttrs(el)).not.toHaveProperty('fill-opacity');
  });

  it('shapePaintAttrs：半透明时 fill-opacity 出现在**同一个** <path> 上（一处覆盖三种填充）', () => {
    const d = createTypographyDocument(SIZE);
    const withOp = (fill: Paint) =>
      shapePaintAttrs(
        createShapeElement(d.size, 'rect', { frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 }, fill }),
      )['fill-opacity'];
    expect(
      withOp({ kind: 'solid', color: '#123456', opacity: 0.5 }),
    ).toBe('0.5');
    // 渐变 / 纹理同样走这一个属性，不必分别处理
    expect(
      withOp({ kind: 'linear', angle: 0, stops: [], opacity: 0.25 }),
    ).toBe('0.25');
    expect(
      withOp({ kind: 'texture', pattern: 'dots', color: '#fff', bg: '#000', scale: 10, thickness: 2, opacity: 0.75 }),
    ).toBe('0.75');
  });

  it('paintToBackground：不透明原样，半透明走 color-mix（纯色 / 色标 / 纹理底色）', () => {
    expect(paintToBackground({ kind: 'solid', color: '#ff0000' })).toBe('#ff0000');
    expect(paintToBackground({ kind: 'solid', color: '#ff0000', opacity: 0.5 })).toBe(
      'color-mix(in srgb, #ff0000 50%, transparent)',
    );
    const grad = paintToBackground({
      kind: 'linear',
      angle: 0,
      stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
      opacity: 0.5,
    });
    expect(grad).toContain('color-mix(in srgb, #ff0000 50%, transparent) 0%');
    expect(grad).toContain('color-mix(in srgb, #0000ff 50%, transparent) 100%');
    // 组合壳的纹理回落到**底色**，所以透明度只乘底色
    expect(paintToBackground({ kind: 'texture', pattern: 'dots', color: '#fff', bg: '#000', scale: 10, thickness: 2, opacity: 0.5 })).toBe(
      'color-mix(in srgb, #000 50%, transparent)',
    );
  });
});

describe('textFillStyle（文本字形填充）', () => {
  it('线性渐变 → background-clip: text + 透明字形色', () => {
    const s = textFillStyle({ kind: 'linear', angle: 90, stops: [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' },
    ] });
    expect(s['background-clip']).toBe('text');
    expect(s['-webkit-background-clip']).toBe('text');
    expect(s.color).toBe('transparent');
    expect(s['background-image']).toContain('linear-gradient');
  });

  it('纹理 → 内联 SVG data-URI 并按周期平铺', () => {
    const s = textFillStyle({
      kind: 'texture', pattern: 'dots', color: '#fff', bg: '#000', scale: 20, thickness: 3,
    });
    expect(s['background-image']).toContain('data:image/svg+xml');
    expect(s['background-size']).toBe('20px 20px');
    expect(s['background-repeat']).toBe('repeat');
    expect(s['background-clip']).toBe('text');
  });

  it('none / solid / undefined → 复位（回到 style.color 纯色字形）', () => {
    for (const f of [undefined, { kind: 'none' } as const, { kind: 'solid', color: '#fff' } as const]) {
      const s = textFillStyle(f);
      expect(s['background-clip']).toBe('border-box');
      expect(s['background-image']).toBe('none');
      // 不复位颜色，交给 textStyle 的 style.color
      expect(s.color).toBeUndefined();
    }
  });

  it('不透明度乘进渐变色标', () => {
    const img = textFillBackgroundImage({
      kind: 'radial', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], opacity: 0.5,
    });
    expect(img).toContain('color-mix(in srgb, #ff0000 50%, transparent)');
  });
});

describe('textBoxStyle（文本框背景 / 边框）', () => {
  const withBox = (over: Parameters<typeof createTextElement>[1]) =>
    textBoxStyle(createTextElement(SIZE, over));

  it('无背景无边框时是一份**完整**的复位声明（就地同步不会残留上一份）', () => {
    const s = withBox({});
    expect(s['background-color']).toBe('transparent');
    expect(s['background-image']).toBe('none');
    expect(s['background-size']).toBe('auto');
    expect(s.border).toBe('0 solid transparent');
  });

  it('纯色背景 → background-color，背景图保持 none', () => {
    const s = withBox({ boxFill: { kind: 'solid', color: '#ff0000' } });
    expect(s['background-color']).toBe('#ff0000');
    expect(s['background-image']).toBe('none');
  });

  it('渐变 → background-image（带所有色标与位置）', () => {
    const s = withBox({
      boxFill: {
        kind: 'linear',
        angle: 0,
        stops: [
          { offset: 0, color: '#ff0000' },
          { offset: 0.25, color: '#00ff00' },
          { offset: 1, color: '#0000ff' },
        ],
      },
    });
    expect(s['background-image']).toContain('linear-gradient');
    expect(s['background-image']).toContain('25%');
  });

  it('纹理 → 内联 SVG 平铺（不是回落到纯底色）', () => {
    const s = withBox({
      boxFill: { kind: 'texture', pattern: 'dots', color: '#ffffff', bg: '#000000', scale: 20, thickness: 3 },
    });
    expect(s['background-image']).toContain('data:image/svg+xml');
    expect(s['background-size']).toBe('20px 20px');
  });

  it('边框走 CSS border；宽度 0 也是显式声明（有 → 无能复位）', () => {
    expect(withBox({ boxStroke: { color: '#abcdef', width: 3, style: 'dashed' } }).border).toBe(
      '3px dashed #abcdef',
    );
    expect(withBox({ boxStroke: { color: '#abcdef', width: 0 } }).border).toBe('0px solid #abcdef');
  });

  it('不透明度乘进色标（与组合壳同一口径）', () => {
    const s = withBox({ boxFill: { kind: 'solid', color: '#ff0000', opacity: 0.5 } });
    expect(s['background-color']).toBe('color-mix(in srgb, #ff0000 50%, transparent)');
  });

  it('渐变色标按 offset 排序后输出（数组顺序是编辑顺序，不是渲染顺序）', () => {
    const s = withBox({
      boxFill: {
        kind: 'linear',
        angle: 0,
        stops: [
          { offset: 1, color: '#0000ff' },
          { offset: 0, color: '#ff0000' },
        ],
      },
    });
    const img = s['background-image']!;
    expect(img.indexOf('#ff0000')).toBeLessThan(img.indexOf('#0000ff'));
  });
});

describe('文字阴影 / 高亮 / 配色方案解析', () => {
  it('阴影尺寸按**字号倍数**换算成 px（文档改分辨率时阴影跟着缩）', () => {
    const s = textStyle({
      ...defaultTextStyle(SIZE),
      fontSize: 100,
      shadow: { color: '#000000', dx: 0.05, dy: 0.1, blur: 0.2 },
    });
    expect(s['text-shadow']).toBe('5px 10px 20px #000000');
  });

  it('无阴影写 none 而不是省略 —— 就地同步时「有 → 无」才能复位', () => {
    expect(textStyle(defaultTextStyle(SIZE))['text-shadow']).toBe('none');
  });

  it('多层阴影 → 逗号列表（先写的在上，与数组第一层最靠近字形一致）', () => {
    const s = textStyle({
      ...defaultTextStyle(SIZE),
      fontSize: 100,
      shadow: [
        { color: '#000000', dx: 0.01, dy: 0.02, blur: 0 },
        { color: '#ff0000', dx: -0.03, dy: 0, blur: 0.1 },
      ],
    });
    expect(s['text-shadow']).toBe('1px 2px 0px #000000, -3px 0px 10px #ff0000');
  });


  it('高亮通过 `--typo-hl` 变量下发（背景不继承，只能这么传）', () => {
    expect(textStyle({ ...defaultTextStyle(SIZE), highlight: '#ffff00' })['--typo-hl']).toBe('#ffff00');
    // 无高亮时写 transparent：就地同步不会重建节点，省略会留下上一帧的底色。
    expect(textStyle(defaultTextStyle(SIZE))['--typo-hl']).toBe('transparent');
  });

  it('颜色里的配色方案引用被解析成真实色（字形色 / 阴影色 / 高亮色都要）', () => {
    const s = textStyle(
      {
        ...defaultTextStyle(SIZE),
        color: '@accent1',
        highlight: '@accent2',
        shadow: { color: '@dk1', dx: 0, dy: 0, blur: 0 },
      },
      'office',
    );
    expect(s.color).toBe('#156082');
    expect(s['--typo-hl']).toBe('#e97132');
    expect(s['text-shadow']).toBe('0px 0px 0px #000000');
  });

  it('spanStyle：默认跟随元素级变量，行内自带高亮时覆盖它', () => {
    expect(spanStyle(undefined)['background-color']).toBe('var(--typo-hl, transparent)');
    expect(spanStyle({ fontWeight: 700 })['background-color']).toBe('var(--typo-hl, transparent)');
    expect(spanStyle({ highlight: '@accent1' }, 'office')['background-color']).toBe('#156082');
  });

  it('图形填充 / 描边 / 渐变色标里的引用同样被解析', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      fill: { kind: 'linear', angle: 0, stops: [
        { offset: 0, color: '@accent1' },
        { offset: 1, color: '@accent2.l80' },
      ] },
      stroke: { color: '@dk1', width: 2 },
    });
    expect(shapePaintAttrs(el, false, 'office').stroke).toBe('#000000');
    const bg = paintToBackground(el.fill, 'office');
    expect(bg).toContain('#156082');
    expect(bg).not.toContain('@accent2');
  });

  it('换配色方案 ⇒ 同一份文档渲染出不同颜色（引用的意义所在）', () => {
    const style = { ...defaultTextStyle(SIZE), color: '@accent1' };
    expect(textStyle(style, 'office').color).not.toBe(textStyle(style, 'office-2007').color);
    expect(textStyle(style, 'office-2007').color).toBe('#4f81bd');
  });
});

describe('字形描边（-webkit-text-stroke）', () => {
  it('宽度 / 颜色 → 两条 -webkit- 属性', () => {
    expect(glyphStrokeStyle({ color: '#ff0000', width: 6, style: 'solid' })).toEqual({
      '-webkit-text-stroke-width': '6px',
      '-webkit-text-stroke-color': '#ff0000',
    });
  });

  it('没有描边时仍写 0 宽度 —— 就地同步没有删除语义', () => {
    expect(glyphStrokeStyle(undefined)).toEqual({
      '-webkit-text-stroke-width': '0px',
      '-webkit-text-stroke-color': 'transparent',
    });
  });

  it('负宽度钳到 0（否则整条属性非法，描边静默消失）', () => {
    expect(glyphStrokeStyle({ color: '#fff', width: -3, style: 'solid' })[
      '-webkit-text-stroke-width'
    ]).toBe('0px');
  });

  it('颜色支持配色方案引用', () => {
    expect(
      glyphStrokeStyle({ color: '@accent1', width: 2, style: 'solid' }, 'office')[
        '-webkit-text-stroke-color'
      ],
    ).toBe('#156082');
  });

});

describe('元素阴影 / 虚化（filter: blur + drop-shadow）', () => {
  it('默认写 filter: none —— 就地同步时「有 → 无」才能复位', () => {
    const d = createTypographyDocument(SIZE);
    expect(elementStyle(createTextElement(d.size)).filter).toBe('none');
  });

  it('多层阴影是按数组顺序链起来的 drop-shadow（不是 box-shadow）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      shadows: [
        { color: '#000000', dx: 1, dy: 2, blur: 3 },
        { color: '#ff0000', dx: -4, dy: 0, blur: 0 },
      ],
    });
    expect(elementStyle(el).filter).toBe(
      'drop-shadow(1px 2px 3px #000000) drop-shadow(-4px 0px 0px #ff0000)',
    );
    // 关键：不是 box-shadow（那个只会投一个矩形，星形 / 裸文字会得到方影子）
    expect(elementStyle(el).filter).not.toContain('box-shadow');
  });

  it('虚化在阴影**之前**（先糊再投影，反过来会连影子一起糊掉）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, {
      blur: 6,
      shadows: [{ color: '#000000', dx: 0, dy: 0, blur: 0 }],
    });
    expect(elementStyle(el).filter).toBe('blur(6px) drop-shadow(0px 0px 0px #000000)');
  });

  it('负模糊钳到 0（NaN / 负数会让整条 filter 被浏览器丢弃）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, { shadows: [{ color: '#000000', dx: 0, dy: 0, blur: -5 }] });
    expect(elementStyle(el).filter).toBe('drop-shadow(0px 0px 0px #000000)');
  });

  it('阴影色走配色方案解析（@accent1 这类引用）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createTextElement(d.size, {
      shadows: [{ color: '@accent1', dx: 0, dy: 0, blur: 0 }],
    });
    expect(elementStyle(el, 'office').filter).toContain('#156082');
    expect(elementStyle(el, 'office').filter).not.toContain('@accent1');
  });

  it('虚化为 0 时不写 blur()（0px 的模糊在部分驱动上仍有代价）', () => {
    const d = createTypographyDocument(SIZE);
    expect(elementStyle(createTextElement(d.size, { blur: 0 })).filter).toBe('none');
  });
});

describe('描边的填充方式', () => {
  it('文本框边框的渐变走 border-image，且写在 border 简写**之后**', () => {
    const el = createTextElement(SIZE, {
      boxStroke: {
        color: '#ffffff',
        width: 4,
        paint: {
          kind: 'linear',
          angle: 0,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' },
          ],
        },
      },
    });
    const s = textBoxStyle(el);
    expect(s['border-image']).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%) 1');
    // 键序 = applyDecls 的写入顺序：border 简写会复位 border-image，
    // 所以 border 必须先写（后写的才生效）。
    expect(Object.keys(s).indexOf('border')).toBeLessThan(Object.keys(s).indexOf('border-image'));
  });

  it('纹理边框：data-URI 平铺 + 按瓦片三分之一切', () => {
    const el = createTextElement(SIZE, {
      boxStroke: {
        color: '#ffffff',
        width: 4,
        paint: { kind: 'texture', pattern: 'dots', color: '#fff', bg: '#000', scale: 30, thickness: 2 },
      },
    });
    const v = textBoxStyle(el)['border-image']!;
    expect(v).toContain('data:image/svg+xml');
    expect(v.endsWith('10 repeat')).toBe(true);
  });

  it('纯色 / 无填充：border-image 复位成 none（就地同步没有删除语义）', () => {
    expect(textBoxStyle(createTextElement(SIZE, {
      boxStroke: { color: '#fff', width: 2, paint: { kind: 'solid', color: '#f00' } },
    }))['border-image']).toBe('none');
    expect(textBoxStyle(createTextElement(SIZE, {
      boxStroke: { color: '#fff', width: 2 },
    }))['border-image']).toBe('none');
  });

  it('图形描边：渐变 → stroke=url(#…)，纯色仍是真实颜色', () => {
    const d = createTypographyDocument(SIZE);
    const base = { frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 } };
    const painted = createShapeElement(d.size, 'rect', {
      ...base,
      stroke: {
        color: '#ffffff',
        width: 4,
        paint: { kind: 'radial', stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
      },
    });
    expect(shapePaintAttrs(painted).stroke).toBe(`url(#${strokePaintDefId(painted.id)})`);
    const plain = createShapeElement(d.size, 'rect', {
      ...base,
      stroke: { color: '#123456', width: 4 },
    });
    expect(shapePaintAttrs(plain).stroke).toBe('#123456');
  });

  it('渐变描边时**不写** dasharray（线型在 border-image 那条路上不生效，两条路要一致）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      stroke: {
        color: '#fff',
        width: 4,
        style: 'dashed',
        paint: { kind: 'linear', angle: 0, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
      },
    });
    expect(shapePaintAttrs(el)['stroke-dasharray']).toBeUndefined();
  });

  it('描边填充的整体不透明度走 stroke-opacity（一处覆盖三种填充）', () => {
    const d = createTypographyDocument(SIZE);
    const el = createShapeElement(d.size, 'rect', {
      frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
      stroke: {
        color: '#fff',
        width: 4,
        paint: {
          kind: 'linear',
          angle: 0,
          stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }],
          opacity: 0.5,
        },
      },
    });
    expect(shapePaintAttrs(el)['stroke-opacity']).toBe('0.5');
  });
});

describe('textureMotifSpec（图形与文本共用的图案几何）', () => {
  it('每种图案都有对应的图元（不返回空）', () => {
    for (const p of ['dots', 'grid', 'diagonal', 'cross', 'checker', 'wave'] as const) {
      expect(textureMotifSpec(p, 20, 3, '#fff').length).toBeGreaterThan(0);
    }
  });

  it('纹理 data-URI 里的图案与 spec 一致（不会两套图案分家）', () => {
    const url = textFillBackgroundImage({
      kind: 'texture', pattern: 'checker', color: '#abcdef', bg: '#000000', scale: 16, thickness: 2,
    });
    // checker 的几何是两块 rect；颜色进 data-URI 前做了转义
    const decoded = decodeURIComponent(url.replace(/^url\("/, '').replace(/"\)$/, ''));
    expect(decoded).toContain('abcdef');
    expect((decoded.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(3); // 底色 + 两块棋盘格
  });
});
