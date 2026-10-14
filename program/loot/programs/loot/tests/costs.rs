//! Compute units and rent of every instruction and account, printed as tables.
mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    loot::Action,
    loot::ContestArgs,
    loot::Input,
    loot::ItemArgs,
    loot::Keep,
    loot::LotteryArgs,
    loot::Origin,
    loot::Output,
    loot::RecipeArgs,
    loot::ScheduleArgs,
    loot::state::DropEntry,
    loot::state::ItemKind,
    loot::state::Life,
    loot::state::Order,
    loot::state::Outcome,
    loot::state::Platform,
    loot::state::Share,
    loot::state::To,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
};

/// Who holds `ticket` in lottery `id`: the same binary search the program does, over the
/// 40-byte lines behind the record.
fn loot_holder(env: &Env, id: u32, ticket: u64) -> Pubkey {
    let data = env.data(&env.mechanic_pda(loot::LOTTERY_SEED, id));
    let head = 1 + <loot::Lottery as anchor_lang::Space>::INIT_SPACE;
    let lines = &data[head..];
    let n = lines.len() / 40;
    for i in 0..n {
        let end = u64::from_le_bytes(lines[i * 40 + 32..i * 40 + 40].try_into().unwrap());
        if end > ticket {
            return Pubkey::new_from_array(lines[i * 40..i * 40 + 32].try_into().unwrap());
        }
    }
    panic!("no holder");
}

/// Wire size of a legacy transaction: signatures, then the message.
fn tx_bytes(env: &Env, ixs: &[anchor_lang::solana_program::instruction::Instruction], payer: &Pubkey, signers: usize) -> usize {
    let msg = Message::new_with_blockhash(ixs, Some(payer), &env.svm.latest_blockhash());
    1 + 64 * signers + msg.serialize().len()
}

/// Labels the last transaction that landed.
fn mark(env: &mut Env, label: &str) {
    env.cus.last_mut().unwrap().0 = format!("* {label}");
}

fn bare_collectible(name: &str) -> ItemArgs {
    ItemArgs { shares: vec![], ..item(ItemKind::Collectible, name, 0, 0) }
}

trait CraftLogs {
    fn ix_craft_logs(&mut self, who: &Keypair, id: u32, assets: &[Pubkey]) -> Vec<String>;
}

impl CraftLogs for Env {
    fn ix_craft_logs(&mut self, who: &Keypair, id: u32, assets: &[Pubkey]) -> Vec<String> {
        let version = self.acc::<loot::Recipe>(&self.mechanic_pda(loot::RECIPE_SEED, id)).version;
        let (ix, made) = self.craft_ix(who.pubkey(), id, version, assets);
        let mut signers = vec![who];
        signers.extend(made.iter());
        self.send(&[compute_limit(1_000_000), ix], &signers).unwrap()
    }
}

