#!/usr/bin/env bash
# Dumps what the LiteSVM tests load from devnet. Read-only RPC; nothing is signed or sent.
#
#   scripts/fetch-fixtures.sh          upstream programs and the VRF oracle queue (not committed:
#                                      upstream binaries). Needed once before `cargo test`.
#   scripts/fetch-fixtures.sh venue    re-reads the venue accounts under tests/fixtures/venue/.
#                                      Those snapshots ARE committed (public chain data, a few
#                                      hundred bytes each), because the tests assert on their exact
#                                      contents and a devnet coin can change (the "before fee
#                                      sharing" coin belongs to someone else). Only re-run this to
#                                      prove the offsets against fresh bytes; review the diff.
#
#   scripts/fetch-fixtures.sh v1       re-reads accounts the 0.1 program wrote on devnet (the
#                                      platform, the e2e game, its items and box, and what a
#                                      sale in that game touches) under tests/fixtures/v1/. Also
#                                      committed: the 0.2 JS client tests in client/ read them.
#
# The RPC URL comes from LAUNCHPAD_RPC_URL (or the git-ignored launchpad/.env), else public devnet.
# It is never printed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
url="${LAUNCHPAD_RPC_URL:-}"
if [ -z "$url" ] && [ -f "$root/../.env" ]; then
  url="$(sed -n 's/^LAUNCHPAD_RPC_URL=//p' "$root/../.env" | head -n 1)"
fi
url="${url:-https://api.devnet.solana.com}"
case "$url" in *mainnet*) echo "refusing a mainnet RPC URL" >&2; exit 1 ;; esac

account() { # <address> <file>
  solana account "$1" --url "$url" --output json-compact > "$2" 2>/dev/null \
    || { echo "could not read $1" >&2; rm -f "$2"; exit 1; }
}

if [ "${1:-}" = "venue" ]; then
  dir="$root/tests/fixtures/venue"
  mkdir -p "$dir"
  # Meteora DBC, a games.fun launch on its own config (fee claimer = partner, 50/50). Official.
  account CByZZSCZUvNFniTx7FkMCTW51RB6nHTctpUMxdsvv4EJ "$dir/meteora-official-pool.json"
  account GDxXUcbUH6EFCwtSkLJaQnS3GU5Ln2kT98CShUodN27v "$dir/meteora-official-config.json"
  # Meteora DBC, fee claimer = partner but the creator takes 100% of the trading fee. Not official.
  account 97Ybxi7AJLWwXDducShNi7RfGGW1UFDmFCfDotk1fxwP "$dir/meteora-creator100-pool.json"
  account 7Ei6a7PwsTFVtxJsn4B5U3wbKVo9scsjgKS1N4G1ooYK "$dir/meteora-creator100-config.json"
  # pump.fun coin FYAtGGoi... after preparePumpFeeShare (creator 5000 / partner 5000, final).
  account HQXB3a5XebbEjMqBGur6tJ1EFSZnn9XBL1Qb6dFhKGEp "$dir/pump-shared-curve.json"
  account ADuh9L5KfRt5Yz9G31PfGrjd6nq7JfDF8fRVY1mEiveF "$dir/pump-shared-sharing.json"
  # pump.fun coin H7WMLJ1T... (a stranger's) with only its create transaction: no sharing config.
  account Ggc8GpGjsxz2d3Gb3cSDofe1ozDGmQQBXQLCgA3e99Xk "$dir/pump-unshared-curve.json"
  # A plain SPL mint with no venue at all.
  account FNdYk3az9KtB1GaRWq6yRtoCmS79bqYhpDKdt1xyexvq "$dir/plain-mint.json"
  echo "venue fixtures written to tests/fixtures/venue"
  exit 0
fi

if [ "${1:-}" = "v1" ]; then
  dir="$root/tests/fixtures/v1"
  mkdir -p "$dir"
  account gHfGU4UmCEHmQ94rvVdygNUD3XpMnbjEvcfMU18KzY4 "$dir/platform.json"
  account 8ZEuFCLj9jLFUGFoJCvL4ZrH4185JKBTSv94Rcta5Dvq "$dir/game.json"
  account DFU6tcxRXafcqxQnNk5bEzUy1kJnSqEwZtTp2HE2bY8i "$dir/item-1.json" # Gecko Crown, collectible
  account CYcdeKa65kXq4oSfd3R3w2mNNtiCDhEK8qz2WSjcrZus "$dir/item-2.json" # Iron Sword, normal
  account 3hoXTDLSEgXG6CAqC6MMGw6rQmkbtpW8XDX97Yeiwktp "$dir/item-3.json" # Founder Badge, soulbound, in the shop
  account B33js5SXdjRHA4UNbPJvxeTTGy6gh5ipnh1euxNgbdZJ "$dir/box.json"
  # The game's Core collection, shop mint and treasury (not ours to lay out; a sale needs them).
  account BT3Po8rB7Deq7HxWkFNbXQmc3mnBPfij7M89UEfuKGLx "$dir/collection.json"
  account 6QxRNRyEx17WKCmUJBz4Lxup66rjF3qm3sxhPUc2BFo6 "$dir/mint.json"
  account FqSTnzNa3jEPJG8Sp9CWymMtgdWV8QeMMqw7JaJNB9YC "$dir/treasury.json"
  echo "0.1 account fixtures written to tests/fixtures/v1"
  exit 0
fi

cd "$root/tests/fixtures"
solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so --url "$url" >/dev/null
solana program dump Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz vrf.so --url "$url" >/dev/null
account Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh queue.json
# The transfer hook the Token-2022 tests use: built here from test-hook/, never deployed.
cargo build-sbf --manifest-path "$root/test-hook/Cargo.toml" --sbf-out-dir "$root/tests/fixtures" >/dev/null
echo "fixtures written to tests/fixtures"
