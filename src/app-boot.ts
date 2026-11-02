/**
 * app-boot.ts — 主应用装配（原 `main.ts` 的正文，逐字搬过来）。
 *
 * 入口是 `main.ts`：它先过能力闸门（WebGL2 / 目录选择），通过之后才**动态
 * import 本文件**。所以「能力不够的浏览器不该为整套 UI 付一次下载」这件事
 * 落在文件边界上，而不是某个 `if` 里。
 *
 * 这里的 import 顺序有讲究（主题 → store → mount），搬动时不要重排。
 */

import { mount } from 'svelte';
import App from './ui/App.svelte';
import './app.css';
// 控件族样式必须在 app.css 的兜底样式**之后**载入，否则同特异度的
// `button:hover` 会盖掉 `.ic-btn:hover`（纯图标按钮要保持透明底）。
import './ui/controls/controls.css';
import { createBlankProject, DEMO_ASSET_ID } from './core/demo-project';
import { renderDemoAudio } from './audio/demo-audio';
import { computeWaveform } from './audio/decode';
import { appState } from './ui/app-state.svelte';
import { platform } from './platform/index';
import { theme } from './ui/theme.svelte';
import { installTheme, applyFontScale, applyMotion } from './ui/theme-apply';
import { installWindowChrome } from './ui/titlebar';
import { runExport } from './exporters/export-runner';
import { PngSequenceSink } from './exporters/png-sequence';
import { Mp4Sink, probeMp4Codec } from './exporters/mp4-sink';
import { mixdown } from './exporters/mixdown';
import { unzipSync } from 'fflate';
import { opfsRoot, readBytesIfExists, resolveDir, writeBytesAtomic } from './project/fs';
import { splitRelPath, pluginFileName } from './project/layout';
import { writePluginFile } from './project/plugins';
import { packProject, unpackProject } from './project/package';
import { editorState } from './ui/typography/editor-state.svelte';
import { outlineTextElement } from './typography/text-outline';
import {
  attachProjectDirectory,
  collectAsset,
  openProjectDirectory,
  openProjectPicker,
  refreshRecentProjects,
  registerDemoAssets,
  listMediaPool,
  renameMediaAsset,
  runMediaPoolOp,
  saveProjectNow,
} from './ui/project-actions';
import { autosave, discardDraft, listDrafts, startAutosave } from './ui/autosave';
import { defaultParams, listGenerators } from './algos/registry';
import { compileAll } from './effects/compile-all';
import { registerImageBytes } from './engine/media-assets';
import { prepareProjectVideoAudio } from './engine/video-audio';
import {
  importAudioBlob,
  importImageBlob,
  importLinkedPath,
  importVideoFile,
} from './ui/media-import';
import { applyMachine, currentCapacity, resetCapacity, setLimits } from './core/capacity';
import { loadCapacityProfile } from './ui/capacity-profile';
import { mascotStats } from './ui/mascot/squeak';
import { createControlPlane } from './agent/index';
import { agentState, registerControlPlane } from './ui/agent/agent-state.svelte';
import { buildUiContext } from './ui/agent/context-bridge';
import type { ControlContext, OpenProjectView } from './agent/types';
import type { Renderer } from './engine/renderer';

/* 装配顺序：主题 → store → mount。
   主题必须最先注入：它是内联 style，写在 :root 上，任何时候注入都生效，
   但放在 mount 前可以避免第一帧用默认值闪一下。 */
installTheme(theme.spec);
applyFontScale(theme.fontScale);
applyMotion(theme.motionEnabled, theme.motionSpeed);

/*
 * 桌面壳的窗口顶栏：给系统画的窗口按钮让位、把顶栏设成可拖拽区。
 * 必须在 mount 之前 —— 晚一帧的话顶栏有一瞬间既不能拖、也没让开按钮。
 * 浏览器里是空操作（`platform.shell` 缺席）。
 */
installWindowChrome();

/*
 * **首屏零选项卡**：不自动开任何工程，直接进欢迎界面。
 *
 * 以前这里是 `init(new ProjectStore(createDemoProject()))` —— 每次打开/刷新都留一份
 * 要手动关掉的 demo。示例工程本身没被砍：它是空界面上的一个入口
 * （`EmptyState.svelte` 的「打开示例工程」→ `newProject(true)`）。
 *
 * 不传 store 是安全的：`appState.store` 会回落到一份丢弃用的空白工程
 * （见 `app-state.svelte.ts` 的 `placeholder`），而 `hasProject` 为假时
 * `tick()` 直接返回，不会有人对空工程渲染。
 * 渲染服务在 Preview.onMount → `appState.attachPreview` 里随 canvas 惰性创建。
 */
appState.init();

