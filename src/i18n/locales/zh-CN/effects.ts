/**
 * effects.ts — 特效**目录**的文案：一句话说明 + 分类名 + 标签名。
 *
 * 前缀：`fx.desc.*`（每个特效一句，与 `media.ts` 里的 `fx.<id>` 显示名配对）、
 * `fx.cat.*`、`fx.tag.*`。
 *
 * 说明的写法约定：**「它做了什么」而不是「它很好」**，一句，句尾带句号。
 * 七十多条要成批读下来，句式统一才读得动 —— 这也是把目录集中在一个文件
 * （`effects/catalog.ts`）的理由之一。
 */

export const effects = {
  /* ------------------------------------------------------------ 分类 */
  'fx.cat.color': '调色',
  'fx.cat.geometry': '几何',
  'fx.cat.glitch': '故障',
  'fx.cat.style': '风格化',
  'fx.cat.blur': '模糊与光',
  'fx.cat.signal': '信号',

  /* ------------------------------------------------- 插件条目（运行期） */
  // 选择器角标：这一条来自插件，不是内置的。
  'fx.pluginBadge': '插件',

  /* ------------------------------------------------------------ 标签 */
  'fx.tag.overlay': '叠加型',
  'fx.tag.feedback': '带反馈',
  'fx.tag.multipass': '多 pass',
  'fx.tag.audio': '吃音频',
  'fx.tag.animated': '随时间动',
  'fx.tag.hdr': '浮点历史',

  /* -------------------------------------------------------- 一句话说明 */
  'fx.desc.ascii': '把画面重排成一格格字符。',
  'fx.desc.audioBars': '按频谱在画面上画出一排律动柱。',
  'fx.desc.bleach': '抽掉颜色，只留下明暗。',
  'fx.desc.blur': '柔化整幅画面。',
  'fx.desc.bulge': '只把中心一团鼓起或凹下，半径外不变。',
  'fx.desc.boxTracker': '给画面叠一层检测 HUD：方框、标签与连线。',

  /*
   * 方框跟踪的**标签词库**（画进画面里的候选词）。
   *
   * 它们放在语言表里不是为了「跟着界面语言变」—— 是**硬编码文案守卫**要求
   * `src/` 下的中日韩字面量只能出现在语言文件里（`tests/unit/i18n.test.ts`）。
   * 逗号分隔成一张表：`engine/box-tracker.ts` 在画标签时 split 一次。
   */
  'fx.boxTracker.wordsMil': '目标,载具,人员,设施,异常体,信号源,重型单位,空中目标',
  'fx.boxTracker.wordsTech': 'TARGET,VEHICLE,HOSTILE,UNKNOWN,SIGNAL,UNIT,ANOMALY,DRONE',
  'fx.boxTracker.wordsId': 'OBJ-0x1F,TRK-07,UNIT-12,SIG-3A,REF-08,NODE-21,TAG-04,SN-114',
  'fx.boxTracker.wordsBio': '人形,四足,飞行体,集群,植物,微生物,未知生物,巢穴',
  'fx.desc.channelSplit': 'R/G/B 分离，经典的故障特效。',
  'fx.desc.channelSplitPrism': '通道错位的两种映射，参数更细。',
  'fx.desc.circleWarp': '把画面卷到圆筒面上。',
  'fx.desc.colorCorrection': '亮度、对比、饱和与色相的统调。',
  'fx.desc.colorHalves': '把画面压成两种颜色。',
  'fx.desc.composite': '模拟复合视频的色度串扰。',
  'fx.desc.dataBend': '宏块栅格整块损坏或挪位。',
  'fx.desc.duotone': '把亮度映射到两种颜色之间。',
  'fx.desc.echo': '叠上一层层逐渐衰减的旧帧。',
  'fx.desc.edges': '只留轮廓，去掉填充。',
  'fx.desc.emboss': '压成一张凸起的灰浮雕。',
  'fx.desc.fastMosh': '只让画面里运动的部分融掉。',
  'fx.desc.feedback': '把画面反复喂给自己。',
  'fx.desc.fiberDisplace': '按纤维状的噪声推开像素。',
  'fx.desc.fisheye': '中间放大、边缘压缩，四角露出黑边；反向则凹陷。',
  'fx.desc.flashGlitch': '按拍闪出反相与色偏。',
  'fx.desc.flowContours': '用流线画出等值线。',
  'fx.desc.ghosting': '拖出多层错位的残影。',
  'fx.desc.glow': '亮部泛出一圈光晕。',
  'fx.desc.gradeBasic': '一级校色：暗部 / 中间调 / 亮部三组色轮，外加对比、饱和、色相与色温色调。',
  'fx.desc.gradeCurves': '主 / R / G / B 四张色调曲线，单调三次插值。',
  'fx.desc.gradeLut': '套用导入的 .cube 查找表；输入空间按 LUT 的调试环境选。',
  'fx.desc.gradeQualifier': '按色相 / 饱和度 / 亮度选一块区域，只改这块；可再接另一个片段的蒙版收窄。',
  'fx.desc.godray': '从亮部射出体积光。',
  'fx.desc.grain': '铺一层胶片颗粒。',
  'fx.desc.halftone': '拆成印刷网点。',
  'fx.desc.hsvSwap': '在 HSV 与 RGB 之间重新解读。',
  'fx.desc.jitter': '逐行横向错位跳动。',
  'fx.desc.kaleido': '镜像成万花筒图案。',
  'fx.desc.kinoDatamosh': '只重画变动过的块。',
  'fx.desc.kinoFeedback': '像对着屏幕拍摄那样回授。',
  'fx.desc.lcd': '凑近看一块液晶屏：RGB 像素、反光与坏道。',
  'fx.desc.lensFlare': '在最亮处压上一串镜片反光。',
  'fx.desc.liquidLight': '把光晕化成流动的液体。',
  'fx.desc.melt': '让画面像蜡一样往下淌。',
  'fx.desc.mirror': '沿中线镜像。',
  'fx.desc.motionBlur': '把运动摊成时间上的拖影。',
  'fx.desc.motionMask': '按运动的多少抠出一张遮罩。',
  'fx.desc.neonEdges': '给轮廓描上霓虹。',
  'fx.desc.nestedShrink': '把缩小后的画面一层层叠在正中间。',
  'fx.desc.opticalFlow': '沿光流把像素拖成线。',
  'fx.desc.petri': '培养皿里的反应扩散。',
  'fx.desc.pixelShifter': '按行或列整体挪动。',
  'fx.desc.pixelSort': '沿亮暗把像素排成条。',
  'fx.desc.pixelate': '降成一格格的马赛克。',
  'fx.desc.polar': '把直角坐标换成极坐标。',
  'fx.desc.posterize': '把连续阶调切成几级。',
  'fx.desc.radialBlur': '从中心向外拉出速度感。',
  'fx.desc.reflection': '画面下方接一片水面倒影。',
  'fx.desc.relief': '用视差做出立体浮雕。',
  'fx.desc.resizeGlitch': '按拍抽动缩放与画面中心。',
  'fx.desc.rgbBurst': '把通道炸开成噪声块。',
  'fx.desc.rgbStrobe': '三个通道各自频闪。',
  'fx.desc.ringWarp': '同心环状的波纹。',
  'fx.desc.ripple': '像水面涟漪一样推开。',
  'fx.desc.scanlines': '隔行压暗，旧屏幕的质感。',
  'fx.desc.screenJump': '整帧回绕滚卷，可加抽动。',
  'fx.desc.shake': '整帧随机抖动。',
  'fx.desc.sharpen': '强化细节与边缘。',
  'fx.desc.shockwave': '一圈冲击波扫过画面。',
  'fx.desc.slices': '少数几行横移很远。',
  'fx.desc.smear': '沿撕开的方向拖出采样保持。',
  'fx.desc.sobelNeon': '提取边缘后描亮。',
  'fx.desc.softGlitch': '几条带各自按节奏错位。',
  'fx.desc.solarize': '亮部反相，萨巴蒂尔效应。',
  'fx.desc.stereoscopic': '红青分色，配立体眼镜看。',
  'fx.desc.strobe': '按拍整帧频闪。',
  'fx.desc.stutter': '按固定帧率冻住画面，快门开着的那段叠成拖影。',
  'fx.desc.stylizeGlitch': '抖动叠一层风格化着色。',
  'fx.desc.swirl': '把画面拧成漩涡。',
  'fx.desc.thermal': '按温度映射成热成像。',
  'fx.desc.tile': '平铺、旋转与镜像。',
  'fx.desc.transform3d': '把画面放进三维空间里转；旋转平面之外是透明的。',
  'fx.desc.trioTone': '三段色阶的调色。',
  'fx.desc.tunnel': '向画面深处推进的隧道。',
  'fx.desc.vhs': '磁带噪点、色偏与抖动。',
  'fx.desc.vignette': '四角压暗。',
  'fx.desc.wobble': '缓慢游移的波浪扭曲。',
  'fx.desc.zoom': '放大或缩小画面。',
} as const;
