/**
 * inspector.ts — 右侧检查器、关键帧控件、以及自研控件族里**自己产生**的文案
 * （滑杆读数、数字框步进提示、下拉空态…）。
 *
 * 前缀：`insp.*` / `ctl.*`
 */

export const inspector = {
  /* ------------------------------------------------ 检查器外壳 / 片段类型 */
  'insp.title': '检查器',
  'insp.clipKindSource': '画面片段',
  'insp.clipKindEffect': '特效片段',
  'insp.clipKindAudio': '音频片段',
  'insp.placeholderSelect': '选中一个片段查看属性。',
  'insp.placeholderRightClick': '空白处右键在鼠标位置新建片段。',

  /* ------------------------------------------------ 片段属性 */
  'insp.name': '名称',
  'insp.start': '起点',
  'insp.end': '终点',
  'insp.fade': '淡变',
  /* 音频片段：编排用的两条斜坡（与时间轴两端的三角手柄同一份数据）。 */
  'insp.fadeIn': '渐入',
  'insp.fadeOut': '渐出',
  'insp.fadeInTip': '渐入 + 渐出 不超过片段长度；也可以直接拖时间轴片段两端的三角',
  'insp.blend': '混合',
  'insp.fit': '适配',
  /* 「适配」的三个取值：目前直接显示英文枚举名，原样保留。 */
  'insp.fitContain': 'contain',
  'insp.fitCover': 'cover',
  'insp.fitStretch': 'stretch',
  'insp.srcIn': '源内偏移',
  'insp.color': '颜色',

  /* 变换与透明度（E2E 断言了「不透明度」子串，改字会挂）。 */
  'insp.opacity': '不透明度',
  'insp.posX': '位置 X',
  'insp.posY': '位置 Y',
  'insp.scaleX': '缩放 X',
  'insp.scaleY': '缩放 Y',
  /* 默认联动：拖任一轴两轴一起变；勾上这个才拆成两个独立轴。 */
  'insp.scaleSeparate': '分离 XY',
  'insp.scaleSeparateTip': '勾选后 X / Y 各自独立；关键帧始终各自独立。',
  'insp.rotate': '旋转',

  /* 来源说明：算法生成器 / 图片素材。 */
  'insp.algoGenerator': '算法生成器：{name}',
  'insp.imageAsset': '图片素材：{name}',
  /* 烘焙入参不可打关键帧：`{label}` 是参数名。 */
  'insp.bakedParamTip': '{label}（烘焙入参，不可打关键帧）',

  /* ------------------------------------------------ 抠图（色键） */
  /* 片段级图像处理，不是特效片段：只处理这一层自己的 alpha（placement pass）。
     与 `quad` 同属「片段自身的属性」，所以 0..1 的滑杆语义与画面上的结果直接对应。 */
  'insp.keying': '抠图',
  'insp.keyingEnable': '启用抠图',
  'insp.keyingDisable': '关闭抠图',
  'insp.keyColor': '键色',
  'insp.keyPick': '吸管取色',
  'insp.keyPickTip': '在预览画面上点击要抠掉的颜色',
  'insp.keyPickHint': '吸管取色：在预览画面上点击要抠掉的颜色（Esc 取消）',
  'insp.keyPickDone': '已取色 {color}',
  'insp.keyPickFailed': '取色失败：画面尚未就绪',
  'insp.keyTolerance': '容差',
  'insp.keyToleranceTip': '颜色距离小于它的像素完全透明',
  'insp.keySoftness': '柔边',
  'insp.keySoftnessTip': '容差之外这段距离里按比例过渡到不透明',
  'insp.keySpill': '溢色抑制',
  'insp.keySpillTip': '把边缘上残留的键色反光往中性压',
  'insp.keyEdit': '修改抠图参数',

  /* ------------------------------------------------ 四角调整（透视变形） */
  'insp.quad': '四角调整',
  'insp.quadEnable': '启用四角调整',
  'insp.quadDisable': '关闭四角调整',
  'insp.quadAdjust': '调整四角',
  'insp.quadHint': '在预览画面里拖动四角或四边中点；拖动期间按 Esc 取消。',
  'insp.quadReset': '重置四角',
  'insp.quadResetTip': '四角回到默认位置（一笔撤销）',

  /* ------------------------------------------------ 裁剪（源边裁切） */
  /* 百分比是「该边被裁掉的源比例」。与抠图 / 四角一样是片段自身属性，
     但它**不改内容比例**：只收可见窗口（见 core/image-fx.ts::CropSettings）。 */
  'insp.crop': '裁剪',
  'insp.cropLeft': '左',
  'insp.cropRight': '右',
  'insp.cropTop': '上',
  'insp.cropBottom': '下',
  'insp.cropReset': '取消裁剪',
  'insp.cropResetTip': '四边都回到 0（一笔撤销）',
  'insp.cropEdit': '修改裁剪',

  /* ------------------------------------------------ 特效链 */
  'insp.addEffect': '添加特效',
  'insp.removeEffect': '删除特效',
  'insp.reorderEffect': '调整特效顺序',
  'insp.editEffectParam': '修改特效参数',
  'insp.toggleEffect': '切换特效',
  'insp.effectEnable': '启用 / 禁用这个特效实例',
  'insp.emptyChain': '空链：从上面添加特效。',
  'insp.fxOrderHint': '从上到下依次处理画面：拖动左侧把手可以改顺序。',
  /* 特效链的折叠 / 排序（链的顺序就是合成顺序）。 */
  'insp.dragEffect': '拖动调整顺序（上面的先作用于画面）',
  'insp.collapseEffect': '折叠这个特效',
  'insp.expandEffect': '展开这个特效',
  'insp.collapseAllEffects': '折叠全部',
  'insp.expandAllEffects': '展开全部',

  /* 影响深度（`EffectClip.affectDepth`）。语义见 engine/stack.ts 的文件头。 */
  'insp.affectDepth': '影响深度',
  'insp.affectDepthTip': '只作用于下方最近的 N 条启用轨道；0 = 下方全部。',
  'insp.affectDepthAll': '影响下方所有轨道。',
  'insp.affectDepthTracks': '影响：{names}',
  'insp.affectDepthEmpty': '下方没有启用的视觉轨，这个特效作用在空画面上。',
  'insp.bindClip': '绑定片段',
  'insp.bindClipTip': '只作用在选定片段那一层上，与轨道顺序无关；与影响深度互斥。',
  'insp.bindNone': '不绑定（按影响深度）',
  /* 蒙版引用（v19）：吃外部蒙版的特效才有这一行。 */
  'insp.mask': '蒙版',
  'insp.maskTip': '用另一个片段的画面当蒙版：它这一帧的整帧层（含它自己的绑定特效），不含混合与不透明度。',
  'insp.maskNone': '不接',
  'insp.maskChannel': '通道',
  'insp.maskChannelLuma': '亮度',
  'insp.maskChannelAlpha': '不透明度',
  'insp.maskChannelR': '红',
  'insp.maskChannelG': '绿',
  'insp.maskChannelB': '蓝',
  'insp.maskCycle': '接不上：这两条链会互相引用（成环）',

  /* 调色精度：中间缓冲拿不到 16F 时的降级提示（判定见 core/grade.ts）。 */
  'insp.gradeNoFloat': '本机无浮点渲染目标，调色按 8 位精度执行。',
  'insp.gradeBudget': '显存预算不足，调色按 8 位精度执行。',

  /* ------------------------------------------------ 特效选择器 */
  'insp.pickerSearch': '搜索特效……',
  'insp.pickerViewGrid': '缩略图（大）',
  'insp.pickerViewList': '列表（小）',
  'insp.pickerViewGridTip': '切换到网格视图：大缩略图',
  'insp.pickerViewListTip': '切换到列表视图：小缩略图 + 标签',
  'insp.pickerFilter': '条件筛选',
  'insp.pickerFilterCat': '分类',
  'insp.pickerFilterTag': '标签',
  'insp.pickerClearFilters': '清除条件',
  'insp.pickerSort': '排序',
  'insp.pickerSortDefault': '默认顺序',
  'insp.pickerSortName': '名称',
  'insp.pickerSelected': '已选',
  'insp.pickerSelCount': '已选 {n} 个',
  'insp.pickerApply': '保存并应用',
  'insp.pickerApplyN': '保存并应用（{n}）',
  'insp.pickerApplyTip': '按选择顺序追加到特效链末尾',
  'insp.pickerNone': '没有符合条件的特效。',
  'insp.pickerEmptyHint': '换个搜索词试试；也可以少勾几个筛选条件。',
  'insp.pickerHitCount': '{n} 个特效',

  /* ------------------------------------------------ 算法生成器选择器 */
  /* 换生成器 = 换一种算法，参数表完全不同，所以旧参数不保留 —— 这一点在面板里明说。 */
  'insp.changeAlgo': '更换算法艺术',
  'insp.algoPickerSearch': '搜索生成器……',
  'insp.algoPickerWarn':
    '更换算法会整份替换这个片段的源：旧参数与旧的关键帧都不会保留，新生成器会写入它的默认参数（整笔操作可用撤销恢复）。',
  'insp.algoPickerApply': '更换',
  'insp.algoPickerApplyTip': '整体替换源，并写入新生成器的默认参数',
  'insp.algoPickerSelected': '当前选择：{name}',
  /* 从时间轴新建片段时 current 为空串：这里还没有「当前生成器」。 */
  'insp.algoPickerPick': '选一个生成器',
  'insp.algoPickerUnchanged': '已是当前生成器',
  'insp.algoPickerCurrent': '当前',
  'insp.algoPickerHit': '{n} 个生成器',
  'insp.algoPickerEmpty': '没有符合条件的生成器。',
  'insp.algoPickerSortDefault': '默认顺序',

  /* 算法选择器的小标题。分类依据见 `algos/catalog.ts` 的 `AlgoGroupId`。 */
  'insp.algoGroupMath': '数学模拟',
  'insp.algoGroupGeometry': '几何图形',
  'insp.algoGroupPhysics': '物理模拟',
  'insp.algoGroupSpecial': '特殊',

  /* ------------------------------------------------ 片段动作 */
  'insp.editTypography': '编辑排版',
  'insp.splitAtPlayhead': '在播放头分割',

  /* ------------------------------------------------ 关键帧 / 曲线 */
  'insp.keyframe': '打关键帧',
  'insp.removeKeyframe': '删除关键帧',
  'insp.clearCurve': '清除曲线',
  'insp.toggleAnchor': '切换锚到拍',
  'insp.editParam': '修改参数',
  'insp.anchorBeat': '锚到拍',
  'insp.anchorTip': '锚到拍：改 BPM/offset 时卡点自动跟随',

  /* 跨剪切点两帧预览（播放头卡在切点时并排显示前/后帧的浮层 aria-label）。 */
  'insp.cutPreview': '剪切点预览：左侧为切点前一帧，右侧为切点后一帧',

  /* ------------------------------------------------ 撤销栈动作词（「重命名」用 common.rename） */
  'insp.changeStart': '改起点',
  'insp.changeEnd': '改终点',
  'insp.changeFade': '改淡变',
  'insp.changeBlend': '改混合模式',
  'insp.changeFit': '改适配',
  'insp.changeColor': '改颜色',
  'insp.changeSrcIn': '改 srcIn',
  'insp.changeAffectDepth': '改影响深度',
  'insp.changeBoundClip': '改绑定片段',
  'insp.changeMask': '改蒙版',

  /* ------------------------------------------------ 转场（出画） */
  /* 转场的**参数名不翻译**：`pixelSize` / `blocksize` 那些逐字来自 gl-transitions
     的第三方作者，是 GLSL uniform 的名字 —— 翻译之后就对着上游文档找不到那一行。
     **中文名与说明在 `transitions.ts`（`tns.*`）**，不在这里：那是每一条转场一条
     的成批数据，和本文件的「界面文案」不是一类东西。 */
  'insp.transition': '转场（出画）',
  /* v13 起两端各一块。`insp.transition` 保留给旧调用点，新界面用下面两个。 */
  'insp.transitionIn': '入场',
  'insp.transitionOut': '出场',
  'insp.transitionNone': '无',
  'insp.transitionDuration': '时长',
  'insp.transitionPick': '选择转场',
  'insp.setTransition': '设置转场',
  'insp.changeTransitionDuration': '改转场时长',
  'insp.editTransitionParam': '修改转场参数',
  /* 另一侧没有片段（v13）：**不是错误**，那一侧就是全透明。 */
  'insp.transitionToTransparent': '后面没有片段：淡出到透明',
  'insp.transitionFromTransparent': '前面没有片段：从透明淡入',
  'insp.transitionShadowed': '与前一段的出场转场落在同一边界，以出场为准。',
  'insp.transitionNextNotSource': '下一个片段是特效片段，没有画面可以作为「入画」内容。',
  'insp.transitionNotAdjacent': '与下一个片段之间有缝隙。转场需要两个片段紧邻；把片段拖到贴合即可生效。',
  'insp.transitionTooShort': '两侧片段太短，放不下转场。',

  /* ------------------------------------------------ 视频变速 */
  'insp.speed': '速度',
  'insp.changeSpeed': '变速',

  /* ------------------------------------------------ 片段音频（v13） */
  'insp.audio': '音频',
  'insp.audioMuted': '静音',
  'insp.audioTrackMuted': '所在轨道已静音',
  'insp.audioGain': '音量',
  'insp.audioFadeIn': '渐入',
  'insp.audioFadeOut': '渐出',
  'insp.audioDetach': '分离音频',
  'insp.audioDetached': '已分离到「{track}」',
  'insp.audioLock': '锁定到视频',
  'insp.audioUnlock': '解锁',
  'insp.audioLockedTo': '已锁定到「{name}」',
  'insp.audioUnlinked': '这条音频不是从视频分离出来的',
  'insp.transitionClamped': '时长超过两侧片段能容纳的上限，实际按 {max}s 生效。',
  'insp.transitionFadeTip': '这个片段同时设了淡变，窗口内会叠加成二次淡出，通常只需要其中一种。',
  'insp.transitionInactive': '当前未生效',
  'insp.transitionChange': '更换转场',
  'insp.transitionClear': '清除转场',

  /* 转场选择器：转场数量过百之后，一个下拉既不能搜、也看不见每条转场把两张图切成了
     什么样。缩略图是「两张底图 @ 50% 进度」的定格（`gen-transition-thumbs.mjs`）。 */
  'insp.transitionPickerSearch': '搜索转场（名称或作者）……',
  'insp.transitionPickerApply': '应用',
  'insp.transitionPickerNone': '无转场',
  'insp.transitionPickerNoneHint': '清除这个片段上的出画转场',
  'insp.transitionPickerSelected': '当前选择：{name}',
  'insp.transitionPickerHit': '{n} 条转场',
  'insp.transitionPickerEmpty': '没有符合条件的转场。',
  'insp.transitionPickerSortName': '名称',
  'insp.transitionPickerSortAuthor': '作者',
  /* 按上游 id 排 —— 知道 gl-transitions 命名的人用它对齐文档。 */
  'insp.transitionPickerSortId': '上游 id',

  /* ------------------------------------------------ 抽屉 */
  'insp.resizeWidth': '调整检查器宽度',
  'insp.collapseDrawer': '收起检查器',

  /* ------------------------------------------------ 关键帧控件自产文案（ctl.*） */
  'ctl.keyframeTipDelete': '删除播放头处的关键帧',
  'ctl.keyframeTipAdd': '在播放头处打关键帧',
  'ctl.keyframeTipCreate': '创建曲线并打第一个关键帧',
  'ctl.keyframeDeleteTip': '点击删除这个关键帧',
  'ctl.clearCurve': '删除整条曲线（回到固定基值）',
  /* 数字框的 aria-label：`{label}` 是参数名。 */
  'ctl.valueAria': '{label} 数值',
} as const;
