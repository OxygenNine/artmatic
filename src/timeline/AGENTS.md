# src/timeline/ —— 时间轴 UI

Canvas2D 绘制 + DOM 片段：轨道行、标尺、波形、选中框、拖拽 / 框选手势。

**何时读我**：改 `timeline/**`；动重绘策略 / 缩放 / 窗口位图；动拖拽与框选手势时。

相关：`src/core/AGENTS.md`（**重叠策略与 trim 的语义在那边**，这里是它在手势层的落点）、
`src/ui/AGENTS.md`（布局、抽屉、底栏提示）、`tests/e2e/AGENTS.md`（手势类断言只能走 `page.mouse`）。

---

- **片段内的迷你曲线只画一条**：`ClipView` 读 `lastCurveKeyOf(clip.id)`（曲线编辑器里
  最后显示的那个属性），用 `curve-geometry.ts::clipCurvePath` 生成路径、曲线下方整块
  加深。**一个片段只画一条**，因为片段高度只够一条；多条叠在一起读不出任何东西。
  `lastCurveKeyOf` 是会话级视图状态，退出编辑器后仍保留 —— 这是「右键重开时显示的
  就是片段上画的那条」的实现基础。x 轴映射片段范围而不是全部 key 的范围：被 trim
  过的片段关键帧常在片段外，按 key 范围映射会把片段内的形状压扁 / 错位。
- **`ClipView` 里的名字必须写在 `$derived` 里并 `void appState.version`**：`clip` 是原地改的
  对象，模板里直接读 `clip.label` 拿不到信号 —— 名字会一直显示旧值，直到
  `{#if renaming}` 那个分支翻一次面。这条由「换算法时自动改名」暴露：store 改对了、
  时间轴上还写着旧算法。同一处的另一半在改名输入框：**Chromium 卸载带焦点的元素时照样
  派发 `blur`**，于是 Esc 取消会被 `onblur` 的提交写回去（旧测试只是因名字不刷新才绿）。
  Escape 分支必须先 `value = 原值` 再退出 —— `renameClip` 遇到同名直接返回，不会多一笔撤销。
- **右键落在片段上时，菜单顶部先给片段级动作**（当前是「编辑关键帧曲线…」）。
  `ClipView` 不处理 `contextmenu`（右键统一归 Timeline），所以 `openCtx` 用
  `elementFromPoint(...).closest('[data-clip-id]')` 反查 —— 不要给片段再挂一套
  contextmenu（两条事件路径必然出现两种菜单行为）。空白行右键时 `clipId` 为 null，
  菜单与原来完全一致。
- **新建片段菜单的层级**：一级平铺（纯色 / 排版 / 特效 / 图片 / 视频 / 算法）；
  「特效片段」「算法片段」各展开一级，子菜单只放**最近用过的 5 个 + 「全部…」**。
  最近项在 `ui/recent-defs.ts`（localStorage），菜单构造在
  `Timeline.svelte::recentEffectMenuItems / recentAlgoMenuItems`。**不要在子菜单里
  重新平铺全部** —— 七十多个特效会撑爆菜单，而用户要的是「常用的那几个一悬停就点得到」。
  「全部…」打开的正是检查器那两个选择器（不要另造一份筛选 / 缩略图逻辑）。

- **形态只在两处分支**：标尺文案（`rulerLabelAt`）与吸附档位表（`view-model.ts` 的
  `SNAP_MODES_FOR`）。工具条上它是**两态按钮**（`activity` = 节奏 / `timer` = 标准），
  不是下拉：只有两个状态时下拉的两步操作纯属多余。
  ⚠️ **吸附档位按形态各记一份**（`app-state` 的 `snapByMode`）：半拍 / 拍 / 小节是拍单位，
  标准模式的标尺上没有拍，列出来只会让人选到一个「吸附到哪里都看不出来」的值；
  标准模式给「自由 / 帧」（帧吸附步长 `1/fps`，与时间码小数位同源）。
  不要退回「一个 snap + 一个 touched 布尔」——那样在两态间来回切一次就丢了用户在
  节奏模式下的选择。
- **竖直滚动合一的前提是「两侧量程相等」**，不是「内容等高」。轨道头列与画布是两个
  独立滚动容器、共享一个 `scrollTop`，所以 `scrollHeight - clientHeight` 必须一致：
  - 轨道头列底部有 28px 的固定页脚（添加轨道）→ 它占的是**视口**，画布内容末尾补一条
    等高的 `.footer-pad`（占**内容**）；
  - 画布的横向滚动条从它的视口里吃掉 s 像素（经典滚动条；Win11 的 overlay 为 0）→
    轨道头列用 `sidePad`（`offsetHeight - clientHeight`，在 `paint` 里测）补成底部内边距。
  量程不等时，滚到底低位那侧会把高位那侧**拽回来**，表现是「最后一条轨的名字被加轨
  按钮盖住」，而且只在高位那侧才看得出来。判据在 `tests/e2e/timeline-ui.spec.ts`
  （`sideMax === canvasMax` + 最后一行底边贴页脚顶边）。
