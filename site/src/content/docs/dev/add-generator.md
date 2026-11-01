---
title: 新建一个算法生成器
description: 四种型怎么选，realtime 与 sim 各写什么，以及注册、目录、文案、缩略图的完整步骤。
sidebar:
  order: 4
---

生成器是画面的来源，不是滤镜。它没有输入纹理，输出一帧画面交给合成器。新增一个生成器要碰的位置和特效类似，但先要做一个特效不需要做的决定：**它是四种型里的哪一种。**

## 先选型

| 型 | 内容从哪来 | 适合什么 | 代价 |
| --- | --- | --- | --- |
| `realtime` | 每帧跑一遍 fragment | 分形、程序化场景、几何图案 | 每帧都算，参数可以打关键帧 |
| `sim` | 主线程上按固定步长推进的状态 | 元胞自动机、反应扩散、沙堆 | 要满足 seek 契约，向前跳帧要真算 |
| `bake` | Worker 里烘一张纹理，再按前沿揭示 | 一次算完的时空图、生长类 | 烘焙入参不能打关键帧 |
| `recall` | 时间轴上过去某一帧 | 闪回 | 只适合极少数场景，目前只有 `flashback` |

判据是「这个系统的当前状态能不能从 `t` 直接算出来」。能，就是 `realtime`；不能、而且必须一步一步走，就是 `sim`；一次算完再慢慢揭开，是 `bake`。

`sim` 有一条不可协商的契约：`seek(f)` 必须等价于从第 0 帧顺序走 f 步。预览、导出、拖动播放头全靠这一条对齐。

选完型之后，公共步骤是四件事：写 def、注册、补目录、加文案，然后出缩略图。

## 写 def 文件

`src/algos/<id>.ts` 导出一个 `GeneratorDef`。下面是一个 `realtime` 型的完整例子，画同心环：

```ts
// src/algos/ripple-rings.ts
import { colors, floats } from '../effects/shader-def';
import { intResParam, type AlgoUniformCtx } from './shader-lib';
import type { GeneratorDef } from './types';

// 不含头：ALGO_HEAD 由运行时拼在前面，已经提供了 u_time / u_resolution / u_aspect / vUv / outColor
const FRAG = `
uniform float u_count;
uniform float u_speed;
uniform float u_falloff;
uniform vec3 u_colorInk;
uniform vec3 u_colorBg;

void main() {
  vec2 p = (vUv - 0.5) * vec2(u_aspect, 1.0);
  float r = length(p);

  // 相位是 t 的闭式函数，不做逐帧累加
  float ring = pow(0.5 + 0.5 * cos(r * u_count * 6.2831853 - u_time * u_speed), 6.0);
  ring *= exp(-r * u_falloff);

  outColor = vec4(mix(u_colorBg, u_colorInk, ring), 1.0);
}`;

export const rippleRingsDef: GeneratorDef = {
  id: 'ripple-rings',
  nameKey: 'algo.rippleRings',
  kind: 'realtime',
  fragment: FRAG,
  params: [
    { key: 'count', labelKey: 'algo.rippleRings.count', type: 'range', min: 2, max: 40, step: 1, defaultValue: 12 },
    { key: 'speed', labelKey: 'algo.rippleRings.speed', type: 'range', min: 0, max: 4, step: 0.01, defaultValue: 0.6 },
    { key: 'falloff', labelKey: 'algo.rippleRings.falloff', type: 'range', min: 0, max: 8, step: 0.1, defaultValue: 2.4 },
    { key: 'colorInk', labelKey: 'algo.rippleRings.colorInk', type: 'color', defaultValue: '#e8f2ff' },
    { key: 'colorBg', labelKey: 'algo.rippleRings.colorBg', type: 'color', defaultValue: '#07080c' },
    intResParam(),
  ],
  setUniforms: (gl, locs, values, ctx) => {
    floats<AlgoUniformCtx>('count', 'speed', 'falloff')(gl, locs, values, ctx);
    colors<AlgoUniformCtx>('colorInk', 'colorBg')(gl, locs, values, ctx);
  },
};
```

