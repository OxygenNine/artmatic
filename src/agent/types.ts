/**
 * types.ts — 控制平面的契约类型（方案：`docs/agent-control-plane.md` §3）。
 *
 * 这一层是 **agent 的唯一操作面**：读场景 / 写工程 / 出图 / 导出 / 排版 / 插件。
 * 它不 import `ui/` —— 运行期实例（当前工程的 `ProjectStore`、`Renderer`、
 * 素材仓、播放头、插件宿主）全部走注入的 `ControlContext`（见本文件末尾），
 * 与 `platform/` 的解耦是同一手法（AGENTS 硬约束 1.5）。
 *
 * ## 关于 `t` 的单位：秒（吸附到帧栅格）
 *
 * 方案 §9.3 把控制平面的 `t` 称作「帧号」，但同一条方案 §5.3 给的吸附公式
 * `round(t·fps)/fps`、以及引擎全链路的 `t`（`engine/clock.ts` 的
 * `timeOf(frame, fps) = frame/fps`、`Renderer.renderFrame(project, t)`）都说明
 * `t` 是**秒**。这里跟引擎与 §5.3 对齐：说错单位的代价是「agent 算出的反馈帧
 * 与导出帧不是同一帧」，而且**不报错**。
 *
 * 判据：**凡是要帧号的地方，字段名一律带 `Frame`**（`frameRange.from` /
 * `frameRange.to` / `frameStep`）；**`t` 永远是秒**。
 *
 * ## 关于返回值：统一 `{ ok, data } | { ok, error }`，不抛异常
 *
 * 异常跨传输层会丢掉类型（CDP 传过来是一句字符串），agent 拿不到可判别的
 * `code`。所以控制平面的每个方法都返回 `ControlResult`，`code` 是稳定的
 * 机器可读枚举，`message` 给人看。
 */

import type { Curve } from '../core/curve';
import type { MaskRef } from '../core/mask';
import type { BlendMode } from '../core/schema';
import type { AlignAxis } from '../typography/geometry';
import type { UiContextSnapshot } from './context';
import type { PluginCheckResult } from './plugin-check';

/* ------------------------------------------------------------------ 结果 */

/**
 * 控制平面 API 版本。网关握手时校验主版本，不匹配就拒绝。
 *
 * v2（2026-10-18）：文本片段的 `source.doc` 从「整份文档」改成摘要
 * （`ClipTextSummary`），详情走 `getTypographyDoc`。这是**读形状变更**，
 * 旧客户端拿到的字段会变成 undefined —— 所以要抬版本而不是静默改。
 *
 * v3（2026-10-19）：场景快照多了 `sections`（段落标记），
 * audio 片段多了 `fadeIn` / `fadeOut`。**只加字段**，但「工程结构里多了一类
 * 用户可编辑的实体」值得让网关照版本号判断能力，而不是让旧客户端以为
 * 时间轴上只有片段。
 *
 * v4（2026-10-21）：排版写入的**返回形状**变了 —— 不再是 `{ changed }`，而是
 * 回显改后的元素（`element` / `elements`）；新增批量写、`typo_measure`、
 * `only` 隔离渲染与 `sceneVersion` 读接口。旧客户端读不到这些字段不会崩，
 * 但会以为「写操作没有回执」，所以按契约变更抬版本。
 *
 * v5（2026-11-06）：场景快照多了 `beatMarks`（手动节奏点 / 打点计时），
 * 并新增 `set_beat_marks` 写接口。与 v3 的段落同一条理由：工程结构里多了一类
 * 用户可编辑的实体，旧客户端看到「时间轴上没有别的标记」会漏掉它。
 */
export const CONTROL_API_VERSION = 5;

export type ControlErrorCode =
  /** 参数形状不对 / 越界 / 枚举里没有这个 id。 */
  | 'invalid-argument'
  /** 引用的东西不存在（clipId / trackId / defId / pluginId）。 */
  | 'not-found'
  /** 这个对象做不到这件事（如给 solid 源设 generator 参数）。 */
  | 'unsupported'
  /** 落点被重叠策略拒收（`overlapBehavior: 'reject'`）。 */
  | 'conflict'
  /** 一份工程都没打开（关闭全部工程之后就是这个状态）。 */
  | 'no-project'
  /** 渲染服务还没装配好（预览 canvas 还没挂载）。 */
  | 'not-ready'
  /** 已经有一个导出在跑。 */
  | 'busy'
  /** 导出被 AbortSignal 取消。 */
  | 'cancelled'
  /** 写盘 / 执行代码需要用户确认（插件安装）。 */
  | 'needs-approval'
  /** 兜底：不该发生。 */
  | 'internal';

export interface ControlError {
  code: ControlErrorCode;
  /** 给人看的一句话。 */
  message: string;
  /** 可选的机器可读细节（校验失败时的字段名、越界时的上下界等）。 */
  detail?: unknown;
}

export type ControlResult<T> = { ok: true; data: T } | { ok: false; error: ControlError };

export function ok<T>(data: T): ControlResult<T> {
  return { ok: true, data };
}

export function fail(code: ControlErrorCode, message: string, detail?: unknown): ControlResult<never> {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}

/** 控制平面内部抛这个，装配层统一转成 `ControlResult`。 */
export class ControlFailure extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ControlFailure';
  }
}

/* -------------------------------------------------------------------- 读 */

export interface DescribeInfo {
  apiVersion: number;
  appVersion: string;
  schemaVersion: number;
  /** 帧率。`t` 的吸附栅格就是它。 */
  fps: number;
  resolution: { w: number; h: number };
  /** 秒。 */
  duration: number;
}

export type SceneDetail = 'ids' | 'full';

export type ClipKind = 'source' | 'effect' | 'audio';

export type SourceType = 'video' | 'image' | 'algo' | 'text' | 'solid';

/**
 * 文本片段的摘要（v2 起 `ClipSourceView` 里给的就是它）。
 *
 * 整份 `TypographyDocument` 有元素、富文本 runs、动画、组合表 —— 一个工程里
 * 几段文字就能把上下文塞满。所以快照只给「有几个元素、画布多大、用什么配色」，
 * 详情由 `getTypographyDoc(clipId, detail)` 按需拉。
 */
export interface ClipTextSummary {
  size: { w: number; h: number };
  /** 元素个数。 */
  elements: number;
  /** 配色方案 id（缺省 = 默认方案）。 */
  theme: string | null;
  /** 有没有元素带入场动画（给「这一帧会不会动」一个提示）。 */
  animated: boolean;
}

export type ClipSourceView =
  | { type: 'video'; assetId: string; srcIn: number; speed: number }
  | { type: 'image'; assetId: string }
  | { type: 'algo'; generator: string; params: Record<string, number | string> }
  | { type: 'text'; doc: ClipTextSummary }
  | { type: 'solid'; color: string };

export interface EffectInstanceView {
  instanceId: string;
  defId: string;
  enabled: boolean;
  values: Record<string, number | string>;
  /**
   * 外部蒙版引用（v19）。缺省 = 没接。形状与 `set_params({ mask })` 的入参同构，
   * 所以「读到什么就能写回什么」。
   */
  mask?: MaskRef;
}

/** `detail: 'ids'` 的片段：只够 agent 在长工程里探路。 */
export interface ClipIdView {
  id: string;
  kind: ClipKind;
  label: string;
  /** 秒。 */
  start: number;
  /** 秒。 */
  end: number;
}

