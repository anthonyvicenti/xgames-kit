//! Contests: entries on a side, a result or a call-off, claims and the close.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::Instruction,
    anchor_spl::token::spl_token,
    common::*,
    loot::ContestArgs,
    loot::GameUpdate,
    loot::Verdict,
    loot::receipts::Decided,
    loot::state::Share,
    loot::state::To,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn contest(env: &Env, shares: Vec<Share>) -> ContestArgs {
    ContestArgs { sides: 2, closes_at: env.now() + 600, result_by: env.now() + 1_200, shares }
}

fn enter_ix(env: &Env, who: Pubkey, id: u32, side: u8, amount: u64, terms: [u8; 32]) -> Instruction {
    let mint = env.contest(id).mint;
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::Enter { side, amount, terms }.data(),
        loot::accounts::Enter {
            player: who,
            game: env.game,
            contest: env.contest_pda(id),
            entry: env.entry_pda(id, &who, side),
            pot: env.pot_pda(id),
            player_token: ata(&who, &mint),
            mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
    )
}

fn my(env: &Env, who: &Pubkey, mint: &Pubkey) -> u64 {
    env.tokens(&ata(who, mint))
}

fn close_contest_ix(env: &Env, id: u32, opener: Pubkey) -> Instruction {
    let c = env.contest(id);
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::CloseContest {}.data(),
        loot::accounts::CloseContest {
            game: env.game,
            contest: env.contest_pda(id),
            opener,
            mint: c.mint,
            pot: env.pot_pda(id),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
        }
        .to_account_metas(None),
    )
}

fn claim_ix(env: &Env, id: u32, player: Pubkey, side: u8, to: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::Claim {}.data(),
        loot::accounts::Claim {
            game: env.game,
            contest: env.contest_pda(id),
            entry: env.entry_pda(id, &player, side),
            player,
            pot: env.pot_pda(id),
            to,
            mint: env.contest(id).mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
        }
        .to_account_metas(None),
    )
}

fn lamports_to(from: &Keypair, to: Pubkey, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(&from.pubkey(), &to, lamports)
}

/// A wrapped SOL mint and a funded wrapped SOL account for `who` (as the fourth review built it).
fn wrapped_sol(env: &mut Env, who: &Pubkey, amount: u64) -> Pubkey {
    let wsol = spl_token::native_mint::ID;
    if !env.exists(&wsol) {
        let mut mint = vec![0u8; 82];
        mint[44] = 9; // decimals
        mint[45] = 1; // initialized
        env.put(wsol, spl_token::ID, mint);
    }
    let rent = env.rent(165);
    let mut bytes = token_account_bytes(&wsol, who, amount);
    bytes[109..113].copy_from_slice(&1u32.to_le_bytes()); // is_native: some
    bytes[113..121].copy_from_slice(&rent.to_le_bytes());
    env.put_with(ata(who, &wsol), spl_token::ID, rent + amount, bytes);
    wsol
}

fn open_contest_ix(env: &Env, who: Pubkey, id: u32, mint: Pubkey, args: ContestArgs) -> Instruction {
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::OpenContest { id, args }.data(),
        loot::accounts::OpenContest {
            authority: who,
            game: env.game,
            contest: env.contest_pda(id),
            mint,
            pot: env.pot_pda(id),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
    )
}

const SIG: u64 = 5_000;

fn balance_of(env: &Env, who: &Keypair, mint: &Pubkey) -> u64 {
    env.tokens(&ata(&who.pubkey(), mint))
}

fn enter_mint_ix(env: &Env, who: Pubkey, id: u32, side: u8, amount: u64, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::Enter { side, amount, terms: env.contest(id).terms }.data(),
        loot::accounts::Enter {
            player: who,
            game: env.game,
            contest: env.contest_pda(id),
            entry: env.entry_pda(id, &who, side),
            pot: env.pot_pda(id),
            player_token: ata(&who, &mint),
            mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
    )
}

/// What the chain takes for one signature.
const TX_FEE: u64 = 5_000;

/// A contest whose entries closed before it opened is accepted. Only the way out is left.
#[test]
fn a_contest_that_closed_before_it_opened_is_accepted() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let p = player(&mut env, 100);
    let args = ContestArgs { sides: 2, closes_at: env.now() - 1, result_by: env.now(), shares: vec![] };
    env.open_contest(&authority, 1, env.mint, args).unwrap();
    assert!(err(env.enter(&p, 1, 0, 10)).contains("ContestNotOpen"));
    assert!(err(env.decide(&authority, 1, 0)).contains("NoWinner"));
    env.call_off(&authority, 1).unwrap();
    env.close_contest(1).unwrap();
}

