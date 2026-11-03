# Electron 环境兼容性调研

> 2026-10-18 · 结论先给：**不需要编 Chromium，也不需要塞 ffmpeg。**
> 但「H.264 能编」这件事有个前提，它决定了我们有没有一条可用的软件回退路径 ——
> 见 §0.1 与 §0.4。真正的宿主侧硬门槛是**页面怎么加载**（必须自定义 standard
> scheme，不能用 `loadFile`）。

## 0. 四条硬事实（都有一手出处）

### 0.1 官方构建默认开启专有编解码器（解码 + 硬件编码）

`electron/build/args/all.gn`（所有构建共用的 args）：

```
ffmpeg_branding = "Chrome"
proprietary_codecs = true
```

`electron/build/args/release.gn` 的注释原文：

> By default, Electron builds ffmpeg with proprietary codecs enabled. In order to
> facilitate users who don't want to ship proprietary codecs in ffmpeg, or who have
> an LGPL requirement to ship ffmpeg as a dynamically linked library, we build
> ffmpeg as a shared library.

也就是说 `libffmpeg.dll` 被做成 shared library，是为了让人**移除**它（市场上有这种
需求），不是等着人补上。**H.264 / AAC 的 parse / decode 支持表是编译期编进去的。**

这决定了三件事：

1. 塞一份自己的 `ffmpeg.exe` 对 WebCodecs **零作用** —— WebCodecs 用的是 Chromium 内部
   的 codec 实现与平台硬编，不是外部可执行文件。
2. 替换 `libffmpeg.dll` 也不是「补上」，而是可能把已经打开的专有编解码器换掉。
3. 需要区分一个容易误读的来源：Chromium 的 media owner 在 2023 年答过「Chromium 默认
   不带专有编解码器，要 `proprietary_codecs=true ffmpeg_branding="Chrome"`」——
   那句针对**通用 Chromium**。Electron 的 args 已经把它打开了。

### 0.2 编码这条路：硬件优先 + OpenH264 软件回退，但只到 Baseline

这一节是上一版写漏的，也是「要不要塞 ffmpeg」这个问题的真正答案。

**软件 H.264 编码器是存在的**，四段代码串起来：

| 位置 | 内容 |
|---|---|
| `media/media_options.gni` | `media_use_openh264 = true`；仅当 `is_ios` / arm Android / **`!proprietary_codecs`** 时关掉 |
| `media/base/media_switches.cc` | `BASE_FEATURE(kOpenH264SoftwareEncoder, base::FEATURE_ENABLED_BY_DEFAULT)` |
| `blink/.../webcodecs/video_encoder.cc` | `CreateSoftwareVideoEncoder` → `case kH264: CreateOpenH264VideoEncoder()` |
| `media/video/openh264_video_encoder.cc` | `if (profile != H264PROFILE_BASELINE) → kEncoderUnsupportedProfile` |

因为 Electron 的 `proprietary_codecs = true`，前三项都成立；第四项限定了能力边界：
**软件路径只出 Constrained Baseline，Main / High 一律不支持。**
（chromium issue 40266541「Support h264 main and high in OpenH264VideoEncoder」还开着，
代码里那行 `profile != H264PROFILE_BASELINE` 就说明没落地。）

所以完整的判定链是：

```
VideoEncoder.isConfigSupported(config)
  ├─ 有硬编（MediaFoundation / VideoToolbox / VA-API）→ Main / High 都可以
  └─ 无硬编（VM、远程桌面、老显卡、驱动被 blocklist）
       └─ 回退 OpenH264 → 只有 Baseline 能过；请求 Main 直接 unsupported
```

**产物不受影响**：Baseline 编出来的仍是合法 H.264，MP4 照常播。

### 0.3 我们现在的 codec 串把软件路径堵死了

`src/exporters/mp4-sink.ts`：

```ts
export const MP4_CODEC = 'avc1.4d0028'   // Main profile, Level 4.0
```

无硬编的机器上，这个串会让 `isConfigSupported` 返回 false → `mp4Supported()` 判假 →
UI 显示「本机浏览器不支持 WebCodecs，只能导出 PNG 序列」。**诊断是错的**：机器能编
H.264，只是编不了 Main。