#[test]
fn mechanics_cost_table() {
    let mut env = setup();
    let (owner, authority, keeper) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let player = env.player.insecure_clone();
    let player_pk = player.pubkey();
    let coin = env.mint;
    let player_coin = ata(&player_pk, &coin);
    let mut sizes: Vec<(String, usize)> = vec![];

    // ------------------------------------------------------------ settings
    env.open_pool(&owner, 0, coin).unwrap();
    env.open_pool(&owner, 1, coin).unwrap();
    env.fund(owner.pubkey(), coin, 100 * PRICE);
    env.deposit(&owner, 0, coin, 10 * PRICE).unwrap();
    env.token_account(keeper.pubkey(), coin);
    let keeper_coin = ata(&keeper.pubkey(), &coin);

    // Items 10 (shards, burnable inputs), 11 (key, output), 12 (tool with a cooldown), 13 (pass, no life), 14 (a normal item).
    env.upsert_item(10, bare_collectible("Shard")).unwrap();
    env.upsert_item(11, bare_collectible("Key")).unwrap();
    env.upsert_item(12, ItemArgs { life: Some(Life { ready_after: 0, lasts: 0, uses: 0, cooldown: 60 }), ..bare_collectible("Tool") }).unwrap();
    env.upsert_item(13, bare_collectible("Pass")).unwrap();
    env.upsert_item(14, ItemArgs { shares: vec![], ..item(ItemKind::Normal, "Potion", 0, PRICE) }).unwrap();
    // A maximal item: 32-character name, 200-character URI, four shares, rise, fall and life.
    env.upsert_item(
        15,
        ItemArgs {
            name: "N".repeat(32),
            uri: "u".repeat(200),
            shares: vec![pool(0, 1_000), burn(500), pool(1, 500), Share { to: To::Account(keeper_coin), bps: 500 }],
            rise: Some(loot::state::Rise { step: 1, growth_bps: 100 }),
            fall: Some(loot::state::Fall { step: 1, every: 60, floor: 1, since: 0 }),
            life: Some(Life { ready_after: 1, lasts: 2, uses: 3, cooldown: 4 }),
            ..item(ItemKind::Collectible, "x", 0, PRICE)
        },
    )
    .unwrap();
    sizes.push(("Item at its limits (32-char name, 200-char URI, 4 shares, rise, fall, life)".into(), env.data(&item_pda(&env.game, 15)).len()));
    for id in 20..28 {
        env.upsert_item(id, bare_collectible(&format!("Drop {id}"))).unwrap();
    }
    let shard = env.make(&authority, 10, player_pk).unwrap();
    env.cus.pop();

    // ------------------------------------------------------------ orders
    env.buy(3, 1).unwrap();
    mark(&mut env, "BuyItem (collectible, first sale in this mint: the vault is created)");
    env.buy(3, 2).unwrap();
    mark(&mut env, "BuyItem (collectible, vault exists)");
    env.buy(14, 3).unwrap();
    mark(&mut env, "BuyItem (normal item)");
    env.settle(order_pda(&env.game, &player_pk, 3), &owner).unwrap();
    mark(&mut env, "Settle (normal item, no shares)");

    // A box of eight item entries, no shares.
    env.upsert_box(2, PRICE, vec![], (20..28).map(|id| item_drop(id, 1)).collect()).unwrap();
    sizes.push(("Box (8 entries, 0 shares)".into(), env.data(&box_pda(&env.game, 2)).len()));
    let ix = env.open_box_ix(2, 10);
    sizes.push(("tx bytes: OpenBox with 8 item entries".into(), tx_bytes(&env, &[ix], &player_pk, 1)));
    env.open_box(2, 10).unwrap();
    mark(&mut env, "OpenBox (8 item entries, vault exists)");
    let order = order_pda(&env.game, &player_pk, 10);
    env.callback_of(2, order, rnd(3)).unwrap();
    mark(&mut env, "CallbackRoll (8 item entries)");
    env.settle(order, &keeper).unwrap();
    mark(&mut env, "Settle (collectible, 0 shares)");

    // A box with four shares, one to whoever holds a collectible.
    let four = vec![pool(0, 1_000), burn(500), Share { to: To::Account(keeper_coin), bps: 500 }, Share { to: To::Holder(shard), bps: 500 }];
    env.upsert_box(4, PRICE, four.clone(), vec![item_drop(20, 1)]).unwrap();
    env.open_box(4, 11).unwrap();
    mark(&mut env, "OpenBox (1 item entry, 4 shares)");
    let order = order_pda(&env.game, &player_pk, 11);
    env.callback_of(4, order, rnd(0)).unwrap();
    mark(&mut env, "CallbackRoll (1 item entry)");
    let ix = env.settle_ix(order, keeper.pubkey());
    sizes.push(("tx bytes: Settle with 4 shares (one a Holder)".into(), tx_bytes(&env, &[ix], &keeper.pubkey(), 1)));
    env.settle(order, &keeper).unwrap();
    mark(&mut env, "Settle (collectible, 4 shares: pool, burn, account, holder)");

    // Prizes: a payment from a pool, a burn, nothing.
    env.upsert_box(5, PRICE, vec![burn(2_000)], vec![pay_drop(0, 100, 1)]).unwrap();
    env.upsert_box(6, PRICE, vec![burn(2_000)], vec![DropEntry { outcome: Outcome::Burn, weight: 1 }]).unwrap();
    env.upsert_box(7, PRICE, vec![burn(2_000)], vec![DropEntry { outcome: Outcome::Nothing, weight: 1 }]).unwrap();
    for (box_id, nonce, label) in [(5u32, 12u64, "SettlePrize (Pay from a pool, 1 burn share)"), (6, 13, "SettlePrize (Burn)"), (7, 14, "SettlePrize (Nothing, 1 burn share)")] {
        env.open_box(box_id, nonce).unwrap();
        let order = order_pda(&env.game, &player_pk, nonce);
        env.callback_of(box_id, order, rnd(0)).unwrap();
        let prize_to = (box_id == 5).then_some(player_coin);
        env.settle_prize(order, prize_to, &keeper).unwrap();
        mark(&mut env, label);
    }

    // A rolled item order refunded after the deadline (its serial goes back).
    env.buy(3, 15).unwrap();
    env.wait_slots(loot::ROLLED_REFUND_SLOTS + 1);
    env.refund(order_pda(&env.game, &player_pk, 15)).unwrap();
    mark(&mut env, "Refund (rolled item order after 7 days, serial released)");

    // ------------------------------------------------------------ pay
    env.pay(PRICE, vec![]).unwrap();
    mark(&mut env, "Pay (0 shares)");
    env.pay(PRICE, four.clone()).unwrap();
    mark(&mut env, "Pay (4 shares: pool, burn, account, holder)");

    // Token-2022 against classic, for the same deposit.
    let m22 = env.new_mint_2022(None, None);
    env.open_pool(&owner, 8, m22).unwrap();
    env.fund(owner.pubkey(), m22, 1_000);
    env.deposit(&owner, 8, m22, 100).unwrap();
    mark(&mut env, "Deposit (Token-2022 mint, no extensions)");
    env.deposit(&owner, 0, coin, 100).unwrap();
    mark(&mut env, "Deposit (classic mint)");

    // ------------------------------------------------------------ random
    env.roll(&authority, REF).unwrap();
    mark(&mut env, "Roll");
    env.random(REF, rnd(1)).unwrap();
    mark(&mut env, "CallbackRandom");

    // ------------------------------------------------------------ schedules
    let points = env.new_mint(env.game);
    env.open_pool(&owner, 6, points).unwrap();
    env.open_pool(&owner, 7, points).unwrap();
    let (p6, p7) = (pool_pda(&env.game, 6), pool_pda(&env.game, 7));
    let now = env.now();
    env.upsert_schedule(&owner, 1, ScheduleArgs { active: true, action: Action::Issue { mint: points, pool: 6, amount: 1_000_000, halve_every: 0 }, every: DAY, next_at: now, max_runs: 0 }).unwrap();
    mark(&mut env, "UpsertSchedule (new)");
    sizes.push(("Schedule".into(), env.data(&env.mechanic_pda(loot::SCHEDULE_SEED, 1)).len()));
    env.upsert_schedule(&owner, 2, ScheduleArgs { active: true, action: Action::Burn { pool: 6, bps: 1_000 }, every: DAY, next_at: now, max_runs: 0 }).unwrap();
    env.upsert_schedule(&owner, 3, ScheduleArgs { active: true, action: Action::Move { from: 6, to: 7, bps: 1_000 }, every: DAY, next_at: now, max_runs: 0 }).unwrap();
    env.run_schedule(1, points, p6).unwrap();
    mark(&mut env, "RunSchedule (Issue)");
    env.run_schedule(2, points, p6).unwrap();
    mark(&mut env, "RunSchedule (Burn)");
    env.run_schedule(3, p6, p7).unwrap();
    mark(&mut env, "RunSchedule (Move)");

    // ------------------------------------------------------------ lottery
    env.open_pool(&owner, 2, coin).unwrap();
    env.upsert_lottery(&owner, 1, LotteryArgs { price: 10, pot: 2, cut_bps: 1_000, places: vec![5_000, 3_000, 2_000], ticket_mint: Pubkey::default(), every: 7 * DAY, draws_at: env.now() + 7 * DAY }).unwrap();
    mark(&mut env, "UpsertLottery (new)");
    sizes.push(("Lottery (no purchases)".into(), env.data(&env.mechanic_pda(loot::LOTTERY_SEED, 1)).len()));
    let buyers: Vec<Keypair> = (0..3).map(|_| wallet(&mut env, coin, 100_000)).collect();
    env.buy_tickets(&buyers[0], 1, 1, coin).unwrap();
    mark(&mut env, "BuyTickets (first line of the round, 10% cut)");
    for i in 1..60 {
        env.buy_tickets(&buyers[i % 3], 1, 2, coin).unwrap();
    }
    mark(&mut env, "BuyTickets (60th line of the round, 10% cut)");
    sizes.push(("Lottery (60 purchases)".into(), env.data(&env.mechanic_pda(loot::LOTTERY_SEED, 1)).len()));
    env.wait(7 * DAY + 1);
    env.draw_lottery(1).unwrap();
    mark(&mut env, "DrawLottery");
    env.lottery_callback(1, rnd(17)).unwrap();
    mark(&mut env, "CallbackLottery (3 places over 60 lines)");
    for place in 0..3u8 {
        let l = env.lottery(1);
        let winner = loot_holder(&env, 1, l.ticket_of_place(place));
        env.pay_lottery_place(1, place, ata(&winner, &coin)).unwrap();
        mark(&mut env, &["PayLottery (place 1 of 3)", "PayLottery (place 2 of 3)", "PayLottery (last place: list emptied, round reopened)"][place as usize]);
    }

    // ------------------------------------------------------------ stake
    let usd = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 5, usd).unwrap();
    env.fund(owner.pubkey(), usd, 1_000_000);
    env.open_stake(&owner, 1, coin, 5, usd, 0).unwrap();
    mark(&mut env, "OpenStake");
    sizes.push(("Stake".into(), env.data(&env.mechanic_pda(loot::STAKE_SEED, 1)).len()));
    let (a, b) = (wallet(&mut env, coin, 1_000), wallet(&mut env, coin, 1_000));
    env.token_account(a.pubkey(), usd);
    env.token_account(b.pubkey(), usd);
    env.stake(&a, 1, 100, usd).unwrap();
    mark(&mut env, "Stake (first position, nothing in the rewards pool)");
    sizes.push(("Position".into(), env.data(&env.position_pda(1, &a.pubkey())).len()));
    env.deposit(&owner, 5, usd, 1_000).unwrap();
    env.stake(&b, 1, 300, usd).unwrap();
    mark(&mut env, "Stake (new position, rewards arrived: pool -> vault)");
    env.deposit(&owner, 5, usd, 1_000).unwrap();
    env.stake(&a, 1, 100, usd).unwrap();
    mark(&mut env, "Stake (existing position, rewards arrived and owed)");
    env.unstake(&a, 1, 0, usd).unwrap();
    mark(&mut env, "Unstake (0: collect only, nothing new arrived)");
    env.unstake(&a, 1, 200, usd).unwrap();
    mark(&mut env, "Unstake (all: position closed)");

    // ------------------------------------------------------------ contest
    let now = env.now();
    env.open_contest(&authority, 1, coin, ContestArgs { sides: 2, closes_at: now + 600, result_by: now + 1_200, shares: vec![] }).unwrap();
    mark(&mut env, "OpenContest (2 sides, 0 shares)");
    sizes.push(("Contest (2 sides, 0 shares)".into(), env.data(&env.contest_pda(1)).len()));
    env.open_contest(&authority, 2, coin, ContestArgs { sides: 2, closes_at: now + 600, result_by: now + 1_200, shares: vec![burn(500), pool(0, 500)] }).unwrap();
    env.enter(&a, 1, 0, 100).unwrap();
    mark(&mut env, "Enter (new entry)");
    sizes.push(("Entry".into(), env.data(&env.entry_pda(1, &a.pubkey(), 0)).len()));
    env.enter(&b, 1, 1, 100).unwrap();
    env.enter(&a, 1, 0, 50).unwrap();
    mark(&mut env, "Enter (existing entry)");
    env.enter(&a, 2, 0, 100).unwrap();
    env.enter(&b, 2, 1, 100).unwrap();
    env.decide(&authority, 1, 0).unwrap();
    mark(&mut env, "Decide (0 shares)");
    env.decide(&authority, 2, 0).unwrap();
    mark(&mut env, "Decide (2 shares: burn, pool)");
    env.claim(1, a.pubkey(), 0, ata(&a.pubkey(), &coin)).unwrap();
    mark(&mut env, "Claim (winner, last of its side: paid, entry closed)");
    env.claim(1, b.pubkey(), 1, ata(&b.pubkey(), &coin)).unwrap();
    mark(&mut env, "Claim (loser: nothing moves, entry closed)");
    env.close_contest(1).unwrap();
    mark(&mut env, "CloseContest");

    // ------------------------------------------------------------ hold
    let held = env.make(&authority, 10, player_pk).unwrap();
    env.cus.pop();
    env.hold(&player, held, 3_600).unwrap();
    mark(&mut env, "Hold");
    sizes.push(("Hold".into(), env.data(&env.hold_pda(&held)).len()));
    env.award(&authority, held, keeper.pubkey()).unwrap();
    mark(&mut env, "Award");
    let held = env.make(&authority, 10, player_pk).unwrap();
    env.cus.pop();
    env.hold(&player, held, 1).unwrap();
    env.wait(2);
    env.take_back(&keeper, held).unwrap();
    mark(&mut env, "TakeBack");

    // ------------------------------------------------------------ craft
    env.token_account(player_pk, points);
    // (a) tokens only: 2 coins burned for 3 points, once and 100 times.
    env.upsert_recipe(&owner, 1, RecipeArgs { active: true, inputs: vec![Input::Pay { mint: coin, amount: 2, to: To::Burn }], outputs: vec![Output::Tokens { mint: points, amount: 3, from: Origin::Issue }], needs: vec![], keeps: vec![] }).unwrap();
    mark(&mut env, "UpsertRecipe (new, 1 line a side)");
    env.craft_times(&player, 1, 1, &[]).unwrap();
    mark(&mut env, "Craft (tokens only, times = 1)");
    env.craft_times(&player, 1, 100, &[]).unwrap();
    mark(&mut env, "Craft (tokens only, times = 100)");
    // (b) one shard burned for a key.
    env.upsert_recipe(&owner, 2, merge_recipe(10, 1, 11)).unwrap();
    let s1 = env.make(&authority, 10, player_pk).unwrap();
    env.cus.pop();
    env.craft(&player, 2, &[s1]).unwrap();
    mark(&mut env, "Craft (burn 1 collectible -> 1 new)");
    // (c) eight shards burned for a key.
    env.upsert_recipe(&owner, 3, merge_recipe(10, 8, 11)).unwrap();
    let shards: Vec<Pubkey> = (0..8).map(|_| { let k = env.make(&authority, 10, player_pk).unwrap(); env.cus.pop(); k }).collect();
    let version = env.acc::<loot::Recipe>(&env.mechanic_pda(loot::RECIPE_SEED, 3)).version;
    let (ix, made) = env.craft_ix(player_pk, 3, version, &shards);
    sizes.push(("tx bytes: Craft burning 8 collectibles for 1 new (with the compute-budget ix)".into(), tx_bytes(&env, &[compute_limit(1_000_000), ix], &player_pk, 1 + made.len())));
    env.craft(&player, 3, &shards).unwrap();
    mark(&mut env, "Craft (burn 8 collectibles -> 1 new)");
    // (d) a tool used with a cooldown (its counters are rewritten on the asset), (e) a pass used with no life.
    env.upsert_recipe(&owner, 4, RecipeArgs { active: true, inputs: vec![Input::Use { item: 12 }], outputs: vec![Output::Tokens { mint: points, amount: 1, from: Origin::Issue }], needs: vec![], keeps: vec![] }).unwrap();
    env.upsert_recipe(&owner, 5, RecipeArgs { active: true, inputs: vec![Input::Use { item: 13 }], outputs: vec![Output::Tokens { mint: points, amount: 1, from: Origin::Issue }], needs: vec![], keeps: vec![] }).unwrap();
    let tool = env.make(&authority, 12, player_pk).unwrap();
    env.cus.pop();
    let pass = env.make(&authority, 13, player_pk).unwrap();
    env.cus.pop();
    env.craft(&player, 4, &[tool]).unwrap();
    mark(&mut env, "Craft (use 1 collectible with a cooldown: Core attribute rewrite)");
    env.craft(&player, 5, &[pass]).unwrap();
    mark(&mut env, "Craft (use 1 collectible with no life: read only)");
    // (f) the widest: 4 burned, 4 used (cooldown) -> 2 new (one keeps an attribute) and tokens.
    env.upsert_recipe(
        &owner,
        6,
        RecipeArgs {
            active: true,
            inputs: vec![Input::Burn { item: 10, count: 4 }, Input::Use { item: 12 }, Input::Use { item: 12 }, Input::Use { item: 12 }, Input::Use { item: 12 }],
            outputs: vec![Output::Item(11), Output::Item(11), Output::Tokens { mint: points, amount: 5, from: Origin::Issue }],
            needs: vec![],
            keeps: vec![Keep { key: "coat".into(), from: 0, to: 0 }],
        },
    )
    .unwrap();
    sizes.push(("Recipe (5 inputs, 3 outputs, 1 keep)".into(), env.data(&env.mechanic_pda(loot::RECIPE_SEED, 6)).len()));
    let mut hand = vec![];
    for i in 0..4 {
        let s = env.make(&authority, 10, player_pk).unwrap();
        env.cus.pop();
        if i == 0 {
            env.set(&authority, s, &[("coat", "red")]).unwrap();
            env.cus.pop();
        }
        hand.push(s);
    }
    env.wait(120);
    for _ in 0..4 {
        let t = env.make(&authority, 12, player_pk).unwrap();
        env.cus.pop();
        hand.push(t);
    }
    let version = env.acc::<loot::Recipe>(&env.mechanic_pda(loot::RECIPE_SEED, 6)).version;
    let (ix, made) = env.craft_ix(player_pk, 6, version, &hand);
    sizes.push(("tx bytes: Craft 4 burned + 4 used -> 2 new + tokens (with the compute-budget ix)".into(), tx_bytes(&env, &[compute_limit(1_000_000), ix], &player_pk, 1 + made.len())));
    env.craft(&player, 6, &hand).unwrap();
    mark(&mut env, "Craft (4 burned + 4 used with cooldown -> 2 new, one keeps an attribute, + tokens)");

    // ------------------------------------------------------------ report
    println!("\n| Instruction (audit) | Compute units |\n| --- | ---: |");
    for (name, cu) in &env.cus {
        if let Some(label) = name.strip_prefix("* ") {
            println!("| {label} | {cu} |");
        }
    }
    println!("\n| Account or transaction | Bytes | Rent, lamports |\n| --- | ---: | ---: |");
    for (name, len) in &sizes {
        let rent = if name.starts_with("tx bytes") { 0 } else { env.rent(*len) };
        println!("| {name} | {len} | {rent} |");
    }
}

