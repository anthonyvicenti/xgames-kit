//! Staking: positions, the lock, and rewards that flow in from a pool.
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
    loot::LotteryArgs,
    loot::Position,
    loot::ScheduleArgs,
    loot::Stake,
    loot::receipts::Unstaked,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn stake_state(env: &Env, id: u32) -> Stake {
    env.acc(&env.mechanic_pda(loot::STAKE_SEED, id))
}

/// `stake`/`unstake` accounts: player 0, game 1, stake 2, position 3, staked_vault 4,
/// rewards_vault 5, rewards_pool 6, player_tokens 7, player_rewards 8, mint 9, rewards_mint 10.
fn staking_metas(env: &Env, who: Pubkey, id: u32) -> Vec<AccountMeta> {
    let s = stake_state(env, id);
    loot::accounts::Staking {
        player: who,
        game: env.game,
        stake: env.mechanic_pda(loot::STAKE_SEED, id),
        position: env.position_pda(id, &who),
        staked_vault: env.staked_vault(id),
        rewards_vault: env.rewards_vault(id),
        rewards_pool: pool_pda(&env.game, s.rewards_pool),
        player_tokens: ata(&who, &s.mint),
        player_rewards: ata(&who, &s.rewards_mint),
        mint: s.mint,
        rewards_mint: s.rewards_mint,
        token_program: spl_token::ID,
        token_2022_program: loot::tokens::TOKEN_2022_ID,
        fee: env.fee(),
    }
    .to_account_metas(None)
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

const REWARDS: u8 = 3;

const REVENUE: u8 = 0;

fn loot_ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(loot::ID, &data, metas)
}

/// `stake` or `unstake` as one instruction, so several fit in one transaction.
fn staking_ix(env: &Env, who: Pubkey, id: u32, rewards_mint: Pubkey, data: Vec<u8>) -> Instruction {
    let stake = env.mechanic_pda(loot::STAKE_SEED, id);
    let s: loot::Stake = env.acc(&stake);
    loot_ix(
        data,
        loot::accounts::Staking {
            player: who,
            game: env.game,
            stake,
            position: env.position_pda(id, &who),
            staked_vault: env.staked_vault(id),
            rewards_vault: env.rewards_vault(id),
            rewards_pool: pool_pda(&env.game, s.rewards_pool),
            player_tokens: ata(&who, &s.mint),
            player_rewards: ata(&who, &rewards_mint),
            mint: s.mint,
            rewards_mint: s.rewards_mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
    )
}

fn unstake_ix(env: &Env, who: Pubkey, amount: u64, rewards_mint: Pubkey) -> Instruction {
    staking_ix(env, who, 1, rewards_mint, loot::instruction::Unstake { amount, forfeit: false }.data())
}

fn stake_ix(env: &Env, who: Pubkey, amount: u64, rewards_mint: Pubkey) -> Instruction {
    staking_ix(env, who, 1, rewards_mint, loot::instruction::Stake { amount }.data())
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

/// A stake of the game's coin whose rewards pool (in the coin too) is fed by a weekly
/// schedule that moves all of the revenue pool. One honest staker holds 100.
fn stake_fed_by_a_schedule() -> (Env, Keypair) {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, REVENUE, env.mint).unwrap();
    env.open_pool(&owner, REWARDS, env.mint).unwrap();
    env.open_stake(&owner, 1, env.mint, REWARDS, env.mint, 7 * DAY).unwrap();
    let honest = player(&mut env, 100);
    env.stake(&honest, 1, 100, env.mint).unwrap();

    env.fund(owner.pubkey(), env.mint, 10_000);
    env.deposit(&owner, REVENUE, env.mint, 10_000).unwrap();
    let weekly = ScheduleArgs {
        active: true,
        action: Action::Move { from: REVENUE, to: REWARDS, bps: 10_000 },
        every: 7 * DAY,
        next_at: env.now() + 7 * DAY,
        max_runs: 0,
    };
    env.upsert_schedule(&owner, 1, weekly).unwrap();
    (env, honest)
}

/// `open_stake` records the mint of whatever `rewards_mint` account is passed and never compares
/// it with the pool's. Rewards then sit in the pool for good, and a stake has no edit and no close.
#[test]
fn a_stake_opened_with_a_rewards_mint_that_is_not_the_pools_never_pays_and_cannot_be_fixed() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 3, usd).unwrap();
    env.open_stake(&owner, 2, gold, 3, gold, 0).unwrap(); // pool 3 holds USD; "gold" is a slip
    let p = player(&mut env, 1_000);
    env.stake(&p, 2, 100, gold).unwrap();
    env.fund(owner.pubkey(), usd, 50);
    env.deposit(&owner, 3, usd, 50).unwrap();
    let u: Unstaked = receipt(&env.unstake(&p, 2, 0, gold).unwrap());
    assert_eq!((u.rewards, env.tokens(&pool_pda(&env.game, 3))), (0, 50), "credited to nobody");
    assert!(env.open_stake(&owner, 2, gold, 3, usd, 0).is_err(), "no second chance at this id");
}

