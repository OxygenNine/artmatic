---
title: 新建一个特效
description: 从两个文件到选择器里的一张卡片：defs、glsl、目录表、文案、缩略图、验证。
sidebar:
  order: 3
---

一个特效由五个位置共同定义。它们分散在不同目录，漏掉任何一个都不会报错，只是界面上缺一块或者参数拨了没反应。

| 位置 | 内容 | 漏了会怎样 |
| --- | --- | --- |
| `src/effects/defs/<id>.ts` | 显示名的 key、参数表 | 启动时直接报错（缺配对文件） |
| `src/effects/glsl/<id>.ts` | 着色器与 uniform 派发 | 启动时直接报错 |
| `src/effects/catalog.ts` | 分类、一句话说明、缩略图底图 | 选择器里没有图、筛不到；单测红 |
| `src/i18n/locales/zh-CN/` | 显示名、参数名、说明 | 界面显示成 key 本身；单测红 |
| `src/assets/effect-thumbnails/<id>.webp` | 卡片图 | 卡片是占位条；单测红 |

下面用 `scanline-bloom`（在画面上叠一条会走的亮线）走一遍。

## 写参数定义

`defs/<id>.ts` 只导出三个东西。文件名必须等于 `id`，否则注册表启动时报错。

```ts
// src/effects/defs/scanline-bloom.ts
import type { ParamDef } from '../types';

export const id = 'scanline-bloom';
export const nameKey = 'fx.scanlineBloom';
export const params: ParamDef[] = [
  {
    key: 'count',
    labelKey: 'fx.scanlineBloom.count',
    type: 'range',
    min: 40,
    max: 900,
    step: 10,
    defaultValue: 240,
  },
  {
    key: 'strength',
    labelKey: 'fx.scanlineBloom.strength',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.35,
  },
  { key: 'tint', labelKey: 'fx.scanlineBloom.tint', type: 'color', defaultValue: '#59f2c9' },
];
```

几条约定：

- `labelKey` 存 key 不存文案。这些表在模块加载时求值一次，写 `tr()` 会把值冻在导入那一刻的语言上。
- 参数键就是 uniform 名的后半段：`count` 对应 `u_count`。
- `visibleWhen` 控制条件可见性，收到的是含默认值的完整参数表。

## 写着色器

`glsl/<id>.ts` 导出一个 `EffectShaderDef`。`fragment` 里**不要写 `#version`、不要声明 `u_texture` / `u_time` / `u_resolution` / `vUv` / `outColor`**，这些由 `EFFECT_HEAD` 统一拼在前面，重复声明会编译失败。

```ts
// src/effects/glsl/scanline-bloom.ts
import { colors, floats, type EffectShaderDef } from '../shader-def';

export const shader: EffectShaderDef = {
  fragment: `
uniform float u_count;
uniform float u_strength;
uniform vec3 u_tint;

void main() {
  vec4 c = texture(u_texture, vUv);

  // 一条窄亮线：在 0.5 处取 1，两侧回落到 0
  float band = fract(vUv.y * u_count);
  float line = smoothstep(0.46, 0.5, band) * (1.0 - smoothstep(0.5, 0.54, band));

  vec3 rgb = mix(c.rgb * (1.0 - u_strength), u_tint, line * u_strength);
  outColor = vec4(rgb, c.a);
}`,
  setUniforms: (gl, locs, values, ctx) => {
    floats('count', 'strength')(gl, locs, values, ctx);
    colors('tint')(gl, locs, values, ctx);
  },
};
```

`setUniforms` 决定了参数有没有接上去。没有它就是四个参数恒为 0，画面不动，也不报错。派发助手有四个：

| 助手 | 用于 | 注意 |
| --- | --- | --- |
| `floats(...keys)` | `range` 参数 → `uniform float u_<key>` | 字符串参数会被 `Number()` 成 0 |
| `ints(...keys)` | `checkbox` 与整数 → `uniform int` | 会四舍五入 |
| `colors(...keys)` | `color` 参数 → `uniform vec3` | hex 转 0..1 |
| `selectInt(key, map)` | `select` 参数 → `uniform int` | map 缺失走 fallback |

参数同时有几种类型时用 `compose(floats(…), colors(…))` 拼起来。

**写 uniform 的类型必须和 fragment 里的声明逐字对应。** 对 `uniform float` 调 `uniform1i` 会触发 GL 的 `INVALID_OPERATION` 并且静默不写，值保持 0。`clockUniforms()` 就中过这一枪，8 个特效的「按拍对齐」一起失效，没有任何报错。

## 处理时间

