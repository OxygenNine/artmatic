# src/core/ —— 纯 TS 内核

无 DOM / 无 WebGL，**必须可单测**。数据模型 · 曲线求值 · 命令栈 · 片段几何（clips）·
转场钳制 · prng · 颜色 · 位掩码 · 容量预算 · 四角单应（`quad.ts`）· 波纹删除几何（`ripple.ts`）·
手动节奏点（`beat-marks.ts`）。
它是**全局关键路径** —— 它定死之前不要写时间轴 UI。

**何时读我**：改 `core/**`；动**片段几何 / trim / 切分 / 重叠策略 / 关键帧 / 容量上限**；
动 `Project` 结构或 `SCHEMA_VERSION` 时。

相关：`src/engine/AGENTS.md`（合成求值 · z 序）、`src/timeline/AGENTS.md`（同一套策略在手势层的落点）、
根 `AGENTS.md` 的硬约束（时钟 / 随机 / 确定性 / 真相在磁盘）。

---

## 数据模型与求值

音频单独成轨。视觉轨道里混放画面来源与特效。

> 片段级的两个「图像处理」字段（`key` / `quad`，v7 起）见本节末尾 —— 它们**不是特效片段**，
> 而是 SourceClip 自己的属性（只作用于本层），实现全在 placement pass。

```ts
type Track = VisualTrack | SoundTrack        // 命名避开 WebAudio 的 AudioTrack

interface VisualTrack {
  kind: 'visual'
  id: string; name: string; enabled: boolean
  /** v15 轨道静音：只关内嵌音轨，画面照常。缺省 = 有声（音频轨没有这个字段）。 */
  muted?: boolean
  clips: (SourceClip | EffectClip)[]          // 同轨不重叠，按 start 排序
}
interface SoundTrack {
  kind: 'audio'
  id: string; name: string; enabled: boolean
  clips: AudioClip[]
  bus: 'master' | string
}

type AnyClip = SourceClip | EffectClip | AudioClip

interface ClipBase {
  id: string; start: number; end: number; label: string
  fadeSec: number
  curves: Record<string, Curve>               // 参数名 → 关键帧曲线
  mods?: Record<string, ModSlot[]>            // v20 参数名 → 调制槽（与 curves 共用键空间）
}

/** 有画面来源，参与合成。被特效影响的就是它。 */
interface SourceClip extends ClipBase {
  kind: 'source'
  source:
    | { type: 'video';    assetId: string; srcIn: number; speed: number }
    | { type: 'image';    assetId: string }
    | { type: 'algo';     generator: GeneratorId; params: Record<string, unknown> }
    | { type: 'text';     doc: TextDocument }
    | { type: 'solid';    color: string }
  blend: BlendMode
  opacity: number
  transform: { x: number; y: number; sx: number; sy: number; rot: number }
  fit: 'contain' | 'cover' | 'stretch'
  /** 简易抠图（色键）。缺省 = 不抠；只作用于本层 alpha。见下面的「片段级图像处理」。 */
  key?: KeySettings
  /** 四角调整（透视变形）。坐标在**层空间**：默认四角 = 单位方的四个角。 */
  quad?: QuadCorners
  /** v13 片段两端的转场（见 `core/transitions.ts`）。另一侧没有邻居 = 全透明。 */
  transitionIn?: { defId: string; duration: number; values: Record<string, number> }
  transitionOut?: { defId: string; duration: number; values: Record<string, number> }
  /** v13 视频内嵌音轨设置。缺省 = 有声 / 0 dB / 不淡；分离音频时 `muted` 置 true。 */
  audio?: { gainDb?: number; fadeIn?: number; fadeOut?: number; muted?: boolean }
  /** v13 分离出来的音频片段 id。store 靠它做移动 / 裁剪 / 分裂的联动。 */
  linkedAudioId?: string
}

/** 无画面来源，把自己插进渲染链。所有特效都是它 —— 含摄像机 / 画幅 / OSD。 */
interface EffectClip extends ClipBase {
  kind: 'effect'
  chain: EffectInstance[]                     // 一条片段可携带一串效果，可拖拽重排
  /** 影响深度：只作用于下方最近的 N 条启用视觉轨；0 / 缺省 = 下方全部（见 `src/engine/AGENTS.md`）。 */
  affectDepth?: number
  /**
   * v11 绑定片段：链只跑在**这一个 SourceClip 的层**上（与 z 序无关）。
   * 与 `affectDepth` **互斥** —— 两者同时出现时 `validateProject` 以绑定为准丢掉深度。
   * 执行位置与边界见 `src/engine/AGENTS.md`。
   */
  boundClipId?: string
}

/** 声音事件，不参与视觉合成。 */
interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: string; srcIn: number
  gain: Curve
  /** v8：编排用的淡变（秒）。与 fadeSec 复合，求值见 core/audio-envelope.ts。 */
  fadeIn?: number; fadeOut?: number
  /** v13：静态增益（dB，-60..+12）。与曲线 / 淡变相乘，求值仍只有一处。 */
  gainDb?: number
  /** v13 血缘与锁定：`linkedVideoId` 解锁后保留，`lockedTo` 非空 = 跟随视频。 */
  linkedVideoId?: string
  lockedTo?: string
}

/** v8：段落标记。标记，不是容器 —— 片段不归属它，它也不裁剪片段。 */
interface Section {
  id: string; name: string
  /** 秒。结尾 = 下一段起点（最后一段到工程末尾），所以不存 end。 */
  start: number
  color?: string
}
```

