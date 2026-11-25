/**
 * three/code.ts — three.js 片段代码的**契约、上限、编译与参数表**。纯函数，可单测。
 *
 * 这一层刻意不认识 WebGL、`engine/`、`three` 包本身：控制平面要拿它做写入前的
 * 语法检查、检查器要拿它列参数（没有渲染器、没有 `import('three')` 时也要能查），
 * 而渲染侧只在真正出图时才 `import('three')`。
 *
 * ## 为什么是「`create(THREE, ctx)` + 返回 scene/camera」
 *
 * 片段跑的是**模型写的代码**，所以契约必须窄到不可能写歪：
 *
 * - `THREE` 作为**参数**传进来，不让它写 import —— 项目里没有模块解析给这段代码用。
 * - 场景与相机由代码自己建、自己返回。渲染器、尺寸、时钟全由宿主管，
 *   模型只需要回答「这一帧画什么」。
 * - 唯一的动画入口是 `update(t, frame)`，`t` 是**片段内秒**。不给 delta、
 *   不给 Clock —— 给了 delta 就等于允许「累加式动画」，那种东西 seek 之后
 *   和正放不是同一幅画面。
 *
 * ## 参数为什么是 `params()` 而不是一串注释里的约定
 *
 * 参数表要**同时**给三个消费方：检查器（画控件）、控制平面（校验写入）、渲染侧
 * （把值塞进 `ctx.params`）。让它住在代码里，三个消费方读的是同一份真相 ——
 * 而不是「代码里改了名字，界面上还挂着旧滑块」。`params()` 是纯函数，执行它
 * 不需要 THREE（契约里写死了）。
 */

import { labelText, type Label } from '../i18n/label';

/**
 * 代码体积上限（字符数 ≈ UTF-16 码元）。
 *
 * 1 Mi 字符（ASCII 下约 1 MB）。它**不再受工具结果约束**：`get_scene` 对超过
 * `THREE_CODE_SCENE_INLINE_MAX` 的代码只给大小与行数，正文走 `three_view` /
 * `three_grep`。留着这条线是为了挡住「把整份素材 / base64 塞进代码」。
 */
export const THREE_CODE_MAX_CHARS = 1024 * 1024;

/**
 * `get_scene` 原样带回代码的上限。
 *
 * 工具结果统一截断在 20000 字符（`TOOL_TEXT_LIMIT`），超过它的代码被截断后
 * 再写回去就是一段半截程序。所以超过这一条线时快照只给 `codeChars` /
 * `codeLines`，正文用 `three_view` 分页读。
 */
export const THREE_CODE_SCENE_INLINE_MAX = 16 * 1024;

/** 参数字符串值（颜色 / 选项 / 文案）的长度上限。 */
export const THREE_PARAM_VALUE_MAX = 128;

/** 传给 `create(THREE, ctx)` 的 ctx。字段只增不改 —— 模型的代码依赖它。 */
export interface ThreeApiContext {
  /** 渲染宽度（px）。预览 ≈960、导出 = 工程分辨率 —— 会变。 */
  width: number;
  /** 渲染高度（px）。 */
  height: number;
  fps: number;
  /** 工程种子。想要可复现的随机就从它派生（不给 `Math.random()` 的替代品）。 */
  seed: number;
  /** 片段时长（秒）。 */
  duration: number;
  clipId: string;
  /** three 的 `WebGLRenderer`。所有 three 片段共用一台，别改它的像素比 / renderTarget。 */
  renderer: unknown;
  /**
   * 当前参数值（已合并默认值、已按 `params()` 的区间夹好）。
   *
   * **同一个对象每帧就地更新** —— 所以 `create` 里存下的引用一直有效，
   * 代码不必每帧重新取。
   */
  params: Record<string, number | string>;
  /**
   * 工程素材（只支持**图片**）→ three 纹理。未解码好返回 `null`。
   *
   * 每帧调都行（内部按 assetId 缓存，素材换了才重建）。**不要把 null 缓存下来**：
   * 素材是异步解码的，这一帧拿不到、下一帧就有了（就绪会触发重绘）。
   */
  texture: (assetId: string) => unknown | null;
}

/* ------------------------------------------------------------------ 参数表 */

export type ThreeParamType = 'range' | 'select' | 'checkbox' | 'color' | 'asset';

export interface ThreeParamOption {
  value: string;
  label: Label;
}

