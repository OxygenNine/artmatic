/**
 * llm/types.ts — 模型层的线格式与事件类型。
 *
 * ## 为什么历史消息继续用 OpenAI 形状
 *
 * `WireMessage`（`role` / `content` / `tool_calls` / `tool_call_id`）是**内部表示**，
 * 不是「我们只支持 OpenAI」。选它当历史格式的理由：
 *
 *   1. `trimMessages` / `recentTail` / `estimateMessagesTokens` 全靠 `role` 与
 *      `tool_call_id` 的邻接关系判断「哪里能切」，换一套中性模型要把这些纯函数
 *      连同 5 条单测一起重写，收益只是「看起来更抽象」。
 *   2. `role:'tool'` 是无损表示。Anthropic 的「tool_result 塞进 user content」
 *      是**确定性折叠**，出站时做一次就够，不需要在历史里长期维持两套形状。
 *   3. DeepSeek 的请求体可以做到**逐字节不变**（`tests/unit/fixtures/
 *      deepseek-request.golden.json` 钉着），因为 OpenAI 序列化器对没有内部字段的
 *      消息是恒等映射。换成中性模型后这个锚点就没了。
 *
 * 代价：`WireMessage` 从此有**内部字段**（`providerMeta`），任何代码都不许直接
 * `JSON.stringify(messages)` 上线，必须走 `protocol/` 的适配器。
 *
 * 一条硬约束（来自官方文档）：**Chat Completions 下图片只能出现在 `user`
 * 消息里**。工具结果（`role:'tool'`）只能带文本，所以截图要在工具轮结束后
 * 以一条 user 消息注入 —— 见 `session.ts`。
 */

/* ------------------------------------------------------------------ 配置 */

/**
 * 思考强度（界面上的四档）。
 *
 * 这是**UI 词汇**，不是任何一家的原生参数：`off` 在 DeepSeek 是
 * `thinking:{type:'disabled'}`，在 OpenAI 是「干脆不发 `reasoning_effort`」，
 * 在 Anthropic 是不发 `thinking`。翻译全部发生在
 * `providers/reasoning.ts::thinkingParamsFor` —— 那是唯一一处。
 */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';

export interface LlmConfig {
  /** 注册表里的 provider id（决定端点、鉴权、思考形态、代理路由）。 */
  providerId: string;
  /** 有效 baseUrl（不带 `/chat/completions`）。自定义服务商时由用户填。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 采样温度。部分推理模型会忽略或拒绝（见 `ModelRule.temperature`）。 */
  temperature: number;
  /** 输出上限。省略 = 服务端默认（Anthropic 例外：它是必填项）。 */
  maxTokens?: number;
  /** 思考强度。**原生参数**，不是提示词 —— 见 `providers/reasoning.ts`。 */
  effort: ReasoningEffort;
  /**
   * 请求级的额外请求体参数（厂商独有字段的逃生舱）。
   *
   * 合并顺序：`ProviderDef.body` → `ModelRule.body` → 这里，后者覆盖前者。
   * 不要用它绕开 `compat`：能声明成方言的（字段名、开关）属于注册表，
   * 这里只放「一次性 / 试验性的参数」（`top_k`、`min_p`、网关路由偏好）。
   */
  extraBody?: Record<string, unknown>;
  /**
   * 直连失败时的同源兜底路径。`null` = 不兜底。
   *
   * 由 `vite.config.ts` 的 `llmProxy()` 中间件提供（dev 与 preview 都注册），
   * 实际路径是 `<proxyPath>/<providerId>/<端点>`。
   */
  proxyPath: string | null;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.3,
  effort: 'high',
  proxyPath: '/__llm',
};

/* ---------------------------------------------------------------- 线格式 */

export type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 不透明载荷：协议要求**原样回传**、但我们不该解释的东西。
 *
 *   anthropic-blocks     Anthropic 的 thinking / redacted_thinking 块。
 *                        `signature` 是密码学校验，改一个字节下一轮就 400；
 *                        `redacted_thinking` 连 `signature` 都没有，只有 `data`。
 *   openrouter-details   OpenRouter 的 `reasoning_details[]`（带 format / index / signature）。
 *
 * 存进历史、出站时由适配器决定用不用。**session 只写不读**。
 */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type ReasoningRaw =
  | { kind: 'anthropic-blocks'; blocks: AnthropicBlock[] }
  | { kind: 'openrouter-details'; details: unknown[] };

/** 挂在消息上的内部元数据。**任何序列化器都必须剥掉它**。 */
export interface WireProviderMeta {
  /** 产出这条消息的 provider。切家之后旧载荷不该被回传给新家。 */
  providerId: string;
  reasoning?: ReasoningRaw;
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | WirePart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  /**
   * 思维链**文本**。带 `tools` 请求时 DeepSeek 要求每一轮都回传（漏传 = 400），
   * 所以 session 无条件写；至于发不发，由适配器按 provider 的 `echo` 策略决定。
   */
  reasoning_content?: string;
  /** 部分兼容服务要求 tool 消息带函数名；DeepSeek 不要求，带上无害。 */
  name?: string;
  /** 内部字段，见 `WireProviderMeta`。**不上线**。 */
  providerMeta?: WireProviderMeta;
}

