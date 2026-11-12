/**
 * session.ts — 一轮对话的**工具循环**。
 *
 * 职责边界：
 *
 *   provider       发请求 / 解析 SSE
 *   **session**    消息历史、工具循环、事务、取消、上下文裁剪、图片注入
 *   executor       工具名 → 控制平面调用
 *   ui/agent/*     展示事件、输入框、审批对话框
 *
 * ## 一轮 = 一笔撤销
 *
 * 每次 `send()` 用 `beginTx` / `endTx` 包住整轮。`CommandStack.commit` 在事务
 * 内不再单独入栈（见 `core/commands.ts`），所以用户按一次 Ctrl+Z 就能撤掉
 * agent 这一轮的全部改动 —— 而不是逐条退。
 *
 * ## 图片注入
 *
 * Chat Completions 只允许图片出现在 `user` 消息里。工具结果（`role:'tool'`）
 * 只能带文本，所以截图在**本轮工具都执行完**之后，合成一条 user 消息追加：
 * `[{type:'text', text:'Rendered frame ...'}, {type:'image_url', ...}]`。
 * 下一轮模型就能看到它。这也顺带避免了「工具结果里夹图片」在其它兼容服务上
 * 直接 400。
 *
 * ## 停止
 *
 * `AbortController` 贯穿网络请求；工具执行本身不可中断（控制平面是同步的），
 * 但循环会在每个工具之后检查 `aborted` 并收尾。事务仍然提交 —— 已经发生的
 * 改动留在工程里，用户可以撤销。
 */

import { tr } from '../../i18n/index.svelte';
import type { AgentControlPlane } from '../control-plane';
import type { ControlResult } from '../types';
import {
  interjectionText,
  renderAttachedRefs,
  renderUiContext,
  type ContextRef,
  type UiContextSnapshot,
} from '../context';
import { costOf, tokensOf, type UsageTokens } from './billing';
import { renderAttachedSkills } from '../skills/registry';
import { uploadImage, fileStillValid } from './files';
import { cacheStatsOf, mergeCacheStats } from './usage';
import { TOOL_BY_NAME, toolsFor, type ToolSpec } from '../tools';
import { RESUME_NOTE, SUMMARY_SYSTEM, SYSTEM_PROMPT, summaryRequest } from './prompt';
import { LLM_TIMEOUT_MS, streamChat } from './transport';
import { parseToolArguments } from './tool-args';
import { apisOf, contextLimitOf, supportsImages } from './providers/registry';
import type { ToolExecutor } from './executor';
import { PARENT_OWNER, writeTargetsOf, type SubagentInbox, type WriteFence } from './subagents';
import {
  LlmError,
  type AgentStatus,
  type CacheStats,
  type InterjectionInput,
  type LlmConfig,
  type LlmUsage,
  type SessionEvent,
  type StoredFile,
  type ToolOutcome,
  type WireMessage,
  type WirePart,
  type WireToolCall,
} from './types';

/**
 * 单轮最多几次「模型 → 工具」往返。
 *
 * 早先的 16 步在真实任务里根本不够（一个排版 + 截图 + 修错就二三十步）。
 * 现在默认 200、上限 2000 —— 真正的刹车不是步数，而是 `stop()`、**重复调用
 * 的引导**（见 `REPEAT_WARN`）与服务端错误。
 */
export const MAX_STEPS = 200;
export const MAX_STEPS_LIMIT = 2000;
/** 上下文里保留的消息字符预算（粗算，中文按 1 字 ≈ 1 token）。 */
/**
 * 默认上下文窗口（token）。**只是兜底**：真正生效的值来自
 * `providers/registry.ts::contextLimitOf(config)` —— 各家的窗口从 32k 到 1M
 * 不等，写死一个数会让压缩永不触发（然后在跑到一半时 400）。
 *
 * 这是**估算**：真实用量以服务端返回的 `usage.prompt_tokens` 为准，只有它缺席
 * （例如压缩后的第一轮）才回落到字符估算。
 */
export const CONTEXT_LIMIT_TOKENS = 1_000_000;
export const COMPACT_AT = 0.75;
/** 压缩时保留的最近消息条数（从 user 边界切，绝不拆开 assistant/tool 对）。 */
const KEEP_RECENT_MESSAGES = 8;

/**
 * 压缩的结果。`ok` 之外都**没有改动** `messages`。
 *
 * `short`（没有可丢的前半段）与 `failed`（总结请求失败）必须分开：前者是
 * 「你没什么可压的」，后者是「压了但没成功」。混成一句「压缩失败」会让用户
 * 以为上下文里塞满了却压不动。
 */
export type CompactOutcome = 'ok' | 'busy' | 'short' | 'failed';
/** 兜底硬裁剪（字符）。1M token ≈ 2.5M 字符；压缩失效时才会走到这里。 */
export const MAX_CONTEXT_CHARS = 2_400_000;

/**
 * 字符 → token 的粗估换算（中文约 1 字/token，英文约 4 字符/token）。
 *
 * 用在**没有服务端 usage** 的回合：刚恢复会话、刚压缩完、以及还没发过一次请求。
 * 它必然不准（中英混排的真实比值在 1.5–3.5 之间摆动），所以一旦服务端给了
 * `prompt_tokens` 就立刻改用真值 —— 不要拿这个估算去做「还剩多少」的承诺。
 */
const CHARS_PER_TOKEN = 2.5;
/**
 * 一张图片占多少 token。DeepSeek 视觉文档给的是**上限 1024**（进模型前缩放到
 * 约 1300×1300），而 `file_id` 与内联 base64 在这里没有区别 —— 都是同一张图。
 * 所以按 1024 计，**绝不能按 base64 长度折算**：那会把一张截图算成一万 token。
 */
const IMAGE_TOKENS = 1_024;
/** 图片在**字符**预算里的等价体积（`trimMessages` 用的是字符）。 */
const IMAGE_CHARS = IMAGE_TOKENS * CHARS_PER_TOKEN;

/** 上下文是否该压缩（纯函数）。 */
export function shouldCompact(tokens: number, limit = CONTEXT_LIMIT_TOKENS): boolean {
  return tokens >= limit * COMPACT_AT;
}

/** 字符 → token 的粗估（中文约 1 字/token，英文约 4 字符/token）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * 同一个「工具 + 参数」**连续**重复到这些次数时的处理阶梯。
 *
 * 以前第 3 次直接抛错掐断 —— 但模型常常是在**确认它刚做过的事**（或读同一个
 * 只读场景），并不是死循环，用户却只看到「失败」。现在：
 *   3 次 → 注入一条提示（换参数 / 读结果 / 用 ask_user），**继续干活**；
 *   6 次 → 再提示一次，更明确；
 *   12 次 → 才真的判定卡死并停下（此时确实没有进展）。
 *
 * ⚠️ 判据是**连续**而不是累计：`plugin_try` 这类「试一版、看一眼、再试一版」
 * 的工具会反复用同一个工具名（甚至同一份参数经过审批重试），累计计次会把它
 * 当成死循环误报。所以只有**紧邻的上一次调用**是同一个「工具 + 参数」才累加，
 * 中间插进任何别的工具、或用户开口（新任务 / 插话），计数立刻清零。
 */
const REPEAT_WARN = 3;
const REPEAT_WARN_AGAIN = 6;
const REPEAT_HARD = 12;

/** 连续重复的计数状态：`key` 是紧邻上一次的判据键，`count` 是它连了几次。 */
export interface RepeatStreak {
  key: string | null;
  count: number;
}

/** 空计数（新任务 / 插话后回到这个值）。 */
export const NO_STREAK: RepeatStreak = { key: null, count: 0 };

