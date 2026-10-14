# The repository's layout

xgames-kit is laid out in layers, one folder per layer. This page is the map: what each folder holds, where every
folder of the old layout went, and why it is laid out this way. The design behind it is the kit's final design of
2026-10-13 ("Kit and Game Creation Loop: Final Design").

## The layers

```
builder/          the shared system every game and every runtime uses
  lib/ commands/ mcp/ server/ studio/ bridge/      the CLI (bin/gamesfun.mjs is its entry), the MCP server, the local
                                                   studio page and its bridge to your agent's session
  tools/          create, verify (the six gates), slots, catalog, play, promises, the checks (tools/lib/)
  loop/           the build loop as a library (pitch, spec, create, rounds, verify, play-test, delivery)
  spec/           the game spec and pitch schemas, the prompts, the development specs
  CONTRACT.md     the kit's API: rules.js, slots, verify's checks, every runtime's section
  GATES.md        the six gates: why they replaced a check per complaint, and what each one asks
  ui/             the menu, the HUD, the panels and the loading screen (a game's gf/three/ui/)
  gf-multiplayer/ gf-audio/ gf-assets/             the kits every game vendors (gf/mp/, audio/, gf/gf-assets.js),
                                                   one copy each; the version is in the copy's own kit.json or VERSION
  multiplayer/ watch/ world-server/                signaling, the two-player gate, the watch relay, the world server
  qa/ asset-manifest/ audio-gates/ studio-lib/     the Chrome launcher, the asset validator, the loudness gates, the
                                                   modules the tools share with games.fun's Studio
  web3/ backend/  the economy and the game-backend layer (devnet), and their in-game clients
  templates/      what create writes into a game folder (game/) and the backend server template (backends/)
runtimes/         what runs a game
  three/          three.js: kit/ (the standard-3d profile and everything the profiles share), profiles/flat-2d,
                  profiles/scenic-3d, profiles/standard-3d (a README: it is kit/ itself), vendor/
                  (three.js, Rapier, postprocessing, N8AO, pinned), character-bench/
  forge/          the Rust core on wgpu, two prebuilt hash-pinned wasm builds, its HUD, its cast (cast.json: what it
                  draws by role, from the asset library) and Rust source
  vista/          the vendored WebGPU core (Tidewater, MIT) for calm places
  godot/          a README: the Godot runtime is being built
components/<id>/  the mechanics, one folder each (a game's gf/three/mechanics/<id>/)
loops/<id>/       how a session runs: round, turns, match, endless (a game's gf/three/loops/)
worlds/           layout generators, places, templates, the voxel world (a game's gf/three/world/)
kinds/            presets for how a game feels (silly, blocky, lofi, scenic, dark, calm, pixel, drawn): one JSON each
registry/         the catalog computed from manifests (exists, tested, open, per runtime, loop, mechanic, kind):
                  build-catalog.mjs writes catalog.json; schema/ holds the manifests' schemas
library/          the asset library, the only art index: packs/<id>/ (one manifest and preview per asset, the pack's
                  licence), defaults/ (the small default set of binaries the kit ships, by sha256), the licence policy;
                  its tools are builder/art/ (gamesfun art find, fill, ingest, fetch, check, generate)
examples/         minimal/ (one idea, one check) and showcase/ (a quality bar with captures and evidence)
evals/            the frozen eval cases and their records (append only): empty for now
games/<name>/     your games (git-ignored)
bin/ docs/ tests/ scripts/ skills/ plugin/ program/   the entry, the docs, the tests, maintainer scripts, the agent
                  skills, the Claude Code plugin, the loot program's Rust source
```

## A game's tree is assembled from the layers

A game keeps the layout it always had: `gf/three/` holds the three runtime's kit with `mechanics/`, `loops/`,
`world/`, `ui/` and `flat/` inside it, because the kit's own modules import each other by those relative paths
(`gf/three/mechanics/melee/index.js` imports `../../core/util.js`). Here those folders live in their own layers, and
one table says where: `GAME_TREE` in `builder/tools/lib/paths.mjs`.

| In a game | In this repository |
|---|---|
| `gf/three/mechanics/<id>/` | `components/<id>/` |
| `gf/three/loops/<id>/` | `loops/<id>/` |
| `gf/three/world/` | `worlds/` |
| `gf/three/ui/` | `builder/ui/` |
| `gf/three/flat/` | `runtimes/three/profiles/flat-2d/` |
| `gf/three/` (the rest) | `runtimes/three/kit/` |
| `gf/scenic/` | `runtimes/three/profiles/scenic-3d/kit/` |
| `gf/forge/` | `runtimes/forge/kit/` |
| `gf/vista/kit/`, `hud/`, `core/` | `runtimes/vista/kit/`, `hud/`, `core/` |
| `gf/mp/` | `builder/gf-multiplayer/source/` |
| `gf/gf-assets.js` | `builder/gf-assets/source/gf-assets.js` |
| `audio/` | `builder/gf-audio/source/` |

The tools read the kit the way a game sees it: `kitPath(KIT, 'mechanics/melee/index.js')` and `walkKit()`, so create
vendors the same files, verify's check 2 holds a game's copy to the same hashes, and the catalog and the slots read
the same declarations. In Node a kit module's import that crosses layers is resolved through the game's tree by the
hook in `builder/tools/lib/kit-import.mjs`; Node code imports such a module with `importLayer()`, never with a static
import (a static import is resolved before any hook can be installed). A new kit module needs nothing new: put it in
its layer, import as a game would.

