/**
 * icons.ts — 图标注册表。
 *
 * 用 Lucide 而不是 Font Awesome（项目取向，也是跨项目偏好）：它是描边图标，
 * 与本项目「不加装饰、靠线条与纯色分层」的视觉一致；ISC 许可；按组件导出，
 * 天然 tree-shaking（Font Awesome 整包 CSS 是 ~1MB 的字体 + 全部图标样式）。
 *
 * 用具名**直连**而不是 `import { Icon } from '@lucide/svelte'`：直连让 Vite 少
 * 解析一个万行 barrel 文件，冷启动与 HMR 都更快。代价是不能用别名——所以下面
 * 全部是 `dist/icons/*.svelte` 里存在独立组件的名字（`trash-2`、`vertical-ellipsis`
 * 这类只有 .js 别名的**不能**直连，已改用 `trash` / `ellipsis-vertical`）。
 *
 * 踩过的坑：文本对齐的图标在 Lucide 里叫 `text-align-start/-center/-end/-justify`，
 * **不是** `align-left` 那套（那四个名字没有独立组件文件）。排版 Ribbon 一开始
 * 就是照着 `align-left` 写的，编译直接报「找不到模块」。
 */

import AArrowDown from '@lucide/svelte/icons/a-arrow-down';
import AArrowUp from '@lucide/svelte/icons/a-arrow-up';
import Activity from '@lucide/svelte/icons/activity';
import AlignCenterHorizontal from '@lucide/svelte/icons/align-center-horizontal';
import AlignCenterVertical from '@lucide/svelte/icons/align-center-vertical';
import AlignEndHorizontal from '@lucide/svelte/icons/align-end-horizontal';
import AlignEndVertical from '@lucide/svelte/icons/align-end-vertical';
import AlignHorizontalSpaceBetween from '@lucide/svelte/icons/align-horizontal-space-between';
import AlignStartHorizontal from '@lucide/svelte/icons/align-start-horizontal';
import AlignStartVertical from '@lucide/svelte/icons/align-start-vertical';
import AlignVerticalSpaceBetween from '@lucide/svelte/icons/align-vertical-space-between';
import ArrowDown from '@lucide/svelte/icons/arrow-down';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import ArrowUp from '@lucide/svelte/icons/arrow-up';
import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
import AudioLines from '@lucide/svelte/icons/audio-lines';
import Baseline from '@lucide/svelte/icons/baseline';
import Blend from '@lucide/svelte/icons/blend';
import Bold from '@lucide/svelte/icons/bold';
import Brain from '@lucide/svelte/icons/brain';
import BringToFront from '@lucide/svelte/icons/bring-to-front';
import Camera from '@lucide/svelte/icons/camera';
import CaseSensitive from '@lucide/svelte/icons/case-sensitive';
import ChartColumnIncreasing from '@lucide/svelte/icons/chart-column-increasing';
import ChartLine from '@lucide/svelte/icons/chart-line';
import Check from '@lucide/svelte/icons/check';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import Circle from '@lucide/svelte/icons/circle';
import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
import Clock from '@lucide/svelte/icons/clock';
import Combine from '@lucide/svelte/icons/combine';
import Copy from '@lucide/svelte/icons/copy';
import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
import Crop from '@lucide/svelte/icons/crop';
import Diamond from '@lucide/svelte/icons/diamond';
import Download from '@lucide/svelte/icons/download';
import Droplet from '@lucide/svelte/icons/droplet';
import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';
import Archive from '@lucide/svelte/icons/archive';
import FileVideoCamera from '@lucide/svelte/icons/file-video-camera';
import FilePlus from '@lucide/svelte/icons/file-plus';
import FileX from '@lucide/svelte/icons/file-x';
import LinkIcon from '@lucide/svelte/icons/link';
import PackageOpen from '@lucide/svelte/icons/package-open';
import FileTypeCorner from '@lucide/svelte/icons/file-type-corner';
import FlaskConical from '@lucide/svelte/icons/flask-conical';
import Folder from '@lucide/svelte/icons/folder';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import Frame from '@lucide/svelte/icons/frame';
import Grid2x2 from '@lucide/svelte/icons/grid-2x2';
import GripVertical from '@lucide/svelte/icons/grip-vertical';
import Group from '@lucide/svelte/icons/group';
import HardDrive from '@lucide/svelte/icons/hard-drive';
import Hexagon from '@lucide/svelte/icons/hexagon';
import Highlighter from '@lucide/svelte/icons/highlighter';
import History from '@lucide/svelte/icons/history';
import ImageIcon from '@lucide/svelte/icons/image';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import Images from '@lucide/svelte/icons/images';
import ImportIcon from '@lucide/svelte/icons/import';
import Info from '@lucide/svelte/icons/info';
import Italic from '@lucide/svelte/icons/italic';
import Keyboard from '@lucide/svelte/icons/keyboard';
import Layers from '@lucide/svelte/icons/layers';
import Lock from '@lucide/svelte/icons/lock';
import LockOpen from '@lucide/svelte/icons/lock-open';
import Magnet from '@lucide/svelte/icons/magnet';
import Megaphone from '@lucide/svelte/icons/megaphone';
import MegaphoneOff from '@lucide/svelte/icons/megaphone-off';
import Maximize from '@lucide/svelte/icons/maximize';
import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus';
import Metronome from '@lucide/svelte/icons/metronome';
import Minimize from '@lucide/svelte/icons/minimize';
import Minimize2 from '@lucide/svelte/icons/minimize-2';
import Minus from '@lucide/svelte/icons/minus';
import Monitor from '@lucide/svelte/icons/monitor';
import Moon from '@lucide/svelte/icons/moon';
import Move from '@lucide/svelte/icons/move';
import MoveDown from '@lucide/svelte/icons/move-down';
import MoveHorizontal from '@lucide/svelte/icons/move-horizontal';
import MoveUp from '@lucide/svelte/icons/move-up';
import Music from '@lucide/svelte/icons/music';
import PaintBrush from '@lucide/svelte/icons/paintbrush';
import PaintBrushVertical from '@lucide/svelte/icons/paintbrush-vertical';
import PaintBucket from '@lucide/svelte/icons/paint-bucket';
import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
import PanelRight from '@lucide/svelte/icons/panel-right';
import Palette from '@lucide/svelte/icons/palette';
import Pause from '@lucide/svelte/icons/pause';
import Pencil from '@lucide/svelte/icons/pencil';
import PenTool from '@lucide/svelte/icons/pen-tool';
import Pipette from '@lucide/svelte/icons/pipette';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import Repeat from '@lucide/svelte/icons/repeat';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import RotateCw from '@lucide/svelte/icons/rotate-cw';
import Save from '@lucide/svelte/icons/save';
import Scissors from '@lucide/svelte/icons/scissors';
import Search from '@lucide/svelte/icons/search';
import Send from '@lucide/svelte/icons/send';
import SendToBack from '@lucide/svelte/icons/send-to-back';
import Settings from '@lucide/svelte/icons/settings';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Shapes from '@lucide/svelte/icons/shapes';
import Sigma from '@lucide/svelte/icons/sigma';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Spline from '@lucide/svelte/icons/spline';
import Eraser from '@lucide/svelte/icons/eraser';
import ALargeSmall from '@lucide/svelte/icons/a-large-small';
import SquaresExclude from '@lucide/svelte/icons/squares-exclude';
import SquaresIntersect from '@lucide/svelte/icons/squares-intersect';
import SquaresSubtract from '@lucide/svelte/icons/squares-subtract';
import SquaresUnite from '@lucide/svelte/icons/squares-unite';
import Square from '@lucide/svelte/icons/square';
import SquareDashed from '@lucide/svelte/icons/square-dashed';
import SquareFunction from '@lucide/svelte/icons/square-function';
import Star from '@lucide/svelte/icons/star';
import LayoutGrid from '@lucide/svelte/icons/layout-grid';
import ListIcon from '@lucide/svelte/icons/list';
import Strikethrough from '@lucide/svelte/icons/strikethrough';
import Sun from '@lucide/svelte/icons/sun';
import TextAlignCenter from '@lucide/svelte/icons/text-align-center';
import TextAlignEnd from '@lucide/svelte/icons/text-align-end';
import TextAlignJustify from '@lucide/svelte/icons/text-align-justify';
import TextAlignStart from '@lucide/svelte/icons/text-align-start';
import Timer from '@lucide/svelte/icons/timer';
import Code from '@lucide/svelte/icons/code';
import Trash from '@lucide/svelte/icons/trash';
import Triangle from '@lucide/svelte/icons/triangle';
import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
import Type from '@lucide/svelte/icons/type';
import Underline from '@lucide/svelte/icons/underline';
import Ungroup from '@lucide/svelte/icons/ungroup';
import Upload from '@lucide/svelte/icons/upload';
import Puzzle from '@lucide/svelte/icons/puzzle';
import Video from '@lucide/svelte/icons/video';
import Volume2 from '@lucide/svelte/icons/volume-2';
import VolumeX from '@lucide/svelte/icons/volume-x';
import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
import Waypoints from '@lucide/svelte/icons/waypoints';
import X from '@lucide/svelte/icons/x';

