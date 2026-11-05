/**
 * agent-ops.ts — 排版文档的 **agent 写入原语**（不碰 DOM、不碰 store）。
 *
 * 与 `ui/typography/actions.ts` 的分工：
 *
 * | | actions.ts | 本文件 |
 * |---|---|---|
 * | 输入 | 当前选择集 + Ribbon 控件 | 明确的元素 id / 完整参数 |
 * | 依赖 | `editorState`（ui 层单例）、`appState.store` | 只有 `document.ts` / `geometry.ts` |
 * | 谁用 | 排版编辑器 | `src/agent/typography.ts`（控制平面） |
 *
 * 两者共用**同一批工厂与几何函数**（`createTextElement` / `applyPaintPatch` /
 * `alignElements` …），所以「agent 做出来的排版」与「手点出来的排版」在数据层
 * 完全同构 —— 后者能编辑前者，导出也走同一条光栅化路径。
 *
 * ## 为什么这些函数是「就地修改」
 *
 * 调用点只有一个：`store.commit(label, p => { const doc = findTextDoc(p, id); applyX(doc, …) })`。
 * 在 `commit` 里换成返回新文档的写法，就得把 `p.tracks[...].clips[...].source.doc`
 * 整条引用链重挂一遍 —— 那正是 `ProjectStore` 与编辑器都刻意避开的事（见
 * `document.ts::elementById` 的注释：给副本会踩「改了浅拷贝 → 判定无变化」）。
 *
 * 所以：**校验全部前置，修改全部就地，失败抛在改动之前**。
 */

import { newId, type Project } from '../core/schema';
import { coerceKeySettings, coerceQuadCorners } from '../core/image-fx';
import {
  SHAPE_KINDS,
  applyPaintPatch,
  cameraIsIdentity,
  coerceCamera,
  coerceTransform3D,
  coerceTransform3DPatch,
  createImageElement,
  createShapeElement,
  createTextElement,
  defaultTextStyle,
  elementById,
  mergeTransform3D,
  reorderElements,
  resizeDocument,
  type ImageElement,
  type Paint,
  type ShapeElement,
  type ShapeKind,
  type ShapePaintPatch,
  type Stroke,
  type TextElement,
  type TextStyle,
  type TextureFrame,
  type TypographyDocument,
  type TypographyElement,
  type TypographyGroup,
} from './document';
import { coerceRuns, hasSpanOverrides, plainTextOf, runsFromText } from './rich-text';
import {
  coerceImageAdjust,
  coerceImageBorder,
  coerceImageFilter,
  coerceImageRecolor,
} from './image-effects';
import { sanitizeScripts, type TypographyScript } from './script/model';
import {
  ANIM_PRESETS,
  animTargetOf,
  createCustomAnimation,
  createPresetAnimation,
  createTracksAnimation,
  isPresetId,
  parseCustomCss,
  type AnimTiming,
  type CustomCssError,
  type Easing,
  type ElementAnimation,
  type TrackKey,
} from './animation';
import {
  identityValue,
  normalizeKeyColor,
  normalizeKeys,
  type AnimChannel,
  type StepEase,
  type TrackEase,
  type TracksAnimation,
} from './animation-tracks';
import {
  CAMERA_CHANNELS,
  cameraChannelOf,
  cameraKeyOf,
  cameraKeysMap,
  createCameraTrack,
  isCameraChannel,
  type CameraKey,
} from './camera-tracks';
import { presetToTracks, type MigrationReport } from './animation-migrate';
import { boundsOf, distribute, alignElements, toRects, type AlignAxis, type Rect } from './geometry';
import { groupElements, groupList, pruneGroups, reorderSelection, ungroupElements } from './groups';
import { buildFromSpec, generatorById, mergeParams } from './svg-gen/registry';
import type { SvgGenParams } from './svg-gen/types';

/* --------------------------------------------------------------- 文档查找 */

/** 在工程里找某个文本片段的文档。找不到返回 null（片段可能刚被删）。 */
export function findTextDoc(project: Project, clipId: string): TypographyDocument | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id !== clipId) continue;
      if (clip.kind === 'source' && clip.source.type === 'text') return clip.source.doc;
      return null;
    }
  }
  return null;
}

/** 这个片段是不是文本片段（写方法的第一道判据）。 */
export function isTextClip(project: Project, clipId: string): boolean {
  return findTextDoc(project, clipId) !== null;
}

/* --------------------------------------------------------------- 小工具 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 坐标保留两位小数：工程 JSON 里不该出现 `123.00000000000001`。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampSize(n: unknown, fallback: number): number {
  return Math.max(1, round2(finite(n, fallback)));
}

/* --------------------------------------------------------------- 帧 */

export interface FramePatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
}

/** 把补丁合进一个已有 frame（尺寸钳到 ≥1，坐标保留两位）。 */
export function applyFramePatch(frame: TextureFrame, patch: FramePatch): void {
  if (patch.x !== undefined) frame.x = round2(finite(patch.x, frame.x));
  if (patch.y !== undefined) frame.y = round2(finite(patch.y, frame.y));
  if (patch.w !== undefined) frame.w = clampSize(patch.w, frame.w);
  if (patch.h !== undefined) frame.h = clampSize(patch.h, frame.h);
  if (patch.rot !== undefined) frame.rot = finite(patch.rot, frame.rot);
}

/* --------------------------------------------------------------- 颜色 / 填充 */

/** 颜料种类的白名单（`typo_update_group` 这类「整份 Paint」的入口要用它校验）。 */
export const PAINT_KINDS = new Set(['none', 'solid', 'linear', 'radial', 'texture']);
const TEXTURE_IDS = new Set(['dots', 'grid', 'diagonal', 'cross', 'checker', 'wave']);

function colorString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/**
 * `Paint` 的宽松校验。
 *
 * agent 的输出是不可信输入：错一个 `kind` 就会让渲染层走进不存在的分支
 * （`render-dom` 的 switch 没有兜底）。所以这里**一律降级到 none**，绝不抛。
 */
export function coercePaint(raw: unknown, fallback: Paint = { kind: 'none' }): Paint {
  if (!isRecord(raw)) return fallback;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!PAINT_KINDS.has(kind)) return fallback;
  const opacity =
    raw.opacity === undefined ? undefined : Math.max(0, Math.min(1, finite(raw.opacity, 1)));
  const stops = Array.isArray(raw.stops)
    ? (raw.stops as unknown[])
        .filter(isRecord)
        .map((s) => ({ offset: Math.max(0, Math.min(1, finite(s.offset, 0))), color: colorString(s.color, '#000000') }))
        .slice(0, 8)
    : [];
  switch (kind) {
    case 'none':
      return { kind: 'none' };
    case 'solid': {
      const p: Paint = { kind: 'solid', color: colorString(raw.color, '#ffffff') };
      return opacity === undefined ? p : { ...p, opacity };
    }
    case 'linear': {
      const p: Paint = {
        kind: 'linear',
        angle: finite(raw.angle, 0),
        stops: stops.length >= 2 ? stops : [
          { offset: 0, color: '#6f64ef' },
          { offset: 1, color: '#00e3c0' },
        ],
      };
      return opacity === undefined ? p : { ...p, opacity };
    }
    case 'radial': {
      const p: Paint = {
        kind: 'radial',
        stops: stops.length >= 2 ? stops : [
          { offset: 0, color: '#ffffff' },
          { offset: 1, color: '#000000' },
        ],
      };
      return opacity === undefined ? p : { ...p, opacity };
    }
    default: {
      const pattern = typeof raw.pattern === 'string' && TEXTURE_IDS.has(raw.pattern) ? raw.pattern : 'dots';
      const p: Paint = {
        kind: 'texture',
        pattern: pattern as Extract<Paint, { kind: 'texture' }>['pattern'],
        color: colorString(raw.color, '#ffffff'),
        bg: colorString(raw.bg, 'rgba(0,0,0,0)'),
        scale: Math.max(2, finite(raw.scale, 28)),
        thickness: Math.max(0.5, finite(raw.thickness, 3)),
      };
      return opacity === undefined ? p : { ...p, opacity };
    }
  }
}

/**
 * 描边填充：`{kind:'none'}` / `{kind:'solid'}` 等价于「没有填充」（回到 `color`），
 * 这时必须**删掉字段**而不是写一个 `{kind:'none'}` —— 见 Stroke.paint 的语义。
 */
function withStrokePaint(base: Stroke, raw: unknown): Stroke {
  if (raw === undefined) return base;
  const paint = coercePaint(raw, base.paint ?? { kind: 'none' });
  const next: Stroke = { ...base };
  if (paint.kind === 'none' || paint.kind === 'solid') delete next.paint;
  else next.paint = paint;
  return next;
}

export function coerceStroke(raw: unknown, fallback: Stroke | null = null): Stroke | null {
  if (raw === null) return null;
  if (!isRecord(raw)) return fallback;
  const style = raw.style === 'dashed' || raw.style === 'dotted' ? raw.style : 'solid';
  return withStrokePaint(
    {
      color: colorString(raw.color, '#ffffff'),
      width: Math.max(0, finite(raw.width, 2)),
      style,
    },
    raw.paint,
  );
}

/**
 * 字形描边（`TextElement.glyphStroke`）。同样是「没有 = 键不存在」，
 * 复用 `coerceStroke`：它已经把颜色 / 宽度 / 线型都钳过了（线型渲染侧忽略）。
 */
function setGlyphStroke(el: TextElement, raw: unknown): void {
  if (raw === null) {
    delete el.glyphStroke;
    return;
  }
  const s = coerceStroke(raw, el.glyphStroke ?? null);
  if (s) el.glyphStroke = s;
  else delete el.glyphStroke;
}

/**
 * 文本框边框（`TextElement.boxStroke` 是 `Stroke | undefined`，不是 `| null`）。
 *
 * 三个写入点共用：不给 `null` 语义是刻意的 —— 文档模型里「没有边框」就是
 * 键不存在，与 `Paint.kind === 'none'` 不是同一套表达。
 */
function setTextBoxStroke(el: TextElement, raw: unknown): void {
  if (raw === null) {
    delete el.boxStroke;
    return;
  }
  if (!isRecord(raw)) return;
  el.boxStroke = withStrokePaint(
    {
      color: colorString(raw.color, '#ffffff'),
      width: Math.max(0, finite(raw.width, 2)),
      style: raw.style === 'dashed' || raw.style === 'dotted' ? raw.style : 'solid',
    },
    raw.paint,
  );
}

/**
 * 图形的**图片填充**（`ShapeElement.imageFill`）。
 *
 * 坏形状返回 null（= 不写这个字段），绝不抛：这条字段是从 agent / 手改的 JSON
 * 进来的，而渲染侧只会拿 `assetId` 去 `resolveImage`，一个不存在的 id 自然
 * 落到「脱机媒体」占位，不会把排版树搞坏。
 */
export function coerceImageFill(raw: unknown): ShapeElement['imageFill'] | null {
  if (!isRecord(raw)) return null;
  const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim() : '';
  if (!assetId) return null;
  const fit =
    raw.fit === 'fill' || raw.fit === 'contain' || raw.fit === 'cover' ? raw.fit : 'cover';
  return { assetId, fit };
}

/** 把 `applyPaintPatch` 的入参收窄成安全形状（只认它认识的键）。 */
export function coercePaintPatch(raw: unknown): ShapePaintPatch | null {
  if (!isRecord(raw)) return null;
  const out: ShapePaintPatch = {};
  if (typeof raw.kind === 'string' && PAINT_KINDS.has(raw.kind)) {
    out.kind = raw.kind as NonNullable<ShapePaintPatch['kind']>;
  }
  if (typeof raw.color === 'string') out.color = raw.color;
  if (typeof raw.color2 === 'string') out.color2 = raw.color2;
  if (Number.isFinite(Number(raw.angle))) out.angle = Number(raw.angle);
  if (Number.isFinite(Number(raw.opacity))) out.opacity = Math.max(0, Math.min(1, Number(raw.opacity)));
  if (typeof raw.pattern === 'string' && TEXTURE_IDS.has(raw.pattern)) {
    out.pattern = raw.pattern as NonNullable<ShapePaintPatch['pattern']>;
  }
  if (Number.isFinite(Number(raw.scale))) out.scale = Number(raw.scale);
  if (Number.isFinite(Number(raw.thickness))) out.thickness = Number(raw.thickness);
  if (Array.isArray(raw.stops)) {
    out.stops = (raw.stops as unknown[]).filter(isRecord).map((s) => ({
      offset: Math.max(0, Math.min(1, finite(s.offset, 0))),
      color: colorString(s.color, '#000000'),
    }));
  }
  return out;
}