修法不用引 ffmpeg，只需一条 codec 阶梯（顺带把 UI 的文案从「不支持 WebCodecs」改成
「本机只能软件编码 / 不支持 H.264」）：

```
avc1.4d0028 (Main 4.0) → avc1.4d401f (Main 3.1) → avc1.42E01E (Baseline 3.1) → 放弃
```

代价要说清：软件路径慢（1080p 大约个位数到十几 fps）且码控能力弱，导出面板应当
在选中软件编码时提示「本机无硬件编码器，导出会明显变慢」。
`hardwareAcceleration: 'prefer-software'` 可以强制走软件路径做测试，但产品里不要写死。

什么时候才真的需要额外 ffmpeg：**只有在软件路径上也要 Main / High 时**。那时它是一条
独立的转码管线（吃掉 RGBA 帧流 → 自己编 → 自己封 MP4），与 WebCodecs 无关，
是另一个量级的工程。现在不需要。

### 0.4 权限默认全放行

`docs/tutorial/web-api-permissions.md`：

> Electron grants access to all JavaScript APIs requesting permissions by default.

所以 `local-fonts`（本机字体）与 `fileSystem` 不需要写 handler —— 想收紧才写。
`session.setPermissionRequestHandler` 的 permission 枚举里确实同时有这两项。

### 0.5 `file://` 是 null origin，会静默关掉一半存储

`docs/api/protocol.md`：

> A standard scheme adheres to what RFC 3986 calls generic URI syntax. For example
> http and https are standard schemes, while **file is not**.
>
> By default web storage apis (localStorage, sessionStorage, webSQL, indexedDB,
> cookies) are disabled for non standard schemes.
>
> **Registering a scheme as standard will allow access to files through the
> FileSystem API. Otherwise the renderer will throw a security error for the scheme.**

三个后果直接命中 Artmatic：

| 依赖 | 位置 | 在 `file://` 下 |
|---|---|---|
| 目录句柄持久化 | `project/handles.ts`（IndexedDB） | 不可靠 |
| 自动保存草稿 | OPFS | 不可靠 |
| UI 偏好 / 主题 / 最近工程 | localStorage | Electron 对 `file://` 有特殊处理，能用，但与 `app://` 不是一个 origin，跨版本迁移会丢 |
| File System Access | `project/fs.ts` | 可能直接抛 security error |

**结论：主进程必须用 `protocol.handle` 服务 `dist/`，并把 scheme 注册成
`{ standard: true, secure: true, supportFetchAPI: true, stream: true }`。**
这是唯一不能省的一步，它决定 web 版的行为在桌面版里是否逐条成立。

## 1. 逐项能力对照

| 能力 | Artmatic 用在哪 | Electron | 需要做什么 |
|---|---|---|---|
| WebGL2 + `EXT_color_buffer_float` | 全部合成、反馈、HDR 历史 | 同 Chromium 同 ANGLE | 不调 `app.disableHardwareAcceleration()` |
| Web Worker（module） | `algos/bake.worker.ts` | 可用 | scheme 必须 standard，否则 module worker 加载失败 |
| `OffscreenCanvas` / `VideoFrame` / `createImageBitmap` | 视频取帧、缩略图 | 可用 | — |
| **VideoEncoder H.264** | MP4 导出（主路径） | 硬编走平台；无硬编回退 OpenH264（**只到 Baseline**） | codec 阶梯，见 §0.3 |
| **VideoDecoder H.264** | 视频素材取帧 | 解码路径完整（ffmpeg 带专有编解码） | 探针 2 确认 |
| AAC 编码 | MP4 音轨 | Chromium 侧一直可用（web 版现网已在用） | 无 |
| `showDirectoryPicker` | 工程目录 | 可用，但受两道限制 | 自定义 scheme + 处理 `file-system-access-restricted` |
| `showSaveFilePicker` / 流式落盘 | 大体积导出 | 同上 | 同上 |
| IndexedDB / OPFS / localStorage | 句柄 / 草稿 / 偏好 | **依赖 standard scheme** | 自定义 scheme |
| `window.queryLocalFonts()` | 排版「本机字体」 | 默认放行 | 无需代码，探针 6 确认返回数 > 0 |
| `EyeDropper` | 屏幕取色 | 未知 | 探针 3 |
| `navigator.clipboard.write(ClipboardItem)` | 截图进剪贴板 | 未知 | 探针 4 |
| `a[download]` + blob URL | GIF / 快照 / 无 FSA 时的导出 | 走 `will-download` 事件 | 改成主进程保存对话框（见 §3.3） |
| 拖入文件（`dataTransfer.files`） | 导入 | 可用 | 无（代码不读 `File.path`，Electron 32+ 已移除该字段，正好没依赖） |
| Pointer Lock / Fullscreen | 数字框拖动、全屏预览 | 可用 | 无 |
| 跨源隔离 / SharedArrayBuffer | 未使用 | — | 不需要 COOP/COEP |

