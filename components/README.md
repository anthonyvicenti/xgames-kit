# components/

The mechanics, one folder each (`components/<id>/`): one behaviour with its params schema, slots, events, host
ownership, bots, notes and a two-player fixture. In a game a mechanic sits at `gf/three/mechanics/<id>/` and imports the
three kit as a game sees it (`../../core/util.js`): `builder/tools/lib/paths.mjs` (`GAME_TREE`) assembles it there.

Each mechanic's three implementation is the folder itself. A second runtime's lives in `impl/<runtime>/` and comes with
its own evidence, never by a shared label: health, loot, pickup and waves have `impl/forge/` (loaded by
`runtimes/forge/kit/mechanics.js`), each with a two-player fixture in `impl/forge/fixture/` that
`runtimes/forge/tools/fixture.mjs` plays with two browsers. A need no mechanic covers is built in the game
first (its `src/`) and moves here after a second game needs it. `npx gamesfun catalog mechanics` lists them. Where
everything else is: [docs/LAYOUT.md](../docs/LAYOUT.md).

A mechanic that places things players go for (spots, gates, zones) lists them with `objectives()` → `[{id, kind, x, y, z,
open, touch?, reach?, radius?}]` (pickup and race do); the play feed (`runtimes/three/kit/core/play.js`,
`window.__game.play()`) reads it, else the mechanic's `interactables()`, and gate D's play leg holds every one to a
player's reach ([builder/play/JUDGE.md](../builder/play/JUDGE.md)). A manifest event may say its play type:
`events: [{name, play: 'pickup'}]` (score, hit, knockout, pickup, goal, death, combo, move, tag, blast, attempt).