/*
 * 自动保存必须在 mount 之前接上：`appState.init()` 之后任何一次
 * `store.commit` 都应该被它看见。晚接的代价是「打开页面后第一笔改动
 * 没被自动保存」—— 而那是用户最可能丢的一笔（还在试）。
 */
startAutosave();

const app = mount(App, { target: document.getElementById('app')! });

/*
 * 启动画面（index.html 内联）在这之后才退场：两帧 rAF 保证浏览器已经
 * 至少提交过一次新 UI —— 先 fade 再移除，避免「splash 消失、界面还没画」
 * 的空白闪一下。移除失败也不影响功能（它 pointer-events: none）。
 */
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 320);
  });
});

// 最近工程列表：只填充 UI，**不自动打开**任何东西。
// 恢复一个工程需要 requestPermission()，而它必须有用户手势 ——
// 页面加载时做不到，所以只能等用户点。
refreshRecentProjects();

/*
 * 机器能力 → 容量预算。**起了不等**（见 ui/capacity-profile.ts）：
 * 各池子读的是 `getLimits()`，结果晚到也照样在下次取用时生效。
 */
void loadCapacityProfile();

// 演示音频：程序生成（无外部文件依赖），解码/波形都在后台完成。
const demoBuffer = await renderDemoAudio();
appState.player.register(DEMO_ASSET_ID, demoBuffer);
// 登记成 generated：它是几行代码算出来的，存进 assets/ 反而是让工程目录
// 带着一份可以随时重建的字节。（`newProject(true)` 走的是同一个函数。）
registerDemoAssets();
appState.waveforms = {
  ...appState.waveforms,
  [DEMO_ASSET_ID]: await computeWaveform(demoBuffer),
};
appState.renderer.renderFrame(appState.store.project, appState.playT);

// 调试 / E2E 钩子。
/**
 * 工程持久化的 E2E 入口。
 *
 * **OPFS 不是 mock。** `navigator.storage.getDirectory()` 返回的就是一个
 * `FileSystemDirectoryHandle`，与用户从选择器拿到的同类 —— 所以从这里进去的
 * 保存/打开链路与生产**完全同一条**，差别只在「根从哪来」。
 *
 * 之所以必须这么绕：`showDirectoryPicker()` 是系统对话框，Playwright 驱动不了。
 * 硬约束 1.5 说「任何只能在 Electron 里跑起来才能测的功能设计，都应当视为
 * 设计错误」—— 这里更进一步，不装 Electron 也能把持久化端到端跑通。
 */
