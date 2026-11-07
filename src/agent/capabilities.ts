/**
 * capabilities.ts — 能力发现（方案 §3.2 的 `getCapabilities`）。
 *
 * **它是 agent 选择合法 id 的唯一依据**：工具面不接受「自由字符串当 defId」，
 * 网关侧也要按这份清单校验（方案 §4.4）。着色器是惰性编译的 —— 语法错误在你
 * 点到它之前不报 —— 所以「先看清单再挂特效」是 agent 唯一能提前发现自己选错
 * 的手段。
 *
 * ## `detail: 'params'`（v2 新增）
 *
 * `ids` 档只给 id（省上下文）；`params` 档给**参数表**：键 / 类型 / 区间 /
 * 选项 / 默认值。没有它，agent 给 `set_params` 填参数只能靠报错试错，而
 * 未知键会被控制平面直接拒掉。
 *
 * 序列化时**剥掉 `visibleWhen`**（函数，过不了 JSON，也没有必要给客户端执行）。
 */

import { BLEND_MODES } from '../core/schema';
import { MASK_CHANNELS, MAX_MASK_DEPTH } from '../core/mask';
import { EXPR_FUNCS } from '../core/expr';
import { MAX_MODULATORS, MOD_DEFAULT_GAIN } from '../core/modulation';
import { EFFECT_CATALOG, structuralTags } from '../effects/catalog';
import { effectRegistryRevision, getEffect, listEffects } from '../effects/registry';
import { algoRegistryRevision, getGenerator, listGenerators } from '../algos/registry';
import { listTransitions } from '../effects/transitions/registry';
import type { ParamDef } from '../effects/types';
import type { ExprFnView } from './types';
import { resolveLabel } from '../i18n/label';
import { tr } from '../i18n/index.svelte';
import { BUILTIN_THEMES, THEME_SLOTS, themeDisplayName, themeIds, type TypographyTheme } from '../typography/theme';
import { ANIM_PRESETS } from '../typography/animation';
import { ANIM_CHANNELS, CHANNEL_META } from '../typography/animation-tracks';
import { SCRIPT_LIMITS } from '../typography/script/model';
import { SCRIPT_TEMPLATES } from '../typography/script/templates';
import { SVG_GENERATORS, defaultsOf } from '../typography/svg-gen/registry';
import { shapeParamSupport } from '../typography/shapes';
import { IMAGE_FILTERS } from '../typography/image-effects';
import {
  DEFAULT_FONT_FAMILY,
  MIX_BLENDS,
  SHAPE_KINDS,
  TEXTURE_PATTERNS,
} from '../typography/document';
import type {
  Capabilities,
  CapabilityDetail,
  EffectCapability,
  GeneratorCapability,
  ParamSchema,
  TransitionCapability,
  TypographyCapabilities,
} from './types';

/** 允许的 fit / 曲线模式 / 源类型：与 `schema.ts` 的联合类型一一对应。 */
const FITS: Capabilities['fits'] = ['contain', 'cover', 'stretch'];
const CURVE_MODES: Capabilities['curveModes'] = ['keyframe', 'impulse', 'follower'];
const SOURCE_TYPES: Capabilities['sourceTypes'] = ['video', 'image', 'algo', 'text', 'solid'];

/* -------------------------------------------------------- 参数表序列化 */

/** `ParamDef` → JSON 安全的 `ParamSchema`（剥离 `visibleWhen`）。 */
export function serializeParam(p: ParamDef): ParamSchema {
  const base: ParamSchema = {
    key: p.key,
    label: resolveLabel(p.labelKey, tr),
    type: p.type,
    defaultValue: p.defaultValue,
    curvable: p.type === 'range',
  };
  switch (p.type) {
    case 'range':
      base.min = p.min;
      base.max = p.max;
      base.step = p.step;
      if (p.curve !== undefined) base.curve = p.curve;
      break;
    case 'select':
      base.options = p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }));
      break;
    case 'bitmask':
      base.bits = p.bits;
      base.groups = p.groups.map((g) => ({
        label: resolveLabel(g.labelKey, tr),
        bits: g.bits,
        style: g.style,
      }));
      if (p.presets) {
        base.presets = p.presets.map((x) => ({ label: resolveLabel(x.labelKey, tr), value: x.value }));
      }
      break;
    case 'pattern':
      if (p.editorSize !== undefined) base.editorSize = p.editorSize;
      if (p.mode) base.mode = p.mode;
      break;
    case 'text':
      if (p.maxLength !== undefined) base.maxLength = p.maxLength;
      if (p.multiline) base.multiline = true;
      if (p.placeholderKey) base.placeholder = resolveLabel(p.placeholderKey, tr);
      break;
    default:
      break;
  }
  return base;
}

