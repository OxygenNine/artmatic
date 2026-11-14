# Lyric and typography-driven video

Treat text as the performed content, not as captions pasted over a finished background.
The craft is the relationship among vocal timing, reading time, composition and motion.

## 1. Prepare the words

- Obtain approved lyrics with intended line breaks. Artmatic does not transcribe vocals.
- Split lines at semantic phrases. For rapid delivery, use shorter groups or word-level
  emphasis; for sustained melodic lines, hold a complete phrase long enough to read.
- Decide how to treat repeats, ad-libs and instrumental passages once, then apply the rule
  consistently. Do not fill every instrumental gap with metadata.
- Sync to the vocal onset or phrase, not automatically to the nearest bar. A small deliberate
  lead-in can help reading; revealing a whole verse early removes the performance.

If word-level timing is unavailable, prefer line-level reveals. Approximate karaoke motion
is more distracting than a well-timed line.

## 2. Build a typographic system

Define a small set of reusable roles rather than designing every line from zero:

- primary lyric, optional emphasis word, optional translation / secondary line;
- one display face, with a second face only for a genuine structural contrast;
- one dominant alignment axis per passage, with intentional exceptions for musical events;
- background / scrim behaviour that guarantees contrast over the brightest source frame;
- two or three entrance behaviours shared across the song.

Avoid slide-deck composition: giant heading, tiny subtitle, explanatory footnote, divider
lines and boxes around every phrase. The words already are the content. Do not display BPM,
section names, prompts or production notes as decorative interface text.

For a long song, create a phrase / section template and vary scale, position, colour role or
camera at structural returns. Batch related element writes with `typo_add_elements` and
`typo_update_elements`; array order is z order.

## 3. Make the static composition work first

Create the text clip with `add_clip({ kind: 'text' })`, set its canvas and background, then
add content. Use theme references for palette roles so a later palette change remains global.

Check the longest line, the most awkward line break and the loudest background before adding
motion. If those frames fail, animation will not rescue them.

Run `typo_measure` for overflow, out-of-canvas boxes and text-on-text collisions. Inspect the
smallest type with `render_frame({ region })`. Test at the intended delivery aspect ratio;
do not infer phone readability from a large desktop preview.

## 4. Choose the motion layer deliberately

### Element tracks

Use `typo_set_animation` with structured tracks. One animation controls one property on one
target layer; pass `mode: 'add'` when adding a separate track so the default replace mode
does not erase the existing animation.

- `keys[].t` is absolute seconds relative to the clip, not 0..1 progress.
- `x` / `y` are document px, scale is a factor, rotation is degrees and opacity is 0..1.
- `target: 'box'` moves the text box and its background; `target: 'content'` moves only the
  glyph / image content. Pick the one that matches the visual object.
- Do not animate the same property twice on the same target layer. Extend the existing track.
- Use presets from `get_typography_capabilities` rather than guessing preset names.

Entrances should establish a readable state quickly. Keep continuous floating, rotation and
blur subordinate to reading; a strong entrance on every word becomes visual metronome noise.

### Document camera

Use the 2.5D camera when several phrases or visual elements share a space:

1. Place elements and assign nonzero `depth` to layers that should react.
2. Set a base pose with `typo_set_camera`.
3. Keyframe one channel at a time with `typo_set_camera_animation` (`x`, `y`, `zoom`, `rot`).
4. Keep the next reading destination visible or intentionally reveal it at the phrase boundary.

Camera keys are clip-relative seconds. A channel with keys ignores its base value. All-zero
`depth` makes the camera pixel-identical to no camera. The camera does not enlarge the layer
rect: content pushed beyond the document canvas is cropped.

### Scripts

Use document scripts only for behaviour that tracks and camera cannot express. Read
`get_typography_capabilities().scripts` first. Scripts must be synchronous, stateless functions
of time and are disabled by the global preference by default. Tell the user to enable them and
verify the rendered result; never claim a scripted effect is visible while the switch is off.

## 5. Integrate type with the picture

Give the background less detail, contrast or speed behind a reading passage. A controlled
scrim, blur or darker palette role is usually better than shrinking the lyric to fit around
busy imagery. During an instrumental hook, the visual layer may take over; let the text leave
rather than forcing both to be the focal point.

Effects on typography can connect it to the footage, but use the same rules as the rest of the
MV: stable finish, limited continuous motion, sparse accents. A glitch that destroys the exact
word carrying the hook is working against the song.

## 6. Verify the performance

- Render the first line, longest line, fastest passage, main hook and final line.
- Use a contact sheet around quick entrances to see whether text arrives, settles and leaves
  in the intended order.
- Check that a previous line does not remain under the next one and that camera movement does
  not crop the active phrase.
- Ask for full playback review when word timing is estimated. A still frame cannot validate
  vocal sync, reading comfort or whether the repeated motion becomes tiring.
