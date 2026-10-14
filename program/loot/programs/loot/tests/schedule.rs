//! Schedules: emissions, burns and moves on a timer.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    anchor_spl::token::spl_token,
    common::*,
    loot::Action,
    loot::ScheduleArgs,
    loot::receipts::ScheduleRan,
    solana_signer::Signer,
};

/// The owner opens pool `index` in `mint` and puts `amount` in it.
fn pool_with(env: &mut Env, index: u8, mint: Pubkey, amount: u64) {
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, index, mint).unwrap();
    if amount > 0 {
        env.fund(owner.pubkey(), mint, amount);
        env.deposit(&owner, index, mint, amount).unwrap();
    }
}

/// `run_schedule` with these remaining accounts.
fn run_ix(env: &Env, id: u32, rest: &[AccountMeta]) -> Instruction {
    let mut metas = loot::accounts::RunSchedule {
        game: env.game,
        schedule: env.mechanic_pda(loot::SCHEDULE_SEED, id),
        token_program: spl_token::ID,
        token_2022_program: loot::tokens::TOKEN_2022_ID,
    }
    .to_account_metas(None);
    metas.extend_from_slice(rest);
    Instruction::new_with_bytes(loot::ID, &loot::instruction::RunSchedule {}.data(), metas)
}

fn loot_ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(loot::ID, &data, metas)
}

fn run_schedule_ix(env: &Env, id: u32, first: Pubkey, second: Pubkey) -> Instruction {
    let mut metas = loot::accounts::RunSchedule {
        game: env.game,
        schedule: env.mechanic_pda(loot::SCHEDULE_SEED, id),
        token_program: spl_token::ID,
        token_2022_program: loot::tokens::TOKEN_2022_ID,
    }
    .to_account_metas(None);
    metas.extend([AccountMeta::new(first, false), AccountMeta::new(second, false)]);
    metas.push(AccountMeta::new_readonly(env.mint_of(&first), false));
    loot_ix(loot::instruction::RunSchedule {}.data(), metas)
}

/// A schedule whose start is in the past (or 0) starts now: one run, then the next is a period
/// away. Before, every missed period was a run anyone could send at once.
#[test]
fn a_schedule_whose_start_is_in_the_past_starts_now() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let points = env.new_mint(env.game);
    env.open_pool(&owner, 0, points).unwrap();
    let pool = pool_pda(&env.game, 0);
    for (id, next_at) in [(1, env.now() - 10 * DAY), (2, 0)] {
        let args = ScheduleArgs {
            active: true,
            action: Action::Issue { mint: points, pool: 0, amount: 1_000, halve_every: 0 },
            every: DAY,
            next_at,
            max_runs: 0,
        };
        env.upsert_schedule(&owner, id, args).unwrap();
        env.run_schedule(id, points, pool).unwrap();
        assert!(err(env.run_schedule(id, points, pool)).contains("NotDue"));
    }
    assert_eq!(env.tokens(&pool), 2_000, "one run each");
}

/// With the same check, a schedule that moves a pool into itself would fail at every run, so it
/// is refused when it is written. A move between two pools is written as before.
#[test]
fn a_schedule_cannot_move_a_pool_into_itself() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let args = |from, to| ScheduleArgs { active: true, action: Action::Move { from, to, bps: 1_000 }, every: DAY, next_at: 0, max_runs: 0 };
    assert!(err(env.upsert_schedule(&owner, 1, args(2, 2))).contains("BadSchedule"));
    env.upsert_schedule(&owner, 1, args(2, 3)).unwrap();
}

