/**
 * tokens.ts — Design Token 单一真源（纯数据 + 纯函数，**不碰 DOM**）。
 *
 * 为什么要有一个 TS 文件当唯一真源，而不是只在 app.css 里写 :root：
 *   时间轴是 Canvas2D 自绘，`ctx.fillStyle` 写不了 `var(--x)`。改版前
 *   grid-draw.ts 因此在 TS 里完整重抄了一份调色板（9 个字面量与 CSS 变量
 *   同值一一对应）——改一次配色要改两处，改漏就是「面板变了、网格没变」
 *   这种极难定位的偏色。现在两份都从这一个文件来，物理上不可能不同步。
 *
 * 分层（每条只允许引用它下面那一层）：
 *
 *   primitive  `--p-*`        只描述值（neutral-900 / violet-500），不含意图
 *   semantic   `--surface-*`  描述用途（surface-raised / text-danger），不含颜色词
 *   component  `--btn-*`      某个 UI 元素的具体绑定，值必须是某个 semantic
 *   content    `--clip-*`     数据的类别色（画面/特效/音频片段），**永不随品牌变**
 *
 * 最后一层是为解一个具体问题：片段类型色编码的是「这是哪类数据」，不是
 * 「界面上的什么角色」。若把它挂进品牌组，用户换主题色时特效片段的样貌会
 * 跟着变，破坏对内容的心智映射。所以它随亮暗变（保对比度）但永不随品牌变。
 *
 * 另有一条边界：生成器默认色（`#3a6ea5`、mandelbrot 的 colorA/B 之类）**不是
 * token**，那是 Project 文档内容（schema 字段）。Inspector 里颜色控件的外观走
 * component 层，控件的**值**走内容。这条守住，将来换主题才不会连带改掉用户
 * 工程里没动过的画面。
 */

/* ------------------------------------------------------------ 类型 */

/** 只借类型，不引运行时 —— tokens 保持「纯数据 + 纯函数」的定位。 */
import type { MessageKey } from '../i18n/locales';
import { hexToRgb, rgbToHex } from '../core/color';

/**
 * 外观模式。四套：
 *   light     亮底
 *   dark      近黑底
 *   gray      中灰面板（#525252）+ 浅灰纸面弹窗（#BDBDBD）——长时间工作的护眼档
 *   contrast  纯黑纯白 + 彩色边框——只为「一眼可辨」
 *
 * **只有实现差异，没有层级差异**：四套都走同一套 semantic 键，组件不感知模式。
 */
export type ThemeMode = 'light' | 'dark' | 'gray' | 'contrast';

/** 设置面板里的排列顺序（也是「从常规到极端」的顺序）。 */
export const THEME_MODES = ['light', 'dark', 'gray', 'contrast'] as const;

/**
 * 亮 / 暗「族」。
 *
 * 四套模式里只有 light 是亮底：gray 的面板是 #525252、contrast 是纯黑，都属于暗底。
 * 凡是「亮底还是暗底」的二元判断（logo 墨色取哪份资源、Canvas 网格用哪档透明度、
 * 原生 `color-scheme`、强调查色的钳制方向）**一律读它**，不要写 `mode === 'light'`
 * —— 那种写法每加一套模式就要改一遍，而改漏的地方不会报错（只会看起来「有点不对」）。
 */
export type ThemeFamily = 'light' | 'dark';

export function themeFamily(mode: ThemeMode): ThemeFamily {
  return mode === 'light' ? 'light' : 'dark';
}

/** 预置品牌色相。注意这是「色相」不是「某个 hex」——亮暗两套取不同明度步进。 */
export type BrandId = 'violet' | 'cyan' | 'lime' | 'amber';

/** 品牌来源：预置 id，或用户给的任意 hex。 */
export type AccentSource = { kind: 'preset'; id: BrandId } | { kind: 'custom'; hex: string };

export interface ThemeSpec {
  mode: ThemeMode;
  accent: AccentSource;
}

/** 主题色的一条完整色阶。5 个值足够覆盖「选中底 / 主色 / 描边 / 按下 / 反差文字」。 */
export interface AccentRamp {
  accent: string;
  accentStrong: string;
  accentWeak: string;
  accentBorder: string;
  accentOn: string;
}

/** semantic 的键。component 层的值类型就是它——写错层直接编译报错。 */
export type SemanticKey =
  | 'surface-0'
  | 'surface-1'
  | 'surface-2'
  | 'surface-3'
  | 'surface-hover'
  | 'surface-active'
  | 'border'
  | 'border-strong'
  /*
   * 可点容器（按钮 / 输入框 / 下拉 / 数字框 / 复选框）的边框。
   *
   * 亮暗灰三套里它与 `border` 同值 —— 分层只靠 surface 深度，按钮不该多一道重色边。
   * 高对比度里它是**唯一的分类手段**：结构分隔线用白、可点容器用青，一眼能分出
   * 「这是能点的」与「这只是隔开两块区域」。
   */
  | 'border-control'
  /** 纯图标按钮的边框。三套常规模式是 `transparent`（图标按钮永远无框无底）。 */
  | 'border-icon'
  | 'border-focus'
  | 'text-primary'
  | 'text-secondary'
  | 'text-muted'
  | 'text-disabled'
  | 'accent'
  | 'accent-strong'
  | 'accent-weak'
  | 'accent-border'
  | 'accent-on'
  | 'danger'
  | 'danger-weak'
  | 'success'
  | 'warning'
  | 'overlay'
  | 'scrollbar'
  | 'scrollbar-hover';

/** 数据类别色（片段 / 波形）。随 mode 变，不随品牌变。 */
export type ContentKey =
  | 'clip-source-bg'
  | 'clip-source-border'
  | 'clip-source-text'
  | 'clip-effect-bg'
  | 'clip-effect-border'
  | 'clip-effect-text'
  | 'clip-audio-bg'
  | 'clip-audio-border'
  | 'clip-audio-text';

