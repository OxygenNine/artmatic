# Artmatic 0.4.0：色彩更新 | Please Can I be, Please Can I be, Colourful and Free

超大规模更新。不按版本切阶段，按**依赖**切。每节标题后面的箭头指向真正的阻塞项。
发布节点不预设：P0+P1 跑通即具备发布条件，P2 之后继续。

判据一律写成可测的，不写「效果良好」。

---

## 依赖图

| 阶段 | 内容 | 阻塞于 | 完成判据 |
|---|---|---|---|
| P0 | 色彩管线底座 | — | 调色链中间缓冲为 16F；编解码函数单测通过；无 float 设备上有可见降级 |
| P1 | 调色 + 示波器 | P0 | 一级校色四组控件 + 曲线 + LUT 可用；示波器读数与探针回读一致 |
| P2 | 外部纹理 / 蒙版 | —（与 P0 并行） | 一个特效读到另一片段的输出当 mask；环在 store 层被拒 |
| P3 | 参数求值统一 / 调制 | P2 的求值收口可先做 | ✅ `f(t)+g(t)` 可表达；求值点只剩 `resolveParam` 一条路径 |
| P4 | 3D 场景图 | P2（深度当蒙版） | 两个生成器共享镜头、互相遮挡；uniform 无撞名 |
| P5 | 排版镜头 | — | 2.5D 视差 + 窗口裁剪；拉近 4× 不糊 |
| P6 | 特效 4 项 | P2（碎片位移） | 各自独立可渲；预览与导出逐像素一致 |
| P7 | 生成器 7 项 | P4（后三项） | 按底座复用率顺序落地 |
| P8 | Agent / 插件 | P9 的 skill 底座 | 手写 skill 可加载；插件能挂面板 |
| P9 | 网站 / UI / 杂项 | — | 随时可做，不阻塞 |

---

## P0 色彩管线

现状：全项目**零色彩管理**。中间 target 默认 RGBA8，89 个特效与 8 种混合模式全部作用在 sRGB 编码值上，`kit.ts::Target` 支持 `float` 但只给有状态模拟用。

**定死的一条：16F 只提高位深，不改变编码。** 混合仍在编码域，只有调色 pass 内部临时解码到线性。不要写成「升 16F 就线性了」—— 那会让每次调色模块的插入点都变成一次隐式色彩空间转换。

- [x] **按需 16F 中间缓冲**
  - 触发条件：链里存在 `grade-*` 特效实例（不是「工程里有调色」）。判断放在 `compositor.runOps` 分配 ping/pong 之前，按 op 列表扫一遍 defId 前缀。
  - `EXT_color_buffer_float` 缺失时 `Target.float` 会**静默回落 RGBA8**。必须有可见提示：调色编辑器顶部一条「本机无浮点渲染目标，调色按 8 位精度执行」。这条不写就是「用户以为自己有 16 bit」。
  - 预算：RGBA16F 每像素 8 字节、RGBA8 是 4，所以是 **2 倍**（不是 8 倍 —— 8 倍是「单通道 16 bit vs 8 bit」的算法）。`core/capacity.ts` 是唯一的策略处，加一档 `gradeTargetMB`，按机器派生。超预算整帧退回 8 位 + 提示，不做分级。

- [x] **sRGB 传输函数库**
  - `effects/shader-def.ts` 的共享头里加 `toLinear(vec3)` / toSrgb(vec3)`（分段式，不是 2.2 幂）。
  - 单测：编码→解码→编码在 0..1 上往返误差 < 1/1024；`toLinear(0.5) ≈ 0.2140`。

- [x] **线性岛的边界**
  - 只在一个调色 pass 的 `main` 内部：`col = toLinear(texel)` → 运算 → `toSrgb(col)`。
  - 相邻两个调色模块之间因此会经历一次 encode/decode 往返。这不是浪费：16F 下往返误差可忽略，而且它保证了「任何调色模块都能单独插入既有链」。
  - **例外**：`grade-curves` 与 `grade-basic` 相邻时允许合批（一次解码跑完两段），实现方式是 compositor 识别连续同族 op 并合并；不做也行，先不做。

落地位置：判定在 `core/grade.ts`（前缀扫描 · 预算 · 三档原因），分配在 `engine/compositor.ts::ensure`，
传输函数是 `effects/shader-def.ts::TRANSFER_GLSL`（常数只有一份，在 `core/color.ts`），
提示条已在检查器（`insp.gradeNoFloat` / `insp.gradeBudget`）—— P1 的调色编辑器落地后
把它挪到编辑器顶部即可，判定不用改。守卫：`color-transfer` / `grade-plan` / `grade-island`
单测 + `tests/e2e/grade-precision.spec.ts`。

---

## P1 调色

入口形态已定：**复用 `EffectClip`，不新增 clip kind**。

- 绑定到某个片段（`boundClipId`）= 这个镜头的自带调色，与 z 序无关。
- 不绑定 + `affectDepth` = 输出级调色（整条时间线统一风格）。
- 这条让「同一镜头的调色」在片段被裁剪/分裂/移动时自动跟随 —— 它是那一条特效片段自己的几何，不是 `SourceClip` 的字段。**不要给 `SourceClip` 加内联 `grade`**，那会和绑定调色片段构成两套真源。

四个模块拆成普通特效，链顺序就是图层顺序：

### `grade-basic`（已落地：`effects/defs|glsl/grade-basic.ts`）

线性域运算，全部为闭式：

| 参数 | 定义式 | UI |
|---|---|---|
| lift | `x ← x + lift`（加性偏移，允许负值压黑） | 色轮 + 数值 |
| gain | `x ← x * gain` | 色轮 + 数值，**用 EV 显示**（`2^EV`），步进 0.05 |
| gamma | `x ← pow(max(x,0), 1/gamma)` | 色轮 + 数值 |
| contrast | `x ← (x - pivot) * contrast + pivot`，`pivot = 0.18` | 0.5..2.0 |
| saturation | `mix(vec3(luma709(x)), x, sat)` | 0..2 |
| hue | YIQ 矩阵旋转（便宜，够用；不上 OkLab） | -180..180 |
| temp / tint | 沿普朗克轨迹的两条基向量（R/B 与 G/M 增益对） | -1..1 |

**注意 contrast 的 pivot 是线性 0.18，不是 0.5。** 0.5 在编码域才像中灰，线性域 0.5 是 73% 白。这个数字写死在 shader 里，参数表里不要暴露 pivot。

色轮是 UI，不是数据结构：`values` 仍是扁平标量（`lift#r`/`lift#g`/`lift#b` …），因为 `EffectInstance.values` 的约定是 `Record<string, number|string>`，而 `transitions/params.ts` 已经有「向量拆成 `foo#0`/`foo#1`」的先例。

