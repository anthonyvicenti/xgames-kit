//! The LiteSVM environment the test files share: the real Metaplex Core and MagicBlock VRF
//! programs (dumped from devnet by `scripts/fetch-fixtures.sh`), fixed keys, and one helper per
//! instruction. The VRF oracle is simulated by sending the callback with the scoped VRF
//! identity as signer (sigverify is off for that reason).
#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{associated_token, token::spl_token},
    base64::Engine,
    litesvm::LiteSVM,
    loot::{
        state::{DropEntry, Fees, Game, Item, ItemKind, LootBox, Order, Outcome, Share, To},
        Attribute, BoxArgs, ItemArgs,
    },
    mpl_core::types::{Plugin, PluginAuthorityPair, UpdateDelegate},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signature::Signature,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    anchor_lang::solana_program::instruction::{AccountMeta, Instruction},
};

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures");
pub const QUEUE: Pubkey = Pubkey::from_str_const("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
pub const VRF: Pubkey = Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
pub const SLOT_HASHES: Pubkey = Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");
pub const PRICE: u64 = 1_000_000;
/// The platform's flat fee in the tests: 0.001 SOL.
pub const FEE: u64 = 1_000_000;
pub const REF: [u8; 32] = [9; 32];

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    /// The game's owner.
    pub creator: Keypair,
    /// The game's authority: signs payouts and makes.
    pub authority: Keypair,
    pub player: Keypair,
    pub cranker: Keypair,
    pub mint: Pubkey,
    pub collection: Pubkey,
    pub game: Pubkey,
    pub treasury: Pubkey,
    /// (instruction, compute units) of every transaction that landed, in order.
    pub cus: Vec<(String, u64)>,
    /// The launch partner recorded on the platform: the real devnet one, so the venue fixtures
    /// (real devnet accounts) pass against it.
    pub partner: Pubkey,
}

pub const PARTNER: Pubkey = Pubkey::from_str_const("8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV");
pub const SYSTEM: Pubkey = anchor_lang::system_program::ID;

/// A devnet account dumped by `scripts/fetch-fixtures.sh venue` (`solana account --output
/// json-compact`).
pub struct Fixture {
    pub key: Pubkey,
    pub owner: Pubkey,
    pub lamports: u64,
    pub data: Vec<u8>,
}

pub fn fixture(name: &str) -> Fixture {
    let text = std::fs::read_to_string(format!("{FIXTURES}/{name}.json")).unwrap_or_else(|_| panic!("fixture {name}"));
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    Fixture {
        key: v["pubkey"].as_str().unwrap().parse().unwrap(),
        owner: v["account"]["owner"].as_str().unwrap().parse().unwrap(),
        lamports: v["account"]["lamports"].as_u64().unwrap(),
        data: base64::engine::general_purpose::STANDARD
            .decode(v["account"]["data"][0].as_str().unwrap())
            .unwrap(),
    }
}

/// A classic SPL token account, packed by hand (mint, owner, amount, no delegate, initialized).
pub fn token_account_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

pub fn program_data() -> Pubkey {
    Pubkey::find_program_address(&[loot::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0
}
pub fn platform_pda() -> Pubkey {
    pda(&[loot::PLATFORM_SEED])
}
/// A game's fee box: where the platform's fees on that game's transactions wait.
pub fn fees_pda(game: &Pubkey) -> Pubkey {
    pda(&[loot::FEES_SEED, game.as_ref()])
}

/// The first receipt of type `T` in a transaction's log.
pub fn receipt<T: anchor_lang::AnchorDeserialize + anchor_lang::Discriminator>(logs: &[String]) -> T {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .find(|b| b.starts_with(T::DISCRIMINATOR))
        .map(|b| T::deserialize(&mut &b[T::DISCRIMINATOR.len()..]).unwrap())
        .expect("no such receipt")
}

/// Deterministic keys, so PDA bump searches (and so compute units) are the same on every run.
pub fn kp(n: u8) -> Keypair {
    Keypair::new_from_array([n; 32])
}
pub fn ix_name(logs: &[String]) -> String {
    logs.iter()
        .find_map(|l| l.strip_prefix("Program log: Instruction: "))
        .unwrap_or("?")
        .to_string()
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &loot::ID).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(owner, mint, &token_program_of(mint))
}

thread_local! {
    /// The Token-2022 mints this test made (`Env::new_mint_2022`). Every other mint is classic.
    static TOKEN_2022_MINTS: std::cell::RefCell<Vec<Pubkey>> = const { std::cell::RefCell::new(vec![]) };
}

/// The token program that owns `mint`.
pub fn token_program_of(mint: &Pubkey) -> Pubkey {
    match TOKEN_2022_MINTS.with(|m| m.borrow().contains(mint)) {
        true => loot::tokens::TOKEN_2022_ID,
        false => spl_token::ID,
    }
}
pub fn item_pda(game: &Pubkey, id: u32) -> Pubkey {
    pda(&[loot::ITEM_SEED, game.as_ref(), &id.to_le_bytes()])
}
pub fn box_pda(game: &Pubkey, id: u32) -> Pubkey {
    pda(&[loot::BOX_SEED, game.as_ref(), &id.to_le_bytes()])
}
pub fn order_pda(game: &Pubkey, player: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[loot::ORDER_SEED, game.as_ref(), player.as_ref(), &nonce.to_le_bytes()])
}
pub fn escrow_pda(order: &Pubkey) -> Pubkey {
    pda(&[loot::ESCROW_SEED, order.as_ref()])
}
pub fn pool_pda(game: &Pubkey, index: u8) -> Pubkey {
    pda(&[loot::POOL_SEED, game.as_ref(), &[index]])
}
/// A box entry that gives an item.
pub fn item_drop(item_id: u32, weight: u32) -> DropEntry {
    DropEntry { outcome: Outcome::Item(item_id), weight }
}
/// A box entry that pays `amount` from a pool.
pub fn pay_drop(pool: u8, amount: u64, weight: u32) -> DropEntry {
    DropEntry { outcome: Outcome::Pay { pool, amount }, weight }
}
pub fn burn(bps: u16) -> Share {
    Share { to: To::Burn, bps }
}
pub fn pool(index: u8, bps: u16) -> Share {
    Share { to: To::Pool(index), bps }
}
pub fn asset_pda_at(order: &Pubkey, slot: u64) -> Pubkey {
    pda(&[loot::ASSET_SEED, order.as_ref(), &slot.to_le_bytes()])
}
/// With LOOT_DUMP_FIXTURES=1, writes real minted asset bytes for the JS parser tests.
pub fn dump_asset(env: &Env, asset: &Pubkey, name: &str) {
    if std::env::var("LOOT_DUMP_FIXTURES").is_err() {
        return;
    }
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../client/fixtures");
    std::fs::create_dir_all(dir).unwrap();
    let data = &env.svm.get_account(asset).unwrap().data;
    let json = format!(
        "{{\"asset\":\"{}\",\"collection\":\"{}\",\"data\":\"{}\"}}\n",
        asset,
        env.collection,
        base64::engine::general_purpose::STANDARD.encode(data)
    );
    std::fs::write(format!("{dir}/{name}.json"), json).unwrap();
}

pub fn scoped_identity() -> Pubkey {
    Pubkey::find_program_address(&[b"identity", loot::ID.as_ref()], &VRF).0
}

