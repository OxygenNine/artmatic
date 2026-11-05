# src/ui/typography/ —— 排版编辑器的 UI 约定

编辑器形态 · Ribbon 布局 · 取色入口 · 元素手势。
**文档模型、光栅化与配色方案的语义在 `src/typography/AGENTS.md`**（本文件只管 UI 侧）。

**何时读我**：改 `ui/typography/**` 或 `ui/ribbon/**`；动 Ribbon 的宽度预算；
动**任何取色入口**；动舞台上的元素手势（拖 / 缩 / 旋转）时。

相关：`src/typography/AGENTS.md`、`src/ui/AGENTS.md`（抽屉 / modal / 浮层的通用约定）。

---

## 旋转几何

- **选中框必须带 `rot`**：单个元素绕自身中心旋转时 `x/y/w/h` **一点没变**（只有 `rot` 变），
  用未旋转 AABB 画框会纹丝不动。单选 → 元素自己的框（含 rot）；多选 → 整个选区的 AABB。
- **旋转后的缩放走 `resizeFramesRotated`**，不能直接用轴对齐的 `scaleFrames`
  （否则「拖右边却往斜上方长」）。`rot === 0` 时两者逐位等价（有单测钉着）。
- 测这类手势的 E2E 时注意：细长元素转 90° 后把手会跑到视口外，用正方形元素测。
  旋转本身断言 `getComputedStyle(el).transform` 矩阵的非对角项，别用「外接矩形变大」。

---

## 命中与把手尺寸（`hit-area.ts` · `SelectionLayer.svelte`）

- **命中先看外接框，图形再过一道像素闸**：`hitTestFirst(rects, x, y, { accept, slop })`
  里的 `accept` 是 `hit-area.ts::isOpaqueAt` —— 图形按 `<path>` 的 `isPointInFill` 判断
  （`docToLocal` 换算到元素自身、`path.getCTM()` 换算到路径用户坐标，自定义路径的
  `scale(w/100,h/100)` 因此自动被吃掉）。**面积大的中空图形（圆环 / 方框 / 星形）
  中间那片透的地方会落到下层元素上**，否则下层根本点不到。
  - **但它是「模糊」的**：中心没命中时在周围撒两圈探针（3px / 6px，八个方向），
    附近有墨迹就算命中 —— 否则一条 2px 的细线、一个旋转过的细长条要求用户把指针
    精确压在墨迹上，鼠标做不到。容差只影响**边缘附近**：洞的直径远大于 6px，
    中心那一片照旧穿透。
  - 外加 `hitAt` 传的 `slop`（3 屏幕 px）放宽**外接框**判定：细线的框只有一两像素，
    压在边缘外侧一点点也该算。两处都按**屏幕 px ÷ zoom**换算，缩放时手感不变。
  - 文本 / 图片不过闸；`fill: none` 的纯描边图形（直线、空心框）退化为整框可点 ——
    否则「点得准不准」变成几像素的考验。有可见填充的中空图形才是要穿透的那一类。
  - ⚠️ **别拿 `isPointInStroke` 补描边容差**：Chrome 那里走 nonzero 缠绕，而环形的
    内外圈同向 ⇒ 圆环正中心 `isPointInFill=false` 却 `isPointInStroke=true`（实测），
    恰好在最需要判对的那类图形上给出反的答案。容差只能由探针实现。
  - **按在选择框上时不走穿透**（`hitTopAt`）：框属于已选元素，Shift 减选 / 单击进组
    必须落在它自己身上，不能因为指针在它的洞上就作用到下层。
- **框小到抓不住时把手缩成四角 + 一个移动握柄**（Office 的做法）：框在屏幕上的宽/高
  小于 30px 时收起那一轴的两个中点把手（15px 的命中区会互相吃光），两轴都小就只剩
  四角；`min(w,h) < 40px` 时框下方多一个圆形握柄（`typo-handle-move`，四向箭头）。
  - **按轴判定，不是「小就全去掉」**：200×6 的分隔线仍需要左右中点调长度。
  - 握柄是**移动**入口（`onMove`），不是缩放入口；`editing` 态下它也要
    `pointer-events: auto`（框内部让给 contenteditable，握柄不能跟着失效）。

---

## 格式刷 / 动画刷（`format-painter.ts` · `actions.ts` · `editor-state.painter`）

- **入口**：「开始」页与「动画」页**最左侧各一个单按钮组**（`typo-format-painter` /
  `typo-anim-painter`）。不与其它组混：刷的是填充/描边/圆角/图片处理与动画，
  不是字，塞进「字体」组等于给它挂错组名。
- **三种手势，语义必须一致**：单击 = 刷一次就收起；**双击 = 连续刷**（按钮第 1 下开、
  第 2 下关、`dblclick` 再把它落成 `sticky`，最终状态恒定）；取消方式三条 ——
  再点一下按钮、点画布空白（`clearSelection()` 顺手清 `painter`）、`Esc`（`keys.ts`
  最外层分支，**不动选择集**）。
