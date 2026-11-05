/**
 * css.ts — 元素 → CSS 声明的**唯一真源**（纯函数，不碰 DOM）。
 *
 * 为什么必须只有一份：舞台（编辑器里的实时 DOM）与光栅化（离屏 DOM → snapDOM）
 * 用的是同一套样式。如果两边各写一份，「编辑器里正常、导出跑版」这种问题
 * 会非常难定位 —— 这与 ui/tokens.ts 那次教训同源（当时 grid-draw.ts 在 TS 里
 * 重抄了一份调色板，改一次配色要改两处，改漏就是「面板变了、网格没变」）。
 *
 * 产出的对象是 **kebab-case 的 CSS 声明表**，调用方（render-dom.ts）
 * 逐条写进 element.style.setProperty。
 */

import type { TextSpanStyle } from './rich-text';
import { cssFamily } from './font/css-family';
import { resolveThemeColor, type TypographyTheme } from './theme';
import {
  parallaxCss,
  parallaxIsIdentity,
  parallaxOf,
  type CameraDoc,
} from './camera';
import {
  normalizeStops,
  textShadowList,
  type ImageElement,
  type Paint,
  type ShapeElement,
  type Stroke,
  type TextElement,
  type TexturePattern,
  type TextStyle,
  type Transform3D,
  type TypographyDocument,
  type TypographyElement,
  type TypographyGroup,
} from './document';

export type CssDecls = Record<string, string>;

/**
 * 配色方案入参：方案对象、方案 id、或什么都不给（缺省 = 默认方案）。
 *
 * 三种都接受是为了让**调用点各取所需**：渲染路径在顶层查一次表把对象传下来
 * （每帧几十次解析，省掉重复查表），单测与临时调用点直接省略即可。所有
 * 「颜色 → 真实颜色」的换算都收口在 `resolveThemeColor()` 里。
 */
export type ThemeArg = TypographyTheme | string | null | undefined;

export function paintCss(p: Paint, theme?: ThemeArg): string {
  return p.kind === 'solid' ? resolveThemeColor(p.color, theme) : 'transparent';
}

/** 渐变 / 纹理在文档里的 `<defs>` id 前缀。 */
export const PAINT_ID_PREFIX = 'typo-paint-';

/** 某个元素的填充 defs id。**由元素 id 派生**：同一元素每帧都得到同一个 id，
 *  否则每次 sync 都会新增一个 `<linearGradient>`，DOM 无限增长。 */
export function paintDefId(elId: string): string {
  return `${PAINT_ID_PREFIX}${elId}`;
}

/**
 * 某个元素**描边**填充的 defs id。
 *
 * 与填充的 id 分开是必须的：同一个元素可以同时有渐变填充和渐变描边，
 * 共用一个 id 时后写的 `<defs>` 会把前一个 `replaceChildren` 掉，
 * 表现是「设了描边渐变，填充变回黑色」。
 */
export function strokePaintDefId(elId: string): string {
  return `${PAINT_ID_PREFIX}stroke-${elId}`;
}

/** 填充是否需要 `<defs>`（纯色 / 无填充不需要）。 */
export function paintNeedsDefs(p: Paint): boolean {
  return p.kind === 'linear' || p.kind === 'radial' || p.kind === 'texture';
}

/**
 * 图形「图片填充」（`ShapeElement.imageFill`）的 `<clipPath>` id。
 *
 * 与填充渐变 / 描边渐变的 id 分开：同一个元素三者的 `<defs>` 各占一块，
 * 共用一个 id 时后写的会把前面的 `replaceChildren` 掉（那条坑在
 * `strokePaintDefId` 的注释里已经踩过一次）。
 */
export function imageFillClipId(elId: string): string {
  return `${PAINT_ID_PREFIX}img-${elId}`;
}

/**
 * `fit` → SVG `<image>` 的 `preserveAspectRatio`。
 *
 * `fill` 必须是 `none`：给 `xMidYMid` 会变成「等比放进框里」，
 * 「拉伸」这个词在图片适配里就是非等比铺满。
 */
export function imageFillAspectRatio(fit: 'fill' | 'contain' | 'cover'): string {
  if (fit === 'fill') return 'none';
  return fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
}

/** SVG `fill` 属性的值。 */
export function fillAttr(p: Paint, elId: string, theme?: ThemeArg): string {
  if (p.kind === 'solid') return resolveThemeColor(p.color, theme);
  if (p.kind === 'none') return 'transparent';
  return `url(#${paintDefId(elId)})`;
}

/** 填充的整体不透明度（0..1）。缺省 = 1。`none` 没有这个概念，一律视为 1。 */
export function paintOpacity(p: Paint): number {
  if (p.kind === 'none' || p.opacity === undefined) return 1;
  return Math.max(0, Math.min(1, p.opacity));
}

/**
 * 把一个颜色按整体不透明度混成半透明。
 *
 * 用 `color-mix(in srgb, …)` 而不是自己解析 hex 再拼 `rgba(…)`：
 * 颜色值可能是任意 CSS 颜色（`#rgb` / `rgb()` / 命名色），自己解析必然漏。
 * `>= 1` 时原样返回 —— 不透明时不留 `color-mix` 噪声（快照里更好比对）。
 */
function fade(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const pct = Math.max(0, Math.min(100, opacity * 100));
  return `color-mix(in srgb, ${color} ${Math.round(pct * 1000) / 1000}%, transparent)`;
}

function px(v: number): string {
  return `${Math.round(v * 1000) / 1000}px`;
}

function rad2deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/* ------------------------------------------------------------ 文档根 */

