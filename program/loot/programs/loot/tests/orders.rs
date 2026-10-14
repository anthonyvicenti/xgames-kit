//! Shop orders: buying an item, settling it, refunding it, and prices that rise and fall.
mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    anchor_spl::token::spl_token,
    common::*,
    loot::BoxArgs,
    loot::ItemArgs,
    loot::state::DropEntry,
    loot::state::Fall,
    loot::state::ItemKind,
    loot::state::LootBox,
    loot::state::Order,
    loot::state::OrderStatus,
    loot::state::Outcome,
    loot::state::Rise,
    loot::state::Share,
    loot::state::To,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn box_args(price: u64, currency: Option<Pubkey>, shares: Vec<Share>, entries: Vec<DropEntry>) -> BoxArgs {
    BoxArgs { price, currency, rise: None, fall: None, stock_odds: false, active: true, shares, entries }
}

fn nothing() -> DropEntry {
    DropEntry { outcome: Outcome::Nothing, weight: 1 }
}

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

fn balance_of(env: &Env, who: &Keypair, mint: &Pubkey) -> u64 {
    env.tokens(&ata(&who.pubkey(), mint))
}

/// The player's first order.
fn order_1(env: &Env) -> Pubkey {
    order_pda(&env.game, &env.player.pubkey(), 1)
}

fn asset_of(env: &Env, key: &Pubkey) -> mpl_core::Asset {
    *mpl_core::Asset::from_bytes(&env.data(key)).unwrap()
}

fn box_entries() -> Vec<DropEntry> {
    vec![item_drop(1, 1), item_drop(2, 1)]
}

const PRIZE: u8 = 0;

fn paid(env: &Env, nonce: u64) -> u64 {
    env.acc::<Order>(&order_pda(&env.game, &env.player.pubkey(), nonce)).paid
}

fn boxed(price: u64, entries: Vec<DropEntry>) -> BoxArgs {
    BoxArgs { price, currency: None, rise: None, fall: None, stock_odds: false, active: true, shares: vec![], entries }
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

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

/// A refund gives the serial back and leaves the risen price where it is; any edit of the item
/// writes the price anew.
#[test]
fn a_rising_price_does_not_come_down_on_refund_and_any_edit_resets_it() {
    let mut env = setup();
    let throne = ItemArgs { rise: Some(Rise { step: 0, growth_bps: 1_000 }), ..item(ItemKind::Collectible, "Throne", 0, 1_000) };
    env.upsert_item(60, throne.clone()).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    env.buy(60, 1).unwrap();
    assert_eq!((env.item_state(60).price, env.item_state(60).issued), (1_100, 1));
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(order).unwrap();
    assert_eq!((env.item_state(60).price, env.item_state(60).issued), (1_100, 0), "the serial came back, the price did not");
    env.buy(60, 2).unwrap();
    assert_eq!(env.item_state(60).price, 1_210);
    env.upsert_item(60, ItemArgs { uri: "https://example.invalid/throne-v2.json".into(), ..throne }).unwrap();
    assert_eq!((env.item_state(60).price, env.item_state(60).issued), (1_000, 1), "a new URI, and the curve starts over");
}

/// One vault holds every open order of a mint. With a 3% transfer fee and a rising price, five
/// orders at odd amounts are settled (shares to two pools and a burn, 100%) or refunded; at
/// every step the vault holds exactly the sum of the open orders' `paid`, and ends empty.
#[test]
fn vault_balances_across_fee_mint_orders_settled_and_refunded() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let coin = env.new_mint_2022(Some(300), None);
    env.fund(p, coin, 10_000_000);
    env.open_pool(&owner, 1, coin).unwrap();
    env.open_pool(&owner, 2, coin).unwrap();
    let shares = vec![pool(1, 3_333), pool(2, 3_333), burn(3_334)];
    let rise = Some(Rise { step: 1_001, growth_bps: 333 });
    env.upsert_box_args(9, BoxArgs { rise, ..box_args(7_777, Some(coin), shares, vec![nothing()]) }).unwrap();
    let vault = ata(&env.game, &coin);

    let orders: Vec<Pubkey> = (1..=5).map(|n| order_pda(&env.game, &p, n)).collect();
    let mut open = 0u64;
    for (i, order) in orders.iter().enumerate() {
        let price = env.acc::<loot::state::LootBox>(&box_pda(&env.game, 9)).price;
        env.open_box(9, i as u64 + 1).unwrap();
        env.callback_of(9, *order, rnd(0)).unwrap();
        let o: Order = env.acc(order);
        assert_eq!(o.paid, price - (price * 300).div_ceil(10_000), "paid is what arrived, less the fee");
        open += o.paid;
        assert_eq!(env.tokens(&vault), open);
    }
    let supply = env.supply(&coin);
    for i in [0, 2, 4] {
        let paid = env.acc::<Order>(&orders[i]).paid;
        env.settle_prize(orders[i], None, &keeper).unwrap();
        open -= paid;
        assert_eq!(env.tokens(&vault), open);
    }
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    for i in [1, 3] {
        env.refund(orders[i]).unwrap();
    }
    assert_eq!(env.tokens(&vault), 0, "nothing is owed and nothing is left");
    // What the settles moved: the burn is exact; each pool got its part less the fee.
    let burned = supply - env.supply(&coin);
    assert!(burned > 0 && env.tokens(&pool_pda(&env.game, 1)) > 0 && env.tokens(&pool_pda(&env.game, 2)) > 0);
}

