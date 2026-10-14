# builder/web3/economy: a game's economy as one spec

A game's economy is the `economy` section of its `gamesfun.json`. It says what the game's money and collectibles are, where they flow, and which rules run by themselves on games.fun's loot program 0.3 (devnet). The schema is `economy.schema.json`; `fixtures/coin-flip-arena.json` is a whole example. It replaced the old `shop` section, and the studio's Economy tab replaced the Token and Shop tabs (a shop is part of the economy; launching the game's token is one of its parts).

Plain ES modules, no build step, no dependencies. Nothing here signs or talks to the chain, except the full simulation (`sim/`, below), which reads devnet once for the program bytes and runs them locally in LiteSVM, an optional dependency it installs into the user's cache folder on first use.

## What a creator does

From a sentence to a live economy, on devnet, without ever handing anyone a key:

1. **Say it.** "A coin-flip arena: 2% house edge to people who stake, and a weekly lottery fed by 10% of every flip." The agent (the `gamesfun-economy` skill) starts from the nearest of the 100 ideas (`ideas.json`) and writes the spec, keeping the sentence in `prompt`. Or build it by hand in the studio's **Economy tab**.
2. **Read what it does.** The checker refuses what the program cannot do (each refusal names its fix) and flags chance that pays tokens; the quick simulation says what each play costs and is worth and how long each pool lasts; the cost says what going live costs. The agent tells it in plain words (`economy_explain`); the Economy tab shows the same beside the parts.
3. **Change it until it is right.** "Make the house edge 3%", "a bigger seed": change, check, simulate again. Every number is a slot (`slots.mjs`).
4. **Save it** into the game's `gamesfun.json`: `economy_save` writes only a spec that checks; the tab saves a moment after each change, once it has the schema's shape.
5. **Put it live.** The agent hands over the studio link (`economy_publish`); the creator opens the Economy tab, looks over every step and its cost, presses **Put it live** and approves in their own wallet. What lands is written back as it lands.
6. **Play it.** The game shows the economy's buttons in the kit's own menu and HUD (a buy, a box, tickets, a stake, a claim), offered by the page that hosts the game, which signs with the player's wallet. The game's code holds none of it.
7. **Watch it and decide.** `economy status` (and the tab) shows each part on chain, the pools and the recent receipts. A rule only the game can judge (a payout, a contest's winner) is signed by the authority: the creator's wallet from the Economy tab (its decision card and Decide section; `economy_decide` and `gamesfun economy decide` return the link), or the local keeper for a game that decides often (Decisions, below).

## What is here

| File | Does |
| --- | --- |
| `economy.schema.json` | the spec's shape |
| `validate.mjs` | checks a spec against the schema (no schema library needed) |
| `check.mjs` | refusals (each with a code, what it means and the fix) and warnings |
| `simulate.mjs` | the quick simulation: what each box, ticket and craft is worth, how long each pool lasts, who pays what |
| `sim/` | the full simulation: the real loot program in LiteSVM, synthetic players through the in-game kit's own calls, its numbers beside the quick ones (below) |
| `cost.mjs` | what going live costs: each account's rent, each call's fee, network fees |
| `compile.mjs` | the setup plan: the program's instructions in order, split into transactions that fit; `diff` for a change |
| `actions.mjs` | `playerActions(economy)`: what a player can do, as the buttons the kit draws (`{ id, part, kind, label, price, says, where, asks }`); `economyState(economy, reads, player)`: the state the page sends the game. Re-exports the in-game kit's `gf-web3/econ/actions.js`, so the tools and the game never disagree |
| `migrate.mjs` | a `shop` section → an `economy` section (the publish flow, the Economy tab and `economyStatus` move a shop on read; the Economy tab saves it). The pure `migrateShop` is the in-game kit's (`gf-web3/econ/shop.js`, browser-safe), so gf-web3 reads an old shop through the same function (with `keepLive`, a shop gf-web3 2.0.0 already put on loot 0.3 stays live there) |
| `slots.mjs` | every number in the spec as a value slot |
| `ideas.json` | the 100 economies of games.fun's economy catalogue, each with how it fits loot 0.3 (`economy_examples` searches them) |
| `fixtures/` | twelve whole economies on real devnet addresses (below) |
| `evals/` | the 20 frozen prompts for the agent (`cases.json`), reference specs and `score.mjs` (the `gamesfun-economy` skill's `references/evals.md`) |
| `model.mjs`, `steps.mjs`, `txsize.mjs`, `idl.mjs` | the shared parts: units and the program's numbers; one setup step per instruction; transaction sizes; loot 0.3's IDL (`loot-0.3.json`, trimmed from the deployed program's) |

**From a terminal:** `npx gamesfun economy check|simulate|cost|plan|publish|status [game-dir]` (`--spec <file>` for a spec outside a game, `--json` for machines). `publish` never signs: it leaves a request and prints the studio link where the creator's wallet approves it (`--picture <file>` for a token launched on games.fun's curve with it). `status` reads the economy back from devnet. Being built: `economy check --devnet`, the same check read against devnet itself.

**The agent tools** (`builder/mcp/tools/economy.mjs`, on by default, off with `GAMESFUN_WEB3=0` (`builder/lib/web3-switch.mjs`); skill `gamesfun-economy`): `economy_catalog` (the parts and their fields), `economy_examples` (the 100 ideas and the fixtures), `economy_check`, `economy_simulate`, `economy_cost`, `economy_explain` (the plain-words summary), `economy_save` (only a spec that checks; a live economy keeps its ids), `economy_publish` (the studio link; never signs), `economy_status` and `economy_decide` (a decision prepared for the creator's wallet). None signs or asks for a key.

**The Economy tab** (`builder/studio/tabs/economy.js`, on by default, off with `GAMESFUN_WEB3=0`): the money flow drawn, the parts with every number editable, the quick simulation and the checker's notes beside them, the cost, **Put it live** (the `economy` flow below), then the live state and the receipts. Its routes (`builder/web3/node/economy-routes.mjs`, under `/api/web3`): GET and POST `/economy` (read and save the spec), POST `/economy/check`, `/economy/simulate`, `/economy/cost`; `GET /economy/status` is `economyStatus`. `#economy?flow=economy` (the link `economy_publish` returns) opens it with Put it live offered.

**In the game** (gf-three CONTRACT §6g W2): the game's code holds no wallet or economy code. The page that hosts the game runs gf-web3, which reads this section and has one call per thing a player signs (`gfWeb3.economy.buy`, `openBox`, `pay`, `craft`, `buyTickets`, `stake`, `unstake`, `hold`, `enter`, `claim`, and `act(id)` for any entry of `playerActions`; the reads `actions()`, `state()`, `pools()`, `boxOdds()`, `lottery()`, `stakePosition()`, `contest()`, `receipts()`; `skills/gamesfun-web3/references/api.md`). The page offers the actions to the game in `gf:host` → `economy.actions` and its state in `gf:economy`; the kit's menu, pause menu, results card and HUD draw them, and a click comes back as `gf:econ-action`. That page is games.fun's `/play` page, or in the kit the studio's preview and `builder/studio/play.html`, both through `builder/studio/host-bridge.js` (the only `gf:host` sender: it shows a lottery's and a stake's HUD line once the player has something in them, and the last result of each box). `tests/web3/devnet/proof-real-game.mjs` proves it on devnet in a real kit game (`gamesfun create --from coin-hop`): put live from the Economy tab, flipped from the game's own wallet view in the studio preview and from its pause menu in `play.html`, the HUD lines followed, verify `--quick` and check 22 pass, `economy check --devnet` agrees (`proof-real-game-result.json`, screenshots in `shots-real-game/`). `tests/web3/devnet/play.mjs` plays a small economy on devnet through `gfWeb3.economy` only (`play-result.json`).

## Going live (`builder/web3/node/economy.mjs`, `builder/web3/node/flows.mjs`)

- `planToInstructions(plan, ctx)` turns each plan step into a real instruction with the kit's builders (`gf-web3/chain/loot.js` `lootIx`, Core, SPL, Metaplex): names become addresses, decimal strings bigints, `{ Pool: 3 }` the codec's `{ Pool: [3] }`, a Token-2022 deposit gets its `transferExtras`.
- Flow kind `economy` (`POST /api/web3/flow/start { kind: 'economy', wallet }`; the old `publish` starts it too) puts everything the economy still needs live: a token launched on a curve of its own first (its own uploads, then one or two transactions), item pictures and details to Arweave, then every setup transaction in one wallet approval (more only when it takes more than 12). Each transaction is written to `gamesfun.json` as it lands: each part's program id, a new token's mint, `live.game`, `live.collection`, `live.treasury`, `live.at`, `live.transactions` (signatures) and `live.published`, the spec as it is on chain. The next publish sends only `diff(live.published, spec)`; "publish" in the spec always means `live.at`.
- `economyStatus(gameDir, opts)` and `GET /api/web3/economy/status`: each part on chain or not and whether it still matches the spec, each pool's balance, the recent receipts.
- Devnet proof: `tests/web3/devnet/economies.mjs` puts every fixture live through the same flow and reads it back (it writes `economies-result.json` beside itself).

## Decisions (`builder/web3/node/decide.mjs`, `decide-flows.mjs`, `decide-routes.mjs`, `keeper.mjs`)

What only the game knows is signed by the game's authority: `payout`, `burn`, `issue`, `make`, `award` (a hold) and a contest's `open_contest` and `decide` are built (`unmake`, `set` and `roll` are refused with `D-NOT-YET`). One builder, `prepareDecision({ economy, request, rpc, signer, ledger, by, now })`, checks a request against the spec and the chain and returns the instructions with a plain-words summary (`says`), its numbers and its refusals (each a code, what it means, its fix). The page, the keeper, `gamesfun economy decide` and `economy_decide` all use it.

**A request** (`readRequest`): `{ decision: "<key>" | "contest:<key>" | "hold:<key>", id?, to?, amount? | percent?, side?, open?, asset?, attempt?, says? }`. `id` is the game's own name for the result (a run, a match): each is decided once (`D-SAME-ID`). `attempt` is the signature of the transaction that paid for the attempt. A private key anywhere in it, the attempt included, is refused.

**A request is a claim.** It comes from code in the player's browser: a player can post "I cleared the level" from the console, and in a room any peer can. So the spec says what a claim must show and how much any claim can move, and the page and the keeper enforce it:

- `proof: { payment, after?, within? }`: the claim must name a successful top-level `pay` on this game, by the receiver, of that payment's whole amount in its currency, split exactly as the spec says (a `pay` that sends its shares back to the player is refused), with the program's `Paid` receipt, at least `after` and at most `within` before the claim (by the chain's block time), and never paid before (the ledger, and the `PaidOut` receipts of the pool's last 25 transactions: the payout carries the attempt's reference). Refusals: `D-PROOF-MISSING`, `-NOT-FOUND`, `-FAILED`, `-NOT-PAY`, `-EARLY`, `-LATE`, `-USED`.
- `caps: { each, perPlayerPerDay, perDay }` in whole units, counted from the ledger over 24 hours (`D-CAP-EACH`, `-PLAYER`, `-DAY`). A payout, issue or make the keeper signs must have `each` and `perDay` (`E-KEEPER-CAPS`); without `proof` the checker warns that anyone can collect it up to its caps (`W-KEEPER-PROOF`).
- And always: the amount at most the decision's own (`D-AMOUNT`), the pool holds it (`D-POOL-SHORT`), the receiver is a wallet and not the game's own account (`D-TO`), the signer is the game's authority on chain (`D-SIGNER`).

**Confirming a win is the game owner's job.** Nothing in the kit or the program can tell a real clear from a typed one: whoever pays rewards for completing a game must confirm on their own end, with their own server or backend, that the player really beat it, before a request reaches the page or the keeper. The checks above only limit the damage when that is missing. What an attacker can still get past them: a player who really paid for an attempt can claim a clear they did not make, once per attempt, after `after`, up to the caps. So a prize above an attempt's price is a bet that the proof is enough; the replay or a quorum of peers is not checked yet. These are the page's and the keeper's own rules: the program trusts the authority's signature and checks nothing else ("we always trust project auth").

**From the page:** the Economy tab reads `#economy?decide=<key>&to=&amount=&percent=&side=&asset=&attempt=&id=&open=` and shows the decision card (what, the numbers, the checks, "Sign in my wallet": flow kind `decide`, the receipt after). The Decide section lists who decides, the spec's decisions, contests open or awaiting a result, collectibles on hold, and the latest ledger lines; it has "Let my keeper decide" and "Take it back" (flow kind `authority`: one owner-signed `update_game`, written into `keys.authority` and `live.published.keys`, so a later publish does not undo it). Routes: `GET /economy/decisions`, `POST /economy/decide/check`, `POST /economy/decide-request`.

**The local keeper:** `gamesfun economy keeper --new-key <file>` writes a fresh keypair file (0600) and prints only its address; it refuses a path inside the game, the kit or any git checkout, and never overwrites. `gamesfun economy keeper [game] --key <file>` (or `GAMESFUN_KEEPER_KEY`) runs it: it signs only decisions the spec gives it (`"signedBy": "keeper"`, else `D-NOT-KEEPER`), one at a time, with the same checks, and logs every request, done, refused or failed, to `.gamesfun/web3/decisions/<game>.jsonl` (also the page's decisions; the caps count both). It listens on 127.0.0.1 behind a token kept in its status file (`.gamesfun/web3/keeper/`), which the dev server reads: `POST /api/web3/economy/decide-request` (same-origin, as every web3 route) hands it a request.

**What the game would send (not in gf-three yet).** The game's host copy knows the result. gf-three has no message for it, so the kit adds none: today a page or a script posts the request to the dev server. The proposed shape for gf-three's page bridge, game to page: `{ type: 'gf:econ-claim', id, decision, player, attempt, says }`, sent by the host copy only, where `player` is the winner's wallet as the page's wallet bar knows it and `attempt` the signature the page got back from `economy.pay`. The page must check before forwarding: it comes from the game frame, the page itself made that payment for that wallet in this session, and the keeper repeats every check above. Requests from games on games.fun's /play page need a relay to the creator's keeper (a queue on the play host the keeper polls); not built.

## How to write one

- **Amounts are in whole units of their currency**: `0.1` is 0.1 SOL, not lamports. Write `"0.1"` as text when it must be exact.
- **Shares are percents**: `2.5` is 2.5%. The program counts hundredths of a percent, so at most two decimals.
- **Times are durations**: `"45s"`, `"30m"`, `"6h"`, `"7d"`, `"2w"`, or seconds. A start is `"publish"`, `"publish+7d"` or a date like `"2026-11-01T18:00:00Z"`.
- **Every part has a `key`** (lower case, digits, dashes). Other parts name it: a box pays from `"pool": "house"`, a split sends to `"pool:house"`. Slots use it too: `economy.box.flip.price`.
- **Ids are the program's.** `id` on items, boxes, recipes, schedules, lotteries and stakes, and `index` on pools, are written when the economy goes live. Leave them out in a new spec and never change them after.

## The parts

| Part | What it is | Who acts at play time |
| --- | --- | --- |
| `tokens` | the currencies. `sol`; `curve` (the game's token, launched with games.fun on a Meteora curve of its own, paired with `pair`: SOL by default, USDC or any SPL mint); `existing` (any mint by address, launched anywhere: classic or Token-2022, pump.fun included); `game` (a token the game mints itself: points, tickets, shards) | |
| `currency` | the game's own currency: shop prices and the treasury | |
| `collection`, `items` | the collectibles (minted to the player) and normal items (kept by the game's backend), with supply, price, a price that rises or falls, and a `life` (ready after, lasts, uses, cooldown) | the player buys |
| `pools` | vaults only the game can spend from: prizes, pots, rewards. `seed` is what the creator puts in at the start | |
| `boxes` | a paid roll: an item, a prize from a pool, a share of a pool (a jackpot), a burn of the payment, or nothing | the player opens; anyone settles |
| `payments` | a player pays for something the game gives off chain (an attempt, an entry), split as it says | the player |
| `recipes` | collectibles and tokens in, collectibles and tokens out: merges, salvage, an exchange, breeding, a daily claim | the player |
| `schedules` | on a timer: mint into a pool, burn a share of a pool, or move a share between pools | anyone |
| `lotteries` | tickets into a pot, a draw on a timer, up to 8 places | players buy; anyone draws and pays |
| `stakes` | players lock a token and share what arrives in a rewards pool | the player |
| `contests` | players back a side; the side the authority names shares the pot | players enter; the authority opens and decides |
| `holds` | a player hands a collectible to the game for a time; the authority says where it goes | the player, then the authority or anyone |
| `decisions` | the authority's rules in words: what only the game knows (who cleared the level) and what the program then does | the authority |
| `keys.authority` | who signs the decisions: `"owner"` (the creator's wallet) or another wallet's public address | |
| `scenario` | what the quick simulation assumes: how many of each a day | |
| `live` | addresses written when it goes live | |

A **split** is up to four shares of a payment, each `{ "to": ..., "percent": ... }`, where `to` is `"burn"`, `"pool:<key>"`, `"account:<token account>"` or `"holder:<collectible address>"`. What the shares leave goes to the treasury.

A **box's outcomes** each have a `chance` (percents that add up to 100) or each a `weight` (whole numbers, as the program keeps them). `gives` is `item` (with `item`), `pay` (with `pool` and `amount`), `share` (with `pool` and `percent`), `burn` or `nothing`. The payment is split as the box says, except on `burn`, which burns all of it.

## What the program does that a spec must respect

Read `launchpad/loot/PROGRAM-0.3.md` in games.fun for the whole program. The checker also warns, from the quick simulation, when a pool empties within the scenario's days (`W-POOL-RUNS-DRY`: the day, and a seed that lasts), and when a box's prize is bigger than its pool's seed plus the open's own share (`W-PRIZE-SEED`: the program skips a prize its pool cannot pay, so the first winner would get nothing). Both are warnings, not refusals: the program pays until the pool is empty; `E-POOL-DRY` refuses only a pool that nothing ever fills. A lottery needs no such check: its places are shares of what its pot holds. The checker enforces the parts a creator can trip on: a stake takes everything in its rewards pool, so that pool is its alone; wrapped SOL cannot be burned; a box or payment in a currency other than the game's must send all of it somewhere (the treasury only holds the game's currency); a lottery's cut only works in the game's currency; a stake and a contest cannot be edited once open; the authority signs every payout, so a rule that pays out needs the authority at play time.

## Fees

The program charges two flat fees in SOL: **0.002 SOL** when a player signs for something of their own (`pay`, `buy_item`, `open_box`, `buy_tickets`, `stake`, `unstake`, `craft`, `hold`, `enter`), and **0.00001 SOL** for everything else that is charged (`deposit`, `payout`, `burn`, `issue`, `make`, `unmake`, `set`, `roll`, `award`, `open_contest`, `decide`). Setting the economy up (`create_game`, `open_pool`, the `upsert_*` calls, `open_stake`) pays rent and network fees only. Finishing what is already decided (`settle`, `run_schedule`, `draw_lottery`, `pay_lottery`, `claim`, ...) is free.

**What games.fun earns**: those flat per-action fees, and 5% of the token fees of a token launched with games.fun (the creator keeps 95%; the graduated pool's liquidity is locked 95 to the creator and 5 to games.fun). Nothing from a token launched anywhere else: any token is welcome, and every part works with it. games.fun has no token of its own for now.

Chance has a third fee, not the program's: **MagicBlock's oracle takes 0.0005 SOL** (500,000 lamports) for each random number, from whoever asks: the player on `open_box`, whoever sends `draw_lottery`, the authority on `roll`. It is `VRF_LAMPORTS_COST` in MagicBlock's `ephemeral-vrf` (`api/src/consts.rs`) for the queue loot uses (`Cuj97ggr…`, the SDK's `DEFAULT_QUEUE`), and `economy check --devnet` measured exactly that on every open (2026-10-11). It is one constant, `model.mjs` `ORACLE_FEE`: `cost.mjs` puts it on each action that rolls (`oracleSol`), `simulate.mjs` in each box's real cost to the player (`realCost`: a 0.1 SOL flip takes 0.10251 SOL from the wallet, the network fee of two signatures included: the open and the claim) and in who pays what a day, and the devnet check compares what it measures against it.

## The full simulation (`sim/`)

`gamesfun economy simulate --full [game-dir] [--players 20] [--days n] [--seed text] [--program loot.so] [--offline]` (and `economy_simulate` with `full: true`, `simulateFull(economy, opts)` in `sim/index.mjs`) runs the economy on the real program instead of on expected values:

1. **A local chain.** LiteSVM (npm `litesvm` 1.5.0, MIT; Linux and macOS only, about 46 MB with its native module) with the loot program 0.3.1 as deployed on devnet (its program data read once and checked against the deploy record's sha256 `aaa04f48…`, the 95 / 5 upgrade of 2026-10-12), or a local build of `program/loot` (`--program`, the report says whether it matches devnet), plus Metaplex Core, Token Metadata and MagicBlock's VRF as they are on devnet (checked against the bytes the kit pinned; a newer devnet build is used with a note). Devnet's loot platform record (the two fees), the VRF queue, the rent sysvar and every account the spec names (an existing token's mint, a partner's account, a collectible a share pays the holder of) are read once too. All of it is cached in the user's cache folder (`GAMESFUN_CACHE`, else `~/.cache/gamesfun`, `~/Library/Caches/gamesfun` or `%LOCALAPPDATA%\gamesfun\cache`); nothing is sent to any network. LiteSVM's own install goes there too, on first use, never into the kit's `node_modules`.
2. **Going live** through the kit's own publish code: `publishPlan`, `planToInstructions` and `recordLanded`, as the Economy tab's flow does, with a fresh owner (a token still to launch on the curve gets a mint of its own on the local chain).
3. **Players** (20 by default) do the scenario's actions for its days through gf-web3's own economy calls (`econ/play.js`: `openBox`, `buy`, `pay`, `craft`, `buyTickets`, `claim`), spread evenly over each day while the clock moves forward. A recipe is made by the first player who holds what it takes. A stake's action is a staker collecting what it earned (the scenario's `staked` is staked by up to five players at the start). A keeper runs every schedule and draws every lottery when it is due (`claim('lottery:…')`, the same call a player could make). A decision with a `perDay` is the authority paying out to a player, burning or rolling. Holds and contests are not played yet (the report says so).
4. **Signatures and the oracle.** LiteSVM checks no signatures here, so nobody needs a key: a wallet is an address marked as a signer. MagicBlock's oracle cannot run locally: after a transaction asks for randomness, the run answers it at once with the loot program's own callback (`callback_roll`, `callback_lottery`, `callback_random`), signed by the VRF identity the program checks, with randomness from the seed, and puts the oracle's queue back as the oracle would have; the real VRF program still charges its fee. The program's own Rust tests do the same (`program/loot/programs/loot/tests/common/mod.rs`).
5. **The ledger.** Every landed transaction's token movements (each transfer, mint and burn, read from its token-program instructions, inner ones included) and the lamports of the platform record, the oracle's queue and the program's own accounts are added up by what they were for. That gives each box's real return, each pool's money in and out a day, where it ended and the first day it was empty, each lottery's paid rounds, each stake's rewards, and who paid what: players, the treasury, games.fun's fees, the oracle, the network, rent.
6. **Side by side.** The quick simulation is run again at the rates the players achieved (a recipe nobody had the inputs for happens less often than the scenario asks; the report lists every refusal) and over the same days, along the quick model's own path for pools that settle (`quickOverRun`). Each number is flagged when the two differ by more than chance (three standard errors where it can be worked out: a box's prizes, a lottery's round, a stake's credits) and 5% of the quick number.

Offline with an empty cache, on Windows, or without npm, it says why and shows the quick simulation. The tests (`tests/economy-sim.test.mjs`) run the coin-flip arena, halving seasons and the sacrifice raffle on the real program when the cache has what they need and skip otherwise (CI has no devnet).

What it found, 2026-10-12, running every fixture (the quick simulation was fixed where it was wrong, each fix with a test in `tests/economy-simulate.test.mjs`):

- **Fixed: who signs the claim.** A box's open and a collectible's purchase are two signatures from the player's wallet (the pay, then the claim gf-web3 sends); the quick simulation counted the claim as the creator's. A 0.1 SOL flip takes 0.10251 SOL, not 0.102505.
- **Fixed: a price that rises or falls.** The quick simulation counted every sale at the listed price. It now prices the scenario's sales as the program does (`salePrices`: the fall since the later of its start and the last sale, then the rise on what was paid) and says where the price ends. The blind forge's box rises 0.5% a sale: 400 sales in two days already paid three times the listed price, and its 6,000 sales over 30 days end at about 10^13 times it (the note says players stop long before). The falling drop's hero sells at its 0.2 SOL floor every time, not at 2 SOL; its clone rises 5% a sale.
- **Fixed: a burn schedule's tokens** were missing from what is burned a day (the scorched treasury burns 1,000 MAIN a day at its seed).
- **Fixed: a collectible's rent** is 0.0031 SOL (its Core account's rent plus Metaplex Core's 0.0015 SOL creation fee, which the account keeps), not about 0.004, and one a recipe burns gives back 0.00096 SOL (its rent less one byte's; the fee stays in a 1-byte account).
- **Approximations the comparison allows for:** a share taken on a timer from a pool that the same timer fills takes more than the continuous estimate (halving seasons: about 9% more reaches the interest pool, and the season pool ends about 19% lower after 30 days); a lottery pot fills for a whole round before it pays; a stake's rewards wait in their pool until someone stakes or unstakes.
- **What the players could not do** is reported, not hidden: halving seasons' 50 daily claims a day need passes that rest a day and sell 5 a day; the sacrifice raffle's 500 tickets a day need 550 tickets a day from sacrifices; the stud farm's breeding needs a number the authority writes on a mare; the duel arena's holds, contests and their decisions are not played yet.

## The setup plan (`compile.mjs`)

`compile(spec)` returns `{ ok, program, before, transactions, play, warnings, notes }`, or `{ ok: false, refusals }`.

- `transactions`: `[{ signer, signers, bytes, says, steps }]`, in order. Each is one wallet signature's worth; `signer` is `owner` (the setup) or `authority` (a seed of a token the game mints, when the authority is another key).
- A step: `{ id, program, ix, args, accounts, signer, signers, says, data, creates }`.
  - `program` is `loot` for loot 0.3, where `ix` and the names in `args` are exactly the IDL's (`upsert_box` with `box_id` and `args: { price, currency, rise, fall, stock_odds, active, shares, entries }`). Other steps are `system`, `spl-token`, `associated-token`, `mpl-core` and `mpl-token-metadata`.
  - In `args`, a u64 is a decimal string in base units; a pubkey is an address, or `@<name>` for one that exists only after an earlier step (`@mint:points`, `@wallet:owner`, `@pda:game`); an enum is `{ Variant: fields }`, `{ Variant: {} }` without fields, `{ Pool: 3 }` with one unnamed field.
  - `accounts` maps the IDL's account names (nested ones flattened, `fee.platform`) to names that stand for one address each: `wallet:owner`, `pda:game`, `pda:pool/0`, `pda:item/3`, `mint:<token key>`, `ata:owner/<token key>`, `new:collection` (a key made for this setup; it signs), `program:system`.
  - `data` is the instruction data's size in bytes; `creates` lists the accounts it opens and their bytes (for the rent).
- `before`: steps outside this plan (a token launched on a curve has its own approval).
- `play`: what each part needs while the game runs: `{ part, ix, signer, says }` (`open_box` by the player, `settle_prize` by anyone, `decide` by the authority).
- Sizes never come out below the real transaction: every account is counted once per name, loot data is sized from the IDL byte for byte, no lookup tables. Transactions are packed to 1,168 bytes, leaving 64 of the network's 1,232 for the wallet's own compute-budget instructions.

`diff(liveSpec, newSpec)` returns the same shape with only what a change needs: parts keep their program ids by key, a removed item, box, recipe or schedule is switched off (the program has no close for them), a removed pool is closed, a bigger seed deposits the difference. It refuses what the program cannot change: an open stake (`E-STAKE-FIXED`), a pool's token (`E-POOL-FIXED`), the game's currency (`E-CURRENCY-FIXED`).

## The fixtures

Ten economies from games.fun's catalogue of 100, the coin-flip arena and the level ladder of games.fun's plan for the economy kit. The tests check, simulate and compile all of them.

| Fixture | From the list | What it exercises |
| --- | --- | --- |
| `coin-flip-arena` | the plan's first example (#61) | a box that pays from a pool, a split into three pools, a lottery with three places, a stake on a curve token |
| `blind-forge` | #1, #8 | a Token-2022 coin with a 1% transfer fee; a box of items with a rising price and stock odds; a lottery with a cut |
| `spark-pity` | #2 | two tokens the game mints; a recipe that pays SOL into a pool and mints both; a box priced in a game token whose split burns it all; a prize from a pool; a recipe that burns 90 Sparks for an item |
| `halving-seasons` | #81, #6, #96 | a schedule that mints with a halving and a run limit; a schedule that moves a share between pools; a soulbound pass with a cooldown, used by a recipe that pays from a pool; a stake |
| `scorched-treasury` | #14 (needs the authority) | a schedule that burns a share; a seed; a payment into a pool; the authority's payouts |
| `merge-2048` | #21 | an existing pump.fun-style mint (a devnet stand-in: classic SPL, 6 decimals, no mint or freeze authority); recipes that burn two for one; a share of a pool as a craft's prize |
| `stud-farm` | #31, #19, #26 | uses and a cooldown, ready-after and lasts; a recipe that uses, burns and pays the stud's holder; needs and keeps; renew |
| `sacrifice-raffle` | #15, #67 | recipes that burn an item for minted tickets; a lottery whose tickets are another token (burned) with eight places |
| `falling-drop` | #92, #40, #74, #20 | a price that falls, a price that rises, payments with a share to an account, a share that burns |
| `duel-arena` | #69, #47 (needs the authority) | a contest with a share for a collectible's holder and a burn; a hold; decisions signed by a separate authority key; 90% of each ship sold fills the mission rewards (added 2026-10-12: before, they paid 40 USDC a day with nothing coming in and ran dry on day 2.5; the devnet run in `economies-result.json` put that earlier version live) |
| `starforce` | #22 | a recipe that gives an attempt token; a box in that token whose outcomes are an item, the same item again, a burn, and a share of the jackpot |
| `level-ladder` | the plan's K4 (#52) | a payment per attempt, 80% into a prize pool; the prize on the last level paid by the keeper (`signedBy: keeper`), only for a paid attempt at least 20 s old (`proof`), within `caps`; devnet proof `tests/web3/devnet/ladder.mjs` |

Every address is a real devnet one: USDC-dev, MAIN-dev (a devnet test token from before 2026-10-12; games.fun has no token of its own now), the Token-2022 coin of the 0.3 devnet run (`7MJWx2u…`), and the accounts `tests/web3/devnet/economies.mjs --make-fixtures` made on 2026-10-12 (`economies-fixtures-result*.json`): the pump.fun-style TILE mint `Cywvs…`, the stud `3rzrH…` and the arena deed `9rAE9…` (Core collectibles held by test wallets), the partners' accounts (the launchpad partner wallet's wrapped SOL `6U3Xn…`, a test wallet's MAIN-dev `3pVhH…`) and the duel arena's authority, the launchpad keeper wallet `Hby5B…`. No fixture needs a secret.

## Where it stands (the phases of games.fun's plan for the economy kit)

| Phase | Built | Not yet |
| --- | --- | --- |
| K0, the program and the old shop | the kit on loot 0.3.1 (devnet `GVzbAquL…`, 2026-10-12: 0.3 with the audit's fixes, at a new address; 0.3 was `88Labq6t…`), Token-2022 allowed; devnet proof `tests/web3/devnet/loot-0.3.mjs`, 9 of 9 steps on 0.3 on 2026-10-11 (its script now goes through the economy; not run again since); `play.mjs` 12 of 12 on 0.3.1 (`play-0.3.1-result.json`) | the CI devnet run |
| The token launch (games.fun's decisions of 2026-10-12) | a DBC config of each launch's own, paired with SOL (default), USDC-dev or any SPL mint, split 95 / 5 to games.fun's partner wallet (`gf-web3/chain/dbc.js`, `dbc-curve.js`), byte for byte what games.fun's launchpad builds (`tests/web3-dbc-config.test.mjs`); devnet proof `tests/web3/devnet/launch-95-5.mjs` (`launch-95-5-result.json`, 2026-10-12: SOL pair with a 0.001 SOL first buy; read back 95 / 5 with the partner as fee claimer; games.fun's official check passed); the loot program upgraded in place to the 95 / 5 registry rules | `attach_token` with a real 95 / 5 launch on devnet (proved in the program's LiteSVM tests only) |
| K1, the spec and its tools | everything in the tables above; every fixture went live on devnet through the economy flow (`economies-result.json`, 13 of 13) | |
| K2, economies in games | the in-game calls (`gfWeb3.economy`, devnet play proof `play.mjs`, 12 of 12); the kit's menu and HUD draw offered actions (gf-three §6g W2 in `kits/`, verify check 22); the page bridge in the studio preview and `builder/studio/play.html`; devnet proof in a real kit game (`proof-real-game.mjs`, coin-hop, 2026-10-12) | a paid button's price at window heights of 660 px or less (gf-three's menu hides the line under the label there); an example game of each kind carrying an economy |
| K3, the agent and the page | the `economy_*` tools, the `gamesfun-economy` skill, the Economy tab, the 20 frozen evals; a scored run by headless Claude Code (`evals/run.mjs`): 19 of 20 with each case's own reference held out, twice (`evals/results/2026-10-11.json`), three of its specs live on devnet | the build loop learning the economy (pitch, spec, deliver: being built in games.fun's gf-three loop) |
| K4, decisions and the full simulation | one decision builder (`builder/web3/node/decide.mjs`) checked against the spec's rules; the Economy tab's decision card and Decide section (flow kinds `decide` and `authority`); the local keeper (`gamesfun economy keeper`); the level ladder fixture and its devnet proof (`tests/web3/devnet/ladder.mjs`, `ladder-result.json`, 2026-10-11); the full simulation on the real program in LiteSVM (`sim/`, `economy simulate --full`, `economy_simulate` `full: true`) | claims from a game played on games.fun's /play page reaching the creator's keeper (below); holds, contests and decisions played in the full simulation |

The kit's `playerActions` also lists a `pay` action for a payment part; gf-three's W2 offer accepts nine kinds without `pay`, so the kit's menu drops it until one of the two changes.