/// A top-up relocks the whole position, not the top-up.
#[test]
fn a_top_up_relocks_a_whole_position() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    env.open_pool(&owner, 1, gold).unwrap();
    env.open_stake(&owner, 1, gold, 1, gold, DAY).unwrap();
    let p = player(&mut env, 1_000);
    env.stake(&p, 1, 100, gold).unwrap();
    env.wait(DAY);
    env.unstake(&p, 1, 1, gold).unwrap();
    env.stake(&p, 1, 1, gold).unwrap();
    assert!(err(env.unstake(&p, 1, 1, gold)).contains("StillLocked"), "one coin in, a hundred locked for a day");
    env.wait(DAY);
    env.unstake(&p, 1, 100, gold).unwrap();
}

/// The token programs accept a transfer from an account to itself
/// and move nothing. A staker who named the stake's rewards vault as `player_rewards`, or the
/// staked vault as `player_tokens`, had the rewards or the principal marked paid while the
/// tokens stayed in the vault, where nothing could pay them out again. Now the game paying into
/// the account it pays from is refused (`tokens::transfer`): the mistake costs a failed
/// transaction, and the same unstake with the right accounts pays in full.
#[test]
fn a_staker_who_names_a_vault_as_their_own_account_is_refused() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 3, gold, 0);
    env.open_stake(&owner, 1, gold, 3, gold, 0).unwrap();
    let a = wallet(&mut env, gold, 1_000);
    env.stake(&a, 1, 100, gold).unwrap();
    env.fund(owner.pubkey(), gold, 100);
    env.deposit(&owner, 3, gold, 100).unwrap();

    // The rewards vault named as where the rewards go.
    let mut metas = staking_metas(&env, a.pubkey(), 1);
    metas[8].pubkey = env.rewards_vault(1);
    assert!(err(env.ix(loot::instruction::Unstake { amount: 0, forfeit: false }.data(), metas, &[&a])).contains("SameAccount"));
    // The staked vault named as the player's own account.
    let mut metas = staking_metas(&env, a.pubkey(), 1);
    metas[7].pubkey = env.staked_vault(1);
    assert!(err(env.ix(loot::instruction::Unstake { amount: 100, forfeit: false }.data(), metas, &[&a])).contains("SameAccount"));

    let logs = env.unstake(&a, 1, 100, gold).unwrap();
    assert_eq!((receipt::<Unstaked>(&logs).rewards, receipt::<Unstaked>(&logs).amount), (100, 100));
    assert_eq!(env.tokens(&ata(&a.pubkey(), &gold)), 1_100, "the principal and the rewards arrived");
    assert_eq!((env.tokens(&env.rewards_vault(1)), env.tokens(&env.staked_vault(1))), (0, 0));
}