### `grade-curves`（已落地：仅表不参数，见 `core/tone-curve.ts`）

- 曲线是**色调映射表**，不是 `core/curve.ts` 的关键帧曲线。两者同形不同义，不要复用 `CurveEditor` 的交互（关键帧有 `interp`/`handles`/`mode`，色调曲线只有单调性）。
- 插值：单调三次（Fritsch–Carlson），防过冲。采样成 1024×1 的 R16F 纹理（WebGL2 无 1D 纹理，用 `Nx1` 的 2D 纹理）。
- 表里存**线性值**，定义域也是线性；编辑器画曲线时横纵轴显示编码刻度。这样数学一致、UI 是用户直觉。
- 通道：主 RGB + 单通道 R/G/B + luma 偏移。四张表，一次 uniform 上传四行。
- 表在参数变动时重建（频率低，不上 GPU 端求值）。

### `grade-lut`（已落地：1D 展开成 3D，素材 kind `lut`）

- `.cube` 解析（1D 与 3D，处理 `DOMAIN_MIN`/`DOMAIN_MAX`），3D 用 `TEXTURE_3D`（WebGL2 原生），尺寸 17/33。
- **必须有「输入空间」选择**：sRGB / 线性 / Log-C。绝大多数免费 LUT 是按 log 或 sRGB 素材调的，硬套到线性域会整体发灰或压死 —— 这是「LUT 看着不对」的第一原因。
- 存成工程 assets（`kind: 'lut'`，`hash` 复用现有台账）。插件可以带 LUT。
- 许可策略：**不打包任何第三方 LUT 集合**。预设改为**参数化 grade 预设**（一组 `grade-basic` + `grade-curves` 的值），没有许可问题，且用户改完还能继续调。要第三方观感就让用户自己导入 .cube。

### `grade-qualifier`（已落地：`effects/defs|glsl/grade-qualifier.ts`）

- HSL 键 + 亮度键 → 生成 mask，输出给后续调色模块当 `u_mask`（或自身直接做局部校正）。
  **落地取后者**：这个模块自己吃 `u_mask`（外部蒙版只收窄范围），键与蒙版相乘后做局部校正；
  「传给后续模块」需要一条链内蒙版通道，暂不做。
- 抠图（`SourceClip.key`）与它不重复：key 是**把背景抠掉**（改 alpha），qualifier 是**选出颜色相近的区域**（不改 alpha）。两者输出都进 mask 通道，共用同一套消费路径。
- 目标追踪不做（见 P2 的「引用点是同一 t」）。

### 调色页（已落地：`ui/grade/`，双击 grade-* 片段进入全屏子界面）

- **不是 modal、不是通用特效检查器。** 画面必须一直在屏上 —— 弹窗盖住预览等于闭着眼调色。
  实现是「工程视图」（`view.kind === 'grade'`，与排版页同一套）：主界面三列换内容，
  `Preview` / `Transport` 原封不动复用，时间轴只 `display:none`（卸载会丢 WebGL 上下文）。
- 布局（见 `ui/AGENTS.md` 的调色页一节）：贴主 rail 的调色侧栏（对照原片 + 面板开关 + 退出）／
  中列预览 + 工具条（分级读数）／底部色轮与曲线／右栏示波器与查找表。
- 打开方式：双击调色特效片段（与排版编辑器一致的手势）。双击**普通**特效片段仍进检查器。
  顶栏 tab 上带色轮图标，Esc 或侧栏底部箭头回时间轴。
