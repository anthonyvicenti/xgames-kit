//! The registry of official tokens: `attach_token` and `recheck_token` on real venue bytes.
mod common;

use {
    anchor_lang::AccountSerialize,
    anchor_lang::prelude::Pubkey,
    anchor_lang::solana_program::instruction::AccountMeta,
    anchor_spl::token::spl_token,
    common::*,
    loot::GameUpdate,
    loot::state::Game,
    loot::state::OfficialToken,
    loot::state::Venue,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const LAUNCHER: Pubkey = Pubkey::from_str_const("7eqbK77uXxrZmd8gi6wGogYgQ6Ks9BH8PLhEA3vtUHy4");

fn has_event(logs: &[String]) -> bool {
    logs.iter().any(|l| l.starts_with("Program data: "))
}

const PUMP_MINT: Pubkey = Pubkey::from_str_const("FYAtGGoi1X1psUB2aqxVFkBSeEcqGv8GpVaGqpuCYyVX");

struct Venues {
    pool: Pubkey,
    config: Pubkey,
    pool100: Pubkey,
    config100: Pubkey,
    curve: Pubkey,
    sharing: Pubkey,
    unshared_curve: Pubkey,
    unshared_sharing: Pubkey,
    plain_mint: Pubkey,
}

fn pump_pda(seed: &[u8], mint: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[seed, mint.as_ref()], program).0
}

const PUMP_UNSHARED_MINT: Pubkey = Pubkey::from_str_const("H7WMLJ1T6Vu1aLhg4ABE7qnAGoRc24DPRsZ2g7mDgNR6");

fn venues(env: &mut Env) -> Venues {
    let v = Venues {
        pool: env.load("venue/meteora-official-pool"),
        config: env.load("venue/meteora-official-config"),
        pool100: env.load("venue/meteora-creator100-pool"),
        config100: env.load("venue/meteora-creator100-config"),
        curve: env.load("venue/pump-shared-curve"),
        sharing: env.load("venue/pump-shared-sharing"),
        unshared_curve: env.load("venue/pump-unshared-curve"),
        unshared_sharing: pump_pda(loot::venue::SHARING_SEED, &PUMP_UNSHARED_MINT, &loot::PUMP_FEES_ID),
        plain_mint: env.load("venue/plain-mint"),
    };
    // The fixtures sit at the addresses the program derives.
    assert_eq!(v.curve, pump_pda(loot::venue::CURVE_SEED, &PUMP_MINT, &loot::PUMP_ID));
    assert_eq!(v.sharing, pump_pda(loot::venue::SHARING_SEED, &PUMP_MINT, &loot::PUMP_FEES_ID));
    assert_eq!(v.unshared_curve, pump_pda(loot::venue::CURVE_SEED, &PUMP_UNSHARED_MINT, &loot::PUMP_ID));
    v
}

const METEORA_MINT: Pubkey = Pubkey::from_str_const("CCpfeJP4nyeJm2s9Fk6poN8t8d7hGvrJRvMU3EM2hF31");

fn expect(result: Result<Vec<String>, String>, what: &str) {
    let err = result.expect_err(what);
    assert!(err.contains(what), "expected {what}, got:
{err}");
}

fn rando(env: &mut Env) -> Keypair {
    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    k
}

const PLAIN_MINT: Pubkey = Pubkey::from_str_const("FNdYk3az9KtB1GaRWq6yRtoCmS79bqYhpDKdt1xyexvq");

const METEORA_100_MINT: Pubkey = Pubkey::from_str_const("GV6AXgb5Q6yCijeYetskPLzPUqqnq3rYYScrQ7rhGjRV");

const DBC: Pubkey = loot::METEORA_DBC_ID;

fn funded_kp(env: &mut Env, n: u8) -> Keypair {
    let k = kp(n);
    env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

#[test]
fn attach_a_meteora_launch_when_its_launcher_signs() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();
    assert_eq!(env.game_state().official, None);
    let size = env.data(&env.game).len();
    assert_eq!(size, Game::space(false));

    let logs = env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config).unwrap();
    assert!(has_event(&logs));
    assert_eq!(env.game_state().official, Some(OfficialToken { mint: METEORA_MINT, venue: Venue::Meteora }));
    // The record costs exactly its 33 bytes, paid by the admin.
    assert_eq!(env.data(&env.game).len(), size + 33);
    assert_eq!(env.lamports(&env.game), env.rent(size + 33));

    // Checked again by anyone: it still passes, nothing changes.
    env.recheck(v.pool, v.config).unwrap();
    assert_eq!(env.game_state().official.unwrap().mint, METEORA_MINT);
}

