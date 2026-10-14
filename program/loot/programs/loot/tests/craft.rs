//! Recipes: collectibles and tokens in and out, life, needs and keeps.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    common::*,
    loot::BoxArgs,
    loot::GameUpdate,
    loot::Input,
    loot::ItemArgs,
    loot::Keep,
    loot::Need,
    loot::Origin,
    loot::Output,
    loot::RecipeArgs,
    loot::receipts::Crafted,
    loot::state::ItemKind,
    loot::state::Life,
    loot::state::Order,
    loot::state::Outcome,
    loot::state::To,
    mpl_core::instructions::*,
    mpl_core::instructions::CreateCollectionV2Builder,
    mpl_core::instructions::CreateV2Builder,
    mpl_core::types::Attribute as CoreAttribute,
    mpl_core::types::Attributes,
    mpl_core::types::Plugin,
    mpl_core::types::PluginAuthorityPair,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn has_receipt(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

fn recipe(inputs: Vec<Input>, outputs: Vec<Output>) -> RecipeArgs {
    RecipeArgs { active: true, inputs, outputs, needs: vec![], keeps: vec![] }
}

fn version(env: &Env, id: u32) -> u32 {
    env.acc::<loot::Recipe>(&env.mechanic_pda(loot::RECIPE_SEED, id)).version
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

fn alive(env: &Env, asset: &Pubkey) -> bool {
    mpl_core::Asset::from_bytes(&env.data(asset)).is_ok()
}

fn bare_collectible(name: &str) -> ItemArgs {
    ItemArgs { shares: vec![], ..item(ItemKind::Collectible, name, 0, 0) }
}

/// The Core attributes this program writes on a collectible of item `item_id`.
fn own_attributes(item_id: u32, made: i64) -> PluginAuthorityPair {
    let attr = |key: &str, value: String| CoreAttribute { key: key.into(), value };
    PluginAuthorityPair {
        plugin: Plugin::Attributes(Attributes {
            attribute_list: vec![attr("item_id", item_id.to_string()), attr("rarity", "3".into()), attr("serial", "1".into()), attr("made", made.to_string())],
        }),
        authority: None,
    }
}

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

fn balance_of(env: &Env, who: &Keypair, mint: &Pubkey) -> u64 {
    env.tokens(&ata(&who.pubkey(), mint))
}

fn holder(env: &Env, asset: &Pubkey) -> Pubkey {
    mpl_core::Asset::from_bytes(&env.data(asset)).unwrap().base.owner
}

/// The number this program wrote on a collectible under `key`, read the way the program reads it.
fn number_on(env: &Env, asset: &Pubkey, key: &str) -> u32 {
    loot::asset::number(&loot::asset::attributes(&env.data(asset)).unwrap(), key)
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

/// Replaces every meta of `ix` whose key is `old` with `new` (same flags).
fn swap(ix: &mut Instruction, old: Pubkey, new: Pubkey) {
    let mut hit = false;
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == old) {
        meta.pubkey = new;
        hit = true;
    }
    assert!(hit, "the account to replace is not in the instruction");
}

fn burn_as_owner(env: &mut Env, who: &Keypair, asset: Pubkey) {
    let ix = mpl_core::instructions::BurnV1Builder::new().asset(asset).collection(Some(env.collection)).payer(who.pubkey()).instruction();
    env.send(&[ix], &[who]).unwrap();
}

/// Every attribute written on an asset, in order.
fn written(env: &Env, asset: &Pubkey) -> Vec<(String, String)> {
    let asset = mpl_core::Asset::from_bytes(&env.data(asset)).unwrap();
    let list = asset.plugin_list.attributes.unwrap().attributes.attribute_list;
    list.into_iter().map(|a| (a.key, a.value)).collect()
}

const CORE_NO_APPROVALS: &str = "custom program error: 0x1a";

fn value(list: &[(String, String)], key: &str) -> Option<String> {
    list.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn keys(list: &[(String, String)]) -> Vec<&str> {
    list.iter().map(|(k, _)| k.as_str()).collect()
}

/// The `Crafted` receipt names a recipe version, and no receipt or account keeps old versions.
#[test]
fn a_crafted_receipt_names_a_version_nothing_on_chain_keeps() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gems = env.new_mint(owner.pubkey());
    let points = env.new_mint(env.game);
    let p = funded(&mut env);
    env.fund(p.pubkey(), gems, 1_000);
    env.token_account(p.pubkey(), points);
    let rate = |take, give| RecipeArgs {
        active: true,
        inputs: vec![Input::Pay { mint: gems, amount: take, to: To::Burn }],
        outputs: vec![Output::Tokens { mint: points, amount: give, from: Origin::Issue }],
        needs: vec![],
        keeps: vec![],
    };
    assert!(!has_receipt(&env.upsert_recipe(&owner, 1, rate(2, 3)).unwrap()), "no receipt says what version 0 was");
    let (mut ix, _) = env.craft_ix(p.pubkey(), 1, 0, &[]);
    ix.data = loot::instruction::Craft { version: 0, times: 50 }.data();
    let c: Crafted = receipt(&env.send(&[ix], &[&p]).unwrap());
    assert_eq!((c.version, c.times, c.burned.len(), c.used.len(), c.made.len()), (0, 50, 0, 0, 0));
    assert!(!has_receipt(&env.upsert_recipe(&owner, 1, rate(2, 1)).unwrap()));
    let r: loot::Recipe = env.acc(&env.mechanic_pda(loot::RECIPE_SEED, 1));
    assert_eq!((r.version, r.outputs[0]), (1, Output::Tokens { mint: points, amount: 1, from: Origin::Issue }));
    // A reader of `Crafted { version: 0, times: 50 }` finds 100 gems and 150 points only in the
    // transaction's inner instructions.
}

/// A recipe's token output or share goes
/// to the player's token account, which the player passes; passing the pool it comes from made
/// the transfer a no-op while the inputs were still taken. Now it is refused, and nothing is paid.
#[test]
fn a_recipe_output_sent_back_to_its_own_pool_is_refused() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    pool_with(&mut env, 0, gold, 1_000);
    let p = wallet(&mut env, gold, 100);
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Pay { mint: gold, amount: 10, to: To::Burn }], vec![Output::Tokens { mint: gold, amount: 50, from: Origin::Pool(0) }])).unwrap();
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Pay { mint: gold, amount: 10, to: To::Burn }], vec![Output::Share { mint: gold, pool: 0, bps: 1_000 }])).unwrap();
    for id in [1, 2] {
        let (mut ix, _) = env.craft_ix(p.pubkey(), id, version(&env, id), &[]);
        let last = ix.accounts.len() - 1;
        assert_eq!(ix.accounts[last].pubkey, ata(&p.pubkey(), &gold));
        ix.accounts[last].pubkey = pool_pda(&env.game, 0);
        assert!(err(env.send(&[ix], &[&p])).contains("SameAccount"));
    }
    assert_eq!(env.tokens(&ata(&p.pubkey(), &gold)), 100, "nothing was paid");
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 1_000);
}

/// `Item.active` switched the shop and the boxes off, not the
/// recipes: an item the owner switched off still came out of every recipe that makes it. Now a
/// recipe refuses it too, and makes it again once it is switched back on.
#[test]
fn an_item_switched_off_does_not_come_out_of_a_recipe() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let p = wallet(&mut env, gold, 100);
    let relic = || ItemArgs { active: false, price: 1, ..bare_collectible("Relic") };
    env.upsert_item(40, relic()).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Pay { mint: gold, amount: 1, to: To::Burn }], vec![Output::Item(40)])).unwrap();
    let me = env.player.insecure_clone();
    env.player = p.insecure_clone();
    assert!(err(env.buy(40, 1)).contains("NotForSale"));
    env.player = me;
    assert!(err(env.craft(&p, 1, &[])).contains("NotForSale"));
    assert_eq!(env.item_state(40).issued, 0);

    env.upsert_item(40, ItemArgs { active: true, ..relic() }).unwrap();
    let made = env.craft(&p, 1, &[]).unwrap()[0];
    assert!(alive(&env, &made));
    assert_eq!(env.item_state(40).issued, 1);
}