## 2. 唯一会静默失败的坑：`file-system-access-restricted`

Electron 在 Chromium 的路径黑名单之上加了一个应用级事件。系统路径黑名单由
`GenerateBlockPaths` 生成（盘符根、`Windows`、`Program Files`、用户主目录本身等），
命中时 Chromium 会 emit：

```ts
session.defaultSession.on('file-system-access-restricted', (event, details, callback) => {
  // details: { origin, isDirectory, path, frame, webContents }
  // callback: 'allow' | 'deny' | 'tryAgain'
})
```

不处理 = **deny → `AbortError`**。用户选到一个被拦的目录时，页面上只会看到
「打不开」，没有任何解释 —— 这正是本项目最讨厌的那类静默失败。

建议处理：弹原生对话框，`allow` 与「换一个目录」两个选项，`deny` 留给系统目录。
不要为了省事一律 `allow`：Artmatic 会往工程目录写 `assets/`、`plugins/`、`project.json`，
让用户把工程放在 `C:\Windows` 下不是「自由」，是给他挖坑。

> **工程目录在桌面版不再走 FSA。** 上面这整段（含黑名单与授权弹窗）只影响
> **浏览器**里打开的工程目录。桌面壳改用原生目录选择器 + **本机路径**句柄
> （`src/project/path-dir.ts`，IPC 在 `host.mjs` 的 `artmatic:fs*`）—— 因为 FSA 的
> 目录句柄是不透明引用，拿不到路径就做不到「在资源管理器里打开工程目录」和
> 「真的把目录删掉」。旧工程（存的是 FSA 句柄）照旧能打开，只是那两件事退化成
> 浏览器的行为（打开=接进来 / 删除=清空）。

## 3. 必须改的代码（5 处，全在宿主侧）

### 3.1 自定义 scheme + 静态服务

```js
// before app.whenReady()
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}])
// after ready
protocol.handle('app', (req) => { /* 限制在 dist 内，防 ../ 穿越；SPA fallback 到 index.html */ })
win.loadURL('app://bundle/')
```

`codeCache: true` 不是可选项：排版编辑器与 75 个特效的 GLSL 都在 JS 里，没有 V8 code cache
每次冷启动都要重新编译。

### 3.2 `file-system-access-restricted`

见 §2。

### 3.3 下载出口

`platform/types.ts::download` 现在在 `platform/browser.ts` 里是 `a.download` + blob URL。
Electron 侧实现为 `dialog.showSaveDialog` + `fs.writeFile(blob.arrayBuffer())`，
**不要**依赖 `a.download`：

- 默认会落到系统下载目录，用户不知道文件去哪了；
- 300 MB 的 MP4 走 blob URL 再下载是白白多一次拷贝，而导出本来就已经有一份字节。

### 3.4 `probeCapacity()`

浏览器版靠 dev / preview 服务端的 `/__capacity.json`。桌面版直接在主进程量：
`os.totalmem() / os.freemem()`，显存沿用现有探测（`scripts/capacity.mjs` 里的逻辑
可以搬进主进程）。返回同样形状的 `MachineCapacity`，上层一行不改。

### 3.5 关窗守卫（`will-prevent-unload` + Ctrl+W）