const projectDebug = {
  /** 把 OPFS 下的一个子目录接成当前工程位置（不弹对话框）。 */
  async useOpfs(name = 'e2e-project'): Promise<string> {
    const root = await opfsRoot();
    const dir = await root.openDir(name, { create: true });
    attachProjectDirectory(dir, `opfs:${name}`);
    return dir.name;
  },
  save: () => saveProjectNow(),
  async open(name = 'e2e-project'): Promise<boolean> {
    const root = await opfsRoot();
    const dir = await root.openDir(name, { create: true });
    // 把原生句柄一起交出去，让句柄被持久化到 IndexedDB —— 与生产路径
    // （`showDirectoryPicker` → `putHandle`）一致，于是在这里打开的工程
    // 也能被「最近工程 / 恢复上次打开的工程」重新打开。
    const raw = (dir as { raw?: unknown }).raw;
    return openProjectDirectory(dir, { raw, key: `opfs:${name}` });
  },
  /** 读工程目录里的一个文件（相对路径，POSIX 斜杠）。 */
  async read(path: string): Promise<string | null> {
    const root = await opfsRoot();
    const segs = splitRelPath(path);
    const file = segs.pop();
    if (!file) return null;
    const dir = await resolveDir(root, segs, false);
    const bytes = await readBytesIfExists(dir, file);
    return bytes ? new TextDecoder().decode(bytes) : null;
  },
  async list(path = ''): Promise<{ name: string; kind: string }[]> {
    const root = await opfsRoot();
    const dir = await resolveDir(root, splitRelPath(path), false);
    return dir.list();
  },
  /** 删掉测试目录，保证用例之间互不干扰（上一轮的残留会让断言假绿）。 */
  async wipe(name = 'e2e-project'): Promise<void> {
    const root = await opfsRoot();
    await root.remove(name, { recursive: true }).catch(() => {});
  },
  /** 删掉工程目录里的一个文件（测「素材丢失」这类场景）。 */
  async remove(path: string): Promise<void> {
    const root = await opfsRoot();
    const segs = splitRelPath(path);
    const name = segs.pop();
    if (!name) return;
    const dir = await resolveDir(root, segs, false);
    await dir.remove(name);
  },
  /** 直接往工程目录里写一个文件（模拟外部程序替换了素材）。 */
  async write(path: string, bytes: number[]): Promise<void> {
    const root = await opfsRoot();
    const segs = splitRelPath(path);
    const name = segs.pop();
    if (!name) return;
    const dir = await resolveDir(root, segs, true);
    await writeBytesAtomic(dir, name, new Uint8Array(bytes), { verify: true });
  },

  /* ------------------------------------------------- 自动保存 / 草稿 */

  /**
   * 立即跑一轮自动保存（测试不等 2 s 防抖）。
   *
   * 判据仍然是自动保存自己的：工程不脏就什么都不写 —— 与生产同一条路径。
   */
  autosaveNow: () => autosave.flushNow(),
  /** 自动保存的状态（降级时 `failure` 是底栏那一句的原因）。 */
  autosaveState: () => ({
    status: autosave.status,
    detail: autosave.detail,
    failure: appState.autosaveFailure,
  }),
  /** OPFS 里的本地草稿。只回元信息：工程本体可能很大。 */
  drafts: async () => (await listDrafts()).map((d) => ({ key: d.key, name: d.name, savedAt: d.savedAt })),
  /** 清掉全部草稿（用例之间隔离；草稿跨用例残留会让「没有草稿」的断言假红）。 */
  wipeDrafts: async () => {
    for (const d of await listDrafts()) await discardDraft(d.key);
  },
  /** 当前工程的草稿键（读 `drafts/<key>.json` 时要用）。 */
  draftKey: () => (appState.hasProject ? appState.activeProject.draftKey : null),
  /** 把一条 linked 素材收集进工程（E2E 与将来的批量收集共用）。 */
  collect: (assetId: string) => collectAsset(assetId),
  /** 桌面宿主冒烟：按本机路径导入 linked 素材（正常路径走原生选择器）。 */
  importLinkedPath: (
    kind: 'audio' | 'image' | 'video',
    name: string,
    path: string,
    size: number,
    target: { trackId?: string | null } = {},
  ) => importLinkedPath(kind, name, path, size, target),

  /**
   * 把当前工程打包到 OPFS（E2E 用；`showSaveFilePicker` 驱动不了）。
   * 返回包字节数，便于断言「linked 素材也被收集进去了」。
   */
  async packToOpfs(name = 'e2e-package.artmatic'): Promise<{ bytes: number; assets: number }> {
    const chunks: Uint8Array[] = [];
    const report = await packProject({
      project: appState.store.project,
      store: appState.assets,
      sink: (c) => {
        chunks.push(c.slice());
      },
      appVersion: 'e2e',
    });
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.byteLength;
    }
    const root = await opfsRoot();
    await writeBytesAtomic(root, name, all, { verify: true });
    return { bytes: all.byteLength, assets: report.assets };
  },

  /** 从 OPFS 里的包导入到一个新目录并打开（E2E 用）。 */
  async importPackFromOpfs(packName: string, destName: string): Promise<boolean> {
    const root = await opfsRoot();
    const bytes = await readBytesIfExists(root, packName);
    if (!bytes) return false;
    const dir = await root.openDir(destName, { create: true });
    await unpackProject(new Blob([bytes as unknown as BlobPart]), dir);
    return openProjectDirectory(dir, {
      raw: (dir as { raw?: unknown }).raw,
      key: `opfs:${destName}`,
    });
  },

  /**
   * 用 OPFS 里的文件模拟「引用本机文件」（linked）导入。
   *
   * `showOpenFilePicker` 是系统对话框，Playwright 驱动不了；OPFS 的
   * `FileSystemFileHandle` 与它**同一个类型**，所以这条路径除了「怎么拿到句柄」
   * 之外与生产完全一致（包括存 IndexedDB、重开时申请权限）。
   */
  async importLinkedFromOpfs(
    kind: 'audio' | 'image',
    dirPath: string,
    name: string,
    target: { trackId?: string | null; start?: number } = {},
  ): Promise<string | null> {
    const root = await opfsRoot();
    const dir = await resolveDir(root, splitRelPath(dirPath), false);
    const rawDir = (dir as { raw?: FileSystemDirectoryHandle }).raw;
    if (!rawDir) return null;
    const native = await rawDir.getFileHandle(name);
    const file = await native.getFile();
    const bytes = await file.arrayBuffer();
    const out =
      kind === 'image'
        ? await importImageBlob(name, bytes, target, native)
        : await importAudioBlob(name, bytes, target, native);
    return out?.assetId ?? null;
  },
};

/**
 * 插件子系统的 E2E 入口。
 *
 * 与 `projectDebug` 同一条理由：界面上的「插件挂上了没有」要经过
 * 「打开面板 → 找那一行 → 读那一段字」三步，而**画面里那个特效真的生效了没有**
 * 根本没法从界面读。这里把宿主的清单与缺失扫描摊平成纯数据，
 * 让断言能精确到「哪一条 def 被剔除了、为什么」。
 */