#[test]
fn attach_needs_the_launcher_signature_and_the_games_owner() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();

    // The game's owner signs as "launcher" with their own key: they did not launch the token.
    expect(env.attach(&c, c.pubkey(), Venue::Meteora, METEORA_MINT, v.pool, v.config), "LauncherMustSign");
    expect(env.attach(&c, c.pubkey(), Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "LauncherMustSign");
    // The partner is a shareholder too, and is not the launcher.
    expect(env.attach(&c, PARTNER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "LauncherMustSign");

    // The real launcher named, but not signing.
    let mut ix = env.attach_ix(c.pubkey(), LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config);
    ix.accounts[1] = AccountMeta::new_readonly(LAUNCHER, false);
    expect(env.send(&[ix], &[&c]), "AccountNotSigner");

    // The launcher signs, for a game the other signer has no say in.
    let r = rando(&mut env);
    expect(env.attach(&r, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config), "NotOwner");
    assert_eq!(env.game_state().official, None);

    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official, Some(OfficialToken { mint: PUMP_MINT, venue: Venue::PumpFun }));
    assert_eq!(env.data(&env.game).len(), Game::space(true));
}

#[test]
fn attach_refuses_every_launch_that_does_not_pay_the_split() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();

    // Meteora, fee claimer is the partner, creator takes 100% of the trading fee.
    expect(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_100_MINT, v.pool100, v.config100), "CreatorFeeTooHigh");
    // pump.fun coin with only its create transaction.
    expect(
        env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_UNSHARED_MINT, v.unshared_curve, v.unshared_sharing),
        "NoFeeSharing",
    );
    // A plain mint: no curve on pump.fun, and no account that is its Meteora pool.
    let curve = pump_pda(loot::venue::CURVE_SEED, &PLAIN_MINT, &loot::PUMP_ID);
    let sharing = pump_pda(loot::venue::SHARING_SEED, &PLAIN_MINT, &loot::PUMP_FEES_ID);
    expect(env.attach(&c, LAUNCHER, Venue::PumpFun, PLAIN_MINT, curve, sharing), "NoBondingCurve");
    expect(env.attach(&c, LAUNCHER, Venue::Meteora, PLAIN_MINT, v.plain_mint, v.plain_mint), "VenueAccounts");

    // A platform with another partner: the same real launches no longer qualify.
    let mut p = env.platform();
    p.partner = Pubkey::new_unique();
    let mut data = vec![];
    p.try_serialize(&mut data).unwrap();
    env.put(platform_pda(), loot::ID, data);
    expect(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config), "FeeClaimerNotPartner");
    expect(env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "ShareholdersMismatch");
    assert_eq!(env.game_state().official, None);
}

