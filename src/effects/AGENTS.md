# src/effects/ —— 特效与转场

**「一个特效 = 两个文件」**（`defs/` 定义 + `glsl/` 着色器），由 glob 配对强制执行，
缺一半启动报错。着色器是**惰性编译**的：语法错误在你点到它之前不报。

**何时读我**：加 / 改特效或转场；加一种 `ParamDef` 参数类型；**从外部移植特效**；
动 `prePasses` / `feedback` / `u_original` / `delayedInput` 时。

相关：`src/engine/AGENTS.md`（compositor 怎么跑这条链）、`src/ui/AGENTS.md`（特效 / 转场选择器）、
`src/algos/AGENTS.md`（参数类型的其它消费方）、`src/assets/AGENTS.md`（缩略图）、
`CREDITS.md`（移植登记与许可白名单）。

---

- **新增一个特效 = 两个文件**（定义 + GLSL）。由 `effects/registry.ts` 的 glob 配对强制执行，
  缺一半启动报错。这是硬指标 —— 摩擦成本决定这个工具三年后还有没有生命力。
- **着色器是惰性编译的**：语法错误在你点到它之前不报。所以有
  `__artmatic.compileAll()`（`effects/compile-all.ts`）覆盖特效（**主 pass + 每一环 pre-pass**）+
  realtime 算法 + 转场，E2E 断言 `failures == []`。**目录层的静态检查只能挡「结构性不可能」，语法 / 版本问题
  只有真编一次才知道。** 它是按钮与 E2E 的动作，**不在启动路径上**（122 次编译是秒级）。
  - program 名由 `effectProgramName(defId, preIndex?)` / `algoProgramName(id)` 生成，**只有一处**。
    预编译与运行期不同名 = `Kit.quad` 另编一份，预编译白做且不报错。
- **特效能拿到什么**（`EFFECT_HEAD`，`effects/shader-def.ts`；fragment 里**不得重复声明**）：
  `u_texture`（本环输入）/ `u_feedback`（本实例跨帧历史）/ `u_original`（**pre-pass 之前**的链输入）/
  `u_mask` + `u_maskOn`（外部蒙版，要写 `mask: true` 才会绑）/ `u_time`（**秒**）/ `u_delta`（= 1/fps）/
  `u_seed` / `u_resolution` / `in vec2 vUv` / `out vec4 outColor`。
  - **`u_time` 没有「累积相位」这回事。** openmosh 里带 `speed` 的特效用 `phase += dt * speed` 累加，
    那是 dt 驱动的有状态量 —— 与硬约束 1.1 冲突且 seek 不可复现。**移植时把相位算成闭式**：
    常速就在 fragment 里写 `u_time * u_speed`；要按拍同步就在 `setUniforms` 里用
    `beatAtTime(ctx.t, ctx.grid) * division` 算好当普通 uniform 传（那里拿得到 `BeatGrid`）。
  - `u_original` 堵的是「需要未处理的源」那一类（glow / ghosting / fast-mosh / motion-mask）。
- **`prePasses`**（主 pass 之前的全屏 pass 链）：第一环读本特效输入，最后一环的输出就是主 pass 的
  `u_texture`。非 `feedback` 的 pre-pass 渲染在**半分辨率浮点草稿**上，`u_resolution` 仍传全分辨率
  —— 降采样只改 tap 密度、**不改模糊半径**。带 `feedback` 的 pre-pass 用**自己的**全分辨率浮点历史
  （键 `${instanceId}:${index}`，`compositor.preFeedbackFor`）。两种历史都由 `clearFeedback()` 清。
  - **特效参数会派发到每个 pass**（上游 `drawPass` 就是这么做的）：`glow` 的 `u_cutoff`/`u_radius`、
    `blur` 的 `u_radius`、`ghosting` 的 `u_bias`/`u_scale`、`fast-mosh` 的 `u_hold`、
    `motion-mask` 的 `u_persistence`/`u_erode`/`u_blur` **都只声明在 pre-pass 里**。
    漏派发的表现是这些参数恒为 0 —— 画面明显不对但不报错。守卫：`lab.spec` 的
    「pre-pass 的参数真的生效」（`blur` 的 radius 只活在 pre-pass 里，是最干净的探针）。
  - 主 pass 与 pre-pass 的 `u_original` **都指向链输入**（pre-pass 之前的那一份），
    不是上一环的输出 —— `fast-mosh` 就靠这个区别：`u_texture` 是 pre-pass 交出的关键帧，
    `u_original` 才是当前帧。
  - **`delayedInput: true`**：这一环的 `u_texture` 换成**上一帧的链输入**。给「要拿当前帧
    和上一帧输入做帧间差分」的特效用（`kino-datamosh` 的运动估计）。链里本来拿不到它
    （`u_texture` 是上一环输出、`u_feedback` 是自身上一帧输出、`u_original` 是当前帧输入），
    而 pre-pass 自己用 `feedback` 存一帧输入也不行 —— 那存的是「上一帧它自己的输出」，
    **永远差一帧**。存储由 runner 在整条链跑完后写入（`compositor.delayedInputFor`），
    只改输入不改输出。守卫：`lab.spec` 的「delayedInput」（用 `velocity` 当探针）。
  - `linearFilter` 的实现是「设 LINEAR → draw → 还原」（`effects/runner.ts` 的 `forceLinear`）：
    GL 的采样参数在 **draw 那一刻**被捕获，单线程里前后夹住是安全的。改的是别人的贴图，务必还原。
  - `hdrFeedback` 走 `Target({ float: true })` → RGBA16F，缺 `EXT_color_buffer_float` 时**安静回落
    RGBA8**（8bit 会把逐帧低于量化步长的增量抹平，有状态模拟会 stall 成色块）。
