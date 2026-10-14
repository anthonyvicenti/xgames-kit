# gf-three look (track L)

Renderer, lighting, sky and fog, soft shadows, the post stack and the house materials. CONTRACT §4.2.

```js
import { createRenderer, applyLook, material, presets, lookConfig, slotsFor } from './gf/three/look/look.js';
const renderer = createRenderer(canvas, lookJson, 'high');        // or K1's tier object { name: 'high', ... }
const look = applyLook(ctx, lookJson, { time: 'day' });          // ctx: { scene, camera, renderer, assets? } → also ctx.look
look.render(dt);                                                  // or look.render(camera) — instead of renderer.render
const m = material('character', { tint: '#ff7eb3' });             // character | prop | ground | water | liquid | glow | decal
```

## Presets (`presets/*.json`, mirrored into `presets.js` by `lookdev/tools/build-presets.mjs`)

| Preset | Feel | Tone map |
|---|---|---|
| `jelly-pastel` | soft wrap light, glossy jelly bodies (clearcoat, subsurface, rim), pastel palette, light ink outline, light bloom | AgX |
| `toon-lowpoly` | three soft light bands, crisp ink outlines, saturated colours, a hard toon highlight | ACES |
| `soft-stylised` | stylised PBR, deep N8AO, warm low sun, haze, filmic grade, almost no outline | AgX |

Each preset has `quality.high|low` and `times.day|golden|night` (deep-merged over the base by `resolveLook`).
`config/look.json` is `lookConfig(id, { time })`: the whole preset, so **every number and colour is a `look.*` value slot**
(`slotsFor(lookJson)`, about 30 main tier). Switching preset = writing a new `lookConfig` (the values travel with the file).

## What applyLook builds

- **Light**: a directional sun (PCF soft shadows, radius = `sun.shadowSoftness`, darkness = `sun.shadowStrength`), a
  hemisphere fill, and an environment map baked from the sky dome (+ a ground disc in `ambient.envGround`).
  `look.fitShadows(box)` fits the shadow camera to the world once (world.js calls it), so shadows never swim.
- **Sky**: a gradient dome (`look.sky.*`), sun glow and disc. **Fog**: linear, `look.fog.*`.
- **Lamps**: `look.setLamps(points)` (world.js passes lanterns, street lights, floor lamps). Night turns on up to
  `quality.*.lampLights` point lights and a glow orb per lamp (`look.lamps.*`).
- **Post** (`post.js`, pmndrs postprocessing + N8AO): RenderPass → N8AO (high tier) → ink outline + bloom + tone mapping
  + grade/vignette → SMAA (high) or FXAA (low). The outline is screen-space from the depth buffer (silhouettes, plus
  creases on high), tinted, faded with distance.
- **Materials** (`materials.js`): MeshStandard/Physical with a shader patch: wrap lighting, optional bands, a shadow
  floor, rim, subsurface tint, toon highlight, saturation/pastel lift. Uniforms are shared per kind, so a preset or time
  change restyles every material live. `adoptMaterials(object3d, kind, { tint, tintMaterials, tintMode, materials })`
  converts a loaded GLB in place (world props; bodies). Clones stay house materials. Adopting a material that already
  is a house material of that kind (and no tint) keeps it, so adopting twice is a no-op.
  `decal` (added by the wave-1 polish track for paint): flat things lying on the ground. It shares the ground's uniforms
  and base values, so it sits in the ground's light and shadow, without the ground's noise detail.
- **Liquid** (`liquid.js`): `createStream({ tint, width })` → a tapered tube on a ballistic arc with drops and a splash;
  `aim(from, to, { apex })` or `fire(origin, velocity)`, `update(dt)`.
- **Capture hook** (`capture-api.js`): `window.__gfLook.shot('hero'|'four'|'wide'|'action'|'top')`, `perf(ms)`,
  `coverage()`, `info()`. `lookdev/capture.mjs` and K1's verify (check 9) use it. Shots are in `shots.js`
  (generic: subjects + world bounds; cameras are kept inside the play area and lifted out of walls).
  No camera starts inside or right behind a world mesh: capture-api passes `occluders` (a ray test against
  `ctx.world.root`, so tree crowns and parasols count, not only colliders) and each shot turns around its subject until
  the line of sight is clear. The hero is the first player standing up (a ragdolled one makes a portrait of the floor),
  framed from the angle with the most open background. `top` (not on the contact sheet) is a plan view straight down,
  for judging a layout: `capture.mjs <game> --shots top`.
- **Ground pattern**: `material('ground', { color, color2, patternSize, pattern })` and `setGroundPattern(mat, texture)`;
  the pattern multiplies over the ground colour in world space (the world's `ground.pattern`, kit/world/README.md).

## The style pass (`harmonize.js`, `harmonize-core.js`)

Mixed packs made one look at load time: `kit/assets/assets.js` passes every parsed GLB (once, before its clones) and
every texture slot's picture through `harmonizeModel` / `harmonizePicture`, driven by `config/look.json` `harmonize`
(a level's own under `levels.<id>.harmonize`; `look.level(id)` restyles them live). Colours move toward the look's
colours of things, roughness and metalness toward its own, the toon material and an inverted-hull outline when the look
asks; a flat game's pictures get the look's ramp, an ink edge and whole texels. Geometry and alpha never change; UI,
fonts and the look's own pictures are left. `window.__gfHarmony.report()` says what it did. Builder side and the library
bake: `builder/look/README.md` ("The style pass").

## Slots it tags

`look.sky.top` (sky dome), `look.lamps.color` (glow orbs), `look.materials.liquid.core` (a stream with no slot of its
own), `look.textures.noise` (the one texture: `assets/textures/ground-noise.png` in a game, `library/textures/noise-soft.png` in the
library; optional, loaded via `ctx.assets`).
`tests/l-look.test.mjs` checks every tag is declared.

## Contract requests (see the track L report)

1. **K1 / create**: keep copying `library/textures/noise-soft.png` to `assets/textures/ground-noise.png` (now the look's slot
   `look.textures.noise`; the world no longer declares its own ground texture).
2. **C / character**: run the body through `ctx.look?.adoptMaterials?.(model, 'character')` before tinting, so bodies get
   the house character material (jelly gloss, rim, subsurface). Done (wave-1 polish): `spawnCharacter` does it.
3. **K2 / projectile**: reads `ctx.physics` as the Rapier world plus `ctx.RAPIER`; K1 provides `ctx.physics = { RAPIER, world }`
   (`castRayAndGetNormal is not a function` in the bench until shimmed). Done (wave-1 polish): K1 provides the bare World
   plus `ctx.RAPIER`, and every module reads either shape through `kit/core/util.js` `physicsOf(ctx)`.