/// A schedule only touches what it names: a move between pools of two mints, a move with a
/// mint that is not the pools', an issue of a mint the game does not control, an issue into a
/// pool of another mint, and a burn of a pool that was closed, all fail and move nothing.
#[test]
fn run_schedule_refuses_the_wrong_mint_a_foreign_mint_and_a_closed_pool() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    let ours = env.new_mint(env.game);
    pool_with(&mut env, 0, gold, 1_000);
    pool_with(&mut env, 1, gold, 0);
    pool_with(&mut env, 2, other, 0);
    let now = env.now();
    let args = |action| ScheduleArgs { active: true, action, every: DAY, next_at: now, max_runs: 0 };
    env.upsert_schedule(&owner, 1, args(Action::Move { from: 0, to: 2, bps: 5_000 })).unwrap();
    env.upsert_schedule(&owner, 2, args(Action::Move { from: 0, to: 1, bps: 5_000 })).unwrap();
    env.upsert_schedule(&owner, 3, args(Action::Issue { mint: other, pool: 2, amount: 100, halve_every: 0 })).unwrap();
    env.upsert_schedule(&owner, 4, args(Action::Issue { mint: ours, pool: 1, amount: 100, halve_every: 0 })).unwrap();
    env.upsert_schedule(&owner, 5, args(Action::Burn { pool: 2, bps: 10_000 })).unwrap();
    let (p0, p1, p2) = (pool_pda(&env.game, 0), pool_pda(&env.game, 1), pool_pda(&env.game, 2));
    let w = |key| AccountMeta::new(key, false);
    let r = |key| AccountMeta::new_readonly(key, false);
    let c = env.cranker.insecure_clone();

    let e = err(env.send(&[run_ix(&env, 1, &[w(p0), w(p2), r(gold)])], &[&c]));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    let e = err(env.send(&[run_ix(&env, 1, &[w(p0), w(p2), r(other)])], &[&c]));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    let e = err(env.send(&[run_ix(&env, 2, &[w(p0), w(p1), r(other)])], &[&c]));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    assert!(err(env.send(&[run_ix(&env, 2, &[w(p0), w(p1)])], &[&c])).contains("WrongMint"));
    let e = err(env.send(&[run_ix(&env, 3, &[w(other), w(p2)])], &[&c]));
    assert!(e.contains("owner does not match"), "{e}");
    let e = err(env.send(&[run_ix(&env, 4, &[w(ours), w(p1)])], &[&c]));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    env.close_pool(&owner, 2).unwrap();
    assert!(err(env.send(&[run_ix(&env, 5, &[w(other), w(p2)])], &[&c])).contains("NotATokenAccount"));
    assert_eq!((env.tokens(&p0), env.tokens(&p1), env.supply(&other), env.supply(&ours)), (1_000, 0, 0, 0));
    for id in 1..=5 {
        assert_eq!(env.acc::<loot::Schedule>(&env.mechanic_pda(loot::SCHEDULE_SEED, id)).runs, 0);
    }
    env.send(&[run_ix(&env, 2, &[w(p0), w(p1), r(gold)])], &[&c]).unwrap();
    assert_eq!((env.tokens(&p0), env.tokens(&p1)), (500, 500));
}

/// By design, shown: a schedule that fell behind is caught up one run per call, and the calls
/// can share one transaction. Each run keeps the rhythm, halves on time, mints nothing once
/// the amount has halved to zero, and `max_runs` stops it mid-way.
#[test]
fn a_schedule_behind_its_time_is_caught_up_in_one_transaction() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let ours = env.new_mint(env.game);
    pool_with(&mut env, 5, ours, 0);
    let start = env.now();
    let args = ScheduleArgs { active: true, action: Action::Issue { mint: ours, pool: 5, amount: 8, halve_every: 1 }, every: HOUR, next_at: start, max_runs: 6 };
    env.upsert_schedule(&owner, 1, args).unwrap();
    env.wait(10 * HOUR);
    let c = env.cranker.insecure_clone();
    let run = run_ix(&env, 1, &[AccountMeta::new(ours, false), AccountMeta::new(pool_pda(&env.game, 5), false)]);
    assert!(err(env.send(&vec![run.clone(); 7], &[&c])).contains("ScheduleOver"));
    let logs = env.send(&vec![run.clone(); 6], &[&c]).unwrap();
    let ran: ScheduleRan = receipt(&logs);
    assert_eq!((ran.run, ran.amount), (1, 8));
    let s: loot::Schedule = env.acc(&env.mechanic_pda(loot::SCHEDULE_SEED, 1));
    assert_eq!((s.runs, s.next_at, env.tokens(&pool_pda(&env.game, 5))), (6, start + 6 * HOUR, 8 + 4 + 2 + 1));
    assert!(err(env.send(&[run], &[&c])).contains("ScheduleOver"));
}

#[test]
fn an_emission_mints_on_its_timer_and_halves() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let points = env.new_mint(env.game); // a mint the game controls
    env.open_pool(&owner, 0, points).unwrap();
    let rewards = pool_pda(&env.game, 0);
    let start = env.now() + DAY;
    let emission = |max_runs| ScheduleArgs {
        active: true,
        action: Action::Issue { mint: points, pool: 0, amount: 1_000, halve_every: 2 },
        every: DAY,
        next_at: start,
        max_runs,
    };
    assert!(err(env.upsert_schedule(&authority, 1, emission(5))).contains("NotOwner"));
    assert!(err(env.upsert_schedule(&owner, 1, ScheduleArgs { every: 0, ..emission(5) })).contains("BadSchedule"));
    env.upsert_schedule(&owner, 1, emission(5)).unwrap();

    // Not before its time, and one run for each day that has passed.
    assert!(err(env.run_schedule(1, points, rewards)).contains("NotDue"));
    env.wait(DAY);
    env.run_schedule(1, points, rewards).unwrap();
    assert!(err(env.run_schedule(1, points, rewards)).contains("NotDue"));
    assert_eq!(env.tokens(&rewards), 1_000);

    // It fell three days behind: three runs catch it up. 1000, 1000, 500, 500.
    env.wait(3 * DAY);
    for _ in 0..3 {
        env.run_schedule(1, points, rewards).unwrap();
    }
    assert_eq!(env.tokens(&rewards), 3_000);
    // Switched off, it does not run. An edit keeps the count, so the fifth run is still the
    // last and still halved twice.
    env.upsert_schedule(&owner, 1, ScheduleArgs { active: false, next_at: env.now(), ..emission(5) }).unwrap();
    assert!(err(env.run_schedule(1, points, rewards)).contains("ScheduleOver"));
    env.upsert_schedule(&owner, 1, ScheduleArgs { next_at: env.now(), ..emission(5) }).unwrap();
    let logs = env.run_schedule(1, points, rewards).unwrap();
    let ran: loot::receipts::ScheduleRan = receipt(&logs);
    assert_eq!((ran.run, ran.amount), (5, 250));
    env.wait(DAY);
    assert!(err(env.run_schedule(1, points, rewards)).contains("ScheduleOver"));
    assert_eq!(env.supply(&points), 3_250);
    assert_eq!(env.fees(), 0, "running a schedule costs no fee");
}

