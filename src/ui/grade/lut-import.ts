/**
 * lut-import.ts — 把用户选的 `.cube` 存成**工程素材**。
 *
 * 为什么走素材台账而不是塞进 `values`：33 阶的 LUT 文本是几 MB，工程 JSON
 * 会被它撑爆；而且「同一张 LUT 用在多个片段上」应该是同一份字节。
 *
 * 为什么不走媒体池的导入入口：媒体池只认「能上时间轴的画面 / 声音」，
 * 而 LUT 既没有时长也没有尺寸。所以它由调色面板自己的文件选择器读进来。
 *
 * 解析失败**不写任何东西**：一张读不了的 LUT 留在台账里只会让「删除素材」
 * 那个界面多出一条谁也解释不清的条目。
 */

import { newId } from '../../core/schema';
import { parseCubeLut } from '../../core/lut-cube';
import { tr } from '../../i18n/index.svelte';
import { contentOfBytes } from '../../project/fingerprint';
import { appState } from '../app-state.svelte';

/** 导入结果：成功给素材 id，失败给原因（面板据此提示）。 */
export type LutImportResult = { ok: true; assetId: string; name: string } | { ok: false; reason: string };

export async function importLutFile(file: File): Promise<LutImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseCubeLut(new TextDecoder().decode(bytes));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const id = newId();
  const name = file.name.replace(/\.cube$/i, '');
  const content = await contentOfBytes(bytes);
  appState.assets.put(id, bytes, { kind: 'lut', name, originName: file.name }, content);
  appState.store.commit(tr('grade.lutImport'), (p) => {
    p.assets[id] = { id, kind: 'lut', name };
  });
  return { ok: true, assetId: id, name };
}

/** 工程里现有的 LUT 素材（面板的下拉列表）。 */
export function lutAssets(): { id: string; name: string }[] {
  return Object.values(appState.store.project.assets)
    .filter((a) => a.kind === 'lut')
    .map((a) => ({ id: a.id, name: a.name }));
}