页面里有 `beforeunload`（`App.svelte::onBeforeUnload`，`anyDirty` 时 `preventDefault`）。
浏览器会自己弹「离开此网站？」，**Electron 不会**：

- 不接 `will-prevent-unload` ⇒ `X` / `Alt+F4` / 任务栏关闭**全部静默失效**，
  窗口关不掉，只能任务管理器强杀。而「零工程」时 `anyDirty` 为假，窗口又能正常关 ——
  症状看起来像「打开工程就坏」。
- 没有应用菜单就**没有 Ctrl+W 的默认加速键**，要自己接一条，并让它走同一个
  `win.close()` 路径（这样脏工程也走同一道确认）。

```ts
win.webContents.on('will-prevent-unload', (event) => {
  // 用户确认放弃时调用 preventDefault —— Electron 的语义是「忽略页面的拦截」
  if (confirmDiscard()) event.preventDefault()
})
```

**这条是产品级缺陷，不是打包配置问题**：web 版有浏览器兜底，桌面版没有。

**关窗之后进程必须真的死掉。** 默认的 `window-all-closed → quit` 在本机会话里会挂住
（同 §7 那条 network service 崩溃），表现是**窗口没了、进程还在**：句柄钉着
`release/*/resources/default_app.asar`，于是旧产物删不掉、目录改名也 `Permission denied`，
只能重启才干净 —— 而症状看起来像「打包脚本有 bug」。所以 `main.mjs` 里给了一支超时：

```js
app.on('window-all-closed', () => {
  app.quit()
  setTimeout(() => app.exit(0), 2000).unref()   // 走到这儿说明清理已完或已不可能
})
```

排查时的一句话：**先 `tasklist | findstr Artmatic`，再怀疑脚本**。有进程在跑就什么都别删。

### 3.6 窗口外观：无菜单 + 顶栏即标题栏

```js
if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
new BrowserWindow({
  titleBarStyle: 'hidden',
  titleBarOverlay: { color, symbolColor, height }, // 首帧值，渲染层随后校正
  icon: 'icon.ico',
})
```

| 关注点 | 处理 |
|---|---|
| 默认菜单栏 | `Menu.setApplicationMenu(null)`，只在非 macOS。Windows / Linux 下它就是那条几十像素高的 File/Edit/View |
| 加速键 | 菜单一并带走全部默认加速键 ⇒ `before-input-event` 补回 Ctrl+W / F12 / Ctrl+Shift+I / F5 / Ctrl+R |
| macOS | 不动：菜单挂在系统菜单栏上、不占窗口，置 null 会弄坏 Cmd+Q / Cmd+C；交通灯浮在内容上要另做左侧留白，而发行版不出 macOS |
| 右侧留白 | 系统画的三个按钮宽度随 DPI 与窗口状态变 ⇒ 读 `navigator.windowControlsOverlay.getTitlebarAreaRect()`，`--wco-w` = `innerWidth − rect.width`（实测 1440 宽的窗口是 137px）。写死 px 必然错位 |
| 拖拽 | 顶栏 `app-region: drag`；按钮与选项卡 `no-drag` —— 选项卡自己有拖动排序，被窗口拖拽吞掉指针事件就废了 |
| 只在壳里生效 | 全部规则门控在 `:root[data-wco='on']`。浏览器里无条件 `drag` 会把顶栏变成点不到、选不中的死区 |
| 按钮配色 | 按钮由主进程画、读不到 CSS 变量 ⇒ 主题变更后 `setTitleBarOverlay` 重发一次。取 `--bar-bg` / `--bar-fg` 时要**解开一层 `var(--x)`**（component 层 token 存的就是那个形态，直接交给 Electron 会抛） |
| 高度 | 真源是 `tokens.ts` 的 `DENSITY.topbarH`；`host.mjs::TITLEBAR_H` 只是首帧猜测，渲染层按 `--topbar-h` 回传校正 |
| 图标 | 两处，缺一不可：窗口 / 任务栏走 `BrowserWindow.icon`（`main.mjs`，读 `desktop/icon.ico`）；**资源管理器里那个**是 exe 自己的 PE 资源，由 `build.mjs::patchExeIcon` 用 `resedit` 改写（顺带把版本信息里的 "Electron" 换成 Artmatic + `package.json` 的版本号）。`icon.ico` 由 `node scripts/make-icon.mjs` 从品牌 SVG 生成，改了品牌才需要重跑 |