- 编辑器里必须能切「前 / 后」对比（走渲染旁路，不改工程）。
- 分级信息条：当前作用于哪个片段（绑定）或哪几条轨（`affectDepth`）。这是「我以为在调这个镜头」的唯一防线。
- 滚轮式滑杆（`GradientSlider`）：轨道比把手高、可带渐变背景，用于主量与色温 / 饱和度这类
  「本身就是一段颜色」的量。
- **四个色轮**：阴影 / 中间调 / 高光 / **偏移**（与达芬奇对齐）。偏移是整体（连黑位一起动）：
  `x' = (x + F)·k - F`，k=1 时逐位恒等。

### 示波器（已落地：探针 256×144 + 10Hz，`ui/grade/Scopes.svelte` + `scope-draw.ts`）

面板挂在调色页右栏（`GradeDock`）里，默认吃满高度；关掉面板时探针立刻停。

数据源：合成之后、编码之前插一个探针 pass，输出 **512×288** RGBA8，`readPixels` 回 CPU，Canvas2D 绘制。
（落地取 256×144 —— 本节末尾自己留的口子；读数在预览与导出之间可比，尺寸固定不跟渲染尺寸变。）

- 波形图：x = 横向位置（512 列），y = 该列亮度分布的 256 桶累计。
- 矢量示波器：Cb/Cr 平面 256×256 累加 + 六角刻度。
- 直方图：256 桶 × R/G/B/luma。
- 分量：三条波形，同数据不同通道。
- 口径默认**编码值**（0–100 IRE 直接映射），可切线性。两种都显示时会有一行小字标注当前口径 —— 示波器的意义在于和画面一致，不在于和 DaVinci 一致。
- 性能：`readPixels` 是同步 stall。只在面板可见时跑，限帧 10 fps，探针尺寸可降到 256×144。`engine/box-tracker.ts` 已经证明这条路（160×90 探针 + CPU 统计）走得通。
- 不做「任意节点的示波器」—— 那是节点图能力，代价与收益不成比例。要单独看某个片段，用编辑器的前/后对比。

---

## P2 外部纹理 / 蒙版（已落地：`core/mask.ts` + `compositor.maskTexture` + `u_mask`）

**蒙版不是一种资源，是一次输入绑定。** 媒体池只存烘焙出来的静态蒙版图（就是普通 image），活的蒙版是引用。

**所有特效都能接**（不需要 def 声明）：缺省是 `composite` —— 在链上补一步
`mix(特效的输入, 特效的输出, mask)`，于是「只模糊左边那块」对 89 个特效同时成立，
没有一行 shader 代码。`mask: 'input'` 是例外，给「蒙版不是用来限制范围」的那类
（色相选取收窄键、碎片位移当概率场、3D 当深度）。

落地形态（改动前先读 `src/core/AGENTS.md` 的「外部蒙版引用」与 `src/engine/AGENTS.md` 的同名一节）：
判定与依赖图在 `core/mask.ts`，求值在 `compositor.maskTexture`（由 runner 在 `prog.use()` 之前调），
校验在 `validateProject` + `ProjectStore.setEffectMaskRef`，界面在检查器的蒙版来源下拉，
agent 走 `set_params({ mask })`。守卫：`tests/unit/mask-graph.test.ts`、
`tests/unit/agent-control-plane.test.ts`、`tests/e2e/mask.spec.ts`。

### 数据形状

```ts
// 每实例可选
EffectInstance.inputs?: Record<string, MaskRef>

type MaskRef =
  | { kind: 'clip'; clipId: string; channel: 'luma' | 'alpha' | 'r' | 'g' | 'b' }
  | { kind: 'asset'; assetId: string; channel: ... }
  | { kind: 'none' };
```

- 声明在 def 侧：`mask?: true`（这个特效消费一张蒙版）。未声明的特效不占 sampler 单元，也就不进拓扑。
- shader 侧：`EFFECT_HEAD` 加 `uniform sampler2D u_mask;`，绑到单元 3（0/1/2 已是 `u_texture`/`u_feedback`/`u_original`）。
- mask target 用 **R8**（`gl.R8` + `gl.RED`），长边 512，可配。R8 够用且省 4 倍预算。

### 引用点的语义

被引用片段的求值结果 = **该片段 placement 之后的整帧层 + 它的绑定特效链（`boundClipId` 指向它的 EffectClip），不含 blend/opacity**。

理由：这才是「这个片段看起来是什么」。取 placement 原始输出更安全（无递归），但那样「模糊后的亮度当蒙版」做不到。既然允许递归，就必须有环检测。

### 拓扑序

`buildStack` 的输出从「线性 op 列表」变成「op 列表 + 依赖边」。渲染时：

1. 收集所有 `MaskRef(clip)` 的 clipId，DFS 求拓扑序；
2. 按序把每个被引用片段渲进独立 target（一帧内按 clipId 去重，多处引用只渲一次）；
3. 再跑主链，把 target 绑到 `u_mask`。

