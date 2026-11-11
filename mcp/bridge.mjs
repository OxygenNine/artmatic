/**
 * bridge.mjs — MCP ⇄ 页面：路径 A（CDP / Playwright 驱动）的传输实现。
 *
 * **这里没有业务逻辑**（方案 §2.1）：只有「起服务 → 起浏览器 → 把工具调用翻成
 * `page.evaluate`」。业务全在页面内的控制平面（`src/agent/`）里。
 *
 * ## 为什么是路径 A
 *
 * 方案 §6.1：仓库里**已经跑通**这条范式（`scripts/gen-algo-thumbs.mjs`），而且
 * 它天然满足 §6.4 的全部安全边界 —— 不开监听端口、不引入 token、生产代码零改动。
 * 页面内 WS（§6.2）是可选增强，本实现没有做。
 *
 * ## 必须继承的约束
 *
 * - `node = process.execPath`：`package.json` 没有 `engines`，不假设 PATH 里有
 *   `node`，也不假设它是哪个版本（`scripts/e2e.mjs:12` 的同一条纪律）。
 * - **不走 playwright 的 `webServer` 配置**：它经 shell spawn 长驻进程，在部分
 *   沙箱里整个进程树会收到 SIGTERM（`scripts/e2e.mjs:2-7` 记着这条）。
 * - 端口默认沿用 4173（e2e / algo thumbs 用的那个）：**如果那儿已经有一个
 *   preview 或 dev server 在跑，直接复用**（`e2e.mjs` 是同一个做法）。
 *   想旁挂用户自己开的 `pnpm run dev`，给 `ARTMATIC_URL` 即可。
 *
 * ## 长驻
 *
 * 网关是长驻进程：浏览器只拉一次，之后每次工具调用都是一次 `page.evaluate`。
 * 页面被 HMR 整页刷新（或用户手动按了刷新）之后 `page` 仍然有效，但
 * `window.__artmatic.control` 会短暂缺席 —— 所以每次调用前都要问一次
 * （见 `call`），而不是在启动时缓存一个 `control` 引用。
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const node = process.execPath;

/**
 * 仓库根：**从本文件的位置反推**，不继承 cwd —— MCP 客户端可以在任意目录里
 * spawn 我们（`cwd` 是用户配置文件里写的那个）。要用它做两件事：
 * 找 `vite`，以及把子进程的 cwd 钉成它。
 *
 * ⚠️ **必须过一遍 `realpathSync.native`**：Windows 上盘符大小写来自「传进来的那
 * 个字符串」，而 Vite 的 `import.meta.glob('/node_modules/...')` 是**根绝对路径**
 * —— 于是「root 是 `d:/…`、importer 是 `D:/…`」会让 Rollup 算出一个
 * `../../..……/d:/…` 这种不存在的相对路径，构建直接失败。`.native` 走的是
 * `GetFinalPathNameByHandle`，拿到的是文件系统里的**规范大小写**，两边就对齐了。
 */
