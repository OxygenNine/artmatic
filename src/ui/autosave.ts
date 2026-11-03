/**
 * autosave.ts（ui 层）— 把 `project/autosave.ts` 的调度器接到真实世界。
 *
 * 分工刻意是这样分的：
 *
 * | 层 | 知道什么 |
 * |---|---|
 * | `project/autosave.ts` | 防抖 / 单飞 / 降级（纯编排，可在 Node 里测） |
 * | 本文件 | 谁是当前工程、目录句柄在哪、草稿写去 OPFS 哪一格 |
 *
 * ## 正式路径与草稿路径是同一个出口
 *
 * 有目录句柄 → `saveProject`（**不带 `.bak`**，与手动保存唯一的差别）；
 * 没有 → OPFS 草稿。两者都由调度器按「写失败就降级」编排，界面只读
 * `appState.autosaveFailure` 那一格。
 *
 * **不动 `savedVersion`**：自动保存之后工程仍然是「有未保存改动」——
 * 用户必须自己决定什么时候保存（那一刻才会轮转 `.bak`）。
 */

import { appState } from './app-state.svelte';
import { Autosave, type AutosaveSnapshot } from '../project/autosave';
import { opfsRoot, type FsDirHandle } from '../project/fs';
import { listDraftFiles, readDraftFile, removeDraftFile, writeDraftFile, type DraftRecord } from '../project/drafts';
import { saveProject } from '../project/io';
import { AUTOSAVE_GAP_MS, refreshProjectCover } from './project-cover.svelte';
import { tr } from '../i18n/index.svelte';

/** OPFS 根只取一次（`getDirectory()` 不便宜，而且它会跨会话稳定）。 */
let rootPromise: Promise<FsDirHandle> | null = null;

function draftsRoot(): Promise<FsDirHandle> {
  rootPromise ??= opfsRoot();
  return rootPromise;
}

/**
 * 上一次真正写下去的内容（按工程键）。**不是**性能优化那么简单：
 *
 * `store.touch()` 不只是编辑 ——— 视频解码出一帧、算法烘焙完成都会 bump
 * version，于是 `projectDirty` 在播放期间恒为真（脏标记本身的方向是安全的：
 * 假阳性只是多问一句）。没有这层比对，自动保存会在播放 2 GB 视频时
 * **每两秒重写一遍 project.json**。
 *
 * 存的是序列化后的文本：内容真的没变时才跳过；改了任何一个字节都会写。
 */
const lastWritten = new Map<string, string>();

function projectText(project: unknown): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

