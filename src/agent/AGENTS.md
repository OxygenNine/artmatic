# src/agent/ —— Agent 控制平面 + 应用内模型运行时

**这是 agent 的唯一操作面**：读场景 / 写工程 / 出图 / 导出 / 排版 / 插件。
面板（`ui/agent/`）与 MCP 网关（`mcp/`）都只是它的传输壳。

**何时读我**：加 / 改工具、改控制平面方法、动插件作者面或排版写入、
改模型运行时（provider / session / executor）、抬 `CONTROL_API_VERSION` 时。

相关：根 `AGENTS.md`（依赖方向 · 一轮一笔撤销）、`src/typography/AGENTS.md`
（文档模型）、`src/plugins/AGENTS.md`（插件安全边界）、`docs/agent-control-plane.md`（方案与契约全表）。

---

## 分层与依赖

```
tools.ts        工具表（名字 / 描述 / 参数 / writes）—— 应用内与 MCP 的共同真源
control-plane.ts 所有方法的唯一实现（读写看导 + 排版 + 插件）
scene.ts        纯函数：场景快照（可在 Node 里单测）
capabilities.ts 能力发现（ids / params 两档）
typography.ts   排版写入（校验前置，落库走 store.commit）
plugin-spec.ts  运行期组装的协议说明书（help 按需取）
plugin-author.ts 试挂 / 安装 / 丢弃 / 移除
llm/            provider（SSE）→ session（工具循环）→ executor（工具名映射）
```

- **不 import `ui/`**：运行期实例全部走注入的 `ControlContext`。
- **可以 import `typography/` 的纯模型层**（`document` / `shapes` / `svg-gen` /
  `theme` / `animation` / `agent-ops`），**禁止** import `typography/render-dom`（DOM）。
- **不 import `project/plugins`**：写盘走 `ctx.persistPlugin` / `ctx.removePlugin`，
  插件宿主走 `ctx.getPluginHost()`（结构类型 `AgentPluginHost`）。
- `getStore()` 每次重新取 —— 多工程下缓存它必然错。

## 写操作的纪律

- 一律走 `ProjectStore` 的既有方法或 `store.commit`；**不许裸改 `project`**。
- 写之前 `beforeWrite()`：先 `stopTextEditing()`（打字是直接改 `doc.runs`，
  不停会被编辑器下一次提交覆盖），再 `cancelPendingGesture()`。
- **一轮对话 = 一笔撤销**：session 用 `beginTx` / `endTx` 包住整轮，
  而 `CommandStack.commit` 在事务打开时**不单独入栈**（`core/commands.ts`）。
  不要在事务内再手动 begin 第二层事务。
- **会话历史不在 `project.json` 里**（v12 起）：数据模型在 `agent/history.ts`，
  落盘在工程目录的 `agent/sessions/<id>.json`（`project/agent-history.ts`），
  一个会话一个文件。理由：挂在工程上时「聊一句 = 原子重写整份工程」，而且撤销
  栈要专门剔除它 —— 那条特例本身就是设计味道。现在一轮对话只写自己那个文件，
  删会话是 unlink，坏文件只丢一条会话。
  上限仍是 30 会话 / 400 条 / 20k 字（`sanitizeAgentSessions`），图片只留说明。
  被上限挤掉的会话**要连文件一起删**（`upsertAgentSession` 回传 `evicted`），
  否则下次打开它又回来了。
  内存副本挂在 `OpenProject.agentSessions`（切选项卡各看各的）；没有目录
  （工程还没保存）时只在内存里，首次保存由 `flushAgentHistory` 补写。
- **恢复会话走摘要，不落 `tool_calls`**：`resumedMessages()` 只把 user / assistant
  的文本接回线格式（相邻同角色合并），工具调用与截图不进上下文 —— 存下来既臃肿，
  又会和换过的模型不兼容；硬造一对出来还会因为孤立的 `tool_call_id` 直接 400。
  起点经 `SessionOptions.initialMessages` 注入，`session` 在末尾补
  `RESUME_NOTE`（「工具调用没保存，改前先读工程」）。**别把 RESUME_NOTE 拼进
  系统提示**：那是每次请求的前缀缓存锚点，必须整会话不变。
  恢复**不进控制平面**（也就不进工具表 / 能力清单）：会话日志不是工程内容，
  而且模型换掉自己正在跑的那条会话没有意义 —— 它属于 §1.9 那个「改动 Artmatic
  自身」的例外，由 `ui/agent/agent-state` 直接读写。
- 校验全部**前置**：参数不合法时在改动之前抛 `ControlFailure`，绝不半途修改。
  `setCurve` 额外校验贝塞尔手柄的形状（`handles` 4 元组 / `hOut` / `hIn` 2 元组，
  全是有限数）—— 形状不对会在求值侧变成 NaN，表现为「整条曲线在画面上静默消失」。

## 工具面

- **根 AGENTS §1.9：新功能必须 Agent 可达。** 加功能时把「纯函数原语 → 控制平面方法 →
  两处工具表 → 能力清单 → 描述」一次走完；漏掉能力清单，模型连试都不会试。
