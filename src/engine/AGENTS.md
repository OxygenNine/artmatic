# src/engine/ —— WebGL2 底层

Program / Target / Pass 调度 · 纹理池 · 预览尺寸 · 确定性时钟 · 素材登记 · 视频取帧与缓存。

**何时读我**：改 `engine/**`；动**合成顺序（z 序）/ 影响深度**；动预览尺寸或全屏策略；
加一个 pass、或碰 GL 状态时。

相关：`src/effects/AGENTS.md`（着色器协议 · `prePasses` / `feedback` · GL 状态事故）、
`src/core/AGENTS.md`（容量预算的裁决）、`src/render/AGENTS.md`（谁把这一层装起来）。

---

## 合成求值

```ts
function buildStack(project: Project, t: number): Stack {
  // 1. 收集所有命中 t 的 SourceClip，轨道序 → 轨道内序 决定 z
  // 2. 按 z 序合成（各自的 blend / opacity / transform / 曲线求值）
  // 3. 把命中的 EffectClip 的 chain 依 z 序插入到 step 2 之后
  // 4. 顶部叠加渲染：排版层
}
```

**EffectClip 是 adjustment layer 语义**：只作用于 z 序在它**之下**的所有 SourceClip 的
合成结果。「调色放最顶层」= 作用于整幅画面；「故障放在两层之间」= 只坏一层。

### 影响深度（`EffectClip.affectDepth`，v5）

`affectDepth = N > 0` 的特效**不再吃 acc 当时的样子**，而是吃一段**独立合成的组画面**：
从「下方第 N 条**启用**视觉轨」起的连续一段 op，**从透明起**合成 → 特效链 → 贴回下层。
于是「作用域 = 只留下这几条轨道时的那幅画面」，它看不到作用域之外的轨道。
「只给上面两层调色、别碰背景」就是它存在的理由。`N = 0` / 缺省 = 下方全部 = v4 的行为
（这条老路**逐字节没变**，也不多花 pass）。

- **贴回用的不是写死的 normal，而是作用域最底层那个 op 自己的混合模式**（`scope-blend.ts`
  的 `bottomScopeBlend`）：组从透明起合成，组内最底层没有背景板，对着透明黑做
  `add` / `multiply` / `screen` 会算出**不透明黑**（alpha 照常按本层覆盖度累积）。
  实测：**黑填充 + 线性加深(add)** 的圆形设了影响深度就变成黑块、把下方画面盖住，
  而不设深度时它与下方相加仍是下方色。所以最底层那个 source 在组内按 `normal`
  收进来（`neutralizeBottomBlend`），混合模式留到贴回那一步对着真正的背景板做。
  守卫 `tests/e2e/effect-scope-blend.spec.ts`（判据是「depth=1 与 depth=0 逐通道一致」，
  不是「画面变了」）。已知近似：组内 rgb 是预乘的，半透明边缘会被多压一次
  （不透明实心区域逐位一致）。

- **只数启用轨**：禁用轨不参与合成，谈不上被影响，也不该占掉一格深度 —— 否则关掉一条轨
  会让上方特效突然作用不到任何东西（看起来就是「特效没了」）。
- **同轨更早的片段在作用域里**：它们在画面上本来就在它之下。作用域是**一段连续的 z 序 op**
  （不是「按轨号挑片段」），所以这一条与上一条都只是这条定义的推论。
- **吸收**：作用域内的其它特效（更低、自己也带深度）需要的轨道会**并进**外层作用域。
  反过来做（截断内层）会让内层特效变成静默的空操作 —— 那是更坏的表现。
- **下方没有启用轨** → 作用域为空，特效作用在**空画面**上（多数特效因此看不出变化）。
  检查器显示「影响：V2、V3」或那条空作用域警告；判据共用
  `engine/stack.ts::affectedVisualIndices`，**别在 UI 里另算一遍**（对不上时不报错）。
- 实现：`buildStack` 把作用域 op **折进** `EffectOp.scope`（顶层不再重复出现它们）；
  旁路消费方（`video-source` 的预取）要走 `walkOps`，否则作用域里的视频源不预解码。
  `compositor.runOps` 递归渲染，`groupTargets(depth)` 保证嵌套时外层中间结果不被覆盖。
  区间族是层叠的（laminar），所以建树是一个栈一趟的事。
- **`SCHEMA_VERSION` 抬到 5**，4→5 是**恒等迁移**：旧版打开新版工程要显式报错，
  而不是静默丢掉作用域再保存。