/* --------------------------------------------------------------- 文本样式 */

const ALIGNS = new Set(['left', 'center', 'right', 'justify']);
const VALIGNS = new Set(['top', 'middle', 'bottom']);
const DECOR = new Set(['none', 'underline', 'line-through']);
const TRANSFORM = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);
const WRITING = new Set(['horizontal-tb', 'vertical-rl']);

/** 文本样式的白名单补丁（未知键静默丢弃 —— agent 拼错键名不该让整次调用失败）。 */
export function applyTextStylePatch(style: TextStyle, raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  let changed = false;
  const set = <K extends keyof TextStyle>(key: K, v: TextStyle[K]): void => {
    if (style[key] === v) return;
    style[key] = v;
    changed = true;
  };
  if (typeof raw.fontFamily === 'string' && raw.fontFamily.trim()) set('fontFamily', raw.fontFamily);
  if (Number.isFinite(Number(raw.fontSize))) set('fontSize', Math.max(1, Number(raw.fontSize)));
  if (Number.isFinite(Number(raw.fontWeight))) {
    set('fontWeight', Math.max(100, Math.min(900, Math.round(Number(raw.fontWeight)))));
  }
  if (raw.fontStyle === 'normal' || raw.fontStyle === 'italic') set('fontStyle', raw.fontStyle);
  if (Number.isFinite(Number(raw.letterSpacing))) set('letterSpacing', Number(raw.letterSpacing));
  if (Number.isFinite(Number(raw.lineHeight))) set('lineHeight', Math.max(0.5, Number(raw.lineHeight)));
  if (typeof raw.align === 'string' && ALIGNS.has(raw.align)) set('align', raw.align as TextStyle['align']);
  if (typeof raw.vAlign === 'string' && VALIGNS.has(raw.vAlign)) {
    set('vAlign', raw.vAlign as TextStyle['vAlign']);
  }
  if (typeof raw.color === 'string' && raw.color.trim()) set('color', raw.color);
  if (typeof raw.textDecoration === 'string' && DECOR.has(raw.textDecoration)) {
    set('textDecoration', raw.textDecoration as TextStyle['textDecoration']);
  }
  if (typeof raw.textTransform === 'string' && TRANSFORM.has(raw.textTransform)) {
    set('textTransform', raw.textTransform as TextStyle['textTransform']);
  }
  if (typeof raw.writingMode === 'string' && WRITING.has(raw.writingMode)) {
    set('writingMode', raw.writingMode as TextStyle['writingMode']);
  }
  if (raw.highlight === null) {
    if (style.highlight !== undefined) {
      delete style.highlight;
      changed = true;
    }
  } else if (typeof raw.highlight === 'string') {
    set('highlight', raw.highlight);
  }
  /*
   * 文字阴影：三种形态都收 —— `null` 清空、单个对象（老形态 / 手写调用）、
   * 数组（多层）。写回**一律是数组**，于是「只有一份真相」成立（读的地方
   * 还要过 `textShadowList()`，那是给老工程数据留的）。
   */
  if (raw.shadow === null) {
    if (style.shadow !== undefined) {
      delete style.shadow;
      changed = true;
    }
  } else if (Array.isArray(raw.shadow) || isRecord(raw.shadow)) {
    const list = (Array.isArray(raw.shadow) ? raw.shadow : [raw.shadow])
      .filter(isRecord)
      .slice(0, 8)
      .map((s) => ({
        color: colorString(s.color, '#000000'),
        dx: finite(s.dx, 0.045),
        dy: finite(s.dy, 0.045),
        blur: Math.max(0, finite(s.blur, 0.09)),
      }));
    if (list.length) set('shadow', list);
    else if (style.shadow !== undefined) {
      delete style.shadow;
      changed = true;
    }
  }
  return changed;
}

/**
 * 文本元素的**字形填充**写入（agent / 文档导入共用）。
 *
 * `TextElement.fill` 的语义是「只有渐变 / 径向 / 纹理覆盖字形色，纯色仍走
 * `style.color`」（见 `document.ts` 的注释）。对 agent 来说，同一个 `fill`
 * 字段「渐变有效、纯色被静默忽略」是最容易误判成自己写错的一类不一致 ——
 * 所以这里把 `solid` **翻译**成 `style.color`：
 *
 *  - `{ kind:'solid', color }` → `style.color = color`，并删掉 `fill`；
 *  - `{ kind:'none' }` / `null` → 删掉 `fill`（回到 `style.color`）；
 *  - 渐变 / 径向 / 纹理 → 整份写进 `fill`；
 *  - 不带 `kind` 的局部补丁（`{ color }`）→ 沿用既有 `applyPaintPatch` 语义。
 *
 * 返回是否真的改了东西。`coercePaint` 永不抛（agent 的输出是不可信输入）。
 */
export function applyTextFill(el: TextElement, raw: unknown): boolean {
  if (raw === null) {
    const had = el.fill !== undefined;
    delete el.fill;
    return had;
  }
  if (!isRecord(raw)) return false;

  if (!('kind' in raw)) {
    // 局部补丁：只改已有填充的颜色 / 角度，不换类型。
    const patch = coercePaintPatch(raw);
    if (!patch) return false;
    const next = applyPaintPatch(el.fill ?? { kind: 'none' }, patch);
    const changed = JSON.stringify(next) !== JSON.stringify(el.fill ?? null);
    if (next.kind === 'none') delete el.fill;
    else el.fill = next;
    return changed;
  }

  // 未知 kind 当作「没给」而不是降级成 none：补丁把已有渐变清掉，
  // 与「拼错一个枚举值」的代价完全不对称。
  if (typeof raw.kind !== 'string' || !PAINT_KINDS.has(raw.kind)) return false;
  const paint = coercePaint(raw);
  if (paint.kind === 'solid') {
    const changed = el.style.color !== paint.color || el.fill !== undefined;
    el.style.color = paint.color;
    delete el.fill;
    return changed;
  }
  if (paint.kind === 'none') {
    const had = el.fill !== undefined;
    delete el.fill;
    return had;
  }
  const changed = JSON.stringify(paint) !== JSON.stringify(el.fill ?? null);
  el.fill = paint;
  return changed;
}

/* --------------------------------------------------------------- 新增元素 */

/** 新建元素都能顺手带一条 / 一组动画（`typo_add_element` 的同名字段）。 */
export interface AnimationCarrier {
  animation?: unknown;
  animations?: unknown[];
}

/** 新建元素的公共可选字段（与 `typo_update_element` 的 patch 同名同义）。 */
export interface ElementExtras {
  /** 元素级 3D：与恒等值合并，`null` / 省略 = 没有 3D。 */
  transform3d?: unknown;
  /** 镜头景深（0..1）。省略 / `null` = 不吃镜头（无穷远）。 */
  depth?: number | null;
}

export interface NewTextInput extends AnimationCarrier, ElementExtras {
  text: string;
  /** 行内富文本：给了就用它（`text` 退化成「纯文本速记」）。 */
  runs?: unknown;
  frame?: FramePatch;
  style?: Record<string, unknown>;
  fill?: unknown;
  boxFill?: unknown;
  boxStroke?: unknown;
  /** 字形描边（`-webkit-text-stroke`）：`{ color, width }`，宽度 px。 */
  glyphStroke?: unknown;
  /** true = 宽固定、高随内容。 */
  autoHeight?: boolean;
  name?: string;
  opacity?: number;
  blend?: string;
}

export interface NewShapeInput extends AnimationCarrier, ElementExtras {
  shape: string;
  frame?: FramePatch;
  fill?: unknown;
  stroke?: unknown;
  radius?: number;
  sides?: number;
  waist?: number;
  inner?: number;
  angle?: number;
  path?: string;
  pathUnit?: 'px' | 'percent';
  clipFrame?: boolean;
  evenOdd?: boolean;
  name?: string;
  opacity?: number;
  blend?: string;
}

export interface NewImageInput extends AnimationCarrier, ElementExtras {
  assetId: string;
  frame?: FramePatch;
  fit?: string;
  radius?: number;
  crop?: { x: number; y: number; w: number; h: number };
  /** 抠像 / 四角（与片段同名字段，见 `core/image-fx.ts`）。 */
  key?: unknown;
  quad?: unknown;
  name?: string;
  opacity?: number;
  blend?: string;
}

export function isShapeKind(v: unknown): v is ShapeKind {
  return typeof v === 'string' && (SHAPE_KINDS as readonly string[]).includes(v);
}

const MIX_BLEND_IDS = new Set([
  'normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn',
  'hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity',
]);

/**
 * 把 `animation` / `animations` 写进元素。非法输入**抛错**（调用方前置校验过；
 * 这里抛是为了「静默丢一条动画」永远不会发生 —— 那在画面上就是「动画没反应」）。
 *
 * `append: false` 用于「设动画」语义（替换），`true` 用于新建元素（本来就空）。
 */
export function applyAnimations(el: TypographyElement, input: AnimationCarrier, append = true): boolean {
  const raw = Array.isArray(input.animations)
    ? input.animations
    : input.animation !== undefined
      ? [input.animation]
      : [];
  if (raw.length === 0) return false;
  const parsed: ElementAnimation[] = [];
  for (const item of raw) {
    if (item === null) continue;
    // 一条输入可能展开成多条轨道（旧式 keys 的每个属性一条），所以是数组。
    const anims = animationsFromInput(item);
    if (!anims) throw new Error('invalid animation input');
    parsed.push(...anims);
  }
  if (parsed.length === 0) return false;
  el.animations = append ? [...(el.animations ?? []), ...parsed] : parsed;
  return true;
}

/**
 * `typo_set_animation` 的写入原语：`input === null` 清空，否则替换 / 追加一条。
 * 非法输入抛错（调用方已在 `commit` 之前校验过一次，这里抛是第二道闸）。
 */
export function setAnimation(
  el: TypographyElement,
  input: unknown,
  mode: 'replace' | 'add' = 'replace',
): boolean {
  if (input === null) {
    el.animations = [];
    return true;
  }
  const anims = animationsFromInput(input);
  if (!anims) throw new Error('invalid animation input');
  el.animations = mode === 'add' ? [...(el.animations ?? []), ...anims] : anims;
  return true;
}

function applyCommon(
  el: TypographyElement,
  input: { name?: string; opacity?: number; blend?: string; depth?: number | null } & AnimationCarrier &
    ElementExtras,
): void {
  if (typeof input.name === 'string' && input.name.trim()) el.name = input.name;
  if (Number.isFinite(Number(input.opacity))) el.opacity = Math.max(0, Math.min(1, Number(input.opacity)));
  if (typeof input.blend === 'string' && MIX_BLEND_IDS.has(input.blend)) {
    el.blend = input.blend as TypographyElement['blend'];
  }
  // 景深：与 patch 同一条语义（`null` 或省略 = 不吃镜头）。
  if (input.depth === null) {
    delete el.depth;
  } else if (Number.isFinite(Number(input.depth))) {
    el.depth = Math.max(0, Math.min(1, Number(input.depth)));
  }
  // 3D 与 patch 同一条语义（对象合并、null 删除）；新建时基值是「没有」。
  if (input.transform3d === null) {
    delete el.transform3d;
  } else if (input.transform3d !== undefined) {
    const patch = coerceTransform3DPatch(input.transform3d);
    if (patch) el.transform3d = mergeTransform3D(el.transform3d, patch);
  }
  applyAnimations(el, input);
}