壳层动作（开发者工具 / 重新加载 / 退出）在**设置 → 桌面**，这一页只在 `platform.shell` 存在时出现 ——
浏览器没有窗口可管。三条都走窗口自己的路径（`reload()` / `close()` 会触发页面 `beforeunload`），
所以脏工程照样弹原生确认框；开发者工具开在**独立窗口**，不挤压按像素排的布局。

`resedit` 是纯 JS 读写 PE 的库（MIT，devDependency，不进产物）。手算 `.rsrc` 的偏移与数据目录
不是这儿该干的事。它替换全部 RT_ICON / RT_GROUP_ICON 组，所以不会在某个视图里残留 Electron 图标。

两条已知边界：

- **会丢掉 Authenticode 签名**（改字节必然）。Electron 官方 Windows 包本来就没签，我们也没签，没有实际损失 —— 真要签名得在打包后重新签。
- 版本信息里的 `CompanyName` / `LegalCopyright` 仍是 Electron 上游那两行（`GitHub, Inc.`）。它们是关于**运行时来源**的陈述，随包还带着 `LICENSES.chromium.html`，所以不改成我们自己的名字。

## 4. 性能：没有理由变慢，但有三个开关会让它变慢

Electron 与 Chrome 是同一套 Chromium / V8 / ANGLE / 硬件解码器。差异只可能来自配置：

1. **别调 `app.disableHardwareAcceleration()`**。调了 = WebGL2 走 SwiftShader，
   1080p 合成会从 2ms 掉到 200ms 量级。
2. 老显卡被 GPU blocklist 挡下时与 Chrome 表现一致；可选
   `app.commandLine.appendSwitch('ignore-gpu-blocklist')`，但这是「赌驱动没问题」。
3. 别开 `transparent: true`（合成器多一遍）与 `backgroundThrottling: false`（部分版本会改变 rAF 节流）。

验收口径：同一工程同一机器，`24 秒 1080p MP4 导出` 的耗时与 Chrome 对照在 ±5% 内；
`chrome://gpu` 显示硬件加速开启。低于这个标准先去查 GPU 进程，不要先怀疑代码。

## 5. 探针清单（5 分钟，放进空壳里跑）

```js
// 1 编码：三档 profile 分档打，结果本身就能看出走的是哪条路
for (const c of ['avc1.4d0028', 'avc1.4d401f', 'avc1.42E01E']) {
  const r = await VideoEncoder.isConfigSupported({ codec: c, width: 1920, height: 1080, bitrate: 16e6, framerate: 30 })
  console.log(c, r.supported)
}
// 期望：有硬编 → 三档全 true；无硬编 → 只有 avc1.42E01E 为 true（OpenH264）
// 2 解码
console.log((await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 1920, codedHeight: 1080 })).supported)
// 3 屏幕取色
console.log(typeof EyeDropper)
// 4 剪贴板图片
const c = document.createElement('canvas'); c.width = c.height = 8
const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
console.log(await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => 'ok', String))
// 5 FSA
console.log((await showDirectoryPicker({ mode: 'readwrite' })).name)
```

再加四条人工检查（探针测不出来）：

- **重启后句柄还在**：选一个目录 → 关掉应用 → 重开 → 「最近的工程」能不能直接打开（不该再要授权）。这条验的是 §0.5 的 scheme 决策。
- `window.queryLocalFonts()` 返回数量 > 0。
- 导入一个 4K H.264 视频，拖播放头时解码 fps 正常。
- 用 `hardwareAcceleration: 'prefer-software'` 重跑探针 1，确认软件路径真的能出片（这条是 §0.3 那条阶梯的兜底验证）。

## 6. 体积

| 项 | 量级 |
|---|---|
| Electron 44 安装包（Win x64） | ~100 MB |
| 解压后 | ~220 MB |
| 额外 ffmpeg | **0**（不需要） |

