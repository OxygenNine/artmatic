/**
 * agent-providers.test.ts — 注册表守卫 + 思考参数矩阵 + 错误归一 + 配置迁移。
 *
 * 这个文件的用例全部是「不报错但行为不对」的形态的守卫：
 *   · 注册表里少写一个字段 → 某家的请求带了个它不认识的键 → 首轮能用、第二轮 400
 *   · `alwaysThinking` 的模型收到 `disabled` → 400，用户不知道为什么
 *   · baseUrl 反查错 → 401，用户以为是 key 过期
 * 所以断言要钉**机制**（字段是否自洽、是否派生出正确路由），不钉字面量。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProxyPath, pickForwardHeaders, proxyTargetUrl } from '../../scripts/llm-proxy.mjs';
import {
  PROVIDERS,
  PROVIDER_BY_ID,
  PROXY_ROUTES,
  contextLimitOf,
  modelRule,
  providerOf,
  supportsImages,
} from '../../src/agent/llm/providers/registry';
import { canDisableThinking, maxTokensFieldFor, outputTokensFor, temperatureFor, thinkingParamsFor } from '../../src/agent/llm/providers/reasoning';
import { classifyHttpError, parseErrorEnvelope } from '../../src/agent/llm/providers/errors';
import { adapterFor } from '../../src/agent/llm/protocol';
import { DEFAULT_LLM_CONFIG } from '../../src/agent/llm/types';
import { LOCALES } from '../../src/i18n/locales';
import {
  activeApiKey,
  activeBaseUrl,
  activeModel,
  inferProviderId,
  migratePrefs,
  prefsForStorage,
  resolveLlmConfig,
} from '../../src/ui/agent/agent-prefs';
import { PROVIDER_LOGOS } from '../../src/ui/agent/provider-logos';

/* ------------------------------------------------------------ 注册表 */