/** `detail: 'full'` 的片段。 */
export interface ClipView extends ClipIdView {
  fadeSec: number;
  /**
   * `t` 时刻是否命中这一段（**含出画转场窗口**）。
   *
   * 由控制平面算好给出：判断命中要处理转场窗口（`transitionAt` 必须在 span
   * 过滤**之前**判，见 `engine/stack.ts`），让每个 agent 各自推一遍会引入
   * 一整类边界 bug。
   *
   * 只反映**几何与转场**，不含轨道 `enabled` —— 轨道开关在 track 上给。
   * 转场窗口内**两侧**（出画片段与入画片段）都是 `true`：那一帧的画面确实由
   * 两张贴图共同决定。
   */
  active: boolean;
  source?: ClipSourceView;
  blend?: BlendMode;
  opacity?: number;
  transform?: { x: number; y: number; sx: number; sy: number; rot: number };
  fit?: 'contain' | 'cover' | 'stretch';
  /** 入场转场（v13）。无前片段时另一侧是全透明。 */
  transitionIn?: { defId: string; duration: number; values: Record<string, number> };
  transitionOut?: { defId: string; duration: number; values: Record<string, number> };
  /** 视频片段的内嵌音轨设置（v13）。缺省 = 有声、0 dB、不淡。 */
  audio?: { gainDb?: number; fadeIn?: number; fadeOut?: number; muted?: boolean };
  /** 视频片段分离出来的音频片段 id（v13）。 */
  linkedAudioId?: string;
  /** 音频片段的静态增益（dB，v13）。缺省 0。 */
  gainDb?: number;
  /** 音频片段的血缘：从哪个视频片段分离出来的（v13）。 */
  linkedVideoId?: string;
  /** 音频片段的锁定目标；非空 = 跟随该视频片段（v13）。 */
  lockedTo?: string;
  chain?: EffectInstanceView[];
  /**
   * 影响深度（只有特效片段有）：只作用于下方最近的 N 条**启用**视觉轨；
   * 0 / 缺省 = 下方全部。语义与边界规则见 `engine/stack.ts`。
   */
  affectDepth?: number;
  /** 绑定片段：链只作用在这个 source 片段的层上（与 `affectDepth` 互斥）。 */
  boundClipId?: string;
  /** 只给**有键**的曲线，不铺开全部参数名。 */
  curves?: Record<string, Curve>;
  /** audio 片段独有的两个字段。 */
  assetId?: string;
  srcIn?: number;
  /** audio 片段的两段淡变（秒，v3）。缺省 = 0 = 不淡。 */
  fadeIn?: number;
  fadeOut?: number;
}

export interface TrackView {
  id: string;
  kind: 'visual' | 'audio';
  name: string;
  enabled: boolean;
  /**
   * 轨道静音（v15，仅视觉轨）：只关这条轨上视频片段的内嵌音轨，画面照常。
   * 视觉轨**总是**给这个键（缺省 false）；音频轨没有（它的 `enabled` 就是喇叭）。
   */
  muted?: boolean;
  /**
   * z 序 = 视觉轨数 − 1 − 视觉轨下标（AGENTS §4.1）。音频轨是 `null`。
   *
   * 由控制平面算好给出：这个换算写反的表现是「特效完全无效且不报错」，
   * 不该让每个 agent 各自推一遍。
   */
  z: number | null;
  clips: ClipView[];
}

export interface TrackIdView {
  id: string;
  kind: 'visual' | 'audio';
  name: string;
  enabled: boolean;
  /** 见 `TrackView.muted`。 */
  muted?: boolean;
  z: number | null;
  clips: ClipIdView[];
}

/**
 * 段落标记（v3）。**只给起点**：这一段的结尾永远是下一段的起点
 * （最后一段到工程末尾）—— 与 `Section` 的存储口径一致，不在快照里再造一份
 * 「end」，否则 agent 读到的是「视图的算法」而不是数据。
 */
export interface SceneSectionView {
  id: string;
  name: string;
  /** 秒。 */
  start: number;
  color?: string;
}

/**
 * 段落的写操作（`edit_sections`）。
 *
 * 一个工具带 `op` 而不是五个工具：参数几乎不重叠，返回值又都是同一份 sections
 * 列表 —— 拆成五个只会让模型多背四个名字（与 `typo_layout` 同一取舍）。
 */
export type SectionOp =
  | { op: 'add'; start: number; name?: string }
  | { op: 'split'; sectionId: string; at: number }
  | { op: 'rename'; sectionId: string; name: string }
  | { op: 'remove'; sectionId: string }
  | { op: 'move'; sectionId: string; start: number };

export interface SceneSnapshot {
  /** 秒，已吸附到帧栅格。 */
  t: number;
  fps: number;
  resolution: { w: number; h: number };
  /** 秒。 */
  duration: number;
  beatGrid: { bpm: number; offset: number; beatsPerBar: number };
  seed: number;
  /** 按 `start` 排好序（与时间轴上的顺序一致）。 */
  sections: SceneSectionView[];
  /**
   * 手动节奏点（v5）：秒、升序、允许不等距。只用于时间轴吸附 / 显示，
   * **不是**第二套拍网格（`beatGrid` 仍是等距拍与音频特征的唯一来源）。
   */
  beatMarks: number[];
  tracks: TrackView[];
}

export interface SceneIdSnapshot {
  t: number;
  fps: number;
  resolution: { w: number; h: number };
  duration: number;
  beatGrid: { bpm: number; offset: number; beatsPerBar: number };
  seed: number;
  sections: SceneSectionView[];
  /** 见 `SceneSnapshot.beatMarks`。 */
  beatMarks: number[];
  tracks: TrackIdView[];
}

/** 已打开的工程（等价 `window.__artmatic.projects()`）。 */
export interface OpenProjectView {
  name: string;
  dirty: boolean;
  active: boolean;
  view: string;
  saved: boolean;
  dir: string | null;
}

/* ------------------------------------------------------- 能力（参数化） */

/** `ids` 只给 id；`params` 额外给展示名与完整参数表。 */
export type CapabilityDetail = 'ids' | 'params';

export interface ParamOption {
  value: string;
  label: string;
}

/**
 * 一项参数的机器可读描述（从 `ParamDef` 序列化而来）。
 *
 * **`visibleWhen` 这样的函数字段一律剥掉**：它过不了 JSON，而且 agent 需要的
 * 只是「有哪些键、什么类型、取值范围」，不需要在客户端执行谓词。
 */
export interface ParamSchema {
  key: string;
  label: string;
  type: 'range' | 'select' | 'checkbox' | 'color' | 'bitmask' | 'pattern' | 'text' | 'asset';
  defaultValue: number | string;
  /** 只有 range 能打关键帧（`runtime.evalParams` 只对 range 走曲线）。 */
  curvable: boolean;
  min?: number;
  max?: number;
  step?: number;
  curve?: number;
  options?: ParamOption[];
  bits?: number;
  groups?: { label: string; bits: number; style: 'eca' | 'count' }[];
  presets?: { label: string; value: number }[];
  /** 分组键（展示元数据）。`asset` 型参数的值是 assetId，空串 = 未绑定。 */
  group?: string;
  accept?: 'image';
  editorSize?: number;
  mode?: '2d' | '1d';
  maxLength?: number;
  multiline?: boolean;
  placeholder?: string;
}

export interface GeneratorCapability {
  id: string;
  kind: string;
  name?: string;
  desc?: string;
  pluginId?: string | null;
  params?: ParamSchema[];
}

