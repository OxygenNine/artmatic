/**
 * typography.ts — 控制平面的**排版文档操作**（写时间轴上的文本片段内容）。
 *
 * 与 `ui/typography/actions.ts` 的区别：那边输入是「当前选择集 + Ribbon 控件」，
 * 这边输入是「明确的元素 id + 完整参数」。两者共用 `typography/agent-ops.ts`
 * 的工厂与几何函数，所以 agent 做出来的文档与手点出来的是同构的。
 *
 * ## 纪律
 *
 * 1. **每一笔写操作只产生一笔撤销**（`store.commit` 一次）。
 * 2. **校验前置**：参数不合法时在改动之前抛 `ControlFailure`，绝不半途修改。
 * 3. **不 import `ui/`**：`findTextDoc` 已经从 `editor-state` 下沉到
 *    `typography/agent-ops.ts`，那边只保留一个转导出。
 * 4. 写之前宿主会调 `ctx.stopTextEditing()`（见 control-plane 的 `beforeWrite`）
 *    —— 否则正在打的字会在下一次编辑器提交时把 agent 的改动覆盖掉。
 */

import { newId } from '../core/schema';
import { coerceKeySettings, coerceQuadCorners } from '../core/image-fx';
import {
  coerceImageAdjust,
  coerceImageBorder,
  coerceImageFilter,
  coerceImageRecolor,
} from '../typography/image-effects';
import type { ProjectStore } from '../core/project-store';
import {
  SHAPE_KINDS,
  cameraIsIdentity,
  coerceCameraPatch,
  coerceTransform3DPatch,
  mergeCamera,
  type Camera,
  type ElementShadow,
  type TextElement,
  type TypographyDocument,
  type TypographyElement,
} from '../typography/document';
import { setCameraTrack, type CameraKey } from '../typography/camera-tracks';
import type { TrackKey } from '../typography/animation-tracks';
// 只取类型：`text-outline.ts` 拉 `render-dom`，值导入会把 DOM 依赖带进控制平面。
import type { TextOutlineItem } from '../typography/text-outline';
import {
  applyBoolean,
  applyDivide,
  applyTextToPath,
  convertShapeToPath,
} from '../typography/shape-convert';
import { applyElementAnimations, applyElementFormat } from '../typography/format-painter';
import type { MessageKey } from '../i18n/locales';
import { CUSTOM_CSS_ERROR_KEYS } from '../typography/animation';
import { coerceRuns } from '../typography/rich-text';
import { sanitizeScripts } from '../typography/script/model';
import { checkScriptSyntax } from '../typography/script/compile';
import {
  isKnownTheme,
  mergeThemeColors,
  themeById,
  themeDisplayName,
  themeIds,
  type TypographyTheme,
} from '../typography/theme';
import {
  addGeneratedShape,
  addImageElement,
  addShapeElement,
  addTextElement,
  applyLayout,
  coerceCameraKeys,
  coerceDocument,
  docView,
  elementViewById,
  scriptsView,
  findTextDoc,
  groupSelection,
  groupView,
  isShapeKind,
  moveElementTo,
  normalizeAfterWrite,
  PAINT_KINDS,
  parseAnimationInput,
  patchElement,
  removeElement as removeOp,
  reorderElement as reorderOp,
  setAnimation as setAnimOp,
  setBackground as setBgOp,
  setDocSize,
  setTheme as setThemeOp,
  ungroupSelection,
  updateGroup as updateGroupOp,
  type CoerceReport,
  type LayoutRequest,
} from '../typography/agent-ops';
import { tr } from '../i18n/index.svelte';
import { ControlFailure, type TextOutlineResult } from './types';
import { measureDocument, type TypographyMeasure } from './typo-measure';
import type {
  TypographyDocIdView,
  TypographyDocView,
  TypographyElementInput,
  TypographyElementPatch,
  TypographyElementView,
  TypographyLayoutRequest,
} from './types';

const MAX_DOC_EDGE = 8192;
/** 一次批量写的上限（一条 undo 记录里的元素条数）。 */
const MAX_BATCH = 200;

/* --------------------------------------------------------------- 读取 */

export function requireDoc(store: ProjectStore, clipId: string): TypographyDocument {
  const doc = findTextDoc(store.project, clipId);
  if (!doc) {
    const clip = store.findClip(clipId);
    if (!clip) throw new ControlFailure('not-found', tr('agent.clip.notFound', { id: clipId }), { clipId });
    throw new ControlFailure('unsupported', tr('agent.typo.notText', { id: clipId }), { clipId });
  }
  return doc;
}

export function getDoc(
  store: ProjectStore,
  clipId: string,
  detail: 'ids' | 'full',
): TypographyDocView | TypographyDocIdView {
  const doc = requireDoc(store, clipId);
  return docView(doc, clipId, detail) as unknown as TypographyDocView | TypographyDocIdView;
}

/* --------------------------------------------------------------- 写入 */

/** 对象判据（与 agent-ops 里的同名工具同义；那边不可导出内部小工具）。 */
function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 在 `store.commit` 里拿**当前**文档（撤销 / 重做会换掉整个 project 对象，
 * 所以在提交前抓到的那份只用来校验，不能拿它改）。
 */
function withDoc(store: ProjectStore, clipId: string, label: string, fn: (doc: TypographyDocument) => void): boolean {
  return store.commit(label, (p) => {
    const doc = findTextDoc(p, clipId);
    if (!doc) return;
    fn(doc);
    normalizeAfterWrite(doc);
  });
}

function requireElement(store: ProjectStore, clipId: string, elementId: string): TypographyElement {
  const doc = requireDoc(store, clipId);
  const el = doc.elements.find((e) => e.id === elementId);
  if (!el) {
    throw new ControlFailure('not-found', tr('agent.typo.elementNotFound', { id: elementId }), { elementId });
  }
  return el;
}