如果将来要做「导入任意格式（ProRes / MKV / HEVC）自动转码」，那时再加静态 ffmpeg
（+80 MB）—— 那是**功能**，不是兼容性需求，与本轮的可用性无关。

## 7. 判定

- 可行，改动面比预想小：宿主侧 4 处接线 + 一个 scheme 决策 + **一条 codec 阶梯**。
- 「H.264 只能解不能编」这个说法对**旧版 Chromium** 成立，对现在的 Electron 不成立：
  硬编之外还有 OpenH264 软件编码，只是限 Constrained Baseline（§0.2）。
- 所以不需要 ffmpeg，但**需要改 codec 串**：`avc1.4d0028` 写死之后，无硬编的机器
  会走进「不支持 WebCodecs」这个错误诊断（§0.3）。这条在 web 版上也成立 ——
  虚拟机、远程桌面、老显卡上现在就是这么表现的。
- 真正的宿主侧风险仍在 `file://`：它会让所有存储行为与 web 版不一致，症状是
  「关掉再打开要重新授权」「自动保存的草稿不见了」—— 都不是报错，是最难查的那类。

## 8. 实测结果（2026-10-19，Electron 44.9.0 / Chromium 152）

复现：

```bash
pnpm run build                 # web 产物
node desktop/build.mjs        # → release/Artmatic-<version>-win32-x64/
```

壳与接线见 `desktop/main.mjs`（`app://` scheme、restricted 事件、权限、`will-download`）。
下面是**在这台机器上跑出来的数**，不是推断。

### 8.1 能力探针

| 项 | 结果 |
|---|---|
| `location.origin` / `isSecureContext` | `app://bundle` / **true** |
| WebGL2 | **true**，`EXT_color_buffer_float` **true** |
| 渲染器 | `ANGLE (NVIDIA, RTX 4070 Laptop, Direct3D11)` —— 真 GPU，不是 SwiftShader |
| `VideoEncoder` Main 4.0 / Main 3.1 / Baseline 3.1 | **true / true / false** |
| 实编 30 帧（640×360，Baseline） | 38,262 字节，首块 `key` |
| `VideoDecoder` H.264 | true |
| `AudioEncoder` AAC-LC | true |
| localStorage / IndexedDB / OPFS | 全部可写可读 |
| `showDirectoryPicker` / `showSaveFilePicker` | 存在 |
| `EyeDropper` / `ClipboardItem` | 存在 |
| `queryLocalFonts()` | **800** 个字体 |

`Baseline = false` 这条值得记住：**方向和我预想的相反**。有硬件编码器时，
MediaFoundation 只暴露 Main/High，不暴露 Baseline，而 OpenH264 只在「硬编拿不到」
时才被选中。所以阶梯必须是「逐档试」而不是「按固定顺序假定某一档一定可用」——
它同时解释了为什么 web 版写死 `avc1.4d0028` 在用户的机器上一直没出问题。

### 8.2 端到端导出

打开演示工程 → 侧栏「导出」→ MP4，全程走产品代码（`runExport` → mediabunny → WebCodecs）：

| 项 | 值 |
|---|---|
| 工程 | 24 s / 1920×1080 / 24 fps（576 帧） |
| 耗时 | **4.1 s** |
| 产物 | 48,133,197 字节（≈16 Mbps） |
| 结构 | `ftyp isom`（compatible brand 含 `avc1`）、`moov` 在 `mdat` 之前（faststart）、含 `mp4a` 音轨 |

4.1 秒这个数只有在硬件编码可用时才成立；它同时说明「渲染 + 编码」这条链在
Electron 里没有额外开销。

### 8.3 两个必须复测的异常

1. **沙箱渲染进程在本机会话里起不来**：`sandbox: true` 时 `render-process-gone`
   报 `crashed / 0x80000003`，页面 `ERR_FAILED`。`--nosandbox` 之后一切正常。
   这很可能是我这台机器所在的**外层沙箱**（进程创建受限）所致，不是 Electron 本身，
   但**必须在干净桌面上复测一次**——如果产品无法开沙箱，那是安全边界问题。
2. **GPU 进程反复 `0xC0000005`**（`child-process-gone: GPU crashed`），而 WebGL2 与
   编码仍然工作。同样是环境嫌疑，需干净机器对照。

