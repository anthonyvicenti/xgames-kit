# gf-scenic look (track L)

The scenic engine's renderer, house material, light, shade, fog, sky, weather, wind and post: a port of folio-2025
(Bruno Simon, MIT, `brunosimon/folio-2025@41046b5`, the licence is `../LICENSE-folio-2025`), the engine behind
scenic-drive. CONTRACT §4.2 and §8. Every ported file names its upstream file in its header.

```js
import { createRenderer, ready, applyLook, material, adoptMaterials, presets, lookConfig, slotsFor } from './gf/scenic/look/look.js';
const renderer = createRenderer(canvas, lookJson, quality);   // WebGPURenderer; ?renderer=webgl forces its WebGL2 backend
await ready(renderer);                                         // renderer.init()
const look = applyLook(ctx, lookJson);                         // also ctx.look and window.__gfLook
look.update(dt, me.position); look.render(camera);
```

| File | From folio-2025 | What it does |
|---|---|---|
| `look.js` | Rendering.js, Ligthing.js, Cycles/DayCycles.js | the renderer, the sun and its shadow box (follows the view, snapped to shadow texels), the time of day and the optional day cycle, lamps, the per-frame update, `window.__gfLook` |
| `materials.js` | Materials.js, Materials/MeshDefaultMaterial.js, Wind.js | the house material: lit colour, core and drop shade toward the look's shade colour (never grey), ground bounce, lamp pools, a character rim and lifted shade, fog, the void fade, emissive; `adoptMaterials` and `adoptScene` patch any lit material in place, so `.color`, `.map`, `.emissive` and `.opacity` keep working (tints, loadouts, hit flash, fair-play shimmer) |
| `noises.js` | Noises.js | the perlin and voronoi textures (shader utilities rendered on the GPU at start) |
| `sky.js` | Fog.js | the background: the fog's screen gradient (so distant things melt into it), a tint toward the top, stars |
| `weather.js` | World/RainLines.js, World/Lightnings.js, Geometries/LineGeometry.js | rain and snow lines, lightning strikes and the flash |
| `post.js` | Rendering.js (setPostprocessing), Passes/cheapDOF.js | bloom on both tiers, the cheap tilt-shift depth of field on high (off for close shots), 4x MSAA on high |
| `presets.js`, `slots.js` | DayCycles presets (retuned) | the five presets; every number, colour and switch is a `look.*` slot (groups `look`, `look-times`, `look-quality`) |
| `capture-api.js`, `shots.js` | gf-three's own | `window.__gfLook`: `shot(name \| {position, target, fov})`, `perf(ms)`, `coverage()`, `info()` (GPU and backend), `freeze(on)` |

## Presets

| Preset | Time | Feel |
|---|---|---|
| `dusk-isle` | dusk | the creator's reference art: cool lavender light, purple shade, a near-black violet void with stars, mint rune lines, purple and green crystals, warm lanterns |
| `night-ruins` | night | moonlit blue, stars, amber runes and braziers |
| `golden-meadow` | golden | folio's warm low sun, lilac shade, peach-to-rose haze |
| `storm-coast` | day | slate light, rain lines and lightning, strong wind |
| `clear-day` | day | folio's day: cyan-to-lilac sky, crisp coloured shade |

Groups: `light`, `shadow`, `bounce`, `fog` (the sky gradient, the haze distances, the void fade), `sky` (tint, stars),
`lamps`, `glow` (lantern, crystal, rune colours and strength), `rim`, `character` (characters' lifted shade), `wind`,
`weather` (rain, snow, lightning), `cycle` (an optional slow day), `post` (bloom, depth of field), `quality.high|low`
(shadow map, depth of field, bloom mips, grass density, pixel ratio), `times` (the other times of day as overrides; the
preset's own time has none, so a base value always shows), `palette`.

## Notes

- folio's camera looks at its island from +x+z; the follow camera looks from -x-z. Anything folio drew one-sided toward
  its camera (rain quads, leaf cards) is double-sided here, or it does not draw at all.
- Lights do not light house materials directly (folio's output node replaces the lighting); light pools come from the
  world's light points (`look.setLamps`), up to 8 nearest the view.
- `look.set({ time })` and `look.set({ config })` restyle live; the day cycle blends the times' values.
