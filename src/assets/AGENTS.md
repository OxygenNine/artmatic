# src/assets/ —— 静态资源（含三套缩略图）

特效 / 转场 / 生成器缩略图都是**打包进 `src/assets/` 的 WebP**（不是 `public/`）：
URL 同步可得、字节由浏览器懒加载。它们由 `scripts/` 里的脚本重新生成，完整性由守卫钉住。

**何时读我**：加一个特效 / 转场 / 生成器（要一起给缩略图）；动生成脚本；
改「选择器怎么读这些资源」时。

相关：`src/effects/AGENTS.md`、`src/algos/AGENTS.md`、`lab/AGENTS.md`（批量导出的入口）、
`src/ui/AGENTS.md`（选择器与悬停浮层）。

---

### 缩略图资源（`src/assets/effect-thumbnails/`）

- 打包进 `src/assets/`（**不是** `public/`），由 `ui/effect-picker/thumb-assets.ts` 用
  `import.meta.glob('../../assets/effect-thumbnails/*.webp', { eager: true, query: '?url' })`
  取：**URL 同步可得**（组件里不需要「加载中」状态），图片字节由浏览器的
  `<img loading="lazy">` 自己懒加载。**选择器不再现渲** —— 第一版现渲要临时编
  七十多个着色器，实测帧数 240 → 190。
- 格式 **WebP**。640×360 q84 实测**整套 1.11 MB**（原始 PNG 6.6 MB），
  所以不必为了省体积降到 256 高：卡片显示宽约 208 CSS px，360 高在任何 DPI
  都清晰，且不重采样就是零损失。
- **仓库里这一套是逐张手挑的**（连同参数一起调，例如 `bleach` 拉到完全去色才是
  它最好的示意），**不是** `EFFECT_CATALOG[id].base` 那套自动底图。
  `lab` 的「批量导出缩略图」用的是自动底图 —— 它会给**另一套**图，
  **别当成「重建同名资源」直接覆盖**。
- 守卫（`tests/unit/effect-thumb-assets.test.ts` + `tests/e2e/effect-picker.spec.ts`）：
  每个注册的特效都有资源、没有孤儿资源、只放 WebP、整套 < 2.5 MB、
  界面上**每张卡片都有 `<img>` 而不是占位条**。加特效时忘了导出会明确报错。
- 渲染侧的两个坑（翻行 / 频谱顶掉链输入）的守卫在 `tests/e2e/lab-shot.spec.ts`
  —— 它们属于**导出这条渲染路径**，不属于选择器。
- **lab 的「导出截图」**（`lab/export-thumbs.ts`）：
  - 单张 = 当前画面存成 `<特效 id>.png`（比右键另存为省事）；
  - 批量 = 按目录底图逐个渲一张，打成一个 zip（**一个下载**，不触发浏览器的
    「是否允许下载多个文件」，也不用往下载目录丢七十多个散文件）。
  - 文件名是**特效 id**，不是显示名 —— id 是这份素材的主键，显示名会随文案变。
  - 高度可选（128/192/256/384，默认 256）。默认比「128 px / 20 KB」那套算得高，
    因为缩略图会被显示成 ≈200 CSS px 宽，128 高在 2× 屏上要放大 1.75 倍。
  - 单个渲染器 **`thumbSize()` 先做 `isFinite` 兜底再取整**：
    `Math.max(16, Math.round(NaN))` 是 `NaN`，会造出一张 NaN 尺寸的 canvas、
    导出静默得到 0 字节文件。

### 转场缩略图资源（`src/assets/transition-thumbnails/`）

- **两张底图在 `effects/transitions/thumbnails.ts`**，是 GLSL 而不是图片文件：
  渲染侧要用**恰好等于渲染尺寸**的两张纹理，GLSL 同步且零资产。两条硬要求 ——
  **冷暖两极的色相**（dissolve / 亮度类靠它读出来）、**强结构 + 一条亮边框**
  （滑移 / 擦除类靠边框的位移读出来；纯色画面上只看得出「颜色变了」）。
  接入方式与特效底图一致：`trthumb:` 伪 generator id，由
  `render/transition-thumb-renderer.ts` 的 resolver 拦截，**不注册、不改 schema**。
