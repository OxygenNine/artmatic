/**
 * schema.ts — 工程数据模型（AGENTS.md §5 的落地）+ schemaVersion + 迁移。
 *
 * 判别联合就是「轨道不区分内容」的实现：
 *   Track = VisualTrack | SoundTrack（命名避开 WebAudio 的 AudioTrack）
 *   AnyClip = SourceClip | EffectClip | AudioClip
 *
 * curves 的键约定：
 *   SourceClip  —— 保留字 'opacity' / 'transform.x' / 'transform.y' / 'transform.sx' /
 *                 'transform.sy' / 'transform.rot'；algo 源另有生成器参数键（如 'zoom'）。
 *   EffectClip  —— `${instanceId}.${paramKey}`，作用于 chain 里某个特效实例的参数。
 *   AudioClip   —— 'gain'。
 */

import type { BeatGrid } from './time';
import type { Curve } from './curve';
import type { CropSettings, KeySettings, QuadCorners } from './image-fx';
import type { TypographyDocument } from '../typography/document';
import {
  isKnownTheme,
  parseThemeRef,
  resolveThemeColor,
  sanitizeCustomThemes,
  type TypographyTheme,
} from '../typography/theme';
import { tr } from '../i18n/index.svelte';
import type { MessageKey } from '../i18n/locales';
import { migrateProjectAnimations, pinAnimationTargets } from '../typography/animation-migrate';
import { sanitizeSections } from './sections';
import { sanitizeBeatMarks } from './beat-marks';
import { isValidCrop } from './image-fx';
import { sanitizeMaskInputs, type MaskRef } from './mask';
import { sanitizeAssetParams } from './asset-params';
import {
  modTable,
  sanitizeClipMods,
  sanitizeModulators,
  type ClipMods,
  type Modulator,
} from './modulation';

export const SCHEMA_VERSION = 21;

export type OverlapBehavior = 'push' | 'reject' | 'trim';

/**
 * 段落标记（v8）。**标记，不是容器** —— 片段不归属段落，段落也不裁剪片段。
 *
 * 只存起点、不存终点：「这一段的结尾」永远是下一段的开头（最后一段到工程末尾）。
 * 存 `end` 会立刻出现「相邻两段之间的缝算谁的」这种没有正确答案的问题，而且改
 * `Project.duration` 时还得跟着修。排序 / 清洗 / 吸附见 `core/sections.ts`。
 */
export interface Section {
  id: string;
  /** 显示名。标尺上方只画得下十几个字，长度在 `sanitizeSections` 里截断。 */
  name: string;
  /** 秒，与 `clip.start` 同一口径。 */
  start: number;
  /** 可选色调（`#rrggbb`），画在标尺上方的段落带上。缺省 = 主题色。 */
  color?: string;
}

export interface Project {
  schemaVersion: number;
  name: string;
  /** 全工程随机种子（硬约束 1.2 的根）。 */
  seed: number;
  fps: number;
  resolution: { w: number; h: number };
  /** 秒。 */
  duration: number;
  beatGrid: BeatGrid;
  /** 同轨重叠策略：可配置（挤开邻居 / 拒绝落点 / 吃掉邻居重叠部分），默认 reject。 */
  overlapBehavior: OverlapBehavior;
  assets: Record<string, Asset>;
  tracks: Track[];
  /**
   * 段落标记（v8）。**只增字段、不改片段几何**：时间轴在标尺上方画一条 12px 带，
   * 段落边界参与吸附（`core/sections.ts::snapTimeWithSections`），但没有任何
   * 渲染 / 导出路径读它 —— 所以「段落」不会让既有工程导出结果发生变化。
   */
  sections: Section[];
  /**
   * 手动节奏点（v21，打点计时）：秒、升序、允许不等距。
   *
   * **不是第二套拍网格**：它只给时间轴提供额外的吸附硬点，并画成虚线 /
   * 段落带刻度；`beatGrid`（BPM / offset）仍然是等距拍与所有音频特征的唯一
   * 来源。清洗 / 增删 / 移动全在 `core/beat-marks.ts`（纯函数）。
   */
  beatMarks: number[];
  /**
   * 工程默认的排版配色方案 id（新文本片段的文档默认；也供检查器里的
   * 非排版取色入口解析主题色引用）。缺省 = `DEFAULT_THEME_ID`。
   */
  typographyTheme?: string;
  /**
   * 用户自定义配色方案（随工程保存，属工程内容）。id 不得与内置方案冲突。
   * 缺省 = 无。坏数据由 `validateProject` 整条丢掉（详见那里的注释）。
   */
  customThemes?: TypographyTheme[];
  /**
   * 调制器（v20）：工程级的表达式实体，被片段上的 `mods` 按 id 引用。
   *
   * **必须是工程级**：同一个「抖动」定义复用到十几条片段上是常态，挂在片段上
   * 等于改一次要改十几处。缺省 = 没有调制器（求值路径与 v19 逐字节相同）。
   */
  modulators?: Modulator[];
}

/*
 * 对话历史**不在**这里：它是 `agent/sessions/<id>.json`（见 `src/agent/history.ts`）。
 * 挂在 Project 上的代价是「聊一句 = 重写整份工程」，而且撤销栈要专门绕开它。
 */

/**
 * 预剪辑范围（v13）：素材上保存的一组 In/Out 对，随工程保存。
 *
 * **秒落库**（与 `clip.start` 同口径），UI 按工程 fps 换算成帧展示与打点 ——
 * 存帧号会把「改了工程 fps」变成对所有素材范围的静默重算。
 */
export interface AssetTrimRange {
  id: string;
  name: string;
  inSec: number;
  outSec: number;
}

/**
 * 素材类型。`lut` 是**给调色用的查找表**（`.cube`）：它进工程素材台账
 * （要跟着工程走、要能打包），但**不进时间轴、不进媒体池的插入入口** ——
 * 它不是「画面」，没有时长也没有尺寸。消费方是 `grade-lut`。
 */
export type AssetKind = 'audio' | 'image' | 'video' | 'lut';

/** 能进时间轴 / 媒体池的那几类（`lut` 故意不在内）。 */
export type MediaKind = 'audio' | 'image' | 'video';

export interface Asset {
  id: string;
  /**
   * `video` 由 `engine/video-source.ts` 接上。台账层
   * （`project/ledger.ts` 的 `AssetEntry.kind`）早就有它了，
   * 这里曾经落后一格 —— 于是「导入视频 → 存进工程 → 打开时按 kind 分支」
   * 会在校验处对不上。
   */
  kind: AssetKind;
  name: string;
  /** 内容哈希（引用制的预留，暂不强制）。 */
  hash?: string;
  durationSec?: number;
  size?: { w: number; h: number };
  /**
   * 视频预剪辑范围（v13）。缺省 = 没有保存过范围，插入整段素材。
   * 坏条目由 `validateProject` 逐条丢弃，工程必须打得开。
   */
  ranges?: AssetTrimRange[];
  /** 当前激活范围（v13）。双击 / 「+」插入时用它；坏 id 在打开时清掉。 */
  activeRangeId?: string;
  /**
   * 视频是否含音轨（v13，导入/打开时探测）。`false` = 不必尝试解码音频；
   * 缺省 = 未知，需要时再探。
   */
  hasAudio?: boolean;
}

/* ---------------------------------------------------------------- tracks */

export type Track = VisualTrack | SoundTrack;

interface TrackBase {
  id: string;
  name: string;
  enabled: boolean;
}

