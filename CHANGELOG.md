# Changelog

All notable changes to xgames-kit. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Version 0.0.0 until the first release.

### Gate E's background-host leg and read-only kits (2026-10-14)

- **The background-host leg's verdict depends on the game, not the machine's load.** When round 1 ends early it waits
  for the room to say round 2 runs (one read raced the room's standings and skipped the step: Table Four, 3 of 5 full
  verifies under load); it holds the joiner's clock with the host's tab behind another to its pace in front, never to
  the wall clock. On a copy that is not the host's, `snapshot().net.clock` is now the last clock the host sent, so a
  host that stops shows as a clock that stops (`builder/gates/evidence/2026-10-14-background-host.json`).
- **Game files are writable whatever the kit's mode.** `create`, the in-game web3 and backend kits, art and items, and
  the Godot and forge copy steps copy through `builder/lib/writable.mjs`: a game made from a read-only kit (Studio's
  release snapshot) can be edited, refreshed by a later `create` and deleted.

### Spec v2 and the registry (2026-10-13)

- **Spec v2 is the only spec.** `runtime` (with its `profile`), `loop` and `kind` replace `engine`
  (`builder/spec/game-spec.v2.schema.json`); `players.mode` became `multiplayer.together`, the forge and vista fields one
  `tables`, a body or a prop is filled through `fill` (`kind`, `library` with `<pack>/<asset>`, `provided`, `generate`,
  `reference`), and `devices.targets` and the `build` list are required. An older spec is refused with what to do;
  nothing upgrades it. `create`, `verify`, the catalog and the examples resolve by runtime and profile.
- **The registry.** `registry/build-catalog.mjs` builds `registry/catalog.json` from the manifests (`runtimes/<id>/
  runtime.json`, `loops/<id>/loop.json`, `components/<id>/mechanic.json`, `kinds/<id>.json`); `create` holds a spec to
  it, and `gamesfun catalog` and `gamesfun_catalog` read it. forge and vista are open by their manifests (the creator:
  "We can open forge and vista"); `GF_FORGE_OPEN` and `GF_VISTA_OPEN` are gone.
- **The verdict.** `verify` writes `verdict.json` in the gates' format (`builder/gates/verdict.schema.json`: per gate
  what ran, passed and was skipped with why, the same on every runtime) and its whole record in `record.json`.
- Gone: `gamesfun economy migrate` (a shop moves in the studio's Economy tab), the reading of a prop's role words.

### The initial import (2026-10-13)

xgames-kit starts as one commit cut from gamesfun-kit, the kit's earlier home, with its private words, dated decisions
and run records taken out. What it holds:

- **The `gamesfun` command** (`npx gamesfun …`): `doctor`, `connect`, `dev`, `create`, `verify`, `play`, `slots`,
  `examples`, `catalog`, `update`, `login` and `publish`, on Windows, macOS and Linux with Node 24 and Chrome or Edge.
- **The MCP server** (`gamesfun_*` tools) and a Claude Code plugin, and `AGENTS.md` for any other agent.
- **The build loop**: pitch, locked spec, create, rules, the six gates of `verify` in real Chrome with real input,
  a black-box play-test by a separate subagent, and delivery with an honest outcome. The tools hold the order.
- **The studio page** on 127.0.0.1: the game, its slots, verify, a friends lobby and live reload, and requests sent to
  your agent's session.
- **Engines**: `party` and `flat` (gf-three, WebGL), `scenic` (gf-scenic, WebGPU or WebGL2), `vista` (gf-vista,
  WebGPU only, behind `GF_VISTA_OPEN=1`), `forge` (gf-forge, a Rust core on WebGPU and WebGL2, behind
  `GF_FORGE_OPEN=1`; no example yet: its free stand-in art is still to be made).
- **Multiplayer**: friends join from their own browser and see each other; online play through a hosted signaling
  server by default, your own server, or this machine only (`docs/ONLINE.md`).
- **Web3 on Solana devnet only**: tokens, items, loot boxes and game economies through the loot program; wallets sign
  in your browser, and the kit holds no private key.
- **Examples** that pass `verify --quick`: `soak-squad`, `giant-four`, `isle-run`, `coin-hop`, and `lantern-cove`
  (vista).

### The layered layout

- The kit is laid out in layers ([docs/LAYOUT.md](docs/LAYOUT.md)): `builder/` (the shared system, the CLI, the MCP
  server and the studio page), `runtimes/` (three with its profiles flat-2d and scenic-3d, forge, vista, a Godot
  placeholder), `components/` (the mechanics), `loops/`, `worlds/`, `examples/minimal` and `examples/showcase`, and empty
  `kinds/`, `registry/`, `library/packs/` and `evals/` for what comes next.
- xgames-kit is the source: `kits/`, `scripts/sync-kits.mjs` and `kits/KITS.json` are gone, and nothing reads a
  games.fun checkout. The last sync before the cut was games.fun 43d423796.
- One copy of each kit a game vendors: gf-multiplayer 1.7.8 (1.7.6 and the development sources dropped), gf-audio
  1.5.0, gf-assets 1.3.0, each without a version folder.
- No backwards compatibility: `gamesfun upgrade` and `tools/upgrade.mjs` are gone; an old game is created again from
  its spec.
