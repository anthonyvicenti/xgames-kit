# loot 0.3: the program

The loot program is one Solana program for game economies: payments, shops, loot boxes, pools, schedules, lotteries,
stakes, recipes, holds and contests, with a public receipt for every move. This document describes 0.3.2, which runs on
devnet at `GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o`. Nothing is on mainnet.

## The whole program in one screen

A project is one record, a `Game`. Value moves in four ways, and each move writes a public receipt.

| Verb | Instructions | Who signs |
| --- | --- | --- |
| **In**: money comes in | `pay`, `buy_item`, `open_box`; `deposit` | the player; anyone for `deposit`, which funds a pool |
| **Out**: a pool pays out or burns | `payout`, `burn` | the game's authority |
| **Make**: tokens and items are made | `issue`, `make`, `unmake`, `set` | the game's authority |
| **Decide**: the game names an outcome and the program carries it out | `award`, `open_contest`, `decide` | the game's authority |

**The authority is only needed for what only the game knows:** who cleared the level, who won the match. Everything the chain can decide by itself runs without it. The owner writes a mechanic once, and after that players and anyone at all carry it out:

| Mechanic | What it does | Written by the owner | Then sent by |
| --- | --- | --- | --- |
| **Box** | a weighted roll that gives an item, pays a prize from a pool, burns the payment, or gives nothing | `upsert_box` | the player (`open_box`), then anyone (`settle` of a collectible, `settle_prize`); a normal item is settled by the game's owner or authority |
| **Schedule** | mints into a pool, burns a share of a pool, or moves a share between pools, on a timer | `upsert_schedule` | anyone (`run_schedule`) |
| **Lottery** | tickets into a pot, a random draw on a timer, up to 8 places that each take a share of the pot | `upsert_lottery` | players (`buy_tickets`), then anyone (`draw_lottery`, `pay_lottery`) |
| **Stake** | players lock a token and share what flows into a rewards pool | `open_stake` | the player (`stake`, `unstake`) |
| **Recipe** | collectibles and tokens in, collectibles and tokens out: a merge, a shop in any currency, a salvage, a breeding, an exchange at a fixed rate | `upsert_recipe` | the player (`craft`) |
| **Hold** | a player hands a collectible to the game for a time they choose; while it runs the authority says where it goes | nothing to write | the player (`hold`), then the authority (`award`) or anyone (`take_back`) |
| **Contest** | players put money on a side; the side the authority names shares the pot | the authority opens one (`open_contest`) | players (`enter`), the authority (`decide`), then anyone (`claim`, `call_off`, `close_contest`) |

Chance comes from MagicBlock's VRF oracle: box rolls, lottery draws, and `roll`, which gives the authority a labelled random number for any rule of its own.

A project has two keys, its owner and its authority, and both are trusted, as is whoever controls its collection: the project's own keys are part of the project. The program keeps players safe from each other, from the platform and from mistakes, not from the project they chose to play. Within that, who signs is the whole security model:

