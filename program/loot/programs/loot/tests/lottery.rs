//! Lotteries: tickets, the oracle's draw, places and the rounds.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::Instruction,
    anchor_spl::token::spl_token,
    common::*,
    loot::Action,
    loot::Lottery,
    loot::LotteryArgs,
    loot::Round,
    loot::ScheduleArgs,
    loot::receipts::LotteryDrawn,
    loot::receipts::LotteryPaid,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn lottery_args(pot: u8, places: Vec<u16>, every: i64, draws_at: i64) -> LotteryArgs {
    LotteryArgs { price: 10, pot, cut_bps: 0, places, ticket_mint: Pubkey::default(), every, draws_at }
}

/// The owner opens pool `index` in `mint` and puts `amount` in it.
fn pool_with(env: &mut Env, index: u8, mint: Pubkey, amount: u64) {
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, index, mint).unwrap();
    if amount > 0 {
        env.fund(owner.pubkey(), mint, amount);
        env.deposit(&owner, index, mint, amount).unwrap();
    }
}

/// A bare lottery record for the pure arithmetic.
fn record(sold: u64, set: usize, first_ticket: u64) -> Lottery {
    let mut places = [0u16; 8];
    places[..set].fill(1);
    Lottery {
        game: Pubkey::default(),
        id: 0,
        bump: 0,
        price: 1,
        pot: 0,
        cut_bps: 0,
        places,
        ticket_mint: Pubkey::default(),
        every: 1,
        draws_at: 0,
        round: 0,
        status: Round::Drawn,
        sold,
        asked_slot: 0,
        winner: Pubkey::default(),
        first_ticket,
        paid: 0,
        pot_at_payout: 0,
    }
}

/// `buy_tickets` as a client builds it. Accounts: player 0, game 1, lottery 2, player_token 3,
/// pot 4, treasury 5, mint 6, token 7, token-2022 8, platform 9, system 10.
fn buy_ix(env: &Env, who: &Pubkey, id: u32, count: u64, mint: Pubkey) -> Instruction {
    let l = env.lottery(id);
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::BuyTickets { count, max_price: l.price }.data(),
        loot::accounts::BuyTickets {
            player: *who,
            game: env.game,
            lottery: env.mechanic_pda(loot::LOTTERY_SEED, id),
            player_token: ata(who, &mint),
            pot: pool_pda(&env.game, l.pot),
            treasury: env.treasury,
            mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
    )
}

fn balance_of(env: &Env, who: &Keypair, mint: &Pubkey) -> u64 {
    env.tokens(&ata(&who.pubkey(), mint))
}

const POT: u8 = 0;

/// A weekly lottery at 10 a ticket with a 10% cut, and three players holding tickets
/// 0..3, 3..4 and 4..10.
fn lottery_with_ten_tickets() -> (Env, [Keypair; 3]) {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, POT, env.mint).unwrap();
    let args = LotteryArgs { price: 10, pot: POT, cut_bps: 1_000, places: vec![], ticket_mint: Pubkey::default(), every: 7 * DAY, draws_at: env.now() + 7 * DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let players = [player(&mut env, 1_000), player(&mut env, 1_000), player(&mut env, 1_000)];
    for (who, count) in players.iter().zip([3, 1, 6]) {
        env.buy_tickets(who, 1, count, env.mint).unwrap();
    }
    (env, players)
}

/// The owner opens pool `index` in the game's mint and puts `amount` in it.
fn jackpot(env: &mut Env, index: u8, amount: u64) {
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, index, env.mint).unwrap();
    if amount > 0 {
        env.fund(owner.pubkey(), env.mint, amount);
        env.deposit(&owner, index, env.mint, amount).unwrap();
    }
}

/// Three places of 50%, 30% and 10% of the pot, and three players holding tickets 0..3, 3..4
/// and 4..10.
fn lottery_with_places(places: Vec<u16>) -> (Env, [Keypair; 3]) {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    jackpot(&mut env, 0, 0);
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places, ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let players = [player(&mut env, 1_000), player(&mut env, 1_000), player(&mut env, 1_000)];
    for (who, count) in players.iter().zip([3, 1, 6]) {
        env.buy_tickets(who, 1, count, env.mint).unwrap();
    }
    (env, players)
}

fn my_coins(env: &Env, who: &Pubkey) -> u64 {
    env.tokens(&ata(who, &env.mint))
}

/// A lottery with these places on pool 0, the pot topped up to 1,100, and three players holding
/// tickets 0..3, 3..4 and 4..10. The draw is due.
fn lottery(places: Vec<u16>) -> (Env, [Keypair; 3]) {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    jackpot(&mut env, 0, 1_000);
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places, ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let players = [player(&mut env, 1_000), player(&mut env, 1_000), player(&mut env, 1_000)];
    for (who, count) in players.iter().zip([3, 1, 6]) {
        env.buy_tickets(who, 1, count, env.mint).unwrap();
    }
    env.wait(DAY);
    (env, players)
}

/// A lottery's cut goes to the treasury, which holds the game's mint. A pot in another mint
/// with a cut is accepted and then refuses every ticket.
#[test]
fn a_lottery_with_a_cut_whose_pot_is_in_another_mint_sells_no_ticket() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 5, usd).unwrap();
    let args = LotteryArgs { price: 10, pot: 5, cut_bps: 1_000, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args.clone()).unwrap();
    let p = funded(&mut env);
    env.fund(p.pubkey(), usd, 100);
    assert!(env.buy_tickets(&p, 1, 1, usd).is_err(), "the token program refuses USD into the gold treasury");
    assert_eq!(env.lottery(1).sold, 0);
    env.upsert_lottery(&owner, 1, LotteryArgs { cut_bps: 0, ..args }).unwrap();
    env.buy_tickets(&p, 1, 1, usd).unwrap();
}

/// `pay_lottery` does not open the winner's token account (refund does). A winner of a pot in a
/// token they never held waits for someone to open one for them.
#[test]
fn a_lottery_winner_with_no_account_of_the_pots_mint_waits_for_someone_to_open_one() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let kills = env.new_mint(env.game);
    env.open_pool(&owner, 0, gold).unwrap();
    env.fund(owner.pubkey(), gold, 500);
    env.deposit(&owner, 0, gold, 500).unwrap();
    let b = funded(&mut env);
    let to = env.token_account(b.pubkey(), kills);
    env.issue(&authority, kills, to, 2).unwrap();
    let args = LotteryArgs { price: 1, pot: 0, cut_bps: 0, places: vec![], ticket_mint: kills, every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    env.buy_tickets(&b, 1, 2, kills).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap();
    assert_eq!(env.lottery(1).winner, b.pubkey());
    assert!(err(env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold))).contains("NotATokenAccount"));
    env.token_account(b.pubkey(), gold);
    env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold)).unwrap();
    assert_eq!(env.tokens(&ata(&b.pubkey(), &gold)), 500);
}