export interface EffectCapability {
  id: string;
  name?: string;
  desc?: string;
  category?: string | null;
  tags?: string[];
  pluginId?: string | null;
  params?: ParamSchema[];
  /** 结构标记：agent 据此知道「这条特效有历史 / 有几个 pre-pass / 吃不吃蒙版」。 */
  flags?: {
    feedback: boolean;
    prePasses: number;
    stateful: boolean;
    hdrFeedback: boolean;
    opaqueOutput: boolean;
    /**
     * 外部蒙版的用法：`'composite'`（缺省，链上 `mix(输入, 输出, mask)`）或
     * `'input'`（特效自己把 `u_mask` 当输入）。**所有特效都接受 `set_params({ mask })`**。
     */
    mask: 'composite' | 'input';
  };
}

export interface TransitionParamSchema {
  key: string;
  label: string;
  type: 'range' | 'checkbox';
  min?: number;
  max?: number;
  step?: number;
  defaultValue: number;
}

export interface TransitionCapability {
  id: string;
  name?: string;
  author?: string;
  license?: string;
  params?: TransitionParamSchema[];
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface Capabilities {
  generators: GeneratorCapability[];
  effects: EffectCapability[];
  transitions: TransitionCapability[];
  blendModes: BlendMode[];
  fits: ('contain' | 'cover' | 'stretch')[];
  curveModes: ('keyframe' | 'impulse' | 'follower')[];
  sourceTypes: SourceType[];
  /**
   * 跨子系统能力的**形状说明**（v13）。模型只信这张表：它猜不到「转场还有入场」、
   * 「视频自带声音」「增益的单位是 dB」这些事，猜错的表现是静默无效。
   */
  features: {
    transitions: { sides: ('in' | 'out')[]; transparentSide: boolean; shadowedBy: 'out' };
    videoPreclip: { ranges: true; frameAccurate: true; activeRange: true };
    videoAudio: {
      embeddedByDefault: true;
      detachToTrack: true;
      linkLock: true;
      gainDb: [number, number];
      fades: true;
      /** v15：片段级静音（`set_clip_audio.muted`）。 */
      muted: true;
      /** v15：轨道级静音（`set_track.muted`），只对视觉轨有意义。 */
      trackMute: 'visual tracks only';
    };
    /**
     * 视频变速（v14）。`set_clip_props({ speed })` 改常速、保持片段长度；
     * 曲线（`set_curve` 的 `speed`）可以取负 = 倒放。
     */
    videoSpeed: {
      staticField: 'source.speed';
      curveKey: 'speed';
      range: [number, number];
      negativeSpeed: 'curve-only';
      keepsClipLength: true;
      shrinksWhenSourceShort: true;
    };
    /**
     * 外部蒙版（v19）。`set_params({ mask })` 绑到**特效实例**上，每个特效都接受；
     * `kind: 'clip'` 读另一个片段这一帧的整帧层（含它的绑定特效链，不含混合 /
     * 不透明度），`kind: 'asset'` 读图片素材。
     */
    /**
     * 手动节奏点（v5，打点计时）。与 `beatGrid` 的分工是模型最容易猜错的一处：
     * 节奏点是**逐个秒数**、只供吸附与显示；BPM / offset / 拍号仍只由
     * `set_project.beatGrid` 管，`set_beat_marks` 不会改变任何音频特征。
     */
    beatMarks: {
      entity: 'Project.beatMarks';
      unit: 'seconds';
      sorted: true;
      uniform: false;
      snappedByTimeline: true;
      changesBeatGrid: false;
    };
    mask: {
      inputKey: 'mask';
      kinds: ['clip', 'asset', 'none'];
      /** 通道顺序就是 `MaskChannel` 的规范顺序（也是 shader 的 `u_channel`）。 */
      channels: ('luma' | 'alpha' | 'r' | 'g' | 'b')[];
      maxDepth: number;
      cycleRejected: true;
      /** `composite` = 链上混回（缺省，所有特效）；`input` = 特效自己解释。 */
      modes: ('composite' | 'input')[];
      defaultMode: 'composite';
      /** 写回形状：`{ kind, clipId | assetId, channel }`，或 `null` = 没有。 */
      shape: string;
    };
    /**
     * 调制（v20）。`bind_modulator` 在**参数层**叠加一条表达式，与关键帧曲线共存
     * （曲线先给值，再逐个槽作用）。三件容易猜错的事：
     *   ① 调制器是**工程级**的（一份定义驱动多条片段），不是片段字段；
     *   ② `add` 的增益是参数自己的单位，`mul` 的增益是 0..1 的混合系数；
     *   ③ 表达式是闭式的（只依赖 t / beat / 种子），没有跨帧递推 —— 所以 seek 精确。
     */
    modulation: {
      entity: 'Project.modulators';
      scope: 'project';
      /** 表达式词汇表（名字 + 参数个数）。 */
      funcs: { name: string; arity: number }[];
      modes: ('add' | 'mul')[];
      /** 槽的写回形状。 */
      shape: string;
      /** 槽的默认增益（`bind_modulator` 省略 gain 时）。 */
      defaultGain: number;
      maxModulators: number;
      /** 成环时的求值结果（不是报错：写入口挡环，求值路径只兜底）。 */
      cycleValue: 0;
    };
    /**
     * 粒子（v21，`gpu-sim` 形态）。模型最容易猜错的三件事：
     *   ① `asset` 型参数的值是 assetId 字符串，空串 = 解绑，不收视频；
     *   ② `rate` 是模拟步/秒，不是发射速率；`life` 是秒；
     *   ③ 预设名只能从 `presets` 取，猜错拼写会静默无效果。
     */
    particles: {
      generator: 'particles';
      kinds: string[];
      presets: string[];
      assetParams: string[];
      assetAccept: 'image';
      assetEmptyValue: '';
      channels: ('luma' | 'alpha')[];
      groups: string[];
      units: Record<string, string>;
      /** 预设不整表替换，只改它声明过的键。 */
      presetMerge: 'overlay';
      /** 粒子数上限由 `core/capacity.ts` 按机器派生，超出会被夹取。 */
      maxParticlesFrom: 'capacity';
    };
    /**
     * 流体（`gpu-sim` 的第二个使用者）。模型最容易猜错的四件事：
     *   ① `rate` 是模拟步/秒，**不是注入速度**；`force` 的单位是「域高度/秒」；
     *   ② `simRes` 是域的**质量档**（16:9 域的高度），不是输出分辨率；
     *   ③ `stateParams` 里的键改了会**从第 0 步重放**模拟（它们写进 dye / velocity），
     *      `volatileParams` 才是「拖了只改画面」；
     *   ④ `maskAsset` 是 assetId 字符串，空串 = 解绑，只收静态图片。
     */
    fluid: {
      generator: 'fluid';
      kinds: string[];
      assetParams: string[];
      assetAccept: 'image';
      assetEmptyValue: '';
      channels: ('luma' | 'alpha')[];
      motions: string[];
      simResOptions: string[];
      units: Record<string, string>;
      /** 改这些键会重放（构造哈希的一部分）。 */
      stateParams: string[];
      /** 改这些键不重放（只在出图那一侧读）。 */
      volatileParams: string[];
    };
  };
}

/* ------------------------------------------------------------ 排版能力 */

export interface TypographyGeneratorCapability {
  id: string;
  group: string;
  name: string;
  defaultSeed: number;
  aspect?: number;
  params: ParamSchema[];
  /**
   * 这个生成器**单看参数表看不出来**的语义（单位 / 夹取 / 覆盖关系）。
   * 只给非显然的那几条，别把 label 复述一遍。
   */
  notes?: string;
}

export interface TypographyCapabilities {
  /** 全部 `ShapeKind`。 */
  shapeKinds: string[];
  /** 每种图形支持哪些专属参数（圆角 / 边数 / 谷半径 / 壁厚 / 张角）。 */
  shapeParams: Record<
    string,
    { radius: boolean; sides: boolean; waist: boolean; inner: boolean; angle: boolean }
  >;
  /**
   * **单位与语义**。参数表只给键 / 区间 / 默认值，不给「这个 0.1 是比例还是
   * 100px 里的百分比」。缺了它，agent 只能靠渲染图反推量级。
   */
  units: {
    frame: string;
    /** 画幅（`doc.size`）与 `typo_set_canvas_size` 的 `scaleContent` 语义。 */
    canvas: string;
    /** 分组底板：`padding` / `radius` 是 px，填充与边框是 Paint / Stroke。 */
    groupBox: string;
    shapeRadius: string;
    shapeInner: string;
    shapeSides: string;
    shapeWaist: string;
    shapeAngle: string;
    generator: string;
    /** 文字的排印参数单位（letterSpacing / lineHeight / stroke 宽度 …）。 */
    text: string;
    /** 颜料的坐标单位（渐变的 angle、纹理的 scale / thickness）。 */
    paint: string;
    /** 手写路径的坐标系（`path` / `pathUnit`：0..100 authored 还是元素像素盒）。 */
    shapePath: string;
    /** 镜头（`typo_set_camera`）：单位、影响范围、以及它不改变图层矩形。 */
    camera: string;
    /** 镜头关键帧（`typo_set_camera_animation`）：通道、关键帧形状、覆盖语义。 */
    cameraTracks: string;
    /** 元素景深 `depth`（0..1）：谁会被镜头影响、0 与 1 分别是什么。 */
    depth: string;
    /** 元素级 3D 的单位与变换顺序（`transform3d`）。 */
    transform3d: string;
    /** agent 造元素时的默认值（透明填充 / 无描边 / 无动画）。 */
    defaults: string;
  };
  /**
   * 图片元素的效果与图形的图片填充。
   *
   * 滤镜 / 曲线的**形状**必须写在这里：模型猜 `filter.name` 的命中率极低，
   * 而猜错的形状会被 `coerceImageFilter` 整条丢掉 —— 回执里字段还在，
   * 画面却没有任何变化。
   */
  images: {
    /** 色彩校正各键的区间（`adjust`）。 */
    adjust: Record<string, string>;
    /** 重新着色的形状（两色 + 强度）。 */
    recolor: string;
    /** 图片边框（画在图内，不改元素框）。 */
    border: string;
    /** 滤镜：形状 + 全部可用 id。 */
    filter: { form: string; ids: string[] };
    /** 裁剪窗的口径与「设了比例会顺手改 fit」这条副作用。 */
    crop: string;
    /** 图形的图片填充（「裁剪为形状」）。 */
    imageFill: string;
  };
  /**
   * 元素动画（CSS 动画系统，预览与导出同一条求值路径）。
   *
   * 为什么要在能力清单里列预设名：模型没法猜 `slide-in-up` 与 `slideInUp` 哪个
   * 存在，而猜错的表现是「动画没生效、也没有报错」。
   */
  animations: {
    presets: { id: string; duration: number; easing: string; params?: Record<string, number> }[];
    /**
     * 结构化轨道（首选形态）：一条动画一个属性、关键帧存相对片段起点的绝对秒。
     *
     * 这张表是模型唯一能知道「`t` 不是 0..1」的地方 —— 缺了它，模型会拿旧的
     * `at` 口径往里填，而错位的表现只有「动得不对」，不报错。
     */
    tracks: {
      form: string;
      prop: string;
      /** 作用层：`content`（缺省，只动内容）/ `box`（整个元素框，含文本框底板与边框）。 */
      target: string;
      channels: { id: string; unit: string; identity: number }[];
      keys: { t: string; v: string; ease: string; color: string };
      derived: string;
      valueGate: string;
    };
    easings: string[];
    directions: string[];
    fills: string[];
    /** 关键帧输入支持的属性（`keys[].*`）。 */
    keyProps: string[];
    /** 一次动画最多几条关键帧。 */
    maxKeys: number;
    /**
     * 手写 CSS 形态（`animation.css`）：编辑器「自定义动画」弹窗的同一套语法。
     * `keys[]` 表达不了的动作（三维旋转 / clip-path / 背景位移 …）走这条。
     */
    customCss: {
      /** 字段名（`typo_set_animation({ animation: { css } })`）。 */
      field: string;
      /** 合法的写法。 */
      forms: string[];
      /** 会被拒绝的东西（以及为什么）。 */
      rejects: string;
      /** 任何可动的 CSS 属性都能写 —— 这条要说出来，否则模型只用 keyProps 那七个。 */
      anyProperty: string;
    };
    /** `typo_set_animation` 的 `at` / `keys[].at` 单位说明。 */
    note: string;
  };
  /**
   * 格式刷 / 动画刷（`typo_copy_style`）。
   *
   * 与 `animations` 分开一段而不是塞进它的 note：刷子是**跨元素**的操作，
   * 模型要先知道「能刷什么、不刷什么」，否则会拿它当 duplicate 用
   * （然后发现位置和内容都没跟过去）。
   */
  styleCopy: {
    /** 工具签名。 */
    tool: string;
    /** 两种模式各刷什么。 */
    what: string[];
    /** 跨种类怎么落（图形的 fill ↔ 文本框的 boxFill）。 */
    mapping: string;
    /** 目标没有的字段怎么办。 */
    skips: string;
    /** 有意不搬的东西。 */
    notCopied: string;
  };
  /**
   * 文档级脚本（每帧求值）。
   *
   * **这是模型唯一能知道 `ctx` 形状的地方**：没有它，模型只能凭「应该有个
   * setOpacity 吧」猜 API，而猜错的表现是「脚本写进去了、画面没变化」。
   */
  scripts: {
    /** 写入字段（`typo_set_scripts({ scripts })` 里每条脚本的字段）。 */
    fields: string[];
    /** 代码形态（函数体 / 同步）。 */
    form: string;
    /** `ctx` 上的只读字段与单位。 */
    context: Record<string, string>;
    /** `ctx.el(id)` 返回的句柄方法。 */
    element: Record<string, string>;
    /** `ctx.chars(elId)` 返回的逐字句柄。 */
    chars: Record<string, string>;
    /** 纯函数助手。 */
    helpers: Record<string, string>;
    /** 结构预处理声明与它带来的副作用。 */
    needs: Record<string, string>;
    limits: {
      maxScripts: number;
      maxCodeChars: number;
      maxTotalCodeChars: number;
      maxWritesPerFrame: number;
      softMs: number;
      hardMs: number;
    };
    /** 内置模板（id + 展示名 + 需要的结构）。 */
    templates: { id: string; name: string; needs: string[] }[];
    /** **总开关默认关**这条事实（模型必须转告用户，而不是以为效果已经生效）。 */
    running: string;
    /** 确定性 / 无状态 / 禁止项。 */
    rules: string;
  };
  /** 程序化 SVG 生成器（22 个）。 */
  generators: TypographyGeneratorCapability[];
  themes: { id: string; name: string; builtin: boolean }[];
  /**
   * 配色方案的**槽位键**（`lt1` / `dk1` / `lt2` / `dk2` / `accent1..6`，顺序即
   * 取色卡列序）。`typo_save_theme({ colors })` 只认这些键 —— 少了它模型只能
   * 猜 `accent1` 还是 `primary`。
   */
  themeSlots: string[];
  defaultFontFamily: string;
  paintKinds: ('none' | 'solid' | 'linear' | 'radial' | 'texture')[];
  texturePatterns: string[];
  mixBlends: string[];
  imageFits: ('fill' | 'contain' | 'cover' | 'none')[];
  textAligns: ('left' | 'center' | 'right' | 'justify')[];
  textVAligns: ('top' | 'middle' | 'bottom')[];
  strokeStyles: ('solid' | 'dashed' | 'dotted')[];
  layoutOps: string[];
  alignAxes: AlignAxis[];
}

/* --------------------------------------------------------------- 排版视图 */

export interface TypographyElementView {
  id: string;
  kind: 'text' | 'shape' | 'image';
  name: string;
  frame: { x: number; y: number; w: number; h: number; rot: number };
  blend: string;
  opacity: number;
  visible: boolean;
  locked: boolean;
  groupId?: string;
  /** 镜头景深（0..1）。缺省 = 不吃镜头。只在 `doc.camera` 存在时有意义。 */
  depth?: number;
  /** 元素级 3D（缺省 = 没有）。与 `frame.rot` 复合，见 typography/document.ts。 */
  transform3d?: unknown;
  /** text */
  text?: string;
  /** 行内富文本：`[{ text, style? }]`，style 的键见 `SPAN_STYLE_KEYS`。只在有覆盖时回显。 */
  runs?: unknown;
  style?: Record<string, unknown>;
  /** true = 宽固定、高随内容（文本框的默认行为）。 */
  autoHeight?: boolean;
  fill?: unknown;
  boxFill?: unknown;
  boxStroke?: unknown;
  /** 字形描边（-webkit-text-stroke）：{ color, width }。 */
  glyphStroke?: unknown;
  /** shape */
  shape?: string;
  /** 手写路径（只在没有 `gen` 时回显：生成器的 path 可由参数复现）。 */
  path?: string;
  /** `'px'` = 路径写在元素自己的像素盒里（文本转路径的产物）。缺省 = 0..100。 */
  pathUnit?: 'px';
  clipFrame?: boolean;
  stroke?: unknown;
  radius?: number;
  sides?: number;
  waist?: number;
  inner?: number;
  angle?: number;
  evenOdd?: boolean;
  gen?: { id: string; seed: number; params: Record<string, number | string> };
  /** image */
  assetId?: string;
  fit?: string;
  crop?: unknown;
  /** 抠像（`{ color, tolerance, softness, spill }`）与四角（`{ tl,tr,br,bl }`）。 */
  key?: unknown;
  quad?: unknown;
  /** 入场动画的完整描述（预设 / 关键帧 / 自定义 CSS + 时序）。 */
  animations?: Record<string, unknown>[];
}

export interface TypographyGroupView {
  id: string;
  name: string;
  fill: unknown;
  stroke: unknown;
  radius: number;
  padding: number;
}

export interface TypographyDocView {
  clipId: string;
  size: { w: number; h: number };
  background: unknown;
  theme: string | null;
  /** 文档镜头。**恒等时省略**（与读回形状一致：省略 = 复位到没有镜头）。 */
  camera?: { x: number; y: number; zoom: number; rot: number };
  elements: TypographyElementView[];
  groups: TypographyGroupView[];
  fonts: { family: string; format: string }[];
}

/** `detail: 'ids'` 的排版文档：只够 agent 找到「要改哪一个元素」。 */
export interface TypographyDocIdView {
  clipId: string;
  size: { w: number; h: number };
  theme: string | null;
  /** 文档镜头（恒等时省略）。探路档也给：没有它看不出画面被推近过。 */
  camera?: { x: number; y: number; zoom: number; rot: number };
  elements: {
    id: string;
    kind: 'text' | 'shape' | 'image';
    name: string;
    frame: TypographyFrame;
    /** 镜头景深（0..1，只在非 0 时给）。 */
    depth?: number;
  }[];
}

/** 一次批量更新的条目。 */
export interface TypographyElementUpdate {
  elementId: string;
  patch: TypographyElementPatch;
}

/**
 * `typo_measure` 的读数。**实测优先、估算兜底**：没有 DOM 时 `estimated`
 * 为 true，此时只该用来发现「明显溢出」，别拿它做像素级对齐。
 */
export interface TypographyMeasure {
  clipId: string;
  size: { w: number; h: number };
  elements: {
    id: string;
    kind: 'text' | 'shape' | 'image';
    name: string;
    frame: TypographyFrame;
    visible: boolean;
    locked: boolean;
    text?: {
      chars: number;
      lines: number;
      contentHeight: number;
      contentWidth: number;
      overflowY: number;
      overflowX: number;
      estimated: boolean;
    };
    /** 超出画布的像素数（正值 = 越界多少）。 */
    outside?: { left: number; top: number; right: number; bottom: number };
  }[];
  /** 相交元素对，按面积从大到小（最多 50 对；按**未旋转**框算）。 */
  overlaps: {
    a: string;
    b: string;
    area: number;
    rect: { x: number; y: number; w: number; h: number };
    textOverlap: boolean;
  }[];
  summary: {
    elements: number;
    texts: number;
    textOverflow: string[];
    outside: string[];
    overlapPairs: number;
    rotated: number;
  };
}

/**
 * 隔离渲染：只让这几层可见（工程本身不改）。
 *
 * 数组形态是「同时看这几层」——比如「只看 BG + 它的特效轨」。注意隔离把**所有**
 * 未列出的视觉轨关掉，包括特效轨：它是「看某一层自己的画面」，不是「试特效」。
 */
export interface RenderOnly {
  /** 只保留这些视觉轨（其余视觉轨临时当作关闭）。 */
  trackId?: string | string[];
  /** 只保留这些排版元素（同一文档里的其它元素临时设为 visible:false）。 */
  elementId?: string | string[];
}

/** 场景版本：判断「两个只读调用之间工程有没有变」。 */
export interface SceneVersion {
  /** `ProjectStore.version`（内容变化才递增；改名字 / 参数都算）。 */
  version: number;
  /** 当前播放头（秒，已吸附到帧栅格）。 */
  playT: number;
}

/* --------------------------------------------------------------- 插件 */

/**
 * 控制平面对插件宿主的**最小视图**。
 *
 * 只声明它用到的那几个方法（结构类型，不需要 import `plugins/host.ts`）——
 * `src/agent/` 的依赖方向里没有 `plugins/`，装配点（`main.ts`）负责把
 * `appState.plugins` 交进来。
 */
export interface AgentPluginHost {
  importBytes(
    fileName: string,
    bytes: Uint8Array,
    projectKey: string | null,
  ): Promise<{ pluginId: string; ok: boolean; issues: PluginIssueView[] }>;
  get(pluginId: string): AgentLoadedPlugin | null;
  list(): AgentLoadedPlugin[];
  markPersisted(pluginId: string, fileName: string): void;
  installedIds?(): Set<string>;
}

export interface PluginIssueView {
  code: string;
  path?: string;
  detail?: string;
}

export interface AgentLoadedPlugin {
  id: string;
  name: string | null;
  author?: string | null;
  version?: string | null;
  license?: string | null;
  fileName: string | null;
  enabled: boolean;
  status: 'ok' | 'partial' | 'failed' | 'disabled';
  effectCount: number;
  generatorCount: number;
  /** 排版文档钩子数（apiVersion 2）。 */
  hookCount?: number;
  issues: PluginIssueView[];
  verified: boolean;
  failure?: { code: string; detail: string } | null;
}

export interface PluginTryResult {
  pluginId: string;
  ok: boolean;
  status: AgentLoadedPlugin['status'];
  /** 已进注册表的**限定 id**（`${pluginId}/${localId}`）。 */
  effects: string[];
  generators: string[];
  /** 已进注册表的文档钩子限定 id（`${pluginId}/${localId}`）。 */
  hooks: string[];
  issues: PluginIssueView[];
  /** 有没有跑过真 GL 编译校验。false = 预览还没装配，稍后重试。 */
  verified: boolean;
  /** 归档在草稿区（可安装 / 可丢弃）。 */
  draft: boolean;
}

export interface PluginInfoView {
  id: string;
  name: string | null;
  enabled: boolean;
  status: AgentLoadedPlugin['status'];
  effectCount: number;
  generatorCount: number;
  /** 排版文档钩子数（apiVersion 2 才有）。 */
  hookCount: number;
  issues: PluginIssueView[];
  /** 磁盘上的文件名。null = 只在内存里（还没安装 / 工程没目录）。 */
  fileName: string | null;
  /** 控制平面的草稿区里有没有这份源码。 */
  draft: boolean;
}

/** 插件源码来自哪里：这次会话改过的草稿，还是磁盘上的已安装文件。 */
export type PluginSourceOrigin = 'draft' | 'file';

/**
 * `plugin_view`：一页带行号的源码。
 *
 * `text` 已经拼好翻页提示（`[42 more lines; continue with offset=21]` /
 * `[end of file (120 lines)]`），所以模型不需要自己算还有没有下一页。
 */
export interface PluginViewResult {
  pluginId: string;
  origin: PluginSourceOrigin;
  /** 1-based，含。空页时 `to < from`。 */
  from: number;
  to: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  text: string;
}

export interface PluginGrepMatchView {
  /** 1-based。 */
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

/** `plugin_grep`：命中行。`total` 是截断前的总数。 */
export interface PluginGrepResult {
  pluginId: string;
  origin: PluginSourceOrigin;
  total: number;
  truncated: boolean;
  matches: PluginGrepMatchView[];
}

/** `plugin_edit`：唯一替换成功的回执。 */
export interface PluginEditResult {
  pluginId: string;
  origin: PluginSourceOrigin;
  /** 替换处的 1-based 行号。 */
  line: number;
  /** 改完之后的总行数 / 字节数。 */
  lines: number;
  bytes: number;
}

/** `plugin_check`：静态检查（真解析、不执行）+ 源码来源。 */
export interface PluginCheckView extends PluginCheckResult {
  pluginId: string;
  origin: PluginSourceOrigin;
}

/* -------------------------------------------------------------------- 看 */

/**
 * 一帧的数值指纹（方案 §5.2）。
 *
 * **默认给这个，不要默认给 PNG**：一张图像输入约合上千 token，数值指纹只有
 * 几十个数字。agent 自循环里的「改对没改对」用它就够。
 *
 * 两条实测过的判据陷阱（AGENTS §5.6，继承 `tests/e2e/_stage.ts::gridStats`）：
 *  1. 把颜色压成一个标量之后有些调色板会退化成常量（余弦调色板三通道恒差
 *     2π/3 ⇒ 均值恒 127.5），所以 `mean` **逐通道**。
 *  2. 分块均值对「铺满整幅的彩色渐变」不敏感。要判「有没有结构」用 `spread`，
 *     **不要用 `mean`**。
 */
export interface FrameSignature {
  /** 秒，已吸附到帧栅格。 */
  t: number;
  w: number;
  h: number;
  /** 逐通道均值（0–255）。 */
  mean: [number, number, number];
  /** 采样点里单通道的最大跨度（0–255）。0 = 这一帧没有结构。 */
  spread: number;
  /** `grid×grid` 分块均值（单通道等价量，与 `_stage.ts` 同口径），行优先。 */
  grid: number[];
  /** `grid×grid` 个点采样，每点 RGB 三通道（长度 = `grid*grid*3`）。 */
  samples: number[];
  /** 非零像素数 —— 纯黑背景下「非零即几何」。 */
  lit: number;
  total: number;
}

/* -------------------------------------------------------------------- 导 */

export type ExportFormat = 'mp4' | 'png' | 'gif';

export interface ExportRequest {
  format: ExportFormat;
  /** **帧号**，左闭右开（与 `ExportOptions.frameRange` 同一约定，见 AGENTS §5.8）。 */
  frameRange?: { from: number; to: number };
  size?: { w: number; h: number };
  /** 抽帧步进（GIF 用得上），默认 1。 */
  frameStep?: number;
  /** 传进来就是秒 —— 同一条求值路径，差别只在分辨率。 */
  signal?: AbortSignal;
  onProgress?: (frac: number) => void;
  onFrame?: (ms: number, index: number) => void;
}

/** 导出跑起来时的进度读数（网关轮询它转成 MCP 的 progress notification）。 */
export interface ExportState {
  format: ExportFormat;
  /** 0–1。 */
  frac: number;
  /** 已经渲完的帧数。 */
  frames: number;
  /** 这一轮导出会渲多少帧（含抽帧）。 */
  totalFrames: number;
  startedAt: number;
}

/**
 * 导出产物。
 *
 * `blob` 只在**页面内**可用（E2E 直接读字节）。跨传输层时用 `exportBase64`
 * —— 它把字节也编码进来，代价是字符串体积约 1.37 倍。大导出请改用
 * 「导出到工程目录」那条路（当前工具面未暴露，见 `docs/agent-control-plane.md` §3.5）。
 */
export interface ExportArtifact {
  format: ExportFormat;
  bytes: number;
  mimeType: string;
  blob: Blob;
}

export interface ExportArtifactBase64 extends Omit<ExportArtifact, 'blob'> {
  base64: string;
}

/* ------------------------------------------------------------------ 上下文 */

/**
 * 控制平面与宿主之间的**唯一**接缝。
 *
 * 为什么是注入而不是直接 import `ui/app-state.svelte`：`appState` 是 `ui/`
 * 层的 `$state` 类，`src/agent/` 直接 import 它就被 `ui/` 反向绑住，将来
 * `/lab/` 或独立入口想复用控制平面时会成环。注入点只有一处（`main.ts`），
 * 代价极小。
 *
 * ⚠️ **`getStore()` 每次调用都重新取**，绝不能缓存成 `const store = ...` 后
 * 跨工程切换用 —— `appState.store` 是 getter，多工程下它永远指向当前前台那份
 * （AGENTS §5.2）。
 */
export interface ControlContext {
  /** 当前激活工程的 store。无工程时返回 null。 */
  getStore(): import('../core/project-store').ProjectStore | null;
  /** 渲染门面。预览 canvas 还没挂载时为 null。 */
  getRenderer(): import('../engine/renderer').Renderer | null;
  /** 当前工程的素材仓（校验 assetId 用）。 */
  getAssets(): import('../project/asset-store').AssetStore | null;
  getPlayT(): number;
  setPlayT(t: number): void;
  /** 音频字节（导出 mp4 混流用）。没有就返回 null。 */
  getAudioBuffer(assetId: string): AudioBuffer | null;
  /**
   * 导出前预热音频：把视频片段的内嵌音轨解成 `AudioBuffer` 并注册进播放器
   * （`engine/video-audio.ts`）。缺省 = 这个宿主不支持视频音频。
   */
  prepareAudio?: (project: import('../core/schema').Project) => Promise<void>;
  listProjects(): OpenProjectView[];
  /** 写盘。返回 false = 没写成（未绑定目录 / 目录选择器不可用）。 */
  saveProject(): Promise<boolean>;
  /** 打开一份工程：给 name 走 OPFS（headless 可用），不给就弹系统对话框（需手势）。 */
  openProject(name?: string): Promise<boolean>;
  /** 编辑器的「取消当前手势」钩子 —— agent 承接事务前必须让它落地。 */
  cancelPendingGesture(): void;
  /** 让界面重新同步（导出 / 出图改过渲染尺寸之后调）。 */
  refreshPreview(): void;
  /**
   * 用户**此刻**的界面状态：播放头 / 在哪一页 / 选中了什么。
   *
   * 每轮对话开工前被读一次，拼进系统提示（`agent/context.ts::renderUiContext`）。
   * 没有它时，用户说「把**这个**片段改一下」，模型只能猜 —— 而猜错的表现是
   * 「改了一个看起来对的东西」，从回执里看不出来。
   *
   * 缺省 = 这个宿主没有界面（headless / CLI），提示里就不带那段。
   */
  getUiContext?: () => UiContextSnapshot | null;