- **刷子开着时不渲染选择层**（`TypographyEditor` 的 `{#if !nodeEditEl && !editorState.painter}`）：
  选择框（含 8 个把手）会吞掉整片 pointerdown —— 源元素完全盖住目标时，刷子就
  永远刷不到它，表现是「点了没反应」。
- **应用路径只有一条**：`actions.applyPainterTo(targetId)`。先拿 `structuredClone`
  试跑，**没变化就不开撤销**（刷成一样 / 目标接不住任何字段时不该留一条空记录）；
  刷完 `selectOnly(target)`（看得见结果），单击模式再收起刷子。
- **纯逻辑在 `typography/format-painter.ts`**（agent 走同一条）：
  - `format` 只搬**外观**：填充、描边、圆角、文本样式、图片的各项处理、阴影与虚化。
    **不搬内容**（`runs` / `assetId`）、**几何**（`frame` / `transform3d`）、
    `opacity` / `blend`（那是图层属性，搬过去会让「只想刷个填充」变成整块半透明）；
  - **跨种类有映射**：图形的 `fill` / `stroke` ↔ 文本框的 `boxFill` / `boxStroke`；
    圆角在图形与图片之间照搬；目标没有的字段**静默跳过**；
  - `animation` 是**整份替换**并**重新发号**（`data-anim-id` 是 CSS 规则的命名空间，
    共用 id 会把两个元素的动画绑成一份）。深拷贝手写，`structuredClone` 之外的任何
    JSON 路径都会把 `iterations: Infinity` 变成 `null`（= 只播一次）。
- **刷子是持续状态，提示走 `statusHint.setGesture`** 而不是一次性 toast：用户可能
  过几秒才点目标。清扫放在 `$effect` 的清理函数里，于是所有取消路径都不必各自记得清。

---

## 编辑器形态 · 快捷键分流 · 图片置入

- 编辑器形态：**工程内部的一个视图**，UI 是数据驱动的 Ribbon（Tab / 分组 / 按钮，
  含 Contextual Tab 与横向滚动 —— 窄窗口横向滚动是设计如此，Office 也是这么做的）。
- **双击片段 = 打开它自己的编辑器，一律不切分**（切分保留 `S` 键与检查器的按钮）。
  双击是最高误触的手势，把破坏性操作绑在上面迟早出事。
- **图片置入画布只有一条实现**（`ui/typography/actions.ts`）：`placeImageBytes`（新字节，
  三层登记 —— engine 的 `registerImageBytes` / typography 的 `putImageBytes` /
  `assets.put` + `p.assets[]`；缺一层的表现是「排版页里好好的，把这条素材拖到时间轴上
  是一片空白」）与 `placeImageAsset`（已在册的素材，**不许再登记一遍** —— 那会造出第二条
  一模一样的池子素材；只在 objectURL 缺席时补一条）。Ribbon 的「插入图片」、剪贴板粘贴、
  媒体池拖放三条路都走它。多张同时进来按**阶梯错开**摆，全叠在中心的话只看得到最后一张。
- 快捷键按**分流**处理：`App.svelte` 的 `onKey` 在编辑器打开时整段交给
  `ui/typography/keys.ts`。于是 `S`（切分）与 `Alt+↑↓`（移轨）在排版页**自然失效**，
  不需要在时间轴的每条分支上加 `if (!editorOpen)`。
- **编辑器内不做脏标记** —— 排版编辑全程直写工程（可撤销），不存在「切走就丢」的东西。
  需要脏标记的是「工程 vs 磁盘」（`savedVersion`）。
- **画幅与上屏大小的入口在「设计」Ribbon**（`ribbon-canvas-size` → 浮层
  `typo-canvas-pop`，组件 `CanvasSizePopover.svelte`）。按钮由 `ribbon-defs`
  描述生成、只能发无参意图（`onOpenCanvasSize`），**拿不到事件目标**，所以浮层的
  锚点由编辑器用 `CANVAS_SIZE_TESTID` 现查 —— 那个常量同时是 E2E 的稳定契约。
  浮层是受控的（`anchor` / `onclose` 由编辑器给），定位与关闭复用
  `controls/popover.ts`（`position: fixed`，与 Ribbon 里其它弹层同一套）。
  写 `doc.size` 走 `editorState.commit`（可撤销），写上屏大小走 `store.updateClip`
  的 `transform.sx / sy`。**缩放条上不再有尺寸读数** —— 别在 `.zoombar` 里加回去。
- **它读的每一样都是「原地改的对象」，派生必须 `$derived.by` + 返回新对象**：
  ```ts
  const docSize = $derived.by(() => { void appState.version; return { w: doc.size.w, h: doc.size.h }; });
  ```
  `$derived(doc.size)` 拿到的是**同一个引用**，`===` 不变 ⇒ 不重算 ⇒ 浮层读数停在
  旧值，而画面本身是对的（所以看起来像「只有数字不更新」）。`svelte-check` 不报这个。
