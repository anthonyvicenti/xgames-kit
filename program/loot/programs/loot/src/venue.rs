//! Reads a launch venue's own accounts and decides whether a mint is a games.fun launch that
//! pays the split. The same rules as the website's `launch/official.mjs`, enforced on chain.
//!
//! This is a record, not a gate: a token launched anywhere else is welcome in the ecosystem
//! (every economy instruction takes any mint). Passing here only shows the token was launched
//! with games.fun and pays games.fun its share.
//!
//! Every number is a bound, so a launch that gives games.fun more than its share also passes.
//! The rules, and why each is there (sources in `REVIEW-2026-10-10.md`, "Resolution"):
//! - Meteora: the fee claimer is the partner; the creator's share of the trading fee is at most
//!   `MAX_CREATOR_FEE_PERCENT` (95%); at least `MIN_PARTNER_LOCKED_LP_PERCENT` (5%) of the
//!   migrated pool's liquidity is permanently locked to the partner; the creator's share of the
//!   migration fee (a cut of the raise, taken in cash before any liquidity exists) is at most
//!   `MAX_CREATOR_FEE_PERCENT`; the migrated pool does not compound its fees (compounded fees are
//!   never paid out, they grow the liquidity, which a locked position cannot withdraw and an
//!   unlocked one can).
//! - pump.fun: the curve pays the mint's fee-sharing config, which is active, final, and holds
//!   exactly two shareholders, the partner with at least `MIN_PARTNER_SHARE_BPS` (5%) and the
//!   launcher with the rest (or the partner alone, at 100%, for its own launch); the coin is not
//!   a cashback or holder-rewards coin (their creator fee goes to traders or holders whatever the
//!   curve's `creator` says).
//!
//! No venue crate is linked, to keep the binary small: accounts are read at byte offsets, each one
//! behind an owner, discriminator and length check. Every offset below is derived from the
//! venue's IDL (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12, IDL 0.2.1; `@pump-fun/pump-sdk`
//! 4.0.0) and proven against real devnet account bytes in the tests at the end of this file
//! (`tests/fixtures/venue/`).
//!
//! Three outcomes, kept apart on purpose:
//! - `Err`: the accounts handed in are not provably the venue's accounts for this mint, or are
//!   in a layout this program does not know. Nothing can be concluded, so nothing is written:
//!   `attach_token` fails and `recheck_token` fails WITHOUT clearing.
//! - `Ok(Fail(reason))`: they are the venue's accounts for this mint, and a rule is broken.
//! - `Ok(Pass(launcher))`: every rule holds; `launcher` is the wallet that must sign to attach.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::LootError;
use crate::state::Venue;

/// What the checks need of an account. Built from an `AccountInfo` on chain and from a fixture
/// in the unit tests.
pub struct Acct<'a> {
    pub key: &'a Pubkey,
    pub owner: &'a Pubkey,
    pub data: &'a [u8],
}

#[derive(Debug)]
pub enum Verdict {
    Pass(Pubkey),
    Fail(LootError),
}

impl PartialEq for Verdict {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Verdict::Pass(a), Verdict::Pass(b)) => a == b,
            (Verdict::Fail(a), Verdict::Fail(b)) => *a as u32 == *b as u32,
            _ => false,
        }
    }
}

// Meteora DBC `VirtualPool` (bytemuck, repr(C)): 8 discriminator + PoolState { volatility_tracker
// (64), config, creator, base_mint, ... } = 424 bytes.
pub const POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const POOL_LEN: usize = 424;
pub const POOL_CONFIG: usize = 72;
pub const POOL_CREATOR: usize = 104;
pub const POOL_BASE_MINT: usize = 136;

// Meteora DBC `PoolConfig` (bytemuck, repr(C)): 8 + quote_mint, fee_claimer, ... = 1048 bytes.
pub const CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const CONFIG_LEN: usize = 1048;
pub const CONFIG_FEE_CLAIMER: usize = 40;
pub const CONFIG_PARTNER_LOCKED_LP_PERCENT: usize = 239;
pub const CONFIG_CREATOR_FEE_PERCENT: usize = 245;
/// `creator_migration_fee_percentage`: the creator's share of `migration_fee_percentage` (247).
pub const CONFIG_CREATOR_MIGRATION_FEE_PERCENT: usize = 248;
/// `migrated_compounding_fee_bps` (u16). Non-zero exactly when `migrated_collect_fee_mode`
/// (360) is 2, Compounding: DBC refuses any other combination when the config is created.
pub const CONFIG_MIGRATED_COMPOUNDING_FEE_BPS: usize = 366;