/// The compute units each callee reports, for the CPI-heavy instructions: what the token
/// programs, Metaplex Core, the VRF program and the system program cost inside ours.
#[test]
fn inner_instruction_costs() {
    let mut env = setup();
    let (owner, authority, keeper) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let player = env.player.insecure_clone();
    let player_pk = player.pubkey();
    let coin = env.mint;
    env.open_pool(&owner, 0, coin).unwrap();
    env.fund(owner.pubkey(), coin, 100 * PRICE);
    env.upsert_item(10, bare_collectible("Shard")).unwrap();
    env.upsert_item(12, ItemArgs { life: Some(Life { ready_after: 0, lasts: 0, uses: 0, cooldown: 60 }), ..bare_collectible("Tool") }).unwrap();
    env.upsert_box(2, PRICE, vec![], (0..8).map(|_| item_drop(10, 1)).collect()).unwrap();
    let points = env.new_mint(env.game);
    env.token_account(player_pk, points);
    env.upsert_recipe(&owner, 4, RecipeArgs { active: true, inputs: vec![Input::Use { item: 12 }], outputs: vec![Output::Tokens { mint: points, amount: 1, from: Origin::Issue }], needs: vec![], keeps: vec![] }).unwrap();
    env.upsert_recipe(&owner, 2, merge_recipe(10, 1, 10)).unwrap();
    let tool = env.make(&authority, 12, player_pk).unwrap();
    let shard = env.make(&authority, 10, player_pk).unwrap();

    let mut report: Vec<(String, Vec<String>)> = vec![];
    let mut keep = |label: &str, logs: Vec<String>| {
        let lines = logs.iter().filter(|l| l.contains("consumed") || l.contains("invoke [")).cloned().collect();
        report.push((label.into(), lines));
    };
    keep("Deposit (classic)", env.deposit(&owner, 0, coin, 100).unwrap());
    keep("OpenBox (8 item entries, first sale: vault created)", env.open_box(2, 1).unwrap());
    let order = order_pda(&env.game, &player_pk, 1);
    keep("CallbackRoll (8 entries)", env.callback_of(2, order, rnd(3)).unwrap());
    keep("Settle (collectible, 0 shares)", env.settle(order, &keeper).unwrap());
    keep("Set (Core UpdatePluginV1 on the attributes plugin)", env.set(&authority, tool, &[("level", "7")]).unwrap());
    let burnable = env.make(&authority, 10, player_pk).unwrap();
    env.upsert_item(16, ItemArgs { burnable: true, ..bare_collectible("Ticket") }).unwrap();
    let ticket = env.make(&authority, 16, player_pk).unwrap();
    keep("Unmake (Core BurnV1)", env.unmake(&authority, ticket).unwrap());
    keep("Craft (burn 1 -> 1 new: Core BurnV1 by the player, Core CreateV2 by the game)", env.ix_craft_logs(&player, 2, &[shard]));
    keep("Hold", env.hold(&player, burnable, 3_600).unwrap());
    keep("Award", env.award(&authority, burnable, keeper.pubkey()).unwrap());
    keep("Roll", env.roll(&authority, REF).unwrap());
    for (label, lines) in report {
        println!("\n== {label}");
        for l in lines {
            println!("   {l}");
        }
    }
}

