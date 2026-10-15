# mechanic: pickup

Collectables at fixed spots: walk into one or press interact (E) next to it, and it comes back after a delay. Heal, score, hand you a carried item, or call your rules.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "pickup", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`prop`, `count`, `zone`, `size`, `color`, `effect` (`auto`|`carry`|`heal`|`score`|`none`), `value`, `radius` (touch distance), `collect` (`touch`|`press`|`both`, default `both`), `reach` (press distance, 2 m), `action` (`interact`), `prompt` (true), `respawnSeconds`, `bob`, `spin`, `maxSpots`, `soundCollect`, `marker` (`auto`|`ring`|`none`).

## Interact (CONTRACT §6d)
Creator, T1 run 5: "I cant seem to ... drink". The HUD said "E: grab a drink" and E did nothing: spots were only taken by
touch. Now a press of `action` within `reach` takes the nearest spot (`collect` `both` or `press`), and walking into one
still does (`both` or `touch`). Near a spot the HUD prompts `E: <controls.interact>` (the game's own words). Every
collect shows on every copy, whatever the rules then do with it: the item flies into the collector and shrinks, with
the collect sound. `interactables()` lists what can be pressed (verify check 13 walks to one and presses E). A joiner's
press goes to the host as `pickup:press` (1 m of slack for latency).

## Slots
`mechanic.pickup.color` (the stand-in gem and the ring on the ground), `.respawn-seconds`, `.value`, `.radius`, `.marker` ... Drawn with the game's `prop.<name>` model (the spec's prop whose role says players pick it up, e.g. "drink to refill"), else a gem.

## How pickups look
- The game's own prop, bobbing and turning, fitted to `size` (0.5–0.7 m reads well from the third-person camera).
- `marker`: a faint thin ring on the ground under each spot. `auto` (default) draws it only under the stand-in gem, because a real model reads by itself; `ring` always; `none` never.
- Where spots go (the creator, 2026-10-14: "there were no berries anywhere. I think in the ocean I saw some boxes but
  those are impossible to get"): `ctx.world.place('pickup', count, {zone})` (worlds/placement.js): on open ground every
  seat reaches, at the ground's own height, clear of colliders and cliff edges, spread out, in `zone` when one is named.
  Never in the sea, inside the ground or walled off. When there is no more room it places fewer and says why
  (`objectives().shortfall`); gate D (measure 6) fails that. A spot that comes back stands on the ground as it is then
  (a crater), or moves to open ground. `spawnAt({x, z})` with no `y` stands on the ground there.
- `objectives()` lists every spot for `window.__game.objectives()`, which holds each to every seat.
- With no `rules.bot`, bots go for the nearest spot (the world routes the way: round walls, over bridges, up ledges).
- A gem means the game names no pickup prop. The set-dressing lint (`tools/dressing.mjs`) fails that (`pickup-standin`), and it fails scenery that looks like a pickup (`looks-collectable`).

## Network ownership and message rates
**Host owns** the spots and who touches them. `ctx.shared` key `pk`: `p = [x, y, z, state]` per spot (about 20 B; `maxSpots` 24 = 0.5 KB). Event `pickup:got` (host -> all, once per collect, for the sound; about 3/s peak). Respawn pop is an edge of the state field on every copy.

## Netcode traps (PLAN 2.6)
Touch is a segment test between the player's last two positions, so a fast pass cannot skip a spot; everyone reacts to the state change, not per frame.

## Methods for rules.js
- Host: `onCollect(fn)` `{player, index, effect, value, point, how: 'touch'|'press'|'rules'}`; `collect(i, player)`; `spawnAt({x, z}, {respawn})`; `remove(i)`; `set(i, present)`; `stats` `{touch, press, pressMissed}`.
- Every copy: `list()`, `presentCount()`, `nearest(pos)` (for bots), `press(player)` (as a press of the action would), `interactables()`.

Example: `pk.onCollect(({ player }) => { player.data.ammo = (player.data.ammo ?? 0) + 5; });`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-pickup.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs pickup` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the host walks onto a spot, it disappears on both copies, the host's score rises on both, the spot returns on both after the delay.
