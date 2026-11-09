/**
 * transport.ts — 传输层：fetch、超时、SSE 取帧、**直连 → 同源代理**的降级。
 *
 * 这个文件**不知道任何协议**。请求体、鉴权头、错误归一、流式增量归约全部由
 * `protocol/` 的适配器提供 —— 早先它们全揉在这里，加第二家时只能靠
 * `if (provider === ...)`，而漏改一处不会报错，只会在「某家第二轮」才 400。
 *
 * ## 为什么仍然先直连
 *
 * 浏览器能否直连各家 API，说法与实测往往不一致（DeepSeek 被拦、Gemini 与
 * OpenRouter 开放、OpenAI 明确拒绝带 `Origin` 的请求）。策略是**先直连，
 * 在收到第一个字节之前**失败才换 `<proxyPath>/<providerId>/<端点>` 转发。
 * 已经吐过字之后再失败**不重试** —— 那会把半截回答重放一遍。
 *
 * `preferProxy` 按 provider 记忆：在 A 家撞过墙不该让 B 家也直接走代理。
 */

import type { ToolSpec } from '../tools';
import { adapterFor } from './protocol';
import type { StreamHandlers } from './protocol/types';
import { endpointTail } from './providers/endpoint';
import { PROVIDER_BY_ID, providerOf } from './providers/registry';
import { protocolFor, ruleFor } from './providers/routing';
import type { ProviderDef } from './providers/types';
import { LlmError, type ChatResult, type LlmConfig, type WireMessage } from './types';

/** 单次请求的超时（毫秒）。开思考的长回答 + 长工具循环需要留足。 */
export const LLM_TIMEOUT_MS = 300_000;

/* ------------------------------------------------------------------ SSE */

export interface SseParseState {
  buffer: string;
}

/** 新建一个 SSE 解析器（纯函数式：把分片喂进去，取出完整 data 帧）。 */
export function createSseParser(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  const events: string[] = [];

  const drain = (): void => {
    for (;;) {
      // 事件之间用空行分隔；兼容 \r\n。
      const m = /\r?\n\r?\n/.exec(buffer);
      if (!m) break;
      const raw = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      // 一个事件里可以有多行 `data:`，按规范用 \n 拼接。
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue; // 注释 / keep-alive
        if (!line.startsWith('data:')) continue;
        data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push(data.join('\n'));
    }
  };

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      drain();
      const out = events.splice(0, events.length);
      return out;
    },
    flush(): string[] {
      // 收尾：没有空行结尾的最后一条也要吐出来（部分实现会这样）。
      const rest = buffer.trim();
      buffer = '';
      if (!rest) return events.splice(0, events.length);
      const data: string[] = [];
      for (const line of rest.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      const out = events.splice(0, events.length);
      if (data.length) out.push(data.join('\n'));
      return out;
    },
  };
}

/* -------------------------------------------------------------- 传输计划 */

