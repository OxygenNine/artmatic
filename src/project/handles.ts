/**
 * handles.ts — 工程目录句柄的持久化。
 *
 * 文件系统句柄是 **structured-cloneable** 的，所以能直接存进 IndexedDB，
 * 下次访问取出来接着用 —— 用户不必每次重新选目录。这是 Web 端 IDE
 * （VS Code for the Web 就是这么干的）的标准做法。
 *
 * ## 句柄能存，权限不一定跟着
 *
 * 句柄本身跨会话保留，**权限可能降级**：新会话里 `queryPermission()` 返回
 * `'prompt'` 是常态，要 `requestPermission()` 一次（且那一下必须有用户手势）。
 * 所以「打开最近工程」这个动作天然只能由点击触发，不能在页面加载时自动完成。
 *
 * Chromium 122 起有三向提示「每次访问时都允许」，用户选过之后就不再问了；
 * 装成 PWA 的站点权限自动保持，完全不问。这两条都不需要我们做任何事。
 *
 * ## 这里存的东西是可丢弃的
 *
 * AGENTS §1.7：真相只在磁盘。句柄丢了最多是「用户要重新选一次目录」，
 * 工程内容一个字节都不会少。所以这里所有失败都是**降级**而不是致命错误：
 * IndexedDB 打不开就当作没有最近工程，绝不因为存储层的问题挡住用户保存。
 */

const DB_NAME = 'artmatic';
/*
 * v2 加了 `covers`（最近工程的封面图）。
 *
 * ⚠️ 版本号是**整个库**的属性：任何地方再用 `indexedDB.open(DB_NAME, 1)` 都会拿到
 * `VersionError`。所以封面必须跟句柄共用这一个模块 —— 另开一个 DB 会让两套
 * 升级逻辑各管一半，而漏掉的那一半表现为「最近工程永远没有缩略图」。
 */
const DB_VERSION = 2;
const STORE = 'dirHandles';
const COVERS = 'covers';
const RECENT_KEY = 'artmatic.recentProjects';
/**
 * 最近工程列表上限。
 *
 * 8 是「一列行」时代的口径。首页改成「三张封面卡 + 若干行」之后，8 条里
 * 有 3 条被卡片占走、4 条铺在列表里，「查看全部」永远没有可展开的东西 ——
 * 一个恒为空的入口比没有入口更糟。12 条时它才真的在「还有下一屏」。
 */
const MAX_RECENT = 12;

export interface ProjectRef {
  /** IndexedDB 里的句柄键。 */
  key: string;
  /**
   * **工程名**（`project.json` 的 `name`），展示用。
   *
   * 不是目录名：工程可以叫「黑洞视界 v2」而目录是随手起的 `untitled-3`。
   * 目录名另存 `dirName`。老条目（这一版之前记下的）里存的是目录名 ——
   * 下次打开或保存那份工程时会被真名覆盖（见 `adoptRecentNames`）。
   */
  name: string;
  /** 目录名（只有「在文件管理器中定位 / 调试」用得上）。 */
  dirName?: string;
  /**
   * 工程目录的**本机绝对路径**（只有桌面壳的路径句柄给得出）。
   *
   * 有它才能「在资源管理器里打开」和「把目录删掉」—— FSA 的目录句柄是不透明
   * 引用，那两件事在浏览器里永远做不到（见 `project/path-dir.ts`）。
   */
  path?: string;
  /** 最近一次打开/保存的时间（毫秒）。 */
  openedAt: number;
  /** 上次已知的素材数量，纯展示。 */
  assetCount?: number;
}

/* ------------------------------------------------------------ IndexedDB */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('此环境没有 IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
  });
}

/** 句柄入库。失败返回 false，不抛 —— 见文件头「可丢弃」那段。 */
export async function putHandle(key: string, handle: unknown): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    await txDone(tx);
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function getHandle(key: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    const value = await new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

export async function deleteHandle(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await txDone(tx);
    db.close();
  } catch {
    /* 删不掉就留着，不影响任何东西 */
  }
}

/* ------------------------------------------------------------ 封面 */

