# gf-forge: the renderer and the look after wave 2 (track L1)

What track L1 added to forge-render, `forge-web/src/glue.rs`, `kit/look.js`, `kit/render.js` and this folder on 2026-10-10, how the world (track L2) and the game use it, and how each number was measured. The brief was `gf-forge/briefs/wave2/L1-renderer.md`; the pictures and logs are in `gf-forge/evidence/wave2-L1-2026-10-10/`. How the Rust side is built is in `core/ARCHITECTURE.md` ("Rendering": the wave 2 paragraph).

**Honest status.** Everything here is measured by scripts on this machine (desktop NVIDIA GPU, chrome-headless-shell, WebGPU). Nobody has judged the look by eye beside the reference but the agent that built it, the creator has seen none of it, and no phone has run it. The reference frames are private and are not in the repo.

## For the world (track L2): surfaces

A model is given its surface once, after it is loaded. `ctx.render` is `kit/render.js`.

```js
const tex = await ctx.forge.texture(bytes, 'image/jpeg');          // the albedo picture (a texture slot's bytes)
ctx.render.surface(model.id, {
  texture: tex,          // drawn in place of the model's own picture (leave out: the model's own)
  tile: 3,               // metres one repeat of the picture covers
  space: 'world',        // laid in world space every `tile` metres: x/z on what faces up or down, the height on
                         // walls. Floor and wall texels then line up whatever the meshes' UVs are.
                         // 'uv' (the default): the mesh's own UVs, one unit of them `tile` metres wide
  emissive: glowTex,     // optional: a second picture that glows (drawn unlit, × emissiveColor × emissiveStrength)
  emissiveColor: '#ff7a2a', emissiveStrength: 2,
  density: 0,            // optional: texels a metre on this model alone (0: the look's)
});
ctx.render.surface(model.id, null);                                 // its own UVs and picture again
```

| Field | Meaning | Without it |
|---|---|---|
| `texture` | a texture id from `host.texture(bytes, mime)` | the model's own picture |
| `tile` | metres one repeat covers; with `space: 'uv'`, how many metres one unit of the mesh's UVs is | the mesh's UV density is measured when it loads (UV area over surface area) |
| `space` | `'world'` or `'uv'` | `'uv'` |
| `emissive`, `emissiveColor`, `emissiveStrength` | a glow picture, its colour (hex or linear `[r, g, b]`) and strength | no glow of its own (a model file's emissive map is still drawn) |
| `density` | texels a metre for the retro look on this model | `look.retro.density` when `tile` is given, else `look.retro.models` |

What the renderer does with it: with `look.retro.texels` on, the picture is drawn as square texels, `density` of them a metre, whatever its resolution. A 512 px picture over a 3 m tile at 16 texels a metre shows 48 texels a tile; each texel's colour comes from the picture's mips, its edges are one screen pixel soft, and far away the mips take over (no shimmer). A picture coarser than the density shows its own texels. With the option off the same texels are filtered smooth. So a ground or wall picture can be any resolution up to 2048 px; **what matters for the look is its brightness**: the moonlit look was tuned on the library's night textures (`library/textures/ground-mud.jpg`, mean luma 65 of 255; `ground-deadgrass.jpg`, 83; `wall-blocks.jpg`, 107). A pale ground (today's room: a light sand colour) is pulled down by the adapting exposure, and then the sky and the far fog go nearly black and the picture's median falls under the target.

**The backdrop** (what stands beyond the walls): `ctx.render.backdrop(instanceId)` on an instance `host.instance(…)` returned. A backdrop instance casts no shadow, is lit by the moon and the ambient light only (no shadow lookup, no fire), is fogged as if it stood `look.backdrop.fog` times as far, is not drawn past `look.backdrop.distance` metres (0: always; the low tier caps it at 90), and is left out when it is outside the camera's view. It needs no collider and no other flag. Instances of one model are one draw.

## For the game: what a fight draws now

Nothing to call. The glue (`forge-web/src/glue.rs`) draws forge-feel's tracer event (kind 33: a hitscan round, each pellet, a beam) and a streak behind every round in flight; the local player's leave the first-person weapon's muzzle where it shows on screen. A friend's tracers are not drawn on other copies: the event is not in a snapshot (the muzzle light and the impact are). From JS: `ctx.render.tracer({from, to, color, width, seconds, beam})`.

Loose pieces (the core's rigid entities: a kill's debris, coins, pickups, orbs) are one draw a model whatever their number. `look.pieces.shadow` (14 m; 10 medium, 6 low) is how far from the eye a piece still casts a shadow, `look.pieces.distance` (70 m; 40 low) how far it is drawn. `ctx.render.pieces(n, {at: [x, z], radius})` lays n pieces at rest for a measurement (QA; `pieces(0)` takes them away).