/// A collectible that looks exactly like one of the game's, in the player's own collection or
/// in none, is not taken for it: the collection is read from the asset, and an asset in the
/// game's collection cannot be created without the game's signature. An asset of the game's
/// collection of another item with the same name is refused by the item number written on it.
#[test]
fn a_look_alike_collectible_is_refused_wherever_it_comes_from() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    pool_with(&mut env, 0, gold, 10_000);
    env.upsert_item(30, bare_collectible("Fish")).unwrap();
    env.upsert_item(31, bare_collectible("Fish")).unwrap(); // another item, one name
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Burn { item: 30, count: 1 }], vec![Output::Tokens { mint: gold, amount: 5_000, from: Origin::Pool(0) }])).unwrap();
    let p = wallet(&mut env, gold, 0);
    let made = env.now();

    // The player's own collection, and in it "Fish #1" with the program's own attributes.
    let collection = Keypair::new();
    let ix = CreateCollectionV2Builder::new().collection(collection.pubkey()).update_authority(Some(p.pubkey())).payer(p.pubkey()).name("Mine".into()).uri("x".into()).instruction();
    env.send(&[ix], &[&p, &collection]).unwrap();
    let fake = Keypair::new();
    let ix = CreateV2Builder::new().asset(fake.pubkey()).collection(Some(collection.pubkey())).authority(Some(p.pubkey())).payer(p.pubkey()).owner(Some(p.pubkey())).name("Fish #1".into()).uri("x".into()).plugins(vec![own_attributes(30, made)]).instruction();
    env.send(&[ix], &[&p, &fake]).unwrap();
    assert!(err(env.craft(&p, 1, &[fake.pubkey()])).contains("ItemMismatch"));

    // In no collection, with the game's collection as its update authority address.
    let loose = Keypair::new();
    let ix = CreateV2Builder::new().asset(loose.pubkey()).update_authority(Some(env.collection)).payer(p.pubkey()).owner(Some(p.pubkey())).name("Fish #1".into()).uri("x".into()).plugins(vec![own_attributes(30, made)]).instruction();
    env.send(&[ix], &[&p, &loose]).unwrap();
    assert!(err(env.craft(&p, 1, &[loose.pubkey()])).contains("ItemMismatch"));

    // In the game's collection: Core refuses without the collection's authority.
    let forged = Keypair::new();
    let ix = CreateV2Builder::new().asset(forged.pubkey()).collection(Some(env.collection)).authority(Some(p.pubkey())).payer(p.pubkey()).owner(Some(p.pubkey())).name("Fish #1".into()).uri("x".into()).plugins(vec![own_attributes(30, made)]).instruction();
    assert!(env.send(&[ix], &[&p, &forged]).is_err());

    // The other item with the same name, really minted by the game.
    let other_fish = env.make(&authority, 31, p.pubkey()).unwrap();
    assert!(err(env.craft(&p, 1, &[other_fish])).contains("ItemMismatch"));
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 10_000);
    let real = env.make(&authority, 30, p.pubkey()).unwrap();
    env.craft(&p, 1, &[real]).unwrap();
    assert_eq!(env.tokens(&ata(&p.pubkey(), &gold)), 5_000);
}

/// One collectible fills one place (twice in a burn, or used and burned); and the item an
/// output names must be writable, because the serial is written straight into it: passed
/// read-only, the runtime refuses the whole craft and nothing is burned or issued.
#[test]
fn craft_refuses_a_collectible_twice_and_a_read_only_item_for_its_output() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    env.upsert_item(20, bare_collectible("Shard")).unwrap();
    env.upsert_item(21, bare_collectible("Key")).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Burn { item: 20, count: 2 }], vec![Output::Item(21)])).unwrap();
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Use { item: 20 }, Input::Burn { item: 20, count: 1 }], vec![Output::Item(21)])).unwrap();
    let gold = env.mint;
    let p = wallet(&mut env, gold, 0);
    let shards: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 20, p.pubkey()).unwrap()).collect();
    assert!(err(env.craft(&p, 1, &[shards[0], shards[0]])).contains("ItemMismatch"));
    assert!(err(env.craft(&p, 2, &[shards[0], shards[0]])).contains("ItemMismatch"));

    let (mut ix, made) = env.craft_ix(p.pubkey(), 1, version(&env, 1), &shards);
    let at = ix.accounts.iter().rposition(|m| m.pubkey == item_pda(&env.game, 21)).unwrap();
    ix.accounts[at].is_writable = false;
    let e = err(env.send(&[compute_limit(1_000_000), ix], &[&p, &made[0]]));
    assert!(e.contains("ReadonlyDataModified"), "{e}");
    assert_eq!(env.item_state(21).issued, 0);
    assert!(shards.iter().all(|s| alive(&env, s)));
    env.craft(&p, 1, &shards).unwrap();
    assert_eq!(env.item_state(21).issued, 1);
}

/// A recipe's payment is made by the player as the owner of `from`: a pool, the treasury, the
/// order vault, a stake's vaults are refused by the token program, whatever `to` is. A mint
/// account that is not the line's is refused by the program, and an account of another mint by
/// the token program.
#[test]
fn a_recipe_payment_cannot_come_from_the_games_own_accounts() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    pool_with(&mut env, 0, gold, 1_000);
    pool_with(&mut env, 1, gold, 0);
    pool_with(&mut env, 3, gold, 0);
    env.open_stake(&owner, 1, gold, 3, gold, 0).unwrap();
    let (s1, s2) = (wallet(&mut env, gold, 50), wallet(&mut env, gold, 50));
    env.stake(&s1, 1, 50, gold).unwrap();
    env.stake(&s2, 1, 50, gold).unwrap();
    env.fund(owner.pubkey(), gold, 100);
    env.deposit(&owner, 3, gold, 100).unwrap();
    env.unstake(&s1, 1, 0, gold).unwrap(); // the rewards vault now holds s2's 50
    let vault = env.token_account(env.game, gold); // the order vault
    env.fund(env.game, gold, 100);
    env.fund(owner.pubkey(), gold, 100); // the treasury
    for pay_to in [To::Burn, To::Pool(1)] {
        env.upsert_recipe(&owner, 1, recipe(vec![Input::Pay { mint: gold, amount: 10, to: pay_to }], vec![Output::Tokens { mint: gold, amount: 5, from: Origin::Pool(0) }])).unwrap();
        let p = wallet(&mut env, gold, 0);
        env.fund(p.pubkey(), other, 100);
        let from_at = |env: &Env| {
            let (ix, _) = env.craft_ix(p.pubkey(), 1, version(env, 1), &[]);
            (ix.accounts.iter().position(|m| m.pubkey == ata(&p.pubkey(), &gold)).unwrap(), ix)
        };
        for from in [pool_pda(&env.game, 0), env.treasury, vault, env.staked_vault(1), env.rewards_vault(1)] {
            let (at, mut ix) = from_at(&env);
            ix.accounts[at].pubkey = from;
            let e = err(env.send(&[ix], &[&p]));
            assert!(e.contains("owner does not match"), "{e}");
        }
        let (at, mut ix) = from_at(&env);
        ix.accounts[at].pubkey = ata(&p.pubkey(), &other);
        assert!(err(env.send(&[ix], &[&p])).contains("WrongMint"));
        let (at, mut ix) = from_at(&env);
        ix.accounts[at - 1].pubkey = other;
        assert!(err(env.send(&[ix], &[&p])).contains("WrongMint"));
        assert_eq!(env.tokens(&ata(&p.pubkey(), &gold)), 0, "got nothing");
    }
    assert_eq!((env.tokens(&pool_pda(&env.game, 0)), env.tokens(&env.treasury), env.tokens(&vault)), (1_000, 100, 100));
    assert_eq!((env.tokens(&env.staked_vault(1)), env.tokens(&env.rewards_vault(1))), (100, 50));
}

/// A payment to the holder of a collectible the player holds themselves nets to nothing: the
/// line is carried out, the outputs are given, the balance does not move.
#[test]
fn a_payment_to_a_holder_the_player_is_nets_to_zero() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let ore = env.new_mint(env.game);
    env.upsert_item(50, bare_collectible("Plot")).unwrap();
    let p = wallet(&mut env, gold, 100);
    env.token_account(p.pubkey(), ore);
    let plot = env.make(&authority, 50, p.pubkey()).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Pay { mint: gold, amount: 10, to: To::Holder(plot) }], vec![Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }])).unwrap();
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((env.tokens(&ata(&p.pubkey(), &gold)), env.tokens(&ata(&p.pubkey(), &ore))), (100, 1));
    // Once the plot belongs to someone else, the payment reaches them.
    let q = wallet(&mut env, gold, 0);
    let ix = mpl_core::instructions::TransferV1Builder::new().asset(plot).collection(Some(env.collection)).payer(p.pubkey()).authority(Some(p.pubkey())).new_owner(q.pubkey()).instruction();
    env.send(&[ix], &[&p]).unwrap();
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((env.tokens(&ata(&p.pubkey(), &gold)), env.tokens(&ata(&q.pubkey(), &gold))), (90, 10));
}