- **`grade-*` 的「线性岛」**（调色模块，判定在 `core/grade.ts`，GLSL 在 `EFFECT_HEAD` 尾部）：
  - 中间缓冲升 16F **只提高位深，不改变编码** —— 混合模式那一套全都按 sRGB 编码值定义，
    写成「升 16F 就线性了」会把 8 种混合模式的观感一起改掉。
  - 解码只发生在调色 pass 的 `main` 内部：`col = toLinear(texel.rgb)` → 运算 → `outColor = vec4(toSrgb(col), a)`。
    一次 pass **恰好一次** decode + 一次 encode（`tests/unit/grade-island.test.ts` 挡）；
    非调色特效不许碰这两个函数。相邻两个调色模块之间会有一次 encode/decode 往返 ——
    16F 下误差可忽略，换来的是「任何调色模块都能单独插进既有链」。
  - `toLinear` / `toSrgb` 的常数由 `core/color.ts::SRGB_TRANSFER` 拼进 GLSL，
    **不要在 shader 里另写一份**（TS 侧的示波器 / LUT / UI 刻度用的是同一个真源）。
  - `contrast` 的 pivot 是**线性 0.18**，不是 0.5（0.5 只是编码域的中灰）。这个数写死在 shader 里。
- **曲线表与 LUT**（`curveTable` / `lut` 两个钩子，与 `glyphs` 同一形态：声明了 sampler 服务就会绑）：
  - `curveTable(values)` 返回四条曲线串 → `engine/curve-texture.ts` 采样成 **1024×4 R16F**
    （行序 主 / R / G / B），shader 侧 `u_curve`。曲线**不是 `ParamDef`** —— 它的数据存在
    `values['curve#master' | 'curve#r' | 'curve#g' | 'curve#b']` 里（`core/tone-curve.ts`）。
  - `lut(values)` 返回**工程素材 id** → `engine/lut-texture.ts` 上传 3D 纹理，shader 侧 `u_lut`
    （`uniform **highp** sampler3D` —— ES 3.00 里 sampler3D 没有默认精度，漏了就编译失败）+
    `u_lutOn` / `u_lutSize`。1D LUT 在解析时展开成 3D，运行时只有一条采样路径。
  - **保留键必须能到达钩子**：runner 过去只把 `entry.params` 里声明过的键放进 `values`，
    于是 `curve#master` / `lutAssetId` 根本进不来 —— 症状是「拖了曲线画面不动」，不报错。
    现在会把实例上没声明成参数的键一并带上（`effects/runner.ts`）。
- **`ParamDef.visibleWhen`** 控参数的条件可见性；特效检查器里 range / select / **checkbox** / color
  四种都必须有分支（缺 checkbox 的表现是「参数不显示」，不报错）。

### 新增一种 `ParamDef` 变体时（2026-10-04 加 `bitmask` / `pattern` 之后总结）

**参数类型有四个消费方，必须一起改 —— 漏掉任何一个都不报错**：