/// `unstake` pays the rewards owed before it returns the principal,
/// so a rewards vault frozen by its mint's freeze authority (the project, or a third-party
/// issuer) held the principal too. `forfeit` gives up the rewards and lets the principal out.
#[test]
fn a_frozen_rewards_vault_cannot_hold_the_principal() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    // A rewards coin whose freeze authority is its issuer.
    let coin = Keypair::new();
    let rent = env.rent(82);
    env.send(
        &[
            solana_system_interface::instruction::create_account(&owner.pubkey(), &coin.pubkey(), rent, 82, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &coin.pubkey(), &owner.pubkey(), Some(&owner.pubkey()), 6).unwrap(),
        ],
        &[&owner, &coin],
    )
    .unwrap();
    let coin = coin.pubkey();
    pool_with(&mut env, 3, coin, 0);
    env.open_stake(&owner, 1, gold, 3, coin, 0).unwrap();
    let a = wallet(&mut env, gold, 1_000);
    env.token_account(a.pubkey(), coin);
    env.stake(&a, 1, 100, coin).unwrap();
    env.fund(owner.pubkey(), coin, 200);
    env.deposit(&owner, 3, coin, 200).unwrap();

    let freeze = spl_token::instruction::freeze_account(&spl_token::ID, &env.rewards_vault(1), &coin, &owner.pubkey(), &[]).unwrap();
    env.send(&[freeze], &[&owner]).unwrap();
    assert!(env.unstake(&a, 1, 100, coin).is_err(), "the rewards cannot move, and with them the principal");

    let logs = env.unstake_forfeit(&a, 1, 100, coin).unwrap();
    assert_eq!((receipt::<Unstaked>(&logs).amount, receipt::<Unstaked>(&logs).rewards), (100, 0));
    assert_eq!(env.tokens(&ata(&a.pubkey(), &gold)), 1_000, "the principal is back");
    assert_eq!(env.tokens(&ata(&a.pubkey(), &coin)), 0, "the rewards were given up");
    assert!(!env.exists(&env.position_pda(1, &a.pubkey())));
}

/// Substitutions on a stake: the rewards account of the wrong mint (when rewards are owed),
/// another pool or a vault as the rewards pool, another player's token account, another
/// player's position. A position whose address a stranger pre-funded costs the player nothing
/// and the stranger's lamports go to the player when it closes.
#[test]
fn stake_substitutions_are_refused_and_a_prefunded_position_costs_the_stranger() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let usd = env.new_mint(owner.pubkey());
    pool_with(&mut env, 3, usd, 0);
    pool_with(&mut env, 4, usd, 0);
    env.open_stake(&owner, 1, gold, 3, usd, 0).unwrap();
    let (a, b) = (wallet(&mut env, gold, 1_000), wallet(&mut env, gold, 1_000));
    env.token_account(a.pubkey(), usd);
    env.stake(&a, 1, 100, usd).unwrap();
    env.fund(owner.pubkey(), usd, 50);
    env.deposit(&owner, 3, usd, 50).unwrap();

    let unstake = |env: &mut Env, metas: Vec<AccountMeta>| env.ix(loot::instruction::Unstake { amount: 0, forfeit: false }.data(), metas, &[&a]);
    let mut metas = staking_metas(&env, a.pubkey(), 1);
    metas[8].pubkey = ata(&a.pubkey(), &gold);
    assert!(err(unstake(&mut env, metas)).contains("Account not associated with this Mint"));
    for wrong in [pool_pda(&env.game, 4), env.rewards_vault(1), env.staked_vault(1)] {
        let mut metas = staking_metas(&env, a.pubkey(), 1);
        metas[6].pubkey = wrong;
        assert!(err(unstake(&mut env, metas)).contains("WrongPool"));
    }
    let mut metas = staking_metas(&env, a.pubkey(), 1);
    metas[3].pubkey = env.position_pda(1, &b.pubkey());
    assert!(err(unstake(&mut env, metas)).contains("ConstraintSeeds"));
    let mut metas = staking_metas(&env, b.pubkey(), 1);
    metas[7].pubkey = ata(&a.pubkey(), &gold);
    let e = err(env.ix(loot::instruction::Stake { amount: 1 }.data(), metas, &[&b]));
    assert!(e.contains("owner does not match"), "{e}");
    assert_eq!((env.tokens(&pool_pda(&env.game, 3)), env.tokens(&ata(&a.pubkey(), &usd))), (50, 0), "nothing moved");
    env.unstake(&a, 1, 0, usd).unwrap();
    assert_eq!(env.tokens(&ata(&a.pubkey(), &usd)), 50);

    // A stranger pre-funds B's position.
    let stranger = env.cranker.insecure_clone();
    let position = env.position_pda(1, &b.pubkey());
    env.send(&[solana_system_interface::instruction::transfer(&stranger.pubkey(), &position, 1_000_000_000)], &[&stranger]).unwrap();
    env.token_account(b.pubkey(), usd);
    let sol = env.lamports(&b.pubkey());
    env.stake(&b, 1, 100, usd).unwrap();
    assert_eq!(sol - env.lamports(&b.pubkey()), FEE + 5_000, "no rent paid");
    assert_eq!(env.acc::<Position>(&position).amount, 100);
    env.unstake(&b, 1, 100, usd).unwrap();
    assert_eq!(env.lamports(&b.pubkey()) - sol, 1_000_000_000 - 2 * (FEE + 5_000), "the stranger's SOL is B's");
}

