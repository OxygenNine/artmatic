/**
 * plugin-actions.ts — 插件的导入 / 移除 / 启停。
 *
 * 这一层是**唯一**把三件东西接起来的地方：用户选的文件、磁盘上的工程目录、
 * 运行期宿主（`PluginHost`）。分成两步是刻意的：
 *
 *   ① `pickPluginFile()`     只选文件，**不写盘、不加载**
 *   ② `confirmImport(pick)`  用户看过风险提示之后才真正导入
 *
 * 中间那一步（风险确认）不能省：插件是运行在主 realm 的任意代码，没有沙箱
 * （见 AGENTS 的安全边界与 `plugins/loader.ts` 的三条限制）。把确认塞进
 * `pickPluginFile` 里的话，UI 就没地方插入那句提示了。
 *
 * ## 为什么不改工程的脏标记
 *
 * 计划里原本写的是「改动会标记工程为有未保存改动」，实现时改掉了：插件文件
 * 写进 `<工程目录>/plugins/` 的那一刻**就已经落盘**，没有「未保存」这回事。
 * 标脏会让用户去点保存、而保存写的是 `project.json`（内容一个字节都没变），
 * 点完之后脏标记消失 —— 那是个骗人的动作。真正需要提示的是「工程还没保存、
 * 因此插件只能临时加载」，那句话由 `importPlugin` 直接 flash 出来。
 */

import { appState } from './app-state.svelte';
import { platform } from '../platform/index';
import { writePluginFile } from '../project/plugins';
import { pluginFileName } from '../project/layout';
import { tr } from '../i18n/index.svelte';
import { issueText } from './plugin-manager/plugin-panel-model';

export interface PickedPlugin {
  name: string;
  bytes: Uint8Array;
}

/** ① 选一个插件文件。用户取消返回 null。 */
export async function pickPluginFile(): Promise<PickedPlugin | null> {
  const picked = await platform.pickPluginFile();
  if (!picked) return null;
  return { name: picked.name, bytes: new Uint8Array(picked.data) };
}

/**
 * ② 真正导入。
 *
 * 顺序是「**先加载进内存，再写盘**」，两条理由：
 *   - 文件名要用**清单里的 id**（`plugins/<id>.js`），而 id 只有加载了才知道；
 *   - 加载失败（语法错误 / 清单不合法）的文件**不写盘** —— 让一个坏插件永久
 *     留在工程目录里，会让「打开工程就有报错」变成常态，而用户没有任何线索
 *     指向那次导入。
 *
 * 写盘失败时**不回滚内存状态**：这一次会话里插件是可用的，只是下次打开工程
 * 会没有它。为此专门 flash 一句提示 —— 比起把用户刚看到的效果收回去，
 * 「这次能用、但没存住」是更好的一种失败。
 */
export async function confirmImport(pick: PickedPlugin): Promise<void> {
  const host = appState.plugins;
  const outcome = await host.importBytes(pick.name, pick.bytes, appState.activeProjectId);

  const info = host.get(outcome.pluginId);
  const label = info?.name ?? outcome.pluginId;

  if (!outcome.ok) {
    // 失败原因不止一条（清单可能同时报几个结构问题），但底栏只放得下一句 ——
    // 完整的清单在插件面板里，那里才是排查的地方。
    const first = outcome.issues[0];
    appState.flash(first ? issueText(first, tr) : tr('pl.fail.notAPlugin'), 'error');
    return;
  }

  const dir = appState.projectDir;
  if (!dir) {
    appState.flash(tr('pl.flash.importedMemoryOnly', { name: label }), 'info');
    return;
  }

  try {
    await writePluginFile(dir, outcome.pluginId, pick.bytes);
    // 告诉宿主磁盘名 —— 停用 / 移除按它寻址（用户选的文件可以叫别的名字）。
    host.markPersisted(outcome.pluginId, pluginFileName(outcome.pluginId));
    appState.flash(tr('pl.flash.imported', { name: label }), 'success');
  } catch (e) {
    // 「能用但没存住」比「把用户刚看到的效果收回去」是更好的一种失败。
    appState.flash(tr('pl.flash.writeFailed', { name: label, detail: errText(e) }), 'error');
  }
}

/** 移除一个插件：注册表 + 记录 + 磁盘文件。 */
export async function removePlugin(pluginId: string): Promise<void> {
  const info = appState.plugins.get(pluginId);
  const label = info?.name ?? pluginId;
  await appState.plugins.remove(pluginId, appState.projectDir);
  appState.flash(tr('pl.flash.removed', { name: label }), 'success');
}

/** 启用 / 停用。停用只改文件扩展名，不删文件（见 host.disable 的理由）。 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const info = appState.plugins.get(pluginId);
  const label = info?.name ?? pluginId;
  try {
    if (enabled) await appState.plugins.enable(pluginId, appState.projectDir);
    else await appState.plugins.disable(pluginId, appState.projectDir);
  } catch (e) {
    // 改名失败时宿主保持原状态；界面必须说「没改成」，不能报成功。
    appState.flash(
      tr('pl.flash.toggleFailed', {
        name: label,
        action: tr(enabled ? 'pl.flash.enableAction' : 'pl.flash.disableAction'),
        detail: errText(e),
      }),
      'error',
    );
    return;
  }
  appState.flash(tr(enabled ? 'pl.flash.enabled' : 'pl.flash.disabled', { name: label }), 'info');
}

/** 面板里的「导入」：选文件 → 交给调用方的确认框 → 确认后走 `confirmImport`。 */
export async function beginImport(): Promise<PickedPlugin | null> {
  return pickPluginFile();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