- **渲染是「造一张最小工程让真转场跑出来」**：`from` 源 → `to` 源相邻、
  `transitionOut` 挂在 `from` 上，在**剪切点**渲一帧 ⇒ `progress` 恰好 0.5。
  所以它走的是预览同一条 `buildStack → runTransition` 路径，**不是**另写一套混合。
- **一条命令落盘**：`node scripts/gen-transition-thumbs.mjs`（build → preview →
  `/lab/` 的 `__lab.renderTransitionThumb`）。**不用 lab 按钮** —— 特效那套打完 zip
  还要人工解压，素材跟着代码走时那一步是多一次「导出了但忘了解压」的机会。
- **有几条转场的中点本来就是退化状态**：`circle` / `CircleCrop` / `Rectangle` /
  `RectangleCrop` 在 progress=0.5 时半径恰好为 0（整屏只剩底色），`SimpleFlip`
  在 0.5 时只留中间一条缝，`StereoViewer` 在 0.48–0.52 之间是纯黑。
  渲染器因此**先在 0.5 拍，只有拍出一张纯色才换邻近进度重拍**
  （`PROGRESS_CANDIDATES`，亮度极差 < 24/765 判为纯色），脚本会把挪过的条目打进日志。
  **不挪的表现是「7 张纯色缩略图」** —— 那种图等于白做。
- **编译失败的转场不写盘并让脚本非零退出**：`runner.ts` 对上编译不过的着色器会
  退化成内置 dissolve，那样导出的缩略图**不代表这条转场**。
- 守卫：`tests/unit/transition-thumb-assets.test.ts`（资源与目录对齐、只放 WebP、
  整套 < 4 MB）+ `tests/e2e/transition-picker.spec.ts`（每张卡片都有 `<img>`、
  左右两半真的不是同一张图）。

### 提供商品牌图（`src/assets/providers/`）