/// The lock: a stake and an unstake around a reward in one transaction is stopped, `since` only
/// ever moves to now (a top-up, never an unstake, resets it), and a position closed and opened
/// again is paid from the rewards per token of the moment it reopens: nothing of what landed
/// while the player was out.
#[test]
fn the_lock_holds_and_a_reopened_position_starts_from_now() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 3, gold, 0);
    env.open_stake(&owner, 1, gold, 3, gold, DAY).unwrap();
    let (a, b) = (wallet(&mut env, gold, 2_000), wallet(&mut env, gold, 1_000));
    let reward = |env: &mut Env, amount: u64| {
        env.fund(owner.pubkey(), gold, amount);
        env.deposit(&owner, 3, gold, amount).unwrap();
    };
    env.stake(&a, 1, 100, gold).unwrap();
    let t0 = env.now();
    reward(&mut env, 100);

    // Collect, top up and leave in one transaction: the top-up restarts the lock.
    let ixs = [
        Instruction::new_with_bytes(loot::ID, &loot::instruction::Unstake { amount: 0, forfeit: false }.data(), staking_metas(&env, a.pubkey(), 1)),
        Instruction::new_with_bytes(loot::ID, &loot::instruction::Stake { amount: 900 }.data(), staking_metas(&env, a.pubkey(), 1)),
        Instruction::new_with_bytes(loot::ID, &loot::instruction::Unstake { amount: 1_000, forfeit: false }.data(), staking_metas(&env, a.pubkey(), 1)),
    ];
    assert!(err(env.send(&ixs, &[&a])).contains("StillLocked"));
    assert_eq!(env.acc::<Position>(&env.position_pda(1, &a.pubkey())).amount, 100, "nothing of it happened");

    env.wait(DAY / 2);
    env.unstake(&a, 1, 0, gold).unwrap();
    assert_eq!(env.acc::<Position>(&env.position_pda(1, &a.pubkey())).since, t0, "an unstake leaves `since`");
    env.stake(&a, 1, 1, gold).unwrap();
    assert_eq!(env.acc::<Position>(&env.position_pda(1, &a.pubkey())).since, t0 + DAY / 2, "a top-up moves it to now");
    env.wait(DAY / 2);
    assert!(err(env.unstake(&a, 1, 1, gold)).contains("StillLocked"));
    env.wait(DAY / 2);
    env.unstake(&a, 1, 101, gold).unwrap();
    assert!(!env.exists(&env.position_pda(1, &a.pubkey())));
    assert_eq!(env.tokens(&ata(&a.pubkey(), &gold)), 2_100);

    // B stakes, 300 land, then A comes back: the 300 are B's, and A starts from the new level.
    env.stake(&b, 1, 100, gold).unwrap();
    reward(&mut env, 300);
    let logs = env.stake(&a, 1, 100, gold).unwrap();
    assert_eq!(receipt::<loot::receipts::Staked>(&logs).rewards, 0);
    let position: Position = env.acc(&env.position_pda(1, &a.pubkey()));
    assert_eq!((position.paid_per_token, position.amount), (stake_state(&env, 1).reward_per_token, 100));
    let logs = env.unstake(&a, 1, 0, gold).unwrap();
    assert_eq!(receipt::<Unstaked>(&logs).rewards, 0);
    let logs = env.unstake(&b, 1, 0, gold).unwrap();
    assert_eq!(receipt::<Unstaked>(&logs).rewards, 300);
    reward(&mut env, 100);
    let logs = env.unstake(&a, 1, 0, gold).unwrap();
    assert_eq!(receipt::<Unstaked>(&logs).rewards, 50, "half of what lands from now on");
}

