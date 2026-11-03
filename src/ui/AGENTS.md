# src/ui/ —— Svelte 界面层

组件 + 控件库（`controls/`）+ 主题与偏好状态。
**时间轴本体是 Canvas2D 自绘，框架只管面板。**

**何时读我**：改 `ui/**`（`ui/typography/**` 与 `ui/ribbon/**` 另有三级文件，见下）；
动抽屉 / 工具栏 / 媒体池 / 剪贴板粘贴 / 设计 token / 选择器；
或遇到「改了 store、界面不动」这类问题时。

相关：`src/ui/typography/AGENTS.md`（排版编辑器）、`src/timeline/AGENTS.md`（时间轴手势与重绘）、
`src/i18n/AGENTS.md`（一切文案）、根 `AGENTS.md`。

---

## 顶栏选项卡是**工程**

一个网页里可以同时开多份工程。`OpenProject` 承载所有「跟这一份工程走」的状态：
`store` / `assets` / `view` / `dir` / `savedVersion` / `playT` / `selectedClipId`。
**切换工程 = 换一个 `activeProjectId`**，不是把一堆散落状态逐个同步一遍（后者每加一个
工程级状态就多一个漏同步的机会）。

- `appState.store` 与 `appState.assets` 是 **getter**，永远指向当前前台那份 ——
  所有写库代码本来就写 `appState.store.xxx`，所以调用点一行都不用改。
  **代价是一条纪律：`const store = appState.store` 之后不能跨越工程切换**，需要跨就重新取。
- 每份工程有自己的 `AssetStore`（`createAssetStore()`）。**任何地方都不许再 import 模块级
  素材仓**（已经没有那个单例，编译期强制）。共用一份的后果不是「看起来不对」，是数据损坏：
  保存 A 时会把 B 导入的素材一起写进 A 的台账。
- **切换工程的顺序不能改**：
  ```
  if (playing) pause()       ← 必须最先：pause 把播放位置写回「当前工程」，
                               而 getter 在改完 id 之后就指向新工程了
  pendingGestureCancel?.()   ← 绝不能让 beginTx 悬空，否则撤销栈整个错乱
  activeProjectId = id
  subscribeActive()          ← version 是 per-工程的，必须换订阅
  refreshPreview()           ← 两份工程分辨率可能不同，必须重同步显示尺寸
  player?.stop()             ← 音频位置属于上一份工程
  ```
- **新建 / 打开 = 再开一份**（`appState.adoptProject()`），不是替换。装配顺序是
  「**先把素材读进来，再登记**」—— 读盘失败时不会在顶栏留下一个半成品 tab。
  因此加号**不需要脏检查**（它不覆盖任何东西）。
- **关闭**：`closeProject(id, { force })` 返回 `'ok' | 'dirty' | 'missing'`。脏的返回 `'dirty'`
  由 UI 弹 `ConfirmDialog`，确认后才带 `force` 再调一次。**不是拒绝** —— 拒绝等于死胡同
  （关不掉，又不知道下一步干什么）。确认框要说清后果是**丢失**。
- **工程列表允许为空**。`appState.hasProject` 是唯一判据；空集时 `activeProject` 回落到一个
  **丢弃用的 `placeholder` 空白工程**，既不是抛错也不是「自动补一份新的」（后者正是
  「关掉空工程看起来没反应」的根因）。空界面（`ui/EmptyState.svelte`）是 `position: fixed`
  盖在主界面上的一层，主界面挂 `inert`。
  > ⚠️ **主界面（尤其 `<canvas>`）绝不能在空状态下卸载** —— WebGL 上下文会永久失效。
  > 并且 `appState.tick()` 在无工程时直接返回（否则背后那台渲染器一直按占位工程出帧）。
- **关页面 / F5 要拦**：`beforeunload` 判据是 `anyDirty`（**任何一份**脏就拦，因为关页面会
  把**所有**打开的工程一起丢掉）。弹**浏览器自己的**确认框 —— 页面内伪造一个会撒谎，
  它挡不住真正的离开。
- 排版视图是**工程内部的第二个视图**（`OpenProject.view`），不是 modal、也不是新 tab。
  时间轴视图**常驻且永不卸载**（卸载 `Preview` 的 `<canvas>` 会丢 WebGL 上下文，且无法恢复），
  所以切视图只是 `display:none` + `appState.tick()` 早退。
- 工程 tab 里可能同时有「回到时间轴」与「关闭工程」两个动作，所以前者用 `arrow-left`
  （`project-tab-timeline-N`），后者用 `x`（`project-tab-close-N`）—— 两个 `×` 会让人分不清。
- **用词约定**：Artmatic 产出的那个目录一律叫「**工程**」，不叫「项目」。
  「项目」只用于指代**这个软件本身**。代码标识符仍是 `project` / `Project`。

---

## 设计 Token 与视觉

- **唯一真源是 `src/ui/tokens.ts`**（纯数据 + 纯函数，不碰 DOM），由 `theme-apply.ts` 写成
  `:root` 的内联自定义属性，`theme.svelte.ts` 管运行时态（亮暗 + 品牌色 + 自定义 hex）。
  **`app.css` 没有也不该有 `:root` 变量块** —— 时间轴是 Canvas2D 自绘，`ctx.fillStyle`
  写不了 `var(--x)`，只写 CSS 必然在 TS 侧养出一份同值的影子副本（改漏就是「面板变了、
  网格没变」这种极难定位的偏色）。Canvas 走 `canvasPalette(spec)`。
- **四层**：primitive（`--p-*`，只描述值）→ semantic（`--surface-*`，描述用途，不含颜色词）
  → component（`--btn-*`，值必须是 `SemanticKey`，写错层直接编译报错）
  → **content**（`--clip-*`，数据类别色，随亮暗变但**永不随品牌变** ——
  它编码的是「这是哪类数据」，不是界面角色）。
- **外观是四套，不是两套**（`THEME_MODES`：`light` / `dark` / `gray` / `contrast`）。
  **rail 的明暗按钮只切 light↔dark**，灰与高对比度**只能**从设置→外观里选
  （`theme.toggleMode()` 从这两套按下去 = 回亮色，图标与结果一致）。
  「亮底还是暗底」一律读 `theme.family` / `themeFamily(mode)`，**不要写
  `mode === 'light'`** —— logo 墨色、Canvas 网格、原生 `color-scheme`、强调色
  的钳制方向都靠它，而写死两态的地方加模式时不会报错。
- **灰色模式有两层底色**：深色 chrome（面板 #525252 + 白字）与**纸面**
  （Modal / 菜单 / 下拉 / Ribbon / 曲线编辑器 = #BDBDBD + 黑字，定位是 Office /
  Unity 那种「长时间盯着看」的一档）。纸面**不是 surface 的某一档**，而是整块
  反相的上下文：容器挂 `data-paper`，`theme-apply.ts` 注入的 `[data-paper]` 规则
  把 semantic 与 component 变量整体重指向 `--paper-*`（规则文本由
  `tokens.paperScopeRule()` 从同一张表生成，**不要手写进 CSS**）。
  于是组件 CSS 照旧写 `var(--text-primary)`，**不要为主题写分支**；新增浮层时
  判据只有一条：它是「叠在面板之上的弹层」就挂 `data-paper`（亮 / 暗 / 高对比度
  下这个属性是空操作）。
- **component 层的值是 `var(--semantic)` 引用**，不是展开后的字面色：自定义属性
  的 var() 在**声明它的元素**上就替换完了，写死颜色的话纸面覆盖追不到
  `--menu-bg`。有单测钉着这条。
- **高对比度模式的分类只靠边框颜色**：表面全 #000、正文全 #FFF；
  `border` 白（结构分隔）、`border-control` 青（按钮 / 输入框 / 下拉 / 数字框）、
  `border-icon` 青（纯图标按钮**只有这一档**有边框，其余三套是 `transparent`，
  对应「图标按钮永远无框」那条纪律的唯一例外）。hover / active 允许离开纯黑
  —— 否则「这里能点」没有任何反馈。Ribbon 的按钮共用 `--ribbon-btn-border`。
  Tab 条与菜单项这类「条状 / 列表里的项」不另加边框：它们已经被所在容器的
  一条边框界定，逐项描边会把面板变成表格。
- **生成器默认色（`#3a6ea5` 之类）不是 token**，那是 Project 文档内容（schema 字段）。
  Inspector 里颜色控件的**外观**走 component 层，**值**走内容。