/// `enter` is refused once entries closed, with other terms than the contest's, and on a side
/// that does not exist. One player may back two sides; each entry is paid on its own.
#[test]
fn enter_is_refused_late_with_other_terms_or_a_bad_side_and_two_sides_pay_each_their_own() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let (a, b) = (player(&mut env, 1_000), player(&mut env, 1_000));
    env.open_contest(&authority, 1, gold, contest(&env, vec![])).unwrap();
    let terms = env.contest(1).terms;

    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&a, 1, 1, 50).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    assert!(err(env.send(&[enter_ix(&env, a.pubkey(), 1, 0, 1, [0; 32])], &[&a])).contains("TermsChanged"));
    let mut other = terms;
    other[0] ^= 1;
    assert!(err(env.send(&[enter_ix(&env, a.pubkey(), 1, 0, 1, other)], &[&a])).contains("TermsChanged"));
    assert!(err(env.enter(&a, 1, 2, 1)).contains("BadContest"));
    assert!(err(env.enter(&a, 1, 255, 1)).contains("BadContest"));
    assert_eq!((env.contest(1).sides, env.contest(1).entries), (vec![100, 150], 3));
    env.wait(600);
    assert!(err(env.enter(&b, 1, 0, 1)).contains("ContestNotOpen"), "at closes_at, entries are closed");

    env.decide(&authority, 1, 0).unwrap();
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    env.claim(1, a.pubkey(), 1, ata(&a.pubkey(), &gold)).unwrap();
    env.claim(1, b.pubkey(), 1, ata(&b.pubkey(), &gold)).unwrap();
    assert_eq!((my(&env, &a.pubkey(), &gold), my(&env, &b.pubkey(), &gold)), (850 + 250, 900));
    env.close_contest(1).unwrap();
}

/// The claims pay exactly the prize: with three equal winners whose shares round down, the
/// last to claim takes the dust, in every order. With a Token-2022 fee that eats a 1-token
/// entry whole, the 0 entry on the winning side takes nothing in either order and the sum of
/// payouts is still the prize.
#[test]
fn claims_pay_exactly_the_prize_with_dust_and_with_a_zero_entry_among_the_winners() {
    for order in [[0usize, 1, 2], [2, 0, 1], [1, 2, 0]] {
        let mut env = setup();
        let authority = env.authority.insecure_clone();
        let gold = env.mint;
        let winners: Vec<Keypair> = (0..3).map(|_| player(&mut env, 10)).collect();
        let loser = player(&mut env, 10);
        env.open_contest(&authority, 1, gold, contest(&env, vec![])).unwrap();
        for w in &winners {
            env.enter(w, 1, 0, 1).unwrap();
        }
        env.enter(&loser, 1, 1, 10).unwrap();
        env.wait(600);
        env.decide(&authority, 1, 0).unwrap();
        assert_eq!(env.contest(1).prize, 13);
        let mut paid = vec![];
        for i in order {
            env.claim(1, winners[i].pubkey(), 0, ata(&winners[i].pubkey(), &gold)).unwrap();
            paid.push(my(&env, &winners[i].pubkey(), &gold) - 9);
        }
        assert_eq!((paid, env.tokens(&env.pot_pda(1))), (vec![4, 4, 5], 0), "13 / 3: 4, 4 and the dust to the last, order {order:?}");
        env.claim(1, loser.pubkey(), 1, ata(&loser.pubkey(), &gold)).unwrap();
        env.close_contest(1).unwrap();
    }

    for zero_first in [true, false] {
        let mut env = setup();
        let authority = env.authority.insecure_clone();
        let coin = env.new_mint_2022(Some(100), None); // 1% fee, so 1 token arrives as 0
        let (z, w, l) = (wallet(&mut env, coin, 10), wallet(&mut env, coin, 1_000), wallet(&mut env, coin, 1_000));
        env.open_contest(&authority, 1, coin, contest(&env, vec![])).unwrap();
        env.enter(&z, 1, 0, 1).unwrap();
        env.enter(&w, 1, 0, 1_000).unwrap();
        env.enter(&l, 1, 1, 1_000).unwrap();
        let entry: loot::Entry = env.acc(&env.entry_pda(1, &z.pubkey(), 0));
        assert_eq!((entry.amount, env.contest(1).sides.clone()), (0, vec![990, 990]));
        env.wait(600);
        env.decide(&authority, 1, 0).unwrap();
        assert_eq!(env.contest(1).prize, 1_980);
        let claims: Vec<&Keypair> = if zero_first { vec![&z, &w] } else { vec![&w, &z] };
        for who in claims {
            env.claim(1, who.pubkey(), 0, ata(&who.pubkey(), &coin)).unwrap();
        }
        assert_eq!((my(&env, &z.pubkey(), &coin), my(&env, &w.pubkey(), &coin), env.tokens(&env.pot_pda(1))), (9, 1_980 - 20, 0), "zero first: {zero_first}");
        env.claim(1, l.pubkey(), 1, ata(&l.pubkey(), &coin)).unwrap();
        env.close_contest(1).unwrap();
    }
}

