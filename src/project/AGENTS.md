# src/project/ —— 工程持久化（File System Access）

工程目录格式 · 素材台账 · 原子写 · 句柄持久化（含 `plugins/` 读写）。
**工程真相在磁盘目录，不在 localStorage。**

**何时读我**：改 `project/**`；动保存顺序 / 素材台账 / 句柄与权限 / `.bak` 与读回校验时。

相关：`src/core/AGENTS.md`（`Project` 结构与 `SCHEMA_VERSION` 迁移）、
`src/plugins/AGENTS.md`（`plugins/` 目录）、`src/exporters/AGENTS.md`（流式落盘）。

---

```
<工程目录>/
├── project.json        工程本体（`src/core/AGENTS.md` 的 Project），真相的唯一载体
├── project.json.bak    上一版**手动**保存的副本（自动保存不碰它）
├── assets.json         素材台账（引用路径 + 内容哈希 + 原始文件名 + retained）
├── assets/             素材字节（文件名 = <assetId>.<原始扩展名>）
│   └── .trash/         清理掉的未使用素材（先搬进来，不直接删）
├── analysis/           可重算的离线分析缓存（音频波形 / BPM / 拍网格）
├── plugins/            这个工程挂的插件（一个插件 = 一个 .js），见 `src/plugins/AGENTS.md`
├── agent/sessions/     Agent 对话历史（一个会话 = 一个 <id>.json），见 `agent-history.ts`
└── thumbs/             缩略图缓存（可丢弃）：`cover.webp` 是工程封面，删了下次保存再生成
```

## 素材引用修复（v21）

`asset` 型参数（`spriteAsset` / `emitAsset`）是 `params` 里的 assetId 字符串。
键清单在 `core/asset-params.ts`，`ui/app-state.svelte.ts::removeAsset` 在删台账条目的
**同一次 `commit`** 里调 `clearAssetRefsInProject`，把指向它的参数置空串。

放在同一次提交是要紧的：分两次会留下一个中间状态，撤销到那里时工程里的参数还指着
一条已经不存在的素材。`validateProject` 里的 `sanitizeAssetParams` 只兜手改 JSON 与
跨版本拼接的数据。

`AssetStore.retire(id)` 保留字节与哈希供「未使用素材」找回，它不碰工程参数表。

**本地草稿不在工程目录里**：没有目录句柄的工程，自动保存落到 OPFS 的
`drafts/<draftKey>.json`（见 `drafts.ts`）。草稿只有一个 `Project` JSON，
没有素材字节与台账 —— 恢复出来缺素材是实话，不是 bug。

- `src/project/layout.ts` 是路径规则的唯一真源。路径一律按**段数组**处理，不拼字符串再拆
  —— FSA 的 `name` 里不允许出现分隔符。`plugins/` 也走这一套
  （`pluginPathSegments` / `safePluginId`），并已加入 `PROJECT_DIRS`。
- **`agent/sessions/` 是工程数据，不是缓存**（与 `plugins/` 同类）：删了就是丢对话
  历史，所以它不在可丢弃清单里。一个会话一个文件是刻意的：
  - 一轮对话只重写自己那个文件（整份重写 = 30 × 400 条摘要跟着每次落盘）；
  - 删会话是 unlink，不用「读全量 → 过滤 → 重写」；
  - 一个坏文件只丢一条会话（`readAgentHistory` 只记 `failed`），工程照常打开。
  **不做索引文件**：目录列表就是索引（30 个小文件）。排序口径在
  `agent/history.ts::sanitizeAgentSessions`，别在 IO 层再写一份。写失败只
  `console.error` —— 历史是日志，不挡保存、不挡打开。
- **`project.json` 不写 `savedAt`**：写进去会让「内容没变 → 字节没变」失效。
- **原子性由浏览器提供**：`createWritable()` 默认 siloed 模式（同目录写 `.crswap`，
  `close()` 时才 rename）。Web 上**没有 fsync**。我们能自己做的只有两件：
  维护 `.bak`，以及 `close()` 之后读回来校验一遍（抓「磁盘满而 close 没报错」这类静默损坏）。
- 多标签页并发写用 `createWritable({ mode: 'exclusive' })`。降级重试**只认 TypeError**
  —— 把「已经有 writer」一起吞掉的话，并发写就退化成静默互相覆盖。
- **素材的身份是内容，不是路径（v3）**：`AssetEntry.content = { size, fp }`，
  `fp = fp1:<size>:<sha256(size\n head64k\n tail64k) 前 32>`（`fingerprint.ts`）。
  只读 128 KiB —— 视频也能算，不需要整份进堆。`locations[]` 才是位置：
  `project`（工程根相对路径）/ `local`（本机路径；浏览器是 `fsa:<assetId>` 这个键）。
  解析策略在 `asset-resolve.ts`（纯函数）：优先 `mode` 指定的那一路，但每份都必须
  指纹匹配；对不上是 `stale` / `conflict`，**绝不静默换内容**。
