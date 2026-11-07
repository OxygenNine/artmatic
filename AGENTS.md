# AGENTS.md

跨 Agent 协作备忘录。

本项目采用**多层 AGENTS.md**，本文件是项目根，只写整个项目共用的开发约束和前置知识；
具体到每个功能和系统时，请阅读对应目录下的子 AGENTS.md，见§3。
**改架构、数据模型、构建方式或测试约定之前，先更新对应那一份。**

任何AGENTS.md 都只写「动手前必须知道」的东西：约束、不变量、架构坐标、会再咬人的坑。
已解决问题的来龙去脉、被推翻的方案、开发过程一律不写 —— 那些在 `git log` 与代码注释里。

---

## 0. 项目的定位和功能边界

**Artmatic** 是一款 Web 原生剪辑软件，对算法艺术和故障艺术这两个方向有特化，具体表现为
它自带的庞大特效库和生成器，以及可由 Agent 实时生成的插件系统。

不要尝试把 Artmatic 做成重型剪辑工业软件。但是项目的目标是让尽可能多的创作步骤在 Artmatic 内完成
而不是反复切换软件（最重要的例子就是排版编辑器，它占据了大约一半以上的代码量，但这也让 Artmatic 脱离了单纯的“故障滤镜小工具”定位，
所以许多功能仍然被值得在 Artmatic 内实现，并且不需要刻意地去强调它不能被做到专业级水平。

---

## 1. 硬约束（不可协商）

违反其中任何一条，架构就已经坏了，且通常要到很晚才发现。

### 1.1 时间只有一个来源

- **唯一时钟是 `t`**（帧号 / fps）。任何渲染函数都不得读 `Date.now()` / `performance.now()`。
- 预览用 rAF 驱动，导出用紧循环驱动，**两者走同一条求值路径**，差别只在分辨率。
- **禁止用 rAF 驱动导出。** 导出是 `for (i = 0; i < totalFrames; i++)`，只受编码器背压约束。

### 1.2 随机必须带种子

一律走 `core/prng.ts`：`withSeededRandom(seed, fn)`（JS 侧）/ `frameSeed()`；GLSL 侧用 `u_seed`。
禁止裸 `Math.random()`。预览与导出必须是同一次随机。

### 1.3 有状态模拟必须确定

反应扩散 / Physarum / 真实 boids 这类**有状态**算法：固定步长推进（与渲染帧率解耦）、
每隔 N 帧写状态快照、seek 时从最近快照重放。`algos/game-of-life.ts` 是现有实现，
注释里承诺 `seek(f) ≡ 从 0 顺序 step f 次`。

**帧记账与句柄状态是两件事，跳帧后必须对齐。** `AlgoRuntime` 用 `entry.frame` 记
「句柄在哪一帧」，并在 `show === entry.frame` 时**跳过 seek** 复用句柄状态 —— 这条
优化的前提是两者一致，而 `Renderer.onSeek()`（跳帧 / 清反馈）之后它**不保证**成立；
表现是「同一 t 连渲两次得到两张不同的画面」（不报错、只在回溯时才看得出）。
所以 `onSeek()` 经 `Renderer.setSeekExtra` 钩子调 `alignSims()` 强制对齐一次
（幂等，同帧时零代价）。**任何新增的 seek 路径都不许绕过 `Renderer.onSeek()`**。

**「同一 t 两渲逐字节相同」在 GPU 上不是免费的**。两只已知的鬼：

1. **非整数倍缩放采样**：源尺寸 → 帧尺寸不是整数比时（生命游戏 64×64 → 558×314、
   lab 的 853×480 → 640×360），同一帧会在**启动窗口内**出现两个稳定态；
   而 2× 精确缩放稳定。差异极小（单通道差 ≤5、几百个像素）且预热几十帧后消失，
   **视觉不可见**。实测已排除 sim 状态、uniform 派发、反馈残留（完整状态哈希逐字节
   相同）、`NEAREST` 采样。细节见 `engine/compositor.ts::placeLayer` 的注释。
2. **大参数 sin**：`fract(sin(x) * 43758.5453)` 家族（`HASH_GLSL` / `HASH_PLAIN_GLSL`）
   在自变量上百之后低位不稳 —— `slices` 的位移图案会在帧间跳，**用户能看见闪烁**
   （已改用无 sin 的 `HASH_FAST_GLSL`）。**新增 hash 优先用 `HASH_FAST_GLSL`**；
   要用 `sin` 就先做相位归约（`scanlines` 那处的写法）。

两只都会把「同帧两渲逐像素相等」的断言打成**偶发**失败（`tests/e2e/lab.spec.ts` / `tests/e2e/algo-pattern.spec.ts`
各有一条）。**别为它们改渲染代码** —— 要断言确定性，就在测量前多渲一帧丢弃。

### 1.4 主线程只做 rAF 与 uniform 写入

解码 → Worker；算法烘焙 → Worker；排版光栅化 → 异步；编码 → WebCodecs 编码器。
主线程每帧的工作量不得超过一帧预算。这是「UI 不许卡顿」唯一的实现方式。

