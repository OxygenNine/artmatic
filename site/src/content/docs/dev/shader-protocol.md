---
title: 着色器与参数
description: 两个头各自提供什么，参数怎么变成 uniform，以及「拨了没反应」的完整成因表。
sidebar:
  order: 5
---

特效与生成器共用一套参数系统，但着色器头不同。这篇讲协议本身：能拿到什么、怎么把参数送进去、哪里会静默失效。

## 两个头

| 名字 | 给谁 | 提供的量 |
| --- | --- | --- |
| `EFFECT_HEAD` | 特效 fragment 与每一环 pre-pass | `u_texture`、`u_feedback`、`u_original`、`u_time`、`u_delta`、`u_seed`、`u_resolution`、`vUv`、`outColor` |
| `ALGO_HEAD` | `realtime` 生成器 fragment | `u_time`、`u_delta`、`u_seed`、`u_resolution`、`u_aspect`、`vUv`、`outColor` |

`realtime` 生成器不声明 `u_texture` / `u_feedback` / `u_original`，因为它没有输入。硬塞进来会让每个生成的 shader 都挂着三个永远拿不到东西的 sampler。

两边的 fragment 都**不含头**。重复声明头里的名字会直接编译失败。从外部移植 shader 时这是最常见的一处，`u_resolution` 尤其容易漏。

`sim` 与 `bake` 型不写 fragment。`sim` 可以给 `tintFragment` 自定义着色，那一份由 `TINT_HEAD` 拼头，已经声明了 `u_tex` / `u_colorBg` / `u_colorLive` 与 contain 适配。

## 时间

`u_time` 的单位是**秒**。它是唯一的时间来源，渲染函数里不许读 `Date.now()` 或 `performance.now()`。

需要的相位写成闭式：

```glsl
float phase = u_time * u_speed;
```

不要用逐帧累加。累加是有状态的量，seek 之后不可复现，导出和预览会给出不同结果。

`u_delta` 的口径是「这个特效用于动画的那个量」的每帧增量，不是固定的秒。普通特效那个量是秒，就等于 `1/fps`；用 `clockUniforms()` 的时钟特效那个量是相位，会按 `speed` / `division` 换算好。

需要按拍同步时，参数用 `clockParams()` 造、uniform 用 `clockUniforms()` 派发。它会在 JS 侧算好 `u_beat`，因为 `BeatGrid` 只有 JS 侧有。

## 随机

GLSL 侧用 `u_seed`，它由 `hashSeed(project.seed, instanceId, frame)` 得出。JS 侧一律走 `core/prng.ts` 的 `withSeededRandom` / `mulberry32`。裸 `Math.random()` 会让预览和导出成为两次不同的随机。

共享库里有三个 hash，选错的表现是「图案从随时间缓动变成逐帧闪烁」：

| 常量 | 掺不掺 seed | 用在哪 |
| --- | --- | --- |
| `HASH_GLSL` | 掺 | 每次求值都该换图案的随机处置 |
| `HASH_PLAIN_GLSL` | 不掺 | 坐标的纯函数，图案要稳定，如织纹、位移场 |
| `HASH_FAST_GLSL` | 不掺、无 `sin` | 大像素坐标下要稳定，新代码优先用它 |

`NOISE_GLSL` 与 `FBM6_GLSL` 建在不掺 seed 的那一支上。空间图案用它们，别自己再写一份。

`fract(sin(x) * 43758.5453)` 这一族在自变量上百之后低位不稳，用户能看见闪烁。要用 `sin` 先做相位归约。

## 参数类型

七种，定义在 `src/effects/types.ts`：

| 类型 | 值 | 可打关键帧 |
| --- | --- | --- |
| `range` | 数 | 是 |
| `select` | 选项字符串 | 否 |
| `checkbox` | 0 / 1 | 否 |
| `color` | hex 字符串 | 否 |
| `bitmask` | 整数，`0..2^bits-1` | 否 |
| `pattern` | `WxH:<base64>` 串，空串表示没有图案 | 否 |
| `text` | 字符串 | 否 |

只有 `range` 会走曲线求值。这也是 `bitmask` 不做成 `range` 的原因之一：混进来会让「这个参数能不能打关键帧」说不清。

`visibleWhen` 收到的参数表已经含默认值，可以写 `(v) => v.outline === 1`。

## 参数怎么变成 uniform

约定是 `u_<参数键>`。派发写在 def 的 `setUniforms` 里，四个助手：

```ts
floats('radius', 'amount')        // range → uniform float
ints('mode', 'invert')            // checkbox / 整数 → uniform int
colors('tint', 'bg')              // color → uniform vec3
selectInt('shape', { a: 0, b: 1 })// select → uniform int，未知值走 fallback
```