- **z 刻度（`tokens.ts` 的 `z-*`）有个非显然的约束：抽屉（`z-drawer`）必须比
  时间轴内部那一整套（`z-grid`..`z-ruler`，0..5）都大。** 抽屉是**层叠上下文**，
  从它里面打开的 modal（特效选择器）会被困在那一层：backdrop 写的是
  `--z-modal`（150）也没用，只要抽屉比时间轴内部刻度低，**ruler（5）与播放头（4）
  就会盖到 modal 上面**。实际表现是「选择器开着，缩略图上横着一条白色标尺 +
  一根播放头」—— 排查时盯着时间轴的 z 看是找不到的，问题在 modal 被关得太低。
  规则：**根上下文里除 modal/tooltip 之外的 z 都必须 < `z-drawer`**
  （工具栏 3、底栏 2、时间轴内部 ≤5）。守卫在 `tests/e2e/modal-layering.spec.ts`。
- **视觉纪律**：零阴影零渐变，层次只靠 surface-0→3 的纯色深度 + 1px 实线；圆角 4/6px；
  **唯一例外是 `--shadow-float`**（只给根级浮动面板，当前只有曲线编辑器 —— 它没有布局
  槽位，纯边框与背景分不开）；
  纯图标按钮永远 `background: transparent`，hover 只改图标颜色；主题色只出现在
  **选中 / 激活、焦点环、播放头、底栏数字**这几处。默认**亮色**。
- **密度**：轨道行高 28px、标尺 24px、字号阶梯只有 10/11/12。数值在 `tokens.ts` 的
  `DENSITY`，CSS 与 Canvas 数学（`timeline/view-model.ts`）都从它取，不许各写一份。
- **界面微动效**：基准只在 `tokens.ts` 的 `MOTION`，经 `resolveMotionTokens()` 与
  `theme-apply.ts::applyMotion()` 下发 `--motion-*`；组件**不许自己写时长**。
  只动 opacity、颜色，以及弹层自身不超过 2px 的位移；全部严格小于 200ms，不做退场等待
  （关闭、焦点恢复、快捷键与 `modalDepth` 清理必须立即完成）。
  Modal 只做透明度，**绝不能在遮罩或浮层祖先上加 transform / filter / backdrop-filter**
  （会改变内部 fixed Select 的包含块）。系统 `prefers-reduced-motion: reduce` 永远优先于
  应用内开关；降级只定向到本轮的界面控件，不用全局 `*`，以免误伤排版文档动画。
  开关与三档速度属于外观偏好（`theme.svelte.ts`，与 `fontScale` 同一存储），设置在
  「外观」页；加载/思考态与 Mascot 不参与速度倍率。

---

## 选择器（特效 / 转场）

### 特效选择器（`添加特效`，2026-10-04）

特效到七十多个之后，检查器里用一个 `<select>` 加特效已经不能用了：搜不了、筛不了、
看不见效果。现在换成一个 modal（`src/ui/effect-picker/`）。

- **目录表在 `effects/catalog.ts`，不在各 `defs/`**：七十多条说明要**成批读一遍**
  才能保证语气与长度一致，散在七十多个文件里做不到；而且它是**展示信息**，
  不是 shader 协议。代价是「新增特效 = 三个地方」，由 `tests/unit/effect-catalog.test.ts`
  断言「每个注册的特效都有条目」+「没有孤儿条目」变成明确报错。
- **标签分两半**：`overlay` 与 `category` 是手工的；`feedback` / `multipass` /
  `audio` / `animated` / `hdr` **从 shader def 推导**（`structuralTags`）——
  手工维护这些必然与代码漂掉。**「是否为叠加层」在本项目里没有区分度**
  （所有特效片段本来就是 adjustment layer），所以改成「叠加型 = 在输入之上加东西」。
  分类名与标签名是**拼出来的键**（`fx.cat.${c}`），TS 覆盖不到 ——
  由 `tests/unit/effect-catalog.test.ts` 的一条运行期断言兜。
- **缩略图底图的选择规则**（`effects/thumbnails/bases.ts` 顶部有表）：
  先问这个特效改的是**颜色 / 阶调 / 形状 / 细节 / 径向 / 运动**，再选底图。
  两条被需求点名、且已经写进 E2E 的：
  **去饱和度必须用高饱和彩条**（参考稿这里就是错的：一个把画面变灰的特效配一张
  本来就灰的底图 = 缩略图上看不出任何变化），**通道错位必须用纯黑白底图**
  （它在彩条上是一堆分不开的色块）。
  `mandel` 底图走**注册的** `mandelbrot` 生成器，所以它的默认色改成了纯黑白
  （顺带改正了 `colorA/colorB` **标签反了**：`t` 随迭代次数增大，`colorA` 是快逃逸端）。
  `scroll` 底图是唯一会动的 —— `motion-mask` / `fast-mosh` / `kino-datamosh` 在
  **静止**底图上运动量恒为 0，缩略图会是纯黑。
- **缩略图用独立的离屏 render-core 渲染**（`ui/effect-picker/thumbnails.ts`），
  与 lab 同款：`createRenderCore` 挂在一块 320×180 的离屏 canvas 上，`thumb:` 前缀的
  伪 generator id 由它自己的 resolver 拦截。**不借预览那台** —— 借的话要
  `setExportSize` 改画布尺寸再还原，一不小心就把预览留在错的尺寸上。
  建不出上下文时卡片退化成「只有名字与说明」，功能仍可用。
- **`readPixels` 是自下而上的，必须翻行**（GL 原点在左下，`ImageData` 第 0 行在顶部）。
  守卫：E2E 拿 `pixelate`（底图 `ramp` 上半灰、下半彩）比上下两半的饱和度，
  翻转之后关系会反过来。
- **懒渲染**：IntersectionObserver 只给滚到可见的卡片排队（用 `peek` 而不是 `get`
  读缓存，否则 `{#each}` 一渲染就把七十多张全排上队）。渲染按**时间预算**分块
  （10 ms/帧），因为 `relief` 那类重着色器 × 12 帧会一次占住主线程一百多毫秒。
  有历史的特效（反馈 / 用到「上一帧输入」/ 会动的底图）要**连渲 12 帧**才有内容。
- **多选**：底部「保存并应用（N）」，按**点击顺序**追加到链尾，**只算一笔撤销**
  （逐个 push 各自成一笔的话，按一次撤销只退掉最后一个）。

---

## 分组小标题与拼音搜索（特效 / 算法艺术选择器，2026-10-22）

两个网格选择器都是「小标题 + 分隔线 + 该组自己的卡片网格」，不再是「一大片卡片」：

- **筛选与排序先完成，分组只负责切标题**（各自的 `picker-model.ts::groupItems`）。
  组序恒为目录表顺序（`EFFECT_CATEGORIES` / `ALGO_GROUPS`），**空组不出现** ——
  筛到只剩一条时不留五个空标题占位置；排序只影响**组内**顺序。
- 因为分组已经承担了「按分类看」，排序里那一档「分类」**删掉了**（`PickerSort` /
  `AlgoSort` 现在只有 `default` / `name`）—— 再加回来就是与分组重复的两个入口。
- **卡片网格挂在组内自己的容器上**（`.fxp-tiles` / `.ap-tiles`），列表形态的两列规则
  跟着搬进去：留在滚动容器上会把所有组挤进同一个网格，小标题变成网格里的一格。
- **拼音搜索是手写表**（`i18n/locales/zh-CN/pinyin.ts`）：要转的只是目录里的一百多个
  名字，运行期拼音库带的是整部字典，不值。**新增特效 / 生成器 / 分类必须补一行**，
  漏了只是「打拼音搜不到那一个」，不报错 → 守卫 `tests/unit/pinyin.test.ts` 同时钉
  覆盖与孤儿两个方向。表放在 `locales/` 下是因为**它的键是中文**，属于硬编码文案
  守卫的豁免范围（文件头写了它不是文案）。进 haystack 的是三种形态：带空格全拼 /
  连写全拼 / 首字母 —— 用户三种都会打。
- **`AlgoCard` 的「当前」标记必须与名称在同一个 flex 行里**（`.ap-title`，
  `align-items: baseline`）。名称是 `display: block`，标记若是它前面的独立块，
  「当前」自己占一行、名字另起一行，卡片高度还会随有没有标记跳一格；E2E 用几何
  判据守（标记中线落在名称的高度带内，且在名称左侧）。

---

## 转场选择器（`ui/transition-picker/`）

- **选择器在 `ui/transition-picker/`，与特效选择器同构但有三处不同**：**单选**
  （一个片段只有一条出画转场）、**没有分类 / 标签筛选**（转场目录里没有这两项数据，
  硬造就是假选项）、**带一个「无转场」磁贴**（对应旧下拉的第一项「无」）。
- **两个选择器的列表形态都是 `repeat(auto-fill, minmax(340px, 1fr))`**：
  模态宽 `min(920px, 94vw)`，一排到底只用掉左半幅。窄屏（窗口 < 约 720px）自然退回
  一列 —— 所以 E2E 断的是「前两张同一行、左右并排」，**不是**某个固定列数。

