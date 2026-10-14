//! The platform and a game's settings: fees, switches, the owner, the catalog.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::bpf_loader_upgradeable,
    anchor_lang::solana_program::instruction::Instruction,
    common::*,
    loot::Action,
    loot::GameUpdate,
    loot::Input,
    loot::ItemArgs,
    loot::LotteryArgs,
    loot::Origin,
    loot::Output,
    loot::RecipeArgs,
    loot::ScheduleArgs,
    loot::receipts::Unstaked,
    loot::state::DropEntry,
    loot::state::Fees,
    loot::state::ItemKind,
    loot::state::Order,
    loot::state::Share,
    loot::state::To,
    mpl_core::instructions::*,
    mpl_core::types::BurnDelegate,
    mpl_core::types::ExternalPluginAdapterInitInfo,
    mpl_core::types::FreezeDelegate,
    mpl_core::types::PermanentBurnDelegate,
    mpl_core::types::PermanentFreezeDelegate,
    mpl_core::types::PermanentTransferDelegate,
    mpl_core::types::Plugin,
    mpl_core::types::PluginAuthorityPair,
    mpl_core::types::TransferDelegate,
    mpl_core::types::UpdateDelegate,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

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

/// The player's first order.
fn order_1(env: &Env) -> Pubkey {
    order_pda(&env.game, &env.player.pubkey(), 1)
}

fn update() -> GameUpdate {
    GameUpdate { authority: None, paused: None }
}

fn box_entries() -> Vec<DropEntry> {
    vec![item_drop(1, 1), item_drop(2, 1)]
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

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

// Core's errors, as they show in a failed transaction's log.
const CORE_INVALID_AUTHORITY: &str = "custom program error: 0x9";

/// A second collection of the creator's.
fn new_collection(env: &mut Env, plugins: Vec<Plugin>, adapters: Vec<ExternalPluginAdapterInitInfo>) -> Result<Pubkey, String> {
    let creator = env.creator.insecure_clone();
    let collection = Keypair::new();
    let mut pairs: Vec<PluginAuthorityPair> = plugins.into_iter().map(|plugin| PluginAuthorityPair { plugin, authority: None }).collect();
    let game = pda(&[loot::GAME_SEED, collection.pubkey().as_ref()]);
    pairs.push(PluginAuthorityPair { plugin: Plugin::UpdateDelegate(UpdateDelegate { additional_delegates: vec![game] }), authority: None });
    let mut builder = CreateCollectionV2Builder::new();
    builder.collection(collection.pubkey()).update_authority(Some(creator.pubkey())).payer(creator.pubkey()).name("Other".into()).uri("x".into()).plugins(pairs);
    if !adapters.is_empty() {
        builder.external_plugin_adapters(adapters);
    }
    env.send(&[builder.instruction()], &[&creator, &collection])?;
    Ok(collection.pubkey())
}

/// `update_game` always rewrites the treasury to the account passed, whatever the update was for.
#[test]
fn update_game_rewrites_the_treasury_to_whatever_account_is_passed() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let other = env.token_account(Keypair::new().pubkey(), env.mint);
    let ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::UpdateGame { update: GameUpdate { authority: None, paused: Some(false) } }.data(),
        loot::accounts::UpdateGame { owner: owner.pubkey(), game: env.game, treasury: other, system_program: SYSTEM, new_owner: None }.to_account_metas(None),
    );
    env.send(&[ix], &[&owner]).unwrap();
    assert_eq!(env.game_state().treasury, other, "an unpause moved every sale's remainder elsewhere");
    assert!(err(env.pay(PRICE, vec![])).contains("ConstraintAddress"), "clients built with the old treasury now fail");
}

/// Collecting rewards costs the player fee even when nothing is owed, and even with no position.
/// A player who funds a pool pays the project fee.
#[test]
fn collecting_rewards_costs_the_player_fee_and_a_players_deposit_costs_the_project_fee() {
    let mut env = world();
    let admin = env.admin.insecure_clone();
    env.init_platform_fees(&admin, program_data(), Fees { player: loot::PLAYER_FEE_LAMPORTS, project: loot::PROJECT_FEE_LAMPORTS }).unwrap();
    env.create_game().unwrap();
    env.catalog();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    env.open_pool(&owner, 1, gold).unwrap();
    env.open_stake(&owner, 1, gold, 1, gold, 0).unwrap();
    let p = player(&mut env, 1_000);
    env.stake(&p, 1, 100, gold).unwrap();

    let fees = env.fees();
    let u: Unstaked = receipt(&env.unstake(&p, 1, 0, gold).unwrap());
    assert_eq!((u.rewards, env.fees() - fees), (0, loot::PLAYER_FEE_LAMPORTS), "0.002 SOL to collect nothing");

    let s = funded(&mut env);
    let fees = env.fees();
    env.unstake(&s, 1, 0, gold).unwrap();
    assert_eq!(env.fees() - fees, loot::PLAYER_FEE_LAMPORTS, "a wallet with no position pays it too");

    let (fees, sol) = (env.fees(), env.lamports(&p.pubkey()));
    env.deposit(&p, 1, gold, 10).unwrap();
    assert_eq!((env.fees() - fees, sol - env.lamports(&p.pubkey())), (loot::PROJECT_FEE_LAMPORTS, loot::PROJECT_FEE_LAMPORTS + 5_000));
}

