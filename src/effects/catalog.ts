/**
 * catalog.ts — 特效的**展示信息**目录：缩略图底图 + 一句话说明 + 分类 + 叠加标记。
 *
 * ## 为什么不放在各自的 `defs/<id>.ts` 里
 *
 * 两条理由：
 * 1. 七十多条说明要**成批读一遍**才能保证语气与长度一致（"把画面变成黑白色。"
 *    这种句式），散在七十多个文件里做不到这件事。
 * 2. 这些是**展示信息**，不是 shader 协议 —— `defs/` 讲的是这个特效的着色器要什么，
 *    这里讲的是怎么把它介绍给人看。两件事的读者不同。
 *
 * 代价是「新增一个特效 = 三个地方」（def + glsl + 这里）。摩擦用两条守卫变成
 * **明确报错**而不是默默漏掉：`effect-catalog.test.ts` 断言
 * 「每个注册的特效都有条目」+「每个条目都对应真实特效（没有孤儿）」。
 *
 * ## 标签分两半
 *
 * - **手工**：`分类`（六选一）+ `叠加型`。这两件只有人能判断。
 * - **自动**：`反馈` / `多 pass` / `音频` / `HDR 历史` / `动态` —— 从 shader def
 *   推导（见 `structuralTags`）。手工维护这些必然与代码漂掉，而它们恰好是
 *   筛选时最有用的几条（"有哪些吃音频"）。
 *
 * ## 「是否为叠加层」这条要重新解释
 *
 * 用户举例里的「是否为叠加层」在本项目里没有区分度：**所有特效片段本来就是
 * adjustment layer**。所以改成「**叠加型**」= 在输入之上**加**东西（辉光 / 反光 /
 * 网格 / 颗粒），而不是**改写**输入（去色 / 量化 / 位移）。挑特效时这个区分才有用。
 */

import type { EffectShaderDef } from './shader-def';
import type { MessageKey } from '../i18n/locales';
import type { ThumbBaseId } from './thumbnails/bases';

export type EffectCategory = 'color' | 'geometry' | 'glitch' | 'style' | 'blur' | 'signal';

/** 分类的展示顺序 —— 也是「按分类排序」时的分组顺序。 */
export const EFFECT_CATEGORIES: EffectCategory[] = [
  'color',
  'geometry',
  'glitch',
  'style',
  'blur',
  'signal',
];

/**
 * 标签。前五个是**结构标签**（自动推导），`overlay` 是手工的。
 *
 * `overlay` 放在同一套标签里而不是单独的字段：筛选面板里它就是一行勾选项，
 * 分成两套概念会让 UI 与模型都多一层。
 */
export type EffectTag = 'feedback' | 'multipass' | 'audio' | 'hdr' | 'animated' | 'overlay';

export const EFFECT_TAGS: EffectTag[] = ['overlay', 'feedback', 'multipass', 'audio', 'animated', 'hdr'];

export interface EffectCatalogEntry {
  /**
   * 缩略图底图（见 `thumbnails/bases.ts` 的择图理由表）。
   *
   * ⚠️ 这是**批量导出的自动选择**，不等于仓库里那套图用的底图 ——
   * `src/assets/effect-thumbnails/` 里那套是**逐张手挑**过的（会连同参数一起
   * 调，比如 `bleach` 拉到完全去色才是它最好的示意）。
   * 所以「批量导出缩略图」会得到**另一套**，别当成重建同名的资源直接覆盖。
   * 见 AGENTS §5.5 的「缩略图资源」。
   */
  base: ThumbBaseId;
  /** 一句话说明。存**文案键**，理由同 `effects/types.ts` 的 `labelKey`。 */
  descKey: MessageKey;
  category: EffectCategory;
  /** 叠加型：在输入之上加东西，而不是改写输入。 */
  overlay?: boolean;
  /**
   * 缩略图的参数覆盖（与该特效的默认值合并）。
   *
   * **「默认参数下这张定格画面看不出特效」的才要写。** 时域特效是典型：`stutter`
   * 在 12fps 下窗口只有两三帧，缩略图与原始画面几乎逐像素相同 —— 卡片等于没有图。
   * 与 `algos/catalog.ts` 的同名字段一个用途（那边的理由是「第 0 秒是空屏」）。
   *
   * 键必须是该特效真的有的参数：写错的键会被 `?? defaultValue` 静默忽略，
   * 于是又回到「卡片是空的」而没人报错（`effect-catalog.test.ts` 守这一条）。
   */
  previewParams?: Record<string, number | string>;
}

