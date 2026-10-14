//! A contest: players put money on a side, the game's authority names the side that won, and
//! its backers share the pot by what each put in. A duel where both stake and the winner
//! takes all. Spectators betting on a match. Factions over a season. A tournament where each
//! entrant is a side.
//!
//! The authority writes a contest and names the side that won. It cannot take the pot: the pot
//! is a vault of the contest's own that only `claim` pays from, to the players who entered. If
//! no result comes by the time the contest promised one, anyone calls it off and every entry
//! takes its own money back.
//!
//! A contest can keep a part of its pot: `shares` are taken when the result is named (a rake
//! that is burned, a cut to a pool, a share for whoever holds the arena). Nothing goes to the
//! treasury unless a share names it. The authority writes them, and every entry signs them. A
//! contest cannot be edited once it is open: what the players entered stays what it is.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use solana_sha256_hasher::hashv;

use crate::{
    constants::*,
    error::LootError,
    pick::share,
    rail::*,
    receipts::*,
    rent::{close, load, save},
    state::*,
    tokens::{self, By, Tokens},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    /// Taking entries, or waiting for its result.
    Open,
    /// A side won: `Contest::winner`.
    Won,
    /// Called off: every entry gets its own money back.
    Off,
}

/// At `["contest", game, id]`. Its pot is the token account at `["pot", contest]`.
#[account(discriminator = &[13])]
pub struct Contest {
    pub game: Pubkey,
    pub id: u32,
    pub bump: u8,
    /// The authority that opened it. Paid its rent, and gets it back when it closes.
    pub opener: Pubkey,
    /// The token it is played in.
    pub mint: Pubkey,
    /// Unix time entries stop.
    pub closes_at: i64,
    /// Unix time a result is due. After it, no result is taken and anyone can call the contest off.
    pub result_by: i64,
    /// A hash of what an entry agrees to (`terms`). A player signs it, so an entry never lands
    /// in another contest opened at the same id.
    pub terms: [u8; 32],
    pub verdict: Verdict,
    /// The side that won, once the verdict is `Won`.
    pub winner: u8,
    /// Entries not yet claimed.
    pub entries: u32,
    /// What the winning side shares, set when the result is named.
    pub prize: u64,
    /// What the winning side put in and has not yet claimed for.
    pub unclaimed: u64,
    /// The parts of the pot taken when the result is named.
    pub shares: Vec<Share>,
    /// What each side has put in.
    pub sides: Vec<u64>,
}

/// At `["entry", contest, player, side]`: what one player put on one side. They pay its rent
/// and get it back when it is claimed.
#[account(discriminator = &[14])]
pub struct Entry {
    pub contest: Pubkey,
    pub player: Pubkey,
    pub side: u8,
    pub bump: u8,
    pub amount: u64,
}

// ---------------------------------------------------------------- open_contest

