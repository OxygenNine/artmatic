/**
 * ribbon-defs.ts — 把「文档 + 选择集」编译成 Ribbon 的 Tab 描述数组。
 *
 * **纯函数**（除了挂在按钮上的回调）：给定输入就能预测输出，所以
 * 「选中图形时出现图形格式 Tab」「没选中文本时字体组置灰」这些规则
 * 都能单测，不用起浏览器。
 *
 * 这里是唯一的「业务 ↔ Ribbon」翻译层。Ribbon 组件不认识文档，
 * actions 不认识按钮，两边都只通过这一层对接。
 */

import type { RibbonItemSpec, RibbonTabDef } from '../ribbon/ribbon-model';
import {
  DEFAULT_PAINT_A,
  MIX_BLENDS,
  defaultTextShadow,
  normalizeStops,
  type ImageElement,
  type MixBlend,
  type Paint,
  type ShapeElement,
  type TextElement,
  type TextStyle,
  type TypographyDocument,
  type TypographyElement,
  type TypographyGroup,
} from '../../typography/document';
import {
  BUILTIN_THEMES,
  resolveThemeColor,
  themeById,
  type TypographyTheme,
} from '../../typography/theme';
import type { MessageKey } from '../../i18n/locales';
import type { AnimPreset } from '../../typography/animation';
import { GRID_LIMITS, type TypoGridPrefs } from '../../typography/grid';
import {
  SHAPE_PRESETS,
  shapeDefaultsToStrokeOnly,
  shapeGeometry,
  shapeParamSupport,
} from '../../typography/shapes';
import type { GalleryCard } from '../ribbon/ribbon-model';
import { CROP_ASPECTS } from '../../typography/image-geometry';
import { minSpanValue, uniformSpanValue, type SpanStyleKey } from '../../typography/rich-text';
import type { TypographyActions } from './actions';
import { loadRecentFonts, orderByRecent, rememberFont } from './recent-fonts';
import { cssFamily } from '../../typography/font/css-family';
import type { SelectOption } from '../controls/select-model';
import { tr } from '../../i18n/index.svelte';

/**
 * 「设计」页「画布大小」按钮的 testid。
 *
 * 它不只是测试选择器：画布尺寸浮层的**锚点**也靠它现查 —— Ribbon item 的
 * `onselect` 是无参意图，拿不到事件目标。两处共用一个常量，改名不会只改一半。
 */
export const CANVAS_SIZE_TESTID = 'ribbon-canvas-size';

/**
 * 「设计」页「镜头」按钮的 testid。
 *
 * 与 `CANVAS_SIZE_TESTID` 同一条理由：它同时是镜头浮层的锚点与 E2E 契约。
 */
export const CAMERA_TESTID = 'ribbon-camera';

/**
 * 「图片格式」里会开浮层的四个按钮（色彩校正 / 重新着色 / 滤镜 / 调整大小）。
 *
 * 与 `CANVAS_SIZE_TESTID` 同一条理由：Ribbon 的按钮只能发无参意图，浮层锚点
 * 由编辑器按 testid 现查。放在这里让「按钮」与「锚点」共用同一个常量。
 * （「裁剪」是一次性菜单，不需要浮层。）
 */
export type ImageToolId = 'adjust' | 'recolor' | 'filter' | 'size';

export const IMAGE_TOOL_TESTIDS: Record<ImageToolId, string> = {
  adjust: 'ribbon-image-adjust',
  recolor: 'ribbon-image-recolor',
  filter: 'ribbon-image-filter',
  size: 'ribbon-image-size',
};

export interface TypographyRibbonInput {
  doc: TypographyDocument;
  selection: TypographyElement[];
  alignTarget: 'canvas' | 'selection';
  /** 已注册的字体族（字体下拉的内容）。 */
  fontFamilies: string[];
  /**
   * 从**本机**枚举来的族名。与 `fontFamilies` 分开传：那个能嵌入导出，
   * 这个不能 —— 下拉里两者一视同仁（用户挑字体时看的是「长什么样」），
   * 但状态层必须分得清。
   */
  localFontFamilies: string[];
  /** 当前环境支不支持读本机字体（入口按钮据此置灰）。 */
  supportsLocalFonts: boolean;
  /** 打开「自定义 CSS」弹窗（界面状态，所以由编辑器提供）。 */
  onOpenCustomCss: () => void;
  /** 打开「插入图标」选择器（同上）。 */
  onOpenIconPicker: () => void;
  /** 打开「插入生成器」选择器（同上）。 */
  onOpenGenPicker: () => void;
  /** 媒体池开着没有（「插入」页里的开合按钮显示激活态）。 */
  mediaPoolOpen: boolean;
  /** 开合媒体池（同上）。 */
  onToggleMediaPool: () => void;
  /** 「转为图片」逃生舱。 */
  onFlatten: () => void;
  /** 网格 / 画幅线框的当前值。 */
  grid: TypoGridPrefs;
  /** 局部更新网格设置。 */
  onGrid: (patch: Partial<TypoGridPrefs>) => void;
  /** 选区恰好是一个完整组合时，那个组合的定义（「组合格式」控件的取值来源）。 */
  soleGroup: TypographyGroup | null;
  /**
   * 编辑文本时的**行内选区**（纯文本 UTF-16 下标）。
   *
   * 有它 ⇒ 字体/字号/加粗这些控件改的是选中的那一段；没有 ⇒ 改整个元素。
   * 这个判断只做一次（在 `tv()` 与 `a.setTextStyle` 里），不让每个控件各判一遍。
   */
  spanRange: { elId: string; start: number; end: number } | null;
  /**
   * 当前是否处于顶点 / 控制点编辑态。
   *
   * 与 `soleGroup` 一样属于「当前处于哪种细粒度编辑」这一类输入 —— 放在这里
   * 而不是让 Ribbon 自己去读 `editorState`，是为了让这张表保持**纯函数**
   * （能直接单测，也不必知道状态住在哪）。
   */
  nodeEditing: boolean;
  /**
   * 工程里的自定义配色方案（`Project.customThemes`）。「设计」选项卡的图库
   * 与一切 `@slot` 解析都要带上它们 —— 文档里的引用可能指向自定义方案。
   */
  customThemes: readonly TypographyTheme[];
  /** 打开「配色方案编辑器」（界面状态，所以由编辑器提供）。 */
  onOpenThemeEditor: () => void;
  /** 开合「画布大小」浮层（画幅 / 上屏大小，见 `CanvasSizePopover`）。 */
  onOpenCanvasSize: () => void;
  /** 开合「镜头」浮层（2.5D 视差，见 `CameraPopover`）。 */
  onOpenCamera: () => void;
  /** 打开「图片格式」的某个浮层（锚点由编辑器按 `IMAGE_TOOL_TESTIDS` 现查）。 */
  onOpenImageTool: (tool: ImageToolId) => void;
  /** 四角调整模式的开合（= 写 `ImageElement.quad` 并进入画布手柄态）。 */
  onImageQuad: (enable: boolean) => void;
  /** 当前是否处于四角调整模式（按钮的激活态）。 */
  quadEditing: boolean;
  /** 当前打开的图片浮层（按钮的激活态；null = 都关着）。 */
  imageTool: ImageToolId | null;
  /**
   * 当前启用的刷子（`editorState.painter?.kind`）。按钮的激活态靠它。
   *
   * 与 `nodeEditing` / `quadEditing` 同一条理由：Ribbon 表是纯函数，
   * 状态从外面喂进来，不让它自己去读 `editorState`。
   */
  painter: 'format' | 'animation' | null;
}

const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
/** 字号下拉的阶梯。**增减按钮不再走它**（按比例缩放，见 actions.scaleFontSize）。 */
const FONT_SIZES = [12, 16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 160, 200];

/** 字符间距预设（px）。档位与 Office 的「很紧 / 紧密 / 常规 / 疏松 / 很松 / 更松」对齐。 */
const SPACING_PRESETS: { value: number; labelKey: MessageKey }[] = [
  { value: -4, labelKey: 'rib.spacingVeryTight' },
  { value: -2, labelKey: 'rib.spacingTight' },
  { value: 0, labelKey: 'rib.spacingNormal' },
  { value: 2, labelKey: 'rib.spacingLoose' },
  { value: 4, labelKey: 'rib.spacingVeryLoose' },
  { value: 8, labelKey: 'rib.spacingWider' },
];

/** 大小写转换的四个选项（模型里 `textTransform` 能表达的四种）。 */
const CASE_OPTIONS: { value: TextStyle['textTransform']; labelKey: MessageKey }[] = [
  { value: 'none', labelKey: 'rib.caseNone' },
  { value: 'capitalize', labelKey: 'rib.caseCapitalize' },
  { value: 'uppercase', labelKey: 'rib.caseUpper' },
  { value: 'lowercase', labelKey: 'rib.caseLower' },
];

const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;

/** 「设计」页两个配色方案动作按钮的宽度（默认 50px 装不下它们的标签）。 */
const THEME_BTN_W = 84;

/** 「画布大小」四个字：默认 50px 差一点，给 58 正好不省略。 */
const CANVAS_BTN_W = 58;

/** 「镜头」两个字 + 图标，比默认宽一点点（与画布按钮同高时读起来才齐）。 */
const CAMERA_BTN_W = 58;

