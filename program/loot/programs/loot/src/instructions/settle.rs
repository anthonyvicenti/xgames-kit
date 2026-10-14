//! How an order ends. `settle` delivers an item, `settle_prize` carries out any other outcome
//! of a box (a prize from a pool, a burn, nothing), and both split the payment. `refund` gives
//! the payment back. Either way the order closes and its rent returns to the player. A paid
//! order always has a way out: `refund` needs nobody's permission once its condition is met.
//!
//! An order never closes in the slot it was opened in. Its collectible's address and its
//! oracle ticket are made from its address and that slot, and a player can open a new order
//! at the same address (the same nonce) once the old one is closed: this way the two can never
//! share a slot, so never a collectible or a ticket.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;

use super::order::{ata_address, NewTokenAccount};
use crate::{
    constants::*,
    core_cpi::{Collectible, Core, MPL_CORE_ID},
    error::LootError,
    rail::*,
    receipts::*,
    rent::pay_lamports_signed,
    state::*,
    tokens::{self, Tokens},
};

// ---------------------------------------------------------------- settle

#[derive(Accounts)]
pub struct Settle<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        close = player,
        has_one = game,
        has_one = player,
        constraint = order.status == OrderStatus::Rolled @ LootError::BadOrderState
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's player. Gets the collectible, the order's rent and the escrow's change.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub game: Box<Account<'info, Game>>,
    /// The item the order gives.
    #[account(
        has_one = game,
        constraint = order.outcome == Outcome::Item(item.item_id) @ LootError::WrongSettle
    )]
    pub item: Box<Account<'info, Item>>,
    /// CHECK: the order's escrow. Only this program can sign for it.
    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the mint the order was paid in, by address. Writable for a burn share.
    #[account(mut, address = order.mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the game's vault, by address.
    #[account(mut, address = ata_address(&game.key(), &order.mint, mint.owner))]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the game's treasury, by address.
    #[account(mut, address = game.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the game's Core collection, by address.
    #[account(mut, address = game.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the collectible this order mints. Unused for a normal item.
    #[account(mut, seeds = [ASSET_SEED, order.key().as_ref(), &order.requested_slot.to_le_bytes()], bump)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    /// CHECK: the game's fee box, where the order's fee goes. It holds only SOL.
    #[account(mut, seeds = [FEES_SEED, game.key().as_ref()], bump = game.fees_bump)]
    pub fees: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // Then: the accounts the order's shares name, in the same order (`rail::deliver`), then
    // any accounts a transfer hook asks for.
}

/// A collectible: anyone can settle (a keeper does, right after the roll) and the asset always
/// goes to the order's player. A normal item: the game's owner or authority settles once its backend has
/// delivered it, so the chain and the backend agree.
pub fn handle_settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let (order, item, system) = (&a.order, &a.item, &a.system_program);
    require!(Clock::get()?.slot > order.requested_slot, LootError::SameSlot);
    if item.kind == ItemKind::Normal {
        require!(a.game.is_ours(&a.signer.key()), LootError::NotTheGames);
    }
    let order_key = order.key();
    let slot = order.requested_slot.to_le_bytes();
    let game_signer: &[&[u8]] = &[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]];
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let escrow_signer: &[&[u8]] = &[ESCROW_SEED, order_key.as_ref(), &[ctx.bumps.escrow]];
    let asset_signer: &[&[u8]] = &[ASSET_SEED, order_key.as_ref(), &slot, &[ctx.bumps.asset]];

    // 1. The payment leaves the vault, split the way it was fixed at purchase.
    let to_treasury = split(
        &Payment {
            game: a.game.key(),
            tokens: &tokens,
            mint: &a.mint,
            from: &a.vault,
            owner: &a.game.to_account_info(),
            signer: &[game_signer],
            treasury: &a.treasury,
        },
        order.paid,
        &order.shares,
        ctx.remaining_accounts,
    )?;

    // 2. The platform's fee leaves the escrow, for the game's fee box.
    pay_lamports_signed(&a.escrow, &a.fees, order.fee, system, escrow_signer)?;

    // 3. The item is delivered.
    let mut asset = Pubkey::default();
    if item.kind == ItemKind::Collectible {
        // Core refuses to create an asset at an address that already holds SOL, and anyone can
        // send SOL to this one. Only this program can sign for it, so it is emptied first.
        pay_lamports_signed(&a.asset, &a.player, a.asset.lamports(), system, asset_signer)?;
        Core {
            program: &a.mpl_core_program,
            asset: &a.asset,
            collection: &a.collection,
            authority: &a.game.to_account_info(),
            payer: &a.escrow,
            system,
        }
        .mint(
            &a.player,
            &Collectible::of(item, order.serial, a.game.key())?,
            &[asset_signer, escrow_signer, game_signer],
        )?;
        asset = a.asset.key();
    }

    // 4. What the escrow has left goes back to the player.
    pay_lamports_signed(&a.escrow, &a.player, a.escrow.lamports(), system, escrow_signer)?;

    emit!(OrderSettled {
        order: order_key,
        game: order.game,
        player: order.player,
        outcome: order.outcome,
        serial: order.serial,
        asset,
        amount: order.paid,
        burned: 0,
        shares: order.shares.clone(),
        to_treasury,
    });
    Ok(())
}

