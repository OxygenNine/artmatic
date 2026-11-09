/**
 * protocol/types.ts — 协议适配器的接口。
 *
 * 划分判据：**只由 `(providerDef, message)` 决定的行为属于适配器；需要会话状态的
 * （步数、重复计数、裁剪位置、事务）属于 session。** 所以「思维链要不要回传」
 * 在这里，也不在 session 里 —— 否则 `session.ts` 会散出五处 provider 分支，
 * 加第 17 家时必然漏一处。
 */

import type { ChatResult, LlmError, LlmConfig, WireMessage } from '../types';
import type { ProviderDef, ProtocolId } from '../providers/types';
import type { ToolSpec } from '../../tools';

export interface StreamHandlers {
  onText?(delta: string): void;
  onReasoning?(delta: string): void;
  /** 工具调用的参数**开始**到达时通知一次（面板可以立刻插一张卡）。 */
  onToolStart?(call: { index: number; id: string; name: string }): void;
}

/**
 * 流式增量归约器：喂已拆好的 `data:` 负载，最终产出 `ChatResult`。
 *
 * 拆成接口而不是「在 fetch 里就地累积」，是为了让两个协议的归约逻辑都能被
 * vitest 直接喂字符串测试 —— 本项目的纪律是**不 mock fetch**。
 */
export interface StreamReducer {
  /** 返回 `true` 表示收到协议终止帧（`[DONE]` 或 `message_stop`）。 */
  push(data: string): boolean;
  /** EOF 或终止后调用；**幂等**。 */
  finish(): ChatResult;
}

export interface BuildBodyArgs {
  config: LlmConfig;
  provider: ProviderDef;
  /** 内部历史（OpenAI 形状），由适配器各自序列化。 */
  messages: readonly WireMessage[];
  /** 中性工具表；序列化形状由协议决定。 */
  tools?: readonly ToolSpec[];
}

export interface ProtocolAdapter {
  readonly id: ProtocolId;
  /** 绝对 URL。`baseUrl` 已归一（无尾斜杠），路径可含 `{model}` 与查询串。 */
  endpoint(baseUrl: string, def: ProviderDef, model: string): string;
  /** content-type + 鉴权 + 协议固定头 + provider/model 头部叠加。 */
  headers(config: LlmConfig, def: ProviderDef, model: string): Record<string, string>;
  /** 请求体（不 stringify，便于深比较与 golden 测试）。 */
  buildBody(args: BuildBodyArgs): Record<string, unknown>;
  /** `model` 决定网关下该读哪家的思维链字段。 */
  createReducer(def: ProviderDef, handlers: StreamHandlers, model: string): StreamReducer;
  /** HTTP 错误归一。 */
  classify(status: number, bodyText: string): LlmError;
}