### 预剪辑范围与声音事件表（v13）

- `Asset.ranges` 是一组 `{ id, name, inSec, outSec }`，**秒落库、帧展示**；取整只有
  `core/preclip.ts` 一处（`normalizeRange` / `spanFromRange`）。别在 UI 里再写
  `Math.round(t * fps) / fps`。
- `Asset.activeRangeId` 决定双击 / 「+」插入哪个范围；失效时 `activeRangeOf` 回落到
  第一个（而不是悄悄插整段）。
- **谁出声只有 `core/audio-plan.ts` 一处**：独立 `AudioClip` + 未静音的 video
  `SourceClip`（`asset.hasAudio !== false`）。预览（`audio/player.ts`）与导出
  （`exporters/mixdown.ts`）都消费 `AudioSpan[]`，不要再各自遍历一遍工程。
- 视频音轨的解码在 `engine/video-audio.ts`（只解使用区间、按 assetId 缓存），
  不属于 core。
- **三种「不发声」在 `audioSpans` 里收口，别在消费方各判一次**（v15 补齐第三种）：
  `track.enabled === false`（整层不在）、`VisualTrack.muted === true`（画面留着、
  内嵌音轨不要）、`clip.audio.muted`（单条片段静音）。只有视觉轨有 `muted`：
  音频轨的 `enabled` 本来就是喇叭语义，两套开关描述同一件事会让导出只看其中一个。
  `videoAudioAssetIds` 必须跟着同一个判据 —— 漏了它只是「多解一段没人听的音轨」，
  但漏了 `audioSpans` 就是「静音了导出还有声」。

### 段落标记（`Project.sections`，v8）

- **只存起点，不存终点。** 「这一段的结尾」永远是下一段的开头；存 `end` 会立刻
  出现「相邻两段之间的缝算谁的」这种没有正确答案的问题，而且改 `Project.duration`
  时还得跟着修。
- **允许重叠 / 同起点**：它是标记不是轨道。排序稳定（同 start 保持原顺序），
  排序 / 清洗 / 吸附全在 `core/sections.ts`（纯函数、有单测）。
- **`sections` 在 `Project` 上是必填**：`validateProject` 把缺失 / 坏条目洗成 `[]`
  （逐条丢弃，工程必须打得开）。必填是为了让读取方不必到处 `?? []` —— 那正是
  「某处忘了兜底 → 时间轴整块空白」的来源。
- **切分而不是逐个新建**：`splitSection(id, t)` 只插一个新的起点（右半继承颜色）。
  因为段落只存起点，先标第一个点会把整首歌圈成第一段 —— 「在鼠标处切一刀」是
  顺序标记与事后补标记共用的那条路。
- **吸附点**：`snapTimeWithSections(t, mode, grid, sections, fps, beatMarks)` 在网格吸附的
  基础上，让「更近的段落起点 / 手动节奏点」赢（容差 = `snapToleranceSec`，半个吸附步长 /
  半帧）。**时间轴里凡是要吸附的地方都走它**，不要直接用 `snapTime` —— 那是「硬点参与了
  吸附」这件事的第二份真源。
- 与 `Curve.beatAnchor` 相反：段落**不锚拍**。BPM 改了它不该偷偷跳走（那是重排，
  不是跟着走）；吸附只发生在拖动 / 创建 / 切分的那一刻。