### 绑定片段（`EffectClip.boundClipId`，v11）

第二种作用方式，与影响深度**互斥**：链不算作用域、不看 z 序，而是**跑在目标
`SourceClip` 那一层上**。

- 执行位置是 `compositor.placeLayer` 的最后一步：`resolveSource.bound` 有值时，
  链在 placement **之后**、blend **之前**跑（`applyBoundChain`，链内用常驻的
  `layerScratch` 做 ping-pong）。所以特效看到的是「这一层自己的像素」，
  看不到任何下方轨道，结果再按目标片段自己的 blend / opacity 混进 acc。
- `buildStack` 先扫一遍「这一帧生效的绑定链」（`boundChains`），把它们挂到
  对应 source 的 `ResolvedSource.bound` 上，**绝不再推一条 effect op**
  （推了就是「同一道特效既作用在这一层又作用在下面所有层」）。
- 绑定链**不受 `onlyTrackId` 影响**：那是这一层自己的样子，隔离观察时必须一起出现。
  同一目标被多条绑定时按 z **升序**（下方轨道那条先跑）。
- 目标片段不在这一帧 / 已被删 ⇒ 这条片段什么都不做，不报错。转场窗口里
  from / to 各跑自己的绑定链。
- 缺省（没有 `boundClipId`）走的是老路，**逐字节没变** —— 这条是回归的前提。

### 视频音频与单侧转场（v13）

- 视频的内嵌音轨**默认就出声**：`core/audio-plan.ts` 给出 span，`engine/video-audio.ts`
  按区间解成 `AudioBuffer` 并注册进播放器。解码失败一律降级为静音，只 warn 一次，
  **不许阻塞播放 / 导出**。`prepareProjectVideoAudio` 在播放前与导出前各调一次。
- 转场 op 的 `from` / `to` 可以为 `null`（那一侧没有片段 = 全透明）。compositor 用
  一张清空的 Target 照常跑转场着色器，并置 `single`；此时着色器输出是**预乘 alpha**
  的，`BLEND_FRAG` 的 `u_unpremult` 会除回去。
- ⚠️ `u_unpremult` 是 **int** uniform，必须用 `u1i` 而不是 `u()`（后者走 uniform1f，
  在 int location 上是 INVALID_OPERATION，值保持 0 —— 画面偏黑且不报错）。

> **z 序 = 列表位置取反**（`engine/stack.ts` 的 `buildStack`：`z = 视觉轨数 - 1 - 视觉轨下标`）。
> `tracks[0]` 渲染在轨道列表最顶部，按 NLE 惯例就是最前景 ⇒ 它的 z 必须最大。
> **编号只数视觉轨**（音频轨不参与合成）。
> 写反的表现是**「特效完全无效且不报错」**。`core/demo-project.ts` 的 tracks 数组
> 必须一起倒序，`tests/unit/stack.test.ts` 会挡住。

### 视频取帧与变速（v14）

`video-source.ts` 的 `mediaTimeOf(clip, t, grid)` 委托 `core/speed.ts`：有速度曲线时
素材时间是**积分**，负速则往回走。两条容易踩的：

- **`grid` 必须传**：速度曲线可以锚到拍（`Curve.beatAnchor`），没有网格就退回
  「相对片段起点」的解释，画面整体错位一段。`createVideoSourceManager` 的
  `getGrid` 由 `render-core` 注入（`opts.getProject().beatGrid`）。
- 帧缓存键是**素材内时间** `ts`，所以缓存对变速天然正确；但倒放会让 `ts` 在相邻
  帧之间往回跳，`sampleAt` 的常驻顺序迭代器会重开（`streams++`）。这是预期代价，
  不是可以靠「缓存得更久」消掉的 —— 逐帧随机访问本来就是它不擅长的形态。

### 片段级几何与抠图（placement pass）

`SourceClip.key`（色键）、`SourceClip.quad`（四角透视）与 `SourceClip.crop`（裁剪）
**都只在一次 placement 里做**（`placement.frag.ts`），不是特效、不是额外 pass。
这个选择的三个后果都要记住：

- **转场两侧各自独立**：转场通路对 from / to 各调一次 placement，所以两边的抠图 / 四角
  天然按各自片段生效，不需要转场着色器知道这件事。