- **环检测放在 `validateProject` 与 store 的 setter 两处**。只在渲染层报错的话，发现环的时候只能死循环或者给白图。深度上限 8，超了当作环。
- 删除片段/拆分/复制时，`inputs.mask.clipId` 要跟着修：删除 = 置 `kind:'none'`（不删整条 inputs，否则下一帧整条链的行为变了）；拆分 = 两侧都指向原目标（如果目标就是自己，则失败并提示）。
- 被引用片段处于转场窗口里时，取 from 侧（`transitionSources` 的既有规则），另一侧不参与。

### 消费方式

shader 自己决定：乘 alpha（局部调色）、当混合权重（mix 原图与特效输出）、当概率场（碎片位移）。三种语义在 shader 里都是几行，不需要三个机制。

### 待落地的消费方

- [x] `grade-qualifier`（P1 依赖它）—— 键 × 蒙版，蒙版只能收窄范围
- [x] `tile-shuffle`（P6）—— 蒙版当概率场（`mask: 'input'`）
- [x] 3D 深度输出（P4）
- [ ] 排版层的 `mask` 属性：排版元素按蒙版做淡出/位移，走的是同一套（`render-dom` 侧读 mask 的 CPU 版本，不需要 GL）

---

## P3 参数求值统一 / 调制系统（已落地：`core/expr.ts` + `core/modulation.ts` + `ui/modulator/`）

现状：`core/curve.ts` 的 `Curve` 就是「时间 → 标量」。它原先在四个地方被求值：`engine/stack.ts`（transform/opacity）、`algos/runtime.ts`（生成器参数）、`effects/runner.ts`（特效参数）、`core/audio-envelope.ts`（gain）。数值生成器如果是第二套系统，这四个地方各要多一个分支 —— 那是四条静默失效路径。

落地形态：表达式 AST + 解析/打印/求值在 `core/expr.ts`，数据与求值口径（`resolveParam`）在 `core/modulation.ts`，
UI 在 `ui/modulator/`（抽屉列表 + modal 里的**节点图画布** + `KeyableField` 的落点与徽标），
agent 走 `list/set/remove/bind/unbind_modulator` 五个工具。守卫：`tests/unit/expr.test.ts`、
`tests/unit/modulation.test.ts`、`tests/e2e/modulator.spec.ts`。

### 数据形状

```ts
// 项目级，独立实体
Project.modulators?: Modulator[]        // { id, name, expr, unit: {min,max} }

// 片段级，与 curves 共用键空间
ClipBase.mods?: Record<string, ModSlot[]>
type ModSlot = { ref: string; gain: number; mode: 'add' | 'mul' };
```

求值：`base = curves[key] ? evalCurve(...) : 静态值`，然后逐个 slot：

- `add`：`v = v + gain * m`
- `mul`：`v = v * mix(1, m, gain)`（`gain=0` 等于不生效，`1` 等于全乘）

「水平运动 + 随机抖动」= `curves['transform.x']` 走关键帧 + `mods['transform.x'] = [{ref: 'jitter', gain: 40, mode: 'add'}]`。两者不互斥，因为加法要求它们在同一个求值点相加。

唯一入口：`core/modulation.ts::resolveParam(clip, key, base, t, ctx)`。四个调用点全部改调它。这条不做，「某个参数在某个片段上不动」会变成要查四处的谜。

### 表达式

- AST 唯一真源，积木是 AST 的编辑视图，文本永远是逃生舱（双向）。积木词汇表表达不了的东西（条件、分量运算、引用参数）在文本里写，切回积木时那块降级成只读的「文本」块（`fitsBlocks`）。
- 节点：`literal` / `time` / `beat` / `param(key)` / `modulator(id)` / `binary(+ - * / %)` / `unary(-)` / `ternary` / `call`。
- 内建函数：`sin cos tan abs floor fract mod pow log exp sqrt clamp map smooth step` + `noise(x, freq, seed)` + `fbm(x, octaves, seed)` + `lfo(t, freq, shape)` + `rand(seed)`。
- **全部闭式**（硬约束 1.3）：不许有 `prev + …` 这种跨帧递推。要做随机游走就写 `smoothNoise(t, freq, seed)`。
- 结果按 `unit` 归一或直接给值：`unit` 只用于 UI 显示范围，求值不钳制（钳制交给参数本身的 min/max）。
- 单测：AST 求值对手算；`add` 顺序无关；同 t 同值；`u_time` 无累积相位这条不能破。

### 编辑器

- Rail 加一个图标开「调制器」面板：列表 + 新建 + 重命名 + 删除（删除前扫描引用，列出受影响的参数路径）。
- 绑定手势：从列表把条目拖到任意参数行上（range 参数行有拖放目标）。松手即在 `mods[key]` 追加一条 `add` 槽，gain 默认 0.5，并顺手张开槽面板（不然用户得先猜徽标能点）。
- 参数行的状态徽标：`KC`（有关键帧）/ `M`（有调制）/ `KC+M`（叠加）。三态必须一眼看得出，否则用户不知道自己在改哪一层。
- 积木与文本视图切换按钮在同一面板右上。
- 积木实现成**节点图**（`GraphEditor`，节点可拖、画布可平移缩放、从输出口拖到输入口
  就是改接）：缩进树每一层吃掉一行宽度，而「这块属于谁」只能靠左边缘对齐去猜。