export function serializeParams(params: readonly ParamDef[] | undefined): ParamSchema[] {
  return (params ?? []).map(serializeParam);
}

/* ------------------------------------------------------------- 能力清单 */

/**
 * 清单在**插件挂载之前**是常量（内置注册表在模块加载时建好，glob 是 eager 的），
 * 所以算一次就够 —— 但要跟着两个注册表的 `revision` 失效：插件挂载后 agent
 * 必须立刻能发现新的 id，否则它手里那份清单会把新特效/生成器当成非法 id 拒掉。
 *
 * 缓存的是**纯数据**，不是「运行期实例」—— 后者绝不能缓存。判断 `!==` 而不是
 * `>`：两个注册表的计数是独立的，任一个变了都得重算。
 */
let cached: Capabilities | null = null;
let cachedRevision = -1;
let cachedDetail: CapabilityDetail = 'ids';

function generatorCapability(id: string, detail: CapabilityDetail): GeneratorCapability {
  const entry = listGenerators().find((g) => g.id === id)!;
  const out: GeneratorCapability = { id, kind: entry.kind, pluginId: entry.pluginId };
  if (detail === 'params') {
    out.name = resolveLabel(entry.nameKey, tr);
    if (entry.desc) out.desc = resolveLabel(entry.desc, tr);
    out.params = serializeParams(getGenerator(id)?.params);
  }
  return out;
}

function effectCapability(id: string, detail: CapabilityDetail): EffectCapability {
  const entry = listEffects().find((e) => e.id === id)!;
  const def = getEffect(id);
  const out: EffectCapability = { id, pluginId: entry.pluginId };
  if (detail === 'params') {
    out.name = resolveLabel(entry.nameKey, tr);
    const cat = def?.meta?.category ?? EFFECT_CATALOG[id]?.category ?? null;
    out.category = cat;
    const descKey = EFFECT_CATALOG[id]?.descKey;
    if (def?.meta?.desc) out.desc = resolveLabel(def.meta.desc, tr);
    else if (descKey) out.desc = tr(descKey);
    out.tags = [
      ...new Set([...(def ? structuralTags(def.shader) : []), ...(def?.meta?.tags ?? [])]),
    ];
    out.params = serializeParams(def?.params);
    if (def) {
      out.flags = {
        feedback: Boolean(def.shader.feedback),
        prePasses: def.shader.prePasses?.length ?? 0,
        stateful: Boolean(def.shader.stateful),
        hdrFeedback: Boolean(def.shader.hdrFeedback),
        opaqueOutput: Boolean(def.shader.opaqueOutput),
        // 缺省就是 'composite'：所有特效都能接蒙版，只有少数把蒙版当自己的输入。
        mask: def.shader.mask ?? 'composite',
      };
    }
  }
  return out;
}

function transitionCapability(id: string, detail: CapabilityDetail): TransitionCapability {
  const entry = listTransitions().find((t) => t.id === id)!;
  const out: TransitionCapability = { id };
  if (detail === 'params') {
    out.name = entry.id;
    out.author = entry.author;
    out.license = entry.license;
    out.params = entry.params.map((p) => ({
      key: p.key,
      label: p.label,
      type: p.type,
      ...(p.min === undefined ? {} : { min: p.min }),
      ...(p.max === undefined ? {} : { max: p.max }),
      ...(p.step === undefined ? {} : { step: p.step }),
      defaultValue: p.defaultValue,
    }));
  }
  return out;
}

/**
 * @param opt.detail `ids`（默认）或 `params`
 * @param opt.ids 只给这几条（按 id 过滤；未知 id 被忽略）。省略 = 全部。
 *   参数表可以很大（70+ 特效 × 十几项），所以 agent 应当先取 id 再按需展开。
 */
/**
 * 表达式词汇表（名字 + 参数个数）。工具表、能力清单、`list_modulators` 共用这一份 ——
 * 三处各列一遍的形态是「模型按清单写了一行，工具拒了」。
 */
