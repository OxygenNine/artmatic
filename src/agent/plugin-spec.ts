/**
 * plugin-spec.ts — 给模型看的**协议说明书**（按需取，不进系统提示）。
 *
 * 为什么是运行期组装而不是一份静态 md：`EFFECT_HEAD` / `ALGO_HEAD` 里的
 * uniform 列表是**唯一真源**，手抄一份到文档里必然在某次加 uniform 时漂掉，
 * 而漂掉的后果是模型写出「重复声明 u_time」这类编译错误 —— 它自己看不出来。
 * 所以头部直接从常量拼，静态部分（工作流 / 例子 / 清单）放在 `plugin-api.md`。
 *
 * 另一半理由：工具表与系统提示要省 token。这些细节只在模型真去写插件时才拉。
 */

import guide from './plugin-api.md?raw';
import { EFFECT_HEAD } from '../effects/shader-def';
import { ALGO_HEAD } from '../algos/shader-lib';
import { tr } from '../i18n/index.svelte';

const HELPERS = `// Paste these small helpers into your single-file plugin - imports are not allowed.
const f = (gl, l, v, k) => { const p = l['u_' + k]; if (p) gl.uniform1f(p, Number(v[k]) || 0); };
const i = (gl, l, v, k) => { const p = l['u_' + k]; if (p) gl.uniform1i(p, Math.round(Number(v[k]) || 0)); };
const rgb = (hex) => {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const c3 = (gl, l, v, k) => { const p = l['u_' + k]; if (p) gl.uniform3f(p, ...rgb(v[k])); };
const sel = (map, fallback = 0) => (v) => map[String(v)] ?? fallback;
`;

/** 完整插件协议说明（`help('plugin-api')` 的返回）。 */
export function pluginReference(): string {
  return [
    '# Artmatic plugin API (single-file ESM)',
    '',
    '## Shared preludes (the runtime prepends these; do NOT redeclare them)',
    '',
    '### Effect fragment prelude (`EFFECT_HEAD`)',
    '```glsl',
    EFFECT_HEAD.trim(),
    '```',
    '',
    '### Realtime generator prelude (`ALGO_HEAD`)',
    '```glsl',
    ALGO_HEAD.trim(),
    '```',
    '',
    '## Value helpers you can paste (no imports allowed)',
    '```js',
    HELPERS.trim(),
    '```',
    '',
    guide.trim(),
  ].join('\n');
}

