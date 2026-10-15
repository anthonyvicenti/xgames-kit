# gf-three world (track L; worlds track D)

World templates, the seeded generator and layout loading. CONTRACT §4.3.

```js
import { loadWorld, templates, templateLayout, slotsFor, expandLayout } from './gf/three/world/world.js';
const world = await loadWorld(ctx, assets.config('world'));   // also ctx.world
world.spawn(i)        // Vector3 with .yaw (faces the middle)      world.zone('centre') → { contains(p), random(rng), at, size }
world.raycast(from, dir, max) → { distance, point, normal?, collider? } | null
world.props           // Map(prop id → [{ prop, at, rot, scale, matrix, meshes, instance }])
world.bounds          // Box3 of the play area (.half for K1's stand-in API)    world.colliders / world.shapes / world.lampPoints
world.kind, world.sizeClass, world.rooms, world.doors, world.entries, world.ceiling
world.roomAt(x, z)    // the room holding a point, or null
world.via(from, to)   // the next point toward `to` through the doors (null in one room): waves enemies and bots use it
world.entry(rng)      // a point just inside a real door or gate: where the waves mechanic brings an enemy in
```

## Recipes, size classes and the generator (`generate.js`)

A template file is a **recipe**; `generateLayout(recipe, { size, seed })` (pure: create, upgrade, the lint, verify and the
browser share it) expands it into the layout a game keeps in `config/world.json`. `create` passes the spec's
`world.size` and a seed from the title, so each game gets its own rooms and the same ones every time.

| Class | Play area | What it is | Spaces | Entries |
|---|---|---|---|---|
| `small` | 350–950 m² | one main space everyone can see across (about 5 s to cross at walking speed) | 1 | 1 |
| `medium` | 1000–1800 m² | several rooms or areas joined by doors and paths (about 7 s); players split up and regroup, enemies come from two sides | 3 | 2 |
| `large` | 1900–3200 m² | a building or park to roam, more than one route between spaces (about 9 s) | 5 | 3 |

The bands are for 1–4 players (bots fill seats) and the third-person camera: 5.2 m behind the shoulder with a 60° view,
about 10–12 m of floor reads clearly ahead.

- **Indoor** (`kind: "indoor"`, the office and the supermarket): a closed building. The size picks the footprint and the room program:
  bands of side rooms along the outside walls (`program.<size>.bands`), the main room in the middle. Rooms are joined by
  real doorways (`office-wall-doorway-wide`: two posts and a lintel, a 1.7 m opening), a spanning tree from the main
  room plus loops from medium up. Rooms marked `entry` get a door to the street: the `entries`. Walls stand on a 2 m
  module (windows outside; glass where a room asks, e.g. the meeting room). A ceiling covers every room; each room is
  dressed by its zone recipe (`rooms.<kind>.fill`: groups `where` wall | corner | centre | grid) from the template's
  furniture `groups`; the main room's middle stays clear (the atrium, zone `centre`). Outside: sidewalk, a road ring,
  street lights and city blocks with towers on the corners and a skyline.
- **The ceiling is a cutaway.** It faces down (seen from inside, culled from above), fades out as the camera rises to it
  (`ceiling.fade`, 0.6 m) and takes the hanging lamps with it; it casts no shadow. It sits at 3.9 m, above the
  third-person camera's usual 3.1 m, so the normal view sees it; looking down lifts the camera over it and shows the room
  from above, and the contact sheet's wide and top shots show the building with its roof off. A band (`ceiling.band`)
  closes the walls up to it. Slots `world.<t>.ceiling.color`, `.band`, `.pattern` (ceiling tiles).
- **Outdoor** (backyard, plaza, arena): the hand-dressed layout in the file is the small world. A larger class keeps the
  middle's set-pieces, moves what stands near an edge out with that edge (things within 1.5 m of each other move
  together), fills the new floor with `grow.<size>` groups (each may name an area zone), and rebuilds the edge all round
  (`edge`: fence, arena wall) with gaps only at `gates` (the `entries`); the plaza's edge is rows of houses with streets
  between them (`outside.rows`); `outside.ring` and `rings` put trees round the edge so the world goes on.

