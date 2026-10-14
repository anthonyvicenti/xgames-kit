# Third-party code and art

Everything this repository carries that it did not write: its licence, where the licence text sits, whether it asks for
credit, and whether it is copied into the games people make. Audited from the repository itself on 2026-10-11; a thing
whose licence the repository cannot show is listed at the end under "Needs a person" and is not described as settled.
For the people and projects behind the art, see [CREDITS.md](CREDITS.md); for a plain-words version, see
[docs/LICENSING.md](docs/LICENSING.md). `tests/licensing.test.mjs` fails when a library file has no licence record, when
a CC-BY file is missing from `CREDITS.md`, or when `LICENSE` is missing or not MIT.

This repository's own code is MIT (see [LICENSE](LICENSE)): one permissive licence for everything of ours, so a game made with it can be used and shared freely.
That covers games.fun's own code and art in the kit's layers. Everything below keeps its own licence.

"In a game" means `create` copies it into the game folder; the game's own `ATTRIBUTION.md` then lists it (see "How a
created game carries its credits" in [CREDITS.md](CREDITS.md)).

## The kits (`builder/`, `runtimes/`, `components/`, `loops/`, `worlds/`)

Made in games.fun's research tree and brought here (the last sync was games.fun 43d423796; [docs/LAYOUT.md](docs/LAYOUT.md)
says where each folder went). games.fun and this kit have the same owner, so these are MIT under this repository's
`LICENSE`.

| Kit | Version | Where | Licence | In a game |
|---|---|---|---|---|
| gf-three (the three.js game kit and its tools) | 0.1.0-dev | `runtimes/three/` (the kit), `components/`, `loops/`, `worlds/`, `builder/ui/` (its parts in a game), `builder/tools/` (the tools) | MIT (this repository) | kit part: yes (`gf/three/`); tools: no |
| gf-scenic (the scenic engine: WebGPU, generated islands and dungeons) | 0.1.0-dev | `runtimes/three/profiles/scenic-3d/` | MIT (this repository); the folio-2025 code inside is a separate row below | scenic games: yes (`gf/scenic/`) |
| gf-vista (the vista engine: WebGPU only, a sky, sea and island; not open to pitches yet) | 0.2.0-thin | `runtimes/vista/` (`kit/`, `hud/`, `core/`, `UPSTREAM.json`, the example spec) | MIT (this repository) for `kit/` and `hud/`; the core is Tidewater's, a separate row below | vista games: yes (`gf/vista/`, the core whole bar the sky-pro clouds, about 53 MB) |
| gf-forge (the forge engine: first-person co-op action on a Rust core; not open to pitches yet) | 0.10.0-wave8 | `runtimes/forge/` (`kit/` with both prebuilt wasm builds, `library/`, `hud/fonts/`, `specs/`, `lookdev/` bar its sheets, `core/` the Rust source, `tools/library.mjs`, `hud/create.mjs`) | MIT (this repository); the crates compiled into the wasm are row 23, the HUD fonts row 24, the art below | forge games: yes (`gf/forge/`, about 10 MB with both builds) |
| gf-multiplayer | 1.7.8 | `builder/gf-multiplayer/` | MIT (its `kit.json` and file headers) | yes (`gf/mp/`) |
| gf-audio | 1.5.0 | `builder/gf-audio/` | MIT (this repository); ZzFX inside is a separate row below | yes (`audio/`) |
| gf-assets | 1.3.0 | `builder/gf-assets/` | MIT (this repository) | yes (`gf/gf-assets.js`) |
| local signaling, validators, QA (signal server, asset-manifest validator, audio gate, Chrome launcher) | as brought here | `builder/multiplayer/`, `builder/asset-manifest/`, `builder/audio-gates/`, `builder/qa/`, `builder/studio-lib/` | MIT (this repository) | no |

## Code inside the kits

