/**
 * manifest.ts — 插件清单的**契约与校验**。
 *
 * 一个插件就是一个 ESM 文件，导出一个 `plugin` 对象：
 *
 * ```js
 * // my-plugin.js —— 放进 <工程目录>/plugins/
 * export const plugin = {
 *   format: 'artmatic-plugin',
 *   apiVersion: 1,
 *   id: 'my-plugin',              // [a-z0-9][a-z0-9._-]*，长度 ≤ 64
 *   name: '我的插件',
 *   author: '…', version: '1.0.0', license: 'MIT',
 *   effects: [
 *     {
 *       id: 'scanline',           // 对外 id = 'my-plugin/scanline'
 *       name: '扫描线',
 *       desc: '一条会走的亮线。',
 *       category: 'style',        // 六选一，缺省 'style'
 *       tags: ['overlay'],
 *       params: [
 *         { key: 'amount', labelKey: '强度', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
 *       ],
 *       shader: {
 *         fragment: `void main() { outColor = texture(u_texture, vUv); }`,  // 不含头
 *         setUniforms: (gl, locs, values) => { … },
 *       },
 *     },
 *   ],
 *   generators: [
 *     {
 *       id: 'waves', name: '波纹', params: [],
 *       fragment: `void main() { … }`,                                       // 不含头
 *       setUniforms: () => {},
 *       // 可选：宿主替它绑的素材纹理（配合 `type: 'asset'` 的参数，见 §4.1 文档）
 *       auxTextures: [{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' }],
 *     },
 *   ],
 * };
 * ```
 *
 * ## 三条设计约束
 *
 * 1. **这个文件是纯函数**，不碰 DOM / GL / 文件系统 —— 校验逻辑是插件系统里
 *    最多分支的一段，必须能脱离浏览器单测（与 `project/layout.ts` 同一条纪律）。
 * 2. **问题一律用 `code` 表达，不写整句中文**。理由有两条：注册表/校验层不该
 *    依赖 i18n 的运行期模块；`src/` 下不许出现面向用户的中文字面量（`i18n.test.ts`
 *    守卫）。句子由 UI 按 code 查表（`ui/plugin-manager/plugin-panel-model.ts`）。
 * 3. **校验只做「能不能安全地交给运行期」这一件事**，不做语义检查：着色器能不能
 *    编译由 `PluginHost` 用真 GL 编译回答（见 `plugins/host.ts`），参数的业务约束
 *    （默认值是否在选项里之类）由 `algo-params.test.ts` 那一族守卫内置数据 —— 
 *    插件数据没有构建期守卫，所以这里只保证「不会让 Inspector 抛异常」。
 */

import { EFFECT_CATEGORIES, EFFECT_TAGS, type EffectCategory, type EffectTag } from '../effects/catalog';
import type { EffectShaderDef } from '../effects/shader-def';
import type { ParamDef } from '../effects/types';
import type { AlgoAuxRef } from '../algos/types';
import type { AlgoSetUniforms } from '../algos/shader-lib';
import { normalizeLabel, type Label } from '../i18n/label';
import { isValidPluginSegment } from '../core/plugin-id';
import {
  TYPO_HOOK_PHASES,
  type TypoHookDef,
  type TypoHookPhase,
  type TypoHookRun,
} from '../typography/hook-types';

/** 清单里的格式标记。写错一律拒收（避免把别的 JSON 当插件喂进来）。 */
export const PLUGIN_FORMAT = 'artmatic-plugin';

/**
 * 本宿主能理解的最高 API 版本。
 *
 * 插件写更高的版本 = 它用了宿主还没有的能力，**必须拒收**而不是「尽力而为」——
 * 半个插件挂上去的表现是「某些参数拨了没反应」，那比明确拒收难查十倍。
 */
export const PLUGIN_API_VERSION = 2;

/* ------------------------------------------------------------- 问题码 */

