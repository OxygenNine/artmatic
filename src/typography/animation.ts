/**
 * animation.ts — CSS 动画模型（纯数据 + 纯函数，**不碰 DOM**）。
 *
 * 时间全部相对**片段起点**。唯一时钟是 t（AGENTS §1.1），这里绝不出现
 * Date.now() / performance.now()。
 *
 * 求值与渲染的分工：
 *  - 本文件只负责「localSec → WAAPI currentTime（ms）」这一层纯换算；
 *  - 真正把动画 seek 到那个时刻的是 bake-animation.ts（有 DOM）。
 * 这样预览与导出走的是同一条求值路径，差别只在有没有把结果固化进内联样式。
 *
 * 一个元素可以挂**多个动画条目**：渲染时每个条目嵌一层 `<div class="typo-anim">`
 * （render-dom.ts）。自定义条目还可以在**同一层里**再写多条逗号分隔的动画
 * （同时 / 先后跑），见 CustomAnimation。
 */

import type { TypographyDocument } from './document';
import {
  applyTrackTiming,
  type TrackEase,
  channelDeclaration,
  normalizeKeys,
  trackSpan,
  type AnimChannel,
  type TracksAnimation,
  type TrackKey,
} from './animation-tracks';
import { PRESET_MODULES } from './animation-presets';
import type { PresetDef, KeyframeBuilder } from './animation-presets';
import { tr } from '../i18n/index.svelte';
import type { MessageKey } from '../i18n/locales';

/** 动画名统一加前缀，避免与用户手写 CSS 或页面其它动画撞名。 */
export const ANIM_NAME_PREFIX = 'artmatic-a-';
/**
 * 动画层的标记 —— 落在哪一层由 `target` 决定：
 * `box`（缺省）= 外壳**之外**的 `.typo-box`，`content` = 外壳之内的 `.typo-anim`。
 * 见 render-dom.ts 的文件头（外层的 transform 被旋转占用，所以动画不能写在外壳上）。
 */
export const ANIM_ID_ATTR = 'data-anim-id';

export type Easing =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  /** cubic-bezier(x1, y1, x2, y2) */
  | [number, number, number, number];

/**
 * 预设 id 清单 —— **`AnimPreset` 联合类型的唯一真源**。
 *
 * 顺序 = 图库顺序：进入 → 强调 → 退出（与 PPT 一致，也与 Ribbon 那条常驻条
 * 的排列一致）。加一个预设的完整动作是 **四处**：这张表、对应分组模块的
 * `defs` + `keyframes`（`animation-presets/`）、图标（`ui/typography/anim-icons/`）
 * 与文案（`i18n/locales/zh-CN/media.ts` 的 `anim.*`）。
 * 漏一处不会静默：`tests/unit/anim-presets.test.ts` 逐条点名，其中
 * **图标与分组**那一半由 `tests/unit/anim-catalog.test.ts` 守。
 */
export const ANIM_PRESET_IDS = [
  /* ---- 进入 ---- */
  'fade-in',
  'slide-in-left',
  'slide-in-right',
  'slide-in-up',
  'slide-in-down',
  'zoom-in',
  'zoom-out',
  'pop',
  'blur-in',
  'flip-in-x',
  'flip-in-y',
  'swivel-in',
  'stretch-in-x',
  'stretch-in-y',
  'sweep-in',
  'iris-in',
  'skew-in',
  'bounce-in',
  'drop-in',
  'tracking-in',
  'roll-in',

  /* ---- 强调 ---- */
  'fade-in-out',
  'pulse',
  'spin',
  'shake',
  'contract',
  'beat',
  'flash',
  'swing',
  'wobble',
  'jello',
  'float',
  'circulate',
  'swirl',
  'flip',
  'hue-cycle',
  'brightness-pulse',
  'glow',
  'blur-pulse',
  'tracking-out',
  'jitter',
  'squash',
  'hop',

  /* ---- 退出 ---- */
  'fade-out',
  'slide-out-left',
  'slide-out-right',
  'slide-out-up',
  'slide-out-down',
  'shrink-out',
  'grow-out',
  'flip-out-x',
  'flip-out-y',
  'sweep-out',
  'iris-out',
  'blur-out',
  'roll-out',
] as const;

export type AnimPreset = (typeof ANIM_PRESET_IDS)[number];