- 工具描述是**给模型读的 API 文档**（英文），界面文案走 i18n 的 `agent.*`。
  工具卡的标题用 `agent.toolName.<camelCase>`（`ui/agent/tool-labels.ts` 把
  `ask_user` 这样的 snake_case 转成键段；i18n 守卫只允许 `[a-zA-Z0-9]`）。
  加工具时**同时**加显示名 —— 缺键会回落到英文 id，那正是漏登记的可见信号。
- `writes: true` 决定「是否计入本轮改动数」。漏标的后果是面板说「没改」，
  而工程其实变了。
- **每加一个工具，两边都要有**：`src/agent/tools.ts` 与 `mcp/tools.mjs`
  （应用内短名 ↔ `artmatic_` 前缀）。`tests/unit/agent-tools-parity.test.ts`
  断言名字集合与必填参数一致；MCP 独有工具要显式列进允许清单。
- 拒绝未知参数键（拼错一个字母就静默取默认值是最难查的一类）。
- **写操作必须回显改后的值**：`changed:true` 让模型只能再读整份文档 / 再渲一张图
  来确认，而一次往返的成本远高于一句回执。排版写返回 `element` / `elements`，
  `set_params` 返回 `values`，`set_clip_props` 返回 `applied`。
- **片段 / 段落 / 特效实例的四个后补入口**（2026-10-22）：`set_clip_props` 的
  `fadeIn` / `fadeOut` / `srcIn` / `crop` / `quad` / `key`、`edit_sections`（add /
  split / rename / remove / move 五合一）、`set_params({ enabled })`（参数变可选）、
  `set_generator`。共同纪律：`null` = 关掉那个效果；只回**落库值**；需要两笔提交时
  靠 `store.inTx` 判断要不要自己包事务 —— `beginTx` 会覆盖外层快照，嵌套调用会把
  会话层的起点抹掉。
- **批量写优先**：`typo_add_elements` / `typo_update_elements` 一次调用 = 一笔撤销，
  数组顺序即 z 序。不要把一个元素一次往返当成「更安全」——21 个元素就是 21 次
  整工程快照。
- `typo_measure` 是**纯读**的几何体检（文字实际内容高度 / 溢出 / 相交 / 出画）。
  文字度量优先用 DOM，没有 DOM 时标 `estimated:true`；别把估算当实测。
- `render_frame` / `frame_signature` 的 `only` 是**观察用**隔离（浅拷贝一个
  project 给渲染器，不改 store、不 bump version）。它只在出图这一帧生效。
  `trackId` / `elementId` 都接受数组。**隔离会连特效轨一起隐藏** —— 它是「看某一层
  自己的画面」，不是「试特效」；绑定在目标片段上的链除外（那是这一层的一部分）。
- **观察必须回显「合成了哪些层」**：`render_frame` / `frame_signature` 的返回里带
  `layers`（由 `buildStack` 的产物算出）。没有它时，「隔离把特效轨藏了」与
  「我改的参数没生效」给出**一模一样**的截图，模型只能靠猜。
- `render_sequence({ from, to, step, size, cols })` 是**节奏自检的入口**：多帧拼成
  一张联系表（时间戳烧在每格底部）。单帧回答不了「这个重音落在拍上没有」。
- `region: { x, y, w, h }`（0..1）是**局部放大**：裁完按最近邻放大到 ≥480px 宽。
  看 ASCII / 半调 / 小字用它，不要为了细节把整帧提到 1920（token 一样贵）。

### 特效片段的作用方式：影响深度 vs 绑定片段

- `affectDepth`：adjustment layer，作用于下方 N 条启用轨的合成结果（要占一条轨）。
- `boundClipId`（v11）：链只跑在**那一个 source 片段的层**上（placement 之后、
  blend 之前），与 z 序无关、不影响别的层。**节拍级短促特效用它**，否则每一段
  卡点都要开一条轨道，而「叠在哪一层上」这个意图在轨道序里反而看不出来。
- 两者**互斥**：`makeEffectClip` / `setClipProps` / `validateProject` 三处都按
  「绑定优先」处理（同一次 patch 给两个直接拒绝）。目标必须是存在的 source 片段。
- 工具描述里因此写了「不要吝啬轨道也别滥开」：一条长链 > 一特效一轨，
  `boundClipId` > 一卡点一轨。

### 曲线寻址（`set_curve` 的 `param`）

`<instanceId>.<key>` 是规范形式；同时接受**唯一前缀**、**唯一 defId**（`blur.radius`）
与**单独的参数键**（全链只有一个实例有它时）。歧义一律报错并在
`detail.candidates` 里列出 `chainIndex` + 完整 `instanceId` —— 随便挑一个的表现是
「曲线跑到了另一个特效上」，从画面上极难看出来。`add_effect` 返回
`{ instanceId, chainIndex, keyPrefix }`，`keyPrefix + key` 永远可直接用
（实例 id 是完整 `newId()`，不再截短 —— 两种 id 形态并存是这条反馈的根因）。
曲线对象缺 `interp` 时按 `smooth` 落库，不要再用报错逼模型学这个字段。