/** 写后读回单个元素的 full 视图（写操作的返回值就是它）。 */
function viewOf(store: ProjectStore, clipId: string, elementId: string): TypographyElementView {
  const doc = findTextDoc(store.project, clipId);
  const view = doc ? elementViewById(doc, elementId) : null;
  if (!view) throw new ControlFailure('internal', tr('agent.typo.noDoc', { id: clipId }), { elementId });
  // `elementView` 的输出形状与 `TypographyElementView` 同源（前者是后者的超集）。
  return view as unknown as TypographyElementView;
}

/** 新增元素的**前置校验**（批量与单个共用；不合法时在改动之前抛）。 */
function validateNewInput(store: ProjectStore, input: TypographyElementInput): void {
  if (!input || typeof input !== 'object') {
    throw new ControlFailure('invalid-argument', tr('agent.args.notObject', { what: 'element' }));
  }
  if (input.kind === 'text') {
    // `runs` 优先于 `text`；形状不对必须报错，否则会静默回落到纯文本。
    if (input.runs !== undefined && !coerceRuns(input.runs)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badRuns'), { runs: input.runs });
    }
    if (typeof input.text !== 'string') {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badText', { what: 'text' }));
    }
  } else if (input.kind === 'shape') {
    if (!isShapeKind(input.shape)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badShape', { shape: String(input.shape) }), {
        validIds: SHAPE_KINDS,
      });
    }
    // 其它图形的几何由参数生成，写路径字段是静默无效的（渲染侧根本不读）。
    if (
      input.shape !== 'svg' &&
      (input.path !== undefined || input.pathUnit !== undefined || input.clipFrame !== undefined)
    ) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.pathNotSvg', { id: '(new element)' }));
    }
  } else if (input.kind === 'image') {
    if (!input.assetId) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.needAsset'));
    }
    const inProject = Boolean(store.project.assets[input.assetId]);
    if (!inProject) {
      throw new ControlFailure('not-found', tr('agent.asset.notFound', { id: input.assetId }), {
        validIds: Object.keys(store.project.assets),
      });
    }
    if (input.key !== undefined && input.key !== null && !coerceKeySettings(input.key)) {
      throw new ControlFailure('invalid-argument', tr('agent.clip.badKey'), { key: input.key });
    }
    if (input.quad !== undefined && input.quad !== null && !coerceQuadCorners(input.quad)) {
      throw new ControlFailure('invalid-argument', tr('agent.clip.badQuad'), { quad: input.quad });
    }
  } else {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.typo.badElementKind', { kind: String((input as { kind?: unknown }).kind) }),
      { validIds: ['text', 'shape', 'image'] },
    );
  }
  if (input.transform3d !== undefined && input.transform3d !== null && !coerceTransform3DPatch(input.transform3d)) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badTransform3d'), { transform3d: input.transform3d });
  }
  validateAnimationInput(input.animation, input.animations);
}

/**
 * 动画入参的前置校验。
 *
 * 为什么不靠 `animationFromInput` 的「返回 null」：那样非法输入会被**静默丢弃**，
 * 而模型看到的是「元素加上了、但动画没跑」，几乎不可能自己定位。这里在改动之前
 * 报错，并在 detail 里回显收到的值。
 *
 * 自定义 CSS 被拒时**必须带上原因**（`CustomCssError`）：花括号没配平与引用未定义
 * 的动画名要改的地方完全不同，只说一句「入参非法」等于让模型盲改字符串。
 */
function validateAnimationInput(animation: unknown, animations: unknown): void {
  const list = Array.isArray(animations) ? animations : animation !== undefined ? [animation] : [];
  for (const item of list) {
    if (item === null) continue;
    /*
     * `target` 单独报一句：写错成 `'element'` / `'text'` 时 `parseAnimationInput`
     * 只会回「入参非法」，而模型不会怀疑是拼写 —— 它会去改 keys 或 preset。
     */
    if (isRecordLike(item)) {
      const target = item.target;
      if (target !== undefined && target !== 'content' && target !== 'box') {
        throw new ControlFailure('invalid-argument', tr('agent.typo.badAnimTarget', { target: String(target) }), {
          target,
          validIds: ['content', 'box'],
        });
      }
    }
    const parsed = parseAnimationInput(item);
    if (parsed.ok) continue;
    if (parsed.reason) {
      throw new ControlFailure(
        'invalid-argument',
        tr('agent.typo.badAnimationCss', { reason: tr(CUSTOM_CSS_ERROR_KEYS[parsed.reason]) }),
        { animation: item, reason: parsed.reason },
      );
    }
    throw new ControlFailure('invalid-argument', tr('agent.typo.badAnimation'), { animation: item });
  }
}

/**
 * `typo_update_element` 的补丁校验。**前置**：在 `commit` 之前跑完。
 *
 * 不做的后果不是「报错不清楚」而是「报错在 commit 里」：`patchElement` 抛的
 * 是裸 `Error`，穿过控制平面之后只剩一句 `internal`，模型完全看不出是自己写错了。
 * 另一个后果是**静默无效**：给非 svg 图形写 `path`、给图形写 `autoHeight`，
 * 渲染侧根本不读，而回执里那个字段还在（读的是旧值）。
 */