- **特效片段碰不到它们**：adjustment layer 作用在 placement 之后的整幅画面上，抠图的
  透明区已经烘进 alpha 了；反过来「先用特效再抠图」这种顺序不存在（要那样就先把源
  渲染成图片素材）。
- **转场窗口里的已知近似**：gl-transitions 的着色器只读贴图 rgb、不看 alpha，所以抠掉的
  区域在转场窗口内会按黑色参与混合（普通合成路径完全正确）。这是取舍，不是 bug；
  别为了它去改转场协议。

- `quad` 用「单位方 → 四角」单应的**逆矩阵**采样（uniform 三行 vec3），identity 时
  `u_quadOn = 0` 走原算式 —— **关闭状态必须与历史逐位一致**（全项目确定性回归的前提）。
  逆矩阵在 `stack.ts::resolveSource` 里算一次（CPU），compositor 只负责上传；四角退化
  （矩阵不可逆）时按「不调整」处理，**不丢层**。
- `key` 的数学（YCbCr 色度差 + 亮度差、容差 / 柔边 / 溢色抑制）写在 placement 的文件头。
  它只乘 alpha（render target 是直通 alpha，乘 rgb 会得到错误结果）；普通通路里
  `u_opacity` 仍由 blend pass 负责，两者互不干扰。
- `crop` 只乘 `inside`（可见窗口），**不动采样坐标**：内容不缩放不位移，所以它和
  `transform.sx/sy` 不是一回事。四条边全 0 时 `stack.ts` 不带这个字段、`u_cropOn = 0`。
- **层边界是解析覆盖率，不是 `step`**：`coverage(uv, lo, hi)` 用 `fwidth` 把边界展开成
  1 像素宽的坡，`insideLayer` 与 `crop` 共用它。MSAA 在这里帮不上忙 —— 全部绘制都是
  全屏三角形，没有光栅化边缘，抗锯齿只能自己算。**`inside` 精确为 1 的像素逐位不变**
  （smoothstep 在边界内部返回 1.0），这是保住既有逐位断言的条件。宽度上下都要夹：
  下界防 drawSize 极大时坡退化成 step，上界（0.25）防图层被缩到几像素时整块糊掉。
  判定用的是**源 uv**（四角变形之后的 `srcTd`），因此与 quad 的顺序无关。
- 坐标空间与 UI 拖角共用 `core/quad.ts`（层空间 = 默认图层矩形），改动语义时先看
  `src/core/AGENTS.md` 的「片段级图像处理」。

---

## 色彩管线：按需 16F

中间目标默认 RGBA8。**只有这一帧的 op 列表里真有 `grade-*` 时才升 RGBA16F** ——
判定按 op 列表扫（`core/grade.ts::gradePlan`），不是问工程：「工程里有调色片段」
与「这一帧要跑调色」不是一回事（片段可能不在时间范围内 / 被禁用 / 绑在没出现的层上）。

```ts
render() → buildStack() → gradePlan(ops) → gradePrecision(...) → ensure(w, h, promote)
```

- **顺序不能反**：`ensure` 曾经在 `buildStack` 之前，16F 就没法按这一帧决定。
- **提升哪些**：`chain`（主链或作用域里有调色）→ `ping`/`pong` + 每层作用域一对；
  `bound`（绑定链里有调色）→ `placedA`/`placedB` + `layerScratch`。
  `trTmp`（转场输出）**始终 8 位**：它从不承载调色的输入输出。
- **方案变了就整体重建**（6 张全分辨率目标换一次精度），并且 `groups` 要一起清 ——
  留着旧的会在同一帧里混用两种精度。
- `alloc` 存的是**打算要什么**。拿 `Target.float` 比较是错的：缺扩展时它静默是 false，
  于是「想升但升不了」每帧都会触发一次重建。
- **预算 `gradeTargetMB`**（`core/capacity.ts`）。超了**全有或全无**地退回 8 位 ——
  不做「主链浮点、绑定链 8 位」，那会让同一组参数绑在不同片段上出现不同结果。
- **降级必须说出口**：`gradeStats()` 的 `reason` 分 `idle` / `ok` / `no-float` / `over-budget`，
  检查器读它显示提示条。缺 `EXT_color_buffer_float` 时 `Target.float` 会安静回落，
  不说就等于「用户以为自己有 16 bit」。
- **编码域不变**（`core/grade.ts` 文件头）：16F 只加位深，混合仍在 sRGB 编码值上，
  只有调色 pass 内部临时解码到线性。