### 手动节奏点（`Project.beatMarks`，v21）

- **不是第二套拍网格。** `beatMarks` 是用户跟着音乐逐个点下来的秒数（升序、可不等距），
  只参与吸附与显示；`beatGrid`（BPM / offset / 拍号）仍然是等距拍、音频特征、
  `Curve.beatAnchor` 与 agent beat↔秒换算的唯一来源。**不要拿它算第 n 拍**，也不要在
  BPM 估算里读它。
- **必填 + 清洗**：`validateProject` 把缺失 / 非数 / 负数洗掉，按升序去重（1 ms 内合并），
  上限 `MAX_BEAT_MARKS`（两万）。纯函数全在 `core/beat-marks.ts`：`sanitizeBeatMarks` /
  `insertBeatMark` / `removeBeatMark` / `moveBeatMark` / `mergeRecordedMarks`。
- **录制语义在 UI 层**：从播放头起录时，起点之后的旧点随播放头走过而清除，只保留新点；
  起点之前的点不动。`mergeRecordedMarks(keep, notReached, recorded)` 是结算口。
- **节奏点的吸附容差有独立上限 `BEAT_MARK_SNAP_SEC`（100 ms）**，取它与
  `snapToleranceSec` 的较小者。直接用半拍容差会让 bar 档下（1 秒）整条轴被密集的点
  盖满，用户再也摆不到「不在点上」的位置。
- **写入口只有一条**：`ProjectStore.setBeatMarks(整表)`（一笔撤销）。不要给「增 / 删 / 拖」
  各写一个 store 方法 —— 排序之后下标会变，维护第二套身份只会引来悬空引用。

### 吸附档位（`core/time.ts::SNAP_MODES`）

- 表里有一档是**异类**：`frame` 的步长是 `1/fps` 秒，与拍网格无关。`snapTime` /
  `snapToleranceSec` 先按 `mode === 'frame'` 分支，**不要**拿它去乘 `beatDur`。
- 「哪些档位属于哪个时间轴形态」不在这张表里（那属于 UI，见
  `src/timeline/view-model.ts::SNAP_MODES_FOR`）；这里只保证每个档位的**物理含义**。
- 拍线位置 = `offset + b * beatDur`（`beatAtTime` 的逆）。**标尺与网格必须走
  `view-model.ts::xOfBeat`** —— offset ≠ 0 时漏掉它就等于线画在第 0 拍、吸附对齐到
  offset 之后的拍。

### 参数求值：只有一个入口（`core/modulation.ts::resolveParam`）

一个数值参数的值 = **曲线（或静态基值）→ 逐个调制槽**。这条路径有四个调用点
（`engine/stack.ts` 的 transform/opacity、`algos/runtime.ts` 的生成器参数、
`effects/runner.ts` 的 `<instanceId>.<key>`、`core/audio-envelope.ts` 的 gain），
**全部改调 `resolveParam`**：各写一份的形态是「某个参数在某个片段上不动」——
不报错，只能靠猜。

- 槽语义：`add` 是 `v += gain·m`，`mul` 是 `v *= mix(1, m, gain)`。后者不用直接相乘，
  是为了让 `gain = 0` 严格等于「不生效」。
- `ResolveCtx.clipStart` 由调用点各自定义：绝大多数是 `clip.start`，**音频 gain 是 0**
  （`curves.gain` 的键是绝对时间，历史如此）。
- 表达式（`core/expr.ts`）**全部闭式**，只依赖 `t` / `beat` / 种子；`modulator(id)` 成环
  求值为 0（写入口挡环，求值路径只兜底）。结果非有限时 `resolveParam` 退回基值 ——
  NaN 进 uniform 就是黑帧，且没有任何东西指向那条表达式。
- 悬空 `ref` 由 `validateProject` 清掉（`sanitizeClipMods`）。留着它的表现同样是
  「参数不动」，而界面上找不到原因。

### 音频包络（`core/audio-envelope.ts`）

`gain（经 resolveParam，含调制）× fadeSec × fadeIn/fadeOut` 只有一个求值处，预览（`audio/player.ts`）
与导出混流（`exporters/mixdown.ts`）都对着它。三条钳制规则：`fadeSec ≤ 片段长/2`
（两个淡区不相交）、`fadeIn + fadeOut` 超长时**按比例收缩**、片外返回 0。

### 片段级图像处理：`key` / `quad` / `crop`（`SCHEMA_VERSION` 7 / 10）