function validatePatch(el: TypographyElement, patch: Record<string, unknown>, elementId: string): void {
  if (patch.animation !== undefined || patch.addAnimation !== undefined) {
    validateAnimationInput(patch.animation, undefined);
    validateAnimationInput(patch.addAnimation, undefined);
  }
  if (patch.animations !== undefined) validateAnimationInput(undefined, patch.animations);

  if (patch.transform3d !== undefined && patch.transform3d !== null) {
    if (!coerceTransform3DPatch(patch.transform3d)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badTransform3d'), {
        transform3d: patch.transform3d,
      });
    }
  }
  if (patch.autoHeight !== undefined && el.kind !== 'text') {
    throw new ControlFailure('invalid-argument', tr('agent.typo.autoHeightNotText', { id: elementId }));
  }
  if (patch.runs !== undefined) {
    if (el.kind !== 'text') {
      throw new ControlFailure('invalid-argument', tr('agent.typo.runsNotText', { id: elementId }));
    }
    if (!coerceRuns(patch.runs)) {
      // 键名拼错（`fontWight`）在 normalizeRuns 里会被原样放过 —— 渲染静默忽略。
      throw new ControlFailure('invalid-argument', tr('agent.typo.badRuns'), { runs: patch.runs });
    }
  }
  // 抠图 / 四角只存在于图片元素：形状不对时要报错，不能靠 patchElement 静默忽略。
  if ((patch.key !== undefined || patch.quad !== undefined) && el.kind !== 'image') {
    throw new ControlFailure('invalid-argument', tr('agent.typo.keyNotImage', { id: elementId }));
  }
  if (patch.key !== undefined && patch.key !== null) {
    if (!coerceKeySettings(patch.key, el.kind === 'image' ? el.key : undefined)) {
      throw new ControlFailure('invalid-argument', tr('agent.clip.badKey'), { key: patch.key });
    }
  }
  if (patch.quad !== undefined && patch.quad !== null && !coerceQuadCorners(patch.quad)) {
    throw new ControlFailure('invalid-argument', tr('agent.clip.badQuad'), { quad: patch.quad });
  }
  /*
   * 图片效果四件套（校正 / 重新着色 / 边框 / 滤镜）。与抠图同一条纪律：
   * 形状不对要在**改动之前**报出来 —— `patchElement` 遇到坏形状是整条跳过，
   * 而回执里那个字段还在（读的是旧值），模型会以为自己写成功了。
   */
  if (patch.adjust !== undefined && patch.adjust !== null) {
    if (el.kind !== 'image' || !coerceImageAdjust(patch.adjust, el.adjust)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badImageFx'), { adjust: patch.adjust });
    }
  }
  if (patch.recolor !== undefined && patch.recolor !== null) {
    if (el.kind !== 'image' || !coerceImageRecolor(patch.recolor, el.recolor)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badImageFx'), { recolor: patch.recolor });
    }
  }
  if (patch.border !== undefined && patch.border !== null) {
    if (el.kind !== 'image' || !coerceImageBorder(patch.border, el.border)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badImageFx'), { border: patch.border });
    }
  }
  if (patch.filter !== undefined && patch.filter !== null) {
    if (el.kind !== 'image' || !coerceImageFilter(patch.filter)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badImageFx'), { filter: patch.filter });
    }
  }
  // 路径三件套只对 svg 生效：写在别的图形上是静默无效（渲染侧根本不读）。
  if (patch.path !== undefined || patch.pathUnit !== undefined || patch.clipFrame !== undefined) {
    if (el.kind !== 'shape' || el.shape !== 'svg') {
      throw new ControlFailure('invalid-argument', tr('agent.typo.pathNotSvg', { id: elementId }));
    }
  }
  if (patch.path !== undefined && typeof patch.path !== 'string') {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badText', { what: 'path' }));
  }
}

/** 在已拿到的文档上追加一个元素，返回新 id（调用点已在 commit 内）。 */
function appendInput(doc: TypographyDocument, input: TypographyElementInput): string {
  if (input.kind === 'text') return addTextElement(doc, input).id;
  if (input.kind === 'shape') return addShapeElement(doc, input).id;
  return addImageElement(doc, input).id;
}

/** 新增元素。三种 kind 的校验都在这里做完，再进 commit。 */
export function addElement(
  store: ProjectStore,
  clipId: string,
  input: TypographyElementInput,
): { elementId: string; element: TypographyElementView } {
  requireDoc(store, clipId);
  validateNewInput(store, input);

  let id = '';
  // 先算一次 id 会让后面的 commit 里拿不到工厂返回值，所以把工厂调用放在 commit 内。
  withDoc(store, clipId, `agent:typo_add_${input.kind}`, (d) => {
    id = appendInput(d, input);
  });
  if (!id) throw new ControlFailure('internal', tr('agent.typo.noDoc', { id: clipId }));
  return { elementId: id, element: viewOf(store, clipId, id) };
}

/**
 * 批量新增：**一次 commit = 一笔撤销**。
 *
 * 为什么必须有它：二十一个元素逐个调意味着二十一次往返 + 二十一次整工程快照
 * （`CommandStack` 每次 commit 都拍两份 JSON）。而 z 序由数组顺序决定，串行
 * 反而是唯一安全的写法 —— 批量接口把这个限制变成一次调用。
 */
export function addElements(
  store: ProjectStore,
  clipId: string,
  inputs: TypographyElementInput[],
): { elementIds: string[]; elements: TypographyElementView[] } {
  requireDoc(store, clipId);
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'elements' }));
  }
  if (inputs.length > MAX_BATCH) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchTooLarge', { max: MAX_BATCH }));
  }
  // 全部校验通过才动手：半途失败会留下「前三个加上了、第四个没有」。
  for (const input of inputs) validateNewInput(store, input);

  const ids: string[] = [];
  withDoc(store, clipId, 'agent:typo_add_elements', (d) => {
    for (const input of inputs) ids.push(appendInput(d, input));
  });
  if (ids.length !== inputs.length) {
    throw new ControlFailure('internal', tr('agent.typo.noDoc', { id: clipId }));
  }
  return { elementIds: ids, elements: ids.map((id) => viewOf(store, clipId, id)) };
}

