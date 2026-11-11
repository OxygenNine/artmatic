/**
 * project-actions.ts — 工程级动作（新建 / 打开 / 保存 / 另存为 / 最近工程）。
 *
 * 这一层是**唯一**把「磁盘上的工程」和「内存里的 store」接起来的地方。
 * 分出来的理由：`project/` 里的模块刻意不认识 appState（那是 UI 状态），
 * 而 UI 组件不该知道 `assets/` 怎么同步、句柄怎么存。两边都靠这层汇合。
 *
 * ## 新建 / 打开 = 再开一份，不是替换
 *
 * 顶栏的选项卡就是工程，所以这两个动作都走 `appState.adoptProject()` ——
 * 装配出一份**新的** `OpenProject` 挂上去并激活它，原来那些一份不动。
 * 装配顺序刻意是「先把素材读进来，再登记」：读盘失败时不会在选项卡上
 * 留下一个半成品工程。
 */

import { appState, type OpenProject } from './app-state.svelte';
import { platform } from '../platform/index';
import { watchProjectAssets } from './asset-watch';
import { createAssetStore, type AssetStore } from '../project/asset-store';
import {
  NotAProjectError,
  assetPathBytes,
  clearTrash,
  deleteAssetFile,
  deleteAssetPath,
  listOrphanPaths,
  listTrashFiles,
  moveAssetToTrash,
  openProject,
  saveProject,
} from '../project/io';
import { autosave, discardDraft, readDraft } from './autosave';
import { attachProjectSession, primeProjectSession } from './project-session';
import { notifyProjectSaved } from './plugins/plugin-bridge';
import { markPanelStateReady } from './plugins/plugin-panels';
import {
  adoptFileHandle,
  adoptNativeDir,
  hasDirectoryPicker,
  isNativeBacked,
  pickDirectory,
  queryPermission,
  readTextIfExists,
  requestPermission,
  type FsDirHandle,
} from '../project/fs';
import {
  getAssetHandle,
  putAssetHandle,
  requestReadPermission,
} from '../project/asset-handles';
import { contentOfBlob, contentOfPath } from '../project/fingerprint';
import {
  forgetProject,
  getHandle,
  keyForHandle,
  listRecentProjects,
  putHandle,
  rememberProject,
  renameRecent,
  type ProjectRef,
} from '../project/handles';
import { ProjectStore } from '../core/project-store';
import { migrateProject, type Project } from '../core/schema';
import { adoptCoverFromDir, refreshProjectCover } from './project-cover.svelte';
import { isPathDir, pathDir, pathFromHandle, pathHandleMarker } from '../project/path-dir';
import { runProjectDocHooks } from '../typography/hook-registry';
import { createBlankProject, createDemoProject, DEMO_ASSET_ID } from '../core/demo-project';
import { renderDemoAudio } from '../audio/demo-audio';
import { decodeAudio, computeWaveform } from '../audio/decode';
import { mimeForImageFilename, putImageBytes } from '../typography/image-assets';
import { registerImageBytes, registerVideoMedia } from '../engine/media-assets';
import { formatBytes } from '../core/format';
import { buildPoolItems, clipsUsingAsset, isPoolKind } from './media-pool';
import type { MediaPoolOp, MediaPoolSnapshot } from '../agent/types';
import { tr } from '../i18n/index.svelte';

