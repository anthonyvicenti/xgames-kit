//! `pay` and the split: shares to pools, accounts, holders and the treasury.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    anchor_spl::token::spl_token,
    common::*,
    loot::BoxArgs,
    loot::ContestArgs,
    loot::GameUpdate,
    loot::ItemArgs,
    loot::LotteryArgs,
    loot::Verdict,
    loot::receipts::Paid,
    loot::state::DropEntry,
    loot::state::ItemKind,
    loot::state::Outcome,
    loot::state::Share,
    loot::state::To,
    mpl_core::instructions::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// A Core asset in no collection at all, made by a stranger and owned by `owner`.
fn foreign_asset(env: &mut Env, owner: Pubkey) -> Pubkey {
    let payer = funded(env);
    let asset = Keypair::new();
    let ix = mpl_core::instructions::CreateV2Builder::new()
        .asset(asset.pubkey())
        .payer(payer.pubkey())
        .owner(Some(owner))
        .name("Foreign".into())
        .uri("https://example.invalid/foreign.json".into())
        .instruction();
    env.send(&[ix], &[&payer, &asset]).unwrap();
    asset.pubkey()
}

fn nothing() -> DropEntry {
    DropEntry { outcome: Outcome::Nothing, weight: 1 }
}

fn box_args(price: u64, currency: Option<Pubkey>, shares: Vec<Share>, entries: Vec<DropEntry>) -> BoxArgs {
    BoxArgs { price, currency, rise: None, fall: None, stock_odds: false, active: true, shares, entries }
}

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

fn balance_of(env: &Env, who: &Keypair, mint: &Pubkey) -> u64 {
    env.tokens(&ata(&who.pubkey(), mint))
}

fn has_receipt(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

const STAKERS: u8 = 1;

const PRIZE: u8 = 0;

/// A game with a prize pool and a stakers' pool in its own mint.
fn game_with_pools() -> Env {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.open_pool(&owner, STAKERS, env.mint).unwrap();
    env
}

/// A wrapped SOL mint and a funded wrapped SOL account for `who`.
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

/// The shares a player chooses in `pay` only move the player's own tokens. Routing a share
/// into the game's vault parks tokens nobody can take out (not through an order: settle and
/// refund move exactly `order.paid`); a pool in another mint is refused by the token program;
/// a `Holder` share pays whoever holds any Core asset the player names, in or out of the
/// game's collection (`rail::deliver` never checks the collection), which is fine here because
/// it is the player's money and the receipt names the asset.
#[test]
fn pay_player_chosen_shares_cannot_take_what_is_not_theirs() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.insecure_clone();
    let gold = env.mint;
    let vault = ata(&env.game, &gold);
    env.token_account(env.game, gold);

    // 1. A share into the vault: accepted, and stuck there.
    let ix = env.pay_ix(p.pubkey(), gold, 1_000, vec![Share { to: To::Account(vault), bps: 10_000 }]);
    env.send(&[ix], &[&p]).unwrap();
    assert_eq!(env.tokens(&vault), 1_000);
    // An order then settles for exactly what it paid; the surplus stays.
    let order = order_pda(&env.game, &p.pubkey(), 1);
    env.buy(3, 1).unwrap();
    assert_eq!(env.tokens(&vault), 1_000 + PRICE / 2);
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.tokens(&vault), 1_000, "settle moved only the order's `paid`");
    // And a refund too.
    let order = order_pda(&env.game, &p.pubkey(), 2);
    env.buy(3, 2).unwrap();
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(order).unwrap();
    assert_eq!(env.tokens(&vault), 1_000, "refund moved only the order's `paid`");

    // 2. A pool in another mint: the token program refuses.
    let other = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 5, other).unwrap();
    let ix = env.pay_ix(p.pubkey(), gold, 1_000, vec![pool(5, 10_000)]);
    let e = err(env.send(&[ix], &[&p]));
    assert!(e.contains("Account not associated with this Mint"), "{e}");
    assert_eq!(env.tokens(&pool_pda(&env.game, 5)), 0);

    // 3. A holder share for a Core asset outside the game's collection: paid to its holder.
    let holder = funded(&mut env);
    let asset = foreign_asset(&mut env, holder.pubkey());
    env.token_account(holder.pubkey(), gold);
    let ix = env.pay_ix(p.pubkey(), gold, 1_000, vec![Share { to: To::Holder(asset), bps: 10_000 }]);
    let logs = env.send(&[ix], &[&p]).unwrap();
    assert_eq!(env.tokens(&ata(&holder.pubkey(), &gold)), 1_000);
    let paid: Paid = receipt(&logs);
    assert_eq!(paid.shares, vec![Share { to: To::Holder(asset), bps: 10_000 }]);
    // The holder's account has to be of the mint paid, whoever passes it.
    env.token_account(holder.pubkey(), other);
    let mut ix = env.pay_ix(p.pubkey(), gold, 1_000, vec![Share { to: To::Holder(asset), bps: 10_000 }]);
    ix.accounts.last_mut().unwrap().pubkey = ata(&holder.pubkey(), &other);
    assert!(err(env.send(&[ix], &[&p])).contains("NotTheHolders"));
    // And it has to be the holder's, not the payer's own.
    let mut ix = env.pay_ix(p.pubkey(), gold, 1_000, vec![Share { to: To::Holder(asset), bps: 10_000 }]);
    ix.accounts.last_mut().unwrap().pubkey = ata(&p.pubkey(), &gold);
    assert!(err(env.send(&[ix], &[&p])).contains("NotTheHolders"));
}