/*
 * 自绘图标。Lucide 里没有对应形状，但这两件事在 Office 里是**固定字形**
 * （「AV 加双向箭头」与「A 带重影」），用别的图标凑合会让人认不出来。
 * 统一遵守 Lucide 的形态约定：24×24 viewBox、描边、currentColor、无填充。
 */
import LetterSpacing from './icons/letter-spacing.svelte';
import TextShadow from './icons/text-shadow.svelte';
import SquaresDivide from './icons/squares-divide.svelte';

/** 名字 → 组件。新增图标只在这里加一行，调用点写 `name="eye"` 即得类型检查。 */
export const ICONS = {
  'a-arrow-down': AArrowDown,
  'a-arrow-up': AArrowUp,
  /** 时间轴形态「节奏」的图标（与 `timer` 组成两态按钮）。 */
  activity: Activity,
  'align-center-horizontal': AlignCenterHorizontal,
  'align-center-vertical': AlignCenterVertical,
  'align-end-horizontal': AlignEndHorizontal,
  'align-end-vertical': AlignEndVertical,
  'align-horizontal-space-between': AlignHorizontalSpaceBetween,
  'align-start-horizontal': AlignStartHorizontal,
  'align-start-vertical': AlignStartVertical,
  'align-vertical-space-between': AlignVerticalSpaceBetween,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'rotate-ccw': RotateCcw,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-up-down': ArrowUpDown,
  'audio-lines': AudioLines,
  baseline: Baseline,
  blend: Blend,
  bold: Bold,
  brain: Brain,
  'bring-to-front': BringToFront,
  'case-sensitive': CaseSensitive,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  circle: Circle,
  'clipboard-paste': ClipboardPaste,
  clock: Clock,
  combine: Combine,
  copy: Copy,
  'corner-down-right': CornerDownRight,
  crop: Crop,
  diamond: Diamond,
  download: Download,
  droplet: Droplet,
  'ellipsis-vertical': EllipsisVertical,
  eye: Eye,
  'eye-off': EyeOff,
  'file-plus': FilePlus,
  'file-x': FileX,
  archive: Archive,
  link: LinkIcon,
  'package-open': PackageOpen,
  'file-type-corner': FileTypeCorner,
  'flask-conical': FlaskConical,
  folder: Folder,
  'folder-open': FolderOpen,
  frame: Frame,
  'grid-2x2': Grid2x2,
  'grip-vertical': GripVertical,
  group: Group,
  'hard-drive': HardDrive,
  hexagon: Hexagon,
  highlighter: Highlighter,
  history: History,
  image: ImageIcon,
  'image-plus': ImagePlus,
  images: Images,
  import: ImportIcon,
  info: Info,
  italic: Italic,
  keyboard: Keyboard,
  layers: Layers,
  lock: Lock,
  'lock-open': LockOpen,
  magnet: Magnet,
  megaphone: Megaphone,
  'megaphone-off': MegaphoneOff,
  maximize: Maximize,
  'message-circle-plus': MessageCirclePlus,
  metronome: Metronome,
  minimize: Minimize,
  'minimize-2': Minimize2,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  move: Move,
  'move-down': MoveDown,
  'move-horizontal': MoveHorizontal,
  'move-up': MoveUp,
  music: Music,
  'paint-bucket': PaintBucket,
  paintbrush: PaintBrush,
  'paintbrush-vertical': PaintBrushVertical,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  'panel-right': PanelRight,
  'chart-line': ChartLine,
  'chart-column-increasing': ChartColumnIncreasing,
  'file-video-camera': FileVideoCamera,
  camera: Camera,
  palette: Palette,
  pause: Pause,
  pencil: Pencil,
  'pen-tool': PenTool,
  pipette: Pipette,
  play: Play,
  plus: Plus,
  repeat: Repeat,
  'rotate-cw': RotateCw,
  save: Save,
  scissors: Scissors,
  search: Search,
  send: Send,
  'send-to-back': SendToBack,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  shapes: Shapes,
  sigma: Sigma,
  sparkles: Sparkles,
  spline: Spline,
  eraser: Eraser,
  'a-large-small': ALargeSmall,
  'squares-divide': SquaresDivide,
  'squares-exclude': SquaresExclude,
  'squares-intersect': SquaresIntersect,
  'squares-subtract': SquaresSubtract,
  'squares-unite': SquaresUnite,
  square: Square,
  'square-dashed': SquareDashed,
  'square-function': SquareFunction,
  star: Star,
  strikethrough: Strikethrough,
  sun: Sun,
  'letter-spacing': LetterSpacing,
  'text-shadow': TextShadow,
  'text-align-center': TextAlignCenter,
  'text-align-end': TextAlignEnd,
  'text-align-justify': TextAlignJustify,
  'text-align-start': TextAlignStart,
  timer: Timer,
  code: Code,
  trash: Trash,
  triangle: Triangle,
  'triangle-alert': TriangleAlert,
  type: Type,
  underline: Underline,
  ungroup: Ungroup,
  upload: Upload,
  video: Video,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'wand-sparkles': WandSparkles,
  waypoints: Waypoints,
  puzzle: Puzzle,
  'layout-grid': LayoutGrid,
  list: ListIcon,
  x: X,
} as const;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** 轨道类型的图标：视觉轨用 `video`，音频轨按静音状态给两套。 */
export const TRACK_ICON = {
  visual: { on: 'eye', off: 'eye-off' },
  audio: { on: 'megaphone', off: 'megaphone-off' },
} as const satisfies Record<string, { on: IconName; off: IconName }>;

/** 片段类型的图标（排版片段在轨道上用的是 `type`）。 */
export const CLIP_ICON = {
  source: 'video',
  text: 'type',
  effect: 'flask-conical',
  audio: 'audio-lines',
} as const satisfies Record<string, IconName>;