/** 按生成器 id 造一个程序化图形。 */
export function addGenerated(
  store: ProjectStore,
  clipId: string,
  input: {
    genId: string;
    params?: Record<string, number | string>;
    seed?: number;
    frame?: { x?: number; y?: number; w?: number; h?: number; rot?: number };
    name?: string;
    fill?: unknown;
    stroke?: unknown;
  },
): { elementId: string; element: TypographyElementView } {
  requireDoc(store, clipId);
  let id = '';
  withDoc(store, clipId, 'agent:typo_add_shape', (d) => {
    try {
      id = addGeneratedShape(d, input).id;
    } catch (e) {
      throw new ControlFailure('not-found', tr('agent.typo.badGen', { id: input.genId }), {
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
  if (!id) throw new ControlFailure('internal', tr('agent.typo.noDoc', { id: clipId }));
  return { elementId: id, element: viewOf(store, clipId, id) };
}

export function updateElement(
  store: ProjectStore,
  clipId: string,
  elementId: string,
  patch: TypographyElementPatch,
): { changed: boolean; element: TypographyElementView } {
  const el = requireElement(store, clipId, elementId);
  validatePatch(el, patch as Record<string, unknown>, elementId);
  const changed = withDoc(store, clipId, 'agent:typo_update', (d) => {
    patchElement(d, elementId, patch as Record<string, unknown>);
  });
  return { changed, element: viewOf(store, clipId, elementId) };
}

/** 批量改属性：一次 commit、一次撤销；返回改后的完整元素视图。 */
export function updateElements(
  store: ProjectStore,
  clipId: string,
  updates: { elementId: string; patch: TypographyElementPatch }[],
): { changed: number; elements: TypographyElementView[] } {
  requireDoc(store, clipId);
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'updates' }));
  }
  if (updates.length > MAX_BATCH) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchTooLarge', { max: MAX_BATCH }));
  }
  for (const [i, update] of updates.entries()) {
    if (!update || typeof update !== 'object' || typeof update.elementId !== 'string') {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badUpdate', { index: i }));
    }
    const el = requireElement(store, clipId, update.elementId);
    // 全部校验通过才动手：半途失败会留下「前三个改了、第四个没有」。
    validatePatch(el, (update.patch ?? {}) as Record<string, unknown>, update.elementId);
  }

  let changed = 0;
  withDoc(store, clipId, 'agent:typo_update_elements', (d) => {
    for (const update of updates) {
      if (patchElement(d, update.elementId, update.patch as Record<string, unknown>)) changed += 1;
    }
  });
  return { changed, elements: updates.map((u) => viewOf(store, clipId, u.elementId)) };
}

/**
 * 设置 / 清除 / 追加一个元素动画（`typo_set_animation`）。
 *
 * `input === null` 清空；`mode:'add'` 追加（一个元素可以叠多条动画：先 fade 再
 * shake 这类组合在渲染侧是**嵌套包装**，见 `typography/animation.ts` 文件头）。
 */
export function setElementAnimation(
  store: ProjectStore,
  clipId: string,
  elementId: string,
  input: unknown,
  mode: 'replace' | 'add',
): { changed: boolean; element: TypographyElementView } {
  requireElement(store, clipId, elementId);
  validateAnimationInput(input, undefined);
  const changed = withDoc(store, clipId, 'agent:typo_set_animation', (d) => {
    const el = d.elements.find((e) => e.id === elementId);
    if (!el) return;
    setAnimOp(el, input, mode);
  });
  return { changed, element: viewOf(store, clipId, elementId) };
}

/**
 * 把**一个元素**的外观（`what:'format'`）或动画（`what:'animation'`）刷到一批目标上
 * —— 编辑器里「格式刷 / 动画刷」的同一条路径（`typography/format-painter.ts`）。
 *
 * 语义与界面完全一致，这也是它存在的理由（硬约束 1.9）：
 *  - `format`：填充 / 描边 / 圆角 / 文本样式 / 图片的各项处理 / 阴影与虚化；
 *  - `animation`：**整份替换**动画条目（不是追加），并重新发 id；
 *  - 目标没有的字段静默跳过（图形没有 `fit`、文本框没有 `crop`…），不报错。
 *
 * 返回真的改了几个（0 = 全都无事可做，例如源与目标的格式本来就一样）。
 */
export function copyElementStyle(
  store: ProjectStore,
  clipId: string,
  sourceId: string,
  targetIds: string[],
  what: 'format' | 'animation',
): { changed: number; elements: TypographyElementView[] } {
  requireElement(store, clipId, sourceId);
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'targetIds' }));
  }
  if (targetIds.length > MAX_BATCH) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchTooLarge', { max: MAX_BATCH }));
  }
  // 源自己混在目标里没有意义（那是空操作），去重后必须还剩东西。
  const ids = [...new Set(targetIds)].filter((id) => id !== sourceId);
  if (!ids.length) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'targetIds' }));
  }
  // 校验前置：任何一个目标不存在就在动手之前报错。
  for (const id of ids) requireElement(store, clipId, id);

  let changed = 0;
  withDoc(store, clipId, `agent:typo_copy_${what}`, (d) => {
    const src = d.elements.find((e) => e.id === sourceId);
    if (!src) return;
    for (const id of ids) {
      const target = d.elements.find((e) => e.id === id);
      if (!target) continue;
      const done = what === 'format' ? applyElementFormat(src, target) : applyElementAnimations(src, target);
      if (done) changed += 1;
    }
  });
  return { changed, elements: ids.map((id) => viewOf(store, clipId, id)) };
}

/**
 * 整表替换文档级脚本（`typo_set_scripts`）。
 *
 * **校验前置**：坏 id / 超长 / 未知 needs 直接拒绝，不做「尽力而为」——
 * 脚本写坏了只会表现成「画面没变化」，那是模型最难自查的一类失败。
 * 语法用编译检查（只编译、不执行）：执行会带来副作用，写入前的闸门不能
 * 顺便跑用户的代码。
 */
export function setScripts(
  store: ProjectStore,
  clipId: string,
  raw: unknown,
): { scripts: Record<string, unknown>[] } {
  requireDoc(store, clipId);
  if (!Array.isArray(raw)) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.scriptsNotArray'));
  }
  const sanitized = sanitizeScripts(raw);
  if (sanitized.dropped.length) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.typo.scriptInvalid', { detail: sanitized.dropped.join(', ') }),
      { dropped: sanitized.dropped },
    );
  }
  for (const script of sanitized.scripts) {
    const check = checkScriptSyntax(script.code);
    if (!check.ok) {
      throw new ControlFailure(
        'invalid-argument',
        tr('agent.typo.scriptSyntax', { name: script.name, detail: check.detail }),
        { scriptId: script.id },
      );
    }
  }
  withDoc(store, clipId, 'agent:typo_set_scripts', (d) => {
    if (sanitized.scripts.length) d.scripts = sanitized.scripts;
    else delete d.scripts;
  });
  return { scripts: scriptsView(requireDoc(store, clipId)) };
}

