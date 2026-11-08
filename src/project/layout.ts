/**
 * layout.ts — 工程目录格式。
 *
 * ```
 * <工程目录>/
 * ├── project.json        工程本体（§5 的 Project），真相的唯一载体
 * ├── project.json.bak    上一版成功保存的副本（writeProject 自动维护）
 * ├── assets.json         素材台账（引用路径 + 内容哈希 + 原始文件名）
 * ├── session.json        会话状态（播放头 / 选中 / 视图；可丢弃，不算工程内容）
 * ├── assets/             素材字节（只有 bundled / generated 两种模式）
 * ├── analysis/           可重算的离线分析缓存（音频波形 / BPM / 拍网格）
 * └── thumbs/             缩略图缓存（可丢弃，删了只是重新生成）
 * ```
 *
 * **本文件是纯函数，不许 import DOM / WebGL / store。** 路径规则一旦
 * 掺进副作用就没法单测了，而路径拼错的表现是「保存成功但下次打开找不到素材」
 * ——那种 bug 在 UI 上完全看不出来。
 *
 * 路径一律按**段数组**处理，不在内部拼字符串再拆。理由：File System Access
 * 的 `getDirectoryHandle/getFileHandle` 逐级取名字，而 `name` 里不允许出现
 * 分隔符；拿 'a/b' 去 getFileHandle 一定失败。相对路径字符串只用于
 * 台账记录与展示（`assetRelPath`）。
 */

/**
 * 目录格式自身的版本，与 `Project.schemaVersion` 独立。
 *
 * v2：台账条目多了 `retained`（已从工程移除、但字节文件保留）。
 * v3（linked 素材）：条目从「一条 path + 一个 hash」变成
 * `content = {size, fp}` + `locations[] = project | local`。旧台账由
 * `parseLedger` 归一化（`path` → project 位置、`hash` 无法换算成采样指纹
 * 所以置 null，打开时补算）。
 */
export const LAYOUT_VERSION = 3;

export const PROJECT_FILE = 'project.json';
export const PROJECT_BACKUP = 'project.json.bak';
export const ASSET_LEDGER_FILE = 'assets.json';
/**
 * 会话状态（播放头 / 选中集 / 停在哪个视图）。
 *
 * **不是工程内容**：它不进 `project.json`，也不参与「有没有未保存改动」的判定
 * （见 `ui/project-session.ts` 与 `core/project-store.ts` 的 `docVersion`）。
 * 留在这里是为了「下次打开直接回到上次的工作位置」——丢了只影响便利性。
 */
export const SESSION_FILE = 'session.json';

export const ASSETS_DIR = 'assets';
/** 素材回收站：清理未使用素材时移到这里，宁可多占一份磁盘也不直接销毁。 */
export const ASSET_TRASH_DIR = '.trash';
export const ANALYSIS_DIR = 'analysis';
export const AUDIO_ANALYSIS_DIR = 'audio';
export const THUMBS_DIR = 'thumbs';

/**
 * 插件目录。
 *
 * 插件文件是**可执行的 JS**，放进工程目录意味着「工程可以带着自己的扩展走」——
 * 拷贝整个工程目录到另一台机器，打开时插件照旧挂载（见 AGENTS 的工程级插件决策）。
 *
 * ⚠️ 它是**工程真相**的一部分，不是缓存：删掉它就等于卸载插件，
 * 工程里引用了那些 id 的片段会退化成「缺失插件」。所以它**不在**可丢弃清单里
 * （对比 `thumbs/` 与 `analysis/`）。
 */
export const PLUGINS_DIR = 'plugins';

/**
 * Agent 对话历史目录。
 *
 * `agent/sessions/<id>.json`：**一个会话一个文件**。
 *
 * ⚠️ 它是**工程数据**（用户会想跟着工程目录一起拷走），但不是 `project.json`
 * 的一部分 —— 聊天记录曾经挂在 Project 上，代价是「聊一句 = 原子重写整份工程」，
 * 而且撤销栈要专门剔除它。一个文件一个会话之后：一轮对话只写自己那一个文件，
 * 删会话是 unlink，坏文件只丢一条会话。
 *
 * `agent/` 与 `plugins/` 同属「工程自带的东西」，所以**不在**可丢弃清单里
 * （对比 `thumbs/` 与 `analysis/`）。
 */