const TIMELINE_HELP = `# Timeline model

- \`t\` is SECONDS and is snapped to the frame grid \`round(t*fps)/fps\`. Fields that
  need frame numbers are named \`*Frame\` (\`frameRange.from/to\`, \`frameStep\`).
- \`tracks[]\` order is compositing order: \`tracks[0]\` is the FRONT-most track.
  The API also gives you \`z\` = (visual track count - 1 - visual index); for an
  effect clip, "below" means smaller \`z\` (later in the array).
- Clip kinds: \`source\` (algo / image / video / text / solid), \`effect\`
  (adjustment layer with \`chain[]\` of effects), \`audio\`.
- An effect clip only affects tracks BELOW it. \`affectDepth\` limits it to the
  nearest N enabled visual tracks (0 = all below).
- **Bound effect clips** (\`boundClipId\`): the chain runs on ONE source clip's own
  layer (placed, filtered, then blended with that clip's blend/opacity). z order and
  \`affectDepth\` are irrelevant, it cannot affect anything else, and several bound
  clips can coexist on the same track if their time ranges do not overlap. Use it
  for beat-level accents (0.25s strobe on one shot) instead of opening a track per
  hit. Bound and depth are mutually exclusive; binding to a missing clip does nothing.
- Track economy: a long chain on one effect clip beats a track per effect, and
  \`boundClipId\` beats a track per accent. A human has to read \`tracks[]\`; 20 tracks
  is a project nobody can edit by hand afterwards.
- Overlap is governed by \`project.overlapBehavior\` (\`push\` | \`reject\` | \`trim\`).
  A rejected placement changes NOTHING, so read the error instead of retrying
  the same coordinates.
- Every write is one undo entry. \`begin_transaction\` + \`commit_transaction\`
  groups a whole turn into one undo entry (a turn is wrapped automatically in
  the in-app panel; the MCP client should do it explicitly).
- Times for transitions: \`transitionOut\` hangs on the OUTGOING source clip; the
  window is centred on the cut (\`clip.end\`) and clamped by both neighbours.
- Adding a clip past the current end **grows \`project.duration\`** (deliberate: the
  extra tail is what an outgoing transition fades into black). Read \`describe()\`
  after bulk edits if the total length matters.

## Media pool (\`media_list\` / \`media_op\`)

\`media_list\` returns every asset with \`inProject\` / \`retained\` / \`linked\` /
\`stale\` / \`missing\` / \`bytes\` / \`uses\` (0 = unused) plus disk usage. Read it
before choosing an id — never guess.

\`media_op({ op, assetId? })\` moves or deletes FILES ON THE USER'S DISK:
\`collect\` (copy a linked asset into the project), \`relink\` (pick a new source
file), \`restore\` (bring a removed asset back), \`trash\` (move a retained file
into \`assets/.trash\`, recoverable), \`delete\` (permanent), \`trash_all\` /
\`delete_all\`, \`clear_trash\`, \`cleanup_orphans\`.

By default it returns \`needs-approval\` and the app asks the user (setting:
"confirm media pool actions", default ON); the call runs once they confirm. The
result's \`changed\` is how many items actually changed — **0 means nothing
happened** (no project directory, asset not retained, source gone), so never
report success without it. Prefer \`trash\` over \`delete\` unless the user asked for
permanent removal.

## Music (\`analyze_music\` / \`render_music_map\`)

\`analyze_music\` is the only way to know what the song is doing. It ensures the beat
grid, then returns a BAR-LEVEL map:

- \`sections[]\` — \`start\` / \`end\` / \`startBar\` / \`bars\`, a \`letter\` (A / B / A means the
  same musical material came back: transposition does not create a new letter, a
  different arrangement does), measured \`energy\` 0-3 relative to this song, \`dEnergy\`
  (change from the previous section), band shares, \`onsetDensity\`, \`brightness\`,
  \`noisiness\`, boundary \`novelty\`, and \`role\` + \`roleConfidence\`.
- \`drops[]\` — the sections the analysis reads as a drop, with their peak bar.
- \`bars[]\` — only with \`includeBars\`: per-bar energy / rms / onset count / novelty.
- \`grid.source\` — \`existing\` | \`estimated\` | \`default\`. \`default\` means no pulse was
  found and the fallback 120 / 0 grid is still in place: the structure is usable, the
  bar positions are not trustworthy for beat-accurate cuts.
- \`written\` — what happened to \`project.sections\`.

\`role\` is INFERENCE from energy and boundary strength. \`letter\`, \`energy\`, the band
shares and \`drops\` are measured. Do not tell the user "this is the chorus".

Boundaries are written into \`project.sections\` with \`source:"auto"\` unless you pass
\`markSections:false\`. A re-run replaces only the auto ones; anything the user marked or
edited stays. Changing \`beatGrid\` moves every bar — re-run \`analyze_music\` afterwards.

\`render_music_map\` draws the same map as one PNG (section ribbon, RMS envelope, 5-band
stack, onset density, novelty with its threshold line, bar numbers, playhead). Look at
it: a table cannot show that a build is flat.

## Audio variables in modulator expressions

A modulator expression can read the song and its structure:

- \`rms sub bass mid high air flux centroid flat\` — 0..1, peak-normalised over the track.
- \`energy\` — 0..3, the current section's energy (bar centres, linearly interpolated).
- \`section\` — 0-based section index; \`sectionU\` — 0..1 progress through that section.
- \`novelty\` — 0..1 boundary strength of the section you are in.
- \`bar\` — 0-based fractional bar; \`beatInBar\` — 0..beatsPerBar.

All of them are 0 without audio, except \`bar\` / \`beatInBar\`, which come from the grid
and always work. That means an \`add\` slot is a no-op in a silent project, while a
\`mul\` slot with gain 1 multiplies by 0 — prefer \`add\` for absolute quantities.

One expression such as \`energy / 3\` or \`sectionU\` replaces a pile of keyframes and
survives a re-analysis. Inside a section, that is usually the right way to get motion;
changing the generator is reserved for section boundaries.

## Sections (\`edit_sections\`)

A section stores ONLY its start time: section N ends where section N+1 starts, and
the last one ends at \`project.duration\`. That is why marking a drop is \`add\` and
cutting a long section is \`split\` (there is nothing to "resize").

\`op: add { start, name? } | split { sectionId, at } | rename { sectionId, name } |
remove { sectionId } | move { sectionId, start }\`

\`start\` / \`at\` are SECONDS. \`add\` clamps into \`[0, duration]\`. \`split\` fails (and
changes nothing) when either half would be shorter than the minimum gap — read the
error instead of assuming it cut. The sections come back sorted, so you can keep
composing against them without re-reading the scene.

A section may carry \`source: "auto"\`: \`analyze_music\` wrote it, and the next analysis
will replace it. Sections without that field are the user's; editing one (move / rename /
split) removes the marker so it is never auto-replaced again.

## Clip look (\`set_clip_props\`)

Beyond \`label / fadeSec / blend / opacity / transform / fit / affectDepth / boundClipId\`:

| field | applies to | semantics |
|---|---|---|
| \`fadeIn\` / \`fadeOut\` | audio clips | seconds; \`fadeIn + fadeOut <= clip length\` (clamped); \`0\` removes |
| \`srcIn\` | audio / video | source offset in seconds — shifts the content inside the clip, does NOT move its edges |
| \`crop\` | source clips | \`{ left, top, right, bottom }\` = fraction of the SOURCE cut away (0..1). Narrow the window only, never scales the content |
| \`quad\` | source clips | \`{ tl, tr, br, bl }\`, each \`[x, y]\` in layer space. Degenerate (zero-area) quads are rejected — they render as nothing |
| \`key\` | image / video | \`{ color: "#rrggbb", tolerance?, softness?, spill? }\` (0..1). Omitted fields keep their value |

Typography image elements accept the same \`key\` / \`quad\` fields through
\`typo_update_element\` (they are validated by the same code): \`null\` turns them
off, and a degenerate (zero-area) quad is rejected because it renders as nothing.

Passing \`null\` turns that effect OFF (field removed). All of these come back in
\`applied\` as the stored value. \`fadeSec\` is the VISUAL clip's cut fade — a
different thing from the audio fades.

Switch a single effect instance off with \`set_params({ target: 'effect', chainIndex })\`
— pass \`enabled\` only (no \`params\`) when you just want the A/B comparison. Two
candidate looks are easier to judge by toggling one instance than by deleting it.

\`set_generator\` replaces an algo clip's generator: params are reset to the new
generator's defaults (then merged with \`params\`), and curves keyed by the OLD
generator's params are deleted. Other curves (\`opacity\`, \`transform.*\`) survive.

## Curves (\`set_curve\`)

\`\`\`json
{
  "mode": "keyframe | impulse | follower",       // default keyframe
  "keys": [
    { "t": 0,   "v": 0, "interp": "smooth" },
    { "t": 0.5, "v": 1, "interp": "smooth", "hOut": [0.15, 0], "hIn": [-0.15, 0] }
  ],
  "beatAnchor": { "beat": 8 },
  "impulse": { "decay": 0.3 },
  "follower": { "attack": 0.05, "release": 0.3 }
}
\`\`\`
- \`t\` is SECONDS (relative to the clip start, or to the anchored beat), \`v\` is the
  value (there is no \`value\` key). \`interp\` defaults to \`smooth\` and only affects
  the segment from that key to the NEXT one. Keys must be sorted by \`t\`.
- \`hOut\` / \`hIn\` are bezier handle offsets \`[seconds, value]\` relative to the key;
  they only matter when the segment's \`interp\` is \`bezier\`.

## Key namespace (which \`param\` string to use)

| clip kind | keys |
|---|---|
| source | \`opacity\`, \`transform.x/y/sx/sy/rot\`, plus every range generator param (e.g. \`zoom\`) |
| effect | \`<instanceId>.<paramKey>\` for every range param of every instance in the chain |
| audio | \`gain\` |

\`set_curve\` also accepts readable forms when they are unambiguous: a unique
instanceId **prefix** (\`fx-38a8.amount\`), a defId when the chain has exactly one
instance of it (\`blur.amount\`), or the bare param key when only one instance has
it. Ambiguity is an error listing every candidate (chainIndex + full instanceId).
\`add_effect\` returns \`keyPrefix\` — \`keyPrefix + "<param>"\` is always valid.

## Isolation (\`only\` on render_frame / frame_signature / render_sequence)

\`only: { trackId: <id | id[]>, elementId: <id | id[]> }\` hides every visual track
that is not listed — **including effect (adjustment) clips on their own tracks**.
It answers "what does this layer look like by itself"; it is NOT a way to test a
chain (render without \`only\` for that). Effects bound to a listed clip stay, because
they are part of that layer. The result echoes \`layers\` (the tracks/clips that
actually composited) — if a chain looks like it did nothing, compare that list.

Common workflow:
1. \`get_scene({ detail: 'ids' })\` - cheap overview.
2. \`get_capabilities({ detail: 'params', ids: [...] })\` - only the defs you plan to use.
3. Add / move clips, set params.
4. \`frame_signature({ t })\` to verify numerically, \`render_frame({ t })\` to look.
5. If a shader def id is wrong the renderer silently skips it - always take the
   id from the capability list instead of inventing one.`;