/// A settle's remaining accounts must be the shares' accounts in the shares' order: fewer, a
/// swapped pair, a holder account of another mint, or a holder account that is not the
/// holder's, are each refused; extra accounts after them are ignored (they are for a hook).
#[test]
fn split_targets_cannot_be_fewer_misordered_or_of_another_mint() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let authority = env.authority.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 1, gold).unwrap();
    let partner = funded(&mut env);
    let partner_gold = env.token_account(partner.pubkey(), gold);
    let holder = funded(&mut env);
    let asset = env.make(&authority, 1, holder.pubkey()).unwrap();
    let holder_gold = env.token_account(holder.pubkey(), gold);
    let holder_other = env.token_account(holder.pubkey(), other);
    let shares = vec![pool(1, 2_000), Share { to: To::Account(partner_gold), bps: 2_000 }, Share { to: To::Holder(asset), bps: 2_000 }];
    env.upsert_box_args(9, box_args(10_000, None, shares, vec![nothing()])).unwrap();
    env.open_box(9, 1).unwrap();
    let order = order_pda(&env.game, &p, 1);
    env.callback_of(9, order, rnd(0)).unwrap();

    let good = env.settle_prize_ix(order, None);
    let n = good.accounts.len(); // ..., pool, partner, asset, holder_gold
    let mut fewer = good.clone();
    fewer.accounts.truncate(n - 2);
    assert!(err(env.send(&[fewer], &[&keeper])).contains("WrongPool"));
    let mut fewer = good.clone();
    fewer.accounts.truncate(n - 1);
    assert!(err(env.send(&[fewer], &[&keeper])).contains("WrongPool"));
    let mut swapped = good.clone();
    swapped.accounts.swap(n - 4, n - 3);
    assert!(err(env.send(&[swapped], &[&keeper])).contains("WrongPool"));
    let mut wrong_mint = good.clone();
    wrong_mint.accounts[n - 1].pubkey = holder_other;
    assert!(err(env.send(&[wrong_mint], &[&keeper])).contains("NotTheHolders"));
    let mut not_holder = good.clone();
    not_holder.accounts[n - 1].pubkey = env.token_account(keeper.pubkey(), gold);
    assert!(err(env.send(&[not_holder], &[&keeper])).contains("NotTheHolders"));
    let mut not_holder = good.clone();
    not_holder.accounts[n - 1].pubkey = pool_pda(&env.game, 1);
    assert!(err(env.send(&[not_holder], &[&keeper])).contains("NotTheHolders"));
    let mut wrong_asset = good.clone();
    wrong_asset.accounts[n - 2].pubkey = foreign_asset(&mut env, holder.pubkey());
    assert!(err(env.send(&[wrong_asset], &[&keeper])).contains("WrongPool"));
    // Extra accounts after the shares' are for a hook and change nothing.
    let mut extra = good.clone();
    extra.accounts.push(AccountMeta::new(env.game, false));
    extra.accounts.push(AccountMeta::new(order, false));
    env.send(&[extra], &[&keeper]).unwrap();
    assert_eq!(
        (env.tokens(&pool_pda(&env.game, 1)), env.tokens(&partner_gold), env.tokens(&holder_gold), env.tokens(&env.treasury)),
        (2_000, 2_000, 2_000, 4_000)
    );
}

/// The refund deadlines are `>`: at exactly `requested_slot + wait` nothing; one slot later,
/// anyone. A settle and a refund of one order in one transaction fail as a whole, in either
/// order, and leave the order as it was.
#[test]
fn refund_boundaries_and_a_refund_racing_a_settle() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let (rolled, pending) = (order_pda(&env.game, &p, 1), order_pda(&env.game, &p, 2));
    env.buy(3, 1).unwrap();
    env.open_box(1, 2).unwrap();
    env.wait_slots(1); // an order closes from the slot after its purchase

    // Both in one transaction: the refund after the settle finds no order, the refund before
    // it is not due; either way the settle is undone with it.
    let (s, r) = (env.settle_ix(rolled, keeper.pubkey()), env.refund_ix(rolled));
    let e = err(env.send(&[s.clone(), r.clone()], &[&keeper]));
    assert!(e.contains("AccountNotInitialized") || e.contains("AccountOwnedByWrongProgram") || e.contains("AccountDiscriminatorMismatch"), "{e}");
    assert!(err(env.send(&[r, s], &[&keeper])).contains("NotStale"));
    assert_eq!(env.acc::<Order>(&rolled).status, OrderStatus::Rolled);

    env.wait_slots(loot::STALE_SLOTS - 1);
    assert!(err(env.refund(pending)).contains("NotStale"));
    env.wait_slots(1);
    env.refund(pending).unwrap();
    env.wait_slots(loot::ROLLED_REFUND_SLOTS - loot::STALE_SLOTS - 1);
    assert!(err(env.refund(rolled)).contains("NotStale"));
    env.wait_slots(1);
    // Now both are possible; once one lands the other finds no order.
    let (s, r) = (env.settle_ix(rolled, keeper.pubkey()), env.refund_ix(rolled));
    let e = err(env.send(&[s.clone(), r.clone()], &[&keeper]));
    assert!(e.contains("AccountNotInitialized") || e.contains("AccountOwnedByWrongProgram") || e.contains("AccountDiscriminatorMismatch"), "{e}");
    assert_eq!(env.acc::<Order>(&rolled).status, OrderStatus::Rolled, "the whole transaction was undone");
    env.send(&[s], &[&keeper]).unwrap();
    assert!(!env.exists(&rolled));
}