export const AGENT_DIR = 'agent';
export const AGENT_SESSIONS_DIR = 'sessions';

/** 打开/新建工程时要确保存在的目录（按层级顺序）。 */
export const PROJECT_DIRS: readonly (readonly string[])[] = [
  [ASSETS_DIR],
  [ANALYSIS_DIR],
  [ANALYSIS_DIR, AUDIO_ANALYSIS_DIR],
  [THUMBS_DIR],
  [PLUGINS_DIR],
  [AGENT_DIR, AGENT_SESSIONS_DIR],
];

/* ------------------------------------------------------------ 名字清洗 */

/**
 * 单段名字的最大长度。Windows 单段上限 255 字节，留足余量；
 * 超长名字在部分文件系统上会被静默截断或直接报错，宁可我们自己截。
 */
const MAX_SEGMENT = 96;

/**
 * 从用户给的原始文件名里取一个**安全的**扩展名（含点，小写）。
 *
 * 拒绝的几种情况都写在这里，因为它们的后果是「写进 assets/ 的文件名
 * 带着路径分隔符或 `..`」—— 那是目录穿越，不是命名风格问题：
 *  - 先取 basename，丢掉用户文件里可能带的任何目录部分
 *  - `dot <= 0` 同时排除「没有扩展名」与「.gitignore 这种点开头的名字」
 *  - 扩展名只允许 `[a-z0-9]`，长度 1–8；`tar.gz` 只取 `gz`（够用了）
 */
export function safeExt(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return '';
  return `.${ext}`;
}

/** 去掉原始文件名里的目录部分，只留文件名本身（展示与台账记录用）。 */
export function baseName(name: string): string {
  return String(name ?? '').split(/[\\/]/).pop() ?? '';
}

/**
 * 把 assetId 清洗成可安全用作文件名的形式。
 *
 * 正常路径下 assetId 是 uuid，本来就是 `[0-9a-f-]`，清洗是空操作。
 * 但 assetId 会进 JSON、会被手改、也可能来自将来某个别的生成器，
 * 所以落盘前必须过一遍。
 *
 * ⚠️ 清洗**可能产生碰撞**（`a/b` 与 `a:b` 都变成 `ab`）。调用方
 * （`ledger.ts` 的 `detectPathConflicts`）负责检出并报错，这里不静默去重
 * ——去重会让两个素材共用一个文件，症状是「换了素材但画面没变」。
 */