export interface VisualTrack extends TrackBase {
  kind: 'visual';
  /** 同轨不重叠，按 start 排序。 */
  clips: (SourceClip | EffectClip)[];
  /**
   * **轨道静音**（v15）：只关这一条轨上视频片段的内嵌音轨，画面照常。
   *
   * 与 `enabled` 刻意分开：`enabled` 是「这一层不出现在画面里」，它已经连带
   * 关掉声音；静音是「画面留着、声音不要」—— 审片时最常见的操作。缺省 / false
   * = 有声。音频轨不用这个字段（它的 `enabled` 本来就是喇叭语义）。
   */
  muted?: boolean;
}

export interface SoundTrack extends TrackBase {
  kind: 'audio';
  clips: AudioClip[];
  bus: 'master' | string;
}

/* ----------------------------------------------------------------- clips */

export type AnyClip = SourceClip | EffectClip | AudioClip;

export interface ClipBase {
  id: string;
  start: number;
  end: number;
  label: string;
  fadeSec: number;
  curves: Record<string, Curve>;
  /**
   * 调制槽（v20）：**与 `curves` 共用键空间**，所以「同一参数既有关键帧又有
   * 调制」天然成立（曲线给值，调制在它之上叠加）。
   *
   * 缺省 = 没有调制。坏引用由 `validateProject` 清掉（见 `core/modulation.ts`
   * 的 `sanitizeClipMods`）：留下的悬空 ref 求值恒为 0，界面上完全看不出原因。
   */
  mods?: ClipMods;
}

export type BlendMode =
  | 'normal' | 'multiply' | 'add' | 'screen'
  | 'overlay' | 'difference' | 'exclusion' | 'subtract';

/** 混合模式表。存文案键而非字符串 —— 理由见 effects/types.ts 的注释。 */
export const BLEND_MODES: { id: BlendMode; labelKey: MessageKey }[] = [
  { id: 'normal', labelKey: 'blend.normal' },
  { id: 'multiply', labelKey: 'blend.multiply' },
  { id: 'add', labelKey: 'blend.add' },
  { id: 'screen', labelKey: 'blend.screen' },
  { id: 'overlay', labelKey: 'blend.overlay' },
  { id: 'difference', labelKey: 'blend.difference' },
  { id: 'exclusion', labelKey: 'blend.exclusion' },
  { id: 'subtract', labelKey: 'blend.subtract' },
];

export type AlgoSource = { type: 'algo'; generator: string; params: Record<string, number | string> };

/**
 * 片段边界的转场（gl-transitions 的一条）。
 *
 * 同一个类型用在两处（v13 起双侧）：
 * - `SourceClip.transitionOut`：剪切点 `clip.end`，另一侧是同轨紧邻的下一个
 *   SourceClip；没有下一个片段时另一侧是**全透明**。
 * - `SourceClip.transitionIn`：剪切点 `clip.start`，另一侧是同轨紧邻的上一个
 *   SourceClip；没有上一个片段时另一侧是**全透明**。
 *
 * 两侧的内容由窗口解析（`core/transitions.ts`）按几何自动取到，所以这里
 * **不存邻居 id** —— 存 id 会引入悬空引用与它的一整套清理逻辑，而片段几何
 * 天然保持相邻（push / trim 都保持）。
 */
export interface TransitionRef {
  /** gl-transitions 条目的 name（如 'CrossZoom'）。渲染侧据此取 GLSL。 */
  defId: string;
  /** 秒。窗口总长；实际生效值还会被两侧片段长度与相邻转场钳制。 */
  duration: number;
  /**
   * 扁平化的标量参数，键由 `effects/transitions/params.ts` 派生
   * （向量会被拆成 `foo#0` / `foo#1`…，于是这里能保持 `Record<string, number>`，
   * 与 EffectInstance.values 的标量约定一致）。
   */
  values: Record<string, number>;
}

/*
 * 抠图 / 四角的类型与出厂值住在 `core/image-fx.ts`（纯数学、零运行时依赖）：
 * 排版文档的 `ImageElement` 也要用同一组字段，而那个模块反过来被本文件 import。
 * 定义放在叶子模块里才不会形成运行时循环。
 */
export type { KeySettings, QuadCorners, CropSettings } from './image-fx';
export { defaultKeySettings, identityQuad, identityCrop, isIdentityCrop } from './image-fx';

/**
 * 视频片段的内嵌音轨设置（v13，仅 `source.type === 'video'` 有意义）。
 *
 * 视频默认参与混流（`core/audio-plan.ts`）；`muted` 在「分离音频」时置 true，
 * 避免与独立音频片段重复出声。`gainDb` / `fadeIn` / `fadeOut` 与 `AudioClip`
 * 同名同义，求值共用 `core/audio-envelope.ts`。
 */
export interface VideoAudioSettings {
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  muted?: boolean;
}

/** 有画面来源，参与合成。被特效影响的就是它。 */
export interface SourceClip extends ClipBase {
  kind: 'source';
  source:
    // 实现 image / algo / solid / text 四种；video 只留类型位置。
    | { type: 'video'; assetId: string; srcIn: number; speed: number }
    | { type: 'image'; assetId: string }
    | AlgoSource
    | { type: 'text'; doc: TypographyDocument }
    | { type: 'solid'; color: string };
  blend: BlendMode;
  opacity: number;
  transform: { x: number; y: number; sx: number; sy: number; rot: number };
  fit: 'contain' | 'cover' | 'stretch';
  /**
   * 简易抠图（色键）。缺省 = 不抠；作用于**本层** alpha（渲染在 placement pass）。
   * 抠掉之后露出来的是什么由普通合成决定（z 序下面的轨道），与特效片段无关。
   */
  key?: KeySettings;
  /**
   * 四角调整（透视变形）。缺省 = 恒等（不调整）；坐标在**层空间**，见 `QuadCorners`。
   * 与 `transform` 复合：变换先摆好图层矩形，四角再把这个矩形透视变形。
   */
  quad?: QuadCorners;
  /**
   * 画面裁剪（v10）：四条边各裁掉多少（源比例 0..1）。缺省 = 不裁。
   *
   * 只收可见窗口，**不缩放内容**；与 `transform` / `quad` 复合（裁剪判定在
   * 源 uv 上，所以四角变形之后裁的仍是「源的那一条边」）。语义与排版元素
   * `ImageElement.crop` 的差别见 `core/image-fx.ts::CropSettings`。
   */
  crop?: CropSettings;
  /** 入场转场（v13）。缺失 = 不设。无前片段时另一侧为全透明。 */
  transitionIn?: TransitionRef;
  /** 出画转场。缺失 = 不设转场。语义与钳制规则见 core/transitions.ts。 */
  transitionOut?: TransitionRef;
  /** 内嵌音轨设置（v13，仅 video 源有意义）。缺失 = 默认（有声、0 dB、不淡）。 */
  audio?: VideoAudioSettings;
  /**
   * 分离出的音频片段 id（v13，仅 video 源）。存在 = 内嵌音轨已被搬走
   * （`audio.muted` 同时为 true），store 靠它做移动 / 裁剪 / 分裂的联动。
   */
  linkedAudioId?: string;
}

