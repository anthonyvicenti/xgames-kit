//! A game's pools: opening and closing them, deposits, and the authority's payout, burn and issue.
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
    loot::ContestArgs,
    loot::GameUpdate,
    loot::Input,
    loot::LotteryArgs,
    loot::Origin,
    loot::Output,
    loot::RecipeArgs,
    loot::ScheduleArgs,
    loot::receipts::Deposited,
    loot::receipts::Paid,
    loot::state::Share,
    loot::state::To,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const PRIZE: u8 = 0;

fn has_receipt(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

const STAKERS: u8 = 1;

/// A game with a prize pool and a stakers' pool in its own mint.
fn game_with_pools() -> Env {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.open_pool(&owner, STAKERS, env.mint).unwrap();
    env
}

const REVENUE: u8 = 0;

const REWARDS: u8 = 3;

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

fn loot_ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(loot::ID, &data, metas)
}

/// A recipe that burns `take` of one token and gives `give` of another.
fn exchange(take_mint: Pubkey, take: u64, give_mint: Pubkey, give: u64, from: Origin) -> RecipeArgs {
    RecipeArgs {
        active: true,
        inputs: vec![Input::Pay { mint: take_mint, amount: take, to: To::Burn }],
        outputs: vec![Output::Tokens { mint: give_mint, amount: give, from }],
        needs: vec![],
        keeps: vec![],
    }
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

fn contest(env: &Env, shares: Vec<Share>) -> ContestArgs {
    ContestArgs { sides: 2, closes_at: env.now() + 600, result_by: env.now() + 1_200, shares }
}

fn recipe(inputs: Vec<Input>, outputs: Vec<Output>) -> RecipeArgs {
    RecipeArgs { active: true, inputs, outputs, needs: vec![], keeps: vec![] }
}

/// Replaces every meta of `ix` whose key is `old` with `new` (same flags).
fn swap(ix: &mut Instruction, old: Pubkey, new: Pubkey) {
    let mut hit = false;
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == old) {
        meta.pubkey = new;
        hit = true;
    }
    assert!(hit, "the account to replace is not in the instruction");
}

fn version(env: &Env, id: u32) -> u32 {
    env.acc::<loot::Recipe>(&env.mechanic_pda(loot::RECIPE_SEED, id)).version
}

/// `payout`, `burn` and `issue` take the authority's signature and nothing else; the token
/// program refuses a destination or a mint that is not the pool's.
#[test]
fn payout_burn_and_issue_need_the_authority_and_the_right_mint() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let gems = env.new_mint(owner.pubkey());
    let p = env.player.insecure_clone();
    let stranger = player(&mut env, 0);
    env.open_pool(&owner, 0, gold).unwrap();
    env.open_pool(&owner, 1, gems).unwrap();
    env.deposit(&p, 0, gold, 1_000).unwrap();
    let p_gems = env.token_account(p.pubkey(), gems);

    assert!(err(env.payout(&stranger, 0, ata(&p.pubkey(), &gold), 1)).contains("NotAuthority"));
    assert!(err(env.payout(&owner, 0, ata(&p.pubkey(), &gold), 1)).contains("NotAuthority"), "the owner is not the authority");
    assert!(err(env.payout(&authority, 0, p_gems, 1)).contains("custom program error: 0x3"), "a token account of another mint");
    assert!(err(env.payout(&authority, 0, ata(&p.pubkey(), &gold), 0)).contains("ZeroAmount"));
    assert!(err(env.burn_from_pool(&stranger, 0, gold, 1)).contains("NotAuthority"));
    assert!(err(env.burn_from_pool(&authority, 0, gems, 1)).contains("custom program error: 0x3"), "another pool's mint");
    assert!(err(env.issue(&stranger, gold, ata(&p.pubkey(), &gold), 1)).contains("NotAuthority"));
    assert!(err(env.issue(&authority, gold, ata(&p.pubkey(), &gold), 1)).contains("custom program error: 0x4"), "the game is not this mint's authority");
    env.payout(&authority, 0, ata(&p.pubkey(), &gold), 1).unwrap();
    env.burn_from_pool(&authority, 0, gold, 1).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 998);
}

