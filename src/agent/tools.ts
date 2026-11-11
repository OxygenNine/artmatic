/**
 * tools.ts — 应用内 Agent 的**工具表**（模型看得见的唯一清单）。
 *
 * ## 与 MCP 的关系
 *
 * `mcp/tools.mjs` 是同一批能力的网关侧声明（它还多一层 MCP 协议适配）。
 * 两边**名字集合必须一致**（应用内用短名，网关加 `artmatic_` 前缀），由
 * `tests/unit/agent-tools-parity.test.ts` 钉住 —— 加工具时忘了一边会立刻变红。
 *
 * ## 为什么描述是英文
 *
 * 这些句子是**给模型读的 API 文档**，不是界面文案（工具卡的标题走 i18n 的
 * `agent.*`）。英文与代码里的 GLSL / 类型名同语言，模型对「uniform / clip /
 * keyframe」这类词的对齐更稳；也避免 `i18n.test.ts` 把几十条指令当成
 * 「未抽取的界面文案」。
 *
 * ## `writes` 字段
 *
 * 会话层据此决定「这一轮要不要包事务」，以及面板上要不要提示「已修改 N 处」。
 * 漏标的后果是撤销栈里多出几条中间记录 —— 不报错，但用户按 Ctrl+Z 时会
 * 落到一个自己没见过的状态。
 */

export type ToolParamKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'size'
  | 'scalars'
  | 'frameRange'
  | 'curve'
  | 'json'
  | 'stringArray'
  | 'numberArray';

export interface ToolParam {
  key: string;
  kind: ToolParamKind;
  desc: string;
  required?: boolean;
  enum?: readonly string[];
}

export interface ToolSpec {
  /** 应用内短名。MCP 侧是 `artmatic_` + 这个名字。 */
  name: string;
  description: string;
  params: ToolParam[];
  /** 会改动工程（会话层据此包事务 / 计数）。 */
  writes: boolean;
  /** 慢操作（导出 / 编译 / 试挂）：超时与进度提示另算。 */
  slow?: boolean;
  /**
   * 只在应用内可用（MCP 网关没有等价能力）。
   *
   * 目前只有 `ask_user`：它需要**一个正在看着面板的人**来回答；外部 MCP 客户端
   * 可能没有 UI，所以网关里不声明它（一致性测试会跳过 appOnly 的条目）。
   */
  appOnly?: boolean;
}

const p = (
  key: string,
  kind: ToolParamKind,
  desc: string,
  extra: Partial<ToolParam> = {},
): ToolParam => ({ key, kind, desc, ...extra });

const req = (key: string, kind: ToolParamKind, desc: string, extra: Partial<ToolParam> = {}): ToolParam => ({
  key,
  kind,
  desc,
  required: true,
  ...extra,
});

const CLIP_ID = req('clipId', 'string', 'Clip id (from get_scene).');
const ASSET_ID = req('assetId', 'string', 'Asset id (from media_list / get_scene).');
const OPT_CLIP_ID = p('clipId', 'string', 'Text clip id. Omit to use the document open in the typography editor.');
const ELEMENT_ID = req('elementId', 'string', 'Typography element id.');
const T = p('t', 'number', 'Time in SECONDS (snapped to the frame grid). Omit = current playhead.');
const SIZE = p('size', 'size', 'Pixel size { w, h }. Omit = project resolution.');
const ONLY = p(
  'only',
  'json',
  'Isolate before rendering: { trackId?: string | string[], elementId?: string | string[] }. ' +
    'Every visual track NOT listed is hidden — INCLUDING effect (adjustment) clips living on their ' +
    'own tracks, so a chain on ANOTHER track will not show up here. Isolation answers "what does ' +
    'this track look like on its own"; it is NOT a way to test an effect chain (render without ' +
    '`only` for that, and read `layers` in the result to see what actually composited). ' +
    'Effects BOUND to a listed clip (boundClipId) do stay, because they are part of that layer. ' +
    'The project is NOT modified.',
);

const REGION = p(
  'region',
  'json',
  'Zoom into a part of the frame: { x, y, w, h } in 0..1 of the rendered image. The crop is ' +
    'upscaled (nearest neighbour, to >=480px wide) so fine detail (ASCII, halftone, small type) ' +
    'is readable without rendering the whole frame at a huge size.',
);