/**
 * 服务端 usage。**各家口径不同，字段也不统一** —— 归一化在 `usage.ts`。
 *
 * 三种家族（2026-10 实测文档）：
 *   DeepSeek         `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（prompt_tokens = 两者之和）
 *   OpenAI 兼容家族  `prompt_tokens_details.cached_tokens`（智谱 / Kimi / 阿里 / OpenRouter）；
 *                    阿里部分模型（新加坡地域）把 `cached_tokens` 放在顶层
 *   Anthropic        `cache_read_input_tokens` / `cache_creation_input_tokens`，
 *                    且 `input_tokens` **不含**这两者
 *
 * 没上报缓存的实现这些字段一个都没有 —— 那时**不显示命中率**，而不是显示 0%。
 */
export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek：命中 / 未命中。 */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** OpenAI 兼容家族的嵌套口径（部分实现还带缓存写入数）。 */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** 少数实现（阿里部分模型 / 地域）把命中数放在顶层。 */
  cached_tokens?: number;
  /** Anthropic：不含缓存读写的输入、以及缓存读 / 写。 */
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/**
 * 一条「插话」：模型正在干活时用户发来的内容。
 *
 * 它不进历史里的旧位置，而是在**下一次模型调用之前**追加成一条 user 消息 ——
 * 见 `session.ts` 的 `drainInterjections`。
 */
export interface InterjectionInput {
  text: string;
  images?: { base64: string; mimeType: string }[];
}

export interface ToolCallResult {
  id: string;
  name: string;
  /** 原始 JSON 字符串（由模型生成，可能不合法）。 */
  arguments: string;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCallResult[];
  usage: LlmUsage | null;
  finishReason: string | null;
  /** 需要原样回传的不透明载荷（Anthropic 块 / OpenRouter details）。 */
  reasoningRaw?: ReasoningRaw;
}

/* ------------------------------------------------------------------ 错误 */

export type LlmErrorCode =
  | 'no-key'
  | 'auth'
  | 'balance'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'bad-response'
  | 'server'
  /** 传输路径不可用（例如 provider 禁止浏览器直连、又没配代理）。 */
  | 'transport'
  /** 上下文超限：要**压缩**，不能像普通 400 那样清空历史。 */
  | 'context'
  /** 这个 provider / 模型组合不支持当前操作。 */
  | 'unsupported';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/* ------------------------------------------------------------------ 事件 */

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'awaiting-approval' | 'awaiting-user' | 'error';

/**
 * 缓存账本：一轮里**所有请求**的输入 token 与命中 token 之和。
 *
 * 单次请求的命中率会误导人：工具循环里第一步几乎必然 0%（它是最长的前缀，
 * 第一次见），后几步接近 100%。用户关心的是「这一轮我少付了多少」。
 */
export interface CacheStats {
  /** 命中（按折扣价计费）的输入 token。 */
  hit: number;
  /** 未命中（按原价计费）的输入 token。 */
  newTokens: number;
  /** 输入 token 总数 = hit + newTokens。 */
  total: number;
  /** 缓存写入 token（Anthropic / Kimi 会单独计费）。 */
  writes: number;
  /** 命中率 0–1。 */
  rate: number;
}

export interface ToolCallEvent {
  kind: 'tool';
  /** 工具调用 id（同一个 call 的 running / done 两条事件用它配对）。 */
  callId: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  /** 结果文本（已截断）。 */
  text?: string;
  code?: string;
  ms?: number;
}

export type SessionEvent =
  | { kind: 'user'; text: string; images?: { base64: string; mimeType: string }[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; base64: string; mimeType: string; caption: string }
  /** 模型通过 `ask_user` 主动暂停（面板弹一张问答卡）。 */
  | { kind: 'ask'; question: string; options: string[]; allowFreeText: boolean }
  /** 会话层自己的提示（重复调用提醒、上下文压缩等），不是模型的输出。 */
  | { kind: 'notice'; text: string }
  /** 上下文用量（面板的环形进度条）。`tokens` 优先取服务端 usage。 */
  | { kind: 'context'; tokens: number; limit: number }
  | ToolCallEvent
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'turn-end'; writes: number; ms: number; cache?: CacheStats };

/* ------------------------------------------------------------------ 工具结果 */

export interface ToolOutcome {
  ok: boolean;
  /** 回给模型的文本（JSON 或一句话）。 */
  text: string;
  /** 需要注入成 user 消息的截图。 */
  images?: { base64: string; mimeType: string; caption: string }[];
  /** 机器可读的失败码（`needs-approval` 等）。 */
  code?: string;
  /** 失败的结构化细节（`needs-approval` 时带 pluginId / 源码体积）。 */
  detail?: unknown;
}
