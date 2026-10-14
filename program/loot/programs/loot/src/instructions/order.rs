//! IN, by order. A collectible has to be minted and a box has to be rolled, so these purchases
//! open an `Order` that holds the payment until `settle` delivers or `refund` gives it back
//! (`settle.rs`). `buy_item` knows its item at once; `open_box` asks MagicBlock's VRF oracle
//! for a random roll, which arrives in `callback_roll`.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::Token;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};
use solana_sha256_hasher::hashv;

use crate::{
    constants::*,
    error::LootError,
    pick::{by_stock, pick, share},
    rail::pool_address,
    receipts::*,
    rent::pay_lamports,
    state::*,
    tokens::{self, By, Tokens},
};

// ---------------------------------------------------------------- taking the payment

/// The associated token account of (`wallet`, `mint`): the game's vault, a player's own account.
/// Its address also names the token program that owns the mint.
pub fn ata_address(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(wallet, mint, token_program)
}

/// The game's vault for `mint`, whichever token program owns the mint: where the payments of
/// open orders wait.
pub fn vaults(game: &Pubkey, mint: &Pubkey) -> [Pubkey; 2] {
    [ata_address(game, mint, &tokens::TOKEN_ID), ata_address(game, mint, &tokens::TOKEN_2022_ID)]
}

/// The accounts a token account is created with when it is missing.
pub struct NewTokenAccount<'a, 'info> {
    /// Already pinned to `ata_address(wallet, mint, program)` by the caller's account rules.
    pub account: &'a AccountInfo<'info>,
    pub wallet: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    /// The program that owns the mint.
    pub token_program: &'a AccountInfo<'info>,
    pub ata_program: &'a AccountInfo<'info>,
    pub system: &'a AccountInfo<'info>,
}

impl NewTokenAccount<'_, '_> {
    pub fn ensure(&self) -> Result<()> {
        if self.account.owner == self.token_program.key {
            return Ok(());
        }
        associated_token::create(CpiContext::new(
            self.ata_program.key(),
            associated_token::Create {
                payer: self.payer.clone(),
                associated_token: self.account.clone(),
                authority: self.wallet.clone(),
                mint: self.mint.clone(),
                system_program: self.system.clone(),
                token_program: self.token_program.clone(),
            },
        ))
    }
}

/// The accounts both purchases share. Both instructions take the id of what is bought, then
/// the order's nonce. Each names its id, and Anchor hands this group the arguments after it.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Checkout<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    /// Only read: a purchase writes nothing every other purchase of the game also writes.
    pub game: Box<Account<'info, Game>>,
    pub platform: Box<Account<'info, Platform>>,
    /// Any `nonce` the player has no open order at in this game.
    #[account(
        init,
        payer = player,
        space = Order::SPACE,
        seeds = [ORDER_SEED, game.key().as_ref(), player.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: holds the order's SOL. Only this program can sign for it.
    #[account(mut, seeds = [ESCROW_SEED, order.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the mint the price is in (checked in `open_order`): the game's own, or a box's.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: what the player pays from. The token program checks that the player may spend it.
    #[account(mut)]
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: the game's vault for that mint: every open order's payment is held here and
    /// nowhere else. Created on the first sale in that mint; that first player pays its rent.
    #[account(mut, address = ata_address(&game.key(), &mint.key(), mint.owner))]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// What a purchase sells: its price, the most the player agreed to, and where the money goes.
struct Sale<'a> {
    mint: Pubkey,
    price: u64,
    max_price: u64,
    shares: &'a [Share],
    /// The box and its version, or the default key and 0 for a shop item.
    loot_box: Pubkey,
    box_version: u32,
}

