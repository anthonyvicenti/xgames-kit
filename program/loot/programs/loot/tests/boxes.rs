//! Loot boxes: the oracle's roll, the odds, prizes from pools, and edits after a purchase.
mod common;

use {
    anchor_lang::Discriminator,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    common::*,
    loot::BoxArgs,
    loot::pick::by_stock,
    loot::receipts::OrderSettled,
    loot::state::DropEntry,
    loot::state::ItemKind,
    loot::state::Order,
    loot::state::OrderStatus,
    loot::state::Outcome,
    loot::state::Share,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn box_args(price: u64, currency: Option<Pubkey>, shares: Vec<Share>, entries: Vec<DropEntry>) -> BoxArgs {
    BoxArgs { price, currency, rise: None, fall: None, stock_odds: false, active: true, shares, entries }
}

fn nothing() -> DropEntry {
    DropEntry { outcome: Outcome::Nothing, weight: 1 }
}

/// The player's first order.
fn order_1(env: &Env) -> Pubkey {
    order_pda(&env.game, &env.player.pubkey(), 1)
}

const PRIZE: u8 = 0;

fn asset_of(env: &Env, key: &Pubkey) -> mpl_core::Asset {
    *mpl_core::Asset::from_bytes(&env.data(key)).unwrap()
}

fn box_entries() -> Vec<DropEntry> {
    vec![item_drop(1, 1), item_drop(2, 1)]
}

fn boxed(price: u64, entries: Vec<DropEntry>) -> BoxArgs {
    BoxArgs { price, currency: None, rise: None, fall: None, stock_odds: false, active: true, shares: vec![], entries }
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

fn my_coins(env: &Env, who: &Pubkey) -> u64 {
    env.tokens(&ata(who, &env.mint))
}

fn nothing_weighing(weight: u32) -> DropEntry {
    DropEntry { outcome: Outcome::Nothing, weight }
}

/// `who` opens box `box_id` at `nonce` and the oracle answers `number`. Returns the order.
fn open_as(env: &mut Env, who: &Keypair, box_id: u32, nonce: u64, number: u64) -> Pubkey {
    let me = env.player.insecure_clone();
    env.player = who.insecure_clone();
    env.open_box(box_id, nonce).unwrap();
    env.player = me;
    let order = order_pda(&env.game, &who.pubkey(), nonce);
    env.callback_of(box_id, order, rnd(number)).unwrap();
    order
}

/// `upsert_box` cannot see what mint a pool holds. A box priced in USD whose split names a gold
/// pool is accepted; its orders roll, cannot settle, and refund after seven days.
#[test]
fn a_box_in_another_currency_whose_pool_is_in_the_games_mint_locks_the_player_for_seven_days() {
    let mut env = setup();
    let (owner, c) = (env.creator.insecure_clone(), env.cranker.insecure_clone());
    let gold = env.mint;
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 0, gold).unwrap();
    let args = BoxArgs {
        price: 10,
        currency: Some(usd),
        rise: None,
        fall: None,
        stock_odds: false,
        active: true,
        shares: vec![pool(0, 10_000)],
        entries: vec![DropEntry { outcome: Outcome::Nothing, weight: 1 }],
    };
    env.upsert_box_args(11, args).unwrap();
    let p = env.player.pubkey();
    env.fund(p, usd, 100);
    let order = order_pda(&env.game, &p, 1);
    env.open_box(11, 1).unwrap();
    env.callback_of(11, order, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&order).outcome, Outcome::Nothing);
    assert!(env.settle_prize(order, None, &c).is_err(), "USD cannot enter a gold pool");
    assert!(err(env.refund(order)).contains("NotStale"));
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(order).unwrap();
    assert_eq!(env.tokens(&ata(&p, &usd)), 100);
}

/// A box may name an item that was never written. The box saves; every open fails.
#[test]
fn a_box_naming_an_item_that_was_never_written_is_accepted_and_opens_for_nobody() {
    let mut env = setup();
    env.upsert_box(9, PRICE, vec![], vec![item_drop(999, 1)]).unwrap();
    assert!(err(env.open_box(9, 1)).contains("AccountOwnedByWrongProgram"));
}

/// A failed order could be refunded and bought again at the same
/// nonce in one transaction, in the slot of the first purchase, and then both orders had the
/// same ticket: a second delivery of the FIRST request's answer would have been taken for the
/// new order. An order now closes only from the slot after its purchase, so the new order is
/// always in a later slot, with another ticket, and the old answer is refused.
#[test]
fn a_rebuy_at_the_same_nonce_never_shares_the_first_orders_ticket() {
    let mut env = setup();
    let p = env.player.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let order = order_pda(&env.game, &p.pubkey(), 1);
    env.open_box(1, 1).unwrap();
    env.upsert_box(1, PRICE, vec![burn(2_000)], vec![item_drop(1, 1), item_drop(2, 1)]).unwrap();
    let first = env.callback_ix(scoped_identity(), order, rnd(0));
    env.send_unsigned(&[first.clone()], &keeper).unwrap();
    assert_eq!(env.acc::<Order>(&order).status, OrderStatus::Failed);
    let slot = env.acc::<Order>(&order).requested_slot;

    // In the slot of its purchase the order cannot close, so it cannot be bought again either.
    assert!(err(env.send(&[env.refund_ix(order), env.open_box_ix(1, 1)], &[&keeper, &p])).contains("NotStale"));
    env.wait_slots(1);
    env.send(&[env.refund_ix(order), env.open_box_ix(1, 1)], &[&keeper, &p]).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.status, o.box_version, o.requested_slot), (OrderStatus::Pending, 1, slot + 1));
    // The first request's answer, delivered again (only the oracle's signer could), names the
    // first purchase's ticket.
    assert!(err(env.send_unsigned(&[first], &keeper)).contains("BadOrderState"));
    assert_eq!(env.acc::<Order>(&order).status, OrderStatus::Pending);
}