/// A lottery's `every` was only checked to be positive. With one so
/// large that the next draw's date overflowed, the last place of a round could not be paid, so
/// the round never ended and the lottery could not be edited. Now a period or a first draw past
/// about 1,000 years is refused, and the longest allowed one ends its round.
#[test]
fn a_rhythm_that_could_overflow_is_refused() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 0, gold, 0);
    let longest = loot::MAX_LOTTERY_TIME;
    assert!(err(env.upsert_lottery(&owner, 1, lottery_args(0, vec![], i64::MAX, env.now() + DAY))).contains("BadLottery"));
    assert!(err(env.upsert_lottery(&owner, 1, lottery_args(0, vec![], longest + 1, env.now() + DAY))).contains("BadLottery"));
    assert!(err(env.upsert_lottery(&owner, 1, lottery_args(0, vec![], DAY, longest + 1))).contains("BadLottery"));

    env.upsert_lottery(&owner, 1, lottery_args(0, vec![], longest, env.now() + DAY)).unwrap();
    let a = wallet(&mut env, gold, 100);
    env.buy_tickets(&a, 1, 1, gold).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap();
    env.pay_lottery(1, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!((env.lottery(1).status, env.lottery(1).round), (Round::Open, 1));
}

/// The ticket arithmetic, re-run: for every round of 1 to 40 tickets and 1 to 8 places, every
/// place's ticket is under `sold`, no ticket wins twice, first place is the drawn ticket, and
/// each ticket wins each place exactly once over all draws.
#[test]
fn ticket_of_place_is_a_bijection_for_every_round_up_to_40() {
    for sold in 1..=40u64 {
        for set in 1..=8usize {
            let winners = record(sold, set, 0).winners();
            assert_eq!(winners, (set as u64).min(sold));
            let mut wins = vec![vec![0u32; sold as usize]; winners as usize];
            for first in 0..sold {
                let l = record(sold, set, first);
                let tickets: Vec<u64> = (0..winners as u8).map(|p| l.ticket_of_place(p)).collect();
                assert_eq!(tickets[0], first);
                assert!(tickets.iter().all(|t| *t < sold));
                let mut unique = tickets.clone();
                unique.sort();
                unique.dedup();
                assert_eq!(unique.len(), tickets.len(), "sold {sold}, set {set}, first {first}");
                for (place, ticket) in tickets.into_iter().enumerate() {
                    wins[place][ticket as usize] += 1;
                }
            }
            assert!(wins.iter().all(|place| place.iter().all(|n| *n == 1)), "sold {sold}, set {set}");
        }
    }
    // The huge round from the sixth review still holds.
    let l = record(u64::MAX, 8, u64::MAX - 1);
    assert!((0..8u8).all(|p| l.ticket_of_place(p) < u64::MAX));
}

/// The holder search over the list of purchases, checked on chain against a linear scan: one
/// lottery per ticket number, each with the same seven purchases (17 tickets), each drawn on
/// that number; plus a list of one line.
#[test]
fn the_holder_search_finds_the_right_buyer_for_every_ticket() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 0, gold, 0);
    let counts = [1u64, 3, 2, 5, 1, 1, 4];
    let sold: u64 = counts.iter().sum();
    let buyers: Vec<Keypair> = counts.iter().map(|_| wallet(&mut env, gold, 1_000)).collect();
    for id in 0..=sold as u32 {
        env.upsert_lottery(&owner, id, lottery_args(0, vec![], DAY, env.now() + DAY)).unwrap();
        if id == sold as u32 {
            env.buy_tickets(&buyers[0], id, 5, gold).unwrap();
        } else {
            for (who, count) in buyers.iter().zip(counts) {
                env.buy_tickets(who, id, count, gold).unwrap();
            }
        }
    }
    env.wait(DAY);
    for ticket in 0..sold {
        let id = ticket as u32;
        env.draw_lottery(id).unwrap();
        env.lottery_callback(id, rnd(ticket)).unwrap();
        let mut end = 0;
        let expected = buyers.iter().zip(counts).find_map(|(who, count)| {
            end += count;
            (ticket < end).then(|| who.pubkey())
        });
        let l = env.lottery(id);
        assert_eq!((l.first_ticket, Some(l.winner)), (ticket, expected), "ticket {ticket}");
    }
    let id = sold as u32;
    env.draw_lottery(id).unwrap();
    env.lottery_callback(id, rnd(4)).unwrap();
    assert_eq!(env.lottery(id).winner, buyers[0].pubkey(), "one line: every ticket is its buyer's");
}

/// Lamports a stranger sends to the lottery record (anyone can) only pay for the next lines
/// and end with first place; they cannot make the payout fail. And a first place whose wallet
/// cannot take the rent (it would stay under its own minimum) leaves it in the record, where it
/// pays the next round's lines: the payout itself never fails over it.
#[test]
fn lamports_sent_to_the_lottery_subsidise_buyers_and_end_with_first_place() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 0, gold, 0);
    env.upsert_lottery(&owner, 1, lottery_args(0, vec![], DAY, env.now() + DAY)).unwrap();
    let lottery = env.mechanic_pda(loot::LOTTERY_SEED, 1);
    let head = env.data(&lottery).len();
    let a = wallet(&mut env, gold, 1_000);
    let stranger = env.cranker.insecure_clone();
    let gift = 1_000_000_000u64;
    env.send(&[solana_system_interface::instruction::transfer(&stranger.pubkey(), &lottery, gift)], &[&stranger]).unwrap();
    let sol = env.lamports(&a.pubkey());
    env.buy_tickets(&a, 1, 2, gold).unwrap();
    assert_eq!(sol - env.lamports(&a.pubkey()), FEE + 5_000, "the fee and the transaction fee; the gift paid the line's rent");
    assert_eq!(env.data(&lottery).len(), head + 40);
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(1)).unwrap();
    let before = env.lamports(&a.pubkey());
    env.pay_lottery(1, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!(env.lamports(&a.pubkey()) - before, gift, "first place gets the gift, the line's rent included");
    assert_eq!((env.lamports(&lottery), env.data(&lottery).len()), (env.rent(head), head));

    env.upsert_lottery(&owner, 2, lottery_args(0, vec![], DAY, env.now() + DAY)).unwrap();
    let lottery = env.mechanic_pda(loot::LOTTERY_SEED, 2);
    let b = wallet(&mut env, gold, 1_000);
    env.buy_tickets(&b, 2, 1, gold).unwrap();
    env.wait(DAY);
    env.draw_lottery(2).unwrap();
    env.lottery_callback(2, rnd(0)).unwrap();
    let mut empty = env.svm.get_account(&b.pubkey()).unwrap();
    empty.lamports = 0;
    env.svm.set_account(b.pubkey(), empty).unwrap();
    env.pay_lottery(2, ata(&b.pubkey(), &gold)).unwrap();
    assert_eq!((env.lamports(&b.pubkey()), env.lamports(&lottery), env.data(&lottery).len()), (0, env.rent(head + 40), head));
    assert_eq!((env.lottery(2).round, env.lottery(2).status), (1, Round::Open));
    // The next buyer pays no rent for their line.
    let c = wallet(&mut env, gold, 1_000);
    let sol = env.lamports(&c.pubkey());
    env.buy_tickets(&c, 2, 1, gold).unwrap();
    assert_eq!(sol - env.lamports(&c.pubkey()), FEE + 5_000);
}

