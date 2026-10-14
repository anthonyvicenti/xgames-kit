# gf-three contract

The API that game agents and module authors write against. It covers what `create` writes, what `rules.js` gets, how a kit part plugs in, what the kit owns and refuses, and how each runtime and profile differs. It describes the kit as the code has it now (`runtimes/three/kit/`, `tools/create.mjs`). Dates, history and the creator's words are in [CHANGELOG.md](CHANGELOG.md). What verify checks is [GATES.md](GATES.md) and `tools/lib/homes.json`. If an API here is wrong, tell the parent; don't fork it.

| § | Topic |
|---|---|
| 1 | A game project: files, versions, import map, URL parameters, `kit.js`, re-running `create`, a game made on an older kit, a backend |
| 2 | Assets: slots, declarations, coverage, items as data, sounds, generated models |
| 3 | `rules.js`: hooks, `ctx`, players, shared state and events, the frame, random numbers |
| 4 | Module interfaces: mechanics, look, world, character, controller, net, flows |
| 5 | The observation and the verify gate |
| 6 | Kit-owned parts: preview subjects (6), fair play (6c), controls (6d), player looks (6e), hits (6f), menu, HUD and wallet (6g), friends (6h), screens (6i), panels (6j) |
| 7 | Refusals: what the kit refuses at run time |
| 8 | Runtimes and profiles: three (standard-3d, scenic-3d), forge, vista; the `follow` camera |
| 9 | Worlds (9), watch then play (9b) |
| 10 | Flat (2D) games |
| 11 | `window.__game` in full |

## 1. A game project (what `gf-three create` writes)

`node builder/tools/create.mjs <spec.json> <out> [--force] [--new-rules] [--standins] [--standin-mechanics] [--json]`

```
game/
├── index.html              import map + <script type="module" src="main.js">; nothing else (forge and vista: §8)
├── main.js                 generated: import { boot } from './gf/three/core/boot.js'; import rules from './rules.js'; boot({ rules })
├── rules.js                THE GAME AGENT'S FILE: the game's own rules (§3)
├── src/                    optional: the game's own modules, imported by rules.js (§1.7): what the kit lacks, built for this game
├── spec.json               the locked spec (its sha256 in gf-three.json)
├── gf-three.json           the record: kit and runtime versions, runtime and profile, loop, kind, the look made, spec sha, options, modules, props, overrides (§1.7)
├── config/
│   ├── game.json           title, text, players, round, camera, controller, controls, props, mechanics[] with params,
│   │                       fair, ui, an optional loadout, and rules: {summary, scoring, params} (from the spec)
│   ├── look.json           look preset id + every look value (slots)
│   ├── world.json          world template id + layout (props, spawns, zones), generated (§4.3)
│   ├── props.json          the prop catalog entries the layout uses (layout worlds only)
│   └── characters.json     roster: body slot per role, tint palette, nameplate style
├── assets/models/          *.glb (model slots): bodies, props, items
├── assets/textures/        *.png|*.jpg|*.ktx2 (image and texture slots)
├── assets/clips/           shared animation GLB(s) for gf-humanoid-1
├── assets/panels/          optional: panel pictures (§6j)
├── assets.json             gf-assets/1 manifest, generated from the slot declarations (§2.2); validates with builder/asset-manifest/validate.mjs
├── multiplayer.json        { "mode": "live", ... } per multiplayer/STANDARD.md
├── ATTRIBUTION.md          every vendored library and asset with its licence
├── tests/                  optional: the game's own tests, <name>.test.json (§5, check 35)
├── backend.json            optional: a backend connection, written only by the open builder's `backend connect` (§1.6)
├── gf/three/               the kit (vendored; a file changes only as a declared override, §1.7), with gf/three/kit.js (§1.3)
├── gf/mp/                  gf-multiplayer (vendored by builder/multiplayer/party/adopt.mjs, never edited)
├── gf/gf-assets.js         gf-assets runtime
├── audio/                  gf-audio
└── vendor/                 three (build/three.module.js + the addons the code imports), rapier, postprocessing, n8ao
```

**Versions.** `create` vendors:
- gf-multiplayer at `KIT_VERSION` in `builder/multiplayer/party/manifest.mjs` (1.7.4 today);
- gf-assets 1.3.0 and gf-audio 1.5.0 (`GF_ASSETS`, `GF_AUDIO` in `tools/lib/paths.mjs`);
- three.js 0.186.0;
- the kit at `KIT_VERSION` in `tools/lib/paths.mjs` (`0.1.0-dev`). The scenic-3d profile's and the forge and vista runtimes' versions sit beside it there (§8).

### 1.1 The import map (three standard-3d and flat-2d; the others: §8)

| Import | Path |
|---|---|
| `three` | `./vendor/three/build/three.module.js` |
| `three/addons/` | `./vendor/three/examples/jsm/` |
| `@dimforge/rapier3d-compat` | `./vendor/rapier/rapier.mjs` |
| `postprocessing` | `./vendor/postprocessing/postprocessing.module.js` |
| `n8ao` | `./vendor/n8ao/N8AO.js` |
| `three/examples/jsm/` | `./vendor/three/examples/jsm/` (N8AO imports it) |

### 1.2 URL parameters

| Parameter | Effect |
|---|---|
| `?seed=N` | Fixes every gameplay random (else the room's seed, else random) |
| `?bots=N` | Fills seats when playing alone (0–7) |
| `?quality=low\|high` | Picks the quality tier |
| `?gf-show=<subject>` | Studio preview subject (§6) |
| `?gf-loadout=<base64url JSON>` | QA only: this player's loadout (§6e) |
| `?gf-autoplay=1` | QA only: skips the home menu when playing alone (the countdown starts at once) |
| `?gf-ui=0` | QA only: hides the HUD and the menu |
| `?gf-calm=N` | QA only: bots stand still for the first N seconds of each round |
| `?gf-res=fixed` | QA only: turns the frame-rate guard off (§6i) |
| `?gf-dev=1` | Hears the page's `gf:slot` messages from a non-localhost origin (§2.4) |
| `?gf-step=1` | QA only, alone (never in a live round or a backdrop): stepped time (`kit/core/step.js`). The clock stands still until `window.__game.step(ms)`, which runs the frames those milliseconds hold at the fixed 60 Hz without waiting and draws the last; `window.__game.stepped` is true. Without the flag neither exists. Real keys and clicks stay real. Not stepped: audio time, CSS, the input's own stamps, loads, shader time. verify's checks 10, 13, 16 and 35 wait this way (`tools/lib/stepped.mjs`) |
| `?gf-backdrop=1` | The friends lobby's backdrop (multiplayer.json `live.backdrop`, §6h F2): the world with the camera circling a character, no menu, HUD, bots, sound or input, nothing saved; ignored in a live round. On a machine that draws on its processor (`kit/core/quality.js` `drawsOnCard`) it is left out: the page stays empty, `<html data-gf-backdrop="off">`, and the seat colours still reach the lobby |
| `?gf-demo=<mechanic>.<moment>` | QA only: a mechanic's staged moment. `waves.hit`: no waves; one enemy at a time stands still 6 m in front of the local player, a new one after each kill. `health.hurt`: from 3 s into the round the local player loses 1 hit point every 2.5 s. `levels.clear`: the first level is cleared at once and its portal opens. `levels.boss`: the run starts on the last level (the boss's). `boss.phase`: the boss arrives at once and its phases can be driven |

Engine parameters (`?gf-forge-backend=`, `?gf-vista-nowebgpu=1`, …) are in §8. `tools/verify.mjs` passes `gf-autoplay` and `gf-ui` to its contact-sheet capture, and Studio's `__GF_ASSET_OVERRIDES` patches (for example a 25 s round) to its solo round.

### 1.3 `gf/three/kit.js` and which modules run

`create` vendors the kit into `gf/three/` and writes `gf/three/kit.js`: `{name, version, runtime, profile, modules: {runtime, profile, look, world, character, mechanics: [ids], flat?}, files: {path: sha256}}`, plus `scenic`, `forge` or `vista` for those (§8). `boot` reads it.

A module counts when its file exists in `runtimes/three/kit/` **and** it imports in Node with the exports the interface needs (look: `createRenderer`, `applyLook`; world: `loadWorld`; character: `spawnCharacter`; a mechanic: `id`, `create`). Otherwise the stand-in in `kit/core/standins/` runs, and its art is still slots. `--standins` forces the stand-ins for look, world and character; `--standin-mechanics` leaves the mechanic modules out (their params stay in config for the rules). The boot loads only the mechanics `config/game.json` uses.

### 1.4 Re-running `create`

Re-run `create` on a game to pick up a module that landed later. It refreshes the kit and vendor copies and keeps `rules.js`, `src/`, `config/*.json`, `assets/`, `multiplayer.json` and the declared overrides (§1.7). `--force` replaces the config, assets and `multiplayer.json` too, but never `rules.js`, `src/` or an override; only `--new-rules` replaces `rules.js` with the stub.

### 1.5 A game made on an older kit: create it again

There is no upgrade path (no backwards compatibility, the creator, 2026-10-13). A game made on an older kit is created
again from its own spec when it is wanted: `node builder/tools/create.mjs <game>/spec.json <game>` (§1.4) refreshes
every kit copy check 2 compares and keeps `rules.js`, `src/`, the config and the declared overrides; `--force` lays the
config, the assets and the world again from the spec. A spec the current schema refuses is written again as a new spec.

### 1.6 A backend (optional)