## Placement: where things go and what every seat reaches (`placement.js`, the gameplay layer, 2026-10-14)

Every world has one API for putting things in play, built from its own colliders (party and sea-islands, terrain,
voxel, scenic, flat seen from above and side-on; forge's pickups use the same grid over its boxes). Nothing that places
a thing assumes a flat floor at y = 0 or the play box: the creator, 2026-10-14, "We were supposed to collect berries,
but there were no berries anywhere. I think in the ocean I saw some boxes but those are impossible to get" (the pickup
part had put its spots at y = 0, sea level on island terrain).

```js
world.groundAt(x, z, below?)   // the ground's top (the highest surface at or under `below`), null where there is none
world.waterAt(x, z)            // the water's surface there, or null
world.isWalkable(x, z, y?)     // dry ground, room for the body, a slope it stands on
world.reach(from, to)          // {ok, why: 'in water' | 'under the ground' | 'walled off' | 'floating' | ...}; from: a point or a seat
world.place(kind, n, { zone, clear, gap, away, rng, near, exclude, prefer })   // [{x, y, z}] on open ground every seat reaches
world.route(from, to)          // the next point on the way ({jump: true} when the next step is a hop); world.via falls back to it
world.walk.audit(list)         // each objective against every seat (window.__game.objectives(): gate D, measure 6)
```

The model: columns of 0.5 m (coarser on a big world, at most 26,000); in each, the surfaces facing up a body fits on
(Rapier rays down, a body-sized cylinder a step up for the fit, probes for how high what pokes up beside it reaches).
Walking joins a surface to a neighbour's a step up (or a ramp's rise, 10° under the capsule's slope limit) or any way
down; a jump joins a place by a drop or a wall to one up to 82% of the jump's rise and reach, the arc clear. Routes are
cheapest first (a hop costs 4 m), so a walk always beats a hop that saves a step. Water is not walkable unless
`config/game.json` → `controller.swim`. The seats are the game's (`players.max` of the world's spawns). A terrain crater
or a voxel edit is read again where it changed. Launch pads (`pads.js`) are links the walk travels as a jump. Not
modelled: moving pieces, doors that open, the space under
an overhang within one collider (a ray meets each collider once). `tests/placement.test.mjs`.