#[test]
fn attach_cannot_be_fooled_by_other_accounts() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();
    let bad = |env: &mut Env, venue, mint, a, b| {
        expect(env.attach(&c, LAUNCHER, venue, mint, a, b), "VenueAccounts");
        assert_eq!(env.game_state().official, None);
    };

    // A pool for another mint (a passing one offered for a failing mint, and the reverse).
    bad(&mut env, Venue::Meteora, METEORA_100_MINT, v.pool, v.config);
    bad(&mut env, Venue::Meteora, METEORA_MINT, v.pool100, v.config100);
    // A config from another pool: the failing mint's pool with the passing config.
    bad(&mut env, Venue::Meteora, METEORA_100_MINT, v.pool100, v.config);
    bad(&mut env, Venue::Meteora, METEORA_MINT, v.pool, v.config100);
    // Look-alikes: the passing pool's bytes rewritten for the failing mint, owned by another
    // program (an attacker cannot make the DBC program own what they wrote).
    let mut pool = fixture("venue/meteora-official-pool").data;
    pool[loot::venue::POOL_BASE_MINT..loot::venue::POOL_BASE_MINT + 32].copy_from_slice(METEORA_100_MINT.as_ref());
    let fake_pool = Pubkey::new_unique();
    for owner in [SYSTEM, loot::ID, spl_token::ID] {
        env.put(fake_pool, owner, pool.clone());
        bad(&mut env, Venue::Meteora, METEORA_100_MINT, fake_pool, v.config);
    }
    // A look-alike config (the passing config's bytes at another address, any owner).
    let fake_config = Pubkey::new_unique();
    env.put(fake_config, loot::METEORA_DBC_ID, fixture("venue/meteora-official-config").data);
    bad(&mut env, Venue::Meteora, METEORA_100_MINT, v.pool100, fake_config);
    // Accounts in the wrong order, the wrong venue for the accounts.
    bad(&mut env, Venue::Meteora, METEORA_MINT, v.config, v.pool);
    bad(&mut env, Venue::PumpFun, METEORA_MINT, v.pool, v.config);
    bad(&mut env, Venue::Meteora, PUMP_MINT, v.curve, v.sharing);

    // pump.fun: another coin's fee-sharing config for a coin that has none.
    bad(&mut env, Venue::PumpFun, PUMP_UNSHARED_MINT, v.unshared_curve, v.sharing);
    // Another coin's curve and sharing config, whole.
    bad(&mut env, Venue::PumpFun, PUMP_UNSHARED_MINT, v.curve, v.sharing);
    // A look-alike sharing config for the unshared coin: right bytes (its mint written in),
    // owned by the fee program even, but not at the mint's address.
    let mut sharing = fixture("venue/pump-shared-sharing").data;
    sharing[loot::venue::SHARING_MINT..loot::venue::SHARING_MINT + 32].copy_from_slice(PUMP_UNSHARED_MINT.as_ref());
    let fake_sharing = Pubkey::new_unique();
    env.put(fake_sharing, loot::PUMP_FEES_ID, sharing.clone());
    bad(&mut env, Venue::PumpFun, PUMP_UNSHARED_MINT, v.unshared_curve, fake_sharing);
    // The same bytes AT the mint's address but owned by someone else are not a sharing config.
    env.put(v.unshared_sharing, SYSTEM, sharing);
    expect(
        env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_UNSHARED_MINT, v.unshared_curve, v.unshared_sharing),
        "NoFeeSharing",
    );
    assert_eq!(env.game_state().official, None);
}

