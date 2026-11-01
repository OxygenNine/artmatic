---
title: 测试与回归
description: 三层测试各管什么，改一处代码该跑哪一层，以及怎么确认自己写的守卫真的会红。
sidebar:
  order: 7
---

三层，管的东西不重叠：

| 层 | 跑什么 | 管什么 |
| --- | --- | --- |
| vitest | `pnpm run test` | 纯函数：曲线、几何、schema 迁移、编解码、参数表自洽 |
| Playwright | `pnpm run test:e2e` | 真浏览器里的行为：画面、交互、落盘 |
| Stryker | `pnpm run test:mutate` | 测试本身有没有效 |

vitest 只测纯函数，不测 DOM，也不测 WebGL。`vite.config.ts` 里把范围限死在 `tests/unit`，`tests/e2e` 不会被收进去。

## 跑多少

不要盲目全量。按改动的位置定：

| 级别 | 改动 | 跑什么 |
| --- | --- | --- |
| A | `core` / `engine` / 共享类型 | 全量 E2E |
| B | 单个模块、单个特效或生成器 | 该模块 E2E + 相关单测 |
| C | 数据、文档、常量 | engine 单测 + JSON 校验 |
| D | 只改语言文件 | `pnpm exec vitest run tests/unit/i18n.test.ts` |

以「加了一个特效」为例，一套够用的命令：

```
pnpm exec vitest run tests/unit/effect-catalog.test.ts tests/unit/effect-thumb-assets.test.ts tests/unit/effect-uniforms.test.ts tests/unit/algo-params.test.ts
pnpm run check
node scripts/e2e.mjs tests/e2e/lab.spec.ts
```

`lab.spec.ts` 里有两条最值钱的断言：一条是「声明了但没被读过」的 uniform，另一条是 pre-pass 的参数真的生效。前者能抓「滑杆能动、画面不动」，而单测的伪 GL 看不见那一类。

E2E 单文件用 `node scripts/e2e.mjs <spec>`，不要直接调 `playwright test`。那个脚本会先 build、再起 preview，`.mjs` 的 MIME 也在那里配好。

## 守卫必须验证过才算守卫

一条永远绿的断言比没有断言更坏：它会让下一个人以为这里有防线。

纯函数层的守卫用变异测试验证。Stryker 把源码逐处改错再跑测试，测试挂了才算这条守卫有效；照样绿的是 survivor，说明它其实没挡住。

```
pnpm run test:mutate -- --mutate src/core/bitmask.ts
STRYKER_MUTATE=src/core/curve.ts pnpm run test:mutate
node scripts/mutate-triage.mjs --diff HEAD
```

范围收窄到本次改动，全量跑会明显更慢。`.stryker-report.json` 有几百 KB，用 `scripts/mutate-triage.mjs` 压成一行一条再读。

survivor 只有三种成因，必须靠「补一条能区分的输入再重跑」来判断：真缺口、等价 mutant、不可达。不要看着行号推断。

E2E 那层 Stryker 够不到，只能手工 A/B：把 bug 改回去、看它红、恢复、看它绿。`tests/AGENTS.md` 里记了二十多条已经这么验证过的例子。

## 判据怎么选

E2E 里最常见的问题是判据太弱。「画面变了」几乎总能通过，包括错误的实现。

几个踩过的例子：

- **3D 的形状判断**用了「分块均值的 L1」。换成「覆盖像素数之差」时，幂次 3 与 8 的面积接近而形态完全不同，断言把正确的实现判死了。
- **影响深度**要两条互相独立的判据：作用域外的轨道与关掉特效轨时的基线逐像素相同，作用域内确实被改了。
- **透明背景**不能直接读 alpha。渲染上下文是 `alpha: false`，`readPixels` 的 A 通道恒为 255。判据要换成「下层透出来」。
- **缩略图浮层**不能只断「存在」。压在菜单上的浮层在可见性断言下完全正常，只是那一项点不到，要用 `elementFromPoint`。

`sim` 的图表断言一律用 `settle`，不要用 `waitForSourceReady`。后者的判据是给「整幅非黑」准备的。

## 确定性

「同一个 `t` 渲两次逐字节相同」是这个项目的核心断言，但它有两个已知的 GPU 鬼：

**非整数倍缩放采样**：源尺寸到帧尺寸不是整数比时，同一帧会在启动窗口内出现两个稳定态。差异极小，预热几十帧后消失。生命游戏 64×64 到 558×314 就是这种。

**大参数 `sin`**：`fract(sin(x) * 43758.5453)` 在自变量上百之后低位不稳。用户能看见闪烁，已改用无 `sin` 的 hash。

两者都会把断言打成偶发失败。别为它们改渲染代码：要断言确定性，就在测量前多渲一帧丢弃。

有跨帧状态的特效（`feedback`、追踪叠加层）在 seek 时清空历史，那条断言本来就不适用于它们。

## 什么不该写进测试

- 渲染后的字符串。`toContainText('已保存')` 把文案变成了契约，跨语言就会失效。允许存在，但要意识到代价。
- 墙钟时间。headless 里必然 flaky。卡顿这类问题用 `ExportOptions.onFrame` 拿每帧真实耗时，`__artmatic.exportTiming(n)` 是它的 E2E 出口。
- 「改完立刻重算」的缓存行为。模拟重建后画面完全一样，只是慢，那属于延迟问题，用单测钉住哈希键就够了。
