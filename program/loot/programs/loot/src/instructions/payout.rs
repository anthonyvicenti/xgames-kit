//! OUT. The game's authority pays from a pool to anyone (`payout`), or destroys what a pool
//! holds (`burn`).
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{constants::*, error::LootError, rail::*, receipts::*, state::*, tokens::Tokens};

// ---------------------------------------------------------------- payout

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct Payout<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the game's pool, by address.
    #[account(mut, seeds = [POOL_SEED, game.key().as_ref(), &[index]], bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: any token account of the pool's mint. The authority decides who is paid.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: the pool's mint. The token program refuses any other.
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: any accounts a transfer hook asks for.
}

/// The authority's signature is the only rule: any amount the pool holds, to any token
/// account, at any time. A paused or suspended game still pays out.
pub fn handle_payout<'info>(ctx: Context<'info, Payout<'info>>, index: u8, amount: u64, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, LootError::ZeroAmount);

    a.fee.charge_project(&a.game, &a.authority)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    tokens.send(&a.game, &a.mint, &a.pool, &a.to, amount)?;

    emit!(PaidOut {
        game: a.game.key(),
        authority: a.authority.key(),
        pool: index,
        to: a.to.key(),
        amount,
        reference,
    });
    Ok(())
}

// ---------------------------------------------------------------- burn

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct Burn<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the game's pool, by address.
    #[account(mut, seeds = [POOL_SEED, game.key().as_ref(), &[index]], bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's mint. The token program refuses any other.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: any accounts a transfer hook asks for.
}

/// Destroys `amount` of what a pool holds: a sink the game decides on after the money is in.
pub fn handle_burn(ctx: Context<Burn>, index: u8, amount: u64, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, LootError::ZeroAmount);

    a.fee.charge_project(&a.game, &a.authority)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    tokens.game_burn(&a.game, &a.mint, &a.pool, amount)?;

    emit!(Burned {
        game: a.game.key(),
        authority: a.authority.key(),
        pool: index,
        mint: a.mint.key(),
        amount,
        reference,
    });
    Ok(())
}