/// The reward sum at its edges: thirty uneven distributions over three stakers pay at most
/// what was credited and leave at most one unit per distribution in the vault; a stake of one
/// token credited the whole supply of a mint (u64::MAX) pays it all; the same again over two
/// stakers pays each their half. Nothing overflows in u128.
#[test]
fn reward_arithmetic_with_a_tiny_total_and_the_largest_credit() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let big = env.new_mint(owner.pubkey());
    pool_with(&mut env, 3, big, 0);
    env.open_stake(&owner, 1, gold, 3, big, 0).unwrap();
    let (a, b, c) = (wallet(&mut env, gold, 10), wallet(&mut env, gold, 10), wallet(&mut env, gold, 10));
    for who in [&a, &b, &c] {
        env.token_account(who.pubkey(), big);
    }
    for (who, amount) in [(&a, 7u64), (&b, 3), (&c, 1)] {
        env.stake(who, 1, amount, big).unwrap();
    }
    let mut credited = 0u64;
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    for _ in 0..30 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let amount = x % 1_000 + 1;
        credited += amount;
        env.fund(owner.pubkey(), big, amount);
        env.deposit(&owner, 3, big, amount).unwrap();
        env.unstake(&a, 1, 0, big).unwrap();
    }
    for who in [&b, &c] {
        env.unstake(who, 1, 0, big).unwrap();
    }
    let paid: u64 = [&a, &b, &c].iter().map(|who| env.tokens(&ata(&who.pubkey(), &big))).sum();
    assert!(paid <= credited && credited - paid <= 30, "credited {credited}, paid {paid}");
    assert_eq!(env.tokens(&env.rewards_vault(1)), credited - paid);

    // A second stake: one token staked, the whole supply of a mint credited.
    let max = env.new_mint(owner.pubkey());
    pool_with(&mut env, 4, max, 0);
    env.open_stake(&owner, 2, gold, 4, max, 0).unwrap();
    env.token_account(a.pubkey(), max);
    env.token_account(b.pubkey(), max);
    env.stake(&a, 2, 1, max).unwrap();
    env.fund(owner.pubkey(), max, u64::MAX);
    env.deposit(&owner, 4, max, u64::MAX).unwrap();
    let logs = env.unstake(&a, 2, 0, max).unwrap();
    assert_eq!((receipt::<Unstaked>(&logs).rewards, env.tokens(&ata(&a.pubkey(), &max)), env.tokens(&env.rewards_vault(2))), (u64::MAX, u64::MAX, 0));
    env.stake(&b, 2, 1, max).unwrap();
    env.deposit(&a, 4, max, u64::MAX).unwrap();
    let half = u64::MAX / 2;
    let logs = env.unstake(&a, 2, 0, max).unwrap();
    assert_eq!(receipt::<Unstaked>(&logs).rewards, half);
    let logs = env.unstake(&b, 2, 0, max).unwrap();
    assert_eq!(receipt::<Unstaked>(&logs).rewards, half);
    assert_eq!(env.tokens(&env.rewards_vault(2)), 1, "the rounding");
    env.unstake(&a, 2, 1, max).unwrap();
    env.unstake(&b, 2, 1, max).unwrap();
    assert_eq!((env.tokens(&env.staked_vault(2)), stake_state(&env, 2).total), (0, 0));
}