/// The platform record is created once, by the program's upgrade authority with the real
/// ProgramData (a look-alike at another address, or a stranger with the real one, is refused);
/// a fee raise applies at exactly its notice and not a second before; a cut inside the notice
/// applies at once and drops the raise; `collect_fees` leaves the record's rent.
#[test]
fn the_platform_is_initialised_once_by_the_upgrade_authority_and_its_fee_notice_holds() {
    let mut env = world();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let fake = Pubkey::new_unique();
    let mut data = vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    data.extend_from_slice(stranger.pubkey().as_ref());
    env.put(fake, bpf_loader_upgradeable::ID, data);
    assert!(err(env.init_platform_as(&stranger, fake, FEE)).contains("ConstraintSeeds"));
    assert!(err(env.init_platform_as(&stranger, program_data(), FEE)).contains("NotPlatform"));
    env.init_platform(FEE).unwrap();
    assert!(env.init_platform(FEE / 2).is_err(), "once");
    let admin = env.admin.insecure_clone();
    assert!(err(env.set_platform_fees(&admin, Fees { player: loot::MAX_FEE_LAMPORTS + 1, project: 0 }, &admin)).contains("FeeAboveCap"));
    env.create_game().unwrap();

    env.set_platform_fees(&admin, Fees { player: 2 * FEE, project: 2 * FEE }, &admin).unwrap();
    let p = env.platform();
    assert_eq!((p.fees.player, p.pending.player, p.pending_at), (FEE, 2 * FEE, env.now() + loot::NOTICE_SECONDS));
    let fees = env.fees();
    env.pay(1, vec![]).unwrap();
    env.wait(loot::NOTICE_SECONDS - 1);
    env.pay(1, vec![]).unwrap();
    assert_eq!(env.fees() - fees, 2 * FEE, "the old fee until the notice has run");
    env.wait(1);
    env.pay(1, vec![]).unwrap();
    assert_eq!(env.fees() - fees, 4 * FEE, "the raise at exactly pending_at");

    // A raise, then a cut inside its notice: the cut applies now and the raise is gone.
    env.set_platform_fees(&admin, Fees { player: 4 * FEE, project: 4 * FEE }, &admin).unwrap();
    env.set_platform_fees(&admin, Fees { player: FEE / 2, project: FEE / 2 }, &admin).unwrap();
    let p = env.platform();
    assert_eq!((p.fees.player, p.pending.player, p.pending_at), (FEE / 2, FEE / 2, 0));
    env.wait(loot::NOTICE_SECONDS);
    let fees = env.fees();
    env.pay(1, vec![]).unwrap();
    assert_eq!(env.fees() - fees, FEE / 2);

    env.collect_fees(&admin, stranger.pubkey()).unwrap();
    assert_eq!((env.fees(), env.lamports(&platform_pda())), (0, env.rent(loot::state::Platform::SPACE)));
    assert!(err(env.collect_fees(&stranger, stranger.pubkey())).contains("NotPlatform"));
}

/// `create_game` takes a collection only from its update authority (an update delegate of the
/// collection is refused), once; a treasury anyone owns is accepted (the owner's choice; it is
/// only ever paid into); a Token-2022 mint with extensions is a fine currency. `update_game`
/// refuses a treasury of another mint. A pool index is free again after `close_pool`, in any
/// mint (the known hazard for the mechanics that name it). A Token-2022 pool holding only
/// withheld fees still closes.
#[test]
fn create_game_update_game_and_pools_refuse_what_they_should() {
    // A collection whose update authority is someone else, with the signer as a delegate.
    let mut env = world();
    env.init_platform(FEE).unwrap();
    let creator = env.creator.insecure_clone();
    let other = Keypair::new();
    let collection = Keypair::new();
    let game = pda(&[loot::GAME_SEED, collection.pubkey().as_ref()]);
    let ix = CreateCollectionV2Builder::new()
        .collection(collection.pubkey())
        .update_authority(Some(other.pubkey()))
        .payer(creator.pubkey())
        .name("Delegated".into())
        .uri("x".into())
        .plugins(vec![PluginAuthorityPair {
            plugin: Plugin::UpdateDelegate(UpdateDelegate { additional_delegates: vec![creator.pubkey(), game] }),
            authority: None,
        }])
        .instruction();
    env.send(&[ix], &[&creator, &collection]).unwrap();
    env.collection = collection.pubkey();
    env.game = game;
    assert!(err(env.create_game()).contains("BadCollection"));

    // The same collection twice.
    let mut env = setup();
    assert!(env.create_game().is_err());

    // A treasury a stranger owns: accepted, and noted.
    let mut env = world();
    env.init_platform(FEE).unwrap();
    let stranger = Keypair::new().pubkey();
    let mint = env.mint;
    env.treasury = env.token_account(stranger, mint);
    env.create_game().unwrap();
    assert_eq!(env.game_state().treasury, env.treasury);
    // `update_game` with a treasury of another mint.
    let gems = env.new_mint(env.creator.pubkey());
    let creator = env.creator.insecure_clone();
    let wrong = env.token_account(creator.pubkey(), gems);
    let ix = Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::UpdateGame { update: GameUpdate { authority: None, paused: None } }.data(),
        loot::accounts::UpdateGame { owner: creator.pubkey(), game: env.game, treasury: wrong, system_program: SYSTEM, new_owner: None }.to_account_metas(None),
    );
    assert!(err(env.send(&[ix], &[&creator])).contains("ConstraintTokenMint"));

    // A Token-2022 currency with a transfer fee.
    let mut env = world();
    env.init_platform(FEE).unwrap();
    env.mint = env.new_mint_2022(Some(100), None);
    let (creator, mint) = (env.creator.insecure_clone(), env.mint);
    env.treasury = env.token_account(creator.pubkey(), mint);
    env.create_game().unwrap();
    assert_eq!(env.game_state().mint, mint);

    // Pools: an index reused in another mint, and a close with only withheld fees left.
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    let gems = env.new_mint(owner.pubkey());
    env.open_pool(&owner, 5, gold).unwrap();
    env.close_pool(&owner, 5).unwrap();
    env.open_pool(&owner, 5, gems).unwrap();
    assert_eq!(env.mint_of(&pool_pda(&env.game, 5)), gems);
    let coin = env.new_mint_2022(Some(100), None);
    env.open_pool(&owner, 6, coin).unwrap();
    env.fund(owner.pubkey(), coin, 1_000);
    env.deposit(&owner, 6, coin, 1_000).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 6)), 990);
    assert!(err(env.close_pool(&owner, 6)).contains("PoolNotEmpty"));
    env.payout(&authority, 6, ata(&owner.pubkey(), &coin), 990).unwrap();
    assert_eq!(env.tokens(&pool_pda(&env.game, 6)), 0);
    env.close_pool(&owner, 6).unwrap();
    assert!(!env.exists(&pool_pda(&env.game, 6)), "harvested the 10 withheld, then closed");
}

