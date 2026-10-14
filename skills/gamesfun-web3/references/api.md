# gf-web3 API (`gf/web3/index.js`, version 2.1.0): the page's side

**A game's own code never calls this.** gf-web3 is what the page that hosts a game runs: it connects the player's
wallet and signs their moves when they press an economy button the kit drew (gf-three CONTRACT §6g W2:
`gf:econ-action` → `gfWeb3.economy.act(id)` → a new `gf:economy`). The agent that builds a game writes no wallet or
economy code (`buy-button.md`). Read this to build or debug a page, or to read an older game whose `rules.js` already
imports it.

```js
import gfWeb3 from './gf/web3/index.js';   // in the page (create keeps a game's gf/web3/ copy current)
```

| Call | Returns | Notes |
| --- | --- | --- |
| `ready()` | the cleaned `gamesfun.json` | Reads `./gamesfun.json` once. Never throws: a missing or bad file gives an empty setup. |
| `mock`, `address`, `config`, `VERSION` | getters | `address` is null for a guest |
| `connect()` | the player's address | Opens the wallet picker when there are several wallets. Throws "No Solana wallet found…" or "No wallet chosen." |
| `disconnect()` | | |
| `signIn({ statement? })` | `{ address, message, signature, mock }` | A Sign In With Solana message signed with `signMessage`. This is client-side proof only. Nothing verifies it on a server yet. |
| `ownedItems()` | `[{ id, name, description, rarity, look, image, serial, asset }]` | This game's collection only. `[]` for a guest. |
| `owns(idOrName)` | boolean | |
| `shop.list()` | `[{ id, key, name, description, rarity, look, image, price, priceText, currency, forSale }]` | The economy's active items. `price` is in base units. `forSale` is false for items only in boxes and recipes. |
| `shop.buy(idKeyOrName, { onStatus })` | `{ item, asset, order, signatures, mock }` | Two approvals (pay, then claim) |
| `boxes()` | `[{ id, name, price, priceText, odds: [{ id, item, chance }] }]` | `chance` is 0–1 |
| `openBox(idOrKey, { onStatus })` | `{ item, asset, outcome, order, signatures, mock }` | Two approvals (pay and roll, then claim). A failed roll throws after the refund. |
| `orders()` | `[{ order, status, outcome, … }]` | The player's orders in this game that have not ended (a claim not approved yet, a slow roll) |
| `finish(order)` | `{ settled, item }` or `{ refunded }` | Claims a rolled order, or refunds one the program lets go back (a failed roll at once, no roll after about 10 minutes, unclaimed after 7 days) |
| `token()` | `{ mint, name, symbol, decimals, source, … }` or null | |
| `loadout(items)` | `{ loadout, worn }` | Pure. One item per slot. |
| `wear(items?)` | `{ loadout, worn }` | Sets `window.__GF_LOADOUT` (gf-three applies it). Remembered per game and wallet. |
| `wearOwned()` | `{ loadout, worn }` | The remembered choice, else every owned item (the rarest wins a slot) |
| `on(event, fn)` | an unsubscribe function | Events: `wallet` (address or null), `items` (a new item), `status` (text for the player), `loadout` |
| `configure({ rpc?, config?, mock? })` | | `rpc` must be keyless https |

| `economy.*` | see below | One call per thing a player signs, the reads, `act(id)` and `state()` |

## The economy (`gfWeb3.economy`)

