# gf-three: the games.fun three.js kit

Every new games.fun game is built on this kit (games.fun's Studio v2). A game is a short `rules.js` plus JSON config on top of the kit. The kit supplies:
- characters friends can see;
- live multiplayer;
- a good-looking renderer and worlds;
- a library of party-game mechanics;
- assets that can all be swapped;
- one-command QA.

The API is in **[CONTRACT.md](../../builder/CONTRACT.md)**. Read it before writing any kit code or any game.

## Layout

The three runtime is one kit a game vendors as `gf/three/`, kept in several layers of this repository
([docs/LAYOUT.md](../../docs/LAYOUT.md)):

```
runtimes/three/
├── README.md                  this file
├── kit/                       the kit, vendored into games as gf/three/ (the standard-3d profile)
│   ├── core/                  boot (and the forge and vista boots), loop, input, rng, observation, quality, guard
│   ├── assets/                slot loader, coverage walk, slot declarations → assets.json, items
│   ├── controller/            Rapier capsule controller, camera rigs
│   ├── net/                   live rounds over gf/mp/net.js, players, shared entities, events, persistence
│   ├── bots/, vfx/            bot players; effects
│   ├── look/                  renderer, lighting, post, materials, presets
│   └── character/             the gf-humanoid-1 runtime
├── profiles/
│   ├── standard-3d/           a README: the profile is kit/ itself
│   ├── flat-2d/               2D seen from above or the side (a game's gf/three/flat/)
│   └── scenic-3d/             the scenic look and world on WebGPU (a game's gf/scenic/), its art.json and specs
├── art.json                   the asset library's packs this runtime's own names resolve in (the art is in library/)
├── vendor/                    three.js 0.186.0, Rapier 0.19.2, postprocessing 6.39.5, N8AO, pinned
└── character-bench/           the body bench (rig and look checks for gf-humanoid-1 bodies)
components/<id>/               the mechanics (a game's gf/three/mechanics/<id>/)
loops/<id>/                    round, turns, match, endless (a game's gf/three/loops/<id>/)
worlds/                        layouts, places, templates, the voxel world (a game's gf/three/world/)
builder/ui/                    menu, HUD, panels, loading (a game's gf/three/ui/)
builder/tools/                 create, verify, slots, catalog, play and the checks
builder/CONTRACT.md            the API
```

## Rules

1. **Swap anything (PLAN §2.2).**
   - Every visible mesh, texture and tuning value is a slot.
   - No visible art is drawn in code; a generator bakes to a file slot.
   - `verify` fails any visible mesh without `userData.gfSlot`.
2. **Pinned:**

   | Library | Pin | Source |
   |---|---|---|
   | three.js | 0.186 (`build/three.module.js`, WebGLRenderer) | `vendor/three@0.186.0` (from games.fun's fps-arena trial) |
   | Rapier | `@dimforge/rapier3d-compat` 0.19.2 | `vendor/rapier@0.19.2` |
   | pmndrs `postprocessing` | as vendored | `vendor/postprocessing@6.39.5` |
   | N8AO (CC0-1.0) | as vendored | `vendor/n8ao` |

   Keep each LICENSE beside its copy. A new dependency needs a permissive licence and a line in `kit/THIRD_PARTY.md`.
3. **No build step.** Plain ES modules and an import map. A game is served as static files.
4. **Generic, not tuned to the test.**
   - The mechanics are the list in PLAN §2.1.
   - Nothing in the kit may exist only for a frozen eval case: no pee, no call centre, no token chart.
   - Those cases (`spec/evals/cases/`) are the system's final exam. Builders don't read them.
5. **Kit copies are never edited in a game.** `gf/three/`, `gf/mp/` and `audio/` are vendored by `create` and checked by `verify`.
6. **Multiplayer is live by default** (`multiplayer/STANDARD.md` bar): friends in one game, in sync, each seen as a character. Never pause during a live round.
7. **Audio through gf-audio** (`builder/gf-audio`); sounds are listed in `assets.json` → `sounds` → `sounds` (verify check 18 fails a sound anywhere else).
8. **Evidence.** QA runs write to `<game>/evidence/<run>/`, and they are append-only.

## Upgrading a game

`node gf-three/tools/upgrade.mjs <game> [--out <dir>] [--world]` brings a game made on an older kit onto the current one: the vendored copies are refreshed, `rules.js` and every config value the game set are kept, the config the new kit expects is added with its defaults, and `assets.json` is regenerated (CONTRACT §6d). Then run `verify`. Kit fixes (fair play, aim at the crosshair, interact that works) reach delivered games this way. `upgrade.mjs <game> --plan` changes nothing and says whether the game is behind the kit and whether `--world` is for it; the Studio worker runs it, then the upgrade, before a change job's agent starts.

## Never again

Every problem the creator finds by playing becomes a broken example in `regressions/` that a verify check must fail (creator decision 2026-10-06). `node gf-three/tools/regress.mjs` runs them all (about 4 minutes on the GPU), and `--corpus` re-verifies every delivered game, upgraded in a scratch copy (`spec/evals/corpus.json`). The no-browser part runs with these tests, and `tests/r-regressions.test.mjs` fails when verify, `tools/lib`, the kit or the examples changed after the last green run (`regress.mjs --record` writes `regressions/last-green.json`). How to add one: `regressions/README.md`.

## Ports

| Port | Use |
|---|---|
| 5790 | sandbox (K1) |
| 5791 | lookdev (L) |
| 5792 | character bench (C) |
| 5793 | mechanics fixtures (K2) |
| 5794–5795 | Studio v2 (S) |
| 5796–5797 | eval runs |

## Status

| Item | State |
|---|---|
| Wave 0b contracts | 2026-10-06 |
| Wave 1 | in progress |
