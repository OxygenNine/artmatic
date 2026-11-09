/**
 * providers/registry.ts — 提供商注册表（**单一真源**）。
 *
 * 一份数据同时被四个消费者读：
 *   1. 浏览器里的适配器（baseUrl / 端点 / 鉴权 / 思考形态 / 模型规则）
 *   2. `vite.config.ts` 传给 `llmProxy()` 的转发白名单（`PROXY_ROUTES`）
 *   3. 设置面板与抽屉里的下拉（顺序即数组顺序）
 *   4. 单测的注册表守卫
 * 所以这里只放**纯数据与纯查询**，不许有 fetch / DOM / 计时器。
 *
 * ## 关于 `models`
 *
 * 这些是**预设**，不是白名单 —— UI 允许手填任意模型名。别名（`qwen-plus`、
 * `kimi-latest`）会随服务端前移，快照名会过期，两者都不该被当成契约。
 * 端点与差异矩阵见 `docs/provider-matrix.md`。
 */

import { LlmError, type LlmConfig } from '../types';
import type { ProviderId } from './ids';
import type { ModelRule, ProviderDef } from './types';

/* ---------------------------------------------------------------- 共同片段 */

const OPENAI_PATH = '/chat/completions';
const ANTHROPIC_PATH = '/messages';

/** 绝大多数国产厂商：`thinking:{type}` 开关 + `reasoning_content` 回传。 */
const toggle = (canDisable = true) =>
  ({ style: 'toggle', field: 'reasoning_content', echo: 'optional', canDisable }) as const;

const openAiCompat = {
  maxTokensField: 'max_tokens',
  streamUsage: true,
  temperature: 'send',
} as const;

/* ------------------------------------------------------------------ 注册表 */

