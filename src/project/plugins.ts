/**
 * plugins.ts — 工程目录里 `plugins/` 的读写。
 *
 * 只管**字节怎么进出工程目录**，不认识插件清单（那是 `plugins/manifest.ts`）
 * 也不碰注册表（那是 `plugins/host.ts`）。分成三层的理由与素材那条链路一致：
 * 「文件系统 / 数据格式 / 运行期状态」各自能单独测，出问题的表现也各不相同。
 *
 * ## 与素材（`asset-store.ts`）的两处刻意的不同
 *
 * 1. **不做台账。** 插件是「一个文件 = 一个插件」，文件名就是插件 id，
 *    从目录本身就能重建全部信息 —— 再维护一份 json 只会多一个会漂的真相。
 * 2. **不做哈希。** 插件是我们自己写进去的（不是用户拖进来的大文件），
 *    字节就在手里；而且它每次迭代都会被重写，「内容没变就不重写」那条优化
 *    在这里省不下什么（插件都很小）。
 *
 * ## 三层文件名
 *
 *   `<id>.js`             正常，会被挂载
 *   `<id>.js.disabled`    停用（见 `host.disable()` 的理由：文件在不在就是真源）
 *   其它                  忽略（编辑器备份、`.map`、写到一半的临时文件…）
 */

import { resolveDir, writeBytesAtomic, type FsDirHandle } from './fs';
import { PLUGINS_DIR, PLUGIN_EXT, pluginFileName, safePluginId } from './layout';

/** 停用后缀。与 `plugins/host.ts` 的 `DISABLED_EXT` 必须一致。 */
export const PLUGIN_DISABLED_EXT = '.disabled';

export interface PluginFileEntry {
  /** 磁盘上的文件名（含扩展名）。仅用于诊断与展示。 */
  name: string;
  bytes: Uint8Array;
}

export interface ReadPluginsResult {
  /** 正常插件文件。 */
  files: PluginFileEntry[];
  /** 停用的插件文件名（带 `.disabled`）。**不读内容** —— 见 host 的说明。 */
  disabled: string[];
  /**
   * 读不出来的文件。**不抛** —— 一个坏文件不该让整个工程打不开，
   * 更不能让其它插件一起挂不上（它们是各自独立的扩展）。
   */
  failed: { name: string; detail: string }[];
}

/** `plugins/` 目录；`create=false` 且不存在时返回 null。 */
export async function pluginsDir(dir: FsDirHandle, create = false): Promise<FsDirHandle | null> {
  try {
    return await resolveDir(dir, [PLUGINS_DIR], create);
  } catch {
    return null;
  }
}

/** 是不是可挂载的插件文件（`.js`，但 `.js.disabled` 不算）。 */
export function isPluginFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(PLUGIN_EXT) && !lower.endsWith(PLUGIN_DISABLED_EXT);
}

/** 是不是停用的插件文件。 */
export function isDisabledPluginFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PLUGIN_EXT + PLUGIN_DISABLED_EXT);
}

/**
 * 读出 `plugins/` 下的全部插件文件。
 *
 * 逐个 try/catch：某个文件读不出来（权限、坏扇区、写到一半断电）只记一条，
 * 其余的照常返回。目录本身不存在时返回空集 —— 那是**正常状态**
 * （从没导入过插件的工程）。
 */
export async function readPluginFiles(dir: FsDirHandle): Promise<ReadPluginsResult> {
  const out: ReadPluginsResult = { files: [], disabled: [], failed: [] };
  const pdir = await pluginsDir(dir, false);
  if (!pdir) return out;

  let entries;
  try {
    entries = await pdir.list();
  } catch (e) {
    out.failed.push({ name: PLUGINS_DIR, detail: errText(e) });
    return out;
  }

  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    if (isDisabledPluginFileName(entry.name)) {
      out.disabled.push(entry.name);
      continue;
    }
    if (!isPluginFileName(entry.name)) continue;
    try {
      const fh = await pdir.openFile(entry.name, { create: false });
      out.files.push({ name: entry.name, bytes: await (await fh.get()).readBytes() });
    } catch (e) {
      out.failed.push({ name: entry.name, detail: errText(e) });
    }
  }
  // 目录项顺序由文件系统给，各平台不一致 —— 排序让「同一工程两次打开」的
  // 加载顺序稳定（插件之间没有依赖，但日志与 issue 顺序要可复现）。
  out.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.disabled.sort();
  return out;
}

