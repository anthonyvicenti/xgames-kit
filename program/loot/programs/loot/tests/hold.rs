//! Holds: a collectible handed to the game for a time, `award` and `take_back`.
mod common;

use {
    anchor_lang::InstructionData,
    anchor_lang::Space,
    anchor_lang::ToAccountMetas,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_lang::solana_program::instruction::Instruction,
    common::*,
    loot::GameUpdate,
    loot::ItemArgs,
    loot::state::ItemKind,
    mpl_core::AuthorityType,
    mpl_core::instructions::*,
    mpl_core::types::BurnDelegate,
    mpl_core::types::Creator,
    mpl_core::types::ExternalCheckResult,
    mpl_core::types::ExternalPluginAdapterInitInfo,
    mpl_core::types::FreezeDelegate,
    mpl_core::types::HookableLifecycleEvent,
    mpl_core::types::LifecycleHookInitInfo,
    mpl_core::types::OracleInitInfo,
    mpl_core::types::PermanentBurnDelegate,
    mpl_core::types::PermanentFreezeDelegate,
    mpl_core::types::PermanentTransferDelegate,
    mpl_core::types::Plugin,
    mpl_core::types::PluginAuthority,
    mpl_core::types::PluginAuthorityPair,
    mpl_core::types::PluginType,
    mpl_core::types::Royalties,
    mpl_core::types::RuleSet,
    mpl_core::types::TransferDelegate,
    mpl_core::types::UpdateAuthority,
    mpl_core::types::UpdateDelegate,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn holder(env: &Env, asset: &Pubkey) -> Pubkey {
    mpl_core::Asset::from_bytes(&env.data(asset)).unwrap().base.owner
}

fn three(t: AuthorityType, a: Option<Pubkey>) -> [(AuthorityType, Option<Pubkey>); 3] {
    [(t.clone(), a), (t.clone(), a), (t, a)]
}

fn core_transfer_in(env: &mut Env, who: &Keypair, asset: Pubkey, collection: Pubkey, to: Pubkey) -> Result<Vec<String>, String> {
    let ix = TransferV1Builder::new().asset(asset).collection(Some(collection)).payer(who.pubkey()).authority(Some(who.pubkey())).new_owner(to).instruction();
    env.send(&[ix], &[who])
}

const CORE_NO_APPROVALS: &str = "custom program error: 0x1a";

fn collectible(name: &str) -> ItemArgs {
    item(ItemKind::Collectible, name, 0, 0)
}

fn core_burn_in(env: &mut Env, who: &Keypair, asset: Pubkey, collection: Pubkey) -> Result<Vec<String>, String> {
    let ix = BurnV1Builder::new().asset(asset).collection(Some(collection)).payer(who.pubkey()).authority(Some(who.pubkey())).instruction();
    env.send(&[ix], &[who])
}

// Core's errors, as they show in a failed transaction's log.
const CORE_INVALID_AUTHORITY: &str = "custom program error: 0x9";

/// `take_back` takes the same accounts as `award` but `to` (it is always the player) and the fee.
fn take_back_ix(m: &loot::accounts::Release) -> Instruction {
    let accounts = loot::accounts::TakeBack {
        signer: m.signer,
        game: m.game,
        hold: m.hold,
        asset: m.asset,
        player: m.player,
        collection: m.collection,
        mpl_core_program: m.mpl_core_program,
        system_program: SYSTEM,
    };
    Instruction::new_with_bytes(loot::ID, &loot::instruction::TakeBack {}.data(), accounts.to_account_metas(None))
}

fn award_ix(m: &loot::accounts::Release) -> Instruction {
    Instruction::new_with_bytes(loot::ID, &loot::instruction::Award { reference: REF }.data(), m.to_account_metas(None))
}

fn release(env: &Env, signer: Pubkey, asset: Pubkey, to: Pubkey) -> loot::accounts::Release {
    let hold: loot::Hold = env.acc(&env.hold_pda(&asset));
    loot::accounts::Release {
        signer,
        game: env.game,
        hold: env.hold_pda(&asset),
        asset,
        player: hold.player,
        to,
        collection: env.collection,
        mpl_core_program: mpl_core::ID,
        fee: env.fee(),
    }
}

fn hold_ix(env: &Env, who: Pubkey, asset: Pubkey, seconds: i64) -> Instruction {
    Instruction::new_with_bytes(
        loot::ID,
        &loot::instruction::Hold { seconds, reference: REF }.data(),
        loot::accounts::HoldItem {
            player: who,
            game: env.game,
            hold: env.hold_pda(&asset),
            asset,
            collection: env.collection,
            mpl_core_program: mpl_core::ID,
            fee: env.fee(),
            system_program: SYSTEM,
        }
        .to_account_metas(None),
    )
}

const SIG: u64 = 5_000;

fn lamports_to(from: &Keypair, to: Pubkey, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(&from.pubkey(), &to, lamports)
}

fn alive(env: &Env, asset: &Pubkey) -> bool {
    mpl_core::Asset::from_bytes(&env.data(asset)).is_ok()
}

fn core_transfer(env: &mut Env, who: &Keypair, asset: Pubkey, collection: Option<Pubkey>, to: Pubkey) -> Result<Vec<String>, String> {
    let ix = TransferV1Builder::new().asset(asset).collection(collection).payer(who.pubkey()).authority(Some(who.pubkey())).new_owner(to).instruction();
    env.send(&[ix], &[who])
}

/// A royalties plugin whose rule refuses every transfer to or from an account of `program`.
fn royalties_denying(program: Pubkey) -> Plugin {
    Plugin::Royalties(Royalties {
        basis_points: 0,
        creators: vec![Creator { address: Pubkey::new_unique(), percentage: 100 }],
        rule_set: RuleSet::ProgramDenyList(vec![program]),
    })
}

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

/// An oracle adapter that can refuse transfers, reading `oracle`.
fn oracle_on_transfers(oracle: Pubkey) -> ExternalPluginAdapterInitInfo {
    ExternalPluginAdapterInitInfo::Oracle(OracleInitInfo {
        base_address: oracle,
        init_plugin_authority: None,
        lifecycle_checks: vec![(HookableLifecycleEvent::Transfer, ExternalCheckResult { flags: 4 })], // 4: can reject
        base_address_config: None,
        results_offset: None,
    })
}

const CORE_MISSING_ADAPTER_ACCOUNT: &str = "custom program error: 0x22";

/// What an oracle account says: 1 (V1), then create, transfer, burn, update (1 rejected, 2 pass).
fn oracle_says(env: &mut Env, oracle: Pubkey, transfer_rejected: bool) {
    let owner = env.creator.pubkey();
    env.put(oracle, owner, vec![1, 2, if transfer_rejected { 1 } else { 2 }, 2, 2]);
}

const CORE_INVALID_COLLECTION: &str = "custom program error: 0x13";

const CORE_PERMANENT_DELEGATES: &str = "custom program error: 0x30";

const CORE_NOT_AVAILABLE: &str = "custom program error: 0x17";

const CORE_ORACLE_REJECTS_ONLY: &str = "custom program error: 0x23";

fn core_burn(env: &mut Env, who: &Keypair, asset: Pubkey, collection: Option<Pubkey>) -> Result<Vec<String>, String> {
    let ix = BurnV1Builder::new().asset(asset).collection(collection).payer(who.pubkey()).authority(Some(who.pubkey())).instruction();
    env.send(&[ix], &[who])
}

/// What the chain takes for one signature.
const TX_FEE: u64 = 5_000;

/// `award` took any `to`, and the game's own address stranded the
/// collectible for good: the hold closed, `unmake` refuses what the game holds, and only the
/// owner of an asset can hand it in. Now it is refused, and the hold stays as it was.
#[test]
fn an_award_to_the_games_own_address_is_refused() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    env.upsert_item(8, ItemArgs { burnable: true, ..item(ItemKind::Collectible, "Arena Ticket", 0, 0) }).unwrap();
    let p = funded(&mut env);
    let ticket = env.make(&authority, 8, p.pubkey()).unwrap();
    env.hold(&p, ticket, 600).unwrap();
    assert!(err(env.award(&authority, ticket, env.game)).contains("ToTheGame"));
    assert!(env.exists(&env.hold_pda(&ticket)), "the hold still records who it goes back to");
    env.award(&authority, ticket, p.pubkey()).unwrap();
    assert_eq!(holder(&env, &ticket), p.pubkey());
}