/// A claim's money can only land in a token account of the contest's mint that the entry's
/// player owns; a losing entry is claimed once, for nothing; a contest closes only after every
/// entry is claimed, and only to whoever opened it.
#[test]
fn claim_and_close_refuse_every_substitution() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let gems = env.new_mint(env.creator.pubkey());
    let (a, b) = (player(&mut env, 1_000), player(&mut env, 1_000));
    let a_gems = env.token_account(a.pubkey(), gems);
    env.open_contest(&authority, 1, gold, contest(&env, vec![])).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.wait(600);
    env.decide(&authority, 1, 0).unwrap();

    // The winner's own account, but of another mint: the token program refuses.
    let e = err(env.send(&[claim_ix(&env, 1, a.pubkey(), 0, a_gems)], &[&c]));
    assert!(e.contains("custom program error: 0x3"), "MintMismatch: {e}");
    assert!(err(env.send(&[claim_ix(&env, 1, a.pubkey(), 0, ata(&b.pubkey(), &gold))], &[&c])).contains("NotThePlayers"));
    assert!(err(env.send(&[claim_ix(&env, 1, a.pubkey(), 0, env.pot_pda(1))], &[&c])).contains("NotThePlayers"));
    assert!(err(env.send(&[claim_ix(&env, 1, a.pubkey(), 0, a.pubkey())], &[&c])).contains("NotATokenAccount"));
    assert!(env.exists(&env.entry_pda(1, &a.pubkey(), 0)), "nothing was claimed");

    // The loser: nothing, once. Their entry needs no token account at all.
    env.send(&[claim_ix(&env, 1, b.pubkey(), 1, b.pubkey())], &[&c]).unwrap();
    assert!(!env.exists(&env.entry_pda(1, &b.pubkey(), 1)));
    assert!(env.send(&[claim_ix(&env, 1, b.pubkey(), 1, ata(&b.pubkey(), &gold))], &[&c]).is_err(), "claimed once");
    assert!(err(env.close_contest(1)).contains("EntriesLeft"));

    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!(my(&env, &a.pubkey(), &gold), 1_100);
    assert!(err(env.send(&[close_contest_ix(&env, 1, c.pubkey())], &[&c])).contains("ConstraintHasOne"));
    let before = env.lamports(&authority.pubkey());
    env.close_contest(1).unwrap();
    assert!(env.lamports(&authority.pubkey()) > before);
    assert!(!env.exists(&env.contest_pda(1)) && !env.exists(&env.pot_pda(1)));
}

/// Where tokens sent straight to the pot end up. Before the result: they join the prize. After
/// the result but before the last winner claims: that winner takes them (the last claim takes
/// what the pot holds). Only what arrives after the last claim is burned at close, which is
/// narrower than "tokens someone sent to the pot outside of an entry ... are burned" in
/// `close_contest`'s doc comment. Nobody but a winner gains, and only from a sender's gift.
#[test]
fn tokens_sent_straight_to_the_pot_go_to_the_winners_until_the_last_claim() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let (a, b, sponsor) = (player(&mut env, 1_000), player(&mut env, 1_000), player(&mut env, 1_000));
    let pot = env.pot_pda(1);
    env.open_contest(&authority, 1, gold, contest(&env, vec![])).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.send(&[spl_transfer(&sponsor, ata(&sponsor.pubkey(), &gold), pot, 50)], &[&sponsor]).unwrap();
    env.wait(600);
    env.decide(&authority, 1, 0).unwrap();
    assert_eq!(env.contest(1).prize, 250, "the gift before the result is part of the prize");
    env.send(&[spl_transfer(&sponsor, ata(&sponsor.pubkey(), &gold), pot, 30)], &[&sponsor]).unwrap();
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!(my(&env, &a.pubkey(), &gold), 900 + 280, "the last winner also took what arrived after the result");
    env.send(&[spl_transfer(&sponsor, ata(&sponsor.pubkey(), &gold), pot, 20)], &[&sponsor]).unwrap();
    env.claim(1, b.pubkey(), 1, ata(&b.pubkey(), &gold)).unwrap();
    let supply = env.supply(&gold);
    env.close_contest(1).unwrap();
    assert_eq!(supply - env.supply(&gold), 20, "only what came after the last claim is burned");
}