/// Every charged instruction of every game wrote the one platform
/// record, so the whole program shared one write lane (about 200 charged transactions a block)
/// and one game's traffic could price out every other. Now each fee goes into the game's own
/// fee box, the platform record is only read, and a purchase only reads the game record. The
/// admin collects from each box; another game's box is refused in place of this one's.
#[test]
fn no_charged_instruction_writes_an_account_every_game_shares() {
    let mut env = setup();
    let keeper = env.cranker.insecure_clone();
    let p = env.player.pubkey();
    let writes = |ix: &anchor_lang::solana_program::instruction::Instruction, key: &Pubkey| {
        ix.accounts.iter().any(|m| m.pubkey == *key && m.is_writable)
    };
    for ix in [env.buy_ix(3, 1), env.open_box_ix(1, 2), env.pay_ix(p, env.mint, 10, vec![])] {
        assert!(!writes(&ix, &platform_pda()), "the platform record is only read");
        assert!(!writes(&ix, &env.game), "the game record is only read");
    }
    assert!(writes(&env.pay_ix(p, env.mint, 10, vec![]), &fees_pda(&env.game)));

    // The fee lands in the game's box, whatever pays it.
    let platform = env.lamports(&platform_pda());
    env.buy(3, 1).unwrap();
    env.settle(order_pda(&env.game, &p, 1), &keeper).unwrap();
    assert_eq!((env.fees(), env.lamports(&platform_pda())), (FEE, platform));

    // Another game's box in place of this one's is refused.
    let mut ix = env.pay_ix(p, env.mint, 10, vec![]);
    let at = ix.accounts.iter().position(|m| m.pubkey == fees_pda(&env.game)).unwrap();
    ix.accounts[at].pubkey = fees_pda(&Pubkey::new_unique());
    let player = env.player.insecure_clone();
    assert!(err(env.send(&[ix], &[&player])).contains("ConstraintSeeds"));

    // The admin takes them out; the box keeps its rent.
    let (admin, bank) = (env.admin.insecure_clone(), Pubkey::new_unique());
    env.collect_fees(&admin, bank).unwrap();
    assert_eq!((env.lamports(&bank), env.fees(), env.lamports(&fees_pda(&env.game))), (FEE, 0, env.rent(0)));
}

/// A game with a collection that can move or freeze every asset in it cannot open here: a
/// player's collectible would not be theirs, and one the game holds might never come back.
#[test]
fn a_collection_that_can_seize_its_assets_cannot_open_a_game() {
    use anchor_lang::{InstructionData, ToAccountMetas};
    use mpl_core::types::{PermanentBurnDelegate, PermanentFreezeDelegate, PermanentTransferDelegate, Creator, Plugin, PluginAuthorityPair, Royalties, RuleSet};
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let mut open_with = |plugins: Vec<Plugin>| {
        let collection = Keypair::new();
        let create = mpl_core::instructions::CreateCollectionV2Builder::new()
            .collection(collection.pubkey())
            .update_authority(Some(owner.pubkey()))
            .payer(owner.pubkey())
            .name("Other".into())
            .uri("https://example.invalid/other.json".into())
            .plugins(plugins.into_iter().map(|plugin| PluginAuthorityPair { plugin, authority: None }).collect())
            .instruction();
        env.send(&[create], &[&owner, &collection]).unwrap();
        let game = pda(&[loot::GAME_SEED, collection.pubkey().as_ref()]);
        env.ix(
            loot::instruction::CreateGame { authority: owner.pubkey() }.data(),
            loot::accounts::CreateGame { owner: owner.pubkey(), game, fees: fees_pda(&game), collection: collection.pubkey(), mint: env.mint, treasury: env.treasury, system_program: SYSTEM }
                .to_account_metas(None),
            &[&owner],
        )
    };
    assert!(err(open_with(vec![Plugin::PermanentTransferDelegate(PermanentTransferDelegate {})])).contains("CollectionCanSeize"));
    assert!(err(open_with(vec![Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: false })])).contains("CollectionCanSeize"));
    assert!(err(open_with(vec![Plugin::PermanentBurnDelegate(PermanentBurnDelegate {})])).contains("CollectionCanSeize"));
    // No plugin at all, and a plain royalty, are fine.
    open_with(vec![]).unwrap();
    open_with(vec![Plugin::Royalties(Royalties { basis_points: 500, creators: vec![Creator { address: owner.pubkey(), percentage: 100 }], rule_set: RuleSet::None })]).unwrap();
}