`ctx.render.stats()` (and `window.__game.forge.drawn()`) gained: `tracersDrawn`, `culled` (items left out of the main pass), `casters` (instances in the moon's shadow pass), `fireFaces` (fire shadow faces drawn this frame), `fireCasters`, `pieces`, `backdrop`, and `tracers` (begun since the page loaded).

## The look's new slots

Every value is a `look.*` slot in `config/look.json` (`kit/look.js` `SLOTS`); a look.json written before wave 2 lacks them and draws as before.

| Slot | moonlit-ruins | What |
|---|---|---|
| `retro.texels` | true | square texels and grain (the reference's "retro texture and grain" option); off: the same texels filtered smooth, no grain |
| `retro.density` | 16 /m | texels a metre on tiling surfaces (ground, walls) |
| `retro.models` | 48 /m | the same for anything with its own UVs (props, bodies, held weapons) |
| `retro.hand` | 160 /m | the same for the first-person arms and weapon |
| `retro.crisp` | 0.5 | 0: a texel is the average of the picture under it; 1: one pixel of it (grittier) |
| `lights.falloff` | 0.16 | a fire's pool: the knee of its falloff as a share of its reach (never under 1 m) |
| `fire.shadows` | 3 | how many of the nearest fires cast a shadow (2 on the medium tier, none on the low) |
| `fire.shadowSize`, `shadowFaces`, `shadowStrength` | 256 px, 4, 0.85 | a face's side, faces drawn again a frame (2 medium), how dark |
| `tone.auto`, `key` | 1, 41 | the exposure follows the picture so its mean luma comes to the key (of 255) |
| `tone.autoMin`, `autoMax`, `adapt` | 0.3, 1.6, 0.3 s | the least and most it multiplies the exposure by; seconds to a brighter picture (four times that to a darker one) |
| `sky.haze` | 0.7 | how high the horizon's colour reaches (what the backdrop fades into) |
| `tracer.width`, `length`, `speed`, `glow` | 0.02 m, 3 m, 220 m/s, 6 | a streak's least width, its length, how fast it crosses a shot's line, its brightness |
| `backdrop.distance`, `fog` | 0, 1 | above |
| `pieces.shadow`, `distance` | 14 m, 70 m | above |

Changed values in `moonlit-ruins`: `exposure` 1.25 → 1, `torch.intensity` 8.5 → 9.6, `bloom.intensity` 0.55 → 0.8, `tone.contrast` 1.04 → 1.14, `sky.zenith` #0f1317 → #262d36, `sky.horizon` #323e44 → #42494d and `fog.color` #37474f → #42494d (so that through this tone curve the sky and the far fog read as the reference's frames do, about #1e252d and #3c4143; the fog uniform feel-targets measured, (0.038, 0.064, 0.078), is #37474f). `ember-crypt` and `ash-storm` keep their values and gain the texel densities, the adapting exposure (key 41) and two fire shadows.

## The measures and the tools

- **Luma** (`measure.mjs` `lumaOf`): mean, median, 99th percentile and the share over 200 of a screenshot's Rec. 709 luma on a 320 px wide copy, against feel-targets "Look targets" (mean 34–48, median 28–44, p99 142–213, about 1% over 200).
- **Pixel-to-pixel detail** (`measure.mjs` `detailOf`): the mean absolute luma step between a pixel and its right neighbour in a box of the picture at its own resolution (the ground: the lower right of a 1280×720 frame, x 640–1100, y 480–700). feel-targets gives the reference's ground as 2.19 with its retro option on and 0.85 off and does not say how; this measure on two reference frames of that option (its menu, on and off) reads 2.52 and 1.26, so compare the two states, not the digits.
- `node runtimes/forge/lookdev/shot.mjs --out <dir> "<lookdev query>" …`: any lookdev picture, measured (`&set=exposure:0.9,tone.auto:0` puts look values over the preset's; `--fire N` keeps a shot's frames).
- `node runtimes/forge/lookdev/capture.mjs <game> --out <dir> [--set exposure=0.9,tone/auto=0] [--no-perf]`: verify's check 9 sheet with look values over the game's own (as Studio's overrides patch them).
- `node runtimes/forge/lookdev/capture.mjs lookdev --out <dir>`: the sheets per look and the bench, now also with 400 pieces at rest.
- `node runtimes/forge/lookdev/fight.mjs <game> --out <dir>`: a game played alone with its test hooks (`?room=1`): the first look, a fight of nine, a shot's, a scattergun's and a repeater's frames from the muzzle flash on, a hit's from its white flash on, a kill's from its pieces on, each held on its exact frame, and 400 pieces at rest with the frame cost before and after.
- New lookdev queries: `&ground=mud|deadgrass|cobble`, `&tile=3`, `&walls=0`, `&backdrop=80`, `&pieces=400`, `shot=ground|yard|pieces`.