function firstText(sel: TypographyElement[]): TextElement | null {
  return (sel.find((e) => e.kind === 'text') as TextElement | undefined) ?? null;
}
function firstShape(sel: TypographyElement[]): ShapeElement | null {
  return (sel.find((e) => e.kind === 'shape') as ShapeElement | undefined) ?? null;
}
function firstImage(sel: TypographyElement[]): ImageElement | null {
  return (sel.find((e) => e.kind === 'image') as ImageElement | undefined) ?? null;
}

/**
 * 形状面板的缩略图。
 *
 * **直接跑 `shapeGeometry`**，不是手画一套预览图 —— 手画的那套迟早与真实
 * 几何分家（改了梯形比例，面板里还是旧样子）。预览盒固定 100×100，
 * 于是 viewBox 也是 `0 0 100 100`。
 */
function shapeCards(): GalleryCard[] {
  return SHAPE_PRESETS.map((p) => {
    const geo = shapeGeometry(p.id, {
      w: 100,
      h: 100,
      radius: p.radius,
      sides: p.sides,
      waist: p.waist,
      angle: p.angle,
      inner: p.id === 'ring' ? 16 : p.id === 'frame' ? 12 : undefined,
    });
    return {
      id: p.key,
      label: tr(p.labelKey),
      d: geo.d,
      viewBox: geo.viewBox,
      evenOdd: geo.evenOdd,
      // 直线没有面积，填充等于什么都不画。
      outline: shapeDefaultsToStrokeOnly(p.id),
    };
  });
}

/**
 * 字体下拉的选项：已注册的族 + 文档里正在用的族（后者可能尚未注册），最近用过的置顶。
 *
 * 每项带上 `fontFamily` —— 这样「宋体」两个字是宋体画的，「Lora」是 Lora 画的。
 * 挑字体时看的是「长什么样」，比任何小字说明都直接。值已经过 `cssFamily`
 * 加引号转义（族名里的空格 / 数字 / 逗号会让裸拼的声明整条失效）。
 */
function fontOptions(input: TypographyRibbonInput, current: string): SelectOption<string>[] {
  const names = new Set([...input.fontFamilies, ...input.localFontFamilies]);
  for (const el of input.doc.elements) {
    if (el.kind === 'text') names.add(el.style.fontFamily);
  }
  if (current) names.add(current);
  return orderByRecent([...names], loadRecentFonts()).map((f) => {
    const family = cssFamily(f);
    return { value: f, label: f, fontFamily: family || undefined };
  });
}