Every call reads the `economy` section of `gamesfun.json` and names parts by their **key** (never an address). A game
that still has an old `shop` and no economy reads as the economy that shop stands for (the same parts
the Economy tab saves; a shop gf-web3 2.0.0 put live on loot 0.3 stays live). Each call checks the player
can pay before the wallet opens, guards the price (the spec's price, or the price shown when it rises; pass
`maxPrice` in whole units to agree to more), resolves every account (split targets, a holder's account, a recipe's
lines, a Token-2022 coin's Memo program and hook accounts) and throws in a player's words ("You need 0.058 SOL more.",
"This round of “Weekly draw” closed; the draw is due now…", "Your Mare is resting: ready again in 29 days.").

| Call | Approvals | Returns (all with `signatures`, `says`) |
| --- | --- | --- |
| `buy(itemKey, { maxPrice })` | 2: pay, then claim (a normal item: 1, the game delivers) | `{ order, asset, outcome }` |
| `openBox(boxKey, { maxPrice })` | 2: pay and roll, then claim the item or prize | `{ order, outcome: { kind: item\|prize\|nothing\|burn, … } }` |
| `pay(paymentKey, { reference })` | 1 | `{ reference }` (32 bytes, random when left out: the receipt names it) |
| `craft(recipeKey, { times })` | 1 (a new collectible's key signs too, made with WebCrypto Ed25519) | `{ outcome: { made, used } }` |
| `buyTickets(lotteryKey, { count = 1, maxPrice })` | 1 | `{ tickets }` (the player's tickets this round) |
| `stake(stakeKey, { amount = 'all' })`, `unstake(stakeKey, { amount = 'all', forfeit = false })` | 1 | `{ units }`; `amount` in whole units; `forfeit` takes the stake out without its rewards, for when they can't be paid (a frozen rewards account) |
| `hold(holdKey, { asset })` | 1 | `{ asset, freeAt }` (the spec's `for`) |
| `enter(contestKey, { side, amount })` | 1 | `{ side, units }`; `side` is a number or a side name |
| `claim(partOrActionId)` | 1 or more | a lottery: starts the draw when due, then pays every place; a stake: collects rewards; a contest: winnings or refund; a hold: brings home what is due; a box or item: finishes open orders |
| `finish(order)` | 1 | `{ settled, outcome }` or `{ refunded }` |
| `act(id, answers)` | as the call | performs an entry of `actions()` from its id alone, with the player's `{ count }` or `{ amount }` |

Reads: `actions()` (playerActions: `[{ id, part, kind, label, price?, says, where, asks? }]`), `state()` (economyState:
`{ player, live, balances, pools, tickets, stakes, contests, holds, claimable }`), `reads()` (what state is made of),
`pools()`, `boxOdds(boxKey)` (as the program rolls them now), `lottery(key)`, `stakePosition(key)` (`pending` rewards
included), `contest(key)`, `receipts({ limit })` (the player's own loot receipts in this game). `playerActions`,
`economyState` and `parseActionId` are also exported by name, and from `builder/web3/economy/actions.mjs` for tools.

In mock mode every call answers at once with `{ mock: true, says }` and no network, so verify stays deterministic.

URL switches: `?gamesfun_mock=1` turns the mock on. `?gamesfun_mock=0` forces the real chain.
`?gamesfun_owned=1,2` gives the mock wallet owned items.

`createGfWeb3(options)` makes a separate instance (for tests). The options are `{ config, configUrl,
fetchImpl, location, navigator, wallets, mock, rpc, storage, win }`.

## gamesfun.json (what the kit reads)

New games carry an `economy` section (`builder/web3/economy/README.md` in the kit; `live` holds the addresses once it is
live). An older game may still carry a `shop`:

```json
{ "version": 1, "network": "devnet", "creator": "<wallet>",
  "token": { "mint": "…", "name": "Bean Brawl", "symbol": "BEAN", "decimals": 6, "program": "spl-token", "source": "launched", "pool": "…" },
  "shop": { "name": "Bean Brawl Items", "collection": "…", "game": "…", "treasury": "…",
            "currency": { "mint": "So111…112", "symbol": "SOL", "decimals": 9, "native": true, "program": "spl-token" },
            "items": [{ "id": 1, "name": "Golden Hat", "rarity": "Rare", "price": "50000000", "maxSupply": 0, "soulbound": false,
                        "look": { "values": { "character.tint.player": "#ffcc00" }, "files": {} },
                        "picture": "assets/hat.png", "image": "https://devnet.irys.xyz/…", "uri": "https://devnet.irys.xyz/…", "listed": true }],
            "boxes": [{ "id": 1, "name": "Mystery Box", "price": "10000000", "entries": [{ "item": 1, "weight": 60 }], "listed": true }] } }
```

The full schema is in `builder/web3/gamesfun.schema.json` in the kit.