/**
 * 目录表。**结构标签不在这里**（自动推导），这里只写人才能判断的三项。
 *
 * 新增特效时照着最后一行补一条 —— `base` 的选择看
 * `thumbnails/bases.ts` 顶部那张表：**先问这个特效改的是颜色、阶调、形状、
 * 细节、径向还是运动**，再选底图。选错的表现是缩略图看不出变化。
 */
export const EFFECT_CATALOG: Record<string, EffectCatalogEntry> = {
  ascii: { base: 'ramp', descKey: 'fx.desc.ascii', category: 'style' },
  'audio-bars': { base: 'grid', descKey: 'fx.desc.audioBars', category: 'signal', overlay: true },
  bleach: { base: 'bars', descKey: 'fx.desc.bleach', category: 'color' },
  blur: { base: 'photo', descKey: 'fx.desc.blur', category: 'blur' },
  'box-tracker': { base: 'photo', descKey: 'fx.desc.boxTracker', category: 'style', overlay: true },
  bulge: { base: 'grid', descKey: 'fx.desc.bulge', category: 'geometry' },
  'channel-split': { base: 'mandel', descKey: 'fx.desc.channelSplit', category: 'glitch' },
  'channel-split-prism': { base: 'mandel', descKey: 'fx.desc.channelSplitPrism', category: 'glitch' },
  'circle-warp': { base: 'grid', descKey: 'fx.desc.circleWarp', category: 'geometry' },
  'color-correction': { base: 'ramp', descKey: 'fx.desc.colorCorrection', category: 'color' },
  'color-halves': { base: 'bars', descKey: 'fx.desc.colorHalves', category: 'color' },
  composite: { base: 'mandel', descKey: 'fx.desc.composite', category: 'signal' },
  'data-bend': { base: 'grid', descKey: 'fx.desc.dataBend', category: 'glitch' },
  duotone: { base: 'ramp', descKey: 'fx.desc.duotone', category: 'color' },
  echo: { base: 'mandel', descKey: 'fx.desc.echo', category: 'blur', overlay: true },
  edges: { base: 'photo', descKey: 'fx.desc.edges', category: 'style' },
  emboss: { base: 'photo', descKey: 'fx.desc.emboss', category: 'style' },
  'fast-mosh': { base: 'scroll', descKey: 'fx.desc.fastMosh', category: 'glitch' },
  feedback: { base: 'photo', descKey: 'fx.desc.feedback', category: 'blur', overlay: true },
  'fiber-displace': { base: 'photo', descKey: 'fx.desc.fiberDisplace', category: 'geometry' },
  'grade-basic': { base: 'ramp', descKey: 'fx.desc.gradeBasic', category: 'color' },
  'grade-curves': { base: 'bars', descKey: 'fx.desc.gradeCurves', category: 'color' },
  'grade-lut': { base: 'mandel', descKey: 'fx.desc.gradeLut', category: 'color' },
  fisheye: { base: 'grid', descKey: 'fx.desc.fisheye', category: 'geometry' },
  'flash-glitch': { base: 'mandel', descKey: 'fx.desc.flashGlitch', category: 'glitch' },
  'flow-contours': { base: 'photo', descKey: 'fx.desc.flowContours', category: 'style' },
  ghosting: { base: 'grid', descKey: 'fx.desc.ghosting', category: 'blur', overlay: true },
  glow: { base: 'rings', descKey: 'fx.desc.glow', category: 'blur', overlay: true },
  godray: { base: 'mandel', descKey: 'fx.desc.godray', category: 'style', overlay: true },
  grain: { base: 'ramp', descKey: 'fx.desc.grain', category: 'style', overlay: true },
  halftone: { base: 'ramp', descKey: 'fx.desc.halftone', category: 'style' },
  'hsv-swap': { base: 'bars', descKey: 'fx.desc.hsvSwap', category: 'color' },
  jitter: { base: 'mandel', descKey: 'fx.desc.jitter', category: 'glitch' },
  kaleido: { base: 'photo', descKey: 'fx.desc.kaleido', category: 'geometry' },
  'kino-datamosh': { base: 'scroll', descKey: 'fx.desc.kinoDatamosh', category: 'glitch' },
  'kino-feedback': { base: 'mandel', descKey: 'fx.desc.kinoFeedback', category: 'blur', overlay: true },
  lcd: { base: 'grid', descKey: 'fx.desc.lcd', category: 'style' },
  'lens-flare': { base: 'photo', descKey: 'fx.desc.lensFlare', category: 'blur', overlay: true },
  'liquid-light': { base: 'photo', descKey: 'fx.desc.liquidLight', category: 'blur', overlay: true },
  melt: { base: 'mandel', descKey: 'fx.desc.melt', category: 'glitch' },
  mirror: { base: 'photo', descKey: 'fx.desc.mirror', category: 'geometry' },
  'motion-blur': { base: 'scroll', descKey: 'fx.desc.motionBlur', category: 'blur' },
  'motion-mask': { base: 'scroll', descKey: 'fx.desc.motionMask', category: 'blur' },
  'neon-edges': { base: 'mandel', descKey: 'fx.desc.neonEdges', category: 'style', overlay: true },
  'nested-shrink': {
    base: 'grid',
    descKey: 'fx.desc.nestedShrink',
    category: 'geometry',
    // 默认只叠一层，卡片上就是一个「画中画」；三层才读出「一层套一层」这件事。
    previewParams: { count: 3, scale: 0.72 },
  },
  'optical-flow': { base: 'scroll', descKey: 'fx.desc.opticalFlow', category: 'style' },
  petri: { base: 'photo', descKey: 'fx.desc.petri', category: 'style' },
  'pixel-shifter': { base: 'mandel', descKey: 'fx.desc.pixelShifter', category: 'glitch' },
  'pixel-sort': { base: 'photo', descKey: 'fx.desc.pixelSort', category: 'glitch' },
  pixelate: { base: 'ramp', descKey: 'fx.desc.pixelate', category: 'glitch' },
  polar: { base: 'grid', descKey: 'fx.desc.polar', category: 'geometry' },
  posterize: { base: 'ramp', descKey: 'fx.desc.posterize', category: 'color' },
  'radial-blur': { base: 'rings', descKey: 'fx.desc.radialBlur', category: 'blur' },
  reflection: { base: 'photo', descKey: 'fx.desc.reflection', category: 'style', overlay: true },
  relief: { base: 'photo', descKey: 'fx.desc.relief', category: 'style' },
  'resize-glitch': { base: 'mandel', descKey: 'fx.desc.resizeGlitch', category: 'glitch' },
  'rgb-burst': { base: 'mandel', descKey: 'fx.desc.rgbBurst', category: 'glitch' },
  'rgb-strobe': { base: 'bars', descKey: 'fx.desc.rgbStrobe', category: 'glitch' },
  'ring-warp': { base: 'grid', descKey: 'fx.desc.ringWarp', category: 'geometry' },
  ripple: { base: 'rings', descKey: 'fx.desc.ripple', category: 'geometry' },
  scanlines: { base: 'ramp', descKey: 'fx.desc.scanlines', category: 'style' },
  'screen-jump': { base: 'mandel', descKey: 'fx.desc.screenJump', category: 'glitch' },
  shake: { base: 'grid', descKey: 'fx.desc.shake', category: 'glitch' },
  sharpen: { base: 'photo', descKey: 'fx.desc.sharpen', category: 'style' },
  shockwave: { base: 'grid', descKey: 'fx.desc.shockwave', category: 'glitch' },
  slices: { base: 'mandel', descKey: 'fx.desc.slices', category: 'glitch' },
  smear: { base: 'photo', descKey: 'fx.desc.smear', category: 'glitch' },
  'sobel-neon': { base: 'mandel', descKey: 'fx.desc.sobelNeon', category: 'style' },
  'soft-glitch': { base: 'mandel', descKey: 'fx.desc.softGlitch', category: 'glitch' },
  solarize: { base: 'ramp', descKey: 'fx.desc.solarize', category: 'color' },
  stereoscopic: { base: 'photo', descKey: 'fx.desc.stereoscopic', category: 'style' },
  strobe: { base: 'mandel', descKey: 'fx.desc.strobe', category: 'glitch' },
  stutter: {
    base: 'scroll',
    descKey: 'fx.desc.stutter',
    category: 'style',
    // 2fps + 全快门：定格画面的窗口跨 15 帧，拖影才在这一帧里读得出来。
    // 默认的 12fps 窗口只有 2.5 帧，缩略图与底图几乎一样。
    previewParams: { rate: 2, shutter: 1 },
  },
  'stylize-glitch': { base: 'mandel', descKey: 'fx.desc.stylizeGlitch', category: 'glitch' },
  swirl: { base: 'rings', descKey: 'fx.desc.swirl', category: 'geometry' },
  thermal: { base: 'ramp', descKey: 'fx.desc.thermal', category: 'color' },
  tile: { base: 'mandel', descKey: 'fx.desc.tile', category: 'geometry' },
  'transform-3d': { base: 'grid', descKey: 'fx.desc.transform3d', category: 'geometry' },
  'trio-tone': { base: 'ramp', descKey: 'fx.desc.trioTone', category: 'color' },
  tunnel: { base: 'rings', descKey: 'fx.desc.tunnel', category: 'blur', overlay: true },
  vhs: { base: 'grid', descKey: 'fx.desc.vhs', category: 'glitch' },
  vignette: { base: 'photo', descKey: 'fx.desc.vignette', category: 'style', overlay: true },
  wobble: { base: 'grid', descKey: 'fx.desc.wobble', category: 'geometry' },
  zoom: { base: 'grid', descKey: 'fx.desc.zoom', category: 'geometry' },
};