/**
 * 动画作用在元素的哪一层。
 *
 *  - `box`（**缺省**）：元素最外层包装 `.typo-box`（包住 `.typo-el`）——
 *    文本框底板、边框与内容一起动。`clip-path` 因此能裁到框，`rotate` 转的是整块。
 *    用户说「我给文本框设了个旋转」时想的就是这个，所以它必须是缺省。
 *  - `content`：内层包装 `.typo-anim` —— 只影响文本 / 图形 / 图片本身。
 *    这是引入 `target` 之前的唯一行为，现在**只能显式选择**。
 *
 * 为什么不能「把动画一律挪到外壳上」（即不要 `.typo-box` 那一层）：外壳的
 * `transform` 被 `frame.rot` / 3D 占用，动画会顶掉用户设的旋转；而放在外壳**之内**
 * 又碰不到外壳自己的 `background-*` / `border`（CSS 动画不向上影响祖先）。
 *
 * **旧工程靠 v18 的迁移钉住（17→18）**：v17 及以前保存的文档里所有动画都
 * 没这个键，迁移会给它们显式写 `target:'content'` —— 缺省改成 `box` 之后，那些
 * 「只转字」的动画仍然逐像素不变。
 *
 * 已知代价（`box` 独有）：动画层会成为 `mix-blend-mode` 的新参照系，所以
 * 「元素混合模式 + box 动画」同时用时，与其他元素的混合结果与静止时不同。
 */
export type AnimTarget = 'content' | 'box';

/** 缺省作用层：整个元素框（含文本框底板 / 边框）。 */
export const DEFAULT_ANIM_TARGET: AnimTarget = 'box';

/** 条目实际作用在哪一层（缺省 / 脏数据一律当 `box`；`content` 必须显式写）。 */
export function animTargetOf(a: { target?: AnimTarget }): AnimTarget {
  return a.target === 'content' ? 'content' : DEFAULT_ANIM_TARGET;
}

export interface AnimTiming {
  /** 秒，相对片段起点。 */
  delay: number;
  /** 单次时长，秒。 */
  duration: number;
  /** 有限次数；Infinity → CSS 的 'infinite'。 */
  iterations: number;
  easing: Easing;
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  fill: 'none' | 'forwards' | 'backwards' | 'both';
  /**
   * 作用层。缺省 = `box`（整个元素框）；`content`（只动内容）必须显式写。
   *
   * 放在 `AnimTiming` 里是刻意的：它是**所有条目共有**的字段（预设 / 自定义 /
   * 轨道），构造、序列化、agent 读回各只有一条路径 —— 三个接口各加一次的话，
   * 漏掉的那一种会静默落到另一层。
   */
  target?: AnimTarget;
}

export interface PresetAnimation extends AnimTiming {
  id: string;
  kind: 'preset';
  preset: AnimPreset;
  /** 预设参数（slide 距离 px / zoom 起止缩放 / blur 半径 px）。 */
  params?: Record<string, number>;
}

export interface CustomAnimation extends AnimTiming {
  id: string;
  kind: 'custom';
  /**
   * 关键帧定义。两种形态，向后兼容：
   *
   *  - **单条（旧）**：只写一个 keyframes 的**体**，例如
   *    `from{opacity:0}to{opacity:1}`。它被自动命名成 `artmatic-a-<id>`，
   *    动画简写由 timing 字段生成 —— 旧工程渲染结果逐字不变。
   *  - **多条（新）**：一个或多个 `@keyframes <名字>{…}` 块。名字由用户起，
   *    输出时会加**元素级命名空间**（`artmatic-a-<id>-<名字>`），
   *    所以两个元素各写一个 `@keyframes pulse` 不会互相覆盖。
   *
   * 为什么不让用户写整段 CSS（他确实要「允许手写代码」，这是能力与安全的
   * 最小妥协）：滚动任意 CSS 字符串会带来三个真问题 ——
   *   ① `@import url(http://…)` 会外发网络请求，破坏「离线 + 确定性」；
   *   ② `position:fixed` 能让元素逃出快照区域，光栅化结果不可预测；
   *   ③ 顶层选择器会污染同页的其它元素（预览页里还有时间轴和面板）。
   * 允许 `@keyframes` 块之后，它仍然只能影响被绑定的那个元素（选择器恒为
   * `[data-anim-id]`），注入点唯一（一份 <style>，随快照进入隔离文档）。
   */
  css: string;
  /**
   * 多条形态下的一条**逗号分隔** `animation` 简写，每条引用本条目里定义的
   * keyframes 名字（或既有预设名，如 `fade-in`）。名字同样会被命名空间化。
   *
   * 缺省 → 退回由 timing 字段生成的**单条**简写（引用 `artmatic-a-<id>`），
   * 与旧单 body 形态渲染结果逐字一致。
   */
  animation?: string;
}

export type ElementAnimation = PresetAnimation | CustomAnimation | TracksAnimation;

/**
 * 结构化轨道（`kind: 'tracks'`）是**编辑器的主模型**：一条动画一个属性、
 * 关键帧存绝对秒、每段可单独设缓动。定义与纯函数在 `animation-tracks.ts`，
 * 这里只负责把它发射成 CSS（与 preset / custom 同一条出口）。
 */
export type { AnimChannel, TracksAnimation, TrackKey };

/* ------------------------------------------------------------ 预设表 */

export interface AnimPresetDef extends PresetDef {}