### 1.5 内核与宿主解耦

内核是**标准 Web 应用**：能在 Chrome 里打开、能用 Playwright 跑 E2E、能热更新。
所有平台能力走 `platform/` 接口。

> **任何「只能在某个宿主壳里跑起来才能测」的功能设计，都视为设计错误。**

### 1.6 禁止堆砌防御性文案

能写「裁剪」就不要写「按百分比裁剪；剪成长条靠它」，能写「思考过程」就不要写「模型思考中，不是最终回复」。
用icon、控件、一两个词能表达的东西，就不用写一段话说明它——现代软件早就教会用户该怎么做。

### 1.7 工程真相在磁盘目录，不在 localStorage

IndexedDB 只放可丢弃的东西（缩略图缓存、UI 状态、目录句柄）。

### 1.8 不引 AGPL / GPL 代码

**本项目自身以 Apache-2.0 授权**（根 `LICENSE`，`package.json` 的 `license` 字段同值）；
引进来或移植进来的东西**保留原许可**、登记在 `CREDITS.md`。Apache-2.0 与 MIT / ISC / BSD /
OFL 兼容，所以下面这套取舍成立；**换成任何 copyleft 主许可前先重新推一遍**（移植的 MIT 代码
可以留在 Apache-2.0 工程里，反过来不行）。

- 禁止：`hydra-synth`（AGPL-3.0）、`Coollab`（GPL-3.0）
- 可用：`gl-transitions`（MIT）、openmosh（MIT）、`lucide`（ISC）、
  `mediabunny`（MPL-2.0 —— 文件级弱 copyleft，本项目 npm 装、不改其源、不分发它，因此无义务）
- **「包是 MIT」≠「每条都能用」**：`gl-transitions` 集合内每个条目自带 `license` 字段。
  `effects/transitions/catalog.ts` 有许可白名单把非宽松许可挡在目录外（测试同时断言），
  明细见 `CREDITS.md`。
- 移植 MIT 代码必须登记到 `CREDITS.md`（含二级移植来源）。这个账越拖越贵。
- `CREDITS.md` 按「**源码 / 资产有没有进仓库**」分两节：进仓库的进 §1（保留原声明），
  只借了做法的进 §2。**「仅参照，未复制」不许写在 §1** —— 那是这份账最容易变糊的地方
  （读者要能只看节标题就判断「这段抄了没有」）。

### 1.9 新功能必须 Agent 可达

任何用户能在界面里做的事，`agent/` 控制平面都要有对应的方法与工具。
**例外只有「改动 Artmatic 自身」的操作**：应用外观与偏好、工程 / 素材的存储格式、
插件安装的最终确认、导出落盘路径这类壳层动作。

判据：一个功能若只能手点，它在 Agent 眼里就**不存在** —— 而模型不会说「做不到」，
它会绕路（用 `typo_replace_doc` 硬写文档、用 `scale` 近似 3D 翻转），并给出一个
看起来对的结果。所以「接上 Agent」不是收尾工作，是功能定义的一部分：

1. 纯逻辑放对应子系统的纯函数层（如 `typography/agent-ops.ts`），可单测；
2. 控制平面加方法（`src/agent/`，校验前置、走 `store.commit`）；
3. 工具表两处同加（`src/agent/tools.ts` + `mcp/tools.mjs`），描述写清形状与单位；
4. 能力清单里列出来（`getCapabilities()` / `get_typography_capabilities()`）—— 模型只信这张表；
5. **读回形状必须能被写入端原样读回**（`detail:full` → 写回不丢字段）。

自查一句：**能力清单里有它吗？工具描述里写了它的形状吗？** 没有 = 模型只能猜，
而猜错通常是静默无效。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 语言 / 构建 | TypeScript（strict）+ Vite |
| UI 框架 | Svelte 5 runes（时间轴本体 Canvas2D 自绘，框架只管面板） |
| 渲染 | WebGL2 + GLSL ES 3.00 |
| 导出编码 | **WebCodecs**（H.264 + AAC 封 MP4，mediabunny）+ PNG 序列逃生舱 + GIF（`gifenc` 软编） |
| 音频分析 | 自研 TS 离线 FFT（对齐 `AnalyserNode` 的 dB 映射） |
| 排版出图 | snapDOM + HarfBuzz WASM（字体子集化 / 字形轮廓「文字转路径」）；本机字体走 Local Font Access |
| 图标 | Lucide（`@lucide/svelte`，ISC）。UI 图标走 `ui/icons.ts` 的按组件导出（可 tree-shaking）；排版编辑器的「插入图标」走全量清单 + 懒加载，见 `src/typography/AGENTS.md` |
| 样式 | Design Token 单一真源在 TS（`ui/tokens.ts`） |
| 工程持久化 | File System Access API；E2E 跑在 OPFS 上 |
| 文案 / i18n | 自研 `src/i18n/`，无第三方库 |
| 测试 | Playwright（E2E）+ vitest（**只测纯函数**） |