/// A drawn round with two tickets and three places has two winners and ends after two
/// payments, in any order. A place cannot be paid twice, into the pot, or into an account of
/// the winner's in another mint. A `Drawn` round cannot be drawn again, stale or not.
#[test]
fn pay_lottery_refuses_the_pot_a_wrong_mint_a_second_payment_and_a_second_draw() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    pool_with(&mut env, 0, gold, 1_000);
    env.upsert_lottery(&owner, 1, lottery_args(0, vec![6_000, 3_000, 1_000], DAY, env.now() + DAY)).unwrap();
    let (a, b) = (wallet(&mut env, gold, 100), wallet(&mut env, gold, 100));
    env.buy_tickets(&a, 1, 1, gold).unwrap();
    env.buy_tickets(&b, 1, 1, gold).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(1)).unwrap(); // first: ticket 1 (b); second: ticket 0 (a)
    let l = env.lottery(1);
    assert_eq!((l.winners(), l.winner, l.sold), (2, b.pubkey(), 2));
    assert!(err(env.draw_lottery(1)).contains("NotDue"), "drawn once");
    env.wait_slots(loot::STALE_SLOTS + 1);
    assert!(err(env.draw_lottery(1)).contains("NotDue"), "a drawn round is never stuck");

    assert!(err(env.pay_lottery_place(1, 2, ata(&a.pubkey(), &gold))).contains("PlacePaid"), "the third place has no winner");
    assert!(err(env.pay_lottery_place(1, 0, pool_pda(&env.game, 0))).contains("NotThePlayers"), "the pot is the game's");
    env.token_account(b.pubkey(), other);
    let e = err(env.pay_lottery_place(1, 0, ata(&b.pubkey(), &other)));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    // The pot held 1,020 when the first place was paid: the shares are of that.
    let paid: LotteryPaid = receipt(&env.pay_lottery_place(1, 1, ata(&a.pubkey(), &gold)).unwrap());
    assert_eq!((paid.place, paid.amount, paid.winner), (1, 306, a.pubkey()));
    assert!(err(env.pay_lottery_place(1, 1, ata(&a.pubkey(), &gold))).contains("PlacePaid"));
    assert_eq!(env.lottery(1).status, Round::Drawn);
    let paid: LotteryPaid = receipt(&env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold)).unwrap());
    assert_eq!((paid.place, paid.amount, paid.winner), (0, 612, b.pubkey()));
    let l = env.lottery(1);
    assert_eq!((l.status, l.round, l.sold, l.paid, l.pot_at_payout), (Round::Open, 1, 0, 0, 0));
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 102, "the 10% nobody won rolls over");
    assert!(err(env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold))).contains("NotDue"), "nothing to pay in a new round");
}

/// `buy_tickets` names its mint, and the token program holds it to the pot's (and to the
/// treasury's when there is a cut): a pot in another mint than the game's cannot sell with a
/// cut at all, and without one only sells in its own mint. With a `ticket_mint`, the mint is
/// held to it by the program, and the burn needs the player's own account.
#[test]
fn buy_tickets_cannot_pay_in_another_mint_or_burn_from_another_account() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    pool_with(&mut env, 0, other, 0);
    pool_with(&mut env, 1, gold, 0);
    env.upsert_lottery(&owner, 1, LotteryArgs { cut_bps: 1_000, ..lottery_args(0, vec![], DAY, env.now() + DAY) }).unwrap();
    env.upsert_lottery(&owner, 2, lottery_args(0, vec![], DAY, env.now() + DAY)).unwrap();
    let p = wallet(&mut env, gold, 1_000);
    env.fund(p.pubkey(), other, 1_000);
    for mint in [gold, other] {
        let e = err(env.buy_tickets(&p, 1, 1, mint));
        assert!(e.contains("Account not associated with this Mint"), "{e}");
    }
    let e = err(env.buy_tickets(&p, 2, 1, gold));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    env.buy_tickets(&p, 2, 1, other).unwrap();
    assert_eq!((env.tokens(&pool_pda(&env.game, 0)), env.tokens(&ata(&p.pubkey(), &gold))), (10, 1_000));

    // Tickets in their own token, burned.
    let kills = env.new_mint(owner.pubkey());
    env.upsert_lottery(&owner, 3, LotteryArgs { price: 1, pot: 1, ticket_mint: kills, ..lottery_args(1, vec![], DAY, env.now() + DAY) }).unwrap();
    let q = wallet(&mut env, kills, 5);
    env.fund(p.pubkey(), kills, 5);
    assert!(err(env.buy_tickets(&p, 3, 1, gold)).contains("WrongMint"));
    assert!(err(env.buy_tickets(&p, 3, 1, other)).contains("WrongMint"));
    let mut ix = buy_ix(&env, &p.pubkey(), 3, 1, kills);
    ix.accounts[3].pubkey = ata(&q.pubkey(), &kills);
    let e = err(env.send(&[ix], &[&p]));
    assert!(e.contains("owner does not match"), "{e}");
    let mut ix = buy_ix(&env, &p.pubkey(), 3, 1, kills);
    ix.accounts[3].pubkey = pool_pda(&env.game, 0);
    assert!(env.send(&[ix], &[&p]).is_err(), "nor from a pool");
    env.buy_tickets(&p, 3, 2, kills).unwrap();
    assert_eq!((env.tokens(&ata(&p.pubkey(), &kills)), env.tokens(&ata(&q.pubkey(), &kills)), env.supply(&kills), env.lottery(3).sold), (3, 5, 8, 2));
}