/// A box share names a partner's associated account. The partner closes it: every settle that
/// pays it fails (the order waits for its 7-day refund), until anyone re-creates the associated
/// account, which can only belong to the partner again, and the settle goes through. A share
/// that names a non-associated account its owner closed stays stuck until the owner edits the
/// box (third review, "still true").
#[test]
fn a_closed_account_share_is_recreated_by_anyone_for_its_owner_only() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let gold = env.mint;
    let partner = funded(&mut env);
    let partner_gold = env.token_account(partner.pubkey(), gold);
    let shares = vec![Share { to: To::Account(partner_gold), bps: 5_000 }];
    env.upsert_box_args(9, box_args(10_000, None, shares, vec![nothing()])).unwrap();
    env.open_box(9, 1).unwrap();
    let order = order_pda(&env.game, &p, 1);
    env.callback_of(9, order, rnd(0)).unwrap();

    let close = anchor_spl::token::spl_token::instruction::close_account(&anchor_spl::token::spl_token::ID, &partner_gold, &partner.pubkey(), &partner.pubkey(), &[]).unwrap();
    env.send(&[close], &[&partner]).unwrap();
    assert!(!env.exists(&partner_gold));
    let e = err(env.settle_prize(order, None, &keeper));
    assert!(e.contains("AccountNotInitialized") || e.contains("InvalidAccountData") || e.contains("Error"), "{e}");
    // A stranger cannot put an account of their own at that address; re-creating the
    // associated account gives it back to the partner.
    env.token_account(partner.pubkey(), gold);
    env.settle_prize(order, None, &keeper).unwrap();
    assert_eq!((env.tokens(&partner_gold), env.tokens(&env.treasury)), (5_000, 5_000));
}

