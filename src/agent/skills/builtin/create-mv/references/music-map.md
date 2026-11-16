# Reading the music map

`analyze_music` returns a bar-level map of the song. This file says what each field is
worth, and where the line between measurement and inference sits.

## Measured

| field | what it should decide |
|---|---|
| `letter` | Visual family. A / B / A means the same musical material came back: reuse the grammar, change one variable. Transposition does not create a new letter; a different arrangement does. |
| `energy` 0–3 | How hard the cut is, how bright the palette can go, how much motion the shot carries. Relative to this song, never to another one. |
| `dEnergy` | Change from the previous section. A big positive number is where a new world can start; a big negative one is where things should thin out. |
| `bars` | Phrase length. Four or eight bars is the common case; an odd count is usually a half-phrase and wants a different treatment. |
| `onsetDensity` | Short dense shots versus long sustained ones. Sparse onsets do not support a cut every bar. |
| `band` (sub / bass / mid / high / air) | Palette and effect character: bass-heavy wants weight and slow motion, air-heavy wants grain and detail. |
| `brightness`, `noisiness` | Clean versus dirty. `noisiness` near 1 means noise-based effects will read as part of the material rather than as a filter. |
| `novelty` | How hard the boundary is. A weak boundary is a change of texture, not a change of world. |
| `drops[]` | The two or three moments that must read as events. Everything else is preparation for them. |

## Inferred

`role` (`intro` / `build` / `drop` / `breakdown` / `outro` / `section`) and
`roleConfidence` are derived from energy, its change, and boundary strength. They are a
hypothesis, not an observation.

- Say what was measured: "the analysis puts a boundary here and the energy rises across it".
- Never say "this is the chorus". The tools do not know what a chorus is, and the user's
  reading of their own song outranks the guess.
- A high `roleConfidence` still is not proof; it only means the energy pattern was clean.
- A `role` of `section` means "no strong pattern" — not "unimportant".

## What the map cannot tell you

- Lyrics, vocals, or which instrument is which.
- Whether a repeated section should look the same. `letter` reports that the material
  repeats; the direction decides whether the picture repeats.
- Anything about a track it did not analyse. `source` names the clip that was used.

## Verification

`render_music_map` draws the same data: section ribbon, RMS envelope, five-band stack,
onset density, novelty with its threshold line, bar numbers and a time ruler. Two things
are only visible there:

- a section that is **flat** inside (the energy line does not move) — a shot list of four
  equal shots will read as static even though four generators were used;
- a **drop with no contrast** (the energy barely steps up) — the picture will not deliver
  the payoff the arrangement asked for, so the visual contrast has to come from palette,
  scale or edit rhythm instead.
