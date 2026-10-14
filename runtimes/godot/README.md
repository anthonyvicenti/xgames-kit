# runtimes/godot

Godot 4.6 as a full runtime of the xgames kit: a game whose world, physics and drawing are a Godot project, played in
the browser as Godot's web export (WebGL2 compatibility rendering, one thread, so no cross-origin isolation), with
everything shared (slots, the round and the friends, bots alone, the menu, HUD and panels, Go live and voice, sounds,
`window.__game`, the gates) running in the page around it. The two talk through Godot's `JavaScriptBridge`, once a
frame each way. A three.js game never installs Godot: the toolchain comes the first time a game picks runtime godot.

```
runtimes/godot/
├── runtime.json            the manifest (registry's runtime schema): limits, toolchain, the nine clauses, measures
├── gamesfun.mjs            what `gamesfun create / verify / dev` call for a godot game (one seam each in builder/)
├── create.mjs              the create adapter (runtimes/CONTRACT.md §2): create({spec, out}) → {files, slots, record}
├── toolchain/              toolchain.json (the editor and the web template, by sha256), export_presets.cfg, licences
├── kit/                    the page side, vendored into a game as gf/godot/ (boot, bridge, engine, players, world, shared,
│                           touch: the phone layout)
├── addon/                  the GF autoload and its parts, vendored into a game's project as addons/gf/
├── templates/              the starters create writes: 2d-side, 2d-top, 3d-follow (project.godot, main.tscn, main.gd),
│                           and game/ (the game's AGENTS.md for the person's agent)
├── tools/                  install, export, create, example, dev, measure, judge, verify (lib: the outside paths in one table)
└── evidence/               dated verify runs (verdict.json in the gates' format, checks.json, screenshots)
examples/minimal/godot-ledge-friends, godot-meadow-walk, godot-arena-friends; examples/showcase/godot-coin-hop
tests/godot.test.mjs        what runs without a browser or Godot
```

## Starters (a spec picks one by its camera)

| camera | profile | world | what create writes |
|---|---|---|---|
| `side` (the default) | `2d` | `stage` | a side-on stage from a gf-tilemap-1 map: run, jump, one-way ledges, drop through |
| `top` | `2d` | `field` | a field seen from above (generated from the title unless the spec draws one): walk eight ways, walls and water stop you |
| `follow` (or profile `3d` alone) | `3d` | `arena` | the same kind of map built in 3D, gf-humanoid-1 bodies from the asset library played with the kit's shared clips, a three-quarter follow camera |

create refuses only what cannot boot here (a camera with no starter, a world the camera's starter does not build, room
multiplayer). A loop the runtime has not proven is a note and a build item on the round loop, never a refusal.

## A game on runtime godot

```
game/
├── index.html, main.js       main.js: boot({rules}) from gf/godot/boot.js
├── rules.js                  the round's rules in JavaScript (scores, the host's shared state), as on every runtime
├── project/                  THE GAME: a Godot project. main.gd is the build agent's; addons/gf/ is the kit's
├── build/                    its export: game.js + game.wasm (the pinned template's bytes) + game.pck; godot-build.json
├── config/, assets.json, multiplayer.json, spec.json, xgames.json, ATTRIBUTION.md, AGENTS.md, assets/
└── gf/godot/, gf/three/ (the shared, three.js-free parts), gf/mp/, gf/gf-assets.js, audio/
```