/// A fishing game: a fish is sold for ore (salvage), ore buys a hook (a shop in another
/// currency), and two fish, a hook and gold make a trophy and some ore.
#[test]
fn a_recipe_takes_and_gives_collectibles_and_tokens() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let ore = env.new_mint(env.game); // the game mints it
    env.open_pool(&owner, 0, gold).unwrap();
    for (id, name) in [(30, "Fish"), (31, "Hook"), (32, "Trophy")] {
        env.upsert_item(id, collectible(name)).unwrap();
    }
    let p = player(&mut env, 1_000);
    env.token_account(p.pubkey(), ore);

    let salvage = recipe(vec![Input::Burn { item: 30, count: 1 }], vec![Output::Tokens { mint: ore, amount: 5, from: Origin::Issue }]);
    let shop = recipe(vec![Input::Pay { mint: ore, amount: 8, to: To::Burn }], vec![Output::Item(31)]);
    let trophy = recipe(
        vec![Input::Burn { item: 30, count: 2 }, Input::Burn { item: 31, count: 1 }, Input::Pay { mint: gold, amount: 100, to: To::Pool(0) }],
        vec![Output::Item(32), Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }],
    );
    assert!(err(env.upsert_recipe(&p, 1, salvage.clone())).contains("NotOwner"));
    env.upsert_recipe(&owner, 1, salvage).unwrap();
    env.upsert_recipe(&owner, 2, shop).unwrap();
    env.upsert_recipe(&owner, 3, trophy.clone()).unwrap();

    let fish: Vec<Pubkey> = (0..4).map(|_| env.make(&authority, 30, p.pubkey()).unwrap()).collect();

    // Not enough ore for a hook yet.
    assert!(env.craft(&p, 2, &[]).is_err());
    env.craft(&p, 1, &fish[..1]).unwrap();
    env.craft(&p, 1, &fish[1..2]).unwrap();
    assert_eq!((balance_of(&env, &p, &ore), alive(&env, &fish[0]), alive(&env, &fish[1])), (10, false, false));

    let hook = env.craft(&p, 2, &[]).unwrap()[0];
    assert_eq!((balance_of(&env, &p, &ore), env.supply(&ore), holder(&env, &hook)), (2, 2, p.pubkey()));

    // The collectibles go in the recipe's order: a hook is not a fish.
    assert!(err(env.craft(&p, 3, &[fish[2], hook, fish[3]])).contains("ItemMismatch"));
    let version = env.acc::<loot::Recipe>(&env.mechanic_pda(loot::RECIPE_SEED, 3)).version;
    let (ix, made) = env.craft_ix(p.pubkey(), 3, version, &[fish[2], fish[3], hook]);
    let logs = env.send(&[compute_limit(1_000_000), ix], &[&p, &made[0]]).unwrap();
    let r: Crafted = receipt(&logs);
    assert_eq!((r.burned, r.used, r.made), (vec![fish[2], fish[3], hook], vec![], vec![made[0].pubkey()]));
    assert_eq!(mpl_core::Asset::from_bytes(&env.data(&made[0].pubkey())).unwrap().base.name, "Trophy #1");
    assert_eq!((balance_of(&env, &p, &gold), env.tokens(&pool_pda(&env.game, 0)), balance_of(&env, &p, &ore)), (900, 100, 3));

    // An edit that lands first cannot change what the player signed for.
    let dearer = RecipeArgs { inputs: vec![Input::Pay { mint: gold, amount: 900, to: To::Pool(0) }], ..trophy };
    env.upsert_recipe(&owner, 3, dearer).unwrap();
    let (ix, made) = env.craft_ix(p.pubkey(), 3, version, &[]);
    assert!(err(env.send(&[ix], &[&p, &made[0]])).contains("RecipeChanged"));
    assert_eq!(balance_of(&env, &p, &gold), 900);

    // The owner's pause stops a recipe like any other way in.
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    assert!(err(env.craft(&p, 2, &[])).contains("Paused"));
}

#[test]
fn a_recipe_is_refused_when_it_is_too_large_or_has_an_empty_line() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let mint = env.mint;
    let burn = |count| Input::Burn { item: 30, count };
    let pay = |amount| Input::Pay { mint, amount, to: To::Burn };
    let bad = [
        recipe(vec![], vec![]),
        recipe(vec![pay(1); 9], vec![]),
        recipe(vec![], vec![Output::Item(1); 9]),
        recipe(vec![burn(5), burn(4)], vec![]),
        recipe(vec![burn(0)], vec![Output::Item(1)]),
        recipe(vec![pay(0)], vec![Output::Item(1)]),
        recipe(vec![burn(1)], vec![Output::Tokens { mint, amount: 0, from: Origin::Issue }]),
    ];
    for args in bad {
        assert!(err(env.upsert_recipe(&owner, 1, args)).contains("BadRecipe"));
    }
    env.upsert_recipe(&owner, 1, recipe(vec![burn(4), burn(3), Input::Use { item: 31 }, pay(1)], vec![])).unwrap();
}

/// Three gems for an upgrade attempt, and the attempt is the price of a box that gives a big
/// gem half the time. The box is priced in the attempt token and burns it.
#[test]
fn a_recipe_and_a_box_make_a_craft_left_to_chance() {
    let mut env = setup();
    let (owner, authority, p) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.player.insecure_clone());
    let attempt = env.new_mint(env.game);
    env.upsert_item(40, collectible("Gem")).unwrap();
    env.upsert_item(41, collectible("Big Gem")).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Burn { item: 40, count: 3 }], vec![Output::Tokens { mint: attempt, amount: 1, from: Origin::Issue }])).unwrap();

    let entries = vec![item_drop(41, 1), loot::state::DropEntry { outcome: Outcome::Nothing, weight: 1 }];
    let fusion = BoxArgs { price: 1, currency: Some(attempt), rise: None, fall: None, stock_odds: false, active: true, shares: vec![burn(10_000)], entries };
    // The treasury holds the game's token only: a box in another one leaves it nothing.
    assert!(err(env.upsert_box_args(5, BoxArgs { shares: vec![burn(9_000)], ..fusion.clone() })).contains("BadShares"));
    env.upsert_box_args(5, fusion).unwrap();

    env.token_account(p.pubkey(), attempt);
    for _ in 0..3 {
        let gems: Vec<Pubkey> = (0..3).map(|_| env.make(&authority, 40, p.pubkey()).unwrap()).collect();
        env.craft(&p, 1, &gems).unwrap();
    }
    assert_eq!(balance_of(&env, &p, &attempt), 3);
    let gold = balance_of(&env, &p, &env.mint);

    // It works.
    let order = order_pda(&env.game, &p.pubkey(), 1);
    env.open_box(5, 1).unwrap();
    assert_eq!((env.acc::<Order>(&order).mint, env.tokens(&ata(&env.game, &attempt))), (attempt, 1));
    env.callback_of(5, order, rnd(0)).unwrap();
    let big = env.asset_pda(&order);
    let c = env.cranker.insecure_clone();
    env.settle(order, &c).unwrap();
    assert_eq!((holder(&env, &big), env.supply(&attempt), balance_of(&env, &p, &attempt)), (p.pubkey(), 2, 2));

    // It fails: the attempt is burned all the same.
    let order = order_pda(&env.game, &p.pubkey(), 2);
    env.open_box(5, 2).unwrap();
    env.callback_of(5, order, rnd(1)).unwrap();
    assert_eq!(env.acc::<Order>(&order).outcome, Outcome::Nothing);
    env.settle_prize(order, None, &c).unwrap();
    assert_eq!((env.supply(&attempt), env.item_state(41).issued), (1, 1));

    // The oracle never answers: the attempt comes back, in its own token.
    let order = order_pda(&env.game, &p.pubkey(), 3);
    env.open_box(5, 3).unwrap();
    assert_eq!(balance_of(&env, &p, &attempt), 0);
    env.wait_slots(loot::STALE_SLOTS + 1);
    env.refund(order).unwrap();
    assert_eq!((balance_of(&env, &p, &attempt), balance_of(&env, &p, &env.mint)), (1, gold), "none of it touched the game's own token");
}

/// An egg hatches after a day, and milk makes cheese only while it is fresh.
#[test]
fn a_collectible_is_taken_only_when_it_is_ready_and_before_it_expires() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    let life = |ready_after, lasts| Some(Life { ready_after, lasts, uses: 0, cooldown: 0 });
    env.upsert_item(70, ItemArgs { life: life(DAY as u32, 0), ..collectible("Egg") }).unwrap();
    env.upsert_item(71, collectible("Chick")).unwrap();
    env.upsert_item(72, ItemArgs { life: life(0, DAY as u32), ..collectible("Milk") }).unwrap();
    env.upsert_item(73, collectible("Cheese")).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(70, 1, 71)).unwrap();
    env.upsert_recipe(&owner, 2, merge_recipe(72, 1, 73)).unwrap();

    let egg = env.make(&authority, 70, p.pubkey()).unwrap();
    let milk: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 72, p.pubkey()).unwrap()).collect();
    assert_eq!(number_on(&env, &egg, "made") as i64, env.now());

    assert!(err(env.craft(&p, 1, &[egg])).contains("NotReady"));
    env.craft(&p, 2, &milk[..1]).unwrap();
    env.wait(DAY - 1);
    assert!(err(env.craft(&p, 1, &[egg])).contains("NotReady"));
    env.wait(1);
    env.craft(&p, 1, &[egg]).unwrap();
    assert!(err(env.craft(&p, 2, &milk[1..])).contains("Expired"));
    assert!(alive(&env, &milk[1]), "it rots in the wallet; nothing burns it");

    // How long an item lives is part of what it is: it cannot change under its holders.
    let shorter = ItemArgs { life: life(0, 60), ..collectible("Milk") };
    assert!(err(env.upsert_item(72, shorter)).contains("KindLocked"));
}

