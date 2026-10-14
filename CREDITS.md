# Credits

The kit stands on other people's work. This page thanks them and gives the credit that some of their licences require.
The full, file-by-file list with licences is [THIRD_PARTY.md](THIRD_PARTY.md); how the licences work for you is in
[docs/LICENSING.md](docs/LICENSING.md).

## Art that asks for credit (CC BY 3.0)

Ten props from [Poly Pizza](https://poly.pizza), made by the people below and shared under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). They were resized to metres,
recentred, joined per material and compressed for the kit (changes, as the licence asks us to say). **A game that keeps
one of these files must keep its credit line.**

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

## Art that asks for credit (CC BY 4.0)

Two cartoon explosion flipbooks (pack `quiver-outpost-fx`) from Quiver's Outpost Assault tower-defence tutorial, shared
under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/); the colour table was flattened to
RGBA for the kit. **A game that keeps one of them must keep this line:**

- Explosion art from Quiver's Outpost Assault (github.com/quiver-dev/tower-defense-tutorial), CC BY 4.0

### An eleventh record: the Meshy gecko (not shipped)

games.fun's library has a "Cyborg gecko" body generated with Meshy, recorded as CC BY 4.0 with Meshy AI credited because
the plan it was made on is unconfirmed. Its file and its record are not in this kit, so no game made here
carries it. If it is ever shipped, the credit line is:

