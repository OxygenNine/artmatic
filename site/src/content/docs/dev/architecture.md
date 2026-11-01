---
title: 架构分层与依赖方向
description: 顶层目录各自负责什么，依赖为什么只能朝一个方向走，以及一帧画面是怎么算出来的。
sidebar:
  order: 1
---

这份手册面向要改代码的人。它讲两件事：哪一层可以 import 哪一层，以及一次渲染从工程数据走到像素经过了哪些步骤。

## 主链

```
core  →  engine  →  { effects, algos }  →  render  →  { ui, lab }
                                             ↑
                                    agent ────┘
```

横向读，左边是右边的基础。`core` 里没有任何 DOM 或 WebGL，可以脱离浏览器单测；`engine` 只依赖 `core`；`effects` 与 `algos` 把定义和着色器交给 `engine` 去编；`render` 把前三者装成一台能出画面的机器；`ui` 与 `lab` 在最上面。

`agent` 站在 `render` 之上、`ui` 之下。它驱动工程，但不画界面。

## 每一层负责什么

| 目录 | 职责 | 靠什么工作 |
| --- | --- | --- |
| `core/` | 数据模型、片段几何、曲线求值、命令栈、容量预算、位掩码、颜色 | 纯 TS，无 DOM、无 WebGL |
| `engine/` | Program / Target / Pass 调度、纹理池、预览尺寸、确定性时钟、视频取帧 | WebGL2 |
| `effects/` | 声明式特效定义与 GLSL，转场目录 | 一个特效 = 两个文件 |
| `algos/` | 生成器注册表、烘焙 Worker、模拟运行时 | 四种型：bake / sim / realtime / recall |
| `render/` | 合成根：装配 Renderer + SourceManager + AlgoRuntime + EffectRunner | 主应用与 `/lab/` 共用 |
| `typography/` | 排版文档模型、光栅化、字体注册表、HarfBuzz 子集化 | DOM 与 WASM |
| `audio/` | 离线 FFT、BPM / offset 估计、波形桶、播放器 | 纯 TS 与 Web Audio |
| `exporters/` | 逐帧驱动、FrameSink（MP4 / PNG 序列 / GIF）、混流 | WebCodecs |
| `project/` | 工程目录格式、素材台账、原子写、句柄持久化 | File System Access |
| `plugins/` | 插件清单校验、动态 import、宿主与引用计数 | 运行期写注册表 |
| `agent/` | 控制平面、场景快照、工具表、应用内模型运行时 | 注入的 `ControlContext` |
| `platform/` | 宿主能力接口（浏览器 / Electron） | 两套实现 |
| `i18n/` | `tr()` + 扁平点分键表 | 真叶子，零出边 |
| `ui/` | Svelte 组件、控件库、主题与偏好 | 依赖全部 |
| `timeline/` | 时间轴本体：Canvas2D 绘制 + DOM 片段 | 与 `ui` 同层 |

规模数字会变，结构不会，所以这张表不记行数。

## 四条不许越过的边

**`render/` 必须单独一层。** 它要把 Renderer、SourceManager、AlgoRuntime、EffectRunner 装到一起，必然 import `algos/` 与 `effects/`，而这两者本来就在 `engine/` 之上。塞进 `engine/` 就成了 `engine → algos → engine` 的倒挂。它也是主应用与 `/lab/` 共用的一台机器：两边各装配一份的 bug 形态是「试炼场里这个特效好好的，主应用里同一类源不工作」，而且没有任何报错。

**`render-core.ts` 不 import `typography/`、`audio/`、`exporters/`。** 频谱源、音频特征源、脱机素材判据全部通过接口注入。否则 `/lab/` 的 bundle 会把整棵排版子树拖进来。

**`agent/` 不 import `ui/`。** 运行期实例（工程 store、插件宿主、目录句柄）都走注入的 `ControlContext`，和 `platform/` 是同一手法。它可以用 `typography/` 的纯模型层，不能用 `typography/render-dom`。

