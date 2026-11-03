/**
 * desktop/host.mjs — Electron 主进程侧的宿主能力。
 *
 * 三块：
 *   1. `artmatic-asset://` 协议：按 Range 返回本机文件（视频 seek 靠它），
 *      只认注册过的 token，不认任意路径。
 *   2. IPC：原生选择器、按范围读、stat、监视、在文件管理器中显示。
 *   3. 窗口级动作：窗口按钮配色、开发者工具、重新加载、退出
 *      —— 应用菜单关掉之后，这几件事没有别的入口。
 *
 * 安全边界贯穿全部：所有路径先过 allowlist（用户亲手选过的文件），页面拿不到 fs，
 * 也拿不到 BrowserWindow。
 *
 * 这个文件是**产品代码**：`main.mjs` 在 app ready 后安装它，
 * `preload.cjs` 只暴露白名单方法。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

/**
 * 窗口按钮那块 overlay 的高度**初值**。
 *
 * 真源是 `ui/tokens.ts` 的 `DENSITY.topbarH`（顶栏高度），渲染层挂载后按
 * `--topbar-h` 算好再回传一次 —— 这里只是首帧用一下，两边不一致会自愈。
 */
export const TITLEBAR_H = 30

/** 与 `app` 同一个 `registerSchemesAsPrivileged` 调用里注册。 */
export const ASSET_SCHEME = {
  scheme: 'artmatic-asset',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    // 自定义 scheme 默认不一定参与 CORS；显式打开，`app://` 才能 fetch 它。
    corsEnabled: true,
  },
}

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.artmatic': 'application/zip',
}

const FILTERS = {
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
}

const trim = (p) => path.resolve(String(p))

