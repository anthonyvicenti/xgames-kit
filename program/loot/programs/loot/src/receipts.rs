//! Every receipt the program writes. A receipt is an event in the transaction's log: it costs
//! no rent, and it is the public record of a project's economy.
//!
//! `reference` is the project's own label for the movement (an order id, a rule's hash). The
//! program records it and never reads it.
use anchor_lang::prelude::*;

use crate::instructions::schedule::Action;
use crate::state::{Fees, Outcome, Share, Venue};

// ---------------------------------------------------------------- in

/// A player paid, and the payment was split at once.
#[event]
pub struct Paid {
    pub game: Pubkey,
    pub player: Pubkey,
    pub mint: Pubkey,
    /// What the player sent, the amount they signed. A mint with a transfer fee takes its fee
    /// out of each part on the way, so each place gets its part less that fee.
    pub amount: u64,
    /// Where the shares went. Each was sent `amount * bps / 10,000`, rounded down.
    pub shares: Vec<Share>,
    /// What was sent to the treasury.
    pub to_treasury: u64,
    pub reference: [u8; 32],
}

/// Someone funded a pool.
#[event]
pub struct Deposited {
    pub game: Pubkey,
    pub pool: u8,
    pub depositor: Pubkey,
    /// What arrived in the pool: what was sent, less any transfer fee.
    pub amount: u64,
}

/// An order has its outcome: an item bought from the shop, or whatever a box rolled.
#[event]
pub struct OrderRolled {
    pub order: Pubkey,
    pub game: Pubkey,
    pub player: Pubkey,
    /// The box, or the default key for a shop purchase.
    pub loot_box: Pubkey,
    pub outcome: Outcome,
    /// The item's serial number, for an item.
    pub serial: u32,
    /// The oracle's random bytes the item was picked with. Zeros for a shop purchase.
    pub randomness: [u8; 32],
}

/// A box order could not be rolled: nothing in it could be won, or the box was edited after
/// the purchase. The order can be refunded.
#[event]
pub struct OrderFailed {
    pub order: Pubkey,
    pub game: Pubkey,
    pub player: Pubkey,
}

/// An order was delivered and its payment split.
#[event]
pub struct OrderSettled {
    pub order: Pubkey,
    pub game: Pubkey,
    pub player: Pubkey,
    /// What the player got.
    pub outcome: Outcome,
    pub serial: u32,
    /// The minted collectible, or the default key when nothing was minted.
    pub asset: Pubkey,
    /// What the player paid.
    pub amount: u64,
    /// How much of it was burned because the outcome was `Burn`. Then nothing was split.
    pub burned: u64,
    pub shares: Vec<Share>,
    pub to_treasury: u64,
}

/// An order's payment went back to its player.
#[event]
pub struct OrderRefunded {
    pub order: Pubkey,
    pub game: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    /// Whether the order's serial number went back to its item.
    pub serial_released: bool,
}

// ---------------------------------------------------------------- out

/// The game's authority paid from a pool.
#[event]
pub struct PaidOut {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub pool: u8,
    /// The token account that received it.
    pub to: Pubkey,
    pub amount: u64,
    pub reference: [u8; 32],
}

/// The game's authority burned tokens out of a pool.
#[event]
pub struct Burned {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub pool: u8,
    pub mint: Pubkey,
    pub amount: u64,
    pub reference: [u8; 32],
}

// ---------------------------------------------------------------- make

/// The game's authority minted tokens of a mint the game controls.
#[event]
pub struct Issued {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub reference: [u8; 32],
}

/// The game's authority minted a collectible without a sale.
#[event]
pub struct Made {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub item_id: u32,
    pub serial: u32,
    pub asset: Pubkey,
    pub owner: Pubkey,
    pub reference: [u8; 32],
}

/// The game's authority burned a collectible.
#[event]
pub struct Unmade {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub asset: Pubkey,
    pub reference: [u8; 32],
}

/// The game's authority rewrote a collectible's attributes. The new values are the
/// instruction's own arguments, in the same transaction.
#[event]
pub struct AttributesSet {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub asset: Pubkey,
    pub reference: [u8; 32],
}

// ---------------------------------------------------------------- mechanics without the authority

/// A schedule ran: it minted, burned or moved `amount`.
#[event]
pub struct ScheduleRan {
    pub game: Pubkey,
    pub id: u32,
    /// Which run this was, counted from 1.
    pub run: u32,
    pub action: Action,
    pub amount: u64,
}

/// A player bought lottery tickets `first_ticket .. first_ticket + count`.
#[event]
pub struct TicketsBought {
    pub game: Pubkey,
    pub id: u32,
    pub round: u32,
    pub player: Pubkey,
    pub first_ticket: u64,
    pub count: u64,
}

