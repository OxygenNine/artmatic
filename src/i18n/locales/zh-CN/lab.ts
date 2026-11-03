/**
 * lab.ts — 试炼场（/lab/）的文案。
 *
 * 试炼场是独立的第二个 HTML 入口，用的是同一个 i18n 模块（`tr()` 读的
 * locale 是 `$state`，Svelte 模板里调用会自动建立依赖）。
 *
 * 特效与生成器的**名字不在这里**：它们由各自的注册表提供 `nameKey`
 * （`fx.*` / `algo.*`，都在 media.ts）。注册表只存 key 不存译文——
 * 定义表在模块加载时求值一次，直接写 `tr()` 会把语言冻在导入那一刻。
 */
export const lab = {
  'lab.title': '试炼场',
  'lab.subtitle': '单独检查每个生成器和特效',

  // —— 左栏
  'lab.groupSource': '源',
  'lab.groupEffect': '特效',
  'lab.searchPlaceholder': '搜索…',
  'lab.none': '（无）',
  'lab.kindBake': '烘焙',
  'lab.kindSim': '模拟',
  'lab.kindRealtime': '实时',
  'lab.kindLab': '内置',

  // —— 中栏工具栏
  'lab.stage': '舞台',
  'lab.play': '播放',
  'lab.pause': '暂停',
  'lab.stepBack': '上一帧',
  'lab.stepForward': '下一帧',
  'lab.scale': '分辨率',
  'lab.bypass': '旁路',
  'lab.bypassHint': '按住 B 看源（对比原图）',
  'lab.compileAll': '全部编译',
  'lab.compileAllTip': '把所有特效/算法/转场的着色器编一遍，提前暴露语法错误',
  'lab.backToApp': '回到编辑界面',
  'lab.srcReady': '就绪',
  'lab.srcPending': '等待中',
  'lab.srcLabel': '源',
  'lab.timeLabel': '时间',
  'lab.hint': '↑↓ 切换 · Space 播放 · B 旁路 · R 重置',

  // —— 右栏
  'lab.paramsSource': '源参数',
  'lab.paramsEffect': '特效参数',
  'lab.noParams': '该条目没有参数',
  'lab.reset': '重置',
  'lab.resetTip': '把当前源与特效的参数恢复成默认值（快捷键 R）',
  'lab.randomize': '随机',
  'lab.randomizeTip': '用种子随机数打乱参数（同一种子结果永远相同）',
  'lab.errorLog': '编译日志',

  // —— 编译
  'lab.compileRunning': '正在编译…',
  'lab.compileAllOk': '全部通过：{n} 个',
  'lab.compileSomeBad': '{bad} / {n} 编译失败（列表中标红）',
  'lab.compileNever': '尚未编译。基线：{n} 个',

  // —— 内置测试图
  'lab.patBars': '彩条',
  'lab.patGrid': '网格',
  'lab.patGradient': '渐变',

  // —— 导出截图
  /* 「导出截图」用的是**当前舞台**尺寸（把正在看的东西存下来），
     高度下拉只管批量 —— 所以它叫「批量高度」，别让人以为两个按钮都受它管。 */
  'lab.shot': '导出截图',
  'lab.shotTip': '把当前舞台画面存成 PNG（尺寸 = 当前舞台），文件名就是特效 id',
  'lab.shotAll': '批量导出缩略图',
  'lab.shotAllTip':
    '按目录底图给每个特效渲一张，打包成 zip —— 解压进 src/assets/effect-thumbnails/ 即可。' +
    '注意：那是按目录自动选的底图，会覆盖仓库里手挑过的那一套',
  'lab.shotHeight': '批量高度',
  'lab.shotRunning': '导出中 {done}/{total}',
  'lab.shotOneDone': '已存 {name}',
  'lab.shotAllDone': '已导出 {n} 张 · {size}',
  'lab.shotFailed': '导出失败：{msg}',

  // —— 空态
  'lab.noSource': '没选源',
} as const;
