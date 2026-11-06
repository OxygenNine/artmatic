# src/typography/ —— 排版

`TypographyDocument` 模型 + 光栅化后端 + 字体注册表 / HarfBuzz 子集化。
排版是**工程内部的第二个视图**（`OpenProject.view`），不是 modal、也不是新 tab。

**何时读我**：改排版文档模型 / 光栅化 / 字体与子集化 / 配色方案 / 画幅与上屏大小 /
脱机媒体占位符时。

相关：`src/ui/typography/AGENTS.md`（编辑器、Ribbon、取色入口的 UI 约定）、
`src/ui/AGENTS.md`（抽屉与 modal 的通用约定）、`src/project/AGENTS.md`（字体字节存哪）。

---

- **色标（渐变停靠点）的两条约定**：文档里 `stops` 的数组顺序是**用户的编辑顺序**
  （面板上色标行不跳位），渲染前一律过 `document.normalizeStops`（钳制 0..1 + 按 offset
  排序）——SVG `<defs>` 与 CSS background 共用它，别各排一份；`applyPaintPatch` 在补丁
  **不带 `stops` 时保留整份色标**，只改「offset 最小 / 最大」的那两个颜色，所以 Ribbon
  的两个颜色控件对多色标是安全的（不会被重建成两色标）。Ribbon 的「渐变开始」读的也是
  排序后的首色标。
- **文本框背景与字形填充是两层，别合并字段**：`TextElement.boxFill` 画在元素外壳
  （`.typo-el` 的 CSS `background-*`，文字之下）；`fill` 裁在内层 `.typo-text` 的
  `background-clip: text` 上。共用一个字段的话，`background-clip: text` 会把背景色一起
  裁到字形里，「给文本框填个底色」就变成给字上色。`boxStroke` 同理（外壳的 CSS border，
  `box-sizing: border-box` 已由 elementStyle 钉死）。两者都由 `css.ts::textBoxStyle`
  产出**完整**声明表（就地同步没有删除语义，切回「无填充」必须能复位）。
  ⚠️ **agent 写入会把纯色 `fill` 翻译成 `style.color`**（`agent-ops.ts::applyTextFill`）：
  渲染侧只有渐变 / 径向 / 纹理参与字形填充，`solid` 是 no-op —— 不翻译的话
  「同一个字段渐变有效、纯色被静默忽略」会被误判成字段名写错。
- **agent 路径的默认值必须「不改变画面」**：`agent-ops.ts::addShapeElement` /
  `addGeneratedShape` 不给 `fill` 时写 `{kind:'none'}`、不给 `stroke` 时写 `null`
  （`createShapeElement` 给 `line` 的那条白色 4px 描边也一样被覆盖）。工厂里的实心紫
  （`#6f64ef`）服务的是面板路径（人先看见再改色），agent 往往「先搭骨架再上色」——
  一块默认紫会把画面染成它没打算要的样子。这条默认值必须同时出现在
  `get_typography_capabilities().units.defaults` 里。
- **元素动画是文档模型的一部分**（`ElementAnimation[]`，`animation.ts`）。
  三种 `kind` 并存，但**编辑器只产 `tracks`**：
  - **预设库在 `animation-presets/`**（进入 / 强调 / 退出三个模块，各带定义与
    keyframes 体；`animation.ts` 只做汇总与派发）。加一条预设 = **四处**：
    `animation.ts::ANIM_PRESET_IDS`（联合类型的唯一真源）、分组模块的 `defs` +
    `keyframes`、图标（`ui/typography/anim-icons/<group>.ts`）、文案
    （`i18n/locales/zh-CN/media.ts` 的 `anim.*`）。漏一处全是**静默**失效，
    `tests/unit/anim-presets*.test.ts` 逐条点名（**含「展开成轨道时零丢弃」**）。
    预设只能写解析器吃得下的写法 —— 清单见 `animation-presets/types.ts` 的头注释，
    违反的后果是动画少一段而不是报错。
  - `tracks`（主模型，`animation-tracks.ts`）：**一条动画 = 一个属性**，关键帧存
    **绝对秒（相对片段起点）**，每帧可带出向 `ease`（关键字 / `[x1,y1,x2,y2]` /
    `{ steps: n, jump }`，发射时统一由 `animation.ts::easingCss` 拼成 CSS 值）。
    想让几个属性异步起落就发**多条**
    动画，各带自己的 `animation-delay`。同一元素**不许两条动画动同一 (属性, 作用层)**
    （同层互相覆盖、嵌套层矩阵相乘，语义都不可预期）——所以「再加一个动画」不是
    再挂一条同属性动画，而是**往那条轨道里接一段关键帧**：`applyPreset` 走
    `animation-insert.ts::insertAnimationsAt(existing, incoming, at)`，插入点 =
    播放头（片段内相对秒），插入点之前的帧一帧不动、之后的帧整体右移新动画时长
    （用户 2026-10-25 定的「增量插入、不破坏先前动画」）。插入点会夹进片段
    （`min(播放头, 片段时长 − 动画时长)`）—— 否则「插进去了但画面里永远看不到」。
    同 (属性, 作用层) 的**替换**语义只剩 `addTrack` / `setTrackTarget` 这两条手工路径。
    **跨层各一条是合法的**（它们落在不同 DOM 节点上）。
  - 关键帧的 `color`（`#rrggbb`）是**编辑器标记**，只画在关键帧面板的菱形上，
    **绝不进样式表**（`channelDeclaration` / `emitTracks` 都不读它）。
    `normalizeKeyColor()` 是唯一闸门；agent 的读回形状会带上它（否则「读一遍再写回」
    会把标记抹掉）。
  - **`target` 只有两个值，缺省是 `box`**：
    `box`（不写键）落在 `.typo-box`（外壳**之外**，文本框底板与边框一起动 ——
    `clip-path` 才裁得到框、`rot` 才转整块）；`content` 落在 `.typo-anim`
    （外壳**之内**，只影响文字 / 图形 / 图片）。
    **为什么缺省是 box 而不是 content**：用户说「给文本框设个旋转」时想的就是整块，
    缺省成「只转字」会被当成 bug（第一版就是这么上的，用户当场报回来）。
    老工程靠 **`SCHEMA_VERSION = 18` 的迁移**（`pinAnimationTargets`）把每个没写键的
    条目显式钉成 `content` —— **没有这条迁移，缺省一改旧工程画面就全变**。
    五条实现纪律：
    1. **只在有 `box` 动画时才建 `.typo-box`**，且它承担 frame 的定位、外壳退化成
       `inset:0`（`elementStyle` 的 `inset`）—— 每层都写 left/top 会把偏移算两遍。
    2. `syncDocDom` / `syncGroupShells` 找外壳必须过 `unwrapShell()`：包装层夹在
       `.typo-doc` 与 `.typo-el` 之间，只认直接子节点的话整轮同步**静默跳过**。
    3. `target` 要进 `docSignature`（它是结构差异）；`parseAnimationInput` 展开出的
       **每一条**轨道（legacy keys / preset）都得带上它，迁移的 `timingOf` 不许丢。
    4. `animationView` **总是**输出 `target`（含 `content`）：省略它再写回就会落回
       缺省的 `box`（老工程「只转字」变「整块转」）。
    5. 新写入口（面板 `addTrack`、agent 的 `typo_set_animation`）显式写这个键 ——
       读回 / 复制 / 迁移时一眼看得出它落在哪一层。**已有轨道可以换层**
       （`actions.setTrackTarget`：改字段 → 签名变 → 重建动画层），
       同层同属性按替换处理 —— 别让用户「删了重建」。
    已知代价：`box` 动画层会成为 `mix-blend-mode` 的新参照系，与静止时不完全等价；
    选中框仍按 `frame` 算（与其它动画一致，不跟着动画转）。
  - `preset` / `custom`：旧形态，只在打开旧工程（v17 迁移）或 agent 的 `css` 入参时出现。
    渲染层必须继续支持（`animationStyleSheet` 三条分支），面板对它们显示只读行。
  - **延迟只许出现一次**：`delay` 写在 CSS 简写的 `animation-delay` 里，那是 effect
    timing 的一部分，而 WAAPI 的 `currentTime` 时间轴**包含**它（实测 delay=3s 的动画
    在 `currentTime=3000` 才进 active 段）。所以 seek 只做「秒 → 毫秒」
    （`animationCurrentTimeMs`），**不许再减 `delay`**。再减一次 = 起点变成 2×delay
    （3s 起的元素 6s 才动），而延迟期被 fill 停在首帧 —— 不报错、不闪，只在回头比对
    时间时看得出（2026-10-24 修，守卫在 `tests/e2e/typography-keyframes.spec.ts`）。

  agent 侧入口是 `agent-ops.ts::parseAnimationInput` / `animationsFromInput` /
  `setAnimation` + `typo_set_animation` / `typo_add_element.animation`。五条不能破：
  1. **时间单位有两套**：`tracks.keys[].t` 是绝对秒；旧式 `keys[].at` 才认 0..1。
     `{beat:n}` 的换算在控制平面（那里才有 BPM 与 clip.start），文档层只收秒。
     两种口径混用不会报错，只会「动得不对」。
  2. 旧式 `keys` 生成的 `@keyframes` 体**每一帧都写全被用到的属性**（缺的取恒等值），
     否则 CSS 会从元素基础样式插值（基础样式里有用户自己的旋转 → 动画会「先歪一下」）。
     `tracks` 一条只有一个属性，这条不适用。
  3. `typo_replace_doc` 必须把 `animations` 一起搬过去。整份替换顺手清掉动画，
     表现是「文档还在、动的东西没了」，且没有任何提示。
  4. **手写 CSS 与 UI 是同一条路**：agent 的 `css` 入参必须过 `parseCustomCss`，
     失败时把 `CustomCssError`（经 `CUSTOM_CSS_ERROR_KEYS` 翻译）回给模型。
     读回形状（`animationView`）必须能被 `parseAnimationInput` 原样读回 ——
     否则「读一遍再写回」会静默丢掉自定义动画、把无限循环变成 1 次。
  5. **预设与旧数据都展开成轨道**（`animation-migrate.ts::presetToTracks` /
     `customToTracks`，由 `core/schema.ts` 的 v17 迁移与 `agent-ops` 共用）。
     `transform` 能无歧义拆 translate/scale/rotate 就拆通道，拆不动就整条存成
     原始属性轨道（**宁可不可编辑也不要改画面**）；拆出来的每个通道都在**所有帧**
     补恒等值 —— CSS 里「这帧没写 transform」是「从基础样式插值」，不是「保持上一帧」。
  6. **任意属性要过闸**：属性名 `^(--)?[A-Za-z][A-Za-z0-9-]*$`、值拒 `; { } < > url( !important`。
     它们会被拼进唯一那份 `<style>`，一个 `}` 就能闭合 `[data-anim-id]` 规则。