// pump.fun `BondingCurve` (borsh): 8 + five u64 + complete: bool + creator: pubkey + ...
// pump.fun appends fields over time, so only the prefix up to `creator` is required.
pub const CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
pub const CURVE_CREATOR: usize = 49;
pub const CURVE_MIN_LEN: usize = CURVE_CREATOR + 32;
/// `is_cashback_coin` and `is_holder_reward`. Curves written before these fields existed are
/// shorter; a byte that is not there is read as false.
pub const CURVE_IS_CASHBACK: usize = 82;
pub const CURVE_IS_HOLDER_REWARD: usize = 124;
pub const CURVE_SEED: &[u8] = b"bonding-curve";

// pump.fun fee program `SharingConfig` (borsh): 8 + bump, version, status, mint, admin,
// admin_revoked, shareholders: Vec<{ address: pubkey, share_bps: u16 }>.
pub const SHARING_DISCRIMINATOR: [u8; 8] = [216, 74, 9, 0, 56, 140, 93, 75];
pub const SHARING_VERSION: usize = 9;
pub const SHARING_STATUS: usize = 10;
pub const SHARING_MINT: usize = 11;
pub const SHARING_ADMIN_REVOKED: usize = 75;
pub const SHARING_COUNT: usize = 76;
pub const SHARING_HOLDERS: usize = 80;
pub const SHAREHOLDER_LEN: usize = 34;
/// The only layout version seen (and proven) so far. Another one is "cannot tell", not "fails".
pub const SHARING_KNOWN_VERSION: u8 = 2;
pub const SHARING_STATUS_ACTIVE: u8 = 1;
pub const SHARING_SEED: &[u8] = b"sharing-config";

fn key_at(data: &[u8], offset: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

fn is(acct: &Acct, program: &Pubkey, discriminator: &[u8; 8]) -> bool {
    acct.owner == program && acct.data.len() >= 8 && acct.data[..8] == discriminator[..]
}

pub fn judge(venue: Venue, mint: &Pubkey, partner: &Pubkey, a: &Acct, b: &Acct) -> Result<Verdict> {
    match venue {
        Venue::Meteora => meteora(mint, partner, a, b),
        Venue::PumpFun => pump(mint, partner, a, b),
    }
}

/// `pool`: the DBC virtual pool whose base mint is `mint`; `config`: that pool's config.
///
/// A pool cannot be derived from the mint alone (its seeds include the config and the quote
/// mint), and it does not need to be: DBC creates the base mint inside pool creation (the mint
/// signs `initialize_virtual_pool_*`), so the one `VirtualPool` the DBC program owns with this
/// base mint IS the mint's pool. The config is then named by the pool itself.
fn meteora(mint: &Pubkey, partner: &Pubkey, pool: &Acct, config: &Acct) -> Result<Verdict> {
    require!(
        is(pool, &METEORA_DBC_ID, &POOL_DISCRIMINATOR),
        LootError::VenueAccounts
    );
    require!(pool.data.len() == POOL_LEN, LootError::VenueLayout);
    require!(key_at(pool.data, POOL_BASE_MINT) == Some(*mint), LootError::VenueAccounts);
    require!(key_at(pool.data, POOL_CONFIG) == Some(*config.key), LootError::VenueAccounts);
    // From here `config` is the address the mint's own pool names. DBC only ever puts a
    // PoolConfig there, so anything else is a layout we do not know.
    require!(
        is(config, &METEORA_DBC_ID, &CONFIG_DISCRIMINATOR) && config.data.len() == CONFIG_LEN,
        LootError::VenueLayout
    );
    let launcher = key_at(pool.data, POOL_CREATOR).ok_or(LootError::VenueLayout)?;

    if key_at(config.data, CONFIG_FEE_CLAIMER) != Some(*partner) {
        return Ok(Verdict::Fail(LootError::FeeClaimerNotPartner));
    }
    if config.data[CONFIG_CREATOR_FEE_PERCENT] > MAX_CREATOR_FEE_PERCENT {
        return Ok(Verdict::Fail(LootError::CreatorFeeTooHigh));
    }
    if config.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] < MIN_PARTNER_LOCKED_LP_PERCENT {
        return Ok(Verdict::Fail(LootError::PartnerLockTooLow));
    }
    // DBC forces this to 0 when there is no migration fee, so the one byte is the whole rule.
    if config.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] > MAX_CREATOR_FEE_PERCENT {
        return Ok(Verdict::Fail(LootError::CreatorMigrationFeeTooHigh));
    }
    if config.data[CONFIG_MIGRATED_COMPOUNDING_FEE_BPS] != 0
        || config.data[CONFIG_MIGRATED_COMPOUNDING_FEE_BPS + 1] != 0
    {
        return Ok(Verdict::Fail(LootError::CompoundingFees));
    }
    Ok(Verdict::Pass(launcher))
}

