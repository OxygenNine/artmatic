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
  type SessionOptions,
  type SessionSnapshot,
} from './session';
export { createToolExecutor, type ToolExecutor } from './executor';
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
  ToolCallEvent,
  ToolOutcome,
  WireMessage,
  WirePart,
  WireProviderMeta,
  WireToolCall,
} from './types';
export { LlmError } from './types';
