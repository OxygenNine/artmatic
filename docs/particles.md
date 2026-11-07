# 粒子系统

`particles` 是 `TODO.md` P7 的第五型生成器，也是 Artmatic 第一个 `gpu-sim` 形态。
本文说明内核分层、复用 API、确定性契约和素材语义。改动手前先读
`src/algos/AGENTS.md` 的粒子一节。

## 1. 分层

内核代码在 `src/algos/particles/`，对外只暴露 `index.ts`。

| 文件 | 职责 |
|---|---|
| `config.ts` | 参数归一化、枚举映射、预设表、容量换算。纯函数，不碰 GL |
| `params.ts` | 参数表。`group` 是展示元数据，`visibleWhen` 控制显隐 |
| `assets.ts` | 素材采样口径与缺席回退 |
| `glsl.ts` | 初始化、两个 step pass、点精灵的四段 GLSL |
| `engine.ts` | `ParticleEngine`：状态纹理、固定步长、快照、渲染、释放 |
| `index.ts` | `createParticleGenerator(spec)`，唯一的复用入口 |

内置的 `src/algos/particles.ts` 只是一份 spec，没有实现代码。后续生成器调
`createParticleGenerator` 拿到一个标准 `GeneratorDef`，再进 `registry.ts` 登记。
内核不 import `ui/`、`agent/`、`project/`。素材解析和目录句柄由运行时注入。

## 2. 复用 API

```ts
import { createParticleGenerator } from './particles/index';

const def = createParticleGenerator({
  id: 'spark-trail',
  nameKey: 'algo.sparkTrail',
  defaults: { shape: 'point', life: 1.2, blend: 'add' },
});
```

`ParticleSpec` 有五组可选项。

- `params` 按 `key` 覆盖或追加参数。键空间仍来自 `params.ts`。
- `defaults` 覆盖出厂值，与 `preset` 同时给时优先。
- `preset` 指定内置预设为出厂值。
- `omit` 移除不需要的参数项。
- `shaders` 按段覆盖 GLSL，`hooks` 派发覆盖段里新增的 uniform。

不同 spec 必须给不同的 `id`。`Kit.quad` 按名字缓存 program，名字由
`particleProgramName(id, part)` 生成。`id` 相同时两个生成器会共用一份 program。

薄封装示例在 `tests/unit/particles-api.test.ts`。它只验证 def 形状与参数派发，
不创建 GL 上下文。

## 3. 状态与确定性

状态放在四张 RGBA32F 纹理里：位置和速度各两张 ping-pong。

- `pos` 存 `vec4(x, y, z, life)`，`life` 是归一化的剩余寿命。
- `vel` 存 `vec4(vx, vy, vz, seed)`，`seed` 每槽恒定。

一步包含两个 pass。`STEP_POS_FRAG` 写新位置，`STEP_VEL_FRAG` 写新速度，
两者都读同一份 src，写完才交换。顺序不影响结果。

步长固定为 `1 / rate` 秒，与渲染 fps 无关。`rate` 从当前参数读取，不进构造哈希。
所有随机都是 `(槽坐标, 步号, 种子)` 的闭式 hash，没有跨帧累加的相位。
hash 走 `HASH_FAST_GLSL`，大步号下低位不抖。

`seek(f)` 等价于从 0 顺序推进 `f` 步。每 16 步把两张状态纹理读回 CPU，
存进 `SnapshotRing` 的抽稀阶梯。快照存的是原始字节，恢复时逐位上传，
因此回退到任意帧都得到同一结果。读回只在快照点发生，不逐帧做。

`Renderer.onSeek()` 会调 `alignSims()`，把两个形态的模拟都对齐一次。
`gpu-sim` 的对齐走 `ParticleEngine.align()`，从最近快照恢复后补步到自称所在的帧。

导出和播放的 `stepBudgetMs` 为 0，走精确路径。拖动播放头时用令牌桶限制单帧步数，
`planSimStep` 和 `advanceBudgeted` 与 CPU `sim` 共用一份实现。

## 4. 渲染

一次 `gl.POINTS` 画完所有粒子。vertex shader 用 `gl_VertexID` 从状态纹理
`texelFetch`，不逐粒子发 draw call。

点尺寸按画面高度归一，以 480p 为基准。`intRes` 只改渲染尺寸，不改粒子大小。
二维和三维共用同一份状态，差别只在 vertex shader 里的投影。

画点前先清屏给底色。片元输出 `vec4(墨色, 覆盖度)`，直通 alpha。底色不能混进片元，
否则会与清屏叠两次，边缘留一圈脏边。混合模式分加色和普通 alpha 两种，
画完必须关掉 `BLEND`，合成链假设它是关的。

## 5. 素材输入

两类输入都是 `asset` 型参数，值是 `assetId` 字符串，空串表示未绑定。

| 参数 | 用途 | 影响 |
|---|---|---|
| `spriteAsset` | 粒子贴图 | 只改渲染，在 `volatile` 里 |
| `emitAsset` | 发射密度图 | 改出生位置，进构造哈希 |

发射密度图按 `luma` 或 `alpha` 采样，值低于阈值时这次重生被拒绝，粒子等下一步再试。
拒绝不改变后续随机序列，否则 `seek` 等价性会破。

素材纹理由 `render-core.ts` 注入的 `AssetResolver` 解码，回放那台独立的
`AlgoRuntime` 也要装。`AlgoRuntime` 不缓存素材纹理：`SourceManager` 自己按
`assetId` 管缓存与淘汰，运行时再持有一份会指向失效纹理。

素材删除时 `appState.removeAsset` 调 `clearAssetRefsInProject`，把指向它的参数置空。
打开工程时 `validateProject` 调 `sanitizeAssetParams`，悬空引用也置空串。
一律置空串。删键会让读取方回落到 def 默认值。

只收静态图片。视频会在任意 seek 上引入异步取帧，这一版不支持。

## 6. 降级

状态纹理优先用 RGBA32F，采样一律 `NEAREST`。没有 `EXT_color_buffer_float` 时
退回 RGBA8，坐标按 `stateEnc` / `stateDec` 压进 `[0, 1]`。两种格式走同一套算术，
降级只掉精度。刻意不退回 RGBA16F，它的渲染目标同样依赖该扩展，而
`readPixels` 的类型在驱动间不一致。

粒子数上限由 `core/capacity.ts::particleCapacity` 按 `simStateMB` 派生。
设计上界是 262144，预算不足时按机器下调，状态栏给可见提示。

`readPixels` 不被驱动接受时会关掉快照，跳帧时从第 0 帧纯重放。语义不变，代价是时间。
降级原因在 `AlgoRuntime.stats().particleDiagnostics` 里，编辑器右栏读它。
控制台只在原因变化时报一次。

## 7. 同改清单

新增或改动粒子相关代码时，下面几处要一起改。

| 改动 | 必须同改 |
|---|---|
| 生成器 def | `registry.ts`、`catalog.ts`、i18n 文案、缩略图 |
| 参数表 | `config.ts` 的归一化、能力清单、检查器与 lab 的控件分支 |
| GLSL 段 | `glsl.ts` 的默认表、`compile-all.ts` 的预编译守卫 |
| 素材参数 | `core/asset-params.ts` 的键清单、控制平面校验、引用修复 |
| 工程视图 | `clip-editor.ts`、`ProjectView`、`TopBar`、`App.svelte` |

缩略图用 `node scripts/gen-algo-thumbs.mjs --only=particles` 重烘。
守卫清单见 `tests/AGENTS.md`。
