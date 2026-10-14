# loot 0.2: what it costs

Rent first, compute second: rent is paid once per account by whoever creates it and adds up across every game and player, so it is optimised first, then compute units.

**Status: measured locally, on the binary that is on devnet since 2026-10-11 UTC** (505,136 bytes, sha256 `a6a91ca15251597b7ac91fb0eab99d056a6e8dd4a69f227f041d98a059e8febd`; `BUILD.md` shows it is what this source builds). Nothing is on mainnet. "0.1" is the program at commit `7fb9424ce`, which built to the 591,512 bytes that were on devnet before. "0.2" is this branch, after the fixes for the security review of 2026-10-10 (`REVIEW-2026-10-10.md`).

How to repeat every number here:

```bash
cd program/loot && scripts/fetch-fixtures.sh && anchor build
cargo test --test flow cost_table -- --nocapture       # account sizes, compute units of the 0.1 instructions
cargo test --test v2 cost_table_v2 -- --nocapture      # compute units of the 0.2 instructions
cargo test --test flow cost_breakdown -- --nocapture   # where the units go, inner programs included
ls -l target/deploy/loot.so
```

- **Rent** is `(bytes + 128) × 5,080` lamports, the rate devnet answered on 2026-10-10 (`solana rent <bytes> --url devnet`, checked for every size below). LiteSVM uses the older 6,960 per byte, so the lamports the tests print are higher; the bytes are the same. Mainnet's rate was not read.
- **Compute units** are whole-transaction units from LiteSVM with fixed keys (the same keys in 0.1 and 0.2, so PDA bump searches cost the same). The inner programs are the real Metaplex Core, MagicBlock VRF and SPL Token binaries.

## 1. Account rent

| Account | Who pays | 0.1 bytes | 0.1 lamports | 0.2 bytes | 0.2 lamports | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `Platform` (one, ever) | us | 75 | 1,031,240 | 117 | 1,244,600 | +213,360 |
| `Game`, no admins, no token | creator | 280 | 2,072,640 | 147 | 1,397,000 | −675,640 (−33%) |
| `Game`, with an official token | creator | (not possible) | | 180 | 1,564,640 | |
| `Game`, 4 admins and a token | creator | 280 | 2,072,640 | 308 | 2,214,880 | +142,240 |
| `ItemDef`, 11-character name, 40-character URI | creator | 305 | 2,199,640 | 124 | 1,280,160 | −919,480 (−42%) |
| `ItemDef`, longest name and URI (32, 200) | creator | 305 | 2,199,640 | 305 | 2,199,640 | 0 |
| `LootBox`, 2 entries | creator | 130 | 1,310,640 | 82 | 1,066,800 | −243,840 (−19%) |
| `LootBox`, 8 entries | creator | 130 | 1,310,640 | 130 | 1,310,640 | 0 |
| `Order` (returned to the player at settle or refund) | player | 174 | 1,534,160 | 174 | 1,534,160 | 0 |
| A `pay` payment | player | (no such instruction) | | 0 | 0 | |
| Game vault (token account, once per game) | first buyer | 165 | 1,488,440 | 165 | 1,488,440 | 0 |
| Fee wallet's token account (once per mint) | first settler | 165 | 1,488,440 | 165 | 1,488,440 | 0 |

Sizes in 0.2: `Game` = 147 + 33 if it has a token + 32 per admin. `ItemDef` = 73 + name + URI. `LootBox` = 66 + 8 per entry.

**A small shop** (one game, the three items and the two-entry box of the tests): 9,982,200 lamports in 0.1, 6,314,440 in 0.2. That is 3,667,760 lamports less (−37%).

What changed, and why each is safe:

- **Sized to content.** 0.1 reserved 232 bytes of strings per item, room for 8 entries per box and 4 admins per game, used or not. 0.2 creates each account at the size of what it holds and resizes it on every edit (`state::fit`): growth is paid by the admin who edits, a shrink pays the surplus back to them. Limits are unchanged (32, 200, 8, 4).
- **No new account anywhere.** The registry is two fields on `Game`. `pay` writes nothing and emits an event. `recheck_token`, `set_suspended`, `apply_pending_fee` create nothing. A cleared token leaves its 33 bytes allocated until the creator's next `update_game` or `attach_token` (a permissionless instruction moves no lamports).
- **`Game` has a one-byte discriminator** (7 bytes, 35,560 lamports per game). It needed a new discriminator anyway (see section 5); a unit test checks that it differs from the first byte of every other account type.
- **`Platform` grew by 42 bytes**, once: the pending fee (10 bytes) and the launch partner (32 bytes).
- **0.1 accounts get their rent back.** `migrate_game` returns 675,640 lamports to each game's authority; the next `upsert_item` or `upsert_box` on a 0.1 item or box returns the padding. Devnet holds 14 games, 24 items and 9 boxes from 0.1 (read 2026-10-10).

## 2. The program binary

| | Bytes | Rent (lamports) | SOL |
| --- | ---: | ---: | ---: |
| 0.1 (on devnet until 2026-10-10) | 591,512 | 3,005,759,800 | 3.0058 |
| 0.2 features on 0.1's build profile and dependencies, before any size work | 684,176 | 3,476,492,920 | 3.4765 |
| **0.2 as shipped** (sha256 `a6a91ca1…e8febd`) | **505,136** | **2,566,969,720** | **2.5670** |

0.2 does more than 0.1 (19 instructions against 11) in 86,376 fewer bytes: 438,790,080 lamports (0.439 SOL, −15%) less rent for a fresh deploy.

**On devnet this saved nothing.** The upgrade in place (2026-10-11 UTC) kept the 591,512 bytes already paid for: `solana program show` after it still reads `Data Length: 591512`, balance 3.0057598 SOL (`devnet-upgrade-0.2-result.json`). The saving is for the mainnet deploy. The upgrade needed no extra rent: a buffer of 2.567 SOL that came back when it was consumed, and 2,515,000 lamports of transaction fees.

**The build profile** (`Cargo.toml`): `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true` (kept on) for everything, and `opt-level = "s"` for the `loot` crate alone. `cargo-build-sbf` already strips the `.so`. Most of the size is Anchor's generated account validation, which lives in this crate, so optimising this crate for size takes most of what a size setting has to give, while the dependencies (borsh, the SPL helpers) stay fast.

The choice between size and compute: `"s"` is the middle setting, where every instruction 0.1 had costs the same or less compute than in 0.1 (section 3). The same source under the other two settings, for comparison:

| `loot` crate at | Bytes | Rent (SOL) | settle | buy_item | open_box | callback_roll | pay |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `"z"` (smallest) | 449,240 | 2.2830 | 83,637 | 48,339 | 69,267 | 15,073 | 31,986 |
| **`"s"` (shipped)** | **505,136** | **2.5670** | **78,696** | **43,574** | **63,970** | **11,862** | **29,793** |
| 3 (fastest; measured before the review fixes, expect about 5 KB more) | 548,744 | 2.7885 | 76,265 | 41,928 | 62,254 | 10,634 | 27,464 |
| 0.1, for reference | 591,512 | 3.0058 | 84,738 | 45,357 | 66,296 | 11,904 | (none) |

`"z"` would save another 55,896 bytes (0.284 SOL of rent, once) and costs about 5,000 compute units more on a sale.

What each change saved while the size work was done. These rows were measured with the crate at `"z"`, in the order the changes were made; "settle" is a collectible settle, the heaviest instruction:

| Step | Bytes | Change | settle CU |
| --- | ---: | ---: | ---: |
| 0.2 features on 0.1's profile (`opt-level` 3, fat LTO, 1 codegen unit) | 695,632 | | |
| Items and boxes created and resized by hand instead of `init_if_needed` | 684,176 | −11,456 | 85,274 |
| `opt-level = "z"` for everything | 574,616 | −109,560 | 105,265 |
| Fee share in 64-bit arithmetic (no `u128` division); box rolls read items without deserialising them | 571,728 | −2,888 | 105,026 |
| Treasury checked by address instead of deserialised | 571,224 | −504 | 103,766 |
| `opt-level = "z"` for this crate only, dependencies back at 3 | 572,968 | +1,744 | 92,978 |
| Metaplex Core `CreateV2` written by hand (no `mpl-core` crate); `ProgramData` read as raw bytes (no serde deserialiser, no float formatting) | 459,024 | −113,944 | 88,746 |
| Token accounts pinned by address, one shared "create if missing" helper, no `init_if_needed` | 444,560 | −14,464 | 83,614 |
| Features trimmed (`init-if-needed` off, `token_2022` only for the IDL build) | 444,512 | −48 | 83,614 |
| The review fixes (section 7) | 449,240 | +4,728 | 83,637 |
| The crate at `"s"` instead of `"z"`: the shipped binary | 505,136 | +55,896 | 78,696 |

