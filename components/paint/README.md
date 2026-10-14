# mechanic: paint

Paints the ground and its zones per player or team from hit points, gives coverage per owner, can be repainted. An owner grid of a few hundred cells, drawn as one soft decal: cheap on the low tier.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "paint", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`by` (`player`|`team`), `cell`, `maxCells`, `radius`, `repaint`, `opacity`, `height`, `fromProjectile`, `streamRadius`, `walkRadius` (ink trail), `walkInterval`, `zones` (names to report).

## Slots
`mechanic.paint.opacity` (tags the paint decal), `.radius`, `.repaint`, `.walk-radius` ... Paint colours are the owners' colours (look palette or team colours).

The decal is lit like the ground under it: the look's `decal` house material (the ground's wrap, bands, shadow floor and colour treatment, without the ground's noise detail), else a standard lit material, and it receives shadows. It darkens under a player and at night instead of glowing on top of the scene (it was an unlit `MeshBasicMaterial`). Test: `research/gf-three/tests/p-mechanics.test.mjs`.

## Network ownership and message rates
**Host owns** the grid. `ctx.shared` key `paint`: `g` = the grid as a run-length string, sent at most 10/s and only when changed (400 cells: 20-400 B, 400 B worst case). Every copy decodes it and redraws the decal. No events. Peak: 0 events, one string in the world message.

## Netcode traps (PLAN 2.6)
Splats come from the host's projectile hit points (`onSurface`), not from per-copy guesses; drawing reacts to a changed string (an edge).

## Methods for rules.js
- Host: `splat(player|teamIndex, {x, z}, {radius})` -> cells changed; `clear()`; `fill(owner)`. Paint under projectile hits is automatic when `fromProjectile` is on.
- Every copy: `coverage()` `[{owner, index, label, color, cells, share}]` biggest first; `coverageOf(player|teamIndex)`; `painted()`; `zoneOwner(zoneName)` `{index, share, cells}`.

Example: `const top = paint.coverage()[0]; // { label: 'Red', share: 0.41 }`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-paint.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs paint` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the host splats, the joiner's decoded grid is identical (same cell count and coverage), a repaint by the joiner changes the host's coverage.