/// `rent::create` on a pot someone pre-funded, in wrapped SOL: the token program counts the
/// parked lamports as the pot's balance from the start, so the stranger's SOL becomes prize for
/// the winners. Raw lamports sent to the pot after the claims leave with the pot's rent to the
/// opener at close. Nobody loses but the sender.
#[test]
fn a_prefunded_wrapped_sol_pot_starts_full_and_closes_whole_to_the_opener() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let (a, b) = (player(&mut env, 0), player(&mut env, 0));
    let wsol = wrapped_sol(&mut env, &a.pubkey(), 1_000);
    wrapped_sol(&mut env, &b.pubkey(), 1_000);
    let pot = env.pot_pda(1);
    let rent = env.rent(165);

    env.send(&[lamports_to(&c, pot, 300_000_000)], &[&c]).unwrap();
    env.open_contest(&authority, 1, wsol, contest(&env, vec![])).unwrap();
    assert_eq!(env.tokens(&pot), 300_000_000 - rent, "the pot opened holding the stranger's SOL");
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.wait(600);
    env.decide(&authority, 1, 0).unwrap();
    assert_eq!(env.contest(1).prize, 300_000_000 - rent + 200);
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &wsol)).unwrap();
    env.claim(1, b.pubkey(), 1, ata(&b.pubkey(), &wsol)).unwrap();
    assert_eq!((env.tokens(&ata(&a.pubkey(), &wsol)), env.tokens(&pot)), (900 + 200 + 300_000_000 - rent, 0));

    env.send(&[lamports_to(&c, pot, 1_000)], &[&c]).unwrap();
    let before = env.lamports(&authority.pubkey());
    let contest_rent = env.lamports(&env.contest_pda(1));
    env.close_contest(1).unwrap();
    assert_eq!(env.lamports(&authority.pubkey()) - before, rent + 1_000 + contest_rent);
    assert!(!env.exists(&pot) && !env.exists(&env.contest_pda(1)));
}

/// `rent::close` leaves a plain empty system account: a contest closed and reopened at the
/// same id inside one transaction is fresh, and a claimed entry cannot be re-entered in the
/// same transaction (the contest has its result).
#[test]
fn a_closed_contest_reopens_fresh_in_one_transaction_and_a_claimed_entry_does_not_revive() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let (a, b) = (player(&mut env, 1_000), player(&mut env, 1_000));
    env.open_contest(&authority, 1, gold, contest(&env, vec![burn(1_000)])).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.wait(600);
    env.decide(&authority, 1, 0).unwrap();

    let terms = env.contest(1).terms;
    let claim_then_enter = [claim_ix(&env, 1, a.pubkey(), 0, ata(&a.pubkey(), &gold)), enter_ix(&env, a.pubkey(), 1, 0, 1, terms)];
    assert!(err(env.send(&claim_then_enter, &[&a])).contains("ContestNotOpen"));
    assert!(env.exists(&env.entry_pda(1, &a.pubkey(), 0)), "the transaction failed as a whole");
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    env.claim(1, b.pubkey(), 1, ata(&b.pubkey(), &gold)).unwrap();
    let old: loot::Contest = env.contest(1);

    let again = ContestArgs { sides: 3, closes_at: env.now() + 60, result_by: env.now() + 120, shares: vec![] };
    let ixs = [close_contest_ix(&env, 1, authority.pubkey()), open_contest_ix(&env, authority.pubkey(), 1, gold, again.clone())];
    env.send(&ixs, &[&authority]).unwrap();
    let new: loot::Contest = env.contest(1);
    assert_eq!((new.verdict, new.entries, new.prize, new.unclaimed, new.winner), (Verdict::Open, 0, 0, 0, 0));
    assert_eq!((new.sides.clone(), new.shares.clone(), new.closes_at), (vec![0, 0, 0], vec![], again.closes_at));
    assert_ne!(new.terms, old.terms);
    assert_eq!(env.tokens(&env.pot_pda(1)), 0);
    let data = env.data(&env.contest_pda(1));
    assert_eq!(env.lamports(&env.contest_pda(1)), env.rent(data.len()), "exactly its rent, nothing carried over");
    assert!(env.enter(&a, 1, 2, 10).is_ok());
    let _ = c;
}

/// `rent.rs`: excess lamports at a pre-funded Entry or Contest address stay in the account
/// (`create` moves nothing out) and leave with its rent to whoever the close names: the entry's
/// player, the contest's opener. The stranger who sends `claim` and `close_contest` gets none
/// of it; `fit` only ever gives spare lamports to the signer who pays for the edit.
#[test]
fn excess_lamports_at_a_prefunded_entry_or_contest_go_to_their_owner_never_to_a_stranger() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let a = player(&mut env, 1_000);
    let (contest_pda, entry_pda) = (env.contest_pda(1), env.entry_pda(1, &a.pubkey(), 0));
    env.send(&[lamports_to(&c, contest_pda, 1_000_000_000), lamports_to(&c, entry_pda, 2_000_000_000)], &[&c]).unwrap();

    let auth_before = env.lamports(&authority.pubkey());
    env.open_contest(&authority, 1, gold, contest(&env, vec![])).unwrap();
    assert_eq!(env.lamports(&contest_pda), 1_000_000_000);
    let pot_rent = env.lamports(&env.pot_pda(1));
    assert_eq!(auth_before - env.lamports(&authority.pubkey()), FEE + SIG + pot_rent, "the opener paid only the pot's rent");
    let a_before = env.lamports(&a.pubkey());
    env.enter(&a, 1, 0, 100).unwrap();
    assert_eq!(env.lamports(&entry_pda), 2_000_000_000);
    assert_eq!(a_before - env.lamports(&a.pubkey()), FEE + SIG);
    // A second entry on the same side edits the account: `fit` gives the spare to the player.
    env.enter(&a, 1, 0, 100).unwrap();
    let entry_rent = env.rent(env.data(&entry_pda).len());
    assert_eq!(env.lamports(&entry_pda), entry_rent);
    assert_eq!(env.lamports(&a.pubkey()), a_before - 2 * (FEE + SIG) + 2_000_000_000 - entry_rent);

    env.wait(600);
    env.decide(&authority, 1, 0).unwrap();
    let (a_before, c_before) = (env.lamports(&a.pubkey()), env.lamports(&c.pubkey()));
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!((env.lamports(&a.pubkey()) - a_before, c_before - env.lamports(&c.pubkey())), (entry_rent, SIG));
    let auth_before = env.lamports(&authority.pubkey());
    env.close_contest(1).unwrap();
    assert_eq!(env.lamports(&authority.pubkey()) - auth_before, 1_000_000_000 + pot_rent);
    assert_eq!(c_before - env.lamports(&c.pubkey()), 2 * SIG);
}