/// The most valuable check of the area, against the real Core program: a player grants a
/// friend a transfer, a burn and a freeze delegate on their collectible BEFORE handing it to
/// the game. The delegate is real (the friend moves a second, loose one). Once the first one is
/// held, Core has reset every owner-managed plugin's authority to the owner (now the game): the
/// friend can neither pull it out, burn it, nor freeze it there, and the player cannot move it
/// either. An award hands it on with no delegate attached.
#[test]
fn a_delegate_granted_before_a_hold_cannot_reach_into_it_core_resets_it() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let p = player(&mut env, 0);
    let friend = player(&mut env, 0);
    let winner = Keypair::new().pubkey();
    env.upsert_item(80, collectible("Sword")).unwrap();
    let held = env.make(&authority, 80, p.pubkey()).unwrap();
    let loose = env.make(&authority, 80, p.pubkey()).unwrap();
    for asset in [held, loose] {
        for plugin in [Plugin::TransferDelegate(TransferDelegate {}), Plugin::BurnDelegate(BurnDelegate {}), Plugin::FreezeDelegate(FreezeDelegate { frozen: false })] {
            let add = AddPluginV1Builder::new()
                .asset(asset)
                .collection(Some(col))
                .payer(p.pubkey())
                .plugin(plugin)
                .init_authority(PluginAuthority::Address { address: friend.pubkey() })
                .instruction();
            env.send(&[add], &[&p]).unwrap();
        }
    }
    let delegate_of = |env: &Env, asset: &Pubkey| {
        let a = mpl_core::Asset::from_bytes(&env.data(asset)).unwrap();
        let t = a.plugin_list.transfer_delegate.unwrap().base.authority;
        let b = a.plugin_list.burn_delegate.unwrap().base.authority;
        let f = a.plugin_list.freeze_delegate.unwrap().base.authority;
        [(t.authority_type, t.address), (b.authority_type, b.address), (f.authority_type, f.address)]
    };
    assert_eq!(delegate_of(&env, &held), three(AuthorityType::Address, Some(friend.pubkey())));
    // The delegate is real: the friend moves the loose one to themselves with it.
    core_transfer_in(&mut env, &friend, loose, col, friend.pubkey()).unwrap();
    assert_eq!(holder(&env, &loose), friend.pubkey());

    env.hold(&p, held, 1_000).unwrap();
    assert_eq!(holder(&env, &held), env.game);
    assert_eq!(delegate_of(&env, &held), three(AuthorityType::Owner, None), "Core reset every owner-managed delegate on the transfer to the game");
    assert!(err(core_transfer_in(&mut env, &friend, held, col, friend.pubkey())).contains(CORE_NO_APPROVALS));
    assert!(err(core_burn_in(&mut env, &friend, held, col)).contains(CORE_NO_APPROVALS));
    let freeze = UpdatePluginV1Builder::new().asset(held).collection(Some(col)).payer(friend.pubkey()).plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: true })).instruction();
    assert!(err(env.send(&[freeze], &[&friend])).contains(CORE_NO_APPROVALS));
    // The previous owner is nobody to Core now either.
    assert!(err(core_transfer_in(&mut env, &p, held, col, p.pubkey())).contains(CORE_NO_APPROVALS));
    assert!(err(core_burn_in(&mut env, &p, held, col)).contains(CORE_NO_APPROVALS));
    // And the authority cannot unmake what the game holds (third review's fix, re-tested).
    assert!(err(env.unmake(&authority, held)).contains("Held"));

    env.award(&authority, held, winner).unwrap();
    assert_eq!(holder(&env, &held), winner);
    assert_eq!(delegate_of(&env, &held), three(AuthorityType::Owner, None), "the winner gets it with no delegate of the old owner's");
    assert!(err(core_transfer_in(&mut env, &friend, held, col, friend.pubkey())).contains(CORE_NO_APPROVALS));
    assert!(!env.exists(&env.hold_pda(&held)));
    let _ = c;
}

