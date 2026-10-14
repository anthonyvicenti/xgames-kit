# Look rubric (scenic engine): does the game look like what the creator asked for?

A build agent answers these eight questions about its own scenic game (`spec.engine` "scenic", gf-scenic) before it delivers. A judge can reuse them on any delivered scenic game. Each answer is **yes** or **no**. Every **no** names what to change, and nothing here needs code: only `config/*.json` and slots.

**The creator's images come first.** When JOB.md has a look target (the creator's pictures), they are what this game is judged against, and the scenic house look (its preset: stylised materials, grass and trees in the wind, water, fog, bloom) is only where you start. Where the pictures and the preset disagree, the pictures win: move `config/look.json` values (sky or void colour, fog, sun and ambient colour, bloom, palette; each a `look.*` slot), the world and the props toward them. Keep the preset id. With no look target, the preset is the target. Creator, 2026-10-08, on a roguelike that ignored their pictures: "The game also doesn't have the right vibe at all."

## Run these first

1. **The likeness check** (when there is a look target). It must pass:

   ```bash
   node {{KIT_TOOLS}}/verify.mjs game --check 23        # the game's own screen beside each picture: camera, palette, light, shapes, characters, vibe
   ```

   Its verdict (`game/evidence/verify-N/verdict.json` → `likeness`) scores each picture on six aspects and lists what to change. Read every line.

2. **The world check**:

   ```bash
   node {{KIT_TOOLS}}/world.mjs game                    # every level the right size, spawns for every seat, a way on from every level but the last
   ```

3. **The contact sheet** on the real GPU (WebGPU):
   - after a full `verify`: `game/evidence/verify-N/sheet/`;
   - on its own: `node {{KIT}}/lookdev/capture.mjs game --out out/sheet --no-perf --shots hero,four,wide,action,top`.

Answer each question from the sheet and the likeness verdict, with each picture open beside it.

## The checks

| # | Question (yes = good) | A "no" looks like | Fix (config / slot) |
|---|---|---|---|
| 1 | **Is the camera the pictures' camera?** The `follow` camera's height, angle and distance frame the scene the way the pictures do (a three-quarter diorama from above, the whole fight in view). | A low view over the shoulder where the pictures look down on an island; the player tiny in a sea of ground. | `config/game.json` → `controller.camera.follow` (`pitchDeg`, `yawDeg`, `distance`, `fov`). |
| 2 | **Is the palette the pictures'?** The main hues, how dark or bright, how saturated. | Daylight greens where the pictures are night and violet; grey where they are warm. | `config/look.json` values: sky or void, fog colour, ground colours; `look.palette`; the world's ground colours (`world.<t>.ground.*`). |
| 3 | **Do light and glow match?** Time of day, where the light comes from, what glows (crystals, portals, runes, lanterns) and how much it blooms. | Flat light, nothing glows, a portal that is just a dark arch. | `config/look.json` (sun and ambient colour and strength, bloom); emissive props from the library; glowing prop colours (`prop.*` slots). |
| 4 | **Are the shapes of the world the pictures'?** Islands with cliff skirts over a void, water and waterfalls, ruins, trees, bridges: what the pictures show around the play area. | A flat round lawn where the pictures have floating islands over a void; bare ground with nothing at the edge. | The world template and size (in the spec: ask in the delivery if it must change), `config/world.json` props and their groups, the level layout. |
| 5 | **Do the characters look like the pictures' characters?** Proportions (head to body), chunkiness, outfits, how stylised. | Realistic adults where the pictures have small chunky robots; the enemies the same build as the players. | `character.body.*` slots (the worker generates `from: "reference"` bodies; never draw one in code), tints, heights in `config/characters.json`. |
| 6 | **Does the depth read?** Fog or haze in the distance, a sky or void behind, the near island crisp. | Everything equally sharp to the horizon; a hard edge where the world ends. | Fog near and far, depth of field, the void or sky colour in `config/look.json`. |
| 7 | **Is the play area clean and readable?** Paths and open ground to fight on, props standing on the ground (not floating or sunk), the player readable against the ground. | A player lost in grass of the same colour; a rock in the middle of the arena; props hovering. | `config/world.json` props, the ground colours, the player tints. |
| 8 | **Do the shots show the game?** The hero shot shows a character's face against the scene; the wide shot shows the island or room and the fight; nothing blocks the camera. | A cliff or tree fills the frame; the camera is under the ground. | Spawns (`config/world.json` → `levels[].spawns`), props near them. |

## Deliver only when

- check 23 passes (or there is no look target), and the world check passes;
- all eight answers are **yes**, or the delivery summary says, in a line each, which are not and why.

Never change the look preset id (`config/look.json` → `preset`) to pass a check, and never turn the look's own features off (fog, bloom, wind) to save work: move their values toward the pictures.
