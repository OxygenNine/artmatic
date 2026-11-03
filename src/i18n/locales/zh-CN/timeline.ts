/**
 * timeline.ts — 时间轴：轨道工具条（播放 / 拍网格 / 时长 / 缩放 / 重叠策略）、
 * 轨道与片段的上下文菜单、片段自身的文案、导入音频、拖拽的撤销标签。
 *
 * 前缀：`tl.*`（轨道工具条另有 `tp.*` 一组，取自 Transport）
 */

export const timeline = {
  /* ------------------------------------------------ 轨道侧栏（Timeline.svelte） */
  'tl.sideTitle': '轨道',
  'tl.trackMenu': '轨道菜单',
  'tl.addTrack': '添加轨道',
  'tl.addVisualTrack': '视频',
  'tl.addAudioTrack': '音频',
  /* 轨道开关的四态提示（音频轨走静音，视觉轨走显隐）。 */
  'tl.muteAudioTrack': '静音这条音频轨',
  'tl.unmuteAudioTrack': '取消静音',
  'tl.hideTrack': '隐藏这条轨道',
  'tl.showTrack': '显示这条轨道',
  /* 视觉轨的静音（v15）：只关视频片段的内嵌音轨，画面照常。 */
  'tl.muteTrack': '静音这条轨道的声音',
  'tl.unmuteTrack': '恢复这条轨道的声音',

  /* ------------------------------------------------ 菜单：新建片段 / 轨道操作 */
  'tl.addSolid': '纯色片段',
  'tl.addText': '排版片段',
  'tl.addEffect': '特效片段',
  'tl.addAlgo': '算法片段',
  /*
   * 二级菜单的两个固定项：最近用过的 5 个之后，用分隔线隔开。
   * 省略号是「会弹窗」的约定（与「导入图片…」一致）。
   */
  'tl.allEffects': '全部特效…',
  'tl.allAlgos': '全部算法片段…',
  /* 算法选择器的确认按钮：从时间轴进来是「插入」，不是检查器里的「更换」。 */
  'tl.insertAlgo': '插入',
  /* 图片与视频同族：都是把一个本地文件变成一条 source 片段。 */
  'tl.importImageMenu': '导入图片…',
  'tl.importImage': '导入图片',
  'tl.importVideoMenu': '导入视频…',
  'tl.importVideo': '导入视频',
  'tl.setFps': '改帧率',
  'tl.renameTrack': '重命名轨道',
  'tl.removeTrack': '删除轨道',
  'tl.moveTrack': '调整轨道顺序',
  /* 从视频分离出来的音频片段的默认名（视频名 + 后缀）。 */
  'tl.audioOfClip': '{name} 音频',
  /* 右键菜单：视频片段分离音频 / 锁定音频。 */
  'tl.detachAudio': '分离音频',
  'tl.audioLock': '锁定到视频',
  'tl.audioUnlock': '解锁',
  /* 导入音频：菜单项带省略号（要弹文件框），撤销标签不带。 */
  'tl.importAudio': '导入音频',
  'tl.importAudioMenu': '导入音频…',

  /* 新建出来的片段默认名。 */
  'tl.clipSolid': '纯色',
  'tl.clipText': '排版',
  'tl.clipEffect': '特效',

  /* ------------------------------------------------ 段落标记（标尺上方 12px 带） */
  'tl.addSection': '在此添加段落',
  'tl.sectionN': '段落 {n}',
  'tl.renameSection': '重命名段落',
  'tl.removeSection': '删除段落',
  'tl.splitSection': '在鼠标处切分',
  'tl.moveSection': '移动段落',
  'tl.sectionName': '段落名',

  /* ------------------------------------------------ 片段自身（ClipView.svelte） */
  'tl.fade': '淡入淡出',
  /* 音频片段两端的淡变三角手柄（拖动 = 一笔撤销）。 */
  'tl.fadeIn': '渐入',
  'tl.fadeOut': '渐出',
  'tl.setFadeIn': '调整渐入',
  'tl.setFadeOut': '调整渐出',
  'tl.fadeInTip': '拖动设置渐入时长（拖回左端 = 不淡）',
  'tl.fadeOutTip': '拖动设置渐出时长（拖回右端 = 不淡）',

  /* ------------------------------------------------ 拖拽的撤销标签（drag.ts） */
  'tl.moveClip': '移动片段',
  'tl.moveClips': '移动 {n} 个片段',
  'tl.resizeClip': '调整片段长度',

  /* ------------------------------------------------ 吸附档位名（core/time.ts 的 SNAP_MODES 表） */
  'tl.snapBar': '小节',
  'tl.snapBeat': '拍',
  'tl.snapHalf': '半拍',
  'tl.snapFree': '自由',
  /* 标准模式专用：步长是 1/fps 秒（时间码的小数位就是帧）。 */
  'tl.snapFrame': '帧',

  /* ------------------------------------------------ 撤销标签（core/project-store.ts） */
  'tl.newTrack': '新建{kind}轨道',
  'tl.trackKindVisual': '视觉',
  'tl.trackKindAudio': '音频',
  'tl.enableTrack': '启用轨道',
  'tl.disableTrack': '禁用轨道',
  'tl.addClip': '新建片段',
  'tl.renameClip': '重命名片段',
  'tl.removeClip': '删除片段',
  'tl.removeClips': '删除 {n} 个片段',
  'tl.moveTrackUp': '上移一轨',
  'tl.moveTrackDown': '下移一轨',
  'tl.setDuration': '修改时长',
  'tl.renameProject': '重命名工程',
  'tl.fitDuration': '时长贴合内容',
  'tl.setResolution': '修改分辨率',
  'tl.splitClip': '切分片段',
  /* 片段复制 / 剪切 / 粘贴（core/clipboard.ts 的载荷 + appState 的三个动作）。
     撤销标签与提示分开：前者进撤销栈（一笔），后者是 flash。 */
  'tl.pasteClips': '粘贴 {n} 个片段',
  'tl.copied': '已复制 {n} 个片段',
  'tl.cut': '已剪切 {n} 个片段',
  /* 系统剪贴板写不进去（权限 / 非安全上下文）：内存副本还在，本应用内照常可粘。 */
  'tl.copyLocalOnly': '浏览器不允许写系统剪贴板，已复制到应用内（可在本应用粘贴）',
  'tl.cutLocalOnly': '浏览器不允许写系统剪贴板，已剪切到应用内（可在本应用粘贴）',
  'tl.pasteEmpty': '剪贴板里没有可粘贴的片段',
  'tl.pasteNoTrack': '没有能放下这些片段的轨道',
  'tl.pasted': '已粘贴 {n} 个片段',
  /* 跨工程 / 素材被删：assetId 在目标工程里不存在，画面按「脱机媒体」占位符表现。 */
  'tl.pasteMissingMedia': '已粘贴 {n} 个片段；其中引用的素材不在本工程，画面显示为脱机媒体',
  'tl.setOverlapBehavior': '切换重叠策略',
  'tl.setBeatGrid': '修改拍网格',
  'tl.loadProject': '载入工程',

  /* ------------------------------------------------ 演示工程（core/demo-project.ts） */
  'tl.demoProjectName': 'Artmatic Demo',
  'tl.demoAudioAsset': '演示节拍 120 BPM',
  'tl.demoClipBeats': '演示节拍',
  /* 轨名：V6 → V1 自上而下 = 前景 → 背景，A1 是唯一的音频轨。 */
  'tl.demoTrackV6': 'V6 全局调色',
  'tl.demoTrackV5': 'V5 标题排版',
  'tl.demoTrackV4': 'V4 故障链',
  'tl.demoTrackV3': 'V3 叠层',
  'tl.demoTrackV2': 'V2 主视觉',
  'tl.demoTrackV1': 'V1 复平面底图',
  'tl.demoTrackA1': 'A1 音乐',
  /* 片段名：写成「生成器 / 特效链 + 一眼能对上画面的描述」，不写片汤话。 */
  'tl.demoClipGrade': '调色 · 暗角 · 颗粒',
  'tl.demoClipTitle': '标题排版',
  'tl.demoClipGlitch': '切片 · 通道错位 · 扫描线 · 拖尾',
  'tl.demoClipBifurcation': 'Logistic 分岔图生长',
  'tl.demoClipFlow': '音频反应墨线',
  'tl.demoClipStrands': '音频反应丝弦',
  'tl.demoClipAnt': '兰顿蚂蚁',
  'tl.demoClipSand': '阿贝尔沙堆',
  'tl.demoClipMandelbrot': 'Mandelbrot 推近',
  /* 演示工程的三个段落标记（标尺上方的段落带）。 */
  'tl.demoSectionIntro': '序曲',
  'tl.demoSectionDevelop': '发展',
  'tl.demoSectionOutro': '收束',

  /* ------------------------------------------------ 轨道工具条（Transport.svelte） */
  'tp.play': '播放',
  /* 时间轴形态（标尺文案 / 吸附档位 / 工具条显示哪一组参数）。两态按钮的提示。 */
  'tp.modeBeat': '节奏',
  'tp.modeStandard': '标准',
  'tp.modeTipBeat': '时间轴：节奏模式（按「小节.拍」读刻度、吸附到拍网格）。点击切到标准模式',
  'tp.modeTipStandard': '时间轴：标准模式（按「分:秒.帧」读刻度、按帧吸附）。点击切到节奏模式',
  'tp.fps': '帧率',
  'tp.fpsTip': '工程帧率：决定时间码的小数位与导出帧数（改它会改变逐帧随机的画面）',
  'tp.pause': '暂停',
  'tp.stop': '停止',
  'tp.timeTip': '工程时间 / 小节.拍',
  'tp.bpmTip': 'BPM',
  'tp.offsetTip': 'offset：第 0 拍的秒数',
  /* 自动估计拍网格。 */
  'tp.estimate': '自动估计',
  'tp.estimateTip': '从工程里的音频估计 BPM 与 offset（谱通量 + 自相关）',
  'tp.estimateBusy': '估计中…',
  'tp.estimateOk': '估计完成：{bpm} BPM，offset {offset}s',
  'tp.estimateNoAudio': '还没有导入音频，无法估计',
  'tp.estimateSilent': 'BPM 计算失败：音频接近静音',
  'tp.estimateFailed': 'BPM 计算失败：音频里找不到稳定的节拍',
  'tp.beatsPerBar': '拍/小节',
  'tp.beatsPerBarTip': '每小节拍数',
  'tp.snap': '吸附',
  'tp.snapTip': '吸附档位',
  'tp.duration': '时长',
  'tp.projectDuration': '工程时长',
  'tp.durationTip':
    '工程时长（秒）：决定导出帧数范围。',
  'tp.fitDuration': '时长收到内容末尾',
  'tp.overlap': '重叠',
  'tp.overlapTip': '同轨重叠策略',
  'tp.overlapReject': '拒绝落点',
  'tp.overlapPush': '挤开邻居',
  'tp.overlapTrim': '吃掉重叠',
  /* 波纹删除：两态按钮（默认关）。删片段后同轨后面的片段前移补位。 */
  'tp.ripple': '波纹',
  'tp.rippleTip':
    '波纹删除：删掉片段后，同一轨道上后面的片段前移补位',
  'tp.zoom': '时间轴缩放',
  'tp.zoomTip': '时间轴缩放（Ctrl+滚轮以光标为锚点缩放）',
  /* 当前帧截图：逐帧操作，所以放轨道工具条（§6.7）。文件名是「工程名-frame-帧号.png」。 */
  'tp.snapshot': '复制当前帧',
  'tp.snapshotTip':
    '把当前预览帧按工程分辨率复制成 PNG（Ctrl/⌘+V 直接可用）。按住 Alt 点击下载为 PNG。',
  'tp.snapshotCopied': '已复制第 {frame} 帧到剪贴板',
  'tp.snapshotCopiedPartial': '已复制第 {frame} 帧（反馈类特效的跨帧历史未重放：超出重放上限）',
  'tp.snapshotSaved': '已导出第 {frame} 帧',
  'tp.snapshotClipDenied': '已改为下载第 {frame} 帧（剪贴板权限被拒）',
  'tp.snapshotClipUnsupported': '已改为下载第 {frame} 帧（此环境不支持写剪贴板）',
  'tp.snapshotFailed': '获取当前帧失败',
} as const;