export function buildTypographyTabs(
  input: TypographyRibbonInput,
  a: TypographyActions,
): RibbonTabDef[] {
  const { selection, alignTarget } = input;
  const n = selection.length;
  const text = firstText(selection);
  const shape = firstShape(selection);
  const image = firstImage(selection);
  const hasText = text !== null;
  /** 一个元素都没选中时，几乎所有编辑动作都没意义 —— 置灰而不是隐藏。 */
  const none = n === 0;

  const style: TextStyle | null = text?.style ?? null;
  /** 当前（第一个）图形支持哪些形状参数。没选中图形时全 false，整组为空。 */
  const support = shapeParamSupport(shape?.shape ?? 'rect');

  /* 填充：Ribbon 上只留「方式 + 主色」两个控件（细节参数在右侧「元素属性」
     面板里，见 shape-format 里填充组的注释）。取值一律从 `shape` 上读，
     没有图形时给默认值（此时控件是禁用态，值只是占位）。 */
  const fillKind: Paint['kind'] = shape?.fill.kind ?? 'solid';
  /** 主色 = 渐变的**开始色**（offset 最小的色标），与「渐变开始」这个标签一致。 */
  const fillColorA =
    shape?.fill.kind === 'solid' || shape?.fill.kind === 'texture'
      ? shape.fill.color
      : shape?.fill.kind === 'linear' || shape?.fill.kind === 'radial'
        ? (normalizeStops(shape.fill.stops)[0]?.color ?? DEFAULT_PAINT_A)
        : DEFAULT_PAINT_A;

  /*
   * 文字填充：只有 `linear` / `radial` / `texture` 才有意义 —— `solid` / `none`
   * 对字形来说就是「跟随文字色」（纯色字形仍走 `style.color`，见 document.ts）。
   */
  const textFillKind: 'none' | 'linear' | 'radial' | 'texture' =
    text?.fill && text.fill.kind !== 'none' && text.fill.kind !== 'solid' ? text.fill.kind : 'none';
  const textFillColorA =
    text?.fill?.kind === 'linear' || text?.fill?.kind === 'radial'
      ? (normalizeStops(text.fill.stops)[0]?.color ?? DEFAULT_PAINT_A)
      : text?.fill?.kind === 'texture'
        ? text.fill.color
        : DEFAULT_PAINT_A;

  /* 组合：只在**选区恰好是一个完整的组**时才出现「组合格式」选项卡。 */
  /*
   * 文本属性的**当前值**：有行内选区就读区间上的生效值，否则读元素级。
   *
   * 读「生效值」而不是「补丁」：一段没写覆盖、元素级是 700 的字，加粗按钮必须
   * 是按下态 —— 否则用户会以为「明明加粗了，按钮却没亮」。
   */
  const range = input.spanRange;
  function tv<K extends SpanStyleKey>(key: K): TextStyle[K] | null {
    if (!text) return null;
    if (range) {
      const u = uniformSpanValue(text.runs, range.start, range.end, text.style, key);
      // 区间内不一致时回落到元素级：这比「硬选一个」诚实，也让再次点击的行为可预期。
      if (u.uniform) return u.value;
    }
    return text.style[key];
  }

  /**
   * 带「区间内是否一致」的读法（字号「XX+」用它）。
   *
   * `tv` 把 `uniform` 吞掉了，而**不一致这件事本身就是要显示出来的东西** ——
   * 一致时刻意不显示的那个「+」正是它的信号。没有它，一行 24 与 48 混排的字
   * 会在输入框里显示成其中一个值，用户改字号时看到的是假的现状。
   */
  function tvUniform<K extends SpanStyleKey>(
    key: K,
  ): { uniform: boolean; value: TextStyle[K] } | null {
    if (!text) return null;
    if (range) {
      return uniformSpanValue(text.runs, range.start, range.end, text.style, key);
    }
    return { uniform: true, value: text.style[key] };
  }

  /**
   * 字号输入框的显示值：区间内字号不一致时显示 `${min}+`（模糊值）。
   *
   * 「97+」读作「至少 97」—— 取的是区间里的**最小值**，不是起点值。
   * 用户看到它就知道这里大小不一，按增减按钮也是整体缩放（见 `scaleFontSize`）。
   */
  const fontSizeText = (() => {
    if (!text) return '0';
    const u = tvUniform('fontSize');
    if (!u) return String(text.style.fontSize);
    if (u.uniform) return String(u.value);
    const min = minSpanValue(text.runs, range?.start ?? 0, range?.end ?? 0, text.style, 'fontSize');
    return `${Math.round(min)}+`;
  })();

  /** 每按一次「增大 / 减小字号」的比例。按比例而不是按档位，见 `scaleFontSize`。 */
  const FONT_SCALE_STEP = 1.15;

  const group = input.soleGroup;
  /** 布尔运算至少要两个图形（多了才有「并」可言）。 */
  const canBool = selection.filter((e) => e.kind === 'shape').length >= 2;
  const groupFillColor =
    group?.fill.kind === 'solid' || group?.fill.kind === 'texture'
      ? group.fill.color
      : group?.fill.kind === 'linear' || group?.fill.kind === 'radial'
        ? (group.fill.stops[0]?.color ?? DEFAULT_PAINT_A)
        : DEFAULT_PAINT_A;

  /**
   * 当前配色方案（「设计」选项卡的数据源）。
   *
   * 走 `themeById` 而不是直接读 `doc.theme`：未设、或工程里存着一个本版本
   * 没有的方案 id 时，界面必须显示**渲染时真正用的那个方案** ——
   * 两处各判一次的话，会出现「面板显示 A、画面用的是 B」。
   * 自定义方案（`Project.customThemes`）也在查表范围内。
   */
  const theme = themeById(input.doc.theme, input.customThemes);
  /** 图库的全部方案：内置 + 工程自定义（自定义排后面，id 不冲突）。 */
  const allThemes = [...BUILTIN_THEMES, ...input.customThemes];

  const tabs: RibbonTabDef[] = [
    /* ------------------------------------------------------------ 开始 */
    {
      id: 'home',
      label: tr('rib.home'),
      order: 0,
      groups: [
        {
          /*
           * 格式刷：**最左侧**（用户指定），单独成组。塞进「字体」组里会让它
           * 挂在「字体」这个组名下 —— 刷的是填充/描边/圆角/图片处理，不是字。
           *
           * 单击 = 刷一次（再点一次取消）；**双击** = 连续刷（用户要求的两种模式）。
           * `canPaint` 在已启用时恒为 true：连续模式下选区会跟着目标走，若按
           * 「必须单选一个元素」判可用，刷完第一个按钮就自己灰掉了。
           */
          id: 'format-copy',
          label: tr('rib.group.formatCopy'),
          items: [
            {
              kind: 'toggle',
              id: 'format-painter',
              label: tr('rib.formatPainter'),
              icon: 'paintbrush',
              testid: 'typo-format-painter',
              active: input.painter === 'format',
              disabled: !a.canPaint('format'),
              onchange: () => a.togglePainter('format', false),
              ondblclick: () => a.togglePainter('format', true),
            },
          ],
        },
        {
          id: 'font',
          label: tr('rib.group.font'),
          /*
           * 两排（`layout: 'rows'`），排法与 PowerPoint 一致：
           *   第一排 = 字体 · 字号 · 字号 ∓ · 清除全部格式 · 字体资源
           *   第二排 = 粗体 斜体 下划线 阴影 删除线 字距 大小写 高亮 字体颜色
           *
           * 为什么要分排：原来九个字形按钮全部是「icon 在上、文字在下」的大按钮，
           * 字号 ∓ 还各带一个「减小字号」这样的四字标签 —— 光这一组就吃掉 700 多
           * 像素，把别的组全挤到滚动条的右边去。而 B / I / U / S 这些符号本身
           * 就是写法，配文字只是噪声。纯图标之后同一组只占 ~380px。
           */
          layout: 'rows',
          items: [],
          rows: [
            [
              {
                kind: 'select',
                id: 'font-family',
                label: tr('rib.fontFamily'),
                // 触发区里显示的就是字体名，底下再压一行小字「字体」是纯噪声。
                hideLabel: true,
                testid: 'ribbon-font-family',
                // 固定宽度 + 触发区自己 ellipsis：字体名长度不可控，让它撑开的话
                // 整条 Ribbon 的布局会在换字体时跳一下（用户反馈的「tab 跳变」）。
                width: 148,
                optionTestidPrefix: 'ribbon-font-option',
                // 本机字体加载后选项有几百条，扫不动：开筛选框（Select 自带，
                // 输入即模糊过滤），最近用过的族已由 fontOptions 置顶。
                filterable: true,
                filterPlaceholder: tr('rib.fontSearch'),
                value: tv('fontFamily') ?? '',
                disabled: !hasText,
                options: fontOptions(input, tv('fontFamily') ?? ''),
                onchange: (v) => {
                  // 记一次「最近使用」——必须在 commit 之前写，因为下面那次
                  // setTextStyle 会触发 Ribbon 重建，重建时才读得到新顺序。
                  rememberFont(v);
                  a.setTextStyle('fontFamily', v);
                },
              },
              {
                kind: 'select',
                id: 'font-size',
                label: tr('rib.fontSize'),
                hideLabel: true,
                testid: 'ribbon-font-size',
                width: 84,
                // 可编辑 + numeric：**「97+」这种非预设值也落在 value 上**，
                // Select 的 labelOf 在选项里找不到就原样显示（见 controls/Select.svelte）。
                editable: true,
                numeric: true,
                value: fontSizeText,
                disabled: !hasText,
                options: FONT_SIZES.map((s) => ({ value: String(s), label: String(s) })),
                onchange: (v) => a.setTextStyle('fontSize', Number(v)),
              },
              {
                kind: 'button',
                id: 'font-size-dec',
                label: tr('rib.fontSizeDown'),
                icon: 'a-arrow-down',
                size: 'icon',
                testid: 'ribbon-font-size-dec',
                disabled: !hasText || !a.canScaleFontSize(-1),
                onselect: () => a.scaleFontSize(1 / FONT_SCALE_STEP),
              },
              {
                kind: 'button',
                id: 'font-size-inc',
                label: tr('rib.fontSizeUp'),
                icon: 'a-arrow-up',
                size: 'icon',
                testid: 'ribbon-font-size-inc',
                disabled: !hasText || !a.canScaleFontSize(1),
                onselect: () => a.scaleFontSize(FONT_SCALE_STEP),
              },
              {
                kind: 'button',
                id: 'clear-format',
                label: tr('rib.clearFormat'),
                /*
                 * 「清除全部格式」：**选中文本**就能用（清元素级），有行内选区时
                 * 只清那一段的覆盖（见 actions.clearTextFormatting）。
                 * 原来只在「选了一段字」时可用 —— 但「整块文字全是花字体想回默认」
                 * 是最常见的用法，那时反而点不动。
                 */
                icon: 'eraser',
                size: 'icon',
                testid: 'typo-clear-format',
                disabled: !hasText,
                onselect: () => a.clearTextFormatting(),
              },
            ],
            [
              {
                kind: 'toggle',
                id: 'bold',
                label: tr('rib.bold'),
                icon: 'bold',
                size: 'icon',
                testid: 'ribbon-bold',
                disabled: !hasText,
                active: (tv('fontWeight') ?? 400) >= 600,
                onchange: () => a.toggleTextFlag('bold'),
              },
              {
                kind: 'toggle',
                id: 'italic',
                label: tr('rib.italic'),
                icon: 'italic',
                size: 'icon',
                testid: 'ribbon-italic',
                disabled: !hasText,
                active: tv('fontStyle') === 'italic',
                onchange: () => a.toggleTextFlag('italic'),
              },
              {
                kind: 'toggle',
                id: 'underline',
                label: tr('rib.underline'),
                icon: 'underline',
                size: 'icon',
                testid: 'ribbon-underline',
                disabled: !hasText,
                active: tv('textDecoration') === 'underline',
                onchange: () => a.toggleTextFlag('underline'),
              },
              {
                kind: 'toggle',
                id: 'text-shadow',
                label: style?.shadow ? tr('rib.textShadowOn') : tr('rib.textShadow'),
                icon: 'text-shadow',
                size: 'icon',
                testid: 'ribbon-text-shadow',
                disabled: !hasText,
                active: !!style?.shadow,
                // 开关语义：有阴影就关掉，没有就套一份默认参数（偏移/模糊按字号比例，
                // 见 document.ts::defaultTextShadow）。阴影是**数组**（多层），
                // 开关只造一层；逐层调整在「元素属性」面板里。
                onchange: () => a.setTextShadow(style?.shadow ? undefined : [defaultTextShadow()]),
              },
              {
                kind: 'toggle',
                id: 'strike',
                label: tr('rib.strike'),
                icon: 'strikethrough',
                size: 'icon',
                testid: 'ribbon-strike',
                disabled: !hasText,
                active: tv('textDecoration') === 'line-through',
                onchange: () => a.toggleTextFlag('strike'),
              },
              {
                kind: 'menu',
                id: 'letter-spacing',
                label: tr('rib.letterSpacing'),
                icon: 'letter-spacing',
                size: 'icon',
                testid: 'ribbon-letter-spacing',
                disabled: !hasText,
                items: SPACING_PRESETS.map((p) => ({
                  id: `ribbon-spacing-${p.value}`,
                  label: tr(p.labelKey),
                  active: Math.abs((tv('letterSpacing') ?? 0) - p.value) < 0.01,
                  onselect: () => a.setTextStyle('letterSpacing', p.value),
                })),
                // 预设之外的任意值走这个输入框 —— 「字距仍然能精确调」是必须的，
                // 预设只是省掉大多数情况下的手输。
                numeric: {
                  label: tr('rib.spacingCustom'),
                  value: tv('letterSpacing') ?? 0,
                  min: -100,
                  max: 400,
                  step: 0.5,
                  precision: 1,
                  suffix: 'px',
                  onchange: (v) => a.setTextStyle('letterSpacing', v),
                },
              },
              {
                kind: 'menu',
                id: 'text-case',
                label: tr('rib.caseTransform'),
                icon: 'case-sensitive',
                size: 'icon',
                testid: 'ribbon-text-case',
                disabled: !hasText,
                items: CASE_OPTIONS.map((o) => ({
                  id: `ribbon-case-${o.value}`,
                  label: tr(o.labelKey),
                  /*
                   * 读**元素级**而不是 `tv()`：`textTransform` 不在行内可覆盖的
                   * 白名单里（同一行里两种大小写转换谁也画不对），所以行内选区
                   * 对它没有意义，勾选态只看元素级。
                   */
                  active: (style?.textTransform ?? 'none') === o.value,
                  // 走 setTextProp 而不是 setTextStyle：后者只收「可行内覆盖」的键，
                  // 而 textTransform 是段落级的（见上面的说明）。
                  onselect: () => a.setTextProp('textTransform', o.value),
                })),
              },
              {
                kind: 'color',
                id: 'text-highlight',
                label: tr('rib.textHighlight'),
                icon: 'highlighter',
                size: 'icon',
                // 高亮可以「没有」，所以给「无颜色」这一项。
                allowNone: true,
                testid: 'ribbon-text-highlight',
                value: tv('highlight') ?? '',
                disabled: !hasText,
                onchange: (v) => a.setTextHighlight(v || undefined),
              },
              {
                kind: 'color',
                id: 'text-color',
                label: tr('rib.fontColor'),
                icon: 'baseline',
                size: 'icon',
                testid: 'ribbon-text-color',
                value: tv('color') ?? '',
                disabled: !hasText,
                onchange: (v) => a.setTextStyle('color', v),
              },
              /*
               * 字体资源两个按钮被推到**行尾**：它们不是字形格式，与左边那排
               * （B / I / U …）本来就不同类；靠一个弹性间隔推到右端之后，
               * 第二排的右边缘正好与第一排（宽下拉那一排）对齐 ——
               * 间距不定死，字号/字体名变宽变窄都不会破坏对齐。
               */
              { kind: 'spacer', id: 'font-spacer' },
              {
                kind: 'button',
                id: 'load-local-fonts',
                label: tr('rib.loadLocalFonts'),
                // 「系统里已有的字体」—— 用字体字形而不是 import（那个是把文件拿进来）。
                icon: 'type',
                size: 'icon',
                testid: 'typo-local-fonts',
                /*
                 * 不支持就置灰。Firefox / Safari / 移动端上这个 API 根本不存在，
                 * 让它可点只会得到一句「你的浏览器不行」—— 不如一开始就说清楚。
                 * 另外它要求**用户手势**，所以只能挂在按钮上，不能在启动时自动跑。
                 */
                disabled: !input.supportsLocalFonts,
                onselect: () => a.loadLocalFonts(),
              },
              {
                kind: 'button',
                id: 'import-font',
                label: tr('rib.importFont'),
                // 语义是「拿进来」，不是「传上去」—— 用 upload 的箭头朝上会误导。
                icon: 'file-type-corner',
                size: 'icon',
                testid: 'typo-font-import',
                onselect: () => a.importFont(),
              },
            ],
          ],
        },
        {
          id: 'para',
          label: tr('rib.group.para'),
          items: [
            /*
             * 这里原来还有一个「字距」输入框，现在归字体组的「字符间距」菜单
             * （预设 + 自定义输入框）。
             *
             * 同一个属性摆两个入口看着更「方便」，实际是困惑源：改了其中一个，
             * 另一个的值会跟着变，而用户会以为它们是两件事。字距是字形属性，
             * 与字体/字号同组才是对的位置；段落组留下真正段落级的那一项（行高）。
             */
            {
              kind: 'number',
              id: 'line-height',
              label: tr('rib.lineHeight'),
              testid: 'ribbon-line-height',
              value: style?.lineHeight ?? 1.2,
              step: 0.05,
              precision: 2,
              disabled: !hasText,
              oninput: (v) => a.setTextPropLive('lineHeight', v),
              onliveend: () => a.endTextPropLive(),
              onchange: (v) => a.setTextProp('lineHeight', v),
            },
          ],
        },
        /* 文本对齐拆成独立两组并排成两行：整组都是小按钮，一字排开要横着
           占掉两百多像素，而它只占 24px 高。两行之后省下的宽度留给字体组。 */
        {
          id: 'align-text-h',
          label: tr('rib.group.alignTextH'),
          layout: 'grid',
          items: [
            {
              kind: 'toggle',
              id: 'align-left',
              label: tr('rib.alignHLeft'),
              size: 'small',
              icon: 'text-align-start',
              testid: 'ribbon-align-left',
              disabled: !hasText,
              active: style?.align === 'left',
              onchange: () => a.setTextAlign('left'),
            },
            {
              kind: 'toggle',
              id: 'align-center',
              label: tr('rib.alignHCenter'),
              size: 'small',
              icon: 'text-align-center',
              testid: 'ribbon-align-center',
              disabled: !hasText,
              active: style?.align === 'center',
              onchange: () => a.setTextAlign('center'),
            },
            {
              kind: 'toggle',
              id: 'align-right',
              label: tr('rib.alignHRight'),
              size: 'small',
              icon: 'text-align-end',
              testid: 'ribbon-align-right',
              disabled: !hasText,
              active: style?.align === 'right',
              onchange: () => a.setTextAlign('right'),
            },
            {
              kind: 'toggle',
              id: 'align-justify',
              label: tr('rib.alignHJustify'),
              size: 'small',
              icon: 'text-align-justify',
              testid: 'ribbon-align-justify',
              disabled: !hasText,
              active: style?.align === 'justify',
              onchange: () => a.setTextAlign('justify'),
            },
          ],
        },
        {
          id: 'align-text-v',
          label: tr('rib.group.alignTextV'),
          layout: 'grid',
          items: [
            {
              kind: 'toggle',
              id: 'valign-top',
              label: tr('rib.alignVTop'),
              size: 'small',
              icon: 'align-start-horizontal',
              testid: 'ribbon-valign-top',
              disabled: !hasText,
              active: style?.vAlign === 'top',
              onchange: () => a.setVAlign('top'),
            },
            {
              kind: 'toggle',
              id: 'valign-middle',
              label: tr('rib.alignVMiddle'),
              size: 'small',
              icon: 'align-center-horizontal',
              testid: 'ribbon-valign-middle',
              disabled: !hasText,
              active: style?.vAlign === 'middle',
              onchange: () => a.setVAlign('middle'),
            },
            {
              kind: 'toggle',
              id: 'valign-bottom',
              label: tr('rib.alignVBottom'),
              size: 'small',
              icon: 'align-end-horizontal',
              testid: 'ribbon-valign-bottom',
              disabled: !hasText,
              active: style?.vAlign === 'bottom',
              onchange: () => a.setVAlign('bottom'),
            },
          ],
        },
        {
          id: 'align',
          label: tr('rib.group.align'),
          items: [
            {
              kind: 'segment',
              id: 'align-target',
              label: tr('rib.alignTo'),
              testid: 'typo-align-target',
              value: alignTarget,
              options: [
                { value: 'canvas', label: tr('rib.alignTargetCanvas') },
                { value: 'selection', label: tr('rib.alignTargetSelection') },
              ],
              onchange: (v) => a.setAlignTarget(v as 'canvas' | 'selection'),
            },
            {
              kind: 'button',
              id: 'align-l',
              label: tr('rib.alignLeft'),
              icon: 'align-start-vertical',
              testid: 'typo-align-left',
              disabled: none,
              onselect: () => a.align('left'),
            },
            {
              kind: 'button',
              id: 'align-ch',
              label: tr('rib.centerH'),
              icon: 'align-center-vertical',
              testid: 'typo-center-h',
              disabled: none,
              onselect: () => a.align('center-h'),
            },
            {
              kind: 'button',
              id: 'align-r',
              label: tr('rib.alignRight'),
              icon: 'align-end-vertical',
              testid: 'typo-align-right',
              disabled: none,
              onselect: () => a.align('right'),
            },
            {
              kind: 'button',
              id: 'align-t',
              label: tr('rib.alignTop'),
              icon: 'align-start-horizontal',
              testid: 'typo-align-top',
              disabled: none,
              onselect: () => a.align('top'),
            },
            {
              kind: 'button',
              id: 'align-cv',
              label: tr('rib.centerV'),
              icon: 'align-center-horizontal',
              testid: 'typo-center-v',
              disabled: none,
              onselect: () => a.align('middle'),
            },
            {
              kind: 'button',
              id: 'align-b',
              label: tr('rib.alignBottom'),
              icon: 'align-end-horizontal',
              testid: 'typo-align-bottom',
              disabled: none,
              onselect: () => a.align('bottom'),
            },
            {
              kind: 'button',
              id: 'dist-h',
              label: tr('rib.distributeH'),
              icon: 'align-horizontal-space-between',
              testid: 'typo-distribute-h',
              // 少于 3 个没有「等距」可言
              disabled: n < 3,
              onselect: () => a.align('distribute-h'),
            },
            {
              kind: 'button',
              id: 'dist-v',
              label: tr('rib.distributeV'),
              icon: 'align-vertical-space-between',
              testid: 'typo-distribute-v',
              disabled: n < 3,
              onselect: () => a.align('distribute-v'),
            },
          ],
        },
        {
          id: 'order',
          label: tr('rib.group.order'),
          layout: 'grid',
          items: [
            {
              kind: 'button',
              id: 'to-front',
              label: tr('rib.toFront'),
              size: 'small',
              icon: 'bring-to-front',
              testid: 'typo-to-front',
              disabled: none,
              onselect: () => a.order('front'),
            },
            {
              kind: 'button',
              id: 'forward',
              label: tr('common.up'),
              size: 'small',
              icon: 'move-up',
              testid: 'typo-forward',
              disabled: none,
              onselect: () => a.order('forward'),
            },
            {
              kind: 'button',
              id: 'backward',
              label: tr('common.down'),
              size: 'small',
              icon: 'move-down',
              testid: 'typo-backward',
              disabled: none,
              onselect: () => a.order('backward'),
            },
            {
              kind: 'button',
              id: 'to-back',
              label: tr('rib.toBack'),
              size: 'small',
              icon: 'send-to-back',
              testid: 'typo-to-back',
              disabled: none,
              onselect: () => a.order('back'),
            },
          ],
        },
        {
          id: 'edit',
          label: tr('rib.group.edit'),
          items: [
            {
              kind: 'button',
              id: 'add-text',
              label: tr('rib.addText'),
              icon: 'type',
              testid: 'typo-add-text',
              onselect: () => a.addText(),
            },
            {
              kind: 'button',
              id: 'duplicate',
              label: tr('rib.duplicate'),
              icon: 'copy',
              testid: 'typo-duplicate',
              disabled: none,
              onselect: () => a.duplicateSelection(),
            },
            {
              kind: 'button',
              id: 'delete',
              label: tr('common.delete'),
              icon: 'trash',
              testid: 'typo-delete',
              disabled: none,
              onselect: () => a.deleteSelection(),
            },
            {
              kind: 'toggle',
              id: 'lock',
              label: tr('rib.lock'),
              icon: 'lock',
              testid: 'typo-lock',
              disabled: none,
              active: selection.every((e) => e.locked),
              onchange: () => a.toggleFlag('locked'),
            },
            {
              kind: 'toggle',
              id: 'hide',
              label: tr('rib.hide'),
              icon: 'eye-off',
              testid: 'typo-hide',
              disabled: none,
              active: selection.every((e) => !e.visible),
              onchange: () => a.toggleFlag('visible'),
            },
          ],
        },
        /*
         * 文字填充。文本属性住在「开始」里（见 contextualTabIds 的约定），
         * 所以它是一组条件出现在 home 里的组 —— 只有选中文本时才占用空间。
         * 组里只有渐变 / 径向 / 纹理：纯色字形仍由「字体」组里的「文字颜色」
         * （`style.color`）负责。
         */
        ...(hasText
          ? [
              {
                id: 'text-fill',
                label: tr('rib.group.textFill'),
                items: [
                  {
                    kind: 'select' as const,
                    id: 'text-fill-kind',
                    label: tr('rib.fillKind'),
                    testid: 'ribbon-text-fill-kind',
                    width: 108,
                    value: textFillKind,
                    optionTestidPrefix: 'ribbon-text-fill-kind-option',
                    options: [
                      { value: 'none', label: tr('rib.textFillFollow') },
                      { value: 'linear', label: tr('rib.fillLinear') },
                      { value: 'radial', label: tr('rib.fillRadial') },
                      { value: 'texture', label: tr('rib.fillTexture') },
                    ],
                    onchange: (v: string) =>
                      v === 'none' ? a.clearTextFill() : a.setTextFill({ kind: v as Paint['kind'] }),
                  },
                  /*
                   * 与「图形格式」的填充组同一条纪律：只留类型 + 主色，两个控件
                   * 不随类型增删 —— 组宽稳定，切换填充方式时后面的组不会整体位移。
                   * 细节参数（第二色 / 角度 / 图案 / 周期 / 线宽 / 不透明度）
                   * 在右侧「元素属性」面板的「字形填充」区里。
                   */
                  {
                    kind: 'color' as const,
                    id: 'text-fill',
                    label: textFillKind === 'texture' ? tr('rib.textureInk') : tr('rib.gradientFrom'),
                    icon: 'paint-bucket' as const,
                    testid: 'ribbon-text-fill',
                    value: textFillColorA,
                    disabled: textFillKind === 'none',
                    onchange: (v: string) => a.setTextFill({ color: v }),
                  },
                ],
              },
            ]
          : []),
        /*
         * 文字转路径。与「文字填充」同一条出现规则：只有选中文本时才占位置。
         * 转换会把文本框拆成图形（多色时多个），所以**放在「开始」而不是
         * 「图形格式」** —— 后者只有在选中图形后才出现，而那时已经晚了。
         */
        ...(hasText
          ? [
              {
                id: 'text-path',
                label: tr('rib.group.textPath'),
                items: [
                  {
                    kind: 'button' as const,
                    id: 'text-to-path',
                    label: tr('rib.textToPath'),
                    icon: 'spline' as const,
                    testid: 'typo-text-to-path',
                    onselect: () => a.convertTextToPath(),
                  },
                ],
              },
            ]
          : []),
      ],
    },

    /* ------------------------------------------------------------ 设计 */
    {
      id: 'design',
      label: tr('rib.design'),
      order: 1,
      groups: [
        /*
         * 「画布」组：画幅（文档尺寸 / 比例）与上屏大小。
         *
         * 之前这枚读数挂在画布下方的缩放条上，看着像缩放的一部分 —— 而它改的是
         * 版式本身，属于「设计」，所以搬到这里。按钮本身不带读数（Ribbon 的标签
         * 是静态文案），尺寸在浮层里看。
         */
        {
          id: 'canvas',
          label: tr('rib.group.canvas'),
          items: [
            {
              kind: 'button',
              id: 'canvas-size',
              label: tr('rib.canvasSize'),
              icon: 'frame',
              size: 'large',
              width: CANVAS_BTN_W,
              testid: CANVAS_SIZE_TESTID,
              onselect: () => input.onOpenCanvasSize(),
            },
          ],
        },
        /*
         * 「镜头」组：2.5D 视差。与画布分开 —— 画布改的是版式（尺寸 / 比例），
         * 镜头改的是**取景**（同一份版式被推近 / 摇过去）。混在一组里，
         * 用户会以为调镜头等于改画幅。
         */
        {
          id: 'camera',
          label: tr('rib.group.camera'),
          items: [
            {
              kind: 'button',
              id: 'camera',
              label: tr('rib.camera'),
              icon: 'camera',
              size: 'large',
              width: CAMERA_BTN_W,
              testid: CAMERA_TESTID,
              onselect: () => input.onOpenCamera(),
            },
          ],
        },
        {
          id: 'theme',
          label: tr('rib.group.theme'),
          items: [
            {
              kind: 'themes',
              id: 'theme-gallery',
              label: tr('rib.themeGallery'),
              testid: 'ribbon-themes',
              value: theme.id,
              options: allThemes.map((t) => ({
                id: t.id,
                // 内置方案走文案键；自定义方案是用户文本（TypographyTheme.name）
                label: t.name ?? tr(t.labelKey!),
                /*
                 * 缩略图的色带顺序与 Office 一致：深色 2 / 浅色 2 / 六个强调色。
                 * 不给「白色 + 黑色」两个端点 —— 所有内置方案的这两个槽都是纯白
                 * 纯黑，画进缩略图只会让 23 个方案看起来一模一样。
                 */
                colors: [
                  t.colors.dk2,
                  t.colors.lt2,
                  t.colors.accent1,
                  t.colors.accent2,
                  t.colors.accent3,
                  t.colors.accent4,
                  t.colors.accent5,
                  t.colors.accent6,
                ],
                // 自定义方案（Project.customThemes 里的）才可移除；内置方案只读。
                removable: input.customThemes.some((c) => c.id === t.id),
              })),
              onselect: (id) => a.setTheme(id),
              onremove: (id) => a.removeCustomTheme(id),
            },
            /*
             * 「应用到整个项目」：一次 commit 写所有文本片段 + 新片段默认
             * （`Project.typographyTheme`）。与图库的区别：图库改的是
             * **当前文档**（scope: 'clip'）。
             */
            {
              kind: 'button',
              id: 'theme-apply-project',
              label: tr('rib.themeApplyProject'),
              icon: 'layers',
              size: 'large',
              // 7 个字的标签在默认 50px 里会被截成「应用到整…」——显式要宽度。
              // 同一份 width 既进组宽预算又下发成按钮宽度（见 RibbonButton 的注释）。
              width: THEME_BTN_W,
              testid: 'ribbon-theme-apply-project',
              onselect: () => a.setTheme(theme.id, 'project'),
            },
            /*
             * 「编辑方案」：改当前方案的槽位色。当前是内置方案时，保存即复制成
             * 自定义方案（内置数据表只读）—— 这条分叉在弹窗内部处理。
             */
            {
              kind: 'button',
              id: 'theme-edit',
              label: tr('rib.themeEdit'),
              icon: 'paintbrush',
              size: 'large',
              width: THEME_BTN_W,
              testid: 'ribbon-theme-edit',
              onselect: () => input.onOpenThemeEditor(),
            },
          ],
        },
      ],
    },

    /* ------------------------------------------------------------ 插入 */
    {
      id: 'insert',
      label: tr('rib.insert'),
      order: 2,
      groups: [
        {
          id: 'shapes',
          label: tr('rib.group.shapes'),
          items: [
            {
              // 预览图面板而不是下拉：形状靠名字挑不出来，必须看见。
              // 缩略图用 `shapeGeometry` 生成，与舞台上渲染的是同一份几何。
              kind: 'gallery',
              id: 'shape-picker',
              label: tr('rib.shape'),
              testid: 'typo-shape',
              columns: 6,
              cards: shapeCards(),
              onselect: (key) => {
                const preset = SHAPE_PRESETS.find((p) => p.key === key);
                if (preset) a.addShape(preset);
              },
            },
            {
              /*
               * 与形状图库并排的一级入口：图库是「挑一个现成的形状」，这个是
               * 「让图形按参数长出来」。参数不在这条 Ribbon 上 —— 横向条带装
               * 不下十来个滑杆，全部住在右侧「元素属性」的生成器小节。
               */
              kind: 'button',
              id: 'add-generator',
              label: tr('rib.addGenerator'),
              icon: 'sparkles',
              testid: 'typo-insert-generator',
              onselect: () => input.onOpenGenPicker(),
            },
          ],
        },
        {
          // 「文本框」原先是塞在名为「图片」的组里的 —— 组名与内容对不上。
          // 拆出一个「文本」组；图片与图标各自成组，四个组名都与内容相符。
          id: 'text',
          label: tr('rib.group.text'),
          items: [
            {
              kind: 'button',
              id: 'add-text',
              label: tr('rib.addText'),
              icon: 'type',
              testid: 'typo-insert-text',
              onselect: () => a.addText(),
            },
          ],
        },
        {
          id: 'media',
          label: tr('rib.group.media'),
          items: [
            {
              kind: 'button',
              id: 'add-image',
              label: tr('rib.addImage'),
              icon: 'image-plus',
              testid: 'typo-add-image',
              onselect: () => a.addImage(),
            },
            {
              /*
               * 媒体池的开合，与 Rail 上那个图标是同一个状态。放这里是因为
               * 「从池子里拖一张图到画布上」是插入图片的另一条路 —— 用户找
               * 图片时会先看这个组，而不会想到去窄侧栏找。
               */
              kind: 'toggle',
              id: 'media-pool',
              label: tr('rib.mediaPool'),
              icon: 'images',
              active: input.mediaPoolOpen,
              testid: 'typo-media-pool',
              onchange: () => input.onToggleMediaPool(),
            },
          ],
        },
        {
          id: 'icons',
          label: tr('rib.group.icons'),
          items: [
            {
              // 图标是**矢量图形**，不是素材：选择器里挑完直接进文档（见
              // icon-shapes.ts）。此前它和图片挤在同一个组里，组名只说「图片」。
              kind: 'button',
              id: 'add-icon',
              label: tr('rib.addIcon'),
              icon: 'shapes',
              testid: 'typo-insert-icon',
              onselect: () => input.onOpenIconPicker(),
            },
          ],
        },
      ],
    },

    /* ------------------------------------------------------------ 动画 */
    {
      id: 'anim',
      label: tr('rib.anim'),
      order: 3,
      groups: [
        {
          /*
           * 动画刷：**最左侧**（用户指定）。与格式刷同一套交互（单击一次 /
           * 双击连续 / 再点一下或点空白取消），只是刷的内容换成动画条目。
           */
          id: 'anim-copy',
          label: tr('rib.group.animCopy'),
          items: [
            {
              kind: 'toggle',
              id: 'anim-painter',
              label: tr('rib.animPainter'),
              icon: 'paintbrush-vertical',
              testid: 'typo-anim-painter',
              active: input.painter === 'animation',
              disabled: !a.canPaint('animation'),
              onchange: () => a.togglePainter('animation', false),
              ondblclick: () => a.togglePainter('animation', true),
            },
          ],
        },
        {
          /*
           * 「动画」组 = **常驻的一条宽条**（PPT 同款），切到这个 Tab 就在。
           *
           * 与右边「高级动画」里的「添加动画」弹层并存：这条给「十四个预设一眼
           * 挑一个」，弹层给分组目录（预设将来变多时它才是可扩展的那一层）。
           * 两处都是「在播放头插一段」，可以连点往后接（`actions.applyPreset`）。
           */
          id: 'anim-strip',
          label: tr('rib.anim'),
          items: [
            {
              kind: 'animStrip',
              id: 'anim-inline',
              label: tr('rib.group.presets'),
              testid: 'typo-anim-strip',
              disabled: none,
              onselect: (id) => a.applyPreset(id as AnimPreset),
            },
          ],
        },
        {
          id: 'presets',
          label: tr('rib.group.advancedAnim'),
          items: [
            {
              /*
               * 图标图库，不是下拉：十四个动画按名字挑不出来（见
               * `ui/ribbon/RibbonAnimGallery.svelte` 的文件头）。点一下 = **在播放头
               * 位置插一段**，可以连点，前一段不丢（`actions.applyPreset`）。
               *
               * testid：入口沿用旧下拉的名字 `typo-anim-preset`，卡片是
               * `typo-anim-preset-card-<预设 id>`（与形状图库同一套后缀）。
               */
              kind: 'animGallery',
              id: 'anim-preset',
              label: tr('rib.addAnim'),
              testid: 'typo-anim-preset',
              disabled: none,
              onselect: (id) => a.applyPreset(id as AnimPreset),
            },
            {
              kind: 'button',
              id: 'clear-anim',
              label: tr('rib.clearAnim'),
              icon: 'rotate-cw',
              testid: 'typo-anim-clear',
              disabled: none,
              onselect: () => a.clearAnimations(),
            },
          ],
        },
        {
          id: 'anim-edit',
          label: tr('rib.group.edit'),
          items: [
            {
              kind: 'button',
              id: 'custom-css',
              label: tr('rib.customCss'),
              icon: 'wand-sparkles',
              testid: 'typo-anim-css',
              disabled: none,
              onselect: () => input.onOpenCustomCss(),
            },
            {
              kind: 'button',
              id: 'flatten',
              label: tr('rib.flatten'),
              icon: 'image',
              testid: 'typo-flatten',
              onselect: () => input.onFlatten(),
            },
          ],
        },
      ],
    },

    /* ------------------------------------------------------------ 视图 */
    {
      id: 'view',
      label: tr('rib.view'),
      order: 4,
      groups: [
        {
          id: 'grid',
          label: tr('rib.group.grid'),
          items: [
            {
              kind: 'toggle',
              id: 'grid-show',
              label: tr('rib.gridShow'),
              icon: 'grid-2x2',
              testid: 'ribbon-grid-show',
              active: input.grid.enabled,
              onchange: () => input.onGrid({ enabled: !input.grid.enabled }),
            },
            {
              kind: 'toggle',
              id: 'grid-snap',
              label: tr('rib.gridSnap'),
              icon: 'magnet',
              testid: 'ribbon-grid-snap',
              // 显示与吸附解耦：PPT 也是两个独立开关（可对齐网格但不显示它）。
              active: input.grid.snap,
              onchange: () => input.onGrid({ snap: !input.grid.snap }),
            },
            {
              kind: 'segment',
              id: 'grid-mode',
              label: tr('rib.gridUnit'),
              testid: 'ribbon-grid-mode',
              value: input.grid.mode,
              options: [
                { value: 'px', label: tr('rib.gridPx') },
                { value: 'percent', label: tr('rib.gridPercent') },
              ],
              onchange: (v) => input.onGrid({ mode: v === 'percent' ? 'percent' : 'px' }),
            },
            {
              kind: 'number',
              id: 'grid-size',
              label: tr('rib.gridSize'),
              testid: 'ribbon-grid-size',
              value: input.grid.size,
              min: input.grid.mode === 'percent' ? GRID_LIMITS.minPct : GRID_LIMITS.minPx,
              max: input.grid.mode === 'percent' ? GRID_LIMITS.maxPct : GRID_LIMITS.maxPx,
              step: input.grid.mode === 'percent' ? 1 : 4,
              precision: 0,
              suffix: input.grid.mode === 'percent' ? '%' : 'px',
              onchange: (v) => input.onGrid({ size: v }),
            },
          ],
        },
        {
          id: 'grid-lines',
          label: tr('rib.group.gridLines'),
          layout: 'grid',
          items: [
            {
              kind: 'toggle',
              id: 'grid-show-x',
              label: tr('rib.gridVertical'),
              size: 'small',
              icon: 'move-horizontal',
              testid: 'ribbon-grid-show-x',
              active: input.grid.showX,
              onchange: () => input.onGrid({ showX: !input.grid.showX }),
            },
            {
              kind: 'toggle',
              id: 'grid-show-y',
              label: tr('rib.gridHorizontal'),
              size: 'small',
              icon: 'arrow-up-down',
              testid: 'ribbon-grid-show-y',
              active: input.grid.showY,
              onchange: () => input.onGrid({ showY: !input.grid.showY }),
            },
            {
              kind: 'toggle',
              id: 'grid-frame',
              label: tr('rib.canvasFrame'),
              size: 'small',
              icon: 'frame',
              testid: 'ribbon-canvas-frame',
              active: input.grid.frame,
              onchange: () => input.onGrid({ frame: !input.grid.frame }),
            },
          ],
        },
      ],
    },

    /* ------------------------------------------- [Contextual] 图形格式 */
    {
      id: 'shape-format',
      label: tr('rib.shapeFormat'),
      contextual: true,
      order: 10,
      groups: [
        {
          id: 'fill',
          label: tr('rib.group.fill'),
          items: [
            {
              kind: 'select',
              id: 'fill-kind',
              label: tr('rib.fillKind'),
              testid: 'ribbon-fill-kind',
              width: 108,
              value: fillKind,
              disabled: !shape,
              optionTestidPrefix: 'ribbon-fill-kind-option',
              options: [
                { value: 'none', label: tr('rib.fillNoneShort') },
                { value: 'solid', label: tr('rib.fillSolid') },
                { value: 'linear', label: tr('rib.fillLinear') },
                { value: 'radial', label: tr('rib.fillRadial') },
                { value: 'texture', label: tr('rib.fillTexture') },
              ],
              onchange: (v) => a.setShapePaint({ kind: v as Paint['kind'] }),
            },
            /*
             * 只留「填充方式 + 主色」，两个控件**不随类型增删**。
             *
             * 这里原先按 fillKind 条件展开（不透明度 / 第二色 / 角度 / 图案 /
             * 周期 / 线宽），每切换一次填充方式，这一组的宽度就变一次 ——
             * 右侧所有组随之整体位移，用户瞄准的按钮会在点下去之前跑掉
             * （用户反馈的「改填充方式影响 Ribbon 排版」）。细节参数现在住在
             * 右侧的「元素属性」面板里，那里的版式固定、不随值变化。
             */
            {
              kind: 'color',
              id: 'shape-fill',
              label: fillKind === 'texture' ? tr('rib.textureInk') : fillKind === 'solid' ? tr('rib.shapeFill') : tr('rib.gradientFrom'),
              icon: 'paint-bucket',
              testid: 'ribbon-shape-fill',
              value: fillColorA,
              // 「无填充」时置灰但**保留占位** —— 组宽不随类型变化是这里的硬要求。
              disabled: !shape || fillKind === 'none',
              onchange: (v: string) => a.setShapePaint({ color: v }),
            },
          ],
        },
        {
          id: 'stroke',
          label: tr('rib.group.stroke'),
          items: [
            {
              kind: 'color',
              id: 'shape-stroke',
              label: tr('rib.strokeColor'),
              icon: 'square-dashed',
              testid: 'ribbon-shape-stroke',
              value: shape?.stroke?.color ?? '#ffffff',
              onchange: (v) => a.setShapeStroke(v),
            },
            {
              kind: 'number',
              id: 'stroke-width',
              label: tr('rib.strokeWidth'),
              testid: 'ribbon-stroke-width',
              value: shape?.stroke?.width ?? 0,
              min: 0,
              step: 1,
              suffix: 'px',
              onchange: (v) => a.setShapeStrokeWidth(v),
            },
            {
              kind: 'select',
              id: 'stroke-style',
              label: tr('rib.strokeStyle'),
              testid: 'ribbon-stroke-style',
              value: shape?.stroke?.style ?? 'solid',
              options: LINE_STYLES.map((s) => ({
                value: s,
                label: s === 'solid' ? tr('rib.lineSolid') : s === 'dashed' ? tr('rib.lineDashed') : tr('rib.lineDotted'),
              })),
              onchange: (v) => a.setShapeStrokeStyle(v as (typeof LINE_STYLES)[number]),
            },
          ],
        },
        {
          id: 'shape',
          label: tr('rib.group.shape'),
          items: [
            // 参数控件按**图形支持什么**显示（`shapeParamSupport`），不是写死一串。
            // 加一种图形只需要在 shapes.ts 里声明它支持哪些参数，这里一行都不用动。
            ...(support.radius
              ? [
                  {
                    kind: 'number' as const,
                    id: 'radius',
                    label: tr('rib.radius'),
                    testid: 'ribbon-shape-radius',
                    value: shape?.radius ?? 0,
                    min: 0,
                    step: 1,
                    onchange: (v: number) => a.setShapeRadius(v),
                  },
                ]
              : []),
            ...(support.sides
              ? [
                  {
                    kind: 'number' as const,
                    id: 'sides',
                    label: tr('rib.sides'),
                    testid: 'ribbon-shape-sides',
                    value: shape?.sides ?? (shape?.shape === 'star' ? 5 : 6),
                    min: 3,
                    max: 60,
                    step: 1,
                    onchange: (v: number) => a.setShapeParam('sides', Math.max(3, Math.round(v))),
                  },
                ]
              : []),
            ...(support.waist
              ? [
                  {
                    kind: 'number' as const,
                    id: 'waist',
                    label: tr('rib.starWaist'),
                    testid: 'ribbon-shape-waist',
                    value: shape?.waist ?? 0.4,
                    min: 0.05,
                    max: 0.98,
                    step: 0.02,
                    precision: 2,
                    onchange: (v: number) => a.setShapeParam('waist', v),
                  },
                ]
              : []),
            ...(support.inner
              ? [
                  {
                    kind: 'number' as const,
                    id: 'inner',
                    label: tr('rib.borderWidth'),
                    testid: 'ribbon-shape-inner',
                    value: shape?.inner ?? 0,
                    min: 0,
                    step: 1,
                    suffix: 'px',
                    onchange: (v: number) => a.setShapeParam('inner', Math.max(0, v)),
                  },
                ]
              : []),
            ...(support.angle
              ? [
                  {
                    kind: 'number' as const,
                    id: 'angle',
                    label: tr('rib.pieAngle'),
                    testid: 'ribbon-shape-angle',
                    value: shape?.angle ?? 270,
                    min: 1,
                    max: 360,
                    step: 5,
                    suffix: '°',
                    onchange: (v: number) => a.setShapeParam('angle', v),
                  },
                ]
              : []),
          ],
        },
        {
          id: 'nodes',
          label: tr('rib.group.nodes'),
          items: [
            {
              kind: 'toggle',
              id: 'node-edit',
              label: tr('rib.nodeEdit'),
              size: 'small',
              icon: 'spline',
              testid: 'typo-node-edit',
              active: input.nodeEditing,
              disabled: !shape,
              onchange: () => a.toggleNodeEdit(),
            },
            {
              kind: 'button',
              id: 'to-path',
              label: tr('rib.toPath'),
              size: 'small',
              icon: 'spline',
              testid: 'typo-to-path',
              // 参数化图形才能「转为路径」；已经是路径的（含布尔运算结果）
              // 再点一次没有任何意义 —— 置灰比「点了没反应」诚实。
              /*
               * **生成器元素例外**：它的 path 虽已烘焙，但「转为路径」的语义是
               * 「脱离生成器」（清掉 gen，参数不再覆盖手改的节点），必须可点。
               */
              disabled: !shape || (shape.shape === 'svg' && !shape.gen),
              onselect: () => a.convertToPath(),
            },
          ],
        },
        {
          id: 'boolean',
          label: tr('rib.group.boolean'),
          layout: 'grid',
          items: [
            {
              kind: 'button',
              id: 'bool-union',
              label: tr('rib.boolUnion'),
              size: 'small',
              icon: 'squares-unite',
              testid: 'typo-bool-union',
              disabled: !canBool,
              onselect: () => a.booleanShapes('union'),
            },
            {
              kind: 'button',
              id: 'bool-subtract',
              label: tr('rib.boolSubtract'),
              size: 'small',
              icon: 'squares-subtract',
              testid: 'typo-bool-subtract',
              disabled: !canBool,
              onselect: () => a.booleanShapes('difference'),
            },
            {
              kind: 'button',
              id: 'bool-intersect',
              label: tr('rib.boolIntersect'),
              size: 'small',
              icon: 'squares-intersect',
              testid: 'typo-bool-intersect',
              disabled: !canBool,
              onselect: () => a.booleanShapes('intersection'),
            },
            {
              kind: 'button',
              id: 'bool-xor',
              label: tr('rib.boolXor'),
              size: 'small',
              icon: 'squares-exclude',
              testid: 'typo-bool-xor',
              disabled: !canBool,
              onselect: () => a.booleanShapes('xor'),
            },
            {
              kind: 'button',
              id: 'bool-divide',
              label: tr('rib.boolDivide'),
              size: 'small',
              // 自绘：Lucide 没有「拆分」，见 `ui/icons/squares-divide.svelte`。
              icon: 'squares-divide',
              testid: 'typo-bool-divide',
              disabled: !canBool,
              onselect: () => a.divideShapes(),
            },
          ],
        },
        effectsGroup(shape?.blend ?? 'normal', shape?.opacity ?? 1, a),
      ],
    },

    /* ------------------------------------------- [Contextual] 组合格式 */
    {
      id: 'group-format',
      label: tr('rib.groupFormat'),
      contextual: true,
      order: 12,
      groups: [
        {
          id: 'group-box',
          label: tr('rib.group.groupBox'),
          items: [
            {
              kind: 'color',
              id: 'group-fill',
              label: tr('rib.groupBackdrop'),
              icon: 'square' as const,
              testid: 'ribbon-group-fill',
              value: groupFillColor,
              onchange: (v) => a.setGroupPaint({ color: v, kind: 'solid' }),
            },
            {
              kind: 'toggle',
              id: 'group-nofill',
              label: tr('rib.fillNoneShort'),
              icon: 'square-dashed',
              testid: 'ribbon-group-nofill',
              active: group?.fill.kind === 'none',
              onchange: () => a.setGroupPaint({ kind: group?.fill.kind === 'none' ? 'solid' : 'none' }),
            },
            {
              kind: 'color',
              id: 'group-border',
              label: tr('rib.groupBorder'),
              icon: 'frame' as const,
              testid: 'ribbon-group-border',
              value: group?.stroke?.color ?? '#ffffff',
              onchange: (v) => a.setGroupStrokeColor(v),
            },
            {
              kind: 'number',
              id: 'group-border-width',
              label: tr('rib.groupBorderWidth'),
              testid: 'ribbon-group-border-width',
              value: group?.stroke?.width ?? 0,
              min: 0,
              step: 1,
              suffix: 'px',
              onchange: (v) => a.setGroupStrokeWidth(v),
            },
            {
              kind: 'number',
              id: 'group-radius',
              label: tr('rib.groupRadius'),
              testid: 'ribbon-group-radius',
              value: group?.radius ?? 0,
              min: 0,
              step: 1,
              onchange: (v) => a.setGroupNumber('radius', v),
            },
            {
              kind: 'number',
              id: 'group-padding',
              label: tr('rib.groupPadding'),
              testid: 'ribbon-group-padding',
              value: group?.padding ?? 8,
              min: 0,
              step: 1,
              onchange: (v) => a.setGroupNumber('padding', v),
            },
          ],
        },
        {
          id: 'group-action',
          label: tr('rib.groupAction'),
          items: [
            {
              kind: 'button',
              id: 'ungroup',
              label: tr('rib.ungroup'),
              icon: 'ungroup',
              testid: 'typo-ungroup',
              onselect: () => a.ungroupSelection(),
            },
          ],
        },
      ],
    },

    /* ------------------------------------------- [Contextual] 图片格式 */
    {
      id: 'image-format',
      label: tr('rib.imageFormat'),
      contextual: true,
      order: 11,
      groups: [
        {
          /*
           * 版式纪律（见 ui/typography/AGENTS.md）：这一组的**控件个数与宽度
           * 恒定**。按状态条件展开的话，每勾一次「删除背景」整条 Ribbon 就会
           * 横向位移一次，用户瞄准的按钮在点下去之前跑掉 —— 填充组那次教训。
           * 不适用的控件置灰、**保留占位**。
           */
          id: 'image-style',
          label: tr('rib.group.imageStyle'),
          items: [
            {
              kind: 'select',
              id: 'image-fit',
              label: tr('rib.imageFit'),
              testid: 'ribbon-image-fit',
              width: 96,
              value: image?.fit ?? 'cover',
              options: [
                { value: 'fill', label: tr('rib.fitFill') },
                { value: 'contain', label: tr('rib.fitContain') },
                { value: 'cover', label: tr('rib.fitCover') },
                { value: 'none', label: tr('rib.fitNone') },
              ],
              onchange: (v) => a.setImageFit(v as ImageElement['fit']),
            },
            {
              kind: 'number',
              id: 'image-radius',
              label: tr('rib.imageRadius'),
              testid: 'ribbon-image-radius',
              value: image?.radius ?? 0,
              min: 0,
              step: 1,
              suffix: 'px',
              onchange: (v) => a.setImageRadius(v),
            },
            {
              kind: 'color',
              id: 'image-border-color',
              label: tr('rib.imageBorderColor'),
              icon: 'frame',
              testid: 'ribbon-image-border-color',
              value: image?.border?.color ?? '#ffffff',
              /*
               * 改颜色时若还没有边框宽度，顺手给 4px：只选颜色却什么都不发生
               * 是这类控件的经典坑（「点了没反应」）。
               */
              onchange: (v) =>
                a.patchImageBorder({ color: v, width: image?.border?.width || 4 }),
            },
            {
              kind: 'number',
              id: 'image-border-width',
              label: tr('rib.imageBorderWidth'),
              testid: 'ribbon-image-border-width',
              value: image?.border?.width ?? 0,
              min: 0,
              max: 200,
              step: 1,
              suffix: 'px',
              onchange: (v) => a.patchImageBorder({ width: v }),
            },
          ],
        },
        {
          id: 'image-bg',
          label: tr('rib.group.imageBg'),
          items: [
            {
              kind: 'toggle',
              id: 'image-key',
              label: tr('rib.imageKey'),
              size: 'large',
              icon: 'eraser',
              testid: 'ribbon-image-key',
              active: !!image?.key,
              onchange: (on) => a.setImageKey(on),
            },
            {
              kind: 'color',
              id: 'image-key-color',
              label: tr('rib.imageKeyColor'),
              icon: 'pipette',
              testid: 'ribbon-image-key-color',
              value: image?.key?.color ?? '#00ff00',
              // 没开抠图时置灰但保留占位（组宽不随状态变化）。
              disabled: !image?.key,
              /*
               * 取色卡里选中主题色时拿到的是 `@accent1` 这样的**引用**；而抠图
               * 颜色要参与逐像素计算，`coerceKeySettings` 只收 `#hex` —— 必须在
               * 这里就地解析，否则「选了主题色、什么都不发生」（静默丢弃）。
               */
              onchange: (v) => a.patchImageKey({ color: resolveThemeColor(v, theme) }),
            },
          ],
        },
        {
          id: 'image-quad',
          label: tr('rib.group.imageQuad'),
          items: [
            {
              kind: 'toggle',
              id: 'image-quad',
              label: tr('rib.imageQuad'),
              size: 'large',
              icon: 'square-dashed',
              testid: 'ribbon-image-quad',
              // 「四角调整」是一个**模式**：开着才在画布上画四个角手柄。
              active: input.quadEditing,
              onchange: (on) => input.onImageQuad(on),
            },
            {
              kind: 'button',
              id: 'image-quad-reset',
              label: tr('rib.imageQuadReset'),
              size: 'small',
              icon: 'rotate-ccw',
              testid: 'ribbon-image-quad-reset',
              disabled: !image?.quad,
              onselect: () => a.resetImageQuad(),
            },
          ],
        },
        {
          id: 'image-adjust',
          label: tr('rib.group.imageAdjust'),
          items: [
            {
              // 「是否开着」要靠 `active` 表达 ⇒ 用 toggle（button 没有激活态）。
              // 点击时忽略传进来的布尔值：编辑器那侧是**开合**语义（再点一次关掉）。
              kind: 'toggle',
              id: 'image-adjust',
              label: tr('rib.imageAdjust'),
              icon: 'sliders-horizontal',
              testid: IMAGE_TOOL_TESTIDS.adjust,
              active: input.imageTool === 'adjust',
              onchange: () => input.onOpenImageTool('adjust'),
            },
            {
              kind: 'toggle',
              id: 'image-recolor',
              label: tr('rib.imageRecolor'),
              icon: 'palette',
              testid: IMAGE_TOOL_TESTIDS.recolor,
              active: input.imageTool === 'recolor',
              onchange: () => input.onOpenImageTool('recolor'),
            },
            {
              kind: 'toggle',
              id: 'image-filter',
              label: tr('rib.imageFilter'),
              icon: 'wand-sparkles',
              testid: IMAGE_TOOL_TESTIDS.filter,
              active: input.imageTool === 'filter',
              onchange: () => input.onOpenImageTool('filter'),
            },
          ],
        },
        {
          id: 'image-crop',
          label: tr('rib.group.imageCrop'),
          items: [
            {
              // 纵横比是**一次性预设**，不显示当前值 ⇒ 用 menu 而不是 select：
              // 下拉的触发区要放得下「16:9」这种读数，宽度会被迫变化。
              kind: 'menu',
              id: 'image-crop',
              label: tr('rib.imageCrop'),
              icon: 'crop',
              testid: 'ribbon-image-crop',
              items: [
                ...CROP_ASPECTS.map((p) => ({
                  id: `crop-${p.id}`,
                  label: tr(p.labelKey),
                  active: false,
                  onselect: () => a.setImageCropAspect(p.ratio),
                })),
                {
                  id: 'crop-reset',
                  label: tr('rib.cropReset'),
                  icon: 'rotate-ccw' as const,
                  onselect: () => a.setImageCrop(null),
                },
              ],
            },
            {
              kind: 'toggle',
              id: 'image-size',
              label: tr('rib.imageSize'),
              icon: 'maximize',
              testid: IMAGE_TOOL_TESTIDS.size,
              active: input.imageTool === 'size',
              onchange: () => input.onOpenImageTool('size'),
            },
            {
              /*
               * 裁剪为形状：图库而不是下拉 —— 形状靠名字挑不出来（与「插入形状」
               * 同一条理由）。`line` 被排除：没有面积，裁过去等于把图删掉。
               */
              kind: 'gallery',
              id: 'image-clip-shape',
              label: tr('rib.imageClipShape'),
              testid: 'ribbon-image-clip-shape',
              columns: 5,
              cards: shapeCards().filter((c) => c.id !== 'line'),
              onselect: (key) => a.clipImagesToShape(key),
            },
          ],
        },
        {
          id: 'image-align',
          label: tr('rib.group.imageAlign'),
          items: [
            {
              kind: 'menu',
              id: 'image-align',
              label: tr('rib.imageAlignCanvas'),
              icon: 'move',
              testid: 'ribbon-image-align',
              items: [
                { id: 'align-center', label: tr('rib.imgAlignCenter'), onselect: () => a.alignImagesToCanvas('center') },
                { id: 'align-center-h', label: tr('rib.imgAlignCenterH'), onselect: () => a.alignImagesToCanvas('center-h') },
                { id: 'align-center-v', label: tr('rib.imgAlignCenterV'), onselect: () => a.alignImagesToCanvas('center-v') },
                { id: 'align-fit', label: tr('rib.imgAlignFit'), onselect: () => a.alignImagesToCanvas('fit') },
                { id: 'align-fill', label: tr('rib.imgAlignFill'), onselect: () => a.alignImagesToCanvas('fill') },
                { id: 'align-stretch', label: tr('rib.imgAlignStretch'), onselect: () => a.alignImagesToCanvas('stretch') },
              ],
            },
          ],
        },
        effectsGroup(image?.blend ?? 'normal', image?.opacity ?? 1, a),
      ],
    },
  ];

  return injectThemeId(tabs, theme.id);
}