// ---------------------------------------------------------------- settle_prize

#[derive(Accounts)]
pub struct SettlePrize<'info> {
    #[account(
        mut,
        close = player,
        has_one = game,
        has_one = player,
        constraint = order.status == OrderStatus::Rolled @ LootError::BadOrderState
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's player. Gets the order's rent and the escrow's change.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub game: Box<Account<'info, Game>>,
    /// CHECK: the order's escrow. Only this program can sign for it.
    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the mint the order was paid in, by address. Writable for a burn.
    #[account(mut, address = order.mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the game's vault, by address.
    #[account(mut, address = ata_address(&game.key(), &order.mint, mint.owner))]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the game's treasury, by address.
    #[account(mut, address = game.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: for a `Pay` outcome, the pool the prize comes from (checked below).
    #[account(mut)]
    pub prize_pool: Option<UncheckedAccount<'info>>,
    /// CHECK: for a `Pay` outcome, a token account the player owns (checked below).
    #[account(mut)]
    pub prize_to: Option<UncheckedAccount<'info>>,
    /// CHECK: for a `Pay` outcome, the pool's mint. The token program refuses any other.
    pub prize_mint: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    /// CHECK: the game's fee box, where the order's fee goes. It holds only SOL.
    #[account(mut, seeds = [FEES_SEED, game.key().as_ref()], bump = game.fees_bump)]
    pub fees: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // Then: the accounts the order's shares name, in the same order (`rail::deliver`), then
    // any accounts a transfer hook asks for.
}

/// Anyone can send this (a keeper does, right after the roll). Nobody decides anything here:
/// the roll already did, and the prize can only go to the order's player.
///
/// If the pool no longer holds the prize, this fails and the order is refunded after 7 days.
/// The roll skips a prize its pool cannot pay, so that takes several winners at once, or the
/// game's authority paying the pool out in between: a prize pool is still a pool.
pub fn handle_settle_prize<'info>(ctx: Context<'info, SettlePrize<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let (order, system) = (&a.order, &a.system_program);
    require!(Clock::get()?.slot > order.requested_slot, LootError::SameSlot);
    let order_key = order.key();
    let game_signer: &[&[u8]] = &[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]];
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let escrow_signer: &[&[u8]] = &[ESCROW_SEED, order_key.as_ref(), &[ctx.bumps.escrow]];
    let payment = Payment {
        game: a.game.key(),
        tokens: &tokens,
        mint: &a.mint,
        from: &a.vault,
        owner: &a.game.to_account_info(),
        signer: &[game_signer],
        treasury: &a.treasury,
    };

    // 1. The payment leaves the vault: burned whole, or split the way it was fixed at purchase.
    let (burned, to_treasury) = match order.outcome {
        // A share was turned into an amount when it was rolled.
        Outcome::Item(_) | Outcome::Share { .. } => return err!(LootError::WrongSettle),
        Outcome::Burn => {
            split(&payment, order.paid, &[Share { to: To::Burn, bps: BPS as u16 }], &[])?;
            (order.paid, 0)
        }
        Outcome::Pay { .. } | Outcome::Nothing => (0, split(&payment, order.paid, &order.shares, ctx.remaining_accounts)?),
    };

    // 2. The prize leaves its pool, to the player.
    if let Outcome::Pay { pool, amount } = order.outcome {
        let from = pool_account(&a.prize_pool, &a.game.key(), pool)?;
        let to = a.prize_to.as_ref().ok_or(LootError::NotThePlayers)?;
        let mint = a.prize_mint.as_ref().ok_or(LootError::WrongMint)?;
        require_keys_eq!(tokens::holding(to)?.owner, order.player, LootError::NotThePlayers);
        tokens.send(&a.game, mint, from, to, amount)?;
    }

    // 3. The platform's fee leaves the escrow, for the game's fee box, and the rest goes back
    // to the player.
    pay_lamports_signed(&a.escrow, &a.fees, order.fee, system, escrow_signer)?;
    pay_lamports_signed(&a.escrow, &a.player, a.escrow.lamports(), system, escrow_signer)?;

    emit!(OrderSettled {
        order: order_key,
        game: order.game,
        player: order.player,
        outcome: order.outcome,
        serial: 0,
        asset: Pubkey::default(),
        amount: order.paid,
        burned,
        shares: order.shares.clone(),
        to_treasury,
    });
    Ok(())
}