- **镜头浮层在「设计 → 镜头」**（`CAMERA_TESTID` → `CameraPopover`），景深在
  **元素属性面板**（`prop-depth` / `prop-depth-num`）。两者分开：镜头是文档级的
  取景（平移 / 缩放 / 旋转），景深是「这个元素在哪一层」。浮层与画布浮层同一套
  受控写法（锚点按 testid 现查、`attachDismiss`、`computePopoverPosition`），
  **没有确定按钮**；复位是浮层右上角一个图标按钮（四个参数逐个调回去不算复位）。
- **关键帧面板常驻「镜头」行**（元素列第一行，`data-el="camera"`）：镜头不是元素，
  但复用元素列的选中 / 加帧 / 拖帧全套交互。四条通道**常驻显示**，没打过关键帧
  的是一个**空轨道桩**（`cam:<通道>` 的 id，不落库）—— 双击轨道空白时 `addKey`
  按同一个 id 物化成真轨道，所以第一次加帧时选中态不会跳。作用层开关、加属性、
  循环开关对镜头行隐藏（它们不适用于 JS 采样）。
- **镜头浮层对有关键帧的通道写「播放头那一帧」**（`actions.setCamera(patch, localSec)`
  的自动关键帧）。只写基准值的话，那条通道被动画接管之后浮层就变成「改了没反应」，
  而用户看不出是被接管了。
- **`viewDoc`（播放头时刻的文档视图）必须显式 `void appState.version`**：
  文档是**原地改**的普通对象，`$derived` 靠 `===` 传播，上游 `doc` 重算后返回的
  还是同一个引用 —— 不直接订阅 version 就永远不重算。表现是「加了镜头关键帧、
  拖播放头，舞台纹丝不动，但文档里确实变了」。同一份陷阱见 `docSize` 的注释。
- **命中 / 框选 / 选择框一律走「屏幕框」**（`editorState.screenRects` /
  `screenFrame(doc, el)`），只有手势内部用 `selectableRects`（吸附加持在文档坐标
  系里算）。漏一处的表现是「镜头放大后点不中自己看得见的东西」。
  手势的指针换算走 `makeEnv(focusId)`：它把屏幕点映射进**那一层自己的坐标空间**
  （除以视差缩放、反转视差旋转）。不做这一步，depth=1 + zoom 2× 时元素跑得比
  指针快一倍；多选且 depth 不同时按指针下那一层换算（元素之间保持刚性）。
- **「文字转路径」按钮住在「开始」的「路径」组**（`typo-text-to-path`），与
  「文字填充」同一条出现规则：只在选中文本时占位置。它**异步**（等 wasm +
  字体字节），期间不改文档；失败只 flash 一条可照做的提示（缺字 / 字体读不到 /
  拒绝授权 / 合成字面 / 竖排），**不做半成品转换**。所以按钮没有「进行中」态也
  安全 —— 连点两次不会叠出两批图形（第二次落到「内容已变 / 已不是文本」的分支）。
  **系统字体不需要导入**：字体在注册表里找不到时会去读本机字体（第一次可能
  等 3 秒，会先 flash 一句提示）；只有「本机也没有 / 没授权 / 没有这个字重」
  才让用户导入文件。实现与取舍见 `src/typography/AGENTS.md` 的「文字转路径」。
- **Ribbon 只放「稳定控件集」，参数编辑住右侧「元素属性」面板**（`PropertiesPanel`，
  与图层 / 动画共用右侧位置）。原先填充组按 `fillKind` 条件展开（角度 / 第二色 / 图案 /
  周期 / 线宽），每切一次填充方式组宽就变一次、后面的组整体位移 —— 用户瞄准的按钮在
  点下去之前跑掉（用户反馈的「改填充方式影响 Ribbon 排版」）。现在 Ribbon 的图形填充组
  与文本填充组都只有「方式 + 主色」两个恒定控件（不适用时置灰但**保留占位**），其余
  参数在三处填充共用的 `PaintEditor` 里。**加新的填充参数时往面板加，不要再往 Ribbon
  的填充组加条件展开。**

---

## 动画预设（「动画」页的常驻条 + 弹层，2026-10-25）

预设不再是一个 `<select>`，而是**两个并存的入口**（用户要求「两个东西并行存在」）：

| 入口 | 组件 | 形态 | 什么时候用 |
|---|---|---|---|
| 「动画」组的**常驻条** | `ui/ribbon/RibbonAnimStrip.svelte` | 640px 宽的凹槽，一排卡片，两端翻页键 + 滚轮翻页 | 切到这一页就想挑一个（主入口） |
| 「高级动画」组的**添加动画** | `ui/ribbon/RibbonAnimGallery.svelte` | 弹层，按「进入 / 强调 / 退出」分组 | 预设变多之后它是目录 |

