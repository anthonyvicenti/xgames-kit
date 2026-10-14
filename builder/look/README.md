# The looks layer (builder/look)

A game's look is held to a **style target**, not only to its kind. The kind is where a look starts (a preset in
`kinds/<id>.json`); the target says what this game's references actually look like, in facts a renderer can be set
from and a judge can score against. The creator, 2026-10-14: "Obviously we don't to steal the art, but we should be
able to get close in style."

```
references (local images) + the person's words + the kind
   │ target.mjs extract()        measured: palette, value/saturation, edges, regions      judged: lighting, materials,
   ▼                                                                                       shapes, camera, UI, VFX, reads
spec.look.target  (gf-look-target/1, builder/spec/look-target.schema.json)   spec.look.refs  (sha256 + source URL)
   │ apply.mjs                    target → the runtime's look values (light, shadow, fog, grade, outline, rim, ramp, sky)
   ▼
pitch.mjs options()               2–3 readings of the target, each rendered on the game's own world and bodies
   │                              (contact sheets by builder/look-judge/kind-sheet.mjs)
   ▼
the loop's look step              the person picks a sheet; headless takes the judge's best (judge.mjs score())
   ▼
config/look.json + config/look-target.json, and the build brief carries the chosen target
```

A target never changes play. The fold: the preset < the kind's values < the target's values < `spec.look.values` (what
tune.mjs writes, or a person), with `look.preset`, `look.palette` and `look.time` answered first. `spec.look.packs`
names packs a look option draws its art from first.

## The legal line

Style is fair game: palette, proportions, rendering technique, camera, mood, UI conventions. Specific characters,
names, logos and actual art are not. Reference images stay **local**: outside every repository, never in a published
game, never an image-to-image source for a generator, used only to measure and judge. The spec carries each image's
sha256 and source URL, never the image. A target never names the reference game (`avoid` says what stays out).

## The target (`spec.look.target`)