- **`fontFamily` 写进 CSS 必须过 `cssFamily()`**（`font/css-family.ts`），`css.ts::textStyle` /
  `spanStyle` 是仅有的两个出口。族名里的「数字开头的词」会让裸拼的声明**整条非法**
  （`font-family: HYPixel 11px` 中的 `11px` 是 dimension 不是 ident）⇒ 浏览器丢弃这条声明，
  元素静默继承界面字体。字体下拉一直走这个函数，所以症状是「下拉里是像素字形、
  舞台上回退系统字体」，而且不报错（2026-10-25 用户报的汉仪像素 11px）。
  **判断「是不是这个 bug」的办法是看族名，不是看字体是不是可变 / 位图**：`Alimama Fangyuanti VF`
  全由合法 ident 组成，裸拼本来就成立。
- **四条实现规则**（不遵守会静默出错）：
  1. **字体子集化，按字形集哈希缓存**。不做这条每帧上百毫秒，做了是毫秒级。
     字形集只在打字时变化，命中率极高。
  2. **不要用 `embedFonts:false` 换性能** —— 实测它的差异量级与「故意换成另一个字体」
     几乎相同，等于换了字体。要性能就裁字体。
  3. **导出前必须 `await document.fonts.ready`**，否则首帧用回落字体量度，导出与预览
     不一致，且「看起来都正常」，极难定位。
  4. **动画状态要烘焙，不要指望库读懂**：WAAPI seek → 把计算值写进内联样式 →
     停掉 animation → 再截图。（WAAPI 的 seek 实测误差为 0，所以 CSS 动画可以帧精确导出，
     但必须走烘焙路径。）
     **快照的属性名单来自 `effect.getKeyframes()` 的并集，不是写死三个**：手写 CSS
     可以动 `visibility` / `letter-spacing` / `clip-path`，写死的名单漏掉它们时
     表现是「预览会动、导出不动、不报错」（2026-10-24 修）。顺序不变：**先读计算值、
     再 `animation='none'`、最后逐个 `setProperty`** —— 反过来会被动画的计算值盖掉。
- **元素级 3D 是「参数 → CSS 字符串」，不是矩阵**（`document.ts::Transform3D` +
  `css.ts::transform3dCss`，面板在「元素属性」的 3D 分节）。三条纪律：
  1. **变换顺序固定**：`perspective → translate3d → rotateX → rotateY → rotateZ →
     skewX → skewY → scale3d`。改顺序 = 改已有工程的画面。
  2. `rotate.z` 与 `frame.rot` **合成一个 `rotateZ`**（都是绕 Z），不写两条 ——
     否则「谁先谁后」会变成第三处约定。
  3. `transform-origin` / `backface-visibility` / `transform-style` **总是输出**
     （关闭时给 CSS 默认值）：就地同步只 set 不 delete，漏一个键就会在
     「启用 → 关闭」后残留（与 `textBoxStyle` 同一条纪律）。
  `perspective` 用 **`perspective()` 函数**，所以没有 `perspective-origin`；要做
  「整页共享一个消失点」得把 perspective 提到文档根（未做）。选择框 / 吸附仍按
  **未倾斜**的 `frame` 算 —— 倾斜元素的可视范围与编辑框不一致是已知的，与旋转同源。