/** 特效实例：参考 openmosh EffectInstance，去掉 mosh/volumeLink。 */
export interface EffectInstance {
  instanceId: string;
  defId: string;
  enabled: boolean;
  values: Record<string, number | string>;
  /**
   * **外部输入绑定**（v19）。目前只有一种键：`mask`（见 `core/mask.ts`）。
   *
   * 为什么挂在实例上而不是片段上：同一个特效片段的一条链可以有两个模块各自
   * 吃不同来源的蒙版（「这个用 B 的亮度、那个用 C 的 alpha」）。挂在片段上就
   * 只能有一个，而那正是「局部调色只能有一种形状」的来源。
   *
   * 缺省（没有这个字段）= 不需要蒙版。声明了蒙版的特效（`EffectShaderDef.mask`）
   * 读到的是一张全白占位图 + `u_maskOn = 0`，行为与「没有蒙版」逐像素一致。
   */
  inputs?: Record<string, MaskRef>;
}

/**
 * 无画面来源，把自己插进渲染链。语义 = AE adjustment layer：
 * 只作用于 z 序在它之下所有 SourceClip 的合成结果。
 */
export interface EffectClip extends ClipBase {
  kind: 'effect';
  chain: EffectInstance[];
  /**
   * **影响深度**：只作用于其下方最近的 N 条**启用**视觉轨（1 起数）；
   * `0` / 缺省 = 下方全部（即 v4 的行为）。
   *
   * 语义与实现都在 `engine/stack.ts`（渲染侧的唯一真源）：
   * `N > 0` 时这个片段的作用域变成一段**独立合成的组画面**（从透明起），
   * 特效作用在它上面，再以 normal 贴回下层 —— 所以它看不到作用域之外的轨道。
   * 边界情形（内层特效需要更深的轨道、下方没有启用轨）见那份文件头。
   */
  affectDepth?: number;
  /**
   * **绑定片段**（v11）：把链挂在某个具体的 `SourceClip` 上，作为**那一层自己的
   * 第一步合成** —— 与 z 序无关，也不算作用域。
   *
   * 语义：目标片段先按 placement 画成整帧层，链在这个层上按顺序跑，最后才用
   * 目标片段自己的 blend / opacity 混进 acc。所以它是「这一层的自带滤镜」，
   * 不是 adjustment layer；同一帧里两条特效片段各自绑不同片段也不会互相影响。
   *
   * - 与 `affectDepth` **互斥**。两者同时出现时以绑定为准，`validateProject`
   *   会把 `affectDepth` 丢掉（手改 JSON 不该让工程打不开）。
   * - 目标片段这一帧不在 / 已被删除 ⇒ 这条片段什么都不做（不报错）。
   * - 目标片段处于转场窗口里时，链分别作用在 from 与 to 两层上。
   * - 时间范围仍由这条片段自己的 `[start, end)` 决定，与目标片段无关。
   *
   * 为什么需要它：节拍级的短促特效（0.25s 的频闪）如果只能靠 adjustment layer
   * 表达，就必须为每一段单独开一条轨道 —— 轨道数会随卡点数量线性增长，而
   * 「叠在哪一层上」这个意图在轨道序里反而看不出来。
   */
  boundClipId?: string;
}

/** 声音事件，不参与视觉合成。 */
export interface AudioClip extends ClipBase {
  kind: 'audio';
  assetId: string;
  srcIn: number;
  /**
   * 淡入 / 淡出（秒，v8）。缺省 = 0 = 不淡。
   *
   * 与 `ClipBase.fadeSec`（头尾各淡这么多）**复合**，不是替代：`fadeSec` 是「剪辑点
   * 的防爆音」，这两个是「编排用的淡变」（用户拖片段两端的三角手柄）。求值只有一处
   * ——`core/audio-envelope.ts`——导出混流（`exporters/mixdown.ts`）与预览播放
   * （`audio/player.ts`）都对着它。
   */
  fadeIn?: number;
  fadeOut?: number;
  /**
   * 静态增益（dB，v13）。缺省 0 = 原音量。与 `curves.gain` 相乘，
   * 求值仍在 `core/audio-envelope.ts`（唯一真源）。
   */
  gainDb?: number;
  /** 血缘：这个音频是从哪个视频片段的音轨分离出来的（v13）。解锁后仍保留。 */
  linkedVideoId?: string;
  /**
   * 锁定目标片段 id（v13）。非空 = 跟随该视频片段的移动 / 裁剪 / 分裂 / 删除。
   * 用户在检查器里手动解锁时清空，`linkedVideoId` 保留。
   */
  lockedTo?: string;
}

/* ------------------------------------------------------------- 构造工具 */

export function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // 非安全上下文（如旧版 headless）的兜底；不追求加密强度。
  return 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)) +
    String(Date.now()).slice(-8);
}

export function defaultTransform(): SourceClip['transform'] {
  return { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 };
}

export function defaultProject(name = tr('proj.unnamed')): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    seed: 0xa27a11c,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    duration: 16,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    overlapBehavior: 'reject',
    assets: {},
    tracks: [],
    sections: [],
    beatMarks: [],
  };
}

/* ----------------------------------------------------------- 校验与迁移 */

/**
 * v15 → v16 要改写参数的生成器。
 *
 * 白名单而不是「凡是有 size 的都改」：雪花与佛像也有 `size`，但那个尺寸是
 * 六角格半径 / 复平面方窗，不是「列数」。误改它们会让画面几何直接变样。
 * 这张表是**历史快照**：以后新增的生成器不需要往这里加。
 */
const GRID_SIM_GENERATORS = new Set([
  'game-of-life',
  'langtons-ant',
  'brians-brain',
  'cyclic-ca',
  'wireworld',
  'sandpile',
  'reaction-diffusion',
  'lenia',
]);

class SchemaError extends Error {}

/**
 * 迁移函数表：MIGRATIONS[v] 把版本 v 的工程升到 v+1。
 * 第一天就是空表 + 版本检查——原子写 / 迁移链条在这里生长，不要事后打补丁。
 */
