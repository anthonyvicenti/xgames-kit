# runtime godot in `gamesfun` (create, verify, dev): how it is wired

Written in staging, moved into xgames-kit on 2026-10-13 (stream godot). Nothing here changes another runtime.

## Where its outside paths are

`tools/lib.mjs → SHARED` is the one table of paths outside `runtimes/godot/`. Every game path's source is
`builder/tools/lib/paths.mjs → repoFileOf()`, the same table three's create and verify read, so a Godot game's
`gf/three/` (its three.js-free parts: assets, core, net, ui, flat), `gf/mp/`, `gf/gf-assets.js` and `audio/` come from
the same layers as every other game's.

## The seams in shared files (one line or one row each)

| File | What |
|---|---|
| `builder/tools/lib/paths.mjs` | `GAME_TREE`: the row `['gf/godot', runtimes/godot/kit]`; `PROFILES`: `godot: ['2d', '3d']` |
| `registry/catalog.json` | rebuilt from the manifests (`node registry/build-catalog.mjs`): godot's manifest is this runtime's |
| `tests/registry-catalog.test.mjs` | today's registry: godot exists (still not open) |
| `tests/spec-v2.test.mjs` | an example on a runtime not open to pitches holds to everything but that; the catalog line says `[not open]` |
| `builder/lib/create.mjs` | a spec with `runtime: "godot"` → `createGodotGame` (runtimes/godot/gamesfun.mjs), plus its import |
| `builder/lib/games.mjs` | `isGame`: a game has `gf-three.json` or `xgames.json` (runtime godot's record) |
| `builder/commands/verify.mjs` | a godot game → `verifyGodotGame`, plus its import |
| `builder/commands/dev.mjs` | a godot game → `devGodotGame` (export now, again on any change in `project/`), closed on stop, plus its import |
| `builder/ui/ui.js`, `builder/ui/menu.js` | the HUD's help line and the controls card: the game's own `controls.move` / `controls.aim` words win, and a side or top camera says "mouse aim" only for a game with a click action (`helpLine` is exported for its test) |

With spec v2 in create and verify (core-spec, merged), the godot branches can move into its dispatch table unchanged: `isGodotSpec(spec)`, `createGodotGame(dir, {specPath, example, force, fresh, kitRoot, shown})`,
`verifyGodotGame(dir, {quick, release, check, gate, out, json})`, `devGodotGame(dir)`.

## create

`createGodotGame` runs `tools/create.mjs` (config, slots, the Godot project from the starter its camera picks, the kit
copies), lays an example's own `rules.js` and `files/` over it, exports (installing Godot the first time:
`tools/install.mjs`, clause 9), and writes the game's `AGENTS.md` from `templates/game/`. Every file slot is filled from
the asset library (library/packs through `builder/art/views.mjs`: the style's `flat-standins-*` pack, then the packs in
`runtimes/godot/art.json`; a spec's `fill.asset` is exact), each pick's licence in the slot, `ATTRIBUTION.md` and
`xgames.json → art`. A 3D game's body and its clips (the body manifest's `use.clips`) are decoded to plain GLBs with the
3D tools' packages
(`builder/lib/char-deps.mjs` installs them once; only a 3D Godot game asks). Web3 (gf/web3) is not added: the wallet is
not wired into Godot games yet (a note says so).

## verify

`verifyGodotGame` writes `evidence/verify-N/verdict.json` in the gates' format (`verdictVersion: 1`; `gates` with
ran, passed, skipped with why, failed), `record.json` (what `builder/lib/games.mjs → latestVerdict` reads: `pass`,
`seconds`, the checks flat as `{n, gate, name, ok, detail}`, a skipped measure `ok: null` with why), `checks.json` (every
check with its detail and the run's facts) and `measures.json` (the browser legs' own record); `--json` prints the
verdict with the flat checks for the MCP tool.
Flags: `--quick` (no shared multiplayer gate: the default here), `--release` (the shared gate, a phone emulated in
Chrome, Firefox and WebKit), `--check` (a static list runs without a browser), `--gate X` (that gate's legs, that gate
judged). Every browser run goes through the GPU slot script on this machine.

## dev

The studio's dev server serves a Godot game as it serves any game (`.wasm` as application/wasm, `.pck` as
octet-stream); `devGodotGame` exports once and again on every change in `project/`, and live reload sees `build/`
change. rules.js and config need only the reload.

## Open

- The play host's headers for `.wasm` and `.pck` on Studio's play origin need a look before a Godot game is published.
- Whether to promote the 2D parts (`GfTilemap2D`, `GfFlatBody`) into `components/` once a second runtime needs them.
- Opening godot to pitches (`state.open` in runtime.json) is the creator's call; until then `checkSpecV2` reports a godot
  spec as "not open to pitches" and the pitch does not offer it.