/// A soulbound collectible cannot be held (Core: it is permanently frozen), and a player cannot
/// hold a collectible they do not own. Neither leaves a Hold behind.
#[test]
fn a_soulbound_collectible_and_one_the_player_does_not_own_cannot_be_held() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let (p, q) = (player(&mut env, 0), player(&mut env, 0));
    let oath = env.make(&authority, 3, p.pubkey()).unwrap(); // "Founder Badge": soulbound
    env.upsert_item(80, collectible("Sword")).unwrap();
    let sword = env.make(&authority, 80, p.pubkey()).unwrap();

    let e = err(env.hold(&p, oath, 10));
    assert!(e.contains("custom program error"), "Core refused: {e}");
    let e = err(env.hold(&q, sword, 10));
    assert!(e.contains(CORE_NO_APPROVALS) || e.contains(CORE_INVALID_AUTHORITY), "not the owner: {e}");
    assert_eq!((holder(&env, &oath), holder(&env, &sword)), (p.pubkey(), p.pubkey()));
    assert!(!env.exists(&env.hold_pda(&oath)) && !env.exists(&env.hold_pda(&sword)));
}

/// Every account a release takes is pinned: the asset and the player by the Hold's `has_one`,
/// the collection by the game's address, the authority for `award`; and time divides the two ways out exactly.
#[test]
fn a_release_refuses_every_substitution_and_the_two_ways_out_never_overlap() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let (s1, s2) = (env.make(&authority, 80, p.pubkey()).unwrap(), env.make(&authority, 80, p.pubkey()).unwrap());
    env.hold(&p, s1, 600).unwrap();
    env.hold(&p, s2, 600).unwrap();
    assert!(env.hold(&p, s1, 600).is_err(), "a held collectible is not held twice");

    let base = release(&env, c.pubkey(), s1, p.pubkey());
    // The other held collectible in the place of the hold's.
    let mut m = release(&env, c.pubkey(), s1, p.pubkey());
    m.asset = s2;
    assert!(err(env.send(&[take_back_ix(&m)], &[&c])).contains("ConstraintHasOne"));
    // The other hold in the place of this one.
    let mut m = release(&env, c.pubkey(), s1, p.pubkey());
    m.hold = env.hold_pda(&s2);
    assert!(err(env.send(&[take_back_ix(&m)], &[&c])).contains("ConstraintHasOne"));
    // A stranger as the player who gets the rent.
    let mut m = release(&env, c.pubkey(), s1, p.pubkey());
    m.player = c.pubkey();
    assert!(err(env.send(&[take_back_ix(&m)], &[&c])).contains("ConstraintHasOne"));
    // Another collection.
    let mut m = release(&env, c.pubkey(), s1, p.pubkey());
    m.collection = Pubkey::new_unique();
    assert!(err(env.send(&[take_back_ix(&m)], &[&c])).contains("ConstraintAddress"));

    // Before the time is up: only the authority, and only by `award`.
    assert!(err(env.send(&[take_back_ix(&base)], &[&c])).contains("StillHeld"));
    let mut m = release(&env, c.pubkey(), s1, c.pubkey());
    m.signer = c.pubkey();
    assert!(err(env.send(&[award_ix(&m)], &[&c])).contains("NotAuthority"));
    env.wait(599);
    assert!(err(env.send(&[take_back_ix(&base)], &[&c])).contains("StillHeld"));
    env.wait(1);
    // At exactly `free_at`: the authority's say is over, anyone sends it home, only home.
    let m = release(&env, authority.pubkey(), s1, c.pubkey());
    assert!(err(env.send(&[award_ix(&m)], &[&authority])).contains("HoldOver"));
    env.send(&[take_back_ix(&base)], &[&c]).unwrap();
    assert_eq!(holder(&env, &s1), p.pubkey());
    assert!(!env.exists(&env.hold_pda(&s1)));
}

