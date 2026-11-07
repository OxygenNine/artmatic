/**
 * control-plane.ts — ★ 控制平面：agent 的唯一操作面（方案 `docs/agent-control-plane.md`）。
 *
 * 四类能力全部**复用既有内核**，一行求值路径都不新开：
 *
 * | 能力 | 落点 | 纪律 |
 * |---|---|---|
 * | 读 | `store.project` → `scene.ts` | 紧凑、确定、可序列化；纯读无副作用 |
 * | 写 | `ProjectStore` 的既有方法 | 每一笔都入撤销栈；**不许裸改 `project`** |
 * | 看 | `renderer.renderFrame` + `readPixels` | 出图只准「临时钉尺寸 + 用完还原」 |
 * | 导 | `runExport` + 三个 `FrameSink` | 与导出面板同一条驱动循环 |
 *
 * ## 四条容易静默坏掉的纪律（方案 §2.4）
 *
 * 1. **写操作一律走 `ProjectStore` 的方法**（`commit` / `beginTx→endTx`）。
 *    裸改的后果不是「看起来不对」，是撤销栈整个错乱 —— agent 的改动用户撤不掉。
 * 2. **读接口不得有副作用**：不推 `playT`、不改 `store.version`、不 `setExportSize`。
 * 3. **出图必须还原尺寸**：`setExportSize` → 渲 → `clearExportSize` + `syncSize`。
 *    忘了还原的表现是「预览停在导出分辨率」，而且不报错（`main.ts:234-235`）。
 * 4. **不新增语义**：本文件里的每个写方法都在 `ProjectStore` 里有唯一对应项
 *    （映射表见方案 §3.3）。「更聪明的打包方法」是活的来源。
 *
 * ## 关于 `t` 的单位
 *
 * **秒**，并且一律吸附到帧栅格（`round(t·fps)/fps`）。理由见 `types.ts` 顶部。
 * 要帧号的地方字段名一律带 `Frame`（`frameRange.from` / `frameStep`）。
 *
 * ## 关于 `label`
 *
 * 方案 §4 说写类的 label 统一形如 `agent:<tool>`。这里只在**自己 `commit`** 的
 * 那几处做到了；包给 `ProjectStore` 既有方法的那些（`addTrack` / `setFps` /
 * `setTransitionOut` …）用的是 store 自己的 i18n 标签 —— 要统一就得给那些方法
 * 加一个 label 参数，而方案 §2.1 明确「内核一行不改」。另外 `CommandStack` 的
 * `onChange(label)` 目前无人消费（`ProjectStore` 收到 label 就直接丢掉），所以
 * 这个差异对用户不可见。将来做「撤销历史」面板时若要区分 agent 的改动，
 * 得先把 label 透出来 —— 那是另一件事。
 */

import {
  BLEND_MODES,
  SCHEMA_VERSION,
  migrateProject,
  newId,
  type AnyClip,
  type BlendMode,
  type EffectClip,
  type OverlapBehavior,
  type Project,
  type SourceClip,
  type Track,
} from '../core/schema';
import type { Curve } from '../core/curve';
import { maskRefCreatesCycle, maskRefOf, sanitizeMaskRef, type MaskRef } from '../core/mask';
import { sanitizeBeatMarks } from '../core/beat-marks';
import { tr } from '../i18n/index.svelte';
import type { ProjectStore } from '../core/project-store';
import type { Renderer } from '../engine/renderer';
import { frameOf, timeOf } from '../engine/clock';
import { timeAtBeat } from '../core/time';
import { buildStack, transitionSources, walkOps } from '../engine/stack';
import { transitionCut, type TransitionSide } from '../core/transitions';
import { activeRangeOf, newRange, nextRangeName, normalizeRange, rangeFrames } from '../core/preclip';
import { defaultValues, type ParamDef } from '../effects/types';
import { defaultEffectValues, getEffect } from '../effects/registry';
import { defaultParams, getGenerator, listGenerators } from '../algos/registry';
import { encodePattern } from '../algos/pattern-codec';
import { bitmapFromImageBlob } from '../algos/pattern-image';
import { gridSizeFromDefs } from '../algos/grid-dims';
import { coerceCropEdges, coerceKeySettings, coerceQuadCorners, identityCrop, isIdentityCrop } from '../core/image-fx';
import { defaultTransitionValues, getTransition } from '../effects/transitions/registry';
import { Mp4Sink, probeMp4Codec } from '../exporters/mp4-sink';
import { PngSequenceSink } from '../exporters/png-sequence';
import { GifSink, GIF_SINK_CODEC } from '../exporters/gif-sink';
import { planGif } from '../exporters/gif-plan';
import { mixdown } from '../exporters/mixdown';
import { ExportCancelled, runExport, type ExportOptions } from '../exporters/export-runner';
import { compileAll, type CompileResult } from '../effects/compile-all';
import { estimateTempo } from '../audio/tempo';
import { createTypographyDocument } from '../typography/document';
import type { TrackKey } from '../typography/animation-tracks';
import { makeEffectClip, makeSourceClip, type EffectClipInput, type SourceClipInput } from './clip-factory';
import { exprFunctions, getCapabilities, getTypographyCapabilities } from './capabilities';
import { frameSignatureOf } from './frame-signature';
import { buildClipView, buildSceneSnapshot } from './scene';
import * as typo from './typography';
import {
  checkPlugin,
  discardPlugin,
  editPlugin,
  grepPlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  tryPlugin,
  viewPlugin,
  draftSource,
  type DraftStore,
} from './plugin-author';
import { helpText } from './plugin-spec';
import {
  MAX_MODULATORS,
  MOD_DEFAULT_GAIN,
  modulatorRefs,
  type Modulator,
} from '../core/modulation';
import { defaultModulatorExpr, parseCached } from '../core/expr';
import {
  CONTROL_API_VERSION,
  ControlFailure,
  fail,
  ok,
  type AssetRangesView,
  type Capabilities,
  type CapabilityDetail,
  type ClipView,
  type ControlContext,
  type ControlResult,
  type DescribeInfo,
  type ExportRequest,
  type ExportArtifact,
  type ExportArtifactBase64,
  type ExportState,
  type ExprFnView,
  type ModulatorView,
  type FrameSignature,
  type OpenProjectView,
  type PluginCheckView,
  type PluginEditResult,
  type PluginGrepResult,
  type PluginInfoView,
  type PluginTryResult,
  type PluginViewResult,
  type RenderOnly,
  type MediaPoolOp,
  type MediaPoolSnapshot,
  type SceneDetail,
  type SceneIdSnapshot,
  type SceneSectionView,
  type SceneSnapshot,
  type SceneVersion,
  type SectionOp,
  type TypographyDocIdView,
  type TypographyDocView,
  type TypographyElementInput,
  type TypographyElementPatch,
  type TypographyElementUpdate,
  type TypographyElementView,
  type TypographyCapabilities,
  type TypographyLayoutRequest,
  type TypographyMeasure,
  type UndoState,
} from './types';
import type { UiContextSnapshot } from './context';

/* --------------------------------------------------------------- 小工具 */

const label = (tool: string) => `agent:${tool}`;

/** 素材的预剪辑范围 → 控制平面的读回形状（帧数与秒都给，调用方不必自己算）。 */
function rangesView(store: ProjectStore, assetId: string): AssetRangesView {
  const asset = store.project.assets[assetId];
  if (!asset) throw new ControlFailure('not-found', tr('agent.args.unknownAsset', { id: assetId }));
  const fps = store.project.fps;
  const ranges = (asset.ranges ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    inSec: r.inSec,
    outSec: r.outSec,
    frames: rangeFrames(r, fps),
  }));
  return {
    assetId,
    durationSec: asset.durationSec ?? null,
    fps,
    ranges,
    activeRangeId: activeRangeOf(asset)?.id ?? null,
  };
}

/** 与导出面板同档位（`ui/export.ts` 的 GIF_DEFAULT_*）。agent 也可以直接给 size。 */
const GIF_FALLBACK_WIDTH = 480;
const GIF_FALLBACK_FPS = 12.5;
const GIF_MAX_COLORS = 256;

const MIME: Record<ExportRequest['format'], string> = {
  mp4: 'video/mp4',
  png: 'application/zip',
  gif: 'image/gif',
};

interface Size {
  w: number;
  h: number;
}

/** 0..1 的裁切框（`render_frame` 的局部放大）。 */
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** H.264 的 4:2:0 需要偶数边长；统一到偶数，免得编码器静默裁一列。 */
function normalizeSize(size: Size): Size {
  return {
    w: Math.max(2, Math.round(size.w / 2) * 2),
    h: Math.max(2, Math.round(size.h / 2) * 2),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 定长数值数组（贝塞尔手柄）。`Number.isFinite(Number(x))` 会把字符串 "1" 放进来。 */
function isNumberArray(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** `Record<string, number | string>` 的校验 + 拷贝（拒绝 NaN / 对象 / 数组）。 */
function checkScalars(values: unknown, what: string): Record<string, number | string> {
  if (!isRecord(values)) {
    throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what }));
  }
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new ControlFailure('invalid-argument', tr('agent.args.notFinite', { what, key: k }));
      }
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = v;
    } else {
      throw new ControlFailure('invalid-argument', tr('agent.args.notScalar', { what, key: k }), {
        key: k,
      });
    }
  }
  return out;
}

/**
 * 只保留这个特效 / 生成器**声明过**的参数键。
 *
 * 别的键会被渲染路径静默忽略（uniform 写不进去），于是 agent 会看到「参数设了
 * 但画面没变」而完全不知道原因。这里是唯一能提前拦住它的地方。
 */
function checkKnownKeys(values: Record<string, number | string>, known: string[], what: string): void {
  const unknown = Object.keys(values).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.args.unknownKeys', { what, keys: unknown.join(', ') }),
      { unknown, known },
    );
  }
}

/** `ParamDef[]` → 参数键列表（校验用）。 */
function paramKeys(params: ParamDef[] | undefined): string[] {
  return (params ?? []).map((p) => p.key);
}

/** 媒体池动作白名单（顺序即工具描述里的顺序）。 */
const MEDIA_POOL_OPS: MediaPoolOp[] = [
  'collect',
  'relink',
  'restore',
  'trash',
  'delete',
  'trash_all',
  'delete_all',
  'clear_trash',
  'cleanup_orphans',
];

/* ------------------------------------------- 片段视觉字段（key / quad / crop）
 *
 * 校验在 `core/image-fx.ts`：排版图片元素与片段共用同一组字段，两份校验必然分叉。
 */

async function bytesToBase64(buf: Uint8Array): Promise<string> {
  let latin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    latin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(latin);
}

/* ------------------------------------------------------------------ 契约 */

export interface AgentControlPlane {
  /* 元信息 */
  describe(): Promise<ControlResult<DescribeInfo>>;
  /* 读 */
  getScene(opt?: { t?: number; detail?: SceneDetail }): Promise<ControlResult<SceneSnapshot | SceneIdSnapshot>>;
  getCapabilities(opt?: { detail?: CapabilityDetail; ids?: string[] }): Promise<ControlResult<Capabilities>>;
  getTypographyCapabilities(): Promise<ControlResult<TypographyCapabilities>>;
  getTypographyDoc(
    clipId: string | undefined,
    detail?: 'ids' | 'full',
  ): Promise<ControlResult<TypographyDocView | TypographyDocIdView>>;
  getClip(clipId: string): Promise<ControlResult<ClipView | null>>;
  listProjects(): Promise<ControlResult<OpenProjectView[]>>;
  /** 媒体池快照：每条素材的归属 / 字节 / 引用次数 + 磁盘占用。 */
  listMediaPool(): Promise<ControlResult<MediaPoolSnapshot>>;
  /**
   * 媒体池动作。**默认要用户确认**（偏好 `mediaPoolConfirm`）：未确认时返回
   * `needs-approval`，`confirm: true` 只由会话层在用户点过之后传。
   */
  mediaPoolOp(req: {
    op: MediaPoolOp;
    assetId?: string;
    confirm?: boolean;
  }): Promise<ControlResult<{ op: string; changed: number; bytes?: number }>>;
  /**
   * 改素材的**展示名**（媒体池里显示的那个名字）。
   *
   * 只改工程里的 `assets[id].name`：磁盘文件名、落盘路径、linked 的原文件路径
   * 一个都不动。**不经过 `mediaPoolConfirm`** —— 它不碰用户的文件。
   */
  renameAsset(assetId: string, name: string): Promise<ControlResult<{ assetId: string; name: string }>>;
  undoState(): Promise<ControlResult<UndoState>>;
  /**
   * 场景版本（内容版本 + 播放头）。给会话层的**重复调用判据**用：
   * `render_frame` 的同一组参数在工程变化之后是**有意义的重试**，不该被
   * 「你调用过三次了」拦住。
   */
  sceneVersion(): Promise<ControlResult<SceneVersion>>;
  /**
   * 用户此刻的界面状态（播放头 / 在哪一页 / 选中了什么）。
   *
   * **不是工具**：只在会话层拼系统提示时被读一次（`context.ts::renderUiContext`）。
   * 模型不该自己调它 —— 它拿到的那段就是最新的，多一次往返只会更旧。
   * 同步返回：读的是宿主注入的钩子（`ControlContext.getUiContext`），没有异步步骤。
   */
  getUiContext(): UiContextSnapshot | null;
  /** 按需取协议 / 模型说明（plugin-api · timeline · typography · workflow · images）。 */
  help(topic?: string): Promise<ControlResult<{ topic: string; text: string }>>;
  /**
   * 着色器体检：把上下文里**所有**着色器编一遍（特效 + realtime 算法 + 全部转场）。
   *
   * 为什么 agent 需要它：着色器是**惰性编译**的（AGENTS §5.5），一个语法错误的
   * GLSL 在它被用到之前不报任何错。agent 在一次挂完一批特效之后自查一遍，是它
   * **唯一**能提前发现自己选错了特效 / 参数的手段（`effects/compile-all.ts`）。
   */
  compileAll(): Promise<ControlResult<{ okCount: number; total: number; failures: CompileResult[] }>>;
  /* 写 */
  addTrack(kind: 'visual' | 'audio', name?: string): Promise<ControlResult<{ trackId: string }>>;
  removeTrack(trackId: string): Promise<ControlResult<{ removed: string }>>;
  moveTrack(from: number, to: number): Promise<ControlResult<{ moved: boolean }>>;
  setTrack(
    trackId: string,
    patch: { enabled?: boolean; name?: string; muted?: boolean },
  ): Promise<ControlResult<{ changed: boolean; enabled: boolean; name: string; muted: boolean | null }>>;
  addClip(trackId: string, input: SourceClipInput): Promise<ControlResult<{ clipId: string; start: number; end: number }>>;
  addEffectClip(trackId: string, input: EffectClipInput): Promise<ControlResult<{ clipId: string }>>;
  removeClip(clipId: string): Promise<ControlResult<{ removed: string }>>;
  moveClip(clipId: string, targetTrackId: string, newStart: number): Promise<ControlResult<{ start: number; end: number }>>;
  resizeClip(clipId: string, edge: 'start' | 'end', time: number): Promise<ControlResult<{ start: number; end: number }>>;
  splitClip(clipId: string, at: number): Promise<ControlResult<{ leftId: string; rightId: string | null }>>;
  setClipProps(
    clipId: string,
    patch: Record<string, unknown>,
  ): Promise<ControlResult<{ changed: boolean; applied: Record<string, unknown> }>>;
  setClipSourceParams(
    clipId: string,
    params: Record<string, number | string>,
  ): Promise<ControlResult<{ changed: boolean; values: Record<string, number | string> }>>;
  /**
   * 把媒体池里的一张图片（SVG / PNG）按模拟网格采样成 `pattern` 参数，
   * 并把 `seedMode` 切到 `'pattern'`（生成器有这一档时）。
   *
   * 采样判据是**不透明度**（见 `algos/pattern-image.ts`）；颜色 / 亮度不参与。
   * 一次调用 = 一笔撤销（图案 + seedMode 一起换，否则会出现「图案写了但
   * 生成器还在随机撒种」的半截状态）。
   */
  seedPatternFromAsset(
    clipId: string,
    param: string,
    assetId: string,
  ): Promise<ControlResult<{ param: string; pattern: string; w: number; h: number }>>;
  /**
   * 改一个特效实例：参数 / 启用开关 / 外部蒙版。三者至少给一个 ——
   * 「只关掉这一条看差异」「只调一个参数」「只换个蒙版源」都不该被迫带上别的。
   *
   * `mask`：`null` = 摘掉引用；`{ kind: 'none' }` = 保留一个空引用；
   * `undefined` = 不动。只有声明了蒙版的特效（`flags.mask`）接受它。
   */
  setEffectParams(
    clipId: string,
    chainIndex: number,
    values?: Record<string, number | string>,
    enabled?: boolean,
    mask?: MaskRef | null,
  ): Promise<
    ControlResult<{
      changed: boolean;
      values: Record<string, number | string>;
      enabled: boolean;
      /** 写完之后实例上的蒙版引用（`null` = 没有）。 */
      mask: MaskRef | null;
    }>
  >;
  /**
   * 换掉算法片段的生成器（参数重置为新生成器的默认值 + 给定值）。
   *
   * 旧生成器的参数曲线会被删掉：它们的键在新生成器上不存在，留着只会在下次
   * 「加一条曲线」时变成噪声（与 UI 的 `changeAlgo` 同一处置）。
   */
  setGenerator(
    clipId: string,
    generator: string,
    params?: Record<string, number | string>,
  ): Promise<ControlResult<{ generator: string; params: Record<string, number | string> }>>;
  setCurve(
    clipId: string,
    param: string,
    curve: Curve | null,
  ): Promise<ControlResult<{ changed: boolean; param: string }>>;