/// `Deposited.amount` was what was sent: with a transfer fee the
/// pool held less than the receipt said. It is now what arrived, like everything the program
/// keeps for itself. `Paid.amount` stays what the player sent, the amount they signed; each
/// place gets its part less the mint's fee, and the receipt says so.
#[test]
fn a_deposit_receipt_names_what_arrived() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let coin = env.new_mint_2022(Some(100), None);
    env.open_pool(&owner, 1, coin).unwrap();
    let sponsor = funded(&mut env);
    env.fund(sponsor.pubkey(), coin, 100_000);
    let logs = env.deposit(&sponsor, 1, coin, 10_000).unwrap();
    assert_eq!(receipt::<Deposited>(&logs).amount, 9_900);
    assert_eq!(env.tokens(&pool_pda(&env.game, 1)), 9_900);
    let ix = env.pay_ix(sponsor.pubkey(), coin, 10_000, vec![pool(1, 10_000)]);
    let logs = env.send(&[ix], &[&sponsor]).unwrap();
    assert_eq!(receipt::<Paid>(&logs).amount, 10_000, "what the player signed");
    assert_eq!(env.tokens(&pool_pda(&env.game, 1)), 19_800);
}

#[test]
fn only_the_owner_opens_and_closes_pools() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let authority = env.authority.insecure_clone();
    let stranger = funded(&mut env);
    let key = pool_pda(&env.game, PRIZE);

    assert!(err(env.open_pool(&stranger, PRIZE, env.mint)).contains("NotOwner"));
    assert!(err(env.open_pool(&authority, PRIZE, env.mint)).contains("NotOwner"));

    // Lamports someone parked at the address do not block the owner.
    env.svm.airdrop(&key, 1_000).unwrap();
    let before = env.lamports(&owner.pubkey());
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    assert_eq!(env.data(&key).len(), 165);
    assert_eq!(env.lamports(&key), env.rent(165));
    assert_eq!(before - env.lamports(&owner.pubkey()), env.rent(165) - 1_000 + 5_000);
    // The pool is the game's: its token authority is the game's own address.
    assert_eq!(env.data(&key)[32..64], env.game.to_bytes());
    assert!(env.open_pool(&owner, PRIZE, env.mint).is_err(), "a pool opens once");

    // A pool that holds something cannot be closed. An empty one returns its rent.
    env.deposit(&owner, PRIZE, env.mint, 0).unwrap_err();
    let from = env.fund(owner.pubkey(), env.mint, 50);
    assert_eq!(env.tokens(&from), 50);
    env.deposit(&owner, PRIZE, env.mint, 50).unwrap();
    assert!(err(env.close_pool(&owner, PRIZE)).contains("PoolNotEmpty"));
    env.payout(&authority, PRIZE, from, 50).unwrap();
    assert!(err(env.close_pool(&stranger, PRIZE)).contains("NotOwner"));
    let before = env.lamports(&owner.pubkey());
    env.close_pool(&owner, PRIZE).unwrap();
    assert!(!env.exists(&key));
    assert_eq!(env.lamports(&owner.pubkey()) - before, env.rent(165) - 5_000);
}

#[test]
fn anyone_deposits_and_a_suspended_game_still_takes_it() {
    let mut env = game_with_pools();
    let admin = env.admin.insecure_clone();
    let sponsor = funded(&mut env);
    env.fund(sponsor.pubkey(), env.mint, 40 * PRICE);

    env.set_suspended(&admin, true).unwrap();
    let logs = env.deposit(&sponsor, PRIZE, env.mint, 40 * PRICE).unwrap();
    assert!(has_receipt(&logs));
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), 40 * PRICE);
    assert_eq!(env.fees(), FEE);
}

#[test]
fn only_the_authority_pays_out_and_nothing_bounds_it() {
    let mut env = game_with_pools();
    let owner = env.creator.insecure_clone();
    let authority = env.authority.insecure_clone();
    let admin = env.admin.insecure_clone();
    let player = env.player.insecure_clone();
    let winner = env.token_account(Keypair::new().pubkey(), env.mint);
    env.pay(10 * PRICE, vec![pool(PRIZE, 10_000)]).unwrap();

    // Not the owner, not the player, not the platform, not a stranger.
    for who in [&owner, &player, &admin, &funded(&mut env)] {
        assert!(err(env.payout(who, PRIZE, winner, 1)).contains("NotAuthority"));
    }
    assert!(err(env.payout(&authority, PRIZE, winner, 0)).contains("ZeroAmount"));
    // More than the pool holds: the token program refuses.
    assert!(env.payout(&authority, PRIZE, winner, 10 * PRICE + 1).is_err());

    // Paused by the owner and suspended by the platform: what is owed still goes out.
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    env.set_suspended(&admin, true).unwrap();
    env.payout(&authority, PRIZE, winner, 3 * PRICE).unwrap();
    // No cap: the rest in one go.
    env.payout(&authority, PRIZE, winner, 7 * PRICE).unwrap();
    assert_eq!(env.tokens(&winner), 10 * PRICE);
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), 0);
}