/// `curve` and `sharing` must be the mint's two pump.fun PDAs, derived here with their
/// canonical bumps. That is what makes "the account is missing or is something else" a fact
/// about the mint and not about what the caller chose to pass.
fn pump(mint: &Pubkey, partner: &Pubkey, curve: &Acct, sharing: &Acct) -> Result<Verdict> {
    let (curve_key, _) = Pubkey::find_program_address(&[CURVE_SEED, mint.as_ref()], &PUMP_ID);
    let (sharing_key, _) =
        Pubkey::find_program_address(&[SHARING_SEED, mint.as_ref()], &PUMP_FEES_ID);
    require!(
        *curve.key == curve_key && *sharing.key == sharing_key,
        LootError::VenueAccounts
    );

    if !is(curve, &PUMP_ID, &CURVE_DISCRIMINATOR) {
        return Ok(Verdict::Fail(LootError::NoBondingCurve));
    }
    require!(curve.data.len() >= CURVE_MIN_LEN, LootError::VenueLayout);
    if !is(sharing, &PUMP_FEES_ID, &SHARING_DISCRIMINATOR) {
        return Ok(Verdict::Fail(LootError::NoFeeSharing));
    }
    let d = sharing.data;
    require!(
        d.len() >= SHARING_HOLDERS && d[SHARING_VERSION] == SHARING_KNOWN_VERSION,
        LootError::VenueLayout
    );
    // The fee program writes a config for a mint only at that mint's address.
    require!(key_at(d, SHARING_MINT) == Some(*mint), LootError::VenueLayout);

    // After fee sharing the curve's creator is the sharing config: every creator fee goes
    // through the split.
    if key_at(curve.data, CURVE_CREATOR) != Some(sharing_key) {
        return Ok(Verdict::Fail(LootError::CurveNotSharing));
    }
    let flag = |at: usize| curve.data.get(at).is_some_and(|b| *b != 0);
    if flag(CURVE_IS_CASHBACK) || flag(CURVE_IS_HOLDER_REWARD) {
        return Ok(Verdict::Fail(LootError::CreatorFeeDiverted));
    }
    if d[SHARING_STATUS] != SHARING_STATUS_ACTIVE {
        return Ok(Verdict::Fail(LootError::SharingNotActive));
    }
    // Final: the launcher can no longer rewrite the shareholders. (pump.fun's own admin still
    // can, in a community takeover; that is what `recheck_token` is for.)
    if d[SHARING_ADMIN_REVOKED] != 1 {
        return Ok(Verdict::Fail(LootError::SharingAdminNotRevoked));
    }

    let count = u32::from_le_bytes([
        d[SHARING_COUNT],
        d[SHARING_COUNT + 1],
        d[SHARING_COUNT + 2],
        d[SHARING_COUNT + 3],
    ]) as usize;
    let holder = |i: usize| -> Option<(Pubkey, u16)> {
        let at = SHARING_HOLDERS + i * SHAREHOLDER_LEN;
        let key = key_at(d, at)?;
        let bps = d.get(at + 32..at + 34)?;
        Some((key, u16::from_le_bytes([bps[0], bps[1]])))
    };
    let launcher = match count {
        // A launch by the partner wallet itself keeps the whole fee (pump.fun refuses
        // duplicate shareholders).
        1 => match holder(0).ok_or(LootError::VenueLayout)? {
            (key, 10_000) if key == *partner => Some(key),
            _ => None,
        },
        // The partner and the launcher, in either order: the partner at least its share, the
        // launcher the rest. A duplicate (the partner twice, or neither) names no launcher.
        2 => {
            let x = holder(0).ok_or(LootError::VenueLayout)?;
            let y = holder(1).ok_or(LootError::VenueLayout)?;
            let (p, l) = if x.0 == *partner && y.0 != *partner {
                (x, y)
            } else if y.0 == *partner && x.0 != *partner {
                (y, x)
            } else {
                return Ok(Verdict::Fail(LootError::ShareholdersMismatch));
            };
            let whole = p.1 as u64 + l.1 as u64 == BPS;
            (p.1 >= MIN_PARTNER_SHARE_BPS && whole).then_some(l.0)
        }
        _ => None,
    };
    Ok(match launcher {
        Some(key) => Verdict::Pass(key),
        None => Verdict::Fail(LootError::ShareholdersMismatch),
    })
}