**发行版是桌面壳，安装包 / 签名 / 自动更新仍不做。** `desktop/` 是**真正的宿主**
（`preload.cjs` + `host.mjs`）：`pnpm run desktop` 起壳，`desktop:probe` 跑能力探针，
`desktop:artifact` 打免安装便携目录，`desktop:smoke` 在打包产物里验 preload / IPC /
`artmatic-asset://` 的 Range（可配 `ARTMATIC_SMOKE_VIDEO` 验路径 linked 视频 + 打包）。
`src/platform/electron.ts` 只覆盖浏览器做不到的事（原生路径、按范围读、文件监视、窗口级动作），
其余直接复用 `browserPlatform`；页面拿不到 `fs`，主进程只认用户选过的路径 + token。
结论见 `docs/electron-compat.md`（官方构建自带专有编解码器，**不需要**塞 ffmpeg）。
Web 版（`pnpm run build` 的 `dist/`）自此定位为**开发与试玩**，不再追 Firefox / Safari 适配。

窗口**没有原生菜单，也没有原生标题栏**：`.topbar` 就是标题栏，右侧让给系统窗口按钮的宽度由
`navigator.windowControlsOverlay` 量（写死 px 必错位）。**改顶栏或往里加控件必须看 TopBar 里
`:root[data-wco='on']` 那几条 `app-region` 规则** —— 新控件默认落在窗口拖拽区里，点击会被吞掉，
而且不报错。壳层动作（开发者工具 / 重新加载 / 退出）只有「设置 → 桌面」一个入口，那一页只在
`platform.shell` 存在时出现。窗口图标有两处：`desktop/icon.ico`（`scripts/make-icon.mjs` 从品牌 SVG 生成）
喂给 `BrowserWindow.icon`，`desktop/build.mjs` 再用 `resedit` 把它写进 exe 的 PE 资源 —— 少改一处就有一处是 Electron 的图标。
细节见 `docs/electron-compat.md` §3.6。

---

## 3. 架构分层

```
src/
├── main.ts        入口：能力闸门（WebGL2 + showDirectoryPicker）通过后才动态 import 装配
├── app-boot.ts    装配根（主题 → store → mount，import 顺序有讲究，不要重排）
├── core/          纯 TS，无 DOM / WebGL，必须可单测
│                  schema · 曲线求值 · 命令栈 · 片段几何（clips）· 转场钳制 · prng
│                  · 颜色（color.ts：sRGB 传输函数是唯一真源）· 位掩码（bitmask.ts：位序映射 + B/S 打包）
│                  · 调色（grade.ts：`grade-*` 前缀扫描 · 16F 给不给 · 线性岛规则；
│                     tone-curve.ts：色调曲线 + 单调三次采样；lut-cube.ts：`.cube` 解析）
│                  · 容量预算（capacity.ts，**唯一策略处**，见 `src/core/AGENTS.md`）
├── engine/        WebGL2：Program / Target / Pass 调度 · 纹理池 · 预览尺寸 · 确定性时钟
│   ├── media-assets.ts   运行期素材登记（图片 = 已解码 canvas；视频 = Blob / File 引用）
│   ├── video-source.ts   视频取帧：mediabunny + WebCodecs + 有界纹理缓存
│   ├── video-budget.ts   视频缓存的淘汰决策（纯函数 + 单测，见 `src/core/AGENTS.md`）
│   └── glyph-atlas.ts    字形图集（u_atlas）：ASCII 字符画的 CPU 侧栅格化
├── effects/       声明式特效定义 + GLSL
│   ├── defs/ · glsl/     「一个特效 = 两个文件」，glob 配对，缺一半启动报错
│   ├── shader-def.ts     着色器协议：EFFECT_HEAD · 共享 GLSL 头 · floats/colorVec3 · program 命名
│   ├── registry.ts       glob 配对 + 批量编译
│   ├── compile-all.ts    全量编译守卫（E2E 与按钮用，不在启动路径上）
│   └── transitions/      gl-transitions 目录 + GLSL 规范化 + runner
├── algos/         算法生成器注册表 + 烘焙 Worker（五型：bake / sim / gpu-sim / realtime / recall）
│   ├── particles/       通用粒子内核（GPU 状态纹理 + createParticleGenerator 复用 API）
│   ├── shader-lib.ts     realtime 生成器的头（ALGO_HEAD）· intResParam · program 命名
│   ├── pattern-codec.ts  手绘位图的编解码（永不抛 / 自带尺寸 / 跨环境稳定）
│   ├── pattern-presets.ts 标准种子图案（滑翔机 / 滑翔机枪 / 脉冲星 …）
│   └── symbology/        机器可读符号编码（QR / Code 128 是完整标准，另五种结构复刻）
├── render/        ★ 合成根（见 `src/render/AGENTS.md`）
├── audio/         离线 FFT · BPM/offset 估计 · 波形桶 · 播放器
├── typography/    TypographyDocument 模型 + 光栅化后端 + 字体注册表 / HarfBuzz 子集化
│                  + `text-outline.ts`（文字转路径：Range 布局 + 字形轮廓）
│                  + `agent-ops.ts`（控制平面用的写入原语，纯函数）
├── timeline/      时间轴 UI（Canvas2D 绘制 + DOM 片段）
├── exporters/     export-runner（逐帧驱动）+ frame-sink（webcodecs / png-sequence / gif）
│                  + mixdown（纯混流）+ gif-plan（GIF 的纯计算：尺寸 / 抽帧 / 延迟）
├── project/       工程目录格式 · 素材台账 · 原子写 · 句柄持久化（含 plugins/ 读写）
├── plugins/       插件子系统（清单校验 · blob 动态 import · 宿主与引用计数 · 缺失扫描），见 `src/plugins/AGENTS.md`
├── i18n/          文案表 + tr() + Label 契约
├── platform/      Platform 接口（浏览器实现）
├── assets/        静态资源：三套缩略图（特效 / 转场 / 生成器）+ 品牌 mark，见 `src/assets/AGENTS.md`
├── agent/         Agent 控制面（能力声明 · 场景快照 · clip 工厂 · 排版写入 · 插件作者面）
│                  + `llm/`（应用内模型运行时：transport / protocol / providers / session / executor）
│                  装配在 `app-boot.ts`，**不依赖 ui/**，见 `src/agent/AGENTS.md`
├── types/         跨层共用类型
└── ui/            Svelte 组件 + 控件库（controls/）+ 主题与偏好状态 + `agent/`（对话抽屉）
                   三个工程视图（时间轴 / 排版 / 调色）**共用同一块 `Preview`**：
                   换页只是 `display:none`，绝不卸载（卸载 = 丢 WebGL 上下文）

lab/               试炼场：第二个 HTML 入口（/lab/），见 `lab/AGENTS.md`
tests/             Playwright（e2e/）+ vitest（unit/），见 `tests/AGENTS.md`
scripts/           e2e 运行器 · 缩略图 / 主题色生成 · 容量探测 · LLM 代理 · CLI 打包 · 变异分诊
desktop/           Electron 宿主（preload/IPC/asset 协议/监视）+ 便携目录；仍不是分发路径
docs/              设计说明与专题笔记（agent 控制面 / 排版光栅化 / Electron 兼容 / 0.3 加固计划）
mcp/ · cli/        宿主侧入口（MCP server / CLI）：它们驱动内核，**内核反向不许 import 它们**
```

