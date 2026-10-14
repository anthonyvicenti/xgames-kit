# mechanic: boss

One big enemy with phases (gf-scenic wave 1, track M). The creator's roguelike had a boss that was the same zombie as the minions.

Add it to a spec as `{ "id": "boss", "as": "...", "params": { "name": "...", "hp": 120 } }` with a `boss` character role (its body: `character.body.boss`; else the waves enemy body; else a stand-in), `height` (scaled), `hp` (×(1 + `hpPerPlayer` per extra player)) and `phases` (hit-point shares, e.g. 0.6 and 0.3). With the levels mechanic it comes on the last level; without one (`auto`), `startDelay` s into the round.

## Attacks
Each phase plays its list (`attacks`) in a fixed, learnable order, each with a telegraph on the ground (a kit primitive in `telegraph-color`) and a red glow: `slam` (a ring that fills, `ahead` m in front; knocks down), `charge` (a lane; it runs it and stops at the island's edge, then recovers, open), `volley` (a fan of slow bolts, through the waves mechanic), `summon` (the waves mechanic's types, at most while `maxMinions` are up). A new phase: a roar (no hits for `roarSeconds`), faster (`phaseSpeed`), shorter windups (`phaseWindup`). A weapon model on `hand_r` (`weapon`, a file in `assets/models/`, with its `weaponGrip`). Clips (track C): `heavy`, `attack_enemy`, `cast`, `death`, `hit`.

## Hits read
Melee (the `b` provider in `ctx.meleeTargets`) and shots (`projectile.addTargets`) hurt it; it flashes, flinches when it is not attacking, and its name and health are a big bar across the top of the HUD (kit/ui/hud.js) with the phase marks.

## Network ownership
**Host owns** it. Shared `boss.a`: `[active, x, z, hp, max, phase, state, attack, yaw°, tx, tz, attack yaw°]` (about 60 B). Every copy draws from it; telegraphs, the slam's shake and the phase banner come from its edges.

## Methods
`begin({x, z})` (host), `state()` (`{active, name, hp, max, phase, phases, attack, state, dead, x, z}`), `damage(n, {from})` (host), `onPhase`, `onDown`, `onHit`. QA: `?gf-demo=boss.phase` (it starts just above its first threshold; with the levels mechanic the run starts on the boss level).

## Fixture and tests
`node research/gf-three/tests/k2-fixture.mjs boss` (it comes on both copies with its bar, a joiner's swing hurts it, both copies see its phases, it goes down on both). Pure logic: `tests/k2-boss.test.mjs`.