- 两者的卡片是**同一份图标 + 同一份名字**，图标都由 `ui/ribbon/AnimPresetIcon.svelte`
  渲染 —— 两处各写一遍图元循环的话，改一次描边宽度就要改两处，而用户会并列看到它们。
- **动画名字挑不出来**（「弹一下」得先在脑子里翻成一段动效），所以卡片 =
  **示意图形 + 名字**。五十多条预设分三组，图标住在 `ui/typography/anim-icons/`
  （`prims.ts` 是唯一的图元工具箱，`enter/emphasis/exit` 各一份），
  归组表与 `animIconOf` 在 `ui/typography/anim-catalog.ts`。**都不在**
  `typography/animation.ts` 的模型表里：那张表被渲染层、schema 迁移、agent 一起读，
  改一个图标不该动模型。
- **示意图形是圆角方形**（用户定的，不是五角星）：`sq` 实心 = 终态、低透明度 =
  起始态、虚线 = 「将要变化」的框；`path` 画运动提示（箭头 / 圆弧 / 抖动线）。
  坐标在 `0 0 32 32`，颜色只来 `currentColor`（不另建一套图标配色）。
  三组的语法分别是**进入 = 虚线在来处**、**退出 = 虚线在去处**、**强调 = 提示在四周**
  （中心就是终态）。两条硬经验：① 箭头**不能画进实心区域**（填色会把它吃掉，
  30px 卡上等于没画）；② 卡片只有 58px 宽，预设名一律 ≤4 个汉字。
- **弹层必须自带 `max-height` + 滚动**：五十多条 + 三个分组标题超过一屏，
  而它是 `position: fixed`（面板裁不到它），没有上限时最后两排永远点不到。
- **常驻条的滚轮必须自己接管**：`Ribbon.svelte` 把纵向滚轮换成了面板级横向滚动，
  不 `stopPropagation` 的话「在这条上滚一下，整排按钮跑到左边去了」。一次滚轮 =
  翻一页（160ms 内只认第一次，滚轮与触控板都会连发事件）。
- **点一下 = 在播放头插一段**（`actions.applyPreset` → 增量插入），所以卡片是
  **一次性动作**、不是「当前值」：卡片上高亮的只是「刚插进去的那一个」（本地状态），
  真相在预览下方的关键帧面板里。**别再给它加 `value` / 选中态** —— 那会误导成
  「这个元素只有这一条动画」。
- testid：条是 `typo-anim-strip` / `-card-<id>` / `-prev` / `-next` / `-track`，
  弹层沿用旧下拉的入口名（`typo-anim-preset` / `typo-anim-preset-pop` /
  `typo-anim-preset-card-<id>`），改名会让所有涉及动画的 E2E 一起碎。

---

## 关键帧面板（`KeyframePanel.svelte` / `KeyframePopover.svelte`，2026-10-24）

- **位置在预览下方、与预览同宽**：`.main` 的中间列包一层 `.center`（viewport + 4px 横向
  把手 + 面板）。**不要塞回右侧栏** —— 那里两百多像素宽，只能退回「一根 0.6 秒的条」；
  右侧现在只剩图层 / 元素属性 / 脚本三栏（只读的「动画窗格」已整体删除）。
- **三列：元素列 | 属性列 | 时间轴**。属性行与右侧轨道**同排**（同一 `ROW_H`）——
  早期版本把属性行嵌在元素列表里，元素一多就空出成片行、轨道与行头错位。
  **属性列是独立一格**（不在横向滚动容器里），只同步 `scrollTop`。别退回
  `position: sticky` 冻结：sticky 的单元格只有「行」那么高，横向滚到中段时播放头
  会从属性列下面露出来（背景也不连续）。
- **元素列列「有动画的 + 舞台上选中的」**。只列前者的话，一个还没动画的元素永远进不了
  列表，也就永远加不了第一条轨道。元素列可整列折叠（`typo-kf-aside-toggle`）。
- **所有操作都在顶栏**（添加属性 / 时刻 / 删帧 / 删轨道 / 吸附单位 / 播放 / 重播 / 时钟），
  宽度不够时横向滚动 + 两端渐变（`updateFades`，与 Transport 同款）。**不要在面板底部
  再放一条底栏** —— 它紧挨着 zoombar，两条横条会读成同一个功能的不同部分。
  唯一的例外是**循环开关**：它是「这条轨道」的属性，所以落在属性行末尾。
- **值 + 曲线在关键帧浮层**（`KeyframePopover.svelte`）：点关键帧弹出，锚在菱形上，
  下方放不下就翻到上方并夹在视口内。双击空白补帧**只选中、不弹浮层**（连续补帧时它
  会挡住刚加的点）。