#[test]
fn recheck_clears_only_a_token_that_stopped_passing() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();
    expect(env.recheck(v.curve, v.sharing), "NoToken");

    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    let token = Some(OfficialToken { mint: PUMP_MINT, venue: Venue::PumpFun });
    let size = env.data(&env.game).len();

    // The right accounts, still passing: nothing changes.
    env.recheck(v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official, token);

    // Wrong accounts never clear a passing token. Each of these is an error.
    let empty = Pubkey::new_unique();
    let mut look_alike = fixture("venue/pump-shared-sharing").data;
    look_alike[loot::venue::SHARING_ADMIN_REVOKED] = 0;
    let fake = Pubkey::new_unique();
    env.put(fake, loot::PUMP_FEES_ID, look_alike);
    // A non-canonical bump of the same seeds: another address, with nothing at it.
    let (_, bump) = Pubkey::find_program_address(&[loot::venue::SHARING_SEED, PUMP_MINT.as_ref()], &loot::PUMP_FEES_ID);
    let off_bump = (0..bump)
        .rev()
        .find_map(|b| Pubkey::create_program_address(&[loot::venue::SHARING_SEED, PUMP_MINT.as_ref(), &[b]], &loot::PUMP_FEES_ID).ok())
        .unwrap();
    for (a, b) in [
        (v.curve, empty),            // "there is no sharing config"
        (v.curve, fake),             // "the admin is not revoked"
        (v.curve, off_bump),         // "there is no sharing config", at a look-alike PDA
        (v.curve, v.unshared_sharing),
        (v.unshared_curve, v.sharing), // "the curve pays someone else"
        (empty, v.sharing),          // "there is no curve"
        (v.pool100, v.config100),    // a failing Meteora launch
        (v.sharing, v.curve),
    ] {
        expect(env.recheck(a, b), "VenueAccounts");
        assert_eq!(env.game_state().official, token);
    }

    // pump.fun's admin resets the sharing config (a community takeover): the real account, at
    // its real address, no longer passes. Anyone clears the token.
    let mut reset = fixture("venue/pump-shared-sharing").data;
    let holders = loot::venue::SHARING_HOLDERS;
    reset[holders..holders + 32].copy_from_slice(Pubkey::new_unique().as_ref());
    reset[holders + 34..holders + 66].copy_from_slice(Pubkey::new_unique().as_ref());
    env.put(v.sharing, loot::PUMP_FEES_ID, reset);
    let holder = env.cranker.pubkey();
    let before = (env.lamports(&env.game), env.lamports(&holder));
    let logs = env.recheck(v.curve, v.sharing).unwrap();
    assert!(has_event(&logs));
    assert_eq!(env.game_state().official, None);
    // No lamports leave the game in a permissionless call (the caller only paid the tx fee),
    // and the 33 bytes are given back at the creator's next update.
    assert_eq!(env.lamports(&env.game), before.0);
    assert!(env.lamports(&holder) <= before.1);
    assert_eq!(env.data(&env.game).len(), size);
    expect(env.recheck(v.curve, v.sharing), "NoToken");
    let sol = env.lamports(&c.pubkey());
    env.update_game(&c, GameUpdate { authority: None, paused: None }).unwrap();
    assert_eq!(env.data(&env.game).len(), size - 33);
    assert_eq!(env.lamports(&env.game), env.rent(size - 33));
    assert!(env.lamports(&c.pubkey()) > sol, "rent came back");

    // The cleared token cannot be attached again while it fails.
    expect(env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "ShareholdersMismatch");
}

#[test]
fn recheck_each_pump_rule_and_a_meteora_token() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();
    let good = fixture("venue/pump-shared-sharing").data;

    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<u8>)>)> = vec![
        ("paused", Box::new(|d| d[loot::venue::SHARING_STATUS] = 0)),
        ("admin back", Box::new(|d| d[loot::venue::SHARING_ADMIN_REVOKED] = 0)),
        ("96/4", Box::new(|d| {
            let h = loot::venue::SHARING_HOLDERS;
            d[h + 32..h + 34].copy_from_slice(&9_600u16.to_le_bytes());
            d[h + 66..h + 68].copy_from_slice(&400u16.to_le_bytes());
        })),
        ("a third holder", Box::new(|d| d[loot::venue::SHARING_COUNT] = 3)),
    ];
    for (what, change) in cases {
        env.put(v.sharing, loot::PUMP_FEES_ID, good.clone());
        env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
        let mut d = good.clone();
        change(&mut d);
        env.put(v.sharing, loot::PUMP_FEES_ID, d);
        env.recheck(v.curve, v.sharing).unwrap();
        assert_eq!(env.game_state().official, None, "{what}");
    }
    // The curve paying the launcher directly again.
    env.put(v.sharing, loot::PUMP_FEES_ID, good.clone());
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    let mut curve = fixture("venue/pump-shared-curve").data;
    curve[loot::venue::CURVE_CREATOR..loot::venue::CURVE_CREATOR + 32].copy_from_slice(LAUNCHER.as_ref());
    env.put(v.curve, loot::PUMP_ID, curve);
    env.recheck(v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official, None);
    env.load("venue/pump-shared-curve");

    // A sharing config in a layout version this program has not seen: it cannot tell, so it
    // neither attaches nor clears.
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    let mut d = good.clone();
    d[loot::venue::SHARING_VERSION] = 3;
    env.put(v.sharing, loot::PUMP_FEES_ID, d);
    expect(env.recheck(v.curve, v.sharing), "VenueLayout");
    assert!(env.game_state().official.is_some());
    env.put(v.sharing, loot::PUMP_FEES_ID, good);

    // Meteora: replace the token, then recheck with other accounts and with its own.
    env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config).unwrap();
    let token = Some(OfficialToken { mint: METEORA_MINT, venue: Venue::Meteora });
    assert_eq!(env.game_state().official, token);
    for (a, b) in [(v.pool100, v.config100), (v.pool, v.config100), (v.curve, v.sharing), (v.config, v.pool)] {
        expect(env.recheck(a, b), "VenueAccounts");
        assert_eq!(env.game_state().official, token);
    }
    env.recheck(v.pool, v.config).unwrap();
    assert_eq!(env.game_state().official, token);
    // A suspended game keeps its record and can still be rechecked.
    let a = env.admin.insecure_clone();
    env.set_suspended(&a, true).unwrap();
    env.recheck(v.pool, v.config).unwrap();
    assert_eq!(env.game_state().official, token);
}