/**
 * 预设表。**由三个分组模块按「进入 → 强调 → 退出」拼出来**，不在这里手写：
 * 这张表的每一项都配着一段 keyframes 体，两者分在两个文件里一定会错位，
 * 所以定与画放在同一个模块里（`animation-presets/<group>.ts`）。
 */
export const ANIM_PRESETS: AnimPresetDef[] = PRESET_MODULES.flatMap((m) => m.defs);

/** id → keyframes 体。散在三个模块里，这里只负责按 id 找到那一个。 */
const PRESET_KEYFRAMES: Record<string, KeyframeBuilder> = Object.assign(
  {},
  ...PRESET_MODULES.map((m) => m.keyframes),
);

const PRESET_IDS = new Set<string>(ANIM_PRESETS.map((d) => d.id));

/** 某个名字是不是内置预设（多动画简写里可以直接引用预设名）。 */
export function isPresetId(name: string): name is AnimPreset {
  return PRESET_IDS.has(name);
}

/**
 * 预设的展示名。找不到就回落到 id 本身 —— 与 `tr()` 的处理同构：
 * 宁可显示一个看得懂的标识符，也不要显示空白。
 */
export function presetLabel(p: AnimPreset): string {
  const def = ANIM_PRESETS.find((d) => d.id === p);
  return def ? tr(def.labelKey) : p;
}

export function defaultTiming(): AnimTiming {
  return {
    delay: 0,
    duration: 0.6,
    iterations: 1,
    easing: 'ease-out',
    direction: 'normal',
    fill: 'both',
  };
}

export function animationName(anim: ElementAnimation): string {
  return `${ANIM_NAME_PREFIX}${anim.id}`;
}

/* ------------------------------------------------------------ 求值（纯函数） */

/**
 * 本地时间 → WAAPI 的 currentTime（ms）。
 *
 * `currentTime` 的时间轴**包含** start delay：CSS `animation-delay` 属于 effect
 * timing，`getComputedTiming().localTime === currentTime`（实测，delay=3s 的动画
 * 在 currentTime=3000 时才刚进入 active 段）。所以这里只做秒→毫秒，**不许再减
 * delay** —— 再减一次等于把延迟算两遍，起点变成 2×delay（delay=3s 的元素 6s 才
 * 开始动），而延迟期被 `Math.max(0, …)` 钳住，看起来一切正常。
 *
 * 本地时间在片段起点之前时钳到 0：`fill: backwards` 显示首帧、`fill: none` 显示
 * 基础样式，两种都是确定的，也与真实播放的 before 段一致。
 */
export function animationCurrentTimeMs(localSec: number): number {
  return Math.max(0, localSec * 1000);
}

/** 此刻动画是否落在「有作用」的区间内（图层面板给动画打点 / 高亮用）。 */
export function isAnimationActiveAt(anim: ElementAnimation, localSec: number): boolean {
  const elapsed = localSec - anim.delay;
  if (elapsed < 0) return false;
  if (anim.iterations === Infinity) return true;
  return elapsed <= anim.duration * anim.iterations + 1e-9;
}

/**
 * 预设 → @keyframes 的**体**（不含 `@keyframes ...{}` 外壳）。纯函数。
 *
 * 找不到就返回空串（而不是抛错）：`AnimPreset` 是封闭联合，正常情况下不可能
 * 找不到；这里兜的是**运行时**的脏数据（旧工程里存过已删掉的预设名），空白
 * 让那条动画静静消失，好过让整份文档打不开。
 */
export function presetKeyframes(preset: AnimPreset, params: Record<string, number> = {}): string {
  return PRESET_KEYFRAMES[preset]?.(params ?? {}) ?? '';
}

/* ------------------------------------------------------------ 手写 CSS 的解析 */

/**
 * 清洗用户手写的自定义 CSS（单 body 或多 @keyframes 块均可）。
 *
 * 剥掉标签 / `@import` / `@charset` / `@namespace` / 注释，并校验花括号配平：
 * 任何时刻 depth 不得为负，结束时必须归零。否则一个 `}` 就能提前闭合我们的
 * `@keyframes` 块，往后写任意顶层 CSS。
 *
 * 注意 keyframes 体里**合法地**包含成对的 `{}`（`from{...}to{...}`），所以
 * 不能简单地把花括号剥掉。清洗后为空字符串 = 非法，调用方应当拒绝写入。
 */
export function sanitizeCustomCss(css: string): string {
  let s = css.replace(/<\/?[a-z][^>]*>/gi, '');
  // 注释先剥：否则 `/* } */` 会干扰花括号配平（也会让 @import 藏在注释里蒙混）。
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/@import\b[^;]*;?/gi, '');
  s = s.replace(/@charset\b[^;]*;?/gi, '');
  s = s.replace(/@namespace\b[^;]*;?/gi, '');

  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return '';
    }
  }
  if (depth !== 0) return '';
  return s.trim();
}

