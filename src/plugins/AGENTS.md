# src/plugins/ —— 插件子系统

清单校验 · blob 动态 `import` · 宿主与引用计数 · 缺失扫描。
**插件跑在主 realm 里，没有沙箱** —— 安全边界要如实告知用户。

**何时读我**：改 `plugins/**`；让一类新东西可被插件扩展；动加载 / 卸载时机或缺失提示时。

相关：`src/effects/AGENTS.md` / `src/algos/AGENTS.md`（两张注册表的双层化）、
`src/i18n/AGENTS.md`（`Label` 契约）、`src/project/AGENTS.md`（`plugins/` 读写）。

---

一个插件 = **工程目录 `plugins/` 下的一个 ESM `.js` 文件**，导出一个清单对象
（`format:'artmatic-plugin'` + `id` + `name` + `effects[]` / `generators[]`）。
运行期 `import(blob:)` 挂载，所以插件能带任意函数（`setUniforms`、以及
`bake`/`sim` 将来可能的工厂）—— 也所以**它跑在主 realm 里，没有沙箱**。

- **注册表是双层**：内置层（effects 走 `import.meta.glob`，algos 走显式清单）
  + 插件层。插件内的 def id 一律注册成 **`${pluginId}/${localId}`** ——
  program 名（`fx-${id}` / `algo-${id}`）因此不可能与内置撞名，
  而「缺插件」也能靠前缀判定。
- **标签契约是 `Label`，不是 `MessageKey`**（`src/i18n/label.ts`）。
  插件的名字/说明是运行期字符串，给不出编译期键。`ParamDef.labelKey` /
  `EffectEntry.nameKey` / `GeneratorDef.nameKey` 都是 `Label`，
  **必须过 `labelOf(label, tr)`**，不许直接 `tr(x.labelKey)`。
  内置的一行都不用改（字符串天然满足 `MessageKey` 分支），而所有旧的
  `tr(...)` 调用点会**编译报错** —— 那是刻意的，它保证不漏改。
- **加载挂在 `ui/project-actions.ts::openAt`**：素材读进来之后、`adoptProject`
  **之后**（引用计数的键是 `OpenProject.id`，而 id 是那一步才产生的）。
  `adoptProject` 自己不挂插件。关闭工程走 `closeProject` → `host.release(id)`，
  引用计数归零才真卸载。
- **编译校验用与运行期同名的 program**（`compileEffect` / `compileAlgoShader`
  走 `effectProgramName` / `algoProgramName`），命中的就是运行期那一份。
  需要真 GL，所以 `PluginHost` 持有可选的 `Kit`：预览装配好时
  `appState.attachPreview` 调 `host.attachKit(core.kit)` 补做校验。
  **编不过的 def 不入注册表**（保持「缺失」语义，渲染层自动透传 / 返回 null），
  只记一条 issue。
  > `dropped-uniform` 在插件这一侧**只对参数名报**（`u_<param.key>`）。
  > `compileAlgoShader` 原本把 head 的 `u_time`/`u_delta`/`u_seed`/
  > `u_resolution`/`u_aspect` 也算「被丢掉」，那对内置生成器有意义，
  > 但一个纯色插件生成器合法地什么都不读 —— 照搬会让它凭空得到 5 条
  > 「参数不会有反应」并把状态打成「部分可用」。
- **热重载要同时清掉三处缓存，漏一处就是「status: ok、画面还是上一版」**：
  1. `importRecord` 见到同 id 就短路 —— 判据必须是**源码指纹**（`sourceKey`），
     不是 id。只比 id 的话新源码根本不会被 `import()`。
  2. `Kit.quad` **按名字**缓存 program，而插件 def 的名字只由
     `${pluginId}/${localId}` 决定 —— 换了源码名字不变，直接命中旧 program。
     所以 `PluginHost.unregister`（install / remove / disable / release / 失败
     记录都经过它）必须按前缀 `dropProgramsByPrefix`，且**先于**摘注册表。
  3. `effects/runner` 本地还存着 `name → Program` 对象；`Kit` 里删掉之后它仍
     握着已 `deleteProgram` 的那一份（画面不动、无异常）。它靠
     `effectRegistryRevision()` 清空，别把那段版本检查删掉。

  症状的判别式：**换一个新的 plugin id 才会重编**。
