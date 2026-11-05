/**
 * actions.ts — 排版编辑器的语义动作。
 *
 * Ribbon 的描述数组里挂的全是这里的函数。分这一层的理由：Ribbon 的按钮只该
 * 知道「点了我做什么」，不该知道「文档结构长什么样、怎么改才安全」。
 * 于是「加一个按钮」= 在 ribbon-defs 里加一行 + 可能在这里加一个函数，
 * 不需要碰任何组件。
 *
 * 所有写库都经 editorState（commit / 手势事务），这是撤销栈完整的唯一前提。
 */

import { platform } from '../../platform/index';
import { appState } from '../app-state.svelte';
import { editorState } from './editor-state.svelte';
import { newId } from '../../core/schema';
import { imageSourceFor, registerImageBytes } from '../../engine/media-assets';
import {
  DEFAULT_PAINT_A,
  applyPaintPatch,
  cameraIsIdentity,
  centeredImageFrame,
  createImageElement,
  createShapeElement,
  createTextElement,
  defaultTextStyle,
  defaultTransform3D,
  mergeCamera,
  mergeTransform3D,
  type Camera,
  type ElementShadow,
  type ImageElement,
  type MixBlend,
  type ShapeElement,
  type ShapePaintPatch,
  type Stroke,
  type TextElement,
  type TextStyle,
  type TextStyleShadow,
  type TextureFrame,
  type Transform3DPatch,
  type TypographyDocument,
  type TypographyElement,
  type ZOrderOp,
} from '../../typography/document';
import {
  alignElements,
  boundsOf,
  distribute,
  toRects,
  type AlignAxis,
  type Rect,
} from '../../typography/geometry';
import { applyElementAnimations, applyElementFormat } from '../../typography/format-painter';
import {
  ANIM_PRESETS,
  animTargetOf,
  createCustomAnimation,
  createPresetAnimation,
  createTracksAnimation,
  parseCustomCss,
  presetLabel,
  type AnimPreset,
  type AnimTarget,
  type AnimTiming,
  type TracksAnimation,
} from '../../typography/animation';
import {
  applyTrackTiming,
  identityValue,
  normalizeKeyColor,
  sampleKeys,
  type TrackEase,
} from '../../typography/animation-tracks';
import {
  CAMERA_CHANNELS,
  cameraChannelValueAt,
  cameraKeyOf,
  cameraKeyOfRowId,
  cameraTracksOf,
  upsertCameraKey,
} from '../../typography/camera-tracks';
import { presetToTracks } from '../../typography/animation-migrate';
import { insertAnimationsAt } from '../../typography/animation-insert';
import { kfPanel } from './keyframe-panel-state.svelte';
import { hasImageAsset, putImageBytes, mimeForImageFilename } from '../../typography/image-assets';
import { defaultKeySettings, identityQuad, type KeySettings } from '../../core/image-fx';
import {
  adjustIsDefault,
  coerceImageAdjust,
  coerceImageBorder,
  coerceImageFilter,
  coerceImageRecolor,
  defaultImageAdjust,
  type CurveChannel,
  type CurvePoint,
  type ImageAdjust,
  type ImageAdjustPatch,
  type ImageBorder,
  type ImageFilterState,
  type ImageRecolor,
} from '../../typography/image-effects';
import {
  cropForAspect,
  frameForAlign,
  resizeFrameCentered,
  type ImageAlignMode,
  type ImageCropRect,
} from '../../typography/image-geometry';
import {
  cloneFragment,
  expandToGroups,
  extractFragment,
  groupElements,
  groupList,
  groupsInSelection,
  ungroupElements,
  type GroupedFragment,
} from '../../typography/groups';
import { SHAPE_PRESETS, type ShapePreset } from '../../typography/shapes';
import { buildFromSpec, defaultsOf, generatorById, nextSeed } from '../../typography/svg-gen';
import { cloneAsCustomTheme, type TypographyTheme } from '../../typography/theme';
import { ICON_STROKE_WIDTH, iconGridFrames, type IconInsert } from '../../typography/icon-shapes';
import { insertNodeOnSegment, parsePathNodes, removeNode, serializePathNodes } from '../../typography/path-nodes';
import { type BoolOp } from '../../typography/path-ops';
import {
  applyBoolean,
  applyDivide,
  buildTextOutlineShapes,
  convertShapeToPath,
} from '../../typography/shape-convert';
import {
  applySpanStyle,
  clearSpanStyle as clearRunsSpanStyle,
  coversWholeText,
  normalizeRuns,
  plainTextOf,
  scaleSpanFontSize,
  SPAN_STYLE_KEYS,
  uniformSpanValue,
  type SpanStyleKey,
  type SpanStylePatch,
} from '../../typography/rich-text';
import { firstFamily } from '../../typography/font/css-family';
import {
  outlineTextElement,
  type TextOutlineFailure,
  type TextOutlineItem,
} from '../../typography/text-outline';
import { localFontSource } from '../../typography/local-fonts';
import { tr } from '../../i18n/index.svelte';

/* ------------------------------------------------------------ 选择集工具 */

function selectedIds(): Set<string> {
  return new Set(editorState.selectedIds);
}

/** 可写的元素（锁定的跳过）。 */
function writable(doc: TypographyDocument): TypographyElement[] {
  const ids = selectedIds();
  return doc.elements.filter((el) => ids.has(el.id) && !el.locked);
}

function onlyText(doc: TypographyDocument) {
  return writable(doc).filter((el): el is Extract<TypographyElement, { kind: 'text' }> => el.kind === 'text');
}

function onlyShape(doc: TypographyDocument) {
  return writable(doc).filter((el): el is ShapeElement => el.kind === 'shape');
}

/** 选中集里由生成器烘焙出来的图形（`gen` 存在）。 */
function onlyGen(doc: TypographyDocument): ShapeElement[] {
  return onlyShape(doc).filter((el) => !!el.gen);
}

/**
 * 按元素上存着的参数与种子重算 `path`（就地）。
 *
 * **渲染只读 `path`**，所以每次改参数都要显式重算 —— 这样 `docHash` 只在
 * 真的改了什么时才变，光栅化缓存口径不变。未知 id（旧档 / 别人的数据）
 * 返回 false，调用方保持原路径不动。
 */
function rebuildGen(el: ShapeElement): boolean {
  const gen = el.gen;
  if (!gen) return false;
  const spec = generatorById(gen.id);
  if (!spec) return false;
  const r = buildFromSpec(spec, gen.params, gen.seed);
  el.path = r.d;
  el.evenOdd = r.evenOdd ? true : undefined;
  return true;
}

/** 生成器元素插入时的默认框：`aspect` 决定宽高比，再夹进画布。 */
function generatedFrame(size: { w: number; h: number }, aspect: number): TextureFrame {
  const maxW = Math.max(24, Math.round(size.w * 0.8));
  const maxH = Math.max(24, Math.round(size.h * 0.8));
  let h = Math.min(160, maxH);
  let w = Math.round(h * aspect);
  if (w > maxW) {
    w = maxW;
    h = Math.max(12, Math.round(w / aspect));
  }
  return {
    x: Math.round((size.w - w) / 2),
    y: Math.round((size.h - h) / 2),
    w,
    h,
    // `TextureFrame` 的 rot 是必填的（弧度）。生成器元素插入时不旋转。
    rot: 0,
  };
}

/** `strokeOnly` 生成器的默认描边宽度（authored 0..100 单位，随元素等比缩放）。 */
const GEN_STROKE_WIDTH = 1.2;

/**
 * 把参数写进「与首个生成器元素同 id」的所有选中元素，并重算路径。
 *
 * 只写同 id 的那些：多选里混了两个生成器时，把一个参数同时塞给两边，
 * 另一边会拿到一个它根本不认识的键（虽然会被忽略，但语义上是污染）。
 */
function applyGenParam(doc: TypographyDocument, key: string, value: number | string): void {
  const target = onlyGen(doc)[0]?.gen?.id;
  if (!target) return;
  for (const el of onlyGen(doc)) {
    if (el.gen!.id !== target) continue;
    el.gen!.params = { ...el.gen!.params, [key]: value };
    rebuildGen(el);
  }
}

/** 转路径失败 → 一条能照做的提示（不是「失败了」三个字）。 */
function textOutlineFailureText(failure: TextOutlineFailure): string {
  switch (failure.code) {
    case 'vertical':
      return tr('typo.textToPathVertical');
    case 'no-font':
      return tr('typo.textToPathNoFont', { fonts: failure.families.join(', ') });
    case 'local-denied':
      return tr('typo.textToPathLocalDenied', { fonts: failure.families.join(', ') });
    case 'local-missing':
      return tr('typo.textToPathLocalMissing', { fonts: failure.families.join(', ') });
    case 'local-failed':
      return tr('typo.textToPathLocalFailed', {
        fonts: failure.families.join(', '),
        msg: failure.message,
      });
    case 'missing-glyphs':
      return tr('typo.textToPathMissingGlyphs', {
        fonts: failure.families.join(', '),
        chars: failure.chars,
      });
    case 'synthetic':
      return tr('typo.textToPathSynthetic', { fonts: failure.faces.join(', ') });
    default:
      return tr('typo.textToPathEmpty');
  }
}

/**
 * 当前处于**顶点编辑态**的那个图形元素。
 *
 * 与 `onlyShape` 的区别很关键：那个返回「选择集里的图形」（可能多个、可能为空），
 * 这个返回「正在被编辑的那**一个**」。顶点写入必须唯一确定目标 —— 用 `onlyShape`
 * 的话，多选时拖一个锚点会把所有选中图形的路径一起改掉（而它们在几何上毫无关系）。
 */
function nodeEditShape(doc: TypographyDocument): ShapeElement | null {
  const id = editorState.nodeEditId;
  if (!id) return null;
  const el = doc.elements.find((e) => e.id === id);
  return el && el.kind === 'shape' ? el : null;
}

function onlyImage(doc: TypographyDocument) {
  return writable(doc).filter((el): el is ImageElement => el.kind === 'image');
}

function anyElement(doc: TypographyDocument): TypographyElement[] {
  return writable(doc);
}

/** 景深写入（多选时逐个写）。0 = 删字段：与「没设过」逐像素相同。 */
function writeDepth(doc: TypographyDocument, value: number): void {
  const v = clamp01(value);
  for (const el of anyElement(doc)) {
    if (v <= 0) delete el.depth;
    else el.depth = v;
  }
}

/**
 * 镜头写入。恒等时删字段（缺省语义就是「没有镜头」）。
 *
 * **有关键帧的通道写的是播放头那一帧**（`atSec` 给了才算），其余写基准值。
 * 不这么做的话，一旦某条通道有了轨道，浮层上那个输入框就变成「改了没反应」——
 * 而用户根本看不出「这个值被动画接管了」。
 */
function writeCamera(doc: TypographyDocument, patch: Partial<Camera>, atSec?: number): void {
  const keyed = new Set(
    cameraTracksOf(doc)
      .filter((t) => t.keys.length > 0)
      .map((t) => cameraKeyOf(t.prop)),
  );
  const base: Partial<Camera> = {};
  for (const key of CAMERA_CHANNELS) {
    const k = cameraKeyOf(key)!;
    const v = patch[k];
    if (v === undefined) continue;
    if (atSec !== undefined && keyed.has(k)) upsertCameraKey(doc, k, atSec, v);
    else base[k] = v;
  }
  if (Object.keys(base).length === 0) return;
  const next = mergeCamera(doc.camera, base);
  if (cameraIsIdentity(next)) delete doc.camera;
  else doc.camera = next;
}

/** 新加一条属性轨道时的默认跨度（秒）。太短会让人以为「没生效」。 */
const DEFAULT_TRACK_SEC = 0.6;

/**
 * 按 id 找一条结构化轨道并就地改它（找不到 = 什么都不做）。
 *
 * 文档级轨道（镜头）与元素轨道共用同一套关键帧手势与撤销粒度，所以
 * 这里一起找 —— 面板上的「镜头」行与元素行走的是同一条编辑路径。
 */
function eachTrack(
  doc: TypographyDocument,
  animId: string,
  fn: (a: TracksAnimation) => void,
): void {
  for (const el of doc.elements) {
    const a = el.animations.find((x) => x.id === animId);
    if (a && a.kind === 'tracks') fn(a);
  }
  const own = (doc.animations ?? []).find((a) => a.id === animId);
  if (own) fn(own);
}

/**
 * 实时预览的写入通道：拖动中连续调用，**不拍快照**；松手由 `endLive` 结算。
 *
 * 拖拽路径没有显式的「开始」信号（第一个 pointermove 就是开始），所以事务
 * 在这里懒开。`beginGesture` 本身是幂等的（已在事务里直接 return），
 * 与 `PropertiesPanel` 的抠图滑杆是同一套写法。
 */