export type PluginIssueCode =
  /** 导出的不是对象。 */
  | 'not-object'
  /** `format` 不是 'artmatic-plugin'。 */
  | 'bad-format'
  /** `apiVersion` 不是 1..PLUGIN_API_VERSION 的整数。 */
  | 'bad-api-version'
  /** `id` 不符合 `[a-z0-9][a-z0-9._-]*`（≤ 64）。 */
  | 'bad-id'
  /** `name` 不是非空字符串。 */
  | 'bad-name'
  /** `effects` / `generators` 不是数组。 */
  | 'bad-list'
  /** 两个列表都空 —— 挂上去什么也不会发生，多半是写错了字段名。 */
  | 'no-defs'
  /** 条目不是对象 / 缺 id / id 非法 / 缺 name。 */
  | 'bad-def'
  /** 同一个插件里 id 重复（后面的会被丢掉）。 */
  | 'duplicate-id'
  /** 参数表里有一项结构不合法（会让检查器渲染不出来）。 */
  | 'bad-param'
  /** 着色器定义不合法。 */
  | 'bad-shader'
  /** 分类 / 标签不认识（**只警告**，那一项被丢掉，条目照常挂载）。 */
  | 'unknown-meta'
  /** 文件读不出来（权限 / 坏文件）。 */
  | 'read-failed'
  /** 着色器编不过（真 GL 编译回答的，不在校验层猜）。 */
  | 'compile-failed'
  /** 着色器声明了某个 uniform 但从没读过它 —— 那个参数拨了不会有反应。 */
  | 'dropped-uniform'
  /**
   * `auxTextures` 的结构不合法（缺 uniform / kind 不认识 / assetParam 没指向
   * 本 def 的 asset 参数）。
   */
  | 'bad-aux'
  /** 文档钩子的结构不合法（缺字段 / 阶段不认识 / run 不是函数）。 */
  | 'bad-hook'
  /** 文档钩子在挂载校验时抛错（在合成文档上真跑了一次）。 */
  | 'hook-failed';

export interface PluginIssue {
  code: PluginIssueCode;
  /** 出问题的位置，如 `effects[0].params[2]`。给 UI 定位用，不含文案。 */
  path?: string;
  /** 出问题的实际值（id / 类型名等），**非文案**。 */
  detail?: string;
}

/* ------------------------------------------------------------- 类型 */

export interface PluginEffectDef {
  id: string;
  name: Label;
  desc: Label | null;
  category: EffectCategory | null;
  tags: EffectTag[];
  params: ParamDef[];
  shader: EffectShaderDef;
}

export interface PluginGeneratorDef {
  id: string;
  name: Label;
  desc: Label | null;
  params: ParamDef[];
  fragment: string;
  setUniforms: AlgoSetUniforms;
  /**
   * 宿主替它绑定的内部纹理（`AlgoAuxRef`）。这是插件拿到**媒体池素材**的唯一
   * 通路：`asset` 型参数只存 assetId，纹理由运行时按 `assetParam` 解析并绑到
   * `uniform` 上 —— sampler 自己声明、自己采样，但**不要**在 `setUniforms`
   * 里写它（宿主绑定，见 `algos/runtime.ts::bindAux`）。
   */
  auxTextures?: AlgoAuxRef[];
}

export interface PluginManifest {
  format: typeof PLUGIN_FORMAT;
  apiVersion: number;
  id: string;
  name: string;
  author: string | null;
  version: string | null;
  license: string | null;
  effects: PluginEffectDef[];
  generators: PluginGeneratorDef[];
  /**
   * 排版文档钩子（打开 / 保存 / 渲染前改写 doc）。
   *
   * 清单里写在 `typography.hooks`；校验后拍平成这个数组 —— 运行期只按
   * `phase` 查表，不需要「typography 还可能有别的字段」这层中间结构。
   */
  hooks: TypoHookDef[];
}

export type ValidateResult =
  | { ok: true; manifest: PluginManifest; warnings: PluginIssue[] }
  | { ok: false; issues: PluginIssue[] };

/* --------------------------------------------------------- 小工具 */