  /* --------------------------------------------------- 调制器（v20） */
  /**
   * 全部调制器 + 它们被哪些参数引用 + 表达式词汇表。
   *
   * 引用清单是**删除前必须看的东西**：调制器是工程级实体，删掉它会让所有
   * 绑定了它的参数静默回到静态值。
   */
  listModulators(): Promise<ControlResult<{ modulators: ModulatorView[]; functions: ExprFnView[] }>>;
  /**
   * 新建或修改一个调制器（`id` 省略 = 新建）。
   *
   * `expr` 会先解析一遍再落库：文本模式的逃生舱允许用户写语法错误的表达式，
   * 但**模型不许** —— 它不会看到「画面没变」，只会以为自己改对了。
   */
  setModulator(req: {
    id?: string;
    name?: string;
    expr?: string;
    min?: number;
    max?: number;
  }): Promise<ControlResult<{ id: string; created: boolean; expr: string; refs: number }>>;
  /** 删除调制器，同时摘掉所有引用（一笔撤销）。 */
  removeModulator(id: string): Promise<ControlResult<{ removed: boolean; refs: number }>>;
  /**
   * 把一个调制器绑到某片段的某个参数上（`param` 接受与 `set_curve` 相同的可读名）。
   *
   * 同 ref 同 mode 的槽已存在时只改增益，不叠第二条 —— 两条一模一样的槽会让
   * 增益翻倍，而列表里看起来只有一行是「重复」的。
   */
  bindModulator(req: {
    clipId: string;
    param: string;
    modulatorId: string;
    gain?: number;
    mode?: 'add' | 'mul';
  }): Promise<
    ControlResult<{ param: string; slots: { ref: string; gain: number; mode: 'add' | 'mul' }[] }>
  >;
  /** 解绑：给了 `modulatorId` 只摘那一档，否则清空这个参数的全部调制。 */
  unbindModulator(
    clipId: string,
    param: string,
    modulatorId?: string,
  ): Promise<ControlResult<{ param: string; slots: number }>>;
  /**
   * 往链里加一个特效。返回的 `keyPrefix` 就是 `set_curve` 该用的前缀
   * （`keyPrefix + paramKey`），所以调用方不必再读一次片段去凑实例 id。
   */
  addEffect(
    clipId: string,
    defId: string,
    values?: Record<string, number | string>,
    index?: number,
    enabled?: boolean,
  ): Promise<ControlResult<{ instanceId: string; chainIndex: number; keyPrefix: string; enabled: boolean }>>;
  removeEffect(clipId: string, chainIndex: number): Promise<ControlResult<{ changed: boolean }>>;
  reorderEffect(clipId: string, from: number, to: number): Promise<ControlResult<{ changed: boolean }>>;
  /**
   * 设一段转场。`side` 缺省 `'out'`（出画）；`'in'` = 入场。
   * 无邻片段时另一侧是全透明，仍然可以设。
   */
  setTransition(
    clipId: string,
    defId: string,
    duration: number,
    values?: Record<string, number>,
    side?: 'in' | 'out',
  ): Promise<ControlResult<{ changed: boolean; side: 'in' | 'out' }>>;
  clearTransition(clipId: string, side?: 'in' | 'out'): Promise<ControlResult<{ changed: boolean }>>;

  /* 视频预剪辑（v13） */
  getAssetRanges(assetId: string): Promise<ControlResult<AssetRangesView>>;
  setAssetRange(
    assetId: string,
    range: { id?: string; name?: string; inSec: number; outSec: number },
  ): Promise<ControlResult<AssetRangesView & { rangeId: string }>>;
  removeAssetRange(assetId: string, rangeId: string): Promise<ControlResult<AssetRangesView>>;
  setActiveRange(assetId: string, rangeId: string | null): Promise<ControlResult<AssetRangesView>>;

  /* 视频音频（v13） */
  detachVideoAudio(clipId: string): Promise<ControlResult<{ audioClipId: string | null; trackId: string | null }>>;
  setAudioLock(clipId: string, locked: boolean): Promise<ControlResult<{ changed: boolean; lockedTo: string | null }>>;
  setClipAudio(
    clipId: string,
    patch: { gainDb?: number; fadeIn?: number; fadeOut?: number; muted?: boolean },
  ): Promise<ControlResult<{ changed: boolean }>>;
  setProject(patch: {
    name?: string;
    fps?: number;
    resolution?: { w: number; h: number };
    duration?: number;
    beatGrid?: { bpm?: number; offset?: number; beatsPerBar?: number };
    overlapBehavior?: OverlapBehavior;
  }): Promise<ControlResult<{ changed: string[] }>>;
  /**
   * 整表替换手动节奏点（v5，打点计时）。秒、升序、不限条数（服务端清洗去重）。
   * **不碰 `beatGrid`**：这是两套东西，见 `core/beat-marks.ts`。
   */
  setBeatMarks(marks: number[]): Promise<ControlResult<{ changed: boolean; beatMarks: number[] }>>;
  /** 段落标记的增 / 切 / 改名 / 删 / 移动。返回改后的完整列表（已按 start 排序）。 */
  editSections(req: SectionOp): Promise<ControlResult<{ changed: boolean; sections: SceneSectionView[] }>>;
  /**
   * 从工程里最早的那条音频片段估 BPM / offset，并写进 `beatGrid`。
   *
   * 与时间轴的「一键估计」同一条实现（`audio/tempo.ts`）。没有音频 / 估不出来
   * 时是 `unsupported` 而不是静默写一个默认值 —— 拍网错位会让所有卡点都偏。
   */
  estimateBeatGrid(): Promise<
    ControlResult<{ bpm: number; offset: number; confidence: number; sourceClipId: string }>
  >;
  loadScene(project: unknown): Promise<ControlResult<{ tracks: number; clips: number }>>;
  beginTx(): Promise<ControlResult<{ open: boolean }>>;
  endTx(label: string): Promise<ControlResult<{ changed: boolean }>>;
  cancelTx(): Promise<ControlResult<{ open: boolean }>>;
  undo(): Promise<ControlResult<{ changed: boolean }>>;
  redo(): Promise<ControlResult<{ changed: boolean }>>;
  /* 看 */
  renderFrame(opt?: {
    t?: number;
    size?: Size;
    only?: RenderOnly;
  }): Promise<ControlResult<{ t: number; w: number; h: number }>>;
  readPixels(): Promise<ControlResult<{ w: number; h: number; rgba: Uint8Array }>>;
  frameSignature(opt?: {
    t?: number;
    size?: Size;
    grid?: number;
    only?: RenderOnly;
  }): Promise<ControlResult<FrameSignature>>;
  snapshotPng(opt?: {
    t?: number;
    size?: Size;
    only?: RenderOnly;
    /** 局部放大：0..1 的裁切框（裁完再放大到至少 480px 宽）。 */
    region?: Region;
  }): Promise<ControlResult<Uint8Array>>;
  /**
   * 联系表：一段时间里的若干帧拼成一张图（节奏 / 卡点自检）。
   *
   * `from` / `to` / `step` 都是**秒**；默认 6 帧均匀铺开，最多 24 帧。
   */
  renderSequence(opt?: {
    from?: number;
    to?: number;
    step?: number;
    size?: Size;
    cols?: number;
    only?: RenderOnly;
    region?: Region;
  }): Promise<ControlResult<{ png: Uint8Array; times: number[]; cols: number; rows: number; w: number; h: number }>>;
  /** 这一帧实际参与合成的图层（`only` 生效之后的那一份）。 */
  frameLayers(opt?: { t?: number; only?: RenderOnly }): Promise<
    ControlResult<{ t: number; layers: { trackId: string; name: string; clips: { id: string; kind: string }[] }[] }>
  >;
  /* 导 */
  export(opt: ExportRequest): Promise<ControlResult<ExportArtifact>>;
  exportBase64(opt: ExportRequest): Promise<ControlResult<ExportArtifactBase64>>;
  exportState(): Promise<ControlResult<ExportState | null>>;
  abortExport(): Promise<ControlResult<{ aborted: boolean }>>;
  /* 工程级动作（需要 ui 层的编排，走注入的 ctx） */
  saveProject(): Promise<ControlResult<{ saved: true }>>;
  openProject(name?: string): Promise<ControlResult<{ opened: boolean }>>;

  /* ------------------------------------------------------------- 排版 */
  /**
   * 省略 `clipId` 时用排版编辑器当前打开的那份（`ctx.getActiveTypoClipId`）——
   * 用户在排版页说「把标题改大」时不该被迫先报一个 id。
   */
  addTypographyElement(
    clipId: string | undefined,
    input: TypographyElementInput,
  ): Promise<ControlResult<{ elementId: string; element: TypographyElementView }>>;
  /** 批量新增：一次调用、一笔撤销。数组顺序即 z 序（后面的在前）。 */
  addTypographyElements(
    clipId: string | undefined,
    inputs: TypographyElementInput[],
  ): Promise<ControlResult<{ elementIds: string[]; elements: TypographyElementView[] }>>;
  addGeneratedShape(
    clipId: string | undefined,
    input: {
      genId: string;
      params?: Record<string, number | string>;
      seed?: number;
      frame?: { x?: number; y?: number; w?: number; h?: number; rot?: number };
      name?: string;
      fill?: unknown;
      stroke?: unknown;
    },
  ): Promise<ControlResult<{ elementId: string; element: TypographyElementView }>>;
  updateTypographyElement(
    clipId: string | undefined,
    elementId: string,
    patch: TypographyElementPatch,
  ): Promise<ControlResult<{ changed: boolean; element: TypographyElementView }>>;
  /** 批量改属性：一次调用、一笔撤销。 */
  updateTypographyElements(
    clipId: string | undefined,
    updates: TypographyElementUpdate[],
  ): Promise<ControlResult<{ changed: number; elements: TypographyElementView[] }>>;
  /**
   * 设 / 清 / 追加一个元素动画（CSS 动画系统，预览与导出同一条路径）。
   *
   * `animation === null` = 清空；`mode:'add'` = 叠一条（一个元素可以有多条）。
   * 输入里 `keys[].at` 既可以是 0..1，也可以是 `{ beat: n }`（按工程 BPM 换算）。
   */
  setTypographyAnimation(
    clipId: string | undefined,
    elementId: string,
    animation: unknown,
    mode?: 'replace' | 'add',
  ): Promise<ControlResult<{ changed: boolean; element: TypographyElementView }>>;
  /**
   * 整表替换文档级脚本（每帧求值）。`[]` = 清空。
   *
   * 与动画一样是文档数据的一部分；**总开关在 UI 偏好里**（默认关），
   * 控制平面不替用户打开它。
   */
  setTypographyScripts(
    clipId: string | undefined,
    scripts: unknown,
  ): Promise<ControlResult<{ scripts: Record<string, unknown>[] }>>;
  /**
   * 把**一个元素**的格式 / 动画刷到一批目标上（编辑器「格式刷 / 动画刷」的同一路径）。
   *
   * `what:'format'` = 填充 / 描边 / 圆角 / 文本样式 / 图片处理 / 阴影与虚化；
   * `what:'animation'` = **整份替换**动画条目（不是追加）。目标没有的字段静默跳过。
   * 返回真的改了几个（0 = 本来就一样）。
   */
  copyTypographyStyle(
    clipId: string | undefined,
    sourceId: string,
    targetIds: string[],
    what?: 'format' | 'animation',
  ): Promise<ControlResult<{ changed: number; elements: TypographyElementView[] }>>;
  setTypographyText(
    clipId: string | undefined,
    elementId: string,
    text: string,
  ): Promise<ControlResult<{ changed: boolean; element: TypographyElementView }>>;
  removeTypographyElement(
    clipId: string | undefined,
    elementId: string,
  ): Promise<ControlResult<{ changed: boolean }>>;
  reorderTypographyElement(
    clipId: string | undefined,
    elementId: string,
    op: 'front' | 'back' | 'forward' | 'backward' | 'index',
    /** `op:'index'` 时的目标下标（0 = 最后面；末尾 = 最前）。 */
    index?: number,
  ): Promise<ControlResult<{ changed: boolean; z: number }>>;
  groupTypographyElements(
    clipId: string | undefined,
    elementIds: string[],
    name?: string,
  ): Promise<ControlResult<{ groupId: string | null }>>;
  ungroupTypographyElements(
    clipId: string | undefined,
    elementIds: string[],
  ): Promise<ControlResult<{ changed: boolean }>>;
  layoutTypography(
    clipId: string | undefined,
    req: TypographyLayoutRequest,
  ): Promise<
    ControlResult<{
      moved: number;
      elements: { id: string; frame: { x: number; y: number; w: number; h: number; rot: number } }[];
    }>
  >;
  /**
   * 几何体检：文字实际内容高度 / 被裁掉多少 / 元素相交 / 出画。
   * 纯读（不渲染、不写文档），是「挪了几次还是对不齐」的替代品。
   */
  measureTypography(
    clipId: string | undefined,
    elementIds?: string[],
  ): Promise<ControlResult<TypographyMeasure>>;
  setTypographyBackground(
    clipId: string | undefined,
    paint: unknown,
  ): Promise<ControlResult<{ changed: boolean }>>;
  /**
   * 换配色方案。`scope:'project'` = 写 `Project.typographyTheme` + 所有文本文档
   * （「一键全工程换色」，一笔撤销）；`null` = 回到默认方案。
   */
  setTypographyTheme(
    clipId: string | undefined,
    theme: string | null,
    scope?: 'clip' | 'project',
  ): Promise<ControlResult<{ changed: boolean; scope: 'clip' | 'project' }>>;
  /** 新建 / 更新一份自定义方案（局部色槽合并），并立即设为当前方案。 */
  saveTypographyTheme(
    clipId: string | undefined,
    input: {
      id?: string;
      base?: string;
      name?: string;
      colors?: unknown;
      scope?: 'clip' | 'project';
    },
  ): Promise<ControlResult<{ theme: { id: string; name?: string; colors: Record<string, string> }; scope: 'clip' | 'project'; appliedTo: string | null }>>;
  /** 删除一份自定义方案，并抹掉工程里对它的引用（`typographyTheme` + 各文档）。 */
  removeTypographyTheme(
    themeId: string,
  ): Promise<ControlResult<{ removed: string; clearedDocs: number }>>;
  /** 改画幅：`scaleContent` = 过 `resizeDocument`（元素 / 字号 / 描边一起缩放）。 */
  setTypographyCanvasSize(
    clipId: string | undefined,
    size: { w: number; h: number },
    scaleContent: boolean,
  ): Promise<ControlResult<{ changed: boolean; size: { w: number; h: number } }>>;
  /**
   * 设文档镜头（2.5D 视差）。`null` = 复位；对象**按出现的键合并**。
   *
   * 元素的景深不在这里：那是 `typo_update_element` 的 `depth`（0 = 无穷远，
   * 1 = 完全跟随镜头）。镜头对 `depth = 0` 的元素没有任何影响。
   */
  setTypographyCamera(
    clipId: string | undefined,
    camera: unknown,
  ): Promise<ControlResult<{ changed: boolean; camera: { x: number; y: number; zoom: number; rot: number } | null }>>;
  /**
   * 镜头**关键帧**：整条通道覆盖写。`null` / `[]` = 删掉这条轨道（回到基准值）。
   *
   * `channel` 收 `'x' | 'y' | 'zoom' | 'rot'`（也收 `'camera.zoom'` 这种全名）。
   * `keys` 是 `{ t, v, ease? }`，`t` 为**片段内绝对秒**，`v` 的量纲由通道决定
   * （px / 倍 / 度）。有关键帧的通道以轨道为准，`setTypographyCamera` 的基准值
   * 对那条通道不再生效。
   */
  setTypographyCameraAnimation(
    clipId: string | undefined,
    channel: string,
    keys: unknown,
  ): Promise<ControlResult<{ changed: boolean; channel: string; keys: unknown[] | null }>>;
  /** 改分组底板：`{ name?, fill?, stroke?, radius?, padding? }`（`stroke:null` = 去边框）。 */
  updateTypographyGroup(
    clipId: string | undefined,
    groupId: string,
    patch: Record<string, unknown>,
  ): Promise<ControlResult<{ changed: boolean; group: Record<string, unknown> }>>;
  /**
   * 图形布尔运算。**差集按 z 序**：最底下的那个是被减数。
   * 结果为空时不改文档、返回 `unsupported`。
   */
  booleanTypographyShapes(
    clipId: string | undefined,
    elementIds: string[],
    op: 'union' | 'difference' | 'intersection' | 'xor',
  ): Promise<ControlResult<{ elementId: string }>>;
  /** 拆分：重叠区域切成互不重叠的若干片（每片沿用最上面那个操作数的外观）。 */
  divideTypographyShapes(
    clipId: string | undefined,
    elementIds: string[],
  ): Promise<ControlResult<{ elementIds: string[] }>>;
  /**
   * 转路径：参数化 / 生成器图形就地转，文本走宿主注入的轮廓计算。
   * 任何一条失败都不改文档（整批原子）。
   */
  convertTypographyToPath(
    clipId: string | undefined,
    elementIds: string[],
  ): Promise<ControlResult<{ elementIds: string[]; converted: number }>>;
  /**
   * 整体替换文档。坏元素丢弃（`dropped`），**未知键逐条报出来**（`droppedKeys`）：
   * 静默归一化会让模型照着一份自己以为对的文档继续往下做。
   */
  replaceTypographyDoc(
    clipId: string | undefined,
    doc: unknown,
  ): Promise<ControlResult<{ elements: number; dropped: number; droppedKeys: string[] }>>;

  /* ------------------------------------------------------------- 插件 */
  /**
   * 试挂（载入内存 + 校验）。`confirm: false`（默认）**只返回 `needs-approval`**，
   * 不 import 源码、不产生任何实例 —— 试挂会在主世界执行这份代码。
   * 面板弹卡，用户点了才带 `confirm: true` 再调一次。
   */
  pluginTry(input: {
    id: string;
    name: string;
    /**
     * 省略 = 用草稿（这次会话里经 `plugin_view` / `plugin_edit` 得出来的那份），
     * 没有草稿再读磁盘上的已安装文件。改插件不必复述整份源码。
     */
    source?: string;
    confirm?: boolean;
  }): Promise<ControlResult<PluginTryResult>>;
  /** 分页读源码（带行号）。`offset` 是 1-based 起始行，`limit` 默认 200 / 上限 500。 */
  pluginView(input: {
    pluginId: string;
    offset?: number;
    limit?: number;
  }): Promise<ControlResult<PluginViewResult>>;
  /** 正则搜索源码，返回命中行号与整行（`context` 给前后行）。 */
  pluginGrep(input: {
    pluginId: string;
    pattern: string;
    ignoreCase?: boolean;
    context?: number;
    max?: number;
  }): Promise<ControlResult<PluginGrepResult>>;
  /**
   * 唯一匹配的字面量替换。**只改内存草稿**（不执行、不写盘）：
   * 生效走 `pluginTry`，落盘走 `pluginInstall`。命中 0 处或多处都失败。
   */
  pluginEdit(input: {
    pluginId: string;
    oldString: string;
    newString: string;
  }): Promise<ControlResult<PluginEditResult>>;
  /** 静态检查（acorn 真解析，**不执行**）。 */
  pluginCheck(pluginId: string): Promise<ControlResult<PluginCheckView>>;
  /**
   * 安装。`confirm: false`（默认）**只返回 `needs-approval`**，不写盘 ——
   * 面板拿到 detail 后弹确认，用户点了才带 `confirm: true` 再调一次。
   */
  pluginInstall(
    pluginId: string,
    confirm?: boolean,
  ): Promise<ControlResult<{ pluginId: string; persisted: boolean; effects: string[]; generators: string[] }>>;
  pluginList(): Promise<ControlResult<{ plugins: PluginInfoView[] }>>;
  pluginDiscard(pluginId: string): Promise<ControlResult<{ discarded: boolean; stillInstalled: boolean }>>;
  pluginRemove(pluginId: string): Promise<ControlResult<{ removed: boolean }>>;
  /**
   * 面板审批卡用：拿要执行的源码（用户要能看一眼自己批准了什么）。
   *
   * 草稿优先，没有草稿时读磁盘上的已安装文件 —— `pluginTry` 省略 `source`
   * 可以直接重挂已安装的插件，那条路的审批卡同样不能是空白的。
   */
  pluginSource(pluginId: string): Promise<ControlResult<{ source: string | null }>>;
}