impl<'info> Checkout<'info> {
    /// Takes `price` into the vault and the order's SOL into its escrow, and starts the order.
    /// The player's signature covers `max_price`: an edit that lands first cannot raise it.
    /// The order holds what arrived in the vault: the price, less any transfer fee.
    fn open_order(&mut self, hook: &[AccountInfo<'info>], nonce: u64, bump: u8, sale: Sale) -> Result<()> {
        let Sale { mint, price, max_price, shares, loot_box, box_version } = sale;
        self.game.open_for_money()?;
        require!(price > 0, LootError::NotForSale);
        require!(price <= max_price, LootError::PriceAboveMax);
        require_keys_eq!(self.mint.key(), mint, LootError::WrongMint);

        let (token, token_2022) = (self.token_program.to_account_info(), self.token_2022_program.to_account_info());
        let tokens = Tokens { token: &token, token_2022: &token_2022, hook };
        NewTokenAccount {
            account: &self.vault,
            wallet: &self.game.to_account_info(),
            mint: &self.mint,
            payer: &self.player,
            token_program: tokens.program(&self.mint)?,
            ata_program: &self.associated_token_program,
            system: &self.system_program,
        }
        .ensure()?;
        let before = tokens::balance(&self.vault);
        tokens.transfer(&self.mint, &self.player_token, &self.vault, &By::player(&self.player), price)?;
        let paid = tokens::received(&self.vault, before)?;
        // The collectible's rent and the platform's fee wait in the escrow. A refund returns both.
        let clock = Clock::get()?;
        let fee = self.platform.fees(clock.unix_timestamp).player;
        pay_lamports(&self.player, &self.escrow, ESCROW_LAMPORTS + fee, &self.system_program)?;

        self.order.set_inner(Order {
            game: self.game.key(),
            player: self.player.key(),
            nonce,
            mint,
            loot_box,
            box_version,
            status: OrderStatus::Pending,
            outcome: Outcome::Nothing,
            serial: 0,
            paid,
            fee,
            shares: shares.to_vec(),
            requested_slot: clock.slot,
            bump,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- buy_item

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct BuyItem<'info> {
    #[account(
        mut,
        seeds = [ITEM_SEED, checkout.game.key().as_ref(), &item_id.to_le_bytes()],
        bump = item.bump
    )]
    pub item: Box<Account<'info, Item>>,
    pub checkout: Checkout<'info>,
}

/// Buys one item from the shop at its price, after any fall. The item's serial number is
/// reserved now, and a rising price takes its step.
pub fn handle_buy_item<'info>(ctx: Context<'info, BuyItem<'info>>, _item_id: u32, nonce: u64, max_price: u64) -> Result<()> {
    let item = &mut ctx.accounts.item;
    require!(item.active, LootError::NotForSale);
    require!(item.has_stock(), LootError::SoldOut);
    item.issued = item.issued.checked_add(1).ok_or(LootError::Overflow)?;

    let price = item.sell(Clock::get()?.unix_timestamp);

    let c = &mut ctx.accounts.checkout;
    let sale = Sale { mint: c.game.mint, price, max_price, shares: &item.shares, loot_box: Pubkey::default(), box_version: 0 };
    c.open_order(ctx.remaining_accounts, nonce, ctx.bumps.checkout.order, sale)?;
    let order = &mut c.order;
    order.status = OrderStatus::Rolled;
    order.outcome = Outcome::Item(item.item_id);
    order.serial = item.issued;

    emit!(OrderRolled {
        order: order.key(),
        game: order.game,
        player: order.player,
        loot_box: order.loot_box,
        outcome: order.outcome,
        serial: order.serial,
        randomness: [0; 32],
    });
    Ok(())
}

// ---------------------------------------------------------------- open_box

#[vrf]
#[derive(Accounts)]
#[instruction(box_id: u32)]
pub struct OpenBox<'info> {
    #[account(
        mut,
        seeds = [BOX_SEED, checkout.game.key().as_ref(), &box_id.to_le_bytes()],
        bump = loot_box.bump
    )]
    pub loot_box: Box<Account<'info, LootBox>>,
    pub checkout: Checkout<'info>,
    /// CHECK: MagicBlock's default oracle queue, and no other: not even its test queue, which
    /// whoever MagicBlock lets serve it could answer.
    #[account(mut, address = vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    // Then: one account for each entry that needs one, in entry order: its item for an item,
    // its pool for a prize. They are handed to the roll.
}