/**
 * 代码声明的参数（已归一化）。形状刻意与 `effects/types.ts::ParamDef` 对齐 ——
 * 检查器与关键帧那套控件直接吃它，不必再写一套。
 */
export interface ThreeParamDef {
  key: string;
  type: ThreeParamType;
  label: Label;
  defaultValue: number | string;
  /** `range` 专用。 */
  min?: number;
  max?: number;
  step?: number;
  /** `select` 专用。 */
  options?: ThreeParamOption[];
  /**
   * `asset` 专用。值是**素材 id**（空串 = 未绑），拿它去问 `ctx.texture()`。
   *
   * 只收图片：视频素材在 three 侧没有解码路径（契约里 `ctx.texture` 对视频
   * 恒返回 null），接受它只会得到一片空场景。
   */
  accept?: 'image';
  /**
   * 改这个键要**重建场景**（几何分段数、粒子数这类）。
   *
   * 缺省 false：值只是塞进 `ctx.params`，不重建 —— 拖滑杆时不应该每帧重建
   * 一遍场景（那是「面板一拖就卡」的来源）。
   */
  rebuild?: boolean;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function shortText(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s || fallback).slice(0, THREE_PARAM_VALUE_MAX);
}

/**
 * 把代码里 `params()` 的返回值**归一化**成可用的定义表。
 *
 * 永不抛：模型写歪（缺 key、type 打错、区间反了）时逐条丢弃或夹取，剩下的照用。
 * 一个坏参数不该让整个片段变成空白。
 */
export function normalizeThreeParams(raw: unknown): ThreeParamDef[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreeParamDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const key = typeof it.key === 'string' ? it.key.trim().slice(0, 64) : '';
    if (!key || seen.has(key)) continue;
    const label = labelText(shortText(it.label, key));
    const rebuild = it.rebuild === true;
    const type = it.type;

    if (type === 'range') {
      let min = num(it.min, 0);
      let max = num(it.max, 1);
      if (min > max) [min, max] = [max, min];
      if (max - min < 1e-9) max = min + 1;
      const step = Math.abs(num(it.step, (max - min) / 100)) || (max - min) / 100;
      const defaultValue = clamp(num(it.defaultValue, min), min, max);
      out.push({
        key,
        type: 'range',
        label,
        defaultValue,
        min,
        max,
        step: clamp(step, 1e-6, max - min),
        rebuild,
      });
      seen.add(key);
      continue;
    }

    if (type === 'select') {
      const opts: ThreeParamOption[] = [];
      const rawOpts = Array.isArray(it.options) ? it.options.slice(0, 32) : [];
      for (const o of rawOpts) {
        if (!o || typeof o !== 'object') continue;
        const oo = o as Record<string, unknown>;
        const value = shortText(oo.value, '');
        if (!value) continue;
        opts.push({ value, label: labelText(shortText(oo.label, value)) });
      }
      if (!opts.length) continue;
      const wanted = shortText(it.defaultValue, opts[0]!.value);
      const defaultValue = opts.some((o) => o.value === wanted) ? wanted : opts[0]!.value;
      out.push({ key, type: 'select', label, defaultValue, options: opts, rebuild });
      seen.add(key);
      continue;
    }

    if (type === 'checkbox') {
      const defaultValue = num(it.defaultValue, 0) ? 1 : 0;
      out.push({ key, type: 'checkbox', label, defaultValue, rebuild });
      seen.add(key);
      continue;
    }

    if (type === 'color') {
      const wanted = shortText(it.defaultValue, '#ffffff');
      const defaultValue = HEX_RE.test(wanted) ? wanted.toLowerCase() : '#ffffff';
      out.push({ key, type: 'color', label, defaultValue, rebuild });
      seen.add(key);
      continue;
    }

    if (type === 'asset') {
      /*
       * 素材 id 是**不透明字符串**：不校验存在性（那要问工程，`code.ts` 不认识
       * 工程），也不裁剪格式 —— 只挡住超长与空白。空串是合法值（= 未绑）。
       */
      out.push({ key, type: 'asset', label, defaultValue: shortText(it.defaultValue, ''), accept: 'image', rebuild });
      seen.add(key);
    }
  }
  return out;
}