A spec may name `backend: {kind: "database" | "host", provider?: "supabase" | "railway", needs: [...]}` (`builder/spec/game-spec.v2.schema.json`; the loop's side is `builder/loop/backend.mjs`). A backend is the person's own account and bill. They connect it with `npx gamesfun backend connect <provider>` (the open builder, gamesfun-kit), which writes only public values into `<game>/backend.json`.

- The game plays with nothing connected, as every build and verify runs it.
- The game reaches the backend only through the kit's client in `gf/backend/` (gamesfun-kit). Its code holds no key or URL: the connection is `backend.json`, and only the kit writes it.
- When the client answers that there is none, the part that needs it says so on screen in plain words ("The leaderboard needs your database: connect Supabase"), and the round plays on.
- A best score in the browser's own storage is not a backend. Live play with friends stays on `gf/mp`.

### 1.7 The game's own modules and engine overrides

The creator, 2026-10-12: "Let the build write engine code" (`research/foundations/evidence/creator-builds-write-engine-code-2026-10-12.json`). When the idea needs something the kit does not do, the build builds it for this game; `spec.build` (`[{what, how, where}]`, the pitch's `v1.build`) is that to-do list, and each item is a promise the play-tester must see work (`tools/lib/promises.mjs`, kind `build`: an unanswered one fails).

**The game's own modules: `src/`.** Any number of ES modules under `<game>/src/`, imported by `rules.js` (`import { grapple } from './src/grapple.js'`). They are game code like `rules.js`: served and delivered with the game (file tree and packed HTML alike), read by every check that reads the game's code (built-in art, the clips and sounds it plays, the three.js addons it imports), and to the kit's guard a call from `src/` is the game's (`kit/core/guard.js`), so a `src/` module that breaks a kit-owned thing is refused as `rules.js` would be. Everything visible is still a slot (§2).

**Engine overrides.** When the game needs the engine itself to change (a kit module, a vista core file), edit the vendored copy in place and declare it in `gf-three.json`:

```json
"overrides": {
  "gf/three/core/input.js": { "base": "<sha256 of the kit release's file, before the edit>", "why": "<one sentence: what the game needs>" }
}
```

- Any file under `gf/three/`, `gf/scenic/`, `gf/forge/` (its JS layer), `gf/vista/` (kit, HUD and core), `gf/gf-assets.js`, `audio/` or `vendor/` may be declared. Take `base` with `sha256sum` before the first edit; gate A's failure for an undeclared edit prints it too.
- **Gate A (measure 2, `tools/lib/kit-check.mjs`)** holds every kit file to its release (`kit-releases/`, the live kit): unchanged, or a declared override whose `base` is the release's file. An undeclared edit fails, naming the file and the base to declare; a declared override with a wrong base fails, naming the release's hash to rebase onto. A new file inside a kit copy is never an override: a module of the game's own goes in `src/`.
- **Never overridable** (gate A fails them when declared): `gf/three/core/guard.js` (the guard finds the game's folder, ROOT, from its own URL) and `gf/three/core/refusals.js`, `gf/three/kit.js` (create's record), every licence and attribution file, `gf/mp/` (held to gf-multiplayer's own frozen releases), and forge's prebuilt core (`gf/forge/wasm/`, `gf/forge/wasm-webgl2/`, any `.wasm`, `BUILD.json`). An override of a boot (`gf/three/core/boot*.js`) must still import `./guard.js`.
- **Pinned cores.** Vista's core is pinned file by file in `gf/three/kit.js` and held to the release by gate A, which honours a declared override there like anywhere else. Forge ships one prebuilt, hash-pinned `.wasm` per kit release that no agent can rebuild (agents never run cargo), so on forge an override covers its JS layer only (`gf/forge/*.js`, `tables/`); what needs the Rust core is engine work for a kit release.
- **The guard** counts a declared override as the kit's code (so the kit's own pointer-lock call in an overridden `core/input.js` is not refused). verify tells it which kit files were changed without a good declaration (`globalThis.__GF_KIT_EDITS`, set by verify's server before any module runs: `kitEditsOverlay`), and it counts those as the game's.
- **`create`** keeps each override (§1.4) and stop on one whose base the kit has moved on from, naming it. Rebase the edit onto the kit's new file, set `base` to its hash, and run again.

## 2. Assets: everything visible is a slot

A game draws no art in code. Every visible model, texture and value is a slot. `rules.js` reads values through `ctx.assets` and `ctx.config`, and exposes its own tuning numbers as `config/game.json` → `rules.params` (each a `rules.*` slot).

### 2.1 Runtime (`kit/assets/assets.js`)

```js
import { assets } from './gf/three/assets/assets.js';     // also ctx.assets
const crate  = await assets.model('prop.crate');          // a clone of the slot's GLB, every mesh tagged userData.gfSlot = 'prop.crate'
const body   = await assets.model('character.body.player');
const tex    = await assets.texture('world.ground.albedo');   // THREE.Texture, colour space from the slot's constraints
const v      = assets.value('look.sun.intensity');        // a value slot, read through gf-assets (overrides applied)
const cfg    = assets.config('game');                     // the whole config/game.json (overrides applied)
assets.url(slotId);                                       // the slot's file URL
assets.has(slotId);                                       // is the slot declared in assets.json
assets.tag(object3d, slotId);                             // for kit primitives whose material is a slot (R1)
const report = assets.coverage(scene);                    // { meshes, tagged, untagged: [{name, path}] }
```

- Reads go through `gf/gf-assets.js`, so Studio overrides, packed mode and `__GF_ASSETS_SEEN` all work.
- GLBs are cached per slot and cloned per use (`SkeletonUtils.clone` for skinned meshes). Loaders: GLTFLoader with Meshopt, Draco and KTX2.
- A slot whose file is missing is an error, never a silent fallback. The exception is a slot declared `optional` with an explicit kit default.
- `assets.tag` of an id `assets.json` does not declare is refused (`slot-unknown`, §7); the object is still tagged.
- A load that fails because its page is going away (after `pagehide`) is not a broken slot: it never settles and nothing is logged.
- Per-player reads (`{player: p}`) and the loadout store: §6e.

### 2.2 Declarations (`tools/slots.mjs`; every module declares)

Every module exports `slots` (an array of slot templates) or `slotsFor(config…)`. `create` and `node tools/slots.mjs <game> --write` assemble `assets.json` from them. The sources are:
- the kit's own modules (look, world, character, mechanics, the core: `kit/core/slots.js`, the UI: `kit/ui/slots.js`);
- `config/*.json`;
- the files under `assets/`.

A template is an ordinary gf-assets/1 slot: `id`, `label`, `group`, `type`, `source`, plus `constraints`, `generate`, `license`, `tier`, `facet` and `rank`. A mechanic's templates may use `{base}` (`/mechanics/<i>/params`, the pointer to this instance's params in `config/game.json`), `{i}`, `{id}`, `{as}` and `{<paramName>}`; `source.file` defaults to `config/game.json`. Example: `{ id: 'mechanic.projectile.speed', label: 'Throw speed', group: 'mechanics', type: 'number', source: { pointer: '{base}/speed' }, tier: 'main' }`. A mechanic without `slots` gets one value slot per param.

| Slot ids | What they are |
|---|---|
| `character.body.<role>` | Body model (`constraints: { rigged: true, rig: "gf-humanoid-1", animations: [...] }`) |
| `character.tint.<role>` | Tint. The one owner of player colours: `look.palette.players` only seeds its defaults and is an advanced slot |
| `character.hat.<role>` | Hat (optional) |
| `prop.<name>`, `prop.<name>.size`, `prop.<name>.count` | A prop, its size and count |
| `world.<template>.<part>` | A part of a world template |
| `look.<group>.<name>` | Look values |
| `mechanic.<id>.<name>` | Mechanic values and models (e.g. `mechanic.projectile.model`, `mechanic.projectile.color`) |
| `rules.<name>` | The game's own numbers from `config/game.json` → `rules.params` |
| `round.*`, `players.*`, `controller.*`, `fair.*` | The kit's own values |
| `ui.<name>` | UI text and colours (`config/game.json` → `text`, `ui`) |
| `panel.image.<name>` | A panel picture (§6j) |

Main tier: at most 40 slots, chosen by `rank`. The rest are `"tier": "advanced"`. Kit sound ids use dashes.

### 2.3 Coverage (R3)

`assets.coverage(scene)` walks visible meshes (`visible`, in the frustum or not, `material.visible`). A mesh is exempt only when `userData.gfExempt` holds a reason (a debug helper, a ray-cast proxy). Every mesh a game or a mechanic adds carries a slot: a model from a slot's file is tagged by `assets.model`, and a kit primitive is tagged with `ctx.assets.tag(obj, slotId)`. The game's own code builds nothing to draw (no `new` geometry, mesh, sprite, points or line in its scripts outside `gf/`, `vendor/` and `audio/`): what it shows comes from a slot's file or a kit part.

### 2.4 Items as data

A mechanic's things are described by the mechanic, in its manifest's `items` (`kit/assets/items.js` has the language and the checks; `tools/catalog.mjs` MANIFEST the shape). No tool, page or check keeps a list of mechanics or fields.

- **A table** (melee's `weapons`, loot's `upgrades`): one entry's JSON Schema (each field's `title`, `type`, `minimum`, `maximum`, `unit`, `default`), `min` and `max` entries, the fields a card shows first (`front`), and its `picture` (field, file, slot, library default). The table is one json value slot, `mechanic.<id>.<key>`, whose `constraints.item` is the declaration. Adding, removing, renaming or re-numbering an entry is a write of that slot. A write is checked first and refused in words ("Foam sword, swing 1: damage is 500: more than 100, the most it can be"). A new entry's picture may be `"library:<id>"`; `slots --write` copies it to the entry's own file with its grip and licence, and splits a file two entries share. `create` writes the engine's default table (`defaults.party`, `defaults.scenic`) into a game whose spec names none.
- **A single item** (pickup, projectile, carry, loot's coin, potion and chest): `{single, noun, fields, front, picture}` over the mechanic's own params and the slots that already point at them.
- `assets.json → items` indexes them: `[{mechanic, as, noun, table}]` or `[{mechanic, as, noun, single, picture, fields, front}]`, all as slot ids.
- **The routes**: `tools/slots.mjs <game> --set <id> <value | @file>` (`tools/lib/items-lib.mjs writeSlot`) and `tools/items.mjs <game> list | add | remove`.
- **Live, dev only** (`kit/core/live-slots.js`): the page hosting the game sends `{type: 'gf:slot', id, value}` and gets back `{type: 'gf:slot-applied', id, ok, live, problems}`. It is heard only from localhost or with `?gf-dev=1`, and never in a live round. `assets.setValue` puts the value in memory after the same check. A part's `slotChanged(id)` answers `'live'` (melee: a weapon's numbers, for the next swing) or `'reload'`. Otherwise the answer is `'on-use'`: whatever reads the slot through `assets.value()` when it uses it sees the new value.
- A preview subject (`?gf-show=character.<role>`) wears each `gf:loadout` the page sends after boot, in place (`snapshot().look.restyled`).

### 2.5 Sounds

Every game plays through gf-audio (`audio/`). The sounds are one list: `assets.json` → `sounds` → `sounds` (presets first; files under `assets/`). `assets.json` → `sounds` holds only `version`, `buses` and `sounds`. Every audio file under `assets/` is played by a listed sound or named by game code.

- `ctx.audio.play(id, {at: {x, y, z}, gainDb, pitch, optional})`. `at` pans the sound and makes it quieter with distance from the camera. `ctx.audio.has(id)`, `ctx.audio.stop(id)`, `ctx.audio.raw` (the gf-audio object).
- An id the list lacks plays nothing and is refused (`sound-unlisted`, §7), unless the call passes `{optional: true}`. The kit's own mechanics play their sounds `optional`. A template id such as `` `death-${n}` `` must match listed ids.
- The kit's bus levels are the creator-approved defaults (`audio/GUIDE.md`); a game never raises them.
- Mechanics name their sounds in params (`soundCollect`, `soundKill`, …); `create` lists what they need.

### 2.6 Generated models (the Studio worker's)

A body or prop the spec asks for `from: "generate"` or `"reference"` is made through the asset library's connection step (`gamesfun art generate`, builder/art/generate.mjs: the maker's model is taken into the game's private pack and the slot is filled from it), called by the Studio worker or the loop while the agent works. It lands in its slot (`character.body.<role>`, `prop.<name>`) after the agent finishes. `game/generated.json` (`gf-three-generated/1`) says how far each item is: its state, reason and attempts, and for a failed one a `delivery` line for the delivery summary. The agent does not call Meshy, edit `generated.json` or draw a stand-in in code. Two roles the spec describes differently (the player and an enemy) never share one body file: a role that is not generated takes its own body from the asset library's bodies.

## 3. The game agent's surface: `rules.js`

`rules.js` owns only what makes this game this game. Everything in §3.6 is the kit's.

### 3.1 Hooks

```js
export default {
  // Once on every copy, after the world, players and mechanics exist. Register shared state, UI, listeners.
  setup(ctx) {},
  // Every copy, when the round starts (the same moment for everyone).
  roundStart(ctx) {},
  // Every frame on every copy, in every phase (check ctx.round.phase). dt is in seconds. Host-only logic under if (ctx.host).
  update(ctx, dt) {},
  // A gameplay event from another copy: ctx.net.send(name, data, to) on their side.
  event(ctx, name, data, from) {},
  // Host only, ten times a second: is the round over? Return null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at round end. Return the rows for the results screen (default: each player's p.score).
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // Optional: steer a bot each frame (the host owns bots; alone only, §6h).
  bot(ctx, player, dt) {},
};
```

Optional hooks the kit calls when present:

| Hook | When |
|---|---|
| `observe(ctx)` → plain JSON | Read into `window.__game.snapshot().rules` (what the game's own tests read) |
| `digest(ctx)` → short string | Added to the live gate's shared digest: equal on every copy when the game's shared world agrees |
| `hostChanged(ctx, isHost)` | A world's host changed (§9) |
| `watchKey(ctx)` → data, `watchStart(ctx, data)`, `watchEnd(ctx)` | Watch then play: what a viewer tuning in needs, and when the viewer joins (§9b) |
| `move`, `turnStart`, `turnTimeout`, `botMove`, `canAct(ctx, p)` | The `turns` flow (§4.7, `kit/loops/README.md`) |

`create` writes `rules.js` from the spec: its rules as comments, the hooks, and in `setup()` the stub of each mechanic it uses (from the manifest's `stub` and `events`).

**Errors.** If `rules.setup` throws, the game does not start (`setup-failed`, §7). If an every-frame hook throws (`update`, `bot`, a `ctx.onFrame` function), the error is logged once per message with a count (`update-failed`), and the frame goes on.

### 3.2 `ctx`

| Field | What it is |
|---|---|
| `THREE`, `scene`, `camera`, `renderer` | The three.js 0.186 objects. The camera is the kit's: assigning `ctx.camera` is refused (`camera-swap`, §7); pick it in `config/game.json` → `camera` |
| `kit` | `{name: 'gf-three', runtime, profile, version}` |
| `config` | `config/game.json` with Studio patches applied. `config.rules` is `{summary, scoring, params}`; `config.rules.params` are the game's own numbers |
| `assets` | §2.1, §6e |
| `rng()` | Seeded 0–1 random, with `.int(n)`, `.range(a, b)`, `.pick(list)`, `.fork(label)`. The rules' own stream (`rng.fork('rules')` of the game seed). See §3.7 |
| `seed`, `quality` | The seed; the tier object `{name: 'low'\|'high', pixelBudget, shadows, …}` |
| `time` | `{now, dt, round, left}` seconds. `dt` is this frame's step; `round` is the host's round clock on every copy; `left` is what the HUD's clock shows (a flow's, or `Infinity` when there is none) |
| `host` | True on the copy that owns shared state (also true alone). In a world it follows the room (§9) |
| `me` | The local player |
| `players` | `list()`, `get(id)`, `others()`, `owned()`, `humans()`, `bots()` (sorted by seat). `add`, `remove` and `place` are the session's: in a friends round they are refused (`players-add-with-friends`, §7); alone they pass through |
| `world` | The world module's object (§4.3): `spawn(i)`, `zone(name)`, `props`, `raycast(from, dir, max)`, `bounds` (Box3), `root`, and what the template adds |
| `physics`, `RAPIER` | The bare Rapier `World` (the kit steps it at a fixed 60 Hz) and the Rapier module. Modules read Rapier through `physicsOf(ctx)` (`kit/core/util.js`), which also accepts `{RAPIER, world}` from a bench or fixture |
| `mechanics` | `get(id)` → the instance `create` configured from the spec, or `{id, as, params, standin: true}` when its module is not in the kit; `list()` |
| `shared` | Host-owned state replicated to every copy (§3.4): `register(key, initial)` → proxy, `smooth(key)`, `snapshot()` |
| `net` | `send(name, data, to='all'\|'host'\|playerId)`, `on(name, fn)`, `active` (false alone), `you`, `blend`, `room` and `status` (worlds, §9). Events are edges, never per frame |
| `ui` | `meter(id, {label, value, max, color})` → `{set, remove}` (sits in the HUD's player card), `goal(text\|null)` (the HUD's goal line, §6g), `score(rows\|null)`, `banner(text, secs)`, `toast(text)`, `prompt(text\|null, owner?)` (each owner keeps its own line; the latest shows), `timer(on)`, `crosshair(on)`, `bars(owner, rows)`, `pop(text, x, y, color)`, `panels` (§6j), `covered` |
| `hud`, `menu` | The kit's HUD and home menu (§6g). Read-only views for rules: reading works (`menu.view`, `menu.paused`, `menu.observe()`; `hud.goalText`, `hud.observe()`, `hud.fullscreen()`); calling anything else or writing a property is refused (`kit-ui-pressed`, §7) |
| `audio` | §2.5 |
| `input` | The local input: `move`, `look`, `actions`, `sprint`, `touch`, `pointer`, `wheel`, `locked`, `lockRefused`, `following`, `cursorMode`, `aimFree`, `keyPressed(code)`, `keysPressed()`, `lookScale` and `invertY` (from the menu's settings) |
| `round` | `{phase: 'lobby'\|'countdown'\|'playing'\|'results', number, winners, reason, end(reason, winners)}`; `end` acts on the host only |
| `fair`, `bots` | Fair play and the bots' fair target helper (§6c) |
| `looks` | This player's loadout (§6e): `key`, `apply(loadout)` |
| `aimed` | True when a mechanic aims (projectile; carry with a throw action): the kit shows the crosshair and turns the shooter to the aim while firing (§6d) |
| `aimBodies` | An array of functions → `[{id, x, z, height, radius}]`: bodies the crosshair ray stops on (waves' enemies, the boss) |
| `presenceOf(p)` | Where a player is when a part holds their body and gives them a mark (a board's cursor), else null |
| `look` | The look handle (`render`, `resize`, `update`, `fitShadows`, …) |
| `resolution` | `{target, ratio, budget}` (§6i) |
| `onFrame` | An array: push `fn(dt)` to run every frame after the rules |
| `makeBot(p)` | The kit's bot brain for a player (the session uses it) |
| `turns`, `match` | The flow's API when the game names that flow (§4.7) |
| `worldMode` | True in a world (§9) |
| `mechanicsList`, `modules` | The kit's own lists (the instances; the loaded modules and which are stand-ins) |

Engines add their own: `ctx.forge`, `ctx.tables`, `ctx.slotIndex`, `ctx.render`, `ctx.fight`, `ctx.feel`, `ctx.ai` (§8 forge); `ctx.vista`, `ctx.finish` (§8 vista).

### 3.3 A player

`{ id, name, color, seat, isBot, local, owned, score, alive, data: {}, character, controller, body, pose, position (feet, Vector3), yaw, anim, aim [x,y,z], aimDist, actions, input, bot, poseExtra, connected, drawn, onScreen }`

- `p.score` is that player's own score. The results card shows each player the score the game gave them, so every player's own score lives in `p.score`, even in a co-op game.
- `aim` is a unit direction from the aim origin (feet + 1.2 m). `aimDist` (the local player in third or first person, and friends through the pose's `ad`) is how far along it the point under the crosshair is: `aimTarget(p)` in `kit/core/aim.js`. Bots and the top camera have no `aimDist` (null). `p.controller.aimAt(point | null)` holds the aim on a world point (QA, fixtures).
- `owned`: this copy simulates the player (the local player; every bot on the host). Read `p.actions.<primary|secondary|interact|jump>.{pressed, down, released}` on owned players only.
- `p.act(word, seconds)`: hold an anim word (`'aim'`, `'emote_cheer'`, …). The pose carries it, so every copy plays it.
- `p.knock({x,y,z} m/s, seconds, {out, force})` and `p.teleport({x,y,z}, yaw)`: callable from any copy; the kit applies them on the copy that owns the player (an event to that copy otherwise). Fair play's rules for knocks: §6c. `p.push(v)` is a shove that never knocks over (streams, contact damage), routed the same way.
- `p.poseExtra = {k: number}`: small numbers that ride in the pose (`extra`), e.g. a stream's pressure. A bot's ride in the host's bot list, so every copy reads `p.pose.extra` for friends and bots alike.
- `p.data` is the game's per-player state. A replay empties it but keeps the same object.
- `p.bot` on the host's bots: `seek(pos, {stop})`, `flee(pos)`, `wander()`, `stop()`, `aimAt(pos)`, `face(yaw)`, `press(action)`, `hold(action, secs)`, `rng()`.

### 3.4 Shared state and events

```js
const S = ctx.shared.register('balls', { list: [] });   // every copy, in setup(): same key, same initial object
if (ctx.host) S.list.push({ id: 1, x: 0, y: 0, z: 0, h: '' });   // the host mutates
const drawn = ctx.shared.smooth('balls');                // other copies: blended between snapshots (for drawing)
```

- Only the host writes. A write from a copy that is not the host, at the top level or nested, changes nothing and is refused (`shared-write-not-host`, §7).
- Everything registered goes into one `net.world` message with the kit's state (≤ 3.5 KB: short keys, round numbers), about 12 a second.
- Read numbers that must not blend (ids, counts, states) through the proxy (the latest snapshot), never `smooth()`.
- A replay resets every key to a copy of its initial object.
- `ctx.net.send(name, data, to)` travels as one kit message type. It reaches `rules.event(ctx, name, data, from)`, any `ctx.net.on(name, fn)`, or, for a name `"<mechanicId>:<event>"`, that mechanic's `event(event, data, from)` (a flow's id works the same). Alone nothing is sent: the local copy is the host, so apply directly.

### 3.5 The frame (every copy)

```
input.update()                     the local player's move/look/actions (edges valid for this frame)
session.tick(dt)                   round clock; a non-host copy applies the host's world; friends placed from poses
bots (host only)                   brain.begin() → the flow's bot, rules.bot(ctx, p, dt) or the default → brain.finish(dt)
physics ×N at 60 Hz                controller.fixedStep() → world.step() → controller.postStep()   (at most 6 steps)
controllers.update(dt, alpha)      characters placed and animated, camera, ctx.me.aim
fair.update(dt)                    who is down or protected (the host referees; every copy shows the shimmer)
mechanic.update(dt)                each mechanic instance
rules.update(ctx, dt)              every phase: check ctx.round.phase yourself
ctx.onFrame[i](dt)
session.send()                     my pose (15/s) and, on the host, the world (12/s): kit state + ctx.shared
world.update(dt), look.update, ui.update, hud.update, look.render(camera)
```

The frame runs through `net.loop`, which never pauses, also in a background tab. Alone, the pause menu holds the game still (§6g M2); with friends a round never pauses. `dt` is capped at 0.1 s.

### 3.6 What the kit owns

- the boot and the frame loop;
- the home menu (title screen, How to play, Settings, the wallet), the pause menu, the countdown, results and replay (§6g);
- the HUD's player card: health, knocked down or out, each mechanic's meter, the goal line, the menu button and the full-screen button (§6g);
- spawning players and bots; who plays in a friends round (§6h);
- local movement through the controller, and sending and drawing poses;
- drawing friends as characters with nameplates, each in their own look (§6e);
- the camera and the mouse: the pointer lock, the crosshair, aiming (§6d);
- fair play (§6c) and how hits read (§6f);
- quality tiers and the pixels drawn (§6i);
- the world's layout (§4.3).

The kit refuses game code that tries to do these things (§7).

### 3.7 Random numbers

`ctx.rng()` is the documented way: seeded, repeatable for the same `?seed=`. While the kit runs a rules hook (any function on the rules object: `setup`, `roundStart`, `update`, `event`, `check`, `results`, `bot`, `observe`, …), `Math.random` draws from a seeded stream forked from the game seed (`rules:Math.random`, apart from `ctx.rng()`'s), so rules that call `Math.random` are seeded too. Only the hook's synchronous part counts: a timer or an awaited promise the rules leave for later draws as before. The kit's own calls and its vendored libraries' calls outside hooks are untouched (`seedRules` in `kit/core/guard.js`).

## 4. Module interfaces

### 4.1 Mechanics: `kit/mechanics/<id>/index.js`

```js
export const id = 'projectile';
export const params = { type: 'object', properties: { speed: { type: 'number', default: 18 } } };  // JSON Schema
export const examples = ['dodgeball throw', 'water-gun stream'];        // the `as` lines catalog.mjs shows
export const slots = [ /* templates (§2.2) */ ];                       // or slotsFor(mechanicConfig, cfgAll)
export const manifest = { id, examples, params, describe, needs, uses, owns, state, events, sync, note, stub, signs, items? };
// optional: defaults that follow the game's own config (create calls it after the kind is applied, only for params the
// spec left unset, and says so in its notes; the spec's own value always wins), e.g. a stream's reach from the camera
export function derive(game, params) { return {}; }
export function create(ctx, params) {
  return {
    setup(ctx) {},              // optional, may be async: once the players, ctx.me and ctx.shared exist, before rules.setup
    update(dt) {},              // every copy, every frame
    event(name, data, from) {}, // optional: its own events, sent as `<id>:<name>`
    reset() {},                 // optional: on a replay and back to the menu
    // optional parts the kit reads: aimed, interacts, interactables(), points(), presence(p), stats, landing(p),
    // slotChanged(id), hostChanged(isHost), watchKey(), watchStart(data), watchEnd(), watchRoom(code), observe()
    // plus the mechanic's own methods, documented in its README.md (e.g. fire(player, dir), coverage(), spawnWave(n))
  };
}
```

- **It imports in Node with no DOM** (`tools/lib/kit-import.mjs` resolves `three`, `three/addons/*`, Rapier, `postprocessing`, `n8ao`, `../../../mp/net.js`, `../../../gf-assets.js`): `create`, `slots.mjs` and `catalog.mjs` read `id`, `params`, `examples`, `slots` and `manifest` that way.
- **The manifest** (fields and their meaning: `tools/catalog.mjs` `MANIFEST`; `manifestProblems` checks the shape; where it runs is its registry manifest's, `components/<id>/mechanic.json` → `impl`): `needs` (parts and world capabilities it cannot work without: `create` refuses a spec that lacks one); `uses`; `owns` (resources it claims, such as `input.<action>`, `player.control`, `round.end`: `create` refuses two owners of one resource unless every claim is shared); `state` (its key in `snapshot().shared`); `events` (the callbacks `rules.js` can hook, who hears them, with what); `sync` (which copy decides); `note` (one to three lines for the build agent); `stub` (its variable in `rules.js`, one worked line, its traps); `signs` (its sign of life for the checks); `items` (§2.4).
- `create` checks the spec's params against `params` and fills its `default`s into `config/game.json`. `create` runs before the players exist; register `ctx.shared` keys in `setup`.
- Models come through `ctx.assets.model('mechanic.<id>.model')` or a `prop.<name>` slot; every mesh it adds carries a slot (§2.3).
- Messages stay within the gf-multiplayer limits: 4 KB a message, at most 60 messages per player per second, `net.world` at most 3.5 KB. Each mechanic handles the netcode traps in PLAN §2.6 (`spec/PLAN.md`).
- **Fixtures.** A mechanic carries a 2-player fixture in `kit/mechanics/<id>/fixture/`: a mini-spec made with `node builder/tools/create.mjs <mini.spec.json> kit/mechanics/<id>/fixture`, its own `rules.js`, served with `tools/serve.mjs` and gated with `tools/verify.mjs`. `build`, `panels` and `shove` have none (build and shove are played through the world flow, §9; panels through `tests/m4d-panels.test.mjs`).

| Id | Mechanic | Runs on (three profiles; `mechanic.json` → `impl`) |
|---|---|---|
| `projectile` | Discrete and continuous streams, arcs, hits, splash | standard-3d, scenic-3d |
| `paint` | Surface coverage per player or team; territory score | standard-3d, scenic-3d |
| `pickup` | Consumables that refill or modify a player's meters; respawn | standard-3d, scenic-3d |
| `health` | Health, knockback, ragdoll and get-up, respawn | standard-3d, scenic-3d |
| `carry` | Grab, carry and throw props or players | standard-3d, scenic-3d |
| `waves` | Host-owned enemies, spawners, a target to defend; enemy `types` | standard-3d, scenic-3d |
| `station` | Interact with a prop: an in-world screen or panel UI, timed tasks, quotas | standard-3d, scenic-3d |
| `race` | Checkpoints, laps, a finish order | standard-3d, scenic-3d |
| `tag` | Roles that pass between players on contact, hide and seek | standard-3d, scenic-3d |
| `teams` | Team assignment, team score | standard-3d, scenic-3d |
| `melee` | A weapon you swing: a weapon table of combo chains (windup, active, recover, arc, reach, damage, knockback, hit-stop, lunge), a heavy attack, a dash with invulnerable frames; swings follow `p.aim`; hits read as §6f; local hit-stop and shake only; the weapon on `hand_r`; bots swing | standard-3d, scenic-3d |
| `levels` | A run of levels: each level's encounter, then its portal opens; everyone in the portal moves to the next level (`ctx.world.setLevel`, `p.teleport`); the last level is the boss's; a lost run restarts at level 1 | standard-3d, scenic-3d |
| `boss` | One big enemy with phases: its own body role and scale, telegraphed slam, charge, volley and summon, a named health bar across the HUD top | standard-3d, scenic-3d |
| `loot` | Drops and choices: coins and potions on kills, chests (interact), weapon drops that swap the melee weapon with a rarity colour, one of three upgrade cards between levels | standard-3d, scenic-3d |
| `board` | A grid on the floor: take turns placing or moving pieces; joins the `turns` flow (`kit/loops/README.md`) | standard-3d, flat-2d |
| `build` | Place, break and paint blocks in a voxel world; signs and boom blocks; saved on the play host (§9) | standard-3d, scenic-3d |
| `shove` | A key or touch button pushes the nearest player in front; a push, never a knock-down (§9) | standard-3d, scenic-3d |
| `panels` | The shared panels for `rules.js` (§6j) | standard-3d, scenic-3d |

**Enemy types** (`waves.types`): each with a body role, hp, speed, damage, reach, a `behaviour` (`chaser`, `lunger`, `ranged`, `brute`, `shielded`), a telegraph and a score. **Attack tokens** let at most N enemies swing at once. In a scenic game, `create` fills the action mechanics' models from the scenic library (melee weapons; a type's or the boss's `weapon` given as a library id such as `kaykit-skeleton-axe`; loot's chest, coin and potion) and adds their sounds (`melee-*`, `enemy-*`, `boss-*`, `portal-*`, `loot-*`).

### 4.2 Look: `kit/look/look.js`

```js
export function createRenderer(canvas, preset, quality)  // WebGLRenderer + tone mapping + shadows from the preset
export function applyLook(ctx, preset)                   // lights, sky/fog, environment, post stack (EffectComposer: N8AO, bloom, outline, grade) → handle
export function material(kind, opts)                     // house materials: 'character' | 'prop' | 'ground' | 'water' | 'liquid' | 'glow' | 'decal' (lit like the ground)
export function lookConfig(presetId, { time })           // what create writes to config/look.json
export const presets                                     // 'jelly-pastel', 'toon-lowpoly', 'soft-stylised' (kit/look/presets/*.json)
export const TIMES = ['day', 'golden', 'night'], QUALITIES = ['high', 'low']
export { slots, slotsFor }                               // slotsFor(lookJson): the look slots
```

- A preset is plain JSON. Every number and colour in it becomes a `look.*` slot.
- Materials accept a tint. Lighting and post settings are tuned per quality tier.
- The handle has `render(camera)`, `resize(w, h)`, `update(dt, focus)`; the kit calls them when present, else `renderer.render`. A look may also export `ready(renderer)` (awaited after `createRenderer`), `createCamera(values)` and `resizeCamera(...)` (a flat game's orthographic camera).
- Seat colours come from `character.tint.<role>` (`config/characters.json` → `palette`), else `look.palette.players`.

### 4.3 World: `kit/world/world.js`

```js
export async function loadWorld(ctx, worldConfig)        // template + layout → meshes (all slots), colliders, spawns, zones
export const templates = ['backyard', 'office', 'plaza', 'arena', 'store']
export async function templateLayout(id, { size, seed }) // the template's recipe expanded at a size class
export function slotsFor(worldJson, catalog, licences)
```

The world is the kit's. `create` generates `config/world.json` from the template at the spec's `world.size`.

- **Templates are recipes; layouts are generated.** `kit/world/generate.js` (pure; `create`, the lint and the browser share it) turns a template's recipe, a size class (`small` | `medium` | `large`, the spec's `world.size`) and a seed (the title's hash) into the concrete `config/world.json`.
  - An **indoor** recipe (office; store: a supermarket) is a closed building: bands of side rooms round the main room; doorways joining them (a spanning tree from the main room, loops from medium up); doors to the street for the rooms marked `entry`; walls on a 2 m module with windows; a ceiling and lamps; each room dressed by its zone recipe from the template's furniture groups; and a street with city blocks outside.
  - An **outdoor** recipe keeps its hand-dressed small layout, grows it for larger classes, and closes its edge (`edge`, `gates`).
- **A layout** is JSON: `{ template, props: [{ prop, at:[x,y,z], rot, scale }], spawns: [[x,y,z]...], zones: { name: { shape, at, size } } }`. `rot` is in **degrees** (yaw, or `[x,y,z]`). Indoor layouts add `kind: "indoor"`, `sizeClass`, `rooms: [{id, kind, label, rect: [x0,z0,x1,z1], main}]`, `doors: [{at, rooms: [a, b], normal, width}]`, `entries: [{name, room, at, normal (outward), width}]` and `ceiling: {height, color, color2, glow, band, pattern}`.
- **The ceiling** is a kit primitive drawn as a **cutaway**. It faces down (seen from inside, culled from above) and fades as the camera rises to it, with what hangs from it. A band (slot `world.<t>.ceiling.band`) closes the walls up to it. Slots `world.<t>.ceiling.color`, `.band`, `.pattern`.
- **`ctx.world`** has `spawn(i)`, `zone(name)`, `props: Map`, `raycast(from, dir, max)`, `bounds`, `root`, `update(dt)`, and from the generator `kind`, `sizeClass`, `rooms`, `doors`, `entries`, `roomAt(x, z)`, `via(from, to)` (the next point toward another room, through its doors; the waves mechanic and the bots walk through it) and `entry(rng)` (a point just inside a real door or gate: the waves mechanic brings enemies in there). Spawns in a world with rooms face the main room's centre zone.
- **What a game does with it.** Enemies come in through its `entries` and walk through the doors by themselves. Stand the thing players defend or gather at in the `centre` zone (the main room's middle), and add props inside the rooms. The walls, the ceiling, the doors and the outside are the world's: the world lint (`node tools/world.mjs <game>`) fails a world that is open, the wrong size, or has no doors for its enemies.
- **Colliders** come from simple shapes declared per prop in the asset library (an asset's `use.collider`; a compound or ramp one in its pack's sources.json). They may be `{shape: 'compound', parts: [...]}` (a doorway: two posts and a lintel, so the opening is real); doorways carry `door: {width, height}`.
- **Set dressing.** `ground.pattern` (slot `world.<t>.ground.pattern`, a baked CC0 texture: paving, carpet tiles, lawn stripes, checker) keeps every floor readable. The library's prop entries carry `real` (the real-world size the lint compares against a 1.7 m character) and `hosts` (what may stand on or inside them, e.g. a planter hosts a tree). Pickups draw the game's own prop (`mechanics[pickup].params.prop`); their ground ring is `params.marker` (`auto` | `ring` | `none`). The lint is `tools/dressing.mjs <game | template>` (rules and thresholds in `tools/lib/dressing.mjs`). How the game looks is judged on the contact sheet by the look judge (`builder/look-judge`) against the game's kind and the person's images. The contact sheet has a `top` plan shot, and no shot starts inside or behind a prop.

Scenic worlds and levels: §8. Voxel worlds: §9. Tile maps: §10.

### 4.4 Character: `kit/character/character.js` (the standard: `kit/character/RIG.md`)

```js
export async function spawnCharacter(ctx, { player, bodySlot, clipsSlot, tint, local, height, plate, onState })
// → { object3d, height, update(dt), play(clip, {loop, fade}), stop(), locomotion(speed, grounded), setAim(pitch),
//     socket(name) /* head|hand_r|hand_l|back */, knock(velocity /* world m/s */, {getUp}), ragdoll(on), setTint(c),
//     setLookTint(c), setHat(obj), look, nameplate(text, color), plate, state, anim, meta, clips, bones, dispose(),
//     express(name, seconds) /* a gfFaces face, e.g. 'hurt' */, face, faces, hipHeight, plateOffset? }
// onState(state, info): 'getup' fires with {position, yaw}, and the controller teleports its capsule there.
export function slotsFor(cfg)   // slot templates: character.body.<role>, character.tint.<role>, character.hat.<role>
export { CLIPS, RIG } from './rig.js'; export { GROUPS } from './ragdoll.js';
```

- Clips: `library/clips/gf-humanoid-1.glb`, bound by bone name. Every clip file carries `CLIPS` (`rig.js`); the melee clips (`MELEE_CLIPS`) are optional at load. Names and metadata: RIG.md §4.
- Any GLB that passes `tools/rig-check.mjs` works as a body.
- Faces (RIG.md §3, `gfFaces`): the beans carry a hurt face. The projectile mechanic shows it on a body while a stream is on it or a shot hits it, and a knocked-down body shows it by itself.
- **How the kit drives it.** Every frame it places `object3d` (feet, `rotation.y = yaw`), calls `locomotion(speed, grounded)`, `setAim(pitch)` (-1..1 from the aim's y) and `update(dt)`. Anim words drive the rest: `knockdown` (stunned) → `ragdoll(true)`; `down` (the ragdoll still settling, while `character.state === 'ragdoll'`) → `ragdoll(false)`, so it gets up once settled; `getup` (while `state === 'getup'`); any other word → `play(word)`. `player.knock(v, secs)` sends the capsule flying, stunned, and `character.knock(v, {getUp: false})` ragdolls with the same world velocity. While the character is not in `'anim'`, the capsule takes no input. A remote player's copy ragdolls from the same words.
- **Collision groups** (RIG.md §6, `kit/core/util.js`): WORLD 0x1, PLAYERS 0x2, PROPS 0x4, RAGDOLL 0x8. A capsule is a PLAYER meeting WORLD | PLAYERS | PROPS; its ground cast and the camera's cast see WORLD | PROPS only; the stand-in world's colliders are WORLD. The character, projectile, carry, waves and `fixedRay` read Rapier through `physicsOf(ctx)`.

### 4.5 Controller: `kit/controller/controller.js`

```js
createController(ctx, { player, character, camera: 'third'|'first'|'top'|'follow'|'orbit', speed, jump, sprint, spawn, settings })
// → { update(dt, alpha), fixedStep(), postStep(), pose() /* for net */, teleport(p, yaw), knock(impulse, secs, {budget}),
//     push(impulse), aimAt(point | null), act(word, secs), enabled, rig, feet, state, anim }
```

- Keyboard and mouse, plus touch, through `kit/core/input.js`. Camera rigs and their defaults: `RIG_DEFAULTS` in `kit/controller/camera-rig.js`, tuned in `config/game.json` → `controller.camera.<mode>`.
- `ctx.me.aim` is a normalised direction. In third and first person it points from the aim origin (feet + 1.2 m) at the point under the crosshair, and `ctx.me.aimDist` is how far that point is (§6d).
- `ctx.me.actions` is `{ primary, secondary, interact, jump }` with edge flags.
- `enabled = false` ignores input; physics continues. The kit enables owned controllers only while playing.

### 4.6 Net: `kit/net/`

- Wraps `gf/mp/net.js` (`session.js` the round and the room, `players.js` the players, `shared.js` `ctx.shared`, `looks.js` loadouts, `host.js` the hosting page, `persist.js` a world's store).
- **Poses** are sent by the kit: `{x, y, z, yaw, anim, aim, ad, lk, extra}` (`ad`: the aim distance, §6d; `lk`: the player's loadout key, §6e, absent without a loadout). A mechanic may add small numbers to `extra`, for example a stream's on/off and pressure.
- **Shared state:** `ctx.shared` is batched into one `net.world` message. Numbers that must not blend are sent as strings or read from `latest` (net.js header).
- **Alone:** `net.active` is false, and the same code runs for one player plus bots.

### 4.7 Flows: `kit/loops/<id>/index.js`

How a round is played is a part a game picks (`spec.loop` → `config/game.json` → `round.flow`, `round.params`). `kit/loops/README.md` is the interface (the module, its hooks, the manifest, how `turns` drives a board).

- **What a flow owns:** everything while the phase is `playing`: whose clock, who may act, what ends it. The lobby, countdown, results, replay, players and net stay the session's (`kit/net/session.js`) for every flow.
- **The flows:** `round` (the timed round; the default when a game names none), `turns` (`ctx.turns`; rules hooks `move`, `turnStart`, `turnTimeout`, `botMove`, `canAct`), `match` (`ctx.match`; rounds won are the score), `endless` (no clock; `rules.check` is the only end). `saved` is not built. A world (§9) is a mode of the session, not a flow.
- **`round.seconds`:** the length of a round for `round` and `match`; for `turns` and `endless` it is optional and caps the whole session. `ctx.time.left` is what the HUD's clock shows: the round's, a turn's, or `Infinity` when there is none.
- **Bots alone:** the flow says how many (`botsAlone`): `turns` seats `players.min - 1` (at least one), the others fill every seat. `?bots=N` still asks for a number.
- **The observation:** `snapshot().flow` is what a flow publishes (`turns`: `{id, order, turn, moves, passed, refused, left, why}`); a flow's shared state is in `snapshot().shared` under its manifest's `state.key`.
- **Signs:** a flow's manifest carries its signs for the checks: `signs.pulse`, `signs.sample` and `judge`, `signs.pressed`, and `signs.short` (what a 25 s check round cuts; `tools/lib/flow-signs.mjs`).

## 5. The observation and the verify gate

Verify judges a game by the gates of [GATES.md](GATES.md) (below); `tools/lib/verdict.mjs` is the rule and `tools/lib/homes.json` each measure's rule and fix (the full `window.__game` is §11).

- **`window.__game`** (K1): `{ kit: 'gf-three', version, phase, players: [{id, name, score, alive, x, z}], snapshot(), seed, quality }`. `snapshot()` holds no functions and is stable for the same seed.
- **`window.__game.events({since})`** (kit/core/events.js, the event log): `{entries: [{i, t, w, ph, k: 'event' | 'counter' | 'score' | 'input' | 'sound', part, name, who: {field: playerId}, at, …}], next, dropped, kinds, me}`: every event a mechanic's manifest lists, a mechanic's counters, every score change, the local player's presses and every sound the kit plays. Read-only; `ctx.events.count(player, what, {at})` is the one way a game's rules add to it (a counted event of the game's own).
- **`node builder/tools/verify.mjs <game> [--out evidence/verify-N] [--quick] [--release] [--gate X[,Y]] [--check N[,N]]`** prints a single verdict by gate and writes `verdict.json`.

**The gates** (builder/GATES.md, approved 2026-10-12; `tools/lib/verdict.mjs` GATES and MEASURES). A gate is a question about the player's experience, made of measures (the old numbered checks, regrouped, and the general measures 12, 38 and 39); each measure belongs to exactly one gate and keeps its number. A gate fails when any of its measures fails, and its failure names the measure, the rule and the fix (`tools/lib/homes.json`). World, forge and vista games use the same gates; their engine's own measures (26–30, 32–33, 36–37) sit in the gate whose question they answer.

- **A. Integrity**: is the kit untouched (its hashes are the kit release's), is every visible thing a slot, does every file a slot names exist and pass its own validator? 1, 2, 4, 18, 19; per release 8.
- **B. Health**: does it boot to play with no errors or kit refusals, at an acceptable frame cost? 3, 9 (when it ran), forge's and vista's 32, 33, 36; per release the kit's own pages: 20, 22, 24, 31.
- **C. Cause → effect**: does every input and every event the kit logs produce something the player it concerns can see or hear on their own screen, soon, and does control come back within `fair.downSeconds`? 10, 13, 15, 16, 38, a world's 30; per release 7 and 21.
- **D. The loop closes**: can a round be won or lost, does it end and replay, and does every score change come from a counted event? 6, 12, a world's 26.
- **E. Shared truth**: does every player see every other where they really are, and does each player's own value belong to that player? 5, 25, a world's 27, 28, 29; per release 34.
- **F. Matches the spec**: is the game what its locked spec says? 11, 14, 17, 35, 39, vista's 37.
- *Judges (advisory, J)*: 23 and the play-tester. They give findings and repair rounds, never a failed verdict.

The measures (Runs: build, every verify; release, the kit's own tests, `verify --release`; full, when it ran; advisory, a judge):

| # | Gate | Runs | Measure |
|---|---|---|---|
| 1 | A | build | `assets.json` valid (`builder/asset-manifest/validate.mjs`), its slot ids exactly the ones the declarations give (`tools/lib/manifest-check.mjs` against `assembleManifest`: a slot the kit modules, `config/*.json` or a file under `assets/` declares and the file lacks is put back by `tools/fix.mjs` before verify, with a note; a slot nothing declares fails and is named; a round game's flow only), and `multiplayer.json` valid |
| 2 | A | build | Kit copies are the kit's releases (`tools/lib/kit-check.mjs`): `gf/three` (and the runtime's `gf/scenic`, `gf/forge` or `gf/vista`) against the hash manifests that belong to the kit, `gf-three/kit-releases/<part>-<id>.json` and the kit as this checkout has it (`tools/lib/kit-release.mjs`; `regress.mjs --record` records a release), never against the list inside the game's own `gf/three/kit.js`: one release must hold every file the game has, byte for byte, and a file no release holds fails (an edit, or not a kit file; an edit to a kit file and to kit.js together still fails). `gf/mp` against the frozen gf-multiplayer releases, `audio/` and `gf/gf-assets.js` against their SHA256SUMS, `vendor/` against the pinned libraries |
| 3 | B | build | Boots to play with no console errors (real input through `builder/qa/browser.mjs`), and the player moves on real keys: the body, or, in a game whose part owns `player.control` by its manifest (a board with a cursor), the mark that part reports (`presence(p)` → `snapshot().players[].mark`; `tools/lib/part-signs.mjs`). The solo round's test player also takes its own turn when a part lists one (`controls().points`, or `interactables` marked `turn: true`; `tools/lib/turn-player.mjs`), so checks 7, 12 and 15 read a round in which the person played |
| 4 | A | build | Slot coverage 100% (§2.3), and the game's own code builds nothing to draw (`tools/lib/improvised-check.mjs`: no `new` geometry, mesh, sprite, points or line in `rules.js` or any other script of the game outside `gf/`, `vendor/` and `audio/`; what a game shows comes from a slot's file or a kit part. A reading of the source; a round game's flow only) |
| 5 | E | build | Two-player live gate (`builder/multiplayer/party/gate-live.mjs` or its gf-three adapter): each screen shows the other player where they really are, and the shared state matches. Plus the loadout leg (§6e, `tools/lib/loadout-check.mjs`): two players in different test loadouts each draw the other in their own body colour (read from the body's material) and shot colour (a stream's from its material; a discrete shot's as each copy resolves it for the shooter); a change mid-round and a reloaded copy follow |
| 6 | D | build | A round runs to results and replays, alone with bots and with two players |
| 7 | C | release | Audio gate v5 (`builder/audio-gates/qa-gate-v5.mjs`; a world and a forge game: v4 in their own flows). Over the solo round: the loudest sound, over the 100 ms it is loudest, reaches -32 LUFS (v4 read the loudest 400 ms against the same number, which a game of single short sounds never fills: board and panel games failed by 0.5 to 4 LU at the kit's own levels); at least 2 sounds of 2 kinds started and 8 in 10 of those that started reached the speakers; when the kit counts plays (`window.__game.sounds()`), one of the game's own listed sounds played when it lists two or more (not on the `ui` bus); and v4's ceilings unchanged (integrated, short-term, true peak, harshness, clipping, 12 sounds in 100 ms, silence while hidden). The kit's bus levels are never raised to pass |
| 8 | A | release | Swap proof: one body and one prop slot replaced by override, and the new model is visible |
| 9 | B | full | Contact sheet and frame cost on the real GPU (`tools/lib/sheet-check.mjs`, which ships beside verify and runs from any game folder; `--quick` skips): the kit's four cameras at 1920×1080 and 390×844, every mesh a slot, a 1920×1080 high-tier frame at most 1,500 draw calls and 4M triangles, and the frame rate at least 85% of a calibration page's in the same browser at the same moment (45% on the low tier under a 4× CPU throttle; the better of two tries), so a busy machine does not decide the verdict. A flat game's own sheet (`tools/lib/flat-sheet.mjs`); a game whose kit copy has no capture hook gets the kind's contact sheet, advisory |
| 10 | C | build | Fair play (§6c): a scripted human vs 3 bots for 42 s, twice at once (stands and fights; wanders and sprays), real keys, no `?gf-calm`. Fails when the player is out of control longer than `fair.downSeconds` + 1 s at once while alive, is in control under 85% of the time alive, or a protected player is knocked. Bot score balance is reported, not failed. `--check 10` runs it alone |
| 11 | F | build | Set dressing (§4.3, `tools/lib/dressing.mjs`, no browser, runs in `--quick`): nothing overlapping, floating, sunk or out of scale, no litter or stand-in pickups, open floor, readable ground and player colours, clear spawns. Errors fail; warnings are notes |
| 12 | D | build | Scores come from counted events (`tools/lib/score-events.mjs`; the old check 12, "something happens", is its first half): the solo round ends with some score of 2 or more, or on one of check 10's two pages a score climbs at least 2 above where it started and stays moved for at least 1.5 s (a flow with its own sign, `signs.pulse`, is judged by that). And every score change a player gets while the round is played, on every page verify opens, is matched one to one by a counted event in the kit's event log (`kit/core/events.js`, `window.__game.events()`) that names that player: a mechanic's event from its manifest (a kill, a pickup, a hit landed or taken, a move, a gate, a tag), a change of a number a mechanic keeps for them (`manifest.counters`: paint's share, tag's whole seconds), or the game's own `ctx.events.count(player, what)`, at most 1.6 s before it or 0.3 s after (an event naming no player counts once for each). A player with 3 or more changes nothing explains, a quarter of their changes or more, fails it: a score that only ticks. A reset to 0 is not judged. A kit copy with no event log is judged on the first half and the verdict says the scores were not traced |
| 13 | C | build | Controls work (§6d, `tools/lib/controls-check.mjs`): every control `config/game.json` → `controls` lists (the HUD's control line) does on the player's own screen what it says it does, on a solo page with no bots, real keys and mouse, on stepped time. A named control the kit does not show (anything but `primary`, `secondary`, `interact`, `jump` and the words `move` and `aim`) fails: no screen shows it. Each of the game's own rows, `controls.more: [keys, what, touch, does]` (keys as a player reads them: "A D / ← →", "Shift", "Click", "Mouse"), is held as its `does` says: `go` moves the player ≥ 1 m in 1.2 s; `turn`, after a short run on the go row (else W), bends the path ≥ 20° while held and keeps bending it, ≥ 10° after the first 200 ms, each key the opposite way (a strafe turns once to a fixed slant and fails; a wall that stops the player ends what is judged); each row on a fresh page, the player at its spawn; `stop`, after a run, slows the player more than coasting does (or backs it up); `move` ≥ 0.5 m; `point` moves the reported mark ≥ 0.3 m; `look` turns the camera ≥ 10°; `zoom` changes its distance by 10%; `rise` ≥ 0.25 m; `act` (or none) changes the game's state or the middle of the screen. A row on keys the kit already uses (W A S D, the arrows, Space, E, F, Q, Shift, the mouse) must say its `does` (2026-10-13, PA10: a car that strafed passed three times; regressions `car-strafes`, `car-controls-unshown`, `camera-keys-dead`, control `car-drives`). `jump` rises ≥ 0.25 m. `interact`: walk to the nearest interactable a mechanic exposes (a pickup spot, a free station, a free carry item), inside its press distance but outside its touch distance, press E (hold or tap for a station) → it changes. `primary` and `secondary`, held 1.4 s: the shot shows at the crosshair (in ≥ 2 frames, ≥ 12% of the pixels within 2.5% of the screen height of the middle changed beyond the released frames' noise; or one frame ≥ 24% and a sum ≥ 0.48 for a quick throw; or one frame ≥ 12% when the kit's observation says the shot landed there, in view); with the kit's observation also the player's own body does not cover the crosshair and the shot lands within 10% of the screen height of it, not behind the body; and paint changes when the game paints. `--check 13` runs it alone (about 15 s) |
| 14 | F | build | Looks honoured (`tools/lib/looks-check.mjs`, no browser, runs in `--quick`; `--check 14` alone): a character or prop the spec asks for `from: "generate"` or `"reference"` is not still a stand-in (byte-identical to a library bean, a kit stand-in file or the placeholder `create` put in its slot, or a GLB whose extras say bean), and two roles the spec describes differently never share one body file (they would differ only by tint). The one excuse is a failed generation the Studio worker recorded in `game/generated.json` (`gf-three-generated/1`: each item's state, reason and attempts) whose `delivery` line, added to the delivery summary, names the role or prop and the file; an item still `running` is pending (the build agent's own verify while the worker generates). Creator, Hang Up On Them: the zombies were the player's bean tinted purple and the token a stand-in crate, and nothing said so |
| 15 | C | build | The loop is alive (`tools/lib/alive-check.mjs`, runs in `--quick`): every page verify opens records the observation 4 times a second, and each mechanic in `config/game.json` must show its own sign of life in the kit's state on them. `waves`: enemies come and close ≥ 2 m on their goal (the target zone, or the nearest player) or reach it; with a target, its zone exists in `config/world.json`, the HUD shows its meter, and on an undefended page (no bots, the player standing still) its health falls ≥ 20%; a player who aims at an enemy with real mouse moves and fires hurts or kills it (else a kill on a page with bots). `pickup`: one taken. `projectile`: shots fly and a hit lands. `carry`, `station`, `paint`, `race`, `tag`, `teams`: an item held, progress, cells painted, a gate passed, someone it, two teams. The goal (a `config/game.json` prop whose role is the thing to defend) fills ≥ 0.3% of the player's first look at round start (`window.__game.sight(ids)`: a depth-tested render from the player's camera) and stands at the waves target. A value the game never reports is unmeasured, which fails. `--check 15` runs it alone (about 30 s) |
| 16 | C | build | Hits read (§6f, `tools/lib/hits-check.mjs`, runs in `--quick`): on a solo page with no bots and the kit's staged moment `?gf-demo=waves.hit` (one enemy at a time standing 6 m in front of the player, the game's own wave-1 hit points, weapon, rules and config), the player aims with the mouse and shoots with real clicks until 3 kills. How many hits a kill takes is measure 39 (gate F), from the same page. A hit that does not kill must change at least 3% of the enemy's pixels on the player's own screen (beyond the noise between frames before it) and show the kit's health bar over it (shown, at least 24x4 px, within 60 px of its head, at the hit points left, its fill drawn in its colour). A game without waves or projectile passes (nothing to hit). `--check 16` runs it alone (about 15 s) |
| 17 | F | build | The world is complete (`tools/lib/world-check.mjs`, no browser, runs in `--quick`; `tools/world.mjs <game>` alone): the play area matches the spec's size class (small 350–950 m², medium 1000–1800, large 1900–3200; `kit/world/generate.js` `SIZE_CLASSES`); medium has at least 3 rooms or areas and large 5; an indoor world has a ceiling and walls all round, open only at doorways a player can walk through; no outside prop of an indoor world shows over its walls (a street or skyline, not trees on a plain); from the middle, at least 12 of 16 directions meet a building (indoor) or a building, tree or hill (outdoor) past the edge; an outdoor edge goes all round, broken only at gates; when enemies come in (waves), the world names entries at real doors or gates (medium 2, large 3), and every room is reached through the doors. Filled ground and the three scales per room are notes. `--check 17` (or `--check 11,17`) runs it alone |
| 18 | A | build | Sounds play (`tools/lib/sounds-check.mjs`, no browser, runs in `--quick`; `--check 18` alone): the game loads one sound list, `assets.json` → `sounds` → `sounds`, and plays a missing id in silence (the kit's mechanics play theirs `optional`). So it fails when `assets.json` → `sounds` holds any key but `version`, `buses` and `sounds` (a sound put one level too high), a listed sound's file is missing, an audio file under `assets/` is played by no listed sound and named by no game code, or the game's own code (`rules.js` and its scripts, not the kit copies) plays an id, or a template pattern like `` `death-${n}` ``, that no listed sound matches. A mechanic's sound param (`soundCollect`, …) naming an unlisted sound is a note for now. Creator, Token Call Centre: four uploaded zombie death sounds were put beside the list and never played |
| 19 | A | build | Bodies hold their shape (`tools/lib/bodies-check.mjs` → `tools/lib/body-judge.mjs`, the model judge's measuring tier; no browser, runs in `--quick`; `--check 19` alone, about 1–2 s a body): every `character.body.*` slot's file, posed by the game's own retarget (`gf/three/character/rig.js`) through every clip of its clip file at 6 times each, beside the clips' own skeleton. Per part: **face** (the front of the head moves with the head, RMS within 6% of the head's size), **hands** (the palm's vertices stay on the hand, within 6% of its length; a bone inside the palm bends at most 20°; each finger joint bends as the clip's finger does, within 30° flex and 25° sideways, the thumb 40°), **arms and legs** (each segment within 15° of the clip's), and **at rest** (every part present, the hands alike left and right, no finger resting bent sideways, the hand resting in line with its arm as the clips' hand does, the toes forward). Folded triangles, stretched edges and a finger past what a finger can bend are notes. Creator, Token Call Centre: "We just made a game where the models look good, but the hand is crooked" (Quaternius fingers start inside the palm; the clips' knuckle bent the palm) |
| 20 | B | release | The menu works (§6g, `tools/lib/menu-check.mjs`; `--check 20` alone, about 15 s): a bare page opens on the kit's home menu with Play, Play with friends, How to play, Settings and the wallet on screen and nothing over them, and the game's title; How to play lists every control `config/game.json` → `controls` names and the goal; real clicks on Settings move the volume and the mouse sensitivity (the input's `lookScale`); the wallet view opens; Play starts the round; Esc opens the pause menu and alone the round clock stops; Resume carries on; Quit to menu goes back to the home menu and Play starts the next round; no console errors. On a phone (since 2026-10-12, `menuOnPhones`, `tools/lib/phone-fit.mjs`): a touch page at 390×844, 844×390 and 640×360, real taps: the home menu, How to play, Settings and the pause menu (the HUD's menu button) each with every control on the screen or in a box that scrolls, none cut off, none under 44 px, and Play, Back or Resume in view, also with everything else scrolled to its end. Creator, 2026-10-08: "our games are all missing a home menu"; 2026-10-12: "Looks like some of the buttons run off the screen" |
| 21 | C | release | The HUD shows your state (§6g, `tools/lib/menu-check.mjs`; `--check 21` alone, about 30 s): a 22 s round with 3 bots, real keys and clicks, and `?gf-demo=health.hurt`; sampled twice a second, the player card, the menu button and the goal line are on screen, and every widget the game's mechanics call for (from `config/game.json`, not the kit's own plan: health when it has hit points, a stream's tank, paint share, team, tag, race, waves, a station quota) is on screen in ≥ 90% of samples and shows what the kit's state says in ≥ 90%; health must follow the hit points the player loses, and a knocked-down or out player must be told so. Creator, same message: "a lot of user HUDs, especially for health" |
| 22 | B | release | The wallet in the menu (§6g, `tools/lib/menu-check.mjs`; `--check 22` alone, about 15 s): the game framed by a stand-in for the games.fun `/play` page on another origin (the page's side of `kit/net/host.js`, one test wallet, two items): the game hears the page, the menu lists the page's wallet, a click asks the page to connect, the menu shows the short address and the items, Wear asks the page, the page's loadout reaches the game and the player is drawn in the item's colour, Disconnect clears it, and Play with friends asks the page. Then the economy (W2, a second stand-in page, the game in stepped time; on forge, which has no stepped time, in real time on a round cut to 20 s through the overrides, as check 6 does, so it still reaches the results card; regression `forge-no-economy-buttons`): with no offer nothing of the economy is on screen (home, wallet view, HUD, pause, results); the page offers one action per place, and each button shows only where its `where` says with nothing over it, a real click sends `gf:econ-action` with its id, the HUD line shows the page's `gf:economy` entry and follows a change, and the observation has the offers, the state and the clicks; every paid button's visible text holds its price, at the normal height and at 787×613 (regression `hidden-price`). Creator, same message: "need to include wallet connect in the home menu for game item integration" |
| 23 | J | advisory | Looks like the references (§8, `tools/lib/likeness-check.mjs`, no browser of its own; `--check 23` alone, about $0.15–0.30 and 25 s): when the locked spec lists references with use "style" (a "character" reference is check 14's: the role's body made from the picture; judged here it was scored against whichever characters the shots showed) and the job has their files (`refs.json` and `refs/` beside the game, or `--refs <folder>`), one vision judge (Claude Opus through `claude -p`, as the model judge) scores each reference against the game's own shots (the player's view at round start and mid-round, and the contact sheet's wide and hero shots when check 9 ran) on camera angle, palette, light and glow, environment shapes, character proportions and style, and overall vibe, 0–2 each with one line of what differs. It fails below 60% of the points the shown aspects can give, or when any one reference is below 40%, naming what to change. With no references it passes ("no references"). The same files and references are never judged twice. Creator, the roguelike: "The assets should look very close to the attached images" and "The game also doesn't have the right vibe at all" (the delivered game scores 12%) |
| 24 | B | release | Plays inside a post (§6d C5, `tools/lib/embed-check.mjs`; `--check 24` alone, about 10 s): the game framed 480×480 by a stand-in post page on another origin, sandboxed without `allow-pointer-lock` (as X frames a player card) and allowing full screen. With a real mouse and keys: Play from the home menu; a click is refused the lock and the camera stays the game's own; the full-screen button is on screen, and a click makes the game full screen; there a drag turns a third or first camera (other cameras are noted, the step skipped), a camera with cursor mode off follows a plain mouse move with no button held, keeps turning with the cursor at the screen's edge and holds still back in the middle (the creator, 2026-10-12: "The mouse doesnt want to follow at all"), and W moves the player; the button leaves full screen; no console errors but the browser's own refusal of the lock. Creator, a post on X: "It doesn't stay in the iframe, you can easily move your mouse out" |
| 25 | E | build | Playing with friends (§6h, `tools/lib/friends-check.mjs`; `--check 25` alone, about 60 s): through the kit's friends page (`gf/mp/index.html`), two Chrome contexts over real WebRTC with real clicks and keys. The Host / Join screen opens with a name in its field (never blank); the host types one, the joiner joins with the one it was given, which must not be "Player"; the waiting room is the party page's own card, with no second copy of the room (the host-join kit's corner pill off, no standings rail) and the host's Start disabled while alone; the joiner clicks its name in the waiting room, types a new one and presses Enter, and the host's waiting room and both copies of the game show it; each player's dot in the waiting room is the colour the game draws that player in (`__game.looks()`); the round holds the two players and no bot on either copy; both play with keys and the primary action held, the host ends the round as a player would (the game's menu, `#gf-end-round`, or the rail's End round), and the party's results card, the only one (the game draws none of its own with friends), shows each player the score the game counted for them on both pages. On a phone (since 2026-10-12, gf-multiplayer 1.7.3, `friendsOnPhones`, `tools/lib/phone-fit.mjs`): two touch pages at 390×844, 844×390 and 640×360: the Host / Join screen, the waiting room alone, the invited friend's Host / Join, the waiting room with that friend (host and joiner) and the stream panel after Go live, each with nothing past the screen or cut off (shadow DOM included), nothing under 44 px, and Host, Join, Start, Turn on mic and the panel's × in view, also with everything else scrolled to its end. On gf-multiplayer 1.7.4 and later, also the game's own link (served under `/p/the-game/` by a server whose `/watch/v1` names a Studio origin): the waiting room's line to Studio's page (`#mp-voice-hint`, `<studio>/play/<slug>?join=<code>`), fitting the same sizes. Creator, 2026-10-08: "New users can't name before joining a room or change name in a room before the game. Final scores seem to always be the same regardless. We really shouldn't have bots in multiplayer modes" |
| 31 | B | release | Sharp on every screen (§6i, `tools/lib/screens-check.mjs`; `--check 31` alone, about 40 s): the game opened on a phone (390×844 at 3×, touch), a tablet (820×1180 at 2×, touch), a laptop (1366×768 at 1×) and a sharp laptop (1440×900 at 2×); then the laptop page zoomed to 150%, switched to a phone in the browser's device mode and back, without a reload. Each time the game's biggest canvas must draw the screen's real pixels (CSS size × devicePixelRatio), lowered only as far as the kit's pixel budget for that screen allows (2% slack for rounding). It measures the canvas itself, so it judges a game on any kit. Creator, 2026-10-09: "Different screen sizes make the game look bad. I just tested a smaller screen size and the game looks very fuzzy" (a phone drew 33% of its pixels, a 150% zoom 67%) |
| 34 | E | release | Watch then play (§9b, `tools/lib/friends-watch-check.mjs`; a world: `tools/lib/worlds-watch-check.mjs`; `--check 34` alone, about 15 s; numbered 32 on its branch and in gf-multiplayer 1.6.0–1.6.2's frozen READMEs, until the forge engine's own 32 and 33 reached main first). Creator, 2026-10-09: "people would be able to do a mini stream right from X as they play and others would be able to watch or join". A live game: two players in a round over real WebRTC; the host opens the game's menu and presses Go live (the share sheet with Post on X; LIVE on both screens); a viewer opens the link, tunes in to this round's page, draws the streamer where they really are after a real walk, has no player of its own in the game, follows the streamer with a camera close to theirs, and the count says 1 watching; a message sent to the relay as a viewer closes that socket (1008); Stop ends the stream for the viewer, with Play; Play opens the room's own link and the viewer joins that room (clicking Join while the lobby's backdrop is still loading the character clips, held until the click, so the friends page swaps the frame mid-load on every run). A world: the same, plus blocks built before and during the stream, Join in place without a reload, and in first person the viewer's eyes are the streamer's. Since play-test 1 (`watch/evidence/playtest-1/report.md`) both also hold: the stream's secret is not in localStorage, the streamer's keys reach the game after the share sheet closes (a real walk), and no stray words in the bar; a live game: LIVE leaves the round's clock in view, a viewer sees the clock and scores, its nameplates sit over the characters, and a streamer who reloads carries on, on the same link; a world: close to a wall the viewer still looks where the streamer looks, and after the host leaves the streamer's next edit reaches the viewer. Since gf-multiplayer 1.7.0 (the creator, 2026-10-12: "add in an audio stream from a mic for the stream watchers") both also hold the streamer's voice (`voiceSteps`): Studio's own capture file (`builder/studio-lib/voice-capture.mjs`) runs on a stand-in Studio page with Chrome's fake microphone (a 440 Hz tone) and hands voice to the streamer's friends page, the viewer taps for sound and plays at least 15 packets at a level over 0.05, and a message from the game below the streamer's page is refused. On 2026-10-12 a Bladder Brawl on 1.6.6 failed it (no sound button) and the same game on 1.7.0 passed, as did Blockhaven on 1.7.0. Since gf-multiplayer 1.7.1 (the creator, 2026-10-12, who went live on the game's own page and found no mic: "The mic options should come up after you click go live before you start the game") the voice comes through the stream panel: going live in the waiting room must offer Turn on mic (`#mp-live-mic`) before the round starts, the panel's button must open Studio's mic window at `/play/<slug>/voice`, a stand-in for that window running the same capture file must be heard by the viewer, the panel must show the mic on, and closing the window must turn it off. A Bladder Brawl on 1.7.0 fails those steps (no `#mp-live-mic`); Bladder Brawl, the forge zombie game and Blockhaven on 1.7.1 pass. Since gf-multiplayer 1.7.2 (the creator, 2026-10-12: "connect your mic when joining any game, it just had to be on the website. And then you could hear everyone voice in the stream", "Admin can kick, any player can mute them for themselves") it also holds voice chat between players and the host's Remove (`tools/lib/voice-chat-check.mjs`): a stand-in Studio play page on its own origin, running Studio's `voice-chat.mjs` and `voice-capture.mjs` with Chrome's fake microphone, frames the friends page; the invite opens that page; it hears who is in the room and who hosts; two players in voice hear each other; Mute is for the listener alone; a viewer hears the other player through the host's stream (the room's mix); the host's Remove tells the player and drops them from the room and voice; and that browser can't join again. A world does the same without the stream, with Studio's Remove |
| 35 | F | build | The game's own tests (`tools/lib/game-tests.mjs`; home "game"; `--check 35` alone, a few seconds). Every `<game>/tests/*.test.json`: `{promise, why, steps}`, where `promise` is the id of one of the game's own promises (`tools/promises.mjs`: its loop, its scoring, a mechanic as this game has it, its hook, an accept item) and `steps` is a play script (`tools/lib/play-script.mjs`) with at least one `expect` step, which reads a path in `window.__game.snapshot()` and holds it to a value. Each test runs alone on a page of its own, with real keys and clicks, on stepped time when the game's kit offers it. Fails when a test's expect does not hold, a step cannot run, the page logs an error, or a test file cannot be read or names no promise of this game. No tests: passes with nothing to run, and `verdict.json` → `gameTests.untested` lists the own promises no test names (`--own-tests require` makes that list a failure). Round games; a world's and a forge game's flows do not run it yet. |
| 38 | C | build | Every event answered (`tools/lib/events-check.mjs`; `--check 38` alone, about 15 s): one solo page with 3 bots, on stepped time when the kit offers it, the audio tap on; a scripted player walks, stands still, holds the primary and presses interact. After every 150 ms of the game's time verify keeps the player's own screen, the camera, the HUD's words, widgets and meters (not the clock, the nameplates or other players' scores), and reads the kit's event log. For each event the log names this player in (a manifest event: `quiet: true` marks the few nothing answers by design, a refused hit, a shot's end), it looks for an answer within 0.6 s: the HUD changed (when it stood still over the two frames before), a sound the kit played at that place (within 4 m; a sound with no place, in the same moment) reached the speakers on the tap, or, while the camera stood still and the place is on screen within 24 m, at least 3% of the pixels in a box round it (sized by distance) changed beyond the noise between the two frames before. A kind of event measured and never once answered fails, by name, with when and where; one judged only while the view moved is unmeasured. Every sound the kit started on the page must reach the speakers at least once (a dead file, a gain of 0, a muted bus fail it by id). A kit copy with no event log fails |
| 39 | F | build | Hits per kill as the spec says (`tools/lib/hits-check.mjs`, the same hits page as 16; `--check 39` alone): the median hits per kill (the kit's kill log) must be at least the locked `spec.json`'s waves `hitsPerKill` (2 when it sets none, 1 when it sets `oneHitKills`; a spec edited after create says nothing). `config/game.json` asking for fewer than the spec (its own `hitsPerKill` or `oneHitKills`) fails. A matter of taste is a spec default the creator can change (GATES.md), never a threshold in verify. A game without waves, or neither projectile nor melee, passes |

**Pass rule.** verify passes when every gate this run requires passes: every required measure ran and passed, none failed, 9 (the contact sheet) counts only when it ran, and a judge (23) never fails a verdict. A build's round game requires 20 measures in six gates (1–6, 10–19, 25, 35, 38, 39 less 7 and 8); a release run 28 (with 7, 8, 20, 21, 22, 24, 31 and 34). `MEASURES` and `MEASURES_OF` in `tools/lib/verdict.mjs` are the rule, so adding a measure means adding it there, in one gate, and a row to the table above (`tests/r-regressions.test.mjs` compares the two, gate and run included, and holds the rule to its cases in `regressions/verdict-rule`). `verdict.json` keeps `checks` (each measure with its `n`, its `gate` and, failing, its rule and fix) and adds `gates` (each gate's verdict, its measures, failed and missing ones). The budget (GATES.md): at most 8 gates; a new complaint widens the gate that should have caught it and never adds a numbered check.

**A build's verify and a release's (2026-10-10; 22 and 24 since 2026-10-11; 7, 20 and 21 since the gates, 2026-10-12).** The kit's own tests (7 the bus loudness, 8 the swap proof, 20–22 the menu, HUD and wallet, 24 a post, 31 sharp screens, 34 watch then play) test the kit: no `rules.js` or config can fail them short of breaking a kit-owned thing. A build's verify neither runs nor requires them (`RELEASE_ONLY` and `requiredFor` in `tools/lib/verdict.mjs`); `verify --release` does, each in the gate whose question it answers, and `regress.mjs --corpus` passes it. What a build could still break there moved into a general measure: a sound no one hears is measure 38's (gate C). Checks 2 and 25 stay in every build. Each check also has a home in `tools/lib/homes.json` (invariant, part, game or nowhere), with its rule and its fix; each of the five prompt rules (`builder/loop/brief.mjs` RULES) has its home and what enforces it; `tests/homes.test.mjs` fails a check or a rule that has none.

**What verify prints.** Each failing measure as it happens (`FAIL C 13 controls work — …`, with its rule and its fix; a judge's finding as `ADVISE J 23 …`), then each failing gate (`GATE C Cause → effect: FAIL — 13 controls work`) and one summary line (`FAIL gates 5/6, measures 19/20 failed: C (13)`); `--all` prints every gate, every measure and the progress lines. `verdict.json` records each measure's `seconds`, and a failing one's `rule` and `fix`.

**`--gate`** takes one gate or several (`C`, `C,F`; `J` the judges): every measure of it this kind of game makes in this run, `--release` adding its kit tests. **`--check`** takes one measure or any list (`13`, `1,2`, `3,4,5`): an alias for those measures, as other tools and older docs use it. **`--profile <file>`** is for a machine that cannot run everything (a CI runner with no graphics card): `{name, environment, skip: [{check, reason, legs?}]}`. The environment is set before any browser starts; a skipped check is recorded `ok: null` with its reason; check 5 with `"legs": "lobby"` runs the gate's lobby legs only. The verdict carries `profile` (name and the skipped list) and `profilePass`, and `pass` stays false while a required check is skipped: a profiled run is never a pass.

## 6. Studio preview subjects

Kit games answer `?gf-show=<subject>` (`kit/core/show.js`): the game skips the lobby, the net and the rules, and shows one thing in the world, framed, with no UI. `window.__game.ready` turns true once it is framed.
- `character.<role>`: a turntable of that role's body (it wears each `gf:loadout` the page sends, §2.4);
- `prop.<name>`: that prop alone, turning;
- `world`: a wide shot;
- `look`: four characters and the props, a three-quarter view;
- `vfx.<preset>`: an effect preset firing over the ground (`kit/vfx/show.js`);
- anything else: a mechanic module's `show(ctx, subject)` when one is passed in. The boot passes none today, so the world shows.

That way, Studio's Assets tab can show any slot in place with no per-game work.

## 6b. (merged)

The kit's as-built additions are in §3.1 (`observe`, `digest`), §3.2 (`ctx`, physics), §3.3 (players) and §4.1 (mechanic `setup`, `reset`).

## 6c. Fair play (kit-owned, on by default)

Fairness is the kit's job in every game. The rules are in `kit/core/fair-logic.js`, the runtime is `kit/core/fair.js` (`ctx.fair`), and the bots' helper is `kit/bots/bots.js` (`ctx.bots`).

| | The kit guarantees |
|---|---|
| F1 | A knock takes a player out of control for `downSeconds` (1.2 s) at most, from the hit to walking again: a short ragdoll tumble, then the get-up clip played faster. |
| F2 | A player who is down (knocked, ragdolled, getting up, or out) takes no damage and no knocks, and hits on them count for nothing. |
| F3 | Once control returns, the player has `protectSeconds` (1.5 s) of protection: no knocks, no damage, no counted hits. Their body shimmers in the `fair.protect-color` slot (an emissive glow on its own materials, no new art). |
| F4 | After a respawn, protection counts from when the player can move. The respawn point is the spawn farthest from the other live players, unless the game set `health.respawnZone`. |
| F5 | For the first `startGrace` (2 s) of a round, no hit counts and bots hold fire. |
| F6 | Continuous attacks (stream ticks, contact damage) push but never knock over. Knock-overs need a discrete hit: a shot, a splash, or a tag with knock. |
| F7 | Bots pick targets that can be hit and spread across them. They react and aim like people (`botSkill`, 0.35 by default, is friendly). At most `botsPerTarget` (1) bots may hurt one human at a time. Every bot holds fire in the grace and while aiming at a player who can't be hit, whatever `rules.bot` asks. |
| F8 | `projectile.onHit`, `health.onDamage` and `waves.onPlayerHit` fire only for hits that counted. A hit fair play refused goes to `projectile.onBlocked` (`why`: `out`, `down`, `protected`, `grace`, `busy`). Rules that score in those callbacks can't farm a helpless player. |

**Config.** `config/game.json` → `fair`: `{ on, downSeconds, protectSeconds, startGrace, botSkill, botsPerTarget, respawnFar, protectColor }`.
- `create` writes it with the defaults (`FAIR_DEFAULTS`); a game without the block gets the same defaults. Values are clamped to sane ranges (`fairConfig`).
- Every value is a `fair.*` slot. Three are main tier: `fair.down-seconds` ("Seconds down after a knock"), `fair.protect-seconds` and `fair.bot-skill`.
- `health.getUpSeconds` and `projectile.knockSeconds` apply only with fair play off.
- Fair play is turned off only when the creator asks.

**API** (the host decides; the other copies show).

| Call | What it does |
|---|---|
| `ctx.fair.canHit(p, {from})` | Does a hit on `p` count now? |
| `ctx.fair.blocked(p, {from})` | Why a hit doesn't count, or null |
| `ctx.fair.state(p)` | `'control'`, `'down'`, `'protected'` or `'out'` |
| `isDown(p)`, `isProtected(p)`, `grace`, `protect(p, secs)` | Read or set the same state |
| `params`, `split` | The values; `split` is `{total, ragdoll, getup}` for one knock |
| `p.knock(v, secs, {out, force})` | The host refuses (→ false) a knock on a player who is down or protected. A knock lasts `downSeconds` in all; `{out: true}` keeps the player down until revived. `force` skips the refusal, for a deliberate knock only, never for ordinary hits |
| `p.push(v)` | A shove that never knocks over |
| `health.damage(t, n, {push: true})` | A continuous hit: it damages and shoves |
| `ctx.bots.target(bot, {range, prefer})` | A player that can be hit, spread across bots; `prefer` is `'spread'`, `'nearest'` or `'leader'`. Null in the grace |
| `ctx.bots.attack(bot, t, {stop, action, hold})` | Seek, aim with human error, and hold `action` once ready |
| `ctx.bots.aim(bot, t)`, `ctx.bots.ready(bot)` | The parts of `attack` |

In `rules.bot`, pick foes with `ctx.bots.target(p, {range})` and fight with `ctx.bots.attack(p, t)`, not the nearest player. Score only hits that counted: score in `projectile.onHit` and `health.onDamage`, which already skip refused ones.

**Observation.** `window.__game.snapshot().players[i]` adds `control`, `down`, `protected` and `pl` (protection seconds left; host). `snapshot().fair` holds the values, `grace`, and stats (knocks, refused knocks, blocked hits by reason).

## 6d. Controls (kit-owned, on by default)

A player's own controls are the kit's: the mouse, the pointer lock, the camera, the crosshair and what interact does.

| | The kit guarantees |
|---|---|
| C1 | **Aim at the crosshair.** In third and first person the aim is the point under the crosshair: a ray from the camera through the middle of the screen into the world (ground, props, other players, `ctx.aimBodies`), starting at the player's depth so nothing between the camera and the player counts (`kit/core/aim.js` `crosshairPoint`). `p.aim` is the unit direction to it from the aim origin (feet + 1.2 m) and `p.aimDist` its distance; the pose carries both (`aim`, `ad`), so every copy knows the point (`aimTarget(p)`). Projectile shots and streams and carry's throw leave the player on the arc that lands there (`solveLaunch`: the low arc in reach, else the farthest landing toward it). Bots, the top camera and an explicit direction (`fire(p, dir)`, `throw(p, dir)`) aim along the given direction. While primary or secondary is held in a game with an aimed mechanic, the body turns to the aim. |
| C2 | **A readable crosshair.** Third-person framing puts the middle of the screen at head height 0.85 m right of the player (`RIG_DEFAULTS.third`: `height` 1.7, `shoulder` 0.85), so the body never covers it. The reticle (a ring and a dot, `kit/ui/ui.js`) shows in third and first person when a mechanic is aimed (`ctx.aimed`), in the `ui.crosshair` colour (`config/game.json` → `ui.crosshair`, default white) with a dark outline. It is UI, not world art. |
| C3 | **Interact means interact.** The pickup mechanic takes a spot on touch and on a press of `action` (E) within `reach` (`collect`: `touch` \| `press` \| `both`, default `both`; `reach` 2 m). Near something to press, the HUD prompts `E: <controls.interact>` in the game's own words (`ctx.ui.prompt(text, owner)`: pickup, carry and station each keep their own line). Every collect shows on every copy (the item flies into the collector, with the collect sound), whatever the rules then do with it. Carry prompts near a free item; station takes interact. |
| C4 | **The control line tells the truth.** The HUD's control line and How to play list `config/game.json` → `controls`: the kit's actions (`primary`, `secondary`, `interact`, `jump`), the words of its own rows (`move`, `aim`) and the game's own rows (`more: [[keys, what, touch?, does?]]`); a control named anything else is shown nowhere and fails measure 13. Every control listed does on the player's own screen what it says (a row's `does`: go, turn, stop, move, point, look, zoom, rise, act). |
| C5 | **Plays inside a post.** X frames a player card sandboxed without `allow-pointer-lock`, so the lock is refused and looking is click-drag. In a frame that allows full screen and is not the games.fun `/play` page (no `gf:host`), with a mouse, the HUD offers a full-screen button (bottom right, `#gf-fullscreen`); full screen keeps the cursor on the game. `input.lockRefused` records a refusal before any lock worked (a refusal after a lock worked is the re-lock delay); a refused lock also makes later clicks the action at once in browsers that only fire `pointerlockerror`. **In full screen with the lock refused**, a camera that looks with the mouse (`cursorMode` false: third and first; and `'look'`, a world in first person, which then aims at the crosshair as under the lock) follows a plain move with no button held (`input.following`), keeps turning while the cursor rests in the band at a screen edge (4% of the side, at least 18 px, up to 900 px of look a second at the very edge), and hides the cursor over the game; a click is the action at once. The 480-pixel card keeps click-drag. |

**What a game does.**
- The pointer lock is the kit's input's: it takes the lock when the player clicks the game, gives it back on Esc, and offers full screen where a frame refuses it. Read `ctx.input.locked`. Game code that calls `requestPointerLock` is refused (`pointer-lock`, §7).
- Keys, mouse and touch reach the game through `ctx.input` (`move`, `look`, `actions`, `keyPressed`, `keysPressed()`, `pointer`). Stopping one on its way to the kit's input is refused (`input-swallowed`, §7).
- The camera is picked in `config/game.json` → `camera` (`third`, `first`, `top`, `follow`, `orbit`) and tuned in `controller.camera`. Assigning `ctx.camera` is refused (`camera-swap`, §7).
- `#gf-fullscreen` is the kit's; hiding it is refused (`kit-ui-hidden`, §7).

**Observation.**
- `window.__game.controls()` → `{camera, crosshair, aimed, controls, prompt, viewport, aim: {dir, dist, point, hit, onSelf, screen}, landing: {point, age, screen, hiddenBySelf, fromAim}, interactables: [{kind, id, x, y, z, reach, touch, action, d}], points, mark, held, mechanics: [{id, aimed, interacts, stats}], me}`.
- Mechanics expose `aimed`, `interacts` and `interactables()`; projectile adds `landing(p)`. A part may also give `points()` (what may be clicked now, in CSS pixels: `controls().points`, each `{kind, id, x, y, action, turn, step, of, verb}`) and `presence(p)` (where a player is when the part holds their body: `controls().mark`, `snapshot().players[].mark`, and the gate block's `me` and `peers`, which then say `mark: true`). An interactable or a point marked `turn: true` is the player's move in a game of turns, and either may carry its own `verb`. `controls().held` says the local body's controller is off.
- `window.__game.camera()` → `{mode, yaw, pitch, cursorMode, cursor, aimFree, eye, dir, sensitivity, lookScale, invertY, crosshair, lockRefused, locked, following, fullscreen: {offered, shown, on}}`.

## 6e. Player looks and loadouts (kit-owned, on by default)

Each player may wear their own loadout (body, hat, body colour, shot or stream colour), and the kit draws every player in it on every screen. The wallet is optional (guests play); items are per game; loadouts are trusted from the client for now. The kit makes no game-specific cosmetic rules. Decisions: [wallet-loadout decisions](../foundations/evidence/wallet-loadout-decisions-2026-10-07.json), [scope](../foundations/evidence/wallet-loadout-scope-2026-10-07.json).

| | The kit guarantees |
|---|---|
| P1 | **Player-look slots.** A slot with `scope: "player"` in `assets.json` resolves per player: that player's loadout value or file when they have one, else the game's. Every game has these by default: `character.body.player`, `character.hat.player` (always declared; optional, and view-only when the game gives players no hat), `character.tint.player`, and each aimed mechanic's colour (`mechanic.projectile.color`). `config/game.json` → `loadout: { slots: [ids], off: [ids] }` adds slots a loadout may set, or keeps some the game's for everyone (`tools/slots.mjs` writes the scope; text and JSON slots never). |
| P2 | **Every copy draws every player in that player's loadout.** The body tint shows on the body. The ring, the nameplate, paint, team colours and every other gameplay colour keep the seat or team colour, so the game reads and scores the same. The player's own shots, stream, drops and splashes use their colour. A new body is put on once the player is on their feet, keeping the ring, held items and the controller. A hat goes on the head socket. Bots wear the game's defaults. |
| P3 | **Loadouts travel with the player.** They go on join and on change, and late or reloaded copies get everyone's. Changing a loadout mid-round updates every screen within about a second. |
| P4 | **A loadout is never fatal.** Unknown slots, wrong types, values outside a slot's range, files other players couldn't load, files over a slot's byte budget, and bodies that are not gf-humanoid-1 rigs are dropped for that player, and the game's own is used instead. |

**Format** (a look in Studio's shape, `creator-studio/docs/web3.md` "Variations"; `kit/assets/loadout.js`):

```json
{ "values": { "character.tint.player": "#23c64a", "mechanic.projectile.color": "#2457ff" },
  "files":  { "character.body.player": "https://…/body.glb", "character.hat.player": { "url": "https://…/hat.glb", "revision": "…" } },
  "pass": null }
```

- **Values.** `color` takes `#rrggbb` (`#rgb` is accepted). A `colors` slot (one entry per seat) takes one colour, the player's own. `number` and `integer` must be within the slot's `min`–`max`; `enum` takes one of its options; `boolean` takes true or false. Text and JSON are never part of a look.
- **Files.** An https URL, or a path inside the game with the slot type's extension. A Studio revision carries its `url`; the page resolves revisions before handing the loadout over. `data:` and `blob:` URLs are dropped (other players couldn't load them). The file must be within the slot's `maxBytes`. A body must pass the runtime rig check (skinned, with the gf-humanoid-1 required bones).
- **Size.** At most 3000 bytes of JSON (one net message).
- **`pass`** is reserved for a later wallet phase: a server-signed pass (wallet, items, expiry, and a session key made in the player's browser) that the play page will put there. On join the player would sign the room's challenge with that key, and the host could refuse items the wallet doesn't own. Today it is carried (opaque, ≤ 2 KB) and never read.
- **The client is trusted today.** Any player can claim any look, and every copy fetches the file URLs a player names. The next phase should check the pass and limit file URLs to the item store's origin.

**Input** (`kit/net/looks.js`). The page hands this player's loadout to the game, before boot or at any time:
- `window.__GF_LOADOUT = loadout` from a same-origin host. A later assignment applies too.
- `postMessage({ type: 'gf:loadout', loadout }, '*')` into the game's frame, from any ancestor window. The game says `{ type: 'gf:loadout-ready', v: 1 }` to its ancestors once it listens, and answers each message with `{ type: 'gf:loadout-applied', key, dropped }`.
- `?gf-loadout=<base64url JSON>`, QA only.
- `?gf-show=` subjects wear the page's loadout too, so Studio can render an item's look in the game.

**Net.** The pose carries `lk`, the loadout's key (8 hex digits). A copy holding a different key for a player asks that player's owner (kit message `lq`, at most every 1.5 s per player); the owner answers with `lo` (the loadout, one message). A change is sent to everyone at once, at most twice a second.

**API.**

| Call | What it does |
|---|---|
| `ctx.assets.value(id, fallback, { player: p })` | That player's value: their loadout's for a player-look slot, else the game's. A `colors` slot gives the player's own entry (by `p.seat`) |
| `ctx.assets.model(id, { player: p })`, `texture(id, { player })`, `url(id, { player })` | That player's own file, else the slot's (a failed own file falls back, and is dropped for them) |
| `ctx.assets.own(id, p)` | The player's own value only (undefined without one) |
| `ctx.assets.setLoadout(id, l)`, `loadout(id)`, `onLoadout(fn)`, `playerLooks()` | The per-player store the kit fills (`setLoadout` → `{key, loadout, dropped, changed}`) |
| `ctx.looks.apply(l)`, `ctx.looks.key` | This player's loadout, as the page's message sets it |
| `p.character.setLookTint(c)`, `setHat(obj)`, `look` | The body's own colour (wins over `setTint`, the gameplay tint), the hat, and what it wears now |

Rules that draw something in a player's colour or model read it per player through these calls. They never copy the game's value for everyone.

**Observation.** `window.__game.looks()` → `{ me, local: {key, from}, slots, players: [{id, name, bot, local, seat, color, key, advertised, values, files, dropped, drawn: {body, hat, tint, bodyTint, material, mix, visible}, shots: {color, stream, drops}}] }`. `drawn.material` is a tint material's colour read back from the scene, and `shots.stream` is the liquid arc's material tint. `node gf-three/tools/loadouts.mjs <game> [--third] [--a <json>] [--b <json>|none]` plays two players in different test loadouts (`--third` adds one who joins during round 1).

## 6f. Hits read (kit-owned, on by default)

Every hit is the kit's to show.

| | The kit guarantees |
|---|---|
| H1 | **A hit that does not kill reads, on every copy** (from the shared hit points alone): the enemy flashes (`mechanic.waves.flash-color` over its own materials, like fair play's shimmer: no new art), flinches (the gf-humanoid-1 `hit` clip and the hurt face; a stand-in squashes), is pushed back `hitKnock` m and staggers `stagger` s (a stream's ticks push a little and never stop it). A health bar shows over it from then on, drawn by the kit's UI like a nameplate (`ui.bars`, never a model: R2), in `mechanic.waves.bar-color`; what the hit took stays light for a moment before it drains. |
| H2 | **A death reads**: the body falls (the `knockdown` clip; a stand-in tips over), then sinks into the floor over `deathSeconds` (1.6 s), with the `soundKill` sound (`enemy-down`, an `explosion-small` preset `create` adds to games with waves); the killer's own screen shows `+killPoints` over it (`ui.pop`). |
| H3 | **Hits to kill**: a basic enemy takes 2–4 hits from the game's weapon. The defaults are hp 2 against projectile damage 1; `create` (`tools/lib/spec-config.mjs` `enemyToughness`) raises a spec's waves `hp` to three hits' worth when its damage (a stream's `streamDamage`) would kill in one. So keep the projectile's `damage` (or `streamDamage`) below waves `hp`. One-hit kills only when the locked spec asks: waves `oneHitKills: true`. If a player can't see their shots land, the fix is the aim, the range or the firing, never one-hit enemies. |
| H4 | **Aim at enemies**: the crosshair ray stops on an enemy where this copy draws it (`ctx.aimBodies`, `kit/core/aim.js`), so a shot lands on the one under the crosshair. |
| H5 | **Hits on players read** too: on the edge where a player's hit points drop, every copy plays their `hit` clip and hurt face, and the hurt player's own Health meter pulses. |

**Observation.** `window.__game.controls().mechanics[waves].stats` → `{demo, oneHitKills, hitsSeen, deathsSeen, dying, lastHit: {id, hp, max, t, flash, clip}, kills: [{id, hits, shots, max, from, t}] (host), enemies: [{id, x, z, hp, max, bar, body, head, feet (screen px)}]}`. The bars are `#gf-ui .gf-hbar[data-key="waves:<id>"]` (`data-frac` is the fill).

## 6g. The home menu, the HUD and the wallet (kit-owned, on by default)

The kit draws the start screen, the pause menu, the health display and the wallet button. A game builds none of them. Hiding, removing or covering the kit's elements, or pressing its buttons from game code, is refused and undone (§7).

| | The kit guarantees |
|---|---|
| M1 | **Every game opens on the home menu** (`kit/ui/menu.js`): the title and tagline over the game's own world, the camera circling the player's character, and Play (`#gf-play`, alone with bots), Play with friends (`#gf-friends`), How to play (`#gf-how`: the goal, every control from `config/game.json` → `controls`, the rules' summary), Settings (`#gf-settings`: volume and mute through gf-audio, mouse sensitivity and invert look on `ctx.input.lookScale` / `invertY`, graphics low/high/auto, saved per game in the browser) and the wallet (`#gf-wallet`). Enter or Space on the home menu starts the round, as Play does. In a live round the party page is the lobby, so the game opens on its waiting card and the menu is the pause menu. |
| M2 | **Esc pauses** (or the HUD's ☰ button, `#gf-menu-button`): Resume (`#gf-resume`), How to play, Settings, the wallet and, alone, Quit to menu (`#gf-leave`, `session.toLobby()`). Alone the game stands still under it (no physics, bots, mechanics or rules; the clock stops); with friends it keeps going. The results card has Menu (`#gf-to-menu`) beside Play again (`#gf-again`) alone. Losing the mouse never opens it. |
| H1 | **The HUD shows the local player's own state** (`kit/ui/hud.js`), read each frame from the mechanics, never from `rules.js`: the player card (`#gf-hud`, bottom left: name in the seat colour; health as pips up to 10 hit points, else a bar and the number, whenever `health` has `hp` > 0; knocked down, out with the seconds to respawn, protected; a stream's tank; paint share; team; tag; lap and place; what you hold; the wave and enemies left; a station quota; the level, coins and weapon with the action mechanics), the goal line under the clock (`#gf-goal`), the menu button, and a boss's bar across the top while a boss fights. A red edge flash when hurt and a slow pulse at a third of health or less. |
| W1 | **The wallet is in the menu, and the game never touches it** (`kit/net/host.js`). The page that hosts the game (the games.fun `/play` page, `creator-studio/components/play/play-room.tsx`) connects the wallet, reads its items from this game and builds the loadout (§6e). The game shows the page's state and asks it for things. Without such a page (the game opened on its own, a Studio preview) the wallet view says where wallets connect. |
| W2 | **The economy's buttons are the page's, and the game only draws them** (`kit/net/host.js`, `kit/ui/menu.js`, `kit/ui/hud.js`). The page offers its economy's actions in `gf:host` → `economy` and says its state in `gf:economy`; the kit draws each action where its `where` says, and a click only tells the page (`gf:econ-action`). The page signs (or not) and answers with a new `gf:economy`. Game code never signs, never calls gf-web3, never prices; rules never see any of it (no `ctx.economy`). **Where:** `menu`: buttons in the wallet view (`#gf-items-panel`'s view, from the home menu or the pause menu), under the wallet; `pause`: buttons in the pause menu, under the wallet button; `results`: buttons on the kit's results card, between the scores and Play again (alone: with friends the party page's card is the result and has none); `hud`: lines in the HUD's player card, each its label and the `gf:economy` entry whose `id` is the action's (balances, then tickets, stakes, claimable), shown once the page's state has one. A paid button shows its price in its label, always on screen ("Coin flip · 0.1 SOL"; a short window hides the small line, and a player never pays without seeing the price), and under it `says`; while its id is in `pending` it waits (disabled, "…"), and the state's `error` shows under the buttons. **No offer, nothing:** with no `economy` (or no actions) nothing of it is drawn anywhere. Ids are `[A-Za-z0-9_.:-]{1,64}`; malformed actions and entries are dropped, never drawn. DOM: `.gf-econ[data-where]` holds `[data-econ="<id>"]` buttons or lines. |

**What a game sets.**
- **The goal line:** one short sentence in `config/game.json` → `text.goal` (the `ui.goal` slot), at least 6 characters. Without it the HUD uses `round.winBy`, then `rules.summary`, then the hook. Mid-round, `ctx.ui.goal(text)` changes it; `ctx.ui.goal(null)` gives back the game's own line. A goal under 6 characters is refused and the previous line stays (`goal-too-short`, §7).
- **Meters:** `ctx.ui.meter(id, {label, value, max, color})` → `{set, remove}` adds a meter to the player card.
- **Words:** the menu's and the cards' words come from `config/game.json` → `text` (`ui.*` slots, `kit/ui/slots.js`): `title`, `hook`, `goal`, `play`, `friends`, `how`, `settings`, `wallet`, `resume`, `leave`, `toMenu`, `again`, `go`, `wins` (`"{name} wins!"`), `lost`, `draw`, `waiting`, `you`, `welcome`. Colours: `--gf-accent`, `--gf-panel`, `--gf-text`.
- Rules read `ctx.menu` and `ctx.hud` (§3.2) and never drive them. The round starts from the kit's Play.

**Messages** (any ancestor window; only the one that said `gf:host` is listened to and answered):

| Direction | Message |
|---|---|
| game → page | `{type: 'gf:host-ready', v: 1}` at boot (beside §6e's `gf:loadout-ready`) |
| page → game | `{type: 'gf:host', v: 1, wallet, friends, shop, economy?}`: what the page offers. `economy`: `{actions: [{id, kind, label, price?: {amount, currency}, says?, where}]}` (W2); `kind` one of `buy`, `openBox`, `craft`, `buyTickets`, `stake`, `unstake`, `hold`, `enter`, `claim`; `where` one of `menu`, `pause`, `results`, `hud`; `amount` a number or a decimal string. A later `gf:host` replaces the offer (without `economy`: none) |
| page → game | `{type: 'gf:economy', v: 1, balances: [entry], tickets: [entry], stakes: [entry], claimable: [entry], pending: [actionId], error}`, on every change (only after `gf:host`, from the same window); `entry` = `{id, label?, amount?, symbol?, text?}` (an amount, or the page's own `text`, which wins) |
| page → game | `{type: 'gf:wallet', status: 'none'\|'connecting'\|'connected'\|'error', wallets: [{name, icon}], address, short, name, icon, error, items: [{itemId, name, rarity, rarityName, image, wearable, worn, count, what}] \| null, boxes: [{name, price, symbol, url}]}`, on every change |
| game → page | `{type: 'gf:wallet-connect', wallet: <name>}`, `{type: 'gf:wallet-disconnect'}`, `{type: 'gf:wear', item, on}`, `{type: 'gf:friends'}`, `{type: 'gf:open', url}` (a loot box link the page itself listed), `{type: 'gf:econ-action', id}` (a click on an offered economy button; never for a `hud` line) |

The page answers `gf:wear` with a new `gf:loadout` (§6e) and `gf:wallet`; `gf:friends` opens its friends lobby (without a page that offers friends, the game goes to `gf/mp/index.html` itself).

**Observation.** `window.__game.menu()` → `{view: 'home'|'how'|'settings'|'items'|'pause'|null, pause, live, buttons: [{id, label, rect, shown, disabled}], how: {goal, keys}, settings: {sensitivity, invertY, quality, volume, muted, lookScale}, items: {state, picks, list}, wallet: {present, offers, status, short, wallets, items, sent}, economy: {offers, state, sent}}` (`economy.sent`: the ids of the last `gf:econ-action`s); `window.__game.hud()` → `{phase, covered, card, goal, menuButton, widgets: [{id, kind, from, need, label, shown, rect, shows, truth}], meters, economy: [{id, label, text, shown, rect}]}`. The snapshot's `view` is the menu's view, else the card's; `paused` is true while the pause menu holds a game alone.

## 6h. Playing with friends (kit-owned)

The friends page is the multiplayer kit's (`gf/mp/`, `multiplayer/party/kit/`); the game's side is `kit/net/session.js`, `kit/core/boot.js` and the pause menu.

| | The kit guarantees |
|---|---|
| F1 | **A name before you play, changeable until the round starts.** The Host / Join screen's name field is never blank: the name you used last, else a rolled "<adjective> <noun>" with a dice button. In the waiting room your own row is an editable name (`#mp-name`; Enter or leaving the field saves it); the room keeps names clean and unique (`gf.room.rename`, the host engine's `name` frame) and everyone's waiting room and game follow (the scoreboard and nameplates read `p.name`). |
| F2 | **One waiting room.** The party page draws it (`card === 'lobby'`): the room code and invite link once (the host-join kit's corner pill is off, `bar: 'none'`), every player in the colour their character wears (the game's `net.describe({colors})`), Start for the host, "Waiting for <host> to start" for the others, Leave or Close room. With `live.backdrop` (`create` writes `gf-backdrop=1`) the game's own world stands behind it (§1.2 `?gf-backdrop=1`). On a machine with no graphics card the backdrop is left out and the waiting room stands on the page's own background. Between rounds the results card leads back to it. |
| F3 | **Friends play friends.** A live round has no bots: `session.js` adds none whatever `players.bots` or `?bots` say (bots are for playing alone, so keep `rules.bot` for that). `ctx.players.add`, `remove` and `place` in a friends round are refused (`players-add-with-friends`, §7). A round needs two players in the room (`players.min` when higher); the host's Start waits ("Waiting for a friend…"), the room refuses less, and "Play alone instead" opens the game on its own. |
| F4 | **The game's HUD is the round's.** With `live.hud: "game"` (`create` writes it) the party page shows no standings rail: the game's scoreboard has everyone, and the pause menu holds the room (`#gf-room`: the code and players; `#gf-invite`; the host's `#gf-end-round`, which ends the game's own round so every copy reports its real score; `#gf-leave-room`). |
| F6 | **A friend is seen even when nobody is a character** (`gf/mp/presence.js`, `ui/presence.js`; STANDARD.md "Seeing a friend with no character"). `config/game.json` → `players.presence` (`create` writes it from the spec and the parts' `holds`): `seats` gives every player a seat card down the left edge (name, colour, the `ui.avatar` picture on a disc of their colour that reacts: thinking on their turn, placed just after a move, won, lost, away; words `ui.mood-*`), their pointer (the part's own mark, or a name tag the part places) and a ring in their colour where each of their moves lands; `boards` draws each friend's own board live down the right edge, framed in their colour, with their name, score, pointer and last move. A part feeds it (`presenceFeed(p)`, `presenceScreen(cell)`, `presenceMarks`); a game's own code calls `ctx.presence.set({pointer, mood, moves, last, board: {cols, rows, g}, score})` for its player, sent to every friend at most 10 a second. Observation: `snapshot().presence` and `snapshot().net.presence` (`{shape, seats: [{id, name, color, mood, moves, card, pointer, lastMove, board}], me}`). Gate E holds it (measure 5's presence leg). |
| F5 | **Each player's own score, one result screen.** With friends the game draws no results card of its own; the party's results card is the result: every player in their colour with the score the game counted (the host's copy sends every player's own `p.score` in `net.finish({values})`), the winner (or, in a team round, won or lost together with a star for the most points), Play again for the host, the waiting room for everyone. Each copy reports its player's live score (`net.progress`), so a round the host or the time cap ends still shows everyone's number. Keep each player's own score in `p.score`, even in a co-op game: a game where every score is always the same reads as broken. |

## 6i. Sharp on every screen (kit-owned, on by default)

- **The pixels drawn** (`kit/core/resolution.js`, boot): the screen's real pixels. `pixelRatioFor({dpr, width, height, budget})` is devicePixelRatio, lowered only to keep the drawing buffer within the quality tier's pixel budget (`PIXEL_BUDGET`: high 3840×2160 = 8.3 MP, a 4K screen at 1×; low 3.2 MP, a phone at its full 3×, a tablet at about 90%), never under one CSS pixel. A look's `quality.<tier>.pixelRatio` is not read.
- **Following the screen:** again on every window resize and every devicePixelRatio change (`watchPixelRatio`: a browser zoom, a move to another monitor, the browser's device mode), with the post stack resized with it. Every engine.
- **The frame-rate guard** (`createGovernor`): while playing in view, after 5 s, a 3 s window under 40 fps lowers the ratio by 15% (never under one CSS pixel); a resize or zoom starts again from the full ratio. `?gf-res=fixed` (QA) turns it off.
- **Observation:** `window.__game.screen()` → `{dpr, css, buffer, ratio, target, budget, quality, slow, guard}` (`slow`: the window that lowered the ratio, else null).

## 6j. Panels (kit-owned, on request)

A shop, an inventory, choice cards, a dialogue and a text field, as one module (`kit/ui/panels/`). Loot's upgrade cards and build's hotbar and sign editor use it. A panel **shows and returns a choice**. It holds no game logic: prices, money, stock and what a purchase does are `rules.js`'s or a mechanic's. A game reaches it through the **`panels` part** (`kit/mechanics/panels`: `{"id": "panels", "params": {"kinds": ["shop", "inventory"]}}`), which brings the words and pictures as slots and hands the panels to `rules.js`; a mechanic calls `ctx.ui.panels` directly.

| | |
|---|---|
| `choice` | `{title, cards: [{id, name, text, image?, tag?, attrs?}], placement: 'center' or 'bottom', modal, keys, dismissable, settle}` → `done`: `{id, index}` (null when dismissed). The keys 1 to 9 pick; a picked card shows for `settle` ms (250). Centre is modal; `bottom` is loot's: the cards sit over the HUD and the player keeps moving |
| `shop` | `{items: [{id, name, text, price, image?, disabled?, reason?, stock?}], currency: {label, amount}, onChoose({id, index})}`. Stays open through any number of buys; `update({items, currency})` redraws in place. A disabled item cannot be chosen; `reason` is the game's own words ("Need 4 more") |
| `inventory` | `{mode: 'bar' or 'grid', items: [{id, name, text, count, image?, node?}], selected, onSelect, actions: [{id, label}], onAction({action, id, index})}`. The **bar** is non-modal; it scrolls sideways with an arrow where there is more; the keys 1 to 9 and 0 select, or `keys: 'labels'` shows the labels and leaves the keys to the mechanic; `into` mounts it in a container, `barId` and `slotClass` name its DOM. The **grid** is modal with a detail line and the actions. `node` is a drawn icon a mechanic made from its own slots. `select(i)`, `update({items, selected, scroll})` |
| `dialogue` | `{speaker, portrait?, lines, choices?: [{id, text}], cps, instant, onLine}` → `done`: `{choice, index, lines, skipped}`. Types out; a tap, Space, Enter or E finishes the line and then goes on; the choices (and their keys) come with the last line; Esc skips to them |
| `input` | `{title, value, lines (1 to 6), maxLength, required, ids?}` → `done`: the text, or null. Enter adds a row while there is one and does nothing on the last (it never closes under someone typing), Ctrl+Enter or the button confirms, Esc cancels; a one-line field confirms on Enter |

Every call returns a handle `{id, kind, open, remote, refused, done, close(result?), update(patch), select(i), el}`. Common options: `id` (one panel per id: opening it again replaces the first, which settles with null), `for` (a player id), `modal`, `dismissable`, `words` (the strings it says: `title`, `buy`, `close`, `ok` ...), `domId`, `onClose`.

- **Pause.** A panel never pauses the round. A modal panel only takes the local player's input (`ui.cover('panel:<id>')`, so `ui.covered` is true and the controller reads idle) and the mouse (an open pointer lock is let go and taken again on close). Esc closes a dismissable panel and, under a modal one, never opens the pause menu behind it. A game that wants the world to hold still alone pauses itself.
- **Multiplayer.** A panel is local to the copy that opens it. `for: playerId` makes it open only on that player's copy (any other copy gets a handle with `remote: true`, nothing drawn), so code that runs on every copy, or on the host, can name whose panel it is. Its answer comes back on that copy only; telling the host or the others is the caller's message (`ctx.net.send`), as loot's `loot:pick` is. A panel keeps no state a friend could see and sends nothing.
- **Slots.** Words: the part brings one text slot per word of each kind the game uses (`mechanic.panels.<kind>-<word>`, e.g. `shop-buy`, `input-ok`; params `shopTitle`, `shopBuy` ... in `config/game.json`), and a mechanic passes its own (`mechanic.loot.upgrade-title`). Pictures: every file `assets/panels/<name>.png|jpg|webp|svg` is an image slot `panel.image.<name>` (lowercase), and a panel names a picture by that id; a path or a URL is refused. Colours are the game's `--gf-panel`, `--gf-accent`, `--gf-text` (the `ui.*` slots). A drawn icon (`node`) is UI built from a mechanic's own texture slots, never new art.
- **Refusals.** A call the kit can see is wrong (an empty list, a repeated id, a picture that is not a slot, a mode that is not one) logs `gf-three panel refused [<kind>]: <what and the fix>` to the console, draws nothing and returns a handle with `refused: true`; nothing throws. The part's sign of life is dead when any call was refused.
- **Phone.** Buttons, rows and cards are 44 px or more (the inventory bar's slots are 46 px, 38 px on a phone), a card scrolls inside the screen, the safe-area insets are kept clear, and the choice cards stack at 640 px and under.
- **Observation.** `window.__game.panels()` → `{open: [{id, kind, modal, rect, count, title, words}], covered, opened, closed, refused, last}`.
- Tests: `tests/m4d-panels.test.mjs`. Regression `panels-refused`. Eval case `spec/evals/gauntlet/cases/S1.json`.

## 7. Refusals

What the kit will not do for a game's code is refused at the call, with a stable code and the fix in the message. Nothing throws (but a failed `rules.setup`), and the kit carries on as if the call had not been made.

- **Said:** `console.error("gf-three refused [<code>]: <message with the fix>")`.
- **Listed:** `window.__game.snapshot().refusals` → `[{code, message, count, first, last}]` (`first`, `last`: seconds since the page loaded). The same code and key logs once and counts up; at most 50 entries are kept (the oldest goes).
- **Whose code:** for the guard's codes (`kit-ui-*`, `pointer-lock`, `input-swallowed`, `camera-swap`) the guard reads the caller from the call's stack: a frame in one of the game's own files (beside `main.js`, outside `gf/`, `audio/` and `vendor/`). A caller it can't place (a packed single-file game, a test's own script) is never refused, so the kit, its vendored libraries and verify's own scripts are never refused.
- **Where:** `kit/core/refusals.js` keeps the list (`refuse(code, message, key)`, `list()`, `CODES`, `MAX`). `kit/core/guard.js` installs the browser wrappers when it is first imported (every boot imports it before `rules.js` runs).
- A panel call has its own refusals, said the same way with `panel refused` (§6j).

| Code | Refused when | What the kit does | Where |
|---|---|---|---|
| `players-add-with-friends` | `ctx.players.add`, `remove` or `place` in a friends round | Nothing (the room decides who plays); alone the call passes through | `kit/net/session.js` |
| `sound-unlisted` | `ctx.audio.play(id)` of an id `assets.json` → `sounds` → `sounds` lacks, without `{optional: true}` | Plays nothing, returns null | the boot's `ctx.audio` |
| `slot-unknown` | `ctx.assets.tag(obj, id)` of an id `assets.json` does not declare | Tags it anyway | `kit/assets/assets.js` |
| `shared-write-not-host` | A write to `ctx.shared`, top level or nested, from a copy that is not the host | Nothing changes; reads still work | `kit/net/shared.js` |
| `goal-too-short` | `ctx.ui.goal(text)` or `config/game.json` → `text.goal` under 6 characters | The previous line stays (at boot: the next candidate, §6g) | `kit/core/refusals.js` |
| `kit-ui-hidden` | Game code hides or removes one of the kit's elements: the kit's layer (`#gf-ui`), the home and pause menu and their buttons, the HUD's player card (`#gf-hud`), the goal line, the menu button, the full-screen button (`#gf-fullscreen`), the wallet (`#gf-wallet`). By a style rule, an inline style, the `hidden` attribute or removal (hiding: `display: none`, `visibility: hidden`, opacity under 0.1, `content-visibility: hidden`, a zero scale) | Deletes the rule, takes the style off, clears `hidden`, or puts the element back | `kit/core/guard.js` |
| `kit-ui-covered` | An element game code put on the page is drawn over one of them (over half of it, the element covering much of the screen, painting or taking clicks) | Puts that element under the kit's layer | `kit/core/guard.js` |
| `kit-ui-pressed` | Game code clicks a kit menu button or dispatches Enter to start a round (skipping the home menu); or calls a method of `ctx.menu` or `ctx.hud` other than the read names, or writes a property on them | Ignored. Only the player starts the round | `kit/core/guard.js`, `kit/ui/menu.js` |
| `pointer-lock` | Game code calls `requestPointerLock` | Ignored (a resolved promise); the kit's input takes the lock on the player's click. Read `ctx.input.locked` | `kit/core/guard.js` |
| `input-swallowed` | Game code calls `stopPropagation` or `stopImmediatePropagation` on a key, mouse, touch or wheel event aimed at the game's canvas or page before the kit's input saw it | The stop is ignored; the event goes on | `kit/core/guard.js` |
| `camera-swap` | An assignment to `ctx.camera` | Ignored; pick the camera in `config/game.json` → `camera` | `kit/core/guard.js` |
| `setup-failed` | A mechanic's or the rules' `setup` threw | Logged as a refusal. A mechanic's part does not work this round; the rules' error still stops the boot | `kit/core/guard.js`, the boots |
| `update-failed` | An every-frame hook threw: `rules.update`, `rules.bot` (or the kit's own bot), a mechanic's `update`, fair play's update, a `ctx.onFrame` function | Logged once per hook and message with a running count (said again at 10, 100, 1000 and 10000), never every frame; the frame goes on | `kit/core/guard.js`, the boots |

**Not a refusal:** `Math.random` inside a rules hook draws from the game's seeded stream (§3.7).

## 8. Runtimes and profiles

A spec v2 places a game by `"runtime"` (and, for a runtime with profiles, `"profile"`), `"loop"` and `"kind"` (builder/spec/game-spec.v2.schema.json); there is no `engine`. Which runtimes and profiles exist, are tested and are open to pitches is the registry's (`runtimes/<id>/runtime.json`, `registry/catalog.json`; `npx gamesfun catalog runtimes`); forge and vista are open (the creator, 2026-10-13), each with its device limits said plainly. Every runtime shares the loop, assets and slots, loadouts, live multiplayer, the home menu, the HUD and the wallet, `create`, `verify` and the regressions; the three runtime's profiles also share the boot, input, characters on `gf-humanoid-1`, fair play and bots.

| | three, `standard-3d` (this kit's own look and world) | three, `scenic-3d` |
|---|---|---|
| Spec | `"runtime": "three", "profile": "standard-3d"` | `"runtime": "three", "profile": "scenic-3d"` |
| Look and world | `gf/three/look/`, `gf/three/world/` | `gf/scenic/look/`, `gf/scenic/world/` (gf/three leaves its own out) |
| three.js 0.186.0 | `three.module.js` (WebGLRenderer), postprocessing, N8AO | `three.webgpu.js` + `three.tsl.js` (WebGPURenderer, WebGL2 inside it), TSL post |
| Worlds (`world.template`) | backyard, office, plaza, arena, store, voxel | island, isles, ruins, dungeon |
| Looks (`look.preset`; left out, the kind's) | jelly-pastel, toon-lowpoly, soft-stylised | dusk-isle, night-ruins, golden-meadow, storm-coast, clear-day |
| Usual camera | third | follow |
| Mechanics | the library (§4.1), where `mechanic.json` lists the profile | the library (§4.1), where `mechanic.json` lists the profile |

`forge` (§8 forge), `vista` (§8 vista) and the `flat-2d` profile (§10) are the others.

1. **A spec's runtime and profile** pick what runs it. `create` refuses a spec whose `world.template` or `look.preset` is not its runtime's (`... is not a three/scenic-3d world (...)`), unless a build item builds that world on its closest (`build[].closest`). A look the spec leaves out is its kind's on that runtime (`tools/lib/spec.mjs` `lookOf`), recorded in `gf-three.json` → `look`.
2. **`gf/three/kit.js`** records `runtime` and `profile` and, for scenic-3d, `scenic: {name: 'gf-scenic', version, files}`. `modules.runtime` and `modules.profile` travel in `gf-three.json` too. `boot` imports the look and world from `../../scenic/` when the profile is scenic-3d (`ctx.kit.runtime`, `ctx.kit.profile`, `window.__game.runtime`, `.profile`).
3. **A look may be asynchronous:** `boot` awaits `look.ready?.(renderer)` right after `createRenderer` (WebGPURenderer's `init()`), before `assets.setRenderer`.
4. **The scenic import map:** `three` and `three/webgpu` → `./vendor/three/build/three.webgpu.js` (one shared three for every module), `three/tsl` → `./vendor/three/build/three.tsl.js`, `three/addons/` and `three/examples/jsm/` → `./vendor/three/examples/jsm/` (the TSL addons from `runtimes/three/vendor/three@0.186.0`), Rapier as before.
5. **A scenic module sees the shared kit as a game does:** `gf/scenic/x/y.js` imports `../../three/core/util.js`. In Node, `tools/lib/kit-import.mjs` maps `gf-scenic/three/<rel>` to `runtimes/three/kit/<rel>`.
6. **The scenic world module** exports `templates`, `worldConfig(spec, opts)` (`create` calls it in Node to write `config/world.json`, a `__catalog` becoming `config/props.json`), `loadWorld(ctx, cfg)` and `slotsFor(cfg)`. **The scenic look module** exports `presets`, `presetValues(id)`, `lookConfig(id, {time})`, `slotsFor(cfg)`, `createRenderer`, `ready`, `applyLook`. Both keep §4.2 and §4.3's runtime shapes.
7. **Kit copies:** `gf/scenic/` is hashed in `kit.js` like `gf/three/`, and `vendor/three/build/three.webgpu.js` and `three.tsl.js` are held to `trials/third-person-adventure/source/vendor/three` (byte-identical to the npm tarball, the same `three.core.js`).

**Levels (scenic worlds).** A scenic world may hold several levels: `config/world.json` → `levels: [{id, at: [x, y, z], radius, last, spawns: [[x, y, z]…], zones: {arena, portal, …}}]` (`worldConfig` makes one per level: the `levels` mechanic's `count`, else `rules.params.levels`, else 1; `isles` defaults to 3). At run time `ctx.world.levels` (zones as objects, spawns with a yaw facing the level's middle), `ctx.world.level` and `ctx.world.setLevel(i)` (then `spawn(i)`, `zone(name)` and `bounds` answer for that level first). The world only says where things are; the `levels` mechanic (host) decides which level is played, opens the portal and moves everyone (`p.teleport`).

**The `follow` camera** (either 3D profile; `spec.camera: "follow"`; the scenic-3d profile's usual camera), after folio-2025's `View.js`:
- A long lens (fov 25) at a fixed three-quarter angle (48° above the ground, turned 45°), 34 m away; the wheel zooms between 20 and 46 m (`config/game.json` → `controller.camera.follow`: `distance`, `minDistance`, `maxDistance`, `pitchDeg`, `yawDeg`, `fov`, `smooth`, `zoomStep`).
- **The mouse stays free and aims** (`ctx.input.cursorMode`: a click is the action at once and never takes the pointer lock; `ctx.input.pointer` is the cursor in normalised device coordinates; `ctx.input.wheel` the wheel steps this frame). The aim point is under the cursor: the rig's `ray()` goes from the camera through the cursor with `fromCamera: true`, so `crosshairPoint` counts the whole ray (a point on the ground between the camera and the player can be aimed at; the player's own body is never a target). `p.aim` and `p.aimDist` mean what §6d says. With the cursor off the canvas, the aim is the heading.
- No reticle in the middle (§6d C2 is for the third and first cameras); the canvas shows a crosshair cursor. Movement is relative to the camera's fixed heading. The character's upper body does not pitch to the aim. How to play lists "Mouse: Aim" and "Wheel: Zoom"; Settings leaves out mouse sensitivity and invert look, as for `top`.

### §8 forge: the forge runtime

The plan is [research/rust-engine/PLAN.md](../rust-engine/PLAN.md) (§2 architecture, §3 these additions). The engine is `gf-forge`: its README says what exists, and `core/ARCHITECTURE.md` how the Rust core is built and extended (the step, the schedule, events, views, snapshots, live co-op, the run, builds, the purse, elites). A Rust core on wgpu draws and simulates; everything above it is this system's, unchanged where it can be. It is for first-person and close-camera action with weight, mobile web, co-op for 2–4. The game that proves it is a co-op zombie night built in games.fun (not shipped with this kit).

| | forge (`gf-forge`) |
|---|---|
| Spec | `"runtime": "forge"` (no profile). `create` refuses another runtime's `world.template` or `look.preset` (`... is not a forge world (...)`), and the registry a camera forge has no rig for and the world loop (both hard limits). A forge spec lists no mechanic (none runs on forge: what its play needs beyond the tables is a build item) |
| Worlds | `crypt-room` (a square room of curated KayKit Dungeon Remastered pieces, CC0, 3–5 tiles of 3 m by size class), `ruins-arena` (a moonlit ruined courtyard generated from `world.seed`, 8–12 tiles a side), `town-street` (item 18) |
| Looks | `moonlit-ruins`, `ember-crypt`, `ash-storm`, `gaslit-street` |
| Camera | `first` (`close-third` is not offered) |
| In the game | `gf/forge/` (`runtimes/forge/kit`: the host, look, renderer, world and arena, town, players, wear, fight, feel, AI, cards, down, HUD, sound, governor, art, `tables/`, `vendor/meshopt_decoder.module.js` (MIT), `wasm/` and `wasm-webgl2/` (the two builds and their glue), `wasm/LICENSES.md`, `BUILD.json`; the README's "Layout" lists each file); of `gf/three/` only what `core/boot-forge.js` imports (no three.js anywhere); no `vendor/`; no import map. `assets.json` → `runtime.gpu: "webgpu"` |
| `spec.tables` | The data tables (item 11): `config/game.json → forge`, every value a slot |
| `main.js` | `import { boot } from './gf/three/core/boot-forge.js'` (boot.js links three.js and Rapier statically, so a forge game starts at its sibling) |

1. **`gf/three/kit.js`** records `runtime: "forge"` and `forge: {name: 'gf-forge', version, wasm (the BUILD.json sha256), main: 'core/boot-forge.js', files}`. The version is `FORGE_VERSION` in `tools/lib/paths.mjs` (`0.9.0-wave7` today); `gf-three.json` → `kit.forge` repeats it. `files` hashes every gf/forge file, and the wasm must be the build `kit.js` names. A game may override forge's JS layer only (§1.7): the wasm, its glue and `BUILD.json` are never overridable, because no agent can rebuild the core. `--world` is not for forge.
2. **The boot** (`kit/core/boot-forge.js`): configs and `assets.json` through `kit/assets/core.js` (the three.js-free half of the slot runtime); the quality tier and the screen's pixels (§6i: the canvas is sized before the engine starts); `createHost(canvas)` (the wasm compiled while it downloads, the adapter and device); the data tables loaded into the core (`ctx.tables`); the forge look and world; gf-audio, the input, the UI, the HUD, the home menu; the round and the net (`kit/net/session.js` with `gf/forge/players.js` as `createPlayers`); fair play's state; the round flow `round.flow` names (item 19); `rules.setup(ctx)`; the frame loop through `net.loop`. The lobby's backdrop is left out on a machine that draws on its processor, as in `boot.js`.
   - `ctx.forge` is the host; `ctx.slotIndex(id)` the index the core draws a slot with; `ctx.world` the forge world (`spawn(i)`, `zone(name)`, `bounds`, `props` (name → `[{at, i}]`), `lights`, `texture`); `ctx.render`, `ctx.fight`, `ctx.feel` (item 14); `ctx.ai` (forge-ai, when the game has enemies; it also runs the bots).
   - No gf-three mechanic module runs on forge: `ctx.mechanics` holds the spec's params as stand-ins.
3. **The boundary** (`gf/forge/host.js` ↔ the core; ARCHITECTURE "The step", "Events v1", "Views", "Snapshot v2").
   - One `tick(dt)` a frame after one packed command buffer (`[op, n, words…]`). Ops 1–63 are the core's (INPUT, TELEPORT, SPAWN, DESPAWN, TUNING, ADD_BOX, CLEAR_BOXES, POSE, FLOOR_LIMIT, SEED, DAMAGE, SET_HEALTH, LOOK), 64–95 forge-feel's (`FEEL_OP`), 96–127 forge-ai's, 128–159 the system's. An unknown op is skipped by its length.
   - The core runs **fixed 120 Hz steps**, at most 100 ms of them a frame, through six stages (input → feel → ai → physics → post → events). Then the host re-reads the **views** (players, entities, the camera, the bone palette), interpolated between the last two steps. Looking is applied at the frame rate, moving at the fixed step.
   - **Events** are 16 words each (HIT, KILL, SPAWN, DESPAWN, SOUND, LIGHT, PARTICLES, CAMERA, UI, RULE, MOTION; a plugin's own 32–63), names travelling as numbers (`forge.name(i)`). Every frame the host routes them: a SOUND plays its assets.json sound by name (`create` declares every sound the tables name), a RULE calls `rules.event(ctx, name, {entity, a, b, c, d, remote}, 'forge')`, and every event reaches `ctx.forge.on(kind, fn)` listeners.
   - **The snapshot** (`host.snapshotB64()` / `applyB64`) is at most 2600 bytes, so its base64 fits `net.world`'s 3.5 KB. A snapshot at or before one applied is ignored.
   - Yaws at the JS boundary are the kit's (a character's, 0 faces +Z); the core's are a camera's (0 looks down −Z): `toCoreYaw`, `toKitYaw`.
   - The input: primary fires, secondary is the alternate fire, interact, jump; Shift evades, R reloads, V is a quick melee, 1–4 and the wheel pick a weapon.
4. **Content is never compiled in** (PLAN §2): every model is a model slot's GLB, read as bytes through gf-assets (Studio's overrides apply), meshopt decoded by the host, parsed by the core (`forge-render/src/glb.rs`: any accessor type, KHR_mesh_quantization, node transforms; images decoded by the browser, at most 2048 px, one copy per picture). A texture slot is drawn over the models it paints (`config/world.json` → `texture: {slot, file, on}`). Every instance is placed with its slot's index, so coverage reads it back.
5. **The observation interface** (`window.__game`, §11's names): `snapshot()` (with `runtime: 'forge'` and `forge: {version, wasm, frames, draws, ticks, recoveries, lost, timing, info, render, fight}`), `coverage()` (every instance the core draws: its slot and screen area; untagged when it has none, `unknownSlots` when assets.json lacks it), `slots()` (per slot: drawables, triangles, on screen, area; a texture slot where the models it paints are), `sight(ids)` (a Promise: the core's slot-ID pass, depth-tested from the player's eyes into 192×108), `controls()`, `menu()`, `hud()`, `looks()` (`drawn: {body, tint, bodyTint, material, mix, visible, held, renderer}`: what the core holds for each player's body), `camera()` (`mode: 'first'`, the kit's yaw), `screen()`, `snapshot().net` (the live gate's block: each friend where this copy draws them, `onScreen` meaning in view with no wall between), and item 13's additions. QA: `forge.state()`, `forge.loseDevice()`.
6. **No WebGPU:** a browser with a WebGPU adapter draws with the WebGPU build; one without, on WebGL2 with a graphics chip behind it, draws with the WebGL2 build (item 16). With neither (or WebGL2 only in software: SwiftShader, llvmpipe) `createHost` throws `NoWebGPU`, and the boot shows the kit's own screen (`#gf-forge-unsupported`: the title, where the game plays, the link, Copy the link), with `window.__game.phase === 'unsupported'`. Never a blank canvas.
7. **Device loss:** the core keeps every mesh and texture on the CPU. When the device (or a WebGL2 context) is lost the frame loop draws nothing, `recover()` asks for a new adapter and device, configures the canvas again and uploads everything, and the round goes on.
8. **WebGL2's limits** (PLAN §9.3): no compute, uniform bindings ≤ 16 KiB (432 bytes of globals, 160 bytes a draw at 256-byte dynamic offsets), textures ≤ 2048 px, Depth24Plus, sRGB and R32Uint targets; the device is asked for `downlevel_webgl2_defaults()` with the screen's own size allowed.
9. **verify** (`tools/verify-forge.mjs`, which `verify.mjs` hands a forge game; one function per check, each listed once in its stage). Every check runs through the observation interface, on WebGPU Chrome; `GF_FORGE_BACKEND=webgl2` (with this machine's WebGL flags) runs the whole verify, and every forge tool, on the WebGL2 build. The required list is `REQUIRED_FORGE` in `tools/lib/verdict.mjs` (pass rule `passesForge`; mechanic modules are `NOT_YET_FORGE`: `ok: null`, never counted as passed). Verify is being regrouped into the gates of [GATES.md](GATES.md); each forge check's tool file says what it measures. Where forge's checks differ from §5:
   - **5**: the live gate + the loadout leg (the colour read back from the core's `Wear`) + forge's sight leg (`tools/lib/forge-sight-check.mjs`: each player sees the other's body in the core's slot-ID pass, a joiner's own player moves within 120 ms of W, the host's snapshot within 2600 bytes). The sight leg stands in for the gate's two random-look samples (`replacedBySight`): in the friends page's frame chrome-headless-shell reports a pointer-locked mouse's moves as 0.
   - **6** also takes the gate's two-player half, and a player felled alone must reach the results (`forge-round-check.mjs`). **8** swaps the game's own prop model slot and the `look` preview's texture slot.
   - **10** (`forge-feel-check.mjs`): in control while evading, jumping and firing; a held strafe key walks the player.
   - **11** and **17**: the forge world lint (`gf/forge/arena.js` `lintWorld`; `forge-world-check.mjs`): overlaps, spawns, open floor, a closed and visible edge (never an invisible boundary alone on a street), emerge points in the spawns' sight, reachability, cover where a collider stands, lanes, fire lights.
   - **12**: three forge-ai bots walk and one scores. **13** (`forge-controls-check.mjs`, `forge-touch-check.mjs`): each listed control answers on a quiet staged page (`?gf-demo=controls`; E beside a fallen friend with `?gf-demo=controls.revive&bots=1`), and on three phone screens the touch buttons at rest cover at most 5%, keep off the aim and readouts, and are at least 44 px.
   - **15** plays the first wave with a new player's hand (`forge-first-wave-check.mjs`, `forge-fight.mjs`; up to three tries). The play tool has the same hand as a step, `{"do":"fight","seconds":8}` (`tools/play.mjs`).
   - **16**: every weapon a player can hold; one that kills the first enemy with every hit fails (a held blade's damage is under half the enemy's health: a swing takes the head and doubles). A multi-pellet weapon is judged by one pellet; the quick melee is not held to two hits.
   - **19** (`runtimes/forge/lookdev/forge-checks.mjs`): the model judge on every skinned body, then forge's own poses and GPU skinning held to rig.js and three.js. **20** presses How to play's key rows (`forge-keys-check.mjs`). **21** (`forge-hud-check.mjs`): readable health within 0.1 of the core's share. **22**: the economy page in real time on a round cut to 20 s.
   - **32** (`forge-webgl-check.mjs`): the WebGL2 build plays with WebGPU hidden; neither shows the kit's screen; a forced build is never swapped. **33**: `forge.loseDevice()` mid-round is recovered. **34**: the viewer looks through the streamer's eyes (item 17). **9** (`lookdev/capture.mjs <game>`) counts when run.
   - **The gate's background-host step:** `create` writes `multiplayer.json → check.query: "gf-gate=1"`; under it `ctx.round.end` from the rules does nothing, so the gate's later steps find the round running (the clock and the host's End round still end it). A rule that ends the round must not repeat something every frame until it has ended.
   - Broken examples: `regressions/forge-*`, on frozen bases `regressions/bases/forge-room` and `forge-street`.
10. **Delivery** is a file tree (PLAN §3.5; never packed into one file): the wasm is served as `application/wasm` and compiles while it downloads (`WebAssembly.instantiateStreaming`), with its sha256 as the etag. `gf-forge/tools/delivery-check.mjs` plays a forge game imported into a **local** Studio (`creator-studio/scripts/import-game.mjs --publish`): in `/play/<slug>`'s frame and its Full screen, the game URL on its own, streaming compile, a `/p/` reload revalidated (304), a `/v/` reload from the browser's cache (immutable), and the no-WebGPU screen in the frame. **Studio's side:** `catalog.json` → `engines.forge` (world, look, camera, the bodies friends see, each table's `runs`), the pitch (`prompts/pitch.md`; the pitch checker holds a forge card to its tables, to one bean role and to our own words: `check-honesty.mjs`), the build brief (`prompts/build-forge.md`) and the forge look rubric. The worker's GPU setup is in `research/foundations/studio-worker/README.md`.
11. **`spec.tables` (forge), the data tables** (PLAN §3.3; ARCHITECTURE "The data tables"): `{player, physics, deal, weapons[], enemies[], waves[], cards[], families[], shop, elites, endless}`. The schema, defaults, checker, slots and sounds are `gf/forge/tables/` (`runtimes/forge/kit/tables`: one declaration per field, its default, range, unit and label; the owner of each table is named there).
    - `create` refuses a spec whose `forge` holds a value the core can't do (out of range), a field or table that does not exist, a kind not offered, a duplicate id or a wave naming a missing enemy (and a `forge` block in another engine's spec). It notes what no system runs yet (`tables/index.js` `RUNS`).
    - It writes the filled tables to `config/game.json → forge` (a row starts from its weapon kind or preset, enemy archetype or card rarity), each value a slot (`forge.player.walk`, `forge.weapons.<id>.damage`, …; the player's walk, jump and health are main), and lists every sound they name in `assets.json`.
    - On forge the controller keeps only the mouse's sensitivity: the walk, the jump and the field of view are the player table's. Defaults are the measured feel targets (`research/rust-engine/feel-targets.md`).
    - `create` writes working rules for a forge wave game (start over, score, win, lose; a run the clock ends has no winner), so a build that changes nothing still delivers a game.
12. **Live co-op for 2–4** (ARCHITECTURE "Live co-op"; forge-core `net.rs`, `snapshot.rs`; `gf/forge/players.js`). The bar is §6h's: friends in one game, in sync, each seeing the others as a character.
    - **Who simulates whom.** A player's core id is their seat + 1 on every copy. The host's core owns the world and simulates every player: its own, and each joiner's from that joiner's inputs. A joiner simulates only its own player, at once (prediction), and shows everyone else as replicas from the host's snapshots. Nothing on a joiner hurts a replica: the host replays the joiner's shot, and its HIT and KILL come back.
    - **Inputs and reconciliation.** A joiner sends its steps' inputs to the host about 20 times a second (`net.send('fi', base64, 'host')`); the host plays them one per step after a 3-step jitter buffer. A joiner whose prediction differs from the host's state by more than 3 cm is moved by the difference, the camera catching up over about 0.1 s; over 2 m (a teleport, a respawn) it snaps. The joiner's health is the host's.
    - **The joiner's word for its own place.** Every input carries where the joiner's own copy left its player (`StepInput::claim`). The host moves its copy there through the world (a wall still stops it), only within 2 m of its own replay (`ADOPT_MAX`). Friends walk through each other; a knock is played on the joiner's own step.
    - **Snapshots** ride in the round's own `net.world` message (`createSession({coreWorld})`: the host takes one only when the message will go, about 10–12 a second, so none of its events is lost).
    - **Not played twice:** a joiner skips the host's sounds and lights whose source is its own player, and particles of the same name within 1 m of ones it drew in the last 0.6 s. A plugin that makes a player's sound or light gives it that player's id as `source`.
    - **Bodies.** Each copy sets every player's `Wear` (the colour (their seat's, or their loadout's §6e), the body's slot index, `hidden` for its own first-person player; `Wear.held`, the weapon in hand, travels in snapshots). The body is the seat's: `character.body.player` (seat 1), `character.body.player.2`, `.3`, `.4` (the materials a body's `gfTint` names take the player's colour, `gfTintMix` of the way), animated with `character.clips.player`, holding `character.held.<weapon id>` at that body's own fist (`config/characters.json → forge`: `fists` per seat, `weapons.<id>.grip`), with a nameplate above. The Rust renderer draws them skinned (`draws_bodies()`).
    - **Tools:** `gf-forge/tools/coop-check.mjs` (three and four players; `--fight`).
13. **The observation interface, forge's additions** (`boot-forge.js`), filled by whatever the core holds:
    - `bodies()`: every animated entity: `{net, kind ('player' | 'enemy' | …), player, slot (its body's), color, held, hidden, bones, at, onScreen, renderer ('skinned' | 'standin' | 'none')}`.
    - `enemies()`: every enemy entity: `{net, type, typeId, at, hp (share), dead, replica, speed}`.
    - `hits(since)`: the HIT and KILL events since `since` seconds (`{t, kind, attacker, target, part, point, damage, crit, region, remote}`; core ids).
    - `wave()`: forge-ai's director (`ai_wave()`), else the last RULE `wave` event (`a` the number, `b` enemies left, `c` the state).
    - `forge.events(since)`, `forge.entities()`, `forge.players()`, `forge.net()` (role, reconciliations, input queues, snapshots), `forge.project(x, y, z)`, `forge.face(x, y, z)` (QA only: turns this copy's player to look at a point), `forge.feel()` (`{shown, stats, recap}`), `forge.drawn()` (what the last frame drew, `gf/forge/render.js` `STATS`), `forge.actor(net)` (how one body was drawn), `forge.fp()` (the first-person weapon's sockets), `forge.run()`, `.cards()`, `.down()`, `.value(path)`, `.counts()` (item 15). `forge.state()` has `backend`, the loaded build's `wasm` hash and `render.tier`.
14. **The fight** (`gf-forge/INTEGRATION.md`; `gf/forge/{wear,players,fight,ai}.js`, `boot-forge.js`).
    - **The boot** makes `ctx.render` (`gf/forge/render.js` over the core's renderer), loads the world (which attaches `ctx.ai` when the game has enemies), then `ctx.fight = loadFight(ctx)` when it has weapons, and `ctx.feel` (the DOM side). `rules.js` drives them: `FEEL_OP` commands in, rule events out (`enemy-down`, `coin`, `wave-start` …).
    - **Slots a forge game with weapons or enemies carries** beside the tables', the look's and the world's: the four bodies and their clips (item 12); `character.held.<weapon id>` (the weapon in a friend's hand and in the first-person hand); `character.arms.player`; `enemy.<id>.body`, `enemy.held.<name>`, `enemy.clips`, `enemy.orb`; `fight.debris.{skull,ribcage,bone}`, `fight.coin`, `fight.target`; `fx.{smoke,sparks,embers,dust,bone,blood, muzzle,impact,orb}`. Every one is drawn tagged with its slot, so coverage stays 100% through a fight.
    - **Who draws what:** the Rust renderer draws every animated body skinned, the weapon on its hand socket, the first-person arms and the weapon in hand (posed from the feel view), and every rigid thing the core spawns by its kind and type (`render.entityModel`). A model's hidden `flash_muzzle` node shows for a shot; `glow_eyes` take the AI view's tell; emissive maps are drawn.
    - **Co-op in a fight:** a joiner's shot is its own at once (flash, kick, sound, sparks); the damage is the host's. Debris, coins and rounds in flight are each copy's own (never in a snapshot); enemies are replicas.
    - **Enemies stand level with the player's eyes:** a chaser, a caster and a shield are 1.1 times their body (1.75 m as built; the eyes are at 1.74 m), a runner 1.01 (`gf/forge/tables/enemies.js`, forge-ai `defs.rs`).
    - **Tools:** `gf-forge/tools/room.mjs` and the native `forge-play/tests/together.rs`.
15. **The run, the look, the HUD** (ARCHITECTURE "The run"; `runtimes/forge/lookdev/README.md`; Bone Vigil, `gf-forge/sandbox/vigil`).
    - **Cards and the reward:** `spec.tables.cards[]` are upgrades (`stat`, `add`, `mul` on a table value by its path), weapons or heals, each a slot; every player has their own values, and a card changes a value exactly (only a whole-number weapon field stays whole, `WHOLE_WEAPON`). A wave with `reward: true` deals three cards when it is cleared, with an inspector of every value the chosen card changes; each player chooses for themselves (mouse, 1 2 3, Enter, Esc, touch). `waves[].friends` grows a wave and a boss with the players. `forge.weapons` promises as keys only the weapons in hand at the start.
    - **Down and revive:** with a friend standing, zero health is down, not out; a friend within `player.revive.range` holding interact for `revive.time` brings them back at `revive.health`.
    - **The look:** adaptive exposure (`look.tone.*`), retro texels (`look.retro.*`), `ctx.render.surface(model, {texture, tile, space, emissive, density})` for a tiling surface, `ctx.render.backdrop(instance)` for what stands beyond the walls (no shadow, no collider). Hands and card pictures ride `config/world.json → art`; `create` ships the small variants of the library's Meshy files.
    - **The HUD and sound:** the `grim` theme (`kit/ui/theme.js`: two OFL font files as font slots, six colour slots; party and scenic games are untouched); the forge HUD (`gf/forge/hud.js`) draws health with armour and stamina, the wave, a boss's bar, score, coins, the weapons held and friends' health; every sound id plays a library file through gf-audio at the default bus levels; a loading view (`kit/ui/loading.js`) stands until the menu.
    - **Tools:** `gf-forge/tools/vigil.mjs` (a whole run with a friend; `--solo`), `touch-check.mjs`, `listen.mjs`, `hud-shots.mjs`, `measure.mjs --load`, `lookdev/fight.mjs`.
16. **Two builds, the page, the crowd, the governor.**
    - **One core, two builds** (forge-web's `webgpu` and `webgl2` features; `BUILD.json` schema 2 with `builds.webgpu` and `builds.webgl2`). A game ships both and a device downloads one; `gf/forge/host.js` picks (item 6). `?gf-forge-backend=webgl|webgpu` forces one for QA and never falls back. Without float render targets the WebGL2 build draws tier `ldr` (8-bit, no bloom; `?gf-forge-scene=8bit` forces it).
    - **The page** (`create.mjs` `indexHtml`): an inline script starts the wasm's download with the page's first bytes (`window.__gfEarly`), every module is preloaded, and `gf/forge/first.js` fetches what the first wave needs once the menu is drawn.
    - **The crowd** (ARCHITECTURE "The crowd"): a player is stopped by an enemy's body and never moved by one.
    - **The governor** (`gf/forge/governor.js`): steps the render scale, particles and shadowed fires down when frames stay low, and back up; a Settings toggle ("Hold the frame rate"); off under automation unless `?gf-governor=1`. Settings on a touch screen also has gyro aim (off by default). The wheel and a two-finger tap swap weapons.
17. **A viewer's copy: Go live on forge** (ARCHITECTURE "Live co-op"; forge-feel `watch.rs`). A fourth role beside host, joiner and alone, with no player of its own: every player is the host's replica. The camera is the streamer's eyes with their weapon in view (it kicks, reloads and swings). **Go live** is in the game's own menu (`#gf-live`), and a viewer has the kit's bar (Join · Start a room · Play solo). A viewer's HUD shows the wave, the clock, every player, damage numbers, the crosshair, the boss bar, the reward as "waiting for …" and who is down, never the player's own card, menu, prompts, coins, ammunition or touch buttons. It does not see a tracer for a missed shot, rounds in flight or the rounds left; the view is about half a second behind. `gf-forge/tools/live.mjs` plays a whole stream.
18. **The town street and the risen townsfolk; phone controls.**
    - **`town-street`, look `gaslit-street`** (`gf/forge/town.js`, `arena.js` `STREET_SIZES`): a cobbled street 9 m wide and 30, 36 or 42 m long into a square, generated from `world.seed`, with alleys, gas lamps (at most five with shadows), cellar hatches, alley mouths and drains for emerge points, and carts, barrels and crates for cover. Its guarded prop is named `pump`. Every piece is a slot (`world.town-street.<piece>`).
    - **A second enemy set** (roles `enemy.zombie.{chaser,runner,ranged,shield,brute,boss}`, the library's `bodies/zombie-*.glb`): a spec picks it by each enemy row's `body` (an archetype's default is its grim skeleton). A set says in its catalog role what a kill sheds (`sheds`) and what its caster throws (`throws`).
    - **A phone's controls** (`gf/forge/hud.js`, `forge.feel.touch`): small buttons in an arc round fire, each shown only when it can do something; the weapon fires by itself while the aim rests on an enemy in range (on for touch, off for a mouse).
19. **Endless** (`spec.tables.endless`; `gf/forge/tables/endless.js`; forge-ai `director.rs`). With `on`, past the last wave the director starts again at wave `from`, a lap more; each lap every wave has `1 + grow × lap` times its enemies (a boss stays one, at most `aliveMost` at once), with that much more health, damage and speed (speed up to `speedMost`). `wave-start` and `wave-clear` carry the running number and `b: 0`, a `lap` rule event marks a new lap, and `waves-done` never comes. **The round flow on forge:** `boot-forge.js` loads the flow `round.flow` names, so a forge spec may name `loop: "endless"` (`kit/loops/endless`; `tools/lib/vendor.mjs` carries every flow whose manifest runs on forge).
20. **Builds, the purse and the cart, elites** (ARCHITECTURE "Builds", "Coins worth spending", "Elites"). A card kind `perk` and `spec.tables.families[]` with set bonuses (rule event `set-bonus`; `deal.familyBias` leans deals toward started families). Every coin fills the player's purse (the host's); `spec.tables.shop` opens a cart after cleared waves, the host checks every purchase (`buy-refused` spends nothing), and a revive can be bought in a fight (holding interact beside a friend stays free); rule events `shop-open`, `bought`, `shop-card`, `shop-refund`, `shop-left`, `shop-done`. `spec.tables.elites` (never a boss) rolls modifiers burning, armoured, splitting and fast on the host's seeded dice; rule events `elite`, `burning`.
21. **One selection system: the cart deals the cards** (ARCHITECTURE "One selection system"; forge-feel `shop.rs`; `gf/forge/shop.js`, sharing `cards.js`'s card face and inspector). When a cart opens the core deals three cards a player (`deal.familyBias` leans them), each priced by its rarity (`spec.tables.shop` card item: a common's price, a multiplier for rare and epic, × perLap^lap, × perBuy^bought this visit); a bought card's place reads "Sold" until a Fresh Deal re-deals all three. A spec whose waves ask for no reward and whose shop is on has one selection system; a game with no shop keeps the reward screen. The cart is one panel over most of the screen: its heading holds the purse, the score, the time left as m:ss and Done (the last 10 seconds count down, `shop.text.packing`); three card faces with Buy, the items as big tiles, the whetstone's chooser and Back; every target at least 56 px either way on a phone. Keys 1–3 choose a card, 4–7 the items; Enter buys the card chosen (or says why not) and with nothing chosen is Done; Esc lets go of a choice or leaves a chooser and never leaves the cart. It takes no click, tap or key for 600 ms after it opens and after a fresh deal (`CART_GUARD_MS`), a card's face only chooses it, the reward never takes the mouse back while the cart is open, a greyed tile or Buy says why on itself ("Need 4 more", "Sold out"), and no cart word is under 14 px with a mouse or 12 px on a phone (`CART_TEXT_MIN`). `spec.tables.shop.seconds` may be 120; the cart closes early when every player has pressed Done ("Waiting for {name} · m:ss"). The HUD keeps the score and the coins on the screen (36 px, 28 on a phone; the cart's heading carries both while it covers the fight). In a fight played alone the boot opens the pause menu when the browser lets the mouse go (its Esc; a page's own `exitPointerLock` opens nothing), and shows "Click to fight" (`text.clickToFight`) back in a fight with the mouse free; in a friends round that line is all. Measure 13 (gate C) holds the cart: its phone leg (`tools/lib/forge-touch-check.mjs`: score and coins on the screen in a fight, the staged `?gf-demo=cart` with its targets, text and heading) and its mouse leg (`tools/lib/forge-cart-check.mjs`: the real pointer lock, the staged `?gf-demo=cart.locked`); broken examples `forge-small-cart`, `forge-hidden-tally`, `forge-cart-small-text`, `forge-cart-captured-mouse`, `forge-cart-no-guard`.

### §8 vista: the vista runtime

The plan is [research/super-scenic/PLAN.md](../super-scenic/PLAN.md) (§3 these additions) and the wave [THIN_E2E.md](../super-scenic/THIN_E2E.md); the engine is `gf-vista` (its README says what exists). A vendored WebGPU core (Tidewater at 4811ba48, MIT: an island in the open sea, a physical sky, a simulated ocean, volumetric clouds, a walker, a boat and fishing) draws and simulates; everything above it is this system's. **Closed to creators** until the creator opens it: the catalog's `engines.vista.status` is `ready` only with `GF_VISTA_OPEN=1`, and the pitch checker refuses a vista card otherwise.

| | vista (`gf-vista`) |
|---|---|
| For | calm games where the place is the point: a coast, the sea, the sky, light and weather; fishing, sailing, exploring, cozy co-op for 1–4. WebGPU only, a desktop browser; never inside a post on X |
| Spec | `"runtime": "vista"` (no profile). `create` refuses another runtime's `world.template` or `look.preset` and any `world.props` (the island's things are the core's); the registry refuses a camera vista has no rig for, a phone or a post on X (vista plays on a desktop only), the world loop and any mechanic (none runs on vista: what the play needs beyond the core and its tables is a build item) |
| Worlds, looks, camera | `islands`: 1 to 5 islands, each generated from a seed and words (`world.islands`: `[{name, seed?, words?}]`; left out, one island of the game's own seeded from `world.seed` or the title and prompt; `gf/vista/kit/world/places.js` WORDS: size, shape, islets, coast, bays, river, cliffs, bay, beach, pier, village, houses, reef, water, sand, rock, vegetation, plants, time, weather; a word it does not know is refused by `create` with the ones it knows). `config/world.json` → `islands` (each with its seed, words and own start places) and `places` (island 1's: `pier`, `pier-head`, `beach`, `boat`, four seats each). Each island's `time` and `weather` set the look on arrival. The reference island is a frozen recipe (`REFERENCE`) for regressions and T7 only: gate F fails a game that builds it (measure 17, vista's leg); `clear-morning`, `bright-noon`, `golden-hour`, `sunset-glow`, `moonlit-night`, `storm-swell` (`gf/vista/kit/look.js` PRESETS: the hour, the sea state, the exposure, the clouds); `first` |
| `spec.tables` | the data tables (`gf/vista/kit/tables`, interface I1: `check`, `fill`): `species`, `gear`, `vendors`, `economy`, `start`; `config/game.json → vista`, every value a slot (`vista.<path>`). `create` refuses what `check` names |
| In the game | `gf/vista/kit/` (`host.js`, `gpu.js` (the probe and the no-WebGPU screen, with no import), `config.js` (what a spec may name, the configs and the slots), `look.js`, `observe.js`, `players.js`, `humanoid.js`, `game.js` (the game bridge, I2), `tables/`, `vendor/meshopt_decoder.module.js`), `gf/vista/hud/` (I3), `gf/vista/core/` (the core's code and its public files, ~50 MB, with its `LICENSE`, `ATTRIBUTION.md`, `CREDITS.md` and `PATCHES.md`), `gf/vista/UPSTREAM.json`, laid out as in the repository; of `gf/three/` only what `core/boot-vista.js` imports; no `vendor/`; no import map; `index.html` holds `<div id="app">` (the core draws into it). `assets.json` → `runtime.gpu: "webgpu"`. Friends' bodies are `assets/bodies/<id>.glb` (I4: `gf/vista/kit/bodies.json` → `default`, else four Quaternius library bodies), slots `character.body.player`, `.2`, `.3`, `.4`, with `character.clips.player` and the seat colours `character.tint.player` |
| `main.js` | `import { boot } from './gf/three/core/boot-vista.js'` |
| Delivery | the file tree only: `tools/pack.mjs` refuses a vista game with the reason (the core's files and its WebGPU-first module loading) |

1. **`gf/three/kit.js`** records `runtime: "vista"` and `vista: {name: 'gf-vista', version, upstream: {repo, commit, license}, main: 'core/boot-vista.js', files}`; the version is `VISTA_VERSION` in `tools/lib/paths.mjs` (`0.2.0-thin` today). `files` hashes every gf/vista file (the core's public files among them), and the core's `LICENSE` and `ATTRIBUTION.md` travel with it. `gf-three.json` → `kit.vista` is the version.
2. **The boot** (`kit/core/boot-vista.js`): the shared loading view; the configs and `assets.json` (`kit/assets/core.js`); **the WebGPU probe before any core module loads** (`gf/vista/kit/gpu.js`): no adapter, a software one or one below the core's limits shows the kit's screen (`#gf-vista-nowebgpu`: the title, why, the game's link, Copy link) with `window.__game.phase === 'unsupported'`, and none of the core is downloaded (`?gf-vista-nowebgpu=1` forces it, QA); then `createVista({ui: false, reader, look})` (nothing of the upstream game's own interface or name is built; every core file is read through gf-assets, so Studio's overrides apply; the look from `config/look.json`), the tables (`fill(config/game.json → vista)`), the game bridge (`createVistaGame`, I2), the shared UI, HUD and home menu with vista's HUD parts in `#gf-vista-hud` inside the HUD layer (`createVistaHud`, I3), the round and the net (`kit/net/session.js` with `gf/vista/kit/players.js` `sessionPlayers`: the local player is the core's walker, friends are drawn by `createPlayers` as gf-humanoid-1 bodies from the body slots), `rules.setup(ctx)`, then the frame loop through `net.loop` (the core's `App.frame`, never its own loop). The core's free camera (F) and time switch (T) are off; the menu's mouse sensitivity and invert reach the core's look; the core takes the mouse only in a round with nothing over it (`window.__ui.isPointerOverUI`). No bots; no Go live (a viewer's copy is not built for vista).
3. **`rules.js` on vista:** `ctx.vista` (`state()` → `{money, cooler, rod, fight, near, catches, log}`, `sell()`, `buy(id)`, `look`, `tables`, `on(name, fn)`, `game.island()`, `game.islands()`); the game's events reach `rules.event(ctx, name, data, 'vista')` on the copy where they happened (`bite`, `hooked`, `catch`, `lost`, `sold`, `bought`, `board`, `leave`, `hop-start`, `hop-done`); `rules.canHop(ctx, to, info)` gates a trip to another island (true, false or the reason the HUD shows; `info.by` names a friend whose ask reached the host). A trip: at the boat's helm, out past the island's reach, toward an island on the horizon: the screen eases out, the next island is built (about 5 s) and everyone arrives aboard at its dock; the host's copy decides, a joiner's asks; `ctx.me.score` is each copy's own, and a joiner's reaches the host (message `vista-score`), which owns the results; `ctx.finish(reason)` ends the session for everyone with the results (a joiner asks the host: `vista-finish`). In a live round the host's copy owns the time of day and the sea state (`v: {h, s}` in the round's own world message). `create` writes a stub that plays: a catch scores, and `rules.params.goalSpecies` kinds of fish end the session (`prompts/build-vista.md`).
4. **The observation interface** (`window.__game`, §11's names): `snapshot()` (the session's fields, `net` the live gate's block, and `vista`: the walker, the boat, the look, the friends as drawn, the game bridge's state), `menu()`, `hud()`, `looks()` (`vista: {state, config, values}`), `camera()`, `screen()`, `controls()`, `project(x, y, z)`, and `vista.*` (`look()`, `game()`, `friends()`, `project(id)`; QA: `frames()`, `showFriend(id, on)`, `tags(on)`, `setLook(v)`). `coverage()` and `sight()` answer `notYet` (the slot-ID pass over what the core draws is not built).
5. **verify** (`tools/verify-vista.mjs`, which `verify.mjs` hands a vista game; `REQUIRED_VISTA` and `passesVista` in `tools/lib/verdict.mjs`; being regrouped into the gates of [GATES.md](GATES.md)). Required: 1 (with `runtime.gpu: "webgpu"`), 2, 3 (boots, no console errors, the walker walks on real keys), **5** (the live gate, and vista's sight leg `tools/lib/vista-sight-check.mjs`: gf-humanoid-1 bodies, each on the other's screen at the start place, the friend's body hidden and shown changing at least 15% of its box and twice the sea's own motion there, drawn within 0.5 m after a walk on real keys; the gate's random-look samples are stood in for by it when they miss), **6** (alone with the clock cut to 25 s, and the gate's two-player half), **13** (the core's controls for a new player: the mouse turns the view a quarter turn each way and never opens the pause menu, R takes the rod out, holding and letting go of the left button casts), 14, **15** (the fishing loop with real input: take the rod out, cast, strike the bite, reel the way the tension bar asks until a fish is landed; the catch is in the cooler and the HUD shows it; up to four casts in three minutes), 18, 20, 21, 23, 25, and vista's own **32** (a Chrome with no WebGPU shows the kit's screen with the game's link and downloads none of the core), **36** (the sea is drawn and moving: a band under the horizon is not flat and changes between frames 600 ms apart while the player stands still) and **37** (the look is the config's: the core's look state is `config/look.json`'s, and an hour Studio sets there reaches the core and changes the sky). **Not yet for vista** (`NOT_YET_VISTA`, each with its reason, never counted as passed): 4, 7, 8, 9, 10, 11, 12, 16, 17, 19, 22, 24, 31, 33, 34.

## 9. Worlds (a persistent block world)

A world is a kind of game, not a round: players drop in and out of one shared place that the play host keeps. Plan: [worlds/PLAN.md](../worlds/PLAN.md).

| | A round (§3) | A world |
|---|---|---|
| `config/game.json` → `round` | `{seconds, countdown, replay, winBy}` | `{mode: "world", countdown: 0, replay: false}` |
| Phases | lobby → countdown → playing → results → replay | lobby → playing, for good (Quit to menu, Leave world: back to lobby, nothing reset) |
| Clock, scores, results, bots | yes | none (`ui.timer(false)`, `ui.score([])`, no bots alone or with friends) |
| With friends | the friends page's waiting room, Start, results | the world card (gf-multiplayer `mode: "world"`): one room per world keyed `world:<slug>`, no codes, no Start; the host can change (a handoff) |
| Player ids | the room's seat id | the tab's `cid` (stable across a handoff; `worldNet` in `kit/net/session.js` translates) |
| Colours | the seat's (`palette[seat]`) | the room's, which follows the tab (`h.color`): the character, its ring and its name match its dot on the world card and in the menu, through a handoff |
| Spawn | the seat's spawn, at each round | on entering (and again 0.7 s later if a friend's pose shows up on it): the seat's spawn, else the one farthest from everyone this copy can see; alone, only the first Play |
| The game's own page, alone | Play: a round with bots | a practice copy: the home menu offers **Enter the world** (`#gf-friends`, the world card) first and **Try it on your own** (`#gf-play`) second; alone the world loads and keeps up with the play host but **nothing is saved** |
| `ctx.host` | fixed for the round | follows `net.onHost`; mechanics get `hostChanged(isHost)`, the rules `hostChanged(ctx, isHost)` |
| `ctx.net` | `send`, `on` | also `room` (`{key, code, host, max, players}`) and `status` (`menu`, `connecting`, `in`, `handoff`, `full`, `offline`; `alone` without friends) |

**The voxel world** (`kit/world/voxel/`; `config/world.json` → `{template: "voxel", voxel: {...}}`; boot loads it for that template whatever the profile):
- `grid.mjs`: one dense `Uint16Array`, a cell `v = block | tint << 8`, index `(y * sz + z) * sx + x`; 16³ chunks meshed with per-vertex AO, paint as its own attribute (the texture's detail stays under the colour), plants as crossed quads; a ray walk that returns the face entered by.
- `blocks.mjs`: `voxel.blocks[]` (`id`, `label`, `kind`: solid | cutout | glass | glow | plant | sign, `tex`, `place`, `break`, `boom`, `natural`), numbered from 1 in order. **Saved worlds keep the numbers: only ever add blocks at the end.**
- `terrain.mjs`: the island, deterministic from `voxel.terrain` (seed, water, ground, radius, hills, coast, beach, lake, trees, plants, plaza). The play host keeps only the cells players changed, so **`terrain.generator` (1) must give the same island forever**; a change to its output is a new generator version.
- `world.js`: the texture array (one image slot per block texture, `world.voxel.texture.<name>`, drawn at `FACE_SIZES` from `blocks.mjs`: 512 px on the high tier, 256 on the low one; every face file at least 512 px), the chunk meshes (slot `world.voxel.blocks`), signs (the board in the sign block's texture slot, the words in `world.voxel.sign-ink` on a panel of `world.voxel.sign-paper`), the sea (the look's water slots), one Rapier voxel collider that follows every edit, walls round the world, and the sea's fence: the open sea (2 or more below the water line, reached from the world's edge, not a lake) is solid in the physics only for three cells up from the water line where it meets the land, so nobody walks down the seabed out of sight; a player out at sea under the water anyway is brought back to a spawn after 1.5 s. `ctx.world.voxel`: `grid`, `table`, `apply(x, y, z, v, {text, face})`, `pick(from, dir, max)`, `protectedAt(x, y, z)`, `seaAt(x, z)`, `remeshNow`, `signs`, `store`, `reload()`, `stats()`.
- `default.json`: the kit's default world; `create` writes it for a spec with `world.template: "voxel"`, seeded by the title, the spec's `world.voxel` merged over it, textures from `library/textures/voxel/`, the spawn square in `voxel.protect`.

**Saved on the play host** (`kit/net/persist.js`; the server is `builder/studio-lib/world-core.mjs` behind `/world/v1/<slug>`, or `builder/world-server/serve.mjs` here): every copy loads the world from the play host (the newest snapshot plus the edits after it); the room's host pushes the edits it accepted every `saveEvery` s and on `pagehide` (keepalive). Only a room saves: alone (`!ctx.net.active`) the build mechanic loads and polls but never pushes (`build().saves`). Without a published slug (a Studio preview, a local page) the world is `local`: nothing is saved. An edit is `[u, x, y, z, v]` or `[u, x, y, z, v, text, face]`; the server dedupes on `u` and checks bounds, `floor`, `protect`, the block count and sign words against the published `config/world.json`.

**Mechanics.** `build` (`kit/mechanics/build/README.md`): the hotbar, place, break, paint, signs, boom blocks; the host orders, re-checks and saves every edit, catches up arrivals, and takes over after a handoff. An edit's author never blocks it on the host; their copy lifts them onto the block. `shove`: F or a touch button pushes the nearest player in front (fair play F6: never a knock-down). Names are filtered by the room, including slurs typed as names.

**First person** (`camera: "first"`, what a world spec picks): the eyes at 1.55 m, kept under a ceiling (a ball cast up from the chest: the body is 1.4 m, so in a two-block room a jump would otherwise put them inside the roof); the player's own body is never drawn on their screen, and it turns with the view, so the others see them face where they look (and a shove goes where they look). The input's `cursorMode = 'look'`: where the page allows the pointer lock, any first click only takes the mouse ("Click to look around with the mouse" until it does); then the mouse looks, a click is the action at the crosshair (held while the button is), and the wheel picks the next or previous block (or colour). Where the frame refuses the lock (a post on X), the orbit camera's way: a drag looks, a click is the action at the cursor, and there is no crosshair; on touch, the same taps and long presses (only Jump keeps a kit button). `input.aimFree` says which: the rig's ray goes through the pointer while it is true. The sign editor gives the mouse back to write and takes it again with the key or click that closes it. A crosshair shows while the middle of the screen aims.

**The orbit camera** (`camera: "orbit"`): third person behind the player, the mouse free (the input's `cursorMode = 'drag'`): a drag turns the camera, a click is the action at the cursor (pressed and released in one frame), the wheel zooms between `minDistance` and `maxDistance`; a wall pulls it in as close as `collisionMin` (0.35 m), and closer than 0.9 m the player's own body is hidden. `input.keysPressed()` gives a frame's key edges in the order they went down. On touch a short tap is the primary action where it lands, a long press the secondary; only Jump keeps a kit button. It never asks for the pointer lock, so it plays the same inside a post on X. `config/game.json` → `controls.more: [[keys, what, touch?, does?]]` lists a game's own keys (How to play and the help line show them; verify measure 13 holds each to its `does`: go, turn, stop, move, point, look, zoom, rise, act).

**Observation** (worlds only): `window.__game.camera()` also gives `pitch`, `eye` (the camera's position), `cursor` (the input's mode by name), `aimFree`, `crosshair`, `sensitivity`, `lookScale` and `invertY`; `window.__game.voxelAt(x, y, z)`, `topAt(x, z)`, `signAt(x, y, z)`, `protectedAt(x, y, z)`, `build()`, `shove()`, `world()`, `project(x, y, z)`; `snapshot().world` = `{status, voxel}`; `snapshot().players[]` carry `color` and `ring` (the colour the ring is drawn in).

**verify, worlds** (`tools/lib/worlds-check.mjs`, `tools/lib/worlds-net-check.mjs`; `REQUIRED_WORLD` in `tools/lib/verdict.mjs`; being regrouped into the gates of [GATES.md](GATES.md)): a world runs the checks that apply as they are (1, 2, 4, 7, 14, 18, 19, 20, 21, 22, 24) and these in place of a round's: 3 boots and walks, 8 swap proof (the body and a block texture), 11 the world lint (spawns on the plaza, the plaza protected, the generator version, every texture listed and at least 512 px), 13 the world controls (place, break, the break tool, hotbar keys, paint, a sign and E, a shove, a jump; real mouse and keys; in first person a first click only takes the mouse, real mouse moves turn the view until the crosshair is on the block, the wheel picks the next block, and the sign editor gives the mouse back), 5 and 25 the world gate (two players in one world through the world card: each sees the other, an edit on one shows on the other; 25 also: each enters on a spawn of their own, one colour per player on every screen, a slur typed as a name masked for everyone), 26 the world persists (entered through the card and built with real input; a fresh browser sees it; the bare page alone offers the world first and saves nothing), 27 the host leaves (the other copy hosts within seconds and keeps every edit and its colour; a third arrives and sees them), 28 the spawn square holds (refused on the client and by the server), 29 sign words are filtered (entered through the card; the host and the server), 30 phones (real touch on 390×844: stick, drag, tap to place, long press to break, the hotbar and tools, Jump), 34 watch then play (§9b). Check 24 adds, for a world in first person, a click on a block in the post's frame that builds there. Every check acts on a block the way the camera aims (`worlds-check.mjs` `aimAt` / `actOn`).

### 9b. Watch then play

Plan and contracts: `watch/PLAN.md`. gf-multiplayer streams and watches (`net.watching`, `net.watch`, `net.live`, `net.watchKey`, `net.onWatchKey`).

- **Go live** (`#gf-live`, the pause menu's room section, where the play host has a relay: `net.live.available`; also `#mp-golive` in the waiting room and results): the party page streams this copy's view of the room to a relay channel kept in the browser per game (a public id, a secret key), shows the share sheet (the link, Copy, Post on X, Stop) and LIVE with the count; everyone in the room sees LIVE. The link is `<studio>/play/<slug>/live/<id>` for a published game, the watch page itself here.
- **A viewer** (`gf/mp/index.html?watch=<id>`; a world's status `'watch'`, `net.watching`): the game page loads as usual and the feed is played into it through net.js 300 ms behind the streamer's own timing. In a live round the viewer's page loads each round's game page (`gf_mode=watch`) with that round's seed, and its own player is a ghost (hidden, in no list or score, `players.add({ghost})`); a world's viewer keeps a real one, hidden, because Join makes it theirs in place. Everyone in the stream is drawn as in the room. Input and the menu are off (the phase is the lobby's). A viewer sends nothing: it is not in the room, and the relay closes a viewer socket that sends anything but `ping`.
- **The viewer's camera** (`kit/core/boot.js` `watchCamera`) follows the streamer: their eyes in first person (the streamer's nameplate left out); in third, the streamer's own rig, found again from the point under their crosshair (behind a pivot at head height, `shoulder` metres to their right, looking through it at that point); behind them along their aim in orbit; the game's fixed angle in follow and top (where the rig stands). It looks from the streamer's eyes at the point they aim at (the pose's `aim` and `ad` from the aim origin, `kit/core/aim.js` `AIM_HEIGHT`). It updates the camera's matrices before nameplates are placed.
- **A viewer's screen** keeps the nameplates, bars, the round's clock and scores, the banner, the goal, a boss bar and the full-screen button (`#gf-ui.gf-watching`); never a player's own card, prompts, menu or touch buttons, and its canvas takes no clicks.
- **A room change** (`net.onWatchRoom`): when a world's host leaves, each mechanic's `watchRoom(code)` hears it in order with the stream (`build` starts its edit count again).
- **Catching up.** Each key frame carries `{looks, mech, rules}` (`kit/net/session.js` `watchBlob`): everyone's loadouts (`looks.watchKey/watchTake`), each mechanic's `watchKey()` taken by its `watchStart(data)`, and `rules.watchKey(ctx)` / `rules.watchStart(ctx, data)`. `build`: the room's entries the play host may not have (the host's from its log, a guest's from its tail); a viewer polls the play host for what was saved since its load, then takes them.
- **Join** (`#mp-watch-join`): in a world, the world card over the stream, which keeps playing behind it; Enter enters the same world without reloading the game (`watchEnd()` on each mechanic and the rules, then the usual guest sync). In a live round, Join opens the room's own link (`?join=<code>`) and the viewer plays from the next round. Stop, or the streamer leaving the room, ends the stream: viewers see that it ended, with Play.
- **A room of one's own, or the game alone.** Beside Join the viewer's bar has Start a room (`#mp-watch-own`, a live game: the friends page, where the viewer names themselves and hosts) and Play solo (`#mp-watch-solo`: the game's own page at its home menu; a world's is its practice copy, §9). A world is one shared world per link, so it has no Start a room. After a stream the first button reads Play with friends (a world: Enter the world). In a frame the size of a post the buttons take a row of their own, left of the full-screen button.
- **A locked room, a round alone.** The host's waiting room has Lock room (`#mp-lock`): the room then refuses anyone new (`refused` code `locked`), a round starts with whoever is in, the host alone included, and a stream's viewer sees Join as Room locked, beside Start a room and Play solo. A world has no lock.
- **The same link next time.** The channel lives in the tab's sessionStorage, so the share sheet also offers **Copy my streamer link** (`#mp-live-keep`): the friends page with `#gf-stream=<id>.<key>` in its fragment. Opened later in any browser, it puts that channel back in the tab, cleans the address bar and shows `#mp-live-saved`; the next Go live is on the same public link. `net.live.saved` says the page came from one. The secret never goes into storage the origin's games share.
- **The streamer's voice** (gf-multiplayer 1.7.0+): the microphone is captured on Studio's play page (or its mic window `/play/<slug>/voice`, the only other page that may hand the friends page voice) and sent as Opus over the stream; a viewer taps for sound and hears it in step with the game. Going live in the waiting room offers Turn on mic (`#mp-live-mic`) before the round starts. A message from the game below the streamer's page is refused. The relay's repeaters: `builder/watch/relay/README.md`.
- **Observation:** `__game.camera().dir` (where the view looks) and `__game.project(x, y, z)` (a world point on this screen) for every game; `snapshot().watch` = `{follow, live, target, camera}` while watching (`target`: the player the camera is on, null until drawn); `snapshot().net.watching`; the party page's `__party.snapshot().live` and `.watch`.
- **verify check 34** (live games: `tools/lib/friends-watch-check.mjs`; worlds: `tools/lib/worlds-watch-check.mjs`): §5 for live games. A world: A enters, builds, presses Go live from the menu (share sheet, LIVE); B opens the watch page and draws A where A is, its camera on A, with the block from before the stream and the one placed while B watches; B is not in the room and A sees 1 watching; a message sent to the relay as a viewer closes that socket (1008) and changes nothing; B joins in place (no reload) and A sees B; C watches, A stops, C sees the end; C presses Play solo and gets the world's own page. A viewer of a world is offered Play solo and no Start a room. For a live game, the viewer in a 480×480 frame is offered all three buttons inside it, presses Start a room and hosts a room that is not the stream's. In third person the viewer's camera is held to the streamer's own: within 1 m and 8° (first person: 0.4 m and 12°).

## 10. Flat (2D) games

A 2D game is `"runtime": "three", "profile": "flat-2d"` in the spec; its camera (`top` or `side`) is its plane. It is this kit on a plane, not another renderer: `gf-three.json` → `kit.profile` is `flat-2d`, `gf/three/kit.js` → `modules.flat` names the plane, and `gf/three/flat/` carries the four parts that differ (the look with an orthographic camera, the world from a tile map, picture bodies, the controller's flat rig). Everything else in this contract holds as written: boot, the session, live multiplayer, bots, fair play, the menu, the HUD, slots, sounds, flows, verify. `kit/flat/README.md` maps the files and the seams; `kit/flat/ART-STANDARD.md` is the picture standard (`gf-flat-1`).

- **Coordinates.** From above the ground is X-Z at y = 0, screen right is +X and screen up is -Z; nobody jumps. From the side the stage is X-Y, gravity pulls down Y, every body's Z is locked at 0, and Space jumps.
- **The spec.** `camera` is the plane's (`top` | `side`), `world.template` is `field` (top) or `stage` (side), `look.preset` is a flat look (it names the art style: pixel or drawn), every body is a picture sheet (`{from: "kind"}` gives the stand-in in the look's art style), and the mechanics are ones run on that plane (the kit's parts catalog → `rows["three/flat-2d"].mechanics.<plane>`). `world.map` may write the level as rows of text. `create` refuses anything else with the reason, and refuses flat things in a spec on another profile.
- **The world.** `config/world.json` → `map` (the slot `world.map`, format `gf-tilemap-1`, `kit/flat/tilemap.js`) is the only thing the world is built from: tile kinds (solid, not solid, or a ledge), spawns and named marks. A kind's picture is the slot `world.tiles.<kind>`. `spawns` beside it is §4.3's list, written from the map (`tools/flat-map.mjs --sync`). The runtime adds to §4.3's shape: `world.marks(name)`, `world.cell(p)`, `world.map`, `world.reach()`.
- **Bodies and props** are `image` slots. `ctx.assets.model("prop.<name>")` gives a picture as a card on the plane, so a mechanic that draws its prop needs no change.
- **Checks.** Where a check would assume a 3D game, the part declares what it should read: `gf/three/flat/index.js` → `manifest.reads(plane)`, `worldReport(subject)` (check 17), `bodyReport(image, opts)` (check 19).
- **Tools.** `tools/flat-art.mjs` (the stand-ins in both styles), `tools/flat-judge.mjs` (a picture or a game's pictures against the standard), `tools/flat-map.mjs` (print, report, sync), `tools/flat-reach.mjs` (side-on: drives the real player over every jump the level needs).

## 11. `window.__game` in full

Read-only, frozen, and plain JSON where it returns data (`kit/core/boot.js`). The forge and vista boots keep the same names (§8 forge 5 and 13, §8 vista 4). A preview subject (`?gf-show=`) has only `kit`, `runtime`, `profile`, `version`, `phase: 'show'`, `subject`, `ready`, `snapshot()`, `coverage()` and `slots()`.

| Name | What it gives |
|---|---|
| `kit`, `version`, `seed`, `quality`, `phase`, `ready`, `players` | The basics; `players` is `snapshot().players` |
| `snapshot()` | `{kit, runtime, profile, version, phase, round, seed, quality, time: {now, round, left}, me, host, live, backdrop, view, paused, players: [{id, name, score, alive, bot, local, x, y, z, anim, color, ring, control, down, protected, pl, mark?}], fair, refusals, winners, reason, results, shared, rules, modules, net, flow?, watch, world}`. `rules` is `rules.observe(ctx)`; `net` is the multiplayer gate's block (null alone); `refusals` is §7's list. Holds no functions and is stable for the same seed |
| `coverage()` | `assets.coverage(scene)` plus `unknownSlots` (slot ids on meshes that `assets.json` lacks) |
| `slots()` | Per slot: drawables, triangles, on screen |
| `controls()` | §6d |
| `camera()` | §6d (and §9 for worlds) |
| `looks()` | §6e |
| `menu()`, `hud()` | §6g |
| `panels()` | §6j |
| `screen()` | §6i |
| `sounds()` | `{plays, dropped}`: which sounds played, by id, as gf-audio counted them; plays it did not start, by reason |
| `sight(ids)` | A Promise: a slot's share of this player's view (`kit/core/sight.js`, a depth-tested render from the player's camera) |
| `project(x, y, z)` | Where a world point is on this screen: `{x, y, front}` |
| `voxelAt`, `topAt`, `signAt`, `protectedAt`, `build()`, `shove()`, `world()` | Worlds only (§9) |
| `stepped`, `step(ms, opts)` | Only with `?gf-step=1` alone (§1.2) |