  /* -------------------------------------------------- 排版 / 插件的接缝 */

  /**
   * 排版编辑器当前正在编辑的文本片段 id。没有打开排版页时返回 null。
   *
   * 排版工具允许省略 `clipId`，此时用它 —— 用户在排版页里说「把标题改大」，
   * agent 不该要求他先报一个 id。
   */
  getActiveTypoClipId?: () => string | null;
  /**
   * 停掉正在进行的行内文本编辑（contenteditable）。
   *
   * 只调 `cancelPendingGesture()` 不够：那个落地的是手势事务，而打字是
   * 直接在文档对象上改 runs 的。不停止的话，agent 写入会被编辑器下一次
   * 提交覆盖（或者反过来）—— 两边都「看起来正常」，只是改动丢了。
   */
  stopTextEditing?: () => void;
  /**
   * 文本轮廓（「文字转路径」的算力）。
   *
   * 跑在页面里：需要 DOM 排版（`Range.getClientRects`）+ HarfBuzz，而
   * `typography/text-outline.ts` 会拉 `render-dom` —— 控制平面不能 import 它。
   * 这里只**计算**，不落库：快照 / 核对 / 提交都在控制平面（撤销纪律）。
   */
  outlineText?: (
    el: import('../typography/document').TextElement,
    theme: string | undefined,
    customThemes: import('../typography/theme').TypographyTheme[] | undefined,
  ) => Promise<TextOutlineResult>;