- 关键帧形状 = 缓动种类：缺省菱形、`cubic-bezier`/关键字圆形、`steps()` 方形
  （`easeKindOf`）。描边 `--text-secondary`，选中换 `--accent`。
- **关键帧可以标色**（`TrackKey.color`）：填充走 `--key-c`（没有标记时退回
  `--surface-0`），入口是顶栏的 `typo-kf-key-color`（`ColorField`，选中帧时才出现，
  框选的一批刷同一个颜色 = 一笔撤销）。它**只做记号**：不进 `@keyframes`、
  不改求值、不影响导出（守卫 `tests/e2e/typography-keyframes.spec.ts` 断「样式表逐字没变」）。
  不要把它做成「按颜色分组 / 按颜色筛选」—— 那会让一个纯展示字段变成第二个真源。
- **一条动画 = 一个属性**（见 `src/typography/AGENTS.md` 的 tracks 一节）。不同属性要
  异步就分别占一条轨道，各自的首帧决定 `delay`；断言要读计算样式 `animationDelay`，
  文档字段只是意图。
- **作用层是顶栏的两态按钮**（`typo-kf-target-toggle`：`type` = 内容 / `square` =
  元素框）。缺省「元素框」= 文本框底板与边框一起动（用户说「设个旋转」时想的就是
  整块）；「内容」= 只动文字 / 图形本身。**有轨道时按钮改这条轨道**
  （`actions.setTrackTarget`，`target` 进 `docSignature` ⇒ 下一帧重建动画层，不用
  删了重建；同层同属性按替换处理），没有轨道时改新建缺省。属性行上带方块图标的
  那条就是 box 层。
- 时间轴：横轴是绝对秒，`zoom` 只改像素密度（`⌘/Ctrl + 滚轮`，以指针处时间为锚），
  普通滚轮 = 横向滚动（内容超出时），`scrollLeft` 驱动标尺平移；**播放头夹进
  `[0, clipDur]`**（打开编辑器时播放头可能停在片段外，原样显示会出现 `-24.00s`）。
- **播放头只有一份：`appState.playT`**。底栏那个「排版预览进度」、本面板的播放头、
  时间轴播放头、舞台动画与底图取帧读的都是它（`bgPreview` 只负责开关 / 不透明度 /
  底图 URL / 播放循环，**不许再存一份「局部预览时间」**）。
  那个 `at` 曾经存在过，代价是「拖底栏滑块 → 关键帧播放头一动不动」：两个控件看着
  是同一个播放头，实际是两份状态，反向操作一下绑定就断了（用户报的 bug）。
  `bgPreview.play()` 每帧写 `playT`，并在发现 **别人挪了播放头**时立刻停手
  （`written` 对不上就 `pause()`），不跟用户抢时钟。
- **手势与片段编辑器对齐**：标尺拖动 = 播放头，轨道上拖动 = 框选（框内关键帧多选，
  Delete 一起删，点空白清空）。关键帧**默认自由拖曳**，`Shift` 才吸附 ——
  无条件吸附时 0.5s 一跳，用户会以为「拖不动」。
- **吸附单位是可选项**（顶栏下拉，`core/time.ts::KEY_SNAP_UNITS`：拍 / 秒 / 0.1 秒 / 帧）。
  它与 `SNAP_MODES`（时间轴网格）**分表**：那张表的口径是小节 / 拍 / 半拍，硬塞进
  「秒」会让时间轴的下拉多出两档而网格不动。换算一律在**绝对秒**上做再折回相对秒
  （拍带 offset、帧号是 `t = frame/fps`）。缺省仍是「拍」。
- **框选之后拖任意一帧 = 整组平移**：按下的帧已在选择集里就不重置选择（否则框选
  完只能一帧一帧挪）。三个不许省的细节：位移由**按下点的原始时刻**重算（逐帧累加会
  漂）；夹的是**整组**的位移区间（各自夹会把相对间距挤变形）；同轨往右拖时**从右往左**
  写（先挪走右边那帧，左边那帧才不会临时落在它的位置上被 `normalizeKeys` 去重吃掉）。
- **循环开关在属性行上**（`typo-kf-loop`，写 `iterations = Infinity | 1`）。一条轨道
  = 一个属性，循环是**这条轨道**的属性；顶栏那种「作用于哪条轨道」的歧义正是被删掉的
  Ribbon「时序」组的病根（显示值取选区里第一个动画、写入按 `kfPanel.animId` 扫全文档，
  两者可以不一致）。时序现在只由关键帧本身表达，**不要再往 Ribbon 加回时长 / 次数 /
  方向 / 填充那一组**。
- ⚠️ **修饰符类名不能与同组件的块类名重名**：`.beat` 上加过 `class:bar`，而顶栏也叫
  `.bar`（Svelte 的 scoped class 会一起命中），于是每条小节线上长出一个 12×27 的方块
  （用户报的「标尺上的小方块」）。现在叫 `is-bar`。这条同样适用于 `on` / `sel` 这类
  一个词的修饰符。