**依赖方向**：`core` 不依赖任何东西 → `engine` 只依赖 `core` →
`{effects, algos}` 依赖 `engine` → **`render` 依赖 `{engine, effects, algos}`** →
`ui` 与 `lab` 依赖全部。`platform` 被所有人依赖。
`plugins/` 在 `render` **之上**：它往 `effects`/`algos` 的注册表里写，只被
`ui` 装配（`render-core` 与 lab **不认识插件**，所以 lab 不需要插件也能跑）。
`agent/` 在 `render` 之上、`ui` 之下：它 **可以** import `typography/` 的纯模型层
（`document` / `shapes` / `svg-gen` / `theme` / `agent-ops`），**禁止** import
`ui/`、`typography/render-dom`、`project/plugins` —— 运行期实例（含插件宿主、
目录句柄）全部走注入的 `ControlContext`（与 `platform/` 同一手法）。

> **`render/` 为什么必须单独一层**：它装配 Renderer + SourceManager + AlgoRuntime +
> EffectRunner，因而要 import `algos/` 与 `effects/` —— 而这两者本就在 `engine/`
> **之上**。放进 `engine/` 会形成 `engine → algos/effects → engine` 的层次倒挂。
> 它是**合成根**：主应用与 `/lab/` 共用同一份 `createRenderCore`，两边各写一份的
> bug 形态是「试炼场里好好的、主应用里某类源不工作」，而且不会有任何报错。
> 它刻意**不 import** `typography/` `audio/` `exporters/` —— 那会把整棵排版 / 音频
> 子树拖进 lab 的 bundle 图。

`core/` 是全局关键路径 —— **它定死之前不要写时间轴 UI**。

---

## 4–5. 子系统规则地图

**原 §4（数据模型）与 §5（关键约定）的每一节都已下放到对应的子系统文件，本表就是它们的入口。**
本文件只留「不管改哪里都必须遵守」的部分；具体到某个目录的约束在那一份自己的
`AGENTS.md` 里 —— **动手前先读它**。（某个目录没有规则文件 = 它还没有专属约束。）