/// A match with a 5% rake that is burned. Two players back themselves, and a spectator backs
/// the first. The authority says who won and never touches the pot.
#[test]
fn players_back_a_side_and_the_winners_share_the_pot() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let (a, b, fan) = (player(&mut env, 1_000), player(&mut env, 1_000), player(&mut env, 1_000));
    let acct = |k: &Keypair| ata(&k.pubkey(), &gold);

    let args = contest(&env, vec![burn(500)]);
    assert!(err(env.open_contest(&owner, 1, gold, args.clone())).contains("NotAuthority"));
    assert!(err(env.open_contest(&authority, 1, gold, ContestArgs { sides: 1, ..args.clone() })).contains("BadContest"));
    assert!(err(env.open_contest(&authority, 1, gold, ContestArgs { result_by: args.closes_at - 1, ..args.clone() })).contains("BadContest"));
    env.open_contest(&authority, 1, gold, args.clone()).unwrap();
    assert!(err(env.open_contest(&authority, 1, gold, args)).contains("ContestOpen"), "one contest at an id");

    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.enter(&fan, 1, 0, 50).unwrap();
    env.enter(&a, 1, 0, 50).unwrap();
    assert!(err(env.enter(&a, 1, 2, 1)).contains("BadContest"));
    assert!(err(env.enter(&a, 1, 0, 0)).contains("ZeroAmount"));
    let state = env.contest(1);
    assert_eq!((state.sides.clone(), state.entries, env.tokens(&env.pot_pda(1))), (vec![200, 100], 3, 300));

    // Nothing is paid, and nothing can be closed, before there is a result.
    assert!(err(env.claim(1, a.pubkey(), 0, acct(&a))).contains("ContestOpen"));
    assert!(err(env.close_contest(1)).contains("ContestOpen"));
    assert!(err(env.decide(&owner, 1, 0)).contains("NotAuthority"));

    env.wait(600);
    assert!(err(env.enter(&fan, 1, 1, 10)).contains("ContestNotOpen"), "entries closed");
    let supply = env.supply(&gold);
    let logs = env.decide(&authority, 1, 0).unwrap();
    let d: Decided = receipt(&logs);
    assert_eq!((d.pot, d.prize, supply - env.supply(&gold)), (300, 285, 15));
    assert!(err(env.decide(&authority, 1, 1)).contains("ContestNotOpen"), "a result is final");
    assert!(err(env.call_off(&authority, 1)).contains("ContestNotOpen"));

    // A winner's money can only go to that winner.
    assert!(err(env.claim(1, a.pubkey(), 0, acct(&b))).contains("NotThePlayers"));
    env.claim(1, a.pubkey(), 0, acct(&a)).unwrap();
    assert_eq!(balance_of(&env, &a, &gold), 850 + 213, "150 of the 200 on the winning side: 285 * 150 / 200, rounded down");
    assert!(err(env.close_contest(1)).contains("EntriesLeft"));
    env.claim(1, b.pubkey(), 1, acct(&b)).unwrap();
    env.claim(1, fan.pubkey(), 0, acct(&fan)).unwrap();
    assert_eq!((balance_of(&env, &b, &gold), balance_of(&env, &fan, &gold)), (900, 950 + 72), "the last winner takes what rounding left");
    assert!(env.claim(1, a.pubkey(), 0, acct(&a)).is_err(), "an entry is claimed once");

    let before = env.lamports(&authority.pubkey());
    env.close_contest(1).unwrap();
    assert!(!env.exists(&env.contest_pda(1)) && !env.exists(&env.pot_pda(1)));
    assert!(env.lamports(&authority.pubkey()) > before, "the rent went back to whoever opened it");
    // The id is free again.
    let again = contest(&env, vec![]);
    env.open_contest(&authority, 1, gold, again).unwrap();
}