/** 记一次调用，返回新的连续计数（纯函数，单测覆盖）：换了键就从 1 重新数。 */
export function advanceStreak(prev: RepeatStreak, key: string): RepeatStreak {
  return prev.key === key ? { key, count: prev.count + 1 } : { key, count: 1 };
}

/**
 * 「同一组参数」不等于「同一个问题」的工具。
 *
 * `render_frame` / `frame_signature` 的入参只有 t 与 size —— 工程在这两次调用
 * 之间被改过时，重新渲一次恰恰是**正确**的动作。判据因此带上场景版本
 * （`control.sceneVersion()`：内容版本 + 播放头），工程变了就重新计数。
 */
const SCENE_SENSITIVE_TOOLS = new Set(['render_frame', 'frame_signature']);

/** 重复调用的判据键（纯函数，单测覆盖）。场景敏感的工具带上版本。 */
export function repeatKeyOf(
  name: string,
  argsJson: string,
  scene?: { version: number; playT: number } | null,
): string {
  const base = `${name}:${argsJson}`;
  if (!scene || !SCENE_SENSITIVE_TOOLS.has(name)) return base;
  return `${base}@${scene.version}:${scene.playT}`;
}

/** 第 n 次重复同一个「工具 + 参数」时该做什么（纯函数，单测覆盖）。 */
/** 控制平面结果 → 工具结果。与 `executor` 的包装同形，避免回环里再造一份。 */
function outcomeOf<T>(r: ControlResult<T>): ToolOutcome {
  return r.ok
    ? { ok: true, text: JSON.stringify({ ok: true, data: r.data }) }
    : {
        ok: false,
        code: r.error.code,
        detail: r.error.detail,
        text: JSON.stringify({ ok: false, error: r.error }),
      };
}

export type RepeatAction = 'none' | 'hint' | 'stop';

export function repeatAction(n: number): RepeatAction {
  if (n >= REPEAT_HARD) return 'stop';
  if (n === REPEAT_WARN || n === REPEAT_WARN_AGAIN) return 'hint';
  return 'none';
}

/** 恢复会话时的一条起点消息（历史里只留对话文本 + Files API 的图片引用）。 */
export interface ResumeEntry {
  role: 'user' | 'assistant';
  content: string;
  files?: StoredFile[];
}

export interface SessionOptions {  config: LlmConfig;
  control: AgentControlPlane;
  execute: ToolExecutor;
  onEvent(e: SessionEvent): void;
  onStatus(s: AgentStatus): void;
  /**
   * 需要用户确认的动作（插件试挂 / 安装）。返回 true = 已批准。
   *
   * `kind` 区分两种语义：`try` 会**立刻执行**源码（载入内存 + 真 GL 编译校验），
   * `install` 才会写盘。面板按它切换文案与「本次会话允许试挂」。
   *
   * 由面板实现：弹一张卡，用户点了才 resolve(true)。session 拿到 true 之后
   * 自己带 `confirm:true` 再调一次控制平面 —— UI 不直接改状态。
   */
  onApproval?(req: {
    /** `media` = 媒体池动作（会移动 / 删除磁盘文件）。 */
    kind: 'try' | 'install' | 'media';
    /** 插件 id；`media` 时是空串。 */
    pluginId: string;
    /** `media` 时给 `{ op, assetId?, assetName? }`。 */
    media?: { op: string; assetId?: string; assetName?: string };
    detail?: unknown;
    text: string;
  }): Promise<boolean>;
  /**
   * 模型调用 `ask_user` 时由面板弹一张问答卡，回答直接作为工具结果回给模型。
   * 返回 `null` = 用户取消（工具结果里写 cancelled）。
   */
  onAskUser?(req: { question: string; options: string[]; allowFreeText: boolean }): Promise<string | null>;
  /**
   * 每轮是否允许把截图注入对话。默认 true。
   *
   * 关掉时工具**照常渲染**（用户仍能在面板上看到缩略图），只是模型看不到画面，
   * 只能靠 `frame_signature` 判断 —— 这正是设置里那个开关的语义。
   */
  screenshots?(): boolean;
  /** 单轮最多几次「模型 → 工具」往返。给函数则每轮重新读（设置里改了立刻生效）。 */
  maxSteps?: number | (() => number);
  /**
   * 取走用户在本轮进行中插入的消息（「插话」）。**每次模型调用之前**调一次。
   *
   * 返回即视为送达（面板那边同时清空排队与卡片）。session 负责把它们追加成
   * `role:'user'` 消息并发 `kind:'user'` 事件 —— 面板不要自己再插一条气泡。
   */
  takeInterjections?(): InterjectionInput[];
  /**
   * 从历史恢复的起点消息（`agent/history.ts::resumedMessages`）。
   *
   * 只在**构造**时读一次：恢复是这条会话的开头，之后每一轮都往后追加。
   * 传进来的必须是不含 `tool_calls` / `tool_call_id` 的纯 user / assistant 文本 ——
   * 孤立的工具对会让服务端直接 400，所以这里再滤一遍角色。
   *
   * `files` 是 Files API 的图片引用：恢复时按 `file_id` 重建 `file` 块，
   * 模型因此能看到当时的截图，而不是只读到一行「[image]」说明。
   */
  initialMessages?: ResumeEntry[];

  /* ------------------------------------------------------ 子代理专用 */

  /**
   * 这个会话的系统提示。缺省 = 主代理的 `SYSTEM_PROMPT`。
   *
   * **改它必须走 `this.sysPrompt`**：`SYSTEM_PROMPT` 在四个地方被写进历史
   * （构造 / `clear()` / 压缩重建 / 400 自愈），漏一处的表现是「子代理某次
   * 400 之后突然开始用主代理的人格说话」，而且只在异常路径复现。
   *
   * 必须是**整会话不变的常量** —— 同一条缓存纪律，见 `uiSnapshotText()`。
   */
  systemPrompt?: string;
  /** 这一轮可用的工具清单。缺省 = `toolsFor(...)` 的全集过滤。 */
  tools?: readonly ToolSpec[];
  /** 独立上下文预算。缺省 = 当前模型的窗口。 */
  contextLimit?: number;
  /** 是否把整轮包进一笔撤销。子代理必须是 `false`（父轮已持事务）。 */
  tx?: boolean;
  /** 写栅栏与事件归属用。缺省 = 父代理。 */
  ownerId?: string;
  /** 每次模型调用之后上报本步用量。子代理的 token 靠它累加进父轮费用。 */
  onUsage?(tokens: UsageTokens): void;
  /**
   * 是否把「用户在哪」（播放头 / 视图 / 选区）拼进 user 消息尾部。
   *
   * 子代理关掉它：它不该关心用户在看哪儿，而且固定输入才可复现。
   */
  contextSuffix?: boolean;
  /** 子代理：父轮进行中把已完成的结果注入成一条 user 消息。 */
  subagents?: SubagentInbox;
  /**
   * 写栅栏。只在**审批重放**那一条路上用到：`plugin_try` / `media_op` /
   * `plugin_install` 在用户点了批准之后由会话层直接调控制平面，
   * **不经过 `execute`** —— 不补这一道，「用户点了批准却被 conflict 拒绝」
   * （或者更糟：批准期间有子代理占了那块区域，重放照样写进去）。
   */
  fence?: WriteFence;
}

export interface SessionSnapshot {
  messages: WireMessage[];
  status: AgentStatus;
  usage: LlmUsage | null;
}

function messageChars(m: WireMessage): number {
  let n = m.reasoning_content?.length ?? 0;
  if (typeof m.content === 'string') n += m.content.length;
  else if (Array.isArray(m.content)) {
    n += m.content.reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : IMAGE_CHARS), 0);
  }
  for (const call of m.tool_calls ?? []) n += call.function.name.length + call.function.arguments.length;
  return n;
}