export const AGENT_TOOLS: ToolSpec[] = [
  /* ---------------------------------------------------------------- 读 */
  {
    name: 'describe',
    description: 'Project metadata: API/schema version, fps, resolution, duration. Call it first.',
    params: [],
    writes: false,
  },
  {
    name: 'help',
    description:
      'Fetch a topic manual. Topics: plugin-api (how to write a plugin: shader preludes, ' +
      'parameter types, dispatch rules, examples), timeline, typography, workflow, images. ' +
      'Read `plugin-api` BEFORE writing plugin source.',
    params: [p('topic', 'string', 'One of: plugin-api, timeline, typography, workflow, images.')],
    writes: false,
  },
  {
    name: 'ask_user',
    description:
      'Pause and ask the user a direct question. Use it when the request is ambiguous, when a ' +
      'destructive action needs a decision, or when you are blocked after repeated failed calls. ' +
      'Do NOT guess the answer. The task resumes with the answer as the tool result.',
    params: [
      req('question', 'string', 'One short question, in the user\'s language.'),
      p('options', 'stringArray', 'Optional quick choices (2-4). The user can still type a custom answer.'),
      p('allowFreeText', 'boolean', 'Allow a free-form answer (default true).'),
    ],
    writes: false,
    appOnly: true,
  },
  {
    name: 'get_scene',
    description:
      "Compact snapshot at time t: tracks (with z order), clips (with `active`), curves. " +
      "Use detail:'ids' for a cheap overview of a long project.",
    params: [T, p('detail', 'string', "ids | full (default full).", { enum: ['ids', 'full'] })],
    writes: false,
  },
  {
    name: 'get_capabilities',
    description:
      "Legal ids and (with detail:'params') their parameter schemas: keys, types, ranges, options, " +
      'defaults, keyframability. Always take def ids from here instead of inventing them.',
    params: [
      p('detail', 'string', 'ids (cheap) | params (with parameter tables).', { enum: ['ids', 'params'] }),
      p('ids', 'stringArray', 'Optional filter: only these def ids. Prefer filtering when using detail=params.'),
    ],
    writes: false,
  },
  {
    name: 'get_typography_capabilities',
    description:
      'Shape kinds (with supported params), 22 procedural SVG generators (with parameter schemas ' +
      'and semantic notes), themes, paint forms, blend modes, layout ops, and a `units` block ' +
      'that says what the numbers mean (px vs 0..1 ratios, rot in radians, generator box).',
    params: [],
    writes: false,
  },
  {
    name: 'get_typography_doc',
    description:
      "A text clip's typography document. detail:'ids' gives element ids / kinds / frames only; " +
      "detail:'full' (the default) also gives styles, paints, text, 3D, generator state and " +
      'animations (preset / keys / custom css verbatim). The full view is round-trippable: what ' +
      'you read back can be edited and sent to typo_replace_doc (unknown keys come back in ' +
      '`droppedKeys`, bad animation entries in `droppedAnimations` — read both fields).',
    params: [OPT_CLIP_ID, p('detail', 'string', "ids | full (default full).", { enum: ['ids', 'full'] })],
    writes: false,
  },
  {
    name: 'get_clip',
    description: 'One clip with its effect chain, parameter values, curves and transition.',
    params: [CLIP_ID],
    writes: false,
  },
  {
    name: 'undo_state',
    description: 'Whether undo/redo is available. Useful right after a write to confirm it landed.',
    params: [],
    writes: false,
  },
  {
    name: 'frame_signature',
    description:
      'Cheap numeric fingerprint of a frame: per-channel means, spread (structure detector), ' +
      'block means, sample colors. Use this for self-checks; use render_frame when you must look.',
    params: [T, SIZE, p('grid', 'integer', 'Block grid size (default 4).'), ONLY],
    writes: false,
  },
  {
    name: 'render_frame',
    description:
      'Render one frame through the real preview/export path and return it as an image. ' +
      'Default size 640x360 (cheap). Use it to judge composition and visual quality. ' +
      'Pass `only` to look at a single track or typography element in isolation. ' +
      'Pass `region` to zoom into a part of the frame. ' +
      'The result also lists `layers` — the tracks/clips that actually composited, which is how ' +
      'you tell "the isolation hid it" apart from "my parameter did nothing".',
    params: [T, SIZE, ONLY, REGION],
    writes: false,
    slow: true,
  },
  {
    name: 'render_sequence',
    description:
      'Render several frames over a time range and return them as ONE contact-sheet image ' +
      '(row-major, each cell labelled with its time). This is how you judge rhythm, beat sync ' +
      'and motion: a single still cannot show whether an accent lands on the beat. ' +
      '`from` / `to` / `step` are SECONDS; default is 6 evenly spaced frames, max 24. ' +
      'Use a small `size` (e.g. 240x135) — each cell is a thumbnail.',
    params: [
      p('from', 'number', 'Start time in seconds (default 0).'),
      p('to', 'number', 'End time in seconds (exclusive; default project duration).'),
      p('step', 'number', 'Spacing in seconds (default: fit ~6 frames into the range).'),
      SIZE,
      p('cols', 'integer', 'Columns in the sheet (default 3, max 6).'),
      ONLY,
      REGION,
    ],
    writes: false,
    slow: true,
  },

  {
    name: 'ui_screenshot',
    description:
      'Screenshot the whole Artmatic UI (rail, agent drawer, timeline, inspector, plugin panels — ' +
      'everything inside the app window). Use it after building or changing a PLUGIN PANEL, or when ' +
      'the user asks how the interface looks: `render_frame` only shows the video frame, so a ' +
      'mis-laid-out panel is invisible there. Dialogs portaled to <body> (settings, plugin manager) ' +
      'are NOT included. Long side is capped at 1600px; `scale` (0.25..2) shrinks it further — the ' +
      'capture costs roughly 1-2k tokens, so do not take one after every edit.',
    params: [p('scale', 'number', 'Output scale 0.25..2 (default 1). Long side stays <=1600px.')],
    writes: false,
  },

  /* ------------------------------------------------------------ 时间轴写 */
  {
    name: 'add_track',
    description:
      'Add a track. New tracks land at the END of tracks[], which is the BOTTOM of the composite ' +
      '(tracks[0] is front-most).',
    params: [
      req('kind', 'string', 'visual | audio', { enum: ['visual', 'audio'] }),
      p('name', 'string', 'Track name.'),
    ],
    writes: true,
  },
  {
    name: 'remove_track',
    description: 'Remove a track and all of its clips (one undo entry).',
    params: [req('trackId', 'string', 'Track id.')],
    writes: true,
  },
  {
    name: 'move_track',
    description: 'Move a track from index `from` to index `to`. Track order IS compositing order.',
    params: [
      req('from', 'integer', 'Current index (0 = front-most).'),
      req('to', 'integer', 'Target index.'),
    ],
    writes: true,
  },
  {
    name: 'set_track',
    description:
      'Enable/disable or rename a track. A disabled track contributes nothing to the frame.\n' +
      'muted (visual tracks only) silences the EMBEDDED AUDIO of the video clips on that track ' +
      'while the picture stays — it also applies to exports. Audio tracks reject muted: their ' +
      '`enabled` already is the sound switch.',
    params: [
      req('trackId', 'string', 'Track id.'),
      p('enabled', 'boolean', 'Visibility.'),
      p('name', 'string', 'New name.'),
      p('muted', 'boolean', 'Visual tracks only: mute the embedded audio, keep the picture.'),
    ],
    writes: true,
  },
  {
    name: 'add_clip',
    description:
      "Add a source clip. kind: solid | algo | image | video | text. For algo pass `generator` + " +
      '`params` (keys from get_capabilities). For text, `doc` is optional: an empty document is created ' +
      'and you fill it with typo_* tools. Times in seconds.\n' +
      '`fit` defaults: solid = stretch (its source is a 1x1 texture, so contain would draw a ' +
      'centred SQUARE instead of filling the frame), everything else = contain. ' +
      'Adding a clip past the current end grows project.duration — that is intentional (the tail ' +
      'is what an outgoing transition fades into black); call set_project({duration}) if you need ' +
      'the old length back.',
    params: [
      req('trackId', 'string', 'Visual track id.'),
      req('kind', 'string', 'solid | algo | image | video | text', {
        enum: ['solid', 'algo', 'image', 'video', 'text'],
      }),
      req('start', 'number', 'Start time in seconds.'),
      req('end', 'number', 'End time in seconds (> start).'),
      p('id', 'string', 'Explicit clip id (for reproducible scripts).'),
      p('label', 'string', 'Clip label shown on the timeline.'),
      p('generator', 'string', 'Generator id (kind=algo).'),
      p('params', 'scalars', 'Generator parameters (kind=algo).'),
      p('color', 'string', 'Hex color (kind=solid).'),
      p('assetId', 'string', 'Asset id (kind=image | video).'),
      p('srcIn', 'number', 'Source offset in seconds (kind=video).'),
      p('speed', 'number', 'Playback speed (kind=video).'),
      p('doc', 'json', 'Typography document (kind=text). Omit for a blank document.'),
      p('blend', 'string', 'Blend mode (see get_capabilities.blendModes).'),
      p('opacity', 'number', '0..1'),
      p('fit', 'string', 'contain | cover | stretch', { enum: ['contain', 'cover', 'stretch'] }),
      p('fadeSec', 'number', 'Fade in/out duration in seconds.'),
    ],
    writes: true,
  },
  {
    name: 'add_effect_clip',
    description:
      'Add an effect clip. Two modes, pick deliberately:\n' +
      '1) adjustment layer (default): affects the composite of the tracks BELOW it, `affectDepth` ' +
      'limits it to the nearest N enabled tracks. Costs one extra track.\n' +
      '2) BOUND to one clip (`boundClipId`): the chain runs on that clip\'s own layer only, after ' +
      'placement and before its blend — z order is irrelevant, and it does not affect anything ' +
      'else. This is the one to use for beat-level accents (a 0.25s strobe on one shot): it needs ' +
      'no dedicated track per hit, and "which layer is this on" is explicit instead of implied by ' +
      'track position. A bound clip must be a source clip; `boundClipId` and `affectDepth` are ' +
      'mutually exclusive.\n' +
      'Tracks are cheap in the model but expensive for a human to read: prefer one effect clip with ' +
      'a longer chain (and curves) over a track per effect, and prefer `boundClipId` over a new ' +
      'track per accent.',
    params: [
      req('trackId', 'string', 'Visual track id.'),
      req('start', 'number', 'Start time in seconds.'),
      req('end', 'number', 'End time in seconds.'),
      p('chain', 'json', 'Array of { defId, values? } (defIds from get_capabilities).'),
      p('label', 'string', 'Clip label.'),
      p('fadeSec', 'number', 'Fade duration in seconds.'),
      p('affectDepth', 'integer', 'Only the nearest N enabled tracks below (0 = all). Not with boundClipId.'),
      p('boundClipId', 'string', 'Bind the chain to this source clip instead of using z order.'),
    ],
    writes: true,
  },
  {
    name: 'remove_clip',
    description: 'Remove a clip by id.',
    params: [CLIP_ID],
    writes: true,
  },
  {
    name: 'move_clip',
    description:
      'Move a clip to another track / start time. Placement follows project.overlapBehavior; ' +
      'a rejected placement changes nothing (read the error instead of retrying blindly).',
    params: [
      CLIP_ID,
      req('targetTrackId', 'string', 'Destination track id.'),
      req('newStart', 'number', 'New start time in seconds.'),
    ],
    writes: true,
  },
  {
    name: 'resize_clip',
    description: 'Trim one edge of a clip.',
    params: [
      CLIP_ID,
      req('edge', 'string', 'start | end', { enum: ['start', 'end'] }),
      req('time', 'number', 'New edge time in seconds.'),
    ],
    writes: true,
  },
  {
    name: 'split_clip',
    description: 'Split a clip at time `at`. Returns the left id (unchanged) and the new right id.',
    params: [CLIP_ID, req('at', 'number', 'Cut time in seconds, inside the clip.')],
    writes: true,
  },
  {
    name: 'set_clip_props',
    description:
      'Patch clip fields. Whitelisted keys:\n' +
      '  label, fadeSec (visual clip cut fade), blend, opacity, transform { x, y, sx, sy, rot } ' +
      '(x/y are 0..1 anchors, rot is RADIANS), fit, affectDepth, boundClipId\n' +
      '  fadeIn / fadeOut — AUDIO clips only, seconds. Clamped so fadeIn + fadeOut <= clip length; 0 removes.\n' +
      '  srcIn — audio / video source offset in seconds (shifting the content inside the clip, ' +
      'without moving its edges).\n' +
      '  crop — source clips: { left?, top?, right?, bottom? } as fractions of the SOURCE (0..1) that ' +
      'are cut away. It only narrows the visible window (AE Crop), it does not scale the content. ' +
      'null removes it; all-zero removes it too.\n' +
      '  quad — source clips: { tl, tr, br, bl }, each [x, y] in layer space (0..1 = the layer box). ' +
      'null removes it; a degenerate (zero-area) quad is rejected because it renders as nothing.\n' +
      '  key — image / video clips: chroma key { color: "#rrggbb", tolerance?, softness?, spill? } ' +
      '(0..1 each; omitted fields keep their current value). null removes it.\n' +
      '  speed — video clips only, positive multiplier (1 = realtime, 2 = double speed, 0.05..100). ' +
      'It KEEPS the clip length: the same timeline span now consumes more (or less) source; the clip ' +
      'only shrinks when the source runs out (`applied.end` tells you the resulting end time). ' +
      'Setting it clears any `speed` keyframe curve — use set_curve for animated / reverse playback ' +
      '(negative values there mean REVERSE).\n' +
      'boundClipId (effect clips only) rebinds the chain to one source clip — null unbinds; it ' +
      'replaces affectDepth (they are mutually exclusive). ' +
      'Returns `applied` with the stored value of each field you sent (null = the effect is off).',
    params: [CLIP_ID, req('patch', 'json', 'Whitelisted fields only.')],
    writes: true,
  },
  {
    name: 'set_params',
    description:
      "Set source params (target:'source') or one effect instance (target:'effect' + chainIndex).\n" +
      "On target:'effect' you may pass `params`, `enabled`, `mask`, or any combination — switching a " +
      'single instance off is how you tell two candidate looks apart without removing anything.\n' +
      '`mask` binds an EXTERNAL mask texture to that instance (only effects whose capability lists ' +
      "`flags.mask: true`, e.g. grade-qualifier). Shape: { kind: 'clip', clipId, channel } reads " +
      "another clip's rendered layer, { kind: 'asset', assetId, channel } reads an image asset, " +
      'null removes it. channel is luma | alpha | r | g | b (default luma). The referenced clip is ' +
      'evaluated at the same t as its own layer INCLUDING its bound effect chain, so it is a real ' +
      'dependency — a reference that would form a cycle (or nest deeper than 8) is rejected with ' +
      'code conflict.\n' +
      'Unknown keys are rejected — read get_capabilities first. Returns `values` with the stored ' +
      'value of each key you sent (defaults and clamps already applied), the stored `enabled`, and ' +
      'the stored `mask` (null = none).\n' +
      'Params of type `asset` (particles.spriteAsset / emitAsset, fluid.maskAsset, ' +
      'extrude-material.logoAsset — and any plugin generator that declares one) hold an ' +
      "assetId STRING, not a texture or a number. Use '' to unbind. Only image assets are " +
      'accepted; the id must already exist in the project. The keys are exactly the def params ' +
      "whose type is 'asset' (features.<generator>.assetParams exists for particles / fluid). " +
      'Presets are applied by writing their parameter values with set_params; ' +
      'names are in get_capabilities.features.particles.presets. For particles, `rate` is ' +
      'simulation steps per second and `life` is seconds. For fluid, `rate` is also steps per ' +
      'second, `force` is in domain heights per second, and `simRes` is a quality tier (the ' +
      'height of the 16:9 simulation domain), not the output resolution.',
    params: [
      CLIP_ID,
      req('target', 'string', 'source | effect', { enum: ['source', 'effect'] }),
      p('chainIndex', 'integer', 'Effect index inside the chain (required for target=effect).'),
      p('params', 'scalars', 'Parameter key/value pairs (optional when `enabled` / `mask` is given).'),
      p('enabled', 'boolean', "target=effect only: switch this instance on / off."),
      p(
        'mask',
        'json',
        "target=effect only: external mask { kind, clipId|assetId, channel } or null to remove.",
      ),
    ],
    writes: true,
  },
  {
    name: 'set_generator',
    description:
      "Replace an algo clip's generator (start / end / blend / non-generator curves are kept). " +
      'Params are reset to the new generator\'s defaults and then merged with `params`. ' +
      'Curves keyed by the OLD generator\'s params are deleted — they do not exist on the new one. ' +
      'Returns the stored generator + params.',
    params: [
      CLIP_ID,
      req('generator', 'string', 'Generator id (get_capabilities.generators).'),
      p('params', 'scalars', 'Parameter overrides for the new generator.'),
    ],
    writes: true,
  },
  {
    name: 'seed_pattern_from_asset',
    description:
      "Fill an algo clip's `pattern` parameter from a media-pool image (SVG / PNG). " +
      'Sampled by OPACITY at the current sim grid size (width x height): pixels with alpha >= 50% ' +
      'become live cells, colour and brightness are ignored. Also switches `seedMode` to ' +
      "'pattern' in the same undo step, so the picture becomes the initial state instead of " +
      'sitting next to a random seed. Returns the encoded pattern (WxH:base64) and the sampled size.',
    params: [
      CLIP_ID,
      req('param', 'string', 'Pattern parameter key (usually "pattern").'),
      ASSET_ID,
    ],
    writes: true,
  },
  {
    name: 'set_curve',
    description:
      'Attach a keyframe curve to a parameter, or pass null to remove it. Only range parameters ' +
      'can be keyframed.\n' +
      'CURVE SCHEMA — exactly these keys, no others:\n' +
      '{\n' +
      '  mode?: "keyframe" | "impulse" | "follower",   // default "keyframe"\n' +
      '  keys: [{\n' +
      '    t: number,          // SECONDS. Relative to clip.start, or to the anchored beat when\n' +
      '                        // curve.beatAnchor is set. Must be non-decreasing across keys.\n' +
      '    v: number,          // the value (NOT "value"), in the parameter\'s own unit\n' +
      '    interp?: "linear" | "step" | "smooth" | "bezier",  // default "smooth"; affects the\n' +
      '                        // segment FROM this key to the NEXT one\n' +
      '    hOut?: [dx, dy],    // bezier out-handle, offset from this key, [seconds, value]\n' +
      '    hIn?: [dx, dy]      // bezier in-handle, offset from this key, [seconds, value]\n' +
      '  }],\n' +
      '  beatAnchor?: { beat: number } | null,   // keys\' t=0 sits on that beat (follows BPM changes)\n' +
      '  impulse?: { decay: number },            // mode "impulse": decay seconds, default 0.3\n' +
      '  follower?: { attack: number; release: number }  // mode "follower", default 0.05 / 0.3\n' +
      '}\n' +
      'Example: {"keys":[{"t":0,"v":0,"interp":"smooth"},{"t":0.5,"v":1,"interp":"smooth"}]}\n' +
      'PARAM ADDRESSING — `param` accepts, in order of preference:\n' +
      '  - "<instanceId>.<key>" for an effect parameter (full id, or any unique prefix)\n' +
      '  - "<defId>.<key>" when only ONE instance of that effect exists in the chain,\n' +
      '    e.g. "blur.amount" (readable form; ambiguous defId returns both candidates)\n' +
      '  - "<key>" alone for a source param (opacity / transform.x / generator keys)\n' +
      '  - "speed" for a VIDEO clip: playback speed multiplier, one curve unit = "x". Negative\n' +
      '    values play the source BACKWARDS (reverse); the clip keeps its timeline span, so a\n' +
      '    negative run rewinds the source and may run past its head (frames clamp to the first\n' +
      '    one). Embedded audio is silent whenever the speed reaches <= 0.\n' +
      '  - "gain" for an audio clip\n' +
      'Not curvable => the error detail.allowed lists every legal key for that clip.',
    params: [
      CLIP_ID,
      req('param', 'string', 'Parameter key — see the addressing rules in the tool description.'),
      p('curve', 'curve', 'Curve object (schema in the description), or null to remove the curve.'),
    ],
    writes: true,
  },
  {
    name: 'list_modulators',
    description:
      'List the project modulators (project-level expressions that can drive any range parameter) ' +
      'with the parameters that reference them, plus the expression function vocabulary. ' +
      'Shape: { modulators: [{ id, name, expr, unit: { min, max }, refs: [{ clipId, clipLabel, ' +
      'param, slots }] }], functions: [{ name, arity }] }. ' +
      '`unit` only affects the UI range, not evaluation. Modulators are shared across the whole ' +
      'project — one definition is meant to drive many clips.',
    params: [],
    writes: false,
  },
  {
    name: 'set_modulator',
    description:
      'Create a modulator (omit `id`) or update one (pass `id`). Returns { id, created, expr, refs }. ' +
      'EXPRESSION LANGUAGE — closed-form only (no per-frame state, so seeking is exact):\n' +
      '  values: numbers, `t` (SECONDS, absolute), `beat` (absolute beats, fractional), pi / tau / e\n' +
      '  operators: + - * / % ^ , comparisons, `cond ? a : b`\n' +
      '  references: modulator("<id>") (cycles evaluate to 0), param("<key>")\n' +
      '  functions: sin cos tan abs floor ceil round fract sign sqrt exp log smooth(x) ' +
      'mod(a,b) pow(a,b) min(a,b) max(a,b) step(edge,x) atan2(y,x) clamp(x,lo,hi) ' +
      'map(x,inMin,inMax,outMin,outMax) noise(x,freq,seed) fbm(x,octaves,seed) ' +
      'lfo(t,freq,shape) rand(seed).\n' +
      '  `lfo` shape: 0 sin, 1 triangle, 2 saw, 3 square, 4 random-hold (one value per period).\n' +
      '  `noise` / `fbm` return -1..1 and are seeded by the project seed.\n' +
      'Example: `sin(t * 2 * pi) * 0.5` — half-amplitude sine at 1 Hz. ' +
      'The expression is parsed before it is stored; a syntax error is rejected with code+offset ' +
      'instead of silently evaluating to 0.',
    params: [
      p('id', 'string', 'Existing modulator id (omit to create a new one).'),
      p('name', 'string', 'Display name (<= 40 chars).'),
      p('expr', 'string', 'Expression source — see the language in the description.'),
      p('min', 'number', 'Display range lower bound (UI only, no clamping).'),
      p('max', 'number', 'Display range upper bound (UI only, no clamping).'),
    ],
    writes: true,
  },
  {
    name: 'remove_modulator',
    description:
      'Delete a modulator and detach it from every parameter that references it (one undo step). ' +
      'Returns { removed, refs } where refs is the number of slots that were detached — call ' +
      'list_modulators first if you need to know which params those were.',
    params: [req('id', 'string', 'Modulator id.')],
    writes: true,
  },
  {
    name: 'bind_modulator',
    description:
      'Attach a modulator to one range parameter of a clip, on top of any keyframe curve ' +
      '(both layers apply: curve first, then each slot in order). Returns the stored slots.\n' +
      'modes: add => v += gain * m ; mul => v *= mix(1, m, gain) (gain 0 = no effect, 1 = full).\n' +
      'gain is in the PARAMETER\'S OWN UNIT for add (e.g. 40 = 40 units of transform.x) and 0..1 ' +
      'for mul. Default gain 0.5, default mode add. Binding the same modulator in the same mode ' +
      'twice only updates the gain. `param` uses the same addressing as set_curve ' +
      '("<instanceId>.<key>", "<defId>.<key>", "<key>", "gain").',
    params: [
      CLIP_ID,
      req('param', 'string', 'Parameter key — same addressing rules as set_curve.'),
      req('modulatorId', 'string', 'Modulator id (from list_modulators).'),
      p('gain', 'number', 'Amplitude / blend weight. Default 0.5.'),
      p('mode', 'string', 'add | mul. Default add.', { enum: ['add', 'mul'] }),
    ],
    writes: true,
  },
  {
    name: 'unbind_modulator',
    description:
      'Detach modulators from a parameter. With `modulatorId` only that slot is removed; without ' +
      'it every slot on that parameter is cleared (the keyframe curve is untouched). ' +
      'Returns { param, slots } with the remaining slot count.',
    params: [
      CLIP_ID,
      req('param', 'string', 'Parameter key — same addressing rules as set_curve.'),
      p('modulatorId', 'string', 'Only remove this modulator. Omit to clear all of them.'),
    ],
    writes: true,
  },
  {
    name: 'add_effect',
    description:
      "Append (or insert at `index`) an effect instance to an effect clip's chain. Returns " +
      '{ instanceId, chainIndex, keyPrefix } — `keyPrefix + "<param>"` is exactly what set_curve ' +
      'expects for this instance (e.g. "b7f0…-4a.amount"), so there is no need to re-read the clip.',
    params: [
      CLIP_ID,
      req('defId', 'string', 'Effect def id.'),
      p('values', 'scalars', 'Parameter overrides (defaults are filled in).'),
      p('index', 'integer', 'Insert position (default: end).'),
      p('enabled', 'boolean', 'Create the instance disabled (default true).'),
    ],
    writes: true,
  },
  {
    name: 'remove_effect',
    description: 'Remove one effect instance from a chain.',
    params: [CLIP_ID, req('chainIndex', 'integer', 'Index inside the chain.')],
    writes: true,
  },
  {
    name: 'reorder_effect',
    description: 'Move an effect instance inside a chain.',
    params: [CLIP_ID, req('from', 'integer', 'Current index.'), req('to', 'integer', 'Target index.')],
    writes: true,
  },
  {
    name: 'set_transition',
    description:
      'Attach a transition to one edge of a source clip. side=out (default): window centred on clip.end, ' +
      'next clip on the same track is the incoming side. side=in: window centred on clip.start, previous ' +
      'clip is the outgoing side. When that neighbour is missing the other side is FULLY TRANSPARENT, ' +
      'so an intro/outro transition still works. Duration is clamped by both sides.',
    params: [
      CLIP_ID,
      req('defId', 'string', 'Transition id.'),
      req('duration', 'number', 'Duration in seconds.'),
      p('values', 'scalars', 'Transition parameter overrides.'),
      p('side', 'string', 'in | out (default out)', { enum: ['in', 'out'] }),
    ],
    writes: true,
  },
  {
    name: 'clear_transition',
    description: 'Remove the transition on one edge of a clip (side defaults to out).',
    params: [CLIP_ID, p('side', 'string', 'in | out (default out)', { enum: ['in', 'out'] })],
    writes: true,
  },
  {
    name: 'get_asset_ranges',
    description:
      'Read the saved pre-clip In/Out ranges of a video asset, plus the activeRangeId. Times are ' +
      'source seconds; frames are given for the project fps.',
    params: [ASSET_ID],
    writes: false,
  },
  {
    name: 'set_asset_range',
    description:
      'Create or update (rangeId) one In/Out range on a video asset. Values are snapped to the frame ' +
      'grid and clamped to the asset duration; at least 1 frame. The first range becomes active.',
    params: [
      ASSET_ID,
      req('inSec', 'number', 'In point in source seconds.'),
      req('outSec', 'number', 'Out point in source seconds.'),
      p('name', 'string', 'Range name (generated when omitted).'),
      p('rangeId', 'string', 'Update an existing range instead of creating one.'),
    ],
    writes: true,
  },
  {
    name: 'remove_asset_range',
    description: 'Delete one saved range from a video asset.',
    params: [ASSET_ID, req('rangeId', 'string', 'Range id.')],
    writes: true,
  },
  {
    name: 'set_active_range',
    description:
      'Pick which saved range is used when the asset is inserted to the timeline. rangeId=null clears ' +
      'it (insert the full asset).',
    params: [ASSET_ID, p('rangeId', 'string', 'Range id, or null to clear.')],
    writes: true,
  },
  {
    name: 'detach_video_audio',
    description:
      'Move the embedded audio of a video clip onto a NEW audio track, aligned and locked to the video. ' +
      'The video is muted in the same step. Returns audioClipId + trackId.',
    params: [CLIP_ID],
    writes: true,
  },
  {
    name: 'set_audio_lock',
    description:
      'Lock or unlock a detached audio clip. While locked it follows the video clip on move / trim / ' +
      'split. Unlock keeps linkedVideoId but stops following.',
    params: [CLIP_ID, req('locked', 'boolean', 'true = follow the video again (snaps geometry now).')],
    writes: true,
  },
  {
    name: 'set_clip_audio',
    description:
      'Set audio properties of an audio clip OR a video clip (embedded track). gainDb is -60..+12 ' +
      '(0 = original, -60 = silent); fadeIn/fadeOut are seconds; muted only applies to video clips.',
    params: [
      CLIP_ID,
      p('gainDb', 'number', 'Static gain in dB (-60..+12).'),
      p('fadeIn', 'number', 'Fade-in in seconds.'),
      p('fadeOut', 'number', 'Fade-out in seconds.'),
      p('muted', 'boolean', 'Mute the embedded video track.'),
    ],
    writes: true,
  },
  {
    name: 'set_project',
    description: 'Change name / fps / resolution / duration / beatGrid / overlapBehavior. Each field is one undo entry.',
    params: [
      p('name', 'string', 'Project name (shown in the tab bar).'),
      p('fps', 'number', 'Frame rate.'),
      p('resolution', 'size', 'Canvas size.'),
      p('duration', 'number', 'Duration in seconds.'),
      p('beatGrid', 'json', '{ bpm, offset, beatsPerBar }.'),
      p('overlapBehavior', 'string', 'push | reject | trim', { enum: ['push', 'reject', 'trim'] }),
    ],
    writes: true,
  },
  {
    name: 'estimate_beat_grid',
    description:
      'Estimate BPM + offset from the EARLIEST audio clip and write them into beatGrid (same ' +
      'implementation as the toolbar button). Use it once after the user imported music, before ' +
      'placing anything on beats — a beat grid that is off by a few percent makes every accent ' +
      'land late. Fails loudly (no audio / silent / no clear pulse) instead of writing a guess; ' +
      'in that case set beatGrid by hand.',
    params: [],
    writes: true,
    slow: true,
  },
  {
    name: 'media_list',
    description:
      'The media pool: every asset with `id` / `kind` / `name`, whether it is in the project ' +
      '(a clip can reference it) or retained (removed but bytes still on disk), whether it is a ' +
      'LINKED file on the user\'s disk (`linked` / `stale`), whether the bytes are missing, its byte ' +
      'size, and `uses` = how many clips reference it (0 = unused). Also returns disk usage ' +
      '(trash / orphan counts) or null when the project has no directory. Read this before any ' +
      'delete/trash decision — never guess an asset id.',
    params: [],
    writes: false,
  },
  {
    name: 'media_op',
    description:
      'Operate the media pool. THESE MOVE OR DELETE FILES ON THE USER\'S DISK, so by default the ' +
      'call returns code=needs-approval and the app asks the user; the same call then runs once they ' +
      'confirm. (The user can turn "confirm media pool actions" off in settings.)\n' +
      'op:\n' +
      '  collect — copy a LINKED asset into the project folder (it becomes self-contained);\n' +
      '  relink — let the user pick a new source file for a linked/missing asset (needs a file dialog, ' +
      'may be unavailable in the browser);\n' +
      '  restore — bring a retained (removed) asset back into the project;\n' +
      '  trash — move a retained asset\'s file into assets/.trash (recoverable);\n' +
      '  delete — permanently delete a retained asset\'s file (NOT recoverable);\n' +
      '  trash_all / delete_all — the same for every retained asset;\n' +
      '  clear_trash — empty assets/.trash (only files already in the trash);\n' +
      '  cleanup_orphans — delete files in assets/ that no asset (active or retained) references.\n' +
      '`assetId` is required for collect / relink / restore / trash / delete. Returns how many items ' +
      'actually changed and the bytes freed — 0 means nothing happened (no project directory, asset ' +
      'not retained, source gone), not that it succeeded.',
    params: [
      req('op', 'string', 'collect | relink | restore | trash | delete | trash_all | delete_all | clear_trash | cleanup_orphans', {
        enum: [
          'collect',
          'relink',
          'restore',
          'trash',
          'delete',
          'trash_all',
          'delete_all',
          'clear_trash',
          'cleanup_orphans',
        ],
      }),
      p('assetId', 'string', 'Target asset (collect / relink / restore / trash / delete).'),
    ],
    writes: true,
  },
  {
    name: 'rename_asset',
    description:
      'Rename an asset\'s DISPLAY name (what the media pool shows). Only project.assets[id].name ' +
      'changes — the file on disk, its extension, and a linked asset\'s path stay exactly as they are. ' +
      'Existing clips keep their own labels (those are separate user data). Empty name is rejected.',
    params: [
      ASSET_ID,
      req('name', 'string', 'New display name (trimmed; must not be empty).'),
    ],
    writes: true,
  },
  {
    name: 'edit_sections',
    description:
      'Add / split / rename / remove / move a section marker. Sections store ONLY their start time: ' +
      'a section ends where the next one begins, and the last one ends at project duration. That is ' +
      'why "mark the drop" is `add` and "cut this one here" is `split`.\n' +
      'op: add { start, name? } | split { sectionId, at } | rename { sectionId, name } | ' +
      'remove { sectionId } | move { sectionId, start }.\n' +
      'start / at are SECONDS. add clamps to [0, duration]; split fails when either half would be ' +
      'shorter than the minimum gap (nothing is changed in that case). ' +
      'Returns the full sections list (sorted, start only) — read it back instead of re-fetching the scene.',
    params: [
      req('op', 'string', 'add | split | rename | remove | move', {
        enum: ['add', 'split', 'rename', 'remove', 'move'],
      }),
      p('sectionId', 'string', 'Target section (split / rename / remove / move).'),
      p('start', 'number', 'Start time in SECONDS (add / move).'),
      p('at', 'number', 'Cut time in SECONDS (split).'),
      p('name', 'string', 'Display name (add / rename).'),
    ],
    writes: true,
  },
  {
    name: 'set_beat_marks',
    description:
      'Replace the manual beat marks — the points a user taps along with the music (the toolbar\'s ' +
      '"tap tempo" modal writes the same field). Values are SECONDS. They are extra magnetic points ' +
      'for timeline snapping and are drawn as dashed lines over the timeline; they do NOT change ' +
      'beatGrid (bpm/offset), audio features, or any clip. Use them when the melody / hits do not ' +
      'sit on the uniform BPM grid, and read them from get_scene before editing: send the FULL list ' +
      '([] clears it). Unsorted input is sorted and values closer than 1 ms collapse. Returns the ' +
      'stored list (ascending) — read it back instead of re-fetching the scene.',
    params: [
      req(
        'marks',
        'numberArray',
        'Full list of mark times in SECONDS. [] clears; order does not matter (stored ascending).',
      ),
    ],
    writes: true,
  },
  {
    name: 'load_scene',
    description:
      'Replace the whole project content with a Project JSON (one undo entry). Prefer semantic calls ' +
      'for local edits; use this for wholesale re-composition. Do not paste the whole project in ' +
      'context unless you must — read with detail:ids first.',
    params: [req('project', 'json', 'A complete Project object.')],
    writes: true,
  },
  {
    name: 'begin_transaction',
    description: 'Open a transaction so the following writes collapse into ONE undo entry.',
    params: [],
    writes: false,
  },
  {
    name: 'commit_transaction',
    description: 'Close the transaction opened by begin_transaction.',
    params: [p('label', 'string', 'Undo label.')],
    writes: true,
  },
  {
    name: 'cancel_transaction',
    description: 'Roll back everything since begin_transaction.',
    params: [],
    writes: true,
  },
  {
    name: 'undo',
    description: 'Undo one entry.',
    params: [],
    writes: true,
  },
  {
    name: 'redo',
    description: 'Redo one entry.',
    params: [],
    writes: true,
  },

  /* ---------------------------------------------------------------- 排版 */
  {
    name: 'typo_add_element',
    description:
      "Add a text / shape / image element. element.kind selects the variant: " +
      "{kind:'text', text, frame?, style?, fill?, boxFill?, boxStroke?} | " +
      "{kind:'shape', shape, frame?, fill?, stroke?, radius?, sides?, waist?, inner?, angle?, path?} | " +
      "{kind:'image', assetId, frame?, fit?, crop?}. " +
      'Every variant also accepts `animation` (one) or `animations` (array) — same schema as ' +
      'typo_set_animation (preset / keys / custom css), so the element can arrive already ' +
      'animated in ONE call — plus `transform3d` for element-level 3D. ' +
      'Frames are { x, y, w, h, rot } in document px (rot in radians). Returns the stored element. ' +
      'Defaults you must know: a shape or generated shape is created with fill:none and no ' +
      'stroke — nothing is drawn unless you pass `fill` / `stroke` (the editor UI uses an accent ' +
      'fill, the agent path deliberately does not). For text, fill:{kind:\'solid\',color} is ' +
      'applied to style.color (gradient / radial / texture stay in `fill`). ' +
      'Units: radius / inner in px, waist is 0..1, angle in degrees, fontSize / letterSpacing in px.',
    params: [OPT_CLIP_ID, req('element', 'json', 'Element input (see description).')],
    writes: true,
  },
  {
    name: 'typo_add_elements',
    description:
      'Add many elements in ONE call and ONE undo entry. `elements` is an array of the same ' +
      'element inputs as typo_add_element; array order IS z order (later = in front). Use this ' +
      'instead of a long serial chain of typo_add_element calls. Returns { elementIds, elements } ' +
      'with the stored values.',
    params: [
      OPT_CLIP_ID,
      req('elements', 'json', 'Array of element inputs (same shape as typo_add_element.element).'),
    ],
    writes: true,
  },
  {
    name: 'typo_add_generated_shape',
    description:
      'Insert one of the 22 procedural SVG generators (rings, barcodes, contours, ...). Pass genId and ' +
      'optionally params / seed; the element becomes an ordinary shape afterwards. Read the ' +
      "generator's `notes` in get_typography_capabilities for units and clamping. Returns the " +
      'stored element.',
    params: [
      OPT_CLIP_ID,
      req('genId', 'string', 'Generator id (get_typography_capabilities).'),
      p('params', 'scalars', 'Generator parameters.'),
      p('seed', 'integer', 'Unsigned 32-bit seed (deterministic output).'),
      p('frame', 'json', 'Optional { x, y, w, h, rot }.'),
      p('name', 'string', 'Element name.'),
      p('fill', 'json', 'Paint object.'),
      p('stroke', 'json', 'Stroke object or null.'),
    ],
    writes: true,
  },
  {
    name: 'typo_update_element',
    description:
      'Patch one element: name, frame, blend, opacity, visible, locked, text, runs, style, fill, boxFill, ' +
      'boxStroke, glyphStroke (text only: {color, width}, -webkit-text-stroke), autoHeight ' +
      '(text only), stroke, radius, sides, waist, inner, angle, evenOdd, fit, crop, ' +
      'runs (text only: inline rich text `[{ text, style? }]` — replaces the whole run list; style keys ' +
      'are fontFamily / fontSize / fontWeight / fontStyle / letterSpacing / color / textDecoration / ' +
      'highlight; runs wins over text when both are sent), ' +
      'shadows (array of {color, dx, dy, blur}, document px), blur (px), ' +
      'depth (0..1: how much this element follows the camera — 0 = infinitely far / never moves, ' +
      '1 = glued to it; null removes it), ' +
      'transform3d (MERGES — send only {rotate:{y:35}} to tilt; null removes 3D), ' +
      'path (shape:"svg" only — writing it clears the generator binding, i.e. it bakes the shape; ' +
      'pair it with pathUnit:"px" for text-outline paths), pathUnit, clipFrame, ' +
      'gen (to re-seed a generated shape), animations (replace the list) / animation (replace ' +
      'with one) / addAnimation (append) / removeAnimations:true. ' +
      'Image-only: adjust ({brightness,contrast,saturation,sharpen,soften,curves} — MERGES, null removes; ' +
      'curves is {master?,r?,g?,b?:[{x,y}]} in 0..1), recolor ({color,shadow,amount 0..1}), ' +
      'border ({color,width} px, drawn inside), filter ({id,amount 0..1}, ids in ' +
      'get_typography_capabilities().images.filter.ids). Shape-only: imageFill ({assetId,fit}) clips that ' +
      'picture to the path — while it is set, `fill` is ignored (this is what crop-to-shape produces). ' +
      'Unknown keys are ignored. ' +
      'Returns the whole element ' +
      "as stored, so you don't need to re-read the document to confirm it landed. " +
      "For text, fill:{kind:'solid',color} writes style.color (same field, one semantics).",
    params: [OPT_CLIP_ID, ELEMENT_ID, req('patch', 'json', 'Whitelisted fields.')],
    writes: true,
  },
  {
    name: 'typo_update_elements',
    description:
      'Patch many elements in ONE call and ONE undo entry. `updates` is [{ elementId, patch }]. ' +
      'Every id is validated before anything changes. Returns { changed, elements } with the ' +
      'stored values — use this to restyle a whole set (e.g. 21 layers) without 21 round trips.',
    params: [
      OPT_CLIP_ID,
      req('updates', 'json', 'Array of { elementId, patch } (same patch keys as typo_update_element).'),
    ],
    writes: true,
  },
  {
    name: 'typo_set_animation',
    description:
      'Attach / replace / clear element animations (the same CSS animation system the editor ' +
      'uses — it renders in exports too, driven by the project clock).\n' +
      'PREFERRED form (structured track):\n' +
      '  { prop: "<channel | css-property>", keys: [ { t, v, ease?, color? }, ... ], loop?, ' +
      'easing?, direction?, fill? }\n' +
      'ONE animation animates ONE property. prop is x | y | sx | sy | rot | opacity | blur, or any ' +
      'CSS property name in kebab-case ("letter-spacing", "clip-path", "color", "transform"). ' +
      'keys[].t is ABSOLUTE SECONDS from the clip start (not 0..1 and not frames); { beat: n } is ' +
      'also accepted. keys[].v is a number (x/y px, sx/sy factor, rot degrees, opacity 0..1, blur ' +
      'px) or a raw CSS string for custom properties. keys[].ease is the easing of the segment that ' +
      'STARTS at that key (keyword or [x1,y1,x2,y2]); omit it to inherit the animation easing. ' +
      'keys[].color is an optional #rrggbb marker for the keyframe list in the editor — purely ' +
      'visual (it never reaches the style sheet), and it is echoed back on read. ' +
      'delay / duration are DERIVED from the first and last key (passing them changes nothing). ' +
      'To stagger properties, send SEVERAL animations with mode:"add" — each one becomes its own ' +
      'CSS animation with its own delay, so opacity and movement can start at different times. ' +
      'Do not animate the same property twice on the SAME target layer.\n' +
      'target (optional): "box" (default) animates the whole element box, so the text-box fill ' +
      'and border move with it (clip-path clips the box, rot spins the whole block). "content" ' +
      'animates only the text / svg / image itself and leaves the text-box background still — ' +
      'use it only when that is explicitly what you want. Both layers may animate the same ' +
      'property independently.\n' +
      'Other accepted forms:\n' +
      '  { css: "<@keyframes blocks + animation shorthand>", duration?, delay?, loop?, easing?, ' +
      'direction?, fill? }\n' +
      '  { preset: "<name>", duration?, delay?, loop?, easing?, direction?, fill?, params? } ' +
      '(expands into structured tracks)\n' +
      '  { keys: [ { at, opacity?, x?, y?, sx?, sy?, rot?, blur? }, ... ], duration?, delay?, ' +
      'loop?, easing? }  (legacy: at is 0..1 or { beat: n }; expands into one animation per ' +
      'property, t = delay + at * duration)\n' +
      'css is the editor\'s "custom animation" syntax: one or more `@keyframes name{…}` blocks plus ' +
      'ONE top-level `animation: name 1s ease 0s 1 normal both;` (comma-separate several). A bare ' +
      'keyframes body (`from{opacity:0}to{opacity:1}`) still works and takes its timing from ' +
      'duration / delay / loop / easing. Any animatable CSS property is allowed and names are ' +
      'namespaced per element — use this for 3D flips, clip-path wipes, color / background motion. ' +
      'Rejected (with the exact reason): top-level selectors, @import / @charset / @namespace, tags.\n' +
      'Preset names: call get_typography_capabilities().animations.presets (e.g. fade-in, ' +
      'slide-in-up, zoom-in, pop, spin, pulse, shake, blur-in).\n' +
      'x / y are px offsets, sx / sy scale, rot in DEGREES, blur in px, opacity 0..1. 2..20 keys. ' +
      'duration / delay are SECONDS. loop: "once" | "infinite" | number.\n' +
      'Pass animation:null to remove every animation from the element. mode:"add" stacks ' +
      'animations instead of replacing (each one gets its own wrapper, so fade + shake compose). ' +
      'Returns the stored element with the full animation list (prop + keys included, so it can be ' +
      'edited and sent back verbatim).',
    params: [
      OPT_CLIP_ID,
      ELEMENT_ID,
      p('animation', 'json', 'Animation object (schema above), or null to clear.'),
      p('mode', 'string', 'replace (default) | add', { enum: ['replace', 'add'] }),
    ],
    writes: true,
  },
  {
    name: 'typo_copy_style',
    description:
      "Paint ONE element's look onto other elements — the editor's format painter (what:'format') and " +
      "animation painter (what:'animation'), in ONE call and ONE undo entry.\n" +
      "what:'format' copies the APPEARANCE only: fill (a shape's fill lands on a text box's boxFill and " +
      'vice versa), stroke (same mapping), radius, text style (font / size / weight / line-height / ' +
      'align / color / decoration / highlight), image processing (fit / crop / key / quad / adjust / ' +
      'recolor / border / filter) and element shadows + blur. It never copies content (runs, assetId), ' +
      'geometry (frame, transform3d) or opacity / blend.\n' +
      "what:'animation' REPLACES the targets' animations with copies of the source's (ids are " +
      'regenerated; an empty source clears them).\n' +
      'Fields the target kind does not have are silently skipped (a shape has no fit / crop). ' +
      'Returns { changed, elements } with the stored values; changed = 0 means nothing differed.',
    params: [
      OPT_CLIP_ID,
      req('sourceId', 'string', 'Element to copy from.'),
      req('targetIds', 'stringArray', 'Elements to paint (the source itself is ignored).'),
      p('what', 'string', '"format" (default) | "animation"', { enum: ['format', 'animation'] }),
    ],
    writes: true,
  },
  {
    name: 'typo_set_scripts',
    description:
      'Replace the whole per-frame script list of a typography document (one undo entry; array ' +
      'order = execution order). [] clears it; omitting the field elsewhere keeps it.\n' +
      'Each entry: { id?, name?, code, enabled?, targets?, needs? }.\n' +
      'code is the body of a SYNCHRONOUS function with `ctx` in scope:\n' +
      '  ctx.t / ctx.frame / ctx.fps / ctx.duration / ctx.w / ctx.h / ctx.seed\n' +
      '  ctx.el(id) / ctx.els(kind?) -> handle: style(decls), transform({x,y,rotate,scale,skew}),\n' +
      '    opacity(v), visible(b), attr(name,value), path(d), var(name,value), canvas(), box(), d\n' +
      '  ctx.chars(elId) -> per-character handles (needs:["chars"])\n' +
      '  ctx.rand(i), ctx.ease(name,x), ctx.clamp/lerp/smoothstep, ctx.morph(dA,dB,k), ctx.hsl, ctx.log\n' +
      'transform: x/y in document px, rotate in DEGREES. path(d) applies to shape:"svg" elements and ' +
      'uses that element\'s pathUnit. canvas() returns a 2D context sized to the element (needs:["canvas"]).\n' +
      'Rules: stateless per frame (same t must give the same pixels), no Math.random / Date.now / ' +
      'timers / fetch (shadowed), no await, no DOM nodes of your own. Limits: 8 scripts, 20k chars ' +
      'each, 64k total, 5k writes per frame, 12 ms hard budget per script. Read ' +
      'get_typography_capabilities().scripts for the full API, limits and examples.\n' +
      'IMPORTANT: scripts only run after the user enables the global preference (off by default). ' +
      'While off the document renders exactly as if it had no scripts — tell the user to enable ' +
      'them instead of assuming the effect is visible.',
    params: [
      OPT_CLIP_ID,
      req('scripts', 'json', 'Array of script objects (schema above); [] clears the list.'),
    ],
    writes: true,
  },
  {
    name: 'typo_measure',
    description:
      'Measure a typography document WITHOUT rendering: per-element frame, measured text content ' +
      'height / line count / clipped overflow, how far elements stick out of the canvas, and ' +
      'pairwise overlaps (text-on-text flagged). Use it instead of guessing pixels when text ' +
      'overflows its box or elements collide, and before moving things around by trial and error. ' +
      'Text sizes are measured in the browser; `estimated:true` means no DOM was available.',
    params: [OPT_CLIP_ID, p('elementIds', 'stringArray', 'Only these elements. Omit = all.')],
    writes: false,
  },
  {
    name: 'typo_set_text',
    description: 'Replace an element\'s text (discards inline per-run formatting of the old runs).',
    params: [OPT_CLIP_ID, ELEMENT_ID, req('text', 'string', 'New plain text (may contain newlines).')],
    writes: true,
  },
  {
    name: 'typo_remove_element',
    description: 'Remove one element from the document.',
    params: [OPT_CLIP_ID, ELEMENT_ID],
    writes: true,
  },
  {
    name: 'typo_reorder_element',
    description:
      'Change z order. Array index = z order (later = in front).\n' +
      'op: front | back | forward | backward, or `index` to move to an absolute position ' +
      '(0 = furthest back, elements.length-1 = frontmost) — use it to slot an element between two ' +
      'specific ones, which the four relative ops cannot express.',
    params: [
      OPT_CLIP_ID,
      ELEMENT_ID,
      req('op', 'string', 'front | back | forward | backward | index', {
        enum: ['front', 'back', 'forward', 'backward', 'index'],
      }),
      p('index', 'integer', 'Target array index (op:"index"). Clamped to the element count.'),
    ],
    writes: true,
  },
  {
    name: 'typo_group',
    description: 'Group elements so they share a background / border shell. Members become contiguous in z order.',
    params: [
      OPT_CLIP_ID,
      req('elementIds', 'stringArray', 'At least 2 element ids.'),
      p('name', 'string', 'Group name.'),
    ],
    writes: true,
  },
  {
    name: 'typo_ungroup',
    description: 'Ungroup the groups that these elements belong to.',
    params: [OPT_CLIP_ID, req('elementIds', 'stringArray', 'Element ids.')],
    writes: true,
  },
  {
    name: 'typo_update_group',
    description:
      "Style a group's backing box (the shell behind its members). `typo_group` only creates it — " +
      'without this call the shell stays invisible (fill:none, no stroke).\n' +
      'patch: { name?, fill?, stroke?, radius?, padding? }.\n' +
      'fill is a Paint (kind none | solid | linear | radial | texture). stroke is a Stroke ' +
      '({ color, width, style, paint? }) or null (null removes the border). radius / padding are ' +
      'document px; padding is how far the shell extends beyond the members. ' +
      'Returns the stored group.',
    params: [OPT_CLIP_ID, req('groupId', 'string', 'Group id (from typo_group / get_typography_doc).'), req('patch', 'json', 'Whitelisted fields only.')],
    writes: true,
  },
  {
    name: 'typo_boolean',
    description:
      'Boolean two or more unlocked shapes. z order is the document order, not the order of `elementIds`.\n' +
      'op: union | difference | intersection | xor.\n' +
      'DIFFERENCE subtracts with the BOTTOM-most shape as the minuend ("drawn later cuts what was ' +
      'drawn earlier").\n' +
      'The result is ONE new `shape:"svg"` element placed where the topmost operand was; the operands ' +
      'are removed and the result carries no animations. An empty result (no overlap / fully ' +
      'subtracted) is an error and changes nothing — treat it as a signal, not a failure to retry. ' +
      'Returns the new element id (and its stored view).',
    params: [
      OPT_CLIP_ID,
      req('elementIds', 'stringArray', 'Two or more shape element ids.'),
      req('op', 'string', 'union | difference | intersection | xor', {
        enum: ['union', 'difference', 'intersection', 'xor'],
      }),
    ],
    writes: true,
  },
  {
    name: 'typo_divide',
    description:
      'Divide overlapping shapes into non-overlapping pieces (one element per region). Each piece ' +
      'inherits the look of the operand that covers it topmost, so A-minus-B keeps A\'s fill and the ' +
      'overlap takes B\'s — that is what makes "split" preserve the original look. Operands are ' +
      'removed, result pieces keep the original group. Returns their ids.',
    params: [
      OPT_CLIP_ID,
      req('elementIds', 'stringArray', 'Two or more shape element ids.'),
    ],
    writes: true,
  },
  {
    name: 'typo_convert_to_path',
    description:
      'Bake elements into explicit SVG paths (irreversible in one step, but one undo entry).\n' +
      '- parametric shapes (rect / ellipse / star …): converted in place (same id), path written in ' +
      'the 0..100 authored space, shape params cleared;\n' +
      '- generated shapes (`gen`): only the generator binding is dropped — their path is already baked;\n' +
      '- text elements: real glyph outlines (DOM layout + HarfBuzz), replaced by one or more ' +
      '`shape:"svg"` elements with `unit:"px"` paths. The first keeps the element id; several results ' +
      'are wrapped in a new group (padding 0).\n' +
      'All-or-nothing: a missing font / vertical text / synthetic bold fails the whole call and nothing ' +
      'is changed. Text conversion is slow. Returns the resulting element ids.',
    params: [OPT_CLIP_ID, req('elementIds', 'stringArray', 'Elements to bake (shape or text).')],
    writes: true,
    slow: true,
  },
  {
    name: 'typo_set_canvas_size',
    description:
      'Change the document canvas (design resolution). Two real intents, so it is a switch:\n' +
      '- scaleContent:true  = "change the format": every element frame, font size, letter spacing, ' +
      'stroke width, shadow / blur and 3D px value is rescaled by the w-ratio and h-ratio, so the ' +
      'composition is preserved (a 16:9 title card becomes the same card in 9:16, stretched per axis).\n' +
      '- scaleContent:false = only the canvas changes: elements keep their pixel positions, so the ' +
      'composition shifts and anything outside the new canvas is cropped.\n' +
      'Returns the stored size. Text clips fit their own document, so this is per-clip.',
    params: [
      OPT_CLIP_ID,
      req('size', 'size', 'New canvas size in px (both >= 2).'),
      p('scaleContent', 'boolean', 'Rescale elements / type with the canvas (default false).'),
    ],
    writes: true,
  },
  {
    name: 'typo_set_camera',
    description:
      'Set the typography 2.5D camera (parallax) BASE pose. The fields MERGE onto the current camera; ' +
      'null resets it to identity.\n' +
      'x / y = pan in DOCUMENT PX (positive x = the camera looks right, so elements slide left); ' +
      'zoom = magnification 0.05..40 (1 = none); rot = roll in DEGREES.\n' +
      'Only elements with `depth` react (set it with typo_update_element.depth): depth 0 (default) = ' +
      'infinitely far, it never moves; depth 1 = glued to the camera (pans, scales and rotates with it); ' +
      'values in between blend linearly — that difference IS the parallax.\n' +
      'A channel that has keyframes IGNORES this base — use typo_set_camera_animation for those. ' +
      'The camera never changes the layer rect: content pushed outside the canvas is cropped by the ' +
      'canvas edge. Returns the stored base camera, or null when it is identity.',
    params: [
      OPT_CLIP_ID,
      req('camera', 'json', '{ x?, y?, zoom?, rot? } (partial ok), or null to reset.'),
    ],
    writes: true,
  },
  {
    name: 'typo_set_camera_animation',
    description:
      "Keyframe ONE camera channel (document-level animation; the elements' own animations are " +
      'unrelated). REPLACES that channel\'s whole key list — pass null or [] to delete the channel ' +
      'and fall back to the base pose from typo_set_camera.\n' +
      'keys = [{ t, v, ease? }]: t is ABSOLUTE SECONDS inside the clip (0 = clip start), v is in the ' +
      "channel's unit (x / y px, zoom magnification, rot DEGREES). ease applies to the segment going " +
      'from this key to the next: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | ' +
      '[x1,y1,x2,y2] | { steps, jump }.\n' +
      'Channels are independent: keyframing zoom does not touch x / y / rot, and values before the ' +
      'first key / after the last key hold. Read the current keys back from get_typography_doc → ' +
      'cameraTracks (and write the same shape back).',
    params: [
      OPT_CLIP_ID,
      req('channel', 'string', '"x" | "y" | "zoom" | "rot".'),
      req('keys', 'json', '[{ t, v, ease? }] (>= 1 key), or null / [] to remove the track.'),
    ],
    writes: true,
  },
  {
    name: 'typo_layout',
    description:
      "Arrange elements. op: align (axis left|center-h|right|top|middle|bottom; target canvas|selection) | " +
      "distribute (axis h|v, needs >=3) | grid (cols, rows?, gap?, margin?) | row | column. " +
      'Omit elementIds to lay out every unlocked element.',
    params: [
      OPT_CLIP_ID,
      req('op', 'string', 'align | distribute | grid | row | column', {
        enum: ['align', 'distribute', 'grid', 'row', 'column'],
      }),
      p('axis', 'string', 'align/distribute axis.'),
      p('target', 'string', 'canvas | selection (align only).', { enum: ['canvas', 'selection'] }),
      p('elementIds', 'stringArray', 'Elements to move.'),
      p('cols', 'integer', 'grid columns.'),
      p('rows', 'integer', 'grid rows.'),
      p('gap', 'number', 'Gap in px.'),
      p('margin', 'number', 'Outer margin in px.'),
    ],
    writes: true,
  },
  {
    name: 'typo_set_background',
    description: "Set the document background Paint (kind none | solid | linear | radial | texture).",
    params: [OPT_CLIP_ID, req('paint', 'json', 'Paint object.')],
    writes: true,
  },
  {
    name: 'typo_set_theme',
    description:
      'Switch the color theme (null = default). Only elements whose colors are theme REFERENCES ' +
      '(`@accent1`, `@dk1.l80` …) recolor — raw hex stays as authored.\n' +
      'scope:"clip" (default) changes this document; scope:"project" also writes the project ' +
      'default and every text document in ONE undo entry (the "recolor the whole film" move). ' +
      'Theme ids come from get_typography_capabilities().themes; unknown ids are rejected instead ' +
      'of silently falling back to the default.',
    params: [
      OPT_CLIP_ID,
      p('theme', 'string', 'Theme id, or null for the default.'),
      p('scope', 'string', 'clip (default) | project', { enum: ['clip', 'project'] }),
    ],
    writes: true,
  },
  {
    name: 'typo_save_theme',
    description:
      'Create or update a CUSTOM color theme, and immediately make it the current one (same as the ' +
      'editor). Custom themes live in the project (`customThemes`), built-ins are read-only.\n' +
      'Fields: { id?, base?, name?, colors?, scope? }.\n' +
      '- id: update that existing custom theme (must exist). Omit to create a new one.\n' +
      '- base: clone this theme (built-in or custom) as the starting point. Omit = the theme the ' +
      'document uses now.\n' +
      '- colors: PARTIAL patch, e.g. { "dk1": "#0b0b0f", "accent1": "#ff8a00" }. Keys must be real ' +
      'slots (get_typography_capabilities().themeSlots); values must be hex. Omitted slots keep ' +
      'the base value, so you never have to read the whole palette back.\n' +
      '- scope: clip (default) | project (apply to every text document too).\n' +
      'Returns the stored theme (id / name / full colors) — reuse `theme.id` with typo_set_theme.',
    params: [
      OPT_CLIP_ID,
      p('id', 'string', 'Existing custom theme id (update instead of create).'),
      p('base', 'string', 'Theme id to clone as the base (built-in or custom).'),
      p('name', 'string', 'Display name.'),
      p('colors', 'json', 'Partial slot → hex patch.'),
      p('scope', 'string', 'clip (default) | project', { enum: ['clip', 'project'] }),
    ],
    writes: true,
  },
  {
    name: 'typo_remove_theme',
    description:
      'Delete a CUSTOM theme and clean every reference to it (`project.typographyTheme` + per-document ' +
      'themes), so no dangling ids are left behind. Built-in themes cannot be removed.',
    params: [req('themeId', 'string', 'Custom theme id (from get_typography_capabilities().themes).')],
    writes: true,
  },
  {
    name: 'typo_replace_doc',
    description:
      'Replace the whole typography document (one undo entry). Bad elements are dropped instead of ' +
      'failing the whole call — check the returned `dropped` count. Keys/fields that were not ' +
      'recognised come back in `droppedKeys` (e.g. "elements[2].colour"); animation entries that ' +
      'failed validation come back in `droppedAnimations` (e.g. "elements[2].animations[0]") — ' +
      'nothing is silently normalised away. Animations (preset, keys AND custom css), inline runs ' +
      'and `scripts` (omit the field to keep them) are preserved, so a document read with ' +
      'detail:full can be edited and written straight back.',
    params: [OPT_CLIP_ID, req('doc', 'json', 'A complete TypographyDocument.')],
    writes: true,
  },

  /* ---------------------------------------------------------------- 插件 */
  {
    name: 'plugin_try',
    description:
      'Validate + import + compile a single-file plugin in memory (no disk write). Returns qualified ' +
      "ids ('<plugin>/<local>') and structured issues. " +
      'OMIT `source` to apply the current draft (after plugin_edit) or the installed file on disk — ' +
      'you do not have to resend the whole file for a small fix. Provide `source` only for the first ' +
      'version of a new plugin. Requires explicit user approval (the source runs in the page ' +
      'immediately): without it this returns code=needs-approval and the panel asks the user. ' +
      'Call help(plugin-api) before writing source.',
    params: [
      req('id', 'string', 'Plugin id: [a-z0-9][a-z0-9._-]*'),
      p('name', 'string', 'Display name (defaults to the draft / installed name).'),
      p('source', 'string', 'Complete ESM source exporting `plugin`. Omit to use the draft.'),
    ],
    writes: false,
    slow: true,
  },
  {
    name: 'plugin_view',
    description:
      'Read a plugin source with line numbers, one page at a time. `offset` is the 1-based start ' +
      'line (default 1), `limit` is lines per page (default 200, max 500). Every line is prefixed ' +
      "like `  12 | code`; the last line of `text` is either `[N more lines; continue with " +
      "offset=M]` or `[end of file (N lines)]`. `origin` says whether you are reading the " +
      'in-memory draft (`draft`) or the installed file (`file`). Use this instead of pulling the ' +
      'whole source.',
    params: [
      req('pluginId', 'string', 'Plugin id (from plugin_list / plugin_try).'),
      p('offset', 'integer', '1-based start line. Default 1.'),
      p('limit', 'integer', 'Lines per page. Default 200, max 500.'),
    ],
    writes: false,
  },
  {
    name: 'plugin_edit',
    description:
      'Replace ONE exact literal in the plugin source. `oldString` must occur exactly once: 0 ' +
      'matches returns not-found, 2+ returns invalid-argument with the matching line numbers in ' +
      '`detail.lines` (add surrounding lines to disambiguate). Edits the in-memory draft only — ' +
      'nothing runs, nothing is written. Apply with plugin_try (omit `source`), then persist with ' +
      'plugin_install. Read with plugin_view / plugin_grep first.',
    params: [
      req('pluginId', 'string', 'Plugin id.'),
      req('oldString', 'string', 'Exact literal to replace. Must match exactly once.'),
      req('newString', 'string', 'Replacement text. Empty string deletes the match.'),
    ],
    writes: false,
  },
  {
    name: 'plugin_grep',
    description:
      'Search a plugin source with a regular expression. Returns matched lines with 1-based `line` ' +
      'numbers and the full line text; `total` is the count before `max` truncation. `context` ' +
      'adds up to 2 lines before/after each hit. Invalid regex → invalid-argument.',
    params: [
      req('pluginId', 'string', 'Plugin id.'),
      req('pattern', 'string', 'JavaScript regex source (no flags; use ignoreCase).'),
      p('ignoreCase', 'boolean', 'Case-insensitive match.'),
      p('context', 'integer', 'Lines of context around each hit (0–2).'),
      p('max', 'integer', 'Max matches to return. Default 40, max 200.'),
    ],
    writes: false,
  },
  {
    name: 'plugin_check',
    description:
      'Static syntax check of a plugin source: parses it as ESM with acorn and NEVER executes it. ' +
      'Issues carry 1-based line/column and a stable code: syntax | import | dynamic-import | ' +
      'no-export | bad-format (plugins are single-file, so any import fails at load time). Also ' +
      'returns `exports` (statically visible names). Cheaper than plugin_try — use it before asking ' +
      'the user to run anything.',
    params: [req('pluginId', 'string', 'Plugin id.')],
    writes: false,
  },
  {
    name: 'plugin_install',
    description:
      'Write the tried plugin into the project plugins/ directory. Requires explicit user approval: ' +
      'without it this returns code=needs-approval and the panel asks the user.',
    params: [req('pluginId', 'string', 'Plugin id from plugin_try.')],
    writes: false,
  },
  {
    name: 'plugin_list',
    description: 'Installed plugins with status, counts, issues and whether a draft exists.',
    params: [],
    writes: false,
  },
  {
    name: 'plugin_discard',
    description: 'Drop the in-memory draft (does not delete an installed file).',
    params: [req('pluginId', 'string', 'Plugin id.')],
    writes: false,
  },
  {
    name: 'plugin_remove',
    description: 'Unregister a plugin and delete its file from the project directory.',
    params: [req('pluginId', 'string', 'Plugin id.')],
    writes: false,
  },
  {
    name: 'plugin_source',
    description: 'Return the current draft source (for review / diffing).',
    params: [req('pluginId', 'string', 'Plugin id.')],
    writes: false,
  },
  {
    name: 'plugin_ui',
    description:
      'Plugin panels (manifest v3). action:"list" returns every installed plugin with its panels ' +
      '({ pluginId, panelId, name, icon, kind: float|modal|dock }) and actions (id, name, params). ' +
      'action:"open"/"close" toggles ONE panel on screen (UI state only, project content unchanged). ' +
      'Panels with icon:null have no rail button — open them through this tool. ' +
      'Do not drive a panel by opening it; call its actions with plugin_invoke instead.',
    params: [
      req('action', 'string', 'list | open | close', { enum: ['list', 'open', 'close'] }),
      p('pluginId', 'string', 'Plugin id (required for open / close).'),
      p('panelId', 'string', 'Panel id from plugin_ui list (required for open / close).'),
    ],
    writes: false,
  },
  {
    name: 'plugin_invoke',
    description:
      'Run a plugin action: actions[] declared by manifest v3, e.g. "apply a font to the selected ' +
      'text elements". This is the SAME code path as the buttons inside the plugin panel, so it is ' +
      'the agent-reachable way to use a plugin. `args` is an object keyed by the action params ' +
      '(shape from plugin_ui list: key / type / defaultValue / min / max / options). Omitted params ' +
      'use their defaultValue; UNKNOWN keys are rejected. Returns { value, truncated } — value is ' +
      'whatever the action returned, truncated to 16KB with truncated:true. ' +
      'An action that writes does so through the control plane, so each call is ONE undo step.',
    params: [
      req('pluginId', 'string', 'Plugin id.'),
      req('actionId', 'string', 'Action id from plugin_ui list.'),
      p('args', 'json', 'Action arguments keyed by param name.'),
    ],
    writes: true,
  },

  /* ---------------------------------------------------------------- 导出 */
  {
    name: 'export',
    description:
      'Export the project. format: mp4 | png (zip of the sequence) | gif. frameRange uses FRAME ' +
      'numbers, left-closed right-open. Large exports take a while; prefer small sizes for checks.',
    params: [
      req('format', 'string', 'mp4 | png | gif', { enum: ['mp4', 'png', 'gif'] }),
      p('frameRange', 'frameRange', '{ from, to } in frames.'),
      SIZE,
      p('frameStep', 'integer', 'Render every Nth frame (GIF).'),
    ],
    writes: false,
    slow: true,
  },
];