## v21：粒子与素材参数

| 想做什么 | 工具 | 读回 |
|---|---|---|
| 调粒子参数 / 应用预设 | `set_params`（把预设的参数值一次写进去） | `{ values }` |
| 绑精灵图 / 发射密度图 | `set_params({ spriteAsset: assetId })` | `{ values }` |
| 解绑 | `set_params({ spriteAsset: '' })` | `{ values }` |

- **`asset` 型参数的值是字符串**：assetId 或空串。视频、数字、图片对象都不收。
  `checkAssetParams` 在写库**之前**校验 id 存在且 `kind === 'image'`。少了这一关，
  模型会凭空编一个 id，回执说改好了，渲染侧却静默回退无贴图。
- **形状与单位在 `getCapabilities().features.particles`**：`presets` 给预设名，
  `assetParams` 给键，`units` 说明 `rate` 是步/秒、`life` 是秒。
  `serializeParam` 给 `asset` 带上 `accept`，给所有参数带上 `group`。
- **预设不整表替换**：`applyParticlePreset` 只改预设声明过的键。模型要一次写全组值，
  就得把这组键值一起传给 `set_params`；单独传一个不存在的 `preset` 键会被
  `checkKnownKeys` 拒掉，这是有意的（不留「选项能选、画面不变」的静默入口）。
- 两处工具表的 `set_params` 描述都写了 asset 形状，改描述时两边同改。

## v13 新增的能力面（别漏了其中任何一处）

| 功能 | 控制平面 | 工具 |
|---|---|---|
| 转场两端 | `setTransition(..., side)` / `clearTransition(clipId, side)` | `set_transition.side` / `clear_transition.side` |
| 预剪辑范围 | `getAssetRanges` / `setAssetRange` / `removeAssetRange` / `setActiveRange` | 同名四个工具 |
| 视频音频 | `detachVideoAudio` / `setAudioLock` / `setClipAudio` | 同名三个工具 |
| 素材显示名 | `renameAsset`（只改 `assets[id].name`，**不动**文件名 / 路径 / 片段 label） | `rename_asset` |
| 手动节奏点（v21） | `setBeatMarks`（整表替换，秒 / 升序 / 不改 `beatGrid`） | `set_beat_marks` |

- `getCapabilities().features` 是模型唯一能看到「转场有 in/out、视频自带声音、增益单位是
  dB、-60 是静音」的地方。新增跨子系统语义时先加这一块，再加工具描述。
- 转场 `transitionCut` **不要求转场已存在**：控制平面靠它判断「首次设置放不放得下」。
  别在那里加 `if (!clip.transitionOut) return no-transition` —— 首次设置会永远被拒。
- `detail:'full'` 的片段读回包含 `transitionIn` / `transitionOut` / `audio` /
  `linkedAudioId` / `gainDb` / `linkedVideoId` / `lockedTo`，写回端必须能原样吃回。

## v20：调制器（参数的第二层）

| 想做什么 | 工具 | 读回 |
|---|---|---|
| 看有哪些调制器、谁在引用它们 | `list_modulators` | `{ modulators: [{ id, name, expr, unit, refs }], functions }` |
| 建 / 改表达式 | `set_modulator`（省略 `id` = 新建） | `{ id, created, expr, refs }` |
| 删除（连带摘引用） | `remove_modulator` | `{ removed, refs }` |
| 绑到参数上 | `bind_modulator`（`param` 用 `set_curve` 的可读名规则） | `{ param, slots }` |
| 解绑 | `unbind_modulator`（给 `modulatorId` 只摘一档） | `{ param, slots }` |

- **表达式先解析再落库**：文本模式的逃生舱允许用户写错（他会看到错误位置），但模型
  拿不到那种反馈 —— 它会以为自己改对了。所以 `set_modulator` 在写之前 `parseCached`。
- 词汇表只有一份：`core/expr.ts::EXPR_FUNCS`。`capabilities.ts::exprFunctions()` 与
  `list_modulators` 都读它，**别在工具描述里手写第二份参数个数**（描述里那张清单是
  给人读的摘要，改词表时一起改）。
- `add` 模式的增益是**参数自己的单位**（`transform.x` 的 40 = 40 个单位），`mul` 是
  0..1 的混合系数。把这两句写进工具描述，否则模型会给 `mul` 传 40。
- 调制与关键帧**共存**：`set_curve` 与 `bind_modulator` 不互斥，绑定时别顺手清曲线。

## v14：视频变速（两个入口，别混）

| 想做什么 | 走哪 |
|---|---|
| 整体快放 / 慢放（保持片段长度） | `set_clip_props({ speed })`，正数 0.05..100 |
| 变速动画 / **倒放** | `set_curve(clipId, "speed", …)`，负值 = 倒放 |

- 写常速会**清掉 `speed` 曲线**（曲线是求值的唯一真源，留着就是「改了值但画面没变」）。
- 素材不够时片段会被缩短（用户点名的「除非因速度过快导致可用时长不足」），所以
  回执里多一个 `applied.end` —— 只回 `speed` 会让模型下一句说错长度。