function messageTokens(m: WireMessage): number {
  let n = estimateTokens(m.reasoning_content ?? '');
  if (typeof m.content === 'string') n += estimateTokens(m.content);
  else if (Array.isArray(m.content)) {
    // 图片按张计（见 IMAGE_TOKENS），不按 base64 长度 —— 后者是请求体的事，
    // 由 `body-budget.ts` 单独管。
    for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS;
  }
  for (const call of m.tool_calls ?? []) {
    n += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
  }
  return n;
}

export function estimateMessagesTokens(messages: WireMessage[]): number {
  let tokens = 0;
  for (const m of messages) tokens += messageTokens(m);
  return tokens;
}

/**
 * 压缩前保留的「最近一段」：从倒数第 N 条开始，**往前**挪到 user 边界。
 * 直接切在 assistant/tool 之间会留下孤立的 `tool_call_id`（服务端 400）。
 */
export function recentTail(messages: WireMessage[], keep = KEEP_RECENT_MESSAGES): WireMessage[] {
  if (messages.length <= keep + 1) return [];
  let start = messages.length - keep;
  for (let i = start; i >= 1; i--) {
    if (messages[i]!.role === 'user') {
      start = i;
      break;
    }
  }
  // 没找到 user 边界就不保留尾巴（宁可全摘要，也不要半截工具对）。
  if (messages[start]?.role !== 'user') return [];
  return messages.slice(start);
}

/** 给总结模型看的转录：每条截断，避免「压缩请求本身爆上下文」。 */
function transcriptOf(messages: WireMessage[]): string {
  const lines: string[] = [];
  for (const m of messages.slice(1)) {
    let body = '';
    if (typeof m.content === 'string') body = m.content;
    else if (Array.isArray(m.content)) {
      body = m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
    }
    if (m.tool_calls?.length) {
      body += `\n[tool calls] ${m.tool_calls
        .map((c) => `${c.function.name}(${c.function.arguments.slice(0, 400)})`)
        .join(', ')}`;
    }
    if (m.tool_call_id) body = `[tool ${m.tool_call_id}] ${body}`;
    lines.push(`${m.role}: ${body.slice(0, 2000)}`);
  }
  const text = lines.join('\n\n');
  // 总结请求自己也不能无限长：取尾部（最近的上下文更重要）。
  return text.length > 240_000 ? text.slice(-240_000) : text;
}

/**
 * 上下文裁剪：保留 system，从最近往前累加，超出预算时在**一条 user 消息处**
 * 切开（切在 assistant/tool 之间会留下孤立的 `tool_call_id`，服务端会 400）。
 */
export function trimMessages(messages: WireMessage[], budget = MAX_CONTEXT_CHARS): WireMessage[] {
  if (messages.length <= 2) return messages;
  let total = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    total += messageChars(messages[i]!);
    if (total > budget) break;
    cut = i;
  }
  // 没有裁掉任何东西（cut 落在第一条业务消息上）就原样返回。
  if (cut >= messages.length || cut <= 1) return messages;
  // 往前挪到最近的 user 边界（含它）。
  for (let i = cut; i >= 1; i--) {
    if (messages[i]!.role === 'user') {
      return [messages[0]!, ...messages.slice(i)];
    }
  }
  // 前面没有 user：往后找**下一条** user，绝不从 tool / assistant 中间切开
  // （那会留下孤立的 tool_call_id，服务端直接 400）。
  for (let i = cut; i < messages.length; i++) {
    if (messages[i]!.role === 'user') return [messages[0]!, ...messages.slice(i)];
  }
  return messages;
}

/** clear() 打断了在飞的 send：旧的工具结果不能再写进新历史。 */
class SessionReset extends Error {
  constructor() {
    super('session reset');
    this.name = 'SessionReset';
  }
}

/** 工具表里 `writes:true` 的工具名集合（计数用）。 */
const WRITE_TOOLS = new Set(
  Array.from(TOOL_BY_NAME.values())
    .filter((t: ToolSpec) => t.writes)
    .map((t) => t.name),
);

export class AgentSession {
  private messages: WireMessage[];
  private status: AgentStatus = 'idle';
  private abort: AbortController | null = null;
  private usage: LlmUsage | null = null;
  private busy = false;
  /** clear() 推进它；在飞的 send 每个 await 后比对，变了就停。 */
  private generation = 0;
  /** 上下文用量（token）。优先用服务端 usage，缺席时按字符估算。 */
  private contextTokens = 0;
  /** 最近一次失败（导出日志时带出去，便于排查 400）。 */
  lastError: { code: string; message: string; status?: number; detail?: string } | null = null;
  /** 「这个模型收不了图片」只提示一次，别每轮刷屏。 */
  private warnedImages = false;
  /** 「Files API 上传失败，退回内联」也只提示一次。 */
  private warnedUpload = false;
  /** 「请求体超限丢了几张图」每轮只提示一次（每一步都会丢同一批，刷屏没用）。 */
  private warnedShed = false;
  /** 本轮所有请求的缓存账（见 `CacheStats`）。 */
  private turnCache: CacheStats | null = null;
  /** 本轮所有请求的 token 三档（计费用的；与缓存账分开，后者可能整个不上报）。 */
  private turnTokens: UsageTokens = { hit: 0, miss: 0, out: 0 };

  constructor(private readonly opts: SessionOptions) {
    // 系统提示是**纯常量**，见 `uiSnapshotText` 的注释（缓存纪律）。
    this.messages = [{ role: 'system', content: this.sysPrompt }];
    const restored = (opts.initialMessages ?? []).filter(
      (m) => m.role === 'user' || m.role === 'assistant',
    );
    if (restored.length) {
      for (const m of restored) {
        this.messages.push({ role: m.role, content: this.resumedContent(m) });
      }
      // 末尾那句是**给模型看的**：历史里没有工具调用与结果（见 `RESUME_NOTE`）。
      this.messages.push({ role: 'user', content: RESUME_NOTE });
      // 环形进度条必须立刻反映「已经背着的上下文」，否则恢复后看起来像空会话。
      this.contextTokens = estimateMessagesTokens(this.messages);
      this.emitContext();
    }
  }