const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  /**
   * v1 → v2：SourceClip 的 text 源从「只留类型位置」（doc: unknown）变成真正的
   * TypographyDocument。
   *
   * v1 里从来没有出现过 text 片段，所以这条迁移在实践中几乎不会命中；写它是因为
   * 「迁移链第一天就有」是项目纪律，而且手改过的 JSON 可能带着
   * 一个形状不对的 doc，不补的话 validateProject 会在更远的地方炸。
   *
   * 注意这里**直接写字面量**而不是调 createTypographyDocument()：那会构成
   * core/schema.ts ↔ typography/document.ts 的运行时循环依赖（后者运行时要用
   * 本文件的 newId）。ESM 能容忍这个循环，但很脆 —— 不值得为省两行字去赌。
   */
  1: (p) => {
    const tracks = (p.tracks as { clips?: unknown[] }[] | undefined) ?? [];
    for (const t of tracks) {
      for (const c of (t.clips ?? []) as {
        kind?: string;
        source?: { type?: string; doc?: unknown };
      }[]) {
        if (c.kind !== 'source' || c.source?.type !== 'text') continue;
        const doc = c.source.doc as TypographyDocument | undefined;
        if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements) || !doc.size) {
          c.source.doc = { size: { w: 1920, h: 1080 }, background: { kind: 'none' }, elements: [], fonts: [] };
        }
      }
    }
    return { ...p, schemaVersion: 2 };
  },

  /**
   * v2 → v3：`SourceClip` 新增可选的 `transitionOut`（出画转场）。
   *
   * **这是一条恒等迁移**：字段可选，v2 的工程读进来天然合法，没有任何要改写的
   * 东西。写它的唯一目的是**把版本号抬上去** —— 于是新版存出的工程被旧版打开时
   * 会走 `versionTooNew` 明确报错，而不是静默忽略 `transitionOut` 再保存
   * （那会把用户的转场悄悄抹掉，是最难查的一类数据丢失）。
   */
  2: (p) => ({ ...p, schemaVersion: 3 }),

  /**
   * v3 → v4：`TextElement.text: string` → `runs: TextRun[]`（富文本）。
   *
   * 这是**真正要改写数据**的一条：v3 的每个文本元素都有一个 `text` 字段，
   * 升上来之后它必须变成只有一个 run 的 `runs`，否则富文本渲染读到 `undefined`
   * 会渲染成空白 —— 用户的标题直接消失，而控制台没有任何报错。
   *
   * 反向不成立：`runs` 表达不了的文字（被删掉的覆盖样式信息）没法回到 `text`。
   * 所以升上来之后不要再降回去。
   */
  3: (p) => {
    const tracks = (p.tracks as { clips?: unknown[] }[] | undefined) ?? [];
    for (const t of tracks) {
      for (const c of (t.clips ?? []) as {
        kind?: string;
        source?: { type?: string; doc?: TypographyDocument };
      }[]) {
        if (c.kind !== 'source' || c.source?.type !== 'text') continue;
        const doc = c.source.doc;
        if (!doc || !Array.isArray(doc.elements)) continue;
        for (const el of doc.elements as unknown as (Record<string, unknown> & { kind?: string })[]) {
          if (el.kind !== 'text') continue;
          if (Array.isArray(el.runs)) {
            delete el.text;
            continue;
          }
          const text = typeof el.text === 'string' ? el.text : '';
          el.runs = [{ text }];
          delete el.text;
        }
        // `groups` 在这一版补齐。**可选字段**，但补上空数组能让
        // 「老工程 vs 新工程」在 stableStringify 下的差异少一处。
        if (!Array.isArray((doc as unknown as { groups?: unknown }).groups)) {
          (doc as unknown as { groups: unknown[] }).groups = [];
        }
      }
    }
    return { ...p, schemaVersion: 4 };
  },

  /**
   * v4 → v5：`EffectClip` 新增可选的 `affectDepth`（影响深度）。
   *
   * **恒等迁移**：缺省 / 0 就是 v4 的行为（作用于下方全部），没有任何要改写的东西。
   * 抬版本号的唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错
   * —— 旧版静默忽略 `affectDepth` 再保存，用户调好的作用域就没了。
   */
  4: (p) => ({ ...p, schemaVersion: 5 }),

  /**
   * v5 → v6：`Project` 新增可选的 `typographyTheme` / `customThemes`
   * （工程级配色方案 + 用户自定义方案）。
   *
   * **恒等迁移**：两个字段都可选，v5 的工程读进来天然合法，没有任何要改写的
   * 东西。抬版本号的唯一目的仍然是让「新版存出的工程被旧版打开」走
   * `versionTooNew` 明确报错 —— 旧版静默忽略 `customThemes` 再保存，
   * 用户自己调的那套配色就没了（静默数据丢失，最难查的一类）。
   */
  5: (p) => ({ ...p, schemaVersion: 6 }),

  /**
   * v6 → v7：`SourceClip` 新增可选的 `key`（简易抠图）/ `quad`（四角调整）。
   *
   * **恒等迁移**：两个字段都可选（缺省语义分别是「不抠」与「不调整」），v6 的
   * 工程读进来天然合法，没有任何要改写的东西。抬版本号的唯一目的仍然是让
   * 「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错 —— 旧版静默忽略这两个
   * 字段再保存，用户调好的抠图与四角就没了（静默数据丢失，最难查的一类）。
   */
  6: (p) => ({ ...p, schemaVersion: 7 }),

  /**
   * v7 → v8：`Project` 新增 `sections`（段落标记）+ `AudioClip` 新增可选的
   * `fadeIn` / `fadeOut`（编排用的淡变）。
   *
   * **恒等迁移**：`sections` 由 `validateProject` 补成 `[]`（见那里的注释），
   * 淡变两个字段可选（缺省 0）。抬版本号的唯一目的仍然是让「新版存出的工程被
   * 旧版打开」走 `versionTooNew` 明确报错 —— 旧版静默忽略 `sections` 再保存，
   * 用户摆好的段落标记就没了（静默数据丢失，最难查的一类）。
   *
   * 这里刻意**不写** `sections: []`：手改过的 v7 JSON 可能已经带着这个字段，
   * 覆盖成空数组等于替用户删数据。
   */
  7: (p) => ({ ...p, schemaVersion: 8 }),

  /**
   * v8 → v9：`Key` 新增可选的 `hOut` / `hIn`（贝塞尔手柄，相对所属 key 的
   * `[秒, 值]` 偏移；见 `core/curve.ts`）。
   *
   * **恒等迁移**：两个字段都可选，v8 的工程读进来天然合法。抬版本号的唯一目的
   * 仍然是让「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错 —— 旧版会
   * 静默忽略这两个字段再保存，用户手调的贝塞尔形状就退化成缺省缓动了
   * （静默数据丢失，最难查的一类）。
   */
  8: (p) => ({ ...p, schemaVersion: 9 }),

  /**
   * v9 → v10：`SourceClip` 新增可选的 `crop`（画面裁剪）。
   *
   * **恒等迁移**：字段可选（缺省 = 不裁），v9 的工程读进来天然合法。抬版本号的
   * 唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错 ——
   * 旧版静默忽略 `crop` 再保存，用户裁好的边就没了（静默数据丢失，最难查的一类）。
   */
  9: (p) => ({ ...p, schemaVersion: 10 }),

  /**
   * v10 → v11：`EffectClip` 新增可选的 `boundClipId`（绑定片段）。
   *
   * **恒等迁移**：字段可选（缺省 = 原来的 adjustment layer 语义），v10 的工程
   * 读进来天然合法。抬版本号的唯一目的仍然是让「新版存出的工程被旧版打开」走
   * `versionTooNew` 明确报错 —— 旧版会把 `boundClipId` 整条忽略（那条特效于是
   * 按 z 序作用于下方所有轨），画面完全变样且没有任何提示。
   */
  10: (p) => ({ ...p, schemaVersion: 11 }),

  /**
   * v11 → v12：**把 Agent 对话历史从工程里赶出去**。
   *
   * 历史不再属于 `project.json`，而是工程目录里的 `agent/sessions/<id>.json`
   * （`project/agent-history.ts`）。这条迁移只做一件事：把旧字段删掉。
   *
   * 旧数据**不抢救**：工程还没发布，迁移里多一段「把会话搬去文件」的代码
   * 只会让这条已经在磁盘上消失的路径长期留在代码里，而它没有任何真实用户。
   * 副作用是可接受的：升级后的旧工程打开时历史是空的，工程内容一字不差。
   */
  11: (p) => {
    const next = { ...p, schemaVersion: 12 } as Record<string, unknown>;
    delete next.agentSessions;
    return next;
  },

  /**
   * v12 → v13：`Asset` 新增预剪辑范围 / `hasAudio`，`SourceClip` 新增
   * `transitionIn` / `audio` / `linkedAudioId`，`AudioClip` 新增
   * `gainDb` / `linkedVideoId` / `lockedTo`。
   *
   * **恒等迁移**：全部可选（缺省语义分别是「没保存范围」「有声」「无入场转场」
   * 「0 dB」「无链接」），v12 的工程读进来天然合法。抬版本号的唯一目的仍然是让
   * 「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错 —— 旧版静默忽略
   * 这些字段再保存，用户存好的预剪辑范围与入场转场就没了（静默数据丢失）。
   */
  12: (p) => ({ ...p, schemaVersion: 13 }),

  /**
   * v13 → v14：视频片段支持**变速关键帧**（`clip.curves.speed`，值可负 = 倒放）。
   *
   * **恒等迁移**：曲线本来就存在于 `curves` 里（v13 及更早已有这个容器），
   * 没有任何要改写的东西。抬版本号的唯一目的仍然是让「新版存出的工程被旧版
   * 打开」走 `versionTooNew` 明确报错 —— 旧版会静默忽略 `curves.speed` 再保存，
   * 用户排好的变速与倒放整段消失（静默数据丢失，最难查的一类）。
   */
  13: (p) => ({ ...p, schemaVersion: 14 }),

  /**
   * v14 → v15：`VisualTrack` 新增可选的 `muted`（轨道静音，只关内嵌音轨）。
   *
   * **恒等迁移**：字段可选（缺省 = 有声），v14 的工程读进来天然合法。抬版本号
   * 的唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错
   * —— 旧版会静默忽略 `muted` 再保存，用户静音掉的轨道在导出里又出声了
   * （静默数据丢失，且只有听得出）。
   */
  14: (p) => ({ ...p, schemaVersion: 15 }),

  /**
   * v15 → v16：网格类模拟的 `size`（正方形）拆成 `width` / `height`（列 × 行）。
   *
   * **真迁移，不是恒等**：`size` 这个键在新参数表里已经不存在，逐键合并会把它
   * 丢掉、退回默认值 —— 用户把网格从 112 调到 224 之后存的工程会静默变回 112。
   * 所以这里必须把它读出来，两个轴都写成同一个值（老语义就是正方形）。
   *
   * 只改**确实有网格的那批生成器**（白名单在下方）。雪花与佛像也各有一个
   * `size`，但方形是它们模型的一部分（六角格 / 复平面），不在此列。
   */
  15: (p) => {
    const tracks = Array.isArray(p.tracks) ? (p.tracks as unknown[]) : [];
    const next = tracks.map((raw) => {
      const track = raw as { clips?: unknown[] };
      if (!Array.isArray(track?.clips)) return raw;
      let changed = false;
      const clips = track.clips.map((rawClip) => {
        const clip = rawClip as {
          kind?: string;
          source?: { type?: string; generator?: string; params?: Record<string, unknown> };
        };
        if (clip?.kind !== 'source' || clip.source?.type !== 'algo') return rawClip;
        if (!GRID_SIM_GENERATORS.has(String(clip.source.generator))) return rawClip;
        const params = clip.source.params;
        if (!params) return rawClip;
        const size = Number(params.size);
        if (!Number.isFinite(size)) return rawClip;
        // 已经是新格式（手改 / 半迁移）就不要再覆盖用户给的宽高
        if (params.width !== undefined || params.height !== undefined) return rawClip;
        const { size: _old, ...rest } = params;
        changed = true;
        return {
          ...clip,
          source: { ...clip.source, params: { ...rest, width: size, height: size } },
        };
      });
      return changed ? { ...track, clips } : raw;
    });
    return { ...p, tracks: next, schemaVersion: 16 };
  },

  /**
   * v16 → v17：排版元素动画从 `preset` / `custom`（CSS 文本）转成结构化轨道
   * （`kind: 'tracks'`）。
   *
   * **真迁移**：关键帧面板只编辑结构化轨道，旧形态读进来在面板里就是一行
   * 「只读 + 转换」—— 用户打开旧工程会发现自己的动画改不了。所以在这里一次
   * 转干净（用户 2026-10-24 拍板「打开即迁移」）。
   *
   * 转换本身是纯函数（`typography/animation-migrate.ts`），与渲染共用同一套
   * `@keyframes` 解析与属性闸门。**转换后 `docHash` 会变** ⇒ 旧的光栅缓存自然
   * 失效；那是会话级 LRU，代价是旧工程首次打开时重烘几帧。
   */
  16: (p) => {
    const { project, report } = migrateProjectAnimations(p);
    if (report.dropAnimations.length || report.dropProps.length) {
      // 只报 id 与属性名，不打印整份文档（那会淹没控制台，也不该把用户内容写进日志）。
      console.warn('[schema] v17 排版动画迁移丢弃了部分内容', {
        animations: report.dropAnimations,
        props: report.dropProps,
      });
    }
    return { ...project, schemaVersion: 17 };
  },

  /**
   * v17 → v18：排版动画的**作用层**从「隐式 = 内容层」变成显式字段。
   *
   * 缺省改成了 `box`（整块一起动）—— 因为「给文本框设个旋转」在所有既有工具里
   * 都是整块转，缺省 `content` 才是那个会被当成 bug 的行为。代价是 v17 及以前
   * 的工程里那些**没写键**的动画会被当成 `box`，所以必须在这里把它们显式钉成
   * `content`，否则老工程一打开动画就全变样了。
   *
   * 转换本身是纯函数（`typography/animation-migrate.ts::pinAnimationTargets`），
   * 幂等；没有排版文档的工程原样返回。
   */
  17: (p) => {
    const { project } = pinAnimationTargets(p);
    return { ...project, schemaVersion: 18 };
  },

  /**
   * v18 → v19：`EffectInstance` 新增可选的 `inputs`（外部输入绑定，目前只有
   * `mask` 一种）。
   *
   * **恒等迁移**：字段可选（缺省 = 不吃蒙版），v18 的工程读进来天然合法。
   * 抬版本号的唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew`
   * 明确报错 —— 旧版会静默忽略 `inputs` 再保存，用户接好的蒙版引用整批消失，
   * 而画面上只表现为「局部调色没了」。环 / 悬空引用由 `validateProject`
   * 那一趟清（`core/mask.ts::sanitizeMaskInputs`）。
   */
  18: (p) => ({ ...p, schemaVersion: 19 }),

  /**
   * v19 → v20：`Project` 新增可选的 `modulators`，`ClipBase` 新增可选的 `mods`
   * （调制器 + 参数上的调制槽）。
   *
   * **恒等迁移**：两个字段都可选，v19 的工程读进来天然合法，求值路径也逐字节
   * 相同（没有 `mods` 时 `resolveParam` 只做原来那一步曲线求值）。抬版本号的
   * 唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew` 明确报错 ——
   * 旧版会静默忽略这两个字段再保存，用户调好的调制整批消失，而画面上只表现为
   * 「那些参数又不动了」。
   */
  19: (p) => ({ ...p, schemaVersion: 20 }),

  /**
   * v20 → v21：`Project` 新增 `beatMarks`（手动节奏点，打点计时）。
   *
   * **恒等迁移**：字段由 `validateProject` 补成 `[]`（与 `sections` 同一条）。
   * 抬版本号的唯一目的仍然是让「新版存出的工程被旧版打开」走 `versionTooNew`
   * 明确报错 —— 旧版会静默忽略 `beatMarks` 再保存，用户跟着音乐打的一整轮
   * 节奏点就没了（静默数据丢失，且只有再点一遍才发现）。
   */
  20: (p) => ({ ...p, schemaVersion: 21 }),
};