## 3. Compute units

The shipped binary. Instructions 0.1 already had, same scenario and keys:

| Instruction | 0.1 | 0.2 | Change |
| --- | ---: | ---: | ---: |
| `init_platform` | 12,584 | 12,219 | −365 |
| `create_game` | 9,247 | 9,638 | +391 |
| `upsert_item`, new (three items; the spread is the PDA bump search) | 19,037 / 26,500 / 11,603 | 17,729 / 25,196 / 10,297 | −1,308 |
| `upsert_item`, edit | 16,942 | 9,192 | −7,750 |
| `upsert_box`, new, 2 entries | 10,653 | 9,386 | −1,267 |
| `open_box`, first of a game (creates the vault) | 90,628 | 88,258 | −2,370 |
| `open_box` | 66,296 | 63,970 | −2,326 (−4%) |
| `callback_roll` | 11,904 | 11,862 | −42 |
| `settle`, collectible, first of a mint (creates the fee account) | 107,603 | 101,550 | −6,053 |
| `settle`, collectible | 84,738 | 78,696 | −6,042 (−7%) |
| `settle`, normal item | 48,913 | 45,834 | −3,079 |
| `settle`, soulbound collectible from the shop | 90,063 | 83,677 | −6,386 |
| `buy_item` | 45,357 | 43,574 | −1,783 (−4%) |
| `refund` (a failed or stale box) | 26,371 | 24,990 | −1,381 (−5%) |
| `set_platform` | 3,845 | 5,043 | +1,198 |
| `update_game` | 5,161 | 8,578 | +3,417 |

New in 0.2:

| Instruction | CU |
| --- | ---: |
| `pay` | 29,793 |
| `attach_token`, Meteora | 11,773 |
| `attach_token`, pump.fun | 13,370 |
| `recheck_token`, Meteora | 7,691 |
| `recheck_token`, pump.fun (passes / clears) | 10,831 / 11,174 |
| `set_suspended` | 7,362 |
| `set_platform`, a raise stored as pending | 5,048 |
| `apply_pending_fee` | 4,430 |
| `migrate_platform` | 10,360 |
| `migrate_game` | 3,026 |
| `refund` of a rolled order after `ROLLED_REFUND_SLOTS` | 29,528 |

**The plain reading:** every instruction a player or the keeper sends costs less compute than in 0.1, in a binary 15% smaller. Three admin instructions cost more: `create_game` (+391), `set_platform` (+1,198: the notice period and its event) and `update_game` (+3,417: it resizes the game and settles its rent).

Of a collectible settle's 78,696 units, 35,658 are spent inside other programs (Core 21,661; three token instructions 13,997) and are not ours to reduce. `pay` is 13,997 units of token program and 15,796 of ours.

What was done for compute:

- Box rolls (`open_box`, `callback_roll`) read up to 8 items through `ItemView`, which parses the fixed fields in place: no strings allocated, and the roll writes the one changed counter instead of re-serialising the item.
- The fee split uses 64-bit arithmetic (`pick::share`, proven equal to the 128-bit formula in a unit test).
- The Core mint builds its instruction bytes directly: no `Vec<PluginAuthorityPair>`, no clones, no `format!`.
- Token accounts and mints the token program validates anyway are no longer deserialised by this program first; they are pinned by address.
- Every PDA this program owns stores its bump and is checked with it (as in 0.1). `Order` could not gain an escrow bump without changing its layout (section 5).
- `pay` loads two accounts of ours (`Game`, `Platform`), keeps `Game` read-only so payments in one game do not contend for a write lock, and creates nothing.
- Events are logs (`emit!`), not self-CPIs.