/// A contest with no result gives every entry its own money back: the authority calls it off,
/// or anyone does once the result is overdue.
#[test]
fn a_contest_with_no_result_gives_everyone_their_money_back() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let (a, b) = (player(&mut env, 1_000), player(&mut env, 1_000));
    let acct = |k: &Keypair| ata(&k.pubkey(), &gold);

    // The authority names a side nobody backed: that is not a result.
    let args = contest(&env, vec![burn(500)]);
    env.open_contest(&authority, 1, gold, args).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 0, 300).unwrap();
    assert!(err(env.decide(&authority, 1, 1)).contains("NoWinner"));
    assert!(err(env.call_off(&c, 1)).contains("NotDue"));
    env.call_off(&authority, 1).unwrap();
    assert_eq!(env.contest(1).verdict, Verdict::Off);
    assert!(err(env.enter(&a, 1, 0, 1)).contains("ContestNotOpen"));
    // Even with the game paused and suspended.
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    let admin = env.admin.insecure_clone();
    env.set_suspended(&admin, true).unwrap();
    env.claim(1, a.pubkey(), 0, acct(&a)).unwrap();
    env.claim(1, b.pubkey(), 0, acct(&b)).unwrap();
    assert_eq!((balance_of(&env, &a, &gold), balance_of(&env, &b, &gold)), (1_000, 1_000), "no rake on a contest that never happened");
    env.set_suspended(&admin, false).unwrap();
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(false) }).unwrap();

    // Tokens someone sent straight to the pot belong to nobody: closing burns them.
    let pot = env.pot_pda(1);
    let stray = spl_transfer(&a, acct(&a), pot, 7);
    env.send(&[stray], &[&a]).unwrap();
    let supply = env.supply(&gold);
    env.close_contest(1).unwrap();
    assert_eq!(supply - env.supply(&gold), 7);

    // The authority goes silent: once the result is overdue, anyone calls it off.
    let args = contest(&env, vec![]);
    env.open_contest(&authority, 2, gold, args).unwrap();
    env.enter(&a, 2, 1, 40).unwrap();
    env.wait(1_200);
    assert!(err(env.call_off(&c, 2)).contains("NotDue"), "not until the promised time has passed");
    env.wait(1);
    env.call_off(&c, 2).unwrap();
    env.claim(2, a.pubkey(), 1, acct(&a)).unwrap();
    assert_eq!(balance_of(&env, &a, &gold), 993);
}

/// MEDIUM, fixed. `enter` signed a contest's address, a side and an amount, and none of its
/// terms, and an id is free again once its contest closes. The authority could close an empty
/// contest and open another at the same id whose shares take the whole pot; an entry signed for
/// the first landed in the second. Now a contest carries a hash of its terms and an entry
/// names the hash it saw.
#[test]
fn an_entry_signs_the_contests_terms() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let victim = player(&mut env, 1_000);
    let authoritys = env.token_account(authority.pubkey(), gold);

    let fair = contest(&env, vec![]);
    env.open_contest(&authority, 1, gold, fair.clone()).unwrap();
    assert_eq!(env.contest(1).terms, loot::terms(&gold, &fair));
    let signed = enter_mint_ix(&env, victim.pubkey(), 1, 0, 1_000, gold);

    env.call_off(&authority, 1).unwrap();
    env.close_contest(1).unwrap();
    let rigged = ContestArgs { sides: 2, closes_at: fair.closes_at, result_by: fair.result_by, shares: vec![Share { to: To::Account(authoritys), bps: 10_000 }] };
    env.open_contest(&authority, 1, gold, rigged).unwrap();

    assert!(err(env.send(&[signed.clone()], &[&victim])).contains("TermsChanged"));
    assert_eq!(balance_of(&env, &victim, &gold), 1_000);

    // The same terms again are the same deal: the entry is good there.
    env.call_off(&authority, 1).unwrap();
    env.close_contest(1).unwrap();
    env.open_contest(&authority, 1, gold, fair).unwrap();
    env.send(&[signed], &[&victim]).unwrap();
}

/// LOW, fixed. `decide` had no deadline, so a result could be named long after it was due and
/// "every entry takes its own money back" was a race. Now no result is taken after `result_by`.
#[test]
fn no_result_is_taken_after_it_was_due() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let (a, b) = (player(&mut env, 100), player(&mut env, 100));
    let args = contest(&env, vec![]);
    env.open_contest(&authority, 1, gold, args).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.wait(1_201);
    assert!(err(env.decide(&authority, 1, 1)).contains("ResultOverdue"));
    env.call_off(&c, 1).unwrap();
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!((env.contest(1).verdict, balance_of(&env, &a, &gold)), (Verdict::Off, 100));
}