/* ------------------------------------------------------------ 密度常量
 *
 * 数值在这里，CSS 字符串也在（由数值生成）。时间轴的 Canvas 数学
 * （行高、标尺高）直接 import 这里的数，不许各写一份。
 */

export const DENSITY = {
  /** 轨道行高。40 → 28 是 Terminal-Native 的密度取向：同屏多出 40% 的轨道。 */
  rowH: 28,
  rulerH: 24,
  controlH: 22,
  topbarH: 30,
  statusbarH: 22,
  railW: 44,
  tlSideW: 160,
  drawerW: 300,
  drawerMinW: 240,
  drawerMaxW: 520,
  /*
   * 媒体池（左侧抽屉）。比检查器窄一档：那边是一列参数表单，这边是
   * 「缩略图 + 名字 + 一行元信息」，再宽只会让名字后面多出一片空白。
   */
  poolW: 232,
  poolMinW: 184,
  poolMaxW: 420,

  /* 排版编辑器的 Ribbon。数值与 CSS 都从这里来（见 STATIC 的派生）。 */
  /** Tab 条高。 */
  ribbonTabH: 26,
  /** 面板高（分组按钮区，含底部 6px 的细横向滚动条）。总高 = 26 + 88 = 114。 */
  ribbonBodyH: 88,
  /** large 按钮（icon 在上、文字在下）。 */
  ribbonBtnW: 50,
  ribbonBtnH: 56,
  /** small 按钮：只放得下一个图标加短文字的紧凑项。 */
  ribbonBtnSmallW: 32,
  /** 纯图标按钮（字体区第二排的 B / I / U / S 那种，宽高比接近正方形）。 */
  ribbonIconW: 26,
  /** 图标按钮高。与 --control-h 无关：它是按钮而不是输入框。 */
  ribbonIconH: 24,
} as const;

/* ------------------------------------------------------------ primitive */

/** 近零饱和度的冷中性灰。刻意不做成纯灰（#808080 系）——极小的蓝偏在
 *  深色表面上比纯灰更「干净」，这是终端主题的常见处理。 */
const NEUTRAL = {
  '0': '#ffffff',
  '50': '#f8f9fa',
  '100': '#eff1f3',
  '150': '#e5e7ea',
  '200': '#d9dcdf',
  '300': '#c3c7cb',
  '400': '#9ba0a6',
  '500': '#787d84',
  '600': '#5b6067',
  '700': '#43474e',
  '800': '#2d3136',
  '850': '#24272c',
  '900': '#1b1e22',
  '950': '#131518',
  '1000': '#0c0e10',
} as const;

export const PRIMITIVES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(NEUTRAL).map(([k, v]) => [`neutral-${k}`, v])),
  'red-400': '#ef5f63',
  'red-500': '#e5484d',
  'green-400': '#46b07c',
  'green-500': '#30a46c',
  'amber-500': '#d99a1f',
};

/** 预置品牌的锚点 hex（= 该品牌 500 步）。亮暗模式各自派生到合适的明度，
 *  所以「品牌紫是 #6F64EF」不等于「亮色下 accent 就是 #6F64EF」——亮色下
 *  它会落到更暗的一档以满足对比度。这是设计系统的常规做法，不是笔误。 */
/** 品牌名的展示文案走 i18n（`labelKey`），理由见 effects/types.ts 的注释。 */
export const ACCENT_PRESETS: Record<BrandId, { labelKey: MessageKey; hex: string }> = {
  violet: { labelKey: 'app.accentViolet', hex: '#6f64ef' },
  cyan: { labelKey: 'app.accentCyan', hex: '#2b9fd8' },
  lime: { labelKey: 'app.accentLime', hex: '#6ba03a' },
  amber: { labelKey: 'app.accentAmber', hex: '#d99a1f' },
};

export const BRAND_IDS = Object.keys(ACCENT_PRESETS) as BrandId[];

/* ------------------------------------------------------------ semantic
 *
 * 结构色与品牌无关，只有 accent 组随品牌走。所以这里先给「非 accent 部分」，
 *  accent 组由 accentRampOf() 填。
 */

