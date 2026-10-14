//! A lottery: tickets into a pot, one random draw, the winners paid. The owner writes it once;
//! after that players buy, and anyone may ask for the draw when it is due and pay the winners
//! when they are known. Then the next round opens by itself.
//!
//! A lottery has up to 8 places, each a share of the pot: one winner takes all (the default),
//! or a grand prize of 50% and seven of 5%. The draw picks one ticket at random for first place,
//! and the other places' tickets follow at even steps around the list from it, so no ticket
//! wins twice and every ticket has the same chance at every place. A round with fewer tickets
//! than places has fewer winners. What the places leave (shares under 100%, places nobody won,
//! rounding) stays in the pot for the next round: a jackpot that rolls over.
//!
//! The shares are of what the pot held when the first place was paid (a place is paid what the
//! pot still holds, if that is less: a pot that shrank in between must not stop the round).
//! Each place is paid on its own, by anyone, and the round ends with the last one.
//!
//! Tickets are kept as a list of purchases behind the lottery's own record, 40 bytes each:
//! who bought, and the number after the last ticket they hold. A buyer pays the rent of their
//! line, and first place gets the rent of the whole list when the round ends.
//!
//! The pot is one of the game's pools, so give a lottery one of its own: the authority can pay
//! out of it, a deposit adds to it, and a schedule or a stake that names it takes from it. A cut
//! goes to the treasury, so it only works for a pot in the game's own mint.
//!
//! A lottery can sell its tickets in another token than its prize (`ticket_mint`): a ticket a
//! player earned for every monster killed, drawn for a pot of coins. Those tickets are burned,
//! and the pot is filled from elsewhere: a share of sales, a schedule, a deposit.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};
use solana_sha256_hasher::hashv;