/// A round of u64::MAX tickets (tickets in their own token, two lines) draws and pays with the
/// arithmetic at the top of its range, and one more ticket, which would wrap `sold`, is refused.
#[test]
fn a_round_of_u64_max_tickets_draws_and_pays_and_one_more_is_refused() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let kills = env.new_mint(owner.pubkey());
    pool_with(&mut env, 1, gold, 1_000);
    env.upsert_lottery(&owner, 1, LotteryArgs { price: 1, ticket_mint: kills, ..lottery_args(1, vec![5_000, 5_000], DAY, env.now() + DAY) }).unwrap();
    let (a, b) = (wallet(&mut env, kills, u64::MAX - 1), wallet(&mut env, kills, 0));
    env.buy_tickets(&a, 1, u64::MAX - 1, kills).unwrap();
    env.fund(b.pubkey(), kills, 1);
    env.buy_tickets(&b, 1, 1, kills).unwrap();
    assert_eq!(env.lottery(1).sold, u64::MAX);
    env.fund(b.pubkey(), kills, 1);
    assert!(err(env.buy_tickets(&b, 1, 1, kills)).contains("Overflow"));
    assert_eq!(env.tokens(&ata(&b.pubkey(), &kills)), 1, "nothing was burned for it");
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(u64::MAX - 1)).unwrap();
    let l = env.lottery(1);
    assert_eq!((l.first_ticket, l.winner, l.ticket_of_place(1)), (u64::MAX - 1, b.pubkey(), u64::MAX / 2 - 1));
    env.token_account(a.pubkey(), gold);
    env.token_account(b.pubkey(), gold);
    env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold)).unwrap();
    env.pay_lottery_place(1, 1, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!((env.tokens(&ata(&b.pubkey(), &gold)), env.tokens(&ata(&a.pubkey(), &gold))), (500, 500));
    assert_eq!((env.lottery(1).status, env.lottery(1).sold), (Round::Open, 0));
}

/// Every monster killed earns a ticket, and the tickets are drawn for a pot of coins. The
/// tickets are their own token and are burned; the pot is filled by the owner.
#[test]
fn a_lottery_sells_tickets_in_one_token_for_a_prize_in_another() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let kills = env.new_mint(env.game);
    env.open_pool(&owner, 0, gold).unwrap();
    let funder = player(&mut env, 500);
    env.deposit(&funder, 0, gold, 500).unwrap();
    let (a, b) = (player(&mut env, 0), player(&mut env, 0));
    for (who, earned) in [(&a, 3), (&b, 1)] {
        let to = env.token_account(who.pubkey(), kills);
        env.issue(&authority, kills, to, earned).unwrap();
    }

    let args = LotteryArgs { price: 1, pot: 0, cut_bps: 0, places: vec![], ticket_mint: kills, every: DAY, draws_at: env.now() + DAY };
    assert!(err(env.upsert_lottery(&owner, 1, LotteryArgs { cut_bps: 100, ..args.clone() })).contains("BadLottery"), "nothing to take a cut of");
    env.upsert_lottery(&owner, 1, args).unwrap();

    assert!(env.buy_tickets(&a, 1, 4, kills).is_err(), "three kills are three tickets");
    env.buy_tickets(&a, 1, 3, kills).unwrap();
    env.buy_tickets(&b, 1, 1, kills).unwrap();
    assert_eq!((env.supply(&kills), env.tokens(&pool_pda(&env.game, 0)), env.lottery(1).sold), (0, 500, 4));

    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(3)).unwrap();
    assert_eq!(env.lottery(1).winner, b.pubkey(), "ticket 3 is b's");
    env.pay_lottery(1, ata(&b.pubkey(), &gold)).unwrap();
    assert_eq!(balance_of(&env, &b, &gold), 500);
}

#[test]
fn a_lottery_sells_draws_and_pays_with_no_key_of_the_game() {
    let (mut env, players) = lottery_with_ten_tickets();
    let owner = env.creator.insecure_clone();
    let lottery = env.mechanic_pda(loot::LOTTERY_SEED, 1);
    let pot = pool_pda(&env.game, POT);
    // 100 paid: 10 to the treasury, 90 in the pot. The owner adds a 500 jackpot.
    assert_eq!((env.tokens(&env.treasury), env.tokens(&pot), env.lottery(1).sold), (10, 90, 10));
    env.fund(owner.pubkey(), env.mint, 500);
    env.deposit(&owner, POT, env.mint, 500).unwrap();
    // Each purchase is one 40-byte line the buyer paid the rent of.
    let head = env.data(&lottery).len() - 3 * 40;
    assert_eq!(env.lamports(&lottery), env.rent(head + 120));
    // The owner cannot change the rules of a round that has sold tickets.
    let changed = LotteryArgs { price: 1, pot: POT, cut_bps: 10_000, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: 0 };
    assert!(err(env.upsert_lottery(&owner, 1, changed)).contains("RoundRunning"));

    // Not drawn early; no sales once the draw is due.
    assert!(err(env.draw_lottery(1)).contains("NotDue"));
    env.wait(7 * DAY);
    assert!(err(env.buy_tickets(&players[0], 1, 1, env.mint)).contains("SalesClosed"));
    env.draw_lottery(1).unwrap();
    assert_eq!(env.lottery(1).status, Round::Drawing);
    assert!(err(env.draw_lottery(1)).contains("NotDue"), "asked once");

    // The oracle's number is 13: ticket 3 of 10, which the second player holds.
    let logs = env.lottery_callback(1, rnd(13)).unwrap();
    let drawn: loot::receipts::LotteryDrawn = receipt(&logs);
    let winner = players[1].pubkey();
    assert_eq!((drawn.winning_ticket, drawn.winners.clone(), drawn.round), (3, vec![winner], 0));
    assert!(env.lottery_callback(1, rnd(0)).is_err(), "drawn once");

    // Anyone pays the winner, and only the winner.
    let stranger_token = ata(&players[0].pubkey(), &env.mint);
    assert!(err(env.pay_lottery(1, stranger_token)).contains("NotThePlayers"));
    let (had, sol) = (env.tokens(&ata(&winner, &env.mint)), env.lamports(&winner));
    let logs = env.pay_lottery(1, ata(&winner, &env.mint)).unwrap();
    let paid: loot::receipts::LotteryPaid = receipt(&logs);
    assert_eq!((paid.amount, paid.winner), (590, winner));
    assert_eq!((env.tokens(&ata(&winner, &env.mint)) - had, env.tokens(&pot)), (590, 0));
    // The winner also gets the rent of the list, and the list is empty again.
    assert_eq!(env.lamports(&winner) - sol, env.rent(head + 120) - env.rent(head));
    assert_eq!(env.data(&lottery).len(), head);

    // The next round is open, a week on, and the owner may change it now.
    let l = env.lottery(1);
    assert_eq!((l.round, l.status, l.sold), (1, Round::Open, 0));
    assert!(l.draws_at > env.now() && l.draws_at <= env.now() + 7 * DAY);
    env.buy_tickets(&players[2], 1, 2, env.mint).unwrap();
    assert!(env.pay_lottery(1, stranger_token).is_err(), "nothing to pay until the next draw");
}