export function exprFunctions(): ExprFnView[] {
  return Object.entries(EXPR_FUNCS).map(([name, arity]) => ({ name, arity }));
}

export function getCapabilities(opt?: { detail?: CapabilityDetail; ids?: string[] }): Capabilities {
  const detail = opt?.detail ?? 'ids';
  const revision = effectRegistryRevision() + algoRegistryRevision();
  const wantAll = !opt?.ids || opt.ids.length === 0;
  const only = new Set(opt?.ids ?? []);

  // 只有「全量 + 同一档位」才走缓存；按 id 过滤是一次性小查询。
  if (wantAll && cached && cachedRevision === revision && cachedDetail === detail) return cached;

  const keep = (id: string) => wantAll || only.has(id);
  const out: Capabilities = {
    generators: listGenerators()
      .filter((g) => keep(g.id))
      .map((g) => generatorCapability(g.id, detail)),
    effects: listEffects()
      .filter((e) => keep(e.id))
      .map((e) => effectCapability(e.id, detail)),
    transitions: listTransitions()
      .filter((t) => keep(t.id))
      .map((t) => transitionCapability(t.id, detail)),
    blendModes: [...BLEND_MODES.map((b) => b.id)],
    fits: [...FITS],
    curveModes: [...CURVE_MODES],
    sourceTypes: [...SOURCE_TYPES],
    features: {
      /*
       * 手动节奏点（v5）。三条模型最容易猜错的：单位是秒、可以不等距、
       * 与 beatGrid 完全无关（写它不会改 BPM，也不会影响任何音频特征）。
       */
      beatMarks: {
        entity: 'Project.beatMarks',
        unit: 'seconds',
        sorted: true,
        uniform: false,
        snappedByTimeline: true,
        changesBeatGrid: false,
      },
      transitions: { sides: ['in', 'out'], transparentSide: true, shadowedBy: 'out' },
      videoPreclip: { ranges: true, frameAccurate: true, activeRange: true },
      videoAudio: {
        embeddedByDefault: true,
        detachToTrack: true,
        linkLock: true,
        gainDb: [-60, 12],
        fades: true,
        // v15：片段级静音（set_clip_audio.muted）与轨道级静音（set_track.muted）。
        muted: true,
        trackMute: 'visual tracks only',
      },
      modulation: {
        entity: 'Project.modulators',
        scope: 'project',
        funcs: exprFunctions(),
        modes: ['add', 'mul'],
        shape: '{ key: [{ ref: modulatorId, gain: number, mode: "add" | "mul" }] } on ClipBase.mods',
        defaultGain: MOD_DEFAULT_GAIN,
        maxModulators: MAX_MODULATORS,
        cycleValue: 0,
      },
      /*
       * 变速（v14）。两条容易猜错的：①`set_clip_props({ speed })` 保持片段
       * 长度（只改「这段时间里放多少素材」），只有素材不够时才缩短；
       * ②负速度只能走关键帧曲线（静态字段必须为正）。
       */
      videoSpeed: {
        staticField: 'source.speed',
        curveKey: 'speed',
        range: [0.05, 100],
        negativeSpeed: 'curve-only',
        keepsClipLength: true,
        shrinksWhenSourceShort: true,
      },
      /*
       * 外部蒙版（v19）。两条 agent 容易猜错的：①它是**实例级**的，同一片段
       * 的两个模块可以吃不同来源；②`kind: 'clip'` 会把被引用片段拉进这一帧
       * 的渲染序（是一次真实的额外渲染），不是「拿一张已有的图」。
       */
      mask: {
        inputKey: 'mask',
        kinds: ['clip', 'asset', 'none'],
        channels: [...MASK_CHANNELS],
        maxDepth: MAX_MASK_DEPTH,
        cycleRejected: true,
        /**
         * 两种用法，按**特效**分：`composite`（缺省，所有特效）在链上做
         * `mix(输入, 输出, mask)` —— 也就是「只在这一块生效」；`input` 是那个特效
         * 自己把 `u_mask` 当输入解释（色相选取用它收窄键）。agent 不需要区分，
         * 只要知道「每个特效都能接」。
         */
        modes: ['composite', 'input'],
        defaultMode: 'composite',
        shape: "set_params({ mask: { kind: 'clip', clipId, channel } | { kind: 'asset', assetId, channel } | { kind: 'none' } | null })",
      },
    },
  };

  if (wantAll) {
    cached = out;
    cachedRevision = revision;
    cachedDetail = detail;
  }
  return out;
}