/** 追加一个文字元素。返回它（调用方要 id）。 */
export function addTextElement(doc: TypographyDocument, input: NewTextInput): TextElement {
  // `runs` 优先：带行内覆盖的内容没法用 `text` 表达。
  const runs = input.runs === undefined ? null : coerceRuns(input.runs);
  const el = createTextElement(doc.size, {
    ...(runs ? { runs } : { text: typeof input.text === 'string' ? input.text : '' }),
    ...(input.name ? { name: input.name } : {}),
  });
  applyFramePatch(el.frame, input.frame ?? {});
  applyTextStylePatch(el.style, input.style ?? {});
  // 纯色 fill 落到 style.color —— 见 applyTextFill 的注释。
  if (input.fill !== undefined) applyTextFill(el, input.fill);
  if (input.boxFill !== undefined) el.boxFill = coercePaint(input.boxFill);
  if (input.boxStroke !== undefined) setTextBoxStroke(el, input.boxStroke);
  if (input.glyphStroke !== undefined) setGlyphStroke(el, input.glyphStroke);
  if (input.autoHeight !== undefined) el.autoHeight = Boolean(input.autoHeight);
  applyCommon(el, input);
  doc.elements = [...doc.elements, el];
  return el;
}

/** 追加一个图形元素。 */
export function addShapeElement(doc: TypographyDocument, input: NewShapeInput): ShapeElement {
  if (!isShapeKind(input.shape)) {
    throw new Error(`unknown shape: ${String(input.shape)}`);
  }
  const el = createShapeElement(doc.size, input.shape, {
    ...(input.path ? { path: input.path } : {}),
    ...(input.pathUnit === 'px' ? { pathUnit: 'px' as const } : {}),
    ...(input.clipFrame ? { clipFrame: true } : {}),
    ...(input.evenOdd !== undefined ? { evenOdd: input.evenOdd } : {}),
  });
  applyFramePatch(el.frame, input.frame ?? {});
  /*
   * **agent 造的形状默认是空的**：没给 fill ⇒ `none`，没给 stroke ⇒ `null`。
   *
   * 面板里新建形状给实心紫是合理的（人眼立刻看到「它在那儿」，然后自己改）；
   * agent 不是 —— 它往往是「先搭骨架、再逐个上色」，而一块默认紫会把画面染成
   * 它没打算要的样子，并且从一张 640 宽的截图里很难分辨「这是我要的紫还是默认紫」。
   * 同理，`line` 在工厂里会带一条白色 4px 描边：只给 fill 的调用方会得到
   * 「一条比预期粗得多的白线」，所以这里也显式覆盖成 null（要描边就自己给）。
   *
   * `get_typography_capabilities().units` 里写明了这条默认值，模型不会因为
   * 「忘了给 fill」而得到一张空白图还不知道原因。
   */
  if (input.fill !== undefined) el.fill = coercePaint(input.fill, { kind: 'none' });
  else el.fill = { kind: 'none' };
  if (input.stroke !== undefined) el.stroke = coerceStroke(input.stroke, null);
  else el.stroke = null;
  if (Number.isFinite(Number(input.radius))) el.radius = Math.max(0, Number(input.radius));
  if (Number.isFinite(Number(input.sides))) el.sides = Math.max(3, Math.min(64, Math.round(Number(input.sides))));
  if (Number.isFinite(Number(input.waist))) el.waist = Math.max(0.02, Math.min(1, Number(input.waist)));
  if (Number.isFinite(Number(input.inner))) el.inner = Math.max(0, Number(input.inner));
  if (Number.isFinite(Number(input.angle))) el.angle = Number(input.angle);
  if (input.name) el.name = input.name;
  applyCommon(el, input);
  doc.elements = [...doc.elements, el];
  return el;
}

/** 追加一个图片元素（`natural` 由调用方从素材仓取，取不到就按正方块）。 */
export function addImageElement(
  doc: TypographyDocument,
  input: NewImageInput,
  natural?: { w: number; h: number } | null,
): ImageElement {
  const el = createImageElement(doc.size, input.assetId, {
    ...(natural ? { natural } : {}),
    ...(input.name ? { name: input.name } : {}),
  });
  applyFramePatch(el.frame, input.frame ?? {});
  if (input.fit && ['fill', 'contain', 'cover', 'none'].includes(input.fit)) {
    el.fit = input.fit as ImageElement['fit'];
  }
  if (Number.isFinite(Number(input.radius))) el.radius = Math.max(0, Number(input.radius));
  if (isRecord(input.crop)) {
    el.crop = {
      x: Math.max(0, Math.min(1, finite(input.crop.x, 0))),
      y: Math.max(0, Math.min(1, finite(input.crop.y, 0))),
      w: Math.max(0.01, Math.min(1, finite(input.crop.w, 1))),
      h: Math.max(0.01, Math.min(1, finite(input.crop.h, 1))),
    };
  }
  const key = input.key === undefined ? null : coerceKeySettings(input.key);
  if (key) el.key = key;
  const quad = input.quad === undefined ? null : coerceQuadCorners(input.quad);
  if (quad) el.quad = quad;
  applyCommon(el, input);
  doc.elements = [...doc.elements, el];
  return el;
}

/** 按生成器 id 造一个 `shape:'svg'` 元素（参数会在内部补默认值）。 */
export function addGeneratedShape(
  doc: TypographyDocument,
  input: {
    genId: string;
    params?: Record<string, number | string>;
    seed?: number;
    frame?: FramePatch;
    name?: string;
    fill?: unknown;
    stroke?: unknown;
    animation?: unknown;
    animations?: unknown[];
  },
): ShapeElement {
  const spec = generatorById(input.genId);
  if (!spec) throw new Error(`unknown generator: ${input.genId}`);
  const seed = Number.isFinite(Number(input.seed)) ? Number(input.seed) >>> 0 : spec.defaultSeed >>> 0;
  const params: SvgGenParams = mergeParams(spec, input.params);
  const built = buildFromSpec(spec, params, seed);

  // 默认盒子按 aspect 定（条码那类方盒里会被拉变形）。
  const aspect = spec.aspect && spec.aspect > 0 ? spec.aspect : 1;
  const baseW = Math.min(doc.size.w * 0.5, doc.size.h * 0.5 * aspect);
  const frame: TextureFrame = {
    x: round2((doc.size.w - baseW) / 2),
    y: round2((doc.size.h - baseW / aspect) / 2),
    w: round2(baseW),
    h: round2(baseW / aspect),
    rot: 0,
  };

  const el = createShapeElement(doc.size, 'svg', {
    path: built.d,
    ...(built.evenOdd ? { evenOdd: true } : {}),
    frame,
    ...(input.name ? { name: input.name } : {}),
  });
  /*
   * 与 `addShapeElement` 同一条默认值：**没给 fill ⇒ none，没给 stroke ⇒ null**。
   *
   * 生成器的图元是有面积的吗？不是 —— `barcode` / `rings` 这类是「细长条 / 细环」，
   * 拿 `stroke` 去描它们，宽度一对叠就煳成一整块实心板（用户实测报过）。所以
   * `notes` 里统一写「用 fill」；这里不再替调用方补一条默认描边。
   * 例外只有 `strokeOnly` 的生成器（路径本身就是一条线，没有可填充的面积）：
   * 那种必须给描边，否则画不出来，宽度取 2px。
   */
  if (built.strokeOnly) {
    el.fill = { kind: 'none' };
    el.stroke = { color: '#ffffff', width: 2, style: 'solid' };
  } else {
    el.fill = { kind: 'none' };
    el.stroke = null;
  }
  if (input.fill !== undefined) el.fill = coercePaint(input.fill, { kind: 'none' });
  if (input.stroke !== undefined) el.stroke = coerceStroke(input.stroke, null);
  applyFramePatch(el.frame, input.frame ?? {});
  applyAnimations(el, input);
  el.gen = { id: spec.id, seed, params };
  doc.elements = [...doc.elements, el];
  return el;
}

/* --------------------------------------------------------------- 修改 / 删除 */

/**
 * 白名单属性补丁。返回是否改了东西。
 *
 * `kind` / `id` / `assetId` 一律不可写 —— 那些各有专属入口（换源要走片段层）。
 */