/// Real devnet accounts, dumped by `scripts/fetch-fixtures.sh venue` on 2026-10-10. These tests
/// are the proof of every offset above.
#[cfg(test)]
pub mod fixtures {
    use super::*;
    use base64::Engine;

    pub const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/venue");
    pub const PARTNER: Pubkey = pubkey!("8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV");
    /// `test-creator`, the wallet that launched every games.fun fixture.
    pub const LAUNCHER: Pubkey = pubkey!("7eqbK77uXxrZmd8gi6wGogYgQ6Ks9BH8PLhEA3vtUHy4");
    pub const METEORA_MINT: Pubkey = pubkey!("CCpfeJP4nyeJm2s9Fk6poN8t8d7hGvrJRvMU3EM2hF31");
    pub const METEORA_100_MINT: Pubkey = pubkey!("GV6AXgb5Q6yCijeYetskPLzPUqqnq3rYYScrQ7rhGjRV");
    pub const PUMP_MINT: Pubkey = pubkey!("FYAtGGoi1X1psUB2aqxVFkBSeEcqGv8GpVaGqpuCYyVX");
    pub const PUMP_UNSHARED_MINT: Pubkey = pubkey!("H7WMLJ1T6Vu1aLhg4ABE7qnAGoRc24DPRsZ2g7mDgNR6");
    pub const PLAIN_MINT: Pubkey = pubkey!("FNdYk3az9KtB1GaRWq6yRtoCmS79bqYhpDKdt1xyexvq");

