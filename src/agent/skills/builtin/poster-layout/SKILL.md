---
name: poster-layout
description: >
  Build a poster, title card or thumbnail in the typography document: the order of
  operations (canvas size, background, content, layout, theme), a three-level type
  hierarchy, grid and gutter rules, and the verification pass with typo_measure and
  render_frame. Use when the request is a poster, cover, thumbnail, title card, credits
  screen, 海报, 封面, 标题卡, or any layout where type is the main subject.
license: MIT
compatibility: Artmatic in-app agent (tools: typo_add_elements, typo_layout, typo_measure, typo_set_theme)
---

# Poster layout

One poster has one focal point. Everything else is either supporting it or on the way out.
If you cannot name the focal point in one sentence, the layout is not ready to render.

## Order of operations

Do not interleave these. Layout before content produces elements that all need moving again.

1. **Canvas** — `typo_set_canvas_size({ size, scaleContent })`. `size` is the design
   resolution, not the output resolution: the clip scales the whole document to fit, so
   proportions matter and pixel count does not. Pick the aspect first (1:1, 4:5, 16:9).
2. **Background** — `typo_set_background({ paint })`: `solid` / `linear` / `radial` /
   `texture`. A flat near-black or near-white is almost always better than a busy image
   behind type; the exceptions are the ones where the image IS the poster.
3. **Content, in one call** — `typo_add_elements({ elements })`. Array order is z order;
   background elements first. One call is one undo entry — twenty calls is twenty.
4. **Layout** — `typo_layout({ op })`: `align` (canvas), `grid`, `row`, `column`,
   `distribute`. Never hand-compute coordinates when a layout op exists; the op knows the
   real text bounds, you only know the nominal frame.
5. **Theme** — `typo_set_theme({ scope })`, or colour via refs (`@accent1`, `@dk1`). Theme
   refs mean a later palette switch recolours the whole document. Hardcoded hex does not.
6. **Camera / animation** — only after the static frame is good. A moving composition that
   is wrong still stands still for most of its duration.
7. **Verify** — `typo_measure`, then `render_frame`, then a `region` crop for small type.

## Hierarchy

- Three levels maximum: display, subhead, body. A fourth reads as noise at any size.
- Each level at least 1.6× the next in `fontSize`. A 1.2× step is invisible as hierarchy
  and visible as a mistake.
- One accent colour, used once. Two accents is a poster about colour, whether you meant it
  or not.
- Alignment: pick one axis (left or centre) and keep it. Mixed alignment is only a choice
  when the focal element justifies it.

## Space

- Outer margin sets the tension. A poster with a 5% margin reads as a photo with text
  dropped on it; 8–12% reads as designed. Whichever you pick, apply it on all four sides
  through `typo_layout({ op: 'grid', margin })`, not per element.
- Line height 1.1–1.3 for display type, 1.4–1.6 for body. Tighter only for one-word lines.
- Let one thing be nearly too large. Equal-size elements are a spreadsheet.

## Verification pass

1. `typo_measure` — `overflowX` / `overflowY` > 0 means the text does not fit its box;
   `outside` > 0 means the box leaves the canvas. Both are invisible in a 640 px render.
2. `render_frame` — composition, contrast between type and background, whether the focal
   point actually wins.
3. `render_frame({ region })` — crop onto the smallest type. If it fails there, it fails.

## Traps

- **A shape added by the agent draws nothing by default.** No `fill` ⇒ `{ kind: 'none' }`,
  no `stroke` ⇒ `null`. That is deliberate: a stray default shape silently ruins a
  composition. Pass both explicitly.
- **Solid text fill becomes `style.color`** on write (`fill` only stays for gradient /
  radial / texture). Reading the element back shows `style.color`; that is not a lost field.
- `frame.rot` is **radians**; `transform3d` angles are **degrees**. Mixing them up gives a
  layout that is 57× too rotated or barely rotated at all.
- `typo_layout` skips locked elements, and `elementIds` scopes it. After a layout op, read
  the returned frames instead of assuming where things went.
- Groups are shells: they carry position but no style. Styling a group and wondering why
  nothing changed is a known dead end — style the children.
- Camera `depth`: 0 = follows the canvas exactly, 1 = fully parallaxed. All-zero depth
  renders pixel-identical to no camera at all, so "the camera did nothing" usually means
  every element is at depth 0.
- `get_typography_capabilities().units` is the authority on px vs 0..1 per field, and
  `units.defaults` on what the agent path leaves unset. Read it before inventing values.