export const autosave = new Autosave({
  snapshot(): AutosaveSnapshot | null {
    if (!appState.hasProject) return null;
    const p = appState.activeProject;
    return {
      key: p.draftKey,
      name: p.store.project.name || tr('proj.unnamed'),
      project: p.store.project,
      formal: !!p.dir,
    };
  },

  // 手动保存正在写同一个 project.json：让路（见 project/autosave.ts 的 canWrite）。
  canWrite: () => !appState.projectBusy,

  dirty(): boolean {
    // 与 `projectDirty` 同一口径：假阳性只是多写一次，假阴性才会丢改动。
    return appState.hasProject && appState.projectDirty;
  },

  async writeFormal(snap: AutosaveSnapshot): Promise<void> {
    /*
     * **按快照的 key 找回那份工程**，不用 `activeProject`：
     * 快照与写入之间隔着 await，用户可能已经切到另一份工程 ——
     * 用「当前」写会把 A 的内容写进 B 的目录（数据损坏，且不报错）。
     */
    const p = appState.projects.find((x) => x.draftKey === snap.key);
    /*
     * 工程已经被关掉了（快照之后用户确认丢弃）：什么都不写。
     * 退化成「写草稿」会让下次启动重新弹出这份已关闭的工程 —— 与
     * `onProjectClosed` 的「清草稿」互相打架，而用户看到的是「关不掉的东西」。
     */
    if (!p) return;
    if (!p.dir) throw new Error('no directory');

    const text = projectText(p.store.project);
    if (lastWritten.get(snap.key) === text) return; // 内容没变（播放期的 touch 不算改动）

    const ledger = await p.assets.buildLedger();
    const report = await saveProject({
      dir: p.dir,
      project: p.store.project,
      ledger,
      openFor: (id) => p.assets.open(id),
      // 三条硬约定之一：自动保存不轮转 .bak（见 project/autosave.ts 文件头）。
      backup: false,
    });
    // 自动保存同样会把素材写进 assets/：不标记的话，用户随后移除它会以为「没落过盘」
    // 而直接丢弃，文件却留在磁盘上变成无人认领的孤儿。
    p.assets.markPersisted(report.persistedAssets);
    // 记「实际写下去的那份」，不是调用前的快照 —— 写入期间可能又被改了一笔。
    lastWritten.set(snap.key, report.projectText);
    /*
     * 封面跟着自动保存一起走，但**只刷缓存**：磁盘上那份 `thumbs/cover.webp`
     * 由手动保存写（每两秒往工程目录写一遍图是没必要的抖动）。
     * 节流是必须的 —— 这条路径在编辑期每两秒被调一次。
     */
    void refreshProjectCover(p, p.dir, { throttleMs: AUTOSAVE_GAP_MS });
    // 正式工程已经是最新的，旧草稿留着只会在下次启动时多问一句。
    await removeDraftFile(await draftsRoot(), snap.key);
  },

  async writeDraft(snap: AutosaveSnapshot): Promise<void> {
    // 同上：已关闭的工程不该被草稿「复活」。
    if (!appState.projects.some((x) => x.draftKey === snap.key)) return;
    const text = projectText(snap.project);
    if (lastWritten.get(snap.key) === text) return;
    await writeDraftFile(await draftsRoot(), snap.key, snap.name, snap.project);
    lastWritten.set(snap.key, text);
  },

  onStatus(status, detail): void {
    if (status !== 'degraded' && status !== 'error') {
      appState.autosaveFailure = null;
      appState.autosaveFatal = false;
      return;
    }
    appState.autosaveFatal = status === 'error';
    appState.autosaveFailure = detail?.trim() ? detail : tr('app.autosaveUnknownReason');
  },
});

/**
 * 接上「工程变了」这条线。在 `app-boot.ts` 里调一次。
 *
 * 订阅点在 `appState.subscribeActive` 的版本回调里（`onStoreChange`）——
 * 那里是**唯一**跨工程都会经过的地方；在组件里监听会漏掉「后台工程被脚本改」
 * 这类路径，而漏掉的表现正是「自动保存时好时坏」。
 */
export function startAutosave(): void {
  appState.onStoreChange = () => autosave.schedule();
  // 切工程前把这一份冲掉（快照在同步阶段就固定，写入按 draftKey 找回）。
  appState.onProjectSwitch = () => void autosave.flushNow();
  // 关工程 = 用户确认丢弃：取消排队并清草稿，免得下次启动又问一遍。
  appState.onProjectClosed = (key) => {
    autosave.cancel();
    void discardDraft(key);
  };
  autosave.schedule();
}

/* ---------------------------------------------------------------- 草稿 */

/** 启动时列草稿（恢复横幅用）。没有 OPFS 能力时返回空，不抛。 */
export async function listDrafts(): Promise<DraftRecord[]> {
  try {
    return await listDraftFiles(await draftsRoot());
  } catch {
    return [];
  }
}

export async function readDraft(key: string): Promise<DraftRecord | null> {
  try {
    return await readDraftFile(await draftsRoot(), key);
  } catch {
    return null;
  }
}

export async function discardDraft(key: string): Promise<void> {
  try {
    await removeDraftFile(await draftsRoot(), key);
  } catch {
    /* 见 drafts.ts：删不掉就留着 */
  }
}
