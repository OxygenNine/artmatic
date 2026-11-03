/**
 * curve.ts — 关键帧曲线编辑器。
 *
 * 前缀 `curve.*`。术语约定：
 *   - 「关键帧」是数据点，「曲线」是整条 `Curve`；
 *   - 「插值」一律指**出向**（本关键帧之后那一段），界面说明里要讲清楚，
 *     否则用户会以为改一个中间关键帧能同时改两侧。
 */
export const curve = {
  'curve.title': '关键帧曲线',
  'curve.open': '编辑曲线',
  'curve.openMenu': '编辑关键帧曲线…',
  'curve.close': '关闭曲线编辑器',
  'curve.toggleParams': '折叠 / 展开参数栏',
  'curve.resize': '拖动调整窗口大小',

  'curve.group.clip': '片段',
  'curve.group.algo': '生成器参数',
  'curve.group.effect': '特效参数',
  'curve.group.audio': '音频',
  'curve.group.other': '其它',
  'curve.gain': '音量',

  'curve.addHint': '点击「{label}」在播放头处新建曲线',
  'curve.addCurve': '新建曲线',
  'curve.empty': '这个片段还没有关键帧',
  'curve.emptyHint': '从左侧列表选择一个参数添加曲线',

  'curve.interp': '插值',
  'curve.interpLinear': '线性',
  'curve.interpStep': '阶梯',
  'curve.interpSmooth': '平滑',
  'curve.interpBezier': '贝塞尔',
  'curve.interpTip': '插值作用于关键帧之后',

  'curve.deleteKey': '删除关键帧',
  'curve.autoHandles': '自动手柄',
  'curve.moveKey': '移动关键帧',
  'curve.editHandles': '调整贝塞尔手柄',
  'curve.setInterp': '修改插值',
  'curve.setValue': '修改关键帧值',
  'curve.addKey': '添加关键帧',
  'curve.deleteKeys': '删除 {n} 个关键帧',

  'curve.time': '时间',
  'curve.value': '值',
  'curve.selected': '已选 {n}',
  'curve.hint': '单击图内加点 · 双击关键帧删除 · 拖动移动 · Shift 多选 · Alt 关闭吸附',
  'curve.handleOut': '出向贝塞尔手柄',
  'curve.handleIn': '入向贝塞尔手柄',
  'curve.graphAria': '关键帧曲线图',
  'curve.keyAria': '关键帧 {n}：{t}s = {v}',
} as const;