- **按 `LoadedPlugin.fileName` 寻址，不许按 `${id}.js` 拼**。磁盘上的文件名
  可以与插件 id 不同（外部放进去的文件、用户改过名、我们自己写的是 `<清单 id>.js`
  而用户选的文件叫什么都有可能）。`importBytes` 那条路走完写盘后必须调
  `host.markPersisted(id, fileName)`。按 id 拼的表现是「点了停用/移除，
  文件没动，重开工程它又回来了」，且**没有任何报错**。
- **停用 = 把文件改名成 `<name>.js.disabled`**，不在 json 里另记一份清单
  （两份真相立刻带来「不一致时听谁的」）。代价要写在面板上：重开后那一行
  **只剩 id**，因为不导入它就读不到名字 —— 这是刻意的，停用不该再执行它的代码。
- **缺失降级已经存在于渲染层**：未知特效原样透传（`effects/runner.ts`），
  未知生成器返回 null（`algos/runtime.ts`）。缺的只是 UI 解释，
  由 `PluginMissingBanner` 补上。`findMissingPlugins` 是**插件级**的：
  装了插件但 def id 写错不会被报出来。
- **导入 / 移除插件不改工程的脏标记**。文件在写进 `plugins/` 那一刻就落盘了，
  标脏会逼用户去点保存、而保存写的是没变的 `project.json` —— 那是个骗人的动作。
  真正要提示的是「工程还没保存，插件只能临时加载」，由 flash 直说。
- **安全边界如实告知，且只有一个告知点**：`PluginImportDialog`
  （面板与提示条共用）。文案在 `pl.risk.*` —— 别弱化它。
  插件是第三方任意代码，项目**不对它做许可校验**（`CREDITS.md` 管的是
  我们自己移植进来的代码，不覆盖插件）。
- **插件 id 只是字符串，不进 `schema`**：`schemaVersion` 不抬，`project.json`
  格式完全不变。
- **测试分工**：单测管纯的部分（`plugin-manifest` / `plugin-missing` /
  `plugin-panel-model` / `plugin-files`）；`import(blob:)`、真 GL 编译、
  「特效真的画到屏幕上了」三件事**只能**在 E2E 测（`tests/e2e/plugins.spec.ts`，
  真实浏览器 + OPFS）。
- **新增一类可被插件扩展的东西**（比如将来的转场）要一次做齐三件：
  注册表双层化 + 标签放宽成 `Label` + 校验分支。少任何一件的表现都是
  「插件里写了、但界面上/画面上没有」。
- **插件生成器可以吃媒体池素材**：`asset` 型参数（值 = assetId 字符串）+ 
  `generators[].auxTextures`（宿主把素材绑成 sampler）。这是 `realtime` 唯一拿到
  外部纹理的通路 —— `setUniforms` 里写 sampler 是无效的（宿主在它之前绑定，
  而且插件没有 GL 上下文以外的上传手段）。校验三分支缺一不可：`PARAM_TYPES` 收
  `asset`、`checkAuxTextures` 要求 `assetParam` 指向**本 def** 的 asset 参数、
  `registerPluginGenerators` 透传 `auxTextures`（漏了透传的表现是「参数有值、
  sampler 恒空」，且不加任何 issue）。
- **插件的 asset 参数键进不了 `core/asset-params.ts` 的静态清单**：那张表只装内置
  def，插件键由 `app-boot.ts` 注入（`setAssetParamKeySource`）。新增一条引用修复路径
  时别忘了它 —— 否则「删了素材，插件生成器里还指着它」，而画面只是那张图一直缺席。
