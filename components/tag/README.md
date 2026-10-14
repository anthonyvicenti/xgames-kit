# mechanic: tag

Roles that pass between players on contact: tag, infection, hide and seek.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "tag", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`its`, `mode` (`swap`|`infect`), `radius`, `cooldown`, `hideSeconds`, `color`, `prop`, `markerSize`, `toast`, `toastText`, `soundTag`, `knock`.

## Slots
`mechanic.tag.color` (tags the marker over the it), `.its`, `.radius`, `.cooldown`, `.hide-seconds` ... The marker can be a `prop.<params.prop>` model.

## Network ownership and message rates
**Host owns** who is it, the cooldowns, the hide timer and time-as-it. `ctx.shared` key `tag`: `t` = ids of the its, `h` = hide seconds left, `ti` = seconds as it per player (updated 2/s). Event `tag:fx` (host -> all, once per tag for the sound; at most 1 per cooldown). The it's controller is held off on its own copy while hiding (an edge). Peak: well under 1 event/s.

## Netcode traps (PLAN 2.6)
Contact is the closest approach of both walkers between their last two samples; the toast and sound fire on the change of the it list, not per frame.

## Methods for rules.js
- Every copy: `isIt(player)`, `its()`, `notIt()`, `itTime(player)`, `itSeconds(player)` (whole seconds: the one to score with while the round runs, since a fraction never matches on two screens), `hiding()`. Host: `makeIt(p)`, `clearIt(p)`, `tag(from, to)`, `onTag(fn)` `{from, to}`, `botStep(bot)` (call from `rules.bot`).

Example: `tag.onTag(({ to }) => { to.score -= 1; });  check(ctx) { return tag.notIt().length === 0 ? { winners: [], reason: 'all tagged' } : null; }`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-tag.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs tag` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the host starts as it or not (random), moves to the other, the role passes on both copies in the same frame range, the marker moves.
