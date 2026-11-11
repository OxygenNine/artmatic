## 1. File shape

A plugin is **one ESM file**. No imports, no relative modules, no top-level side
effects, no DOM / WebGL access at module scope (the host imports your file into
the page realm, but execution happens later, inside the renderer).

```js
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 3,
  id: 'my-plugin',                 // [a-z0-9][a-z0-9._-]*, <= 64
  name: 'My plugin',
  author: 'you', version: '1.0.0', license: 'MIT',
  effects: [ /* see section 3 */ ],
  generators: [ /* see section 4 */ ],
  typography: { hooks: [ /* see section 6 */ ] },
};
```

`apiVersion` is always `3`. `effects`, `generators`, `typography.hooks`,
`panels`, `actions` may all be omitted, but at least one of them (or
`activate`) must be present.
Every `id` inside the arrays is **local**; the host exposes it as
`"<plugin id>/<local id>"`. Use local ids inside the source, qualified ids when
you call `artmatic_add_effect` / `artmatic_add_clip`.

## 2. Parameters (`params`)

`params` is an array of plain objects. All variants share `key`, `labelKey`
(a plain string is fine - it is shown as-is) and `type`.

| type | required fields | notes |
|---|---|---|
| `range` | `min`, `max`, `step`, `defaultValue` | the only type that can be keyframed |
| `select` | `defaultValue`, `options: [{ value, labelKey }]` | dispatched as an `int` index, see section 5 |
| `checkbox` | `defaultValue` (0 or 1) | dispatched as `int` |
| `color` | `defaultValue` (`#rrggbb`) | dispatched as `vec3` in 0..1 |
| `bitmask` | `bits`, `defaultValue`, `groups` | generator-only in practice |
| `pattern` | `defaultValue` (string) | generator-only |
| `text` | `defaultValue` (string) | not keyframable |
| `asset` | `defaultValue` (string) | a media-pool **image** assetId; `''` = unbound. Not keyframable. See section 4.1 for how to actually sample it |

Keep keys short and stable: they become the uniform names `u_<key>`.

## 3. Effect definition

```js
{
  id: 'scanline',
  name: 'Scanline',
  desc: 'A moving bright line.',
  category: 'style',                 // style|color|glitch|geometry|blur|signal
  tags: ['overlay'],
  params: [
    { key: 'amount', labelKey: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    { key: 'tint',   labelKey: 'Tint',   type: 'color', defaultValue: '#ffffff' },
  ],
  shader: {
    // fragment WITHOUT the shared head (printed above this guide)
    fragment: `
void main() {
  vec4 src = texture(u_texture, vUv);
  float y = fract(vUv.y + u_time * 0.2);
  float line = smoothstep(0.02, 0.0, abs(y - 0.5));
  outColor = vec4(mix(src.rgb, u_tint, line * u_amount), src.a);
}`,
    setUniforms: (gl, locs, values) => {
      const a = locs.u_amount; if (a) gl.uniform1f(a, Number(values.amount) || 0);
      const t = locs.u_tint;   if (t) {
        const hex = String(values.tint || '#ffffff');
        const n = parseInt(hex.slice(1), 16);
        gl.uniform3f(t, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
      }
    },
  },
}
```

Optional `shader` fields (only use them when you actually need them):

- `prePasses: [{ fragment, linearFilter?, feedback?, delayedInput? }]` - full-screen
  passes before the main pass. The first reads the effect input, the last one's
  output becomes `u_texture` of the main pass. **Dispatch your parameters in every
  pass that declares them** (the host calls `setUniforms` once per pass).
- `feedback: true` - allocate a per-instance history texture (`u_feedback`).
  Required if the fragment samples `u_feedback`; otherwise it reads an unbound
  texture and looks like "no trail" with no error.
- `hdrFeedback: true` - 16-bit history for slow state accumulation.
- `linearFilter` / `opaqueOutput` / `stateful` - see the type definitions.

## 4. Generator definition (`realtime` only)