The camera place finder (a look shot's `where`) is `world.lookout(where)`.

## Connectors: every area worth going to is reached (`connect.mjs`, `walk.mjs`, `pads.js`, the gameplay layer, 2026-10-14)

The creator, after the berry fix: "still some flags we talked about before, like making all area reachable". The
composed levels showed islands, a gatehouse on a hill and a mesa a player sees and cannot get to, and islands a bridge
led to that a player could never come back from. One rule for every world:

```js
world.walk.regions({ things, rims, backdrop })   // the ground the seats cannot get to, and the traps they cannot leave:
                                                 // [{at, area, core, box, things, gap: {from, to, across, rise, why}, trap?, on?}]
world.connectors                                 // {list: [{kind, at, ends, why, for}], kept, left, apart, backdrop}
window.__game.regions()                          // the same, with the seats, landmarks, set dressing and objectives as things
```

- **Regions** are places that get to each other (strongly connected over walking, drops and jumps; `walk.mjs`, the
  walk grid split out of `placement.js` so pure code builds one too). A **trap** is ground the seats get to (a drop)
  with no way back to them. Each has the nearest way across and why there is none: water, void (a drop), a cliff (higher
  than a jump), a wall, too far.
- **Worth going to** (`worthOf`): it holds an objective, a landmark, a seat or two pieces of set dressing, or it is
  room to play (24 m², 6 m² of it 1.2 m clear of its edges: a plateau, not a ribbon of beach). The tops of things (a
  wall, a stall: colliders tagged as props) and a bridge's own deck are not places.
- **The connectors**, cheapest first, by the gap and what the world and the look allow (`connectorsFor`): shallows (a
  sandbar between low shores), a ramp (ground laid over a short gap, or a slope cut into a cliff and built out from its
  foot, or along its face), a bridge (the level's bridge model when it has one, with earthen approaches onto its deck;
  else a land bridge of the ground itself), a launch pad (a pad at each end; stepping on one throws the body along a
  fixed arc to the other: `controller.carry`, the same on every copy). Each try that does not join its region is taken
  away and the next is tried. Ladders and climbable faces are not offered: no controller climbs yet.
- **Where they are made.** A terrain world makes them at generation in its distance field (`terrain/connect.mjs`),
  deterministic like the rest of the ground (same seed, same connectors on every copy), so they are standable, stop
  shots and are carved by blasts. Every world on the walk grid (party, voxel, flat, scenic, and what a terrain's ground
  could not join) gets launch pads the first time its grid is ready (`pads.js` `joinWithPads`, from `placement.js`),
  before anything is placed. A part that lets players make their own way (the build mechanic: `makesWay`) needs none.
- **Kept apart on purpose**: `config/world.json` → `reach` (spec `world.reach`): `{connect: false}` turns them off,
  `kinds` limits them to what the look allows, `apart: [{what, why}]` keeps a region apart with its reason (`what`:
  `'seats'` for seats on their own grounds, a thing's id, or `[x, z]`).
- **Backdrop** islands out at sea stand at least 30 m of water past the play ground (`sea.js` `BACKDROP_CLEAR`), and set
  dressing only stands where the seats get to and back from.
- **The gate**: measure 6's reach leg (`builder/tools/lib/reach-check.mjs`, `judgeAreas`) fails a world with a region
  worth going to that is neither reached nor kept apart, naming it, where and why. `tests/connect.test.mjs`.

## Places, colliders and reach (open builder wave 10)

- **`places/`, the vocabulary.** An outdoor place is a recipe: steps run in order over one seeded stream, each a word of
  one small vocabulary (ground `rect`, `island`; features `zones`, `spawns`, `gates`, `plaza`, `portal`, `paths`,
  `spawn-line`, `arena-zones`, `water`; structures `edge`, `rows`, `backdrop-ring`, `climb`, `islets`, `floaters`; sizing
  `stretch`, `grow`; dressing `place`, `put`, `pick`, `scatter`). `buildPlace(recipe, {size, seed, reach})`. A number may
  be per size or an expression over the place's quantities, the character's jump among them (`climb` refuses a rise past
  it at the call). `from-yard.js` turns an outdoor template into a recipe and `generate.js` builds arena, backyard and
  plaza through it; gf-scenic lays out each island level from its `recipes.js`. Both give the worlds they gave before,
  byte for byte (`tests/d-places.test.mjs`). Indoor worlds and dungeons are still their own generators.
- **`colliders.js`, one collider list.** `collidersOf(layout, catalog)` is every collider a world loader builds (party:
  the ground, each placement's catalog collider at its model's fit, the invisible walls; scenic: island tops and rims,
  dungeon floors and walls, props, trees, crystals, ruins), as data; `buildColliders` makes Rapier from it with each
  engine's `MATERIALS`. Both loaders build their physics this way, and `world.shapes` is the list.
- **`reach.js`, reach.** `reachOf(layout, colliders, movementOf(game))`: which spawns, zones and entries a body gets to
  by walking and by the jump `config/game.json` gives the character (82% of it, as the flat part), over the list. Check
  17 reports what it cannot reach as a **warning** (rule `reach`, named in the detail); `tools/places-reach.mjs` drives
  the jumps with the kit's capsule on Rapier. A scenic game carries `places/`, `colliders.js` and `layout.js` in its
  `gf/three/world/` (its world imports them as `../../three/world/…`).

## Templates (`templates/<id>.json`, 2–8 players)

| Id | What it is | Ground pattern | small / medium / large |
|---|---|---|---|
| `backyard` | fenced garden: striped lawn, slide, swings, sandbox, picnic corner, flower beds by the fence, houses and trees behind, a garden gate | `lawn-stripes` | 30 × 24, 40 × 32, 52 × 40 m |
| `office` | a closed office building on a city street: open floor with desk pods round an atrium, break room, meeting room (glass), lobby, manager's office, store room, lounge; doors to the street | `carpet-tiles` | 24 × 24 (3 rooms), 40 × 32 (6), 48 × 40 m (9) |
| `store` | a closed supermarket on a city street: aisles of stocked shelves round an open middle, freezers on the walls, checkouts and trolleys by the entrance; store room with a loading door, staff room, manager's office, cold room, bakery | `carpet-tiles` (read as floor tiles) | 24 × 24 (3 rooms), 40 × 32 (5), 48 × 40 m (7) |
| `plaza` | paved square: fountain ringed by benches and lanterns, market and café corners, townhouses all round with streets into the square | `paving-slabs` | 30 × 30, 40 × 36, 50 × 46 m |
| `sea-islands` | islands in an open sea: hills, shores, cut cliffs, beaches, islands on the horizon, puff clouds (generated from params) | the look's ground picture, else colour | 30 × 24, 40 × 32, 52 × 40 m play area |
| `arena` | candy party arena on a checkered pitch: trophy block with ramps, raised corner blocks, springs, hazards by the walls, open gateways | `arena-checker` | 28 × 28, 36 × 36, 46 × 46 m |

Every template at every size passes the set-dressing lint and the world check with no errors (`tests/d-worlds.test.mjs`);
the small layouts pass the lint with no warnings (`tests/l-dressing.test.mjs`):

```bash
node research/gf-three/tools/dressing.mjs plaza            # or office:medium, a game directory, or a layout file
node research/gf-three/tools/dressing.mjs <game> --svg plan.svg --json
node research/gf-three/tools/world.mjs office:large        # verify check 17: is the world complete? (or a game)
node research/gf-three/tools/world.mjs office:medium --layout out.json   # the generated layout
```

A layout is clean when nothing overlaps, floats or pokes through the edge; props stand along the edges and in groups,
with open floor in the middle; seats face a table, a centrepiece or the middle; spawns have a metre of clear floor; no
small loose thing lies in the open; and the ground has a pattern and contrast against the player colours. The rules
and their thresholds are in `tools/lib/dressing.mjs` (`RULES`, `T`); how the game looks is the look judge's
(`builder/look-judge`), on the contact sheet.

## Sea islands (`sea-islands`, `sea.js` + `islands.js`; looks wave 2)

Islands in an open sea: the play island's flat middle (the size class's play area, inside invisible walls) ringed by
hills in two or three groups, the land falling toward the shore between them, its edge rounding over into cut cliffs
(the ground's cross-section: a strata picture, slot `world.sea-islands.cliffs.pattern`, over coloured bands) with ledges
and a beach at the foot, more islands toward the horizon, puff clouds in a ring over the sea, and one sea disc of the
house water material. `params` (`SEA_PARAMS`: relief, cliff, terraces, beach, islands, clouds, cloudStyle, cloudColor,
density, dressing, ground, cliffs) come from the recipe, a spec's `world.params` or a look target
(`builder/look/world.mjs`). `heightAt(layout, x, z)` is the ground's height (the set-dressing lint and the sheet read it);
the hills that reach the play area are hull colliders. The terrain stream's destructible ground takes the same island
list when it lands (it owns the ground's mesh; `sea.js` owns where the land is and how high).

**A composed level** (`params.compose`, looks wave 4: `sea-compose.mjs`, with the framing maths of `compose.mjs` that
the terrain world's composer shares): the main landmark stands in the play area as ground (its placement's collider
`mesh`: the world builds a trimesh from the model's own triangles, so players stand on its walls and roofs), the
dressing keeps off its footprint, the seats come in pairs round it (or before it, `behind`) that see each other past it,
each with its yaw (`spawnYaw`: the partner and the landmark in the frame), and `landmarks` is what the camera leans
toward. Bridges are the terrain world's (here the play island is the one landmass players reach); a piece is never
carved here (the terrain world's pieces are).

## Layout JSON (what agents edit; `config/world.json` is a copy of a template plus the game's own props)

```jsonc
{ "template": "backyard", "size": [30, 24],
  "ground": { "kind": "grass", "color": "#86b84a", "color2": "#79ac43", "outer": "#80b452",   // world.<t>.ground.* colour slots
              "pattern": { "file": "assets/textures/lawn-stripes.png", "size": 4 } },          // world.<t>.ground.pattern: metres per tile
  "bounds": { "walls": true, "height": 4 },                                      // invisible walls at the edge
  "props":   [{ "prop": "slide", "at": [9.5, 0, -6.8], "rot": 55, "scale": 1 }], // rot: degrees about Y (or [x,y,z] degrees)
  "scatter": [{ "prop": "grass-tuft", "count": 34, "area": [-14.5, -11.5, 14.5, 11.5], "seed": 7, "clear": [[0, 3, 7]], "scale": [0.7, 1] }],
  "spawns":  [[0, 0, 8], ...],
  "zones":   { "centre": { "shape": "circle", "at": [0, 0, 2], "size": [2.5] }, "left": { "shape": "box", "at": [-7.5, 0, 0], "size": [15, 4, 24] } },
  "bench":   { "stage": [0, 0, 3], "facing": 0 } }                                // where the lookdev bench lines up four characters
```

- `prop` is an asset library id (a bare id resolves in the three runtime's packs, `runtimes/three/art.json`; or `<pack>/<id>`). Every prop is metres, Y up, base at y = 0, centred; `at` is where it stands.
  Seats (bench, chair, sofa) face +z at `rot` 0.
- `scatter` expands deterministically (seeded) at load: `expandLayout(cfg)` (in `layout.js`, pure, shared with the lint).
- `ground.kind` (`grass`, `paved`, `floor`) tells the lint where plants belong. `ground.pattern` is a seamless greyscale
  picture the house ground material multiplies over the ground colour in world space (`size` metres per tile): light is
  the ground colour, dark is grout or seams. The patterns are baked offline by `lookdev/tools/bake-patterns.mjs`
  into `library/textures/` (CC0); `create` copies the one a game uses to `assets/textures/`.
- **Drawing**: one `InstancedMesh` per (prop, mesh part), so a world is ~60–240 draw calls. Materials go through the
  look's `adoptMaterials` (props named in the catalog's `materials`, like a fountain's `Water`, take the water material).
- **Colliders**: from the catalog's `collider` (box, cylinder, sphere, ramp; `none` for decor), scaled and turned with the
  placement, built as fixed Rapier colliders when `ctx.physics` exists (a bare world, or K1's `{ RAPIER, world }`).
  Ground and walls are collision group WORLD, props PROPS (kit/character/RIG.md §6).
- **Swap anything**: each prop loads through its `prop.<id>` model slot (`ctx.assets.model`). A replacement in another
  unit is fitted to the catalog `size` (more than 1.5× off → rescaled), so an uploaded model drops into place.
- **Lamps**: catalog `light` points (lanterns, street lights, floor and desk lamps) go to `ctx.look.setLamps` for night.
- **Slots** (`slotsFor(cfg, catalog, licences)`): `world.<t>.ground.color|color2|outer`, `.pattern` (when the layout has
  one), `.layout`, `.spawns`, `.zones`, and one `prop.<id>` model slot per prop used, with its licence. Every mesh it
  draws is tagged with one of them.

## The prop catalog

`gf-three create` writes the asset library's entries the layout uses (builder/art/views.mjs propEntry, each with its
`ref`) to the game's `config/props.json` and copies their GLBs to `assets/models/<id>.glb`. `loadWorld` reads the catalog
from `ctx.assets.config('props')`, else `opts.catalog`, else `props.json` where `opts.library` serves the library.

Two catalog fields serve the lint (both are in the asset library: an asset's `use.real`, and `hosts` in its pack's sources.json):
`real: [min, max]`, the real thing's height in metres beside a 1.75 m adult (the lint has defaults by id and tag), and
`hosts: [ids]`, props that stand through this one by design (the parasol through the picnic table).