export function migrateProject(raw: Record<string, unknown>): Project {
  const rawV = raw.schemaVersion;
  if (typeof rawV !== 'number') throw new SchemaError(tr('err.schema.missingVersion'));
  if (rawV > SCHEMA_VERSION) {
    throw new SchemaError(tr('err.schema.versionTooNew', { found: rawV, supported: SCHEMA_VERSION }));
  }
  let v = rawV;
  let cur = raw;
  while (v < SCHEMA_VERSION) {
    const mig = MIGRATIONS[v];
    if (!mig) throw new SchemaError(tr('err.schema.missingMigration', { version: v }));
    cur = mig(cur);
    v = cur.schemaVersion as number;
  }
  return validateProject(cur);
}

export function validateProject(raw: unknown): Project {
  const p = raw as Project;
  if (!p || typeof p !== 'object') throw new SchemaError(tr('err.schema.notObject'));
  if (typeof p.name !== 'string') throw new SchemaError(tr('err.schema.missingName'));
  if (typeof p.fps !== 'number' || p.fps <= 0) throw new SchemaError(tr('err.schema.badFps'));
  if (!p.resolution || p.resolution.w <= 0 || p.resolution.h <= 0) {
    throw new SchemaError(tr('err.schema.badResolution'));
  }
  if (typeof p.duration !== 'number' || p.duration <= 0) throw new SchemaError(tr('err.schema.badDuration'));
  if (!p.beatGrid || p.beatGrid.bpm <= 0 || p.beatGrid.beatsPerBar < 1) {
    throw new SchemaError(tr('err.schema.badBeatGrid'));
  }
  if (typeof p.seed !== 'number') throw new SchemaError(tr('err.schema.badSeed'));
  if (p.overlapBehavior !== 'push' && p.overlapBehavior !== 'reject' && p.overlapBehavior !== 'trim') {
    throw new SchemaError(tr('err.schema.badOverlap'));
  }
  if (!p.assets || typeof p.assets !== 'object') throw new SchemaError(tr('err.schema.badAssets'));
  if (!Array.isArray(p.tracks)) throw new SchemaError(tr('err.schema.badTracks'));
  /*
   * 素材上的预剪辑范围（v13）。与段落 / 配色同一条纪律：**坏条目逐条丢弃**，
   * 工程必须打得开。范围是「重放 In/Out」的便利数据，为它让整份工程打不开
   * 不成比例；而坏 id 留在 `activeRangeId` 里会让双击插入静默落回整段素材。
   */
  for (const asset of Object.values(p.assets) as Asset[]) sanitizeAssetRanges(asset);
  /*
   * 工程级配色方案（v6 的两个可选字段）。**坏数据回落而不是抛错** ——
   * 工程必须打得开，颜色这种事不值得让整份工程打不开。
   *   - customThemes：逐条校验（`sanitizeCustomThemes`），坏条目整条丢；
   *   - typographyTheme：引用了一个不存在的方案 id（自定义方案被手删 / 工程
   *     来自更早的版本）→ 删掉这个键，读时自然回落默认方案。
   */
  const custom = sanitizeCustomThemes((p as { customThemes?: unknown }).customThemes);
  if (custom.length) (p as { customThemes?: TypographyTheme[] }).customThemes = custom;
  else delete (p as { customThemes?: TypographyTheme[] }).customThemes;
  const declared = (p as { typographyTheme?: unknown }).typographyTheme;
  if (declared !== undefined) {
    if (typeof declared === 'string' && isKnownTheme(declared, custom)) {
      (p as { typographyTheme?: string }).typographyTheme = declared;
    } else {
      delete (p as { typographyTheme?: string }).typographyTheme;
    }
  }
  /*
   * 段落标记（v8）。与上面两条同一条纪律：坏条目逐条丢弃，工程必须打得开。
   * 缺字段（v7 工程、手改 JSON）补成 `[]` —— **写成必填**是为了让读取方不必
   * 到处 `?? []`；那正是「某处忘了兜底 → 时间轴整块空白」的来源。
   */
  p.sections = sanitizeSections((p as { sections?: unknown }).sections);
  /*
   * 手动节奏点（v21）。与段落同一条纪律：坏条目逐条丢弃，工程必须打得开；
   * 缺字段补成 `[]`（写成必填，读取方不必到处 `?? []`）。
   */
  p.beatMarks = sanitizeBeatMarks((p as { beatMarks?: unknown }).beatMarks);
  /*
   * 调制器（v20）。清洗必须在片段 `mods` 之前：后者要按前者的 id 集合判悬空。
   * 空表就把字段删掉 —— 留一个 `[]` 会让每份工程文件都多一行噪音，
   * 而「有没有调制器」的判据本来就是 `undefined` 与空数组等价。
   */
  const modulators = sanitizeModulators((p as { modulators?: unknown }).modulators);
  if (modulators.length > 0) p.modulators = modulators;
  else delete p.modulators;
  const mods = modTable(modulators);
  /*
   * v12 起历史不在工程里。`migrateProject` 只在 v11→v12 那一步删它，
   * 而手改过的 JSON（或从别处拷来的片段）可能带着这个键 —— 留着的话它会被
   * 原样写回磁盘，工程文件里就永远挂着一坨没人读的聊天记录。删掉。
   */
  delete (p as { agentSessions?: unknown }).agentSessions;
  /*
   * 顺手修掉历史数据里的「主题色引用跑进非排版颜色参数」。
   *
   * 取色卡对所有颜色入口都提供主题色（`@accent1`），但只有排版文档会在渲染时
   * 解析引用；算法参数 / 特效参数 / 纯色片段的颜色直接进 `hexToRgba()`，
   * 那里的坏颜色回退是**品红**。用户挑一个主题色，画面整片变品红，
   * 而参数表里存的是一串 `@accent1` —— 从界面上完全看不出发生了什么。
   *
   * 新数据由检查器在**写入时**解析（见 `ui/Inspector.svelte` 的三处取色），
   * 这里只补打开工程这一条：老工程存下来的引用要变成裸 hex，否则它们永远画品红。
   */
  resolveStrayThemeRefs(p, custom);

  // 循环变量刻意叫 tk 而不是 tr：`tr` 是翻译函数的专名（i18n/index.svelte.ts），
  // 同名会把下面那两次取词整成「tr is not a function」。
  for (const tk of p.tracks as { kind: string; clips: unknown; muted?: unknown }[]) {
    if (tk.kind !== 'visual' && tk.kind !== 'audio') {
      throw new SchemaError(tr('err.schema.unknownTrackKind', { kind: String(tk.kind) }));
    }
    if (!Array.isArray(tk.clips)) throw new SchemaError(tr('err.schema.trackMissingClips'));
    /*
     * 轨道静音（v15）：只认 `true`。手改 JSON 写出 `"yes"` / `1` 时删字段回到
     * 「有声」—— 与「静音」相比，「意外没声」更容易被当成 bug 报上来，而
     * 「意外有声」多半就被当成自己忘了。音频轨不认这个字段（它的 `enabled`
     * 已经是喇叭语义），留着会让两个开关描述同一件事。
     */
    if (tk.muted !== undefined && (tk.kind !== 'visual' || tk.muted !== true)) delete tk.muted;
    for (const c of tk.clips as AnyClip[]) validateClip(c, tk.kind);
  }
  /*
   * 悬空链接清扫（v13）。链接字段是「跟随另一条片段」的指令，指向不存在的
   * 片段时表现是「拖视频时音频不动 / 锁定的音频永远找不到主人」，而且没有任何
   * 报错。统一在打开时清掉，让数据回到「没有链接」这个能继续工作的状态。
   *
   * 只清同一工程内可解析的引用；删除视频时删除音频是 store 的事（见
   * `ProjectStore` 的链接同步）——这里兜的是手改 JSON 与历史数据。
   */
  const clipsById = new Map<string, AnyClip>();
  for (const tk of p.tracks as Track[]) for (const c of tk.clips) clipsById.set(c.id, c);
  /*
   * 蒙版引用（v19）。与上面的链接清扫同一趟、同一纪律：形状坏 / 目标不在了
   * 一律回落，工程必须打得开；成环的引用在写入口就该被拒，这里兜的是手改 JSON
   * 与「两版之间拼接」的那类数据（见 `core/mask.ts`）。
   */
  sanitizeMaskInputs(p);
  /*
   * `asset` 型参数（v21 起，第一个使用者是粒子）。与蒙版同一条纪律：
   * 悬空 / 类型坏的引用一律置**空串**（不是删键 —— 删键会让读取方回落
   * def 默认值，而空串才是「明确没绑」）。不抬 SCHEMA_VERSION：这些是
   * `params` 里的可选字符串键，运行期逐键 `?? defaultValue` 合并。
   */
  sanitizeAssetParams(p as unknown as Parameters<typeof sanitizeAssetParams>[0]);
  /*
   * 片段级调制槽（v20）。与蒙版引用同一趟、同一纪律：坏引用 / 坏形状逐槽丢弃，
   * 工程必须打得开。这里能清是因为调制器表已经建好了（见上面那段）。
   */
  for (const c of clipsById.values()) {
    const cleaned = sanitizeClipMods(c.mods, mods);
    if (cleaned) c.mods = cleaned;
    else delete c.mods;
  }
  for (const c of clipsById.values()) {
    if (c.kind === 'source') {
      if (c.linkedAudioId !== undefined && clipsById.get(c.linkedAudioId)?.kind !== 'audio') {
        delete c.linkedAudioId;
      }
    } else if (c.kind === 'audio') {
      if (c.linkedVideoId !== undefined) {
        const v = clipsById.get(c.linkedVideoId);
        if (!v || v.kind !== 'source' || v.source.type !== 'video') delete c.linkedVideoId;
      }
      if (c.lockedTo !== undefined) {
        const v = clipsById.get(c.lockedTo);
        if (!v || v.kind !== 'source' || v.source.type !== 'video') delete c.lockedTo;
      }
    }
  }
  return p;
}