/**
 * 给所有颜色控件补上当前配色方案 id —— **唯一的注入点**。
 *
 * 为什么不在每个 `kind: 'color'` 项上各写一遍：漏掉一处的表现是
 * 「取色卡里画的是**默认**方案的色格，而选出来的颜色按**当前**方案解析」
 * —— 只在切换过配色方案之后才看得出来，而且不报任何错
 * （用户报的正是这个：图形格式 → 填充的取色卡不跟着刷新）。
 * 收口到这里之后，「新增颜色控件忘了带主题」从不可能发生。
 */
function injectThemeId(tabs: RibbonTabDef[], themeId: string): RibbonTabDef[] {
  const fix = (item: RibbonItemSpec): RibbonItemSpec =>
    item.kind === 'color' && item.themeId === undefined ? { ...item, themeId } : item;
  return tabs.map((tab) => ({
    ...tab,
    groups: tab.groups.map((g) => ({
      ...g,
      items: g.items.map(fix),
      rows: g.rows?.map((row) => row.map(fix)),
    })),
  }));
}

/** 「艺术效果」组：混合模式 + 不透明度。图形格式与图片格式共用。 */
function effectsGroup(blend: MixBlend, opacity: number, a: TypographyActions) {
  return {
    id: 'effects',
    label: tr('rib.group.effects'),
    items: [
      {
        kind: 'select' as const,
        id: 'blend',
        label: tr('rib.blend'),
        testid: 'ribbon-blend',
        value: blend,
        options: MIX_BLENDS.map((m) => ({ value: m.id, label: tr(m.labelKey) })),
        onchange: (v: string) => a.setBlend(v as MixBlend),
      },
      {
        kind: 'number' as const,
        id: 'opacity',
        label: tr('rib.opacity'),
        testid: 'ribbon-opacity',
        value: opacity,
        min: 0,
        max: 1,
        step: 0.05,
        precision: 2,
        onchange: (v: number) => a.setOpacity(v),
      },
    ],
  };
}