use super::order::ticket_of;
use crate::{
    constants::*,
    error::LootError,
    pick::share,
    rail::*,
    receipts::*,
    rent::{give, load, pay_lamports, save},
    state::*,
    tokens::{self, By, Tokens},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Round {
    /// Tickets are on sale.
    Open,
    /// The draw was asked for; waiting for the oracle.
    Drawing,
    /// The winner is known and not paid yet.
    Drawn,
}

/// At `["lottery", game, id]`. The list of purchases follows these fields in the same account.
#[account(discriminator = &[8])]
#[derive(InitSpace)]
pub struct Lottery {
    pub game: Pubkey,
    pub id: u32,
    pub bump: u8,
    /// The price of one ticket, in the mint of the pot (or in `ticket_mint`).
    pub price: u64,
    /// The pool that holds the pot.
    pub pot: u8,
    /// The share of ticket money that goes to the game's treasury instead of the pot.
    pub cut_bps: u16,
    /// What each place wins, in basis points of the pot: first place first. Unused places are 0.
    pub places: [u16; MAX_PLACES],
    /// When set, a ticket costs `price` of this mint and is burned, and no ticket money
    /// reaches the pot. The default address means there is none: tickets pay into the pot.
    pub ticket_mint: Pubkey,
    /// Seconds from one draw to the next.
    pub every: i64,
    /// Unix time this round's draw is due. Sales stop then.
    pub draws_at: i64,
    /// Counts up by one each time a winner is paid.
    pub round: u32,
    pub status: Round,
    /// Tickets sold this round. They are numbered from 0.
    pub sold: u64,
    /// The slot the draw was asked in.
    pub asked_slot: u64,
    /// Who holds first place, once drawn.
    pub winner: Pubkey,
    /// The ticket that won first place.
    pub first_ticket: u64,
    /// The places paid this round, one bit each.
    pub paid: u8,
    /// What the pot held when the first place of this round was paid. The shares are of this.
    pub pot_at_payout: u64,
}

/// The most places a lottery pays.
pub const MAX_PLACES: usize = 8;
/// The latest first draw date and the longest period a lottery may name: about 1,000 years.
pub const MAX_LOTTERY_TIME: i64 = 1_000 * 365 * 24 * 60 * 60;

impl Lottery {
    /// Where the list of purchases starts.
    const HEAD: usize = 1 + Self::INIT_SPACE;
    /// One purchase: the buyer (32 bytes), then the number after their last ticket (8).
    const LINE: usize = 40;

    /// The next date on the lottery's own rhythm that is still ahead of `now`.
    fn next_date(&self, now: i64) -> Result<i64> {
        let missed = now.saturating_sub(self.draws_at).max(0) / self.every;
        let ahead = missed.checked_add(1).and_then(|n| n.checked_mul(self.every));
        Ok(ahead.and_then(|ahead| self.draws_at.checked_add(ahead)).ok_or(LootError::Overflow)?)
    }

    /// The places that have a winner this round: as many as are set, but no more than tickets.
    pub fn winners(&self) -> u64 {
        let set = self.places.iter().take_while(|bps| **bps > 0).count() as u64;
        set.min(self.sold)
    }

    /// The ticket that wins `place`: even steps around the list from the first place's ticket.
    /// The steps stay under `sold`, so going round the end of the list is a subtraction.
    pub fn ticket_of_place(&self, place: u8) -> u64 {
        let ahead = place as u64 * (self.sold / self.winners());
        let to_end = self.sold - self.first_ticket;
        if ahead < to_end {
            self.first_ticket + ahead
        } else {
            ahead - to_end
        }
    }

    /// Who holds ticket number `ticket`: the first purchase whose end is past it.
    fn holder(lines: &[u8], ticket: u64) -> Pubkey {
        let line = |i: usize| &lines[i * Self::LINE..(i + 1) * Self::LINE];
        let end_of = |i: usize| u64::from_le_bytes(line(i)[32..].try_into().unwrap());
        let (mut low, mut high) = (0, lines.len() / Self::LINE - 1);
        while low < high {
            let middle = (low + high) / 2;
            if end_of(middle) > ticket {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        Pubkey::new_from_array(line(low)[..32].try_into().unwrap())
    }
}

// ---------------------------------------------------------------- upsert_lottery

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LotteryArgs {
    pub price: u64,
    pub pot: u8,
    pub cut_bps: u16,
    /// What each place wins, in basis points of the pot, first place first. Empty means one
    /// winner who takes all.
    pub places: Vec<u16>,
    pub ticket_mint: Pubkey,
    pub every: i64,
    pub draws_at: i64,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct UpsertLottery<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the lottery's address. Read and written by hand.
    #[account(mut, seeds = [LOTTERY_SEED, game.key().as_ref(), &id.to_le_bytes()], bump)]
    pub lottery: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Creates the lottery, or changes it between rounds: never while tickets are sold. A lottery
/// pays out of a pool, so only the owner writes one.
pub fn handle_upsert_lottery(ctx: Context<UpsertLottery>, id: u32, args: LotteryArgs) -> Result<()> {
    let a = &ctx.accounts;
    require!(args.price > 0 && args.every > 0 && args.cut_bps as u64 <= BPS, LootError::BadLottery);
    // A date or a period past `MAX_LOTTERY_TIME` could overflow the next draw's date, and a
    // round that cannot compute it can never end.
    require!(args.every <= MAX_LOTTERY_TIME && (0..=MAX_LOTTERY_TIME).contains(&args.draws_at), LootError::BadLottery);
    // Burned tickets leave nothing to take a cut of.
    require!(args.ticket_mint == Pubkey::default() || args.cut_bps == 0, LootError::BadLottery);
    let mut places = [0u16; MAX_PLACES];
    if args.places.is_empty() {
        places[0] = BPS as u16;
    }
    let total: u64 = args.places.iter().map(|bps| *bps as u64).sum();
    require!(args.places.len() <= MAX_PLACES && args.places.iter().all(|bps| *bps > 0) && total <= BPS, LootError::BadLottery);
    places[..args.places.len()].copy_from_slice(&args.places);
    let old = load::<Lottery>(&a.lottery)?;
    require!(old.as_ref().is_none_or(|l| l.sold == 0), LootError::RoundRunning);

    let lottery = Lottery {
        game: a.game.key(),
        id,
        bump: ctx.bumps.lottery,
        price: args.price,
        pot: args.pot,
        cut_bps: args.cut_bps,
        places,
        ticket_mint: args.ticket_mint,
        every: args.every,
        draws_at: args.draws_at,
        round: old.map_or(0, |l| l.round),
        status: Round::Open,
        sold: 0,
        asked_slot: 0,
        winner: Pubkey::default(),
        first_ticket: 0,
        paid: 0,
        pot_at_payout: 0,
    };
    let game = a.game.key();
    let seeds: &[&[u8]] = &[LOTTERY_SEED, game.as_ref(), &id.to_le_bytes(), &[lottery.bump]];
    save(&a.lottery, &lottery, seeds, &a.owner, &a.system_program)
}

// ---------------------------------------------------------------- buy_tickets

#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game)]
    pub lottery: Account<'info, Lottery>,
    /// CHECK: what the player pays from. The token program checks that they may spend it.
    #[account(mut)]
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: the pot (checked below).
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: the game's treasury, by address. It gets the lottery's cut.
    #[account(mut, address = game.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the mint the player pays in: the pot's, or the lottery's `ticket_mint` when its
    /// tickets are burned (checked below; the token program checks the rest).
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then: any accounts a transfer hook asks for.
}

/// Buys `count` tickets at no more than `max_price` each.
pub fn handle_buy_tickets<'info>(ctx: Context<'info, BuyTickets<'info>>, count: u64, max_price: u64) -> Result<()> {
    let a = &ctx.accounts;
    let l = &a.lottery;
    a.game.open_for_money()?;
    require!(l.status == Round::Open && Clock::get()?.unix_timestamp < l.draws_at, LootError::SalesClosed);
    require!(count > 0, LootError::ZeroAmount);
    require!(l.price <= max_price, LootError::PriceAboveMax);
    require_keys_eq!(a.pot.key(), pool_address(&a.game.key(), l.pot), LootError::WrongPool);

    a.fee.charge_player(&a.game, &a.player)?;
    let cost = l.price.checked_mul(count).ok_or(LootError::Overflow)?;
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let player = By::player(&a.player);
    if l.ticket_mint == Pubkey::default() {
        let cut = share(cost, l.cut_bps).ok_or(LootError::Overflow)?;
        tokens.transfer(&a.mint, &a.player_token, &a.treasury, &player, cut)?;
        tokens.transfer(&a.mint, &a.player_token, &a.pot, &player, cost - cut)?;
    } else {
        require_keys_eq!(a.mint.key(), l.ticket_mint, LootError::WrongMint);
        tokens.burn(&a.mint, &a.player_token, &player, cost)?;
    }

    // One more line on the list: the buyer, and the number after their last ticket.
    let sold = l.sold.checked_add(count).ok_or(LootError::Overflow)?;
    let account = l.to_account_info();
    let end = account.data_len();
    let rent = Rent::get()?.minimum_balance(end + Lottery::LINE);
    pay_lamports(&a.player, &account, rent.saturating_sub(account.lamports()), &a.fee.system_program)?;
    account.resize(end + Lottery::LINE)?;
    {
        let mut data = account.try_borrow_mut_data()?;
        data[end..end + 32].copy_from_slice(a.player.key().as_ref());
        data[end + 32..end + 40].copy_from_slice(&sold.to_le_bytes());
    }

    emit!(TicketsBought {
        game: l.game,
        id: l.id,
        round: l.round,
        player: a.player.key(),
        first_ticket: l.sold,
        count,
    });
    ctx.accounts.lottery.sold = sold;
    Ok(())
}

// ---------------------------------------------------------------- draw_lottery

#[vrf]
#[derive(Accounts)]
pub struct DrawLottery<'info> {
    /// Pays the oracle.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub lottery: Account<'info, Lottery>,
    /// CHECK: MagicBlock's default oracle queue, and no other: not even its test queue, which
    /// whoever MagicBlock lets serve it could answer.
    #[account(mut, address = vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Anyone may ask for the draw once it is due. A round nobody bought into just moves to its
/// next date. If the oracle has not answered after `STALE_SLOTS`, anyone may ask again; only
/// the newest request is then taken.
pub fn handle_draw_lottery<'info>(ctx: Context<'info, DrawLottery<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let l = &mut ctx.accounts.lottery;
    let due = l.status == Round::Open && clock.unix_timestamp >= l.draws_at;
    let stuck = l.status == Round::Drawing && clock.slot > l.asked_slot.saturating_add(STALE_SLOTS);
    require!(due || stuck, LootError::NotDue);
    if l.sold == 0 {
        l.draws_at = l.next_date(clock.unix_timestamp)?;
        return Ok(());
    }
    l.status = Round::Drawing;
    l.asked_slot = clock.slot;

    let lottery = l.key();
    let request = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackLottery::DISCRIMINATOR.to_vec(),
        caller_seed: hashv(&[lottery.as_ref(), &l.round.to_le_bytes(), &clock.slot.to_le_bytes()]).to_bytes(),
        // The oracle calls `callback_lottery` with these: the lottery, and this request's ticket.
        accounts_metas: Some(vec![
            SerializableAccountMeta { pubkey: lottery, is_signer: false, is_writable: true },
            SerializableAccountMeta { pubkey: ticket_of(&lottery, clock.slot), is_signer: false, is_writable: false },
        ]),
        ..Default::default()
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &request)?;
    Ok(())
}

