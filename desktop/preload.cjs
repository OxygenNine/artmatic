/**
 * desktop/preload.cjs — 桌面宿主暴露给页面的**唯一**入口。
 *
 * 页面拿不到 `fs` / `path` / `process`：只有这几个白名单方法。
 * 主进程侧每个方法都有 allowlist（只有用户亲手选过的文件才可读），
 * 协议也不认任意路径 —— 只认 token。
 *
 * 沙箱模式（`sandbox: true`）下 preload 只能用 `require('electron')`，
 * 这是刻意的：多一个 Node 模块就多一个「页面能间接碰到 fs」的口子。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 只有冒烟模式才暴露测试入口；正常启动时页面上不存在这两个键。 */
const SMOKE = process.argv.includes('--artmatic-smoke')

const api = {
  /** 原生文件选择器：返回路径 + stat，不读字节。 */
  pickLinked: (kind) => ipcRenderer.invoke('artmatic:pickLinked', kind),
  /** 小文件整份读（图片 / 音频）。 */
  readFile: (path) => ipcRenderer.invoke('artmatic:readFile', path),
  /** 大文件按范围读（视频解码 / 指纹）。 */
  readRange: (path, start, end) =>
    ipcRenderer.invoke('artmatic:readRange', path, start, end),
  stat: (path) => ipcRenderer.invoke('artmatic:stat', path),
  /**
   * 拖入的 File → 真实路径（Electron 32 起 `File.path` 已删除）。
   *
   * **授权也在这里**：`webUtils.getPathForFile` 只对用户拖入 / 选中的真实 File
   * 返回路径，所以它等价于一次明确的用户选择，可以同步登记进主进程 allowlist。
   * 不把 `allowPath` 单独暴露给页面 —— 那等于把「任意路径读取」的开关交给渲染层。
   */
  pathForFile: (file) => {
    try {
      const p = webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : ''
      if (p) ipcRenderer.sendSync('artmatic:allowPath-sync', p)
      return p || null
    } catch {
      return null
    }
  },
  /** 工程包选择（`.artmatic`）。 */
  pickArchive: () => ipcRenderer.invoke('artmatic:pickArchive'),
  /** 监视一组本机文件（源文件变化 → 只有 stale 提示，不自动换内容）。 */
  watch: (paths) => ipcRenderer.invoke('artmatic:watch', paths),
  unwatch: () => ipcRenderer.invoke('artmatic:unwatch'),
  onAssetChanged: (cb) => {
    const fn = (_e, p) => cb(p)
    ipcRenderer.on('artmatic:asset-changed', fn)
    return () => ipcRenderer.removeListener('artmatic:asset-changed', fn)
  },
  showInFolder: (path) => ipcRenderer.invoke('artmatic:showInFolder', path),
  /**
   * 本机路径文件系统 —— 桌面版的工程目录就是一条路径（见 `platform/types.ts`
   * 的 `NodeFs` 与 `project/path-dir.ts`）。主进程侧只认「用户亲手选过的根」。
   *
   * `sep` 是常量：拼子路径在 list/遍历里会调用很多次，不值得每次都过一趟 IPC。
   */
  fs: {
    sep: process.platform === 'win32' ? '\\' : '/',
    pickProjectDir: () => ipcRenderer.invoke('artmatic:pickProjectDir'),
    list: (dir) => ipcRenderer.invoke('artmatic:fsList', dir),
    read: (file, start, end) => ipcRenderer.invoke('artmatic:fsRead', file, start, end),
    stat: (p) => ipcRenderer.invoke('artmatic:fsStat', p),
    mkdir: (dir) => ipcRenderer.invoke('artmatic:fsMkdir', dir),
    remove: (p, recursive) => ipcRenderer.invoke('artmatic:fsRemove', p, recursive),
    writeBegin: (file) => ipcRenderer.invoke('artmatic:fsWriteBegin', file),
    writeChunk: (id, bytes) => ipcRenderer.invoke('artmatic:fsWriteChunk', id, bytes),
    writeEnd: (id) => ipcRenderer.invoke('artmatic:fsWriteEnd', id),
    writeAbort: (id) => ipcRenderer.invoke('artmatic:fsWriteAbort', id),
    reveal: (p) => ipcRenderer.invoke('artmatic:fsReveal', p),
  },
  /** 机器能力（内存 / 显存）。`app://` 下没有 `/__capacity.json`，只能由主进程量。 */
  capacity: () => ipcRenderer.invoke('artmatic:capacity'),
  /**
   * 窗口级动作。应用菜单被关掉之后，开发者工具 / 重新加载 / 退出只剩设置面板
   * 这一个入口（界面靠这个键在不在，决定要不要显示「桌面」那一页）。
   *
   * 全部单向 `send`：没有返回值，失败只会在主进程侧打一行日志 —— 这三件事
   * 没有「可以补救」的失败形态。
   */
  shell: {
    setTitleBarOverlay: (chrome) => ipcRenderer.send('artmatic:titleBarOverlay', chrome),
    toggleDevTools: () => ipcRenderer.send('artmatic:toggleDevTools'),
    reload: () => ipcRenderer.send('artmatic:reload'),
    quit: () => ipcRenderer.send('artmatic:quit'),
    /** 站外链接交给系统浏览器（主进程只放行 http/https）。 */
    openExternal: (url) => ipcRenderer.send('artmatic:openExternal', url),
  },
}

if (SMOKE) {
  api.__smokeAllow = (path) => ipcRenderer.invoke('artmatic:smokeAllow', path)
  api.__smokeUrl = (path) => ipcRenderer.invoke('artmatic:smokeUrl', path)
  /** 把一个临时目录加进「工程根」允许集合（原生选择器驱动不了，只能开后门）。 */
  api.__smokeAllowDir = (path) => ipcRenderer.invoke('artmatic:smokeAllowDir', path)
}

contextBridge.exposeInMainWorld('artmaticHost', api)
