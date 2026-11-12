---
name: beat-sync-edit
description: >
  Cut and accent a timeline to music. Covers reading the beat grid, planning in bars,
  placing bound effect clips for beat-level hits, and verifying the result with a
  beat-spaced contact sheet. Use when the request mentions beats, BPM, drops, rhythm,
  music sync, "cut on the beat", 卡点, or when audio is already in the project and the
  edit has to land on it.
license: MIT
compatibility: Artmatic in-app agent (tools: estimate_beat_grid, set_beat_marks, split_clip, add_effect_clip, render_sequence)
---

# Beat-synced editing

Rhythm is arithmetic, not taste. Get the grid right, place everything from the grid,
then look at a beat-spaced sheet. Skipping any of the three is how an edit ends up
"almost on the beat", which reads worse than no sync at all.

## 1. Establish the grid before placing anything

`get_scene({ detail: 'ids' })` returns `beatGrid: { bpm, offset, beatsPerBar }`.
`offset` is the time of beat 0 in seconds — not zero in most imported music.

- If the project has audio and `beatGrid` still holds the 120 / 0 default, run
  `estimate_beat_grid` **once**. It reads the earliest audio clip, writes both values,
  and fails loudly when there is no clear pulse. A rewritten grid invalidates every
  time you computed before it.
- If the grid is right for the kick but the melody hits sit elsewhere, do not move the
  grid. Add `set_beat_marks` for the off-grid hits (seconds, ascending, full list each
  call) — they are extra snap points, they do not change BPM.
- Do not hand-tune `bpm` to "make it look better". One percent error is 0.36 s of drift
  per 36 s of music; you cannot see that on a still frame and the user hears it at the end.

Beat times: `t_n = offset + n * 60 / bpm`. Bar lines are every `beatsPerBar` beats.
Snap every time you write: `t = round(t * fps) / fps` (`fps` from `describe`). A cut
written at 0.5001 s is not a bug, but a cut written at 0.51 s visibly lags at 24 fps.

`references/beat-tables.md` has beat / bar / 16th lengths for common tempos.

## 2. Plan in bars, not in clips

Decide the structure first, as bar numbers: intro 4 bars, drop at bar 9, break at 17.
Then convert to seconds **once** and keep that list. Editing bar by bar is how you end
up with a 3.5-bar section nobody can explain.

- Cut points go on beats; structural changes (drop, break, new section) go on bar lines.
- A cut that lands half a beat off reads as a mistake. Same cut on the next beat reads
  as intent. When in doubt, move to the **next** beat, never to the nearest frame.

## 3. Cut

- `split_clip({ clipId, at })` at beat times, bottom-up (splitting creates a new right-hand
  id, so re-read `get_scene` before reusing ids you cached earlier in a long loop).
- `move_clip` / `resize_clip` to align edges. Overlap behaviour is a project setting
  (`push` / `reject` / `trim`); a rejected placement changes nothing, so read the error
  instead of retrying the same numbers.
- Hard cuts: leave `fadeSec` at 0. A fade is a deliberate softening; adding one to every
  cut smears the rhythm you just built.
- Transitions: `set_transition` hangs on the OUTGOING clip. Keep the duration under half
  the shorter neighbour, or the transition eats the beat it was supposed to mark.

## 4. Accent without opening a track per hit

For a strobe / glitch / flash on one shot, use a **bound** effect clip:

1. `add_effect_clip({ trackId, start, end, boundClipId })` — start and end one 16th or
   8th note long, inside the target clip's range.
2. `add_effect({ clipId, defId })` for the effect, then `set_params` for the intensity.
3. Resize the range rather than adding a second clip when the accent needs to be longer.

`boundClipId` and `affectDepth` are mutually exclusive. A bound clip affects exactly one
source clip, so z order does not matter and it cannot bleed onto other layers — which is
the whole reason it exists.

Accent the **first** beat of a bar, not every beat. A hit on every beat is a metronome;
the ear stops hearing it after two bars and the user asks for "more energy" instead.

## 5. Verify the rhythm — this is the step people skip

`render_sequence({ from, to, step })` returns a contact sheet with the timestamp burnt
into each cell. Set `step = 60 / bpm` (or `bar` for structural checks) and render 8–12
cells across the section you just edited.

Read it like a flipbook: the cell where the image changes must be the cell whose label
is a beat time. If the change is one cell late, your cut is one beat late — not "close
enough", and not something the numbers will tell you.

Cap: max 24 cells per sheet, and each sheet is one image in the conversation. Two sheets
per iteration is plenty; rendering eight of them costs more than the edit.

## Traps

- `speed` on a video clip keeps the clip length but changes what is inside it. Never sync
  content-level events (a subject hitting the floor) to the grid through an animated speed
  curve.
- Animated `speed` curves and beat sync fight each other: fix the speed first, then cut.
- `beatMarks` and `beatGrid` are different fields with different effects (marks = snap
  points only). Editing one and expecting the other to move is a silent no-op.
- When the user says "the drop", confirm the bar with `ask_user` if the audio has more
  than one candidate — a wrong drop costs a whole re-edit.