export const SEMANTIC: Record<ThemeMode, Record<SemanticKey, string>> = {
  light: {
    'surface-0': NEUTRAL['0'], // body / 时间轴底
    'surface-1': NEUTRAL['50'], // 顶栏 / 底栏 / 侧栏 / 抽屉
    'surface-2': NEUTRAL['100'], // 工具条 / 轨道侧栏
    'surface-3': NEUTRAL['0'], // 菜单 / 气泡 / 输入框
    'surface-hover': NEUTRAL['150'],
    'surface-active': NEUTRAL['200'],
    border: NEUTRAL['200'],
    'border-strong': NEUTRAL['300'],
    'border-control': NEUTRAL['200'],
    'border-icon': 'transparent',
    'border-focus': '#000000', // 被 accent 覆盖
    'text-primary': NEUTRAL['1000'],
    'text-secondary': NEUTRAL['600'],
    'text-muted': NEUTRAL['500'],
    'text-disabled': NEUTRAL['400'],
    'accent': '#000000',
    'accent-strong': '#000000',
    'accent-weak': '#000000',
    'accent-border': '#000000',
    'accent-on': '#ffffff',
    danger: PRIMITIVES['red-500']!,
    'danger-weak': '#fbeaea',
    success: PRIMITIVES['green-500']!,
    warning: PRIMITIVES['amber-500']!,
    overlay: 'rgba(0, 0, 0, 0.30)',
    scrollbar: NEUTRAL['300'],
    'scrollbar-hover': NEUTRAL['400'],
  },
  dark: {
    'surface-0': NEUTRAL['1000'],
    'surface-1': NEUTRAL['950'],
    'surface-2': NEUTRAL['900'],
    'surface-3': NEUTRAL['850'],
    'surface-hover': NEUTRAL['800'],
    'surface-active': NEUTRAL['700'],
    border: NEUTRAL['800'],
    'border-strong': NEUTRAL['700'],
    'border-control': NEUTRAL['800'],
    'border-icon': 'transparent',
    'border-focus': '#ffffff',
    'text-primary': NEUTRAL['100'],
    'text-secondary': NEUTRAL['400'],
    'text-muted': NEUTRAL['500'],
    'text-disabled': NEUTRAL['600'],
    'accent': '#000000',
    'accent-strong': '#000000',
    'accent-weak': '#000000',
    'accent-border': '#000000',
    'accent-on': '#ffffff',
    danger: PRIMITIVES['red-400']!,
    'danger-weak': '#3a2226',
    success: PRIMITIVES['green-400']!,
    warning: PRIMITIVES['amber-500']!,
    overlay: 'rgba(0, 0, 0, 0.50)',
    scrollbar: NEUTRAL['700'],
    'scrollbar-hover': NEUTRAL['600'],
  },

  /*
   * 灰色模式。
   *
   * 面板底色 #525252：比近黑「亮」一档，绝对对比度更低（白字对它 7.9:1，对
   * 暗色 surface-1 是 16:1），但可识别度仍然良好 —— 这正是 Office / Unity /
   * Blender 那些「一坐一整天」的软件都在提供的一档。对全是故障特效的剪辑软件
   * 更甚：画面本身已经高频闪烁，界面再压到近黑，眼睛没有休息的地方。
   *
   * 注意这里**只描述「深色chrome」**：弹窗 / 菜单 / Ribbon 是浅灰纸面（#BDBDBD
   * + 黑字），见下面的 PAPER —— 纸面不是一个 surface 档位，而是一整块反相上下文，
   * 单靠 surface-0..3 的深度表达不了「容器整体反相」。
   */
  gray: {
    'surface-0': '#464646', // body / 时间轴底（比面板深一档，让轨道区「沉」下去）
    'surface-1': '#525252', // 面板正色：顶栏 / 底栏 / 侧栏 / 抽屉
    'surface-2': '#5b5b5b', // 工具条 / 轨道侧栏
    'surface-3': '#616161', // 深色面板里的输入框
    'surface-hover': '#6b6b6b',
    'surface-active': '#7a7a7a',
    border: '#6f6f6f',
    'border-strong': '#8f8f8f',
    'border-control': '#6f6f6f',
    'border-icon': 'transparent',
    'border-focus': '#ffffff',
    'text-primary': '#ffffff',
    'text-secondary': '#dedede',
    'text-muted': '#c2c2c2',
    'text-disabled': '#9a9a9a',
    'accent': '#000000',
    'accent-strong': '#000000',
    'accent-weak': '#000000',
    'accent-border': '#000000',
    'accent-on': '#000000',
    danger: '#ff9d9d',
    'danger-weak': '#5a2c2c',
    success: '#7ee0a8',
    warning: '#ffd166',
    overlay: 'rgba(0, 0, 0, 0.42)',
    scrollbar: '#7d7d7d',
    'scrollbar-hover': '#969696',
  },

  /*
   * 高对比度模式。
   *
   * 只有 #000000 + #FFFFFF，**唯一的例外是 hover / active 的填充与彩色边框**：
   *   - hover 若也停在纯黑，「这里能点」就完全没有反馈（比低对比度更糟）；
   *   - 边框承担全部分类：结构线白、可点容器青（--border-control）。
   * 文字三档全按 4.5:1 以上给（次级也是纯白，层级只靠字号与字重）。
   */
  contrast: {
    'surface-0': '#000000',
    'surface-1': '#000000',
    'surface-2': '#000000',
    'surface-3': '#000000',
    'surface-hover': '#1c1c1c',
    'surface-active': '#303030',
    border: '#ffffff',
    'border-strong': '#ffffff',
    'border-control': '#00e5ff',
    'border-icon': '#00e5ff',
    'border-focus': '#ffffff',
    'text-primary': '#ffffff',
    'text-secondary': '#ffffff',
    'text-muted': '#d0d0d0',
    'text-disabled': '#8c8c8c',
    'accent': '#000000',
    'accent-strong': '#000000',
    'accent-weak': '#000000',
    'accent-border': '#000000',
    'accent-on': '#000000',
    danger: '#ff5c5c',
    'danger-weak': '#2a0000',
    success: '#33ff88',
    warning: '#ffd400',
    overlay: 'rgba(0, 0, 0, 0.78)',
    scrollbar: '#ffffff',
    'scrollbar-hover': '#00e5ff',
  },
};

/* ------------------------------------------------------------ content
 *
 * 片段类别色。极低彩度：要让三种片段在时间轴上可区分，但不跟主题色抢，
 *  也不违反「中性灰为主」的取向。
 */

export const CONTENT: Record<ThemeMode, Record<ContentKey, string>> = {
  light: {
    'clip-source-bg': '#e8ebef',
    'clip-source-border': '#b4bbc5',
    'clip-source-text': '#2b3037',
    'clip-effect-bg': '#ebe8f3',
    'clip-effect-border': '#b0a8d2',
    'clip-effect-text': '#332c4a',
    /*
     * 音频片段的底色**必须是半透明**：波形是画在 canvas.grid 上的，而那张画布
     * 在片段 DOM 的**下面**（见 grid-draw.ts 的注释）。填充不透明的话波形就被
     * 整个盖住，看起来像一段纯色块——只有片段本身变半透明时才「忽然」露出来
     * （拖动被拒时的 0.7 透明度、轨道静音时的 0.5），这正是用户报的那个现象。
     * 视频/特效片段底下的画布没有内容，保持不透明即可。
     */
    'clip-audio-bg': 'rgba(228, 238, 233, 0.42)',
    'clip-audio-border': '#a3c1b1',
    'clip-audio-text': '#25402f',
  },
  dark: {
    'clip-source-bg': '#272c34',
    'clip-source-border': '#4b535f',
    'clip-source-text': '#d8dde4',
    'clip-effect-bg': '#2b2736',
    'clip-effect-border': '#5d5480',
    'clip-effect-text': '#ded7f5',
    'clip-audio-bg': 'rgba(35, 48, 41, 0.42)',
    'clip-audio-border': '#3f6455',
    'clip-audio-text': '#cfe6da',
  },
  /* 灰色模式：片段底色要压在中灰网格（#464646）上，所以比暗色那套亮一档、
     彩度更低。仍然是「三种片段能分开、但不跟主题色抢」。 */
  gray: {
    'clip-source-bg': '#5d5d5d',
    'clip-source-border': '#8f8f8f',
    'clip-source-text': '#f4f4f4',
    'clip-effect-bg': '#615b6b',
    'clip-effect-border': '#918aa6',
    'clip-effect-text': '#f0ecfa',
    'clip-audio-bg': 'rgba(92, 112, 100, 0.42)',
    'clip-audio-border': '#93ab9e',
    'clip-audio-text': '#e6f2ea',
  },
  /* 高对比度：底一律纯黑，**分类只靠边框色**（与界面同一条思路）。 */
  contrast: {
    'clip-source-bg': '#000000',
    'clip-source-border': '#00e5ff',
    'clip-source-text': '#d9fbff',
    'clip-effect-bg': '#000000',
    'clip-effect-border': '#ff70e0',
    'clip-effect-text': '#ffe4fa',
    'clip-audio-bg': 'rgba(0, 70, 40, 0.45)',
    'clip-audio-border': '#5cff9d',
    'clip-audio-text': '#d9ffe8',
  },
};

