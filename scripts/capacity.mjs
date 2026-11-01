/**
 * capacity.mjs — 探测**这台机器**的真实内存 / 显存容量（Node 侧，只做测量）。
 *
 * ## 为什么这件事必须在 Node 里做
 *
 * 页面里测不到：`navigator.deviceMemory` 粗到 GB 且只有 Chromium 有；
 * `performance.memory` 只统计 JS 堆，与纹理/显存毫无关系；WebGL 连显存大小
 * 都不肯说（`WEBGL_debug_renderer_info` 给的是型号字符串）。而容量不足的表现
 * 在我们这里是**静默**的（缺层、变糊、context lost），所以宁可去外面测。
 *
 * ## 分工：这里只测量，**策略在 `src/core/capacity.ts`**
 *
 * 本文件输出的是「机器事实」（MB），**不含任何比例 / 阈值**。派生规则放在
 * 页面的 TS 里，理由有两条：① 纯函数可单测；② 页面在没有服务端（纯静态部署）
 * 时也要能自己算。两处各写一份「推荐值」是必然会漂的形态。
 *
 * ## 显存怎么测
 *
 * 按可靠性排序，第一个成功的算数：
 *   1. `nvidia-smi`（N 卡，驱动自带）—— 还能顺带拿到**当前可用**显存；
 *   2. Windows 注册表 `HardwareInformation.qwMemorySize`（N/A/I 卡通用，
 *      给的是总量；`Win32_VideoController.AdapterRAM` 是 32 位有符号的，
 *      超过 4 GB 会报错或回绕，**不能用**）；
 *   3. Linux 的 sysfs（`/sys/class/drm/` 下各 card 的 `mem_info_vram_total`）。
 * 都拿不到 → `vramMB: null`，页面那边会退回保守默认（= 改造前的行为）。
 *
 * ⚠️ **混合显卡的已知偏差**：笔记本上 `nvidia-smi` 报的是独显，而页面可能跑在
 * 核显上。这里会照实报独显的值（因为 `kit.ts` 要的是 `high-performance` 适配器，
 * 浏览器通常也选独显），但把 `source` 字段带出去，好让人看出数字是哪来的。
 *
 * ## 覆盖
 *
 * `artmatic.capacity.json`（仓库根，**机器相关，不要提交**）：
 *
 * ```json
 * {
 *   "machine": { "freeRamMB": 3072, "vramMB": 16376 },
 *   "limits": { "videoTextureMB": 1536, "exportMemoryMB": 1024 }
 * }
 * ```
 *
 * `machine` 覆盖探测结果（部分字段即可），`limits` 直接覆盖派生值 ——
 * 后者是给「我就想让它多吃一点」用的逃生舱。路径也可以用环境变量
 * `ARTMATIC_CAPACITY` 指定。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CAPACITY_FILE = process.env.ARTMATIC_CAPACITY || join(REPO_ROOT, 'artmatic.capacity.json');

const MB = 1024 * 1024;
const toMB = (bytes) => Math.round(bytes / MB);

/** 跑一条外部命令，**绝不抛**：探测失败是正常情况，不是错误。 */
function run(cmd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** N 卡：`nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`。 */
async function viaNvidiaSmi() {
  const out = await run('nvidia-smi', [
    '--query-gpu=memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return null;
  // 多卡时取第一行（主卡）。数字单位已经是 MiB。
  const line = out.split(/\r?\n/).find((l) => l.trim());
  const m = /(\d+)\s*,\s*(\d+)/.exec(line ?? '');
  if (!m) return null;
  return { vramMB: Number(m[1]), freeVramMB: Number(m[2]), source: 'nvidia-smi' };
}

/** Windows 注册表：显卡子键下的 `HardwareInformation.qwMemorySize`（字节，QWORD）。 */
async function viaWindowsRegistry() {
  if (process.platform !== 'win32') return null;
  const base =
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  const list = await run('reg', ['query', base]);
  if (!list) return null;
  // 子键形如 ...\0000、\0001；只取数字子键。
  const keys = list
    .split(/\r?\n/)
    .map((l) => /\\\d{4}\s*$/.exec(l.trim())?.[0]?.trim())
    .filter(Boolean);
  let best = 0;
  for (const key of keys) {
    const v = await run('reg', ['query', `${base}${key}`, '/v', 'HardwareInformation.qwMemorySize']);
    if (!v) continue;
    const m = /0x([0-9a-fA-F]+)/.exec(v);
    if (!m) continue;
    // QWORD：必须用 BigInt 解析，Number 会在 >2^53 时失真（16 GB 恰好越界）。
    const bytes = Number(BigInt(`0x${m[1]}`) / 1024n / 1024n);
    if (bytes > best) best = bytes;
  }
  return best > 0 ? { vramMB: best, freeVramMB: null, source: 'win-registry' } : null;
}

/** Linux：AMD / Intel 独显的 sysfs 读数。 */
function viaSysfs() {
  if (process.platform !== 'linux') return null;
  for (let i = 0; i < 4; i++) {
    try {
      const bytes = Number(
        readFileSync(`/sys/class/drm/card${i}/device/mem_info_vram_total`, 'utf8').trim(),
      );
      if (Number.isFinite(bytes) && bytes > 0) {
        return { vramMB: toMB(bytes), freeVramMB: null, source: 'sysfs' };
      }
    } catch {
      /* 这个 card 没有该文件，试下一个 */
    }
  }
  return null;
}

/** 逐条尝试显存探测；全失败返回 null。 */
export async function probeVram() {
  for (const probe of [viaNvidiaSmi, viaWindowsRegistry, viaSysfs]) {
    try {
      const r = await probe();
      if (r) return r;
    } catch {
      /* 换下一种手段 */
    }
  }
  return null;
}

/**
 * 探测整机。**同步的部分（内存）先做，异步的（显存）再等** —— 内存一定要有值，
 * 显存可以是 null。
 */
export async function probeMachine() {
  const total = totalmem();
  const free = freemem();
  const vram = await probeVram();
  return {
    totalRamMB: toMB(total),
    freeRamMB: toMB(free),
    vramMB: vram?.vramMB ?? null,
    freeVramMB: vram?.freeVramMB ?? null,
    source: `node+${vram?.source ?? 'no-vram-probe'}`,
  };
}

/** 读覆盖文件（不存在 / 坏 JSON 都当没有，**不抛**）。 */
export function readOverrides(path = CAPACITY_FILE) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path,
      machine: raw && typeof raw.machine === 'object' && raw.machine ? raw.machine : null,
      limits: raw && typeof raw.limits === 'object' && raw.limits ? raw.limits : null,
    };
  } catch {
    return { path, machine: null, limits: null };
  }
}