export function setText(
  store: ProjectStore,
  clipId: string,
  elementId: string,
  text: string,
): { changed: boolean; element: TypographyElementView } {
  if (typeof text !== 'string') {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badText', { what: 'text' }));
  }
  requireElement(store, clipId, elementId);
  const changed = withDoc(store, clipId, 'agent:typo_set_text', (d) => {
    patchElement(d, elementId, { text });
  });
  return { changed, element: viewOf(store, clipId, elementId) };
}

export function removeElement(store: ProjectStore, clipId: string, elementId: string): boolean {
  requireElement(store, clipId, elementId);
  return withDoc(store, clipId, 'agent:typo_remove', (d) => {
    removeOp(d, elementId);
  });
}

export function reorderElement(
  store: ProjectStore,
  clipId: string,
  elementId: string,
  op: 'front' | 'back' | 'forward' | 'backward' | 'index',
  index?: number,
): { changed: boolean; z: number } {
  requireElement(store, clipId, elementId);
  if (op === 'index' && !Number.isFinite(Number(index))) {
    throw new ControlFailure('invalid-argument', tr('agent.args.notFinite', { what: 'index', key: 'index' }));
  }
  const changed = withDoc(store, clipId, 'agent:typo_reorder', (d) => {
    if (op === 'index') moveElementTo(d, elementId, Number(index));
    else reorderOp(d, elementId, op);
  });
  const doc = requireDoc(store, clipId);
  return { changed, z: doc.elements.findIndex((e) => e.id === elementId) };
}

export function groupElements(
  store: ProjectStore,
  clipId: string,
  elementIds: string[],
  name: string,
): { groupId: string | null } {
  requireDoc(store, clipId);
  let groupId: string | null = null;
  withDoc(store, clipId, 'agent:typo_group', (d) => {
    groupId = groupSelection(d, elementIds, name || 'group');
  });
  return { groupId };
}

export function ungroupElements(store: ProjectStore, clipId: string, elementIds: string[]): boolean {
  requireDoc(store, clipId);
  return withDoc(store, clipId, 'agent:typo_ungroup', (d) => {
    ungroupSelection(d, elementIds);
  });
}

/**
 * 改分组底板（组名 / 填充 / 边框 / 圆角 / 内边距）。
 *
 * 分组自带一块外壳，但「成组」只是把它建出来；不把这块壳暴露出去的话，agent 造
 * 出来的组永远是「什么都没有」的一层（`fill:none` + `stroke:null` + `padding:8`）。
 */
export function updateGroupBox(
  store: ProjectStore,
  clipId: string,
  groupId: string,
  patch: Record<string, unknown>,
): { changed: boolean; group: Record<string, unknown> } {
  const doc = requireDoc(store, clipId);
  const group = (doc.groups ?? []).find((g) => g.id === groupId);
  if (!group) {
    throw new ControlFailure('not-found', tr('agent.typo.groupNotFound', { id: groupId }), {
      validIds: (doc.groups ?? []).map((g) => g.id),
    });
  }
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.args.emptyPatch', { what: 'patch' }));
  }
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badText', { what: 'name' }));
  }
  if (patch.fill !== undefined) {
    const kind = (patch.fill as { kind?: unknown } | null)?.kind;
    if (!isRecordLike(patch.fill) || typeof kind !== 'string' || !PAINT_KINDS.has(kind)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badPaint'), { fill: patch.fill });
    }
  }
  if (patch.stroke !== undefined && patch.stroke !== null && !isRecordLike(patch.stroke)) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badStroke'), { stroke: patch.stroke });
  }
  for (const key of ['radius', 'padding'] as const) {
    if (patch[key] !== undefined && !(Number(patch[key]) >= 0)) {
      throw new ControlFailure('invalid-argument', tr('agent.args.notFinite', { what: 'patch', key }));
    }
  }
  const changed = withDoc(store, clipId, 'agent:typo_group_box', (d) => {
    updateGroupOp(d, groupId, patch);
  });
  const after = (requireDoc(store, clipId).groups ?? []).find((g) => g.id === groupId);
  return { changed, group: after ? groupView(after) : {} };
}

/** 改画幅（`scaleContent` = 过 `resizeDocument`，元素 / 字号 / 描边一起缩放）。 */
export function setCanvasSize(
  store: ProjectStore,
  clipId: string,
  size: { w: number; h: number },
  scaleContent: boolean,
): { changed: boolean; size: { w: number; h: number } } {
  requireDoc(store, clipId);
  const w = Math.round(Number(size?.w));
  const h = Math.round(Number(size?.h));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badCanvas'), { size });
  }
  const changed = withDoc(store, clipId, 'agent:typo_canvas', (d) => {
    setDocSize(d, { w, h }, scaleContent);
  });
  const after = requireDoc(store, clipId);
  return { changed, size: { ...after.size } };
}

/**
 * 设镜头（2.5D 视差）。`null` = 回到恒等（删字段），对象 = **按出现的键合并**
 * 到当前镜头上（只给 `{ zoom: 1.4 }` 不会把已有的 x / y / rot 清掉）。
 *
 * 元素的 `depth` 走 `typo_update_element` 的 `depth` —— 镜头是文档级的，
 * 景深是元素级的，两者分开才不会出现「改一个元素把镜头重置了」。
 */
export function setCamera(
  store: ProjectStore,
  clipId: string,
  input: unknown,
): { changed: boolean; camera: Camera | null } {
  requireDoc(store, clipId);
  let next: Camera | null;
  if (input === null) {
    next = null;
  } else {
    const patch = coerceCameraPatch(input);
    if (!patch) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.badCamera'), { camera: input });
    }
    next = mergeCamera(requireDoc(store, clipId).camera, patch);
  }
  const identity = !next || cameraIsIdentity(next);
  const changed = withDoc(store, clipId, 'agent:typo_camera', (d) => {
    if (identity) delete d.camera;
    else d.camera = next!;
  });
  return { changed, camera: identity ? null : next };
}