const TYPOGRAPHY_HELP = `# Typography documents

A text clip owns a \`TypographyDocument\`:

- \`size\` (document pixels, top-left origin, y down), \`background\` (Paint),
  \`elements[]\`, \`groups[]\`, \`fonts[]\`, optional \`theme\`.
- \`elements\` array index IS the z-order: index 0 is the bottom, last is the front.
  Do not invent a \`z\` field; use \`typo_reorder_element\`.
- Element kinds:
  - \`text\`: \`runs\` (plain text input is fine - we convert it), \`style\`
    (fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, align, vAlign,
    color, textDecoration, textTransform, highlight, shadow, writingMode),
    optional \`fill\` (gradient / texture on glyphs), \`boxFill\`, \`boxStroke\`
    (the box rectangle), \`glyphStroke\` (\`{ color, width }\`, an outline on the
    glyphs themselves via \`-webkit-text-stroke\`; width is centred, so half of
    it eats into the glyph). A SOLID \`fill\` is the same thing as \`style.color\`:
    passing \`{kind:'solid',color}\` writes \`style.color\` (gradient / radial /
    texture are the only kinds that live in \`fill\`). Both spellings work.
  - \`shape\`: \`shape\` kind (rect / ellipse / line / triangle / star / polygon /
    trapezoid / parallelogram / arrow / ring / frame / pie / svg), \`fill\`,
    \`stroke\`, \`radius\` (px), \`sides\` (count), \`waist\` (0..1), \`inner\` (px
    wall thickness), \`angle\` (degrees), \`path\` (for svg). If you give
    \`stroke\` and omit \`fill\`, the fill defaults to NONE - an outline shape
    does not get a solid block behind it.
  - \`image\`: \`assetId\`, \`fit\`, optional \`crop\`, \`radius\`.
- Every element also takes \`shadows\` (array of \`{ color, dx, dy, blur }\` in
  document px, rendered as chained \`filter: drop-shadow()\`), \`blur\` (px,
  \`filter: blur()\`) and \`transform3d\` (element-level 3D; a patch MERGES, \`null\`
  removes it — order is perspective → translate → rotate → skew → scale, degrees
  for angles). A stroke's optional \`paint\` (same Paint shape) fills it with a
  gradient / texture instead of \`color\`. Text elements have \`autoHeight\` (fixed
  width, height follows content); \`shape:"svg"\` elements have \`path\` +
  \`pathUnit\` (\`"px"\` for text-outline paths) — writing \`path\` bakes away the
  generator binding.
- \`frame\` is the unrotated bounding box: \`{ x, y, w, h, rot }\` in document px.
  Rotation is around the box centre (radians).
- \`Paint\`: \`{ kind: 'none' }\` | \`{ kind:'solid', color }\` |
  \`{ kind:'linear', angle, stops:[{offset,color}] }\` |
  \`{ kind:'radial', stops }\` | \`{ kind:'texture', pattern, color, bg, scale, thickness }\`.
- Colors may reference the document theme: \`@accent1\`, \`@dk1\`, \`@lt1\` etc.
  Changing \`theme\` then recolors every element that uses a theme reference.

Layout: prefer \`typo_layout\` over hand-computing coordinates. It supports
\`align\` (canvas or selection), \`distribute\` (>=3 elements), \`grid\`, \`row\`,
\`column\` with \`gap\` / \`margin\`. Use \`typo_add_generated_shape\` for the 22
procedural SVG generators (rings, barcodes, contours, ...) - they accept
\`{ genId, params, seed }\` and become ordinary shape elements afterwards.

Units (also in \`get_typography_capabilities().units\`): frame x/y/w/h are
document px, \`rot\` is RADIANS. \`fontSize\` and \`letterSpacing\` are px (NOT em:
8 = 8px between glyphs); \`lineHeight\` is a MULTIPLIER of the font size (1.2 =
120%). Generator params are authored in a 0..100 box stretched to the element
frame; length-like values are ~1% of the frame side each, ratio-like values
(range 0..1) are fractions. A generator's \`notes\` flags clamping (e.g.
\`rings.width\` is capped by the ring pitch) and the paint rule (generators are
closed paths: paint them with \`fill\`, not \`stroke\` — a normal stroke width is
wider than a bar and neighbouring outlines merge into a solid plate).

Defaults for agent-created elements: shapes and generated shapes get
\`fill:{kind:'none'}\` and no stroke unless you pass them (nothing is drawn by
accident). No animation is attached unless you ask for one.

## Animation

\`typo_set_animation({ clipId?, elementId, animation, mode? })\` — one call,
one undo entry. Three forms:

\`\`\`json
{ "css": "@keyframes flip{from{transform:rotateY(90deg);opacity:0}to{transform:rotateY(0);opacity:1}}\\nanimation: flip .7s ease-out both;" }
\`\`\`
\`\`\`json
{ "preset": "slide-in-up", "duration": 0.6, "delay": 0, "loop": "once", "easing": "ease-out" }
\`\`\`
\`\`\`json
{
  "duration": 0.8, "easing": "ease-out",
  "keys": [
    { "at": 0,   "opacity": 0, "y": 40, "sx": 0.8 },
    { "at": 0.6, "opacity": 1, "y": 0,  "sx": 1.05 },
    { "at": 1,   "opacity": 1, "y": 0,  "sx": 1 }
  ]
}
\`\`\`
- \`css\` is the editor's "custom animation" syntax: one or more \`@keyframes name{…}\`
  blocks plus ONE top-level \`animation: name <duration> …;\` (comma-separate
  several). A bare keyframes body (\`from{…}to{…}\`) also works and takes its
  timing from \`duration\` / \`delay\` / \`loop\` / \`easing\`. **Any animatable CSS
  property** is allowed (3D rotate / clip-path / color / background-position …);
  names are namespaced per element, so two elements may each define
  \`@keyframes pulse\`. Top-level selectors, \`@import\` / \`@charset\` / \`@namespace\`
  and HTML tags are rejected — with the specific reason.
- \`at\` is 0..1 of the animation, or \`{ "beat": n }\` (converted with the project
  BPM). \`duration\` / \`delay\` are SECONDS; \`loop\` is \`"once" | "infinite" | number\`
  (\`iterations\` is accepted too — it is the read-back field name).
- Key props: \`opacity\`, \`x\`/\`y\` (px offsets), \`sx\`/\`sy\` (scale), \`rot\` (DEGREES),
  \`blur\` (px). 2..20 keys. When the motion needs something outside these seven
  properties, write \`css\` instead of approximating it.
- Preset names: \`get_typography_capabilities().animations.presets\`. Do not guess
  the spelling — a wrong name is rejected, not silently ignored.
- \`mode:'add'\` stacks another animation on the same element (each gets its own
  wrapper), so \`fade-in\` + \`shake\` compose. \`animation:null\` clears them all.
- Animations live in the document and are evaluated by the project clock: they
  are real in exports, not a preview-only effect. \`typo_add_element\` accepts the
  same field (\`animation\` / \`animations\`) so a new element can arrive animated
  in one call.

## Paths: bake, boolean, divide

- \`typo_convert_to_path({ elementIds })\` bakes elements into explicit SVG paths:
  parametric shapes in place (same id, 0..100 authored space, shape params cleared),
  generated shapes only lose their generator binding, and TEXT becomes real glyph
  outlines (one shape per color / text box, \`pathUnit:"px"\`; several results are
  wrapped in a new group). Text conversion is async and all-or-nothing: a missing
  font / vertical text / synthetic bold fails the call and nothing changes.
- \`typo_boolean({ elementIds, op })\` — op: union | difference | intersection | xor.
  z order comes from the document, not from \`elementIds\`. DIFFERENCE subtracts with
  the BOTTOM-most shape as the minuend. The result is one new \`shape:"svg"\` element
  at the topmost operand's z position, with no animations; an empty result is an
  error and changes nothing.
- \`typo_divide({ elementIds })\` — splits the arrangement into non-overlapping
  pieces; each piece keeps the look of the operand that covers it topmost.
- Vertex editing needs no tool: \`path\` is writable (\`typo_update_element\`), so
  insert / remove / move an anchor by editing the \`d\` string. Remember to keep
  \`pathUnit:"px"\` for text-outline paths (0..100 would stretch their stroke).

## Canvas, group boxes, themes

- \`typo_set_canvas_size({ size, scaleContent })\` changes \`doc.size\`. \`scaleContent:true\`
  rescales every element (frame / font size / letter spacing / stroke width /
  shadow / blur / 3D px), so the composition is preserved — that is "change the
  format". \`false\` only changes the canvas: elements keep their pixel positions,
  so the composition shifts and anything outside is cropped.
- \`typo_group\` only creates the backing box; without \`typo_update_group\` the box
  stays invisible (\`fill:none\`, no stroke, padding 8). Patch
  \`{ name, fill, stroke, radius, padding }\` — \`stroke:null\` removes the border.
  Both \`typo_group\` and \`typo_update_group\` return the group (\`groupId\` /
  stored box) so you never need to re-read the document.
- Themes: \`typo_set_theme({ theme, scope })\` switches; \`scope:'project'\` writes
  the project default and EVERY text document in one undo entry. Only colors
  written as theme refs (\`@accent1\`, \`@dk1.l80\`) follow — raw hex stays.
  \`typo_save_theme({ base, name, colors })\` creates a custom theme from \`base\`
  (or the current one) with a PARTIAL slot patch; slot keys are
  \`get_typography_capabilities().themeSlots\`. \`typo_remove_theme\` deletes a
  custom theme and cleans every reference to it.

Bulk work: \`typo_add_elements\` / \`typo_update_elements\` take arrays and
commit ONE undo entry (array order = z order for adds). Every write returns
the stored element(s), so do not re-read the whole document to confirm.

Whole-document writes: \`typo_replace_doc\` drops bad elements (\`dropped\`), reports
every unrecognised key in \`droppedKeys\` (\`elements[2].colour\`) and every animation
entry that failed validation in \`droppedAnimations\` (\`elements[2].animations[0]\`).
Read both — a silent normalisation looks exactly like success.
\`get_typography_doc({detail:'full'})\` output is round-trippable: animations
(preset, keys and custom css), paints, styles, 3D, generator state and inline runs
all come back, so edit-and-write-back is a legitimate workflow.

Inline rich text: a text element's \`runs\` is \`[{ text, style? }]\` and is returned
ONLY when some run actually overrides something (otherwise \`text\` rebuilds the
same runs). Style keys are \`fontFamily\`, \`fontSize\` (px), \`fontWeight\`,
\`fontStyle\`, \`letterSpacing\` (px), \`color\`, \`textDecoration\`, \`highlight\`; a
missing key inherits the element style. Send \`runs\` to \`typo_update_element\` (or
in a new element) to replace the whole list — \`text\` is the plain-text shorthand.

## Document scripts (per-frame JS)

\`doc.scripts\` is optional; array order is execution order:
\`[{ id, name, code, enabled, targets?, needs? }]\`. \`typo_set_scripts({ clipId, scripts })\`
replaces the whole array (one undo entry); \`scripts: []\` clears it and omitting
the field keeps the existing scripts. \`get_typography_doc({detail:'full'})\`
returns it verbatim, so read → edit → write back is lossless.

\`code\` is the body of a SYNCHRONOUS function; \`ctx\` is in scope:

\`\`\`js
const el = ctx.el('element-id');        // null if not rendered
if (el) { el.opacity(ctx.ease('out', Math.min(1, ctx.t))); el.transform({ y: 24 }); }
\`\`\`

- Time: \`ctx.t\` (seconds, local to the clip), \`ctx.frame\`, \`ctx.fps\`, \`ctx.duration\`,
  \`ctx.w\`/\`ctx.h\` (document px), \`ctx.seed\`.
- Elements: \`ctx.el(id)\`, \`ctx.els(kind?)\`. Handle: \`style(decls)\`, \`transform({x,y,rotate,scale,skew})\`
  (translate px, rotate DEGREES), \`opacity\`, \`visible\`, \`attr(name,value)\`,
  \`path(d)\` (SVG shapes; \`pathUnit\` tells you the coordinate space), \`var(name,value)\`,
  \`canvas()\` (2D context, cleared each frame), \`box()\`, \`d\` (authored path).
- Per character: \`ctx.chars(elId)\` returns \`[{ index, count, char, style, transform, opacity }]\`.
  It is empty unless the script declares \`needs:['chars']\` for that element.
- Pure helpers: \`ctx.rand(i)\` (deterministic per frame+script+i), \`ease('linear'|'in'|'out'|'in-out', x)\`,
  \`clamp\`, \`lerp\`, \`smoothstep\`, \`morph(pathA, pathB, k)\`, \`hsl(h,s,l)\`, \`log(...)\`.
- \`needs\`: \`'chars'\` builds per-character spans (typing in that text pauses the effect);
  \`'canvas'\` inserts a 2D canvas sized to the element. \`targets\` limits those extras
  to the listed element ids (default: every element).
- Rules: NO state between frames (same \`t\` must give the same pixels), no
  \`Math.random\` / \`Date.now\` / network / timers (they are shadowed), no \`await\`,
  no DOM nodes of your own. Limits: 8 scripts, 20k chars each, 64k total,
  5k writes/frame, 12ms hard budget per script.
- **Scripts only run when the user has enabled them** (a global preference, off by
  default). While off the document renders exactly as if it had no scripts, so do
  not use a script when the effect must be visible without asking the user first.

Geometry: call \`typo_measure\` when text may overflow its frame, elements may
collide, or something may sit outside the canvas. It reports measured text
content height, clipped overflow, pairwise intersections and per-element
out-of-canvas amounts. \`render_frame({ only: { trackId } | { elementId } })\`
renders one layer in isolation without modifying the project.`;

