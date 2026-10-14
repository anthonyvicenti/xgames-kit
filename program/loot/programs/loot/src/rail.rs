//! The one rail. Every payment this program takes is split here, and the platform's fee is
//! charged here: `pay` and `settle` call `split`, a recipe's payment and a contest's shares
//! call `deliver`, and every instruction that asks for something calls `Fee::charge_*` (an
//! order pays it from its escrow into the game's fee box when it settles; finishing what is
//! decided is free).
use anchor_lang::prelude::*;
use crate::{
    asset,
    constants::*,
    error::LootError,
    pick::share,
    rent::pay_lamports,
    state::*,
    tokens::{self, By, Tokens},
};

// ---------------------------------------------------------------- the fee

/// The accounts a receipt needs to pay the platform's flat fee. The fee goes into the game's
/// own fee box (`FEES_SEED`), an account this program owns, so nothing the platform does can
/// make a fee unpayable and so stop a payout, and one game's traffic never waits on another's.
/// The platform record is only read, for the amount. The platform takes the fees out with
/// `collect_fees`.
#[derive(Accounts)]
pub struct Fee<'info> {
    pub platform: Account<'info, Platform>,
    /// CHECK: the game's fee box, checked against the game when the fee is paid.
    #[account(mut)]
    pub fees: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> Fee<'info> {
    /// A player pays the player fee, for something they signed for themselves.
    pub fn charge_player(&self, game: &Account<'info, Game>, player: &AccountInfo<'info>) -> Result<()> {
        let fee = self.platform.fees(Clock::get()?.unix_timestamp).player;
        self.pay(game, player, fee)
    }

    /// Whoever else signs pays the project fee: the game's keys, a sponsor.
    pub fn charge_project(&self, game: &Account<'info, Game>, payer: &AccountInfo<'info>) -> Result<()> {
        let fee = self.platform.fees(Clock::get()?.unix_timestamp).project;
        self.pay(game, payer, fee)
    }

    fn pay(&self, game: &Account<'info, Game>, payer: &AccountInfo<'info>, fee: u64) -> Result<()> {
        require_keys_eq!(self.fees.key(), game.fees_address(&game.key())?, ErrorCode::ConstraintSeeds);
        pay_lamports(payer, &self.fees, fee, &self.system_program)
    }
}

// ---------------------------------------------------------------- the split

/// A payment about to be split.
pub struct Payment<'a, 'info> {
    pub game: Pubkey,
    pub tokens: &'a Tokens<'a, 'info>,
    pub mint: &'a AccountInfo<'info>,
    /// Where the money is: the player's own token account, or the game's vault.
    pub from: &'a AccountInfo<'info>,
    /// Who can move it: the player (who signed), or the game (with `signer`).
    pub owner: &'a AccountInfo<'info>,
    pub signer: &'a [&'a [&'a [u8]]],
    pub treasury: &'a AccountInfo<'info>,
}

/// Sends each share of `amount` where it says, and what is left to the game's treasury.
/// `targets` are the accounts the shares name, in the order they name them (`deliver`).
/// Returns what the treasury got.
pub fn split<'info>(
    p: &Payment<'_, 'info>,
    amount: u64,
    shares: &[Share],
    targets: &[AccountInfo<'info>],
) -> Result<u64> {
    // When the shares take the whole payment, the last one also takes what rounding left, so
    // nothing is owed to the treasury (which matters for a payment in another mint).
    let takes_all = shares.iter().map(|s| s.bps as u64).sum::<u64>() == BPS;
    let mut left = amount;
    let mut targets = targets.iter();
    for (i, s) in shares.iter().enumerate() {
        let part = match takes_all && i + 1 == shares.len() {
            true => left,
            false => share(amount, s.bps).ok_or(LootError::Overflow)?,
        };
        deliver(p, s.to, part, &mut targets)?;
        left = left.checked_sub(part).ok_or(LootError::BadShares)?;
    }
    transfer(p, p.treasury, left)?;
    Ok(left)
}

/// Sends `amount` of a payment where `to` says. The accounts a destination needs are the next
/// of `targets`: its pool for `Pool`, the token account for `Account`, and for `Holder` the
/// collectible and then a token account of whoever holds it.
pub fn deliver<'info>(
    p: &Payment<'_, 'info>,
    to: To,
    amount: u64,
    targets: &mut std::slice::Iter<'_, AccountInfo<'info>>,
) -> Result<()> {
    let mut next = || targets.next().ok_or(LootError::WrongPool);
    match to {
        To::Burn => burn(p, amount),
        To::Pool(index) => {
            let pool = next()?;
            require_keys_eq!(pool.key(), pool_address(&p.game, index), LootError::WrongPool);
            transfer(p, pool, amount)
        }
        To::Account(address) => {
            let account = next()?;
            require_keys_eq!(account.key(), address, LootError::WrongPool);
            transfer(p, account, amount)
        }
        To::Holder(collectible) => {
            let (asset, account) = (next()?, next()?);
            require_keys_eq!(asset.key(), collectible, LootError::WrongPool);
            // Nobody holds one that was burned, and the game holding one for a player
            // (`hold.rs`) has no token account that is the player's. Then the share is burned.
            let Some(holder) = asset::holder(asset).filter(|holder| *holder != p.game) else {
                return burn(p, amount);
            };
            // The holder's account, and of this mint: anyone can open an account of a
            // worthless mint in the holder's name.
            let holding = tokens::holding(account)?;
            require!(holding.owner == holder && holding.mint == p.mint.key(), LootError::NotTheHolders);
            transfer(p, account, amount)
        }
    }
}

/// The address of a game's pool: a token account only the game can spend from.
pub fn pool_address(game: &Pubkey, index: u8) -> Pubkey {
    Pubkey::find_program_address(&[POOL_SEED, game.as_ref(), &[index]], &crate::ID).0
}

/// An optional pool account an instruction was handed, checked to be the game's pool `index`.
pub fn pool_account<'a, 'info>(
    account: &'a Option<UncheckedAccount<'info>>,
    game: &Pubkey,
    index: u8,
) -> Result<&'a AccountInfo<'info>> {
    match account {
        Some(account) if account.key() == pool_address(game, index) => Ok(account),
        _ => err!(LootError::WrongPool),
    }
}

fn transfer<'info>(p: &Payment<'_, 'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    p.tokens.transfer(p.mint, p.from, to, &By { authority: p.owner, seeds: p.signer }, amount)
}

fn burn<'info>(p: &Payment<'_, 'info>, amount: u64) -> Result<()> {
    p.tokens.burn(p.mint, p.from, &By { authority: p.owner, seeds: p.signer }, amount)
}