/** 镜头关键帧的输入 → `TrackKey[]`（形状不认识返回 null，由控制平面报 invalid-argument）。 */
export function coerceCameraKeyList(raw: unknown[]): TrackKey[] | null {
  return coerceCameraKeys(raw);
}

/**
 * 镜头关键帧：**整条通道覆盖写**（`null` = 删掉这条轨道，回到基准值）。
 *
 * 为什么不是「加一帧 / 删一帧」：agent 拿到的是一份它自己算好的曲线，逐帧
 * 增量写要么在时间上漂、要么点数量翻倍；整条写保证「读回什么就能写回什么」。
 * 求值见 `camera-tracks.ts::cameraAt` —— 有关键帧的通道以轨道为准，`doc.camera`
 * 只是其余通道的基准值。
 */
export function setCameraAnimation(
  store: ProjectStore,
  clipId: string,
  channel: CameraKey,
  keys: TrackKey[] | null,
): { changed: boolean; channel: CameraKey; keys: TrackKey[] | null } {
  requireDoc(store, clipId);
  const changed = withDoc(store, clipId, 'agent:typo_camera_track', (d) => {
    setCameraTrack(d, channel, keys);
  });
  return {
    changed,
    channel,
    keys: keys && keys.length ? keys.map((k) => ({ ...k })) : null,
  };
}

/* ------------------------------------------------- 路径族：布尔 / 拆分 / 转路径 */

/** 参与几何运算的元素：必须是存在、未锁定的图形（ids 顺序无关，运算按 z 序）。 */
function requireShapes(store: ProjectStore, clipId: string, ids: readonly string[]): void {
  const doc = requireDoc(store, clipId);
  if (!Array.isArray(ids) || ids.length < 2) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.needTwoShapes'));
  }
  for (const id of ids) {
    const el = doc.elements.find((e) => e.id === id);
    if (!el) {
      throw new ControlFailure('not-found', tr('agent.typo.elementNotFound', { id }), { elementId: id });
    }
    if (el.kind !== 'shape') {
      throw new ControlFailure('invalid-argument', tr('agent.typo.notShape', { id }), { elementId: id });
    }
    if (el.locked) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.locked', { id }), { elementId: id });
    }
  }
}

/**
 * 布尔运算（并 / 差 / 交 / 异或）。
 *
 * **差集按 z 序**：最底下的那个图形是被减数（「后画的挖掉先画的」）。
 * 结果为空的（交集为空 / 被减没了）是 `unsupported` 且**不改文档** —— 改成空图形
 * 没有意义，而静默返回一个不存在的 id 会让模型以为画面上多了个东西。
 */
export function booleanShapes(
  store: ProjectStore,
  clipId: string,
  ids: readonly string[],
  op: 'union' | 'difference' | 'intersection' | 'xor',
): { elementId: string } {
  requireShapes(store, clipId, ids);
  const out: { id: string | null } = { id: null };
  withDoc(store, clipId, 'agent:typo_boolean', (d) => {
    out.id = applyBoolean(d, ids, op);
  });
  if (!out.id) {
    throw new ControlFailure('unsupported', tr('agent.typo.booleanEmpty'));
  }
  return { elementId: out.id };
}

/** 拆分：重叠区域切成互不重叠的若干片，每片沿用「盖在它最上面的那个操作数」的外观。 */
export function divideShapes(
  store: ProjectStore,
  clipId: string,
  ids: readonly string[],
): { elementIds: string[] } {
  requireShapes(store, clipId, ids);
  const out: { ids: string[] } = { ids: [] };
  withDoc(store, clipId, 'agent:typo_divide', (d) => {
    out.ids = applyDivide(d, ids);
  });
  if (!out.ids.length) {
    throw new ControlFailure('unsupported', tr('agent.typo.booleanEmpty'));
  }
  return { elementIds: out.ids };
}

/** `TextOutlineFailure.code` → 文案键（都要能照做，不能只说「失败」）。 */
const OUTLINE_ERROR_KEYS: Record<string, MessageKey> = {
  empty: 'agent.typo.outlineEmpty',
  vertical: 'agent.typo.outlineVertical',
  'no-font': 'agent.typo.outlineNoFont',
  'local-denied': 'agent.typo.outlineLocal',
  'local-missing': 'agent.typo.outlineLocal',
  'local-failed': 'agent.typo.outlineLocal',
  'missing-glyphs': 'agent.typo.outlineMissingGlyphs',
  synthetic: 'agent.typo.outlineSynthetic',
};

/**
 * 把元素转成路径。
 *
 * - 参数化 / 生成器图形：就地转成 `shape:'svg'`（生成器元素只摘掉 `gen` —— 它的
 *   path 本来就是烘焙结果）。同步、一笔撤销。
 * - 文本：轮廓计算要 DOM + HarfBuzz，走注入的 `outline`（控制平面自己 import
 *   不了 `text-outline`）。**先全部算完再落库**，任何一条失败都不改文档；等算
 *   期间文档被改过就整批放弃（与编辑器同一条判据）。
 */