/// Two mares, each good for two foals and one a hour, make a foal and are kept. A soulbound
/// pass pays its holder a coin a day.
#[test]
fn a_collectible_is_used_and_kept_only_so_many_times_and_only_so_often() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let p = player(&mut env, 0);
    let other = player(&mut env, 0);
    let funder = player(&mut env, 100);
    env.deposit(&funder, 0, gold, 100).unwrap();

    let mare = Life { ready_after: 0, lasts: 0, uses: 2, cooldown: HOUR as u32 };
    let pass = Life { ready_after: 0, lasts: 0, uses: 0, cooldown: DAY as u32 };
    env.upsert_item(74, ItemArgs { life: Some(mare), ..collectible("Mare") }).unwrap();
    env.upsert_item(76, collectible("Foal")).unwrap();
    env.upsert_item(77, ItemArgs { soulbound: true, life: Some(pass), ..collectible("Pass") }).unwrap();
    env.upsert_item(78, ItemArgs { soulbound: true, ..collectible("Licence") }).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Use { item: 74 }, Input::Use { item: 74 }], vec![Output::Item(76)])).unwrap();
    let coin = vec![Output::Tokens { mint: gold, amount: 1, from: Origin::Pool(0) }];
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Use { item: 77 }], coin.clone())).unwrap();
    env.upsert_recipe(&owner, 3, recipe(vec![Input::Use { item: 78 }], coin)).unwrap();

    let mares: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 74, p.pubkey()).unwrap()).collect();
    let theirs = env.make(&authority, 74, other.pubkey()).unwrap();
    // The authority's own attributes sit beside the program's counts.
    let made = number_on(&env, &mares[0], "made").to_string();
    env.set(&authority, mares[0], &[("made", made.as_str()), ("speed", "9")]).unwrap();

    // One mare is not two parents, and someone else's mare is not yours.
    assert!(err(env.craft(&p, 1, &[mares[0], mares[0]])).contains("ItemMismatch"));
    assert!(err(env.craft(&p, 1, &[mares[0], theirs])).contains("ItemMismatch"));

    let foal = env.craft(&p, 1, &mares).unwrap()[0];
    assert_eq!(holder(&env, &foal), p.pubkey());
    for mare in &mares {
        assert_eq!((holder(&env, mare), number_on(&env, mare, "used"), number_on(&env, mare, "used_at") as i64), (p.pubkey(), 1, env.now()));
    }
    // What the program reads is what Metaplex Core's own reader finds.
    let core: Vec<(String, String)> = mpl_core::Asset::from_bytes(&env.data(&mares[0])).unwrap().plugin_list.attributes.unwrap().attributes.attribute_list.into_iter().map(|a| (a.key, a.value)).collect();
    let ours: Vec<(String, String)> = loot::asset::attributes(&env.data(&mares[0])).unwrap().into_iter().map(|a| (a.key, a.value)).collect();
    assert_eq!(core, ours);
    assert_eq!(ours[..2], [("made".to_string(), made), ("speed".to_string(), "9".to_string())]);

    assert!(err(env.craft(&p, 1, &mares)).contains("NotReady"), "an hour between foals");
    env.wait(HOUR);
    env.craft(&p, 1, &mares).unwrap();
    env.wait(HOUR);
    assert!(err(env.craft(&p, 1, &mares)).contains("UsedUp"), "two foals each");
    assert_eq!(env.item_state(76).issued, 2);

    // A daily claim: a soulbound pass can be used (never burned), once a day.
    let pass = env.make(&authority, 77, p.pubkey()).unwrap();
    env.craft(&p, 2, &[pass]).unwrap();
    assert!(err(env.craft(&p, 2, &[pass])).contains("NotReady"));
    env.wait(DAY);
    env.craft(&p, 2, &[pass]).unwrap();
    assert_eq!((balance_of(&env, &p, &gold), number_on(&env, &pass, "used")), (2, 2));

    // An item with no life is only held: a licence opens a recipe as often as its holder likes.
    let licence = env.make(&authority, 78, p.pubkey()).unwrap();
    env.craft(&p, 3, &[licence]).unwrap();
    env.craft(&p, 3, &[licence]).unwrap();
    assert!(err(env.craft(&other, 3, &[licence])).contains("ItemMismatch"));
    assert_eq!((balance_of(&env, &p, &gold), number_on(&env, &licence, "used")), (4, 0));
}

/// A hero of level 10 or more is reborn: the new hero keeps its name and its eyes. A pickaxe
/// good for two swings is repaired for a coin.
#[test]
fn a_recipe_asks_for_a_number_keeps_attributes_and_renews_uses() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let ore = env.new_mint(env.game);
    let p = player(&mut env, 10);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(90, collectible("Hero")).unwrap();
    env.upsert_item(91, collectible("Reborn Hero")).unwrap();
    let two_swings = Life { ready_after: 0, lasts: 0, uses: 2, cooldown: 0 };
    env.upsert_item(92, ItemArgs { life: Some(two_swings), ..collectible("Pickaxe") }).unwrap();

    let need = |key: &str| Need { place: 0, key: key.into(), at_least: 10 };
    let keep = |key: &str| Keep { key: key.into(), from: 0, to: 0 };
    let rebirth = RecipeArgs {
        needs: vec![need("level")],
        keeps: vec![keep("name"), keep("eyes"), keep("tail")],
        ..recipe(vec![Input::Burn { item: 90, count: 1 }], vec![Output::Item(91)])
    };
    // A need or a keep names a collectible the recipe has, and never the program's own numbers.
    for bad in [
        RecipeArgs { needs: vec![Need { place: 1, ..need("level") }], ..rebirth.clone() },
        RecipeArgs { needs: vec![need("")], ..rebirth.clone() },
        RecipeArgs { keeps: vec![Keep { from: 1, ..keep("name") }], ..rebirth.clone() },
        RecipeArgs { keeps: vec![Keep { to: 1, ..keep("name") }], ..rebirth.clone() },
        RecipeArgs { keeps: vec![keep("serial")], ..rebirth.clone() },
        RecipeArgs { keeps: vec![keep("used")], ..rebirth.clone() },
    ] {
        assert!(err(env.upsert_recipe(&owner, 1, bad)).contains("BadRecipe"));
    }
    env.upsert_recipe(&owner, 1, rebirth).unwrap();

    let heroes: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 90, p.pubkey()).unwrap()).collect();
    env.set(&authority, heroes[0], &[("level", "9"), ("name", "Bo"), ("eyes", "green")]).unwrap();
    assert!(err(env.craft(&p, 1, &heroes[..1])).contains("NeedNotMet"));
    assert!(err(env.craft(&p, 1, &heroes[1..])).contains("NeedNotMet"), "no level written is no level");
    env.set(&authority, heroes[0], &[("level", "10"), ("name", "Bo"), ("eyes", "green")]).unwrap();
    let reborn = env.craft(&p, 1, &heroes[..1]).unwrap()[0];
    let on_it: Vec<(String, String)> = loot::asset::attributes(&env.data(&reborn)).unwrap().into_iter().map(|a| (a.key, a.value)).collect();
    let keys: Vec<&str> = on_it.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["item_id", "rarity", "serial", "made", "name", "eyes"], "its own four, then what it kept; the hero had no tail");
    assert_eq!((on_it[0].1.as_str(), on_it[4].1.as_str(), on_it[5].1.as_str()), ("91", "Bo", "green"));

    // The pickaxe: two swings, then a repair that costs a coin, then two more.
    let swing = recipe(vec![Input::Use { item: 92 }], vec![Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }]);
    let repair = recipe(vec![Input::Renew { item: 92 }, Input::Pay { mint: gold, amount: 1, to: To::Burn }], vec![]);
    env.upsert_recipe(&owner, 2, swing).unwrap();
    env.upsert_recipe(&owner, 3, repair).unwrap();
    let pickaxe = env.make(&authority, 92, p.pubkey()).unwrap();
    env.craft(&p, 2, &[pickaxe]).unwrap();
    env.craft(&p, 2, &[pickaxe]).unwrap();
    assert!(err(env.craft(&p, 2, &[pickaxe])).contains("UsedUp"));
    env.craft(&p, 3, &[pickaxe]).unwrap();
    assert_eq!((number_on(&env, &pickaxe, "used"), balance_of(&env, &p, &gold)), (0, 9));
    env.craft(&p, 2, &[pickaxe]).unwrap();
    assert_eq!((balance_of(&env, &p, &ore), holder(&env, &pickaxe)), (3, p.pubkey()));

    // A recipe with a collectible in it is crafted once at a time.
    assert!(err(env.craft_times(&p, 2, 2, &[pickaxe])).contains("OnceAtATime"));
}

/// The largest recipes: eight collectibles burned for one, and four burned and four used for
/// two more and some tokens. Each fits in one transaction and its compute limit.
#[test]
fn the_largest_recipes_fit_in_one_transaction() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let ore = env.new_mint(env.game);
    let p = player(&mut env, 1_000);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(30, collectible("Shard")).unwrap();
    env.upsert_item(31, ItemArgs { life: Some(Life { ready_after: 0, lasts: 0, uses: 9, cooldown: 0 }), ..collectible("Rune") }).unwrap();
    env.upsert_item(32, collectible("Relic")).unwrap();
    let rune = |_| Input::Use { item: 31 };
    let wide = RecipeArgs {
        keeps: vec![Keep { key: "made_by".into(), from: 0, to: 0 }],
        ..recipe(
            vec![Input::Burn { item: 30, count: 4 }, rune(0), rune(1), rune(2), rune(3), Input::Pay { mint: env.mint, amount: 5, to: To::Burn }],
            vec![Output::Item(32), Output::Item(32), Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }],
        )
    };
    env.upsert_recipe(&owner, 1, merge_recipe(30, 8, 32)).unwrap();
    env.upsert_recipe(&owner, 2, wide).unwrap();

    let shards: Vec<Pubkey> = (0..12).map(|_| env.make(&authority, 30, p.pubkey()).unwrap()).collect();
    let runes: Vec<Pubkey> = (0..4).map(|_| env.make(&authority, 31, p.pubkey()).unwrap()).collect();
    for (id, assets) in [(1, shards[..8].to_vec()), (2, [&shards[8..], &runes[..]].concat())] {
        let (ix, made) = env.craft_ix(p.pubkey(), id, 0, &assets);
        let ixs = [compute_limit(1_400_000), ix];
        let message = solana_message::Message::new(&ixs, Some(&p.pubkey()));
        let bytes = 1 + 64 * (1 + made.len()) + message.serialize().len();
        let mut signers = vec![&p];
        signers.extend(made.iter());
        env.send(&ixs, &signers).unwrap();
        let units = env.cus.last().unwrap().1;
        eprintln!("LIMIT recipe {id}: {bytes} bytes, {units} compute units");
        assert!(bytes <= 1232, "a transaction is at most 1,232 bytes; this one is {bytes}");
        assert!(units <= 1_400_000);
    }
}

