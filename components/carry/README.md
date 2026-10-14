# mechanic: carry

Grab, carry, drop and throw props (optionally friends). Held items sit in the character's hand socket.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "carry", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`prop`, `count`, `spawnZone`, `size`, `color`, `maxHeld`, `reach`, `grabAction`, `throwAction`, `throwSpeed`, `throwArc`, `gravity`, `bounciness`, `holdHeight`, `socket`, `grabPlayers`, `maxItems`, `soundGrab`, `soundThrow`. `grabAction: 'interact'` grabs (or drops with nothing in reach); `throwAction: ''` leaves throwing to rules (`carry.throw` or projectile).

## Controls (CONTRACT §6d)
Near a free item, with room in the hands, the HUD prompts `E: <controls.interact>` (when `grabAction` is `interact`).
`throw(player)` with no direction goes to the thrower's crosshair point (the arc that lands there, `kit/core/aim.js`);
with a direction it keeps the `throwArc` lob. The instance is `aimed` when `throwAction` is set (the kit shows the
crosshair) and lists free items in `interactables()` (verify check 13).

## Slots
`mechanic.carry.color` (the stand-in box), `.throw-speed`, `.reach` ... The item is drawn with the game's `prop.<name>` model slot, else a coloured box.

## Network ownership and message rates
**Host owns** every item (rest, flying, held) and who holds it. A player's copy owns only its request. `ctx.shared` key `carry`: `i` = `[id, x, y, z, holderSeat|-1, flying, vx, vy, vz]` (about 30 B, +12 B while flying; `maxItems` 24 = 0.7 KB), `cp` = carried-friend map. Flying items are integrated locally between snapshots. Events: `carry:grab|drop|throw|consume` (player copy -> host, one per key press, about 3/s), `carry:held` (host -> the carried friend, 2 per grab). Carrying a friend: the host teleports them 10/s through the kit's routed `teleport`. Peak: about 3-4 events/s, +10/s only while a friend is carried.

## Netcode traps (PLAN 2.6)
Held items are drawn at the hand on every copy from the holder's drawn position (no per-frame traffic); a throw starts from the hand, never from a stale position; item sounds fire on the change of holder (an edge).

## Methods for rules.js
- `grab(player)`, `drop(player)`, `throw(player, dir?, {speed})`, `consume(player)` (remove what they hold: thrown by another mechanic), any copy for an owned player.
- Every copy: `held(player)` -> `{id, prop}`|null, `heldCount(player)`, `items()`, `nearest(pos)`. Host: `give(player)`, `spawn({x, z})`, `toss(pos, vel)`, `onGrab|onDrop|onThrow(fn)`.

Example: `if (me.actions.primary.pressed && carry.held(me)) { prj.fire(me); carry.consume(me); }`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-carry.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs carry` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the host's ball is grabbed by the joiner on request (one winner), the held ball shows in the joiner's hand on both copies, a throw lands in the same rest place on both.
