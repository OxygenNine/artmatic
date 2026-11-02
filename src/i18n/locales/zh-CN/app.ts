/**
 * app.ts — 应用外壳：顶栏、底栏、窄侧栏、四个全屏面板（关于 / 快捷键 / 导出 /
 * 设置 / 工程）、主题与品牌色、确认框。
 *
 * 前缀：`app.*`
 */

export const app = {
  /* ------------------------------------------------ 品牌与「关于」 */
  'app.aboutArtmatic': '关于 Artmatic',
  'app.aboutLead': 'Web 原生剪辑软件，为故障和算法艺术特化。',
  'app.version': '版本',
  'app.render': '渲染',
  'app.icons': '图标库',
  'app.compression': '压缩',
  /* 许可方括号用全角 —— 这本身就是排版约定，所以整串进语言文件。 */
  'app.licenseLucide': 'Lucide（ISC）',
  'app.licenseFflate': 'fflate（MIT）',

  /* ------------------------------------------------ 侧栏入口 */
  'app.shortcuts': '快捷键',
  'app.project': '工程',
  'app.projectPanelTip': '管理工程…',
  'app.saveProject': '保存工程',
  'app.saveToCurrentDir': '保存到当前工程目录（Ctrl+S）',
  'app.savePickDir': '选择目录并保存（Ctrl+S）',
  'app.export': '导出',
  'app.settings': '设置',
  'app.toDark': '切到暗色',
  'app.toLight': '切到亮色',
  'app.openLab': '打开试炼场',
  'app.openLabTip': '试炼场：逐个审查特效 / 生成器 / 转场，定默认参数',

  /* ------------------------------------------------ 画幅与帧率（工程级设置） */
  'app.frameRate': '帧率',
  'app.fpsChangeHint': '改帧率会改变逐帧随机种子，带随机参数的生成器/特效画面会跟着变。',
  'app.custom': '自定义',
  'app.presetLandscape': '横屏 1080p',
  'app.preset720': '横屏 720p',
  'app.preset4k': '横屏 4K',
  'app.presetVertical': '竖屏 1080×1920',
  'app.presetSquare': '方形 1080',

  /* ------------------------------------------------ 预览浮动工具栏 */
  /* 这些档位只影响预览；导出永远是全帧全质，所以文案里不含「导出」。 */
  'app.previewFps': '帧率',
  'app.previewFpsFull': '全速',
  'app.previewFpsFraction': '1/{n} 帧率',
  'app.previewQuality': '画质',
  'app.previewRestore': '暂停回全质',
  'app.previewRestoreTip': '播放时用上面的档位，暂停时自动回到全质（停住时看到的必须是准的）',
  'app.previewOptions': '预览选项',
  'app.previewCollapse': '收起为悬浮球',
  /* 全屏预览：放大到铺满屏幕（受 2× 上限约束，见 preview-size.ts）。 */
  'app.previewFullscreen': '全屏预览',
  'app.previewFullscreenTip': '放大到铺满整个屏幕（Esc 退出）',
  'app.previewExitFullscreen': '退出全屏',

  /* ------------------------------------------------ 面板调校（拖拽热区） */
  /* 轨道区高度可拖：工具条下缘一条横带只调高度；轨道区与抽屉的夹角一次调两样。 */
  'app.resizeTimeline': '调整时间轴高度',
  'app.resizeTimelineCorner': '同时调整时间轴高度与面板宽度',

  /* ------------------------------------------------ 导出面板 */
  'app.exportFileName': '文件名',
  'app.duration': '时长',
  'app.framesSeconds': '{n} 帧（{sec} 秒）',
  'app.resolution': '分辨率',
  'app.exportMp4': 'MP4',
  'app.exportMp4Hint': 'H.264 + AAC · 约 {size}',
  'app.exportMp4Unsupported': '本机浏览器不支持 WebCodecs，只能导出 PNG 序列。',
  /* 有 WebCodecs 但没有可用 H.264 profile：诊断与上一条不同。 */
  'app.exportMp4NoH264': '本机没有可用的 H.264 编码器，只能导出 PNG 序列。',
  /* 落到 baseline = 走 OpenH264 软件编码：能编，但比硬编慢一个量级。 */
  'app.exportMp4Software': '本机无硬件编码器（软件编码），导出会明显变慢。',
  'app.exportPng': 'PNG 序列',
  /* 真实采样估算：导出面板打开时渲当前帧、量真实 PNG 字节再乘帧数（见 samplePngFrameBytes）。
     会随画面内容波动，所以是「约」而不是承诺。 */
  'app.exportPngHint': '按当前帧约 {size}',
  /* 采样失败时的回退口径：未压缩 RGBA 上界（确定的、可复核的，但不是预计值）。 */
  'app.exportPngHintRaw': '未压缩约 {size}（采样失败）',
  'app.exportPngHintSampling': '估算中…',
  'app.exportTrack': '轨道',
  /* 三个格式通用的轨道筛选项；只列视觉轨（音频单独处理，不进这个下拉）。 */
  'app.exportTrackAll': '全部轨道',
  'app.exportGif': 'GIF',
  /* GIF 独有的参数，只在导出面板出现；标签与「工程帧率」不是一回事。 */
  'app.gifFps': '帧率',
  'app.gifWidth': '宽度',
  'app.gifRange': '区间',
  /* 只有读屏用户听得到，但仍要抽：输入框里是两个没有上下文的光秃数字。 */
  'app.gifRangeStart': '开始',
  'app.gifRangeEnd': '结束',
  /* 抽帧后的实际帧数，紧跟区间输入框 —— 改区间时唯一的即时反馈。 */
  'app.gifFrames': '{n} 帧',
  /* 与 PNG 那条同一个口径：给的是索引数据的**未压缩**大小，不是预计体积 ——
     LZW 的压缩率同样完全取决于画面内容。 */
  'app.exportGifHint': '未压缩约 {size}',
  'app.exporting': '导出中 {pct}%',
  /*
   * 拖动播放头时画面会比播放头**早**（见 app-state 的 syncSimBudget）——
   * 模拟是主线程同步的，向前跳必须真把中间每一步算完。追上之前给个明确提示，
   * 否则用户会以为预览坏了。
   */
  'app.simCatchUp': '模拟追赶中',
  /*
   * 自动保存降级。**常驻**底栏直到下一次写入成功 ——
   * 它与 `notice` 那条一次性提示分开，因为「磁盘上的工程不是最新的」
   * 是一个持续状态，不是一件事。
   */
  'app.autosaveDegraded': '自动保存已降级到本地草稿：{reason}',
  'app.autosaveFailed': '自动保存失败：{reason}',
  'app.autosaveUnknownReason': '未知原因',

  /* ------------------------------------------------ 工程面板 */
  'app.name': '名称',
  'app.location': '位置',
  'app.status': '状态',
  'app.assets': '素材',
  'app.dirConnected': '已连接磁盘目录',
  'app.dirNotChosen': '尚未选择',
  'app.savedAgo': '已保存 · {ago}',
  'app.notSavedYet': '尚未保存',
  'app.assetCount': '{n} 个 · {size}',
  'app.assetCountShort': '{n} 素材',
  'app.assetAudit': '素材检查',
  /*
   * 未使用素材：媒体池「移除」之后字节文件仍在 assets/。
   * 这一段是「移除 ≠ 销毁」唯一可操作的出口 —— 没有它，「文件保留」
   * 就只是一句安慰，用户找不到那个文件。
   */
  'app.unusedAssets': '未使用素材',
  'app.unusedAssetsHint': '{n} 个 · {size}。已不在工程里，字节文件仍留在 assets/。',
  'app.unusedRestore': '恢复',
  'app.unusedTrash': '移到回收站',
  'app.unusedDelete': '彻底删除',
  'app.unusedTrashConfirm': '把「{name}」移到 assets/.trash/？文件不会消失，需要时还能手动找回。',
  'app.unusedDeleteConfirm': '彻底删除「{name}」的源文件？这一步无法撤销。',
  'app.unusedTrashed': '「{name}」已移到回收站',
  'app.unusedDeleted': '已删除「{name}」的源文件',
  'app.unusedRestored': '「{name}」已恢复为工程素材',
  'app.unusedFailed': '「{name}」处理失败（文件可能已被移走或没有权限）',
  /* 清理链路：占用统计与批量动作。 */
  'app.storageUsage': '占用',
  'app.usageProject': '工程内副本',
  'app.usageUnused': '未使用素材',
  'app.usageTrash': '回收站',
  'app.usageOrphans': '未跟踪文件',
  'app.usageHint': '只统计体积，不读取素材内容。',
  'app.trashAll': '全部移入回收站',
  'app.trashAllConfirm': '把 {n} 个未使用素材（{size}）全部移到 assets/.trash/？',
  'app.deleteAll': '全部彻底删除',
  'app.deleteAllConfirm': '彻底删除 {n} 个未使用素材（{size}）的源文件？这一步无法撤销。',
  'app.clearTrash': '清空回收站',
  'app.clearTrashConfirm': '清空 assets/.trash/ 里的 {n} 个文件（{size}）？这一步无法撤销。',
  'app.trashCleared': '已清空回收站（{n} 个文件，{size}）',
  'app.cleanupOrphans': '清理未跟踪文件',
  'app.cleanupOrphansConfirm':
    'assets/ 里有 {n} 个文件不属于当前台账（{size}，旧版本或手工放进去的）。永久删除它们？',
  'app.trashAllDone': '{n} 个素材已移到回收站',
  'app.deleteAllDone': '{n} 个素材已彻底删除',
  'app.orphansDone': '已清理 {n} 个未跟踪文件',
  'app.cleanupFailed': '清理失败：{detail}',

  /* ---------------------------------------------------- 工程包 */
  'app.pack': '打包工程…',
  'app.importPack': '导入工程包…',
  'app.packDescription': 'Artmatic 工程包（工程 + 全部素材）',
  'app.packing': '正在打包工程…',
  'app.packed': '工程包已保存（{n} 个素材，{size}）',
  'app.packedWithMissing': '已保存，但有 {n} 个素材没有字节、未打进包：{names}…',
  'app.packNoStream': '当前环境不支持流式保存，无法打包大工程',
  'app.packFailed': '打包失败：{detail}',
  'app.importingPack': '正在校验并导入工程包…',
  'app.imported': '已导入「{name}」（{n} 个素材）',
  'app.importNotEmpty': '目标目录里已经有一份工程（project.json），请换一个空目录',
  'app.importPackFailed': '导入工程包失败：{detail}',
  'app.newBlank': '新建空白',
  'app.loadDemo': '载入演示',
  'app.openProjectEllipsis': '打开工程…',
  'app.saveAsEllipsis': '另存为…',
  /*
   * 工程面板的分页（范式同设置面板：左 navside + 右内容）。
   * 四页按「什么时候会点它」切：看状态 / 回收空间 / 对工程做动作 / 回到上次那份。
   */
  'app.projectNavOverview': '概览',
  'app.projectNavCleanup': '清理',
  'app.projectNavActions': '操作',
  'app.projectNavRecent': '最近',
  'app.nothingToClean': '没有可清理的内容：未使用素材、回收站与未跟踪文件都是空的。',
  /* 空状态页也要列最近工程，所以这条仍是共用文案（不叫「最近」）。 */
  'app.recentProjects': '最近的工程',
  'app.noRecentProjects': '还没有打开过工程。新建、打开或保存一份之后会出现在这里。',
  'app.cleanupNoDir': '还没有连接磁盘目录：回收站与未跟踪文件只存在于磁盘上的工程里。',
  'app.cleanupTrashHint': '{n} 个文件 · {size}。清空后无法找回。',
  'app.cleanupOrphansHint': '{n} 个文件 · {size}。它们不在台账里，删除不影响任何片段。',
  /*
   * 动作页的逐条说明。几个动作容易混（另存为 / 打包 / 导入），
   * 说明写清「会动什么、不会动什么」，比标签本身重要。
   */
  'app.actionNewDesc': '在同一页里再开一份空白工程，当前这份不动。',
  'app.actionDemoDesc': '开一份带片段与排版的示例工程，用来熟悉工具。',
  'app.actionOpenDesc': '从磁盘上的工程目录打开。打开过的会记在「最近」里。',
  'app.actionSaveAsDesc': '把当前工程写到另一个目录，原来那份保持不动。',
  'app.actionPackDesc': '连同全部素材打成一个 .artmatic 文件，便于备份或换机。',
  'app.actionImportDesc': '校验并解包到一个空目录，然后按普通工程打开。',
  /*
   * 工程目录说明被三个 <code> 元素打断，所以拆成四段。
   * 这是 i18n 里的固有麻烦：句子中间嵌了标记就没法整句存。
   * 这里的取舍是**保视觉**（文件名走等宽样式）而不是保整句 ——
   * 文件名本身是技术标识符，不进语言文件，真正要翻译的只有这四段连接词。
   */
  'app.projectHintA': '工程是一个磁盘目录：',
  'app.projectHintB': ' 是内容，',
  'app.projectHintC': ' 是素材台账，素材字节在 ',
  'app.projectHintD': '。整个目录可以直接拷走。',

  /* ------------------------------------------------ 设置面板 */
  'app.settingsNavProject': '当前工程',
  'app.settingsNavAppearance': '外观',
  'app.settingsNavHabits': '操作习惯',
  'app.settingsNavEditor': '编辑器行为',
  'app.settingsNavDesktop': '桌面',
  'app.settingsNavLicense': '许可',
  'app.applySettings': '保存并应用',
  'app.changedMark': '本次已更改',
  'app.renameProject': '重命名工程',

  /* —— 当前工程 —— */
  'app.basic': '基础',
  'app.projectName': '工程名称',
  'app.customResolution': '自定义分辨率…',
  'app.width': '宽',
  'app.height': '高',
  'app.customFps': '自定义帧率…',
  /* 改分辨率不会缩放已有排版 —— 这是唯一会让人"改完吓一跳"的后果，所以要说明。 */
  'app.resolutionWarn': '改变分辨率不会缩放已有的排版：画布尺寸变了，文本框的位置与换行会跟着变。',
  'app.music': '音乐',
  'app.bpm': 'BPM',
  'app.offset': '偏移',
  'app.beatsPerBar': '每小节的拍数',
  'app.beatsPerBarHint': '拍网格的计量方式。改 BPM / 偏移前先确认它。',

  /* —— 外观 —— */
  'app.fontScale': '字号',
  'app.fontScaleSmall': '小',
  'app.fontScaleNormal': '标准',
  'app.fontScaleLarge': '大',
  'app.fontScaleXLarge': '特大',
  'app.motion': '界面动效',
  'app.motionEnable': '启用',
  'app.motionSpeed': '速度',
  'app.motionSpeedSlow': '慢',
  'app.motionSpeedNormal': '标准',
  'app.motionSpeedFast': '快',
  'app.accentColor': '主题色',
  'app.customAccent': '自定义主题色',
  'app.mode': '模式',
  'app.light': '亮色',
  'app.dark': '暗色',
  /* 这两套**只能**在这里选，rail 的明暗按钮不提供（见 Rail.svelte 的注释）。 */
  'app.modeGray': '灰色',
  'app.modeContrast': '高对比度',
  /* 彩蛋。文案刻意只说「是什么」，不说「怎么玩」—— 捏一下的乐趣在于自己发现。 */
  'app.mascot': '看板娘',
  'app.mascotEnable': '启用',
  'app.mascotTip': '在左下角放一只可以捏的看板娘。捏太急她会坏掉。',
  'app.mascotPoke': '捏一下',

  /* —— 操作习惯 —— */
  'app.shortcutScheme': '快捷键方案',
  'app.shortcutSplit': '切分片段',

  /* —— 运行错误兜底 —— */
  'app.runtimeError': '运行错误 {n}',
  'app.runtimeErrorTitle': '运行错误',
  'app.runtimeErrorHint':
    '这些错误不会中断编辑，但可能意味着某块界面或渲染没有正常工作。复制诊断信息可以帮助定位。',
  'app.copyDiagnostics': '复制诊断信息',
  'app.diagnosticsCopied': '已复制',
  'app.recentConsole': '最近的 console.error',
  'app.clearErrors': '清空',

  /* —— 编辑器行为 —— */
  'app.overlapBehavior': '片段重叠行为',
  'app.overlapBehaviorTip': '把片段拖到同轨邻居身上时怎么办。',
  'app.keyframes': '关键帧',
  'app.beatAnchorNew': '新关键帧默认锚到拍',
  'app.beatAnchorTip': '锚到拍：改 BPM / offset 时卡点自动跟随',
  'app.inspector': '检查器',

  /* —— 桌面（只有桌面壳里有这一页） —— */
  /*
   * 应用菜单已被关掉（`Menu.setApplicationMenu(null)`），这三个动作只剩
   * 这一个入口。
   */
  'app.devTools': '开发者工具',
  'app.reload': '重新加载',
  'app.quit': '退出 Artmatic',
  'app.desktopNote': '有未保存的改动时，重新加载与退出都会先弹确认框。',

  /* —— 许可 —— */
  /*
   * 这一页**只列名称**：包名 / 字体名 / 上游仓库与 SPDX 短名都是标识符，留在
   * 组件里不进语言文件；要翻译的只有这三个分组标题和末尾那一句指针。
   */
  'app.licenseMeta': '项目名称和许可证类型',
  'app.licenseCode': '代码',
  'app.licenseAssets': '素材',
  'app.licenseDeps': '依赖',
  'app.licenseFull': '完整内容见 OxygenNine/artmatic 的 CREDITS.md',

  /* ------------------------------------------------ 顶栏与关闭确认 */
  'app.openProjects': '打开的工程',
  'app.unsavedChanges': '有未保存改动',
  'app.backToTimeline': '回到时间轴',
  'app.closeProjectTab': '关闭 {name}',
  'app.newProject': '新建工程',
  'app.newProjectTip': '新建工程',
  'app.discardTitle': '放弃未保存的改动？',
  'app.discardMessage': '「{name}」有未保存的改动，放弃改动会丢失工作内容。',
  'app.discardConfirm': '放弃改动并关闭',
  'app.back': '返回',
  'app.projectGone': '这份工程已经不在了',

  /* ------------------------------------------------ 空界面（一份工程都没开） */
  /* 只有一句「从哪开始」。空界面上不该有第二句解释 —— 能做的事就那几件。 */
  'app.emptyLead': '新建一份工程，或打开磁盘上已有的工程目录。',
  'app.emptyDemo': '打开示例工程',
  'app.emptyDemoTip': '24 秒的样片：六条轨道各走通一条通路（排版 / 转场 / 反馈特效 / 模拟）',
  'app.restoreTabsHint': '要恢复上次打开的工程吗？',
  'app.restoreTabsDo': '恢复',
  'app.restoreTabsDismiss': '忽略',
  'app.restoreTabsFailed': '恢复失败，请从下方「最近的工程」里手动打开。',
  'app.emptyImport': '导入工程',
  'app.emptyRecentEmpty': '还没有打开过工程。',

  /* ------------------------------------------------ 底栏 */
  'app.fpsTip': '预览帧率',

  /* ------------------------------------------------ 快捷键冲突提示（App.svelte） */
  'app.noTrackFits': '上下都没有能装下这个片段的轨道了',
  'app.targetOccupied': '目标轨没有多余空间',

  /* ------------------------------------------------ 品牌色预置名 */
  /* 只在设置面板的色块 aria-label 与「当前品牌」文字里出现。 */
  'app.accentViolet': '紫',
  'app.accentCyan': '青',
  'app.accentLime': '黄绿',
  'app.accentAmber': '琥珀',

  /* ------------------------------------------------ 启动能力闸门（main.ts） */
  /* 缺 WebGL2 / 目录选择时只渲染这段说明，不挂主应用。 */
  'app.capabilityGate.title': '这个浏览器跑不了 Artmatic',
  'app.capabilityGate.noWebgl2': '它需要 WebGL2 来做预览与导出，而这个浏览器没有可用的 WebGL2 上下文。',
  'app.capabilityGate.noDirPicker':
    '它需要 File System Access（选择本地目录）来保存工程，而这个浏览器不支持它。',
  'app.capabilityGate.hint': '请改用桌面版，或最新版 Chrome / Edge。',
} as const;