- "Cyborg gecko (Meshy)" by Meshy AI (generated for games.fun), CC BY 4.0 (https://www.meshy.ai)

## Art and sound given freely (CC0, credit not required, given anyway)

- [Kenney](https://kenney.nl): 139 props and 28 textures (CC0), and every model of five of his kits as the `kenney-*-full`
  packs (nature, platformer, survival, toy car, fantasy town: 840 models) and the 80 sprites of his Particle Pack (CC0).
- [Quaternius](https://quaternius.com): character bodies and the Universal Animation Library clips and mannequin (CC0).
- [Kay Lousberg, KayKit](https://kaylousberg.com): the dungeon props, weapons and character bodies of the scenic
  library (CC0).
- [Poly Haven](https://polyhaven.com): the stand-in ground texture, `leafy_grass` (CC0), and the vista core's scanned
  beach debris, stall props and wood and iron textures (CC0).
- [Freesound](https://freesound.org) recordists: the vista core's 42 field recordings (CC0), each credited with its
  author and link in `runtimes/vista/core/public/audio/CREDITS.md`.
- The forge library's sounds from [OpenGameArt](https://opengameart.org) and [Kenney](https://kenney.nl) (CC0), each with
  its author in its manifest in `library/packs/forge-sounds/` (Zane, rubberduck, artisticdude, thebardofblasphemy,
  congusbongus and others), and its Poly Haven textures by Rob Tuytel and Dimitrios Savva (CC0).
- games.fun: the bean bodies and the procedural textures, the forge engine's town street and pieces made from code, and
  the six weapon icons of its artillery game Crumble Cove (pack `xk-artillery-icons`) (CC0).

## Code and art under MIT and other permissive licences

- [three.js](https://threejs.org) (MIT) and the Draco and Basis Universal decoders it ships (Apache-2.0), including the
  meshoptimizer decoder (Arseny Kapoulkine, MIT), fflate (MIT), ktx-parse and zstddec.
- [Rapier](https://rapier.rs) by Dimforge (Apache-2.0), the physics.
- [pmndrs](https://github.com/pmndrs): postprocessing (Zlib), and ecctrl by Erdong Chen (MIT), whose floating-capsule
  character logic is ported here.
- N8AO (ambient occlusion; its licence text in the repository is CC0).
- [folio-2025](https://github.com/brunosimon/folio-2025) by Bruno Simon (MIT): the scenic engine's rendering, materials,
  lighting, terrain and vegetation are ported from it, and some of its models and textures are scenic props.
- [Tidewater](https://github.com/dgreenheck/tidewater) by Dan Greenheck, DRG Software Solutions LLC (MIT): the vista
  engine's core (its WebGPU renderer, ocean, sky, clouds, island, wildlife and fishing), vendored with games.fun's
  edits; its humpback whale model is the author's own. The kit carries the core's own MIT clouds, not the volumetric
  ones from the author's sky-pro-webgpu.
- The forge core's Rust crates (wgpu, naga, rapier3d, hecs, glam, gltf, wasm-bindgen and the rest; MIT, Apache-2.0,
  BSD, Zlib), each with its version and licence text in `gf/forge/wasm/LICENSES.md` of every forge game.
- [Bangers](https://github.com/googlefonts/bangers) by Vernon Adams and [Bungee](https://github.com/djrrb/Bungee) by
  David Jonathan Ross (SIL Open Font License 1.1), the comic and signage display faces (packs `ofl-bangers`,
  `ofl-bungee`).
- The forge HUD's fonts: subsets of [Grenze Gotisch](https://github.com/Omnibus-Type/Grenze-Gotisch) and
  [Grenze](https://github.com/Omnibus-Type/Grenze) by Omnibus-Type (SIL Open Font License 1.1), renamed GF Grim Display
  and GF Grim Text.
- [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) (MIT): the six people friends see each other as
  in a vista game, and the vista core's two stall keepers.
- [BUDDY: ROLLBACK](https://github.com/octobooth-4/buddy-rollback) by its contributors (MIT): the combat model of the
  melee mechanic.
- The three.js voxel example by Google Inc. and threejsfundamentals (BSD-3-Clause), adapted into the voxel world.
- [Divine Voxel Engine](https://github.com/Divine-Star-Software/DivineVoxelEngine) by Divine Star LLC (MIT): the voxel
  world's sunlight and coloured block light, its smooth per-vertex light and its terrain ideas follow DVE's techniques.
- [ZzFX](https://github.com/KilledByAPixel/ZzFX) by Frank Force (MIT), the sound engine inside gf-audio.
- [ws](https://github.com/websockets/ws) (MIT), for the local signaling server.
- The npm packages the tools use (the Model Context Protocol SDK, Playwright) and their dependencies, all permissive;
  see THIRD_PARTY.md.
- The loot program's source (`program/`) stands on [Anchor](https://github.com/solana-foundation/anchor) (Apache-2.0),
  [MagicBlock](https://github.com/magicblock-labs)'s ephemeral rollups and VRF SDKs (MIT) and the Solana and SPL crates
  (Apache-2.0); its tests on [LiteSVM](https://github.com/LiteSVM/litesvm) (Apache-2.0) and
  [Metaplex Core](https://github.com/metaplex-foundation/mpl-core) (Metaplex NFT Open Source License).
- The full economy simulation runs the program in LiteSVM's npm package (MIT), installed on first use into the user's
  cache folder, with Metaplex Core and Token Metadata and MagicBlock's VRF program as deployed on devnet.

## How a game made with the kit carries these credits

If your game keeps a credited file, it must keep the credit. Today:

- `create` writes an `ATTRIBUTION.md` into every game, listing each library file the game uses with its licence and
  author, and each code library with where its licence text sits. The licence texts of three.js, Rapier,
  postprocessing, N8AO, ecctrl, the melee model, folio-2025 (scenic), Tidewater (vista, `gf/vista/core/LICENSE` and
  `ATTRIBUTION.md`) and ZzFX are copied into the game beside the code.
- **That `ATTRIBUTION.md` is not yet enough for CC BY.** For a CC-BY file it prints only the licence name and the
  author ("CC-BY-3.0, J-Toastie"). The licence also asks for the title and a link to the work, and a link to the
  licence. The exact lines are in the library's `LICENSES.json` (`credit`), but `create` does not copy them.
- Nothing shows a credit to a *player* either; a game published with a CC-BY prop should show its credit lines somewhere
  a player can find them (a credits screen, the page, or the post). The kit has no credits screen yet.
- The kit's own MIT licence text is not copied into games next to the `gf/` code (see below).

These are gaps in `create`, which is written in games.fun. The request to games.fun is in
[docs/LICENSING.md](docs/LICENSING.md), section "Requests to games.fun".

If you ship your game, keep `ATTRIBUTION.md` with it, and add the credit lines above for any CC-BY file you kept.