| 消费方 | 漏掉的症状 |
|---|---|
| `ui/Inspector.svelte`（源参数 + 特效参数**两个循环**） | 参数在检查器里**什么都不显示**（`{#if}` 链没有 `else`） |
| `lab/LabParams.svelte`（同样两个循环） | 参数在试炼场里被 `{:else}` 兜成**一个颜色选择器** |
| `lab/lab-state.svelte.ts` 的 `randomizeParams` | 「随机」按钮**不随机这一项**（静默回落 defaultValue） |
| `effects/types.ts` 的 `defaultValues` | 新片段写入时缺这个键 —— 只有自带 `defaultValue` 才没事 |
| `plugins/manifest.ts` 的 `PARAM_TYPES` | 插件声明这种类型时被**当成非法参数拒掉**（内置没事，插件侧全黑） |

（2026-10-17 加 `text` 时补齐了第五项。`ParamDef` 联合类型新增一支后，先用
`grep PARAM_TYPES` 把所有白名单找出来，别只改内置那四处。）

### `text` 参数（候选词库那类内容）

- 值就是字符串，`EffectInstance.values` 本来就允许 `number | string`，**不需要抬
  `SCHEMA_VERSION`**。
- 不可打关键帧（`evalParams` 只对 `range` 走曲线）：一段文字逐帧变形没有语义。
- 控件是 `ui/controls/TextField.svelte`，提交时机取 `change`（失焦 / 回车）——
  逐字符提交会把撤销栈塞满，一次 Ctrl+Z 只退一个字符。
- **中文内容仍然要进语言表**：`src/` 下除 `i18n/locales/` 外的中日韩字面量会被
  `tests/unit/i18n.test.ts` 的硬编码守卫挡下（「方框跟踪」的候选词库就存在
  `effects.ts` 的 `fx.boxTracker.words*` 里，逗号分隔，运行时 split）。
  这些词是**画进画面**的内容，不是界面文案 —— 放在语言表里只是为了过守卫；
  别在模块加载时 `tr()`（值会冻在那一刻的语言上）。

- 试炼场是「新参数类型的 testbed」：**它和产品端不一致，等于这个类型没有被测过**。
  所以新参数类型要在 lab 侧也加一条 DOM 断言。
- 守卫：`tests/unit/algo-params.test.ts` 遍历所有注册的生成器与特效，断言参数类型在
  已知集合内、`labelKey`/选项文案能解析、`select.defaultValue` 在选项里、
  `bitmask` 的分组位数之和 = `bits` 且默认值 < 2^bits、`visibleWhen` 引用的键
  **真的存在于同一张参数表**（`v.seedModeX` 这种拼写错误类型系统拦不住 —— `v` 是 `Record`）。
- **自研控件必须 `data-exempt`**（见 `src/ui/AGENTS.md`）——位表与绘画 canvas 都踩这条。

### 从外部移植一个特效时（2026-10-03 移植 51 个之后总结）

**照抄会静默坏掉的三类，按出现频率排**：

1. **重复声明 head 里的 uniform。** 上游 shader 常在自己的 fragment 里再写一遍
   `uniform sampler2D u_texture;` / `uniform float u_time;` / `uniform vec2 u_resolution;`
   —— 与 `EFFECT_HEAD` 重复，**直接编译失败**。移植前先搜一遍 head 里那几个名字。
   （`u_resolution` 这一条在 51 个里出现了 **6 次**。）
2. **`u_time` 是秒还是相位，以及 `speed` 是「时间倍率」。** openmosh 的
   `getEffectTime` **只对有 `speed` 参数的特效**把 `u_time` 换成累积相位
   （`phase += dt * speed`，`sync === 'beat'` 时读拍网格），**同时**把
   `u_delta` 换成 `dt * speed`。所以：def 里有 `speed` 而上游 shader 直接用
   `u_time` ⇒ **移植时必须自己把它乘出来**（`u_time * u_speed`，或用 `clockPhase()`），
   否则那个滑杆**完全失效且不报错**。反过来，shader 里本来就写了 `u_time * u_speed`
   的，**不要再乘一次**。**若 shader 还读 `u_delta`，它也要乘**（`melt` 是典型：
   只乘一个的话「下淌速度」与「愈合速度」会以不同比例跑，画面就散了）。
   - 口径：**`u_delta` 是「本特效用于动画的那个量」的每帧增量，不是固定的秒。**
     非 clock 特效那个量是秒（runner 直接给 `1/fps`）；clock 特效那个量是相位，
     `clockUniforms()` 会按 `speed` / `division` 换算好。