/// Eight entries at the largest weight, with stock odds on a limited item, roll without
/// overflow (the sum is 8 × 2^32 in u64). A box that lists one item twice reserves one serial
/// whichever entry wins, and the item is minted once.
#[test]
fn callback_weights_at_u32_max_and_an_item_listed_twice() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let mut entries = vec![DropEntry { outcome: Outcome::Nothing, weight: u32::MAX }; 7];
    entries.push(item_drop(1, u32::MAX)); // supply 2
    env.upsert_box_args(8, BoxArgs { stock_odds: true, ..box_args(PRICE, None, vec![], entries) }).unwrap();
    let w = u32::MAX as u64;
    // u64::MAX = (2^32 - 1)(2^32 + 1), so u64::MAX % (8 w) = w: the second entry.
    let order = order_pda(&env.game, &p, 1);
    env.open_box(8, 1).unwrap();
    env.callback_of(8, order, rnd(u64::MAX)).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.outcome, o.serial, env.item_state(1).issued), (Outcome::Nothing, 0, 0));
    // 7 w lands on the eighth entry, the item: serial 1.
    let order = order_pda(&env.game, &p, 2);
    env.open_box(8, 2).unwrap();
    env.callback_of(8, order, rnd(7 * w)).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.outcome, o.serial, env.item_state(1).issued), (Outcome::Item(1), 1, 1));

    env.upsert_box(7, PRICE, vec![], vec![item_drop(1, 1), item_drop(1, 1)]).unwrap();
    let order = order_pda(&env.game, &p, 3);
    env.open_box(7, 3).unwrap();
    env.callback_of(7, order, rnd(1)).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.outcome, o.serial, env.item_state(1).issued), (Outcome::Item(1), 2, 2));
    env.settle(order, &keeper).unwrap();
    assert!(err(env.open_box(7, 4)).contains("SoldOut"));
}

/// `open_box` reads the entries' accounts first and treats the rest as a hook's; an account
/// slipped in before them is read as an entry's and refused.
#[test]
fn open_box_entry_accounts_cannot_be_displaced_by_hook_accounts() {
    let mut env = setup();
    let p = env.player.insecure_clone();
    let mut ix = env.open_box_ix(1, 1);
    let n = ix.accounts.len();
    ix.accounts.insert(n - 2, AccountMeta::new(env.game, false));
    assert!(err(env.send(&[ix], &[&p])).contains("AccountDidNotDeserialize"));
    let mut ix = env.open_box_ix(1, 1);
    ix.accounts.insert(n - 2, AccountMeta::new(env.player.pubkey(), false));
    assert!(err(env.send(&[ix], &[&p])).contains("AccountOwnedByWrongProgram"));
    let mut ix = env.open_box_ix(1, 1);
    ix.accounts.truncate(n - 1);
    assert!(err(env.send(&[ix], &[&p])).contains("ItemMismatch"));
    assert!(!env.exists(&order_pda(&env.game, &p.pubkey(), 1)));
}

/// A box in another currency with `Nothing` settles without touching the treasury (its shares
/// take all); a `Burn` outcome burns exactly `paid` from the vault; neither can be sent to the
/// item settle, and an item order cannot be sent to the prize settle.
#[test]
fn prize_and_item_settles_cannot_be_swapped_and_the_treasury_is_left_alone() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let coin = env.new_mint_2022(None, None);
    env.fund(p, coin, 10_000);
    env.open_pool(&owner, 1, coin).unwrap();
    let entries = vec![nothing(), DropEntry { outcome: Outcome::Burn, weight: 1 }, item_drop(2, 1)];
    env.upsert_box_args(9, box_args(1_000, Some(coin), vec![pool(1, 10_000)], entries)).unwrap();
    let orders: Vec<Pubkey> = (1..=3).map(|n| order_pda(&env.game, &p, n)).collect();
    for (i, order) in orders.iter().enumerate() {
        env.open_box(9, i as u64 + 1).unwrap();
        env.callback_of(9, *order, rnd(i as u64)).unwrap();
    }
    let treasury = env.tokens(&env.treasury);
    assert!(err(env.settle(orders[0], &keeper)).contains("WrongSettle"));
    assert!(err(env.settle(orders[1], &keeper)).contains("WrongSettle"));
    assert!(err(env.settle_prize(orders[2], None, &keeper)).contains("WrongSettle"));
    let supply = env.supply(&coin);
    env.settle_prize(orders[0], None, &keeper).unwrap();
    env.settle_prize(orders[1], None, &keeper).unwrap();
    assert_eq!((env.tokens(&pool_pda(&env.game, 1)), supply - env.supply(&coin)), (1_000, 1_000));
    assert_eq!(env.tokens(&env.treasury), treasury);
    // The normal item: nobody but the game's keys, and the treasury (game mint) is not where
    // a coin box pays.
    assert!(err(env.settle(orders[2], &keeper)).contains("NotTheGames"));
    let authority = env.authority.insecure_clone();
    env.settle(orders[2], &authority).unwrap();
    assert_eq!((env.tokens(&pool_pda(&env.game, 1)), env.tokens(&ata(&env.game, &coin))), (2_000, 0));
}

