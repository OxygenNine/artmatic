/**
 * serve.mjs — npm 版运行时的静态服务：把预构建的 `dist/` 端出来。
 *
 * ## 为什么不是 `vite preview`
 *
 * `vite preview` 要 vite + `@sveltejs/vite-plugin-svelte` 在场（都是 devDependency，
 * 不会被装进用户的机器）。npm 用户应该只拿到 `dist/` 与一个 `node:http` 服务 ——
 * 零运行时依赖，这也是这个包能 `npx artmatic` 直接跑起来的前提。
 *
 * ## 与 dev / preview 的三处刻意差异
 *
 * 1. `/__capacity.json` 由这里提供，**复用** `scripts/capacity.mjs`（它只测量，
 *    派生预算的规则仍然只在 `core/capacity.ts`）。区别是覆盖文件的默认位置：
 *    dev 读仓库根，这里读 **cwd**（用户自己的目录），否则全局安装后会去写
 *    `node_modules` 里面。
 * 2. `/__llm/*` 与 dev / preview **同一条实现**（`scripts/llm-proxy.mjs`），差别只在
 *    路由表来源：这里读生成的 `server/llm-routes.json`（裸 Node 进不去 TS 注册表，
 *    见 `scripts/gen-llm-routes.mjs`）。没有它，OpenAI 官方端点（`browserDirect:false`）
 *    在 npm 版里就是不可用的。
 * 3. **只 bind loopback**：非 loopback 的 http 源不是 secure context，
 *    `showDirectoryPicker` / WebCodecs 会**静默**失效（能开页面、开不了工程）。
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { createLlmProxyHandler } from '../scripts/llm-proxy.mjs';

export const DEFAULT_PORT = 4180;

/** 端口被占（预览服务、E2E、另一个 artmatic）很常见，往后找几个而不是直接失败。 */
const PORT_TRIES = 20;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 扩展名 → Content-Type。
 *
 * `.wasm` 单列一条是必须的：HarfBuzz 的 `WebAssembly.instantiateStreaming` 只认
 * `application/wasm`，否则「文字转路径」直接失败，而**构建产物本身没有任何问题** ——
 * 所以这条漏了只会在用户机器上暴露。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 请求路径 → 动作。**纯函数**（不碰磁盘）。
 *
 * 三种形态：`file`（去磁盘找）、`redirect`（`/lab` 补尾斜杠）、`fallback`（SPA，
 * 端 `index.html`）。`fallback` 只在**没有扩展名**时给 —— 有扩展名还回落 HTML 的话，
 * `import` 会拿到一段 HTML，报错点离原因非常远（浏览器只说「MIME 不对」）。
 */
export function routePath(pathname) {
  if (pathname === '/lab') return { kind: 'redirect', location: '/lab/' };
  if (pathname === '/' || pathname === '') return { kind: 'file', path: '/index.html' };
  if (pathname.endsWith('/')) return { kind: 'file', path: `${pathname}index.html` };
  if (extname(pathname)) return { kind: 'file', path: pathname };
  return { kind: 'fallback' };
}

/**
 * URL 路径 → 磁盘绝对路径（不存在 / 越界 / 坏编码都返回 `null`）。
 *
 * `decodeURIComponent` 必须在**归一化之前**做：否则 `%2e%2e%2f` 会绕过前缀检查。
 */
export function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const abs = resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * 缓存策略：`/assets/` 的文件名带内容哈希，锁一年；HTML 是**唯一**会改而不改名的
 * 东西，必须 `no-cache`（否则用户升级后仍看到旧页面，而且没有任何报错）。
 */
function cacheFor(urlPath) {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

function send(res, status, body, headers = {}, headOnly = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(headOnly ? undefined : buf);
}

function sendText(res, status, text, headOnly) {
  send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8' }, headOnly);
}

function sendJson(res, status, body, headOnly) {
  send(res, status, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headOnly);
}

function sendFile(res, abs, urlPath, headOnly) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return sendText(res, 404, 'NOT FOUND', headOnly);
  }
  res.writeHead(200, {
    'Content-Type': mimeFor(abs),
    'Content-Length': st.size,
    'Cache-Control': cacheFor(urlPath),
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });
  if (headOnly) return res.end();
  const stream = createReadStream(abs);
  // 读一半出错（文件被替换 / 权限）时必须销毁连接：`res.end()` 会让浏览器
  // 拿到一个 Content-Length 对不上的响应，表现是「模块加载失败」。
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------- /__capacity.json */

/** 探测要 spawn `nvidia-smi` / `reg`，别每个请求都做；与 vite 插件同一个 30s。 */
const CAPACITY_TTL_MS = 30_000;
let capacityCache = { at: 0, body: '' };