### 与规格不同的两处（落地时的取舍）

- **滑杆读数不含调制。** `KeyableField` 的滑杆 / 数字框显示的是基值（或曲线值），
  调制后的实际值只在槽面板里给（「实际值 0.412」）。混在一起会让把手永远追不上指针：
  写入端改的是基值，而读数变成 `基值 + 调制` 之后每一帧都把差值叠回去。
- **列表在抽屉、编辑器在 modal。** 规格里是一块面板，但拖放到右侧参数行要求列表
  与检查器同时可见（modal 会盖住整屏），而节点图需要一块能平移缩放的画布。

---

## P4 3D 场景图（已落地：`sdf-geoms.ts` + `sdf-compose.ts` + `scene3d.ts`）

阻塞项：每个 3D def 把几何、运镜、局部光照写在同一个 `BODY` 里，`sdfKernel(sd)` 只是套模板。要两个生成器共享镜头并互相遮挡，必须先拆。

落地形态：几何进 `algos/sdf-geoms.ts`（`SdfGeom`：`name` / `src` / `keys` / `set`），
运镜留在各自的 def 里（`sdfFrag(geom, { src, call })`），场景在 `algos/scene3d.ts`
拼片段（`build` 钩子，程序名按「槽的 defId 序列」缓存）。
守卫：`tests/unit/sdf-scene.test.ts`、`tests/e2e/algos3d.spec.ts` 的「3D 场景」三条、
`tests/e2e/mask.spec.ts` 的深度蒙版一条、`lab.spec` 的 dropped-uniform 差集。

- [x] **拆 def**：`GEOM`（`float sdX(vec3 p)` + 自己的 uniform 声明）/ 运镜（`CAM`，只在单生成器模式下用，场景模式下忽略）/ 材质（可选，`sdfKernelMaterial` 的 `vec3(距离, 材质, 自发光)`）。
- [x] **`scene` 生成器类型**：2..4 个槽，每槽 `{ defId, op: union|subtract|intersect, t: vec3, scale, rotY, material }` + 子参数 `s1.<key>`、`s2.<key>`。
- [x] **uniform 前缀重写**：编译期把子 body 的所有 `uniform` 声明改写成 `u_s1_<name>`。这是字符串处理，风险在宏、注释、多行声明。守卫：编译后取 `ACTIVE_UNIFORMS`，与期望集合做差集（`lab.spec` 已有这套手法），差集非空即失败。
- [x] **无限延伸逐槽套用**：折叠 `mod(p+1,2)-1` 之后必须删外框 `max(|p|)-1`，且折叠要在**槽的局部坐标**做。跨槽不能折叠。
- [x] **深度输出**：`u_outDepth=1` 时 fragment 返回 `vec4(depthNorm)`，作为 `MaskRef.clipId` + `channel:'r'` 的源。这是 P2 的第一个真实消费者。
- [x] **Skybox**：命中失败（`sdfMarch` 返回 -1）时采样天空 shader，而不是背景色。`sdfMarch` 的未命中哨兵是 -1，命中判定一律 `hit < 0.0`。
- [x] **同屏混搭的另一半**：让 `scene` 也能被普通片段用（单槽 = 现有行为），否则会出现「两个生成器长得一样但参数不一样」的分裂。

---

## P5 排版镜头（已落地：`camera.ts` + `css.ts` + `runtime.ts` + `CameraPopover`）

2.5D 分层视差，走 DOM 内 transform（不做真 3D）。

落地形态：`doc.camera?: { x, y, zoom, rot }`（x/y = 取景中心相对画布中心的偏移，
文档 px；zoom 倍数；**rot 是度**）与 `el.depth?: number`（0 = 无穷远不动，
1 = 完全跟随）。变换是 `A_d(p) = o + s·R(φ)·(p−o) + t`，`s = 1+(zoom−1)d`、
`φ = rot·d`、`t = −d·zoom·R(rot)·c`。守卫：`tests/unit/typography-camera.test.ts`
（20 条）、`tests/e2e/typography-camera.spec.ts`（6 条，含光栅化与命中）。

- [x] **模型**：两个可选字段 ⇒ 不抬 `SCHEMA_VERSION`（与 `groups` / `theme` / `scripts` 同条约定）。
  `resizeDocument` 按各轴缩 `camera.x/y`（zoom / rot 无量纲）。
- [x] **复合进元素已有的 transform**（`elementStyle` 的 `parallaxTransform` 前缀），
  **没有 wrapper**。只能挂外壳、不能挂 `.typo-box` 动画层（CSS 动画的 `transform`
  优先级高于内联样式，box 动画一跑就把视差顶掉）。组合外壳用**离镜头最近的成员**
  的 depth。
- [x] **窗口与留边**：窗口仍是**整个 `doc.size`**，超采样多出来的部分由后端
  `shrinkCanvas` 在 canvas 里裁掉 —— 不是 CSS clip 后再缩，那会在帧边缘留一条硬缝。
  刻意**不扩大图层矩形**：`drawSizeFor` 按位图尺寸摆放，位图一变宽整幅排版就缩水，
  而「推出画布」本来就等于出画。（真要出血是另一个功能，得动 placement。）