/* ------------------------------------------------------------ 纸面（paper）
 *
 * 弹窗 / 菜单 / 下拉 / Ribbon 这一层在灰色模式下是**浅灰底 + 黑字**（#BDBDBD），
 * 而面板是深灰 + 白字 —— 这不是某个 surface 档位的差别，是整块上下文反相。
 *
 * 用一套 `--paper-*` 承接：容器挂 `data-paper`，`theme-apply.ts` 注入的
 * `[data-paper]` 规则把 semantic / component 变量全部指向 `--paper-*`。
 * 于是**组件内部一行都不用改** —— 它们仍然写 `var(--text-primary)`。
 *
 * 亮 / 暗 / 高对比度三套的纸面就是它们自己的语义表（反相后与外面一致），
 * 只有灰色模式真的换了另一套值。这条对称性很重要：它保证「加模式」不会
 * 让某个容器莫名其妙变成另一种配色。
 */
export const PAPER: Record<ThemeMode, Record<SemanticKey, string>> = {
  light: SEMANTIC.light,
  dark: SEMANTIC.dark,
  contrast: SEMANTIC.contrast,
  gray: {
    'surface-0': '#b0b0b0', // 纸面内的凹槽（列表斑马纹 / 画布外的衬底）
    'surface-1': '#bdbdbd', // 纸面本体：弹窗 / Ribbon / 菜单
    'surface-2': '#cccccc', // 纸面上的控件底（按钮）
    'surface-3': '#ffffff', // 纸面上的输入框、再上一层的浮层
    'surface-hover': '#aeaeae',
    'surface-active': '#a0a0a0',
    border: '#8a8a8a',
    'border-strong': '#6b6b6b',
    'border-control': '#8a8a8a',
    'border-icon': 'transparent',
    'border-focus': '#000000',
    'text-primary': '#141414',
    'text-secondary': '#333333',
    'text-muted': '#4d4d4d',
    'text-disabled': '#767676',
    'accent': '#000000',
    'accent-strong': '#000000',
    'accent-weak': '#000000',
    'accent-border': '#000000',
    'accent-on': '#ffffff',
    danger: '#b3261e',
    'danger-weak': '#f2c6c2',
    success: '#1b6b3d',
    warning: '#7a5a00',
    overlay: 'rgba(0, 0, 0, 0.30)',
    scrollbar: '#8a8a8a',
    'scrollbar-hover': '#6b6b6b',
  },
};

/* ------------------------------------------------------------ 字体
 *
 * 界面字体栈的**唯一真源**。三处读者：`app.css` 的 `html, body`、
 * 组件里的 `var(--font-mono)`、以及 Canvas2D 的 `ctx.font`（写不了 var()，
 * 所以必须从这里取字符串，不许在别的文件里再抄一份族名）。
 *
 * 分工：`FONT_UI` 是界面字体（Sarasa Gothic SC 的汉字 + 比例西文，Inter 血统），
 * `FONT_MONO` 才是等宽（JetBrains Mono → 时间码 / 参数 / id / 代码 / 标尺刻度）。
 * 两套都随包分发（`public/fonts/`，OFL-1.1，版权行见同目录的 OFL 文本），
 * `@font-face` 写在 `app.css`；**改栈只改这里**，CSS 那边只是 var() 引用。
 *
 * ⚠️ 族名是**别名**（`Artmatic UI` / `Artmatic Mono`），不是字体真名。
 * 这两套字用户本机可能也装着，而排版文档存的就是族名；用真名声明 @font-face 会让
 * 界面那份盖过本机字体，snapDOM 于是把 13 MB 的 CJK 字体内联进**每次捕获**
 * （20 ms → 514 ms/帧）。别把别名改回真名，理由写在 `app.css` 那段注释里。
 *
 * 也别把 `FONT_UI` 换成等宽那套：JetBrains 的汉字是 0、西文定宽 0.6em，
 * 整个界面会变成一份终端，中英混排的字宽也对不齐。
 */
export const FONT_UI = "'Artmatic UI', system-ui, sans-serif";

/**
 * 等宽语义：数字列 / id / 代码 / 标尺刻度。
 *
 * `Artmatic Mono` 只有 latin 子集（定宽 0.6em），汉字逐字回落界面那套
 * —— 那套字本身就是全角等宽，所以中英混排的列仍然对得上。
 */
export const FONT_MONO = "'Artmatic Mono', 'Artmatic UI', system-ui, sans-serif";