| 目录 | 规则文件 | 什么时候必须先读 |
|---|---|---|
| `src/core/` | `src/core/AGENTS.md` | 数据模型 · 片段几何 / trim / 切分 · 重叠策略 · 关键帧与包络 · 容量预算 |
| `src/engine/` | `src/engine/AGENTS.md` | 合成求值（z 序）· 影响深度 · 预览尺寸 / 全屏 |
| `src/effects/` | `src/effects/AGENTS.md` | 加改特效 / 转场 · `ParamDef` 参数类型 · 从外部移植 · `prePasses` / `feedback` |
| `src/algos/` | `src/algos/AGENTS.md` | 加改生成器 · sim 状态 / 快照 / 步进预算 · 默认值 · 音频特征 |
| `src/render/` | `src/render/AGENTS.md` | 动 `createRenderCore` · 加离屏渲染器 |
| `src/agent/` | `src/agent/AGENTS.md` | 控制平面 / 工具面 / 应用内 LLM · 插件作者面 · 排版写入 · 一轮一笔撤销 |
| `src/audio/` | `src/audio/AGENTS.md` | 音频分析 / 特征 · 播放器 |
| `src/typography/` | `src/typography/AGENTS.md` | 排版文档模型 · 光栅化 · 字体子集化 · 配色方案 · 脱机媒体 |
| `src/ui/` | `src/ui/AGENTS.md` | 面板与控件 · 抽屉 / 工具栏 / 媒体池 · 设计 token · 选择器 · 界面实时性 |
| `src/ui/typography/`（`src/ui/ribbon/` 也看它） | `src/ui/typography/AGENTS.md` | 排版编辑器 · Ribbon 布局 · 取色入口 · 元素手势 |
| `src/timeline/` | `src/timeline/AGENTS.md` | 时间轴重绘 · 拖拽 / 框选手势 |
| `src/exporters/` | `src/exporters/AGENTS.md` | 导出与编码 · GIF · 落盘方式 |
| `src/project/` | `src/project/AGENTS.md` | 保存 / 打开 · 素材台账 · 句柄与权限 |
| `src/plugins/` | `src/plugins/AGENTS.md` | 插件加载 / 卸载 / 缺失 / 安全边界 |
| `src/i18n/` | `src/i18n/AGENTS.md` | **任何文案改动** · 加域 / 加语言 |
| `src/assets/` | `src/assets/AGENTS.md` | 三套缩略图资源与它们的生成脚本 |
| `lab/` | `lab/AGENTS.md` | 试炼场入口 · 分辨率档位 · 批量导出 |
| `tests/` | `tests/AGENTS.md` | 写测试 · 加守卫 · 选回归范围 |
| `tests/e2e/` | `tests/e2e/AGENTS.md` | 写任何 E2E 之前 |

> **规则冲突时就近优先**：离代码最近的那份说了算；但**硬约束（§1）永远以本文件为准**。
>
> ⚠️ **已核实（2026-10-19，官方 Rules 文档）**：CodeBuddy 只自动加载**项目根**的
> `CODEBUDDY.md`；根 `AGENTS.md` 仅在**不存在** `CODEBUDDY.md` 时被全文注入（两者共存时
> 本文件整份失效）。子目录的 `AGENTS.md` / `CODEBUDDY.md` 不在承诺范围内 ⇒ 按上表主动读。
> **禁止在根新建 `CODEBUDDY.md`**；要让子规则被自动发现，走 `.codebuddy/rules/<name>/RULE.mdc`
> （`alwaysApply: false` + `description`，正文只写「先读 `src/x/AGENTS.md`」）。

### 五条跨目录铁律（其余细节都在上面那张表指向的文件里）

1. **容量常数只在 `core/capacity.ts`**（内存 / 显存上限）—— 别在别处另写一个数。
2. **翻译函数叫 `tr()`，不叫 `t`** —— `t` 在本项目里是帧号。
3. **导出必须走 `runExport` + `FrameSink`** —— 不要另写一条逐帧循环。
4. **合成只走 `createRenderCore`**（主应用与 `/lab/` 同一份）—— 不要各装配一台。
5. **Agent 的一切写操作只走控制平面**（`src/agent/`）—— UI 面板与 MCP 网关都只调它；
   不要在 `ui/agent/` 里直接改 `ProjectStore`，也不要给它开「执行任意代码」的口。

---

## 6. 开发与测试

```bash
pnpm install         # 唯一的装依赖方式（真源是 pnpm-lock.yaml）
pnpm run dev         # Vite dev server（纯浏览器，http://localhost:5173）
pnpm run build       # 生产构建（产出 dist/，静态站点）
pnpm run preview     # 预览构建产物（http://localhost:4173）
pnpm run serve       # 用 npm 版运行时起 dist（验发布形态，见下方「npm 发布形态」）
pnpm run check       # svelte-check 类型检查
pnpm run test        # vitest，只测纯逻辑（配置里限死 tests/unit，不收 e2e）
pnpm run test:mutate # Stryker 变异测试（见 `tests/AGENTS.md`）：逐处改错源码再跑测试，报出「假守卫」
pnpm run test:e2e    # scripts/e2e.mjs：自 build + 自起 preview + Playwright（系统 Chrome）
pnpm exec vitest run tests/unit/xxx.test.ts   # 只想跑一个测试文件
node scripts/e2e.mjs tests/e2e/x.spec.ts      # 只跑一个 E2E（参数原样转给 playwright test）
pnpm run capacity    # 打印本机内存 / 显存探测（页面读的是 /__capacity.json）
pnpm run fonts:sfnt  # 内置字体 woff2 → TTF（文本转路径要 SFNT；产物已提交）
pnpm run cli new ./p # CLI（new / validate / clip add / diff / render），首次按需 SSR 打包
pnpm run mcp         # MCP server（stdio）：stdout 是 JSON-RPC 通道，不能往里打日志
pnpm run desktop     # Electron 探针壳（先 build）；desktop:probe 加探针 + 截图
```

