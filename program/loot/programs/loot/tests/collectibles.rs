//! The authority's collectibles: `make`, `unmake` and `set`.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    common::*,
    loot::Input,
    loot::ItemArgs,
    loot::Origin,
    loot::Output,
    loot::RecipeArgs,
    loot::state::ItemKind,
    loot::state::Life,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn make_with(env: &mut Env, who: &Keypair, item_id: u32, owner: Pubkey, asset: &Keypair) -> Result<Vec<String>, String> {
    env.ix(
        loot::instruction::Make { reference: REF }.data(),
        loot::accounts::Make {
            authority: who.pubkey(),
            game: env.game,
            item: item_pda(&env.game, item_id),
            collection: env.collection,
            asset: asset.pubkey(),
            owner,
            mpl_core_program: mpl_core::ID,
            fee: env.fee(),
        }
        .to_account_metas(None),
        &[who, asset],
    )
}

/// Every attribute written on an asset, in order.
fn written(env: &Env, asset: &Pubkey) -> Vec<(String, String)> {
    let asset = mpl_core::Asset::from_bytes(&env.data(asset)).unwrap();
    let list = asset.plugin_list.attributes.unwrap().attributes.attribute_list;
    list.into_iter().map(|a| (a.key, a.value)).collect()
}

fn holder(env: &Env, asset: &Pubkey) -> Pubkey {
    mpl_core::Asset::from_bytes(&env.data(asset)).unwrap().base.owner
}

fn asset_of(env: &Env, key: &anchor_lang::prelude::Pubkey) -> mpl_core::Asset {
    *mpl_core::Asset::from_bytes(&env.data(key)).unwrap()
}

fn has_receipt(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

fn attributes(env: &Env, key: &anchor_lang::prelude::Pubkey) -> Vec<(String, String)> {
    let list = asset_of(env, key).plugin_list.attributes.unwrap().attributes.attribute_list;
    list.into_iter().map(|a| (a.key, a.value)).collect()
}

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

fn keys(list: &[(String, String)]) -> Vec<&str> {
    list.iter().map(|(k, _)| k.as_str()).collect()
}

fn value(list: &[(String, String)], key: &str) -> Option<String> {
    list.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn recipe(inputs: Vec<Input>, outputs: Vec<Output>) -> RecipeArgs {
    RecipeArgs { active: true, inputs, outputs, needs: vec![], keeps: vec![] }
}

/// A `Normal` item's `life` and `soulbound` are dropped without a word.
#[test]
fn a_normal_item_silently_loses_its_life_and_soulbound_flag() {
    let mut env = setup();
    let life = Some(Life { ready_after: 0, lasts: 0, uses: 0, cooldown: DAY as u32 });
    env.upsert_item(5, ItemArgs { soulbound: true, life, ..item(ItemKind::Normal, "Potion", 0, PRICE) }).unwrap();
    let it = env.item_state(5);
    assert_eq!((it.life, it.soulbound), (None, false));
}

/// Note: unlike every address this program creates itself (`rent::create`, which tolerates
/// parked lamports), the Core asset of a `make` is created by Core with a plain
/// `create_account`, so a key that someone sent lamports to first is refused ("already in
/// use"). The key is a fresh keypair only the sender knows, so this needs front-running the
/// transaction; the sender retries with another key and nothing is owed yet, so it is a note.
/// A used key is refused the same way. `set` never changes which item a collectible is, even
/// when named, and keeps `made`.
#[test]
fn make_refuses_a_prefunded_or_used_key_and_set_never_changes_the_item() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let p = player(&mut env, 0);
    let parked = Keypair::new();
    env.svm.airdrop(&parked.pubkey(), 1).unwrap();
    assert!(err(make_with(&mut env, &authority, 1, p.pubkey(), &parked)).contains("already in use"));
    let key = Keypair::new();
    make_with(&mut env, &authority, 1, p.pubkey(), &key).unwrap();
    assert_eq!(holder(&env, &key.pubkey()), p.pubkey());
    assert!(err(make_with(&mut env, &authority, 1, p.pubkey(), &key)).contains("already in use"), "a used key");
    let before = written(&env, &key.pubkey());
    let made = before.iter().find(|(k, _)| k == "made").unwrap().1.clone();
    env.set(&authority, key.pubkey(), &[("item_id", "999"), ("rarity", "0"), ("serial", "77"), ("level", "7")]).unwrap();
    let after = written(&env, &key.pubkey());
    let get = |k: &str| after.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    assert_eq!((get("item_id"), get("rarity"), get("serial"), get("level"), get("made")), (Some("1".into()), Some("3".into()), Some("1".into()), Some("7".into()), Some(made)));
    assert_eq!(after.len(), 5);
}

#[test]
fn the_authority_makes_a_collectible_without_a_sale() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let owner = env.creator.insecure_clone();
    let winner = Keypair::new().pubkey();

    // Item 1 has a supply of 2.
    let fees_before = env.fees();
    let asset = env.make(&authority, 1, winner).unwrap();
    let a = asset_of(&env, &asset);
    assert_eq!((a.base.owner, a.base.name.as_str()), (winner, "Gecko Crown #1"));
    assert_eq!(a.base.update_authority, mpl_core::types::UpdateAuthority::Collection(env.collection));
    assert!(a.plugin_list.permanent_burn_delegate.is_none(), "not a burnable item");
    assert_eq!(env.item_state(1).issued, 1);
    assert_eq!(env.fees() - fees_before, FEE);

    assert!(err(env.make(&owner, 1, winner).map(|_| ())).contains("NotAuthority"));
    // A normal item lives in the game's backend: there is nothing to mint.
    assert!(err(env.make(&authority, 2, winner).map(|_| ())).contains("NotCollectible"));
    // The item's own supply holds, and sales share it.
    assert!(err(env.buy(1, 1)).contains("NotForSale"), "item 1 has no shop price");
    env.make(&authority, 1, winner).unwrap();
    assert!(err(env.make(&authority, 1, winner).map(|_| ())).contains("SoldOut"));
    // The owner raises it, and the authority makes again.
    env.upsert_item(1, item(ItemKind::Collectible, "Gecko Crown", 3, 0)).unwrap();
    let third = env.make(&authority, 1, winner).unwrap();
    assert_eq!(asset_of(&env, &third).base.name, "Gecko Crown #3");
}

