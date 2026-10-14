//! Economy for Anything: the one program every coin of a project's economy passes through.
//!
//! A project is one `Game` record. Value moves in four ways, and each move writes a public
//! receipt (`receipts.rs`):
//!
//!   IN      money comes in                pay, buy_item, open_box (a player pays);
//!                                         deposit (anyone funds a pool)
//!   OUT     a pool pays out or burns      payout, burn
//!   MAKE    tokens and items are made     issue, make, unmake, set
//!   DECIDE  the game names an outcome     award, open_contest, decide
//!
//! Chance comes from MagicBlock's VRF oracle: `open_box` rolls a box's drop table, and `roll`
//! gives the game's authority a random number for any rule of its own.
//!
//! Who signs is the whole security model. A project has two keys, its owner and its
//! authority, and both are trusted (as is whoever controls its collection): the program keeps
//! players safe from each other, from the platform and from mistakes, not from the project
//! they chose to play.
//!
//!   - A player signs what they pay, and the most they agree to pay.
//!   - The game's `authority` key signs what leaves a pool or gets made on the game's say-so:
//!     the things only the game knows, like who won. The program checks that signature and
//!     nothing else. It sets no caps and no limits.
//!   - The game's `owner` signs its settings and writes its catalog and its mechanics (items,
//!     boxes, schedules, recipes, lotteries, stakes). Once written, a mechanic runs by its own
//!     rules with nobody's signature.
//!   - The platform signs only its own fee (setting it, collecting it) and the suspend switch.
//!     Nothing it can sign stops a payout, a settle or a refund.
//!   - Anyone may finish what is already decided: settle a collectible or a box's other
//!     outcomes (a normal item is settled by the game's own keys), refund, run a schedule that is due,
//!     draw a lottery and pay its winners, send a held collectible home, claim a contest's
//!     entry for its player, call off a contest whose result is overdue, recheck a token.
//!
//! The platform's fee is a flat amount of SOL, paid by whoever asks for something: the player
//! fee when a player signs for something of their own, the project fee for everything else that
//! is charged (`state::Fees`). An order pays the player fee from its escrow when it settles.
//! Finishing what is already decided is free. Each fee is capped, and a raise waits 7 days.
//! Fees wait in each game's own fee box (`["fees", game]`) until the platform collects them,
//! so no account is written by every game's transactions.
//!
//! Where to read:
//!   state.rs      the five core accounts (each mechanic keeps its own in its own file)
//!   rail.rs       the fee and the split: the only place a payment is divided
//!   receipts.rs   every receipt
//!   instructions  one file per group below
pub mod asset;
pub mod constants;
pub mod core_cpi;
pub mod error;
pub mod instructions;
pub mod pick;
pub mod rail;
pub mod receipts;
pub mod rent;
pub mod state;
pub mod tokens;
pub mod venue;

use anchor_lang::prelude::*;

pub use constants::*;
pub use core_cpi::Attribute;
pub use instructions::*;
pub use rail::Fee;
pub use state::*;

declare_id!("GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o");

#[program]
pub mod loot {
    use super::*;

    // ------------------------------------------------------------ IN: a player pays

