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