#[test]
fn stakers_share_what_flows_into_the_rewards_pool() {
    let mut env = setup();
    let (owner, authority, admin) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.admin.insecure_clone());
    let usd = env.new_mint(owner.pubkey()); // rewards in another currency than the stake
    env.open_pool(&owner, REWARDS, usd).unwrap();
    assert!(err(env.open_stake(&authority, 1, env.mint, REWARDS, usd, DAY)).contains("NotOwner"));
    env.open_stake(&owner, 1, env.mint, REWARDS, usd, DAY).unwrap();
    let (a, b) = (player(&mut env, 1_000), player(&mut env, 1_000));
    let (a_usd, b_usd) = (env.token_account(a.pubkey(), usd), env.token_account(b.pubkey(), usd));
    env.fund(owner.pubkey(), usd, 1_000);
    let reward = |env: &mut Env, amount| env.deposit(&owner, REWARDS, usd, amount).unwrap();

    // A stakes 100. 30 arrive: all A's. B stakes 300. 40 arrive: 10 A's, 30 B's.
    reward(&mut env, 5); // before anyone staked: it waits for the first stakers
    env.stake(&a, 1, 100, usd).unwrap();
    reward(&mut env, 25);
    env.stake(&b, 1, 300, usd).unwrap();
    assert_eq!(env.tokens(&env.staked_vault(1)), 400);
    reward(&mut env, 40);

    let logs = env.unstake(&a, 1, 0, usd).unwrap(); // zero: only collect
    let collected: loot::receipts::Unstaked = receipt(&logs);
    assert_eq!((collected.rewards, collected.staked, env.tokens(&a_usd)), (40, 100, 40));
    env.unstake(&a, 1, 0, usd).unwrap();
    assert_eq!(env.tokens(&a_usd), 40, "paid once");

    // Staked tokens and credited rewards are out of the authority's reach.
    for vault in [env.staked_vault(1), env.rewards_vault(1)] {
        let mut ix = env.payout_ix(authority.pubkey(), REWARDS, a_usd, 1);
        let at = ix.accounts.iter().position(|m| m.pubkey == pool_pda(&env.game, REWARDS)).unwrap();
        ix.accounts[at].pubkey = vault;
        assert!(err(env.send(&[ix], &[&authority])).contains("ConstraintSeeds"));
    }

    // Nothing comes out before the stake's lock has run: a day after the last stake.
    assert!(err(env.unstake(&b, 1, 300, usd)).contains("StillLocked"));
    env.wait(DAY);

    // Suspended and paused: no new stakes, and everyone still gets out with their rewards.
    env.set_suspended(&admin, true).unwrap();
    assert!(err(env.stake(&a, 1, 1, usd)).contains("Suspended"));
    assert!(err(env.unstake(&b, 1, 301, usd)).contains("MoreThanStaked"));
    let sol = env.lamports(&b.pubkey());
    let position = env.position_pda(1, &b.pubkey());
    let rent = env.lamports(&position);
    env.unstake(&b, 1, 300, usd).unwrap();
    assert_eq!((env.tokens(&b_usd), env.tokens(&ata(&b.pubkey(), &env.mint))), (30, 1_000));
    // A position that is empty is closed, and its rent comes back.
    assert!(!env.exists(&position));
    assert_eq!(env.lamports(&b.pubkey()) - sol, rent - FEE - 5_000);
    env.unstake(&a, 1, 100, usd).unwrap();
    assert_eq!((env.tokens(&env.staked_vault(1)), env.tokens(&env.rewards_vault(1))), (0, 0));
}

/// A share of every sale goes to the stakers, by a split and nothing else.
#[test]
fn a_sale_feeds_the_stakers() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, REWARDS, env.mint).unwrap();
    env.open_stake(&owner, 1, env.mint, REWARDS, env.mint, 0).unwrap();
    let staker = player(&mut env, 100);
    env.stake(&staker, 1, 100, env.mint).unwrap();

    env.pay(1_000, vec![pool(REWARDS, 2_500)]).unwrap();
    env.unstake(&staker, 1, 100, env.mint).unwrap();
    assert_eq!(env.tokens(&ata(&staker.pubkey(), &env.mint)), 100 + 250);
}

