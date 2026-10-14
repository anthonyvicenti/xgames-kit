# What the creator approves, and what it costs (devnet)

Everything is built on the human's machine with their RPC (`gamesfun web3 settings --rpc`, default
the public devnet RPC). Their wallet signs in the studio page, which is a real Chrome page on
127.0.0.1, so wallet extensions work. The studio shows each step and what it touches before the
wallet asks.

## Launch a token (the token part of the Economy tab, or `web3_prepare_launch`)

A token launched with games.fun is one part of the game's economy (`tokens` → `source: "curve"`). When the economy
goes live, it launches first, in its own approval; the Economy tab's token part can also launch it alone. Launching
here is optional: a token launched anywhere else (pump.fun, another launchpad, the creator's own mint) is just as
welcome (`web3_link_token`, or `source: "existing"` in an economy) and works with every part.

**What games.fun earns**: 5% of the token fees of a token launched with
games.fun, nothing from a token launched elsewhere, plus the loot program's flat per-action fees (0.002 SOL when a
player signs for something of their own, 0.00001 SOL for the project's other charged calls). games.fun has no token of
its own for now.

1. **Upload the picture** to Arweave through Irys: one `signMessage`. It moves no funds and is free
   up to 100 KB. Over that, the wallet first approves a small SOL deposit to its Irys balance.
2. **Upload the token details** (name, symbol, description, image): one `signMessage`.
3. **The launch** (one approval): a Meteora DBC config **of the token's own** (`createConfig`), then the pool on it
   (`createPool`), paired with **SOL** by default, **USDC-dev**, or any SPL mint Meteora takes (a Token-2022 pair only
   without extensions that need a Meteora token badge). games.fun's partner wallet is the config's fee claimer and
   leftover receiver, and the split is **95 / 5**: the creator keeps 95% of the trading fees (after Meteora's own
   cut); when the token graduates, the pool's liquidity is locked 95 to the creator and 5 to games.fun. No migration
   fee, no compounding. The wallet pays the config's rent and becomes the pool creator; a fresh config address and a
   fresh base-mint address sign too (one-time keys, in memory, then dropped). Rent and fees come to about 0.03 SOL
   (0.028 on devnet, 2026-10-12).
   One transaction when it fits, otherwise two sent in order (the config, then the pool with the buy).
   - **The curve's size**: start near a $5,000 market cap, graduation near $75,000, in the pair. Devnet has no
     market price, so SOL is sized at a **devnet reference price of $100** (`--sol-usd`, `solUsd` or the Economy tab
     to use another) and USDC-dev at $1. A pair with no price needs the creator's own start and graduation market
     caps (`--start-cap`, `--graduation-cap`, in whole pair tokens).
   - **Optional initial buy in the pair** (SOL is wrapped and unwrapped around it), in the pool's own transaction,
     so nobody buys first and it pays the minimum 1% fee instead of the anti-snipe fee. The amount out is quoted
     offline from the new curve (the launchpad's own quote, matched to the base unit), and the minimum keeps 0.5%
     slack. It must stay below the curve's graduation amount, and the wallet must hold it.
   - After it lands, the kit reads the config back from chain (fee claimer, 95, 5) before it records the token.

The name, ticker and picture are permanent.

## Put the economy live (the Economy tab's "Put it live", `economy_publish`, or the old `web3_prepare_publish`)

`economy_publish` (and `npx gamesfun economy publish`) only checks the saved spec, adds up the cost and hands over the
studio link (`#economy?flow=economy`). The creator opens the Economy tab, looks it over, and presses **Put it live**
(**Put the changes live** once it is live). A game that still has an old `shop` has it moved into its economy first,
so `web3_prepare_publish` leads to the same flow. Then:

1. **A token launched with games.fun**, when the economy has one that isn't live yet (above).
2. **Uploads**, one `signMessage` each: every new item picture, the details of every new or changed item, and the
   collection's details (the first time only). Items whose details didn't change (a price or supply change) skip this.
3. **One approval for every setup transaction** (the wallet signs them together; more than one approval only when it
   takes more than 12 transactions):
   - the first time: the Core collection (the creator's wallet is its update authority, with the royalty the spec
     says), the creator's treasury account, and `create_game` on the loot program 0.3, priced in the economy's
     currency (fixed from then on). The creator's wallet is the game's owner (settings and catalog) and, unless the
     spec names another key, its authority (payouts and decisions);
   - then every part: pools and their seeds, tokens the game mints, items, boxes, recipes, schedules, lotteries and
     stakes (a contest is opened by the authority while the game runs).
4. What lands is written to `gamesfun.json` as it lands (`economy.live`: the game, collection, treasury, each part's
   id, the signatures, and `live.published`, the spec as it is on chain). If a later transaction fails, the earlier
   ones stay recorded, and the next publish carries on. A later change sends only the difference; the checker refuses
   what the program cannot change (an open stake, a pool's token, the currency).

`economy_cost` says what going live costs before anyone signs: each account's rent, each call's fee, network fees.

## What players sign (in the game, through the page)

The page that hosts the game signs a player's moves with their wallet when they press an economy button in the kit's
menu (`buy-button.md`). A buy is two approvals (pay, then claim); a box is two (pay and roll, then claim); a ticket,
a stake, a craft, a hold or an entry is one. Each payment goes where the spec's split says, the rest to the creator's
treasury (wrapped SOL for a SOL economy; a Token-2022 coin's own transfer fee, if it has one, is kept by the token).
games.fun's loot program charges the player a flat 0.002 SOL, in SOL, for each thing they sign for themselves, on top
of the price.
