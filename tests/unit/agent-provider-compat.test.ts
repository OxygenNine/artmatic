/**
 * agent-provider-compat.test.ts — 方言 / 端点 / 头部 / 分流的守卫。
 *
 * 这些用例覆盖的是「注册表数据之外」的那层胶水：自动嗅探、鉴权头形态、
 * 端点模板、网关的按模型分流。它们出错的样子都很安静：
 *
 *   · 端点少了 `?api-version` → Azure 回 404，看起来像资源名写错
 *   · 网关没掐掉 `Authorization` → 上游把网关自己的 key 当成厂商 key
 *   · `reasoning_effort` 发给不接受它的端点 → 400，但只在「开了思考」时
 *   · 网关按模型分流写反 → 一半模型能用，另一半首次就 400
 */

import { describe, expect, it } from 'vitest';
import { buildOpenAiBody, serializeOpenAiMessages } from '../../src/agent/llm/protocol/openai';
import {
  DEFAULT_COMPAT,
  detectCompat,
  endpointIsCustom,
  mergeCompat,
  resolveCompat,
} from '../../src/agent/llm/providers/compat';
import {
  authHeaders,
  endpointFor,
  endpointTail,
  mergeHeaders,
} from '../../src/agent/llm/providers/endpoint';
import { providerOf } from '../../src/agent/llm/providers/registry';
import { thinkingBudgetFor, thinkingParamsFor } from '../../src/agent/llm/providers/reasoning';
import { protocolFor, ruleFor, thinkingPolicyFor } from '../../src/agent/llm/providers/routing';
import { DEFAULT_LLM_CONFIG, type LlmConfig, type WireMessage } from '../../src/agent/llm/types';
import { planTransports } from '../../src/agent/llm/transport';

const config = (patch: Partial<LlmConfig> = {}): LlmConfig => ({
  ...DEFAULT_LLM_CONFIG,
  apiKey: 'sk-test',
  ...patch,
});

/* ------------------------------------------------------------------ 方言 */

describe('compat：默认值 / 嗅探 / 覆盖', () => {
  it('默认是标准 OpenAI 形状', () => {
    expect(DEFAULT_COMPAT).toEqual({
      maxTokensField: 'max_tokens',
      streamUsage: true,
      supportsReasoningEffort: true,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      temperature: 'send',
    });
  });

  it('嗅探只从主机名认已知的方言差异', () => {
    expect(detectCompat('https://api.deepseek.com/v1')).toMatchObject({ maxTokensField: 'max_tokens' });
    expect(detectCompat('https://api.together.xyz/v1')).toMatchObject({
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: false,
    });
    expect(detectCompat('https://api.z.ai/api/coding/paas/v4')).toMatchObject({
      supportsReasoningEffort: false,
    });
    // 认不出的自建网关：一个字都不猜。
    expect(detectCompat('https://llm.corp.example.com/v1')).toEqual({});
  });

  it('官方端点不嗅探，自填端点才嗅探', () => {
    const deepseek = providerOf('deepseek');
    expect(endpointIsCustom(deepseek, 'https://api.deepseek.com')).toBe(false);
    // 把自定义端点指到 Together：方言必须跟着端点走。
    const custom = providerOf('custom');
    expect(resolveCompat(custom, 'm', 'https://api.together.xyz/v1')).toMatchObject({
      supportsReasoningEffort: false,
    });
    // 显式注册表数据优先于嗅探。
    expect(
      resolveCompat(
        { baseUrl: 'https://api.together.xyz/v1', compat: { supportsReasoningEffort: true } },
        'm',
        'https://api.together.xyz/v1',
      ).supportsReasoningEffort,
    ).toBe(true);
  });

  it('mergeCompat 忽略 undefined，后层覆盖前层', () => {
    expect(mergeCompat({ temperature: 'one' }, { temperature: undefined, streamUsage: false })).toMatchObject({
      temperature: 'one',
      streamUsage: false,
    });
  });

  it('不接受 reasoning_effort 的端点只发开关', () => {
    const custom = providerOf('custom');
    expect(
      thinkingParamsFor(custom, 'high', 'm', 'https://api.together.xyz/v1'),
    ).toEqual({});
    // 同一家换成认这个参数的主机就该发。
    expect(thinkingParamsFor(custom, 'high', 'm', 'https://llm.corp.example.com/v1')).toEqual({
      reasoning_effort: 'high',
    });
  });
});