#[test]
fn every_ticket_wins_for_its_holder() {
    for (number, holder) in [(0u64, 0usize), (2, 0), (3, 1), (4, 2), (9, 2), (10, 0), (19, 2)] {
        let (mut env, players) = lottery_with_ten_tickets();
        env.wait(7 * DAY);
        env.draw_lottery(1).unwrap();
        env.lottery_callback(1, rnd(number)).unwrap();
        assert_eq!(env.lottery(1).winner, players[holder].pubkey(), "number {number}");
    }
}

#[test]
fn a_draw_the_oracle_never_answers_is_asked_again_and_only_the_newest_counts() {
    let (mut env, _) = lottery_with_ten_tickets();
    let c = env.cranker.insecure_clone();
    env.wait(7 * DAY);
    env.draw_lottery(1).unwrap();
    let first = env.lottery(1).asked_slot;
    env.wait_slots(loot::STALE_SLOTS);
    assert!(err(env.draw_lottery(1)).contains("NotDue"));
    env.wait_slots(1);
    env.draw_lottery(1).unwrap();

    // The first request's answer arrives late: refused. The second's is taken.
    let late = env.lottery_callback_ix(1, first, rnd(0));
    assert!(err(env.send_unsigned(&[late], &c)).contains("NotDue"));
    env.lottery_callback(1, rnd(0)).unwrap();
    // Only the oracle answers at all.
    let (mut env, _) = lottery_with_ten_tickets();
    env.wait(7 * DAY);
    env.draw_lottery(1).unwrap();
    let mut ix = env.lottery_callback_ix(1, env.lottery(1).asked_slot, rnd(0));
    ix.accounts[0].pubkey = c.pubkey();
    assert!(env.send_unsigned(&[ix], &c).is_err());
}

#[test]
fn a_round_nobody_bought_into_moves_to_its_next_date() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, POT, env.mint).unwrap();
    let due = env.now() + DAY;
    let args = LotteryArgs { price: 10, pot: POT, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: due };
    assert!(err(env.upsert_lottery(&owner, 1, LotteryArgs { price: 0, ..args.clone() })).contains("BadLottery"));
    env.upsert_lottery(&owner, 1, args).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    let l = env.lottery(1);
    assert_eq!((l.status, l.draws_at, l.round), (Round::Open, due + DAY, 0));
}

#[test]
fn a_lottery_pays_each_place_its_share_and_rolls_the_rest_over() {
    let (mut env, [a, b, c]) = lottery_with_places(vec![5_000, 3_000, 1_000]);
    let owner = env.creator.insecure_clone();
    let pot = pool_pda(&env.game, 0);
    env.fund(owner.pubkey(), env.mint, 1_000);
    env.deposit(&owner, 0, env.mint, 1_000).unwrap();
    assert_eq!(env.tokens(&pot), 1_100);

    // 13 picks ticket 3 for first place (b's). Ten tickets, three places: the others are
    // three tickets on, 6 and 9, both c's.
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    let drawn: LotteryDrawn = receipt(&env.lottery_callback(1, rnd(13)).unwrap());
    assert_eq!((drawn.winning_ticket, drawn.winners), (3, vec![b.pubkey(), c.pubkey(), c.pubkey()]));

    // Each place is paid on its own, to its own winner, once.
    let gold = env.mint;
    let to = |who: &Keypair| ata(&who.pubkey(), &gold);
    assert!(err(env.pay_lottery_place(1, 1, to(&b))).contains("NotThePlayers"));
    assert!(err(env.pay_lottery_place(1, 1, to(&a))).contains("NotThePlayers"));
    let first: LotteryPaid = receipt(&env.pay_lottery_place(1, 0, to(&b)).unwrap());
    assert_eq!((first.place, first.winner, first.amount), (0, b.pubkey(), 550));
    assert!(err(env.pay_lottery_place(1, 0, to(&b))).contains("PlacePaid"));
    assert!(err(env.pay_lottery_place(1, 3, to(&c))).contains("PlacePaid"), "there is no fourth place");

    // Money that arrives meanwhile does not change the shares: they are of the pot at payout.
    env.fund(owner.pubkey(), env.mint, 500);
    env.deposit(&owner, 0, env.mint, 500).unwrap();
    env.pay_lottery_place(1, 2, to(&c)).unwrap();
    assert_eq!(env.lottery(1).status, Round::Drawn, "one place is still unpaid");
    env.pay_lottery_place(1, 1, to(&c)).unwrap();
    assert_eq!((my_coins(&env, &b.pubkey()), my_coins(&env, &c.pubkey())), (990 + 550, 940 + 330 + 110));

    // The last place paid ends the round. 10% of the pot, and the deposit, roll over.
    let l = env.lottery(1);
    assert_eq!((l.round, l.status, l.sold, l.paid), (1, Round::Open, 0, 0));
    assert_eq!(env.tokens(&pot), 1_100 - 550 - 330 - 110 + 500);
}

#[test]
fn a_round_with_fewer_tickets_than_places_has_fewer_winners() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    jackpot(&mut env, 0, 0);
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![5_000, 5_000], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    for places in [vec![5_000, 0, 1], vec![1; 9], vec![5_000, 5_001]] {
        assert!(err(env.upsert_lottery(&owner, 1, LotteryArgs { places, ..args.clone() })).contains("BadLottery"));
    }
    env.upsert_lottery(&owner, 1, args).unwrap();
    let a = player(&mut env, 100);
    env.buy_tickets(&a, 1, 1, env.mint).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(7)).unwrap();
    assert!(err(env.pay_lottery_place(1, 1, ata(&a.pubkey(), &env.mint))).contains("PlacePaid"), "one ticket, one winner");
    env.pay_lottery_place(1, 0, ata(&a.pubkey(), &env.mint)).unwrap();
    // Half the pot was won; second place's half stays for next round.
    assert_eq!((env.lottery(1).round, env.tokens(&pool_pda(&env.game, 0))), (1, 5));
}