/// A payout can only come from a pool. The vault, where the payments of open orders wait, is
/// the game's too, and the authority cannot reach it.
#[test]
fn the_authority_cannot_reach_the_order_vault() {
    let mut env = game_with_pools();
    let authority = env.authority.insecure_clone();
    env.buy(3, 1).unwrap();
    let vault = ata(&env.game, &env.mint);
    assert_eq!(env.tokens(&vault), PRICE / 2);

    let to = ata(&env.player.pubkey(), &env.mint);
    let mut ix = env.payout_ix(authority.pubkey(), PRIZE, to, 1);
    let at = ix.accounts.iter().position(|m| m.pubkey == pool_pda(&env.game, PRIZE)).unwrap();
    ix.accounts[at].pubkey = vault;
    assert!(err(env.send(&[ix], &[&authority])).contains("ConstraintSeeds"));
    assert_eq!(env.tokens(&vault), PRICE / 2);
}

#[test]
fn the_authority_issues_a_token_the_game_controls() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let owner = env.creator.insecure_clone();
    let player_wallet = env.player.pubkey();

    // A soft currency whose mint authority is the game's address.
    let points = env.new_mint(env.game);
    let to = env.token_account(player_wallet, points);
    let logs = env.issue(&authority, points, to, 250).unwrap();
    assert!(has_receipt(&logs));
    assert_eq!((env.tokens(&to), env.supply(&points)), (250, 250));
    assert_eq!(env.fees(), FEE);

    assert!(err(env.issue(&owner, points, to, 1)).contains("NotAuthority"));
    assert!(err(env.issue(&authority, points, to, 0)).contains("ZeroAmount"));
    // The shop's mint belongs to its creator, not to the game: the token program refuses.
    let player_token = ata(&player_wallet, &env.mint);
    assert!(env.issue(&authority, env.mint, player_token, 1).is_err());
}

/// A split is the player's to sign, so a careless or hostile one must not reach anywhere but
/// this game.
#[test]
fn a_pool_of_another_game_is_not_a_pool_of_this_one() {
    let mut env = game_with_pools();
    let p = env.player.insecure_clone();
    // A second game, with its own pool 0.
    let other_owner = funded(&mut env);
    let collection = Keypair::new();
    let other_game = pda(&[loot::GAME_SEED, collection.pubkey().as_ref()]);
    let ix = mpl_core::instructions::CreateCollectionV2Builder::new()
        .collection(collection.pubkey())
        .update_authority(Some(other_owner.pubkey()))
        .payer(other_owner.pubkey())
        .name("Other".into())
        .uri("https://example.invalid/other.json".into())
        .instruction();
    env.send(&[ix], &[&other_owner, &collection]).unwrap();
    let treasury = env.token_account(other_owner.pubkey(), env.mint);
    let (mine, mine_collection) = (env.game, env.collection);
    (env.game, env.collection, env.treasury) = (other_game, collection.pubkey(), treasury);
    let saved = std::mem::replace(&mut env.creator, other_owner.insecure_clone());
    env.create_game().unwrap();
    env.open_pool(&other_owner, PRIZE, env.mint).unwrap();
    env.creator = saved;
    (env.game, env.collection) = (mine, mine_collection);
    env.treasury = ata(&env.creator.pubkey(), &env.mint);

    let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![pool(PRIZE, 5_000)]);
    ix.accounts.last_mut().unwrap().pubkey = pool_pda(&other_game, PRIZE);
    assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
}

#[test]
fn the_authority_burns_from_a_pool() {
    let mut env = game_with_pools();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    env.pay(10 * PRICE, vec![pool(PRIZE, 10_000)]).unwrap();
    let supply = env.supply(&env.mint);
    let fees = env.fees();

    assert!(err(env.burn_from_pool(&owner, PRIZE, env.mint, 1)).contains("NotAuthority"));
    assert!(err(env.burn_from_pool(&authority, PRIZE, env.mint, 0)).contains("ZeroAmount"));
    assert!(env.burn_from_pool(&authority, PRIZE, env.mint, 10 * PRICE + 1).is_err(), "more than the pool holds");

    let logs = env.burn_from_pool(&authority, PRIZE, env.mint, 4 * PRICE).unwrap();
    let burned: loot::receipts::Burned = receipt(&logs);
    assert_eq!((burned.pool, burned.mint, burned.amount, burned.reference), (PRIZE, env.mint, 4 * PRICE, REF));
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), 6 * PRICE);
    assert_eq!(supply - env.supply(&env.mint), 4 * PRICE);
    assert_eq!(env.fees() - fees, FEE);
}