#[test]
fn the_authority_rolls_a_number_for_any_rule() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let draw = [42u8; 32]; // the game's label: this week's lottery draw

    // The real oracle program takes the request, from the authority only.
    assert!(err(env.roll(&owner, draw)).contains("NotAuthority"));
    env.roll(&authority, draw).unwrap();
    assert_eq!(env.fees(), FEE);

    // Only the oracle answers.
    let ix = env.random_ix(c.pubkey(), draw, rnd(7));
    assert!(env.send_unsigned(&[ix], &c).is_err());
    // Its answer is a receipt with the label and the number, and nothing else changes.
    let logs = env.random(draw, rnd(7)).unwrap();
    let rolled: loot::receipts::Rolled = receipt(&logs);
    assert_eq!((rolled.game, rolled.reference, rolled.randomness), (env.game, draw, rnd(7)));
}

/// The creator's example: a player pays in the game's token, and a roll decides what becomes
/// of it. 40% it is burned, 20% it becomes an NFT, 30% it pays out in USD, 10% in SOL.
/// The odds are the box's own bytes, and the program carries out every outcome: a keeper who
/// holds no key of the game sends the settles, and the authority signs nothing.
#[test]
fn a_box_whose_roll_burns_mints_or_pays_in_another_currency() {
    use loot::state::{DropEntry, Order, Outcome};
    const USD: u8 = 1;
    const SOL: u8 = 2;
    let mut env = setup();
    let (owner, keeper) = (env.creator.insecure_clone(), env.cranker.insecure_clone());
    let player = env.player.pubkey();
    let (usd, sol) = (env.new_mint(owner.pubkey()), env.new_mint(owner.pubkey())); // stand-ins
    env.open_pool(&owner, USD, usd).unwrap();
    env.open_pool(&owner, SOL, sol).unwrap();
    env.fund(owner.pubkey(), usd, 1_000);
    env.fund(owner.pubkey(), sol, 1_000);
    env.deposit(&owner, USD, usd, 1_000).unwrap();
    env.deposit(&owner, SOL, sol, 1_000).unwrap();
    let (player_usd, player_sol) = (env.token_account(player, usd), env.token_account(player, sol));

    env.upsert_item(11, item(ItemKind::Collectible, "Lucky Charm", 0, 0)).unwrap();
    let entries = vec![
        DropEntry { outcome: Outcome::Burn, weight: 40 },
        item_drop(11, 20),
        pay_drop(USD, 30, 30),
        pay_drop(SOL, 5, 10),
    ];
    env.upsert_box(1, PRICE, vec![], entries).unwrap();

    // One purchase per outcome: a roll of 0..40 burns, 40..60 mints, 60..90 pays USD, 90..100 SOL.
    let supply = env.supply(&env.mint);
    for (nonce, roll) in [(1u64, 39u64), (2, 40), (3, 89), (4, 99)] {
        let order = order_pda(&env.game, &player, nonce);
        env.open_box(1, nonce).unwrap();
        env.callback(order, rnd(roll)).unwrap();
        match env.acc::<Order>(&order).outcome {
            Outcome::Item(_) => {
                let asset = env.asset_pda(&order);
                env.settle(order, &keeper).unwrap();
                assert!(env.exists(&asset));
            }
            Outcome::Pay { pool: USD, .. } => drop(env.settle_prize(order, Some(player_usd), &keeper).unwrap()),
            Outcome::Pay { .. } => drop(env.settle_prize(order, Some(player_sol), &keeper).unwrap()),
            _ => drop(env.settle_prize(order, None, &keeper).unwrap()),
        }
        assert!(!env.exists(&order));
    }
    assert_eq!(supply - env.supply(&env.mint), PRICE, "one whole payment was burned");
    assert_eq!(env.tokens(&env.treasury), 3 * PRICE, "the other three went to the treasury");
    assert_eq!((env.tokens(&player_usd), env.tokens(&player_sol)), (30, 5));
    assert_eq!(env.tokens(&ata(&env.game, &env.mint)), 0, "nothing is left in the vault");
}

#[test]
fn a_prize_goes_only_to_the_player_and_only_from_its_pool() {
    use loot::state::{Order, OrderStatus};
    const PRIZES: u8 = 1;
    let mut env = setup();
    let (owner, keeper, p) = (env.creator.insecure_clone(), env.cranker.insecure_clone(), env.player.insecure_clone());
    env.open_pool(&owner, PRIZES, env.mint).unwrap();
    env.open_pool(&owner, 2, env.mint).unwrap();
    env.fund(owner.pubkey(), env.mint, 100);
    env.deposit(&owner, PRIZES, env.mint, 60).unwrap();
    env.deposit(&owner, 2, env.mint, 40).unwrap();
    assert!(err(env.upsert_box(1, PRICE, vec![], vec![pay_drop(PRIZES, 0, 1)])).contains("BadEntries"));
    env.upsert_box(1, PRICE, vec![], vec![pay_drop(PRIZES, 50, 1)]).unwrap();
    let player_token = ata(&p.pubkey(), &env.mint);
    let thief_token = env.token_account(keeper.pubkey(), env.mint);
    let order = order_pda(&env.game, &p.pubkey(), 1);

    // The entry's pool account is checked when the box is opened.
    let mut ix = env.open_box_ix(1, 1);
    ix.accounts.last_mut().unwrap().pubkey = pool_pda(&env.game, 2);
    assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    env.open_box(1, 1).unwrap();
    env.callback(order, rnd(0)).unwrap();

    // Not to someone else, not from another pool, not through the item settle.
    assert!(err(env.settle(order, &keeper)).contains("WrongSettle"));
    assert!(err(env.settle_prize(order, Some(thief_token), &keeper)).contains("NotThePlayers"));
    assert!(err(env.settle_prize(order, None, &keeper)).contains("NotThePlayers"));
    let mut ix = env.settle_prize_ix(order, Some(player_token));
    let at = ix.accounts.iter().position(|m| m.pubkey == pool_pda(&env.game, PRIZES)).unwrap();
    ix.accounts[at].pubkey = pool_pda(&env.game, 2);
    assert!(err(env.send(&[ix], &[&keeper])).contains("WrongPool"));

    let had = env.tokens(&player_token);
    env.settle_prize(order, Some(player_token), &keeper).unwrap();
    assert_eq!(env.tokens(&player_token) - had, 50);
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZES)), 10);

    // The pool now holds 10, less than the prize: the roll skips it, and with nothing else in
    // the box the order fails and refunds at once.
    let second = order_pda(&env.game, &p.pubkey(), 2);
    assert!(err(env.open_box(1, 3)).contains("SoldOut"));
    env.fund(owner.pubkey(), env.mint, 40);
    env.deposit(&owner, PRIZES, env.mint, 40).unwrap();
    env.open_box(1, 2).unwrap();
    let authority = env.authority.insecure_clone();
    env.payout(&authority, PRIZES, thief_token, 50).unwrap(); // the pool is emptied before the roll
    env.callback(second, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&second).status, OrderStatus::Failed);
    env.refund(second).unwrap();
    assert_eq!(env.tokens(&player_token), had + 50, "the second box cost the player nothing");
}