#[test]
fn every_place_has_its_own_ticket() {
    // Ten tickets and three places, three apart: from any first ticket, three different ones.
    for number in 0..10u64 {
        let (mut env, _) = lottery_with_places(vec![3_000, 3_000, 3_000]);
        env.wait(DAY);
        env.draw_lottery(1).unwrap();
        env.lottery_callback(1, rnd(number)).unwrap();
        let l = env.lottery(1);
        let tickets: Vec<u64> = (0..3).map(|place| l.ticket_of_place(place)).collect();
        assert_eq!(tickets, vec![number, (number + 3) % 10, (number + 6) % 10]);
    }
}

/// LOW, fixed. `pay_lottery` sent the rent of the ticket list straight to the winner's wallet.
/// With three lines or fewer that is less than an empty wallet needs to exist, and a
/// validator refuses such a transaction, so an empty-handed winner could not be paid. The
/// rent now stays in the lottery when the winner's wallet cannot take it, and pays for the
/// next round's first lines. (LiteSVM does not enforce that rule itself, so this shows the
/// program's side.)
#[test]
fn pay_lottery_does_not_leave_an_empty_winner_wallet_below_rent() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let buyer = player(&mut env, 100);
    env.buy_tickets(&buyer, 1, 1, env.mint).unwrap();
    let all = env.lamports(&buyer.pubkey()) - 5_000;
    let out = solana_system_interface::instruction::transfer(&buyer.pubkey(), &owner.pubkey(), all);
    env.send(&[out], &[&buyer]).unwrap();

    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap();
    env.pay_lottery(1, ata(&buyer.pubkey(), &env.mint)).unwrap();
    assert_eq!(env.lamports(&buyer.pubkey()), 0, "the wallet was left as it was");
    assert_eq!(env.tokens(&ata(&buyer.pubkey(), &env.mint)), 100, "and the pot was paid");
}

/// LOW, noted (said at the top of `lottery.rs`). Two things about a lottery's cut. (1) It is rounded down per purchase, so tickets
/// bought one at a time pay none when `price * cut_bps < 10,000`. (2) The cut goes to the
/// game's treasury, which is in the game's mint; a lottery whose pot is in another mint is
/// accepted with a cut, and then no ticket can ever be bought.
#[test]
fn the_lottery_cut_rounds_down_and_needs_a_pot_in_the_games_mint() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 1, usd).unwrap();
    let draws_at = env.now() + DAY;
    env.upsert_lottery(&owner, 1, LotteryArgs { price: 5, pot: 0, cut_bps: 1_000, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at }).unwrap();
    env.upsert_lottery(&owner, 2, LotteryArgs { price: 5, pot: 1, cut_bps: 1_000, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at }).unwrap();

    let p = player(&mut env, 100);
    let before = env.tokens(&env.treasury);
    env.buy_tickets(&p, 1, 1, env.mint).unwrap();
    env.buy_tickets(&p, 1, 1, env.mint).unwrap();
    assert_eq!(env.tokens(&env.treasury) - before, 0, "two tickets, no cut");
    env.buy_tickets(&p, 1, 2, env.mint).unwrap();
    assert_eq!(env.tokens(&env.treasury) - before, 1, "the same two at once pay it");

    env.fund(p.pubkey(), usd, 100);
    assert!(env.buy_tickets(&p, 2, 2, usd).is_err(), "the cut cannot reach a treasury in another mint");
}

/// An answer to a draw of an earlier round (asked twice, answered once) cannot decide a later
/// round, whichever of the old requests it belongs to.
#[test]
fn an_old_rounds_answer_does_not_draw_a_new_round() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let c = env.cranker.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let (a, b) = (player(&mut env, 100), player(&mut env, 100));

    // Round 0: asked, never answered, asked again, answered, paid.
    env.buy_tickets(&a, 1, 1, env.mint).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    let first = env.lottery(1).asked_slot;
    env.wait_slots(loot::STALE_SLOTS + 1);
    env.draw_lottery(1).unwrap();
    let second = env.lottery(1).asked_slot;
    env.lottery_callback(1, rnd(0)).unwrap();
    env.pay_lottery(1, ata(&a.pubkey(), &env.mint)).unwrap();

    // Round 1: a sells out to two players, and is being drawn.
    env.buy_tickets(&a, 1, 1, env.mint).unwrap();
    env.buy_tickets(&b, 1, 1, env.mint).unwrap();
    for slot in [first, second] {
        let ix = env.lottery_callback_ix(1, slot, rnd(1));
        assert!(err(env.send_unsigned(&[ix], &c)).contains("NotDue"), "tickets still on sale");
    }
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    for slot in [first, second] {
        let ix = env.lottery_callback_ix(1, slot, rnd(1));
        assert!(err(env.send_unsigned(&[ix], &c)).contains("NotDue"), "not this draw's request");
    }
    env.lottery_callback(1, rnd(1)).unwrap();
    assert_eq!(env.lottery(1).winner, b.pubkey());
}

/// One line on the list, any number; a purchase too large to price; nothing bought.
#[test]
fn the_ticket_list_at_its_edges() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args.clone()).unwrap();
    let a = player(&mut env, 100);
    assert!(err(env.buy_tickets(&a, 1, 0, env.mint)).contains("ZeroAmount"));
    assert!(err(env.buy_tickets(&a, 1, u64::MAX, env.mint)).contains("Overflow"));
    env.buy_tickets(&a, 1, 1, env.mint).unwrap();
    // A round with tickets sold cannot be rewritten, which is also what keeps its list.
    assert!(err(env.upsert_lottery(&owner, 1, args)).contains("RoundRunning"));
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, [0xff; 32]).unwrap();
    assert_eq!(env.lottery(1).winner, a.pubkey());
}