/// A farming game: a partner takes 10% of every payment, and whoever holds the plot takes 20%.
#[test]
fn a_share_pays_an_account_or_whoever_holds_a_collectible() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let partner = env.token_account(Keypair::new().pubkey(), gold);
    let landlord = player(&mut env, 0);
    let buyer = player(&mut env, 0);
    env.upsert_item(50, collectible("Plot")).unwrap();
    let plot = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let shares = vec![Share { to: To::Account(partner), bps: 1_000 }, Share { to: To::Holder(plot), bps: 2_000 }, burn(1_000)];

    let treasury = env.tokens(&env.treasury);
    env.pay(1_000, shares.clone()).unwrap();
    assert_eq!((env.tokens(&partner), balance_of(&env, &landlord, &gold), env.tokens(&env.treasury) - treasury), (100, 200, 600));

    // A sale from the shop pays the plot's holder too, when it settles.
    env.upsert_item(51, ItemArgs { shares: vec![Share { to: To::Holder(plot), bps: 5_000 }], ..item(ItemKind::Collectible, "Crop", 0, 1_000) }).unwrap();
    env.buy(51, 1).unwrap();
    let c = env.cranker.insecure_clone();
    env.settle(order_pda(&env.game, &env.player.pubkey(), 1), &c).unwrap();
    assert_eq!(balance_of(&env, &landlord, &gold), 700);

    // The share must go to the holder: nobody who sends a transaction can point it elsewhere.
    let p = env.player.insecure_clone();
    let mut ix = env.pay_ix(p.pubkey(), gold, 1_000, shares.clone());
    let last = ix.accounts.len() - 1;
    ix.accounts[last] = AccountMeta::new(partner, false);
    assert!(err(env.send(&[ix], &[&p])).contains("NotTheHolders"));

    // The plot is sold on: the share follows it.
    let sell = mpl_core::instructions::TransferV1Builder::new()
        .asset(plot)
        .collection(Some(env.collection))
        .payer(landlord.pubkey())
        .new_owner(buyer.pubkey())
        .instruction();
    env.send(&[sell], &[&landlord]).unwrap();
    env.pay(1_000, shares.clone()).unwrap();
    assert_eq!((balance_of(&env, &landlord, &gold), balance_of(&env, &buyer, &gold)), (700, 200));

    // The plot is burned: nobody holds it, and its share is burned with the 10% that always is.
    let burn_it = mpl_core::instructions::BurnV1Builder::new()
        .asset(plot)
        .collection(Some(env.collection))
        .payer(buyer.pubkey())
        .instruction();
    env.send(&[burn_it], &[&buyer]).unwrap();
    let (treasury, supply) = (env.tokens(&env.treasury), env.supply(&gold));
    env.pay(1_000, shares).unwrap();
    assert_eq!((balance_of(&env, &buyer, &gold), env.tokens(&env.treasury) - treasury, supply - env.supply(&gold)), (200, 600, 300));
}

/// The design's level game: pay to try, the entry feeds a prize pool, the final level pays it.
#[test]
fn pay_to_enter_then_the_authority_pays_the_prize() {
    let mut env = game_with_pools();
    let player = env.player.pubkey();
    let player_token = ata(&player, &env.mint);
    let (prize, stakers) = (pool_pda(&env.game, PRIZE), pool_pda(&env.game, STAKERS));
    let had = env.tokens(&player_token);
    let supply = env.supply(&env.mint);
    let sol = env.lamports(&player);

    // An attempt costs 5 coins: 70% to the prize, 10% to stakers, 5% burned, the rest (15%) to
    // the owner's treasury.
    let entry = 5 * PRICE;
    let logs = env.pay(entry, vec![pool(PRIZE, 7_000), pool(STAKERS, 1_000), burn(500)]).unwrap();
    assert!(has_receipt(&logs));
    assert_eq!(env.tokens(&player_token), had - entry);
    assert_eq!(env.tokens(&prize), entry * 70 / 100);
    assert_eq!(env.tokens(&stakers), entry * 10 / 100);
    assert_eq!(env.supply(&env.mint), supply - entry * 5 / 100);
    assert_eq!(env.tokens(&env.treasury), entry * 15 / 100);
    // The platform took its flat fee in SOL, and nothing of the payment.
    assert_eq!(env.fees(), FEE);
    assert_eq!(env.lamports(&player), sol - FEE - 5_000);

    // The player clears the final level; the game's authority pays the whole prize.
    let authority = env.authority.insecure_clone();
    let logs = env.payout(&authority, PRIZE, player_token, entry * 70 / 100).unwrap();
    assert!(has_receipt(&logs));
    assert_eq!(env.tokens(&prize), 0);
    assert_eq!(env.tokens(&player_token), had - entry + entry * 70 / 100);
    assert_eq!(env.fees(), 2 * FEE);
}

#[test]
fn a_split_with_nothing_named_all_goes_to_the_treasury() {
    let mut env = setup();
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(env.tokens(&env.treasury), PRICE);
}