---

## 预览画面上的叠加控件（四角手柄 / 取色吸管）

`ui/QuadHandles.svelte` 是覆盖在**预览画面**上的交互层（四角调整的四角 + 四边中点手柄），
取色吸管则是同一块画面上的「点一下取色」模式。三条纪律：

- **坐标只算一次、只共一份**：手柄位置 = `core/quad.ts` 的 `layerUvToFrameUv`（层空间 →
  画面 uv）+ canvas 的 `getBoundingClientRect()`；图层默认矩形的尺寸用
  `engine/placement.frag.ts` 的 `drawSizeFor`（与合成同源），源尺寸取
  `Project.assets[assetId].size`。**别在 UI 里另写一套 fit/transform 数学** —— 与渲染差
  半像素的形态是「手柄看着对、拖出来画面偏」，没有任何报错。
- **手柄拖动 = 一笔撤销**：`store.beginTx()` → pointermove 里原地改 `clip.quad` +
  `store.touch()` → pointerup `store.endTx()`；pointerdown 必须
  `stopPropagation()`（Preview 的「横向拖 = 两帧并排」会抢走手势）。
  结束路径（pointercancel / Esc / 切工程）一律 `cancelTx()` + `registerGestureCancel(null)`
  —— **绝不能留下悬空的 beginTx**（切工程时的 `pendingGestureCancel` 会兜底，但那是
  事故路径）。覆盖层本体 `pointer-events:none`，只有手柄本身 `auto`。
- **取色吸管（`appState.keyPickClipId`）读的是「只渲染这一轨」的一帧**：
  `renderer.renderFrame(project, playT, { onlyTrackId })` → `readPixels()` → **同一次同步
  任务内立刻** `renderFrame(project, playT)` 还原（中间没有 rAF，屏幕不闪）。
  两条坑：`readPixels` 的行是**自下而上**（GL 原点在左下，uv.y 要翻）；绝不能借用
  `setExportSize` 去放大画布（预览尺寸会被永久短路）。取色结束 / 切选中 / Esc 都要退出模式。

---

## 检查器（`ui/Inspector.svelte`）

- **特效链卡片可折叠、可拖拽排序**。折叠态按 `instanceId` 记在组件本地（不落盘）；
  拖拽复用 `ui/drag-reorder.ts`，**必须给 `handleSelector`** —— 卡片里全是滑杆 / 数字框，
  整卡起拖会把「拖一下滑杆」变成「拖走整张卡片」。链顺序 = 合成顺序（上面的先作用于
  画面），所以排序是内容操作，一笔撤销（`insp.reorderEffect`）。
- **「缩放 X / Y」默认联动**（`appState.scaleLinked`，默认 `true`，存 UI 偏好）。
  拖任一轴的滑杆 / 数字框会把**两个基准值**写成同一个；只同步基值、**不碰 `curves`**
  （两轴的关键帧是独立编排的）。「分离 XY」勾选 = 关掉联动。
- 时间轴右键 / 轨道 ⋯ 菜单的「特效片段」「算法片段」只列**最近用过的 5 个** + 「全部…」。
  最近项存 localStorage（`ui/recent-defs.ts`），**按注册表过滤后再截 5** —— 失效 id
  不许占展示位。新增「用过了」的写入点必须调用 `rememberRecentEffect/Algo`，
  否则下次菜单顺序不变（静默、无报错）。
- **特效片段的「绑定片段」是下拉，不是按钮**（`effect-bind-target`）：候选只列
  **其它视觉轨上的 source 片段**（同轨在时间上不重叠，绑了也看不到），首项是
  「不绑定（按影响深度）」。绑定与影响深度**互斥**，所以绑定时深度输入框整个让位
  —— 两个可编辑项同时存在时，用户会以为它们叠加生效。当前绑定值若不在候选里
  （目标被删 / 被移到同轨）要补一条原值，否则下拉显示「不绑定」而实际仍是绑定。
  时间轴对应角标是 `clip-effect-bound`（`→片段名`），与深度角标同位、互斥。

## 参数行与全局错误

- **非关键帧的「滑杆 + 数字框」只有一份实现**：`controls/NumericField.svelte`。
  检查器烘焙入参 / 转场参数、lab 源 / 特效参数都用它；testid、宽度、tip 走 props。
  `KeyableField` 是它的超集（多了 ◆、曲线键列表、播放头处 key 的读写），不要把两者
  再合并成一份 props 爆炸的分派器。
- **禁用态是一个 props，不是三处各写一遍**：`NumericField` / `Slider` / `NumberInput`
  的 `disabled` 同义（滑杆与数字框一起变灰、不可拖、不可键入）。`Slider` 用
  `aria-disabled` + `controls.css` 的 `.sld[aria-disabled='true']`，别在组件里另加
  一个布尔量控制外观 —— 「数据层禁用了、看着还能点」已经被踩过一次（见 controls.css 里
  `.sel` 那段注释）。
- **全局错误兜底在 `ui/runtime-errors.svelte.ts`**：`main.ts` 最早安装，底栏
  `runtime-error` 段只显示计数，详情在 `runtime-error-modal`。同一条 message 2 秒内
  去重；只留最近 5 条错误 + 10 条 `console.error`。诊断文本包含版本 / URL / UA，
  由 `diagnosticText()` 生成 —— **不要在别处另拼一份**。

## 调色页（`ui/grade/`）

双击 `grade-*` 特效片段进入（`appState.openClipEditor` 分派，与排版页同一手势）。
它是**工程视图**（`view.kind === 'grade'`），不是 modal —— 与排版页同一套：切走再切回来
还停在那一页，顶栏 tab 上带一个色轮图标，Esc / 侧栏底部的箭头回时间轴。

布局不是「一个面板」，而是把主界面的三列换掉内容（见 `App.svelte` 的 `.body.is-grade`）：

| 位置 | 内容 |
|---|---|
| 左下角 | `GradeRail`：对照原片 + 四个面板开关 + 退出。**只占工具条 + 面板那一条**（`.stage.is-grade` 的行 2–3），不满屏 —— 五颗图标占一整列纯属浪费 |
| 中列 | 还是那一个 `Preview` / `Transport`（**不卸载**，卸载就丢 WebGL 上下文）；底部 `Timeline` 只是 `display:none`，那一格换成 `GradePanels`（色轮 / 曲线） |
| 右列 | `GradeDock`：示波器 + 查找表，宽度复用 `drawerWidth`，两块之间的高度可拖（`scopeFrac`） |

- **画面必须一直在屏上**。这是整页改造的原因：原来的 modal 把画面盖住，等于闭着眼调色。
  任何「把调色塞进弹窗 / 抽屉」的方案都会退回同一个毛病。
- **它是专用编辑器，不是检查器的皮肤。** 检查器是「一参数一行」，表达不了色轮位置、
  曲线形状与波形；`grade-curves` 之所以**一个 `ParamDef` 都没有**就是这个原因。
- **前 / 后对比走渲染旁路**（`renderer.setBypassEffect(clipId)`），不改工程数据。
  改 `inst.enabled` 会留下撤销记录，用户按着「看原片」时工程其实被改了 ——
  离开调色页忘恢复就是静默的数据损坏（`closeGradeEditor` 里复位）。
- **分级信息条在工具条里**（`GradeInfo`）：绑定片段还是按影响深度，用
  `affectedVisualIndices` 算（与检查器同一份判据，别在 UI 里另算）。
- **示波器只在示波器面板挂载期间采样**（`Scopes` 的 `onMount/onDestroy` 开关 `setScopeProbe`），
  UI 按 100ms 取最新一帧重画。口径是**编码值**：示波器的意义在于和画面一致。
- **面板显隐在 `grade-panels.svelte.ts`**：侧栏图标与面板标题栏的 × 读同一份 state，
  不写进 `UiPrefs`（页内偏好，不该让工程变脏）。
- **`clip` 是 store 里的普通对象**，所以这个目录里每个 `$derived` 都要 `void appState.version`
  （见上一节「根因三」）。漏了的症状：点了「加上曲线」右边什么都不出现、拖完控制点曲线不重画、
  **拖色轮时把手不动而画面在动**（E2E 有一条用例专门盯这个：松手前读 store 与把手 transform）。
- **谁展示，谁写入：调色页禁止「写当前模块」。** 每个面板都自己派生它要编辑的实例
  （色轮/滑杆 → `basicInst`、曲线 → `curvesInst`、LUT → `lutInst`），写入一律
  `writeOn(inst.instanceId, …)`。`appState.gradeInstanceId` 只用于「多个 `grade-basic`
  时选一个」，**不许**拿它当写入目标：曾经有一个 `write()` 走它，而「加上曲线」正是把它
  改成曲线模块的那一步，于是五个滑杆把 `contrast/saturation/…` 写进一个没有这些参数的
  实例 —— 把手不动、画面不动、不报错，离开调色页再进来又好了（用户报的「偶发滑块无响应」，
  `grade-editor.spec` 的「参数滑杆」用例里有一段盯它）。