## Old path → new path

The cut (2026-10-13) took gamesfun-kit's release branch into this repository as one commit; the move is the
second and third commits after it, so `git log --follow` shows each file's way.

| Old (gamesfun-kit) | New |
|---|---|
| `kits/gf-three/kit/` | `runtimes/three/kit/` |
| `kits/gf-three/kit/mechanics/<id>/` | `components/<id>/` |
| `kits/gf-three/kit/loops/` | `loops/` |
| `kits/gf-three/kit/world/` | `worlds/` |
| `kits/gf-three/kit/ui/` | `builder/ui/` |
| `kits/gf-three/kit/flat/` | `runtimes/three/profiles/flat-2d/` |
| `kits/gf-three/tools/` | `builder/tools/` |
| `kits/gf-three/loop/` | `builder/loop/` |
| `kits/gf-three/CONTRACT.md` | `builder/CONTRACT.md` |
| `kits/gf-three/README.md`, `character-bench/` | `runtimes/three/README.md`, `character-bench/` |
| `kits/gf-three/library/`, `kits/gf-scenic/library/`, `kits/gf-forge/library/` | `library/packs/` (manifests) and `library/defaults/` (the binaries), read through `builder/art/views.mjs`; the forge's casting is `runtimes/forge/cast.json` |
| `lib/art/` | `builder/art/` |
| `kits/gf-scenic/` | `runtimes/three/profiles/scenic-3d/` |
| `kits/gf-forge/` | `runtimes/forge/` |
| `kits/gf-vista/` | `runtimes/vista/` |
| `kits/gf-multiplayer/1.7.8/` (1.7.6 and the development sources in `kits/multiplayer/party/kit/` dropped) | `builder/gf-multiplayer/` |
| `kits/gf-audio/1.5.0/` | `builder/gf-audio/` |
| `kits/gf-assets/1.3.0/` | `builder/gf-assets/` |
| `kits/multiplayer/`, `spec/`, `qa/`, `asset-manifest/`, `watch/`, `studio-lib/` | `builder/` + the same name |
| `kits/audio/` | `builder/audio-gates/` |
| `kits/worlds/` (the world server) | `builder/world-server/` |
| `kits/vendor/` | `runtimes/three/vendor/` |
| `kits/KITS.json` | gone (nothing is synced) |
| `lib/`, `commands/`, `mcp/`, `server/`, `studio/`, `bridge/`, `web3/`, `backend/` | `builder/` + the same name |
| `templates/examples/<id>/` | `examples/minimal/<id>/` |
| `templates/game/`, `templates/backends/` | `builder/templates/game/`, `builder/templates/backends/` |
| `scripts/sync-kits.mjs`, `scripts/kit-layout.mjs` | gone |
| `gf-three/tools/upgrade.mjs`, `gamesfun upgrade` | gone: an old game is created again from its spec |

Paths written as `research/…` in records and comments (a `LICENSES.json` row's source, a comment naming where a
check came from) name games.fun's research tree, where the file was made. They are history, not paths here.

## Why this layout

- **Three questions, three kinds of folder.** A game is placed by what runs it (a runtime and its profile), how it is
  played (a loop and mechanics) and how it feels (a kind). Each answer has its own folder, so adding a feel never means
  adding an engine, and a mechanic is not hidden inside one runtime's kit. The runtime × kind matrix is a catalog
  view (`registry/`), never a folder tree.
- **One shared system.** Everything every runtime uses (create, verify and its gates, the loop, slots, multiplayer,
  audio, the menu and HUD, the CLI, the MCP server, the studio page, the economy) is in `builder/`, so a runtime plugs
  into one place.
- **xgames-kit is the source.** The old `kits/` folder was a byte-for-byte mirror of games.fun's research tree,
  rewritten on every sync and never edited here. That made every fix a round trip and kept two copies of each frozen
  kit version. Now the files are edited here, there is one copy of each kit, and nothing reads a games.fun checkout.
- **No backwards compatibility.** No version folders, no upgrade path, no shims: an old game is created again from a
  new spec when it is wanted (the creator, 2026-10-13).
- **A game's layout did not move.** The layers are this repository's; a game's `gf/three/` is the same tree as before,
  assembled from them. So no game, check or Studio page had to learn the new folders.

## Still to do (other streams)

- Spec v2 is the only spec (2026-10-13): `runtime`, `profile`, `loop` and `kind` in place of `engine`; create, verify,
  the catalog and the examples read it (`builder/tools/lib/spec.mjs`; `placeOf`, `placeOfGame` and `rendererFor` in
  `builder/tools/lib/paths.mjs`), and an older spec is refused. The registry (`registry/`, built from the manifests
  `runtimes/<id>/runtime.json`, `loops/<id>/loop.json`, `components/<id>/mechanic.json`, `kinds/<id>.json`) says what is
  open. Still to do: `kinds/` are stubs until the kinds stream's presets land; `library/packs/`, `evals/` and
  `runtimes/godot/` come with their streams.
- `profiles/standard-3d` is the three kit itself; `flat-2d` lives inside a game's `gf/three/` and `scenic-3d` beside
  it as `gf/scenic/`.
