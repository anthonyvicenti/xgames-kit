# mechanic: race

Checkpoints, laps and a finish order, with gates drawn in the world.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "race", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`checkpoints` (`[[x, z], ...]` or an automatic ring of `ringCount` gates), `ringRadius`, `laps`, `radius`, `color`, `nextColor`, `gateSize`, `prop`, `placePoints`, `ending` (`first`|`all`|`never`), `toast`, `lapText`, sounds.

## Slots
`mechanic.race.color` (tags the gate rings), `.next-color`, `.laps`, `.ring-count`, `.gate-size` ... A gate can be a `prop.<params.prop>` model instead of a ring.

## Network ownership and message rates
**Host owns** progress and the finish order. `ctx.shared` key `race`: `r = {playerId: [lap, cp, place]}` (about 14 B per player), `o` = finish order. No events. Peak: 0 events.

## Netcode traps (PLAN 2.6)
Gate crossing is a segment test between last-frame and current positions, so speed cannot skip a gate; sounds fire on the edge of progress changes.

## Methods for rules.js
- Every copy: `progress(player)` `{lap, cp, place, fraction, done}`, `nextGate(player)`, `standings()`, `finishOrder()`. Host: `check()` (for `rules.check`), `botStep(bot)`, `onCheckpoint|onLap|onFinish(fn)`.

Example: `check: ctx => ctx.mechanics.get('race').check()`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-race.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs race` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the host is teleported through the gates in order, both copies show the same lap/checkpoint, the host finishes first and the finish order is `[host]` on both.
