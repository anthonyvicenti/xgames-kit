//! The platform's own settings. This is all the platform can do: set its two flat fees (each
//! capped, a raise waits 7 days), take out the fees paid so far from each game's fee box, name its next admin, and switch a game's
//! money in off and on.
use anchor_lang::prelude::*;

use crate::{constants::*, error::LootError, receipts::*, state::*};

// ---------------------------------------------------------------- init_platform

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Platform::SPACE, seeds = [PLATFORM_SEED], bump)]
    pub platform: Account<'info, Platform>,
    /// CHECK: this program's ProgramData account, checked in `require_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Only the program's upgrade authority can create the platform record, once.
pub fn handle_init_platform(
    ctx: Context<InitPlatform>,
    fees: Fees,
    partner: Pubkey,
) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.admin.key())?;
    require!(fees.no_raise_over(&MAX_FEES), LootError::FeeAboveCap);
    ctx.accounts.platform.set_inner(Platform {
        admin: ctx.accounts.admin.key(),
        partner,
        fees,
        pending: fees,
        pending_at: 0,
        bump: ctx.bumps.platform,
    });
    Ok(())
}

/// `signer` must be this program's upgrade authority. `program_data` is read as raw bytes (a
/// u32 tag 3, a u64 slot, then an optional key), because Anchor's typed reader adds 25 KB to
/// the program.
fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    use anchor_lang::solana_program::bpf_loader_upgradeable;
    // The address is derived, never taken from the caller: another program's ProgramData, where
    // the caller is the upgrade authority, must not pass.
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require_keys_eq!(program_data.key(), expected, ErrorCode::ConstraintSeeds);
    require_keys_eq!(*program_data.owner, bpf_loader_upgradeable::ID, ErrorCode::ConstraintOwner);
    let data = program_data.try_borrow_data()?;
    require!(
        data.len() >= 45 && data[..4] == [3, 0, 0, 0] && data[12] == 1 && data[13..45] == signer.to_bytes(),
        LootError::NotPlatform
    );
    Ok(())
}

// ---------------------------------------------------------------- set_platform

#[derive(Accounts)]
pub struct SetPlatform<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ LootError::NotPlatform)]
    pub platform: Account<'info, Platform>,
    /// Who signs for the platform from now on: the current admin to keep it. It signs, so a
    /// mistyped key can never take the platform over.
    pub next_admin: Signer<'info>,
}

/// New fees that raise either one wait `NOTICE_SECONDS`, both together (setting them again
/// restarts the wait). Fees that raise neither apply at once and drop any pending raise.
pub fn handle_set_platform(ctx: Context<SetPlatform>, fees: Fees) -> Result<()> {
    require!(fees.no_raise_over(&MAX_FEES), LootError::FeeAboveCap);
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.platform;
    // A raise that has already served its notice is the current fees.
    p.fees = p.fees(now);
    if fees.no_raise_over(&p.fees) {
        p.fees = fees;
        p.pending = fees;
        p.pending_at = 0;
    } else {
        p.pending = fees;
        p.pending_at = now.checked_add(NOTICE_SECONDS).ok_or(LootError::Overflow)?;
    }
    p.admin = ctx.accounts.next_admin.key();
    emit!(FeeChanged { fees: p.fees, pending: p.pending, pending_at: p.pending_at });
    Ok(())
}

// ---------------------------------------------------------------- collect_fees

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ LootError::NotPlatform)]
    pub platform: Account<'info, Platform>,
    /// CHECK: wherever the admin sends the fees.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    // Then: a game and its fee box (writable), for each game to collect from.
}

/// Moves every fee paid so far out of the fee boxes passed, and anything sent to the platform
/// record itself. Each keeps its own rent.
pub fn handle_collect_fees<'info>(ctx: Context<'info, CollectFees<'info>>) -> Result<()> {
    let rent = Rent::get()?;
    let platform = ctx.accounts.platform.to_account_info();
    let mut boxes = vec![(platform.clone(), rent.minimum_balance(platform.data_len()))];
    for pair in ctx.remaining_accounts.chunks(2) {
        let [game, fees] = pair else { return err!(ErrorCode::AccountNotEnoughKeys) };
        let game = Account::<Game>::try_from(game)?;
        require_keys_eq!(fees.key(), game.fees_address(&game.key())?, ErrorCode::ConstraintSeeds);
        boxes.push((fees.clone(), rent.minimum_balance(0)));
    }
    let mut total: u64 = 0;
    for (account, keep) in boxes {
        let spare = account.lamports().saturating_sub(keep);
        **account.try_borrow_mut_lamports()? -= spare;
        total = total.checked_add(spare).ok_or(LootError::Overflow)?;
    }
    **ctx.accounts.to.try_borrow_mut_lamports()? += total;
    Ok(())
}

// ---------------------------------------------------------------- set_suspended

/// The platform's switch on a game. It stops money in: `pay`, `buy_item`, `open_box`,
/// `craft`, `buy_tickets`, `stake`, `hold`, `enter`. It never stops what is owed: `settle`, `refund`, a roll,
/// `payout`, `unstake`, a lottery's draw and payment.
#[derive(Accounts)]
pub struct SetSuspended<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin @ LootError::NotPlatform)]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub game: Account<'info, Game>,
}

pub fn handle_set_suspended(ctx: Context<SetSuspended>, suspended: bool) -> Result<()> {
    ctx.accounts.game.suspended = suspended;
    emit!(GameSuspended { game: ctx.accounts.game.key(), suspended });
    Ok(())
}