/// A box whose sale feeds a prize pool: open, roll, settle. Every coin and every lamport is
/// accounted for.
#[test]
fn open_a_box_roll_it_and_settle_into_pools() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let player = env.player.pubkey();
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.upsert_box(1, PRICE, vec![pool(PRIZE, 5_000), burn(1_000)], box_entries()).unwrap();
    let (order, vault) = (order_1(&env), ata(&env.game, &env.mint));
    let had = env.tokens(&ata(&player, &env.mint));
    let supply = env.supply(&env.mint);

    // Open: the price waits in the vault, the asset's rent and the fee wait in the escrow.
    env.open_box(1, 1).unwrap();
    assert_eq!(env.tokens(&ata(&player, &env.mint)), had - PRICE);
    assert_eq!(env.tokens(&vault), PRICE);
    assert_eq!(env.lamports(&escrow_pda(&order)), loot::ESCROW_LAMPORTS + FEE);
    assert_eq!(env.data(&order).len(), Order::SPACE);
    let o: Order = env.acc(&order);
    assert_eq!((o.status, o.paid, o.fee, o.shares.len()), (OrderStatus::Pending, PRICE, FEE, 2));
    assert!(env.settle(order, &keeper).is_err(), "not rolled yet");

    // Roll: 0 of weights [1, 1] picks item 1, the collectible.
    env.callback(order, rnd(0)).unwrap();
    let o: Order = env.acc(&order);
    assert_eq!((o.status, o.outcome, o.serial), (OrderStatus::Rolled, Outcome::Item(1), 1));
    assert_eq!(env.item_state(1).issued, 1);
    assert!(err(env.callback(order, rnd(1))).contains("BadOrderState"), "a roll happens once");

    // Settle: anyone can, and the asset goes to the player.
    let sol = env.lamports(&player);
    let asset = env.asset_pda(&order);
    env.settle(order, &keeper).unwrap();
    let a = asset_of(&env, &asset);
    assert_eq!((a.base.owner, a.base.name.as_str()), (player, "Gecko Crown #1"));
    assert!(a.plugin_list.permanent_freeze_delegate.is_none());
    dump_asset(&env, &asset, "core-asset-tradeable");

    // The payment: 50% to the prize, 10% burned, 40% left for the treasury. The vault is empty.
    assert_eq!(env.tokens(&pool_pda(&env.game, PRIZE)), PRICE / 2);
    assert_eq!(supply - env.supply(&env.mint), PRICE / 10);
    assert_eq!(env.tokens(&env.treasury), PRICE * 4 / 10);
    assert_eq!(env.tokens(&vault), 0);
    // The SOL: the fee to the platform, the asset's rent to the asset, everything else (the
    // order's rent and the escrow's change) back to the player.
    assert_eq!(env.fees(), FEE);
    assert!(!env.exists(&order) && !env.exists(&escrow_pda(&order)));
    let back = env.lamports(&player) - sol;
    assert_eq!(back, env.rent(Order::SPACE) + loot::ESCROW_LAMPORTS - env.lamports(&asset));
}

#[test]
fn only_the_oracle_rolls() {
    let mut env = setup();
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    let c = env.cranker.insecure_clone();

    // Signed by someone who is not the oracle's identity for this program.
    for identity in [c.pubkey(), Pubkey::find_program_address(&[b"identity"], &VRF).0] {
        let ix = env.callback_ix(identity, order, rnd(0));
        assert!(env.send_unsigned(&[ix], &c).is_err());
    }
    // The right identity with the wrong items.
    let mut ix = env.callback_ix(scoped_identity(), order, rnd(0));
    ix.accounts.swap(4, 5);
    assert!(err(env.send_unsigned(&[ix], &c)).contains("ItemMismatch"));
    let o: Order = env.acc(&order);
    assert_eq!(o.status, OrderStatus::Pending);
}