/* ---------------------------------------------------------------- 端点 */

describe('端点：模板 / 查询串 / 网关分流', () => {
  it('Azure：部署名在路径里，版本在查询串里，鉴权头是 api-key', () => {
    const azure = providerOf('azure');
    const tail = endpointTail(azure, 'my-deployment');
    expect(tail).toBe('/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21');
    expect(endpointFor('https://res.openai.azure.com/', azure, 'my-deployment')).toBe(
      `https://res.openai.azure.com${tail}`,
    );
    expect(authHeaders(azure.auth, 'k')).toEqual({ 'api-key': 'k' });
  });

  it('网关：按模型前缀切协议与子路径', () => {
    const cf = providerOf('cloudflare');
    expect(protocolFor(cf, 'anthropic/claude-sonnet-4-5')).toBe('anthropic');
    expect(endpointTail(cf, 'anthropic/claude-sonnet-4-5')).toBe('/anthropic/v1/messages');
    expect(endpointTail(cf, 'openai/gpt-5')).toBe('/openai/v1/chat/completions');
    expect(endpointTail(cf, 'workers-ai/@cf/moonshotai/kimi-k2')).toBe('/compat/chat/completions');
    // 未知前缀落回提供商默认协议，而不是静默变成 Anthropic。
    expect(protocolFor(cf, 'mystery-model')).toBe('openai');
  });

  it('模型规则可以覆盖整条端点（含 {model}）', () => {
    const def = {
      ...providerOf('custom'),
      endpointPath: '/v1/{model}:stream',
    };
    expect(endpointTail(def, 'gemini-2.5-pro')).toBe('/v1/gemini-2.5-pro:stream');
  });
});

/* ---------------------------------------------------------------- 头部 */

describe('头部叠加与鉴权形态', () => {
  it('三种鉴权形态', () => {
    expect(authHeaders('bearer', 'k')).toEqual({ Authorization: 'Bearer k' });
    expect(authHeaders('anthropic', 'k')).toEqual({ 'x-api-key': 'k' });
    expect(authHeaders({ header: 'api-key' }, 'k')).toEqual({ 'api-key': 'k' });
    expect(authHeaders({ header: 'cf-aig-authorization', scheme: 'bearer' }, 'k')).toEqual({
      'cf-aig-authorization': 'Bearer k',
    });
  });

  it('null 删掉同名默认头（网关不能把平台 key 当厂商 key 发出去）', () => {
    const cf = providerOf('cloudflare');
    const headers = mergeHeaders(
      { 'Content-Type': 'application/json' },
      authHeaders(cf.auth, 'cf-key'),
      cf.headers,
    );
    expect(headers['cf-aig-authorization']).toBe('Bearer cf-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('大小写不敏感，保留最后写入者的键名', () => {
    expect(mergeHeaders({ 'X-Api-Key': 'a' }, { 'x-api-key': 'b' })).toEqual({ 'x-api-key': 'b' });
  });

  it('模型级头部可以覆盖提供商头部', () => {
    const def = {
      ...providerOf('custom'),
      headers: { 'x-tenant': 'stock', 'x-drop': 'yes' },
      modelRules: [{ prefix: 'pro', headers: { 'X-Tenant': 'pro', 'x-drop': null } }],
    };
    const rule = ruleFor(def, 'pro-1');
    expect(mergeHeaders(def.headers, rule?.headers)).toEqual({ 'X-Tenant': 'pro' });
  });
});

/* ------------------------------------------------------------ 请求体方言 */

describe('请求体方言落到字节上', () => {
  const toolMessages = (): WireMessage[] => [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_scene', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'user', content: '继续' },
  ];

  it('requiresToolResultName：tool 消息补回函数名', () => {
    const def = supplier({ requiresToolResultName: true });
    const out = serializeOpenAiMessages(toolMessages(), def, 'm', def.compat);
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}', name: 'get_scene' });
  });

  it('requiresAssistantAfterToolResult：tool 与 user 之间插一条空 assistant', () => {
    const def = supplier({ requiresAssistantAfterToolResult: true });
    const out = serializeOpenAiMessages(toolMessages(), def, 'm', def.compat);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'user']);
  });

  it('默认不发这两个键（DeepSeek / OpenAI 的字节基线不能动）', () => {
    const def = supplier({});
    const out = serializeOpenAiMessages(toolMessages(), def, 'm', def.compat);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(out[1]).not.toHaveProperty('name');
  });

  it('provider.body → ModelRule.body → extraBody，后者覆盖前者', () => {
    const def = {
      ...supplier({}),
      body: { top_k: 1, gateway: 'provider' },
      modelRules: [{ prefix: 'pro', body: { top_k: 2 } }],
    };
    const body = buildOpenAiBody({
      config: config({ providerId: def.id, baseUrl: 'https://llm.example.com/v1', model: 'pro-1', extraBody: { top_p: 0.5 } }),
      provider: def,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body).toMatchObject({ top_k: 2, gateway: 'provider', top_p: 0.5 });
  });
});