- **工具条换成进度条**（`GradeScrubber`）：时间轴被隐藏之后，「拖播放头看别的帧」没着落。
  拍网格 / 吸附 / 时长 / 重叠 / 波纹 / 缩放全是编辑时间轴用的，在这一页一个都用不上。
- **四个色轮**：阴影 / 中间调 / 高光 / 偏移（`lift/gamma/gain/offset`）。偏移是「整体」，
  shader 里先给一点底再乘再减回去 —— 于是它连黑位一起动，而 gain 是纯乘（黑留在黑）。
- 色轮的一行四值（主 / R / G / B）用 `NumberInput fluid`：格子只有 26–30px，写死宽度会
  把 `-0.20` 裁成 `-0.2`。整格还有 `max-width` 上限，免得窗口一宽数值漂离轮盘。
- **面板接缝可拖**：底部两块宽度（`wheelsFrac`）、码头两块高度（`scopeFrac`），都只存
  在 `grade-panels.svelte.ts`（页内偏好，不落盘）。
- **调色模块被停用时必须显式提示**（`grade.moduleDisabled` + 启用按钮）：否则拖曲线
  完全没有反应，看起来就是「曲线坏了」——实测被这样报过。
- **没有专用面板的调色模块在色轮区下方有一块自己的地方**（`extraModules`：既不是
  `grade-basic`、也不是 curves / lut 的那些，今天只有 `grade-qualifier`）。判据按 defId
  白名单排除，不按「有没有参数」—— 曲线与查找表各有面板，在这里再列一遍就是两套真源。
  那一块同时是**蒙版接线口**：调色页把时间轴换掉之后检查器不在屏上，不在这里给入口，
  接蒙版就只能退回时间轴，而「接哪里」正是要边看边定的东西。缺了它的表现是
  「明明加了局部选取，色轮区却只显示『需添加基础调色』」。
- **蒙版接线是一个共用组件**（`ui/controls/MaskField.svelte`）：检查器与调色页同一份，
  候选用 `maskPathExists(边表, 目标, 所有者)` 过滤（一次建图，不逐候选重建）。
  检查器里**每个特效实例都有这一行**（缺省 `composite` 模式在链上混回），不要再按
  def 决定要不要显示 —— 那会把「只有声明过的才能用」重新引进来。
- 曲线是**四张并排**（主 / R / G / B），不是页签：调色最常做的是「提主曲线之后 R 偏了」，
  页签来回切两下就忘了上一条长什么样。一页放几张由**面板宽度 ÷ 图边长**决定
  （允许图缩到面板高度的 2/3 来多放一张），放不下的用两侧的翻页按钮 —— **不要横向滚动条**：
  拖曲线时手本来就在图里，滚轮会跟「拖控制点」抢手势。
- 曲线图的网格 / 参考线 / 曲线本体必须 `pointer-events: none`。它们只是「画」，
  双击加点要落在 `<svg>` 自己身上；不写的话在恒等线上双击（最自然的位置）什么都不发生。

### 示波器（`grade/Scopes.svelte` + `scope-draw.ts`）

- **后备尺寸跟盒子走**（每次重画按 `clientWidth/Height` 设 `canvas.width/height`）。
  固定 256×144 再被 CSS 拉伸的版本里，面板一变高波形就被纵向拉长、矢量图的圆变成椭圆。
- 矢量图取 `min(宽, 高)` 作边长并**居中**：圆是它的坐标系本身，不能椭圆。
- 只在挂载期间采（`setScopeProbe`），限帧 10Hz；`readPixels` 是同步 stall。

### 渐变滑块（`ui/controls/GradientSlider.svelte` + `grade/gradients.ts`）

普通滑杆的轨道只有 3px，表达不了「这一段颜色」；调色的主量与色温 / 饱和度这类量本身就是
一条渐变。所以轨道做成 12px 的渐变条、把手压在上面（16px）。

- 渐变是**内容**（说明往哪边推会发生什么），色值写死在 `gradients.ts`，不跟主题。
- 主量轨道按**影调范围**取灰阶的一段（阴影只暗段、高光只亮段、偏移整段）——
  取整成六档色板会让「中间调」与「偏移」长得一模一样（有单测钉住两条渐变必须不同）。
- 参数改名 / 删掉时渐变表会留死键，症状只是「这条滑杆没有渐变」：`grade-gradients.test.ts`
  把表与参数键钉在一起。

### 环形滚动条（`ui/controls/RingSlider.svelte` + `ring-math.ts`）

色相是**周期量**：线性滑杆的头尾同色却相距最远，红要么被切成两段要么藏在一端。
所以做成一维环（`radius` 不传）与二维盘（传 `radius`）两种形态，数学全在 `ring-math.ts`。

- 角度 0 在 +X、**逆时针**增大；屏幕 y 向下，所以每次换算都取负。写反的症状是
  「色轮上下镜像」—— 拖动看起来正常，只有拿截图比对才发现。
- 半径用**把手活动半径**（`size/2 - 7`）而不是容器半径，否则永远拖不到 1.0。
- 环 / 盘是**内容**（必须显示真实色相），把手与容器是 chrome。把手刻意用白 + 深描边：
  它要压在任意色相上，跟着主题走会在浅色块上消失。
- 轮盘写的是**三分量方向向量**（`lift#r/g/b`），不是「角度/半径」—— 存极坐标会让
  关键帧在 0.99 → 0.01 处跳一圈。换算在 `ui/grade/wheel-model.ts`（零亮度色度平面，
  红 0°、绿 120°、蓝 240°，逆换算是闭式的）。

## 关键帧曲线编辑器（`ui/curve-editor/`）

- **是独立浮层，不进检查器**。曲线要同时看「时间 × 值」两维，塞进一列表单只能得到
  「选一个 key → 改一个数字」。检查器里只留一个曲线图标入口（`KeyableField` 的
  `curve-open`）；插值切换、手柄、批量全在浮层里。**不要再往检查器关键帧行加控件**。
- **三个呼出入口都只调 `curve-editor-state.svelte.ts::openCurveEditor`**：检查器按钮、
  时间轴右键片段「编辑关键帧曲线…」、选中片段后按 **K**。不要在组件里各存一份
  「开着没」的布尔量。
- **多开：一个片段一个面板，不同片段可以同时开**。`targets` 数组顺序 = 层叠顺序
  （后开的 / 刚点过的在上）；再次打开同一片段只切属性并提到最上层。不要再加
  「全局只有一个 target」的旧假设。
- **面板可拖标题栏移动、拖右下角改尺寸、标题栏按钮折叠左侧参数栏**。折叠后图占满
  整宽；尺寸与位置是面板本地状态，不落库。
- **左键单击图内 = 在点击处新增 key；双击 key = 删除它**。拖空白 = 框选，拖 key /
  手柄 = 调整；点时间刻度只挪播放头。不要恢复「双击空白加点」—— 左键已经承担了它。
- **`interp` 是出向语义**（见 `core/curve.ts` 的 `Key` 注释）：选中一个 key 只出现它的
  出向手柄；要改两侧就把相邻两个都选上。工具栏说明文字必须讲清这一点。
- **手势 = 一笔撤销**：`beginTx` → 直改 + `store.touch()` → `endTx`；没拖动就
  `cancelTx`（否则点一下 key 也留一条空撤销）。`registerGestureCancel` 要挂，
  切工程时不能留悬空事务。
- **坐标映射与路径生成在 `curve-geometry.ts`（纯函数 + 单测）**：SVG 用固定 viewBox，
  指针坐标先按 boundingRect 归一化再乘回 viewBox —— 直接拿 clientX 减 viewBox 值会
  在大窗口下整体偏移。
- **左侧参数表是自服务入口**：列出片段上所有可关键帧参数（含尚未建曲线的）；点一个
  没有曲线的参数 = 在播放头建一个 key。量纲与「能不能打关键帧」的唯一来源是
  `curve-meta.ts`（与检查器的 `keyframable` 同一条判据），不要在这里另抄一份 min/max。
- **时间轴片段上的迷你曲线读 `lastCurveKeyOf(clipId)`**：它是「最后一次在编辑器里显示
  的属性」，退出编辑器后保留（会话级视图状态，不进工程）。一个片段只画一条 ——
  片段高度只够一条，多条叠在一起什么都读不出来。路径复用 `curve-geometry.ts` 的
  `clipCurvePath`，与编辑器形状一致。