/// The 95/5 split: games.fun takes at least 5% of the token fees of a token launched with it,
/// the launcher at most 95%. The real
/// fixtures are 50/50 launches from before, which still pass; these are the same accounts with
/// the split's bytes rewritten.
#[test]
fn a_95_5_launch_attaches_and_one_below_it_does_not() {
    let mut env = setup();
    let v = venues(&mut env);
    let c = env.creator.insecure_clone();
    let good_config = fixture("venue/meteora-official-config").data;
    let good_sharing = fixture("venue/pump-shared-sharing").data;
    let (fee, lp, migration) = (
        loot::venue::CONFIG_CREATOR_FEE_PERCENT,
        loot::venue::CONFIG_PARTNER_LOCKED_LP_PERCENT,
        loot::venue::CONFIG_CREATOR_MIGRATION_FEE_PERCENT,
    );
    assert_eq!((good_config[fee], good_config[lp]), (50, 50), "the real launch is 50/50");

    // Meteora at 95/5: creator 95% of the trading fee and of a migration fee, 5% locked to us.
    let mut d = good_config.clone();
    d[fee] = 95;
    d[lp] = 5;
    d[247] = 10;
    d[migration] = 95;
    env.put(v.config, DBC, d.clone());
    env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config).unwrap();
    assert_eq!(env.game_state().official, Some(OfficialToken { mint: METEORA_MINT, venue: Venue::Meteora }));
    env.recheck(v.pool, v.config).unwrap();
    assert!(env.game_state().official.is_some());
    // One point past each bound: refused at attach, cleared at recheck.
    for (what, at, value) in [("CreatorFeeTooHigh", fee, 96u8), ("PartnerLockTooLow", lp, 4), ("CreatorMigrationFeeTooHigh", migration, 96)] {
        let mut bad = d.clone();
        bad[at] = value;
        env.put(v.config, DBC, bad);
        expect(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config), what);
        env.recheck(v.pool, v.config).unwrap();
        assert_eq!(env.game_state().official, None, "{what}");
        env.put(v.config, DBC, d.clone());
        env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, v.pool, v.config).unwrap();
    }
    env.put(v.config, DBC, good_config);

    // pump.fun: launcher 9500 + partner 500 attaches; 9600 + 400 does not, and is cleared.
    let h = loot::venue::SHARING_HOLDERS;
    let split = |launcher: u16, partner: u16| {
        let mut d = good_sharing.clone();
        d[h + 32..h + 34].copy_from_slice(&launcher.to_le_bytes());
        d[h + 66..h + 68].copy_from_slice(&partner.to_le_bytes());
        d
    };
    env.put(v.sharing, loot::PUMP_FEES_ID, split(9_500, 500));
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official, Some(OfficialToken { mint: PUMP_MINT, venue: Venue::PumpFun }));
    env.recheck(v.curve, v.sharing).unwrap();
    assert!(env.game_state().official.is_some());
    env.put(v.sharing, loot::PUMP_FEES_ID, split(9_600, 400));
    env.recheck(v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official, None);
    expect(env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "ShareholdersMismatch");
    // The partner twice: no launcher to name.
    let mut twice = split(9_500, 500);
    twice[h..h + 32].copy_from_slice(PARTNER.as_ref());
    env.put(v.sharing, loot::PUMP_FEES_ID, twice);
    expect(env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing), "ShareholdersMismatch");
    // The real 50/50 coin still attaches.
    env.put(v.sharing, loot::PUMP_FEES_ID, good_sharing);
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, v.curve, v.sharing).unwrap();
    assert_eq!(env.game_state().official.unwrap().mint, PUMP_MINT);
}

