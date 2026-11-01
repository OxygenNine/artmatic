---
title: 写一个插件
description: 插件的文件形状、能扩展什么、不能扩展什么，以及为什么它会跑在你的主 realm 里。
sidebar:
  order: 8
---

一个插件就是工程目录 `plugins/` 下的一个 ESM `.js` 文件。它导出一个清单对象，运行期用 `import(blob:)` 挂载。所以插件能带任意函数，也所以**它跑在主 realm 里，没有沙箱**。

## 最小形状

```js
// <工程目录>/plugins/my-plugin.js
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 1,
  id: 'my-plugin',
  name: '我的插件',
  effects: [
    {
      id: 'scanline',
      name: '扫描线',
      desc: '一条会走的亮线。',
      category: 'style',
      params: [
        { key: 'amount', labelKey: '强度', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      ],
      shader: {
        fragment: `
uniform float u_amount;
void main() {
  vec4 c = texture(u_texture, vUv);
  outColor = vec4(c.rgb * (1.0 - u_amount), c.a);
}`,
        setUniforms: (gl, locs, values) => {
          const loc = locs['u_amount'];
          if (loc) gl.uniform1f(loc, Number(values.amount) || 0);
        },
      },
    },
  ],
  generators: [
    {
      id: 'waves',
      name: '波纹',
      params: [],
      fragment: `void main() { outColor = vec4(0.1, 0.2, 0.3, 1.0); }`,
      setUniforms: () => {},
    },
  ],
};
```

`id` 必须是 `[a-z0-9][a-z0-9._-]*`，长度不超过 64。文件里的条目 id 是插件内部的局部 id，注册之后对外是 `my-plugin/scanline`。

那个 `/` 是判据：内置 id 与文件名一致，文件名里不可能有路径分隔符，所以「含 `/`」等价于「来自插件」。缺失插件提示靠它工作。

## 能扩展什么

- **特效**：完整的 `EffectShaderDef`，`prePasses`、`feedback` 都能用，走的是和内置特效完全相同的编译与派发路径。
- **生成器**：只有 `realtime`。`bake` 的函数要进 Worker 跑，`sim` 的确定性契约没法在加载时校验，两者都把实现交给宿主去另一个上下文里跑，而插件的函数对象不能被结构化克隆。
- **排版文档钩子**（`typography.hooks`，API v2）：`open` / `save` / `render` 三个阶段。

## 加载与校验

打开工程时，插件在工程数据读进来之后挂载。关闭工程时引用计数归零才真卸载。

挂载时会用真 GL 编译一遍，program 名与运行期同名。编不过的 def **不进注册表**，只记一条 issue，于是它保持「缺失」语义：特效链原样透传，生成器返回 null。

清单校验只做「能不能安全地交给运行期」这件事，不做语义检查。参数的业务约束（默认值是否在选项里之类）在插件这一侧**没有构建期守卫**，因为那些守卫遍历的是内置注册表。写完自己确认一遍。

校验结果里有一条值得注意：`dropped-uniform`。它表示这个 shader 声明了某个 uniform 但从没读过，对应的参数拨了不会有反应。插件侧只对参数名报这一条，纯色生成器合法地不读 `u_time`，不会因此被误判。

## 文案

插件的名字与说明是运行期字符串，用不了编译期的文案键。所以 `ParamDef.labelKey` 与 `nameKey` 的类型是 `Label`，值为字面量文本即可。

代价是插件文案不跟着界面语言变。这是刻意的：插件进不了构建期的语言表。

## 安全边界

插件是第三方任意代码，项目不对它做许可校验。`CREDITS.md` 记的是我们自己移植进来的代码，不覆盖插件。

这条边界只在导入对话框里告知一次，文案在 `pl.risk.*`。别弱化它。

## 停用与移除

停用的实现是把文件改名成 `<name>.js.disabled`，不在 `project.json` 里另记一份清单。两份真相立刻带来「不一致时听谁的」。

代价要写在面板上：重开工程之后，那一行只剩 id，因为不导入它就读不到名字。这也是刻意的：停用不该再执行它的代码。

## 入口在哪

左侧竖栏的拼图图标（提示文字「插件」）。插件是**工程级**的扩展，每个工程一套，随工程目录走，所以那个按钮紧挨着工程按钮。

## 测试

单测管纯的部分：清单校验、缺失扫描、面板模型、文件读写。

`import(blob:)`、真 GL 编译、「特效真的画到屏幕上了」这三件事只能在 E2E 测（`tests/e2e/plugins.spec.ts`，真实浏览器 + OPFS）。