function liveWrite(fn: (doc: TypographyDocument) => void): void {
  if (!editorState.gestureActive) editorState.beginGesture();
  editorState.live(fn);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 把一份色彩校正写进元素。
 *
 * **全默认时删字段**：`imageNeedsFx` 据 `adjustIsDefault` 判空，留一个全 0 的
 * `adjust` 会让这张图永远走 canvas 路径（画质与性能都变，而用户什么都没改）。
 */
function writeImageAdjust(el: ImageElement, patch: ImageAdjustPatch): void {
  const next = coerceImageAdjust(patch, el.adjust);
  if (!next) return;
  if (adjustIsDefault(next)) delete el.adjust;
  else el.adjust = next;
}

/** `setImageCurve` / `setImageCurveLive` 的写库体（两条路必须同一份）。 */
function applyImageCurve(
  doc: TypographyDocument,
  channel: CurveChannel,
  points: CurvePoint[] | null,
): void {
  for (const el of onlyImage(doc)) {
    const adjust: ImageAdjust = { ...(el.adjust ?? defaultImageAdjust()) };
    const curves = { ...(adjust.curves ?? {}) };
    if (points && points.length) {
      // 排序是必须的：曲线求值假设 x 单增（`curveLut` 的 `while` 扫描）。
      curves[channel] = points
        .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
        .sort((a, b) => a.x - b.x);
    } else {
      delete curves[channel];
    }
    if (Object.keys(curves).length) adjust.curves = curves;
    else delete adjust.curves;
    if (adjustIsDefault(adjust)) delete el.adjust;
    else el.adjust = adjust;
  }
}

/** `setImageFilter` / `setImageFilterLive` 的写库体。 */
function applyImageFilter(doc: TypographyDocument, filter: ImageFilterState | null): void {
  for (const el of onlyImage(doc)) {
    const next = filter ? coerceImageFilter(filter) : null;
    if (next) el.filter = next;
    else delete el.filter;
  }
}

/**
 * `patchImageRecolor` / `...Live` 的写库体。
 *
 * `amount = 0` **保留字段**，不删：用户把强度拖到 0 再拖回来时颜色还在
 * （删掉的话下一次 `coerceImageRecolor` 会退回默认色，等于把用户挑的颜色扔了）。
 * 「没有效果」由 `recolorIsDefault` 判定，与有没有键无关。
 */
function applyImageRecolor(doc: TypographyDocument, patch: Partial<ImageRecolor>): void {
  for (const el of onlyImage(doc)) {
    const next = coerceImageRecolor(patch, el.recolor);
    if (next) el.recolor = next;
  }
}

/**
 * `setFrame` 的写库体。commit 与实时预览共用 —— 分两份的话「拖动时按锚点
 * 整体平移、松手后变成各自设值」这种不一致只在多选时出现，极难发现。
 */
function applyFrame(doc: TypographyDocument, patch: Partial<TextureFrame>): void {
  const ids = new Set(editorState.groupAwareIds);
  if (!ids.size) return;
  const targets = doc.elements.filter((el) => ids.has(el.id) && !el.locked);
  const anchor = targets[0];
  if (!anchor) return;
  const single = targets.length === 1;
  const dx = patch.x !== undefined ? patch.x - anchor.frame.x : 0;
  const dy = patch.y !== undefined ? patch.y - anchor.frame.y : 0;
  for (const el of targets) {
    const f = el.frame;
    el.frame = {
      x: patch.x !== undefined ? (single ? patch.x : f.x + dx) : f.x,
      y: patch.y !== undefined ? (single ? patch.y : f.y + dy) : f.y,
      // 宽 / 高 / 旋转只在单选时生效（见 setFrame 的接口注释）。宽高至少 1px：
      // 0 宽的元素在画布上再也点不回来。
      w: single && patch.w !== undefined ? Math.max(1, patch.w) : f.w,
      h: single && patch.h !== undefined ? Math.max(1, patch.h) : f.h,
      rot: single && patch.rot !== undefined ? patch.rot : f.rot,
    };
  }
}

/**
 * 图形描边宽度（commit / 实时共用）。
 *
 * 本来没有描边时也**创建**：面板上「先调宽度、再挑颜色」是常见顺序，
 * 静默不生效会让人以为控件坏了。宽度 0 在视觉上仍等于没有描边。
 */
function applyShapeStrokeWidth(doc: TypographyDocument, width: number): void {
  const w = Math.max(0, width);
  for (const el of onlyShape(doc)) {
    el.stroke = el.stroke
      ? { ...el.stroke, width: w }
      : { color: '#ffffff', width: w, style: 'solid' };
  }
}

/** 文本框边框（commit / 实时共用）。 */
function applyTextBoxStroke(doc: TypographyDocument, patch: Partial<Stroke>): void {
  for (const el of onlyText(doc)) {
    const cur = el.boxStroke;
    const next: Stroke = {
      color: patch.color ?? cur?.color ?? '#ffffff',
      // 宽度 0 = 无边框（与图形描边同一套语义：不做「有 / 无」两态，
      // 少一个状态就少一处「为什么这里还有个隐形边框」）。
      width: patch.width !== undefined ? Math.max(0, patch.width) : (cur?.width ?? 2),
      style: patch.style ?? cur?.style ?? 'solid',
    };
    // 填充方式（渐变 / 纹理）是另一个入口写的，这里必须**带过去** ——
    // 重建成三字段对象的话，调一次宽度就把渐变边框打回纯色。
    if (patch.paint !== undefined) next.paint = patch.paint;
    else if (cur?.paint) next.paint = cur.paint;
    el.boxStroke = next;
  }
}

/**
 * 元素阴影（commit / 实时共用）。空列表 = 删字段。
 *
 * 逐层钳一遍：颜色原样、其余必须是**有限数**且模糊非负。面板给不出坏值，
 * 但 agent 与粘贴进来的 JSON 能 —— 一个 `NaN` 会让整条 `filter` 失效
 * （浏览器丢弃整条声明），表现是「调了半天阴影突然全没了」。
 */
function applyShadows(doc: TypographyDocument, list: ElementShadow[]): void {
  const next = list.map((s) => ({
    color: s.color,
    dx: Number.isFinite(s.dx) ? s.dx : 0,
    dy: Number.isFinite(s.dy) ? s.dy : 0,
    blur: Number.isFinite(s.blur) ? Math.max(0, s.blur) : 0,
  }));
  for (const el of anyElement(doc)) {
    if (next.length) el.shadows = next.map((s) => ({ ...s }));
    else delete el.shadows;
  }
}

/** 元素虚化（commit / 实时共用）。0 = 删字段（缺省语义就是「不虚化」）。 */
function applyBlur(doc: TypographyDocument, value: number): void {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  for (const el of anyElement(doc)) {
    if (v > 0) el.blur = v;
    else delete el.blur;
  }
}

/** 文字阴影（commit / 实时共用）。空列表 = 删字段。 */
function applyTextShadows(doc: TypographyDocument, list: TextStyleShadow[]): void {
  for (const el of onlyText(doc)) {
    const next: TextStyle = { ...el.style };
    if (list.length) next.shadow = list.map((s) => ({ ...s }));
    else delete next.shadow;
    el.style = next;
  }
}

/** 字形描边的写库体（commit / 实时共用）。与 `applyTextBoxStroke` 同款，只写到 glyphStroke。 */
function applyGlyphStroke(doc: TypographyDocument, patch: Partial<Stroke>): void {
  for (const el of onlyText(doc)) {
    const cur = el.glyphStroke;
    el.glyphStroke = {
      color: patch.color ?? cur?.color ?? '#ffffff',
      // 第一次点颜色就造一条 3px 的描边：比「设了色什么都没有」更容易发现，
      // 又不至于像 4px 那样把字形吃掉一大块（居中描边，见 document.ts）。
      width: patch.width !== undefined ? Math.max(0, patch.width) : (cur?.width ?? 3),
      style: 'solid',
    };
  }
}

/**
 * 描边填充方式的写库体（commit / 实时共用）。
 *
 * 语义与 `applyPaintPatch` 一致：**只有渐变 / 纹理才算「有填充」**，
 * `solid` / `none` 一律删掉 `paint` 字段、回到 `stroke.color` 那条老路
 * （与 `TextElement.fill` 同构，见 document.ts::Stroke.paint）。
 *
 * 本来没有描边、又被设成纯色的：**什么都不做** —— 不凭空造出一条 2px 白边
 * （与 `applyTextBoxStroke` 的「调宽度就创建」不同：那里用户的动作就是调宽度）。
 */
function applyStrokePaint(
  doc: TypographyDocument,
  target: 'shape' | 'box',
  patch: ShapePaintPatch,
): void {
  if (target === 'shape') {
    for (const el of onlyShape(doc)) {
      const next = strokePaintNext(el.stroke, patch);
      if (next) el.stroke = next;
    }
    return;
  }
  for (const el of onlyText(doc)) {
    const next = strokePaintNext(el.boxStroke, patch);
    if (next) el.boxStroke = next;
  }
}

/** 上面那个函数的一层：返回 null = 这次不改（见「什么都不做」那条注释）。 */
function strokePaintNext(cur: Stroke | null | undefined, patch: ShapePaintPatch): Stroke | null {
  const applied = applyPaintPatch(cur?.paint ?? { kind: 'none' }, patch);
  const painted = applied.kind !== 'none' && applied.kind !== 'solid' ? applied : null;
  if (!cur && !painted) return null;
  const next: Stroke = cur ? { ...cur } : { color: '#ffffff', width: 2, style: 'solid' };
  if (painted) next.paint = painted;
  else delete next.paint;
  return next;
}

/** `patchTransform3d` 的写库体（同样的理由：commit 与实时预览必须同源）。 */
function applyTransform3d(doc: TypographyDocument, patch: Transform3DPatch): void {
  for (const el of anyElement(doc)) {
    // 面板只在启用后才显示控件；合并函数从恒等值起算，免得别处调进来写出半个对象。
    el.transform3d = mergeTransform3D(el.transform3d, patch);
  }
}

/**
 * 写一个文本属性。**唯一实现** —— 提交路径与「拖动实时预览」路径共用，
 * 两处各写一份的话，「提交生效、预览不变」这类不一致迟早出现。
 *
 * ## 可被行内覆盖的键：同时清掉整段里该键的旧覆盖
 *
 * 不清的后果就是用户报的那个：「给部分文字单独设了字号 / 颜色 / 加粗，
 * 之后选整个文本框改同一个属性，那部分文字纹丝不动」—— 行内覆盖的优先级
 * 高于元素级，旧覆盖会一直钉着旧值，观感是「设置了却没生效」。
 * 行内选区那条路（`setTextStyle` 的 `coversWholeText` 分支）早就这么做了；
 * 这里是「点选文本框」（无行内选区）的同一件事：**整块级操作必须对整块
 * 一致生效**，不管是设值（这里）还是按比例缩放（`scaleFontSize`）。
 */
function writeTextProp<K extends keyof TextStyle>(
  doc: TypographyDocument,
  key: K,
  value: TextStyle[K],
): void {
  const spanKey = (SPAN_STYLE_KEYS as readonly string[]).includes(key)
    ? (key as SpanStyleKey)
    : null;
  for (const el of onlyText(doc)) {
    const next: TextStyle = { ...el.style, [key]: value };
    /*
     * `undefined` 的语义是**删掉这个键**，不是「把它设成 undefined」。
     * 可选字段（highlight / shadow）靠它表达「没有」：留一个值为 undefined
     * 的键虽然序列化时也会被丢掉，但它在 `Object.keys` 里是个幽灵 ——
     * 「这段有没有高亮」这类判断会开始依赖「是 undefined 还是不存在」。
     */
    if (value === undefined) delete (next as unknown as Record<string, unknown>)[key as string];
    el.style = next;
    if (spanKey) {
      el.runs = clearRunsSpanStyle(el.runs, 0, plainTextOf(el.runs).length, [spanKey]);
    }
  }
}

/** 对齐目标框：画布，或选区外接框。 */
function targetRect(): Rect {
  const doc = editorState.doc;
  if (appState.typoAlignTarget === 'selection') {
    return boundsOf(toRects(editorState.selected));
  }
  const size = doc?.size ?? { w: 1920, h: 1080 };
  return { id: 'canvas', x: 0, y: 0, w: size.w, h: size.h };
}

/**
 * 建一个图片元素并选中（一笔撤销）。
 *
 * 默认框**按素材原始比例**算（`defaultImageFrame` / `centeredImageFrame`），
 * 比例来自 `imageSourceFor` —— 那是引擎里已经解码好的那一份，插入路径上的每一个
 * 入口（Ribbon 插入 / 剪贴板粘贴 / 媒体池拖放）都已经登记过它，所以不需要在这里
 * 再解一次字节。解不出来（极端情况）就退回正方块：**不猜比例**。
 *
 * @param center 给了就按它当中心（粘贴是画布中心、拖放是鼠标落点）。
 */
function insertImageElement(
  assetId: string,
  name: string,
  center?: { x: number; y: number },
): string | null {
  let elId: string | null = null;
  const natural = imageSourceFor(assetId);
  editorState.commit(tr('typo.undo.addImage'), (doc) => {
    const el = createImageElement(doc.size, assetId, {
      name,
      ...(natural ? { natural: { w: natural.w, h: natural.h } } : {}),
      ...(center
        ? {
            frame: centeredImageFrame(
              doc.size,
              center.x,
              center.y,
              natural?.w ?? 0,
              natural?.h ?? 0,
            ),
          }
        : {}),
    });
    doc.elements = [...doc.elements, el];
    elId = el.id;
    queueMicrotask(() => editorState.selectOnly(el.id));
  });
  return elId;
}

/**
 * 把一份**新**图片字节登记成素材并置入文档。Ribbon 的「插入图片」与
 * 剪贴板粘贴走它；从媒体池拖进来的（素材已在册）走 `placeImageAssetImpl`。
 *
 * 登记分三层，缺一不可：
 *  ① `registerImageBytes`（engine）—— 时间轴把图片当画面源时要的那份解码结果；
 *  ② `putImageBytes`（typography）—— 舞台渲染与 snapDOM 光栅化要的 objectURL；
 *  ③ `assets.put` + `p.assets[]` —— 保存工程时的字节与元信息。
 */
async function placeImageBytesImpl(
  name: string,
  data: ArrayBuffer,
  center?: { x: number; y: number },
): Promise<string | null> {
  const assetId = newId();
  const mime = mimeForImageFilename(name);
  // 解码放在最前面：解不开的字节不该在工程里留下一条永远画不出来的素材
  //（与 media-import.ts 的 importImageBlob 同一条取舍）。
  try {
    await registerImageBytes(assetId, new Blob([data], { type: mime }));
  } catch {
    appState.flash(tr('err.image.unreadable', { name }), 'error');
    return null;
  }
  // 尺寸从解码结果取（拿不到就不写，不猜）。Asset.size 只是展示用。
  const decoded = imageSourceFor(assetId);

  putImageBytes(assetId, data, mime);
  // 字节进仓。直接持有 `data` 上的视图，不额外拷贝：这份 buffer 是刚读出来的，
  // 没有第二个持有者（上面两步各自内部拷贝）。
  appState.assets.put(assetId, new Uint8Array(data), {
    kind: 'image',
    name,
    originName: name,
  });
  appState.store.commit(tr('typo.undo.registerImageAsset'), (p) => {
    p.assets[assetId] = {
      id: assetId,
      kind: 'image',
      name,
      ...(decoded ? { size: { w: decoded.w, h: decoded.h } } : {}),
    };
  });

  return insertImageElement(assetId, name, center);
}

/**
 * 把**已在册**的图片素材置入文档（媒体池拖到画布）。
 *
 * 不再登记一遍 —— 那会给同一张图造出第二个 assetId，媒体池里立刻多出一条
 * 一模一样的素材。这里只在 objectURL 缺席时补一条（正常路径上导入与打开工程
 * 都已建过，见 `project-actions.ts::hydrateRenderAssets`；补这条是为了万一
 * 拿不到 URL 时画布上不会留一个空洞）。
 */
function placeImageAssetImpl(
  assetId: string,
  name: string,
  center?: { x: number; y: number },
): string | null {
  if (!hasImageAsset(assetId)) {
    // 同步 API 只能拿**已在内存里**的字节（图片从台账读回时就是 bytes 来源）；
    // 拿不到就是真拿不到 —— 视频那样的句柄来源不该被这里同步读一遍。
    const bytes = appState.assets.bytesOf(assetId);
    if (!bytes) {
      appState.flash(tr('pool.missing'), 'error');
      return null;
    }
    putImageBytes(assetId, bytes.slice().buffer as ArrayBuffer, mimeForImageFilename(name));
  }
  return insertImageElement(assetId, name, center);
}

/* ------------------------------------------------------------ 动作表 */

export interface TypographyActions {
  /* 文本 */
  setTextProp<K extends keyof TextStyle>(key: K, value: TextStyle[K]): void;
  /**
   * 文本属性的**统一写入口**：编辑中且选中了一段字 ⇒ 写行内覆盖；
   * 否则写元素级。Ribbon 上的文本控件一律走它 —— 让每个控件自己判断
   * 「现在改的是整块还是一段」等于把这个判断抄了 N 份。
   *
   * 走元素级时（含「全选文本」与「点选文本框」两种形态）会**同时清掉整段里
   * 该键的旧行内覆盖** —— 不清的话旧覆盖继续压着新设的值，症状是
   * 「选了文本框、设了样式、被单独改过的那部分没反应」。
   */
  setTextStyle<K extends SpanStyleKey>(key: K, value: TextStyle[K]): void;
  /**
   * 按比例缩放字号（「增大 / 减小字号」按钮）。`factor > 1` 变大。
   *
   * 为什么是缩放而不是「跳到阶梯上的相邻档」：用户按下这个按钮的意图是
   * 「大一点点 / 小一点点」，而阶梯（12/16/20/…）会把 37 号字一步带到 40，
   * 把他调好的相对关系弄丢。相对关系在混合选区里尤其重要 ——
   * 24 与 48 一起放大 1.15 倍之后仍然是 1:2。
   *
   * 点选文本框（无行内选区）时同样保持这个语义：元素级字号与**行内覆盖过的
   * 字号一起按比例缩放**，没有行内选区的片段与有行内选区的片段行为一致。
   */
  scaleFontSize(factor: number): void;
  /**
   * 还能不能继续缩放字号（「增大 / 减小字号」按钮的可用性）。
   *
   * 上下界在**动作这一侧**（`FONT_SIZE_LIMITS`），不放到 Ribbon 去 ——
   * 两处各判一次的形态是「按钮还亮着，按了没反应」。
   * 混合选区永远可用：各段各自乘，总有还能动的那一处。
   */
  canScaleFontSize(dir: -1 | 1): boolean;
  /** 直接写行内覆盖（`null` = 删掉这条覆盖，回到元素级）。 */
  setSpanStyle(patch: SpanStylePatch): void;
  /** 清掉选中范围的**全部**行内覆盖。 */
  clearSpanFormats(): void;
  /** 现在有没有「行内选区」（「清除格式」的可用性）。 */
  hasSpanRange(): boolean;
  /** 拖动调值时的实时预览（不入撤销栈，松手时 `endTextPropLive` 结算一笔）。 */
  setTextPropLive<K extends keyof TextStyle>(key: K, value: TextStyle[K]): void;
  /** 实时预览收尾。没在实时改就什么都不做。 */
  endTextPropLive(): void;
  setTextAlign(value: TextStyle['align']): void;
  setVAlign(value: TextStyle['vAlign']): void;
  toggleTextFlag(key: 'bold' | 'italic' | 'underline' | 'strike'): void;
  /**
   * 文字阴影：**整份替换**（`undefined` = 去掉阴影）。
   *
   * 独立一个动作而不是塞进 `setTextStyle`：阴影是个数组，而 `setTextStyle`
   * 的键值语义（还能按行内覆盖）对它是错的 —— 阴影**只有元素级**
   * （见 `SPAN_STYLE_KEYS`：同一行里两种阴影谁也画不对）。
   *
   * 为什么是整份而不是「按下标打补丁」：面板上的层会增删，逐层补丁要求调用方
   * 维护一份稳定的下标映射 —— 那正是「删掉一层之后改到另一层」这类 bug 的来源
   * （与色标列表同一条教训，见 `ShapePaintPatch.stops`）。
   */
  setTextShadow(shadow: TextStyleShadow[] | undefined): void;
  /** 实时版本（拖动某层的偏移 / 模糊时连续写，松手由 `endLive` 结算）。 */
  setTextShadowLive(shadow: TextStyleShadow[]): void;
  /**
   * 「突出显示颜色」。`undefined` = 去掉高亮。
   *
   * 与 `setTextStyle('highlight', v)` 的差别只在**清除**：那边 `undefined`
   * 是「这一项不动」（补丁语义），清不掉已经设好的高亮。这里显式表达
   * 「删掉这条覆盖 / 删掉这个键」，所以得单独一个动作。
   */
  setTextHighlight(color: string | undefined): void;
  /**
   * 「清除全部格式」。
   *
   * 有行内选区 ⇒ 清那一段的覆盖（`clearSpanFormats`）；否则把选中文本元素的
   * **字形类**属性恢复默认。段落级属性（行高 / 对齐 / 竖排）**保留** ——
   * 它们是版式决定，不是「格式」，清掉会让整块文字的排版塌回默认。
   */
  clearTextFormatting(): void;

  /* 配色方案 */
  /**
   * 切换文档的配色方案（用了主题色的元素会跟着变）。
   *
   * `scope: 'clip'`（默认）只改当前文档；`'project'` 应用到工程里所有文本
   * 片段，并设为新片段的默认（一笔撤销，见实现）。
   */
  setTheme(id: string, scope?: 'clip' | 'project'): void;
  /**
   * 保存一份自定义配色方案（新建或改槽位），并设为当前文档的方案。
   * 一笔撤销；内置方案是只读数据表，要改先 `cloneAsCustomTheme` 复制。
   */
  saveCustomTheme(theme: TypographyTheme): void;
  /**
   * 移除一份自定义配色方案（图库里右键它 → 「移除」）。一笔撤销。
   *
   * 引用它的地方**就地回落**成「没设过」：`doc.theme` 与
   * `Project.typographyTheme` 都删掉。渲染结果与 `themeById` 的回落一致
   * （画面本来就会回到默认方案），但工程里不再留悬空 id。
   */
  removeCustomTheme(id: string): void;

  /* 插入 */
  addText(): void;
  addShape(preset: ShapePreset): void;
  /**
   * 插入一个生成器图形（「插入生成器」选择器）。
   *
   * 路径在插入时**烘焙**成普通 `shape:'svg'`；`gen` 只保存「怎么再生成一次」。
   * 渲染只读 `path`，所以生成器元数据不影响光栅化缓存口径。
   */
  addGeneratedShape(id: string): void;
  /**
   * 切换生成器类型。作用于所有选中的生成器元素，参数重置为新类型的默认值，
   * **种子保留**（「换个生成器、同一个种子」是常见对比手法）。
   */
  setGeneratorType(id: string): void;
  /** 离散改一个参数（下拉 / 开关）：一笔撤销。 */
  setGeneratorParam(key: string, value: number | string): void;
  /** 拖动中的实时改参（滑动中不入撤销栈）。 */
  setGeneratorParamLive(key: string, value: number): void;
  /** 手势收尾：一次拖动只落一笔撤销。 */
  endGeneratorParamLive(): void;
  /** 直接指定种子（数字框）。 */
  setGeneratorSeed(seed: number): void;
  /** 换一个种子：同参数摇出另一张，且旧种子可复现。 */
  reseedGenerator(): void;
  addImage(): void;
  /**
   * 把一份图片字节置入画布（剪贴板粘贴 / 媒体池拖放 / 文件选择器共用）。
   *
   * `center` 是文档坐标的落点（不给 = 画布中心）。返回新元素 id；
   * 解不开的字节返回 null（已 flash 过原因）。
   */
  placeImageBytes(
    name: string,
    data: ArrayBuffer,
    center?: { x: number; y: number },
  ): Promise<string | null>;
  /** 把已在册的图片素材置入画布（媒体池拖放）。返回新元素 id。 */
  placeImageAsset(
    assetId: string,
    name: string,
    center?: { x: number; y: number },
  ): string | null;
  /** 插入一批图标（来自图标选择器），按给定顺序从左到右排成网格。 */
  addIcons(items: IconInsert[]): void;

  /* 通用元素属性 */
  setBlend(value: MixBlend): void;
  setOpacity(value: number): void;
  /**
   * 镜头景深（0..1，多选时逐个写）。0 删字段（= 无穷远，不吃镜头）。
   *
   * 景深是**元素级**的、镜头是文档级的：混在一起写会让「调一个元素的景深」
   * 顺手把镜头重置掉。
   */
  setDepth(value: number): void;
  /** 实时版本（滑杆拖动中连续写，松手由 `endLive` 结算）。 */
  setDepthLive(value: number): void;
  /**
   * 改镜头（`camera.ts` 的参数，缺省键不动）。只影响 `depth > 0` 的元素。
   * 恒等时删字段 —— 与「从来没设过」逐像素相同。
   *
   * `atSec` = 播放头在片段内的秒数：**该通道有关键帧时写那一帧**，否则写基准值。
   */
  setCamera(patch: Partial<Camera>, atSec?: number): void;
  setCameraLive(patch: Partial<Camera>, atSec?: number): void;
  /** 复位镜头（删基准值与全部镜头关键帧，一笔撤销）。 */
  resetCamera(): void;
  /**
   * 元素几何（属性面板的「位置 / 大小 / 旋转」）。
   *
   * 多选语义：改位置时以**首元素为锚整体平移**（相对位置保持），而不是把
   * 每个元素都设成同一个值 —— 后者会把它们叠在一起。宽 / 高 / 旋转只对单选
   * 有意义（多选时「那条边」没有唯一定义，与拖拽缩放不做组版本同源）：
   * 面板在多选时禁用它们，这里再兜一道，非单选直接忽略。
   */
  setFrame(patch: Partial<TextureFrame>): void;

  /* 实时预览（属性面板的数字框拖动）：连续写、松手结算成一笔 */
  /** 位置 / 大小 / 旋转的实时版本（与 `setFrame` 同一套多选语义）。 */
  setFrameLive(patch: Partial<TextureFrame>): void;
  setOpacityLive(value: number): void;
  patchTransform3dLive(patch: Transform3DPatch): void;
  /** 结算一次实时预览（松手）。无变化的事务由撤销栈自己丢弃。 */
  endLive(label: string): void;

  /* 元素级 3D 变换（所有元素类型通用） */
  /** 打开 / 关闭 3D。关闭 = 删字段（缺省语义就是「没有 3D」）。 */
  setTransform3dEnabled(enable: boolean): void;
  /** 改 3D 参数。嵌套对象逐层合并；未启用时会先补一份默认值。 */
  patchTransform3d(patch: Transform3DPatch): void;

  /* 阴影 / 虚化（所有元素类型通用） */
  /**
   * 元素阴影：**整份替换**。空数组 = 删字段（缺省语义就是「没有阴影」）。
   *
   * 与文字阴影同一套理由：层会增删，逐层补丁的下标映射迟早错位。
   */
  setShadows(list: ElementShadow[]): void;
  /** 实时版本（拖动某层的偏移 / 模糊）。 */
  setShadowsLive(list: ElementShadow[]): void;
  /** 元素虚化半径（文档 px）。0 = 不虚化。 */
  setBlur(value: number): void;
  /** 实时版本。 */
  setBlurLive(value: number): void;

  /* 图片元素的抠图 / 四角（元素级，只作用于图片） */
  /** 打开 / 关闭抠图。打开时若还没有参数，写一份默认绿幕。 */
  setImageKey(enable: boolean): void;
  /** 改抠图参数（任一字段）。没有参数时会先补一份默认值。 */
  patchImageKey(patch: Partial<KeySettings>): void;
  /** 打开 / 关闭四角调整。打开时写恒等四角（= 开但不变形）。 */
  setImageQuad(enable: boolean): void;
  /** 四角复位成恒等（保留开关）。 */
  resetImageQuad(): void;

  toggleFlag(key: 'locked' | 'visible'): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  order(op: ZOrderOp): void;

  /* 剪贴板（编辑器内部，不碰系统剪贴板） */
  copySelection(): void;
  cutSelection(): void;
  pasteClipboard(): void;
  /** 剪贴板里有没有东西（右键菜单据此置灰「粘贴」）。 */
  hasClipboard(): boolean;

  /* 组合 */
  groupSelection(): void;
  ungroupSelection(): void;
  /** 选区里有没有可成组的东西（≥2 个元素）。 */
  canGroup(): boolean;
  /** 选区里有没有落在组合里的元素。 */
  canUngroup(): boolean;
  setGroupPaint(patch: ShapePaintPatch): void;
  setGroupStrokeColor(color: string): void;
  setGroupStrokeWidth(width: number): void;
  setGroupNumber(key: 'radius' | 'padding', value: number): void;

  /* 格式刷 / 动画刷 */
  /**
   * 启用刷子（源 = 当前**单选**的那个元素）。
   *
   * `sticky` = 双击启用的连续模式：刷完一个继续等下一个。同一种刷子再点一次
   * （`sticky` 为 false）= 取消。
   */
  togglePainter(kind: 'format' | 'animation', sticky: boolean): void;
  /** 收起刷子（再点按钮 / 点空白 / Esc 都走这里）。 */
  cancelPainter(): void;
  /** 把刷子应用到某个元素（点中目标时调）。返回是否真的改了文档。 */
  applyPainterTo(targetId: string): boolean;
  /** 按钮可用性：已启用（允许再点一下取消）或当前恰好单选了一个元素。 */
  canPaint(kind: 'format' | 'animation'): boolean;

  /* 图形 */
  setShapeFill(color: string): void;
  /** 填充类型 / 渐变 / 纹理的**一处**写入路径（见 document.ts 的 applyPaintPatch）。 */
  setShapePaint(patch: ShapePaintPatch): void;
  /** 实时版本（拖动数字框时连续写，松手由 `endLive` 结算）。 */
  setShapePaintLive(patch: ShapePaintPatch): void;
  /**
   * 文本**字形填充**的局部更新（渐变 / 径向 / 纹理）。
   *
   * 与图形填充共用 `applyPaintPatch` —— 只有渲染落点不同（字形走 CSS
   * `background-clip: text`，见 css.ts::textFillStyle）。`solid` / `none`
   * 对字形没有意义：纯色字形仍走 `style.color`，「跟随文字色」由
   * `clearTextFill` 把字段整个清掉。
   */
  setTextFill(patch: ShapePaintPatch): void;
  /** 实时版本（见 setShapePaintLive）。 */
  setTextFillLive(patch: ShapePaintPatch): void;
  /** 清掉文本字形填充，回到 `style.color` 纯色字形。 */
  clearTextFill(): void;
  /**
   * **文本框背景**填充的局部更新（属性面板）。
   *
   * 与 `setTextFill` 是两层东西：那个是字形着色（`background-clip: text`），
   * 这个是画在文本元素外壳上的背景（文字之下）。见 TextElement.boxFill。
   */
  setTextBoxFill(patch: ShapePaintPatch): void;
  /** 实时版本（见 setShapePaintLive）。 */
  setTextBoxFillLive(patch: ShapePaintPatch): void;
  /** 文本框边框（颜色 / 宽度 / 线型 / 填充）。局部更新，缺省字段沿用原值。 */
  setTextBoxStroke(patch: Partial<Stroke>): void;
  /** 实时版本（拖动边框宽度时连续写）。 */
  setTextBoxStrokeLive(patch: Partial<Stroke>): void;
  /**
   * **描边的填充方式**（渐变 / 纹理）的局部更新。两处描边共用这一个动作 ——
   * 图形描边走 SVG `url(#…)`，文本框边框走 CSS `border-image`，差别只在
   * 渲染出口（见 document.ts::Stroke.paint）。
   *
   * `kind: 'none'` = 回到纯色（删掉 `paint` 字段，不是写 `{kind:'none'}`）。
   */
  patchStrokePaint(target: 'shape' | 'box', patch: ShapePaintPatch): void;
  /** 实时版本（拖动渐变角度 / 纹理周期）。 */
  patchStrokePaintLive(target: 'shape' | 'box', patch: ShapePaintPatch): void;
  /**
   * **字形描边**（`-webkit-text-stroke`）的局部更新，只对文本框。
   *
   * `width: 0` = 关掉（与文本框边框同一套「不做有/无两态」的语义）。
   * 注意它是**居中**描边：半个宽度压在字形里，面板上的提示也是这么写的。
   */
  setGlyphStroke(patch: Partial<Stroke>): void;
  /** 实时版本（拖动宽度时连续写）。 */
  setGlyphStrokeLive(patch: Partial<Stroke>): void;
  /**
   * 布尔运算（并 / 差 / 交 / 异或）。作用于选中的图形，结果为**一个** `svg` 图形。
   * 差集是「**最底层**那个减去其余」（与 Illustrator 的 Minus Front、Figma 的
   * Subtract 一致：后画的图形挖掉前面的）。
   */
  booleanShapes(op: BoolOp): void;
  /**
   * 拆分（分割）：按彼此的边界把选中图形切成互不重叠的面，**每个面一个图形**。
   * 与异或的区别见 `path-ops.ts::dividePolygons`。
   */
  divideShapes(): void;
  /** 选中的图形够不够做布尔运算（≥2 个）。 */
  canBoolean(): boolean;
  setShapeStroke(color: string): void;
  setShapeStrokeWidth(width: number): void;
  /** 实时版本（拖动线宽时连续写）。 */
  setShapeStrokeWidthLive(width: number): void;
  setShapeStrokeStyle(style: 'solid' | 'dashed' | 'dotted'): void;
  setShapeRadius(radius: number): void;
  /** 形状参数（边数 / 锐利度 / 壁厚 / 张角）。所有图形共用一条写入路径。 */
  setShapeParam(key: 'sides' | 'waist' | 'inner' | 'angle', value: number): void;

  /* 顶点 / 控制点编辑 */
  /** 进入 / 退出顶点编辑（Ribbon 按钮与快捷键共用同一个入口）。 */
  toggleNodeEdit(): void;
  /** 把参数化图形转成路径。之后它的形状由顶点决定，参数控件不再适用。 */
  convertToPath(): void;
  /**
   * 把选中的文本框**转成真正的路径**（每个字形一份轮廓，坐标落在像素盒里）。
   *
   * 异步：先按 face 取字体字节、再逐字形取轮廓。任何一步失败都只 flash
   * 一条提示、**不改文档**（半成品转换会静默换字形，比不做更糟）。
   */
  convertTextToPath(): void;
  /** 双击路径：在命中位置插一个锚点（de Casteljau 细分，形状不变）。 */
  addPathNode(hit: { sub: number; seg: number; t: number }): void;
  /** 双击锚点：删掉它（相邻两段合并成一段）。 */
  deletePathNode(index: number): void;

  /* 图片 */
  setImageFit(value: ImageElement['fit']): void;
  /** 图片圆角（0 = 直角）。 */
  setImageRadius(value: number): void;
  /**
   * 色彩校正。`patch` 里缺的字段沿用原值（`coerceImageAdjust` 的 `base`）——
   * 浮层上五个滑杆各发各的补丁，不该互相覆盖。
   */
  patchImageAdjust(patch: ImageAdjustPatch): void;
  /** 实时版本（拖动滑杆时连续写，松手由 `endLive` 结算）。 */
  patchImageAdjustLive(patch: ImageAdjustPatch): void;
  /** 单通道曲线。`null` / 空数组 = 重置该通道。 */
  setImageCurve(channel: CurveChannel, points: CurvePoint[] | null): void;
  /** 曲线拖动中的实时版本（不入撤销栈）。 */
  setImageCurveLive(channel: CurveChannel, points: CurvePoint[]): void;
  /** 滤镜（`null` = 关掉）。 */
  setImageFilter(filter: ImageFilterState | null): void;
  /** 滤镜强度拖动中的实时版本。 */
  setImageFilterLive(filter: ImageFilterState): void;
  /** 重新着色（颜色 / 暗部色 / 强度）。 */
  patchImageRecolor(patch: Partial<ImageRecolor>): void;
  /** 强度拖动中的实时版本。 */
  patchImageRecolorLive(patch: Partial<ImageRecolor>): void;
  /** 图片边框（宽度 0 = 去掉边框）。 */
  patchImageBorder(patch: Partial<ImageBorder>): void;
  /** 按纵横比裁剪（`null` = 恢复整图）。会顺手把 `contain` 提成 `cover`。 */
  setImageCropAspect(ratio: number | null): void;
  /** 直接写裁剪窗（0..1 源比例），浮层之外的程序化入口用。 */
  setImageCrop(rect: ImageCropRect | null): void;
  /** 对齐到画布（居中 / 水平 / 垂直 / 适应 / 铺满 / 拉伸）。 */
  alignImagesToCanvas(mode: ImageAlignMode): void;
  /** 改尺寸，保持中心不动；`lockAspect` 按各自当前比例推另一边。 */
  resizeImages(next: { w?: number; h?: number }, lockAspect: boolean): void;
  /**
   * 「裁剪为形状」：把选中的图片**就地换成**一个带图片填充的图形
   * （同一个 id / 位置 / 层级 / 动画）。`presetKey` 来自 `SHAPE_PRESETS`。
   */
  clipImagesToShape(presetKey: string): void;
  /** 图形的图片填充（`null` = 移除）。 */
  setShapeImageFill(fill: { assetId: string; fit: 'fill' | 'contain' | 'cover' } | null): void;

  /* 对齐 */
  align(axis: AlignAxis): void;
  setAlignTarget(target: 'canvas' | 'selection'): void;

  /* 动画 */
  applyPreset(preset: AnimPreset): void;
  /** 写入手写 keyframes 体。返回 false 表示代码非法（未写入）。 */
  applyCustomCss(css: string): boolean;
  clearAnimations(): void;

  /* 关键帧（结构化轨道，一条动画一个属性） */
  /**
   * 给选中元素加一条属性轨道。`atSec` 缺省 = 片段起点；同一 **(属性, 作用层)**
   * 已有时不重复加（返回时调用方自己按 prop + target 找回那条）。
   *
   * `target` 缺省 = `'box'`（整个元素框，含文本框底板与边框）；`'content'`
   * 只动文字 / 图形本身。已有轨道换层要删了重建 —— 它是 DOM 结构差异。
   */
  addTrack(prop: string, initial?: number | string, atSec?: number, target?: AnimTarget): void;
  removeTrack(animId: string): void;
  /**
   * 把一条动画的作用层改成 `box`（整个元素框）或 `content`（只动内容）。
   *
   * 换层会让动画层在 DOM 里换位置（`.typo-box` 在外面 / `.typo-anim` 在里面），
   * 所以 `docSignature` 认它、下一帧整棵重建 —— 动画不会中断（seek 按时间重算）。
   */
  setTrackTarget(animId: string, target: AnimTarget): void;
  /**
   * 整条轨道**循环播放**（CSS `animation-iteration-count: infinite`）。
   *
   * 走 `iterations` 而不是新加一个 `loop` 字段：模型里它本来就是这个意思
   * （`Infinity` → `infinite`），多一个同义字段只会有「两个真源」的分叉。
   */
  setTrackLoop(animId: string, loop: boolean): void;
  /** 在 `t` 处插一帧；`v` 缺省 = 该时刻的插值（浮动轨道取恒等值）。 */
  addKey(animId: string, t: number, v?: number | string): void;
  setKeyValue(animId: string, t: number, v: number | string): void;
  /** 精确改一帧的时刻（拖动走 `moveKey`，那是手势、不拍快照）。 */
  setKeyTime(animId: string, t: number, nextT: number): void;
  setKeyEase(animId: string, t: number, ease: TrackEase | null): void;
  /**
   * 关键帧的**标记色**（`#rrggbb`；`null` = 去掉标记）。
   *
   * 只给编辑器看，**不影响动画**：`channelDeclaration` 与样式表都不读它。
   * 一次写一批（框选后刷同一个颜色 = **一笔撤销**），逐个 commit 会灌满撤销栈。
   */
  setKeysColor(keys: { animId: string; t: number }[], color: string | null): void;
  /** 缓动浮层拖动中的实时写入（不进撤销栈，松手由手势结算）。 */
  liveKeyEase(animId: string, t: number, ease: TrackEase | null): void;
  /** 拖动关键帧：手势里调（`live`，不 commit）。 */
  moveKey(animId: string, t: number, nextT: number): void;
  removeKey(animId: string, t: number): void;

  /* 字体 */
  importFont(): void;
  /**
   * 读**本机已安装**的字体族，并进字体下拉。
   *
   * 与 `importFont` 的区别：那个是把字体**文件**注册进 `FontRegistry`（有字节、
   * 导出时可子集化嵌入）；这个只是拿到一串系统的族名 —— 不产生任何资产，
   * 换台机器就没有了。
   */
  loadLocalFonts(): void;

  /* 逃生舱 */
  /** 把排版文档 1:1 烘焙成一张 PNG，并把片段改成 image 源。 */
  flattenToImage(localSec: number): void;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 字号缩放的安全区间。
 *
 * 比 Ribbon 那张阶梯（12…200）宽：**缩放是相对的，不该被阶梯端点卡住** ——
 * 一个 8 号的小注脚、一个 240 号的大标题都该还能再动一点。
 * 上下界只是防止按着不放把字号推到 3 或 3000 那种画不出东西的量级。
 */
const FONT_SIZE_LIMITS = { min: 8, max: 320 } as const;

const clampFontSize = (n: number): number =>
  r2(Math.min(FONT_SIZE_LIMITS.max, Math.max(FONT_SIZE_LIMITS.min, n)));

/* ------------------------------------------------------------ 剪贴板
 *
 * 状态存在 `editorState.clipboard`（响应式），不在这里的模块作用域 ——
 * 原因见那边的注释：右键菜单的「粘贴」可用性必须跟着它变。
 * 这里只留纯函数。
 */
const PASTE_OFFSET = 24;

function writeClipboard(frag: GroupedFragment): void {
  editorState.clipboard = frag;
  editorState.pasteCount = 1;
}

/**
 * 当前的行内选区（**校验过它确实落在一个存在的文本元素上**）。
 *
 * 校验这一步不能省：编辑中切换元素 / 文档被重建时 `textRange` 可能指向一个
 * 已经不存在的元素，直接拿 start/end 去切片会切到别人身上。
 */
function textSpanRange(): { elId: string; start: number; end: number } | null {
  const r = editorState.textRange;
  if (!r) return null;
  const doc = editorState.doc;
  const el = doc?.elements.find((x) => x.id === r.elId);
  if (!el || el.kind !== 'text') return null;
  const total = plainTextOf(el.runs).length;
  const start = Math.max(0, Math.min(r.start, total));
  const end = Math.max(0, Math.min(r.end, total));
  return end > start ? { elId: r.elId, start, end } : null;
}

/**
 * 当前**格式上下文**里某个文本属性的生效值。
 *
 * 有行内选区 ⇒ 取区间上的统一值（混合时取区间起点的值，交给调用方决定要不要
 * 当作「不定态」）；没有 ⇒ 取首个选中文本元素的元素级值。
 * 返回 null = 根本没有作用对象（按钮那时本来就是禁用态）。
 */
function currentTextValue<K extends SpanStyleKey>(key: K): TextStyle[K] | null {
  return currentTextUniform(key)?.value ?? null;
}

/**
 * 同 `currentTextValue`，但**带上「区间内是否一致」**。
 *
 * 不一致这件事本身是有意义的（PPT 的交互就建在它上面）：
 *  - 加粗 / 斜体：「全部已生效」才整体取消，否则整体施加；
 *  - 字号：区间内不一致时输入框显示 `97+`（模糊值），而不是硬选一个数。
 * 把 `uniform` 吞掉的旧签名做不到这两件事 —— 而它们正是用户要的「按直觉来」。
 */
function currentTextUniform<K extends SpanStyleKey>(
  key: K,
): { uniform: boolean; value: TextStyle[K] } | null {
  const doc = editorState.doc;
  const range = textSpanRange();
  if (doc && range) {
    const el = doc.elements.find((x) => x.id === range.elId);
    if (el && el.kind === 'text') {
      return uniformSpanValue(el.runs, range.start, range.end, el.style, key);
    }
  }
  const t = editorState.selected.find((e) => e.kind === 'text');
  return t && t.kind === 'text' ? { uniform: true, value: t.style[key] } : null;
}

/** 把片段复制一份并落进文档（粘贴 / 复制 / Ctrl 拖曳共用）。 */
function placeFragment(
  frag: GroupedFragment,
  offset: number,
  select: boolean,
  label: string,
): TypographyElement[] {
  const clone = cloneFragment(frag, offset, newId);
  editorState.commit(label, (doc) => {
    doc.elements = [...doc.elements, ...clone.elements];
    if (clone.groups.length) doc.groups = [...(doc.groups ?? []), ...clone.groups];
  });
  if (select) {
    queueMicrotask(() => editorState.setSelection(clone.elements.map((e) => e.id)));
  }
  return clone.elements;
}

export function createTypographyActions(): TypographyActions {
  return {
    /* ---------------------------------------------------------- 文本 */

    setTextProp(key, value) {
      // 实时预览进行中：这一笔属于那个手势事务，不能再开一条撤销记录
      // （否则一次拖拽会变成「预览一条 + 提交一条」两条，Ctrl+Z 要按两次）。
      if (editorState.gestureActive) {
        editorState.live((doc) => writeTextProp(doc, key, value));
        return;
      }
      editorState.commit(tr('typo.undo.textProp'), (doc) => writeTextProp(doc, key, value));
    },

    setTextStyle(key, value) {
      const range = textSpanRange();
      const doc = editorState.doc;
      // 行内选区只对「可以行内覆盖」的属性有意义；行高 / 对齐这类段落属性
      // 永远写元素级（同一行里两种行高谁也画不对，见 rich-text.ts）。
      if (range && doc && (SPAN_STYLE_KEYS as readonly string[]).includes(key)) {
        const el = doc.elements.find((x) => x.id === range.elId);
        /*
         * **全选 = 改整块**（用户报的「全选后设样式不起效」）。
         *
         * 原来只要落在文本元素上就一律写行内覆盖：Ctrl+A 之后点字体 / 字号 /
         * 加粗，得到的是一整段行内覆盖，元素级**一点没变**。用户看到的
         * 「选了文本框、设了样式、没反应」就是这个 —— 内部的 span 优先级
         * 高于文本框本身。
         *
         * 所以全选时落到元素级，并**同时清掉区间内该键的旧覆盖**（不清的话
         * 那些覆盖会继续压着新设的元素级，症状一模一样）。两件事必须同一笔
         * 撤销里做完，否则 Ctrl+Z 只回来一半。
         */
        if (el?.kind === 'text' && coversWholeText(el.runs, range.start, range.end)) {
          editorState.commit(tr('typo.undo.textProp'), (d) => {
            const t = d.elements.find((x) => x.id === range.elId);
            if (!t || t.kind !== 'text') return;
            t.style = { ...t.style, [key]: value } as TextStyle;
            t.runs = clearRunsSpanStyle(t.runs, range.start, range.end, [key as SpanStyleKey]);
          });
          return;
        }
        this.setSpanStyle({ [key]: value } as SpanStylePatch);
        return;
      }
      this.setTextProp(key, value);
    },

    scaleFontSize(factor) {
      if (!(factor > 0) || factor === 1) return;
      const range = textSpanRange();
      const doc = editorState.doc;
      const el = doc && range ? doc.elements.find((x) => x.id === range.elId) : undefined;

      /*
       * 有行内选区（含**全选**）一律**逐处**缩放，不走「全选 = 改整块」那条捷径。
       *
       * 这是与 `setTextStyle` 刻意不同的取舍：「设一个值」时用户要的是整块统一，
       * 全选落元素级是对的；而「按比例缩放」时用户要的是**比例关系不变** ——
       * 全选落元素级 + 清覆盖会把 24 与 48 的混排一步抹平成同一个字号，
       * 而输入框上那个 `XX+` 刚刚才告诉他这里有大小之分。
       */
      if (el?.kind === 'text' && range) {
        editorState.commit(tr('typo.undo.spanStyle'), (d) => {
          const t = d.elements.find((x) => x.id === range.elId);
          if (!t || t.kind !== 'text') return;
          t.runs = scaleSpanFontSize(t.runs, range.start, range.end, t.style, factor, FONT_SIZE_LIMITS);
        });
        return;
      }

      // 没有行内选区：缩放全部选中文本元素的元素级字号（一笔撤销）。
      editorState.commit(tr('typo.undo.textProp'), (doc2) => {
        for (const t of onlyText(doc2)) {
          t.style = { ...t.style, fontSize: clampFontSize(t.style.fontSize * factor) };
          /*
           * 行内覆盖过的字号**按同一比例**缩放 —— 不是清掉、也不是不动。
           *
           * 不动就是用户报的「部分文字的字号不跟着变」；清掉则会把 24/48 的
           * 混排一步抹平成同一个字号，而输入框上的 `XX+` 刚刚才告诉他这里
           * 有大小之分。与有行内选区时走 `scaleSpanFontSize` 的行为保持一致
           * （那边也是逐处按比例乘，保留相对关系）。
           */
          if (t.runs.some((r) => r.style?.fontSize !== undefined)) {
            t.runs = normalizeRuns(
              t.runs.map((r) =>
                r.style?.fontSize === undefined
                  ? r
                  : {
                      ...r,
                      style: { ...r.style, fontSize: clampFontSize(r.style.fontSize * factor) },
                    },
              ),
            );
          }
        }
      });
    },

    canScaleFontSize(dir) {
      const cur = currentTextUniform('fontSize');
      if (!cur) return false;
      if (!cur.uniform) return true;
      return dir < 0 ? cur.value > FONT_SIZE_LIMITS.min : cur.value < FONT_SIZE_LIMITS.max;
    },

    setSpanStyle(patch) {
      const r = textSpanRange();
      if (!r) return;
      editorState.commit(tr('typo.undo.spanStyle'), (d) => {
        const el = d.elements.find((x) => x.id === r.elId);
        if (el && el.kind === 'text') el.runs = applySpanStyle(el.runs, r.start, r.end, patch);
      });
    },

    clearSpanFormats() {
      const r = textSpanRange();
      if (!r) return;
      editorState.commit(tr('typo.undo.clearFormat'), (d) => {
        const el = d.elements.find((x) => x.id === r.elId);
        if (el && el.kind === 'text') el.runs = clearRunsSpanStyle(el.runs, r.start, r.end);
      });
    },

    hasSpanRange() {
      return textSpanRange() !== null;
    },

    setTextPropLive(key, value) {      if (!editorState.gestureActive) editorState.beginGesture();
      editorState.live((doc) => writeTextProp(doc, key, value));
    },

    endTextPropLive() {
      if (!editorState.gestureActive) return;
      editorState.endGesture(tr('typo.undo.textProp'));
    },

    setTextAlign(value) {
      editorState.commit(tr('typo.undo.textAlign'), (doc) => {
        for (const el of onlyText(doc)) el.style = { ...el.style, align: value };
      });
    },

    setVAlign(value) {
      editorState.commit(tr('typo.undo.vAlign'), (doc) => {
        for (const el of onlyText(doc)) el.style = { ...el.style, vAlign: value };
      });
    },

    toggleTextFlag(flag) {
      /*
       * 开关的语义是「在**当前生效值**上取反」，不是「把元素级取反」。
       * 一段字已经被行内加粗过、而元素级不是粗体时，按钮是按下态 —— 再点一次
       * 必须取消它，而不是把元素级设成粗体（那看起来像「点了没反应，反而更粗了」）。
       *
       * 而且判据是「**全部**已生效」：选了一段粗一段不粗的字，按一下是
       * 「全部加粗」，再按一下才是「全部解除」（PPT 的交互）。
       * 只看起点的话，混合选区按一下就变成「起点那段反向、其余不动」——
       * 用户看到的是「按了两次才统一」，第二次还反着来。
       */
      if (flag === 'bold') {
        const cur = currentTextUniform('fontWeight');
        if (!cur) return;
        const allBold = cur.uniform && cur.value >= 600;
        this.setTextStyle('fontWeight', allBold ? 400 : 700);
        return;
      }
      if (flag === 'italic') {
        const cur = currentTextUniform('fontStyle');
        if (!cur) return;
        const allItalic = cur.uniform && cur.value === 'italic';
        this.setTextStyle('fontStyle', allItalic ? 'normal' : 'italic');
        return;
      }
      const v = currentTextValue('textDecoration');
      if (v === null) return;
      const want = flag === 'underline' ? 'underline' : 'line-through';
      // 两种装饰共用一个 CSS 属性，所以「当前是另一种装饰」时直接换成新的，
      // 而不是先取消——用户的意图是「要这个」，不是「不要那个」。
      this.setTextStyle('textDecoration', v === want ? 'none' : want);
    },

    setTextShadow(shadow) {
      editorState.commit(tr('typo.undo.textShadow'), (doc) => {
        applyTextShadows(doc, shadow ?? []);
      });
    },

    setTextShadowLive(shadow) {
      liveWrite((doc) => applyTextShadows(doc, shadow));
    },

    setTextHighlight(color) {
      const r = textSpanRange();
      if (r) {
        editorState.commit(tr('typo.undo.highlight'), (d) => {
          const el = d.elements.find((x) => x.id === r.elId);
          if (el && el.kind === 'text') {
            // `null`（不是 undefined）= 删掉这条行内覆盖，回到元素级。
            el.runs = applySpanStyle(el.runs, r.start, r.end, { highlight: color ?? null });
          }
        });
        return;
      }
      editorState.commit(tr('typo.undo.highlight'), (doc) => {
        for (const el of onlyText(doc)) {
          const next: TextStyle = { ...el.style };
          if (color) next.highlight = color;
          else delete next.highlight;
          el.style = next;
          // 与 writeTextProp 同一件事：highlight 也是可行内覆盖的键，
          // 元素级改高亮必须清掉整段里该键的旧覆盖，否则被单独设过的那几段
          // 仍旧钉在旧颜色上（「选了文本框改高亮，部分文字没反应」）。
          el.runs = clearRunsSpanStyle(el.runs, 0, plainTextOf(el.runs).length, ['highlight']);
        }
      });
    },

    clearTextFormatting() {
      // 有行内选区时，「清除格式」的语义就是清那一段的覆盖 —— 与旧行为一致。
      if (this.hasSpanRange()) {
        this.clearSpanFormats();
        return;
      }
      editorState.commit(tr('typo.undo.clearFormat'), (doc) => {
        const base = defaultTextStyle(doc.size);
        for (const el of onlyText(doc)) {
          const next: TextStyle = {
            ...el.style,
            fontFamily: base.fontFamily,
            fontSize: base.fontSize,
            fontWeight: base.fontWeight,
            fontStyle: base.fontStyle,
            letterSpacing: base.letterSpacing,
            color: base.color,
            textDecoration: base.textDecoration,
            textTransform: base.textTransform,
          };
          delete next.highlight;
          delete next.shadow;
          el.style = next;
          // 字形填充（渐变 / 纹理）与字形描边也是「格式」，一并清掉。
          // 注意**不**清 boxFill / boxStroke：那是文本框本身的外观（Word 同款），
          // 与「清字形格式」不是一件事。
          delete el.fill;
          delete el.glyphStroke;
          // 行内覆盖整段丢掉：清格式之后不该有任何一段还留着旧样式。
          el.runs = normalizeRuns(el.runs.map((r) => ({ text: r.text })));
        }
      });
    },

    setTheme(id, scope = 'clip') {
      if (scope === 'project') {
        /*
         * 「应用到整个项目」：**一次 commit** 遍历写所有文本片段的 doc.theme，
         * 并写 `Project.typographyTheme`（新片段 / 新文档的默认）。
         *
         * 正在编辑的这份文档也在遍历里（`editorState.doc` 就是 store 里那个
         * 对象），所以一笔撤销覆盖全部 —— 分两笔的话 Ctrl+Z 只回来一半。
         */
        appState.store.commit(tr('typo.undo.themeProject'), (p) => {
          p.typographyTheme = id;
          for (const t of p.tracks) {
            for (const c of t.clips) {
              if (c.kind === 'source' && c.source.type === 'text') c.source.doc.theme = id;
            }
          }
        });
        return;
      }
      editorState.commit(tr('typo.undo.theme'), (doc) => {
        doc.theme = id;
      });
    },

    /**
     * 保存一份自定义配色方案（新建或改槽位）：**一笔撤销**。
     *
     * 自定义方案存在 `Project.customThemes`（随工程保存）。内置方案是只读的
     * 数据表 —— 「编辑内置方案」的路径是先复制成自定义方案再存（见
     * `cloneAsCustomTheme`），保存后它立即成为当前文档的方案。
     */
    saveCustomTheme(theme) {
      const clipId = editorState.clipId;
      appState.store.commit(tr('typo.undo.themeSave'), (p) => {
        const list = Array.isArray(p.customThemes) ? [...p.customThemes] : [];
        const i = list.findIndex((t) => t.id === theme.id);
        if (i >= 0) list[i] = theme;
        else list.push(theme);
        p.customThemes = list;
        // 刚保存的那个方案立即成为当前方案（用户调完看的就是它）。
        if (clipId) {
          for (const t of p.tracks) {
            for (const c of t.clips) {
              if (c.id === clipId && c.kind === 'source' && c.source.type === 'text') {
                c.source.doc.theme = theme.id;
              }
            }
          }
        }
      });
    },

    /**
     * 移除一份自定义配色方案：**一笔撤销**。
     *
     * 删 `customThemes` 的那一条之外，还要把**引用它的地方**抹干净：
     * `doc.theme` 与 `Project.typographyTheme`。不抹的话工程里会留一堆指向
     * 不存在方案的悬空 id —— 渲染照样回落默认方案（不报错），但图库/检查器
     * 显示的是「本版本没有的方案」，下次保存也照样带着它。
     *
     * 用户可能正在编辑用了它的文档：commit 之后 `doc.theme` 变 undefined，
     * 编辑器的派生（`appState.version`）会跟上，画面按默认方案重渲。
     */
    removeCustomTheme(id) {
      // 只认工程里的自定义方案：内置方案是只读数据表。UI 已经按 `removable`
      // 挡过一层，这里再挡一次 —— 传进一个内置 id 的话，下面会把工程里对它的
      // 引用（包括新片段默认方案）一起抹掉。
      const target = appState.project.customThemes?.find((t) => t.id === id);
      if (!target) return;
      const name = target.name;
      appState.store.commit(tr('typo.undo.themeRemove'), (p) => {
        const list = (p.customThemes ?? []).filter((t) => t.id !== id);
        if (list.length) p.customThemes = list;
        else delete p.customThemes;
        if (p.typographyTheme === id) delete p.typographyTheme;
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (clip.kind !== 'source' || clip.source.type !== 'text') continue;
            if (clip.source.doc.theme === id) delete clip.source.doc.theme;
          }
        }
      });
      if (name) appState.flash(tr('rib.themeRemoved', { name }), 'info');
    },

    /* ---------------------------------------------------------- 插入 */

    addText() {
      editorState.commit(tr('typo.undo.addText'), (doc) => {
        const el = createTextElement(doc.size);
        doc.elements = [...doc.elements, el];
        queueMicrotask(() => editorState.selectOnly(el.id));
      });
    },

    addShape(preset) {
      editorState.commit(tr('typo.undo.addShape'), (doc) => {
        const el = createShapeElement(doc.size, preset.id, {
          radius: preset.radius,
          sides: preset.sides,
          waist: preset.waist,
          angle: preset.angle,
        });
        doc.elements = [...doc.elements, el];
        queueMicrotask(() => editorState.selectOnly(el.id));
      });
    },

    addGeneratedShape(id) {
      const spec = generatorById(id);
      if (!spec) return;
      editorState.commit(tr('gen.undo.insert'), (doc) => {
        const params = defaultsOf(spec);
        // 预览用的就是这一次 build：选择器里的图和插进来的图必然同源。
        const r = buildFromSpec(spec, params, spec.defaultSeed);
        const strokeOnly = r.strokeOnly === true;
        const el = createShapeElement(doc.size, 'svg', {
          name: tr(spec.labelKey),
          frame: generatedFrame(doc.size, spec.aspect ?? 1),
          path: r.d,
          evenOdd: r.evenOdd ? true : undefined,
          gen: { id: spec.id, seed: spec.defaultSeed, params: { ...params } },
          /*
           * 线族只有线宽没有面积：插入即「无填充 + 描边」，否则画布上什么都看不到。
           * 描边宽度是 authored 单位，随 `scale(w/100, h/100)` 等比缩放 ——
           * 与图标（`ICON_STROKE_WIDTH`）同一口径。
           */
          fill: strokeOnly ? { kind: 'none' } : undefined,
          stroke: strokeOnly
            ? { color: DEFAULT_PAINT_A, width: GEN_STROKE_WIDTH, style: 'solid' }
            : undefined,
        });
        doc.elements = [...doc.elements, el];
        queueMicrotask(() => editorState.selectOnly(el.id));
      });
    },

    setGeneratorType(id) {
      const spec = generatorById(id);
      if (!spec) return;
      editorState.commit(tr('gen.undo.type'), (doc) => {
        const params = defaultsOf(spec);
        for (const el of onlyGen(doc)) {
          // 种子保留：换类型、同种子，便于横向比较同一套随机。
          el.gen = { id: spec.id, seed: el.gen!.seed, params: { ...params } };
          rebuildGen(el);
        }
      });
    },

    setGeneratorParam(key, value) {
      editorState.commit(tr('gen.undo.param'), (doc) => {
        applyGenParam(doc, key, value);
      });
    },

    setGeneratorParamLive(key, value) {
      editorState.beginGesture();
      editorState.live((doc) => {
        applyGenParam(doc, key, value);
      });
    },

    endGeneratorParamLive() {
      editorState.endGesture(tr('gen.undo.param'));
    },

    setGeneratorSeed(seed) {
      const next = Number.isFinite(seed) ? seed >>> 0 : 0;
      editorState.commit(tr('gen.undo.seed'), (doc) => {
        for (const el of onlyGen(doc)) {
          el.gen!.seed = next;
          rebuildGen(el);
        }
      });
    },

    reseedGenerator() {
      editorState.commit(tr('gen.undo.seed'), (doc) => {
        for (const el of onlyGen(doc)) {
          el.gen!.seed = nextSeed(el.gen!.seed);
          rebuildGen(el);
        }
      });
    },

    /**
     * 插入图标 = 插入一组「无填充 + 描边」的 `shape:'svg'` 图形。
     *
     * 为什么不是图片：图标语义正好落在 ShapeElement 的表达力里（见
     * `icon-shapes.ts`），于是描边颜色 / 线宽 / 混合模式这些既有控件插入后
     * 立刻可用，也不占素材表。元素名直接用图标名（`arrow-up` 这样）——
     * 图层面板里一眼能认出是哪个图标，比一排「形状」有用得多。
     */
    addIcons(items) {
      if (!items.length) return;
      editorState.commit(tr('typo.undo.addIcons'), (doc) => {
        const frames = iconGridFrames(doc.size, items.length);
        const els = items.map((item, i) =>
          createShapeElement(doc.size, 'svg', {
            name: item.name,
            frame: frames[i],
            path: item.path,
            fill: { kind: 'none' },
            stroke: { color: DEFAULT_PAINT_A, width: ICON_STROKE_WIDTH, style: 'solid' },
          }),
        );
        doc.elements = [...doc.elements, ...els];
        // 一次事务 = 一次撤销；插入完直接选中，接着就能拖走或改颜色。
        queueMicrotask(() => editorState.setSelection(els.map((e) => e.id)));
      });
    },

    addImage() {
      void (async () => {
        const picked = await platform.pickImageFile();
        if (!picked) return;
        await placeImageBytesImpl(picked.name, picked.data);
      })();
    },

    placeImageBytes: placeImageBytesImpl,

    placeImageAsset: placeImageAssetImpl,

    /* ---------------------------------------------------- 通用属性 */

    setBlend(value) {
      editorState.commit(tr('typo.undo.blend'), (doc) => {
        for (const el of anyElement(doc)) el.blend = value;
      });
    },

    setOpacity(value) {
      editorState.commit(tr('typo.undo.opacity'), (doc) => {
        for (const el of anyElement(doc)) el.opacity = Math.max(0, Math.min(1, value));
      });
    },

    setDepth(value) {
      editorState.commit(tr('typo.undo.depth'), (doc) => writeDepth(doc, value));
    },

    setDepthLive(value) {
      liveWrite((doc) => writeDepth(doc, value));
    },

    setCamera(patch, atSec) {
      editorState.commit(tr('typo.undo.camera'), (doc) => writeCamera(doc, patch, atSec));
    },

    setCameraLive(patch, atSec) {
      liveWrite((doc) => writeCamera(doc, patch, atSec));
    },

    resetCamera() {
      editorState.commit(tr('typo.undo.camera'), (doc) => {
        // 复位 = 回到「没有镜头」：基准值和关键帧一起删掉。只删基准值的话，
        // 有关键帧的通道会原地不动，按钮看起来就是坏的。
        delete doc.camera;
        delete doc.animations;
      });
    },

    setTransform3dEnabled(enable) {
      editorState.commit(tr(enable ? 'typo.undo.t3dOn' : 'typo.undo.t3dOff'), (doc) => {
        for (const el of anyElement(doc)) {
          // 关闭 = 删字段（缺省语义就是「没有 3D」），与抠图 / 四角的开关节律一致。
          if (enable) el.transform3d = el.transform3d ?? defaultTransform3D();
          else delete el.transform3d;
        }
      });
    },

    patchTransform3d(patch) {
      editorState.commit(tr('typo.undo.t3d'), (doc) => applyTransform3d(doc, patch));
    },

    patchTransform3dLive(patch) {
      liveWrite((doc) => applyTransform3d(doc, patch));
    },

    setShadows(list) {
      editorState.commit(tr('typo.undo.shadow'), (doc) => applyShadows(doc, list));
    },

    setShadowsLive(list) {
      liveWrite((doc) => applyShadows(doc, list));
    },

    setBlur(value) {
      editorState.commit(tr('typo.undo.blur'), (doc) => applyBlur(doc, value));
    },

    setBlurLive(value) {
      liveWrite((doc) => applyBlur(doc, value));
    },

    setImageKey(enable) {
      editorState.commit(tr(enable ? 'typo.undo.keyOn' : 'typo.undo.keyOff'), (doc) => {
        for (const el of onlyImage(doc)) {
          // 关闭 = 删字段（缺省语义就是「不抠」），与片段的键盘语义一致。
          if (enable) {
            if (!el.key) el.key = defaultKeySettings();
          } else {
            delete el.key;
          }
        }
      });
    },

    patchImageKey(patch) {
      editorState.commit(tr('typo.undo.key'), (doc) => {
        for (const el of onlyImage(doc)) {
          if (!el.key) el.key = defaultKeySettings();
          Object.assign(el.key, patch);
        }
      });
    },

    setImageQuad(enable) {
      editorState.commit(tr(enable ? 'typo.undo.quadOn' : 'typo.undo.quadOff'), (doc) => {
        for (const el of onlyImage(doc)) {
          if (enable) el.quad = el.quad ?? identityQuad();
          else delete el.quad;
        }
      });
    },

    resetImageQuad() {
      editorState.commit(tr('typo.undo.quadReset'), (doc) => {
        for (const el of onlyImage(doc)) {
          if (el.quad) el.quad = identityQuad();
        }
      });
    },

    setFrame(patch) {
      editorState.commit(tr('typo.undo.frame'), (doc) => applyFrame(doc, patch));
    },

    setFrameLive(patch) {
      liveWrite((doc) => applyFrame(doc, patch));
    },

    setOpacityLive(value) {
      const v = Math.max(0, Math.min(1, value));
      liveWrite((doc) => {
        for (const el of anyElement(doc)) el.opacity = v;
      });
    },

    endLive(label) {
      // 无变化的事务（拖出去又拖回来）由 CommandStack.endTx 自己丢弃，不留空记录。
      if (editorState.gestureActive) editorState.endGesture(label);
    },

    toggleFlag(key) {
      editorState.commit(key === 'locked' ? tr('typo.undo.lock') : tr('typo.undo.hide'), (doc) => {
        for (const el of writable(doc)) el[key] = !el[key];
      });
    },

    duplicateSelection() {
      const doc = editorState.doc;
      if (!doc) return;
      const frag = extractFragment(doc, editorState.groupAwareIds);
      if (!frag.elements.length) return;
      placeFragment(frag, 24, true, tr('typo.undo.duplicate'));
    },

    deleteSelection() {
      const ids = new Set(selectedIds());
      if (!ids.size) return;
      editorState.commit(tr('typo.undo.delete'), (doc) => {
        doc.elements = doc.elements.filter((el) => !ids.has(el.id) || el.locked);
      });
      editorState.clearSelection();
    },

    order(op) {
      // 唯一实现在 editorState（图层面板的上下移也走它），这里只做转发。
      editorState.order(op);
    },

    /* ---------------------------------------------------------- 剪贴板 */

    copySelection() {
      const doc = editorState.doc;
      if (!doc) return;
      writeClipboard(extractFragment(doc, editorState.groupAwareIds));
    },

    cutSelection() {
      const doc = editorState.doc;
      if (!doc) return;
      const frag = extractFragment(doc, editorState.groupAwareIds);
      if (!frag.elements.length) return;
      writeClipboard(frag);
      this.deleteSelection();
    },

    pasteClipboard() {
      const frag = editorState.clipboard;
      if (!frag?.elements.length) return;
      // 连续粘贴要一份比一份更靠右下，否则第二份会**完全盖住**第一份，
      // 看起来像「粘贴没反应」。剪贴板里存的始终是**未偏移**的原件，
      // 所以偏移量随次数累加，而不是在已偏移的副本上再偏移。
      placeFragment(frag, PASTE_OFFSET * editorState.pasteCount, true, tr('typo.undo.paste'));
      editorState.pasteCount += 1;
    },

    hasClipboard() {
      return (editorState.clipboard?.elements.length ?? 0) > 0;
    },

    /* ---------------------------------------------------------- 组合 */

    groupSelection() {
      const doc = editorState.doc;
      if (!doc) return;
      const ids = editorState.selectedIds;
      if (ids.length < 2) return;
      const name = tr('typo.groupName');
      editorState.commit(tr('typo.undo.group'), (d) => {
        const next = groupElements(d, ids, name);
        if (next === d) return;
        d.elements = next.elements;
        d.groups = next.groups;
      });
      // 成组后整体选中（成员 id 没变，但 selection 的语义要落到「整组」）
      queueMicrotask(() => {
        const gid = editorState.selectedGroupIds[0];
        if (gid) editorState.selectGroup(gid);
      });
    },

    ungroupSelection() {
      const doc = editorState.doc;
      if (!doc) return;
      const ids = editorState.selectedIds;
      if (!groupsInSelection(doc, ids).length) return;
      editorState.commit(tr('typo.undo.ungroup'), (d) => {
        const next = ungroupElements(d, ids);
        d.elements = next.elements;
        d.groups = next.groups;
      });
    },

    canGroup() {
      return editorState.selectedIds.length >= 2;
    },

    canUngroup() {
      const doc = editorState.doc;
      return !!doc && groupsInSelection(doc, editorState.selectedIds).length > 0;
    },

    setGroupPaint(patch) {
      const doc = editorState.doc;
      const gid = editorState.soleSelectedGroupId;
      if (!doc || !gid) return;
      editorState.commit(tr('typo.undo.groupStyle'), (d) => {
        d.groups = groupList(d).map((g) => (g.id === gid ? { ...g, fill: applyPaintPatch(g.fill, patch) } : g));
      });
    },

    setGroupStrokeColor(color) {
      const gid = editorState.soleSelectedGroupId;
      if (!gid) return;
      editorState.commit(tr('typo.undo.groupStyle'), (d) => {
        d.groups = groupList(d).map((g) =>
          g.id === gid
            ? { ...g, stroke: g.stroke ? { ...g.stroke, color } : { color, width: 2, style: 'solid' } }
            : g,
        );
      });
    },

    setGroupStrokeWidth(width) {
      const gid = editorState.soleSelectedGroupId;
      if (!gid) return;
      const w = Math.max(0, width);
      editorState.commit(tr('typo.undo.groupStyle'), (d) => {
        d.groups = groupList(d).map((g) => (g.id === gid ? { ...g, stroke: { ...(g.stroke ?? { color: '#ffffff', style: 'solid' as const }), width: w } } : g));
      });
    },

    setGroupNumber(key, value) {
      const gid = editorState.soleSelectedGroupId;
      if (!gid) return;
      const v = Math.max(0, value);
      editorState.commit(tr('typo.undo.groupStyle'), (d) => {
        d.groups = groupList(d).map((g) => (g.id === gid ? { ...g, [key]: v } : g));
      });
    },

    /* ------------------------------------------------------ 格式刷 / 动画刷 */

    togglePainter(kind, sticky) {
      const cur = editorState.painter;
      /*
       * 同一种刷子再点一次 = 收起（用户明确要求的取消方式）。
       *
       * 但**双击**不能被这两次单击的开关抵消：单击两次的节奏是
       * 「开 → 关」，紧接着的 dblclick 再把 `sticky` 置上，最终一定是「开着且
       * 连续」。所以这里不能把「同一 kind 已启用」当成错误，它只是流程中的一站。
       */
      if (cur?.kind === kind && !sticky) {
        editorState.painter = null;
        return;
      }
      /*
       * 源的取法：已经开着同一种刷子时**保留原源**（双击只改连续模式，不该把
       * 源换成刚刷过的那个 —— 虽然两者格式已相同，但那是巧合，不是语义）。
       */
      const sourceId = cur?.kind === kind ? cur.sourceId : editorState.selected[0]?.id;
      if (!sourceId) return;
      editorState.painter = { kind, sourceId, sticky };
    },

    cancelPainter() {
      editorState.painter = null;
    },

    applyPainterTo(targetId) {
      const brush = editorState.painter;
      if (!brush) return false;
      const source = editorState.elements.find((e) => e.id === brush.sourceId);
      const target = editorState.elements.find((e) => e.id === targetId);
      // 源被删掉（或点回了源自己）：没有可刷的东西，静默收起。
      if (!source || !target || source.id === target.id) {
        if (!source) editorState.painter = null;
        return false;
      }
      const isFormat = brush.kind === 'format';
      /*
       * 先拿一份副本试跑：全被跳过时（例如从纯图形刷到纯图片）不能开一笔空撤销。
       * `structuredClone` 能带上 Infinity（animations 的 iterations），JSON 不行。
       */
      const probe = structuredClone(target);
      const wouldChange = isFormat
        ? applyElementFormat(source, probe)
        : applyElementAnimations(source, probe);
      if (!wouldChange) return false;

      editorState.commit(tr(isFormat ? 'typo.undo.formatPainter' : 'typo.undo.animPainter'), (doc) => {
        const s = doc.elements.find((e) => e.id === brush.sourceId);
        const t = doc.elements.find((e) => e.id === targetId);
        if (!s || !t) return;
        if (isFormat) applyElementFormat(s, t);
        else applyElementAnimations(s, t);
      });

      // 刷完一个就选中它（看得见结果）；连续模式继续等下一下。
      editorState.selectOnly(targetId);
      if (!brush.sticky) editorState.painter = null;
      return true;
    },

    canPaint(kind) {
      if (editorState.painter?.kind === kind) return true;
      const sel = editorState.selected;
      return sel.length === 1 && !sel[0]!.locked;
    },

    /* ---------------------------------------------------------- 图形 */

    setShapeFill(color) {
      editorState.commit(tr('typo.undo.shapeFill'), (doc) => {
        for (const el of onlyShape(doc)) el.fill = { kind: 'solid', color };
      });
    },

    setShapePaint(patch) {
      editorState.commit(tr('typo.undo.shapeFill'), (doc) => {
        for (const el of onlyShape(doc)) {
          el.fill = applyPaintPatch(el.fill, patch);
          /*
           * 「换一种填充方式」= 用户不要图片填充了。不清的话路径被渲染成
           * `fill: none`，改填充色看起来完全没反应（而且没有任何报错）。
           * 只改颜色（补丁不带 `kind`）时不动它 —— 那条路下面还有描边在用。
           */
          if (patch.kind !== undefined) delete el.imageFill;
        }
      });
    },

    setShapePaintLive(patch) {
      liveWrite((doc) => {
        for (const el of onlyShape(doc)) {
          el.fill = applyPaintPatch(el.fill, patch);
          if (patch.kind !== undefined) delete el.imageFill;
        }
      });
    },

    setTextFill(patch) {
      // 起步用一份纯色：applyPaintPatch 会把颜色带到新类型，于是「第一次点
      // 渐变」不会得到一份没有颜色、画出来全透明的填充。
      editorState.commit(tr('typo.undo.shapeFill'), (doc) => {
        for (const el of onlyText(doc)) {
          el.fill = applyPaintPatch(el.fill ?? { kind: 'solid', color: DEFAULT_PAINT_A }, patch);
        }
      });
    },

    setTextFillLive(patch) {
      liveWrite((doc) => {
        for (const el of onlyText(doc)) {
          el.fill = applyPaintPatch(el.fill ?? { kind: 'solid', color: DEFAULT_PAINT_A }, patch);
        }
      });
    },

    clearTextFill() {
      editorState.commit(tr('typo.undo.shapeFill'), (doc) => {
        for (const el of onlyText(doc)) el.fill = undefined;
      });
    },

    setTextBoxFill(patch) {
      // 与 setTextFill 同款：起步给一份纯色，applyPaintPatch 会把颜色带进新类型。
      editorState.commit(tr('typo.undo.shapeFill'), (doc) => {
        for (const el of onlyText(doc)) {
          el.boxFill = applyPaintPatch(el.boxFill ?? { kind: 'solid', color: DEFAULT_PAINT_A }, patch);
        }
      });
    },

    setTextBoxFillLive(patch) {
      liveWrite((doc) => {
        for (const el of onlyText(doc)) {
          el.boxFill = applyPaintPatch(el.boxFill ?? { kind: 'solid', color: DEFAULT_PAINT_A }, patch);
        }
      });
    },

    setTextBoxStroke(patch) {
      editorState.commit(tr('typo.undo.shapeStroke'), (doc) => applyTextBoxStroke(doc, patch));
    },

    setTextBoxStrokeLive(patch) {
      liveWrite((doc) => applyTextBoxStroke(doc, patch));
    },

    patchStrokePaint(target, patch) {
      // 两处描边的标签不同：图形说「描边」，文本框说「边框」——
      // 撤销记录里能区分是哪一处，回退时才对得上用户刚才的动作。
      const label = target === 'shape' ? 'typo.undo.strokePaint' : 'typo.undo.borderPaint';
      editorState.commit(tr(label), (doc) => applyStrokePaint(doc, target, patch));
    },

    patchStrokePaintLive(target, patch) {
      liveWrite((doc) => applyStrokePaint(doc, target, patch));
    },

    setGlyphStroke(patch) {
      editorState.commit(tr('typo.undo.glyphStroke'), (doc) => applyGlyphStroke(doc, patch));
    },

    setGlyphStrokeLive(patch) {
      liveWrite((doc) => applyGlyphStroke(doc, patch));
    },

    setShapeStroke(color) {
      editorState.commit(tr('typo.undo.shapeStroke'), (doc) => {
        for (const el of onlyShape(doc)) {
          el.stroke = el.stroke ? { ...el.stroke, color } : { color, width: 4, style: 'solid' };
        }
      });
    },

    setShapeStrokeWidth(width) {
      editorState.commit(tr('typo.undo.strokeWidth'), (doc) => applyShapeStrokeWidth(doc, width));
    },

    setShapeStrokeWidthLive(width) {
      liveWrite((doc) => applyShapeStrokeWidth(doc, width));
    },

    setShapeStrokeStyle(style) {
      editorState.commit(tr('typo.undo.strokeStyle'), (doc) => {
        for (const el of onlyShape(doc)) {
          el.stroke = el.stroke ? { ...el.stroke, style } : { color: '#ffffff', width: 4, style };
        }
      });
    },

    setShapeRadius(radius) {
      editorState.commit(tr('typo.undo.radius'), (doc) => {
        for (const el of onlyShape(doc)) el.radius = Math.max(0, radius);
      });
    },

    setShapeParam(key, value) {
      editorState.commit(tr('typo.undo.shapeParam'), (doc) => {
        for (const el of onlyShape(doc)) el[key] = value;
      });
    },

    /* ---------------------------------------------------- 顶点 / 控制点编辑 */

    toggleNodeEdit() {
      const el = editorState.selected[0];
      if (!el || el.kind !== 'shape') return;
      if (editorState.nodeEditId === el.id) {
        editorState.nodeEditId = null;
        return;
      }
      /*
       * 参数化图形还没有「顶点」可编辑 —— 它的形状由公式给出。这里顺手转成
       * 路径，与进入编辑**合成一笔撤销**：按一次 Ctrl+Z 应当回到「还是参数化
       * 图形、也没在编辑」，而不是先退回一个「已经是路径但已退出编辑」的
       * 中间态（那对用户毫无意义）。
       *
       * 生成器图形同理：路径已经是烘焙好的，只需**清掉 gen**（脱离生成器）。
       * 否则用户手改的节点会被下一次参数改动覆盖 —— 而且没有任何提示。
       */
      if (el.shape !== 'svg' || el.gen) {
        editorState.commit(tr('typo.undo.toPath'), (doc) => {
          const target = doc.elements.find((e) => e.id === el.id);
          if (!target || target.kind !== 'shape') return;
          if (target.gen) target.gen = undefined;
          else convertShapeToPath(target);
        });
      }
      editorState.nodeEditId = el.id;
    },

    convertToPath() {
      editorState.commit(tr('typo.undo.toPath'), (doc) => {
        for (const el of onlyShape(doc)) {
          // 生成器元素：path 已是烘焙结果，脱离 = 丢掉 gen。
          if (el.gen) el.gen = undefined;
          else convertShapeToPath(el);
        }
      });
    },

    convertTextToPath() {
      /*
       * **先收尾文本编辑，再取文档**：`stopEditing()` 会触发 focusout → 提交
       * 正在编辑的内容（那是另一笔 commit）。先拿元素引用的话可能拿到提交前
       * 的那一版 —— 转出来的是「少打了最后一个字」的形状。
       */
      editorState.stopEditing();
      const doc = editorState.doc;
      if (!doc) return;
      const targets = onlyText(doc);
      if (!targets.length) return;

      /*
       * **快照**：轮廓计算要等字体 wasm / 字节（可能上百毫秒），期间用户还能
       * 继续改文档。拿快照算、落库前再核对一次内容没变 —— 用当前对象边算边改
       * 的话，用户刚打的字会被一个「上一版的形状」盖掉。
       */
      const jobs = targets.map((el) => ({ source: structuredClone(el) }));
      const theme = doc.theme;
      const customThemes = appState.project.customThemes;

      /*
       * 用到本机字体时先打一声招呼：**第一次** `queryLocalFonts()` 要枚举整机
       * 字体（实测 Windows 上 3 秒），之后 Chrome 自己缓存到 1ms。没有这句的
       * 话，用户点完按钮会愣三秒以为卡死了。只在「族不在注册表里、环境又支持
       * 本机字体」时才说，正常情况下不该多一条噪声。
       */
      const needsLocalFonts = targets.some((el) =>
        el.runs.some(
          (run) => !appState.fonts.has(firstFamily(run.style?.fontFamily ?? el.style.fontFamily)),
        ),
      );
      if (needsLocalFonts && localFontSource()) {
        appState.flash(tr('typo.textToPathReadingLocalFonts'), 'info');
      }

      void (async () => {
        const prepared: { source: TextElement; items: TextOutlineItem[]; shadows: ElementShadow[] }[] = [];
        try {
          for (const job of jobs) {
            const r = await outlineTextElement(job.source, {
              fonts: appState.fonts,
              theme,
              customThemes,
            });
            if (!r.ok) {
              appState.flash(textOutlineFailureText(r), 'error');
              return;
            }
            prepared.push({ source: job.source, items: r.items, shadows: r.shadows });
          }
        } catch (err) {
          console.warn('[typo] text-to-path failed', err);
          appState.flash(tr('typo.textToPathFailed'), 'error');
          return;
        }

        // 等了一会儿之后文档可能已经变了：逐个体检，任何一个对不上就整批放弃。
        const now = editorState.doc;
        if (!now) return;
        for (const job of prepared) {
          const el = now.elements.find((e) => e.id === job.source.id);
          // 整元素比对：改字号 / 字体 / 颜色 / 框大小同样会让快照过期。
          if (!el || el.kind !== 'text' || JSON.stringify(el) !== JSON.stringify(job.source)) {
            appState.flash(tr('typo.textToPathChanged'), 'error');
            return;
          }
        }

        const freshIds: string[] = [];
        editorState.commit(tr('typo.undo.textToPath'), (d) => {
          for (const job of prepared) {
            const idx = d.elements.findIndex((e) => e.id === job.source.id);
            if (idx < 0) continue;
            const src = d.elements[idx]!;
            if (src.kind !== 'text') continue;
            const shapes = buildTextOutlineShapes(job.source, job.items, job.shadows);
            d.elements.splice(idx, 1, ...shapes);
            freshIds.push(...shapes.map((s) => s.id));
            /*
             * 按颜色拆成多个图形时包成一个组合：拖动 / 选择仍是一件事。
             * 源元素本来就在组里就不另建 —— 组合是扁平的，不能套娃。
             */
            if (shapes.length > 1 && !src.groupId) {
              const gid = newId();
              for (const s of shapes) s.groupId = gid;
              d.groups = [
                ...(d.groups ?? []),
                // padding 0：原文本没有「外扩一圈」的语义，默认的 8 会让选择框变大。
                { id: gid, name: src.name, fill: { kind: 'none' }, stroke: null, radius: 0, padding: 0 },
              ];
            }
          }
        });

        if (freshIds.length) queueMicrotask(() => editorState.setSelection(freshIds));
        else appState.flash(tr('typo.textToPathEmpty'), 'error');
      })();
    },

    addPathNode(hit) {
      editorState.commit(tr('typo.undo.addNode'), (doc) => {
        const el = nodeEditShape(doc);
        if (!el) return;
        const subs = parsePathNodes(el.path ?? '');
        const sp = subs[hit.sub];
        if (!sp) return;
        subs[hit.sub] = insertNodeOnSegment(sp, hit.seg, hit.t);
        el.path = serializePathNodes(subs);
      });
    },

    deletePathNode(index) {
      editorState.commit(tr('typo.undo.deleteNode'), (doc) => {
        const el = nodeEditShape(doc);
        if (!el) return;
        const subs = parsePathNodes(el.path ?? '');
        const sp = subs[0];
        if (!sp) return;
        const next = removeNode(sp, index);
        // 少于下限时 `removeNode` 原样返回 —— 那是「拒绝删除」，不该留一条空撤销。
        if (next === sp) return;
        subs[0] = next;
        el.path = serializePathNodes(subs);
      });
    },

    /* ---------------------------------------------------- 布尔运算 */

    canBoolean() {
      return editorState.selected.filter((e) => e.kind === 'shape' && !e.locked).length >= 2;
    },

    booleanShapes(op) {
      const doc = editorState.doc;
      if (!doc) return;
      // 只取图形，按 **z 序**（底 → 顶）参与运算；差集依赖顺序，最底下的是被减数。
      const ids = editorState.selected.filter((e) => e.kind === 'shape' && !e.locked).map((e) => e.id);
      if (ids.length < 2) return;

      const out: { id: string | null } = { id: null };
      editorState.commit(tr('typo.undo.boolean'), (d) => {
        // 交集为空 / 被减没了：改成一个空图形没有意义，干脆不动，让用户看到提示。
        out.id = applyBoolean(d, ids, op);
      });

      if (!out.id) {
        appState.flash(tr('typo.booleanEmpty'), 'error');
        return;
      }
      const freshId = out.id;
      queueMicrotask(() => editorState.setSelection([freshId]));
    },

    divideShapes() {
      const doc = editorState.doc;
      if (!doc) return;
      /* 与布尔运算同一条选择口径：只取未锁定的图形，按 z 序（底 → 顶）传入。 */
      const ids = editorState.selected.filter((e) => e.kind === 'shape' && !e.locked).map((e) => e.id);
      if (ids.length < 2) return;

      const out = { ids: [] as string[] };
      editorState.commit(tr('typo.undo.divide'), (d) => {
        out.ids = applyDivide(d, ids);
      });

      if (!out.ids.length) {
        appState.flash(tr('typo.booleanEmpty'), 'error');
        return;
      }
      // 全部选中：用户可以立刻整体拖动，也可以点其中一片单独改色 / 移动。
      const freshIds = out.ids;
      queueMicrotask(() => editorState.setSelection(freshIds));
    },

    /* ---------------------------------------------------------- 图片 */

    setImageFit(value) {
      editorState.commit(tr('typo.undo.imageFit'), (doc) => {
        for (const el of onlyImage(doc)) el.fit = value;
      });
    },

    setImageRadius(value) {
      editorState.commit(tr('typo.undo.imageRadius'), (doc) => {
        const v = Math.max(0, value);
        for (const el of onlyImage(doc)) {
          // 0 = 直角：删字段（缺省语义就是没有圆角），别留一个 0 让文件变脏。
          if (v > 0) el.radius = v;
          else delete el.radius;
        }
      });
    },

    patchImageAdjust(patch) {
      editorState.commit(tr('typo.undo.imgAdjust'), (doc) => {
        for (const el of onlyImage(doc)) writeImageAdjust(el, patch);
      });
    },

    patchImageAdjustLive(patch) {
      liveWrite((doc) => {
        for (const el of onlyImage(doc)) writeImageAdjust(el, patch);
      });
    },

    setImageCurve(channel, points) {
      editorState.commit(tr('typo.undo.imgCurve'), (doc) => applyImageCurve(doc, channel, points));
    },

    setImageCurveLive(channel, points) {
      liveWrite((doc) => applyImageCurve(doc, channel, points));
    },

    setImageFilter(filter) {
      editorState.commit(tr('typo.undo.imgFilter'), (doc) => applyImageFilter(doc, filter));
    },

    setImageFilterLive(filter) {
      liveWrite((doc) => applyImageFilter(doc, filter));
    },

    patchImageRecolor(patch) {
      editorState.commit(tr('typo.undo.imgRecolor'), (doc) => applyImageRecolor(doc, patch));
    },

    patchImageRecolorLive(patch) {
      liveWrite((doc) => applyImageRecolor(doc, patch));
    },

    patchImageBorder(patch) {
      editorState.commit(tr('typo.undo.imgBorder'), (doc) => {
        for (const el of onlyImage(doc)) {
          const next = coerceImageBorder(patch, el.border);
          if (!next) continue;
          // 宽度 0 = 用户点了「无边框」：删字段而不是留一个「看不见的边框」。
          if (next.width <= 0) delete el.border;
          else el.border = next;
        }
      });
    },

    setImageCropAspect(ratio) {
      editorState.commit(tr('typo.undo.imgCrop'), (doc) => {
        for (const el of onlyImage(doc)) {
          if (ratio === null) {
            delete el.crop;
            continue;
          }
          const nat = imageSourceFor(el.assetId);
          if (!nat) continue;
          const rect = cropForAspect({ w: nat.w, h: nat.h }, ratio);
          if (!rect) continue;
          el.crop = rect;
          /*
           * `contain` / `none` 下裁出来的窗口会留边（窗口不是元素框的比例），
           * 用户会以为「裁剪没生效」。提到 `cover` 之后窗口正好铺满。
           */
          if (el.fit === 'contain' || el.fit === 'none') el.fit = 'cover';
        }
      });
    },

    setImageCrop(rect) {
      editorState.commit(tr('typo.undo.imgCrop'), (doc) => {
        for (const el of onlyImage(doc)) {
          if (!rect) {
            delete el.crop;
            continue;
          }
          el.crop = {
            x: clamp01(rect.x),
            y: clamp01(rect.y),
            w: Math.max(0.02, Math.min(1, rect.w)),
            h: Math.max(0.02, Math.min(1, rect.h)),
          };
        }
      });
    },

    alignImagesToCanvas(mode) {
      editorState.commit(tr('typo.undo.imgAlign'), (doc) => {
        for (const el of onlyImage(doc)) {
          const next = frameForAlign(el.frame, doc.size, mode);
          el.frame = {
            x: r2(next.x ?? el.frame.x),
            y: r2(next.y ?? el.frame.y),
            w: Math.max(1, r2(next.w ?? el.frame.w)),
            h: Math.max(1, r2(next.h ?? el.frame.h)),
            rot: el.frame.rot,
          };
          // `stretch` 要配 `fill` 才是「拉伸铺满」；其余两种配对应的等比语义。
          if (mode === 'stretch') el.fit = 'fill';
          else if (mode === 'fit' && el.fit === 'fill') el.fit = 'contain';
          else if (mode === 'fill' && el.fit !== 'cover') el.fit = 'cover';
        }
      });
    },

    resizeImages(next, lockAspect) {
      editorState.commit(tr('typo.undo.imgResize'), (doc) => {
        for (const el of onlyImage(doc)) {
          const p = resizeFrameCentered(el.frame, next, lockAspect);
          el.frame = {
            x: r2(p.x ?? el.frame.x),
            y: r2(p.y ?? el.frame.y),
            w: Math.max(1, r2(p.w ?? el.frame.w)),
            h: Math.max(1, r2(p.h ?? el.frame.h)),
            rot: el.frame.rot,
          };
        }
      });
    },

    clipImagesToShape(presetKey) {
      const preset = SHAPE_PRESETS.find((p) => p.key === presetKey);
      // 直线没有面积，拿来当裁剪框等于把图片删掉。
      if (!preset || preset.id === 'line') return;
      editorState.commit(tr('typo.undo.clipShape'), (doc) => {
        const ids = selectedIds();
        doc.elements = doc.elements.map((el) => {
          if (el.kind !== 'image' || !ids.has(el.id) || el.locked) return el;
          /*
           * **沿用同一个 id**：动画的 `data-anim-id`、组归属、当前选中全部靠它，
           * 换 id 就等于「裁成形状之后动画没了、选择也丢了」。
           * `docSignature` 带 kind，所以舞台会按新类型重建节点（那条路是必须的）。
           */
          const shape = createShapeElement(doc.size, preset.id, {
            id: el.id,
            name: el.name,
            frame: { ...el.frame },
            blend: el.blend,
            opacity: el.opacity,
            visible: el.visible,
            locked: el.locked,
            animations: el.animations,
            transform3d: el.transform3d,
            shadows: el.shadows,
            blur: el.blur,
            radius: preset.radius,
            sides: preset.sides,
            waist: preset.waist,
            angle: preset.angle,
            fill: { kind: 'none' },
            stroke: null,
          });
          if (el.groupId) shape.groupId = el.groupId;
          // 图片填满形状（`cover`）：裁成形状之后再留边就只是「一个框」。
          shape.imageFill = { assetId: el.assetId, fit: 'cover' };
          return shape;
        });
      });
    },

    setShapeImageFill(fill) {
      editorState.commit(tr('typo.undo.shapeImageFill'), (doc) => {
        for (const el of writable(doc)) {
          if (el.kind !== 'shape') continue;
          if (fill) {
            el.imageFill = { ...fill };
            continue;
          }
          delete el.imageFill;
          /*
           * 「裁剪为形状」把填充设成了 `none`（否则不透明填充会盖住图）。移掉
           * 图片填充之后如果不补一块色，图形会直接消失 —— 用户点的是「移除图片
           * 填充」，不是「删掉这个图形」。
           */
          if (el.fill.kind === 'none') el.fill = { kind: 'solid', color: DEFAULT_PAINT_A };
        }
      });
    },

    /* ---------------------------------------------------------- 对齐 */

    align(axis) {
      const rects = toRects(editorState.selected.filter((e) => !e.locked));
      if (!rects.length) return;

      if (axis === 'distribute-h' || axis === 'distribute-v') {
        const axisShort = axis === 'distribute-h' ? 'h' : 'v';
        const map = distribute(rects, axisShort);
        if (!map.size) return;
        editorState.commit(tr('typo.undo.distribute'), (doc) => {
          for (const el of anyElement(doc)) {
            const v = map.get(el.id);
            if (v === undefined) continue;
            if (axisShort === 'h') el.frame.x = r2(v);
            else el.frame.y = r2(v);
          }
        });
        return;
      }

      const map = alignElements(rects, targetRect(), axis);
      editorState.commit(tr('typo.undo.align'), (doc) => {
        for (const el of anyElement(doc)) {
          const p = map.get(el.id);
          if (!p) continue;
          el.frame.x = r2(p.x);
          el.frame.y = r2(p.y);
        }
      });
    },

    setAlignTarget(target) {
      appState.typoAlignTarget = target;
    },

    /* ---------------------------------------------------------- 动画 */

    applyPreset(preset) {
      /*
       * **在播放头处增量插入**（用户 2026-10-25 定）：点预设不再替换同属性轨道，
       * 而是往那条轨道里接一段关键帧 —— 播放头之前的编排一帧不动。
       * 合并规则（含「插入点之后整体右移」与衔接处的保持）在
       * `typography/animation-insert.ts`，纯函数 + 单测。
       *
       * 插入点用**片段内相对秒**（与关键帧同口径）；插到片段末尾之外没有意义，
       * 所以夹一下让整段动画落在片段里 —— 播放头在 3.9s、片段 4s、动画 0.6s 时
       * 落在 3.4s，而不是「插进去了但看不见」。
       */
      const clip = editorState.clip;
      const span = ANIM_PRESETS.find((p) => p.id === preset)?.duration ?? 0.6;
      const playAt = clip ? appState.playT - clip.start : 0;
      const limit = clip ? Math.max(0, clip.end - clip.start - span) : playAt;
      const at = Math.max(0, Math.min(playAt, limit));

      let trackIds: string[] = [];
      editorState.commit(tr('typo.undo.addAnim'), (doc) => {
        for (const el of anyElement(doc)) {
          const incoming = presetToTracks(createPresetAnimation(preset, newId()), {
            dropAnimations: [],
            dropProps: [],
          });
          const res = insertAnimationsAt(el.animations, incoming, at);
          el.animations = res.animations;
          // 面板显示的是「列表里第一个元素」，第一个写到的元素就够了。
          if (!trackIds.length) trackIds = res.trackIds;
        }
      });
      if (trackIds.length) kfPanel.selectTrack(trackIds[0]!);
      appState.flash(
        tr('typo.animInserted', { name: presetLabel(preset), at: at.toFixed(2) }),
        'success',
      );
    },

    clearAnimations() {
      editorState.commit(tr('typo.undo.clearAnim'), (doc) => {
        for (const el of anyElement(doc)) el.animations = [];
      });
    },

    applyCustomCss(css) {
      // 解析（含清洗）放在写库之前：非法代码绝不能进文档 —— 一旦进了，光栅化时
      // animationStyleSheet 会跳过它，但用户已经以为「保存成功」了。
      // 支持旧单 body 与「多个 @keyframes 块 + 逗号分隔 animation 简写」两种形态。
      const parsed = parseCustomCss(css);
      if (!parsed.ok) return false;
      const target = kfPanel.animId;
      editorState.commit(tr('typo.undo.customAnim'), (doc) => {
        for (const el of anyElement(doc)) {
          const at = target ? el.animations.findIndex((a) => a.id === target) : -1;
          const prev = at >= 0 ? el.animations[at] : el.animations[0];
          // 继承上一段动画的时序，否则用户手写一段 keyframes 之后时长会跳回
          // 默认的 0.6s，「只是改了下缓动」变成了「动画变快了」。
          // （多动画简写自带每条时序，这里的字段只服务于旧单 body 形态。）
          const over: Partial<AnimTiming> & { animation?: string } = prev
            ? {
                delay: prev.delay,
                duration: prev.duration,
                iterations: prev.iterations,
                easing: prev.easing,
                direction: prev.direction,
                fill: prev.fill,
              }
            : {};
          if (parsed.animation) over.animation = parsed.animation;
          const custom = createCustomAnimation(newId(), parsed.css, over);
          // 命中选中的轨道就替换它，否则**追加**一条（手写 CSS 是逃生舱，
          // 不该顺手清掉用户已经排好的其它属性轨道）。
          el.animations =
            at >= 0 ? el.animations.map((a, i) => (i === at ? custom : a)) : [...el.animations, custom];
        }
      });
      return true;
    },

    /* ------------------------------------------------ 关键帧（结构化轨道） */

    addTrack(prop, initial, atSec, target: AnimTarget = 'box') {
      const at = Math.max(0, atSec ?? 0);
      const want = target === 'content' ? 'content' : 'box';
      editorState.commit(tr('typo.undo.addAnimTrack'), (doc) => {
        for (const el of anyElement(doc)) {
          /*
           * 同一 **(属性, 作用层)** 只允许一条轨道（见 applyPreset 的注释）。
           * 两层各一条是合法的：它们落在不同 DOM 节点上，不会互相覆盖；
           * 同一层里同属性才会（`transform` 只有最后一条生效）。
           */
          if (
            el.animations.some(
              (a) => a.kind === 'tracks' && a.prop === prop && animTargetOf(a) === want,
            )
          ) {
            continue;
          }
          const v = initial ?? identityValue(prop);
          /*
           * 起手两根**零变化**的帧：一是给用户一根可抓的时长（单帧轨道只有 1ms，
           * 拖起来像没反应），二是值相同 ⇒ 画面不变，不会「加个属性就把元素挪走」。
           */
          el.animations = [
            ...el.animations,
            createTracksAnimation(
              newId(),
              prop,
              [
                { t: at, v },
                { t: at + DEFAULT_TRACK_SEC, v },
              ],
              // 新轨道**显式**写作用层：缺省虽然是 box，但写出来才能在读回 /
              // 复制 / 迁移时一眼看出它落在哪一层（与旧数据区分开）。
              { target: want },
            ),
          ];
        }
      });
    },

    removeTrack(animId) {
      editorState.commit(tr('typo.undo.removeAnimTrack'), (doc) => {
        for (const el of anyElement(doc)) {
          el.animations = el.animations.filter((a) => a.id !== animId);
        }
        // 镜头轨道也在这一条路径上（面板的垃圾桶对两者是同一个按钮）。
        const own = (doc.animations ?? []).filter((a) => a.id !== animId);
        if (own.length) doc.animations = own;
        else delete doc.animations;
      });
    },

    setTrackTarget(animId, target) {
      const want: AnimTarget = target === 'content' ? 'content' : 'box';
      editorState.commit(tr('typo.undo.trackTarget'), (doc) => {
        // 旧形态（preset / custom）也认 id：换层对它们同样有效，不必先迁移。
        for (const el of anyElement(doc)) {
          const a = el.animations.find((x) => x.id === animId);
          if (!a) continue;
          /*
           * 同一层里同属性只能有一条（同层会互相覆盖）。换过去时把目标层那条
           * **替换**掉 —— 与 `applyPreset` / `addTrack` 的判重同一条口径。
           */
          if (a.kind === 'tracks') {
            const prop = a.prop;
            el.animations = el.animations.filter(
              (x) =>
                !(
                  x.id !== animId &&
                  x.kind === 'tracks' &&
                  x.prop === prop &&
                  animTargetOf(x) === want
                ),
            );
          }
          const moved = el.animations.find((x) => x.id === animId);
          if (moved) moved.target = want;
        }
      });
    },

    setTrackLoop(animId, loop) {
      editorState.commit(tr('typo.undo.trackLoop'), (doc) => {
        eachTrack(doc, animId, (a) => {
          a.iterations = loop ? Infinity : 1;
        });
      });
    },

    addKey(animId, t, v) {
      const at = Math.max(0, t);
      const camKey = cameraKeyOfRowId(animId);
      editorState.commit(tr('typo.undo.addKey'), (doc) => {
        /*
         * 面板上四条镜头属性常驻显示，但没打过帧的通道**不落库**（否则每开一次
         * 面板就往工程里塞四条空轨道）。所以虚拟行 `cam:<通道>` 在这里物化，
         * 初值取**当前取景**而不是 0 —— zoom 的 0 会被夹成 0.05，一加帧画面就跳。
         */
        if (camKey) {
          upsertCameraKey(doc, camKey, at, Number(v ?? cameraChannelValueAt(doc, camKey, at)));
          return;
        }
        eachTrack(doc, animId, (a) => {
          const cam = cameraKeyOf(a.prop);
          // 镜头轨道按**缓动后**的值起手（`sampleKeys` 只做线性，屏幕上看到的是缓动后的）。
          const def = v ?? (cam ? cameraChannelValueAt(doc, cam, at) : sampleKeys(a.keys, at));
          a.keys = [...a.keys, { t: at, v: def }];
          applyTrackTiming(a);
        });
      });
    },

    setKeyValue(animId, t, v) {
      editorState.commit(tr('typo.undo.keyValue'), (doc) => {
        eachTrack(doc, animId, (a) => {
          const k = a.keys.find((x) => Math.abs(x.t - t) < 1e-6);
          if (k) k.v = v;
        });
      });
    },

    setKeyTime(animId, t, nextT) {
      const at = Math.max(0, nextT);
      editorState.commit(tr('typo.undo.keyMove'), (doc) => {
        eachTrack(doc, animId, (a) => {
          const k = a.keys.find((x) => Math.abs(x.t - t) < 1e-6);
          if (!k) return;
          k.t = at;
          applyTrackTiming(a);
        });
      });
    },

    setKeyEase(animId, t, ease) {
      editorState.commit(tr('typo.undo.keyEase'), (doc) => {
        eachTrack(doc, animId, (a) => {
          const k = a.keys.find((x) => Math.abs(x.t - t) < 1e-6);
          if (k) k.ease = ease;
        });
      });
    },

    liveKeyEase(animId, t, ease) {
      editorState.live((doc) => {
        eachTrack(doc, animId, (a) => {
          const k = a.keys.find((x) => Math.abs(x.t - t) < 1e-6);
          if (k) k.ease = ease;
        });
      });
    },

    setKeysColor(keys, color) {
      if (!keys.length) return;
      // 非法色当成「去掉标记」：宁可没有颜色，也不要写一个会让界面上出现怪颜色的值。
      const hex = normalizeKeyColor(color);
      const want = new Set(keys.map((k) => `${k.animId}@${k.t.toFixed(6)}`));
      editorState.commit(tr('typo.undo.keyColor'), (doc) => {
        // 遍历全部元素而不是选择集：面板里可以操作**没在舞台上选中**的元素
        // （元素列列出一切有动画的元素）。镜头轨道同理（文档级，不在任何元素上）。
        const all: TracksAnimation[] = [...(doc.animations ?? [])];
        for (const el of doc.elements) {
          for (const a of el.animations) if (a.kind === 'tracks') all.push(a);
        }
        for (const a of all) {
          for (const k of a.keys) {
            if (!want.has(`${a.id}@${k.t.toFixed(6)}`)) continue;
            if (hex) k.color = hex;
            else delete k.color;
          }
        }
      });
    },

    moveKey(animId, t, nextT) {
      // 拖动中每帧都走 live（不拍快照）：一帧一条撤销记录的形态是「拖完要按 60 次撤销」。
      editorState.live((doc) => {
        eachTrack(doc, animId, (a) => {
          const k = a.keys.find((x) => Math.abs(x.t - t) < 1e-6);
          if (!k) return;
          k.t = Math.max(0, nextT);
          applyTrackTiming(a);
        });
      });
    },

    removeKey(animId, t) {
      editorState.commit(tr('typo.undo.removeKey'), (doc) => {
        eachTrack(doc, animId, (a) => {
          a.keys = a.keys.filter((x) => Math.abs(x.t - t) > 1e-6);
          applyTrackTiming(a);
        });
      });
    },

    loadLocalFonts() {
      // 异步但不 await：提示在 `appState.loadLocalFonts` 里发。
      void appState.loadLocalFonts();
    },

    importFont() {
      void (async () => {
        const picked = await platform.pickFontFiles();
        if (!picked?.length) return;
        let ok = 0;
        for (const f of picked) {
          try {
            await appState.fonts.registerFile(f.name, f.data);
            ok += 1;
          } catch (err) {
            console.warn(`[typo] 字体 ${f.name} 导入失败`, err);
          }
        }
        appState.refreshFontFamilies();
        appState.flash(
          ok === picked.length
            ? tr('typo.fontsImported', { ok })
            : tr('typo.fontsImportedPartial', { ok, total: picked.length }),
        );
      })();
    },

    flattenToImage(localSec) {
      const clipId = editorState.clipId;
      const doc = editorState.doc;
      if (!clipId || !doc) return;
      void (async () => {
        const canvas = await appState.textRaster.rasterizeOnce(doc, doc.size.w, doc.size.h, localSec);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
        if (!blob) {
          appState.flash(tr('typo.bakeFailed'), 'error');
          return;
        }
        const assetId = newId();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        putImageBytes(assetId, bytes.buffer, 'image/png');
        appState.assets.put(assetId, bytes, {
          kind: 'image',
          name: tr('typo.bakedName'),
          originName: 'flatten.png',
        });
        /*
         * 「换源」与「登记素材」必须合成**一笔**撤销。
         *
         * 拆成两笔时栈顶是登记：第一下 Ctrl+Z 只把 `p.assets[assetId]` 撤掉，
         * 而片段已经指向它 —— 画面当场变成离线占位符，用户看到的是「撤销
         * 之后图没了」。`beginTx` 只在没有外层事务时打开（它会覆盖快照，
         * 见 `core/project-store.ts::inTx` 的注释）。
         */
        const wrap = !appState.store.inTx;
        if (wrap) appState.store.beginTx();
        try {
          appState.store.commit(tr('typo.undo.registerImageAsset'), (p) => {
            p.assets[assetId] = { id: assetId, kind: 'image', name: tr('typo.bakedName') };
          });
          appState.store.updateClip(clipId, tr('typo.undo.flatten'), (clip) => {
            if (clip.kind === 'source' && clip.source.type === 'text') {
              clip.source = { type: 'image', assetId };
            }
          });
        } finally {
          if (wrap) appState.store.endTx(tr('typo.undo.flatten'));
        }
        // 源已经不是 text 了，编辑页必须关掉 —— 留着会指向一个不存在的文档。
        appState.closeTypographyView();
      })();
    },
  };
}
