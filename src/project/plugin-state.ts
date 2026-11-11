/**
 * plugin-state.ts — 插件自己的小型状态（`plugins/<id>.state.json`）。
 *
 * ## 与 `session.json` / `project.json` 的三方分工
 *
 * | 文件 | 内容 | 谁写 | 丢了会怎样 |
 * |---|---|---|---|
 * | `project.json` | 工程内容 | 自动保存 | 灾难（所以有 `.bak`） |
 * | `session.json` | 播放头 / 选中 / 视图 / 面板开关 | 本应用的 UI | 回到默认位置 |
 * | `plugins/<id>.state.json` | **插件自己的配置与缓存** | 插件经 `api.state` | 回到插件的默认值 |
 *
 * 三条理由不把它塞进 `project.json`：
 *  1. **不抬 `schemaVersion`**：插件 id 不是数据模型的一部分（见 `core/plugin-id.ts`），
 *     让插件往工程本体里写任意 JSON 会把那份格式变成第三方约定的垃圾桶；
 *  2. **不参与脏标记**：「插件记住面板宽度」不该让工程提示未保存；
 *  3. **卸载即删**：`remove` 会连这个文件一起删；放在 `project.json` 里就删不干净。
 *
 * ## 上限
 *
 * 256 KB。这不是机器容量（所以不进 `core/capacity.ts`），而是**格式闸门**：
 * `api.state.set` 是插件随手调的，没有上限时一个「把整份文档缓存下来」的插件
 * 会让每次保存都写几十 MB，而失败的表现是「保存变慢 / 权限弹窗」。
 * 超限时**不写**并返回 false，插件自己看得见（`api.state.set` 会打一条警告）。
 */

import { readTextIfExists, writeBytesAtomic, type FsDirHandle } from './fs';
import { pluginsDir } from './plugins';

/** 信封版本。字段只增不改；读不出来就当空。 */
export const PLUGIN_STATE_FORMAT = 1;

/** 单文件上限（字节）。见文件头「上限」。 */
export const PLUGIN_STATE_MAX_BYTES = 256 * 1024;

/** 插件状态文件名。**不参与挂载**：`readPluginFiles` 只认 `.js` 结尾。 */
export function pluginStateFileName(pluginId: string): string {
  return `${pluginId}.state.json`;
}

/** 插件状态的形状。值必须是可 JSON 化的东西 —— 不可序列化的会被丢掉（见下）。 */
export type PluginState = Record<string, unknown>;

/**
 * 只保留 JSON 能原样往返的键。
 *
 * `structuredClone` 能存 `Map` / `Date` / `undefined`，但落盘再读回就变成 `{}` /
 * 字符串 / 消失 —— 那种「这次能用、下次打开就没了」的差异比直接拒绝更难查。
 * 所以写之前就按 JSON 口径过滤一次。
 */
function jsonSafe(data: PluginState): PluginState {
  const out: PluginState = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    try {
      JSON.stringify(value);
      out[key] = value;
    } catch {
      // 循环引用 / BigInt：跳过这一项，其余照写。
    }
  }
  return out;
}

/**
 * 读插件状态。**永不抛**：没有文件、坏 JSON、坏结构都返回 `{}`。
 *
 * 状态是插件自己的缓存，读丢了最坏是它重新算一遍 —— 不该挡住打开工程
 * （这条与 `session.ts` 同一条纪律）。
 */
export async function readPluginState(dir: FsDirHandle, pluginId: string): Promise<PluginState> {
  try {
    const pdir = await pluginsDir(dir, false);
    if (!pdir) return {};
    const text = await readTextIfExists(pdir, pluginStateFileName(pluginId));
    if (!text) return {};
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const o = raw as { format?: unknown; data?: unknown };
    if (typeof o.format === 'number') {
      return o.data && typeof o.data === 'object' && !Array.isArray(o.data)
        ? (o.data as PluginState)
        : {};
    }
    // 没有信封的（手写的 / 更早的形态）：整份当 data。
    return o as PluginState;
  } catch {
    return {};
  }
}

/** 写插件状态。返回 false = 没写（超限 / 权限 / 目录不在），**不抛**。 */
export async function writePluginState(
  dir: FsDirHandle,
  pluginId: string,
  data: PluginState,
): Promise<boolean> {
  try {
    const text = `${JSON.stringify({ format: PLUGIN_STATE_FORMAT, data: jsonSafe(data) }, null, 2)}\n`;
    if (text.length > PLUGIN_STATE_MAX_BYTES) return false;
    const pdir = await pluginsDir(dir, true);
    if (!pdir) return false;
    // 与 session 同口径：可丢弃状态不做读回校验。
    await writeBytesAtomic(pdir, pluginStateFileName(pluginId), text, { verify: false });
    return true;
  } catch {
    return false;
  }
}

/** 删插件状态。文件不存在算成功（幂等）；用途是「移除插件」时连带清理。 */
export async function removePluginState(dir: FsDirHandle, pluginId: string): Promise<void> {
  try {
    const pdir = await pluginsDir(dir, false);
    if (!pdir) return;
    await pdir.remove(pluginStateFileName(pluginId));
  } catch {
    // 不存在 / 目录被移走：都不是错误。
  }
}
