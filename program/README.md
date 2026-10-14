# program/: the loot program's source (loot 0.3.2, "Economy for Anything")

Every economy the kit puts live runs on one Solana program: games.fun's **loot program 0.3.2**, deployed on devnet at
`GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o`. 0.3.2 is a cleanup of 0.3.1, upgraded in place (no account layout
changed): each instruction checks less twice, handovers need the new key's signature, a schedule can't start in the
past, 52 KB less program (`loot/PROGRAM-0.3.md`, "0.3.2 cleanup"). 0.3.1 is 0.3 with the fixes of a full audit (no
Critical, High or Medium; its 4 Lows and the notes that needed a fix are fixed: `loot/PROGRAM-0.3.md`, "Reviews and
audit"), with the 95 / 5 registry rules: a token launched with games.fun pays it at least 5% of its fees (the launcher
keeps up to 95%), and a token launched anywhere else works with every mechanic (the registry is a record, never a
gate). The audit's fixes changed two account layouts, so 0.3.1 was deployed fresh at its own address; 0.3 stays at
`88Labq6t…KXqM`, and an economy the kit put live there goes live fresh on 0.3.1 (its old addresses are kept under
`economy.previous`). This folder is its whole Rust source, published with the kit under the kit's MIT licence. Read
`loot/PROGRAM-0.3.md` for what it does, `loot/programs/loot/src/lib.rs` first in the code (every instruction, grouped,
and the security model in its header), and `loot/COSTS.md` for what each call costs.

Nothing here is needed to make a game: the kit talks to the deployed program through its own plain JavaScript client
(`web3/gf-web3/chain/loot.js`). The source is here so anyone can read what their game's money runs on, build it, check
that the build is byte for byte what is on devnet, and run its tests. The full simulation (`gamesfun economy simulate
--full`, `web3/economy/sim/`) can run a local build of it instead of the deployed bytes.

## Where it comes from

| | |
| --- | --- |
| Source | games.fun's loot program, version 0.3.2 |
| Deployed | devnet, program `GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o`, program data `2RGLXrYCQedMHdArd8zWW9nNXhvjVuzP5nUTFwafrpvB`, platform `3ASM4DQfuvjL2J6ZXLZ9dBrF8c3kbxibutgJjy2mFkCt`; deployed fresh as 0.3.1, then upgraded in place to the 95 / 5 rules and to 0.3.2 (transaction `4GxQ3FLETVTrBFehdZK7KznbHZoo9MRaSriC1bzk7hzMhH1WGQCk3S5qKdubrg4KrwCrTw5JdbN28P7eNtAMezmh`) |
| Deployed file | 852,896 bytes, `sha256 935f850022013f0cd9766c5ab8f942dd0d2678f3a0211976e043b448542accdc`. Before it: 0.3.1 with the 95 / 5 rules, 905,320 bytes, `aaa04f48…a354`; the first 0.3.1, 905,024 bytes, `681981727f5f…8be9` |

What is here: the Cargo workspace (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `Anchor.toml`), the program
(`programs/loot/`: `src/**` and its LiteSVM tests `tests/**`), the Token-2022 transfer hook the tests build
(`test-hook/`), the devnet account snapshots the tests read (`tests/fixtures/venue/`, `tests/fixtures/v1/`: public chain
data), `scripts/fetch-fixtures.sh`, and the documents `PROGRAM-0.3.md`, `COSTS.md` and `BUILD.md` (the last is the
reproducible-build record of 0.2; the 0.3 one is below).

What is not: every key file (the program's keypair and the deployer's), `target/`, and the upstream binaries the tests
load (`tests/fixtures/*.so`, `queue.json`), which `scripts/fetch-fixtures.sh` dumps from devnet. `Anchor.toml`'s
`wallet` names Solana's default (`~/.config/solana/id.json`); it does not touch the build. Nothing in this folder deploys
anything.

## Build it and check it against devnet

The toolchain: Rust 1.89.0 (`rust-toolchain.toml`), the Solana CLI 3.1.10 (its `cargo-build-sbf`, platform-tools v1.52),
optionally anchor-cli 1.1.2 (`anchor build` runs the same `cargo-build-sbf`) and `solana-verify` 0.5.2.

```bash
cd program/loot
cargo build-sbf --manifest-path programs/loot/Cargo.toml --sbf-out-dir target/deploy
sha256sum target/deploy/loot.so
# 935f850022013f0cd9766c5ab8f942dd0d2678f3a0211976e043b448542accdc  (the deployed file)

# The same comparison with the chain itself (it ignores the zero padding behind the program in its account):
solana-verify get-executable-hash target/deploy/loot.so
solana-verify get-program-hash -u devnet GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o
# both: 0705303b6c3e0befad47208c60af75acf697590c93e89e8fd5348f2661bb4977
```

**Result (0.3.2, this folder, Linux x86-64):** `cargo build-sbf` (cargo-build-sbf 3.1.10, platform-tools v1.52, rustc
1.89.0) built `loot.so` (852,896 bytes) in 43 s; its sha256 is `935f8500…ccdc`, the deployed file's (`anchor build` of
the same source gives the same file), and `solana-verify
get-executable-hash` of the deployed file equals `get-program-hash` of the devnet program (`0705303b…4977`). The Docker
build (`solana-verify build --library-name loot --base-image solanafoundation/solana-verifiable-build:3.1.10`, see
`BUILD.md`) was not run for 0.3, 0.3.1 or 0.3.2; for 0.2 it gave the same file as the plain build.

To let the full simulation use your build instead of the deployed bytes: `gamesfun economy simulate --full
--program program/loot/target/deploy/loot.so` (it says so in its report, and says whether the build matches devnet).

## Run its tests

```bash
cd program/loot
scripts/fetch-fixtures.sh          # once: Metaplex Core, MagicBlock's VRF and its queue from devnet (read-only)
cargo test
```

**Result (0.3.2, with the fixtures `scripts/fetch-fixtures.sh` dumped):** 295 tests pass, 0 fail. The tests are grouped by feature (orders, boxes, payments, pools, collectibles, stake,
contest, lottery, craft, hold, schedule, platform, registry, token_2022, costs).

The tests run the program in LiteSVM with the real Metaplex Core and MagicBlock VRF programs. The VRF oracle cannot run
there, so the tests send its callback themselves with the program's VRF identity as signer (signature checks off), the
same way the full simulation does.

## Licences

- This source: MIT, under the kit's `LICENSE` (games.fun's own code, same owner as the kit).
- Its dependencies keep their own licences (`THIRD_PARTY.md`, "The loot program's source"): anchor-lang and anchor-spl
  1.1.2 (Apache-2.0), MagicBlock's ephemeral-rollups-sdk and ephemeral-vrf-sdk 0.17.2 (MIT), solana-sha256-hasher 3.1.0
  (Apache-2.0); for the tests only: litesvm 0.10.0 (Apache-2.0), mpl-core 0.12.1 (the Metaplex NFT Open Source License),
  the solana-* crates and spl-token-2022-interface (Apache-2.0), borsh (MIT or Apache-2.0).
- Not in this folder: the Metaplex Core and MagicBlock VRF **programs** the tests and the full simulation load are
  dumped from devnet onto your own machine, never committed. MagicBlock's VRF program is under the Business Source
  License 1.1 (non-production use allowed; MIT from 2029-12-01); Metaplex Core under the Metaplex NFT Open Source License.
