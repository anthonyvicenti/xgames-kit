# Look rubric: is the game clean before it ships?

A build agent answers these eight questions about its own game before it delivers. A judge can reuse them on any delivered game. Each answer is **yes** or **no**. Every **no** names what to change, and nothing here needs code: only `config/*.json` and slots.

The house look stays `jelly-pastel` (creator, 2026-10-07: "The overall vibe is perfect"). This rubric is about cleanup, not a new style, **unless the creator gave images of the look they want**: then those images are the target (JOB.md, "The look target"), and the house look never overrides them. Move `config/look.json` values (palette, sky, fog, light colours, each a `look.*` slot), the world and the props toward the pictures; keep the preset id. verify check 23 compares the game with them (creator, 2026-10-08: "The game also doesn't have the right vibe at all").

## Run these two first

1. **The set-dressing lint.** It must pass with 0 errors:

   ```bash
   node {{KIT_TOOLS}}/dressing.mjs game              # one plain-words line per problem, each with its fix
   node {{KIT_TOOLS}}/dressing.mjs game --svg out/plan.svg   # a top-down plan: problems outlined in red
   ```

2. **The contact sheet.** Look at it on the real GPU:
   - after a full `verify`: `game/evidence/verify-N/sheet/sheet.jpg`;
   - on its own: `node {{KIT}}/lookdev/capture.mjs game --out out/sheet --no-perf --shots hero,four,wide,action,top`.

   `top` is a plan view from straight above, and is the quickest way to judge the layout.

Answer each question from the sheet. Use the lint for the numbers.

## The checks

| # | Question (yes = good) | A "no" looks like | Fix (config / slot) | Lint rules |
|---|---|---|---|---|
| 1 | **Does the ground read as a surface?** You can see paving, carpet tiles or mowing stripes, and the players are clearly lighter or darker than the ground, not only a different hue. | A flat, pale plane; the beans float on it with no sense of scale. | `config/world.json` → `ground.pattern` (slot `world.<t>.ground.pattern`). Move `ground.color` / `color2` (`world.<t>.ground.color`) darker or lighter, away from the players' lightness. | `ground-flat`, `value` |
| 2 | **Can you see every player colour, its paint and the stream on the ground?** Green on grass counts. | One bean or its paint disappears into the floor. | `ground.color` (`world.<t>.ground.color`), or the seat colours in `config/characters.json` → `palette` (`character.tint.<role>`), or `mechanic.projectile.color`. | `contrast`, `palette` |
| 3 | **Is the floor free of litter?** No small loose things in the open. Pickups are drawn as the game's own pickup prop, not a gem. Nothing that looks collectable stands there as scenery. | Cans and balls scattered about; yellow gems with rings everywhere; flower clumps dotted on paving. | Delete the loose props from `config/world.json` → `props`. For pickups, set the spec prop's role to say players pick it up (e.g. "pick up to refill"), or set `mechanics[pickup].params.prop`. The ring under pickups is `mechanics[pickup].params.marker` (`auto`, `ring` or `none`). Plants go in beds and planters. | `clutter`, `looks-collectable`, `pickup-standin`, `scattered`, `plants-on-paving` |
| 4 | **Does every prop stand cleanly?** Nothing overlaps, floats, sinks, tilts or pokes through a wall. Chairs face their table or desk, and benches face the middle or a centrepiece. | A chair inside a desk; a tree growing out of a hedge; a bench facing a wall. | Each prop's `at` and `rot` (degrees; seats face +z at 0) in `config/world.json` → `props` (slot `world.<t>.layout`). | `overlap`, `inside`, `floating`, `sunk`, `tilted`, `edge`, `faces-nothing`, `duplicate`, `doubled` |
| 5 | **Is the layout purposeful?** Props stand along the edges, in corners and in groups, such as a cafe corner or a desk pod. The middle is open floor to play on, around one centrepiece. | Props sprinkled at random angles across the middle. | Move props to the edges and group them. Keep the lint's open floor at 65% or more and the middle clear. | `crowded-centre`, `cramped`, `density`, `scattered` |
| 6 | **Is everything to scale with a 1.7 m character?** A bench reaches the character's hip, lamps stand about twice its height, doors are a little taller than it, and pickups are easy to read (about a third of its height). | Benches up to a bean's chest; a can the size of a bin; pickups too small to see. | A prop's `scale` in `config/world.json`. Pickup size is `mechanics[pickup].params.size` (0.5–0.7). Character height is `config/characters.json` → `roles.<role>.height`. A wrong library size is a library fix: `library/sources.json`, then `lookdev/tools/curate.mjs`. | `scale`, `scale-mixed`, `stretched`, `pickup-size` |
| 7 | **Do the shots show the game?** The hero shot shows a standing character's face against the scene. The four shot shows the players. No shot is inside, or right behind, a wall or prop. | A wall fills the frame; a player lies on the floor; a lamp post covers the lens. | Usually the spawns: move them off the edges and away from tall props (`config/world.json` → `spawns`). Then capture again. | `spawn-view`, `spawn-blocked` |
| 8 | **Does every player start on open floor?** Each spawn has a metre of clear floor around it, sits inside the play area, faces the middle, and has a seat for every player. | A bean spawns inside a block or against a bench; two spawns overlap. | `config/world.json` → `spawns` (slot `world.<t>.spawns`). | `spawn-blocked`, `spawn-edge`, `spawn-close`, `spawn-count` |

## Deliver only when

- the lint shows **0 errors**, and every warning you keep has a one-line reason in the delivery summary;
- all eight answers are **yes**.

Never change the look preset id (`config/look.json` → `preset`) to pass a check. Change the world and the props, and the look's values only toward the creator's images.