```js
{
  id: 'ripple',
  name: 'Ripple',
  params: [
    { key: 'freq', labelKey: 'Frequency', type: 'range', min: 1, max: 40, step: 0.5, defaultValue: 12 },
    { key: 'amp',  labelKey: 'Amplitude', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  ],
  fragment: `
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  float v = sin(r * u_freq * 6.2831 - u_time * 2.0) * exp(-r * 4.0) * u_amp;
  vec3 c = mix(vec3(0.02, 0.03, 0.05), vec3(0.6, 0.9, 1.0), 0.5 + 0.5 * v);
  outColor = vec4(c, 1.0);
}`,
  setUniforms: (gl, locs, values) => {
    const f = locs.u_freq; if (f) gl.uniform1f(f, Number(values.freq) || 0);
    const a = locs.u_amp;  if (a) gl.uniform1f(a, Number(values.amp) || 0);
  },
}
```

### 4.1 Media-pool images (`asset` params + `auxTextures`)

A generator cannot upload textures, but it **can** sample media-pool images: declare an
`asset` parameter and ask the host to bind it as a sampler.

```js
{
  id: 'wall',
  name: 'Image wall',
  params: [
    { key: 'srcAsset', labelKey: 'Image', type: 'asset', defaultValue: '' },
    { key: 'mix', labelKey: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 1 },
  ],
  // The HOST binds these; `assetParam` names a param of THIS def.
  auxTextures: [{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' }],
  fragment: `
uniform sampler2D u_tex;
uniform int u_hasTex;
uniform float u_mix;
void main() {
  vec3 c = vec3(vUv, 0.5);
  if (u_hasTex == 1) c = mix(c, texture(u_tex, vUv).rgb, u_mix);
  outColor = vec4(c, 1.0);
}`,
  setUniforms: (gl, l, v) => {
    const h = l.u_hasTex; if (h) gl.uniform1i(h, String(v.srcAsset || '') ? 1 : 0);
    const m = l.u_mix;    if (m) gl.uniform1f(m, Number(v.mix) || 0);
  },
}
```

- `kind: 'asset-image'` - one RGBA texture of the bound image, `texture(u_tex, uv)`.
- `kind: 'logo-sdf'` - the same image as a signed distance field in R16F (`red` = signed
  distance in texels, negative inside). This is the "3D 格式化" input. It costs a CPU
  EDT pass the first time the image changes (tens of ms once, not per frame) - only ask
  for it if you are actually extruding.
- `kind: 'glyph-atlas'` - a runtime-drawn ASCII glyph atlas (no `assetParam`).
- **`assetParam` must name an `asset` param of this same def**, otherwise the plugin is
  rejected (`bad-aux`). Writing a range param there looks like "no texture" forever.
- **Never dispatch an aux sampler in `setUniforms`** - the host binds it before your
  call. Writing `gl.uniform1i(l.u_tex, 0)` there is harmless but pointless.
- An unbound / deleted / still-decoding asset means **the sampler is not bound at all**
  for that frame, so sampling it reads garbage. Gate on the assetId yourself and expose
  the result as a normal uniform (`u_hasTex` above) - the shader cannot see `values`.
- Orientation: the host uploads the decoded image with `UNPACK_FLIP_Y_WEBGL = true`, and
  `vUv` is the usual GL bottom-up space - so `texture(u_tex, vUv)` is upright on screen.
  Do not flip it yourself.

`bake` and `sim` generators are **not** pluggable: their implementation functions
have to run in a Worker or satisfy a deterministic step contract that the host
validates. `realtime` is enough for full-screen procedural scenes.

**Select parameters cannot be dispatched with `uniform1f`.** Map the string value
to an integer index yourself and write it with `uniform1i`, as section 5 shows.

## 5. Dispatch rules (the silent-failure list)

- **Uniform type must match the declaration.** Writing an `int` with
  `uniform1f` (or a `float` with `uniform1i`) raises `INVALID_OPERATION` and
  **silently does nothing** - the value stays 0 and the parameter looks dead.
- `u_time` is **seconds**, not an accumulated phase. If your effect has a `speed`
  parameter, compute the phase in closed form: `float phase = u_time * u_speed;`.
  Never keep state in JS between frames.
- All randomness must be reproducible: use `u_seed` (per-frame seed) or a hash of
  the coordinates. Never call `Math.random()` inside `setUniforms`.