Schema `builder/spec/look-target.schema.json` (`$id` https://xgames.fun/schemas/look-target/1.json), examples in
`builder/spec/examples/look-target/`. Every field is a number, a colour or a short list:

| Part | Fields | From |
|---|---|---|
| `palette` | `colors` [{hex, share, words, role?}] (≤ 12), `value` and `chroma` {mean, spread, hist[16]} (OKLab), `mean` {L, C, contrast, litL, litC}, `warmth` | measured |
| `regions` | `sky`, `ground`, `characters`: {colors, value, chroma, hue}, when they can be told apart | measured |
| `edges` | `density`, `dark` (share of pixels on a thin dark line), `outline` none/low/mid/high, `outlineColor` | measured (+ judged level) |
| `lighting` | `key` (the open world's light), `fill`, `keyStrength`, `contrast`, `shadowSoftness`, `fog` {density, color}, `time`, `sky` [the open world's skies, main first], `local` [lamp, lava and glow colours] | judged, beside the measured numbers |
| `materials` | `shading` (flat, toon, soft-toon, painterly, pbr, unlit, pixel), `bands`, `roughness`, `gloss`, `rim`, `texture` | judged |
| `shapes` | `chunkiness`, `roundness`, `detail`, `headToBody`, `eyes`, `language` [words] | judged |
| `camera` | `view`, `pitch`, `distance`, `fov`, `projection`, `framings` [{name, pitch, distance m, fov, height?, frame?}] (the judge renders at these) | judged |
| `ui` | `style`, `font` [kinds, never trade names], `accent`, `panel`, `corners`, `ink` | judged |
| `vfx` | `style`, `scale`, `palette` | judged |
| `reads` | what makes it read, 3–6 lines in the order they matter | judged |
| `avoid` | what would break it, and what the legal line keeps out | judged |
| `from`, `confidence`, `refsUsed`, `sources` | refs / words / refs+words; how far to lean on it; which parts were measured and which judged, the model | — |

With no images the target is written from words alone: `from: "words"`, confidence about 0.4, and the "measured"
parts are the judge's guesses (listed under `sources.judged`).

## The references (`spec.look.refs`)

`[{sha256, url, frame, note, size}]`: what was measured, by content. The images live in a local folder with a
`manifest.json` (`gf-look-refs/1`: `{name, made, frames: [{file, sha256, url, frame, note}]}`); `refs.mjs` finds them
by sha256 in the reference folders: `XGK_LOOK_REFS` (folders separated by the path delimiter), then
`$XGK_EVAL_PRIVATE/looks/*`, then `~/.gamesfun/look-refs/*`. A game that lists refs no folder on this machine holds
still builds: its target stands as written, and the judge says it could not compare frames.

## Modules and their interfaces

| File | Interface | Owner |
|---|---|---|
| `refs.mjs` | `readManifest(dir)` → {name, dir, frames: [{file, sha256, url, frame, note}], problems}; `refsOf(frames)` → spec `look.refs`; `findRefs(refs, {dirs})` → {frames (with their local `file`), missing}; `refDirs(env)`; `sha256Of(file)` | look-target |
| `stats.mjs` | the look judge's measured numbers (`frameStats`, `compareStats`, `measuredMark`, OKLab helpers). One copy for both halves, so a target and a score are measured alike | look-judge |
| `measure.mjs` | `measureSet(files)` → {frames, palette [{hex, share, words}], value and chroma {mean, spread, hist[16]}, edges, regions {sky, ground, characters}, mean {L, C, contrast, litL, litC}, warmth}; `measureImage`, `measureFrame`, `rgbaOf` (sharp, no browser). `litL`/`litC` are the lit pixels only (OKLab L > 0.45): a dark cave frame says how much is dark, not how its light looks | look-target |
| `target.mjs` | `extract({refs, words, kind, judge})` → {target} with a judge, else {pending: {message, schema, images, dirs, base}}; `finish(base, judged)` → the target; `judgeMessage()`, `JUDGED_SCHEMA` (the fixed rubric, $refs inlined for a runner's structured output); `runnerJudge(run)` (the loop's `claudeRunner`: the person's own login, no key here). CLI: `node builder/look/target.mjs <reference folder or images…> [--words "…"] [--kind k] [--judge [--model opus]] [--judged answer.json] [--out target.json]` | look-target |
| `apply.mjs` | `lookValues(target, {runtime, profile})` → {values, levers, suggest} or {skipped}; `applyTarget(C, spec, {place})` (create's seam, after the kind); `LEVERS` (mapped per runtime, and why the others are not yet); `REF`, `LIT_C`, `LIT_L` (the scaling levers are set from fixed middles, so applying a target twice lands in the same place) | look-target |
| `pitch.mjs` | `readings(target)` → faithful, pushed, and the references' other sky (else softer); `options(spec, {game, target, packs, refs, render, score, calibrate})` → [{id, title, reading, values, levers, art, sheet, tiles, calibration, score}]; `artOf(packs, target)`, `applyArt(dir, art, ground)`; `overview(opts, {refs, out})`; `markOf(files, refStats)`. CLI: `node builder/look/pitch.mjs <game> [--packs a,b] [--refs <reference folder>] [--out dir]` (through the GPU slots) | look-target |
| `world.mjs` | `rankWorlds(target, place, {loop})` (the runtime's worlds by their `reads` in `runtimes/<id>/runtime.json`); `worldPlan(target, place, {loop, current, art, dressing, rank, push})` → {template, params, score, ranked, why, notes}; `cameraOf(target, rig, {framing})` → the rig's numbers; `worldLookValues(target)` (the sea, the ground's patch scale); `dressingOf(words)` → {ids, missing}; `specWithWorld(spec, plan)`; `seaParams`, `seaColours`, `strataOf`, `groundTileOf` | look-world |
| `judge.mjs` | `score(game, target, refs)` → {score 0–100, parts, findings}; `pitch.mjs` calls it when it exists, else every score is null and the faithful reading is first | look-judge |
| `tune.mjs` | the tuning loop over the cheap levers | look-judge |
| `harmonize.mjs` | the style pass, builder side: `harmonizeValues(target, {style, groundTexels, looks})` → config/look.json `harmonize`; `harmonizeLook(C, spec, {place})` (create's seam, inside `applyTarget`); `objectColours(target)`; `harmonizePng(bytes, settings, opts)`, `harmonizeGlb(bytes, settings, {words})`; `distanceTo(palette, settings)`. The numbers are `runtimes/three/kit/look/harmonize-core.js`; load time is `runtimes/three/kit/look/harmonize.js`; the bake is `builder/art/harmonize.mjs` (`gamesfun art harmonize`) | harmonizer |

### The three runtime's levers (standard-3d; the other runtimes and profiles say "not mapped yet")

sky (top, horizon, bottom from the judge's open-world sky, else the measured sky band) · fog (the horizon colour;
near and far by haze) · sun (key colour, intensity by keyStrength, shadow strength by contrast, PCF radius by
softness) · ambient (the fill as a light's colour, the ground colour, intensity by contrast) · materials (toon bands
and softness by shading, roughness, rim, toon highlight by gloss) · post outline (level and ink colour) · post grade
(saturation by lit chroma, temperature by warmth) · renderer exposure (by lit lightness) · lamps (local light pools) ·
the HUD accent. The players' colours, the camera rig, the world layout and every rule of play are never touched.

### How an option is made

Since wave 2 each reading has its place and camera too: the faithful one in the world the target reads as, from its
play camera; the pushed one with more land and cloud and a camera lower and closer; the third in the runtime's next
world when it reads nearly as close, else from the references' wide framing. An option whose world or camera differs
from the game's is made by create from its own spec (`options[].made` = {world, target}: what the pick writes); its
sheet draws the game's own generated world from the game's camera rig. All readings take the ground picture nearest the
target's grass (wave 1 gave the pushed and third readings other tops, which read as other games).


Each reading is mapped onto the levers over the made game's `config/look.json`; with `packs`, the option also brings
the packs' art (a rigged body as the player, the other bodies standing still until their archetype has a rig, props on
the props shot through `config/look-sheet.json`, the ground top nearest the target's grass by hue). It is drawn from a
copy of the game (config copied, the rest linked: nothing is written into the game), then measured once and corrected
once (grade saturation and exposure by its lit pixels against the target's); the correction is kept only when the
judge's measured mark against the references does not fall. The sheet page draws a body with no rig as a static model
and a game's own props when `config/look-sheet.json` lists them (`builder/look-judge/pages/three.js`).

## The place and the camera (looks wave 2, `world.mjs`)

Wave 1 showed the cheap levers barely move a look: what dominates it is the place (a fenced yard against islands in a
sea) and the camera (high and wide against low under a big sky). The target now carries both, judged from the frames:

| Part | Fields |
|---|---|
| `world` | `setting` (islands, coast, town, yard, arena, indoor, cave, dungeon, ruins, desert, forest, hills, mountains, plain, blocks, sky, space, other) and `also` (the other places the levels swing between), `land` (floating, islands, cliffs, hills, canyon, flat, terraces, blocky, rooms), `horizon` (sea, sky, mountains, hills, city, trees, walls, void, none), `water`, `relief` 0–1, `sky` {kind, clouds 0–1, cloudStyle puff/card/wisp/layer, cloudColor}, `props` {density 0–1, dressing [plain words]}, `ground` {tile (metres one repeat of the ground's picture covers), detail, crossSection}, `words` |
| `camera` (added) | `horizon` (where the horizon line sits in the play view, a share of the frame from the bottom), `groundShare`, `eye` (metres above the ground), `perspective` |

What each part drives, on any game:

- **The world.** Each runtime's worlds say what they read as (`runtime.json` `worlds[].reads`: setting, land, horizon,
  water); `rankWorlds` holds the target's facts against them (weights `WEIGHTS`). The best one is chosen and, when it
  takes parameters (`SHAPERS`), shaped: the three runtime's `sea-islands` world (`worlds/sea.js`) takes relief, cliff
  height and ledges, beaches, the islands toward the horizon, cloud cover and style, the set dressing (library props
  found from the target's words by `dressingOf`; the words with none go to the build and the art ladder), the ground's
  picture and its scale, and the cliffs' picture over strata from the palette's rock and soil colours. A world with no
  parameters (voxel, the yards) is chosen as it is, and a place no world reads like names its closest and says what to
  build (never refused).
- **The camera.** `cameraOf` sets the rig's numbers (`config/game.json` `controller.camera.<rig>`): the pitch from the
  horizon line and the fov (tan pitch = (horizon − 0.5) · 2 · tan(fov / 2)), the pivot from the eye height, the distance
  from the play framing, held to what the rig plays well at. Players still move it. create sets it after the kind.
- **Texture scale.** The ground's picture repeats every `world.ground.tile` metres; a calm ground (low detail) takes it
  at part strength over the target's grass colour; the ground's colour patches scale with it (`materials.ground.tile`).
  A pixel-textured or block world keeps its own ground.
- **Sky and clouds.** Puff clouds (rounded masses, unfogged, in a ring low over the horizon) or flat cards, by the
  target's cover; the open sea keeps its own colour to the horizon (deepened from a colour it shares with the sky).

- **The terrain world** (worlds/terrain, smooth ground blasts carve) ranks first when the frames show the ground
  breaking (`world.destructible`; worlds' `reads.traits`: destructible, cross-section, blocky). `terrainParams` shapes it
  (islands or a cliff shore, the land's height and hills, the look's top and cliff pictures, an open sea) and asks for
  its **scenery** (`world.params.scenery`, `worlds/scenery.js`): puff clouds, islands out at sea, and the set dressing
  standing on firm ground above the sea (a carve takes what it undercuts, colliders and all). Scenery props are solid:
  their catalog colliders (a tree's trunk, a rock's body) plus a ball for a tree's canopy above head height, so players
  and the camera stop at them. The seats stand on **level pads** the generator cuts into the land (`pads.count`, flat
  within a few centimetres over three metres): a body and its camera never stand on a slope, and no camera rolls (the
  rigs look at a point with world up: tests/look-world.test.mjs holds it).

### Places for target cameras

Each target camera names the kind of place it stands in (`camera.framings[].where`: the reader's, else from its frame
kind: `looks.mjs` `wherePlaces`: a play or close frame at a seat, a scene on a sunlit rise or over an open sea view).
The look judge's render asks the world for it (`__gfLook.view({ where })` → `ctx.world.place(where)`): the voxel
world's `places.mjs` (a lit cavern, a sunlit rise), the terrain world's `worlds/terrain/places.mjs` and the sea-islands
world's `worlds/sea-places.mjs`, both on the outdoor lookouts (`worlds/lookouts.mjs`: seat, day, night, cliff-edge,
beach, sea-view over the ground's height). A world with no such place answers null and the camera frames the player
(the terrain islands are cliff all round: no beach).

### Looks (levels)

References of one game often span very different levels (a desert, a sky level, a night level, a fortress at dusk);
one averaged target matches none of them. The reader groups the frames into up to four **looks** (`target.looks`: id,
name, frames by sha256, share, setting, and each look's own lighting, world and reads), and `measureLooks` measures
each from its own frames (its setting from the look judge's classifier, `settings.mjs`, when the kit has it).
`looks.mjs` `targetOfLook(target, id)` makes one look a whole target (`level` names it); `levelValues` gives create the
per-level look values: `config/look.json` `levels` {id: values} and `level` (the one the game starts in), and the three
runtime's `ctx.look.level(id)` restyles live to another (for a game that changes look per level or round). The pitch
offers one option per look (the biggest three), each in its own place and held by the judge to its own frames; the
pick writes that look as the spec's target (with the others kept for the levels).

create keeps the spec's world and says when the target reads as another (`applyTarget` notes); the look step's options
show the target's world, and the pick writes it into the spec (`world.template`, `world.params`), which the loop locks
and create makes the game from.

## The style pass: mixed packs made one look (looks wave 3, `harmonize.mjs`)

A game mixes packs (Kenney, KayKit, Quaternius, our drawn packs, generated models) and they do not look like one game:
a teal low-poly tree beside painted grass. The style pass moves every model and picture a slot loads toward the look's
own colours and materials, once, at load time, and the library can bake the same pass into new assets. It never
changes geometry or a shape: a realistic rock stays a realistic shape (the art ladder swaps it; the bake's report and
the judge's findings say so).

**Settings** live in the look: `config/look.json` `harmonize` (a level's own in `levels.<id>.harmonize`, so
`look.level(id)` restyles every harmonised asset live). create writes them from the target (`harmonizeLook`, inside
`applyTarget`, on every three profile, flat-2d too); `spec.look.harmonize` wins field by field, and `false` turns the
pass off. What the target gives:

| Setting | From the target |
|---|---|
| `palette`, `weights`, `roles` | the look's colours of things (`objectColours`): the palette's swatches whose role is not sky, sea, cloud, ink or UI, the other looks' at a smaller share (a crate is a crate at dusk too), and the HUD and effect accents (`ui.accent`, `vfx.palette`: a red barrel has a red to keep) |
| `strength` | 0.85 from frames, 0.55 from words |
| `roughness`, `metalness`, `emissiveMax`, `toon` | `materials` (a toon, flat or painterly look: the house toon material on every model, metalness 0, emissive capped at 1) |
| `outline`, `outlineColor` | `edges.outline`: high → an inverted-hull outline on still meshes (3D), mid → the post outline (3D) or an ink edge (2D); a pixel look inks in each thing's own deep shade |
| `quantize`, `texelsPerMetre` | a pixel look snaps pictures to a ramp of its colours (beside each picture's own few) at 16 texels a metre; drawn 128; 3D props match the ground picture's texels a metre |
| `skip` | the look's own picks (the world pictures the look chose from the library); UI, fonts, cards and the look's data pictures are always left; a slot's own `harmonize: false` too |

**How a colour moves** (`harmonize-core.js`): an asset's colours are grouped (a few OKLab clusters over its surface by
area, or its pixels; a texture is read at each triangle's UVs, so an atlas counts by what it paints). Each cluster turns
toward its nearest look colour, as far as it is near (a plateau: near goes most of the way, far hardly moves), and
moves a little of the way to its chroma (the look's colours are read from finished frames, under light and haze). The
asset's own words (its slot, its materials' and meshes' names, its tags) choose among look colours colour alone cannot
tell apart: `MATTER` groups (foliage, wood, rock, sand, soil, metal, water, skin, fire) meet the look colours' roles,
so a teal canopy goes to the look's greens, not its sea. Lightness moves once for the whole asset, so it keeps its
own value contrast. Every colour then moves with its clusters, through a lookup table: texture detail stays.

**Load time** (three; `kit/assets/assets.js` calls it): a parsed GLB once, before its clones (base colours, or the
texture, or the vertex colours; emissive; roughness and metalness; the toon material; the hull outline), and a texture
slot's picture once (a flat game's sprites and tiles: palette, ramp, ink edge, whole texels). A player's own file is
never touched. `window.__gfHarmony.report()` lists what it did; `restyle(settings | null)` redoes it all from the
originals. The look judge's sheet page runs the same pass (`?harm=0` draws a game without it, for a before and after).

**The bake**: `gamesfun art harmonize --pack <id> --look <target.json | config/look.json | game | kind> [--level id]
[--style pixel|drawn]` writes each asset as a NEW asset in a derived pack (`<pack>-h-<look>`, private unless
`--public`, the source pack's licence): `harmonized` names the original, its sha256, the look and the settings; its
phone variants are harmonised too; preview, signature and validators are measured again. The original pack is never
written. Both sides are measured by the same tool and reported: the distance of the asset's colours to the look's
(`distanceTo`, OKLab transport) and its style fit (`builder/art/coverage.mjs styleFit`).

**What it cannot do**: change a shape, a silhouette or a surface's detail (flat colour stays flat colour; a faceted
low-poly tree stays faceted), or tell an accent from a mistake when the asset's words and the look's roles do not
say (a red with no red in the look drifts toward the nearest look colour). Those are the art ladder's: a library
swap, then generation.

## The loop's look step

`create → look → build`. After create the game exists, so options render on its own world and bodies. The step:

1. takes `spec.look.target`; when there is none and the person gave references or words about the look, a `look`
   round reads them (the judged parts, through the session or the headless runner) and `extract` measures the rest;
2. renders 2–3 options (`tools.lookOptions`); a runtime the sheet tool cannot draw yet is said and skipped;
3. waits for the person (`waiting: creator`, `about: look`, the options with their sheets; `gamesfun_step_look
   {pick}`); headless, the answers hook takes the highest score, else the first option;
4. writes the chosen option's look values into the game's `config/look.json`, and the build brief carries the target
   and the pick (`## The look (chosen before this round)`): the build fills the slots with the option's art.

The ledger carries the person's references (an image by sha256, a page by URL, a game by name) into the pitch. The kit
studio shows the options as sheets (`GET /api/build/look/:option`, the Look stage) and sends the pick to the session
(`gamesfun_step_look {pick}`). `GAMESFUN_LOOK=0` turns the step off; a host with no look tools goes from create
straight to the build.

A spec with no target, no references and no words about the look skips the step (said in the history): the kind decides.

## The judge, the tuning loop and the look gate

Function has a closed loop (gates, repair, ladder). This folder gives the look one too: a judge that scores a game
against its style target and its reference frames, and a tuning loop that moves the cheap levers until the score stops
rising. The style target itself (`look.target`, extracted from the references and the creator's words) and the look
pitch are `target.mjs` and `pitch.mjs` (the look-target stream).

```
node builder/look/judge.mjs <game-dir> [--refs <manifest.json>] [--out <dir>] [--no-vision]
node builder/look/judge.mjs --frames <frames.json> --refs <manifest.json> [--out <dir>]    # pre-rendered frames
node builder/look/tune.mjs  <game-dir> [--refs <manifest.json>] [--out <dir>] [--rounds N] [--write]
node builder/look/calibrate.mjs <calibration.json>                                         # the known pair
```

### judge.mjs

```js
import { score } from './builder/look/judge.mjs';
const r = await score(game, target, refs, { vision: true, outDir });
// game:   a game folder (rendered live on the GPU at the framings below), or { frames: [{ file, framing }] }
// target: the spec's look.target (gf-look-target/1, builder/spec/look-target.schema.json), or null
// refs:   [{ file, frame?, framing?, crop?, sha256? }]: local reference frames (outside every repository; never published)
// → { score: 0–100, bar, pass, advisory, confidence: 'refs' | 'words', parts: { measured: {...}, judged: {...} },
//     framings: [{ framing, ours, ref, measured, judged, score }],
//     findings: [{ framing, part, source: 'measured' | 'judged', line, reach: 'levers' | 'art' }], change, sheet }
```

What it reads from the target: `from` ('refs', 'words', 'refs+words'), `camera.framings` ([{ name, pitch, distance,
fov, frame }]: a camera's place comes from pitch and distance), `palette.colors`, `palette.value.hist` and
`palette.chroma.hist`, `edges`, `regions.sky`, `shapes.headToBody`, `reads`. With no frames on this machine, a target
from frames is held to the numbers it carries (our framings pooled against them, measured only).

**Framings.** The target's camera presets (`target.camera`: `{ name, pitch, distance, fov, height? }`, one or more),
plus the kit's sheet framings: `wide` (the world), `hero` (a character close), `props` (the action shot: props and
bodies at mid range), `hud` (the player's own view, HUD on). Each of our frames is compared with the closest reference
frame (by framing name when the reference names one, else by measured likeness).

**Measured parts** (`stats.mjs`, pure, no browser; each 0–100: 100 the same, about 60 a frame of the same game at
another framing; combined as a weighted geometric mean, so one collapsed part pulls the mark down):
| part | what |
|---|---|
| `palette` | optimal-transport distance between our colour clusters and the reference's, in OKLab (k-means, k = 8) |
| `value` | 1-D earth mover's distance between the lightness histograms |
| `saturation` | the same for chroma |
| `sky`, `ground`, `characters` | surface to surface: each surface's colours against the same surface's (palette transport). A reference's surfaces are the regions `target.mjs` reads (`measure.mjs`: a band is the sky or the ground only when one colour family holds it, so a flying shot's sea is not ground); ours are the same bands kept whatever they hold (`stats.mjs surfacesOf`: a painted ground of many greens is still the ground). A surface only one side shows is not compared |
| `edges` | edge density and dark-line (outline) density, Sobel on lightness |
| `proportion` | head-to-body ratio of the bodies in view against `target.shape.headToBody` (only when bodies are visible and the target says) |

**Judged parts** (`vision.mjs`, one pairwise vision judge per framing, a fixed rubric): `palette`, `lighting`,
`materials`, `shape`, `characters`, `ui`, `vfx`. Each gets `match` 0–4 (how close in style), `vs` (`worse`, `par`,
`better`: how well ours does that aspect next to the reference) or `null` when the pair does not show it, and one plain
finding ("sky too desaturated", "no outlines; reference has thick dark outlines").

The judged parts are weighted by the target's "what makes it read" lines (`vision.mjs partWeights`: each line counts
for the part whose words it uses most; a part no line is about weighs 1).

**Looks side by side** (`compare(looks, target, refs)`): several looks of one game (the pitch's options, a tuning's
before and after, a calibration's states) are each measured alone, then judged together in one call
(`vision.mjs judgeOptions`, the looks under neutral letters, marks out of 10): a judge marking each alone gave close
options the same marks (artillery case: B, C and D all 37), side by side it ranks them as a person does.

**Score** = 30 % measured + 70 % judged (measured alone with `--no-vision`, with no frames on file, and in the tuning
loop's inner search). The bar comes from the target's confidence: `refs` 55, `words` advisory, never failing.

**Calibration** (`calibrate.mjs <calibration.json>`): a known pair, our blocky world against Hollow Reach (our own voxel
trial) before the voxel work, after voxel2 and after voxel3, must rank in that order and agree with the parent's read
(caves too dark at voxel2; land better and caves on par at voxel3). The record is `evidence/`; the frames stay local.
The look options of the artillery proving case (look-target's pitch: B faithful with the pilot pack, about 5/10 by eye;
C pushed and D the other sky, about 3/10; A the kind as it is) are ranked side by side: B first
(`evidence/calibration-artillery-options-2026-10-14.json`, numbers only).

### stats.mjs (shared: look-target computes the target's numbers with the same code)

```js
import { frameStats, compareStats, toOklab } from './builder/look/stats.mjs';
const s = frameStats({ width, height, data });   // RGBA, any size (downscale to ≤ 320 px wide first: pixels.mjs)
// → { palette: [{ lab: [L, a, b], hex, share }], value: [16 bins], chroma: [16 bins], edges: { density, dark }, mean }
compareStats(ours, ref) → { palette, value, saturation, edges } (0–100 each) + findings
```

### A verdict that depends on the game, not on the judge's luck (noise.mjs)

The vision model varies from call to call (its CLI takes no temperature or seed). `noise.mjs` scores one unchanged game
N times: on Hollow Reach / block-valley, re-rendered each time as verify does, the judged half spread with a standard
deviation of 5.7 points (range 17) and the whole 3.8 (range 47–58, across the bar); on the artillery case 2.8 and 1.1.
The measured half is deterministic (0.15 across re-renders; 0 on the same frames). So measure 23:
- averages k = 3 judge passes (in parallel, so about one call's time), the pairs' order reversed on every other pass;
- puts an interval round the score: ± Z · judged weight · sd / √k, where sd is the larger of this run's spread and the
  measured noise (NOISE.judgedSd, 6), Z = 2;
- fails only when the whole interval is below the bar; a game whose interval holds the bar is **unsure**: said, advisory,
  never a fail; above it, a pass.
The measured half keeps 30 % (BLEND): averaged over three passes the judged half's spread is about 3.3, so the band of
"unsure" is the bar ± 4.9; weighting the measured half more would narrow it at the price of the calibration (the bar was
set on the 30/70 blend). Proof (evidence/stability-2026-10-14.json): the same games, verify --check 23 run 10 times each.

### Settings: like with like (settings.mjs)

Every reference frame and every frame of ours has a setting: `day` (outdoors in daylight), `cave` (underground or
indoors), `night`, `close` (a close-up) or `ui` (a menu or title card). The vision model says which (cached by sha256 in
the local looks folder; without a model, the numbers tell day from cave). A reference is scored only against our frames
of its own setting; a setting the references show and no frame of ours does is a finding (`missingSettings`), never a
score. The whole is the settings' scores weighed by game time (the player's own view's setting counts twice).
Our frames include a place per setting when the world has one (`ctx.world.place(setting)`; the voxel world finds a lit
cavern and an open rise in daylight: `worlds/voxel/places.mjs`), so a cave reference is held to a frame in a cave.

### tune.mjs

Searches the cheap levers only, live (`window.__gfLook.restyle(values)`, `__gfLook.worldLight(values)`), like with
like (the parent, 2026-10-14: a tuner scored against every reference at once pulled a daylight overworld toward Hollow
Reach's cave frames, darker and greyer, while its score rose):
1. the look's levers (sky, sun, fog, grade, outline, materials; they reach every setting) are searched for the setting
   with the most game time, toward that setting's references only;
2. a setting's own levers, where the runtime has them per setting (the voxel world's cave fill, lamps, spread, glow and
   fog), are searched for that setting;
3. guards on every step: no other setting's measured score may fall, and no setting may come out darker or greyer than
   both where it started and its own references (mean, lit surfaces and shadows);
4. the judge walks back along each search's path and takes the furthest point it finds closer to the setting's
   references and no worse to play in (`vision.mjs judgeBeforeAfter`: before against after, asked in both orders;
   a preference counts when both orders hold it);
5. the veto: every setting before against after with all choices in place; a setting that loses reverts the group
   aimed at it (or the look's group).
Coordinate descent, then a small evolutionary search, per group. It never changes play or swaps assets. Writes
`<out>/look.json` (`{ values, world }`: the spec's `look.values` and the world's light), `<out>/before-after.jpg` (our
frames, each with its setting) and `<out>/tune.json` (settings, guards, tones before and after, the judge's verdicts,
vetoes). Until it is trusted, the build loop runs it as a suggestion only (the values and the sheet beside the game).
When the plateau is below the bar, the record's `ladder` names the findings the levers cannot reach: an asset swap
from the library first (`gamesfun art coverage`), then generation (`builder/art/recipe.mjs`).

### In the gates and the loop

Measure 23 ("looks like its target", gate F; `builder/tools/lib/look-check.mjs`): it fails below the bar when the target
rests on frames, and is advisory when it rests on words only. Why F and not a seventh gate: `builder/GATES.md`. In the build loop, after a round passes the functional gates, the ladder runs
`tune.mjs` before any look repair, and the judge's findings go into the repair brief.

### The legal line (as above)

Reference frames stay local (a manifest of files by sha256, outside every repository). They are measured and judged,
never fed to a generator, never published. Records keep file names and hashes, never the frames.