## 示波器探针（`compositor.captureScope`）

调色面板的读数来源：合成之后、呈现之后，把整帧拷进一张 **256×144 RGBA8** 目标并
`readPixels` 回 CPU。形状照抄 `box-tracker` 的探针，但三条纪律是它自己的：

- **只在面板可见时跑**（`setScopeProbe`）。`readPixels` 是同步 stall，不看着的时候一帧都不该花。
- **限帧**（`SCOPE_STRIDE = 6` ≈ 10Hz）。示波器的意义是「和画面一致」，不是「逐帧」。
- **尺寸固定，不跟渲染尺寸变**：读数要在预览与导出之间可比；跟随尺寸会让同一画面给出不同的分布。
- 回读的行序是**下往上**，`captureScope` 里翻成上往下再交出去 —— 不翻的话波形图上下颠倒，
  看起来像「暗部跑到上面」，但那不是数据错了。

## 曲线表 / LUT 纹理（`curve-texture.ts` / `lut-texture.ts`）

与 `glyph-atlas.ts` 完全同构：CPU 准备数据，GL 只负责上传与绑定，特效侧只认 uniform 协议。
两个都**按内容缓存**（曲线按参数串、LUT 按素材 id），LRU 8 / 4 张；都不含跨帧状态，
`onSeek()` 不用清。

- **建纹理前先切 scratch 单元**（第三次强调，见 `effects/AGENTS.md` 的事故记录）。
- **3D 纹理不能用 `Program.tex()` 绑**：那是 `TEXTURE_2D` 目标，绑 3D 纹理是
  `INVALID_OPERATION` 且 sampler 收不到东西（用 `Program.tex3d()`）。
- LUT 的字节来源由宿主注入（`LutTextures.setLoader`）：`render-core` 不许 import
  `project/`，所以 `app-state` 装配完再 `setLoader`；没设之前一切 LUT 退化成「没载入」。
- **没有 LUT 时绑 2 阶恒等表**（三线性插值下等价于 `x`）并置 `u_lutOn = 0`，
  shader 里显式跳过 —— 这样「没载入」与「载入了」在画面上分得开。

---

## 斑点追踪（`box-tracker.ts`）

「方框跟踪」特效的服务层：**探针回读 + 跨帧状态 + Canvas2D 叠层**。它补的是
「特效协议拿不到画面里有哪些物体」这一环：

```
链输入 → 固定 160×90 探针 pass → readPixels → core/blob-track（纯 TS）
      → Canvas2D 画框/标签/连线 → 上传 u_overlay → 主 pass 做框内效果 + 合成
```

- **放在 engine 而不是 effects**：`engine` 不许 import `effects`。特效那一侧只认
  uniform 协议（program 声明了 `u_overlay` 就调用它），所以主应用与 `/lab/` 自动都有。
- **探针恒为 160 宽**（高按画幅比）。它**不能**跟着渲染尺寸走：预览 960 与导出
  1920 会降采样出不同的显著性图，表现是「预览里框在这、导出后框在那」。
  E2E 钉死 `probeW === 160`（`tests/e2e/box-tracker.spec.ts`）。
- **探针 pass 的采样步长是「探针 texel」，不是源 texel**。用错的形态很隐蔽：
  每个 tap 只隔半个源像素（等于点采样），周期为整数倍的画面（lab 的网格）会被
  采成同一个值 ⇒ 显著性恒为 0 ⇒ 一个框都没有。
- **检测按帧号栅格**（`frame % refresh`），**参数变化时强制重检** —— 否则暂停着拖
  「目标数上限 / 灵敏度」画面不动，看起来像滑杆坏了。
- **状态与 seek**：方框列表 / ID / 标签 / 上一帧亮度都是跨帧状态，`reset()` 在
  `Renderer.onSeek()` 里清（与 `feedback` 类特效同一处置）。导出是顺序循环，逐帧
  精确；预览跳转后从新画面重检（一两帧收敛）。**不保证同一 t 两渲逐字节相同**，
  不要为此写断言。
- **生命周期必须有调用方**：`drop(instanceId)` 由 `app-state` 关工程时调；
  `prune()` 兜住「实例被删掉但没人记得调 drop」；`clear()` 全清。每实例持有
  一张探针 Target + 一张叠层纹理，只增不减就是显存泄漏的老形态。
