# gf-three: third-party code and art (the vendoring list)

Every library a gf-three game carries, where `create` copies it from, and its licence. The licence file travels beside
each copy. A new dependency needs a permissive licence and a line here (research/gf-three/README.md rule 2).

## Code a game vendors (`<game>/vendor/`, `<game>/gf/`, `<game>/audio/`)

| What | Version / pin | Copied from | Into the game | Licence |
|---|---|---|---|---|
| three.js build | 0.186.0 (`build/three.module.js`, `three.core.js`), byte-identical to the npm tarball | `research/foundations/trials/fps-arena/source/vendor/three/` | `vendor/three/build/`, `vendor/three/LICENSE` | MIT |
| three.js addons | 0.186.0, only the files the kit, the modules, the libraries and `rules.js` import (resolved by `tools/lib/vendor.mjs`) | `research/gf-three/tools/lib/vendor/three/examples/jsm/` (a curated copy of the npm 0.186.0 tree: animation, csm, curves, effects, environments, geometries, lights, lines, math, misc, modifiers, objects, postprocessing, shaders, textures, utils; the GLTF, DRACO, KTX2, HDR, RGBE and EXR loaders; meshopt, ktx-parse, zstddec, fflate) | `vendor/three/examples/jsm/` | MIT |
| Draco decoder | 1.5.6 (three.js 0.186.0 `examples/jsm/libs/draco/gltf/`; three.js commit a79f0788dc "Update Draco decoders to v1.5.6") | the curated copy | `vendor/three/examples/jsm/libs/draco/` (its README, and `LICENSE`: google/draco tag 1.5.6) | Apache-2.0 |
| Basis Universal transcoder | 1.50 (three.js 0.186.0 `examples/jsm/libs/basis/`; three.js commit 302240259d "Upgrade to Basis Universal v1.50") | the curated copy | `vendor/three/examples/jsm/libs/basis/` (its README, and `LICENSE`: BinomialLLC/basis_universal tag v1_50_0) | Apache-2.0 |
| ktx-parse | 1.1.0 (three.js commit c06699ee25, 2025-08-10, the day 1.1.0 was published; three post-processes the file, so it is not byte-identical to the npm build) | the curated copy | `vendor/three/examples/jsm/libs/ktx-parse.module.js`, `LICENSE-ktx-parse` (from the npm 1.1.0 tarball) | MIT, Copyright (c) 2020 Don McCurdy |
| zstddec | 0.0.2 (three.js commit d5bb033624, 2020-07-27, the day 0.0.2 was published) with the Zstandard decoder compiled in from zstd's dev branch | the curated copy | `vendor/three/examples/jsm/libs/zstddec.module.js`, `LICENSE-zstddec` (npm 0.0.2 tarball), `LICENSE-zstd` (facebook/zstd v1.4.5, the release before that build; the exact zstd commit is not recorded) | MIT (zstddec); BSD-3-Clause (Zstandard) |
| @dimforge/rapier3d-compat | 0.19.2 (wasm inlined) | `research/foundations/trials/third-person-adventure/source/vendor/rapier/` | `vendor/rapier/` (`LICENSE`, `package.json`) | Apache-2.0 |
| pmndrs postprocessing | 6.39.5 | `research/foundations/trials/fps-arena/source/vendor/postprocessing/` | `vendor/postprocessing/` (`LICENSE.md`) | Zlib |
| N8AO | as vendored by fps-arena | `research/foundations/trials/fps-arena/source/vendor/n8ao/` | `vendor/n8ao/` (`LICENSE`) | CC0-1.0 (the vendored `LICENSE` is the CC0 1.0 text; this row said MIT until 2026-10-11) |
| gf-multiplayer | 1.3.0 | `research/multiplayer/party/adopt.mjs` (from `research/foundations/kits/gf-multiplayer/`) | `gf/mp/` | games.fun (MIT header) |
| gf-assets | 1.3.0 (`gf-assets.js` only) | `research/foundations/kits/gf-assets/1.3.0/source/` | `gf/gf-assets.js` | games.fun |
| gf-audio | 1.5.0 (ZzFX inside: MIT, `LICENSE-zzfx`) | `research/foundations/kits/gf-audio/1.5.0/source/` | `audio/` | games.fun; ZzFX MIT |
| gf-three (this kit) | 0.1.0-dev | `research/gf-three/kit/` | `gf/three/` (+ `gf/three/kit.js`, the hashes; `gf/three/LICENSE`), and `gf/LICENSE` (written by create: which folders are the kit's, then the same text) | MIT, Copyright (c) 2026 games.fun (`kit/LICENSE`) |
| three.js WebGPU build (scenic games only, CONTRACT §8) | 0.186.0 (`build/three.webgpu.js`, `three.tsl.js`, the same `three.core.js`), byte-identical to the npm tarball | `research/foundations/trials/third-person-adventure/source/vendor/three/` | `vendor/three/build/` | MIT |
| three.js TSL addons (scenic games only) | 0.186.0 `examples/jsm/tsl/` | `research/gf-scenic/tools/lib/vendor/three/` (copied from the npm 0.186.0 tarball) | `vendor/three/examples/jsm/tsl/` (only what the modules import) | MIT |
| gf-scenic (the scenic-3d profile, scenic-3d games only) | 0.1.0-dev | `research/gf-scenic/kit/` (folio-2025 by Bruno Simon @ `41046b5`, MIT, ported; `LICENSE-folio-2025` beside it) | `gf/scenic/` (hashed in `gf/three/kit.js`) | games.fun; folio-2025 MIT |

## Code inside the kit

| What | Where | Upstream | Licence |
|---|---|---|---|
| Floating-capsule character logic | `kit/controller/capsule.mjs` | [pmndrs/ecctrl](https://github.com/pmndrs/ecctrl) @ `e2cab804f9f15661a642e76f52d09f0b2db63f35` (`src/character/Ecctrl.tsx`), by way of games.fun's `trials/third-person-adventure/source/src/physics.mjs`; `LICENSE-ecctrl` and `NOTICE-ecctrl` beside it | MIT, Copyright (c) 2023-2026 Erdong Chen |
| Third-person camera rig | `kit/controller/camera-rig.js` | games.fun's `trials/third-person-adventure/source/src/camera-rig.js` (authored there) | games.fun |
| Friends drawn from poses, nameplates, `onScreen` | `kit/net/players.js` | patterns from games.fun's `trials/dusk-outbreak/source/src/friends.js` and `research/multiplayer/party/LIVE_HANDBOOK.md` | games.fun |
| The Node import hook for declarations | `research/gf-three/tools/lib/kit-import.mjs` | Node's `module.registerHooks` | — |
| Melee combat model (combo chains, swing arcs, queued presses and combo windows, the dash strike, hit-stop) | `kit/mechanics/melee/logic.js` (rewritten as data and a step function; nothing copied line for line) | [octobooth-4/buddy-rollback](https://github.com/octobooth-4/buddy-rollback) @ `db51978d61ed329fcdcfbfc8653b28cfdb007404` (`src/weapons.js`, `src/player.js`); `LICENSE-buddy-rollback` and `NOTICE-buddy-rollback` beside it. No Buddy or VS Code character, name or lore | MIT, Copyright (c) 2026 BUDDY: ROLLBACK contributors |
| Attack tokens and telegraphed windups for enemies | `kit/mechanics/waves/` | games.fun's Knuckle Row, `trials/brawler/source/src/model.mjs` | games.fun |
| Voxel chunk meshing, face table and ray walk | `kit/world/voxel/grid.mjs` | the three.js r186 manual example `voxel-geometry-culled-faces-ui.html` (mrdoob/three.js tag r186, commit 148ef33ecb), by way of games.fun's Blockhaven; `LICENSE-three-voxel` beside it (the text from `research/foundations/trials/voxel-builder/upstream/three-r186/LICENSE-threejsfundamentals-BSD-3`) | BSD-3-Clause, Copyright 2018 Google Inc. |

## Stand-in art `create` copies into a game (until tracks L and C have a match)

Listed with hashes in `research/gf-three/tools/lib/standin-assets/provenance.json`.

| File | Slot | Source | Licence |
|---|---|---|---|
| `mannequin.glb` | `character.body.<role>` (only when the character module is the stand-in) | Quaternius Universal Animation Library mannequin, `trials/third-person-adventure/source/assets/hero/hero.glb` byte for byte | CC0-1.0 |
| `grass.ktx2` | `world.<template>.ground` (stand-in world only) | Poly Haven `leafy_grass`, converted by `trials/scenic-valley` | CC0-1.0 |
| `ball.glb`, `slide.glb`, `bench.glb`, `crate.glb` | `prop.<name>` with no library match | baked by `tools/lib/standin-bake.mjs` (games.fun) | CC0-1.0 |
| `cap.glb`, `cap-backwards.glb` | `character.hat.<role>` | baked by `tools/lib/standin-bake.mjs` (games.fun) | CC0-1.0 |

Library props, bodies and clips carry their own records in the asset library (`library/packs/<pack>/`: pack.json,
LICENSE.txt and each asset's manifest; a generated body is in a private pack, never shipped). `create` copies
each record into the game's `assets.json` slot and `ATTRIBUTION.md`.
