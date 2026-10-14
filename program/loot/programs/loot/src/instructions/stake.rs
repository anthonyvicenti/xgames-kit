//! Staking: players lock a token and share what flows into a rewards pool, each by how much
//! they have staked, with nobody's signature.
//!
//! The rewards pool is an ordinary pool of the game, so anything can feed it: a share of
//! every sale, a schedule, a deposit. Each time someone stakes or unstakes, whatever the pool
//! holds is first moved into the stake's own rewards vault and credited to everyone staked at
//! that moment. Staked tokens and credited rewards sit in two vaults the game's authority
//! cannot pay out of.
//!
//! Two things the owner must get right, because the program cannot:
//! - Give a stake a rewards pool of its own. It takes ALL that pool holds, so a pool shared
//!   with a lottery's pot or a second stake would be emptied by whoever comes first.
//! - Set a lock at least as long as the gap between rewards. Without one, someone can stake a
//!   large sum just before a reward lands and leave right after, taking most of it.
//!
//! The sum behind it: `reward_per_token` only ever grows, by `new rewards / total staked`. A
//! position remembers its value when it was last paid, and is owed
//! `amount * (reward_per_token - remembered)`.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{
    constants::*,
    error::LootError,
    rail::*,
    receipts::*,
    rent::{close, load, save},
    state::*,
    tokens::{self, By, Tokens},
};

/// `reward_per_token` is kept times this, so small rewards over large stakes are not lost.
const PRECISION: u128 = 1_000_000_000_000;

/// At `["stake", game, id]`.
#[account(discriminator = &[9])]
#[derive(InitSpace)]
pub struct Stake {
    pub game: Pubkey,
    pub id: u32,
    pub bump: u8,
    /// The token players stake.
    pub mint: Pubkey,
    /// The pool rewards arrive in, and the mint it had when the stake was opened.
    pub rewards_pool: u8,
    pub rewards_mint: Pubkey,
    /// Seconds a position must wait, after its last stake, before any of it can be taken out.
    pub lock: i64,
    /// Staked by everyone, right now.
    pub total: u64,
    /// Rewards credited so far for each staked token, times `PRECISION`.
    pub reward_per_token: u128,
}

/// At `["position", stake, player]`: one player's stake. They pay its rent and get it back
/// when they unstake everything.
#[account(discriminator = &[10])]
#[derive(InitSpace)]
pub struct Position {
    pub stake: Pubkey,
    pub player: Pubkey,
    pub bump: u8,
    pub amount: u64,
    /// Unix time of its last stake. The lock counts from here.
    pub since: i64,
    /// `reward_per_token` when this position was last paid.
    pub paid_per_token: u128,
}

// ---------------------------------------------------------------- open_stake

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct OpenStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    #[account(
        init,
        payer = owner,
        space = 1 + Stake::INIT_SPACE,
        seeds = [STAKE_SEED, game.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub stake: Account<'info, Stake>,
    /// CHECK: the token players will stake, a mint of either program.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the mint of the rewards pool.
    pub rewards_mint: UncheckedAccount<'info>,
    /// CHECK: where staked tokens are kept.
    #[account(mut, seeds = [STAKED_SEED, stake.key().as_ref()], bump)]
    pub staked_vault: UncheckedAccount<'info>,
    /// CHECK: where credited rewards are kept.
    #[account(mut, seeds = [REWARDS_SEED, stake.key().as_ref()], bump)]
    pub rewards_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Opens a stake. It cannot be edited afterwards: what stakers agreed to stays what it is.
pub fn handle_open_stake(ctx: Context<OpenStake>, id: u32, rewards_pool: u8, lock: i64) -> Result<()> {
    let a = &ctx.accounts;
    let stake = a.stake.key();
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    for (vault, mint, seed, bump) in [
        (&a.staked_vault, &a.mint, STAKED_SEED, ctx.bumps.staked_vault),
        (&a.rewards_vault, &a.rewards_mint, REWARDS_SEED, ctx.bumps.rewards_vault),
    ] {
        tokens.open(vault, mint, &a.game.key(), &a.owner, &a.system_program, &[seed, stake.as_ref(), &[bump]])?;
    }
    ctx.accounts.stake.set_inner(Stake {
        game: a.game.key(),
        id,
        bump: ctx.bumps.stake,
        mint: a.mint.key(),
        rewards_pool,
        rewards_mint: a.rewards_mint.key(),
        lock: lock.max(0),
        total: 0,
        reward_per_token: 0,
    });
    Ok(())
}

// ---------------------------------------------------------------- stake and unstake

/// The accounts both take.
#[derive(Accounts)]
pub struct Staking<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub stake: Account<'info, Stake>,
    /// CHECK: the player's position. Read and written by hand: it may not exist yet.
    #[account(mut, seeds = [POSITION_SEED, stake.key().as_ref(), player.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the stake's vault of staked tokens, by address.
    #[account(mut, seeds = [STAKED_SEED, stake.key().as_ref()], bump)]
    pub staked_vault: UncheckedAccount<'info>,
    /// CHECK: the stake's vault of rewards, by address.
    #[account(mut, seeds = [REWARDS_SEED, stake.key().as_ref()], bump)]
    pub rewards_vault: UncheckedAccount<'info>,
    /// CHECK: the pool rewards arrive in (checked below).
    #[account(mut)]
    pub rewards_pool: UncheckedAccount<'info>,
    /// CHECK: the player's account of the staked token.
    #[account(mut)]
    pub player_tokens: UncheckedAccount<'info>,
    /// CHECK: where the player wants their rewards.
    #[account(mut)]
    pub player_rewards: UncheckedAccount<'info>,
    /// CHECK: the staked token's mint, by address.
    #[account(address = stake.mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the rewards' mint, by address.
    #[account(address = stake.rewards_mint)]
    pub rewards_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: any accounts a transfer hook asks for.
}