**它们不是特效片段。** 特效片段（EffectClip）是 adjustment layer，作用于下方所有轨的
合成结果；这三个字段是 SourceClip 自己的属性，只处理**这一层**，实现全在同一次
placement pass（`src/engine/placement.frag.ts`）。

- `key?: KeySettings` —— 简易抠图（色键）：`{ color, tolerance, softness, spill }`。
  按颜色距离把**本层**像素变透明（色度差为主、亮度差加权，见 placement 的文件头）。
  抠掉之后露出一层是什么，由普通合成决定（z 序下面的层）。
- `quad?: QuadCorners` —— 四角调整（透视变形）：`{ tl, tr, br, bl }`，每个角是 `[x, y]`。
  坐标在**层空间**：`(0,0)(1,0)(1,1)(0,1)` = 默认图层矩形四角（`fit` / `transform` 之后、
  透视变形之前）。这样它与 `transform` 的缩放 / 旋转**复合**而不是互相覆盖，用户先摆好
  图层再拉角依然成立。渲染用「单位方 → 四角」单应的**逆映射**采样（真透视，不是双线性
  拉伸）。四角退化到不可逆（三点共线 / 面积 0）时按「不调整」渲染 —— **不丢层**。
- `crop?: CropSettings` —— 裁剪（v10）：`{ left, top, right, bottom }`，每项是**该边被
  裁掉的源比例**（0..1，缺省全 0 = 不裁）。它**只收可见窗口、不改采样坐标** ——
  内容不缩放不位移，所以「把 16:9 裁成一条竖带」只能靠它（缩放 + 偏移做不到）。
  判定在**源 uv** 上，所以与 `quad` 的顺序无关；两条边之和必须 < 1（`isValidCrop`）。
  ⚠️ 与排版文档的 `ImageElement.crop`（`{x,y,w,h}` 源窗**铺满**元素框）**不是一回事**：
  那个的框是用户给的，片段这个的框由 `fit` 从源比例推出来，同一套语义会退化成放大。
- **UI 拖角与渲染采样必须共用同一份纯数学**：`core/quad.ts`（无任何运行时 import，
  E2E 也直接 import 它算期望值）。判定「恒等」只认 `isIdentityQuad()` —— 各写一份
  容差的表现是「手柄位置对、画面差半像素」这种没人会查的偏差。裁剪同理：
  钳制只在 `withCropEdge()`（写入口）与 `isValidCrop()`（打开工程）各一次。

- 6→7 是**恒等迁移**：两个字段都可选，抬版本号的唯一目的仍然是让旧版打开新版工程时
  走 `versionTooNew` 显式报错，而不是静默丢掉用户的抠图 / 变形设置（静默数据丢失）。
- **类型与默认值住在 `core/image-fx.ts`，不在本文件（schema.ts）里定义。**
  排版文档的 `ImageElement` 也有同样两个字段（见 `src/typography/AGENTS.md`），而
  `schema.ts` 已经 import 了 `typography/document.ts` —— 定义放在 schema 里会形成
  **运行时**循环（`defaultKeySettings` / `identityQuad` 是函数，不是类型）。所以：
  - `KeySettings` / `QuadCorners` / `defaultKeySettings()` / `identityQuad()` 在
    `core/image-fx.ts`（零运行时 import 的叶子），`schema.ts` 只 re-export；
  - `core/image-fx.ts` 同时是**色键 CPU 实现的唯一真源**（`keyKeep` /
    `applyKeyToRgba`）：GLSL（`engine/placement.frag.ts`）与排版图片元素都对着它。
    改公式必须三处同改（本文件只是说明，不参与运算）。

### 外部蒙版引用：`EffectInstance.inputs.mask`（v19，`core/mask.ts`）

**蒙版不是资源，是一次输入绑定。** 没有「蒙版实体」这种类型，只有三种引用：
`{ kind:'clip', clipId, channel }`（读另一个片段这一帧的样子）、
`{ kind:'asset', assetId, channel }`（读一张图片素材）、`{ kind:'none' }`（有过、现在空着）。

- 通道 `luma | alpha | r | g | b`，索引就是 GLSL 的 `u_channel`（`MASK_CHANNEL_INDEX`）。
- 挂在**实例**上而不是片段上：同一片段的两个模块可以吃不同来源。
- `kind:'none'` 与「没有这个字段」在渲染侧等价，但读回/撤销栈里不等价 ——
  删除被引用片段时**置 none 而不是删键**（`ProjectStore.clearMaskRefs`）。