## 4. Not taken

Each of these was measured or sized. None is in the program. The byte and compute figures were measured with the crate at `"z"`; at the shipped `"s"` they will differ a little.

| Option | Would save | Why not |
| --- | --- | --- |
| Drop the PDA re-derivation of `Game`, `Platform`, `ItemDef` and `LootBox` on the hot paths and compare stored fields instead (an account of this program with the right discriminator can only have been created at its PDA) | 11,088 bytes (56,327,040 lamports); per call: `settle` −4,765 CU, `buy_item` −4,763, `pay` −3,217, `refund` −1,602 | Built and measured, all tests passed. It removes a check that is redundant only while no other bug exists. "PDA seeds verified" is part of the security bar, and this program will be audited: the auditor can take it. |
| Stop pinning the vault in `settle` and `refund` (the token program only lets the `Game` PDA spend from an account it owns) | 1,144 bytes; `settle` −3,128 CU, `refund` −3,125 | It is a safety check. With it, an order can only ever be paid out of the one account every payment went into. |
| Anchor's `no-log-ix-name` feature | 1,816 bytes; about 100 CU per call | It removes the `Instruction: X` log line that explorers, support and our own cost tables read. |
| Shrink `Order` by 40 bytes (drop `randomness` and `nonce`) | 203,200 lamports of deposit per open order | The deposit comes back to the player within seconds. Changing the layout would mean reading two layouts in `settle`, `refund` and the oracle callback, or stranding orders that are open during the upgrade. |
| Drop `game` (32 bytes) from `ItemDef` and `LootBox` (the PDA already implies it) | 162,560 lamports per item or box | The API lists a game's catalog with a `getProgramAccounts` filter on that field, and a box roll checks up to 8 items against it by comparing bytes instead of deriving 8 PDAs. |
| One-byte discriminators and one-byte string lengths for `ItemDef` and `LootBox` | up to 13 bytes, 66,040 lamports per item | It needs a migration for every 0.1 item and box. Keeping their encoding means they read as they are and shrink on their next edit, which saves about 180 bytes on a typical item with no migration at all. |
| Pack `paused` and `suspended` into one byte | 5,080 lamports per game | Two plain booleans in the IDL are worth one byte. |
| Share the purchase accounts of `open_box` and `buy_item` as one nested Anchor struct | unknown, not built | It reorders both instructions' accounts for every client. Worth trying before mainnet. |

## 5. Old accounts (A12)

Chosen per account type by what costs least in rent and compute:

| 0.1 account | 0.2 handling | Cost |
| --- | --- | --- |
| `Platform` (75 bytes) | `migrate_platform`, upgrade authority only, once: grows it to 117 bytes. Until then every instruction that reads the platform fails cleanly (the short account does not deserialise) and nothing is lost. | 10,360 CU and 213,360 lamports, once |
| `Game` (280 bytes) | `migrate_game`, permissionless, once per game: rewrites it in the 0.2 layout at its content size and sends the freed rent to the game's authority (or, when that would leave an empty authority wallet below its own rent-exempt minimum, keeps it in the game until the authority's next `update_game`; review L2). The 0.2 layout has its own discriminator, so no instruction can misread a 0.1 game (0.1 never cleared the tail of the account when the admin list shrank, so it cannot be trusted as padding). A keeper puts `migrate_game` in front of the first settle or refund of a game. | 3,026 CU, once; returns 675,640 lamports |
| `ItemDef` (305), `LootBox` (130) | Read as they are: same field order and encoding, zero padding behind the content. The next edit shrinks them. | nothing |
| `Order` (174) | Unchanged, byte for byte. | nothing |

Reading both `Game` layouts in every instruction instead would have cost compute on every sale forever, more program bytes, and left 133 bytes of rent locked in every old game.

Proof: `tests/v2.rs` `devnet_accounts_from_0_1_work_after_the_upgrade` loads the real devnet platform, the e2e game, its three items and its box (`tests/fixtures/v1/`), migrates, and settles a shop order, rolls and settles a box order and refunds a stale one that were open across the upgrade. Devnet had no open order on 2026-10-10, so those three are built in the unchanged `Order` layout. `migrate_game_with_admins_and_a_stale_tail` covers 0 to 4 admins with garbage in the tail.