- 关键帧用**时刻**标识而不是下标：`applyTrackTiming()` 每次写入都会重排关键帧。
- 手势：拖动关键帧 = `beginGesture → live(moveKey) → endGesture`，没位移就
  `cancelGesture`；擦洗挂在滚动容器上（轨道少时下方空白也能拖）；Delete 删选中帧
  （事件里挡掉 input / textarea）；拖动吸附到拍，按住 Alt 关闭。
- **列表派生必须逐层浅拷贝**（`{ ...a, keys: a.keys.map(k => ({ ...k })) }`）：
  文档对象是原地改的，直接交给 `{#each}` 会在拖动后按 `===` 认为没变而静默断更。
- 缓动是**出向**语义（本帧 → 下一帧），所以入口长在关键帧上；末帧没有下一段，
  控件呈禁用态并给一行说明。
- 「双击轨道加点」这条提示**只在底栏**（`hints.ts::KF_HINT`，指针落到轨道区时出现），
  面板里不再写说明文字。

## 脚本页签（`ScriptPanel.svelte`）

- 入口是右侧第 4 个页签「脚本」，**不要再往 Ribbon 加按钮**（Ribbon 只放稳定
  控件集，见本文件开头）。脚本是**文档级**的，属性面板只放一行只读提示
  「受 N 条脚本控制」，那一条是就地同步的状态，不是操作入口。
- 代码编辑走**草稿 + 失焦提交**（`onblur` → `editorState.commit`）：每个字符一次
  commit 会把撤销栈灌满（一次 Ctrl+Z 只退一个字母）。同时保留「检查语法」按钮
  （只编译不执行），错误消息显示在按钮旁。
- 总开关直接写 `appState.setRunTypoScripts()`（UI 偏好）；`ScriptPanel` 自己不存
  第二份。关闭时面板顶部有说明、图层行有 `code` 标记、元素属性底部显示
  「脚本未运行」——三处都要在，少一处就会出现「脚本写了但没人知道它没跑」。
- **列表派生必须返回浅拷贝**（`scripts` 里对每条脚本 `{...s}` + 拷贝数组字段）。
  `doc.scripts[i]` 是原地改的普通对象：直接把它交给 `$derived` / `{#each}`，
  版本号变了、派生重跑了，但引用没变 ⇒ Svelte 按 `===` 认为「不用更新」，
  新增/删除脚本要等下一次交互才刷新。同样的坑在 `LayersPanel` 文件头写着。
  依赖要显式读 `appState.version`，不要只依赖 `doc`（它每次重算还是同一对象）。
- 代码框的草稿同步**看焦点**（`codeFocused`）：同步 effect 在每次版本变化时都会
  重跑，不挡住会在打字途中被库里的旧代码覆盖。同一条脚本的其它字段（启停 /
  needs / 目标）变化时不要碰草稿，只在「选中换了 / 代码被外部改了」时替换。
- 运行诊断从 `script/diagnostics.ts` 订阅（模块级表，不进文档）；`$effect` 里
  `subscribeScriptDiagnostics` 的清理必须返回，否则切页签后还在累加计数。
- 脚本写入会改变**结构**（`needs` / `targets` / 逐字 span），所以
  `TypographyEditor` 的 `signature` 必须带 `scriptsActive` 与 `editingId`；
  改 `docSignature` 的入参时两处（build / sync）一起改。

## Ribbon 布局与取色入口

- **Ribbon 的弹层必须是 `position: fixed`**（`controls/popover.ts` 的纯函数定位）。
  面板是 `overflow: auto/hidden`（横向滚动 + 固定高度），absolute 弹层会被整个裁掉。
  取色卡、菜单、下拉、图库全部走这一套。
- **字体下拉的每个选项用它自己的字体画名字**（`SelectOption.fontFamily`，值由
  `typography/font/css-family.ts::cssFamily` 生成），触发区（`.sel-label`）跟随当前值 ——
  挑字体时看的是「长什么样」，配一行小字说明是噪声。族名**必须加引号转义**：本机族名里
  有空格 / 数字 / 逗号，裸拼会让整条 `font-family` 声明失效，而失效是**静默**的
  （退回界面字体，不报错）。E2E 因此不只断言 computed 字体名，还量同一串字在四族里的
  宽度必须互不相同（`typography-ribbon.spec.ts` 的「字体下拉」用例）。