/** 预剪辑范围的清洗（就地改）。缺省 / 坏值都不抛 —— 见调用点的注释。 */
function sanitizeAssetRanges(a: Asset): void {
  const raw = (a as { ranges?: unknown }).ranges;
  if (!Array.isArray(raw)) {
    delete (a as { ranges?: unknown }).ranges;
  } else {
    const limit = typeof a.durationSec === 'number' && a.durationSec > 0 ? a.durationSec : null;
    const out: AssetTrimRange[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Partial<AssetTrimRange>;
      if (typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
      const inSec = Number(r.inSec);
      const outSec = Number(r.outSec);
      if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) continue;
      const lo = Math.max(0, inSec);
      const hi = limit === null ? outSec : Math.min(limit, outSec);
      if (!(hi > lo)) continue;
      seen.add(r.id);
      out.push({
        id: r.id,
        name: typeof r.name === 'string' && r.name ? r.name : tr('preclip.rangeDefault', { n: out.length + 1 }),
        inSec: lo,
        outSec: hi,
      });
    }
    if (out.length) (a as { ranges?: AssetTrimRange[] }).ranges = out;
    else delete (a as { ranges?: unknown }).ranges;
  }

  const ranges = (a as { ranges?: AssetTrimRange[] }).ranges;
  const active = (a as { activeRangeId?: unknown }).activeRangeId;
  if (typeof active !== 'string' || !ranges?.some((r) => r.id === active)) {
    delete (a as { activeRangeId?: unknown }).activeRangeId;
  }
  const hasAudio = (a as { hasAudio?: unknown }).hasAudio;
  if (hasAudio !== undefined && typeof hasAudio !== 'boolean') delete (a as { hasAudio?: unknown }).hasAudio;
}

