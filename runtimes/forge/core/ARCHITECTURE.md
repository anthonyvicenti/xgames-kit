# gf-forge core: the architecture (wave 1b: the core game model, the four tracks, and how they meet)

The Rust half of the forge engine (research/rust-engine/PLAN.md §2): the shared foundation of wave 1a, the crates tracks R, F, A and S built on it, and (wave 1b, 2026-10-10) the places where they were joined. Each track owns one crate and plugs into `forge-core`. This file says where each extension point is and what it looks like. The JS half and the commands are in `gf-forge/README.md`; what the integration changed and what is still open is in `gf-forge/INTEGRATION.md`.

## Crates and owners

| Crate | Owner | What |
|---|---|---|
| `forge-core` | wave 1a, then track S | the ECS world on a fixed 120 Hz step, the schedule, the shared components, physics (rapier3d), events v1, the data tables, snapshot v2, live co-op (`net.rs`), the views, the fixture runner. No web code |
| `forge-anim` | wave 1a (shared by R and F) | glTF skins and clips from bytes, sampling, crossfades, an upper-body layer, additive per-bone springs, the gf-humanoid-1 bone map and retarget (rig.js's math), bone matrices as one flat array |
| `forge-feel` | track F | the first-person controller (replaces `core.move`), weapons, hits and reactions, kills into debris and coins, knock-downs, hurt and the low-health stages, the feel view |
| `forge-ai` | track A | six archetypes, the nav grid and flow fields, attack tokens, the wave director, bosses, bots, the AI view |
| `forge-play` | wave 1b | the plugin that joins feel and AI (`PlayPlugin`: `play.knocks`, `play.requests`, `play.replicas`), `install(core)` (feel, AI, play, in that order), and the native tests of the tracks together (`tests/together.rs`) |
| `forge-render` | track R | the wgpu renderer: models and GPU-skinned bodies (instanced), the first-person layer, the moon's shadow, point lights and flashes, the look stack (sky, fog, bloom, tone, retro), particles, hit flash and eye glow, emissive maps, hidden nodes and the player tint, the slot-ID pass and vertex capture for verify ("Rendering" below) |
| `forge-web` | wave 1a, then S; `render.rs` R; `glue.rs` wave 1b | the wasm exports `gf/forge/host.js` calls (each track's exports in its own module's `#[wasm_bindgen] impl Forge` block); `new_core()` calls `forge_play::install` |

Dependencies point one way: `forge-feel`, `forge-ai` → `forge-core` → `forge-anim`; `forge-play` → feel, AI; `forge-render` → `forge-anim` only (it knows neither feel nor AI); `forge-web` → all. `forge_core` re-exports `glam`, `hecs`, `rapier3d`, `serde_json` and `forge_anim`, so every crate uses the same versions.

## The step

- **120 Hz** (`forge_core::STEP` = 1/120 s, `HZ`). A 60 Hz frame runs exactly two steps (feel target 1).
- **Catch-up cap.** A frame owes at most `MAX_CATCHUP` = 100 ms (`MAX_STEPS` = 12); a longer stall drops the rest (`Core::dropped` counts it). A 126 ms stall advances exactly 100 ms.
- **Render interpolation.** At the start of every step each `Transform` copies `pos`/`rot` into `prev_pos`/`prev_rot` (`begin_step`). The views draw `alpha` = the leftover time / STEP of the way between them. `Transform::teleport` moves without interpolating.
- **Looking** is applied at the frame rate (the INPUT command), never held back to the next step.
- **A press counts once.** `Control::pressed` is latched until a step runs, then cleared after it.

`Core::tick(dt, words)`: apply the frame's commands → run the owed steps → fill the views → pack the events.

## The schedule and plugins (`schedule.rs`, `lib.rs`)

Every step runs six stages in order. A stage runs its systems in the order they were added. A system is `FnMut(&mut Sim)` with a name:

| Stage | For | The core's systems |
|---|---|---|
| `Input` | intent from commands and buttons | `net.inputs` (the host: one queued input per joiner's player), `net.record` (a joiner: this step's input), `core.held` (the weapon in hand) |
| `Feel` | the player's controller, weapons, hits (F) | `core.move` |
| `Ai` | enemies, the wave director (A) | — |
| `Physics` | characters and the rapier step | `core.character`, `core.physics` |
| `Post` | what follows from where things are | `core.walk`, `core.lifetime`, `core.replicas`, `core.anim`, `core.hurtboxes`, `net.predict` (last: a joiner's prediction after this step) |
| `Events` | turning this step's events into more (a hit → a flash, a sound, a kick) | — |

Despawns queued with `sim.despawn(e)` run after each stage.

**A plugin** (`forge_core::Plugin`: `name()`, `install(&mut Core)`) is how a crate plugs in. In `install` it may:

| Way in | Call | Example in the stubs |
|---|---|---|
| a system | `core.schedule.add(Stage::Feel, "feel.weapons", f)`; `add_before` / `add_after("core.character", …)`; `replace("core.move", f)` (F swaps the basic walk for its controller); `remove`; `set_enabled` | `feel.example`, `feel.hits`, `ai.example` |
| its own components | any `Send + Sync + 'static` type, inserted on entities | `FeelState`, `Brain` |
| its own state | `sim.res.entry::<T>()`, `get`, `get_mut`, `insert`, `take` (a type map) | `Arsenal`, `Roster`, `Ping` |
| a command | `core.on_command(op, "feel.fire", |sim, record| …)` in its op range | `OP_PING` (64), `OP_SPAWN` (96) |
| the tables | `core.on_tables("feel.weapons", |sim| …)`: runs at every load; parse `sim.tables.weapons` rows into its own types | `Arsenal`, `Roster` |
| events | `sim.emit(Event::…)`; read `sim.events.step_events()` from a later stage; its own kinds as `Event::Custom` | `feel.hits` turns a HIT into a LIGHT |

`forge-web` installs the feel, AI and play plugins at `create` (`forge_play::install`); a fixture runner installs what it measures. `core.systems()` lists the schedule (`forge.systems()` in JS).

**What the plugins did to the core's own systems** (wave 1b's schedule): forge-feel replaces `core.move` with its controller and turns `core.held` off (its `Arms::current` writes `Wear::held`); forge-ai replaces `core.anim` with the same system evaluating enemies' poses every other step; forge-play adds `play.knocks` before `feel.push` (an enemy's knock, forge-ai's event 41, lays the player down through `forge_feel::controller::knock`), `play.requests` after `feel.debris` (forge-feel's knock of an enemy, event 35, becomes forge-ai's knock-down request) and `play.replicas` before `core.anim` (a joiner's replica enemies play their row's clip for the state byte the snapshot carries).

**Reserved numbers** (so tracks never collide):

| What | Core | F | A | S | R |
|---|---|---|---|---|---|
| command ops (`cmd`) | 1..=63 | 64..=95 | 96..=127 | 128..=159 | 160..=191 |
| event kinds (`events`) | 1..=31 | 32..=39 | 40..=47 | 48..=55 | 56..=63 |
| entity kinds (`components::kind`) | 1..=15 | 16..=31 by agreement | | | |
| collision groups | bits 0..=5 | bits 8..=15 | bits 16..=23 | | |

## Shared components (`components.rs`)

The only hecs components forge-core defines; every other crate defines its own.

| Component | What |
|---|---|
| `Transform` | `pos`, `rot`, `scale`, and `prev_pos`/`prev_rot` for interpolation |
| `Velocity` | `linear`, `angular` (for a character: what it wants this step; the controller writes back what happened) |
| `Player` | `id` (1..=255: the seat + 1 on every copy), `local`, `owned` (simulated here: on the host every player, each joiner's from its inputs (owned, not local); on a joiner only its own) |
| `Look`, `Control` | a player's view angles; its stick and buttons (`held`, `pressed`, `enabled`) |
| `Health` | `hp`, `max`, `armor` (soaks first), `dead`, `invulnerable` seconds, `last_hit_by` |
| `Team` | `PLAYERS`, `ENEMIES`, `NEUTRAL` |
| `Kind` | `kind` (`kind::PLAYER`, `ENEMY`, `PROJECTILE`, `DEBRIS`, `PICKUP`, `PROP`) and `type_` (its table row) |
| `NetId` | the id across the boundary and the network: a player's id, else 256..=65535 (`sim.new_net_id`) |
| `Lifetime` | seconds until `core.lifetime` despawns it |
| `Hurtbox`, `HurtRegion`, `Part` | capsules on bones (`bone`, ends `a`/`b` in the bone's frame, `radius`, `damage` multiplier, `crit`), placed in the world every step (`world`); `Part` is the gf-humanoid-1 ragdoll part a hit names |
| `Replica` | shown from the host's snapshots on a joiner; `core.replicas` moves it, nothing else may simulate it (`.without::<&Replica>()`); `Sim::damage` on one deals nothing (the host decides) |
| `Wear` | what a player's body wears and holds (track S sets it, track R draws it): `tint` (linear), `body` (its slot index), `held` (the weapons row in hand, `HELD_NONE` 255; forge-feel's weapon switching writes it, snapshots carry it), `hidden` (this copy's own first-person player) |
| `Local` | wave 1b: an entity each copy makes for itself (a kill's pieces, a coin's picture, a round in flight): its net id is at or above `sim::LOCAL_NET_ID` (32768; `spawn_local`), no snapshot carries it and no joiner drops it as "the host does not have it" |
| `Reacts` | wave 1b: the entity plays its own hit reactions (forge-ai's enemies), so forge-feel's flinch leaves it alone |

Plus, from other modules: `physics::Body` (rapier handles), `physics::Mover` (a character's controller state), `sim::Walker` (the core walk's state), `sim::Animated` (an animator and its bone range), `snapshot::SnapByte` (one byte of plugin state a snapshot carries per entity).

## Sim (`sim.rs`): what every system gets

`world` (hecs), `physics`, `events`, `tables`, `names`, `res`, `time` (`step`, `now`, `dt`), `rng` (seeded xorshift: `f32`, `range`, `cone`), `anim` (`library`, `poses`), `camera` (`CameraRig`: offset, pitch, yaw, roll, fov_add: F writes it, the camera view adds it), `players` (id → entity), `floor_limit`.

Shared operations, so every crate does them the same way:

- `spawn_player(id, feet, yaw, local, owned)` · `spawn_actor(kind, type, pos, yaw)` (a fresh net id, a SPAWN event) · `spawn_local(kind, type, pos, yaw)` (this copy's own: `Local`) · `add_character(e, radius, height, group)` · `animate(e, body, clips, hurt_group)` (with a group: the body's ragdoll-part hurtbox on its bones)
- `despawn(e)` (deferred) · `despawn_now(e)` (its body leaves physics, its net id is freed, a DESPAWN event) · `teleport(e, pos)`
- `damage(target, amount, attacker, hit, dir)` → `Dealt {damage, killed}`: armour first, HIT, then KILL once
- `trace(origin, dir, max, groups, exclude)` → `TraceHit {entity, net, dist, point, normal, part, region, damage, crit}`: the nearest of the world, bodies without hurtboxes (rapier) and every hurt region (`hurtbox::ray_capsule`)
- `sound(name, pos, gain_db, source)` · `rule(name, entity, a, b, c, d)` · `emit(event)` · `entity_of(net)` · `net_of(e)` · `bones_of(e)`

## Physics (`physics.rs`)

rapier3d 0.36.0 (Apache-2.0, pinned; it does its math in glam 0.33, our glam). `Physics::world` is rapier's whole `PhysicsWorld` (bodies, colliders, joints) for what this layer lacks, such as a ragdoll's joints.

- **Groups** (`groups`): `WORLD`, `PLAYER`, `ENEMY`, `DEBRIS`, `PROJECTILE`, `TRIGGER`; `filter_of(group)` says what a member touches; `CHARACTER_BLOCKS` = world, players and enemies (a character pushes through debris).
- **Static world:** `add_box(min, max)`, `add_mesh(vertices, triangles)`, `clear_static()`; the ADD_BOX command and `forge.add_static_mesh` from JS.
- **Bodies added between steps** (a joiner's replica from `apply`): `refresh()` runs rapier's collision pipeline, which consumes a new body's insertion without giving it an island, so `step()` touches every body inserted since the last step first (else rapier 0.36 asserts "has no island" in debug, and misses a step in release). `place()` never wakes a kinematic body.
- **Characters:** `add_character(e, feet, &Mover, group)` makes a kinematic capsule; `move_character(body, mover, feet, desired, dt, snap)` → `CharacterMove {translation, grounded, sliding, ceiling, wall, ground_normal}` through rapier's controller: slides along walls, steps up to `step_height` (autostep), holds slopes up to `slope_max`, snaps down by `snap`. `core.character` does this for every `Mover` each step from `Velocity × STEP + Mover::nudge`. Rapier's controller now and then refused a whole step along flat ground (only the floor touched inside its 1 cm skin: about one step in 70 at a full walk, a 65 mm hitch, and a step a joiner's prediction and the host's replay disagreed on); `core.character` then moves again from 12 mm up (track S, `kcc_probe` in lib.rs: 4 refused steps in 300 before, none after).
- **Dynamic bodies** (debris, ragdoll pieces): `add_dynamic(e, Shape, pos, rot, linvel, angvel, group, density)`; `core.physics` writes their pose into `Transform`. They report contacts: `physics.contacts` (`Contact {a, b, groups_a, groups_b, speed}`) holds those that started in the last step. `impulse`, `place`, `set_kinematic`, `state`, `remove`.
- **Queries** (`QueryMask {hits, exclude, exclude_body, sensors}`): `cast_ray`, `cast_ray_all` (nearest first), `cast_shape` (a ball, box or capsule swept), `overlap_ball`. A hit names its entity (colliders carry the hecs entity's bits).
- Measured natively (release, `cargo test --release -p forge-core -- --ignored debris_burst`): 50 debris pieces among 20 enemies spawn in 0.05 ms, and a step takes 0.04 ms on average, 0.25 ms at worst (the step their contacts start). The feel target's budget is 2 ms; wasm on a phone is not measured.

## The crowd (`crowd.rs`; wave 3, track M)

Rapier's character controller was 85 to 92% of a step with a wave packed round a player: for every body it touches it builds contact manifolds, sweeps its capsule up to twenty times, and lets every kinematic body it touches push and drag it as a moving platform would. A crowd is all touching. So a **member of a crowd** (`Mover::crowd`: forge-ai sets it on every enemy whose row has no `climb`) walks flat ground by `crowd::walk` instead, and `core.character` keeps the controller for everything else.

- **Order.** `core.character` first moves everyone who is not of a crowd (players, bots, climbers) through the controller, as before, then the crowd one after another. Each member sees where everyone before it now stands (the controller saw everyone where the last step left them), so two members never step into the same gap.
- **Other characters are discs** (their capsules from above, `SKIN` 1 cm apart, heights compared so a player in the air above a head is not in the way). A member's move is swept against them and slides round them, at most three times a step. Nobody is pushed: a member stops at a body, and forge-ai's own separation spreads a crowd out. A member that overlaps a body (a joiner's word moved a player into it) backs out 1 cm a step.
- **The world is one sweep** of its capsule with the foot lifted 12 cm (`Physics::sweep_world`: nothing allocated), and one more along the wall it meets. **The ground is one ray.**
- **Anything else is the controller's:** in the air, on a slope, at a step or a ledge's edge, no ground under it. `walk` returns `None` and the member goes through rapier for that step.
- **A crowd's bodies carry no velocity** (`Physics::set_still`, also for a joiner's copies of enemies in `core.replicas`). The controller treats a kinematic body it touches as a platform: one that walks into a player pushes it, and one that backs away *draws the player after it* (an enemy stepping back from its lunge pulled the player 17 cm). A player is now stopped by an enemy's body and never moved by one; a knock is forge-feel's own shove (a PUSH event both copies play). What changed with it: a lunge no longer shoves the player the 6 cm it used to.
- **Measured** (native, release, `fixtures/ai/packed.json`: Bone Vigil's largest wave as four players meet it, 22 alive, closing on one player): `core.character` 212 µs a packed step before, 9.7 to 13.5 µs after; `crowd30.json` 249 → 27 to 49 µs. Every AI fixture target is met as it stood (`tokens`: the last of eight still gets its turn; `chaser`: stops at the body at 0.66 m, steps back 0.19 m). In the packed fixture the crowd lands more hits than it did (338 → 364 to 403 damage in 14 s): turns pass round faster when nobody is dragged about. The browser's numbers are in `gf-forge/evidence/wave3-M-2026-10-10/`.

## The core walk (`systems.rs`)

`core.move` reads the player table: top speed `walk` in every direction, an exponential approach (`accelTime` to 90%, `stopTime` to under 10%; `airControl` of it in the air), a jump with coyote time and a buffer, gravity integrated exactly over the step (`Mover::nudge`). `core.walk` emits footsteps every `stepEvery` metres, a landing, a bump into a wall, a fall below `floor_limit` (back to spawn), each a MOTION event and, for steps, jumps and landings, a SOUND by the table's name. Track F replaces `core.move`; `core.character` stays underneath.

## Events v1 (`events.rs`)

Typed in Rust (`Event::Hit(Hit {…})`, …), packed for JS as 16 u32 words: word 0 the kind, 1..=14 the payload (floats as bits), 15 the flags (`FLAG_REMOTE`: re-emitted from a snapshot). At most 1024 a tick (the oldest go first; `dropped` counts them).

| Kind | Payload |
|---|---|
| 1 HIT | attacker, target (net ids), part, point xyz, normal xyz, damage, crit, region |
| 2 KILL | attacker, target, part, point xyz, dir xyz, damage |
| 3 SPAWN / 4 DESPAWN | id, kind, type (+ pos xyz, yaw) |
| 5 SOUND | name (a `Names` id: an assets.json sound), source, pos xyz, gain dB, rate |
| 6 LIGHT | source, pos xyz, colour rgb (linear), radius, intensity, frames |
| 7 PARTICLES | name, count, pos xyz, dir xyz, speed, spread |
| 8 CAMERA | player, kick pitch °, kick yaw °, fov punch °, fov time, shake m, shake time |
| 9 UI | what (1 damage number, 2 combo), player, pos xyz, value, crit, count, multiplier, seconds |
| 10 RULE | name, entity, a, b, c, d (for rules.js) |
| 11 MOTION | what (step, jump, land, fell, bump, evade), player, pos xyz, speed, air time |
| 12 PUSH | wave 2: player, seq (the player's own input step it starts at; 0: now), vel xyz (y: a hop), seconds, down (seconds without control): a shove or a knock-down; a snapshot carries it ("The run", below) |
| 32..=63 | `Event::Custom`: a plugin's own (ranges above) |

Strings travel as numbers: `sim.names.id("shot")`; JS reads `forge.name(i)` (the list only grows). Every sound name in the tables gets its id at load. **JS routing** (`host.route(ctx, rules)`, every frame): SOUND → `ctx.audio.play(name, {gainDb, at})` (the local player's own at full level, anyone else's at its place); RULE → `rules.event(ctx, name, {entity, a, b, c, d, remote}, 'forge')`; every event → `host.on(kind, fn)` listeners (the renderer's flashes and particles, the HUD's numbers). The host's events go to joiners in the snapshot (HIT, KILL, SOUND, LIGHT, PARTICLES, RULE, DESPAWN of a shared entity; `events::replicated`).

**Early events** (wave 1b). An event pushed between steps (a snapshot's, re-emitted by `apply` with `FLAG_REMOTE`; a command's) used to be seen by no system: `step_events()` only holds what the running step emitted. `events.early_events()` gives a step those events with their flags, for exactly one step (`begin_step` takes them, `end_step` drops them). It is how a joiner's forge-feel turns the host's HIT and KILL into its own damage number, combo and pieces.

## Views (`views.rs`)

Flat f32 arrays, structure-of-arrays (field `f` of row `i` at `f × capacity + i`), interpolated, refilled every tick:

- `players`: 16 fields × 8 (`views::player`: id, x y z, yaw, pitch, vx vy vz, grounded, local, speed, hp, hp max, armour, alive; wave 0's first 12 kept their places).
- `entities`: 16 fields × 2048 (`views::entity`: net id, kind, type, x y z, quaternion, scale, hp share, flags (dead, replica, grounded, animated), bone base, bone count, speed): every entity with a net id, players too.
- `camera`: 16 floats (`views::camera`: eye xyz, yaw, pitch, alpha, fov, roll, player): the local player's eyes plus the `CameraRig`.
- the bone palette: `sim.anim.poses` (below).

## The data tables (`tables.rs`; the kit's `gf-forge/kit/tables/`)

`spec.forge` = `{player, physics, deal, weapons[], enemies[], waves[], cards[]}`. The schema, defaults, checker, slots and sounds are the kit's, one field declaration each (`fields.js`: `num(default, min, max, unit, label, describe, tier)`, `int`, `bool`, `color`, `choice`, `sound(default, preset)`, `ref(table)`, `obj`, `list`, `id`). Owners: `player.js` (the core; F for evade, stamina, bob, hurt), `weapons.js` and `cards.js` (F), `enemies.js` and `waves.js` (A). `create` refuses a spec whose values the core can't do (a range, an unknown field, a kind, a wave naming a missing enemy), writes the filled tables to `config/game.json → forge` (every value a slot: `forge.player.walk`, `forge.weapons.<id>.damage`, …), declares every sound they name in `assets.json`, and the boot hands them to the core (`forge.load_tables(json)`, again when Studio changes one).

Rows start from their kind or preset (weapons: `pistol`, `shotgun`, `repeater`, `blade`, numbers from feel-targets moments 8-11), archetype (enemies: chaser, runner, caster, shield, brute) or rarity (cards), then the row's own values.

In Rust the core types only what it reads (`PlayerTable`, `PhysicsTable`); every other table is `Vec<Row>` (a JSON object with `num`, `int`, `bool`, `str`, `color` (→ linear RGB), `row`, `rows`, dotted paths). A plugin parses its rows in an `on_tables` hook. **To add a field:** declare it in the owner's kit file (default, range, label), read it from the row in your crate, run `node gf-forge/tools/tables.mjs --write` (forge-core's test holds `PlayerTable::default` to `kit/tables/defaults.json`).

## Animation (`forge-anim`)

- `Library::add_body(glb)` → a `Body`: every skin's joints parents first (`joints`, `skins[i]` = a skin's joints as indices), inverse bind matrices, the bind pose in character space recovered from the hips (rig.js `bindPose`), the rest pose made consistent with it (`poseToBind`), the bind-pose box (ground, height), `gf_body` extras (`gfSpineBend`, `gfFingers`).
- `Library::add_clips(glb)` → a `ClipSet`: the file's node tree and clips (`Clip::sample(t, pose)`: step, linear (slerp), cubic), `gfClips` metadata (loop, layer, speed, impact), and `standard` when it is a gf-humanoid-1 clip file (identity rest rotations; rest positions, `gfGround`, hip height).
- `Library::animator(body, clips)` → an `Animator`: through `Retarget` (rig.js `createRetarget`: swings, inherited swings, finger alignment, the palm-first finger shift, spine bend, the hips scaled by straight-leg reach) when the clips are standard, else by bone name. `play(lib, name, Play {fade, layer, looping, rate, restart, hold})`, `stop(layer)`, `impulse(joint, spin, omega, zeta)` (an additive damped spring per bone: a hit's flinch), `advance(dt)`, `evaluate(lib, &mut PoseBuffer, base)`, `finished`.
- `PoseBuffer`: `world` (each joint in model space) and `skin` (world × inverse bind, per the glTF spec, before the model's own placement), one flat array for every animated entity; `world_floats()` / `skin_floats()` are what JS and the renderer read (16 floats a joint, column-major). In the core, `core.anim` lays out every `Animated` entity's range (`base`, `count`, also in the entities view) each step, in entity order.
- `humanoid`: the gf-humanoid-1 table (54 bones, canonical parents, required bones), `SWING`, `inherits`, `finger_of`, `upper` (the overlay mask), `SOCKETS`, `RAGDOLL` (the 11 parts `components::Part` names; `hurtbox::humanoid_regions(body, group)` puts a capsule on each).
- **It matches rig.js:** `node gf-forge/tools/anim-fixture.mjs` poses four library bodies (a bean, a Quaternius body with palm-first fingers, a Meshy body, a KayKit skeleton) through seven clips with the kit's own rig.js; `cargo test -p forge-anim --test rig_js` poses them with forge-anim: 833 bone poses, at worst 0.16 mm and 0.0012 rad apart (2026-10-09). The fixture is outside git (~/.cache/gf-forge/anim-fixture); without it the test says so and passes.
- Not here: GPU skinning (forge-render, "Rendering" below: it builds its own palette from `world`), IK, root motion, ragdoll blending (F).
- **`PoseBuffer::skin` is not a drawing palette for every body.** It keeps one inverse bind matrix per joint (the first skin's), but a body's skins may each carry their own (KayKit: one skin per piece, each in its piece's bind space), so skinning with it draws such a body in pieces. The renderer skins per skin (`world × that skin's inverse bind`, `Scene::push_palette`); anything else that skins vertices should do the same.

## Snapshot v2 (`snapshot.rs`)

`core.snapshot()` → at most `MAX_BYTES` = 2600 bytes (3468 base64 characters: under the live standard's 3.5 KB `net.world` with its JSON; `host.snapshotB64()`), quantized, little endian: a 17-byte header (`GF`, version 2, flags: actors cut, events cut; the host's step; the step of the snapshot before; counts; how many events are repeats), players (23 bytes: id, position at 1/64 m, yaw, pitch, velocity at 0.25 m/s, grounded and alive, health share, armour, a plugin byte, the weapons row in hand, the last input step of theirs the host applied (`ack`)), actors (14 bytes: net id, kind, type, position, yaw, health share, dead, a plugin byte), the names its events use (as strings: each copy has its own `Names`), then the previous snapshot's events again and the new ones (HIT 15 B, KILL 15, DESPAWN 4, SOUND 11, LIGHT 15 with its source, PARTICLES 13, RULE 20). Players always go; the new events take at most 900 bytes (the newest kept) and the repeats 400; actors fill the rest, the longest unsent first, then the nearest a player.

`core.apply(bytes)` on a joiner: a snapshot at or before one already applied is ignored (`snapshots.stale`); players it does not simulate and every actor become `Replica`s moving between the last two samples (`core.replicas`), new ones SPAWN and missing ones (in a complete snapshot) DESPAWN; the repeated events are played only when the snapshot that first carried them was missed (two arriving in one frame: the page sees only the newest); the events are emitted here with `FLAG_REMOTE`, except what this joiner already played for its own player (live co-op, below); its own player is reconciled (`net::reconcile`) and takes the host's health.

## Live co-op (`net.rs`; track S)

`NetState` (in `sim.res`) holds this copy's role, set from JS with `Core::net_role(Role, local, epoch)` (forge-web `net_role`): `Solo` (nothing here runs), `Host`, `Joiner` (the event queue for snapshots is off: `events.authority`).

- **A joiner** records every fixed step's input of its own player under the step's number (`net.record`, Input stage first: the stick, the look (absolute), held, pressed, enabled, a teleport its own TELEPORT made) and where the step left it (`net.predict`, Post stage last). `net_take_inputs()` encodes the steps since the last call as one batch (`epoch`, the first step, then 11 bytes a step, +16 with a teleport); JS sends it to the host about 20 times a second.
- **The host** queues each joiner's batches per player (`net_push_inputs(id, bytes)`; repeats and older steps dropped, a new epoch starts the queue again) and `net.inputs` (Input stage, first) plays one per step into that player's `Control` and `Look` after a 3-step jitter buffer, repeats the last when the queue runs dry (idle after 30 steps), folds the oldest in past 24 waiting, and keeps the last step applied (`ack`), which the snapshot sends with the player.
- **Reconciliation** (`reconcile`, from `apply`): the host's position at `ack` against the joiner's prediction for that step. Over 3 cm (height differences under 6 cm are rounding: moving a grounded character by one would put it in the controller's skin) the present and every later prediction move by the difference; the camera view adds `smooth`, decaying over ~0.1 s, so the screen does not jump; over 2 m it snaps. A velocity difference over 1 m/s is added (a knock on the host). Counts: `net_stats()`.
- **Not played twice:** `apply` skips the host's SOUND and LIGHT events whose `source` is the joiner's own player, and PARTICLES of the same name within 1 m of ones the joiner drew in the last 0.6 s (`saw_fx` from `tick`). **So a plugin that makes a player's sound or light gives it that player's id as `source`.**
- Tests (`snapshot.rs`): a host and a joiner in one process walk, strafe and stay within 5 cm over 260 frames with 3-frame input batches and 6-frame snapshots; a knock (a 6 m move on the host) is reconciled; the host's sound of the joiner's own shot is not played twice; a missed snapshot's events come with the next one, once.
- **A viewer** (wave 4, track V: watch then play, CONTRACT §9b; `Role::Viewer`, 3; `net_role('viewer')` in `kit/host.js`). A copy with no player of its own: every player is the host's `Replica`, nothing is predicted, recorded, sent or reconciled, no event of the host's is skipped (it made none itself), and `events.authority` is off. `NetState::follows()` is true for a joiner and a viewer (what asks "does the host decide here?"); `is_viewer()` for the viewer alone.
  - **Whose eyes.** `Core::net_watch(id)` (forge-web `net_watch`) names the player it looks through; the `net.watch` system (Input stage) marks that replica `Player.local = true` with `owned = false`. The camera view, the feel view, the hidden body and the HUD's own player then follow it with no code of their own. **So a system that acts for this copy's own player asks `local && owned`** (the coin sound, the hurt sounds, a death's rule event); `local` alone means "the player this screen is about".
  - **Their look.** A replica keeps the pitch of its last two snapshots (`Replica::from_pitch/to_pitch`, `pitch_at`); the camera's yaw is the interpolated body's (`snapshot::yaw_of_rot`). Measured in three browsers: the view is about 460 ms behind the streamer's (the kit replays the stream 300 ms late), eyes within 0.01 m and the look about 1° at the median once shifted by that.
  - **Their hands.** One byte a player in the snapshot (the player's state byte, forge-feel `watch.rs`): shots fired (3 bits), reloading, a swing (held or quick) and its flip. The host writes it in `feel.acts`; a viewer replays it onto the watched replica's `Arms` in `feel.watch`, so the weapon in view kicks, reloads and swings. A tracer is drawn for a shot that hit (from the host's HIT, muzzle to the hit); a miss leaves none, and the rounds left in the weapon are not sent (the HUD shows no count).
  - Tests: `snapshot.rs` `a_viewer_looks_through_a_replicas_eyes_and_plays_everything_the_host_sends`; forge-feel `watch.rs`; forge-play `together.rs` `a_viewer_sees_the_watched_players_fight_through_their_eyes` and `bone_vigils_largest_wave_with_four_players_fits_the_room_and_the_streams_relay` (the largest snapshot 1,093 bytes against the room's 4,096 and the relay's 8,000 characters a message). In browsers: verify check 34 and `tools/live.mjs`.

## Fixtures (`fixture.rs`, `examples/`)

Scripted input through the real core, headless, with a trace of every step and measures against targets:

```bash
cargo run -p forge-core --example fixture -- gf-forge/fixtures/core/walk.json [--trace] [--json] [--tables <game>/config/game.json]
cargo run -p forge-feel --example feel-fixture -- gf-forge/fixtures/feel/<x>.json     # with F's plugin
cargo run -p forge-ai --example ai-fixture -- gf-forge/fixtures/ai/<x>.json           # with A's plugin
node gf-forge/tools/fixtures.mjs [core|feel|ai]                                       # every fixture, exit 1 on a miss
```

A script: `tables` (over the defaults), `boxes` (default: a 200 m floor), `spawn`, `yaw`, `frame` (the host's frame, default 1/60), `script` (segments: `for` seconds, `move` [x, z], `hold` / `press` buttons, `look`, `mark`, a segment's own `frame` for a stall), `measure` (each `what`: `speed`, `time_to_speed`, `time_to_below`, `apex`, `apex_time`, `air_time`, `distance`, `sim_time`, `events`, `interval`; times from marks like `"go+1.0"`; `target` [lo, hi]). `forge_core::fixture::run(core, script, tables)` returns the `Trace` and the measures, for a plugin's own runner or tests (`the_core_fixtures_meet_their_targets` runs fixtures/core in `cargo test`).

The core's walk against research/rust-engine/feel-targets.md (2026-10-09, `node gf-forge/tools/fixtures.mjs core`):

| Measure | Core | Target |
|---|---|---|
| walk and strafe speed | 7.80 m/s | 7.8-8.0 |
| time to 90% of walk | 0.100 s | about 0.1 |
| time to 7.1 m/s | 0.108 s | 7.1 by about 0.09 (strafe) |
| time to under 10% / under 1 m/s after release | 0.092 / 0.083 s | about 0.085, within 0.085-0.1 |
| footstep interval | 0.288 s | 0.28 |
| jump apex / time to apex / air time | 1.134 m / 0.325 s / 0.642 s | 1.18 m (at the eyes) / 0.32 / 0.65 |
| sim time in a 126 ms frame / in 60 frames | 0.100 / 1.000 s | exactly 0.1 / two steps a frame |

The approach is one exponential: it reaches 90% on time, but the reference's first frames are quicker (5.3 m/s at 27 ms against the core's 3.6). Track F's controller owns that curve.

## The web boundary (`forge-web`, `kit/host.js`)

`create(canvas)` (the core with the feel, AI and play plugins: `forge_play::install`) → `net_role(role, local, epoch)` / `net_take_inputs` / `net_push_inputs(player, bytes)` / `net_stats` / `snapshot_bytes` / `set_wear(net, r, g, b, body, hidden)` / `wear(net)` / `clear_line(x0, y0, z0, x1, y1, z1)` (track S) / `cmd_ptr` / `tick(dt, words)` / `views_ptr` / `entities_ptr` / `camera_ptr` / `events_ptr` + `events_count` / `bones_ptr` / `skins_ptr` / `bones_len` / `names_count` + `name(i)` / `load_tables(json)` / `snapshot` / `apply` / `add_static_mesh` / `add_anim_body` / `add_anim_clips` / `animate(net, body, clips, hurt)` / `anim_play(net, clip, fade, layer, loop)` / `plugins` / `systems` / `steps` / `step_hz` / `dropped_seconds`, plus wave 0's scene, readback and device-loss calls. `host.js` wraps them: `loadTables`, `cmd.input({mx, mz, dx, dy, held, pressed})` (BTN bits: jump, fire, alt, melee, evade, reload, interact, next, prev, slot 1-4, crouch), `cmd.damage`, `cmd.raw(op, ints, floats)`, `players()`, `entities()`, `bones(skin)`, `eye()`, `decodedEvents()`, `route(ctx, rules)`, `on(kind, fn)`, `snapshotB64` / `applyB64`, `animBody` / `animClips` / `animate` / `animPlay`. The boot (`gf/three/core/boot-forge.js`) maps the input: primary fires, secondary is the alternate fire, interact, jump; Shift evades, R reloads, V is a quick melee, 1-4 and the wheel pick a weapon. Track F's exports (`feel_view`, `feel_view_names`, `feel_stats`, `feel_recap`, `feel_protocol`: `forge-web/src/feel.rs`) and track A's (`ai_view_ptr` and its sizes, `ai_director`, `ai_boss`, `ai_bots`, `ai_nav`, `ai_archetypes`, `ai_profile`: `forge-web/src/ai.rs`) live in their own modules. Track R's live in `forge-web/src/render.rs` (wrapped by `kit/render.js`; "Rendering" below), with wave 1b's: `draws_bodies()` (true: `players.js` and `ai.js` give every body to the renderer), `entity_model(class, type, model, slot, fit, spin, bob)` / `entity_models_clear()` (a rigid model for every entity of a kind and type: debris pieces, the coin, pickups, a caster's orb as class 100), `fp_auto(on)` (the first-person layer follows the feel view; off: the host poses it, as the lookdev does), `fp_blade(model, slot)` (what a quick melee swings when the tables have no melee weapon), and `render_stats()`'s later fields (rigid models drawn, moving lights, the first-person layer shown, and counts since the page loaded of muzzle flashes shown, hit flashes started and swings begun).

## Rendering (`forge-render`; `forge-web/src/render.rs`; `kit/render.js`, `kit/look.js`; track R)

**A frame** (`gpu.rs`), within WebGL2's limits:

| Pass | What |
|---|---|
| shadow | the moon's one depth map (`look.shadow.size`: 2048 high, 1536 medium, 1024 low, 0 off), an orthographic box ahead of the eye snapped to whole texels; only what reaches that box is drawn into it (wave 2) |
| fire shadows (wave 2) | the nearest `look.fire.shadows` fire lights (3 high, 2 medium, none low) each keep five square depth faces (`look.fire.shadowSize`, 256 px; +Y is left out) in one depth array texture; `look.fire.shadowFaces` of them (4) are drawn again each frame in turn, all five when a fire takes a slot |
| world | into an HDR target (Rgba16Float, the render scale and the `detail` width cap): static runs, skinned runs (two-sided ones uncull), the sky at the far plane (gradient, stars, the moon where the moon light comes from), then the world's particles (one instanced draw, premultiplied: smoke blends, sparks add) |
| first person | the arms and weapon on a cleared depth with their own field of view (`look.fp.fov`, or `fp_fov`), then particles drawn on top (a muzzle flash born within 1.6 m of the eye) |
| bloom | extract (a soft threshold) at a quarter of the scene's size, blur across, blur down; skipped at `look.bloom.intensity` 0 |
| meter (wave 2) | with `look.tone.auto`: 96 points of the scene through the tone curve into one float texel, fed back from frame to frame: the factor on the exposure that brings the picture's mean luma to `look.tone.key` |
| composite | scene + bloom, exposure (× the meter's factor), the tone curve (ACES, Reinhard, clamp), saturation, vignette, sRGB, gamma, contrast, grain, the colour steps with an ordered dither, into the canvas (or an 8-bit target, then FXAA when `look.aa`) |

Everything drawn is an **item** (a static instance, an actor, an attachment, a first-person piece); each item's primitives become 144-byte instance records (model matrix, tint × base colour, flash, emissive, slot / flags / bone base, and since wave 2 the surface: its texel grid and world tile), sorted into **runs** (layer, pipeline, mesh, pictures), one instanced draw each: twenty skeletons sharing a mesh are one draw, and so are 400 pieces of debris sharing a model. Lights: the host's (`set_lights`, at most 32: fires) and flashes, at most `look.lights.max` a frame, flashes first, then the nearest. Shading: ambient, the moon with its shadow (4 filtered taps), point lights (`q² / (1 + d²)`, q = 1 − (d/r)⁴), emissive × `look.emissive`, the hit flash, then fog (exponential `look.fog.density` over the linear near/far ramp).

**Wave 2 (track L1: the look).** What the renderer gained, each a `look.*` slot (kit/look.js; `gf-forge/lookdev/README.md` has the slots, the calls and the measures):

- **The retro texel grid** (`look.retro.texels`, `density`, `models`, `hand`, `crisp`; mesh.wgsl `fs_main`). A picture is not sampled at the screen's pixels but on a grid of square texels at the look's texels a metre, whatever its resolution: each texel takes one colour from the picture's mips, its edges are one screen pixel soft, and the mips take over once a texel is under a pixel, so it reads as nearest sampling up close and does not shimmer in motion. With the option off the same grid is filtered smooth. The grid per instance (`InstData::surf`) comes from the model's **surface** (`Surface`: a tiling picture, `tile` metres a repeat, laid in world space or by the mesh's UVs; forge-web `model_surface`, kit/render.js `surface`) or, for any other mesh, from its measured UV density (`glb::uv_density`, UV units a metre) and where it stands. A surface may carry its own emissive picture (a second texture in the material group); a model file's emissive map that is not its base picture is drawn too.
- **Lights.** A point light's knee is `look.lights.falloff` of its reach (never under 1 m): a fire's pool reaches most of its 11 m. **Fire shadows** as in the table above: `Scene::fire_casters`, gpu.rs `plan_fire` and `fire_face`, mesh.wgsl `fire_shadow` (a native test holds the two to one projection); what holds the fire and anything within 0.5 m of it is not in its faces.
- **The eye adapts** (`look.tone.auto`, `key`, `autoMin`, `autoMax`, `adapt`; post.wgsl `fs_meter`): the meter above, to a brighter picture over `adapt` seconds and four times as slowly to a darker one, at once on the first frames and after a cut.
- **Tracers** (`look.tracer.*`; `Scene::tracers`, `streaks`): forge-feel's TRACER event (kind 33) and every round in flight (its `Shot` entities) are drawn by the glue as beam strips in the particles' one draw (particles.wgsl shape 5), added and bright enough to bloom, never under about a pixel and a half wide.
- **What a frame leaves out** (`Scene::records_for`): static instances and rigid pieces outside the camera's frustum; from the moon's shadow pass whatever does not reach its box; loose pieces (the core's rigid entities: `Scene::pieces_from`) past `look.pieces.distance`, and their shadows past `look.pieces.shadow`. Bodies and the first-person layer are never culled.
- **The backdrop layer** (`Instance::backdrop`; forge-web `instance_backdrop`, kit/render.js `backdrop`): an instance beyond the walls casts no shadow, takes the moon and the ambient light only (no shadow lookup, no light loop), has its fog thickened by `look.backdrop.fog` and is not drawn past `look.backdrop.distance`; `look.sky.haze` widens the band of horizon colour it fades into.
- The look's pack grew by 23 values, appended (`EXT_FIELDS` 47 → 70): a look.json without them draws wave 1's picture.

**Bodies.** `add_body(bytes, slot)` adds a skinned GLB to the core's animation library and as a drawable model bound to that skeleton (→ [body, model]). From then on, **every core entity with `Animated` on that body is drawn by itself**, each frame, at its interpolated place, turned by π (an entity faces −Z, a gf-humanoid-1 body +Z), with its flash, glow, tint and cloth colour; the local player's own body is not drawn while the camera is its eyes. `render_stats()[13]` counts animated bodies with no model (nobody called `add_body`). The palette is built per skin from forge-anim's `world` (`Scene::push_palette`): every file skin's joints with its own inverse bind matrices, then one entry per rigid piece on a joint (a helmet on the Head). A skinned mesh node's own placement is ignored, as the glTF spec and three.js do. **Puppets** (`puppet`, `puppet_play`, `puppet_rest`, `puppet_move`, `puppet_remove`) are bodies the renderer poses itself (lookdev, previews, verify's poses). **Attachments** (`attach(owner, model, slot, socket, grip)`) hang a rigid model on `hand_r`, `hand_l`, `head`, `back` (rig.js `mkSocket`'s frames, or a body's own `socket_*` node) or any bone, placed by the catalog's grip.

**The first-person layer**, in camera space (the eye at the origin, −Z forward): `fp_arms(model, slot)` (fp/arms.glb: `arm_r` is moved so its `socket_grip` sits at the weapon's hold; `arm_l` goes to a two-handed weapon's `socket_grip_l`, else it is hidden), `fp_weapon(index, model, slot, hold xyz, two_handed)` registers the weapon of table row `index`, `fp_use(index)`, `fp_pose(m)` (the rig's camera-space offset: kick, sway, bob, reload poses), `fp_visible`, `fp_fov`, `fp_sleeve(rgb)`. `fp_sockets()` → the muzzle, tip and grip in camera space and, for the muzzle and tip, the world point that shows at the same place on screen through the world camera: start the flash, smoke and tracer there.

**What the art says** (wave 1b; `glb.rs`, the library's conventions in `library/README.md`). A material's emissive texture is drawn (the instance's emissive × the map, × `look.emissive`; only one map a model: a second is read and ignored). A node with `extras.gfHidden` (a weapon's `flash_muzzle`) is left out of the model's box and not drawn until asked for: the first-person weapon's for 50 ms after its shot. A model's `extras.gfTint` names the materials that take the player colour (beside any `tint_*` name) and `gfTintMix` how far (0.85 without it); the co-op hunters use both. `glow_*` materials take an actor's glow (the eyes' tell).

**Rigid entities and moving lights** (wave 1b; `actors.rs` `EntityModel`, `Scene::attached`, `Scene::moving_lights`). `entity_model(class, type, …)` registers the model every non-animated core entity of that kind and type is drawn as, each frame at its interpolated place, with a fit matrix and an optional spin and bob (a pickup turns and floats; a piece of debris tumbles as rapier moves it). Class 100 (`CLASS_ORB`) is a shared `PROJECTILE` (a caster's orb: forge-feel's own rounds are `Local` and drawn as particles). Lights that move with an entity (the orbs', from the AI view) are added to the frame's lights after the host's fires.

**What F and A drive, from Rust** (no crate dependency: events, read once per tick by the glue in `forge-web/src/render.rs`):

| Event | Kind | Words (floats as bits) | Effect |
|---|---|---|---|
| LIGHT (core) | 6 | source, xyz, rgb, radius, intensity, frames | a flash light at full intensity, fading linearly to 0 over `frames` at 60 a second (muzzle: r 3.4 m, 2–4 frames, 0.95–1.8; impact: r 2.5 m, 4 frames, 1.17) |
| PARTICLES (core) | 7 | name, count, xyz, dir xyz, speed, spread | a burst of the kind the name says (`smoke`, `sparks`, `embers`, `dust`, `bone`, `blood`, `muzzle`, `impact`, `orb`, `ash`, or an alias: `spark`, `fx.spark`, `bone-chips`, `muzzle-flash`, …); 0s take the kind's own numbers; `<kind>@muzzle` and `<kind>@tip` put the burst at the first-person weapon's socket where it shows on screen (a zero direction: the view's); an unknown name is counted (`render_stats()[12]`) |
| HIT (core) | 1 | … target … | the target's white body flash, `look.hit.time` (0.05 s, 2–3 frames) at `look.hit.amount` (0: none) |
| KILL (core) | 2 | … target … | the target's eyes go out |
| R_FLASH | 56 | target net id, r, g, b, amount 0..1, seconds | any other body flash |
| R_GLOW | 57 | target, r, g, b, intensity, ramp seconds | the `glow_eyes` colour × intensity, reached over the ramp (the tell: rest × 1.14 over 0.3 s, back with ramp 0 as the lunge lands); intensity < 0: the material's own |
| R_VIEWMODEL | 58 | weapon index (u32::MAX keep), flags (1 hidden), x y z (m), pitch yaw roll (°), fov (° , 0 keep) | the first-person rig's offset this step and the weapon in hand |
| R_TINT | 59 | target, r, g, b, a (a < 0: none) | a body's colour multiplier |
| R_CLOTH | 60 | target, r, g, b (r < 0: none) | the `tint_*` materials (the player colour, mix 0.85) |

For example, A's attack tell: `sim.emit(Event::Custom { kind: 57, words: [net, c[0].to_bits(), c[1].to_bits(), c[2].to_bits(), (rest * 1.14).to_bits(), 0.3f32.to_bits(), 0, 0, 0, 0, 0, 0, 0, 0] })`. These events also reach JS (`host.on('custom-57', …)`); they are not replicated (each copy draws its own). From JS the same calls exist directly (`kit/render.js`: `flash`, `glow`, `tint`, `cloth`, `fp.*`, `burst`, `light`, `fxPicture`).

**Particles** (`particles.rs`): a few thousand at most, simulated on the CPU (gravity or rise, drag, swirl for what floats, bounce for chips), each kind's numbers a `look.particles.<kind>` slot; the renderer also emits embers and smoke over every fire light the host sets (`look.fire.*`) and ash around the eye (`look.weather.ash`). A kind's picture is its `fx.*` image slot (`fx_texture(kind, w, h, rgba)`, packed into a 4 × 4 atlas of 128 px cells); without one the shader draws a shape (a soft disc, a star, a streak, a ring, a chip).

**The look** (`look.rs`): `set_look` takes wave 0's 22 floats, then `7301, 1, n, EXT_FIELDS…, kinds, KIND_FIELDS, …` (kit/look.js `pack`: `PACK_EXT`, `PACK_KIND`, `KIND_IDS`; a cargo test reads look.js and holds both to one order). A wave-0 look (no stack values) draws as wave 0 did. `pack(look, tier)` lowers what `TIERS` says for `low` and `medium` (the shadow map, lights a frame, AA, the particle budget).

**For verify:** `report()` has a row for every static instance (its index, hidden ones too), then every actor, attachment and first-person piece (a skinned body's box is its bind box at its place); the slot-ID pass (`request_sight`) draws everything, the first-person layer on a cleared depth; `actor_look(id)` says how an actor was drawn (flash, glow, tint); `capture_request(actor)` reads back a body's skinned vertices as the GPU skinned them, and `capture_cpu(actor)` sums the same matrices on the CPU. `gf-forge/lookdev/forge-checks.mjs` holds forge's bones to rig.js, the GPU to the CPU and the vertices to three.js's skinning (verify check 19).

**WebGL2: one core, two builds (wave 3, track W).** The same crates build twice, by forge-web's Cargo features, and `tools/build.mjs` makes both (`kit/BUILD.json` → `builds`): `webgpu` (the default; `kit/wasm/`) is wgpu's WebGPU backend, where the browser compiles the WGSL and neither wgpu-core nor naga is in the wasm; `webgl2` (`--no-default-features --features webgl2`; `kit/wasm-webgl2/`) is wgpu's GL backend on a WebGL2 context, which carries wgpu-core, wgpu-hal and naga. `kit/host.js` loads one per device (a WebGPU adapter, else WebGL2, else the kit's screen; `?gf-forge-backend=webgl|webgpu` forces one) and `window.__game.forge.state().backend` says which drew. The renderer is the same code and the same WGSL in both. What the WebGL2 build needed:

- **The shaders arrive as naga's IR** (forge-render's `naga-ir` feature; `build.rs`). wgpu's GL backend translates WGSL to GLSL itself, so the first WebGL2 wasm carried naga's WGSL parser: 5,285,698 bytes raw against the 5 MiB budget, and with it `unicode-ident`, whose licence (Unicode-3.0) is not on PLAN §5's list. Now `build.rs` parses and validates each module on the build machine and writes it as bincode; `gpu.rs` `shader_source` hands wgpu `ShaderSource::Naga`. The wasm keeps the validator and the GLSL writer only. Two native tests hold it: every entry point translates to GLSL ES 3.00 (`the_shaders_translate_to_webgl2`), and the IR's trip through bincode writes the same GLSL (`the_shader_ir_survives_the_trip`).
- **One sampler a picture.** The GLSL writer refuses a texture read through two samplers in one entry point (WebGL2's samplers are a texture and its sampler together). `fs_composite` read the scene through a filtering and a point sampler; the pixelated upscale now reads the texel under the pixel at its centre through the one. Nothing else in the four modules had to change: within WebGL2's limits as wave 1 kept them (no compute, no storage buffers: the palette is an Rgba32Float texture read with `textureLoad` in the vertex stage; one 1.5 KiB uniform block; content textures ≤ 2048 px; 14 vertex attributes of 16; 7 inter-stage variables; comparison-sampled Depth32Float shadow maps, the fires' as a 2D array; the R32Uint slot-ID targets and the Rgba32Float vertex capture read back).
- **What the device can draw into** (`forge_render::Caps`, asked of the adapter at `attach`; `render_caps()`, kit/render.js `caps()`): `hdr` (Rgba16Float as a blending render target: EXT_color_buffer_float or _half_float on WebGL2) and `float_capture` (Rgba32Float: verify's check 19). **Without `hdr`: the 8-bit scene** (common.wgsl; kit/look.js `BACKEND_TIERS.ldr`). The scene target is Rgba8UnormSrgb, so the exposure and the tone curve are applied as each scene pixel is drawn (`scene_out` in the mesh, sky and particle shaders), the composite adds only what follows them, and there is no bloom. The eye still adapts: the meter keeps its factor in two bytes of an Rgba8Unorm texel, read once a vertex (`ldr_exposure`; the frame groups carry both meter texels, `Gpu::fbg`). `?gf-forge-scene=8bit` draws it on any device with either build.
- **A lost device is a lost WebGL2 context.** wgpu's GL backend does not report it, so `host.js` listens (`webglcontextlost` → `mark_lost()`; the browser restores the context; `recover()` waits for `webglcontextrestored`). On WebGL2 `recover()` makes a new wgpu instance on the same canvas: a restored context has forgotten its extensions, the float targets among them. QA's `loseDevice()` is WEBGL_lose_context there.
- **`log` is compiled out of the release wasm** (`release_max_level_off`, forge-web's Cargo.toml): no logger is installed in the page.

Not known: any phone. Everything above ran in Chrome on this desktop (ANGLE on OpenGL and on Vulkan, NVIDIA; SwiftShader boots it at a few frames a second). naga's GLSL on a mobile GL driver, and a device without float render targets, have not been seen; the 8-bit scene has only been forced.

## Size

The release wasm (`node gf-forge/tools/build.mjs`, LTO, `-Oz`, the hot crates at opt-level 3: forge-core, forge-anim, forge-feel, forge-ai, rapier3d, parry3d) is in `kit/BUILD.json`; the README has the numbers and the budget.

## How the crates meet (wave 1b)

Each track wrote "where the others start" for itself; the integration (gf-forge/INTEGRATION.md, which lists every mismatch found) settled them like this. Follow these when adding to any crate.

**Who draws what.** The renderer draws every core entity that is `Animated` on a body added with `add_body`, by itself; nothing in JS poses or skins a body. `players.js` gives each seat its hunter (`Wear.body` is the slot index) and `ai.js` each enemy row its grim body; both hang held weapons on `hand_r` with `attach`. The local player's own body is never drawn while the camera is its eyes. Rigid things the core spawns (a kill's pieces, the coin, a pickup, a caster's orb) are drawn by class and type through `entity_model` (`kit/fight.js`, `kit/ai.js`).

**Views in, not events.** forge-render depends on neither forge-feel nor forge-ai. `forge-web/src/glue.rs` reads their views once a frame and drives the renderer: the feel view's weapon row, kick, sway, bob, reload, raise, swing and knock-down pose the first-person layer; the AI view's eye colour and intensity set each enemy's `glow_eyes`, and its orb rows become moving point lights. The renderer's own events (`R_FLASH` 56 … `R_CLOTH` 60, the table under "Rendering") stay as a way in for a rules-side or future caller; nothing in the core emits them today.

**A shot, end to end.** forge-feel's `feel.weapons` fires on the copy that pressed (the host, or a joiner predicting): the muzzle LIGHT, the shot SOUND, the smoke and sparks PARTICLES, the kick, each with the player's id as `source`. The glue shows the first-person weapon's hidden `flash_muzzle` node (or the muzzle picture) for 50 ms and moves the muzzle's particles to the weapon's `socket_muzzle` where it shows on screen. A trace that lands deals damage through `Sim::damage` with the region's multiplier and the trace's own (`weapons::region_mult`: forge-ai's shield is a hurt region below 1). The HIT flashes the body (the look's hit flash, forge-feel's FLASH over it), `feel.hits` adds the number and the combo; forge-ai's enemy, being `Reacts`, plays its own stagger. A KILL: forge-ai emits `enemy-down` and its death sound and keeps the dead body for 0.15 s; forge-feel's `feel.debris`, later in the same step, bursts it into `Local` pieces and a coin and despawns it at once; each sound plays once (kill layers are deduplicated by name and source within the step).

**On a joiner.** A replica cannot be hurt there (`Sim::damage` deals nothing), so a predicted shot shows its own impact light, sound and sparks and waits for the host: the host's HIT and KILL arrive as early events (above), and forge-feel shows the number and bursts the joiner's own pieces (`kills::remote_kills`); debris and coins are never in a snapshot. The host's copies of the joiner's own shot effects are dropped by `apply` (same source). Replica enemies have no brain on a joiner: `play.replicas` plays the row's clip for the snapshot's state byte.

**Being hurt.** forge-ai's attacks call `Sim::damage` on the player; forge-feel's `feel.hurt` reads the health lost (so it also works on a joiner, from the snapshot) and raises the tint, the thud and the low-health stages. A brute's slam and the boss's knocks are forge-ai's event 41; `play.knocks` turns one into `forge_feel::controller::knock` (down for the event's seconds, pushed, no firing meanwhile).

**Bots** are forge-ai's and play through the same `Control` and `Look` an INPUT writes, so they move with forge-feel's controller and fire forge-feel's weapons; `Wear.held` follows their `Arms::current` like anyone's.

**Rules for the next addition.** Skip `Replica`s in every system that simulates; spawn anything a copy makes for itself with `spawn_local`; never despawn another crate's entity without its event having been emitted first; give every effect its player's id as `source`; add an export in your own forge-web module; and add a test to `forge-play/tests/together.rs` when two crates must agree.

## The run (wave 2, track G: cards, the reward, down and revive, debris that stays, co-op under a hit)

What the first playable (`sandbox/vigil`, "Bone Vigil") added to the core. The proof is in `gf-forge/evidence/wave2-G-2026-10-10/`.

**Each player's own values** (`forge-feel/src/cards.rs`). `Config` now carries the player's walk and body (`player`, forge-core's `PlayerTable`) beside the moves and the weapons, and every player has a `Build` (the cards held, in the order taken, and the `Config` they give). A card is an upgrade (`stat` + `add` then `mul` on a table value by its path: `player.walk`, `player.stamina.evadeCost`, `weapons.sidearm.damage`, `weapons.*.reload`; a second value `stat2` for a trade), a weapon (the row is given and drawn) or a heal. The values are the tables' rows as JSON with every upgrade applied in order (`with_cards`), read back through the same `from_row` the tables load with, so units, ranges and derived numbers (the recoil spring, the evade's speed) follow. **Every feel system reads the player's own config** (`cards::of(sim, e)`, or `build.cfg` inside a query): never `crate::cfg(sim)` or `sim.tables.player` for a value a card may change. `preview` gives the inspector's before → after from the code that applies the card; `value_of` reads one value back.

**The deal and the reward.** `deal(defs, rarity weights, seed, player, reward index, cards held, weapons usable)` is pure: three cards without putting back, `weight × deal.<rarity>`, never a full stack, a weapon already held, or an upgrade for a weapon the player cannot use. `Reward` (a resource, the host's) is opened by `op::REWARD` (74: `[1, wave, seed lo, seed hi]`, `[seconds]`), a choice is `op::PICK` (75: `[player, 0..2 | pass]`), and `feel.reward` counts down, passes the undecided at the end and emits `reward-done`. Rule events: `reward-open`, `card-picked`, `card-passed`, `reward-done`, `card`. `op::CARD` (76) gives a card outright; `op::RESET` starts a player's run over (cards gone).

**Snapshot v3** (`forge-core/src/snapshot.rs`). Each player record ends with a plugin's bytes (`SnapBlob`, at most 48): forge-feel writes them on the host in `feel.told` (Events, last) and reads them on a joiner in `feel.sync` (Input): down, the revive's share and helper, the reward (open, seconds left, wave, the three cards dealt, the choice) and the cards held. `apply` puts the host's bytes on **every** player of a joiner's copy, its own too: a joiner predicts its own player with the same card-changed values the host replays it with. A player with nothing to say costs one byte.

**Down and revive** (`forge-feel/src/revive.rs`; `spec.forge.player.revive`). With a friend standing, zero health is `Pilot::downed`: the weapons already stop for the dead, the look turns slowly (forge-core `LookScale`, honoured by INPUT), the eyes sink (`feel.camera`), forge-ai targets only the living. A living player within `revive.range` holding `BTN_INTERACT` fills `Pilot::revive` at 1 / the helper's own `revive.time`; released, it drains at twice the speed; full, `raise` brings the player back at `revive.health`, unhurtable for `revive.grace`. Nobody standing: nobody is down (`player-out`), and the rules end the run. Rule events: `player-down`, `player-revived`, `player-out`. `op::REVIVE` (77).

**Debris stays** (`forge-feel/src/kills.rs`). A piece on the ground is damped (`LAND_DAMP`: a ball no longer rolls until its time is up), and once slow for `REST_AFTER` it gives up its rapier body and its `Piece` and becomes a `Rest`: an entity with a transform and a kind, drawn, never stepped, never collided with. At most `feel.kill.rest` (400) stay; past it the oldest shrink away over `feel.kill.restFade`. `feel.kill.budget` is now the pieces *flying*. Coins fly to the nearest player standing.

**The governor's hold on the pieces** (wave 3, track M; `forge-feel/src/kills.rs` `Quality`, `op::QUALITY` 78: floats [rest share, flying share]). When frames stay short the kit's governor (`gf/forge/governor.js`) asks this copy to keep a share of `feel.kill.rest` and of `feel.kill.budget`; `kills::kept` gives the caps now. A lowered resting cap is met at once by setting the oldest pieces to shrink away over `restFade`, as past the cap always. This copy's own, like the pieces: never in a snapshot. `fixtures/feel/governor.json` holds it (288 lying, a quarter of the cap kept: 100; given back: the next kills stay).

**Co-op under a hit** (INTEGRATION.md mismatch 16), four parts:
- *A joiner's word for where its own player is* (`forge-core/src/net.rs`, the module's notes; `core.character`). Every input of a joiner carries where its own copy left its player after that step, and how fast (`StepInput::claim`: 18 bytes, from `net.predict`'s record). The host still replays the input, then moves its copy to the claim: through the world alone (a wall still stops it) and only within `ADOPT_MAX` (2 m) of its own replay (a respawn the joiner has not heard of stays the host's; the joiner snaps as before). This is what ended the corrections: the two copies never have the enemies in quite the same places, so what stops a player differs by a step here and there, and each such step came back as a correction (0.4 to 1.1 m in a crowd). Now a player is stopped by what its own screen shows and the host's copy follows. The host counts it (`net_stats` → `queues[].taken`, `takenMax`, `refused`). The other three parts keep the host's replay close to the claim, so what the others see of a friend is smooth.
- *A shove on the joiner's own step* (`forge-feel/src/shove.rs`; forge-core `events::Push`, kind 12, carried by the snapshot). `controller::knock` goes through `shove::shove`: for a joiner's player on the host it is scheduled `DELAY` (24) of the joiner's own input steps after the last one applied and announced with a PUSH naming that step; both copies start it in `feel.shoves` (Feel stage, before the controller) as they simulate that step. A PUSH that arrives after its step plays what is left of it (counted as `pushesLate` in `net_stats`): a shorter shove on every screen, never a correction. forge-ai's `knock_player` no longer writes the player's velocity when forge-play is installed (`KnockByEvent`).
- *Friends walk through each other* (`physics::groups::PLAYER_BLOCKS`): a player's capsule is stopped by the world and enemies, not by players.
- *A joiner's copies of enemies have bodies* (`forge-play` `play.bodies`), placed by `core.replicas` where the host will have them when it replays the joiner's step: the newest sample carried forward by the replica's velocity (`Replica::vel`) times the joiner's lead (`NetState::lead`: its step now minus the step the snapshot acknowledged), at most `MAX_LEAD`, never into the joiner's own player. The body is still *drawn* between its samples.

**Waves grow with the players** (`forge-ai/src/director.rs`; `waves[].friends`): each player after the first adds that share of the wave's enemies and of `maxAlive`, and of a boss's health (never more bosses).

## Elites (wave 7, track E: `forge-ai/src/elite.rs`; `spec.forge.elites`)

The creator, 2026-10-12, chose "Elite zombies" for the forge zombie game: from the second lap some of the risen carry a modifier read at a glance (burning, armoured, splitting, fast), and pay more coins.

- **What an enemy is, each step.** `Enemy::def` is an index: its row, or a *variant* of it (`Roster::variant(row, lap, modifier, young)`: endless's growth for the lap, then the elite's changes, made once per key and kept in `Roster::variants`; `Roster::of(&Enemy)` reads it). Every forge-ai system reads `of`, so a later lap's damage and speed now reach what an enemy does each step; wave 6 scaled only the health it rose with (its damage and speed were the row's).
- **Who and when.** The director rolls each ordinary arrival on the host (`elite::roll`, the seeded `sim.rng`, only once elites can rise); `OP_ELITE` (104) queues forced ones for QA; `OP_SPAWN`'s third int makes a hand-raised one an elite; `OP_DIRECTOR` start and skip take a lap. `EliteState` (the host's) counts a wave's elites, the run's firsts, the burns and the fire on the ground.
- **Effects.** Health × `health` (variant); fast: speed, tells, cooldowns, recoveries (variant); armoured: staggers, downs and flinch spring (variant) and forge-core's `Marked.taken` (`Sim::damage` deals that share; the HIT says what was dealt); every elite `Marked.bounty` (forge-feel's kill throws its row's coins × it). Burning: the enemy system's landed blows and a caster's orbs (`Orb::mark`) call `elite::ignite`; `ai.elites` (Ai stage, the host's only) bites every `tick` through `Sim::damage` (attacker: the elite) with embers and a quiet sound, and keeps a fallen burning elite's patch alight (embers, a LIGHT, alight whoever stands in it). Splitting: `die` queues the young, spawned after the step's despawns with the elite's wave (the director counts them), unhurt for 0.4 s (the body's burst), marked `CHILD`.
- **Every copy draws the same.** The mark (`Enemy::mark`: the modifier, + 8 for a young one) is the AI view's field 16 (`ELITE`; `FIELDS` 17) and forge-core's `Marked.mark`, seven bits carried in a snapshot actor's flags byte (bits 1..7; no byte more; a joiner's copy gets `Marked` with the mark alone). forge-play's `play.sizes` gives a joiner's replica enemies their type's scale (they were drawn at 1) and a young one its smaller size. forge-web's glue sets each marked enemy's rim (`ActorFx::rim` → `Actor::rim` → the instance's `extra.w`, `pack_rim`; mesh.wgsl `rim_of`: brightest at the edges as the eye sees them, a little over the body, half of it through the fog) and its tint, and `elite_fx` gives a burning one embers and a small light, a fast one a wisp. A joiner's burn is the host's: the joiner hears the rule `burning`, sees the embers and takes the health the snapshot carries.
- Tests: `forge-ai/src/elite_tests.rs` (the table held to the kit's, gating, chance, the cap, the boss left out, each modifier, the burn's bites and refresh, the fire, the young, the director's count, endless growth each step, the rule events), forge-play `together.rs` (coins × the multiplier, a joiner's mark and sizes, a joiner's player burning), forge-render `an_actors_rim_rides_in_its_records_and_nothing_elses`. In browsers: `gf-forge/tools/elites.mjs`.

**forge-web** (`feel.rs`): `feel_run()` (the reward and every player's run state, JSON), `feel_card_preview(player, card)`, `feel_value(player, path)`, `feel_players()` (six floats a player, for every frame). The feel view gained `resting`, `downed`, `revive`, `reviver`, `reviving`, `revivingShare`, `cards`, `reward`, `rewardLeft`, `choice` (fields 41–50).

## Builds (wave 7, track B: perks, families, set bonuses)

The creator, 2026-10-12: "We should incorporate fun builds people can go. Tank AOE damage build, high damage low health build, ect" — they chose families and set bonuses. `forge-feel/src/perks.rs`; the kit's `tables/cards.js` (PERKS, `familyFields`) and `builds.js`.

**Perk cards.** A card of kind `perk` names a `perk` and its numbers (`power`; the perk's defaults fill the rest, `fixtures/feel/data/perks.json` holds the Rust defaults to the kit's). Nine: `blast` (a shot that lands splashes `share` of its damage within `radius`), `burst` (a kill deals `damage` within `radius`; chains), `shockwave` (hurt: `damage` and `knockback` within `radius`, `cooldown`), `thorns` (a striker within `radius` takes `damage`), `aura` (`damage` a second within `radius`, two ticks a second), `fury` (hits do up to `share` more × health missing), `lifesteal` (`heal` + `share` of full health a kill), `ambush` (the shot after an evade, within `seconds`, is a sure critical), `rush` (a kill: `seconds` of `speed` and `rate` more). A perk card may carry `stat`/`stat2` upgrades too (a trade). Copies stack: the largest radius, the shortest cooldown, the rest summed (`Perk::stack`).

**Families.** `spec.forge.families[]` (id, name, label, colour, text, `at`, `sound`, `bonus: {name, text, perk, power}`); a card's `family`. `perks::held(cards, families, held)` is pure: each perk's sum, each family's count (copies count) and the set bonuses unlocked (`count ≥ at`), whose perks join the cards'. It is made with a player's values (`cards::rebuild` → `Config::perks`), so a joiner that has the cards has the perks. `cards::grant` says a bonus once: rule event `set-bonus` {entity: player, a: family row, b: held, c: at}, the family's sound and a flare. `deal` weights a card of a family the player holds by `deal.familyBias` (default 2), copied into each `CardDef::bias` at the load so `deal`'s signature is unchanged; still pure.

**Where they run.** On the host (`feel.perks`, Physics before `feel.kills`): the step's evades, kills by players and hits on players (and between-step command damage), then the aura; a perk's own kills are reacted to in the same step up to `ROUNDS` (4). `weapons::strike` adds fury and the blast; `weapons::fire` takes the sure critical (`Shot::crit` carries it on a projectile). Damage is credited to the player. Joiners see lights, particles and sounds (replicated events); the aura shows a ring of embers and a low glow each tick. The rush is the one state a joiner predicts with: its share left in fifteenths rides in the player's snapshot byte 0, bits 4–7 (`Told::rush`), and the controller's walk and the weapons' cooldown run faster by `perks::haste`. `Perks` (a component) holds the rush, the sure critical, the shockwave's cooldown, the aura clock and each sound's hold-back; `op::RESET` clears it. `Tally` (a resource) counts each perk's uses, hits, kills, damage and health given, and the set bonuses: `feel_run()` carries it as `perks`, and each player's `build` (perks held, family counts, bonuses, rush, primed). `feel_card_preview` gained `perk` {kind, before, after} and `family` {row, label, at, held, after, unlocks, bonus}.

## Coins worth spending (wave 7, track P: the purse, the pedlar's cart, a paid revive)

The creator, 2026-10-12: "Also coins still cant be used for much"; asked what coins should buy, they chose the pedlar's cart between waves and paying to revive a friend (`research/rust-engine/evidence/creator-zombie-town-builds-coins-request-2026-10-12.json`). The proof is in `gf-forge/evidence/wave7-track-p-2026-10-12/`.

**The purse** (`forge-feel/src/shop.rs` `Shop::purses`). Each player's coins, by player id, the host's: `kills::feel_coins` puts every coin it scores (`coin` rule event, value rounded) into the purse of the player it reached (`shop::earn`), at most 65,535; a purchase takes its price out; `op::RESET` empties it. **Not a component**: a component added at the first coin moved that player to another hecs archetype, which changed the order every query meets the players in, and with it the fight (forge-play's four-player wave test lost two of its enemies at most alive). Honed cards are kept the same way (`Shop::honed`). **Size**: the purses, the hones, the table and the lap all live in the one `Shop` resource, as small lists by player id (`shop::Ids`, not BTreeMaps), the default items live only in the kit's table, three ops are one, the joiner's mirror rides `cards::feel_sync`'s own loop, and JS gets numbers (`shop::state`, prices one by one, a honed value one path at a time) and works out what can be bought itself, as the core checks it: each BTreeMap of a new value type, each resource type, each command and each `json!` cost the wasm kilobytes (the first cut cost 91 KB raw a build; see the evidence record for the final numbers).

**The cart** (`Shop`, a resource; `spec.forge.shop`, kit `tables/shop.js`). `op::SHOP` (88: `[1 open | 0 close, wave, seed lo, seed hi, 1 with the reward]`, `[seconds]`) opens it with every player as a visitor; `op::BUY` with item `shop::LEAVE` (255) leaves; `feel.shop` (Feel stage, after `feel.reward`) counts down and closes it when every visitor has left or the time is up (a paid three left waiting is refunded). The wave director waits for it (`forge-ai` `Roster::cart`, read from the same table's `on`, `every`, `from`: `wave-clear` and `wave-reward` gained `d` = 1 the cart opens, and `wave-reward`'s `c` = 1 a reward follows), and the kit (`gf/forge/ai.js`) opens the cart and, on a reward wave, the reward with the same seconds (the longer of `deal.seconds` and `shop.seconds`), and resumes the director when both are done.

**An item** (`ItemDef`): `price × perLap^lap × perBuy^bought`, rounded, where `lap` is the wave director's (forge-play `play.lap` copies `Director::lap` into `Shop::lap` every step through `shop::set_lap`, the host's; a joiner reads it from the snapshot) and `bought` this player's purchases of it this visit (a visit runs from one cart to the next). `stock` is per player a visit (0: none). `op::BUY` (89: `[player, item row | LEAVE 255 | TAKE 254, arg]`) is checked by the host: the item, the cart open and the player in it (a revive needs neither: it is sold in a fight too), the stock, the coins, a target; a refusal is `buy-refused` {entity, a: item, b: why (1 item, 2 closed, 3 stock, 4 coins, 5 nothing to use it on)} and spends nothing. The kinds:
- `card`: three cards dealt for the player by `cards::deal_salted` (the reward's deal with a salt: `SALT_CARD` + how many bought, so neither the reward's three nor the first paid three); `op::BUY` with item `shop::TAKE` (254, arg 0..2 | give back) takes one (`cards::grant`) or gives them back for the coins.
- `reroll`: on a reward wave, the player's three dealt again (`SALT_REROLL` + bought + 1), while they are still choosing.
- `heal`: `share` of full health, not at full health.
- `hone`: `arg` is the card's place in the hand. At level n a card is played at factor `1 + by × n`: its `add` × the factor and its multiplier to the power of the factor (`cards::with_cards_honed`; a multiplier below one never crosses zero). A card is honed one rarity a step, up to epic (`honeable`: an upgrade card with values, `rarity + level < 2`). Every value a card changes goes through the factors: `set_cards` (the player's own `Config`), `preview`, `value_of`; `shop::value_honed` gives the inspector's after (one path at a time; `value_of` is the before) from the same code.
- `revive`: `arg` is a downed friend; `revive::raise` at the table's revive health, the payer as the helper (`player-revived` a). A revive by holding interact stays free.

Rule events: `shop-open` {a: wave, b: seconds, c: lap, d: with the reward}, `bought` {entity, a: item, b: price, c: arg}, `shop-card` {entity, a: card row, b: slot}, `shop-refund` {entity, a: item, b: coins}, `shop-left` {entity}, `shop-done` {a: wave, b: purchases, c: coins spent}.

**The snapshot** carries each player's part after the cards (`cards::Told::extra`, `shop::encode`/`decode`: flags, the purse, the cart's seconds, the lap, the wave, the visit, the purchases in four bits an item, the paid three, the honed cards), and `cards::feel_sync` hands each player's to `shop::sync_one` on a joiner (`sync_begin` first): each purse, the cart, and the hone levels, after which the joiner's own player's values are made again (it predicts with the honed value). `forge-core` `BLOB_MAX` went from 48 to 96 bytes: a full hand (32) with every card honed still fits (10 + 32 + 15 + 32).

**forge-web** (`feel.rs`): `feel_shop_state(player)` (`shop::state`: open, seconds left, in the cart, purse, with the reward, visit, lap, wave, seconds, the paid three, this visit's purchases of each item, the hone level of each card held), `feel_shop_price(player, row)`, `feel_hone_value(player, pos, path)`; `feel_protocol` names the two ops.

**The kit** (`gf/forge/shop.js`, made by `boot-forge.js` as `ctx.shop`): the cart panel, the paid revive's prompt in a fight (G, or its button), a joiner's purchase, leaving or taking as the kit message `fb` to the host; `window.__game.forge.shop()` is what it shows. The HUD's coin count is the purse (`hud.js`, `feel_shop_state`'s [3]). `cards.js` deals the screen's three again when a fresh deal changes them.

## The three wave 7 tracks together (the merge, 2026-10-12)

- **A player's snapshot bytes:** the 10-byte header (byte 0's bits 4–7: B's rush), the cards, then P's shop bytes (`Told::extra`). The worst case, a full hand of 32 with every card honed, is 10 + 32 + 15 + 32 = 89 of `BLOB_MAX` 96; E's elite mark rides the actor flags byte, not the blob. Held by forge-play `tests/together.rs` (four full players and an elite in one snapshot the joiner reads back).
- **The deal:** B's family lean lives in `cards::deal_salted`, so the reward, P's sealed letter and P's fresh deal all lean. A full hand (`MAX_CARDS`) is dealt nothing: the reward passes it and a letter is refused (`why::TARGET`).
- **Kills and coins:** a perk's damage is the player's (`Sim::damage` with the player as attacker), so a perk's kill throws the row's coins × E's `Marked.bounty`, and each coin that reaches a player goes into P's purse once (`feel_coins`). Coins fly to the nearest player, as before wave 7: in co-op that is not always the killer.
- **Armour:** every perk's damage (blast, burst, aura, thorns, shockwave) goes through `Sim::damage`, so an armoured elite's `Marked.taken` applies to it as to a weapon's.
- **The whetstone** hones only upgrade cards (`shop::honeable`); a perk card is refused cleanly and the kit's cart does not offer it.
- **Laps after a cart:** the director's `RESUME` after P's cart runs `advance`, which starts the next lap; E's `Roster::variant` gives that lap's enemies its damage and speed.

## One selection system (v8, 2026-10-12: the cart's cards on show)

The creator on the forge zombie game v7: "The HUD/cart pop up is too small and hard to pick. We should also have a longer timer, 2 minutes. I think the old system where you pick 3 cards is still overlapping. We should only have one selection system. FInally, would love to see gold and score back on the display"; asked how cards and the cart become one, "Cart only, no free cards" (`research/rust-engine/evidence/creator-zombie-town-v7-feedback-2026-10-12.json`, `…-one-selection-answer-2026-10-12.json`). What changed in the core (`forge-feel/src/shop.rs`); where it disagrees with "Coins worth spending" above, this wins:

- **The cards on show.** A cart with an item of kind `card` deals three cards for each visitor as it opens (`shop::open` → `redeal`, `SALT_CARD`, the visit's seed: the reward's deal with its own salt, so the family lean applies). They are `Visitor::offers`, the bytes the paid three used to ride in (11..14), so a joiner's copy has its own three and every other player's. `op::BUY` with the card row and `arg` 0..=2 buys the card in that place: priced by its rarity (`price × 1`, `× rare`, `× epic`, then `perLap^lap × perBuy^bought` as every item; `shop::card_price`), granted at once (`cards::grant`), its place left empty (`NO_CARD`) until a fresh deal; `shop-card` {entity, a: card row, b: place}. Nothing is paid before a card is chosen, so the paid three, `TAKE` (254), the refunds and `shop-refund` are gone (`Visitor::paid`, `paid_item`, `waiting`, `take`, `give_back`).
- **A fresh deal** (`reroll`) deals the three on show again (`SALT_REROLL` + bought + 1); on a wave whose reward is open and still being chosen it deals the reward's three, as before.
- **Two minutes.** `shop.seconds` is clamped to 3..=180 (was 60), and the snapshot's seconds-left byte counts halves (to 127.5 s; it counted quarters, to 63.75). `op::SHOP`'s own seconds are not clamped.
- **`shop::state`** (forge-web `feel_shop_state`) ends with the price of each of the three on show (−1: none), so the kit shows the core's prices and never works one out.
- **Size:** both builds came out 450 bytes smaller (the paid three's code went with it): WebGPU 3,768,615 raw, WebGL2 5,235,306 raw (7,574 under the 5 MiB budget).
- **Tests:** `shop.rs` (the three on show priced by rarity and their places emptied, the state's prices, a fresh deal at the cart, two minutes in the bytes, Done taking the rest back), forge-play `the_cart_alone_shows_each_player_three_cards_and_sells_them_on_both_copies` (two copies: each its own three and the host's prices on the joiner, a joiner's purchase as the host's word, a fresh deal on both).

A game picks it per spec: Zombie Town's waves ask for no reward and its cart sells `card`; a game with no cart (Bone Vigil) keeps the reward screen as it was. The kit's cart (`kit/shop.js`) draws the three with the reward's own card face and inspector (`kit/cards.js` `cardFront`, `createInspector`).