/* ------------------------------------------------------------ static
 *
 * 与 mode 和品牌都无关。**层次感只靠 surface-0→3 的纯色深度 + 1px 实线边框**，
 * 这是本项目的视觉纪律。唯一的例外是 `shadow-float`：根级浮动面板（曲线编辑器）
 * 没有自己的布局槽位，纯靠边框与背景色分不开，需要一层阴影把它「托」起来。
 * 不要把它用在普通面板 / 卡片上。
 */

export const STATIC: Record<string, string> = {
  'radius-sm': '4px',
  'radius-md': '6px',
  'shadow-float': '0 12px 32px rgba(0, 0, 0, 0.28), 0 3px 10px rgba(0, 0, 0, 0.16)',

  'fs-xs': '10px',
  'fs-sm': '11px',
  'fs-md': '12px',
  'icon-sm': '13px',
  'icon-md': '15px',

  'font-ui': FONT_UI,
  'font-mono': FONT_MONO,

  'row-h': `${DENSITY.rowH}px`,
  'ruler-h': `${DENSITY.rulerH}px`,
  'control-h': `${DENSITY.controlH}px`,
  'topbar-h': `${DENSITY.topbarH}px`,
  'statusbar-h': `${DENSITY.statusbarH}px`,
  'rail-w': `${DENSITY.railW}px`,
  'tl-side-w': `${DENSITY.tlSideW}px`,

  /* Ribbon。注意**没有 --ribbon-w**：宽度随容器，是实例值，不进 token。 */
  'ribbon-tab-h': `${DENSITY.ribbonTabH}px`,
  'ribbon-body-h': `${DENSITY.ribbonBodyH}px`,
  'ribbon-h': `${DENSITY.ribbonTabH + DENSITY.ribbonBodyH}px`,
  // 注意：**没有 --drawer-w**。抽屉宽度是可拖的实例值，若放进来会被每次
  // 主题重写覆盖掉用户拖出来的宽度。它走元素内联样式，默认值取 DENSITY.drawerW。

  'sp-1': '2px',
  'sp-2': '4px',
  'sp-3': '6px',
  'sp-4': '8px',
  'sp-5': '12px',
  'sp-6': '16px',

  // z 层级。数值保持原有的相对关系（selected 盖住 edge），只是给了名字。
  'z-grid': '0',
  'z-clip': '1',
  'z-edge': '2',
  'z-clip-selected': '3',
  'z-playhead': '4',
  'z-ruler': '5',
  /*
   * 抽屉。**必须比时间轴内部那一套（1..5）都大。**
   *
   * 为什么这不是「随便给个 1 就行」：抽屉是一个**层叠上下文**，从抽屉里打开的
   * modal（如特效选择器，backdrop 是 z-modal 150）会被困在抽屉这一层 ——
   * 于是 z=5 的时间轴 ruler、z=4 的播放头都会盖到 modal 上面（真出现过：
   * 选择器开着，缩略图上横着一条白色标尺）。给抽屉留出比时间轴内部刻度更高的
   * 位置，modal 才谈得上「在最上面」。
   *
   * 规则：**根上下文里除 modal/tooltip 之外的 z 都必须 < 本值**（工具栏 3、
   * 底栏 2、时间轴内部 ≤5）。有 E2E 守着（见 timeline-ui.spec 的层叠用例）。
   */
  'z-drawer': '10',
  'z-popover': '20',
  'z-menu': '100',
  'z-modal': '150',
  'z-tooltip': '200',
};

/* ------------------------------------------------------------ motion
 *
 * 界面微动效的唯一基准。刻意不放进 STATIC：静态 token 是主题的固定部分，
 * 而这里的最终值随「启用 / 速度」偏好变化。组件只消费 --motion-* 变量，
 * 不自己写时长，否则设置里的开关会漏掉那个组件。
 *
 * 视觉纪律：只动 opacity、颜色，以及弹层自身不超过 2px 的位移。
 * 不动 width / height / top / left，也不在 Modal 及浮层祖先上用 transform
 * （会成为 fixed 后代的包含块，见 src/ui/AGENTS.md）。
 */