/// `rent.rs` and Anchor's `init` on a Hold someone pre-funded: a stranger parks SOL at the
/// hold's address before the player holds. The hold still opens, the player pays no rent, and
/// the parked SOL leaves with the hold's rent to the player (never to the stranger who sends
/// `take_back`). The address is reused by a new hold with fresh state, and `take_back` plus
/// `hold` in one transaction works: a closed Hold does not revive.
#[test]
fn a_prefunded_hold_works_and_its_address_is_reused_fresh_even_in_one_transaction() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let sword = env.make(&authority, 80, p.pubkey()).unwrap();
    let hold = env.hold_pda(&sword);
    let rent = env.rent(1 + loot::Hold::INIT_SPACE);

    env.send(&[lamports_to(&c, hold, 500_000_000)], &[&c]).unwrap();
    let (p_before, c_before) = (env.lamports(&p.pubkey()), env.lamports(&c.pubkey()));
    env.hold(&p, sword, 10).unwrap();
    assert_eq!(env.lamports(&hold), 500_000_000, "the excess stays in the account");
    assert_eq!(p_before - env.lamports(&p.pubkey()), FEE + SIG, "the player paid no rent");
    let h: loot::Hold = env.acc(&hold);
    assert_eq!((h.player, h.free_at, h.reference), (p.pubkey(), env.now() + 10, REF));

    env.wait(10);
    env.take_back(&c, sword).unwrap();
    assert_eq!(env.lamports(&p.pubkey()), p_before - FEE - SIG + 500_000_000, "the parked SOL went with the rent to the player");
    assert_eq!(env.lamports(&c.pubkey()), c_before - SIG, "the stranger got nothing back");
    assert!(!env.exists(&hold));

    // The same address again, with a different time: fresh state, exactly the rent.
    env.hold(&p, sword, 777).unwrap();
    let h: loot::Hold = env.acc(&hold);
    assert_eq!((h.free_at, env.lamports(&hold)), (env.now() + 777, rent));

    // Out and in within one transaction, signed by the stranger (take_back) and the player (hold).
    env.wait(777);
    let out = take_back_ix(&release(&env, c.pubkey(), sword, p.pubkey()));
    let back_in = hold_ix(&env, p.pubkey(), sword, 5);
    env.send(&[out, back_in], &[&c, &p]).unwrap();
    let h: loot::Hold = env.acc(&hold);
    assert_eq!((holder(&env, &sword), h.free_at, env.lamports(&hold)), (env.game, env.now() + 5, rent));
    // A zero-second hold: the stranger sends it home at once.
    env.hold(&p, sword, 0).unwrap_err();
    env.wait(5);
    env.take_back(&c, sword).unwrap();
    env.hold(&p, sword, 0).unwrap();
    env.take_back(&c, sword).unwrap();
    assert_eq!(holder(&env, &sword), p.pubkey());
}

/// The authority could `award` a held collectible to the game's
/// own address, and `make` one to it, and from then on nothing moved it: `unmake` refuses (the
/// holder is the game), nobody can `hold` it (the game cannot sign), and no instruction
/// transfers a game-owned collectible without a Hold. Both are refused now.
#[test]
fn a_collectible_cannot_be_awarded_or_made_to_the_game_itself() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let p = player(&mut env, 0);
    env.upsert_item(80, ItemArgs { burnable: true, ..collectible("Sword") }).unwrap();
    let sword = env.make(&authority, 80, p.pubkey()).unwrap();
    env.hold(&p, sword, 600).unwrap();
    assert!(err(env.award(&authority, sword, env.game)).contains("ToTheGame"));
    assert!(env.exists(&env.hold_pda(&sword)));
    assert!(env.make(&authority, 80, env.game).unwrap_err().contains("ToTheGame"));
    assert_eq!(env.item_state(80).issued, 1, "the refused make took no serial");
}

/// A raid: a player takes a sword in for ten minutes. If they die in that time the authority
/// gives it to whoever killed them; if they do not, it comes home.
#[test]
fn a_player_hands_a_collectible_to_the_game_for_a_time_they_choose() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let p = player(&mut env, 0);
    let killer = Keypair::new().pubkey();
    env.upsert_item(80, collectible("Sword")).unwrap();
    env.upsert_item(81, ItemArgs { soulbound: true, ..collectible("Oath") }).unwrap();
    let swords: Vec<Pubkey> = (0..3).map(|_| env.make(&authority, 80, p.pubkey()).unwrap()).collect();
    let oath = env.make(&authority, 81, p.pubkey()).unwrap();

    // The first sword: lost in the raid.
    let before = env.lamports(&p.pubkey());
    env.hold(&p, swords[0], 600).unwrap();
    let h: loot::Hold = env.acc(&env.hold_pda(&swords[0]));
    assert_eq!((holder(&env, &swords[0]), h.player, h.free_at), (env.game, p.pubkey(), env.now() + 600));
    assert!(err(env.take_back(&c, swords[0])).contains("StillHeld"));
    assert!(err(env.award(&owner, swords[0], killer)).contains("NotAuthority"));
    env.award(&authority, swords[0], killer).unwrap();
    assert_eq!(holder(&env, &swords[0]), killer);
    assert!(!env.exists(&env.hold_pda(&swords[0])));
    assert_eq!(before - env.lamports(&p.pubkey()), FEE + 5_000, "the hold's rent came back; the fee and the signature did not");

    // The second: the raid ends, and the authority's say with it.
    env.hold(&p, swords[1], 600).unwrap();
    env.wait(600);
    assert!(err(env.award(&authority, swords[1], killer)).contains("HoldOver"));
    env.take_back(&c, swords[1]).unwrap();
    assert_eq!(holder(&env, &swords[1]), p.pubkey());

    // The third: no time at all is a hold nobody but the player ever decides.
    env.hold(&p, swords[2], 0).unwrap();
    assert!(err(env.award(&authority, swords[2], killer)).contains("HoldOver"));
    // Neither the owner's pause nor the platform's suspension keeps it from going home.
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(true) }).unwrap();
    let admin = env.admin.insecure_clone();
    env.set_suspended(&admin, true).unwrap();
    env.take_back(&p, swords[2]).unwrap();
    assert!(err(env.hold(&p, swords[2], 0)).contains("Paused"));

    // A soulbound collectible never moves, so it cannot be held.
    env.set_suspended(&admin, false).unwrap();
    env.update_game(&owner, GameUpdate { authority: None, paused: Some(false) }).unwrap();
    assert!(env.hold(&p, oath, 0).is_err());
    assert_eq!(holder(&env, &oath), p.pubkey());
}