const PARAM_TYPES = new Set([
  'range',
  'select',
  'checkbox',
  'color',
  'bitmask',
  'pattern',
  'text',
  'asset',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 非空字符串。**空白串算空** —— 一个 `name: '   '` 的插件在列表里是一行空白，
 * 而「为什么这一行没有名字」没人查得出来。原样返回（不做 trim），
 * 免得把 `id` / 选项值这类**要精确匹配**的字段改掉。
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** 读一个可选文本字段：缺省 → null；给了但不是非空字符串 → null（不报错）。 */
function optionalText(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/* ----------------------------------------------------- 参数表校验 */

/**
 * 校验一项 `ParamDef`。返回 `null` 表示合法。
 *
 * 判据只有一条：**`Inspector.svelte` 的渲染分支会不会在它身上抛**。
 * 那里是 `{#if}` 链，未知类型会被静默跳过（不渲染），所以「未知类型」不算
 * 致命 —— 但缺 `options` 的 select 会直接 `undefined.map` 崩掉整块面板。
 */
function checkParam(raw: unknown, path: string): PluginIssue | null {
  if (!isObject(raw)) return { code: 'bad-param', path, detail: 'not-object' };
  const key = str(raw.key);
  if (!key) return { code: 'bad-param', path, detail: 'key' };
  if (!normalizeLabel(raw.labelKey)) return { code: 'bad-param', path, detail: 'labelKey' };
  if (raw.visibleWhen !== undefined && typeof raw.visibleWhen !== 'function') {
    return { code: 'bad-param', path, detail: 'visibleWhen' };
  }
  const type = str(raw.type);
  if (!type) return { code: 'bad-param', path, detail: 'type' };
  if (!PARAM_TYPES.has(type)) return { code: 'bad-param', path, detail: `type:${type}` };

  switch (type) {
    case 'range': {
      if (num(raw.min) === null) return { code: 'bad-param', path, detail: 'min' };
      if (num(raw.max) === null) return { code: 'bad-param', path, detail: 'max' };
      if (num(raw.step) === null) return { code: 'bad-param', path, detail: 'step' };
      if (num(raw.defaultValue) === null) return { code: 'bad-param', path, detail: 'defaultValue' };
      if (raw.curve !== undefined && num(raw.curve) === null) {
        return { code: 'bad-param', path, detail: 'curve' };
      }
      return null;
    }
    case 'select': {
      if (str(raw.defaultValue) === null) return { code: 'bad-param', path, detail: 'defaultValue' };
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        return { code: 'bad-param', path, detail: 'options' };
      }
      for (const [i, o] of raw.options.entries()) {
        if (!isObject(o) || str(o.value) === null || !normalizeLabel(o.labelKey)) {
          return { code: 'bad-param', path: `${path}.options[${i}]`, detail: 'option' };
        }
      }
      return null;
    }
    case 'checkbox': {
      if (num(raw.defaultValue) === null) return { code: 'bad-param', path, detail: 'defaultValue' };
      return null;
    }
    case 'color': {
      if (str(raw.defaultValue) === null) return { code: 'bad-param', path, detail: 'defaultValue' };
      return null;
    }
    case 'bitmask': {
      if (num(raw.bits) === null || (num(raw.bits) as number) <= 0) {
        return { code: 'bad-param', path, detail: 'bits' };
      }
      if (num(raw.defaultValue) === null) return { code: 'bad-param', path, detail: 'defaultValue' };
      if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
        return { code: 'bad-param', path, detail: 'groups' };
      }
      for (const [i, g] of raw.groups.entries()) {
        if (!isObject(g) || num(g.bits) === null || !normalizeLabel(g.labelKey)) {
          return { code: 'bad-param', path: `${path}.groups[${i}]`, detail: 'group' };
        }
        if (g.style !== 'eca' && g.style !== 'count') {
          return { code: 'bad-param', path: `${path}.groups[${i}]`, detail: 'style' };
        }
      }
      if (raw.presets !== undefined) {
        if (!Array.isArray(raw.presets)) return { code: 'bad-param', path, detail: 'presets' };
        for (const [i, o] of raw.presets.entries()) {
          if (!isObject(o) || num(o.value) === null || !normalizeLabel(o.labelKey)) {
            return { code: 'bad-param', path: `${path}.presets[${i}]`, detail: 'preset' };
          }
        }
      }
      return null;
    }
    case 'pattern': {
      if (typeof raw.defaultValue !== 'string') return { code: 'bad-param', path, detail: 'defaultValue' };
      if (raw.editorSize !== undefined && num(raw.editorSize) === null) {
        return { code: 'bad-param', path, detail: 'editorSize' };
      }
      if (raw.mode !== undefined && raw.mode !== '2d' && raw.mode !== '1d') {
        return { code: 'bad-param', path, detail: 'mode' };
      }
      return null;
    }
    case 'text': {
      if (typeof raw.defaultValue !== 'string') return { code: 'bad-param', path, detail: 'defaultValue' };
      if (raw.maxLength !== undefined && num(raw.maxLength) === null) {
        return { code: 'bad-param', path, detail: 'maxLength' };
      }
      if (raw.placeholderKey !== undefined && !normalizeLabel(raw.placeholderKey)) {
        return { code: 'bad-param', path, detail: 'placeholderKey' };
      }
      return null;
    }
    case 'asset': {
      // 值必须是 assetId 字符串（空串 = 未绑定）。只收静态图片，所以 `accept`
      // 只允许缺省或 'image' —— 写别的等于要求一种宿主给不出的素材。
      if (typeof raw.defaultValue !== 'string') return { code: 'bad-param', path, detail: 'defaultValue' };
      if (raw.accept !== undefined && raw.accept !== 'image') {
        return { code: 'bad-param', path, detail: 'accept' };
      }
      return null;
    }
    default:
      return null;
  }
}

/** 整张参数表：逐项校验 + 键唯一（重复键会让两个控件改同一个值）。 */
function checkParams(raw: unknown, path: string): PluginIssue[] {
  if (!Array.isArray(raw)) return [{ code: 'bad-param', path, detail: 'not-array' }];
  const out: PluginIssue[] = [];
  const seen = new Set<string>();
  for (const [i, p] of raw.entries()) {
    const issue = checkParam(p, `${path}[${i}]`);
    if (issue) {
      out.push(issue);
      continue;
    }
    const key = (p as { key: string }).key;
    if (seen.has(key)) out.push({ code: 'bad-param', path: `${path}[${i}]`, detail: `dup-key:${key}` });
    seen.add(key);
  }
  return out;
}

/** 一个 pre-pass。 */
function checkPrePass(raw: unknown, path: string): PluginIssue | null {
  if (!isObject(raw)) return { code: 'bad-shader', path, detail: 'not-object' };
  if (typeof raw.fragment !== 'string' || raw.fragment.trim().length === 0) {
    return { code: 'bad-shader', path, detail: 'fragment' };
  }
  for (const k of ['linearFilter', 'feedback', 'delayedInput']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') {
      return { code: 'bad-shader', path, detail: k };
    }
  }
  return null;
}

