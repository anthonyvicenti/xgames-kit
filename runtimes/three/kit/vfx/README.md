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

## Limits (honest)

- Additive light is washed out on a bright backdrop (the party looks by day): pick a `normal` preset there or set `blending`.
- `normal` blending cannot fade a particle's alpha on this path (no per-instance alpha): smoke shrinks away instead.
  A translucent, alpha-faded smoke needs a second path (a `ShaderMaterial` in WebGL, a node material in WebGPU): not built.
- No ribbons, trails, mesh particles, turbulence or GPU simulation.
- Effects are cosmetic and local: each copy draws them from the events it already gets; nothing goes over the network.
- The low quality tier (`?quality=low`) draws 40% of the particles in a pool a quarter the size.
- Preview: `?gf-show=vfx.<name>`. `window.__gfVfx.paused = true` freezes it for a screenshot.