- `getCapabilities().features.videoSpeed` 是模型唯一能看到「保持长度 / 负值只走曲线」
  的地方；工具描述别只写区间。
- 内嵌音轨在速度 ≤ 0 时**静音**（预览与导出同规则）。不要在工具描述里承诺「倒放有声」。

## v15：静音（片段 + 轨道）

| 想做什么 | 走哪 |
|---|---|
| 单条视频的嵌入音轨静音 | `set_clip_audio({ muted: true })` |
| 整条视觉轨的声音静音（画面保留） | `set_track({ muted: true })` |

- 两种静音都只关**声音**，画面照常，导出同样生效（预览 / 导出 / 预热表读同一张
  `audioSpans`）。
- 音频轨拒绝 `set_track.muted`（`invalid-argument`）：它的 `enabled` 就是喇叭。
  「整条音频轨闭嘴」用 `set_track({ enabled: false })`。
- 读回：`get_scene().tracks[].muted` 只在视觉轨上出现（**总是**给布尔，模型不用猜
  缺省）；片段侧读 `clip.audio.muted`。`set_track` 的回执对音频轨给 `muted: null`
  —— null 就是「这条轨没有这个概念」，不是 false。

## 能力清单（`getCapabilities`）

- `detail:'ids'` 只给 id；`params` 给完整参数表（键 / 类型 / 区间 / 选项 / 默认值 /
  能否打关键帧）。**参数表可以很大**，所以支持 `ids` 过滤。
- `ParamDef.visibleWhen` 是函数，序列化时必须剥掉（`serializeParam`）。
- **单位是能力清单的一部分**：排版清单的 `units` 说明 frame 是 px / `rot` 是
  弧度、形状参数谁是 px 谁是 0..1、生成器参数在 0..100 authored 盒里；
  生成器的 `notes`（`SvgGenSpec.notes`）只写参数表看不出来的夹取 / 覆盖。
  少了这两处，模型只能靠渲染图反推量级。
- 文本片段的 `source.doc` 在快照里只给摘要（`ClipTextSummary`），详情走
  `getTypographyDoc` —— 这是 `CONTROL_API_VERSION = 2` 的读形状变更。
- 段落标记（v3）在 `head()` 里给**两份快照**：`sections: { id, name, start, color? }`。
  只给起点（结尾 = 下一段起点），否则 agent 读到的是「视图的算法」而不是数据。
  音频片段另给 `fadeIn` / `fadeOut`（0 不铺开）。
- 抬版本时同步 `mcp/index.mjs` 与 `tests/e2e/agent.spec.ts`（后者 import 常量）。

## 排版写入

- 纯函数在 `typography/agent-ops.ts`，这里只做校验 + `store.commit`。
- 每个写方法一次 `commit`（一个工具调用 = 一笔撤销）。
- `coerceDocument` **永不抛**：坏元素整条丢弃，工程必须打得开。
- 文本元素的三层填充别混：`fill`（字形）/ `boxFill`（文本框底）/ `boxStroke`（边框）。
- **文本的纯色 `fill` 在写入时翻译成 `style.color`**（`agent-ops.ts::applyTextFill`）。
  渲染侧本来就只让渐变 / 径向 / 纹理走 `background-clip: text`；不翻译的话
  「同一个字段渐变有效、纯色被静默忽略」，模型会以为自己写错了字段名。
  读回的视图因此是 `style.color`，`fill` 只在渐变类时出现。
- **agent 造的形状默认是空的**：没给 `fill` ⇒ `{kind:'none'}`，没给 `stroke` ⇒ `null`
  （`line` 在工厂里那条白色 4px 描边也一样被覆盖）。面板路径的实心紫是为「人先看见
  再改色」服务的，agent 的默认值必须**不改动画面** —— 一块没打算要的紫足以毁掉
  一张合成图，而 640 宽的截图里分辨不出它是不是默认值。默认值写在
  `get_typography_capabilities().units.defaults` 里，别只写在代码注释里。
- **生成器用 `fill` 画**：`barcode` / `hudticks` 这类是密集的闭合矩形，`stroke`
  会描每一根的轮廓，宽度一过就煳成实心板。这条写进了各自 spec 的 `notes`。
- 布局优先走 `typo_layout`，别让模型手算坐标。布局结果回显每个元素的新 frame。
- **画幅 / 组框 / 配色 / 图层下标**（2026-10-22 P2）：`typo_set_canvas_size`
  （`scaleContent` 决定要不要过 `resizeDocument`）、`typo_update_group`（成组只建壳，
  不给样式壳不可见）、`typo_save_theme` / `typo_remove_theme` + `typo_set_theme({scope})`、
  `typo_reorder_element({op:'index'})`。配色的 `colors` 是**局部补丁**，槽位键从
  `get_typography_capabilities().themeSlots` 取；删方案要连引用一起抹。
- 图片元素的 `key` / `quad` 与片段共用 `core/image-fx.ts` 的 `coerce*`：两处各写一份
  的形态是「同一个 `{tolerance}` 在时间轴有效、在排版里被静默丢掉」。
