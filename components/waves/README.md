# mechanic: waves

Host-owned enemies in waves that chase players or a target that has health. Projectiles hit them. Drawn with a `character.body.<role>` body when the game has one, else a prop, else a capsule.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "waves", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`enemyRole`, `prop`, `color`, `height`, `startCount`, `growth`, `maxAlive`, `hp`, `hpGrowth`, `speed`, `speedGrowth`, `firstDelay`, `restSeconds`, `spawnEvery`, `nextWave` (`clear`|`timer`), `interval`, `maxWaves`, `aggro`, `attackRange`, `attackInterval`, `damage`, `contactKnock`, `hittable`, `target` (zone), `targetHp`, `killPoints`, `banner`, `bannerText`, and for hits that read (CONTRACT §6f): `oneHitKills`, `barColor`, `flashColor`, `hitKnock`, `stagger`, `deathSeconds`, `soundKill`.

## Slots
`mechanic.waves.color` (the capsule, the target ring and the tint), `.start-count`, `.growth`, `.speed`, `.hp`, `.target-hp`, `.bar-color`, `.flash-color`, `.hit-knock`, `.stagger`, `.death-seconds`, `.sound-kill` ... Enemy body: slot `character.body.<enemyRole>` when declared, else `prop.<prop>`. `oneHitKills` is not a slot: it is the spec's.

## Hits read (CONTRACT §6f; creator, "Hang Up On Them", 2026-10-07)
"The zombies are instant killed to I couldn't even tell what was happened. There was no healthbar or anything." The spec had damage 1 against 2 HP, and a hit that did not kill showed nothing, so a repair round made every shot kill. Now, on every copy, from the shared hit points alone:
- **A hit that does not kill**: the enemy flashes (`flashColor` over its own materials: the character's `glow`, or a stand-in's own material copies), flinches (the gf-humanoid-1 `hit` clip and the hurt face; a stand-in squashes), is pushed back `hitKnock` m along the shot and staggers `stagger` s on the host (a stream's ticks push a quarter as far and never stop it). A health bar shows over it from then on: the kit's UI (`ctx.ui.bars`, like nameplates; never a model), in `barColor`, what the hit took light for a moment before it drains.
- **A kill**: the body falls (the `knockdown` clip; a stand-in tips over), then sinks into the floor over `deathSeconds`, with `soundKill` (`enemy-down`, which `create` adds to games with waves). The killer's own screen shows `+killPoints` over it (`ctx.ui.pop`; the shared `k` list says who killed what).
- **Hits to kill**: a basic enemy takes 2–4 hits from the game's weapon. Defaults: hp 2 against projectile damage 1 (a stream: 4 ticks of 0.5). `create` (`tools/lib/spec-config.mjs` `enemyToughness`) raises a spec's `hp` to three hits' worth when its damage would kill in one. `oneHitKills: true` makes any hit kill, only when the spec asks: verify check 16 (`tools/lib/hits-check.mjs`) fails one-hit kills unless the locked `spec.json` sets it.
- **Aim**: the crosshair ray stops on an enemy where this copy draws it (`ctx.aimBodies`, `kit/core/aim.js`), so a shot lands on the one under the crosshair.

**QA's staged moment** `?gf-demo=waves.hit` (host): no waves; one enemy at a time stands still 6 m in front of the local player (the game's own wave-1 hit points), facing them, and a new one comes 0.8 s after each kill. Check 16 photographs it; a play-tester can too.

**Observation** (`window.__game.controls().mechanics[waves].stats`): `{demo, oneHitKills, hitsSeen, deathsSeen, dying, lastHit: {id, hp, max, t, flash, clip}, kills: [{id, hits, shots, max, from, t}] (host, the last 16), enemies: [{id, x, z, hp, max, bar, body, head, feet}]}` (screen px). A kill's `hits` counts the frames in which it took damage (a shot and the rules' own damage on it in the same frame are one hit). The bars are `#gf-ui .gf-hbar[data-key="waves:<id>"]` (`data-frac`).

