//! MAKE. The game's authority creates and changes value without a sale: it mints the game's
//! own tokens (`issue`), mints a collectible (`make`), burns one (`unmake`) and rewrites one's
//! attributes (`set`). As with `payout`, the authority's signature is the only rule.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{
    constants::*,
    asset,
    core_cpi::{Attribute, Collectible, Core, MPL_CORE_ID},
    error::LootError,
    rail::*,
    receipts::*,
    state::*,
    tokens::Tokens,
};

// ---------------------------------------------------------------- issue

#[derive(Accounts)]
pub struct Issue<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: a mint whose mint authority is the game. The token program refuses any other.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: any token account of that mint.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

/// Mints `amount` new tokens. A token becomes issuable when its creator hands its mint
/// authority to the game's address.
pub fn handle_issue(ctx: Context<Issue>, amount: u64, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, LootError::ZeroAmount);

    a.fee.charge_project(&a.game, &a.authority)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    tokens.mint(&a.game, &a.mint, &a.to, amount)?;

    emit!(Issued {
        game: a.game.key(),
        authority: a.authority.key(),
        mint: a.mint.key(),
        to: a.to.key(),
        amount,
        reference,
    });
    Ok(())
}

// ---------------------------------------------------------------- make

#[derive(Accounts)]
pub struct Make<'info> {
    /// Pays the new asset's rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub item: Account<'info, Item>,
    /// CHECK: the game's Core collection, by address.
    #[account(mut, address = game.collection)]
    pub collection: UncheckedAccount<'info>,
    /// A new key the caller made for this asset.
    #[account(mut)]
    pub asset: Signer<'info>,
    /// CHECK: whoever receives the collectible.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

/// Mints one collectible of `item` to `owner`, with the item's next serial number. The item's
/// own supply still holds: its owner set it, and can raise it. `active` does not: switching an
/// item off stops its sales, drops and recipes, not the authority's own `make`. Never to the
/// game itself, which could not move it on without a hold.
pub fn handle_make(ctx: Context<Make>, reference: [u8; 32]) -> Result<()> {
    require_keys_neq!(ctx.accounts.owner.key(), ctx.accounts.game.key(), LootError::ToTheGame);
    let item = &mut ctx.accounts.item;
    require!(item.kind == ItemKind::Collectible, LootError::NotCollectible);
    require!(item.has_stock(), LootError::SoldOut);
    item.issued = item.issued.checked_add(1).ok_or(LootError::Overflow)?;

    let a = &ctx.accounts;
    a.fee.charge_project(&a.game, &a.authority)?;
    Core {
        program: &a.mpl_core_program,
        asset: &a.asset,
        collection: &a.collection,
        authority: &a.game.to_account_info(),
        payer: &a.authority,
        system: &a.fee.system_program,
    }
    .mint(
        &a.owner,
        &Collectible::of(&a.item, a.item.issued, a.game.key())?,
        &[&[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]]],
    )?;

    emit!(Made {
        game: a.game.key(),
        authority: a.authority.key(),
        item_id: a.item.item_id,
        serial: a.item.issued,
        asset: a.asset.key(),
        owner: a.owner.key(),
        reference,
    });
    Ok(())
}

// ---------------------------------------------------------------- unmake and set

/// The accounts to change a collectible that already exists.
#[derive(Accounts)]
pub struct Remake<'info> {
    /// Pays for a longer attribute list, or gets the rent of a burned asset.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: a collectible. Core checks that it belongs to `collection`.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the game's Core collection, by address.
    #[account(mut, address = game.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

impl<'info> Remake<'info> {
    fn core<'a>(&'a self, game: &'a AccountInfo<'info>) -> Core<'a, 'info> {
        Core {
            program: &self.mpl_core_program,
            asset: &self.asset,
            collection: &self.collection,
            authority: game,
            payer: &self.authority,
            system: &self.fee.system_program,
        }
    }
}

/// Burns a collectible, whoever holds it. Core allows it only for an item that was created
/// `burnable`: a ticket used at the door. Never one the game is holding for a player
/// (`hold.rs`): there the game is the owner, and Core would let an owner burn anything.
pub fn handle_unmake(ctx: Context<Remake>, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(asset::holder(&a.asset) != Some(a.game.key()), LootError::Held);
    a.fee.charge_project(&a.game, &a.authority)?;
    a.core(&a.game.to_account_info())
        .burn(&[&[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]]])?;
    emit!(Unmade { game: a.game.key(), authority: a.authority.key(), asset: a.asset.key(), reference });
    Ok(())
}

/// Replaces a collectible's whole attribute list: a level gained, a repair. Which item it is
/// (`item_id`, `rarity`, `serial`) never changes. The program's other numbers (`made`, `used`,
/// `used_at`) stay as they are unless the new list names them: a level written without them
/// must not make an egg hatch or milk rot.
pub fn handle_set(ctx: Context<Remake>, mut attributes: Vec<Attribute>, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let written = asset::attributes(&a.asset.try_borrow_data()?).unwrap_or_default();
    let fixed = [asset::ITEM_ID, "rarity", "serial"];
    attributes.retain(|new| !fixed.contains(&new.key.as_str()));
    for kept in written {
        let key = kept.key.as_str();
        let stays = [asset::MADE, asset::USED, asset::USED_AT].contains(&key) && !attributes.iter().any(|new| new.key == key);
        if fixed.contains(&key) || stays {
            attributes.push(kept);
        }
    }
    a.fee.charge_project(&a.game, &a.authority)?;
    a.core(&a.game.to_account_info())
        .set_attributes(&attributes, &[&[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]]])?;
    emit!(AttributesSet { game: a.game.key(), authority: a.authority.key(), asset: a.asset.key(), reference });
    Ok(())
}