| # | What | Version | Licence | Licence text (path from the repository root) | Credit asked? | In a game |
|---|---|---|---|---|---|---|
| 1 | three.js (build) | 0.186.0 | MIT | `runtimes/three/vendor/three@0.186.0/LICENSE` | keep the notice | yes, `vendor/three/` with its `LICENSE` |
| 2 | three.js addons (curated copy: loaders, utils, postprocessing, ...) | 0.186.0 | MIT | `runtimes/three/vendor/three@0.186.0/LICENSE`; `runtimes/three/vendor/three@0.186.0/LICENSE` | keep the notice | yes (only what the game imports) |
| 3 | three.js WebGPU build and TSL addons (scenic) | 0.186.0 | MIT | `runtimes/three/vendor/three@0.186.0/LICENSE` | keep the notice | scenic games |
| 4 | Draco decoder (from three.js) | 0.186.0 | Apache-2.0 | stated in its `README.md` under `.../examples/jsm/libs/draco/`; the full Apache text is not beside it | keep notices | yes, with its README |
| 5 | Basis Universal transcoder (from three.js) | 0.186.0 | Apache-2.0 | stated in its `README.md` under `.../examples/jsm/libs/basis/`; the full Apache text is not beside it | keep notices | yes, with its README |
| 6 | meshoptimizer decoder (in three.js addons) | as in three 0.186.0 | MIT | header of `.../jsm/libs/meshopt_decoder.module.js` (Copyright (C) 2016-2026 Arseny Kapoulkine) | keep the notice | yes, inside the addons |
| 7 | fflate (in three.js addons) | as in three 0.186.0 | MIT | header of `.../jsm/libs/fflate.module.js` names MIT and links its LICENSE; no text beside it | keep the notice | yes, inside the addons |
| 8 | ktx-parse, zstddec (in three.js addons) | as in three 0.186.0 | not shown by the files | no licence text or header in the repository | see "Needs a person" | yes, inside the addons |
| 9 | @dimforge/rapier3d-compat | 0.19.2 | Apache-2.0 | `runtimes/three/vendor/rapier@0.19.2/LICENSE` | keep notices | yes, `vendor/rapier/` with its `LICENSE` |
| 10 | pmndrs postprocessing | 6.39.5 | Zlib | `runtimes/three/vendor/postprocessing@6.39.5/LICENSE.md` | notice kept; no credit needed | party games, `vendor/postprocessing/` |
| 11 | N8AO | as vendored | CC0-1.0 by the text beside it (earlier versions of this file said MIT; see "Needs a person") | `runtimes/three/vendor/n8ao/LICENSE` | none (CC0) | party games, `vendor/n8ao/` |
| 12 | pmndrs/ecctrl (floating-capsule logic, ported) | `e2cab804` | MIT, (c) 2023-2026 Erdong Chen | `runtimes/three/kit/controller/LICENSE-ecctrl`, `NOTICE-ecctrl` | keep the notice | yes, beside `capsule.mjs` |
| 13 | BUDDY: ROLLBACK (combat model, rewritten as data; nothing copied line for line) | `db51978` | MIT, (c) 2026 BUDDY: ROLLBACK contributors | `components/melee/LICENSE-buddy-rollback`, `NOTICE-buddy-rollback` | keep the notice | yes, beside the melee mechanic |
| 14 | three.js manual example `voxel-geometry-culled-faces-ui` (adapted into the voxel world's grid) | r186, `148ef33e` | BSD-3-Clause, (c) 2018 Google Inc. (from threejsfundamentals) | named in the header of `worlds/voxel/grid.mjs`; the licence text it promises (`LICENSE-three-voxel` beside it) is not in the snapshot | keep the notice | voxel games (`gf/three/world/voxel/`); see gap 2 |
| 15 | folio-2025 by Bruno Simon (rendering, materials, lighting, terrain, vegetation, ported) | `41046b5` | MIT, (c) 2025 Bruno Simon | `runtimes/three/profiles/scenic-3d/kit/LICENSE-folio-2025` | keep the notice | scenic games, beside `gf/scenic/` |
| 16 | ZzFX (in gf-audio) | 1.3.2, adapted | MIT | `builder/gf-audio/source/LICENSE-zzfx`, `ATTRIBUTION.md` | keep the notice | yes, `audio/LICENSE-zzfx` |
| 17 | ws (the signal server's WebSocket) | 8.21.3 | MIT | `builder/multiplayer/p2p/vendor/ws/LICENSE`, `../ATTRIBUTION.md` | keep the notice | no (Node side only) |
| 18 | Mannequin animation clips and `hero.glb` (stand-in body) | Quaternius, via pmndrs/ecctrl `e2cab804` | CC0-1.0 | `builder/tools/lib/standin-assets/LICENSE-mannequin.txt` | none (credit is courteous) | yes, as the stand-in body |
| 19 | Tidewater by DRG Software Solutions LLC (Dan Greenheck): the vista core's engine, ocean, sky, post, fx, materials, world, player, game, UI and audio code, vendored with games.fun's edits (marked `gf-vista:`, listed in `core/PATCHES.md`) | `4811ba48` | MIT, (c) 2026 DRG Software Solutions LLC | `runtimes/vista/core/LICENSE`, `ATTRIBUTION.md`, `CREDITS.md`; `runtimes/vista/UPSTREAM.json` | keep the notice | vista games, `gf/vista/core/` with its `LICENSE` and `ATTRIBUTION.md` (verify check 2 fails a game without them) |
| 20 | The volumetric cumulus (`core/src/sky/SkyProClouds.js`) and its noise volumes (`core/public/clouds/`), from the same author's `sky-pro-webgpu` | as in Tidewater `4811ba48` | **not shipped in the kit** (the kit uses the core's own MIT clouds); their notice names a separate "Three.js Sky Pro license" | none here: they are not in the kit | — | no: a vista game made with this kit draws the core's own clouds (`core/src/sky/Clouds.js`, MIT, row 19); games.fun's own Studio draws the volumetric sky-pro ones |
| 21 | SMAA area and search tables (from three.js; SMAA by Jorge Jimenez et al.) | as in Tidewater `4811ba48` | MIT | named in `runtimes/vista/core/ATTRIBUTION.md`; no text beside `core/public/textures/smaa/` | keep the notice | vista games |
| 22 | meshoptimizer decoder (the vista kit's own copy) | as vendored | MIT, (c) Arseny Kapoulkine | `runtimes/vista/kit/vendor/LICENSE-meshoptimizer` | keep the notice | vista games, `gf/vista/kit/vendor/` |
| 23 | The forge core's Rust crates (wgpu, naga, hecs, glam, gltf, rapier3d, bytemuck, wasm-bindgen and the rest: 89 in the WebGPU build, 93 in the WebGL2 build), compiled into `kit/wasm/forge_web_bg.wasm` and `kit/wasm-webgl2/forge_web_bg.wasm` | as locked in `runtimes/forge/core/Cargo.lock` | MIT, Apache-2.0, BSD, Zlib (where a crate offers a choice, the one taken is named) | `runtimes/forge/kit/wasm/LICENSES.md` and `wasm-webgl2/LICENSES.md` (every crate, its version, licence and the licence texts) | keep the notices | forge games, `gf/forge/wasm*/LICENSES.md` |
| 24 | The forge HUD's two fonts: subsets of Grenze Gotisch and Grenze (Omnibus-Type), renamed GF Grim Display and GF Grim Text | google/fonts `c1eda92` and `87340cb` | OFL-1.1 | `runtimes/forge/hud/fonts/LICENSE-grim-display.txt`, `LICENSE-grim-text.txt`, `ATTRIBUTION.md` | keep the licence text with the font; the font may not be sold by itself | forge games, `assets/fonts/` with their texts beside them |
| 25 | meshoptimizer decoder (the forge kit's own copy, the one three.js 0.186.0 ships) | as vendored | MIT, (c) Arseny Kapoulkine | `runtimes/forge/kit/vendor/LICENSE-meshoptimizer` | keep the notice | forge games, `gf/forge/vendor/` |
| 26 | Divine Voxel Engine and its core divinevoxel-vlox (the voxel world's light flood, smooth per-vertex light and terrain ideas, written again for the kit's grid; no file, art or data copied) | `5080a27d`, vlox `eba6f696` | MIT, (c) 2025 Divine Star LLC | `worlds/voxel/LICENSE-dve` (both commits named), headers of `light.mjs`, `mesh.mjs`, `terrain.mjs` | keep the notice | voxel games (`gf/three/world/voxel/LICENSE-dve`) |

Gap list from this table (each is fixed here, in the kit's layers):
rows 4 and 5 and 8 lack a full licence text; row 14 lacks `LICENSE-three-voxel`; row 11 needs a person.
The kit's own list is `runtimes/three/kit/THIRD_PARTY.md`.

## Art (the asset library: `library/packs/`, its default set in `library/defaults/`)

Every asset is in a pack (`library/packs/<pack>/`): the pack's `pack.json` and `LICENSE.txt` hold its licence, author,
pinned source and every credit line, and each asset's manifest (`assets/<id>.json`) its own page, the sha256 of the
source and of the kept file, and what was changed. The kit ships only licences its policy allows
(`library/policy.json`: own, CC0 and permissive, CC BY with its credit line) and never a paid maker's output (those
packs are private and live outside the repository). `tests/licensing.test.mjs` fails when a pack's licence is outside
the policy or a default-set file is no public asset's. The rows below name the sources; `gamesfun art find` lists
every asset with its licence.

| # | Source | Licence | Files | Credit asked? | In a game |
|---|---|---|---|---|---|
| A1 | Kenney (kenney.nl): props and textures | CC0-1.0 | 139 props + 28 textures | no | the ones the game uses |
| A2 | Quaternius (Universal Animation Library and character packs) | CC0-1.0 | 13 bodies + the shared clips (`clips/gf-humanoid-1.glb`) | no | the ones the game uses |
| A3 | games.fun (bean bodies, textures, previews) | CC0-1.0, or generated (previews, one noise texture) | 4 bodies + 10 textures + 19 generated | no | the ones the game uses |
| A4 | Kay Lousberg, KayKit (scenic library: dungeon props, weapons, 9 character bodies) | CC0-1.0 | 84 | no | scenic games |
| A5 | Poly Haven `leafy_grass` (stand-in ground) | CC0-1.0 | `tools/lib/standin-assets/grass.ktx2` | no | every party game's stand-in ground |
| A6 | folio-2025 models and textures as scenic props (`library/folio/`) | MIT (Bruno Simon), `library/folio/LICENSE` | 15 files | keep the notice | scenic games that use them |
| A7 | Poly Pizza creators (below) | **CC-BY-3.0** | **10 props** | **yes** | yes: soak-squad, the party example, carries 9 of them |
| A9 | Microsoft Rocketbox avatars, six people rigged onto gf-humanoid-1 (pack `rocketbox-adults`) | MIT, (c) 2020 Microsoft, `library/packs/rocketbox-adults/LICENSE.txt` | 6 bodies (glb, sidecar, preview) | keep the notice | vista games (friends' bodies, `runtimes/vista/kit/bodies.json`) |
| A10 | The forge's art (packs `forge-*`, `kaykit-*`, `quaternius-props`, `humanoid-clips`): KayKit dungeon pieces and spare skeletons (Kay Lousberg), Quaternius clips and pieces, Kenney textures and sounds, OpenGameArt sounds (Zane, rubberduck, artisticdude and others, each named in its record), Poly Haven textures (Rob Tuytel, Dimitrios Savva) and games.fun's own pieces and town made from code | CC0-1.0 | 258 files (bodies, ruins, world, town, sounds, textures, fx, clips) | no | forge games: the ones the game uses, each listed in its `ATTRIBUTION.md` |
| A11 | The forge library's Meshy models: the four co-op hunters, the grim skeletons, the risen townsfolk, their held weapons, the first-person weapons and hands, the card pictures and props (generated on games.fun's paid Meshy plan) | LicenseRef-Meshy-Paid | **0 shipped**: their records are in `LICENSES.json`; the files are not in the kit (the kit never ships Meshy output, whose licence tier is unconfirmed). A forge game made here draws CC0 files of A10 in their place (games.fun's `library/stand-ins.json`) | no | no |
| A12 | Kenney (kenney.nl): every model of the nature, platformer, survival, toy car and fantasy town kits (packs `kenney-*-full`, in Kenney's own units) and the Particle Pack's 80 sprites (`kenney-particle-pack`), each pack pinned to its zip | CC0-1.0 | 840 models + 80 sprites | no | the ones the game uses |
| A13 | Quiver's Outpost Assault: two cartoon explosion flipbooks (pack `quiver-outpost-fx`, repository pinned to `9f5cc04`) | **CC-BY-4.0** | **2 effects** | **yes**: Explosion art from Quiver's Outpost Assault (github.com/quiver-dev/tower-defense-tutorial), CC BY 4.0 | the ones the game uses |
| A14 | Bangers (Vernon Adams) and Bungee (David Jonathan Ross) from google/fonts, pinned commits (packs `ofl-bangers`, `ofl-bungee`) | OFL-1.1 | 2 fonts | keep the licence text with the font | the ones the game uses |
| A15 | games.fun's Crumble Cove weapon icons (pack `xk-artillery-icons`), drawn as SVG for our own game | CC0-1.0 | 6 icons | no | the ones the game uses |
| A8 | Meshy AI "Cyborg gecko" | recorded as CC-BY-4.0 (plan unconfirmed) | **0 shipped**: the file is not in this kit, and neither is its record | yes, if it is ever shipped | no |

The ten CC-BY-3.0 props, each with the credit line exactly as the licence asks (author, title, a link to the work); the
licence is [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). They were resized to metres, recentred, joined per
material and meshopt-compressed (gltf-transform), which counts as a change:

- "Slide" by Poly by Google, CC BY 3.0 (https://poly.pizza/m/dDe3njWPbg0)
- "Cloud" by jeremy, CC BY 3.0 (https://poly.pizza/m/8CXbPO6p0n2)
- "Cloud" by Poly by Google, CC BY 3.0 (https://poly.pizza/m/44cGXp6_8WD)
- "Swing set" by Poly by Google, CC BY 3.0 (https://poly.pizza/m/e-IJdcqZH4p)
- "Sandbox" by sirkitree, CC BY 3.0 (https://poly.pizza/m/07KqBahqHXK)
- "Picnic Table" by J-Toastie, CC BY 3.0 (https://poly.pizza/m/GQieALI2C4)
- "Barbecue Grill" by Jason Toff, CC BY 3.0 (https://poly.pizza/m/c53QXQ1ofIN)
- "Red/White Beach Umbrella" by S. Paul Michael, CC BY 3.0 (https://poly.pizza/m/2li3sdSkmCI)
- "Reel W/ Hose" by J-Toastie, CC BY 3.0 (https://poly.pizza/m/qXBsZPAaYQ)
- "Water Cooler" by J-Toastie, CC BY 3.0 (https://poly.pizza/m/zWi9p5FSxD)

The two CC-BY-4.0 explosion flipbooks (A13), with the credit line exactly as the licence asks:

- Explosion art from Quiver's Outpost Assault (github.com/quiver-dev/tower-defense-tutorial), CC BY 4.0

The Meshy gecko's credit line, kept for the day it ships:

- "Cyborg gecko (Meshy)" by Meshy AI (generated for games.fun), CC BY 4.0 (https://www.meshy.ai)

games.fun's library has eleven CC-BY records: these ten, and the Meshy gecko (A8), which is CC-BY-4.0 and credits
Meshy AI; its file and its record are not in this kit.

### The vista core's own files (`runtimes/vista/core/public/`)

Not a library (no `LICENSES.json`): the core is copied whole into a vista game, and each folder carries its credits.

| What | Licence | Credits | In a game |
|---|---|---|---|
| 42 field recordings (Ogg Opus) from Freesound | CC0-1.0 | `public/audio/CREDITS.md` (each file's author and link) | vista games |
| Scanned beach debris and stall props, planks, iron and timber textures from Poly Haven | CC0-1.0 | `public/models/debris/CREDITS.md`, `public/models/props/CREDITS.md` | vista games |
| Two Rocketbox characters (the stall keepers) | MIT, (c) 2020 Microsoft | `public/models/characters/LICENSE-Rocketbox.md` | vista games |
| The humpback whale (mesh, albedo, height) | MIT (Tidewater's own) | `core/ATTRIBUTION.md` | vista games |

Upstream's key art (`public/ui/keyart*.jpg`) and its Google Fonts link are not vendored (`core/ATTRIBUTION.md`), and
the sky-pro cloud volumes (`public/clouds/`) are not in this kit (code row 20). The core's `ATTRIBUTION.md` and a
created game's `ATTRIBUTION.md` still list the sky-pro clouds and "cloud volumes": that wording is games.fun's and is
corrected there.

Sounds are gf-audio presets, synthesised at run time: no audio files (a vista game also plays the core's recordings
above). The grim theme's two OFL-1.1 fonts (Grenze
Gotisch and Grenze, Omnibus-Type) ship with the forge engine (code row 24).

## The example game

`examples/minimal/soak-squad/` is adapted from "Bladder Brawl", a game games.fun's Studio v2 built and delivered
(same owner, MIT with the rest). It uses only library art, and 9 of the 10 CC-BY props.

`examples/minimal/lantern-cove/` is games.fun's vista development spec (`runtimes/vista/specs/thin-cove.spec.json`,
same owner) with its prompt reworded: our own design and names, nothing of Tidewater's people or places.

`examples/minimal/isle-run/` is games.fun's scenic sandbox spec, and `examples/minimal/giant-four/` is the proof
game of games.fun's board mechanic and turns loop (same owner). Each uses only the library art of its engine.

## npm dependencies (`package.json`, pinned exactly; installed by `npm ci`, not committed)

| Package | Version | Licence | In a game |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.32.1 | MIT | no (tools only) |
| playwright-core | 1.63.0 | Apache-2.0 | no (tools only) |
| ajv | 8.20.0 | MIT | no (the MCP tools' argument check; already a dependency of the MCP SDK, now named directly) |
| their dependencies (92 packages: express, hono, zod, ...) | as locked in `package-lock.json` | MIT (83), ISC (7), BSD-3-Clause (2), BSD-2-Clause (1) | no |

The licence texts of npm packages are in their folders under `node_modules/` after `npm ci`; the repository does not
commit them.

Installed on first use of `rig-check` or `meshy`, from `builder/tools/lib/char-deps/package.json`
(tools only, never in a game): @gltf-transform/core, extensions, functions 4.5.1 (MIT), meshoptimizer 1.1.1 (MIT),
sharp 0.35.5 (Apache-2.0; its prebuilt libvips binaries are LGPL-3.0, dynamically linked), three 0.186.0 (MIT).

When Playwright's Chromium is downloaded (no Chrome or Edge on the machine), it comes under Chromium's own licences.

## Needs a person

Not settled from the repository itself:

1. **N8AO.** The licence text beside the vendored copy is CC0 1.0, but earlier lists in this repository and in
   games.fun's `kit/THIRD_PARTY.md` say MIT. The repository does not show which is the upstream's. Both are permissive;
   what a person should confirm is only the label. Also unconfirmed: the version.
2. **ktx-parse and zstddec** (inside the three.js addons): no licence text or header in the repository. They are the
   copies three.js 0.186.0 ships; confirm against that tarball.
3. **Draco and Basis Universal**: the repository states Apache-2.0 in their READMEs but has no copy of the full text.
4. **folio-2025 art** (A6): the record cites Bruno Simon's `license.md` (MIT, text beside the files). Whether the 3D
   models and textures in that repository fall under the same licence is something the MIT text alone does not say; a
   person should read the upstream repository's terms for its art.
5. **Quaternius bodies** fetched through Poly Pizza: each record says the Poly Pizza page showed "CC0 1.0" on the day
   it was retrieved; the repository keeps no copy of that page.
6. **The grim theme's fonts** (OFL-1.1): settled. They ship with the forge engine (code row 24), each with its licence
   text, and bring OFL-1.1's own conditions (the licence text with the font; the font may not be sold by itself).
7. **Chromium** downloaded by Playwright and sharp's libvips (LGPL-3.0): not shipped by this repository; mentioned only.
8. **The vista core's sky-pro clouds** (code row 20): settled by leaving them out. They are **not shipped in the kit**
   (the kit uses the core's own MIT clouds), because the `LICENSING.md` beside their noise
   volumes refers to a separate "Three.js Sky Pro license" whose text the repository does not have. The core's own
   `Clouds.js` (Tidewater, MIT) says in its comments that its technique follows sky-pro-webgpu; its code is Tidewater's.
9. **The forge library's Meshy models** (art row A11): settled by leaving them out: the kit never ships Meshy output, a forge game made here draws the CC0 stand-ins games.fun's
   forge library names in their place, and games published from games.fun's Studio keep the Meshy art.


## The loot program's source (`program/`)

games.fun's loot program 0.3.2 (the Solana program every economy runs on, devnet `GVzbAquL…Tg73o`), copied from games.fun's
source of 0.3.2 and published with the kit under its MIT licence (`program/LICENSE` is the same text). `program/README.md` says how to build it and check it against devnet.
Its Rust dependencies are not committed; `cargo` fetches them, at the versions in `program/loot/Cargo.lock`:

| Crate | Version | Licence | Used for |
| --- | --- | --- | --- |
| anchor-lang, anchor-spl | 1.1.2 | Apache-2.0 | the program framework and SPL token calls (in the deployed program) |
| ephemeral-rollups-sdk, ephemeral-vrf-sdk (MagicBlock) | 0.17.2 | MIT | asking MagicBlock's VRF oracle for randomness (in the deployed program) |
| magicblock-delegation-program-api, magicblock-magic-program-api | 3.1.0, 0.10.1 | MIT | pulled in by the MagicBlock SDK |
| solana-sha256-hasher | 3.1.0 | Apache-2.0 | ticket and terms hashes (in the deployed program) |
| litesvm | 0.10.0 | Apache-2.0 | the program's tests only |
| mpl-core (Metaplex) | 0.12.1 | Metaplex NFT Open Source License 1.0 (Apache-style, with restrictions on modifying Metaplex's code) | the program's tests only (building Core instructions); the deployed program calls Core through its own `core_cpi.rs` |
| solana-* crates, spl-token-2022-interface | 2.x to 3.x, 2.1.0 | Apache-2.0 | the program's tests only |
| borsh | 1.x | MIT OR Apache-2.0 | the program's tests only |

Not in `program/`: the upstream programs the tests load (`tests/fixtures/*.so`, dumped from devnet by
`scripts/fetch-fixtures.sh` onto the machine that runs them). The program data snapshots under `tests/fixtures/venue/`
and `tests/fixtures/v1/` are public devnet account bytes.

## The full simulation (`builder/web3/economy/sim/`)

Nothing new is installed with the kit. On first use of `gamesfun economy simulate --full` (or `economy_simulate` with
`full: true`) it installs, into the user's cache folder (never the kit's `node_modules`, never into a game):

| Package | Version | Licence | How |
| --- | --- | --- | --- |
| litesvm (and its prebuilt native module, `litesvm-<platform>`) | 1.5.0 | MIT | the local Solana the simulation runs the real program in; Linux and macOS builds only |
| its dependencies (@solana/kit 8.4.0 and 42 small @solana packages, @solana-program/token and system) | as npm resolves them for litesvm 1.5.0 | MIT (49), Apache-2.0 (2) | used by LiteSVM's own wrapper; the kit's code does not import them |

It also reads, once, from devnet into the same cache folder, and runs locally: the loot program 0.3 (games.fun's own,
MIT, checked against the deploy record's sha256), Metaplex Core and Metaplex Token Metadata (Metaplex NFT Open Source
License 1.0), and MagicBlock's VRF program (Business Source License 1.1: copying and non-production use allowed, MIT
from 2029-12-01). None of these binaries is committed or shipped; a simulation on the user's own machine is
non-production use.

## web3 (`builder/web3/`, `builder/server/routes/web3.mjs`, `builder/commands/web3.mjs`, `builder/mcp/tools/web3.mjs`, `builder/studio/tabs/{token,shop}.js`)

The Solana layer has **no runtime npm dependencies**. Its Solana code is written in the kit's own plain ES modules,
in `builder/web3/gf-web3/chain/`. That covers base58, SHA-256, the ed25519 curve check, PDAs, Borsh, legacy and v0
transactions, the loot program (0.3, classic SPL and Token-2022 tokens), Metaplex Core, the Meteora DBC launch instructions and mint parsing. Node's own
`node:crypto` provides ed25519 and SHA-384. The kit adopts nothing from `@solana/web3.js`, which pulls in
`rpc-websockets` (LGPL-3.0-only).

| What | Where it is used | Licence | How |
| --- | --- | --- | --- |
| games.fun loot program 0.3.2 IDL (program `GVzbAquL…Tg73o`, devnet) and its client | `builder/web3/gf-web3/chain/loot-idl.js`, `loot.js`, `borsh.js`, `token2022.js` | games.fun's own (MIT) | The IDL is the `anchor build` output of the loot program 0.3.2 (`target/idl/loot.json`; the source is in `program/`), with doc comments removed. The client is ported from games.fun's own client and devnet run of the same version, and checked against them byte for byte (`tests/web3-loot.test.mjs`). The transfer-hook resolution follows the spl-transfer-hook-interface account list and is checked against `@solana/spl-token` 0.4.15 (Apache-2.0), which is not a dependency |
| Meteora Dynamic Bonding Curve IDL facts (instruction discriminators, account orders, `ConfigParameters` field order for `createConfig`, `PoolConfig`/`VirtualPool` field offsets, program version 0.2.1) | `builder/web3/gf-web3/chain/dbc.js` | MIT, per the `license` field of `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12. The npm package ships no LICENSE file. | Read from the IDL inside that SDK. The kit's builders are checked against the SDK's output through golden fixtures (`tests/web3/fixtures/chain.json`, and `dbc-config.json`, made by games.fun's launchpad with that SDK). |
| Meteora DBC curve arithmetic (`buildCurveWithMarketCap`, `buildCurve` and their helpers, the fee scheduler's minimum fee, the exact-in swap quote) | `builder/web3/gf-web3/chain/dbc-curve.js` | MIT, `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12 (author Dann Wee, MeteoraAg; the MIT text is the kit's `LICENSE` with that copyright holder) | Ported from the SDK's `dist/index.cjs` to plain BigInt for the launchpad's one curve shape. The SDK computes with decimal.js 10.6.0 (MIT) at its defaults (20 significant digits, half up); the kit reproduces that rounding in its own code and copies none of decimal.js. Fuzzed against the launchpad's `curve/params.mjs` and `launch/first-buy.mjs` on 4,096 inputs on 2026-10-12 (4,055 built, each with four first-buy quotes; 41 refused by both), with no difference, and held byte for byte by `tests/web3-dbc-config.test.mjs`. |
| Wallet Standard protocol | `builder/web3/gf-web3/wallet.js`, `builder/studio/tabs/web3/wallet.js` | Specification (wallet-standard, Apache-2.0) | Implemented from the protocol's events (`wallet-standard:register-wallet`, `wallet-standard:app-ready`). No library is used. |
| ANS-104 data items | `builder/web3/node/irys.mjs` | Specification (ArweaveTeam/arweave-standards) | Implemented from the specification. The output is checked against `@irys/bundles` 0.0.5 (Apache-2.0) through golden fixtures. That package is not a dependency. |

### Test-only (not installed with the kit)

`tests/web3/fixtures/generate.mjs` regenerates `tests/web3/fixtures/chain.json` from a separate reference install,
which is never part of the kit. That install holds `@solana/web3.js` 1.99.0 (MIT), `@solana/spl-token` 0.4.15
(Apache-2.0), `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12 (MIT), `@irys/bundles` 0.0.5 (Apache-2.0),
`bn.js` 5.2.5 (MIT) and games.fun's own loot client. The fixture file holds the outputs and public devnet account
bytes. It holds no code.

The web3 browser test (`tests/web3-studio.test.mjs`) and the devnet proof (`tests/web3/devnet/proof.mjs`) drive Chrome through
the kit's `playwright-core` (above) with an injected Wallet Standard wallet; they add no dependency.