const pluginDebug = {
  /** 当前挂载的全部插件（含加载失败的与停用的）。 */
  list: () => appState.plugins.list(),
  /** 已安装的插件 id。缺失扫描的判据是它。 */
  installed: () => [...appState.plugins.installedIds()],
  /** 当前工程引用了、但没装的插件。 */
  missing: () => appState.plugins.missing(appState.store.project),
  /** 子系统的版本号（插件集合变化时增长）。 */
  revision: () => appState.plugins.revision(),
};

/** 打开的工程列表：`__artmatic.projects()` 与控制平面共用一份口径。 */
function projectList(): OpenProjectView[] {
  return appState.projects.map((p) => ({
    name: p.store.project.name,
    dirty: p.savedVersion !== p.store.version,
    active: p.id === appState.activeProjectId,
    view: p.view.kind,
    saved: p.savedVersion >= 0,
    dir: p.dir?.name ?? null,
  }));
}

/**
 * ★ Agent 控制平面（方案：`docs/agent-control-plane.md`）。
 *
 * **装配点放在这里**（而不是 `src/agent/` 内部）：`appState` 是 `ui/` 层的
 * `$state` 类，让控制平面直接 import 它会把 `src/agent/` 反向绑在 `ui/` 上，
 * 将来 `/lab/` 或独立入口想复用控制平面时会成环（方案 §2.2）。注入点只有
 * 这一处，代价极小。
 *
 * 与 `__artmatic` 的关系是**同源演进，不是替换**：后者是控制平面的前身
 * （E2E / 试炼场专用），方案 §2.3 明确「保留 `__artmatic` 及其全部现有键不动」
 * —— `tests/e2e/_stage.ts` 与 `scripts/gen-*-thumbs.mjs` 依赖它们。
 *
 * > 关于「生产构建不注册」（方案 §6.4 第 3 条）：那条约束的对象是**页面内
 * > WebSocket 服务**（它开了监听端口，是真正的新攻击面）。控制平面对象本身
 * > 不比已有的 `__artmatic` 多给任何能力 —— 能执行 `window.__artmatic.control`
 * > 的脚本本来就能执行 `window.__artmatic.appState.store.commit`。而路径 A
 * > （headless 驱动）恰恰跑在 `vite preview` 的**生产产物**上，注册被门住
 * > 就等于把唯一跑得通的自动化通道拆掉。所以这里与 `__artmatic` 一样无条件注册；
 * > 页面内 WS（§6.2，方案标为可选）没有实现，那条边界因此没有失守。
 * > 生产构建确实**没有** WebSocket / 任何监听端口（断言见 `tests/e2e/agent.spec.ts`）。
 */