`realtime` 型的两个坑：

- **fragment 不含头**，`#version` 与 `u_time` / `u_resolution` / `u_aspect` 都在 `ALGO_HEAD` 里。重复声明会编译失败。
- **`select` 参数派发不了**。`floats()` 里是 `Number(v[key]) || 0`，字符串值会静默变成 0。要区分形态就用 0..1 的 `range`。

内部分辨率统一用 `intResParam()`，键是 `intRes`，文案键全家族共用。它是性能档位，不是时间档位，画面不该随它改变形态。

## `sim` 型的写法

`create(params, seed)` 返回一个 `SimHandle`，运行时每帧按 `t` 算出该看第几步，再调 `seek()`。骨架：

```ts
import { mulberry32 } from '../core/prng';
import { gridSizeOf } from './grid-dims';
import { SnapshotRing } from './sim-util';
import type { GeneratorDef, SimHandle } from './types';

/** 与参数表里 width / height 的 min / max / default 同源。 */
const GRID = { min: 32, max: 512, fallback: 160 } as const;
const SNAPSHOT = { every: 16, cap: 64, clone: (v: Uint8Array) => v.slice() };

function createExcite(params: Record<string, number | string>, seed: number): SimHandle {
  const { w, h } = gridSizeOf(params, GRID);
  const stepsPerSec = Math.max(1, Number(params.rate) || 30);

  // 初始态只由 seed 与 params 决定 —— 这是 seek 可复现的前提
  const rng = mulberry32(seed);
  const density = Number(params.density) || 0.02;
  let cur = new Uint8Array(w * h);
  for (let i = 0; i < cur.length; i++) cur[i] = rng() < density ? 1 : 0;

  let frame = 0;
  const snaps = new SnapshotRing<Uint8Array>(SNAPSHOT, cur);
  const out = new Uint8Array(cur.length);

  // stepOnce 是这个模型的转移函数：输入当前网格，返回下一帧的网格
  const stepTo = (target: number): void => {
    while (frame < target) {
      cur = stepOnce(cur, w, h);
      frame++;
      if (snaps.shouldStore(frame)) snaps.store(frame, cur);
    }
  };

  return {
    gridW: w,
    gridH: h,
    stepsPerSec,
    seek(simFrame: number): void {
      const target = Math.max(0, Math.floor(simFrame));
      if (target < frame) {
        const snap = snaps.nearestAtOrBefore(target);
        cur = snap.value.slice();
        frame = snap.frame;
      }
      stepTo(target);
    },
    current(): Uint8Array {
      // 量化只发生在这一步：内部状态用高精度数组，输出才是 8 位
      for (let i = 0; i < out.length; i++) out[i] = cur[i] === 1 ? 255 : cur[i] === 2 ? 90 : 0;
      return out;
    },
  };
}
```

四条纪律：

- **网格尺寸是两栏**，参数键固定 `width` / `height`，读取一律走 `gridSizeOf()`。写死一个 `size` 当正方形用，在 16:9 工程里会得到「中间一块方图，两侧底色」。
- **速度参数一律叫 `rate`**，运行时每帧从当前参数读它，所以改速度不需要重建模拟。
- **快照存内部精度**。存 `current()` 的量化输出会把每一步的舍入误差累积进重放路径，`seek(f) ≡ 顺序 step f 次` 就不成立了。
- **`volatile` 列出的键不参与构造哈希**。配色、调色板、`bgMode` 这类只在渲染期读的参数必须列进去，否则拉一下配色滑杆就会重建整个模拟。代价说准一点：模拟是确定性的，重建后画面完全一样，只是要重放几千步，长片子上是秒级卡顿。

`current()` 的量化口径逐个生成器自己定。反应扩散把 v 乘 3 拉开窄动态范围，沙堆用 `sqrt(h)·96` 让 2 与 3 的差别可见。这些都是显示处理，不影响状态。

## `bake` 型的写法

