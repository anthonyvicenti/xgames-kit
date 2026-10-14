# Licensing, in plain words

This page is for a person who makes games with the kit. It is a guide, not legal advice, and no lawyer has read it yet.
The facts it relies on are in [LICENSE](../LICENSE), [THIRD_PARTY.md](../THIRD_PARTY.md) and [CREDITS.md](../CREDITS.md).

## What MIT lets you do

The kit is under the MIT licence (the text is in [LICENSE](../LICENSE); the copyright line reads "games.fun"). That means
you may:

- use it for anything, for free or for money;
- change it, copy it and give it to others, in whole or in part;
- make games with it and keep, sell or give away those games, with no fee and no share to us;
- fork it and run your own version.

The one condition: **keep the copyright notice and the licence text** with any copy of the kit's code you pass on. The
kit's code sits inside every game `create` makes (the `gf/` and `audio/` folders), so a game you publish carries that
code. Leave those licence files where they are.

There is no warranty. MIT says the software comes "as is".

## What comes along from other people

The kit includes work by others, each under its own licence. The full list, file by file, is
[THIRD_PARTY.md](../THIRD_PARTY.md). In short:

| Piece | Licence | What it asks of you |
|---|---|---|
| three.js, Rapier (physics), the Draco and Basis decoders | MIT, Apache-2.0 | Keep the licence files beside the code. `create` puts them in your game's `vendor/` folder; do not delete them. |
| pmndrs postprocessing (Zlib), N8AO (CC0 text) | Zlib, CC0 | Zlib: keep the notice and do not claim you wrote it. |
| ecctrl, folio-2025, the melee model, ZzFX | MIT | Keep the licence files that `create` puts beside them. |
| The vista engine's core (Tidewater, by DRG Software Solutions LLC), the six Rocketbox people (Microsoft) | MIT | Keep `gf/vista/core/LICENSE` and `ATTRIBUTION.md` in a vista game. Microsoft's MIT text for the Rocketbox people travels in `gf/vista/core/public/models/characters/LICENSE-Rocketbox.md`, and the game's `ATTRIBUTION.md` lists each body. The kit leaves out the core's volumetric sky-pro-webgpu clouds (their notice names a separate licence), so a vista game made here draws the core's own MIT clouds. |
| The vista core's sounds (Freesound recordists) and debris and stall props (Poly Haven) | CC0 | Nothing. Each is credited in the core's `CREDITS.md` files anyway. |
| The forge engine's core (our own Rust, MIT) and the crates compiled into its two wasm builds | MIT, Apache-2.0, BSD, Zlib | Keep `gf/forge/wasm/LICENSES.md` and `gf/forge/wasm-webgl2/LICENSES.md` in a forge game (every crate, its version and licence text). No Rust toolchain is needed: the builds are prebuilt; the source is in `runtimes/forge/core` for reading. |
| The forge HUD's two fonts (subsets of Grenze Gotisch and Grenze) | SIL OFL 1.1 | Keep each font's licence text beside it (`create` copies them into `assets/fonts/`); do not sell the fonts by themselves. |
| The forge library's art and sounds (KayKit, Quaternius, Kenney, OpenGameArt, Poly Haven, games.fun) | CC0 | Nothing. The game's `ATTRIBUTION.md` lists each file anyway. The forge library's Meshy-made models are not in this kit: a forge game made here draws CC0 stand-ins in their place (THIRD_PARTY.md, art rows A10 and A11). |
| The three.js voxel example (voxel worlds) | BSD-3-Clause | Keep its notice. (The kit has a gap here; see below.) |
| Art by Kenney, Quaternius, Kay Lousberg (KayKit), Poly Haven, games.fun | CC0 | Nothing. Credit is kind but not required. |
| Ten props by Poly Pizza creators | **CC BY 3.0** | **Credit the author, the title and a link, and say you changed it.** The exact lines are in [CREDITS.md](../CREDITS.md). If you keep one of these files in your game, keep its credit. If you swap the file for your own, you may drop the credit. |
| The tools' npm dependencies | MIT, ISC, BSD, Apache-2.0 | They stay on your computer; they are not part of your game. |
| The loot program's Rust source (`program/`) | MIT (games.fun's own); its crates Apache-2.0 and MIT, its tests also use Metaplex Core's crate (Metaplex NFT Open Source License) | Nothing for your game: it runs on chain, your game does not carry it. |
| The full economy simulation's LiteSVM (installed on first use into your cache folder) and the Metaplex and MagicBlock programs it reads from devnet | MIT; Metaplex NFT Open Source License; MagicBlock's VRF under the Business Source License 1.1 (non-production use allowed) | Nothing: they stay in your cache folder, for simulating on your own machine. |