/**
 * 服务端要交给页面的那一份：`{ machine, overrides }`。
 *
 * `machine` 是探测结果 + 文件里的 `machine` 覆盖（后者优先），
 * `overrides` 是文件里的 `limits`（由页面在**派生之后**套上去）。
 *
 * `configPath` 可以显式给：npm 版（`server/serve.mjs`）读的是**用户 cwd**，
 * 不是安装目录 —— 全局装完把覆盖文件写进 `node_modules` 里既找不到也不该写。
 */
export async function capacityPayload(configPath = CAPACITY_FILE) {
  const probed = await probeMachine();
  const ov = readOverrides(configPath);
  const machine = ov.machine ? { ...probed, ...pickNumbers(ov.machine), source: 'override' } : probed;
  return { machine, overrides: ov.limits ?? null, configPath: ov.path, configFound: !!ov.machine || !!ov.limits };
}

/** 只收数字字段：`machine` 是人工编辑的 JSON，不能直接摊进探测结果。 */
function pickNumbers(obj) {
  const out = {};
  for (const key of ['totalRamMB', 'freeRamMB', 'vramMB', 'freeVramMB']) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/* ------------------------------------------------------------ 直接运行时 */

// Windows 上 `argv[1]` 是 `D:\…` 形式，直接喂 `new URL` 会把 `D:` 当成协议 —— 必须过 pathToFileURL。
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { machine, configPath, configFound } = await capacityPayload();
  process.stdout.write(
    [
      '机器能力探测（MB）：',
      `  物理内存总量 ${machine.totalRamMB}`,
      `  可用内存     ${machine.freeRamMB}`,
      `  显存总量     ${machine.vramMB ?? '（探测不到）'}`,
      `  可用显存     ${machine.freeVramMB ?? '（探测不到）'}`,
      `  来源         ${machine.source}`,
      `  覆盖文件     ${configFound ? configPath : `${configPath}（不存在，用探测值）`}`,
      '',
      '这份「机器事实」由开发/预览服务器经 /__capacity.json 交给页面；',
      '预算的派生规则在 `src/core/capacity.ts`（那里才做比例与夹取）。',
      '页面里读 `__artmatic.capacity()` 看实际生效的预算。',
      '',
    ].join('\n'),
  );
}