function msg(e: unknown): string {
  if (e instanceof NotAProjectError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 启动时填充最近工程列表。**不做自动打开**：那需要用户手势，做不到。 */
export function refreshRecentProjects(): void {
  appState.recentProjects = listRecentProjects();
  // 老条目里存的是目录名（这一版之前）。能读到 project.json 就顺手换成真名。
  void adoptRecentNames();
}

/**
 * 把最近工程列表里的名字换成 `project.json` 的真名。
 *
 * **只对权限已经有效的条目做**：新会话里 `queryPermission()` 通常是 `prompt`，
 * 为了更新一行字去弹系统授权框是不划算的（首页不该有这种惊吓）。所以它在启动
 * 时多半什么都不做 —— 等用户真的打开过那份工程，`openAt` 会把真名写回去。
 */
async function adoptRecentNames(): Promise<void> {
  let changed = false;
  for (const ref of listRecentProjects()) {
    const raw = await getHandle(ref.key);
    if (!raw) continue;
    try {
      const dir = adoptNativeDir(raw);
      if ((await queryPermission(dir, 'read')) !== 'granted') continue;
      const text = await readTextIfExists(dir, 'project.json');
      if (!text) continue;
      const name = (JSON.parse(text) as { name?: unknown }).name;
      if (typeof name !== 'string' || !name.trim() || name.trim() === ref.name) continue;
      renameRecent(ref.key, { name: name.trim() });
      changed = true;
    } catch {
      /* 单个坏条目（json 坏了 / 目录被删）不影响其余 */
    }
  }
  if (changed) appState.recentProjects = listRecentProjects();
}

/* ------------------------------------------------------------ 工程目录位置
 *
 * 两个宿主两种根：
 *  · 桌面壳 —— **本机绝对路径**（`platform.fs` 那组 IPC）。工程因此知道自己
 *    在哪，「在资源管理器里打开」「把目录删掉」才成立。
 *  · 浏览器 —— FSA 句柄。读写一样成立，但那两件事做不到，界面按 `ref.path`
 *    在不在决定走哪条。
 *
 * 两边在 IndexedDB 里用同一个 store，靠 `pathHandleMarker` 区分。
 */

/** 把句柄登记进 IndexedDB：路径句柄存一个小对象，FSA 存原生句柄本身。 */
function putDirHandle(key: string, dir: FsDirHandle, raw?: unknown): void {
  if (isPathDir(dir)) {
    void putHandle(key, pathHandleMarker(dir.path));
    return;
  }
  const native = raw ?? (isNativeBacked(dir) ? dir.raw : null);
  if (native) void putHandle(key, native);
}

/** 从 key 拿回目录句柄（最近工程用）。权限**不在这里申请** —— 那需要用户手势。 */
async function dirForKey(key: string): Promise<FsDirHandle | null> {
  const raw = await getHandle(key);
  if (!raw) return null;
  const p = pathFromHandle(raw);
  if (p) return platform.fs ? pathDir(p, platform.fs) : null;
  return adoptNativeDir(raw);
}

/** 选一个工程目录。桌面壳走原生对话框（返回路径），其余宿主走 FSA。 */
async function pickProjectDirectory(id: string): Promise<{ dir: FsDirHandle; key: string } | null> {
  const nodeFs = platform.fs;
  if (nodeFs) {
    const path = await nodeFs.pickProjectDir();
    if (!path) return null;
    return { dir: pathDir(path, nodeFs), key: `path:${path}` };
  }
  const picked = await pickDirectory({ mode: 'readwrite', id });
  if (!picked) return null;
  const key = await keyForHandle(picked.raw, picked.dir.name);
  await putHandle(key, picked.raw);
  return { dir: picked.dir, key };
}

/* ------------------------------------------------------- 最近工程的菜单动作 */

/**
 * 「打开文件夹」。
 *
 * 桌面壳：工程目录就是一条本机路径，直接交给系统的文件管理器（`fsReveal`）。
 *
 * 浏览器：FSA 的目录句柄是**不透明引用**（见 `handles.ts::keyForHandle`），
 * 拿不到路径就没有「定位到它」这回事。那时退化成这个应用里「打开那个文件夹」
 * 唯一成立的事：把它接进来；已经开着就切到前台（左键是「再开一份」）。
 */
export async function openProjectFolder(ref: ProjectRef): Promise<void> {
  if (ref.path && platform.fs) {
    await platform.fs.reveal(ref.path);
    return;
  }
  const already = appState.projects.find((p) => p.key === ref.key);
  if (already) {
    appState.activateProject(already.id);
    return;
  }
  await openRecentProject(ref);
}

/** 从列表里移除（**不碰磁盘**）。没有二次确认：它可以被「打开工程」加回来。 */
export function forgetRecentProject(ref: ProjectRef): void {
  appState.recentProjects = forgetProject(ref.key);
  appState.flash(tr('proj.removedFromRecent', { name: ref.name }), 'success');
}

/**
 * 删除工程：**目录连同内容一起删掉** + 从最近列表里移除。
 *
 * 两条路：
 *  · 桌面壳（`ref.path` 在）—— 主进程 `fs.rm(recursive)`，目录本身也没了。
 *    主进程会额外校验这个目录里有 `project.json`，免得一个写错的路径把别的
 *    文件夹清了。
 *  · 浏览器（FSA）—— `FsDirHandle.remove()` 只能删子项，删自己需要父句柄，
 *    而父句柄从来没到过我们手里（FSA 也不提供「向上」）。所以那边只能**清空**，
 *    留一个空文件夹。确认框的措辞因此写的是「清空」——**它必须比实际做得少，
 *    不能多**。
 */
export async function deleteProjectFromDisk(ref: ProjectRef): Promise<boolean> {
  if (appState.projectBusy) return false;
  // 打开着的那份先关掉：用户已经在确认框里认过「不能撤销」，再叠一次脏确认是重复。
  for (const p of appState.projects) {
    if (p.key === ref.key) appState.closeProject(p.id, { force: true });
  }

  appState.projectBusy = true;
  try {
    if (ref.path && platform.fs) {
      await platform.fs.remove(ref.path, true);
    } else {
      const dir = await dirForKey(ref.key);
      // 老条目可能没记 `path`，但句柄本身是路径句柄 —— 那也走得到真删。
      if (dir && isPathDir(dir) && platform.fs) {
        await platform.fs.remove(dir.path, true);
      } else if (dir) {
        if ((await queryPermission(dir, 'readwrite')) !== 'granted') {
          const state = await requestPermission(dir, 'readwrite');
          if (state !== 'granted') {
            appState.flash(tr('proj.permissionDenied', { name: ref.name }), 'error');
            return false;
          }
        }
        // 逐项删。`assets/` 动辄几 GB，所以这个动作**可能**要几秒 —— 期间
        // `projectBusy` 挡住并发的打开/保存，界面上的其它动作自己会禁用。
        const failed: string[] = [];
        for (const item of await dir.list()) {
          try {
            await dir.remove(item.name, { recursive: true });
          } catch {
            failed.push(item.name);
          }
        }
        if (failed.length) throw new Error(failed.join(', '));
      }
    }
    appState.recentProjects = forgetProject(ref.key);
    appState.flash(tr('proj.deleted', { name: ref.name }), 'success');
    return true;
  } catch (e) {
    appState.flash(tr('err.io.deleteFailed', { detail: msg(e) }), 'error');
    return false;
  } finally {
    appState.projectBusy = false;
  }
}

/* ------------------------------------------------------------ 新建 */

/**
 * 把演示工程依赖的「程序生成素材」登记进某个素材仓。
 *
 * 这些素材由代码确定性重放，所以不落盘（`mode: 'generated'`），
 * 而且因为 id 固定、生成确定，**多份 demo 工程共用同一条**没问题。
 */
export function registerDemoAssets(target: AssetStore = appState.assets): void {
  target.putGenerated(DEMO_ASSET_ID, {
    kind: 'audio',
    name: tr('tl.demoAudioAsset'),
    originName: 'demo-song',
  });
}

/** 新建工程时可改的初始值（缺省 = `createBlankProject()` 的默认）。 */
export interface NewProjectSpec {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * 在同一页里**再开一份**工程并激活它。
 *
 * 新工程没有盘上位置（`dir: null`）、也从未保存过（`savedDocVersion: -1`），
 * 所以它一出现就是「脏」的 —— 这正是我们想要的：用户必须主动决定存到哪里。
 *
 * `spec` 是首页那个「新建工程」弹窗给的初始值。它在**构造 store 之前**写进
 * 工程本体：走 `ProjectStore.setResolution/setFps` 会各留一次撤销记录，
 * 于是用户新建完按第一次 Ctrl+Z，画面尺寸会跳回 1920×1080。
 */
export async function newProject(demo = false, spec: NewProjectSpec = {}): Promise<void> {
  if (appState.projectBusy) return;
  const store = new ProjectStore(demo ? createDemoProject() : blankFrom(spec));
  appState.adoptProject({
    store,
    savedDocVersion: -1,
    savedAt: 0,
  });

  if (demo) {
    // 音频是程序生成的，解码一次给播放器与波形。id 固定，所以多份 demo 共用。
    registerDemoAssets();
    const buf = await renderDemoAudio();
    appState.player.register(DEMO_ASSET_ID, buf);
    appState.waveforms = { ...appState.waveforms, [DEMO_ASSET_ID]: await computeWaveform(buf) };
  }

  appState.flash(demo ? tr('proj.newDemoFlash') : tr('proj.newBlankFlash'));
}

/** 空白工程 + 弹窗给的初始画幅 / 帧率。非法值一律落回默认（导入的工程包也走这条路）。 */
function blankFrom(spec: NewProjectSpec): Project {
  const p = createBlankProject(spec.name?.trim() || undefined);
  const w = Math.round(Number(spec.width ?? 0));
  const h = Math.round(Number(spec.height ?? 0));
  // 16 是 `Project` 校验与设置面板共用的下界（见 `app.customResolution` 旁的 NumberInput）。
  if (Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16) p.resolution = { w, h };
  const fps = Number(spec.fps ?? 0);
  if (Number.isFinite(fps) && fps > 0 && fps <= 240) p.fps = fps;
  return p;
}

/* ------------------------------------------------------------ 打开 */

/** 打开一份工程并把它**挂到选项卡上**（原来是替换当前那份，现在是多开）。 */
async function openAt(dir: FsDirHandle, raw: unknown, key?: string): Promise<boolean> {
  // 选择器 / 权限申请期间可能有保存或删除开始；入口统一再挡一次。
  if (appState.projectBusy) return false;
  appState.projectBusy = true;
  /** 插件在 adopt 之前挂载用的临时引用键；adopt 之后必须放掉。 */
  let openHolder: string | null = null;
  try {
    const res = await openProject(dir);

    const k = key ?? (await keyForHandle(raw, dir.name));
    putDirHandle(k, dir, raw);

    /*
     * 插件必须在 **adoptProject 之前**挂一次：`open` 钩子要改写的是
     * 「刚读出来、还没上屏」的文档，而那时代码只能来自工程目录里的插件。
     *
     * 引用计数用一个临时 holder key（`open:<k>`），adopt 之后马上释放；
     * 真正的 holder 仍由下面的 `mountPlugins(proj.id, dir)` 接上。第二次
     * `mountFromDirectory` 遇到已加载的健康记录会直接复用（不重新 import）。
     */
    openHolder = `open:${k}`;
    // `transient: true` —— 这一次挂载只为让 `open` 钩子跑起来：此刻工程还没进
    // store，插件的 `activate(api)` 拿不到任何可用的 API（见 `PluginHost.hold`）。
    await appState.plugins.mountFromDirectory(dir, openHolder, { transient: true });
    const hooked = runProjectDocHooks(res.project, 'open', { seed: res.project.seed });

    // 先把素材读回来，再登记 —— 读盘失败时不会在顶栏留下一个半成品 tab。
    const store = new ProjectStore(res.project);
    const assetStore = createAssetStore();
    const loaded = await assetStore.loadFrom(dir, res.ledger, res.project);
    // linked 素材的句柄不在工程目录里：从 IndexedDB 接回来（失败只影响那一条）。
    await resolveLocalHandles(assetStore);

    const proj = appState.adoptProject({
      store,
      assets: assetStore,
      dir,
      key: k,
      savedDocVersion: store.docVersion,
      savedAt: Date.now(),
      issues: res.issues,
      // 上次离开时的播放头 / 选中 / 视图。读不到（旧工程、手删了）就是从头开始。
      session: res.session,
    });
    /*
     * 会话状态读进来之后才算「已落盘」：否则一次尚未改动的打开会在第一次
     * 预览刷新后把同一份内容再写一遍（见 `primeProjectSession`）。
     */
    primeProjectSession(proj);
    await hydrateRenderAssets(assetStore);
    // 桌面版：监视 linked 的本机原文件（只标 stale，不自动换内容）。
    watchProjectAssets(proj);
    /*
     * 对话历史在**插件之前**读：它不参与渲染，纯数据；放在这里是因为
     * `adoptProject` 已经产生工程 id，而后面 `mountPlugins` 可能要编译着色器。
     * 读失败只影响历史面板（`loadAgentHistory` 自己吞掉单文件错误）。
     */
    await appState.loadAgentHistory(proj.id, dir);

    /*
     * 插件在**素材之后、其余收尾之前**挂载。
     *
     * 两条理由：
     *  - 要等 `adoptProject` 返回：引用计数的键是工程 id，而 id 是那一步才产生的；
     *  - 要等素材：`mountFromDirectory` 里的着色器编译校验会在**有 Kit 时**跑，
     *    而 Kit 存在与否取决于预览是否装配过。素材就绪后再挂，能让「打开工程」
     *    这一步的画面尽量只是一次完整渲染，而不是先缺特效再补上。
     *
     * 挂载本身**不会抛**（单个坏插件只记在自己头上），所以它不需要参与
     * 上面那个 try/catch 的语义。
     */
    await appState.mountPlugins(proj.id, dir);
    /*
     * 插件挂完了，panel 状态才可以「剪」。
     *
     * 会话里的面板开关是先读出来的，而挂载之前 `panelsFor()` 是空的 ——
     * 早剪一次就会把刚恢复的面板全删掉（表现是「重开工程面板没回来」）。
     */
    markPanelStateReady(proj.id);
    // 真正的 holder 已经接上；临时引用到这里才能放（放早了插件会被卸载再重导）。
    if (openHolder) {
      appState.plugins.release(openHolder);
      openHolder = null;
    }
    if (hooked.appliedHooks > 0) {
      appState.flash(tr('pl.hookOpened', { n: hooked.changedClips }), 'success');
    }

    appState.recentProjects = rememberProject({
      key: k,
      // 工程名（不是目录名）：用户给工程起的名字才是他认得出来的那个。
      name: store.project.name,
      dirName: dir.name,
      // 有路径才谈得上「在资源管理器里打开 / 删掉目录」，见 path-dir.ts。
      ...(isPathDir(dir) ? { path: dir.path } : {}),
      openedAt: Date.now(),
      assetCount: Object.keys(res.ledger.entries).length,
    });
    // 磁盘上可能已经有一张上次保存留下的封面（缓存被清过 / 换了机器）。
    // 此刻权限刚申请过，读它不会再弹第二个授权框。
    void adoptCoverFromDir(dir, k);

    // 只数 error 级的：info 级的（unhashed / untracked）是提示不是故障，
    // 每次都弹一句「有 N 个问题」会让真正该看的 missing 被淹没。
    // 提示里也用工程名：用户认出工程靠的是它，不是目录名。
    const problems = res.issues.filter((i) => i.severity === 'error').length;
    if (problems) {
      appState.flash(tr('proj.openedWithProblems', { name: store.project.name, problems }), 'error');
    } else {
      appState.flash(tr('proj.openedAssets', { name: store.project.name, n: loaded.loaded }), 'success');
    }
    return true;
  } catch (e) {
    if (openHolder) appState.plugins.release(openHolder);
    appState.flash(tr('err.io.openFailed', { detail: msg(e) }), 'error');
    return false;
  } finally {
    appState.projectBusy = false;
  }
}

/** 选一个目录打开（新开一份，不关掉现有的）。 */
export async function openProjectPicker(): Promise<boolean> {
  if (appState.projectBusy) return false;
  if (!platform.fs && !hasDirectoryPicker()) {
    appState.flash(tr('err.platform.openDirUnsupported'), 'error');
    return false;
  }
  const picked = await pickProjectDirectory('artmatic-open');
  if (!picked) return false;
  return openAt(picked.dir, null, picked.key);
}

/**
 * 打开一个**已经拿到的**目录句柄（不弹选择器）。
 *
 * 存在的理由是 E2E：`showDirectoryPicker` 是系统对话框，自动化驱动不了，
 * 而 OPFS 的根目录句柄是同一个 `FileSystemDirectoryHandle` 类型。
 * 于是测试可以 `navigator.storage.getDirectory()` 拿一个真目录喂进来，
 * 走的是与生产完全相同的代码路径 —— 不是 mock。
 */
export async function openProjectDirectory(
  dir: FsDirHandle,
  opts: { raw?: unknown; key?: string } = {},
): Promise<boolean> {
  return openAt(dir, opts.raw ?? null, opts.key);
}

/**
 * 把某个目录句柄接成**当前工程**的位置，之后保存直接写它。
 *
 * E2E 用它把 OPFS 的子目录喂进来（`showDirectoryPicker` 驱动不了），
 * 也预留给将来真正的「另存到此处」动作。
 */
export function attachProjectDirectory(dir: FsDirHandle, key: string): void {
  appState.projectDir = dir;
  appState.projectKey = key;
  // 「先聊天、后接目录」这条路（E2E 与将来的另存到此处）：内存里的历史要补写。
  appState.flushAgentHistory(appState.activeProject.id, dir);
  // 会话状态同样：这个位置还没写过，补一次（否则重开工程会回到第 0 秒）。
  attachProjectSession(appState.activeProject);
  // 让这个位置也能被「最近工程 / 恢复上次打开的工程」重新打开 —— 与
  // `openAt` 里那次 `putHandle` 同一件事。缺了它，E2E 的 OPFS 工程
  // 打开着却永远恢复不了（句柄没进 IndexedDB）。
  putDirHandle(key, dir);
}

/** 从最近工程列表恢复（新开一份）。 */
export async function openRecentProject(ref: ProjectRef): Promise<boolean> {
  if (appState.projectBusy) return false;
  const dir = await dirForKey(ref.key);
  if (!dir) {
    appState.flash(tr('proj.credentialExpired', { name: ref.name }), 'error');
    return false;
  }
  // 路径句柄不需要授权（根是上次用户亲手选的）。FSA 则需要：
  // 这里是**唯一在用户手势里**调 requestPermission 的地方 —— 新会话里
  // 句柄的权限多半已降级成 'prompt'，只有点击能把它申请回来。
  if (!isPathDir(dir) && (await queryPermission(dir, 'readwrite')) !== 'granted') {
    const state = await requestPermission(dir, 'readwrite');
    if (state !== 'granted') {
      appState.flash(tr('proj.permissionDenied', { name: ref.name }), 'error');
      return false;
    }
  }
  return openAt(dir, null, ref.key);
}

/* ------------------------------------------------------------ 保存 */

/**
 * 保存指定的那份工程。
 *
 * **必须显式给 `p`**，不能在里面读 `appState.store`：一次保存可能
 * 要流式写几 GB 素材，期间用户切选项卡是正常操作 —— 用「当前」会把 A 的内容
 * 记成 B 已保存（脏标记从此撒谎，而磁盘上多出一份不该有的文件）。
 */
async function writeTo(p: OpenProject, dir: FsDirHandle, key: string): Promise<boolean> {
  /*
   * **手动保存优先**：先取消排队中的自动保存，再等正在跑的
   * 那一轮写完。不等的话两边会同时 `createWritable({mode:'exclusive'})` ——
   * 后到的那个拿到 `NoModificationAllowedError`，而它可能正是用户按的 Ctrl+S。
   */
  autosave.cancel();
  await autosave.idle();

  appState.projectBusy = true;
  try {
    const ledger = await p.assets.buildLedger();
    /*
     * `save` 钩子改的是**将要写盘的副本**（`runProjectDocHooks` 内部克隆），
     * store 与撤销栈一个字都不动。钩子失败时返回原工程，保存照常继续 ——
     * 插件不能因为自己写坏了就把用户的保存卡住。
     */
    const hooked = runProjectDocHooks(p.store.project, 'save', {
      seed: p.store.project.seed,
    });
    const report = await saveProject({
      dir,
      project: hooked.project,
      ledger,
      openFor: (id) => p.assets.open(id),
    });
    if (hooked.appliedHooks > 0) {
      appState.flash(tr('pl.hookSaved', { n: hooked.changedClips }), 'success');
    }

    // 让素材仓记住「这些字节确实在 assets/ 里」：之后移除时才知道有没有文件可保留。
    p.assets.markPersisted(report.persistedAssets);

    const isActive = appState.activeProject === p;
    if (isActive) {
      appState.projectDir = dir;
      appState.projectKey = key;
    } else {
      // 后台完成：直接写字段，再补一次「打开着的工程」同步（setter 里那条只在激活时跑）。
      p.dir = dir;
      p.key = key;
      appState.refreshOpenTabs();
    }
    /*
     * Agent 历史补写。
     *
     * 首次保存之前 `p.dir` 是 null，会话只活在内存里；接上目录（含「另存为」换了
     * 新目录）之后必须整份刷过去，否则「先聊几轮再保存」会丢掉保存前的那几轮。
     * 目录树由 `saveProject` 刚建好（`PROJECT_DIRS` 含 `agent/sessions`），
     * 所以这次补写一定能落到已存在的目录里。
     */
    appState.flushAgentHistory(p.id, dir);
    p.savedDocVersion = p.store.docVersion;
    p.savedAt = Date.now();
    /*
     * 插件订阅的 `save` 事件。保存不改 store（`savedDocVersion` 在 appState 上），
     * 所以它不在 `store.subscribe` 这条线上 —— 少这一次通知，插件的
     * `api.on('save')` 永远不会触发，而作者只会以为是自己写错了。
     */
    notifyProjectSaved(p.id);
    /*
     * 首次保存 / 另存为换了目录：会话状态要写到**新的**那一个。之前记的
     * 「已写过」属于旧位置（甚至根本没有位置），作废后补写一次。
     */
    attachProjectSession(p);
    // 有正式落点了，本地草稿退休；降级提示也该消失（下一次写失败会重新亮）。
    if (isActive) {
      appState.autosaveFailure = null;
      appState.autosaveFatal = false;
    }
    void discardDraft(p.draftKey);
    appState.recentProjects = rememberProject({
      key,
      // 用**写下去的那份**的名字（`save` 钩子可能改过），与磁盘上的一致。
      name: hooked.project.name,
      dirName: dir.name,
      ...(isPathDir(dir) ? { path: dir.path } : {}),
      openedAt: Date.now(),
      assetCount: Object.keys(ledger.entries).length,
    });

    // 手动保存 = 「这份工程现在长这样」的权威时刻：刷缓存 + 写一份进 `thumbs/`。
    // 不 await：一次 WebP 编码不该出现在「保存要多久」的账上。
    void refreshProjectCover(p, dir, { writeFile: true });

    // 保存成功了，但带着警告 —— 用中性的 info 而不是绿色：
    // 绿字会说「一切都好」，而这里有东西需要看。
    if (report.warnings.length) {
      appState.flash(
        tr('proj.savedWithWarnings', { n: report.warnings.length, first: report.warnings[0] }),
      );
    } else {
      appState.flash(
        tr('proj.savedAssets', {
          n: report.assetsWritten,
          size: (report.project.bytes / 1024).toFixed(1),
          ms: report.durationMs,
        }),
        'success',
      );
    }
    return true;
  } catch (e) {
    appState.flash(tr('err.io.saveFailed', { detail: msg(e) }), 'error');
    return false;
  } finally {
    appState.projectBusy = false;
  }
}

/** 另存为：选一个新目录（或已有目录，会覆盖其中的工程文件）。 */
export async function saveProjectAs(): Promise<boolean> {
  if (appState.projectBusy) return false;
  if (!platform.fs && !hasDirectoryPicker()) {
    appState.flash(tr('err.platform.saveDirUnsupported'), 'error');
    return false;
  }
  // 选择器可能开着很久；先固定「这次保存的是哪一份」。
  const p = appState.activeProject;
  const picked = await pickProjectDirectory('artmatic-save');
  if (!picked) return false;
  return writeTo(p, picked.dir, picked.key);
}

/** 保存。没有位置时自动走「另存为」—— 第一次保存本来就要问位置。 */
export async function saveProjectNow(): Promise<boolean> {
  if (appState.projectBusy) return false;
  const p = appState.activeProject;
  if (!p.dir || !p.key) return saveProjectAs();
  return writeTo(p, p.dir, p.key);
}

/* ------------------------------------------------------- 渲染期素材恢复 */

/**
 * 把某个素材仓里的字节重新变成「能画出来的东西」。
 *
 * 持久化层存的是**来源**，渲染层要的是 objectURL / AudioBuffer /
 * 视频 `Blob`，两者之间必须有一次重建。**单条素材解不开不中断整个流程**：
 * 画面照旧能开，只是那一条没声音/不显示，而 `issues` 里通常已经有记录了。
 *
 * 视频走 `openVideo()`（`File` / 句柄直接交给解码器），**不读字节**。
 */
/**
 * 把 `fsa:<id>` 的本地句柄接回素材仓。
 *
 * 视频保留句柄（零读取）；图片/音频读出字节（同步 API `bytesOf` 要它）。
 * 权限申请失败、句柄丢失都只让这一条变成「脱机」，**不挡打开工程**。
 */
async function resolveLocalHandles(store: AssetStore): Promise<void> {
  for (const id of store.ids()) {
    const local = store.localOf(id);
    if (!local) continue;

    /*
     * 桌面版 linked：台账里是绝对路径。这里只 `stat` 一次（不读字节），
     * 把来源接成 `path`；真正的读取由 `setAssetPathReader` 注入的
     * `platform.readPath` 按范围完成。
     */
    if (!local.startsWith('fsa:')) {
      try {
        const st = await platform.statPath?.(local);
        if (st) store.attachLocalPath(id, local, st.size);
      } catch {
        /* 源文件不在：保持 none，画面走脱机占位 */
      }
      continue;
    }

    try {
      const raw = await getAssetHandle(id);
      if (!raw) continue;
      if (!(await requestReadPermission(raw))) continue;
      const fh = adoptFileHandle(raw as FileSystemFileHandle);
      const input = store.input(id);
      if (!input) continue;
      if (input.kind === 'video') {
        store.attachLocalHandle(id, fh, (await fh.get()).size);
      } else {
        const bytes = await (await fh.get()).readBytes();
        store.putLinkedBytes(id, bytes, input, store.contentOf(id));
      }
    } catch {
      /* 单条失败：画面走脱机占位 */
    }
  }
}

async function hydrateRenderAssets(store: AssetStore): Promise<void> {
  for (const id of store.ids()) {
    // 视频要 `handle.get()`（可能因权限失效而抛）：单条失败不挡打开。
    try {
      await hydrateAsset(store, id);
    } catch {
      /* 见函数头：那一条没画面，`issues` 里通常已有记录 */
    }
  }
}

/** 单条素材的渲染期重建（打开工程与「恢复未使用素材」共用）。 */
async function hydrateAsset(store: AssetStore, id: string): Promise<void> {
  const input = store.input(id);
  if (!input) return;

  if (input.kind === 'video') {
    const media = await store.openVideo(id);
    if (media) registerVideoMedia(id, media);
    return;
  }

  // 图片与音频本来就小，`readAll` 对 bytes 来源是零拷贝、对句柄来源读一份。
  const bytes = await store.readAll(id);
  if (!bytes) return;

  if (input.kind === 'image') {
    // ArrayBuffer 必须是这一份自己的：`putImageBytes` 会把它包成 Blob，
    // 而 registerImageBytes 也要一份；`slice()` 复制一份只在这里发生一次。
    const arr = bytes.slice().buffer as ArrayBuffer;
    const mime = mimeForImageFilename(input.originName);
    putImageBytes(id, arr, mime);
    // 排版文档用 objectURL（snapDOM 要从 DOM 取 <img>），
    // 而 image **片段**要的是 WebGL 纹理 —— 两条路都得喂。
    // 这里漏过一整个版本周期：`setImage` 零调用方，
    // 于是「转为图片」产出的片段在画面上一律空白。
    try {
      await registerImageBytes(id, new Blob([arr], { type: mime }));
    } catch {
      /* 单条解不开不挡打开（与下面的音频同理） */
    }
    return;
  }

  if (input.kind === 'audio') {
    try {
      // slice() 是为了给 decodeAudio 一份可被 detach 的拷贝：
      // 它会把传进去的 ArrayBuffer 用掉，而素材仓里那份还要留着保存。
      const buf = await decodeAudio(bytes.slice().buffer as ArrayBuffer);
      appState.player.register(id, buf);
      appState.waveforms = { ...appState.waveforms, [id]: await computeWaveform(buf) };
    } catch {
      /* 见函数头：单条失败不挡打开 */
    }
  }
}

/* -------------------------------------------------------- 未使用素材 */

/**
 * 把一条「已移除但字节还在」的素材恢复成工程素材。
 *
 * 恢复的元信息只能从素材仓拿（`project.assets` 那条在移除时就删了）。
 * 时长 / 尺寸**丢掉了** —— 台账不记它们。后果只有「素材池里那一行不显示
 * 时长、新拖出来的片段按默认长度」，已有片段照常播放（它们自带几何）。
 */
export async function restoreUnusedAsset(assetId: string): Promise<boolean> {
  if (!appState.hasProject) return false;
  const p = appState.activeProject;
  const input = p.assets.retainedInput(assetId);
  if (!input) return false;

  // 先把字节来源恢复好（同步 API `bytesOf` 之后才可用），再写工程表。
  await p.assets.restore(assetId);
  p.store.commit(tr('pool.restoreAsset'), (proj) => {
    proj.assets[assetId] = { id: assetId, kind: input.kind, name: input.name };
  });
  try {
    await hydrateAsset(p.assets, assetId);
  } catch {
    /* 字节读不出来：素材回表了，画面走「脱机媒体」占位（比假装恢复成功好） */
  }
  return true;
}

/**
 * 清理未使用素材：文件移进 `assets/.trash/`（**不是删除**）。
 *
 * 没有目录句柄的工程没有磁盘文件可清 —— 只有 `assets/` 存在时这个动作才有意义。
 * 走 `store.touch()` 让工程变脏：台账变了，必须被下一次保存写下去，
 * 否则「文件已进回收站」这件事只发生在内存里。
 */
export async function trashUnusedAsset(assetId: string): Promise<boolean> {
  if (!appState.hasProject) return false;
  const p = appState.activeProject;
  if (!p.dir) return false;
  const ledger = await p.assets.buildLedger();
  const entry = ledger.entries[assetId];
  if (!entry?.retained) return false;
  const moved = await moveAssetToTrash(p.dir, entry);
  if (!moved) return false;
  p.assets.remove(assetId);
  p.store.touch();
  autosave.schedule();
  return true;
}

/** 彻底删除源文件（只对已移除的保留项出现；二次确认由调用方做）。 */
export async function deleteUnusedAsset(assetId: string): Promise<boolean> {
  if (!appState.hasProject) return false;
  const p = appState.activeProject;
  const ledger = await p.assets.buildLedger();
  const entry = ledger.entries[assetId];
  if (!entry?.retained) return false;
  if (p.dir) await deleteAssetFile(p.dir, entry);
  p.assets.remove(assetId);
  p.store.touch();
  autosave.schedule();
  return true;
}

/* ---------------------------------------------------------- 占用与清理 */

export interface ProjectUsage {
  /** 活动素材的体积（含只有本地引用的）。 */
  projectBytes: number;
  /** 「未使用素材」的体积。 */
  unusedBytes: number;
  trashCount: number;
  trashBytes: number;
  orphanCount: number;
  orphanBytes: number;
}

const EMPTY_USAGE: ProjectUsage = {
  projectBytes: 0,
  unusedBytes: 0,
  trashCount: 0,
  trashBytes: 0,
  orphanCount: 0,
  orphanBytes: 0,
};

/**
 * 工程相关磁盘占用。**只 stat，不读字节** —— 视频素材也不会因此进堆。
 *
 * 没有目录句柄时只有「活动 / 未使用」两项有意义：回收站与孤儿都是磁盘概念。
 */
export async function getProjectUsage(): Promise<ProjectUsage> {
  if (!appState.hasProject) return { ...EMPTY_USAGE };
  const p = appState.activeProject;
  const store = p.assets;
  const unusedBytes = store.retainedIds().reduce((n, id) => n + (store.retainedSize(id) ?? 0), 0);
  if (!p.dir) {
    return { ...EMPTY_USAGE, projectBytes: store.totalBytes(), unusedBytes };
  }

  let trashCount = 0;
  let trashBytes = 0;
  let orphanCount = 0;
  let orphanBytes = 0;
  try {
    const trash = await listTrashFiles(p.dir);
    trashCount = trash.length;
    trashBytes = trash.reduce((n, f) => n + f.bytes, 0);
    const ledger = await store.buildLedger();
    const orphans = await listOrphanPaths(p.dir, ledger);
    orphanCount = orphans.length;
    for (const rel of orphans) orphanBytes += await assetPathBytes(p.dir, rel);
  } catch {
    /* 统计失败不该挡住面板：少显示一行比整块报错好 */
  }
  return {
    projectBytes: store.totalBytes(),
    unusedBytes,
    trashCount,
    trashBytes,
    orphanCount,
    orphanBytes,
  };
}

/** 清空 `assets/.trash/`。只删回收站里的文件，**不碰本地原文件**。 */
export async function clearProjectTrash(): Promise<{ removed: number; bytes: number } | null> {
  if (!appState.hasProject) return null;
  const p = appState.activeProject;
  if (!p.dir) return null;
  try {
    const res = await clearTrash(p.dir);
    appState.flash(tr('app.trashCleared', { n: res.removed, size: formatBytes(res.bytes) }), 'success');
    return res;
  } catch (e) {
    appState.flash(tr('app.cleanupFailed', { detail: msg(e) }), 'error');
    return null;
  }
}

/**
 * 批量清理未使用素材（进回收站）。
 *
 * 与逐条动作共用 `moveAssetToTrash`；台账只构建一次 —— 逐条调
 * `trashUnusedAsset` 会为每条素材重算一遍台账（哈希缓存虽然省算力，但
 * `buildLedger` 仍是 O(素材数)）。
 */
export async function trashAllUnused(): Promise<number> {
  if (!appState.hasProject) return 0;
  const p = appState.activeProject;
  if (!p.dir) return 0;
  const ledger = await p.assets.buildLedger();
  let moved = 0;
  for (const id of p.assets.retainedIds()) {
    const entry = ledger.entries[id];
    if (!entry?.retained) continue;
    try {
      if (await moveAssetToTrash(p.dir, entry)) {
        p.assets.remove(id);
        moved += 1;
      }
    } catch {
      /* 单条失败继续；结束后用 moved 如实报数 */
    }
  }
  if (moved) {
    p.store.touch();
    autosave.schedule();
  }
  return moved;
}

/** 批量彻底删除未使用素材（含工程副本；本地原文件永远不碰）。 */
export async function deleteAllUnused(): Promise<number> {
  if (!appState.hasProject) return 0;
  const p = appState.activeProject;
  const ledger = await p.assets.buildLedger();
  let removed = 0;
  for (const id of [...p.assets.retainedIds()]) {
    const entry = ledger.entries[id];
    if (!entry?.retained) continue;
    try {
      if (p.dir) await deleteAssetFile(p.dir, entry);
      p.assets.remove(id);
      removed += 1;
    } catch {
      /* 同上 */
    }
  }
  if (removed) {
    p.store.touch();
    autosave.schedule();
  }
  return removed;
}

/**
 * 清理 `assets/` 里台账不知道的文件（旧版本留下的孤儿）。
 *
 * **只删「不在当前台账里」的直接子文件**：`.trash/` 是目录，不会被 `listAssetPaths`
 * 列进来；也没有任何路径来自用户输入。仍然要求调用方二次确认。
 */
export async function cleanupOrphanFiles(): Promise<number> {
  if (!appState.hasProject) return 0;
  const p = appState.activeProject;
  if (!p.dir) return 0;
  const ledger = await p.assets.buildLedger();
  const orphans = await listOrphanPaths(p.dir, ledger);
  let removed = 0;
  for (const rel of orphans) {
    try {
      if (await deleteAssetPath(p.dir, rel)) removed += 1;
    } catch {
      /* 同上 */
    }
  }
  return removed;
}

/* ---------------------------------------------------------- 引用式素材 */

/**
 * 把一条 linked 素材收集进工程（`assets/` 里加一份副本，本地位置保留）。
 *
 * 有目录就立刻保存一次；没有目录只标记，等用户第一次保存。
 * **本地原文件永远不动。**
 */
export async function collectAsset(assetId: string): Promise<boolean> {
  if (!appState.hasProject) return false;
  const p = appState.activeProject;
  if (!p.assets.markBundled(assetId)) return false;
  p.store.touch();
  autosave.schedule();
  if (!p.dir) {
    appState.flash(tr('pool.collectPending'), 'info');
    return true;
  }
  const ok = await saveProjectNow();
  if (ok) appState.flash(tr('pool.collected'), 'success');
  return ok;
}

/**
 * 重新链接一条 linked 素材（源文件被移动 / 改名 / 权限丢了）。
 *
 * **只接受内容相同的新文件**：指纹不同意味着「这是另一份素材」，静默换掉会让
 * 已经排好的片段在用户没察觉时换了画面。要换内容请走「作为新素材导入」。
 */
export async function relinkAsset(assetId: string): Promise<boolean> {
  if (!appState.hasProject || appState.projectBusy) return false;
  const p = appState.activeProject;
  const input = p.assets.input(assetId);
  if (!input || !isPoolKind(input.kind)) return false;
  const picked = await platform.pickLinkedFile(input.kind);
  if (!picked) return false;

  const path = picked.path;
  const content = picked.file
    ? await contentOfBlob(picked.file)
    : path && platform.readPath
      ? await contentOfPath(picked.size, (s, e) => platform.readPath!(path, s, e))
      : null;
  if (!content) {
    appState.flash(tr('pool.relinkUnsupported'), 'error');
    return false;
  }
  const known = p.assets.contentOf(assetId);
  if (known && known.fp !== content.fp) {
    appState.flash(tr('pool.relinkMismatch'), 'error');
    return false;
  }
  try {
    if (input.kind === 'video') {
      if (path && !picked.file) {
        const read = platform.readPath!;
        p.assets.putPath(assetId, path, picked.size, input, content);
        registerVideoMedia(assetId, {
          kind: 'path',
          path,
          size: picked.size,
          read: (s, e) => read(path, s, e),
        });
      } else if (picked.file) {
        const fh = adoptFileHandle(picked.handle as FileSystemFileHandle);
        p.assets.putLinkedHandle(assetId, fh, picked.size, input, content);
        registerVideoMedia(assetId, picked.file);
      }
    } else if (path) {
      const bytes = await platform.readFileAt!(path);
      p.assets.putLinkedBytesAt(assetId, bytes, path, input, content);
      await hydrateAsset(p.assets, assetId);
    } else if (picked.file) {
      const bytes = new Uint8Array(await picked.file.arrayBuffer());
      p.assets.putLinkedBytes(assetId, bytes, input, content);
      await hydrateAsset(p.assets, assetId);
    }
    if (picked.handle) await putAssetHandle(assetId, picked.handle);
    p.assets.clearStale(assetId);
    p.store.touch();
    autosave.schedule();
    appState.flash(tr('pool.relinked', { name: input.name }), 'success');
    return true;
  } catch (e) {
    appState.flash(tr('app.cleanupFailed', { detail: msg(e) }), 'error');
    return false;
  }
}

/* ------------------------------------------------------------ 崩溃恢复 */

/**
 * 从本地草稿恢复一份工程。
 *
 * 落成一份**带未保存标记**的新工程（`savedDocVersion: -1`）：它还没有目录，
 * 首次保存会走「另存为」。恢复成功后草稿文件删除 —— 否则每次启动都会
 * 再问一遍同一份草稿；新工程的下一次编辑会重新写一份（新的 `draftKey`）。
 */
export async function restoreDraftProject(key: string): Promise<boolean> {
  if (appState.projectBusy) return false;
  const rec = await readDraft(key);
  if (!rec) {
    appState.flash(tr('proj.draftBroken'), 'error');
    return false;
  }
  appState.projectBusy = true;
  try {
    // 草稿可能来自更早的版本 —— 与打开工程走同一条迁移。
    const project = migrateProject(rec.project as Record<string, unknown>);
    const store = new ProjectStore(project);
    const proj = appState.adoptProject({ store, savedDocVersion: -1, savedAt: 0 });
    await hydrateRenderAssets(proj.assets);
    await discardDraft(key);
    appState.flash(tr('proj.draftRestored', { name: rec.name }), 'success');
    // 恢复出来的工程是脏的，但 adopt 不会触发 store 变更 —— 主动排一次，
    // 让下一次 2 s 之后的新草稿与本工程重新绑定。
    autosave.schedule();
    return true;
  } catch (e) {
    appState.flash(tr('err.io.openFailed', { detail: msg(e) }), 'error');
    return false;
  } finally {
    appState.projectBusy = false;
  }
}

/* ------------------------------------------------- Agent 媒体池桥（AGENTS §1.9） */

/**
 * 媒体池快照（`media_list`）。
 *
 * 面板需要的都在这里：归属（工程表 / 已移除）、字节、引用次数、源状态。
 * **只 stat 不读字节** —— 视频素材再多也不会因为这个列表进堆。
 */
export async function listMediaPool(): Promise<MediaPoolSnapshot> {
  if (!appState.hasProject) return { assets: [], usage: null };
  const p = appState.activeProject;
  const retained = new Set(p.assets.retainedIds());
  const rows = buildPoolItems(appState.project.assets, p.assets).map((it) => ({
    id: it.id,
    name: it.name,
    kind: it.kind,
    inProject: Boolean(appState.project.assets[it.id]),
    retained: retained.has(it.id),
    linked: it.linked === true,
    stale: it.stale === true,
    missing: it.missing,
    bytes: it.bytes,
    uses: clipsUsingAsset(appState.project, it.id).length,
  }));
  return { assets: rows, usage: await getProjectUsage() };
}

/**
 * 改素材的展示名（`rename_asset`）。
 *
 * 只动工程表与素材仓里的名字：磁盘文件名、工程副本路径、linked 的原文件路径
 * 都不变 —— 与「重命名素材」右键菜单是同一个入口（`appState.renameAsset`）。
 * 返回 false = 没有这条素材 / 没有打开工程。
 */
export function renameMediaAsset(assetId: string, name: string): boolean {
  if (!appState.hasProject || !appState.project.assets[assetId]) return false;
  appState.renameAsset(assetId, name);
  return true;
}

/**
 * 媒体池动作（`media_op`）。返回「真的改了几条」—— 0 = 条件不满足、什么都没做
 * （没有工程目录、素材不在回收站里、源文件已经没了……），调用方据此如实回执。
 */
export async function runMediaPoolOp(
  op: MediaPoolOp,
  assetId?: string,
): Promise<{ changed: number; bytes?: number }> {
  const id = assetId ?? '';
  switch (op) {
    case 'collect':
      return { changed: (await collectAsset(id)) ? 1 : 0 };
    case 'relink':
      return { changed: (await relinkAsset(id)) ? 1 : 0 };
    case 'restore':
      return { changed: (await restoreUnusedAsset(id)) ? 1 : 0 };
    case 'trash':
      return { changed: (await trashUnusedAsset(id)) ? 1 : 0 };
    case 'delete':
      return { changed: (await deleteUnusedAsset(id)) ? 1 : 0 };
    case 'trash_all':
      return { changed: await trashAllUnused() };
    case 'delete_all':
      return { changed: await deleteAllUnused() };
    case 'clear_trash': {
      const r = await clearProjectTrash();
      return { changed: r?.removed ?? 0, bytes: r?.bytes ?? 0 };
    }
    case 'cleanup_orphans':
      return { changed: await cleanupOrphanFiles() };
    default:
      return { changed: 0 };
  }
}