- **路径族**（2026-10-22 P3）：`typo_boolean`（差集按 z 序，最底下的是被减数）、
  `typo_divide`、`typo_convert_to_path`（文本轮廓走注入的 `ctx.outlineText` ——
  `text-outline` 拉 `render-dom`，控制平面不许 import）。几何逻辑在
  `typography/shape-convert.ts`，编辑器与 agent 共用；顶点编辑不需要新工具
  （`path` 可写）。
- **行内富文本**：`runs` 读侧只在真有覆盖时给（否则 `text` 能重建），写侧过
  `rich-text.ts::coerceRuns` —— `normalizeRuns` 只合并不校验，拼错的 key 会静默失效。
- **镜头是文档级、景深是元素级**（P5）：`typo_set_camera` 按出现的键合并、`null` 复位；
  每个元素靠 `typo_update_element.depth`（0 缺省 = 无穷远、1 = 完全跟随）决定吃多少。
  单位是 px / 倍 / **度**（与 `transform3d` 同口径，不是 `frame.rot` 的弧度）。
  两条不能猜错的语义：**镜头不改变图层矩形**（位图永远覆盖 `doc.size`，推出画布 = 出画）、
  **全 depth 0 时画面与没有镜头逐像素相同**（缓存键也逐字相同 —— `docHash` 刻意不含
  camera / depth，它们的效果由 `camera.ts::parallaxSignature` 表达）。
  模型的判断依据在 `get_typography_capabilities().units.camera / depth / cameraTracks`。
- **镜头关键帧是第二条求值路径**：`typo_set_camera_animation({ channel, keys })`
  写 `doc.animations` 里的 `camera.*` 轨道（**整条覆盖写**，`null` / `[]` 删轨道），
  读回在 `get_typography_doc → cameraTracks`。三条不能猜错的语义：**有帧的通道
  忽略 `typo_set_camera` 的基准值**；`t` 是片段内绝对秒、`v` 的量纲随通道
  （px / 倍 / 度）；一旦有关键帧，这份文档就变成逐帧光栅化（缓存键逐帧不同）。
- **媒体池**：`media_list` / `media_op` 经 `ctx.mediaPool` 注入（实现需要目录句柄
  与播放器）。默认要用户确认（偏好 `mediaPoolConfirm`）：未确认 = `needs-approval`，
  `confirm:true` 只由会话层在用户点过之后传。返回值是「真的改了几条」，0 = 什么都没做。
- **动画是文档的一部分**：`typo_set_animation` / `typo_add_element.animation` 写的是
  `typography/animation.ts` 的 CSS 动画（预览与导出同一条求值路径）。
  `keys[].at` 收 0..1 或 `{ beat: n }`（换算在 `control-plane.ts`，文档模型只收 0..1）；
  预设名必须从 `get_typography_capabilities().animations.presets` 取 —— 猜错拼写
  的表现是「动画没生效、也不报错」。视图里回显**完整动画字段**，否则模型读不回
  自己设过什么。
- **格式刷 / 动画刷**（2026-10-24）：`typo_copy_style({ sourceId, targetIds, what })`
  与编辑器两个按钮走**同一条纯函数**（`typography/format-painter.ts`）。`what:'format'`
  只搬外观（填充 / 描边 / 圆角 / 文本样式 / 图片处理 / 阴影与虚化），不搬内容、几何、
  `opacity` / `blend`；`what:'animation'` **整份替换**并重新发号。返回 `changed`
  = 真的改了几个（0 = 本来就一样，不是错误）。能力清单在
  `get_typography_capabilities().styleCopy` —— 少了它，模型会拿它当 duplicate 用。
- `typo_replace_doc` 的 `droppedKeys` 是契约的一部分：未知键逐条报出来（
  `elements[2].colour`），静默归一化会让模型照着一份自己以为对的文档继续做。
  同理 `docView` 的 `full` 对缺 `fonts` / `elements` 的旧文档必须兜底（曾经整档崩 `internal`）。

## 排版文档脚本（`doc.scripts`）

- 工具：`typo_set_scripts({ clipId, scripts })` 整表替换（一笔撤销，数组顺序 = 执行
  顺序）；`[]` 清空，**省略字段保留**（与 `animations` 同一条无损往返纪律）。
  `get_typography_doc({detail:'full'})` 带 `scripts`；`typo_replace_doc` 省略时保留。
- **能力清单是 API 的唯一真源**：`get_typography_capabilities().scripts` 给
  `ctx` 字段 / 元素与逐字句柄 / 纯函数 / `needs` / 上限 / 模板 / `running` / `rules`。
  改 `ctx` 的任何方法都必须同时改这里与 `mcp/tools.mjs` 的 `typo_set_scripts` 描述。
- 写入前**编译检查**（`checkScriptSyntax`，只编译不执行）：语法错误在改动之前抛
  `invalid-argument`，带脚本名与引擎消息。结构错误（重复 id / 未知 needs / 超长）
  也拒绝而不是 `sanitize` 后静默降级 —— 降级的表现是「回执说成功、画面没变化」。