设置面板的提供商列表与抽屉里的 chip 要显示品牌图。素材来自
[Lobe Icons](https://lobehub.com/icons)（`@lobehub/icons-static-svg`），
**文件名 = provider id**（`deepseek.svg` …），由 `ui/agent/provider-logos.ts` 用
`import.meta.glob('../../assets/providers/*.svg', { eager: true, query: '?url' })`
取；守卫在 `tests/unit/agent-providers.test.ts`（每个 provider 都有图、没有孤儿）。

国内网络下 GitHub raw 拿不到，用 npmmirror 取：

```
https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons/<lobe-id>-color.svg
```

两种渲染方式，选错的表现都是「看不见」而不是「报错」：

- **整张 `<img>`**（默认）：彩色 SVG。品牌色在明暗两种主题下都看得见。
- **蒙版 `mask` + `currentColor`**：品牌色本身就是黑的那几家（OpenAI / Anthropic /
  xAI / Kimi），贴彩色在暗色主题里是一块黑斑；OpenRouter 反过来是荧光绿，在白底上
  几乎看不见。名单在 `provider-logos.ts` 的 `MONO_LOGOS`。

补图时注意三点：① `<img>` 拿不到 `currentColor`，单色图只能走蒙版；
② 蒙版用 alpha 通道，**不透明底的图会蒙出一整块实心方块**；
③ 彩色 SVG 内部的 `url(#...)` 渐变 id 在 `<img>` 里按文档隔离，不会互相污染。

### 生成器预览缩略图（静态 WebP + 菜单悬停浮层）

二十多个生成器光看名字（「李雅普诺夫分形」）没人知道插进去长什么样，所以
「插入片段 → 算法片段」二级菜单在**悬停某一项时**给一张缩略图 + 一句话说明。

- **素材预先导出、静态存放**：`node scripts/gen-algo-thumbs.mjs` →
  `src/assets/algo-thumbnails/<id>.webp`（640×360，30 张共约 593 KB）。
  脚本自己 build + 起 preview + 用 Playwright 调 `__lab.renderThumb()`，
  **直接落盘**（不像特效那套打完 zip 还要人工解压——素材跟着代码走，
  多一步人工就多一次「导出了但忘了解压」）。
- 渲染器 `render/algo-thumb-renderer.ts`（与 `effect-thumb-renderer.ts` 同一
  手法：另起一台离屏 render-core）。**翻行那一步直接复用后者的
  `pixelsToCanvas`** —— 抄第二份的下场是「特效图是正的、生成器图是倒的」。
- ⚠️ **`sim` 的采样时刻单位是「步数」不是「秒」。** 决定形态的永远是
  `t × rate`，而各生成器的默认步频差 40 倍（雪花 10、兰顿蚂蚁 400）。按秒
  给必然得到一堆「刚开始长」的图 —— 第一版就是这么错的：雪花 t=16s 只有
  160 步（一个孤点）、蚂蚁 2400 步（一小团）、反应扩散 1680 步（一个环）。
  配方表与目标步数见 `algos/catalog.ts` 头注。
- ⚠️ **bake 是异步的，必须重试。** 第一次调用时烘焙还没好，`renderFrame`
  渲出空帧。**从 Node 侧轮询**（20 × 300ms）：在 page 里自旋会把主线程占住，
  而 bake 的 Worker 要主线程跑消息循环才会被唤醒。
- ⚠️ **频谱与音频特征都要给**（`staticSpectrum()` + `staticFeatures()`）：
  这条链上「不传也能跑」的注入点全是静默退化 —— 吃频谱的只剩底图，
  `scene-*` 读到全零特征会又平又暗。缩略图是给人挑东西用的，必须代表真实长相。
- 三条守卫：`tests/unit/algo-thumb-assets.test.ts`（资源与注册表对齐 / 非空 WebP /
  **sim·bake 必须显式给 `previewT` 且 > 0** / 说明长度 ≤ 44 字）、
  `tests/e2e/algo-preview.spec.ts`（浮层出现 + **图真的加载出来**（`naturalWidth > 0`）+
  换项换图 + **浮层不许盖住高亮项**（`elementFromPoint`）+ 关闭后无孤儿）。
  （同一个文件里还有「展示信息目录与注册表对齐」那批：缺条目 / 孤儿 /
  `previewParams` 里的键不存在 / 说明文案解析不出或过长。）

### 首页：外链品牌图（`src/assets/brand/github.svg` · `bilibili.svg`）

- 只用于首页底部那两个链接（GitHub / Bilibili），由 `ui/home/SocialMark.svelte`
  用 `?raw` 内联，`path { fill: currentColor }` 跟着链接色走（常态 muted → hover primary）。
  **不要做成 `<img>`**：它拿不到 `currentColor`，得为两种状态各存一份图。
- 这两份是**品牌商标**（版权属各自品牌方），只作「指向其站点的图标」使用；
  它们不进 `ui/icons.ts`（那张表只收 Lucide），也不进 `providers/`（那是 AI 提供商）。

### 首页背景（`src/assets/home/{light,dark}.png`）

- 是**没有渐变遮罩**的那一份（1280×720 PNG，各约 0.5 MB）。顶部压深改由
  `ui/EmptyState.svelte` 的 `linear-gradient` 画：把渐变烘进位图再压成 WebP，
  8 位色阶会出现可见的跳变，看起来像裁切断了。
- 所以这两张**不要再转 WebP**（重编码会把刚去掉的跳变又请回来）。换图时保留
  「无渐变 + 只留纹理与那道弧」的形状，渐变交给 CSS。