    /// Pay `amount`, split at once into pools, burn and the game's treasury.
    pub fn pay<'info>(
        ctx: Context<'info, Pay<'info>>,
        amount: u64,
        shares: Vec<Share>,
        reference: [u8; 32],
    ) -> Result<()> {
        pay::handle_pay(ctx, amount, shares, reference)
    }

    /// Put tokens into one of the game's pools.
    pub fn deposit<'info>(ctx: Context<'info, Deposit<'info>>, index: u8, amount: u64) -> Result<()> {
        pay::handle_deposit(ctx, index, amount)
    }

    /// Buy an item from the shop. Opens an order.
    pub fn buy_item<'info>(ctx: Context<'info, BuyItem<'info>>, item_id: u32, nonce: u64, max_price: u64) -> Result<()> {
        order::handle_buy_item(ctx, item_id, nonce, max_price)
    }

    /// Buy a loot box and ask the oracle for its roll. Opens an order.
    pub fn open_box<'info>(
        ctx: Context<'info, OpenBox<'info>>,
        box_id: u32,
        nonce: u64,
        client_seed: [u8; 32],
        max_price: u64,
    ) -> Result<()> {
        order::handle_open_box(ctx, box_id, nonce, client_seed, max_price)
    }

    /// The oracle's answer: picks the box order's outcome.
    pub fn callback_roll<'info>(
        ctx: Context<'info, CallbackRoll<'info>>,
        randomness: [u8; 32],
    ) -> Result<()> {
        order::handle_callback_roll(ctx, randomness)
    }

    /// Deliver an order's item and split its payment.
    pub fn settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        settle::handle_settle(ctx)
    }

    /// Carry out a box order whose roll was not an item: a prize from a pool, a burn, nothing.
    pub fn settle_prize<'info>(ctx: Context<'info, SettlePrize<'info>>) -> Result<()> {
        settle::handle_settle_prize(ctx)
    }

    /// Give an order's payment back to its player.
    pub fn refund<'info>(ctx: Context<'info, Refund<'info>>) -> Result<()> {
        settle::handle_refund(ctx)
    }

    // ------------------------------------------------------------ OUT: a pool pays out or burns

    /// The authority pays `amount` from a pool to any token account.
    pub fn payout<'info>(ctx: Context<'info, Payout<'info>>, index: u8, amount: u64, reference: [u8; 32]) -> Result<()> {
        payout::handle_payout(ctx, index, amount, reference)
    }

    /// The authority destroys `amount` of what a pool holds.
    pub fn burn(ctx: Context<Burn>, index: u8, amount: u64, reference: [u8; 32]) -> Result<()> {
        payout::handle_burn(ctx, index, amount, reference)
    }

    // ------------------------------------------------------------ RANDOM: a number for any rule

    /// The authority asks the oracle for a random number, labelled `reference`.
    pub fn roll<'info>(ctx: Context<'info, Roll<'info>>, reference: [u8; 32]) -> Result<()> {
        roll::handle_roll(ctx, reference)
    }

    /// The oracle's answer, written as a receipt.
    pub fn callback_random(ctx: Context<CallbackRandom>, randomness: [u8; 32]) -> Result<()> {
        roll::handle_callback_random(ctx, randomness)
    }

    // ------------------------------------------------------------ MAKE: tokens and items

    /// The authority mints tokens of a mint the game controls.
    pub fn issue(ctx: Context<Issue>, amount: u64, reference: [u8; 32]) -> Result<()> {
        make::handle_issue(ctx, amount, reference)
    }

    /// The authority mints a collectible without a sale.
    pub fn make(ctx: Context<Make>, reference: [u8; 32]) -> Result<()> {
        make::handle_make(ctx, reference)
    }

    /// The authority burns a burnable collectible.
    pub fn unmake(ctx: Context<Remake>, reference: [u8; 32]) -> Result<()> {
        make::handle_unmake(ctx, reference)
    }

    /// The authority rewrites a collectible's attributes.
    pub fn set(ctx: Context<Remake>, attributes: Vec<Attribute>, reference: [u8; 32]) -> Result<()> {
        make::handle_set(ctx, attributes, reference)
    }

    // ------------------------------------------------------------ DECIDE: what only the game knows

    /// While a hold runs, the authority gives the held collectible to `to`.
    pub fn award(ctx: Context<Release>, reference: [u8; 32]) -> Result<()> {
        hold::handle_award(ctx, reference)
    }

    /// The authority opens a contest: sides to back, and a pot.
    pub fn open_contest(ctx: Context<OpenContest>, id: u32, args: ContestArgs) -> Result<()> {
        contest::handle_open_contest(ctx, id, args)
    }

    /// The authority names the side of a contest that won.
    pub fn decide<'info>(ctx: Context<'info, Decide<'info>>, side: u8, reference: [u8; 32]) -> Result<()> {
        contest::handle_decide(ctx, side, reference)
    }

    // ------------------------------------------------------------ WITHOUT THE AUTHORITY
    // Mechanics the owner writes once. After that the program runs them by their own rules.

    /// Write a schedule: mint, burn or move on a timer.
    pub fn upsert_schedule(ctx: Context<UpsertSchedule>, id: u32, args: ScheduleArgs) -> Result<()> {
        schedule::handle_upsert_schedule(ctx, id, args)
    }

    /// Anyone runs a schedule that is due.
    pub fn run_schedule<'info>(ctx: Context<'info, RunSchedule<'info>>) -> Result<()> {
        schedule::handle_run_schedule(ctx)
    }

    /// Write a lottery: tickets into a pot, a draw on a timer.
    pub fn upsert_lottery(ctx: Context<UpsertLottery>, id: u32, args: LotteryArgs) -> Result<()> {
        lottery::handle_upsert_lottery(ctx, id, args)
    }

    /// A player buys lottery tickets.
    pub fn buy_tickets<'info>(ctx: Context<'info, BuyTickets<'info>>, count: u64, max_price: u64) -> Result<()> {
        lottery::handle_buy_tickets(ctx, count, max_price)
    }

    /// Anyone asks the oracle for a lottery's draw once it is due.
    pub fn draw_lottery<'info>(ctx: Context<'info, DrawLottery<'info>>) -> Result<()> {
        lottery::handle_draw_lottery(ctx)
    }

    /// The oracle's answer: picks the winning ticket.
    pub fn callback_lottery(ctx: Context<CallbackLottery>, randomness: [u8; 32]) -> Result<()> {
        lottery::handle_callback_lottery(ctx, randomness)
    }

    /// Anyone pays one place of a drawn lottery. The last place paid opens the next round.
    pub fn pay_lottery<'info>(ctx: Context<'info, PayLottery<'info>>, place: u8) -> Result<()> {
        lottery::handle_pay_lottery(ctx, place)
    }

    /// Open a stake: players lock a token and share what flows into a rewards pool.
    pub fn open_stake(ctx: Context<OpenStake>, id: u32, rewards_pool: u8, lock: i64) -> Result<()> {
        stake::handle_open_stake(ctx, id, rewards_pool, lock)
    }

    /// A player stakes, and is paid the rewards owed so far.
    pub fn stake<'info>(ctx: Context<'info, Staking<'info>>, amount: u64) -> Result<()> {
        stake::handle_stake(ctx, amount)
    }

    /// A player unstakes, and is paid the rewards owed so far. Zero only collects rewards.
    /// `forfeit` gives up the rewards owed instead, for when they cannot be paid.
    pub fn unstake<'info>(ctx: Context<'info, Staking<'info>>, amount: u64, forfeit: bool) -> Result<()> {
        stake::handle_unstake(ctx, amount, forfeit)
    }

    /// Write a recipe: collectibles and tokens in, collectibles and tokens out.
    pub fn upsert_recipe(ctx: Context<UpsertRecipe>, id: u32, args: RecipeArgs) -> Result<()> {
        craft::handle_upsert_recipe(ctx, id, args)
    }

    /// A player crafts a recipe, at the version they saw, `times` over.
    pub fn craft<'info>(ctx: Context<'info, Craft<'info>>, version: u32, times: u64) -> Result<()> {
        craft::handle_craft(ctx, version, times)
    }

    /// A player hands a collectible to the game for `seconds`.
    pub fn hold(ctx: Context<HoldItem>, seconds: i64, reference: [u8; 32]) -> Result<()> {
        hold::handle_hold(ctx, seconds, reference)
    }

    /// Anyone sends a collectible back to its player once its hold is over.
    pub fn take_back(ctx: Context<TakeBack>) -> Result<()> {
        hold::handle_take_back(ctx)
    }

    /// A player puts `amount` on one side of a contest.
    pub fn enter<'info>(ctx: Context<'info, Enter<'info>>, side: u8, amount: u64, terms: [u8; 32]) -> Result<()> {
        contest::handle_enter(ctx, side, amount, terms)
    }

    /// Anyone calls off a contest whose result is overdue (its authority, at any time).
    pub fn call_off(ctx: Context<CallOff>) -> Result<()> {
        contest::handle_call_off(ctx)
    }

    /// Anyone pays a decided contest's entry to its player.
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>) -> Result<()> {
        contest::handle_claim(ctx)
    }

    /// Anyone closes a contest whose entries are all claimed.
    pub fn close_contest(ctx: Context<CloseContest>) -> Result<()> {
        contest::handle_close_contest(ctx)
    }

    // ------------------------------------------------------------ a game's settings (its owner)

    pub fn create_game(ctx: Context<CreateGame>, authority: Pubkey) -> Result<()> {
        game::handle_create_game(ctx, authority)
    }

    pub fn update_game(ctx: Context<UpdateGame>, update: GameUpdate) -> Result<()> {
        game::handle_update_game(ctx, update)
    }

    pub fn open_pool(ctx: Context<OpenPool>, index: u8) -> Result<()> {
        game::handle_open_pool(ctx, index)
    }

    pub fn close_pool(ctx: Context<ClosePool>, index: u8) -> Result<()> {
        game::handle_close_pool(ctx, index)
    }

    pub fn upsert_item(ctx: Context<UpsertItem>, item_id: u32, args: ItemArgs) -> Result<()> {
        catalog::handle_upsert_item(ctx, item_id, args)
    }

    pub fn upsert_box(ctx: Context<UpsertBox>, box_id: u32, args: BoxArgs) -> Result<()> {
        catalog::handle_upsert_box(ctx, box_id, args)
    }

    // ------------------------------------------------------------ the platform

    pub fn init_platform(
        ctx: Context<InitPlatform>,
        fees: Fees,
        partner: Pubkey,
    ) -> Result<()> {
        platform::handle_init_platform(ctx, fees, partner)
    }

    pub fn set_platform(ctx: Context<SetPlatform>, fees: Fees) -> Result<()> {
        platform::handle_set_platform(ctx, fees)
    }

    pub fn collect_fees<'info>(ctx: Context<'info, CollectFees<'info>>) -> Result<()> {
        platform::handle_collect_fees(ctx)
    }

    pub fn set_suspended(ctx: Context<SetSuspended>, suspended: bool) -> Result<()> {
        platform::handle_set_suspended(ctx, suspended)
    }

    // ------------------------------------------------------------ the registry (official tokens)

    pub fn attach_token(ctx: Context<AttachToken>, venue: Venue, mint: Pubkey) -> Result<()> {
        token::handle_attach_token(ctx, venue, mint)
    }

    pub fn recheck_token(ctx: Context<RecheckToken>) -> Result<()> {
        token::handle_recheck_token(ctx)
    }
}