async function capacityBody(configPath) {
  if (capacityCache.body && Date.now() - capacityCache.at < CAPACITY_TTL_MS) return capacityCache.body;
  let body;
  try {
    const { capacityPayload } = await import('../scripts/capacity.mjs');
    body = JSON.stringify(await capacityPayload(configPath));
  } catch (e) {
    // 探测失败不是错误：页面会退回 `DEFAULT_LIMITS`（见 core/capacity.ts）。
    body = JSON.stringify({ machine: null, overrides: null, error: String(e) });
  }
  capacityCache = { at: Date.now(), body };
  return body;
}

/* --------------------------------------------------------------- handler */

function createHandler({ root, configPath }) {
  return (req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const headOnly = method === 'HEAD';

      let pathname;
      try {
        pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        return sendText(res, 400, 'BAD REQUEST', headOnly);
      }

      if (pathname === '/__capacity.json') {
        if (method !== 'GET' && method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD');
          return sendText(res, 405, 'METHOD NOT ALLOWED', false);
        }
        return sendJson(res, 200, await capacityBody(configPath), headOnly);
      }
      // `/__llm/*` 在更外层就已经被代理接管了（见 startServer），这里只剩其它 `__` 前缀。
      // **先于方法检查**：代理客户端用 POST，回 405 会让人以为是「方法写错了」，
      // 而真实原因是这个端点根本不存在。
      if (pathname.startsWith('/__')) {
        return sendJson(
          res,
          404,
          JSON.stringify({ error: { code: 'no-endpoint', message: `${pathname} 在 npm 版里不存在` } }),
          headOnly,
        );
      }

      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendText(res, 405, 'METHOD NOT ALLOWED', false);
      }

      const route = routePath(pathname);
      if (route.kind === 'redirect') {
        res.writeHead(302, { Location: route.location });
        return res.end();
      }
      if (route.kind === 'file') {
        const abs = resolveFile(root, route.path);
        if (abs) return sendFile(res, abs, route.path, headOnly);
        return sendText(res, 404, 'NOT FOUND', headOnly);
      }

      const index = resolveFile(root, '/index.html');
      if (index) return sendFile(res, index, '/index.html', headOnly);
      return sendText(res, 500, 'dist/index.html 不存在：先在仓库里跑 pnpm run build', headOnly);
    })().catch((e) => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, String(e?.message ?? e), false);
    });
  };
}

/* ------------------------------------------------------ /__llm 路由表 */

const ROUTES_FILE = new URL('./llm-routes.json', import.meta.url);

/**
 * 代理白名单：`providerId → 上游 origin`，由 `scripts/gen-llm-routes.mjs` 从
 * `PROVIDERS`（真源 `src/agent/llm/providers/registry.ts`）转录而来。
 *
 * 缺文件**直接报错**而不是静默用空表：空表的表现是「OpenAI 那家连不上，回 404
 * provider is not proxied」，离真正的原因（包里少了生成物）很远。
 */
function loadProxyRoutes() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ROUTES_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`读不到 server/llm-routes.json（${e?.message ?? e}）：跑 pnpm run gen:llm-routes 重新生成`);
  }
  if (!parsed?.routes || typeof parsed.routes !== 'object') {
    throw new Error('server/llm-routes.json 形状不对：跑 pnpm run gen:llm-routes 重新生成');
  }
  return parsed.routes;
}

/* ---------------------------------------------------------------- listen */

function listenOnce(server, port, host) {
  return new Promise((ok, fail) => {
    const onError = (e) => {
      server.off('listening', onListening);
      fail(e);
    };
    const onListening = () => {
      server.off('error', onError);
      ok();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 起服务。
 *
 * @param {{root: string, host?: string, port?: number, configPath?: string}} opts
 * @returns {Promise<{port: number, url: string, origin: string, host: string, loopback: boolean, close: () => Promise<void>}>}
 */
export async function startServer(opts) {
  const { root, configPath } = opts;
  const host = opts.host ?? '127.0.0.1';
  const firstPort = Number(opts.port ?? process.env.ARTMATIC_PORT ?? DEFAULT_PORT);
  // 代理先挂、静态后接：`/__llm/*` 永远不经 SPA 回落（否则页面会拿到一段 HTML，
  // 表现是「一条空回答且没有任何错误」）。
  const proxy = createLlmProxyHandler({ routes: loadProxyRoutes() });
  const serveStatic = createHandler({ root, configPath });
  const server = createServer((req, res) => proxy(req, res, () => serveStatic(req, res)));

  let port = 0;
  let lastErr;
  for (let i = 0; i < PORT_TRIES; i++) {
    try {
      await listenOnce(server, firstPort + i, host);
      port = firstPort + i;
      break;
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!port) throw new Error(`端口 ${firstPort}–${firstPort + PORT_TRIES - 1} 都被占用：${lastErr?.message ?? ''}`);

  const loopback = LOOPBACK.has(host);
  // `0.0.0.0` / `::` 在浏览器里打不开，展示用的地址固定写 localhost。
  const shownHost = loopback ? (host === 'localhost' || host === '::1' ? host : '127.0.0.1') : 'localhost';
  const origin = `http://${shownHost}:${port}`;

  return {
    port,
    host,
    origin,
    url: `${origin}/`,
    loopback,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