### 8.4 体积

| 项 | 裁之前 | 裁之后 |
|---|---|---|
| 壳 | 368.5 MB | 321.9 MB |
| 应用（dist + 入口） | 10.0 MB | 10.0 MB |
| 合计（解压后） | **378.5 MB** | **331.8 MB** |

最大的一块是 Chromium 本体（静态链进 `Artmatic.exe`，236 MB），动不了。
**`locales/` 那 55 个 `.pak` 是 Chromium 自己的界面文案**（DevTools、右键菜单、
网络错误页），与 Artmatic 的 i18n 无关 —— 我们 3032 条文案全在 `dist` 的 JS 里。
只留 `zh-CN` / `zh-TW` / `en-US` 省了 46.7 MB；缺哪个语言 Chromium 回落 en-US。

余下可动的只有 `dxcompiler.dll`（25 MB，D3D12 着色器编译，删了赌驱动）与
`vk_swiftshader.dll`（5.3 MB，无 GPU 时的软件 GL 回退）—— 都不建议删。
安装包（NSIS 压缩）预计落在 120–140 MB。

### 8.5 关窗守卫：已踩到并修掉

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开工程后 `X` / `Ctrl+W` / `Alt+F4` 都关不掉，只能强杀；零工程时能关 | 页面 `beforeunload` 在 `anyDirty` 时拦截，Electron 不弹浏览器那种确认框，窗口于是永远不关 | 接 `will-prevent-unload` → 原生确认框；用户选「放弃」时 `event.preventDefault()` |
| `Ctrl+W` 完全没反应 | 没有应用菜单 ⇒ 没有默认加速键 | `before-input-event` 里接 `Ctrl/Cmd+W` → `win.close()` |
| `F12` / `F5` / `Ctrl+R` 也没反应 | 同上，同一批默认加速键一起消失 | 同一个 handler 里补上，指向 `toggleDevTools()` / `reload()` |
| 窗口关了，`release/*/` 却删不掉 | `app.quit()` 挂住 ⇒ 没有窗口的僵尸进程钉着 `resources/default_app.asar` | `window-all-closed` 里 quit + 2s 后 `app.exit(0)`；排查先看 `tasklist` |
| 强杀时窗口先变黑再消失 | 进程被杀，合成器没了 | 正常现象，不是 bug |

验证（`desktop/main.mjs --closetest`，打开演示工程使其处于未保存状态）：

```
ARTMATIC_CLOSE_ANSWER=cancel  → [close] dirty prompt -> cancel → [closetest] window still open
ARTMATIC_CLOSE_ANSWER=discard → [close] dirty prompt -> discard → 进程干净退出（rc=0）
```

打包产物上同样跑过一遍。`ARTMATIC_CLOSE_ANSWER` 只是给自动化用的旁路，
不设它就走真实对话框。

### 8.6 机器能力：`app://` 下没有 `/__capacity.json`（0.3.0 补）

浏览器版的容量预算来自 dev / preview 服务端的 `/__capacity.json`（`scripts/capacity.mjs`
同时是个 Vite 插件）。发行版里没有这个路由，于是 `probeCapacity()` 返回 null、
`loadCapacityProfile()` 打一行 `[capacity] 拿不到宿主机器能力` 就退回 `DEFAULT_LIMITS`
—— **不报错，只是把一台 8 GB 显存的机器当中端机用**（特效池 256 而非 512、导出内存
512 而非 1.2 GB）。

修法：`desktop/host.mjs` 加 `artmatic:capacity`（复用同一个 `probeMachine()`，
dev 走 `../scripts`、打包后走 `resources/app/scripts`，`desktop/build.mjs` 负责带上），
`preload.cjs` 暴露 `capacity()`，`src/platform/electron.ts` 覆盖 `probeCapacity()`。

实测（RTX 4070 Laptop / 16 GB）：

```
[capacity] 来源 node+nvidia-smi｜内存 5261/16065 MB｜显存 8188 MB
｜预算：视频 819 MB、排版 307 MB、特效池 512 MB、模拟 205 MB、导出内存 1315 MB、撤销 164 步
```
