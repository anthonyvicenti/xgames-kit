# kit/flat: a 2D game in the one system

A flat game is `"runtime": "three", "profile": "flat-2d"` in the spec; its camera says its plane (`top`: seen from above, world `field`; `side`: seen from the side with gravity, world `stage`). Inside the kit it is the three kit with four parts swapped: the same boot, session, net, bots, fair play, HUD, menu, sounds, slots, mechanics and flows. `gf/three/kit.js` says `profile: "flat-2d"`, and `modules.flat` names the plane.

| File | What it is |
|---|---|
| `index.js` | The part's manifest, read by the tools only: planes, styles, looks, worlds, the mechanics run on each plane (`runs`), the note a build reads, and what a check should read in a flat game (`reads`, `worldReport`, `bodyReport`). Pure |
| `slots.js` | The declarations: styles, looks, what a flat spec may name (`refuse`), `config/look.json` and `config/world.json`, the picture slots. Pure |
| `tilemap.js` | The tile map (`gf-tilemap-1`): read and check it, merge solids into boxes, the jump reach model, a generated map. Pure |
| `judge.js` | The picture judge (`gf-flat-1`): body sheets, props, tiles. Pure |
| `look.js` | The orthographic camera, the two styles' filtering, the pixel snap, a picture slot as a card (the seam every mechanic's `assets.model()` goes through) |
| `drawplan.js` | What a top-down map draws and where: the base, the kinds, soft "blend" edges on the cells' corners, "connect" fences and walls, dressing, set pieces standing near over far, their shadows. Pure; the world and the look judge's sheet both draw it |
| `world.js` | The world from the tile map: meshes from the draw plan (side-on: one mesh a tile kind), Rapier boxes for solids, one-way ledges, spawns, marks |
| `character.js` | A body that is a picture sheet (1 row, or 3 rows by heading); the seat colour on its light greys only; from above, a shadow and the near-over-far order |
| `controller.js` | The kit's own controller with a flat camera rig; side-on: the ledge rule, the portrait rule, bots that hop |
| `module.js` | Makes `create` carry this folder into a flat game and no other |
| `ART-STANDARD.md` | What a picture must be, for whoever makes them |

Tools: `runtimes/three/tools/pixel/` draws the pixel style's own art (`folk.mjs` the villagers, `town.mjs` the tiles, edges, dressing, props and set pieces, `packs.mjs` takes them into the asset library: `flat-standins-pixel`, `xk-pixel-folk`, `xk-pixel-town`), `builder/tools/flat-map.mjs` checks a map. A whole town to copy: `runtimes/three/worlds/pixel-town.json`. Examples: `examples/minimal/coin-hop` (side-on, drawn), `examples/minimal/market-day` (from above, pixel). Tests: `tests/flat-pixel.test.mjs`.

## Seams outside this folder

Each is written for any part that brings the same thing, not for flat by name:

| File | The seam |
|---|---|
| `core/boot.js` | `kit.js modules.flat` picks the four modules; a look may bring its camera (`createCamera`, `resizeCamera`) and frame the preview (`frameSubject`); a rig that places itself (`rig.place`) keeps the menu and a viewer's camera; a body may say where its name goes (`plateOffset`); a sound's distance under an orthographic camera |
| `net/players.js` | the controller is the game's kind's when its parts bring one; "can this player see that one" runs along an orthographic view's own direction |
| `controller/capsule.mjs` | `setQuery(groups)`: what a body's ground probe sees, settable per step (the ledge rule) |
| `mechanics/pickup/index.js` | `touchHeight` (a param): how far above or below a spot a body may be and still take it |
| `ui/ui.js` | the control hint of the `side` camera |

## Not done

- Mechanics on a plane beyond `pickup` (both planes) and `board` (top): `create` refuses the rest as "not run on the flat plane yet".
- Slopes, moving platforms, death pits (the map's bottom is closed), parallax backdrops, animated tiles; side-on edges and dressing (only `cap`).
- Edges, dressing and set pieces on Godot 2D (it draws the plain tiles), and Godot's seat colour still multiplies the whole body.
- Bots do not plan a route up the ledges: they hop when blocked and now and then.
- The settings menu still offers mouse sensitivity, which does nothing here.
- Checks that assume 3D (13 side-on, 17, 19, 24, and 8, 9, 34): the part declares what they should read (`index.js` → `reads`, `worldReport`, `bodyReport`); the checks are track V's.
