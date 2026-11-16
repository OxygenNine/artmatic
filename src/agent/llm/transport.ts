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
 *
 * **断线重连也在这层**：`network` / `server` 且一个字节都没收到时，把**同一份
 * 请求体**再发几次（判据见 `shouldReconnect`）。换路与重连是两件事 ——
 * 直连→代理是「同一次尝试里换条路」，重连是「整轮候选路径都失败之后再等一会儿」。
 */

import type { ToolSpec } from '../tools';
import { shedInlineImages } from './body-budget';
import { adapterFor } from './protocol';
import type { ProtocolAdapter, StreamHandlers } from './protocol/types';
import { endpointTail } from './providers/endpoint';
import { classifyHttpError } from './providers/errors';
import { PROVIDER_BY_ID, providerOf } from './providers/registry';
import { protocolFor, ruleFor } from './providers/routing';
import type { ProviderDef } from './providers/types';
import { LlmError, type ChatResult, type LlmConfig, type WireMessage } from './types';

/** 单次请求的超时（毫秒）。开思考的长回答 + 长工具循环需要留足。 */
export const LLM_TIMEOUT_MS = 300_000;

/**
 * 断线重连的预算。
 *
 * 一次重连 = 一个「整轮候选路径」（直连 + 代理）失败之后的再一次整轮。
 * 首发 + 3 次重连，退避合计 5.6 s —— 网络抖动通常在这之前就恢复了，
 * 而再往上加只会让真正的故障更难被判死。
 */
export const LLM_RECONNECT = {
  /** 总尝试次数（含首次请求）。 */
  attempts: 4,
  /** 第一次重连前等多久（之后每次 ×2）。 */
  baseMs: 800,
  /** 单次等待上限：第 4 次尝试不该让用户盯着「思考中」十几秒。 */
  maxMs: 5_000,
} as const;

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

/**
 * 附加 API（搜索 / 抓取 / 上传 / 余额）的候选路径。
 *
 * 与 `planTransports` 同一套判据，只是端点是**绝对路径**而不是对话端点 ——
 * 两处各写一份「stock 才给代理」的规则，迟早在某一家上分叉（表现是「对话能用、
 * 搜索永远 404」）。所以规则只在这里写一次，`planTransports` 是它的特例。
 */
export function auxPlans(config: LlmConfig, def: ProviderDef, path: string): TransportPlan[] {
  const baseUrl = trimSlash(config.baseUrl);
  if (!baseUrl) return [];
  const stock = def.baseUrl !== '' && baseUrl === trimSlash(def.baseUrl);
  const plans: TransportPlan[] = [];
  if (def.transport.browserDirect || !stock) plans.push({ kind: 'direct', url: `${baseUrl}${path}` });
  if (def.transport.proxy && config.proxyPath && stock) {
    plans.push({ kind: 'proxy', url: `${trimSlash(config.proxyPath)}/${def.id}${path}` });
  }
  return plans;
}

/** 哪些 provider 已经验证过「直连走不通」，下次直接走代理。按 id 记忆。 */
const preferProxy = new Set<string>();

/** 测试用：重置传输层记忆（不传 id = 全清）。 */
export function resetTransportPreference(providerId?: string): void {
  if (providerId) preferProxy.delete(providerId);
  else preferProxy.clear();
}

/** 把候选路径按「上次成功过哪种」重排。 */
function orderPlans(plans: TransportPlan[], providerId: string, proxyFirst = false): TransportPlan[] {
  if (!proxyFirst && !preferProxy.has(providerId)) return plans;
  return [...plans.filter((p) => p.kind === 'proxy'), ...plans.filter((p) => p.kind === 'direct')];
}

/**
 * 附加 API 的取数入口：直连 → 同源代理，非 2xx 归一成 `LlmError`。
 *
 * 只做「拿回一个 Response」这一件事：解析（搜索结果的形状、余额的字段）留给
 * 各自的模块，因为那些形状差异与传输无关。
 *
 * `body` 允许 `FormData`（Files API 的上传）—— 那种情况**不要**设 `Content-Type`，
 * 边界串由浏览器生成，手写一个会 400。
 */