- **不要承诺效果已经可见**：脚本总开关默认关（`UiPrefs.runTypoScripts`），关闭时
  画面与没有脚本逐像素相同。`scripts.running` 就是写给模型看的那句话。
- `scripts` 是可选字段 ⇒ 不抬 `SCHEMA_VERSION`；但 `coerceDocument` 的 `DOC_KEYS`
  必须包含它，否则整份替换会把它当未知键丢掉。
- 诊断（编译失败 / 运行错误 / 超预算）不进文档，在 `typography/script/diagnostics.ts`；
  工具回执不返回它们（本轮不把运行期状态混进读形状）。

## 插件作者面

- **改写循环是五件套**，不是「整份重发」：`plugin_view`（分页读）→ `plugin_grep`
  （正则定位）→ `plugin_edit`（唯一字面量替换）→ `plugin_check`（静态检查）→
  `plugin_try`（试挂）。Agent 起不了终端，这五个工具是它唯一的插件编辑面。
- **`plugin_edit` 只改内存草稿，不执行、不写盘**。执行只发生在 `plugin_try`，
  所以编辑工具的确认门是「没有」而不是「也要确认」——但反过来，`plugin_try`
  **省略 `source` 时用的是草稿**；若它仍然强制整份源码，「只改一行」既省不下
  token，又给了模型把无关处改回去的机会。改这条链路时两件事必须一起改。
- **源码来源是草稿优先、磁盘兜底**（`resolveSource`）：`plugin_view` / `grep` /
  `check` / `edit` / `try` 都走同一条。已安装插件从磁盘读，靠注入的
  `ctx.readPluginSource`（控制平面不 import `project/plugins`）；读源码**不执行**
  任何代码，所以没有确认门。
- **`plugin_check` 用 acorn 真解析，绝不 `import()`**：后者会执行插件，正是
  `plugin_try` 才该做的事。acorn **动态加载**（只在调用该工具时进 bundle）。
  它报 `syntax | import | dynamic-import | no-export | bad-format`：插件是单文件、
  经 blob 载入，任何模块说明符都解析不了。
- 两级安装：`plugin_try`（内存载入 + 真 GL 编译，可预览）→ `plugin_install`（写盘）。
  **两级都必须用户确认**，否则返回 `needs-approval` —— 试挂不是「只看一眼」：
  `host.importBytes` 会 `import()` 源码，也就是**立刻在主世界执行**。确认必须挡在
  它之前，否则「未确认时没有实例」这条判据不成立。省略 `source` 走草稿时也一样。
- `plugin_try` 的 `confirm` **不暴露给模型**（工具面没有这个参数，模型不能自批）；
  它只由 session 在用户点了审批卡之后带 `confirm:true` 重调。MCP 面的 `confirm`
  由客户端用户决定。「本次会话允许试挂」只活在 UI 会话里，不进协议。
- 草稿只活在控制平面实例的内存里；安装之后磁盘才是真源。
- 只写 `plugins/<合法 id>.js`（`isValidPluginSegment`），没有任意路径写、没有 eval。
- `plugin-spec.ts` 的说明书由 `EFFECT_HEAD` / `ALGO_HEAD` 常量拼出 ——
  加 uniform 时文档自动跟上；单测断言「两个头的每个 uniform 都出现在文档里」。
- 插件是单文件、不能 import，所以说明书里要带可直接粘贴的 helper。

## 上下文注入（`context.ts`）

三件事共用一份纯函数（单测 `tests/unit/agent-context.test.ts` /
`agent-usage.test.ts`）：

- **用户标注**（右键「添加进上下文」）：片段 / 排版元素拼进**那条 user 消息的末尾**，
  不独立成一条 —— 独立消息会被模型当成「之前某轮说过的话」，而它其实是这句话的宾语。
  元素按所属片段分组（`typo_*` 都要 `clipId`）。**id 与显示名必须同时写**：只给名字
  模型定位不了，只给 id 它读不懂「这个」指的是哪个。
- **界面快照**（`renderUiContext`）：播放头（秒 / 帧号 / 小节拍）+ 在哪一页 +
  选中了什么，**同样只贴在 user 消息尾部，绝不进系统提示**。数据源是注入的
  `ControlContext.getUiContext`（装配在 `ui/agent/context-bridge.ts`：id → 显示名
  要走 i18n）。它**不是工具** —— 多一次往返只会拿到更旧的状态。
- **插话**（`interjectionText`）：模型干活期间用户发的话，在**下一次模型调用之前**
  追加成一条 user 消息（见下节）。

### 缓存纪律（2026-10-24 核实四家文档）

**系统提示必须是整个会话不变的纯常量。** 前缀缓存按**字节**比前缀，而
`prompt_tokens` 就是账本：`messages[0]` 一变，后面全部历史按未命中计费
（DeepSeek 文档的例子 2：`A+B` → `A+C` 命中不了，要等第三次认出公共前缀）。
所以动态语境（播放头 / 选区 / 标注）只能加在**尾部**，且同一输入的拼装顺序固定。

