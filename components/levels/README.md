# mechanic: levels

A run of levels (gf-scenic wave 1, track M). The creator, 2026-10-08: "several levels you have to clear all monsters in and then a final boss level".

Add it to a spec as `{ "id": "levels", "as": "...", "params": { "count": 3 } }` with a scenic world that lays out levels (`isles`: one floating island each; CONTRACT §8 "Levels"). A world without levels (a party arena) plays every level in its one arena, the portal at its `portal` zone or its centre.

## The run (host)
Level i's encounter is the waves mechanic's (`startEncounter`): `wavesPerLevel` waves, `startCount + levelGrowth × i` enemies in the first (more with more players: `countPerPlayer`), tougher and faster each level (`hpScale`, `speedScale`), types by their `from`. When every enemy is down the level's portal opens (`portalZone`); when every player who is up stands in it, or `portalSeconds` after the first steps in, everyone moves on: `ctx.world.setLevel(i)` and each copy teleports the players it owns to that level's spawns (a late joiner lands on the current level). The last level is the boss mechanic's (`bossLevel` "last"); beating it, and its minions, wins the run. Everyone down at once loses it (the spec's loseBy). With `endRound` the run's end is the round's (won: everyone wins; lost: nobody). A replay starts at level 1. When a level is cleared every player is offered an upgrade card (`upgrades`, the loot mechanic) and each level gets `chests`.

## What shows
The portal: `prop.<portalProp>` when the game has that model, else a kit primitive ring in `portal-color` with a glow in `portal-glow` and a beam when open; an arrow at the screen edge points to an open portal that is off screen. Banners: `bannerText` ("Level {n}"), `bossText`, `openText`, `winText`, `loseText`. HUD: "Level 2/3 · 4 left" or "Portal open" (kit/ui/hud.js). Sounds `portal-open`, `portal-travel`.

## Network ownership
**Host owns** the run. Shared `levels`: `l` (level), `ph` (fight | open | travel | won | lost), `t` (the portal's wait), `ip` (players in the portal), `c` (levels cleared), `v` (moves through a portal). No events. Every copy applies a level change on its edge.

## Methods
`state()` (`{level, count, phase, boss, left, inPortal, seconds, portal: {x, z, r, open}, cleared, travels}`), `next()`, `restart(i)` (host), `onLevel`, `onClear`, `onWin`, `onLose`. QA staged moments: `?gf-demo=levels.clear` (each level's enemies taken down 3 s after they come) and `?gf-demo=levels.boss` (start on the boss level); verify check 15 walks into the portal on the first.

## Fixture and tests
`node research/gf-three/tests/k2-fixture.mjs levels` (scenic isles in WebGPU Chrome: the portal opens on both copies, one player in it waits, both move to isle 2, the last clear wins on both). Pure logic: `tests/k2-levels.test.mjs`.