/// HIGH, fixed. `unmake` signs Core's burn as the game, and Core lets an asset's owner burn it.
/// While a collectible is held the game is its owner, so the authority could burn a held
/// collectible that was never burnable, during the hold and after it. Now `unmake` refuses a
/// collectible the game is holding.
#[test]
fn the_authority_cannot_burn_a_collectible_the_game_is_holding() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let p = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap(); // burnable: false
    env.upsert_item(82, ItemArgs { burnable: true, ..collectible("Ticket") }).unwrap();
    let swords: Vec<Pubkey> = (0..2).map(|_| env.make(&authority, 80, p.pubkey()).unwrap()).collect();
    let ticket = env.make(&authority, 82, p.pubkey()).unwrap();

    assert!(env.unmake(&authority, swords[0]).is_err(), "not in the player's wallet");
    env.hold(&p, swords[0], 0).unwrap();
    assert!(err(env.unmake(&authority, swords[0])).contains("Held"), "not at a hold of no time");
    env.take_back(&c, swords[0]).unwrap();

    env.hold(&p, swords[1], 600).unwrap();
    assert!(err(env.unmake(&authority, swords[1])).contains("Held"), "not while a hold runs");
    env.wait(601);
    assert!(err(env.unmake(&authority, swords[1])).contains("Held"), "not after it is over");
    env.take_back(&c, swords[1]).unwrap();
    assert!(alive(&env, &swords[0]) && alive(&env, &swords[1]));

    // Not even a burnable one while it is held. In the wallet it still can be.
    env.hold(&p, ticket, 0).unwrap();
    assert!(err(env.unmake(&authority, ticket)).contains("Held"));
    env.take_back(&c, ticket).unwrap();
    env.unmake(&authority, ticket).unwrap();
}

/// A hold takes only a collectible of this game's collection, from whoever owns it. The second
/// the hold ends is the player's: `award` is refused from `free_at` on and `take_back` before
/// it, so there is no second in which both work or neither does.
#[test]
fn a_hold_takes_only_the_games_collectibles_and_its_last_second_belongs_to_one_side() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let p = player(&mut env, 0);
    let thief = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let sword = env.make(&authority, 80, p.pubkey()).unwrap();

    // An asset outside the collection.
    let loose = Keypair::new();
    let ix = mpl_core::instructions::CreateV2Builder::new()
        .asset(loose.pubkey())
        .payer(p.pubkey())
        .owner(Some(p.pubkey()))
        .name("Sword #9".into())
        .uri("x".into())
        .instruction();
    env.send(&[ix], &[&p, &loose]).unwrap();
    assert!(env.hold(&p, loose.pubkey(), 0).is_err());
    assert_eq!(holder(&env, &loose.pubkey()), p.pubkey());

    // Someone else's sword.
    assert!(env.hold(&thief, sword, 0).is_err());

    env.hold(&p, sword, 600).unwrap();
    assert!(err(env.hold(&p, sword, 600)).contains("already in use"), "one hold at a time");
    env.wait(599);
    assert!(err(env.take_back(&c, sword)).contains("StillHeld"));
    env.wait(1);
    assert!(err(env.award(&authority, sword, thief.pubkey())).contains("HoldOver"));
    // Only the player's own address, and only the Hold of this asset.
    env.take_back(&c, sword).unwrap();
    assert_eq!(holder(&env, &sword), p.pubkey());
}

