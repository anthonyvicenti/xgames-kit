# Kinds

A kind is how a game feels: one JSON preset in this folder (`<id>.json`, schema `registry/schema/kind.schema.json`).
It is a feel, never a genre: racing or tycoon is a loop with mechanics. A kind changes no rule of play
(`changesPlay: false`); the same loop under two kinds plays the same and looks different.

A game is placed by three answers: the runtime (what runs it), the loop and its mechanics (how it is played), and the
kind (how it feels). The kind is chosen last, from the creator's words and reference games.

## The initial eight (2026-10-13, for the creator to review)

| Kind | Feel | Should evoke | Proven on | Sheet |
|---|---|---|---|---|
| `silly` | toon low-poly, pastel, bright light, jelly bodies that flop | Peak, R.E.P.O., Gang Beasts | three standard-3d | `sheets/silly.png` |
| `blocky` | flat-shaded blocks, block avatars, saturated colours | Grow a Garden, Steal a Brainrot, Minecraft | three standard-3d (exists; no game yet) | `sheets/blocky.png` |
| `lofi` | low resolution, ordered dither, small grimy palette, vertex wobble, ink in the gloom | Lethal Company, Content Warning | three standard-3d (exists; no game yet); forge partly | `sheets/lofi.png` |
| `scenic` | painterly stylised 3D, living grass, coloured shade, fog, a day cycle | Tunic, Hades II, Dredge | three scenic-3d | `sheets/scenic.png` |
| `dark` | grim fantasy at night: moonlit ruins, embers, ash, retro texels | Nightreign, Dark and Darker | forge | `sheets/dark.png` |
| `calm` | photoreal light, sea and sky; the place is the point | Tidewater, Dredge, Webfishing | vista (WebGPU, desktop) | `sheets/calm.png` |
| `pixel` | 2D pixel art, 16 texels a metre, whole screen pixels a texel; villagers, soft edges, set pieces | Stardew Valley, Balatro, Core Keeper | three flat-2d; godot 2d exists | `sheets/pixel.png` |
| `drawn` | 2D cartoon, 128 texels a metre, thick ink, soft edges | Silksong, Cuphead, Pizza Tower | three flat-2d; godot 2d exists (side-on) | `sheets/drawn.png` |

## What a preset holds