/// Pays for a box and asks the oracle for the roll.
pub fn handle_open_box<'info>(
    ctx: Context<'info, OpenBox<'info>>,
    _box_id: u32,
    nonce: u64,
    client_seed: [u8; 32],
    max_price: u64,
) -> Result<()> {
    let loot_box = &mut ctx.accounts.loot_box;
    require!(loot_box.active, LootError::NotForSale);

    // Check the accounts now, so a wrong set fails here and not in the oracle's callback. What
    // follows the entries' accounts is for a transfer hook.
    let mut accounts = ctx.remaining_accounts.iter();
    let mut any_available = false;
    for entry in &loot_box.entries {
        any_available |= Stock::of(entry, &loot_box.game, &mut accounts)?.available;
    }
    let (entry_accounts, hook) = ctx.remaining_accounts.split_at(ctx.remaining_accounts.len() - accounts.len());
    require!(any_available, LootError::SoldOut);

    let price = loot_box.sell(Clock::get()?.unix_timestamp);

    let c = &mut ctx.accounts.checkout;
    let mint = loot_box.currency.unwrap_or(c.game.mint);
    let sale = Sale { mint, price, max_price, shares: &loot_box.shares, loot_box: loot_box.key(), box_version: loot_box.version };
    c.open_order(hook, nonce, ctx.bumps.checkout.order, sale)?;
    loot_box.opened = loot_box.opened.checked_add(1).ok_or(LootError::Overflow)?;

    // The oracle calls `callback_roll` with these accounts: the order, the box, this
    // purchase's ticket, then the entries' items and pools.
    let order = c.order.key();
    let mut callback_accounts = vec![
        SerializableAccountMeta { pubkey: order, is_signer: false, is_writable: true },
        SerializableAccountMeta { pubkey: loot_box.key(), is_signer: false, is_writable: false },
        SerializableAccountMeta { pubkey: ticket_of(&order, c.order.requested_slot), is_signer: false, is_writable: false },
    ];
    callback_accounts.extend(entry_accounts.iter().map(|item| SerializableAccountMeta {
        pubkey: item.key(),
        is_signer: false,
        is_writable: true,
    }));
    // The player's seed is mixed with the order and the slot, so they can't pick a seed they like.
    let seed = hashv(&[order.as_ref(), &client_seed, &c.order.requested_slot.to_le_bytes()]).to_bytes();
    let request = create_request_randomness_ix(RequestRandomnessParams {
        payer: c.player.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackRoll::DISCRIMINATOR.to_vec(),
        caller_seed: seed,
        accounts_metas: Some(callback_accounts),
        ..Default::default()
    });
    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.checkout.player.to_account_info(), &request)?;
    Ok(())
}

// ---------------------------------------------------------------- callback_roll

/// An address that names one request to the oracle: what it is for (an order, a lottery) and
/// the slot it was made in. Nothing lives there.
///
/// An order's address is free again once the order closes. Without the ticket, a roll that
/// arrives late could land on a newer order at the same address, with randomness its player
/// has already seen. Two orders at one address never share a slot (`settle.rs`), so they never
/// share a ticket.
pub fn ticket_of(order: &Pubkey, slot: u64) -> Pubkey {
    Pubkey::new_from_array(hashv(&[b"ticket", order.as_ref(), &slot.to_le_bytes()]).to_bytes())
}

/// Only MagicBlock's oracle can call this: `#[vrf_callback]` adds its signer, tied to this
/// program's identity.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRoll<'info> {
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(address = order.loot_box @ LootError::ItemMismatch)]
    pub loot_box: Account<'info, LootBox>,
    /// CHECK: the ticket of the purchase this roll was asked for.
    #[account(address = ticket_of(&order.key(), order.requested_slot) @ LootError::BadOrderState)]
    pub ticket: UncheckedAccount<'info>,
    // Then: the same accounts `open_box` passed, in entry order.
}

/// One box entry, beside the account that came with it.
struct Stock<'a, 'info> {
    /// Can be won right now: an item still in supply, a pool that holds the prize.
    available: bool,
    /// What a pool holds, for a prize from one.
    holds: u64,
    item: Option<ItemView>,
    account: Option<&'a AccountInfo<'info>>,
}