export function isValidCustomCss(css: string): boolean {
  return sanitizeCustomCss(css) !== '';
}

/** 交给编辑器预填的**可编辑文本**：单 body 原样，多动画 = 块 + 简写。 */
export function keyframeBodyOf(anim: ElementAnimation): string {
  if (anim.kind === 'preset') return presetKeyframes(anim.preset, anim.params);
  // 结构化轨道：给出它真正会跑的那份体（含逐段缓动），手写 CSS 弹窗据此可编辑。
  if (anim.kind === 'tracks') return trackFrames(anim)?.body ?? '';
  if (anim.animation) return `${anim.css}\nanimation: ${anim.animation};`.trim();
  return sanitizeCustomCss(anim.css);
}

/**
 * 自定义 CSS 被拒绝的原因。**只给编码** —— 组件负责翻成可读文案
 * （面向用户文案一律走 `tr()`，见 AGENTS §5.3）。
 */
export type CustomCssError =
  | 'unbalanced' // 花括号未配平 / 空
  | 'badAtRule' // 出现 @keyframes 之外的顶层 @ 规则
  | 'badSelector' // 顶层出现了选择器（不允许）
  | 'badKeyframeName' // @keyframes 名字不合法
  | 'missingAnimation' // 有 @keyframes 块却没有 animation 简写
  | 'badAnimation' // animation 简写解析失败
  | 'unknownName'; // 简写引用了未定义的动画名

export type CustomCssParse =
  | { ok: true; css: string; animation?: string }
  | { ok: false; reason: CustomCssError };

/**
 * 失败原因 → 文案键。**唯一一份**：编辑器弹窗与 agent 报错都从这里取。
 *
 * 两处各写一份的形态是「用户看到『引用的动画名没定义』、模型只收到『入参非法』」——
 * 后者只能靠改字符串试错，而每次试错都是一整轮往返。
 */
export const CUSTOM_CSS_ERROR_KEYS: Record<CustomCssError, MessageKey> = {
  unbalanced: 'typo.customCssUnbalanced',
  badAtRule: 'typo.customCssErrAtRule',
  badSelector: 'typo.customCssErrSelector',
  badKeyframeName: 'typo.customCssErrBadName',
  missingAnimation: 'typo.customCssErrMissingAnimation',
  badAnimation: 'typo.customCssErrBadAnimation',
  unknownName: 'typo.customCssErrUnknownName',
};

const KEYFRAME_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** `@keyframes` 体内合法的选择器：`from` / `to` / 百分比（可逗号分隔多个）。 */
const KEYFRAME_SELECTOR_RE = /^(from|to|(?:\d+\.?\d*|\.\d+)%)$/i;

/**
 * 校验一段**关键帧体**（`from{…}to{…}`）的选择器是否合法。
 *
 * 为什么必须校验：浏览器遇到非法的关键帧选择器（比如手滑写了个 `div{color:red}`）
 * 会**整条丢弃** `@keyframes`，于是动画「保存成功、就是不跑」，而且没有任何报错。
 * 旧单 body 形态绕过了 `scanCssBlocks`，这里是它唯一的闸口。
 */
function validKeyframeBody(s: string): boolean {
  const n = s.length;
  let i = 0;
  let sawBlock = false;
  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && s[i] !== '{' && s[i] !== '}') i++;
    if (i >= n || s[i] === '}') return false;
    const sel = s.slice(start, i).trim();
    if (!sel) return false;
    for (const part of sel.split(',')) {
      if (!KEYFRAME_SELECTOR_RE.test(part.trim())) return false;
    }
    let depth = 1;
    i += 1;
    while (i < n && depth > 0) {
      if (s[i] === '{') depth += 1;
      else if (s[i] === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) return false;
    sawBlock = true;
  }
  return sawBlock;
}

/** 顶层（括号 / 花括号内不算）是否出现 `@` 规则或 `animation:` 声明。 */
function looksStructured(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '@') return true;
      if ((ch === 'a' || ch === 'A') && /^animation\s*:/i.test(s.slice(i))) return true;
    }
  }
  return false;
}

interface CssScan {
  keyframes: { name: string; body: string }[];
  others: string[];
  error?: CustomCssError;
}

/**
 * 扫一遍（已清洗的）CSS：抽出所有 `@keyframes <名字>{<体>}` 块，其余顶层语段
 * 原样收进 `others`。非 keyframes 的顶层花括号 = 结构非法。
 */
