#!/usr/bin/env node
/**
 * artmatic — npm 包的入口：起本地服务 → 开浏览器。
 *
 * 包内只有预构建的 `dist/` 与 `server/serve.mjs`，**不含** `src/`、Vite 与
 * Svelte 工具链。用户的机器上不该出现「装完还要自己 build」这一步。
 *
 * 这里只做 UX（参数、横幅、开浏览器、Ctrl+C），服务本体在 `server/serve.mjs`。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, startServer } from '../server/serve.mjs';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG_ROOT, 'dist');

const HELP = [
  'Artmatic — 本地启动 WebUI',
  '',
  '  artmatic                起服务并打开浏览器',
  '  -p, --port <n>          端口（默认 4180，占用时自动往后找）',
  '      --host <addr>       监听地址（默认 127.0.0.1）',
  '      --no-open           不自动打开浏览器',
  '  -v, --version',
  '  -h, --help',
].join('\n');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parse(argv) {
  const out = { port: undefined, host: undefined, open: true, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) die(`${a} 需要一个值`);
      i++;
      return next;
    };
    if (a === '-p' || a === '--port') out.port = Number(takeValue());
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--host') out.host = takeValue();
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--no-open' || a === '--open=false') out.open = false;
    else if (a === '-v' || a === '--version' || a === '-h' || a === '--help') out.flags.add(a);
    else die(`未知参数 ${a}（--help 看用法）`);
  }
  return out;
}

/** 开浏览器。打不开不是错误 —— 地址已经打印在终端里了。 */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    /* 没有 xdg-open / 权限不足都无所谓 */
  }
}

const args = parse(process.argv.slice(2));

if (args.flags.has('-h') || args.flags.has('--help')) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (args.flags.has('-v') || args.flags.has('--version')) {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (args.port !== undefined && (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535)) {
  die(`--port 不合法：${args.port}`);
}
if (!existsSync(join(DIST, 'index.html'))) {
  die(`缺少 dist/index.html（${DIST}）—— 在仓库里先跑 pnpm run build，发布包里自带它`);
}

const server = await startServer({
  root: DIST,
  host: args.host,
  port: args.port,
  // 覆盖文件的默认位置是**用户当前目录**，不是 node_modules 里（见 serve.mjs 头）。
  configPath: process.env.ARTMATIC_CAPACITY || join(process.cwd(), 'artmatic.capacity.json'),
});

process.stdout.write(`\nArtmatic  ${server.origin}\n\n`);

if (!server.loopback) {
  // 这条不是「防御性文案」：它是唯一会让用户看见的解释 —— 非 loopback 的 http 源
  // 不是 secure context，File System Access 与 WebCodecs 会直接缺 API，页面却一切正常。
  process.stdout.write(
    `注意：${server.host} 不是本机地址。http 下的 File System Access / WebCodecs 不可用，` +
      `请在跑这个服务的机器上访问 ${server.origin}\n\n`,
  );
}

if (args.open) openBrowser(server.origin);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
