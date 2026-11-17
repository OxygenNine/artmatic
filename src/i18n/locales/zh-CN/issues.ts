/**
 * issues.ts — 画面批注标记（Issues）。
 *
 * 前缀 `iss.*`（`issues` 与项目里其它前缀不冲突；`tl.` 留给时间轴本身）。
 * 术语：
 *   - 「标记」= 某一帧上的一个矩形 + 一句注释（`Project.issues` 的一条）；
 *   - 「问题标记」是面板 / 侧栏的名字，也是这套功能的用户可见叫法。
 */
export const issues = {
  'iss.title': '画面标记',
  'iss.openTip': '画面标记',
  'iss.close': '关闭问题标记面板',
  'iss.resize': '拖动调整面板宽度',
  'iss.count': '{n} 条',
  'iss.empty': '还没有标记',
  'iss.emptyHint': '在画面里右键，标出有问题的地方',

  'iss.markHere': '在画面标记问题',
  'iss.editNote': '编辑注释',
  'iss.remove': '删除标记',
  'iss.clear': '清空全部',
  'iss.clearTitle': '清空问题标记',
  'iss.clearBody': '删除全部 {n} 条标记？',
  'iss.deleteTitle': '删除标记',
  'iss.deleteBody': '标记 {n}：{note}',

  'iss.note': '注释',
  'iss.notePlaceholder': '添加一些注释…',
  'iss.color': '标记颜色',
  'iss.start': '起点',
  'iss.duration': '时长',
  'iss.done': '完成',
  'iss.jump': '跳到这一帧',
  'iss.marker': '标记 {n}',
  'iss.add': '添加问题标记',
  'iss.update': '修改问题标记',
  'iss.clearLabel': '清空问题标记',
  'iss.sizeHint': '可在时间轴拖曳标记头设置时长',
  'iss.selected': '当前标记',
};