/// By design: the project's own keys are trusted (the reviewer rated it high). "A hold always has a way out that needs nobody's permission" is false against
/// whoever controls the game's Core collection (its owner). Core asks the collection's
/// plugins about every transfer of an asset in it, and the collection's update authority can
/// add a `Royalties` plugin with a rule set at any time after `create_game`. A deny list that
/// names the loot program refuses every transfer whose signer or receiver is an account of
/// the loot program: that is exactly the game handing a held collectible back. `take_back`
/// then fails for every held collectible until the owner removes the plugin, while collectibles
/// in wallets still move. The same plugin added to one asset strands only that one.
/// `create_game` also accepts a collection that is born with it. A deny list naming the system
/// program freezes every player's collectible in their own wallet.
#[test]
fn the_collections_owner_stops_every_take_back_with_a_royalties_rule() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let (p, q) = (player(&mut env, 0), player(&mut env, 0));
    env.upsert_item(80, collectible("Sword")).unwrap();
    let swords: Vec<Pubkey> = (0..4).map(|_| env.make(&authority, 80, p.pubkey()).unwrap()).collect();
    env.hold(&p, swords[0], 10).unwrap();
    env.hold(&p, swords[1], 10_000).unwrap();
    env.wait(11);

    let add = AddCollectionPluginV1Builder::new().collection(col).payer(owner.pubkey()).plugin(royalties_denying(loot::ID)).instruction();
    env.send(&[add], &[&owner]).unwrap();

    // The hold is over and the collectible does not come home.
    assert!(err(env.take_back(&c, swords[0])).contains(CORE_INVALID_AUTHORITY));
    assert!(err(env.take_back(&p, swords[0])).contains(CORE_INVALID_AUTHORITY));
    // Nor can the authority give back one whose hold still runs.
    assert!(err(env.award(&authority, swords[1], p.pubkey())).contains(CORE_INVALID_AUTHORITY));
    assert_eq!(holder(&env, &swords[0]), env.game);
    // A collectible in a wallet still moves: only what the game holds is stuck.
    core_transfer(&mut env, &p, swords[2], Some(col), q.pubkey()).unwrap();

    // It comes home when the owner allows it, and only then.
    let remove = RemoveCollectionPluginV1Builder::new().collection(col).payer(owner.pubkey()).plugin_type(PluginType::Royalties).instruction();
    env.send(&[remove], &[&owner]).unwrap();
    env.take_back(&c, swords[0]).unwrap();

    // The same on one asset only.
    env.hold(&p, swords[3], 0).unwrap();
    let add = AddPluginV1Builder::new().asset(swords[3]).collection(Some(col)).payer(owner.pubkey()).plugin(royalties_denying(loot::ID)).instruction();
    env.send(&[add], &[&owner]).unwrap();
    assert!(err(env.take_back(&c, swords[3])).contains(CORE_INVALID_AUTHORITY));
    env.hold(&p, swords[0], 0).unwrap();
    env.take_back(&c, swords[0]).unwrap();

    // A deny list naming the system program: no wallet can send or receive one.
    let add = AddCollectionPluginV1Builder::new().collection(col).payer(owner.pubkey()).plugin(royalties_denying(SYSTEM)).instruction();
    env.send(&[add], &[&owner]).unwrap();
    assert!(err(core_transfer(&mut env, &q, swords[2], Some(col), p.pubkey())).contains(CORE_INVALID_AUTHORITY));

    // And `create_game` takes a collection born with such a rule.
    let mut env = world();
    env.init_platform(FEE).unwrap();
    env.collection = new_collection(&mut env, vec![royalties_denying(loot::ID)], vec![]).unwrap();
    env.game = pda(&[loot::GAME_SEED, env.collection.as_ref()]);
    env.create_game().unwrap();
}

/// By design, as above (rated high). The same, with an oracle. A Core collection can carry external plugin adapters, which
/// `create_game` does not look at (they are in a second registry) and which the update
/// authority can add later anyway. An `Oracle` adapter makes Core read an account its author
/// controls before every transfer. While that account says "rejected", no collectible of the
/// game moves: not in a wallet, not out of a hold. And even while it says "pass", every
/// `take_back`, `award` and `hold` fails, because Core then requires the oracle account in the
/// transaction and those instructions pass none on.
#[test]
fn an_oracle_on_the_collection_stops_every_take_back_even_while_it_passes() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let (p, q) = (player(&mut env, 0), player(&mut env, 0));
    env.upsert_item(80, collectible("Sword")).unwrap();
    let held = env.make(&authority, 80, p.pubkey()).unwrap();
    let loose = env.make(&authority, 80, p.pubkey()).unwrap();
    env.hold(&p, held, 10).unwrap();
    env.wait(11);

    let oracle = Pubkey::new_unique();
    oracle_says(&mut env, oracle, true);
    let add = AddCollectionExternalPluginAdapterV1Builder::new().collection(col).payer(owner.pubkey()).init_info(oracle_on_transfers(oracle)).instruction();
    env.send(&[add], &[&owner]).unwrap();

    // Rejected: a player cannot move their own collectible.
    let mut transfer = TransferV1Builder::new().asset(loose).collection(Some(col)).payer(p.pubkey()).new_owner(q.pubkey()).instruction();
    transfer.accounts.push(AccountMeta::new_readonly(oracle, false));
    assert!(err(env.send(&[transfer.clone()], &[&p])).contains(CORE_INVALID_AUTHORITY));
    assert!(err(env.take_back(&c, held)).contains(CORE_MISSING_ADAPTER_ACCOUNT));

    // Pass: the wallet transfer works, with the oracle account in the transaction.
    oracle_says(&mut env, oracle, false);
    env.send(&[transfer], &[&p]).unwrap();
    // The program's own transfers have no place for that account.
    assert!(err(env.take_back(&c, held)).contains(CORE_MISSING_ADAPTER_ACCOUNT));
    assert!(err(env.hold(&q, loose, 0)).contains(CORE_MISSING_ADAPTER_ACCOUNT));
    assert_eq!(holder(&env, &held), env.game);

    // `create_game` takes a collection born with an oracle.
    let mut env = world();
    env.init_platform(FEE).unwrap();
    env.collection = new_collection(&mut env, vec![], vec![oracle_on_transfers(oracle)]).unwrap();
    env.game = pda(&[loot::GAME_SEED, env.collection.as_ref()]);
    env.create_game().unwrap();
}