/// Everything in the box is sold out when the roll arrives: the player gets all of it back, at
/// once, and the platform takes no fee.
#[test]
fn a_failed_roll_refunds_everything() {
    let mut env = setup();
    let player = env.player.pubkey();
    // One item, supply 1, in a box of its own; two players' worth of orders.
    env.upsert_item(5, item(ItemKind::Collectible, "Last One", 1, 0)).unwrap();
    env.upsert_box(1, PRICE, vec![], vec![item_drop(5, 1)]).unwrap();
    let (first, second) = (order_1(&env), order_pda(&env.game, &player, 2));
    let had = env.tokens(&ata(&player, &env.mint));
    env.open_box(1, 1).unwrap();
    env.open_box(1, 2).unwrap();
    env.callback(first, rnd(0)).unwrap();
    env.callback(second, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&second).status, OrderStatus::Failed);
    assert!(err(env.open_box(1, 3)).contains("SoldOut"));

    let sol = env.lamports(&player);
    env.refund(second).unwrap();
    assert!(!env.exists(&second) && !env.exists(&escrow_pda(&second)));
    assert_eq!(env.tokens(&ata(&player, &env.mint)), had - PRICE, "only the first order's price is out");
    // All the SOL the order held: its rent, the asset's rent and the fee that was never due.
    assert_eq!(env.lamports(&player) - sol, env.rent(Order::SPACE) + loot::ESCROW_LAMPORTS + FEE);
    assert_eq!(env.fees(), 0);
}

#[test]
fn a_roll_that_never_arrives_refunds_after_ten_minutes() {
    let mut env = setup();
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    assert!(err(env.refund(order)).contains("NotStale"));
    env.wait_slots(loot::STALE_SLOTS);
    assert!(err(env.refund(order)).contains("NotStale"));
    env.wait_slots(1);
    env.refund(order).unwrap();
    assert_eq!(env.tokens(&ata(&env.game, &env.mint)), 0);
    assert_eq!(env.fees(), 0);
}

/// A box is its odds. An order paid for one version of a box is never rolled on another: it
/// fails, and the player is refunded at once.
#[test]
fn an_order_is_not_rolled_on_a_box_that_was_edited_after_it_was_paid() {
    let mut env = setup();
    let player = env.player.pubkey();
    let had = env.tokens(&ata(&player, &env.mint));
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    env.upsert_box(1, PRICE, vec![], vec![item_drop(2, 1), item_drop(1, 1_000)]).unwrap();
    env.upsert_box(1, PRICE, vec![burn(2_000)], box_entries()).unwrap(); // even edited back

    env.callback(order, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&order).status, OrderStatus::Failed);
    assert_eq!(env.item_state(1).issued, 0, "no serial was handed out");
    env.refund(order).unwrap();
    assert_eq!(env.tokens(&ata(&player, &env.mint)), had);
}

/// A mythic of 11 and a common with no limit, at equal weights. Ten mythics are gone, so with
/// `stock_odds` the last one weighs 1,000 × 1/11, rounded up: 91.
#[test]
fn an_items_odds_shrink_with_what_is_left_of_it() {
    let mut env = setup();
    env.upsert_item(40, item(ItemKind::Collectible, "Mythic", 11, PRICE)).unwrap();
    env.upsert_item(41, item(ItemKind::Collectible, "Common", 0, PRICE)).unwrap();
    for nonce in 1..=9 {
        env.buy(40, nonce).unwrap();
    }
    let entries = vec![item_drop(40, 1_000), item_drop(41, 1_000)];
    env.upsert_box_args(7, boxed(PRICE, entries.clone())).unwrap();
    env.upsert_box_args(8, BoxArgs { stock_odds: true, ..boxed(PRICE, entries) }).unwrap();
    let p = env.player.pubkey();
    let roll = |env: &mut Env, box_id, nonce, number| {
        env.open_box(box_id, nonce).unwrap();
        env.callback_of(box_id, order_pda(&env.game, &p, nonce), rnd(number)).unwrap();
        env.acc::<Order>(&order_pda(&env.game, &p, nonce)).outcome
    };

    // In the plain box, 150 is a mythic (150 < 1,000): the tenth.
    assert_eq!(roll(&mut env, 7, 20, 150), Outcome::Item(40));
    // With stock odds, the same 150 is a common (the mythic is 91 of 1,091), and 90 still
    // wins the last mythic.
    assert_eq!(roll(&mut env, 8, 21, 150), Outcome::Item(41));
    assert_eq!(roll(&mut env, 8, 22, 90), Outcome::Item(40));
    assert_eq!(env.item_state(40).issued, 11);
}

/// A progressive jackpot: every box that misses feeds the pool, and a hit takes half of it.
#[test]
fn a_box_prize_can_be_a_share_of_what_a_pool_holds() {
    let mut env = setup();
    let c = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    jackpot(&mut env, 1, 1_000);
    let entries = vec![DropEntry { outcome: Outcome::Share { pool: 1, bps: 5_000 }, weight: 1 }, DropEntry { outcome: Outcome::Nothing, weight: 1 }];
    let args = BoxArgs { shares: vec![pool(1, 10_000)], ..boxed(100, entries.clone()) };
    for bps in [0, 10_001] {
        let bad = vec![DropEntry { outcome: Outcome::Share { pool: 1, bps }, weight: 1 }];
        assert!(err(env.upsert_box_args(9, BoxArgs { entries: bad, ..args.clone() })).contains("BadEntries"));
    }
    env.upsert_box_args(9, args).unwrap();

    // A miss: the 100 paid goes into the jackpot.
    env.open_box(9, 1).unwrap();
    env.callback_of(9, order_pda(&env.game, &p, 1), rnd(1)).unwrap();
    env.settle_prize(order_pda(&env.game, &p, 1), None, &c).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 1)), 1_100);

    // A hit: half of what the pool holds at the roll, fixed in the order then. This payment
    // joins the pool at the settle and stays for the next winner.
    let before = my_coins(&env, &p);
    env.open_box(9, 2).unwrap();
    env.callback_of(9, order_pda(&env.game, &p, 2), rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&order_pda(&env.game, &p, 2)).outcome, Outcome::Pay { pool: 1, amount: 550 });
    env.settle_prize(order_pda(&env.game, &p, 2), Some(ata(&p, &env.mint)), &c).unwrap();
    assert_eq!((my_coins(&env, &p) + 100 - before, env.tokens(&pool_pda(&env.game, 1))), (550, 650));

    // A share of an empty pool is nothing to win, and a box with nothing else is sold out.
    jackpot(&mut env, 2, 0);
    env.upsert_box_args(10, boxed(100, vec![DropEntry { outcome: Outcome::Share { pool: 2, bps: 5_000 }, weight: 1 }])).unwrap();
    assert!(err(env.open_box(10, 3)).contains("SoldOut"));
}