/** 把一个值按定义夹取成合法值。写入口与求值口共用这一份。 */
export function coerceThreeValue(def: ThreeParamDef, value: unknown): number | string {
  switch (def.type) {
    case 'range':
      return clamp(num(value, Number(def.defaultValue)), def.min ?? 0, def.max ?? 1);
    case 'checkbox':
      // 布尔直接认（JSON 里 `true` 很常见），其余按数字真值；NaN 退回默认。
      if (typeof value === 'boolean') return value ? 1 : 0;
      return num(value, Number(def.defaultValue)) !== 0 ? 1 : 0;
    case 'select': {
      const s = typeof value === 'string' ? value : String(def.defaultValue);
      return (def.options ?? []).some((o) => o.value === s) ? s : def.defaultValue;
    }
    case 'color': {
      const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return HEX_RE.test(s) ? s : def.defaultValue;
    }
    case 'asset':
      // 空串合法（解绑）；非字符串一律当成「没绑」，不把数字 id 变成幽灵引用。
      return typeof value === 'string' ? value.trim().slice(0, THREE_PARAM_VALUE_MAX) : '';
  }
}

/**
 * 合并出这一帧真正给代码看的值：**只含定义表里的键**（代码删掉的参数不会以
 * 幽灵键的形式留在 `ctx.params` 里），每个都夹过。
 */
export function mergeThreeParams(
  defs: readonly ThreeParamDef[],
  values: Record<string, number | string> | undefined,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const d of defs) out[d.key] = coerceThreeValue(d, values?.[d.key]);
  return out;
}

/**
 * 需要重建场景的那几个键的签名。值变了 → 重建；其余参数变了 → 只改 `ctx.params`。
 * 用字符串而不是对象比较：调用方每帧都要判断，深比较不值。
 */
export function threeRebuildSignature(
  defs: readonly ThreeParamDef[],
  values: Record<string, number | string> | undefined,
): string {
  let sig = '';
  for (const d of defs) {
    if (!d.rebuild) continue;
    sig += `${d.key}=${coerceThreeValue(d, values?.[d.key])};`;
  }
  return sig;
}

export interface ThreeCompileOk {
  ok: true;
  /** 调用即执行用户的 `create`。渲染侧与试跑都走它。 */
  run: (THREE: unknown, ctx: ThreeApiContext) => unknown;
  /** 只读参数表：不执行 `create`，也不需要 THREE。 */
  readParams: () => unknown;
}

export interface ThreeCompileErr {
  ok: false;
  error: string;
}

export type ThreeCompile = ThreeCompileOk | ThreeCompileErr;

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * 编译一段 three 片段代码。
 *
 * 包裹体只做一件事：把 `create` / `params` 摘出来交回去，其它一概不碰。
 * 两者都缺席时不在这里报错 —— 语法检查的职责是「编译不过」，不是「写得不对」。
 */
export function compileThreeCode(code: string): ThreeCompile {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'code is empty' };
  }
  if (code.length > THREE_CODE_MAX_CHARS) {
    return {
      ok: false,
      error: `code is ${code.length} chars, limit is ${THREE_CODE_MAX_CHARS}`,
    };
  }
  let read: () => { create: unknown; params: unknown };
  try {
    /*
     * 末尾那个 `return` 前的空行是必须的：代码最后一行可能是 `//` 注释。
     * 返回一个对象而不是直接调 create —— 因为 `params()` 也要能被单独调到，
     * 而它不该触发 `create` 的任何副作用。
     */
    read = new Function(
      'THREE',
      'ctx',
      `"use strict";\n${code}\n;return {
        create: typeof create === "function" ? create : null,
        params: typeof params === "function" ? params : null,
      };`,
    ) as () => { create: unknown; params: unknown };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  return {
    ok: true,
    run: (THREE, ctx) => {
      const api = read();
      return typeof api.create === 'function' ? (api.create as (T: unknown, C: unknown) => unknown)(THREE, ctx) : null;
    },
    readParams: () => {
      const api = read();
      return typeof api.params === 'function' ? (api.params as () => unknown)() : null;
    },
  };
}

/**
 * 参数表缓存。键是**代码字符串**本身。
 *
 * 检查器每次重绘都会问一次（它是 `$derived`），而 `new Function` + 调一次用户
 * 代码虽然不贵，但每帧都做就是白烧。缓存还顺带保证了**同一份代码拿到同一个
 * 数组引用**，Svelte 的依赖比较不会因为「内容一样但对象新」而无休止重算。
 */