/* --------------------------------------------------------- 排版能力清单 */

/**
 * 排版侧的能力清单：图形种类、22 个程序化生成器、配色方案、可控属性。
 *
 * 与特效清单同理：`params` 是 agent 唯一能知道自己「能调什么」的地方。
 * **纯函数**（自定义配色由调用方传进来），可以在单测里跑。
 */
export function getTypographyCapabilities(custom: readonly TypographyTheme[] | null): TypographyCapabilities {
  return {
    shapeKinds: [...SHAPE_KINDS],
    shapeParams: Object.fromEntries(SHAPE_KINDS.map((k) => [k, shapeParamSupport(k)])),
    /*
     * 单位说明是**能力清单的一部分**，不是注释：参数表只给区间与默认值，
     * 而 agent 真正会猜错的是「0.1 是比例还是 10px」。写在这里的每一条都
     * 对应一个会静默出错的实际语义（见 typography/shapes.ts）。
     */
    units: {
      frame:
        'x / y / w / h are document pixels (top-left origin). rot is RADIANS, ' +
        'rotated around the box centre. w / h are the unrotated box.',
      canvas:
        '`typo_set_canvas_size({ size })` is `doc.size` in pixels (the design resolution, >= 2). ' +
        '`scaleContent:true` also rescales every element (frame / font size / letter spacing / ' +
        'stroke width / shadow / blur / 3D px) by w-ratio and h-ratio — that is "change the ' +
        'format". `scaleContent:false` only changes the canvas: elements keep their pixel ' +
        'positions, so the composition shifts and anything outside is cropped.',
      groupBox:
        'A typography group owns one backing box: fill (Paint), stroke (Stroke or null), radius ' +
        '(px) and padding (px, the shell is this much larger than the members). `typo_update_group` ' +
        'takes `{ name, fill, stroke, radius, padding }`; `stroke:null` removes the border.',
      shapeRadius: 'corner / vertex radius in document px (not a ratio).',
      shapeInner:
        'wall thickness in document px (not a ratio). Default = short side × 0.1 for ' +
        '`frame`, × 0.18 for `ring`; clamped so the hole cannot collapse.',
      shapeSides: 'vertex count (3..64). Only polygon / star use it.',
      shapeWaist: 'star valley radius as a ratio of the outer radius (0..1).',
      shapeAngle: 'pie sweep in degrees (1..360).',
      generator:
        'Generator params are authored in a 0..100 square box that is then stretched to ' +
        'the element frame. Length-like values (width / tickWidth / bandWidth / gaps in ' +
        'the bar generators) are in that box: on a square frame 1 ≈ 1% of the side; on a ' +
        'non-square frame x distances scale with the frame width and y distances with the ' +
        'height, so the pattern is stretched rather than letterboxed. Values whose range ' +
        'is 0..1 are ratios of that box. Per-generator `notes` flag the cases where a ' +
        'parameter is clamped or scaled differently. **Paint generators with `fill`**: ' +
        'their path is a set of closed shapes, so a `stroke` traces every outline and, at ' +
        'bar widths below ~1 box unit, neighbouring outlines merge into a solid block.',
      text:
        'fontSize is px. letterSpacing is px (NOT em): 8 means 8px between glyphs. ' +
        'lineHeight is a MULTIPLIER of fontSize (1.2 = 120%), not px. fontWeight is 100..900. ' +
        'glyphStroke.width and boxStroke.width are px. shadows dx/dy/blur are document px. ' +
        'rot on a frame is radians, but a text element has no rotation field of its own — ' +
        'frame.rot is the only rotation and it is applied around the box centre. ' +
        'autoHeight:true means the box width is fixed and the height follows the text. ' +
        'Inline rich text lives in `runs: [{ text, style? }]`; style keys are fontFamily / fontSize (px) / ' +
        'fontWeight / fontStyle / letterSpacing (px) / color / textDecoration / highlight — anything ' +
        'omitted inherits the element style. `runs` is only returned when a run overrides something; ' +
        'otherwise send `text`.',
      shapePath:
        '`path` is only read when `shape:"svg"`. Default coordinate space is 0..100 authored and ' +
        'stretched to the frame; `pathUnit:"px"` means the path is already in the element\'s own ' +
        'pixel box (text-outline paths need this — 0..100 would stretch their stroke). Writing ' +
        '`path` drops the generator binding (`gen`), i.e. it bakes the shape.',
      transform3d:
        'Element-level 3D. perspective is px (0 = orthographic); translate is px (z = depth); ' +
        'rotate / skew are DEGREES; scale is a multiplier; origin is 0..1 of the element box ' +
        '(CSS transform-origin). Order is FIXED: perspective → translate3d → rotateX → rotateY → ' +
        'rotateZ → skewX → skewY → scale3d (rotate.z adds to frame.rot, both are around Z). ' +
        'On a patch it MERGES (send only the sub-objects you want to change); null removes 3D. ' +
        'Note transform-origin is per element, so several tilted elements in one row each need ' +
        'their own transform3d. Combine with shadows carefully: filter makes preserve-3d flat.',
      camera:
        '`typo_set_camera({ camera })` sets the BASE pose of the document-level camera: x / y are pan ' +
        'in document px from the canvas centre (+x = the camera looks right, so depth>0 elements slide ' +
        'LEFT), zoom is magnification 0.05..40, rot is roll in DEGREES (not radians). Fields MERGE; ' +
        'null (or an identity pose) removes it. It never ' +
        'resizes the layer: the typography bitmap always covers doc.size, so anything the parallax ' +
        'pushes outside the canvas is cropped by the canvas edge. Elements that are not inside the ' +
        'frame after the camera transform are simply out of frame.',
      cameraTracks:
        'Any camera channel can be keyframed with `typo_set_camera_animation({ channel, keys })`, ' +
        'channel = "x" | "y" | "zoom" | "rot". keys = [{ t, v, ease? }]: t is ABSOLUTE SECONDS inside ' +
        'the clip (0 = clip start), v is in that channel\'s unit (px / magnification / DEGREES). The ' +
        'call REPLACES the whole key list of that channel; null or [] deletes the track. A channel ' +
        'with keys IGNORES the base pose from `typo_set_camera`; channels without keys keep the base. ' +
        'Values hold before the first key and after the last. Read them back from ' +
        '`get_typography_doc → cameraTracks` (same shape you write), and note the typography clip ' +
        'becomes animated (rasterised per frame) once any channel has keys.',
      depth:
        '`depth` on an element is 0..1 and only matters while a camera is set: 0 (default) = ' +
        'infinitely far, it does not move at all; 1 = glued to the camera (zoom / pan / roll apply ' +
        'fully, so it looks unchanged relative to the camera); in between = a linear blend, which is ' +
        'where the parallax comes from. A whole text block has ONE depth (split it into several text ' +
        'elements if you need layers inside a block). depth:null removes the field. Map px of pan to ' +
        'px of movement: an element at depth d moves by d × zoom × pan.',
      paint:
        'Paint.colors accept hex or theme slots (@accent1 / @dk1 / @lt1 ...). linear.angle is ' +
        'DEGREES (0 = left→right). stop.offset is 0..1 along the gradient. texture.scale is a ' +
        'multiplier of the pattern cell, texture.thickness is in document px.',
      defaults:
        'Elements created by the agent start EMPTY: shapes and generated shapes get ' +
        'fill {kind:"none"} and stroke null unless you pass them, so nothing is drawn by ' +
        'accident (the editor UI uses a solid accent fill for hand-made shapes — do not ' +
        'rely on that here). Text gets the document text style (default color = theme text ' +
        'slot). No animation is attached unless you pass `animation` / `animations`.',
    },
    generators: SVG_GENERATORS.map((g) => ({
      id: g.id,
      group: g.group,
      name: tr(g.labelKey),
      defaultSeed: g.defaultSeed,
      ...(g.aspect === undefined ? {} : { aspect: g.aspect }),
      ...(g.notes ? { notes: g.notes } : {}),
      params: serializeParams(g.params),
    })),
    themes: themeIds(custom).map((id) => {
      const builtin = BUILTIN_THEMES.find((t) => t.id === id) ?? null;
      const c = custom?.find((t) => t.id === id) ?? null;
      const theme = builtin ?? c;
      return { id, name: theme ? themeDisplayName(theme) : id, builtin: Boolean(builtin) };
    }),
    themeSlots: [...THEME_SLOTS],
    defaultFontFamily: DEFAULT_FONT_FAMILY,
    paintKinds: ['none', 'solid', 'linear', 'radial', 'texture'],
    texturePatterns: TEXTURE_PATTERNS.map((p) => p.id),
    mixBlends: MIX_BLENDS.map((b) => b.id),
    imageFits: ['fill', 'contain', 'cover', 'none'],
    images: {
      adjust: {
        brightness: '-100..100 (0 = unchanged)',
        contrast: '-100..100 (0 = unchanged)',
        saturation: '-100..100 (-100 = greyscale)',
        sharpen: '0..100 (0 = off)',
        soften: '0..100 (0 = off)',
        curves:
          '{ master?, r?, g?, b?: [{ x, y }] } — up to 16 points per channel, both coordinates ' +
          '0..1, piecewise LINEAR (what the editor draws). master runs first, then the channel. ' +
          '`curves: null` clears every channel.',
      },
      recolor:
        '{ color, shadow, amount 0..1 } — maps LUMINANCE onto the gradient shadow(luminance 0) → ' +
        'color(luminance 1) and mixes it with the original by `amount`. amount 0 = no effect ' +
        '(the colours are kept, so dragging the strength back up restores them).',
      border:
        '{ color, width } — width in document px, drawn INSIDE the image (the frame does not grow). ' +
        'width 0 / null removes it.',
      filter: {
        form:
          '{ id, amount 0..1 } — one preset at a time (`null` removes it). Spatial presets ' +
          '(blur / sharpen / mosaic / sketch / neon / emboss / halftone) are applied at a raster ' +
          'capped to 2048 px on the long edge; colour presets run at full resolution.',
        ids: IMAGE_FILTERS.map((f) => f.id),
      },
      crop:
        'crop is { x, y, w, h } as SOURCE ratios (0..1, (0,0) = top-left of the original image). ' +
        'Setting an aspect ratio through the UI also switches `fit` to "cover" so the crop window ' +
        'fills the frame — writing `crop` yourself does not change `fit`.',
      imageFill:
        'Shapes may take `imageFill: { assetId, fit: "fill" | "contain" | "cover" }` — the shape ' +
        'path clips that picture (this is what "crop to shape" produces). While imageFill is set ' +
        'the path `fill` is IGNORED (a solid fill would cover the picture); set `fill` with a ' +
        '`kind` or `imageFill: null` to go back to a normal fill.',
    },
    textAligns: ['left', 'center', 'right', 'justify'],
    textVAligns: ['top', 'middle', 'bottom'],
    strokeStyles: ['solid', 'dashed', 'dotted'],
    /*
     * 动画清单。**预设名必须列出来**：模型猜 `slide-in-up` / `slideInUp` 的命中率
     * 大约是掷硬币，而猜错的表现是「动画没生效、也没有任何报错」。
     */
    animations: {
      presets: ANIM_PRESETS.map((p) => ({
        id: p.id,
        duration: p.duration,
        easing: typeof p.easing === 'string' ? p.easing : 'cubic-bezier',
        ...(p.params ? { params: p.params } : {}),
      })),
      /*
       * 结构化轨道（首选形态）。这张表必须写形状与单位：模型不会说「做不到」，
       * 它会拿 `at` 当秒用、或者把两个属性塞进一条动画（后写的那个静默无效）。
       */
      tracks: {
        form: '{ prop, keys: [{ t, v, ease? }], loop?, easing?, direction?, fill? }',
        prop:
          'x | y | sx | sy | rot | opacity | blur, or ANY CSS property name in kebab-case ' +
          '("letter-spacing", "clip-path", "color", "transform"). ONE animation animates ONE ' +
          'property — to make properties start at different times, send several animations ' +
          '(mode:"add"); never animate the same property twice on the SAME target layer.',
        target:
          'box (default) = the whole element box, so the text-box fill and border move too ' +
          '(clip-path clips the box, rot spins the whole block). content = only the text / svg / ' +
          'image itself (the text-box background stays still) — use it only when that is what you ' +
          'want. Omitted = box.',
        channels: ANIM_CHANNELS.map((id) => ({
          id,
          unit: CHANNEL_META[id].unit,
          identity: CHANNEL_META[id].identity,
        })),
        keys: {
          t: 'ABSOLUTE SECONDS from the clip start (not 0..1, not frames) or { beat: n }',
          v: 'number for channels (px / factor / degrees / 0..1), raw CSS string for any other property',
          ease: 'easing of the segment starting at this key (keyword or [x1,y1,x2,y2]); omit to inherit',
          color:
            'optional #rrggbb marker colour for the keyframe list in the editor — purely visual, ' +
            'it never reaches the style sheet',
        },
        derived:
          'delay = first key, duration = last key − first key. Passing delay / duration does not ' +
          'change the timing of a track (move the keys instead).',
        valueGate:
          'custom property values reject ; { } < > url( and !important (they would escape the ' +
          "element's style rule); custom property names must be kebab-case and cannot be animation-*",
      },
      easings: ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier(x1,y1,x2,y2)'],
      directions: ['normal', 'reverse', 'alternate', 'alternate-reverse'],
      fills: ['none', 'forwards', 'backwards', 'both'],
      keyProps: ['opacity', 'x', 'y', 'sx', 'sy', 'rot', 'blur'],
      maxKeys: 20,
      customCss: {
        field: 'css',
        forms: [
          'one or more `@keyframes <name>{ … }` blocks plus ONE top-level `animation: <name> <duration> …;` shorthand (comma-separate several)',
          'a bare keyframes body, e.g. `from{opacity:0}to{opacity:1}` (legacy form; timing comes from duration / delay / loop / easing)',
        ],
        rejects:
          'Top-level selectors, @import / @charset / @namespace, HTML tags and position tricks are ' +
          'rejected — a custom animation can only ever affect the element it is attached to. Names ' +
          'are namespaced per element, so two elements may both define `@keyframes pulse`.',
        anyProperty:
          'Any animatable CSS property works (transform / 3D rotate / filter / color / clip-path / ' +
          'letter-spacing / background-position …). Use it whenever `keys[]` cannot express the ' +
          'motion — do not approximate a 3D flip with scale.',
      },
      note:
        '`duration` / `delay` are SECONDS. Two time units exist and they are NOT the same: the ' +
        'structured form (`prop` + `keys[]`) uses `t` = ABSOLUTE seconds from the clip start, ' +
        'while the legacy `keys[].at` is 0..1 of the animation. `{ beat: n }` is accepted in both ' +
        'and is converted with the project BPM. Key props: x / y are px offsets, sx / sy are scale ' +
        'factors, rot is DEGREES, blur is px, opacity is 0..1. Animations live in the document and ' +
        'are evaluated by the same clock as everything else, so they render in exports too. The ' +
        'read-back shape (what `get_typography_doc` returns: `prop` + `keys`, `iterations` instead ' +
        'of `loop`) is accepted verbatim, so a document can be read, edited and written back ' +
        'without losing animations.',
    },
    /* 格式刷 / 动画刷（`typo_copy_style`）：一次调用刷一批，一笔撤销。 */
    styleCopy: {
      tool: 'typo_copy_style({ clipId?, sourceId, targetIds[], what? })',
      what: [
        'format (default): fill, stroke, radius, text style, image processing (fit / crop / key / quad / adjust / recolor / border / filter), shadows, blur',
        'animation: replaces the targets\' animations with copies of the source\'s (new ids; an empty source clears them)',
      ],
      mapping:
        'A shape\'s `fill` / `stroke` lands on a text box\'s `boxFill` / `boxStroke` and vice versa, ' +
        'so painting a shape onto a text box gives the box the same background and border.',
      skips:
        'Fields the TARGET kind does not have are silently skipped (a shape has no fit / crop, a ' +
        'text box has no radius). `changed: 0` means nothing differed — not an error.',
      notCopied:
        'Content (runs, assetId), geometry (frame, transform3d), opacity and blend are NEVER copied: ' +
        'this is an appearance painter, not a duplicate.',
    },
    scripts: {
      fields: ['id', 'name', 'code', 'enabled', 'targets', 'needs'],
      form:
        '`code` is the body of a SYNCHRONOUS function; `ctx` is in scope (do not write `(ctx) => {}`). ' +
        'Statements only — `return` is allowed but its value is ignored (a Promise is rejected).',
      context: {
        t: 'seconds, local to the clip (negative during the first half of a transition)',
        frame: 'round(t * fps)',
        fps: 'project fps',
        duration: 'clip duration in seconds',
        w: 'document width in px',
        h: 'document height in px',
        seed: 'project seed (pass it to derive your own noise)',
      },
      element: {
        'el(id)': 'handle for one element, or null if it is not rendered',
        'els(kind?)': 'handles for every visible element (optionally filtered by kind)',
        style: 'style({ "css-property": "value" }) — numbers are stringified; null removes',
        transform:
          'transform({ x, y, rotate, scale, skew }) — x/y in document px, rotate/skew in DEGREES, ' +
          'scale number or { x, y }; composed INSIDE the element animation layer',
        opacity: 'opacity(0..1)',
        visible: 'visible(boolean)',
        attr: 'attr(name, value) on the content node (svg / text box / image wrapper)',
        path:
          'path(d) — shape:"svg" only; the string uses the pathUnit of that element ' +
          '(percent = 0..100 authored box, px = element box)',
        var: 'var("--name", value) — CSS custom property (must start with --)',
        canvas:
          'canvas() — the 2D context of the pre-built canvas of the element (needs:["canvas"]), ' +
          'already cleared and reset for this frame; null if the element has no canvas',
        box: 'box() — { x, y, w, h, rot } of the unrotated element frame in document px',
        d: 'the AUTHORED path string of a shape:"svg" element (null otherwise)',
      },
      chars: {
        length: 'one entry per character (newlines included); empty unless needs:["chars"]',
        index: '0-based index and `count` (total characters in that element)',
        char: 'the character itself (read-only)',
        style: 'style(decls) on that character span',
        transform: 'transform({ x, y, rotate, scale, skew }) on that character span',
        opacity: 'opacity(0..1) on that character span',
      },
      helpers: {
        'rand(i)': 'deterministic random in [0,1) — same frame + script + i gives the same value',
        'ease(name, x)': 'name: linear | in | out | in-out; x is clamped to 0..1',
        clamp: 'clamp(v, min, max)',
        lerp: 'lerp(a, b, k)',
        smoothstep: 'smoothstep(edge0, edge1, x)',
        'morph(a, b, k)': 'interpolates two SVG `d` strings (equal segment counts are resampled)',
        hsl: 'hsl(h, s, l) -> "hsl(h s% l%)"',
        log: 'log(...) — only reaches the console when script debugging is on',
      },
      needs: {
        chars:
          'builds one inline-block span per character for the targeted text elements; ' +
          'this disables ligatures/kerning there and PAUSES while that text is being edited',
        canvas:
          'inserts a 2D canvas sized to the element, painted UNDER the element content',
        targets:
          'needs apply to `targets` (element ids) only; omit targets = every element. ' +
          'needs never limits ctx.el(id) — it only decides which DOM extras are built.',
      },
      limits: {
        maxScripts: SCRIPT_LIMITS.maxScripts,
        maxCodeChars: SCRIPT_LIMITS.maxCodeChars,
        maxTotalCodeChars: SCRIPT_LIMITS.maxTotalCodeChars,
        maxWritesPerFrame: SCRIPT_LIMITS.maxWrites,
        softMs: SCRIPT_LIMITS.softMs,
        hardMs: SCRIPT_LIMITS.hardMs,
      },
      templates: SCRIPT_TEMPLATES.map((t) => ({
        id: t.id,
        name: resolveLabel(t.labelKey, tr) || t.labelKey,
        needs: [...t.needs],
      })),
      running:
        'Scripts are OFF by default (a global user preference): while off the document renders ' +
        'EXACTLY as if it had no scripts, and exports contain no script effects. Do not claim the ' +
        'effect is visible — tell the user to enable "run typography scripts", then re-render.',
      rules:
        'Stateless per frame: the same t must produce the same pixels (backwards seeking replays ' +
        'from scratch; nothing accumulates). Math.random / Date.now / performance.now / fetch / ' +
        'timers / storage are shadowed and throw. No await, no async, no node creation, no layout ' +
        'reads, no network or files. Scripts only change the presentation layer — they never write ' +
        'documents, z-order, groups or colors.',
    },
    layoutOps: ['align', 'distribute', 'grid', 'row', 'column'],
    alignAxes: [
      'left',
      'center-h',
      'right',
      'top',
      'middle',
      'bottom',
      'distribute-h',
      'distribute-v',
    ],
  };
}

/** 生成器默认参数（`add_generated_shape` 省略 params 时用）。 */
export function svgGenDefaults(id: string): Record<string, number | string> {
  const spec = SVG_GENERATORS.find((g) => g.id === id);
  return spec ? defaultsOf(spec) : {};
}
