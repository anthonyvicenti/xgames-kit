//! Every token call the program makes, each one function: five moves, opening and closing an
//! account, and reading one. The game signs for what it owns (its pools, its vaults, the mints
//! it controls); a player signs for what they own. A move of zero does nothing.
//!
//! A mint is the classic SPL Token program's or Token-2022's, and each call goes to the program
//! that owns the mint. So every instruction that moves tokens takes both programs (`Tokens`).
//! The two programs share the instructions used here, byte for byte, and they are written out
//! by hand as the four Metaplex Core calls are (`core_cpi.rs`).
//!
//! What Token-2022 adds, and what the program does about it:
//! - A transfer is always `TransferChecked`, which Token-2022 requires for mints with a fee or
//!   a hook, and which the classic program also takes.
//! - A transfer hook runs on every transfer of its mint. The accounts it asks for come in the
//!   instruction's remaining accounts, after whatever the instruction itself reads there, and
//!   every transfer of a Token-2022 mint hands them all on: Token-2022 takes the ones its hook
//!   names (by address) and ignores the rest. The hook gets no signature of ours.
//! - A transfer fee takes part of what is sent before it arrives. Where the program writes down
//!   an amount (what an order paid, what a player staked or put on a side), it writes what
//!   arrived (`received`). Before closing an account that holds fees withheld for the mint, it
//!   sweeps them to the mint (`close`), which anyone may do.
//! - A token account's owner can require a memo before every transfer into it. A transfer to
//!   such an account first sends a memo through the Memo program, which the sender passes with
//!   the hook's accounts; so nobody can stop what the program owes them, or anyone else, by
//!   turning memos on.
//! - A token account of a Token-2022 mint can be bigger than 165 bytes. Accounts the program
//!   opens ask Token-2022 for their size.
//! - Everything else a Token-2022 mint can carry is the mint's and its owner's business, as a
//!   classic mint's freeze authority already is: a permanent delegate can move tokens out of
//!   the game's own accounts, a default frozen state or a pause stops transfers into and out of
//!   them, a non-transferable mint can only be burned, and a hook decides each transfer for
//!   itself (it can refuse a settle and let the refund after it through).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
};

use crate::{constants::*, error::LootError, rent::create, state::Game};

pub const TOKEN_ID: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Wrapped SOL, in each program. It can't be burned.
pub const WRAPPED_SOL: Pubkey = anchor_spl::token::spl_token::native_mint::ID;
pub const WRAPPED_SOL_2022: Pubkey = pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

/// The Memo program (v2), for transfers into accounts that require a memo.
pub const MEMO_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// A plain token account, and how far into a Token-2022 account its type byte sits.
const ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;
/// A multisig of either program. It has no type byte, so its byte 165 is part of a key anyone
/// chooses, and it must never be read as an account or a mint.
const MULTISIG_LEN: usize = 355;

pub fn is_wrapped_sol(mint: &Pubkey) -> bool {
    *mint == WRAPPED_SOL || *mint == WRAPPED_SOL_2022
}

/// The two token programs, as an instruction has them, and the accounts a transfer hook may ask
/// for (the instruction's remaining accounts).
pub struct Tokens<'a, 'info> {
    pub token: &'a AccountInfo<'info>,
    pub token_2022: &'a AccountInfo<'info>,
    pub hook: &'a [AccountInfo<'info>],
}

/// Who signs a call: a player (who signed the transaction), or the game (by its seeds).
pub struct By<'a, 'info> {
    pub authority: &'a AccountInfo<'info>,
    pub seeds: &'a [&'a [&'a [u8]]],
}

impl<'a, 'info> By<'a, 'info> {
    pub fn player(player: &'a AccountInfo<'info>) -> Self {
        By { authority: player, seeds: &[] }
    }
}

/// The game's own signature.
pub fn game_seeds(game: &Game) -> [&[u8]; 3] {
    [GAME_SEED, game.collection.as_ref(), std::slice::from_ref(&game.bump)]
}

impl<'a, 'info> Tokens<'a, 'info> {
    /// The program that owns `mint`.
    pub fn program(&self, mint: &AccountInfo) -> Result<&'a AccountInfo<'info>> {
        match *mint.owner {
            id if id == TOKEN_ID => Ok(self.token),
            id if id == TOKEN_2022_ID => Ok(self.token_2022),
            _ => err!(LootError::NotAMint),
        }
    }

    fn call(&self, program: &AccountInfo<'info>, data: Vec<u8>, accounts: Vec<(&AccountInfo<'info>, bool, bool)>, by: &By<'_, 'info>) -> Result<()> {
        let mut metas: Vec<AccountMeta> = accounts.iter().map(|(a, writable, signer)| AccountMeta { pubkey: a.key(), is_writable: *writable, is_signer: *signer }).collect();
        let mut infos: Vec<AccountInfo<'info>> = accounts.iter().map(|(a, _, _)| (*a).clone()).collect();
        // A Token-2022 transfer hands on the accounts its hook may need. Nothing of ours signs them.
        if program.key() == TOKEN_2022_ID && data[0] == TRANSFER_CHECKED {
            metas.extend(self.hook.iter().map(|a| AccountMeta { pubkey: a.key(), is_writable: a.is_writable, is_signer: false }));
            infos.extend(self.hook.iter().cloned());
        }
        infos.push(program.clone());
        let ix = Instruction { program_id: program.key(), accounts: metas, data };
        invoke_signed(&ix, &infos, by.seeds).map_err(Into::into)
    }