#[test]
fn shares_round_down_and_the_treasury_gets_every_unit_left() {
    let mut env = game_with_pools();
    let supply = env.supply(&env.mint);
    // 7 units at 33.33% each: two shares of 2, and 3 left over.
    env.pay(7, vec![pool(PRIZE, 3_333), burn(3_333)]).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), 2);
    assert_eq!(supply - env.supply(&env.mint), 2);
    assert_eq!(env.tokens(&env.treasury), 3);
}

#[test]
fn pay_refuses_what_it_should() {
    let mut env = game_with_pools();
    let p = env.player.insecure_clone();
    let owner = env.creator.insecure_clone();

    assert!(err(env.pay(0, vec![])).contains("ZeroAmount"));
    assert!(err(env.pay(PRICE, vec![burn(6_000), pool(PRIZE, 4_001)])).contains("BadShares"));
    assert!(err(env.pay(PRICE, vec![burn(1); 5])).contains("BadShares"));

    // A share that names a pool must come with that pool's own account.
    let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![pool(PRIZE, 5_000)]);
    ix.accounts.pop();
    assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    for wrong in [pool_pda(&env.game, STAKERS), ata(&env.game, &env.mint), env.treasury, ata(&p.pubkey(), &env.mint)] {
        let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![pool(PRIZE, 5_000)]);
        ix.accounts.last_mut().unwrap().pubkey = wrong;
        assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    }
    // A pool that was never opened.
    assert!(env.pay(PRICE, vec![pool(9, 5_000)]).is_err());

    // The treasury is the game's, by address, and the receipt names the mint that moved.
    let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![]);
    ix.accounts[4].pubkey = ata(&p.pubkey(), &env.mint);
    assert!(err(env.send(&[ix], &[&p])).contains("ConstraintAddress"));
    let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![]);
    ix.accounts[2].pubkey = env.collection;
    assert!(err(env.send(&[ix], &[&p])).contains("ConstraintTokenMint"));

    // The owner's switch.
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    assert!(err(env.pay(PRICE, vec![])).contains("Paused"));

    // Nothing above moved a coin or paid a fee.
    assert_eq!(env.tokens(&env.treasury), 0);
    assert_eq!(env.fees(), 0);
}

/// An entry fee in another currency than the shop's, all of it into a pool of that currency.
#[test]
fn pay_in_another_mint_when_the_shares_take_all_of_it() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let p = env.player.insecure_clone();
    let usdc = env.new_mint(owner.pubkey());
    env.fund(p.pubkey(), usdc, 100 * PRICE);
    env.open_pool(&owner, 7, usdc).unwrap();

    let ix = env.pay_ix(p.pubkey(), usdc, 10 * PRICE, vec![pool(7, 10_000)]);
    env.send(&[ix], &[&p]).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 7)), 10 * PRICE);

    // Shares that take all of it leave nothing to rounding either.
    env.open_pool(&owner, 8, usdc).unwrap();
    let ix = env.pay_ix(p.pubkey(), usdc, 7, vec![pool(7, 5_000), pool(8, 5_000)]);
    env.send(&[ix], &[&p]).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 8)), 4);

    // Anything left over would have to go to the treasury, which holds the game's own mint.
    let ix = env.pay_ix(p.pubkey(), usdc, 10 * PRICE, vec![pool(7, 9_000)]);
    assert!(env.send(&[ix], &[&p]).is_err());
    // And a pool only takes its own mint.
    assert!(env.pay(PRICE, vec![pool(7, 5_000)]).is_err());
}

/// `Paid.mint` was whatever account the payer passed unless the split
/// had a burn share. `pay` now checks it against the token account the payment comes from.
/// Still true, and harmless: the treasury's holder can "pay" the treasury from the treasury.
/// Nothing moves, and the receipt names that holder as the player.
#[test]
fn the_paid_receipt_names_the_mint_that_moved() {
    let mut env = setup();
    let (owner, p) = (env.creator.insecure_clone(), env.player.insecure_clone());
    let usdc = env.new_mint(owner.pubkey());
    for wrong in [usdc, env.cranker.pubkey()] {
        let mut ix = env.pay_ix(p.pubkey(), env.mint, PRICE, vec![]);
        ix.accounts[2].pubkey = wrong;
        assert!(err(env.send(&[ix], &[&p])).contains("ConstraintTokenMint"));
    }
    let logs = env.pay(5 * PRICE, vec![]).unwrap();
    let paid: loot::receipts::Paid = receipt(&logs);
    assert_eq!((paid.mint, paid.amount, paid.to_treasury), (env.mint, 5 * PRICE, 5 * PRICE));
}