const controlContext: ControlContext = {
  // `store` / `assets` 是 getter，永远指向当前前台那份；**每次调用都重新取**
  // （多工程下缓存它必然错，见 AGENTS §5.2 的纪律）。
  getStore: () => (appState.hasProject ? appState.store : null),
  getRenderer: () => (appState.renderer as Renderer | undefined) ?? null,
  getAssets: () => (appState.hasProject ? appState.assets : null),
  getPlayT: () => appState.playT,
  setPlayT: (t) => {
    appState.playT = t;
  },
  getAudioBuffer: (id) => appState.player?.buffer(id) ?? null,
  prepareAudio: async (project) => {
    await prepareProjectVideoAudio(project, (id, buf) => appState.player.register(id, buf));
  },
  listProjects: projectList,
  saveProject: () => saveProjectNow(),
  // 给 name 走 OPFS（headless 驱动可用）；不给就弹系统对话框（必须有用户手势）。
  openProject: (name) => (name ? projectDebug.open(name) : openProjectPicker()),
  cancelPendingGesture: () => appState.cancelGesture(),
  refreshPreview: () => appState.refreshPreview(),
  /*
   * 用户此刻的界面（播放头 / 在哪一页 / 选中了什么）。每轮对话开工前读一次，
   * 拼进系统提示 —— 用户说「改这个」时，模型只有这一处坐标系。
   * 装配在 `ui/agent/context-bridge.ts`：id → 显示名要走 i18n，控制平面不 import ui。
   */
  getUiContext: buildUiContext,

  /*
   * 排版 / 插件的接缝。控制平面不 import `ui/` 与 `project/plugins`，
   * 这三件事只有装配点知道「现在前台是哪份工程、目录句柄在哪」。
   */
  getActiveTypoClipId: () => appState.activeTypoClipId,
  /*
   * 媒体池。这些动作会移动 / 删除磁盘文件，所以默认要用户确认一次；
   * 偏好关掉时控制平面直接执行（见 `mediaPoolOp`）。
   */
  mediaPool: { list: listMediaPool, run: runMediaPoolOp, rename: renameMediaAsset },
  getMediaPoolConfirm: () => agentState.prefs.mediaPoolConfirm,
  // 打字是直接改 doc.runs，不经过手势事务；agent 写文档前必须先停掉。
  stopTextEditing: () => editorState.stopEditing(),
  /*
   * 「文字转路径」的算力。控制平面不能 import `text-outline`（它拉 `render-dom`），
   * 所以轮廓在这里算、按 `TextOutlineResult` 交回去；快照 / 核对 / 提交都在那边。
   */
  outlineText: async (el, theme, customThemes) => {
    try {
      const r = await outlineTextElement(el, { fonts: appState.fonts, theme, customThemes });
      if (r.ok) return { ok: true, items: r.items, shadows: r.shadows };
      const { ok: _ok, code, ...detail } = r;
      return { ok: false, code, detail: detail as Record<string, unknown> };
    } catch (e) {
      // 抛错也归成一条可判别的失败（模型至少知道是「读字体」这一步挂了）。
      return {
        ok: false,
        code: 'local-failed',
        detail: { message: e instanceof Error ? e.message : String(e) },
      };
    }
  },
  getPluginHost: () => appState.plugins,
  getProjectKey: () => (appState.hasProject ? appState.activeProjectId : null),
  persistPlugin: async (pluginId, source) => {
    const dir = appState.projectDir;
    if (!dir) return false;
    await writePluginFile(dir, pluginId, new TextEncoder().encode(source));
    appState.plugins.markPersisted(pluginId, pluginFileName(pluginId));
    return true;
  },
  unloadPlugin: async (pluginId) => {
    // 只摘注册表与记录，不动磁盘（草稿丢弃走这条）。
    await appState.plugins.remove(pluginId, null);
  },
  removePlugin: async (pluginId) => {
    await appState.plugins.remove(pluginId, appState.projectDir);
  },
};

const control = createControlPlane(controlContext);
/*
 * 把控制平面交给界面层的 Agent 状态（它需要同一份实例来执行工具调用）。
 *
 * 反过来（agent-state import main）会成环；这个注册函数是唯一的方向：
 * `ui/agent/*` 只知道 `AgentControlPlane` 的类型，不知道它是怎么装配出来的。
 */
registerControlPlane(control);