    /// Moves `amount` of `mint` from `from` to `to`, signed `by` whoever may spend `from`.
    /// The game paying into the account it pays from is refused: the token program would accept
    /// it and move nothing, and the program would record it as paid (a staker's rewards, a
    /// recipe's output). A player paying themselves, a share that comes back to the holder who
    /// pays it, nets to zero and is fine.
    pub fn transfer(&self, mint: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, by: &By<'_, 'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        require!(by.seeds.is_empty() || from.key() != to.key(), LootError::SameAccount);
        let mut data = vec![TRANSFER_CHECKED];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals(mint)?);
        let program = self.program(mint)?;
        if program.key() == TOKEN_2022_ID && requires_memo(to) {
            let memo = self.hook.iter().find(|a| a.key() == MEMO_ID).ok_or(LootError::MemoNeeded)?;
            let ix = Instruction { program_id: MEMO_ID, accounts: vec![], data: b"loot".to_vec() };
            invoke(&ix, std::slice::from_ref(memo))?;
        }
        let accounts = vec![(from, true, false), (mint, false, false), (to, true, false), (by.authority, false, true)];
        self.call(program, data, accounts, by)
    }

    /// Burns `amount` of `mint` from `from`.
    pub fn burn(&self, mint: &AccountInfo<'info>, from: &AccountInfo<'info>, by: &By<'_, 'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let mut data = vec![BURN];
        data.extend_from_slice(&amount.to_le_bytes());
        let accounts = vec![(from, true, false), (mint, true, false), (by.authority, false, true)];
        self.call(self.program(mint)?, data, accounts, by)
    }

    /// The game pays from a token account it owns.
    pub fn send(&self, game: &Account<'info, Game>, mint: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        let game_info = game.to_account_info();
        let seeds = game_seeds(game);
        self.transfer(mint, from, to, &By { authority: &game_info, seeds: &[&seeds] }, amount)
    }

    /// The game burns from a token account it owns.
    pub fn game_burn(&self, game: &Account<'info, Game>, mint: &AccountInfo<'info>, from: &AccountInfo<'info>, amount: u64) -> Result<()> {
        let game_info = game.to_account_info();
        let seeds = game_seeds(game);
        self.burn(mint, from, &By { authority: &game_info, seeds: &[&seeds] }, amount)
    }

    /// The game mints new tokens of a mint it controls.
    pub fn mint(&self, game: &Account<'info, Game>, mint: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let mut data = vec![MINT_TO];
        data.extend_from_slice(&amount.to_le_bytes());
        let game_info = game.to_account_info();
        let seeds = game_seeds(game);
        let by = By { authority: &game_info, seeds: &[&seeds] };
        let accounts = vec![(mint, true, false), (to, true, false), (&game_info, false, true)];
        self.call(self.program(mint)?, data, accounts, &by)
    }

    /// Creates a token account of `mint` that only the game can spend from, at the address of
    /// `seeds`: a pool, the vault of a stake, the pot of a contest.
    pub fn open(&self, account: &AccountInfo<'info>, mint: &AccountInfo<'info>, game: &Pubkey, payer: &AccountInfo<'info>, system: &AccountInfo<'info>, seeds: &[&[u8]]) -> Result<()> {
        let program = self.program(mint)?;
        let len = if program.key() == TOKEN_2022_ID { account_len_2022(program, mint)? } else { ACCOUNT_LEN };
        create(account, len, &program.key(), payer, system, seeds)?;
        let mut data = vec![INITIALIZE_ACCOUNT_3];
        data.extend_from_slice(game.as_ref());
        let accounts = vec![(account, true, false), (mint, false, false)];
        self.call(program, data, accounts, &By { authority: payer, seeds: &[] })
    }

    /// The game closes a token account it owns, which holds nothing, and its rent goes to `to`.
    /// Fees a Token-2022 mint withheld in it are swept to the mint first, or the close fails.
    pub fn close(&self, game: &Account<'info, Game>, mint: &AccountInfo<'info>, account: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<()> {
        let program = self.program(mint)?;
        let game_info = game.to_account_info();
        let seeds = game_seeds(game);
        let by = By { authority: &game_info, seeds: &[&seeds] };
        if withheld(account) > 0 {
            let accounts = vec![(mint, true, false), (account, true, false)];
            self.call(program, vec![TRANSFER_FEE_EXTENSION, HARVEST_WITHHELD_TO_MINT], accounts, &by)?;
        }
        let accounts = vec![(account, true, false), (to, true, false), (&game_info, false, true)];
        self.call(program, vec![CLOSE_ACCOUNT], accounts, &by)
    }
}