export function patchElement(
  doc: TypographyDocument,
  id: string,
  raw: Record<string, unknown>,
): boolean {
  const el = elementById(doc, id);
  if (!el) throw new Error(`element not found: ${id}`);
  let changed = false;
  const before = JSON.stringify(el);

  if (raw.name !== undefined && typeof raw.name === 'string') el.name = raw.name;
  if (isRecord(raw.frame)) applyFramePatch(el.frame, raw.frame as FramePatch);
  if (typeof raw.blend === 'string' && MIX_BLEND_IDS.has(raw.blend)) {
    el.blend = raw.blend as TypographyElement['blend'];
  }
  if (raw.opacity !== undefined && Number.isFinite(Number(raw.opacity))) {
    el.opacity = Math.max(0, Math.min(1, Number(raw.opacity)));
  }
  /*
   * 景深（镜头视差）：`null` 删字段（回到「无穷远」），数字则夹进 0..1。
   * 删字段而不是写 0 是为了让读回形状与「没设过」一致 —— 0 与 undefined 在
   * 渲染上等价，但写回往返会把每个元素都染上一个键。
   */
  if (raw.depth === null) {
    delete el.depth;
  } else if (raw.depth !== undefined) {
    el.depth = Math.max(0, Math.min(1, finite(raw.depth, 0)));
  }
  if (raw.visible !== undefined) el.visible = Boolean(raw.visible);
  if (raw.locked !== undefined) el.locked = Boolean(raw.locked);

  /*
   * 3D：`null` 关闭（删字段），对象则**合并**（与面板「先启用再调」同一条语义——
   * 只给 `{rotate:{y:35}}` 不该把已有透视 / 位移清掉）。
   */
  if (raw.transform3d === null) {
    delete el.transform3d;
  } else if (raw.transform3d !== undefined) {
    const patch = coerceTransform3DPatch(raw.transform3d);
    if (patch) el.transform3d = mergeTransform3D(el.transform3d, patch);
  }

  /*
   * 动画：`animations` / `animation` **替换**（与「改属性」的语义一致），
   * `removeAnimations: true` 或 `animation: null` 清空，`addAnimation` 追加。
   * 没有 `append` 语义的话，「把 pop 改成 fade」在工具面上只能先读再删再加。
   */
  if (raw.removeAnimations === true || raw.animation === null) {
    el.animations = [];
  } else if (raw.animations !== undefined || raw.animation !== undefined) {
    applyAnimations(el, raw as AnimationCarrier, false);
  } else if (raw.addAnimation !== undefined) {
    applyAnimations(el, { animation: raw.addAnimation }, true);
  }

  /* 阴影 / 虚化：所有元素通用，都是「空 = 删字段」。 */
  if (raw.blur !== undefined) {
    const v = Math.max(0, finite(raw.blur, 0));
    if (v > 0) el.blur = v;
    else delete el.blur;
  }
  if (raw.shadows !== undefined) {
    const list = (Array.isArray(raw.shadows) ? raw.shadows : [])
      .filter(isRecord)
      .slice(0, 8)
      .map((s) => ({
        color: colorString(s.color, '#000000'),
        dx: finite(s.dx, 0),
        dy: finite(s.dy, 0),
        blur: Math.max(0, finite(s.blur, 0)),
      }));
    if (list.length) el.shadows = list;
    else delete el.shadows;
  }

  if (el.kind === 'text') {
    if (isRecord(raw.style)) applyTextStylePatch(el.style, raw.style);
    // 纯色 fill 等价于 style.color（见 applyTextFill）；null / {kind:'none'} = 清掉渐变。
    if (raw.fill !== undefined) applyTextFill(el, raw.fill);
    const boxPatch = coercePaintPatch(raw.boxFill);
    if (boxPatch) el.boxFill = applyPaintPatch(el.boxFill ?? { kind: 'none' }, boxPatch);
    if (raw.boxStroke !== undefined) setTextBoxStroke(el, raw.boxStroke);
    if (raw.glyphStroke !== undefined) setGlyphStroke(el, raw.glyphStroke);
    if (raw.text !== undefined && typeof raw.text === 'string') el.runs = runsFromText(raw.text);
    // `runs` 覆盖 `text` 之后：同一份 patch 里两个都给时，后者更精确。
    if (raw.runs !== undefined) {
      const runs = coerceRuns(raw.runs);
      if (runs) el.runs = runs;
    }
    if (raw.autoHeight !== undefined) el.autoHeight = Boolean(raw.autoHeight);
  } else if (el.kind === 'shape') {
    const fillPatch = coercePaintPatch(raw.fill);
    if (fillPatch) el.fill = applyPaintPatch(el.fill, fillPatch);
    if (raw.stroke !== undefined) el.stroke = coerceStroke(raw.stroke, el.stroke);
    /*
     * 手写路径只对 `shape:'svg'` 有意义（其它图形由参数生成几何）。写 path 时
     * 顺手清掉 `gen`：生成器元素一旦被手改过，下次改参数会把它静默覆盖掉。
     * 这条与编辑器的「转为路径 / 进入顶点编辑」同源（见 typography/AGENTS.md）。
     */
    if (typeof raw.path === 'string' && el.shape === 'svg') {
      el.path = raw.path;
      delete el.gen;
    }
    if (raw.pathUnit === 'px') el.pathUnit = 'px';
    else if (raw.pathUnit === 'percent') delete el.pathUnit;
    if (raw.clipFrame !== undefined) {
      if (raw.clipFrame) el.clipFrame = true;
      else delete el.clipFrame;
    }
    if (Number.isFinite(Number(raw.radius))) el.radius = Math.max(0, Number(raw.radius));
    if (Number.isFinite(Number(raw.sides))) el.sides = Math.max(3, Math.min(64, Math.round(Number(raw.sides))));
    if (Number.isFinite(Number(raw.waist))) el.waist = Math.max(0.02, Math.min(1, Number(raw.waist)));
    if (Number.isFinite(Number(raw.inner))) el.inner = Math.max(0, Number(raw.inner));
    if (Number.isFinite(Number(raw.angle))) el.angle = Number(raw.angle);
    if (raw.evenOdd !== undefined) el.evenOdd = Boolean(raw.evenOdd);
    // 图片填充：`null` = 回到普通填充（与编辑器的「换填充方式」同一语义）。
    if (raw.imageFill === null) delete el.imageFill;
    else if (raw.imageFill !== undefined) {
      const imageFill = coerceImageFill(raw.imageFill);
      if (imageFill) el.imageFill = imageFill;
    }
    if (raw.fill !== undefined && isRecord(raw.fill) && raw.fill.kind !== undefined) {
      delete el.imageFill;
    }
    // 改生成器的种子 / 参数：重算路径（与 UI 的 rebuildGen 同一口径）。
    if (isRecord(raw.gen)) {
      const genId = typeof raw.gen.id === 'string' ? raw.gen.id : el.gen?.id;
      const spec = genId ? generatorById(genId) : null;
      if (spec) {
        const seed = Number.isFinite(Number(raw.gen.seed))
          ? Number(raw.gen.seed) >>> 0
          : el.gen?.seed ?? spec.defaultSeed;
        const params = mergeParams(spec, isRecord(raw.gen.params) ? (raw.gen.params as SvgGenParams) : el.gen?.params);
        const built = buildFromSpec(spec, params, seed);
        el.path = built.d;
        el.evenOdd = built.evenOdd ?? false;
        el.gen = { id: spec.id, seed, params };
      }
    }
  } else if (el.kind === 'image') {
    if (typeof raw.fit === 'string' && ['fill', 'contain', 'cover', 'none'].includes(raw.fit)) {
      el.fit = raw.fit as ImageElement['fit'];
    }
    if (Number.isFinite(Number(raw.radius))) el.radius = Math.max(0, Number(raw.radius));
    if (isRecord(raw.crop)) {
      el.crop = {
        x: Math.max(0, Math.min(1, finite(raw.crop.x, 0))),
        y: Math.max(0, Math.min(1, finite(raw.crop.y, 0))),
        w: Math.max(0.01, Math.min(1, finite(raw.crop.w, 1))),
        h: Math.max(0.01, Math.min(1, finite(raw.crop.h, 1))),
      };
    }
    // 抠图 / 四角：`null` = 关掉；形状不对时**整条不写**（调用方负责前置校验）。
    if (raw.key === null) delete el.key;
    else if (raw.key !== undefined) {
      const key = coerceKeySettings(raw.key, el.key);
      if (key) el.key = key;
    }
    if (raw.quad === null) delete el.quad;
    else if (raw.quad !== undefined) {
      const quad = coerceQuadCorners(raw.quad);
      if (quad) el.quad = quad;
    }
    /*
     * 色彩校正 / 重新着色 / 边框 / 滤镜。`null` = 关掉，对象 = **局部合并**
     * （与抠图同一条语义：只给 `{brightness: 20}` 不该把别的项清掉）。
     */
    if (raw.adjust === null) delete el.adjust;
    else if (raw.adjust !== undefined) {
      const adjust = coerceImageAdjust(raw.adjust, el.adjust);
      if (adjust) el.adjust = adjust;
    }
    if (raw.recolor === null) delete el.recolor;
    else if (raw.recolor !== undefined) {
      const recolor = coerceImageRecolor(raw.recolor, el.recolor);
      if (recolor) el.recolor = recolor;
    }
    if (raw.border === null) delete el.border;
    else if (raw.border !== undefined) {
      const border = coerceImageBorder(raw.border, el.border);
      if (border) {
        if (border.width <= 0) delete el.border;
        else el.border = border;
      }
    }
    if (raw.filter === null) delete el.filter;
    else if (raw.filter !== undefined) {
      const filter = coerceImageFilter(raw.filter);
      if (filter) el.filter = filter;
    }
  }

  changed = JSON.stringify(el) !== before;
  return changed;
}

export function removeElement(doc: TypographyDocument, id: string): boolean {
  const before = doc.elements.length;
  doc.elements = doc.elements.filter((e) => e.id !== id);
  return doc.elements.length !== before;
}

/**
 * 层级调整（前后 / 逐层）。
 *
 * 就地写回同一个 doc 对象 —— `reorderElements` 是纯函数（返回新文档），
 * 而 `store.commit` 里拿到的引用必须保持有效。
 */
export function reorderElement(
  doc: TypographyDocument,
  id: string,
  op: 'front' | 'back' | 'forward' | 'backward',
): boolean {
  const next = reorderElements(doc, [id], op);
  if (next === doc) return false;
  doc.elements = next.elements;
  return true;
}

/**
 * 移动到指定下标（数组顺序 = z 序，**末尾 = 最前**）。
 *
 * `reorderElement` 的四档只能「相对」移动；把元素精确放到某一层（比如「插在标题
 * 与副标题之间」）需要绝对值。越界值夹进 `[0, n-1]`。
 */
export function moveElementTo(doc: TypographyDocument, id: string, index: number): boolean {
  const from = doc.elements.findIndex((e) => e.id === id);
  if (from < 0) return false;
  const at = Math.max(0, Math.min(doc.elements.length - 1, Math.round(index)));
  if (at === from) return false;
  const next = [...doc.elements];
  const [moved] = next.splice(from, 1);
  next.splice(at, 0, moved!);
  doc.elements = next;
  return true;
}

/* --------------------------------------------------------------- 组合 */

export function groupSelection(doc: TypographyDocument, ids: string[], name: string): string | null {
  const next = groupElements(doc, ids, name);
  if (next === doc) return null;
  const added = (next.groups ?? []).filter((g) => !(doc.groups ?? []).some((x) => x.id === g.id))[0];
  doc.elements = next.elements;
  doc.groups = next.groups;
  return added?.id ?? null;
}

export function ungroupSelection(doc: TypographyDocument, ids: string[]): boolean {
  const next = ungroupElements(doc, ids);
  if (next === doc) return false;
  doc.elements = next.elements;
  doc.groups = next.groups;
  return true;
}

/**
 * 改分组的底板（组名 / 填充 / 边框 / 圆角 / 内边距）。
 *
 * 分组不只是「几个元素一起选中」：它自带一块底板外壳（`TypographyGroup`），
 * 所以「成组」之后还要能把这层壳调成想要的卡片样式 —— 否则 agent 造出来的组
 * 永远是一块没有任何外观的空壳。
 *
 * 就地改同一个 group 对象（`store.commit` 里的引用必须保持有效）。
 */
export function updateGroup(doc: TypographyDocument, groupId: string, raw: Record<string, unknown>): boolean {
  const group = (doc.groups ?? []).find((g) => g.id === groupId);
  if (!group) return false;
  const before = JSON.stringify(group);
  if (typeof raw.name === 'string' && raw.name.trim()) group.name = raw.name.trim();
  if (raw.fill !== undefined) group.fill = coercePaint(raw.fill, group.fill);
  // `stroke: null` = 去掉边框（组模型里就是 null，不是「宽度 0」）。
  if (raw.stroke !== undefined) {
    group.stroke = raw.stroke === null ? null : coerceStroke(raw.stroke, group.stroke);
  }
  if (Number.isFinite(Number(raw.radius))) group.radius = Math.max(0, Number(raw.radius));
  if (Number.isFinite(Number(raw.padding))) group.padding = Math.max(0, Number(raw.padding));
  return JSON.stringify(group) !== before;
}

/** 组视图（写操作回显用：改完的底板直接给回去，不必再读整份文档）。 */
export function groupView(group: TypographyGroup): Record<string, unknown> {
  return { ...group, fill: { ...group.fill }, stroke: group.stroke ? { ...group.stroke } : null };
}

/**
 * 改画幅。
 *
 * `scaleContent` 关 = 只改 `doc.size`：元素留在原像素位置，视口变了、构图跟着挪，
 * 超出的部分被画布边缘裁掉。开 = 过 `resizeDocument`（frame / 字号 / 字距 / 描边宽度 /
 * 阴影 / 虚线 / 3D 的 px 参数一起按比例重排）—— 那才是「换画幅」。
 * 两种都是真实需求，所以给开关而不是替调用方选（与排版页的画幅弹层同一语义）。
 */
export function setDocSize(
  doc: TypographyDocument,
  size: { w: number; h: number },
  scaleContent: boolean,
): boolean {
  const w = Math.max(2, Math.round(Number(size.w)));
  const h = Math.max(2, Math.round(Number(size.h)));
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  if (doc.size.w === w && doc.size.h === h) return false;
  if (!scaleContent) {
    doc.size = { w, h };
    return true;
  }
  const next = resizeDocument(doc, { w, h });
  doc.size = next.size;
  doc.elements = next.elements;
  return true;
}

/** 写库之后的统一收口（与 `editorState.commit` 同一件事）。 */
export function normalizeAfterWrite(doc: TypographyDocument): void {
  const pruned = pruneGroups(doc);
  if (pruned !== doc) {
    doc.elements = pruned.elements;
    doc.groups = pruned.groups;
  }
}

/* --------------------------------------------------------------- 布局 */

export type LayoutRequest =
  | { op: 'align'; axis: AlignAxis; target?: 'canvas' | 'selection'; elementIds?: string[] }
  | { op: 'distribute'; axis: 'h' | 'v'; elementIds?: string[] }
  | { op: 'grid'; cols: number; rows?: number; gap?: number; margin?: number; elementIds?: string[] }
  | { op: 'row' | 'column'; gap?: number; margin?: number; elementIds?: string[] };

function pickTargets(doc: TypographyDocument, ids?: string[]): TypographyElement[] {
  const only = ids && ids.length ? new Set(ids) : null;
  return doc.elements.filter((e) => !e.locked && (!only || only.has(e.id)));
}