/// By design, as above (rated high). A third way, with no plugin at all. The collection's update authority can take any
/// asset out of the collection with Core's `UpdateV2`, whoever owns it. A held collectible that
/// is no longer in the game's collection can never be handed back: `take_back` names the game's
/// collection, and Core refuses the pair. A collectible in a wallet that is taken out stops
/// being one of its item for every recipe (and can no longer be held).
#[test]
fn the_collections_owner_takes_a_held_collectible_out_of_the_collection() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let p = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    env.upsert_item(81, collectible("Blade")).unwrap();
    env.upsert_recipe(&owner, 1, merge_recipe(80, 1, 81)).unwrap();
    let held = env.make(&authority, 80, p.pubkey()).unwrap();
    let loose = env.make(&authority, 80, p.pubkey()).unwrap();
    env.hold(&p, held, 10).unwrap();
    env.wait(11);

    for asset in [held, loose] {
        let out = UpdateV2Builder::new()
            .asset(asset)
            .collection(Some(col))
            .payer(owner.pubkey())
            .new_update_authority(UpdateAuthority::Address(owner.pubkey()))
            .instruction();
        env.send(&[out], &[&owner]).unwrap();
    }

    assert!(err(env.take_back(&c, held)).contains(CORE_INVALID_COLLECTION));
    assert_eq!(holder(&env, &held), env.game, "it stays with the game for good");
    assert!(err(env.craft(&p, 1, &[loose])).contains("ItemMismatch"), "the player's sword is no sword any more");
    assert!(env.hold(&p, loose, 0).is_err());
    // The owner cannot take it for themselves this way (see the `sound_` test below).
    assert!(err(core_transfer(&mut env, &owner, held, None, owner.pubkey())).contains(CORE_NO_APPROVALS));
}

/// By design, as above (rated medium). All three ways above are open to every update delegate of the collection, not only
/// its update authority. The game itself has to be one (that is how it mints), and
/// `create_game` neither checks who else is, nor can it stop the owner adding one later: a
/// server key that was only meant to edit metadata can strand every held collectible.
#[test]
fn any_update_delegate_of_the_collection_can_stop_take_back_too() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let (col, game) = (env.collection, env.game);
    let p = player(&mut env, 0);
    let delegate = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let held = env.make(&authority, 80, p.pubkey()).unwrap();
    env.hold(&p, held, 0).unwrap();

    let delegates = Plugin::UpdateDelegate(UpdateDelegate { additional_delegates: vec![game, delegate.pubkey()] });
    let name = UpdateCollectionPluginV1Builder::new().collection(col).payer(owner.pubkey()).plugin(delegates).instruction();
    env.send(&[name], &[&owner]).unwrap();

    let add = AddCollectionPluginV1Builder::new().collection(col).payer(delegate.pubkey()).plugin(royalties_denying(loot::ID)).instruction();
    env.send(&[add], &[&delegate]).unwrap();
    assert!(err(env.take_back(&c, held)).contains(CORE_INVALID_AUTHORITY));
}

/// The collection-plugin question, the part that holds. After `create_game` nobody can give the
/// collection, or an asset in it, a plugin that moves or burns what someone else owns: Core
/// refuses a permanent freeze, transfer or burn delegate anywhere but at creation, refuses an
/// owner's freeze, transfer or burn delegate on a collection at all, refuses it on an asset to
/// anyone but the asset's owner, refuses to move an asset into a collection that has permanent
/// delegates, and refuses a lifecycle hook. So the owner can strand a collectible (the findings
/// above) but cannot take or burn one: not from a wallet, not from the game.
#[test]
fn nothing_added_after_create_game_moves_or_burns_a_collectible() {
    let mut env = setup();
    let (owner, authority, c) = (env.creator.insecure_clone(), env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let p = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let held = env.make(&authority, 80, p.pubkey()).unwrap();
    let loose = env.make(&authority, 80, p.pubkey()).unwrap();
    env.hold(&p, held, 10).unwrap();
    env.wait(11);

    let seizing = || {
        vec![
            Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }),
            Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}),
            Plugin::PermanentBurnDelegate(PermanentBurnDelegate {}),
            Plugin::FreezeDelegate(FreezeDelegate { frozen: true }),
            Plugin::TransferDelegate(TransferDelegate {}),
            Plugin::BurnDelegate(BurnDelegate {}),
        ]
    };
    for plugin in seizing() {
        let add = AddCollectionPluginV1Builder::new().collection(col).payer(owner.pubkey()).plugin(plugin).instruction();
        assert!(err(env.send(&[add], &[&owner])).contains(CORE_INVALID_AUTHORITY));
    }
    for asset in [held, loose] {
        for plugin in seizing() {
            let add = AddPluginV1Builder::new().asset(asset).collection(Some(col)).payer(owner.pubkey()).plugin(plugin).instruction();
            assert!(env.send(&[add], &[&owner]).is_err());
        }
    }
    let hook = ExternalPluginAdapterInitInfo::LifecycleHook(LifecycleHookInitInfo {
        hooked_program: owner.pubkey(),
        init_plugin_authority: None,
        lifecycle_checks: vec![(HookableLifecycleEvent::Transfer, ExternalCheckResult { flags: 2 })], // 2: can approve
        extra_accounts: None,
        data_authority: None,
        schema: None,
    });
    let add = AddCollectionExternalPluginAdapterV1Builder::new().collection(col).payer(owner.pubkey()).init_info(hook).instruction();
    assert!(err(env.send(&[add], &[&owner])).contains(CORE_NOT_AVAILABLE));
    // An oracle can refuse and never approve.
    let mut approving = oracle_on_transfers(Pubkey::new_unique());
    if let ExternalPluginAdapterInitInfo::Oracle(oracle) = &mut approving {
        oracle.lifecycle_checks[0].1.flags = 2;
    }
    let add = AddCollectionExternalPluginAdapterV1Builder::new().collection(col).payer(owner.pubkey()).init_info(approving).instruction();
    assert!(err(env.send(&[add], &[&owner])).contains(CORE_ORACLE_REJECTS_ONLY));

    // Into a collection of the owner's that was born with permanent delegates.
    let trap = new_collection(&mut env, vec![Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}), Plugin::PermanentBurnDelegate(PermanentBurnDelegate {})], vec![]).unwrap();
    for asset in [held, loose] {
        let moved = UpdateV2Builder::new()
            .asset(asset)
            .collection(Some(col))
            .payer(owner.pubkey())
            .new_collection(Some(trap))
            .new_update_authority(UpdateAuthority::Collection(trap))
            .instruction();
        assert!(err(env.send(&[moved], &[&owner])).contains(CORE_PERMANENT_DELEGATES));
        assert!(core_transfer(&mut env, &owner, asset, Some(col), owner.pubkey()).is_err());
        assert!(core_burn(&mut env, &owner, asset, Some(col)).is_err());
    }
    env.take_back(&c, held).unwrap();
    assert_eq!((holder(&env, &held), holder(&env, &loose)), (p.pubkey(), p.pubkey()));
}