## 6. Threat notes

What 0.2 adds, what defends it, and the test that tries to break it (`tests/v2.rs` unless noted; `venue::tests` are unit tests on real devnet account bytes).

**Who can do what**

| Instruction | Who | Enforced by | Negative test |
| --- | --- | --- | --- |
| `init_platform`, `migrate_platform` | the program's upgrade authority | `require_upgrade_authority`: the ProgramData address is derived from this program's id, never taken from the caller; owner is the upgradeable loader; authority present and equal to the signer | `another_programs_upgrade_authority_is_not_ours`, `only_the_upgrade_authority_creates_the_platform`, `devnet_accounts_from_0_1_work_after_the_upgrade` |
| `set_platform`, `set_suspended` | `Platform.admin` | `has_one = admin`, signer | `the_cap_holds_for_the_pending_rate_and_only_the_admin_sets_it`, `suspension_stops_sales_and_never_a_settle_or_a_refund` |
| `attach_token` | a game admin AND the token's launcher, both signing | `is_admin`; `Signer` on `launcher`, compared with the launcher the venue's accounts name | `attach_needs_the_launcher_signature_and_a_game_admin` |
| `recheck_token`, `apply_pending_fee`, `migrate_game` | anyone | each is fully determined by chain state; none moves lamports to the caller | `recheck_clears_only_a_token_that_stopped_passing`, `migrate_game_with_admins_and_a_stale_tail` |
| `pay` | the payer | `Signer`; the token program checks the payer may spend from the source account | `pay_refuses_wrong_accounts` |

**Account confusion defended**

- *A pool for another mint, a config from another pool, a look-alike owned by another program* (Meteora): the pool must be owned by the DBC program, carry the `VirtualPool` discriminator and exact length, and name the mint as its base mint; the config must be the address that pool names. `attach_cannot_be_fooled_by_other_accounts`, `venue::tests::meteora_wrong_accounts_are_errors_not_verdicts`.
- *Another coin's curve or sharing config, a look-alike at another address, a non-canonical bump* (pump.fun): both accounts must sit at the PDAs derived here from the mint with their canonical bumps, under pump.fun's two program ids. Same tests, and `venue::tests::pump_wrong_accounts_are_errors_not_verdicts`.
- *Clearing a passing token by passing other accounts*: `venue::judge` has three outcomes. Accounts that are not provably the venue's accounts for the recorded mint are an **error** and change nothing; only the venue's own accounts failing a rule is a verdict that clears. An empty account, a look-alike or another coin's failing accounts cannot produce a verdict. `recheck_clears_only_a_token_that_stopped_passing` tries eight such pairs.
- *A 0.1 game read as a 0.2 game, or its stale tail read as a suspension or a token*: different discriminators; `migrate_game` accepts only the 0.1 discriminator at the 0.1 size under this program. `migrate_game_with_admins_and_a_stale_tail`.
- *A fee account that is not the platform's* (`pay`, `settle`): pinned to the associated token address of (fee wallet, mint) in both, so the platform's money lands in one known account per mint (review L3). `pay_refuses_wrong_accounts`, `review.rs` `fixed_l3_pay_sends_the_fee_only_to_the_fee_wallets_associated_account`.
- *A second vault* (`open_box`, `buy_item`, `settle`, `refund`): the vault is pinned to the associated token address of (game, mint), so every payment of a game is held in one account and paid out of it. `token_accounts_are_pinned_by_address`.
- *Blocking a creator by sending lamports to an address first* (an item, a box, the vault): creation tops up, allocates and assigns instead of failing. `token_accounts_are_pinned_by_address` (vault), `accounts_are_sized_to_what_they_hold` (item and box).
- *Blocking a mint by sending lamports to the order's asset address* (review H1): Metaplex Core creates the asset with a plain `create_account`, which refuses an address that holds lamports. `settle` empties the address first (only this program can sign for it) and the lamports go to the player. `review.rs` `fixed_h1_lamports_at_the_asset_address_no_longer_block_settle`, `fixed_h1_ahead_of_time_on_a_box_order`. Every address this program or one of its CPIs creates was checked for the same thing: order, escrow, vault, fee account, the player's refund account, item, box (`sound_prefunded_addresses_of_our_own_accounts_do_not_block`) and now the asset. The VRF request creates no account.