export const MOTION = {
  hover: 80,
  enter: 120,
  modal: 140,
  distance: -2,
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const MOTION_SPEEDS = ['slow', 'normal', 'fast'] as const;
export type MotionSpeed = (typeof MOTION_SPEEDS)[number];

/** 慢 1.25×、标准 1×、快 0.75×。最慢的 Modal 也只有 175ms。 */
export const MOTION_SPEED_FACTOR: Record<MotionSpeed, number> = {
  slow: 1.25,
  normal: 1,
  fast: 0.75,
};

/**
 * 把「启用 + 速度」解析成根节点上的 CSS 变量。
 *
 * 关闭时写 0ms / 0px 而不是删变量：组件仍沿用同一条声明，
 * 不会出现「某些组件回落到 CSS 默认时长」的漏网状态。
 */
export function resolveMotionTokens(enabled: boolean, speed: MotionSpeed): Record<string, string> {
  const factor = enabled ? MOTION_SPEED_FACTOR[speed] : 0;
  const ms = (base: number) => `${Math.round(base * factor)}ms`;
  return {
    '--motion-duration-hover': ms(MOTION.hover),
    '--motion-duration-enter': ms(MOTION.enter),
    '--motion-duration-modal': ms(MOTION.modal),
    '--motion-distance': enabled ? `${MOTION.distance}px` : '0px',
    '--motion-ease': MOTION.ease,
  };
}

/* ------------------------------------------------------------ component
 *
 * 组件绑定。值**必须**是 SemanticKey——想直接写 '--p-neutral-900' 会编译报错。
 * 这一层随组件落地逐步补齐；已经落地的都用它，避免组件 CSS 里散落 semantic
 * 名（那样改语义时组件是隐式跟随，看不出耦合点）。
 *
 * 输出成 `var(--semantic)` 而**不是**展开后的字面色，是为了让 `data-paper`
 * 那类局部覆盖能连带生效：自定义属性的 var() 在**声明它的元素**上就完成了替换，
 * 若这里写死颜色，纸面上下文里改 --surface-3 也追不到 --menu-bg。
 */

export const COMPONENT: Record<string, Record<string, SemanticKey>> = {
  tip: {
    bg: 'text-primary',
    fg: 'surface-0',
    border: 'text-primary',
  },
  popover: {
    bg: 'surface-3',
    border: 'border',
  },
  menu: {
    bg: 'surface-3',
    border: 'border',
    'item-hover': 'surface-hover',
    'item-fg': 'text-primary',
    'item-fg-muted': 'text-muted',
    'item-danger': 'danger',
    separator: 'border',
  },
  input: {
    bg: 'surface-3',
    border: 'border-control',
    'border-hover': 'border-strong',
    fg: 'text-primary',
    placeholder: 'text-muted',
  },
  field: {
    label: 'text-secondary',
    'label-muted': 'text-muted',
  },
  btn: {
    bg: 'surface-2',
    'bg-hover': 'surface-hover',
    border: 'border-control',
    fg: 'text-primary',
    'fg-hover': 'text-primary',
    'ghost-fg': 'text-secondary',
    'ghost-fg-hover': 'text-primary',
    /* 纯图标按钮：常规模式无框（透明），高对比度下靠它画出可点边界。 */
    'icon-border': 'border-icon',
    disabled: 'text-disabled',
  },
  rail: {
    bg: 'surface-1',
    border: 'border',
    fg: 'text-secondary',
    'fg-hover': 'text-primary',
    'fg-active': 'accent',
  },
  bar: {
    bg: 'surface-1',
    border: 'border',
    fg: 'text-secondary',
    'fg-strong': 'text-primary',
    accent: 'accent',
  },
  drawer: {
    bg: 'surface-1',
    border: 'border',
  },
  tl: {
    'side-bg': 'surface-2',
    border: 'border',
    'name': 'text-secondary',
    'name-muted': 'text-disabled',
    'icon-on': 'accent',
    'icon-off': 'text-muted',
    gutter: 'border',
  },
  /*
   * Ribbon 面板。视觉纪律照旧：零阴影零渐变，层次靠 surface 深度 + 1px 实线；
   * 主题色只出现在「当前 Tab」「toggle 打开态」「contextual 标记」「图库选中」——
   * 全都是「选中/激活」语义。
   */
  ribbon: {
    bg: 'surface-1',
    border: 'border',
    /* Ribbon 里的按钮（大按钮 / 菜单 / 图库 / 颜色）共用一条：常规三套是透明
       （Ribbon 的层次靠分组间距，不给每个按钮描边），高对比度下才画出边界。 */
    'btn-border': 'border-icon',
    'tab-fg': 'text-secondary',
    'tab-fg-hover': 'text-primary',
    'tab-fg-active': 'accent',
    'group-label': 'text-muted',
    separator: 'border',
    'btn-fg': 'text-secondary',
    'btn-fg-hover': 'text-primary',
    'btn-fg-active': 'accent',
    'btn-bg-hover': 'surface-hover',
    'btn-bg-active': 'accent-weak',
    'btn-fg-disabled': 'text-disabled',
    'gallery-border': 'border',
    'gallery-sel': 'accent',
  },
};

/* ------------------------------------------------------------ 颜色工具 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 解析 `#rgb` / `#rrggbb`（大小写与 `#` 均可省）。失败返回 null。 */
export const parseHex = hexToRgb;

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = clamp01(s);
  const ll = clamp01(l);
  if (ss === 0) {
    const v = ll * 255;
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: hue(hh + 1 / 3) * 255, g: hue(hh) * 255, b: hue(hh - 1 / 3) * 255 };
}

/** WCAG 相对亮度。 */
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 对比度（1..21）。传 hex 字符串。无法解析时返回 1。 */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------ accent 派生 */

/** 正文级对比度门槛。accent 会出现在底栏工程名、选中描边旁的文字上，
 *  所以按正文标准（4.5:1）而不是图形标准（3:1）来要求。 */
export const ACCENT_MIN_CONTRAST = 4.5;

/**
 * 每套模式的强调色政策。
 *
 * `gray` 把饱和度封顶在 0.55 —— 需求就是「更低饱和度、亮度更高的品牌色」：
 * 中灰底上再叠一个饱和紫，界面会比深色模式更吵，正好抵消了护眼的意义。
 * 其余三套沿用原来的口径（只兜底「全灰输入」，不额外压饱和）。
 */
export interface AccentPolicy {
  /** 下限：全灰输入也要能产出一条合法色阶（退化为灰阶强调色）。 */
  minS: number;
  /** 上限：1 = 不压饱和。 */
  maxS: number;
}

export const ACCENT_POLICY: Record<ThemeMode, AccentPolicy> = {
  light: { minS: 0.28, maxS: 1 },
  dark: { minS: 0.28, maxS: 1 },
  gray: { minS: 0.28, maxS: 0.55 },
  contrast: { minS: 0.28, maxS: 1 },
};

/** 底色是亮还是暗，决定强调色往哪边钳制。阈值取得很保守：纸面 #BDBDBD 与
 *  深灰 #525252 都必须落在正确的一侧。 */
function familyOfBg(bg: string): ThemeFamily {
  const c = parseHex(bg);
  return c && relativeLuminance(c) > 0.25 ? 'light' : 'dark';
}

function rampFromHsl(h: number, s: number, l: number, family: ThemeFamily): AccentRamp {
  const base = hslToRgb(h, s, l);
  const hex = rgbToHex(base);

  const strong = hslToRgb(h, clamp01(s * 1.02), clamp01(family === 'light' ? l - 0.1 : l + 0.09));
  // weak 是「选中底」这类极淡填充：亮色下提亮降饱和，暗色下压暗降饱和。
  const weak = family === 'light' ? hslToRgb(h, s * 0.55, 0.955) : hslToRgb(h, s * 0.42, 0.2);

  const onWhite = contrastRatio('#ffffff', hex);
  const onInk = contrastRatio(PRIMITIVES['neutral-1000']!, hex);

  return {
    accent: hex,
    accentStrong: rgbToHex(strong),
    accentWeak: rgbToHex(weak),
    accentBorder: hex,
    accentOn: onWhite >= onInk ? '#ffffff' : PRIMITIVES['neutral-1000']!,
  };
}

