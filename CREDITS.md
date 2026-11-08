# CREDITS

本项目自有代码以 **Apache-2.0** 授权（`LICENSE`），登记规则见 AGENTS.md §1.8。
本文件同时是第三方归属声明（Apache-2.0 §4(c)），因此不另设 `NOTICE`。

## §1 引用的第三方源代码

### zivavu/openmosh（MIT）

**基础设施**

- `gl/effect-shaders.ts` 的 blend mode switch、`LAYER_BOX_GLSL`、`EffectShaderDef` / `PrePassDef` 协议、`HASH_GLSL`&`HASH_PLAIN_GLSL` → `src/engine/blend.frag.ts`、`src/engine/placement.frag.ts`、`src/effects/shader-def.ts`
- `BOUNCE_GLSL`、`HSV_GLSL`、`HUE_ROTATE_GLSL` → `src/effects/shader-def.ts`
- `gl/preview-size.ts` → `src/engine/preview-size.ts`
- `timeline/clips.ts` → `src/core/clips.ts`
- `effects/types.ts` 的参数定义类型 → `src/effects/types.ts`
- `vite.config.ts` 的 `labRedirect()` → `vite.config.ts`

**特效**

- 色彩与色调：posterize、solarize、bleach、color-correction、duotone、thermal、color-halves、hsv-swap、trio-tone
- 几何与采样：edges、neon-edges、sharpen、mirror、kaleido、polar、zoom、circle-warp、radial-blur
- 风格化与形态：emboss、stereoscopic、pixel-sort、sobel-neon、vignette、bulge、halftone
- 位移与抖动：jitter、wobble、shake、screen-jump、tile、swirl、ripple、pixel-shifter、transform-3d
- 频闪与时序故障：strobe、rgb-strobe、rgb-burst、resize-glitch、stylize-glitch、shockwave、ring-warp、channel-split-prism
- 信号与噪声：grain、soft-glitch、data-bend、vhs、composite、optical-flow、smear、relief、fiber-displace
- 反馈类：melt、tunnel、feedback、liquid-light、flow-contours
- 多 pass：glow、blur、ghosting、fast-mosh、motion-mask
- `petri`
- ISF 端口：godray、reflection、flash-glitch、kino-feedback

**音频**

- `audio/spectrum-range.ts`、`audio/spectrum-frames.ts`、`engine/spectrum-texture.ts`、`effects/{defs,glsl}/audio-bars.ts`

**openmosh的二级来源**

- Vidvox/ISF-Files（MIT）：hsv-swap、trio-tone、circle-warp、pixel-shifter、rgb-strobe、ring-warp、shockwave、resize-glitch、stylize-glitch、ghosting、fast-mosh、motion-mask
- QianMo/X-PostProcessing-Library（MIT）：rgb-burst、screen-jump、sobel-neon
- keijiro（Unlicense）：flash-glitch、kino-feedback
- pixijs/filters（MIT）：godray、reflection

### lobehub/lobe-icons（`src/assets/providers/`，MIT）