/**
 * 按**文件名**写一个文件进 `plugins/`。
 *
 * 走 `writeBytesAtomic`（exclusive + 读回校验）：插件是**可执行的代码**，
 * 半截的文件不是「少了点东西」而是 import 时的语法错误，整个插件直接不可用。
 */
export async function writePluginFileByName(
  dir: FsDirHandle,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const pdir = await resolveDir(dir, [PLUGINS_DIR], true);
  await writeBytesAtomic(pdir, fileName, bytes, { verify: true });
}

/** 把一个插件写进 `plugins/<id>.js`。 */
export async function writePluginFile(dir: FsDirHandle, pluginId: string, bytes: Uint8Array): Promise<void> {
  await writePluginFileByName(dir, pluginFileName(pluginId), bytes);
}

/**
 * 按文件名读一个插件文件。返回 null = 目录 / 文件不存在。
 *
 * 不存在**不是错误**：Agent 的 `plugin_view` 既要能看已安装的插件，也要能看
 * 只在内存里试挂过的草稿 —— 后者本来就没有文件，空白回答比抛错更有用。
 * 停用的插件（`.js.disabled`）也能读：源码没变，只是不挂载。
 */
export async function readPluginFileByName(dir: FsDirHandle, fileName: string): Promise<Uint8Array | null> {
  const pdir = await pluginsDir(dir, false);
  if (!pdir) return null;
  try {
    const fh = await pdir.openFile(fileName, { create: false });
    return await (await fh.get()).readBytes();
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** 删掉 `plugins/` 下的某个文件。文件不存在算成功（幂等）。 */
export async function removePluginFileByName(dir: FsDirHandle, fileName: string): Promise<void> {
  const pdir = await pluginsDir(dir, false);
  if (!pdir) return;
  try {
    await pdir.remove(fileName);
  } catch (e) {
    // 不存在的文件不是错误：用户可能已经在资源管理器里删掉了。
    if (!isMissing(e)) throw e;
  }
}

/** 删掉 `plugins/<id>.js`。 */
export async function removePluginFile(dir: FsDirHandle, pluginId: string): Promise<void> {
  await removePluginFileByName(dir, pluginFileName(pluginId));
}

/**
 * 改名（读 → 写 → 删）。
 *
 * FSA 没有 rename（`FileSystemHandle.move()` 的可用性不足以依赖），所以只能
 * 三步走。中途失败时**优先保留目标名**：先写新名再删旧名，最坏结果是多一个
 * 旧文件（无害，下次打开会照常加载），而不是两边都没有。
 */
export async function renamePluginFile(dir: FsDirHandle, from: string, to: string): Promise<void> {
  const pdir = await pluginsDir(dir, false);
  if (!pdir) return;
  const fh = await pdir.openFile(from, { create: false });
  const bytes = await (await fh.get()).readBytes();
  await writePluginFileByName(dir, to, bytes);
  await removePluginFileByName(dir, from);
}

/**
 * 文件名 → 插件 id 的**猜测**（去掉扩展名与停用后缀）。
 *
 * 只在「文件在、但清单没读到」这类诊断里用；真正的 id 一律以清单为准。
 */
export function pluginIdFromFileName(name: string): string {
  let base = String(name ?? '').replace(/^.*[\\/]/, '');
  const lower = base.toLowerCase();
  const tail = PLUGIN_EXT + PLUGIN_DISABLED_EXT;
  if (lower.endsWith(tail)) base = base.slice(0, base.length - tail.length);
  else if (lower.endsWith(PLUGIN_EXT)) base = base.slice(0, base.length - PLUGIN_EXT.length);
  else base = base.replace(/\.[^.]*$/, '');
  return safePluginId(base, base || 'plugin');
}

function isMissing(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'NotFoundError';
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
