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
  - `PLUGIN_API_VERSION = 2`；声明钩子却写 `apiVersion: 1` **拒收**——装上了但
    钩子永远不被调用，是最难查的一类。
  - 钩子只会被**已经装了的插件**提供：它不是给工程文件注入代码的通道。