**A paid order always has a way out** (review M1). A box the oracle never answers is refundable after `STALE_SLOTS` (about 10 minutes), a failed roll at once, and since the review any order that was rolled and is still not settled after `ROLLED_REFUND_SLOTS` (1,512,000 slots: 7 days at 400 ms, counted from the purchase). Anyone can send that refund; everything goes to the order's player. It covers every reason a settle can fail: a treasury the creator closed, a collection that no longer lets this program mint, an asset address already in use because a nonce was reused (review L1), a Core fee above what the escrow holds. **For a normal item it is the game's deadline:** a game that delivers the item in its own backend and does not settle within 7 days has given the player the item and the money. The serial the order reserved goes back to the item when it is the last one handed out; an earlier one stays a gap (no minted number is repeated), and the creator can raise `max_supply` by one. `review.rs` `fixed_m1_*`, `fixed_l1_*`. Not covered: a mint whose freeze authority freezes the vault blocks settle and refund alike; `create_game` accepts such mints because USDC is one.

**The player signs a price** (review M4). `buy_item` and `open_box` take `max_price` and fail above it. `pay` already carries its amount. `review.rs` `fixed_m4_a_signed_purchase_fails_above_the_price_it_was_signed_for`.

**The platform fee rounds up** (review M2): `ceil(amount × fee_bps / 10,000)`, never more than the amount; the burn rounds down; the creator gets the rest; the three add up to the payment exactly. No payment is too small to pay the fee and cutting a price into pieces never pays less. `pick::tests::fee_rounds_up_and_the_parts_always_add_up` checks every amount from 0 to 20,100 at every rate from 0 to 1,000 bps.

**Odds are read at the roll, not at the payment** (review L5, left as it is: fixing it means a hash of the box on every order, which is rent). Between `open_box` and the oracle's answer a game admin can change weights or switch an item off, and the paid order rolls on the new table. What a player cannot lose is the payment: when every item is switched off the roll fails and the order refunds at once, and an order whose box no longer matches its items never rolls and refunds after `STALE_SLOTS`. `review.rs` `noted_l5_a_game_admin_changes_the_odds_of_a_paid_box_but_an_emptied_box_refunds`. Item metadata (name, URI, rarity) is likewise read at settle.

**Suspension never traps a player.** `suspended` is read in `open_box`, `buy_item` and `pay` only. `callback_roll`, `settle` and `refund` do not read it. `suspension_stops_sales_and_never_a_settle_or_a_refund` settles and refunds orders opened before the suspension.

**Arithmetic.** `overflow-checks` is on in the release profile. The split, the counters, the notice time and every lamport move use checked operations; `split` returns `None` when two rates exceed the payment.

**What makes a token official, and what the venues' source says** (review M3; citations in `REVIEW-2026-10-10.md`, "Resolution"). The rules `attach_token` and `recheck_token` enforce:

| Venue | Rule | Byte(s) | Error |
| --- | --- | --- | --- |
| Meteora | the pool is a DBC `VirtualPool` (owner, discriminator, 424 bytes) whose base mint is the mint; the config is the `PoolConfig` (1048 bytes) that pool names | pool 136, 72 | `VenueAccounts`, `VenueLayout` |
| Meteora | `fee_claimer` is the partner | config 40 | `FeeClaimerNotPartner` |
| Meteora | `creator_trading_fee_percentage` ≤ 50 | config 245 | `CreatorFeeTooHigh` |
| Meteora | `partner_permanent_locked_liquidity_percentage` ≥ 50 | config 239 | `PartnerLockTooLow` |
| Meteora, **new** | `creator_migration_fee_percentage` ≤ 50 | config 248 | `CreatorMigrationFeeTooHigh` |
| Meteora, **new** | `migrated_compounding_fee_bps` = 0 (the migrated pool does not compound) | config 366–367 (u16) | `CompoundingFees` |
| Meteora | the pool's current `creator` signs (attach only) | pool 104 | `LauncherMustSign` |
| pump.fun | curve and sharing config are the mint's PDAs, owned by pump.fun's programs | | `VenueAccounts`, `NoBondingCurve`, `NoFeeSharing` |
| pump.fun | the curve's `creator` is the sharing config | curve 49 | `CurveNotSharing` |
| pump.fun, **new** | `is_cashback_coin` = 0 and `is_holder_reward` = 0 (a byte past the end of an older, shorter curve counts as 0) | curve 82, 124 | `CreatorFeeDiverted` |
| pump.fun | sharing config active, admin revoked, launcher 5000 + partner 5000 (or the partner alone at 10000) | sharing 10, 75, 76… | `SharingNotActive`, `SharingAdminNotRevoked`, `ShareholdersMismatch` |
| pump.fun | the 5000-bps shareholder that is not the partner signs (attach only) | | `LauncherMustSign` |

All 13 devnet configs that are ours (3 named, 10 of own-pair launches) and the 4 devnet pump.fun coins with our fee share pass every rule, read from chain on 2026-10-10. A 14th config names our partner as fee claimer and fails, as it should: the hand-made one with the creator at 100% of the trading fee.

**Open questions**

1. **Meteora: one pool per mint. Confirmed in DBC's source.** The base mint is created inside pool creation (`init, signer` on `base_mint` in all three `initialize_virtual_pool_*`), and nothing else creates a pool. So "a DBC-owned `VirtualPool` whose base mint is M" is *the* pool of M.
2. **Meteora: a config and a pool's `config` field are immutable. Confirmed in DBC's source** (a config is written only at creation, `pool.config` is assigned once), for the two versions read: `main` at release 0.2.1 and the `release_0.2.2` branch. **Devnet runs something newer than 0.2.1** (our newest configs carry `version` 1, which only 0.2.2 writes), the deployed bytes were not compared with either source, and Meteora can upgrade the program. `recheck_token` relies on none of it: it runs the full check every time.
3. **A pool's creator can change** (`transfer_pool_creator`: the current creator signs, the new one does not, any time except between the curve completing and migration). The signature `attach_token` asks for is the pool's *current* creator: whoever earns the creator's fees now, not necessarily the wallet that sent the launch. A creator can hand the role to an address that can never sign, after which the token can no longer be attached. Transferring it after attaching changes nothing the rules read.
4. **pump.fun's program is closed source.** Its rules here rest on its official docs and IDLs, not on code: the cashback and holder-rewards flags, and the fact that pump.fun's own admin can rewrite or end a sharing config even after `admin_revoked` (a community takeover). That last one cannot be prevented, only detected, which is what `recheck_token` is for. The sharing config's `version` byte is 2 on every devnet account read; any other value is "cannot tell": no attach and no clear until the program is taught the layout. The curve is read by prefix (pump.fun appends fields).
5. **Settings that are NOT checked, because they are allocations or policy and not the fee and liquidity split.** Each is real, read from DBC's source, and each is the launcher's call; ours all sit at the safe value today.
   - `leftover_receiver` with `fixed_token_supply_flag` = 1: base tokens left after migration go to any address the config names (ours: the partner).
   - `locked_vesting_config`: any amount of base tokens goes to the pool's creator through a vesting locker (ours: none).
   - `creator_liquidity_percentage`: the creator's half of the liquidity may be unlocked and withdrawable while the partner's half is permanently locked (ours: both halves locked).
   - `token_update_authority` 3 or 4: a mint authority for the creator or the partner. DBC refuses it for new plain configs since 0.2.0; an older config could carry it (ours: 1, immutable).
   - `quote_mint`: the partner's half is paid in whatever the pool is quoted in.
   - Fee level (`pool_fees`, `migration_fee_option`, `migrated_pool_fee_bps`): how large the fee is, not who gets it.