- **「开始」的字体区是 PPT 式两排**（`layout: 'rows'` + `size: 'icon'` 的纯图标按钮）：
  第一排是宽下拉（字体 / 字号 / 字号 ∓ / 清除格式），第二排是字形格式，**行尾**是
  字体资源（本机字体 / 导入字体）—— 两者之间靠 `{ kind: 'spacer' }` 撑开，两排的
  右边缘因此天然对齐（间距不定死，改了字号/字体名也不会破坏对齐）。
  这是 `align-items: stretch` 的直接推论：每行必须撑满组宽，行内的弹性间隔才有
  空间可吃。宽度口径有**两处必须同源**——
  `ribbon-model.ts::itemWidth()`（组宽预算）与 `Ribbon.svelte` 在根元素下发的 CSS 变量
  （`--ribbon-icon-w` 等，值来自 `DENSITY`）。各写一遍的表现是「预算说 26px、按钮实际
  30px」，整条 Ribbon 的横向排布会慢慢错位。
- **大按钮的宽度跟着标签走**（`labelWidthPx()`，`itemWidth()` 与 `RibbonButton` 用
  同一个数）。写死 50px 的话「插入生成器」会被截成「插入生…」—— 而 Ribbon 的设计
  前提是「文字直接写在按钮上」，截断等于把功能藏起来。估算按 `--fs-xs`（10px）：
  全角 10.2、其余 5.8，另留 10px 内边距；显式 `width` 仍然优先（如「应用到整个项目」）。
- **取色卡的「最近使用的颜色」只记裸色**（`ui/typography/recent-colors.ts`，localStorage、
  可丢）：把 `@accent1` 混进最近色会让那一行在换方案后显示一堆与主题网格重复、
  但语义不同的格子。
- **颜色控件的 `themeId` 由 `ribbon-defs.ts::injectThemeId` 一处注入**，不要在
  `kind: 'color'` 项上各写一遍。漏掉一处的表现是「取色卡画的是默认方案的色格，
  而选出来的颜色按当前方案解析」—— 切过配色方案才现形，且不报错。
- **自定义配色方案的移除入口是图库的右键菜单**（`RibbonThemes` → `controls/Menu`）：
  只有 `options[].removable`（= 工程 `customThemes` 里的条目）才挂得上，内置方案
  只读。动作只有一条 `actions.removeCustomTheme`，一笔撤销，且**同时删掉引用它的
  `doc.theme` / `Project.typographyTheme`** —— 留着悬空 id 不会报错（渲染照样回落
  默认方案），但工程会带着一个「本版本没有的方案」。两个实现细节：右键菜单必须
  渲染在 `{#if open}` **之外**（点菜单项时指针不在面板上，图库会先自关，嵌套的
  菜单会被连带卸载、点击落空）；图库的 `attachDismiss` 必须开
  `keepOnRightButton`，否则右键一按下面板就没了，`contextmenu` 根本落不到那一行。
- **原生取色器（`<input type="color">`）只接 `change`，不接 `input`**：那个 input
  活在取色卡的弹层里，而提交动作会关掉弹层 ⇒ input 被销毁 ⇒ **原生取色器被连坐关闭**，
  颜色根本拖不动（用户报过）。拖动中的实时预览要用手势事务（`live`/`endGesture`）做，
  不能「每次 `input` 都提交」—— 那还会往撤销栈里塞几十笔。
- **面板里的一切取色入口走 `ui/controls/ColorField.svelte`（色块按钮 + 取色卡）**，
  裸 `<input type="color">` 只允许存在于 `ColorPickerPanel` 内部的「其他颜色」一格
  （它是逃生舱，不是入口）。原来散落的 6 处（检查器 3 + 属性面板 1 + 填充面板 2，
  另加 lab 2 处）都换过了 —— 原生控件给不出**主题色引用**，所以「换配色方案 ⇒
  颜色跟着走」在那些入口上根本不可能发生。两条口径不变：**显示的是解析后的 hex，
  写回的仍是裸 hex**（精细调整区，改完就该钉死）；`theme` 传**对象**（调用方解析好，
  含 `customThemes`），`allowNone` 控制要不要「无颜色」那一项。

---

## 图片格式（Contextual Tab）

- **版式：一组一个「动作入口」，参数住浮层**。Ribbon 上分别是
  「图片样式（适配 / 圆角 / 边框色 / 边框宽）」「删除背景（开关 + 键色）」
  「四角（开关 + 复位）」「调整（色彩校正 / 重新着色 / 滤镜）」
  「裁剪（裁剪菜单 / 调整大小 / 裁剪为形状）」「对齐画布」+ 既有的「艺术效果」。
  这一组的**控件个数与宽度恒定**：不按状态条件展开（填充组那次教训，见上）。
- **四个浮层共用一个外壳 `ImagePopShell.svelte`**（定位 / 关闭 / 标题）。
  锚点由编辑器按 `IMAGE_TOOL_TESTIDS` 现查 —— 按钮只能发无参意图。
  同一时刻只开一个（`imageTool`），选中换成非图片时自动关掉。
- **裁剪是菜单、不是浮层**：纵横比是一次性预设，没有「当前值」要显示。
  设完比例会顺手把 `fit` 提成 `cover`（`contain` 下窗口会留边，用户会以为
  「裁剪没生效」）；裁剪窗的口径推导在 `typography/image-geometry.ts::cropForAspect`。
