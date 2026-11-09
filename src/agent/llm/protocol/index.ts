/**
 * protocol/index.ts — 协议 id → 适配器。
 *
 * 只有两个：`openai`（Chat Completions）与 `anthropic`（Messages）。
 * 哪个模型走哪个由 `providers/routing.ts::protocolFor` 决定 —— 网关会在同一
 * baseUrl 下按模型前缀分流，所以**不要**在传输层读 `def.protocol`。
 * 第 3 门协议（比如 Cohere v2）加进这里、注册表指过去就行，`transport.ts` 不用动。
 */

import { anthropicAdapter } from './anthropic';
import { openAiAdapter } from './openai';
import type { ProtocolAdapter } from './types';
import type { ProtocolId } from '../providers/types';

const ADAPTERS: Record<ProtocolId, ProtocolAdapter> = {
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
};

export function adapterFor(protocol: ProtocolId): ProtocolAdapter {
  return ADAPTERS[protocol];
}

export { anthropicAdapter, openAiAdapter };