const WORKFLOW_HELP = `# Working with this editor

1. Read before writing: \`get_scene({detail:'ids'})\` / \`get_typography_doc({detail:'ids'})\`.
2. Ask for capabilities only for the ids you intend to use
   (\`get_capabilities({detail:'params', ids:[...]})\`).
3. Make changes with explicit tool calls. Use \`typo_add_elements\` /
   \`typo_update_elements\` when a whole set changes together (one undo entry).
   The in-app panel wraps a whole turn in one transaction, so a failed attempt
   is one undo away.
4. Look at the result: \`render_frame({ t })\` returns an image; sizes default to
   640x360 and are cheap. Use \`frame_signature\` when you only need "did anything
   change / is there structure". \`render_sequence({from,to,step})\` gives a
   contact sheet for rhythm / beat timing. All three accept
   \`only:{trackId|elementId}\` (string or array) to inspect specific layers
   without touching the project — remember it hides effect tracks too, and the
   result's \`layers\` field says what really composited. For text overflow /
   overlaps, \`typo_measure\` is cheaper than guessing pixels. For fine detail,
   use \`region\` on render_frame instead of a huge render size.
5. Report what you changed in one or two sentences. Do not dump JSON.

Rules:
- Never invent ids (clip ids, def ids, asset ids): read them first.
- \`t\` is seconds. A clip's span is \`[start, end)\`.
- If a tool returns \`{ ok:false, error }\`, read \`error.code\` and \`error.detail\`;
  \`invalid-argument\` usually means a wrong key or a value out of range.
- Determinism matters: the same \`t\` always renders the same frame. Do not ask
  for "randomness" - set the project seed or generator parameters instead.`;