- **段落带是标尺上方的一条 DOM，不是 canvas**（`SECTION_BAND_HEIGHT = 12`）。
  `drawRuler` 一行不改 —— 段落要做双击改名（要输入框）、右键菜单、悬停 title，
  12px 高的画布条带里三样都做不了。`side-head` 与 `.ruler-wrap` 的高度是
  `RULER_HEIGHT + SECTION_BAND_HEIGHT`（**两侧必须同一个表达式**），
  带子与标尺共享一个 sticky 外层（各自 sticky 会在纵向滚动时错开）。
- **段落拖动是独立手势**（`drag.ts::startSectionDrag`），与片段拖拽同一套
  两段式（move 直改 + touch，up 结算一笔撤销）。段落**没有重叠约束**，
  所以不经过 `settlePlacement`。`onClick`（没拖动）= 播放头跳到该段起点。
- **段落带还叠着一层手动节奏点刻度**（`.beat-mark`，`data-testid="tl-beat-mark"`）：
  1px 竖线、`pointer-events: none`（段落仍要能拖 / 双击改名）。主时间轴的整高虚线
  在 `grid-draw.ts` 的 `drawGrid` 里画（一条路径 + `setLineDash`）。两处的 x 都走
  `xOfTime`，不要各自换算。数据在 `Project.beatMarks`（见 `src/core/AGENTS.md`）。
- **打点计时入口在 `Transport` 工具条、只在节奏模式出现**（`beat-tap-open`）。
  Modal 在 `ui/beat-tap/`：录制时空格 / 左键只打点（不暂停播放），播放头走过的旧点
  被剔除，停止录制才结算成一笔撤销。**它不改 BPM / offset** —— 那是 `BeatGrid` 的事，
  节奏点只供吸附与显示。
- **Modal 的时间线是像素坐标（秒 × zoom），不是整首铺满**：几分钟的歌整首铺满会让
  点挤成一团。最小缩放 = 整首适配，播放 / 录制时自动跟随播放头；只渲染视口前后
  各一屏的刻度和点（`shownMarks`），别把几万个 DOM 节点一次性塞进去。
- **Modal 的编辑手势**：非录制模式下左键空白拖动 = 框选（Shift 加选）、左键单击空白
  = 清空选择、**右键菜单才是新增入口**（左键不再直接加点）、拖圆点整组移动、方向键
  按帧微调、Delete 删除选中。右键菜单必须渲染在 `<dialog>` / `.modal` **里面**：
  放在外面会被 `--z-modal` 的遮罩盖住（看得见、点不到）。
- **标段落的主路径是「在鼠标处切分」，不是逐个新建**：段落只存起点，所以先标
  第一个点等于把整首歌标成第一段。右键某段 → `splitSection` 只插一个新起点
  （右半继承颜色，原名留给左半），左半的终点自动变成它。菜单按
  `store.canSplitSection(id, t)` 置灰，判据与写入同一份（`splitPoint`）。
- **音频淡变手柄不吸附**（`'fade-in' | 'fade-out'`）：拖的是连续秒数，与拍网格无关。
  ⚠️ **起点值必须在 pointerdown 快照**（`origFadeIn` / `origFadeOut`）：`clip` 是原地改的
  对象，在 `onMove` 里读 `clip.fadeIn + dt` 会把每帧增量叠到上一帧写进去的值上
  （实测拖 56px 得到 4.5s，且松手前看不出规律）。
- **标尺文案来自 `drawRuler` 的 `mode` 参数**，格式在 `grid-draw.ts::rulerLabelAt`
  （纯函数 + 单测）。双形态只改三处：标尺文案、工具条显示哪组参数、吸附默认值
  （`UiPrefs.snapTouched` 保证手动调过之后不再被覆盖）。
- **框选出来的多个片段一起走**（`drag.ts` 的 `peers`，单片段是它长度为 0 的特例）。
  三条不变量：位移 `dt` 由**指针**算、与成员无关（相对位置天然保持）；换轨是
  **整组平移 d 格**（`legalDelta`），不是逐成员各找各的轨道；兼容判据仍然只有
  `canHost`。于是「组里含音频就不许上下跨轨」是这条判据的**推论**（音频片段平移
  后会落到视觉轨），**不要**再写一条「组里有没有音频」的独立规则。
  缩放**不做组版本**（`peers` 传进去也被忽略）：一组片段的「那条边」没有唯一定义。
  按下已选中的片段时**先保持整个选中集**，松手若没移动过（<4px）再收敛成单选 ——
  否则整组拖动无从谈起。这条判断只能放在拖拽层（`DragOptions.onClick`）。