- **默认 linked**：导入记录本地位置，工程里不复制。`<input type=file>` 给不出句柄，
  所以浏览器用 `showOpenFilePicker()`（句柄存 IndexedDB，`asset-handles.ts`）；
  拿不到句柄的环境退回 bundled。`collect`（媒体池菜单）才把副本写进 `assets/`。
  **本地原文件永远不删**；linked-only 条目在工程目录里没有文件是正常状态，
  `auditLedger` 不对它报 missing。
- **素材仓存的是来源，不是一律摊开的字节**：`AssetSource = file | handle | bytes | path | none`。
  - 视频：`file`（本地导入）/ `handle`（句柄）/ `path`（桌面版绝对路径）——
    **一个字节都不进堆**。图片/音频：`bytes`（要喂解码器）。
  - `path` 的读取由 `setAssetPathReader()` 在 `main.ts` 注入（Electron 主进程的
    `readRange`）：`open()` 按 4 MiB 分块、`openVideo()` 返回 `{kind:'path',read}`
    给 mediabunny `CustomSource`、`contentFor` 只读首尾 128 KiB。**没有注入时
    `open()` 返回 null，绝不产出空流**（否则保存会写出 0 字节文件）。
  - 读接口只有两条：`open()`（分块，保存用）与 `readAll()`（一次性，图片/音频用）。
    `bytesOf()` **只返回已在内存里的字节**，绝不读盘 —— 排版置图是同步 API，靠它。
  - 旧版「视频 hash 恒为 null」已废弃：现在所有素材都有采样 `content.fp`。
    `hash: null` 只可能是 v2 迁移过来的、还没补算的旧条目。
- **写入顺序就是全部的安全性**：素材 → 台账 → 工程。崩在中间任何一步都无害
  （多出来的素材文件下次被当作孤儿报告），而「工程引用了已删素材」是有害的。
  素材写入走 `writeStreamAtomic`（**流式**），`saveProject` 只收 `openFor(id)`；
  它不再有 `bytesFor` —— 把整份视频交给它就会把句柄化的收益赔回去。
- **保存不删素材文件**：从 `Project.assets` 移除只解除引用，`assets/` 里的字节
  留在原处。台账把它标成 `retained: true`（不再是「孤儿」），工程面板的
  「未使用素材」可以恢复它，或者把文件**移进 `assets/.trash/`**（先写回收站再删原文件）。
  「彻底删除」只对已移除的条目出现，并带二次确认。所以 `assets/` 里有台账不知道的文件
  仍是**预期状态**（旧版本留下的孤儿），不是残留。
- 台账**可以丢**：文件名就是 `<assetId>.<ext>`，从 `assets/` 目录本身就能重建（哈希现场算）。
  所以 `parseLedger` 对损坏输入降级成空台账 + 警告，而不是抛错。`assets/` 里的未跟踪文件
  **只提示不删**。`auditLedger` **跳过 retained 条目**（它们不再被工程引用，文件丢了也
  不该报 error）。`LAYOUT_VERSION` 3：v2 的 `path` 归一化成一条 `project` 位置，
  `hash`（全量 sha256）无法换算成采样指纹，置空、打开时补算。
- **`.artmatic` 工程包（`archive.ts` + `package.ts`）**：store-only ZIP64，流式写
  （data descriptor 边写边算 CRC），内存峰值与包大小无关。`manifest.json` 在包最前面；
  打包 = 收集全部未移除素材（含 retained、把 linked 物化成 `assets/`），排除
  `.trash/`、`thumbs/`、`analysis/`。导入**先校验清单与 project.json CRC**，拒绝
  绝对路径 / `..` / 重复条目 / 清单之外的条目；**不执行包里的插件**（跳过并告警）。
  目标目录里已有 `project.json` 时拒绝覆盖。
- 三个根来源（`project/fs.ts` 定义最小句柄接口）：`fsaRoot`（生产，首次需点一次）/
  `opfsRoot`（E2E 与 dev，无授权）/ `memoryRoot`（单测，**模拟 swap 语义** + `setFault()` 注入失败）。
  句柄存 IndexedDB，跨会话保留，但**权限不一定跟着** —— 新会话里 `queryPermission()`
  通常是 `'prompt'`，要 `requestPermission()` 且那一下必须有用户手势。所以「打开最近工程」
  天然只能由点击触发，**页面加载时不能自动恢复**。同名目录靠 `isSameEntry()` 区分。