## 菜单浮层：缩略图预览

**菜单浮层的实现**（`ui/controls/Menu.svelte`）：`MenuItem.thumb` / `.desc`
有值就渲染浮层，贴在**当前高亮项所在的菜单面板**旁边 —— 位置由
`computePreviewPosition`（`ui/controls/popover.ts`，纯函数 + 单测）算，不能用普通的
`computePopoverPosition`：后者只会「右放不下翻左」，**不理解菜单栈的形状**。二级菜单
在屏幕右侧左翻时，按高亮项右侧算出来的预览正好压住一级菜单（2026-10-19 截图实拍）。
现在的候选顺序是「当前面板右 → 当前面板左 → 整个菜单栈左 → 整个菜单栈右」，取第一个
放得下且**不与任何面板相交**的位置。位置在同一个 `$effect` 里算，与子菜单面板同一套
`data-menu-index` 量 rect 的手法。**不引入额外的 hover 状态**：`menu.levels` 就是唯一
真源，鼠标划过与方向键都会更新它，于是浮层自动跟着键盘导航走。三条踩过的：

1. `submenu()` 不接 `testid` —— 二级菜单父项原本没有 testid，测试点不到它。
   在 `clipItems` 里展开时补一个。
2. 浮层的 testid 用**固定**的 `menu-preview`，不跟 `testid` 拼：拼出来的名字
   （`track-menu-panel-preview`）会让测试绑死「从哪个入口打开的菜单」。
3. `bind:this` 挂可变 `let` 会被 svelte-check 报 `non_reactive_update` →
   用**单元素数组**（与同文件的 `panels` 同一手法）。

---

## 界面实时性（本项目最容易反复踩的一类 bug）

症状统一是「store 改了、界面没改，退出重进才更新」，控制台一片安静、不抛任何错。
**测试抓不到这类问题，除非你按下面的纪律写断言。**

**根因一：Svelte 5 的 `$derived` / `{#each}` 靠 `===` 判断传播。**
元素是**原地改**的普通对象（`clip.frame.x = ...`），引用不变 ⇒ 派生重跑了但「值没变」
⇒ 依赖它的模板 effect 静默断更。

> **规则：模板里凡是读嵌套对象字段的地方，来源派生必须换引用。**
> 写法是 `$derived.by(() => { void appState.version; return xs.map(e => ({ ...e, ...e.frame })); })`
> —— `map` / `filter` / 显式字面量都会产生新引用，`return xs` 不会。
> 判据：**模板里凡是 `{@const}` 取的嵌套对象，来源派生就必须让它换引用。**

**根因二：改了文档，但没改 DOM。** 排版编辑器里文档是数据、舞台是 DOM，中间靠
`syncDocDom()` 同步。两次踩坑：传错根节点（函数只看**直接子节点**，外层容器传进去就
全部 `continue`，表现是「拖了半天画面纹丝不动」且不报错）；容器与选择层坐标系不一致
（`toBeVisible()` 抓不到，它只要求元素在 DOM 里有尺寸）。
**能让错误不可能发生，就别指望调用方记得传对。**

**根因三：读的是「类实例」的字段 —— 那个读取压根不可追踪。**
`$state` 只深代理**普通对象与数组**；类实例（`ProjectStore`、`AssetStore`）原样留着，
于是 `p.store.version` 是一次普普通通的属性访问，**不产生任何依赖**。

> **规则：派生里凡是要读类实例的字段，必须同时 `void` 一个可追踪的信号。**
> 本项目的标准信号是 `void appState.version`（「当前工程 version 的镜像」，每次 commit 都变）。
> 判据：问一句「这个字段变的时候，**谁会通知 Svelte**？」答不上来就是漏了。

**根因四：`$effect` 里 `x += 1` 读写同一份 `$state` = 无限自触发。**
`x += 1` 先**读**再写，于是这个 effect 依赖了自己写的状态，每轮 flush 重跑，
Svelte 跑满 1000 次才抛 `effect_update_depth_exceeded` —— 主线程被占死，
**整页掉到 1~2 FPS**，而且欢迎界面（没有工程）也一样慢，因为组件照常挂载。
2026-10-17 在 `QuadHandles.svelte` 的 `geomTick` 上踩过。
> **规则：effect 内只「赋值」不「读取」的计数器，计数放在普通 `let` 上。**
> 写法是 `let seq = 0; let tick = $state(0); const bump = () => { seq += 1; tick = seq; };`
> 同理，任何 `$state` 的 `++` / `+=` 都不许出现在会以它为依赖的 effect 体里。

**配套的测试纪律（比上面三条更重要）**：

> **E2E 只负责「操作」，不看「UI 表现」—— 所以上面这一整类 bug 它一条都抓不到。**
> 断言 store 是必要的，但**不等于验证了功能**：文档改了 ≠ 用户看得见。

- **凡是用户能看见的状态，就断言 DOM**：内联样式、`getBoundingClientRect()`、
  子节点类型 / 顺序、`innerHTML`（图标是否换了）。`tests/e2e/typography-ribbon.spec.ts` 里那几条
  「实时跟随」用例是模板。
- **图标切换必须真的换图标**，不要只改颜色 —— 只改颜色的话 DOM 里什么都看不出来。

---

## 前端实现坑

1. **别把变量命名成 `state` / `props` / `derived` / `effect`** —— svelte2tsx 会把
   `$state` 当成「订阅名为 `state` 的 store」，报一堆看不懂的错。
2. **`use:` action 的 `destroy` 与 `pointerleave` 都可能跑在卸载流程里**：组件被移除时
   浏览器会**被动触发** `pointerleave`，那一刻仍在 Svelte 的 flush 内，同步写 rune 会抛
   `state_unsafe_mutation`。状态写入要挪进 `queueMicrotask`，并用代际号防止迟到的
   clear 抹掉新 hint。
3. **grid 子项要显式约束列**：隐式列默认是 `auto`，会被子项的**最小内容宽度**撑开
   （工具条里几乎全是 `flex-shrink: 0` 的控件）。修法是
   `grid-template-columns: minmax(0, 1fr)`。
4. **自研控件必须带 `data-exempt`**：全局快捷键原来只对 `INPUT/SELECT/TEXTAREA` 放行，
   而自研下拉 / 滑杆 / 数字框都不是原生元素 —— 在它们上面按 Space 会「打开下拉 + 开始播放」
   同时发生。判据统一在 `ui/focus.ts` 的 `isExempt()`。
5. **`NumberInput` 键入的值不要做 step 量化**：`min=0.1 step=0.5` 时键入 30 会被吸附成 30.1。
   量化只留给拖动 / 方向键（`commitValue(raw, cfg, { quantize: false })`）。
6. **删掉组件再新建同名文件，Vite dev server 会继续提供旧模块**（HMR 不报错，表现为
   「改了半天界面纹丝不动」）。验证方法：`curl` 那个模块 URL 搜新代码里的字符串。
   **修法是重启 dev server**（必要时连 `node_modules/.vite` 一起删）。正常编辑不会这样。
7. **样式没热更新时，别急着改选择器**。判据是**同一个元素上「JS 驱动的部分变了、CSS 驱动的
   部分没变」**（图标更新 = 组件逻辑是新的；颜色没更新 = 样式表是旧的）。验证要
   **dev 与 prod 各跑一遍**：Vite dev 把 `<style>` 注入成标签、prod 走独立 CSS 文件，
   两条路径的 scoping 类名都不一样，**只验一边等于没验**。
8. **浮层里不要用 `transform` / `filter` / `backdrop-filter`**：它们会让祖先成为 `position:
   fixed` 后代的**包含块**，于是 `Select` 弹层按视口算出的坐标被当成「相对祖先」解释 ——
   表现是弹层整体偏到一边。居中请用 `left/right: 0 + margin-inline: auto + width: fit-content`。
9. **取色卡给的是「主题色引用」，只有排版能存引用。** `ColorField` / `ColorPickerPanel`
   对所有颜色入口一视同仁地提供 `@accent1` 这类槽位引用，而**只有排版文档**会在渲染时
   调用 `resolveThemeColor`。算法参数 / 特效参数 / 纯色片段的颜色都直接进
   `hexToRgba()` —— 引用在那里算坏颜色，回退成**品红**（`#ff00ff`）。
   症状：在检查器里挑一个主题色，整个画面变品红，参数表里却只看到一串 `@accent1`。
   纪律：**这三个入口写入前必须 `resolveThemeColor(v, theme)`**（检查器三处、lab 两处）；
   排版自己的入口继续存引用（那是「换配色方案跟着变」的唯一依据）。
   历史数据由 `core/schema.ts` 的 `validateProject` → `resolveStrayThemeRefs` 在打开时补，
   它**只碰** `source.color` / algo `params` / effect `values`，`source.doc` 一个字不动。
   守卫：`tests/e2e/color-picker-refs.spec.ts`（落库是 hex + 画面无品红）、
   `tests/unit/schema.test.ts`（含「排版文档里的引用不能被动」）。