3. **hash / noise 的形状与 seed。** `HASH_GLSL`（掺 seed，逐帧换图案）与
   `HASH_PLAIN_GLSL`（坐标的纯函数）用途不同，拿错会让图案从「随时间爬行」变成
   「逐帧闪烁」。`NOISE_GLSL` / `FBM6_GLSL` 建在**不掺 seed** 的那支上。
   上游 shader 自带 hash 时**优先保留自带实现**：常数不同（`127.1/311.7` vs
   `12.9898/78.233`）就是不同的图案，换过去是改画面，不是「统一实现」。
   另外注意 `HUE_ROTATE_GLSL` 的 `hueRotate` 收的是**度**，上游有些 shader 自带的
   `hrot` 收的是**弧度**。
4. **`u_feedback` 要显式开。** openmosh 是「fragment 用了 `u_feedback` 就自动分配
   历史缓冲」（它查 program 的活跃 uniform），Artmatic 的协议要求写
   `feedback: true`。漏写的表现是 sampler 没人绑、采样读回未绑定纹理 ——
   像「没有拖尾」，不报错。同理任何 runner 绑不了的 sampler（如 `u_spectrum`）
   都会被 `tests/unit/effect-uniforms.test.ts` 拦下。
5. **上传纹理不许用「当前激活单元」，而且「创建」与「上传」两条路都要走 scratch。**
   `bindTexture` / `texImage2D` / `texSubImage2D` 都作用在当前激活的纹理单元上，
   而 `Program.tex()` 会把采样本依次绑到 0..n 并留下最后一个为激活态。更阴的是：
   采样器**没被编译器保留**时（如 `audio-bars` 用不到 `u_original`）`tex()` 会提前返回
   **且不递增 `texUnit`**，激活单元可能停在任何位置 —— 于是上传把某个 sampler
   指到了错的纹理上。
   - 事故一（已修）：上传把 `u_texture` 换成频谱纹理，画面变成一片红竖线
     （R8 读作 rgba=(r,0,0,1)）。修法是上传走 `scratchUnit`。
   - **事故二（2026-10-04，同一个 bug 的另一半）**：修了「上传」却漏了「**创建**」——
     `makeTexture()` 里的 `bindTexture` 同样作用在当前激活单元上，而它发生在
     `prog.tex('u_texture', ...)` **之后**，于是首次建纹理那一帧 u_texture 被顶掉，
     画面整片发红。**只在每个实例的第一帧发生**（第二帧起走已存在分支），
     所以任何连续渲染的用例都看不见它 —— 而缩略图 / 单帧导出 100% 命中。
   - **教训**：这条协议的正确形式是「**任何** bind / upload 之前先切到 scratch」，
     不是「上传时记得切」。改一个 GL 状态 helper 时，要顺着找**所有**动那个状态的地方。
   - 守卫：`tests/e2e/effect-picker.spec.ts` 的「频谱类特效没把链输入顶掉」——
     `audio-bars` 的缩略图里「红主导像素占比」必须 < 20%（修好前后实测 0.76% vs 近乎整幅）。

### 反馈类特效与「渲染帧」

带 `feedback: true` 的特效（含 pre-pass 级的）**按渲染帧累积状态** —— 每个 pass
只在渲染时步进一次，而 `u_delta` 是名义 `1/fps`。所以**渲染率必须等于工程帧率**，
否则仿真会随时间轴漂：预览跑满 rAF（60）而工程 30fps → 仿真比时间轴快一倍。
对不稳定系统（`petri`）尤其明显，直接表现成「狂闪」。

- 主应用：`app-state.tick()` 播放时把渲染节流到 `project.fps`，并把 `playT`
  **吸附到帧栅格**（`round(playT·fps)/fps`）—— 于是每个预览帧就是一个导出帧。
  暂停时不吸附（拖播放头要的是连续）。
- 试炼场：`lab-state` 的循环同样节流到 `LAB_FPS`（漏过这条，是 petri 那份 2× 的来源）。
- **已知缺口**：预览的「帧率档位」低于 100%（`previewFpsDiv > 1`）时会少渲染帧，
  反馈类特效的演化同比变慢 —— 那个档位是**性能档，不是时间档**。

### 外部蒙版：缺省是「链上混回」，写 shader 才是例外

