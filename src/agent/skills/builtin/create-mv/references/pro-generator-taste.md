# Generator direction

Choose a generator for the role it plays and the change it can express. The question is
not "which generator looks cool" but "what should still be recognisable after this shot
has moved for four bars". Read the actual parameters with `get_capabilities` before writing.

## Pick by visual role

| Role | Useful families | Direction |
|---|---|---|
| Full-screen audio-reactive hero | `scene-ripple`, `scene-field`, `scene-datamosh`, `scene-flow`, `scene-strands` | Use the shared arrangement controls (`density`, `warp`, `tone`) as an authored score, not as unrelated sliders. Read each scene's private controls separately. |
| Navigable mathematical world | `menger`, `mandelbulb`, `apollonian`, `tunnel-3d`, `scene-3d` | Compose the camera first. Use orbit / travel / rotation to reveal structure; keep a recognisable spatial anchor between shots. |
| Evolving flat mathematical image | `mandelbrot`, `newton`, `kleinian`, `lyapunov`, `buddhabrot` | Do not leave a fractal as a still. Animate its centre / view / formation parameters where available, and replace the stock palette with project colours. |
| Emergence / artificial life | `game-of-life`, `langtons-ant`, `reaction-diffusion`, `brians-brain`, `cyclic-ca`, `lenia`, `wireworld`, `lsystem`, `dla` | Use growth, self-organisation or rule-driven change as the meaning. Often stronger inside a composition than as an unexplained full-screen simulation. |
| Geometry in motion | `kinetic-shapes`, `polyhedron`, `particles`, `fluid` | Choose one motion grammar: radial entrances, orbiting bodies, ballistic particles or fluid advection. Do not stack all four. |
| Atmosphere / spatial material | `smoke`, `volumetric-cloud`, `horizon`, `black-hole` | Establish scale with camera and negative space. Extra glow cannot rescue a weak composition. |
| Support / mask / background | `grid`, `gradient`, `bars`, `noise-field`, `streamlines`, `qr-code` | Give the layer a job: depth, pacing, masking, direction or encoded content. A support layer may become the hero only when the composition deliberately promotes it. |

## Make the image develop

- Change one dominant spatial or structural parameter over a phrase. Add a second only when
  it answers another audible layer. Keyframing everything produces arbitrary churn.
- For flat fractals, prefer a coherent camera journey or morph over random per-beat seeds.
  Keep a landmark stable long enough for the viewer to perceive the transformation.
- For 3D fractals and tunnels, frame a surface, opening or passage before increasing speed.
  Faster travel without a readable destination is just visual noise.
- For life / reaction / growth systems, let the state become interesting before judging it.
  Many are empty or trivial near local `t=0`; use pre-roll when the first visible frame must
  already contain a developed structure.
- For bake reveals, `speed` determines when the reveal fills. Match that development to the
  phrase; do not assume the whole baked image appears at the clip head.
- For repeated sections, preserve the generator and its visual identity. Change the camera,
  scale, palette role or arrangement parameter rather than substituting an unrelated algorithm.

## Use audio deliberately

The five audio-reactive `scene-*` generators read offline features and the beat grid. They
can carry continuous energy and discrete hits without manually keyframing every frame.

- Use `density` / `warp` for the large arrangement arc and `tone` for the tonal arc.
- `lift` exists only on `scene-strands`; other private controls vary by scene. Never treat a
  uniform in shared shader code as a writable parameter without checking `get_capabilities`.
- With no audio, their feature input is zero and the picture may be dark. Fix the input first.
- Do not add independent shake / flash effects on top of an already reactive scene unless the
  two responses represent different musical events.

## Compose layers instead of accumulating them

A useful stack has a clear order: background texture, hero, supporting motif, typography.
When two hero layers compete, remove one or move it to another section. Use transparency
only where the capability exposes it; do not assume every full-frame generator has alpha.

`streamlines` can describe emission, attraction, connection, rain or directional flow depending
on its endpoints and segment length. Animate endpoints to make the network participate in the
music; leaving the default field running behind everything adds little.

`particles` and fluid / smoke systems need a performance-aware prototype. Start with a modest
population / quality, inspect motion, then raise detail. `intRes` is a performance control,
not a creative resolution switch; check the final frame after changing it.

## Do not fabricate unsuitable subject matter

Do not construct realistic people, faces, animals, products or complex narrative props from
primitive shapes when no suitable asset exists. Choose an abstract treatment, use supplied
media, or ask for the missing asset. Procedural geometry is strongest when the geometry is
the subject, not when it is an apology for unavailable footage.