6. **Settings not checked because what they do is unconfirmed.** Meteora 0.2.2's base-mint transfer fee (config bytes 216–220, zero on all of ours): not traced who receives it. Meteora `migration_option` 0 (the old DAMM v1 path, refused for new configs; ours are 1). pump.fun `is_mayhem_mode` (curve 81). pump.fun after graduation: that the AMM pool's `coin_creator` stays the sharing config is documented, not checked here (it would need a third account).
7. **The partner address is fixed** once written by `init_platform` or `migrate_platform`. It is its own field and not `fee_wallet` because the fee wallet can move at any time, while this address is written into venue accounts that never change: if it could move, every pump.fun token attached under the old address would become clearable by anyone, and no existing Meteora config could ever pass again. The cost is 32 bytes once. A wrong address at migration can only be fixed by a program upgrade.
8. **A token can be attached to more than one game, and any game admin (not only the authority) can replace an attached token** with another passing one whose launcher signs (review L4, left open; `review.rs` `finding_l4_a_game_admin_replaces_the_official_token` still shows it). Nobody can remove one. Uniqueness would need an account per mint, which is rent.
9. **A creator can point the treasury at the game's own vault** (review I1, not fixed): their share then stays in the vault with no way out. Only the creator loses. `review.rs` `finding_i1_*`.
10. **`set_platform` changes the admin at once** (as in 0.1): a wrong `new_admin` loses the platform's admin until a program upgrade. A two-step handover would be safer; not in scope.
11. **Launching a token as the partner wallet itself** passes with a single 100% shareholder, as the website's check allows.
12. **`DEFAULT_TEST_QUEUE` is accepted as an oracle queue** (review I2, not changed): whether it exists on mainnet and who serves it was not checked.
13. **Run on devnet (2026-10-11 UTC), with the real MagicBlock oracle:** a box, a shop purchase with `max_price`, a failed-roll refund, `pay`, `migrate_platform`, `migrate_game` on a 0.1 game and a sale on it, a pending raise and its cancellation, `attach_token` and `recheck_token` on real launches (two attached, five refused), suspension. See the four `devnet-*-0.2*.json` result files. **Not run on a real cluster:** a rolled-order refund (it needs 7 days), a raise actually coming into force (7 days), a real cut below 5% (the way back would take 7 days), `recheck_token` clearing a token (it needs a venue account to change), Token-2022 mints (refused at `create_game`, as before).

## 7. What the review fixes cost

Fixes for `REVIEW-2026-10-10.md` (H1, M1, M2, M3, M4, L1, L2, L3). This table was measured with the crate at `"z"`, before and after the fixes; the shipped numbers are in sections 2 and 3.

| | Before (`3ba021bbb`) | After | Change |
| --- | ---: | ---: | ---: |
| Program | 444,512 bytes | 449,240 bytes | +4,728 bytes, +24,018,240 lamports of rent (0.024 SOL, once) |
| Every account type | | | no change in size or rent |
| New accounts | | | none: the rolled refund, the price cap and the venue rules store nothing |
| `pay` | 30,436 CU | 31,986 | +1,550: the fee account is now derived (L3) instead of read |
| `buy_item` / `open_box` | 48,274 / 69,188 | 48,339 / 69,267 | +65 / +79: the price cap (M4) |
| `settle`, collectible | 83,614 | 83,637 | +23: the look at the asset address (H1); a sweep, when someone did park lamports, is one more system transfer |
| `refund`, failed or stale box | 28,030 | 28,034 | +4 |
| `refund`, rolled order after 7 days | (not possible) | 32,989 | new (M1) |
| `upsert_item`, edit | 11,542 | 12,035 | +493: `fit` now always reads the rent, to hand back lamports left by an L2 migration |
| `migrate_game` | 3,752 | 4,101 | +349: the rent-exemption check on the authority (L2) |
| `attach_token`, pump.fun | 15,309 | 15,810 | +501: the two flags (M3), and `fit` reading the rent on a path that used to return early |
| `attach_token` Meteora, `recheck_token` | 14,053 / 9,707 / 12,924 | 14,057 / 9,713 / 12,932 | +4 to +8 (M3) |
| Rounding the fee up (M2) | | | no measurable change |

The rent work is intact: the shop in section 1 still costs 6,314,440 lamports and a `pay` still creates nothing.