Your own game (your `rules.js`, `config/`, your own art and sounds) is yours. You choose its licence. What you did not
write inside it (the kit and the library art) keeps the terms above.

If you add files of your own (a model, a picture, a sound), put their source and licence in your game's
`ATTRIBUTION.md`, and use only files you made or that carry a licence that lets you ship them.

### Optional: Meshy

If you use the `meshy` command, you use your own Meshy key and plan. Meshy's terms, not ours, say what you may do with
what it makes. The kit does not ship Meshy output.

## Names

**DRAFT. Not reviewed by a lawyer. Proposed wording for the creator to decide.**

The MIT licence covers the code. It does not give anyone the right to use the name "games.fun" or the
games.fun logo, which belong to their owner. You may say, in plain words, that your game or fork "is made with the
games.fun kit" or "is a fork of the games.fun kit". Please do not name a product so that it could be mistaken for ours
or looks endorsed by us, and do not use our logo. A fork should pick its own name.

The kit works with coding agents. In plain text we may say it "runs with Claude Code or Codex". Those names and logos
belong to Anthropic and OpenAI. They are not part of this project's name or look, and nothing here is made, approved or
endorsed by them.

## The hosted Creator Studio

The games.fun website and its hosted Creator Studio (accounts, publishing, the shared play host) are a separate, private
service run by games.fun. They are not in this repository and MIT does not cover them. Its terms are its own. This kit
runs entirely on your computer and does not need that service.

## Gaps to fix in the kit

These are gaps found in a licence audit of the kit. Each is a change in `builder/tools/create.mjs` (and where noted,
the library), made here.

1. **A created game should carry the kit's licence.** Write the kit's MIT text into the game as `LICENSE-gamesfun-kit`
   (or a `gf/LICENSE`) beside `gf/` and `audio/`, with a line that `gf/`, `audio/` and `gf/gf-assets.js` are MIT,
   Copyright (c) 2026 games.fun (or whatever name the owner picks for the copyright line). Today only the third-party
   parts carry a licence file; games.fun's own code has a header ("MIT") in `gf/mp/` and nothing beside `gf/three/`.
2. **A created game should carry the full CC-BY credit.** In `attribution(spec, record)` (`create.mjs`, the Art table),
   when a record's `spdx` is `CC-BY-*`, print the record's `credit` line (it already holds author, title, link and
   licence) and a link to the licence, and add "changed: resized, recentred and compressed" from `modified`.
   Add a short "Credits" paragraph to the game's `ATTRIBUTION.md` listing those lines.
3. **Show credit lines to players.** A CC-BY prop in a published game needs its credit visible somewhere a player can
   find it. Suggest the kit's home menu "How to play" / settings panel list the game's CC-BY lines from `assets.json`
   (CONTRACT section 6g). Until then a maker must add them by hand.
4. **Ship `LICENSE-three-voxel`.** `kit/world/voxel/grid.mjs` says the BSD-3-Clause text is "beside this file" as
   `LICENSE-three-voxel`; the file is not in `worlds/voxel/`. Add it (the
   threejsfundamentals BSD-3-Clause text) and have `create` copy it into voxel games.
5. **Full texts for Draco, Basis, ktx-parse and zstddec**, or a statement of where their licences are (see
   THIRD_PARTY.md, "Needs a person").
6. **N8AO label.** `runtimes/three/kit/THIRD_PARTY.md` and `runtimes/three/README.md` say MIT; the vendored `LICENSE` is CC0.
   Make them agree.
7. The Meshy gecko's record and file are out of the kit; its credit line (CREDITS.md) goes with it if it is ever shipped.

## Decisions for the creator

- The name on the copyright line (placeholder: "games.fun").
- Whether the name policy above is what you want, then a lawyer's read of it.
- Whether to keep the ten CC-BY props (decided 2026-10-11: keep, think later) or swap them for CC0 art.