#[test]
fn cost_table() {
    let mut env = setup();
    let (owner, authority, keeper, admin) =
        (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone(), env.admin.insecure_clone());
    let player = env.player.pubkey();
    let player_token = ata(&player, &env.mint);

    // Settings.
    env.open_pool(&owner, 0, env.mint).unwrap();
    env.open_pool(&owner, 1, env.mint).unwrap();
    env.upsert_item(8, ItemArgs { burnable: true, ..item(ItemKind::Collectible, "Arena Ticket", 0, PRICE) }).unwrap();
    env.upsert_box(1, PRICE, vec![pool(0, 5_000), burn(1_000)], vec![item_drop(1, 1), item_drop(2, 1)]).unwrap();

    // In.
    env.pay(PRICE, vec![]).unwrap();
    env.cus.last_mut().unwrap().0 = "Pay (all to the treasury)".into();
    env.pay(PRICE, vec![pool(0, 7_000), pool(1, 1_000), burn(500)]).unwrap();
    env.cus.last_mut().unwrap().0 = "Pay (two pools, a burn, the treasury)".into();
    env.fund(owner.pubkey(), env.mint, PRICE);
    env.deposit(&owner, 0, env.mint, PRICE).unwrap();
    env.open_box(1, 1).unwrap();
    let order = order_pda(&env.game, &player, 1);
    env.callback(order, rnd(0)).unwrap();
    env.settle(order, &keeper).unwrap();
    env.cus.last_mut().unwrap().0 = "Settle (a collectible, one pool, a burn)".into();
    env.buy(8, 2).unwrap();
    env.open_box(1, 3).unwrap();
    env.wait_slots(loot::STALE_SLOTS + 1);
    env.refund(order_pda(&env.game, &player, 3)).unwrap();

    // Out and make.
    env.payout(&authority, 0, player_token, PRICE).unwrap();
    let points = env.new_mint(env.game);
    let to = env.token_account(player, points);
    env.issue(&authority, points, to, 100).unwrap();
    let ticket = env.make(&authority, 8, player).unwrap();
    env.set(&authority, ticket, &[("level", "7")]).unwrap();
    env.unmake(&authority, ticket).unwrap();

    // Platform.
    env.set_fee(2 * FEE).unwrap();
    env.set_suspended(&admin, true).unwrap();

    println!("\n| Instruction | Compute units |\n| --- | ---: |");
    let mut seen = std::collections::BTreeMap::new();
    for (name, cu) in &env.cus {
        let slot = seen.entry(name.clone()).or_insert(0u64);
        *slot = (*slot).max(*cu);
    }
    for (name, cu) in seen {
        println!("| `{name}` | {cu} |");
    }

    println!("\n| Account | Bytes | Rent, lamports |\n| --- | ---: | ---: |");
    let sizes = [
        ("Platform", env.data(&platform_pda()).len()),
        ("Game", env.data(&env.game).len()),
        ("Item (11-character name, 40-character URI, one share)", env.data(&item_pda(&env.game, 1)).len()),
        ("Box (2 entries, 2 shares)", env.data(&box_pda(&env.game, 1)).len()),
        ("Order", Order::SPACE),
        ("Pool", env.data(&pool_pda(&env.game, 0)).len()),
    ];
    for (name, len) in sizes {
        println!("| {name} | {len} | {} |", env.rent(len));
    }
    assert_eq!(env.data(&platform_pda()).len(), Platform::SPACE);
}