- **镜头（2.5D 视差）：语义只有一个实现**（`camera.ts`，纯函数）。`doc.camera` 是
  文档级的四个数（x / y = 取景中心相对画布中心的偏移，文档 px；zoom 倍数；
  **rot 是度**，与 `transform3d` 同口径而不是 `frame.rot` 的弧度），元素的
  `depth`（0..1）决定它吃多少：
  `A_d(p) = o + s·R(φ)·(p − o) + t`，`s = 1+(zoom−1)d`、`φ = rot·d`、
  `t = −d·zoom·R(rot)·c`（o = 画布中心）。三条端点因此是干净的：
  **d=0 ⇒ 恒等**（无穷远，一个像素都不动）、**d=1 ⇒ 与「整个文档被镜头推过去」
  等价**、没有 camera 或全 depth 0 ⇒ 与没这个功能**逐像素相同**。
  1. **只拼在 `.typo-el` 自己的 `transform` 前缀上，不加 wrapper**：wrapper 会新建
     层叠上下文与包含块，富文本块内的绝对定位子元素会换参照系（不报错、只在特定
     排版下歪）。CSS 只有一个 `transform-origin`，所以 `parallaxCss` 把它拆成
     「绕自身 origin 的同一变换 + 一段补偿平移」，origin 按 `t3.origin` / 缺省 50% 计。
  2. **不能挂在 `.typo-box` 动画层上**：CSS 动画的 `transform` 优先级高于内联样式，
     `target:'box'` 的动画一跑就把视差顶掉。挂在外壳上则动画与视差各自占一层。
  3. **`A_d` 必须是相似变换**（uniform scale + rotation + translation）：`screenFrame`
     靠它把元素框当成「仍然是一个旋转矩形」，命中 / 选择框 / 手势逆变换
     （`inverseParallax`，就是「除以 s、反转 φ」）都依赖这一点。换成一般仿射矩阵
     会静默给错答案。
  4. **镜头不改变图层矩形**：位图永远覆盖 `doc.size`（`drawSizeFor` 的契约），
     被视差推出画布的内容由画布边缘裁掉 —— 那就是「出画」。想让它变宽是另一个
     功能（要动 placement），别在 `rasterSizeFor` 里偷偷放大。
  5. **超采样封顶 2×**：`cameraDensity(doc)` = 「被放大的最多那一层」的倍数，
     钳到 2（策略在 `camera.ts::rasterDensity`，纯函数 + 单测：**播放中降 1、
     导出 / 一次性烘焙永不降**，最后按 `rasterEdge` 夹）。40× 的镜头若按
     40× 密度烘，1080p 一帧是几十亿像素；超出部分交给 GPU 放大（只糊到 2× 以内）。
     密度由后端 `shrinkCanvas` 缩回目标尺寸 —— **不能把 2× 位图交给合成器的双线性
     采样**：位图是直通 alpha，透明处 rgb=0，降采样会在字形边缘糊出一圈暗边。
     反过来说：全 depth 0 时密度恒为 1，位图尺寸与缓存键都逐字不变。
     **任何新的「预览降质」开关都加进 `rasterDensity`**（带 `exporting` / `oneShot`
     分支），别在 `resolve` 里另写一个 `if (playing)` —— 分家的形态是「导出跟着降」。
  6. **缓存键里 camera / depth 不进 `docHash`**（`cache-key.ts::hashableDoc`）。
     它们的效果由 `parallaxSignature`（逐元素的 s / φ / t / origin）表达：没有元素
     吃镜头时摘要为空 ⇒ 键与没有镜头逐字相同，拖 zoom 不会白白击穿每一层。
     镜头**不**让静态文档变成逐帧重渲（它是静态构图参数，同一 t 永远同一张图）。
  7. **组合外壳用「离镜头最近的成员」的 depth**（`groupDepthOf`）：底板只有一个，
     取平均谁都贴不上，取 0 会出现「文字飞走、框留下」。
  8. 富文本块**整体一个 depth**，块内不拆 —— 要分层就拆成多个文本元素。
  9. 已知取舍：多选且各元素 depth 不同时，手势按**指针下那一层**的视差换算
     （元素之间保持刚性）；同一 depth 的多选完全精确。选择框 / 命中用的是
     `editorState.screenRects` + `screenFrame`（不是 `frame`），否则「镜头放大 2×
     就点不中自己看得见的东西」。
  10. **镜头可以有关键帧，但走的是另一条求值路径**（`camera-tracks.ts`）：
     `doc.animations` 里的 `TracksAnimation`（`prop` = `camera.x|y|zoom|rot`）是
     文档级轨道，**不发射 CSS**（`animationStyleSheet` 只遍历元素），求值在 JS 里
     同步做：`cameraAt(doc, localSec)` → `mergeCamera`（夹取只在那一处）。
     元素动画是 CSS + WAAPI seek，镜头是纯函数采样 —— 因为命中测试、手势换算、
     光栅密度都要在**这一帧立刻**知道取景，等不到浏览器把动画跑完。
     **有帧的通道以轨道为准**，`doc.camera` 只是其余通道的基准值。
  11. **`withCameraAt(doc, localSec)` 是渲染侧唯一入口**（舞台 / 光栅化 /
     命中测试）。没有生效轨道时它**原样返回入参**（每帧复制文档是隐形的税）；
     有轨道时返回浅拷贝（`elements` 共享）—— 视图对象**绝不回写**。
     逐段缓动必须与 CSS 同一套语义（`easeProgress`：关键字 / cubic-bezier /
     `steps()`），否则「面板上画了曲线、画面匀速走」。轨道缺省 `easing` 是
     **linear**（元素轨道是 ease-out）：整条写进来的关键帧列表默认就是匀速。
  12. **空轨道不算动画**：`docIsAnimated` 只看有帧的轨道，`cache-key` 的
     `hashableDoc` 也把空轨道滤掉 —— 面板上那四条常驻属性行不该让一张标题卡
     变成逐帧重烘。反过来，镜头动画会让**帧号进缓存键**（`parallaxSignature`
     逐帧不同，`docHash` 跨帧恒定 —— 时间不改变文档身份）。
  13. `iterations` / `target`（box / content）对镜头轨道**没有意义**：JS 采样不读
     它们。面板上也把循环开关与作用层对这两行隐藏了。
- **元素阴影用 `filter: drop-shadow()`，不是 `box-shadow`**（`document.ts::ElementShadow`
  + `css.ts::elementFilter`）。`box-shadow` **有** `spread`（能「调大小」），但它永远投
  元素的**边框盒**：星形 / 圆环得到一块方影子，裸文字（没有文本框背景）会把整块框影出来。
  实测（`.codebuddy/tmp/2026-10-21/shadow-spread.mjs`）：星形 + `box-shadow:0 0 0 10px`
  时框角 `(36,36)` 是纯黑；`drop-shadow` 同一位置是透明白。
  **`drop-shadow()` 没有 `spread`**（规范只允许 `offset-x offset-y blur? color?`）：
  写 `drop-shadow(0 0 0 10px)` 不是「忽略多出来的那个长度」，而是**整条 `filter` 失效**，
  computed 值退回 `none`（同一个脚本量的：`filter=none`，一点影子都没有）。
  1. **filter 链是复合的**，不是并列：`drop-shadow(a) drop-shadow(b)` 里 b 会把
     「元素 + a 的影子」一起再投一次（实测：dy=20 叠两次，影子从 `[40,100)` 延伸到
     `[60,120)`；`box-shadow` 两条并列则不会）。后果：**面板上第 N 层阴影也会给前 N-1 层
     再投影** —— 加一层会同时加深前面那几层。别拿它去凑「加粗的描边」：那要多向 copy，
     层数随厚度线性涨，r=10 时 4 向在尖角处实测漏一格（8 向才补上，代价 8 个 filter pass）。
  2. 虚化与阴影**共用同一条 `filter`**，顺序固定 `blur() → drop-shadow(...)`（先糊再投影；
     反过来会把影子也糊掉，并在边缘留一圈亮环）。关闭时**写 `'none'`**（就地同步没有删除语义）。
  3. 挂在**元素外壳**上 ⇒ 投的是「整个元素」的影（含文本框底色 / 边框 / 图片）；
     按字形投影是 `TextStyle.shadow`（text-shadow）那条路，两者别混。
  4. `filter` 是分组属性：它会让 `transform-style: preserve-3d` 失效（跨元素深度排序本来
     也未验证）。设了阴影 / 虚化的元素不能指望与兄弟元素穿插，这与 3D 那一节的已知限制同源。
  5. snapDOM 对 `box-shadow` / `drop-shadow` / `blur` / `text-shadow` / `border-image`
     / `-webkit-text-stroke` 全部保真（`.codebuddy/tmp/2026-10-21/snapdom-effects.mjs`
     与同目录 `text-stroke.mjs`），所以这里是取舍不是限制。
- **描边分三条路，按对象选，别混**（这是被推翻过一轮的结论）：
  | 对象 | 用什么 | 入口 |
  |---|---|---|
  | 图形 | SVG `stroke`（真描边，有 join/cap） | `ShapeElement.stroke` |
  | 文本框那个矩形框 | CSS `border`（+ 渐变走 `border-image`） | `TextElement.boxStroke` |
  | **字形** | **`-webkit-text-stroke`**（一个宽度参数） | `TextElement.glyphStroke` |
  字形**不要**用多向 `text-shadow` 拼描边：`text-shadow` 没有 `spread`，层数随厚度涨、
  尖角漏、还不能单独调「线宽以外的任何东西」。`-webkit-text-stroke` 的代价是
  **描边居中**（半个宽度压在字形里 ⇒ 想外扩 N px 就设 2N；HTML 文字没有
  `paint-order: stroke fill`，那是 SVG text 的属性）。`-webkit-` 前缀没有标准替身，
  Chromium 认、其他引擎不认 —— 本项目已不做那两家适配（AGENTS §2），不写两份。