/// A price that falls to 0 is not for sale and the failed sale leaves the item's count alone;
/// a fall that starts in the future holds the price; a price that cannot rise further stays
/// put, and the order still settles.
#[test]
fn price_edges_on_buy_item() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let now = env.now();
    env.upsert_item(70, ItemArgs { fall: Some(Fall { step: 100, every: 60, floor: 0, since: now }), ..item(ItemKind::Collectible, "Comet", 0, 100) }).unwrap();
    env.upsert_item(71, ItemArgs { fall: Some(Fall { step: 100, every: 60, floor: 0, since: now + 10_000 }), ..item(ItemKind::Collectible, "Later", 0, 100) }).unwrap();
    env.buy(70, 1).unwrap();
    assert_eq!(env.acc::<Order>(&order_pda(&env.game, &p, 1)).paid, 100);
    env.wait(60);
    assert!(err(env.buy(70, 2)).contains("NotForSale"));
    assert_eq!(env.item_state(70).issued, 1, "the failed sale reserved nothing");
    env.buy(71, 2).unwrap();
    assert_eq!(env.acc::<Order>(&order_pda(&env.game, &p, 2)).paid, 100);

    // The whole supply of the mint in one wallet, and an item priced at nearly all of it.
    let have = env.tokens(&ata(&p, &env.mint));
    let mint = env.mint;
    let supply = env.supply(&mint);
    env.fund(p, mint, u64::MAX - supply);
    assert_eq!(env.tokens(&ata(&p, &mint)), have + (u64::MAX - supply));
    let price = u64::MAX - 1_000;
    env.upsert_item(72, ItemArgs { rise: Some(Rise { step: 2_000, growth_bps: 0 }), ..item(ItemKind::Collectible, "Everything", 0, price) }).unwrap();
    let ix = env.buy_ix_max(72, 3, u64::MAX);
    let player = env.player.insecure_clone();
    env.send(&[ix], &[&player]).unwrap();
    let order = order_pda(&env.game, &p, 3);
    assert_eq!(env.acc::<Order>(&order).paid, price);
    assert_eq!(env.item_state(72).price, price, "it can rise no further and stays put");
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.tokens(&env.treasury), price - price / 5);
}

/// Lamports anyone sends to an order's escrow, to its future asset address, or to the order's
/// own address before it is opened, all end with the order's player.
#[test]
fn prefunded_order_escrow_and_asset_go_to_the_player() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let stranger = funded(&mut env);
    let order = order_pda(&env.game, &p, 1);
    env.token_account(env.game, env.mint); // the vault, so its rent is not in the sums below
    // Before the order exists.
    env.svm.airdrop(&order, 1_000).unwrap();
    let sol = env.lamports(&p);
    env.buy(3, 1).unwrap();
    let asset = env.asset_pda(&order);
    assert_eq!(sol - env.lamports(&p), env.rent(Order::SPACE) - 1_000 + loot::ESCROW_LAMPORTS + FEE + 5_000, "the player's rent was 1,000 short");
    env.svm.airdrop(&escrow_pda(&order), 2_000).unwrap();
    env.svm.airdrop(&asset, 3_000).unwrap();
    let sol = env.lamports(&p);
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.lamports(&p) - sol, env.rent(Order::SPACE) + loot::ESCROW_LAMPORTS + 2_000 + 3_000 - env.lamports(&asset));
    assert_eq!(env.fees(), FEE);
    let _ = stranger;
}

/// A player who bought again at a nonce they had settled in the
/// same slot put the new order's collectible at the address the first one was minted at: that
/// settle failed and the order waited 7 days for a refund. An order now closes only from the
/// slot after its purchase, so the second purchase is in a later slot, has an address of its
/// own, and settles.
#[test]
fn a_rebuy_at_a_settled_nonce_gets_a_collectible_of_its_own() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let order = order_pda(&env.game, &p, 1);
    env.buy(3, 1).unwrap();
    let asset = env.asset_pda(&order);
    assert!(err(env.send(&[env.settle_ix(order, keeper.pubkey())], &[&keeper])).contains("SameSlot"));
    env.settle(order, &keeper).unwrap(); // from the next slot
    env.buy(3, 1).unwrap();
    assert_ne!(env.asset_pda(&order), asset, "same order address, another slot: another asset address");
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.item_state(3).issued, 2);
}