/** 让一组元素在画布上排整齐。返回移动了几个。 */
export function applyLayout(doc: TypographyDocument, req: LayoutRequest): number {
  const targets = pickTargets(doc, req.elementIds);
  if (targets.length === 0) return 0;

  if (req.op === 'align') {
    const rects = toRects(targets);
    const canvas: Rect = { id: 'canvas', x: 0, y: 0, w: doc.size.w, h: doc.size.h };
    const anchor = req.target === 'selection' && rects.length > 1 ? boundsOf(rects) : canvas;
    if (req.axis === 'distribute-h' || req.axis === 'distribute-v') {
      return applyDistribute(doc, targets, req.axis === 'distribute-h' ? 'h' : 'v');
    }
    const moves = alignElements(rects, anchor, req.axis);
    for (const el of targets) {
      const m = moves.get(el.id);
      if (!m) continue;
      el.frame.x = round2(m.x);
      el.frame.y = round2(m.y);
    }
    return moves.size;
  }

  if (req.op === 'distribute') return applyDistribute(doc, targets, req.axis);

  // grid / row / column：先算格子，再把元素中心放进去（尺寸保持不变）。
  const gap = Math.max(0, finite(req.gap, Math.round(Math.min(doc.size.w, doc.size.h) * 0.03)));
  const margin = Math.max(0, finite(req.margin, Math.round(Math.min(doc.size.w, doc.size.h) * 0.06)));
  const cols = req.op === 'grid'
    ? Math.max(1, Math.min(12, Math.round(finite(req.cols, Math.max(1, targets.length)))))
    : req.op === 'row' ? targets.length : 1;
  const rows = req.op === 'grid'
    ? Math.max(1, Math.min(24, Math.round(finite(req.rows, Math.ceil(targets.length / cols)))))
    : req.op === 'column' ? targets.length : 1;

  const maxW = Math.max(...targets.map((t) => t.frame.w));
  const maxH = Math.max(...targets.map((t) => t.frame.h));
  const availW = doc.size.w - margin * 2;
  const availH = doc.size.h - margin * 2;
  const cellW = req.op === 'row' ? (availW - gap * (targets.length - 1)) / targets.length : Math.min(maxW, (availW - gap * (cols - 1)) / cols);
  const cellH = req.op === 'column' ? (availH - gap * (targets.length - 1)) / targets.length : Math.min(maxH, (availH - gap * (rows - 1)) / rows);

  targets.forEach((el, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = margin + col * (cellW + gap) + cellW / 2;
    const cy = margin + row * (cellH + gap) + cellH / 2;
    el.frame.x = round2(cx - el.frame.w / 2);
    el.frame.y = round2(cy - el.frame.h / 2);
  });
  return targets.length;
}

function applyDistribute(doc: TypographyDocument, targets: TypographyElement[], axis: 'h' | 'v'): number {
  if (targets.length < 3) return 0;
  const moves = distribute(toRects(targets), axis);
  for (const el of targets) {
    const v = moves.get(el.id);
    if (v === undefined) continue;
    if (axis === 'h') el.frame.x = round2(v);
    else el.frame.y = round2(v);
  }
  return moves.size;
}

/* --------------------------------------------------------------- 文档级 */

export function setBackground(doc: TypographyDocument, paint: unknown): void {
  doc.background = coercePaint(paint);
}

export function setTheme(doc: TypographyDocument, id: string | null): void {
  if (id === null || id === '') delete doc.theme;
  else doc.theme = id;
}

/* --------------------------------------------------------------- 动画 */

/** 旧式关键帧输入（`at` 为 0..1 的动画进度；beat 由调用方先换算成进度）。 */
export interface AnimationKeysInput {
  at: number;
  opacity?: number;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  rot?: number;
  blur?: number;
}

/**
 * 结构化轨道的关键帧输入。
 *
 * `t` 是**相对片段起点的绝对秒**（与编辑器面板、文档模型同口径）——
 * 旧式的 `at`（0..1 进度）仍然收，但它只描述「一条动画内部的相对位置」，
 * 表达不了「位移 0.4s 才起步、淡入从 0s 开始」这种异步。
 */
export interface AnimationTrackKeyInput {
  t: number;
  /** 数值通道 number（px / 倍 / 度 / 0..1）；任意属性原始字符串。 */
  v: number | string;
  /**
   * 出向缓动（本帧 → 下一帧）：关键字 / `[x1,y1,x2,y2]` /
   * `{ steps: 4, jump: 'end' }` / 原文 `"steps(4, end)"`。`null` = 跟随条目 easing。
   */
  ease?: string | number[] | { steps: number; jump?: string } | null;
  /**
   * 关键帧的**标记色**（`#rrggbb`）—— 只给编辑器做记号，**不影响动画**。
   * 读回形状（`animationView`）会带上它，所以「读一遍再写回」不会丢。
   */
  color?: string;
}

/** 一条结构化轨道：**一个属性** + 一串绝对秒关键帧。 */
export interface AnimationTrackInput {
  /** 通道（x / y / sx / sy / rot / opacity / blur）或任意 CSS 属性名。 */
  prop: string;
  keys: AnimationTrackKeyInput[];
}

/**
 * 动画输入（`typo_set_animation` 的 `animation` 参数，与 `typo_add_element` 的
 * 同名子字段同构）。三种形态，**按优先级**：
 *
 *  - `css: '…'`（手写 CSS：一个或多个 `@keyframes` 块 + 一条 `animation` 简写；
 *    旧形态「只填一个 keyframes 体」也接受）。与编辑器弹窗同一套校验
 *    （`parseCustomCss`），所以两侧写出来的动画在文档里完全同构。
 *  - `{ prop, keys: [{ t, v, ease? }] }`（结构化轨道：**一条动画一个属性**，
 *    `t` 是绝对秒。想让几个属性异步起落就发**多条**动画，各带自己的时间）
 *  - `keys: [{ at, opacity, x, y, sx, sy, rot, blur }]`（旧式：按属性**拆成多条**
 *    轨道，`t = delay + at × duration` —— 与它当年逐字等价）
 *  - `preset: 'fade-in' | 'slide-in-left' | ...`（内置 14 个，同样展开成轨道）
 *
 * 都走项目已有的 CSS 动画系统（`typography/animation.ts`）：预览与导出对同一条
 * 动画求同一个时间，因此**动画在导出里是真的**，不是只在预览里演一遍。
 */
export interface AnimationInput {
  /**
   * 手写 CSS。只允许 `@keyframes` 块 + 一条顶层 `animation:` 声明（选择器 /
   * `@import` / `@charset` / `@namespace` 一律拒绝 —— 理由见
   * `animation.ts` 的 `CustomAnimation.css` 注释：注入点唯一、不许逃出元素）。
   */
  css?: string;
  /** 与 `css` 配套的简写值（等价于在 css 末尾写 `animation: …;`）。 */
  animation?: string;
  preset?: string;
  duration?: number;
  delay?: number;
  /** 播放次数：`'once'` / `'infinite'` / 正数。缺省 once。 */
  loop?: number | 'once' | 'infinite';
  /**
   * `loop` 的**读回别名**：`animationView` 回显的是 `iterations`，所以「读回来
   * 再写回去」必须认它。两个都给时 `loop` 优先。
   */
  iterations?: number | 'infinite';
  easing?: string | number[];
  direction?: string;
  fill?: string;
  /** 预设参数（slide 的 dist / zoom 的 z0,z1 / blur 的 blur）。 */
  params?: Record<string, number>;
  /**
   * 作用层：`'box'`（缺省，整个元素框，含文本框底板与边框）/ `'content'`
   * （只动文字 / 图形 / 图片本身）。
   *
   * 缺省是 `box`：模型说「给文本框设个旋转」时想的就是整块。只有明确要
   * 「只转字」时才传 `'content'` —— 旧工程里的动画由 schema v18 迁移显式钉成
   * `'content'`，不受这个缺省影响。
   */
  target?: string;
  /** 结构化轨道形态：`prop` + `keys[].t`（绝对秒）。 */
  prop?: string;
  /** 旧式形态：`keys[].at`（0..1）；两者按「有没有 `prop` / 有没有 `t`」判别。 */
  keys?: AnimationKeysInput[] | AnimationTrackKeyInput[];
}

const EASING_IDS = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']);
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const MAX_ANIM_KEYS = 20;

function timingOf(input: AnimationInput): Partial<AnimTiming> | null {
  const out: Partial<AnimTiming> = {};
  if (input.duration !== undefined) {
    if (!(Number(input.duration) > 0)) return null;
    out.duration = Number(input.duration);
  }
  if (input.delay !== undefined) out.delay = Math.max(0, Number(input.delay) || 0);
  // `iterations` 是 `animationView` 的读回名（写回时不能丢），`loop` 是工具面的名字。
  const loop = input.loop ?? input.iterations;
  if (loop !== undefined) {
    if (loop === 'infinite') out.iterations = Infinity;
    else if (loop === 'once') out.iterations = 1;
    else if (Number.isFinite(Number(loop)) && Number(loop) > 0) out.iterations = Number(loop);
    else return null;
  }
  if (input.easing !== undefined) {
    if (typeof input.easing === 'string' && EASING_IDS.has(input.easing)) out.easing = input.easing as Easing;
    else if (Array.isArray(input.easing) && input.easing.length === 4 && input.easing.every((n) => Number.isFinite(Number(n)))) {
      out.easing = input.easing.map(Number) as [number, number, number, number];
    } else return null;
  }
  if (input.direction !== undefined) {
    if (!DIRECTIONS.has(String(input.direction))) return null;
    out.direction = input.direction as AnimTiming['direction'];
  }
  if (input.fill !== undefined) {
    if (!FILLS.has(String(input.fill))) return null;
    out.fill = input.fill as AnimTiming['fill'];
  }
  // 作用层只认两个值：写错（`'element'` / `'text'`）时整条拒掉，而不是静默
  // 回落缺省 —— 后者表现成「设了只转字、结果整块飞了」，模型不会怀疑是拼写。
  //
  // `content` 也必须**显式写进对象**：schema v18 迁移靠它把旧工程的动画钉住，
  // 读回/写回（`animationView` → `parseAnimationInput`）也靠它往返。
  if (input.target !== undefined) {
    if (input.target !== 'content' && input.target !== 'box') return null;
    out.target = input.target;
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 关键帧列表 → `@keyframes` 体。
 *
 * 每一帧都写**全部**被用到的属性（缺的取恒等值），因为 CSS 只对「两端都出现」
 * 的属性做插值：只在首帧写 `transform` 的话，中间会从元素的基础样式插进来，
 * 而基础样式里有用户自己的旋转 —— 动画看起来会莫名其妙地「先歪一下」。
 */
export function keyframesFromKeys(keys: readonly AnimationKeysInput[]): string | null {
  if (keys.length < 2 || keys.length > MAX_ANIM_KEYS) return null;
  const used = {
    opacity: keys.some((k) => k.opacity !== undefined),
    transform: keys.some((k) => k.x !== undefined || k.y !== undefined || k.sx !== undefined || k.sy !== undefined || k.rot !== undefined),
    blur: keys.some((k) => k.blur !== undefined),
  };
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  const frames: string[] = [];
  for (const k of sorted) {
    if (!Number.isFinite(k.at)) return null;
    const pct = round3(Math.max(0, Math.min(1, k.at)) * 100);
    const decl: string[] = [];
    if (used.opacity) decl.push(`opacity:${round3(Math.max(0, Math.min(1, k.opacity ?? 1)))}`);
    if (used.transform) {
      const x = round3(k.x ?? 0);
      const y = round3(k.y ?? 0);
      const sx = round3(k.sx ?? 1);
      const sy = round3(k.sy ?? k.sx ?? 1);
      const rot = round3(k.rot ?? 0);
      decl.push(`transform:translate(${x}px,${y}px) scale(${sx},${sy}) rotate(${rot}deg)`);
    }
    if (used.blur) decl.push(`filter:blur(${round3(Math.max(0, k.blur ?? 0))}px)`);
    frames.push(`${pct}%{${decl.join(';')}}`);
  }
  return frames.join('');
}

/**
 * 输入 → 动画条目。**带原因的**解析结果：自定义 CSS 被拒时给出编辑器同一套
 * `CustomCssError`，调用方翻成文案回给模型（「花括号没配平」与「引用未定义的
 * 动画名」需要改的地方完全不同，只报一句「入参非法」等于让它瞎试）。
 */
export type AnimationParse =
  | {
      ok: true;
      /** 第一条（读接口兼容用）；多条轨道时用 `animations`。 */
      animation: ElementAnimation;
      animations: ElementAnimation[];
    }
  | { ok: false; reason?: CustomCssError };

/** `"steps(4, end)"` 的解析。合法性只在这一处定义（面板与 agent 同一条）。 */
const STEPS_RE = /^steps\(\s*(\d{1,3})\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/i;

function stepsOf(raw: unknown): StepEase | undefined {
  if (isRecord(raw)) {
    const n = Number(raw.steps);
    if (!Number.isFinite(n) || n < 1) return undefined;
    const jump = typeof raw.jump === 'string' ? raw.jump : undefined;
    if (jump && !STEPS_RE.test(`steps(1,${jump})`)) return undefined;
    return { steps: Math.min(999, Math.round(n)), ...(jump ? { jump: jump as StepEase['jump'] } : {}) };
  }
  if (typeof raw === 'string') {
    const m = STEPS_RE.exec(raw.trim());
    if (!m) return undefined;
    const steps = Math.round(Number(m[1]));
    if (!(steps >= 1)) return undefined;
    return { steps, ...(m[2] ? { jump: m[2].toLowerCase() as StepEase['jump'] } : {}) };
  }
  return undefined;
}

/** 缓动输入 → `TrackEase`。`null` = 用条目自己的；`undefined` = 非法。 */
function easeOf(raw: unknown): TrackEase | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && EASING_IDS.has(raw)) return raw as Easing;
  if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => Number.isFinite(Number(n)))) {
    return raw.map(Number) as [number, number, number, number];
  }
  // 阶梯：对象 `{ steps: 4, jump: 'end' }` 或原文 `"steps(4, end)"` 都收。
  const step = stepsOf(raw);
  if (step) return step;
  return undefined;
}