#[test]
fn the_owner_rotates_the_authority() {
    let mut env = game_with_pools();
    let owner = env.creator.insecure_clone();
    let old = env.authority.insecure_clone();
    let new = funded(&mut env);
    let to = ata(&env.player.pubkey(), &env.mint);
    env.pay(PRICE, vec![pool(PRIZE, 10_000)]).unwrap();

    // Only the owner changes it: the authority cannot hand itself on.
    let update = |key| GameUpdate { authority: Some(key), paused: None };
    assert!(err(env.update_game(&old, update(new.pubkey()))).contains("NotOwner"));
    env.update_game(&owner, update(new.pubkey())).unwrap();

    assert!(err(env.payout(&old, PRIZE, to, 1)).contains("NotAuthority"));
    env.payout(&new, PRIZE, to, 1).unwrap();
}

#[test]
fn a_fee_raise_waits_seven_days_and_a_cut_applies_at_once() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let stranger = funded(&mut env);
    let paid = |env: &Env| env.fees();

    assert!(err(env.set_platform(&stranger, 0, &stranger)).contains("NotPlatform"));
    assert!(err(env.set_fee(loot::MAX_FEE_LAMPORTS + 1)).contains("FeeAboveCap"));

    // A raise is only announced.
    env.set_fee(3 * FEE).unwrap();
    let p = env.platform();
    assert_eq!((p.fees.player, p.pending.player, p.pending_at), (FEE, 3 * FEE, env.now() + loot::NOTICE_SECONDS));
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(paid(&env), FEE);

    // One second before the notice has run, still the old fee. Then the new one.
    env.wait(loot::NOTICE_SECONDS - 1);
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(paid(&env), 2 * FEE);
    env.wait(1);
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(paid(&env), 5 * FEE);

    // A cut applies now, and drops a raise that was waiting.
    env.set_fee(loot::MAX_FEE_LAMPORTS).unwrap();
    env.set_fee(FEE).unwrap();
    let p = env.platform();
    assert_eq!((p.fees.player, p.pending_at), (FEE, 0));
    env.wait(2 * loot::NOTICE_SECONDS);
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(paid(&env), 6 * FEE);

    // Free is allowed.
    env.set_fee(0).unwrap();
    env.pay(PRICE, vec![]).unwrap();
    assert_eq!(paid(&env), 6 * FEE);

    // Only the admin takes the fees out, all of them, and the record keeps its rent.
    let bank = Keypair::new().pubkey();
    assert!(err(env.collect_fees(&stranger, stranger.pubkey())).contains("NotPlatform"));
    env.collect_fees(&admin, bank).unwrap();
    assert_eq!((env.lamports(&bank), paid(&env)), (6 * FEE, 0));
    // The admin hands the platform on.
    // The next admin signs the handover: a key that does not sign is refused.
    let mut metas = loot::accounts::SetPlatform { admin: admin.pubkey(), platform: platform_pda(), next_admin: stranger.pubkey() }
        .to_account_metas(None);
    metas.last_mut().unwrap().is_signer = false;
    let data = loot::instruction::SetPlatform { fees: env.platform().fees }.data();
    assert!(err(env.ix(data, metas, &[&admin])).contains("AccountNotSigner"));
    env.set_platform(&admin, 0, &stranger).unwrap();
    assert_eq!(env.platform().admin, stranger.pubkey());
    assert!(err(env.collect_fees(&admin, bank)).contains("NotPlatform"));
}

#[test]
fn only_the_upgrade_authority_creates_the_platform() {
    let mut env = world();
    let stranger = funded(&mut env);
    assert!(err(env.init_platform_as(&stranger, program_data(), FEE)).contains("NotPlatform"));
    // Another program's ProgramData, where the stranger is the upgrade authority, is not ours.
    let theirs = Keypair::new().pubkey();
    let mut data = env.data(&program_data());
    data[13..45].copy_from_slice(stranger.pubkey().as_ref());
    env.put(theirs, anchor_lang::solana_program::bpf_loader_upgradeable::ID, data);
    assert!(err(env.init_platform_as(&stranger, theirs, FEE)).contains("ConstraintSeeds"));

    assert!(err(env.init_platform(loot::MAX_FEE_LAMPORTS + 1)).contains("FeeAboveCap"));
    env.init_platform(FEE).unwrap();
    assert!(env.init_platform(FEE).is_err(), "once");
    assert_eq!(env.data(&platform_pda()).len(), loot::state::Platform::SPACE);
}

#[test]
fn the_switches_stop_money_in_and_never_what_is_owed() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let admin = env.admin.insecure_clone();
    let keeper = env.cranker.insecure_clone();
    let stranger = funded(&mut env);
    let (rolled, pending) = (order_1(&env), order_pda(&env.game, &env.player.pubkey(), 2));
    env.open_box(1, 1).unwrap();
    env.open_box(1, 2).unwrap();

    assert!(err(env.set_suspended(&stranger, true)).contains("NotPlatform"));
    assert!(err(env.set_suspended(&owner, true)).contains("NotPlatform"));
    env.set_suspended(&admin, true).unwrap();
    assert!(err(env.open_box(1, 3)).contains("Suspended"));
    assert!(err(env.buy(3, 3)).contains("Suspended"));
    assert!(err(env.pay(PRICE, vec![])).contains("Suspended"));

    // The owner cannot lift the platform's switch, and has their own.
    env.update_game(&owner, GameUpdate { paused: Some(true), ..update() }).unwrap();
    env.set_suspended(&admin, false).unwrap();
    assert!(err(env.open_box(1, 3)).contains("Paused"));
    assert!(err(env.buy(3, 3)).contains("Paused"));
    env.set_suspended(&admin, true).unwrap();

    // Both switches on: the roll, the settle and the refund of paid orders all go through.
    env.callback(rolled, rnd(0)).unwrap();
    env.settle(rolled, &keeper).unwrap();
    env.wait_slots(loot::STALE_SLOTS + 1);
    env.refund(pending).unwrap();
}