/// A limited `Normal` item whose game never settles: a player buys
/// the whole remaining supply, waits out the 7 days, and refunds in the order of purchase. Only
/// the last serial could be taken back, so the supply stayed short by all but one unit until
/// the owner raised `max_supply`. Now the serials that cannot be taken back are counted as
/// voided, and every unit is for sale again; those numbers stay gaps.
#[test]
fn refunding_in_purchase_order_gives_every_unit_back() {
    let mut env = setup();
    env.upsert_item(7, item(ItemKind::Normal, "Limited Pass", 3, PRICE)).unwrap();
    let player = env.player.pubkey();
    let orders: Vec<_> = (1..=3u64).map(|n| { env.buy(7, n).unwrap(); order_pda(&env.game, &player, n) }).collect();
    assert_eq!(env.item_state(7).issued, 3);
    assert!(err(env.buy(7, 4)).contains("SoldOut"));

    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    for o in &orders {
        env.refund(*o).unwrap();
    }
    // Serial 3 was taken back, 1 and 2 are voided: no unit is out.
    let it = env.item_state(7);
    assert_eq!((it.issued, it.voided), (2, 2));
    for n in 5..=7u64 {
        env.buy(7, n).unwrap();
    }
    assert!(err(env.buy(7, 8)).contains("SoldOut"));
    assert_eq!(env.acc::<loot::state::Order>(&order_pda(&env.game, &player, 7)).serial, 5, "new numbers, no repeats");
}

/// A throne that costs 10% more each time, and a box that costs 50 more each time.
#[test]
fn a_price_rises_with_every_sale() {
    let mut env = setup();
    let p = env.player.insecure_clone();
    let gold = env.mint;
    let throne = ItemArgs { rise: Some(Rise { step: 0, growth_bps: 1_000 }), ..item(ItemKind::Collectible, "Throne Seat", 0, 1_000) };
    env.upsert_item(60, throne).unwrap();
    let before = balance_of(&env, &p, &gold);

    // Two buyers saw 1,000. The second one's transaction lands at 1,100, and is refused.
    let late = env.buy_ix_max(60, 2, 1_000);
    env.buy(60, 1).unwrap();
    assert_eq!(env.item_state(60).price, 1_100);
    assert!(err(env.send(&[late], &[&p])).contains("PriceAboveMax"));
    env.buy(60, 2).unwrap();
    assert_eq!((env.item_state(60).price, before - balance_of(&env, &p, &gold)), (1_210, 2_100));

    let rising = BoxArgs { price: 100, currency: None, rise: Some(Rise { step: 50, growth_bps: 0 }), fall: None, stock_odds: false, active: true, shares: vec![], entries: vec![item_drop(60, 1)] };
    env.upsert_box_args(6, rising).unwrap();
    env.open_box(6, 3).unwrap();
    env.open_box(6, 4).unwrap();
    assert_eq!(env.acc::<loot::state::LootBox>(&box_pda(&env.game, 6)).price, 200);
    assert_eq!(env.acc::<Order>(&order_pda(&env.game, &p.pubkey(), 4)).paid, 150);
}

#[test]
fn a_normal_item_is_settled_by_one_of_the_games_two_keys() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    env.callback(order, rnd(1)).unwrap(); // item 2, normal
    let asset = env.asset_pda(&order);

    assert!(err(env.settle(order, &keeper)).contains("NotTheGames"));
    // The game's server, once its backend has delivered the item (the owner can too).
    env.settle(order, &authority).unwrap();
    assert!(!env.exists(&asset), "nothing is minted for a normal item");
    assert_eq!(env.tokens(&env.treasury), PRICE * 8 / 10);
    assert_eq!(env.fees(), FEE);
}

#[test]
fn a_shop_purchase_of_a_soulbound_collectible() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.buy(3, 1).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.status, o.outcome, o.serial, o.paid), (OrderStatus::Rolled, Outcome::Item(3), 1, PRICE / 2));
    let asset = env.asset_pda(&order);
    env.settle(order, &keeper).unwrap();

    let a = asset_of(&env, &asset);
    assert_eq!(a.base.name, "Founder Badge #1");
    assert!(a.plugin_list.permanent_freeze_delegate.unwrap().permanent_freeze_delegate.frozen);
    dump_asset(&env, &asset, "core-asset-soulbound");
    // It cannot be transferred.
    let p = env.player.insecure_clone();
    let ix = mpl_core::instructions::TransferV1Builder::new()
        .asset(asset)
        .collection(Some(env.collection))
        .payer(p.pubkey())
        .new_owner(keeper.pubkey())
        .instruction();
    assert!(env.send(&[ix], &[&p]).is_err());
}

/// A game that never settles cannot keep the money: after 7 days anyone refunds the order, and
/// its serial number goes back to the item when it was the last one handed out.
#[test]
fn an_unsettled_order_refunds_after_seven_days() {
    let mut env = setup();
    let player = env.player.pubkey();
    let had = env.tokens(&ata(&player, &env.mint));
    let (first, second) = (order_1(&env), order_pda(&env.game, &player, 2));
    env.buy(3, 1).unwrap();
    env.buy(3, 2).unwrap();
    assert_eq!(env.item_state(3).issued, 2);

    env.wait_slots(loot::ROLLED_REFUND_SLOTS);
    assert!(err(env.refund(first)).contains("NotStale"));
    env.wait_slots(1);
    // Without its item, or with another one, a rolled order is not refunded.
    let c = env.cranker.insecure_clone();
    let mut ix = env.refund_ix(first);
    ix.accounts.pop();
    assert!(err(env.send(&[ix], &[&c])).contains("ItemMismatch"));
    let mut ix = env.refund_ix(first);
    ix.accounts.last_mut().unwrap().pubkey = item_pda(&env.game, 1);
    assert!(err(env.send(&[ix], &[&c])).contains("ItemMismatch"));

    // Serial 1 is not the last handed out: it stays a gap. Serial 2 is: it is free again.
    env.refund(first).unwrap();
    assert_eq!(env.item_state(3).issued, 2);
    env.refund(second).unwrap();
    assert_eq!(env.item_state(3).issued, 1);
    assert_eq!(env.tokens(&ata(&player, &env.mint)), had);
    assert_eq!(env.tokens(&env.treasury), 0);
}