- **环必须在写入口拒**（`maskRefCreatesCycle`）：渲染层遇到环只能给白图或者死循环，
  两者都不报错。依赖边有**两种** —— 引用边 `effect→目标片段` 与绑定边
  `source→绑在它上面的 effect`；只看引用边会漏掉「A 的链引用 B、B 的绑定链又引用 A」。
  深度上限 8 层，超了同样当作环（链太长本身就是渲染事故）。
- `validateProject` 那一趟（`sanitizeMaskInputs`）负责：坏形状删键、悬空引用置 none、
  成环的引用置 none、未知输入键删掉。与坏段落 / 坏配色同一条纪律：工程必须打得开。
- 复制 / 粘贴**不需要**修复引用：引用是外向的（片段 → 别人），不指向自己；跨工程粘贴
  产生的悬空引用由上面那一趟清。
- **UI**：检查器的蒙版来源下拉用同一份 `maskRefCreatesCycle` 过滤掉会成环的候选 ——
  列表里有、点了没反应，是最难被理解的一种交互。写入走 `setEffectMaskRef`（它会再判一次）。

---

## 重叠策略与结算时序

**同轨不重叠**，需要叠就加轨道。拖动策略是可配置项
`overlapBehavior: 'push' | 'reject' | 'trim'`（挤开 / 拒绝落点 / 吃掉邻居重叠部分），
默认 `'reject'`。reject 的语义是「落点非法就整次不动」，**不是**「钳在当前空档里」。

| 阶段 | 做什么 |
|---|---|
| `pointermove` | 只做**自由移动**（`liveMoveClip` / `liveResizeClip`）：片段跟着鼠标走、可压在邻居身上、跨轨也实时生效。**策略一律不动。** |
| `pointerup` | 调 `settlePlacement` / `settleResize` **结算一次**：push 挤开、trim 吃掉、reject 拒绝（非法则 `cancelTx` 整次手势作废） |

**片段剪贴板**（`core/clipboard.ts`，纯逻辑）：

- 载荷是自有 JSON：`{ kind: 'artmatic/clips', version: 1, clips: [{ trackId, clip }] }`。
  `start` **与 `end` 一起**归一成「相对第一个片段」（只搬 start 会把片段拉到另一个长度）。
- `parseClipboard` **永不抛**：非 JSON / 外来 JSON / 版本不对 / 片段形状不对一律 null
  （调用方必须整段放行，见 `src/ui/AGENTS.md` 的粘贴纪律）。
- 落点优先级：**复制时的原轨位** → 选中片段所在轨 → 第一条装得下的轨；一条都不行就
  跳过那个片段并说明（不静默丢弃）。同轨重叠的顺延/裁切**复用 `ProjectStore.placeInto`**
  （`addClip` 与 `pasteClips` 的唯一实现）—— 各写一份的形态是「从池里插会压邻居、
  粘贴却不会」。粘贴是**一笔撤销**，片段一律换新 id（留原 id 会让 `findClip` 找到源片段）。
- 跨工程 / 素材被删：`planPaste` 只打 `assetMissing` 标记，画面按「脱机媒体」占位符
  表现（见 `src/typography/AGENTS.md`）。**静默丢弃是更难查的坏法**（用户看到「粘贴了但什么都没有」）。

理由：策略若在 `pointermove` 里生效，trim 会在拖过去的瞬间毁掉邻居，拖回来也回不来。
拖动期间允许视觉重叠，落点非法时给红框预告（`appState.dragIllegal`）。

- **例外**：`resize` + `reject` 是单边钳制、非破坏性，仍然实时生效。`resize` 遵守全部三种策略。
- 几何层入口统一是 `placeSpan(干净 lane, 候选几何片段, duration, behavior)`。
  **lane 必须是干净的** —— 拖拽期间被拖片段已压在邻居身上，脏 lane 会让 push 的扫掠
  把锚点自己推走。
- **跨轨**兼容判据只有一条 `ProjectStore.canHost(track, clip)`（音频片段只进音频轨），
  拖拽与 `Alt+↑↓` 共用，不许各写一套。拖拽期间实时搬家 ⇒ 指针监听挂在 `window`
  而不是 `setPointerCapture`（元素会在两个 `{#each}` 块之间重建，捕获随之失效）。

---

## trim-in 与切分