/**
 * 任意 hex → 一条完整色阶，**按与 `bg` 的对比度钳制明度**。
 *
 * 用户给一个亮黄当主题色，直接用在亮底上会糊成一片；这里保持色相、按政策钳
 * 饱和度，再把明度二分到刚好满足 ACCENT_MIN_CONTRAST 的那一档 —— 方向由
 * `bg` 的亮度决定，所以同一支函数同时服务「深色面板」与「浅灰纸面」。
 */
export function accentRampOn(hex: string, bg: string, policy: AccentPolicy): AccentRamp {
  const family = familyOfBg(bg);
  const rgb = parseHex(hex);
  // 解析失败不抛错：主题色是用户输入，坏值应该退化成默认紫而不是整个应用起不来。
  // 走**同一条**钳制路径（而不是另给一组写死的明度），否则默认色会在某套模式下不达标。
  if (!rgb) return accentRampOn(ACCENT_PRESETS.violet.hex, bg, policy);

  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const sat = Math.min(policy.maxS, Math.max(s, policy.minS));
  const hexAt = (ll: number): string => rgbToHex(hslToRgb(h, sat, ll));

  const ok = (ll: number): boolean => contrastRatio(hexAt(ll), bg) >= ACCENT_MIN_CONTRAST;

  const darker = family === 'light'; // 亮底要更暗，暗底要更亮
  let lo = darker ? 0 : l;
  let hi = darker ? l : 1;
  let best = l;

  if (ok(l)) {
    best = l;
  } else {
    // 二分找一个刚好达标的明度；找不到就用端点（已是最有利的一侧）。
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) {
        best = mid;
        if (darker) lo = mid;
        else hi = mid;
      } else if (darker) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    if (!ok(best)) best = darker ? 0 : 1;
  }

  /*
   * 收尾：保证**叠在 accent 上的文字**也达标。
   *
   * 只钳「accent vs 底色」是不够的：明度落在中间带时，白字与近黑字对它的对比度
   * 会同时卡在 4.4 附近（紫 #6f64ef 在纯黑底上就是这样 —— 需求里高对比度模式
   * 那一档刚好把它暴露出来）。往远离底色的方向推一两个千分点就能跨出这条带，
   * 而「离底色更远」这个方向永远同时满足第一条约束。
   */
  for (let i = 0; i < 24; i += 1) {
    const ramp = rampFromHsl(h, sat, best, family);
    if (contrastRatio(ramp.accentOn, ramp.accent) >= ACCENT_MIN_CONTRAST) return ramp;
    const next = Math.min(1, Math.max(0, best + (darker ? -0.004 : 0.004)));
    if (next === best || !ok(next)) break;
    best = next;
  }

  return rampFromHsl(h, sat, best, family);
}

export function accentRampFromHex(hex: string, mode: ThemeMode): AccentRamp {
  return accentRampOn(hex, SEMANTIC[mode]['surface-0'], ACCENT_POLICY[mode]);
}

export function accentRampOf(src: AccentSource, mode: ThemeMode): AccentRamp {
  if (src.kind === 'custom') return accentRampFromHex(src.hex, mode);
  return accentRampFromHex(ACCENT_PRESETS[src.id].hex, mode);
}

/**
 * 纸面上下文里的强调色。
 *
 * 灰色模式的纸面是 #BDBDBD，主界面的强调色（按 #464646 钳出来的亮粉彩）放上去
 * 会低到看不清；所以纸面单独按自己的底色钳一版。其余三套模式的纸面与外面一致，
 * 直接复用 —— 它们必须是同一个值，否则弹窗内外会差半档色。
 */
export function paperRampOf(src: AccentSource, mode: ThemeMode): AccentRamp {
  if (mode !== 'gray') return accentRampOf(src, mode);
  const hex = src.kind === 'custom' ? src.hex : ACCENT_PRESETS[src.id].hex;
  return accentRampOn(hex, PAPER.gray['surface-1'], ACCENT_POLICY.gray);
}

/* ------------------------------------------------------------ 解析 */

/** accent 组的 token 名。换品牌时**只应**这几个键变化——有单测钉住这条。
 *  `border-focus` 也在内，因为焦点环就是主题色，它是派生值不是独立语义。 */
export const ACCENT_TOKEN_KEYS = [
  'accent',
  'accent-strong',
  'accent-weak',
  'accent-border',
  'accent-on',
  'border-focus',
] as const;

function flatten(
  records: Record<string, string>[],
  out: Record<string, string>,
): Record<string, string> {
  for (const rec of records) {
    for (const [k, v] of Object.entries(rec)) out[`--${k}`] = v;
  }
  return out;
}

/** 全量扁平化：`resolveTokens(spec)` → `{ '--surface-0': '#ffffff', ... }`。 */
export function resolveTokens(spec: ThemeSpec): Record<string, string> {
  const ramp = accentRampOf(spec.accent, spec.mode);
  const semantic = applyRamp({ ...SEMANTIC[spec.mode] }, ramp);

  const paperRamp = paperRampOf(spec.accent, spec.mode);
  const paperSemantic = applyRamp({ ...PAPER[spec.mode] }, paperRamp);
  const paper: Record<string, string> = {};
  for (const [k, v] of Object.entries(paperSemantic)) paper[`paper-${k}`] = v;
  // 纸面自己的原生配色（滚动条 / 取色器 / 表单控件）。按**纸面底色**定，
  // 而不是按模式：灰色模式的纸面是浅灰，`color-scheme: dark` 会画出深色滚动条。
  paper['paper-color-scheme'] = familyOfBg(paperSemantic['surface-0']!);

  /*
   * component 层输出 `var(--semantic)` 而不是展开值。两个理由：
   *   1. 局部覆盖能连带生效（纸面上下文靠它，见 PAPER 的注释）；
   *   2. 组件与语义之间只剩一处耦合点，且被类型锁在 SemanticKey 上。
   */
  const component: Record<string, string> = {};
  for (const [group, vars] of Object.entries(COMPONENT)) {
    for (const [name, key] of Object.entries(vars)) {
      if (semantic[key] !== undefined) component[`${group}-${name}`] = `var(--${key})`;
    }
  }

  return flatten(
    [STATIC, semantic, CONTENT[spec.mode], component, paper],
    {} as Record<string, string>,
  ) as Record<string, string>;
}