**每个特效都能接蒙版，不用声明。** 缺省模式是在**链上**做一步：

```
out = mix(本特效的输入, 本特效的输出, mask)
```

（`compositor.maskMix`，由 runner 在特效 pass 之后补一个全屏 pass。）所以在
`EffectInstance.inputs.mask` 上接一个片段之后，`blur` / `glow` / `slices` / 81 个特效
全都「只在这一块生效」，**没有一个 shader 需要写蒙版代码**。

为什么不在 shader 内部混：出口不止一个（prePasses 的中间环、`feedback` 的历史写入、
预乘 alpha 的转场），逐个 def 写必然漏，而漏了的表现只是「接了蒙版没反应」。

- **`mask: 'input'`** 是例外：蒙版是那个特效**自己的输入**，fragment 读 `u_mask`
  （+ `u_maskOn`）。给「蒙版不是用来限制范围」的那类：色相选取拿它收窄键、碎片位移
  拿它当概率场、3D 拿它当深度。GLSL 里 `u_mask` 是 **R8 单通道**（`.r`，其余为 0），
  长边 512（`limits.maskEdge`）；没接引用时绑 1×1 全白 + `u_maskOn = 0`，数值上与
  「没有蒙版」一致，**不需要在 GLSL 里判空**。
- 两种模式都由 runner 在 `prog.use()` **之前**求出贴图（`compositor.maskTexture` 会切
  FBO / program 去渲被引用片段那一层）。pre-pass 与主 pass 都绑同一张，理由与参数派发一样。
- 数据的形状在 `core/mask.ts`（三种引用 + 通道），环与深度上限在写入口拒。
- **不要**在 shader 里对蒙版做「阈值化再相乘」以外的语义假设：它只是一张灰度图。
- `composite` 模式只在真的接了引用时才多那一个 pass；没接的实例零成本。

### 追踪叠加层（`u_overlay` / `u_boxA`）

「方框跟踪」是**唯一一个需要 CPU 侧跨帧状态**的特效。它走的是一条独立的
**uniform 协议**，不在 `EffectShaderDef` 里加字段：

```
uniform sampler2D u_overlay;   // Canvas2D 画好的框/标签/连线（straight alpha）
uniform int   u_boxCount;      // 0..12
uniform vec4  u_boxA[12];      // xy = 中心、zw = 半宽半高（0..1，**GL 空间：v 向上**）
uniform float u_boxFade[12];   // 每框的绘制不透明度（出场/消失动画）
```

- 服务是 `engine/box-tracker.ts`（`BoxTracker`）。**判据只有一条**：主 pass 声明了
  `u_overlay` 就干活 —— 与 `SpectrumTextures.bindTo` 对 `u_spectrum` 同构，
  runner 里没有 defId 分支。其余七十多个特效走早退路径，零开销。
- runner 里的调用是**两段式，顺序不能换**：
  1. `ctx.tracker?.prepare(prog, inst, inputTex, values, ctx)` —— 在 `prog.use()`
     **之前**。它要切 program / FBO / 激活纹理单元，插在纹理绑定之后会把
     `u_texture` 顶掉（本文件记过两次真实事故）。
  2. `ctx.tracker?.bind(prog, inst)` —— 在 `.tex('u_texture').tex('u_original')`
     之后，只做 `prog.tex('u_overlay', …)` 与 `uniform1i/uniform4fv/uniform1fv`。
- **掩码的几何必须取自「画到叠层上的那一份」**（`Entry.views`），不要另算：
  - `cy` 是 Canvas2D 的**左上原点**，而片元里 `vUv.y` 向上（同 `placement.frag`
    那条约定）⇒ 进 uniform 前要 `1 - cy`。写错不报错，症状是「框内效果整块
    上下镜像」，与「检测框错位」看起来一样。
  - `zw` 要乘 `BoxView.scale`（出场/消失时框在缩放），`u_boxFade` 要取
    `BoxView.alpha`。漏掉的表现是「框在动、反色块不动」「框没了、反色块还在」。
- **`Program.u()` 装不下 48 个 float**：数组 uniform 必须直接 `uniform4fv`
  （location 已去掉 `[0]` 后缀）。别试图用 `floats()` 派发。