参数同时有几种类型时用 `compose(...)` 把它们拼成一个 setter。

**写入类型必须与 fragment 的声明逐字对应。** 对 `uniform float` 调 `uniform1i` 会触发 GL 的 `INVALID_OPERATION` 并静默不写，值保持 0。自动冒烟的编译检查看不见这一类，靠 `effect-uniforms.test.ts` 与 `algo-uniforms.test.ts` 的静态自检拦。

`select` 的 map 里找不到的值走 fallback 而不报错，这是刻意留给工程向前兼容的。

`realtime` 生成器不能派发 `select`：`floats()` 里是 `Number(v[key]) || 0`，字符串会变成 0。要区分形态就用 0..1 的 `range`。

## 新增一种参数类型

参数类型有五个消费方，漏掉任何一个都不报错：

| 消费方 | 漏掉的症状 |
| --- | --- |
| `ui/Inspector.svelte` | 检查器里这一项什么都不显示 |
| `lab/LabParams.svelte` | 试炼场里被兜成一个颜色选择器 |
| `lab/lab-state.svelte.ts` 的 `randomizeParams` | 「随机」按钮跳过这一项 |
| `effects/types.ts` 的 `defaultValues` | 新实例写入时缺这个键 |
| `plugins/manifest.ts` 的 `PARAM_TYPES` | 插件声明这种类型时被当成非法参数拒掉 |

改之前先 `grep PARAM_TYPES` 把白名单找全。试炼场是「新参数类型的 testbed」：它和产品端表现不一致，等于这个类型没被测过。

## 需要更多输入时

按复杂度排，这些协议各自解决一类问题：

**`u_original`** 是**pre-pass 之前**的链输入。辉光、残影、运动遮罩这类「需要未处理的源」的效应用它。

**`u_feedback`** 是本实例跨帧的历史，要显式写 `feedback: true`。漏写的表现是「没有拖尾」，不报错。逐帧增量很小时再开 `hdrFeedback`，让历史走 RGBA16F。

**`prePasses`** 是主 pass 之前的全屏 pass 链。第一环读特效输入，最后一环的输出是主 pass 的 `u_texture`。参数会派发到每一环，所以只在 pre-pass 里声明的 uniform 同样能拿到值。

**`delayedInput`** 把某一环的 `u_texture` 换成上一帧的链输入，给帧间差分用。链里本来拿不到这个量：`u_texture` 是上一环输出，`u_feedback` 是自身上一帧输出，`u_original` 是当前帧输入。

**`linearFilter`** 让这一环采样时临时切成 LINEAR。实现是「设 LINEAR、画、还原」，改的是别人的贴图，务必还原。

**服务型 sampler** 走「声明即绑定」：program 里写了 `u_spectrum`、`u_overlay`、`u_atlas`，对应的服务就会绑好并派发配套的度量 uniform。runner 里没有按 defId 分支的代码，所以主应用、试炼场、离屏缩略图三处自动都有。其余七十多个特效走早退路径，没有额外开销。

## 静默失效速查

这一节是排错顺序，从上往下试。

| 症状 | 先查 |
| --- | --- |
| 参数拨了画面不动 | `setUniforms` 有没有派发这个键；uniform 名是不是 `u_<key>` |
| 某些值永远等于 0 | 写入类型与声明是否一致（`uniform1i` 写 float 会静默失败） |
| 控件根本不显示 | `visibleWhen` 引用的键是否存在、值类型是否对得上 |
| 选中某档没有效果 | `selectInt` 的 map 里有没有这个 value |
| 图案逐帧闪烁 | hash 选错，掺了 seed |
| 着色器编译过但参数没反应 | 声明了却从没读过，被链接器丢掉。`compileAll` 的返回里会标出来 |
| 频率随分辨率变化 | 用了 `vUv` 做像素尺度的量，该用 `u_resolution` |

最后一条的判据：`u_resolution` 在 pre-pass 里仍是全分辨率，降采样只改 tap 密度、不改模糊半径。

## 自检

```
pnpm exec vitest run tests/unit/effect-uniforms.test.ts tests/unit/algo-uniforms.test.ts tests/unit/algo-tint-uniforms.test.ts
```

三份都用伪 GL 跑一遍派发，断言「声明的都被写到」「写入类型与声明一致」「没摸到未声明的名字」。`algo-tint-uniforms.test.ts` 单独管 `sim` 的自定义着色，它的失效形态和上面完全一样，但 `algo-uniforms.test.ts` 看不到。