describe('提供商注册表', () => {
  it('id 唯一且能当 URL 段 / localStorage 键', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(ids.length).toBeGreaterThanOrEqual(16);
  });

  it('协议合法且都有适配器', () => {
    for (const def of PROVIDERS) {
      expect(['openai', 'anthropic']).toContain(def.protocol);
      expect(() => adapterFor(def.protocol)).not.toThrow();
    }
  });

  it('端点自洽：https、无尾斜杠、能拼出同一个 origin', () => {
    for (const def of PROVIDERS) {
      if (!def.baseUrl) {
        expect(def.id).toBe('custom');
        continue;
      }
      expect(def.baseUrl.startsWith('https://')).toBe(true);
      expect(def.baseUrl.endsWith('/')).toBe(false);
      expect(def.baseUrl).not.toMatch(/[?#]/);
      expect(def.endpointPath.startsWith('/')).toBe(true);
      const url = new URL(`${def.baseUrl}${def.endpointPath}`);
      expect(url.origin).toBe(new URL(def.baseUrl).origin);
      expect(url.pathname).not.toMatch(/\/\//);
    }
  });

  it('Anthropic 走 /messages，别的走 /chat/completions', () => {
    for (const def of PROVIDERS) {
      expect(def.endpointPath).toBe(def.protocol === 'anthropic' ? '/messages' : '/chat/completions');
    }
  });

  it('预设模型非空、无重复（custom 除外），且默认模型在列表里', () => {
    for (const def of PROVIDERS) {
      if (def.id === 'custom') {
        expect(def.models).toEqual([]);
        continue;
      }
      expect(def.models.length, def.id).toBeGreaterThan(0);
      expect(new Set(def.models).size, def.id).toBe(def.models.length);
    }
  });

  it('上下文窗口是像样的正整数', () => {
    for (const def of PROVIDERS) {
      expect(Number.isInteger(def.contextWindow)).toBe(true);
      expect(def.contextWindow).toBeGreaterThanOrEqual(8_192);
    }
  });

  it('思考策略自洽：读不到思维链就不可能要求回传', () => {
    for (const def of PROVIDERS) {
      if (def.thinking.field === 'none') expect(def.thinking.echo, def.id).toBe('never');
      if (def.thinking.echo === 'required') expect(def.thinking.field, def.id).not.toBe('none');
      if (def.thinking.style === 'anthropic') expect(def.protocol).toBe('anthropic');
      if (def.protocol === 'anthropic') expect(def.thinking.style).toBe('anthropic');
    }
  });

  it('每个 labelKey 在中文表里真的存在', () => {
    const table = LOCALES['zh-CN'] as Record<string, string>;
    for (const def of PROVIDERS) {
      expect(table[def.labelKey], `${def.id} 缺文案 ${def.labelKey}`).toBeTruthy();
      expect(def.labelKey.startsWith('agent.provider.')).toBe(true);
    }
  });

  it('每个提供商都有品牌图（只有「自定义」没有品牌可画）', () => {
    const allowedMissing = new Set(['custom']);
    for (const def of PROVIDERS) {
      if (allowedMissing.has(def.id)) continue;
      expect(PROVIDER_LOGOS[def.id], `${def.id} 缺 logo`).toBeTruthy();
    }
    const ids = new Set<string>(PROVIDERS.map((p) => p.id));
    for (const id of Object.keys(PROVIDER_LOGOS)) {
      expect(ids.has(id), `孤儿 logo：${id}`).toBe(true);
    }
  });

  it('未知 id 直接抛，不静默回落到某一家', () => {
    expect(() => providerOf('nope')).toThrow(/unknown provider/);
  });
});

/* ------------------------------------------------------------- 代理路由 */

describe('代理路由（由注册表派生）', () => {
  it('键集合恰好等于允许代理的那些', () => {
    const expected = PROVIDERS.filter((p) => p.transport.proxy).map((p) => p.id).sort();
    expect(Object.keys(PROXY_ROUTES).sort()).toEqual(expected);
  });

  it('转发目标就是注册表里的 baseUrl', () => {
    for (const [id, base] of Object.entries(PROXY_ROUTES)) {
      expect(base).toBe(PROVIDER_BY_ID.get(id)!.baseUrl);
    }
  });

  it('自定义服务商不进代理（目标不可信）', () => {
    expect(PROXY_ROUTES.custom).toBeUndefined();
  });

  it('parseProxyPath 认合法路径、挡穿越与未知形状', () => {
    expect(parseProxyPath('/__llm/deepseek/chat/completions')).toEqual({
      providerId: 'deepseek',
      tail: '/chat/completions',
    });
    expect(parseProxyPath('/__llm/anthropic/messages?x=1')).toEqual({
      providerId: 'anthropic',
      tail: '/messages',
    });
    expect(parseProxyPath('/__llm/deepseek')).toBeNull();
    expect(parseProxyPath('/__llm/deepseek/')).toBeNull();
    expect(parseProxyPath('/other/deepseek/chat/completions')).toBeNull();
    // 穿越：tail 里带 `..`，由 handler 的 origin 校验兜住；这里只验解析结果
    expect(parseProxyPath('/__llm/deepseek/../openai/chat/completions')).toEqual({
      providerId: 'deepseek',
      tail: '/../openai/chat/completions',
    });
  });

  it('转发头只走白名单（cookie / origin 一律不带）', () => {
    const picked = pickForwardHeaders({
      authorization: 'Bearer sk-x',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
      cookie: 'session=1',
      origin: 'http://localhost:5173',
      'x-random': 'nope',
    });
    expect(picked).toEqual({
      authorization: 'Bearer sk-x',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
  });

  /**
   * npm 版（`server/serve.mjs`）读的是生成的 `server/llm-routes.json`：裸 Node 进不去
   * TS 注册表。这份转录**必须**与注册表一致 —— 不一致的形态是「新加的那家在 npm 版里
   * 连不上，回 404 provider is not proxied」，而 dev 里一切正常。
   */
  it('发布用的 server/llm-routes.json 与注册表同步（改了 registry 就重跑 pnpm run gen:llm-routes）', () => {
    const file = fileURLToPath(new URL('../../server/llm-routes.json', import.meta.url));
    const shipped = JSON.parse(readFileSync(file, 'utf8')) as { routes: Record<string, string> };
    expect(shipped.routes).toEqual({ ...PROXY_ROUTES });
  });

  /**
   * 上游 URL 必须**保留 baseUrl 自带的路径**。
   *
   * 用 `new URL(tail, base)` 写会踩一个很难发现的坑：`tail` 以 `/` 开头是根相对引用，
   * 于是 `…/compatible-mode/v1` + `/chat/completions` 变成根下的 `/chat/completions`，
   * 16 家里 15 家 404 —— 而 deepseek（baseUrl 无路径）碰巧是对的，所以手测第一家
   * 永远测不出来。
   */
  it('代理目标保留 baseUrl 的路径', () => {
    expect(proxyTargetUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', '/chat/completions').href).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(proxyTargetUrl('https://api.openai.com/v1', '/chat/completions').href).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    // 末尾有斜杠 / 没有斜杠都只该拼一次
    expect(proxyTargetUrl('https://api.deepseek.com', '/chat/completions').href).toBe(
      'https://api.deepseek.com/chat/completions',
    );
    expect(proxyTargetUrl('https://api.deepseek.com/', '/chat/completions').href).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('每一家都能拼出自己 baseUrl 下的端点', () => {
    for (const [id, base] of Object.entries(PROXY_ROUTES)) {
      const def = PROVIDER_BY_ID.get(id)!;
      const url = proxyTargetUrl(base, def.endpointPath);
      expect(url.origin).toBe(new URL(base).origin);
      expect(url.pathname, id).toBe(`${new URL(base).pathname.replace(/\/+$/, '')}${def.endpointPath}`);
    }
  });
});

/* ------------------------------------------------------------ 思考矩阵 */

describe('思考参数矩阵', () => {
  it('deepseek：off 只有 disabled，其余三档带 reasoning_effort', () => {
    const d = providerOf('deepseek');
    expect(thinkingParamsFor(d, 'off', 'deepseek-flash')).toEqual({ thinking: { type: 'disabled' } });
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(thinkingParamsFor(d, effort, 'deepseek-flash')).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
      });
    }
  });

  it('toggle（智谱）：只有开关，没有强度', () => {
    const z = providerOf('zhipu');
    expect(thinkingParamsFor(z, 'off', 'glm-4.6')).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingParamsFor(z, 'high', 'glm-4.6')).toEqual({ thinking: { type: 'enabled' } });
  });

  it('budget（通义千问）：enable_thinking + thinking_budget', () => {
    const q = providerOf('dashscope');
    expect(thinkingParamsFor(q, 'off', 'qwen-plus')).toEqual({ enable_thinking: false });
    const on = thinkingParamsFor(q, 'high', 'qwen-plus');
    expect(on.enable_thinking).toBe(true);
    expect(typeof on.thinking_budget).toBe('number');
    // 档位越高预算越大（否则「最高」和「低」没区别）
    const low = thinkingParamsFor(q, 'low', 'qwen-plus').thinking_budget as number;
    const max = thinkingParamsFor(q, 'max', 'qwen-plus').thinking_budget as number;
    expect(max).toBeGreaterThan(low);
  });

  it('effort（OpenAI）：off 什么都不发，档位按注册表映射', () => {
    const o = providerOf('openai');
    expect(thinkingParamsFor(o, 'off', 'gpt-5')).toEqual({});
    expect(thinkingParamsFor(o, 'low', 'gpt-5')).toEqual({ reasoning_effort: 'low' });
    // OpenAI 没有 max 档，必须落到 high 而不是把 'max' 直接发过去
    expect(thinkingParamsFor(o, 'max', 'gpt-5')).toEqual({ reasoning_effort: 'high' });
  });

  it('openrouter 用 reasoning.effort', () => {
    const r = providerOf('openrouter');
    expect(thinkingParamsFor(r, 'low', 'openai/gpt-5')).toEqual({ reasoning: { effort: 'low' } });
  });

  it('anthropic 用 thinking.budget_tokens', () => {
    const a = providerOf('anthropic');
    expect(thinkingParamsFor(a, 'off', 'claude-sonnet-4-5')).toEqual({});
    const on = thinkingParamsFor(a, 'high', 'claude-sonnet-4-5');
    expect(on).toMatchObject({ thinking: { type: 'enabled' } });
    expect(typeof (on.thinking as { budget_tokens: number }).budget_tokens).toBe('number');
  });

  it('关不掉思考的模型：off 档绝不出现 disabled', () => {
    // 这条是 GLM 5.3 / MiniMax M3 的 400 源头。
    for (const [id, model] of [
      ['zhipu', 'glm-5.3'],
      ['minimax', 'MiniMax-M3.1'],
    ] as const) {
      const def = providerOf(id);
      expect(canDisableThinking(def, model), `${id}/${model}`).toBe(false);
      expect(JSON.stringify(thinkingParamsFor(def, 'off', model))).not.toContain('disabled');
    }
  });

  it('canDisableThinking 对能关的模型为 true', () => {
    for (const [id, model] of [
      ['deepseek', 'deepseek-flash'],
      ['zhipu', 'glm-4.6'],
      ['anthropic', 'claude-sonnet-4-5'],
    ] as const) {
      expect(canDisableThinking(providerOf(id), model)).toBe(true);
    }
  });
});

/* ------------------------------------------------------- 温度 / 输出上限 */

describe(' temperature / max_tokens 的 per-model 规则', () => {
  it('OpenAI 推理模型不发 temperature、用 max_completion_tokens', () => {
    const o = providerOf('openai');
    expect(temperatureFor(o, 'high', 'gpt-5', 0.3)).toBeUndefined();
    expect(temperatureFor(o, 'high', 'gpt-4.1', 0.3)).toBe(0.3);
    expect(maxTokensFieldFor(o, 'o3-mini')).toBe('max_completion_tokens');
    expect(maxTokensFieldFor(o, 'gpt-4.1')).toBe('max_tokens');
  });

  it('Anthropic 开思考时不发 temperature', () => {
    const a = providerOf('anthropic');
    expect(temperatureFor(a, 'high', 'claude-sonnet-4-5', 0.3)).toBeUndefined();
    expect(temperatureFor(a, 'off', 'claude-sonnet-4-5', 0.3)).toBe(0.3);
  });

  it('Anthropic 的 max_tokens 永远有值；其余不设就不发', () => {
    const a = providerOf('anthropic');
    const config = { ...DEFAULT_LLM_CONFIG, providerId: 'anthropic', effort: 'max' as const };
    const out = outputTokensFor(a, config);
    expect(typeof out).toBe('number');
    expect(out!).toBeGreaterThan(0);
    expect(outputTokensFor(providerOf('deepseek'), DEFAULT_LLM_CONFIG)).toBeUndefined();
  });
});

/* ------------------------------------------------------------ 上下文窗口 */

describe('上下文窗口与能力查询', () => {
  it('按 provider 取，模型规则可以覆盖', () => {
    expect(contextLimitOf({ providerId: 'deepseek', model: 'deepseek-flash' })).toBe(1_000_000);
    expect(contextLimitOf({ providerId: 'spark', model: 'lite' })).toBe(32_000);
    // 未知 provider 回落到保守值而不是抛（UI 在迁移中途会读到）
    expect(contextLimitOf({ providerId: 'nope', model: 'x' })).toBe(128_000);
  });

  it('noImages 的模型被识别出来', () => {
    expect(supportsImages({ providerId: 'deepseek', model: 'deepseek-flash' })).toBe(true);
    expect(supportsImages({ providerId: 'nope', model: 'x' })).toBe(false);
  });

  it('modelRule 取最长前缀', () => {
    const def = {
      ...providerOf('openai'),
      modelRules: [
        { prefix: 'gpt-5', temperature: 'omit' as const },
        { prefix: 'gpt-5-mini', temperature: 'one' as const },
      ],
    };
    expect(modelRule(def, 'gpt-5-mini-2024')?.temperature).toBe('one');
    expect(modelRule(def, 'gpt-5-turbo')?.temperature).toBe('omit');
    expect(modelRule(def, 'gpt-4o')).toBeNull();
  });
});

/* ------------------------------------------------------------ 错误归一 */

describe('错误归一', () => {
  it('认得四种错误体', () => {
    expect(parseErrorEnvelope('{"error":{"message":"bad","code":"x"}}')).toEqual({ code: 'x', message: 'bad' });
    expect(parseErrorEnvelope('{"code":"401","msg":"no key"}')).toEqual({ code: '401', message: 'no key' });
    expect(parseErrorEnvelope('{"error_code":17,"error_msg":"限流"}')).toEqual({ code: '17', message: '限流' });
    expect(parseErrorEnvelope('{"base_resp":{"status_code":1004,"status_msg":"bad"}}')).toEqual({
      code: '1004',
      message: 'bad',
    });
    expect(parseErrorEnvelope('plain text').message).toBe('plain text');
    expect(parseErrorEnvelope('')).toEqual({ code: '', message: '' });
  });

  it('402 与 429+insufficient_quota 都归到 balance', () => {
    expect(classifyHttpError(402, '{"error":{"message":"Insufficient Balance"}}').code).toBe('balance');
    expect(
      classifyHttpError(429, '{"error":{"code":"insufficient_quota","message":"quota"}}').code,
    ).toBe('balance');
    // 真的限流仍然是 rate-limit
    expect(classifyHttpError(429, '{"error":{"message":"rate limit reached"}}').code).toBe('rate-limit');
  });

  it('上下文超限单独归到 context（不能走 400 的清空历史）', () => {
    expect(
      classifyHttpError(400, '{"error":{"code":"context_length_exceeded","message":"too long"}}').code,
    ).toBe('context');
    expect(classifyHttpError(400, '{"error":{"message":"bad tool schema"}}').code).toBe('bad-response');
  });

  it('401 / 403 归 auth，5xx 归 server', () => {
    expect(classifyHttpError(401, '').code).toBe('auth');
    expect(classifyHttpError(403, '').code).toBe('auth');
    expect(classifyHttpError(503, '').code).toBe('server');
  });
});

/* ------------------------------------------------------------ 配置迁移 */

describe('配置迁移', () => {
  it('rev3 的扁平配置：按 baseUrl 反查，key 不丢', () => {
    const prefs = migratePrefs({
      prefsRev: 3,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-old',
      effort: 'high',
      temperature: 0.4,
      maxSteps: 40,
      screenshots: false,
      sessionOnly: false,
      thinking: true,
    });
    expect(prefs.providerId).toBe('deepseek');
    expect(prefs.overrides.deepseek).toEqual({ model: 'deepseek-chat', apiKey: 'sk-old' });
    expect(prefs.temperature).toBe(0.4);
    expect(prefs.screenshots).toBe(false);
    // 旧默认步数被抬到 200（新结构缺席时只抬一次）
    expect(prefs.maxSteps).toBe(200);
  });

  it('反查不出的一律落到 custom，且保留原 baseUrl 与 key', () => {
    const prefs = migratePrefs({
      prefsRev: 3,
      baseUrl: 'https://my-gateway.example.com/v1',
      model: 'my-model',
      apiKey: 'sk-mine',
    });
    expect(prefs.providerId).toBe('custom');
    expect(prefs.overrides.custom).toEqual({
      baseUrl: 'https://my-gateway.example.com/v1',
      model: 'my-model',
      apiKey: 'sk-mine',
    });
  });

  it('inferProviderId：多带一段路径也能认出来，未知 host 不猜', () => {
    expect(inferProviderId('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(inferProviderId('https://dashscope.aliyuncs.com/compatible-mode/v1/')).toBe('dashscope');
    expect(inferProviderId('https://example.com/v1')).toBe('custom');
    expect(inferProviderId('')).toBe('deepseek');
  });

  it('rev4 结构原样读回，每家的 key 各自独立', () => {
    const prefs = migratePrefs({
      prefsRev: 4,
      providerId: 'anthropic',
      overrides: {
        deepseek: { apiKey: 'sk-ds', model: 'deepseek-chat' },
        anthropic: { apiKey: 'sk-ant' },
        bogus: { apiKey: 'nope' },
      },
      temperature: 0.3,
      effort: 'low',
      maxSteps: 200,
    });
    expect(prefs.providerId).toBe('anthropic');
    expect(prefs.overrides.deepseek?.apiKey).toBe('sk-ds');
    expect(prefs.overrides.bogus).toBeUndefined();
    expect(resolveLlmConfig(prefs).apiKey).toBe('sk-ant');
  });

  it('坏数据不抛', () => {
    expect(() => migratePrefs(null)).not.toThrow();
    expect(() => migratePrefs('垃圾')).not.toThrow();
    expect(() => migratePrefs({ overrides: 5 })).not.toThrow();
  });

  it('sessionOnly 落盘时剥掉所有 key（内存不受影响）', () => {
    const prefs = migratePrefs({
      prefsRev: 4,
      providerId: 'deepseek',
      overrides: { deepseek: { apiKey: 'sk-a' }, openai: { apiKey: 'sk-b', model: 'gpt-5' } },
      sessionOnly: true,
    });
    const stored = prefsForStorage(prefs);
    expect(stored.overrides.deepseek).toBeUndefined();
    expect(stored.overrides.openai).toEqual({ model: 'gpt-5' });
    // 原对象仍带着 key
    expect(activeApiKey(prefs)).toBe('sk-a');
  });
});

describe('prefs → LlmConfig', () => {
  it('覆盖项优先，缺省跟随注册表', () => {
    const prefs = migratePrefs({
      prefsRev: 4,
      providerId: 'openai',
      overrides: { openai: { apiKey: 'sk-o', model: 'gpt-5-mini' } },
    });
    expect(activeModel(prefs)).toBe('gpt-5-mini');
    expect(activeBaseUrl(prefs)).toBe('https://api.openai.com/v1');
    const config = resolveLlmConfig(prefs);
    expect(config).toMatchObject({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-o',
      model: 'gpt-5-mini',
      proxyPath: '/__llm',
    });
  });

  it('自定义服务商没有预设模型时回落到空串而不是别家的模型名', () => {
    const prefs = migratePrefs({ prefsRev: 4, providerId: 'custom', overrides: {} });
    expect(activeModel(prefs)).toBe('');
    expect(activeBaseUrl(prefs)).toBe('');
  });
});