- **纹理纪律**：建/传纹理前先切 `scratchUnit`（`Program.tex()` 会把采样本绑到
  0..n 并留下最后一个为激活态）。这条在 `effects/AGENTS.md` 里记过两次事故。
- **三套坐标，混了就「框内效果和框不同步」**：检测/状态/`Canvas2D` 用
  **左上原点**（探针 pass 已经把回读行序翻成与 canvas 同序），片元里 `vUv.y`
  **向上**，上传叠层时又 `UNPACK_FLIP_Y = true`。所以叠层纹理与 `vUv` 天然对齐，
  而 `u_boxA` 的 `cy` 必须由装配侧翻成 `1 - cy`。本文件与 `effects/AGENTS.md`
  都记了这条：写错时的症状是「反色块整体上下镜像」，看起来像检测器错位。
- **掩码与绘制同源**：`Entry.views`（含出场/消失的 `scale`/`alpha`）是唯一几何来源 ——
  绘制与 `u_boxA`/`u_boxFade` 都从它取，不要各自再算一遍。

测试：`tests/unit/blob-track.test.ts`（纯算法）+ `tests/e2e/box-tracker.spec.ts`
（真的出框 / 换色跟着变 / 探针不随档位变 / 框内效果与框线重合）。读数为
`renderer.trackerStats()`，`__artmatic.trackerStats()` 与 `__lab.trackerStats()` 都通到它。

---

## 字形图集（`glyph-atlas.ts`）

「ASCII 字符画」的 CPU 侧：Canvas2D 栅格化字符 → 一张图集纹理 → `bindTo(prog, spec)`
（`u_atlas` / `u_glyphCount` / `u_glyphCols`）。与 `spectrum-texture` / `box-tracker`
同一形态：`engine` 不认识特效，只认 uniform 协议；主应用、`/lab/`、离屏缩略图渲染器
都从 `createRenderCore` 拿到同一份。

- **按实测覆盖率（alpha 均值）升序摆放字形**。字符的面积占比差一个量级，
  按输入顺序映射亮度会出现明暗断层 —— 这是「自定义字符集看起来乱」的真因。
- 按 (字符序列, 字体) 缓存，LRU 8 张；**不含时间**，`onSeek()` 不用清。
- 建 / 传纹理前先切 `scratchUnit`（同两个邻居，`effects/AGENTS.md` 记过两次事故）。
- **上传不翻 Y**：图集不是按 `vUv` 采样的，行号由着色器算；`v=0` 就是第 0 行。
- 内置 5×7 像素字体与本文件同源；方块元素（`█▓▒░▏…`）按几何绘制 ——
  覆盖率必须精确，走系统字体的话每台机器都不一样。

---

## 预览

- 预览降质档位（帧率 1×/½/⅓、画质 100/75/50/25%、暂停回全质）**只影响预览**。
  缩放乘在 `fitPreviewSize` 的结果上，**不能走 `setExportSize`** —— 那会让 `syncSize`
  直接 return，窗口缩放 / 切工程 / 改分辨率全都不会再适配。而且**不动 CSS 盒**：
  canvas 不设 CSS 尺寸时，显示尺寸等于缓冲像素数，只缩后备缓冲画面会跟着变小。
- 帧率节流只在**播放中**生效：暂停时永远渲，那是「改一个参数立刻看到结果」的路径。
- **全屏预览**：宿主是 `.preview` 容器（不是 canvas —— 悬浮工具条与两帧浮层要跟着
  铺满），`requestFullscreen` 后由 `fullscreenchange` 同步状态（浏览器给的退出通道
  不走我们的按钮）。它打开的**唯一开关**是 `renderer.setAllowUpscale(true)`
  （`fitPreviewSize` 松开 `k = Math.min(1, scale)` 那个帽子，上限 `UPSCALE_CAP = 2×`）——
  **绝不能改用 `setExportSize`**（`syncSize` 永久短路）。退出全屏必须关回去，
  否则窗口模式下也按屏幕尺寸分配缓冲。
  - 预览缓冲**由显示区域决定**，所以「工程分辨率变小」不会让 `kit.w` 变小到分辨率以下 ——
    量它之前先想清楚是哪个量在限制（`tests/e2e/ui-ux.spec.ts` 的全屏用例记着这一条）。
  - **headless 里 `Esc` 不触发浏览器级退出全屏**（键盘是 CDP 合成的），E2E 的退出
    走我们自己的按钮（`document.exitFullscreen()`，不需要手势）。
