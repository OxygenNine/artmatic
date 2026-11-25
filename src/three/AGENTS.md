# src/three/ —— Agent 写的 three.js 片段（实验）

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

## 参数与素材（阶段 1）

- **参数表住在代码里**（`params()`），值住在 `source.params`。检查器、控制平面、
  运行时都读 `readThreeParams(code)`（按源码缓存）——**不要在任何一处硬编码参数表**，
  那正是「代码改了名、界面上还挂着旧滑块」的来源。
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
