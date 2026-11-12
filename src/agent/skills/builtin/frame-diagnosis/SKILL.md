---
name: frame-diagnosis
description: >
  Read a frame before judging it: which of frame_signature, render_frame, render_sequence
  and region answers which question, how to interpret mean / spread / lit, and a table
  mapping symptoms (black, blown out, muddy, flickering, unreadable type) to the layer or
  parameter that usually causes them. Use when the user says the picture looks wrong, too
  dark, too busy, broken, or before claiming a visual change worked.
license: MIT
compatibility: Artmatic in-app agent (tools: frame_signature, render_frame, render_sequence, typo_measure)
---

# Frame diagnosis

There are four observation tools and they answer different questions. Picking the wrong
one is why agents end up saying "it looks fine" about a black frame.

| Question | Tool | Cost |
|---|---|---|
| Did the pixels change at all? | `frame_signature` | one render, no image |
| What does it look like? | `render_frame` | one image |
| Is it moving / does it land on the beat? | `render_sequence` | one sheet, up to 24 cells |
| Is this detail legible? | `render_frame({ region })` | one upscaled crop |
| Is the type overflowing / colliding? | `typo_measure` | no render at all |

Cheapest first. `frame_signature` before and after a change is the only way to tell
"parameter had no effect" from "parameter had a small effect"; a single image cannot
distinguish those.

## Reading the numbers

```
mean:   [r, g, b] 0..255        average per channel
spread: 0..255                  max per-channel range across sampled points
lit / total                     non-zero source pixels (black background: lit ≈ geometry)
grid:   n*n block means         composition, row-major
samples: n*n * 3 RGB            point samples
```

- `spread ≈ 0` means **the frame has no structure** — not "low contrast". Either it is
  flat colour, flat black, or a full-frame effect erased everything.
- `lit ≈ 0` means nothing was drawn. Check clip ranges and opacity before touching effects.
- Compare two signatures of the same `t` (before / after). Absolute means mean nothing:
  a night scene and a white title card are both "correct".
- `mean` high everywhere + `spread` low = blown out. `mean` mid + `spread` low = gray mush.

## Symptom → first thing to check

| Symptom | Check in this order |
|---|---|
| Black / empty frame | clip range covers `t`? → track `enabled`? → clip `opacity` → effect clip's `affectDepth` swallows the layer → generator needs time to grow (bake / sim / reveal start empty at t=0) |
| Blown out, no detail in highlights | `grade-basic` exposure / contrast → `glow` / `bleach` / `bloom` → `posterize` levels too low |
| Flat gray, no structure | a full-frame effect: `blur` radius, `pixelate` cell, `feedback` dilution, `kino-datamosh` block size → is the effect clip's range longer than intended? |
| Muddy edges, mush | source upscaled far beyond its size → `intRes` too low on a 3D generator → `sharpen` cannot fix missing pixels |
| Colour fringing / wrong hue | `hsv-swap`, `channel-split-*`, `duotone`, `thermal` — check hue rotation is 0 where you expect neutral |
| Flicker between adjacent frames | hash-based patterns with large `sin` arguments, `feedback` residue, sim state not seeded → render two adjacent cells in one sheet; identical cells that differ = flicker |
| Type unreadable | `typo_measure` first (`overflowX` / `overflowY` / `outside`), then `render_frame({ region })` on the text box |
| UI looks wrong (not the frame) | `ui_screenshot` — `render_frame` cannot show panels, drawers or toolbars |

## Rules that keep this cheap

- A change to **one parameter** is verified with `frame_signature` (or not at all). A
  change to **composition, colour or legibility** needs `render_frame`.
- Never raise the render size to see detail. `region: { x, y, w, h }` in 0..1 crops and
  upscales; it costs one image, not a 1920-wide one.
- `render_sequence` is for motion, not for stills. Default 6 cells; use `step = 60/bpm`
  only when the question is rhythmic.
- Isolation (`only`) hides other tracks **including effect tracks**. If the frame went
  black under `only`, that is the tool, not the project. `layers` in the result says what
  was composited — read it before concluding.
- Same `t`, two calls, two different images: that is either a sim seeking mid-flight or
  a known sampling ghost, not something a parameter can fix. Re-render once before
  reporting it as a bug.