- **描边填充（渐变 / 纹理）有两个渲染出口，一份数据**（`Stroke.paint`，语义与
  `TextElement.fill` 同构：只有 linear / radial / texture 覆盖 `color`）：
  - 文本框边框 → CSS **`border-image`**（`css.ts::borderImageCss`）。必须写在 `border`
    简写**之后**（简写会把 `border-image` 复位），且 `border-width` 为 0 时什么都画不出来。
    **`border-image` 不吃 `border-radius`**（实测圆角处仍是方角）—— 文本框今天没有圆角字段，
    将来加的时候要先解决它。
  - 图形描边 → SVG `stroke="url(#…)"` + `<defs>`（`render-dom.ts::syncPaintDefs`，id 走
    `strokePaintDefId`，**不能与填充共用 id**：共用时后写的 `replaceChildren` 会把填充的
    `<defs>` 抹掉）。
  - 设了渐变 / 纹理就**不写 `stroke-dasharray`**、面板把线型置灰：`border-image` 那条路
    根本不支持线型，两条路给同一个开关不同结果才是真的糟。
- **文字阴影是数组**（多层，`TextStyle.shadow?: TextStyleShadow | TextStyleShadow[]`）：
  新数据一律写数组，老工程的单个对象在读的时候过 `textShadowList()` 归一化 ——
  仓库里没有文档解析的迁移钩子（工程里存的就是 `clip.source.doc` 原样），
  加新字段会让老工程的阴影静默消失。多层让「描边字」「霓虹」这类效果成为可能
  （单层做不到，`TEXT_SHADOW_PRESETS` 有现成的四向零模糊写法）。
  尺寸仍是**字号倍数**（`resizeDocument` 按比例缩字号，阴影跟着缩）；而元素阴影是
  **文档 px**（它跟着元素框走，不跟字号）。
- **字体按 face 而不是按族组织**（最小单位 `family + weight + style`）：一族只存一份字节的话，
  粗体只能由浏览器合成，而舞台用的是真正的 700 字面 —— 「预览是真粗体、导出是合成粗体」，
  字宽与笔画都不同，逐像素一比就是几万个像素。
- 字体**只存引用**（`FontRef`）：9 MB 中文字体 base64 进 `project.json` 会把工程变成
  不可用的大 blob。内置只有 OFL 的四族西文（Inter 无衬线 / JetBrains Mono 等宽 /
  Lora 衬线 / Outfit 装饰，各 400+700，只含 latin 子集，清单在
  `font-registry.ts::BUILTIN_FONTS`）；中文字体由用户自行导入或走本机字体。
- HarfBuzz 的 subset **只吃 SFNT（TTF/OTF）**，woff / woff2 走「原样内联」分支。
  四个 wasm 坑写在 `typography/font/subset-hb.ts`：`memory.buffer` 的视图会在 wasm 内存
  增长后 detach（每次用堆视图前都重取）、`hb_blob_get_data` 返回堆指针要先 `.slice()`、
  `HB_MEMORY_MODE_WRITABLE` 的源数据要最后才 free、遍历字形必须按**码点**（`.length` 索引
  会把代理对切碎）。
- **性能形状（改之前先看 `docs/typography-perf.md`）**：一次捕获 **13–30ms**，
  其中 **≈13ms 是空文档也要付的固定开销**（snapDOM 的 SVG/foreignObject 路线），
  内容只加 3–10ms；**分辨率与密度几乎不影响**（1280 与 1920 差 1ms，不是像素
  受限）。  所以「降画质省时间」是错的直觉，唯一有效的是**减少捕获次数**。
  动态文档每帧一次捕获 ⇒ 30fps 天花板，不要去优化 `buildDocDom` 或上传（各 ≤1ms）。
  **优化只能发生在捕获链的外面**（少捕获 / 少排队 / 文件级代理）。
  换掉这条链（自研 GL 渲染器、第二套排版子系统）**已被明确否决**（2026-11-06）：
  复用 HTML + CSS Animation + snapDOM 的全部价值就是不来维护一个 HTML 渲染引擎。
- **文档根必须显式写 `font-family`**（`css.ts::docStyle`，钉成 `DEFAULT_FONT_FAMILY`）。
  snapDOM 的 `embedFonts` 会把「被捕获子树里出现过的族」对应的 `@font-face`
  **内联成 data URL**；根不写字体时它继承宿主页面，界面字体栈（含 13 MB 的
  CJK webfont）就进了那份清单 —— **单次捕获 20 ms → 500 ms**，每帧都付
  （2026-11-06 换上 UI webfont 当天就中，表现为「排版编辑器突然变卡」）。
  推论：大字体**不要挂到会继承进排版文档的地方**；这条只有耗时看得出来，
  画面完全正常。守卫在 `tests/unit/typography-css.test.ts` 的 docStyle 一组。
- **A0/A1/A2 已落地（2026-11-06，实测单帧 −24~33%、播放期 rAF +60~80%，见
  `docs/typography-perf.md` §6）。三条各自都有「改坏了不报错」的形态**：
  1. **`dom-snap` 用 snapDOM 的 `cache:'soft'`** ⇒ 单次捕获便宜约三成。前提是
     **换字节必须换 URL**（`image-assets.ts::putImageAsset` 每次 revoke 建新的）：
     它的 image / resource 表按 URL 做键，URL 稳定而字节变了就会吐回旧图。
     `tests/e2e/typography-image-fx.spec.ts` 的「同一 assetId 换字节必须重烘」钉着
     这条（把 `putImageAsset` 改成复用旧 URL → 变红）。想把排版图片换成稳定的
     `artmatic-asset://` URL 之前，先想清楚这条。
  2. **预览的异步烘焙同一层只留一单**（`runtime.ts::schedule`，槽位 =
     `片段 id|位图尺寸`）。播放时每帧一个新精确键，不去重就是「每帧排一单、
     队列一路涨」，主线程被注定被丢弃的捕获占满。槽位**不能改用缓存桶**
     （`sizeKeyOf`）：同一份文档可以被两条片段各用一次（复制出来的标题卡，起点
     不同、时间重叠），同桶不同帧 ⇒ 一层会显示另一层的那一帧。
     `inflightSlots` **只给预览**：导出的 `bakeNow` 不许去重 —— 跳过一单就是那一帧
     真的没有。读数看 `stats().pending`（去重后稳定在层数量级，不会一路涨）。
  3. **超采样在播放中降为 1**（`camera.ts::rasterDensity`）。导出与
     `rasterizeOnce`（「转为图片」的产物会被当素材反复看）**永不降**。
  `stats()` 因此多了两个读数：`rasters`（累计完成的捕获数）与 `pending`（在飞单数）；
  排版唯一的性能量是「捕获次数」，没有读数就只能靠「卡不卡」猜。
- **光栅化缓存键 = `docHash | WxH | frame | 模式盐 | 逐帧盐`**。后两段的分工是硬约束
  （2026-11-05 踩出来的）：**模式盐**（脚本 / 插件钩子开关）跨帧恒定，它决定
  `runtime.ts::sizeKeyOf` 的「缺帧回退桶」；**逐帧盐**（镜头视差 + 超采样密度）
  每帧都可能不同，**必须单独成段、不进桶** —— 并进模式盐就是每帧一个新桶，
  `latest` 永远没有可回退的上一帧，表现是「有镜头关键帧的排版播放时整层消失、
  偶发频闪、暂停又正常」。任何「只有一部分帧才变」的新键成分都走第 5 段。
  `docHash` **只哈希 `clip.source.doc`**，
  不掺 `store.version` —— 否则改一下无关片段的名字就把所有排版缓存击穿了。
  **静态文档（`docIsAnimated === false`，含「有脚本但总开关关着」）的帧号是 `null`** ⇒ 尺寸相同就永远命中同一条缓存
  （带帧号会让一张标题卡每帧重做一遍，而且**看不出来**，只是慢）。
  **默认不做预烘焙 PNG 序列**：1080p 一帧 RGBA = 8.3 MB，150 帧 = 1.24 GB；逐帧按需光栅 +
  LRU 常驻只需 1–2 张纹理。内存预算按机器派生（`limits.textRasterMB` / `rasterEdge`，
  见 `core/capacity.ts`），条目上限是兜底，真正的不变量是「不许淘汰这一帧在屏的层」。
  **带镜头时单张位图可以按 2× 密度烘**（4× 字节），但目标边长仍 ≤ `rasterEdge` ——
  `runtime.ts::densityFor` 把密度按剩余边长夹过，所以截图也永远不超过它。