#[test]
fn only_the_owner_edits_the_catalog() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let authority = env.authority.insecure_clone();
    let admin = funded(&mut env);
    let crown = || item(ItemKind::Collectible, "Gecko Crown", 2, 0);

    assert!(err(env.upsert_item_as(&admin, 1, crown())).contains("NotOwner"));
    assert!(err(env.upsert_item_as(&authority, 1, crown())).contains("NotOwner"), "the authority pays out; it does not edit");
    env.upsert_item_as(&owner, 1, crown()).unwrap();

    // What an entry may hold.
    assert!(err(env.upsert_item(1, ItemArgs { name: "n".repeat(33), ..crown() })).contains("StringTooLong"));
    assert!(err(env.upsert_item(1, ItemArgs { uri: "u".repeat(201), ..crown() })).contains("StringTooLong"));
    assert!(err(env.upsert_item(1, ItemArgs { shares: vec![burn(10_001)], ..crown() })).contains("BadShares"));
    assert!(err(env.upsert_box(1, PRICE, vec![burn(1); 5], box_entries())).contains("BadShares"));
    assert!(err(env.upsert_box(1, PRICE, vec![], vec![])).contains("BadEntries"));
    assert!(err(env.upsert_box(1, PRICE, vec![], vec![item_drop(1, 0)])).contains("BadEntries"));
    assert!(err(env.upsert_box(1, PRICE, vec![], vec![item_drop(1, 1); 9])).contains("BadEntries"));

    // Once one is out, what the item is cannot change under its holders.
    env.make(&authority, 1, admin.pubkey()).unwrap();
    assert!(err(env.upsert_item(1, ItemArgs { kind: ItemKind::Normal, ..crown() })).contains("KindLocked"));
    assert!(err(env.upsert_item(1, ItemArgs { soulbound: true, ..crown() })).contains("KindLocked"));
    assert!(err(env.upsert_item(1, ItemArgs { burnable: true, ..crown() })).contains("KindLocked"));
    env.make(&authority, 1, admin.pubkey()).unwrap();
    assert!(err(env.upsert_item(1, ItemArgs { max_supply: 1, ..crown() })).contains("SupplyBelowIssued"));
    // The count survives an edit.
    env.upsert_item(1, ItemArgs { price: 9, max_supply: 0, ..crown() }).unwrap();
    assert_eq!((env.item_state(1).issued, env.item_state(1).price), (2, 9));
}

/// Catalog accounts are exactly as big as what they hold, and an edit settles the rent.
#[test]
fn an_edit_resizes_the_account_and_settles_the_rent() {
    let mut env = setup();
    let owner = env.creator.pubkey();
    let (item_key, box_key) = (item_pda(&env.game, 1), box_pda(&env.game, 1));
    let short = item(ItemKind::Collectible, "A", 0, 0);
    let long = ItemArgs { name: "N".repeat(32), uri: "u".repeat(200), shares: vec![pool(0, 1); 4], ..short.clone() };

    for args in [long.clone(), short.clone(), long, short] {
        let before = env.lamports(&owner) + env.lamports(&item_key);
        env.upsert_item(1, args).unwrap();
        let len = env.data(&item_key).len();
        assert_eq!(env.lamports(&item_key), env.rent(len), "exactly rent-exempt at {len} bytes");
        assert_eq!(before - env.lamports(&owner) - env.lamports(&item_key), 5_000, "only the network fee is gone");
        // 63 fixed bytes, a byte each for no rise, no fall and no life, then the shares, the name
        // and the URI, each behind a 4-byte length.
        let it = env.item_state(1);
        let shares: usize = it.shares.iter().map(|s| if s.to == loot::state::To::Burn { 3 } else { 4 }).sum();
        assert_eq!(len, 63 + 3 + 4 + shares + 4 + it.name.len() + 4 + it.uri.len());
    }
    for n in [8usize, 1, 5] {
        env.upsert_box(1, PRICE, vec![], vec![item_drop(1, 1); n]).unwrap();
        assert_eq!(env.data(&box_key).len(), 59 + 4 + 4 + 4 + 9 * n, "a byte each for no currency, no rise, no fall and no stock odds");
        assert_eq!(env.lamports(&box_key), env.rent(env.data(&box_key).len()));
    }
}

#[test]
fn only_the_owner_changes_the_game_and_can_hand_it_on() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let authority = env.authority.insecure_clone();
    let next = funded(&mut env);
    assert_eq!(env.data(&env.game).len(), 166);

    assert!(err(env.update_game(&authority, update())).contains("NotOwner"));
    assert!(err(env.hand_over_game(&next, &next)).contains("NotOwner"));

    // The next owner signs the handover: a key that does not sign is refused.
    let mut metas = loot::accounts::UpdateGame {
        owner: owner.pubkey(),
        game: env.game,
        treasury: env.treasury,
        system_program: SYSTEM,
        new_owner: Some(next.pubkey()),
    }
    .to_account_metas(None);
    metas.last_mut().unwrap().is_signer = false;
    let data = loot::instruction::UpdateGame { update: update() }.data();
    assert!(err(env.ix(data, metas, &[&owner])).contains("AccountNotSigner"));

    env.hand_over_game(&owner, &next).unwrap();
    assert!(err(env.update_game(&owner, update())).contains("NotOwner"));
    env.update_game(&next, GameUpdate { paused: Some(true), ..update() }).unwrap();
    let g = env.game_state();
    assert_eq!((g.owner, g.authority, g.paused), (next.pubkey(), authority.pubkey(), true));
}