/// The token program closes a wrapped-SOL account with its whole
/// balance, so `close_pool` emptied a wrapped-SOL pool to the owner with no payout and no
/// receipt. `close_pool` now refuses a pool that holds anything.
#[test]
fn close_pool_refuses_a_wrapped_sol_pool_that_holds_sol() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    // The native mint, as it is on every cluster: 9 decimals, no authorities.
    let mut mint = vec![0u8; 82];
    mint[44] = 9;
    mint[45] = 1;
    env.put(spl_token::native_mint::ID, spl_token::ID, mint);
    env.open_pool(&owner, 9, spl_token::native_mint::ID).unwrap();
    let pool = pool_pda(&env.game, 9);
    env.svm.airdrop(&pool, 2_000_000_000).unwrap();
    let c = env.cranker.insecure_clone();
    env.send(&[spl_token::instruction::sync_native(&spl_token::ID, &pool).unwrap()], &[&c]).unwrap();

    assert!(err(env.close_pool(&owner, 9)).contains("PoolNotEmpty"));
    assert_eq!(env.tokens(&pool), 2_000_000_000);
}

/// The mechanics name pools by index and take nothing else in a pool's place: not the order
/// vault, not a stake's vaults.
#[test]
fn no_mechanic_takes_a_vault_for_a_pool() {
    let (mut env, _) = stake_fed_by_a_schedule();
    let owner = env.creator.insecure_clone();
    let (staked, rewards, vault) = (env.staked_vault(1), env.rewards_vault(1), ata(&env.game, &env.mint));
    let c = env.cranker.insecure_clone();
    env.wait(7 * DAY);

    // A schedule.
    for from in [staked, rewards, vault] {
        let ix = run_schedule_ix(&env, 1, from, pool_pda(&env.game, REWARDS));
        assert!(err(env.send(&[ix], &[&c])).contains("WrongPool"));
    }

    // An exchange (a recipe of tokens) that pays from the revenue pool.
    let junk = env.new_mint(owner.pubkey());
    let p = wallet(&mut env, junk, 10);
    env.token_account(p.pubkey(), env.mint);
    env.upsert_recipe(&owner, 1, exchange(junk, 1, env.mint, 1, Origin::Pool(REVENUE))).unwrap();
    for from in [staked, rewards, vault] {
        let (mut ix, _) = env.craft_ix(p.pubkey(), 1, 0, &[]);
        let at = ix.accounts.iter().position(|m| m.pubkey == pool_pda(&env.game, REVENUE)).unwrap();
        ix.accounts[at].pubkey = from;
        assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    }

    // A lottery's pot.
    let buyer = player(&mut env, 100);
    let args = LotteryArgs { price: 10, pot: REVENUE, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY };
    env.upsert_lottery(&owner, 1, args).unwrap();
    env.buy_tickets(&buyer, 1, 1, env.mint).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(0)).unwrap();
    for from in [staked, rewards, vault] {
        let ix = loot_ix(
            loot::instruction::PayLottery { place: 0 }.data(),
            loot::accounts::PayLottery {
                game: env.game,
                lottery: env.mechanic_pda(loot::LOTTERY_SEED, 1),
                first_place: buyer.pubkey(),
                pot: from,
                to: ata(&buyer.pubkey(), &env.mint),
                mint: env.mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
            }
            .to_account_metas(None),
        );
        assert!(err(env.send(&[ix], &[&c])).contains("WrongPool"));
    }
    assert_eq!(env.tokens(&staked), 100);
}

/// The authority's `payout` and `burn`, and a recipe's pool output, name a pool by its index:
/// a contest's pot or the order vault put in the pool's place is refused.
#[test]
fn no_pool_instruction_reaches_a_contests_pot_or_the_order_vault() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let funder = player(&mut env, 500);
    env.deposit(&funder, 0, gold, 100).unwrap();
    let a = player(&mut env, 100);
    let args = contest(&env, vec![]);
    env.open_contest(&authority, 1, gold, args).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.buy(3, 1).unwrap(); // an open order: its payment is in the vault
    let (pot, vault, pool) = (env.pot_pda(1), ata(&env.game, &gold), pool_pda(&env.game, 0));
    let to = env.token_account(authority.pubkey(), gold);

    for target in [pot, vault] {
        let mut ix = env.payout_ix(authority.pubkey(), 0, to, 50);
        swap(&mut ix, pool, target);
        assert!(err(env.send(&[ix], &[&authority])).contains("ConstraintSeeds"));
    }

    env.upsert_recipe(&owner, 1, recipe(vec![], vec![Output::Tokens { mint: gold, amount: 50, from: Origin::Pool(0) }])).unwrap();
    for target in [pot, vault] {
        let (mut ix, _) = env.craft_ix(a.pubkey(), 1, version(&env, 1), &[]);
        swap(&mut ix, pool, target);
        assert!(err(env.send(&[ix], &[&a])).contains("WrongPool"));
    }
    assert_eq!((env.tokens(&pot), env.tokens(&vault)), (100, PRICE / 2));
}