/// M3, fixed for the settings confirmed to route value around the split (see the Resolution
/// section of the review for the venue source behind each): a Meteora config whose creator
/// takes more than its share of the migration fee (50% then, 95% since 2026-10-12), or whose
/// migrated pool compounds its fees; a
/// pump.fun cashback or holder-rewards coin. None of them attaches, and a token that turns into
/// one is cleared by `recheck_token`.
#[test]
fn attach_refuses_launches_whose_other_settings_bypass_the_split() {
    let mut env = setup();
    let c = env.creator.insecure_clone();
    let pool = env.load("venue/meteora-official-pool");
    let good = fixture("venue/meteora-official-config");
    let mut config = fixture("venue/meteora-official-config");
    assert_eq!((config.data[247], config.data[248]), (0, 0));
    config.data[247] = 99; // migration_fee_percentage (SDK MAX_MIGRATION_FEE_PERCENTAGE)
    config.data[248] = 100; // creator_migration_fee_percentage
    config.data[240] = 0; // partner_liquidity_percentage
    env.put(config.key, DBC, config.data.clone());
    assert!(err(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config.key)).contains("CreatorMigrationFeeTooHigh"));
    assert_eq!(env.game_state().official, None);
    // The same 99% fee shared within the split (the creator at most 95%), in cash: it passes.
    // 96% does not.
    config.data[248] = 96;
    env.put(config.key, DBC, config.data.clone());
    assert!(err(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config.key)).contains("CreatorMigrationFeeTooHigh"));
    for creator in [50, 95] {
        config.data[248] = creator;
        env.put(config.key, DBC, config.data.clone());
        env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config.key).unwrap();
        env.recheck(pool, config.key).unwrap();
        assert!(env.game_state().official.is_some(), "{creator}");
    }
    // A migrated pool that compounds its fees.
    let mut compounding = good.data.clone();
    compounding[360] = 2;
    compounding[366..368].copy_from_slice(&10_000u16.to_le_bytes());
    env.put(config.key, DBC, compounding);
    env.recheck(pool, config.key).unwrap();
    assert_eq!(env.game_state().official, None, "recheck applies the same rules");
    assert!(err(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config.key)).contains("CompoundingFees"));
    // The real config, untouched, still attaches.
    env.put(config.key, DBC, good.data);
    env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config.key).unwrap();

    let real = fixture("venue/pump-shared-curve");
    let sharing = env.load("venue/pump-shared-sharing");
    assert_eq!((real.data[82], real.data[124]), (0, 0));
    for flag in [82usize, 124] {
        let mut curve = real.data.clone();
        curve[flag] = 1; // is_cashback_coin, is_holder_reward
        env.put(real.key, loot::PUMP_ID, curve);
        assert!(err(env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, real.key, sharing)).contains("CreatorFeeDiverted"));
        assert_eq!(env.game_state().official.unwrap().mint, METEORA_MINT);
    }
    // The real coin attaches; pump.fun's admin later turns it into a holder-rewards coin
    // (a community takeover); anyone clears the token.
    env.put(real.key, loot::PUMP_ID, real.data.clone());
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, real.key, sharing).unwrap();
    let mut taken_over = real.data.clone();
    taken_over[124] = 1;
    env.put(real.key, loot::PUMP_ID, taken_over);
    env.recheck(real.key, sharing).unwrap();
    assert_eq!(env.game_state().official, None);
}