/**
 * 结构化轨道的关键帧数组。
 *
 * 两种时间都收：`t`（绝对秒）优先，缺 `t` 时用 `at`（0..1）按条目的
 * `delay + at × duration` 换算 —— 模型常常「照旧例填 at」，直接拒掉只会让它
 * 在下一轮换个写法再试，而它永远猜不到「这里要的是绝对秒」。
 */
function parseTrackKeys(raw: unknown[], timing: Partial<AnimTiming>): TrackKey[] | null {
  if (raw.length < 2 || raw.length > MAX_ANIM_KEYS) return null;
  const delay = timing.delay ?? 0;
  const duration = timing.duration ?? 0.6;
  const out: TrackKey[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const absolute = Number(item.t);
    const t = Number.isFinite(absolute)
      ? Math.max(0, absolute)
      : delay + Math.max(0, Math.min(1, finite(item.at, 0))) * duration;
    const v = item.v;
    if (typeof v !== 'string' && !Number.isFinite(Number(v))) return null;
    const ease = easeOf(item.ease);
    if (ease === undefined) return null;
    // 标记色是可选的**纯展示**字段：坏值直接丢（不因此整条拒绝 —— 它不影响画面）。
    const color = normalizeKeyColor(item.color);
    out.push({
      t,
      v: typeof v === 'string' ? v : Number(v),
      ...(ease ? { ease } : {}),
      ...(color ? { color } : {}),
    });
  }
  return out;
}

/**
 * 旧式 `keys`（一个数组里同时给 opacity / x / y / …）→ **每个属性一条轨道**。
 *
 * 时间换算 `t = delay + at × duration` 与它当年的 `@keyframes` 百分比逐字等价。
 * `sx` / `sy` 缺一条时按另一条补齐（旧实现里 `scale(sx, sy ?? sx)` 就是这个语义），
 * 否则「只传 sx」会从「等比缩放」变成「只缩 X」。
 */
function tracksFromLegacyKeys(
  keys: AnimationKeysInput[],
  timing: Partial<AnimTiming>,
): ElementAnimation[] {
  const delay = timing.delay ?? 0;
  const duration = timing.duration ?? 0.6;
  const at = (k: AnimationKeysInput): number => delay + Math.max(0, Math.min(1, k.at)) * duration;
  const props: AnimChannel[] = ['opacity', 'x', 'y', 'sx', 'sy', 'rot', 'blur'];
  const want = new Set<AnimChannel>();
  for (const prop of props) if (keys.some((k) => k[prop] !== undefined)) want.add(prop);
  if (want.has('sx') || want.has('sy')) {
    want.add('sx');
    want.add('sy');
  }
  const out: ElementAnimation[] = [];
  for (const prop of props) {
    if (!want.has(prop)) continue;
    const trackKeys: TrackKey[] = keys.map((k) => {
      const raw =
        prop === 'sx' ? (k.sx ?? k.sy) : prop === 'sy' ? (k.sy ?? k.sx) : k[prop];
      return { t: at(k), v: raw === undefined ? identityValue(prop) : (raw as number) };
    });
    out.push(createTracksAnimation(newId(), prop, trackKeys, timing));
  }
  return out;
}

export function parseAnimationInput(raw: unknown): AnimationParse {
  if (!isRecord(raw)) return { ok: false };
  const input = raw as AnimationInput;
  // 形状先过一遍：`css` 存在时它是唯一定义来源，keys / preset / params 一并忽略。
  if (input.css !== undefined && typeof input.css !== 'string') return { ok: false };
  const timing = timingOf(input);
  if (!timing) return { ok: false };
  const single = (animations: ElementAnimation[]): AnimationParse =>
    animations.length ? { ok: true, animation: animations[0]!, animations } : { ok: false };

  if (typeof input.css === 'string') {
    let text = input.css;
    if (typeof input.animation === 'string' && input.animation.trim()) {
      /*
       * 单独的 `animation` 字段只在 css 里没写简写时拼进去。两处都写会解析出
       * 两条 `animation` 声明，那在 parseMultiCss 里是明确的错误 —— 而模型很
       * 可能「照编辑器预览的样子」两处都填。
       */
      const alone = parseCustomCss(text);
      if (!(alone.ok && alone.animation)) text = `${text}\nanimation: ${input.animation.trim()};`;
    }
    const parsed = parseCustomCss(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return single([
      createCustomAnimation(newId(), parsed.css, {
        ...timing,
        ...(parsed.animation ? { animation: parsed.animation } : {}),
      }),
    ]);
  }

  // 结构化轨道：`prop` 决定「这条动画动的是哪个属性」。
  if (typeof input.prop === 'string' && Array.isArray(input.keys)) {
    const keys = parseTrackKeys(input.keys, timing);
    const prop = input.prop.trim();
    if (!keys || !prop) return { ok: false };
    return single([createTracksAnimation(newId(), prop, keys, timing)]);
  }

  if (Array.isArray(input.keys) && input.keys.length > 0) {
    // 走到这里说明没有 `prop`（上面那条已经消费了带 prop 的形态），所以是旧式字段。
    const keys: AnimationKeysInput[] = (input.keys as AnimationKeysInput[])
      .filter(isRecord)
      .map((k) => ({
        at: finite(k.at, 0),
        ...(k.opacity === undefined ? {} : { opacity: finite(k.opacity, 1) }),
        ...(k.x === undefined ? {} : { x: finite(k.x, 0) }),
        ...(k.y === undefined ? {} : { y: finite(k.y, 0) }),
        ...(k.sx === undefined ? {} : { sx: finite(k.sx, 1) }),
        ...(k.sy === undefined ? {} : { sy: finite(k.sy, 1) }),
        ...(k.rot === undefined ? {} : { rot: finite(k.rot, 0) }),
        ...(k.blur === undefined ? {} : { blur: finite(k.blur, 0) }),
      }));
    // 单帧列表当年就是非法的（没有插值区间），保持这条口径。
    if (keys.length < 2 || keys.length > MAX_ANIM_KEYS) return { ok: false };
    return single(tracksFromLegacyKeys(keys, timing));
  }

  if (typeof input.preset === 'string' && isPresetId(input.preset)) {
    const def = ANIM_PRESETS.find((d) => d.id === input.preset);
    const params = { ...(def?.params ?? {}), ...(input.params ?? {}) };
    // 预设**直接展开成轨道**：面板只编辑结构化数据，留一个 preset kind 会让
    // 「刚加的动画改不了值」成为常态（用户 2026-10-24 定的「打开即迁移」同理）。
    const report: MigrationReport = { dropAnimations: [], dropProps: [] };
    const tracks = presetToTracks(
      createPresetAnimation(input.preset, newId(), {
        ...timing,
        ...(Object.keys(params).length ? { params } : {}),
      }),
      report,
    );
    return single(tracks);
  }
  return { ok: false };
}

/** 输入 → 动画条目（多条轨道时取第一条）。不合法返回 null。 */
export function animationFromInput(raw: unknown): ElementAnimation | null {
  const parsed = parseAnimationInput(raw);
  return parsed.ok ? parsed.animation : null;
}

/** 输入 → **全部**动画条目（一条输入可能展开成多个属性轨道）。 */
export function animationsFromInput(raw: unknown): ElementAnimation[] | null {
  const parsed = parseAnimationInput(raw);
  return parsed.ok ? parsed.animations : null;
}

/**
 * 读回形状（写操作回显 / 文档视图共用）。
 *
 * **必须能被 `parseAnimationInput` 原样读回**：`typo_replace_doc` 的整份往返
 * 依赖这一点。字段名因此同时认两套（`iterations` 是这里的名字，`loop` 是工具面
 * 的名字），自定义动画的 `css` / `animation` 也是原样给出。
 */
export function animationView(a: ElementAnimation): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    // 作用层**总是**输出（含缺省值）：`content` 是旧工程迁移后的显式状态，
    // 省略它再写回就会落回缺省的 `box` —— 老工程打开一次、动一下别处，动画
    // 就会从「只转字」变成「整块转」。
    target: animTargetOf(a),
    ...(a.kind === 'preset' ? { preset: a.preset, ...(a.params ? { params: a.params } : {}) } : {}),
    ...(a.kind === 'custom' ? { css: a.css, ...(a.animation ? { animation: a.animation } : {}) } : {}),
    // 结构化轨道：**原样**给出 `prop` + 绝对秒关键帧，`parseAnimationInput` 能读回。
    // `ease` 显式写 null（缺省 = 继承条目 easing）—— 省略它读回时也等价，但显式
    // 更容易让模型看出「这一段是默认缓动」。
    ...(a.kind === 'tracks'
      ? {
          prop: a.prop,
          // `color` 是**标记色**（只给编辑器做记号），但它必须原样读回 ——
          // 少了它，「读一遍再写回」会把用户标好的关键帧颜色全抹掉。
          keys: a.keys.map((k) => ({
            t: k.t,
            v: k.v,
            ease: k.ease ?? null,
            ...(k.color ? { color: k.color } : {}),
          })),
        }
      : {}),
    duration: a.duration,
    delay: a.delay,
    iterations: a.iterations === Infinity ? 'infinite' : a.iterations,
    easing: a.easing,
    direction: a.direction,
    fill: a.fill,
  };
}

/* --------------------------------------------------------------- 视图 */

export interface DocViewOptions {
  detail: 'ids' | 'full';
}