- Anything your fragment declares as `uniform ... u_<key>;` and never reads is
  reported as `dropped-uniform` - that means the parameter will do nothing.
  Declare only what you use.
- The same check does **not** cover `auxTextures`: a sampler you declare but never read
  is silently dropped by the linker and samples nothing. If you asked for a texture,
  sample it.
- `half`, `input`, `output`, `filter` are reserved words in GLSL ES 3.00. Do not
  use them as variable names.

## 6. Typography document hooks

A hook rewrites a typography document at one of three moments:

```js
typography: {
  hooks: [
    {
      id: 'brand-footer',            // local id, same rules as effect ids
      name: 'Add brand footer',
      phase: 'open',                 // 'open' | 'save' | 'render'
      run(doc, ctx) {
        // doc is a DEEP-FROZEN copy: mutate a clone, never the input.
        // ctx = { phase, clipId?, t?, frame?, fps?, duration?, seed? }
        // Return a complete TypographyDocument, or undefined to leave it alone.
        return doc;
      },
    },
  ],
}
```

- `open` runs after the project is read and **before** its tab is shown. The
  rewritten document is only in memory (never written to disk by this hook).
- `save` runs on a **copy of the project that is about to be written**. The
  editor keeps showing the original document; the file on disk is the rewritten
  one.
- `render` runs before every rasterization of a text clip (preview and export
  share this path). It is applied only to that one frame — never written back.
  It is the only phase that gets `t` / `frame` / `fps` / `duration`, so it must
  be a pure function of those values plus `doc`.
- The return value goes through the same strict document parser the agent uses:
  unknown fields, invalid elements, or a thrown error make the hook **fail
  closed** — the original document is kept and the plugin panel shows the
  reason. There is no partial write.
- Hooks run in registration order (plugin load order). Input is frozen; a hook
  that tries to mutate it throws and is rejected.
- Hooks are validated once at load with a synthetic document. A hook that throws
  there is removed from the registry (`hook-failed`).

## 6.5 Panels, actions and the host API

```js
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 3,
  id: 'font-browser',
  name: 'Font browser',
  panels: [
    {
      id: 'browser',
      name: 'Fonts',
      icon: 'type',            // kebab-case Lucide name; null = no rail button
      kind: 'float',           // 'float' | 'modal' | 'dock'
      width: 360, height: 420, // float only; clamped to the viewport
      render(el, api) {
        // `el` already lives inside a shadow root: your CSS cannot leak out.
        el.innerHTML = '<button>Apply</button>';
        // optional: return a cleanup function (timers / observers / listeners)
      },
    },
  ],
  actions: [
    {
      id: 'apply',
      name: 'Apply font',
      params: [
        { key: 'family', labelKey: 'Family', type: 'text', defaultValue: '' },
      ],
      async run(api, args) {
        // args has EVERY key filled in; unknown keys never reach this function.
        return api.typography.command('typo_update_element', {
          elementId: api.typography.selection()?.elementIds[0],
          patch: { style: { fontFamily: args.family } },
        });
      },
    },
  ],
  activate(api) {
    // runs once per (plugin, project); return a dispose function
  },
}
```

**Panels.** `render(el, api)` only runs when the panel is actually opened (no
pre-render at load). Throwing shows an error inside the panel and records
`panel-failed`; the rest of the plugin keeps working. Shadow DOM isolates
**styles only** — plugins still run in the main realm with full page access.

**Actions are the capability, panels are just a view.** Every button in a panel
should end up calling an action (or `api.typography.command`), because the same
action is exposed to the agent as `plugin_invoke({ pluginId, actionId, args })`.
An action that only exists as DOM is invisible to the agent. Param types are
`range | select | checkbox | color | text` (no asset / pattern this round).

**Host API (`api`).** All reads are deep-frozen copies — mutating them throws;
write only through commands:

- `project.snapshot()` / `project.textClips()` / `project.revision()` — read the
  project (no playing-head, no selection).
- `typography.doc(clipId)` / `typography.selection()` — read a frozen document
  and what is selected in the typography editor.
- `typography.command(name, args)` — write the typography document. Names are the
  same as the agent tools: `typo_add_element`, `typo_update_element`,
  `typo_remove_element`, `typo_set_canvas_size`, `typo_set_theme`.