官网是独立子项目 `site/`（Astro + Starlight），**不进主构建**，也不共用 `dist/`：

```bash
pnpm run site:dev    # site/ 的 dev server（http://localhost:4321）
pnpm run site:build  # 产出 site/dist（CI 里由 .github/workflows/pages.yml 发布）
```

三条容易踩的：

- **`pnpm run site:*` 会自动先跑 `gen`**：`tokens.css` / `stats.json` / `content/docs/api/` 都是生成物（已 gitignore），分别来自 `src/ui/tokens.ts`、`src/` 的实数、TypeDoc。`gen` 里有两个脚本要直接 import `.ts` 源文件，走 `tsx` 而不是裸 `node`。
- **本地验子路径部署要关掉 MSYS 的路径转换**：`MSYS_NO_PATHCONV=1 BASE_PATH=/artmatic pnpm run site:build`。不关的话 Git Bash 会把 `/artmatic` 改写成 `C:/Program Files/.../artmatic`，构建会在 `api/agent` 路由上报 `NoMatchingStaticPathFound`。
- **首页的界面图是脚本截的**：`cd site && pnpm run shots`（先起 `pnpm run dev`）。手截的图会随界面变化悄悄过期，脚本至少能重跑。
- **首页版式只有一套坐标**：`.board`（单一宽度 1200）负责左右竖线与横线的外延短头，`.row` 是 12 栏网格，**竖线只写在带 `.vr` 的单元上**。别在 section 上另加 border —— 那正是「两端不接触其它线条的悬空分隔线」的来源。
- **首页的动态画面不 import 主应用任何模块**：`home/AlgoCanvas.svelte`（WebGL2，lyapunov / mandelbrot，`data-theme=light` 时把同一张图换算成「纸上的墨」）与 `home/AsciiField.svelte`（2D canvas 字符场）。那条 import 链会经 i18n 拉到 `$state`，在 Astro 下编译不过。

**构建期注入**（`vite.config.ts`，dev 与 preview 两侧，`build` 里没有）：`__APP_VERSION__` 由
`package.json` 注入；`GET /__capacity.json` 给本机真实内存 / 显存（拉不到则退回保守默认）；
`/__llm/*` 是直连失败时的同源代理回落。纯静态部署按「三项都不存在」理解。

**npm 发布形态**（`npx artmatic` / `npm i -g artmatic`）：包内只有预构建的 `dist/`、
`bin/artmatic.mjs` 与 `server/serve.mjs`（零依赖 `node:http`），`package.json` 的 `files`
是白名单，`prepack` 负责构建。五条不动摇的：

- **`dependencies` 必须为空**。运行时只有预构建的 `dist/` 加 `node:http`，一个包都不需要；
  构建期依赖一律写 `devDependencies`。0.3.0 把它们写在 `dependencies` 里，`npx` 会连带
  装 34 个包 / 40 MB / 9836 个文件、约 25 s；挪走之后是 1 个包 / 12.5 MB / 3 s。
  往 `dependencies` 里加东西之前先问一句：`dist/` 里已经打包了，运行时真的还要它吗？
- **只 bind loopback**（默认 `127.0.0.1`）：非 loopback 的 http 源不是 secure context，
  `showDirectoryPicker` / WebCodecs 会静默缺 API —— 页面照开，工程打不开、导不出。
- `/__capacity.json` 由 `serve.mjs` **复用** `scripts/capacity.mjs` 提供，覆盖文件读
  **cwd**；派生规则仍只在 `core/capacity.ts`，别在服务端再算一份预算。
- `/__llm` 与 dev / preview **同一份实现**（`scripts/llm-proxy.mjs`），只是路由表读生成的
  `server/llm-routes.json`（`pnpm run gen:llm-routes` 从 `PROVIDERS` 转录，`build` 会跑，
  单测断言它与 `PROXY_ROUTES` 一致）。**别手写第二份**：漏一家的表现是「那家在 npm 版里
  连不上、回 404」，而 dev 里一切正常。
- **发 dist 就是分发打包进去的第三方代码**（mediabunny 是 MPL-2.0，`CREDITS.md` §1 的前提
  「只 npm 装、不分发」在这里不成立），`CREDITS.md` 必须进 `files`。

