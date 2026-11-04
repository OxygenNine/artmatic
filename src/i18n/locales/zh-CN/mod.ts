/**
 * mod.ts — 调制器（表达式）面板。
 *
 * 前缀 `mod.*`。术语约定：
 *   - 「调制器」是一条**工程级**表达式（`Project.modulators`），不是片段的属性；
 *   - 「调制」（调制槽）是参数上对某个调制器的一次引用，带增益与叠加方式；
 *   - 「积木」是 AST 的编辑视图，「文本」是同一个 AST 的另一张脸。
 *
 * 函数名（`sin` / `clamp` / `noise`…）**不在这里** —— 它们是用户在文本模式里
 * 亲手打的标识符，翻译了就对不上。积木里也只显示原名。
 */
export const mod = {
  'mod.title': '调制器',
  'mod.open': '打开调制器面板',
  'mod.openTip': '表达式 + 拖到参数上叠加',
  'mod.close': '关闭调制器面板',
  'mod.resize': '拖动调整面板宽度',

  'mod.new': '新建调制器',
  'mod.empty': '还没有调制器',
  'mod.emptyHint': '新建一个，再把它拖到任意数值参数上',
  'mod.tooMany': '调制器最多 {max} 个',
  'mod.defaultName': '调制 {n}',
  'mod.rename': '重命名',
  'mod.delete': '删除',
  'mod.deleteTitle': '删除调制器',
  'mod.deleteBody': '「{name}」被 {n} 处参数引用，删除后那些参数会回到静态值。',
  'mod.deleteFree': '「{name}」没有被任何参数引用。',

  'mod.edit': '编辑表达式',
  'mod.name': '名称',
  'mod.expr': '表达式',
  'mod.exprHint': 't = 秒，beat = 拍。闭式，不能跨帧递推',
  'mod.range': '显示范围',
  'mod.rangeMin': '下限',
  'mod.rangeMax': '上限',
  'mod.preview': '当前值',
  'mod.refs': '{n} 处引用',

  'mod.view.blocks': '积木',
  'mod.view.text': '文本',
  'mod.view.switch': '切换编辑方式',
  'mod.textApply': '应用',

  'mod.blk.num': '数值',
  'mod.blk.time': '时间 t',
  'mod.blk.beat': '拍',
  'mod.blk.mod': '调制器',
  'mod.blk.unary': '负号',
  'mod.blk.add': '运算',
  'mod.blk.text': '文本',
  'mod.blk.pick': '选择积木',
  'mod.blk.noMod': '还没有调制器可选',
  'mod.blk.group.value': '值',
  'mod.blk.group.time': '时间',
  'mod.blk.group.ref': '引用',
  'mod.blk.group.math': '数学',
  'mod.blk.group.wave': '波形与噪声',
  'mod.blk.clear': '清零（换成 0）',
  'mod.blk.port': '拖到这里改接',
  'mod.graph.fit': '适应画布',
  'mod.graph.tidy': '自动排列',

  'mod.err.unexpectedChar': '第 {at} 个字符不认识',
  'mod.err.badNumber': '数字写错了',
  'mod.err.unclosedString': '引号没有闭合',
  'mod.err.unexpectedToken': '这里不该出现这个符号',
  'mod.err.unexpectedEnd': '表达式没写完',
  'mod.err.unknownIdent': '不认识的变量名',
  'mod.err.unknownFunc': '没有这个函数',
  'mod.err.badArity': '函数参数个数不对',
  'mod.err.empty': '表达式是空的',
  'mod.err.tooDeep': '嵌套太深',
  'mod.slot.live': '实际值',
  'mod.slot.remove': '移除这一档',
  'mod.slot.gain': '增益',
  'mod.slot.mode': '叠加方式',
  'mod.slot.modeAdd': '相加',
  'mod.slot.modeMul': '相乘',
  'mod.slot.broken': '调制器已不存在',

  'mod.badge.kc': 'KC',
  'mod.badge.mod': 'M',
  'mod.badge.both': 'KC+M',
  'mod.badge.tip': '关键帧 / 调制状态，点开管理调制',

  'mod.dropHint': '松手绑定到「{label}」',

  'mod.add': '新建调制器',
  'mod.editExpr': '修改表达式',
  'mod.setRange': '改显示范围',
  'mod.remove': '删除调制器',
  'mod.bind': '绑定调制器',
};