/**
 * 特效的着色器定义。
 *
 * 只查**结构**：`fragment` 是不是非空字符串、`setUniforms` 是不是函数、
 * pre-pass 数组的形状。GLSL 的语法/链接错误由真 GL 编译来回答
 * （`PluginHost` 在挂载时编译一遍），不在这里猜。
 */
function checkShader(raw: unknown, path: string): PluginIssue[] {
  if (!isObject(raw)) return [{ code: 'bad-shader', path, detail: 'not-object' }];
  const out: PluginIssue[] = [];
  if (typeof raw.fragment !== 'string' || raw.fragment.trim().length === 0) {
    out.push({ code: 'bad-shader', path, detail: 'fragment' });
  }
  if (typeof raw.setUniforms !== 'function') {
    out.push({ code: 'bad-shader', path, detail: 'setUniforms' });
  }
  if (raw.prePasses !== undefined) {
    if (!Array.isArray(raw.prePasses)) {
      out.push({ code: 'bad-shader', path, detail: 'prePasses' });
    } else {
      for (const [i, pp] of raw.prePasses.entries()) {
        const issue = checkPrePass(pp, `${path}.prePasses[${i}]`);
        if (issue) out.push(issue);
      }
    }
  }
  for (const k of ['feedback', 'hdrFeedback', 'linearFilter', 'opaqueOutput']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') {
      out.push({ code: 'bad-shader', path, detail: k });
    }
  }
  return out;
}

/* --------------------------------------------------- 生成器的 aux 纹理 */

/**
 * 宿主认识的 aux 种类（与 `AlgoAuxKind` 同值）。
 *
 * 不认识的值必须**拒收**而不是丢掉：丢掉之后那个 sampler 永远没有绑定的纹理，
 * 而画面看起来只是「没贴图」—— 作者不会想到是这里写错了。
 */
const AUX_KINDS = new Set(['glyph-atlas', 'asset-image', 'logo-sdf']);