/// A lottery's `ticket_mint`. Tickets are burned from the player's own account of that mint and
/// from nowhere else: leaving the mint out, naming another, or paying from an account of the
/// pot's token are all refused, the pot is never touched by a purchase, and the owner cannot
/// switch the lottery to another ticket while tickets of the round are out.
#[test]
fn a_lotterys_tickets_in_another_mint_are_burned_from_the_buyer_only() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let kills = env.new_mint(owner.pubkey());
    let other = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 0, gold).unwrap();
    let p = player(&mut env, 500);
    env.deposit(&p, 0, gold, 400).unwrap();
    env.fund(p.pubkey(), kills, 10);
    env.fund(p.pubkey(), other, 10);
    let args = LotteryArgs { price: 1, pot: 0, cut_bps: 0, places: vec![], ticket_mint: kills, every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args.clone()).unwrap();

    let buy = |env: &Env, from: Pubkey, ticket_mint: Option<Pubkey>| {
        Instruction::new_with_bytes(
            loot::ID,
            &loot::instruction::BuyTickets { count: 5, max_price: 1 }.data(),
            loot::accounts::BuyTickets {
                player: p.pubkey(),
                game: env.game,
                lottery: env.mechanic_pda(loot::LOTTERY_SEED, 1),
                player_token: from,
                pot: pool_pda(&env.game, 0),
                treasury: env.treasury,
                mint: ticket_mint.unwrap_or(gold),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: env.fee(),
            }
            .to_account_metas(None),
        )
    };
    let (in_kills, in_gold, in_other) = (ata(&p.pubkey(), &kills), ata(&p.pubkey(), &gold), ata(&p.pubkey(), &other));
    let attempts = [(in_kills, None), (in_kills, Some(other)), (in_other, Some(other)), (in_gold, Some(kills)), (in_other, Some(kills)), (in_gold, None)];
    for (from, mint) in attempts {
        let ix = buy(&env, from, mint);
        assert!(env.send(&[ix], &[&p]).is_err());
    }
    assert_eq!((env.lottery(1).sold, env.tokens(&pool_pda(&env.game, 0)), balance_of(&env, &p, &gold)), (0, 400, 100));

    let ix = buy(&env, in_kills, Some(kills));
    env.send(&[ix], &[&p]).unwrap();
    assert_eq!((env.lottery(1).sold, env.supply(&kills), env.tokens(&pool_pda(&env.game, 0))), (5, 5, 400));
    assert!(err(env.upsert_lottery(&owner, 1, LotteryArgs { ticket_mint: other, ..args })).contains("RoundRunning"));
}

/// LOW, fixed. A lottery that sells its tickets in another token never touches its pot when a
/// ticket is bought, so nothing notices that the pot was never opened. `pay_lottery` failed on
/// the missing account and the round could not end until the owner opened that pool. Now a
/// pot that is not there holds nothing, and the round ends.
#[test]
fn a_lottery_without_its_pot_still_finishes_the_round() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let kills = env.new_mint(owner.pubkey());
    let p = player(&mut env, 0);
    env.fund(p.pubkey(), kills, 10);
    let args = LotteryArgs { price: 1, pot: 9, cut_bps: 0, places: vec![], ticket_mint: kills, every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args.clone()).unwrap();
    env.buy_tickets(&p, 1, 10, kills).unwrap();
    assert_eq!(env.supply(&kills), 0, "ten tickets burned");

    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(3)).unwrap();
    assert_eq!((env.lottery(1).status, env.lottery(1).winner), (Round::Drawn, p.pubkey()));
    assert!(err(env.upsert_lottery(&owner, 1, args)).contains("RoundRunning"));
    env.pay_lottery(1, ata(&p.pubkey(), &gold)).unwrap();
    assert_eq!((env.lottery(1).status, balance_of(&env, &p, &gold)), (Round::Open, 0), "nothing to win, and the next round is open");
}

/// A round nobody bought into moved its date by one period for each
/// `draw_lottery`, so a lottery left alone needed one transaction for every period it missed.
/// Now one call moves it to its next date that is still ahead.
#[test]
fn an_idle_lottery_comes_back_in_one_call() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let p = player(&mut env, 10);
    env.upsert_lottery(&owner, 1, LotteryArgs { price: 1, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: 60, draws_at: env.now() + 60 }).unwrap();
    env.wait(30 * 60);
    let mut calls = 0;
    while env.buy_tickets(&p, 1, 1, gold).is_err() {
        env.draw_lottery(1).unwrap();
        calls += 1;
    }
    assert_eq!(calls, 1, "thirty minutes idle on a one-minute lottery: one transaction");
}

/// Each place was a share of `pot_at_payout` sent from what the pot
/// held then, so anything that took from the pot between payouts (here a stranger running the
/// owner's burn schedule) made the rest unpayable and the round could never end. Now a place
/// is paid its share or what the pot still holds, whichever is less.
#[test]
fn a_lottery_round_ends_when_the_pot_shrinks_between_places() {
    let (mut env, [_, b, c]) = lottery(vec![5_000, 5_000]);
    let owner = env.creator.insecure_clone();
    let pot = pool_pda(&env.game, 0);
    let burn_tenth = ScheduleArgs { active: true, action: Action::Burn { pool: 0, bps: 1_000 }, every: DAY, next_at: env.now(), max_runs: 0 };
    env.upsert_schedule(&owner, 1, burn_tenth).unwrap();

    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(13)).unwrap();
    let gold = env.mint;
    env.pay_lottery_place(1, 0, ata(&b.pubkey(), &gold)).unwrap();
    env.run_schedule(1, gold, pot).unwrap();
    assert_eq!(env.tokens(&pot), 495);

    let paid: LotteryPaid = receipt(&env.pay_lottery_place(1, 1, ata(&c.pubkey(), &gold)).unwrap());
    assert_eq!((paid.amount, env.tokens(&pot)), (495, 0), "what was left");
    assert_eq!((env.lottery(1).round, env.lottery(1).status), (1, Round::Open));
}

/// The rent of the list went to whichever place was paid last, so
/// whoever sent the payouts chose who got it. Now it goes to first place, in any sequence.
#[test]
fn the_list_rent_goes_to_first_place_in_any_sequence() {
    for b_last in [true, false] {
        let (mut env, [_, b, c]) = lottery(vec![5_000, 3_000, 1_000]);
        env.draw_lottery(1).unwrap();
        env.lottery_callback(1, rnd(13)).unwrap(); // places: b, c, c
        let gold = env.mint;
        let (bt, ct) = (ata(&b.pubkey(), &gold), ata(&c.pubkey(), &gold));
        let sequence = if b_last { vec![(1, ct), (2, ct), (0, bt)] } else { vec![(0, bt), (1, ct), (2, ct)] };
        let lottery_key = env.mechanic_pda(loot::LOTTERY_SEED, 1);
        let list_rent = env.lamports(&lottery_key) - env.rent(env.data(&lottery_key).len() - 3 * 40);
        let (b_sol, c_sol) = (env.lamports(&b.pubkey()), env.lamports(&c.pubkey()));
        for (place, to) in sequence {
            env.pay_lottery_place(1, place, to).unwrap();
        }
        assert!(list_rent > 0);
        assert_eq!((env.lamports(&b.pubkey()) - b_sol, env.lamports(&c.pubkey()) - c_sol), (list_rent, 0));
    }
}