/// A payment in another mint failed whenever its split rounded, because
/// the leftover unit went to the treasury, which holds the game's mint. When the shares take
/// the whole payment, the last share now takes the rounding too.
#[test]
fn pay_in_another_mint_works_when_the_split_rounds() {
    let mut env = setup();
    let (owner, p) = (env.creator.insecure_clone(), env.player.insecure_clone());
    let usdc = env.new_mint(owner.pubkey());
    env.fund(p.pubkey(), usdc, 100 * PRICE);
    env.open_pool(&owner, 7, usdc).unwrap();
    env.open_pool(&owner, 8, usdc).unwrap();

    let ix = env.pay_ix(p.pubkey(), usdc, 10 * PRICE + 1, vec![pool(7, 5_000), pool(8, 5_000)]);
    env.send(&[ix], &[&p]).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 7)), 5 * PRICE);
    assert_eq!(env.tokens(&pool_pda(&env.game, 8)), 5 * PRICE + 1);
}

/// The vault and the pools are the game's, and no instruction lets a signer who is not the
/// game spend from them by naming them as the paying account.
#[test]
fn nobody_pays_with_the_games_own_accounts() {
    let mut env = setup();
    let (owner, authority, p) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.player.insecure_clone());
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.open_pool(&owner, 1, env.mint).unwrap();
    env.pay(4 * PRICE, vec![pool(PRIZE, 10_000)]).unwrap();
    env.buy(3, 1).unwrap();
    let (vault, prize) = (ata(&env.game, &env.mint), pool_pda(&env.game, PRIZE));
    let player_token = ata(&p.pubkey(), &env.mint);

    for (who, from) in [(&p, vault), (&p, prize), (&authority, vault), (&authority, prize), (&owner, vault), (&owner, prize)] {
        // pay, from the vault or a pool, into the treasury.
        let mut ix = env.pay_ix(who.pubkey(), env.mint, PRICE / 2, vec![]);
        ix.accounts[3].pubkey = from;
        assert!(env.send(&[ix], &[who]).is_err());
        // deposit, from the vault or a pool, into pool 1.
        let ix = Instruction::new_with_bytes(
            loot::ID,
            &anchor_lang::InstructionData::data(&loot::instruction::Deposit { index: 1, amount: PRICE / 2 }),
            anchor_lang::ToAccountMetas::to_account_metas(
                &loot::accounts::Deposit {
                    depositor: who.pubkey(),
                    game: env.game,
                    pool: pool_pda(&env.game, 1),
                    from,
                    mint: env.mint,
                    token_program: spl_token::ID,
                    token_2022_program: loot::tokens::TOKEN_2022_ID,
                    fee: env.fee(),
                },
                None,
            ),
        );
        assert!(env.send(&[ix], &[who]).is_err());
    }
    // buy_item, paid for out of the vault.
    let mut ix = env.buy_ix(3, 2);
    let at = ix.accounts.iter().position(|m| m.pubkey == player_token).unwrap();
    ix.accounts[at].pubkey = vault;
    assert!(env.send(&[ix], &[&p]).is_err());

    assert_eq!((env.tokens(&vault), env.tokens(&prize)), (PRICE / 2, 4 * PRICE));
}