#[test]
fn a_game_needs_a_collection_its_creator_controls() {
    let mut env = world();
    env.init_platform(FEE).unwrap();
    // Someone who does not control the collection cannot open its game.
    let stranger = funded(&mut env);
    let real = std::mem::replace(&mut env.creator, stranger);
    assert!(err(env.create_game()).contains("BadCollection"));
    env.creator = real;
    // Nor can a game be opened for something that is not a Core collection.
    let (collection, game) = (env.collection, env.game);
    env.collection = env.mint;
    env.game = pda(&[loot::GAME_SEED, env.mint.as_ref()]);
    assert!(err(env.create_game()).contains("BadCollection"));
    (env.collection, env.game) = (collection, game);

    env.create_game().unwrap();
    let g = env.game_state();
    assert_eq!((g.owner, g.authority), (env.creator.pubkey(), env.authority.pubkey()));
    assert!(env.create_game().is_err(), "one game per collection");
}

/// A game or a platform record is taken by its owner and its tag, not by its address: only
/// `create_game` and `init_platform` write one, each at its own address. A copy with the right
/// tag that another program owns (here one naming the forger as authority, and one with no fee)
/// is refused.
#[test]
fn a_forged_game_or_platform_with_the_right_tag_is_refused() {
    let mut env = setup();
    let forger = funded(&mut env);
    let other_program = Pubkey::new_unique();

    let mut game = env.data(&env.game);
    game[33..65].copy_from_slice(forger.pubkey().as_ref()); // the authority
    let fake_game = Pubkey::new_unique();
    env.put(fake_game, other_program, game);
    let mut ix = env.payout_ix(forger.pubkey(), 0, ata(&forger.pubkey(), &env.mint), 1);
    ix.accounts[1].pubkey = fake_game;
    assert!(err(env.send(&[ix], &[&forger])).contains("AccountOwnedByWrongProgram"));

    let mut platform = env.data(&platform_pda());
    platform[65..81].fill(0); // both fees
    let fake_platform = Pubkey::new_unique();
    env.put(fake_platform, other_program, platform);
    let mut ix = env.pay_ix(env.player.pubkey(), env.mint, PRICE, vec![]);
    let at = ix.accounts.iter().position(|m| m.pubkey == platform_pda()).unwrap();
    ix.accounts[at].pubkey = fake_platform;
    let p = env.player.insecure_clone();
    assert!(err(env.send(&[ix], &[&p])).contains("AccountOwnedByWrongProgram"));
}

/// Every receipt used to pay its fee to a wallet the platform could
/// change at once; pointing it at an address no transaction can write stopped `payout` and
/// `settle`. Fees now collect in the platform record, which this program owns: there is no
/// wallet to repoint, and nothing the platform admin can sign stops what is owed.
#[test]
fn nothing_the_platform_signs_stops_a_payout_or_a_settle() {
    let mut env = setup();
    let (owner, authority, admin, keeper) =
        (env.creator.insecure_clone(), env.authority.insecure_clone(), env.admin.insecure_clone(), env.cranker.insecure_clone());
    env.open_pool(&owner, PRIZE, env.mint).unwrap();
    env.pay(10 * PRICE, vec![pool(PRIZE, 10_000)]).unwrap();
    env.buy(3, 1).unwrap();
    let order = order_1(&env);
    let to = ata(&env.player.pubkey(), &env.mint);

    // Everything the admin can do: the highest fee, the game suspended, the fees taken out
    // (to the program's own address, which can never be written), the platform handed away.
    env.set_fee(loot::MAX_FEE_LAMPORTS).unwrap();
    env.wait(loot::NOTICE_SECONDS + 1);
    env.set_suspended(&admin, true).unwrap();
    assert!(env.collect_fees(&admin, loot::ID).is_err());
    env.collect_fees(&admin, admin.pubkey()).unwrap();
    env.set_platform(&admin, loot::MAX_FEE_LAMPORTS, &Keypair::new()).unwrap();

    env.payout(&authority, PRIZE, to, 10 * PRICE).unwrap();
    env.settle(order, &keeper).unwrap();
    assert_eq!(env.fees(), loot::MAX_FEE_LAMPORTS + FEE, "the payout at today's fee, the order at its own");
}