16 张 AI 提供商品牌图取自 [Lobe Icons](https://github.com/lobehub/lobe-icons)（`@lobehub/icons-static-svg`，MIT），文件名按本项目的 provider id 重命名后入库。品牌标志的版权属于对应的版权所有者。

| 本项目 id | 上游图标 |
|---|---|
| `deepseek` | `deepseek-color` |
| `dashscope` | `qwen-color` |
| `zhipu` | `zhipu-color` |
| `kimi` | `moonshot` |
| `doubao` | `doubao-color` |
| `hunyuan` | `hunyuan-color` |
| `qianfan` | `wenxin-color` |
| `spark` | `spark-color` |
| `stepfun` | `stepfun-color` |
| `minimax` | `minimax-color` |
| `siliconflow` | `siliconcloud-color` |
| `openai` | `openai` |
| `anthropic` | `anthropic` |
| `gemini` | `gemini-color` |
| `openrouter` | `openrouter` |
| `xai` | `xai` |

### 内置字体（`public/fonts/`，OFL-1.1）

- Inter
- JetBrains Mono
- Lora
- Outfit
- Sarasa Gothic SC（Regular / Bold，全量 CJK，界面中文字体；上游 [be5invis/Sarasa-Gothic](https://github.com/be5invis/Sarasa-Gothic) 的 TTF，未做子集化，文件未改动）

版权行与许可原文见 `public/fonts/OFL.txt`。前四族是排版子系统（`typography/font-registry.ts` 的 `BUILTIN_FONTS`）用的：`*.ttf` 是同一份 `*.woff2` 的无损解压，供 HarfBuzz 取轮廓；woff2 取自 `@fontsource/*` 的 latin 子集。Sarasa 只给界面用（`app.css` 的 `@font-face`），不进 `BUILTIN_FONTS`，因此没有 woff2 那一半。

### kazuhikoarase/qrcode-generator（MIT，`src/algos/symbology/`）

- `qr-tables.ts` 里的两张标准表（对齐图形中心坐标、纠错块结构）是**脚本从 npm 包 `qrcode-generator@1.4.4` 的 `qrcode.js` 逐字提取**的，不是手抄；提取脚本与理由记在 `src/algos/AGENTS.md` 的「机器可读符号」一节。
- `qr.ts` 的编码流程按该实现的同一条路径重写为 TypeScript：byte 模式位流、RS 分块与交织、之字形铺码、格式 / 版本信息布局、掩码惩罚 `getLostPoint`，以及 BCH 的三个常数 `G15` / `G18` / `G15_MASK`。`tests/unit/symbology.test.ts` 用它的**整幅矩阵**做金标对拍。

### lindell/JsBarcode（MIT，`src/algos/symbology/code128.ts`）

- Code 128 的 108 个符号图案表（`src/barcodes/CODE128/constants.js` 的 `BARS`）逐字取自该仓库。
- 码值 / 校验位（mod 103）/ Stop 的排布按标准 §4.3.5 自己实现，并且只做 subset B。

### angel-echo（内部移植）

angel-echo是未公开的内部项目。

- `src/core/prng.ts` —— `js/util.js::mulberry32`
- `src/core/commands.ts` —— `angel-echo-splitter` 的 `store.js` 快照模式
- `src/core/curve.ts` —— `Impulse` / `follower` 两条包络（闭式递推是本项目改的，见文件注释）
- `src/engine/kit.ts` —— `js/gl.js`（282 行）
- `src/algos/` —— `scenes.ts`（`js/scenes.js`）、`shader-lib.ts` 的 `ALGO_HEAD`（`LIB` 那套噪声 / 特征工具）、`rule110.ts` · `lsystem.ts` · `langtons-ant.ts` · `bifurcation.ts`（`js/automata.js`）、`menger.ts`（`mathfield` mode 6）
- `src/audio/tempo.ts` —— `tools/analyze_audio.py` 的谱通量 + 自相关
- `src/effects/glsl/echo.ts` —— `post.js::ECHO_FS` 的简化版（去掉 camera 段）
- `src/effects/shader-def.ts` —— `HASH_FAST_GLSL`、`FBM6_GLSL`（6 阶 fbm + `ridge`）、`DISC_GLSL`（黄金角 8 tap 圆盘采样）、`HSV_GLSL`（与 openmosh 同源写法，两边都有）

---

## §2 参考致谢

在Artmatic的开发过程中，Agent 参考了下列项目的实现，但并未复制源代码。

### 镜头光晕（`src/effects/{defs,glsl}/lens-flare.ts`）

- [BetterLensFlare](https://github.com/polincdev/BetterLensFlare)（MIT）：鬼影沿「光源 → 画面中心」的轴排布、逐通道错位做色散、横向拉丝的胶囊形衰减。
- Anderson Mancini 的 *Ultimate Lens Flare*（Shadertoy 上的公开实现）：星芒来自 `atan` 角度乘条数后取幂，光圈叶片的六边形边。

### 引力透镜黑洞（`src/algos/black-hole.ts`）

- [Haskely/Gargantua](https://github.com/Haskely/Gargantua)：视觉目标（薄吸积盘 + 引力透镜后的多重成像 + 多普勒增亮）。该仓库把着色器内联在 `index.html` 里、未声明许可，**未取任何代码**。
- sonicether 的 Shadertoy 作品 `lstSRS`（Gargantua 的上游）：只参照了「笛卡尔坐标下的光子测地线近似 + 逐次穿越盘面」这一公开做法；积分器、噪声、配色与参数全部按本项目重写。

### 流体（`src/algos/fluid/`）

- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)（MIT）：半拉格朗日平流 + 散度 / Jacobi 压力 / 减梯度 / 涡量约束这条 pass 链，以及 display 里「用 dye 亮度的横向/纵向差分当法线」的伪 3D 明暗。
  **未取代码**：上游是 demo 形态（画布尺寸即模拟域、rAF 驱动、鼠标事件注入、自带 bloom 与多种着色器变体），本项目的 GLSL 全部重写为固定步长 + 固定 16:9 域 + 参数/蒙版驱动注入；单位（texel/秒）、状态布局（八张 RGBA16F）、快照与确定性栅栏都没有对应物。
  其中的 Stable Fluids 流程本身出自 Jos Stam 的公开论文。

### 文本转路径（`src/typography/text-outline.ts`）

`tooooools/html-to-svg`（MIT）的 text 渲染器用 Range API 做布局、用 `rect.top + ascent` 反推基线。本项目的位置测量沿用这两条公开技法，字形轮廓与字体选择走自己的 `FontRegistry` + HarfBuzz（`glyphToPath`），没有引入 opentype.js。

### SVG 素材生成器（`src/typography/svg-gen/`）

- 10 PRINT 斜纹网格（`tenprint`）：公开的 Commodore 64 单行程序；
- Catmull-Rom → 三次贝塞尔（`blobs / waveband / squiggle / globe`）：公开的样条公式；
- 阿基米德螺旋、等距（30°）轴测投影、正交经纬球投影：教科书公式；
- 刻度盘 / 条码 / HUD 刻度：按 `rahoo.online` **导出的 SVG 结构**归纳出的几何做法（逐图元 `<circle>` / `<line>` / `<path>`），未取其源码与任何资产。

---

## 附 A：项目依赖

| 包 | 许可 | 用途 |
|---|---|---|
| `fflate` | MIT | PNG 序列导出打 zip |
| `gifenc` | MIT | GIF 导出 |
| `@lucide/svelte` | ISC | UI 图标 |
| `@zumer/snapdom` | MIT | 排版层光栅化 |
| `mediabunny` | MPL-2.0 | MP4 封装 |
| `harfbuzzjs` | MIT | 字体子集化 + 字形轮廓（文本转路径） |
| `gl-transitions` | MIT | 转场 |
| `polygon-clipping` | MIT | 图形布尔运算 |
| `pinyin-pro` | MIT | 媒体池搜索的中文名拼音匹配（**只在搜索框获得焦点时动态加载**，见 `src/ui/pool-pinyin.ts`） |
| `acorn` | MIT | Agent 的插件静态检查 `plugin_check`（只解析不执行；**只在调用该工具时动态加载**，见 `src/agent/plugin-check.ts`） |
| `wawoff2` | MIT | **仅 devDependency**：`scripts/fonts-woff2-to-sfnt.mjs` 把内置 woff2 无损还原成 TTF |

以上均按依赖引入，不复制源码入库。

`mediabunny` 以 MPL-2.0 方式授权，仓库地址见 https://github.com/Vanilagy/mediabunny 。

**npm 发布包（`npx artmatic` / `npm i -g artmatic`）是唯一例外**：包内 `dist/` 是打包产物，
上表依赖的代码以打包形式随包分发（仍然不分发它们的源码）。其中 `mediabunny` 是 MPL-2.0
的文件级弱 copyleft，本项目未修改它；按 §3.2 的源码可获得性要求，对应源码即 npm 包
`mediabunny@1.62.1`（版本与 `package.json` 一致）或上述仓库。

仅引入了 `gl-transitions` 的 MIT 子集。

---

## 附 B：评估后不使用

评估后放弃引入下面的项目，供 Agent 参考。

- `hydra-synth`（AGPL-3.0）
- `Coollab`（GPL-3.0）
- fffuel 的形状文件与生成结果 —— 许可禁止再分发
- `rahoo.online` 的 canvas 实现代码 —— 无许可声明（默认保留）；只参考了算法思路，代码未取
- `pattern.monster` / `svelte-svg-patterns` 的 476 条 tile 数据 —— 一期不做策展层，二期若接入需按 MIT 边界逐条筛选并在此登记
