---
name: create-mv
description: >
  Plan and build a complete music-driven video in Artmatic: lock the audio and brief,
  map sections and energy, design a reusable visual system, arrange shots, add synced
  motion and accents, then verify with contact sheets. Use for MV, music video, PV,
  BGA, lyric video, 音乐视频, 文字 PV, 卡点视频, or turning a song into algorithmic visuals.
license: MIT
compatibility: Artmatic in-app agent (scene, analyze_music, music map, generator, effects, typography, render and export tools)
---

# Create a music-driven video

Build the music map before the visuals, prove one representative passage before scaling,
and judge the result by whether the picture has a deliberate relationship to the music.
A stack of fashionable generators with an effect on every beat is not a direction.

Use the user's term (MV / PV / BGA / lyric video) in the reply. The workflow below covers
all of them; the amount of narrative, typography and spectacle changes with the brief.

## 1. Lock the brief and the source

1. Establish the deliverable: abstract BGA, narrative MV, performance edit, lyric / type
   PV, or a hybrid. Confirm aspect ratio and target duration when they affect the build.
2. Read `describe`, `get_scene({ detail: 'ids' })`, `project_stats` and `media_list`.
   Inventory the actual audio, images, video, existing clips and available screen space.
3. If there is no music, ask the user to import the intended master and place it on an
   audio track on the timeline; a media-pool file alone cannot drive analysis. Do not build
   a timed edit against a placeholder or move / trim the master to fix visual timing.
4. If lyrics matter, ask for approved text and, for word-level motion, timing information.
   Artmatic has no lyric transcription. Never invent missing words from the title.
5. When the user has not delegated art direction, ask one compact question about the
   visual world and palette. With full creative freedom, choose and proceed.
6. Use `web_search` for artist / genre / context only when it will change the direction.
   Separate verified metadata from interpretation. Do not reconstruct a song from its
   filename, and do not let search results override what the user asked for.

## 2. Make a music map

`analyze_music` is your ears: call it once before any cue or clip. It ensures the beat grid,
returns bar-aligned sections with letters, measured energy and a drop timetable, and writes
the boundaries into `project.sections` as `source: "auto"`. `render_music_map` shows the same
map as a picture — the table gives numbers, the picture gives shape. `references/music-map.md`
maps each field to the decision it drives and separates measured from inferred; read it first.

If `grid.source` is `"default"` no pulse was found: the structure is usable, bar positions are
guesses. Changing `beatGrid` moves every bar — re-run `analyze_music` and recompute cue times.

Keep a compact map before writing clips:

| start / bars | role | energy 0–3 | main visual | motion / density | text |
|---|---|---:|---|---|---|
| 0.0 / 1–4 | intro | 0 | establish motif | sparse, slow | title or none |
| drop bar | payoff | 3 | hero variant | sharp contrast | hook only |

- Treat energy as relative within this song, not as loudness alone. Instrumentation,
  harmonic tension, vocal density, silence and repetition can all justify a boundary.
- Mark the first payoff, the largest contrast and the ending before filling the middle.
- Reuse the visual grammar of repeated sections, but change one meaningful variable on
  the final repeat: scale, colour, camera, density or narrative state.
- Reserve negative space. A breakdown, pause or held frame can be the accent after a
  dense build; maximum energy does not require maximum brightness or cut frequency.

For a valid constant grid, beat time is `offset + n * 60 / bpm`; a bar is `beatsPerBar`
beats. For variable tempo, use the actual cue list instead of this formula. Convert musical
cues to seconds once, then snap written times to the project frame grid.

## 3. Commit to one visual thesis

Write one internal sentence: **this song becomes <motif> undergoing <change>**. Then define:

- **Hero:** one dominant image, generator, footage treatment or typographic behaviour.
- **Support:** one secondary motif that gives the hero contrast or spatial context.
- **Texture:** at most one background / grain / grid layer. Noise is not automatically a subject.
- **Palette roles:** background, primary ink, readable text, one accent. Assign colours by role.
- **Motion rule:** what continuously breathes, what changes per phrase, and what only hits accents.

Use `references/direction-and-palette.md` when direction is open. Genre is a source of
cultural clues, not a lookup table. Prefer two or three recurring motifs over a tour of
the entire generator catalogue. A style change must correspond to a musical or narrative
change; random novelty per shot destroys the visual world.

Avoid the usual generated-video tells:

- untouched defaults, static fractals, or animation applied only because a parameter exists;
- slide-deck layouts, decorative rules everywhere, and giant title + tiny subtitle + footnote;
- camera UI in all four corners, BPM / section labels / prompts presented as fictional HUD data;
- several equally loud focal points, with no quiet area for the eye;
- literal complex people or objects assembled from primitive shapes without suitable assets;
- a new palette and effect stack in every shot without an audible reason.

## 4. Turn sections into shots

Plan in musical phrases, not arbitrary seconds. One to four bars is a useful starting range,
not a hard shot-length limit. Follow an unbroken gesture across a boundary when the music
does; cut within a phrase only when its internal rhythm supports it.

**Changing the generator is a structural event, not a bar counter.** Use a different
generator at a section boundary or when the material changes; inside a section, vary it with
modulators and curves. A new generator every bar — or the same one for four bars with nothing
moving — reads as a metronome with pictures.

For each shot, know its start, end, source, focal point, motion and handoff to the next shot.
A cut, match in shape / motion, camera continuation, or deliberate rupture are different
choices. Do not add a decorative transition merely because two clips touch.