/// What an entry agrees to: the token, the sides, the two times and the shares.
pub fn terms(mint: &Pubkey, args: &ContestArgs) -> [u8; 32] {
    let mut bytes = mint.to_bytes().to_vec();
    args.serialize(&mut bytes).unwrap();
    hashv(&[&bytes]).to_bytes()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ContestArgs {
    /// How many sides there are to back.
    pub sides: u8,
    pub closes_at: i64,
    pub result_by: i64,
    pub shares: Vec<Share>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct OpenContest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the contest's address. Written by hand because its size depends on its sides.
    #[account(mut, seeds = [CONTEST_SEED, game.key().as_ref(), &id.to_le_bytes()], bump)]
    pub contest: UncheckedAccount<'info>,
    /// CHECK: the contest's mint, of either token program.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the contest's pot.
    #[account(mut, seeds = [POT_SEED, contest.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

/// Opens a contest. An id is free again once the contest at it has closed.
pub fn handle_open_contest(ctx: Context<OpenContest>, id: u32, args: ContestArgs) -> Result<()> {
    let a = &ctx.accounts;
    require!(args.sides >= 2 && args.closes_at <= args.result_by, LootError::BadContest);
    check_later_shares(&args.shares, &a.mint.key(), &[a.pot.key()])?;
    require!(load::<Contest>(&a.contest)?.is_none(), LootError::ContestOpen);
    a.fee.charge_project(&a.game, &a.authority)?;

    let (game, contest_key) = (a.game.key(), a.contest.key());
    let system = &a.fee.system_program;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    tokens.open(&a.pot, &a.mint, &game, &a.authority, system, &[POT_SEED, contest_key.as_ref(), &[ctx.bumps.pot]])?;
    let contest = Contest {
        game,
        id,
        bump: ctx.bumps.contest,
        opener: a.authority.key(),
        mint: a.mint.key(),
        closes_at: args.closes_at,
        result_by: args.result_by,
        terms: terms(&a.mint.key(), &args),
        verdict: Verdict::Open,
        winner: 0,
        entries: 0,
        prize: 0,
        unclaimed: 0,
        shares: args.shares,
        sides: vec![0; args.sides as usize],
    };
    let seeds: &[&[u8]] = &[CONTEST_SEED, game.as_ref(), &id.to_le_bytes(), &[contest.bump]];
    save(&a.contest, &contest, seeds, &a.authority, system)
}

// ---------------------------------------------------------------- enter

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct Enter<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub contest: Account<'info, Contest>,
    /// CHECK: the player's entry on this side. Read and written by hand: it may not exist yet.
    #[account(mut, seeds = [ENTRY_SEED, contest.key().as_ref(), player.key().as_ref(), &[side]], bump)]
    pub entry: UncheckedAccount<'info>,
    /// CHECK: the contest's pot, by address.
    #[account(mut, seeds = [POT_SEED, contest.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: what the player pays from. The token program checks that they may spend it.
    #[account(mut)]
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: the contest's mint, by address.
    #[account(address = contest.mint)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

/// The player puts `amount` on `side`, or adds to what they already have there, in the contest
/// whose `terms` they saw. What a transfer fee leaves of `amount` is what counts.
pub fn handle_enter<'info>(ctx: Context<'info, Enter<'info>>, side: u8, amount: u64, terms: [u8; 32]) -> Result<()> {
    let a = &mut *ctx.accounts;
    a.game.open_for_money()?;
    require!(amount > 0, LootError::ZeroAmount);
    let open = a.contest.verdict == Verdict::Open && Clock::get()?.unix_timestamp < a.contest.closes_at;
    require!(open, LootError::ContestNotOpen);
    require!(a.contest.terms == terms, LootError::TermsChanged);
    require!((side as usize) < a.contest.sides.len(), LootError::BadContest);

    a.fee.charge_player(&a.game, &a.player)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let before = tokens::balance(&a.pot);
    tokens.transfer(&a.mint, &a.player_token, &a.pot, &By::player(&a.player), amount)?;
    let amount = tokens::received(&a.pot, before)?;
    let total = a.contest.sides.get_mut(side as usize).ok_or(LootError::BadContest)?;
    *total = total.checked_add(amount).ok_or(LootError::Overflow)?;

    let (contest, player) = (a.contest.key(), a.player.key());
    let mut entry = match load::<Entry>(&a.entry)? {
        Some(entry) => entry,
        None => {
            a.contest.entries += 1;
            Entry { contest, player, side, bump: ctx.bumps.entry, amount: 0 }
        }
    };
    entry.amount += amount; // no more than the side's total, which did not overflow
    let seeds: &[&[u8]] = &[ENTRY_SEED, contest.as_ref(), player.as_ref(), &[side], &[entry.bump]];
    save(&a.entry, &entry, seeds, &a.player, &a.fee.system_program)?;

    emit!(Entered { game: a.game.key(), id: a.contest.id, player, side, amount });
    Ok(())
}

// ---------------------------------------------------------------- decide and call_off

#[derive(Accounts)]
pub struct Decide<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game, has_one = mint)]
    pub contest: Account<'info, Contest>,
    /// CHECK: the contest's mint, by address. Writable for a burn share.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the contest's pot, by address.
    #[account(mut, seeds = [POT_SEED, contest.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: the accounts the contest's shares name, in the same order (`rail::deliver`).
}

/// The authority names the side that won, no later than the result was due. The contest's
/// shares leave the pot now, and the rest is the prize. Entries stop here, so nobody enters
/// knowing the result.
pub fn handle_decide<'info>(ctx: Context<'info, Decide<'info>>, side: u8, reference: [u8; 32]) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.contest.verdict == Verdict::Open, LootError::ContestNotOpen);
    require!(Clock::get()?.unix_timestamp <= a.contest.result_by, LootError::ResultOverdue);
    let backed = *a.contest.sides.get(side as usize).ok_or(LootError::BadContest)?;
    require!(backed > 0, LootError::NoWinner);
    a.fee.charge_project(&a.game, &a.authority)?;

    let pot = tokens::holding(&a.pot)?.amount;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let game_signer: &[&[u8]] = &[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]];
    let payment = Payment {
        game: a.game.key(),
        tokens: &tokens,
        mint: &a.mint,
        from: &a.pot,
        owner: &a.game.to_account_info(),
        signer: &[game_signer],
        treasury: &a.pot, // unused: what the shares leave is the prize
    };
    let mut prize = pot;
    let targets = &mut ctx.remaining_accounts.iter();
    for s in &a.contest.shares {
        let part = share(pot, s.bps).ok_or(LootError::Overflow)?;
        deliver(&payment, s.to, part, targets)?;
        prize -= part;
    }
    a.contest.verdict = Verdict::Won;
    a.contest.winner = side;
    a.contest.prize = prize;
    a.contest.unclaimed = backed;

    emit!(Decided { game: a.game.key(), id: a.contest.id, side, pot, prize, reference });
    Ok(())
}