const paramCache = new Map<string, ThreeParamDef[]>();
const PARAM_CACHE_MAX = 32;

/** 读一份代码的参数表。Never throws；编译失败或 `params()` 抛错都给空表。 */
export function readThreeParams(code: string): ThreeParamDef[] {
  const hit = paramCache.get(code);
  if (hit) return hit;
  let defs: ThreeParamDef[] = [];
  const compiled = compileThreeCode(code);
  if (compiled.ok) {
    try {
      defs = normalizeThreeParams(compiled.readParams());
    } catch {
      // `params()` 抛错 = 没有参数可用。别把它变成「整个片段不可编辑」的错误。
      defs = [];
    }
  }
  paramCache.set(code, defs);
  if (paramCache.size > PARAM_CACHE_MAX) {
    const oldest = paramCache.keys().next().value;
    if (oldest !== undefined) paramCache.delete(oldest);
  }
  return defs;
}

/**
 * 模型看到的契约（能力清单与工具描述共用）。
 *
 * 写在这里而不是各写一份：工具表有两个（应用内 / MCP），能力清单还有一个，
 * 三份手写必然漂。改动这里等于同时改了给模型看的说明书。
 */
export const THREE_CODE_CONTRACT = `A three.js clip is a JavaScript function body that defines create(THREE, ctx) and returns { scene, camera, update?, resize?, dispose? }. It MAY also define params().

function params() {
  return [
    { key: 'hue', type: 'range', label: 'Hue', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], defaultValue: 'a' },
  ];
}

function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.set(0, 0, 6);
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 160, 32), new THREE.MeshNormalMaterial());
  scene.add(mesh);
  return {
    scene, camera,
    update(t, frame) { mesh.rotation.set(t * 0.9, t * 0.6, 0); },
  };
}

- update(t, frame): t is CLIP-LOCAL seconds (0 at the clip start), frame = round(t * fps). Called once per rendered frame; the order can jump (scrubbing / export seek). Derive the pose from t, not from accumulated deltas.
- Two shapes are equally valid: a scene graph (meshes + lights + a real camera), or ONE fullscreen quad with a ShaderMaterial and your own GLSL. Raymarched / SDF looks are usually cheaper and sharper as a fullscreen shader — do not build geometry just to fake them.
- ctx: { width, height, fps, seed, duration, clipId, renderer, params, texture }. width/height change between preview and export sizes — return resize(w, h) if the scene depends on them (the camera aspect is updated for you otherwise).
- params(): OPTIONAL, and do not add it by reflex. Expose a knob only when a human would want to tweak it and the code cannot know the answer — light intensity / colour, camera framing (distance, field of view, roll), and knobs of a genuinely procedural look (density, warp, palette). Do NOT expose values that the animation itself drives over time, and do not turn every constant into a slider. Zero params is a perfectly good clip.
  Types: 'range' (min/max/step/defaultValue, numbers), 'select' (options [{value,label}], defaultValue string), 'checkbox' (defaultValue 0|1), 'color' (defaultValue '#rrggbb'), 'asset' (defaultValue is an IMAGE asset id, '' = none). Values arrive in ctx.params (same object each frame, already clamped). Add rebuild: true ONLY when the value changes geometry structure (segment counts, instance counts) — those rebuild the scene on change.
- ctx.texture(assetId): project IMAGE assets as THREE.Texture (video assets return null). Textures are cached per asset and rebuilt when the asset changes; calling it every frame is fine. It returns null until the image is decoded — do not cache the null. Feed it from an 'asset' param: ctx.texture(String(ctx.params.logoAsset ?? '')). The texture's image is the decoded source, so you can draw it to a 2D canvas to trace a silhouette.
- Nothing on screen? three_status reports drawCalls and filled. drawCalls=0 = nothing drawable in the scene (or all culled); drawCalls>0 with filled=0 = it DID draw but every pixel is transparent or black (camera at/behind the near plane, vertex shader writing w=0, material alpha 0). None of those throw, so check the numbers before rewriting the scene.
- No imports, no network, no asset loaders beyond ctx.texture, no addons (OrbitControls / GLTFLoader / postprocessing are NOT available). Build geometry and textures procedurally.
- All three clips share one WebGLRenderer: do not call setPixelRatio / setRenderTarget / setSize on it.
- Determinism is not required, but Math.random() will make exports differ from the preview. Derive randomness from ctx.seed.`;
