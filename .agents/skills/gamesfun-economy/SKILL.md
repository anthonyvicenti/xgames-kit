---
name: gamesfun-economy
description: Turn a creator's sentence into a game economy on games.fun's loot program 0.3 (Solana devnet) - shops, loot boxes, lotteries, staking, crafting and merges, seasons and schedules, contests, a game token or an existing coin (Token-2022 and pump.fun included) - then check it, simulate it, explain it in plain words, save it into the game and hand the creator the link that puts it live. Use when someone asks for an economy, a shop, loot boxes, a gacha, a lottery or raffle, staking, rewards, crafting, a token or coin for their game, or when the economy_* tools or a gamesfun.json "economy" come up.
---

# Make a game economy (devnet)

A game's economy is the `economy` section of its `gamesfun.json`: its currencies, collectibles, pools, boxes,
payments, recipes, schedules, lotteries, stakes, contests, holds, and the decisions only the game can make. It runs
on games.fun's loot program 0.3 on **Solana devnet**. You write the spec; the kit checks, simulates and costs it; the
creator approves going live in their own wallet. The format is `builder/web3/economy/README.md`.

The tools are the `economy_*` MCP tools (on by default; `GAMESFUN_WEB3=0` hides them). Without them, the same from a terminal:
`npx gamesfun economy check|simulate|cost|plan [game] [--spec <file>] [--json]`.

## Rules (always)

1. **You never sign, and you never ask for or handle a key.** No private key, seed phrase or keypair file, ever: not
   in chat, not in a spec, not in a file. Going live and every decision are signed in the creator's own wallet in the
   studio page. If the creator pastes a key, tell them to treat it as exposed and move its funds; write it nowhere.
2. **Devnet only.** There is no mainnet in the kit. Nothing here is real money, and say so.
3. **Chance that pays tokens is flagged.** A box that pays a prize, a lottery, a contest or a jackpot is gambling in
   many places once it is real money. When the checker raises `W-CHANCE-PRIZE`, tell the creator in plain words,
   every time, and never call such a thing an investment or a sure win.
4. **The checker decides.** Never save or publish a spec with refusals. Fix each refusal the way its `fix` says.
5. **Numbers come from the tools.** What a box gives back, how long a pool lasts, what going live costs: quote
   `economy_simulate`, `economy_cost` and `economy_explain`, never your own arithmetic.