function elementView(el: TypographyElement): Record<string, unknown> {
  const base = {
    id: el.id,
    kind: el.kind,
    name: el.name,
    frame: { ...el.frame },
    blend: el.blend,
    opacity: el.opacity,
    visible: el.visible,
    locked: el.locked,
    ...(el.groupId ? { groupId: el.groupId } : {}),
    // 动画给**可复述的完整字段**（预设名 / 关键帧 / CSS / 时序）：只给 kind+duration
    // 的话模型读不回来自己设过什么，只能再猜一次。
    ...((el.animations ?? []).length ? { animations: (el.animations ?? []).map(animationView) } : {}),
    // 阴影 / 虚化 / 3D 对所有元素成立，放在公共部分。
    ...(el.shadows?.length ? { shadows: el.shadows } : {}),
    ...(el.blur ? { blur: el.blur } : {}),
    ...(el.transform3d ? { transform3d: el.transform3d } : {}),
    // 景深只在真设过时回显：0 与「没设过」渲染等价，铺开它只会让每个元素
    // 都带一个 depth:0，整份文档读回来全是噪声。
    ...(el.depth ? { depth: el.depth } : {}),
  };
  if (el.kind === 'text') {
    return {
      ...base,
      text: plainTextOf(el.runs),
      /*
       * `runs` 只在**真有行内覆盖**时给：没有覆盖时 `text` 已经能原样重建同一份
       * runs（`runsFromText`），铺开它只会白烧上下文。反过来，有覆盖却不给
       * runs，就等于「读一次再写回」把加粗 / 高亮整段抹掉。
       */
      ...(hasSpanOverrides(el.runs) ? { runs: el.runs.map((r) => ({ ...r, ...(r.style ? { style: { ...r.style } } : {}) })) } : {}),
      style: { ...el.style },
      autoHeight: el.autoHeight,
      ...(el.fill ? { fill: el.fill } : {}),
      ...(el.boxFill ? { boxFill: el.boxFill } : {}),
      ...(el.boxStroke ? { boxStroke: el.boxStroke } : {}),
      // 字形描边只用于文本（图形有自己的 stroke），与 boxStroke 并列但含义不同。
      ...(el.glyphStroke ? { glyphStroke: el.glyphStroke } : {}),
    };
  }
  if (el.kind === 'shape') {
    return {
      ...base,
      shape: el.shape,
      fill: el.fill,
      stroke: el.stroke,
      /*
       * `path` 只给**手写 / 文本转路径**的图形。生成器元素（`gen` 存在）的 path
       * 可能是上千条命令，而它本来就能用 `gen.params` 复现 —— 回显它只会白烧
       * 上下文。反过来，手写的 path 不回显就等于「读一次再写回去就丢了」。
       */
      ...(el.path && !el.gen ? { path: el.path } : {}),
      ...(el.pathUnit === 'px' ? { pathUnit: 'px' } : {}),
      ...(el.clipFrame ? { clipFrame: true } : {}),
      ...(el.radius !== undefined ? { radius: el.radius } : {}),
      ...(el.sides !== undefined ? { sides: el.sides } : {}),
      ...(el.waist !== undefined ? { waist: el.waist } : {}),
      ...(el.inner !== undefined ? { inner: el.inner } : {}),
      ...(el.angle !== undefined ? { angle: el.angle } : {}),
      ...(el.evenOdd ? { evenOdd: true } : {}),
      ...(el.gen ? { gen: el.gen } : {}),
      // 图片填充（「裁剪为形状」的产物）：不给的话「读一次再写回」会把图丢了。
      ...(el.imageFill ? { imageFill: { ...el.imageFill } } : {}),
    };
  }
  return {
    ...base,
    assetId: el.assetId,
    fit: el.fit,
    ...(el.crop ? { crop: el.crop } : {}),
    // 抠图 / 四角：与片段同名字段、同一套语义（缺省 = 没开）。
    ...(el.key ? { key: el.key } : {}),
    ...(el.quad ? { quad: el.quad } : {}),
    ...(el.radius !== undefined ? { radius: el.radius } : {}),
    // 色彩校正 / 重新着色 / 边框 / 滤镜：缺省 = 没开。
    ...(el.adjust ? { adjust: el.adjust } : {}),
    ...(el.recolor ? { recolor: el.recolor } : {}),
    ...(el.border ? { border: el.border } : {}),
    ...(el.filter ? { filter: el.filter } : {}),
  };
}

/**
 * 单个元素的 full 视图。
 *
 * 写操作的返回值用它**回显改后的值**：`{ changed: true }` 让 agent 必须再读
 * 整份文档（或渲一张图）才能确认改动落地，而一次 `typo_update_element` 的
 * 意图往往只是「把这三个字段改成我给的数」。读回一个元素是几十到几百 token，
 * 读回整份文档是几千。
 */
export function elementViewById(doc: TypographyDocument, id: string): Record<string, unknown> | null {
  const el = elementById(doc, id);
  return el ? elementView(el) : null;
}

/**
 * 文档视图。
 *
 * `ids` 只给 id / 类型 / 名字 / 框 —— 二十个元素的完整样式（渐变 + 阴影 +
 * 富文本）能上万 token。agent 先探路，再对具体元素取 `full`。
 */
export function docView(
  doc: TypographyDocument,
  clipId: string,
  detail: 'ids' | 'full',
): {
  clipId: string;
  size: { w: number; h: number };
  theme: string | null;
  /** 镜头。**恒等在两者都省掉**（读回形状与「没设过」等价）。 */
  camera?: unknown;
  background?: unknown;
  elements: unknown[];
  groups?: unknown[];
  fonts?: { family: string; format: string }[];
  /** `ids` 档给数量，`full` 档给完整脚本表（可原样写回）。 */
  scripts?: unknown;
} {
  /*
   * 字段兜底（`?? []`）不是防御性冗余：`fonts` / `elements` 在**类型上是必填**，
   * 但手改过的 JSON、以及更早版本的文档里确实会缺 —— 缺一个就让整个 `full` 档
   * 抛 `internal`，agent 于是完全看不到文档内容（这条是实际发生过的）。
   */
  const elements = Array.isArray(doc.elements) ? doc.elements : [];
  // 镜头是 4 个数字，两档都给：否则 agent 看不出「为什么画面被推近过」，
  // 只能拿一张截图反推。恒等时省略（省略 = 复位到没有镜头）。
  const camera = doc.camera && !cameraIsIdentity(doc.camera) ? { camera: { ...doc.camera } } : {};
  // 镜头关键帧：只给**有帧**的通道（空轨道是面板的显示细节，不该进读回形状）。
  const camKeys = cameraKeysMap(doc);
  const cameraTracks = Object.keys(camKeys).length ? { cameraTracks: camKeys } : {};
  if (detail === 'ids') {
    return {
      clipId,
      size: { w: doc.size.w, h: doc.size.h },
      theme: doc.theme ?? null,
      ...camera,
      ...cameraTracks,
      elements: elements.map((e) => ({
        id: e.id,
        kind: e.kind,
        name: e.name,
        frame: { ...e.frame },
        ...(e.depth ? { depth: e.depth } : {}),
      })),
      // ids 档只给数量：一段脚本两三百行，探路阶段不需要它的正文。
      scripts: (doc.scripts ?? []).length,
    };
  }
  return {
    clipId,
    size: { w: doc.size.w, h: doc.size.h },
    theme: doc.theme ?? null,
    ...camera,
    ...cameraTracks,
    background: doc.background ?? { kind: 'none' },
    elements: elements.map(elementView),
    groups: groupList(doc).map((g) => ({ ...g })),
    fonts: (doc.fonts ?? []).map((f) => ({ family: f.family, format: f.format })),
    // 完整脚本表：字段名与 `sanitizeScripts` 的输入一致，读回可以直接写回。
    scripts: scriptsView(doc),
  };
}

/** 单条脚本的读回形状（可原样写回 `typo_set_scripts` / `typo_replace_doc`）。 */
export function scriptView(s: TypographyScript): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    code: s.code,
    enabled: s.enabled,
    ...(s.targets?.length ? { targets: [...s.targets] } : {}),
    ...(s.needs?.length ? { needs: [...s.needs] } : {}),
  };
}

/** 整份脚本表的读回形状。 */
export function scriptsView(doc: TypographyDocument): Record<string, unknown>[] {
  return (doc.scripts ?? []).map(scriptView);
}

/* --------------------------------------------------------------- 整份替换 */

/**
 * 把不可信的 JSON 收成一份合法文档。
 *
 * **永不抛**（与 `pattern-codec` 同一条纪律）：agent 生成的文档结构可能整段错位，
 * 而「工程打不开」比「文档少几个元素」严重得多。坏元素整条丢弃，坏字段回落默认。
 */
export interface CoerceReport {
  /**
   * 被丢掉的**未知键**（`doc.foo` / `elements[2].bar`）。
   *
   * 为什么要报：`typo_replace_doc` 的约定是「坏元素丢弃、坏字段回落」，但模型
   * 分不清「我写错了键名」和「这个字段生效了」。静默归一化的结果是它照着一份
   * 自己以为对的文档继续往下做，直到某次渲染对不上才回头。
   */
  droppedKeys: string[];
  /**
   * 被丢掉的**动画条目**（`elements[2].animations[0]`）。
   *
   * 与 `droppedKeys` 分开报：动画条目是合法的键、只是内容不合法（比如猜错预设名），
   * 混进「未知键」会让模型以为字段名写错了。不报的话表现是「文档写进去了、
   * 动画没了」，而模型会照着那份「看起来成功」的回执继续做。
   */
  droppedAnimations: string[];
}

/*
 * `clipId` 是**读侧的回显字段**（`docView` 会给），整份往返时原样带回来。
 * 不接受它的话，「读回来 → 直接写回」这条被文档承诺的路径会每次都报一个
 * `clipId` 未知键 —— 模型会以为自己写错了什么。
 */
const DOC_KEYS = new Set([
  'clipId',
  'size',
  'background',
  'elements',
  'fonts',
  'groups',
  'theme',
  'scripts',
  'camera',
  // 镜头关键帧的读回形状（通道 → 关键帧）。放进白名单才能「读回 → 原样写回」。
  'cameraTracks',
  // 文档级动画的内部形状（整份文档搬运时会出现；与 cameraTracks 同义）。
  'animations',
]);
const ELEMENT_KEYS = new Set([
  'id', 'kind', 'name', 'frame', 'blend', 'opacity', 'visible', 'locked', 'animations',
  'shadows', 'blur', 'groupId', 'transform3d', 'depth',
]);
/*
 * 白名单**必须是「实现真的会读」的键**：放进来却不处理，等于把这些键变成
 * 静默丢弃（`runs` / `natural` 就是这么躺了一阵的）。写不了的字段宁可报出来。
 */
const KIND_KEYS: Record<string, string[]> = {
  text: ['text', 'runs', 'style', 'fill', 'boxFill', 'boxStroke', 'glyphStroke', 'autoHeight'],
  shape: ['shape', 'path', 'pathUnit', 'clipFrame', 'fill', 'stroke', 'radius', 'sides', 'waist', 'inner', 'angle', 'evenOdd', 'gen', 'imageFill'],
  image: ['assetId', 'fit', 'crop', 'radius', 'key', 'quad', 'adjust', 'recolor', 'border', 'filter'],
};

/** 把一个元素输入里「不认识的键」记进 report（按 kind 的白名单）。 */
function noteUnknownKeys(item: Record<string, unknown>, kind: string, at: number, report?: CoerceReport): void {
  if (!report) return;
  const allowed = new Set([...ELEMENT_KEYS, ...(KIND_KEYS[kind] ?? [])]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) report.droppedKeys.push(`elements[${at}].${key}`);
  }
}

/**
 * 镜头关键帧的输入 → `TrackKey[]`。一条通道至少 1 帧（元素轨道的「至少 2 帧」
 * 不适用于它：单帧镜头就是「从这一帧起固定取景」）。
 */
export function coerceCameraKeys(raw: unknown): TrackKey[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANIM_KEYS) return null;
  const out: TrackKey[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const t = Number(item.t);
    const v = Number(item.v);
    if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
    const ease = easeOf(item.ease);
    if (ease === undefined) return null; // 给了但认不出 —— 报错胜过静默线性
    const key: TrackKey = { t: Math.max(0, t), v };
    if (ease) key.ease = ease;
    const color = normalizeKeyColor(item.color);
    if (color) key.color = color;
    out.push(key);
  }
  return normalizeKeys(out);
}