Prototype the first representative low-energy passage and the main payoff before filling
the whole timeline. If both work with the same system, scale it; if not, fix the system
rather than hiding the problem with more effects.

For long tracks, build reusable section families and vary their arrangement. Do not clone
every chorus byte-for-byte when the final chorus needs a larger payoff.

## 5. Build the system

1. Get legal ids with `get_capabilities({ detail: 'ids' })`; request `detail: 'params'`
   with an `ids` filter before choosing values. Never invent a def id or parameter key.
2. Add source clips with `add_clip`. Set intentional non-default values immediately with
   `params` / `set_params`; use explicit ids in long builds so later calls remain readable.
3. Give each hero shot one primary evolving relationship. Animate a camera, geometry or
   formation parameter with `set_curve`; do not keyframe every available slider.
4. Use `set_modulator` + `bind_modulator` for continuous closed-form motion, and curves
   for authored section changes. Modulation adds to curves; binding does not clear them.
   Expressions can read `energy` / `sectionU` / `rms` / `bass` / `bar` and more (see
   `help('timeline')`): one such expression often replaces twenty keyframes.
5. Keep track roles legible: base / hero sources, typography, global finish. Use a bound
   effect clip for a short accent on one source instead of opening a track per hit.
6. Use `references/pro-generator-taste.md` for source selection and development,
   `references/pro-effects-taste.md` for effect hierarchy, and
   `references/full-text-pv.md` whenever lyrics or typography carry the piece.

Write a plugin only when the central motif cannot be expressed by existing generators,
typography and effects. Read the relevant `help` topic first, prototype the smallest version,
and use the plugin approval flow. Do not use a plugin to avoid making an art-direction choice.

## 6. Put rhythm at three different scales

- **Structure:** section changes, camera worlds and palette turns belong on phrase / bar
  boundaries. Keep a deliberate exception when the musical event itself is off-grid.
- **Gestures:** entrances, reveals, pushes and build-ups follow phrase shape. A build needs
  headroom: increase one or two dimensions progressively instead of starting at maximum.
- **Accents:** kicks, snares, fills and onsets get short, sparse responses. Use `boundClipId`
  for a one-shot glitch / pulse on a single source. Do not turn every beat into a full-frame hit.

When a section reads as static in `render_music_map`, the missing layer is almost always the
middle one — add a modulator rather than another clip.

Sync the event that carries meaning: lyrics follow vocal syllables or phrases, not the nearest
bar by default; a physical action follows its own visible impact. Beat alignment is a tool,
not a substitute for semantic timing.

## 7. Verify motion, not just stills

1. Render one `render_frame` at each representative section. Check focal point, palette,
   empty layers and whether the hero actually dominates.
2. Use `render_sequence` across 8–12 cells around a section transition and across one
   evolving shot. Use beat spacing for a rhythmic question and smaller spacing for a fast accent.
3. Use `frame_signature` before / after a subtle change when the question is whether pixels
   changed at all. Read `layers` when using `only`; isolation also hides effect tracks.
4. For type, run `typo_measure`, then inspect small text with `render_frame({ region })`.
   A full-frame thumbnail cannot prove that lyrics fit or remain readable.
5. Check the opening, first payoff, final repeat and ending at minimum. Then inspect any
   long repeated stretch for stagnation and any dense stretch for unreadable accumulation.
6. A contact sheet proves visible timing and motion, not audible sync or playback comfort.
   Ask for a full playback review when the final judgement depends on hearing the track.

Avoid more than three general or saturated-red flashes in any one second unless a proper
flash analysis demonstrates that the area / contrast thresholds are met. A contact sheet is
not that analysis. For aggressive strobes, reduce flash count, area, contrast or red saturation;
do not treat BPM as permission to strobe.

## 8. Finish honestly

Check clip coverage, unintended black gaps, project duration and layer naming. Export only
when requested or clearly part of the task. In the final response, name what was built and
which timings or creative assumptions still need user review; never claim an unrendered
section is finished or that a still image proves the whole MV works.

## Traps

- Changing the beat grid invalidates cue times **and** the map. Re-run `analyze_music`.
- `analyze_music` writes sections with `source:"auto"`. Hand-marked ones sit alongside, never
  underneath; editing a section makes it the user's and it is never auto-replaced again.
- `role` is a guess from energy and boundary strength. Repeating it as fact misrepresents
  what was measured.
- `set_curve` times are seconds relative to the clip, except with `beatAnchor`, where `t=0`
  is the anchored beat. Typography camera / element track times are clip-relative seconds,
  while modulator `t` is absolute. Mixing these origins silently shifts an accent.
- `set_generator` resets parameters and deletes curves for parameters of the old generator.
  Finish generator selection before detailed animation.
- Bake / sim sources can be empty near local `t=0`; judge them after their actual development
  time or give them off-screen pre-roll. Do not repair an empty first frame with random effects.
- Audio-reactive scene generators receive zero features without audio and may look dark.
  That is missing input, not a colour-parameter bug.
- `boundClipId` and `affectDepth` are mutually exclusive. A bound accent affects one source;
  an adjustment layer depends on track order and depth.
- Typography scripts are off by default. If the chosen design needs them, tell the user to
  enable them and do not describe the scripted result as visible before checking it.
- Adding clips can extend project duration. Restore the intended ending with `set_project`
  when an accidental tail was created.