Per runtime (keys `three`, `forge`, `vista`, `godot`; the profile goes inside): the `look` (a preset the runtime
lists, its time of day, alternates, and `values` over the preset's, each a `look.*` slot), the `world` family and its
templates (with `values` over a template's layout, each a `world.*` slot, and a world `preset` file), the `camera`
default (and the rig's numbers), the `bodies` set, the `props`. Then the `audio` character in gf-audio terms (presets
per sound, pitch and gain trims, an ambient bed; the bus levels stay the kit's creator-approved defaults), the `hud`
(a theme, or tokens: accent, panel, text, font, corners; `builder/ui/kind-hud.js`, a game's `gf/three/ui/kind-hud.js`,
applies them), the
`mechanics` it suggests (suggestions only: the creator's words win), the `packs` the resolver ranks first
(`PACKS.md`; every one a pack in `library/packs`), the `runtimes` it is proven on (each a `state` {exists, tested, open}, tested with evidence), and
the `sheet` (what its contact sheet renders).

## How create applies a kind

`kinds/apply.mjs`, called once by `builder/tools/create.mjs` right after the spec becomes config (the one seam). The
spec's own answers always win. It writes:

| What | Where in the game | When |
|---|---|---|
| the look's `values`, over the preset and over its time of day (a preset's time block would shadow them) | `config/look.json` | the game's look is the kind's (the spec names no other preset) |
| world `values` and the world `preset` | `config/world.json` | the spec's world is one of the kind's templates |
| the rig's numbers (fov, distance…) | `config/game.json → controller.camera.<rig>` | the spec's rig is the kind's default |
| pitch and gain trims, a preset swap | `assets.json → sounds` | the sound exists and the spec did not describe it |
| the HUD: a theme, or tokens and the font pack's file | `config/game.json → hud`, `assets/fonts/` | not on forge or vista (their HUDs are their own) |
| the packs the art resolver ranks first | `config/game.json → art` | always |

Bodies a spec fills `from: "kind"` are the resolver's, which ranks the kind's packs first. The three runtime's boot
hands `game.hud` to the kit's HUD (`gf/three/ui/kind-hud.js`) and the look attaches the lofi pass itself when its
values carry `post.lofi` (`gf/three/look/lofi.js`). Tests: `tests/kind-apply.test.mjs`.

## Adding a kind (hours)

1. Copy the nearest preset to `kinds/<id>.json`. Write the feel in plain words and the reference games.
2. Pick the runtime the feel needs and a look that runtime already lists; tune it with `values` (every one a slot).
   A look the runtime lacks is a runtime change (a new preset or a pass in the runtime's look), not part of a kind.
3. Name the world family, camera default, body set, props and packs (each a pack in `library/packs`); write the audio
   character from gf-audio's presets; give the HUD its tokens and a font pack.
4. Write `sheet` (the bodies, hero and props it shows) and render it (`--fetch` the first time: the 2D sheet packs):

   ```bash
   node builder/look-judge/kind-sheet.mjs <id> [--fetch]       # → kinds/sheets/<id>.png (+ .json; tiles/ stay local)
   node builder/look-judge/kind-sheet.mjs <id> --only world --query 'set={"fog":{"far":20}}'   # a tuning run
   ```
5. Look at the sheet at full size against the reference games, fix what reads wrong, render again. Validate the
   preset (`npm test`: `tests/kinds.test.mjs`) and rebuild the registry (`node registry/build-catalog.mjs`). Set
   `tested` on a runtime only when a verified example on that runtime proves it.

## Its only check: the contact sheet

`builder/look-judge/kind-sheet.mjs` renders a kind on the runtime it is proven on, headless on the graphics card,
into one PNG: the world (ground, sky, light), a body up close, the body set, the props, the HUD over the world, and a
card of the preset's other answers (palette, camera, audio character, packs, runtime states). A person or the look
judge reads it beside the reference games. There is no numbered check and no score: a taste change from the creator
changes a default in the preset.

`gamesfun verify` draws it for every game (measure 9, advisory): `kind-sheet.mjs --game <dir>` draws the game's kind
with the game's own look, world values and bodies (three standard-3d; on the other runtimes the kind's own sheet, and
the record says so) into the run's `sheet/`. It never fails a verdict and measures no frame rate.

| Runtime / profile | How the sheet is drawn |
|---|---|
| three standard-3d | `pages/three.js`: the runtime's look (the lofi pass included), world, character and prop code on WebGL |
| three flat-2d | `pages/flat.js`: the flat runtime's picture rules (orthographic view, one texel density, pixel snapping) |
| three scenic-3d | a game made by create from the isle-run example in the kind's preset, played by bots, shot through `window.__gfLook` on WebGPU; each body of the set alone in the look's preview |
| forge | the forge lookdev scene in the kind's preset (WebGPU); the props on `pages/forge-props.js` |
| vista | `pages/vista.js`: the kind's own island (`sheet.place`, a generated place) in its preset, library bodies on the pier (WebGPU) |

Art comes from the asset library (`lib/roots.mjs libraryRoute`); the 2D sheet packs are fetched by hash
(`sheet-packs.json`). The HUD tile is the kit's own HUD layer (`builder/ui/ui.js`) over the world frame, in the
kind's theme or tokens. GPU work goes through the machine's GPU slots; `--software` renders on the CPU to check a page
while the slots are busy, and marks the record so it is never taken for a look.

## Parts that came with the kinds

- `runtimes/three/kit/look/lofi.js` (a game's `gf/three/look/lofi.js`): the lofi pass (low-resolution drawing scaled
  up with hard pixels, Bayer 2/4/8 ordered dither, a palette of up to 32 colours, vertex snap to the pixel grid, affine
  texture warp), every number a `post.lofi` look value; the look attaches it and sizes it. Tests: `tests/lofi.test.mjs`,
  and `tests/look-post-size.test.mjs` for the post stack at any pixel ratio.
- `runtimes/three/tools/blocky.mjs`: the blocky body set on gf-humanoid-1 (four variants, rigid toy joints, a printed
  face and a hurt face), the library pack `xk-blocky-bodies`. Tests: `tests/blocky.test.mjs`.
- `runtimes/three/worlds/blocky-land.json`: the voxel world as a world (land with biomes, caves and light, the kit's own pixel faces `xk-voxel-blocks`; no saved edits unless the game keeps them). The world itself is `worlds/voxel` (README there).
- `builder/ui/kind-hud.js` (a game's `gf/three/ui/kind-hud.js`): a kind's HUD tokens over the kit's HUD layer.