export function safeAssetId(id: string, fallback = 'asset'): string {
  const s = String(id ?? '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, MAX_SEGMENT);
  return s || fallback;
}

/* ------------------------------------------------------------ 路径推导 */

/** 素材在 `assets/` 下的段数组。 */
export function assetPathSegments(assetId: string, originName: string): string[] {
  return [ASSETS_DIR, safeAssetId(assetId) + safeExt(originName)];
}

/** 素材相对工程根的路径，用于台账记录与 UI 展示。POSIX 分隔符。 */
export function assetRelPath(assetId: string, originName: string): string {
  return assetPathSegments(assetId, originName).join('/');
}

/**
 * 回收站里放一个素材文件时的段数组。
 *
 * 文件名带时间戳：同一个素材被清理两次时不能互相覆盖 —— 第一次进回收站的
 * 那一份才是用户可能想找回的。`stamp` 由调用方给（纯函数不读时钟）。
 */
export function trashPathSegments(assetId: string, originName: string, stamp: number): string[] {
  const base = safeAssetId(assetId);
  const suffix = stamp > 0 ? `-${stamp}` : '';
  return [ASSETS_DIR, ASSET_TRASH_DIR, `${base}${suffix}${safeExt(originName)}`];
}

/** 该相对路径是不是在回收站里。`listAssetPaths` 只列直接子文件，所以这是第二道判定。 */
export function isTrashPath(rel: string): boolean {
  const segs = splitRelPath(rel);
  return segs[0] === ASSETS_DIR && segs[1] === ASSET_TRASH_DIR;
}

/** 插件文件扩展名。清单是 ESM，所以宿主按模块导入它。 */
export const PLUGIN_EXT = '.js';

/**
 * 插件 id → 可安全用作文件名的形式。
 *
 * 直接复用 `safeAssetId` 的清洗规则（只留 `[A-Za-z0-9._-]`、截断到 96）——
 * 两条路径最后都进同一层文件系统，规则分开写就会出现「素材能过、插件不能过」
 * 这种不对称。插件 id 本身在清单校验时已被限制成 `[a-z0-9._-]`，这里是兜底。
 */
export function safePluginId(id: string, fallback = 'plugin'): string {
  return safeAssetId(id, fallback);
}

/** 插件文件在 `plugins/` 下的段数组。 */
export function pluginPathSegments(pluginId: string): string[] {
  return [PLUGINS_DIR, safePluginId(pluginId) + PLUGIN_EXT];
}

/** 插件文件相对工程根的路径，用于展示与诊断。POSIX 分隔符。 */
export function pluginRelPath(pluginId: string): string {
  return pluginPathSegments(pluginId).join('/');
}

/** 插件 id 在 `plugins/` 里的文件名（含扩展名）。 */
export function pluginFileName(pluginId: string): string {
  return safePluginId(pluginId) + PLUGIN_EXT;
}

/**
 * Agent 会话文件在 `agent/sessions/` 下的段数组。
 *
 * 文件名清洗复用 `safeAssetId`（只留 `[A-Za-z0-9._-]`、截断到 96）：会话 id 是
 * 我们生成的 uuid，清洗是空操作；但它会从 URL / 手改的文件名进来，落盘前必须过一遍。
 */
export function agentSessionSegments(sessionId: string): string[] {
  return [AGENT_DIR, AGENT_SESSIONS_DIR, `${safeAssetId(sessionId, 'session')}.json`];
}

/** 音频分析缓存在 `analysis/audio/` 下的段数组。 */
export function audioAnalysisSegments(assetId: string): string[] {
  return [ANALYSIS_DIR, AUDIO_ANALYSIS_DIR, `${safeAssetId(assetId)}.json`];
}

/** 缩略图在 `thumbs/` 下的段数组。key 通常是片段 id。 */
export function thumbSegments(key: string): string[] {
  return [THUMBS_DIR, `${safeAssetId(key, 'thumb')}.png`];
}

/**
 * 工程封面（首页「最近的工程」那张图）的文件名。
 *
 * 与 `thumbSegments` 分开命名是刻意的：那些是**按片段 id** 存的、按 PNG 走；
 * 封面只有一张，而且是 WebP（与 `src/assets/` 里的资源同一套口径）。
 * 覆盖同一个 `cover` 而不是按时间戳堆文件 —— 封面是「现在长什么样」，旧的没有价值。
 */
export const COVER_THUMB = 'cover.webp';

/** 封面在 `thumbs/` 下的段数组。 */
export function coverThumbSegments(): string[] {
  return [THUMBS_DIR, COVER_THUMB];
}

/** 拆相对路径串为段数组。只认 `/`，`..` 与空段直接丢掉（不接受上跳）。 */
export function splitRelPath(rel: string): string[] {
  return String(rel ?? '')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..');
}

/* ------------------------------------------------------------ 判定 */

/** 该名字是不是本格式的工程目录标志文件。 */
export function isProjectFile(name: string): boolean {
  return name === PROJECT_FILE;
}

/**
 * 备份文件要不要参与「这是什么目录」的判定：不要。
 * 一个只有 .bak 的目录不是一个可打开的工程。
 */
export function isBackupFile(name: string): boolean {
  return name === PROJECT_BACKUP;
}