export function installHost({ app, protocol, ipcMain, dialog, shell }) {
  /** 用户亲手选过 / 明确允许的文件。**没有这个集合就什么都不给读。** */
  const allowed = new Set()
  /** token → 绝对路径。协议只认这里。 */
  const tokens = new Map()

  const allow = (p) => {
    const abs = trim(p)
    allowed.add(abs)
    return abs
  }

  /*
   * 工程目录（本机路径）的根。桌面版的工程位置就是**一条绝对路径**（渲染层把它
   * 包成 FsDirHandle，见 `src/project/path-dir.ts`）—— FSA 的目录句柄是不透明
   * 引用，拿不到路径就做不到「在资源管理器里打开」「真的删掉目录」，而这两件事
   * 在 Node 侧各是一行。
   *
   * 根只能由原生选择器加入（`pickProjectDir`），页面不能自己声明。根之下的
   * 文件与一次性允许的文件走同一个判据（`permitted`），所以按范围读视频、
   * 监视素材变化这些既有能力对工程目录同样成立。
   */
  const projectRoots = new Set()
  const withinRoots = (p) => {
    const abs = trim(p)
    for (const root of projectRoots) {
      if (abs === root) return true
      if (abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
    }
    return false
  }
  const guard = (p) => {
    const abs = trim(p)
    if (!withinRoots(abs)) throw new Error('path not allowed')
    return abs
  }

  const permitted = (p) => allowed.has(trim(p)) || withinRoots(p)

  const tokenFor = (abs) => {
    const token = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 24)
    tokens.set(token, abs)
    return token
  }
  const urlFor = (abs) => `artmatic-asset://asset/${tokenFor(abs)}`

  protocol.handle('artmatic-asset', async (req) => {
    try {
      const url = new URL(req.url)
      if (url.hostname !== 'asset') return new Response('bad host', { status: 400 })
      const abs = tokens.get(url.pathname.replace(/^\//, ''))
      if (!abs) return new Response('unknown asset', { status: 404 })

      const st = await fsp.stat(abs).catch(() => null)
      if (!st?.isFile()) return new Response('not found', { status: 404 })

      const headers = {
        'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        // app:// 与 artmatic-asset:// 是两个 origin；视频 fetch 需要这两条。
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'content-range, content-length',
      }
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...headers,
            'access-control-allow-headers': 'range',
            'access-control-allow-methods': 'GET,HEAD,OPTIONS',
          },
        })
      }

      const range = req.headers.get('range')
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (!m) return new Response('bad range', { status: 416 })
        const start = m[1] ? Number(m[1]) : 0
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
        if (!Number.isFinite(start) || start >= st.size || end < start) {
          return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${st.size}` },
          })
        }
        // Node 的 `createReadStream` 的 `end` 是**包含**的（与 HTTP Range 一致）。
        return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), {
          status: 206,
          headers: {
            ...headers,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${st.size}`,
          },
        })
      }

      if (req.method === 'HEAD') {
        return new Response(null, { headers: { ...headers, 'content-length': String(st.size) } })
      }
      return new Response(Readable.toWeb(fs.createReadStream(abs)), {
        headers: { ...headers, 'content-length': String(st.size) },
      })
    } catch (e) {
      console.error('[asset] handler failed', e)
      return new Response('handler error', { status: 500 })
    }
  })

  ipcMain.handle('artmatic:pickLinked', async (_e, kind) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: FILTERS[kind] ?? FILTERS.video,
    })
    if (canceled || !filePaths[0]) return null
    const abs = allow(filePaths[0])
    const st = await fsp.stat(abs)
    return { path: abs, name: path.basename(abs), size: st.size, mtime: st.mtimeMs }
  })

  ipcMain.handle('artmatic:pickArchive', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Artmatic package', extensions: ['artmatic'] }],
    })
    if (canceled || !filePaths[0]) return null
    const abs = allow(filePaths[0])
    const st = await fsp.stat(abs)
    return { path: abs, name: path.basename(abs), size: st.size }
  })

  /**
   * 拖拽入口的授权：路径来自 preload 的 `webUtils.getPathForFile`（用户刚把文件
   * 拖进来），与原生选择器是同一种「用户明确选择」。
   *
   * 用同步 IPC 的唯一理由：必须在 preload 返回路径**之前**完成登记，否则紧随
   * 其后的 `readRange` 会以「path not allowed」失败。它不暴露给页面。
   */
  ipcMain.on('artmatic:allowPath-sync', (e, p) => {
    if (typeof p === 'string' && p) allow(p)
    e.returnValue = true
  })

  ipcMain.handle('artmatic:readFile', async (_e, p) => {
    if (!permitted(p)) throw new Error('path not allowed')
    return new Uint8Array(await fsp.readFile(trim(p)))
  })

  ipcMain.handle('artmatic:stat', async (_e, p) => {
    if (!permitted(p)) return null
    const st = await fsp.stat(trim(p)).catch(() => null)
    return st?.isFile() ? { size: st.size, mtime: st.mtimeMs } : null
  })

  ipcMain.handle('artmatic:readRange', async (_e, p, start, end) => {
    if (!permitted(p)) throw new Error('path not allowed')
    const abs = trim(p)
    const st = await fsp.stat(abs)
    const s = Math.max(0, Math.floor(Number(start) || 0))
    const e = Math.min(st.size, Math.max(s, Math.floor(Number(end) || 0)))
    if (e <= s) return new Uint8Array(0)
    const fh = await fsp.open(abs, 'r')
    try {
      const buf = Buffer.alloc(e - s)
      await fh.read(buf, 0, buf.length, s)
      return new Uint8Array(buf)
    } finally {
      await fh.close()
    }
  })

  ipcMain.handle('artmatic:showInFolder', (_e, p) => {
    if (permitted(p)) shell.showItemInFolder(trim(p))
  })

  /**
   * 站外链接交给系统浏览器。
   *
   * 只放行 http/https：`file:` 能拉起本地程序，`app:` 会绕回应用自己的协议栈 ——
   * 页面里能触发这条的只有首页那几个社交链接，没有第二种用途。
   */
  ipcMain.on('artmatic:openExternal', (_e, url) => {
    if (typeof url !== 'string') return
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void shell.openExternal(parsed.toString())
  })

  /* ------------------------------------------------ 工程目录（本机路径）
   *
   * 根的集合与 `withinRoots` / `guard` 在文件开头（`permitted` 要用它们）。
   * 这里只放 IPC：一个目录选择器、一组读写、以及两件 FSA 做不到的事
   * （`fsRemove` 删根自己、`fsReveal` 在资源管理器里打开）。
   */
  ipcMain.handle('artmatic:pickProjectDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths[0]) return null
    const abs = trim(filePaths[0])
    projectRoots.add(abs)
    return abs
  })

  ipcMain.handle('artmatic:fsList', async (_e, dir) => {
    try {
      const entries = await fsp.readdir(guard(dir), { withFileTypes: true })
      return entries.map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }))
    } catch {
      return []
    }
  })

  ipcMain.handle('artmatic:fsRead', async (_e, file, start, end) => {
    const abs = guard(file)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st?.isFile()) return null
    const s = Math.max(0, Math.floor(Number(start) || 0))
    const e = Math.min(st.size, Math.max(s, Math.floor(Number(end) || 0)))
    if (e <= s) return new Uint8Array(0)
    const fh = await fsp.open(abs, 'r')
    try {
      const buf = Buffer.alloc(e - s)
      await fh.read(buf, 0, buf.length, s)
      return new Uint8Array(buf)
    } finally {
      await fh.close()
    }
  })

  ipcMain.handle('artmatic:fsStat', async (_e, p) => {
    if (!withinRoots(p)) return null
    const st = await fsp.stat(trim(p)).catch(() => null)
    if (!st) return null
    return { size: st.size, mtime: st.mtimeMs, kind: st.isDirectory() ? 'directory' : 'file' }
  })

  ipcMain.handle('artmatic:fsMkdir', async (_e, dir) => {
    await fsp.mkdir(guard(dir), { recursive: true })
  })

  ipcMain.handle('artmatic:fsRemove', async (_e, p, recursive) => {
    const abs = trim(p)
    if (!withinRoots(abs)) throw new Error('path not allowed')
    const st = await fsp.stat(abs).catch(() => null)
    if (!st) return
    if (!st.isDirectory()) {
      await fsp.rm(abs, { force: false })
      return
    }
    // 删根自己 = 删除工程：只认「目录里真有 project.json」的目录。
    if (projectRoots.has(abs)) {
      const isProject = await fsp
        .stat(path.join(abs, 'project.json'))
        .then((s) => s.isFile(), () => false)
      if (!isProject) throw new Error('not an artmatic project')
    } else if (!recursive) {
      const left = await fsp.readdir(abs)
      if (left.length) throw new Error('directory not empty')
    }
    /*
     * Windows 上递归删目录会偶尔抛 ENOTEMPTY / EBUSY：上一刻刚关掉的写入句柄、
     * 杀毒扫描、索引器都可能还压着某个文件。隔一拍重试一次 —— 一次真实的删除失败
     * 通常不是这种瞬时态，重试不会把它藏起来。
     */
    try {
      await fsp.rm(abs, { recursive: Boolean(recursive), force: false })
    } catch (e) {
      if (e?.code !== 'ENOTEMPTY' && e?.code !== 'EBUSY') throw e
      await new Promise((r) => setTimeout(r, 150))
      await fsp.rm(abs, { recursive: Boolean(recursive), force: false })
    }
    projectRoots.delete(abs)
  })

  /*
   * 写事务。临时文件与目标同目录，`writeEnd` 才 `rename` —— 与 FSA 的 siloed
   * 写入是同一种原子性来源（Chromium 的 `.crswap` 也是这个手法）。
   */
  let writeSeq = 0
  /** id → { handle, tmp, file, size } */
  const writes = new Map()

  ipcMain.handle('artmatic:fsWriteBegin', async (_e, file) => {
    const abs = guard(file)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    const id = ++writeSeq
    const tmp = `${abs}.${id}.tmp`
    writes.set(id, { handle: await fsp.open(tmp, 'w'), tmp, file: abs, size: 0 })
    return id
  })

  ipcMain.handle('artmatic:fsWriteChunk', async (_e, id, bytes) => {
    const w = writes.get(id)
    if (!w) throw new Error('no such writer')
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    await w.handle.write(buf, 0, buf.length, w.size)
    w.size += buf.length
  })

  ipcMain.handle('artmatic:fsWriteEnd', async (_e, id) => {
    const w = writes.get(id)
    if (!w) return
    writes.delete(id)
    try {
      await w.handle.sync()
      await w.handle.close()
      await fsp.rename(w.tmp, w.file)
    } catch (e) {
      await w.handle.close().catch(() => {})
      await fsp.rm(w.tmp, { force: true }).catch(() => {})
      throw e
    }
  })

  ipcMain.handle('artmatic:fsWriteAbort', async (_e, id) => {
    const w = writes.get(id)
    if (!w) return
    writes.delete(id)
    await w.handle.close().catch(() => {})
    await fsp.rm(w.tmp, { force: true }).catch(() => {})
  })

  ipcMain.handle('artmatic:fsReveal', async (_e, p) => {
    if (!withinRoots(p)) return
    const abs = trim(p)
    const st = await fsp.stat(abs).catch(() => null)
    if (st?.isDirectory()) await shell.openPath(abs)
    else if (st) shell.showItemInFolder(abs)
  })

  /** 冒烟专用：把一个临时目录加进允许集合（页面上只在 `--artmatic-smoke` 时可达）。 */
  ipcMain.handle('artmatic:smokeAllowDir', (_e, p) => {
    projectRoots.add(trim(p))
    return true
  })

  /** 每个窗口只监视一组；重开工程时整体替换。 */
  let watchers = []
  const closeWatchers = () => {
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* 已关 */
      }
    }
    watchers = []
  }
  app.on('will-quit', closeWatchers)
  app.on('window-all-closed', closeWatchers)

  ipcMain.handle('artmatic:watch', (e, paths) => {
    closeWatchers()
    const wc = e.sender
    for (const p of Array.isArray(paths) ? paths : []) {
      if (!permitted(p)) continue
      try {
        let timer = null
        const w = fs.watch(trim(p), { persistent: false }, () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (!wc.isDestroyed()) wc.send('artmatic:asset-changed', trim(p))
          }, 250)
        })
        watchers.push(w)
      } catch (err) {
        console.warn('[watch] failed', p, err?.message ?? err)
      }
    }
    return watchers.length
  })

  ipcMain.handle('artmatic:unwatch', () => {
    closeWatchers()
    return true
  })

  /**
   * 机器能力（容量预算的输入）。
   *
   * 浏览器版靠 dev / preview 服务端的 `/__capacity.json`（`scripts/capacity.mjs`
   * 同时是个 Vite 插件），而 `app://` 下没有这个路由。不补这一条，发行版启动时
   * 只会打一行「拿不到宿主机器能力」然后退回保守默认 —— 一台大显存机器被当成
   * 中端机，表现是特效池 / 视频纹理缓存偏小，**且不会报错**。
   *
   * 测量逻辑只有一份（`scripts/capacity.mjs::probeMachine`）：dev 下走 `../scripts`，
   * 打包后走 `resources/app/scripts`（`desktop/build.mjs` 会把这个文件带进去）。
   */
  let capacity = null
  ipcMain.handle('artmatic:capacity', () => {
    capacity ??= (async () => {
      for (const rel of ['./scripts/capacity.mjs', '../scripts/capacity.mjs']) {
        try {
          const mod = await import(new URL(rel, import.meta.url))
          if (typeof mod.probeMachine === 'function') {
            return { machine: await mod.probeMachine(), overrides: null }
          }
        } catch {
          /* 这个位置没有 / 探测抛了，换下一个 */
        }
      }
      return null
    })()
    return capacity
  })

  /*
   * 冒烟入口只在测试参数下注册。它仍然是「allow 一次 + 拿 token」，
   * 不开新能力 —— 只是把「选文件」这一步换成脚本给路径。
   */
  if (
    process.argv.includes('--artmatic-smoke') ||
    process.argv.includes('--host-smoke')
  ) {
    ipcMain.handle('artmatic:smokeAllow', (_e, p) => allow(p))
    ipcMain.handle('artmatic:smokeUrl', (_e, p) => urlFor(allow(p)))
  }

  return { allow, urlFor, stop: closeWatchers }
}