/** `name → spec`。会话层与执行器都按它查。 */
export const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------- JSON Schema 产出 */

function paramSchema(param: ToolParam): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.desc };
  switch (param.kind) {
    case 'string':
      base.type = 'string';
      break;
    case 'number':
      base.type = 'number';
      break;
    case 'integer':
      base.type = 'integer';
      break;
    case 'boolean':
      base.type = 'boolean';
      break;
    case 'size':
      base.type = 'object';
      base.properties = { w: { type: 'integer' }, h: { type: 'integer' } };
      base.required = ['w', 'h'];
      base.additionalProperties = false;
      break;
    case 'scalars':
      base.type = 'object';
      base.additionalProperties = { type: ['number', 'string'] };
      break;
    case 'frameRange':
      base.type = 'object';
      base.properties = { from: { type: 'integer' }, to: { type: 'integer' } };
      base.required = ['from', 'to'];
      base.additionalProperties = false;
      break;
    case 'curve':
      base.type = ['object', 'null'];
      break;
    case 'stringArray':
      base.type = 'array';
      base.items = { type: 'string' };
      break;
    case 'numberArray':
      base.type = 'array';
      base.items = { type: 'number' };
      break;
    default:
      // `json`: 结构由控制平面校验，这里只要求是对象。
      base.type = ['object', 'array', 'string', 'number', 'boolean', 'null'];
      break;
  }
  if (param.enum) base.enum = [...param.enum];
  return base;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * 一个工具参数的 JSON Schema（`type:'object'`）。
 *
 * 抽出来是因为 **Anthropic 也要用**：它的 `input_schema` 与 OpenAI 的 `parameters`
 * 是同一份东西，只是外面套的壳不同。写两份的话，某个参数的 `enum` / `required`
 * 迟早只有一边更新。
 */
export function toolParameters(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of spec.params) {
    properties[param.key] = paramSchema(param);
    if (param.required) required.push(param.key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Chat Completions 的 `tools` 数组。 */
export function openAiTools(specs: readonly ToolSpec[] = AGENT_TOOLS): OpenAiTool[] {
  return specs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: toolParameters(t) },
  }));
}