/**
 * 最近工程列表上那张缩略图。
 *
 * 为什么**不读工程目录里的 `thumbs/cover.png`**：读它要先 `openFile`，而新会话里
 * 句柄权限是降级的（`prompt`），拿缩略图不该触发一次系统授权弹窗 —— 那张图只是
 * 首页上的一格装饰。所以磁盘那份（可移植、跟工程走）与这份缓存（首页直接用）
 * 是**两件事**：保存时两边都写，打开工程时如果缓存空着就从磁盘补一次
 * （那一刻权限刚好是有效的，见 `adoptCoverFromDir`）。
 */
export async function putCover(key: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(COVERS, 'readwrite');
    tx.objectStore(COVERS).put(blob, key);
    await txDone(tx);
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function getCover(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(COVERS, 'readonly');
    const req = tx.objectStore(COVERS).get(key);
    const value = await new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    return value instanceof Blob ? value : null;
  } catch {
    return null;
  }
}

export async function deleteCover(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(COVERS, 'readwrite');
    tx.objectStore(COVERS).delete(key);
    await txDone(tx);
    db.close();
  } catch {
    /* 同上：删不掉只是多占一点 IndexedDB，不值得报错 */
  }
}

/* ------------------------------------------------------------ 最近工程 */

export function listRecentProjects(): ProjectRef[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r): r is ProjectRef => !!r && typeof r === 'object' && typeof (r as ProjectRef).key === 'string')
      .sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

function writeRecents(list: ProjectRef[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* 存不下不影响本次会话 */
  }
}

/** 记一条最近工程（同 key 覆盖并提到最前），返回更新后的列表。 */
export function rememberProject(ref: ProjectRef): ProjectRef[] {
  const rest = listRecentProjects().filter((r) => r.key !== ref.key);
  const next = [{ ...ref }, ...rest].slice(0, MAX_RECENT);
  writeRecents(next);
  // 被挤出去的条目，句柄与封面也一起清掉，免得 IndexedDB 无限增长。
  for (const gone of rest.slice(MAX_RECENT - 1)) {
    void deleteHandle(gone.key);
    void deleteCover(gone.key);
  }
  return next;
}

/**
 * 就地改某条最近工程的展示字段，**不改变它在这一列里的位置**。
 *
 * 与 `rememberProject` 的分工：那个是「刚打开 / 保存过」，要把条目提到最前；
 * 这个只改内容（老条目补上 `project.json` 里的真名时用），位置不动。
 */
export function renameRecent(key: string, patch: Partial<Omit<ProjectRef, 'key'>>): ProjectRef[] {
  const next = listRecentProjects().map((r) => (r.key === key ? { ...r, ...patch } : r));
  writeRecents(next);
  return next;
}

export function forgetProject(key: string): ProjectRef[] {
  const next = listRecentProjects().filter((r) => r.key !== key);
  writeRecents(next);
  void deleteHandle(key);
  void deleteCover(key);
  return next;
}

/**
 * 给一个目录句柄找一个稳定的 key。
 *
 * 用目录名当 key 是不够的（两个都叫 `untitled` 的目录会互相覆盖），
 * 而**拿不到绝对路径**（File System Access 的安全设计，句柄是不透明引用），
 * 所以用 `isSameEntry()` 和已存的句柄逐个比对：命中就复用那条 key。
 *
 * 这是唯一能在「没有路径」的前提下区分同名目录的办法。
 * `isSameEntry` 不可用时退化成按名字匹配 —— 行为仍然正确，只是同名目录会串。
 */
export async function keyForHandle(handle: unknown, name: string): Promise<string> {
  const refs = listRecentProjects();
  const isSame = (handle as { isSameEntry?: (o: unknown) => Promise<boolean> } | null)?.isSameEntry;
  if (isSame) {
    for (const ref of refs) {
      const stored = await getHandle(ref.key);
      if (!stored) continue;
      try {
        if (await isSame.call(handle, stored)) return ref.key;
      } catch {
        /* 句柄失效（目录被删/移动）就跳过 */
      }
    }
  }
  return `dir:${name}`;
}
