//! Every seed and number the program uses.
use anchor_lang::prelude::*;

// ---------------------------------------------------------------- addresses
// Each account sits at an address derived from one of these words.

#[constant]
pub const PLATFORM_SEED: &[u8] = b"platform";
/// `["game", collection]`
#[constant]
pub const GAME_SEED: &[u8] = b"game";
/// `["fees", game]`: the game's fee box, an account of this program that holds nothing but
/// SOL. The platform's fees on that game's transactions wait there until it collects them, so
/// one game's traffic never queues behind another's on a shared account.
#[constant]
pub const FEES_SEED: &[u8] = b"fees";
/// `["pool", game, index]`: a token account the game owns.
#[constant]
pub const POOL_SEED: &[u8] = b"pool";
/// `["item", game, item id]`
#[constant]
pub const ITEM_SEED: &[u8] = b"item";
/// `["box", game, box id]`
#[constant]
pub const BOX_SEED: &[u8] = b"box";
/// `["order", game, player, nonce]`
#[constant]
pub const ORDER_SEED: &[u8] = b"order";
/// `["escrow", order]`: holds the SOL an order needs (the collectible's rent and the fee), so
/// anyone can settle without the player signing twice. What is left goes back to the player.
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";
/// `["asset", order, slot of the purchase]`: the collectible an order mints. The slot keeps a
/// later order that reuses the same nonce from landing on an address already taken: an order
/// never closes in the slot it was opened in (`settle.rs`).
#[constant]
pub const ASSET_SEED: &[u8] = b"asset";

/// `["schedule", game, id]`, `["lottery", game, id]`,
/// `["stake", game, id]`, `["recipe", game, id]`: the mechanics a game runs without its
/// authority.
#[constant]
pub const SCHEDULE_SEED: &[u8] = b"schedule";
#[constant]
pub const LOTTERY_SEED: &[u8] = b"lottery";
#[constant]
pub const STAKE_SEED: &[u8] = b"stake";
#[constant]
pub const RECIPE_SEED: &[u8] = b"recipe";
/// `["staked", stake]` and `["rewards", stake]`: the two vaults of a stake.
#[constant]
pub const STAKED_SEED: &[u8] = b"staked";
#[constant]
pub const REWARDS_SEED: &[u8] = b"rewards";
/// `["position", stake, player]`: one player's stake.
#[constant]
pub const POSITION_SEED: &[u8] = b"position";
/// `["hold", asset]`: a collectible the game is holding for a player.
#[constant]
pub const HOLD_SEED: &[u8] = b"hold";
/// `["contest", game, id]`, its pot at `["pot", contest]`, and one player's stake on one side
/// at `["entry", contest, player, side]`.
#[constant]
pub const CONTEST_SEED: &[u8] = b"contest";
#[constant]
pub const POT_SEED: &[u8] = b"pot";
#[constant]
pub const ENTRY_SEED: &[u8] = b"entry";

// ---------------------------------------------------------------- the platform's fee

/// The most either flat fee can ever be: 0.01 SOL.
#[constant]
pub const MAX_FEE_LAMPORTS: u64 = 10_000_000;
pub const MAX_FEES: crate::state::Fees = crate::state::Fees { player: MAX_FEE_LAMPORTS, project: MAX_FEE_LAMPORTS };
/// The fees the platform starts with: 0.002 SOL when a player signs for something of their own,
/// 0.00001 SOL for everything else, so a project paying out to ten thousand players pays 0.1 SOL
/// in fees, not 20.
#[constant]
pub const PLAYER_FEE_LAMPORTS: u64 = 2_000_000;
#[constant]
pub const PROJECT_FEE_LAMPORTS: u64 = 10_000;
/// A fee raise waits this long before it applies (7 days). A cut applies at once.
#[constant]
pub const NOTICE_SECONDS: i64 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------- sizes

/// Drop entries in one box.
pub const MAX_ENTRIES: usize = 8;
/// Shares in one split. What they leave over goes to the treasury.
pub const MAX_SHARES: usize = 4;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 200;
/// Basis points in a whole: 10,000 = 100%.
pub const BPS: u64 = 10_000;

// ---------------------------------------------------------------- orders

/// Put in the escrow on every purchase. A Core asset with our plugins costs about 0.004 SOL.
#[constant]
pub const ESCROW_LAMPORTS: u64 = 6_000_000;
/// A box still waiting for its roll after this many slots (about 10 minutes) can be refunded.
#[constant]
pub const STALE_SLOTS: u64 = 1_500;
/// An order that is rolled and still not settled after this many slots (7 days at 400 ms a slot,
/// counted from the purchase) can be refunded. It is the deadline a game has to settle, and the
/// way out when a settle cannot succeed.
#[constant]
pub const ROLLED_REFUND_SLOTS: u64 = 1_512_000;

// ---------------------------------------------------------------- launch venues (the registry)
// The same program ids on devnet and mainnet.

/// Meteora Dynamic Bonding Curve.
pub const METEORA_DBC_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// pump.fun (bonding curves).
pub const PUMP_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// pump.fun fee program (fee-sharing configs).
pub const PUMP_FEES_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

/// The least games.fun takes of a token launched with it (`venue.rs`). These are bounds, so a
/// launch that gives games.fun more still passes. No economy instruction reads `Game::official`,
/// so a token launched anywhere else works with every mechanic. The website's
/// `launch/split.mjs` and `pump/prepare.mjs` must use the same numbers.
///
/// Meteora: the most of the trading fee, and of the migration fee, the creator may take.
pub const MAX_CREATOR_FEE_PERCENT: u8 = 95;
/// Meteora: the least of the migrated pool's liquidity permanently locked to the partner.
pub const MIN_PARTNER_LOCKED_LP_PERCENT: u8 = 5;
/// pump.fun: the least share of the creator fee the partner holds (of `BPS`); the launcher
/// holds the rest.
pub const MIN_PARTNER_SHARE_BPS: u16 = 500;