export const PROVIDERS: readonly ProviderDef[] = [
  /* ---------------------------------------------------------------- 国内 */
  {
    id: 'deepseek',
    labelKey: 'agent.provider.deepseek',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['deepseek-flash', 'deepseek-chat'],
    contextWindow: 1_000_000,
    thinking: {
      style: 'deepseek',
      field: 'reasoning_content',
      // 带 tools 时**漏传就 400**，官方硬要求。这条是整个适配层最不能简化的一项。
      echo: 'required',
      canDisable: true,
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'dashscope',
    labelKey: 'agent.provider.dashscope',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus'],
    contextWindow: 128_000,
    thinking: {
      style: 'budget',
      field: 'reasoning_content',
      /*
       * `preserve_thinking` 默认 false，官方对我们这种「不带回历史思维链」的用法
       * 是兼容的（文档明确：历史里没有 reasoning_content 不报错）。选择不回传：
       * 回了要把历史思考重新计费，而且 qwen3.8-max 那几个型号还强制要求完整回传，
       * 一旦切模型就会在「有时对有时错」之间摆动。
       */
      echo: 'never',
      canDisable: true,
      budgets: { low: 1_024, high: 4_096, max: 16_384 },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'zhipu',
    labelKey: 'agent.provider.zhipu',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['glm-4.6', 'glm-4.5-air', 'glm-4.5v'],
    contextWindow: 128_000,
    thinking: {
      style: 'toggle',
      field: 'reasoning_content',
      // 官方明确「不要在后续请求里携带 reasoning_content」。
      echo: 'never',
      canDisable: true,
    },
    compat: openAiCompat,
    // glm-5.3 / 5.3-flash 关不掉思考，传 disabled 直接 400。
    modelRules: [{ prefix: 'glm-5.3', alwaysThinking: true }],
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'kimi',
    labelKey: 'agent.provider.kimi',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['kimi-latest', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    contextWindow: 128_000,
    thinking: toggle(),
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'doubao',
    labelKey: 'agent.provider.doubao',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    /*
     * 方舟早期要求填**推理接入点 id**（`ep-...`），新版认模型名。两种都合法，
     * 所以这里给模型名、允许用户改填 ep id。
     */
    models: ['doubao-seed-1.6', 'doubao-1.5-pro-32k'],
    contextWindow: 128_000,
    thinking: toggle(),
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'hunyuan',
    labelKey: 'agent.provider.hunyuan',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-lite'],
    contextWindow: 128_000,
    thinking: toggle(),
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'qianfan',
    labelKey: 'agent.provider.qianfan',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['ernie-4.5-turbo-128k', 'ernie-x1-turbo-32k', 'ernie-speed-128k'],
    contextWindow: 128_000,
    thinking: toggle(),
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'spark',
    labelKey: 'agent.provider.spark',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['4.0Ultra', 'generalv3.5', 'lite'],
    contextWindow: 32_000,
    thinking: { ...toggle(), field: 'none', echo: 'never' },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'stepfun',
    labelKey: 'agent.provider.stepfun',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['step-2-16k', 'step-1v-8k'],
    contextWindow: 32_000,
    thinking: {
      style: 'effort',
      field: 'reasoning_content',
      echo: 'optional',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'minimax',
    labelKey: 'agent.provider.minimax',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['MiniMax-M2', 'MiniMax-Text-01'],
    contextWindow: 200_000,
    thinking: {
      style: 'effort',
      field: 'reasoning_content',
      echo: 'optional',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'max' },
    },
    compat: { ...openAiCompat, maxTokensField: 'max_completion_tokens' },
    // M3.x 强制思考：传 disabled 回 400 "requires adaptive thinking"。
    modelRules: [{ prefix: 'MiniMax-M3', alwaysThinking: true }],
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'siliconflow',
    labelKey: 'agent.provider.siliconflow',
    group: 'cn',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-235B-A22B', 'THUDM/GLM-4.5'],
    contextWindow: 128_000,
    thinking: {
      style: 'budget',
      field: 'reasoning_content',
      echo: 'never',
      canDisable: true,
      budgets: { low: 1_024, high: 4_096, max: 16_384 },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },

  /* ---------------------------------------------------------------- 国外 */
  {
    id: 'openai',
    labelKey: 'agent.provider.openai',
    group: 'intl',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
    contextWindow: 400_000,
    thinking: {
      style: 'effort',
      field: 'none',
      echo: 'never',
      canDisable: true,
      // OpenAI 没有 max 档；`off` 走「不发 reasoning_effort」（部分模型支持显式 none）。
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    modelRules: [
      { prefix: 'gpt-5', maxTokensField: 'max_completion_tokens', temperature: 'omit' },
      { prefix: 'o1', maxTokensField: 'max_completion_tokens', temperature: 'omit' },
      { prefix: 'o3', maxTokensField: 'max_completion_tokens', temperature: 'omit' },
      { prefix: 'o4', maxTokensField: 'max_completion_tokens', temperature: 'omit' },
    ],
    // 官方端点拒绝带 Origin 的请求（CORS 不开放），只能走代理。
    transport: { browserDirect: false, proxy: true },
  },
  {
    id: 'anthropic',
    labelKey: 'agent.provider.anthropic',
    group: 'intl',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    endpointPath: ANTHROPIC_PATH,
    auth: 'anthropic',
    headers: {
      'anthropic-version': '2023-06-01',
      // 没有这个头，浏览器里发出去的请求会被当成 CORS 请求拒掉。
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    models: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
    contextWindow: 200_000,
    thinking: {
      style: 'anthropic',
      field: 'thinking_blocks',
      // 带 signature 的 thinking / redacted_thinking 块必须原样回传，否则第二轮 400。
      echo: 'required',
      canDisable: true,
      budgets: { low: 2_048, high: 8_192, max: 24_576 },
    },
    compat: { maxTokensField: 'max_tokens', streamUsage: true, temperature: 'send' },
    // Anthropic 的 max_tokens 是必填项。
    defaultMaxTokens: 16_384,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'gemini',
    labelKey: 'agent.provider.gemini',
    group: 'intl',
    protocol: 'openai',
    // 走官方 OpenAI 兼容层：tools / 图片 / 流式 / reasoning_effort 都有。
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    contextWindow: 1_000_000,
    thinking: {
      style: 'effort',
      field: 'none',
      echo: 'never',
      canDisable: true,
      // 官方映射表：minimal / low / medium / high；没有 max 档。
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'openrouter',
    labelKey: 'agent.provider.openrouter',
    group: 'intl',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['openai/gpt-5', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
    contextWindow: 128_000,
    thinking: {
      style: 'openrouter',
      // 新格式是 `reasoning_details[]`（带 signature / encrypted），旧字段 `reasoning` 仍在。
      field: 'reasoning_details',
      echo: 'optional',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },
  {
    id: 'xai',
    labelKey: 'agent.provider.xai',
    group: 'intl',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    contextWindow: 256_000,
    thinking: {
      style: 'effort',
      field: 'reasoning_content',
      echo: 'optional',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    transport: { browserDirect: true, proxy: true },
  },

  /* ---------------------------------------------------------------- 网关 / 云 */
  {
    id: 'azure',
    labelKey: 'agent.provider.azure',
    group: 'intl',
    protocol: 'openai',
    /*
     * Azure OpenAI 是**资源级**端点：baseUrl 里带资源名，部署名在路径里，
     * 版本在查询串里 —— 三样都不是全局统一的，所以 baseUrl 必须由用户填。
     * 模型框里填的是**部署名**（默认与模型名一致）。
     */
    baseUrl: '',
    baseUrlRequired: true,
    endpointPath: '/openai/deployments/{model}/chat/completions',
    query: { 'api-version': '2024-10-21' },
    // Azure 不认 `Authorization: Bearer`，认 `api-key`。
    auth: { header: 'api-key' },
    models: ['gpt-5', 'gpt-4.1', 'o4-mini'],
    contextWindow: 400_000,
    thinking: {
      style: 'effort',
      field: 'none',
      echo: 'never',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: { maxTokensField: 'max_completion_tokens' },
    modelRules: [
      // 老模型仍用 max_tokens；推理模型不收 temperature。
      { prefix: 'gpt-4', maxTokensField: 'max_tokens' },
      { prefix: 'o1', temperature: 'omit' },
      { prefix: 'o3', temperature: 'omit' },
      { prefix: 'o4', temperature: 'omit' },
    ],
    // 资源域名的 CORS 由用户配置，无法预知；不代转（转发目标必须来自注册表）。
    transport: { browserDirect: true, proxy: false },
  },
  {
    id: 'cloudflare',
    labelKey: 'agent.provider.cloudflare',
    group: 'intl',
    /*
     * Cloudflare AI Gateway：一个 baseUrl 下按路径前缀分三条上游通道。
     * baseUrl 填网关根 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`，
     * 前缀决定走哪家：`anthropic/*` → /anthropic/v1/messages，
     * `openai/*` → /openai/v1/chat/completions，`workers-ai/*` → /compat/chat/completions。
     * 这是**唯一**需要 per-model 协议分流的形态，规则全在 `modelRules` 里。
     */
    baseUrl: '',
    baseUrlRequired: true,
    protocol: 'openai',
    endpointPath: '/compat/chat/completions',
    // 网关自身用 `cf-aig-authorization`，上游 key 由控制台托管（统一计费 / BYOK）。
    auth: { header: 'cf-aig-authorization', scheme: 'bearer' },
    // 掐掉默认的 Authorization：网关只认自己的头。
    headers: { Authorization: null },
    models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5', 'workers-ai/@cf/moonshotai/kimi-k2'],
    contextWindow: 200_000,
    // Claude 的 max_tokens 必填且必须大于 thinking 预算（high 档 8192）。
    defaultMaxTokens: 16_384,
    thinking: {
      style: 'effort',
      field: 'reasoning_content',
      echo: 'never',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    modelRules: [
      {
        prefix: 'anthropic/',
        protocol: 'anthropic',
        pathPrefix: '/anthropic/v1',
        endpointPath: '/messages',
        // 走真 Anthropic 协议：thinking 块带 signature，必须原样回传。
        thinking: {
          style: 'anthropic',
          field: 'thinking_blocks',
          echo: 'required',
          canDisable: true,
          budgets: { low: 2_048, high: 8_192, max: 24_576 },
        },
      },
      { prefix: 'openai/', pathPrefix: '/openai/v1', endpointPath: '/chat/completions' },
      { prefix: 'workers-ai/', contextWindow: 131_072, endpointPath: '/compat/chat/completions' },
    ],
    transport: { browserDirect: true, proxy: false },
  },

  /* ---------------------------------------------------------------- 兜底 */
  {
    id: 'custom',
    labelKey: 'agent.provider.custom',
    group: 'custom',
    protocol: 'openai',
    // 用户必须自己填 baseUrl（设置里空值时也能用，请求会明确报「未填端点」）。
    baseUrl: '',
    baseUrlRequired: true,
    endpointPath: OPENAI_PATH,
    auth: 'bearer',
    models: [],
    contextWindow: 128_000,
    thinking: {
      style: 'effort',
      // OpenAI 兼容服务的思维链字段不统一，三者都读。
      field: 'reasoning_content',
      echo: 'optional',
      canDisable: true,
      effortMap: { low: 'low', high: 'high', max: 'high' },
    },
    compat: openAiCompat,
    // 目标不可信：不代转。
    transport: { browserDirect: true, proxy: false },
  },
];

/* ------------------------------------------------------------------ 查询 */

export const DEFAULT_PROVIDER_ID: ProviderId = 'deepseek';

export const PROVIDER_BY_ID: ReadonlyMap<string, ProviderDef> = new Map(
  PROVIDERS.map((p) => [p.id, p]),
);

/**
 * 代理转发白名单：id → 上游 origin。
 *
 * 由注册表**派生**而不是手写第二份 —— 手写的那份一定会在加第 17 家时漏掉，
 * 而漏掉的表现是「这家在 dev 里就是连不上」，且错误信息是 404 而不是人话。
 */
export const PROXY_ROUTES: Readonly<Record<string, string>> = Object.fromEntries(
  PROVIDERS.filter((p) => p.transport.proxy).map((p) => [p.id, p.baseUrl]),
);

/** 未知 id 不该静默回落到 DeepSeek —— 那会让「配置没生效」看起来像「模型答得不对」。 */
export function providerOf(id: string): ProviderDef {
  const def = PROVIDER_BY_ID.get(id);
  if (!def) throw new LlmError('unsupported', `unknown provider: ${id}`);
  return def;
}

/** 按 `prefix` 最长匹配取模型规则；没有匹配返回 `null`。 */
export function modelRule(def: ProviderDef, model: string): ModelRule | null {
  let best: ModelRule | null = null;
  for (const rule of def.modelRules ?? []) {
    if (!model.startsWith(rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best;
}

/** 这个 (provider, model) 组合的有效上下文窗口。 */
export function contextLimitOf(config: Pick<LlmConfig, 'providerId' | 'model'>): number {
  const def = PROVIDER_BY_ID.get(config.providerId);
  if (!def) return 128_000;
  return modelRule(def, config.model)?.contextWindow ?? def.contextWindow;
}

/** 这个组合能不能收图片。 */
export function supportsImages(config: Pick<LlmConfig, 'providerId' | 'model'>): boolean {
  const def = PROVIDER_BY_ID.get(config.providerId);
  if (!def) return false;
  return modelRule(def, config.model)?.noImages !== true;
}
