# Notes for the next core release (Rust)

The forge core ships as one prebuilt, hash-pinned wasm per build; agents building games never run cargo. What the
runtime contract still wants from the core, found while bringing forge onto it (2026-10-13). Each item says what the
JavaScript side does today in its place.

1. **A ray query.** `window.__game.controls().aim` needs what the crosshair is on. The core has no query, so
   `kit/observe.js aimOf` walks the world's collider boxes (config/world.json), the enemies' capsules (from the entity
   view) and the ground. It misses what the core alone knows: props without a box, the exact hurt regions, other
   players. Wanted: `ray(origin, dir, far) → {t, kind, net, part}` against the physics world and the hurtboxes.

2. **A stand-in body on a target dummy takes no hits.** With `animate(net, body, clips, {hurt: true})` the dummy's hit
   regions ride the body's bones. On the KayKit skeleton the open kit uses as a stand-in (`bodies/skeleton-grunt.glb`
   standing in for the generated chaser), six shots aimed at its chest landed no hit; the generated body took 4 hits
   and 2 kills from the same shots, and the same KayKit body as a wave's enemy is hit fine. Today a stand-in body keeps
   the dummy's own regions (`characters.json fight.targetHurt: false`, `kit/fight.js`). Worth a fixture in
   forge-feel: a dummy animated on each library body, shot at its torso.

3. **Stepped time without drawing.** `?gf-step=1` works on forge: a stepped frame ticks the core and skips
   `render()`. The core's own 120 Hz accumulator is fed 1/60 s per frame. Nothing to change; noted so a core change
   keeps `tick(dt)` deterministic for a fixed dt.

4. **Mechanics (2026-10-13: four run with no core change).** health, loot, pickup and waves have `impl/forge`
   (`components/<id>/impl/forge`, loaded by `kit/mechanics.js`), each passing its two-player fixture
   (`tools/fixture.mjs`; the records in `components/<id>/impl/forge/evidence/2026-10-13`). What they do in JavaScript that the core could own:
   - **A pickup the rules define.** pickup's spots and loot's potions are renderer instances (`host.instance`) the host
     moves and hides, with the touch test in JavaScript on the host's player places. Wanted: a core entity kind for a
     rule-defined pickup (`{model slot, at, radius, respawn}` → a `pickup` rule event with who took it), so a joiner's
     prediction, the snapshot and the drawing are the core's, as for weapon pickups (forge-feel weapons.rs `Pickups`).
   - **A tint that reaches a glowing model.** `host.tint` multiplies a model's colours; the kit's coin (the stand-in a
     pickup and a potion fall back to without a prop slot of their own) glows gold whatever the tint, so a potion drawn
     on the coin reads as a coin. Wanted: the tint applied to emissive colour too, or a stand-in potion model in the
     forge library.
   - **Health on another scale.** The core's health is the tables' (100); three's `hp` param is pips (3). The forge
     health implementation reads the tables and ignores `hp`; no core change needed, noted so nobody "fixes" it there.
