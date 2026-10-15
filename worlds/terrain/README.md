# The terrain world (`worlds/terrain`, a game's `gf/three/world/terrain/`)

Smooth, rounded ground that explosions carve: islands in a sea or a cliff shore, a top surface (grass, sand, candy, ...),
cliffs of rock strata, and a soil cross-section that shows wherever a blast cuts the ground. It is a world part any three.js game can choose (the
look-world stream picks and shapes it from a look target); the carve mechanic (`components/carve`) makes the craters and
keeps every screen's ground the same.

`config/world.json` → `{ template: 'terrain', terrain: {...}, materials: {...}, sea: {...}, spawns: 8 }`. `create` writes
it from `default.json`, the spec's `world.params` and a seed from the title (`builder/tools/lib/spec-config.mjs`
`terrainWorld`): the params' `materials`, `sea`, `spawns` and `debris` keys go to those parts, every other key to the
generator.

| File | What it does |
|---|---|
| `field.mjs` | the field: signed distance on a box of samples (negative in the ground), `sample`, `normal`, `heightAt`, `raycast`; edits `[op, x, y, z, r]` in whole centimetres (`editOf`, `isEdit`), `apply(edit)` → the samples it changed, `chunksOf(box)` → the chunks to re-mesh |
| `generate.mjs` | the generators (`generateTerrain(params)`, version `GENERATOR`): `islands` (count, radius, spread, or a hand-placed `list`) and `cliffs` (a shore on one side, `terraces` steps); `land` sets height, rim, hills, cliff steepness, overhangs and tunnels; `spawnsOn(field, n, seed)` finds standing places |
| `mesh.mjs` | surface nets per 16-cell chunk (8 m at the default 0.5 m cell): one vertex per crossed cell, normals from the field's gradient (smooth across chunk seams), per vertex its depth under the ground's original top and how deep inside the original ground it is |
| `mesh-worker.js` | a copy of the field off the main thread: the first mesh, then each edit's chunks |
| `material.js` | the house `ground` material (the look's light, bands, fog) painted with the top picture where the ground faces up and was not cut, a lip of it down the cliff edges, the cliff picture (rock strata) on the faces the land was made with, the soil picture where a blast cut (both triplanar, their layers level), darker bands with depth, sand by the sea, an ink line where top meets the rest |
| `debris.js` | lumps of ground thrown from a crater, bouncing on the field (cosmetic, per copy) |
| `world.js` | `loadWorld(ctx, cfg)`: the kit's world API (spawn, zone, bounds, raycast, update) plus `world.terrain` and `world.seaLevel`; one Rapier trimesh collider per chunk, built from the drawn mesh |

## `world.terrain`

```js
const T = ctx.world.terrain;
T.apply(edit, { quiet })      // on this copy: field, mesh, collider, debris (none when quiet), listeners → changed?
T.editOf('carve', at, r)      // an edit from metres; T.carve(at, r) / T.add(at, r) apply one here
T.edits                       // every edit that changed the ground since it was made, in order
T.onEdit(fn)                  // fn({ edit, op, at, r, normal }) after each edit: VFX, sounds, rules
T.debris(at, r, { normal })   // throw lumps (apply does it for a carve)
T.reset()                     // the ground as it was made (a new round) → a promise
T.sample / normal / solid / heightAt / surface(from, dir, max)   the field itself
T.stats()                     // { chunks, triangles, edits, remeshMs, remeshMax, genMs, meshMs, worker, debris, pending }
```

Who may edit and how edits travel is the **carve** mechanic's: the host makes and numbers every edit, every copy applies
them in order on the same generated ground, a copy that misses some asks the host, a late joiner is sent the round's log,
a viewer's key frame carries it. Same seed + same `generator` + same edit list = the same field, bit for bit (only
`+ - * /` and `Math.sqrt` on Float32 storage). `window.__game.terrainHash()` hashes the field: two screens with the same
hash hold the same ground.

## A composed level (`terrain.compose`, looks wave 4)

The landmarks are the playfield: you fight on the fortress, across the bridge, around the castle. A look target says what
the play happens on (`world.composition`: its landmarks, `playOn` on / around / across / behind, bridges, verticality,
and the share of a gameplay frame the landmarks take); `builder/look/world.mjs` finds the pieces in the level's own set
dressing first and writes `terrain.compose` {landmarks, bridges, playOn, share, verticality, bridgeCount, camera, seats}.
A spec can write it too (`examples/minimal/tower-isles`). The world loads the pieces' models first, then:

| File | What it does |
|---|---|
| `compose.mjs` | the composer: the land's masses (`landMasses`; one mass that asks for a bridge gets a chasm cut across it, `cutChasm`); the main landmark on the main mass, scaled and its seats' distance chosen together so it takes the share asked with its top in the frame (the play camera leaning toward it), a level plaza at its foot; the other landmarks crown the other masses; bridges rim to rim at the narrowest place (stretched along their length, the higher rim cut down, never filled); the seats in pairs on level pads, each pair in sight of each other and of a landmark, each yaw facing the partner with the landmark in the frame (`worlds/compose.mjs framedYaw`); the pairs round the main landmark first |
| `connect.mjs` | the connectors (`../connect.mjs`'s rule, made in the field): after the land, the composer and the seats, every region worth going to that the seats cannot get to (or come back from) is joined: shallows, ramps (`layStrip`: a strip of ground laid over a gap, cut into a cliff and built out from its foot, or along its face), the level's bridge model (`compose.mjs` `spanBridge`, with earthen approaches onto its deck; the composer's own bridges get them too) or a land bridge, launch-pad discs (`../pads.js` stands the pads). Regions come from the walk grid over this field (`fieldSource`), the same model the game's placement reads from the colliders. `config/world.json` → `reach` turns them off, limits their kinds or keeps regions apart |
| `piece.mjs` | a mesh made ground: the exact distance to its triangles in a narrow band, inside or outside by ray parity on three axes (two of three votes), a thin part (a plank deck) thickened by a shell so it is walkable; joined into the field (the lower value wins) and its samples marked in an owner mask |

**Why the distance field, not breakable chunks.** The land already is a distance field whose edits every copy replays
from the host's log (the carve mechanic): made part of it, a landmark is standable (the chunks' trimesh colliders are its
shape), stops shots, is seen by the composer's sight lines, and is carved by the same edits on every screen, late joiners
included, with no new network message. Chunks would need their own split (a closed mesh cut into convex parts), their own
colliders and their own sync, and only ever break along their seams. What the field cannot keep is the model's detail, so
the model is still what is drawn: `world.js` clips it with a small 3D picture of the ground the field lost round it (updated
on each edit) and the terrain material draws the cut faces in the piece's inside colour (`own`, `setBuilt`), leaving the
piece's uncut surface to its model. The same seed, generator, pieces' triangles and edit list give the same field bit for
bit (a piece's yaw is turned by sines rounded to a millionth). Its cost: about 0.1 s a piece at load (12 k triangles).

`world.landmarks` ({id, prop, role, centre, box, top}) is what the camera leans toward (`kit/controller/camera-rig.js`,
`frame`: a few degrees toward a landmark in view, over the player's own yaw and pitch) and what the look judge's sheet
frames from the first seat; `world.composition` is the composer's report; `window.__game.landmarks()` says what each
landmark has lost (`tests/terrain-two-players.mjs --landmark`: both screens hold the same holes).

## Collision

Bodies, shots and the camera meet Rapier trimesh colliders made from the very mesh that is drawn (one per chunk,
replaced when the chunk is re-meshed), so what you see is what you stand on. The projectile mechanic's shots end on
them (and on the sea at y = 0, its floor). `T.surface()` is the same surface from the field, for code without physics.

## Speed (measured 2026-10-14: `evidence/terrain-2026-10-14.json`)

Default box 112 × 34 × 80 m at 0.5 m: about 2.6 M samples (10 MB), generated in 0.1 s, meshed on the worker in
0.13 s, about 95 k triangles in about 135 chunks. A crater of 2.6 m: the field edit 0.1–0.4 ms on the main thread, the
re-mesh 5–13 ms on the worker, each chunk's mesh and collider swapped in at most 1.4 ms (under a 4× CPU throttle: 1.1 ms,
22–25 ms, 4.1 ms). At 3840 × 2160 and at phone size the frame holds 60 fps on this machine's desktop GPU (render CPU
1–2.6 ms); no real phone has run it.

## Prior art and credits

Surface nets: S. F. F. Gibson, "Constrained elastic surface nets" (1998), in the naive form M. Lysenko describes
("Smooth voxel terrain", 2012); written here from those descriptions, no code taken. Noise and the worker pattern come
from the voxel world (`worlds/voxel`, credited there). The pictures are the kit's own (`library/packs/xk-terrain`, CC0,
drawn by `runtimes/three/tools/terrain-textures.mjs`).
