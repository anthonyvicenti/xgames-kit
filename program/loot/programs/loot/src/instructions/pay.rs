//! IN, at once. `pay` splits a player's payment on the spot; `deposit` funds a pool. Neither
//! creates an account, so neither costs rent, and the receipt is the record.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{
    constants::*,
    error::LootError,
    rail::*,
    receipts::*,
    state::*,
    tokens::{self, By, Tokens},
};

// ---------------------------------------------------------------- pay

#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub game: Account<'info, Game>,
    /// CHECK: the mint being paid in (checked below against `player_token`).
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: what the player pays from, a token account of either program (checked below).
    /// The token program checks that the player may spend it.
    #[account(mut)]
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: the game's treasury, by address.
    #[account(mut, address = game.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: the accounts that `shares` names, in the same order (`rail::deliver`), then any a
    // transfer hook asks for.
}

/// The player pays `amount`. Each share is burned or goes where it says (a pool of this game,
/// a token account, whoever holds a collectible), and what is left goes to the game's treasury.
///
/// The split is part of what the player signs. The app that asked for the payment reads the
/// receipt and admits the player when the amount, the split and the reference are the ones it
/// asked for.
///
/// A payment in another mint than the game's works when its shares add up to 100%, so nothing
/// is left for the treasury (an entry fee in USDC that all goes to USDC pools).
pub fn handle_pay<'info>(
    ctx: Context<'info, Pay<'info>>,
    amount: u64,
    shares: Vec<Share>,
    reference: [u8; 32],
) -> Result<()> {
    let a = &ctx.accounts;
    a.game.open_for_money()?;
    require!(amount > 0, LootError::ZeroAmount);
    check_shares(&shares)?;
    // The receipt names the mint that really moved.
    require_keys_eq!(tokens::holding(&a.player_token)?.mint, a.mint.key(), ErrorCode::ConstraintTokenMint);

    a.fee.charge_player(&a.game, &a.player)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let to_treasury = split(
        &Payment {
            game: a.game.key(),
            tokens: &tokens,
            mint: &a.mint,
            from: &a.player_token,
            owner: &a.player,
            signer: &[],
            treasury: &a.treasury,
        },
        amount,
        &shares,
        ctx.remaining_accounts,
    )?;

    emit!(Paid {
        game: a.game.key(),
        player: a.player.key(),
        mint: a.mint.key(),
        amount,
        shares,
        to_treasury,
        reference,
    });
    Ok(())
}

// ---------------------------------------------------------------- deposit

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub game: Account<'info, Game>,
    /// CHECK: the game's pool, by address.
    #[account(mut, seeds = [POOL_SEED, game.key().as_ref(), &[index]], bump)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: what the depositor pays from. The token program checks the rest.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: the pool's mint. The token program checks it is the pool's and `from`'s.
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: any accounts a transfer hook asks for.
}

/// Anyone can put tokens into a pool: the owner funding a prize, a sponsor, a player. It is not
/// a purchase, so neither switch stops it, and whoever sends it pays the project fee.
pub fn handle_deposit<'info>(ctx: Context<'info, Deposit<'info>>, index: u8, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0, LootError::ZeroAmount);

    a.fee.charge_project(&a.game, &a.depositor)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let before = tokens::balance(&a.pool);
    tokens.transfer(&a.mint, &a.from, &a.pool, &By::player(&a.depositor), amount)?;
    let amount = tokens::received(&a.pool, before)?;

    emit!(Deposited { game: a.game.key(), pool: index, depositor: a.depositor.key(), amount });
    Ok(())
}
