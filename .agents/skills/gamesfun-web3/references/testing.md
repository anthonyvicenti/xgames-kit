# Testing web3 in a game

## What verify checks in the game

The game's side is the kit's: `gamesfun verify` check 22 frames the game in a stand-in page (a test wallet, two
items, then one economy action per place) and clicks through the wallet, Wear and every economy button for real
(`buy-button.md`, "Checking it"). Nothing in `rules.js` needs testing for web3, because nothing there is web3. Run
`npx gamesfun verify games/<name>` after changing the economy or an item's look; check 5's loadout leg has to pass too.

The economy itself is checked before it reaches a game: `economy_check`, `economy_simulate` and `economy_cost`
(the `gamesfun-economy` skill).

## The gf-web3 mock (the page side, and older games)

gf-web3 is what the page runs to sign (and what an older game's own code calls). `gfWeb3.mock` is `true` and nothing touches the network when:

- the page is automated or headless (`navigator.webdriver`, HeadlessChrome), so **`gamesfun verify`
  stays deterministic**;
- the URL has `?gamesfun_mock=1`.

In the mock:

- `connect()` returns a pretend address and `signIn()` a pretend signature.
- `shop.list()` and `boxes()` come from the real `gamesfun.json`.
- `shop.buy()` and `openBox()` succeed at once. Box rolls use the box's weights with seeded
  randomness, so the same run gives the same rolls.
- `?gamesfun_owned=1,2` (item ids or names) gives the pretend wallet items to start with, so you can
  check that `wearOwned()` changes the player and that every other player sees it.
- What the mock buys or opens is owned until the page reloads.

Every `gfWeb3.economy.*` call answers at once in the mock with `{ mock: true, says }`. Use it to check a page's
side, or an older game whose `rules.js` calls gf-web3: that the looks apply, errors show, and the game still runs for
a guest who never connects.

## A real wallet on devnet

The human does this part. You can't approve a wallet prompt, and you must never ask for a key.

1. Run `npx gamesfun dev games/<name>`. It opens the studio in the human's own Chrome profile, where their
   wallet extension is. The game is at `/game/`. A normal Chrome window is not automated, so the mock is off.
   In an automated browser, add `?gamesfun_mock=0`.
2. Ask them to switch the wallet (Phantom, Solflare, Backpack…) to **devnet** and get devnet SOL
   (https://faucet.solana.com).
3. Have them press the economy's buttons in the game's menu, where a page offers them (the studio's preview, whose
   side of `gf:host` is being built), approving each in the wallet. Then check the result
   with `npx gamesfun economy status games/<name>` (each part on chain, the pools, the recent receipts).

## Limits of the public devnet RPC

Players read through `https://api.devnet.solana.com`. It rate-limits (about 100 requests per 10 s
per IP, 40 per method) and has no DAS API. `ownedItems()` makes one filtered `getProgramAccounts`
call over the collection's Core assets. Call it on connect and after a purchase, never every frame.
A game may set a public, **keyless** RPC with `gfWeb3.configure({ rpc })`. A keyed URL is refused,
because every player could read it.
