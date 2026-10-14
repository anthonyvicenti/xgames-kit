# loot 0.2: a build anyone can repeat, and what is on devnet

**Result (2026-10-11 UTC): the hashes match.** The program deployed on devnet is byte for byte what this source builds, in Docker and outside it.

| | Hash |
| --- | --- |
| `solana-verify get-executable-hash target/deploy/loot.so` (the Docker build) | `994b9b33312e75990aa2f8edc28218b9d25bbdbe9bcbafada74091996cb3bf27` |
| `solana-verify get-program-hash -u devnet FWVap91DnGRU2bid8PZwazZmFfWwJomyeTMKqYsSf53D` | `994b9b33312e75990aa2f8edc28218b9d25bbdbe9bcbafada74091996cb3bf27` |
| `sha256sum target/deploy/loot.so` (505,136 bytes) | `a6a91ca15251597b7ac91fb0eab99d056a6e8dd4a69f227f041d98a059e8febd` |

The executable hash ignores the zero padding behind the program in its on-chain account (the account still holds the 591,512 bytes of 0.1; the upgradeable loader does not shrink it), so it is the one to compare. The `sha256sum` is of the file.

- **Source:** loot 0.2 (`Cargo.lock` committed). This folder now holds 0.3.2; `program/README.md` has its build and check.
- **Deployed:** devnet, program `FWVap91DnGRU2bid8PZwazZmFfWwJomyeTMKqYsSf53D`, slot 509754232, transaction `3Mt67hNczBGVsumVJ6aroVJr6yDnk2Gxd2qheDRKQfnEaRrM8PTjmGvokRWqzUdBDUmS2DTEvFmTtE4mE1FgZUVp`.
- **What was deployed is the file a plain `anchor build` wrote.** The Docker build was run first, on the same source, and produced the identical file (same `sha256sum`), so either is the artifact.

## Toolchain

| | Version |
| --- | --- |
| `solana-verify` | 0.5.2 (`cargo install solana-verify --locked`) |
| Docker | 29.1.3 |
| Build image | `solanafoundation/solana-verifiable-build:3.1.10` (digest `sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3`) |
| Inside it, and on the host | `cargo-build-sbf` 3.1.10, platform-tools v1.52, rustc 1.89.0 |
| Host only | anchor-cli 1.1.2, solana-cli 3.1.10; `rust-toolchain.toml` pins 1.89.0 |

## Commands

```bash
cd program/loot

# 1. The verifiable build (Docker). The image must be named: left to itself, solana-verify 0.5.2 picks the 2.3.0
#    image, whose cargo (1.84) cannot build this dependency tree ("feature `edition2024` is required").
solana-verify build --library-name loot --base-image solanafoundation/solana-verifiable-build:3.1.10

# 2. Its hash, and the hash of what is on chain.
solana-verify get-executable-hash target/deploy/loot.so
solana-verify get-program-hash -u devnet FWVap91DnGRU2bid8PZwazZmFfWwJomyeTMKqYsSf53D

# 3. Optional: the plain build gives the same file.
anchor build && sha256sum target/deploy/loot.so
```

Docker writes `target/` as root. To build outside Docker again afterwards, give the files back to yourself:

```bash
docker run --rm -v "$PWD/target:/t" --entrypoint chown solanafoundation/solana-verifiable-build:3.1.10 -R "$(id -u):$(id -g)" /t
```

## Not done

- **No public verification record yet.** `solana-verify verify-from-repo` and the on-chain verification PDA need the source in a public repository; until one is made, the proof is the three commands above.
- **Mainnet:** nothing is deployed there.
- The image tag `3.1.10` could be re-pointed by its publisher; the digest above is the one used.