impl<'info> Staking<'info> {
    /// Credits what has arrived in the rewards pool to today's stakers, then pays this
    /// position everything it is owed. Returns the position (a new one if the player has
    /// none) and what was paid.
    ///
    /// With `forfeit`, no reward token moves at all: the position gives up what it is owed,
    /// which stays in the rewards vault for good. That is the way out when the rewards cannot
    /// be paid, a rewards vault frozen by its mint's freeze authority.
    fn pay_rewards(&mut self, tokens: &Tokens<'_, 'info>, bump: u8, forfeit: bool) -> Result<(Position, u64)> {
        let stake_key = self.stake.key();
        require_keys_eq!(
            self.rewards_pool.key(),
            pool_address(&self.game.key(), self.stake.rewards_pool),
            LootError::WrongPool
        );
        // If the owner closed the pool, or reopened it in another mint, nothing arrives. That
        // must never stop a staker from getting out.
        let arrived = match tokens::read(&self.rewards_pool) {
            Some(pool) if pool.mint == self.stake.rewards_mint && !forfeit => pool.amount,
            _ => 0,
        };
        if arrived > 0 && self.stake.total > 0 {
            // What a transfer fee leaves is what is credited.
            let before = tokens::balance(&self.rewards_vault);
            tokens.send(&self.game, &self.rewards_mint, &self.rewards_pool, &self.rewards_vault, arrived)?;
            let credited = tokens::received(&self.rewards_vault, before)?;
            self.stake.reward_per_token += credited as u128 * PRECISION / self.stake.total as u128;
        }

        let mut position = load::<Position>(&self.position)?.unwrap_or(Position {
            stake: stake_key,
            player: self.player.key(),
            bump,
            amount: 0,
            since: 0,
            paid_per_token: 0,
        });
        let owed = match forfeit {
            true => 0,
            false => position.amount as u128 * (self.stake.reward_per_token - position.paid_per_token) / PRECISION,
        };
        tokens.send(&self.game, &self.rewards_mint, &self.rewards_vault, &self.player_rewards, owed as u64)?;
        position.paid_per_token = self.stake.reward_per_token;
        Ok((position, owed as u64))
    }

    /// Writes the position back, or closes it when it is empty.
    fn keep(&self, position: &Position) -> Result<()> {
        if position.amount == 0 {
            return close(&self.position, &self.player);
        }
        let (stake, player) = (self.stake.key(), self.player.key());
        let seeds: &[&[u8]] = &[POSITION_SEED, stake.as_ref(), player.as_ref(), &[position.bump]];
        save(&self.position, position, seeds, &self.player, &self.fee.system_program)
    }
}

/// Stakes `amount` more, and pays the rewards owed so far. What a transfer fee leaves of
/// `amount` is what is staked.
pub fn handle_stake<'info>(ctx: Context<'info, Staking<'info>>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    let (token, token_2022) = (a.token_program.to_account_info(), a.token_2022_program.to_account_info());
    let tokens = Tokens { token: &token, token_2022: &token_2022, hook: ctx.remaining_accounts };
    a.game.open_for_money()?;
    require!(amount > 0, LootError::ZeroAmount);

    a.fee.charge_player(&a.game, &a.player)?;
    let (mut position, rewards) = a.pay_rewards(&tokens, ctx.bumps.position, false)?;
    let before = tokens::balance(&a.staked_vault);
    tokens.transfer(&a.mint, &a.player_tokens, &a.staked_vault, &By::player(&a.player), amount)?;
    let amount = tokens::received(&a.staked_vault, before)?;
    position.amount = position.amount.checked_add(amount).ok_or(LootError::Overflow)?;
    position.since = Clock::get()?.unix_timestamp;
    a.stake.total = a.stake.total.checked_add(amount).ok_or(LootError::Overflow)?;
    a.keep(&position)?;

    emit!(Staked {
        game: a.game.key(),
        id: a.stake.id,
        player: a.player.key(),
        amount,
        rewards,
        staked: position.amount,
    });
    Ok(())
}

/// Takes `amount` back out once the stake's lock has run, and pays the rewards owed so far, or
/// gives them up with `forfeit`. An `amount` of zero only collects the rewards, lock or no lock.
/// No switch of the owner or the platform stops it.
pub fn handle_unstake<'info>(ctx: Context<'info, Staking<'info>>, amount: u64, forfeit: bool) -> Result<()> {
    let a = &mut *ctx.accounts;
    let (token, token_2022) = (a.token_program.to_account_info(), a.token_2022_program.to_account_info());
    let tokens = Tokens { token: &token, token_2022: &token_2022, hook: ctx.remaining_accounts };
    a.fee.charge_player(&a.game, &a.player)?;
    let (mut position, rewards) = a.pay_rewards(&tokens, ctx.bumps.position, forfeit)?;
    let unlocked = Clock::get()?.unix_timestamp >= position.since.saturating_add(a.stake.lock);
    require!(amount == 0 || unlocked, LootError::StillLocked);
    position.amount = position.amount.checked_sub(amount).ok_or(LootError::MoreThanStaked)?;
    a.stake.total -= amount;
    tokens.send(&a.game, &a.mint, &a.staked_vault, &a.player_tokens, amount)?;
    a.keep(&position)?;

    emit!(Unstaked {
        game: a.game.key(),
        id: a.stake.id,
        player: a.player.key(),
        amount,
        rewards,
        staked: position.amount,
    });
    Ok(())
}