const REPO_ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const VITE_BIN = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 跑一条会结束的命令（目前只有 `vite build`）。
 *
 * ⚠️ **stdout 必须丢掉**：我们这个进程的 stdout 是 JSON-RPC 通道（stdio 传输），
 * 把构建日志写进去就是往协议流里掺字符串 —— 客户端会解析失败，而且失败点
 * 离原因很远。日志一律从 stderr 走。
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], cwd: REPO_ROOT });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`))));
    p.on('error', reject);
  });
}

async function reachable(url, timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForPort(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url, 2000)) return;
    await delay(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

/**
 * 只允许连本机。方案 §6.4 第 1 条：**绝不 bind / 连 0.0.0.0**。
 * 这条判据在网关侧同样成立 —— 否则 agent 可以被指向某个第三方页面。
 */
function assertLoopback(url) {
  const u = new URL(url);
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`只允许连本机地址，收到 ${u.hostname}`);
  }
  return u;
}

export class Bridge {
  /** @param {{url?: string, port?: number, headless?: boolean, build?: boolean}} opts */
  constructor(opts = {}) {
    this.port = Number(opts.port ?? process.env.ARTMATIC_PORT ?? 4173);
    this.headless = opts.headless ?? process.env.ARTMATIC_HEADLESS !== '0';
    this.url = opts.url ?? process.env.ARTMATIC_URL ?? null;
    this.build = opts.build ?? process.env.ARTMATIC_NO_BUILD !== '1';
    this.browser = null;
    this.pageRef = null;
    this.server = null;
    this.origin = null;
  }

  /** 起服务（或复用已有的）并拉起浏览器。幂等。 */
  async start() {
    if (!this.origin) {
      if (this.url) {
        // 有头场景：旁挂用户自己开的 dev / preview（方案 §6.3「两者共用同一控制平面」）。
        const u = assertLoopback(this.url);
        this.origin = `${u.protocol}//${u.host}`;
      } else {
        const origin = `http://localhost:${this.port}`;
        if (await reachable(origin)) {
          this.origin = origin;
        } else {
          if (this.build) await run(node, [VITE_BIN, 'build']);
          this.server = spawn(
            node,
            [VITE_BIN, 'preview', '--port', String(this.port), '--strictPort'],
            // stdout 丢掉（协议通道）；cwd 钉在仓库根（见 REPO_ROOT 的注释）。
            { stdio: ['ignore', 'ignore', 'inherit'], cwd: REPO_ROOT },
          );
          await waitForPort(origin);
          this.origin = origin;
        }
      }
    }
    if (!this.browser) {
      this.browser = await chromium.launch({ channel: 'chrome', headless: this.headless });
    }
    return this.origin;
  }

  /** 当前页面。页面被关掉/整页刷新之后会自动重开。 */
  async page() {
    if (this.pageRef && !this.pageRef.isClosed()) return this.pageRef;
    // 起服务 + 起浏览器必须在 `newPage` **之前**（`start()` 幂等，第一次调用会做这两件事）。
    const origin = await this.start();
    const page = await this.browser.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[mcp] 页面错误：${e.message}\n`));
    await page.goto(`${origin}/`);
    // 控制平面是 `main.ts` 里同步挂上去的，`__artmatic` 出现之后它就在了。
    await page.waitForFunction(() => Boolean(window.__artmatic?.control), null, { timeout: 30_000 });
    this.pageRef = page;
    return page;
  }

  /**
   * 通用 RPC：把 `{ method, args }` 变成一个 `page.evaluate`。
   *
   * **每次都在页面里重新取 `control`**（不缓存引用）：整页刷新之后旧引用会变成
   * 一个指向旧 realm 的死对象，症状是「第一次调用好好的，刷新之后全部失败」。
   */
  async call(method, args = []) {
    const page = await this.page();
    return page.evaluate(
      async ({ m, a }) => {
        const C = window.__artmatic?.control;
        if (!C) return { ok: false, error: { code: 'not-ready', message: '页面里没有 __artmatic.control' } };
        try {
          return await C[m](...a);
        } catch (e) {
          // 控制平面本来不抛异常；这里兜住「传了它不认识的参数」这类**网关自身**的错。
          return { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } };
        }
      },
      { m: method, a: args },
    );
  }

  /**
   * 出图：PNG 字节在**页面内**转成 base64。
   *
   * 为什么要转：`Uint8Array` 过不了 CDP 的序列化（会变成 `{}`，而 `{}` 看起来
   * 「成功」）。base64 是唯一稳的形态，代价是体积 ×1.37。
   */
  async snapshotPng(args) {
    const page = await this.page();
    return page.evaluate(async (a) => {
      const C = window.__artmatic?.control;
      if (!C) return { ok: false, error: { code: 'not-ready', message: '页面里没有 __artmatic.control' } };
      const r = await C.snapshotPng(a);
      if (!r.ok) return r;
      const u8 = r.data;
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      return { ok: true, data: { base64: btoa(s), bytes: u8.length } };
    }, args);
  }

  /**
   * 界面截图。与 `snapshotPng` 同一条理由：`Uint8Array` 过不了 CDP 序列化，
   * 必须在页面内转 base64（顺便把 w / h / warnings 一起带回来）。
   */
  async uiScreenshotPng(args) {
    const page = await this.page();
    return page.evaluate(async (a) => {
      const C = window.__artmatic?.control;
      if (!C) return { ok: false, error: { code: 'not-ready', message: '页面里没有 __artmatic.control' } };
      const r = await C.screenshotUi(a);
      if (!r.ok) return r;
      const u8 = r.data.bytes;
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      return {
        ok: true,
        data: {
          base64: btoa(s),
          bytes: u8.length,
          w: r.data.w,
          h: r.data.h,
          warnings: r.data.warnings,
        },
      };
    }, args);
  }

  /**
   * 联系表（多帧拼图）。与 `snapshotPng` 同一条理由：`Uint8Array` 过不了 CDP 序列化，
   * 必须在页面内转 base64。
   */
  async renderSequencePng(args) {
    const page = await this.page();
    return page.evaluate(async (a) => {
      const C = window.__artmatic?.control;
      if (!C) return { ok: false, error: { code: 'not-ready', message: '页面里没有 __artmatic.control' } };
      const r = await C.renderSequence(a);
      if (!r.ok) return r;
      const u8 = r.data.png;
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      return {
        ok: true,
        data: {
          base64: btoa(s),
          bytes: u8.length,
          times: r.data.times,
          cols: r.data.cols,
          rows: r.data.rows,
          w: r.data.w,
          h: r.data.h,
        },
      };
    }, args);
  }

  /**
   * 起一次导出但**不等它**：结果挂在 `window.__mcpExport` 上，进度由
   * `exportState()` 轮询。这是把回调式的进度变成 MCP progress notification 的唯一办法
   * （页面内的 `onProgress` 回调过不了 CDP）。
   */
  async startExport(args) {
    const page = await this.page();
    return page.evaluate((a) => {
      window.__mcpExport = null;
      window.__artmatic.control.exportBase64(a).then(
        (r) => {
          window.__mcpExport = r;
        },
        (e) => {
          window.__mcpExport = { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } };
        },
      );
      return true;
    }, args);
  }

  /** 轮询一次：{ done, state }。结果本身用 `takeExportResult()` 取（可能很大）。 */
  async pollExport() {
    const page = await this.page();
    return page.evaluate(async () => {
      const C = window.__artmatic?.control;
      const st = C ? await C.exportState() : { ok: false, error: { code: 'not-ready', message: 'no control' } };
      return { done: window.__mcpExport !== null && window.__mcpExport !== undefined, state: st.ok ? st.data : null };
    });
  }

  async takeExportResult() {
    const page = await this.page();
    return page.evaluate(() => {
      const r = window.__mcpExport;
      window.__mcpExport = null;
      return r ?? null;
    });
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.pageRef = null;
    this.server?.kill();
    this.server = null;
  }
}
