---
title: 接入 Agent
description: 新功能为什么必须在控制平面里有对应方法，以及那五步分别落在哪个文件。
sidebar:
  order: 9
---

用户能在界面里做的事，Agent 也要能做。这条不是收尾工作，是功能定义的一部分。

理由很具体：一个只能手点的功能，在 Agent 眼里**不存在**。而模型不会说「做不到」，它会绕路。它会用 `typo_replace_doc` 硬写文档、用缩放近似 3D 翻转，给出一个看起来对的结果。这种失败比报错难查得多。

例外只有「改动 Artmatic 自身」的操作：应用外观与偏好、工程的存储格式、插件安装的最终确认、导出落盘路径。

## 五步

**1. 纯逻辑放进独立函数**

能在 Node 里单测的那一层单独写，比如 `typography/agent-ops.ts`。不要把它和历史状态、Svelte 组件混在一起，否则只能靠 E2E 覆盖。

**2. 控制平面加方法**

`src/agent/control-plane.ts` 是所有方法的唯一实现。校验全部前置：参数不合法时在改动之前抛 `ControlFailure`，绝不半途修改。

写工程一律走 `ProjectStore` 的既有方法或 `store.commit`，不裸改 `project`。写之前调 `beforeWrite()`：先结束正在进行的文字编辑，再取消挂起的手势。

**3. 两处工具表同加**

`src/agent/tools.ts`（应用内）与 `mcp/tools.mjs`（MCP 网关）都要有。应用内用短名，MCP 侧加 `artmatic_` 前缀。

`tests/unit/agent-tools-parity.test.ts` 断言两边的名字集合与必填参数一致。MCP 独有的工具要显式列进允许清单。

工具描述是**给模型读的 API 文档**，用英文，写清形状与单位。界面文案走 i18n 的 `agent.*`，工具卡标题用 `agent.toolName.<camelCase>`，加工具时一起加，缺键会回落到英文 id。

**4. 能力清单里列出来**

`src/agent/capabilities.ts` 的 `getCapabilities()`，排版侧是 `getTypographyCapabilities()`。模型只信这张表：没有列出来的能力，它连试都不会试。

**5. 读回形状要能被写入端原样读回**

`detail:full` 读出来的东西，写回去不能丢字段。做不到这一点时，模型会「读一遍、改一个字段、整份写回」，然后把没读到的字段清空。

## 三个容易漏的字段

**`writes: true`** 决定这次调用是否计入本轮改动数。漏标的后果是面板说「没改」，而工程其实变了。

**回显改后的值。** 写操作必须返回 `changed` 之外的落库值：`set_params` 返回 `values`，`set_clip_props` 返回 `applied`，排版写入返回 `element` / `elements`。只回 `changed: true` 时，模型只能再读一遍整份文档确认，一次往返的成本远高于一句回执。

**拒绝未知参数键。** 拼错一个字母就静默取默认值，是最难查的一类。

## 撤销

一轮对话 = 一笔撤销。会话层用 `beginTx` / `endTx` 包住整轮，`CommandStack.commit` 在事务打开时不单独入栈。

方法内部需要两笔提交时，用 `store.inTx` 判断该不该自己包事务。嵌套 `beginTx` 会覆盖外层快照，把会话层的起点抹掉。

批量写优先。`typo_add_elements` 一次调用加 21 个元素是一笔撤销；21 次调用就是 21 次整工程快照。

## 观察类工具

模型判断「改对了没有」全靠渲染回来的像素。所以观察工具要回显足够多的上下文：

- `render_frame` / `frame_signature` 返回 `layers`（由 `buildStack` 的产物算出）。没有它时，「隔离把特效轨藏了」和「我改的参数没生效」给出两张一模一样的截图。
- `render_sequence` 把多帧拼成一张联系表，时间戳烧在每格底部。单帧回答不了「这个重音落在拍上没有」。
- `region: { x, y, w, h }` 是局部放大，看 ASCII、半调、小字用它。为了细节把整帧提到 1080p 只会更贵。

## 自检两问

写完一个功能，问自己：

**能力清单里有它吗？工具描述里写了它的形状吗？**

两个都是「没有」时，模型只能猜。猜错通常不会报错，只是静默无效。