/**
 * 把「跑进非排版颜色字段的主题色引用」解析成裸 hex（就地改）。
 *
 * 只碰**能解析成合法槽位/变体**的字符串（`parseThemeRef` 非 null）：
 * 自定义文本参数里手打的 `@foo` 之类必须原样保留 —— 那是用户内容，不是坏颜色。
 *
 * 只覆盖三处：纯色片段的 `color`、算法片段的 `params`、特效实例的 `values`。
 * **排版文档里的引用一个字都不能动** —— 那是「换配色方案跟着变」的唯一依据。
 */
function resolveStrayThemeRefs(p: Project, custom: readonly TypographyTheme[]): void {
  const resolve = (v: unknown): unknown =>
    typeof v === 'string' && parseThemeRef(v) ? resolveThemeColor(v, p.typographyTheme, custom) : v;

  for (const tk of p.tracks as Track[]) {
    if (tk.kind !== 'visual') continue;
    for (const c of tk.clips) {
      if (c.kind === 'source') {
        if (c.source.type === 'solid') {
          c.source.color = String(resolve(c.source.color));
        } else if (c.source.type === 'algo') {
          for (const key of Object.keys(c.source.params)) {
            c.source.params[key] = resolve(c.source.params[key]) as number | string;
          }
        }
      } else if (c.kind === 'effect') {
        for (const inst of c.chain) {
          for (const key of Object.keys(inst.values)) {
            inst.values[key] = resolve(inst.values[key]) as number | string;
          }
        }
      }
    }
  }
}

