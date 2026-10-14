# The runtime contract: the price of admission

A runtime is what runs a game: three (profiles standard-3d, scenic-3d, flat-2d), forge, vista, godot. Everything a
player and the builder share sits above it, in `builder/`: the spec, create, slots (gf-assets), gf/mp, gf-audio, the
menu, HUD, wallet and panels, the observation, the six gates, the play-tester and the loop tools. This file is the
interface between the two. A runtime is admitted when it meets all nine clauses of §1; its manifest
(`runtimes/<id>/runtime.json`, `registry/schema/runtime.schema.json` → `admission`) says clause by clause whether it
meets each one today, with the gaps named.

Ground truth for "today": the games.fun research tree as of 2026-10-13 (gf-three `kit/core/boot.js`, `boot-forge.js`,
`boot-vista.js`, `tools/lib/verdict.mjs`, CONTRACT.md §1.7, §5, §8, §11, GATES.md). Where this contract asks for more
than a runtime gives today, the gap is marked **GAP** and listed per runtime in §11.

## 1. The nine clauses

| # | Clause | What it asks | Where it is held |
|---|---|---|---|
| 1 | Boots from a spec through create | `create <spec.json> <out>` writes a game that boots to the home menu from the spec alone (§2) | gate B measure 3 |
| 2 | Every visible thing is a slot read through gf-assets | §3 | gate A measures 1, 4, 8 |
| 3 | Joins gf/mp | poses, host-owned shared state, the lobby, names, the results each player sees as their own (§4) | gate E measures 5, 25 |
| 4 | Hosts the kit's menu, HUD, wallet and panels through the host bridge | §5 | gate B measures 20, 22 (release) |
| 5 | Exposes `window.__game` | the fields of §6, so the gates and the play-tester see what the player sees | every gate |
| 6 | Supplies measures for all six gates and names what it skips | §7 | the verdict |
| 7 | Ships one minimal example and one showcase | with captures, pinned versions and evidence (§10) | the registry's state.tested |
| 8 | Pins its core by hash, with licences beside it; device claims name the tested browser and hardware | §8 | gate A measure 2 |
| 9 | Installs its toolchain only when chosen | a three.js build never installs Godot or cargo (§9) | the CLI's doctor |

## 2. Boot from a spec (clause 1)

`create` reads a spec v2 (`builder/spec/game-spec.v2.schema.json`) and the catalog, and hands the runtime's own part to
the runtime's `create` adapter (`runtimes/<id>/create.mjs`, default export `create({spec, out, catalog, kit})` →
`{files, slots, record}`). The shared part is the same for every runtime:

```
game/
├── index.html, main.js     the runtime's boot (main.js imports the runtime's boot and the game's rules)
├── rules.js                the game's own rules (godot: the game's own scripts; §2.2)
├── src/                    the game's own modules (spec.src and whatever the build adds)
├── spec.json               the locked spec
├── xgames.json             the record: kit and runtime versions and profile, spec and ledger sha256, modules,
│                           src files, overrides {file: {base, why, for}} (today: gf-three.json)
├── config/                 game.json (players, round, controls, mechanics or tables, rules.params), look.json,
│                           world.json, characters.json
├── assets.json             gf-assets/1, assembled from the slot declarations (§3)
├── multiplayer.json        {mode: live | room | solo, …}
├── promises.json           builder/loop/promises.schema.json, derived at create, settled by verify and play
├── ATTRIBUTION.md          every vendored library and asset with its licence
├── gf/<runtime>/           the runtime, vendored (a file changes only as a declared override)
├── gf/mp/, gf/gf-assets.js, audio/   the shared system, vendored, never edited
└── vendor/                 pinned libraries the runtime imports
```

