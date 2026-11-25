# three.js 片段

模型写一段 JS，Artmatic 在片段所处的时刻把这段代码画的场景渲出来，当成一个普通源
参与合成（特效 / 转场 / 变换 / 混合全都照常）。

它有意打破三条硬约束，理由与代价都在 §3 —— 动它之前先看那一节。

## 1. 数据与契约

```ts
SourceClip.source = {
  type: 'three';
  code: string;                                 // 片段的内容
  params?: Record<string, number | string>;     // 用户 / Agent 改过的参数值
}
```

### 代码从哪来：内联或引用

```ts
{ type: 'three', ref: { plugin: 'my-plugin', name: 'vaporwave' }, params: {…} }
```

插件可以带一个 **three 代码池**（清单里的 `three: [{ name, label, code }]`，API v4），
片段用 `ref` 引用其中一个。**改插件 = 改所有引用它的片段** —— 这是引用而非拷贝的
全部意义，也是它存在的理由（一份代码喂十条片段）。

三条纪律：

- **引用型片段没有自己的代码**：`set_three_code` 拒掉（`unsupported`）。分叉的正确
  做法是另建一条内联片段，而不是让某一条偷偷长出副本。
- **停用的插件不提供代码**。three 程序是会被执行的 JS，停用就该真的停。
- 解析不到（没装 / 改名 / 停用）时这一层不出图，`three_status` 说清是哪一段引用
  找不到，检查器也在参数上方写明；「缺少插件」的提示走 `plugins/missing.ts`。

解析只有一处：`three/ref.ts::resolveThreeCode`。渲染、检查器、控制平面都过它 ——
各判一次的表现是「预览里是新代码、参数面板还是旧那张表」。

**参数表住在代码里**（`params()`），值住在工程里。这是刻意的分工：代码是唯一真相，
面板只是它的投影 —— 代码里删掉一个参数，面板上那个滑块就跟着消失，不会留下一个
「挂着但改不动」的控件。没有 UI 代码编辑器：改代码仍然只有 agent 工具
（`set_three_code`），改参数有滑块（检查器）+ `set_params`（Agent 与插件共用）。

代码契约的唯一真源是 `src/three/code.ts::THREE_CODE_CONTRACT`，它同时出现在
`get_capabilities().features.three.contract` 和工具描述里 —— 改契约只改那一处。
形状：

```js
function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  return { scene, camera, update(t, frame) { /* t = 片段内秒 */ } };
}
```

`THREE` 是**参数**不是 import（工程里没有模块解析给这段代码用）；`ctx` 给
`width / height / fps / seed / duration / clipId / renderer / params / texture`；
可选 `resize(w, h)` / `dispose()`。没有 addon、没有 loader、没有网络（素材走
`ctx.texture`）。代码上限 1 MB（1 Mi 字符）；**读回另有分页**：`get_scene` 只
原样返回 ≤16K 字符的内联代码，更大的给 `codeChars` / `codeLines`，正文走
`three_view` / `three_grep`。工具结果统一截断在 20K 字符，把更大的代码塞进快照
只会得到一段半截程序 —— 而它被原样写回去时不会有任何报错。

### 参数

```js
function params() {
  return [
    { key: 'tint', type: 'color', label: 'Tint', defaultValue: '#ff8844' },
    { key: 'fov',  type: 'range', label: 'FOV', min: 20, max: 90, step: 1, defaultValue: 50 },
  ];
}
```

四种类型：`range` / `select` / `checkbox` / `color`（与 `effects/types.ts` 的参数
是同构的，检查器直接吃）。值每帧**就地**写进 `ctx.params` —— 代码在 `create` 里
存下的引用一直有效，不必自己缓存。`rebuild: true` 的参数改了会整份重建场景
（几何分段数那类），其余只改值。

**不要为了「显得可调」而加参数。** 判据是人真的会想拧、而代码自己猜不到答案：
光强 / 颜色、镜头（距离、FOV、滚转）、程序化外观的密度与调色。动画本身驱动的量
不该开成参数（那是 `update(t)` 的活）。

### 素材

`ctx.texture(assetId)` 给**图片**素材的 `THREE.Texture`（视频返回 `null`）。
three 有自己的 GL 上下文，主链那张纹理在那边用不了，所以它拿的是**已解码的源**、
在自己的上下文里上传一份；按 assetId 缓存，素材换了才重建。未解码好返回 `null`，
**不要缓存这个 null**（就绪会触发重绘）。

`t` 是**片段内秒**：切分一段 three 片段，两半各自从自己的 0 开始，动画会重来一次。
这与算法片段的参数求值同一条口径（`AlgoRuntime.evalParams` 也吃片段内时间）。

## 2. 一条帧的路

```
Compositor.resolve(clip, t, frame)
  → SourceManager 的 'three' 分支
    → three/runtime.ts::bind(consumer)
       3. renderer.render(scene, camera)          ← 独立的 WebGL 上下文
       4. texImage2D(canvas) → 该 consumer 的纹理  ← 主上下文里的一次拷贝
```