/// An order's address depends only on
/// (game, player, nonce) and is free again once the order closes, so a roll asked for a
/// refunded order used to be accepted by a new order at the same nonce, with randomness the
/// player had already seen. A roll now carries the ticket of its own purchase (the order and
/// the slot it was paid in), and an order takes only its own.
#[test]
fn a_late_roll_does_not_land_on_a_new_order_at_the_same_nonce() {
    let mut env = setup();
    let c = env.cranker.insecure_clone();
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();
    // The oracle's answer to this purchase, which arrives late.
    let late = env.callback_ix(scoped_identity(), order, rnd(0));
    env.wait_slots(loot::STALE_SLOTS + 1);
    env.refund(order).unwrap();
    assert!(env.send_unsigned(&[late.clone()], &c).is_err());

    // The player likes what they saw and opens the same nonce again.
    env.open_box(1, 1).unwrap();
    assert!(err(env.send_unsigned(&[late], &c)).contains("BadOrderState"));
    assert_eq!(env.acc::<Order>(&order).status, OrderStatus::Pending);
    // The new purchase's own roll is taken.
    env.callback(order, rnd(1)).unwrap();
}

/// The roll is only as good as who may ask for one. `callback_roll` trusts any callback the VRF
/// program signs for this program, so the VRF program must take requests for loot's callback
/// from loot alone. It does: a request sent straight to the VRF program, naming loot's
/// `callback_roll` and an order of the sender's choice, is refused unless loot's own identity
/// PDA signs it (and only loot can sign for that).
#[test]
fn nobody_else_can_ask_the_oracle_to_roll_an_order() {
    let mut env = setup();
    let attacker = funded(&mut env);
    let order = order_1(&env);
    env.open_box(1, 1).unwrap();

    let the_box = box_pda(&env.game, 1);
    let request = |identity: Pubkey| {
        let mut data = vec![10u8]; // scoped request, as `#[vrf]` sends it
        let sdk = ephemeral_rollups_sdk::vrf::instructions::create_request_randomness_ix(
            ephemeral_rollups_sdk::vrf::instructions::RequestRandomnessParams {
                payer: attacker.pubkey(),
                oracle_queue: QUEUE,
                callback_program_id: loot::ID,
                callback_discriminator: loot::instruction::CallbackRoll::DISCRIMINATOR.to_vec(),
                caller_seed: [42; 32], // a seed the attacker ground offline
                accounts_metas: Some(vec![
                    ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta { pubkey: order, is_signer: false, is_writable: true },
                    ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta { pubkey: the_box, is_signer: false, is_writable: false },
                ]),
                ..Default::default()
            },
        );
        data.extend_from_slice(&sdk.data[1..]);
        Instruction::new_with_bytes(
            VRF,
            &data,
            vec![
                AccountMeta::new(attacker.pubkey(), true),
                AccountMeta::new_readonly(identity, true),
                AccountMeta::new(QUEUE, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(SLOT_HASHES, false),
            ],
        )
    };
    // With the attacker's own key as the "program identity": it really signs, and is refused.
    let ix = request(attacker.pubkey());
    assert!(env.send(&[ix], &[&attacker]).is_err());
    // Control: the same bytes with loot's identity are accepted when that PDA is taken as having
    // signed (sigverify is off in this harness; on a cluster only loot can sign for it). This
    // proves the request above was refused for its identity and not for its shape.
    let ix = request(pda(&[b"identity"]));
    env.send_unsigned(&[ix], &attacker).unwrap();
}

/// A box is not an item, and an item is not a box: the one-byte tags keep the hand-read
/// `ItemView` and the typed accounts apart.
#[test]
fn an_item_and_a_box_are_never_taken_for_each_other() {
    let mut env = setup();
    let (p, c, keeper) = (env.player.insecure_clone(), env.cranker.insecure_clone(), env.cranker.insecure_clone());
    let (the_box, item_1) = (box_pda(&env.game, 1), item_pda(&env.game, 1));

    // open_box with the box where an item should be.
    let mut ix = env.open_box_ix(1, 1);
    ix.accounts.last_mut().unwrap().pubkey = the_box;
    assert!(err(env.send(&[ix], &[&p])).contains("AccountDidNotDeserialize"));
    // open_box with an item where the box should be.
    let mut ix = env.open_box_ix(1, 1);
    ix.accounts[0].pubkey = item_1;
    assert!(env.send(&[ix], &[&p]).is_err());
    // buy_item with a box where the item should be.
    let mut ix = env.buy_ix(3, 1);
    ix.accounts[0].pubkey = the_box;
    assert!(env.send(&[ix], &[&p]).is_err());

    env.open_box(1, 1).unwrap();
    let order = order_1(&env);
    // The roll with the box in an item's place.
    let mut ix = env.callback_ix(scoped_identity(), order, rnd(0));
    ix.accounts[4].pubkey = the_box;
    assert!(err(env.send_unsigned(&[ix], &c)).contains("AccountDidNotDeserialize"));
    env.callback(order, rnd(0)).unwrap();

    // settle with another item, or the box, in the item's place.
    for wrong in [item_pda(&env.game, 3), the_box] {
        let mut ix = env.settle_ix(order, keeper.pubkey());
        let at = ix.accounts.iter().position(|m| m.pubkey == item_1).unwrap();
        ix.accounts[at].pubkey = wrong;
        assert!(env.send(&[ix], &[&keeper]).is_err());
    }
    // The refund of a rolled order with the box as its item.
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    let mut ix = env.refund_ix(order);
    ix.accounts.last_mut().unwrap().pubkey = the_box;
    assert!(err(env.send(&[ix], &[&c])).contains("AccountDidNotDeserialize"));
    assert_eq!(env.item_state(1).issued, 1);
}

/// MEDIUM, fixed. A paid box order was rolled against the box as it was when the oracle
/// answered, so an edit between the payment and the answer changed the odds and prizes of a
/// purchase already made. A box now counts its edits, and an order paid for another
/// version is not rolled at all: it fails, and the player is refunded at once.
#[test]
fn a_box_edited_after_the_purchase_refunds_that_purchase() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.open_pool(&owner, 0, env.mint).unwrap();
    env.fund(owner.pubkey(), env.mint, 1_000);
    env.deposit(&owner, 0, env.mint, 1_000).unwrap();
    env.upsert_box(1, PRICE, vec![], vec![pay_drop(0, 500, 1), nothing_weighing(1)]).unwrap();
    env.wait_slots(1);

    let had = env.tokens(&ata(&env.player.pubkey(), &env.mint));
    env.open_box(1, 1).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    env.wait_slots(1);
    env.upsert_box(1, PRICE, vec![], vec![pay_drop(0, 1, 1), nothing_weighing(1_000_000)]).unwrap();
    env.callback(order, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&order).status, loot::state::OrderStatus::Failed);
    env.refund(order).unwrap();
    assert_eq!(env.tokens(&ata(&env.player.pubkey(), &env.mint)), had);

    // A purchase made after the edit is rolled on the box as it is now.
    env.wait_slots(1);
    env.open_box(1, 2).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 2);
    env.callback(order, rnd(0)).unwrap();
    assert_eq!(env.acc::<Order>(&order).outcome, Outcome::Pay { pool: 0, amount: 1 });
}