/// `ticket_of_place` added before taking the remainder, so a round of
/// more than about 2^63 tickets overflowed. It now goes round the end of the list by subtraction.
#[test]
fn ticket_of_place_holds_in_a_huge_round() {
    let l = record(u64::MAX, 8, u64::MAX - 1);
    assert_eq!(l.ticket_of_place(0), u64::MAX - 1);
    assert_eq!(l.ticket_of_place(7), 7 * (u64::MAX / 8) - 1);
}

/// Each place's ticket is a bijection of the first ticket, so every ticket has the same chance
/// at every place, and no ticket wins twice in one draw. The expected value of any set of
/// tickets is its share of the tickets, wherever they sit in the list. (Places are correlated:
/// a buyer can make winning several places together, or winning exactly one, more likely, but
/// not their expected share larger.)
#[test]
fn every_place_is_a_fair_draw() {
    for sold in 1..=40u64 {
        for set in 1..=8usize {
            let winners = record(sold, set, 0).winners();
            assert_eq!(winners, (set as u64).min(sold));
            let mut wins = vec![vec![0u32; sold as usize]; winners as usize];
            for first in 0..sold {
                let l = record(sold, set, first);
                let tickets: Vec<u64> = (0..winners as u8).map(|p| l.ticket_of_place(p)).collect();
                let mut unique = tickets.clone();
                unique.sort();
                unique.dedup();
                assert_eq!(unique.len(), tickets.len(), "a ticket won twice: sold {sold}, set {set}, first {first}");
                for (place, ticket) in tickets.into_iter().enumerate() {
                    wins[place][ticket as usize] += 1;
                }
            }
            assert!(wins.iter().all(|place| place.iter().all(|n| *n == 1)), "sold {sold}, set {set}");
        }
    }
}

/// The old lottery (no places given): one winner, the whole pot as it is at payout, the list's
/// rent to the winner, the next round open. A second place does not exist.
#[test]
fn a_single_winner_lottery_still_takes_the_whole_pot() {
    let (mut env, [a, _, _]) = lottery(vec![]);
    let gold = env.mint;
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(2)).unwrap(); // ticket 2: a's
    assert_eq!(env.lottery(1).winner, a.pubkey());
    // A sponsor's deposit after the draw is won with the rest, as before.
    let sponsor = player(&mut env, 300);
    env.deposit(&sponsor, 0, gold, 300).unwrap();
    assert!(err(env.pay_lottery_place(1, 1, ata(&a.pubkey(), &gold))).contains("PlacePaid"));
    let before = my_coins(&env, &a.pubkey());
    let paid: LotteryPaid = receipt(&env.pay_lottery(1, ata(&a.pubkey(), &gold)).unwrap());
    assert_eq!((paid.amount, my_coins(&env, &a.pubkey()) - before), (1_400, 1_400));
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 0);
    let l = env.lottery(1);
    assert_eq!((l.round, l.status, l.sold, l.paid, l.pot_at_payout), (1, Round::Open, 0, 0, 0));
}

/// A stranger who adds to the pot before the first payout raises every place by the same
/// share and loses what the places leave; after the first payout it only rolls over. Neither
/// moves value from one winner to another. Place numbers are checked, and so is each winner.
#[test]
fn a_stranger_cannot_move_value_between_places() {
    let (mut env, [a, b, c]) = lottery(vec![5_000, 3_000, 1_000]);
    let gold = env.mint;
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(13)).unwrap(); // b, c, c
    let stranger = player(&mut env, 1_000);
    env.deposit(&stranger, 0, gold, 900).unwrap(); // the pot is 2,000
    let (bt, ct) = (ata(&b.pubkey(), &gold), ata(&c.pubkey(), &gold));
    for place in [8u8, 9, 255] {
        assert!(err(env.pay_lottery_place(1, place, ct)).contains("PlacePaid"));
    }
    assert!(err(env.pay_lottery_place(1, 0, ata(&a.pubkey(), &gold))).contains("NotThePlayers"));
    assert!(err(env.pay_lottery_place(1, 0, ct)).contains("NotThePlayers"));
    let mut amounts = vec![];
    for (place, to) in [(2u8, ct), (0, bt), (1, ct)] {
        let paid: LotteryPaid = receipt(&env.pay_lottery_place(1, place, to).unwrap());
        amounts.push((paid.place, paid.amount));
        if place == 2 {
            // After the first payout, more money only rolls over.
            env.deposit(&stranger, 0, gold, 100).unwrap();
        }
    }
    assert_eq!(amounts, vec![(2, 200), (0, 1_000), (1, 600)]);
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 200 + 100, "the 10% the places leave, and the late deposit, roll over");
}

/// A lottery that burns `ticket_mint` tickets, with two places and a pot that was never opened,
/// still ends: both places are paid nothing and the next round opens.
#[test]
fn a_ticket_mint_lottery_with_places_and_no_pot_still_ends() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let kills = env.new_mint(owner.pubkey());
    let args = LotteryArgs { price: 1, pot: 5, cut_bps: 0, places: vec![6_000, 4_000], ticket_mint: kills, every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    let (a, b) = (player(&mut env, 0), player(&mut env, 0));
    for who in [&a, &b] {
        env.fund(who.pubkey(), kills, 5);
        env.buy_tickets(who, 1, 5, kills).unwrap();
    }
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap(); // tickets 0 (a) and 5 (b)
    env.pay_lottery_place(1, 1, ata(&b.pubkey(), &kills)).unwrap();
    env.pay_lottery_place(1, 0, ata(&a.pubkey(), &kills)).unwrap();
    assert_eq!((env.lottery(1).round, env.lottery(1).status), (1, Round::Open));
}

/// N5 bounded a lottery's period and first draw from above only: a first draw far
/// before 1970 made the next date overflow on every draw (no ticket could be sold, so nothing
/// was at risk). A first draw before 1970 is refused now.
#[test]
fn a_lottery_cannot_start_before_1970() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let args = |draws_at| LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: 1, draws_at };
    assert!(err(env.upsert_lottery(&owner, 1, args(i64::MIN))).contains("BadLottery"));
    assert!(err(env.upsert_lottery(&owner, 1, args(-1))).contains("BadLottery"));
    env.upsert_lottery(&owner, 1, args(0)).unwrap();
}