/// A lottery's round was drawn.
#[event]
pub struct LotteryDrawn {
    pub game: Pubkey,
    pub id: u32,
    pub round: u32,
    /// First place's ticket. The others follow at even steps (`Lottery::ticket_of_place`).
    pub winning_ticket: u64,
    /// Each place's winner, first place first.
    pub winners: Vec<Pubkey>,
    pub randomness: [u8; 32],
}

/// One place of a lottery was paid its share of the pot.
#[event]
pub struct LotteryPaid {
    pub game: Pubkey,
    pub id: u32,
    pub round: u32,
    pub place: u8,
    pub winner: Pubkey,
    pub amount: u64,
}

/// A player staked `amount` more and was paid `rewards`. `staked` is their position now.
#[event]
pub struct Staked {
    pub game: Pubkey,
    pub id: u32,
    pub player: Pubkey,
    pub amount: u64,
    pub rewards: u64,
    pub staked: u64,
}

/// A player took `amount` out of their stake and was paid `rewards`.
#[event]
pub struct Unstaked {
    pub game: Pubkey,
    pub id: u32,
    pub player: Pubkey,
    pub amount: u64,
    pub rewards: u64,
    pub staked: u64,
}

/// A player crafted a recipe. The tokens it took and gave are the recipe's own lines.
#[event]
pub struct Crafted {
    pub game: Pubkey,
    pub id: u32,
    /// The recipe's version: its lines, as they were, say what tokens moved.
    pub version: u32,
    pub player: Pubkey,
    /// How many times over: every token line moved its amount times this.
    pub times: u64,
    /// The collectibles burned, used and kept, and made.
    pub burned: Vec<Pubkey>,
    pub used: Vec<Pubkey>,
    pub made: Vec<Pubkey>,
}

// ---------------------------------------------------------------- holds

/// A player handed a collectible to the game until `free_at`.
#[event]
pub struct Held {
    pub game: Pubkey,
    pub asset: Pubkey,
    pub player: Pubkey,
    pub free_at: i64,
    pub reference: [u8; 32],
}

/// A held collectible went back to its player.
#[event]
pub struct Returned {
    pub game: Pubkey,
    pub asset: Pubkey,
    pub player: Pubkey,
}

/// The authority gave a held collectible to `to`, while its hold ran.
#[event]
pub struct Awarded {
    pub game: Pubkey,
    pub authority: Pubkey,
    pub asset: Pubkey,
    pub player: Pubkey,
    pub to: Pubkey,
    pub reference: [u8; 32],
}

// ---------------------------------------------------------------- contests

/// A player put `amount` on one side of a contest.
#[event]
pub struct Entered {
    pub game: Pubkey,
    pub id: u32,
    pub player: Pubkey,
    pub side: u8,
    pub amount: u64,
}

/// The authority named the side that won. `prize` is what its backers share.
#[event]
pub struct Decided {
    pub game: Pubkey,
    pub id: u32,
    pub side: u8,
    pub pot: u64,
    pub prize: u64,
    pub reference: [u8; 32],
}

/// A contest was called off: every entry gets its own money back.
#[event]
pub struct CalledOff {
    pub game: Pubkey,
    pub id: u32,
}

/// An entry was paid `amount` and closed.
#[event]
pub struct Claimed {
    pub game: Pubkey,
    pub id: u32,
    pub player: Pubkey,
    pub side: u8,
    pub amount: u64,
}

// ---------------------------------------------------------------- random

/// The oracle answered a `roll`. What the number decides is the game's own rule.
#[event]
pub struct Rolled {
    pub game: Pubkey,
    /// The label the authority gave the request.
    pub reference: [u8; 32],
    pub randomness: [u8; 32],
}

// ---------------------------------------------------------------- platform and registry

#[event]
pub struct FeeChanged {
    /// The fees in force now, in lamports.
    pub fees: Fees,
    /// A raise waiting out its notice period, and when it applies (0: none).
    pub pending: Fees,
    pub pending_at: i64,
}

#[event]
pub struct GameSuspended {
    pub game: Pubkey,
    pub suspended: bool,
}

#[event]
pub struct TokenAttached {
    pub game: Pubkey,
    pub mint: Pubkey,
    pub venue: Venue,
    pub launcher: Pubkey,
}

#[event]
pub struct TokenCleared {
    pub game: Pubkey,
    pub mint: Pubkey,
    pub venue: Venue,
    /// The `LootError` code of the rule that no longer holds.
    pub reason: u32,
}