/// LOW, fixed. An order is only rolled on the version of the box it paid for, and fails at
/// once on any other. That was true only when the edit left the entries' accounts as they
/// were: the roll read the edited entries against the purchase's accounts before it looked at
/// the version, so an edit that named another item made the oracle's answer itself fail and
/// the player waited out 1,500 slots. Now the version is looked at first.
#[test]
fn a_box_edit_that_changes_an_entry_fails_the_order_at_once() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();

    // An edit of the price alone: the order fails at once, as the document says.
    env.open_box(1, 1).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    let answer = env.callback_ix_of(1, scoped_identity(), order, rnd(0));
    env.upsert_box(1, PRICE * 2, vec![burn(2_000)], vec![item_drop(1, 1), item_drop(2, 1)]).unwrap();
    env.wait_slots(1); // the oracle answers in a later slot
    env.send_unsigned(&[answer], &keeper).unwrap();
    assert_eq!(env.acc::<loot::state::Order>(&order).status, OrderStatus::Failed);
    env.refund(order).unwrap();

    // An edit that swaps an entry for another item: the oracle's answer is refused.
    env.open_box(1, 2).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 2);
    let answer = env.callback_ix_of(1, scoped_identity(), order, rnd(0));
    env.upsert_box(1, PRICE * 2, vec![burn(2_000)], vec![item_drop(3, 1), item_drop(2, 1)]).unwrap();
    env.wait_slots(1);
    env.send_unsigned(&[answer], &keeper).unwrap();
    assert_eq!(env.acc::<loot::state::Order>(&order).status, OrderStatus::Failed);
    env.refund(order).unwrap();
}

/// A `Share` box prize was sized when the order was settled, and
/// anyone may settle any order in any sequence: two orders that rolled the same 100% jackpot
/// both counted as hits, whoever was settled first took the pool, and the other, who hit
/// first, was settled for nothing with no refund. The two receipts were the same.
///
/// Now the roll turns a share into `Pay` with the amount it is of the pool at the roll, so it
/// is paid like any fixed prize: a settle the pool cannot pay fails, and that order refunds
/// after 7 days. (Two hits on one pool before either settles is the same race every fixed
/// prize already has; a keeper settles right after the roll.)
#[test]
fn a_share_prize_is_fixed_at_the_roll() {
    let mut env = setup();
    let c = env.cranker.insecure_clone();
    jackpot(&mut env, 1, 1_000);
    let jackpot_entry = DropEntry { outcome: Outcome::Share { pool: 1, bps: 10_000 }, weight: 1 };
    env.upsert_box_args(20, boxed(100, vec![jackpot_entry])).unwrap();
    let a = env.player.insecure_clone();
    let b = player(&mut env, 1_000);

    let order_a = open_as(&mut env, &a, 20, 1, 0);
    let order_b = open_as(&mut env, &b, 20, 1, 0);
    let won = Outcome::Pay { pool: 1, amount: 1_000 };
    assert_eq!((env.acc::<Order>(&order_a).outcome, env.acc::<Order>(&order_b).outcome), (won, won), "each order names its amount");

    // B is settled first and paid. A's settle fails, and A gets their payment back.
    let b_before = my_coins(&env, &b.pubkey());
    let rb: OrderSettled = receipt(&env.settle_prize(order_b, Some(ata(&b.pubkey(), &env.mint)), &c).unwrap());
    assert_eq!((my_coins(&env, &b.pubkey()) - b_before, rb.outcome), (1_000, won));
    assert!(env.settle_prize(order_a, Some(ata(&a.pubkey(), &env.mint)), &c).is_err());
    let a_before = my_coins(&env, &a.pubkey());
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(order_a).unwrap();
    assert_eq!(my_coins(&env, &a.pubkey()) - a_before, 100);
}