- A player signs what they pay, and the most they agree to pay.
- The game's **authority** key signs everything that leaves a pool or gets made on the game's say-so. The program checks that signature and nothing else. There are no caps. It cannot pay out of the vaults that hold open orders, a stake's vaults or a contest's pot, and it cannot move a held collectible once its hold is over. In a contest it writes the terms every entry signs, and names the winning side.
- The game's **owner** signs its settings and writes every mechanic, because a mechanic can move a pool or mint. It also writes the catalog: every item and box.
- The platform signs only its own fee (setting it, collecting it) and the suspend switch. Nothing it can sign stops a payout, a settle, a refund or an unstake.
- Anyone may finish what is already decided: `settle`, `settle_prize`, `refund`, `run_schedule`, `draw_lottery`, `pay_lottery`, `take_back`, `claim`, `call_off` (once a contest's result is overdue), `close_contest`, `recheck_token`.

## Where to read

Read `lib.rs` first: it lists every instruction under its group. Each mechanic is one file that reads top to bottom: its account, then its instructions.

| File | What is in it |
| --- | --- |
| `src/lib.rs` | every instruction, grouped; the security model in its header |
| `src/state.rs` | the five core accounts, then their tests |
| `src/rail.rs` | the fee, the split, and the one function that sends a share where it says |
| `src/tokens.rs` | the five token moves the program makes, each one call |
| `src/receipts.rs` | every receipt |
| `src/instructions/pay.rs` | `pay`, `deposit` |
| `src/instructions/payout.rs` | `payout`, `burn` |
| `src/instructions/make.rs` | `issue`, `make`, `unmake`, `set` |
| `src/instructions/roll.rs` | `roll`, `callback_random` |
| `src/instructions/order.rs` | `buy_item`, `open_box`, `callback_roll` |
| `src/instructions/settle.rs` | `settle`, `settle_prize`, `refund` |
| `src/instructions/schedule.rs` | `upsert_schedule`, `run_schedule` |
| `src/instructions/lottery.rs` | `upsert_lottery`, `buy_tickets`, `draw_lottery`, `callback_lottery`, `pay_lottery` |
| `src/instructions/stake.rs` | `open_stake`, `stake`, `unstake` |
| `src/instructions/craft.rs` | `upsert_recipe`, `craft` |
| `src/instructions/hold.rs` | `hold`, `take_back`, `award` |
| `src/instructions/contest.rs` | `open_contest`, `enter`, `decide`, `call_off`, `claim`, `close_contest` |
| `src/asset.rs` | reading a collectible: who holds it, which item it is one of, the numbers written on it |
| `src/instructions/game.rs` | `create_game`, `update_game`, `open_pool`, `close_pool` |
| `src/instructions/catalog.rs` | `upsert_item`, `upsert_box` |
| `src/instructions/platform.rs` | `init_platform`, `set_platform`, `collect_fees`, `set_suspended` |
| `src/rent.rs`, `pick.rs`, `core_cpi.rs`, `constants.rs`, `error.rs` | helpers: account sizing, the weighted pick, the four Metaplex Core calls, numbers, errors |
| `src/venue.rs`, `instructions/token.rs` | the registry (official tokens: launched with games.fun, paying it at least 5%). Not part of the economy, and not a gate to it; as in 0.2 except the split, 95/5 |

The source was 6,795 lines (7,057 after the four pieces, 7,371 with Token-2022 and the two fees), of which `venue.rs` is 567 and tests inside the source files about 600.

## Accounts

| Account | Address | Holds | Who pays its rent |
| --- | --- | --- | --- |
| Platform | `platform` | admin, partner, the fee and a pending raise. A game's transactions only read it | us, once |
| Game | `game`, collection | owner, authority, collection, mint, treasury, paused, suspended, official token. A purchase only reads it | owner |
| Fee box | `fees`, game | nothing but SOL: the platform's fees on the game's transactions, until the platform collects them | owner, once, at `create_game` (0.00065 SOL, devnet and mainnet rent read on 2026-10-12) |
| Pool | `pool`, game, index | nothing of ours: a plain token account that only the game can spend | owner |
| Item | `item`, game, id | kind, rarity, soulbound, burnable, supply, issued, voided, price, how the price rises, its life, active, its split, name, URI | owner |
| Box | `box`, game, id | price, the mint it is in, how it rises, active, opened count, its split, up to 8 drop entries | owner |
| Order | `order`, game, player, nonce | one purchase, and the mint it was paid in, until it is settled or refunded | player, returned |
| Schedule | `schedule`, game, id | what it does, how often, when next, runs so far | owner |
| Lottery | `lottery`, game, id | price, pot, cut, timing, round, winner; then 40 bytes per purchase of the round | owner; each buyer pays their line; first place gets the lines' rent when their wallet can take it, or else it stays and pays the next round's first lines |
| Stake | `stake`, game, id | the staked mint, the rewards pool, the total staked, rewards per token; plus two token vaults | owner |
| Position | `position`, stake, player | one player's stake | player, returned when they unstake everything |
| Recipe | `recipe`, game, id | its version, up to 8 lines in and 8 lines out | owner |
| Hold | `hold`, asset | the player, when the authority's say ends, the game's label | player, returned |
| Contest | `contest`, game, id | the mint, the two deadlines, the verdict, what each side put in, its shares; plus its pot, a token vault | the authority that opened it, returned when it closes |
| Entry | `entry`, contest, player, side | what one player put on one side | player, returned at claim |

Every account is as big as what it holds and no bigger. A pay, a payout, a deposit, a schedule run and a craft or a make of tokens create no account, so they cost no rent. Making a collectible creates its Core asset, whose rent the caller pays. The first purchase in each mint creates the game's vault for that mint, and that buyer pays its rent.

## What a box can give

Each entry of a box has a weight and one of four outcomes. The roll picks one, and the program carries it out.

| Outcome | What happens |
| --- | --- |
| An item | `settle` mints the collectible to the player (a normal item is settled by the game's owner or authority, once its backend delivered it) |
| Pay an amount from a pool | `settle_prize` pays it to a token account the player owns |
| Burn | `settle_prize` burns the player's whole payment, in place of the box's split |
| A share of a pool | the roll turns it into an amount: a share (basis points) of what the pool holds at the roll. From there it is paid like a fixed prize. A jackpot that grows until someone hits it |
| Nothing | `settle_prize` splits the payment as usual |

A box can be priced in any mint (`currency`): the payment waits in the game's vault for that mint, and a refund returns the same token. The game's treasury only holds the game's own mint, so a box in another one must have shares that take the whole payment. A box or a shop item can also carry a `rise`: after each sale the price becomes `price + step + price × growth ÷ 10,000`. The buyer's `max_price` still holds, so a sale that lands after the price moved is refused.

A box or a shop item can also carry a `fall`: from `since`, its price falls by `step` every `every` seconds, never below `floor`. Each sale after `since` pays the fallen price, takes any `rise` from there, and starts the fall again at the time of the sale. With a fall alone it is a drop whose price comes down until it sells; with both it is a price that climbs with demand and cools off while nobody buys. A price that falls to 0 is no longer for sale.

A box with `stock_odds` scales each item's weight by the share of its supply still left, rounded up, so the last of an item can still be won: the last mythic of 100 is a hundred times rarer than the first. Items with no supply limit, and the other outcomes, keep their weight.

An order is only ever rolled on the version of the box it paid for: if the owner edits the box in between, the order fails and can be refunded from the next slot.

An order never closes (settles or refunds) in the slot it was opened in. Its collectible's address and its oracle ticket are made from the order's address and that slot, and a player can open a new order at the same address once the old one is closed; this way two orders at one address never share a slot, so never a collectible or a ticket (audit L3).

The roll skips what cannot be won at that moment: an item that is sold out, and a prize its pool does not hold. If nothing is left, the order fails and refunds from the next slot. If a pool is emptied between the roll and the settle, the settle fails and the order refunds after 7 days.

## The other mechanics, in a few sentences each

- **Schedule.** Every `every` seconds, one run. `Issue` mints an amount into a pool, and the amount can halve every N runs. `Burn` and `Move` take a share of whatever the pool holds at that moment. A schedule that fell behind catches up one call at a time. `max_runs` ends it, and `active` switches it off.
- **Lottery.** Ticket money goes to the pot (a pool), less a cut to the treasury. When the draw is due, anyone asks the oracle; its number picks first place's ticket, and up to 7 more places follow at even steps around the list of tickets from it, so no ticket wins twice and every ticket has the same chance at every place. Each place takes its share of what the pot held when the first payment of the round was made, whichever place it paid (so a deposit between the draw and that payment raises every place), or what the pot still holds if that is less (by default one place of 100%: the winner takes all). Anyone pays each place on its own; the last payment gives the rent of the list to first place and opens the next round. A round with fewer tickets than places has fewer winners, and whatever the places leave stays in the pot for the next round. If the oracle does not answer in about 10 minutes, anyone asks again and only the newest request counts. A lottery can sell its tickets in another token than its prize (`ticket_mint`): those tickets are burned, and the pot is filled from elsewhere. The owner can only change a lottery between rounds. Its period and its first draw date must be within about 1,000 years, so the next draw's date can always be counted.
- **Stake.** Whatever arrives in the rewards pool is credited to everyone staked the next time anyone stakes or unstakes, each by their share. A stake has a lock, set when it is opened: nothing comes out until it has run since the position's last stake. Set it at least as long as the gap between rewards, and give the stake a rewards pool of its own. Staked tokens and credited rewards sit in two vaults the authority cannot pay out of. A stake cannot be edited once it is open. `unstake(0)` only collects rewards. `unstake` with `forfeit` gives up the rewards owed and pays out the principal alone: the way out when the rewards cannot move, a rewards vault frozen by its mint's freeze authority.
- **Recipe.** Up to 8 lines in and 8 lines out, and everything named happens in one transaction or none of it does. A line in is: collectibles of an item that are burned, one collectible that is used and kept, or an amount of a token that is burned or sent where a share could send it. A line out is: one new collectible, an amount of a token that is minted or paid from a pool, or a share (basis points) of what a pool holds at that moment; a recipe with a share is crafted once at a time. The player signs the recipe's version, so an edit that lands first cannot change what they agreed to. An item switched off (`active` false) is not made by a recipe, as it is not sold or dropped; the authority's own `make` still makes it. The program recognises a collectible by its owner, its collection, its name (always "<item name> #<serial>") and the item number written on it, which the authority's `set` never changes. A recipe has no chance in it: for that it gives a token that a box is priced in, and the box rolls. A recipe of tokens only is an exchange at a fixed rate and can be crafted many times at once (`times`): this is what the converter was. A recipe can ask that a number the authority wrote on a handed-in collectible is at least so much (`needs`: a hero of level 10), a new collectible can take named attributes from one handed in (`keeps`: a foal with its mother's coat), and a `Renew` line keeps a collectible and counts its uses from zero again (a repair; the cooldown still counts from its last use).
- **A collectible's life.** An item can say when a recipe may take one of it: not until `ready_after` seconds after it was made (an egg), not once `lasts` seconds have passed (milk), at most `uses` times when it is used and kept (a mare, a mine), and not more often than every `cooldown` seconds (a daily pass). The program writes `made`, `used` and `used_at` on the collectible itself, as attributes a wallet shows. An item with no life that a recipe uses only has to be held: a licence. An item's life cannot change once one is issued. The authority's `set` keeps these three numbers unless it names them. One collectible fills one place in a craft.
- **Hold.** The collectible itself moves to the game, so it cannot be sold or crafted meanwhile. The player chooses the seconds. Until they are up, the authority can `award` the collectible to anyone (back to the player early, or to whoever won it) but the game itself, which could never move it on. After that the authority can do nothing and anyone can send it home with `take_back`. The authority can never `unmake` a collectible the game is holding. The way home goes through Metaplex Core, so whoever controls the game's collection there could make Core refuse it: that is the project itself, which is trusted. A hold of zero seconds is no lock at all: anyone can send it home in the same slot. A soulbound collectible cannot be held.
- **Contest.** The authority opens one with a number of sides, a time entries close and a time a result is due. Players `enter` on a side, as often as they like, and each entry names the hash of the contest's terms it saw (`Contest::terms`), so it cannot land in another contest opened at the same id. `decide` names the side that won, no later than the result was due: the contest's shares leave the pot (a rake that is burned, a cut to a pool, a share for whoever holds the arena) and the rest is the prize, split by what each winner put in; the last winner to claim also takes the rounding. `call_off` gives every entry its own money back, with no cut: the authority can do it while the contest is open, and anyone can once the result is overdue. Naming a side nobody backed is refused. A contest cannot be edited.

## The split

A split is a list of up to four shares. Each share is a number of basis points (10,000 is the whole) with a destination: burned, one of the game's pools, a named token account (a partner, a creator), or whoever holds a named collectible at that moment (the owner of a plot, a stud, an arena). Whatever the shares leave goes to the game's treasury.

A share for a holder must be paid into a token account that holder owns; whoever sends the transaction cannot point it elsewhere. When nobody holds the collectible (it was burned, or the game is holding it), that share is burned. The owner writes the split of an item and of a box; the authority writes a contest's. Wrapped SOL cannot be burned, so a split in it that is carried out later (a sale, a box, a contest) takes no share that burns. Shares round down, so the treasury also gets the rounding.

- An item and a box each carry their own split, set by the owner. An order copies it at purchase, so a later edit does not touch a paid order.
- When the shares take the whole payment, the last one also takes the rounding, so nothing is owed to the treasury.
- `pay` takes its split from the transaction the player signs. The app that asked for the payment reads the receipt and admits the player when the amount, the split and the reference are the ones it asked for.

## The fee

There are two flat fees in SOL, so that a project paying out to ten thousand players does not pay a fortune for it, and each player only sees their own fee once:

| Fee | Starts at | Charged on the spot by | Why |
| --- | --- | --- | --- |
| **Player fee** | 0.002 SOL (`PLAYER_FEE_LAMPORTS`) | `pay`, `buy_tickets`, `stake`, `unstake`, `craft`, `hold`, `enter`; and `buy_item`, `open_box` through the order | a player signs for something of their own |
| **Project fee** | 0.00001 SOL (`PROJECT_FEE_LAMPORTS`) | `deposit`, `payout`, `burn`, `issue`, `make`, `unmake`, `set`, `roll`, `award`, `open_contest`, `decide` | everything else that is charged: an airdrop of 10,000 payouts costs 0.1 SOL in fees |

An order pays the player fee once: it waits in the order's escrow, goes to the game's fee box at settle, and goes back to the player at `refund`. `deposit` is at the project fee because a deposit is how a project or a sponsor funds a pool, even when a player sends it.

Finishing what is already decided is free of our fee, or nobody would do it: `run_schedule`, `draw_lottery`, `pay_lottery`, `take_back`, `call_off`, `claim`, `close_contest`. Whoever sends `draw_lottery` still pays MagicBlock's oracle fee (about 0.0005 SOL), as whoever asks for any roll does.

Fees collect in each game's own fee box, `["fees", game]`: an account the program owns that holds nothing but SOL, created by `create_game` (the owner pays its rent once). The platform admin takes them out with `collect_fees`, passing each game and its box; each keeps its rent. No account is written by every game's transactions: the platform record is only read, for the amounts, and a purchase only reads the game record. So one game's traffic never queues behind another's, as it did when every charged instruction wrote the platform record (audit L4: about 200 charged transactions a block for the whole program). There is no fee wallet to point somewhere unwritable, so the platform cannot stop a payout by breaking the fee.

Each fee is capped at 0.01 SOL (`MAX_FEE_LAMPORTS`). `set_platform` takes both: if it raises either one, the pair waits 7 days together; if it raises neither, it applies at once and drops any raise that was waiting. `init_platform` takes the fees to start with; the two constants are the defaults.

## Token-2022

Every token the program moves can be a classic SPL token or a Token-2022 token, in any role: a game's currency, a box's currency, a pool, a stake and its rewards, a contest's pot, a recipe's lines, a lottery's pot or tickets. All token calls are in `tokens.rs`, written out by hand (the two programs share the instructions used, byte for byte), and each goes to the program that owns its mint. So every instruction that moves tokens takes both programs (`token_program`, `token_2022_program`), and each one names the mint of every token it moves.

| Token-2022 brings | What the program does |
| --- | --- |
| Transfers must be checked for mints with a fee or a hook | every transfer is `TransferChecked` (the classic program takes it too) |
| A **transfer hook** runs on every transfer of its mint, with extra accounts it names | the hook's accounts come at the end of the instruction's remaining accounts, after whatever the instruction itself reads there; every Token-2022 transfer hands them all on, and Token-2022 takes the ones its hook names by address. The hook gets no signature of ours, even when the game signs the transfer and the hook's list asks for the game as a signer: Token-2022 calls a hook with no signer at all (`tests/token_2022.rs` checks it). A hook can refuse a transfer, as a freeze can |
| A **transfer fee** keeps part of what is sent | where the program writes an amount down, it writes what arrived: what an order paid, what a player staked, the rewards a stake credits, what an entry put on a side. So every account the program keeps can pay out what it owes. Payouts arrive less the fee, as any transfer of that mint does |
| Fees the mint withholds sit in the receiving account, and block closing it | before closing a pool or a contest's pot, the program sweeps them to the mint (`HarvestWithheldTokensToMint`, which anyone may do) |
| An account of a Token-2022 mint can need more than 165 bytes | pools, stake vaults and pots ask Token-2022 their size (`GetAccountDataSize`); the vaults and player accounts are associated token accounts, which the associated token program sizes |
| An account's owner can **require a memo** on every transfer into it | a transfer into such an account first sends a memo through the Memo program, which the sender passes with the hook's accounts (`MemoNeeded` without it). So nobody stops what is owed to them, or anyone else, by turning memos on |
| A multisig of either program has no type byte | an account of its length (355 bytes) is never read as a token account or a mint |
| Token-2022 wrapped SOL | treated like classic wrapped SOL: no share that burns it |
| Everything else (a permanent delegate, a default frozen state, a pause, non-transferable, interest, metadata, confidential balances) | the mint's own business, as a classic mint's freeze authority already is. A permanent delegate can move tokens out of the game's own accounts, a frozen or paused account stops transfers in and out, and a hook decides each transfer for itself (it can refuse an order's settle and let its refund through 7 days later, as freezing the box's pools for 7 days could); the project chose the mint |

A recipe and a box no longer refuse accounts after their last line: those are for a hook. An extra account there is handed to the hook, if any, and to nothing else.

## Building blocks

A list of 50 economies people would want (burning, merging, rarity mints, breeding, raids, betting) was the test: how far does the program get with no rule written for any one of them? Seven pieces were missing, each general, and each is now in the program:

| Missing piece | What was added | Economies it opens |
| --- | --- | --- |
| One recipe for any mix of things | `craft`: collectibles and tokens in, collectibles and tokens out; it replaced `merge` | salvage, a shop in any currency, multi-part sets, breeding, daily claims |
| Chance on a craft | a box priced in any mint (`currency`): the recipe gives the token, the box rolls | gem fusion, risky upgrades, pity counters |
| Paying a player as a share | `To::Account`, `To::Holder` | stud fees, land that earns, a recipe's finder, an arena's owner |
| A price that is a formula | `Rise` on items and boxes | bonding-curve mints, a throne that costs more each time |
| State on an item the program can check | `Life`: ready after, lasts, uses, cooldown | eggs, rot, mortal pets, breed counts, mines that run dry, daily turns |
| Holding and moving an item | `hold`, `award`, `take_back` | raids with real loot, heists, lending |
| The game names an outcome without touching the money | `open_contest`, `enter`, `decide`, `claim`, `call_off` | duels, betting on a match, faction seasons, tournaments |
| A recipe that looks at what the game wrote | `needs`, `keeps`, `Renew` | rebirth at max level, traits passed on, repairs and refills |
| A prize in another token than the ticket | `ticket_mint` on a lottery | a ticket per monster killed, drawn for a pot of coins |

How the pieces go together, with no new rule for any of them:

- **A craft left to chance.** A recipe burns three gems and gives one "attempt" token. A box priced in that token gives the big gem half the time. A failed roll that never arrives refunds the attempt.
- **A pity counter.** The recipe that sells a pull also gives a pity token; a second recipe turns 50 pity tokens into the epic.
- **A daily claim.** A soulbound pass with a cooldown of a day, used and kept by a recipe that pays one coin from a pool.
- **A stud fee.** The stud's holder crafts a "cover" token from the stud (used and kept, so many times, so often) and sells it; the breeder's recipe takes a mare and a cover and gives a foal.
- **Staking things that are alike.** A recipe burns a sheep for one share token and another gives it back; the share token is staked like any other.
- **An exchange.** A recipe that burns 2 gems and mints 3 points, crafted 500 times in one transaction. The separate converter mechanic was removed for this: two instructions and one kind of account less. The shop (`buy_item`) was looked at and kept, because a sale opens an order: a normal item is delivered by the game's backend before it is settled, anyone can settle a collectible for the buyer, and what a split leaves goes to the treasury.
- **A pet that must be fed.** The pet lasts a day. The feeding recipe burns it with some food and gives a new one.

## What changed from 0.2

| Change | Why |
| --- | --- |
| The fee is a flat amount of SOL, not a percent in the sale's token | simpler: no fee token account per currency, no fee rounding rule |
| `authority` on the game; `payout`, `burn`, `issue`, `make`, `unmake`, `set`, `roll` | the out and make verbs, and a random number for any rule |
| Pools, `open_pool`, `close_pool`, `deposit` | named vaults for prizes, rewards and stakers |
| A split per item, per box and per `pay`, replacing the game's one burn rate | money in can feed pools |
| Box entries are outcomes; `settle_prize` | a box can pay, burn or give nothing, with nobody's signature |
| Schedules, lotteries, stakes, recipes (a converter was written too, and later folded into the recipe) | the authority is needed only for game-time decisions |
| `burnable` on an item | only a burnable collectible can be unmade by the authority |
| `Game.authority` (0.2) is now `Game.owner` | the owner signs settings, the authority signs payouts |
| One-byte tags on every account; fixed fields first on an item | 7 bytes less rent each; a box roll reads items at fixed places |
| `migrate_platform`, `migrate_game`, `apply_pending_fee` and the 0.1 layouts are gone | a clean start |
| A roll carries the ticket of its own request; a collectible's address includes the slot of its purchase | an address is free again once its account closes, and a reused one must not inherit a late roll (first review) |

Kept as they were: the order flow with its ways out (a failed roll, a roll that never arrives after 1,500 slots, an unsettled order after 7 days), `max_price`, the authenticated oracle callback, the suspend switch that never stops what is owed, and the registry.

## Size

0.3.2 is 852,896 bytes, against 505,136 for 0.2, with 49 instructions against 19. A recipe at its limits fits in one
transaction, with the compute limit raised above the default 200,000: eight collectibles burned for one took 888 bytes
and about 198,000 compute units; four burned and four used for two new ones and tokens took 1,154 of the 1,232 bytes
and about 337,000. A contest entry took about 45,000 and a hold about 33,000. `tests/costs.rs` measures every
instruction and account; `COSTS.md` has the numbers.

## Reviews and audit

0.3 was reviewed several times by independent reviewers (the base, everything added after it, the building blocks,
the fixes of each review, the four pieces from the list of 100 economies, Token-2022 and the two fees), and then
audited in full: every instruction's accounts, signers and state, and attempts to fake accounts to take value. The
audit found no Critical, High or Medium, 4 Lows and 12 notes. Each finding has a test that checks its fix; the tests
are in the feature files under "Run it". The fixes after the last review are not reviewed again.

| # | Finding | Now |
| --- | --- | --- |
| L1 | The token programs accept a transfer into the account it comes from. A staker who named a stake's vault as their own account had rewards or principal marked paid while the tokens stayed put; a recipe's output sent back to its pool was a no-op | fixed: the game paying into the account it pays from is refused (`tokens::transfer`). A player paying themselves, a share that comes back to the holder who pays it, still nets to zero. A schedule that moves a pool into itself is refused when written |
| L2 | Refunding limited-supply orders in purchase order burned supply: only the last serial came back | fixed: a serial that cannot be taken back is counted in `Item.voided`, and the supply counts `issued - voided`. Those numbers stay gaps, so after a void a later serial can be above `max_supply` (a serial is a number, not a count; a page showing "#n of max" should show the units out instead) |
| L3 | A re-buy at the same nonce in the slot an order closed in landed on the first order's collectible address and ticket | fixed: an order never closes in the slot it was opened in, so two orders at one address never share a slot. The audit proposed a counter; this needs no new field and no write to the game |
| L4 | Every charged instruction of every game wrote the one platform record: one lane for the whole program, about 200 charged transactions a block | fixed: each game's fee box (`["fees", game]`), the platform record only read, `Game.orders` dropped so a purchase only reads the game; `settle` and `settle_prize` pay the order's fee straight into the box. Each game now has a lane of its own: one very busy game still meets the same ceiling of about 200 charged transactions a block, but no longer slows any other |
| N1 | MagicBlock's test queue was accepted beside the default queue | fixed: only the default queue |
| N2 | `Deposited` and `Paid` named what was sent, not what arrived | `Deposited` now names what arrived; `Paid` keeps what the player signed, and says each place gets its part less the mint's fee |
| N3 | After 7 days a stranger can refund a rolled order that could still settle | by design, unchanged |
| N4 | `Item.active` did not stop recipes | fixed: a recipe does not make an item switched off; `make` still does (the authority's own act) |
| N5 | A lottery whose next date overflowed could never end its round | fixed: period and first draw within about 1,000 years, and the date is counted with checked arithmetic |
| N6 | A frozen rewards vault held the principal too | fixed: `unstake(amount, forfeit)`; with `forfeit` no reward token moves |
| N7 | `award` to the game and `make` to the game stranded the collectible | fixed: both refused (`ToTheGame`) |
| N8 | `make` and a craft's collectible fail on a pre-funded new asset key | unchanged: only a front-runner of the signed transaction can do it, and the sender retries with another key |
| N9 | Tokens sent straight to a contest's pot mostly go to the winners, not to a burn | the comment in `contest.rs` now says what happens |
| N10, N11, N12 | A contest's `result_by` is unbounded; a mint whose accounts start frozen; `pay` lets a player route their own money anywhere | by design, unchanged |


Not done from the audit: its other optimisations (stored bumps, a cheaper `craft`, close instructions for items,
boxes, recipes, schedules, lotteries and stakes), and a recipe of 8 collectible outputs that no legacy transaction can
carry.

## 0.3.2 cleanup

No account layout changed from 0.3.1, so 0.3.2 went out as an in-place upgrade; the IDL changed for four instructions.

- **A schedule starts no earlier than now.** `upsert_schedule` stores `next_at = max(next_at, now)`. A start in the past, or 0, used to let anyone send one run per missed period, back to back.
- **Handovers need the new key's signature.** `set_platform` takes the next admin as a signer account; `update_game` takes an optional `new_owner` signer. A mistyped key can no longer take the platform or a game.
- **`take_back` takes only what it uses**: no platform record, no fee box, no `to` (the collectible goes to the hold's player, which `has_one` already pins). `settle_prize` lost a signer it never read; `callback_random` reads the game's key without loading the record.
- **`Game` and `Platform` are taken by owner and tag.** Only `create_game` and `init_platform` create them, each at its own address, so the 45 constraints that derived the address again are gone (a test shows a copy owned by another program is refused). Signing still uses the stored bump. This is most of the saving below.
- `Game::open_for_money` replaces seven copies of the paused and suspended checks; clippy is clean.
- Comments say what and why. The tests are grouped by feature (the table under "Run it"): 295 pass.

The binary went from 905,320 to 852,896 bytes (-5.8%), about 0.365 SOL less rent.

## Not done, and open

- **0.3.1 was deployed fresh, not as an upgrade of 0.3** (`88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM`, which is
  left as it was): the audit's fixes changed the `Game` and `Item` layouts. A devnet run with the real MagicBlock oracle
  passes: boxes rolled by the oracle, a lottery with two places, a stake, a box priced in a Token-2022 coin with a 1%
  transfer fee, and the game's fee box holding exactly the run's fees until `collect_fees` sweeps them.
- **Payout by voucher and a limited keeper key** are not built. Both would shrink what the authority's signature can
  do for game-time decisions.
- **Not built in the mechanics:** staking weighted by lock time or by held items, an exchange with vesting, a trait
  picked by chance from two parents, a family tree, a forced sale (a throne or land that anyone can buy from its holder
  at a price), a buy-back along a rising price, "the last buyer wins when the timer runs out", an auction, a payout of
  1/N of a pool where N is what is left of an item (the program cannot count burns: a holder can burn a collectible
  through Metaplex Core directly), and taking anything from a wallet with no signature.
- **An authority that is another program's address** must be a plain system address holding SOL, because it pays the
  flat fee with a system transfer.
- **`create_game` checks two things about the collection** (its update authority is the owner who signs, and it has no
  permanent freeze, transfer or burn delegate) and not that the collection lets the game mint. The owner grants that on
  the collection (an update delegate) and can take it back. Without it, collectible orders wait 7 days and refund.
- **Chosen limits:** the 0.01 SOL fee cap, four shares per split, eight lines a side and eight collectibles per recipe.

## Run it

```bash
cd program/loot
scripts/fetch-fixtures.sh        # once: the Metaplex Core and MagicBlock VRF programs, and the test hook
cargo build-sbf && cargo test    # the tests load target/deploy/loot.so
```

| Test file (by feature since 0.3.2) | What it proves |
| --- | --- |
| `tests/orders.rs` | shop orders: buy, settle, refund, nonces, serials, prices that rise and fall |
| `tests/boxes.rs` | loot boxes: the oracle's roll, odds and stock odds, prizes from pools, edits after a purchase |
| `tests/payments.rs` | `pay` and the split: shares to pools, accounts, holders and the treasury, wrapped SOL |
| `tests/pools.rs` | pools: open, close, deposit, and the authority's payout, burn and issue |
| `tests/collectibles.rs` | the authority's `make`, `unmake` and `set` |
| `tests/stake.rs` | staking: positions, the lock, rewards |
| `tests/contest.rs` | contests: entries, a result or a call-off, claims, the close |
| `tests/lottery.rs` | lotteries: tickets, the draw, places, rounds |
| `tests/craft.rs` | recipes: collectibles and tokens in and out, life, needs, keeps, exchanges |
| `tests/hold.rs` | holds: `hold`, `award`, `take_back`, and what the collection's owner can do to them |
| `tests/schedule.rs` | schedules: emissions, burns, moves |
| `tests/platform.rs` | the platform and a game's settings: fees, switches, handovers, the catalog, forged records |
| `tests/registry.rs` | official tokens on real venue bytes (Meteora, pump.fun), the 95/5 bounds |
| `tests/token_2022.rs` | Token-2022: transfer fees, hooks, required memos, fake mints and multisigs |
| `tests/costs.rs` | compute units and rent of every instruction and account |

The tests of every review and of the audit are in the feature files above.