/**
 * 镜头轨道输入 → 文档级 `TracksAnimation[]`。**永不抛**（坏通道整条丢弃）。
 *
 * 两种形状都收：读回形状 `{ x: keys[], zoom: keys[] }` 与内部形状
 * `[{ prop: 'camera.x', keys: [...] }]`。前者是 agent 该用的，后者是
 * 「整份文档搬运」的路径 —— 只认一种的形态是「读回来的文档写不回去」。
 */
function coerceCameraTracks(raw: unknown): TracksAnimation[] | undefined {
  if (raw === null) return [];
  const out: TracksAnimation[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || !isCameraChannel(String(item.prop))) continue;
      const keys = coerceCameraKeys(item.keys);
      const key = cameraKeyOf(String(item.prop));
      if (!keys || !key) continue;
      out.push(createCameraTrack(key, keys));
    }
  } else if (isRecord(raw)) {
    for (const prop of CAMERA_CHANNELS) {
      const key = cameraKeyOf(prop)!;
      const keys = coerceCameraKeys(raw[key]);
      if (keys) out.push(createCameraTrack(key, keys));
    }
  } else {
    return undefined; // 形状不认识：保留原有轨道，别把用户的动画抹掉
  }
  // 一个通道最多一条：后者覆盖前者（与 `setCameraTrack` 同一口径）。
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(t.prop) ? false : (seen.add(t.prop), true)));
}

export function coerceDocument(
  raw: unknown,
  fallback: TypographyDocument,
  report?: CoerceReport,
): TypographyDocument {
  if (!isRecord(raw)) return fallback;
  if (report) {
    for (const key of Object.keys(raw)) {
      if (!DOC_KEYS.has(key)) report.droppedKeys.push(key);
    }
  }
  const sizeRaw = isRecord(raw.size) ? raw.size : {};
  const size = {
    w: Math.max(2, Math.round(finite(sizeRaw.w, fallback.size.w))),
    h: Math.max(2, Math.round(finite(sizeRaw.h, fallback.size.h))),
  };
  /*
   * 脚本表：
   *  - `scripts === undefined` → **保留原脚本**（老客户端 / 精简写入不该把
   *    用户写的代码抹掉；与 `animations` 同一类「读回再写回必须无损」）；
   *  - `scripts: []` → 显式清空；
   *  - 其余 → 过 `sanitizeScripts`（永不抛，坏条目进 droppedKeys）。
   */
  let scripts: TypographyScript[] | undefined = fallback.scripts;
  if (raw.scripts !== undefined) {
    if (Array.isArray(raw.scripts)) {
      const sanitized = sanitizeScripts(raw.scripts);
      scripts = sanitized.scripts;
      if (report) report.droppedKeys.push(...sanitized.dropped);
    } else {
      report?.droppedKeys.push('scripts');
    }
  }

  /*
   * 镜头：`undefined` → 保留原镜头（与 `scripts` 同一条「精简写入不该抹掉
   * 用户设过的东西」）；`null` → 显式清掉；对象 → 与恒等值合并。
   */
  const camera =
    raw.camera === undefined
      ? fallback.camera
      : raw.camera === null
        ? null
        : coerceCamera(raw.camera);

  /*
   * 镜头关键帧：读回给的是 `cameraTracks`（通道 → 关键帧），写回同一个形状。
   * `undefined` → 保留原有轨道（与 camera / scripts 同一条纪律）；`null` → 清空。
   * 也接受内部形状 `animations`（直接搬运整份文档时用），两份都给时 `cameraTracks` 优先。
   */
  const animations =
    raw.cameraTracks !== undefined
      ? coerceCameraTracks(raw.cameraTracks)
      : raw.animations !== undefined
        ? coerceCameraTracks(raw.animations)
        : fallback.animations;

  const doc: TypographyDocument = {
    size,
    background: coercePaint(raw.background, { kind: 'none' }),
    elements: [],
    fonts: [],
    groups: [],
    ...(typeof raw.theme === 'string' ? { theme: raw.theme } : {}),
    ...(scripts && scripts.length ? { scripts } : {}),
    ...(camera && !cameraIsIdentity(camera) ? { camera } : {}),
    ...(animations && animations.length ? { animations } : {}),
  };

  const style0 = defaultTextStyle(size);
  const seen = new Set<string>();
  const rawEls = Array.isArray(raw.elements) ? raw.elements : [];
  for (const [at, item] of rawEls.entries()) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' && item.id.trim() && !seen.has(item.id) ? item.id : newId();
    seen.add(id);
    const kind = item.kind;
    noteUnknownKeys(item, String(kind), at, report);
    const frame = isRecord(item.frame) ? (item.frame as Record<string, unknown>) : {};
    const animations: ElementAnimation[] = [];
    if (Array.isArray(item.animations)) {
      for (const [ai, rawAnim] of item.animations.entries()) {
        const parsed = parseAnimationInput(rawAnim);
        if (parsed.ok) animations.push(...parsed.animations);
        else report?.droppedAnimations.push(`elements[${at}].animations[${ai}]`);
      }
    }
    const t3 = isRecord(item.transform3d) ? coerceTransform3D(item.transform3d) : null;
    const common = {
      id,
      frame: commonFrame(size, frame),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.blend === 'string' && MIX_BLEND_IDS.has(item.blend)
        ? { blend: item.blend as TypographyElement['blend'] }
        : {}),
      ...(Number.isFinite(Number(item.opacity)) ? { opacity: Math.max(0, Math.min(1, Number(item.opacity))) } : {}),
      ...(item.visible === false ? { visible: false } : {}),
      ...(item.locked === true ? { locked: true } : {}),
      // 3D 与阴影 / 虚化一样是公共字段；缺省 = 没有（不写键）。
      ...(t3 ? { transform3d: t3 } : {}),
      // 景深：整份替换必须一起搬（漏了就是「读一遍再写回，分层没了」）。
      ...(Number.isFinite(Number(item.depth)) && Number(item.depth) > 0
        ? { depth: Math.max(0, Math.min(1, Number(item.depth))) }
        : {}),
      // 动画必须一起搬过去：`typo_replace_doc` 如果把动画静默丢掉，
      // 「先写动画、再整份替换」就会在没有任何提示的情况下变成静止画面。
      ...(animations.length ? { animations } : {}),
    };
    if (kind === 'text') {
      const el = createTextElement(size, {
        ...common,
        text: typeof item.text === 'string' ? item.text : '',
      });
      el.style = { ...style0 };
      if (isRecord(item.style)) applyTextStylePatch(el.style, item.style);
      if (item.fill !== undefined) applyTextFill(el, item.fill);
      if (item.boxFill !== undefined) el.boxFill = coercePaint(item.boxFill);
      if (item.boxStroke !== undefined) setTextBoxStroke(el, item.boxStroke);
      if (item.glyphStroke !== undefined) setGlyphStroke(el, item.glyphStroke);
      if (item.autoHeight !== undefined) el.autoHeight = Boolean(item.autoHeight);
      // 富文本：`runs` 比 `text` 更精确（带行内覆盖），两者都在时以它为准。
      if (item.runs !== undefined) {
        const runs = coerceRuns(item.runs);
        if (runs) el.runs = runs;
      }
      doc.elements.push(el);
    } else if (kind === 'shape' && isShapeKind(item.shape)) {
      const el = createShapeElement(size, item.shape, {
        ...common,
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        /*
         * 路径坐标系必须一起搬：`pathUnit:'px'` 的路径（文本转路径的产物）落到
         * 默认的 0..100 上会被非等比拉伸，描边变成一边粗一边细。
         */
        ...(item.pathUnit === 'px' ? { pathUnit: 'px' as const } : {}),
        ...(item.clipFrame === true ? { clipFrame: true } : {}),
        ...(item.evenOdd === true ? { evenOdd: true } : {}),
      });
      if (item.fill !== undefined) el.fill = coercePaint(item.fill, el.fill);
      else if (item.stroke !== undefined && item.stroke !== null) el.fill = { kind: 'none' };
      if (item.stroke !== undefined) el.stroke = coerceStroke(item.stroke, el.stroke);
      if (Number.isFinite(Number(item.radius))) el.radius = Math.max(0, Number(item.radius));
      if (Number.isFinite(Number(item.sides))) el.sides = Math.max(3, Math.min(64, Math.round(Number(item.sides))));
      if (Number.isFinite(Number(item.waist))) el.waist = Math.max(0.02, Math.min(1, Number(item.waist)));
      if (Number.isFinite(Number(item.inner))) el.inner = Math.max(0, Number(item.inner));
      if (Number.isFinite(Number(item.angle))) el.angle = Number(item.angle);
      const imageFill = coerceImageFill(item.imageFill);
      if (imageFill) el.imageFill = imageFill;
      doc.elements.push(el);
    } else if (kind === 'image' && typeof item.assetId === 'string' && item.assetId) {
      const el = createImageElement(size, item.assetId, { ...common });
      if (typeof item.fit === 'string' && ['fill', 'contain', 'cover', 'none'].includes(item.fit)) {
        el.fit = item.fit as ImageElement['fit'];
      }
      if (isRecord(item.crop)) {
        el.crop = {
          x: Math.max(0, Math.min(1, finite(item.crop.x, 0))),
          y: Math.max(0, Math.min(1, finite(item.crop.y, 0))),
          w: Math.max(0.01, Math.min(1, finite(item.crop.w, 1))),
          h: Math.max(0.01, Math.min(1, finite(item.crop.h, 1))),
        };
      }
      // 抠图 / 四角与片段同名字段：整份替换时一起搬，否则「读一次再写回」会丢。
      const key = item.key === undefined ? null : coerceKeySettings(item.key);
      if (key) el.key = key;
      const quad = item.quad === undefined ? null : coerceQuadCorners(item.quad);
      if (quad) el.quad = quad;
      // 色彩校正 / 重新着色 / 边框 / 滤镜：同一批「缺省 = 没开」的可选字段。
      const adjust = item.adjust === undefined ? null : coerceImageAdjust(item.adjust);
      if (adjust) el.adjust = adjust;
      const recolor = item.recolor === undefined ? null : coerceImageRecolor(item.recolor);
      if (recolor) el.recolor = recolor;
      const border = item.border === undefined ? null : coerceImageBorder(item.border);
      if (border) el.border = border;
      const filter = item.filter === undefined ? null : coerceImageFilter(item.filter);
      if (filter) el.filter = filter;
      doc.elements.push(el);
    }
  }

  // 字体引用只保留格式合法的那些（字形子集化需要它）。
  const rawFonts = Array.isArray(raw.fonts) ? raw.fonts : [];
  for (const f of rawFonts) {
    if (!isRecord(f) || typeof f.family !== 'string') continue;
    const format = f.format === 'woff2' || f.format === 'woff' ? f.format : 'sfnt';
    doc.fonts.push({ id: typeof f.id === 'string' ? f.id : f.family, family: f.family, format, source: { kind: 'builtin' } });
  }
  return doc;
}

function commonFrame(
  size: { w: number; h: number },
  raw: Record<string, unknown>,
): TextureFrame {
  const w = clampSize(raw.w, Math.round(size.w * 0.5));
  const h = clampSize(raw.h, Math.round(size.h * 0.15));
  return {
    x: round2(finite(raw.x, Math.round((size.w - w) / 2))),
    y: round2(finite(raw.y, Math.round((size.h - h) / 2))),
    w,
    h,
    rot: finite(raw.rot, 0),
  };
}

/* --------------------------------------------------------------- 默认值导出 */

/** 常用留白 / 安全区（agent 给它「按边距排版」时不用自己猜数字）。 */
export function defaultMargin(doc: TypographyDocument): number {
  return Math.round(Math.min(doc.size.w, doc.size.h) * 0.06);
}