/// SOL parked at a catalog address before its first write does not block the write (a plain
/// `create_account` would fail), and the account ends exactly as big as what it holds.
#[test]
fn a_prefunded_catalog_address_is_still_created() {
    let mut env = setup();
    let (item_9, box_9) = (item_pda(&env.game, 9), box_pda(&env.game, 9));
    env.svm.airdrop(&item_9, 1).unwrap();
    env.svm.airdrop(&box_9, 50_000_000).unwrap();
    env.upsert_item(9, item(ItemKind::Normal, "Parked", 0, PRICE)).unwrap();
    env.upsert_box(9, PRICE, vec![], vec![item_drop(9, 1)]).unwrap();
    assert_eq!(env.item_state(9).name, "Parked");
    assert_eq!(env.lamports(&item_9), env.rent(env.data(&item_9).len()));
    assert!(env.lamports(&box_9) >= 50_000_000);

    // An asset key that is already an asset cannot be made again.
    let authority = env.authority.insecure_clone();
    let made = env.make(&authority, 1, authority.pubkey()).unwrap();
    let ix = Instruction::new_with_bytes(
        loot::ID,
        &anchor_lang::InstructionData::data(&loot::instruction::Make { reference: REF }),
        anchor_lang::ToAccountMetas::to_account_metas(
            &loot::accounts::Make {
                authority: authority.pubkey(),
                game: env.game,
                item: item_pda(&env.game, 1),
                collection: env.collection,
                asset: made,
                owner: authority.pubkey(),
                mpl_core_program: mpl_core::ID,
                fee: env.fee(),
            },
            None,
        ),
    );
    assert!(env.send_unsigned(&[ix], &authority).is_err());
    assert_eq!(env.item_state(1).issued, 1);
}

/// HIGH/MEDIUM, fixed. Converters, schedules, lotteries, recipes and boxes move pools and mint
/// with no authority, and any admin could write one: an admin emptied a pool and minted a
/// token the game controls, each in two transactions. Everything that can move a pool or mint
/// became the owner's alone, and then admins were dropped altogether: a game has two keys, its
/// owner and its authority.
#[test]
fn only_the_owner_writes_a_mechanic() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let admin = Keypair::new();
    env.svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    env.open_pool(&owner, 0, env.mint).unwrap();
    let junk = env.new_mint(owner.pubkey());

    // What was a converter is a recipe of tokens now.
    let drain = exchange(junk, 1, env.mint, 5_000, Origin::Pool(0));
    assert!(err(env.upsert_recipe(&admin, 8, drain)).contains("NotOwner"));
    let burn_all = ScheduleArgs { active: true, action: Action::Burn { pool: 0, bps: 10_000 }, every: 1, next_at: 0, max_runs: 0 };
    assert!(err(env.upsert_schedule(&admin, 9, burn_all)).contains("NotOwner"));
    let pot = LotteryArgs { price: 1, pot: 0, cut_bps: 0, places: vec![], ticket_mint: Pubkey::default(), every: 1, draws_at: 0 };
    assert!(err(env.upsert_lottery(&admin, 9, pot)).contains("NotOwner"));
    let recipe = merge_recipe(1, 1, 3);
    assert!(err(env.upsert_recipe(&admin, 9, recipe)).contains("NotOwner"));
    let c = std::mem::replace(&mut env.creator, admin.insecure_clone());
    assert!(err(env.upsert_box(9, PRICE, vec![], vec![pay_drop(0, 5_000, 1)])).contains("NotOwner"));
    // Nor an item.
    assert!(err(env.upsert_item(30, item(ItemKind::Collectible, "Admin's Hat", 0, 0))).contains("NotOwner"));
    env.creator = c;
}

/// MEDIUM, closed. Admins edited items, shares included, and `To::Account` let an admin point
/// an item's whole revenue at an account of their own. A game has no admins any more: only
/// its owner writes an item.
#[test]
fn only_the_owner_writes_where_an_items_revenue_goes() {
    let mut env = setup();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    let admin = player(&mut env, 0);
    env.upsert_item(50, collectible("Plot")).unwrap();

    let crop = |to| ItemArgs { shares: vec![Share { to, bps: 10_000 }], ..item(ItemKind::Collectible, "Crop", 0, 1_000) };
    let admins = ata(&admin.pubkey(), &gold);
    env.upsert_item_as(&owner, 51, crop(To::Burn)).unwrap();
    for to in [To::Account(admins), To::Holder(admins), To::Pool(0)] {
        assert!(err(env.upsert_item_as(&admin, 51, crop(to))).contains("NotOwner"));
    }
    env.upsert_item_as(&owner, 51, crop(To::Account(admins))).unwrap();
}

/// `create_game` refuses a collection born with a permanent freeze, transfer or burn delegate,
/// and Core refuses to create a collection with an owner's delegate.
#[test]
fn create_game_refuses_a_collection_born_able_to_seize() {
    let permanent = [
        Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: false }),
        Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}),
        Plugin::PermanentBurnDelegate(PermanentBurnDelegate {}),
    ];
    for plugin in permanent {
        let mut env = world();
        env.init_platform(FEE).unwrap();
        env.collection = new_collection(&mut env, vec![plugin], vec![]).unwrap();
        env.game = pda(&[loot::GAME_SEED, env.collection.as_ref()]);
        assert!(err(env.create_game()).contains("CollectionCanSeize"));
    }
    let mut env = world();
    for plugin in [Plugin::FreezeDelegate(FreezeDelegate { frozen: true }), Plugin::TransferDelegate(TransferDelegate {}), Plugin::BurnDelegate(BurnDelegate {})] {
        assert!(err(new_collection(&mut env, vec![plugin], vec![])).contains(CORE_INVALID_AUTHORITY));
    }
}

/// MEDIUM, closed. An admin could edit the real item: put one the owner never sold on sale
/// for 1 and feed it to the owner's recipe, or point an item's revenue at the pool their own
/// stake draws from. First an admin was left only how an item looks; then the creator dropped
/// admins altogether (2026-10-11). Only a game's owner writes an item.
#[test]
fn only_the_owner_writes_an_item() {
    let mut env = setup();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let stranger = player(&mut env, 10);
    let fish = collectible("Fish");
    env.upsert_item(30, fish.clone()).unwrap();
    for who in [&stranger, &authority] {
        assert!(err(env.upsert_item_as(who, 30, ItemArgs { price: 1, ..fish.clone() })).contains("NotOwner"));
        assert!(err(env.upsert_item_as(who, 30, ItemArgs { rarity: 7, ..fish.clone() })).contains("NotOwner"));
        assert!(err(env.upsert_item_as(who, 31, fish.clone())).contains("NotOwner"));
    }
    env.upsert_item_as(&owner, 30, ItemArgs { price: 1, ..fish }).unwrap();
}