#[test]
fn a_schedule_burns_or_moves_a_share_of_a_pool() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    for index in 0..3 {
        env.open_pool(&owner, index, env.mint).unwrap();
    }
    let (treasury_pool, stakers, other) = (pool_pda(&env.game, 0), pool_pda(&env.game, 1), pool_pda(&env.game, 2));
    env.fund(owner.pubkey(), env.mint, 1_000);
    env.deposit(&owner, 0, env.mint, 1_000).unwrap();
    let supply = env.supply(&env.mint);
    let now = env.now();
    let args = |action| ScheduleArgs { active: true, action, every: DAY, next_at: now, max_runs: 0 };
    env.upsert_schedule(&owner, 1, args(Action::Burn { pool: 0, bps: 500 })).unwrap();
    env.upsert_schedule(&owner, 2, args(Action::Move { from: 0, to: 1, bps: 2_000 })).unwrap();
    assert!(err(env.upsert_schedule(&owner, 3, args(Action::Burn { pool: 0, bps: 10_001 }))).contains("BadSchedule"));

    // 5% of 1000 burned, then 20% of the 950 left moved to the stakers' pool.
    env.run_schedule(1, env.mint, treasury_pool).unwrap();
    assert_eq!((env.tokens(&treasury_pool), supply - env.supply(&env.mint)), (950, 50));
    env.run_schedule(2, treasury_pool, stakers).unwrap();
    assert_eq!((env.tokens(&treasury_pool), env.tokens(&stakers)), (760, 190));

    // A schedule only touches the pools it names.
    env.wait(DAY);
    assert!(err(env.run_schedule(1, env.mint, other)).contains("WrongPool"));
    assert!(err(env.run_schedule(2, treasury_pool, other)).contains("WrongPool"));
    assert!(err(env.run_schedule(2, stakers, treasury_pool)).contains("WrongPool"));
    assert!(err(env.run_schedule(2, ata(&env.game, &env.mint), stakers)).contains("WrongPool"), "never the order vault");
}

/// A schedule that mints takes its mint and its pool in that order and no other accounts, and
/// one whose pool is in another mint fails without counting a run.
#[test]
fn an_emission_names_its_mint_and_its_pool() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let c = env.cranker.insecure_clone();
    let points = env.new_mint(env.game);
    let other = env.new_mint(env.game);
    env.open_pool(&owner, 0, points).unwrap();
    env.open_pool(&owner, 1, env.mint).unwrap();
    let start = env.now();
    let args = |pool| ScheduleArgs {
        active: true,
        action: Action::Issue { mint: points, pool, amount: 1_000, halve_every: 1 },
        every: DAY,
        next_at: start,
        max_runs: 0,
    };
    env.upsert_schedule(&owner, 1, args(0)).unwrap();
    env.upsert_schedule(&owner, 2, args(1)).unwrap();
    let (p0, p1) = (pool_pda(&env.game, 0), pool_pda(&env.game, 1));

    for (first, second) in [(p0, points), (other, p0), (points, p1), (points, ata(&env.game, &env.mint))] {
        let ix = run_schedule_ix(&env, 1, first, second);
        assert!(err(env.send(&[ix], &[&c])).contains("WrongPool"));
    }
    assert!(env.run_schedule(2, points, p1).is_err(), "the pool holds another mint");
    let s: loot::Schedule = env.acc(&env.mechanic_pda(loot::SCHEDULE_SEED, 2));
    assert_eq!(s.runs, 0);

    // Halving every run: 1000, 500, 250.
    for _ in 0..3 {
        env.run_schedule(1, points, p0).unwrap();
        env.wait(DAY);
    }
    assert_eq!(env.tokens(&p0), 1_750);
}