    pub struct Fixture {
        pub key: Pubkey,
        pub owner: Pubkey,
        pub data: Vec<u8>,
    }
    impl Fixture {
        pub fn load(name: &str) -> Self {
            let text = std::fs::read_to_string(format!("{DIR}/{name}.json")).expect("venue fixture");
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            Fixture {
                key: v["pubkey"].as_str().unwrap().parse().unwrap(),
                owner: v["account"]["owner"].as_str().unwrap().parse().unwrap(),
                data: base64::engine::general_purpose::STANDARD
                    .decode(v["account"]["data"][0].as_str().unwrap())
                    .unwrap(),
            }
        }
        /// An address nothing lives at: the system program owns it and it has no data.
        pub fn missing(key: Pubkey) -> Self {
            Fixture { key, owner: Pubkey::default(), data: vec![] }
        }
        pub fn acct(&self) -> Acct<'_> {
            Acct { key: &self.key, owner: &self.owner, data: &self.data }
        }
    }
    pub fn curve_key(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[CURVE_SEED, mint.as_ref()], &PUMP_ID).0
    }
    pub fn sharing_key(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[SHARING_SEED, mint.as_ref()], &PUMP_FEES_ID).0
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn err(r: Result<Verdict>) -> String {
        format!("{:?}", r.unwrap_err())
    }
    fn met(mint: &Pubkey, pool: &Fixture, config: &Fixture) -> Result<Verdict> {
        judge(Venue::Meteora, mint, &PARTNER, &pool.acct(), &config.acct())
    }
    fn pmp(mint: &Pubkey, curve: &Fixture, sharing: &Fixture) -> Result<Verdict> {
        judge(Venue::PumpFun, mint, &PARTNER, &curve.acct(), &sharing.acct())
    }

    #[test]
    fn meteora_offsets_against_real_accounts() {
        let pool = Fixture::load("meteora-official-pool");
        let config = Fixture::load("meteora-official-config");
        assert_eq!(pool.owner, METEORA_DBC_ID);
        assert_eq!(pool.data.len(), POOL_LEN);
        assert_eq!(pool.data[..8], POOL_DISCRIMINATOR);
        assert_eq!(key_at(&pool.data, POOL_BASE_MINT), Some(METEORA_MINT));
        assert_eq!(key_at(&pool.data, POOL_CONFIG), Some(config.key));
        assert_eq!(key_at(&pool.data, POOL_CREATOR), Some(LAUNCHER));
        assert_eq!(config.owner, METEORA_DBC_ID);
        assert_eq!(config.data.len(), CONFIG_LEN);
        assert_eq!(config.data[..8], CONFIG_DISCRIMINATOR);
        assert_eq!(key_at(&config.data, CONFIG_FEE_CLAIMER), Some(PARTNER));
        assert_eq!(config.data[CONFIG_CREATOR_FEE_PERCENT], 50);
        assert_eq!(config.data[CONFIG_PARTNER_LOCKED_LP_PERCENT], 50);
        // The same two bytes in the config that the website's check reads as 100 and 50.
        let c100 = Fixture::load("meteora-creator100-config");
        assert_eq!(c100.data[CONFIG_CREATOR_FEE_PERCENT], 100);
        assert_eq!(c100.data[CONFIG_PARTNER_LOCKED_LP_PERCENT], 50);
    }

    #[test]
    fn meteora_official_passes_and_names_the_launcher() {
        let pool = Fixture::load("meteora-official-pool");
        let config = Fixture::load("meteora-official-config");
        assert_eq!(met(&METEORA_MINT, &pool, &config).unwrap(), Verdict::Pass(LAUNCHER));
    }

    #[test]
    fn meteora_creator_at_100_percent_fails() {
        let pool = Fixture::load("meteora-creator100-pool");
        let config = Fixture::load("meteora-creator100-config");
        assert_eq!(
            met(&METEORA_100_MINT, &pool, &config).unwrap(),
            Verdict::Fail(LootError::CreatorFeeTooHigh)
        );
    }

    #[test]
    fn meteora_rule_by_rule() {
        let pool = Fixture::load("meteora-official-pool");
        let config = Fixture::load("meteora-official-config");
        // Another partner: the fee claimer no longer matches.
        let other = Pubkey::new_unique();
        assert_eq!(
            judge(Venue::Meteora, &METEORA_MINT, &other, &pool.acct(), &config.acct()).unwrap(),
            Verdict::Fail(LootError::FeeClaimerNotPartner)
        );
        // The real config is 50/50, from before the split became 95/5: it is inside the bounds.
        let mut c = Fixture::load("meteora-official-config");
        c.data[CONFIG_CREATOR_FEE_PERCENT] = 96;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::CreatorFeeTooHigh));
        c.data[CONFIG_CREATOR_FEE_PERCENT] = 95;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));
        c.data[CONFIG_CREATOR_FEE_PERCENT] = 0;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));
        c.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] = 4;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::PartnerLockTooLow));
        c.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] = 0;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::PartnerLockTooLow));
        c.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] = 5;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));
        c.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] = 100;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));

        // The migration fee: any size is fine while the creator takes at most 95% of it.
        let mut c = Fixture::load("meteora-official-config");
        assert_eq!((c.data[247], c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT]), (0, 0), "ours take none");
        c.data[247] = 99;
        c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] = 50;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));
        c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] = 95;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));
        c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] = 96;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::CreatorMigrationFeeTooHigh));
        c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] = 100;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::CreatorMigrationFeeTooHigh));

        // A whole 95/5 launch: creator 95% of the trading fee and of the migration fee, 5% of
        // the liquidity locked to the partner.
        let mut c = Fixture::load("meteora-official-config");
        c.data[CONFIG_CREATOR_FEE_PERCENT] = 95;
        c.data[CONFIG_PARTNER_LOCKED_LP_PERCENT] = 5;
        c.data[247] = 10;
        c.data[CONFIG_CREATOR_MIGRATION_FEE_PERCENT] = 95;
        assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Pass(LAUNCHER));

        // A migrated pool that compounds its fees, at any rate (the rate is a u16).
        for bps in [1u16, 255, 256, 10_000] {
            let mut c = Fixture::load("meteora-official-config");
            assert_eq!((c.data[360], c.data[366], c.data[367]), (0, 0, 0), "ours do not compound");
            c.data[360] = 2;
            c.data[CONFIG_MIGRATED_COMPOUNDING_FEE_BPS..CONFIG_MIGRATED_COMPOUNDING_FEE_BPS + 2].copy_from_slice(&bps.to_le_bytes());
            assert_eq!(met(&METEORA_MINT, &pool, &c).unwrap(), Verdict::Fail(LootError::CompoundingFees), "{bps}");
        }
    }

    #[test]
    fn meteora_wrong_accounts_are_errors_not_verdicts() {
        let pool = Fixture::load("meteora-official-pool");
        let config = Fixture::load("meteora-official-config");
        let pool100 = Fixture::load("meteora-creator100-pool");
        let config100 = Fixture::load("meteora-creator100-config");
        // A pool for another mint.
        assert!(err(met(&METEORA_MINT, &pool100, &config100)).contains("VenueAccounts"));
        // A config from another pool (a failing one must not be usable to fail a passing token,
        // a passing one must not be usable to pass a failing token).
        assert!(err(met(&METEORA_MINT, &pool, &config100)).contains("VenueAccounts"));
        assert!(err(met(&METEORA_100_MINT, &pool100, &config)).contains("VenueAccounts"));
        // The same bytes under another owner.
        let mut fake = Fixture::load("meteora-official-pool");
        fake.owner = Pubkey::new_unique();
        assert!(err(met(&METEORA_MINT, &fake, &config)).contains("VenueAccounts"));
        // Swapped, missing, another account type of the same program, a plain mint.
        assert!(err(met(&METEORA_MINT, &config, &pool)).contains("VenueAccounts"));
        assert!(err(met(&METEORA_MINT, &Fixture::missing(pool.key), &config)).contains("VenueAccounts"));
        let mint = Fixture::load("plain-mint");
        assert!(err(met(&PLAIN_MINT, &mint, &config)).contains("VenueAccounts"));
        // A pool of a length we do not know.
        let mut long = Fixture::load("meteora-official-pool");
        long.data.push(0);
        assert!(err(met(&METEORA_MINT, &long, &config)).contains("VenueLayout"));
    }

    #[test]
    fn pump_offsets_against_real_accounts() {
        let curve = Fixture::load("pump-shared-curve");
        let sharing = Fixture::load("pump-shared-sharing");
        assert_eq!(curve.key, curve_key(&PUMP_MINT), "the SDK's bondingCurvePda");
        assert_eq!(sharing.key, sharing_key(&PUMP_MINT), "the SDK's feeSharingConfigPda");
        assert_eq!(curve.owner, PUMP_ID);
        assert_eq!(curve.data[..8], CURVE_DISCRIMINATOR);
        assert_eq!(key_at(&curve.data, CURVE_CREATOR), Some(sharing.key));
        assert_eq!(sharing.owner, PUMP_FEES_ID);
        assert_eq!(sharing.data[..8], SHARING_DISCRIMINATOR);
        assert_eq!(sharing.data[SHARING_VERSION], SHARING_KNOWN_VERSION);
        assert_eq!(sharing.data[SHARING_STATUS], SHARING_STATUS_ACTIVE);
        assert_eq!(key_at(&sharing.data, SHARING_MINT), Some(PUMP_MINT));
        assert_eq!(sharing.data[SHARING_ADMIN_REVOKED], 1);
        assert_eq!(sharing.data[SHARING_COUNT..SHARING_COUNT + 4], [2, 0, 0, 0]);
        assert_eq!(key_at(&sharing.data, SHARING_HOLDERS), Some(LAUNCHER));
        assert_eq!(sharing.data[SHARING_HOLDERS + 32..SHARING_HOLDERS + 34], 5_000u16.to_le_bytes());
        assert_eq!(key_at(&sharing.data, SHARING_HOLDERS + SHAREHOLDER_LEN), Some(PARTNER));
        // Before fee sharing the curve's creator is the wallet that created the coin.
        let unshared = Fixture::load("pump-unshared-curve");
        assert_eq!(unshared.key, curve_key(&PUMP_UNSHARED_MINT));
        assert_eq!(
            key_at(&unshared.data, CURVE_CREATOR),
            Some(pubkey!("4wEjLrMqewYf5kkgAjS4htKoHmtpyXPn8Ye9BDS9vjgJ"))
        );
    }

    #[test]
    fn pump_after_fee_sharing_passes_and_names_the_launcher() {
        let curve = Fixture::load("pump-shared-curve");
        let sharing = Fixture::load("pump-shared-sharing");
        assert_eq!(pmp(&PUMP_MINT, &curve, &sharing).unwrap(), Verdict::Pass(LAUNCHER));
    }

    #[test]
    fn pump_before_fee_sharing_fails() {
        let curve = Fixture::load("pump-unshared-curve");
        let sharing = Fixture::missing(sharing_key(&PUMP_UNSHARED_MINT));
        assert_eq!(
            pmp(&PUMP_UNSHARED_MINT, &curve, &sharing).unwrap(),
            Verdict::Fail(LootError::NoFeeSharing)
        );
    }

    #[test]
    fn plain_mint_is_on_no_venue() {
        let curve = Fixture::missing(curve_key(&PLAIN_MINT));
        let sharing = Fixture::missing(sharing_key(&PLAIN_MINT));
        assert_eq!(
            pmp(&PLAIN_MINT, &curve, &sharing).unwrap(),
            Verdict::Fail(LootError::NoBondingCurve)
        );
        // And no Meteora pool can be shown for it: the mint account itself is not one.
        let mint = Fixture::load("plain-mint");
        assert!(err(met(&PLAIN_MINT, &mint, &mint)).contains("VenueAccounts"));
    }

    #[test]
    fn pump_rule_by_rule() {
        let curve = Fixture::load("pump-shared-curve");
        let fresh = || Fixture::load("pump-shared-sharing");
        let check = |s: &Fixture| pmp(&PUMP_MINT, &curve, s).unwrap();

        let mut s = fresh();
        s.data[SHARING_STATUS] = 0;
        assert_eq!(check(&s), Verdict::Fail(LootError::SharingNotActive));
        let mut s = fresh();
        s.data[SHARING_ADMIN_REVOKED] = 0;
        assert_eq!(check(&s), Verdict::Fail(LootError::SharingAdminNotRevoked));
        // Launcher / partner shares (the real config holds the launcher first, at 50/50). The
        // partner needs at least 5%, and the two must make the whole.
        let split = |launcher: u16, partner: u16| {
            let mut s = fresh();
            s.data[SHARING_HOLDERS + 32..SHARING_HOLDERS + 34].copy_from_slice(&launcher.to_le_bytes());
            s.data[SHARING_HOLDERS + 66..SHARING_HOLDERS + 68].copy_from_slice(&partner.to_le_bytes());
            check(&s)
        };
        let mismatch = Verdict::Fail(LootError::ShareholdersMismatch);
        assert_eq!(split(5_000, 5_000), Verdict::Pass(LAUNCHER));
        assert_eq!(split(9_500, 500), Verdict::Pass(LAUNCHER));
        assert_eq!(split(6_000, 4_000), Verdict::Pass(LAUNCHER));
        assert_eq!(split(0, 10_000), Verdict::Pass(LAUNCHER));
        assert_eq!(split(9_600, 400), mismatch);
        assert_eq!(split(10_000, 0), mismatch);
        // Shares that do not make the whole (pump.fun refuses them; this does not rely on it).
        assert_eq!(split(9_000, 600), mismatch);
        assert_eq!(split(9_500, 600), mismatch);
        assert_eq!(split(u16::MAX, 500), mismatch);
        // The partner first: the same rules.
        let mut s = fresh();
        s.data[SHARING_HOLDERS..SHARING_HOLDERS + 32].copy_from_slice(PARTNER.as_ref());
        s.data[SHARING_HOLDERS + 32..SHARING_HOLDERS + 34].copy_from_slice(&500u16.to_le_bytes());
        s.data[SHARING_HOLDERS + 34..SHARING_HOLDERS + 66].copy_from_slice(LAUNCHER.as_ref());
        s.data[SHARING_HOLDERS + 66..SHARING_HOLDERS + 68].copy_from_slice(&9_500u16.to_le_bytes());
        assert_eq!(check(&s), Verdict::Pass(LAUNCHER));
        s.data[SHARING_HOLDERS + 32..SHARING_HOLDERS + 34].copy_from_slice(&400u16.to_le_bytes());
        s.data[SHARING_HOLDERS + 66..SHARING_HOLDERS + 68].copy_from_slice(&9_600u16.to_le_bytes());
        assert_eq!(check(&s), mismatch);
        // Duplicates: the partner twice, the launcher twice.
        for who in [PARTNER, LAUNCHER] {
            let mut s = fresh();
            s.data[SHARING_HOLDERS..SHARING_HOLDERS + 32].copy_from_slice(who.as_ref());
            s.data[SHARING_HOLDERS + 34..SHARING_HOLDERS + 66].copy_from_slice(who.as_ref());
            assert_eq!(check(&s), mismatch, "{who}");
        }
        // The partner replaced by someone else.
        let mut s = fresh();
        s.data[SHARING_HOLDERS + 34..SHARING_HOLDERS + 66].copy_from_slice(Pubkey::new_unique().as_ref());
        assert_eq!(check(&s), Verdict::Fail(LootError::ShareholdersMismatch));
        // A third shareholder, or only the launcher.
        let mut s = fresh();
        s.data[SHARING_COUNT] = 3;
        assert_eq!(check(&s), Verdict::Fail(LootError::ShareholdersMismatch));
        let mut s = fresh();
        s.data[SHARING_COUNT] = 1;
        assert_eq!(check(&s), Verdict::Fail(LootError::ShareholdersMismatch));
        // The partner alone at 100% is the partner's own launch.
        let mut s = fresh();
        s.data[SHARING_COUNT] = 1;
        s.data[SHARING_HOLDERS..SHARING_HOLDERS + 32].copy_from_slice(PARTNER.as_ref());
        s.data[SHARING_HOLDERS + 32..SHARING_HOLDERS + 34].copy_from_slice(&10_000u16.to_le_bytes());
        assert_eq!(check(&s), Verdict::Pass(PARTNER));
        // The curve paying the launcher directly again.
        let mut c = Fixture::load("pump-shared-curve");
        c.data[CURVE_CREATOR..CURVE_CREATOR + 32].copy_from_slice(LAUNCHER.as_ref());
        assert_eq!(
            pmp(&PUMP_MINT, &c, &fresh()).unwrap(),
            Verdict::Fail(LootError::CurveNotSharing)
        );
        // A cashback coin, a holder-rewards coin: the creator fee goes elsewhere.
        assert_eq!((curve.data[CURVE_IS_CASHBACK], curve.data[CURVE_IS_HOLDER_REWARD]), (0, 0));
        for at in [CURVE_IS_CASHBACK, CURVE_IS_HOLDER_REWARD] {
            let mut c = Fixture::load("pump-shared-curve");
            c.data[at] = 1;
            assert_eq!(pmp(&PUMP_MINT, &c, &fresh()).unwrap(), Verdict::Fail(LootError::CreatorFeeDiverted));
        }
        // A curve from before those fields existed (shorter) has neither.
        let mut c = Fixture::load("pump-shared-curve");
        c.data.truncate(CURVE_MIN_LEN);
        assert_eq!(pmp(&PUMP_MINT, &c, &fresh()).unwrap(), Verdict::Pass(LAUNCHER));
        // A layout version we have not seen is not a verdict.
        let mut s = fresh();
        s.data[SHARING_VERSION] = 3;
        assert!(err(pmp(&PUMP_MINT, &curve, &s)).contains("VenueLayout"));
    }

    #[test]
    fn pump_wrong_accounts_are_errors_not_verdicts() {
        let curve = Fixture::load("pump-shared-curve");
        let sharing = Fixture::load("pump-shared-sharing");
        let other_curve = Fixture::load("pump-unshared-curve");
        // Another coin's curve, with or without this coin's sharing config.
        assert!(err(pmp(&PUMP_MINT, &other_curve, &sharing)).contains("VenueAccounts"));
        // An empty account in place of the sharing config must not read as "no fee sharing".
        let empty = Fixture::missing(Pubkey::new_unique());
        assert!(err(pmp(&PUMP_MINT, &curve, &empty)).contains("VenueAccounts"));
        assert!(err(pmp(&PUMP_MINT, &empty, &sharing)).contains("VenueAccounts"));
        // This coin's real accounts offered for another mint.
        assert!(err(pmp(&PUMP_UNSHARED_MINT, &curve, &sharing)).contains("VenueAccounts"));
        // A look-alike: the right bytes at another address, under another owner.
        let mut fake = Fixture::load("pump-shared-sharing");
        fake.key = Pubkey::new_unique();
        fake.owner = Pubkey::new_unique();
        assert!(err(pmp(&PUMP_MINT, &curve, &fake)).contains("VenueAccounts"));
        // A non-canonical bump gives another address, which is refused like any other.
        let (_, bump) = Pubkey::find_program_address(&[SHARING_SEED, PUMP_MINT.as_ref()], &PUMP_FEES_ID);
        for b in (0..bump).rev() {
            if let Ok(key) = Pubkey::create_program_address(&[SHARING_SEED, PUMP_MINT.as_ref(), &[b]], &PUMP_FEES_ID) {
                assert!(err(pmp(&PUMP_MINT, &curve, &Fixture::missing(key))).contains("VenueAccounts"));
                break;
            }
        }
        // Meteora accounts offered as pump.fun's, and the other way round.
        let pool = Fixture::load("meteora-official-pool");
        let config = Fixture::load("meteora-official-config");
        assert!(err(pmp(&METEORA_MINT, &pool, &config)).contains("VenueAccounts"));
        assert!(err(met(&PUMP_MINT, &curve, &sharing)).contains("VenueAccounts"));
    }
}
