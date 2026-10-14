# gf-scenic world (track L)

Generated scenic worlds: islands, floating isles, ruins and dungeons, drawn with folio-2025's terrain, grass, leaves,
flowers and water (MIT, `brunosimon/folio-2025@41046b5`, `../LICENSE-folio-2025`), folio's props
(the asset library's `folio-nature` pack, MIT) and the KayKit Dungeon Remastered pieces (`kaykit-dungeon-remastered`, CC0). CONTRACT §4.3 and §8.

| File | What it does |
|---|---|
| `generate.js` | pure and seeded (the title's hash): `worldConfig(spec)` (create, Node), `generate({template, size, seed, levels, preset})`, `terrainData(cfg)`, the palettes; the shapes are gf-three's `kit/world/places/shapes.js`, re-exported. It imports the shared kit as a game sees it (`../../three/world/places/`): in Node, install `research/gf-three/tools/lib/kit-import.mjs`'s hook first |
| `recipes.js` | the island, isles and ruins levels as recipes of the places vocabulary (gf-three `kit/world/places/`, open builder wave 10): `generate` runs one per island level over the world's one random stream (until wave 10 this was `islandLevel` and `dress`, code with a branch per template) |
| `world.js` | `loadWorld(ctx, cfg)`: the island tops, cliffs, water, falls, grass, trees, bushes, flowers, props, crystals, islets, rocks, the levels API; its colliders come from gf-three's one list (`kit/world/colliders.js`); `slotsFor(cfg, catalog)` |
| `terrain.js` | folio's Terrain, Floor and WaterSurface: the terrain data texture (r stone, g grass, b water depth, a island), the floor shader with folio's slabs and the glowing rune lines, the cliff skirts, the waterfalls |
| `vegetation.js` | folio's Grass, Foliage, Bushes, Trees, Flowers: wind grass that follows the view, alpha-tested leaf clusters (with folio's see-through round the local player), pines as stacked clusters |

## Templates

| Template | Levels | Shape |
|---|---|---|
| `island` | 1 (or the levels mechanic's count) | a grassy island in a sea, a plaza, paths, a pond and stream |
| `isles` | 3 | floating islands over the void, each with a cliff wall tapering to a hanging point, a waterfall turned toward the camera, crystals, rim boulders, islets and loose rocks |
| `ruins` | 1 | a large paved arena ringed by KayKit pillars, broken walls and rubble, standing torches, a wood round it |
| `dungeon` | 1 | KayKit 3 m modules: a 15 m hall and 9 m rooms joined by corridors, doorways with their doors open, low walls on the camera's side, wall torches, banners, barrels, a gold chest by the portal |

Each level (CONTRACT §8 "Levels"): `{id, at, radius, half, last, spawns, zones: {arena, portal, plaza}}`. Every level
stands at y = 0 (the waves mechanic draws enemies at y = 0). `world.bounds` is the current level's play box, a square
that fits inside the island's walkable rim (the waves mechanic clamps enemies to it); `setLevel(i)` moves it, the
spawns and the zones. `world.entry(rng)` is a point at the edge of the play box; `world.via(from, to)` routes through a
dungeon's doorways.

## Slots

`world.<t>.ground.*` (grass, sunny grass, earth, path, paving, cliff, deep cliff, moss), `world.<t>.water.*` (water,
deep water, foam, waterfall, sea, depth), `world.<t>.foliage.<kind>` (two colours: shade, sun), `world.<t>.flowers`,
`world.<t>.stone`, `world.<t>.wood`, `world.<t>.grass.*` (density, height, width), `world.<t>.runes`, the two texture
slots (`ground.slabs`, `foliage.texture`, folio's), the layout JSON slots, and `prop.<id>` for every model the layout
uses (folio MIT or KayKit CC0, each with its licence). The crystals' colour is the look's `look.glow.crystal|rune`.

## Not yet

- Track C's KayKit Forest (pines, rocks, bushes) is not in: pines are folio leaf clusters on a primitive trunk.
- A dungeon's room set is one level; `via` routes room to room through the doorways, but the waves mechanic still
  clamps enemies to the level's bounding box (they can cross walls).