- **轨道头右端现在是三个开关，各有各的语义**（v15）：
  - `track-enabled`（眼睛 / 喇叭）：视觉轨 = 整层不进画面，音频轨 = 整条不出声；
  - `track-muted`（`volume-2` / `volume-x`，仅视觉轨且轨上有视频片段时显示）：
    只关内嵌音轨，画面照常。**不要**做成「有视频片段才可用」的常驻按钮：
    纯色 / 算法轨上它永远不生效，占位只会让人以为坏了；
  - `track-menu`（⋯）：行菜单。它必须是这一行的**最后一个**控件 —— 菜单锚点按
    `data-testid=track-menu` 现查，其它按钮插到它右边会让浮层对齐到错的元素。

---

## 时间轴重绘：两条不变式

> **① 单次绘制的工作量只与可见区宽有关，与工程时长无关。**
> 每条绘制都被 `clip` 到 `view`；拍线只从可见区间左端起头；波形只算可见列，
> 并且同轨所有片段合成**一条**闭合包络路径后 `fill()` 一次。

> **② 位图面积只与视口和轨道数有关，与工程时长和缩放都无关。**
> 画布只覆盖 `[winFrom, winFrom + winW)`（`winW = min(内容宽, 3 × 视口宽)`），
> 跟着视口挪位置，**不是整幅工程宽**。

② 必须存在的原因：整幅宽时内存 = 时长 × 缩放 × 轨道数 × dpr²，**无上界**。

改 `grid-draw.ts` / `Timeline.svelte` 的 `paint` 前必读：

1. **一条跨整幅画布的超长多子路径是 Skia 最坏的输入形态**（N 个**小**路径反而快一个
   数量级）。不要在 `paint` 之外直接 `ctx.stroke()`。波形是主犯：同轨合成一条闭合包络再
   `fill()` 一次。
2. **`canvas.width !== w * dpr` 的比较必须 `Math.round`**：`canvas.width` 是整数，
   dpr=1.5 遇到奇数 `w` 是 `.5` 结尾，直接比会**永远不等**，于是每次重绘都重建位图。
3. **`painted` 的失效条件要跟着「画了什么」走**，包含 `activeProjectId` —— 切工程时
   `subscribeActive` 只是把 `version` 换成新工程的计数，**两份工程 version 撞号时赋值不
   产生变化**，effect 不跑，画布就停在上一份工程的内容上。
4. **窗口挪位置必须在绘制之前落定**（`style.left` / `style.margin-left`），否则绘制原点与
   元素位置对不上。
5. **坐标系有两套，别混**：`content`（x=0 是工程起点）与 `canvas`（x=0 是位图左缘），
   差一个 `origin = winFrom`。`view` 一律用 content 坐标传，`grid-draw.ts` 内部减掉 origin。
   **探针 / 测试读像素时也必须减** —— 直接拿 `scrollLeft * dpr` 当画布 x 会在窗口外读到
   全透明，得出「波形丢了」的假结论。
6. **超限时 `canvas.width = …` 是静默失败的**（留下「位图宽 ≠ style.width」的错位、画面被
   压扁，控制台一句话都没有）。所以内存必须**由构造保证**，而不是靠「设个阈值再降级」。
   Chrome 对细长画布**单边不设 65535 上限**，真正卡的是**面积**。
7. **标尺不随 BPM 变**：拍线画在 `xOfBeat(b) = offset 的 x + b * pxPerBeat` 处，BPM 决定的是
   「一拍几秒」，只影响波形 / 片段的像素位置。要动标尺看 `beatsPerBar`。
   ⚠️ **offset 必须计入**（`view-model.ts::xOfBeat` 是唯一换算处）：拍从 `offset` 之后才开始数，
   吸附走的是 `beatAtTime`。两处各写一份 `b * pxPerBeat` 的形态是「播放头永远压不上刻度」，
   看起来像渲染错位，其实是标尺少加了一个常量。
8. **E2E 别断言耗时，也别断言跨操作序列的逐位像素相同**：Skia 在抗锯齿边缘会给出
   ±3/255 的舍入差（同一序列重复则逐位相同）。断言用「最大通道差 ≤4 + 墨迹量 ±0.1%」。
   `tests/e2e/timeline-ui.spec.ts` 跑在 `deviceScaleFactor: 1.5`（本机真实 dpr），dpr=1 会把噪声放大十倍。