/// LOW, closed. Any game admin could replace the game's official token, with the signature of
/// whoever launched the replacement. A game has no admins any more: only its owner can.
#[test]
fn only_the_games_owner_replaces_the_official_token() {
    let mut env = setup();
    let c = env.creator.insecure_clone();
    let helper = funded_kp(&mut env, 61);
    let pool = env.load("venue/meteora-official-pool");
    let config = env.load("venue/meteora-official-config");
    let curve = env.load("venue/pump-shared-curve");
    let sharing = env.load("venue/pump-shared-sharing");
    env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config).unwrap();
    expect(env.attach(&helper, LAUNCHER, Venue::PumpFun, PUMP_MINT, curve, sharing), "NotOwner");
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, curve, sharing).unwrap();
    assert_eq!(env.game_state().official.unwrap().mint, PUMP_MINT);
}

/// The registry: a stranger cannot attach, the launcher alone cannot attach to a game it does
/// not administer, and no choice of accounts clears a passing token.
#[test]
fn attach_and_recheck_resist_a_strangers_accounts() {
    let mut env = setup();
    let c = env.creator.insecure_clone();
    let s = funded_kp(&mut env, 57);
    let pool = env.load("venue/meteora-official-pool");
    let config = env.load("venue/meteora-official-config");
    let pool100 = env.load("venue/meteora-creator100-pool");
    let config100 = env.load("venue/meteora-creator100-config");
    let curve = env.load("venue/pump-shared-curve");
    let sharing = env.load("venue/pump-shared-sharing");

    // The launcher (signature assumed) without a game admin; a game admin with itself as the
    // launcher.
    assert!(env.attach(&s, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config).is_err());
    assert!(env.attach(&c, c.pubkey(), Venue::Meteora, METEORA_MINT, pool, config).is_err());
    // A look-alike pool: the right bytes under another owner, then the right owner at the
    // right length with the base mint rewritten (which only DBC could write).
    let real = fixture("venue/meteora-official-pool");
    let fake = Pubkey::new_unique();
    env.put(fake, s.pubkey(), real.data.clone());
    assert!(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, fake, config).is_err());
    // A look-alike config under another owner, named by nothing.
    let cfg = fixture("venue/meteora-official-config");
    let fake_cfg = Pubkey::new_unique();
    env.put(fake_cfg, DBC, cfg.data.clone());
    assert!(env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, fake_cfg).is_err());

    env.attach(&c, LAUNCHER, Venue::Meteora, METEORA_MINT, pool, config).unwrap();
    let official = env.game_state().official;
    // Every pair a stranger could offer to clear it: a failing launch's accounts, a mix, pump
    // accounts, empty accounts, the game itself.
    let empty = Pubkey::new_unique();
    for (a, b) in [(pool100, config100), (pool, config100), (pool100, config), (curve, sharing), (empty, empty), (config, pool), (env.game, env.game), (fake, config), (pool, fake_cfg)] {
        let _ = env.recheck(a, b);
        assert_eq!(env.game_state().official, official);
    }
    // pump.fun: the two addresses are derived from the recorded mint, so nothing else is read.
    env.attach(&c, LAUNCHER, Venue::PumpFun, PUMP_MINT, curve, sharing).unwrap();
    let official = env.game_state().official;
    let unshared = env.load("venue/pump-unshared-curve");
    for (a, b) in [(unshared, sharing), (curve, empty), (empty, sharing), (pool, config), (pool100, config100), (sharing, curve)] {
        assert!(env.recheck(a, b).is_err());
        assert_eq!(env.game_state().official, official);
    }
}