- **工程封面有两份，用途不同**（`ui/project-cover.svelte.ts`）：`<工程>/thumbs/cover.webp`
  跟工程走（拷走还在），IndexedDB 的 `covers` 给首页直接用 —— 首页**不能**为了拿一张
  缩略图去申请目录权限。同一个库（`artmatic`）里 `dirHandles` 与 `covers` 两个 store，
  所以 `DB_VERSION` 一提就得两处一起建（别另开一个 DB，两套升级逻辑必有一半会漏）。
  手动保存两份都写，自动保存只刷缓存；`最近工程` 上限 12 条，被挤出去的句柄与封面一起清。
- **`ProjectRef.name` 是工程名（`project.json` 的 `name`），不是目录名**；目录名在
  `dirName`。写入口只有两处（`openAt` / `writeTo`），都用内存里那份工程的名字 ——
  老条目（这一版之前记的是目录名）由 `adoptRecentNames()` 在启动时自愈，但它
  **只在权限已经 granted 时**读 `project.json`（为了更新一行字弹系统授权框不值当）。
- **最近工程的右键菜单**在 `ui/recent-menu.ts`：「打开文件夹」/「从最近工程列表移除」/
  「删除工程」，首页与工程面板共用同一份定义。
  - 「打开文件夹」：桌面壳交系统文件管理器（`fsReveal`）；浏览器里 FSA 的目录句柄
    是不透明引用、**拿不到绝对路径**，那种情况下退化成「把那个目录接进来」（= 打开工程，
    已开着就切到前台）。
  - 「删除工程」：桌面壳**连目录一起删**（主进程 `fs.rm`）；浏览器里只能**清空目录**
    （`remove()` 只能删子项，删自己需要父句柄）。两条路的确认文案不同 ——
    `proj.deleteBodyPath` / `proj.deleteBody`，措辞不许比实际做得多。
- **工程目录的第二条根：本机路径**（`project/path-dir.ts`）。桌面壳的工程位置是
  **绝对路径**（`platform.fs` 那组 IPC），因为它才让上面两件事成立：
  - IndexedDB 里存 `{kind:'path', path}` 小对象（`pathHandleMarker`），与 FSA 的原生
    句柄同店不同形 —— 取回来先看 `pathFromHandle`，再看 `adoptNativeDir`。key 是
    `path:<绝对路径>`，稳定且可读。
  - 原子写对齐 FSA 的 siloed 语义：同目录临时文件 + `rename`（主进程侧）。
  - ⚠️ **主进程的边界**：根只能由原生选择器加入；任何路径都要落在某个根之下
    （`withinRoots`），并且**删根自己**时额外校验目录里有 `project.json` ——
    没有这条，一个写错的路径就能把别的文件夹清了。
  - `FsFile.path`：只有路径句柄给得出。视频解码靠它走 `PathVideoMedia`（按范围读），
    否则「工程目录里的视频」会被 `readBytes()` 整份摊进堆。
  - 回归：`tests/unit/path-dir.test.ts`（真 Node 文件系统当桥）+ `desktop:smoke`
    的 `[path-project]` 段（保存 / 落盘 / 守卫 / 删根）。
- **脏标记是近似但方向安全**：`savedVersion !== version` 即视为有未保存改动
  （假阳性只是多问一句，假阴性才是丢工作）。注意 `store.touch()` 也被「视频解出一帧 /
  算法烘焙完成」用来通知重绘，所以**播放期间工程会一直显示为脏** —— 自动保存因此
  必须自己做内容比对（见下一条），不能只看脏标记。
  `ProjectStore.replaceProject()`（打开 / 新建）**会清空撤销栈**，`loadFrom()`（工程内换内容）
  不会 —— 否则撤销会把两份工程的片段混在一起，而每一步看起来都合法。
- **自动保存**：调度器在 `project/autosave.ts`（纯编排，单测走 `memoryRoot`），
  接线在 `ui/autosave.ts`。三条硬约定：
  1. **不轮转 `.bak`**（`saveProject({ backup: false })`）—— `.bak` 只代表「上一次手动保存」；
  2. **不入撤销栈、不 bump version、不动 `savedVersion`** —— 自动保存是磁盘行为，
     工程必须继续显示「有未保存改动」；
  3. **单飞**：同一工程同时只允许一个写入，后到的请求合并成一次；手动保存先
     `autosave.cancel()` 再 `await autosave.idle()`，并以 `canWrite:false` 让自动保存让路。
  - 有目录 → 写正式工程；无目录 → OPFS `drafts/<draftKey>.json`。正式写失败**降级**到草稿，
    底栏常驻一条 `app.autosaveDegraded`；草稿也失败才是 `error`。
  - **内容没变就不写**（`lastWritten` 比对）：没有这一层，播放视频时每两秒会重写一遍
    `project.json`。
  - 草稿恢复走 `restoreDraftProject()`：`migrateProject` → 新工程（`savedVersion: -1`）→
    删草稿。关闭工程（用户确认丢弃）时也删草稿，否则下次启动会再问一遍。