  /**
   * 媒体池（列 + 动作）。实现住在 `ui/project-actions.ts`（需要工程目录句柄、
   * 素材仓与播放器），控制平面不 import `ui/`。
   */
  mediaPool?: {
    list(): Promise<MediaPoolSnapshot>;
    /** `assetId` 只对单条动作有意义（`trash_all` / `clear_trash` 等忽略它）。 */
    run(op: MediaPoolOp, assetId?: string): Promise<{ changed: number; bytes?: number }>;
    /**
     * 改展示名（只动工程里的名字与素材仓的镜像）。返回 false = 没有这条素材。
     * 不属于 `run` 的那些磁盘动作，所以**不经过确认**。
     */
    rename?(assetId: string, name: string): boolean;
  };
  /**
   * 「操作媒体池需用户确认」偏好（默认 **true**）。
   *
   * 这些动作会移动 / 删除用户磁盘上的文件，而 Agent 无法从画面判断哪一份是原件；
   * 关掉它等于把这类操作交给模型自行决定。
   */
  getMediaPoolConfirm?: () => boolean;

  /** 插件宿主（`appState.plugins`）。没有工程 / 未初始化时为 null。 */
  getPluginHost?: () => AgentPluginHost | null;
  /** 当前工程的引用计数键（`OpenProject.id`）。 */
  getProjectKey?: () => string | null;
  /**
   * 把插件源码写进 `<工程目录>/plugins/<id>.js`。
   * 返回 false = 没有工程目录（只能本次会话内存可用）。
   */
  persistPlugin?: (pluginId: string, source: string) => Promise<boolean>;
  /** 从注册表卸载（不删磁盘文件）。 */
  unloadPlugin?: (pluginId: string) => Promise<void>;
  /** 彻底移除：注册表 + 记录 + 磁盘文件。 */
  removePlugin?: (pluginId: string) => Promise<void>;
  /**
   * 读一个**已安装**插件的源码（`plugin_view` / `plugin_edit` / `plugin_check`
   * 的只读来源）。返回 null = 没有这条记录 / 只在内存里 / 文件读不到。
   *
   * **不执行**插件代码：与 `persistPlugin` 相反的方向，只是把字节读回来。
   * 控制平面不 import `project/plugins`，所以这条接缝与另外三条一样由装配点给。
   */
  readPluginSource?: (pluginId: string) => Promise<string | null>;
}

/**
 * 文本轮廓的结果（`ControlContext.outlineText` 的返回）。
 *
 * `items` / `shadows` 的精确类型住在 `typography/text-outline.ts`（它拉 DOM），
 * 这里只过一道不透明的形状，控件平面投给 `buildTextOutlineShapes` 时再收窄。
 */
export type TextOutlineResult =
  | { ok: true; items: unknown[]; shadows: unknown[] }
  /** `code` 与 `TextOutlineFailure['code']` 对齐（empty / no-font / synthetic …）。 */
  | { ok: false; code: string; detail?: Record<string, unknown> };

/* ------------------------------------------------------------ 媒体池 */

/**
 * 媒体池动作。
 *
 * 这些动作会**改磁盘上的文件**（移进回收站 / 彻底删除 / 收集进工程目录），
 * 所以默认要用户确认一次（偏好 `mediaPoolConfirm`，见 `ControlContext`）。
 */
export type MediaPoolOp =
  | 'collect'
  | 'relink'
  | 'restore'
  | 'trash'
  | 'delete'
  | 'trash_all'
  | 'delete_all'
  | 'clear_trash'
  | 'cleanup_orphans';

/** 媒体池里的一条素材（`media_list` 的返回行）。 */
export interface MediaPoolAssetView {
  id: string;
  name: string;
  kind: 'audio' | 'image' | 'video';
  /** 工程素材表里有它 —— 新片段能引用。 */
  inProject: boolean;
  /** 已从工程移除，但字节还在仓里（可恢复 / 可进回收站）。 */
  retained: boolean;
  /** 引用式素材：字节指向本机原文件。 */
  linked: boolean;
  /** linked 的源文件在本次会话里变过（只提示，不自动换内容）。 */
  stale: boolean;
  /** 工程登记了它、但仓里没有字节（打开工程时读不出来）。 */
  missing: boolean;
  bytes: number | null;
  /** 被片段引用的次数（0 = 未使用）。 */
  uses: number;
}

/* ------------------------------------------------------ 视频预剪辑（v13） */

export interface AssetRangeView {
  id: string;
  name: string;
  /** 源内入点（秒）。 */
  inSec: number;
  /** 源内出点（秒）。 */
  outSec: number;
  /** 帧数（按工程 fps 换算，插片段时落下的长度就是它）。 */
  frames: number;
}

/**
 * 一个调制器（v20）的读回形状。
 *
 * `refs` 不只是调试信息：删除前要拿它告诉用户「这会摘掉哪几处参数」，
 * 评审一次 agent 的改动时也靠它看出「这条表达式到底影响多大范围」。
 */
export interface ModulatorView {
  id: string;
  name: string;
  expr: string;
  unit: { min: number; max: number };
  refs: { clipId: string; clipLabel: string; param: string; slots: number }[];
}

/** 表达式词汇表的一条（`get_capabilities` / `list_modulators` 都会带）。 */
export interface ExprFnView {
  name: string;
  arity: number;
}

export interface AssetRangesView {
  assetId: string;
  /** 素材总时长（秒）；未知 = null。 */
  durationSec: number | null;
  fps: number;
  ranges: AssetRangeView[];
  /** 当前激活范围；没有 = null（插入整段素材）。 */
  activeRangeId: string | null;
}

export interface MediaPoolSnapshot {
  assets: MediaPoolAssetView[];
  /** 磁盘占用；没有工程目录时为 null。 */
  usage: {
    projectBytes: number;
    unusedBytes: number;
    trashCount: number;
    trashBytes: number;
    orphanCount: number;
    orphanBytes: number;
  } | null;
}

/* ------------------------------------------------------ 排版写入的请求形状 */

/**
 * 新增元素。三种 `kind` 各有自己的字段，公共字段（位置 / 样式）在顶层。
 *
 * 之所以不用「一个通用 patch 对象」：文字要 runs + style、图形要 shape + fill，
 * 混在一个宽松对象里，agent 写错字段名不会有任何报错（只是静默没生效）。
 */
/** 新建元素时顺手带的动画（与 `typo_set_animation` 的 `animation` 同构）。 */
interface ElementAnimationInput {
  /** 一条（等价于 `animations: [x]`）。 */
  animation?: unknown;
  /** 多条；数组顺序 = 嵌套顺序（后面的在里层，见 animation.ts）。 */
  animations?: unknown[];
}

/** 三种元素共用的可选字段（与 `typo_update_element` 的 patch 同构）。 */
interface ElementExtraInput {
  /** 元素级 3D：`{ perspective, translate, rotate, scale, skew, origin, backface, style }`。 */
  transform3d?: unknown;
}

export type TypographyElementInput = (
  | {
      kind: 'text';
      text: string;
      /** 文档坐标（左上原点，px）。省略 = 水平居中、纵向居中偏上。 */
      frame?: Partial<TypographyFrame>;
      /** 行内富文本（整份）：`[{ text, style? }]`。给了就不再需要 text。 */
      runs?: unknown;
      style?: Partial<TypographyTextStyleInput>;
      fill?: unknown;
      boxFill?: unknown;
      boxStroke?: unknown;
      glyphStroke?: unknown;
      /** true = 宽固定、高随内容（与编辑器文本框的默认行为一致）。 */
      autoHeight?: boolean;
      name?: string;
      opacity?: number;
      blend?: string;
    }
  | {
      kind: 'shape';
      shape: string;
      frame?: Partial<TypographyFrame>;
      fill?: unknown;
      stroke?: unknown;
      radius?: number;
      sides?: number;
      waist?: number;
      inner?: number;
      angle?: number;
      /** 只有 `shape:'svg'` 有意义；与 `gen` 互斥，给了 path 就不该再给 gen。 */
      path?: string;
      /** `'px'` = 路径写在元素自己的像素盒里（文本转路径）。缺省 0..100。 */
      pathUnit?: 'px' | 'percent';
      clipFrame?: boolean;
      evenOdd?: boolean;
      name?: string;
      opacity?: number;
      blend?: string;
    }
  | {
      kind: 'image';
      assetId: string;
      frame?: Partial<TypographyFrame>;
      fit?: 'fill' | 'contain' | 'cover' | 'none';
      radius?: number;
      crop?: { x: number; y: number; w: number; h: number };
      /** 抠像（局部对象可）与四角（`{ tl, tr, br, bl }`）。 */
      key?: unknown;
      quad?: unknown;
      name?: string;
      opacity?: number;
      blend?: string;
    }
) &
  ElementAnimationInput &
  ElementExtraInput;

export interface TypographyFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface TypographyTextStyleInput {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  letterSpacing: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right' | 'justify';
  vAlign: 'top' | 'middle' | 'bottom';
  color: string;
  textDecoration: 'none' | 'underline' | 'line-through';
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  highlight?: string;
  /** 文字阴影：数组 = 多层（单个对象是老形态，写入时归一化成数组）。 */
  shadow?: { color: string; dx: number; dy: number; blur: number }[];
  writingMode: 'horizontal-tb' | 'vertical-rl';
}

/** 元素属性的白名单补丁（`kind` / `id` / `source` 一类不可写）。 */
export interface TypographyElementPatch {
  name?: string;
  frame?: Partial<TypographyFrame>;
  blend?: string;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  /** 镜头景深 0..1；`null` = 删字段（回到无穷远）。 */
  depth?: number | null;
  /**
   * 元素级 3D：对象 = **逐层合并**（只给 `{rotate:{y:35}}` 不会清掉已有透视），
   * `null` = 关闭（删字段）。
   */
  transform3d?: unknown;
  /** 元素阴影（多层，文档 px）。空数组 = 去掉阴影。 */
  shadows?: { color: string; dx: number; dy: number; blur: number }[];
  /** 元素虚化半径（文档 px）。0 = 不虚化。 */
  blur?: number;
  /** text */
  /** 行内富文本（整份替换）：`[{ text, style? }]`；与 `text` 同时给时以它为准。 */
  runs?: unknown;
  style?: Partial<TypographyTextStyleInput>;
  fill?: unknown;
  boxFill?: unknown;
  boxStroke?: unknown;
  /** 字形描边（-webkit-text-stroke）：{ color, width }，宽度 px。`null` = 去掉。 */
  glyphStroke?: unknown;
  /** true = 宽固定、高随内容。 */
  autoHeight?: boolean;
  /** shape */
  stroke?: unknown;
  /** 手写路径（只对 `shape:'svg'` 生效；写入时清掉 `gen`）。 */
  path?: string;
  /** `'px'` = 路径写在元素自己的像素盒里；`'percent'` = 回到 0..100（删字段）。 */
  pathUnit?: 'px' | 'percent';
  clipFrame?: boolean;
  radius?: number;
  sides?: number;
  waist?: number;
  inner?: number;
  angle?: number;
  evenOdd?: boolean;
  /** image */
  fit?: 'fill' | 'contain' | 'cover' | 'none';
  crop?: { x: number; y: number; w: number; h: number };
  /** 抠像参数（局部对象 = 只改给的键）；`null` = 关闭。只用于图片元素。 */
  key?: unknown;
  /** 四角透视（`{ tl,tr,br,bl }`，每个 `[x,y]`）；`null` = 关闭。退化四边形会被拒绝。 */
  quad?: unknown;
  /** 动画：`animations` / `animation` 替换，`addAnimation` 追加，`removeAnimations` 清空。 */
  animations?: unknown[];
  animation?: unknown;
  addAnimation?: unknown;
  removeAnimations?: boolean;
}

export type TypographyLayoutRequest =
  | { op: 'align'; axis: AlignAxis; target?: 'canvas' | 'selection'; elementIds?: string[] }
  | { op: 'distribute'; axis: 'h' | 'v'; elementIds?: string[] }
  | { op: 'grid'; cols: number; rows?: number; gap?: number; margin?: number; elementIds?: string[] }
  | { op: 'row' | 'column'; gap?: number; margin?: number; elementIds?: string[] };