/// A winner who held their order unsettled while later
/// players fed the pool used to take what those players paid in. Now they take what they won.
#[test]
fn a_share_winner_cannot_wait_for_the_jackpot_to_grow() {
    let mut env = setup();
    let c = env.cranker.insecure_clone();
    jackpot(&mut env, 1, 1_000);
    let entries = vec![DropEntry { outcome: Outcome::Share { pool: 1, bps: 10_000 }, weight: 1 }, DropEntry { outcome: Outcome::Nothing, weight: 1 }];
    env.upsert_box_args(21, BoxArgs { shares: vec![pool(1, 10_000)], ..boxed(100, entries) }).unwrap();
    let a = env.player.insecure_clone();
    let b = player(&mut env, 1_000);

    let order_a = open_as(&mut env, &a, 21, 1, 0);
    assert_eq!(env.acc::<Order>(&order_a).outcome, Outcome::Pay { pool: 1, amount: 1_000 });
    for nonce in 1..=5 {
        let order = open_as(&mut env, &b, 21, nonce, 1);
        env.settle_prize(order, None, &c).unwrap();
    }
    assert_eq!(env.tokens(&pool_pda(&env.game, 1)), 1_500);
    let before = my_coins(&env, &a.pubkey());
    env.settle_prize(order_a, Some(ata(&a.pubkey(), &env.mint)), &c).unwrap();
    assert_eq!(my_coins(&env, &a.pubkey()) - before, 1_000, "the jackpot as it was when A hit it");
    assert_eq!(env.tokens(&pool_pda(&env.game, 1)), 600, "B's 500 and A's own 100 stay for the next winner");
}

/// The weight arithmetic at its edges: no overflow, never above the weight, 0 only when none
/// is left, at least 1 while one is.
#[test]
fn stock_odds_at_the_edges() {
    assert_eq!(by_stock(u32::MAX, 1, 0), u32::MAX);
    assert_eq!(by_stock(u32::MAX, u32::MAX, u32::MAX - 1), 1);
    assert_eq!(by_stock(1, u32::MAX, 0), 1);
    assert_eq!(by_stock(1, u32::MAX, u32::MAX - 1), 1);
    assert_eq!(by_stock(7, 10, 11), 0, "more issued than the supply: nothing left");
    assert_eq!(by_stock(7, 0, u32::MAX), 7);
    for weight in [1u32, 2, 3, 999, u32::MAX] {
        for max in [1u32, 2, 7, 100, u32::MAX] {
            for issued in [0u32, 1, max / 2, max.saturating_sub(1), max] {
                let w = by_stock(weight, max, issued);
                assert!(w <= weight);
                assert_eq!(w == 0, issued >= max);
            }
        }
    }
}

/// A sold-out item in a `stock_odds` box is skipped like in any box, and the other entries keep
/// their weights.
#[test]
fn a_stock_odds_box_skips_what_is_sold_out() {
    let mut env = setup();
    env.upsert_item(40, item(ItemKind::Collectible, "Mythic", 1, PRICE)).unwrap();
    env.upsert_item(41, item(ItemKind::Collectible, "Common", 0, PRICE)).unwrap();
    env.buy(40, 1).unwrap();
    env.upsert_box_args(8, BoxArgs { stock_odds: true, ..boxed(PRICE, vec![item_drop(40, u32::MAX), item_drop(41, 1)]) }).unwrap();
    let p = env.player.insecure_clone();
    for (nonce, number) in [(2, 0), (3, u64::MAX)] {
        let order = open_as(&mut env, &p, 8, nonce, number);
        assert_eq!(env.acc::<Order>(&order).outcome, Outcome::Item(41));
    }
}

/// A box priced in another mint can carry a `Share` of a pool in the game's mint: the prize is
/// paid in the pool's mint, only to an account of the player in that mint.
#[test]
fn a_share_from_a_box_in_another_currency_pays_in_the_pools_mint() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let c = env.cranker.insecure_clone();
    let gems = env.new_mint(owner.pubkey());
    jackpot(&mut env, 1, 1_000);
    let p = env.player.insecure_clone();
    env.fund(p.pubkey(), gems, 100);
    let entries = vec![DropEntry { outcome: Outcome::Share { pool: 1, bps: 5_000 }, weight: 1 }];
    let args = BoxArgs { currency: Some(gems), shares: vec![burn(10_000)], ..boxed(10, entries) };
    env.upsert_box_args(30, args).unwrap();
    let order = open_as(&mut env, &p, 30, 1, 0);
    assert!(env.settle_prize(order, Some(ata(&p.pubkey(), &gems)), &c).is_err(), "not into the player's gem account");
    let stranger = player(&mut env, 0);
    assert!(err(env.settle_prize(order, Some(ata(&stranger.pubkey(), &env.mint)), &c)).contains("NotThePlayers"));
    let before = my_coins(&env, &p.pubkey());
    env.settle_prize(order, Some(ata(&p.pubkey(), &env.mint)), &c).unwrap();
    assert_eq!((my_coins(&env, &p.pubkey()) - before, env.tokens(&ata(&p.pubkey(), &gems))), (500, 90));
}