function scanCssBlocks(s: string): CssScan {
  const keyframes: { name: string; body: string }[] = [];
  const others: string[] = [];
  const n = s.length;
  let i = 0;

  const fail = (error: CustomCssError): CssScan => ({ keyframes, others, error });

  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (i >= n) break;

    if (s[i] === '@') {
      const kw = /^@keyframes\b/i.exec(s.slice(i));
      if (!kw) return fail('badAtRule');
      i += kw[0].length;
      while (i < n && /\s/.test(s[i]!)) i++;
      const nameStart = i;
      while (i < n && /[A-Za-z0-9_-]/.test(s[i]!)) i++;
      const name = s.slice(nameStart, i);
      if (!KEYFRAME_NAME_RE.test(name)) return fail('badKeyframeName');
      while (i < n && /\s/.test(s[i]!)) i++;
      if (s[i] !== '{') return fail('unbalanced');
      const bodyStart = i + 1;
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (s[i] === '{') depth += 1;
        else if (s[i] === '}') depth -= 1;
        i += 1;
      }
      if (depth !== 0) return fail('unbalanced');
      const body = s.slice(bodyStart, i - 1).trim();
      // 体内选择器也要管：非法的关键帧选择器会让浏览器丢掉整条 @keyframes。
      if (!validKeyframeBody(body)) return fail('badSelector');
      keyframes.push({ name, body });
    } else {
      const start = i;
      let depth = 0;
      while (i < n) {
        const ch = s[i]!;
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === '{') return fail('badSelector');
        else if (ch === '}') return fail('unbalanced');
        else if (ch === ';' && depth === 0) break;
        i += 1;
      }
      const stmt = s.slice(start, i).trim();
      if (stmt) others.push(stmt);
      i += 1;
    }
  }
  return { keyframes, others };
}

function parseMultiCss(s: string): CustomCssParse {
  const scan = scanCssBlocks(s);
  if (scan.error) return { ok: false, reason: scan.error };

  let animation: string | undefined;
  for (const stmt of scan.others) {
    const m = /^animation\s*:\s*([\s\S]+)$/i.exec(stmt);
    if (!m || animation !== undefined) return { ok: false, reason: 'badAnimation' };
    animation = m[1]!.trim();
  }

  if (animation === undefined) {
    // 只有块没有简写 = 不知道该怎么用；什么都没有 = 空。
    return {
      ok: false,
      reason: scan.keyframes.length > 0 ? 'missingAnimation' : 'unbalanced',
    };
  }

  const parsed = parseAnimationShorthand(animation);
  if (!parsed.ok) return { ok: false, reason: 'badAnimation' };

  const defined = new Set(scan.keyframes.map((b) => b.name));
  for (const p of parsed.parts) {
    if (!defined.has(p.name) && !isPresetId(p.name)) return { ok: false, reason: 'unknownName' };
  }

  return {
    ok: true,
    css: scan.keyframes.map((b) => `@keyframes ${b.name}{${b.body}}`).join(''),
    animation,
  };
}

/**
 * 抽出（已清洗的）CSS 里所有 `@keyframes` 块。解析失败返回空数组。
 *
 * 给迁移用：`custom` 条目里那些块要逐帧拆成结构化轨道。扫描器只有一份实现
 * （`scanCssBlocks`），不要在迁移里另写一个「差不多的」解析器 —— 两处分家的
 * 形态是「编辑器能保存、迁移看不懂」。
 */
export function keyframeBlocksOf(css: string): { name: string; body: string }[] {
  return scanCssBlocks(css).keyframes;
}

/**
 * 解析编辑器里的一段自定义 CSS。纯函数。
 *
 * 判别：顶层不含 `@` 规则、也没有 `animation:` 声明 → **旧单 body 形态**
 * （整个文本就是一个 keyframes 体）；否则走多动画形态（N 个 `@keyframes` 块 +
 * 一条 `animation` 简写）。旧工程因此继续原样可用。
 */
export function parseCustomCss(raw: string): CustomCssParse {
  const s = sanitizeCustomCss(raw);
  if (!s) return { ok: false, reason: 'unbalanced' };
  // 旧形态没有 `@`，靠「整段就是一个关键帧体」判别；选择器写错时宁可拒绝。
  if (!looksStructured(s)) return validKeyframeBody(s) ? { ok: true, css: s } : { ok: false, reason: 'badSelector' };
  return parseMultiCss(s);
}

/* ------------------------------------------------------ animation 简写的解析 */

export interface ParsedAnimPart {
  /** 引用的动画名（本条目定义的 keyframes 名，或预设 id）。 */
  name: string;
  /** 秒。 */
  duration: number;
  /** 秒。 */
  delay: number;
  /** Infinity → infinite。 */
  iterations: number;
}

export type ShorthandParse = { ok: true; parts: ParsedAnimPart[] } | { ok: false };