> **包管理器只有 pnpm。** `package.json` 的 `packageManager` 声明了版本，lockfile
> 只有 `pnpm-lock.yaml` 一份（`bun.lock*` / `package-lock.json` / `yarn.lock` 已进
> `.gitignore`）。**不要用 `npm` / `yarn` / `bun`** —— 它们会写出自己的 lockfile，
> 与 `pnpm-lock.yaml` 分叉；两边版本一旦不一致，症状是「本机好好的、别人装出来不一样」，
> 而且**不会有任何报错**。
>
> 这不是假想：`b32d191`（引入 MCP 那次）用 npm 装了 `@modelcontextprotocol/sdk`，
> 只更新了 `package-lock.json`，真源的 lockfile 从此落后一个提交 —— 直到 2026-10-11
> 才补上。**装了依赖就一定要更新 `pnpm-lock.yaml` 并一起提交**：用 `pnpm add` /
> `pnpm remove`，不要只改 `package.json`。
>
> **直接依赖写死精确版本（不带 `^`）**，值与 `pnpm-lock.yaml` 的解析结果一致 ——
> 覆盖掉 lockfile 被删、合并冲突这类场景。加依赖用 `pnpm add pkg@x.y.z`，要升级就
> 整批升并跑一遍 `pnpm run test`。
>
> **workspace 成员写在 `pnpm-workspace.yaml` 的 `packages` 里。** pnpm 不读
> `package.json` 的 `workspaces` 字段 —— 按 npm 的习惯写在那里，`site/` 会被当成
> 无关目录，症状是它自己的依赖根本没装。
>
> **依赖的安装脚本默认被拦。** 只有 `pnpm-workspace.yaml` 的 `allowBuilds` 里点名的包
> 才执行 `postinstall`（mapping 形式：`pkg: true`；旧的 `onlyBuiltDependencies` 已不生效）。
> 新依赖若要下载平台二进制（`sharp` / `esbuild` 这类），漏登记的症状是运行时缺文件，
> 安装时**不报错**。
>
> `electron` 44 起没有 `postinstall`（`allowBuilds` 里写它没有意义），二进制走单独的
> `install-electron` bin；`desktop` / `desktop:artifact` 脚本已内置这一步。它在国内直连
> GitHub release 会报 `TypeError: fetch failed` —— 先设
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再跑。

> `test:e2e` **不走** playwright 的 `webServer` 配置：它经 shell spawn 长驻进程，
> 在部分沙箱里整个进程树会收到 SIGTERM（runner 零输出暴毙）。`scripts/e2e.mjs`
> 全部用 `process.execPath` 直接 spawn node 绕开。
> Playwright 浏览器下载慢 / 不稳时，装依赖用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
> （我们用系统 Chrome，`channel: 'chrome'`）。

---

## 7. 未决问题

1. **`ProjectStore.addTrack` 的命名与位置自相矛盾**：命名 `V${n}`（暗示 V 号越大越靠前）
   与 `push` 到数组末尾（z 最低）冲突。用户新建轨道后加特效片段会踩到「特效看不见」。
   改法二选一：保留位置改命名，或改成 `unshift`。**未拍板。**
   相关的 E2E 缓解已落地（用 `.last()` 或按轨名定位，见 `tests/AGENTS.md`）。
2. **有状态模拟的 seek 回放与顺序播放不一致（真问题，未定位）**：
   `生命游戏：seek 回退再前进与顺序播放逐像素一致` 偶发 `diff = 102`，
   差异形状完全固定（34 个像素、同一行 y=78、x ∈ [195,359]），**先于转场功能存在**。
   单测里 `seek ≡ 顺序推进` 被钉死，所以嫌疑在**渲染路径**（R8 上传 / tint pass / `outPool`
   复用）而不在 `lifeStep` 本身 —— 但那只是排除法。
   用户可见性：单行 34 像素、只在「先回退再前进」路径上出现，预览几乎看不出。
   **但导出与预览走的正是这两条不同路径，所以它不是纯粹的测试噪声。**
   **不要为了绿而放宽这条断言。** 复现：`for i in 1 2 3; do node scripts/e2e.mjs algos.spec; done`
   （单跑常常绿，全量跑才挂 —— 负载相关）。
   > **更便宜的复现（Wave 2）**：`sim` 生成器**根本不用回退** —— 同一个 t 连渲两次就差
   > （Brian's Brain 恒差 15 字节、沙堆 489 字节，每次数值都一样）。`onSeek()` 不碰 sim、
   > 单测里 `seek ≡ 顺序推进` 逐字节相等 ⇒ 嫌疑固定在渲染层（R8 上传 / tint pass / `outPool`）。
   > 处置：`tests/e2e/algo-sim.spec.ts` 不断这条，确定性交给单测 —— **不等于问题解决了**。
3. **素材重定位 UI**：`auditLedger` 能检出 `missing` / `changed` 并在「工程」面板列出来，
   但**只能报告不能修**。缺的动作是「重选这个文件」→ `showOpenFilePicker()` → 比对哈希 →
   更新台账并回写工程。