/// MEDIUM, fixed. A `Holder` share nobody could take fell to the treasury, which only holds the
/// game's mint, so the holder of a named collectible could stop every settle of a box in
/// another mint by handing the collectible to the game. Now a share nobody holds is burned, in
/// the mint it was paid in.
#[test]
fn a_share_nobody_holds_is_burned_and_stops_no_settle() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gems = env.new_mint(owner.pubkey());
    let landlord = player(&mut env, 0);
    env.token_account(landlord.pubkey(), gems);
    env.fund(env.player.pubkey(), gems, 100);
    env.upsert_item(50, collectible("Plot")).unwrap();
    let plot = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let entries = vec![DropEntry { outcome: Outcome::Nothing, weight: 1 }];
    let shares = vec![burn(5_000), Share { to: To::Holder(plot), bps: 5_000 }];
    env.upsert_box_args(5, BoxArgs { price: 10, currency: Some(gems), rise: None, fall: None, stock_odds: false, active: true, shares, entries }).unwrap();

    for nonce in [1, 2] {
        env.open_box(5, nonce).unwrap();
        env.callback_of(5, order_pda(&env.game, &env.player.pubkey(), nonce), rnd(0)).unwrap();
    }
    env.hold(&landlord, plot, 3_600).unwrap();
    env.settle_prize(order_pda(&env.game, &env.player.pubkey(), 1), None, &c).unwrap();
    assert_eq!((balance_of(&env, &landlord, &gems), env.supply(&gems)), (0, 90), "all 10 burned: the landlord's half too");

    env.wait(3_600);
    env.take_back(&c, plot).unwrap();
    env.settle_prize(order_pda(&env.game, &env.player.pubkey(), 2), None, &c).unwrap();
    assert_eq!((balance_of(&env, &landlord, &gems), env.supply(&gems)), (5, 85));
}

/// MEDIUM, fixed. The third review's finding 6 was closed by burning a `Holder` share nobody
/// holds, and wrapped SOL cannot be burned: in wrapped SOL the holder of a named collectible
/// could stop a contest's result (or a box's settles) for good by burning the collectible. Now
/// a split that is carried out later takes no share that burns when it is in wrapped SOL.
#[test]
fn a_later_split_in_wrapped_sol_has_no_share_that_burns() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let landlord = player(&mut env, 0);
    let wsol = wrapped_sol(&mut env, &landlord.pubkey(), 1_000);
    env.upsert_item(50, collectible("Arena")).unwrap();
    let arena = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let contest = |shares| ContestArgs { sides: 2, closes_at: 600, result_by: 1_200, shares };
    for to in [To::Holder(arena), To::Burn] {
        let e = err(env.open_contest(&authority, 1, wsol, contest(vec![Share { to, bps: 500 }])));
        assert!(e.contains("BadShares") || e.contains("BadContest"), "{e}");
    }
    let nothing = vec![DropEntry { outcome: Outcome::Nothing, weight: 1 }];
    let wsol_box = |shares, entries| BoxArgs { price: 10, currency: Some(wsol), rise: None, fall: None, stock_odds: false, active: true, shares, entries };
    for to in [To::Holder(arena), To::Burn] {
        assert!(err(env.upsert_box_args(5, wsol_box(vec![Share { to, bps: 10_000 }], nothing.clone()))).contains("BadShares"));
    }
    let burns = vec![DropEntry { outcome: Outcome::Burn, weight: 1 }];
    assert!(err(env.upsert_box_args(5, wsol_box(vec![pool(0, 10_000)], burns))).contains("BadEntries"));
    env.upsert_box_args(5, wsol_box(vec![pool(0, 10_000)], nothing)).unwrap();
    env.open_contest(&authority, 1, wsol, contest(vec![pool(0, 500)])).unwrap();
}