export async function providerFetch(
  config: LlmConfig,
  path: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: BodyInit | null },
  signal?: AbortSignal,
): Promise<Response> {
  if (!config.apiKey.trim()) throw new LlmError('no-key', 'missing api key');
  const def = providerOf(config.providerId);
  const plans = orderPlans(auxPlans(config, def, path), def.id);
  if (!plans.length) {
    throw new LlmError('transport', `provider ${def.id} has no reachable endpoint for ${path}`);
  }

  let last: unknown;
  for (const [i, plan] of plans.entries()) {
    try {
      const res = await fetch(plan.url, {
        method: init.method,
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw classifyHttpError(res.status, detail.slice(0, 800));
      }
      if (plan.kind === 'proxy' && plans.some((p) => p.kind === 'direct')) preferProxy.add(def.id);
      return res;
    } catch (e) {
      last = e;
      // 只有网络层失败（CORS / DNS）才换路；状态码错误是上游的真实答复，换路也白搭。
      const networkish = e instanceof LlmError ? e.code === 'network' || e.code === 'server' : e instanceof TypeError;
      const canFallBack = networkish && plan.kind === 'direct' && plans.slice(i + 1).some((p) => p.kind === 'proxy');
      if (!canFallBack) throw e instanceof LlmError ? e : new LlmError('network', String(e), undefined, plan.url);
    }
  }
  throw last instanceof LlmError ? last : new LlmError('network', String(last));
}

/* --------------------------------------------------------------- 重连判据 */

/**
 * 第 n 次重连前的等待（n 从 1 起）：0.8 s / 1.6 s / 3.2 s，封顶 5 s。
 *
 * **不加抖动**：这里只有一个用户在打一个上游，「一群进程同时重试」的雪崩不
 * 存在；而随机会让「刚才到底卡了多久」变成不可复现的东西（根 AGENTS §1.2）。
 */
export function reconnectDelay(n: number): number {
  return Math.min(LLM_RECONNECT.baseMs * 2 ** (Math.max(1, n) - 1), LLM_RECONNECT.maxMs);
}

/** 传输层失败（网络断了 / 网关 5xx）。只有这两类值得再发一次同样的请求。 */
export function isTransportFailure(e: unknown): boolean {
  return e instanceof LlmError && (e.code === 'network' || e.code === 'server');
}

/**
 * 断线重连的判据（纯函数，单测钉着）。三条同时成立才重连：
 *
 *  1. **传输层失败**。401 / 402 / 429 / 400 / 上下文超限都是上游**给出**的答复，
 *     再发一遍只会拿到同一个答复，却把报错拖慢 5 秒。超时也不重试 —— 单请求
 *     300 s，再试两次就是 15 分钟看起来像卡死。
 *  2. **一个字节都还没收到**。已经吐过字再重发会把半截回答重放一遍；
 *     `emitted` 由 `streamChat` 按 onText / onReasoning 记账。
 *  3. **请求体不变**。重发的是首次那份 body **字符串本身**（见 `streamChat`
 *     里那句 `JSON.stringify`），前缀缓存该命中的仍然命中。
 */
export function shouldReconnect(e: unknown, emitted: boolean): boolean {
  return !emitted && isTransportFailure(e);
}

/** 退避等待；`signal` 一断立刻抛 cancelled（用户按了停止不该再等完这几秒）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('cancelled', 'aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError('cancelled', 'aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* --------------------------------------------------------------- 单次请求 */

function looksLikeStream(res: Response): boolean {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  // 服务端没给 content-type 时放行（少数代理会这样）。
  if (!ct) return true;
  return ct.includes('event-stream') || ct.includes('ndjson');
}

/**
 * 发一次请求并读完 SSE。
 *
 * `body` 是**传进来的**，不在里面构造：重连的每一次尝试必须发同一份字节，
 * 见 `streamChat`。
 */
async function once(
  plan: TransportPlan,
  adapter: ProtocolAdapter,
  def: ProviderDef,
  config: LlmConfig,
  body: string,
  signal: AbortSignal | undefined,
  handlers: StreamHandlers,
): Promise<ChatResult> {
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
        body,
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

  /*
   * 字节预算：token 环看不到 base64 的体积（见 `body-budget.ts`）。
   * 这里**一次**决定丢掉哪几张旧图，所有候选传输路径与所有重连共用同一份结果 ——
   * 每条路径各丢一次会让「直连失败换代理」时前后两次请求的字节不一致。
   */
  const shed = shedInlineImages(messages);
  const outgoing = shed.messages;

  /*
   * **请求体只构造一次**，所有尝试发的是同一个字符串 —— 这是「断线重连不炸
   * 前缀缓存」的全部实现。前缀缓存按**字节**比前缀（见 `src/agent/AGENTS.md`
   * 的缓存纪律）：重连时哪怕多一个空格、少一个字段，整段历史就重新按未命中计费，
   * 而用户看到的只是「网络抖了一下」。
   *
   * 所以别为了「每次重新构造更干净」把它挪回 `once()`。
   */
  const adapter = adapterFor(protocolFor(def, config.model));
  const body = JSON.stringify(adapter.buildBody({ config, provider: def, messages: outgoing, tools }));

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

  /** 直连在网络层挂过：同一轮里后面的尝试先走代理，别再白试一次。 */
  let proxyFirst = false;
  let last: unknown;

  for (let attempt = 0; attempt < LLM_RECONNECT.attempts; attempt++) {
    if (attempt > 0) {
      // 走到这里说明上一轮**所有**候选路径都在吐字之前失败，且判据允许重连。
      const delayMs = reconnectDelay(attempt);
      handlers.onRetry?.({
        retry: attempt,
        of: LLM_RECONNECT.attempts - 1,
        delayMs,
        ...(last instanceof LlmError ? { code: last.code } : {}),
      });
      // 用户按停止时这里立刻抛 cancelled，不必等完退避。
      await sleep(delayMs, signal);
    }

    const ordered = orderPlans(plans, def.id, proxyFirst);
    for (const [i, plan] of ordered.entries()) {
      try {
        const result = await once(plan, adapter, def, config, body, signal, tracked);
        if (plan.kind === 'proxy' && plans.some((p) => p.kind === 'direct')) preferProxy.add(def.id);
        return shed.dropped ? { ...result, omittedImages: shed.dropped } : result;
      } catch (e) {
        last = e;
        const reconnectable = shouldReconnect(e, emitted);
        // 直连在网络层失败（CORS / DNS / 证书）→ 换同源代理，同一次尝试内完成。
        const canFallBack =
          reconnectable && plan.kind === 'direct' && ordered.slice(i + 1).some((p) => p.kind === 'proxy');
        if (canFallBack) {
          proxyFirst = true;
          continue;
        }
        // 走投无路：要么不值得重连，要么重连配额用完 —— 抛最后那个错误。
        if (!reconnectable || attempt === LLM_RECONNECT.attempts - 1) throw e;
        // 整轮候选路径都试过了：退避之后从第一条路径再来一遍。
        break;
      }
    }
  }
  throw last instanceof LlmError ? last : new LlmError('network', String(last));
}

/** 注册表查询的转发，省得 UI 层再 import 一个 providers 路径。 */
export { PROVIDER_BY_ID };