export function docStyle(doc: TypographyDocument): CssDecls {
  return {
    position: 'relative',
    width: px(doc.size.w),
    height: px(doc.size.h),
    // 文档背景独立于元素，且在元素之下。
    // 注意：光栅化时**不要**把这段背景带进 PNG —— 排版层是要叠到视频上的，
    // 自带不透明底会把下面的画面整个盖住。所以这里只描述「预览用的底板」，
    // 由 render-dom 决定要不要注入（forRaster 时不注入）。
    overflow: 'hidden',
    // 关键：mix-blend-mode 的混合范围必须被限制在文档内部。
    // 不加这句，元素会与页面背景（编辑器 UI / 时间轴）混合，预览与导出不一致。
    isolation: 'isolate',
    contain: 'layout size style',
  };
}

/* ------------------------------------------------------------ 元素外壳 */

/* ------------------------------------------------------------ 3D 变换 */

/** 角度 → CSS `deg`（三位小数，与 `px()` 同口径）。 */
function deg(v: number): string {
  return `${Math.round(v * 1000) / 1000}deg`;
}

/** 倍数 → CSS 数字。 */
function num(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** 0..1 → CSS 百分比（原点是元素框的比例，不是 px）。 */
function pct(v: number): string {
  return `${Math.round(v * 100000) / 1000}%`;
}

/**
 * 3D 参数 → 一条 CSS `transform` 值。
 *
 * 顺序固定（见 `document.ts::Transform3D`）：写进 CSS 的列表就是矩阵相乘的顺序，
 * 调换一下就是另一幅画 —— 已有工程会跟着变，不要「顺手」重排。
 *
 * 只有 `perspective` 为 0 且其余全恒等时返回 `'none'`。默认的 `perspective(800px)`
 * 单独存在时矩阵是单位矩阵（视觉不变），保留它只是为了让 DOM 值与面板一致 ——
 * 面板显示 800，`transform` 里就该看得到 800。
 */
function transform3dCss(frameRot: number, t: Transform3D): string {
  const parts: string[] = [];
  if (t.perspective > 0) parts.push(`perspective(${px(t.perspective)})`);

  const tr = t.translate;
  const ro = t.rotate;
  const sc = t.scale;
  const sk = t.skew;
  if (tr.x || tr.y || tr.z) parts.push(`translate3d(${px(tr.x)}, ${px(tr.y)}, ${px(tr.z)})`);
  if (ro.x) parts.push(`rotateX(${deg(ro.x)})`);
  if (ro.y) parts.push(`rotateY(${deg(ro.y)})`);
  /*
   * `frame.rot` 与 `rotate.z` 都是绕 Z ⇒ 合成一个角度。
   * 写成两条 `rotateZ` 的话，「谁先谁后」会变成第三处需要记住的约定，
   * 而这里两者可交换、合并后没有任何歧义。
   */
  const rz = rad2deg(frameRot) + ro.z;
  if (rz) parts.push(`rotateZ(${deg(rz)})`);
  if (sk.x) parts.push(`skewX(${deg(sk.x)})`);
  if (sk.y) parts.push(`skewY(${deg(sk.y)})`);
  if (sc.x !== 1 || sc.y !== 1 || sc.z !== 1) {
    parts.push(`scale3d(${num(sc.x)}, ${num(sc.y)}, ${num(sc.z)})`);
  }
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * 元素阴影 + 虚化 → 一条 CSS `filter`。
 *
 * 顺序固定为 **blur 在前、drop-shadow 在后**：先把元素糊开再投它的影，
 * 得到的是「模糊的墨迹 + 清晰的边缘扩散」；反过来会把影子本身也糊掉，
 * 而且元素边缘会出现一圈亮环（drop-shadow 取的是**过滤后**的 alpha）。
 *
 * 无阴影 / 无虚化时返回 `'none'`：就地同步只 set 不 delete，
 * 「有 → 无」必须靠这条显式复位（与 textBoxStyle / elementStyle 的 3D 同一条纪律）。
 */
function elementFilter(el: TypographyElement, theme?: ThemeArg): string {
  const parts: string[] = [];
  if (el.blur && el.blur > 0) parts.push(`blur(${px(el.blur)})`);
  for (const s of el.shadows ?? []) {
    const blur = Math.max(0, s.blur);
    parts.push(
      `drop-shadow(${px(s.dx)} ${px(s.dy)} ${px(blur)} ${resolveThemeColor(s.color, theme)})`,
    );
  }
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * 把镜头视差**前缀**在元素自己那条 `transform` 上（缺省 / 恒等时原样返回）。
 *
 * 为什么不加一层 wrapper：wrapper 会新建层叠上下文与包含块，富文本块内的
 * 绝对定位子元素会换参照系 —— 那是一个不会报错、只在特定排版下歪掉的 bug。
 *
 * 变换原点按 CSS 实际生效的那个点算（`t3.origin` 或 50% 50% 的元素框中心）：
 * 视差是绕**画布中心**的，拆成「绕自身原点 + 补偿平移」才能只占一个
 * `transform-origin`（见 `camera.ts::parallaxCss`）。
 *
 * ⚠️ 只能挂在**外壳**上，不能挂在 `.typo-box` 动画层上：CSS 动画的
 * `transform` 优先级高于内联样式，box 动画一跑就会把视差顶掉。
 */
function parallaxTransform(
  el: TypographyElement,
  camera: CameraDoc | undefined,
  own: string,
): string {
  if (!camera || !el.depth) return own;
  const p = parallaxOf(camera, el);
  if (parallaxIsIdentity(p)) return own;
  const t3 = el.transform3d;
  const origin = {
    x: el.frame.x + el.frame.w * (t3 ? t3.origin.x : 0.5),
    y: el.frame.y + el.frame.h * (t3 ? t3.origin.y : 0.5),
  };
  const pre = parallaxCss(camera, p, origin);
  return own === 'none' ? pre : `${pre} ${own}`;
}

/**
 * 外层：几何 + 旋转 / 3D + 不透明度 + 混合模式 + 阴影 / 虚化。
 * **动画不在这里** —— 动画预设大量使用 transform，而这里的 transform 被几何变换
 * 占用。动画挂在紧接着的内层包装上（见 animLayerStyle），两者互不干扰。
 *
 * 三个 3D 相关声明**总是写出来**（关闭时给 CSS 默认值）：就地同步
 * （`syncDocDom`）没有删除语义，只 set 不 delete —— 少写一个键，从「启用」
 * 切回「关闭」时上一份的值会留在元素上（见 textBoxStyle 的同一条纪律）。
 *
 * `inset`：由外层 `.typo-box`（`target: 'box'` 的动画层）承担几何时，外壳退化成
 * 「铺满外层」的一层 —— 否则 frame 的 left/top 会被算**两遍**（外层一次、内层一次）。
 *
 * `theme` 只有阴影色需要（阴影色可以是配色方案引用）。缺省 = 默认方案。
 */
export function elementStyle(
  el: TypographyElement,
  theme?: ThemeArg,
  opts: { inset?: boolean; camera?: CameraDoc } = {},
): CssDecls {
  const t3 = el.transform3d;
  const inset = opts.inset === true;
  const own = t3
    ? transform3dCss(el.frame.rot, t3)
    : el.frame.rot
      ? `rotate(${rad2deg(el.frame.rot)}deg)`
      : 'none';
  return {
    position: 'absolute',
    left: inset ? '0' : px(el.frame.x),
    top: inset ? '0' : px(el.frame.y),
    width: inset ? '100%' : px(el.frame.w),
    height: inset ? '100%' : px(el.frame.h),
    transform: parallaxTransform(el, opts.camera, own),
    'transform-origin': t3 ? `${pct(t3.origin.x)} ${pct(t3.origin.y)}` : '50% 50%',
    'backface-visibility': t3?.backface ?? 'visible',
    'transform-style': t3?.style ?? 'flat',
    opacity: String(el.opacity),
    'mix-blend-mode': el.blend,
    filter: elementFilter(el, theme),
    'pointer-events': 'none',
    'user-select': 'none',
    'box-sizing': 'border-box',
  };
}

/**
 * `target: 'box'` 的动画层：包住整个外壳（含文本框底板 / 边框），并**承担 frame
 * 的定位**（外壳这时退化成 `inset: 0` 的填充层，见 `elementStyle` 的 `inset`）。
 *
 * 为什么不能像 content 层那样只写 `inset: 0`：那一层是 `.typo-doc` 的直接子节点，
 * `100%` 会等于**整张画布** —— `transform-origin: 50% 50%` 就成了画布中心，
 * 「原地旋转」会变成「绕画布中心甩」。
 *
 * 不写 `transform` / `opacity` / `filter`：它们要么归动画（CSS 动画自带），
 * 要么归外壳（`elementStyle`）。同步时只 set 不 delete，写了就会盖掉别的层。
 */
export function boxWrapStyle(el: TypographyElement): CssDecls {
  return {
    position: 'absolute',
    left: px(el.frame.x),
    top: px(el.frame.y),
    width: px(el.frame.w),
    height: px(el.frame.h),
    'transform-origin': '50% 50%',
    'box-sizing': 'border-box',
    'pointer-events': 'none',
    'user-select': 'none',
  };
}

/** 内层：动画的落点。每个动画一层，嵌套排列，这样多个 transform 动画可以叠加。 */
export function animLayerStyle(): CssDecls {
  return {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    'transform-origin': '50% 50%',
    'box-sizing': 'border-box',
  };
}

/**
 * 脚本层：**动画层之内、内容之外**。
 *
 * 为什么单独一层而不是直接写在外壳上：外层 transform 被 `frame.rot` 与 CSS
 * 动画占用，脚本再写 transform 会把它们顶掉（「加了旋转之后动画位置全乱」）。
 * 单独一层让三者**复合**，也让撤销日志只包住脚本自己的写入。
 */
export function scriptLayerStyle(): CssDecls {
  return {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    'transform-origin': '50% 50%',
    'box-sizing': 'border-box',
  };
}

/**
 * 逐字 span。`inline-block` 是 transform 的前提（inline 元素不产生盒子，
 * 写 transform 没有任何效果）；`white-space: pre` 保住空格 —— 否则
 * 「A B」拆成三个 span 之后中间那个空格会被折叠掉。
 *
 * 代价：inline-block 会断开连字与跨字距的字偶间距。所以它**只在脚本显式
 * 声明 `needs:['chars']` 且总开关打开时**才出现（见 render-dom.ts），
 * 关掉脚本时排版与原来逐像素一致。
 */
export function scriptCharStyle(): CssDecls {
  return {
    display: 'inline-block',
    'white-space': 'pre',
    'will-change': 'transform, opacity',
  };
}

/** 脚本 Canvas：铺满元素框，位于内容之下（先 append）。 */
export function scriptCanvasStyle(): CssDecls {
  return {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    'pointer-events': 'none',
  };
}



/* ------------------------------------------------------------ 文本 */

/**
 * 文字阴影 → `text-shadow` 声明。**尺寸是字号倍数**，这里才换算成 px
 * （见 document.ts::TextStyleShadow 的理由）。无阴影返回 `'none'` ——
 * 声明表逐键同构，就地同步时「有 → 无」才能复位。
 *
 * 多层时按数组顺序拼成一条逗号列表：CSS 里**先写的在上**，
 * 与「数组第一个最靠近字形」是同一条约定（见 textShadowList）。
 */
function textShadow(style: TextStyle, theme: ThemeArg): string {
  const list = textShadowList(style);
  if (!list.length) return 'none';
  const k = style.fontSize;
  return list
    .map((sh) => {
      const blur = Math.max(0, sh.blur * k);
      return `${px(sh.dx * k)} ${px(sh.dy * k)} ${px(blur)} ${resolveThemeColor(sh.color, theme)}`;
    })
    .join(', ');
}

export function textStyle(style: TextStyle, theme?: ThemeArg): CssDecls {
  // 竖排时「垂直对齐」在视觉上变成了水平方向，所以主轴翻转。
  const vertical = style.writingMode === 'vertical-rl';
  const vAlign =
    style.vAlign === 'middle' ? 'center' : style.vAlign === 'bottom' ? 'flex-end' : 'flex-start';

  return {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    display: 'flex',
    'flex-direction': vertical ? 'row' : 'column',
    'justify-content': vAlign,
    // 让匿名 flex item 撑满主轴宽度，text-align 才有效果。
    'align-items': 'stretch',
    'box-sizing': 'border-box',
    overflow: 'hidden',

    /*
     * **必须过 `cssFamily()`**：本机族名里带数字 / 逗号 / 空格的名字裸拼会让
     * 整条声明失效（`font-family: HYPixel 11px` 里的 `11px` 是 dimension，
     * 不是 ident ⇒ 声明被丢弃，字符**静默**退回界面字体）。
     * 字体下拉走的就是这个函数，所以「下拉里看着对、舞台上却回退」的怪相
     * 只出现在这条漏了它（2026-10-25 用户报的那个像素字体）。
     */
    'font-family': cssFamily(style.fontFamily),
    'font-size': px(style.fontSize),
    'font-weight': String(style.fontWeight),
    'font-style': style.fontStyle,
    'letter-spacing': px(style.letterSpacing),
    'line-height': String(style.lineHeight),
    'text-align': style.align,
    color: resolveThemeColor(style.color, theme),
    'text-decoration': style.textDecoration,
    'text-transform': style.textTransform,
    'text-shadow': textShadow(style, theme),
    /*
     * 高亮底色通过这个**自定义属性**传给行内段（见 spanStyle / applyRuns）。
     *
     * 为什么不直接给 `.typo-text` 设 background-color：这个盒子是 flex 容器、
     * 撑满整个元素框，背景会把换行处的空白一起填满 —— 看起来是「给文本框
     * 刷了底色」，不是「把字涂黄」。而背景**不继承**，所以只能靠变量下发。
     *
     * 无高亮时写 `transparent` 而不是省略：就地同步不会重建节点，
     * 省略会让上一帧的底色留在那里。
     */
    '--typo-hl': style.highlight ? resolveThemeColor(style.highlight, theme) : 'transparent',
    'white-space': 'pre-wrap',
    'word-break': 'break-word',
    'writing-mode': style.writingMode,
    'text-autospace': style.textAutospace ?? 'none',
    // 文档内容不该继承编辑器/页面的字体回退差异。
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
  };
}

/**
 * 文本框的**背景与边框** → 写在元素外壳（`.typo-el`）上的 CSS 声明。
 *
 * 与 `textFillStyle`（字形着色，走内层 `.typo-text` 的
 * `background-clip: text`）分属两个节点，所以互不干扰：这一层在文字**之下**，
 * 是「文本框底色 / 边框」；那一层裁到字形上，是「字的颜色」。
 *
 * 三件与字形路径对齐的事：
 *  - 渐变色标与 `paintToBackground` 一样过 `cssStops` 归一化（排序 + 高精度
 *    百分比），否则同一个文档在「组合壳」与「文本框」上会排成不同的渐变；
 *  - 纹理复用 `textFillBackgroundImage`（内联 SVG 平铺），不是回落到纯底色
 *    —— 图形与字形都能平铺，文本框没理由比它们少；
 *  - **总是返回完整声明**：就地同步（syncDocDom）不重建节点，切回「无填充」
 *    时必须能把上一份 background 复位。
 */
export function textBoxStyle(el: TextElement, theme?: ThemeArg): CssDecls {
  const fill = el.boxFill;
  const out: CssDecls = {};
  if (fill && fill.kind === 'solid') {
    out['background-color'] = fade(resolveThemeColor(fill.color, theme), paintOpacity(fill));
    out['background-image'] = 'none';
    out['background-size'] = 'auto';
  } else if (fill && fill.kind !== 'none') {
    const cell = fill.kind === 'texture' ? Math.max(2, fill.scale) : null;
    out['background-color'] = 'transparent';
    out['background-image'] = textFillBackgroundImage(fill, theme);
    // 纹理按周期平铺（与 textFillStyle 同一口径），渐变铺满整个文本框。
    out['background-size'] = cell === null ? 'auto' : `${cell}px ${cell}px`;
  } else {
    out['background-color'] = 'transparent';
    out['background-image'] = 'none';
    out['background-size'] = 'auto';
  }
  out['background-repeat'] = 'repeat';

  const s = el.boxStroke;
  // 无边框写 `0 solid transparent` 而不是 `none`：声明表逐键同构，
  // 「有 → 无」在就地同步下才能逐键复位（没有删除语义）。
  out.border = s
    ? `${px(Math.max(0, s.width))} ${s.style ?? 'solid'} ${resolveThemeColor(s.color, theme)}`
    : '0 solid transparent';
  /*
   * 描边的**填充方式**。`border` 简写会把 `border-image` 复位成 none，
   * 所以这一条必须写在 `border` **之后**（对象键序就是 applyDecls 的写入顺序）。
   * 复位同样显式写 'none'（就地同步没有删除语义）。
   */
  out['border-image'] = s?.paint ? borderImageCss(s.paint, theme) : 'none';
  return out;
}

/**
 * 描边的渐变 / 纹理 → CSS `border-image` 的值。
 *
 * 两处与「填充」那条路对齐、一处必须不同：
 *  - 色标同样过 `cssStops`（排序 + 高精度百分比），否则同一个文档在
 *    「文本框背景」与「边框」上会排成不同的渐变；
 *  - 纹理复用 `textureDataUri`（同一份图案几何），不是回落到纯色；
 *  - **`border-image` 不吃 `border-radius`**（实测：圆角处仍是方角，
 *    这是 CSS 的既有行为，不是我们的 bug）。文本框没有圆角字段，所以
 *    这条今天不会露出来；将来给文本框加圆角时要先解决它。
 *
 * `slice` 取一个固定的「1」：渐变是连续色彩，切分位置不影响观感（整块铺满）；
 * 纹理则按瓦片的三分之一切，中间那段平铺 —— 与 `textureDataUri` 的瓦片尺寸
 * 对得上，不会出现「纹理被拉成一条」。
 */
function borderImageCss(paint: Paint, theme?: ThemeArg): string {
  const op = paintOpacity(paint);
  switch (paint.kind) {
    case 'linear':
      return `linear-gradient(${Math.round(paint.angle + 90)}deg, ${cssStops(paint, op, theme)}) 1`;
    case 'radial':
      return `radial-gradient(circle at 50% 50%, ${cssStops(paint, op, theme)}) 1`;
    case 'texture': {
      const cell = Math.max(2, paint.scale);
      const slice = Math.max(1, Math.round(cell / 3));
      return `${textureDataUri(paint, op, theme)} ${slice} repeat`;
    }
    default:
      return 'none';
  }
}

/* ------------------------------------------------------------ 图形 */

/**
 * 图形用 `<path>` 画在**与元素盒等尺寸的 viewBox** 里（`0 0 w h`），所以缩放是
 * 1:1，描边宽度可以直接用文档 px。
 *
 * 早期版本用 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` 拉伸，代价是
 * 非等比缩放时边框一边粗一边细（水平边按 sy 缩放、垂直边按 sx）—— 看起来就像
 * 被 `transform: scale()` 拉歪了。改成像素盒之后这类换算整体消失。
 */
export function shapePaintAttrs(el: ShapeElement, evenOdd = false, theme?: ThemeArg): CssDecls {
  const attrs: CssDecls = {
    fill: fillAttr(el.fill, el.id, theme),
    // 圆环 / 方框靠**嵌套子路径 + evenodd** 挖洞，不用 evenodd 的话内圈会被填满，
    // 看起来就是一个实心圆/矩形 —— 形状参数全都"没生效"。
    'fill-rule': evenOdd ? 'evenodd' : 'nonzero',
    stroke: 'none',
    'stroke-width': '0',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  };
  // 填充的整体不透明度：**一处 fill-opacity 就覆盖纯色 / url(#渐变) / url(#pattern)**，
  // 不必分别处理三种填充。不透明时不写这个属性，保持老工程渲染结果逐字节不变。
  const fillOpacity = paintOpacity(el.fill);
  if (fillOpacity < 1) attrs['fill-opacity'] = String(fillOpacity);
  if (!el.stroke) return attrs;

  /*
   * 描边填充：渐变 / 纹理走 `<defs>` 的 `url(#…)`（与填充同一套机制，
   * 见 render-dom.ts::syncPaintDefs）。`solid` / `none` 仍是纯色 —— 与
   * `TextElement.fill` 的语义同构（见 document.ts::Stroke.paint）。
   */
  const sp = el.stroke.paint;
  const painted = sp && sp.kind !== 'solid' && sp.kind !== 'none' ? sp : null;
  attrs.stroke = painted
    ? `url(#${strokePaintDefId(el.id)})`
    : resolveThemeColor(el.stroke.color, theme);
  if (painted) {
    const op = paintOpacity(painted);
    if (op < 1) attrs['stroke-opacity'] = String(op);
  }
  attrs['stroke-width'] = String(Math.max(0, el.stroke.width));
  // 设了渐变 / 纹理就**不写 dasharray**：文本框那条路（border-image）根本
  // 不支持线型，两条路给同一个开关不同结果才是真的糟。
  if (!painted && el.stroke.style === 'dashed') attrs['stroke-dasharray'] = '6 4';
  if (!painted && el.stroke.style === 'dotted') attrs['stroke-dasharray'] = '1 3';
  return attrs;
}

/* ------------------------------------------------------------ 图片 */

/**
 * 裁剪用「外层裁窗 + 内层按比例放大并偏移」实现：
 *   crop = {x,y,w,h}（相对源图的 0..1）
 * 内层图片的尺寸是 100/cw %、位置是 -cx/cw * 100 %，
 * 于是 crop 矩形正好铺满外层元素框。fit 作用在内层 <img> 上。
 *
 * **边框走 `box-shadow: inset`，不是 `border`**：`border` 会挤占内容盒，
 * 加一条 20px 的边就等于把图片裁小一圈（而 PPT 的图片边框是画在图片上的）。
 * inset 阴影跟着 `border-radius` 走，snapDOM 也保真（见 typography/AGENTS.md
 * 的阴影一节）。`width = 0` 时必须显式写 `none` —— 就地同步只 set 不 delete。
 */
export function imageStyle(
  el: ImageElement,
  theme?: ThemeArg,
): { wrapper: CssDecls; img: CssDecls } {
  const c = el.crop;
  const border = el.border && el.border.width > 0 ? el.border : null;
  const wrapper: CssDecls = {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    'border-radius': el.radius ? px(el.radius) : '0',
    'box-sizing': 'border-box',
    'box-shadow': border
      ? `inset 0 0 0 ${px(border.width)} ${resolveThemeColor(border.color, theme)}`
      : 'none',
  };

  if (!c || c.w <= 0 || c.h <= 0) {
    return {
      wrapper,
      img: {
        width: '100%',
        height: '100%',
        'object-fit': el.fit,
        display: 'block',
      },
    };
  }

  return {
    wrapper,
    img: {
      position: 'absolute',
      width: `${(100 / c.w).toFixed(4)}%`,
      height: `${(100 / c.h).toFixed(4)}%`,
      left: `${((-c.x / c.w) * 100).toFixed(4)}%`,
      top: `${((-c.y / c.h) * 100).toFixed(4)}%`,
      'object-fit': el.fit,
      display: 'block',
      'max-width': 'none',
    },
  };
}

/* ------------------------------------------------------------ 组合外壳 */

/**
 * 组合的共享外壳 → CSS 声明。
 *
 * 它是**普通 DOM 盒子**（不是 SVG），所以填充直接用 CSS：
 *  - 纯色 → `background-color`
 *  - 线性 / 径向渐变 → `linear-gradient` / `radial-gradient`
 *  - 纹理 → 回落到底色（CSS 里复刻那套 SVG pattern 需要另一份实现，
 *    而组合壳的纹理几乎没人用；宁可少一个能力，也不要两套会分家的图案代码）
 *
 * 角度换算：本项目的 Paint 角度是「0° = 左→右，顺时针」，
 * 而 CSS 的 `0deg` 是「从下往上、顺时针」⇒ 加 90°。
 */
export function groupStyle(
  g: TypographyGroup,
  box: { x: number; y: number; w: number; h: number },
  theme?: ThemeArg,
  camera?: CameraDoc,
  depth = 0,
): CssDecls {
  /*
   * 镜头视差：组合外壳用的是**离镜头最近的那个成员**的深度。
   *
   * 成员可以有各自的 depth，而底板只有一个 —— 取最近的（max）是唯一能让
   * 「底板跟着内容一起动」读得通的选择：取平均会让底板落在两层之间，
   * 谁都贴不上；取 0 则会出现「文字跟着镜头飞走、框留着不动」。
   */
  const pre =
    camera && depth > 0
      ? (() => {
          const p = parallaxOf(camera, { depth });
          return parallaxIsIdentity(p)
            ? ''
            : parallaxCss(camera, p, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
        })()
      : '';
  const decls: CssDecls = {
    position: 'absolute',
    left: px(box.x),
    top: px(box.y),
    width: px(box.w),
    height: px(box.h),
    'border-radius': g.radius ? px(g.radius) : '0',
    'box-sizing': 'border-box',
    'pointer-events': 'none',
    // 就地同步只 set 不 delete ⇒ 关掉镜头必须显式写回 none。
    transform: pre || 'none',
    background: paintToBackground(g.fill, theme),
  };
  if (g.stroke) {
    decls.border = `${px(g.stroke.width)} ${g.stroke.style ?? 'solid'} ${resolveThemeColor(g.stroke.color, theme)}`;
  }
  return decls;
}

/**
 * 色标位置 → CSS 百分比。
 *
 * 三位小数（`33.33%`）而不是取整到一起：`Math.round(offset * 100)` 会把
 * 0.3333 与 0.3349 压成同一个 33% —— 面板上拖色标时手一停位置就跳，
 * 而且与 SVG 那条路（用原始 float）对不上。
 */
function stopPct(offset: number): string {
  return `${Math.round(offset * 100000) / 1000}%`;
}

/** 渐变色标的 CSS 片段（`色 33.33%`），排序归一化与 SVG 那条路共用。 */
function cssStops(p: Paint, op: number, theme: ThemeArg): string {
  return normalizeStops(p.kind === 'linear' || p.kind === 'radial' ? p.stops : [])
    .map((s) => `${fade(resolveThemeColor(s.color, theme), op)} ${stopPct(s.offset)}`)
    .join(', ');
}

export function paintToBackground(p: Paint, theme?: ThemeArg): string {
  // 整体不透明度按**色标**乘进去（CSS 背景没有「层不透明度」这种属性）。
  const op = paintOpacity(p);
  switch (p.kind) {
    case 'solid':
      return fade(resolveThemeColor(p.color, theme), op);
    case 'linear': {
      return `linear-gradient(${Math.round(p.angle + 90)}deg, ${cssStops(p, op, theme)})`;
    }
    case 'radial': {
      return `radial-gradient(circle at 50% 50%, ${cssStops(p, op, theme)})`;
    }
    case 'texture':
      // 组合壳的纹理回落到**底色**（见 groupStyle 的说明），所以这里只乘底色。
      return fade(resolveThemeColor(p.bg, theme), op);
    default:
      return 'transparent';
  }
}

/**
 * 富文本的**内层容器**。
 *
 * ⚠️ **必须有这一层。** `.typo-text` 是 `display: flex`（靠它做垂直对齐），
 * 而 **flex 容器的每一个子元素都会被块级化** —— 直接把每段文字的 `<span>`
 * 挂进去，每段就各占一行：一个 6 字的标题只要中间加粗两个字，就会断成三行。
 * 外面套一个普通块级盒子之后，flex 项只有它一个，行内的 span 恢复正常流。
 *
 * 用 `<span>` + `display: block` 而不是 `<div>`：这样「编辑区里除了行内段
 * 不该有块级标签」这条判据仍然只看标签名就成立（见 rich-text 的遍历约定）。
 */
export function runsWrapperStyle(): CssDecls {
  return { display: 'block', width: '100%', 'min-width': '0' };
}

/* ------------------------------------------------------------ 纹理几何（纯数据） */

/**
 * 一个 SVG 图元的**纯数据**描述（标签 + 属性）。
 *
 * 纹理图案只有一套几何，却有两个消费方：图形走真实的 SVG `<pattern>`（render-dom），
 * 文本字形填充走内联的 `data:image/svg+xml`（本文件）。把它抽成纯数据是为了
 * **不让两套图案代码分家** —— 加一种纹理只改这里的 switch，两个渲染路径同时生效。
 */
export interface SvgPrimitive {
  tag: string;
  attrs: Record<string, string>;
}

/** 图案的原始形状（cell = 一个周期；thick = 线宽；color = 线/点色）。 */
export function textureMotifSpec(
  pattern: TexturePattern,
  cell: number,
  thick: number,
  color: string,
): SvgPrimitive[] {
  const line = (x1: number, y1: number, x2: number, y2: number): SvgPrimitive => ({
    tag: 'line',
    attrs: {
      x1: String(x1),
      y1: String(y1),
      x2: String(x2),
      y2: String(y2),
      stroke: color,
      'stroke-width': String(thick),
    },
  });
  const half = cell / 2;
  switch (pattern) {
    case 'dots':
      return [
        { tag: 'circle', attrs: { cx: String(half), cy: String(half), r: String(thick), fill: color } },
      ];
    case 'grid':
      // 画在上/左两条边上，平铺之后就是一整张网格。
      return [line(0, 0, cell, 0), line(0, 0, 0, cell)];
    case 'diagonal':
      return [line(0, cell, cell, 0)];
    case 'cross':
      return [line(0, 0, cell, cell), line(0, cell, cell, 0)];
    case 'checker':
      return [
        { tag: 'rect', attrs: { x: '0', y: '0', width: String(half), height: String(half), fill: color } },
        {
          tag: 'rect',
          attrs: { x: String(half), y: String(half), width: String(half), height: String(half), fill: color },
        },
      ];
    case 'wave': {
      // 一个周期的正弦（两个二次贝塞尔拼）。控制点取 4/3·(√2−1) 的近似，
      // 0.55 是肉眼看着最像正弦的那个系数。
      const d = `M0,${half} Q${cell * 0.25},${half - cell * 0.55} ${half},${half} Q${cell * 0.75},${half + cell * 0.55} ${cell},${half}`;
      return [{ tag: 'path', attrs: { d, fill: 'none', stroke: color, 'stroke-width': String(thick) } }];
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------ 文本字形填充 */

/**
 * 文本元素 → 字形填充的 CSS 声明。
 *
 * 实现是 CSS 的 `background-clip: text`（渐变 / 径向 / 纹理裁到字形上），
 * **总是返回一份完整声明**：不仅要设上，也要在「切回纯色」时把上一帧残留的
 * 裁切复位 —— 就地同步（syncDocDom）不会重建节点，残留的 `background-clip`
 * 会让 `style.color` 再也显不出来。
 *
 * 只有 `linear` / `radial` / `texture` 才覆盖字形着色；`solid` / `none` /
 * `undefined` 一律复位，交回 `style.color` 那条老路（见 TextElement.fill 的语义）。
 */
export function textFillStyle(fill: Paint | undefined, theme?: ThemeArg): CssDecls {
  const usable =
    fill && fill.kind !== 'none' && fill.kind !== 'solid' ? fill : null;
  if (!usable) {
    return {
      'background-image': 'none',
      'background-size': 'auto',
      'background-repeat': 'repeat',
      'background-clip': 'border-box',
      '-webkit-background-clip': 'border-box',
    };
  }
  // 纹理要按周期平铺（background-size = 一个周期），渐变则铺满整个文本框（auto）。
  const cell = usable.kind === 'texture' ? Math.max(2, usable.scale) : null;
  return {
    'background-image': textFillBackgroundImage(usable, theme),
    'background-clip': 'text',
    '-webkit-background-clip': 'text',
    'background-repeat': 'repeat',
    'background-size': cell === null ? 'auto' : `${cell}px ${cell}px`,
    color: 'transparent',
  };
}

/**
 * 文本元素 → **字形描边**的 CSS 声明（`-webkit-text-stroke`）。
 *
 * 为什么是这条而不是给字形加 `text-shadow` 四向叠：`text-shadow` 没有 `spread`，
 * 只能靠多向 copy 拼（层数随厚度线性上升，尖角处还会漏），而描边本来就是一个
 * 有宽度参数的属性。图形那边用真 `stroke`，文字这边用这个，两边都「一个参数调粗细」。
 *
 * 三个必须知道的现实（都写在文档模型 `TextElement.glyphStroke` 上）：
 *  - **居中描边**：半个宽度压在字形里，所以「向外扩 N px」要设 2N。
 *  - `paint-order` 救不了：那是 SVG text 的属性，HTML 文字不认。
 *  - 名字带 `-webkit-` 且没有标准替身（`text-stroke` 未标准化）。Chromium 认；
 *    本项目已经不做 Firefox / Safari 适配（AGENTS §2），所以不写两遍。
 *
 * **总是返回完整声明**：就地同步没有删除语义，宽度要能复位到 0。
 */
export function glyphStrokeStyle(stroke: Stroke | undefined, theme?: ThemeArg): CssDecls {
  const width = stroke && Number.isFinite(stroke.width) ? Math.max(0, stroke.width) : 0;
  return {
    '-webkit-text-stroke-width': px(width),
    '-webkit-text-stroke-color': resolveThemeColor(stroke?.color ?? 'transparent', theme),
  };
}

/** 文本字形填充的 `background-image`：渐变 / 径向直接映射成 CSS，纹理转成内联 SVG。 */
export function textFillBackgroundImage(p: Paint, theme?: ThemeArg): string {
  const op = paintOpacity(p);
  switch (p.kind) {
    case 'linear':
      return `linear-gradient(${Math.round(p.angle + 90)}deg, ${cssStops(p, op, theme)})`;
    case 'radial':
      return `radial-gradient(circle at 50% 50%, ${cssStops(p, op, theme)})`;
    case 'texture':
      return textureDataUri(p, op, theme);
    default:
      return 'none';
  }
}

/**
 * 纹理 → `url("data:image/svg+xml,…")`。
 *
 * 与图形共用 `textureMotifSpec` 的几何；整体不透明度用一层 `<g opacity>` 表达
 * —— 在 SVG 属性里用 `color-mix()` 的兼容性不稳，而组透明度哪都认。
 * 色标里的 `#` 交给 `encodeURIComponent` 转义成 `%23`，data-URI 才不会断。
 */
function textureDataUri(
  paint: Extract<Paint, { kind: 'texture' }>,
  opacity: number,
  theme?: ThemeArg,
): string {
  const cell = Math.max(2, paint.scale);
  const thick = Math.max(0.2, paint.thickness);
  const body: string[] = [
    `<rect x="0" y="0" width="${cell}" height="${cell}" fill="${resolveThemeColor(paint.bg, theme)}"/>`,
  ];
  for (const prim of textureMotifSpec(paint.pattern, cell, thick, resolveThemeColor(paint.color, theme))) {
    const attrs = Object.entries(prim.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    body.push(`<${prim.tag} ${attrs}/>`);
  }
  const op = opacity < 1 ? ` opacity="${Math.round(opacity * 1000) / 1000}"` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}">` +
    `<defs><pattern id="p" patternUnits="userSpaceOnUse" width="${cell}" height="${cell}">` +
    `<g${op}>${body.join('')}</g>` +
    `</pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/* ------------------------------------------------------------ 行内富文本 */

/**
 * 一段文本的**局部覆盖** → CSS。
 *
 * **只写被覆盖的那几项**，其余一律继承 `.typo-text` 上的元素级样式。
 * 「先铺满一份完整样式再改一项」的话，元素级之后改一次就传不下去了 ——
 * 把整块字从 97 调到 120 时，被单独加粗过的那一段会停在旧字号。
 *
 * 段落级属性（行高 / 对齐 / 竖排）刻意**不在**覆盖范围内：同一行里两种行高
 * 谁也画不对，见 rich-text.ts 里 `SPAN_STYLE_KEYS` 的说明。
 */
export function spanStyle(span: TextSpanStyle | undefined, theme?: ThemeArg): CssDecls {
  /*
   * 高亮底色**总是**写出来：
   *  - 这一段自己有高亮 → 用它的颜色；
   *  - 没有 → `var(--typo-hl, transparent)`，即跟随元素级的高亮（见 textStyle）。
   *
   * 走变量而不是「元素级改高亮时重建整个 spans」：重建会打断正在编辑的
   * contenteditable 选区（打字时换个高亮色光标就飞了）。
   */
  const out: CssDecls = { 'background-color': 'var(--typo-hl, transparent)' };
  if (!span) return out;
  // 与 textStyle 同理：族名必须加引号转义（`HYPixel 11px` 裸拼整条声明失效）。
  if (span.fontFamily !== undefined) {
    const family = cssFamily(span.fontFamily);
    if (family) out['font-family'] = family;
  }
  if (span.fontSize !== undefined) out['font-size'] = px(span.fontSize);
  if (span.fontWeight !== undefined) out['font-weight'] = String(span.fontWeight);
  if (span.fontStyle !== undefined) out['font-style'] = span.fontStyle;
  if (span.letterSpacing !== undefined) out['letter-spacing'] = px(span.letterSpacing);
  if (span.color !== undefined) out.color = resolveThemeColor(span.color, theme);
  if (span.textDecoration !== undefined) out['text-decoration'] = span.textDecoration;
  if (span.highlight !== undefined) {
    out['background-color'] = resolveThemeColor(span.highlight, theme);
  }
  return out;
}

/* ------------------------------------------------------------ 工具 */

/** 把声明表写进元素的内联样式。唯一写样式的出口。 */
export function applyDecls(el: HTMLElement | SVGElement, decls: CssDecls): void {
  for (const [k, v] of Object.entries(decls)) el.style.setProperty(k, v);
}