/** GLSL 标识符（aux 的 uniform 名要能真的出现在着色器里）。 */
const UNIFORM_NAME = /^u_[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验 `generators[].auxTextures`。
 *
 * 三条判据都不是形式主义：
 *
 * - `uniform` 必须形如 `u_xxx`：运行时按这个名字 `getUniformLocation`，
 *   写成别的（如 `tex`）永远拿不到位置 ⇒ 静默不绑。
 * - `kind` 必须在白名单里（见上）。
 * - `assetParam` 必须指向**本 def 的一条 `asset` 型参数**。只查「键存在」不够：
 *   指向一个 range 参数时，运行时会把 `String(数值)` 当 assetId 去查素材，
 *   结果是这条 aux 永远缺席，且不报错。
 */
function checkAuxTextures(
  raw: unknown,
  path: string,
  assetParamKeys: Set<string>,
): PluginIssue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [{ code: 'bad-aux', path, detail: 'not-array' }];
  const out: PluginIssue[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isObject(item)) {
      out.push({ code: 'bad-aux', path: at, detail: 'not-object' });
      continue;
    }
    const uniform = str(item.uniform);
    if (!uniform || !UNIFORM_NAME.test(uniform)) {
      out.push({ code: 'bad-aux', path: at, detail: `uniform:${String(item.uniform ?? '')}` });
      continue;
    }
    // 同名两次 = 后一项覆盖前一项（Map 的写入顺序），那一条 aux 永远不会被绑。
    if (seen.has(uniform)) {
      out.push({ code: 'bad-aux', path: at, detail: `dup-uniform:${uniform}` });
      continue;
    }
    seen.add(uniform);
    const kind = str(item.kind);
    if (!kind || !AUX_KINDS.has(kind)) {
      out.push({ code: 'bad-aux', path: at, detail: `kind:${String(item.kind ?? '')}` });
      continue;
    }
    // 字形图集是运行时自己画的，不需要素材参数；另外两种必须绑一张图。
    if (kind === 'glyph-atlas') continue;
    const assetParam = str(item.assetParam);
    if (!assetParam || !assetParamKeys.has(assetParam)) {
      out.push({ code: 'bad-aux', path: at, detail: `assetParam:${String(item.assetParam ?? '')}` });
    }
  }
  return out;
}

/* ----------------------------------------------------- 文档钩子 */

/**
 * 校验 `typography.hooks`。
 *
 * 只查**结构**（id / name / phase / run）：钩子真正做什么由运行期回答，
 * 能不能跑由 `PluginHost.verify()` 在合成文档上真跑一次回答 —— 与着色器
 * 「结构在这里、编译在那里」是同一条分工。
 */
function checkHooks(raw: unknown): { issues: PluginIssue[]; hooks: TypoHookDef[] } {
  const issues: PluginIssue[] = [];
  const hooks: TypoHookDef[] = [];
  if (raw === undefined) return { issues, hooks };
  if (!isObject(raw)) {
    issues.push({ code: 'bad-hook', path: 'typography', detail: 'not-object' });
    return { issues, hooks };
  }
  const list = raw.hooks ?? [];
  if (!Array.isArray(list)) {
    issues.push({ code: 'bad-hook', path: 'typography.hooks', detail: 'not-array' });
    return { issues, hooks };
  }
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const at = `typography.hooks[${i}]`;
    if (!isObject(item)) {
      issues.push({ code: 'bad-hook', path: at, detail: 'not-object' });
      continue;
    }
    const id = str(item.id);
    if (!id || !isValidPluginSegment(id)) {
      issues.push({ code: 'bad-hook', path: at, detail: `id:${String(item.id ?? '')}` });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ code: 'duplicate-id', path: at, detail: id });
      continue;
    }
    const name = normalizeLabel(item.name);
    if (!name) {
      issues.push({ code: 'bad-hook', path: at, detail: 'name' });
      continue;
    }
    const phase = str(item.phase);
    if (!phase || !(TYPO_HOOK_PHASES as readonly string[]).includes(phase)) {
      issues.push({ code: 'bad-hook', path: at, detail: `phase:${String(item.phase ?? '')}` });
      continue;
    }
    if (typeof item.run !== 'function') {
      issues.push({ code: 'bad-hook', path: at, detail: 'run' });
      continue;
    }
    seen.add(id);
    hooks.push({
      id,
      name,
      phase: phase as TypoHookPhase,
      run: item.run as TypoHookRun,
    });
  }
  return { issues, hooks };
}