- **排版文档钩子（`typography.hooks`，API v2）**：
  - 三个阶段：`open`（读工程后、上屏前，只改内存）/ `save`（写盘前，改**副本**）/
    `render`（每次光栅化前，只作用于本次出图）。`render` 是唯一拿得到
    `t / frame / fps / duration` 的阶段，必须是纯函数。
  - **输入是深拷贝 + 冻结**（`frozenHookInput`）：钩子改输入会抛，而不是悄悄改掉
    store 里那份。
  - **输出必须是完整文档**，过 `coerceDocument`。抛错 / 返回非对象 / 出现未知键
    ⇒ **整条拒绝、保留原文档**，原因进 `hook-registry` 的 failures（面板可见）。
    绝不「尽力而为写半截」——那会让工程再也打不开。
  - 挂载时在合成文档上真跑一次，跑不通的钩子从注册表剔除（`hook-failed`，
    与 `compile-failed` 同口径）。它不需要 GL，所以不像着色器那样等 `attachKit`。
  - **注册表是第二张双层表**（`typography/hook-registry.ts`，id =
    `${pluginId}/${localId}`）：`install / verify / disable / enable / remove /
    release` 都要同步注册与注销。漏一处 = 停用的插件还在改文档。
  - **打开工程的挂载顺序有讲究**：插件必须在 `adoptProject` **之前**挂一次
    （引用计数用临时键 `open:<k>`），否则 `open` 钩子没有插件可用；`adoptProject`
    之后用工程 id 正式挂载，再释放临时键。放早了会卸载重导（代码执行两次）。
  - `PLUGIN_API_VERSION = 3`；**能力按 `apiVersion` 解析**，低于引入版本的声明
    （钩子 v2、面板 / 动作 / 激活 v3）**整块静默忽略**，不报错、不提示。
    v1 / v2 插件全部是发布前的测试产物，不值得为它们写兼容分支与文案。
    写**高于** 3 的版本仍然整份拒收（`bad-api-version`）——那是「用了宿主还没有
    的能力」，半个插件挂上去最难查。
  - 钩子只会被**已经装了的插件**提供：它不是给工程文件注入代码的通道。

- **面板 / 动作 / 激活（`apiVersion: 3`）**：
  - 清单在 `plugins/manifest.ts` 校验（纯层），契约类型在 `plugins/api-types.ts`
    （只 import 类型）。**动作是能力，面板只是它的视图**：每个面板按钮最终都要落到
    `actions[].run` 或 `api.typography.command`。只写在 DOM 里的能力，Agent 看不见。
  - **参数校验在 `plugins/action-args.ts`**（纯函数）：补默认值、拒绝未知键、拒绝
    类型不对与越界值。面板与 Agent 共用这一份，别在两边各写一套。
  - **激活是 (插件, 工程) 一份**。`hold(..., transient: true)` 那次挂载（`open:<n>`，
    只为 `open` 钩子）**不激活** —— 那时工程还没进 store，API 拿不到任何东西。
    最后一个真实 holder 被 `release` 时调 dispose。
  - **卸载顺序固定**：插件自己的 dispose → 摘三张注册表 → 丢 program 前缀。
    新加的清理只能放在 `unregister()` 里；调用点各写一遍必然漏一处。
  - **面板不预渲染**：`render(el, api)` 只在该面板被打开时执行。渲染抛错记
    `panel-failed`，面板体内显示错误 + 重试，插件其余部分照常工作。
  - **运行期问题必须去重**（`PluginIssue.repeats`）：一个每次变化都重渲染的面板
    能把 issues 撑到几万条，插件面板因此卡死。
  - **`PluginRuntime.createApi` 是异步的**（要先读 `plugins/<id>.state.json`），
    所以宿主激活也是异步；`apiFor()` 只返回已激活的实例，UI 走 `ensureActive()`。
  - **写只有两个入口**：`api.typography.command()` 与 `api.timeline.command()`，
    名字与 Agent 工具同名，映射表在 `ui/plugins/plugin-commands.ts`
    （`PLUGIN_COMMANDS` / `PLUGIN_TIMELINE_COMMANDS` 两张白名单）。
    撤销语义、`beforeWrite`、`coerceDocument` 全部复用控制平面，别在这里开第三条路。
    时间轴那组是 `set_params`（source / effect 两种 target）、`set_clip_props`、
    `set_generator` —— 少了它们插件只能读快照、改不了任何片段。
  - **状态文件是 `plugins/<id>.state.json`**，不进 `project.json`：上限 256 KB，
    防抖 500 ms，移除插件时连带删除。它不是工程内容，不参与脏标记，也不抬
    `schemaVersion`。
  - **图标白名单在 `ui/icons.ts`**，`manifest.ts` 不许 import 它 —— 由注入的
    `PluginRuntime.hasIcon` 回答，不认识的降级成 `puzzle` 并记 `unknown-meta`。
  - **Shadow DOM 隔离的是样式，不是权限**。插件仍然跑在主 realm，能拿到
    `document` / `window`；`pl.risk.*` 仍是唯一的风险告知点，不要弱化它。