#[test]
fn the_authority_sets_attributes_and_burns_what_is_burnable() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let owner = env.creator.insecure_clone();
    let holder = Keypair::new().pubkey();
    env.upsert_item(8, ItemArgs { burnable: true, ..item(ItemKind::Collectible, "Arena Ticket", 0, 0) }).unwrap();

    let ticket = env.make(&authority, 8, holder).unwrap();
    let crown = env.make(&authority, 1, holder).unwrap();
    let burner = asset_of(&env, &ticket).plugin_list.permanent_burn_delegate.unwrap();
    assert_eq!(burner.base.authority, mpl_core::types::PluginAuthority::Address { address: env.game }.into());

    // set: a level gained. The whole list is replaced, except the program's own numbers.
    assert_eq!(attributes(&env, &crown).len(), 4, "item id, rarity, serial, and when it was made");
    let logs = env.set(&authority, crown, &[("item_id", "1"), ("serial", "1"), ("level", "7"), ("repaired", "yes")]).unwrap();
    assert!(has_receipt(&logs));
    let now = attributes(&env, &crown);
    assert_eq!(now.len(), 6, "level and repaired; which item it is (item id, rarity, serial) and `made` stay");
    assert!(now.contains(&("level".into(), "7".into())) && now.iter().any(|(key, _)| key == "made"));
    assert!(err(env.set(&owner, crown, &[])).contains("NotAuthority"));

    // unmake: the ticket is used at the door, whoever holds it. The crown cannot be burned.
    assert!(err(env.unmake(&owner, ticket)).contains("NotAuthority"));
    assert!(env.unmake(&authority, crown).is_err(), "Core refuses: the game is not its burn delegate");
    let logs = env.unmake(&authority, ticket).unwrap();
    assert!(has_receipt(&logs));
    assert!(mpl_core::Asset::from_bytes(&env.data(&ticket)).is_err(), "burned");
    assert!(env.set(&authority, ticket, &[]).is_err());
}

/// The authority of one game has no say over another game's collectibles.
#[test]
fn a_games_authority_cannot_touch_another_collection() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let other_owner = funded(&mut env);
    let collection = Keypair::new();
    let asset = Keypair::new();
    let ixs = [
        mpl_core::instructions::CreateCollectionV2Builder::new()
            .collection(collection.pubkey())
            .payer(other_owner.pubkey())
            .name("Someone Else".into())
            .uri("https://example.invalid/else.json".into())
            .instruction(),
        mpl_core::instructions::CreateV2Builder::new()
            .asset(asset.pubkey())
            .collection(Some(collection.pubkey()))
            .payer(other_owner.pubkey())
            .name("Theirs".into())
            .uri("https://example.invalid/theirs.json".into())
            .instruction(),
    ];
    env.send(&ixs, &[&other_owner, &collection, &asset]).unwrap();

    assert!(env.set(&authority, asset.pubkey(), &[("stolen", "1")]).is_err());
    assert!(env.unmake(&authority, asset.pubkey()).is_err());
}

