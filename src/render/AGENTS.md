# src/render/ —— ★ 合成根

装配 Renderer + SourceManager + AlgoRuntime + EffectRunner。
**主应用与 `/lab/` 共用同一份 `createRenderCore`** —— 两边各写一份的 bug 形态是
「试炼场里好好的、主应用里某类源不工作」，而且不会有任何报错。

**何时读我**：加一个新的离屏渲染器（缩略图那类）；出现「想顺手在别处再装一台 renderer」的念头时。

相关：根 `AGENTS.md` 的「架构分层」（`render/` 为什么必须单独一层）、
`src/algos/AGENTS.md`、`src/effects/AGENTS.md`。

---

- **离屏渲染器住在 `render/effect-thumb-renderer.ts`**（不是 `effects/` 也不是
  `ui/effect-picker/`）：它要 `createRenderCore`，而 `render → effects` 是唯一合法的
  方向；放 `effects/` 会成环。**只有 lab 的批量导出在用**（选择器读静态资源，见 `src/assets/AGENTS.md`）。

### `recall.ts` —— 回放服务（闪回）

`recall` 型生成器（`algos/flashback.ts`）问它要「工程在过去某一时刻的整帧」：

```
AlgoRuntime.resolve → RecallProvider(provider) → 独立 Compositor 重渲 → 一张目标
```

四条不是可选项的实现约束：

1. **必须另起一台 Compositor**。借外层那台会把它的 ping-pong / placedA 覆盖掉
   （表现是「闪回里混进另一半画面」，不报错）。
2. **必须另起一台 AlgoRuntime**。共用时回放帧会把 sim 拨到过去、外层随即又要拨回
   `t` —— 每帧重放几千步，预览直接卡死。分开之后回放侧总是向后走，快照环兜住。
   烘焙客户端（`BakeClient`）反而**要共用**：它是按哈希的纹理缓存，无状态。
3. **每次重渲前 `clearFeedback()`**。反馈历史是「从 0 播到 tPast」的产物，随机
   回跳时没有定义；不清它，「同一个 t 渲两次相同」立刻不成立（导出不允许）。
   `comp.tracker` 同理留在 `null`。
4. **工程从 `Renderer.currentProject` 取**，不要注入 `getProject()`：后者只保证
   拍网格 / 种子 / 帧率（`RenderCoreProject`），而重渲要整棵树。`renderFrame`
   每帧收到的就是唯一权威，离屏缩略图那几台也自动正确。

回放那台 Compositor 也要接蒙版素材解析器（`comp.maskAsset = sources.resolveAssetImage`）：
回放帧里同样可能有吃蒙版的特效，漏了的表现是「闪回里那块局部调色变成全图」。

### `bake-surface.ts` —— 预览缓存的离屏烘焙面

与 `recall.ts` 同一套隔离手法（第二台 Compositor + 第二台 AlgoRuntime，共用
`SourceManager` / `BakeClient` / 频谱字形曲线 LUT / 特效执行器），差别是它渲进
**自己的一张 FBO 再回读**（`readPixels` → RGBA），产物交给 H.264 编码器。

三条不是可选项：

1. **不许改回 `runExport` + 可见画布**。那条路的形态是「烘焙期间预览冻住、
   `tick` 里 `return` 掉整条预览路径」——用户体感就是卡死。离屏之后预览照常
   按 rAF 画，可见画布一个像素都不动。
2. **`flipY` 只在回读这条路上给**（`Compositor.render` 的第 5 个参数）：
   `readPixels` 是自下而上，翻一次比在 CPU 上翻 3 MB 便宜；闪回不传它。
3. **尺寸必须偶数**（`core/dims.ts`）：目标尺寸 = `kit.w/h`，所以**预览缓冲本身
   已取偶**。谁把 `preview-size.ts` 的取偶删掉，烘焙会在奇数尺寸上「四档 H.264
   全不支持」——报错长得像「本机没有编码器」。

节奏与让速不在这里（这里只管「渲一帧并回读」），见
`ui/preview-cache.ts::pump` 与 `core/preview-cache.ts::PREVIEW_BAKE_MAX_FPS`。
回收：`forget(clipId)` 要接到关工程那条路上（第三份 sim 状态纹理）。


### 新形态 runtime 的注入点（v21）

`createRenderCore` 装好主 `AlgoRuntime` 后，除了 `setFeatureSource` /
`setRecallProvider`，还要 `algos.setAssetResolver((id) => sources.resolveAssetImage(id))`。
`render/recall.ts` 那台独立 runtime 也要装同一份解析器。
`asset` 型参数（粒子精灵 / 发射密度图）在 `bindAux` 里解析；没装解析器时该输入一律缺席，
回退到无贴图渲染。漏装回放侧的表现是「闪回里的粒子贴图丢了」，主画面完全正常。

`stats()` 现在返回 `gpuSims` / `gpuSimBytes` / `particleDiagnostics` / `assetNotices`。
`forget(clipId)` 对 `gpu-sim` 要调 `handle.dispose()`：状态纹理在句柄里，
靠预算淘汰会让「片段已删」的四张 RGBA32F 一直占着显存。

窗口与时间映射的纯函数在 `algos/flashback.ts`（可单测）；本文件只管「渲哪一帧、
渲到哪张纹理」。递归由 `MAX_RECALL_DEPTH` 兜底，视频的精确帧由
`RecallService.prepare`（导出预热里调）解。