  /**
   * 恢复的一条消息 → 线格式内容。
   *
   * 图片引用（`file_id`）在三种情况下不能照搬，否则要么 400、要么让模型对着
   * 一个死 id 说话：
   *   - 这家没有 Files API（换过提供商）→ 降级成一行说明；
   *   - 引用已过期（30 天前的上传）→ 同降级；
   *   - 全部过期 → 退回纯文本。
   * 降级必须**明说**「图没了」，不能静默去掉：模型会以为它还看得见。
   */
  private resumedContent(m: ResumeEntry): WireMessage['content'] {
    const alive = (m.files ?? []).filter((f) => fileStillValid(f.expiresAt));
    if (!alive.length) return m.content;
    if (!apisOf(this.opts.config.providerId).files) {
      return `${m.content}\n\n[${alive.length} image(s) from the earlier session are not available with this provider]`;
    }
    const parts: WirePart[] = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const f of alive) parts.push({ type: 'file', file_id: f.fileId });
    return parts;
  }

  /**
   * 这一轮开始时「用户在哪」（播放头 / 视图 / 选区）。
   *
   * **拼在 user 消息尾部，不拼进系统提示** —— 这是缓存纪律的核心。
   * 各家的前缀缓存（DeepSeek 硬盘缓存 / 智谱 / Kimi / 阿里的隐式缓存 /
   * Anthropic 的显式断点）都以**逐字节相同的前缀**为前提，而 `messages[0]`
   * 一旦每轮变化，**整段历史都会 miss**（DeepSeek 文档的例子 2：A+B → A+C
   * 命中不了，只能等第三次才认出公共前缀 A）。
   *
   * 摆在句尾也更贴切：播放头与选区本来就是「这句请求的语境」，不是对话的规则。
   * 快照缺席（没有工程 / 宿主没接钩子）时返回空串，不编造。
   */
  private uiSnapshotText(): string {
    let snap: UiContextSnapshot | null = null;
    try {
      snap = this.opts.control.getUiContext?.() ?? null;
    } catch {
      // 界面状态是「锦上添花」：钩子挂了不该让整轮对话发不出去。
      snap = null;
    }
    return snap ? renderUiContext(snap) : '';
  }

  /* ------------------------------------------------------------- 查询 */

  snapshot(): SessionSnapshot {
    return { messages: [...this.messages], status: this.status, usage: this.usage };
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get context(): { tokens: number; limit: number } {
    return { tokens: this.contextTokens, limit: this.limit() };
  }

  /** 系统提示的唯一读取点。见 `SessionOptions.systemPrompt` 的注释。 */
  private get sysPrompt(): string {
    return this.opts.systemPrompt ?? SYSTEM_PROMPT;
  }

  /** 当前 (provider, model) 的上下文窗口。切换模型后立刻生效。 */
  private limit(): number {
    return this.opts.contextLimit ?? contextLimitOf(this.opts.config);
  }

  private emitContext(): void {
    this.opts.onEvent({ kind: 'context', tokens: this.contextTokens, limit: this.limit() });
  }

  clear(): void {
    if (this.busy) this.stop();
    this.generation++;
    // 旧一轮的 finally 会看到代次不同而跳过收尾；这里主动放开新会话的入口。
    this.busy = false;
    this.abort = null;
    this.messages = [{ role: 'system', content: this.sysPrompt }];
    this.usage = null;
    this.contextTokens = 0;
    this.lastError = null;
    this.warnedImages = false;
    this.warnedUpload = false;
    this.warnedShed = false;
    this.emitContext();
    this.setStatus('idle');
  }

  stop(): void {
    this.abort?.abort();
  }

  private setStatus(s: AgentStatus): void {
    this.status = s;
    this.opts.onStatus(s);
  }

  /** 本轮开始时的代次已被 `clear()` 作废 → 停止写入新会话。 */
  private ensureCurrent(generation: number): void {
    if (generation !== this.generation) throw new SessionReset();
  }

  /**
   * 这个 (provider, model) 收不收图片。
   *
   * 不判断的后果不是报错，而是**模型凭空描述画面** —— 它看不到图，却会顺着
   * 上下文里「我截图了」的说法编一段出来。所以能力判定必须在注册表里，
   * 而不是「反正发了也没事」。
   */
  private imagesAllowed(): boolean {
    if (supportsImages(this.opts.config)) return true;
    if (!this.warnedImages) {
      this.warnedImages = true;
      this.opts.onEvent({ kind: 'notice', text: tr('agent.llm.noImages') });
    }
    return false;
  }

  /* ------------------------------------------------------------- 插话 */

  /**
   * 图片 → 消息内容块。**图片注入的唯一路径**（用户附图 / 插话 / 工具截图都走它）。
   *
   * 有 Files API 就先上传换 `file_id`：历史里只留 40 字节的引用，而不是 1–3 MB
   * 的 base64。没有（或者这一张传失败）就内联 —— 内联不是错误，只是贵，
   * 而 `body-budget.ts` 会在请求体真的过大时兜底丢掉最老的几张。
   *
   * `text` 放在最前面：同样的输入必须生成同样的字节序列（前缀缓存按字节比）。
   */
  private async mediaParts(
    text: string,
    images: readonly { base64: string; mimeType: string; caption?: string }[],
    nameOf: (index: number, image: { base64: string; mimeType: string }) => string,
    signal?: AbortSignal,
  ): Promise<{ parts: WirePart[]; files: StoredFile[] }> {
    const parts: WirePart[] = [];
    if (text) parts.push({ type: 'text', text });
    const files: StoredFile[] = [];
    const canUpload = Boolean(apisOf(this.opts.config.providerId).files);

    for (const [i, img] of images.entries()) {
      if (canUpload) {
        try {
          const up = await uploadImage(this.opts.config, img, nameOf(i, img), signal);
          files.push({
            fileId: up.fileId,
            mimeType: img.mimeType,
            ...(img.caption ? { caption: img.caption } : {}),
            expiresAt: up.expiresAt,
          });
          parts.push({ type: 'file', file_id: up.fileId });
          continue;
        } catch (e) {
          this.warnUpload(e);
        }
      }
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'low' },
      });
    }
    return { parts, files };
  }

  private warnUpload(e: unknown): void {
    if (this.warnedUpload) return;
    this.warnedUpload = true;
    this.opts.onEvent({
      kind: 'notice',
      text: tr('agent.llm.uploadFailed', { detail: (e instanceof Error ? e.message : String(e)).slice(0, 120) }),
    });
  }

  /**
   * 把排队的插话注入成 user 消息，返回注入了几条。
   *
   * **只在两次模型调用之间注入**：工具批跑完、截图注入完之后（OpenAI 要求
   * `tool` 消息紧跟 `assistant.tool_calls`，夹在中间等于把整段历史弄成 400），
   * 或者模型这一步已经说完、但用户还插了话的时候（那就再请求一次）。
   *
   * 注入的是普通 `role:'user'` 消息：它是对话里真实发生过的发言，位置要留在
   * 历史里 —— 不是系统提示那种可以随时重写的旁白（那会毁掉前缀缓存）。
   */
  private async drainInterjections(signal?: AbortSignal): Promise<number> {
    const take = this.opts.takeInterjections;
    if (!take) return 0;
    const items = take().filter((i) => i.text.trim());
    if (!items.length) return 0;
    for (const item of items) await this.pushInterjection(item, signal);
    return items.length;
  }

  private async pushInterjection(item: InterjectionInput, signal?: AbortSignal): Promise<void> {
    const text = item.text.trim();
    const images = item.images ?? [];
    // 用户点名过技能时，正文跟着插话一起进来：否则「插话期间选的技能」
    // 会在队列里静默消失，而那是用户明确表达过的要求。
    const skills = renderAttachedSkills(item.skills ?? []);
    const marked = [interjectionText(text), skills].filter(Boolean).join('\n\n');
    const keep = images.length ? this.imagesAllowed() : false;
    if (images.length && keep) {
      const { parts, files } = await this.mediaParts(marked, images, (i) => `interjection-${i + 1}`, signal);
      this.messages.push({ role: 'user', content: parts });
      this.opts.onEvent({ kind: 'user', text, images, ...(files.length ? { files } : {}) });
      return;
    }
    this.messages.push({
      role: 'user',
      content: images.length
        ? `${marked}\n[the user attached ${images.length} image(s); this model cannot read images]`
        : marked,
    });
    // 面板上仍显示用户自己打的字（标注 / 说明是给模型的）。
    this.opts.onEvent({ kind: 'user', text, ...(images.length ? { images } : {}) });
  }

  /* ------------------------------------------------------------- 一轮 */

  /**
   * 把已完成的子代理结果注入成 user 消息。
   *
   * 用 `role:'user'` 而不是 system：DeepSeek 在带 tools 的请求里插 system 会
   * 直接 400（见重复调用那段注释的实测结论）。也不发 `kind:'user'` 事件 ——
   * 那不是用户说的话，面板上由子代理卡自己交代。
   */
  private drainSubagents(): void {
    const pending = this.opts.subagents?.takeResults() ?? [];
    for (const text of pending) this.messages.push({ role: 'user', content: text });
  }

  /**
   * 手动压缩（输入框里的 `/compact`）。
   *
   * 与 75% 的自动压缩走**同一段实现**，差别只有两处：不判阈值（「现在还装得下，
   * 但我想腾地方」是合法诉求），以及把结果**返回给调用方**而不是静默失败 ——
   * 面板必须能说「没压」或「压失败了」，否则用户以为腾出了空间。
   *
   * `abort` 挂在 `this.abort` 上：按停按钮（`stop()`）因此也能中止这一次总结。
   */
  async compact(): Promise<CompactOutcome> {
    if (this.busy) return 'busy';
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      return await this.summarize(ctrl.signal);
    } finally {
      if (this.abort === ctrl) this.abort = null;
    }
  }

  /**
   * 75% 时把前半段对话压成一份交接说明（同一个模型、不带工具）。
   * 失败不致命：继续用原上下文跑，下一轮再试。
   */
  private async maybeCompact(signal: AbortSignal): Promise<void> {
    if (!shouldCompact(this.contextTokens, this.limit())) return;
    await this.summarize(signal);
  }

  /** 压缩的唯一实现。`ok` 之外都**不改** `messages`。 */
  private async summarize(signal: AbortSignal): Promise<Exclude<CompactOutcome, 'busy'>> {
    // 没有可丢的前半段：既不烧一次 API 调用，也不假装压过了。
    if (this.messages.length <= KEEP_RECENT_MESSAGES + 1) return 'short';

    const before = this.contextTokens;
    try {
      const res = await streamChat(
        this.opts.config,
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: summaryRequest(transcriptOf(this.messages)) },
        ],
        // 不带 tools：总结请求不需要工具，也不会被 reasoning_content 回传规则约束。
        undefined,
        signal,
        {},
      );
      const summary = res.content.trim();
      if (!summary) return 'failed';
      const tail = recentTail(this.messages);
      // 找不到安全的尾巴就不压缩：宁可超一点上下文，也不要丢掉当前这一步。
      if (!tail.length) return 'failed';
      this.messages = [
        { role: 'system', content: this.sysPrompt },
        {
          role: 'user',
          content:
            `# Handoff note from the earlier part of this session\n${summary}\n` +
            '(This is a summary produced for you; the original messages were dropped to save context.)',
        },
        ...tail,
      ];
      this.contextTokens = estimateMessagesTokens(this.messages);
      this.opts.onEvent({
        kind: 'notice',
        text: tr('agent.context.compacted', {
          from: Math.round(before / 1000),
          to: Math.round(this.contextTokens / 1000),
        }),
      });
      this.emitContext();
      return 'ok';
    } catch (e) {
      if (e instanceof LlmError && e.code === 'cancelled') throw e;
      // 压缩失败不阻断主流程（例如总结请求被限流）。
      return 'failed';
    }
  }

  /**
   * 发一条用户消息。
   *
   * `refs` 是用户从界面里**标注**的对象（右键 → 添加进上下文）。它们不作为独立
   * 消息存在，而是拼在这条 user 消息末尾 —— 独立成一条会让模型把它当成
   * 「之前某个用户说过的话」，而它其实是这句话的宾语。
   *
   * `skills` 是用户在输入框里用斜杠菜单**点名**的技能：正文直接拼进来，
   * 不等模型自己判断要不要 `read_skill`。用户指名是一种指令，不是提示。
   */
  async send(
    text: string,
    images: { base64: string; mimeType: string }[] = [],
    refs: readonly ContextRef[] = [],
    skills: readonly string[] = [],
  ): Promise<void> {
    const typed = text.trim();
    /*
     * 这一句的语境 = 用户标注的对象 + 用户点名的技能 + 此刻的界面，
     * **全部贴在消息尾部**。顺序固定（标注 → 技能 → 界面）：同样的输入必须
     * 生成同样的字节，否则第二轮的前缀就不是第一轮的严格前缀，缓存直接失效。
     *
     * 子代理关掉最后一段（`contextSuffix: false`）：它不该关心用户在看哪儿。
     * 技能与标注不跟着关 —— 子代理是「这件事的另一个执行者」，它需要同样的宾语。
     */
    const suffix = [
      renderAttachedRefs(refs),
      renderAttachedSkills(skills),
      this.opts.contextSuffix === false ? '' : this.uiSnapshotText(),
    ]
      .filter(Boolean)
      .join('\n\n');
    /*
     * 上一轮跑完但没人取的子代理结果。用户选了「空闲不自动开新轮」，所以它们
     * 搭在这里送出去 —— 抢在 `if (!content)` 之前，否则纯结果的那一次会被丢掉。
     */
    const queued = this.opts.subagents?.takeResults() ?? [];
    const base = queued.length ? [typed, ...queued].filter(Boolean).join('\n\n') : typed;
    const content = suffix ? (base ? `${base}\n\n${suffix}` : suffix) : base;
    if (!content && !images.length) return;
    if (this.busy) {
      this.opts.onEvent({ kind: 'error', message: tr('agent.llm.busy'), code: 'busy' });
      return;
    }

    this.busy = true;
    this.lastError = null;
    this.turnCache = null;
    this.turnTokens = { hit: 0, miss: 0, out: 0 };
    // 子代理的账也按轮算：不清零的话第二轮的 `turn-end` 会把上一轮的算进去。
    this.opts.subagents?.resetUsage();
    this.warnedShed = false;
    const startedAt = Date.now();
    const ctrl = new AbortController();
    this.abort = ctrl;
    const signal = ctrl.signal;
    let writes = 0;
    const generation = this.generation;

    /*
     * ⚠️ **不要在这里重写 `messages[0]`。** 系统提示必须是整个会话不变的常量：
     * 前缀缓存按字节比较，而各家（DeepSeek / 智谱 / Kimi / 阿里 / Anthropic）
     * 的第一条消息就是缓存前缀的开头。早先这里每轮把播放头拼进系统提示，
     * 代价是**每一轮全部历史按未命中计费**，而且从回执上看不出来。
     * 动态语境一律进 user 消息尾部（见上面 `suffix`）。
     */

    let attachedFiles: StoredFile[] = [];
    if (images.length) {
      const keep = this.imagesAllowed();
      if (keep) {
        const built = await this.mediaParts(content, images, (i) => `attach-${i + 1}`, signal);
        this.messages.push({ role: 'user', content: built.parts });
        attachedFiles = built.files;
      } else {
        this.messages.push({
          role: 'user',
          content: `${content}\n\n[the user attached ${images.length} image(s); this model cannot read images]`.trim(),
        });
      }
    } else {
      this.messages.push({ role: 'user', content });
    }
    // 面板上只显示用户自己打的字：标注块是给模型的，铺进气泡里只是噪声。
    this.opts.onEvent({
      kind: 'user',
      text: typed,
      ...(images.length ? { images } : {}),
      ...(attachedFiles.length ? { files: attachedFiles } : {}),
    });

    try {
      /*
       * 整轮包一笔撤销。失败（例如已经有事务开着）不致命：退回逐笔撤销。
       *
       * `tx: false` 是子代理的形态：父轮已经持着事务，控制平面的 `txOpen` 是
       * 单实例单标志，再开一次必然 conflict；子代理的写因此留在**父的事务**里，
       * 用户按一次 Ctrl+Z 仍然撤掉整轮。
       */
      if (this.opts.tx !== false) {
        try {
          await this.opts.control.beginTx('session');
        } catch {
          /* 退回逐笔撤销 */
        }
      }
      this.ensureCurrent(generation);
      this.setStatus('thinking');
      /*
       * 工具表按**这一家有没有附加 API** 过滤（联网检索要用注册表里声明的端点）。
       * 同一轮内必须稳定：模型看到的那份 schema 变了，前缀缓存立刻失效。
       * `AGENT_TOOLS` 是全集，`TOOL_BY_NAME` 仍是全集（用于识别"模型调了个这次
       * 没声明的工具"→ 明确报错，而不是当未知工具）。
       *
       * 子代理传自己的清单（预设）。`toolNames` 是**执行期的白名单**：光靠
       * 「发给模型的 schema 里没有」挡不住幻觉调用，而 `TOOL_BY_NAME` 是全集。
       */
      const apis = apisOf(this.opts.config.providerId);
      const tools =
        this.opts.tools ??
        toolsFor({
          search: Boolean(apis.search),
          fetch: Boolean(apis.fetch),
          // 设置里关掉 / 没有宿主 ⇒ `spawn_agent` 不出现在这一轮的 schema 里。
          subagents: Boolean(this.opts.subagents?.available()),
        });
      const toolNames = this.opts.tools ? new Set(this.opts.tools.map((t) => t.name)) : null;
      /*
       * 连续重复计数（见 `REPEAT_WARN`）：只在**紧邻的上一次**调用同工具同参数时累加。
       * 每轮任务新建一份 = 新任务自动清零；插话（用户开口）也清零，见 drain 处。
       */
      let streak: RepeatStreak = NO_STREAK;
      const resetStreak = (): void => {
        streak = NO_STREAK;
      };
      const configured = this.opts.maxSteps ?? MAX_STEPS;
      const maxSteps = Math.max(1, typeof configured === 'function' ? configured() : configured);

      for (let step = 0; step < maxSteps; step++) {
        if (signal.aborted) throw new LlmError('cancelled', tr('agent.llm.cancelled'));
        this.ensureCurrent(generation);

        /*
         * 子代理结果在这里落地：上一轮的 tool 消息已经 push 完，所以插一条
         * `role:'user'` 不会把 `assistant.tool_calls` 与它的 `tool` 结果拆开
         * （那会让 DeepSeek 400）。
         *
         * **只在循环顶部**，不在「模型没有 tool call → break」那个点：那里注入
         * 等于自动续轮，而用户明确不要空闲时自动开新轮。模型收尾了就走排队。
         */
        this.drainSubagents();
        await this.maybeCompact(signal);
        this.ensureCurrent(generation);
        /*
         * 硬裁剪的预算必须跟着**这个模型**的窗口走。写死 `MAX_CONTEXT_CHARS`
         * 的后果：128k 的模型要一路跑到 96 万 token 才肯裁，于是「压缩没触发、
         * 上游先拒绝」。裁剪会改变前缀（缓存必然 miss 一次），所以只在**真的
         * 装不下**时发生。
         */
        const trimmed = trimMessages(this.messages, this.limit() * CHARS_PER_TOKEN);
        if (trimmed.length !== this.messages.length) {
          this.messages = trimmed;
          // 裁完要立刻把环拉回真实值：否则面板还显示裁剪前的数字，直到下一次回执。
          this.contextTokens = Math.min(this.contextTokens, estimateMessagesTokens(this.messages));
          this.emitContext();
        }

        let streamed = '';
        const result = await streamChat(this.opts.config, this.messages, tools, signal, {
          onText: (d) => {
            if (generation !== this.generation) return;
            streamed += d;
            this.opts.onEvent({ kind: 'assistant', text: d });
          },
          onReasoning: (d) => {
            if (generation !== this.generation) return;
            this.opts.onEvent({ kind: 'reasoning', text: d });
          },
        });
        this.ensureCurrent(generation);
        if (result.usage) this.usage = result.usage;
        /*
         * 缓存账按**这一轮的所有请求**累加：工具循环里第一步几乎必然 0%
         * （整段前缀第一次见），后几步接近 100%。单看最后一次会高得离谱，
         * 单看第一次又会低得离谱 —— 用户要的是「这轮我少付了多少」。
         */
        this.turnCache = mergeCacheStats(this.turnCache, cacheStatsOf(result.usage));
        const spent = tokensOf(result.usage);
        this.turnTokens = {
          hit: this.turnTokens.hit + spent.hit,
          miss: this.turnTokens.miss + spent.miss,
          out: this.turnTokens.out + spent.out,
        };
        // 子代理的账要算进父轮：不加这条，用户看到的钱只有一半。
        this.opts.onUsage?.(spent);
        /*
         * 字节预算丢过图：告诉模型一次。静默丢弃的后果是它「记得自己截过图」，
         * 于是对着已经不在上下文里的画面继续推理（而且不报错）。
         */
        if (result.omittedImages && !this.warnedShed) {
          this.warnedShed = true;
          this.opts.onEvent({
            kind: 'notice',
            text: tr('agent.llm.bodyShed', { n: result.omittedImages }),
          });
        }
        // usage 是服务端的真实计数；没有时按字符估算（压缩后的第一轮就是这种）。
        if (result.usage?.prompt_tokens) {
          this.contextTokens = result.usage.prompt_tokens + (result.usage.completion_tokens ?? 0);
        } else {
          this.contextTokens = estimateMessagesTokens(this.messages);
        }
        this.emitContext();

        const assistant: WireMessage = {
          role: 'assistant',
          content: result.content || (streamed ? streamed : null),
          /*
           * 思维链**文本**。存下来是必须的：DeepSeek 带 `tools` 时每一轮都要
           * 回传（漏传 = 400）。至于发不发出去，由适配器按 provider 的
           * `thinking.echo` 决定 —— session 不在这个层面做任何 provider 判断。
           */
          reasoning_content: result.reasoning,
          ...(result.toolCalls.length
            ? {
                tool_calls: result.toolCalls.map<WireToolCall>((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments || '{}' },
                })),
              }
            : {}),
          /*
           * 内部字段：Anthropic 的 thinking/redacted_thinking 原始块、OpenRouter 的
           * `reasoning_details`。**不能上线** —— 序列化器会剥掉它。
           * 带 `providerId` 是为了切家之后不再把别家的推理回传过去。
           */
          providerMeta: {
            providerId: this.opts.config.providerId,
            ...(result.reasoningRaw ? { reasoning: result.reasoningRaw } : {}),
          },
        };
        this.messages.push(assistant);

        /*
         * 模型这一步说完了 —— 但如果用户在这期间插了话，就当「下一次调用」
         * 把它带上继续跑（否则用户得再按一次发送，而他要的正是「不用再按」）。
         */
        if (!result.toolCalls.length) {
          // 用掉最后一步时不再 continue：插话已经进了历史，下一轮模型会看到它。
          if (await this.drainInterjections(signal)) {
            resetStreak();
            if (step < maxSteps - 1) continue;
          }
          break;
        }
        if (signal.aborted) throw new LlmError('cancelled', tr('agent.llm.cancelled'));
        this.setStatus('tool');

        const images: { base64: string; mimeType: string; caption: string }[] = [];

        for (const call of result.toolCalls) {
          const spec = TOOL_BY_NAME.get(call.name);
          const callId = call.id;
          let args: Record<string, unknown> = {};
          /*
           * 白名单闸门。**必须在 `ask_user` 分支之前**：那一支不经过
           * `execute`，只靠「schema 里没给」挡不住模型自己编一个名字 ——
           * 子代理幻觉调用 `ask_user` 会真的给用户弹一张问答卡。
           */
          if (toolNames && !toolNames.has(call.name)) {
            const out: ToolOutcome = {
              ok: false,
              code: 'not-available',
              text: JSON.stringify({
                ok: false,
                error: {
                  code: 'not-available',
                  message:
                    `The tool \`${call.name}\` is not available to you. ` +
                    'Use one of the tools listed in this request; if that is not enough, ' +
                    'report the limitation in "gaps" instead of working around it.',
                },
              }),
            };
            this.pushToolResult(callId, out);
            this.opts.onEvent({ kind: 'tool', callId, name: call.name, args: {}, status: 'error', code: 'not-available', text: out.text });
            resetStreak();
            continue;
          }
          if (!spec) {
            const out: ToolOutcome = {
              ok: false,
              code: 'not-found',
              text: JSON.stringify({ ok: false, error: { code: 'not-found', message: tr('agent.llm.toolUnknown', { name: call.name }) } }),
            };
            this.pushToolResult(callId, out);
            this.opts.onEvent({ kind: 'tool', callId, name: call.name, args: {}, status: 'error', code: 'not-found', text: out.text });
            resetStreak();
            continue;
          }
          try {
            args = parseToolArguments(call);
          } catch (e) {
            const out: ToolOutcome = {
              ok: false,
              code: 'invalid-argument',
              text: JSON.stringify({
                ok: false,
                error: {
                  code: 'invalid-argument',
                  message: tr('agent.llm.toolArgs', { name: call.name, detail: e instanceof Error ? e.message : String(e) }),
                },
              }),
            };
            this.pushToolResult(callId, out);
            this.opts.onEvent({ kind: 'tool', callId, name: call.name, args: {}, status: 'error', code: 'invalid-argument', text: out.text });
            resetStreak();
            continue;
          }

          /*
           * `ask_user` 不经过控制平面：它要的不是工程数据，而是**一个人**。
           * 回答直接作为 tool result 回给模型；面板同时收到一张问答卡。
           */
          if (call.name === 'ask_user') {
            const askStart = Date.now();
            const question = typeof args.question === 'string' ? args.question.trim() : '';
            const options = Array.isArray(args.options)
              ? args.options.filter((x): x is string => typeof x === 'string').slice(0, 6)
              : [];
            const allowFreeText = args.allowFreeText !== false;
            let out: ToolOutcome;
            if (!question || !this.opts.onAskUser) {
              out = {
                ok: false,
                code: 'unsupported',
                text: JSON.stringify({
                  ok: false,
                  error: { code: 'unsupported', message: 'ask_user is not available in this client' },
                }),
              };
            } else {
              this.setStatus('awaiting-user');
              this.opts.onEvent({ kind: 'ask', question, options, allowFreeText });
              const answer = await this.opts.onAskUser({ question, options, allowFreeText });
              this.ensureCurrent(generation);
              this.setStatus('tool');
              out =
                answer === null
                  ? {
                      ok: false,
                      code: 'cancelled',
                      text: JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'user cancelled' } }),
                    }
                  : { ok: true, text: JSON.stringify({ ok: true, data: { answer } }) };
            }
            this.pushToolResult(callId, out);
            this.opts.onEvent({
              kind: 'tool',
              callId,
              name: 'ask_user',
              args: { question },
              status: out.ok ? 'ok' : 'error',
              ...(out.code ? { code: out.code } : {}),
              text: out.text,
              ms: Date.now() - askStart,
            });
            resetStreak();
            continue;
          }

          /*
           * 重复调用的处理阶梯（见 REPEAT_WARN 的注释）：先**引导**，不掐断。
           *
           * 只数**连续**：`advanceStreak` 在键变了时从 1 重新计，连着的才累加。
           *
           * ⚠️ 引导**不能**作为 system 消息插到 assistant/tool 之间 —— DeepSeek 在
           * 带 tools 的请求上会因此 400（实测：第 3 次提示后整轮失败，且历史被污染，
           * 之后每一条消息都 400）。改成**附加在这条 tool 结果后面**：结构不变，
           * 模型照样读得到。
           */
          let scene: { version: number; playT: number } | null = null;
          if (SCENE_SENSITIVE_TOOLS.has(call.name)) {
            const v = await this.opts.control.sceneVersion();
            this.ensureCurrent(generation);
            if (v.ok) scene = v.data;
          }
          const key = repeatKeyOf(call.name, call.arguments, scene);
          streak = advanceStreak(streak, key);
          const n = streak.count;
          const repeatStep = repeatAction(n);
          let guidance: string | null = null;
          if (repeatStep === 'hint') {
            guidance =
              `\n\n[system note] You have called \`${call.name}\` with identical arguments ${n} times in a row. ` +
              'Read the result above again. If it already answered the question, continue with the ' +
              'next step; if it failed, change the arguments or the approach; if you are blocked by ' +
              'an ambiguity in the user request, call `ask_user`. Do not repeat it again.';
            this.opts.onEvent({
              kind: 'notice',
              text: tr('agent.llm.loopNotice', { name: call.name, n }),
            });
          }
          if (repeatStep === 'stop') {
            throw new LlmError('bad-response', tr('agent.llm.loop', { n }));
          }

          this.opts.onEvent({ kind: 'tool', callId, name: call.name, args, status: 'running' });
          const startedAt = Date.now();
          let out = await this.opts.execute(call.name, args, {
            ...(this.opts.ownerId ? { ownerId: this.opts.ownerId } : {}),
            // `wait_for_agent` 靠它响应父代理的「停止」；不传就要等满墙钟。
            signal,
          });
          this.ensureCurrent(generation);

          /*
           * 需要审批：交给面板。用户点了之后 session 带 `confirm:true` 再调一次
           * 控制平面 —— 面板不直接改状态。
           *
           * 两条路径：
           *  · `plugin_try` 会**立刻执行**源码，批准后用同一份参数重试；
           *  · `plugin_install` 只写盘，批准后按 pluginId 安装。
           * 工具面不暴露 `confirm`（模型不能自己批准），所以这一层必须按名字分流。
           */
          /*
           * 审批重放的栅栏。这三条（`media_op` / `plugin_try` / `plugin_install`）
           * 在用户点批准之后**不经过 `execute`**，所以栅栏得在这里补一道，而且
           * 必须在**弹卡之前** —— 否则用户点了批准才发现被 conflict 拒绝，
           * 他刚做的决定没有任何意义。
           */
          if (!out.ok && out.code === 'needs-approval' && this.opts.fence) {
            const verdict = this.opts.fence.check(this.opts.ownerId ?? PARENT_OWNER, writeTargetsOf(call.name, args));
            if (!verdict.ok) {
              out = {
                ok: false,
                code: 'conflict',
                text: JSON.stringify({
                  ok: false,
                  error: {
                    code: 'conflict',
                    message:
                      `Target "${verdict.target}" is reserved by ` +
                      `${verdict.owner === PARENT_OWNER ? 'the parent agent' : `subagent ${verdict.owner}`}. ` +
                      'Nothing was written and nothing was approved.',
                  },
                }),
              };
            }
          }

          if (!out.ok && out.code === 'needs-approval' && this.opts.onApproval) {
            this.setStatus('awaiting-approval');
            const detail = out.detail as
              | { pluginId?: unknown; kind?: unknown; op?: unknown; assetId?: unknown; assetName?: unknown }
              | undefined;
            const pluginId = String(detail?.pluginId ?? args.pluginId ?? '');
            const kind: 'try' | 'install' | 'media' =
              detail?.kind === 'media'
                ? 'media'
                : call.name === 'plugin_try' || detail?.kind === 'try'
                  ? 'try'
                  : 'install';
            const approved = await this.opts.onApproval({
              kind,
              pluginId,
              ...(kind === 'media'
                ? {
                    media: {
                      op: String(detail?.op ?? args.op ?? ''),
                      ...(typeof detail?.assetId === 'string' ? { assetId: detail.assetId } : {}),
                      ...(typeof detail?.assetName === 'string' ? { assetName: detail.assetName } : {}),
                    },
                  }
                : {}),
              detail: out.detail,
              text: out.text,
            });
            this.ensureCurrent(generation);
            this.setStatus('tool');
            if (approved && kind === 'media') {
              // 工具面不暴露 `confirm`：只有用户点过之后，这一层才能自己带上。
              out = outcomeOf(
                await this.opts.control.mediaPoolOp({
                  op: String(args.op ?? '') as never,
                  ...(typeof args.assetId === 'string' ? { assetId: args.assetId } : {}),
                  confirm: true,
                }),
              );
            } else if (approved && kind === 'try') {
              out = outcomeOf(
                await this.opts.control.pluginTry({
                  id: String(args.id ?? pluginId),
                  name: String(args.name ?? ''),
                  // 模型没传 source = 用草稿（`plugin_edit` 之后那条路）。
                  // 这里**不能**塞空串：控制平面会把它当成「有一份空源码」。
                  ...(typeof args.source === 'string' ? { source: args.source } : {}),
                  confirm: true,
                }),
              );
            } else if (approved && pluginId) {
              out = outcomeOf(await this.opts.control.pluginInstall(pluginId, true));
            }
            this.ensureCurrent(generation);
          }

          if (guidance) out = { ...out, text: `${out.text}${guidance}` };
          if (out.ok && WRITE_TOOLS.has(call.name)) writes += 1;
          this.pushToolResult(callId, out);
          this.opts.onEvent({
            kind: 'tool',
            callId,
            name: call.name,
            args,
            status: out.ok ? 'ok' : 'error',
            ...(out.code ? { code: out.code } : {}),
            text: out.text,
            ms: Date.now() - startedAt,
          });
          if (out.images?.length) images.push(...out.images);
          if (signal.aborted) break;
        }

        // 截图统一在**工具轮之后**注入成一条 user 消息（见文件头）。
        // 设置里关掉「截图回传」时只留在面板上，不进模型的上下文。
        if (images.length) {
          const keep = (this.opts.screenshots?.() ?? true) && this.imagesAllowed();
          // 上传是网络往返：先**一次**传完这一批，再拼消息 —— 中途失败也要保证
          // 一条 user 消息里的顺序固定（文字在前），否则前缀字节会变。
          const built = keep
            ? await this.mediaParts(
                images.map((i) => i.caption).join('\n') || 'Rendered frame.',
                images,
                (i) => `frame-${i + 1}`,
                signal,
              )
            : null;
          if (built) this.messages.push({ role: 'user', content: built.parts });
          /*
           * 只有**一张不落**都上传成功时才把引用带出去（`files` 与 `images` 一一对应）。
           * 部分失败时下标就错位了，这时宁可不存引用（历史里只剩说明，和以前一样），
           * 也不要给历史挂一个张冠李戴的 file_id。
           */
          const paired = built && built.files.length === images.length ? built.files : null;
          for (const [i, img] of images.entries()) {
            this.opts.onEvent({
              kind: 'image',
              base64: img.base64,
              mimeType: img.mimeType,
              caption: img.caption,
              ...(paired ? { file: paired[i]! } : {}),
            });
          }
        }

        if (signal.aborted) throw new LlmError('cancelled', tr('agent.llm.cancelled'));
        if (step === maxSteps - 1) {
          throw new LlmError('bad-response', tr('agent.llm.maxSteps', { n: maxSteps }));
        }
        /*
         * 工具结果与截图都拼完之后才注入插话：OpenAI 要求 `tool` 消息紧跟在
         * `assistant.tool_calls` 之后，夹在中间会让整段历史 400。
         */
        if (await this.drainInterjections(signal)) resetStreak();
      }
    } catch (e) {
      if (e instanceof SessionReset || generation !== this.generation) {
        // clear() 已经换掉了历史；旧循环只需安静退出，不能把取消写进新会话。
      } else {
        this.lastError =
          e instanceof LlmError
            ? { code: e.code, message: e.message, status: e.status, detail: e.detail }
            : { code: 'internal', message: e instanceof Error ? e.message : String(e) };

        /*
         * 400 之后**必须换掉上下文**：坏消息（缺 reasoning_content、孤立 tool 等）
         * 会一直留在历史里，导致之后每一条消息都 400。清掉模型历史，UI 记录保留。
         * 这不是「静默吞错」——下面仍会报错，同时给一条可读的提示。
         */
        if (e instanceof LlmError && e.code === 'context') {
          /*
           * 上下文超限**绝不能走下面那条「清空历史」**：那是为了逃离被污染的
           * 历史，而这里只是装不下。把用量顶到窗口上，下一轮开头的 `maybeCompact`
           * 就会触发压缩。
           */
          this.contextTokens = Math.max(this.contextTokens, this.limit());
          this.emitContext();
          this.opts.onEvent({ kind: 'notice', text: tr('agent.llm.contextOverflow') });
        } else if (e instanceof LlmError && e.code === 'bad-response' && e.status === 400) {
          this.messages = [{ role: 'system', content: this.sysPrompt }];
          this.contextTokens = 0;
          this.emitContext();
          this.opts.onEvent({ kind: 'notice', text: tr('agent.llm.resetOn400') });
        }

        this.opts.onEvent({
          kind: 'error',
          message: describeError(e),
          code: e instanceof LlmError ? e.code : 'internal',
        });
      }
    } finally {
      if (this.opts.tx !== false) {
        try {
          await this.opts.control.endTx('agent: turn', 'session');
        } catch {
          /* endTx 失败（事务没开成）不掩盖真正的错误 */
        }
      }
      // 代次已变 = clear() 后已经有了新一轮：旧轮不能改它的 busy / abort / 状态。
      if (generation === this.generation) {
        this.busy = false;
        if (this.abort === ctrl) this.abort = null;
        /*
         * 费用按**这一轮所有请求**的 token 求和后一次算（价目表里没有这一家
         * 就缺席）。峰谷按**轮末**的时段判：一轮通常只有几十秒，跨过 18:00 的
         * 情况不值得为它把账拆成分段积分。
         */
        const own = this.turnTokens;
        const sub = this.opts.subagents?.usage();
        const total = sub ? { hit: own.hit + sub.hit, miss: own.miss + sub.miss, out: own.out + sub.out } : own;
        const cost = costOf(this.opts.config.providerId, this.opts.config.model, total, Date.now());
        this.opts.onEvent({
          kind: 'turn-end',
          writes,
          ms: Date.now() - startedAt,
          // 这家不上报缓存时缺席（面板据此决定显不显示命中率，而不是显示 0%）。
          ...(this.turnCache ? { cache: this.turnCache } : {}),
          ...(cost ? { cost } : {}),
        });
        this.setStatus('idle');
      }
    }
  }

  private pushToolResult(callId: string, out: ToolOutcome): void {
    this.messages.push({ role: 'tool', tool_call_id: callId, content: out.text });
  }
}