- [x] **超采样封顶 2×**：密度 = 「被放大的最多那一层」的倍数，钳到 2，再按
  `rasterEdge` 夹一次；降采样走 canvas（预乘空间），否则直通 alpha 的位图会在字形
  边缘糊出暗边。全 depth 0 时密度恒为 1。
- [x] **缓存键**：`docHash` 不含 camera / depth（`cache-key.ts::hashableDoc`），
  它们的像素效果由 `parallaxSignature`（逐元素 s / φ / t / origin 的哈希）表达。
  没有元素吃镜头 ⇒ 摘要为空、键与没有镜头逐字相同。镜头**不**让静态文档逐帧重渲
  （它是静态构图参数）；将来若由文档外驱动（脚本 / 时间轴），这一段已经是现成的键。
- [x] **富文本块整体一个 depth**，块内不拆（要分层就拆成多个文本元素）。
- [x] **镜头关键帧**：`doc.animations?: TracksAnimation[]`（`prop` = `camera.x|y|zoom|rot`）
  + `camera-tracks.ts` 的 JS 采样（`cameraAt` / `withCameraAt`）。前置基建就是那个字段：
  元素动画是 CSS + WAAPI seek，镜头**必须**同步求值（命中 / 手势 / 光栅密度都要
  这一帧的取景），所以两条路径并存，逐段缓动在 JS 里重实现了一遍（`easeProgress`，
  与 CSS 语义逐字对齐，单测钉着）。守卫：`tests/unit/typography-camera-tracks.test.ts`、
  `tests/e2e/typography-camera-keys.spec.ts`。
  - **有帧的通道覆盖基准值**；浮层对这类通道写「播放头那一帧」= 自动关键帧。
  - **空轨道不算动画**：面板四条通道常驻（空桩不落库），`docIsAnimated` /
    `hashableDoc` 都按「有帧才算」判，静态文档不会因为开过面板变逐帧。
  - 面板：「镜头」行常驻元素列第一行，双击轨道空白加帧；作用层 / 加属性 / 循环
    开关对它隐藏（JS 采样不读 `iterations` / `target`）。
  - ⚠️ 踩过的坑：`viewDoc` 这个 `$derived` **必须显式 `void appState.version`** ——
    文档是原地改的普通对象，`$derived` 靠 `===` 传播，上游 `doc` 重算后还是同一个
    引用，不订阅 version 就永远不重算（表现：加完关键帧拖播放头，舞台纹丝不动，
    而文档里确实变了）。同一份陷阱见 `docSize` 的注释。
- [ ] 景深（可选，后置）：按 depth 分 3 桶，每桶单独光栅化 + 各自模糊半径，再合成。先不做。

### 排版性能（调研已完成，见 `docs/typography-perf.md`）

实测：单次捕获 13–30ms，**空文档也要 13ms**（snapDOM 的固定开销），分辨率/密度
几乎不影响；动态文档每帧一次捕获 ⇒ 30fps 天花板、视差场景 20fps。

- [ ] **A0**：`cache: 'soft'`（snap 段 ≈2×，26 条 E2E 全绿）。开之前先补「换图后重烘」的守卫。
- [ ] **A1**：`inflight` 按「文档+尺寸+模式」去重，别给每一帧都排一次捕获。
- [ ] **A2**：播放时 `density` 恒为 1（暂停仍 2×）。
- [ ] **B1**：动画文档按 `floor(frame/2)` 烘焙（键与 `localSec` 同时量化），做成偏好。
- [ ] **B2**：镜头下放到合成器（四边形矩阵 + 按最大 zoom 烘一次 + overscan）；视差要是重点功能才做。
- [ ] **D**（待议）：文件级预览代理（播放/拖动用低码率 MP4，暂停走精确位图），见 `docs/typography-perf.md` §D。
- **不做**：换掉 DOM 捕获路线（自研 GL 排版渲染器 / 第二套排版子系统）—— 复用 HTML+CSS+snapDOM 的全部价值就是不维护一个 HTML 渲染引擎。

---

## P6 特效

- [x] **`tile-shuffle` 碎片位移**（依赖 P2）
  - 网格尺寸按**输出像素**算（`u_cellPx`），不是按归一化 uv —— 否则同一 t 在预览和导出的格子数不同，导出结果和预览对不上。
  - 每格 hash → 旋转 90° 倍数 / 镜像 / 与邻格交换；发生概率 = `mask` 采样值 × `density`。
  - cell 数上限（防止 1px 格把 shader 拖死），超出按最大允许值钳制并提示（钳制在 shader 里，确定性、不报错；参数面板没有提示位）。
- [x] **`beat-pulse` 节奏律动**
  - 闪白 = `mix(col, vec3(1), a)`；震动 = **uv 偏移**（不是层 transform，否则层边缘露底），边界 clamp + 镜像。
  - 衰减：`pow(1 - fract(phase), k)`，`phase` 由 `beatAtTime(ctx.t, ctx.grid)` 给。`u_time` 无累积相位这条不能破。
  - 全表最便宜的一项，可先做。
