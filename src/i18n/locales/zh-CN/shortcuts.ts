/**
 * shortcuts.ts — 快捷键清单（分组标题 + 每条的按键列 + 描述列）。
 *
 * 前缀：`sc.*`
 *
 * 连**按键列**也进语言文件，是因为它不是纯组合键：'标尺拖动'、'拖边'、
 * '空白处拖动' 这些是鼠标手势的名字，本来就是要翻译的。既然一列里有
 * 两种东西，与其搞个 `keys: MessageKey | string` 的混合类型，不如统一成
 * 展示字符串 —— 顺带让 macOS 版可以说 '⌘S'。
 *
 * 真正判定的仍是 `KeyboardEvent` 的 key/code（在 App.svelte 与
 * typography/keys.ts 里），改这里的字**不会**改行为。
 */

export const shortcuts = {
  /* ------------------------------------------------ 分组标题 */
  'sc.group.playback': '播放与时间',
  'sc.group.clip': '片段',
  'sc.group.focus': '焦点与面板',
  'sc.group.typo': '排版编辑器',
  'sc.group.param': '参数控件',
  'sc.group.project': '工程',
  'sc.group.general': '通用',

  /* ------------------------------------------------ 按键列（含鼠标手势名） */
  'sc.key.space': 'Space',
  'sc.key.rulerDrag': '标尺拖动',
  'sc.key.ctrlWheel': 'Ctrl+滚轮',
  'sc.key.wheel': '滚轮',
  'sc.key.drag': '拖动',
  'sc.key.dragEdge': '拖边',
  'sc.key.dblClick': '双击片段 / Enter',
  'sc.key.renameClip': 'F2',
  'sc.key.k': 'K',
  'sc.key.s': 'S',
  'sc.key.h': 'H',
  'sc.key.altArrows': 'Alt+↑ / Alt+↓',
  'sc.key.delete': 'Delete',
  'sc.key.ctrlC': 'Ctrl+C',
  'sc.key.ctrlX': 'Ctrl+X',
  'sc.key.ctrlV': 'Ctrl+V',
  'sc.key.rightClick': '右键',
  'sc.key.clickShiftClick': '单击 / Shift+单击',
  'sc.key.shiftClickClip': 'Shift+单击片段',
  'sc.key.dragSelection': '拖动已选片段',
  'sc.key.dragEmpty': '空白处拖动',
  'sc.key.dragElement': '拖动元素',
  'sc.key.arrows': '方向键',
  'sc.key.ctrlA': 'Ctrl+A',
  'sc.key.esc': 'Esc',
  /* 焦点与面板（`ui/focus-panels.ts`） */
  'sc.key.shiftDigits': 'Shift+1…6',
  'sc.key.ctrlShiftDot': 'Ctrl+Shift+.',
  'sc.key.enter': 'Enter',
  'sc.key.arrowsLr': '← / →',
  'sc.key.dragNumber': '拖动数字框',
  'sc.key.ctrlDrag': 'Ctrl 拖动',
  'sc.key.altDrag': 'Alt 拖动',
  'sc.key.shiftDrag': 'Shift 拖动',
  'sc.key.upDown': '↑ / ↓',
  'sc.key.ctrlS': 'Ctrl+S',
  'sc.key.ctrlShiftS': 'Ctrl+Shift+S',
  /*
   * 另外三个方案的切分键（「操作习惯」）。它们与 Artmatic 默认的 `sc.key.s`
   * 是同一条数据的四种取值 —— 底栏提示要说**当前生效**的那个键，
   * 而写死字面量的那份副本迟早会与方案表漂移。
   */
  'sc.key.ctrlK': 'Ctrl+K',
  'sc.key.ctrlShiftD': 'Ctrl+Shift+D',
  'sc.key.ctrlB': 'Ctrl+B',
  'sc.key.ctrlZ': 'Ctrl+Z',
  'sc.key.ctrlShiftZ': 'Ctrl+Shift+Z / Ctrl+Y',

  /* ------------------------------------------------ 描述列 */
  'sc.playPause': '播放 / 暂停',
  'sc.scrub': '移动播放头',
  'sc.zoomAtCursor': '以鼠标为中心缩放时间轴',
  'sc.scrollTimeline': '时间轴横向滚动',
  'sc.moveClip': '移动片段',
  'sc.resizeClip': '改变片段长度',
  'sc.openClipEditor': '打开片段编辑器',
  'sc.renameClip': '重命名选中的片段',
  'sc.openCurveEditor': '打开关键帧曲线编辑器',
  'sc.splitAtPlayhead': '在播放头处切分选中片段',
  'sc.toggleClipHidden': '隐藏 / 显示选中片段',
  'sc.shiftTrack': '把选中片段上移 / 下移一轨',
  'sc.deleteClip': '删除选中片段',
  /* 片段剪贴板：复制/剪切进系统剪贴板（自有 JSON），粘贴认这个格式。
     跨工程粘贴时缺失的素材按「脱机媒体」占位符表现。 */
  'sc.copyClips': '复制选中片段',
  'sc.cutClips': '剪切选中片段',
  'sc.pasteClips': '在播放头处粘贴片段',
  'sc.marqueeClips': '拖动空白处框选多个片段',
  'sc.addRemoveClip': '加选 / 减选片段',
  'sc.moveClips': '整组移动选中片段（含音频则只能水平移动）',
  'sc.newClipAtCursor': '在鼠标位置新建片段',
  'sc.clipNeighbor': '焦点移到时间上的相邻片段',
  'sc.panelFocus': '打开 / 跳转面板，焦点进入该面板',
  'sc.cyclePanels': '在面板之间轮询焦点',
  'sc.releaseFocus': '释放焦点（离开输入框 / 按钮 / 面板）',
  'sc.commitInput': '提交并离开输入框',
  'sc.selectElement': '选中元素 / 加选',
  'sc.marquee': '框选',
  'sc.moveElement': '移动（自动吸附参考线；按住 Alt 临时关吸附）',
  'sc.nudgeElement': '移动 1px（Shift ×10）',
  'sc.selectAll': '全选元素',
  'sc.deselect': '取消选择',
  'sc.playPauseAnim': '播放 / 暂停',
  'sc.scrubValue': '连续改值',
  'sc.snapToStep': '吸附到步长整数倍',
  'sc.fineTune': '精细（灵敏度 ×0.1）',
  'sc.coarseTune': '粗调（灵敏度 ×10）',
  'sc.cancelDrag': '取消这次拖动，恢复原值',
  'sc.stepValue': '按步长增减（Shift ×10）',
  'sc.saveProject': '保存工程（没有位置时会先问目录）',
  'sc.saveAs': '另存为（选一个新目录）',
  'sc.undo': '撤销',
  'sc.redo': '重做',
  'sc.closeOverlay': '关闭弹窗',
} as const;