export interface TransportPlan {
  kind: 'direct' | 'proxy';
  url: string;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * 候选传输路径，按优先顺序。
 *
 * `proxy` 只在**用户的 baseUrl 就是注册表里那个端点**时才给：代理的转发目标
 * 来自注册表，baseUrl 被改到别处还硬走代理，会静默打到默认 host —— 用户会看到
 * 「我明明改了地址，怎么还是那家的回答」。
 */
export function planTransports(config: LlmConfig, def: ProviderDef): TransportPlan[] {
  // 网关按模型切协议：`anthropic/*` 与 `gpt-*` 可能不是同一条端点。
  const adapter = adapterFor(protocolFor(def, config.model));
  const baseUrl = trimSlash(config.baseUrl);
  if (!baseUrl) return [];

  const stock = def.baseUrl !== '' && baseUrl === trimSlash(def.baseUrl);
  const plans: TransportPlan[] = [];

  // 官方明确拒绝浏览器直连（OpenAI）时，只有用户自己换了端点才敢试直连。
  if (def.transport.browserDirect || !stock) {
    plans.push({ kind: 'direct', url: adapter.endpoint(baseUrl, def, config.model) });
  }
  if (def.transport.proxy && config.proxyPath && stock) {
    const tail = endpointTail(def, config.model, ruleFor(def, config.model));
    plans.push({ kind: 'proxy', url: `${trimSlash(config.proxyPath)}/${def.id}${tail}` });
  }
  return plans;
}

/* --------------------------------------------------------------- 单次请求 */

function isRetryable(e: unknown): boolean {
  return e instanceof LlmError && (e.code === 'network' || e.code === 'server');
}

function looksLikeStream(res: Response): boolean {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  // 服务端没给 content-type 时放行（少数代理会这样）。
  if (!ct) return true;
  return ct.includes('event-stream') || ct.includes('ndjson');
}

async function once(
  plan: TransportPlan,
  def: ProviderDef,
  config: LlmConfig,
  messages: readonly WireMessage[],
  tools: readonly ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
  handlers: StreamHandlers,
): Promise<ChatResult> {
  const adapter = adapterFor(protocolFor(def, config.model));

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, LLM_TIMEOUT_MS);
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(plan.url, {
        method: 'POST',
        headers: adapter.headers(config, def, config.model),
        body: JSON.stringify(adapter.buildBody({ config, provider: def, messages, tools })),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timedOut) throw new LlmError('timeout', `timeout after ${LLM_TIMEOUT_MS} ms`);
      if (signal?.aborted) throw new LlmError('cancelled', 'aborted');
      // 浏览器把 CORS / DNS / 断网都报成 TypeError（没有可读的 status）。
      throw new LlmError('network', e instanceof Error ? e.message : String(e), undefined, plan.url);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 800);
      } catch {
        /* 读不出错误体也不影响归一 */
      }
      throw adapter.classify(res.status, detail);
    }
    if (!res.body) throw new LlmError('bad-response', 'response has no body');

    /*
     * **静态站点把 `/__llm/*` 回落成 200 + index.html** 时，没有任何一处会报错：
     * reducer 收到一堆 `<` 开头的帧全部跳过，用户看到的是一条空回答。
     * 这条守卫把「看起来成功了其实什么都没收到」变成一个明确的错误。
     */
    if (!looksLikeStream(res)) {
      const snippet = await res.text().catch(() => '');
      throw new LlmError(
        'bad-response',
        `expected text/event-stream, got ${res.headers.get('content-type') ?? 'unknown'}`,
        res.status,
        snippet.slice(0, 400),
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const reducer = adapter.createReducer(def, handlers, config.model);

    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      for (const event of parser.push(text)) {
        if (reducer.push(event)) {
          done = true;
          break;
        }
      }
    }
    if (!done) {
      for (const event of parser.flush()) {
        if (reducer.push(event)) break;
      }
    }

    return reducer.finish();
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (timedOut) throw new LlmError('timeout', `timeout after ${LLM_TIMEOUT_MS} ms`);
    if (signal?.aborted) throw new LlmError('cancelled', 'aborted');
    throw new LlmError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ------------------------------------------------------------------ 入口 */

/** 哪些 provider 已经验证过「直连走不通」，下次直接走代理。按 id 记忆。 */
const preferProxy = new Set<string>();

/** 测试用：重置传输层记忆（不传 id = 全清）。 */
export function resetTransportPreference(providerId?: string): void {
  if (providerId) preferProxy.delete(providerId);
  else preferProxy.clear();
}

export async function streamChat(
  config: LlmConfig,
  messages: readonly WireMessage[],
  tools: readonly ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
  handlers: StreamHandlers = {},
): Promise<ChatResult> {
  if (!config.apiKey.trim()) throw new LlmError('no-key', 'missing api key');

  // 未知 provider 立刻炸：静默回落到某一家的后果是「配置没生效」看起来像「模型答得不对」。
  const def = providerOf(config.providerId);
  const plans = planTransports(config, def);
  if (!plans.length) {
    throw new LlmError('transport', `provider ${def.id} has no reachable endpoint (needs a base URL or a local /__llm proxy)`);
  }

  const ordered = preferProxy.has(def.id)
    ? [...plans.filter((p) => p.kind === 'proxy'), ...plans.filter((p) => p.kind === 'direct')]
    : plans;

  let emitted = false;
  const tracked: StreamHandlers = {
    onText: (d) => {
      emitted = true;
      handlers.onText?.(d);
    },
    onReasoning: (d) => {
      emitted = true;
      handlers.onReasoning?.(d);
    },
    onToolStart: handlers.onToolStart,
  };

  let last: unknown;
  for (const [i, plan] of ordered.entries()) {
    try {
      const result = await once(plan, def, config, messages, tools, signal, tracked);
      if (plan.kind === 'proxy' && plans.some((p) => p.kind === 'direct')) preferProxy.add(def.id);
      return result;
    } catch (e) {
      last = e;
      const canFallBack =
        !emitted && isRetryable(e) && plan.kind === 'direct' && ordered.slice(i + 1).some((p) => p.kind === 'proxy');
      if (!canFallBack) throw e;
      // 直连在网络层失败（CORS / DNS / 证书）→ 换同源代理。
    }
  }
  throw last;
}

/** 注册表查询的转发，省得 UI 层再 import 一个 providers 路径。 */
export { PROVIDER_BY_ID };