impl Env {
    /// Puts raw bytes at an address, rent-exempt, as if `owner` had written them.
    pub fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.put_with(key, owner, lamports, data);
    }

    pub fn put_with(&mut self, key: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8>) {
        self.svm
            .set_account(key, solana_account::Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    /// Loads a devnet fixture at its own address, with its own owner. Returns the address.
    pub fn load(&mut self, name: &str) -> Pubkey {
        let f = fixture(name);
        self.put(f.key, f.owner, f.data);
        f.key
    }

    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm.get_account(key).map(|a| a.data).unwrap_or_default()
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>().unix_timestamp
    }

    /// Moves the clock forward by `seconds` (and one slot).
    pub fn wait(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
        clock.unix_timestamp += seconds;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    /// An order closes in a later slot than its purchase: steps to the next slot when the
    /// clock is still in the order's own.
    pub fn past_purchase_slot(&mut self, order: &Pubkey) {
        let Some(account) = self.svm.get_account(order).filter(|a| a.owner == loot::ID) else { return };
        let Ok(o) = Order::try_deserialize(&mut account.data.as_slice()) else { return };
        if self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>().slot <= o.requested_slot {
            self.wait_slots(1);
        }
    }

    pub fn wait_slots(&mut self, slots: u64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
        clock.slot += slots;
        self.svm.set_sysvar(&clock);
    }

    pub fn acc<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let a = self.svm.get_account(key).expect("account missing");
        T::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    /// The mint of a token account, the game's own if the account is not there.
    pub fn mint_of(&self, account: &Pubkey) -> Pubkey {
        match self.svm.get_account(account) {
            Some(a) if a.data.len() >= 32 => Pubkey::new_from_array(a.data[..32].try_into().unwrap()),
            _ => self.mint,
        }
    }

    /// What a token account of either program holds (its amount sits at bytes 64..72 in both).
    pub fn tokens(&self, key: &Pubkey) -> u64 {
        self.svm
            .get_account(key)
            .filter(|a| (a.owner == spl_token::ID || a.owner == loot::tokens::TOKEN_2022_ID) && a.data.len() >= 165)
            .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
            .unwrap_or(0)
    }

    /// A mint's supply, of either program (bytes 36..44 in both).
    pub fn supply(&self, mint: &Pubkey) -> u64 {
        let a = self.svm.get_account(mint).unwrap();
        u64::from_le_bytes(a.data[36..44].try_into().unwrap())
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn platform(&self) -> loot::state::Platform {
        self.acc(&platform_pda())
    }

    pub fn game_state(&self) -> Game {
        self.acc(&self.game)
    }

    pub fn item_state(&self, id: u32) -> Item {
        self.acc(&item_pda(&self.game, id))
    }

    // ------------------------------------------------------------ sending

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let m = self.svm
            .send_transaction(tx)
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))?;
        self.cus.push((ix_name(&m.logs), m.compute_units_consumed));
        Ok(m.logs)
    }

    /// Sends with only `payer` really signing; every other required signature is assumed
    /// (sigverify is off). Used for the oracle's identity and for devnet wallets whose key the
    /// tests do not have.
    pub fn send_unsigned(&mut self, ixs: &[Instruction], payer: &Keypair) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let n = msg.header.num_required_signatures as usize;
        let mut sigs = vec![Signature::default(); n];
        sigs[0] = payer.sign_message(&msg.serialize());
        let tx = VersionedTransaction { signatures: sigs, message: VersionedMessage::Legacy(msg) };
        let m = self.svm
            .send_transaction(tx)
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))?;
        self.cus.push((ix_name(&m.logs), m.compute_units_consumed));
        Ok(m.logs)
    }

    fn loot(&self, data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
        Instruction::new_with_bytes(loot::ID, &data, metas)
    }

    pub fn ix(&mut self, data: Vec<u8>, metas: Vec<AccountMeta>, signers: &[&Keypair]) -> Result<Vec<String>, String> {
        let ix = self.loot(data, metas);
        self.send(&[ix], signers)
    }

    /// The accounts every receipt pays the platform's fee with.
    pub fn fee(&self) -> loot::accounts::Fee {
        loot::accounts::Fee { platform: platform_pda(), fees: fees_pda(&self.game), system_program: SYSTEM }
    }

    // ------------------------------------------------------------ platform

    /// The platform with one fee for players and projects alike (the older tests count with it).
    pub fn init_platform(&mut self, fee_lamports: u64) -> Result<Vec<String>, String> {
        let a = self.admin.insecure_clone();
        self.init_platform_as(&a, program_data(), fee_lamports)
    }

    pub fn init_platform_as(&mut self, who: &Keypair, program_data: Pubkey, fee_lamports: u64) -> Result<Vec<String>, String> {
        self.init_platform_fees(who, program_data, Fees { player: fee_lamports, project: fee_lamports })
    }

    pub fn init_platform_fees(&mut self, who: &Keypair, program_data: Pubkey, fees: Fees) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::InitPlatform { fees, partner: self.partner }.data(),
            loot::accounts::InitPlatform { admin: who.pubkey(), platform: platform_pda(), program_data, system_program: SYSTEM }
                .to_account_metas(None),
            &[who],
        )
    }

    /// The fees paid so far on the game's transactions and not yet collected.
    pub fn fees(&self) -> u64 {
        self.lamports(&fees_pda(&self.game)) - self.rent(0)
    }

    /// Collects the game's fees.
    pub fn collect_fees(&mut self, who: &Keypair, to: Pubkey) -> Result<Vec<String>, String> {
        let mut metas = loot::accounts::CollectFees { admin: who.pubkey(), platform: platform_pda(), to }.to_account_metas(None);
        metas.push(AccountMeta::new_readonly(self.game, false));
        metas.push(AccountMeta::new(fees_pda(&self.game), false));
        self.ix(loot::instruction::CollectFees {}.data(), metas, &[who])
    }

    pub fn set_platform(&mut self, who: &Keypair, fee_lamports: u64, next: &Keypair) -> Result<Vec<String>, String> {
        self.set_platform_fees(who, Fees { player: fee_lamports, project: fee_lamports }, next)
    }

    /// `next` signs as the admin from now on (`who` again to keep it).
    pub fn set_platform_fees(&mut self, who: &Keypair, fees: Fees, next: &Keypair) -> Result<Vec<String>, String> {
        let metas = loot::accounts::SetPlatform { admin: who.pubkey(), platform: platform_pda(), next_admin: next.pubkey() }
            .to_account_metas(None);
        let signers: Vec<&Keypair> = if who.pubkey() == next.pubkey() { vec![who] } else { vec![who, next] };
        self.ix(loot::instruction::SetPlatform { fees }.data(), metas, &signers)
    }

    /// The admin changes only the fee.
    pub fn set_fee(&mut self, fee_lamports: u64) -> Result<Vec<String>, String> {
        let a = self.admin.insecure_clone();
        self.set_platform(&a, fee_lamports, &a)
    }

    pub fn set_suspended(&mut self, who: &Keypair, suspended: bool) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::SetSuspended { suspended }.data(),
            loot::accounts::SetSuspended { admin: who.pubkey(), platform: platform_pda(), game: self.game }
                .to_account_metas(None),
            &[who],
        )
    }

    // ------------------------------------------------------------ game settings

    pub fn create_game(&mut self) -> Result<Vec<String>, String> {
        let c = self.creator.insecure_clone();
        self.ix(
            loot::instruction::CreateGame { authority: self.authority.pubkey() }.data(),
            loot::accounts::CreateGame {
                owner: c.pubkey(),
                game: self.game,
                fees: fees_pda(&self.game),
                collection: self.collection,
                mint: self.mint,
                treasury: self.treasury,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[&c],
        )
    }

    pub fn update_game(&mut self, who: &Keypair, update: loot::GameUpdate) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::UpdateGame { update }.data(),
            loot::accounts::UpdateGame {
                owner: who.pubkey(),
                game: self.game,
                treasury: self.treasury,
                system_program: SYSTEM,
                new_owner: None,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    /// The owner hands the game to `next`, who signs.
    pub fn hand_over_game(&mut self, who: &Keypair, next: &Keypair) -> Result<Vec<String>, String> {
        let update = loot::GameUpdate { authority: None, paused: None };
        self.ix(
            loot::instruction::UpdateGame { update }.data(),
            loot::accounts::UpdateGame {
                owner: who.pubkey(),
                game: self.game,
                treasury: self.treasury,
                system_program: SYSTEM,
                new_owner: Some(next.pubkey()),
            }
            .to_account_metas(None),
            &if who.pubkey() == next.pubkey() { vec![who] } else { vec![who, next] },
        )
    }

    pub fn open_pool(&mut self, who: &Keypair, index: u8, mint: Pubkey) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::OpenPool { index }.data(),
            loot::accounts::OpenPool {
                owner: who.pubkey(),
                game: self.game,
                mint,
                pool: pool_pda(&self.game, index),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn close_pool(&mut self, who: &Keypair, index: u8) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::ClosePool { index }.data(),
            loot::accounts::ClosePool {
                owner: who.pubkey(),
                game: self.game,
                pool: pool_pda(&self.game, index),
                mint: self.mint_of(&pool_pda(&self.game, index)),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn upsert_item_as(&mut self, who: &Keypair, id: u32, args: ItemArgs) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::UpsertItem { item_id: id, args }.data(),
            loot::accounts::UpsertItem { owner: who.pubkey(), game: self.game, item: item_pda(&self.game, id), system_program: SYSTEM }
                .to_account_metas(None),
            &[who],
        )
    }

    pub fn upsert_item(&mut self, id: u32, args: ItemArgs) -> Result<Vec<String>, String> {
        let c = self.creator.insecure_clone();
        self.upsert_item_as(&c, id, args)
    }

    pub fn upsert_box(&mut self, box_id: u32, price: u64, shares: Vec<Share>, entries: Vec<DropEntry>) -> Result<Vec<String>, String> {
        self.upsert_box_args(box_id, BoxArgs { price, currency: None, rise: None, fall: None, stock_odds: false, active: true, shares, entries })
    }

    pub fn upsert_box_args(&mut self, box_id: u32, args: BoxArgs) -> Result<Vec<String>, String> {
        let c = self.creator.insecure_clone();
        self.ix(
            loot::instruction::UpsertBox { box_id, args }.data(),
            loot::accounts::UpsertBox { owner: c.pubkey(), game: self.game, loot_box: box_pda(&self.game, box_id), system_program: SYSTEM }
                .to_account_metas(None),
            &[&c],
        )
    }

    /// Three items and one box with two of them. Every sale burns 20%.
    pub fn catalog(&mut self) {
        self.upsert_item(1, item(ItemKind::Collectible, "Gecko Crown", 2, 0)).unwrap();
        self.upsert_item(2, item(ItemKind::Normal, "Iron Sword", 0, 0)).unwrap();
        self.upsert_item(3, ItemArgs { soulbound: true, ..item(ItemKind::Collectible, "Founder Badge", 0, PRICE / 2) }).unwrap();
        self.upsert_box(1, PRICE, vec![burn(2_000)], vec![item_drop(1, 1), item_drop(2, 1)]).unwrap();
    }

    // ------------------------------------------------------------ in

    /// The accounts a split names, in order, as the instruction's last accounts.
    pub fn pool_metas(&self, shares: &[Share], mint: &Pubkey) -> Vec<AccountMeta> {
        shares.iter().flat_map(|s| self.to_metas(s.to, mint)).collect()
    }

    /// The accounts one destination needs (`rail::deliver`).
    pub fn to_metas(&self, to: To, mint: &Pubkey) -> Vec<AccountMeta> {
        match to {
            To::Burn => vec![],
            To::Pool(index) => vec![AccountMeta::new(pool_pda(&self.game, index), false)],
            To::Account(account) => vec![AccountMeta::new(account, false)],
            To::Holder(asset) => {
                let holder = mpl_core::Asset::from_bytes(&self.data(&asset)).map(|a| a.base.owner).unwrap_or_default();
                vec![AccountMeta::new_readonly(asset, false), AccountMeta::new(ata(&holder, mint), false)]
            }
        }
    }

    pub fn pay_ix(&self, player: Pubkey, mint: Pubkey, amount: u64, shares: Vec<Share>) -> Instruction {
        let mut metas = loot::accounts::Pay {
            player,
            game: self.game,
            mint,
            player_token: ata(&player, &mint),
            treasury: self.treasury,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: self.fee(),
        }
        .to_account_metas(None);
        metas.extend(self.pool_metas(&shares, &mint));
        self.loot(loot::instruction::Pay { amount, shares, reference: REF }.data(), metas)
    }

    /// The player pays `amount` of the game's mint.
    pub fn pay(&mut self, amount: u64, shares: Vec<Share>) -> Result<Vec<String>, String> {
        let p = self.player.insecure_clone();
        let ix = self.pay_ix(p.pubkey(), self.mint, amount, shares);
        self.send(&[ix], &[&p])
    }

    pub fn deposit(&mut self, who: &Keypair, index: u8, mint: Pubkey, amount: u64) -> Result<Vec<String>, String> {
        let ix = self.deposit_ix(&who.pubkey(), index, mint, amount);
        self.send(&[ix], &[who])
    }

    pub fn deposit_ix(&self, who: &Pubkey, index: u8, mint: Pubkey, amount: u64) -> Instruction {
        self.loot(
            loot::instruction::Deposit { index, amount }.data(),
            loot::accounts::Deposit {
                depositor: *who,
                game: self.game,
                pool: pool_pda(&self.game, index),
                from: ata(who, &mint),
                mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
        )
    }

    fn checkout(&self, nonce: u64) -> loot::accounts::Checkout {
        self.checkout_in(nonce, self.mint)
    }

    fn checkout_in(&self, nonce: u64, mint: Pubkey) -> loot::accounts::Checkout {
        let player = self.player.pubkey();
        let order = order_pda(&self.game, &player, nonce);
        loot::accounts::Checkout {
            player,
            game: self.game,
            platform: platform_pda(),
            order,
            escrow: escrow_pda(&order),
            mint,
            player_token: ata(&player, &mint),
            vault: ata(&self.game, &mint),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            associated_token_program: associated_token::ID,
            system_program: SYSTEM,
        }
    }

    /// The account each box entry comes with: its item for an item, its pool for a prize.
    fn entry_metas(&self, lb: &LootBox) -> Vec<AccountMeta> {
        lb.entries
            .iter()
            .filter_map(|e| match e.outcome {
                Outcome::Item(id) => Some(AccountMeta::new(item_pda(&self.game, id), false)),
                Outcome::Pay { pool, .. } | Outcome::Share { pool, .. } => Some(AccountMeta::new_readonly(pool_pda(&self.game, pool), false)),
                Outcome::Burn | Outcome::Nothing => None,
            })
            .collect()
    }

    pub fn buy(&mut self, item_id: u32, nonce: u64) -> Result<Vec<String>, String> {
        let ix = self.buy_ix(item_id, nonce);
        let p = self.player.insecure_clone();
        self.send(&[ix], &[&p])
    }

    /// Signs for the price the item has when the instruction is built, as a client does.
    pub fn buy_ix(&self, item_id: u32, nonce: u64) -> Instruction {
        self.buy_ix_max(item_id, nonce, self.item_state(item_id).price)
    }

    pub fn buy_ix_max(&self, item_id: u32, nonce: u64, max_price: u64) -> Instruction {
        self.loot(
            loot::instruction::BuyItem { item_id, nonce, max_price }.data(),
            loot::accounts::BuyItem { item: item_pda(&self.game, item_id), checkout: self.checkout(nonce) }.to_account_metas(None),
        )
    }

    pub fn open_box(&mut self, box_id: u32, nonce: u64) -> Result<Vec<String>, String> {
        let ix = self.open_box_ix(box_id, nonce);
        let p = self.player.insecure_clone();
        self.send(&[ix], &[&p])
    }

    /// Signs for the price the box has when the instruction is built, as a client does.
    pub fn open_box_ix(&self, box_id: u32, nonce: u64) -> Instruction {
        let lb: LootBox = self.acc(&box_pda(&self.game, box_id));
        let mut metas = loot::accounts::OpenBox {
            loot_box: box_pda(&self.game, box_id),
            checkout: self.checkout_in(nonce, lb.currency.unwrap_or(self.mint)),
            oracle_queue: QUEUE,
            program_identity: pda(&[b"identity"]),
            vrf_program: VRF,
            slot_hashes: SLOT_HASHES,
            system_program: SYSTEM,
        }
        .to_account_metas(None);
        metas.extend(self.entry_metas(&lb));
        self.loot(
            loot::instruction::OpenBox { box_id, nonce, client_seed: [7; 32], max_price: lb.price }.data(),
            metas,
        )
    }

    pub fn callback_ix(&self, identity: Pubkey, order: Pubkey, randomness: [u8; 32]) -> Instruction {
        self.callback_ix_of(1, identity, order, randomness)
    }

    /// The oracle answers an order of box `box_id`, in a later slot than the purchase as it does
    /// on chain.
    pub fn callback_of(&mut self, box_id: u32, order: Pubkey, randomness: [u8; 32]) -> Result<Vec<String>, String> {
        self.past_purchase_slot(&order);
        let ix = self.callback_ix_of(box_id, scoped_identity(), order, randomness);
        let c = self.cranker.insecure_clone();
        self.send_unsigned(&[ix], &c)
    }

    pub fn callback_ix_of(&self, box_id: u32, identity: Pubkey, order: Pubkey, randomness: [u8; 32]) -> Instruction {
        // Built from the box, not the order, so it can target a closed order too.
        let box_key = box_pda(&self.game, box_id);
        let lb: LootBox = self.acc(&box_key);
        let mut metas = vec![
            AccountMeta::new_readonly(identity, true),
            AccountMeta::new(order, false),
            AccountMeta::new_readonly(box_key, false),
            AccountMeta::new_readonly(self.ticket(&order), false),
        ];
        metas.extend(self.entry_metas(&lb));
        self.loot(loot::instruction::CallbackRoll { randomness }.data(), metas)
    }

    /// The ticket of the open order at this address (any address if there is none).
    pub fn ticket(&self, order: &Pubkey) -> Pubkey {
        match self.svm.get_account(order).filter(|a| a.owner == loot::ID) {
            Some(_) => loot::ticket_of(order, self.acc::<Order>(order).requested_slot),
            None => Pubkey::default(),
        }
    }

    /// Where the open order at this address will mint its collectible.
    pub fn asset_pda(&self, order: &Pubkey) -> Pubkey {
        asset_pda_at(order, self.acc::<Order>(order).requested_slot)
    }

    /// The oracle answers.
    pub fn callback(&mut self, order: Pubkey, randomness: [u8; 32]) -> Result<Vec<String>, String> {
        self.past_purchase_slot(&order);
        let ix = self.callback_ix(scoped_identity(), order, randomness);
        let c = self.cranker.insecure_clone();
        self.send_unsigned(&[ix], &c)
    }

    pub fn settle(&mut self, order: Pubkey, signer: &Keypair) -> Result<Vec<String>, String> {
        self.past_purchase_slot(&order);
        let ix = self.settle_ix(order, signer.pubkey());
        self.send(&[ix], &[signer])
    }

    /// Settles a box order whose roll was a prize, a burn or nothing. `prize_to` is where a
    /// prize goes: a token account of the player.
    pub fn settle_prize(&mut self, order: Pubkey, prize_to: Option<Pubkey>, signer: &Keypair) -> Result<Vec<String>, String> {
        self.past_purchase_slot(&order);
        let ix = self.settle_prize_ix(order, prize_to);
        self.send(&[ix], &[signer])
    }

    pub fn settle_prize_ix(&self, order: Pubkey, prize_to: Option<Pubkey>) -> Instruction {
        let o: Order = self.acc(&order);
        let prize_pool = match o.outcome {
            Outcome::Pay { pool, .. } | Outcome::Share { pool, .. } => Some(pool_pda(&self.game, pool)),
            _ => None,
        };
        let mut metas = loot::accounts::SettlePrize {
            order,
            player: o.player,
            game: self.game,
            escrow: escrow_pda(&order),
            mint: o.mint,
            vault: ata(&self.game, &o.mint),
            treasury: self.treasury,
            prize_pool,
            prize_to,
            prize_mint: prize_pool.map(|pool| self.mint_of(&pool)),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fees: fees_pda(&self.game),
            system_program: SYSTEM,
        }
        .to_account_metas(None);
        metas.extend(self.pool_metas(&o.shares, &o.mint));
        self.loot(loot::instruction::SettlePrize {}.data(), metas)
    }

    pub fn settle_ix(&self, order: Pubkey, signer: Pubkey) -> Instruction {
        let o: Order = self.acc(&order);
        // An order that is not an item order names no item; the program refuses it.
        let item_id = match o.outcome {
            Outcome::Item(id) => id,
            _ => 1,
        };
        let mut metas = loot::accounts::Settle {
            signer,
            order,
            player: o.player,
            game: self.game,
            item: item_pda(&self.game, item_id),
            escrow: escrow_pda(&order),
            mint: o.mint,
            vault: ata(&self.game, &o.mint),
            treasury: self.treasury,
            collection: self.collection,
            asset: asset_pda_at(&order, o.requested_slot),
            mpl_core_program: mpl_core::ID,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fees: fees_pda(&self.game),
            system_program: SYSTEM,
        }
        .to_account_metas(None);
        metas.extend(self.pool_metas(&o.shares, &o.mint));
        self.loot(loot::instruction::Settle {}.data(), metas)
    }

    pub fn refund(&mut self, order: Pubkey) -> Result<Vec<String>, String> {
        let ix = self.refund_ix(order);
        let c = self.cranker.insecure_clone();
        self.send(&[ix], &[&c])
    }

    /// A rolled order's refund names its item (the reserved serial goes back to it).
    pub fn refund_ix(&self, order: Pubkey) -> Instruction {
        let o: Order = self.acc(&order);
        let mut metas = loot::accounts::Refund {
            signer: self.cranker.pubkey(),
            order,
            player: o.player,
            game: self.game,
            escrow: escrow_pda(&order),
            mint: o.mint,
            vault: ata(&self.game, &o.mint),
            player_token: ata(&o.player, &o.mint),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            associated_token_program: associated_token::ID,
            system_program: SYSTEM,
        }
        .to_account_metas(None);
        if let (loot::state::OrderStatus::Rolled, Outcome::Item(item_id)) = (o.status, o.outcome) {
            metas.push(AccountMeta::new(item_pda(&self.game, item_id), false));
        }
        self.loot(loot::instruction::Refund {}.data(), metas)
    }

    // ------------------------------------------------------------ out

    pub fn payout_ix(&self, who: Pubkey, index: u8, to: Pubkey, amount: u64) -> Instruction {
        self.loot(
            loot::instruction::Payout { index, amount, reference: REF }.data(),
            loot::accounts::Payout {
                authority: who,
                game: self.game,
                pool: pool_pda(&self.game, index),
                to,
                mint: self.mint_of(&pool_pda(&self.game, index)),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
        )
    }

    pub fn payout(&mut self, who: &Keypair, index: u8, to: Pubkey, amount: u64) -> Result<Vec<String>, String> {
        let ix = self.payout_ix(who.pubkey(), index, to, amount);
        self.send(&[ix], &[who])
    }

    pub fn burn_from_pool(&mut self, who: &Keypair, index: u8, mint: Pubkey, amount: u64) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::Burn { index, amount, reference: REF }.data(),
            loot::accounts::Burn {
                authority: who.pubkey(),
                game: self.game,
                pool: pool_pda(&self.game, index),
                mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
            &[who],
        )
    }

    // ------------------------------------------------------------ random

    /// The authority asks the oracle for a number.
    pub fn roll(&mut self, who: &Keypair, reference: [u8; 32]) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::Roll { reference }.data(),
            loot::accounts::Roll {
                authority: who.pubkey(),
                game: self.game,
                oracle_queue: QUEUE,
                fee: self.fee(),
                program_identity: pda(&[b"identity"]),
                vrf_program: VRF,
                slot_hashes: SLOT_HASHES,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn random_ix(&self, identity: Pubkey, reference: [u8; 32], randomness: [u8; 32]) -> Instruction {
        self.loot(
            loot::instruction::CallbackRandom { randomness }.data(),
            vec![
                AccountMeta::new_readonly(identity, true),
                AccountMeta::new_readonly(self.game, false),
                AccountMeta::new_readonly(Pubkey::new_from_array(reference), false),
            ],
        )
    }

    /// The oracle answers a `roll`.
    pub fn random(&mut self, reference: [u8; 32], randomness: [u8; 32]) -> Result<Vec<String>, String> {
        let ix = self.random_ix(scoped_identity(), reference, randomness);
        let c = self.cranker.insecure_clone();
        self.send_unsigned(&[ix], &c)
    }

    // ------------------------------------------------------------ make

    pub fn issue(&mut self, who: &Keypair, mint: Pubkey, to: Pubkey, amount: u64) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::Issue { amount, reference: REF }.data(),
            loot::accounts::Issue { authority: who.pubkey(), game: self.game, mint, to, token_program: spl_token::ID, token_2022_program: loot::tokens::TOKEN_2022_ID, fee: self.fee() }
                .to_account_metas(None),
            &[who],
        )
    }

    /// Mints one of `item_id` to `owner`. Returns the new asset's address.
    pub fn make(&mut self, who: &Keypair, item_id: u32, owner: Pubkey) -> Result<Pubkey, String> {
        let asset = Keypair::new();
        self.ix(
            loot::instruction::Make { reference: REF }.data(),
            loot::accounts::Make {
                authority: who.pubkey(),
                game: self.game,
                item: item_pda(&self.game, item_id),
                collection: self.collection,
                asset: asset.pubkey(),
                owner,
                mpl_core_program: mpl_core::ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
            &[who, &asset],
        )?;
        Ok(asset.pubkey())
    }

    fn remake(&self, who: Pubkey, asset: Pubkey) -> Vec<AccountMeta> {
        loot::accounts::Remake {
            authority: who,
            game: self.game,
            asset,
            collection: self.collection,
            mpl_core_program: mpl_core::ID,
            fee: self.fee(),
        }
        .to_account_metas(None)
    }

    pub fn unmake(&mut self, who: &Keypair, asset: Pubkey) -> Result<Vec<String>, String> {
        let metas = self.remake(who.pubkey(), asset);
        self.ix(loot::instruction::Unmake { reference: REF }.data(), metas, &[who])
    }

    pub fn set(&mut self, who: &Keypair, asset: Pubkey, attributes: &[(&str, &str)]) -> Result<Vec<String>, String> {
        let attributes = attributes.iter().map(|(k, v)| Attribute { key: k.to_string(), value: v.to_string() }).collect();
        let metas = self.remake(who.pubkey(), asset);
        self.ix(loot::instruction::Set { attributes, reference: REF }.data(), metas, &[who])
    }

    // ------------------------------------------------------------ mechanics without the authority

    pub fn mechanic_pda(&self, seed: &[u8], id: u32) -> Pubkey {
        pda(&[seed, self.game.as_ref(), &id.to_le_bytes()])
    }

    pub fn upsert_schedule(&mut self, who: &Keypair, id: u32, args: loot::ScheduleArgs) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::UpsertSchedule { id, args }.data(),
            loot::accounts::UpsertSchedule {
                owner: who.pubkey(),
                game: self.game,
                schedule: self.mechanic_pda(loot::SCHEDULE_SEED, id),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    /// Anyone runs schedule `id`; `first` and `second` are the two accounts its action names.
    pub fn run_schedule(&mut self, id: u32, first: Pubkey, second: Pubkey) -> Result<Vec<String>, String> {
        let c = self.cranker.insecure_clone();
        let mut metas = loot::accounts::RunSchedule {
            game: self.game,
            schedule: self.mechanic_pda(loot::SCHEDULE_SEED, id),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
        }
        .to_account_metas(None);
        metas.extend([AccountMeta::new(first, false), AccountMeta::new(second, false)]);
        // A move between pools also names their mint.
        metas.push(AccountMeta::new_readonly(self.mint_of(&first), false));
        self.ix(loot::instruction::RunSchedule {}.data(), metas, &[&c])
    }

    pub fn lottery(&self, id: u32) -> loot::Lottery {
        self.acc(&self.mechanic_pda(loot::LOTTERY_SEED, id))
    }

    pub fn upsert_lottery(&mut self, who: &Keypair, id: u32, args: loot::LotteryArgs) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::UpsertLottery { id, args }.data(),
            loot::accounts::UpsertLottery {
                owner: who.pubkey(),
                game: self.game,
                lottery: self.mechanic_pda(loot::LOTTERY_SEED, id),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    /// `who` buys `count` tickets with the mint of the lottery's pot, at the price on show.
    pub fn buy_tickets(&mut self, who: &Keypair, id: u32, count: u64, mint: Pubkey) -> Result<Vec<String>, String> {
        let l = self.lottery(id);
        self.ix(
            loot::instruction::BuyTickets { count, max_price: l.price }.data(),
            loot::accounts::BuyTickets {
                player: who.pubkey(),
                game: self.game,
                lottery: self.mechanic_pda(loot::LOTTERY_SEED, id),
                player_token: ata(&who.pubkey(), &mint),
                pot: pool_pda(&self.game, l.pot),
                treasury: self.treasury,
                mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn draw_lottery(&mut self, id: u32) -> Result<Vec<String>, String> {
        let c = self.cranker.insecure_clone();
        self.ix(
            loot::instruction::DrawLottery {}.data(),
            loot::accounts::DrawLottery {
                payer: c.pubkey(),
                lottery: self.mechanic_pda(loot::LOTTERY_SEED, id),
                oracle_queue: QUEUE,
                program_identity: pda(&[b"identity"]),
                vrf_program: VRF,
                slot_hashes: SLOT_HASHES,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[&c],
        )
    }

    /// The oracle's answer to the draw that was asked for in `asked_slot`.
    pub fn lottery_callback_ix(&self, id: u32, asked_slot: u64, randomness: [u8; 32]) -> Instruction {
        let lottery = self.mechanic_pda(loot::LOTTERY_SEED, id);
        self.loot(
            loot::instruction::CallbackLottery { randomness }.data(),
            vec![
                AccountMeta::new_readonly(scoped_identity(), true),
                AccountMeta::new(lottery, false),
                AccountMeta::new_readonly(loot::ticket_of(&lottery, asked_slot), false),
            ],
        )
    }

    pub fn lottery_callback(&mut self, id: u32, randomness: [u8; 32]) -> Result<Vec<String>, String> {
        let ix = self.lottery_callback_ix(id, self.lottery(id).asked_slot, randomness);
        let c = self.cranker.insecure_clone();
        self.send_unsigned(&[ix], &c)
    }

    /// Anyone pays the drawn winner of first place, into token account `to`.
    pub fn pay_lottery(&mut self, id: u32, to: Pubkey) -> Result<Vec<String>, String> {
        self.pay_lottery_place(id, 0, to)
    }

    /// Anyone pays one place, into token account `to` of its winner.
    pub fn pay_lottery_place(&mut self, id: u32, place: u8, to: Pubkey) -> Result<Vec<String>, String> {
        let l = self.lottery(id);
        let c = self.cranker.insecure_clone();
        self.ix(
            loot::instruction::PayLottery { place }.data(),
            loot::accounts::PayLottery {
                game: self.game,
                lottery: self.mechanic_pda(loot::LOTTERY_SEED, id),
                first_place: l.winner,
                pot: pool_pda(&self.game, l.pot),
                to,
                mint: self.mint_of(&pool_pda(&self.game, l.pot)),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
            }
            .to_account_metas(None),
            &[&c],
        )
    }

    pub fn staked_vault(&self, id: u32) -> Pubkey {
        pda(&[loot::STAKED_SEED, self.mechanic_pda(loot::STAKE_SEED, id).as_ref()])
    }

    pub fn rewards_vault(&self, id: u32) -> Pubkey {
        pda(&[loot::REWARDS_SEED, self.mechanic_pda(loot::STAKE_SEED, id).as_ref()])
    }

    pub fn position_pda(&self, id: u32, player: &Pubkey) -> Pubkey {
        pda(&[loot::POSITION_SEED, self.mechanic_pda(loot::STAKE_SEED, id).as_ref(), player.as_ref()])
    }

    pub fn open_stake(&mut self, who: &Keypair, id: u32, mint: Pubkey, rewards_pool: u8, rewards_mint: Pubkey, lock: i64) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::OpenStake { id, rewards_pool, lock }.data(),
            loot::accounts::OpenStake {
                owner: who.pubkey(),
                game: self.game,
                stake: self.mechanic_pda(loot::STAKE_SEED, id),
                mint,
                rewards_mint,
                staked_vault: self.staked_vault(id),
                rewards_vault: self.rewards_vault(id),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    fn staking(&self, who: Pubkey, id: u32, rewards_mint: Pubkey) -> Vec<AccountMeta> {
        let s: loot::Stake = self.acc(&self.mechanic_pda(loot::STAKE_SEED, id));
        loot::accounts::Staking {
            player: who,
            game: self.game,
            stake: self.mechanic_pda(loot::STAKE_SEED, id),
            position: self.position_pda(id, &who),
            staked_vault: self.staked_vault(id),
            rewards_vault: self.rewards_vault(id),
            rewards_pool: pool_pda(&self.game, s.rewards_pool),
            player_tokens: ata(&who, &s.mint),
            player_rewards: ata(&who, &rewards_mint),
            mint: s.mint,
            rewards_mint: s.rewards_mint,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: self.fee(),
        }
        .to_account_metas(None)
    }

    pub fn stake(&mut self, who: &Keypair, id: u32, amount: u64, rewards_mint: Pubkey) -> Result<Vec<String>, String> {
        let metas = self.staking(who.pubkey(), id, rewards_mint);
        self.ix(loot::instruction::Stake { amount }.data(), metas, &[who])
    }

    pub fn unstake(&mut self, who: &Keypair, id: u32, amount: u64, rewards_mint: Pubkey) -> Result<Vec<String>, String> {
        let metas = self.staking(who.pubkey(), id, rewards_mint);
        self.ix(loot::instruction::Unstake { amount, forfeit: false }.data(), metas, &[who])
    }

    /// Unstakes and gives up the rewards owed.
    pub fn unstake_forfeit(&mut self, who: &Keypair, id: u32, amount: u64, rewards_mint: Pubkey) -> Result<Vec<String>, String> {
        let metas = self.staking(who.pubkey(), id, rewards_mint);
        self.ix(loot::instruction::Unstake { amount, forfeit: true }.data(), metas, &[who])
    }

    pub fn upsert_recipe(&mut self, who: &Keypair, id: u32, args: loot::RecipeArgs) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::UpsertRecipe { id, args }.data(),
            loot::accounts::UpsertRecipe {
                owner: who.pubkey(),
                game: self.game,
                recipe: self.mechanic_pda(loot::RECIPE_SEED, id),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    /// `who` merges `inputs` by recipe `id`. Returns the new asset's address.
    pub fn merge(&mut self, who: &Keypair, id: u32, inputs: &[Pubkey]) -> Result<Pubkey, String> {
        Ok(self.craft(who, id, inputs)?[0])
    }

    /// `who` crafts recipe `id`, handing in `assets` (the burned and the used, in the recipe's
    /// order). Returns the addresses of the collectibles it made.
    pub fn craft(&mut self, who: &Keypair, id: u32, assets: &[Pubkey]) -> Result<Vec<Pubkey>, String> {
        self.craft_times(who, id, 1, assets)
    }

    /// The same, `times` over (a recipe of tokens only).
    pub fn craft_times(&mut self, who: &Keypair, id: u32, times: u64, assets: &[Pubkey]) -> Result<Vec<Pubkey>, String> {
        let version = self.acc::<loot::Recipe>(&self.mechanic_pda(loot::RECIPE_SEED, id)).version;
        let (mut ix, made) = self.craft_ix(who.pubkey(), id, version, assets);
        ix.data = loot::instruction::Craft { version, times }.data();
        let mut signers = vec![who];
        signers.extend(made.iter());
        self.send(&[compute_limit(1_000_000), ix], &signers)?;
        Ok(made.iter().map(|k| k.pubkey()).collect())
    }

    pub fn craft_ix(&self, who: Pubkey, id: u32, version: u32, assets: &[Pubkey]) -> (Instruction, Vec<Keypair>) {
        let recipe = self.mechanic_pda(loot::RECIPE_SEED, id);
        let r: loot::Recipe = self.acc(&recipe);
        let mut metas = loot::accounts::Craft {
            player: who,
            game: self.game,
            recipe,
            collection: self.collection,
            mpl_core_program: mpl_core::ID,
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: self.fee(),
        }
        .to_account_metas(None);
        let mut assets = assets.iter();
        for input in &r.inputs {
            match *input {
                loot::Input::Burn { item, count } => {
                    metas.push(AccountMeta::new_readonly(item_pda(&self.game, item), false));
                    metas.extend(assets.by_ref().take(count as usize).map(|key| AccountMeta::new(*key, false)));
                }
                loot::Input::Use { item } | loot::Input::Renew { item } => {
                    metas.push(AccountMeta::new_readonly(item_pda(&self.game, item), false));
                    metas.extend(assets.by_ref().take(1).map(|key| AccountMeta::new(*key, false)));
                }
                loot::Input::Pay { mint, to, .. } => {
                    metas.extend([AccountMeta::new(mint, false), AccountMeta::new(ata(&who, &mint), false)]);
                    metas.extend(self.to_metas(to, &mint));
                }
            }
        }
        let mut made = vec![];
        for output in &r.outputs {
            match *output {
                loot::Output::Item(item) => {
                    let asset = Keypair::new();
                    metas.extend([AccountMeta::new(item_pda(&self.game, item), false), AccountMeta::new(asset.pubkey(), true)]);
                    made.push(asset);
                }
                loot::Output::Tokens { mint, from, .. } => {
                    metas.push(AccountMeta::new(mint, false));
                    if let loot::Origin::Pool(index) = from {
                        metas.push(AccountMeta::new(pool_pda(&self.game, index), false));
                    }
                    metas.push(AccountMeta::new(ata(&who, &mint), false));
                }
                loot::Output::Share { mint, pool, .. } => {
                    metas.extend([AccountMeta::new(mint, false), AccountMeta::new(pool_pda(&self.game, pool), false)]);
                    metas.push(AccountMeta::new(ata(&who, &mint), false));
                }
            }
        }
        (self.loot(loot::instruction::Craft { version, times: 1 }.data(), metas), made)
    }

    // ------------------------------------------------------------ holds

    pub fn hold_pda(&self, asset: &Pubkey) -> Pubkey {
        pda(&[loot::HOLD_SEED, asset.as_ref()])
    }

    pub fn hold(&mut self, who: &Keypair, asset: Pubkey, seconds: i64) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::Hold { seconds, reference: REF }.data(),
            loot::accounts::HoldItem {
                player: who.pubkey(),
                game: self.game,
                hold: self.hold_pda(&asset),
                asset,
                collection: self.collection,
                mpl_core_program: mpl_core::ID,
                fee: self.fee(),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            &[who],
        )
    }

    /// `who` (anyone) sends a held collectible home to its player.
    pub fn take_back(&mut self, who: &Keypair, asset: Pubkey) -> Result<Vec<String>, String> {
        let hold: loot::Hold = self.acc(&self.hold_pda(&asset));
        let metas = loot::accounts::TakeBack {
            signer: who.pubkey(),
            game: self.game,
            hold: self.hold_pda(&asset),
            asset,
            player: hold.player,
            collection: self.collection,
            mpl_core_program: mpl_core::ID,
            system_program: SYSTEM,
        }
        .to_account_metas(None);
        self.ix(loot::instruction::TakeBack {}.data(), metas, &[who])
    }

    fn release(&self, signer: Pubkey, asset: Pubkey, to: Pubkey) -> Vec<AccountMeta> {
        let hold: loot::Hold = self.acc(&self.hold_pda(&asset));
        loot::accounts::Release {
            signer,
            game: self.game,
            hold: self.hold_pda(&asset),
            asset,
            player: hold.player,
            to,
            collection: self.collection,
            mpl_core_program: mpl_core::ID,
            fee: self.fee(),
        }
        .to_account_metas(None)
    }

    pub fn award(&mut self, who: &Keypair, asset: Pubkey, to: Pubkey) -> Result<Vec<String>, String> {
        let metas = self.release(who.pubkey(), asset, to);
        self.ix(loot::instruction::Award { reference: REF }.data(), metas, &[who])
    }

    // ------------------------------------------------------------ contests

    pub fn contest_pda(&self, id: u32) -> Pubkey {
        self.mechanic_pda(loot::CONTEST_SEED, id)
    }

    pub fn contest(&self, id: u32) -> loot::Contest {
        self.acc(&self.contest_pda(id))
    }

    pub fn pot_pda(&self, id: u32) -> Pubkey {
        pda(&[loot::POT_SEED, self.contest_pda(id).as_ref()])
    }

    pub fn entry_pda(&self, id: u32, player: &Pubkey, side: u8) -> Pubkey {
        pda(&[loot::ENTRY_SEED, self.contest_pda(id).as_ref(), player.as_ref(), &[side]])
    }

    pub fn open_contest(&mut self, who: &Keypair, id: u32, mint: Pubkey, args: loot::ContestArgs) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::OpenContest { id, args }.data(),
            loot::accounts::OpenContest {
                authority: who.pubkey(),
                game: self.game,
                contest: self.contest_pda(id),
                mint,
                pot: self.pot_pda(id),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn enter(&mut self, who: &Keypair, id: u32, side: u8, amount: u64) -> Result<Vec<String>, String> {
        let contest = self.contest(id);
        let mint = contest.mint;
        self.ix(
            loot::instruction::Enter { side, amount, terms: contest.terms }.data(),
            loot::accounts::Enter {
                player: who.pubkey(),
                game: self.game,
                contest: self.contest_pda(id),
                entry: self.entry_pda(id, &who.pubkey(), side),
                pot: self.pot_pda(id),
                player_token: ata(&who.pubkey(), &mint),
                mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
                fee: self.fee(),
            }
            .to_account_metas(None),
            &[who],
        )
    }

    pub fn decide(&mut self, who: &Keypair, id: u32, side: u8) -> Result<Vec<String>, String> {
        let c = self.contest(id);
        let mut metas = loot::accounts::Decide {
            authority: who.pubkey(),
            game: self.game,
            contest: self.contest_pda(id),
            mint: c.mint,
            pot: self.pot_pda(id),
            token_program: spl_token::ID,
            token_2022_program: loot::tokens::TOKEN_2022_ID,
            fee: self.fee(),
        }
        .to_account_metas(None);
        metas.extend(self.pool_metas(&c.shares, &c.mint));
        self.ix(loot::instruction::Decide { side, reference: REF }.data(), metas, &[who])
    }

    pub fn call_off(&mut self, who: &Keypair, id: u32) -> Result<Vec<String>, String> {
        self.ix(
            loot::instruction::CallOff {}.data(),
            loot::accounts::CallOff { signer: who.pubkey(), game: self.game, contest: self.contest_pda(id) }.to_account_metas(None),
            &[who],
        )
    }

    /// A keeper claims `player`'s entry on `side`, into token account `to`.
    pub fn claim(&mut self, id: u32, player: Pubkey, side: u8, to: Pubkey) -> Result<Vec<String>, String> {
        let c = self.cranker.insecure_clone();
        self.ix(
            loot::instruction::Claim {}.data(),
            loot::accounts::Claim {
                game: self.game,
                contest: self.contest_pda(id),
                entry: self.entry_pda(id, &player, side),
                player,
                pot: self.pot_pda(id),
                to,
                mint: self.contest(id).mint,
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
            }
            .to_account_metas(None),
            &[&c],
        )
    }

    pub fn close_contest(&mut self, id: u32) -> Result<Vec<String>, String> {
        let contest = self.contest(id);
        let c = self.cranker.insecure_clone();
        self.ix(
            loot::instruction::CloseContest {}.data(),
            loot::accounts::CloseContest {
                game: self.game,
                contest: self.contest_pda(id),
                opener: contest.opener,
                mint: contest.mint,
                pot: self.pot_pda(id),
                token_program: spl_token::ID,
                token_2022_program: loot::tokens::TOKEN_2022_ID,
            }
            .to_account_metas(None),
            &[&c],
        )
    }

    // ------------------------------------------------------------ registry

    pub fn attach_ix(&self, admin: Pubkey, launcher: Pubkey, venue: loot::state::Venue, mint: Pubkey, a: Pubkey, b: Pubkey) -> Instruction {
        self.loot(
            loot::instruction::AttachToken { venue, mint }.data(),
            loot::accounts::AttachToken { owner: admin, launcher, game: self.game, platform: platform_pda(), venue_a: a, venue_b: b, system_program: SYSTEM }
                .to_account_metas(None),
        )
    }

    /// `admin` signs for real. The launcher's signature is assumed (sigverify is off), which is
    /// how the tests "sign" as the devnet wallet that launched the fixture tokens.
    pub fn attach(&mut self, admin: &Keypair, launcher: Pubkey, venue: loot::state::Venue, mint: Pubkey, a: Pubkey, b: Pubkey) -> Result<Vec<String>, String> {
        let ix = self.attach_ix(admin.pubkey(), launcher, venue, mint, a, b);
        self.send_unsigned(&[ix], admin)
    }

    pub fn recheck(&mut self, a: Pubkey, b: Pubkey) -> Result<Vec<String>, String> {
        let c = self.cranker.insecure_clone();
        self.ix(
            loot::instruction::RecheckToken {}.data(),
            loot::accounts::RecheckToken { game: self.game, platform: platform_pda(), venue_a: a, venue_b: b }.to_account_metas(None),
            &[&c],
        )
    }

    // ------------------------------------------------------------ tokens the tests need

    /// A new classic SPL mint with `authority` as its mint authority. Returns its address.
    pub fn new_mint(&mut self, authority: Pubkey) -> Pubkey {
        let mint = Keypair::new();
        let c = self.creator.insecure_clone();
        let rent = self.rent(82);
        let ixs = [
            solana_system_interface::instruction::create_account(&c.pubkey(), &mint.pubkey(), rent, 82, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &authority, None, 6).unwrap(),
        ];
        self.send(&ixs, &[&c, &mint]).unwrap();
        self.cus.pop();
        mint.pubkey()
    }

    /// A new Token-2022 mint with the creator as its mint authority and these extensions: a
    /// transfer fee of `fee_bps` (when some), a transfer hook of `hook` (when some).
    pub fn new_mint_2022(&mut self, fee_bps: Option<u16>, hook: Option<Pubkey>) -> Pubkey {
        use spl_token_2022_interface::extension::{transfer_fee, transfer_hook, ExtensionType};
        let t22 = loot::tokens::TOKEN_2022_ID;
        let mint = Keypair::new();
        let c = self.creator.insecure_clone();
        let mut kinds = vec![];
        let mut init = vec![];
        if let Some(bps) = fee_bps {
            kinds.push(ExtensionType::TransferFeeConfig);
            init.push(transfer_fee::instruction::initialize_transfer_fee_config(&t22, &mint.pubkey(), Some(&c.pubkey()), Some(&c.pubkey()), bps, u64::MAX).unwrap());
        }
        if let Some(hook) = hook {
            kinds.push(ExtensionType::TransferHook);
            init.push(transfer_hook::instruction::initialize(&t22, &mint.pubkey(), Some(c.pubkey()), Some(hook)).unwrap());
        }
        let len = ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Mint>(&kinds).unwrap();
        let mut ixs = vec![solana_system_interface::instruction::create_account(&c.pubkey(), &mint.pubkey(), self.rent(len), len as u64, &t22)];
        ixs.extend(init);
        ixs.push(spl_token_2022_interface::instruction::initialize_mint2(&t22, &mint.pubkey(), &c.pubkey(), None, 6).unwrap());
        self.send(&ixs, &[&c, &mint]).unwrap();
        self.cus.pop();
        TOKEN_2022_MINTS.with(|m| m.borrow_mut().push(mint.pubkey()));
        mint.pubkey()
    }

    /// Makes sure `wallet` has a token account of `mint`. Returns its address.
    pub fn token_account(&mut self, wallet: Pubkey, mint: Pubkey) -> Pubkey {
        let key = ata(&wallet, &mint);
        if !self.exists(&key) {
            let c = self.cranker.insecure_clone();
            let ix = associated_token::spl_associated_token_account::instruction::create_associated_token_account(&c.pubkey(), &wallet, &mint, &token_program_of(&mint));
            self.send(&[ix], &[&c]).unwrap();
            self.cus.pop();
        }
        key
    }

    /// The creator (the mint authority of the tests' own mints) mints `amount` to `wallet`.
    pub fn fund(&mut self, wallet: Pubkey, mint: Pubkey, amount: u64) -> Pubkey {
        let to = self.token_account(wallet, mint);
        let c = self.creator.insecure_clone();
        let ix = spl_token_2022_interface::instruction::mint_to(&token_program_of(&mint), &mint, &to, &c.pubkey(), &[], amount).unwrap();
        self.send(&[ix], &[&c]).unwrap();
        self.cus.pop();
        to
    }
}

pub fn item(kind: ItemKind, name: &str, max_supply: u32, price: u64) -> ItemArgs {
    ItemArgs {
        kind,
        rarity: 3,
        soulbound: false,
        burnable: false,
        name: name.into(),
        uri: format!("https://example.invalid/{}.json", name.to_lowercase().replace(' ', "-")),
        max_supply,
        price,
        rise: None,
        fall: None,
        life: None,
        active: true,
        shares: vec![burn(2_000)],
    }
}

/// The old merge: `count` of one item burned for one of another.
pub fn merge_recipe(input: u32, count: u8, output: u32) -> loot::RecipeArgs {
    loot::RecipeArgs {
        active: true,
        inputs: vec![loot::Input::Burn { item: input, count }],
        outputs: vec![loot::Output::Item(output)],
        needs: vec![],
        keeps: vec![],
    }
}

/// Lifts the compute limit of a transaction: a craft makes several Core calls.
pub fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"), &data, vec![])
}

/// The chain before any loot instruction: programs, funded keys, the game token and the
/// creator's Core collection.
pub fn world() -> Env {
    let mut svm = LiteSVM::new().with_sigverify(false);
    svm.add_program(loot::ID, include_bytes!("../../../../target/deploy/loot.so")).unwrap();
    svm.add_program(mpl_core::ID, &std::fs::read(format!("{FIXTURES}/mpl_core.so")).expect("run scripts/fetch-fixtures.sh")).unwrap();
    svm.add_program(VRF, &std::fs::read(format!("{FIXTURES}/vrf.so")).unwrap()).unwrap();

    // Oracle queue account, as it is on devnet.
    let q: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}/queue.json")).unwrap()).unwrap();
    let data = base64::engine::general_purpose::STANDARD
        .decode(q["account"]["data"][0].as_str().unwrap())
        .unwrap();
    svm.set_account(
        QUEUE,
        solana_account::Account {
            lamports: q["account"]["lamports"].as_u64().unwrap(),
            data,
            owner: VRF,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let admin = kp(1);
    let creator = kp(2);
    let player = kp(3);
    let cranker = kp(4);
    let authority = kp(8);
    for k in [&admin, &creator, &player, &cranker, &authority] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }

    // Make `admin` the loot program's upgrade authority (LiteSVM deploys it with none).
    let pd_key = Pubkey::find_program_address(&[loot::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0;
    let mut pd = svm.get_account(&pd_key).unwrap();
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(admin.pubkey().as_ref());
    svm.set_account(pd_key, pd).unwrap();

    let mut env = Env {
        svm,
        admin,
        creator,
        authority,
        player,
        cranker,
        mint: Pubkey::default(),
        collection: Pubkey::default(),
        game: Pubkey::default(),
        treasury: Pubkey::default(),
        cus: vec![],
        partner: PARTNER,
    };

    // Game token: a plain SPL mint like the launchpad's DBC tokens.
    let mint = kp(6);
    env.mint = mint.pubkey();
    let rent = env.svm.minimum_balance_for_rent_exemption(82);
    let creator_pk = env.creator.pubkey();
    let player_pk = env.player.pubkey();
    let ixs = vec![
        solana_system_interface::instruction::create_account(&creator_pk, &env.mint, rent, 82, &spl_token::ID),
        spl_token::instruction::initialize_mint2(&spl_token::ID, &env.mint, &creator_pk, None, 6).unwrap(),
        associated_token::spl_associated_token_account::instruction::create_associated_token_account(&creator_pk, &creator_pk, &env.mint, &spl_token::ID),
        associated_token::spl_associated_token_account::instruction::create_associated_token_account(&creator_pk, &player_pk, &env.mint, &spl_token::ID),
        spl_token::instruction::mint_to(&spl_token::ID, &env.mint, &ata(&player_pk, &env.mint), &creator_pk, &[], 100 * PRICE).unwrap(),
    ];
    let c = env.creator.insecure_clone();
    env.send(&ixs, &[&c, &mint]).unwrap();
    env.treasury = ata(&creator_pk, &env.mint);

    // Creator's Core collection, with the Game PDA as an update delegate.
    let collection = kp(7);
    env.collection = collection.pubkey();
    env.game = pda(&[loot::GAME_SEED, env.collection.as_ref()]);
    let ix = mpl_core::instructions::CreateCollectionV2Builder::new()
        .collection(env.collection)
        .update_authority(Some(creator_pk))
        .payer(creator_pk)
        .name("Gecko Zombies".into())
        .uri("https://example.invalid/collection.json".into())
        .plugins(vec![PluginAuthorityPair {
            plugin: Plugin::UpdateDelegate(UpdateDelegate { additional_delegates: vec![env.game] }),
            authority: None,
        }])
        .instruction();
    env.send(&[ix], &[&c, &collection]).unwrap();

    env
}

/// The usual start: the platform's fee at 0.001 SOL, a game, three items and one box.
pub fn setup() -> Env {
    let mut env = world();
    env.init_platform(FEE).unwrap();
    env.create_game().unwrap();
    env.catalog();
    env
}

/// `random_u64` reads bytes 0,4,8,...,28 little-endian; this puts `v` there.
pub fn rnd(v: u64) -> [u8; 32] {
    let mut r = [0u8; 32];
    for (i, b) in v.to_le_bytes().iter().enumerate() {
        r[i * 4] = *b;
    }
    r
}

// ------------------------------------------------------------------ helpers every test file uses

pub const MINUTE: i64 = 60;
pub const HOUR: i64 = 60 * MINUTE;
pub const DAY: i64 = 24 * HOUR;

/// The failure's text. Panics if the transaction went through.
pub fn err<T>(r: Result<T, String>) -> String {
    r.err().expect("expected the transaction to fail")
}

/// A new wallet with SOL.
pub fn funded(env: &mut Env) -> Keypair {
    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

/// A new wallet with SOL and `amount` of `mint`.
pub fn wallet(env: &mut Env, mint: Pubkey, amount: u64) -> Keypair {
    let k = funded(env);
    env.fund(k.pubkey(), mint, amount);
    k
}

/// A new wallet with SOL and `amount` of the game's own token.
pub fn player(env: &mut Env, amount: u64) -> Keypair {
    let mint = env.mint;
    wallet(env, mint, amount)
}

/// A classic SPL transfer signed by `who`.
pub fn spl_transfer(who: &Keypair, from: Pubkey, to: Pubkey, amount: u64) -> Instruction {
    spl_token::instruction::transfer(&spl_token::ID, &from, &to, &who.pubkey(), &[], amount).unwrap()
}