const IMAGE_HELP = `# Screenshots

- \`render_frame({ t, size? })\` renders through the SAME evaluation path as preview
  and export (including \`onSeek\` + async text rasterization). It temporarily pins
  the render size and restores it afterwards; the preview is not left resized.
- Images are injected as a user message right after the tool result (the chat API
  only accepts images in user messages). Each image costs at most ~1k tokens.
- Prefer small sizes. \`detail:'low'\` is used by default; ask for a larger size
  only when you need to read small text.
- **Zoom instead of raising the resolution**: \`region: { x, y, w, h }\` (0..1)
  crops the rendered frame and upscales it to >=480px wide. ASCII / halftone /
  2px strokes are unreadable at 640 wide but obvious in a zoomed crop, and the
  token cost is the same.
- **Motion needs a sequence**: \`render_sequence({ from, to, step, size, cols })\`
  returns ONE contact-sheet image (each cell labelled with its time). A single
  still cannot tell you whether an accent lands on the beat. Keep cells small.
- Numeric alternative: \`frame_signature({ t, grid })\` returns per-channel means,
  spread, block means and sample colors. Use \`spread\` to answer "is there any
  structure" and per-channel means to catch color changes.
- Both \`render_frame\` and \`frame_signature\` echo \`layers\`: the tracks and clips
  that actually composited. When \`only\` is used, this is the only way to see that
  an effect track was hidden by the isolation (the picture looks identical to
  "my parameter did nothing").
- **Seeding a grid simulation with an image**: \`seed_pattern_from_asset({ clipId,
  param:'pattern', assetId })\` samples a media-pool image (PNG / SVG) by OPACITY at
  the generator's current grid size — pixels with alpha >= 50% become live cells,
  colour and brightness are ignored — and switches \`seedMode\` to \`pattern\` in the
  same undo step. Use \`media_list\` for asset ids. Hand-drawn patterns still go
  through \`set_params({ params:{ pattern } })\` with the \`WxH:<base64>\` encoding.`;

export type HelpTopic = 'plugin-api' | 'timeline' | 'typography' | 'workflow' | 'images';

export const HELP_TOPICS: HelpTopic[] = ['plugin-api', 'timeline', 'typography', 'workflow', 'images'];

/** `help(topic)` 的实现。未知 topic 返回可用清单（而不是抛错 —— 模型能自我纠正）。 */
export function helpText(topic: string | undefined): string {
  switch (topic) {
    case 'plugin-api':
      return pluginReference();
    case 'timeline':
      return TIMELINE_HELP;
    case 'typography':
      return TYPOGRAPHY_HELP;
    case 'workflow':
      return WORKFLOW_HELP;
    case 'images':
      return IMAGE_HELP;
    default:
      return `${tr('agent.llm.toolUnknown', { name: `help(${String(topic)})` })}\nAvailable topics: ${HELP_TOPICS.join(', ')}`;
  }
}