/// What a converter was: a recipe of tokens only, crafted many times at once.
#[test]
fn a_recipe_of_tokens_is_an_exchange_at_the_owners_rate() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gems = env.new_mint(owner.pubkey()); // what players give
    let points = env.new_mint(env.game); // minted by the game
    let p = wallet(&mut env, gems, 1_000);
    env.token_account(p.pubkey(), points);
    env.token_account(p.pubkey(), env.mint);
    env.open_pool(&owner, 0, gems).unwrap();
    env.open_pool(&owner, 1, env.mint).unwrap();
    env.fund(owner.pubkey(), env.mint, 500);
    env.deposit(&owner, 1, env.mint, 500).unwrap();

    // 1: burn gems, mint 3 points for every 2. 2: gems into a pool, coins out of another, 1 for 10.
    let exchange = |take, to, give_mint, give, from| RecipeArgs {
        active: true,
        inputs: vec![Input::Pay { mint: gems, amount: take, to }],
        outputs: vec![Output::Tokens { mint: give_mint, amount: give, from }],
        needs: vec![],
        keeps: vec![],
    };
    let burn_for_points = exchange(2, To::Burn, points, 3, Origin::Issue);
    assert!(err(env.upsert_recipe(&p, 1, burn_for_points.clone())).contains("NotOwner"));
    env.upsert_recipe(&owner, 1, burn_for_points.clone()).unwrap();
    env.upsert_recipe(&owner, 2, exchange(10, To::Pool(0), env.mint, 1, Origin::Pool(1))).unwrap();

    let (mut ix, _) = env.craft_ix(p.pubkey(), 1, 0, &[]);
    ix.data = anchor_lang::InstructionData::data(&loot::instruction::Craft { version: 0, times: 50 });
    let logs = env.send(&[ix], &[&p]).unwrap();
    let c: loot::receipts::Crafted = receipt(&logs);
    assert_eq!(c.times, 50);
    assert_eq!((env.supply(&gems), env.tokens(&ata(&p.pubkey(), &points))), (900, 150));

    env.craft_times(&p, 2, 25, &[]).unwrap();
    assert_eq!((env.tokens(&pool_pda(&env.game, 0)), env.tokens(&pool_pda(&env.game, 1))), (250, 475));
    assert_eq!(env.tokens(&ata(&p.pubkey(), &env.mint)), 25);

    // The player signs the recipe they saw: a worse rate that lands first does not short them.
    let (mut signed, _) = env.craft_ix(p.pubkey(), 1, 0, &[]);
    signed.data = anchor_lang::InstructionData::data(&loot::instruction::Craft { version: 0, times: 50 });
    env.upsert_recipe(&owner, 1, exchange(2, To::Burn, points, 2, Origin::Issue)).unwrap();
    assert!(err(env.send(&[signed], &[&p])).contains("RecipeChanged"));
    // Nothing at all; more than fits; a wrong pool; switched off; the owner's pause.
    assert!(err(env.craft_times(&p, 2, 0, &[])).contains("ZeroAmount"));
    assert!(err(env.craft_times(&p, 2, u64::MAX, &[])).contains("Overflow"));
    let (mut ix, _) = env.craft_ix(p.pubkey(), 2, 0, &[]);
    let at = ix.accounts.iter().position(|m| m.pubkey == pool_pda(&env.game, 1)).unwrap();
    ix.accounts[at].pubkey = ata(&env.game, &env.mint);
    assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    env.upsert_recipe(&owner, 1, RecipeArgs { active: false, ..burn_for_points }).unwrap();
    assert!(err(env.craft_times(&p, 1, 1, &[])).contains("NotForSale"));
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    assert!(err(env.craft_times(&p, 2, 1, &[])).contains("Paused"));
}

#[test]
fn a_player_merges_three_shards_into_a_key() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    let other = player(&mut env, 0);
    env.upsert_item(20, item(ItemKind::Collectible, "Shard", 0, 0)).unwrap();
    env.upsert_item(21, item(ItemKind::Collectible, "Shard Key", 1, 0)).unwrap();
    env.upsert_item(22, ItemArgs { soulbound: true, ..item(ItemKind::Collectible, "Shar", 0, 0) }).unwrap();
    let recipe = merge_recipe(20, 3, 21);
    assert!(err(env.upsert_recipe(&p, 1, recipe.clone())).contains("NotOwner"));
    assert!(err(env.upsert_recipe(&owner, 1, merge_recipe(20, 9, 21))).contains("BadRecipe"));
    env.upsert_recipe(&owner, 1, recipe.clone()).unwrap();

    let shards: Vec<Pubkey> = (0..4).map(|_| env.make(&authority, 20, p.pubkey()).unwrap()).collect();
    let theirs = env.make(&authority, 20, other.pubkey()).unwrap();
    let key_item_as_input = env.make(&authority, 22, p.pubkey()).unwrap(); // "Shar #1": another item

    // Too few, someone else's, another item's, the same one twice.
    assert!(err(env.merge(&p, 1, &shards[..2])).contains("ItemMismatch"));
    assert!(err(env.merge(&p, 1, &[shards[0], shards[1], theirs])).contains("ItemMismatch"));
    assert!(err(env.merge(&p, 1, &[shards[0], shards[1], key_item_as_input])).contains("ItemMismatch"));
    assert!(env.merge(&p, 1, &[shards[0], shards[1], shards[1]]).is_err());

    let key = env.merge(&p, 1, &shards[..3]).unwrap();
    let a = *mpl_core::Asset::from_bytes(&env.data(&key)).unwrap();
    assert_eq!((a.base.owner, a.base.name.as_str()), (p.pubkey(), "Shard Key #1"));
    for shard in &shards[..3] {
        assert!(mpl_core::Asset::from_bytes(&env.data(shard)).is_err(), "burned");
    }
    assert!(mpl_core::Asset::from_bytes(&env.data(&shards[3])).is_ok());

    // The output's own supply holds (one key), and a recipe can be switched off.
    let more: Vec<Pubkey> = (0..3).map(|_| env.make(&authority, 20, p.pubkey()).unwrap()).collect();
    assert!(err(env.merge(&p, 1, &more)).contains("SoldOut"));
    assert!(mpl_core::Asset::from_bytes(&env.data(&more[0])).is_ok(), "nothing was burned");
    env.upsert_recipe(&owner, 1, RecipeArgs { active: false, ..recipe }).unwrap();
    assert!(err(env.merge(&p, 1, &more)).contains("NotForSale"));
}

/// A golden ticket cashed in for a tenth of the treasure, whatever it holds by then.
#[test]
fn a_recipe_can_give_a_share_of_what_a_pool_holds() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    jackpot(&mut env, 0, 1_000);
    let p = player(&mut env, 100);
    let cash_in = |bps| RecipeArgs {
        active: true,
        inputs: vec![Input::Pay { mint: gold, amount: 10, to: loot::state::To::Burn }],
        outputs: vec![Output::Share { mint: gold, pool: 0, bps }],
        needs: vec![],
        keeps: vec![],
    };
    assert!(err(env.upsert_recipe(&owner, 1, cash_in(0))).contains("BadRecipe"));
    assert!(err(env.upsert_recipe(&owner, 1, cash_in(10_001))).contains("BadRecipe"));
    env.upsert_recipe(&owner, 1, cash_in(1_000)).unwrap();

    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((my_coins(&env, &p.pubkey()), env.tokens(&pool_pda(&env.game, 0))), (90 + 100, 900));
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((my_coins(&env, &p.pubkey()), env.tokens(&pool_pda(&env.game, 0))), (80 + 190, 810));
    assert!(err(env.craft_times(&p, 1, 2, &[])).contains("OnceAtATime"), "a share is taken one craft at a time");
}

/// LOW, fixed. `convert` cut a result that did not fit in 64 bits down to its low bits. It
/// was refused, and the converter is a recipe of tokens now, which refuses it too.
#[test]
fn a_conversion_too_big_for_64_bits_is_refused() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gems = env.new_mint(owner.pubkey());
    let points = env.new_mint(env.game);
    let p = wallet(&mut env, gems, 10);
    env.token_account(p.pubkey(), points);
    env.upsert_recipe(&owner, 1, exchange(gems, 1, points, 1 << 63, Origin::Issue)).unwrap();
    assert!(err(env.craft_times(&p, 1, 3, &[])).contains("Overflow"));
    assert_eq!(env.supply(&gems), 10);
}

/// LOW, fixed. A merge recognised its inputs by the asset's name. Renaming an item used to
/// strand the collectibles already minted under the old name: an item's name is locked once
/// one is issued. Two items of one game with the same name were interchangeable as inputs:
/// since the fourth review a recipe also reads the item number written on the collectible.
#[test]
fn a_recipe_goes_by_name_and_number_and_a_name_cannot_change_once_issued() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(20, item(ItemKind::Collectible, "Shard", 0, 0)).unwrap();
    env.upsert_item(21, item(ItemKind::Collectible, "Shard Key", 0, 0)).unwrap();
    env.upsert_item(23, ItemArgs { rarity: 9, ..item(ItemKind::Collectible, "Shard", 0, 0) }).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(20, 2, 21)).unwrap();

    let others: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 23, p.pubkey()).unwrap()).collect();
    assert!(err(env.merge(&p, 1, &others)).contains("ItemMismatch"), "two collectibles of item 23 are not item 20");

    env.make(&authority, 20, p.pubkey()).unwrap();
    assert!(err(env.upsert_item(20, item(ItemKind::Collectible, "Fragment", 0, 0))).contains("KindLocked"));
}

