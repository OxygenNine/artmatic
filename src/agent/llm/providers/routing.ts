/**
 * providers/routing.ts — 「这个模型走哪条路」的**唯一判断点**。
 *
 * 一家提供商默认一种协议，但网关（Cloudflare AI Gateway、自建 one-api /
 * LiteLLM）会在同一 baseUrl 下按模型分流：`anthropic/*` 只能发 `/messages`，
 * `workers-ai/*` 只能发 `/chat/completions`。分流规则是数据
 * （`ModelRule.protocol / pathPrefix`），不是适配器里的分支。
 *
 * 代价说明：`session.ts` / `transport.ts` 里**不许**再出现
 * `def.protocol === ...` —— 一旦出现，网关类就只能在「一半模型能用」之间摆动。
 */

import { modelRule } from './registry';
import type { ModelRule, ProtocolId, ProviderDef, ThinkingPolicy } from './types';

export function ruleFor(def: ProviderDef, model: string): ModelRule | null {
  return modelRule(def, model);
}

/** 有效协议：模型规则优先，缺省跟随提供商。 */
export function protocolFor(def: ProviderDef, model: string): ProtocolId {
  return modelRule(def, model)?.protocol ?? def.protocol;
}

/** 有效思考策略：网关下不同模型可能是不同形态（Claude vs GPT）。 */
export function thinkingPolicyFor(def: ProviderDef, model: string): ThinkingPolicy {
  return modelRule(def, model)?.thinking ?? def.thinking;
}