/// The third review could not check a delegate and a hold. A player's own transfer, burn and
/// freeze delegates end when the collectible goes to the game: the delegate cannot pull it out
/// of a hold, burn it there, or freeze it so that it never comes back. A delegate can itself
/// start a hold, and then the collectible comes back to the delegate: no more than the
/// transfer it could already make.
#[test]
fn a_players_delegates_do_not_reach_into_a_hold() {
    let mut env = setup();
    let (authority, c) = (env.authority.insecure_clone(), env.cranker.insecure_clone());
    let col = env.collection;
    let p = player(&mut env, 0);
    let friend = player(&mut env, 0);
    env.upsert_item(80, collectible("Sword")).unwrap();
    let sword = env.make(&authority, 80, p.pubkey()).unwrap();
    let delegates = |env: &mut Env, p: &Keypair| {
        for plugin in [Plugin::TransferDelegate(TransferDelegate {}), Plugin::BurnDelegate(BurnDelegate {}), Plugin::FreezeDelegate(FreezeDelegate { frozen: false })] {
            let add = AddPluginV1Builder::new().asset(sword).collection(Some(col)).payer(p.pubkey()).plugin(plugin).init_authority(PluginAuthority::Address { address: friend.pubkey() }).instruction();
            env.send(&[add], &[p]).unwrap();
        }
    };
    delegates(&mut env, &p);
    env.hold(&p, sword, 1_000).unwrap();

    assert!(err(core_transfer(&mut env, &friend, sword, Some(col), friend.pubkey())).contains(CORE_NO_APPROVALS));
    assert!(err(core_burn(&mut env, &friend, sword, Some(col))).contains(CORE_NO_APPROVALS));
    let freeze = UpdatePluginV1Builder::new().asset(sword).collection(Some(col)).payer(friend.pubkey()).plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: true })).instruction();
    assert!(err(env.send(&[freeze], &[&friend])).contains(CORE_NO_APPROVALS));
    env.wait(1_000);
    env.take_back(&c, sword).unwrap();
    assert_eq!(holder(&env, &sword), p.pubkey());

    // The delegate's own hold: the collectible returns to the delegate.
    let plugins = [PluginType::TransferDelegate, PluginType::BurnDelegate, PluginType::FreezeDelegate];
    for plugin_type in plugins {
        let remove = RemovePluginV1Builder::new().asset(sword).collection(Some(col)).payer(p.pubkey()).plugin_type(plugin_type).instruction();
        env.send(&[remove], &[&p]).unwrap();
    }
    delegates(&mut env, &p);
    env.hold(&friend, sword, 0).unwrap();
    env.take_back(&c, sword).unwrap();
    assert_eq!(holder(&env, &sword), friend.pubkey());
}

/// A hold's rent and its way home, with nobody the player has to ask: a stranger with no
/// stake in it sends the collectible back, the player gets the hold's rent, and the address
/// is free for the next hold. A hold of the longest time does not overflow.
#[test]
fn a_holds_rent_comes_back_and_its_address_is_free_again() {
    let mut env = setup();
    env.wait(1_700_000_000);
    let authority = env.authority.insecure_clone();
    let p = player(&mut env, 0);
    let keeper = env.cranker.insecure_clone();
    env.upsert_item(40, collectible("Sword")).unwrap();
    let sword = env.make(&authority, 40, p.pubkey()).unwrap();
    for _ in 0..2 {
        let had = env.lamports(&p.pubkey());
        env.hold(&p, sword, 60).unwrap();
        assert!(err(env.take_back(&keeper, sword)).contains("StillHeld"));
        env.wait(60);
        env.take_back(&keeper, sword).unwrap();
        assert_eq!(env.lamports(&p.pubkey()), had - FEE - TX_FEE, "only the fees are gone: the hold's rent came back");
        assert!(env.data(&env.hold_pda(&sword)).is_empty());
    }
    env.hold(&p, sword, i64::MAX).unwrap();
    assert_eq!(env.acc::<loot::Hold>(&env.hold_pda(&sword)).free_at, i64::MAX);
    env.award(&authority, sword, p.pubkey()).unwrap();
}