/// LOW, noted (said at the top of `craft.rs`). A soulbound collectible is frozen for
/// good, and Core refuses to burn a frozen asset even for its owner, so a recipe whose input
/// item is soulbound fails every merge. `upsert_recipe` accepts it.
#[test]
fn a_recipe_with_a_soulbound_input_can_never_be_merged() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(20, ItemArgs { soulbound: true, ..item(ItemKind::Collectible, "Badge", 0, 0) }).unwrap();
    env.upsert_item(21, item(ItemKind::Collectible, "Medal", 0, 0)).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(20, 1, 21)).unwrap();
    let badge = env.make(&authority, 20, p.pubkey()).unwrap();
    let e = err(env.merge(&p, 1, &[badge]));
    assert!(e.contains("permanent_freeze_delegate") && e.contains("Reject"), "{e}");
    assert!(mpl_core::Asset::from_bytes(&env.data(&badge)).is_ok(), "still there");
}

/// The key of the asset a merge gives cannot be one of the assets it burns: Core keeps a
/// burned asset's address taken.
#[test]
fn a_merge_cannot_give_back_an_address_it_just_burned() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(20, item(ItemKind::Collectible, "Shard", 0, 0)).unwrap();
    env.upsert_item(21, item(ItemKind::Collectible, "Shard Key", 0, 0)).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(20, 1, 21)).unwrap();
    let shard = env.make(&authority, 20, p.pubkey()).unwrap();

    // The recipe's accounts, with the shard itself as the new collectible's key (signed for,
    // as its maker could).
    let (mut ix, _) = env.craft_ix(p.pubkey(), 1, 0, &[shard]);
    let last = ix.accounts.len() - 1;
    ix.accounts[last] = AccountMeta::new(shard, true);
    let e = err(env.send_unsigned(&[ix], &p));
    assert!(e.contains("already in use"), "{e}");
    assert!(mpl_core::Asset::from_bytes(&env.data(&shard)).is_ok());
    assert_eq!(env.item_state(21).issued, 0);
}

/// HIGH, fixed. A recipe line `Pay { mint, amount, to: Holder(asset) }` was paid in any mint:
/// `craft` checked the mint account but not that the paying token account was of it, and for a
/// `Holder` the other side is any token account the holder owns, which anyone can open in a
/// worthless mint. Now `craft` checks the paying account's mint, and `deliver` checks the
/// holder's account is of the payment's mint.
#[test]
fn a_recipe_payment_to_a_holder_is_paid_only_in_its_mint() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let ore = env.new_mint(env.game);
    let junk = env.new_mint(owner.pubkey()); // stands for a mint the attacker made
    let landlord = player(&mut env, 0);
    let attacker = player(&mut env, 100);
    env.upsert_item(50, collectible("Plot")).unwrap();
    let plot = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let pay = Input::Pay { mint: gold, amount: 100, to: To::Holder(plot) };
    env.upsert_recipe(&owner, 1, recipe(vec![pay], vec![Output::Tokens { mint: ore, amount: 5, from: Origin::Issue }])).unwrap();

    env.token_account(attacker.pubkey(), ore);
    env.fund(attacker.pubkey(), junk, 100);
    let landlords_junk = env.token_account(landlord.pubkey(), junk);

    // Paying from a junk account into a junk account of the landlord's.
    let (mut ix, _) = env.craft_ix(attacker.pubkey(), 1, version(&env, 1), &[]);
    swap(&mut ix, ata(&attacker.pubkey(), &gold), ata(&attacker.pubkey(), &junk));
    swap(&mut ix, ata(&landlord.pubkey(), &gold), landlords_junk);
    assert!(err(env.send(&[compute_limit(1_000_000), ix], &[&attacker])).contains("WrongMint"));

    // Paying real gold, but pointing the landlord's share at their junk account.
    let (mut ix, _) = env.craft_ix(attacker.pubkey(), 1, version(&env, 1), &[]);
    swap(&mut ix, ata(&landlord.pubkey(), &gold), landlords_junk);
    assert!(err(env.send(&[compute_limit(1_000_000), ix], &[&attacker])).contains("NotTheHolders"));

    env.craft(&attacker, 1, &[]).unwrap();
    assert_eq!((balance_of(&env, &attacker, &ore), balance_of(&env, &landlord, &gold), env.tokens(&landlords_junk)), (5, 100, 0));
}

/// MEDIUM, fixed. One collectible filled a `Use` line and then a `Burn` line of the same
/// recipe, so a recipe that asks for two of an item was crafted with one. Now a collectible
/// fills one place in a craft, whatever the lines.
#[test]
fn one_collectible_fills_one_place_in_a_craft() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(74, collectible("Mare")).unwrap();
    env.upsert_item(76, collectible("Foal")).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Use { item: 74 }, Input::Burn { item: 74, count: 1 }], vec![Output::Item(76)])).unwrap();
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Burn { item: 74, count: 1 }, Input::Use { item: 74 }], vec![Output::Item(76)])).unwrap();
    let mares: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 74, p.pubkey()).unwrap()).collect();

    assert!(err(env.craft(&p, 1, &[mares[0], mares[0]])).contains("ItemMismatch"));
    assert!(err(env.craft(&p, 2, &[mares[0], mares[0]])).contains("ItemMismatch"));
    assert!(alive(&env, &mares[0]));
    env.craft(&p, 1, &[mares[0], mares[1]]).unwrap();
    assert!(alive(&env, &mares[0]) && !alive(&env, &mares[1]));
}

/// LOW, fixed. A recipe line paid to `Holder(asset)` cost nothing when nobody held the asset:
/// the line was skipped and every output still given. Now the payment is burned instead.
#[test]
fn a_recipe_payment_to_a_holder_is_never_free() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let ore = env.new_mint(env.game);
    let landlord = player(&mut env, 0);
    let poor = player(&mut env, 0);
    let p = player(&mut env, 250);
    env.token_account(poor.pubkey(), ore);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(50, collectible("Plot")).unwrap();
    let plot = env.make(&authority, 50, landlord.pubkey()).unwrap();
    let pay = Input::Pay { mint: gold, amount: 100, to: To::Holder(plot) };
    env.upsert_recipe(&owner, 1, recipe(vec![pay], vec![Output::Tokens { mint: ore, amount: 5, from: Origin::Issue }])).unwrap();

    env.hold(&landlord, plot, 0).unwrap();
    assert!(env.craft(&poor, 1, &[]).is_err(), "held by the game: it still costs 100 gold");
    let supply = env.supply(&gold);
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((balance_of(&env, &p, &gold), supply - env.supply(&gold), balance_of(&env, &landlord, &gold)), (150, 100, 0));

    env.take_back(&poor, plot).unwrap();
    burn_as_owner(&mut env, &landlord, plot);
    assert!(env.craft(&poor, 1, &[]).is_err(), "burned: it still costs 100 gold");
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!((balance_of(&env, &p, &gold), balance_of(&env, &p, &ore)), (50, 10));
}

/// A recipe's lines are matched to accounts strictly: one asset cannot be burned twice, a
/// cheaper item cannot stand in for the one a line names, someone else's asset is not the
/// player's, and missing accounts are refused. Accounts after the last line are for a transfer
/// hook (since Token-2022 support): they are accepted and nothing is done with them here.
#[test]
fn a_recipes_accounts_cannot_be_substituted_or_repeated() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    let other = player(&mut env, 0);
    env.upsert_item(30, collectible("Fish")).unwrap();
    env.upsert_item(31, collectible("Fish Bone")).unwrap(); // a name that starts the same
    env.upsert_item(32, collectible("Trophy")).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(30, 2, 32)).unwrap();
    let fish = env.make(&authority, 30, p.pubkey()).unwrap();
    let bones: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 31, p.pubkey()).unwrap()).collect();
    let theirs = env.make(&authority, 30, other.pubkey()).unwrap();

    assert!(env.craft(&p, 1, &[fish, fish]).is_err(), "one fish is not two");
    assert!(err(env.craft(&p, 1, &bones)).contains("ItemMismatch"), "a bone is not a fish");
    assert!(err(env.craft(&p, 1, &[fish, theirs])).contains("ItemMismatch"));
    assert!(err(env.craft(&p, 1, &[fish])).contains("ItemMismatch"), "too few");

    // The item account of the line swapped for the cheaper item's.
    let (mut ix, made) = env.craft_ix(p.pubkey(), 1, version(&env, 1), &bones);
    let at = ix.accounts.iter().position(|m| m.pubkey == item_pda(&env.game, 30)).unwrap();
    ix.accounts[at].pubkey = item_pda(&env.game, 31);
    assert!(err(env.send(&[compute_limit(1_000_000), ix], &[&p, &made[0]])).contains("ItemMismatch"));

    // An extra account after the last line: someone else's fish, which stays theirs.
    let fish2 = env.make(&authority, 30, p.pubkey()).unwrap();
    let (mut ix, made) = env.craft_ix(p.pubkey(), 1, version(&env, 1), &[fish, fish2]);
    ix.accounts.push(AccountMeta::new(theirs, false));
    env.send(&[compute_limit(1_000_000), ix], &[&p, &made[0]]).unwrap();
    assert!(!alive(&env, &fish) && !alive(&env, &fish2) && env.item_state(32).issued == 1);
    assert!(alive(&env, &theirs) && holder(&env, &theirs) == other.pubkey());
}