- **框内效果只支持内置的单 pass 观感**（反色 / 黑白 / 阈值 / 色阶 / 色相 /
  像素化 / RGB 错位 / 扫描线 / 描边）。**不是**「任意已有特效」：现有特效是整帧
  多 pass 管线（`prePasses` + 私有 `u_feedback` 历史 + 半分辨率浮点草稿），
  协议里没有「按子区域求值」；按框调用要每个框一组目标 + N 倍 pass。
  要加新的观感，就在 `glsl/box-tracker.ts` 的 `interiorFx` 里加一支 + 一个
  `select` 选项，别去动特效链。
  **默认是 `none`**：整块处理在真实素材上会把画面切成灰/橙卡片，HUD 反而像
  占位符 —— 风格化的观感要让用户显式开。
- **装饰（扫描线 / 准星 / 数据条 / 纹理描边 / 连线流光 / 出场动画）全部画在
  Canvas2D 叠层上**，不进着色器。理由与标签一样：虚线、裁切、渐变、径向柔光
  在 Canvas2D 里是几行，在 GLSL 里要写一整套 SDF。它们只依赖 `t` 与方框 id
  的哈希，**没有跨帧状态**（出场动画的 `age`/`lost` 来自追踪状态，但只读）。
- **出场动画的起点不能是 0**：单帧渲染（缩略图 / 首帧）里 `age` 恒为 1，
  从 0 开始会得到「一帧没有框」的画面。所以淡入从 0.35 起（见
  `viewsFor` 的注释），配合 `EffectShaderDef.stateful`（缩略图渲染器据此
  连渲 12 帧）两处一起保证「第一帧也看得见框」。
- **反色的强度必须是 1**（或者 0）：`mix(c, 1-c, 0.5)` 恒等于 0.5 灰，
  半强度反色是一块死灰补丁。需要「弱一点」就去色或直接关掉。
- 守卫：`tests/e2e/box-tracker.spec.ts`（出框 / 换框线颜色画面跟着变 / 探针尺寸
  不随渲染档位变 / **框内效果的像素范围与框线重合**）。**不要**断言「同一 t 两渲
  逐字节相同」—— 它持有跨帧状态，seek 时清空（与 `feedback` 类特效同一处置）。

### 字形图集（`u_atlas` / `u_glyphCount` / `u_glyphCols`）

「ASCII 字符画」要往每个格子里**画字符**，而 GLSL 里没有字体。走的是与追踪叠加层
同构的一条 **uniform 协议**（不在 `EffectShaderDef` 里塞纹理字段）：

```
uniform sampler2D u_atlas;   // 字符图集，每格 64px
uniform float u_glyphCount;  // 字形数（按覆盖率升序）
uniform float u_glyphCols;   // 图集每行几格
```

- 服务是 `engine/glyph-atlas.ts`（`GlyphAtlases`）。判据只有一条：program 声明了
  `u_atlas` 就干活 —— runner 里没有 defId 分支，其余特效走早退，零开销。
- **字符序列从哪来**：`EffectShaderDef.glyphs(values)` 返回 `{ text, font }`。
  它与 `setUniforms` 并列，runner 在**每个 pass** 都调用一次（pre-pass 也能用）。
- **排序是服务做的**：栅格化后量每个字形的 alpha 均值、升序摆放。着色器只写
  `index = 亮度 × 字形数` —— **不要在 GLSL 里另排一套**，两处排序必然漂。
- 图集**不含时间、不含跨帧状态** ⇒ `onSeek()` 不用清；同一 t 两渲逐字节相同。
- 上传**不翻 Y**（与 `SourceManager.uploadImage` 相反）：图集不是按 `vUv` 直接
  采样的，行号由着色器算 —— 不翻时 `v = 0` 正好是图集第 0 行。字形内部的上下
  翻转在着色器里补（`gp.y = 1.0 - gp.y`）。
- 守卫：`tests/unit/effect-uniforms.test.ts` 的 `GLYPH_BOUND`（这三个 uniform 由
  服务写，`setUniforms` 不该碰）+ `BINDABLE_SAMPLERS` 里的 `u_atlas`。

**判定「参数有没有接上」的自动关卡**：`tests/unit/effect-uniforms.test.ts` ——
用伪 gl 跑一遍每个特效的 `setUniforms`，断言「fragment 里声明的每个 uniform 都被写到」
且「写它的函数类型与声明一致」。它守的是**协议层**（`shader-def.ts` 的 setter 助手），
新加一个助手或改一个 uniform 声明都会在这里被拦下。

