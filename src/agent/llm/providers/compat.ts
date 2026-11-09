/**
 * providers/compat.ts — 请求体方言的**唯一解析点**。
 *
 * 三层来源，后者覆盖前者：
 *
 *   1. 默认值（标准 OpenAI 形状）
 *   2. `detectCompat(baseUrl)` —— 只对**用户自填的端点**生效。注册表里的官方
 *      端点已经有实测结论，不需要猜；自建网关 / 代理 / 自部署 vLLM 才需要。
 *   3. 注册表 `ProviderDef.compat` → `ModelRule.compat`
 *
 * 为什么要有第 2 层：`custom` 这一项的 baseUrl 是用户填的，同一个适配器可能对着
 * DeepSeek、Moonshot、vLLM、one-api。没有嗅探就得让用户自己配四个布尔，而他
 * 根本不知道 `reasoning_effort` 会不会 400。
 *
 * **嗅探只修「已知会 400」的项**，不猜能力：猜错的表现是「本来能用的参数被吞掉」，
 * 比 400 更难发现。
 */

import type { Compat, CompatOverrides } from './types';

export const DEFAULT_COMPAT: Compat = {
  maxTokensField: 'max_tokens',
  streamUsage: true,
  supportsReasoningEffort: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  temperature: 'send',
};

/** 端点 → 方言修正。键是**主机名子串**（与 pi 的判定口径一致，大小写不敏感）。 */
const HOST_RULES: readonly { match: string; compat: CompatOverrides }[] = [
  // 只认 `max_tokens`：文档给的字段名就是它，发另一个会 400。
  { match: 'api.deepseek.com', compat: { maxTokensField: 'max_tokens' } },
  { match: 'api.moonshot.', compat: { maxTokensField: 'max_tokens' } },
  { match: 'api.together.', compat: { maxTokensField: 'max_tokens', supportsReasoningEffort: false } },
  { match: 'integrate.api.nvidia.com', compat: { maxTokensField: 'max_tokens', supportsReasoningEffort: false } },
  { match: 'api.z.ai', compat: { supportsReasoningEffort: false } },
  { match: 'open.bigmodel.cn', compat: { supportsReasoningEffort: false } },
  { match: 'api.x.ai', compat: { supportsReasoningEffort: false } },
  // OpenAI 官方：推理模型只认 `max_completion_tokens`，但老模型认 `max_tokens`。
  // 所以这一项交给 `ModelRule`，不在这里按 host 一刀切。
];

/** 从端点嗅探方言。认不出就返回空对象（= 标准形状）。 */
export function detectCompat(baseUrl: string): CompatOverrides {
  const url = baseUrl.trim().toLowerCase();
  if (!url) return {};
  for (const rule of HOST_RULES) {
    if (url.includes(rule.match)) return rule.compat;
  }
  return {};
}

/**
 * 合并成一份有效方言。
 *
 * `detect` 由调用方决定**传不传**：`endpointIsCustom()` 为 true 时才传 —— 官方
 * 端点的结论在注册表里，让嗅探去覆盖它等于把实测数据降级成猜测。
 */
export function mergeCompat(
  ...layers: readonly (CompatOverrides | undefined)[]
): Compat {
  const out: Compat = { ...DEFAULT_COMPAT };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer) as (keyof Compat)[]) {
      const value = layer[key];
      if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * 用户改过端点吗？
 *
 * 注册表的 `baseUrl` 是实测过的官方端点；一旦被覆盖（自建网关、代理、区域端点），
 * 之前的结论就不成立了 —— 这时才轮到 `detectCompat`。`baseUrlRequired` 的
 * 提供商（Azure / 网关）本身就是用户填的，恒为 true。
 */
export function endpointIsCustom(def: { baseUrl: string; baseUrlRequired?: boolean }, baseUrl: string): boolean {
  if (def.baseUrlRequired) return true;
  const norm = (s: string): string => s.trim().replace(/\/+$/, '').toLowerCase();
  return norm(baseUrl) !== norm(def.baseUrl);
}

/** 有效方言：默认 → （自填端点的）嗅探 → provider → model。 */
export function resolveCompat(
  def: { baseUrl: string; baseUrlRequired?: boolean; compat?: CompatOverrides },
  model: string,
  baseUrl: string,
  ruleCompat?: CompatOverrides,
): Compat {
  const detected = endpointIsCustom(def, baseUrl) ? detectCompat(baseUrl) : {};
  return mergeCompat(detected, def.compat, ruleCompat);
}