/// MEDIUM, fixed. A recipe recognised a collectible by its name alone, and an admin can write
/// a new item with the name of an existing one and sell it for next to nothing: what it sold
/// was, to every recipe, the real thing, and an admin emptied a pool through the owner's own
/// recipe. Now a recipe also reads the item number written on the collectible, which `set`
/// never changes.
#[test]
fn an_item_with_anothers_name_is_not_taken_for_it() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let funder = player(&mut env, 10_000);
    env.deposit(&funder, 0, gold, 10_000).unwrap();
    env.upsert_item(30, collectible("Fish")).unwrap(); // not for sale: the game hands fish out
    let salvage = recipe(vec![Input::Burn { item: 30, count: 1 }], vec![Output::Tokens { mint: gold, amount: 5_000, from: Origin::Pool(0) }]);
    env.upsert_recipe(&owner, 1, salvage).unwrap();

    let admin = env.player.insecure_clone();
    // (When this was found an admin could write the look-alike. A game has no admins now, so
    // here the owner makes the mistake of two items with one name.)
    let fake = ItemArgs { shares: vec![], ..item(ItemKind::Collectible, "Fish", 0, 1) };
    assert!(err(env.upsert_item_as(&admin, 999, fake.clone())).contains("NotOwner"));
    env.upsert_item(999, fake).unwrap();

    env.buy(999, 1).unwrap();
    let order = order_pda(&env.game, &admin.pubkey(), 1);
    let fish = env.asset_pda(&order);
    env.settle(order, &admin).unwrap();
    assert!(err(env.craft(&admin, 1, &[fish])).contains("ItemMismatch"));
    // Nor after the authority writes on it: which item a collectible is never changes.
    env.set(&authority, fish, &[("item_id", "30"), ("level", "2")]).unwrap();
    assert!(err(env.craft(&admin, 1, &[fish])).contains("ItemMismatch"));
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 10_000);

    let real = env.make(&authority, 30, admin.pubkey()).unwrap();
    env.craft(&admin, 1, &[real]).unwrap();
}

/// `Renew` set `used` to 0, and `Use` only checked the cooldown when `used` was
/// not 0, so a renewal was also a skipped cooldown. Now the cooldown counts from the last use
/// whatever the count says: a repair is not a turn.
#[test]
fn a_renew_does_not_skip_the_cooldown() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let ore = env.new_mint(env.game);
    let p = player(&mut env, 0);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(60, ItemArgs { life: Some(Life { ready_after: 0, lasts: 0, uses: 2, cooldown: DAY as u32 }), ..collectible("Mine") }).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Use { item: 60 }], vec![Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }])).unwrap();
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Renew { item: 60 }], vec![])).unwrap();
    let mine = env.make(&authority, 60, p.pubkey()).unwrap();

    env.craft(&p, 1, &[mine]).unwrap();
    env.craft(&p, 2, &[mine]).unwrap();
    assert!(err(env.craft(&p, 1, &[mine])).contains("NotReady"), "renewed, and still once a day");
    for _ in 0..3 {
        env.wait(DAY);
        env.craft(&p, 1, &[mine]).unwrap();
        env.craft(&p, 2, &[mine]).unwrap();
    }
    assert_eq!(balance_of(&env, &p, &ore), 4, "a renewal lifts the count of uses, never the wait");
}

/// Two `Keep`s of one key into the same new collectible wrote the key twice, and
/// everything that reads a number read the first. Now a recipe keeps a key once per collectible.
#[test]
fn a_recipe_keeps_a_key_once_for_each_new_collectible() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    env.upsert_item(74, collectible("Mare")).unwrap();
    env.upsert_item(75, collectible("Stud")).unwrap();
    env.upsert_item(76, collectible("Foal")).unwrap();
    let breed = |keeps| RecipeArgs { keeps, ..recipe(vec![Input::Use { item: 74 }, Input::Use { item: 75 }], vec![Output::Item(76), Output::Item(76)]) };
    let keep = |from, to| Keep { key: "speed".into(), from, to };
    assert!(err(env.upsert_recipe(&owner, 1, breed(vec![keep(0, 0), keep(1, 0)]))).contains("BadRecipe"));
    env.upsert_recipe(&owner, 1, breed(vec![keep(0, 0), keep(1, 1)])).unwrap();
}

/// `times` and the converter's removal. An exchange is a recipe of tokens crafted `times` over.
/// What the converter's `min_out` gave, the signed version gives: an edit of the rate that lands
/// first fails the craft. Amounts are multiplied with a check, a recipe with a collectible on
/// either side is crafted once, a pool in the place of the recipe's pool is refused, and a pool
/// that cannot pay the whole of it pays none of it.
#[test]
fn an_exchange_is_a_recipe_crafted_many_times_at_the_rate_the_player_signed() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let gems = env.new_mint(owner.pubkey());
    let points = env.new_mint(env.game);
    env.open_pool(&owner, 0, gold).unwrap();
    env.open_pool(&owner, 1, gold).unwrap();
    let funder = player(&mut env, 2_000);
    env.deposit(&funder, 0, gold, 1_000).unwrap();
    env.deposit(&funder, 1, gold, 1_000).unwrap();
    let p = player(&mut env, 0);
    env.fund(p.pubkey(), gems, 1_000);
    env.token_account(p.pubkey(), points);

    let rate = |out| recipe(vec![Input::Pay { mint: gems, amount: 2, to: To::Burn }], vec![Output::Tokens { mint: points, amount: out, from: Origin::Issue }]);
    env.upsert_recipe(&owner, 1, rate(3)).unwrap();
    assert!(err(env.craft_times(&p, 1, 0, &[])).contains("ZeroAmount"));
    assert!(err(env.craft_times(&p, 1, u64::MAX, &[])).contains("Overflow"));
    assert!(env.craft_times(&p, 1, 501, &[]).is_err(), "1,002 gems are not there");
    env.craft_times(&p, 1, 100, &[]).unwrap();
    assert_eq!((balance_of(&env, &p, &gems), balance_of(&env, &p, &points)), (800, 300));

    // The owner cuts the rate while the player's transaction is on its way.
    let (mut signed, _) = env.craft_ix(p.pubkey(), 1, version(&env, 1), &[]);
    signed.data = loot::instruction::Craft { version: version(&env, 1), times: 100 }.data();
    env.upsert_recipe(&owner, 1, rate(1)).unwrap();
    assert!(err(env.send(&[signed], &[&p])).contains("RecipeChanged"));
    assert_eq!(balance_of(&env, &p, &gems), 800);

    // From a pool: all of it or none, and only the pool the recipe names.
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Pay { mint: gems, amount: 1, to: To::Burn }], vec![Output::Tokens { mint: gold, amount: 300, from: Origin::Pool(0) }])).unwrap();
    assert!(env.craft_times(&p, 2, 4, &[]).is_err(), "the pool holds 1,000");
    let (mut ix, _) = env.craft_ix(p.pubkey(), 2, version(&env, 2), &[]);
    ix.accounts.iter_mut().filter(|m| m.pubkey == pool_pda(&env.game, 0)).for_each(|m| m.pubkey = pool_pda(&env.game, 1));
    assert!(err(env.send(&[ix], &[&p])).contains("WrongPool"));
    env.craft_times(&p, 2, 3, &[]).unwrap();
    assert_eq!((balance_of(&env, &p, &gems), balance_of(&env, &p, &gold), env.tokens(&pool_pda(&env.game, 1))), (797, 900, 1_000));

    // A collectible on either side: once at a time.
    env.upsert_item(30, collectible("Fish")).unwrap();
    env.upsert_recipe(&owner, 3, recipe(vec![Input::Pay { mint: gems, amount: 1, to: To::Burn }], vec![Output::Item(30)])).unwrap();
    env.upsert_recipe(&owner, 4, recipe(vec![Input::Use { item: 30 }], vec![Output::Tokens { mint: points, amount: 1, from: Origin::Issue }])).unwrap();
    let fish = env.make(&authority, 30, p.pubkey()).unwrap();
    assert!(err(env.craft_times(&p, 3, 2, &[])).contains("OnceAtATime"));
    assert!(err(env.craft_times(&p, 4, 2, &[fish])).contains("OnceAtATime"));
}