/// An item's `Life` is counted from numbers on the collectible, and `set` replaces
/// the whole list: a level written without `made` made an egg hatch at once and fresh milk
/// expire. Now `set` keeps the program's three numbers unless the new list names them.
#[test]
fn a_set_keeps_the_programs_numbers_unless_it_names_them() {
    let mut env = setup();
    env.wait(1_700_000_000); // the test chain starts in 1970; a real one does not
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let p = player(&mut env, 0);
    let life = |ready_after, lasts| Some(Life { ready_after, lasts, uses: 0, cooldown: 0 });
    env.upsert_item(70, ItemArgs { life: life(DAY as u32, 0), ..collectible("Egg") }).unwrap();
    env.upsert_item(71, collectible("Chick")).unwrap();
    env.upsert_item(72, ItemArgs { life: life(0, DAY as u32), ..collectible("Milk") }).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(70, 1, 71)).unwrap();
    env.upsert_recipe(&owner, 2, merge_recipe(72, 1, 71)).unwrap();
    let egg = env.make(&authority, 70, p.pubkey()).unwrap();
    let milk = env.make(&authority, 72, p.pubkey()).unwrap();

    env.set(&authority, egg, &[("level", "2")]).unwrap();
    assert!(err(env.craft(&p, 1, &[egg])).contains("NotReady"), "a level-up hatches nothing");
    env.set(&authority, milk, &[("level", "2")]).unwrap();
    env.craft(&p, 2, &[milk]).unwrap();

    // The authority is still the authority: it can write the number itself.
    env.set(&authority, egg, &[("made", "0")]).unwrap();
    env.craft(&p, 1, &[egg]).unwrap();
}

/// Fix "set keeps the program's numbers", case by case, on the real Core program: an empty
/// list, a list that names the fixed three, one that names the other three, twice in a row,
/// and a burned asset. No key is ever written twice, and the list Core holds afterwards is the
/// one a recipe reads.
#[test]
fn set_keeps_the_fixed_three_writes_nothing_twice_and_core_takes_every_list() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let ore = env.new_mint(env.game);
    let p = player(&mut env, 0);
    env.token_account(p.pubkey(), ore);
    env.upsert_item(60, ItemArgs { burnable: true, life: Some(Life { ready_after: 0, lasts: 0, uses: 5, cooldown: 0 }), ..collectible("Mine") }).unwrap();
    env.upsert_recipe(&owner, 1, recipe(vec![Input::Use { item: 60 }], vec![Output::Tokens { mint: ore, amount: 1, from: Origin::Issue }])).unwrap();
    let mine = env.make(&authority, 60, p.pubkey()).unwrap();
    let fresh = written(&env, &mine);
    assert_eq!(keys(&fresh), ["item_id", "rarity", "serial", "made"]);

    // An empty list on a new collectible: the four stay.
    env.set(&authority, mine, &[]).unwrap();
    assert_eq!(written(&env, &mine), fresh);

    env.craft(&p, 1, &[mine]).unwrap();
    let used = written(&env, &mine);
    assert_eq!(keys(&used), ["item_id", "rarity", "serial", "made", "used", "used_at"]);

    // An empty list on a used one: all six stay, as they were.
    env.set(&authority, mine, &[]).unwrap();
    assert_eq!(written(&env, &mine), used);

    // A list that tries the fixed three and writes one of the others.
    env.set(&authority, mine, &[("item_id", "1"), ("rarity", "9"), ("serial", "77"), ("level", "3"), ("used", "4")]).unwrap();
    let now = written(&env, &mine);
    assert_eq!(keys(&now), ["level", "used", "item_id", "rarity", "serial", "made", "used_at"]);
    for key in ["item_id", "rarity", "serial", "made", "used_at"] {
        assert_eq!(value(&now, key), value(&used, key), "{key}");
    }
    assert_eq!(value(&now, "used").as_deref(), Some("4"));

    // The same list again changes nothing, and the recipe still reads the collectible.
    env.set(&authority, mine, &[("level", "3"), ("used", "4")]).unwrap();
    assert_eq!(written(&env, &mine), now);
    env.craft(&p, 1, &[mine]).unwrap();
    assert_eq!(value(&written(&env, &mine), "used").as_deref(), Some("5"));
    assert!(err(env.craft(&p, 1, &[mine])).contains("UsedUp"));

    // A burned one: nothing to read, and Core refuses.
    env.unmake(&authority, mine).unwrap();
    assert!(env.set(&authority, mine, &[("level", "1")]).is_err());
}
