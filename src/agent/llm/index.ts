/**
 * llm/index.ts — 模型层的对外入口（UI 只 import 这里）。
 *
 * 分层：`transport`（网络 + SSE 取帧）→ `protocol/*`（请求体 / 鉴权 / 归约）
 *       → `session`（工具循环）→ `executor`（控制平面）。
 * UI 不需要知道线格式，只消费 `SessionEvent`、`AgentStatus` 与注册表查询。
 */

export {
  AgentSession,
  MAX_STEPS,
  MAX_STEPS_LIMIT,
  repeatAction,
  trimMessages,
  type CompactOutcome,
  type SessionOptions,
  type SessionSnapshot,
} from './session';
export { SuspendGate } from './suspend-gate';
export { createToolExecutor, type ToolExecutor, type ToolContext } from './executor';
/* 子代理：预设与写栅栏是纯逻辑，运行时单独一个文件。
 * **父子必须共用一个 `fence` 实例**，所以它从这里转出给 UI 装配。 */
export {
  createWriteFence,
  checkWrite,
  writeTargetsOf,
  claimDomains,
  presetTools,
  parseSubagentResult,
  isPreset,
  MAX_CONCURRENT_SUBAGENTS,
  PARENT_OWNER,
  type SubagentHost,
  type SubagentInbox,
  type SubagentPreset,
  type SubagentScope,
  type WriteClaim,
  type WriteFence,
} from './subagents';
export { createSubagentRunner, type SubagentRunnerOpts } from './subagent-runner';
/* 对话之外的厂商 API：联网检索 / 文件上传 / 余额 / 计费（UI 只从这里取）。 */
export {
  costOf,
  tokensOf,
  fetchBalance,
  priceEntryOf,
  isPeak,
  beijingClock,
  currencySymbol,
  PRICE_BOOKS,
  CN_HOLIDAYS,
  type BalanceInfo,
  type BalanceSnapshot,
  type PriceBook,
  type PriceEntry,
  type TokenPrice,
  type UsageTokens,
} from './billing';
export { FILE_TTL_SECONDS, fileStillValid, resetFileCache } from './files';
export { fetchPage, parseSearchResults, searchBody, searchWeb, type SearchHit } from './web-tools';
export { INLINE_IMAGE_BUDGET, inlineImageBytes, shedInlineImages } from './body-budget';
export {
  streamChat,
  createSseParser,
  planTransports,
  resetTransportPreference,
  LLM_TIMEOUT_MS,
  type TransportPlan,
} from './transport';
export { parseToolArguments } from './tool-args';
export { SYSTEM_PROMPT } from './prompt';
export { DEFAULT_LLM_CONFIG } from './types';

/* 注册表与能力查询：设置面板 / 抽屉 / 会话层都用它，不要各自维护一份模型列表。 */
export {
  PROVIDERS,
  PROVIDER_BY_ID,
  DEFAULT_PROVIDER_ID,
  providerOf,
  modelRule,
  contextLimitOf,
  supportsImages,
  apisOf,
} from './providers/registry';
export { canDisableThinking, thinkingParamsFor } from './providers/reasoning';
export type { ProviderId } from './providers/ids';
export type {
  AuthSpec,
  Compat,
  CompatOverrides,
  ModelRule,
  ProviderDef,
  ProtocolId,
  ThinkingPolicy,
} from './providers/types';
/* 方言 / 端点 / 分流的解析点：测试与设置面板都用这里，不要各自重算。 */
export { DEFAULT_COMPAT, detectCompat, endpointIsCustom, mergeCompat, resolveCompat } from './providers/compat';
export { authHeaders, endpointFor, endpointTail, mergeHeaders } from './providers/endpoint';
export { protocolFor, ruleFor, thinkingPolicyFor } from './providers/routing';

export type {
  AgentStatus,
  AnthropicBlock,
  ChatResult,
  LlmConfig,
  LlmErrorCode,
  LlmUsage,
  ReasoningEffort,
  ReasoningRaw,
  SessionEvent,
  StoredFile,
  ToolCallEvent,
  ToolOutcome,
  TurnCost,
  WireMessage,
  WirePart,
  WireProviderMeta,
  WireToolCall,
} from './types';
export { LlmError } from './types';