/**
 * 开发者工具：开 / 关同一个入口（设置面板与 F12 共用）。
 *
 * **独立窗口**（`mode: 'detach'`）：停在窗口底部会压掉预览的高度，
 * 而这台应用的布局是按像素排的 —— 一开工具就把时间轴挤掉一截，很容易被当成 bug。
 */
export function toggleDevTools(win) {
  const wc = win?.webContents
  if (!wc || wc.isDestroyed()) return
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach' })
}

/**
 * 窗口级动作的 IPC。
 *
 * 关掉应用菜单（`Menu.setApplicationMenu(null)`）之后，「开发者工具 / 重新加载 /
 * 退出」在窗口里就没有入口了，改由渲染层的设置面板触发。三条都走窗口自己的既有
 * 路径（`reload()` / `close()` 会触发页面的 `beforeunload`），脏工程照样弹原生
 * 确认框，所以这里不需要再实现一遍守卫。
 *
 * 页面调不到 BrowserWindow —— 与素材那条链路同一条边界：只认具名动作。
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => import('electron').BrowserWindow | null} deps.getWindow
 */
export function installWindowShell({ app, ipcMain, getWindow }) {
  const live = () => {
    const w = getWindow()
    return w && !w.isDestroyed() ? w : null
  }

  ipcMain.on('artmatic:titleBarOverlay', (_e, next) => {
    const w = live()
    // macOS 用交通灯，没有 overlay 这回事；那边调 setTitleBarOverlay 会抛。
    if (!w || process.platform === 'darwin') return
    const color = typeof next?.color === 'string' ? next.color : null
    const symbolColor = typeof next?.symbolColor === 'string' ? next.symbolColor : null
    const height = Number(next?.height)
    try {
      w.setTitleBarOverlay({
        ...(color ? { color } : {}),
        ...(symbolColor ? { symbolColor } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      })
    } catch (e) {
      // 颜色串不合法时 Electron 抛在这里。留着上一版配色比崩掉好。
      console.warn('[titlebar] overlay failed', e?.message ?? e)
    }
  })

  ipcMain.on('artmatic:toggleDevTools', () => toggleDevTools(live()))
  ipcMain.on('artmatic:reload', () => live()?.webContents.reload())
  ipcMain.on('artmatic:quit', () => app.quit())
}