## CSS 命名空间：组件类名会被全局样式命中

`src/app.css` 与 `src/ui/controls/controls.css` 是**全局**样式表（`main.ts` 直接 import）。
Svelte 组件的 `<style>` 是 scoped 的，组件规则不会外泄 —— **但反过来成立：
组件里用的类名会被全局规则命中。**（真事：排版选中框用了 `class="sel"`，而编译器里
`.sel` 是 Select 控件类名，于是选中框变成一个不透明白块把图形整个盖住。）

- **跨组件的复用类名加前缀**（`typo-sel` / `rcolor-swatch`），别用
  `sel` / `swatch` / `box` / `row` / `item` 这种通用词。
- **有守卫**：`tests/unit/css-namespace.test.ts` 解析那两张全局表，再扫 `SCANNED_DIRS`
  （`src/ui/typography` + `src/ui/ribbon` + `src/ui/effect-picker` + `src/ui/mascot` +
  `src/ui/pattern` + `lab`）里所有 `.svelte` 的 `class=` / `class:xxx`，
  撞车即失败。加新目录时要把它加进 `SCANNED_DIRS`。
- 这类 bug 只在「那个元素正好被选中」时才出现，控制台没有任何提示 —— 所以必须靠守卫。

---

## 界面约定

- **操作按「逐帧/逐拍」与「对整份工程」分工**：播放、拍网格、吸附、重叠策略、工程时长、
  缩放这些**时间轴操作**一律放在轨道正上方的工具条里（不要挪回窗口顶部）；保存、导出这类
  **工程级动作**放在最左侧的窄图标栏。新增入口时先想清楚它属于哪一边。
- **时间轴形态（节奏 / 标准）的开关也在工具条上**，是**两态按钮**不是下拉
  （只有两个状态时，下拉展开再选另一个是多余的一步）：图标 `activity` / `timer`。
  它只改三处 —— 标尺文案、工具条显示哪组参数（BPM 组 ⇄ 帧率）、吸附档位表；
  **不改数据、不改渲染管线**。吸附档位按形态各记一份（标准模式没有「拍」可吸）。
  详见 `src/timeline/AGENTS.md`。
- **波纹删除的开关也在工具条上**（`ripple-edit`，同样是两态按钮，默认关，存
  `UiPrefs.rippleEdit`）。删片段的入口（Delete 键、检查器删除按钮、右键菜单）**一律走
  `appState.removeClips`**，由它把 `ripple` 交给 store；某个入口直接调 `store.removeClip`
  的形态是「开着波纹、那个按钮却不补位」，看起来像偶发 bug。语义（只动同轨、保留原有空隙）
  见 `src/core/AGENTS.md`。
- **菜单不要无谓地加层级**：一级平铺能放下的就平铺，只有**会变长**的列表才收进子菜单。
- **窄侧栏的入口用全屏 modal，不是 flyout**：flyout 只有两百多像素宽，快捷键清单或导出
  信息塞进去就成了带滚动条的小盒子。（**例外是媒体池**：它是一条贴着左侧栏的抽屉，
  与检查器镜像 —— 内容是一列素材，不需要宽度。）
- **两个抽屉分居两侧**：检查器在右（`.body` 最后一列，选中片段时自动展开），媒体池在左
  （第一列，Rail 上的 `images` 图标或排版页 Ribbon 的「媒体池」开合，默认收起）。宽度是
  **实例值**（`--pool-w` / `--drawer-w` 内联在容器上，不进 token），关掉时是 `0px`。
  ⚠️ **每一列都必须显式写 `grid-column`**：抽屉都是条件渲染的，靠自动排布会在缺一个的
  时候把主体填进 0 宽那一列 —— 表现是整块画面凭空消失（`.body` 与排版页的 `.main`
  各踩过一次，后者是「关掉媒体池，舞台整个不见」）。
- **时间轴高度也是实例值**（`appState.timelineHeight`，`TRACKS_H` 钳 120–560，走
  `UiPrefs` 落 localStorage；`.stage` 上内联下发 `--tracks-h`）。两个热区：
  工具条下缘那条 4px 横带（只调高度）、轨道区底角与抽屉的夹角的两个方块（一次手势
  同时调高度与该侧抽屉宽度）。**方向都是「边界跟随光标」，因此两条热区的竖直符号相反**
  —— 上沿那条是 `startH - deltaY`，下沿那条是 `startH + deltaY`。写反的形态是
  「拖动手感是反的」，用一次就知道不对，但没有任何报错。
- **工具条（`Transport`）窄窗口下横向滚动，不折行**：`overflow-x: auto` + 隐藏滚动条 +
  纵向滚轮转横向（与 Ribbon 面板同源），内容 `width: max-content`（否则控件被压扁
  而不是滚动）。两侧渐变遮罩只在**可滚且没到端**时显示（按 `scrollLeft / clientWidth /
  scrollWidth` 算，容器尺寸变化靠 RO 重算）。
  ⚠️ **绝不加「刷新时把 scrollLeft 归零」的 effect** —— 那句话 Ribbon 的
  `lastScrollResetTab` 注释里记着：挂在 `version` 上的重算会把用户正在点的按钮永远
  打回视口外。
- **媒体池在两个视图各有一份渲染位，同一时刻只有一个实例在 DOM 里**：排版编辑页打开时
  `.body` 里那份靠 `{#if mediaPoolOpen && !editorOpen}` 卸载（主界面只是 `display:none`、
  **不卸载**，少了 `!editorOpen` 就会有两份列表 + 两份视频缩略图队列）。开关是**同一个**
  `appState.mediaPoolOpen`（切视图不重置），条目落点由 `MediaPool` 的 `oninsert` 注入：
  不传 = 插入时间轴，排版页传「图片置入画布」（视频/音频给一句说明）。
- **Agent 抽屉与媒体池共用左列，互斥**：`appState.agentOpen` / `mediaPoolOpen`
  各记各的意图，但 `setAgentOpen(true)` 会收起媒体池、`setMediaPoolOpen(true)` 会收起
  Agent（左列只有一个位置）。宽度共用 `mediaPoolWidth`，拖宽热区同一套。
  两个视图各挂一份、条件互斥（与媒体池同一条），**排版页也必须能开 Agent** ——
  「让模型排字」就是在那页发生的。rail 的入口是 `AgentRailButton`（状态弧 / 计数角标 /
  待确认点，全部 CSS 动画 + `prefers-reduced-motion` 退化）。
- **Agent 的输入框是浮动的，不是流里的最后一块**：`position: absolute` 贴底，
  消息区用 `bind:clientHeight` 量出来的真实高度留底部内边距。它内部有附图、
  模型 / 思考强度的二级菜单。消息列表里每个子项必须 `flex: 0 0 auto`
  （工具卡组件自己也钉了），否则 flex column 会把它们压扁、滚动条永不出现。
- **输入框上方是「标注胶囊」**（`agentState.contextRefs`）：时间轴片段与排版元素的
  右键菜单都有「添加进上下文」，点了就打开抽屉、焦点交给输入框（按数量判断，
  去重后数量不变就不抢焦点）。状态必须放 `agentState` 而不是抽屉组件里 —— 抽屉是
  条件渲染的，关着的时候用户也会右键。发送后清空（它已经进了那条 user 消息）、
  `×` 只撤一条、换工程整批清掉（旧 id 在别的工程里是悬空的）。
  id 与显示名的解析在 `ui/agent/context-bridge.ts`。
- **运行期间输入框不锁**：`busy` 时发送 = **插话**，进 `agentState.queued`，
  虚线卡片贴在输入框上方（可编辑 / 撤销），由 session 在**下一次模型调用之前**
  取走。按钮在 busy 时同时给「停止」与「插话」—— 只剩停止的话，用户会先停再发，
  等于白丢一次已经跑完一半的工具循环。
- **轮末摘要带缓存命中率**（`agent.cache`，`data-pct`）：`agentState.lastCache` 为
  `null` 时整段不渲染（服务商不上报 ≠ 命中 0%）。
- **Agent 的历史入口在 Agent 抽屉顶栏、面板本身是根级 modal**：抽屉带 z-index 是
  层叠上下文，modal 挂进去会被检查器盖住遮罩。会话记录在工程目录的
  `agent/sessions/<id>.json`（不在 `project.json` 里，见 `src/agent/AGENTS.md`），
  打开工程时由 `appState.loadAgentHistory` 读进 `OpenProject.agentSessions`；
  历史面板只读，底部可导出 JSON 日志。