其余会打碎前缀的动作，都是「必须付」的代价，别在上面做优化：
`maybeCompact`（历史被摘要替换）、`trimMessages`（硬裁剪）、400 后清空历史。
它们一旦发生，这一轮的命中率会掉到 0 —— 那是**真的**，不是显示 bug。

各家机制（细节与出处见 `docs/provider-matrix.md` §8）：

| 家 | 开启 | 上报字段 |
|---|---|---|
| DeepSeek | 自动（默认开） | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| 智谱 / Kimi / 通义 / OpenAI | 自动（隐式，无法关） | `prompt_tokens_details.cached_tokens` |
| Anthropic | **必须打 `cache_control` 断点** | `cache_read_input_tokens` / `cache_creation_input_tokens` |

Anthropic 的断点由 `protocol/anthropic.ts::markCacheBreakpoint` 打在**最后一个
user 回合的最后一个可缓存块**上（每轮往后移；旧消息字节不变，所以旧缓存仍然命中）。

命中率由 `llm/usage.ts` 归一（各家分母口径不同，直接混读会算出 >100%），
按**一轮所有请求**求和后在 `turn-end` 事件里上报；面板只在有数据时显示 ——
「没上报」与「命中 0%」是两件事，不要合并。

## 插话（模型干活时用户说话）

- 面板不阻塞输入：`agentState.send` 在 `busy` 时**入队**（`queued`，卡片可编辑 /
  撤销），session 在每次模型调用之前用 `takeInterjections()` 取走。
- 注入时机只有两处，都在 `session.send` 的循环里：**工具批 + 截图注入之后**
  （OpenAI 要求 `tool` 消息紧跟 `assistant.tool_calls`，夹在中间 = 400）、
  以及**模型这一步说完但用户还插了话时**（那就再请求一次，不结束本轮）。
- 注入的是普通 `role:'user'` 消息（带一行 `interjection` 说明）。**不要**把它塞进
  系统提示或改写历史：那是缓存杀手，而且模型会以为这是上一轮的旧话。
- 轮末还没送出去的（模型已收尾 / 步数用尽）由面板当**下一条消息**自动发出；
  用户主动按停时不发 —— 那时他多半是想改这句话。

## 模型运行时（`llm/`）

分层：`transport`（fetch / SSE 取帧 / 直连降级）→ `protocol/*`（请求体 · 鉴权 ·
流式归约）→ `session`（工具循环）→ `executor`（控制平面）。

- **协议只有两种**：`openai`（Chat Completions）与 `anthropic`（Messages）。
  差异全部在 `providers/registry.ts` 的数据里，别在适配器里写
  `if (providerId === ...)` —— **`session.ts` 里一个 provider 分支都不许有**。
- **一家可以有多种路由**：`ModelRule.protocol / pathPrefix / endpointPath` 让网关
  （Cloudflare AI Gateway、自建 one-api / LiteLLM）按模型前缀切协议与子路径。
  问「这个模型走哪条路」只问 `providers/routing.ts::protocolFor`（连带
  `thinkingPolicyFor`）—— `transport.ts` 不许读 `def.protocol`。
- **新增一家 = 注册表一条 + 一张 logo + 一个 i18n 键**；资源级端点（Azure /
  网关 / 自定义）把 `baseUrl` 留空并标 `baseUrlRequired: true`，由用户填。
  端点 / 思考形态 / 回传策略 / 方言 / 代理白名单 / UI 下拉全部由这条数据派生。
  自检：`tests/unit/agent-providers.test.ts` 的注册表守卫。
- **`models` 是离线兜底，不是真源**：打开设置时会把 models.dev 的目录并到这些
  预设前面（`providers/models-dev.ts` 解析 + `ui/agent/model-catalog.svelte.ts`
  取一次缓存 24h）。新增一家必须在 `MODELS_DEV_SOURCE` 或 `MODELS_DEV_UNMAPPED`
  里登记，否则那一家永远只显示快照 —— 而快照一定会腐烂（单测会红）。
- **方言（`compat`）是数据，不是分支**：`maxTokensField` / `streamUsage` /
  `supportsReasoningEffort` / `requiresToolResultName` /
  `requiresAssistantAfterToolResult` / `temperature`。来源三层：默认 →
  **自填端点的** `detectCompat()` → `ProviderDef.compat` → `ModelRule.compat`
  （`providers/compat.ts`）。官方端点不做嗅探 —— 那里已经有实测结论。
  危害：多发一个端点不认的键（例如 `reasoning_effort`）= 400，而且只在
  「开了思考」的那一轮出现。
- **鉴权 / 端点 / 头部也是数据**：`AuthSpec`（`bearer` / `anthropic` /
  `{header, scheme}`）覆盖 Azure 的 `api-key` 与网关的 `cf-aig-authorization`；
  `endpointPath` 支持 `{model}` 占位符，`query` 拼固定查询串（Azure 的
  `api-version`）；头部叠加顺序是适配器默认 → provider → model，值为 `null`
  表示**删掉**同名头。三个解析点都在 `providers/endpoint.ts`。
