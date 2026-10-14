# mechanic: teams

Team assignment (balanced, by seat or random), team colours on nameplates and rings, team scores, a team scoreboard. Projectile reads its friendly-fire flag, paint can paint by team.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "teams", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`count`, `names`, `colors`, `assign`, `friendlyFire`, `scoreMode` (`sum`|`manual`), `tint`, `scoreboard`, `bannerOnStart`, `youAreText`, `spawnZones`.

## Slots
`mechanic.teams.colors` (the team colours, a JSON list), `.names`, `.count`, `.friendly-fire` ... no meshes: the rings and nameplates are the kit's, retinted.

## Network ownership and message rates
**Host owns** assignment and manual points. `ctx.shared` key `teams`: `a = {playerId: team}` (about 10 B per player), `m` = manual points. Sum scores are computed on every copy from the replicated player scores. No events. Peak: 0 events.

## Netcode traps (PLAN 2.6)
Looks (colour, ring) change on the edge of an assignment, never per frame.

## Methods for rules.js
- Every copy: `teamOf(player)`, `nameOf(t)`, `colorOf(t)`, `members(t)`, `sameTeam(a, b)`, `scores()`, `score(t)`, `standings()`, `leader()`, `friendlyFire`. Host: `assignTo(p, t)`, `shuffle()`, `addScore(t, n)`, `check()`, `winnerIds()`; `spawnPoint(player)`.

Example: `check(ctx) { return ctx.time.left <= 0 ? ctx.mechanics.get('teams').check() : null; }`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-teams.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs teams` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the two are put on different teams on both copies, colours applied, the host's score point raises the team score on both.