/// A raise of either fee never applies before its notice: a raise of one with a cut of the
/// other waits whole; repeating a raise restarts the wait; cancelling it and raising again
/// starts a new one. Each time, what a payment is really charged is the old fee until the day.
#[test]
fn a_fee_raise_never_applies_early() {
    let mut env = world();
    let admin = env.admin.insecure_clone();
    let f = |player, project| Fees { player, project };
    let start = f(2_000_000, 10_000);
    env.init_platform_fees(&admin, program_data(), start).unwrap();
    assert!(err(env.init_platform_fees(&admin, program_data(), start)).len() > 0);
    env.create_game().unwrap();
    env.catalog();
    let owner = env.creator.insecure_clone();
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();
    let charged = |env: &mut Env| {
        let before = env.fees();
        env.pay(10, vec![pool(0, 10_000)]).unwrap();
        env.fees() - before
    };

    // A raise of the player fee with a cut of the project fee: neither applies now.
    env.set_platform_fees(&admin, f(3_000_000, 5_000), &admin).unwrap();
    assert_eq!(charged(&mut env), 2_000_000);
    env.wait(loot::NOTICE_SECONDS - 10);
    assert_eq!(charged(&mut env), 2_000_000);
    // Setting the same raise again restarts the wait.
    env.set_platform_fees(&admin, f(3_000_000, 5_000), &admin).unwrap();
    env.wait(20);
    assert_eq!(charged(&mut env), 2_000_000);
    // Cancelling (setting the fees in force) and raising again starts over.
    env.set_platform_fees(&admin, start, &admin).unwrap();
    env.set_platform_fees(&admin, f(3_000_000, 5_000), &admin).unwrap();
    env.wait(loot::NOTICE_SECONDS - 1);
    assert_eq!(charged(&mut env), 2_000_000);
    env.wait(1);
    assert_eq!(charged(&mut env), 3_000_000);
    // Each fee is capped on its own.
    assert!(err(env.set_platform_fees(&admin, f(0, loot::MAX_FEE_LAMPORTS + 1), &admin)).contains("FeeAboveCap"));
    assert_eq!(env.svm.get_account(&platform_pda()).unwrap().data.len(), loot::state::Platform::SPACE);
    let _ = DAY;
}

/// A player pays 0.002 SOL when they sign for something of their own; anything else that is
/// charged costs 0.00001 SOL. An airdrop to 10,000 players costs the project 0.1 SOL in fees.
#[test]
fn players_pay_the_player_fee_and_projects_the_project_fee() {
    let mut env = world();
    let admin = env.admin.insecure_clone();
    let fees = Fees { player: loot::PLAYER_FEE_LAMPORTS, project: loot::PROJECT_FEE_LAMPORTS };
    assert_eq!(fees, Fees { player: 2_000_000, project: 10_000 });
    env.init_platform_fees(&admin, program_data(), fees).unwrap();
    env.create_game().unwrap();
    env.catalog();
    let (owner, authority) = (env.creator.insecure_clone(), env.authority.insecure_clone());
    let gold = env.mint;
    env.open_pool(&owner, 0, gold).unwrap();

    let charged = |env: &mut Env, run: &mut dyn FnMut(&mut Env)| {
        let before = env.fees();
        run(env);
        env.fees() - before
    };
    // The player's own: a payment, a purchase (paid at settle, from the order's escrow).
    assert_eq!(charged(&mut env, &mut |env| { env.pay(PRICE, vec![pool(0, 10_000)]).unwrap(); }), 2_000_000);
    env.buy(3, 1).unwrap();
    let order = order_pda(&env.game, &env.player.pubkey(), 1);
    assert_eq!(env.acc::<Order>(&order).fee, 2_000_000);
    // The project's: a deposit, a payout, an issue of tokens.
    env.fund(owner.pubkey(), gold, PRICE);
    assert_eq!(charged(&mut env, &mut |env| { env.deposit(&owner, 0, gold, PRICE).unwrap(); }), 10_000);
    let to = ata(&env.player.pubkey(), &gold);
    assert_eq!(charged(&mut env, &mut |env| { env.payout(&authority, 0, to, PRICE).unwrap(); }), 10_000);

    // Fees that raise either one wait out the notice, together; fees that raise neither apply now.
    let p = |player, project| Fees { player, project };
    env.set_platform_fees(&admin, p(1_000_000, 20_000), &admin).unwrap();
    assert_eq!((env.platform().fees, env.platform().pending, env.platform().pending_at > 0), (fees, p(1_000_000, 20_000), true));
    env.set_platform_fees(&admin, p(1_000_000, 5_000), &admin).unwrap();
    assert_eq!((env.platform().fees, env.platform().pending_at), (p(1_000_000, 5_000), 0));
    env.wait(loot::NOTICE_SECONDS + DAY);
    assert_eq!(env.platform().fees(env.now()), p(1_000_000, 5_000), "the raise that was waiting was dropped");
    assert!(err(env.set_platform_fees(&admin, p(loot::MAX_FEE_LAMPORTS + 1, 0), &admin)).contains("FeeAboveCap"));
}
