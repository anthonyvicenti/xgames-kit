forge-feel is track F's crate (research/rust-engine/PLAN.md §4): how a first-person forge game feels, data-driven from
the tables (`spec.forge.player`, `weapons`, `feel`; the kit's `tables/player.js`, `weapons.js`, `feel.js`) and measured
against research/rust-engine/feel-targets.md by the native fixtures in gf-forge/fixtures/feel/ (18 scripts, 186
measures, every one met: fixtures/feel/RESULTS.md). It plugs into forge-core only through its ways in (core/ARCHITECTURE.md).
The DOM side is the kit's gf/forge/feel.js; the test room is made by create from gf-forge/specs/feel-room.spec.json (port 5825).

Status (2026-10-10): the numbers are the native core's in the fixtures and a scripted play of the feel room in WebGPU
Chrome (evidence/feel-room-2026-10-10). Nobody has played it but scripts; that is not the creator's verdict.

## What runs

| System | Stage | What |
|---|---|---|
| `core.move` (replaced) | Feel | the controller: a straight first burst to `burst.share` of the walk in `burst.time` (5.3 m/s by 27 ms), then 90% at `accelTime`; the exponential stop; jump with coyote and buffer; the evade (speed solved from `evade.distance`, driven `evade.time`, capped at `evade.peak`), stamina shared by jump and evade; the body rests on the ground (see "Core issues") |
| `feel.aim` | Feel | aim help: the look turns toward a target in the cone (players with it on) |
| `feel.weapons` | Feel | switching, reloads, the quick melee, firing (hitscan pellets, projectiles converging on the crosshair, beams, charged shots), the recoil spring, the viewmodel's snap, muzzle light, sparks, smoke, tracers, sounds, cues |
| `feel.shots`, `feel.pickups` | Feel | projectiles as swept rays; weapon pickups that give, draw and refill |
| `feel.push` | Physics, before `core.character` | a hit's push on a character (`Mover::nudge`) |
| `feel.kills`, `feel.dummies` | Physics, before `core.physics` | a kill bursts its body into rapier debris (its regions, `enemies[].debris` or `feel.kill.pieces`), dust/sparks/bone chips, a coin, the layered sound; severs; the debris budget and lifetimes; dummies stand again |
| `feel.severed` | Post, after `core.anim` | a severed part's bones collapse in the skin palette |
| `feel.debris`, `feel.hits`, `feel.hurt`, `feel.late`, `feel.coins`, `feel.camera`, `feel.view` | Events | knock-downs from fast pieces; each hit's flash, number, flinch and combo; the player's tint, jitter, thud, low-health stages and death; late kills; coins; the camera rig (bob, dips, eye lift, jitter, recoil, FOV punch); the feel view |

## The contract other tracks honour

**Events out** (custom kinds 32..=37, 14 words; host.js decodes them as `custom-<kind>`; `forge.feel_protocol()` names them):

| Kind | Payload | Who acts |
|---|---|---|
| 32 FLASH | target net, seconds (f), r g b (f, linear) | **R**: draw the whole body flat in that colour for that long (2-3 frames) |
| 33 TRACER | from xyz, to xyz, rgb, seconds, width (f), source | **R**: a streak (pellets, hitscan rounds, beams) |
| 34 SEVER | target net, part (`Part`), pieces, at xyz (f) | **R**: hide the part (forge-feel also collapses its bones in the skin palette); **A**: stop the attack in progress |
| 35 KNOCK | target net, seconds (f), dir xyz (f), by | **A**: stop the attack, lay it down for that long (`fall`, then `rise`); forge-feel also pushes it 3 m/s for 0.25 s |
| 36 LABEL | name id, at xyz (f), player, value | feel.js (a floating word: "launched") |
| 37 WEAPON | player, what (1 fire, 2 reload, 3 reloaded, 4 switch, 5 swing, 6 contact, 7 empty), row, value (f) | **R**: viewmodel cues on their exact step |

Core events forge-feel emits: LIGHT for the muzzle (about 1 m in front of the eyes) and impacts with `frames`
(**R**: draw `frames` display frames, fading; the reference's muzzle curves are 1.8 → 1.6 → 0.93 → 0.27 for the shotgun,
0.95 → 0.28 for the pistol, impacts lose about 0.28 a frame), PARTICLES named `sparks`, `smoke`, `dust`, `bone` (**R**:
the library's fx), SOUND by name, UI (`UI_DAMAGE` numbers, `UI_COMBO`), MOTION (jump, evade), RULE `kill` (entity: the
killer; a: target net, b: its row, c: the combo multiplier, d: the hits it took), `coin` (entity: the player, a: value),
`pickup` (entity, a: the weapon row), `player-dead` (entity: the player; a: the attacker's net id, b: the final blow, c:
health before it, d: the armour it took).

**Entities:** debris pieces are `kind::DEBRIS` with `type_` = `piece::{SKULL 0, RIBCAGE 1, BONE 2, SHORT_BONE 3, CHIP 4}`
(**R**: library debris models; long bones lie along Z: shapes in kills.rs `piece_for`); coins kind 16; target dummies
kind 17 (a humanoid's regions on a static capsule); projectiles `kind::PROJECTILE` with `type_` = the weapon row (**R**: a
streak in the row's `tracer` colour); weapon pickups `kind::PICKUP` with `type_` = the row.

**Components forge-feel sets on others' entities:** `kills::Knocked { left }` and `kills::Severed { parts, bones }`
(A reads them if it depends on forge-feel; otherwise the KNOCK and SEVER events say the same), a severed part's hurt
regions get radius 0, `hits::Push`. A dead body is despawned by `feel.kills` before the rapier step of its kill (an enemy
row with `debris: 0` keeps it: A plays its death). Every KILL reaches A's Ai stage before that.

**The feel view** (`forge.feel_view()`, `view::NAMES`, fixed order): weapon, slot, ammo, magazine, reload, reloading, raise,
swing, swingRow, swingQuick, viewKick, swayX, swayY, bobX, bobY, recoil, tint, stage, health, armor, stamina, evadeCool,
evading, fov, combo, comboMult, comboLeft, dead, assist, charge, spread, shake, head, held, shots, hits, kills, bestCombo,
debris, player. **R** draws the viewmodel from it (the feel room's rules.js has a stand-in).

**Commands in** (ops 65..73, ints first): LOADOUT (id, rows…), GIVE (id, row, draw), EQUIP (id, row), DUMMY (x y z yaw hp
every), PICKUP (row; x y z every), SETTINGS (id, aim help 0 off / 1 touch / 2 mouse / 3 on), REFILL (id), RESET (id: health,
tint, combo, recap, ammo), CLEAR (debris, coins, shots).

## Core issues found (forge-core is not this track's: reported, worked around here)

1. **The character controller stalls on a flat floor** about one step in a hundred (no travel at all; the 1a walk too:
   `cargo run -p forge-feel --example dbg-walk -- core` counts 11 of 1049 moving steps). Pressing the grounded capsule into
   the floor every step causes it; forge-feel's controller rests on the ground instead (0 of 1049).
2. **`core.character`'s wall rule takes rapier's spurious contacts**: a (0.67, 0.14, 0.73) "wall" on a full-length first
   step halved the velocity. forge-feel keeps its own intended velocity and takes the cut only when the travel fell short.
3. **`Physics::refresh()` after bodies are added or removed between steps trips rapier 0.36's island checks** (debug
   builds; `examples/dbg-rapier.rs`), and so does an idle kinematic body struck by new debris. forge-feel adds and removes
   bodies just before the rapier step and poses its dummies every step.
4. **Events from commands** (the host's DAMAGE) land before the first step, so no system's `step_events()` sees them:
   forge-feel reads players' health changes and dead bodies instead.
5. **The drawn camera is one 120 Hz step behind at 60 Hz** (`views` interpolate with alpha ≈ 0: the step before the last).
   The walk fixture's "frame 2, as drawn" records 4.3 m/s against the body's 5.3.

## Run

```bash
cargo test -p forge-feel                                     # units, and every feel fixture against its targets
node gf-forge/tools/fixtures.mjs feel [--table]     # the fixtures, printed (or as one Markdown table)
node gf-three/tools/create.mjs gf-forge/specs/feel-room.spec.json <dir>; cp gf-forge/specs/feel-room.rules.js <dir>/rules.js
node gf-three/tools/serve.mjs <dir> --port 5825    # the test room
node gf-forge/tools/feel-room.mjs                   # a scripted play of the room, screenshots → evidence
```
