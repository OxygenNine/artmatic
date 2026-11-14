# Effect direction

An effect needs a musical or material job. Build a consistent finish, choose a small motion
vocabulary, and reserve destructive accents for events. If every shot has every treatment,
none of them carries information.

## A useful chain has roles

| Role | Examples | Use |
|---|---|---|
| Match / grade | `grade-basic`, `grade-curves`, `grade-lut`, `color-correction`, `duotone`, `trio-tone` | Establish the shared tonal and colour world before stylising individual shots. |
| Light / surface | `glow`, `godray`, `grain`, `halftone`, `lcd`, `scanlines` | Add one material signature. Keep text and dark detail readable. |
| Camera / space | `fisheye`, `bulge`, `kaleido`, `polar`, `transform-3d`, `zoom` | Give the source a coherent spatial behaviour; animate the camera rather than randomly changing projection. |
| Continuous distortion | `liquid-light`, `melt`, `smear`, `wobble`, `fiber-displace`, `flow-contours` | Map to a sustained texture or gesture. Limit amplitude so the source remains identifiable. |
| Rhythmic response | `beat-pulse`, `shake`, `shockwave`, `radial-blur`, `channel-split`, `channel-split-prism` | Use short envelopes or sparse parameter peaks tied to actual accents. |
| Damage / signal failure | `kino-datamosh`, `fast-mosh`, `pixel-sort`, `slices`, `data-bend`, `soft-glitch`, `stylize-glitch` | Damage needs intact material around it. Preserve enough source detail for the failure to read. |
| Time manipulation | `stutter`, `motion-blur`, `echo`, `ghosting`, `hold-trail`, `feedback`, `kino-feedback` | Use when temporal residue is the intended gesture. Verify adjacent frames, not only a still. |
| Semantic overlay | `audio-bars`, `box-tracker`, `ascii` | Use when spectrum, tracking or glyph representation belongs to the concept, not as generic techno decoration. |

## Finish, motion, accent

Keep these three levels separate:

1. **Finish:** a mostly stable grade / grain / glow chain that makes separate shots belong
   together. Apply it consistently and avoid repeatedly crushing highlights.
2. **Motion:** one evolving distortion or camera treatment per visual idea. Keyframe its
   development across the phrase instead of leaving a constant amount running forever.
3. **Accent:** a brief glitch, pulse, blur or displacement on a meaningful hit. Prefer a
   bound effect clip so the accent cannot bleed into unrelated layers.

A single long effect clip with a coherent chain is usually easier to control than one track
per effect. A short accent on one source is the opposite case: use `boundClipId`.

## Preserve readable structure

- Pixelation, datamosh, low-resolution signal effects and extreme displacement destroy source
  information. Use them as contrast, then return to a readable state.
- Glow needs dark room around the light source. Raising base exposure and glow together
  produces a white sheet, not intensity.
- Grain and scanlines are material, not detail. They cannot repair an empty or blurry source.
- Kaleidoscope and mirror effects create symmetry but also destroy spatial continuity. Use a
  cut or morph to explain the transition into that world.
- Typography can share the same lens, glitch or grain treatment, but its timing and legibility
  come first. A lyric that breaks at every hit is no longer carrying the lyric.
- Box tracking is meaningful only when the tracked objects matter. Empty labels and arbitrary
  rectangles read as placeholder HUD, not intelligence.

## Temporal effects need motion and history

`hold-trail`, echo and feedback-like treatments require a changing source; a static image
only accumulates copies of itself. For trails on typography, preserve the intended alpha and
test the moving phrase. If the result is a solid smear, reduce persistence before adding blur.

Judge temporal effects with `render_sequence` over adjacent or closely spaced frames. One
representative still can look clean while the animation flickers, stalls or never releases.

## Flash safety

Full-frame strobes, alternating saturated red and rapid black / white inversions can cause
physical harm. Avoid more than three flashes in any one second unless a proper analysis shows
that the flash area and contrast remain below the applicable thresholds. Reduce count, area,
contrast or red saturation. Do not assume that short duration, low BPM or a musical drop makes
an unsafe sequence acceptable.

References: W3C WCAG, Understanding Success Criterion 2.3.1, Three Flashes or Below Threshold
(https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