- **对话内容必须可选中**（`app.css` 默认全局不可选）：`.stream` 显式恢复
  `user-select: text`；右键走自绘菜单（复制 / 全选 / 添加到输入框 / 复制整段），
  输入框保留原生菜单。全局 contextmenu 已在 `App.svelte` 禁止。
- **助手正文渲染 Markdown**（`ui/agent/markdown.ts`，`marked`）：模型回答天然是
  Markdown，按纯文本显示时用户看到的是 `**加粗**` 与 `- 条目`。三条安全约束
  **必须保留**：解析前把 `<` 转义（模型输出是不可信输入）、链接白名单
  （`javascript:` 落到 `#`）、图片只回显 alt（不请求第三方 URL）。
  正文是 `{@html}` 注入的 HTML，**不在 Svelte 模板里** ⇒ 样式必须写
  `.md :global(...)`，否则作用域类加不到注入节点上（表现是「有结构、完全没样式」）。
- **工具卡显示的是「设置轨道」而不是 `set_track`**：`ui/agent/tool-labels.ts`
  把 id 转成 `agent.toolName.<camelCase>`；状态用名字前的小圆点编码，
  不用左边框色条。整轮结束后所有过程卡自动折叠。
- **Modal 打开期间全局快捷键整段让路**（`appState.modalDepth`，由 `controls/Modal.svelte`
  增减）。两个 keydown 都挂在 window 上时 `preventDefault()` 挡不住对方 —— 少了这条，
  弹窗里按空格会把主时间线一起播起来。计数刻意**不是 `$state`**：`$effect` 里
  `+=` 会自追踪，直接把响应式系统打崩。
- **弹窗内的视频预览按墙钟配速**（`ui/preclip/preclip-preview.ts`）：`samples()`
  的解码吞吐远高于实时，不等待就会 4–8 倍速。等待只用于 pacing，画面时间仍来自
  `sample.timestamp`，不要把它接进确定性渲染路径。稀疏取帧带「最新一次」令牌，
  拖动打点时旧帧晚到会被丢弃（否则画面回跳）。
- **预剪辑（v13）的入口是单击视频条目**：弹窗在 `ui/preclip/`，范围存 `Asset.ranges`
  （秒落库、帧展示，取整只在 `core/preclip.ts`）。单击与双击必须**人为区分**
  （220ms 定时器；`+` / `⋯` 要 `stopPropagation`），否则双击会先开弹窗再插入。
  排版页（`oninsert` 有值）不打开它 —— 那里没有时间线可插。
- **拖片段首尾裁剪时显示名要跟着被裁**（v13）：`timeline/live-trim.svelte.ts` 记录
  手势起点的内容原点，`ClipView` 把 label 的 `left` 反向偏移；松手清空。只靠边框变色
  不够 —— 裁剪与移动必须在按下那一刻就能区分。
- **媒体池的列表是「合成」出来的**：`Project.assets`（kind / 名字 / 时长 / 尺寸）与
  `AssetStore`（来源 / 字节数）各说一半，合成规则与「素材 → 片段」的默认值都在
  `ui/media-pool.ts`（纯函数，有单测）；面板只管把 `appState` 喂进去。想改
  「图片默认几拍 / 什么 fit」时改那一处 —— 抄进组件就意味「导入」与「从池里插入」
  两条路会给出两个结果。
- **媒体池的搜索 / 形态 / 排序都在 `media-pool.ts`**（纯函数，有单测），组件只画：
  `filterPoolItems`（展示名 + 原始文件名 + id，包含 / 拼音 / 子序列三种命中）·
  `sortPoolItems`（**只决定组内顺序**，方向写进下拉标签）· `assetUsageSeconds`（「时间轴
  时长」那一档的数据，与 `clipsUsingAsset` 共用 `clipAssetId` 这一条判据）。
  **搜索输入框在抽屉头部（`MediaPoolDrawer`）**，查询词是那一刻的临时状态，不进偏好。
- **媒体池的拼音走按需加载的 `pinyin-pro`**（`ui/pool-pinyin.ts`）：`i18n/pinyin.ts` 的
  手写表只覆盖固定词表，而素材名是**用户数据（开放集）**。库只在搜索框 `focus` 时
  `import()`，加载完把 `appState.poolPinyinReady` 翻真让列表重算一次。**别改成静态
  import** —— 那会把几百 KB 的字典塞进首屏与排版页；也**别为「一致」把手写表删掉**：
  它仍是加载失败时的兜底。
- **紧凑形态用 CSS grid `auto-fill` 决定列数**，不在 JS 里算「够不够宽」：条目只留名字，
  缩略图整个不渲染（也就不为它解视频帧）。两种形态共用一个偏好 `appState.poolView`。
- **重命名素材只改 `Project.assets[id].name`**（`ProjectStore.renameAsset`，一笔撤销）：
  台账的 `originName`（决定落盘文件名 / 扩展名）、linked 的原文件路径、已有片段的 label
  **都不动**。素材仓里的展示名镜像由 `appState.renameAsset` 一起改，否则「未使用素材」
  会继续报旧名字。Agent 侧是 `rename_asset`（不经过 media_op 的确认闸门 —— 它不碰文件）。
- **右键与 ⋯ 是同一个菜单**：`Menu` 的 `at`（右键坐标）/ `anchorEl`（按钮）两条入口，
  条目列表只写一份。行上的 `oncontextmenu` 必须 `preventDefault`（全局右键已禁用）。
- **linked 素材的三种状态都有唯一出口**：媒体池行内徽标（`引用` / `源已变化`）、
  右键「收集到工程 / 重新链接」走 `project-actions.collectAsset` / `relinkAsset`。
  桌面版的文件监视在 `ui/asset-watch.ts`，**只标 `stale`，绝不自动重读**——
  自动换内容会让「同一帧两次渲染用了不同字节」变得无法复现。
- **拖入 / 粘贴都走 `media-import.importFiles`**：进入函数时**同步**把
  `platform.pathForFile` 取完（Electron 的 `webUtils` 只在 drop 事件期间可靠），
  再 `await platform.allowPath` 登记主进程 allowlist，最后走
  `importLinkedPath`。拿不到路径（浏览器 / 剪贴板）才退化成字节导入。
  **不要**在 drop handler 里自己 `await` 后再取路径 —— 那样会静默退化成 bundled。
- **「未使用素材」只在工程面板的「清理」页（`ProjectModal.svelte`）**，数据是 `assets.retainedIds()` /
  `retainedInput()` / `retainedSize()`。三个动作都有唯一实现：恢复走
  `project-actions.restoreUnusedAsset`（要 await 素材来源重建，之后画面才能出来）、
  清理与真删走 `trashUnusedAsset` / `deleteUnusedAsset`。**不要在组件里直接调
  `moveAssetToTrash` / `fs.remove`** —— 少了 `store.touch()` 台账就不会被下一次
  保存写下去，表现是「删了又回来」。
- **素材进来有五个入口，一份实现**：时间轴菜单（文件选择器）、从系统拖文件到时间轴
  （落成片段）、从系统拖到媒体池（只登记素材）、从池子里拖条目到时间轴、**剪贴板粘贴**。
  全部走 `ui/media-import.ts`（素材那一半）+ `ui/media-pool.ts::insertAssetClip`（片段
  那一半）；`ImportTarget.trackId` 的三种取值就是三种落点：**`undefined` = 只登记素材、
  字符串 = 建片段且优先这条轨、`null` = 建片段但由 `insertAssetClip` 自选**（没有装得下的
  会补一条轨）。**不许在组件里另写一份 probe / 进仓 / 建片段** —— 那样「拖进来的视频」与
  「菜单导入的」迟早会在默认 `fit`、默认长度、落点上分叉，而这种偏差没人会去查。
- **粘贴走 window 上的 `paste` 事件，不是 Ctrl+V 的 keydown**：`clipboardData` 只在事件
  派发期间可读（同步、零权限），keydown 里够不到它（只能去要授权的
  `navigator.clipboard.read()`）。三条纪律：剪贴板里**没有素材时必须整段放行**
  （不 preventDefault，否则输入类控件的文本粘贴整个失灵）；`isExempt(e.target)` 放最前
  面；文本编辑区的守卫用 `e.defaultPrevented` 让路。时间轴视图弹 `PasteAssetsModal` 问
  落点（播放头 / 仅入池），排版视图按类型直接落地（图片进画布、视频音频进池子）——
  那边只有一种合理解释，不值得再问。类型判定在 `ui/clipboard-assets.ts`（纯函数，
  **认不出的静默跳过**：粘一段文字不该弹「不支持的文件」）。