> **写 uniform 的类型必须与 fragment 的声明逐字对应。** 对 `uniform float` 调
> `gl.uniform1i`（或反过来）会触发 GL `INVALID_OPERATION` 并且**静默不写** ——
> 值保持 0，功能像没做。真实事故：`clockUniforms()` 用 `uniform1i` 写 `u_sync`，
> 8 个 clock 特效的「按拍对齐」全部退回 `speed`，无任何报错（2026-10-03）。
> 自动冒烟的 `compileAll` **看不见这一类**，所以要靠上面那份静态自检。
- **出画转场**挂在 `SourceClip.transitionOut`，剪切点 `cut = clip.end`，窗口**以剪切点为中心**
  `[cut - d/2, cut + d/2)`。入画片段 = 同轨 `start` 紧邻（`|Δ| ≤ 1e-6`）的下一个 SourceClip，
  **按相邻关系解析、不存 id** —— 存 id 会引入悬空引用与它的一整套清理，而片段几何
  （push / trim）本来就会保持相邻。
  - 全部钳制在 `core/transitions.ts` 一处（窗口上限 = `2 × min(左侧可用, 右侧可用)`，
    两侧各扣掉相邻转场已占的半宽）；渲染 / store / 检查器 / 时间轴共用一份。
  - `transitionAt()` 必须在 span 过滤**之前**判 —— 窗口后半段的 t 已越过 `from.end`，
    先过滤就整段漏掉（表现是「转场只在前半段生效」）。命中后 `i++` 跳过入画片段。
  - 两侧各自把 `opacity` 烘进各自 alpha（转场着色器只认贴图，没地方接收「这一侧的不透明度」）；
    合成用**入画片段**的 blend（窗口结束后下一帧就是它，不会有跳变）。
  - 窗口内 `fadeSec` 照常生效，不做特判（会叠加成二次淡出，检查器给提示而不改机制）。
  - `SCHEMA_VERSION` 抬版本时迁移可以是**恒等**的 —— 加可选字段不需变换，抬版本号是为了让
    「旧版打开新版工程」显式报错，而不是静默丢掉转场再保存。
  - **明确不做**：跨轨转场、转场参数打关键帧、`transitionIn`。
- **GLSL 规范化**（`transitions/glsl.ts`，**运行时、不改上游文件**）两类改写：
  1. `texture2D` → `texture`、`gl_FragColor` → `outColor`。
  2. **「依赖 uniform 的全局变量初始化」→ `#define`**（ES 1.00 允许、ES 3.00 不允许：
     `global variable initializers must be constant expressions`）。这类变量是只读派生量，
     宏展开语义相同。
  判据收窄到「可机械判定」：只改引用 uniform 的初始化式，真常量全局变量一律不动。
- **目录准入**（`catalog.ts`）：许可白名单 + 名字唯一 + `vec4 transition(` 入口 +
  **`paramsTypes` 覆盖检查**（body 声明了但 metadata 里没有的 uniform → 运行时恒为 0，
  而 0 往往是退化取值）。拒收是**数据驱动**的，不是黑名单 —— 上游改了会自动放行。
- **已知陷阱**：集合里 `dissolve` 其实是**亮度驱动的烧灼**（`show = burn(from) - progress`），
  纯红 `from` 在 `p=0.5` 时整帧仍是红的。拿它写「p=0.5 应红蓝各半」会得到一个看起来像
  bug 的假失败。

---

## 转场目录的中文名与说明（对「转场名不翻译」的破例）

- **中文名与说明在 `effects/transitions/catalog-info.ts` + 语言表 `tns.*`**
  （新域 `src/i18n/locales/zh-CN/transitions.ts`，`tests/unit/i18n.test.ts` 的 `DOMAINS` 要一起加）。
  这是对「转场名不翻译」那条老约定的**破例**：转场过百 + 有缩略图之后，全是英文 id
  的列表扫不动了。折中是**两个都给** —— 显示中文名，**上游 id 一并保留**
  （列表视图 / 检查器里的等宽小字），「回上游查这条转场」的路没被堵上。
  **参数名仍然不翻译**（`pixelSize` 是 GLSL uniform 的名字，翻了就对着文档找不到）。
  `tests/unit/transition-catalog-info.test.ts` 守「每条转场都有条目 / 没有孤儿条目 /
  名字与说明互不重复 / 语言表里没有孤儿键 / 规模恰好 = 转场数 × 2」。
