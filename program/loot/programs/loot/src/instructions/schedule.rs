//! A schedule: something the game does to its own pools on a timer, with nobody's signature.
//! The owner writes it once; after that anyone may run it each time it is due. Emissions with
//! halvings, a quarterly burn of the treasury pool, a weekly share of revenue to stakers.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{
    constants::*,
    error::LootError,
    pick::share,
    rail::pool_address,
    receipts::*,
    rent::{load, save},
    state::*,
    tokens::{self, Tokens},
};

/// What a schedule does each time it runs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    /// Mint `amount` of a mint the game controls into a pool. The amount halves after every
    /// `halve_every` runs (0: never).
    Issue { mint: Pubkey, pool: u8, amount: u64, halve_every: u32 },
    /// Burn a share of what a pool holds.
    Burn { pool: u8, bps: u16 },
    /// Move a share of what one pool holds to another pool of the same mint.
    Move { from: u8, to: u8, bps: u16 },
}

/// At `["schedule", game, id]`.
#[account(discriminator = &[6])]
pub struct Schedule {
    pub game: Pubkey,
    pub id: u32,
    pub bump: u8,
    pub active: bool,
    pub action: Action,
    /// Seconds between runs.
    pub every: i64,
    /// Unix time of the next run.
    pub next_at: i64,
    /// Runs so far.
    pub runs: u32,
    /// Stops after this many runs. 0: never stops.
    pub max_runs: u32,
}

// ---------------------------------------------------------------- upsert_schedule

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScheduleArgs {
    pub active: bool,
    pub action: Action,
    pub every: i64,
    pub next_at: i64,
    pub max_runs: u32,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct UpsertSchedule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the schedule's address. Read and written by hand.
    #[account(mut, seeds = [SCHEDULE_SEED, game.key().as_ref(), &id.to_le_bytes()], bump)]
    pub schedule: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Creates the schedule or replaces it. Its count of runs survives an edit, so a halving or a
/// last run cannot be reset by accident. A first run in the past starts now: anyone could
/// otherwise run every missed one back to back. A schedule mints and moves the game's money,
/// so only the owner writes one.
pub fn handle_upsert_schedule(ctx: Context<UpsertSchedule>, id: u32, args: ScheduleArgs) -> Result<()> {
    let a = &ctx.accounts;
    require!(args.every > 0, LootError::BadSchedule);
    let bps = match args.action {
        Action::Issue { .. } => 0,
        Action::Burn { bps, .. } | Action::Move { bps, .. } => bps,
    };
    require!(bps as u64 <= BPS, LootError::BadSchedule);
    // A move into the pool it leaves would be refused at every run (`tokens::transfer`).
    require!(!matches!(args.action, Action::Move { from, to, .. } if from == to), LootError::BadSchedule);

    let schedule = Schedule {
        game: a.game.key(),
        id,
        bump: ctx.bumps.schedule,
        active: args.active,
        action: args.action,
        every: args.every,
        next_at: args.next_at.max(Clock::get()?.unix_timestamp),
        runs: load::<Schedule>(&a.schedule)?.map_or(0, |old| old.runs),
        max_runs: args.max_runs,
    };
    let game = a.game.key();
    let seeds: &[&[u8]] = &[SCHEDULE_SEED, game.as_ref(), &id.to_le_bytes(), &[schedule.bump]];
    save(&a.schedule, &schedule, seeds, &a.owner, &a.system_program)
}

// ---------------------------------------------------------------- run_schedule

#[derive(Accounts)]
pub struct RunSchedule<'info> {
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub schedule: Account<'info, Schedule>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    // Then, by action:
    //   Issue: the mint, the pool
    //   Burn:  the mint, the pool
    //   Move:  the pool it leaves, the pool it enters, their mint, then any accounts a
    //          transfer hook asks for
}

/// Anyone may run a schedule once it is due. One call is one run: a schedule that fell behind
/// catches up one call at a time and keeps its rhythm.
pub fn handle_run_schedule<'info>(ctx: Context<'info, RunSchedule<'info>>) -> Result<()> {
    let s = &mut ctx.accounts.schedule;
    require!(Clock::get()?.unix_timestamp >= s.next_at, LootError::NotDue);
    require!(s.active && (s.max_runs == 0 || s.runs < s.max_runs), LootError::ScheduleOver);

    let game = &ctx.accounts.game;
    let [first, second, rest @ ..] = ctx.remaining_accounts else {
        return err!(LootError::WrongPool);
    };
    let tokens = Tokens { token: &ctx.accounts.token_program, token_2022: &ctx.accounts.token_2022_program, hook: rest };
    let is_pool = |account: &AccountInfo, index: u8| account.key() == pool_address(&game.key(), index);
    let amount = match s.action {
        Action::Issue { mint, pool, amount, halve_every } => {
            require!(first.key() == mint && is_pool(second, pool), LootError::WrongPool);
            let halvings = s.runs.checked_div(halve_every).unwrap_or(0);
            let amount = amount.checked_shr(halvings).unwrap_or(0);
            tokens.mint(game, first, second, amount)?;
            amount
        }
        Action::Burn { pool, bps } => {
            require!(is_pool(second, pool), LootError::WrongPool);
            let amount = share(tokens::holding(second)?.amount, bps).ok_or(LootError::Overflow)?;
            tokens.game_burn(game, first, second, amount)?;
            amount
        }
        Action::Move { from, to, bps } => {
            require!(is_pool(first, from) && is_pool(second, to), LootError::WrongPool);
            let amount = share(tokens::holding(first)?.amount, bps).ok_or(LootError::Overflow)?;
            let mint = rest.first().ok_or(LootError::WrongMint)?;
            tokens.send(game, mint, first, second, amount)?;
            amount
        }
    };

    s.runs += 1;
    s.next_at = s.next_at.checked_add(s.every).ok_or(LootError::Overflow)?;
    emit!(ScheduleRan { game: s.game, id: s.id, run: s.runs, action: s.action, amount });
    Ok(())
}