/* ------------------------------------------------------------- 实现 */

export function createControlPlane(ctx: ControlContext): AgentControlPlane {
  /** 进行中的导出读数。网关轮询 `exportState()` 把它转成 MCP 的进度通知。 */
  let exportRun: ExportState | null = null;
  let exportAbort: AbortController | null = null;
  /** 控制平面自己开的事务。`ProjectStore` 不暴露 `inTx`，只能在这里记账。 */
  let txOpen = false;
  /** 最近一次「看」拿到的像素，供 `readPixels()` 独立读取。见 `drawAndRead`。 */
  let lastFrame: { w: number; h: number; rgba: Uint8Array } | null = null;
  /** 插件草稿区（源码只活在本次会话的内存里，安装之后磁盘才是真源）。 */
  const pluginDrafts: DraftStore = new Map();

  /* ---------------------------------------------------------- 取实例 */

  function needStore(): ProjectStore {
    const store = ctx.getStore();
    if (!store) throw new ControlFailure('no-project', tr('agent.ctx.noProject'));
    return store;
  }

  function needRenderer(): Renderer {
    const renderer = ctx.getRenderer();
    if (!renderer) throw new ControlFailure('not-ready', tr('agent.ctx.notReady'));
    return renderer;
  }

  function needClip(store: ProjectStore, clipId: string): { track: Track; clip: AnyClip } {
    const found = store.findClip(clipId);
    if (!found) {
      throw new ControlFailure('not-found', tr('agent.clip.notFound', { id: clipId }), { clipId });
    }
    return found;
  }

  function needEffectClip(store: ProjectStore, clipId: string): EffectClip {
    const { clip } = needClip(store, clipId);
    if (clip.kind !== 'effect') {
      throw new ControlFailure(
        'unsupported',
        tr('agent.clip.notEffect', { id: clipId, kind: clip.kind }),
        { clipId },
      );
    }
    return clip;
  }

  function needSourceClip(store: ProjectStore, clipId: string): SourceClip {
    const { clip } = needClip(store, clipId);
    if (clip.kind !== 'source') {
      throw new ControlFailure(
        'unsupported',
        tr('agent.clip.notSource', { id: clipId, kind: clip.kind }),
        { clipId },
      );
    }
    return clip;
  }

  /** 写操作前让悬空的手势落地 —— 否则 `beginTx` 会把用户的事务快照顶掉（方案 §5.2）。 */
  function beforeWrite(): ProjectStore {
    // 先停行内文本编辑：打字是直接改 doc.runs，不经过手势事务，
    // 不停的话编辑器下一次提交会把 agent 的改动覆盖掉（两边都不报错）。
    ctx.stopTextEditing?.();
    ctx.cancelPendingGesture();
    return needStore();
  }

  /** 排版写方法的目标片段：省略时用编辑器当前打开的那一份。 */
  function typoClipId(clipId: string | undefined): string {
    const id = clipId || ctx.getActiveTypoClipId?.() || '';
    if (!id) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.noDoc', { id: '(none)' }), {
        hint: 'pass clipId, or open the typography editor first',
      });
    }
    return id;
  }

  /**
   * 同上的「宽松版」：没有文档也返回 null。
   *
   * 工程级的配色操作（`scope:'project'`、删除方案）本来就不需要某一份文档 ——
   * 要求先打开排版页才能全工程换色是多余的门槛。
   */
  function optionalTypoClipId(clipId: string | undefined): string | null {
    return clipId || ctx.getActiveTypoClipId?.() || null;
  }

  function trackIdOf(store: ProjectStore, clipId: string): string {
    return needClip(store, clipId).track.id;
  }

  function paramsOf(generator: string): ParamDef[] {
    return getGenerator(generator)?.params ?? [];
  }

  /**
   * 动画关键帧允许写 `{ beat: n }`：读工程 BPM 换算成秒 / 进度。
   *
   * 两种时间口径都要管：
   *  - 旧式 `keys[].at`（0..1 进度）→ `timeAtBeat / duration`；
   *  - 结构化轨道 `keys[].t`（**相对片段起点的绝对秒**）→ `timeAtBeat − clip.start`。
   *
   * 换算只在这里发生（文档模型不认识拍号）—— 与 `core/curve.ts` 的 `beatAnchor`
   * 同一条纪律：不要在数据里物化拍号。
   */
  function resolveBeatKeys(store: ProjectStore, input: unknown, clipStart = 0): unknown {
    if (!isRecord(input) || !Array.isArray(input.keys)) return input;
    const duration = Number(input.duration) > 0 ? Number(input.duration) : 0.6;
    const grid = store.project.beatGrid;
    const keys = input.keys.map((k) => {
      if (!isRecord(k)) return k;
      if (isRecord(k.at)) {
        const beat = Number(k.at.beat);
        if (!Number.isFinite(beat)) return k;
        const sec = timeAtBeat(beat, grid);
        return { ...k, at: Math.max(0, Math.min(1, sec / duration)) };
      }
      if (isRecord(k.t)) {
        const beat = Number(k.t.beat);
        if (!Number.isFinite(beat)) return k;
        return { ...k, t: Math.max(0, timeAtBeat(beat, grid) - clipStart) };
      }
      return k;
    });
    return { ...input, keys };
  }

  /** 绑定片段的目标校验：必须是存在且是 source 的片段（特效片段不能当目标）。 */
  function checkBoundTarget(store: ProjectStore, clipId: string): void {
    const found = store.findClip(clipId);
    if (!found) {
      throw new ControlFailure('not-found', tr('agent.clip.notFound', { id: clipId }), { clipId });
    }
    if (found.clip.kind !== 'source') {
      throw new ControlFailure('invalid-argument', tr('agent.clip.boundNotSource', { id: clipId }), {
        clipId,
        kind: found.clip.kind,
      });
    }
  }

  /* ------------------------------------------------------------ 包装 */

  function toFailure(e: unknown): ControlResult<never> {
    if (e instanceof ControlFailure) return fail(e.code, e.message, e.detail);
    if (e instanceof ExportCancelled) return fail('cancelled', tr('agent.export.cancelled'));
    if (e instanceof Error) return fail('internal', e.message);
    return fail('internal', String(e));
  }

  async function run<T>(fn: () => T | Promise<T>): Promise<ControlResult<T>> {
    try {
      return ok(await fn());
    } catch (e) {
      return toFailure(e);
    }
  }

  /* ------------------------------------------------------------ 读 */

  const read: Pick<
    AgentControlPlane,
    | 'describe'
    | 'getScene'
    | 'getCapabilities'
    | 'getTypographyCapabilities'
    | 'getTypographyDoc'
    | 'getClip'
    | 'listProjects'
    | 'listMediaPool'
    | 'getAssetRanges'
    | 'undoState'
    | 'sceneVersion'
    | 'getUiContext'
    | 'help'
    | 'compileAll'
    | 'exportState'
  > = {
    async describe() {
      return run<DescribeInfo>(() => {
        const store = ctx.getStore();
        return {
          apiVersion: CONTROL_API_VERSION,
          appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
          schemaVersion: SCHEMA_VERSION,
          fps: store?.project.fps ?? 0,
          resolution: store ? { ...store.project.resolution } : { w: 0, h: 0 },
          duration: store?.project.duration ?? 0,
        };
      });
    },

    /**
     * 核心读接口。**纯读**：不推 `playT`、不动 `version`、不改渲染尺寸。
     * 省略 `t` 时用当前播放头 —— 那是「用户正看着哪一帧」的诚实答案。
     */
    async getScene(opt) {
      return run(() => {
        const store = needStore();
        const t = opt?.t ?? ctx.getPlayT();
        return buildSceneSnapshot(store.project, t, opt?.detail ?? ('full' as const));
      });
    },

    async getCapabilities(opt) {
      return run(() => getCapabilities(opt));
    },

    async getTypographyCapabilities() {
      return run<TypographyCapabilities>(() => {
        const store = needStore();
        return getTypographyCapabilities(store.project.customThemes ?? null);
      });
    },

    async getTypographyDoc(clipId, detail) {
      return run<TypographyDocView | TypographyDocIdView>(() => {
        // 纯读：不取消手势、不改播放头、不动渲染尺寸。
        const store = needStore();
        return typo.getDoc(store, typoClipId(clipId), detail ?? 'full');
      });
    },

    async help(topic) {
      return run(() => ({ topic: topic ?? 'index', text: helpText(topic) }));
    },

    async getClip(clipId) {
      return run(() => {
        const store = needStore();
        return buildClipView(store.project, clipId, ctx.getPlayT());
      });
    },

    async listProjects() {
      return run(() => ctx.listProjects());
    },

    async listMediaPool() {
      return run(async () => {
        needStore();
        if (!ctx.mediaPool) {
          throw new ControlFailure('unsupported', tr('agent.media.unsupported'));
        }
        return ctx.mediaPool.list();
      });
    },

    async getAssetRanges(assetId) {
      return run(() => rangesView(needStore(), assetId));
    },

    async undoState() {
      return run<UndoState>(() => {
        const store = ctx.getStore();
        return {
          canUndo: store?.canUndo() ?? false,
          canRedo: store?.canRedo() ?? false,
        };
      });
    },

    /**
     * 场景版本。**纯读**：不推播放头、不碰 store.version。
     *
     * 会话层把它拼进「工具 + 参数」的重复判据里：同一组 `render_frame` 参数
     * 在工程变化之后是新的问题，而不是第 3 次重复调用。
     */
    async sceneVersion() {
      return run<SceneVersion>(() => {
        const store = ctx.getStore();
        if (!store) return { version: 0, playT: 0 };
        const fps = store.project.fps;
        return { version: store.version, playT: timeOf(frameOf(ctx.getPlayT(), fps), fps) };
      });
    },

    getUiContext() {
      return ctx.getUiContext?.() ?? null;
    },

    async compileAll() {
      return run(() => {
        const renderer = needRenderer();
        const { results, okCount, total } = compileAll(renderer.kit);
        return { okCount, total, failures: results.filter((r) => !r.ok) };
      });
    },

    async exportState() {
      return run(() => exportRun);
    },
  };

  /* ------------------------------------------------------ 片段输入校验 */

  /**
   * 源输入的公共校验：生成器 / 素材必须真实存在。
   *
   * 为什么放在这里而不是渲染路径上：「黑屏」与「一句明确报错」的调试成本差一个
   * 量级，而 agent 拿不到控制台 —— 一次 `not-found(generator)` 比一张纯黑 PNG
   * 有用得多。
   */
  function validateSourceInput(store: ProjectStore, input: SourceClipInput): SourceClipInput {
    if (!isRecord(input)) {
      throw new ControlFailure('invalid-argument', tr('agent.clip.inputNotObject'));
    }
    const kinds = ['algo', 'solid', 'image', 'video', 'text'];
    if (typeof input.kind !== 'string' || !kinds.includes(input.kind)) {
      throw new ControlFailure(
        'invalid-argument',
        tr('agent.clip.badKind', { kinds: kinds.join(' / ') }),
        { validIds: kinds },
      );
    }
    if (input.kind === 'algo') {
      const def = getGenerator(input.generator ?? '');
      if (!def) {
        throw new ControlFailure(
          'not-found',
          tr('agent.gen.notFound', { id: String(input.generator) }),
          { validIds: getCapabilities().generators.map((g) => g.id) },
        );
      }
      const given = checkScalars(input.params ?? {}, 'params');
      checkKnownKeys(given, paramKeys(def.params), tr('agent.what.generator', { id: def.id }));
      // 默认参数在这里补齐：让 agent 只给「想改的那几个」。
      return { ...input, generator: def.id, params: { ...defaultValues(def.params), ...given } };
    }
    if (input.kind === 'image' || input.kind === 'video') {
      const id = input.assetId ?? '';
      const inProject = Boolean(store.project.assets[id]);
      const inStore = ctx.getAssets()?.has(id) ?? false;
      if (!id || (!inProject && !inStore)) {
        throw new ControlFailure(
          'not-found',
          tr('agent.asset.notFound', { id: id || tr('agent.asset.none') }),
          { validIds: Object.keys(store.project.assets) },
        );
      }
    }
    if (input.kind === 'text' && !input.doc) {
      /*
       * 文本片段必须带文档（`clip-factory` 对空 doc 抛错）。让 agent 从零手写
       * 一份 `TypographyDocument` 是没必要的摩擦：先给一张空画布，再用
       * `typo_add_element` 往里加东西 —— 这也是排版页「新建」的同一形态。
       */
      return { ...input, doc: createTypographyDocument(store.project.resolution) };
    }
    return input;
  }

  /* ------------------------------------------------------------ 写 */

  const write: Pick<
    AgentControlPlane,
    | 'addTrack'
    | 'removeTrack'
    | 'moveTrack'
    | 'setTrack'
    | 'addClip'
    | 'addEffectClip'
    | 'removeClip'
    | 'moveClip'
    | 'resizeClip'
    | 'splitClip'
    | 'setClipProps'
    | 'setClipSourceParams'
    | 'seedPatternFromAsset'
    | 'setGenerator'
    | 'setEffectParams'
    | 'setCurve'
    | 'listModulators'
    | 'setModulator'
    | 'removeModulator'
    | 'bindModulator'
    | 'unbindModulator'
    | 'addEffect'
    | 'removeEffect'
    | 'reorderEffect'
    | 'setTransition'
    | 'clearTransition'
    | 'setAssetRange'
    | 'removeAssetRange'
    | 'setActiveRange'
    | 'detachVideoAudio'
    | 'setAudioLock'
    | 'setClipAudio'
    | 'setProject'
    | 'setBeatMarks'
    | 'editSections'
    | 'estimateBeatGrid'
    | 'mediaPoolOp'
    | 'renameAsset'
    | 'loadScene'
    | 'beginTx'
    | 'endTx'
    | 'cancelTx'
    | 'undo'
    | 'redo'
  > = {
    /* ---- 轨道 ---- */

    async addTrack(kind, name) {
      return run(() => {
        const store = beforeWrite();
        if (kind !== 'visual' && kind !== 'audio') {
          throw new ControlFailure('invalid-argument', tr('agent.track.badKind'));
        }
        return { trackId: store.addTrack(kind, name) };
      });
    },

    async removeTrack(trackId) {
      return run(() => {
        const store = beforeWrite();
        if (!store.track(trackId)) {
          throw new ControlFailure('not-found', tr('agent.track.notFound', { id: trackId }));
        }
        store.removeTrack(trackId);
        return { removed: trackId };
      });
    },

    async moveTrack(from, to) {
      return run(() => {
        const store = beforeWrite();
        const n = store.project.tracks.length;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.track.badIndex', { max: n - 1 }),
            { from, to },
          );
        }
        const before = store.version;
        store.moveTrack(from, to);
        return { moved: store.version !== before };
      });
    },

    async setTrack(trackId, patch) {
      return run(() => {
        const store = beforeWrite();
        if (!store.track(trackId)) {
          throw new ControlFailure('not-found', tr('agent.track.notFound', { id: trackId }));
        }
        let changed = false;
        if (patch.enabled !== undefined) {
          const v0 = store.version;
          store.setTrackEnabled(trackId, Boolean(patch.enabled));
          changed = changed || store.version !== v0;
        }
        if (patch.name !== undefined) {
          const v0 = store.version;
          store.renameTrack(trackId, String(patch.name));
          changed = changed || store.version !== v0;
        }
        if (patch.muted !== undefined) {
          /*
           * 轨道静音只存在于视觉轨：音频轨的 `enabled` 本来就是「这条轨出不出声」，
           * 再开一个 muted 就会出现两个开关描述同一件事（而导出只看其中一个）。
           * 直接拒绝，别让模型以为它设上了。
           */
          if (store.track(trackId)?.kind !== 'visual') {
            throw new ControlFailure('invalid-argument', tr('agent.track.muteAudioTrack', { id: trackId }));
          }
          const v0 = store.version;
          store.setTrackMuted(trackId, Boolean(patch.muted));
          changed = changed || store.version !== v0;
        }
        // 回显落库后的值（空名字会被 store 拒掉，这里给的就是真值）。
        const after = store.track(trackId);
        return {
          changed,
          enabled: after?.enabled ?? false,
          name: after?.name ?? '',
          muted: after?.kind === 'visual' ? after.muted === true : null,
        };
      });
    },

    /* ---- 片段 ---- */

    async addClip(trackId, input) {
      return run(() => {
        const store = beforeWrite();
        const track = store.track(trackId);
        if (!track) throw new ControlFailure('not-found', tr('agent.track.notFound', { id: trackId }));
        if (track.kind === 'audio') {
          throw new ControlFailure('invalid-argument', tr('agent.track.audioOnlyAudio'));
        }
        const spec = validateSourceInput(store, input);
        const clip = makeSourceClip(spec);
        store.addClip(trackId, clip);
        const placed = store.findClip(clip.id);
        if (!placed) {
          // `addClip` 在落点被占且找不到空档时会**静默不动** —— 这类「什么都没
          // 发生」必须变成明确的错误，否则 agent 会以为加上了。
          throw new ControlFailure('conflict', tr('agent.place.addFailed', { id: trackId }), {
            start: clip.start,
            end: clip.end,
          });
        }
        return { clipId: clip.id, start: placed.clip.start, end: placed.clip.end };
      });
    },

    async addEffectClip(trackId, input) {
      return run(() => {
        const store = beforeWrite();
        const track = store.track(trackId);
        if (!track) throw new ControlFailure('not-found', tr('agent.track.notFound', { id: trackId }));
        if (track.kind !== 'visual') {
          throw new ControlFailure('invalid-argument', tr('agent.track.cannotHost', { id: trackId, kind: 'effect' }));
        }
        for (const c of input.chain ?? []) {
          if (!getEffect(c.defId)) {
            throw new ControlFailure('not-found', tr('agent.fx.notFound', { id: c.defId }), {
              validIds: getCapabilities().effects.map((e) => e.id),
            });
          }
        }
        // 绑定目标必须是**存在的 source 片段**：绑到一个不存在的 id 上，这条特效
        // 永远不会生效，而界面上它看起来完全正常（最容易浪费一整轮的现象）。
        if (input.boundClipId !== undefined) checkBoundTarget(store, input.boundClipId);
        const clip = makeEffectClip(input);
        store.addClip(trackId, clip);
        if (!store.findClip(clip.id)) {
          throw new ControlFailure('conflict', tr('agent.place.addEffectFailed', { id: trackId }));
        }
        return { clipId: clip.id };
      });
    },

    async removeClip(clipId) {
      return run(() => {
        const store = beforeWrite();
        needClip(store, clipId);
        store.removeClip(clipId);
        return { removed: clipId };
      });
    },

    /**
     * 移动片段 = `liveMoveClip` + `settlePlacement` 包在**一笔** `commit` 里。
     *
     * 为什么必须是这两步：`live*` 是实时直改（不入栈、不套用重叠策略），
     * `settle*` 才是按 `overlapBehavior` 结算的那一步 —— 只调前者会把片段压在
     * 邻居身上（方案 §3.3 明令 `live*` / `settle*` 不许单独暴露给 agent）。
     * 两者都不入栈，所以外面必须套 `commit`，否则用户的 Ctrl+Z 撤不掉。
     */
    async moveClip(clipId, targetTrackId, newStart) {
      return run(() => {
        const store = beforeWrite();
        const { clip } = needClip(store, clipId);
        const target = store.track(targetTrackId);
        if (!target) {
          throw new ControlFailure('not-found', tr('agent.track.notFound', { id: targetTrackId }));
        }
        if (!store.canHost(target, clip)) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.track.cannotHost', { id: targetTrackId, kind: clip.kind }),
          );
        }
        if (!Number.isFinite(newStart)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.seconds', { what: 'newStart' }));
        }
        // 先问一次落点合法性：reject 策略下非法落点要**整次不动**，而
        // live+settle 一旦跑过就已经改过几何了（见 core/clips.ts 的时序约定）。
        if (!store.placementAccepted(targetTrackId, clipId, newStart)) {
          throw new ControlFailure(
            'conflict',
            tr('agent.place.conflict', { behavior: store.project.overlapBehavior }),
            { newStart, to: targetTrackId },
          );
        }
        store.commit(label('move_clip'), () => {
          store.liveMoveClip(targetTrackId, clipId, newStart);
          store.settlePlacement(targetTrackId, clipId, newStart);
        });
        const after = store.findClip(clipId);
        return { start: after?.clip.start ?? newStart, end: after?.clip.end ?? newStart };
      });
    },

    async resizeClip(clipId, edge, time) {
      return run(() => {
        const store = beforeWrite();
        if (edge !== 'start' && edge !== 'end') {
          throw new ControlFailure('invalid-argument', tr('agent.args.edge'));
        }
        if (!Number.isFinite(time)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.seconds', { what: 'time' }));
        }
        const trackId = trackIdOf(store, clipId);
        store.commit(label('resize_clip'), () => {
          store.liveResizeClip(trackId, clipId, edge, time);
          store.settleResize(trackId, clipId, edge, time);
        });
        const after = store.findClip(clipId);
        return { start: after?.clip.start ?? 0, end: after?.clip.end ?? 0 };
      });
    },

    async splitClip(clipId, at) {
      return run(() => {
        const store = beforeWrite();
        const trackId = trackIdOf(store, clipId);
        if (!Number.isFinite(at)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.seconds', { what: 'at' }));
        }
        if (!store.splitClipAt(trackId, clipId, at)) {
          throw new ControlFailure('invalid-argument', tr('agent.place.splitOutside', { at }), {
            clipId,
            at,
          });
        }
        const track = store.track(trackId);
        // 右半段是新 id（`splitSpan` 生成的），只能按几何认回来。
        const right = track?.clips.find((c) => c.id !== clipId && Math.abs(c.start - at) < 1e-6);
        return { leftId: clipId, rightId: right?.id ?? null };
      });
    },

    /** 白名单式改属性：`kind` / `id` / `source` 一律不可写（那些各有专属方法）。 */
    async setClipProps(clipId, patch) {
      return run(() => {
        const store = beforeWrite();
        const { clip } = needClip(store, clipId);
        if (!isRecord(patch) || Object.keys(patch).length === 0) {
          throw new ControlFailure('invalid-argument', tr('agent.args.emptyPatch', { what: 'patch' }));
        }
        const allowed = [
          'label', 'fadeSec', 'blend', 'opacity', 'transform', 'fit', 'affectDepth', 'boundClipId',
          // 音频淡变 / 源入点 / 视觉效果（v3 补齐）
          'fadeIn', 'fadeOut', 'srcIn', 'key', 'quad', 'crop',
          // 视频变速（v14）。常速，保持片段长度；倒放走 set_curve 的 `speed`。
          'speed',
        ];
        const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
        if (bad.length > 0) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notWritable', { keys: bad.join(', ') }), {
            allowed,
          });
        }
        /* ---- 片段种类：先判「这个字段在这类片段上有没有意义」 ---- */
        const isAudio = clip.kind === 'audio';
        const isSource = clip.kind === 'source';
        const srcType = clip.kind === 'source' ? clip.source.type : null;
        if ((patch.fadeIn !== undefined || patch.fadeOut !== undefined) && !isAudio) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.fadeNotAudio'));
        }
        if (patch.srcIn !== undefined && !(isAudio || srcType === 'video')) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.srcInNotMedia'));
        }
        /*
         * 变速只对视频有意义。**负值在这里拒绝**：`source.speed` 是常速旋钮，
         * 倒放走关键帧曲线（`set_curve` 的 `speed`，可以取负）—— 两个入口都
         * 能倒放的话，「片段头一帧该显示哪一帧」会有两套解释。
         */
        if (patch.speed !== undefined) {
          const v = Number(patch.speed);
          if (srcType !== 'video') {
            throw new ControlFailure('invalid-argument', tr('agent.clip.speedNotVideo'));
          }
          if (!Number.isFinite(v) || v <= 0) {
            throw new ControlFailure('invalid-argument', tr('agent.clip.speedPositive'));
          }
        }
        if (patch.key !== undefined && !(srcType === 'image' || srcType === 'video')) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.mediaOnly', { field: 'key' }));
        }
        if (patch.quad !== undefined && !isSource) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.mediaOnly', { field: 'quad' }));
        }
        if (patch.crop !== undefined && !isSource) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.mediaOnly', { field: 'crop' }));
        }
        /*
         * 绑定片段：`null` = 解绑（回到 adjustment layer 语义）。字符串则必须是
         * 存在的 source 片段。与 `affectDepth` 互斥 —— 同一次 patch 里给两个
         * 直接拒绝，而不是悄悄留一个（语义矛盾不该被静默仲裁）。
         */
        if (patch.boundClipId !== undefined && patch.boundClipId !== null) {
          if (typeof patch.boundClipId !== 'string' || !patch.boundClipId) {
            throw new ControlFailure('invalid-argument', tr('agent.args.boundClip'));
          }
          checkBoundTarget(store, patch.boundClipId);
        }
        if (patch.boundClipId !== undefined && patch.affectDepth !== undefined) {
          throw new ControlFailure('invalid-argument', tr('agent.args.boundVsDepth'));
        }
        if (patch.blend !== undefined && !BLEND_MODES.some((b) => b.id === patch.blend)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.blend', { value: String(patch.blend) }), {
            validIds: BLEND_MODES.map((b) => b.id),
          });
        }
        if (patch.fit !== undefined && !['contain', 'cover', 'stretch'].includes(String(patch.fit))) {
          throw new ControlFailure('invalid-argument', tr('agent.args.fit', { value: String(patch.fit) }));
        }
        if (patch.opacity !== undefined && !Number.isFinite(Number(patch.opacity))) {
          throw new ControlFailure('invalid-argument', tr('agent.args.opacity'));
        }
        if (patch.fadeSec !== undefined && !(Number(patch.fadeSec) >= 0)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.fade'));
        }
        if (patch.transform !== undefined && !isRecord(patch.transform)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.transform'));
        }
        if (
          patch.affectDepth !== undefined &&
          (!Number.isInteger(Number(patch.affectDepth)) || Number(patch.affectDepth) < 0)
        ) {
          throw new ControlFailure('invalid-argument', tr('agent.args.affectDepth'));
        }
        if (patch.fadeIn !== undefined && !(Number(patch.fadeIn) >= 0)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.fade'));
        }
        if (patch.fadeOut !== undefined && !(Number(patch.fadeOut) >= 0)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.fade'));
        }
        if (patch.srcIn !== undefined && !(Number(patch.srcIn) >= 0)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.seconds', { what: 'srcIn' }));
        }
        /*
         * 三个视觉字段先算出**落库值**再写：形状不对就在改动之前报错。
         * `null` 是明确的「关掉这个效果」，与「没给」是两件事 —— 后者要沿用现有值。
         */
        const keyNext =
          patch.key === undefined
            ? undefined
            : patch.key === null
              ? null
              : coerceKeySettings(patch.key, isSource ? clip.key : undefined);
        if (keyNext === null && patch.key !== null) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.badKey'), { key: patch.key });
        }
        const quadNext =
          patch.quad === undefined ? undefined : patch.quad === null ? null : coerceQuadCorners(patch.quad);
        if (quadNext === null && patch.quad !== null) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.badQuad'), { quad: patch.quad });
        }
        const cropNext =
          patch.crop === undefined
            ? undefined
            : patch.crop === null
              ? null
              : coerceCropEdges(patch.crop, (isSource ? clip.crop : undefined) ?? identityCrop());
        if (cropNext === null && patch.crop !== null) {
          throw new ControlFailure('invalid-argument', tr('agent.clip.badCrop'), { crop: patch.crop });
        }

        const hasFade = patch.fadeIn !== undefined || patch.fadeOut !== undefined;
        const hasSpeed = patch.speed !== undefined;
        const hasOther = Object.keys(patch).some((k) => k !== 'fadeIn' && k !== 'fadeOut' && k !== 'speed');
        const before = store.version;
        /*
         * 淡变 / 变速走 store 的专属方法（前者钳制淡区、后者要拿素材时长决定
         * 片段是否缩短），其余字段走 updateClip。没有外层事务时多笔提交必须
         * 自己包一层：一次工具调用只该留一条撤销记录。
         * `beginTx` 会**覆盖**已有快照，所以只在没有事务时包（会话层通常在整轮
         * 动作外面已经开了一个）。
         */
        const wrap = (hasFade || hasSpeed) && hasOther && !store.inTx;
        if (wrap) store.beginTx();
        try {
          if (hasFade) {
            store.setFades(clipId, {
              ...(patch.fadeIn === undefined ? {} : { fadeIn: Number(patch.fadeIn) }),
              ...(patch.fadeOut === undefined ? {} : { fadeOut: Number(patch.fadeOut) }),
            });
          }
          if (hasSpeed) store.setClipSpeed(clipId, Number(patch.speed));
          if (hasOther) {
            store.updateClip(clipId, label('set_clip_props'), (c) => {
              if (patch.label !== undefined) c.label = String(patch.label);
              if (patch.fadeSec !== undefined) c.fadeSec = Math.max(0, Number(patch.fadeSec));
              // 影响深度 / 绑定片段只对特效片段有意义（都是 EffectClip 的字段）。
              if (c.kind === 'effect' && patch.affectDepth !== undefined) {
                c.affectDepth = Number(patch.affectDepth);
                delete c.boundClipId;
              }
              if (c.kind === 'effect' && patch.boundClipId !== undefined) {
                if (patch.boundClipId === null) delete c.boundClipId;
                else c.boundClipId = String(patch.boundClipId);
                delete c.affectDepth;
              }
              if (c.kind === 'audio' && patch.srcIn !== undefined) c.srcIn = Math.max(0, Number(patch.srcIn));
              if (c.kind !== 'source') return;
              if (patch.blend !== undefined) c.blend = patch.blend as BlendMode;
              if (patch.opacity !== undefined) c.opacity = Number(patch.opacity);
              if (patch.fit !== undefined) c.fit = patch.fit as SourceClip['fit'];
              if (patch.transform !== undefined) Object.assign(c.transform, patch.transform);
              if (patch.srcIn !== undefined && c.source.type === 'video') {
                c.source.srcIn = Math.max(0, Number(patch.srcIn));
              }
              if (keyNext !== undefined) {
                if (keyNext === null) delete c.key;
                else c.key = keyNext;
              }
              if (quadNext !== undefined) {
                if (quadNext === null) delete c.quad;
                else c.quad = quadNext;
              }
              // 全零裁剪删字段（与 UI 同纪律）：留着它会让渲染多开一条裁剪路径。
              if (cropNext !== undefined) {
                if (cropNext === null || isIdentityCrop(cropNext)) delete c.crop;
                else c.crop = cropNext;
              }
            });
          }
          if (wrap) store.endTx(label('set_clip_props'));
        } catch (e) {
          if (wrap) store.cancelTx();
          throw e;
        }

        // 回显**改后的值**（只回请求里那几个键）：`{changed:true}` 让 agent
        // 只能靠再读一次片段或出一张图来确认，往返成本远高于这句回执。
        const after = needClip(store, clipId).clip;
        const applied: Record<string, unknown> = {};
        for (const key of Object.keys(patch)) {
          switch (key) {
            case 'transform':
              applied.transform = after.kind === 'source' ? { ...after.transform } : null;
              break;
            case 'affectDepth':
              applied.affectDepth = after.kind === 'effect' ? (after.affectDepth ?? 0) : null;
              break;
            case 'boundClipId':
              // 解绑回显 null（`undefined` 会被 JSON.stringify 丢掉，模型会以为没生效）。
              applied.boundClipId = after.kind === 'effect' ? (after.boundClipId ?? null) : null;
              break;
            case 'fadeIn':
            case 'fadeOut':
              applied[key] = after.kind === 'audio' ? (key === 'fadeIn' ? (after.fadeIn ?? 0) : (after.fadeOut ?? 0)) : null;
              break;
            case 'srcIn':
              applied.srcIn =
                after.kind === 'audio'
                  ? after.srcIn
                  : after.kind === 'source' && after.source.type === 'video'
                    ? after.source.srcIn
                    : null;
              break;
            case 'key':
              applied.key = after.kind === 'source' ? (after.key ?? null) : null;
              break;
            case 'quad':
              applied.quad = after.kind === 'source' ? (after.quad ?? null) : null;
              break;
            case 'crop':
              applied.crop = after.kind === 'source' ? (after.crop ?? null) : null;
              break;
            case 'speed':
              applied.speed =
                after.kind === 'source' && after.source.type === 'video' ? after.source.speed : null;
              break;
            default:
              applied[key] = (after as unknown as Record<string, unknown>)[key];
          }
        }
        /*
         * 变速的**副作用**也要回显：素材不够时片段会被缩短（`setClipSpeed`
         * 的规则）。只回 `speed` 的话，agent 会以为长度没变，下一句就说错。
         */
        if (hasSpeed) applied.end = after.end;
        return { changed: store.version !== before, applied };
      });
    },

    async setClipSourceParams(clipId, params) {
      return run(() => {
        const store = beforeWrite();
        const clip = needSourceClip(store, clipId);
        const given = checkScalars(params, 'params');
        if (clip.source.type === 'algo') {
          checkKnownKeys(
            given,
            paramKeys(paramsOf(clip.source.generator)),
            tr('agent.what.generator', { id: clip.source.generator }),
          );
        } else if (clip.source.type === 'solid') {
          checkKnownKeys(given, ['color'], tr('agent.what.solid'));
        } else {
          throw new ControlFailure(
            'unsupported',
            tr('agent.clip.noSourceParams', { type: clip.source.type }),
          );
        }
        const before = store.version;
        store.updateClip(clipId, label('set_params'), (c) => {
          if (c.kind !== 'source') return;
          if (c.source.type === 'algo') Object.assign(c.source.params, given);
          else if (c.source.type === 'solid' && typeof given.color === 'string') c.source.color = given.color;
        });
        const after = needSourceClip(store, clipId);
        const values: Record<string, number | string> = {};
        for (const key of Object.keys(given)) {
          if (after.source.type === 'algo') values[key] = after.source.params[key] ?? given[key]!;
          else if (after.source.type === 'solid' && key === 'color') values.color = after.source.color;
        }
        return { changed: store.version !== before, values };
      });
    },

    async seedPatternFromAsset(clipId, param, assetId) {
      return run(async () => {
        const store = beforeWrite();
        const clip = needSourceClip(store, clipId);
        if (clip.source.type !== 'algo') {
          throw new ControlFailure('unsupported', tr('agent.algo.notAlgo', { id: clipId, type: clip.source.type }));
        }
        const def = getGenerator(clip.source.generator);
        if (!def) {
          throw new ControlFailure('not-found', tr('agent.gen.notFound', { id: clip.source.generator }));
        }
        const target = def.params.find((p) => p.key === param);
        if (!target || target.type !== 'pattern') {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.pattern.notPattern', { id: def.id, param }),
            { validIds: def.params.filter((p) => p.type === 'pattern').map((p) => p.key) },
          );
        }

        const assets = ctx.getAssets();
        if (!assets) throw new ControlFailure('unsupported', tr('agent.pattern.unsupported'));
        const declared = store.project.assets[assetId];
        const kind = declared?.kind ?? assets.input(assetId)?.kind;
        if (!kind) {
          throw new ControlFailure('not-found', tr('agent.asset.notFound', { id: assetId }), {
            validIds: Object.keys(store.project.assets),
          });
        }
        if (kind !== 'image') {
          throw new ControlFailure('invalid-argument', tr('agent.pattern.notImage', { id: assetId }));
        }
        const bytes = await assets.readAll(assetId);
        if (!bytes || bytes.byteLength === 0) {
          throw new ControlFailure('not-found', tr('agent.pattern.noBytes', { id: assetId }));
        }

        /*
         * 采样分辨率 = 模拟网格。图案盖回网格时是恒等映射，图片就是初始状态；
         * 用编辑器那个 32² 的话，256 宽的网格上只会在中间出现一小块。
         */
        const grid = gridSizeFromDefs(clip.source.params, def.params) ?? { w: 32, h: 32 };
        const name = assets.input(assetId)?.originName ?? '';
        const type = name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        // `Uint8Array<ArrayBufferLike>` 不满足 BlobPart（TS 5.9），切一份自己的 buffer。
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const bm = await bitmapFromImageBlob(new Blob([buf], { type }), grid.w, grid.h);
        if (!bm) {
          throw new ControlFailure('unsupported', tr('agent.pattern.decodeFailed', { id: assetId }));
        }
        const pattern = encodePattern(bm);

        // 图案与 `seedMode` 在同一笔撤销里：只写图案的话，生成器还在随机撒种，
        // 模型会以为工具没生效、再调一次。
        const seedParam = def.params.find((p) => p.key === 'seedMode');
        const canSeed =
          seedParam?.type === 'select' && seedParam.options.some((o) => o.value === 'pattern');
        store.updateClip(clipId, label('seed_pattern_from_asset'), (c) => {
          if (c.kind !== 'source' || c.source.type !== 'algo') return;
          c.source.params[param] = pattern;
          if (canSeed) c.source.params.seedMode = 'pattern';
        });
        return { param, pattern, w: bm.w, h: bm.h };
      });
    },

    async setGenerator(clipId, generator, params) {
      return run(() => {
        const store = beforeWrite();
        const clip = needSourceClip(store, clipId);
        if (clip.source.type !== 'algo') {
          throw new ControlFailure('unsupported', tr('agent.algo.notAlgo', { id: clipId, type: clip.source.type }));
        }
        const def = getGenerator(generator);
        if (!def) {
          throw new ControlFailure('not-found', tr('agent.algo.notFound', { id: generator }), {
            validIds: listGenerators().map((g) => g.id),
          });
        }
        const given = params === undefined ? {} : checkScalars(params, 'params');
        checkKnownKeys(given, paramKeys(def.params), tr('agent.what.generator', { id: generator }));
        const staleKeys = new Set(paramKeys(paramsOf(clip.source.generator)));
        /*
         * 参数默认值必须**一并写入**：只换 generator 名而沿用旧 params 的话，
         * 新生成器会拿到一堆它不认识的键（被静默忽略），画面停在上一次的形态上。
         */
        const next = { ...defaultParams(generator), ...given };
        const before = store.version;
        store.updateClip(clipId, label('set_generator'), (c) => {
          if (c.kind !== 'source' || c.source.type !== 'algo') return;
          c.source.generator = generator;
          c.source.params = { ...next };
          /*
           * 旧生成器的参数曲线在新生成器上没有对应物：留着它们既不会生效，
           * 又会让 `set_curve` 的可读名解析多出一批死键（与 UI `changeAlgo` 同一处置）。
           */
          for (const key of staleKeys) delete c.curves[key];
        });
        const after = needSourceClip(store, clipId);
        const values: Record<string, number | string> = {};
        if (after.source.type === 'algo') {
          for (const key of Object.keys(next)) values[key] = after.source.params[key] ?? next[key]!;
        }
        return { generator, params: values };
      });
    },

    async setEffectParams(clipId, chainIndex, values, enabled, mask) {
      return run(() => {
        const store = beforeWrite();
        const clip = needEffectClip(store, clipId);
        const inst = clip.chain[chainIndex];
        if (!inst) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.args.chainIndex', { index: chainIndex, max: clip.chain.length - 1 }),
          );
        }
        /*
         * 参数、开关、蒙版是可分开的：「关掉这条看差异」不该被迫带一个参数，
         * 反之亦然。三个都没给才是错误（那次调用什么都不会发生）。
         */
        if (values === undefined && enabled === undefined && mask === undefined) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.args.emptyPatch', { what: 'params / enabled / mask' }),
          );
        }
        const given = values === undefined ? {} : checkScalars(values, 'values');
        if (Object.keys(given).length > 0) {
          checkKnownKeys(
            given,
            paramKeys(getEffect(inst.defId)?.params),
            tr('agent.what.effect', { id: inst.defId }),
          );
        }
        /*
         * 蒙版引用：**所有校验都在写库之前**做完，这样「被拒」时工程一个字没动。
         * 环的判据与检查器共用 `core/mask.ts` —— 两处各写一份的话，
         * 「面板里能接、模型接不了」或者反过来，迟早出现。
         */
        let nextMask: MaskRef | null | undefined = undefined;
        if (mask !== undefined) {
          /*
           * 每个特效都接受蒙版（缺省的 `composite` 模式在链上混回），所以这里不判
           * 「这个 def 吃不吃蒙版」—— 判了就是把「只有声明过的才能用」重新引进来。
           */
          if (mask === null) {
            nextMask = null;
          } else {
            const clean = sanitizeMaskRef(mask);
            if (!clean) {
              throw new ControlFailure('invalid-argument', tr('agent.args.maskShape'));
            }
            if (clean.kind === 'clip') {
              const target = store.findClip(clean.clipId)?.clip;
              if (!target || target.kind !== 'source') {
                throw new ControlFailure(
                  'invalid-argument',
                  tr('agent.args.maskTarget', { id: clean.clipId }),
                );
              }
              if (maskRefCreatesCycle(store.project, clipId, clean.clipId)) {
                throw new ControlFailure('conflict', tr('agent.args.maskCycle'), {
                  hint: 'pick a clip that does not (transitively) reference this effect clip',
                });
              }
            } else if (clean.kind === 'asset') {
              if (store.project.assets[clean.assetId]?.kind !== 'image') {
                throw new ControlFailure(
                  'invalid-argument',
                  tr('agent.args.maskTarget', { id: clean.assetId }),
                );
              }
            }
            nextMask = clean;
          }
        }
        const before = store.version;
        if (values !== undefined || enabled !== undefined) {
          store.updateClip(clipId, label('set_params'), (c) => {
            if (c.kind !== 'effect') return;
            const target = c.chain[chainIndex];
            if (!target) return;
            if (enabled !== undefined) target.enabled = enabled;
            if (Object.keys(given).length > 0) Object.assign(target.values, given);
          });
        }
        if (nextMask !== undefined) {
          // store 那边会再判一次环（它是最后一道闸），这里失败说明两次判断之间被改过。
          if (!store.setEffectMaskRef(clipId, inst.instanceId, nextMask)) {
            throw new ControlFailure('conflict', tr('agent.args.maskCycle'));
          }
        }
        const after = needEffectClip(store, clipId).chain[chainIndex];
        const applied: Record<string, number | string> = {};
        for (const key of Object.keys(given)) applied[key] = after?.values[key] ?? given[key]!;
        return {
          changed: store.version !== before,
          values: applied,
          enabled: after?.enabled ?? true,
          mask: after ? (maskRefOf(after) ?? null) : null,
        };
      });
    },

    async setCurve(clipId, param, curve) {
      return run(() => {
        const store = beforeWrite();
        const { clip } = needClip(store, clipId);
        // 可读名 → 规范键（`blur.amount` → `<uuid>.amount`）。歧义时报候选。
        const key = resolveCurveKey(clip, param);
        // 缺 `interp` 时按 smooth 落库（工具描述里写明了默认值）。
        const normalized = curve === null ? null : withDefaultInterp(curve);
        if (normalized !== null) validateCurve(key, normalized);
        const before = store.version;
        store.updateClip(clipId, label('set_curve'), (c) => {
          if (normalized === null) delete c.curves[key];
          else c.curves[key] = normalized;
        });
        return { changed: store.version !== before, param: key };
      });
    },

    async listModulators() {
      return run(() => {
        const store = needStore();
        const clips = store.allClips();
        const list = store.project.modulators ?? [];
        return {
          modulators: list.map<ModulatorView>((m) => ({
            id: m.id,
            name: m.name,
            expr: m.expr,
            unit: { ...m.unit },
            refs: modulatorRefs(list, clips, m.id).map((r) => ({
              clipId: r.clipId,
              clipLabel: r.clipLabel,
              param: r.key,
              slots: r.slots,
            })),
          })),
          functions: exprFunctions(),
        };
      });
    },

    async setModulator(req) {
      return run(() => {
        const store = beforeWrite();
        const expr = typeof req.expr === 'string' ? req.expr.trim() : undefined;
        if (expr !== undefined) {
          const parsed = parseCached(expr);
          if (!parsed.ok) {
            throw new ControlFailure(
              'invalid-argument',
              tr('agent.mod.badExpr', { code: parsed.error.code, at: parsed.error.at + 1 }),
              { code: parsed.error.code, at: parsed.error.at },
            );
          }
        }
        const list = store.project.modulators ?? [];
        const target = req.id ? list.find((m) => m.id === req.id) : undefined;
        if (req.id && !target) {
          throw new ControlFailure('not-found', tr('agent.mod.notFound', { id: req.id }), {
            validIds: list.map((m) => m.id),
          });
        }
        if (!target && list.length >= MAX_MODULATORS) {
          throw new ControlFailure('conflict', tr('agent.mod.tooMany', { max: MAX_MODULATORS }));
        }
        // 区间：只给一端时另一端取旧值（改上下限不该要求两边都写）。
        const lo = req.min ?? target?.unit.min ?? -1;
        const hi = req.max ?? target?.unit.max ?? 1;
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
          throw new ControlFailure('invalid-argument', tr('agent.mod.badRange', { min: lo, max: hi }));
        }
        const id = target?.id ?? newId();
        const created = !target;
        const nextExpr = expr ?? target?.expr ?? defaultModulatorExpr();
        const nextName = (req.name ?? target?.name ?? tr('mod.defaultName', { n: list.length + 1 }))
          .trim()
          .slice(0, 40);
        /*
         * 一笔 commit 做完三件事（建 / 改名 / 改表达式），不是三次 store 方法调用：
         * 那样一次工具调用会留下三条撤销记录，用户按一下 Ctrl+Z 只退回三分之一。
         */
        store.commit(label('set_modulator'), (p) => {
          const arr = p.modulators ?? [];
          const entry = {
            id,
            name: nextName || id.slice(0, 8),
            expr: nextExpr,
            unit: { min: Math.min(lo, hi), max: Math.max(lo, hi) },
          };
          p.modulators = target ? arr.map((m) => (m.id === id ? entry : m)) : [...arr, entry];
        });
        const after = store.project.modulators ?? [];
        const refs = modulatorRefs(after, store.allClips(), id).reduce((n, r) => n + r.slots, 0);
        return { id, created, expr: nextExpr, refs };
      });
    },

    async removeModulator(id) {
      return run(() => {
        const store = beforeWrite();
        const list = store.project.modulators ?? [];
        if (!list.some((m) => m.id === id)) {
          throw new ControlFailure('not-found', tr('agent.mod.notFound', { id }), {
            validIds: list.map((m) => m.id),
          });
        }
        const refs = store.removeModulator(id);
        return { removed: true, refs: refs.reduce((n, r) => n + r.slots, 0) };
      });
    },

    async bindModulator(req) {
      return run(() => {
        const store = beforeWrite();
        const { clip } = needClip(store, req.clipId);
        const list = store.project.modulators ?? [];
        if (!list.some((m) => m.id === req.modulatorId)) {
          throw new ControlFailure('not-found', tr('agent.mod.notFound', { id: req.modulatorId }), {
            validIds: list.map((m) => m.id),
          });
        }
        // 与 set_curve 同一套可读名解析：`blur.amount` → `<uuid>.amount`，歧义即报错。
        const param = resolveCurveKey(clip, req.param);
        const gain = req.gain === undefined ? MOD_DEFAULT_GAIN : Number(req.gain);
        if (!Number.isFinite(gain)) {
          throw new ControlFailure('invalid-argument', tr('agent.mod.badGain', { gain: String(req.gain) }));
        }
        const mode = req.mode === 'mul' ? 'mul' : 'add';
        store.bindModulator(req.clipId, param, req.modulatorId, gain, mode);
        const after = needClip(store, req.clipId).clip;
        return { param, slots: (after.mods?.[param] ?? []).map((s) => ({ ...s })) };
      });
    },

    async unbindModulator(clipId, param, modulatorId) {
      return run(() => {
        const store = beforeWrite();
        const { clip } = needClip(store, clipId);
        const key = resolveCurveKey(clip, param);
        const current = clip.mods?.[key] ?? [];
        const next = modulatorId ? current.filter((s) => s.ref !== modulatorId) : [];
        if (next.length === current.length) {
          throw new ControlFailure('not-found', tr('agent.mod.notBound', { param: key }), {
            bound: current.map((s) => s.ref),
          });
        }
        store.setClipMods(clipId, key, next.length > 0 ? next : null);
        return { param: key, slots: next.length };
      });
    },

    async addEffect(clipId, defId, values, index, enabled) {
      return run(() => {
        const store = beforeWrite();
        const clip = needEffectClip(store, clipId);
        const def = getEffect(defId);
        if (!def) {
          throw new ControlFailure('not-found', tr('agent.fx.notFound', { id: defId }), {
            validIds: getCapabilities().effects.map((e) => e.id),
          });
        }
        const given = checkScalars(values ?? {}, 'values');
        checkKnownKeys(given, paramKeys(def.params), tr('agent.what.effect', { id: defId }));
        // 默认值补齐：agent 只给「想改的那几个」。
        const merged = { ...defaultEffectValues(defId), ...given };
        /*
         * 实例 id 用**完整** `newId()`，不再截 8 位。
         *
         * 曲线键是 `${instanceId}.${param}`，截短之后有两种 id 形态同时存在于工程里
         * （`add_effect_clip` 的 chain 给的是完整 id），模型必须记住「哪个接口返回的是
         * 哪种」才能写对 `set_curve` —— 它做不到，实测就只能在报错里抄 allowed。
         * 统一成完整 id 之后，返回值本身就能直接用。
         */
        const instanceId = newId();
        const at = index === undefined ? clip.chain.length : Math.max(0, Math.min(index, clip.chain.length));
        const on = enabled ?? true;
        store.updateClip(clipId, label('add_effect'), (c) => {
          if (c.kind !== 'effect') return;
          c.chain.splice(at, 0, { instanceId, defId, enabled: on, values: merged });
        });
        return { instanceId, chainIndex: at, keyPrefix: `${instanceId}.`, enabled: on };
      });
    },

    async removeEffect(clipId, chainIndex) {
      return run(() => {
        const store = beforeWrite();
        const clip = needEffectClip(store, clipId);
        if (!clip.chain[chainIndex]) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.args.chainIndex', { index: chainIndex, max: clip.chain.length - 1 }),
          );
        }
        store.updateClip(clipId, label('remove_effect'), (c) => {
          if (c.kind === 'effect') c.chain.splice(chainIndex, 1);
        });
        return { changed: true };
      });
    },

    async reorderEffect(clipId, from, to) {
      return run(() => {
        const store = beforeWrite();
        const clip = needEffectClip(store, clipId);
        const n = clip.chain.length;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.args.effectIndex', { max: n - 1 }),
            { from, to },
          );
        }
        if (from !== to) {
          store.updateClip(clipId, label('reorder_effect'), (c) => {
            if (c.kind !== 'effect') return;
            const [moved] = c.chain.splice(from, 1);
            if (moved) c.chain.splice(to, 0, moved);
          });
        }
        return { changed: from !== to };
      });
    },

    /* ---- 转场 ---- */

    async setTransition(clipId, defId, duration, values, side = 'out') {
      return run(() => {
        const store = beforeWrite();
        if (!getTransition(defId)) {
          throw new ControlFailure('not-found', tr('agent.tr.notFound', { id: defId }), {
            validIds: getCapabilities().transitions.map((t) => t.id),
          });
        }
        const host = transitionHostOf(store, clipId);
        if (!host) {
          throw new ControlFailure('unsupported', tr('agent.transition.host', { id: clipId }));
        }
        // 先用 core 的同一个函数问一次「这个剪切点能不能落」——store 那边对落不了
        // 地的情况是**静默不动**的，那种「什么都没发生」对 agent 不可接受。
        const cut = transitionCut(host.track, host.index, side as TransitionSide);
        if (!cut.ok) {
          throw new ControlFailure('unsupported', tr('agent.transition.cut', { reason: cut.reason }), {
            reason: cut.reason,
            side,
          });
        }
        const merged = { ...defaultTransitionValues(defId), ...(values ?? {}) };
        const before = store.version;
        store.setTransition(clipId, side as TransitionSide, defId, duration, merged);
        return { changed: store.version !== before, side };
      });
    },

    async clearTransition(clipId, side = 'out') {
      return run(() => {
        const store = beforeWrite();
        needClip(store, clipId);
        const before = store.version;
        store.setTransition(clipId, side as TransitionSide, '', 0, {});
        return { changed: store.version !== before };
      });
    },

    /* ---- 视频预剪辑（v13） ---- */

    async setAssetRange(assetId, input) {
      return run(() => {
        const store = beforeWrite();
        const view = rangesView(store, assetId);
        if (view.durationSec === null) {
          throw new ControlFailure('unsupported', tr('agent.args.unknownAsset', { id: assetId }));
        }
        const norm = normalizeRange(input, view.durationSec, view.fps);
        if (!norm) {
          throw new ControlFailure('invalid-argument', tr('agent.args.badRange'), { input });
        }
        const existing = input.id ? store.project.assets[assetId]?.ranges?.find((r) => r.id === input.id) : undefined;
        const range =
          existing !== undefined
            ? { ...existing, ...norm, ...(input.name ? { name: input.name } : {}) }
            : {
                ...newRange(
                  norm.inSec,
                  norm.outSec,
                  input.name ?? nextRangeName(view.ranges, (n) => tr('preclip.rangeDefault', { n })),
                ),
              };
        store.setAssetRange(assetId, range);
        return { ...rangesView(store, assetId), rangeId: range.id };
      });
    },

    async removeAssetRange(assetId, rangeId) {
      return run(() => {
        const store = beforeWrite();
        store.removeAssetRange(assetId, rangeId);
        return rangesView(store, assetId);
      });
    },

    async setActiveRange(assetId, rangeId) {
      return run(() => {
        const store = beforeWrite();
        store.setActiveRange(assetId, rangeId);
        return rangesView(store, assetId);
      });
    },

    /* ---- 视频音频（v13） ---- */

    async detachVideoAudio(clipId) {
      return run(() => {
        const store = beforeWrite();
        const audioClipId = store.detachVideoAudio(clipId);
        const audio = audioClipId ? store.findClip(audioClipId) : null;
        return { audioClipId, trackId: audio?.track.id ?? null };
      });
    },

    async setAudioLock(clipId, locked) {
      return run(() => {
        const store = beforeWrite();
        const before = store.version;
        store.setAudioLocked(clipId, locked);
        const clip = store.findClip(clipId)?.clip;
        return {
          changed: store.version !== before,
          lockedTo: clip?.kind === 'audio' ? (clip.lockedTo ?? null) : null,
        };
      });
    },

    async setClipAudio(clipId, patch) {
      return run(() => {
        const store = beforeWrite();
        needClip(store, clipId);
        const before = store.version;
        if (patch.gainDb !== undefined) store.setClipGainDb(clipId, patch.gainDb);
        if (patch.fadeIn !== undefined) store.setClipAudioFade(clipId, 'in', patch.fadeIn);
        if (patch.fadeOut !== undefined) store.setClipAudioFade(clipId, 'out', patch.fadeOut);
        if (patch.muted !== undefined) store.setVideoAudioMuted(clipId, patch.muted);
        return { changed: store.version !== before };
      });
    },

    /* ---- 工程 ---- */

    /**
     * 改工程级参数。**一个字段一笔 commit**（`ProjectStore` 的每个 setter 自带
     * 一个），所以一次给多字段会产生多条撤销记录 —— agent 想「一键撤销」应当
     * 先用 `beginTx` / `endTx` 把整段包起来。
     */
    async setProject(patch) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(patch) || Object.keys(patch).length === 0) {
          throw new ControlFailure('invalid-argument', tr('agent.args.emptyPatch', { what: 'patch' }));
        }
        const allowed = ['name', 'fps', 'resolution', 'duration', 'beatGrid', 'overlapBehavior'];
        const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
        if (bad.length > 0) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notWritable', { keys: bad.join(', ') }), {
            allowed,
          });
        }
        const changed: string[] = [];
        const step = (name: string, fn: () => void) => {
          const v0 = store.version;
          fn();
          if (store.version !== v0) changed.push(name);
        };
        if (patch.name !== undefined) {
          if (typeof patch.name !== 'string' || !patch.name.trim()) {
            throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'name' }));
          }
          step('name', () => store.setProjectName(String(patch.name)));
        }
        if (patch.fps !== undefined) step('fps', () => store.setFps(Number(patch.fps)));
        if (patch.resolution !== undefined) {
          const res = patch.resolution;
          if (!isRecord(res)) {
            throw new ControlFailure('invalid-argument', tr('agent.args.resolution'));
          }
          const w = Number(res.w);
          const h = Number(res.h);
          step('resolution', () => store.setResolution(w, h));
        }
        if (patch.duration !== undefined) step('duration', () => store.setDuration(Number(patch.duration)));
        if (patch.beatGrid !== undefined) {
          const grid = patch.beatGrid;
          if (!isRecord(grid)) {
            throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'beatGrid' }));
          }
          step('beatGrid', () =>
            store.setBeatGrid(grid as { bpm?: number; offset?: number; beatsPerBar?: number }),
          );
        }
        if (patch.overlapBehavior !== undefined) {
          const v = patch.overlapBehavior;
          if (v !== 'push' && v !== 'reject' && v !== 'trim') {
            throw new ControlFailure('invalid-argument', tr('agent.args.overlap', { value: String(v) }));
          }
          step('overlapBehavior', () => store.setOverlapBehavior(v));
        }
        return { changed };
      });
    },

    async setBeatMarks(marks) {
      return run(() => {
        const store = beforeWrite();
        if (!Array.isArray(marks)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'beatMarks' }));
        }
        /*
         * 校验前置（AGENTS「参数不合法时在改动之前抛」）：NaN / 负数会在吸附与
         * 画布换算里变成「线画到屏幕外、拖拽永远吸不到」的静默故障。
         * 数组顺序 / 重复点不报错 —— 那是语义上的集合，清洗成升序去重即可。
         */
        for (let i = 0; i < marks.length; i += 1) {
          const m = marks[i];
          if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) {
            throw new ControlFailure(
              'invalid-argument',
              tr('agent.args.seconds', { what: `beatMarks[${i}]` }),
            );
          }
        }
        const next = sanitizeBeatMarks(marks);
        const before = store.version;
        store.setBeatMarks(next);
        return { changed: store.version !== before, beatMarks: [...store.project.beatMarks] };
      });
    },

    async editSections(req) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(req) || typeof req.op !== 'string') {
          throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'op' }));
        }
        const sectionsOf = (): SceneSectionView[] =>
          store.project.sections.map((s) => ({
            id: s.id,
            name: s.name,
            start: s.start,
            ...(s.color ? { color: s.color } : {}),
          }));
        const need = (id: string) => {
          const section = store.project.sections.find((s) => s.id === id);
          if (!section) {
            throw new ControlFailure('not-found', tr('agent.section.notFound', { id }), {
              validIds: store.project.sections.map((s) => s.id),
            });
          }
          return section;
        };
        const before = JSON.stringify(store.project.sections);
        // 先取成 `string`：switch 的 default 分支里 `req` 已经被收窄成 never。
        const rawOp = String((req as { op?: unknown }).op);
        const startOf = (v: unknown, what: string): number => {
          if (!Number.isFinite(Number(v))) {
            throw new ControlFailure('invalid-argument', tr('agent.args.seconds', { what }));
          }
          // 段落只存起点；越界会让段落带跑到工程外（时间轴上表现为「最后一段不见了」）。
          return Math.min(Math.max(0, Number(v)), store.project.duration);
        };

        switch (req.op) {
          case 'add':
            store.addSection(startOf(req.start, 'start'), typeof req.name === 'string' ? req.name : undefined);
            break;
          case 'split': {
            const section = need(String(req.sectionId ?? ''));
            const at = startOf(req.at, 'at');
            const created = store.splitSection(section.id, at);
            if (!created) {
              /*
               * `splitSection` 在两半太窄时返回 null（菜单据此置灰）。静默成功会让
               * 模型以为切开了，然后对着一份没变的 sections 继续往下做。
               */
              throw new ControlFailure('invalid-argument', tr('agent.section.tooNarrow', { at }));
            }
            break;
          }
          case 'rename': {
            const section = need(String(req.sectionId ?? ''));
            const name = String(req.name ?? '').trim();
            if (!name) throw new ControlFailure('invalid-argument', tr('agent.section.badName'));
            store.renameSection(section.id, name);
            break;
          }
          case 'remove':
            store.removeSection(need(String(req.sectionId ?? '')).id);
            break;
          case 'move': {
            const section = need(String(req.sectionId ?? ''));
            store.moveSection(section.id, startOf(req.start, 'start'));
            break;
          }
          default:
            throw new ControlFailure('invalid-argument', tr('agent.section.badOp', { op: rawOp }), {
              validIds: ['add', 'split', 'rename', 'remove', 'move'],
            });
        }
        return { changed: JSON.stringify(store.project.sections) !== before, sections: sectionsOf() };
      });
    },

    async estimateBeatGrid() {
      return run(async () => {
        const store = beforeWrite();
        /*
         * 与时间轴的「一键估计」同一条判据：找**最早开始**的、且拿得到解码缓冲的
         * 音频片段。混流（mixdown）估不出拍 —— 鼓点会被别的轨糊掉。
         */
        let best: { id: string; start: number; srcIn: number; buffer: AudioBuffer } | null = null;
        for (const track of store.project.tracks) {
          if (track.kind !== 'audio') continue;
          for (const clip of track.clips) {
            if (clip.kind !== 'audio') continue;
            const buffer = ctx.getAudioBuffer(clip.assetId);
            if (!buffer) continue;
            if (!best || clip.start < best.start) {
              best = { id: clip.id, start: clip.start, srcIn: clip.srcIn, buffer };
            }
          }
        }
        if (!best) {
          throw new ControlFailure('unsupported', tr('agent.beat.noAudio'), {
            hint: 'audio clips are imported by the user; this needs one that is decoded',
          });
        }
        const estimate = await estimateTempo(best.buffer);
        if (!estimate || estimate.silent || !(estimate.confidence > 0)) {
          throw new ControlFailure('unsupported', tr('agent.beat.failed'));
        }
        const bpm = Math.max(20, Math.min(300, Math.round(estimate.bpm * 100) / 100));
        if (!Number.isFinite(bpm) || bpm <= 0) {
          throw new ControlFailure('unsupported', tr('agent.beat.failed'));
        }
        // offset 是「第 0 拍的秒数」：估计给的是相对音频起点的相位，片段可能被挪过 / 裁过。
        const offset = Math.round((estimate.offset + best.start - best.srcIn) * 10000) / 10000;
        store.setBeatGrid({ bpm, offset });
        return { bpm, offset, confidence: estimate.confidence, sourceClipId: best.id };
      });
    },

    async mediaPoolOp(req) {
      return run(async () => {
        const store = beforeWrite();
        if (!ctx.mediaPool) {
          throw new ControlFailure('unsupported', tr('agent.media.unsupported'));
        }
        if (!isRecord(req)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'mediaPoolOp' }));
        }
        const op = String(req.op ?? '');
        if (!MEDIA_POOL_OPS.includes(op as MediaPoolOp)) {
          throw new ControlFailure('invalid-argument', tr('agent.media.badOp', { op }), {
            validIds: MEDIA_POOL_OPS,
          });
        }
        const one = op === 'collect' || op === 'relink' || op === 'restore' || op === 'trash' || op === 'delete';
        const assetId = typeof req.assetId === 'string' ? req.assetId : '';
        if (one && !assetId) {
          throw new ControlFailure('invalid-argument', tr('agent.media.needAsset', { op }));
        }
        /*
         * 「操作媒体池需用户确认」：默认开着。关掉它等于把「移动 / 删除磁盘文件」
         * 交给模型自行决定，所以这里是**偏好**而不是工具参数 —— 模型不能自己批准
         * （`confirm` 只由会话层在用户点过之后传）。
         */
        if (req.confirm !== true && (ctx.getMediaPoolConfirm?.() ?? true)) {
          const name = (assetId && store.project.assets[assetId]?.name) || assetId;
          throw new ControlFailure('needs-approval', tr('agent.media.needsApproval', { op, name }), {
            kind: 'media',
            op,
            ...(assetId ? { assetId, assetName: name } : {}),
          });
        }
        const result = await ctx.mediaPool.run(op as MediaPoolOp, assetId || undefined);
        return { op, ...result };
      });
    },

    async renameAsset(assetId, name) {
      return run(() => {
        const store = beforeWrite();
        if (!store.project.assets[assetId]) {
          throw new ControlFailure('not-found', tr('agent.args.unknownAsset', { id: assetId }), { assetId });
        }
        const next = String(name ?? '').trim();
        if (!next) {
          throw new ControlFailure('invalid-argument', tr('agent.args.emptyName'), { assetId });
        }
        /*
         * 走装配点注入的那条路（它同时更新素材仓里的展示名镜像）；没有注入时
         * 退到工程表那一份 —— 只改名字，不碰任何字节。
         */
        if (ctx.mediaPool?.rename) ctx.mediaPool.rename(assetId, next);
        else store.renameAsset(assetId, next);
        return { assetId, name: next };
      });
    },

    /**
     * 整体改写（方案 §3.6 的路径 B）：传一份完整 `Project`。
     *
     * 走 `loadFrom` 而**不是** `replaceProject`：前者是「在当前工程里换内容」，
     * **可撤销**；后者清空撤销栈、只用于「打开 / 新建」。agent 的批量重排必须
     * 能被用户 Ctrl+Z 掉。
     */
    async loadScene(project) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(project)) {
          throw new ControlFailure('invalid-argument', tr('agent.scene.notObject'));
        }
        let migrated: Project;
        try {
          migrated = migrateProject(project);
        } catch (e) {
          throw new ControlFailure(
            'invalid-argument',
            tr('agent.scene.invalid', { detail: e instanceof Error ? e.message : String(e) }),
          );
        }
        store.loadFrom(migrated);
        let clips = 0;
        for (const tk of migrated.tracks) clips += tk.clips.length;
        return { tracks: migrated.tracks.length, clips };
      });
    },

    /* ---- 事务与撤销 ---- */

    async beginTx() {
      return run(() => {
        const store = beforeWrite();
        if (txOpen) throw new ControlFailure('conflict', tr('agent.tx.open'));
        store.beginTx();
        txOpen = true;
        return { open: true };
      });
    },

    async endTx(text) {
      return run(() => {
        const store = needStore();
        if (!txOpen) throw new ControlFailure('conflict', tr('agent.tx.none'));
        txOpen = false;
        return { changed: store.endTx(text || label('transaction')) };
      });
    },

    async cancelTx() {
      return run(() => {
        const store = needStore();
        if (!txOpen) return { open: false };
        txOpen = false;
        store.cancelTx();
        return { open: false };
      });
    },

    async undo() {
      return run(() => {
        ctx.cancelPendingGesture();
        return { changed: needStore().undo() };
      });
    },

    async redo() {
      return run(() => {
        ctx.cancelPendingGesture();
        return { changed: needStore().redo() };
      });
    },
  };

  /** 片段上「能打关键帧」的参数键（AGENTS §5.6 的键约定）。 */
  function curveKeysOf(clip: AnyClip): string[] {
    const SOURCE_KEYS = [
      'opacity',
      'transform.x',
      'transform.y',
      'transform.sx',
      'transform.sy',
      'transform.rot',
    ];
    if (clip.kind === 'audio') return ['gain'];
    if (clip.kind === 'effect') {
      const out: string[] = [];
      for (const inst of clip.chain) {
        for (const p of getEffect(inst.defId)?.params ?? []) {
          // 只有 range 参数能打关键帧（`runtime.evalParams` 只对 range 走曲线）。
          if (p.type === 'range') out.push(`${inst.instanceId}.${p.key}`);
        }
      }
      return out;
    }
    if (clip.source.type === 'algo') {
      const algoKeys = paramsOf(clip.source.generator)
        .filter((p) => p.type === 'range')
        .map((p) => p.key);
      return [...SOURCE_KEYS, ...algoKeys];
    }
    // 视频变速：`speed` 与 opacity / transform.* 同构，**允许负值**（倒放）。
    if (clip.source.type === 'video') return [...SOURCE_KEYS, 'speed'];
    return SOURCE_KEYS;
  }

  interface CurveCandidate {
    key: string;
    chainIndex: number;
    instanceId: string;
    defId: string;
  }

  /**
   * 把 agent 写的参数名解析成**规范键**。接受四种写法（工具描述里写明）：
   *
   *  - `opacity` / `transform.x` / 生成器参数键（source 片段）—— 原样
   *  - `<instanceId>.<key>`，instanceId 可以是**唯一前缀**（`fx-38a8` 能用）
   *  - `<defId>.<key>`，仅当链里该 defId 只出现一次（`blur.amount` 这种可读写法）
   *  - `<key>` 单独写，仅当全链只有一个实例有这个参数
   *
   * 有歧义时**报错并列出候选**（chainIndex + 完整 instanceId），而不是随便挑一个 ——
   * 挑错的表现是「我设的曲线跑到了另一个特效上」，从画面上极难看出来。
   */
  function resolveCurveKey(clip: AnyClip, param: string): string {
    const allowed = curveKeysOf(clip);
    const raw = String(param ?? '').trim();
    if (allowed.includes(raw)) return raw;

    const dot = raw.lastIndexOf('.');
    const key = dot > 0 ? raw.slice(dot + 1) : raw;
    const prefix = dot > 0 ? raw.slice(0, dot) : '';

    const candidates: CurveCandidate[] = [];
    if (clip.kind === 'effect') {
      for (const [chainIndex, inst] of clip.chain.entries()) {
        for (const p of getEffect(inst.defId)?.params ?? []) {
          if (p.type !== 'range') continue;
          candidates.push({
            key: `${inst.instanceId}.${p.key}`,
            chainIndex,
            instanceId: inst.instanceId,
            defId: inst.defId,
          });
        }
      }
    }
    const byKey = candidates.filter((c) => c.key === `${c.instanceId}.${key}`);

    const ambiguous = (list: CurveCandidate[]): never => {
      throw new ControlFailure('invalid-argument', tr('agent.curve.ambiguous', { param: raw, n: list.length }), {
        param: raw,
        candidates: list.map((c) => ({
          chainIndex: c.chainIndex,
          instanceId: c.instanceId,
          defId: c.defId,
          param: c.key,
        })),
      });
    };

    if (prefix) {
      const byInstance = byKey.filter((c) => c.instanceId.startsWith(prefix));
      if (byInstance.length === 1) return byInstance[0]!.key;
      if (byInstance.length > 1) return ambiguous(byInstance);

      const byDef = byKey.filter((c) => {
        const local = c.defId.split('/').pop() ?? c.defId;
        return c.defId === prefix || local === prefix;
      });
      if (byDef.length === 1) return byDef[0]!.key;
      if (byDef.length > 1) return ambiguous(byDef);
    } else if (byKey.length === 1) {
      return byKey[0]!.key;
    } else if (byKey.length > 1) {
      return ambiguous(byKey);
    }

    throw new ControlFailure('invalid-argument', tr('agent.curve.notCurvable', { id: clip.id, param: raw }), {
      allowed,
    });
  }

  /** 缺 `interp` 的 key 按 smooth 落库（工具描述里的默认值就是它）。 */
  function withDefaultInterp(curve: Curve): Curve {
    if (!isRecord(curve) || !Array.isArray(curve.keys)) return curve;
    return {
      ...curve,
      keys: curve.keys.map((k) => ({ ...k, interp: (k as { interp?: string }).interp ?? 'smooth' })) as Curve['keys'],
    };
  }

  /** 曲线形状校验。**形状不对会一路穿透到渲染期**，在那里表现为「参数不动」。 */
  function validateCurve(param: string, curve: Curve): void {
    if (!isRecord(curve) || !Array.isArray(curve.keys)) {
      throw new ControlFailure('invalid-argument', tr('agent.curve.shape', { param }));
    }
    if (curve.mode && !['keyframe', 'impulse', 'follower'].includes(curve.mode)) {
      throw new ControlFailure('invalid-argument', tr('agent.curve.mode', { mode: String(curve.mode) }));
    }
    let prev = -Infinity;
    for (const [i, k] of curve.keys.entries()) {
      if (!isRecord(k) || !Number.isFinite(Number(k.t)) || !Number.isFinite(Number(k.v))) {
        throw new ControlFailure('invalid-argument', tr('agent.curve.key', { param, index: i }));
      }
      // `interp` 缺省 = smooth（`withDefaultInterp` 已经补过；这里再放一次是为了
      // 让「手写 JSON 里漏了 interp」不成为一个必须靠报错才能学会的知识点）。
      if (k.interp !== undefined && !['linear', 'step', 'smooth', 'bezier'].includes(String(k.interp))) {
        throw new ControlFailure('invalid-argument', tr('agent.curve.interp', { param, index: i }));
      }
      /*
       * 手柄是渲染侧直接参与求值的数：形状不对会在 `segmentHandles` 里变成
       * NaN，然后整条曲线在**画面上静默消失**（参数恒定 / 不透明度 0）。
       * 这里只校验「有限数 + 维度」，方向与越界交给求值时的 clamp。
       */
      if (k.handles !== undefined && !isNumberArray(k.handles, 4)) {
        throw new ControlFailure('invalid-argument', tr('agent.curve.handles', { param, index: i }));
      }
      if (k.hOut !== undefined && !isNumberArray(k.hOut, 2)) {
        throw new ControlFailure('invalid-argument', tr('agent.curve.handle', { param, index: i }));
      }
      if (k.hIn !== undefined && !isNumberArray(k.hIn, 2)) {
        throw new ControlFailure('invalid-argument', tr('agent.curve.handle', { param, index: i }));
      }
      if (Number(k.t) < prev) throw new ControlFailure('invalid-argument', tr('agent.curve.order'));
      prev = Number(k.t);
    }
  }

  function transitionHostOf(
    store: ProjectStore,
    clipId: string,
  ): { track: Extract<Track, { kind: 'visual' }>; index: number } | null {
    for (const track of store.project.tracks) {
      if (track.kind !== 'visual') continue;
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index < 0) continue;
      if (track.clips[index]!.kind !== 'source') return null;
      return { track, index };
    }
    return null;
  }

  /* ------------------------------------------------------------ 看 */

  /**
   * 「临时钉尺寸 → 用完还原」的唯一入口。
   *
   * 为什么必须还原：`setExportSize` 之后 `syncSize` 会直接 return（它要尊重导出
   * 尺寸），于是预览会**停在导出分辨率**上，而这一步不报错（`main.ts:234-235`
   * 已经踩过）。`runExport` 自己只 `clearExportSize`，`syncSize` 得由调用方补
   * —— 这里把那两件事收在一处，调用方无从漏掉。
   */
  async function withPinnedSize<T>(
    renderer: Renderer,
    project: Project,
    size: Size,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    renderer.setExportSize(size.w, size.h);
    try {
      return await fn();
    } finally {
      renderer.clearExportSize();
      renderer.syncSize(project.resolution);
    }
  }

  /** 一次序列渲染的帧数上限：再多就该用 export 了（这里是给人/模型看节奏的）。 */
  const MAX_SEQUENCE_FRAMES = 24;
  /** 拼图单元之间的缝（px），只是为了让相邻帧的边界看得出来。 */
  const SHEET_GAP = 4;

  function clampRegion(r: Region): { x: number; y: number; w: number; h: number } {
    const x = Math.max(0, Math.min(1, Number(r.x) || 0));
    const y = Math.max(0, Math.min(1, Number(r.y) || 0));
    const w = Math.max(0.01, Math.min(1 - x, Number(r.w) || 1));
    const h = Math.max(0.01, Math.min(1 - y, Number(r.h) || 1));
    return { x, y, w, h };
  }

  /**
   * 局部放大：先按比例裁，再**最近邻整数倍放大**到至少 480px 宽。
   *
   * 为什么放大而不是只裁：模型的视觉编码器在 200×120 的图上看不出 ASCII / 半调
   * 的细节，而「为看细节把整帧提到 1920」既慢又白付 90% 的 token。裁 + 放大
   * 把像素预算花在真正要判断的那一块上。
   */
  function cropAndZoom(
    frame: { w: number; h: number; rgba: Uint8Array },
    region: Region,
  ): { w: number; h: number; rgba: Uint8Array } {
    const r = clampRegion(region);
    const x0 = Math.min(frame.w - 1, Math.max(0, Math.round(r.x * frame.w)));
    const y0 = Math.min(frame.h - 1, Math.max(0, Math.round(r.y * frame.h)));
    const cw = Math.max(1, Math.min(frame.w - x0, Math.round(r.w * frame.w)));
    const ch = Math.max(1, Math.min(frame.h - y0, Math.round(r.h * frame.h)));
    const cropped = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const src = ((y0 + y) * frame.w + x0) * 4;
      cropped.set(frame.rgba.subarray(src, src + cw * 4), y * cw * 4);
    }
    const factor = Math.max(1, Math.min(8, Math.ceil(480 / Math.max(1, cw))));
    if (factor === 1) return { w: cw, h: ch, rgba: cropped };
    const ow = cw * factor;
    const oh = ch * factor;
    const out = new Uint8Array(ow * oh * 4);
    for (let y = 0; y < oh; y++) {
      const sy = Math.floor(y / factor);
      for (let x = 0; x < ow; x++) {
        const sx = Math.floor(x / factor);
        const s = (sy * cw + sx) * 4;
        const d = (y * ow + x) * 4;
        out[d] = cropped[s]!;
        out[d + 1] = cropped[s + 1]!;
        out[d + 2] = cropped[s + 2]!;
        out[d + 3] = cropped[s + 3]!;
      }
    }
    return { w: ow, h: oh, rgba: out };
  }

  /** RGBA → PNG（走一张 2D canvas；`preserveDrawingBuffer` 那条路代价更高，见 snapshotPng）。 */
  async function encodePng(frame: { w: number; h: number; rgba: Uint8Array }): Promise<Uint8Array> {
    const canvas = document.createElement('canvas');
    canvas.width = frame.w;
    canvas.height = frame.h;
    const c2d = canvas.getContext('2d');
    if (!c2d) throw new ControlFailure('internal', tr('agent.view.no2d'));
    c2d.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.w, frame.h), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new ControlFailure('internal', tr('agent.view.pngFailed'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** GL 的原点在**左下**，`ImageData` 的第 0 行在**顶部** —— 翻一次，否则图是倒的。 */
  function flipRows(data: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(data.length);
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * stride;
      out.set(data.subarray(src, src + stride), y * stride);
    }
    return out;
  }

  /**
   * 单帧求值：钉尺寸 → 跳帧对齐 → 等文字层就绪 → 渲染 → **在同一段钉尺寸里读回**。
   *
   * 三件不能省的事：
   *  - `onSeek()`：反馈类（echo）/ sim 类特效的历史是**跨帧状态**，不清历史就等于
   *    在「泵历史」，拿到的图带着上一次查询的残留（方案 §5.3）。
   *  - `prepareFrame`：排版层的位图是**异步光栅化**的。不 await 的话，agent 加完
   *    文字片段后第一次取图会拿到一张没有字的图（导出循环里也是这么做的）。
   *  - 吸附 t：`round(t·fps)/fps`，否则反馈帧与导出帧不是同一帧。
   *
   * **读必须在钉尺寸的内层**：`syncSize` 会改 canvas 尺寸，而改尺寸会**清空
   * 帧缓冲** —— 先还原尺寸再 `readPixels` 拿到的是一张黑图（而且不报错）。
   */
  async function drawAndRead(
    renderer: Renderer,
    project: Project,
    tRaw: number,
    size: Size,
  ): Promise<{ t: number; w: number; h: number; rgba: Uint8Array }> {
    const t = timeOf(frameOf(tRaw, project.fps), project.fps);
    const frame = await withPinnedSize(renderer, project, size, async () => {
      renderer.onSeek();
      await renderer.prepareFrame(project, t);
      renderer.renderFrame(project, t);
      const { data, w, h } = renderer.readPixels();
      return { w, h, rgba: flipRows(data, w, h) };
    });
    lastFrame = frame;
    return { t, ...frame };
  }

  function signatureSize(resolution: Size): Size {
    // 指纹默认小尺寸：性能类测量只能从小尺寸做，而且 agent 往返更快。
    const w = Math.min(320, Math.max(2, resolution.w));
    return normalizeSize({ w, h: (w * resolution.h) / Math.max(1, resolution.w) });
  }

  /**
   * 隔离渲染：给渲染器一份「只留指定层」的 project。
   *
   * **工程本身不动**（不 commit、不 bump version）：这是一次观察，不是编辑。
   * 浅拷贝轨道 / 片段，只把被隐藏的 `enabled` 与目标文档的 `visible` 换成新值
   * —— 其余引用原样共享（渲染只读）。
   */
  function asIdList(v: string | string[] | undefined): string[] {
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.length > 0);
  }

  function isolatedProject(project: Project, only: RenderOnly | undefined): Project {
    const trackIds = asIdList(only?.trackId);
    const elementIds = asIdList(only?.elementId);
    if (trackIds.length === 0 && elementIds.length === 0) return project;
    let tracks: Project['tracks'] = project.tracks;

    if (trackIds.length > 0) {
      const keep = new Set<string>();
      for (const id of trackIds) {
        const target = tracks.find((t) => t.id === id);
        if (!target) {
          throw new ControlFailure('not-found', tr('agent.track.notFound', { id }), { trackId: id });
        }
        if (target.kind !== 'visual') {
          throw new ControlFailure('invalid-argument', tr('agent.track.cannotHost', { id, kind: 'visual' }), {
            trackId: id,
          });
        }
        keep.add(id);
      }
      tracks = tracks.map((t) => (t.kind === 'visual' && !keep.has(t.id) ? { ...t, enabled: false } : t));
    }

    if (elementIds.length > 0) {
      const keep = new Set(elementIds);
      const found = new Set<string>();
      tracks = tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.kind !== 'source' || c.source.type !== 'text') return c;
          const hits = c.source.doc.elements.filter((e) => keep.has(e.id));
          if (hits.length === 0) return c;
          for (const e of hits) found.add(e.id);
          return {
            ...c,
            source: {
              ...c.source,
              doc: {
                ...c.source.doc,
                elements: c.source.doc.elements.map((e) => ({ ...e, visible: keep.has(e.id) })),
              },
            },
          };
        }),
      })) as Project['tracks'];
      for (const id of elementIds) {
        if (!found.has(id)) {
          throw new ControlFailure('not-found', tr('agent.typo.elementNotFound', { id }), { elementId: id });
        }
      }
    }
    return { ...project, tracks };
  }

  /**
   * 这一帧**真正参与合成**的图层。
   *
   * `render_frame` / `frame_signature` 的返回里要回显它：只有画面时，agent 分不清
   * 「隔离把特效轨也隐藏了」与「我改的参数没用」—— 这两种情况的截图一模一样。
   * 直接读 `buildStack` 的产物，保证与渲染器看到的是同一份 op。
   */
  function participatingLayers(
    project: Project,
    t: number,
  ): { trackId: string; name: string; clips: { id: string; kind: string }[] }[] {
    const ops = buildStack(project, t);
    const active = new Set<string>();
    walkOps(ops, (op) => {
      if (op.type === 'source') active.add(op.source.clip.id);
      else if (op.type === 'transition') {
        for (const side of transitionSources(op)) active.add(side.clip.id);
      } else active.add(op.clip.id);
    });
    const out: { trackId: string; name: string; clips: { id: string; kind: string }[] }[] = [];
    for (const track of project.tracks) {
      if (track.kind !== 'visual' || !track.enabled) continue;
      const clips = track.clips
        .filter((c) => active.has(c.id))
        .map((c) => ({ id: c.id, kind: c.kind === 'effect' ? (c.boundClipId ? 'effect(bound)' : 'effect') : 'source' }));
      if (clips.length > 0) out.push({ trackId: track.id, name: track.name, clips });
    }
    return out;
  }

  const view: Pick<
    AgentControlPlane,
    'renderFrame' | 'readPixels' | 'frameSignature' | 'snapshotPng' | 'renderSequence' | 'frameLayers'
  > = {
    async renderFrame(opt) {
      return run(async () => {
        const store = needStore();
        const renderer = needRenderer();
        const project = isolatedProject(store.project, opt?.only);
        const size = normalizeSize(opt?.size ?? project.resolution);
        const frame = await drawAndRead(renderer, project, opt?.t ?? ctx.getPlayT(), size);
        return { t: frame.t, w: frame.w, h: frame.h };
      });
    },

    /**
     * 读回最近一次「看」的像素。
     *
     * 契约上是「读当前帧缓冲」，实现上是**把 `renderFrame` / `snapshotPng` /
     * `frameSignature` 刚刚读到的同一份像素交回来** —— 因为出图路径用完就把
     * canvas 尺寸还回去了，而改尺寸会清空帧缓冲，事后真的去读只能读到黑图。
     * 交回来的这份就是那一刻的帧缓冲，逐字节相同。
     */
    async readPixels() {
      return run(() => {
        needRenderer();
        if (!lastFrame) throw new ControlFailure('not-ready', tr('agent.view.noFrame'));
        return { ...lastFrame };
      });
    },

    /**
     * 数值指纹。**默认给这个，不要默认给 PNG**（方案 §5.1）：
     * 一张图像输入约合上千 token，而指纹只有几十个数字。
     */
    async frameSignature(opt) {
      return run<FrameSignature>(async () => {
        const store = needStore();
        const renderer = needRenderer();
        const project = isolatedProject(store.project, opt?.only);
        const size = normalizeSize(opt?.size ?? signatureSize(project.resolution));
        const frame = await drawAndRead(renderer, project, opt?.t ?? ctx.getPlayT(), size);
        return frameSignatureOf({
          rgba: frame.rgba,
          w: frame.w,
          h: frame.h,
          grid: opt?.grid,
          t: frame.t,
        });
      });
    },

    /** PNG 截图。**只在需要「看」的时候用**（审美判断 / 最终验收 / 给人看）。 */
    async snapshotPng(opt) {
      return run<Uint8Array>(async () => {
        const store = needStore();
        const renderer = needRenderer();
        const project = isolatedProject(store.project, opt?.only);
        const size = normalizeSize(opt?.size ?? project.resolution);
        const frame = await drawAndRead(renderer, project, opt?.t ?? ctx.getPlayT(), size);
        // 局部放大在**读回之后**做（裁 + 最近邻放大），不需要再渲一遍。
        const shown = opt?.region ? cropAndZoom(frame, opt.region) : frame;
        return encodePng(shown);
      });
    },

    /**
     * 节奏自检：把一段时间的若干帧拼成**一张**联系表（contact sheet）。
     *
     * 为什么不是「返回 N 张图」：一张 6 格的拼图 ≈ 1 张图的 token，而 N 张就是 N 倍；
     * 判断卡点 / 动势也正需要**并排**比较。时间戳烧在每格底下，否则模型分不清
     * 「第几格是第几秒」。
     */
    async renderSequence(opt) {
      return run<{ png: Uint8Array; times: number[]; cols: number; rows: number; w: number; h: number }>(
        async () => {
          const store = needStore();
          const renderer = needRenderer();
          const project = isolatedProject(store.project, opt?.only);
          const duration = store.project.duration;
          const from = Math.max(0, Math.min(duration, Number(opt?.from ?? 0)));
          const to = Math.max(from + 1 / project.fps, Math.min(duration, Number(opt?.to ?? duration)));
          const want = Math.round(Number(opt?.cols ?? 3));
          const cols = Math.max(1, Math.min(6, Number.isFinite(want) ? want : 3));

          // 默认 6 帧均匀铺开；给了 step 就按 step（秒）走。
          const rawStep = Number(opt?.step);
          const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : Math.max(1 / project.fps, (to - from) / 5);
          const times: number[] = [];
          for (let t = from; t < to - 1e-6 && times.length < MAX_SEQUENCE_FRAMES; t += step) times.push(t);
          if (times.length === 0) times.push(from);

          const cell = normalizeSize(
            opt?.size ?? { w: 320, h: Math.max(2, Math.round((320 * project.resolution.h) / Math.max(1, project.resolution.w))) },
          );
          const rows = Math.ceil(times.length / cols);
          const sheetW = cols * cell.w + (cols - 1) * SHEET_GAP;
          const sheetH = rows * cell.h + (rows - 1) * SHEET_GAP;
          const canvas = document.createElement('canvas');
          canvas.width = sheetW;
          canvas.height = sheetH;
          const c2d = canvas.getContext('2d');
          if (!c2d) throw new ControlFailure('internal', tr('agent.view.no2d'));
          c2d.fillStyle = '#000000';
          c2d.fillRect(0, 0, sheetW, sheetH);
          c2d.font = '11px monospace';
          c2d.textBaseline = 'bottom';

          for (const [i, t] of times.entries()) {
            const frame = await drawAndRead(renderer, project, t, cell);
            const shown = opt?.region ? cropAndZoom(frame, opt.region) : frame;
            const x = (i % cols) * (cell.w + SHEET_GAP);
            const y = Math.floor(i / cols) * (cell.h + SHEET_GAP);
            const patch = document.createElement('canvas');
            patch.width = shown.w;
            patch.height = shown.h;
            const p2d = patch.getContext('2d');
            if (!p2d) throw new ControlFailure('internal', tr('agent.view.no2d'));
            p2d.putImageData(new ImageData(new Uint8ClampedArray(shown.rgba), shown.w, shown.h), 0, 0);
            c2d.imageSmoothingEnabled = false;
            c2d.drawImage(patch, 0, 0, shown.w, shown.h, x, y, cell.w, cell.h);
            // 时间戳条：底下 14px，只盖住画面最下沿（构图判断不受影响）。
            c2d.fillStyle = 'rgba(0,0,0,0.72)';
            c2d.fillRect(x, y + cell.h - 14, cell.w, 14);
            c2d.fillStyle = '#ffffff';
            c2d.fillText(`${t.toFixed(2)}s  #${i + 1}`, x + 4, y + cell.h - 3);
          }

          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw new ControlFailure('internal', tr('agent.view.pngFailed'));
          return {
            png: new Uint8Array(await blob.arrayBuffer()),
            times,
            cols,
            rows,
            w: sheetW,
            h: sheetH,
          };
        },
      );
    },

    /** 这一帧参与的图层（`only` 之外的那些不会出现在里面）。 */
    async frameLayers(opt) {
      return run(() => {
        const store = needStore();
        const project = isolatedProject(store.project, opt?.only);
        const t = timeOf(frameOf(opt?.t ?? ctx.getPlayT(), project.fps), project.fps);
        return { t, layers: participatingLayers(project, t) };
      });
    },
  };

  /* ------------------------------------------------------------ 导 */

  async function runOneExport(opt: ExportRequest): Promise<ExportArtifact> {
    const store = needStore();
    const renderer = needRenderer();
    const project = store.project;
    if (exportRun) throw new ControlFailure('busy', tr('agent.export.busy'));
    if (!['mp4', 'png', 'gif'].includes(opt.format)) {
      throw new ControlFailure('invalid-argument', tr('agent.export.badFormat', { format: String(opt.format) }));
    }

    let sink: ExportOptions['sink'];
    let codec: string | undefined;
    let size = opt.size ? normalizeSize(opt.size) : undefined;
    let frameStep = opt.frameStep;
    let frameRange = opt.frameRange;

    if (opt.format === 'mp4') {
      if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        // 复用 UI 那条同义文案：agent 与面板给的是同一个下一步动作。
        throw new ControlFailure('unsupported', tr('err.export.noWebCodecs'));
      }
      // 与 UI 走同一条阶梯：无硬编的机器只有 Constrained Baseline。
      const exportSize = size ?? project.resolution;
      const choice = await probeMp4Codec({ w: exportSize.w, h: exportSize.h, fps: project.fps });
      if (!choice) throw new ControlFailure('unsupported', tr('err.export.noH264'));
      // 视频内嵌音轨是异步解码的；`mixdown` 同步取 buffer，所以先预热。
      await ctx.prepareAudio?.(project);
      const audio = mixdown(project, (id) => ctx.getAudioBuffer(id));
      sink = new Mp4Sink({ audio });
      codec = choice.codec;
    } else if (opt.format === 'png') {
      sink = new PngSequenceSink();
    } else {
      // GIF 的尺寸 / 抽帧由 `gif-plan` 算（秒 → 帧号只在那里发生一次）。
      // agent 给的是帧号，所以这里把区间换回秒再交出去 —— 往返是精确的。
      const plan = planGif({
        srcSize: project.resolution,
        srcFps: project.fps,
        duration: project.duration,
        range: frameRange
          ? { start: frameRange.from / project.fps, end: frameRange.to / project.fps }
          : undefined,
        width: size?.w ?? GIF_FALLBACK_WIDTH,
        fps: frameStep && frameStep > 0 ? project.fps / frameStep : GIF_FALLBACK_FPS,
      });
      size = plan.size;
      frameStep = plan.frameStep;
      frameRange = plan.frameRange;
      sink = new GifSink({
        width: plan.size.w,
        height: plan.size.h,
        maxColors: GIF_MAX_COLORS,
        delaysMs: plan.delaysMs,
        loop: 0,
      });
      codec = GIF_SINK_CODEC;
    }

    // 进度分母必须与 runExport 同口径（抽帧 / 区间都会改它），否则进度条永远
    // 到不了 100%。
    const total = Math.max(1, Math.ceil(project.duration * project.fps));
    const from = Math.min(Math.max(0, Math.floor(frameRange?.from ?? 0)), total - 1);
    const to = Math.min(Math.max(from + 1, Math.ceil(frameRange?.to ?? total)), total);
    const step = Math.max(1, Math.floor(frameStep ?? 1));
    const totalFrames = Math.max(1, Math.ceil((to - from) / step));

    const ctrl = new AbortController();
    exportAbort = ctrl;
    const forward = () => ctrl.abort();
    opt.signal?.addEventListener('abort', forward, { once: true });
    exportRun = { format: opt.format, frac: 0, frames: 0, totalFrames, startedAt: Date.now() };

    try {
      const out = await runExport(renderer, project, {
        sink,
        codec,
        size,
        frameStep,
        frameRange,
        // GIF 是纯 CPU 编码（每帧几十毫秒），默认 10 帧让渡一次会让取消按钮
        // 半秒才响应。理由见 ExportOptions.yieldEvery。
        yieldEvery: opt.format === 'gif' ? 1 : 10,
        onProgress: (frac) => {
          if (exportRun) exportRun.frac = frac;
          opt.onProgress?.(frac);
        },
        onFrame: (ms, index) => {
          if (exportRun) exportRun.frames += 1;
          opt.onFrame?.(ms, index);
        },
        signal: ctrl.signal,
      });
      const blob = out as Blob;
      return { format: opt.format, bytes: blob.size, mimeType: MIME[opt.format], blob };
    } finally {
      opt.signal?.removeEventListener('abort', forward);
      exportAbort = null;
      exportRun = null;
      // `runExport` 的 finally 只 clearExportSize，syncSize 得调用方补 ——
      // 不补的话预览停在导出分辨率上（而且不报错）。
      renderer.syncSize(store.project.resolution);
      ctx.refreshPreview();
    }
  }

  const io: Pick<AgentControlPlane, 'export' | 'exportBase64' | 'abortExport'> = {
    async export(opt) {
      return run(() => runOneExport(opt));
    },

    /** 跨传输层的导出：字节也一起给（base64）。 */
    async exportBase64(opt) {
      return run<ExportArtifactBase64>(async () => {
        const art = await runOneExport(opt);
        const base64 = await bytesToBase64(new Uint8Array(await art.blob.arrayBuffer()));
        return { format: art.format, bytes: art.bytes, mimeType: art.mimeType, base64 };
      });
    },

    async abortExport() {
      return run(() => {
        if (!exportAbort) return { aborted: false };
        exportAbort.abort();
        return { aborted: true };
      });
    },
  };

  /* ----------------------------------------------------- 工程级动作 */

  const projectActions: Pick<AgentControlPlane, 'saveProject' | 'openProject'> = {
    async saveProject() {
      return run(async () => {
        if (!(await ctx.saveProject())) {
          throw new ControlFailure('unsupported', tr('agent.export.saveFailed'));
        }
        return { saved: true as const };
      });
    },

    async openProject(name) {
      return run(async () => {
        ctx.cancelPendingGesture();
        const opened = await ctx.openProject(name);
        return { opened };
      });
    },
  };

  /* ------------------------------------------------------------ 排版 */

  const typography: Pick<
    AgentControlPlane,
    | 'addTypographyElement'
    | 'addTypographyElements'
    | 'addGeneratedShape'
    | 'updateTypographyElement'
    | 'updateTypographyElements'
    | 'setTypographyAnimation'
    | 'setTypographyScripts'
    | 'copyTypographyStyle'
    | 'setTypographyText'
    | 'removeTypographyElement'
    | 'reorderTypographyElement'
    | 'groupTypographyElements'
    | 'ungroupTypographyElements'
    | 'layoutTypography'
    | 'measureTypography'
    | 'setTypographyBackground'
    | 'setTypographyTheme'
    | 'saveTypographyTheme'
    | 'removeTypographyTheme'
    | 'setTypographyCanvasSize'
    | 'setTypographyCamera'
    | 'setTypographyCameraAnimation'
    | 'updateTypographyGroup'
    | 'booleanTypographyShapes'
    | 'divideTypographyShapes'
    | 'convertTypographyToPath'
    | 'replaceTypographyDoc'
  > = {
    /**
     * 设 / 清 / 追加一个元素动画。`input === null` = 清空。
     *
     * `at` 支持 `{ beat: n }` 的换算在这一层做（要读 `project.beatGrid`）：
     * 文档模型不认识 BPM，把「拍」的换算法留在工具面上，`typography/` 只收秒。
     */
    async setTypographyAnimation(clipId, elementId, input, mode) {
      return run(() => {
        const store = beforeWrite();
        const id = typoClipId(clipId);
        // `t` 是相对片段起点的秒，拍换算要用片段起点把工程绝对时间折回来。
        const clipStart = store.findClip(id)?.clip.start ?? 0;
        return typo.setElementAnimation(
          store,
          id,
          elementId,
          resolveBeatKeys(store, input, clipStart),
          mode ?? 'replace',
        );
      });
    },
    async setTypographyScripts(clipId, scripts) {
      return run(() => {
        const store = beforeWrite();
        return typo.setScripts(store, typoClipId(clipId), scripts);
      });
    },
    async copyTypographyStyle(clipId, sourceId, targetIds, what) {
      return run(() => {
        const store = beforeWrite();
        return typo.copyElementStyle(store, typoClipId(clipId), sourceId, targetIds, what ?? 'format');
      });
    },

    async addTypographyElement(clipId, input) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(input)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'element' }));
        }
        return typo.addElement(store, typoClipId(clipId), input as TypographyElementInput);
      });
    },

    async addTypographyElements(clipId, inputs) {
      return run(() => {
        const store = beforeWrite();
        if (!Array.isArray(inputs)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'elements' }));
        }
        return typo.addElements(store, typoClipId(clipId), inputs as TypographyElementInput[]);
      });
    },

    async addGeneratedShape(clipId, input) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(input) || typeof input.genId !== 'string') {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badGen', { id: String(input?.genId) }));
        }
        return typo.addGenerated(store, typoClipId(clipId), input);
      });
    },

    async updateTypographyElement(clipId, elementId, patch) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(patch) || Object.keys(patch).length === 0) {
          throw new ControlFailure('invalid-argument', tr('agent.args.emptyPatch', { what: 'patch' }));
        }
        return typo.updateElement(store, typoClipId(clipId), elementId, patch);
      });
    },

    async updateTypographyElements(clipId, updates) {
      return run(() => {
        const store = beforeWrite();
        if (!Array.isArray(updates)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'updates' }));
        }
        return typo.updateElements(store, typoClipId(clipId), updates as TypographyElementUpdate[]);
      });
    },

    async setTypographyText(clipId, elementId, text) {
      return run(() => {
        const store = beforeWrite();
        return typo.setText(store, typoClipId(clipId), elementId, text);
      });
    },

    async removeTypographyElement(clipId, elementId) {
      return run(() => {
        const store = beforeWrite();
        return { changed: typo.removeElement(store, typoClipId(clipId), elementId) };
      });
    },

    async reorderTypographyElement(clipId, elementId, op, index) {
      return run(() => {
        const store = beforeWrite();
        if (!['front', 'back', 'forward', 'backward', 'index'].includes(op)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badLayout', { detail: `op=${String(op)}` }), {
            validIds: ['front', 'back', 'forward', 'backward', 'index'],
          });
        }
        if (op === 'index' && !Number.isFinite(Number(index))) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notFinite', { what: 'index', key: 'index' }));
        }
        return typo.reorderElement(store, typoClipId(clipId), elementId, op, index);
      });
    },

    async groupTypographyElements(clipId, elementIds, name) {
      return run(() => {
        const store = beforeWrite();
        if (!Array.isArray(elementIds) || elementIds.length < 2) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badLayout', { detail: 'group needs >= 2 elementIds' }));
        }
        return typo.groupElements(store, typoClipId(clipId), elementIds, name ?? 'group');
      });
    },

    async ungroupTypographyElements(clipId, elementIds) {
      return run(() => {
        const store = beforeWrite();
        if (!Array.isArray(elementIds) || elementIds.length === 0) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badLayout', { detail: 'elementIds is empty' }));
        }
        return { changed: typo.ungroupElements(store, typoClipId(clipId), elementIds) };
      });
    },

    async layoutTypography(clipId, req) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(req) || typeof req.op !== 'string') {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badLayout', { detail: 'op is required' }));
        }
        return typo.layout(store, typoClipId(clipId), req);
      });
    },

    async measureTypography(clipId, elementIds) {
      return run<TypographyMeasure>(async () => {
        // 纯读：不停手势、不 commit。字体没加载完时量出来是回落字体的宽度 ——
        // 与导出那条「必须 await document.fonts.ready」同一条理由。
        if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
        const store = needStore();
        return typo.measure(store, typoClipId(clipId), elementIds);
      });
    },

    async setTypographyBackground(clipId, paint) {
      return run(() => {
        const store = beforeWrite();
        return { changed: typo.setBackground(store, typoClipId(clipId), paint) };
      });
    },

    async setTypographyTheme(clipId, theme, scope) {
      return run(() => {
        const store = beforeWrite();
        const resolvedScope = scope === 'project' ? 'project' : 'clip';
        const id = resolvedScope === 'project' ? optionalTypoClipId(clipId) : typoClipId(clipId);
        return { changed: typo.setTheme(store, id, theme, resolvedScope), scope: resolvedScope };
      });
    },

    async saveTypographyTheme(clipId, input) {
      return run(() => {
        const store = beforeWrite();
        const scope = input?.scope === 'project' ? 'project' : 'clip';
        const id = scope === 'project' ? optionalTypoClipId(clipId) : typoClipId(clipId);
        return typo.saveTheme(store, id, {
          ...(typeof input.id === 'string' ? { id: input.id } : {}),
          ...(typeof input.base === 'string' ? { base: input.base } : {}),
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(input.colors === undefined ? {} : { colors: input.colors }),
          scope,
        });
      });
    },

    async removeTypographyTheme(themeId) {
      return run(() => {
        const store = beforeWrite();
        return typo.removeTheme(store, String(themeId ?? ''));
      });
    },

    async setTypographyCanvasSize(clipId, size, scaleContent) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(size)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badCanvas'), { size });
        }
        return typo.setCanvasSize(
          store,
          typoClipId(clipId),
          { w: Number(size.w), h: Number(size.h) },
          Boolean(scaleContent),
        );
      });
    },

    async setTypographyCamera(clipId, camera) {
      return run(() => {
        const store = beforeWrite();
        return typo.setCamera(store, typoClipId(clipId), camera === undefined ? null : camera);
      });
    },

    async setTypographyCameraAnimation(clipId, channel, keys) {
      return run(() => {
        const store = beforeWrite();
        /*
         * 通道名两种写法都收：`zoom` 与 `camera.zoom`。模型照着读回形状抄的时候
         * 很容易带上前缀，直接拒掉会让它在下一轮换个拼法再试。
         */
        const raw = String(channel ?? '').trim().replace(/^camera\./, '');
        const key = (['x', 'y', 'zoom', 'rot'] as const).find((k) => k === raw);
        if (!key) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badCameraChannel', { channel: raw }), {
            validChannels: ['x', 'y', 'zoom', 'rot'],
          });
        }
        // `null` / 空数组 = 删掉这条轨道；其余必须是数组，且每一帧都要能解析。
        let parsed: TrackKey[] | null = null;
        if (Array.isArray(keys) && keys.length > 0) {
          parsed = typo.coerceCameraKeyList(keys);
          if (!parsed) {
            throw new ControlFailure('invalid-argument', tr('agent.typo.badCameraKeys'), { keys });
          }
        } else if (keys !== null && keys !== undefined && !Array.isArray(keys)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badCameraKeys'), { keys });
        }
        return typo.setCameraAnimation(store, typoClipId(clipId), key, parsed);
      });
    },

    async updateTypographyGroup(clipId, groupId, patch) {
      return run(() => {
        const store = beforeWrite();
        if (!isRecord(patch)) {
          throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'patch' }), { patch });
        }
        return typo.updateGroupBox(store, typoClipId(clipId), String(groupId ?? ''), patch);
      });
    },

    async booleanTypographyShapes(clipId, elementIds, op) {
      return run(() => {
        const store = beforeWrite();
        if (!['union', 'difference', 'intersection', 'xor'].includes(op)) {
          throw new ControlFailure('invalid-argument', tr('agent.typo.badLayout', { detail: `op=${String(op)}` }), {
            validIds: ['union', 'difference', 'intersection', 'xor'],
          });
        }
        return typo.booleanShapes(store, typoClipId(clipId), Array.isArray(elementIds) ? elementIds : [], op);
      });
    },

    async divideTypographyShapes(clipId, elementIds) {
      return run(() => {
        const store = beforeWrite();
        return typo.divideShapes(store, typoClipId(clipId), Array.isArray(elementIds) ? elementIds : []);
      });
    },

    async convertTypographyToPath(clipId, elementIds) {
      return run(async () => {
        const store = beforeWrite();
        return typo.convertToPath(
          store,
          typoClipId(clipId),
          Array.isArray(elementIds) ? elementIds : [],
          ctx.outlineText,
        );
      });
    },

    async replaceTypographyDoc(clipId, doc) {
      return run(() => {
        const store = beforeWrite();
        return typo.replaceDoc(store, typoClipId(clipId), doc);
      });
    },
  };

  /* ------------------------------------------------------------ 插件 */

  const plugins: Pick<
    AgentControlPlane,
    | 'pluginTry'
    | 'pluginView'
    | 'pluginGrep'
    | 'pluginEdit'
    | 'pluginCheck'
    | 'pluginInstall'
    | 'pluginList'
    | 'pluginDiscard'
    | 'pluginRemove'
    | 'pluginSource'
  > = {
    async pluginTry(input) {
      return run(async () => {
        needStore();
        return tryPlugin({
          host: ctx.getPluginHost?.() ?? null,
          projectKey: ctx.getProjectKey?.() ?? null,
          drafts: pluginDrafts,
          readSource: ctx.readPluginSource ?? null,
          input: {
            id: String(input?.id ?? ''),
            name: String(input?.name ?? ''),
            // 不传 = 用草稿。传空串与不传等价（模型习惯把可选参数填空）。
            ...(typeof input?.source === 'string' && input.source.trim() !== ''
              ? { source: input.source }
              : {}),
          },
          // 控制平面永远要求显式确认；「本次会话允许」是 UI 的会话状态。
          confirm: input?.confirm === true,
        });
      });
    },

    async pluginView(input) {
      return run(() =>
        viewPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          readSource: ctx.readPluginSource ?? null,
          pluginId: String(input?.pluginId ?? ''),
          ...(typeof input?.offset === 'number' ? { offset: input.offset } : {}),
          ...(typeof input?.limit === 'number' ? { limit: input.limit } : {}),
        }),
      );
    },

    async pluginGrep(input) {
      return run(() =>
        grepPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          readSource: ctx.readPluginSource ?? null,
          pluginId: String(input?.pluginId ?? ''),
          pattern: String(input?.pattern ?? ''),
          ...(typeof input?.ignoreCase === 'boolean' ? { ignoreCase: input.ignoreCase } : {}),
          ...(typeof input?.context === 'number' ? { context: input.context } : {}),
          ...(typeof input?.max === 'number' ? { max: input.max } : {}),
        }),
      );
    },

    async pluginEdit(input) {
      return run(() =>
        editPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          readSource: ctx.readPluginSource ?? null,
          pluginId: String(input?.pluginId ?? ''),
          oldString: String(input?.oldString ?? ''),
          newString: String(input?.newString ?? ''),
        }),
      );
    },

    async pluginCheck(pluginId) {
      return run(() =>
        checkPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          readSource: ctx.readPluginSource ?? null,
          pluginId,
        }),
      );
    },

    async pluginInstall(pluginId, confirm) {
      return run(() =>
        installPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          projectKey: ctx.getProjectKey?.() ?? null,
          persist: ctx.persistPlugin ?? null,
          pluginId,
          confirm: confirm === true,
        }),
      );
    },

    async pluginList() {
      return run(() => ({ plugins: listPlugins(ctx.getPluginHost?.() ?? null, pluginDrafts) }));
    },

    async pluginDiscard(pluginId) {
      return run(() =>
        discardPlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          unload: ctx.unloadPlugin ?? null,
          pluginId,
        }),
      );
    },

    async pluginRemove(pluginId) {
      return run(() =>
        removePlugin({
          host: ctx.getPluginHost?.() ?? null,
          drafts: pluginDrafts,
          remove: ctx.removePlugin ?? null,
          pluginId,
        }),
      );
    },

    async pluginSource(pluginId) {
      return run(async () => {
        const draft = draftSource(pluginDrafts, pluginId);
        if (draft !== null) return { source: draft };
        // 没有草稿 = 这次要执行的是磁盘上那份（见接口注释）。
        const fromDisk = ctx.readPluginSource ? await ctx.readPluginSource(pluginId) : null;
        return { source: fromDisk };
      });
    },
  };

  return { ...read, ...write, ...view, ...io, ...projectActions, ...typography, ...plugins };
}