- **纹理上传方向**：`VERT_QUAD` 里 `vUv = aPos*0.5+0.5`，v=0 是**底部**；而 `texImage2D`
  默认把图像首行放到 v=0。所以排版纹理上传必须 `UNPACK_FLIP_Y_WEBGL = true`，否则文字
  上下颠倒（`tests/e2e/typography-export.spec.ts` 有方向断言钉着）。
  ⚠️ **`UNPACK_FLIP_Y_WEBGL` 对 `ImageBitmap` 源在 Chromium 上被忽略** ⇒
  图片 / 视频的上传源统一成 **canvas**，翻转在 `SourceManager.uploadImage` 一处定义。
- **图片元素的抠图 / 四角是 CPU 处理的**（`typography/image-fx.ts`），不能像片段那样
  交给 GPU：抠图必须逐像素，四角重采样要控质量（与 `placement.frag.ts` 逐点对拍），
  而排版渲染成 DOM，没有 placement pass 那个可编程采样点。三条实测结论：
  1. **CSS 3D 变换在 snapDOM 里是保留的**（2026-10-21 重测 3.2.0：裸 div 的
     `perspective` / `rotateY` / `rotateX` / `translateZ`、真实 `.typo-doc` 嵌套
     （`contain` + `isolation` + `overflow:hidden`）、用四角单应写的 `matrix3d`、
     `<img>`、文字、外层 `scale()` —— 全部正确出图）。**旧注释「snapDOM 会丢
     `matrix3d`」是误判，已删**；当时看到的现象另有原因（未定位）。
     复现脚本在 `.codebuddy/tmp/2026-10-21/`。跨元素 `preserve-3d` 的深度排序
     **仍未验证**。抠图 / 四角仍走 CPU，所以有 `key` 或非恒等 `quad` 的图片元素
     内容节点是 `<canvas>` 而不是 `<img>`（`render-dom.ts::buildImageNode`）——
     这是逐像素处理的要求，不是 3D 的要求。
  2. **处理是异步的**（要等图片解码）。舞台未就绪时先显示**原图**、完成后靠
     `BuildDocOptions.onImageFxReady` bump 一次 version 换节点；光栅化那条路
     **必须 `await ensureDocImagesFx()`**（`dom-snap.ts`）—— 不等的话截图拿到原图，
     而那张图会按正确的缓存键存下来，表现成「导出没抠图且永远不恢复」。
  3. **缓存键 = URL | 位图尺寸 | fit | crop | key 参数 | quad**（`fxKey`）。恒等 quad
     与「没有 quad」同键（两者都走 `<img>` + CSS，与引擎 `u_quadOn = 0` 同一判据）。
     拖动参数时按**元素串行 + 50ms 去抖**（`pump`）：不合并的话拖一下滑杆就是几十次
     1920×1080 的逐像素重算。
  4. **色键公式只有一份**：`core/image-fx.ts::applyKeyToRgba`，与
     `engine/placement.frag.ts` 逐字对齐。两套分家的形态是「排版里边缘发绿、
     时间轴上干净」，没有任何报错。
- **图片效果（色彩校正 / 重新着色 / 滤镜 / 边框）分两条路，按「要不要逐像素」选**：
  - **纯 CSS**：边框（`ImageElement.border` → `css.ts::imageStyle` 的
    **`box-shadow: inset`**）。用 `border` 会挤占内容盒 —— 加一条 20px 的边等于
    把图裁小一圈，而 PPT 的图片边框是画在图上的。`width = 0` 时必须显式写
    `none`（就地同步只 set 不 delete）。
  - **CPU canvas**：`adjust` / `recolor` / `filter`（`typography/image-effects.ts`
    是纯像素层，可单测）。顺序写死在 `image-fx.ts::renderFx`：
    **校正 → 柔化 → 锐化 → 滤镜 → 重新着色 → 抠图 → 四角**。换顺序会改变成品
    （锐化后再柔化 = 白干），所以不要在别处再排一遍。
  - **判空才算「没有效果」**：`adjustIsDefault` / `recolorIsDefault` 决定
    `imageNeedsFx()` 与 `fxKey`。留一个全 0 的 `adjust` 会让老工程凭空走进
    CPU 路径（画质与性能都变，而用户什么都没改）。
  - 带**空间滤波**（锐化 / 柔化 / 任何滤镜）时位图长边上限降到 **2048**
    （`MAX_EDGE_SPATIAL`）：`boxBlur` 每帧要开两块与位图同大的 scratch，
    4096² 是 67 MB/块。滤镜是风格化处理，2048 与 4096 肉眼无差。
  - **曲线是分段线性**（`curveLut` 的 256 项 LUT）且**两端各补一段**：
    首点在 0.3 时暗部按比例走到首点，不补的话整段暗部会被拉平。三次样条在
    两点之间会自己鼓出去，表现成「只提亮中间、暗部却更暗」。
  - **滤镜的噪点 / 故障必须用坐标哈希**（`hash01`），不许 `Math.random()` ——
    否则导出每帧都在闪（AGENTS §1.2）。17 个滤镜的名字在 `IMAGE_FILTERS`，
    文案在 `i18n/locales/zh-CN/ribbon.ts` 的 `rib.imgfx.*`。
- **图形的图片填充（`ShapeElement.imageFill`）是 `图片 + clipPath`，不是 `<pattern>`**：
  pattern 的坐标活在引用它的用户空间里，而自定义路径外面还套着
  `scale(w/100, h/100)`，图案会被非等比拉歪。结构固定为
  `<defs><clipPath id=…><path d transform/></clipPath></defs><image clip-path/>`，
  `<image>` 插在 `<g>` **之前**（图在下、描边在上）。有 `imageFill` 时路径的
  `fill` 被强制成 `none`（不透明填充会把图整个盖住）。**`syncImageFill` 必须在
  `syncPaintDefs` 之后跑** —— 那个函数会 `replaceChildren` 重建 `<defs>`。
  用户改填充方式（`setShapePaint` 带 `kind`）会清掉 `imageFill`。
- **两个测试钩子**：`FontRegistry.subsetting` 可关（退回整体内联），
  `tests/e2e/typography-font.spec.ts` 用它断言**子集 vs 全量逐像素零差异** —— 这是唯一能证明
  「子集化没有改动字形或度量」的测试。光栅化另有 `typoRasterize`（不经过 GPU）。
- **插入图标 = 插入 `ShapeElement(shape:'svg')`**（`typography/icon-shapes.ts` +
  `ui/typography/icon-library.ts` + `IconPickerModal.svelte`）。Lucide 的语义
  （无填充 + 圆头描边）正好落在 ShapeElement 的表达力里 ⇒ 描边色 / 线宽 / 混合
  这些既有控件插入后立刻可用，也不占素材表。图标 authored 在 24×24 而
  `shape:'svg'` 按 0..100 authored（见 `shapes.ts` 的 `scaleFrom100`），统一乘
  `100/24`，线宽用 `ICON_STROKE_WIDTH`（= 100/12）。三个会再咬人的坑：
  1. **多个图元的 `d` 不许拼成一条字符串再解析**：相对命令（`m` / `a` / `l`）的
     当前点在各自的 `<path>` 里从 `(0,0)` 起算，拼接后会接着上一条子路径的终点 ——
     图标整体错位几十个单位（`a-large-small` 这类以 `m` 开头的片段必中）。合并只能
     发生在**子路径层**：逐个图元 `parsePathNodes` → 合并 → `serializePathNodes`。
  2. **SVG `A` 命令的两个 flag 是单字符**，会与相邻数字粘连：`a7 7 0 011.412 7.872`
     里的 `011.412` 是 `0`、`1`、`1.412`。通用数字正则读成 `11.412` ⇒ 这组少一个
     参数 ⇒ **整条弧被丢掉且当前点不推进** ⇒ 后续相对命令全体错位。`path-ops.ts::tokenize`
     现在对 `A`/`a` 走逐字符扫描（这一处修好连带修正了布尔运算与顶点编辑的同类输入）。
  3. **图标数据必须分块，不要逐图标成 chunk**：1800+ 个 chunk 会让每次 `vite build`
     的 `prepareOutDir` 删除量顶爆开发机的批量删除保护（`[safe-delete]` 阈值 500），
     **第二次构建起必然失败**。`vite.config.ts` 的 `manualChunks` 按**首字母**分组。
