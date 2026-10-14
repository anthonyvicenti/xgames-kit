# mechanic: carve

Explosions bite smooth craters out of the terrain world (`worlds/terrain`), and every screen keeps the same ground.
With the projectile mechanic, every shot with a splash (`splashRadius > 0`) carves where it ends by itself.

Add it to a spec as `{ "id": "carve", "as": "...", "params": {...} }` beside `"world": { "template": "terrain" }`;
`create` fills the defaults.

## Params
`fromProjectile`, `radius` (0: the shot's splash radius × `scale`), `scale`, `minRadius`, `maxRadius`, `keep` (craters
stay from round to round), `debris`, `blastFx` and `dustFx` (vfx presets: `create` brings the vfx module), `sound`,
`splashFx` and `splashSound` (a blast on the sea, where there is nothing to carve), `shake`. Schema and defaults:
`index.js` `params`.

## Slots
`mechanic.carve.scale` (main), `.radius`, `.max-radius`, `.keep`, `.shake`. The craters are painted by the terrain's
own slots (`world.terrain.top`, `world.terrain.soil`).

## Network ownership and message rates
**Host owns** every edit. It applies it, numbers it and sends `carve:e` `{r, i, e}` (about 40 B) to everyone: one per
crater, so a bomb a second is one small event a second. `ctx.shared` key `carve`: `r` (the host's round count: a new
round starts the ground again unless `keep`) and `n` (edits this round). A copy that is not the host applies edits in
order; one that finds a gap or is behind `n` asks with `carve:want` `{r, from}` and the host answers with `carve:log`
`{r, from, l}` in pieces of about 3 KB (a late joiner catches up this way, quietly: no blasts, no debris). The watch key
frame carries the round's log. A blast on the sea carves nothing: the host sends `carve:s` `{p, r}` and every copy
splashes there. Edits are whole centimetres, so every copy applies exactly the same numbers to the same
generated ground (`window.__game.terrainHash()` equal on every screen). A blast on the sea carves nothing: the host
sends `carve:s` `{p, r}` and every copy splashes there.

## Methods for rules.js
- Host: `carve(at, r, by?)` → the edit or null (nothing there); `add(at, r, by?)` (a lump of ground: a bridge, a wall).
- Every copy: `onCarve(fn)` `{op, at, r, normal, live, by}` (`live` false while catching up); `applied()`; `observe()`.

## Tests
`tests/terrain.test.mjs` (the field, generators, mesher, the feed); `tests/terrain-two-players.mjs <game>` (host and
joiner over WebRTC: the same ground after real bomb clicks, then a late joiner gets it).
