/**
 * desktop/smoke.mjs — 一键验证**打包产物**里的宿主接线。
 *
 * 前提：`dist/` 已构建（`pnpm run build`）。本脚本会重打便携目录，然后跑
 * `Artmatic.exe --host-smoke`：
 *   - preload 桥存在；
 *   - IPC 按范围读；
 *   - `artmatic-asset://` 的 206 / HEAD；
 *   - **本机路径工程**：`pathDir` 那套 IPC 能把工程写到盘上、「删除工程」能连根删掉，
 *     且「目录里没有 project.json 就不许删」这条守卫成立；
 *   - 设置 `ARTMATIC_SMOKE_VIDEO=<mp4>` 时，再验证「路径 linked 导入 →
 *     mediabunny CustomSource → 打包收集」整条链。
 *
 * 用法：
 *   pnpm run build && node desktop/smoke.mjs
 *   $env:ARTMATIC_SMOKE_VIDEO='D:\path\clip.mp4'; node desktop/smoke.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

execFileSync(process.execPath, [path.join(ROOT, 'desktop', 'build.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
})

const release = path.join(ROOT, 'release')
const candidates = fs
  .readdirSync(release)
  .filter((n) => n.startsWith(`Artmatic-${VERSION}-win32-x64`))
  .map((n) => path.join(release, n))
  .filter((p) => fs.statSync(p).isDirectory())
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

if (!candidates.length) {
  console.error('✗ 没找到 release 产物')
  process.exit(1)
}

const exe = path.join(candidates[0], process.platform === 'win32' ? 'Artmatic.exe' : 'Artmatic')
if (!fs.existsSync(exe)) {
  console.error('✗ 没找到可执行文件：', exe)
  process.exit(1)
}

console.log('▶', path.relative(ROOT, exe))
const r = spawnSync(exe, ['--host-smoke', '--nosandbox', '--show'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
})
process.exit(r.status ?? 1)