// ---------------------------------------------------------------- refund

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Pays for the player's token account if they closed it.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, close = player, has_one = game, has_one = player)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's player.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub game: Box<Account<'info, Game>>,
    /// CHECK: the order's escrow. Only this program can sign for it.
    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the mint the order was paid in, by address.
    #[account(address = order.mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the game's vault, by address.
    #[account(mut, address = ata_address(&game.key(), &order.mint, mint.owner))]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: where the refund goes: the player's own token account, by address.
    #[account(mut, address = ata_address(&player.key(), &order.mint, mint.owner))]
    pub player_token: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Then, for a rolled order whose outcome is an item: that item, writable. Then any accounts
    // a transfer hook asks for.
}

/// Anyone can refund, always to the order's player, and the platform takes no fee:
/// - a box whose roll failed (everything was sold out): from the next slot;
/// - a box whose roll never arrived: after `STALE_SLOTS`;
/// - any order rolled and still not settled: after `ROLLED_REFUND_SLOTS` (7 days). That is the
///   way out of every settle that cannot succeed, and the deadline a game has to settle a
///   normal item. Its unit goes back to the item: the serial number too when it is the last one
///   handed out, or else that number stays a gap and is counted as voided.
pub fn handle_refund<'info>(ctx: Context<'info, Refund<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let order = &a.order;
    let wait = match order.status {
        OrderStatus::Failed => 0,
        OrderStatus::Pending => STALE_SLOTS,
        OrderStatus::Rolled => ROLLED_REFUND_SLOTS,
    };
    require!(Clock::get()?.slot > order.requested_slot.saturating_add(wait), LootError::NotStale);

    let mut serial_released = false;
    if let (OrderStatus::Rolled, Outcome::Item(item_id)) = (order.status, order.outcome) {
        let account = ctx.remaining_accounts.first().ok_or(LootError::ItemMismatch)?;
        let mut item = ItemView::read(account)?;
        require!(
            item.game == order.game && item.item_id == item_id,
            LootError::ItemMismatch
        );
        serial_released = item.release(account, order.serial)?;
    }
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };

    NewTokenAccount {
        account: &a.player_token,
        wallet: &a.player,
        mint: &a.mint,
        payer: &a.signer,
        token_program: tokens.program(&a.mint)?,
        ata_program: &a.associated_token_program,
        system: &a.system_program,
    }
    .ensure()?;
    tokens.send(&a.game, &a.mint, &a.vault, &a.player_token, order.paid)?;
    let order_key = order.key();
    pay_lamports_signed(
        &a.escrow,
        &a.player,
        a.escrow.lamports(),
        &a.system_program,
        &[ESCROW_SEED, order_key.as_ref(), &[ctx.bumps.escrow]],
    )?;

    emit!(OrderRefunded {
        order: order_key,
        game: order.game,
        player: order.player,
        amount: order.paid,
        serial_released,
    });
    Ok(())
}