4. **打开工程时图片 / 音频仍是全量读进内存的（视频已解决）**：视频在导入 / 打开时
   只留 `File` / 句柄 / 本地路径（linked），保存走 `writeStreamAtomic`。但图片 / 音频
   仍整份读回 —— 它们本来就要整份喂给 `createImageBitmap` / `decodeAudioData`。
   大音频（几百 MB 的 WAV）仍会顶到堆；流式解码不在本轮范围。
5. **`analysis/` 与 `thumbs/` 只建了目录**，路径规则就位，缓存还没落地。
6. **视频解码在无 GPU / 不支持的容器时没有兜底文案**：失败只记进 `stats().failures` 与
   `console.error`，界面表现为「这一层不出画面」。应当在底栏给一条 `err.video.unreadable`。
7. **OPFS 的配额**：E2E 跑在 OPFS 上，而 OPFS 受浏览器存储配额约束（用户选的目录不受限）。
   现在只有几 KB 假素材所以没碰到；将来给 E2E 塞真实视频素材前先看
   `navigator.storage.estimate()`。
8. **`tr()` 的响应式路径尚未被真正验证过**：只有 zh-CN 一门语言，`setLocale()` 没有可切换的
   目标，所以「切语言 → 界面自动重渲」**只有设计依据、没有实测**。在那之前不要把 `src/i18n/AGENTS.md` 的
   机制描述当成已验证的事实。
9. **`html-in-canvas`（排版后端的下一个档）**：本机 Chromium 上捕获路径可用且快得多，
   但上传路径（`texElementImage2D` 等）拒绝所有入参，API 仍在改。
   **不为其设计架构，但在 `TextRasterizer` 后面留好了位置**（snapDOM 3.x 自己就有
   `engine: 'html-in-canvas'`，通了一个选项就能切）。
10. **不可子集化的字体（woff2）+ 动画文档的逐帧成本**未测。woff2 通常只有 TTF 的 30–50%，
    所以不是「上百毫秒」那个量级。真要遇上，对策是引导用户换 TTF/OTF，或用「转为图片」
    把它冻成静态资源。
11. **大工程的保存校验会静默降级**：`project/fs.ts` 里 `> 4 MB` 只比长度、
    `> 64 MB` 干脆不读回（`verified: 'none'`），而 `verified` **不进 UI** ——
    保存提示只看 `warnings`，于是「磁盘写坏」与「保存成功」在界面上长得一样。
    修法：把 `verified !== 'hash'` 并进保存提示。触发条件是大工程（几十 MB 的
    `project.json`），现在没踩到，但它是**数据安全**那一类。
12. **超上限的静默夹小没有提示**：`maxUploadWidth` / `rasterEdge` 由容量派生，但「8K 缩到
    4096」只是变糊，没有 UI 说出来。修法：素材 / 排版面板给一条一次性提示。
13. **撤销栈按步数裁，不按字节裁**：`undoSteps` 已按可用内存派生（见 `src/core/AGENTS.md`），
    但每条记录是**整份工程 JSON 快照**，所以「能存几步」其实是工程大小的函数。
    修法：字段级/增量快照，或直接按字节预算裁（`pushUndo` 里已经有钩子）。
14. **两处近义提示没有统一**：`app.beatAnchorTip` 与 `insp.anchorTip` 只差斜杠空格。
    同一功能两份 tooltip 是维护负担，合并需一次独立的文案改动。
15. **文字转路径的剩余边界**：系统字体已走 Local Font Access（`queryLocalFonts()`
    → `FontData.blob()`）解决，变量字体按 `wght` 轴实例化。仍未覆盖：
    ① **用户导入的 woff2** 拿不到 SFNT（提示换成 TTF/OTF）；
    ② **CSS 通用族**（`sans-serif` / `system-ui`）没有具体族名可匹配；
    ③ **合成斜体** 拒绝转换（没有可复现的倾斜角）；
    ④ 平台若把 `family` 只给本地化名字（如「微软雅黑」）而文档里存的是英文名，
     `pickLocalFont` 的 fullName / PostScript 回落能兜住大部分，但兜不住全部；
    ⑤ 第一次查询要枚举整机字体（Windows 实测 3 秒），只是在**一次会话**里付一次。

---

## 9. 协作约定

- **改架构 / 数据模型 / 构建方式 → 先更新对应那一份 `AGENTS.md`**（受影响的子系统 + 必要时改根地图）。
- **新开一个子系统目录、或给某个目录加规则文件 → 在根 AGENTS.md 的「子系统规则地图」里补一行**，否则它等于不存在。
- 多个 Agent 可能并行操作本项目。`core/` 的接口变更是高冲突操作，动手前在 commit message
  里写清楚。
- 提交信息用中文，格式：`模块: 做了什么`。例：`core: Curve 增加 beatAnchor 与三种 envelope 模式`
- **不要把 `.workbuddy/`、`.claude/`、`.codex/`、`.trae/` 之类的 Agent 工作目录及文件写进任何地方**（本文件、README、代码注释都不行）。
- **优先留注释解释「为什么」**，尤其是踩过的坑。那是参考代码里最有价值的部分。
