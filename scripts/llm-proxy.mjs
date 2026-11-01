/**
 * llm-proxy.mjs — 给应用内 Agent 的 **同源兜底**。
 *
 * 为什么需要它：浏览器直连各家 API 的表现不一致 —— OpenAI 官方明确拒绝带
 * `Origin` 的请求，DeepSeek 实测被 CORS 拦，Gemini / OpenRouter 则开放。
 * 页面先直连；只有在**收到第一个字节之前**失败才换到本代理。
 *
 * 四条边界：
 *  1. **只转发注册表里的 provider**，路径 `/__llm/<providerId>/<端点>`。
 *     转发目标取自路由表（由 `providers/registry.ts` 派生），不是请求里带的 URL ——
 *     所以这不是通用反代，也就没有「拿它去刷别家站点」的口子。
 *  2. **不落 key、不写日志**：鉴权头从请求头原样透传，进程里不留副本。
 *  3. **三个宿主都挂**：Vite dev / preview（`vite.config.ts`，路由表直接从 TS 注册表取）
 *     与 npm 版的本地服务（`server/serve.mjs`，路由表读生成的 `server/llm-routes.json` ——
 *     裸 Node 进不去 TS 源码）。纯静态托管没有这条路由，页面回落到直连。
 *  4. 只放行 `POST`，且 `tail` 必须是 `/` 开头的同源路径（挡 `../` 穿越）。
 *
 * 与 `scripts/capacity.mjs` 同一个范式：插件在 `configureServer` 与
 * `configurePreviewServer` 两侧都挂，所以 E2E 也能测到这条兜底路径。
 */

const DEFAULT_PREFIX = '/__llm';

/** 需要透传给上游的请求头。别的（cookie / referer / origin）一概不带。 */
const FORWARD_HEADERS = [
  'content-type',
  'accept',
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
];

/**
 * `/__llm/deepseek/chat/completions` → `{ providerId:'deepseek', tail:'/chat/completions' }`。
 * 解析不出（缺 id、缺端点）返回 `null`。
 */
export function parseProxyPath(url, prefix = DEFAULT_PREFIX) {
  const path = String(url ?? '').split('?')[0];
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const providerId = rest.slice(0, slash);
  const tail = rest.slice(slash);
  if (!providerId || tail === '/') return null;
  return { providerId, tail };
}

/** 只放行白名单里的头，值必须是字符串。 */
export function pickForwardHeaders(headers) {
  const out = {};
  for (const name of FORWARD_HEADERS) {
    const value = headers?.[name];
    if (typeof value === 'string' && value) out[name] = value;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { code, message } }));
}

/**
 * 上游 URL = `baseUrl` + `tail`。**必须拼字符串，不能用 `new URL(tail, base)`**：
 * `tail` 以 `/` 开头，在 URL 里是「根相对引用」，会把 baseUrl 自带的路径整段丢掉 ——
 * `https://dashscope.aliyuncs.com/compatible-mode/v1` + `/chat/completions` 会变成
 * 根下的 `/chat/completions`，16 家里有 15 家直接 404（只有 baseUrl 无路径的
 * deepseek 碰巧对）。纯函数，便于单测。
 */
export function proxyTargetUrl(base, tail) {
  return new URL(`${base.replace(/\/+$/, '')}${tail}`);
}

/**
 * 中间件本体：`(req, res, next)`，与 connect / Vite 的 `server.middlewares` 同形状。
 * 不匹配前缀就 `next()`，所以宿主可以先挂它、后面接自己的静态服务。
 *
 * @param {{ routes?: Record<string, string>, prefix?: string }} options
 *   `routes`：providerId → 上游 origin（Vite 侧来自 `PROXY_ROUTES`，
 *   npm 侧来自生成的 `server/llm-routes.json`）。
 */
export function createLlmProxyHandler({ routes = {}, prefix = DEFAULT_PREFIX } = {}) {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(prefix)) return next();

    const parsed = parseProxyPath(url, prefix);
    if (!parsed) return fail(res, 404, 'not-found', 'unknown llm proxy route');
    if (req.method !== 'POST') return fail(res, 405, 'method', 'only POST is proxied');

    const base = routes[parsed.providerId];
    if (!base) return fail(res, 404, 'not-found', `provider ${parsed.providerId} is not proxied`);

    let target;
    try {
      target = proxyTargetUrl(base, parsed.tail);
    } catch {
      return fail(res, 400, 'bad-path', 'malformed upstream path');
    }
    // `../` 穿越：解析后的 origin 必须还是这一家。
    if (target.origin !== new URL(base).origin) {
      return fail(res, 404, 'not-found', 'path escapes the provider origin');
    }

    void (async () => {
      try {
        const body = await readBody(req);
        const upstream = await fetch(target, {
          method: 'POST',
          headers: pickForwardHeaders(req.headers),
          body,
        });

        res.statusCode = upstream.status;
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
        // 流式回答不能被缓冲或缓存。
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');

        if (!upstream.body) {
          res.end(await upstream.text());
          return;
        }
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
      } catch (e) {
        // 已开始写响应时只能断开；未开始则给一条可读的错误。
        if (!res.headersSent) {
          fail(res, 502, 'network', String(e?.message ?? e));
        } else {
          res.end();
        }
      }
    })();
  };
}

/** Vite 插件外壳：dev 与 preview 两侧挂同一个 handler。 */
export function llmProxy(options) {
  const handler = createLlmProxyHandler(options);
  return {
    name: 'artmatic:llm-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