/// LOW, noted (PROGRAM-0.3.md). A contest share for whoever holds a collectible must be paid into that holder's own
/// token account, and `decide` fails when the account it was sent with is not the holder's any
/// more. The holder decides when that is: they move the collectible to another wallet of
/// theirs and the result that was on its way fails. A result is refused after `result_by`, so
/// a holder who backed the losing side and keeps this up until then turns the loss into a
/// refund. This test shows one round of it; keeping it up for a whole contest means winning a
/// race with the authority every time, which this test does not show.
#[test]
fn a_holder_who_moves_the_collectible_fails_the_result_that_was_sent() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let gold = env.mint;
    let (a, landlord) = (player(&mut env, 100), player(&mut env, 100));
    env.upsert_item(50, collectible("Arena")).unwrap();
    let arena = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let (closes_at, result_by) = (env.now() + 600, env.now() + 1_200);
    let args = ContestArgs { sides: 2, closes_at, result_by, shares: vec![Share { to: To::Holder(arena), bps: 500 }] };
    env.open_contest(&authority, 1, gold, args).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    env.enter(&landlord, 1, 1, 100).unwrap();

    // The authority's result: side 0 won. Built while the landlord holds the arena.
    let mut metas = loot::accounts::Decide {
        authority: authority.pubkey(),
        game: env.game,
        contest: env.contest_pda(1),
        mint: gold,
        pot: env.pot_pda(1),
        token_program: spl_token::ID,
        token_2022_program: loot::tokens::TOKEN_2022_ID,
        fee: env.fee(),
    }
    .to_account_metas(None);
    metas.extend(env.to_metas(To::Holder(arena), &gold));
    let decide = Instruction::new_with_bytes(loot::ID, &loot::instruction::Decide { side: 0, reference: REF }.data(), metas);

    // The landlord moves the arena to a second wallet first.
    let second = Keypair::new().pubkey();
    let moved = TransferV1Builder::new().asset(arena).collection(Some(env.collection)).payer(landlord.pubkey()).authority(Some(landlord.pubkey())).new_owner(second).instruction();
    env.send(&[moved], &[&landlord]).unwrap();
    assert!(err(env.send(&[decide], &[&authority])).contains("NotTheHolders"));
    assert_eq!(env.contest(1).verdict, Verdict::Open);

    // Kept up until the result is overdue, the contest can only be called off.
    env.wait(1_201);
    env.token_account(second, gold);
    assert!(err(env.decide(&authority, 1, 0)).contains("ResultOverdue"));
    env.call_off(&landlord, 1).unwrap();
    env.claim(1, landlord.pubkey(), 1, ata(&landlord.pubkey(), &gold)).unwrap();
    assert_eq!(balance_of(&env, &landlord, &gold), 100, "the side that lost has its money back");
}