// ---------------------------------------------------------------- callback_lottery

/// Only MagicBlock's oracle can call this, and only for a request this program made.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackLottery<'info> {
    #[account(mut, constraint = lottery.status == Round::Drawing @ LootError::NotDue)]
    pub lottery: Account<'info, Lottery>,
    /// CHECK: the ticket of the newest request for this draw. An older request's answer is refused.
    #[account(address = ticket_of(&lottery.key(), lottery.asked_slot) @ LootError::NotDue)]
    pub ticket: UncheckedAccount<'info>,
}

/// The oracle's number picks first place's ticket, and with it every other place's.
pub fn handle_callback_lottery(ctx: Context<CallbackLottery>, randomness: [u8; 32]) -> Result<()> {
    let l = &mut ctx.accounts.lottery;
    l.first_ticket = vrf::rnd::random_u64(&randomness) % l.sold;
    let winners: Vec<Pubkey> = {
        let data = l.to_account_info();
        let data = data.try_borrow_data()?;
        (0..l.winners() as u8).map(|place| Lottery::holder(&data[Lottery::HEAD..], l.ticket_of_place(place))).collect()
    };
    l.winner = winners[0];
    l.status = Round::Drawn;
    emit!(LotteryDrawn {
        game: l.game,
        id: l.id,
        round: l.round,
        winning_ticket: l.first_ticket,
        winners,
        randomness,
    });
    Ok(())
}