const EASING_KEYWORDS = new Set([
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
]);
const DIRECTION_KEYWORDS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILL_KEYWORDS = new Set(['none', 'forwards', 'backwards', 'both']);
const TIME_RE = /^[+-]?(\d+\.?\d*|\.\d+)(ms|s)$/i;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const EASING_FN_RE = /^(cubic-bezier|steps|linear)\(/i;

/** 顶层按分隔符切（括号 / 花括号内不切）。 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** 顶层按空白切（`cubic-bezier(0.2, 0, 0.2, 1)` 里的空格不切）。 */
function splitWhitespace(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function toSeconds(tk: string): number {
  const n = Number.parseFloat(tk);
  return /ms$/i.test(tk) ? n / 1000 : n;
}

/** 一条动画（逗号分隔中的一段）→ 名字 + 时序。无法识别返回 null。 */
function parsePart(part: string): ParsedAnimPart | null {
  const tokens = splitWhitespace(part);
  let name = '';
  let duration = 0;
  let delay = 0;
  let iterations = 1;
  let timeSeen = 0;

  for (const tk of tokens) {
    if (TIME_RE.test(tk)) {
      if (timeSeen === 0) duration = toSeconds(tk);
      else if (timeSeen === 1) delay = toSeconds(tk);
      else return null; // 超过两个时间 —— 非法
      timeSeen++;
    } else if (tk.toLowerCase() === 'infinite') {
      iterations = Infinity;
    } else if (NUMBER_RE.test(tk)) {
      iterations = Number(tk);
    } else if (EASING_KEYWORDS.has(tk.toLowerCase()) || EASING_FN_RE.test(tk)) {
      // 缓动，忽略
    } else if (DIRECTION_KEYWORDS.has(tk.toLowerCase()) || FILL_KEYWORDS.has(tk.toLowerCase())) {
      // 方向 / 填充，忽略
    } else if (IDENT_RE.test(tk)) {
      if (name) return null; // 两个候选名 —— 非法
      name = tk;
    } else {
      return null;
    }
  }
  if (!name) return null;
  return { name, duration, delay, iterations };
}

/** 解析一条**逗号分隔**的 `animation` 简写值。纯函数。 */
export function parseAnimationShorthand(s: string): ShorthandParse {
  const raw = splitTopLevel(s, ',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (raw.length === 0) return { ok: false };
  const parts: ParsedAnimPart[] = [];
  for (const p of raw) {
    const parsed = parsePart(p);
    if (!parsed) return { ok: false };
    parts.push(parsed);
  }
  return { ok: true, parts };
}

/**
 * 某条目在时间轴上实际会跑的**子动画**列表。
 *
 *  - 预设 / 旧单 body 自定义 → 一条，延迟取 timing 字段（与旧行为逐字一致）。
 *  - 多动画自定义 → 逐条取自简写，各有自己的时长与延迟。
 *
 * 关键帧面板与 agent 的读回形状都读它，保证「预览里跑几条」与「面板画几条 /
 * 读回几条」一致。烘焙 seek **不**需要它：延迟已经写进 CSS 简写（effect timing），
 * `currentTime` 对每一条都是同一个绝对时间。
 */
export function customSubAnimations(anim: ElementAnimation): ParsedAnimPart[] {
  const fallback: ParsedAnimPart = {
    name: animationName(anim),
    delay: anim.delay,
    duration: anim.duration,
    iterations: anim.iterations,
  };
  if (anim.kind !== 'custom' || !anim.animation) return [fallback];
  const parsed = parseAnimationShorthand(anim.animation);
  return parsed.ok ? parsed.parts : [fallback];
}

/* ------------------------------------------------------------ 样式表生成 */

/**
 * 缓动 → CSS 值。三种形态：关键字原文、`cubic-bezier(...)` 四元组、`steps(n, jump)`。
 *
 * 只认这三种（没有自由字符串）：值会被拼进唯一那份 `<style>`，放行任意文本等于
 * 给了一条注入通道（与属性名闸门同一条理由）。
 */
export function easingCss(e: TrackEase): string {
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) return `cubic-bezier(${e.map((n) => round(n, 4)).join(',')})`;
  const n = Math.max(1, Math.round(e.steps));
  return `steps(${n}${e.jump ? `,${e.jump}` : ''})`;
}

function iterationsCss(n: number): string {
  return n === Infinity ? 'infinite' : String(round(n, 4));
}

function round(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** 动画 → CSS `animation` 简写值（单条；多动画走 CustomAnimation.animation）。 */
export function animationShorthand(anim: ElementAnimation): string {
  return [
    animationName(anim),
    `${round(anim.duration, 4)}s`,
    easingCss(anim.easing),
    `${round(anim.delay, 4)}s`,
    iterationsCss(anim.iterations),
    anim.direction,
    anim.fill,
  ].join(' ');
}

interface EmittedCustom {
  keyframes: { name: string; body: string }[];
  animation: string;
}

/**
 * 把自定义条目展开成「要发出的 @keyframes 块 + 最终简写」。
 *
 * **命名空间化**：每条 keyframes 名都前缀 `artmatic-a-<id>-`，引用预设则用
 * `artmatic-a-<id>-p-<预设>`。id 全局唯一，所以两个元素各写一个 `@keyframes pulse`
 * 不会互相覆盖。简写里的名字同步重写成这些命名空间名。
 *
 * 旧形态（`animation` 缺省）沿用 `artmatic-a-<id>` 单名 + timing 生成的简写，
 * 与扩展前逐字一致。
 */
function emitCustom(c: CustomAnimation): EmittedCustom | null {
  if (!c.animation) {
    const body = sanitizeCustomCss(c.css);
    if (!body) return null;
    return { keyframes: [{ name: animationName(c), body }], animation: animationShorthand(c) };
  }

  const scan = scanCssBlocks(c.css);
  if (scan.error) return null;
  const parsed = parseAnimationShorthand(c.animation);
  if (!parsed.ok) return null;

  const names = new Map<string, string>();
  const keyframes: { name: string; body: string }[] = [];
  for (const b of scan.keyframes) {
    const ns = `${ANIM_NAME_PREFIX}${c.id}-${b.name}`;
    names.set(b.name, ns);
    keyframes.push({ name: ns, body: b.body });
  }
  for (const p of parsed.parts) {
    if (names.has(p.name)) continue;
    if (!isPresetId(p.name)) return null; // 引用了本条目未定义的名字
    const ns = `${ANIM_NAME_PREFIX}${c.id}-p-${p.name}`;
    names.set(p.name, ns);
    keyframes.push({ name: ns, body: presetKeyframes(p.name) });
  }

  return { keyframes, animation: rewriteNames(c.animation, names) };
}

/** 把简写里每段的动画名替换成命名空间名（其余 token 原样保留）。 */
function rewriteNames(shorthand: string, names: Map<string, string>): string {
  return splitTopLevel(shorthand, ',')
    .map((raw) => {
      const part = parsePart(raw);
      const tokens = splitWhitespace(raw);
      if (!part) return tokens.join(' ');
      const idx = tokens.indexOf(part.name);
      const ns = names.get(part.name);
      if (ns && idx >= 0) tokens[idx] = ns;
      return tokens.join(' ');
    })
    .filter((s) => s !== '')
    .join(', ');
}

/* ------------------------------------------------------ 结构化轨道（tracks） */

/**
 * 结构化轨道 → 关键帧体（不含 `@keyframes` 外壳）。纯函数。
 *
 * 两件事在这里定死：
 *  1. **百分比归一化**：`offset = (t − delay) / span`，`delay = 第一帧`。
 *     面板上的「1.2s」与 CSS 上的「50%」是同一个东西的两种坐标。
 *  2. **逐段缓动写进帧块**：`animation-timing-function` 在关键帧块内作用于
 *     「本帧 → 下一帧」，与 `core/curve.ts` 的出向 `interp` 同义。末帧不写
 *     （它没有下一段）。
 */
function trackFrames(anim: TracksAnimation): { body: string; delay: number; span: number } | null {
  const keys = normalizeKeys(anim.keys);
  if (keys.length === 0) return null;
  const { delay, duration } = trackSpan(keys);
  const first = channelDeclaration(anim.prop, keys[0]!.v);
  if (!first) return null;
  // 单帧：整段时间都是这个值。只写 0% 也能用，但 0%,100% 更不容易被后续工具误读。
  if (keys.length === 1) return { body: `0%,100%{${first}}`, delay, span: 0 };

  const frames: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const decl = i === 0 ? first : channelDeclaration(anim.prop, key.v);
    if (!decl) return null;
    /*
     * 所有帧挤在同一刻（span ≈ 0）时百分比会全是 0 —— 那种 `@keyframes`
     * 没有插值区间，浏览器会**整条丢掉**（表现是「动画保存成功、就是不跑」）。
     * 退化成 0→100 同值，至少是确定的。
     */
    const pct = i === 0 ? 0 : duration <= 1e-6 ? 100 : round(((key.t - delay) / duration) * 100, 4);
    const decls = [decl];
    if (i < keys.length - 1 && key.ease) decls.push(`animation-timing-function:${easingCss(key.ease)}`);
    frames.push(`${pct}%{${decls.join(';')}}`);
  }
  return { body: frames.join(''), delay, span: duration };
}

function emitTracks(anim: TracksAnimation): EmittedCustom | null {
  const out = trackFrames(anim);
  if (!out) return null;
  const name = animationName(anim);
  return {
    keyframes: [{ name, body: out.body }],
    // 简写走**同一个** animationShorthand：时长/延迟取派生值，其余（easing /
    // iterations / direction / fill）原样来自条目。两处各拼一遍的形态是
    // 「面板说 0.6s、实际跑 2s」。
    animation: animationShorthand({ ...anim, delay: out.delay, duration: Math.max(1e-3, out.span) }),
  };
}

/**
 * 生成整篇文档所需的 `<style>` 内容：@keyframes 块 + 每个动画的绑定规则。
 *
 * 绑定走**一份样式表**而不是逐个元素写内联 style：注入点唯一，
 * 快照序列化时只需要带上这一个节点，也让「手写 CSS 无法逃逸」这条成立。
 *
 * 选择器用 `[data-anim-id=...]`：`box` 条目挂在外壳**之外**的 `.typo-box`，
 * `content` 挂在**内层** `.typo-anim` —— 无论哪种都不写在外壳上，
 * 因为外壳的 transform 被旋转占用，而动画预设大量使用 transform。
 */
export function animationStyleSheet(doc: TypographyDocument): string {
  const frames: string[] = [];
  const rules: string[] = [];
  const seen = new Set<string>();

  const pushFrame = (name: string, body: string): void => {
    if (!body || seen.has(name)) return;
    seen.add(name);
    frames.push(`@keyframes ${name}{${body}}`);
  };

  for (const el of doc.elements) {
    for (const anim of el.animations) {
      if (anim.kind === 'custom' || anim.kind === 'tracks') {
        const emitted = anim.kind === 'custom' ? emitCustom(anim) : emitTracks(anim);
        if (!emitted) continue;
        for (const k of emitted.keyframes) pushFrame(k.name, k.body);
        rules.push(`[${ANIM_ID_ATTR}="${cssAttrEscape(anim.id)}"]{animation:${emitted.animation}}`);
      } else {
        const body = presetKeyframes(anim.preset, anim.params);
        if (!body) continue;
        pushFrame(animationName(anim), body);
        rules.push(`[${ANIM_ID_ATTR}="${cssAttrEscape(anim.id)}"]{animation:${animationShorthand(anim)}}`);
      }
    }
  }
  return frames.concat(rules).join('\n');
}

/** 属性选择器里的字符串转义。id 是我们自己生成的，但仍然不信任。 */
function cssAttrEscape(s: string): string {
  return s.replace(/["\\]/g, (m) => `\\${m}`);
}

/**
 * 文档是否含时间变化的内容 —— 决定光栅化缓存键要不要带帧号。
 *
 * 脚本只在**总开关打开**时才算「会随时间变化」：
 *  - 关掉时脚本一条都不执行，画面与没有脚本的文档逐像素相同 ⇒ 按静态缓存
 *    （不然一张标题卡会每帧重烘一遍，白烧 200ms/帧）；
 *  - 打开时每帧都可能不同 ⇒ 帧号进键。
 *
 * 两种模式在缓存键里各有盐（见 `cache-key.ts::rasterKey`），所以切换开关
 * 不会命中对方烘出来的图。
 */
export function docIsAnimated(doc: TypographyDocument, scriptsActive = false): boolean {
  if (doc.elements.some((e) => e.animations.length > 0)) return true;
  /*
   * 镜头轨道也要算进来。**空轨道不算**：面板上那四条属性常驻显示，没打过关键帧
   * 的通道不该让静态文档变成逐帧重烘（一张标题卡每帧多花几百毫秒，还看不出来）。
   * 直接读字段而不 import `camera-tracks`：那里会 import 本文件（`defaultTiming`），
   * 反向再 import 就是一条运行期环。
   */
  if ((doc.animations ?? []).some((a) => a.kind === 'tracks' && a.keys.length > 0)) return true;
  return scriptsActive && (doc.scripts ?? []).some((s) => s.enabled && s.code.trim().length > 0);
}

/* ------------------------------------------------------------ 构造 */

export function createPresetAnimation(
  preset: AnimPreset,
  id: string,
  over: Partial<AnimTiming> = {},
): PresetAnimation {
  const def = ANIM_PRESETS.find((d) => d.id === preset);
  return {
    ...defaultTiming(),
    duration: def?.duration ?? 0.6,
    easing: def?.easing ?? 'ease-out',
    ...over,
    id,
    kind: 'preset',
    preset,
    params: def?.params,
  };
}

export function createCustomAnimation(
  id: string,
  css: string,
  over: Partial<AnimTiming> & { animation?: string } = {},
): CustomAnimation {
  const { animation, ...timing } = over;
  const anim: CustomAnimation = { ...defaultTiming(), ...timing, id, kind: 'custom', css };
  if (animation) anim.animation = animation;
  return anim;
}

/**
 * 新建一条结构化轨道。
 *
 * `keys[].t` 是**绝对秒**；这里立刻过一遍 `applyTrackTiming`，所以 `delay` /
 * `duration` 从创建那一刻就与关键帧一致 —— 不存在「面板画在一处、Ribbon 显示
 * 另一处」的中间态。
 */
export function createTracksAnimation(
  id: string,
  prop: AnimChannel | (string & {}),
  keys: TrackKey[],
  over: Partial<AnimTiming> = {},
): TracksAnimation {
  const anim: TracksAnimation = { ...defaultTiming(), ...over, id, kind: 'tracks', prop, keys };
  return applyTrackTiming(anim);
}