- 图标清单 / 内容是 `import.meta.glob` 对 `@lucide/svelte` **源文件**的 `?raw` 懒加载：
  glob 的 key（= 图标名）在构建期静态解析，零打包成本；每个 `.svelte` 里有一行
  `const iconData = {...}` 由该包的构建模板写死。**升级这个包之后先跑
  `tests/unit/typography-icon-shapes.test.ts` 的全量守卫**（1800+ 个图标逐个转换、坐标必须落在
  0..100）—— 模板变了的话表现是「选择器里那一格是空的」，没有任何报错。
- **配色方案：颜色是「引用」而不是值**。`TextStyle.color` / `highlight` /
  `shadow.color`、`Paint` 的各个色、`Stroke.color`、`boxFill` / `boxStroke` 都可以是
  `@accent1`（或带明暗变体的 `@accent1.l80`），见 `typography/theme.ts`。这是
  「换配色方案 ⇒ 用了主题色的元素自动跟着变」的全部机制；从标准色 / 最近使用 /
  其他颜色进来的**裸 hex 不跟着变**，这就是「仅限于使用了配色的元素」。
  三条硬纪律：
  1. **一切颜色的渲染出口都要过 `resolveThemeColor()`** —— 全项目只有两个出口
     （`css.ts` 的 CSS 声明表 + `render-dom.ts` 的 `<defs>`）。漏一处的表现是
     「舞台上变了、导出没变」，而且不报错。
  2. `doc.theme` 是**可选字段**（缺省 = 默认方案），所以**它本身不抬 `SCHEMA_VERSION`**
     —— 与 `groups` / `Paint.opacity` 同一条约定。但**工程级**的两项抬过一次（见下一条）。
  2b. **`Project.typographyTheme` / `Project.customThemes` ⇒ `SCHEMA_VERSION = 6`**
     （5→6 恒等迁移）。自定义方案是**用户内容**：旧版静默忽略 `customThemes` 再保存
     等于把用户调好的那套颜色抹掉。解析顺序「自定义 → 内置 → 默认」，
     `sanitizeCustomThemes` 逐条校验、坏条目整条丢（缺槽 / 坏 hex / 撞内置 id），
     `validateProject` 里**绝不抛** —— 工程必须打得开。
     ⚠️ **凡是从 `doc.theme`（id）出发的解析，都要把 `Project.customThemes` 一起带上**
     （`themeById(id, custom)` / `resolveThemeColor(color, theme, custom)`）：漏一处
     的表现是「用了自定义方案的颜色回落成默认方案」，只在自定义方案上看得出来。
     调用点：`render-dom` 顶层两次（build / sync）、`ribbon-defs`、三个面板、
     `TypographyEditor`（舞台 + `textRaster.customThemes`，后者是**函数**式字段，
     切工程不能留上一份）。
  3. **明暗变体是实测标定的，不是「凭印象调亮度」**：三支规则（常规色走 OOXML 的
     `lumMod/lumOff`、纯黑纯白走固定灰阶、极亮色走亮度乘系数）的实测依据写在
     `theme.ts` 的文件头。改算法前先 `node scripts/extract-theme-colors.mjs analyze <取色卡截图>`
     对照 —— 常规色那 7 列的实测与预测是**逐通道误差 ≤ 1** 的。
- **文字高亮走 `--typo-hl` 自定义属性下发到行内段**，不是给 `.typo-text` 上色：
  那个盒子是 flex 容器、撑满整个元素框，背景会连换行处的空白一起填满
  （看起来是「给文本框刷了底色」而不是「把字涂黄」）。背景**不继承**，所以元素级
  高亮只能靠变量传给每个 `<span data-run>`；行内覆盖则直接写 `background-color`。

---

## 画幅与上屏大小（`canvas-size.ts`）

- **画布尺寸 ≠ 上屏大小**。`doc.size` 是设计分辨率（元素坐标的 0..100 按它铺），
  上屏多大由**片段**的 `transform.sx / sy` 决定。改画布不改上屏占位，改上屏不改画布。
- **`fit: 'contain'` 会把画布等比放大**，所以**同比例改画布像素，上屏大小一点不变**
  （1920×1080 与 1280×720 都铺满）。用户看到「改了尺寸画面没变」时，先看弹层那行
  「画面上 W × H（pct% × pct%）」有没有变 —— 它才是实际占位。
- **占位读数的真源只有一份**：`footprintOf` 与 `runtime.ts::rasterSizeFor` 都调
  `engine/placement.frag.ts::drawSizeFor`。别在 UI 里另算一遍（改了 GLSL 就会和画面打架）。
- `withLockedAspect` 锁的是**当前画幅**（不是 16:9 常量），`sizeForRatio` 的 `project`
  预设读 `project.width/height`（工程设置改了它跟着变）。
- **「缩放内容」是两个动作，别做成一个**：关 = 只改 `doc.size`，元素留在原像素位置
  （视口变了，构图跟着挪）；开 = 过 `resizeDocument` 按比例重排（构图保持）。

---

## 布尔运算与拆分（`path-ops.ts`）

- **所有运算都在文档坐标的 MultiPolygon 上做**，结果经 `multiToShape` 归一化回
  0..100 authored。旋转不参与（见 `shapeToMultiPolygon` 的注释）；差集的被减数是
  **数组第一个 = 最底层**（Illustrator 的 Minus Front / Figma Subtract 口径）。
- **拆分（`dividePolygons`）不是异或**：xor 给的是「一块带洞的形状」，拆分要「每个
  面一个对象」。实现是**增量切分** —— 每加入一个图形，把已有面切成相交 / 不相交
  两份，新图形净增的部分另起一块；不是枚举 2^N 个子集。返回的 `top` 是覆盖该面
  的**最上层**操作数，动作层按它取填充 / 描边（重叠区跟顶层走，A 独有的部分
  不会被染成 B 的颜色）。
- **结果字段统一走 `booleanResultFrom`**：几何身份（`pathUnit` / `clipFrame` /
  形状参数 / 动画）全部重置；布尔清 `groupId`，拆分**保留**（每片有明确来源，
  留在原组里才不会「拆完跑出组」）。⚠️ 拆出的相邻片各自带描边 / 阴影时，接缝
  处会出现**双线 / 叠影** —— 它们已经是独立对象了，这是拆分的固有代价，不是 bug。
- **拆分一次产出多个元素**：全部选中、一笔撤销；结果为空时不写文档，只 flash。
- **图标 `squares-divide` 是自绘的**（Lucide 没有这个形状）：两片 L =
  `squares-subtract` 的实线部分 + 它旋转 180° 的副本，中间一个空心方 = 被切出来
  的重叠区。三块之间必须留缝，否则 16px 下与 `squares-exclude` 糊成一团。

## 文字转路径（`text-outline.ts` + `font/outline-hb.ts`）

入口是「开始 → 路径 → 文字转路径」（只在选中文本时出现）。产出是一组
`ShapeElement`：文本框底色 → 高亮 → 字形（按颜色分桶）→ 下划线 / 删除线。

- **布局归浏览器、轮廓归 HarfBuzz，两边都不许自己发明**：位置逐字符用
  `Range.getClientRects()` 量（换行 / 对齐 / 两端对齐 / 字距 / 行内字号全都
  自动对）；轮廓走 `Font.glyphToPath`，字体字节与光栅化是**同一份**
  （`FontRegistry` 的 face）。基线 = `rect.top + ascent × size / upem`
  （实测 Chrome 的字符矩形就是字体的 ascent..descent 一段）。
