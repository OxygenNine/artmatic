---
title: 本地开发
description: 装依赖、起服务、用试炼场定参数，以及浏览器控制台里那几个能省半小时的入口。
sidebar:
  order: 2
---

## 装依赖

包管理器只有 pnpm，版本写在 `package.json` 的 `packageManager` 里，lockfile 只有 `pnpm-lock.yaml` 一份。用 npm 或 yarn 装出来的依赖会写到别的 lockfile，症状是「本机好好的、别人装出来不一样」，而且不会有任何报错。

```
pnpm install
```

Node 用 20.19 以上或 22 以上，跟 Vite 7 的要求一致。

## 常用命令

| 命令 | 做什么 | 什么时候跑 |
| --- | --- | --- |
| `pnpm run dev` | Vite dev server，`http://localhost:5173` | 日常开发 |
| `pnpm run build` | 生产构建，末尾跑一遍产物守卫 | 收尾前 |
| `pnpm run preview` | 预览 `dist/`，`http://localhost:4173` | 验构建产物 |
| `pnpm run check` | `svelte-check` 类型检查 | 改完代码 |
| `pnpm run test` | vitest，只收 `tests/unit` | 改完纯函数 |
| `pnpm run test:e2e` | 自 build、自起 preview、跑 Playwright | 改渲染 / 界面 |
| `pnpm exec vitest run tests/unit/x.test.ts` | 只跑一个单测文件 | 反复调一条用例 |
| `node scripts/e2e.mjs tests/e2e/x.spec.ts` | 只跑一个 E2E | 同上 |

E2E 用系统装的 Chrome（`channel: 'chrome'`），不需要 `playwright install`。整套跑得慢，所以平时只跑受影响的那一个文件，范围怎么定见[测试与回归](/dev/testing/)。

## 两个入口

主应用在 `/`，试炼场的完整地址是 `http://localhost:5173/lab/`。末尾那个斜杠不能省，`/lab` 会被 SPA fallback 端成主应用，看起来像「试炼场坏了」。

试炼场是第二个 HTML 入口，有自己的 canvas 和 renderer，不引导主应用。它存在的理由只有一条：决定哪些特效与生成器值得留下、默认参数该定多少。左右两栏分别选源和特效，工具栏可以切分辨率档位、看帧耗时。

新写一个特效之后，第一件事是在试炼场里看它。那里能单独看一个特效在测试图上的样子，比在主应用里叠一整套轨道快得多。

## 浏览器控制台里的入口

主应用挂了 `window.__artmatic`，试炼场挂了 `window.__lab`。几个常用的：

```js
// 把当前上下文里的所有着色器预编译一遍，返回逐条结果
__artmatic.compileAll()

// 渲染某一帧并读回像素（调试用，别在业务代码里依赖）
__artmatic.renderFrame(2.5)
__artmatic.readPixels()

// 控制平面：所有 Agent 能做的事，这里都能做
__artmatic.control.getCapabilities()
__artmatic.control.renderFrame({ ... })
```

试炼场那边有 `__lab.compileAll()` 与 `__lab.compileState()`，脚本批量导缩略图时用的 `__lab.renderThumb()` 也在同一处。

要改工程状态，优先走 `__artmatic.control`，不要直接动 `appState.store.project`。控制平面会做校验、走 `store.commit`、进撤销栈，绕过它的改动不会留下撤销记录。

## 着色器是惰性编译的

`effects/runner.ts` 第一次用到某个特效时才编译它的 program。所以一段有语法错误的 GLSL 在你点开那个特效之前不会报错，构建也不会红。

改完着色器之后有两个动作：

- 进试炼场点「全部编译」，它覆盖所有特效的主 pass 与每一环 pre-pass、所有 realtime 生成器、所有转场。
- 或者在控制台调 `__artmatic.compileAll()`，返回里 `failures` 为空才算过。

预编译和运行期用的是同一个程序名（`effectProgramName` / `algoProgramName`），所以预编译不会另编一份。

## 改完看不到变化怎么办

`defs/` 与 `glsl/` 里的定义表是在模块加载时求值一次建好的。改完这些文件如果界面没变，整页刷新一次。

`effects/types.ts` 里那句注释解释了同一件事的另一面：定义表里不能写 `tr('…')`，值会冻在导入那一刻的语言上，之后切语言永远不更新。所以表里只存 key。

## 文档站

官网是独立子项目 `site/`，不进主构建：

```
pnpm run site:dev     # http://localhost:4321
pnpm run site:build   # 产出 site/dist
```

`site` 的 `dev` 与 `build` 都会先跑一遍 `gen`：`tokens.css` 来自 `src/ui/tokens.ts`，`stats.json` 来自仓库里的实际数量，`content/docs/api/` 来自 TypeDoc。这三样都是生成物，不要手改。

所以首页那句「81 个特效」不是手写的，加一个特效之后它会自己变。