function validateClip(c: AnyClip, trackKind: Track['kind']): void {
  if (typeof c.id !== 'string' || !c.id) throw new SchemaError(tr('err.schema.clipMissingId'));
  if (!(c.start >= 0) || !(c.end > c.start)) {
    throw new SchemaError(tr('err.schema.clipBadSpan', { id: c.id }));
  }
  if (typeof c.fadeSec !== 'number' || c.fadeSec < 0) {
    throw new SchemaError(tr('err.schema.clipBadFade', { id: c.id }));
  }
  if (!c.curves || typeof c.curves !== 'object') {
    throw new SchemaError(tr('err.schema.clipBadCurves', { id: c.id }));
  }
  if (trackKind === 'audio') {
    if (c.kind !== 'audio') throw new SchemaError(tr('err.schema.audioTrackHasNonAudio'));
    /*
     * 淡变（v8）**钳制而不抛**：坏值的表现是「听不见」或「爆音」，不是数据丢失。
     * 为它让整份工程打不开不成比例。负秒 / NaN 一律归 0，超过片段长度的由
     * `core/audio-envelope.ts` 按比例收缩两个淡区（与 `fadeSec` 同一套钳制口径）。
     */
    const a = c as AudioClip;
    for (const key of ['fadeIn', 'fadeOut'] as const) {
      if (a[key] === undefined) continue;
      const v = Number(a[key]);
      a[key] = Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    /* 静态增益（v13）：钳到 [-60, +12] dB，NaN 归 0（原音量）。 */
    if (a.gainDb !== undefined) {
      const v = Number(a.gainDb);
      a.gainDb = Number.isFinite(v) ? Math.min(12, Math.max(-60, v)) : 0;
    }
  } else {
    if (c.kind !== 'source' && c.kind !== 'effect') {
      throw new SchemaError(tr('err.schema.visualTrackHasNonVisual'));
    }
    if (c.kind === 'effect') {
      const fx = c as EffectClip;
      if (!Array.isArray(fx.chain)) {
        throw new SchemaError(tr('err.schema.effectClipMissingChain', { id: c.id }));
      }
      // 影响深度是非负整数（0 = 下方全部）。手改 JSON 写出 2.5 / -1 时在打开时报错，
      // 而不是让它一路穿透到 `buildStack` 里以「数到第 N 条轨」的语义变成别的东西。
      if (fx.affectDepth !== undefined && (!Number.isInteger(fx.affectDepth) || fx.affectDepth < 0)) {
        throw new SchemaError(tr('err.schema.effectBadAffectDepth', { id: c.id }));
      }
      /*
       * 绑定片段（v11）。**两种作用方式互斥**：绑定 = 「这一层的滤镜」，
       * 影响深度 = 「对下面几条轨的画面做一道处理」。同时存在时以绑定为准，
       * 把 affectDepth 丢掉 —— 这与「坏数据回落、工程必须打得开」同一条纪律
       * （手改 JSON 写出两个字段是数据矛盾，不是会传染的结构错误）。
       */
      if (fx.boundClipId !== undefined) {
        if (typeof fx.boundClipId !== 'string' || !fx.boundClipId) {
          throw new SchemaError(tr('err.schema.effectBadBoundClip', { id: c.id }));
        }
        delete fx.affectDepth;
      }
    }
    // text 源的最小校验。validateProject 历史上不深校验 source 字段，
    // 手改 JSON 会一路静默穿透到光栅化，在那里炸得莫名其妙。
    if (c.kind === 'source') {
      const src = (c as SourceClip).source as { type?: string; doc?: unknown } | undefined;
      if (src?.type === 'text') {
        const doc = src.doc as TypographyDocument | undefined;
        if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements)) {
          throw new SchemaError(tr('err.schema.typographyBadDoc', { id: c.id }));
        }
        if (!doc.size || !(doc.size.w > 0) || !(doc.size.h > 0)) {
          throw new SchemaError(tr('err.schema.typographyBadSize', { id: c.id }));
        }
        // 富文本的**最小结构校验**：文本元素必须有 runs 数组。
        // 漏了这一步的话，手改过的 JSON（或想当然是 v3 的旧文件）会一路穿透到
        // 渲染期，那里读到 undefined 只会渲染出空白 —— 没有报错、也很难定位。
        for (const el of doc.elements as { kind?: string; runs?: unknown }[]) {
          if (el?.kind === 'text' && !Array.isArray(el.runs)) {
            throw new SchemaError(tr('err.schema.typographyBadTextRuns', { id: c.id }));
          }
        }
      }
      // 转场同样是「形状不对就穿透到渲染期」的那一类，在这里挡住。
      // v13 起两端各一个（入场 / 出场），共用同一套形状校验。
      for (const trRef of [(c as SourceClip).transitionIn, (c as SourceClip).transitionOut]) {
        if (trRef === undefined) continue;
        if (!trRef || typeof trRef !== 'object' || typeof trRef.defId !== 'string' || !trRef.defId) {
          throw new SchemaError(tr('err.schema.transitionBadDefId', { id: c.id }));
        }
        if (typeof trRef.duration !== 'number' || !Number.isFinite(trRef.duration) || trRef.duration <= 0) {
          throw new SchemaError(tr('err.schema.transitionBadDuration', { id: c.id }));
        }
        if (!trRef.values || typeof trRef.values !== 'object') {
          throw new SchemaError(tr('err.schema.transitionBadValues', { id: c.id }));
        }
      }
      /*
       * 内嵌音轨设置（v13）。只有 video 源有意义：其他源带着这两个字段是
       * 数据矛盾（手改 JSON / 从视频片段改源），删掉而不是让渲染侧去猜。
       */
      const src2 = (c as SourceClip).source;
      if (src2?.type === 'video') {
        /*
         * 变速（v14）：`source.speed` 必须是**正**有限数 —— 倒放走
         * `curves.speed`（关键帧可以取负）。坏值归 1，而不是让它一路穿透到
         * `core/speed.ts`：NaN 会让这一层的素材时间全是 NaN，画面整块消失
         * 且没有任何报错。
         */
        const sp = Number(src2.speed);
        src2.speed = Number.isFinite(sp) && sp > 0 ? Math.min(100, Math.max(0.05, sp)) : 1;
        const va = (c as SourceClip).audio;
        if (va !== undefined) {
          if (!va || typeof va !== 'object' || Array.isArray(va)) {
            delete (c as SourceClip).audio;
          } else {
            if (va.muted !== undefined && typeof va.muted !== 'boolean') delete va.muted;
            if (va.gainDb !== undefined) {
              const v = Number(va.gainDb);
              va.gainDb = Number.isFinite(v) ? Math.min(12, Math.max(-60, v)) : 0;
            }
            for (const key of ['fadeIn', 'fadeOut'] as const) {
              if (va[key] === undefined) continue;
              const v = Number(va[key]);
              va[key] = Number.isFinite(v) ? Math.max(0, v) : 0;
            }
            if (!('gainDb' in va || 'fadeIn' in va || 'fadeOut' in va || 'muted' in va)) {
              delete (c as SourceClip).audio;
            }
          }
        }
        if ((c as SourceClip).linkedAudioId !== undefined &&
            (typeof (c as SourceClip).linkedAudioId !== 'string' || !(c as SourceClip).linkedAudioId)) {
          delete (c as SourceClip).linkedAudioId;
        }
      } else {
        delete (c as SourceClip).audio;
        delete (c as SourceClip).linkedAudioId;
      }
      /*
       * 抠图 / 四角的形状校验。它们是「形状不对就穿透到渲染期」的那一类：
       * 渲染侧拿到坏颜色只会静默画成品红、拿到 NaN 容差会画出全透明或全不透明，
       * 没有报错、也很难定位。所以手改 JSON 的坏形状必须在打开时就挡住。
       */
      const key = (c as SourceClip).key;
      if (key !== undefined && !isValidKeySettings(key)) {
        throw new SchemaError(tr('err.schema.badKeySettings', { id: c.id }));
      }
      const quad = (c as SourceClip).quad;
      if (quad !== undefined && !isValidQuad(quad)) {
        throw new SchemaError(tr('err.schema.badQuad', { id: c.id }));
      }
      /*
       * 裁剪的形状校验。同样是「坏形状会穿透到渲染期」的那一类：越界的裁剪量在
       * 着色器里只会让整层变成透明 —— 没有报错，看起来像「片段丢了」。
       */
      const crop = (c as SourceClip).crop;
      if (crop !== undefined && !isValidCrop(crop)) {
        throw new SchemaError(tr('err.schema.badCrop', { id: c.id }));
      }
    }
  }
}

/** 与 UI 取色器 / CSS 的产物一致：必须带 `#`，六位十六进制（大小写不限）。 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 0..1 的有限数。`typeof NaN === 'number'` 但 `NaN >= 0` 为假，所以下界判断一并挡掉。 */
function isUnitNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 形状不对一律 false —— 调用点只关心「能不能进渲染期」，不关心具体哪里错。 */
function isValidKeySettings(k: unknown): k is KeySettings {
  if (!k || typeof k !== 'object' || Array.isArray(k)) return false;
  const s = k as Partial<KeySettings>;
  return (
    typeof s.color === 'string' &&
    HEX_COLOR.test(s.color) &&
    isUnitNumber(s.tolerance) &&
    isUnitNumber(s.softness) &&
    isUnitNumber(s.spill)
  );
}

/** 一个角：长度 2 的数组 + 两个有限数（`Infinity` / `NaN` 都不能进单应）。 */
function isCorner(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function isValidQuad(q: unknown): q is QuadCorners {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
  const c = q as Partial<QuadCorners>;
  return isCorner(c.tl) && isCorner(c.tr) && isCorner(c.br) && isCorner(c.bl);
}

/** 深拷贝（工程是纯 JSON，structuredClone 足够）。 */
export function cloneProject(p: Project): Project {
  return structuredClone(p);
}