/// A refund pays the order's player and nobody else, whoever sends it.
#[test]
fn a_refund_cannot_be_redirected() {
    let mut env = setup();
    let c = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    env.wait_slots(loot::STALE_SLOTS + 1);

    let thief = c.pubkey();
    let thief_token = env.token_account(thief, env.mint);
    let mut ix = env.refund_ix(order);
    ix.accounts[2].pubkey = thief; // the player
    assert!(err(env.send(&[ix], &[&c])).contains("ConstraintHasOne"));
    let mut ix = env.refund_ix(order);
    let at = ix.accounts.iter().position(|m| m.pubkey == ata(&env.player.pubkey(), &env.mint)).unwrap();
    ix.accounts[at].pubkey = thief_token;
    assert!(err(env.send(&[ix], &[&c])).contains("ConstraintAddress"));
}

#[test]
fn a_purchase_never_costs_more_than_the_player_signed() {
    let mut env = setup();
    let p = env.player.insecure_clone();
    // The player signs for the price they were shown; the owner's raise lands first.
    let buy = env.buy_ix(3, 1);
    let open = env.open_box_ix(1, 2);
    env.upsert_item(3, ItemArgs { soulbound: true, ..item(ItemKind::Collectible, "Founder Badge", 0, PRICE) }).unwrap();
    env.upsert_box(1, 2 * PRICE, vec![], box_entries()).unwrap();
    assert!(err(env.send(&[buy], &[&p])).contains("PriceAboveMax"));
    assert!(err(env.send(&[open], &[&p])).contains("PriceAboveMax"));
    // A cut is fine: the player pays the lower price.
    let buy = env.buy_ix_max(3, 1, 5 * PRICE);
    env.send(&[buy], &[&p]).unwrap();
    assert_eq!(env.acc::<Order>(&order_1(&env)).paid, PRICE);
}

/// The split and the fee are fixed when the player pays. Later edits do not touch the order.
#[test]
fn an_order_keeps_the_split_and_the_fee_it_was_paid_under() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.buy(3, 1).unwrap(); // under: burn 20%, fee 0.001 SOL

    let edited = ItemArgs { soulbound: true, shares: vec![pool(PRIZE, 10_000)], ..item(ItemKind::Collectible, "Founder Badge", 0, PRICE / 2) };
    env.upsert_item(3, edited).unwrap();
    env.set_fee(0).unwrap();
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), 0);
    assert_eq!(env.tokens(&env.treasury), PRICE / 2 * 8 / 10);
    assert_eq!(env.fees(), FEE);
}

#[test]
fn lamports_parked_at_the_asset_address_do_not_block_settle() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.buy(3, 1).unwrap();
    let asset = env.asset_pda(&order);
    // Core's create refuses an address that holds SOL, and anyone can send some there.
    env.svm.airdrop(&asset, 12_345).unwrap();
    let sol = env.lamports(&env.player.pubkey());
    env.settle(order, &keeper).unwrap();
    assert_eq!(asset_of(&env, &asset).base.owner, env.player.pubkey());
    // Whoever parked them paid the player.
    let back = env.lamports(&env.player.pubkey()) - sol;
    assert_eq!(back, 12_345 + env.rent(Order::SPACE) + loot::ESCROW_LAMPORTS - env.lamports(&asset));
}

#[test]
fn settle_pays_only_where_the_game_and_the_order_say() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.open_pool(&owner, 1, env.mint).unwrap();
    env.upsert_item(3, ItemArgs { shares: vec![pool(PRIZE, 5_000)], ..item(ItemKind::Collectible, "Founder Badge", 0, PRICE) }).unwrap();
    env.buy(3, 1).unwrap();
    env.wait_slots(1); // an order closes from the slot after its purchase
    let thief = keeper.pubkey();
    let thief_token = env.token_account(thief, env.mint);

    let swaps = [
        (env.treasury, thief_token, "ConstraintAddress"),
        (env.player.pubkey(), thief, "ConstraintHasOne"),
        (ata(&env.game, &env.mint), thief_token, "ConstraintAddress"),
        (pool_pda(&env.game, PRIZE), thief_token, "WrongPool"),
        (pool_pda(&env.game, PRIZE), pool_pda(&env.game, 1), "WrongPool"),
        (env.collection, Keypair::new().pubkey(), "ConstraintAddress"),
    ];
    for (right, wrong, why) in swaps {
        let mut ix = env.settle_ix(order, keeper.pubkey());
        let at = ix.accounts.iter().position(|m| m.pubkey == right).unwrap();
        ix.accounts[at].pubkey = wrong;
        assert!(err(env.send(&[ix], &[&keeper])).contains(why), "{why}");
    }
    // The pool account left out altogether.
    let mut ix = env.settle_ix(order, keeper.pubkey());
    ix.accounts.pop();
    assert!(err(env.send(&[ix], &[&keeper])).contains("WrongPool"));

    env.settle(order, &keeper).unwrap();
    assert_eq!(env.tokens(&thief_token), 0);
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), PRICE / 2);
    assert_eq!(env.tokens(&env.treasury), PRICE / 2);
}

