/**
 * grade —— 调色面板（`ui/grade/`）的文案。
 *
 * 与检查器分开一个域：调色面板是**专用编辑器**（三栏 + 示波器），它的文案
 * 增长方式与检查器那种「一参数一行」完全不同，混在一起以后会找不到。
 */
export const grade = {
  'grade.title': '调色',
  'grade.reset': '复位这个轮盘',
  'grade.resetShort': '复位',
  'grade.resetAll': '全部复位',
  'grade.before': '看原片',
  'grade.after': '看调色',
  'grade.showOriginal': '对照原片',
  'grade.showGraded': '回到调色',
  'grade.compareTip': '比对调色更改',
  'grade.colWheels': '一级校色轮',
  'grade.colCurves': '曲线',
  'grade.colScopes': '示波器',
  'grade.colLut': '查找表',
  'grade.panelExpand': '展开{name}面板',
  'grade.panelCollapse': '收起{name}面板',
  'grade.masterShort': 'Y',
  'grade.moduleDisabled': '这个模块已停用，改动不会影响画面。',
  'grade.enableModule': '启用',
  'grade.splitPanels': '拖动调整宽度',
  'grade.splitDock': '拖动调整高度',
  'grade.scrub': '播放进度',
  'grade.exitTip': '回到时间轴（Esc）',
  'grade.resizeDock': '拖动调整宽度',

  /* 分级信息条：这是「我以为在调这个镜头」的唯一防线，必须说清作用范围。 */
  'grade.infoAll': '作用于其下的所有轨道',
  'grade.infoTracks': '作用于 {names}',
  'grade.infoBound': '只作用于「{name}」',
  'grade.infoEmpty': '无受影响片段',

  'grade.noWheel': '这个模块没有色轮，参数在下方。',
  'grade.other': '其余',
  'grade.module': '模块',

  /* 曲线 */
  'grade.curveMaster': 'Y',
  'grade.curveChannelR': 'R',
  'grade.curveChannelG': 'G',
  'grade.curveChannelB': 'B',
  'grade.curveHint': '拖动控制点；双击空白加一个点，双击控制点删除。',
  'grade.curvePrev': '上一页曲线',
  'grade.curveNext': '下一页曲线',
  'grade.curveHintShort': '双击加点 / 删点',
  'grade.curvesMissing': '这条链上还没有曲线模块。',
  'grade.addCurves': '加上曲线',
  'grade.curveReset': '拉直',
  'grade.curveCount': '{n} 个点',
  'grade.curvePoint': '第 {n} 个控制点',

  /* LUT */
  'grade.lutImport': '导入 .cube',
  'grade.lutNone': '未载入 LUT',
  'grade.lutSpace': '输入空间',
  'grade.lutSpaceSrgb': 'sRGB',
  'grade.lutSpaceLinear': '线性',
  'grade.lutSpaceLogC': 'Log-C',
  'grade.lutSize': '{size} 阶',
  'grade.lutMissing': 'LUT 素材不在工程里',
  'grade.lutError': 'LUT 读取失败（{reason}）',
  'grade.lutEmpty': '还没有导入任何 .cube。',

  /* 示波器 */
  'grade.scopeWaveform': '波形',
  'grade.scopeParade': '分量',
  'grade.scopeVector': '矢量',
  'grade.scopeHistogram': '直方图',
  'grade.scopeEncoded': '编码值',
  'grade.scopeEmpty': '还没有画面',
  'grade.scopeLinear': '线性',
};