/* ------------------------------------------------------- 主入口 */

/**
 * 校验一个插件的导出物。
 *
 * **拒收（`ok: false`）与警告（`warnings`）的分界**：会不会让「挂上去之后
 * 界面/渲染出问题」。结构问题一律拒收整条插件（因为它多半是写错了字段名，
 * 半挂上去最难查）；分类/标签不认识只警告并丢掉那一项（条目本身是好的）。
 */
export function validateManifest(raw: unknown): ValidateResult {
  const issues: PluginIssue[] = [];
  const warnings: PluginIssue[] = [];

  if (!isObject(raw)) return { ok: false, issues: [{ code: 'not-object' }] };

  if (raw.format !== PLUGIN_FORMAT) {
    return { ok: false, issues: [{ code: 'bad-format', detail: String(raw.format ?? '') }] };
  }

  const apiVersion = num(raw.apiVersion);
  if (apiVersion === null || !Number.isInteger(apiVersion) || apiVersion < 1 || apiVersion > PLUGIN_API_VERSION) {
    return { ok: false, issues: [{ code: 'bad-api-version', detail: String(raw.apiVersion ?? '') }] };
  }

  const id = str(raw.id);
  if (!id || !isValidPluginSegment(id)) {
    return { ok: false, issues: [{ code: 'bad-id', detail: String(raw.id ?? '') }] };
  }

  const name = str(raw.name);
  if (!name) issues.push({ code: 'bad-name' });

  const effectsList = raw.effects ?? [];
  const generatorsList = raw.generators ?? [];
  const effectsIsArray = Array.isArray(effectsList);
  const generatorsIsArray = Array.isArray(generatorsList);
  if (!effectsIsArray) issues.push({ code: 'bad-list', path: 'effects' });
  if (!generatorsIsArray) issues.push({ code: 'bad-list', path: 'generators' });
  if (!effectsIsArray || !generatorsIsArray || issues.length > 0) return { ok: false, issues };
  const rawEffects = effectsList as unknown[];
  const rawGenerators = generatorsList as unknown[];

  const effects: PluginEffectDef[] = [];
  const generators: PluginGeneratorDef[] = [];
  const seen = new Set<string>();

  for (const [i, rawDef] of rawEffects.entries()) {
    const at = `effects[${i}]`;
    if (!isObject(rawDef)) {
      issues.push({ code: 'bad-def', path: at, detail: 'not-object' });
      continue;
    }
    const localId = str(rawDef.id);
    if (!localId || !isValidPluginSegment(localId)) {
      issues.push({ code: 'bad-def', path: at, detail: `id:${String(rawDef.id ?? '')}` });
      continue;
    }
    const label = normalizeLabel(rawDef.name);
    if (!label) {
      issues.push({ code: 'bad-def', path: at, detail: 'name' });
      continue;
    }
    if (seen.has(localId)) {
      issues.push({ code: 'duplicate-id', path: at, detail: localId });
      continue;
    }
    const paramIssues = checkParams(rawDef.params ?? [], `${at}.params`);
    const shaderIssues = checkShader(rawDef.shader, `${at}.shader`);
    if (paramIssues.length > 0 || shaderIssues.length > 0) {
      issues.push(...paramIssues, ...shaderIssues);
      continue;
    }

    let category: EffectCategory | null = null;
    if (rawDef.category !== undefined) {
      const c = str(rawDef.category);
      if (c && (EFFECT_CATEGORIES as string[]).includes(c)) category = c as EffectCategory;
      else warnings.push({ code: 'unknown-meta', path: at, detail: `category:${String(rawDef.category)}` });
    }

    const tags: EffectTag[] = [];
    if (rawDef.tags !== undefined) {
      if (!Array.isArray(rawDef.tags)) {
        warnings.push({ code: 'unknown-meta', path: at, detail: 'tags:not-array' });
      } else {
        for (const t of rawDef.tags) {
          if (typeof t === 'string' && (EFFECT_TAGS as string[]).includes(t)) tags.push(t as EffectTag);
          else warnings.push({ code: 'unknown-meta', path: at, detail: `tag:${String(t)}` });
        }
      }
    }

    seen.add(localId);
    effects.push({
      id: localId,
      name: label,
      desc: normalizeLabel(rawDef.desc),
      category,
      tags,
      params: (rawDef.params ?? []) as ParamDef[],
      shader: rawDef.shader as unknown as EffectShaderDef,
    });
  }

  for (const [i, rawDef] of rawGenerators.entries()) {
    const at = `generators[${i}]`;
    if (!isObject(rawDef)) {
      issues.push({ code: 'bad-def', path: at, detail: 'not-object' });
      continue;
    }
    const localId = str(rawDef.id);
    if (!localId || !isValidPluginSegment(localId)) {
      issues.push({ code: 'bad-def', path: at, detail: `id:${String(rawDef.id ?? '')}` });
      continue;
    }
    const label = normalizeLabel(rawDef.name);
    if (!label) {
      issues.push({ code: 'bad-def', path: at, detail: 'name' });
      continue;
    }
    if (seen.has(localId)) {
      issues.push({ code: 'duplicate-id', path: at, detail: localId });
      continue;
    }
    const paramIssues = checkParams(rawDef.params ?? [], `${at}.params`);
    if (paramIssues.length > 0) {
      issues.push(...paramIssues);
      continue;
    }
    if (typeof rawDef.fragment !== 'string' || rawDef.fragment.trim().length === 0) {
      issues.push({ code: 'bad-shader', path: at, detail: 'fragment' });
      continue;
    }
    if (typeof rawDef.setUniforms !== 'function') {
      issues.push({ code: 'bad-shader', path: at, detail: 'setUniforms' });
      continue;
    }
    // 参数表已经过完 checkParams，这里可以安全地按 ParamDef[] 读。
    const params = (rawDef.params ?? []) as ParamDef[];
    const assetParamKeys = new Set(
      params.filter((p) => p.type === 'asset').map((p) => (p as { key: string }).key),
    );
    const auxIssues = checkAuxTextures(rawDef.auxTextures, `${at}.auxTextures`, assetParamKeys);
    if (auxIssues.length > 0) {
      issues.push(...auxIssues);
      continue;
    }

    seen.add(localId);
    generators.push({
      id: localId,
      name: label,
      desc: normalizeLabel(rawDef.desc),
      params,
      fragment: rawDef.fragment,
      setUniforms: rawDef.setUniforms as AlgoSetUniforms,
      ...(rawDef.auxTextures ? { auxTextures: rawDef.auxTextures as AlgoAuxRef[] } : {}),
    });
  }

  const hookCheck = checkHooks(raw.typography);
  issues.push(...hookCheck.issues);
  const hooks = hookCheck.hooks;

  if (issues.length > 0) return { ok: false, issues };
  /*
   * 文档钩子是 **API v2** 才有的能力。声明了钩子却写着 apiVersion 1 的插件
   * 必须拒收：宿主会以为自己能跑，而钩子从来不会被调用 —— 那是「装上了、
   * 什么都没发生」，最难查的一类。
   */
  if (hooks.length > 0 && apiVersion < 2) {
    return {
      ok: false,
      issues: [{ code: 'bad-api-version', path: 'typography.hooks', detail: 'requires-v2' }],
    };
  }
  if (effects.length === 0 && generators.length === 0 && hooks.length === 0) {
    return { ok: false, issues: [{ code: 'no-defs' }] };
  }

  return {
    ok: true,
    warnings,
    manifest: {
      format: PLUGIN_FORMAT,
      apiVersion,
      id,
      name: name as string,
      author: optionalText(raw.author),
      version: optionalText(raw.version),
      license: optionalText(raw.license),
      effects,
      generators,
      hooks,
    },
  };
}

/**
 * 从模块的导出物里取清单。
 *
 * 同时接受 `export const plugin = …` 与 `export default …`：前者是文档里写的
 * 形式（自带名字，读代码时一眼看得出这是什么），后者是写起来最省事的形式。
 * 两个都没有时返回 `null`，由调用方翻译成一条可读的失败原因。
 */
export function manifestFromModule(mod: unknown): unknown {
  if (!isObject(mod)) return null;
  if ('plugin' in mod) return mod.plugin;
  if ('default' in mod) return mod.default;
  return null;
}