- **文本通道里先试片段 JSON**（`core/clipboard.ts` 的 `parseClipboard`），命中才接管；
  没命中**照旧整段放行**。剪贴板里不可能同时是片段 JSON 又是素材文件，两条路互斥；
  排版页不接片段 JSON（那边有自己的元素剪贴板，时间轴片段粘进去没有意义）。
  Ctrl+C/X 写系统剪贴板**之外**还留一份内存副本：写不进去（权限 / 非安全上下文）时
  Ctrl+V 才拦截并粘内存里那份（`clipClipboardFallbackActive()`）—— 写得进去时一律
  不拦截，让 `paste` 事件读系统剪贴板里**最新**的内容（包括从别的窗口粘进来的）。
- **拖动期间只读得到 `dataTransfer.types`，读不到 `getData`**：所以「认不认得这个拖拽」
  必须靠类型判定 —— 媒体池的条目用自定义 MIME `application/x-artmatic-asset`，
  系统文件用浏览器的 `Files`。落点提示（行底色 + 竖线）只在两者之一时才亮。
- **落点判定挂在 `.rows` 上，不是每一行**：行下标由 `clientY` 算（拖到行区下方的空白
  处算最后一行），时刻由 `timeAtClientX` 算 —— 与右键菜单同一套换算，竖线画在**吸附后**
  的位置上，看见的就是会落下的位置。
- **视频的缩略图是惰性的**（`ui/media-thumbs.svelte.ts`）：列到某一条视频时才解一帧
  （`engine/video-source.ts::videoThumbnail`，一次性 Input、用完 dispose），**串行**、
  失败不重试。导入时不预热 —— 十个视频就是十次解码，而用户可能根本不打开媒体池。
  图片不需要这一套：导入时 `registerImageBytes` 已经解出一张 canvas 了。
- **工具条的 tooltip 朝上**（`tipPlacement="top"`）：工具条紧贴轨道区，下方没空间。
  `tip.ts` 在 `pointerdown` 时会收起气泡 —— 否则点开的下拉会被悬停气泡挡住第一项。
- **UI 文本一律 `user-select: none`**（`app.css` 在 `html,body` 上设，输入类元素单独放行）。
- **drag-to-tweak 撞到视口边缘时上 Pointer Lock**：检查器在屏幕右侧，往右拖几下就撞边、
  位移不再增加。只在 `clientX` 贴边（3px 内）时才启用，所以普通拖动的手感完全不变；
  锁定被解除（Esc / 失焦）＝取消这次拖动。
- **音频片段的底色必须半透明**：波形画在 `canvas.grid` 上，而那张画布在片段 DOM **下面**；
  填充不透明就会把波形整个盖住，看起来是纯色块。
- **列表拖曳排序只有一份实现**（`ui/drag-reorder.ts`）：顶栏选项卡（横向）、时间轴轨道行、
  排版图层面板（纵向）、检查器特效链（纵向）都用它。三条硬约定：位移超 4px 才算拖
  （否则按钮点按被 1~2px 抖动吃掉）；拖完那一次 `click` 必须吞掉（否则「拖一下选项卡」
  会顺带切一次工程）；**项内有交互控件时必须给 `handleSelector`**（特效链靠它只认 grip，
  不然滑杆的按下会被当成起拖）。图层列表是**倒序**渲染的，视觉下标 → 数组下标要
  `len - 1 - i`，换算只在调用处做一次。
- **设置面板 = 草稿 + 保存并应用**（`ui/SettingsModal.svelte`）：工程参数与界面偏好只在
  Apply 时写回，取消 = 什么都不做。标签前的 `*` 表示「与**打开面板时**的值不同」。
  那份基准快照是**普通 const，不是 `$derived`** —— 做成派生的话 `version` 一动基准就变，
  星号会在自己刚亮起时又熄掉。**「许可」与「桌面」是只读页**：没有草稿，底栏只有「关闭」。
  许可页列第三方名称（数据表在组件里，只列名称，用途与移植细节留在仓库根的 `CREDITS.md`，
  抄进界面就是第二份会过期的账）；桌面页是壳层动作（开发者工具 / 重新加载 / 退出），
  **只在 `platform.shell` 存在时出现** —— 浏览器里没有窗口可管，列出来就是一页按了没反应的按钮。
- **「侧栏 + 内容」型面板只用 `controls/SideNav`**（设置 / 工程）：navside 固定宽、内容列
  自己滚动、modal 高度固定（切页不跳）。工程面板的四页是**按发生时刻**切开的
  （概览 / 清理 / 操作 / 最近），动作页是竖排列表而不是一排按钮 —— 六个动作的标签长度
  差一倍，排一行会被最长那条撑开，「另存为」与「打包」的区别也没地方写。
- **`.editor` 这类 grid 的行数必须与子项数一一对应**。条件渲染的子项一律先包一层再进 grid，
  否则缺席时后面的子项会落到错误的行上（表现为某条 bar 被拉高或被挤出屏幕）。
- **`$derived` 返回新对象时，读它的 `$effect` 会每轮重跑**。需要「只在 X 真的变化时做一次」
  的动作（如 Ribbon 归零）必须用普通 `let` 记住上一次的值，不能靠 effect 依赖。
- **禁用必须同时是功能上的与视觉上的**：看着能点、点了没反应只会被判定成卡死。
- **操作提示分三级**：`appState.flash(text, level)`，`level ∈ info | success | error`，
  默认中性，颜色与图标都跟着 level 走。不要只有红色 —— 「已保存」也是红的会让人以为失败。

### 底栏提示（`ui/hints.ts` + `ui/status-hint.svelte.ts` + `StatusBar`）

「现在能做什么」，**不是**「这个控件叫什么」。后者是悬浮气泡（`use:tip`）的活；
底栏原来抄气泡的文字，于是屏幕上同一句话出现两次（而且气泡能换行、底栏不能，
抄过去还得被截断）。三层，优先级从高到低：

1. **手势**（`statusHint.gesture`）：拖片段 / 框选进行中，报「松开会怎样、Esc 会怎样」。
   写在手势代码里（`timeline/drag.ts`、`timeline/marquee.ts`），**结束必须清**。
2. **悬停**（`statusHint.hover`）：片段 / 轨道行空白 / 标尺 / 轨道头。这些目标
   **没有气泡**，是底栏唯一无可替代的一类。判定走 `Timeline.svelte` 里**一个**委托的
   `pointerover`（`data-clip-id` 压过 `data-hint="rows|ruler|track"`）——
   用冒泡的 `pointerover` 而不是 `pointerenter`，否则在行内滑动时判定不会更新。
3. **场景**（`sceneHint`）：空时间轴 → 右键新建片段（Blender 报 Shift+A 的位置）；
   选中集 → 切分 / 改名 / 删除；播放中 → 最前面压一个「空格 暂停」。

- 构图全在 `ui/hints.ts`（**纯函数**，不 import appState，快照由 StatusBar 组装成
  `HintContext` 传进去 ⇒ 可单测；`timeline/` 也要用它，不能把 appState 拖进手势代码的模块图）。
  文案键集中在 `i18n/locales/zh-CN/hint.ts`（`hint.*`），角标复用 `sc.*` 的
  「按键 + 说明」对（`shortcutOf` 按描述键回查，查不到就抛）。
- **一条提示最多四件事**（含播放中那个暂停角标），`tests/unit/hints.test.ts` 按上限
  守着全矩阵；`tests/e2e/status-hint.spec.ts` 守接线（`data-hint` 写错就是一片空白）。
- **不能报假的快捷键**：F2 / S / Del 只作用于选中集，悬停一个**没选中**的片段时不许出现；
  切分键随「操作习惯」变（`splitKeysKeyOf`），说错键比不说更坏。
- 场景快照里 `void appState.version` 不能省（片段增删是原地改）——否则删光片段后底栏
  不会切回「右键新建片段」。

---

## 品牌资源

`ui/Brand.svelte` 内联 SVG（不用 `<img src>` —— 那是独立文档，页面 CSS 进不去），
按 `variant` + 当前主题取用，把资源里写死的品牌紫换成 `var(--accent)`，**墨色保持资源原值**。
标记在 `size >= 44px` 时换成 3×3 版（20px 的位子放 3×3 会糊成一团）。

> ⚠️ **文件名说的是「墨色」，不是「目标模式」** —— 这里极容易搞反：
> `-dark` 里的墨是深灰，配**亮背景**（亮色主题）；`-light` 里是近白，配**暗背景**。
> 也就是 `mode === 'light'` 取 `-dark` 文件，反之亦然。
> 搞反的后果不是「颜色不太对」而是 **logo 整块隐形**，肉眼验收很容易放过 ——
> 所以有 `tests/e2e/brand.spec.ts` 钉着（查墨色取值 + 与底色的对比度）。