impl<'a, 'info> Stock<'a, 'info> {
    fn of(entry: &DropEntry, game: &Pubkey, accounts: &mut std::slice::Iter<'a, AccountInfo<'info>>) -> Result<Self> {
        let mut next = || accounts.next().ok_or(LootError::ItemMismatch);
        Ok(match entry.outcome {
            Outcome::Item(item_id) => {
                let account = next()?;
                let item = ItemView::read(account)?;
                require!(item.game == *game && item.item_id == item_id, LootError::ItemMismatch);
                Stock { available: item.available(), holds: 0, item: Some(item), account: Some(account) }
            }
            Outcome::Pay { pool, .. } | Outcome::Share { pool, .. } => {
                let account = next()?;
                require_keys_eq!(account.key(), pool_address(game, pool), LootError::WrongPool);
                // A pool that was closed since holds nothing.
                let holds = tokens::read(account).map_or(0, |h| h.amount);
                let available = match entry.outcome {
                    Outcome::Share { bps, .. } => share(holds, bps).is_some_and(|prize| prize > 0),
                    Outcome::Pay { amount, .. } => holds >= amount,
                    _ => false,
                };
                Stock { available, holds, item: None, account: Some(account) }
            }
            Outcome::Burn | Outcome::Nothing => Stock { available: true, holds: 0, item: None, account: None },
        })
    }
}

/// Picks the order's outcome by the box's weights, among the entries that can be won right now.
/// For an item, reserves its serial number. A share of a pool becomes the amount it is of what
/// the pool holds now. When nothing can be won, or the box was edited
/// after the player paid, the order fails and can be refunded at once.
pub fn handle_callback_roll<'info>(
    ctx: Context<'info, CallbackRoll<'info>>,
    randomness: [u8; 32],
) -> Result<()> {
    let order = &mut ctx.accounts.order;
    require!(order.status == OrderStatus::Pending, LootError::BadOrderState);
    let fail = |order: &mut Account<Order>| {
        order.status = OrderStatus::Failed;
        emit!(OrderFailed { order: order.key(), game: order.game, player: order.player });
        Ok(())
    };
    // A box edited after the player paid is not the box they paid for: nothing is picked, and
    // its entries are not even read (they may name other accounts than the purchase passed).
    if ctx.accounts.loot_box.version != order.box_version {
        return fail(order);
    }
    let entries = &ctx.accounts.loot_box.entries;
    let mut accounts = ctx.remaining_accounts.iter();
    let mut stock = Vec::with_capacity(entries.len());
    let mut weights = Vec::with_capacity(entries.len());
    let stock_odds = ctx.accounts.loot_box.stock_odds;
    for entry in entries {
        let s = Stock::of(entry, &order.game, &mut accounts)?;
        let weight = match &s.item {
            Some(item) if stock_odds => by_stock(entry.weight, item.max_supply, item.out()),
            _ => entry.weight,
        };
        weights.push((weight, s.available));
        stock.push(s);
    }
    let Some(i) = pick(&weights, vrf::rnd::random_u64(&randomness)) else {
        return fail(order);
    };
    order.status = OrderStatus::Rolled;
    order.outcome = match entries[i].outcome {
        // A share becomes an amount now, of what the pool holds at the roll, so the order it
        // was won in is the order it is paid in: a later winner settled first cannot take it.
        Outcome::Share { pool, bps } => Outcome::Pay { pool, amount: share(stock[i].holds, bps).ok_or(LootError::Overflow)? },
        outcome => outcome,
    };
    let won = &mut stock[i];
    if let (Some(item), Some(account)) = (&mut won.item, won.account) {
        order.serial = item.issue(account)?;
    }
    emit!(OrderRolled {
        order: order.key(),
        game: order.game,
        player: order.player,
        loot_box: order.loot_box,
        outcome: order.outcome,
        serial: order.serial,
        randomness,
    });
    Ok(())
}
