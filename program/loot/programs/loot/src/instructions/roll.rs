//! A random number for anything. The game's authority asks MagicBlock's VRF oracle for one and
//! labels the request; the answer comes back as a receipt anyone can check. What the number
//! decides is the game's own rule: a lottery draw, a breeding trait, a critical hit, a drop.
//!
//! Nothing is stored, so a roll costs no rent. The label travels to the oracle and back in
//! the place of an account address: 32 bytes are 32 bytes.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};
use solana_sha256_hasher::hashv;

use crate::{error::LootError, rail::*, receipts::*, state::*};

// ---------------------------------------------------------------- roll

#[vrf]
#[derive(Accounts)]
pub struct Roll<'info> {
    /// Pays the platform's fee and the oracle's.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        has_one = authority @ LootError::NotAuthority
    )]
    pub game: Account<'info, Game>,
    /// CHECK: MagicBlock's default oracle queue, and no other: not even its test queue, which
    /// whoever MagicBlock lets serve it could answer.
    #[account(mut, address = vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
}

/// Asks for a random number under `reference`, the game's own label for what it will decide.
pub fn handle_roll<'info>(ctx: Context<'info, Roll<'info>>, reference: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    a.fee.charge_project(&a.game, &a.authority)?;

    // Mixed with the slot, so the same label can be rolled again later.
    let game = a.game.key();
    let seed = hashv(&[game.as_ref(), &reference, &Clock::get()?.slot.to_le_bytes()]).to_bytes();
    let request = create_request_randomness_ix(RequestRandomnessParams {
        payer: a.authority.key(),
        oracle_queue: a.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackRandom::DISCRIMINATOR.to_vec(),
        caller_seed: seed,
        // The oracle calls `callback_random` with these: the game, and the label as an address.
        accounts_metas: Some(vec![
            SerializableAccountMeta { pubkey: game, is_signer: false, is_writable: false },
            SerializableAccountMeta { pubkey: Pubkey::new_from_array(reference), is_signer: false, is_writable: false },
        ]),
        ..Default::default()
    });
    a.invoke_signed_vrf(&a.authority.to_account_info(), &request)?;
    Ok(())
}

// ---------------------------------------------------------------- callback_random

/// Only MagicBlock's oracle can call this, and only for a request this program made.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRandom<'info> {
    /// CHECK: the game `roll` named in its request; only the oracle sends this.
    pub game: UncheckedAccount<'info>,
    /// CHECK: not an account: the request's label, carried as an address.
    pub reference: UncheckedAccount<'info>,
}

/// The oracle's answer. It changes nothing; it writes the receipt.
pub fn handle_callback_random(ctx: Context<CallbackRandom>, randomness: [u8; 32]) -> Result<()> {
    emit!(Rolled {
        game: ctx.accounts.game.key(),
        reference: ctx.accounts.reference.key().to_bytes(),
        randomness,
    });
    Ok(())
}