- `timeline.command(name, args)` — write a timeline clip. `clipId` is required
  (there is no "current clip"):
  - `set_params` — `{ clipId, target: 'source' | 'effect', params?, chainIndex?, enabled?, mask? }`.
    `target: 'source'` writes algo / solid params; `target: 'effect'` writes ONE
    instance of an effect chain (`chainIndex` is its position in `chain[]`).
    Find both from `project.snapshot()`.
  - `set_clip_props` — `{ clipId, patch }`, patch keys as the agent tool:
    `opacity`, `blend`, `transform`, `fit`, `fadeSec`, `crop`, `quad`, `key`,
    `speed`, `srcIn`, `fadeIn` / `fadeOut` (audio), `affectDepth`, `boundClipId`, `label`.
  - `set_generator` — `{ clipId, generator, params? }` (params reset to the new
    generator's defaults, then merged).
  Each call is ONE undo entry; validation happens before anything changes.
- `ui.openPanel(id)` / `ui.closePanel(id)` / `ui.openTypography(clipId)` /
  `ui.notify(text, 'info' | 'success' | 'error')`.
- `state.get(key)` / `state.set(key, value)` — your own JSON state, persisted to
  `<project>/plugins/<id>.state.json` (debounced, 256 KB cap).
- `on('project' | 'typography' | 'save', fn)` — content-level changes only,
  coalesced per microtask. There is **no per-frame callback** by design.

**Lifecycle.** Activation happens once per (plugin, project) after the project
is loaded; dispose runs before the plugin is unregistered (disable / remove /
hot reload / closing the project). Panels are destroyed with the instance, so
do not keep global references to their DOM.

**Rail.** A panel with an `icon` gets a rail button; unknown icon names fall
back to `puzzle` and record `unknown-meta`. Panels without an icon are opened
from the plugin manager or via `plugin_ui({ action: 'open' })`.

## 7. Workflow

You cannot open a terminal, so these four tools are how you read and change a
plugin **without resending the whole file**:

- `plugin_view({ pluginId, offset?, limit? })` - line-numbered pages. `offset` is
  the 1-based start line, `limit` defaults to 200 (max 500). The end of `text` is
  either `[N more lines; continue with offset=M]` or `[end of file (N lines)]`.
- `plugin_grep({ pluginId, pattern, ignoreCase?, context?, max? })` - regex search
  over the source; returns 1-based `line` numbers and the full line text.
- `plugin_edit({ pluginId, oldString, newString })` - exact-literal replacement.
  `oldString` **must occur exactly once**: 0 matches → not-found, 2+ →
  invalid-argument with every hit in `detail.lines`. It edits the in-memory draft
  only (nothing runs, nothing is written).
- `plugin_check({ pluginId })` - parses the source as ESM with acorn and reports
  `syntax | import | dynamic-import | no-export | bad-format` with line/column.
  It never executes the plugin.

1. First version: `artmatic_plugin_try({ id, name, source })` - validates the
   manifest, imports the module and compiles every shader with the **real** GL
   context. Returns `effects` / `generators` (qualified ids) and a list of issues
   with `path` and `detail`.
2. Fix issues in a loop: `plugin_view` → `plugin_grep` → `plugin_edit` →
   `plugin_check`. Then call `plugin_try` with **no `source`**: it applies the
   current draft (or the installed file) and hot-replaces the previous version.
   Small fixes never need the whole file again.
3. Once the status is `ok`, use the qualified id in `artmatic_add_effect` or
   `artmatic_add_clip({ kind: 'algo', generator: '<qualified id>' })` and take a
   screenshot with `artmatic_render_frame`.
4. `artmatic_plugin_install({ id })` - asks the user for approval, then writes
   `<project>/plugins/<id>.js`. Without a project directory the plugin stays in
   memory for this session only.

`plugin_try` still executes the code in the page and still needs user approval,
including when `source` is omitted.

## 8. Cost discipline

Your code runs every frame on the user's GPU. None of this is enforced by the
host: an expensive shader compiles fine and only shows up as a stuttering editor.

- **Effect passes.** The main pass renders at the full render size, and every
  `prePasses` entry is one more full-screen pass. `feedback: true` allocates a
  per-instance history texture (16-bit with `hdrFeedback`) - ask for it only when
  the fragment actually samples `u_feedback`. Non-feedback pre-passes render on a
  **half-resolution** scratch target, so heavy work belongs there rather than in
  the main pass.
- **Generator resolution is host-side.** Declare a parameter whose key is
  exactly `intRes` (select: `auto | 240 | 480 | 720 | 1080`). The host reads that
  key itself and renders into a target of that height, so `u_resolution` already
  follows it - you write no code and there is nothing to dispatch. Do **not**
  declare a `u_intRes` uniform: the linker drops it and it is reported as a dead
  parameter. Keep `defaultValue` at `'480'` or lower.
- **Do not add antialiasing unless the image actually needs it.** Nothing in the
  host does it for you - what you leave aliased stays aliased, and that is
  usually fine. Supersampling multiplies the whole frame: 4x4 turned a 3.9 ms
  ray-marched tunnel into 49.3 ms at 720p, which is why the built-in 3D
  generators only treat 4x4 as a still / export setting. Decide from the frame
  you rendered: hard
  geometric silhouettes and thin high-contrast structures are the cases that
  need it; noise, grain, glow and soft gradients do not.
  If it does need it: key `aa`, select `off | x2 | x3 | x4` dispatched as samples
  per axis (`off` = 1), **`defaultValue: 'off'`**, dispatched through
  `sel({ off: 1, x2: 2, x3: 3, x4: 4 })` - `i(gl, l, v, 'aa')` turns `'x2'` into
  `0`, so every setting silently becomes "off". Fixed offset grid, never jitter
  (a jittered grid renders the same `t` differently frame to frame):
  ```glsl
  uniform int u_aa;            // samples per axis: 1 (off) .. 4
  vec4 shade(vec2 uv);         // your pixel function

  void main() {
    int n = clamp(u_aa, 1, 4);
    int total = n * n;
    vec2 texel = 1.0 / max(u_resolution, vec2(1.0));
    vec4 sum = vec4(0.0);
    for (int k = 0; k < total; k++) {
      vec2 off = (vec2(float(k % n), float(k / n)) + 0.5) / float(n) - 0.5;
      sum += shade(vUv + off * texel);
    }
    // average premultiplied, or transparent edges get a grey rim
    outColor = vec4(sum.rgb / max(sum.a, 1e-4), sum.a / float(total));
  }
  ```
  `n = 1` lands exactly on the pixel centre, so `aa: 'off'` is the plain
  single-sample image. Keep it to **one call site** - every call site is
  inlined, and compile time (not run time) is what blows up first.
- **Anything 3D** (ray marching, a 3D engine bundled into the file) **must**
  expose `intRes` and **default it to the lowest value** (`'240'`). The first
  `plugin_try` runs code nobody has measured yet; raise it in a later edit, never
  in the same message that first tries the plugin. Antialiasing stays optional
  even here - add it only if the frame you looked at is visibly crawling.
- **Per-pixel loops.** A loop of N texture taps is N samples for every pixel of
  the frame. Sampling the input more than once per pixel is usually a bug, not a
  look.
- **Typography `render` hooks** run once per text clip per frame, and preview and
  export share that path. Keep them O(elements): no whole-document scans, and
  anything constant belongs in `open`.

## 9. Minimal checklist before calling `plugin_try`

- [ ] `format: 'artmatic-plugin'`, `apiVersion: 3`, lowercase `id`
- [ ] at least one effect, generator, typography hook, panel, action or `activate`
- [ ] every `params[].key` is unique and (except the host-read `intRes`) matches
      a `u_<key>` used in `setUniforms`
- [ ] fragment does **not** redeclare any uniform from the shared head
- [ ] `setUniforms` writes every parameter except the host-read `intRes`
      (otherwise the parameter is dead)
- [ ] every `auxTextures[].assetParam` names an `asset` param of the same def
      (a wrong key rejects the whole plugin with `bad-aux`)
- [ ] no `Math.random()`, no `Date.now()`, no state kept between frames
- [ ] 3D content exposes `intRes` with the lowest default (`'240'`)
- [ ] `aa` only when the rendered frame needed it - and then `defaultValue: 'off'`