- [x] **`bokeh-defocus` 失焦散光**
  - 两级：小半径高斯去细节 → 亮度阈值提亮部 → 圆盘卷积（golden angle 螺旋采样 32 点，半径随阈值增大）。
  - 阈值以下不参与圆盘，否则整幅画变成磨砂。
  - 落地时的两处修正：圆盘取**最大**而不是平均（平均会摊成渐变 ⇒ 看起来像辉光）；
    只认**孤立**亮部（锐利减模糊的 top-hat），否则大片亮区会把整幅铺成白。
- [x] **`hold-trail` 定帧拖尾**
  - `feedback: true`（漏写 = sampler 没绑，画面完全不变且不报错）。
  - 「定格」= 只在帧号变化时推进 feedback；拖动位移 = 采样偏移；重影强度 = 上一帧混合权重。
  - 落地时按「Windows 重绘」的语义重写：**不混合、不衰减**，整帧盖上去；
    去掉了逐帧位移（它会让暂停时的每次重渲都再盖一次，尾巴自己长）。
    不透明素材没有 alpha 可用，另给「亮部 / 暗部留尾」两种叠法。

---

## P7 生成器

按「新增底座个数」排序。前三个不引入新底座。

- [x] **`noise-field` 噪声**
  - value / gradient / voronoi 三族 × 2D/3D + fbm + 域扭曲。输出灰度，可直接当 mask 源。
  - 现在 3D 噪声只在 `smoke.ts` 里私有，提成共用库。走 `HASH_FAST_GLSL`（无 sin），否则大参数下低位不稳、帧间闪烁。
  - 落地：库在 `algos/noise-lib.ts`（`NOISE_GLSL`，自带 hash；与 `FBM6_GLSL` 不能同拼），`smoke` 的私有实现已并入。
  - 两种模式**都在三维里采样**，区别只在流速怎么用：二维吹平面（深度冻结在「演化」），三维往深度穿。`speed = 0` 时画面对 `t` 逐点无感（E2E 钉住）。
  - 演化（`u_evolve`）是**进度**不是速度（单位格，可打关键帧）；它就是「噪声原地平滑换形」，与流速的平移互补。
  - 默认对比 0.15 是**实测**挑的：×2.5 时 value / gradient 出现大片平台；gradient 基元因此刻意**不逐阶截平**（×0.9）。
  - 成本（480p、默认参数、10 帧取 5 轮最小值、含一次读回摊薄）：value ≈1.2 · gradient ≈1.3 · voronoi ≈1.8 ms，二维与三维同价（只差流速加到哪个坐标）。
- [ ] **`kinetic-shapes` 跃动几何**
  - 形状（圆/方/三角/线/环）+ 缓入缓出 + 网格/随机分布 + 可引用媒体池图片作形状纹理。
  - 密度/尺寸/旋转/配色/速度/位置全部可打关键帧。可选音频驱动。
  - 零新底座，但它是「MG 观感」的主力，优先级不低于后面几个。
- [ ] **`volumetric-cloud` 体积云**（依赖 noise-field）
  - ray-march + 3D 噪声。步数上限 64 + 早退（密度累积到 0.99 停）。1440p 下必须测帧时间，超了就降步数不能降分辨率。
- [ ] **`horizon` 地平线**
  - 复用 3D 内核：SDF 平面/海面 + 掠飞镜头。风格预设（硬表面科幻 / 蒸汽波 / 体素 / 示波器 / PS1）做成参数组合，不是 shader 分支。
- [ ] **`particles` 粒子**（新底座：GPU 状态纹理）
  - 两张 RGBA32F ping-pong（pos.xyz + life / vel.xyz + seed），固定步长，快照 + seek 重放（硬约束 1.3）。
  - 2D/3D 同一套状态，只差投影。上限 262144，按机器派生。
  - 参数面板是重头：发射器形状/速率/寿命/力场/颜色随寿命。
- [ ] **`fluid` 流体**（新底座：有状态 sim）
  - 移植 PavelDoGreat 内核（advection / divergence / pressure / gradient / curl / vorticity）成固定步长的 pass 链。它原仓库是 demo 形态（自带 rAF 与画布），不能直接嵌。
  - 力注入改为**由关键帧/mask 驱动**，不做鼠标交互。
  - `sim-util.TorusField` 那类环状核在这里不适用（流体边界是 clamp）。
- [ ] **`extrude-material` 3D 格式化**（新底座：位图 → SDF）
  - 先做 PNG alpha → SDF（8SSEDT），再挤出 + 材质（液态金属/玻璃）。SVG 后置（path 采样 + 距离场）。
  - 这是全表最重的一条，放最后。

**跨项纪律**：新增生成器 = `algos/<id>.ts` + `registry.ts` + `algos/catalog.ts` + i18n 三处 + 缩略图。少了 catalog 那一条，`algo-catalog` / `algo-thumb-assets` 单测会挡，但不会挡住 `pnpm dev` 的静默空帧。

---

## P8 Agent 与插件

审美靠**人手写的 skill 文档**，不靠自我评审。但 skill 要能被加载，这是底座。