- **曲线编辑器是 canvas**（`CurveEditor.svelte`）：控制点要能随时增删，
  SVG 节点增删会在拖动中途打断 pointer capture。坐标一律 0..1、y 向上。
  拖动走 `onlive`（不入撤销栈），**抬手只结算手势**（`onend`），
  纯点击加点才 `oncommit` —— 手势中途 commit 会灌满撤销栈。
- **「四角调整」开关 = 进出模式，不删数据**：打开时补恒等四角并进
  `editorState.quadEditId`；关闭时**只退出模式**。点灭开关的人多半是想编辑
  别的东西，不是想扔掉拖了半天的透视（彻底移除字段仍在元素属性面板）。
- **「裁剪为形状」= 图片就地换成图形 + `imageFill`**：沿用同一个 id（动画 /
  组归属 / 选中都靠它），`docSignature` 带 kind 所以舞台会按新类型重建。
  渲染细节见 `src/typography/AGENTS.md` 的「图形的图片填充」。
- **Contextual Tab 只用一条下划线**：原来给它加了 `border-top` 主题色线，
  激活时上下各一条、像个盒子，而其它 Tab 只有下面一条（用户当 bug 报过）。
  标记改走**文字颜色**（`.r-tab.contextual { color: var(--accent) }`）。

---

## 图片的四角调整模式（`QuadEditLayer.svelte`）

图片元素开了「四角调整」之后，可以在画布上拖四个角 / 边中点：

- **模式是显式的**（属性面板的「在画布上调整」勾选框 → `editorState.quadEditId`），
  不是「选中就显示手柄」。原因：四角手柄与 8 个缩放把手在四个角上**完全重合**，
  两套同时显示时用户分不清拖的是缩放还是透视。进入该模式后 `SelectionLayer`
  只留外框（`quadEdit` prop），退出/换选中就收手柄（`setSelection` 里清）。
- **手柄画在旋转后的框上**：`frame.rot` 是外壳的 CSS 旋转，四角在未旋转的层空间里
  —— 画在未旋转位置上的话，转过 30° 的图片会看到手柄浮在画外。拖动的逆变换
  用 `Rᵀ`（`docToLayer`），写反的表现是「转过的元素手柄走反方向」。
- **拖动是一笔撤销**：`beginGesture()` → `live()`（每 move 改 `el.quad`）→
  `endGesture(tr('typo.undo.quad'))`；纯点击（零位移）走 `cancelGesture()`，
  不留空记录。Esc = 取消这次拖动，不在拖动时 = 退出模式。

---

## 生成器（`ui/typography/SvgGenPickerModal.svelte` + 元素属性面板）

- **入口只有一个按钮**（「插入」页 → 图形组 → 「插入生成器」），点开按六组分区的
  22 格选择器。**参数不进 Ribbon**：横向条带装不下十来个滑杆，全部住在右侧
  「元素属性」的「生成器」小节（类型 / 种子 / 换种子 + `ParamDef` 动态控件）。
- **换类型也走同一个选择器弹窗**（带 `current` 高亮），不是下拉：二十多个生成器靠
  名字挑不出来。与「更换特效 / 转场 / 算法艺术」是同一种交互。
- **预览盒的宽高必须与 `spec.aspect` 严格同比例**（`artBox()` 算好后内联）。
  `<svg preserveAspectRatio="none">` 会照着盒子拉伸：盒子一旦靠 `width: %` +
  `max-height` 夹出来，圆就会变成横向椭圆（用户报的「预览都被拉伸」）。
- **预览与插入同源**：卡片就是 `buildFromSpec(spec, 默认参数, defaultSeed)` 的输出，
  与 `actions.addGeneratedShape` 第一次 build 逐字节相同。手画预览迟早与生成器分家。
- **拖动实时、松手一笔撤销**：`range` 的 `oninput` 走 `setGeneratorParamLive`
  （`beginGesture` + `live`），`onchange` 走 `endGeneratorParamLive`。下拉 / 开关是
  离散值，直接 `setGeneratorParam`（一次 commit）。
- **多选语义**：换类型作用于**全部**生成器元素；改参数只写「与首个元素同 id」的那些
  —— 否则一个色板上的键会污染另一个生成器。
- 参数标签一律 `resolveLabel(p.labelKey, tr)`：`ParamDef.labelKey` 的类型是 `Label`
  （插件可能给字面量），直接 `tr()` 会编译报错。
- **`typo-to-path` 对生成器元素必须可点**（`shape:'svg' && !gen` 才置灰）：
  它的语义是「脱离生成器」，不是「参数化图形转路径」。
- 未知 `gen.id`（旧档 / 别人的数据）→ 生成器小节只留一行降级提示，路径照常渲染。