**判据只有一条：起点动、终点也动 = 整体平移（`push` 挤开邻居），不动 `srcIn`；
起点动、终点不动 = 头部被裁 / 被拉长，`srcIn += Δ × speed`。**

实现是 `core/clips.ts` 的 `applyTrimIn` / `earliestTrimStart` / `trimInOf`。

| 场景 | 期望 |
|---|---|
| 拖片段中部 | 整体平移，`srcIn` 不变 |
| 拖左边界往右（裁掉 1s） | 长度 −1s，**`srcIn` +1s** |
| 拖左边界往左 | 只有在 `srcIn > 0` 时才能扩 —— 素材头部没有更多内容 |
| 视频 | 按 `speed` 折算：2× 的片段裁 1s 时间轴 = 素材 2s；**有速度曲线时是 ∫v**（见下节），不是 `Δ × speed` |
| `trim` 吃掉邻居的**头部** | 邻居的 `srcIn` 跟着进 |
| `push` 挤开邻居 | 邻居两端一起动 ⇒ `srcIn` **不能**动 |

**`splitClipAt` 是同一族的第三处落点**：右半段必须补 `srcIn += atRel × speed`，
否则切开后后半段从头重放。

## 波纹删除（`core/ripple.ts`）

删除后把**同一轨道**上起点落在被删区间之后（含贴边）的片段前移「被删长度」。
纯几何只有 `rippleShift(start, removals)` 一处，`ProjectStore.removeClips(ids, { ripple })`
在**同一笔提交**里删 + 补位（分两笔的话一次 Ctrl+Z 只回来一半）。

三条刻意的取舍：

- **只动被删片段所在的那几条轨**。轨道是图层，全轨一起前移会静默毁掉跨轨的卡点
  对齐 —— 那种偏差事后只能靠耳朵听出来。视频与它分离出来的音频各在各的轨上补位，
  两条都前移，同步仍然成立。
- **原有空隙不合并**：只扣掉被删掉的那几段长度，用户故意留的呼吸空间保持原样。
- **片段长度不变**：搬的是位置，不是裁掉内容。

开关是 UI 偏好（默认关），所以 `removeClips` 的 `ripple` 缺省 `false`；Agent 的
`remove_clip` 不读它（那是「这次怎么剪」的手感，不是工程内容）。

## 视频变速（`core/speed.ts`，v14）

**素材内时间 = `srcIn + ∫ speed`，不是 `srcIn + Δt × speed`。** 速度一旦能打关键帧，
乘法就只在常速时成立。唯一实现是 `core/speed.ts`：取帧（`engine/video-source.ts`）、
导出混流 / 预览播放（`core/audio-plan.ts` 的消费方）、trim / 切分全对着它。
各处自己积一遍的形态是「画面按曲线走、声音按平均速度走」。

- 曲线键是 **`curves.speed`**，基值 `source.speed`（常速）。有曲线时基值不参与求值
  （与 `opacity` / `transform.*` 同构）。`source.speed` **必须为正** —— 负值只能走曲线。
- **负速度 = 倒放**：媒体时间往回走，`srcIn` 是**起点处**的素材时间（不是最小值），
  所以可用素材在它**之前**。`sourceRangeOf` 返回区间极值（含折返点），音频解码范围与
  「素材够不够」都读它。
- `integralCurve`（`core/curve.ts`）：linear / step / smooth 闭式，bezier 复合 Simpson，
  与求值共用同一份 `bezierSegmentValue`。反向区间返回负值。
- 「保持片段长度」是 `ProjectStore.setClipSpeed` 的规则：改速度不动 `start` / `end`，
  只有加速后需要的素材超过「`srcIn` 到素材末尾」时把片段缩到用完为止。
- **内嵌音轨在速度 ≤ 0 的区间静音**（预览与导出同一条规则）：WebAudio 的
  `playbackRate` 必须为正。`AudioSpan.reversed` 就是这条判据，别在消费方各判一次。
- `earliestTrimStart` 在曲线下用基值估算是**保守近似**（曲线非匀速时允许拖到略早于
  素材头部，那里呈现首帧）。这是取舍，不是待修的 bug。

## 工程时长与素材长度无关

`Project.duration` 只决定导出帧数范围与时间轴宽度；片段可以把它撑长
（`addClip` / `liveMoveClip` / `liveResizeClip` 只增不减），用户也可以手动改小或用
「贴合内容」收回。导入音频只是新片段的默认长度，**不许**被 `duration` 截断。