## Enemy types (gf-scenic wave 1, track M; `types.js`, `bolts.js`)
With `types` the enemies fight like an action game's; without it everything above holds exactly as before (the same slots, rows and steering). A type: `{id, name, role, behaviour, hp, speed, damage, reach, arc, windup, active, recover, cooldown, knock, knockdown, telegraph, score, height, color, weight, from, weapon, weaponGrip, shield, shieldGrip}` (each behaviour's defaults in `types.js`).
- **Behaviours**: `chaser` (walks up, a readable windup, a swing in an arc), `lunger` (stops at a distance, a lane on the ground, then dashes through it), `ranged` (keeps its distance, shoots slow bolts a player can step out of or dash through), `brute` (slow, a long windup with a wide ring, a blow that knocks down; light hits do not interrupt it: poise), `shielded` (blocks hits from the front while its guard is up; a heavy breaks guards; open behind or while it swings).
- **Telegraphs**: the windup leans back, glows in `telegraph-color` and fills its mark on the ground (a kit primitive: a sector, a ring, a lane or a line) before it lands: what the mark covers is what the attack reaches.
- **Attack tokens** (Knuckle Row): at most `attackTokens` (+ half a token per extra player) wind up or swing at once, `tokenCooldown` apart; the rest wait on a ring round their target.
- **Hits on players** go through fair play and a dash's invulnerable frames (melee `dodging`). Light swings push; brutes knock down.
- **Melee**: the `w` provider in `ctx.meleeTargets` (each target once a swing; the guard; a push of 0.07 × knockback m; a heavy breaks poise). Hit-stop freezes its drawn body on the striker's copy.
- **Levels**: `manage()`, `startEncounter({level, waves, startCount, growth, hpScale, speedScale, mix})`, `encounterCleared()`, `endEncounter()`, `clearAll()` (host); in a scenic world with levels enemies come out across the current level's `arena` zone, away from the players, and keep on its island. `spawnType(type, at)` and `fireBolt(at, yaw, opts)` serve the boss. `hpPerPlayer` makes co-op a fight.
- **What shows**: per-type bodies (`character.body.<role>`, tinted, scaled to `height`), weapons and shields on their KayKit grips (slots `mechanic.waves.<type>.weapon` / `.shield` when the files are in `assets/models/`), track C's clips (`attack_enemy`, `heavy`, `cast`, `death`), sounds `enemy-windup`, `enemy-swing`.
- **Wire**: a typed row is `[id, x, z, hp, max, type, state, yaw°]` (about 36 B); `w` adds `[level, encounter on, encounter cleared, tokens]`; bolts are shared `wb.l` (`[id, x, z, vx, vz, radius]`, at most 16).

## Network ownership and message rates
**Host owns** every enemy, the director and the target's hit points. `ctx.shared` key `waves`: `e` = `[id, x, z, hp, max]` per enemy (about 28 B; `maxAlive` 24 = 0.7 KB, default 14 = 0.4 KB), `w` = `[wave, kills, targetHp, phase]`, `k` = `[[enemy id, killer id], …]` (the last 6 kills). Other copies ease toward the snapshot and face their movement; a drop in an enemy's hit points is the hit edge (flash, flinch, bar), an enemy leaving the list is the death edge (the fall and the sink). No events. Peak: 0 events.

## Netcode traps (PLAN 2.6)
Enemies move only on the host (kinematic, y = 0), so there is nothing to desync; the projectile mechanic hit-tests them against their drawn-and-host position with the same sweep as players. Hit and death effects come from the shared state's edges, so every copy shows the same hits.

## Methods for rules.js
- Every copy: `state()` `{wave, alive, kills, targetHp, targetMax, phase, cleared, hasTarget}`, `enemies()` `[{id, x, z, hp, max}]`.
- Host: `damageEnemy(id, n, {from, impulse, kind})`, `damageNear({x, z}, radius, n, {from})`, `spawnOne()`, `nextWave()`, `onKill(fn)` `{enemy, from}`, `onSpawn`, `onPlayerHit`, `onTargetHit`, `onTargetDown`.

Example: `check(ctx) { return waves.state().targetHp <= 0 ? { winners: [], reason: 'lost' } : null; }`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-waves.test.mjs` (the director, steering, hits per frame, `oneHitKills`, knock, flash, the death pose, the staged spot; create's `enemyToughness`; check 16's verdict).
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs waves` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: both copies list the same enemy ids and wave number, enemies approach the same place, a hit that does not kill shows the same health bar on both, a kill removes the same id on both and both draw it going down, its bar goes with it.
- In a real game: `regressions/one-shot-zombies` (and its control) through `tools/regress.mjs`.