/// A drop at 1,000 that falls 100 a minute, from a minute from now, down to 400.
#[test]
fn a_price_falls_with_time_and_each_sale_starts_it_again() {
    let mut env = setup();
    let start = env.now() + MINUTE;
    let fall = Some(Fall { step: 100, every: MINUTE as u32, floor: 400, since: start });
    env.upsert_item(50, ItemArgs { fall, ..item(ItemKind::Collectible, "Comet", 0, 1_000) }).unwrap();
    assert!(err(env.upsert_item(51, ItemArgs { fall: Some(Fall { every: 0, ..fall.unwrap() }), ..item(ItemKind::Collectible, "Bad", 0, 1) })).contains("BadPrice"));
    assert!(err(env.upsert_item(51, ItemArgs { fall: Some(Fall { step: 0, ..fall.unwrap() }), ..item(ItemKind::Collectible, "Bad", 0, 1) })).contains("BadPrice"));

    // Before the start it holds.
    env.buy(50, 1).unwrap();
    assert_eq!(paid(&env, 1), 1_000);

    // Three minutes past the start: 700. The buyer signed for 1,000 and pays 700.
    env.wait(4 * MINUTE);
    env.buy(50, 2).unwrap();
    assert_eq!(paid(&env, 2), 700);
    // The sale starts the fall again from 700.
    let comet = env.item_state(50);
    assert_eq!((comet.price, comet.fall.unwrap().since), (700, env.now()));
    env.wait(MINUTE - 1);
    env.buy(50, 3).unwrap();
    assert_eq!(paid(&env, 3), 700, "a minute has not passed since the last sale");

    // Then it rests on its floor.
    env.wait(DAY);
    env.buy(50, 4).unwrap();
    assert_eq!(paid(&env, 4), 400);
}

/// A throne that costs 50% more with each buyer and loses 10 a minute while nobody buys.
#[test]
fn a_price_that_rises_with_sales_and_falls_with_time() {
    let mut env = setup();
    let fall = Some(Fall { step: 10, every: MINUTE as u32, floor: 100, since: env.now() });
    let throne = ItemArgs { rise: Some(Rise { step: 0, growth_bps: 5_000 }), fall, ..item(ItemKind::Collectible, "Throne", 0, 200) };
    env.upsert_item(60, throne).unwrap();
    env.buy(60, 1).unwrap();
    assert_eq!((paid(&env, 1), env.item_state(60).price), (200, 300));
    env.wait(5 * MINUTE);
    env.buy(60, 2).unwrap();
    assert_eq!((paid(&env, 2), env.item_state(60).price), (250, 375));

    // A box falls the same way.
    let falling = BoxArgs { fall: Some(Fall { step: 100, every: MINUTE as u32, floor: 100, since: env.now() }), ..boxed(300, vec![item_drop(60, 1)]) };
    env.upsert_box_args(6, falling).unwrap();
    env.wait(MINUTE);
    env.open_box(6, 3).unwrap();
    assert_eq!(paid(&env, 3), 200);
    assert_eq!(env.acc::<LootBox>(&box_pda(&env.game, 6)).price, 200);
}

/// An order's collectible sat at `["asset", order]`, so a second
/// purchase at the nonce of a settled order could never settle: its asset address was taken. The
/// address now includes the slot of the purchase.
#[test]
fn a_reused_nonce_buys_a_collectible_that_settles() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.buy(3, 1).unwrap();
    let first = env.asset_pda(&order);
    env.settle(order, &keeper).unwrap();

    env.wait_slots(1);
    env.buy(3, 1).unwrap(); // the same nonce
    let second = env.asset_pda(&order);
    env.settle(order, &keeper).unwrap();
    assert_ne!(first, second);
    assert!(env.exists(&first) && env.exists(&second));
}

/// OPEN:
/// refusing such mints would refuse USDC. A project's page should say when its mint can freeze.
/// `create_game` takes a mint with a freeze authority. Whoever holds it can freeze the game's
/// vault, or one player's token account: then neither settle nor refund can move that order's
/// payment, for as long as the freeze lasts. Nothing is stolen; the order is held hostage.
#[test]
fn a_freeze_authority_holds_open_orders_hostage() {
    let mut env = world();
    let (owner, keeper) = (env.creator.insecure_clone(), env.cranker.insecure_clone());
    let player = env.player.pubkey();
    // The game's token, this time with a freeze authority.
    let mint = Keypair::new();
    let ixs = [
        solana_system_interface::instruction::create_account(&owner.pubkey(), &mint.pubkey(), env.rent(82), 82, &spl_token::ID),
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &owner.pubkey(), Some(&owner.pubkey()), 6).unwrap(),
    ];
    env.send(&ixs, &[&owner, &mint]).unwrap();
    env.mint = mint.pubkey();
    env.treasury = env.token_account(owner.pubkey(), env.mint);
    env.fund(player, env.mint, 100 * PRICE);
    env.init_platform(FEE).unwrap();
    env.create_game().unwrap();
    env.catalog();

    env.buy(3, 1).unwrap();
    let (order, vault) = (order_1(&env), ata(&env.game, &env.mint));
    let freeze = spl_token::instruction::freeze_account(&spl_token::ID, &vault, &env.mint, &owner.pubkey(), &[]).unwrap();
    env.send(&[freeze], &[&owner]).unwrap();

    assert!(env.settle(order, &keeper).is_err());
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    assert!(env.refund(order).is_err(), "the way out is shut too");
    assert_eq!(env.tokens(&vault), PRICE / 2);
}