(window as unknown as Record<string, unknown>).__artmatic = {
  /**
   * ⚠️ **getter，不是快照**：预览服务会在「换 canvas / WebGL 上下文恢复」时整块重建
   * （见 `appState.attachPreview`），那之后 `appState.renderer` 是**另一个对象**。
   * 写成快照的话，所有拿 `__artmatic.renderer` 的 E2E / 诊断脚本会在重建之后
   * 对着已经废弃的 renderer 操作 —— 表现是「测试说画面没变」而其实是读错了对象。
   */
  get renderer() {
    return appState.renderer;
  },
  appState,
  theme,
  /**
   * ★ 协议化的控制平面（agent 的唯一操作面）。每个方法都返回
   * `{ ok: true, data } | { ok: false, error: { code, message } }`，**不抛异常**
   * —— 异常跨传输层会丢掉类型，agent 就拿不到可判别的 `code` 了。
   */
  control,
  /**
   * `store` 与 `assets` 是 **getter**，指向当前激活工程那一份。
   *
   * 多工程下它们不能是固定引用 —— 测试里 `A.store.project` 必须始终
   * 等于「用户现在看到的这份」，与 UI 走的是同一个 getter。
   */
  get store() {
    return appState.store;
  },
  get assets() {
    return appState.assets;
  },
  /** 当前宿主实现（诊断 / 冒烟用；业务代码走 `platform/index`）。 */
  get platform() {
    return platform;
  },
  project: projectDebug,
  plugins: pluginDebug,
  /** 打开的工程列表，摊平成纯数据（page 里能直接断言，且可序列化）。 */
  projects: (): OpenProjectView[] => projectList(),
  renderFrame: (t: number) => appState.renderer.renderFrame(appState.store.project, t),
  readPixels: () => {
    const { data, w, h } = appState.renderer.readPixels();
    return { data: Array.from(data), w, h };
  },
  /**
   * E2E / 试炼场专用：把当前 WebGL 上下文里**所有**着色器预编译一遍
   * （特效 + realtime 算法 + 122 条转场），返回逐条成功/失败。
   *
   * 之所以要暴露到 `__artmatic`：artmatic 的着色器是惰性编译的，语法错误在你
   * 点到它之前不会报。E2E 靠这条断言「全量转场在这台机器上都能编译」——
   * 这是 122 条第三方 GLSL 唯一的自动化防线（见 effects/compile-all.ts）。
   */
  compileAll: () => {
    const { results, okCount, total } = compileAll(appState.renderer.kit);
    return { okCount, total, failures: results.filter((r) => !r.ok) };
  },
  /**
   * E2E 专用：**现场编一段真视频**当测试素材（红 1s → 蓝 1s，160×90 @10fps）。
   *
   * 为什么不往仓库里塞一个 mp4 当 fixture：二进制素材会一直躺在版本库里，
   * 而它本来就能用项目自己的编码链路生成。顺带这条路径还证明了「导出的
   * MP4 能被自己的解码链路读回来」—— 这是两个子系统之间一次真实的往返。
   *
   * 回传 `number[]`：20 帧的 160×90 只有几 KB，远低于 E2E 的传参上限；
   * 拿到之后用 Playwright 的 `setFiles({buffer})` 灌进真实的选择器，
   * 走的就是导入视频的**真实路径**。
   */
  makeTestVideo: async () => {
    const p = createBlankProject('e2e-test-video');
    p.resolution = { w: 160, h: 90 };
    p.fps = 10;
    p.duration = 2;

    /*
     * 内容的形状是刻意的：**上下两半不同色**，而且颜色随时间变。
     *
     *   t ∈ [0,1)： 上半红 / 下半蓝      t ∈ [1,2)： 上半绿 / 下半蓝
     *
     * 于是这一份素材同时能验两件事：
     *   · 取帧跟着 t 走（红 → 绿，纯色视频过不了这一条）
     *   · 上下方向正确（上半红/绿、下半蓝；上下颠倒会立刻被抓到）
     *
     * 两半靠**两条视觉轨 + transform** 做出来（solid 源不能上色曲线），
     * 顺带也把 placement 的 uv 语义钉住了。
     */
    const mk = (id: string, start: number, end: number, color: string, y: number) => ({
      kind: 'source' as const,
      id,
      start,
      end,
      label: color,
      fadeSec: 0,
      curves: {},
      source: { type: 'solid' as const, color },
      blend: 'normal' as const,
      opacity: 1,
      transform: { x: 0.5, y, sx: 1, sy: 0.5, rot: 0 },
      fit: 'stretch' as const,
    });
    const top = p.tracks.find((t) => t.kind === 'visual');
    if (!top || top.kind !== 'visual') return [];
    // 上半：红 → 绿
    top.clips.push(mk('tv-top-a', 0, 1, '#ff0000', 0.75), mk('tv-top-b', 1, 2, '#00ff00', 0.75));
    // 下半：蓝（贯穿两秒）
    p.tracks.push({
      kind: 'visual',
      id: 'tv-bottom',
      name: 'V2',
      enabled: true,
      clips: [mk('tv-bottom-a', 0, 2, '#0000ff', 0.25)],
    } as never);

    // 按尺寸探测阶梯：无硬编的机器上没有 Main，只有 baseline。
    const choice = await probeMp4Codec({ w: p.resolution.w, h: p.resolution.h, fps: p.fps });
    if (!choice) return [];
    const blob = (await runExport(appState.renderer, p, {
      sink: new Mp4Sink({ audio: null }),
      codec: choice.codec,
    })) as Blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // 导出会临时钉死 canvas 尺寸，导完要还回去，否则预览停在导出分辨率上
    appState.renderer.clearExportSize();
    appState.renderer.syncSize(appState.store.project.resolution);
    return Array.from(bytes);
  },
  /** E2E 专用：视频帧缓存的读数（证明解码真的发生了、缓存是有界的）。 */
  videoStats: () => appState.video.stats(),
  /** E2E / 诊断：特效池与模拟状态的容量读数（失败模式是静默的，所以要有读数）。 */
  poolStats: () => appState.renderer.poolStats(),
  /** E2E / 诊断：斑点追踪（方框跟踪）的读数。 */
  trackerStats: () => appState.renderer.trackerStats(),
  /** E2E / 诊断：调色中间缓冲的精度（16F 还是 8 位、为什么）。 */
  gradeStats: () => appState.renderer.gradeStats(),
  algoStats: () => appState.algos.stats(),
  /**
   * 容量预算的读数与写入。
   *
   * 读：`capacity()` 给出 `{ machine, limits, source }` —— 回答「这台机器上
   * 实际生效的预算是多少、数字从哪来」。
   * 写：`capacity.set({...})` 覆盖几项（E2E 用它把预算钉死，否则一条用例的
   * 行为会跟着跑测试的机器变）；`capacity.probe()` 重新问一次服务端。
   */
  capacity: {
    get: () => currentCapacity(),
    set: (patch: Parameters<typeof setLimits>[0]) => {
      setLimits(patch, 'override');
      return currentCapacity();
    },
    probe: () => loadCapacityProfile(),
    apply: (machine: Parameters<typeof applyMachine>[0]) => {
      applyMachine(machine);
      return currentCapacity();
    },
    reset: () => {
      resetCapacity();
      return currentCapacity();
    },
  },
  /**
   * E2E 专用：把一个 Blob 登记成图片素材（等价于导入图片 / 排版「转为图片」
   * 走的那一步）。E2E 里造不出真实文件，但可以造真实 PNG 字节。
   */
  registerImageAsset: (assetId: string, blob: Blob) => registerImageBytes(assetId, blob),
  /**
   * E2E / 手工验收：用**字节**走一遍真实的「导入视频」路径。
   *
   * 为什么要这个口子：视频导入靠 `showOpenFilePicker`（文件系统访问 API），
   * 它要求真实用户手势，Playwright 的 `filechooser` 事件截不到 —— 于是
   * 「方框跟踪」这类需要真实视频素材验收的功能无法在 headless 里跑。
   * 这里绕过的只是「选文件」那一步，probe / 登记 / 建片段全是同一条路。
   */
  importVideoBytes: (
    name: string,
    bytes: number[],
    target?: { trackId?: string; start?: number },
  ) => importVideoFile(new File([new Uint8Array(bytes)], name, { type: 'video/mp4' }), target ?? {}),
  /**
   * E2E / 性能探针专用：跑真实导出管线但**丢掉帧**，只回传耗时。
   *
   * 为什么需要它：视频解码是**异步就绪**的，而预览缺帧时会拿最近的帧顶上，
   * 所以「连着渲 N 帧然后计时」量到的是渲染缓存纹理的成本，不是解码成本
   * （实测会得到 3 万 fps 这种荒谬数字）。导出循环每个都 `await prepareFrame`
   * —— 那才是解码+上传的真实成本，也正是用户关心的「导出要多久」。
   *
   * 回传标量摘要：帧数、总耗时、每帧中位数。
   */
  exportTiming: async (frames: number) => {
    const project = { ...appState.store.project, duration: frames / appState.store.project.fps };
    const per: number[] = [];
    // 空 sink：只计时，不编码（编码是另一条链路，会把数字搅在一起）
    const sink = {
      configure: async () => {},
      submit: async (i: number) => {
        void i;
      },
      finalize: async () => new Blob(),
    };
    await runExport(appState.renderer, project, { sink: sink as never, onFrame: (ms) => per.push(ms) });
    appState.renderer.clearExportSize();
    appState.renderer.syncSize(appState.store.project.resolution);
    const sorted = [...per].sort((a, b) => a - b);
    return {
      frames: per.length,
      totalMs: Math.round(per.reduce((s, v) => s + v, 0)),
      medianMs: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 10) / 10,
      maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    };
  },
  /** E2E 专用：跑一遍真实导出管线并把 zip 解开——大像素数据不出 page。 */
  exportFrames: async () => {
    const blob = (await runExport(appState.renderer, appState.store.project, {
      sink: new PngSequenceSink(),
    })) as Blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    const files = unzipSync(buf);
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Array.from(v)]));
  },
  /**
   * E2E 专用：跑一遍真实的 MP4 导出管线，**只回传标量摘要**。
   *
   * 为什么不给字节：MP4 是二进制大对象，`Array.from` 一遍就是几 MB 的
   * JSON 传输，E2E 会被撑爆。要验的内容（大小、ftyp/moov 魔数、是否含音轨）
   * 在 page 内判完，只回传结论。需要原始字节的断言走真实下载路径。
   */
  exportMp4Probe: async (
    opts: {
      /** 强制某一档 codec（E2E 用；不给就按尺寸走阶梯）。 */
      codec?: string;
      hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    } = {},
  ) => {
    const project = appState.store.project;
    const choice =
      opts.codec !== undefined
        ? { codec: opts.codec }
        : await probeMp4Codec({
            w: project.resolution.w,
            h: project.resolution.h,
            fps: project.fps,
            ...(opts.hardwareAcceleration ? { hardwareAcceleration: opts.hardwareAcceleration } : {}),
          });
    if (!choice) {
      // 四档全不支持：把「编不了」与「没编出东西」分开，E2E 能直接判 code。
      return {
        bytes: 0,
        codec: null,
        avcProfile: null,
        decodable: false,
        ftyp: '',
        hasMoov: false,
        hasAudio: false,
        hasVideo: false,
        audioPeak: null,
      };
    }
    // 视频内嵌音轨是异步解码的：与 ui/export.ts 同一条预热路径。
    await prepareProjectVideoAudio(project, (id, buf) => appState.player.register(id, buf));
    const audio = mixdown(project, (id) => appState.player.buffer(id));
    const blob = (await runExport(appState.renderer, project, {
      sink: new Mp4Sink({
        audio,
        ...(opts.hardwareAcceleration ? { hardwareAcceleration: opts.hardwareAcceleration } : {}),
      }),
      codec: choice.codec,
    })) as Blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    // latin1 逐字节转字符串，只在 page 内做一次，用来搜 box 名。
    let latin = '';
    for (let i = 0; i < buf.length; i++) latin += String.fromCharCode(buf[i]);

    /*
     * avcC 的布局：`[size(4)][type 'avcC'(4)][configurationVersion(1)]
     * [AVCProfileIndication(1)][profile_compat(1)][level(1)]…`
     * 所以 profile 字节在 `indexOf('avcC') + 5`：0x42 = Baseline，0x4d = Main。
     */
    const avcC = latin.indexOf('avcC');
    const avcProfile = avcC >= 0 ? (buf[avcC + 5] ?? null) : null;

    // 能被解码器读回才算真的可用（「盒子对」不等于「能播」）。
    let decodable = false;
    if (avcC >= 4) {
      try {
        const boxSize = new DataView(buf.buffer, avcC - 4, 4).getUint32(0);
        // WebCodecs 的 description 要的是 AVCDecoderConfigurationRecord
        //（box 载荷），不含 4 字节长度与 'avcC' 类型。
        const description = buf.slice(avcC + 4, avcC - 4 + boxSize);
        const res = await VideoDecoder.isConfigSupported({
          codec: choice.codec,
          description,
          codedWidth: project.resolution.w,
          codedHeight: project.resolution.h,
        });
        decodable = res.supported === true;
      } catch {
        decodable = false;
      }
    }

    return {
      bytes: buf.length,
      codec: choice.codec,
      avcProfile,
      decodable,
      ftyp: latin.slice(4, 8),
      hasMoov: latin.includes('moov'),
      hasAudio: latin.includes('mp4a') || latin.includes('soun'),
      hasVideo: latin.includes('avc1') || latin.includes('vide'),
      audioPeak: audio ? audio.peak : null,
    };
  },
  algo: { listGenerators, defaultParams },
  /**
   * 彩蛋的 E2E 读数：捏了几次、最近一次是不是已经坏成噪音。
   *
   * Web Audio 的**输出**在 Playwright 里读不到（没有可靠的取音路径），
   * 能证实的是「点击真的走到了合成器，并且每次的计划都不同 / 越点越坏」。
   */
  mascotStats,
  /**
   * E2E 专用：直接调排版光栅化，**不经过 compositor / GPU**。
   *
   * 这样测的是「光栅化本身确定不确定」，而不是「整条 GPU 链路确定不确定」——
   * 后者是 AGENTS §7 记录在案的 flaky 区（echo/glitch 的边界采样竞态，
   * 60–75% 失败率，与代码版本无关）。P7 验证「子集字体 vs 全量字体逐像素
   * 零差异」也走这个入口。
   */
  typoRasterize: async (doc: unknown, w: number, h: number, localSec: number) => {
    const canvas = await appState.textRaster.rasterizeOnce(
      doc as Parameters<typeof appState.textRaster.rasterizeOnce>[0],
      w,
      h,
      localSec,
    );
    const ctx = canvas.getContext('2d')!;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 只回传标量：像素留在 page 内。
    let sum = 0;
    let ink = 0;
    let h32 = 0x811c9dc5;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]!;
      if (a > 8) ink += 1;
      sum += px[i]! + px[i + 1]! + px[i + 2]!;
      h32 = (Math.imul(h32 ^ px[i]!, 0x01000193) ^ a) >>> 0;
    }
    return { w: canvas.width, h: canvas.height, ink, sum, hash: h32.toString(16).padStart(8, '0') };
  },
  typoStats: () => appState.textRaster.stats(),
  /**
   * E2E 专用：从字节注册一个字体（本机系统字体不进仓库，测试从 Node 侧读盘传进来）。
   */
  typoRegisterFont: async (name: string, bytes: Uint8Array | number[]) => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const face = await appState.fonts.registerFile(name, u8.buffer as ArrayBuffer);
    appState.refreshFontFamilies();
    return face.id;
  },
  typoFontStats: () => ({
    ...appState.fonts.subsetStats,
    faces: appState.fonts.faceReports(),
  }),
  /** ADR-003 规则 ① 的对照组开关：关掉子集化后光栅化必须**逐像素相同**。 */
  typoSetSubsetting: (on: boolean) => {
    appState.fonts.subsetting = on;
    appState.fonts.invalidatePrepared();
  },
};

export default app;