function describeError(e: unknown): string {
  if (e instanceof LlmError) {
    switch (e.code) {
      case 'no-key':
        return tr('agent.llm.noKey');
      case 'auth':
        return tr('agent.llm.auth');
      case 'balance':
        return tr('agent.llm.balance');
      case 'rate-limit':
        return tr('agent.llm.rate');
      case 'network':
        return tr('agent.llm.network', { detail: e.detail ?? e.message });
      case 'timeout':
        return tr('agent.llm.timeout', { ms: LLM_TIMEOUT_MS });
      case 'cancelled':
        return tr('agent.llm.cancelled');
      case 'transport':
        return tr('agent.llm.transport', { detail: e.detail ?? e.message });
      case 'context':
        return tr('agent.llm.context');
      case 'unsupported':
        return tr('agent.llm.unsupported', { detail: e.message });
      case 'bad-response':
        // HTTP 400 的响应体是排查的唯一线索（reasoning_content / 工具配对），
        // 别把它吞成一句「HTTP 400」。
        return e.status
          ? tr('agent.llm.http', { status: e.status, detail: (e.detail ?? e.message).slice(0, 500) })
          : e.message || tr('agent.llm.badResponse');
      default:
        return tr('agent.llm.http', { status: e.status ?? 0, detail: e.detail ?? e.message });
    }
  }
  return e instanceof Error ? e.message : String(e);
}