/// Fix 6, looked at from the other side: a game whose own mint is wrapped SOL. Nothing that is
/// carried out later can be written with a burn in it (an item's split, a box's split, a box
/// entry that burns, a holder's share), and what can be written settles: a shop sale splits to
/// a pool and the treasury, a box in the game's own mint pays, a lottery pays its pot out.
#[test]
fn a_game_in_wrapped_sol_writes_no_burn_for_later_and_settles_what_it_sells() {
    let mut env = world();
    env.wait(1_700_000_000);
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let buyer = env.player.insecure_clone();
    let wsol = wrapped_sol(&mut env, &owner.pubkey(), 0);
    wrapped_sol(&mut env, &buyer.pubkey(), 1_000_000);
    env.mint = wsol;
    env.treasury = ata(&owner.pubkey(), &wsol);
    env.init_platform(FEE).unwrap();
    env.create_game().unwrap();
    env.open_pool(&owner, 0, wsol).unwrap();

    assert!(err(env.upsert_item(50, collectible("Arena"))).contains("BadShares"), "the tests' usual item burns 20%");
    env.upsert_item(50, ItemArgs { shares: vec![], ..collectible("Arena") }).unwrap();
    let arena = env.make(&authority, 50, buyer.pubkey()).unwrap();
    let sword = |shares| ItemArgs { shares, ..item(ItemKind::Collectible, "Sword", 0, 1_000) };
    for to in [To::Burn, To::Holder(arena)] {
        assert!(err(env.upsert_item(1, sword(vec![Share { to, bps: 100 }]))).contains("BadShares"));
        let entries = vec![DropEntry { outcome: Outcome::Nothing, weight: 1 }];
        let args = BoxArgs { price: 10, currency: None, rise: None, fall: None, stock_odds: false, active: true, shares: vec![Share { to, bps: 100 }], entries };
        assert!(err(env.upsert_box_args(1, args)).contains("BadShares"));
    }
    let burns = BoxArgs { price: 10, currency: None, rise: None, fall: None, stock_odds: false, active: true, shares: vec![], entries: vec![DropEntry { outcome: Outcome::Burn, weight: 1 }] };
    assert!(err(env.upsert_box_args(1, burns)).contains("BadEntries"));

    // A shop sale: half to a pool, the rest to the treasury.
    env.upsert_item(1, sword(vec![pool(0, 5_000)])).unwrap();
    env.buy(1, 1).unwrap();
    let order = order_pda(&env.game, &buyer.pubkey(), 1);
    let keeper = env.cranker.insecure_clone();
    env.settle(order, &keeper).unwrap();
    assert_eq!((env.tokens(&pool_pda(&env.game, 0)), env.tokens(&env.treasury)), (500, 500));

    // A box that pays a prize from the pool or gives nothing, with what is left to the treasury.
    env.upsert_box(1, 100, vec![pool(0, 1_000)], vec![pay_drop(0, 200, 1), DropEntry { outcome: Outcome::Nothing, weight: 1 }]).unwrap();
    for (nonce, roll) in [(2, 0), (3, 1)] {
        env.open_box(1, nonce).unwrap();
        let order = order_pda(&env.game, &buyer.pubkey(), nonce);
        env.callback_of(1, order, rnd(roll)).unwrap();
        env.settle_prize(order, Some(ata(&buyer.pubkey(), &wsol)), &keeper).unwrap();
    }
    assert_eq!((env.tokens(&pool_pda(&env.game, 0)), env.tokens(&env.treasury)), (500 + 10 - 200 + 10, 500 + 90 + 90));

    // A lottery with a cut: the cut to the treasury, the pot to the winner.
    env.open_pool(&owner, 1, wsol).unwrap();
    env.upsert_lottery(&owner, 1, LotteryArgs { price: 100, pot: 1, cut_bps: 1_000, places: vec![], ticket_mint: Pubkey::default(), every: DAY, draws_at: env.now() + DAY }).unwrap();
    env.buy_tickets(&buyer, 1, 3, wsol).unwrap();
    env.wait(DAY);
    env.draw_lottery(1).unwrap();
    env.lottery_callback(1, rnd(1)).unwrap();
    let had = env.tokens(&ata(&buyer.pubkey(), &wsol));
    env.pay_lottery(1, ata(&buyer.pubkey(), &wsol)).unwrap();
    assert_eq!((env.tokens(&ata(&buyer.pubkey(), &wsol)), env.tokens(&env.treasury)), (had + 270, 680 + 30));

    // What still burns in wrapped SOL fails in the transaction that asks for it, and holds
    // nothing up: a `pay` with a burn share is the payer's own.
    assert!(env.pay(100, vec![burn(1_000)]).is_err());
    env.pay(100, vec![pool(0, 1_000)]).unwrap();
}

/// LOW, fixed. Since L1 the game cannot pay into the account it pays from. A treasury set to the
/// game's own vault, which `create_game` and `update_game` accepted, then made every settle with
/// a leftover fail, and players waited 7 days for a refund; so did an item's or a box's share
/// that pays the vault. Both are now refused when they are written.
#[test]
fn the_vault_cannot_be_the_treasury_or_a_share() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let first = order_pda(&env.game, &env.player.pubkey(), 1);
    env.buy(3, 1).unwrap(); // opens the vault
    env.settle(first, &keeper).unwrap();

    let (vault, treasury) = (ata(&env.game, &env.mint), env.treasury);
    env.treasury = vault;
    assert!(err(env.update_game(&owner, GameUpdate { authority: None, paused: None })).contains("SameAccount"));
    env.treasury = treasury;
    assert_eq!(env.game_state().treasury, treasury);

    let pays_vault = ItemArgs { shares: vec![Share { to: To::Account(vault), bps: 1_000 }], ..item(ItemKind::Collectible, "Hat", 0, PRICE) };
    assert!(err(env.upsert_item(9, pays_vault)).contains("SameAccount"));

    let second = order_pda(&env.game, &env.player.pubkey(), 2);
    env.buy(3, 2).unwrap();
    env.settle(second, &keeper).unwrap();
}