**内核不反向 import 宿主。** `mcp/` 与 `cli/` 驱动内核，内核不认识它们。这条保证了「内核是标准 Web 应用」：能在 Chrome 里打开、能用 Playwright 跑。

## 文档说的不完全对的地方

根 `AGENTS.md` 的分层图是目标，不是逐行核对过的现状。改代码之前值得知道这几个例外：

**`core` 不是零依赖。** 少数文件会取 `tr()`，`schema.ts` 还从 `typography/theme` 拿工具函数。这不违反「core 无 DOM、可单测」，但它意味着 `core → typography/theme → core/color` 是一个真实的目录级环。`schema.ts` 里那处刻意写字面量而不是调工厂函数，就是为了不把它变成运行期循环依赖。

**`platform` 不是被所有人依赖。** 实际用它的只有 `ui`、`timeline`、`exporters` 和入口 `app-boot.ts`。`platform` 自己还依赖 `core` 的类型和 `i18n` 的 `tr`。它不是最底层，是宿主能力的注入点。

**`ui` 与 `timeline` 是同一层的两个包。** `timeline` 的组件会 import `ui/app-state`、`ui/controls`、`ui/effect-picker`，`ui` 也会 import `timeline`。画成上下层会让每次改时间轴手势都不知道文件该放哪边。

还有两条弱反向边：`agent` 依赖 `exporters`（导出工具），`project/agent-history` 从 `agent/history` 借类型。改到的时候别惊讶。

## 一帧是怎么算出来的

入口只有一个：`Renderer.renderFrame(project, t)`。中间的分解在 `engine/stack.ts`：

1. 收集所有命中 `t` 的 `SourceClip`，轨道序与轨道内序决定 z。
2. 按 z 序逐层求值：曲线、transform、crop、各自的 blend 与 opacity。
3. 把命中 `t` 的 `EffectClip` 的链按 z 序插进去。默认是 adjustment layer 语义，只作用于它下方的合成结果。
4. 顶部叠加排版层。

特效链本身的执行在 `effects/runner.ts`。一个特效可能有若干环 pre-pass，最后一环的输出才是主 pass 的输入。带 `feedback` 的特效按渲染帧累积状态，所以预览必须把渲染节流到工程帧率，否则仿真会比时间轴跑得快。

特效有两种作用方式，互斥。`affectDepth` 让它吃下方 N 条启用轨的独立合成结果，`boundClipId` 让链只跑在某一个 source 片段上，执行位置在 placement 之后、blend 之前。绑定的那条不受「隔离观察」影响，因为那是这一层自己的样子。

导出不另走一条渲染路径。它用 `runExport` 紧循环调同一个 `renderFrame`，差别只在分辨率与编码器背压。

## 唯一真源

这个项目里最贵的 bug 往往来自同一件事写了两遍，逻辑写错反而是次要的。已经收口的位置：

- 合成只走 `createRenderCore`
- 导出只走 `runExport` + `FrameSink`
- Agent 的一切写操作只走控制平面
- 设计令牌只有 `src/ui/tokens.ts` 一份
- 特效清单只有 `effects/catalog.ts` 一份，缺项由单测挡住
- 生成器展示信息只有 `algos/catalog.ts` 一份
- 容量常数只在 `core/capacity.ts`
- 程序名只有 `effectProgramName` / `algoProgramName` 两处生成

新增一条路径之前，先确认它不是在第二遍实现上面某一个。

## 这套分层没有编译期守卫

没有 ESLint 规则、没有 dependency-cruiser、没有针对 import 边界的测试。`svelte-check` 查类型，单测查行为，两者都不看「谁 import 了谁」。

也就是说分层靠约定和 review 维持。加一条跨层依赖之前先回来读这张图；如果那条依赖确实合理，就把这张表和各目录的 `AGENTS.md` 一起改掉。一张只存在于文档里的架构图，一旦和代码不同步，就会开始骗人。