function applyRamp(semantic: Record<string, string>, ramp: AccentRamp): Record<string, string> {
  semantic['accent'] = ramp.accent;
  semantic['accent-strong'] = ramp.accentStrong;
  semantic['accent-weak'] = ramp.accentWeak;
  semantic['accent-border'] = ramp.accentBorder;
  semantic['accent-on'] = ramp.accentOn;
  semantic['border-focus'] = ramp.accent;
  return semantic;
}

/* ------------------------------------------------------------ 纸面作用域
 *
 * 容器挂 `data-paper` 就进入纸面上下文：这里把 semantic 与 component 变量整体
 * 重指向 `--paper-*`。**规则文本由 TS 生成**，不是手写在 app.css 里 ——
 * 加一个 semantic key 时，纸上那份手写清单必然会漏，而漏掉的表现是「弹窗里
 * 有一个控件还是深色」，不报错、也说不清是哪一条。
 */
export const PAPER_ATTR = 'data-paper';

export function paperScopeRule(): string {
  const decls: string[] = [];
  for (const key of Object.keys(SEMANTIC.light)) decls.push(`--${key}:var(--paper-${key})`);
  for (const [group, vars] of Object.entries(COMPONENT)) {
    for (const [name, key] of Object.entries(vars)) decls.push(`--${group}-${name}:var(--${key})`);
  }
  decls.push('color-scheme:var(--paper-color-scheme)');
  return `[${PAPER_ATTR}]{${decls.join(';')}}`;
}

/* ------------------------------------------------------------ Canvas 调色板
 *
 * 时间轴 Canvas2D 的唯一颜色来源。网格线这类需要 alpha 的颜色没法直接复用
 * 不透明 token，所以在这里显式给成 rgba 字符串——但**只在这里给一次**。
 */

export interface CanvasPalette {
  rulerBg: string;
  rulerText: string;
  barLine: string;
  beatLine: string;
  gridBg: string;
  rowVisual: string;
  rowAudio: string;
  rowLine: string;
  waveBody: string;
  waveCenter: string;
  originLine: string;
}

/** 把不透明的 hex 套上 alpha，得到 Canvas 可用的 rgba 字符串。 */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}

/**
 * 网格线的 alpha 与「用哪一档 surface 当底」。
 *
 * 四套模式各写一份是**必要**的：alpha 的合适值取决于底色亮度 —— 同样的 0.24
 * 白线，在 #131518 上是清晰的网格，在 #525252 上几乎看不见。灰模式的网格要
 * 抬到 0.34 才读得出格，而高对比度需要 0.6。
 */
const CANVAS_TUNING: Record<
  ThemeMode,
  {
    grid: 'surface-0' | 'surface-1';
    ruler: 'surface-1' | 'surface-2';
    bar: number;
    beat: number;
    rowVisual: number;
    rowAudio: number;
    rowLine: number;
    waveBody: number;
    waveCenter: number;
  }
> = {
  light: {
    grid: 'surface-0',
    ruler: 'surface-1',
    bar: 0.26,
    beat: 0.09,
    rowVisual: 0.022,
    rowAudio: 0.05,
    rowLine: 0.14,
    waveBody: 0.62,
    waveCenter: 0.2,
  },
  dark: {
    grid: 'surface-1',
    ruler: 'surface-2',
    bar: 0.24,
    beat: 0.07,
    rowVisual: 0.05,
    rowAudio: 0.09,
    rowLine: 0.16,
    waveBody: 0.68,
    waveCenter: 0.22,
  },
  /* 中灰底：所有线都要更实一点，否则「有格」和「没格」分不出来。 */
  gray: {
    grid: 'surface-0',
    ruler: 'surface-2',
    bar: 0.34,
    beat: 0.12,
    rowVisual: 0.04,
    rowAudio: 0.07,
    rowLine: 0.18,
    waveBody: 0.78,
    waveCenter: 0.32,
  },
  /* 纯黑底：一切都拉到「扫一眼就看见」，波形几乎不透明。 */
  contrast: {
    grid: 'surface-0',
    ruler: 'surface-1',
    bar: 0.6,
    beat: 0.28,
    rowVisual: 0.06,
    rowAudio: 0.1,
    rowLine: 0.32,
    waveBody: 0.95,
    waveCenter: 0.5,
  },
};

export function canvasPalette(spec: ThemeSpec): CanvasPalette {
  const t = resolveTokens(spec);
  const tune = CANVAS_TUNING[spec.mode];
  const ink = t['--text-primary']!;

  return {
    rulerBg: t[`--${tune.ruler}`]!,
    rulerText: t['--text-muted']!,
    // 拍线淡、小节线显著——读格靠这个层级，不靠颜色。
    barLine: withAlpha(ink, tune.bar),
    beatLine: withAlpha(ink, tune.beat),
    gridBg: t[`--${tune.grid}`]!,
    rowVisual: withAlpha(ink, tune.rowVisual),
    rowAudio: withAlpha(ink, tune.rowAudio),
    rowLine: withAlpha(ink, tune.rowLine),
    // 波形要能透过音频片段的半透明底色读出来，所以比网格线明显得多
    waveBody: withAlpha(ink, tune.waveBody),
    waveCenter: withAlpha(ink, tune.waveCenter),
    // 工程起点线用主题色：它是「当前位置」类标记，与播放头同类，
    // 属于本设计里允许动用主题色的少数场景之一。
    originLine: withAlpha(t['--accent']!, 0.85),
  };
}