// The instructions used, by their first byte (the same in both programs).
const MINT_TO: u8 = 7;
const BURN: u8 = 8;
const CLOSE_ACCOUNT: u8 = 9;
const TRANSFER_CHECKED: u8 = 12;
const INITIALIZE_ACCOUNT_3: u8 = 18;
const GET_ACCOUNT_DATA_SIZE: u8 = 21;
const TRANSFER_FEE_EXTENSION: u8 = 26;
const HARVEST_WITHHELD_TO_MINT: u8 = 4;

/// Token-2022's answer to how big an account of `mint` has to be, for the extensions the mint
/// asks every account of it to carry.
fn account_len_2022<'info>(program: &AccountInfo<'info>, mint: &AccountInfo<'info>) -> Result<usize> {
    let ix = Instruction {
        program_id: program.key(),
        accounts: vec![AccountMeta::new_readonly(mint.key(), false)],
        data: vec![GET_ACCOUNT_DATA_SIZE],
    };
    invoke(&ix, &[mint.clone(), program.clone()])?;
    match get_return_data() {
        Some((from, data)) if from == program.key() && data.len() == 8 => Ok(u64::from_le_bytes(data[..8].try_into().unwrap()) as usize),
        _ => err!(LootError::NotAMint),
    }
}

// ---------------------------------------------------------------- reading

/// The extensions of a Token-2022 account or mint: after the 165 bytes of a plain account (a
/// mint is padded to the same length) comes one byte that says which it is, then each extension
/// as a type (2 bytes), a length (2) and its value. Returns the value of extension `kind`.
fn extension(data: &[u8], kind: u16) -> Option<&[u8]> {
    let mut at = ACCOUNT_LEN + 1;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        let value = data.get(at + 4..at + 4 + len)?;
        if ty == kind {
            return Some(value);
        }
        if ty == 0 {
            return None;
        }
        at += 4 + len;
    }
    None
}

/// Fees a Token-2022 mint has withheld in this account (its `TransferFeeAmount`, extension 2).
fn withheld(account: &AccountInfo) -> u64 {
    let Ok(data) = account.try_borrow_data() else { return 0 };
    extension(&data, 2).and_then(|v| v.get(..8)).map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
}

/// The account's owner requires a memo before every transfer into it (`MemoTransfer`,
/// extension 8).
fn requires_memo(account: &AccountInfo) -> bool {
    let Ok(data) = account.try_borrow_data() else { return false };
    extension(&data, 8).is_some_and(|v| v.first().is_some_and(|on| *on != 0))
}

/// The decimals of a mint of either program.
pub fn decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    let owned = *mint.owner == TOKEN_ID || *mint.owner == TOKEN_2022_ID;
    // A mint is 82 bytes, or a Token-2022 mint with extensions, whose type byte says so.
    let shaped = data.len() == MINT_LEN || (data.len() > ACCOUNT_LEN && data.len() != MULTISIG_LEN && data[ACCOUNT_LEN] == 1);
    require!(owned && shaped && data[45] == 1, LootError::NotAMint);
    Ok(data[44])
}

/// What a token account says about itself. Its first bytes are its mint (32), its owner (32)
/// and its amount (8).
pub struct Holding {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

/// Reads a token account of either program, or `None` if the account is not one (closed, a
/// mint, or something else).
pub fn read(account: &AccountInfo) -> Option<Holding> {
    let data = account.try_borrow_data().ok()?;
    let owned = *account.owner == TOKEN_ID || *account.owner == TOKEN_2022_ID;
    // 165 bytes, or a Token-2022 account with extensions, whose type byte says it is an account.
    let shaped = data.len() == ACCOUNT_LEN || (data.len() > ACCOUNT_LEN && data.len() != MULTISIG_LEN && data[ACCOUNT_LEN] == 2);
    if !owned || !shaped || data[108] == 0 {
        return None;
    }
    Some(Holding {
        mint: Pubkey::new_from_array(data[..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
    })
}

/// Reads a token account that has to be one.
pub fn holding(account: &AccountInfo) -> Result<Holding> {
    read(account).ok_or(error!(LootError::NotATokenAccount))
}

/// What a token account holds, 0 if it is not one.
pub fn balance(account: &AccountInfo) -> u64 {
    read(account).map_or(0, |h| h.amount)
}

/// What arrived in `account` since it held `before`: what was sent, less any transfer fee.
pub fn received(account: &AccountInfo, before: u64) -> Result<u64> {
    Ok(balance(account).checked_sub(before).ok_or(LootError::Overflow)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_an_extension_by_its_type() {
        let mut data = vec![0u8; ACCOUNT_LEN];
        data.push(2); // an account
        data.extend_from_slice(&7u16.to_le_bytes()); // immutable owner, no value
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes()); // withheld fees
        data.extend_from_slice(&8u16.to_le_bytes());
        data.extend_from_slice(&55u64.to_le_bytes());
        assert_eq!(extension(&data, 2), Some(&55u64.to_le_bytes()[..]));
        assert_eq!(extension(&data, 7), Some(&[][..]));
        assert_eq!(extension(&data, 14), None);
        assert_eq!(extension(&data[..ACCOUNT_LEN], 2), None, "a plain account has none");
        assert_eq!(extension(&data[..data.len() - 1], 2), None, "a value cut short is not read");
    }
}