/** 造一个带指定 compat 的 OpenAI 兼容提供商（用 custom 做底）。 */
function supplier(compat: Record<string, unknown>) {
  return {
    ...providerOf('custom'),
    baseUrl: 'https://llm.example.com/v1',
    baseUrlRequired: false,
    compat,
  } as ReturnType<typeof providerOf>;
}

/* ---------------------------------------------------------------- 分流 */

describe('传输计划跟着模型走', () => {
  it('Azure 直连 URL 带部署名与版本；不代转', () => {
    const azure = providerOf('azure');
    const plans = planTransports(
      config({ providerId: 'azure', baseUrl: 'https://res.openai.azure.com', model: 'gpt-5-deploy' }),
      azure,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.url).toBe(
      'https://res.openai.azure.com/openai/deployments/gpt-5-deploy/chat/completions?api-version=2024-10-21',
    );
  });

  it('网关：Claude 模型直连 /messages，GPT 模型直连 /chat/completions', () => {
    const cf = providerOf('cloudflare');
    const base = 'https://gateway.ai.cloudflare.com/v1/acc/gw';
    expect(planTransports(config({ providerId: 'cloudflare', baseUrl: base, model: 'anthropic/claude-sonnet-4-5' }), cf)[0]!.url).toBe(
      `${base}/anthropic/v1/messages`,
    );
    expect(planTransports(config({ providerId: 'cloudflare', baseUrl: base, model: 'openai/gpt-5' }), cf)[0]!.url).toBe(
      `${base}/openai/v1/chat/completions`,
    );
  });
});

/* ------------------------------------------------------------ 思考预算 */

describe('思考策略按模型解析', () => {
  it('网关下 Claude 走符号化 thinking 块，GPT 走 reasoning_content', () => {
    const cf = providerOf('cloudflare');
    expect(thinkingPolicyFor(cf, 'anthropic/claude-sonnet-4-5')).toMatchObject({
      style: 'anthropic',
      echo: 'required',
    });
    expect(thinkingPolicyFor(cf, 'openai/gpt-5')).toMatchObject({ style: 'effort', echo: 'never' });
    expect(thinkingBudgetFor(cf, 'high', 'anthropic/claude-sonnet-4-5')).toBe(8_192);
    expect(thinkingBudgetFor(cf, 'high', 'openai/gpt-5')).toBe(0);
  });
});
