# kit/vfx: named effects

An optional kit module (a folder with a `module.js`: `create` vendors it into `gf/three/vfx/` only for a game that
uses it). Particles drawn as one `InstancedMesh` per preset, billboarded on the CPU: one drawing path for WebGL (party)
and WebGPU (scenic), no renderer branch.

```js
const vfx = ctx.vfx;       // made on first use (vfxOf(ctx) from './index.js'); a mechanic gets it by dynamic import
vfx.fx('spark-burst', { at: {x,y,z}, dir?: {x,y,z}, count?, scale? });     // one burst
const h = vfx.follow('fire', object3d, { offset?, rate?, scale? });        // continuous: rides an object; h.stop()
```

Never the verb `play`: verify check 18 reads every `play('id')` in game code as a sound id (regression `vfx-named-play`).

## Presets

`config/game.json → vfx.<name>` = `{ color, colorEnd, texture, shape: {...} }`, a copy of a kit preset
(`presets.js`: spark-burst, impact-flash, smoke-puff, dust-kick, fire, magic-sparkle, confetti). Each preset a game
uses is four slots: `vfx.<name>.color` and `.texture` (main), `.color-end` and `.shape` (advanced). A game gets a
preset by naming it in a mechanic param ending in `Fx` (`projectile.hitFx: "spark-burst"`): `create` writes the config
block and the stand-in sprite and vendors this folder. Added by hand to an existing game: put the block in
`config/game.json`, copy a sprite from `standin/`, and re-run `create` (it keeps your files and rebuilds `assets.json`).

`shape` numbers: `count`, `rate` (per second, continuous), `emitter` (point | sphere | disc | ring | box | line),
`radius`, `height`, `outward`, `speed`, `life`, `size` (each with a `...Jitter`), `gravity` (negative rises), `drag`,
`spread`, `up`, `stretch`, `spin`, `fade`, `shrink`, `grow`, `hueJitter`, `intensity`, `blending` (additive | normal).

## Effect styles (styles.js)

A game's effect style is `config/game.json → fx` = `{style, blast, hit, trail, numbers, scale, palette?}` (slot
`vfx.style`), written by `create` from the spec's look target (`look.target.vfx`, `styleFromFacts`): cartoon (solid round
puffs, chunky low-poly rocks and bright bits thrown far, a shock ring, star sparks, inked damage numbers), fiery (a
CC BY flipbook fireball, wispy smoke, sparks, shards), pixel (square bits) and soft (the kit's party default). The
mechanics call the part, never a preset: `vfx.blast(at, {radius})` (projectile: a splash), `vfx.hit(at)` (a direct hit, a
landing), `vfx.trail(object)` (each shot), `vfx.damage(at, amount)` (health: every hurt, through `ui.pop` in the HUD's
number style). New drawing options: `solid` (cut-out sprites with depth), `alpha` (soft sprites that fade, WebGL),
`upright`, `mesh` (`chunk`, `shard`: lit tumbling pieces), `flipCols/flipRows/flipFrames` (a flipbook). Sprites:
`standin/` (ours from `scripts/make-vfx-standins.mjs`; the Kenney smoke CC0 and the Quiver flipbook CC BY 4.0, credited
in a game's ATTRIBUTION.md: NOTICE-styles). Preview: `?gf-show=vfx.blast`.

## Limits (honest)

- Additive light is washed out on a bright backdrop (the party looks by day): pick a `normal` preset there or set `blending`.
- `normal` blending cannot fade a particle's alpha on this path (no per-instance alpha): smoke shrinks away instead.
  A translucent, alpha-faded smoke needs a second path (a `ShaderMaterial` in WebGL, a node material in WebGPU): not built.
- No ribbons, trails, mesh particles, turbulence or GPU simulation.
- Effects are cosmetic and local: each copy draws them from the events it already gets; nothing goes over the network.
- The low quality tier (`?quality=low`) draws 40% of the particles in a pool a quarter the size.
- Preview: `?gf-show=vfx.<name>`. `window.__gfVfx.paused = true` freezes it for a screenshot.