export async function convertToPath(
  store: ProjectStore,
  clipId: string,
  elementIds: readonly string[],
  outline?: (
    el: TextElement,
    theme: string | undefined,
    customThemes: TypographyTheme[] | undefined,
  ) => Promise<TextOutlineResult>,
): Promise<{ elementIds: string[]; converted: number }> {
  const doc = requireDoc(store, clipId);
  if (!Array.isArray(elementIds) || elementIds.length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.batchEmpty', { what: 'elementIds' }));
  }
  const targets = elementIds.map((id) => requireElement(store, clipId, id));
  const texts = targets.filter((e): e is TextElement => e.kind === 'text');
  if (texts.length > 0 && !outline) {
    throw new ControlFailure('unsupported', tr('agent.typo.outlineUnavailable'));
  }

  const prepared: { source: TextElement; items: TextOutlineItem[]; shadows: ElementShadow[] }[] = [];
  for (const el of texts) {
    const snap = structuredClone(el);
    const r = await outline!(snap, doc.theme, store.project.customThemes ?? undefined);
    if (!r.ok) {
      const d = r.detail ?? {};
      const list = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');
      throw new ControlFailure('unsupported', tr(OUTLINE_ERROR_KEYS[r.code] ?? 'agent.typo.outlineEmpty', {
        fonts: list(d.families),
        faces: list(d.faces),
        chars: String(d.chars ?? ''),
        msg: String(d.message ?? ''),
      }), r.detail);
    }
    prepared.push({
      source: snap,
      items: r.items as TextOutlineItem[],
      shadows: r.shadows as ElementShadow[],
    });
  }

  // 等轮廓期间文档可能变了：整批比对，任何一条对不上就整批放弃。
  const now = requireDoc(store, clipId);
  for (const job of prepared) {
    const el = now.elements.find((e) => e.id === job.source.id);
    if (!el || JSON.stringify(el) !== JSON.stringify(job.source)) {
      throw new ControlFailure('conflict', tr('agent.typo.outlineChanged'));
    }
  }

  const out: { ids: string[] } = { ids: [] };
  store.commit('agent:typo_to_path', (p) => {
    const d = findTextDoc(p, clipId);
    if (!d) return;
    for (const id of elementIds) {
      const el = d.elements.find((e) => e.id === id);
      if (!el || el.kind !== 'shape') continue;
      // 生成器元素的 path 已是烘焙结果：脱离 = 丢掉 gen（与编辑器一致）。
      if (el.gen) delete el.gen;
      else if (convertShapeToPath(el)) out.ids.push(el.id);
    }
    for (const job of prepared) {
      out.ids.push(...applyTextToPath(d, job.source.id, job.items, job.shadows));
    }
  });
  return { elementIds: out.ids, converted: out.ids.length };
}

/** 对齐 / 分布 / 网格 / 行列。 */
export function layout(
  store: ProjectStore,
  clipId: string,
  req: TypographyLayoutRequest,
): { moved: number; elements: { id: string; frame: { x: number; y: number; w: number; h: number; rot: number } }[] } {
  const doc = requireDoc(store, clipId);
  const picked = req.elementIds && req.elementIds.length ? req.elementIds : doc.elements.map((e) => e.id);
  if (picked.length === 0) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.noElements'));
  }
  for (const id of picked) {
    if (!doc.elements.some((e) => e.id === id)) {
      throw new ControlFailure('not-found', tr('agent.typo.elementNotFound', { id }));
    }
  }
  if (req.op === 'distribute' && picked.length < 3) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.typo.badLayout', { detail: tr('agent.typo.distributeMin') }),
    );
  }
  if (req.op === 'grid' && !(req.cols >= 1)) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.typo.badLayout', { detail: tr('agent.typo.badCols') }),
    );
  }

  let moved = 0;
  withDoc(store, clipId, 'agent:typo_layout', (d) => {
    moved = applyLayout(d, req as LayoutRequest);
  });
  // 回显**新的 frame**：布局是 agent 最容易「调了但不知道落到哪」的一类操作。
  const after = requireDoc(store, clipId);
  const frames = picked
    .map((id) => after.elements.find((e) => e.id === id))
    .filter((el): el is NonNullable<typeof el> => Boolean(el))
    .map((el) => ({ id: el.id, frame: { ...el.frame } }));
  return { moved, elements: frames };
}

/** 几何体检：文字内容高度 / 溢出 / 元素相交 / 出画。纯读，不写文档。 */
export function measure(store: ProjectStore, clipId: string, elementIds?: string[]): TypographyMeasure {
  const doc = requireDoc(store, clipId);
  if (elementIds && elementIds.length) {
    for (const id of elementIds) {
      if (!doc.elements.some((e) => e.id === id)) {
        throw new ControlFailure('not-found', tr('agent.typo.elementNotFound', { id }), { elementId: id });
      }
    }
  }
  return measureDocument(doc, clipId, { elementIds });
}

export function setBackground(store: ProjectStore, clipId: string, paint: unknown): boolean {
  requireDoc(store, clipId);
  return withDoc(store, clipId, 'agent:typo_background', (d) => {
    setBgOp(d, paint);
  });
}

/** `null` = 回到默认方案。 */
export function setTheme(
  store: ProjectStore,
  clipId: string | null,
  theme: string | null,
  scope: 'clip' | 'project' = 'clip',
): boolean {
  const custom = store.project.customThemes ?? [];
  if (theme !== null && !isKnownTheme(theme, custom)) {
    // 未知 id 会被渲染静默回落默认方案 —— 那看起来就是「换了没反应」。
    throw new ControlFailure('not-found', tr('agent.typo.themeNotFound', { id: theme }), {
      validIds: themeIds(custom),
    });
  }
  if (scope === 'project') {
    return store.commit('agent:typo_theme', (p) => {
      if (theme) p.typographyTheme = theme;
      else delete p.typographyTheme;
      for (const track of p.tracks) {
        for (const clip of track.clips) {
          if (clip.kind !== 'source' || clip.source.type !== 'text') continue;
          if (theme) clip.source.doc.theme = theme;
          else delete clip.source.doc.theme;
        }
      }
    });
  }
  if (!clipId) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.noDoc', { id: '(none)' }), {
      hint: 'pass clipId, or use scope:"project"',
    });
  }
  requireDoc(store, clipId);
  return withDoc(store, clipId, 'agent:typo_theme', (d) => {
    setThemeOp(d, theme);
  });
}

export interface ThemeSaveInput {
  /** 更新已有的自定义方案（必须存在）。省略 = 新建。 */
  id?: string;
  /** 复制基准：内置或工程自定义方案的 id。省略 = 当前文档用的那套。 */
  base?: string;
  /** 显示名。更新时省略 = 保留原名。 */
  name?: string;
  /** 局部色槽：`{ accent1: '#ff8a00', dk1: '#0b0b0f' }`（合并到基准上）。 */
  colors?: unknown;
  scope?: 'clip' | 'project';
}