- **厂商独有参数走 `body` / `extraBody`**，顺序 provider → model → 请求级；
  三者都空时**一个键都不加**（DeepSeek 的 golden 字节基线靠这个）。
  不要为了一个参数在适配器里开分支。
- **手写 SSE**（不引 SDK）：`delta.tool_calls[i].function.arguments` 是**分片**，
  按 `index` 累积再拼。Anthropic 的 `partial_json` / `signature` 同理，
  且 `signature` 是**追加到块上**而不是拼进正文。
- **思考参数有五形态**（`thinking` / `enable_thinking`+`thinking_budget` /
  `reasoning_effort` / `reasoning.effort` / `thinking.budget_tokens`），
  翻译**只在** `providers/reasoning.ts::thinkingParamsFor`。UI 档位固定四档，
  不要把档位写成提示词。
- **「关不掉思考」是模型级的**（GLM 5.3 / MiniMax M3）：传 `disabled` 直接 400。
  写在 `ModelRule.alwaysThinking` 上，UI 据此隐藏「关闭」档。
- **思维链回传策略是 per-provider 的** `thinking.echo`：
  `required`（DeepSeek 带 tools 漏传 = 400、Anthropic 的 signature 必须原样）、
  `optional`、`never`（智谱明确不回传）。判据在适配器的 `serializeMessages`，
  session 只管把 `reasoning_content` 与 `providerMeta` 写进历史。
- **`WireMessage` 是内部表示**，`providerMeta`（Anthropic 的 thinking 块、
  OpenRouter 的 `reasoning_details`）**绝不上线**，任何序列化器都要剥掉它。
- **图片只能出现在 user 消息**。不支持图片的模型（`ModelRule.noImages`）要
  **跳过注入**，否则模型会凭空描述画面。截图在工具轮结束后以一条 user 消息注入。
- `t` 是秒；工具表里帧号字段一律带 `Frame`。
- 传输：**先直连**，在收到第一个字节之前失败才切 `<proxyPath>/<providerId>/<端点>`。
  `preferProxy` 按 provider 记忆。已经吐过字之后**不重试**（会重放半截回答）。
  OpenAI 官方端点拒绝带 `Origin` 的请求，`transport.browserDirect: false` 只走代理。
  代理的转发目标取自注册表 —— 所以 `baseUrl` 由用户填的端点（Azure / 网关）
  `transport.proxy: false`，填多了只会打到默认 host 而静默串家。
- **响应必须是 `text/event-stream`**：静态站点会把 `/__llm/*` 回落成 200 + HTML，
  没有这条守卫时表现为「一条空回答且没有任何错误」。
- **重复调用先引导、别掐断**：同一个「工具 + 参数」**连续**第 3 / 6 次把引导
  **附加在那条 tool 结果末尾**，第 12 次才判死。⚠️ 不能插 system 消息（DeepSeek
  带 tools 会 400，且坏历史会让之后每条都 400）。
  判据只数**连续**（`advanceStreak`）：插进别的工具、`ask_user`、用户插话或新一轮
  任务都立刻清零 —— `plugin_try` 那种「试一版看一眼再试一版」的反复调用是正常
  工作方式，累计计次会把它误报成死循环。
  `render_frame` / `frame_signature` 的判据额外带 `sceneVersion()`（内容版本 +
  播放头）——工程变了就是新问题，不该被「你调用过三次了」拦住。
- **400 自愈**：`bad-response + 400` 之后清空模型历史并提示。**上下文超限例外**
  （归 `context`）：那是装不下，不是历史被污染 —— 压缩，不要清空。
- `ask_user` 是 **appOnly** 工具：由 session 直接拦截并向 UI 要答案（`onAskUser`）。
- **上下文窗口按 `(provider, model)` 取**（`contextLimitOf`，从 32k 到 1M）；
  75% 时用同一个模型（不带 tools）把前半段压成交接说明，保留最近 8 条。
  硬裁剪兜底，**绝不能切在 assistant/tool 之间**。
- `AbortController` 贯穿请求；单请求超时 300s。
- 步数默认 200、上限 2000（`MAX_STEPS` / `MAX_STEPS_LIMIT`）。
- **配置**：`agent-prefs.ts` 是纯函数层（迁移 / 解析），`agent-state.svelte.ts`
  只负责接到 `$state` 上。key / 模型 / 端点**按 provider 各存一份**，只覆盖与
  注册表不同的部分。Key 只存 `localStorage` 的 `artmatic.agent`，**不进
  `project.json`**；`sessionOnly` 在落盘时剥掉所有 key。

## 测试

- 纯逻辑（参数序列化 / 文档原语 / SSE / 裁剪 / 工具表）在 `tests/unit`。
- 需要真 GL 与页面状态的在 `tests/e2e/agent*.spec.ts`：用 `page.route` 伪造 SSE，
  不依赖真 Key；插件那条走真编译（坏着色器 → `compile-failed`）。
- 真 Key 冒烟脚本与日志放 `.codebuddy/tmp/<日期>/`，别提交。
