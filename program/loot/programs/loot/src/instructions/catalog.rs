//! A game's catalog: the items it sells, drops or makes, and its loot boxes. Its owner writes
//! both. Each call creates the entry or replaces it, and the account is always exactly
//! as big as what it holds.
use anchor_lang::prelude::*;

use super::order::vaults;
use crate::{
    constants::*,
    error::LootError,
    rent::{load, save},
    state::*,
};

// ---------------------------------------------------------------- upsert_item

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ItemArgs {
    pub kind: ItemKind,
    pub rarity: u8,
    pub soulbound: bool,
    pub burnable: bool,
    pub name: String,
    pub uri: String,
    pub max_supply: u32,
    pub price: u64,
    pub rise: Option<Rise>,
    pub fall: Option<Fall>,
    pub life: Option<Life>,
    pub active: bool,
    pub shares: Vec<Share>,
}

#[derive(Accounts)]
#[instruction(item_id: u32)]
pub struct UpsertItem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the item's address. Read and written by hand because its size changes.
    #[account(mut, seeds = [ITEM_SEED, game.key().as_ref(), &item_id.to_le_bytes()], bump)]
    pub item: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_upsert_item(ctx: Context<UpsertItem>, item_id: u32, args: ItemArgs) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        args.name.len() <= MAX_NAME_LEN && args.uri.len() <= MAX_URI_LEN,
        LootError::StringTooLong
    );
    check_later_shares(&args.shares, &a.game.mint, &vaults(&a.game.key(), &a.game.mint))?;
    require!(Fall::check(&args.fall), LootError::BadPrice);
    let collectible = args.kind == ItemKind::Collectible;
    let mut item = Item {
        game: a.game.key(),
        item_id,
        kind: args.kind,
        rarity: args.rarity,
        soulbound: args.soulbound && collectible,
        burnable: args.burnable && collectible,
        max_supply: args.max_supply,
        issued: 0,
        voided: 0,
        price: args.price,
        active: args.active,
        bump: ctx.bumps.item,
        rise: args.rise,
        fall: args.fall,
        life: args.life.filter(|_| collectible),
        shares: args.shares,
        name: args.name,
        uri: args.uri,
    };
    // What an item is can't change under the people who already hold one.
    if let Some(old) = load::<Item>(&a.item)? {
        (item.issued, item.voided) = (old.issued, old.voided);
        // Its name is how a recipe recognises it, so the name is part of what it is. So is how
        // long it lives and how often it can be used.
        let same = (old.kind, old.soulbound, old.burnable, old.life, &old.name)
            == (item.kind, item.soulbound, item.burnable, item.life, &item.name);
        require!(old.issued == 0 || same, LootError::KindLocked);
    }
    require!(item.max_supply == 0 || item.max_supply >= item.out(), LootError::SupplyBelowIssued);

    let game = a.game.key();
    let seeds: &[&[u8]] = &[ITEM_SEED, game.as_ref(), &item_id.to_le_bytes(), &[item.bump]];
    save(&a.item, &item, seeds, &a.owner, &a.system_program)
}

// ---------------------------------------------------------------- upsert_box

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BoxArgs {
    pub price: u64,
    pub currency: Option<Pubkey>,
    pub rise: Option<Rise>,
    pub fall: Option<Fall>,
    pub stock_odds: bool,
    pub active: bool,
    pub shares: Vec<Share>,
    pub entries: Vec<DropEntry>,
}

#[derive(Accounts)]
#[instruction(box_id: u32)]
pub struct UpsertBox<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the box's address. Read and written by hand because its size changes.
    #[account(mut, seeds = [BOX_SEED, game.key().as_ref(), &box_id.to_le_bytes()], bump)]
    pub loot_box: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// An order that was paid before an edit is not rolled on the edited box: its roll fails it,
/// and the player can be refunded at once. A box decides where money goes, so only the owner
/// writes one.
pub fn handle_upsert_box(ctx: Context<UpsertBox>, box_id: u32, args: BoxArgs) -> Result<()> {
    let a = &ctx.accounts;
    let n = args.entries.len();
    let pays_something = |outcome: &Outcome| match *outcome {
        Outcome::Pay { amount, .. } => amount > 0,
        Outcome::Share { bps, .. } => bps > 0 && bps as u64 <= BPS,
        _ => true,
    };
    require!(
        (1..=MAX_ENTRIES).contains(&n) && args.entries.iter().all(|e| e.weight > 0 && pays_something(&e.outcome)),
        LootError::BadEntries
    );
    require!(Fall::check(&args.fall), LootError::BadPrice);
    let mint = args.currency.unwrap_or(a.game.mint);
    check_later_shares(&args.shares, &mint, &vaults(&a.game.key(), &mint))?;
    let burns = args.entries.iter().any(|e| e.outcome == Outcome::Burn);
    require!(!burns || !crate::tokens::is_wrapped_sol(&mint), LootError::BadEntries);
    // The treasury holds the game's mint, so a box in another one leaves it nothing.
    let takes_all = args.shares.iter().map(|s| s.bps as u64).sum::<u64>() == BPS;
    require!(args.currency.is_none_or(|mint| mint == a.game.mint) || takes_all, LootError::BadShares);
    let old = load::<LootBox>(&a.loot_box)?;
    let loot_box = LootBox {
        game: a.game.key(),
        box_id,
        price: args.price,
        currency: args.currency,
        rise: args.rise,
        fall: args.fall,
        stock_odds: args.stock_odds,
        active: args.active,
        opened: old.as_ref().map_or(0, |old| old.opened),
        version: old.map_or(0, |old| old.version + 1),
        bump: ctx.bumps.loot_box,
        shares: args.shares,
        entries: args.entries,
    };

    let game = a.game.key();
    let seeds: &[&[u8]] = &[BOX_SEED, game.as_ref(), &box_id.to_le_bytes(), &[loot_box.bump]];
    save(&a.loot_box, &loot_box, seeds, &a.owner, &a.system_program)
}