1. **A game boots with no network but the play host.** Everything it loads is in the folder or named by a slot.
2. **The game's own code surface is the runtime's.** three, forge and vista: `rules.js` with `ctx` (hooks `setup`,
   `update`, `event`, `check`, `results`, `observe`, the loop's hooks). Godot: GDScript in the exported project, which
   reaches the shared system through the JavaScript bridge (§5.3). A runtime never forces another's API on a game.
3. **create refuses only what cannot boot** (a world the runtime has not got and no build promise for it, a table value
   its checker refuses, a hard limit the spec breaks). A need the runtime lacks is the game's: the spec carries it as a
   build promise and create writes the stub that names it.
4. **Overrides:** a declared override is any vendored file outside the never-overridable list (the guard and refusals,
   `kit.js`, licences, `gf/mp`, a prebuilt core: the runtime manifest's `core.neverOverride`). Gate A holds every
   vendored file to its release or to a declared override whose `base` is the release's sha256.

## 3. Slots through gf-assets (clause 2)

1. **Every visible model, texture, picture, sound and tuning value is a slot** in `assets.json` (gf-assets/1). The game's
   own code builds nothing to draw; a src module reads `game.*` slots the spec declared (`spec.slots`).
2. **The runtime declares its slots** from its parts and the config (`slots` / `slotsFor` exports, as three's modules do),
   and sets `assets.json → runtime.gpu` when it needs one (`webgpu` for forge and vista).
3. **Reads go through `gf/gf-assets.js`** so Studio overrides, packed mode and the seen-list work. A slot whose file is
   missing is an error, never a silent fallback.
4. **Coverage:** `window.__game.coverage()` reports what is drawn and which slot each thing carries (§6).
5. **create fills default slots through the library resolver** (`library/`, the kind's packs first; DESIGN "The asset
   library"). The art order: provided, library, connection, session, stand-ins.

## 4. gf/mp (clause 3)

A runtime joins the shared multiplayer kit (`gf/mp/net.js`, gf-multiplayer 1.7.x; `research/multiplayer/STANDARD.md`).
The bar (creator, 2026-10-05): friends are in one game, in sync, and each sees the others as a character.

| Part | What the runtime does |
|---|---|
| Poses | sends its local player's pose every frame through the session: `{x, y, z, yaw, anim, aim, ad, lk, extra}` (`ad` aim distance, `lk` loadout key; `extra` small numbers a part adds) |
| Friends | draws every peer (`net.peers()`) as a character with its name and seat colour, where they really are; reports `onScreen` honestly |
| Shared state | the host's copy owns everything shared (enemies, pickups, clock, results) and sends it in one `net.world` message (≤ 3.5 KB); other copies show it and never simulate it; a player's action on a shared thing goes to the host (`net.send(…, 'host')`) |
| Own player | each copy simulates its own player at once (never waits on the network for its own controls) |
| Lobby | the friends page (`gf/mp/index.html`): Host / Join, the waiting room; a friends round has no bots and needs two players |
| Names | picked before joining (never blank, never "Player"), changeable in the waiting room; both copies show the change |
| Results | the party's results card is the only one; it shows each player the score the game counted for that player |
| Frame loop | `net.loop(frame)` (a background tab keeps stepping; nobody can pause the shared world) |
| Watch, voice | Go live (a viewer sees through a player's eyes) and voice chat, where the manifest's `limits.watch` / `limits.voice` say so |

Limits: 4 KB a message, 60 messages a player a second. Alone, `net.active` is false and the same code runs.

## 5. The host bridge (clause 4)

### 5.1 The kit's UI
The menu (Play, Play with friends, How to play, Settings, the wallet), the HUD (player card, menu button, goal line,
the widgets the game's parts call for), the pause menu, the results card and the panels (choice, shop, inventory,
dialogue, input) are the shared system's, drawn over the runtime's canvas in their own layer. A runtime gives the UI:
the phase, the clock, the local player's state for the HUD widgets, the input lock (`isPointerOverUI` so the UI can take
the pointer), and the mouse sensitivity and invert from Settings into its camera.

### 5.2 The page protocol (`kit/net/host.js` today)
The game to its ancestors: `gf:host-ready` (every second until answered), `gf:wallet-connect`, `gf:wallet-disconnect`,
`gf:wear`, `gf:friends`, `gf:open`, `gf:econ-action`. The page to the game: `gf:host` (what it offers: wallet, friends,
shop, economy actions with `where`), `gf:wallet`, `gf:loadout`, `gf:economy`. The game never signs, prices or decides
anything of the economy; `rules.js` never sees it. A runtime that draws bodies must draw a worn loadout (§6 `looks()`).

### 5.3 A runtime whose UI is not JavaScript (godot)
It talks to the shared UI and gf/mp through its engine's JavaScript bridge (Godot's `JavaScriptBridge`): the shared UI
and gf/mp run in the page; the engine sends its phase, local player, poses and shared state across, and receives
inputs, peers, the host's world and UI commands. No game script talks to the page directly.

## 6. `window.__game` (clause 5)

Read-only, frozen, and plain JSON where it returns data. Set once the boot reaches the menu; a boot that throws sets
`window.__game = {kit, runtime, phase: 'error', error: {message}}` (**GAP** on every runtime today: none is set).

### 6.1 Required on every runtime

| Name | Type | What it gives | Today |
|---|---|---|---|
| `kit` | string | `'xgames-kit'` | three/forge/vista say `'gf-three'` |
| `runtime`, `profile` | string | the runtime and profile ids (never `engine`) | **GAP**: today `engine` (`party` even for flat) |
| `version` | string | the runtime's version | all |
| `seed` | number | the session's seed | all |
| `quality` | string | the quality tier | **GAP** vista |
| `phase` | string | `menu`, `lobby`, `countdown`, `playing`, `results`, `world` (a loop that stays), `show` (a preview subject), `unsupported`, `error` | all (menu is `lobby` today) |
| `ready` | boolean | booted and drawing | all |
| `players` | array | `snapshot().players` | all |
| `snapshot()` | object | §6.2 | all, with gaps |
| `coverage()` | object | `{meshes, tagged, exempt, untagged: [{name, path}], unknownSlots: []}` (2D: drawables) | **GAP** vista (`notYet`) |
| `slots()` | object | `{[slotId]: {drawables, triangles, onScreen}}` | **GAP** vista (`{}`) |
| `sight(ids)` | Promise | `{share, pixels, open, drawables, rect, center, size, distance, w, h}`: a slot's share of this player's view, depth-tested | three standard-3d returns a plain object; **GAP** vista |
| `project(x, y, z)` | object | `{x, y, front}` in CSS pixels | all |
| `camera()` | object | `{mode, yaw, pitch, eye: [x,y,z], dir: [x,y,z], fov, sensitivity, lookScale, invertY, cursorMode, locked, lockRefused, following, fullscreen}` | **GAP** vista (no `eye`, `dir`, `sensitivity`, `lookScale`, `invertY`, `cursorMode`) |
| `controls()` | object | `{camera, crosshair, controls, prompt, viewport, aim: {dir, dist, point, hit, onSelf, screen}, landing, interactables: [], mechanics: [{id, aimed, interacts, stats}], me: {x, y, z, alive, holding}, points?, mark?, held?}` | **GAP** forge (aim and landing stubbed), vista (no aim, landing, interactables) |
| `screen()` | object | `{dpr, css: [w, h], buffer: [w, h], ratio, budget, quality, fps, frameMs, api, gpu}` | **GAP** shapes differ: three has no `fps`; forge puts it in `governor`; vista uses `{width, height, cssWidth, …}` |
| `menu()`, `hud()` | object | §6g of today's contract: buttons with rects, the HUD's widgets as drawn against the truth behind them | all |
| `looks()` | object | loadouts and how each player is drawn | all (vista players partial) |
| `events({since})` | object | the event log: `{entries: [{i, t, w, ph, k, part, name, who, at}], next, dropped, kinds, me}` (`k`: event, counter, score, input, sound) | **GAP** forge (own `forge.events` and `hits`), vista (none) |
| `sounds()` | object | `{plays: {id: n}, dropped: {reason: n}}` | **GAP** forge, vista |
| `panels()` | object | `{open: [{id, kind, modal, rect, count, title, words}], covered, opened, closed, refused, last}` | **GAP** forge, vista |

### 6.2 `snapshot()`
`{kit, runtime, profile, version, phase, round, seed, quality, time: {now, round, left}, me, host, live, backdrop, view,
paused, players: [{id, name, score, alive, bot, local, x, y, z, anim, color, control, down, protected, pl, ring?,
mark?}], fair, refusals: [{code, message, count, first, last}], winners, reason, results, shared, rules, modules: {mechanics:
[{id, standin}]}, net: null | {you, host, started, watching, me, peers: [{id, name, x, y, z, onScreen}], over, clock,
shared}, flow?, watch, world, <runtime>?}`. Holds no functions and is stable for the same seed. `rules` is the game's
`observe(ctx)`; `<runtime>` is the runtime's own block (`forge: {…}`, `vista: {…}`).
**GAP** vista: no `quality`, `backdrop`, `fair`, and players lack `control`, `down`, `protected`, `pl`.

### 6.3 Required when the runtime has the capability
| Name | When | Today |
|---|---|---|
| `stepped`, `step(ms, opts)` → `{frames, simulated, owed, now, round, phase}` | a runtime that can step its own time (`?gf-step=1`, solo): measures 35 and 38 use it when present | three only; **GAP** forge, vista (real time) |
| `unsupported` `{reason, kind, shown, link}` | the browser lacks every graphics API the runtime takes | forge, vista |
| `voxelAt`, `topAt`, `signAt`, `protectedAt`, `build()`, `shove()`, `world()` | a voxel world | three |

### 6.4 The runtime's own namespace
Anything else lives under `window.__game.<runtime>` (`forge.*`: `state`, `players`, `feel`, `cards`, `shop`, `run`,
`down`, `value`, `net`, `events`, `face`, `loseDevice`, …; `vista.*`: `look`, `game`, `friends`, `project`, `frames`,
`showFriend`, `tags`, `setLook`). Today forge also puts `bodies()`, `enemies()`, `hits()` and `wave()` at the top level:
**GAP** (move under `forge.*`, or into §6.1 when a second runtime has them). QA helpers that change the game (force a
device loss, turn the player) are allowed only there and only behind a QA flag.

## 7. Measures per gate (clause 6)

The gates are six and stay six (GATES.md, approved 2026-10-12; budget 8 gates, 5 prompt rules). A gate is a question
about the player's experience; a measure belongs to exactly one gate and keeps its number. Each runtime supplies its
own measures for every gate and names the ones it skips, with why.

| Gate | Question | Measures (gate of each number) |
|---|---|---|
| A Integrity | is the kit untouched, is every visible thing a slot, does every slot's file pass its validator? | 1, 2, 4, 18, 19; release 8 |
| B Health | does it boot to play with no errors, at an acceptable frame cost? | 3, 9 (full), 32, 33, 36; release 20, 22, 24, 31 |
| C Cause → effect | does every input and logged event show on that player's own screen, soon? | 10, 13, 15, 16, 30, 38; release 7, 21 |
| D The loop closes | can it be won or lost, does it end and replay, does every score come from a counted event? | 6, 12, 26 |
| E Shared truth | does every player see every other where they really are, and own their own values? | 5, 25, 27, 28, 29; release 34 |
| F Matches the spec | is the game what its locked spec says? | 11, 14, 17, 35, 37, 39 |
| J Judges (advisory) | findings and repair rounds only, never a failed verdict | 23, the play-tester |

**The verdict** (`builder/gates/verdict.schema.json`) has one entry per gate, keyed by its letter, and a flat list of
what failed (what the ladder's failing set reads):

```json
{ "gates": { "C": { "gate": "C", "ran": [13, 15], "passed": [13, 15],
                    "skipped": [{ "measure": 38, "why": "the vista boot keeps no event log yet" }],
                    "failed": [], "ok": true } },
  "failed": [], "pass": true }
```

A skipped measure is never counted as passed. A measure the run required and skipped makes the gate fail
(`skipped[].required: true`); a measure the runtime cannot have (nothing to hit on a calm game) is skipped with its
reason and not required. A machine profile that skips measures (a CI runner with no GPU) never makes a pass.

**Today, per runtime (build run; `tools/lib/verdict.mjs`):**

| Runtime / loop | Build measures | Release adds | Skipped (not yet) |
|---|---|---|---|
| three round loops (standard-3d, scenic-3d, flat-2d) | A 1 2 4 18 19 · B 3 (9 full) · C 10 13 15 16 38 · D 6 12 · E 5 25 · F 11 14 17 35 39 | 7 8 20 21 22 24 31 34 | none |
| three loop world (voxel) | A 1 2 4 18 19 · B 3 · C 13 30 · D 26 · E 5 25 27 28 29 · F 11 14 | 7 8 20 21 22 24 31 34 | 6 10 12 15 16 17 35 38 39 (no rounds; the world's own 26–30 stand in), 9 (not built for a world) |
| forge | A 1 2 4 18 19 · B 3 32 33 · C 10 13 15 16 · D 6 12* · E 5 25 · F 11 14 17 | 7 8 20 21 22 24 31 34 | 38 (no shared event log), 39 (hits per kill are its tables'), 35 (not run on forge); *12 is still "something happens" (no event log to trace scores) |
| vista | A 1 2 18 · B 3 31 32 36 · C 13 15 · D 6 · E 5 25 · F 14 37 | 20 21 | 4 9 10 11 12 16 17 19 33 38 39, release 7 8 22 24 34 (each with its reason in the vista manifest) |
| godot | none | none | everything: the runtime does not exist yet |

Each runtime's manifest carries this as `measures` (build, release, skipped with why), and the catalog shows it.

## 8. Pinned core and licences (clause 8)

1. **The core is pinned by hash.** three: npm versions (three 0.186.0, Rapier, postprocessing, N8AO) with their hashes
   in the release manifest. forge: one prebuilt `.wasm` per release for each build (WebGPU, WebGL2) with `BUILD.json`;
   agents never run cargo. vista: the vendored upstream core at its commit, file by file. godot: the export templates at
   their version and hash.
2. **Licences travel beside the code:** `LICENSE`, `ATTRIBUTION.md`, `THIRD_PARTY.md`, `UPSTREAM.json` in the runtime
   folder, and copied into every game that vendors it. Permissive only, unless the creator approves.
3. **A release manifest** (`runtimes/<id>/releases/<version>.json`: path → sha256) is what gate A measure 2 holds a
   game's vendored copy to. A game's `xgames.json` names the release.
4. **Device claims name the tested browser and hardware** (`limits.devices.<class>.evidence`). A claim with no evidence is
   `untested`; a claim measured only in a headless browser at that size is `emulated`.

## 9. Toolchain only when chosen (clause 9)

The runtime manifest's `toolchain.game` lists what a game build needs beyond Node and Chrome (three, forge, vista:
nothing; godot: the Godot editor and export templates at 4.6, installed by its own script). `toolchain.build` lists what
rebuilding the core needs (forge: Rust and wasm tools; never run by an agent building a game). The CLI installs a
runtime's game toolchain the first time a spec chooses that runtime, never before.

## 10. Examples (clause 7)

- **Minimal:** one per runtime (and profile): the smallest game that boots, plays a round with two players and passes
  every measure the runtime supplies. Tagged runtime, profile, loop and kind.
- **Showcase:** a quality bar against a named reference game: captures, pinned versions, evidence, the creator's verdict
  in their words when there is one.
- A runtime's `state.tested` needs its minimal example's verdict as evidence; `state.open` needs the creator's word.

## 11. Gaps per runtime (2026-10-13)

**three** (standard-3d, scenic-3d, flat-2d): meets all nine clauses. Gaps:
- observation: top-level `engine` instead of `runtime` and `profile`; flat says `party` everywhere; `sight()` is
  synchronous on standard-3d (a Promise on scenic); `screen()` has no `fps` (the frame cost lives in `__gfLook.perf()`,
  party and scenic only, and no verify tool reads it); no `window.__game` when boot throws.
- examples: no showcase per profile yet (the kinds stream picks them); scenic's `__gfLook` differs from party's.
- flat-2d: only `pickup` and `board` proven on a plane; its loops (round, turns, endless, match) are claimed but not run
  per plane.

**forge**: meets clauses 1, 2, 3 (live co-op 2–4), 4, 8 (two prebuilt builds, LICENSES.md), 9. Partly 5, 6, 7:
- observation: no `events()`, `sounds()`, `panels()`, `stepped`; `controls()` aim and landing stubbed; `bodies`,
  `enemies`, `hits`, `wave` at the top level.
- measures: 38, 39 and 35 not run; 12 is the old "something happens" (no shared event log).
- mechanics: 4 of the 18 run on forge (health, loot, pickup, waves: `components/<id>/impl/forge`, loaded by
  `kit/mechanics.js`, each with a two-player fixture both screens pass, `components/<id>/impl/forge/evidence/2026-10-13`);
  the rest of its play is the tables and rules.js. The shared HUD card's health, wave and coin rows are hidden on forge
  (its own HUD draws them), so measure 21 would find them not shown (a request to the HUD owners: a widget a runtime
  draws itself).
- devices: WebGL2 build not yet run on a real phone or in an in-app browser (phone is `emulated`); not offered inside a
  post on X yet.
- examples: Zombie Town is the showcase (nobody outside has played it); no minimal example.

**vista**: meets clauses 1, 3 (live co-op 1–4, no bots), 8 (Tidewater core MIT, pinned at 4811ba48), 9. Partly 2, 4, 5,
6, 7:
- slots: the core's own models, textures and sounds are not slots yet (only look values and the friends' bodies).
- host bridge: no loadout drawn on vista bodies. Go live and voice chat are wired (a viewer looks out of the streamer's
  eyes through the core's own free camera, `kit/watch.js`); a viewer does not see the streamer's rod, line or catch
  (`runtimes/vista/CORE-NOTES.md`), and verify-vista does not run measure 34 yet (the shared check passes by hand).
- observation: `coverage()`, `sight()` answer `notYet`, `slots()` is empty; no `events()`, `sounds()`, `panels()`,
  `stepped`; `camera()` and `screen()` have their own shapes; snapshot lacks `quality`, `backdrop`, `fair`, and players'
  fair fields.
- measures: 4, 9, 10, 11, 12, 16, 17, 19, 33, 38, 39 and release 7, 8, 22, 24, 34 not run (each reason in its manifest).
- devices: WebGPU on a desktop only; phones and posts on X unsupported; the first visit compiles shaders (about 10 s);
  file-tree delivery only.
- examples: Glass Bay (sandbox), T7 eval; no minimal example in the examples folder.

**godot**: exists: false. Every clause is a gap. What is known: Godot 4.6 exports on this Linux toolchain
(`provision.sh`, kit `platformer@1.1.1`); its web target is WebGL2 compatibility rendering, single-threaded (no
cross-origin isolation needed); it reaches the shared system through `JavaScriptBridge` (§5.3); its examples come from
the 8 public Godot trials (MIT starters). The 96 legacy Godot builds stay frozen and are not its examples.