#[derive(Accounts)]
pub struct CallOff<'info> {
    pub signer: Signer<'info>,
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub contest: Account<'info, Contest>,
}

/// Calls an open contest off: the authority at any time, anyone once its result is overdue.
pub fn handle_call_off(ctx: Context<CallOff>) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.contest.verdict == Verdict::Open, LootError::ContestNotOpen);
    let overdue = Clock::get()?.unix_timestamp > a.contest.result_by;
    require!(overdue || a.signer.key() == a.game.authority, LootError::NotDue);
    a.contest.verdict = Verdict::Off;
    emit!(CalledOff { game: a.game.key(), id: a.contest.id });
    Ok(())
}

// ---------------------------------------------------------------- claim

#[derive(Accounts)]
pub struct Claim<'info> {
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub contest: Account<'info, Contest>,
    #[account(mut, close = player, has_one = contest, has_one = player)]
    pub entry: Account<'info, Entry>,
    /// CHECK: the entry's player. Gets its rent.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: the contest's pot, by address.
    #[account(mut, seeds = [POT_SEED, contest.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: where the money goes: a token account the player owns (checked below).
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: the contest's mint, by address.
    #[account(address = contest.mint)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Anyone sends this for any entry once the contest has a result, and the money can only go
/// to the entry's player. A winning entry gets its part of the prize, a losing one nothing,
/// and every entry of a contest that was called off gets its own money back. It costs no fee,
/// and no switch of the owner or the platform stops it.
pub fn handle_claim<'info>(ctx: Context<'info, Claim<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    let (contest, entry) = (&mut a.contest, &a.entry);
    let amount = match contest.verdict {
        Verdict::Open => return err!(LootError::ContestOpen),
        Verdict::Off => entry.amount,
        Verdict::Won if contest.winner != entry.side => 0,
        Verdict::Won => {
            let backed = contest.sides[contest.winner as usize];
            let last = entry.amount == contest.unclaimed;
            contest.unclaimed -= entry.amount;
            match last {
                // The last winner also takes what rounding left.
                true => tokens::holding(&a.pot)?.amount,
                false => (contest.prize as u128 * entry.amount as u128 / backed as u128) as u64,
            }
        }
    };
    contest.entries -= 1;
    if amount > 0 {
        require_keys_eq!(tokens::holding(&a.to)?.owner, entry.player, LootError::NotThePlayers);
        let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
        tokens.send(&a.game, &a.mint, &a.pot, &a.to, amount)?;
    }
    emit!(Claimed { game: a.game.key(), id: contest.id, player: entry.player, side: entry.side, amount });
    Ok(())
}

// ---------------------------------------------------------------- close_contest

#[derive(Accounts)]
pub struct CloseContest<'info> {
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game, has_one = mint, has_one = opener)]
    pub contest: Account<'info, Contest>,
    /// CHECK: who opened the contest. Gets the rent back.
    #[account(mut)]
    pub opener: UncheckedAccount<'info>,
    /// CHECK: the contest's mint, by address.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the contest's pot, by address.
    #[account(mut, seeds = [POT_SEED, contest.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Anyone closes a contest once it has a result and every entry is claimed. The rent of the
/// contest and its pot goes back to whoever opened it. Tokens someone sent straight to the pot
/// mostly went to the winners already: before `decide` they became part of the prize, and
/// after it the last claim took them with what rounding left. Only what arrived after the last
/// claim is still here. It belongs to nobody and is burned (wrapped SOL cannot be burned:
/// closing the pot releases it with the rent).
pub fn handle_close_contest(ctx: Context<CloseContest>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.contest.verdict != Verdict::Open, LootError::ContestOpen);
    require!(a.contest.entries == 0, LootError::EntriesLeft);
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: &[] };
    if !tokens::is_wrapped_sol(&a.contest.mint) {
        tokens.game_burn(&a.game, &a.mint, &a.pot, tokens::holding(&a.pot)?.amount)?;
    }
    tokens.close(&a.game, &a.mint, &a.pot, &a.opener)?;
    close(&a.contest.to_account_info(), &a.opener)
}