## 关键帧锚拍与包络

```ts
interface Key {
  t: number
  v: number
  /** **出向**语义：只决定「本 key → 下一个 key」这一段。 */
  interp: 'linear' | 'step' | 'smooth' | 'bezier'
  /** 旧版段级归一化控制点 [x1,y1,x2,y2]（只在没有 hOut/hIn 时读）。 */
  handles?: [number, number, number, number]
  /** 出向手柄，相对本 key 的 [秒, 值]。 */
  hOut?: [number, number]
  /** 入向手柄，相对本 key 的 [秒, 值]（秒为负）。 */
  hIn?: [number, number]
}
interface Curve {
  keys: Key[]
  mode?: 'keyframe' | 'impulse' | 'follower'
  beatAnchor?: { beat: number } | null
}
```

- `hOut` / `hIn` 是 **schema v9** 新增的可选字段（8 → 9 恒等迁移）；旧工程读进来
  没有它们仍然合法，求值走缺省水平手柄或旧版 `handles`。
- **`interp` 只看左 key**：想改一段的两侧就把相邻两个 key 都设上。曲线编辑器
  的手柄显示与工具栏全部按这条约定实现。
- **手柄归属**：`a.hOut` + `b.hIn` 构成 `a → b` 段的两个控制点。`withInterp`
  切到 `bezier` 时负责补齐；`segmentHandles` 是求值与 UI 的唯一换算处。
- **旧版 `handles` 不要删也不要再写**：它只在 `hOut` / `hIn` 都不存在时参与求值；
  保留是为了让 0.3 之前的工程逐像素不变。新写入一律用值域偏移（归一化坐标在
  `dv = 0` 时把手柄纵向分量乘成 0，表达不了过冲）。
- **控制点必须钳进 x 单调域**（`0 ≤ out.t ≤ span`、`-span ≤ in.t ≤ 0`、
  `out.t - in.t ≤ span`）。越界会让 `x(s) = t` 多解，编辑器里看到的形状与求值
  结果对不上，而不会报错。
- **`bezier` 缺省 = 缓入缓出**（水平手柄）。旧注释「缺省近似线性」已作废：
  要匀速请用 `linear`。

`beatAnchor` 必须在 `Curve` 结构本身里，不是事后补 —— 改了 BPM 或微调 `offset` 之后
**所有卡点自动跟着走，不用重排**。

`core/curve.ts` 另有三种闭合解包络（帧率无关、天然 seek 安全）：
`impulse`（指数衰减冲击）、`follower`（非对称攻放）、`approach`（帧率无关指数逼近）。
**运镜的缓动用 `approach`，不要用关键帧。**

---

## 容量预算（内存 / 显存）

**唯一策略处是 `core/capacity.ts`。任何地方都不要再写容量常数。**

这条是补出来的：内存 / 显存类上限曾经散落成字面量（`DEFAULT_BUDGET_BYTES = 192MB`、
`MAX_RASTER_BYTES = 48MB`、`EXPORT_ENTRIES = 2` …），而它们本质是
**「这台机器有多宽裕」的函数**，于是 16 GB 台式机与 8 GB 轻薄本共用同一组数字。
更要命的是容量不足的表现**通常静默**：画面缺层、变糊、context lost，**不报错**。

### 数字从哪来（浏览器测不准，所以由 Node 测）

```
scripts/capacity.mjs  （Node：os.freemem + nvidia-smi / 注册表）
      ↓ /__capacity.json（vite.config.ts 的中间件注入）
ui/capacity-profile.ts（启动期取一次，**起了不等**）
      ↓ applyMachine()
core/capacity.ts      （deriveLimits：share × 份额 → 夹进 [floor, cap]）
      ↓ getLimits()     ← 所有消费方都在**用到时**读，不抄进字段
```

- 页面侧拿不到可信数字：`navigator.deviceMemory` 粗到 GB 且只有 Chromium 有，
  `performance.memory` **只统计 JS 堆**，WebGL 连显存大小都不肯说
  （`MAX_TEXTURE_SIZE` 是格式上限，不是容量）。**别在页面里猜。**
- 探测不到（纯静态部署 / 探测失败）就退回 `DEFAULT_LIMITS` —— 那组值刻意等于
  「改造之前的行为」，所以**不会因为探测失败而回归**，只是拿不到更好的利用。