四个点，每个都对应一类**不报错的**故障：

1. **独立上下文**。`new WebGLRenderer({ context: kit.gl })` 会与 `engine/` 的
   状态假设互相踩，且没有任何报错。多一个上下文换的是确定性。
2. **每个消费方一份纹理**（`bind('main' | 'recall' | 'bake')`）。三者渲染的是
   不同时刻；共用一张纹理的表现是「闪回 / 缓存帧里混进播放头那一层」。
3. **`premultipliedAlpha: false`**。合成链的 blend 按**直通 alpha** 算
   （`engine/blend.frag.ts`），three 输出预乘值会让半透明边缘亮一圈。
4. **上传的翻转**沿用 `SourceManager.uploadImage` 的口径（canvas 源受
   `UNPACK_FLIP_Y_WEBGL` 控制，`ImageBitmap` 不受）。`tests/e2e/three.spec.ts`
   的「上红下蓝」钉着它。

three 的 `import()` 是懒的：工程里没有 three 片段时那 750 KB 不下载。首帧缺席
（返回 `null`）是正常状态，模块载入完成会走 `onReady → store.invalidate()`。

## 3. 三条刻意的例外

| 约束 | 例外的内容 | 为什么可以接受 |
|---|---|---|
| §1.3 确定性 | 不承诺「同一 t 两渲相同」 | 使用者要的是**好看**，不是可重放的合成。代码允许 `Math.random()`、允许 `update` 里攒状态 —— 强行确定等于把模型写的动画降级成「t 的纯函数」，而那正是它比内置生成器强的地方 |
| §1.4 主线程 | 每帧在主线程同步渲一次 three + 一次纹理上传 | 改成 Worker + OffscreenCanvas 会让 `resolve` 变成异步，而**导出**（`runExport` 的紧循环）与**闪回**（`render/recall.ts`）都在同步路径上。代价是每帧多 0.04–0.06 ms 主线程（实测见 §4），但它是**线性累加**的：一屏五个 three 片段就是五倍 |
| §1.9 可调参数 | 没有参数、UI 里没有编辑入口 | 这一项不是「UI 不可达的功能」，而是「**内容就是代码**」。给滑块等于给模型一个更差的接口；给代码框等于让用户去写 JS，两样都不是这个功能要的 |

`SCHEMA_VERSION` **不抬**：旧版打开带 three 片段的工程时 `resolve` 落到 default
返回 `null`（这一层不出图），`validateProject` 不认识这个 `type` 也不会删它 ——
数据无损往返，画面缺一层。

## 4. 实测（Win10 / Chrome / RTX 4070，预览 700×394）

| 项 | 数值 |
|---|---|
| 冷启动（工程里第一次出现 three 片段：载入 753 KB + 建上下文 + 编译 three 内部着色器） | 约 100 ms，一次性 |
| 每帧主线程（只下发命令） | 0.04–0.06 ms |
| 每帧端到端（含 GPU：一个全屏 quad / 一个 5k 三角形的 TorusKnot） | 比纯色层多 0.02–0.04 ms |
| 同一帧重复请求（命中缓存，不重渲） | 与纯色层无可测差异 |
| three 分块体积 | 753 KB（gzip 192 KB），只在用到时下载 |

量法：`renderFrame` 的 CPU 时间（主线程开销）与「连渲 120 帧后一次 `readPixels`
把整段跑完」的均值（含 GPU 吞吐）。GPU 是异步的，不插同步点只会量到队列下发。
这两个数都低于「一帧预算」一个量级 —— 因为渲染的是一个场景，不是一张图。
真正贵的是模型写的东西本身（几万三角形、几百个 draw call、每帧重建几何），
所以真要做重场景，第一步是把渲染搬进 Worker（那会同时解掉 §3 的两条例外）。
片段数线性叠加：三个 three 片段同屏 ≈ 三倍。

## 5. 信任模型

**打开一份工程等于执行它里面的 three 代码**（`new Function`，与页面同权限）。
这与排版脚本（`doc.scripts`）是同一类风险，但那边默认关闭、这边默认开启 ——
判据是「没人会手工编辑 three 片段」：它没有 UI 编辑入口，只可能来自 agent。
工程目录是用户自己选的，Artmatic 没有「导入陌生工程」的入口。

要收紧的话，正确的做法是给整个工程加一个「运行代码」总开关（把排版脚本与 three
并到同一个开关下），而不是给 three 单独加一个 —— 那会变成两个描述同一件事的开关。

## 6. 不做什么

- 不暴露参数、不做 three 代码的编辑器、不做 `OrbitControls` 之类的 addon 白名单。
- 不让 three 片段读工程素材（贴图 / 视频帧）。要做的话先解决「素材解码是异步的、
  而 resolve 是同步的」这件事 —— 现在 `ctx` 里没有异步入口是**刻意的**。
- 不做帧缓存（预览缓存 `preview-cache` 只缓存合成结果，three 层跟着一起被缓存，
  不需要单独一条路径）。