`u_time` 的单位是**秒**，而且它是唯一的时间来源。不要写「累积相位」，那是有状态的量，seek 之后不可复现。

需要速度参数时，相位就在 fragment 里算成闭式：

```glsl
float phase = u_time * u_speed;
```

需要按拍同步时，用 `clockParams()` 造参数、`clockUniforms()` 派发。后者会在 JS 侧算好 `u_beat`（那里才拿得到拍网格），并顺带按 `speed` / `division` 换算 `u_delta`。

## 补目录条目

`effects/catalog.ts` 决定卡片长什么样、落在哪个分类、被哪些标签筛出来。

```ts
'scanline-bloom': {
  base: 'ramp',
  descKey: 'fx.desc.scanlineBloom',
  category: 'style',
  overlay: true,
},
```

`base` 是缩略图的底图，选错的表现是「缩略图上看不出变化」，等于这张图白做：

| 底图 | 变化发生在 | 给谁 |
| --- | --- | --- |
| `bars` | 颜色 | 去色、换色、二分色 |
| `ramp` | 阶调 | 量化、抖动、曝光、半调、扫描线 |
| `grid` | 形状 | 扭曲、位移、平铺 |
| `photo` | 细节 | 模糊、锐化、浮雕、颗粒 |
| `rings` | 径向 | 漩涡、涟漪、径向模糊 |
| `mandel` | 硬边 | 通道错位、边缘、霓虹 |
| `scroll` | 运动 | 运动遮罩、融帧、数据融毁 |

分类是六选一：`color` / `geometry` / `glitch` / `style` / `blur` / `signal`。`overlay` 表示它在输入之上加东西（辉光、颗粒、扫描线），而不是改写输入。

`feedback` / `multipass` / `audio` / `animated` / `hdr` 这几条标签由 shader def 自动推导，不用手写。

默认参数下画面看不出变化的特效，用 `previewParams` 给一组定格用的参数。时域特效是典型：`stutter` 在静态底图上几乎和原始画面一样。键必须真实存在，写错的键会被静默忽略。

## 加文案

三个 key，两个文件：

```ts
// src/i18n/locales/zh-CN/media.ts —— 显示名与参数名
'fx.scanlineBloom': '扫描线辉光',
'fx.scanlineBloom.count': '线数',
'fx.scanlineBloom.strength': '强度',
'fx.scanlineBloom.tint': '线色',

// src/i18n/locales/zh-CN/effects.ts —— 一句话说明，句尾带句号
'fx.desc.scanlineBloom': '在画面上叠一条会走的亮线。',
```

说明写「它做了什么」，一句，别写「很好用」。七十多条要成批读下来，句式统一才读得动。

## 出缩略图

先有目录条目，缩略图渲染器要从 `EFFECT_CATALOG` 取底图，没有条目会直接返回空。

```
node scripts/gen-effect-thumb.mjs scanline-bloom
```

它会自己 build、起 preview、用 `EffectThumbRenderer` 渲一张 640×360 WebP 落到 `src/assets/effect-thumbnails/`。顺带也验证了这个特效在离屏上下文里渲得出来。

不要用「批量导出」重建整套图。仓库里那套是逐张手挑、连带参数一起调的，批量导出给的是另一套自动底图版本，覆盖掉就回不来了。

## 验证

按顺序做，前面几条几十秒就能过：

1. 试炼场里选中它，确认画面随参数变。
2. 点「全部编译」，确认这条没有编译失败。
3. 下面三条命令：

```
pnpm exec vitest run tests/unit/effect-catalog.test.ts tests/unit/effect-thumb-assets.test.ts tests/unit/effect-uniforms.test.ts tests/unit/algo-params.test.ts
pnpm run check
pnpm run test
```

`effect-uniforms.test.ts` 用伪 GL 跑一遍 `setUniforms`，断言 fragment 里声明的每个 uniform 都被写到、写入类型和声明一致。它抓的是 `compileAll` 看不见的那一类错误。

`algo-params.test.ts` 会检查每个参数的文案键能解析、`select.defaultValue` 在选项里、`visibleWhen` 引用的键真的存在。

4. 需要断言画面行为时再加一条 E2E。判据怎么选见[测试与回归](/dev/testing/)。

## 什么时候不是「加一个特效」

带 `feedback`、pre-pass、`u_original`、`delayedInput`、吃频谱或追踪叠加层的特效，还要处理额外的协议。那些在[着色器与参数](/dev/shader-protocol/)里。

从外部移植特效时，最容易静默坏掉的三处是重复声明 uniform、把 `u_time` 当成累积相位、`u_feedback` 忘了显式开。`src/effects/AGENTS.md` 有完整清单，移植前读一遍。