- [x] **插件热重载修复和精确编辑**：新增`plugin_edit`等工具，支持Agent精确编辑插件。
- [ ] **Skills 系统**
  - 位置：工程内 `skills/` + 全局；`load_skill(name)` 工具按需注入（不要一次性塞进系统提示，工具表已经几万字）。
  - 斜杠命令映射与 skill 同名；「压缩上下文」这类是宿主动作，不是 skill。
  - 上下文预算：单个 skill 上限字符数，超了截断并告警。
- [ ] **def 别名表**
  - 每个 def 一个中文别名 + 一句用法，随 `get_capabilities` 返回。手写文档里写「黑洞」时，模型要能落到 `black-hole`。这一条很小，但没有它手写 skill 会反复写错 defId，而错 defId 在渲染层是静默的。
- [ ] **内置 skill 内容**（人写）
  - 按风格分册：构图、平面设计风格、动态设计原则、故障艺术调参、生成器选型、转场、动静结合、音乐配合。
  - 每册附参考图与「用哪几个 def + 什么参数区间」，不要写抽象形容词。
- [ ] **插件独立性**
  - manifest v2：面板（可拖曳弹窗 / Modal / 常驻面板）、Rail icon、「无 icon 面板」。
  - 挂载点 API + 引用计数。Rail 在空间不足时可滚动。
- [ ] **跨工程插件**：全局安装目录 + 工程内 `plugins/` 的优先级与冲突规则。
- [ ] **子代理**：主代理可 `spawn_subagent(task)`，独立上下文与预算，结果回传。工具权限继承，写操作仍走主代理的撤销栈。
- [ ] **工程记忆 / 跨工程记忆**：工程内 `.artmatic/memory.md` + 全局；注入时机与预算同 skill。
- [ ] **生图 MCP、本机字体列表、生成器源码可见**
- [ ] **DeepSeek 网页搜索 API、峰谷定价、余额显示**

---

## P9 网站 / UI / 杂项

### 网站

- [ ] 技术文档重写并扩展
- [ ] 使用指南重写并扩展
- [ ] API 文档可读性（TypeDoc 直出，注释先瘦身再生成，别反过来）
- [ ] Vibe Coding 指南

### UI

- [x] 零选项卡启动画面重置：常驻 Rail / 顶栏 / 底栏 + 双栏首页 + 新建弹窗 + 工程缩略图（保存时抓帧）
- [ ] 杀掉防御性文案（硬约束 1.6）

### Optimize

- [ ] **3D 自由镜头与曲线轨迹**（依赖 P4 的运镜拆分）
- [ ] **ASCII 字符覆盖率**：未覆盖处透明或按字符背景色填充。注意 `readPixels` 的 alpha 恒为 255，验证要走 `frame_signature` 的分通道 L1，不能断言 alpha
- [ ] **更准确的工程变更提示**：`projectContentHash()` 纯函数，忽略播放头/选中/UI 状态。对照 `agent/frame-signature.ts` 的思路
- [ ] **数值上限审计**：逐 def 过一遍 `max`，用「拉到上限看是否还有意义」当判据。流线（发射密度）已改
- [ ] **排版图片/SVG 反向输出到媒体池**：光栅化 → 写 assets → 台账登记 → 撤回走 `retire()`
- [ ] **更换算法时自动重命名片段**（仅当片段未被改过名：`label === 默认名`）

### Chore

- [ ] 代码注释瘦身（先做，再生成 TypeDoc）

### Fix

- 暂无

---

## 跨文件纪律（改一处必须同时改）

| 新增/修改 | 必须同改 |
|---|---|
| 特效 | `defs/<id>.ts` + `glsl/<id>.ts` + `effects/catalog.ts` + i18n 三处 |
| 生成器 | `algos/<id>.ts` + `registry.ts` + `algos/catalog.ts` + i18n 三处 |
| 参数类型 | `effects/types.ts` + `visibleParams` 的消费方（检查器 + LabParams）+ 序列化校验 |
| 求值路径 | `core/modulation.ts::resolveParam` 唯一入口；`stack.ts` / `runtime.ts` / `effects/runner.ts` / `audio-envelope.ts` 四处同步 |
| 调制器（表达式） | `core/expr.ts` + `core/modulation.ts` + 上面四条求值路径 + store 的 modulator 方法 + agent 五件套（`list/set/remove/bind/unbind_modulator`） |
| 积木词汇表 | `core/expr.ts` 的 `EXPR_FUNCS` 是唯一真源：`ui/modulator/block-palette.ts` 与能力清单的 `features.modulation.funcs` 都读它 |
| 蒙版引用 | `validateProject` 环检测 + store setter 增量检测 + 删除/拆分/复制的引用修复 |
| `SCHEMA_VERSION` | 19 → 20（`Project.modulators` / `ClipBase.mods`），迁移恒等 + 新字段校验 |
| Agent 可达性 | 控制平面方法 + `src/agent/tools.ts` + `mcp/tools.mjs` + `getCapabilities()` 四处 |
| 合成顺序 | `engine/stack.ts` 与 `render/AGENTS.md` 同时更新（拓扑序改变后，那份文档的「合成求值」一节必须重写） |