/// LOW, fixed. `close_contest` burns what is left in the pot, and the token program refuses to
/// burn wrapped SOL, so one stray lamport kept a wrapped SOL contest from ever closing. Now a
/// wrapped SOL pot is closed without a burn, and what is in it leaves with the rent.
#[test]
fn a_stray_lamport_of_wrapped_sol_does_not_keep_a_contest_open() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let wsol = spl_token::native_mint::ID;
    if !env.exists(&wsol) {
        let mut mint = vec![0u8; 82];
        mint[44] = 9; // decimals
        mint[45] = 1; // initialized
        env.put(wsol, spl_token::ID, mint);
    }
    let args = contest(&env, vec![]);
    env.open_contest(&authority, 1, wsol, args).unwrap();
    env.call_off(&authority, 1).unwrap();

    // A stranger's wrapped SOL account with one lamport in it.
    let stranger = player(&mut env, 0);
    let from = Keypair::new().pubkey();
    let rent = env.rent(165);
    let mut bytes = token_account_bytes(&wsol, &stranger.pubkey(), 1);
    bytes[109..113].copy_from_slice(&1u32.to_le_bytes()); // is_native: some
    bytes[113..121].copy_from_slice(&rent.to_le_bytes());
    env.put_with(from, spl_token::ID, rent + 1, bytes);
    let stray = spl_transfer(&stranger, from, env.pot_pda(1), 1);
    env.send(&[stray], &[&stranger]).unwrap();

    env.close_contest(1).unwrap();
    assert!(!env.exists(&env.contest_pda(1)) && !env.exists(&env.pot_pda(1)));
}

/// A contest never pays out more than its pot and leaves nothing behind, whatever the order of
/// the claims, with shares and amounts that do not divide.
#[test]
fn a_contest_pays_out_exactly_its_pot_in_any_order_of_claims() {
    for order in [[0usize, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]] {
        let mut env = setup();
        let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
        let gold = env.mint;
        env.open_pool(&owner, 0, gold).unwrap();
        let stakes = [(0u8, 7u64), (0, 13), (0, 1), (1, 1_000_003)];
        let players: Vec<Keypair> = stakes.iter().map(|(_, amount)| player(&mut env, *amount)).collect();
        let args = contest(&env, vec![burn(333), pool(0, 777)]);
        env.open_contest(&authority, 1, gold, args).unwrap();
        for (p, (side, amount)) in players.iter().zip(stakes) {
            env.enter(p, 1, side, amount).unwrap();
        }
        let pot = env.tokens(&env.pot_pda(1));
        env.decide(&authority, 1, 0).unwrap();
        let prize = env.contest(1).prize;
        assert_eq!(env.tokens(&env.pot_pda(1)), prize);
        assert!(prize <= pot);

        for i in order {
            let p = &players[i];
            env.claim(1, p.pubkey(), stakes[i].0, ata(&p.pubkey(), &gold)).unwrap();
        }
        let paid: u64 = players.iter().map(|p| balance_of(&env, p, &gold)).sum();
        assert_eq!((paid, env.tokens(&env.pot_pda(1)), balance_of(&env, &players[3], &gold)), (prize, 0, 0));
        env.close_contest(1).unwrap();
    }
}

/// A contest's entries cannot be claimed against another contest's pot, an entry is one per
/// player and side, and a contest cannot close or reopen while an entry is unclaimed, so an old
/// entry never meets a new contest at the same address.
#[test]
fn an_entry_belongs_to_one_contest_and_holds_its_id_until_it_is_claimed() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let (a, b) = (player(&mut env, 100), player(&mut env, 100));
    for id in [1, 2] {
        let args = contest(&env, vec![]);
        env.open_contest(&authority, id, gold, args).unwrap();
    }
    env.enter(&a, 1, 0, 10).unwrap();
    env.enter(&b, 2, 0, 100).unwrap();
    env.call_off(&authority, 1).unwrap();
    env.call_off(&authority, 2).unwrap();

    // a's entry of contest 1, claimed from contest 2's pot.
    let c = env.cranker.insecure_clone();
    let ix = Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::Claim {}.data(),
        loot::accounts::Claim {
            game: env.game,
            contest: env.contest_pda(2),
            entry: env.entry_pda(1, &a.pubkey(), 0),
            player: a.pubkey(),
            pot: env.pot_pda(2),
            to: ata(&a.pubkey(), &gold),
            mint: gold,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
        }
        .to_account_metas(None),
    );
    assert!(err(env.send(&[ix], &[&c])).contains("ConstraintHasOne"));

    assert!(err(env.close_contest(1)).contains("EntriesLeft"));
    let again = contest(&env, vec![]);
    assert!(err(env.open_contest(&authority, 1, gold, again)).contains("ContestOpen"));
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert!(env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).is_err());
    assert_eq!((balance_of(&env, &a, &gold), env.tokens(&env.pot_pda(2))), (100, 100));
}