/// HIGH, fixed. Rewards are credited to whoever is staked at the first stake/unstake after
/// they reach the rewards pool, and anyone decides when they reach it. In one transaction an
/// attacker staked a large borrowed sum, ran the schedule that feeds the pool, and unstaked,
/// taking the week's rewards from the staker who had held all week. A stake now has a lock,
/// set by the owner when it is opened: nothing comes out until it has run since the
/// position's last stake. With a lock as long as the gap between rewards, capital has to sit
/// for a whole period to earn that period's share, which is what staking means.
#[test]
fn a_flash_stake_cannot_leave_with_the_distribution() {
    let (mut env, honest) = stake_fed_by_a_schedule(); // lock: 7 days
    env.wait(7 * DAY);

    let attacker = player(&mut env, 1_000_000);
    let (a, mint) = (attacker.pubkey(), env.mint);
    let ixs = [
        stake_ix(&env, a, 1_000_000, mint),
        run_schedule_ix(&env, 1, pool_pda(&env.game, REVENUE), pool_pda(&env.game, REWARDS)),
        unstake_ix(&env, a, 1_000_000, mint),
    ];
    assert!(err(env.send(&ixs, &[&attacker])).contains("StillLocked"));
    assert_eq!(env.tokens(&ata(&a, &mint)), 1_000_000, "nothing happened");

    // The honest staker runs the schedule and collects the week.
    env.run_schedule(1, pool_pda(&env.game, REVENUE), pool_pda(&env.game, REWARDS)).unwrap();
    let logs = env.unstake(&honest, 1, 100, mint).unwrap();
    assert_eq!(receipt::<loot::receipts::Unstaked>(&logs).rewards, 10_000);
}

/// HIGH against the stated model, fixed. `unstake` read the rewards pool before anything
/// else, so the owner could stop every unstake by closing that pool, or by reopening it in
/// another mint. A pool that is gone, or holds another mint than the one the stake was opened
/// with, now simply brings no rewards.
#[test]
fn closing_or_swapping_the_rewards_pool_stops_no_unstake() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, REWARDS, usd).unwrap();
    env.open_stake(&owner, 1, env.mint, REWARDS, usd, 0).unwrap();
    let a = player(&mut env, 1_000);
    env.token_account(a.pubkey(), usd);
    env.stake(&a, 1, 100, usd).unwrap();

    // 1. The pool is gone.
    env.close_pool(&owner, REWARDS).unwrap();
    env.unstake(&a, 1, 40, usd).unwrap();

    // 2. The pool is back in another mint and holds something.
    let other = env.new_mint(owner.pubkey());
    env.open_pool(&owner, REWARDS, other).unwrap();
    env.fund(owner.pubkey(), other, 1);
    env.deposit(&owner, REWARDS, other, 1).unwrap();
    env.unstake(&a, 1, 60, usd).unwrap();
    assert_eq!(env.tokens(&ata(&a.pubkey(), &env.mint)), 1_000);
    assert_eq!(env.tokens(&pool_pda(&env.game, REWARDS)), 1, "and the other mint was left alone");
}

