//! A game's settings, signed by its owner: the record itself, and its pools.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use super::order::vaults;
use crate::{
    asset,
    constants::*,
    core_cpi::MPL_CORE_ID,
    error::LootError,
    rent::{create, fit},
    state::*,
    tokens::{self, Tokens},
};

// ---------------------------------------------------------------- create_game

#[derive(Accounts)]
pub struct CreateGame<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Game::space(false),
        seeds = [GAME_SEED, collection.key().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the game's fee box, created here: an account of this program that holds only SOL.
    #[account(mut, seeds = [FEES_SEED, game.key().as_ref()], bump)]
    pub fees: UncheckedAccount<'info>,
    /// CHECK: a Core collection whose update authority is the signer (checked below).
    #[account(owner = MPL_CORE_ID @ LootError::BadCollection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the currency of the game's shop, a mint of either token program (checked below).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: a token account of that mint (checked below).
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// A Core collection account starts with a tag byte (5 for a collection) and its update
/// authority.
const CORE_COLLECTION_TAG: u8 = 5;
/// Core plugins that let a collection freeze, move or burn every asset in it, whoever holds
/// it: a permanent freeze, transfer or burn delegate. Core only lets a collection have one
/// from the moment it is created, so checking once is enough.
const SEIZING_PLUGINS: [u8; 3] = [5, 7, 8];

/// Whoever controls a Core collection can open the game for it. `authority` is the key that
/// will sign payouts and makes; the owner can change it later. The owner also pays the rent of
/// the game's fee box, which the platform's fees then collect in.
pub fn handle_create_game(ctx: Context<CreateGame>, authority: Pubkey) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    tokens::decimals(&ctx.accounts.mint)?;
    require_keys_eq!(tokens::holding(&ctx.accounts.treasury)?.mint, ctx.accounts.mint.key(), ErrorCode::ConstraintTokenMint);
    // The vault pays the treasury what a split leaves, and the game cannot pay into the account
    // it pays from.
    let vault = vaults(&ctx.accounts.game.key(), &ctx.accounts.mint.key());
    require!(!vault.contains(&ctx.accounts.treasury.key()), LootError::SameAccount);
    {
        let data = ctx.accounts.collection.try_borrow_data()?;
        require!(
            data.len() >= 33 && data[0] == CORE_COLLECTION_TAG && data[1..33] == owner.to_bytes(),
            LootError::BadCollection
        );
        // A player's collectible is theirs, and one the game holds for them comes back.
        let plugins = asset::collection_plugins(&data).ok_or(LootError::BadCollection)?;
        require!(!plugins.iter().any(|plugin| SEIZING_PLUGINS.contains(plugin)), LootError::CollectionCanSeize);
    }
    ctx.accounts.game.set_inner(Game {
        owner,
        authority,
        collection: ctx.accounts.collection.key(),
        mint: ctx.accounts.mint.key(),
        treasury: ctx.accounts.treasury.key(),
        bump: ctx.bumps.game,
        fees_bump: ctx.bumps.fees,
        paused: false,
        suspended: false,
        official: None,
    });
    let game = ctx.accounts.game.key();
    create(
        &ctx.accounts.fees,
        0,
        &crate::ID,
        &ctx.accounts.owner,
        &ctx.accounts.system_program,
        &[FEES_SEED, game.as_ref(), &[ctx.bumps.fees]],
    )
}

// ---------------------------------------------------------------- update_game

/// What to change. `None` leaves a setting as it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GameUpdate {
    pub authority: Option<Pubkey>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateGame<'info> {
    /// Gets back the rent of an official token's record once the token was cleared.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the treasury from now on: pass the current one to keep it, or another token
    /// account of the game's mint (checked below).
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// The owner from now on, when it changes. It signs, so a mistyped key can never take the
    /// game over.
    pub new_owner: Option<Signer<'info>>,
}

pub fn handle_update_game(ctx: Context<UpdateGame>, update: GameUpdate) -> Result<()> {
    require_keys_eq!(tokens::holding(&ctx.accounts.treasury)?.mint, ctx.accounts.game.mint, ErrorCode::ConstraintTokenMint);
    let vault = vaults(&ctx.accounts.game.key(), &ctx.accounts.game.mint);
    require!(!vault.contains(&ctx.accounts.treasury.key()), LootError::SameAccount);
    let game = &mut ctx.accounts.game;
    if let Some(owner) = &ctx.accounts.new_owner {
        game.owner = owner.key();
    }
    if let Some(authority) = update.authority {
        game.authority = authority;
    }
    if let Some(paused) = update.paused {
        game.paused = paused;
    }
    game.treasury = ctx.accounts.treasury.key();
    fit(
        &game.to_account_info(),
        game.space_now(),
        &ctx.accounts.owner,
        &ctx.accounts.system_program,
    )
}

// ---------------------------------------------------------------- open_pool

/// A pool is a token account for one mint, at `["pool", game, index]`, that only the game can
/// spend from. Any number per game, any mint. Its name lives in the project's `economy.json`;
/// on chain it is its index.
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct OpenPool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the pool's mint, of either token program.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the new pool's address.
    #[account(mut, seeds = [POOL_SEED, game.key().as_ref(), &[index]], bump)]
    pub pool: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_pool(ctx: Context<OpenPool>, index: u8) -> Result<()> {
    let a = &ctx.accounts;
    let game = a.game.key();
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    tokens.open(&a.pool, &a.mint, &game, &a.owner, &a.system_program, &[POOL_SEED, game.as_ref(), &[index], &[ctx.bumps.pool]])
}

// ---------------------------------------------------------------- close_pool

/// Closes an empty pool and returns its rent to the owner.
#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ClosePool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the pool, by address. It must hold nothing (checked below).
    #[account(mut, seeds = [POOL_SEED, game.key().as_ref(), &[index]], bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's mint.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
}

pub fn handle_close_pool(ctx: Context<ClosePool>, _index: u8) -> Result<()> {
    let a = &ctx.accounts;
    let pool = tokens::holding(&a.pool)?;
    require!(pool.amount == 0, LootError::PoolNotEmpty);
    require_keys_eq!(pool.mint, a.mint.key(), LootError::WrongMint);
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    tokens.close(&a.game, &a.mint, &a.pool, &a.owner)
}