/// By design. A contest's shares are written by the authority and can pay an account or a
/// holder (the arena's owner). The reviewer raised it because the third review's fix 4 lets
/// only the owner write such a share on an item; that rule is about admins. The authority is
/// one of the project's own keys, which the program trusts, and every entry signs the terms.
#[test]
fn the_authority_writes_a_contests_shares_and_every_entry_signs_them() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let (a, b) = (player(&mut env, 100), player(&mut env, 100));
    let arena_owner = env.token_account(Keypair::new().pubkey(), gold);
    let args = ContestArgs { sides: 2, closes_at: env.now() + 600, result_by: env.now() + 1_200, shares: vec![Share { to: To::Account(arena_owner), bps: 1_000 }] };
    env.open_contest(&authority, 1, gold, args).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&b, 1, 1, 100).unwrap();
    env.decide(&authority, 1, 0).unwrap();
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &gold)).unwrap();
    assert_eq!((env.tokens(&arena_owner), balance_of(&env, &a, &gold)), (20, 180));
}

/// The third review's fixes 3 and 8, at their edges. A result is taken up to and including the
/// second it was due and a stranger's `call_off` only after it, so there is no second in which
/// both work or neither does. The terms an entry signs name the token as well: the same
/// numbers in another mint are other terms.
#[test]
fn a_result_and_a_call_off_never_share_a_second_and_terms_name_the_mint() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let gems = env.new_mint(owner.pubkey());
    let a = player(&mut env, 200);
    let args = ContestArgs { sides: 2, closes_at: env.now() + 600, result_by: env.now() + 1_200, shares: vec![] };
    for id in [1, 2] {
        env.open_contest(&authority, id, gold, args.clone()).unwrap();
        env.enter(&a, id, 0, 100).unwrap();
    }
    env.open_contest(&authority, 3, gems, args.clone()).unwrap();
    assert_ne!(env.contest(1).terms, env.contest(3).terms);
    assert_eq!(env.contest(1).terms, env.contest(2).terms);

    env.wait(1_200);
    assert!(err(env.call_off(&c, 1)).contains("NotDue"));
    env.decide(&authority, 1, 0).unwrap();
    env.wait(1);
    assert!(err(env.decide(&authority, 2, 0)).contains("ResultOverdue"));
    env.call_off(&c, 2).unwrap();
    assert_eq!((env.contest(1).verdict, env.contest(2).verdict), (Verdict::Won, Verdict::Off));
}

/// A contest at its limits: 255 sides, amounts near the top of 64 bits, and three shares that
/// each round down. Nothing overflows, the account never changes size, every entry's rent
/// comes back, and the pot is paid out to the last unit.
#[test]
fn a_contest_of_the_largest_numbers_pays_out_to_the_last_unit_and_closes() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let big = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 0, big).unwrap();
    let third = u64::MAX / 3;
    let players: Vec<Keypair> = (0..3).map(|_| player(&mut env, 0)).collect();
    for p in &players {
        env.fund(p.pubkey(), big, third);
    }
    let args = ContestArgs { sides: 255, closes_at: env.now() + 600, result_by: env.now() + 1_200, shares: vec![burn(3_333), pool(0, 3_333), burn(1)] };
    env.open_contest(&authority, 1, big, args).unwrap();
    let size = env.data(&env.contest_pda(1)).len();
    let before: Vec<u64> = players.iter().map(|p| env.lamports(&p.pubkey())).collect();
    env.enter(&players[0], 1, 254, third).unwrap();
    env.enter(&players[0], 1, 254, 0).unwrap_err();
    env.enter(&players[1], 1, 254, third - 1).unwrap();
    env.enter(&players[1], 1, 254, 1).unwrap();
    env.enter(&players[2], 1, 0, third).unwrap();
    assert!(err(env.enter(&players[2], 1, 255, 1)).contains("BadContest"));
    env.decide(&authority, 1, 254).unwrap();
    assert_eq!(env.data(&env.contest_pda(1)).len(), size);
    for (p, side) in [(&players[2], 0), (&players[1], 254), (&players[0], 254)] {
        env.claim(1, p.pubkey(), side, ata(&p.pubkey(), &big)).unwrap();
    }
    assert_eq!(env.tokens(&env.pot_pda(1)), 0);
    let paid: u64 = players.iter().map(|p| balance_of(&env, p, &big)).sum();
    assert_eq!(paid, env.contest(1).prize);
    env.close_contest(1).unwrap();
    assert!(!env.exists(&env.contest_pda(1)) || env.data(&env.contest_pda(1)).is_empty());
    // The first and the third each sent one entry that landed and one that was refused; the
    // second sent two that landed.
    let spent = [FEE + 2 * TX_FEE, 2 * (FEE + TX_FEE), FEE + 2 * TX_FEE];
    for ((p, had), spent) in players.iter().zip(before).zip(spent) {
        assert_eq!(env.lamports(&p.pubkey()), had - spent, "only the fees are gone: the entry's rent came back");
    }
}