/// LOW/MEDIUM, noted (`stake.rs` and `lottery.rs` now say so at the top; a setup checker
/// should refuse it before it reaches the chain). A stake takes everything its
/// rewards pool holds each time anyone stakes or unstakes. Nothing stops that pool from also
/// being a lottery's pot (or a box's prize pool, or a converter's stock, or a second stake's
/// rewards pool). Here a holder of one staked coin takes the pot before the winner is paid.
#[test]
fn a_stake_sweeps_a_pot_that_shares_its_pool() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    env.open_stake(&owner, 1, env.mint, 0, env.mint, 0).unwrap();
    let args = LotteryArgs { price: 10, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: 7 * DAY, draws_at: env.now() + 7 * DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();

    let staker = player(&mut env, 1);
    env.stake(&staker, 1, 1, env.mint).unwrap();
    let buyer = player(&mut env, 1_000);
    env.buy_tickets(&buyer, 1, 9, env.mint).unwrap();
    env.wait(7 * DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap();

    env.unstake(&staker, 1, 0, env.mint).unwrap();
    assert_eq!(env.tokens(&ata(&staker.pubkey(), &env.mint)), 90, "the whole pot");
    let logs = env.pay_lottery(1, ata(&buyer.pubkey(), &env.mint)).unwrap();
    let paid: loot::receipts::LotteryPaid = receipt(&logs);
    assert_eq!(paid.amount, 0, "the winner is paid nothing");
}

/// Rewards that are already in the pool when someone stakes go to those who were staked
/// before, and someone with no stake collects nothing.
#[test]
fn a_late_stake_gets_nothing_of_what_had_already_arrived() {
    let (mut env, honest) = stake_fed_by_a_schedule();
    env.wait(7 * DAY);
    env.run_schedule(1, pool_pda(&env.game, REVENUE), pool_pda(&env.game, REWARDS)).unwrap();

    let late = player(&mut env, 1_000_000);
    let mint = env.mint;
    env.stake(&late, 1, 1_000_000, mint).unwrap();
    let logs = env.unstake(&late, 1, 0, mint).unwrap();
    assert_eq!(receipt::<loot::receipts::Unstaked>(&logs).rewards, 0);

    let stranger = player(&mut env, 0);
    let logs = env.unstake(&stranger, 1, 0, mint).unwrap();
    assert_eq!(receipt::<loot::receipts::Unstaked>(&logs).rewards, 0);
    assert!(!env.exists(&env.position_pda(1, &stranger.pubkey())));

    let logs = env.unstake(&honest, 1, 100, mint).unwrap();
    assert_eq!(receipt::<loot::receipts::Unstaked>(&logs).rewards, 10_000);
    assert_eq!(env.tokens(&env.rewards_vault(1)), 0);
}

/// A position at an address someone sent SOL to is still opened; and closing a position and
/// opening it again inside one transaction neither pays twice nor loses the stake.
#[test]
fn a_position_survives_a_prefunded_address_and_a_close_and_reopen() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, REWARDS, env.mint).unwrap();
    env.open_stake(&owner, 1, env.mint, REWARDS, env.mint, 0).unwrap();
    let a = player(&mut env, 1_000);
    let b = player(&mut env, 1_000);
    let (ak, mint) = (a.pubkey(), env.mint);
    let position = env.position_pda(1, &ak);
    env.svm.airdrop(&position, 5_000_000).unwrap();

    env.stake(&a, 1, 100, mint).unwrap();
    env.stake(&b, 1, 100, mint).unwrap();
    env.fund(owner.pubkey(), mint, 200);
    env.deposit(&owner, REWARDS, mint, 200).unwrap();

    // Out, in, out, in: the 100 owed is paid once, the stake ends where it began.
    let ixs = [
        unstake_ix(&env, ak, 100, mint),
        stake_ix(&env, ak, 100, mint),
        unstake_ix(&env, ak, 100, mint),
        stake_ix(&env, ak, 100, mint),
        unstake_ix(&env, ak, 0, mint),
    ];
    env.send(&ixs, &[&a]).unwrap();
    assert_eq!(env.tokens(&ata(&ak, &mint)), 900 + 100);
    let p: loot::Position = env.acc(&position);
    assert_eq!(p.amount, 100);

    // The other staker's half is still there for them, and the vaults add up.
    let logs = env.unstake(&b, 1, 100, mint).unwrap();
    assert_eq!(receipt::<loot::receipts::Unstaked>(&logs).rewards, 100);
    env.unstake(&a, 1, 100, mint).unwrap();
    assert_eq!((env.tokens(&env.staked_vault(1)), env.tokens(&env.rewards_vault(1))), (0, 0));
    assert!(!env.exists(&position), "closed, with the SOL that was parked there");
}