/**
 * 结构标签：**从 shader def 推导**，不手工维护。
 *
 * 判据都取「协议上确凿的事实」，所以不会与代码漂：
 * - `feedback: true` → 它持有跨帧历史
 * - `prePasses` 非空 → 它是多 pass
 * - `hdrFeedback` → 历史是浮点的
 * - fragment / pre-pass 里出现 `u_spectrum` → 它读音频
 * - fragment 里出现 `u_time` → 它的画面随时间变（静态特效不需要）
 */
export function structuralTags(shader: EffectShaderDef): EffectTag[] {
  const tags: EffectTag[] = [];
  if (shader.feedback) tags.push('feedback');
  if ((shader.prePasses?.length ?? 0) > 0) tags.push('multipass');
  if (shader.hdrFeedback) tags.push('hdr');
  const sources = [shader.fragment, ...(shader.prePasses ?? []).map((p) => p.fragment)];
  if (sources.some((s) => /\bu_spectrum\b/.test(s))) tags.push('audio');
  if (/\bu_time\b/.test(shader.fragment)) tags.push('animated');
  return tags;
}

/** 一个特效的全部标签 = 结构标签 + 目录里的手工标记。顺序跟 `EFFECT_TAGS`。 */
export function effectTags(shader: EffectShaderDef, entry: EffectCatalogEntry): EffectTag[] {
  const set = new Set<EffectTag>(structuralTags(shader));
  if (entry.overlay) set.add('overlay');
  return EFFECT_TAGS.filter((t) => set.has(t));
}

/**
 * 插件特效的标签 = 结构标签 + 插件自报的标签。
 *
 * 与 `effectTags` 的唯一区别是**没有目录条目**：插件的「叠加型」这类人工判断
 * 由插件自己在清单里写（`tags: ['overlay']`）。结构标签照旧自动推导 ——
 * 它读的是 shader def 本身，对插件同样成立，不需要插件作者声明。
 */
export function pluginEffectTags(
  shader: EffectShaderDef,
  declared: readonly EffectTag[],
): EffectTag[] {
  const set = new Set<EffectTag>(structuralTags(shader));
  for (const t of declared) set.add(t);
  return EFFECT_TAGS.filter((t) => set.has(t));
}

/**
 * 插件特效没有声明分类时的回落分类。
 *
 * 必须有一个具体值而不是 `null`：选择器按分类分组/筛选，`null` 会让插件特效
 * 在任何分类视图里都消失（看起来像「加载失败」）。选 `'style'` 是因为它本身
 * 就是最宽的一类（风格化），落进去不算错。
 */
export const DEFAULT_EFFECT_CATEGORY: EffectCategory = 'style';