/// One order pays once. A second settle, or a refund after a settle, in the same transaction or
/// a later one, finds no order.
#[test]
fn an_order_ends_once() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let (first, second) = (order_1(&env), order_pda(&env.game, &env.player.pubkey(), 2));
    env.buy(3, 1).unwrap();
    env.buy(3, 2).unwrap();
    let vault = ata(&env.game, &env.mint);
    assert_eq!(env.tokens(&vault), PRICE);

    // Twice in one transaction: all of it fails, nothing moved.
    let twice = [env.settle_ix(first, keeper.pubkey()), env.settle_ix(first, keeper.pubkey())];
    assert!(env.send(&twice, &[&keeper]).is_err());
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    let both = [env.settle_ix(first, keeper.pubkey()), env.refund_ix(first)];
    assert!(env.send(&both, &[&keeper]).is_err());
    let both = [env.refund_ix(first), env.settle_ix(first, keeper.pubkey())];
    assert!(env.send(&both, &[&keeper]).is_err());
    assert_eq!(env.tokens(&vault), PRICE);

    // Once each, then never again: the other order's payment stays where it is.
    let (settle_again, refund_again) = (env.settle_ix(first, keeper.pubkey()), env.refund_ix(first));
    env.settle(first, &keeper).unwrap();
    assert!(env.send(&[settle_again], &[&keeper]).is_err());
    assert!(env.send(&[refund_again], &[&keeper]).is_err());
    assert_eq!(env.tokens(&vault), PRICE / 2);
    env.refund(second).unwrap();
    assert_eq!(env.tokens(&vault), 0);
}

/// `Checkout` is a group of accounts inside `BuyItem` and `OpenBox`, and takes its `nonce` from
/// the instruction data that follows the outer struct's id. With an id and a nonce that share no
/// bytes, the order lands at the address of exactly that nonce, for both instructions.
#[test]
fn checkout_reads_the_nonce_that_follows_the_id() {
    let mut env = setup();
    let player = env.player.pubkey();
    let (a, b) = (0xA1B2_C3D4_E5F6_0718u64, 0x0102_0304_0506_0708u64);
    env.buy(3, a).unwrap();
    env.open_box(1, b).unwrap();
    let (oa, ob): (Order, Order) = (env.acc(&order_pda(&env.game, &player, a)), env.acc(&order_pda(&env.game, &player, b)));
    assert_eq!((oa.nonce, oa.outcome, oa.status), (a, loot::state::Outcome::Item(3), OrderStatus::Rolled));
    assert_eq!((ob.nonce, ob.loot_box, ob.status), (b, box_pda(&env.game, 1), OrderStatus::Pending));
    // What a misread would have produced (the id's 4 bytes then the nonce's first 4) is empty.
    let misread = ((a & 0xFFFF_FFFF) << 32) | 3;
    assert!(!env.exists(&order_pda(&env.game, &player, misread)));
}

/// A raise of the fee that takes effect while an order is open changes nothing for it: the
/// escrow holds the fee the player was shown, pays exactly that, and returns the rest.
#[test]
fn a_fee_raise_between_purchase_and_settle_costs_the_order_nothing_more() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.set_fee(0).unwrap();
    env.buy(3, 1).unwrap(); // under a fee of 0
    env.set_fee(loot::MAX_FEE_LAMPORTS).unwrap();
    env.wait(loot::NOTICE_SECONDS + 1);
    assert_eq!(env.platform().fees(env.now()).player, loot::MAX_FEE_LAMPORTS);

    let sol = env.lamports(&env.player.pubkey());
    let asset = env.asset_pda(&order);
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.fees(), 0, "the order was bought at a fee of 0");
    let back = env.lamports(&env.player.pubkey()) - sol;
    assert_eq!(back, env.rent(Order::SPACE) + loot::ESCROW_LAMPORTS - env.lamports(&asset));
    assert_eq!(env.lamports(&escrow_pda(&order)), 0);
}

/// At settle, whoever sends the transaction cannot point a `Holder` or `Account` share
/// anywhere else, and cannot name another collectible as the one whose holder is paid.
#[test]
fn a_settle_cannot_redirect_a_share() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let landlord = player(&mut env, 0);
    let thief = player(&mut env, 0);
    let partner = env.token_account(Keypair::new().pubkey(), gold);
    env.upsert_item(50, collectible("Plot")).unwrap();
    let plot = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let thiefs_plot = env.make(&authority, 50, thief.pubkey()).unwrap();
    let shares = vec![Share { to: To::Holder(plot), bps: 5_000 }, Share { to: To::Account(partner), bps: 5_000 }];
    env.upsert_item(51, ItemArgs { shares, ..item(ItemKind::Collectible, "Crop", 0, 1_000) }).unwrap();
    env.buy(51, 1).unwrap();
    env.wait_slots(1); // an order closes from the slot after its purchase
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    let thiefs = ata(&thief.pubkey(), &gold);

    let mut ix = env.settle_ix(order, c.pubkey());
    swap(&mut ix, ata(&landlord.pubkey(), &gold), thiefs);
    assert!(err(env.send(&[ix], &[&c])).contains("NotTheHolders"));

    let mut ix = env.settle_ix(order, c.pubkey());
    swap(&mut ix, plot, thiefs_plot);
    swap(&mut ix, ata(&landlord.pubkey(), &gold), thiefs);
    assert!(err(env.send(&[ix], &[&c])).contains("WrongPool"));

    let mut ix = env.settle_ix(order, c.pubkey());
    swap(&mut ix, partner, thiefs);
    assert!(err(env.send(&[ix], &[&c])).contains("WrongPool"));

    env.settle(order, &c).unwrap();
    assert_eq!((balance_of(&env, &landlord, &gold), env.tokens(&partner), env.tokens(&thiefs)), (500, 500, 0));
    assert!(!env.exists(&order));
}