6. **Say what the program cannot do.** If an idea needs a piece loot 0.3 does not have (an auction, a last-buyer
   timer, taking from a wallet without its holder's signature), say so first and offer the nearest thing it can do.
7. **Public data only in a spec**: names, prices, percents, public addresses. Ids, indexes and `live` are written
   when it goes live: leave them out.

## In the creation loop

An economy is offered at the pitch, never forced: `offers.economy` (`what`, `price` from `economy_cost`, `clears`)
with one question (`"about": "economy"`) that has an option leaving it out, unless the person's own words asked for
one (SOL, a wallet, staking, real money, their own token: then `from` with those words, and no question). Their answer
keeps or drops it; a kept one is `"economy": {"in": "gamesfun.json"}` in the spec. In the build round you write it
with the steps below and save it (`economy_save`); `gamesfun_step_economy` then runs the checker on it after every
round, and a refusal comes back as a repair round. At delivery the loop prepares the approval link
(`economy_publish`); going live is the person's own wallet, and delivery never waits for it.

## The steps


1. **Read what an economy can be made of**: `economy_catalog` (the parts, their fields, who acts at play time and
   each fee; `{"part": "boxes"}` for one part's nested shapes).
2. **Start from the nearest example**: `economy_examples {"query": "<the creator's words>"}`, then
   `economy_examples {"name": "<example>"}` for its whole spec. The 100 ideas say how each fits the program.
3. **Write the spec** from the creator's sentence: `references/sentence-to-spec.md` maps their words to parts.
   Keep their sentence in `prompt`. Put a `scenario` with the counts they expect (how many flips a day).
4. **Check it**: `economy_check {"spec": …}`. Fix every refusal; read every warning.
5. **Simulate it and explain it**: `economy_simulate`, then `economy_explain`. Tell the creator, in a few short
   lines, what each play costs and is worth, how the pools fill and drain, what setting it up costs, what they must
   decide while it runs, and the chance flag: `references/telling-the-creator.md`. Before it goes live, or when
   the numbers matter (a box's return, a pool that must last), run `economy_simulate {"full": true}` too: the real
   program with synthetic players, its numbers beside the quick ones. Tell the creator every flagged row in words;
   if it says it could not run (offline, no devnet yet), say so and go on with the quick simulation.
6. **Iterate on what they say.** "Make mythics 0.5%", "a bigger seed": change the spec, check, simulate, explain
   again. Don't save until they are happy.
7. **Save it**: `economy_save {"game": "games/<name>", "spec": …}`. It writes only a spec that checks; a live
   economy keeps its ids and refuses what the program cannot change (an open stake, a pool's token, the currency).
   A game with an old `shop` moves it first: open the studio's Economy tab, which shows the shop as an economy and saves it.
8. **Hand over the link when they say "put it live"**: `economy_publish {"game": …}` returns the studio's Economy tab
   link (`#economy?flow=economy`). Tell them to open it and press "Put it live"; their wallet shows every step and
   its cost. You publish nothing yourself.
9. **After it is live**: `economy_status` (pools, parts on chain, receipts). For a decision only the game knows
   (a payout, a contest's winner, a held item's fate), `economy_decide` returns the Economy tab link where the
   creator reads the checks and presses "Sign in my wallet" (say it is prepared, not done). For a game that decides
   often, the creator's local keeper signs instead: they make its key on their own machine
   (`npx gamesfun economy keeper --new-key <file outside the game>`, which prints only its address), press "Let my
   keeper decide" in the Economy tab, and run `npx gamesfun economy keeper --key <file>`. Never ask for or handle
   that key.

## In the game: nothing to write

The game's agent writes no wallet or economy code. The spec is the design; the buttons come for free. The page that
hosts the game offers the economy's actions to it through `gf:host` → `economy.actions` (each `{ id, kind, label,
price, says, where }`, from `playerActions(economy)` in `builder/web3/economy/actions.mjs`), and the kit's home menu, pause
menu, results card and HUD draw them (gf-three CONTRACT §6g W2). A click only tells the page; the page signs with the
player's wallet (`gfWeb3.economy.*`, page side only) and sends the new state. So a button's name is its part's
`name`, and what it says comes from the spec's prices and odds: to change a button, change the spec. Never add a shop
overlay, a `gf/web3/` import or a price to `rules.js`; rules never see the economy, and a game is never scored by
what someone paid. Which items a player owns and **Wear** are in the kit's wallet view too; an item's `look` says
what wearing it changes.

## Things to get right

- A **stake takes everything in its rewards pool**: give each stake a pool of its own, fed by splits or a schedule.
- A **lottery** needs a pot of its own; its cut only works in the game's currency.
- **Wrapped SOL cannot be burned**: burn a game token or an existing coin, never SOL.
- A **box or payment in a currency other than the game's** must send all of each payment somewhere (its split adds
  up to 100%).
- **Prizes paid from a pool** need something filling it (a seed, a split, a schedule): `E-POOL-DRY` otherwise. The
  simulation says how big a seed rides out a bad week; pass that on. A pool that pays out faster than it fills and
  empties within the scenario's days is `W-POOL-RUNS-DRY` (it names the day and the seed that lasts); a box prize
  bigger than its pool's seed plus the open's own share is `W-PRIZE-SEED` (the first winner would get nothing).
- **Chance costs the oracle's fee**: every box open, lottery draw and `roll` pays MagicBlock's oracle 0.0005 SOL,
  from whoever asks (the player for a box). The cost and the simulation count it; say it with the price.
- **A token the game mints** (`source: "game"`) is how points, tickets, attempts and shards work; an existing coin
  needs its mint address and decimals from the creator (ask; never guess an address).
- **Any token is welcome.** A coin launched anywhere (pump.fun, another launchpad, the creator's own mint) works with
  every part, and games.fun takes nothing from its fees. A token launched with games.fun (`source: "curve"`, paired
  with SOL unless `pair` says USDC or a mint) gives games.fun 5% of its token fees; the creator keeps 95%. Besides
  that, games.fun earns only the program's flat per-action fees (0.002 SOL / 0.00001 SOL). It has no token of its own
  for now, so never present one as "games.fun's token".
- **Decisions and contests need the authority** while the game runs (`W-AUTHORITY`): by default that is the
  creator's own wallet, signing from the studio page.
- **Rewards for beating the game: confirming the win is the creator's job, on their own end.** The game runs in
  the player's browser, so anyone there can post "I cleared it", and nothing in the kit or the program can tell a
  real win from a typed one. Whoever pays out for completing the game must confirm, with their own server or
  backend, that the player really beat it (a replay of the run, their own server's view of the match, whatever
  fits their game) before a payout is asked for. Say this to the creator in plain words whenever an economy pays
  for a result only the game knows, and do not promise that the kit checks it.
- **What the kit's keeper does check is not proof of a win.** A payout the keeper signs (`"signedBy": "keeper"`) must have `caps` (`each`, `perPlayerPerDay`, `perDay`;
  `E-KEEPER-CAPS`) and should have `proof` (`{ "payment": "<the attempt they pay for>", "after": "<the least time a
  clear takes>" }`, else `W-KEEPER-PROOF`): the keeper then pays only an attempt the receiver paid on chain, once.
  Keep the prize at or under what the caps allow, and tell the creator what a cheater can still get (the caps).

## More

- From a sentence to a spec, with a worked example: `references/sentence-to-spec.md`
- Telling the creator what they get: `references/telling-the-creator.md`
- The frozen evals (20 prompts) and how to score a run: `references/evals.md`
- How the buttons reach the game, item looks, and a game that still has an old `shop`: the `gamesfun-web3` skill.
