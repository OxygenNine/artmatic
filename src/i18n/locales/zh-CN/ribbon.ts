/**
 * ribbon.ts — 排版编辑器的 Ribbon（选项卡 / 分组 / 按钮 / 下拉选项）。
 *
 * 前缀：`rib.*`
 *
 * 这里条目最多（原 `ribbon-defs.ts` 一个文件就有 100 处），因为它是一张
 * 数据驱动的表：每个按钮的 label / tip 都从这张表取。
 *
 * > 形状名 / 动画预设名 / 混合模式名**不在这里** —— 它们在 `media.ts`
 * > （`shape.*` / `anim.*` / `blend.*`），由数据表里的 `labelKey` 指过来。
 */

export const ribbon = {
  /* ------------------------------------------------ 选项卡 */
  'rib.home': '开始',
  'rib.insert': '插入',
  'rib.design': '设计',
  'rib.anim': '动画',
  'rib.view': '视图',
  'rib.shapeFormat': '图形格式',
  'rib.imageFormat': '图片格式',

  /* ------------------------------------------------ 分组标题 */
  'rib.group.font': '字体',
  'rib.group.canvas': '画布',
  'rib.group.theme': '配色方案',
  'rib.group.themeColor': '主题色',
  'rib.group.para': '段落',
  'rib.group.alignTextH': '水平对齐',
  'rib.group.alignTextV': '垂直对齐',
  'rib.group.text': '文本',
  'rib.group.icons': '图标',
  'rib.group.align': '对齐',
  'rib.group.order': '层级',
  'rib.group.edit': '编辑',
  'rib.group.formatCopy': '复制格式',
  'rib.group.animCopy': '复制动画',
  'rib.group.shapes': '图形',
  'rib.group.media': '图片',
  'rib.group.presets': '预设',
  'rib.group.advancedAnim': '高级动画',
  'rib.group.fill': '填充',
  'rib.group.stroke': '描边',
  'rib.group.shape': '形状',
  'rib.group.effects': '艺术效果',
  'rib.group.imageStyle': '图片样式',
  'rib.group.imageBg': '删除背景',
  'rib.group.imageQuad': '四角',
  'rib.group.imageAdjust': '调整',
  'rib.group.imageCrop': '裁剪',
  'rib.group.imageAlign': '排列',

  /* ------------------------------------------------ 视图 */
  'rib.group.grid': '网格',
  'rib.group.gridLines': '参考线',
  'rib.gridShow': '显示网格',
  'rib.gridSnap': '吸附网格',
  'rib.gridUnit': '网格单位',
  'rib.gridPx': '像素',
  'rib.gridPercent': '画幅 %',
  'rib.gridSize': '间距',
  'rib.gridVertical': '竖线',
  'rib.gridHorizontal': '横线',
  'rib.canvasFrame': '画幅线框',

  /* ------------------------------------------------ 图形格式 → 形状参数 */
  'rib.sides': '边数',
  'rib.starWaist': '锐利度',
  'rib.borderWidth': '壁厚',
  'rib.pieAngle': '张角',
  'rib.nodeEdit': '编辑顶点',
  'rib.group.nodes': '顶点',
  'rib.toPath': '转为路径',

  /* ------------------------------------------------ 图形格式 → 布尔运算 */
  'rib.group.boolean': '布尔运算',
  'rib.boolUnion': '并集',
  'rib.boolSubtract': '差集',
  'rib.boolIntersect': '交集',
  'rib.boolXor': '异或',
  'rib.boolDivide': '拆分',

  /* ------------------------------------------------ 图形格式 → 填充 */
  'rib.fillKind': '填充类型',
  'rib.fillNoneShort': '无填充',
  'rib.fillSolid': '纯色',
  'rib.fillLinear': '线性渐变',
  'rib.fillRadial': '径向渐变',
  'rib.fillTexture': '纹理',
  'rib.gradientFrom': '起始色',
  'rib.gradientTo': '结束色',
  'rib.gradientAngle': '渐变角度',
  'rib.textureInk': '纹理色',
  'rib.textureBg': '底色',
  'rib.texturePattern': '图案',
  'rib.textureScale': '周期',
  'rib.textureThickness': '线宽',
  'rib.group.textFill': '文字填充',
  'rib.textFillFollow': '跟随文字色',
  /* ------------------------------------------------ 开始 → 文字转路径 */
  'rib.group.textPath': '路径',
  'rib.textToPath': '文字转路径',

  /* ------------------------------------------------ [Contextual] 组合格式 */
  'rib.groupFormat': '组合格式',
  'rib.group.groupBox': '组合外框',
  'rib.groupBackdrop': '背景',
  'rib.groupBorder': '边框色',
  'rib.groupBorderWidth': '边框宽度',
  'rib.groupRadius': '外框圆角',
  'rib.groupPadding': '内边距',
  'rib.groupAction': '组合',
  'rib.ungroup': '解除组合',
  /* ------------------------------------------------ 开始 → 字体 */
  'rib.fontFamily': '字体',
  'rib.fontSearch': '搜索字体',
  'rib.fontSize': '字号',
  'rib.fontSizeDown': '减小字号',
  'rib.fontSizeUp': '增大字号',
  'rib.bold': '加粗',
  'rib.italic': '斜体',
  'rib.underline': '下划线',
  'rib.strike': '删除线',
  'rib.clearFormat': '清除全部格式',
  'rib.textShadow': '阴影',
  'rib.textShadowOn': '关闭阴影',
  'rib.textHighlight': '突出显示颜色',
  'rib.fontColor': '字体颜色',
  'rib.caseTransform': '大小写',
  'rib.caseNone': '无转换',
  'rib.caseUpper': '全部大写',
  'rib.caseLower': '全部小写',
  'rib.caseCapitalize': '每个单词首字母大写',
  'rib.spacingVeryTight': '很紧',
  'rib.spacingTight': '紧密',
  'rib.spacingNormal': '常规',
  'rib.spacingLoose': '疏松',
  'rib.spacingVeryLoose': '很松',
  'rib.spacingWider': '更松',
  'rib.spacingCustom': '自定义',
  'rib.loadLocalFonts': '本机字体',
  'rib.importFont': '导入字体',

  /* ------------------------------------------------ 开始 → 段落 */
  'rib.letterSpacing': '字距',
  'rib.lineHeight': '行高',
  'rib.alignHLeft': '左',
  'rib.alignHCenter': '中',
  'rib.alignHRight': '右',
  'rib.alignHJustify': '两端',
  'rib.alignVTop': '顶',
  'rib.alignVMiddle': '中',
  'rib.alignVBottom': '底',

  /* ------------------------------------------------ 开始 → 文本颜色 */
  'rib.color': '颜色',

  /* ------------------------------------------------ 开始 → 对齐 */
  'rib.alignTo': '对齐到',
  'rib.alignTargetCanvas': '画布',
  'rib.alignTargetSelection': '选区',
  'rib.alignLeft': '左对齐',
  'rib.centerH': '水平居中',
  'rib.alignRight': '右对齐',
  'rib.alignTop': '顶对齐',
  'rib.centerV': '垂直居中',
  'rib.alignBottom': '底对齐',
  'rib.distributeH': '横向分布',
  'rib.distributeV': '纵向分布',

  /* ------------------------------------------------ 开始 → 层级 */
  /* 「上移 / 下移」用 common.up / common.down。 */
  'rib.toFront': '置顶',
  'rib.toBack': '置底',

  /* ------------------------------------------------ 开始 → 编辑 */
  /* 「删除」用 common.delete。 */
  'rib.addText': '文本框',
  'rib.duplicate': '复制',
  'rib.lock': '锁定',
  'rib.hide': '隐藏',

  /* ------------------------------------------------ 格式刷 / 动画刷 */
  'rib.formatPainter': '格式刷',
  'rib.animPainter': '动画刷',

  /* ------------------------------------------------ 插入 */
  'rib.shape': '形状',
  'rib.pickShape': '选择形状…',
  'rib.addImage': '插入图片',
  'rib.addIcon': '插入图标',
  /* 「插入」页里的媒体池开合（与 Rail 上那个图标同一个状态）。 */
  'rib.mediaPool': '媒体池',

  /* ------------------------------------------------ 动画 → 预设 */
  // 图库触发按钮（PPT 的「添加动画」）。点一下 = 在播放头插一段，不是「选择当前值」。
  'rib.addAnim': '添加动画',
  'rib.clearAnim': '清除动画',
  // 常驻预设条两端的翻页键（只有无障碍名，界面上是 < > 两个箭头）。
  'rib.animPagePrev': '上一页',
  'rib.animPageNext': '下一页',

  /* ------------------------------------------------ 动画 → 编辑 */
  'rib.customCss': '自定义 CSS',
  'rib.flatten': '转为图片',

  /* ------------------------------------------------ 图形格式 */
  'rib.shapeFill': '填充',
  'rib.strokeColor': '描边色',
  'rib.strokeWidth': '线宽',
  'rib.strokeStyle': '线型',
  'rib.lineSolid': '实线',
  'rib.lineDashed': '虚线',
  'rib.lineDotted': '点线',
  'rib.radius': '圆角',
  'rib.blend': '混合模式',
  'rib.opacity': '不透明度',

  /* ------------------------------------------------ 图片格式 */
  'rib.imageFit': '适配',
  'rib.fitFill': '拉伸',
  'rib.fitContain': '完整显示',
  'rib.fitCover': '铺满裁切',
  'rib.fitNone': '原始尺寸',
  'rib.imageRadius': '圆角',
  'rib.imageBorderColor': '边框色',
  'rib.imageBorderWidth': '边框',
  'rib.imageKey': '删除背景',
  'rib.imageKeyColor': '键色',
  'rib.imageQuad': '四角调整',
  'rib.imageQuadReset': '复位',
  'rib.imageAdjust': '色彩校正',
  'rib.imageRecolor': '重新着色',
  'rib.imageFilter': '滤镜',
  'rib.imageCrop': '裁剪',
  'rib.imageSize': '调整大小',
  'rib.imageClipShape': '裁剪为形状',
  'rib.imageAlignCanvas': '对齐画布',
  'rib.imgAlignCenter': '居中',
  'rib.imgAlignCenterH': '水平居中',
  'rib.imgAlignCenterV': '垂直居中',
  'rib.imgAlignFit': '适应画布',
  'rib.imgAlignFill': '铺满画布',
  'rib.imgAlignStretch': '拉伸铺满',
  'rib.cropOriginal': '原始比例',
  'rib.cropSquare': '1:1 正方形',
  'rib.crop4x3': '4:3',
  'rib.crop3x4': '3:4',
  'rib.crop16x9': '16:9',
  'rib.crop9x16': '9:16',
  'rib.crop3x2': '3:2',
  'rib.crop2x3': '2:3',
  'rib.cropReset': '恢复整图',

  /* ------------------------------------------------ 图片浮层（二次菜单） */
  'rib.imgBrightness': '亮度',
  'rib.imgContrast': '对比度',
  'rib.imgSaturation': '饱和度',
  'rib.imgSharpen': '锐化',
  'rib.imgSoften': '柔化',
  'rib.imgCurves': '曲线',
  'rib.imgCurveMaster': 'RGB',
  'rib.imgCurveR': 'R',
  'rib.imgCurveG': 'G',
  'rib.imgCurveB': 'B',
  'rib.imgCurveReset': '重置曲线',
  'rib.imgResetAll': '清空所有曲线',
  'rib.imgRecolorLight': '亮部',
  'rib.imgRecolorShadow': '暗部',
  'rib.imgRecolorAmount': '强度',
  'rib.imgFilterAmount': '强度',
  'rib.imgFilterNone': '无滤镜',
  'rib.imgSizeWidth': '宽',
  'rib.imgSizeHeight': '高',
  'rib.imgSizeLock': '锁定比例',
  'rib.imgSizePercent': '按比例',
  'rib.imgSizeOriginal': '原始大小',
  'rib.imgClose': '关闭',

  /* ------------------------------------------------ 滤镜名（17 个） */
  'rib.imgfx.grayscale': '黑白',
  'rib.imgfx.sepia': '复古',
  'rib.imgfx.invert': '反色',
  'rib.imgfx.posterize': '色调分离',
  'rib.imgfx.threshold': '阈值',
  'rib.imgfx.duotone': '双色调',
  'rib.imgfx.blur': '模糊',
  'rib.imgfx.sharpen': '锐化',
  'rib.imgfx.emboss': '浮雕',
  'rib.imgfx.sketch': '素描',
  'rib.imgfx.neon': '霓虹边缘',
  'rib.imgfx.mosaic': '马赛克',
  'rib.imgfx.halftone': '半调网点',
  'rib.imgfx.vignette': '暗角',
  'rib.imgfx.glitch': '故障',
  'rib.imgfx.noise': '噪点',
  'rib.imgfx.scanlines': '扫描线',

  /* ------------------------------------------------ 取色卡（Office 式） */
  'rib.pick.themeColors': '主题颜色',
  'rib.pick.standardColors': '标准色',
  'rib.pick.recentColors': '最近使用的颜色',
  'rib.pick.moreColors': '其他颜色…',
  'rib.pick.eyedropper': '取色器',
  'rib.pick.eyedropperHint': '当前浏览器不支持屏幕取色',
  'rib.pick.none': '无颜色',
  'rib.pick.current': '当前颜色',
  'rib.pick.aria': '选择颜色',

  /* ------------------------------------------------ 配色方案槽位与变体 */
  'rib.slot.lt1': '背景色 1',
  'rib.slot.dk1': '文字色 1',
  'rib.slot.lt2': '背景色 2',
  'rib.slot.dk2': '文字色 2',
  'rib.slot.accent1': '强调色 1',
  'rib.slot.accent2': '强调色 2',
  'rib.slot.accent3': '强调色 3',
  'rib.slot.accent4': '强调色 4',
  'rib.slot.accent5': '强调色 5',
  'rib.slot.accent6': '强调色 6',
  'rib.shade.l80': '浅色 80%',
  'rib.shade.l60': '浅色 60%',
  'rib.shade.l40': '浅色 40%',
  'rib.shade.d25': '深色 25%',
  'rib.shade.d50': '深色 50%',

  /* ------------------------------------------------ [设计] 画布 */
  /* 「画布大小」：画幅（文档像素 / 比例）与上屏缩放。尺寸读数在浮层里，
     按钮上只写动作 —— Ribbon 的标签是静态文案，塞不进实时数字。 */
  'rib.canvasSize': '画布大小',

  /* ------------------------------------------------ [设计] 配色方案 */
  'rib.themeGallery': '配色方案',
  'rib.themeCurrent': '当前',
  /* 「应用到整个项目」：一次写所有文本片段 + 新片段默认（Project.typographyTheme）。
     与图库的区别：图库只改当前文档。 */
  'rib.themeApplyProject': '应用到整个项目',
  /* 「编辑方案」：改当前方案的槽位色；当前是内置方案时保存即复制成自定义方案。 */
  'rib.themeEdit': '编辑方案',
  'rib.themeEditTitle': '编辑配色方案',
  'rib.themeNewTitle': '新建配色方案',
  'rib.themeName': '方案名',
  /* 图库里右键自定义方案的菜单项。内置方案是只读数据表，没有这一项。 */
  'rib.themeRemove': '移除配色方案',
  'rib.themeRemoved': '已移除配色方案「{name}」',
  /* 内置方案复制成自定义方案时的名字后缀。 */
  'rib.themeCopySuffix': ' 副本',
  'rib.themeEditHint': '共 8 个可编辑主题色',
  'rib.theme.office': 'Office',
  'rib.theme.office2013': 'Office 2013 - 2022',
  'rib.theme.office2007': 'Office 2007 - 2010',
  'rib.theme.grayscale': '灰度',
  'rib.theme.blueWarm': '蓝色暖调',
  'rib.theme.blue': '蓝色',
  'rib.theme.blueII': '蓝色 II',
  'rib.theme.blueGreen': '蓝绿色',
  'rib.theme.green': '绿色',
  'rib.theme.yellowGreen': '黄绿色',
  'rib.theme.yellow': '黄色',
  'rib.theme.yellowOrange': '黄橙色',
  'rib.theme.orange': '橙色',
  'rib.theme.orangeRed': '橙红色',
  'rib.theme.redOrange': '红橙色',
  'rib.theme.red': '红色',
  'rib.theme.magenta': '紫红色',
  'rib.theme.violet': '紫罗兰色',
  'rib.theme.violetII': '紫罗兰色 II',
  'rib.theme.median': '中性',
  'rib.theme.paper': '纸张',
  'rib.theme.caption': '字幕',
  'rib.theme.slipstream': '气流',
  'rib.themeHint': '用了主题色的元素会跟着一起换',

  /* ------------------------------------------------ Ribbon 容器 */
  'rib.ariaTools': '排版工具',

  /* ------------------------------------------------ 插入生成器 */
  'rib.addGenerator': '插入生成器',
  'gen.pickerTitle': '插入生成器',
} as const;