// ---------------------------------------------------------------- pay_lottery

#[derive(Accounts)]
pub struct PayLottery<'info> {
    pub game: Account<'info, Game>,
    #[account(
        mut,
        has_one = game,
        constraint = lottery.status == Round::Drawn @ LootError::NotDue
    )]
    pub lottery: Account<'info, Lottery>,
    /// CHECK: first place's winner, by address. Gets the rent of the list of purchases when the
    /// round ends, whichever place is paid last.
    #[account(mut, address = lottery.winner)]
    pub first_place: UncheckedAccount<'info>,
    /// CHECK: the pot (checked below).
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: a token account the place's winner owns (checked below).
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: the pot's mint. The token program refuses any other.
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
}

/// Anyone may pay one place its share of the pot, to a token account of its winner. The
/// round ends when the last place with a winner is paid, and the next one opens at once.
pub fn handle_pay_lottery<'info>(ctx: Context<'info, PayLottery<'info>>, place: u8) -> Result<()> {
    let a = &ctx.accounts;
    let l = &a.lottery;
    let bit = 1u8.checked_shl(place as u32).unwrap_or(0);
    require!((place as u64) < l.winners() && l.paid & bit == 0, LootError::PlacePaid);
    let winner = Lottery::holder(&l.to_account_info().try_borrow_data()?[Lottery::HEAD..], l.ticket_of_place(place));
    require_keys_eq!(a.pot.key(), pool_address(&a.game.key(), l.pot), LootError::WrongPool);
    require_keys_eq!(tokens::holding(&a.to)?.owner, winner, LootError::NotThePlayers);

    // A pot that was never opened, or was closed, holds nothing. That must not keep the round
    // from ending.
    let holds = tokens::read(&a.pot).map_or(0, |pot| pot.amount);
    let pot_at_payout = if l.paid == 0 { holds } else { l.pot_at_payout };
    let amount = share(pot_at_payout, l.places[place as usize]).ok_or(LootError::Overflow)?.min(holds);
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    tokens.send(&a.game, &a.mint, &a.pot, &a.to, amount)?;

    let l = &mut ctx.accounts.lottery;
    emit!(LotteryPaid { game: l.game, id: l.id, round: l.round, place, winner, amount });
    l.pot_at_payout = pot_at_payout;
    l.paid |= bit;
    if (l.paid.count_ones() as u64) < l.winners() {
        return Ok(());
    }

    // The last place is paid. The list is emptied, and its rent goes to first place (or stays,
    // to pay for the next round's first lines, if their wallet is too empty to take it).
    let account = l.to_account_info();
    let rent = Rent::get()?;
    let spare = account.lamports() - rent.minimum_balance(Lottery::HEAD);
    give(&account, &ctx.accounts.first_place, spare, &rent)?;
    account.resize(Lottery::HEAD)?;

    let now = Clock::get()?.unix_timestamp;
    l.round += 1;
    l.status = Round::Open;
    l.sold = 0;
    l.winner = Pubkey::default();
    l.first_ticket = 0;
    l.paid = 0;
    l.pot_at_payout = 0;
    l.draws_at = l.next_date(now)?;
    Ok(())
}