/// A fall that started near `i64::MIN` overflowed on every sale, so
/// the item could never sell. A fall's start may no longer be before 1970, and the arithmetic
/// saturates.
#[test]
fn a_fall_cannot_start_before_1970() {
    let mut env = setup();
    for since in [i64::MIN, -1] {
        let fall = Some(Fall { step: 1, every: 1, floor: 1, since });
        assert!(err(env.upsert_item(70, ItemArgs { fall, ..item(ItemKind::Collectible, "Relic", 0, 1_000) })).contains("BadPrice"));
    }
    let fall = Some(Fall { step: 1, every: 1, floor: 1, since: 0 });
    env.upsert_item(70, ItemArgs { fall, ..item(ItemKind::Collectible, "Relic", 0, 1_000) }).unwrap();
    env.buy(70, 1).unwrap();
}

/// A falling price at its edges: a floor above the price, a step bigger than the price, a start
/// in the future, a fall to 0, and the buyer's `max_price`.
#[test]
fn a_fall_at_its_edges() {
    let mut env = setup();
    let now = env.now();
    let paid = |env: &Env, nonce| env.acc::<Order>(&order_pda(&env.game, &env.player.pubkey(), nonce)).paid;

    // A floor above the price: it never moves.
    env.upsert_item(80, ItemArgs { fall: Some(Fall { step: 10, every: 1, floor: 500, since: now }), ..item(ItemKind::Collectible, "A", 0, 100) }).unwrap();
    // A step of everything, every second: the floor at once.
    env.upsert_item(81, ItemArgs { fall: Some(Fall { step: u64::MAX, every: 1, floor: 7, since: now }), ..item(ItemKind::Collectible, "B", 0, 100) }).unwrap();
    // A start a year away: the price holds, and a sale leaves the start alone.
    env.upsert_item(82, ItemArgs { fall: Some(Fall { step: 10, every: 1, floor: 1, since: now + 365 * DAY }), ..item(ItemKind::Collectible, "C", 0, 100) }).unwrap();
    // A floor of 0: the price reaches 0 and the item is no longer for sale.
    env.upsert_item(83, ItemArgs { fall: Some(Fall { step: 50, every: 1, floor: 0, since: now }), ..item(ItemKind::Collectible, "D", 0, 100) }).unwrap();
    env.wait(DAY);

    env.buy(80, 1).unwrap();
    env.buy(81, 2).unwrap();
    env.buy(82, 3).unwrap();
    assert_eq!((paid(&env, 1), paid(&env, 2), paid(&env, 3)), (100, 7, 100));
    assert_eq!(env.item_state(82).fall.unwrap().since, now + 365 * DAY);
    assert!(err(env.buy(83, 4)).contains("NotForSale"));
    assert_eq!(env.item_state(83).price, 100, "a refused sale changes nothing");

    // The buyer's limit is checked against the fallen price.
    env.upsert_item(84, ItemArgs { fall: Some(Fall { step: 10, every: 1, floor: 50, since: env.now() }), ..item(ItemKind::Collectible, "E", 0, 100) }).unwrap();
    env.wait(2);
    let p = env.player.insecure_clone();
    let ix = env.buy_ix_max(84, 5, 79);
    assert!(err(env.send(&[ix], &[&p])).contains("PriceAboveMax"));
    let ix = env.buy_ix_max(84, 5, 80);
    env.send(&[ix], &[&p]).unwrap();
}

/// After a void a later sale gets a serial above `max_supply`: a serial is a
/// number, not a count (`Item.voided`). The units out still respect the cap.
#[test]
fn a_voided_serial_lets_a_later_serial_pass_max_supply() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    env.upsert_item(10, item(ItemKind::Collectible, "Rare Hat", 2, PRICE)).unwrap();
    let player = env.player.pubkey();
    let (o1, o2, o3) = (order_pda(&env.game, &player, 1), order_pda(&env.game, &player, 2), order_pda(&env.game, &player, 3));
    env.buy(10, 1).unwrap(); // serial 1
    env.buy(10, 2).unwrap(); // serial 2
    assert!(err(env.buy(10, 3)).contains("SoldOut"));

    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(o1).unwrap(); // serial 1 is not the last: voided
    let it = env.item_state(10);
    assert_eq!((it.issued, it.voided, it.max_supply), (2, 1, 2));

    env.buy(10, 3).unwrap();
    let o: loot::state::Order = env.acc(&o3);
    assert_eq!(o.serial, 3, "serial 3 of an item whose max supply is 2");
    env.settle(o2, &keeper).unwrap();
    env.settle(o3, &keeper).unwrap();
    assert!(err(env.buy(10, 4)).contains("SoldOut"), "but the units out still respect the cap");
}