```ts
export const myBakeDef: GeneratorDef = {
  id: 'my-bake',
  nameKey: 'algo.myBake',
  kind: 'bake',
  // 只在揭示 pass 里读的参数，改了不该重烘
  volatile: ['speed', 'colorBg', 'colorLive', 'bgMode'],
  reveal: 'front-y',
  params: [/* … */],
  bake: (params, seed) => {
    const w = 1024;
    const h = 512;
    const data = new Uint8Array(w * h);
    // …算完写进 data，非零像素才会被揭示出来
    return { data, w, h, frontMax: h };
  },
};
```

- 烘出来的纹理是 **R8**，活性值写 255，不要写裸 1。1 进 R8 会被归一化成 0.0039，所有阈值把它抹成 0。
- `reveal` 决定「生长」沿哪个量推进：`'front-y'` 是行、`'front-x'` 是列、`'value'` 是像素值本身。`frontMax` 的口径随它变。
- `bake` 跑在 Worker 里，函数必须是纯的，不碰 DOM。
- **新增 bake 型生成器必须登记到 `src/algos/bakers.ts`**。漏登记不会报错，`BakeClient` 只在控制台打一行，画面永远空帧。

## 注册、目录、文案、缩略图

**注册**：`src/algos/registry.ts` 的 `DEFS` 数组加一行 import 与一项。这张表是显式的，没有 glob 配对。

**目录**：`src/algos/catalog.ts` 的 `ALGO_CATALOG` 加一条。`group` 是选择器里的小标题，`previewT` 是缩略图在几秒处截。

```ts
'ripple-rings': { descKey: 'algo.desc.rippleRings', group: 'geometry', previewT: 4 },
```

`previewT` 对 `sim` 与 `bake` 是**必填且必须大于 0**，因为它们的第 0 秒是空屏。单位是秒，但形态由 `t × rate` 决定，所以各生成器的默认步频差几十倍，得按目标步数反推。

**文案**：三个 key 都在 `src/i18n/locales/zh-CN/media.ts`。

```ts
'algo.rippleRings': '涟漪环',
'algo.rippleRings.count': '环数',
// …每个参数一条
'algo.desc.rippleRings': '从中心荡开的同心环。',
```

说明限 44 字，单测会查。

**缩略图**：

```
node scripts/gen-algo-thumbs.mjs --only=ripple-rings
```

它自己 build、起 preview、调 `__lab.renderThumb()` 落盘到 `src/assets/algo-thumbnails/`。`--only` 只重渲列出的那几个，但仍按全量判断孤儿，所以不会误删别人的图。

## 验证

1. 试炼场左栏选中它，确认画面随参数变、`intRes` 切换不改变形态。
2. 点「全部编译」，确认没有编译失败。
3. 命令：

```
pnpm exec vitest run tests/unit/algo-uniforms.test.ts tests/unit/algo-params.test.ts tests/unit/bake-registry.test.ts tests/unit/algo-thumb-assets.test.ts
pnpm run check
```

`algo-uniforms.test.ts` 用伪 GL 跑每个 `realtime` 的 `setUniforms`，抓「声明了没写」「写入类型与声明不一致」「摸到未声明的名字」。这三类失效全都不报错。

4. `sim` 型补一条纯函数单测，钉住 `seek(f) ≡ 顺序 step f 次`。向前跳、向后跳、跳到同一帧都要逐字节相同。

## 默认值靠实测

生成器能不能用，多半取决于默认值。文献上的参数搬到另一个网格、另一个步频上，经常会得到「一步就死」或者「炸成一整片」。

判断「画面活不活」也要按模型选指标。`ink = 非零格数` 对连续场和多态模型没有意义：循环 CA 的 92% 格子非零，雪花的 100% 格子非零。循环 CA 要看「相邻两步变了几格」，雪花要看「冰的格数」。

`src/algos/AGENTS.md` 记了几组实测数据和判据怎么选。加新生成器之前值得翻一遍，那里每一条都是踩过一次才写下来的。