/**
 * 新建 / 更新一份自定义配色方案，并**立即设成当前方案**（与 UI 的保存行为一致）。
 *
 * 为什么 `colors` 是局部补丁而不是整份：模型不需要先读回整套颜色才能改一个槽，
 * 而「照着一份自己以为对的色表继续做」正是最容易偏的地方。基准优先级
 * 「id 指的那份 → `base` 指的 → 当前文档的方案 → 默认方案」。
 */
export function saveTheme(
  store: ProjectStore,
  clipId: string | null,
  input: ThemeSaveInput,
): { theme: TypographyTheme; scope: 'clip' | 'project'; appliedTo: string | null } {
  const custom = store.project.customThemes ?? [];
  const scope = input.scope === 'project' ? 'project' : 'clip';
  const doc = clipId ? requireDoc(store, clipId) : null;
  if (scope === 'clip' && !doc) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.noDoc', { id: '(none)' }), {
      hint: 'pass clipId, or use scope:"project"',
    });
  }

  const existing = typeof input.id === 'string' ? custom.find((t) => t.id === input.id) : null;
  if (typeof input.id === 'string' && !existing) {
    throw new ControlFailure('not-found', tr('agent.typo.themeNotFound', { id: input.id }), {
      validIds: custom.map((t) => t.id),
    });
  }
  if (input.base !== undefined && !isKnownTheme(String(input.base), custom)) {
    throw new ControlFailure('not-found', tr('agent.typo.themeNotFound', { id: String(input.base) }), {
      validIds: themeIds(custom),
    });
  }
  const base = existing ?? themeById(input.base ?? doc?.theme ?? null, custom);
  const colors = input.colors === undefined ? { ...base.colors } : mergeThemeColors(base.colors, input.colors);
  if (!colors) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.badThemeColors'), {
      slots: Object.keys(base.colors),
    });
  }
  const name =
    (typeof input.name === 'string' && input.name.trim()) || existing?.name || themeDisplayName(base);
  const theme: TypographyTheme = { id: existing?.id ?? newId(), name, colors };

  store.commit('agent:typo_theme_save', (p) => {
    const list = Array.isArray(p.customThemes) ? [...p.customThemes] : [];
    const i = list.findIndex((t) => t.id === theme.id);
    if (i >= 0) list[i] = theme;
    else list.push(theme);
    p.customThemes = list;
    if (scope === 'project') {
      p.typographyTheme = theme.id;
      for (const track of p.tracks) {
        for (const c of track.clips) {
          if (c.kind === 'source' && c.source.type === 'text') c.source.doc.theme = theme.id;
        }
      }
    } else if (clipId) {
      const target = findTextDoc(p, clipId);
      if (target) target.theme = theme.id;
    }
  });
  return { theme, scope, appliedTo: scope === 'project' ? null : clipId };
}

/**
 * 删除一份自定义方案，并把引用它的地方抹干净（`Project.typographyTheme` + 各文档）。
 *
 * 不抹的话工程里会留一堆悬空 id：渲染回落默认方案（不报错），但图库/检查器显示
 * 「本版本没有的方案」，下次保存也照样带着它。
 */
export function removeTheme(store: ProjectStore, themeId: string): { removed: string; clearedDocs: number } {
  const custom = store.project.customThemes ?? [];
  const target = custom.find((t) => t.id === themeId);
  if (!target) {
    throw new ControlFailure('not-found', tr('agent.typo.themeNotFound', { id: themeId }), {
      // 内置方案是只读数据表，删不掉 —— validIds 因此只列自定义的。
      validIds: custom.map((t) => t.id),
      hint: 'built-in themes cannot be removed',
    });
  }
  let cleared = 0;
  store.commit('agent:typo_theme_remove', (p) => {
    const list = (p.customThemes ?? []).filter((t) => t.id !== themeId);
    if (list.length) p.customThemes = list;
    else delete p.customThemes;
    if (p.typographyTheme === themeId) delete p.typographyTheme;
    for (const track of p.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'source' || clip.source.type !== 'text') continue;
        if (clip.source.doc.theme !== themeId) continue;
        delete clip.source.doc.theme;
        cleared += 1;
      }
    }
  });
  return { removed: themeId, clearedDocs: cleared };
}

/**
 * 整体替换文档（路径 B）。
 *
 * 与 `loadScene` 同一条思路：agent 生成一份完整文档比逐元素调 40 次更自然，
 * 而 `coerceDocument` 保证坏数据降级而不是把工程卡住。
 */
export function replaceDoc(
  store: ProjectStore,
  clipId: string,
  raw: unknown,
): { elements: number; dropped: number; droppedKeys: string[]; droppedAnimations: string[] } {
  const doc = requireDoc(store, clipId);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ControlFailure('invalid-argument', tr('agent.typo.docNotObject'));
  }
  const rawSize = (raw as { size?: unknown }).size;
  if (rawSize && typeof rawSize === 'object') {
    const w = Number((rawSize as { w?: unknown }).w);
    const h = Number((rawSize as { h?: unknown }).h);
    if (Number.isFinite(w) && Number.isFinite(h) && (w > MAX_DOC_EDGE || h > MAX_DOC_EDGE)) {
      throw new ControlFailure('invalid-argument', tr('agent.typo.widthTooLarge', { w, h, max: MAX_DOC_EDGE }));
    }
  }
  const report: CoerceReport = { droppedKeys: [], droppedAnimations: [] };
  const next = coerceDocument(raw, doc, report);
  const rawCount = Array.isArray((raw as { elements?: unknown }).elements)
    ? ((raw as { elements: unknown[] }).elements.length)
    : 0;
  store.updateClip(clipId, 'agent:typo_replace_doc', (c) => {
    if (c.kind === 'source' && c.source.type === 'text') c.source.doc = next;
  });
  return {
    elements: next.elements.length,
    dropped: Math.max(0, rawCount - next.elements.length),
    // 未知键**必须报出来**：静默归一化会让模型照着一份「自己以为对」的文档继续做。
    droppedKeys: report.droppedKeys.slice(0, 100),
    // 动画条目单独一栏：它是合法键、坏内容，混进 droppedKeys 会误导成「键名写错」。
    droppedAnimations: report.droppedAnimations.slice(0, 50),
  };
}
