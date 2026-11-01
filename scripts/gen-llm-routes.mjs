/**
 * gen-llm-routes.mjs — 把 `PROXY_ROUTES` 落成 `server/llm-routes.json`。
 *
 * ## 为什么要生成，而不是手写一份
 *
 * 真源是 `src/agent/llm/providers/registry.ts`，而 npm 版的本地服务是**裸 Node**
 * （零依赖，没有 Vite）：Node 进不去 TS，更解析不了全项目一致的无扩展名相对 import。
 * 构建时用 Vite 打一份 SSR 包读出来（与 `scripts/cli.mjs` 同一个手法），写成纯数据。
 *
 * 手写第二份是不行的：加第 17 家时一定会漏，而漏掉的表现是「这家在 npm 版里连不上」，
 * 错误还是 404 而不是人话。所以这里只做**转录**，漂移由
 * `tests/unit/agent-providers.test.ts` 兜住 —— registry 改了却没重跑这个脚本，单测直接红。
 *
 * 产物**入库**（与 `public/fonts/*.ttf` 同类）：`pnpm run serve` 不该要求先跑一次生成。
 * `pnpm run build` 会顺带重跑它，所以 `npm pack` / `publish` 里的那份永远是新的。
 *
 * 产物落 `node_modules/.cache/artmatic-llm-routes/`：中间包不进仓库。
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 仓库根 + `realpathSync.native` 规范化盘符大小写：Windows 上盘符大小写不一致会让
 * Rollup 算出不存在的相对路径（详见 `mcp/bridge.mjs` 里 REPO_ROOT 的注释）。
 */
const REPO_ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(REPO_ROOT, 'server', 'llm-routes.json');
const CACHE = join(REPO_ROOT, 'node_modules', '.cache', 'artmatic-llm-routes');

const { build } = await import('vite');
const { svelte } = await import('@sveltejs/vite-plugin-svelte');

await build({
  configFile: false,
  root: REPO_ROOT,
  // 只报 warn 以上：这条构建是 `pnpm run build` 的前置步骤，不该刷屏。
  logLevel: 'warn',
  plugins: [svelte()],
  build: {
    ssr: join(REPO_ROOT, 'src', 'agent', 'llm', 'providers', 'registry.ts'),
    outDir: CACHE,
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'registry.mjs' } },
  },
});

const { PROXY_ROUTES } = await import(pathToFileURL(join(CACHE, 'registry.mjs')).href);
if (!PROXY_ROUTES || typeof PROXY_ROUTES !== 'object') {
  process.stderr.write('[llm-routes] registry 里没有 PROXY_ROUTES\n');
  process.exit(1);
}

// 键排序：让 diff 只反映「谁进了白名单」，而不是对象字面量的书写顺序。
const routes = Object.fromEntries(
  Object.entries(PROXY_ROUTES).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedBy: 'scripts/gen-llm-routes.mjs',
      source: 'src/agent/llm/providers/registry.ts',
      routes,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`[llm-routes] ${Object.keys(routes).length} 家 → server/llm-routes.json\n`);
