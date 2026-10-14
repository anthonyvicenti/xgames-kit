//! The registry: which token is a game's official one, the token that was launched with
//! games.fun and pays games.fun its share (`venue.rs`). It is a record, not a gate: no economy
//! instruction reads it. A reader of the economy can skip this file and `venue.rs`.
//!
//! The token: `attach_token` writes a game's official token after the venue's own
//! accounts pass (`venue.rs`) and the launcher signs; `recheck_token` lets anyone clear a token
//! that stopped passing.
use anchor_lang::prelude::*;

use crate::{
    error::LootError,
    receipts::*,
    rent::fit,
    state::*,
    venue::{judge, Acct, Verdict},
};

fn verdict(
    venue: Venue,
    mint: &Pubkey,
    partner: &Pubkey,
    a: &UncheckedAccount,
    b: &UncheckedAccount,
) -> Result<Verdict> {
    let (da, db) = (a.try_borrow_data()?, b.try_borrow_data()?);
    judge(
        venue,
        mint,
        partner,
        &Acct { key: a.key, owner: a.owner, data: &da },
        &Acct { key: b.key, owner: b.owner, data: &db },
    )
}

#[derive(Accounts)]
pub struct AttachToken<'info> {
    /// The game's owner. Pays the 33 bytes of rent the record takes.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// The wallet that launched the token: the Meteora pool's creator, or the pump.fun coin's
    /// shareholder that is not the partner. Its signature is the proof that the launcher
    /// agrees this game is the token's game. May be the same key as `owner`.
    pub launcher: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    pub platform: Account<'info, Platform>,
    /// CHECK: Meteora: the DBC virtual pool of `mint`. pump.fun: the mint's bonding curve PDA.
    /// Owner, discriminator, length and address are checked in `venue::judge`.
    pub venue_a: UncheckedAccount<'info>,
    /// CHECK: Meteora: the pool's config. pump.fun: the mint's fee-sharing config PDA.
    /// Checked in `venue::judge`.
    pub venue_b: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attach_token(ctx: Context<AttachToken>, venue: Venue, mint: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    let launcher = match verdict(venue, &mint, &a.platform.partner, &a.venue_a, &a.venue_b)? {
        Verdict::Pass(launcher) => launcher,
        Verdict::Fail(reason) => return Err(reason.into()),
    };
    require_keys_eq!(a.launcher.key(), launcher, LootError::LauncherMustSign);

    let game = &mut ctx.accounts.game;
    game.official = Some(OfficialToken { mint, venue });
    let space = game.space_now();
    emit!(TokenAttached { game: game.key(), mint, venue, launcher });
    fit(&game.to_account_info(), space, &ctx.accounts.owner, &ctx.accounts.system_program)
}

/// Anyone can run the same checks again, without the signature. The token is cleared only when
/// the venue's own accounts for the recorded mint are shown and a rule no longer holds. Wrong
/// accounts are an error and change nothing, so a passing token cannot be cleared by a caller's
/// choice of accounts. No lamports move: the 33 bytes stay allocated until the game's next
/// `update_game` or `attach_token`.
#[derive(Accounts)]
pub struct RecheckToken<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub platform: Account<'info, Platform>,
    /// CHECK: as in `attach_token`.
    pub venue_a: UncheckedAccount<'info>,
    /// CHECK: as in `attach_token`.
    pub venue_b: UncheckedAccount<'info>,
}

pub fn handle_recheck_token(ctx: Context<RecheckToken>) -> Result<()> {
    let a = &ctx.accounts;
    let token = a.game.official.ok_or(LootError::NoToken)?;
    if let Verdict::Fail(reason) =
        verdict(token.venue, &token.mint, &a.platform.partner, &a.venue_a, &a.venue_b)?
    {
        let game = &mut ctx.accounts.game;
        game.official = None;
        emit!(TokenCleared {
            game: game.key(),
            mint: token.mint,
            venue: token.venue,
            reason: reason as u32 + anchor_lang::error::ERROR_CODE_OFFSET,
        });
    }
    Ok(())
}