- **`pathUnit: 'px'` 是必须的，不要改回 0..100**：文本框通常是几百乘几十，
  回到 authored 空间会被 `scale(w/100,h/100)` 非等比拉伸，描边变成「一边粗
  一边细」。`clipFrame: true` 同理 —— 文本框本来 `overflow: hidden`，
  不裁的话溢出的字形 / 描边会在转换后突然冒出来。
- **`pathUnitScale()` 是唯一的坐标系换算处**（`shapes.ts`）：渲染
  （`shapeGeometry` 的 `scaleFrom100`）、布尔运算（`shapeToMultiPolygon`）、
  顶点编辑（`NodeEditor`）与手势写回（`gestures.ts::toAuthored`）都从它取
  比例。新加一条碰 `ShapeElement.path` 的路径时必须过这里。
- **本机字体不用导入**：注册表里没有的族会走 `local-fonts.ts` 的
  `resolveLocalFont` → `FontData.blob()`，System Fonts 的字节就是这么来的
  （Chrome / Edge 桌面版的 Local Font Access；Electron 宿主已放行 `local-fonts`
  且页面跑在 secure 的 `app://` 上）。实测第一个 `queryLocalFonts()` 要枚举整机
  字体（3 秒），之后 Chrome 自己缓存到 1ms；`convertTextToPath` 会先 flash
  一句「正在读取本机字体」，别删。**拒绝授权** / **本机没有这个字重** / **根本
  没这个字体**是三种说法（`local-denied` / `local-missing` / `no-font`），
  下一步动作不同。字节只放内存（LRU 4 条，CJK 一条十几 MB），**绝不进工程**。
- **变量字体按 `wght` 轴实例化，不判成合成粗体**：`FontData.style` 只写
  `Regular`/`Bold`，看不出一个字体是不是 VF，所以用 `font/sfnt.ts` 直接读
  `fvar` 判断有没有 `wght` 轴。有轴 → `glyphFaceFor(bytes, weight)` 调
  `setVariations`（缓存的第二层键也要带 `wght`，否则 400/700 会拿到同一个
  实例）；没有轴又要 600+ → 浏览器是合成粗体，**拒绝转换**。合成斜体没有对应
  的轴（`slnt` 不等于 CSS 的 italic），一律拒绝。
- **HarfBuzz 只认 SFNT**：每套内置字体因此同时提供 `*.ttf`（由同名 woff2
  **无损解压**，`pnpm run fonts:sfnt` 重新生成）与 woff2（E2E 当用户字体用）。
  新增内置字体 = 往 `public/fonts/` 放 `<family>-latin-<weight>.woff2` → 跑
  `pnpm run fonts:sfnt` → 在 `BUILTIN_FONTS` 加一行 → 更新 `public/fonts/OFL.txt`
  与 `CREDITS.md`。
  用户导入的 woff2 拿不到轮廓（`sfntBytes` 返回 null），会落到本机字体查询，
  再失败才拒绝 —— 提示里让用户导入 TTF/OTF，绝不能转出半个字形。
- **界面字体的族名必须是别名**（`app.css` 里叫 `Artmatic UI` / `Artmatic Mono`）。
  文档里存的是**真族名**（`fontFamily: 'Sarasa Gothic SC'`，本机装了就直连本机字体），
  而 CSS `@font-face` 的族名会**盖过**同名本机字体 —— 一旦同名，文档引用这个族时
  snapDOM 就把那条 **13 MB** 的 face 内联进每次捕获（实测 20.8 → 513.9 ms/帧，
  导出同样）。别名之后两条路彻底分开：界面用别名，文档用真名/导入字体。
  新增界面字体时**继续用别名**；给文档加中文走**导入字体**（`FontRegistry` +
  HarfBuzz 子集化，KB 级）。
  字体里没有那几个字（默认中文占位文本 + Inter 就是这种）走 `missing-glyphs`，
  说法与「字体读不到」分开：前者要换字体，后者要导入字体文件。
- **不做整形（不调 `hb_shape`）**：位置全来自浏览器，逐字符只取
  `nominalGlyph`。代价是连字 / 上下文替换按单字绘制（位置仍然对），阿拉伯 /
  印度系这类需要整形的文字不在支持范围。竖排（`writing-mode: vertical-rl`）
  同样拒绝：矩形是旋转的，基线方向没有实测依据。
- **一个文本元素可能变成多个图形**：行内多色按解析后的颜色分桶，各出一个
  `svg` 图形；有文本框底色 / 边框时再加一个 `rect`；每个高亮颜色一组矩形；
  产物 >1 且源元素本来不在组里时包一个 `padding: 0` 的组（默认 8 会让选择框
  凭空大一圈）。动画 id 逐个换新，否则 `bake-animation` 的按 id 索引会串味。
  ⚠️ **拆成多层之后 `opacity` / 混合模式是逐元素生效的**：重叠处（文本框压在
  字形下面、或两层阴影）与原来的「整块一次性合成」不完全等价；单层字形
  （没有底色 / 高亮 / 多色）时逐像素等价。
- **下划线 / 删除线的尺寸是实测的，不读 `post` 表**：Chrome 的
  `text-decoration-thickness: auto` 恒为 **0.1em**，下划线位置恒为基线下
  **0.05em**（Inter 的 `post.underlinePosition` 是 -0.17em，照抄会低 10 多像素）；
  删除线位置才读字体的 `OS/2 yStrikeoutPosition`（Inter 671/2048，实测吻合）。
  取数脚本在 `.codebuddy/tmp/2026-10-21/underline-rule.mjs`；改这里先重跑它。
- **`TextStyle.shadow` 映射到 `ElementShadow`**（字号倍数 × fontSize → px），
  顺序是「文字阴影在前、元素阴影在后」：`filter` 链里后面的会连前面的影子
  一起再投一次。多层阴影的复合观感与 CSS `text-shadow` 不完全等价（见
  元素阴影那节的实测）。**阴影要按角色分**：文字阴影 + 元素阴影只给字形 /
  装饰线；文本框底色与高亮只带元素阴影 —— 否则文本框会凭空长出一圈文字阴影。
- **wasm 懒加载**：`import('harfbuzzjs')` 在第一次转路径时才发生，Vite 会把
  `harfbuzz.wasm` 作为独立资产产出。`vite.config.ts` 把该包**排除出
  optimizeDeps**：预打包会把它挪进 `.vite/deps/`，emscripten 胶水按
  `import.meta.url` 找同目录 wasm 时就是 404（dev 侧实测）。

## SVG 素材生成器（`src/typography/svg-gen/`）

22 个程序化生成器（一期 20 + 二期 motif / contour），对外只有一条契约：
**纯函数** `build(params, seed) => { d, evenOdd?, strokeOnly?, commands }`。

- 坐标 authored 在 **0..100 × 0..100**，走既有的 `shape:'svg'` + `scaleFrom100` 通道；
  插入后就是普通 `ShapeElement`，填充 / 描边 / 混合 / 动画 / 导出全部白拿。
- **随机只能来自注入的 `seed`**（`core/prng.ts`）。不许 `Math.random` / `Date.now` / DOM ——
  否则「同参数同种子复现同一张图」这条唯一的承诺就没了。
- 图元 IR（`prims.ts`）是 `d` 的**唯一序列化出口**。不要在生成器里拼字符串：
  相对命令的当前点会串味、`A` 的 flag 会与数字粘连、闭合带另起 `M` 会让 evenodd 自我抵消。
- `commands` 必须是真实命令数（序列化时数出来的），`GEN_MAX_COMMANDS = 3000`；
  超了只 `console.warn`、**不改用户参数**（静默降档的表现是「拖到最大却没变」）。

### 数据模型

- `ShapeElement.evenOdd?` + `ShapeElement.gen?`（`{ id, seed, params }`）都是**可选字段**，
  不抬 `SCHEMA_VERSION`（与 `groups` / `doc.theme` 同一条约定）。
- **渲染只读 `path`**，不重算；改参数时在 `actions.ts::rebuildGen` 里重算并写回。
  这样 `docHash` 只在真变化时改变，光栅化缓存口径不变。