- 要更大的值：写 `artmatic.capacity.json`（路径见 `scripts/capacity.mjs`，
  可用 `ARTMATIC_CAPACITY` 覆盖），或在宿主里 `setLimits()`。
  **不要回来改 `deriveLimits` 的比例** —— 那是所有机器共享的策略。
- 新预算 = 加到 `CapacityLimits` + `deriveLimits`（写明 share / floor / cap 的
  理由）+ `RANGE` + `DEFAULT_LIMITS`（等于旧行为），再让消费方读 `getLimits()`。

### 两条不变量（谁违反谁出「静默故障」）

1. **上限必须罩得住「当前实际要画的东西」。** 与预算冲突时**保画面 + 报超支**，
   不许让上限赢：
   - 排版：`protectedKeys()` = 当前帧 ∪ 上一帧在屏的键，永不淘汰；
     超出预算就置 `overBudget`（`stats()` 里可见）。
   - 视频：`planEviction()` 两级裁决，**每条缓存至少留一帧**（那是正在显示的画面），
     连这都放不下就停手并置 `overBudget`。
   - 特效池：反馈历史与 `delayedInput` 是**状态**不是中间结果，在用的那份淘汰
     就是画错，同样停手 + `poolOverBudget`。
   - 调色中间缓冲（`gradeTargetMB`）：超了**整帧退回 8 位**并置 `gradeStats().reason = 'over-budget'`
     （检查器有条提示）。它与上面三条的区别是「精度」而不是「内容」，所以不适用
     「保画面」——画面照常，只是调色按 8 位算。**不许悄悄降精度**。
2. **作用域要写对：全局 vs 每项。** `new FrameCache(192MB)` 建在**每条素材**的
   条目里 = N × 192 MB（实测一次 4 秒导出就吃掉 398 MB 显存）。声明是全局就必须
   只有一份，裁决只能有一处（`rebalance()` / `evict()` / `trimPools()`）。

### 生命周期：有 `forget`/`dispose` 就必须有调用方

注册处的接口齐全但**零调用方** = 完全等于没写。素材级资源（视频解码器 + 帧缓存、
图片 canvas + 纹理、AudioBuffer、频谱分析、波形）在 `closeProject` 时经
`releaseProjectAssets()` 释放；片段级的模拟状态纹理走 `AlgoRuntime.forget()`。
模拟状态**不能**靠预算淘汰 —— 它装的是状态，删了就得从第 0 帧重推（违反根 `AGENTS.md` 硬约束 1.3）。

### GPU 粒子容量与素材引用（v21，不抬 `SCHEMA_VERSION`）

- **粒子上限只在 `capacity.ts::particleCapacity` 派生**：设计上界 262144，
  按 `simStateMB` 的一半与「四张状态纹理 + 快照环」的单粒子成本夹取。
  别在引擎 / UI 里再写一个「最多多少粒子」。预算不足时 `degraded: true`，
  编辑器状态栏给可见提示。
- **`asset` 型参数是 `params` 里的可选字符串键**（`assetId`，空串 = 未绑定）。
  运行期逐键 `?? defaultValue` 合并，所以不抬版本、也不加迁移。
- **键清单在 `core/asset-params.ts`**：`ASSET_PARAM_KEYS` 是唯一真源。
  `validateProject` 调 `sanitizeAssetParams`（悬空 / 类型坏一律置**空串**），
  `appState.removeAsset` 调 `clearAssetRefsInProject`。一律置空串。
  删键会让读取方回落 def 默认值，那可能是另一张素材。
- 它与 `MaskRef` 不是一回事：mask 是输入绑定（可指向片段、要环检测），
  asset 参数只能指向工程台账里的一张静态图片，没有拓扑。

### 消费与验证

- 淘汰是**延迟结算**的（upload / 模式切换 / 帧末 / 每次解码），所以改完预算要
  触一次才会看到；`overBudget` 类读数就是给这件事留的证据。
- E2E 里**把预算钉死**（`__artmatic.capacity.set({...})`），否则用例行为会跟着
  跑测试的机器变。注意 `RANGE` 有下限：写 `1` 会被夹回 floor，用例会变成假绿。
- 导出体积超 `exportMemoryMB` 时改走**流式落盘**（`Platform.saveStream` +
  mediabunny 的 `StreamTarget` / fflate 增量 zip）。这条路要用户先选保存位置
  （`showSaveFilePicker` 要求瞬时激活），拿不到时明确提示风险并继续 ——
  理由见 `ui/export.ts::pickOutput`。
