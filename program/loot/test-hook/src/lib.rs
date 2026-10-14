//! A transfer hook for the loot tests. Token-2022 calls it on every transfer of a mint that
//! names it, with the transfer's source, mint, destination and authority, the mint's list of
//! extra accounts, then those accounts. Here the one extra account is a counter this program
//! owns: each transfer adds one to it, and a transfer of 13 is refused. If any account arrives
//! as a signer, the counter's second number is set to 1: a hook must never get a signature.
#![no_std]
use pinocchio::{account_info::AccountInfo, entrypoint, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // 8 bytes of discriminator, then the amount.
    let amount = data.get(8..16).ok_or(ProgramError::InvalidInstructionData)?;
    if u64::from_le_bytes(amount.try_into().unwrap()) == 13 {
        return Err(ProgramError::Custom(13));
    }
    let counter = accounts.get(5).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let signed = accounts.iter().any(|a| a.is_signer());
    let mut data = counter.try_borrow_mut_data()?;
    let count = u64::from_le_bytes(data[..8].try_into().unwrap()) + 1;
    data[..8].copy_from_slice(&count.to_le_bytes());
    if signed && data.len() >= 16 {
        data[8..16].copy_from_slice(&1u64.to_le_bytes());
    }
    Ok(())
}