- `gen.params` 存的是**合并默认值后的全量值**：工程文件不会因为将来改了默认值而静默变样。
  读旧档 / 外来数据时 `mergeParams()` 会补缺键并归一 checkbox。
- 未知 `gen.id` → 属性面板降级隐藏、路径照常渲染、不抛错。

### 五条会再咬人的坑

1. **`evenOdd` 必须一路透传**（`ShapeBox.evenOdd` → `shapeGeometry('svg')` → `render-dom` /
   `path-ops`）。漏一处的表现是「环 / 刻度盘 / 嵌套框全变成实心块」，不报错。
2. **开放样条不能对邻点取模**。取模会让首点的前驱变成末点，端部切线反向、曲线甩出盒外
   （实测 -15，盒是 0..100）。`serializePrims` 的 `at()` 已按 close/open 分开处理。
3. **闭合带的下沿必须 `L` 接上**，不能另起 `M`（evenodd 会把带子算成两片互相抵消）。
4. **嵌套环带是两条子路径**（外框一条、内框一条）。把内框顶点接在外框后面是一个自交
   多边形，evenodd 会在连接处涂出蝴蝶结。
5. **坐标必须留在 0..100**：越界会撑大包围盒，选中框、布尔运算、光栅化区域跟着错。
   生成器里的夹取（抖动、外沿、溅点扩散）是硬要求，不是审美。
6. **marching squares 的 16-case 表要按位核对**（`defs/contour.ts`）。两处会静默出错：
   ① 鞍点（5 / 10）的配对必须**绕着单个角**走，写反就把线连到对角线方向；
   ② 「只有一个角在下」的三组（11 / 13）最容易把孤立角认错 —— 后果不是报错，
   而是插值被夹到 0/1、端点全部落在格点上，等高线断成一截一截的虚线。改表后
   先跑 `tests/unit/svg-gen.test.ts` 里的「等高线不出盒」与命令数守卫。
7. **环带的内圈必须反向绕向**（`prims.ts::band` 已按此发出）。两个后果：
   - `nonzero` 下「外圈顺时针 + 内圈逆时针」才是环，同向会变成实心圆盘；
   - **多个图形互相重叠时要走 nonzero**（刻度盘的刻度与环），交集是**并集**。
     走 evenodd 的话重叠处会被挖空 —— 刻度穿过环的那一段直接消失（用户报过）。
     反之，靠 evenodd 挖洞的生成器（`rings` / `perspective`）必须保证子路径**不重叠**。

### 脱离规则

「转为路径」与「进入顶点编辑」对生成器元素 = **清掉 `gen`**（路径已是烘焙结果），
元素退化成普通 svg 路径。不清的话，用户手改的节点会被下一次参数改动**静默覆盖**。

### 加一个生成器

1. 在 `defs/<group>.ts` 里写 spec（`params` 用 `shared.ts` 的工厂，区间按「最坏组合
   ≤ 3000 命令」调）；
2. 在 `registry.ts` 的 `SVG_GENERATORS` 与对应组数组里登记；
3. 文案进 `i18n/locales/zh-CN/typography.ts`（`gen.<id>` 与复用的 `gen.p.*`），
   **数据表只存 `labelKey`**；
4. `tests/unit/svg-gen.test.ts` 会自动扫到它（注册表驱动），不需要逐条加测试。

---

## 文档脚本（`script/`）

`TypographyDocument.scripts?: TypographyScript[]` —— 文档级、每帧求值的 JS 表现层。
硬约束的落点（违反任一条都会静默出错）：

- **默认不运行**：总开关是 `UiPrefs.runTypoScripts`（false）。关闭时不执行、
  画面与「没有脚本」逐像素相同；`docIsAnimated(doc, false)` 也返回 false
  （否则一张标题卡会每帧重烘）。
- **缓存键必须带模式盐**：`docHash|WxH|frame|s{0,1}h{0,1}`。没有盐时切换开关会
  直接命中旧图（表现是「打开了脚本，画面没变」）。`runtime.ts::sizeKeyOf` 不能用
  `lastIndexOf('|')` 切 —— 切出来的是「某一帧」，缺帧回退会失效。
- **回滚日志，不是整层快照**（`script/baseline.ts`）：整段写回 `style.cssText` 会
  打掉 `syncDocDom` 每帧写的内联样式。只记自己改过的属性/属性名，且回滚前比对
  当前值是否仍是自己写的。
- **脚本层永远是内容之外的一层**（`shell > .typo-anim* > .typo-script > content`）：
  外壳 transform 被 `frame.rot` 占用、动画层被 CSS 动画占用，脚本再写会顶掉它们。
- **无状态**：同一 `t` 两次求值必须逐像素相同；倒退 seek 不累积。粒子/反应扩散
  这类需要累积的效果**不在支持范围**（要以闭式函数写，或未来接 sim 快照）。
  `Math.random` / `Date.now` / 定时器在编译期被遮蔽 —— 但这是确定性与误用防护，
  **不是安全边界**；真正的边界是默认关闭 + 界面告知。
- **`needs` 是结构预处理声明**：`'chars'` 生成逐字 span（inline-block ⇒ 断连字；
  编辑该文本时暂停），`'canvas'` 插 2D canvas（**WebGL canvas 在 snapDOM 里是空白**）。
  `needs` / `targets` / `editingId` 都进 `docSignature`，否则加完脚本舞台不重建。
- **校验前置、不进 doc 的诊断**：运行错误 / 耗时 / 超预算在
  `script/diagnostics.ts`（模块级表），不进文档（跑一下就脏工程）。
- **缓存淘汰必须保住「刚落地的那一条」**：光栅化是「先 upload、后 render」，
  `resolve` 要到 `renderFrame` 里才 `markLive`。导出期 `live` / `livePrev` 还停在
  前两帧上，若不显式保护 `justUploaded`，淘汰会把这一帧刚烘好的纹理当成最旧的
  删掉 → `resolve` miss → 排版层整层缺席（成片纯黑），而且还会再排一次光栅化。
  `evict(max, bytes, justUploaded)` 的第三个参数就是这条不变量。
- **`ensure(doc)` 是每次光栅化都调的**：字体 data URL 必须按「字形集键」缓存
  （`face.dataUrlKey`）。只缓存子集字节、每帧重新 base64 的话，woff2（不可子集化）
  或整量回退时每帧要付几十到上百毫秒 —— 带脚本的文档每帧都要烘，这一项会直接
  把导出拖慢一个数量级。
- **插件文档钩子**在 `hook-registry.ts`：三层阶段 `open` / `save` / `render`，
  输入冻结深拷贝、输出过 `coerceDocument`，**失败保留原文档**。

## 脱机媒体占位符（素材不存在时画什么）

- **「脱机媒体」占位符**：片段引用的素材**不存在**时，画面给一块暗红占位
  （`file-x-corner` 图标 + 「脱机媒体」），而不是静默跳过那一层（无声空白）。
  - 判据的**唯一实现**是 `appState.isAssetOffline(assetId)`：仓里没有字节**且**
    运行期没登记过 —— 两个条件都要查，只查仓子会把「导入中」误判成不存在，
    只查登记表会把「打开工程时文件读不到」漏掉。**「不存在」与「还没加载好」是
    两件事**：给后者也画占位符的话，正常加载会满屏闪暗红。
  - 三个消费方共用它：合成路径（`render-core` 注入 `sources.setAssetOfflineProbe`）、
    排版光栅化（`textRaster.isImageOffline`）、排版舞台（`TypographyEditor` 的
    `BuildDocOptions.isImageOffline`）。各判一次的形态是「时间轴上显示脱机、
    画布上却空白」。
  - 占位文字由宿主注入（`setOfflineLabel` / `offlineLabel`）—— `engine` 与
    `typography` 都不 import i18n。字形与颜色常量在 `core/offline-media.ts`
    （canvas 与 DOM 两个出口共用，各画各的会出现「时间轴上是暗红、排版里是玫红」）。
  - DOM 侧（`render-dom`）状态迁移**不走 `docSignature`**（素材就绪/消失不改文档
    结构签名），所以 `syncElement` 里用 `data-typo-offline` 标记就地换节点。
