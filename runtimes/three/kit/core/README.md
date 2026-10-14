# gf-three kit core: a map of the files

The API (what a game, a mechanic or a module sees) is `research/gf-three/CONTRACT.md`; this page only says which file
does what, and points at the section that documents it. History is in `research/gf-three/CHANGELOG.md`.

| File | What it does | CONTRACT |
|---|---|---|
| `boot.js` | `boot({rules})` for the three runtime (its standard-3d, scenic-3d and flat-2d profiles): builds `ctx`, runs the frame, publishes `window.__game` | §3, §11 |
| `boot-forge.js` | The same for a forge game, with no three.js | §8 forge 2 |
| `boot-vista.js` | The same for a vista game: the WebGPU probe first, then the vendored core | §8 vista 2 |
| `refusals.js` | The refusal list: `refuse(code, message, key)`, `list()`, `CODES`, `MAX`; the goal line's length rule | §7 |
| `guard.js` | What game code cannot do to the kit's things (hidden or covered UI, presses, the pointer lock, swallowed input, the camera, failing hooks), and `Math.random` seeded inside rules hooks | §7, §3.7 |
| `rng.js` | Seeded random numbers (`createRng`, `fork`) | §3.2, §3.7 |
| `input.js` | The local player's keyboard, mouse (lock, drag, follow in full screen) and touch | §3.2 `input`, §6d |
| `aim.js` | The point under the crosshair, `aimTarget`, `ctx.aimBodies` | §6d C1, §6f H4 |
| `fair.js`, `fair-logic.js` | Fair play's runtime (`ctx.fair`) and its pure rules (`FAIR_DEFAULTS`, `fairConfig`) | §6c |
| `quality.js` | The quality tiers; `drawsOnCard` | §3.2 `quality`, §1.2 `gf-backdrop` |
| `resolution.js` | The pixels drawn, following the screen, the frame-rate guard | §6i |
| `slots.js` | The core's own slot declarations (`round.*`, `players.*`, `rules.*`, …) | §2.2 |
| `live-slots.js` | The page's `gf:slot` messages, dev only | §2.4 |
| `show.js` | Studio preview subjects (`?gf-show=`) | §6 |
| `sight.js` | `window.__game.sight(ids)`: a slot's share of the player's view | §11 |
| `step.js` | Stepped time (`?gf-step=1`) | §1.2 |
| `util.js` | Collision groups, `physicsOf(ctx)`, shared helpers | §4.4 |
| `standins/` | The look, world and character that run when the real module is missing | §1.3 |

## The boot, in order (`boot.js`)

1. `listenForHost`, `listenForLoadout` (the page's wallet and loadout: §6g, §6e).
2. `assets.init()`: `assets.json` and every JSON a value slot points into; a backdrop on a machine with no graphics card
   stops here (§6h F2).
3. `ctx.fair`, `ctx.bots`; the modules `kit.js` lists (§1.3).
4. Seed (`?seed=` → `net.seed` → random), quality tier, `look.createRenderer`, `look.ready`, `look.applyLook`, the
   pixel ratio (§6i).
5. Rapier (`ctx.physics`, `ctx.RAPIER`), `world.loadWorld` → `ctx.world`.
6. `?gf-show=<subject>` stops here and shows the subject (§6).
7. Audio, input, UI, HUD, the goal line.
8. Mechanics: `create(ctx, params)` for each `config/game.json → mechanics[]` whose module the kit carries.
9. The flow, the session (players and bots), `ctx.round`; then `fair.setup()`, each mechanic's `setup(ctx)`, and
   `rules.setup(ctx)`. Then, dev only, the page's `gf:slot` messages are heard.
10. The menu; alone the home menu (or `?gf-autoplay=1`), live `net.ready()`.
11. `window.__game`, then the frame through `net.loop` (§3.5).
