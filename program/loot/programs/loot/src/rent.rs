//! Keeping accounts exactly as big as what they hold. Whoever signs an edit pays for growth and
//! gets the rent of a shrink back.
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::error::LootError;

/// Reads the account if this program already wrote it, `None` if nothing is there yet.
pub fn load<T: AccountDeserialize>(account: &AccountInfo) -> Result<Option<T>> {
    if *account.owner == crate::ID {
        return Ok(Some(T::try_deserialize(&mut &account.try_borrow_data()?[..])?));
    }
    require!(
        *account.owner == system_program::ID && account.data_is_empty(),
        ErrorCode::ConstraintOwner
    );
    Ok(None)
}

/// Writes `value` to the account at the address of `seeds`, creating it or resizing it to fit.
pub fn save<'info, T: AccountSerialize>(
    account: &AccountInfo<'info>,
    value: &T,
    seeds: &[&[u8]],
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
) -> Result<()> {
    let mut bytes = Vec::new();
    value.try_serialize(&mut bytes)?;
    if *account.owner == crate::ID {
        fit(account, bytes.len(), payer, system)?;
    } else {
        create(account, bytes.len(), &crate::ID, payer, system, seeds)?;
    }
    account.try_borrow_mut_data()?.copy_from_slice(&bytes);
    Ok(())
}

/// Resizes an account this program owns to exactly `len` bytes and settles the rent difference
/// with `payer`. Call it after every other CPI of the instruction: a shrink moves lamports
/// directly.
pub fn fit<'info>(
    account: &AccountInfo<'info>,
    len: usize,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
) -> Result<()> {
    let rent = Rent::get()?;
    let need = rent.minimum_balance(len);
    let have = account.lamports();
    if have < need {
        pay_lamports(payer, account, need - have, system)?;
    } else {
        give(account, payer, have - need, &rent)?;
    }
    if account.data_len() != len {
        account.resize(len)?;
    }
    Ok(())
}

/// Moves spare lamports out of an account this program owns, unless that would leave `to` with
/// less than its own rent minimum: a validator refuses any transaction that does, and returning
/// spare rent must never be why an instruction fails. Then they stay, and the next `fit` offers
/// them again.
pub fn give<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64, rent: &Rent) -> Result<()> {
    let after = to.lamports().checked_add(lamports).ok_or(LootError::Overflow)?;
    if lamports > 0 && after >= rent.minimum_balance(to.data_len()) {
        **from.try_borrow_mut_lamports()? -= lamports;
        **to.try_borrow_mut_lamports()? = after;
    }
    Ok(())
}

/// Creates an account of `space` bytes, owned by `owner`, at the address of `seeds`. It also
/// works when someone already sent lamports there, which makes a plain `create_account` fail
/// and would let anyone block an owner's item or pool.
pub fn create<'info>(
    account: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let need = Rent::get()?.minimum_balance(space);
    let have = account.lamports();
    if have < need {
        pay_lamports(payer, account, need - have, system)?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Allocate { account_to_allocate: account.clone() },
            &[seeds],
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Assign { account_to_assign: account.clone() },
            &[seeds],
        ),
        owner,
    )
}

/// A plain SOL transfer from a signer.
pub fn pay_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
    system: &AccountInfo<'info>,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(system.key(), system_program::Transfer { from: from.clone(), to: to.clone() }),
        lamports,
    )
}

/// The same, from an address only this program can sign for.
pub fn pay_lamports_signed<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Transfer { from: from.clone(), to: to.clone() },
            &[seeds],
        ),
        lamports,
    )
}

/// Closes an account this program owns and gives its rent to `to`.
pub fn close<'info>(account: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<()> {
    if *account.owner != crate::ID {
        return Ok(()); // it was never created
    }
    **to.try_borrow_mut_lamports()? += account.lamports();
    **account.try_borrow_mut_lamports()? = 0;
    account.resize(0)?;
    account.assign(&system_program::ID);
    Ok(())
}
