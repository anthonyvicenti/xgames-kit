# From a creator's sentence to a spec

Read the sentence for **what players pay, what they can get, where the money goes, and who decides**. Each phrase
maps to a part of the spec (`economy_catalog` has every field).

| They say | Write |
| --- | --- |
| "a shop", "sell hats for 0.05 SOL", "limited to 100" | `items` with `price` (in the game's `currency`) and `supply` |
| "costs more each time", "+5% per sale" | an item's or box's `rise` (`growthPercent`, or a `step`) |
| "price drops every minute until it sells" | `fall` (`step`, `every`, `floor`) |
| "loot box", "gacha", "mystery box", "60/25/10/4/1" | `boxes` with `outcomes` of `gives: "item"` and a `chance` each |
| "coin flip", "double or nothing", "plinko", "a prize" | a box whose outcomes `pay` from a pool; its `split` fills that pool |
| "jackpot", "a tenth of the jackpot" | an outcome `gives: "share"` of a pool (`percent`) |
| "x% house edge to stakers", "fees go to holders" | a `split` share `"to": "pool:<rewards>"` and a `stakes` entry whose `rewards` is that pool |
| "weekly lottery", "three places", "one grand prize and seven smaller" | `lotteries` with its own `pot`, `every: "7d"`, `places: [50, 30, 20]` |
| "x% of tickets go to me" | the lottery's `cutPercent` |
| "fed by 10% of every flip" | a 10% share in the box's `split` into the lottery's pot |
| "burn X for Y", "merge two into one", "craft", "breed" | `recipes`: `in` (`burn`, `use`, `pay`) and `out` (`item`, `tokens`, `share`) |
| "points", "tickets", "shards", "attempts", "sparks" | a token the game mints: `tokens` entry with `source: "game"`, given by a recipe's `out` (`from: "mint"`) |
| "a pass that claims daily", "cooldown" | an item with `life.cooldown`; a recipe that `use`s it and pays `tokens` from a pool |
| "ready after 7 days", "rots in 3 days", "6 uses" | an item's `life`: `readyAfter`, `lasts`, `uses` |
| "every day mint 1,000 into the pool, halving every 30 days" | a `schedules` entry `does: "issue"`, `every: "1d"`, `halveEvery: 30` |
| "burn 1% of the pool daily", "move 5% weekly" | a schedule `does: "burn"` or `does: "move"` with `percent` |
| "an entry fee", "pay per attempt" | `payments` with `amount` and a `split` |
| "the referrer gets 10%" | a split share `"to": "account:<their token account>"` (ask for the address) |
| "the holder of the deed gets 3%" | a split share `"to": "holder:<collectible address>"` |
| "duel", "bet on a side", "the winner takes the pot" | `contests` with `sides` and a rake in `split`; the authority decides |
| "the game decides who cleared the level and pays them" | `decisions`: `does: "payout"` from a pool, with `when` in words |
| "send ships on missions, the game says how it went" | `holds` (the item, `for`) and an `award` decision |
| "our token", "launch a coin" | a `tokens` entry `source: "curve"` (launched with games.fun on a curve of its own, its own approval; `pair`: SOL by default, "USDC" or a mint; the creator keeps 95% of its fees, games.fun 5%) |
| "my pump.fun coin", "this mint" | `source: "existing"` with `mint`, `decimals`, `venue: "pump.fun"` (ask for the address) |
| "Token-2022", "a transfer fee" | `program: "token-2022"` and `powers.transferFeePercent` |
| "in USDC" | the devnet currencies `economy_catalog` lists, by their mint |

Then fill the gaps with sensible, stated defaults (a seed for a prize pool from the simulation's advice, a stake's
`lock` as long as the gap between rewards) and tell the creator which ones you chose.

## Worked example

The creator: *"Make me a coin-flip arena: 2% house edge to people who stake, and a weekly lottery with three places
fed by 10% of every flip."*

- **Pays**: a flip (a box). **Gets**: double or nothing (a `pay` outcome at 50%). **Money goes**: 2% to stakers, 10%
  to the lottery's pot, the rest back into the pool that pays the flips. **Decides**: nobody (it runs alone).
- `economy_examples {"query": "coin flip staking lottery"}` → `coin-flip-arena`. Its spec:

```json
{
  "version": 1,
  "name": "Coin-flip arena",
  "prompt": "Make me a coin-flip arena: 2% house edge to people who stake, and a weekly lottery with three places fed by 10% of every flip.",
  "currency": "sol",
  "tokens": [{ "key": "sol", "source": "sol" }, { "key": "arena", "source": "curve", "name": "Arena", "symbol": "ARENA", "decimals": 6 }],
  "pools": [
    { "key": "house", "currency": "sol", "seed": 5 },
    { "key": "backers", "currency": "sol" },
    { "key": "pot", "currency": "sol" }
  ],
  "boxes": [{
    "key": "flip", "name": "Coin flip", "price": 0.1,
    "split": [{ "to": "pool:house", "percent": 88 }, { "to": "pool:pot", "percent": 10 }, { "to": "pool:backers", "percent": 2 }],
    "outcomes": [{ "gives": "pay", "chance": 50, "pool": "house", "amount": 0.176 }, { "gives": "nothing", "chance": 50 }]
  }],
  "lotteries": [{ "key": "weekly", "name": "Weekly draw", "pot": "pot", "price": 0.01, "places": [50, 30, 20], "every": "7d" }],
  "stakes": [{ "key": "backers", "name": "Back the house", "stakes": "arena", "rewards": "backers", "lock": "1d" }],
  "scenario": { "perDay": { "box:flip": 1000, "lottery:weekly": 100 }, "staked": { "backers": 1000000 } }
}
```

- `economy_check` → clean, with `W-CHANCE-PRIZE` (say it) and `W-FEE` (the 0.002 SOL player fee is 2% of a flip).
- `economy_simulate` → a flip gives back 0.088 SOL on average (88%): the stakers' 2% and the lottery's 10% both come
  out of every flip, so players keep 88%, not 98%. Say that plainly and ask which they meant: keep it as written, or
  fill the pot from tickets alone and pay 0.196 SOL on a win (98% back, the 2% to stakers). Both check clean.
- `economy_explain` → the words for the creator. The simulation also says a 5 SOL seed is thin against a week's luck
  and suggests about 22: pass it on.
- The creator: "make it 20 SOL to start". Change the seed, check, simulate, explain, then `economy_save`, and when
  they say so, `economy_publish` for the link.