Godot draws and moves; the page owns everything shared. create fills every file slot from the asset library
(library/packs; `art.json` names godot's packs). Every picture and model is a slot read at run time through
gf-assets (`GF.texture("world.tiles.grass")`, `GF.bytes("character.body.player")`), so Studio's replaced files and
changed values reach the game with no new export. 2D uses three's flat-2d art standard and map format (gf-flat-1 body
sheets, tiles and props; the gf-tilemap-1 map in `config/world.json`); 3D uses the library's gf-humanoid-1 bodies (gf-beans by default) and
the clip file their manifest names, decoded to plain GLBs at create (Godot's runtime glTF reader takes no meshopt).

Seen from above, a field is drawn as three's flat-2d draws it: the page plans it with three's own
`gf/three/flat/drawplan.js` (the base, the kinds, soft "blend" edges on the cells' corners for a path or a pond,
"connect" kinds joined to themselves for a wall or a fence, dressing such as tufts and flowers on a share of a kind's
cells, set pieces such as a house or a tree standing on their footprint's near edge with a shadow) and hands the plan to
`GfTilemap2D` (`GF.world.plan`); create fills the edge sets, dressing strips and set pieces from the library
(`xk-pixel-town`) and they are slots (`world.edges.<kind>`, `world.dress.<kind>`, a piece's `world.tiles.<kind>`). The
set pieces stand in a y-sorted parent with the bodies, so a body walks behind a roof and in front of a door. A body's
seat colour goes onto the picture's light greys only (a shirt), as on three; skin, hair and clothes keep their colours.

## The GF autoload (`addon/gf.gd`)

```gdscript
func _ready():
    await GF.boot()                                      # config, map, values and this player are in
    var sheet := await GF.texture("character.body.player")
func _physics_process(dt):
    GF.set_pose(me.position, face, "walk")               # 2D: what every friend's copy draws of this player
    if touched: GF.event("coin", {"i": 3})               # → rules.event(ctx, "coin", {i: 3}, "godot") on this copy
```

| Read | What |
|---|---|
| `GF.phase`, `GF.playing`, `GF.input_on`, `GF.paused`, `GF.host`, `GF.me`, `GF.peers`, `GF.bots`, `GF.shared`, `GF.world`, `GF.config`, `GF.ppm`, `GF.style`, `GF.plane`, `GF.is_3d`, `GF.watching`, `GF.follow` | the kit's state (2D peers carry `at` in pixels; 3D peers `at3` in metres and `yaw`) |
| `GF.value(id, fallback)`, `GF.has_slot(id)` | value slots, live |
| `await GF.texture(id)`, `await GF.bytes(id)` | file slots (or game paths) through gf-assets |
| `GF.spawn(seat)`, `GF.marks(name)`, `GF.to_px(m)`, `GF.to_m(px)` | 2D: the map in pixels (1 m = `ppm` px, y down; seen from above y is south) |
| `GF.spawn3(seat)`, `GF.marks3(name)` | 3D: the map in metres, on the ground |

| Call | What |
|---|---|
| `GF.set_pose(at, face, anim, extra)` / `GF.set_pose3(at, yaw, anim, extra)` | this player's pose (2D pixels; 3D metres, the kit's yaw: atan2(dx, dz)) |
| `GF.event(name, data)` / `GF.event_as(bot_id, name, data)` | something happened (this player, or a bot): rules.js decides |
| `GF.sound(id, opts)` | a sound listed in assets.json → sounds, through gf-audio |
| `await GF.panel(kind, opts)` | the kit's panels (choice, shop, inventory, dialogue, input) over the game; the answer comes back |
| `GF.report_friend(...)` / `report_friend3(...)`, `GF.report_bot(...)` / `report_bot3(...)` | where this copy drew a friend or a bot (the parts below do it) |
| `GF.observe = func(): return {...}` | the game's own observation: `snapshot().godot.game` |

Signals: `booted`, `phase_changed`, `message` (rules.js: `ctx.godot.send`), `shared_changed`, `value_changed`,
`place_me` / `place_me3`, `bots_changed`, `panel_event`, `watch_changed`. Parts: 2D `GfFlatBody`, `GfTilemap2D`,
`GfFriends2D`, `GfBots2D`; 3D `GfHumanoid3D` (a gf-humanoid-1 body from a GLB slot), `GfRig3D` (the standard's retarget,
the same scheme as three's `rig.js`), `GfArena3D`, `GfFriends3D`, `GfBots3D`. Input goes through actions (`move_left`,
`move_right`, `move_up`, `move_down`, `jump`, `act`: WASD, arrows, Space, E); while the kit holds input (a menu, a
modal panel, the countdown, the results, watching a stream) GF takes every action's keys out of the input map, and
alone the pause menu pauses the scene tree. On a touch screen the kit's stick and buttons press the same actions
(`kit/touch.js`): the move stick is always in sight at the lower left (a resting ring; a finger anywhere on the left half
moves), the buttons are only the actions the game's controls name (Jump for `controls.jump`, Action and Use for
`controls.primary` and `controls.interact`; a walker seen from above has the stick alone), and the HUD is laid out to fit
390x844 and 844x390: the player card a slim pill in the top row beside the clock, the goal line where the scoreboard
leaves room. The phone leg of verify checks all of it held upright and sideways.

**Sound.** gf-audio, never Godot's audio (the engine starts with `--audio-driver Dummy`): one sound system for every
runtime, with its limiter, cooldowns, hidden-tab mute, the creator-approved bus levels and every sound a slot.

**Bots.** Alone, the session seats bots in the empty seats (`players.bots`, `?bots=N`); a friends round has none. The
starters move them like the player and wander between marks and spawns; a game says where they head (`bots.goal`).

**Watch then play and voice.** The pause menu's Go live and voice rows are gf/mp's; a viewer's copy has no player of its
own (`GF.watching`) and the starters' camera follows the streamer (`GF.follow`).

## Commands

```bash
npx gamesfun create games/my-game --spec spec.json        # a spec with runtime "godot" (installs Godot the first time)
npx gamesfun create games/my-game --from godot-coin-hop   # or an example
npx gamesfun dev games/my-game                            # the studio; a change in project/ exports again
npx gamesfun verify games/my-game [--release]             # the six gates; --release adds the mp gate, a phone, Firefox, WebKit
node runtimes/godot/tools/export.mjs <game> [--force]     # the export alone (GDScript errors in seconds)
.claude/scripts/gpu-run.sh node runtimes/godot/tools/verify.mjs <game> --out <dir> [--mp-gate] [--devices] [--static]
node --test tests/godot.test.mjs
```

## Measures

Six gates; what runs on godot, what is partial and what is skipped (with why) is `tools/verify.mjs → MEASURES` and
`runtime.json → measures`. Runs: `evidence/<date>-run<n>/`.

## Not yet

A slot-ID pass over what Godot draws (measure 4's other half, 15), frame-cost capture (9), the loudness gate on a Godot
game (7), the wallet's loadouts on Godot bodies, a game inside a post on X (24), a browser with no WebGL2 driven (32),
the retarget's finger shift for rigs whose finger 1 sits in the palm, touch controls tried on a real phone, Safari
(WebKit could not start on the Linux machine the runs were made on), editors for macOS and Windows in the toolchain record.
