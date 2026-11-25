# src/three/ —— three.js 运行时（片段 + 生成器）

同一段代码有两个入口：**片段**（`source.type:'three'`，内容就是代码）与**生成器**
（`def.kind:'three'`，参数走 algo 那条路，见 `src/algos/AGENTS.md`）。两者共用
`runtime.ts` —— 差别只在「参数从哪来」，渲染、缓存、回收完全没有第二条路。

**何时读我**：动 `three` 片段的渲染 / 契约 / 缓存 / 回收时。方案与取舍全表在
`docs/three-clips.md`；这里只写会再咬人的那几条。

相关：`src/render/AGENTS.md`（消费方各绑一份）、`src/engine/AGENTS.md`（合成链）、
根 `AGENTS.md` §1.3 / §1.4 的两条例外。

---

## 分层

| 文件 | 职责 |
|---|---|
| `code.ts` | 契约文本 `THREE_CODE_CONTRACT`、体积上限、`compileThreeCode`（**只编译不执行**）。纯函数，控制平面也 import 它 |
| `runtime.ts` | 独立 three 上下文 → 每个消费方一张纹理。`bind()` / `probe()` / `forget()` |

`agent/control-plane.ts` **只** import `code.ts`（写入前语法检查）；`runtime.ts`
只被 `render/render-core.ts` 用。反过来（`code.ts` import engine）会成环。

## 读代码

`get_scene` 只原样带回 ≤16K 字符的内联代码（`THREE_CODE_SCENE_INLINE_MAX`）；
更大的给 `codeChars` / `codeLines`，正文走 `three_view` / `three_grep` ——
工具结果统一截断在 20K 字符，把更大的代码塞进快照只会得到一段半截程序。
引用型片段没有自己的代码：读改都走 `plugin_view` / `plugin_grep` / `plugin_edit`。

## 生成器走同一条运行时

`algos/` 不认识 three，`three/` 也不认识算法生成器；接缝在 `render/three-source.ts`
（`ThreeResolver` → `ThreeSourceProvider`，造一个只换 `source` 的临时 clip）。
合流点只有一处的原因：`bind()` 里每个 `clip.source.xxx` 与 `clip.start` 都是
「这条片段的事实」，加一条平行的入参路径等于让它们全变成二选一 —— 漏掉任何一处
都不会报错（最典型的是 `clip.start` 漏了，`update(t)` 拿到绝对秒，动画整体偏移）。

三个消费方各自 `algos.setThreeSource(...)`：主链 `'main'`、回放 `'recall'`、烘焙面
`'bake'`。漏一处的表现是「闪回 / 预览缓存里那一层是黑的」，主画面完全正常。

## 参数与素材（阶段 1）

- **参数表住在代码里**（`params()`），值住在 `source.params`。检查器、控制平面、
  运行时都读 `readThreeParams(code)`（按源码缓存）——**不要在任何一处硬编码参数表**，
  那正是「代码改了名、界面上还挂着旧滑块」的来源。
- 参数类型有五种：`range` / `select` / `checkbox` / `color` / `asset`。
  `asset` 的值是**图片素材 id**（空串 = 未绑），代码拿它喂 `ctx.texture(id)`；
  视频在 three 侧没有解码路径，所以 `accept` 只有 `'image'`。它到 `ParamDef` 之后
  就是一个普通的 `asset` 参数 —— 控制平面的「assetId 必须指向工程里的图」那条
  前置、以及 `listAssetParamKeys()` 的引用修复都自动覆盖，不必另开一条路。
- 值**每帧就地写进 `ctx.params` 同一个对象**：`create` 里存下的引用必须一直有效。
  只写定义表里的键（删掉的参数不能变成幽灵键）。
- `rebuild: true` 的参数参与重建签名（`threeRebuildSignature`），其余只改值。
  拖滑杆重建场景 = 面板一拖就卡。
- `ctx.texture(assetId)` 走的是**已解码的源**，three 在自己的上下文里上传一份；
  主链那张 `WebGLTexture` 在那边用不了。素材换身份（`ImageEntry` 换了）才 dispose 重建。
- 素材是异步解码的：拿不到给 `null`，**不要把 null 缓存进闭包**。视频返回 null。

## 代码来源：内联 / 插件引用

`source.code` 与 `source.ref = { plugin, name }` **二选一**（schema 校验时以 ref 为准、
删掉内联）。取代码**只有一处**：`ref.ts::resolveThreeCode`（渲染、检查器、控制平面
都过它）。引用型片段没有自己的代码，`set_three_code` 拒掉；插件停用时
`PluginHost.threeCode` 返回 null（那是会被执行的 JS，停用就得真停）。

## 六条不变量

1. **`resolve` 同步，拿不到就 null**。`import('three')` 是懒的，首帧一定缺席；
   模块就绪后走 `onReady → store.invalidate()`，下一帧补上。
2. **每个消费方一份纹理**（`bind('main' | 'recall' | 'bake')`）。共用一份的表现是
   「闪回 / 缓存帧里混进播放头那一层」，不报错。`render/recall.ts` 与
   `render/bake-surface.ts` 的 `resolve` 里那个 `if (type === 'three')` 分支
   就是干这个的 —— 它必须排在「非 algo 都复用宿主那份」之前。
3. **`premultipliedAlpha: false`**：`engine/blend.frag.ts` 按直通 alpha 算。
   改这个标志的表现是半透明边缘亮一圈，单帧截图说不清那是 bug。
4. **上传的翻转照抄 `SourceManager.uploadImage`**（canvas 源受
   `UNPACK_FLIP_Y_WEBGL` 控制，`ImageBitmap` 不受）。`tests/e2e/three.spec.ts`
   的「上红下蓝」钉着它。
5. **代码变了就整份重建并回收旧场景**（`disposeTree`）。模型不会替我们 dispose
   几何体与材质，「让 agent 改十遍」= 十份显存常驻。
6. **`forget(clipId)` 必须接在关工程 / 删片段那条路上**（`appState.releaseProjectAssets`），
   与 algos / recall / bakeSurface 同一条纪律。

## 试跑（`probe`）

写入回执里那个 `{ ok, error, checked }` 来自这里：编译 + 建场景 + **用真尺寸渲一帧**。
用预览尺寸而不是写死 960×540 —— 相机 aspect 写错是这一层最容易犯、又最难从
一张空白里看出来的错。没有渲染器时只能到 `checked:'syntax'`，**不要**把它报成
`ok:true`：模型会以为画面已经有了。

## 不要做

- 不要给它加参数（`source.params`）。改画面 = 改代码，这条是功能定义。
- 不要给 UI 加代码编辑器。用户改不来 JS，而一个半吊子的编辑器只会让
  「这段为什么长这样」没有答案。
- 不要在 `ctx` 里加异步入口（`fetch` / loader / `resolveAsset`）。`resolve` 是同步
  路径，异步入口会把缺席帧变成竞态。