/// `Need` and `Keep`. A need is read from the collectible in its own place and nowhere else, a
/// value that is not a number is 0, a player cannot write one, and a recipe cannot be written
/// to carry the program's own numbers (`made`, `used`, `used_at`, the serial) to a new
/// collectible, or to name a place it does not have.
#[test]
fn a_need_is_read_from_its_own_place_and_a_keep_never_carries_the_programs_numbers() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let col = env.collection;
    let p = player(&mut env, 0);
    env.upsert_item(40, collectible("Hero")).unwrap();
    env.upsert_item(41, collectible("Sword")).unwrap();
    env.upsert_item(42, collectible("Medal")).unwrap();
    let quest = |needs, keeps| RecipeArgs { needs, keeps, ..recipe(vec![Input::Use { item: 40 }, Input::Burn { item: 41, count: 2 }], vec![Output::Item(42)]) };
    let need = |place, at_least| Need { place, key: "level".into(), at_least };
    let keep = |key: &str, from, to| Keep { key: key.into(), from, to };

    for bad in [vec![need(3, 1)], vec![Need { place: 0, key: "".into(), at_least: 1 }]] {
        assert!(err(env.upsert_recipe(&owner, 1, quest(bad, vec![]))).contains("BadRecipe"));
    }
    for bad in [keep("made", 0, 0), keep("used", 0, 0), keep("used_at", 0, 0), keep("serial", 0, 0), keep("item_id", 0, 0), keep("level", 3, 0), keep("level", 0, 1)] {
        assert!(err(env.upsert_recipe(&owner, 1, quest(vec![], vec![bad]))).contains("BadRecipe"));
    }
    // The hero of level 10, and the second sword of level 2.
    env.upsert_recipe(&owner, 1, quest(vec![need(0, 10), need(2, 2)], vec![keep("level", 0, 0)])).unwrap();
    let hero = env.make(&authority, 40, p.pubkey()).unwrap();
    let swords: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 41, p.pubkey()).unwrap()).collect();

    assert!(err(env.craft(&p, 1, &[hero, swords[0], swords[1]])).contains("NeedNotMet"), "nothing written");
    // The player cannot write a level: the attribute list is the collection's.
    let forge = UpdatePluginV1Builder::new()
        .asset(hero)
        .collection(Some(col))
        .payer(p.pubkey())
        .plugin(Plugin::Attributes(mpl_core::types::Attributes { attribute_list: vec![mpl_core::types::Attribute { key: "level".into(), value: "99".into() }] }))
        .instruction();
    assert!(err(env.send(&[forge], &[&p])).contains(CORE_NO_APPROVALS));

    env.set(&authority, hero, &[("level", "ten")]).unwrap();
    env.set(&authority, swords[0], &[("level", "50")]).unwrap();
    assert!(err(env.craft(&p, 1, &[hero, swords[0], swords[1]])).contains("NeedNotMet"), "not a number");
    env.set(&authority, hero, &[("level", "10")]).unwrap();
    assert!(err(env.craft(&p, 1, &[hero, swords[0], swords[1]])).contains("NeedNotMet"), "the level is on the first sword, asked of the second");
    let medal = env.craft(&p, 1, &[hero, swords[1], swords[0]]).unwrap()[0];
    let on_medal = written(&env, &medal);
    assert!(on_medal.contains(&("level".into(), "10".into())) && on_medal.iter().filter(|(key, _)| key == "made").count() == 1);
    assert!(alive(&env, &hero) && !alive(&env, &swords[0]));
}

/// Fix 5, and what it has to hold against. A collectible is one of an item only when the item
/// number written on it says so, and nothing a player or an admin can reach writes that
/// number: an admin's item with the same name carries its own number; an asset of the game's
/// collection with the right name and no attribute list is refused, and so is one whose list
/// has no item number.
#[test]
fn a_recipe_reads_the_item_number_and_only_the_game_writes_it() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let p = player(&mut env, 10_000);
    env.deposit(&p, 0, gold, 10_000).unwrap();
    env.upsert_item(30, collectible("Fish")).unwrap();
    let salvage = recipe(vec![Input::Burn { item: 30, count: 1 }], vec![Output::Tokens { mint: gold, amount: 5_000, from: Origin::Pool(0) }]);
    env.upsert_recipe(&owner, 1, salvage).unwrap();

    // The right name and collection, minted straight through Core with no attributes, and
    // with attributes that name no item. (Only the collection's owner can mint these: the
    // point is what the program does with one.)
    let mut bare = vec![];
    for attributes in [None, Some(vec![("level", "9")]), Some(vec![("item_id", "x30")])] {
        let asset = Keypair::new();
        let mut create = CreateV2Builder::new();
        create.asset(asset.pubkey()).collection(Some(env.collection)).payer(owner.pubkey()).authority(Some(owner.pubkey())).owner(Some(p.pubkey())).name("Fish #7".into()).uri("x".into());
        if let Some(list) = attributes {
            let attribute_list = list.into_iter().map(|(k, v)| mpl_core::types::Attribute { key: k.into(), value: v.into() }).collect();
            create.plugins(vec![mpl_core::types::PluginAuthorityPair { plugin: mpl_core::types::Plugin::Attributes(mpl_core::types::Attributes { attribute_list }), authority: None }]);
        }
        env.send(&[create.instruction()], &[&owner, &asset]).unwrap();
        assert!(err(env.craft(&p, 1, &[asset.pubkey()])).contains("ItemMismatch"));
        bare.push(asset.pubkey());
    }
    // `set` cannot write on an asset with no attribute list (Core refuses), and on the others
    // it writes no item number.
    assert!(env.set(&authority, bare[0], &[("item_id", "30")]).is_err());
    env.set(&authority, bare[1], &[("item_id", "30")]).unwrap();
    assert_eq!(written(&env, &bare[1]), vec![]);
    assert!(err(env.craft(&p, 1, &[bare[1]])).contains("ItemMismatch"));

    // Another item called Fish, bought by a player: its number is its own.
    let admin = player(&mut env, 0);
    env.upsert_item(999, ItemArgs { shares: vec![], ..item(ItemKind::Collectible, "Fish", 0, 1) }).unwrap();
    env.buy(999, 1).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    let fake = env.asset_pda(&order);
    env.settle(order, &admin).unwrap();
    assert_eq!(value(&written(&env, &fake), "item_id").as_deref(), Some("999"));
    let buyer = env.player.insecure_clone();
    assert!(err(env.craft(&buyer, 1, &[fake])).contains("ItemMismatch"));
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 10_000);
}

/// The cooldown fix at its edges: an item with a cooldown and no count of uses. A renewal
/// before the first use is not a use; a renewal after one does not shorten the wait; and
/// neither does the authority writing something else on it.
#[test]
fn a_cooldown_counts_from_the_last_use_through_a_renewal_and_a_set() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let ore = env.new_mint(env.game);
    let p = player(&mut env, 0);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(60, ItemArgs { soulbound: true, life: Some(Life { ready_after: 0, lasts: 0, uses: 0, cooldown: DAY as u32 }), ..collectible("Pass") }).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Use { item: 60 }], vec![Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }])).unwrap();
    env.upsert_recipe(&owner, 2, recipe(vec![Input::Renew { item: 60 }], vec![])).unwrap();
    let pass = env.make(&authority, 60, p.pubkey()).unwrap();

    env.craft(&p, 2, &[pass]).unwrap(); // renewed before it was ever used
    assert_eq!(value(&written(&env, &pass), "used_at"), None);
    env.craft(&p, 1, &[pass]).unwrap();
    for _ in 0..2 {
        env.craft(&p, 2, &[pass]).unwrap();
        env.set(&authority, pass, &[("level", "2")]).unwrap();
        env.wait(DAY - 1);
        assert!(err(env.craft(&p, 1, &[pass])).contains("NotReady"));
        env.wait(1);
        env.craft(&p, 1, &[pass]).unwrap();
    }
    assert_eq!(balance_of(&env, &p, &ore), 3);
    assert_eq!(keys(&written(&env, &pass)).iter().filter(|k| **k == "used" || **k == "used_at").count(), 2, "each written once");
}

/// The receipt fix: `Crafted` names the version that was crafted, and a craft signed for an
/// older version is refused, so the version on a receipt is the one whose lines moved.
#[test]
fn the_crafted_receipt_names_the_version_whose_lines_moved() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let points = env.new_mint(env.game);
    let p = player(&mut env, 100);
    let gold = env.mint;
    env.token_account(p.pubkey(), points);
    let rate = |amount| recipe(vec![Input::Pay { mint: gold, amount: 2, to: To::Burn }], vec![Output::Tokens { mint: points, amount, from: Origin::Issue }]);
    env.upsert_recipe(&owner, 1, rate(3)).unwrap();
    let (mut old, _) = env.craft_ix(p.pubkey(), 1, 0, &[]);
    old.data = loot::instruction::Craft { version: 0, times: 5 }.data();
    env.upsert_recipe(&owner, 1, rate(1)).unwrap();
    assert!(err(env.send(&[old], &[&p])).contains("RecipeChanged"));

    let (mut new, _) = env.craft_ix(p.pubkey(), 1, 1, &[]);
    new.data = loot::instruction::Craft { version: 1, times: 5 }.data();
    let logs = env.send(&[new], &[&p]).unwrap();
    let crafted: loot::receipts::Crafted = receipt(&logs);
    assert_eq!((crafted.id, crafted.version, crafted.times, crafted.player), (1, 1, 5, p.pubkey()));
    assert_eq!((balance_of(&env, &p, &gold), balance_of(&env, &p, &points)), (90, 5));
}

/// A recipe's `Share` only pays from a pool of the mint it names, and never `times` over.
#[test]
fn a_recipe_share_names_its_mint() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let other = env.new_mint(owner.pubkey());
    jackpot(&mut env, 0, 1_000);
    let p = player(&mut env, 100);
    env.token_account(p.pubkey(), other);
    let recipe = |mint| RecipeArgs {
        active: true,
        inputs: vec![Input::Pay { mint: gold, amount: 10, to: loot::state::To::Burn }],
        outputs: vec![Output::Share { mint, pool: 0, bps: 1_000 }],
        needs: vec![],
        keeps: vec![],
    };
    env.upsert_recipe(&owner, 1, recipe(other)).unwrap();
    assert!(err(env.craft(&p, 1, &[])).contains("WrongPool"));
    env.upsert_recipe(&owner, 1, recipe(gold)).unwrap();
    assert!(err(env.craft_times(&p, 1, 3, &[])).contains("OnceAtATime"));
    env.craft(&p, 1, &[]).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 0)), 900);
}
