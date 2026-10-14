//! The five core accounts this program owns. Each mechanic that runs without the authority
//! (schedule, lottery, stake, recipe, hold, contest) keeps its own account in its own file
//! under `instructions/`. Everything else the program touches is a wallet, a token account or
//! a Metaplex Core asset.
//!
//! Rent is the first cost we optimise: each account starts with a one-byte tag instead of
//! Anchor's eight, and the ones an owner pays for are sized to what they hold (`rent.rs`).
//!
//! A pool is not in this file because it has no record of its own. It is a plain token account
//! at `["pool", game, index]` that the game owns.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::LootError;

// ---------------------------------------------------------------- platform

/// The platform's two flat fees, in lamports. A player's few transactions carry the larger
/// one; a project's many (an airdrop to ten thousand players) carry the smaller.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Fees {
    /// What a player pays when they sign for something of their own: a payment, a purchase,
    /// a craft, tickets, a stake or an unstake, a hold, an entry.
    pub player: u64,
    /// What every other charged instruction costs: a deposit, a payout, a burn, an issue, a
    /// make, a roll, an award, a contest opened or decided.
    pub project: u64,
}

impl Fees {
    /// Neither fee is above the one in `now`.
    pub fn no_raise_over(&self, now: &Fees) -> bool {
        self.player <= now.player && self.project <= now.project
    }
}

/// One for the whole program, at `["platform"]`: our fees. Only `init_platform` creates one, at
/// that address, so an account this program owns with this tag is the platform: instructions
/// check the owner and the tag (Anchor's `Account`) and do not derive the address again.
///
/// The fees themselves collect in each game's fee box (`FEES_SEED`) until the admin takes them
/// out, so this account is only ever read by a game's transactions and never holds them up.
#[account(discriminator = &[1])]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    /// The launch partner an official token pays at its venue (the registry, `venue.rs`).
    /// Set once: venue accounts that name it can never change.
    pub partner: Pubkey,
    /// The fees in force.
    pub fees: Fees,
    /// A raise waiting out its notice period. Meaningless while `pending_at` is 0.
    pub pending: Fees,
    /// Unix time the pending fees apply from. 0 means there are none.
    pub pending_at: i64,
    pub bump: u8,
}

impl Platform {
    pub const SPACE: usize = 1 + Self::INIT_SPACE;

    /// The fees in force at `now`: the pending ones once their notice period has run.
    pub fn fees(&self, now: i64) -> Fees {
        if self.pending_at != 0 && now >= self.pending_at {
            self.pending
        } else {
            self.fees
        }
    }
}

// ---------------------------------------------------------------- game (a project)

/// Where an official token was launched.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Venue {
    /// Meteora Dynamic Bonding Curve.
    Meteora,
    /// pump.fun.
    PumpFun,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct OfficialToken {
    pub mint: Pubkey,
    pub venue: Venue,
}

/// One per project, at `["game", collection]`. It is also the signer the program uses for the
/// project: it owns the pools and the order vault, mints the project's tokens and collectibles.
/// Only `create_game` creates one, at that address, so an account this program owns with this
/// tag is a game at its own address: instructions check the owner and the tag (Anchor's
/// `Account`) and do not derive the address again. Signing still uses the stored `bump`.
#[account(discriminator = &[2])]
pub struct Game {
    /// Signs the settings, the catalog and every mechanic. Can hand the game to another key.
    /// A project has two keys, this one and `authority`, and both are trusted.
    pub owner: Pubkey,
    /// Signs what leaves a pool, what gets made and what only the game knows (`payout`, `burn`,
    /// `issue`, `make`, `unmake`, `set`, `roll`, `award`, `open_contest`, `decide`). A wallet, a multisig, a server's key or another program's address. The program
    /// checks this signature and nothing else. It pays the flat fee in SOL, so it must be a
    /// plain address that holds some.
    pub authority: Pubkey,
    /// The Metaplex Core collection the game's collectibles are minted into.
    pub collection: Pubkey,
    /// The currency of the shop: every item's price is in this mint, and a box's unless it
    /// names another.
    pub mint: Pubkey,
    /// Token account that receives whatever a split leaves over.
    pub treasury: Pubkey,
    pub bump: u8,
    /// The bump of the game's fee box, `["fees", game]`.
    pub fees_bump: u8,
    /// The owner's switch: stops what comes in (`pay`, `buy_item`, `open_box`, `craft`,
    /// `buy_tickets`, `stake`, `hold`, `enter`).
    pub paused: bool,
    /// The platform's switch: stops the same. Never what is owed (settle, refund, payout,
    /// unstake, a lottery's draw and payment, a held collectible going home, a contest's claim).
    pub suspended: bool,
    /// The game's official token: one launched with games.fun that pays its share. Written only
    /// by `attach_token`, a record and not a gate: no economy instruction reads it.
    pub official: Option<OfficialToken>,
}

impl Game {
    /// Takes money in: neither the owner's switch nor the platform's is on.
    pub fn open_for_money(&self) -> Result<()> {
        require!(!self.paused, LootError::Paused);
        require!(!self.suspended, LootError::Suspended);
        Ok(())
    }

    /// One of the project's two keys.
    pub fn is_ours(&self, key: &Pubkey) -> bool {
        self.owner == *key || self.authority == *key
    }

    pub fn space(official: bool) -> usize {
        1 + 32 * 5 + 1 + 1 + 1 + 1 + 1 + if official { 33 } else { 0 }
    }

    /// The game's fee box (`FEES_SEED`). Checked with the stored bump, the cheap way.
    pub fn fees_address(&self, game: &Pubkey) -> Result<Pubkey> {
        Pubkey::create_program_address(&[FEES_SEED, game.as_ref(), &[self.fees_bump]], &crate::ID)
            .map_err(|_| error!(ErrorCode::ConstraintSeeds))
    }

    pub fn space_now(&self) -> usize {
        Self::space(self.official.is_some())
    }
}

// ---------------------------------------------------------------- splits

/// Where a share of a payment goes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum To {
    /// Destroyed.
    Burn,
    /// The game's pool with this index.
    Pool(u8),
    /// This token account: a partner, a creator, the player who found the recipe.
    Account(Pubkey),
    /// Whoever holds this collectible at that moment: the owner of a plot, a stud, a throne.
    /// When nobody does (it was burned, or the game is holding it), this share is burned.
    Holder(Pubkey),
}

/// A part of a payment, in basis points of the whole (10,000 = 100%).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Share {
    pub to: To,
    pub bps: u16,
}

/// At most `MAX_SHARES`, adding up to 100% or less.
pub fn check_shares(shares: &[Share]) -> Result<()> {
    let total: u64 = shares.iter().map(|s| s.bps as u64).sum();
    require!(shares.len() <= MAX_SHARES && total <= BPS, LootError::BadShares);
    Ok(())
}

/// The same, for a split that is carried out later (a sale when it settles, a contest when it
/// is decided) in `mint`, out of one of the accounts `paid_from`. One that could never be
/// carried out would hold up every order or result behind it, so it has:
/// - no share that burns, when it is in wrapped SOL, which cannot be burned: not `Burn`, and
///   not `Holder`, which is burned when nobody holds the collectible;
/// - no share into the account it is paid from, which `tokens::transfer` refuses.
pub fn check_later_shares(shares: &[Share], mint: &Pubkey, paid_from: &[Pubkey]) -> Result<()> {
    check_shares(shares)?;
    let burns = shares.iter().any(|s| matches!(s.to, To::Burn | To::Holder(_)));
    require!(!burns || !crate::tokens::is_wrapped_sol(mint), LootError::BadShares);
    let pays_itself = shares.iter().any(|s| matches!(s.to, To::Account(to) if paid_from.contains(&to)));
    require!(!pays_itself, LootError::SameAccount);
    Ok(())
}

// ---------------------------------------------------------------- catalog

/// A price that rises with every sale: a bonding curve, a throne that costs 10% more each time.
/// After a sale the price becomes `price + step + price * growth_bps / 10,000`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rise {
    pub step: u64,
    pub growth_bps: u16,
}

impl Rise {
    /// The price after one more sale at `price`. One that can rise no further stays put.
    pub fn next(rise: &Option<Rise>, price: u64) -> u64 {
        let Some(rise) = rise else { return price };
        let grown = crate::pick::share(price, rise.growth_bps).and_then(|more| price.checked_add(more));
        grown.and_then(|p| p.checked_add(rise.step)).unwrap_or(price)
    }
}

/// A price that falls with time: a drop whose price comes down until it sells, a seat that
/// cools off between buyers. It falls by `step` every `every` seconds counted from `since`,
/// and never below `floor` (a price already below the floor stays where it is).
///
/// The owner sets `since`: the price holds until then. Each sale after it sets it to the time
/// of the sale, so the price starts falling again from what was paid, after any `Rise`. A price that
/// falls to 0 is no longer for sale.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fall {
    pub step: u64,
    pub every: u32,
    pub floor: u64,
    pub since: i64,
}

impl Fall {
    /// What `price` has fallen to at `now`.
    pub fn at(fall: &Option<Fall>, price: u64, now: i64) -> u64 {
        let Some(fall) = fall else { return price };
        if now <= fall.since || price <= fall.floor || fall.every == 0 {
            return price;
        }
        let steps = (now.saturating_sub(fall.since) / fall.every as i64) as u64;
        price.saturating_sub(steps.saturating_mul(fall.step)).max(fall.floor)
    }

    /// The price a sale at `now` pays, and what the price becomes after it.
    pub fn sell(price: &mut u64, rise: &Option<Rise>, fall: &mut Option<Fall>, now: i64) -> u64 {
        let paid = Fall::at(fall, *price, now);
        *price = Rise::next(rise, paid);
        // A sale before the fall begins leaves its start where the owner put it.
        if let Some(fall) = fall {
            fall.since = fall.since.max(now);
        }
        paid
    }

    pub fn check(fall: &Option<Fall>) -> bool {
        fall.is_none_or(|fall| fall.step > 0 && fall.every > 0 && fall.since >= 0)
    }
}

/// How a collectible lives, for the recipes that take it (`craft.rs`). Every time is in
/// seconds, and 0 switches that rule off.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Life {
    /// It can't go into a recipe until this long after it was made: an egg that incubates, a
    /// crop that grows.
    pub ready_after: u32,
    /// It can't go into a recipe once this long has passed since it was made: food that rots,
    /// a pet that dies.
    pub lasts: u32,
    /// The times a recipe can use it without burning it: a breed count, a tool that wears out,
    /// a mine that runs dry.
    pub uses: u32,
    /// The wait between two uses: a cooldown, a daily turn.
    pub cooldown: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    /// Lives in the game's own backend. The chain only records that it was paid for.
    Normal,
    /// Minted as a Core asset in the game's collection.
    Collectible,
}

/// Something the game sells, drops from a box, or makes. The fixed fields come first so a box
/// roll can read them at fixed places (`ItemView`).
#[account(discriminator = &[3])]
#[derive(Debug)]
pub struct Item {
    pub game: Pubkey,
    pub item_id: u32,
    pub kind: ItemKind,
    pub rarity: u8,
    /// Collectibles only: frozen for good at mint, so it can't be transferred.
    pub soulbound: bool,
    /// Collectibles only: the game's authority can burn it later (`unmake`).
    pub burnable: bool,
    /// 0 means unlimited.
    pub max_supply: u32,
    /// Handed out so far, by sales, boxes and `make`. Also the last serial number used.
    pub issued: u32,
    /// Serials of refunded orders that could not be taken back (`ItemView::release`). They stay
    /// gaps in the numbering, and the units they stood for can be sold again under new numbers.
    /// So once a serial is voided, a later one can be above `max_supply`: a serial is a number,
    /// not a count. The count of units out is `issued - voided`, and it never passes the supply.
    pub voided: u32,
    /// Shop price in the game's mint. 0 means it is not sold directly.
    pub price: u64,
    /// Switched off, it is not sold, dropped from a box or made by a recipe. The authority's
    /// own `make` still works.
    pub active: bool,
    pub bump: u8,
    /// Makes the shop price rise with every sale.
    pub rise: Option<Rise>,
    /// Makes the shop price fall with time.
    pub fall: Option<Fall>,
    /// Collectibles only: when a recipe can take one, and how often.
    pub life: Option<Life>,
    /// Where a shop sale of this item sends its money.
    pub shares: Vec<Share>,
    pub name: String,
    pub uri: String,
}

impl Item {
    /// The units that count against the supply: every serial handed out, less the voided ones.
    pub fn out(&self) -> u32 {
        self.issued - self.voided
    }

    pub fn has_stock(&self) -> bool {
        self.max_supply == 0 || self.out() < self.max_supply
    }

    /// One sale at `now`: what it pays, after any fall, and the price after it.
    pub fn sell(&mut self, now: i64) -> u64 {
        Fall::sell(&mut self.price, &self.rise, &mut self.fall, now)
    }
}

/// The fixed fields of an `Item`, read straight from the account's bytes. A box roll looks at
/// up to eight items and changes one counter in one of them; loading each one whole would
/// allocate its name, URI and shares and write all of it back.
pub struct ItemView {
    pub game: Pubkey,
    pub item_id: u32,
    pub kind: ItemKind,
    pub max_supply: u32,
    pub issued: u32,
    pub voided: u32,
    pub active: bool,
}

impl ItemView {
    // Byte positions in an `Item` account: tag 0, game 1, item id 33, kind 37, rarity 38,
    // soulbound 39, burnable 40, max supply 41, issued 45, voided 49, price 53, active 61.
    const ISSUED_AT: usize = 45;
    const VOIDED_AT: usize = 49;
    const FIXED_LEN: usize = 62;

    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < Self::FIXED_LEN || data[..1] != *Item::DISCRIMINATOR {
            return None;
        }
        let u32_at = |at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        Some(ItemView {
            game: Pubkey::new_from_array(data[1..33].try_into().unwrap()),
            item_id: u32_at(33),
            kind: match data[37] {
                0 => ItemKind::Normal,
                1 => ItemKind::Collectible,
                _ => return None,
            },
            max_supply: u32_at(41),
            issued: u32_at(Self::ISSUED_AT),
            voided: u32_at(Self::VOIDED_AT),
            active: data[61] == 1,
        })
    }

    /// An item account of this program.
    pub fn read(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*account.owner, crate::ID, ErrorCode::AccountOwnedByWrongProgram);
        Self::parse(&account.try_borrow_data()?).ok_or(error!(ErrorCode::AccountDidNotDeserialize))
    }

    /// The units that count against the supply, as `Item::out`.
    pub fn out(&self) -> u32 {
        self.issued - self.voided
    }

    /// Can be sold or dropped right now.
    pub fn available(&self) -> bool {
        self.active && (self.max_supply == 0 || self.out() < self.max_supply)
    }

    fn write_counts(&self, account: &AccountInfo) -> Result<()> {
        let mut data = account.try_borrow_mut_data()?;
        data[Self::ISSUED_AT..Self::ISSUED_AT + 4].copy_from_slice(&self.issued.to_le_bytes());
        data[Self::VOIDED_AT..Self::VOIDED_AT + 4].copy_from_slice(&self.voided.to_le_bytes());
        Ok(())
    }

    /// Hands out the next serial number.
    pub fn issue(&mut self, account: &AccountInfo) -> Result<u32> {
        self.issued = self.issued.checked_add(1).ok_or(LootError::Overflow)?;
        self.write_counts(account)?;
        Ok(self.issued)
    }

    /// Gives back the unit of an order that is refunded without being minted. When its serial is
    /// the last one handed out, the serial is taken back and sold again under the same number.
    /// An earlier serial stays a gap, since lowering `issued` would repeat a number that is
    /// already minted, and is counted as voided. Returns whether the serial was taken back.
    pub fn release(&mut self, account: &AccountInfo, serial: u32) -> Result<bool> {
        if serial == 0 {
            return Ok(false);
        }
        let taken_back = serial == self.issued;
        match taken_back {
            true => self.issued -= 1,
            false => self.voided += 1,
        }
        self.write_counts(account)?;
        Ok(taken_back)
    }
}

/// What a box can give.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    /// One of this item. `settle` delivers it.
    Item(u32),
    /// `amount` from the game's pool with this index, to the player. `settle_prize` pays it.
    Pay { pool: u8, amount: u64 },
    /// A share of what the game's pool with this index holds when the box is rolled, in basis
    /// points: a jackpot that grows until someone hits it. The roll turns it into `Pay` with
    /// that amount, which `settle_prize` pays.
    Share { pool: u8, bps: u16 },
    /// The player's payment is burned, all of it, in place of the box's split.
    Burn,
    /// Nothing. The payment is split as usual.
    Nothing,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct DropEntry {
    pub outcome: Outcome,
    /// The chance of this entry is its weight over the sum of the weights still in stock (each
    /// first scaled by what is left of its item, when the box says `stock_odds`).
    pub weight: u32,
}

/// A loot box: a price and a drop table. The odds on a page are these bytes.
#[account(discriminator = &[4])]
pub struct LootBox {
    pub game: Pubkey,
    pub box_id: u32,
    pub price: u64,
    /// The mint the price is in. `None` is the game's own. A box in another mint has shares
    /// that take the whole payment, because the treasury only holds the game's mint.
    pub currency: Option<Pubkey>,
    /// Makes the price rise with every box opened.
    pub rise: Option<Rise>,
    /// Makes the price fall with time.
    pub fall: Option<Fall>,
    /// Each item's weight shrinks with its stock: it is multiplied by the share of the item's
    /// supply still left, rounded up. The last mythic of 100 is a hundred times rarer than the
    /// first. Items with no supply limit and the other outcomes keep their weight.
    pub stock_odds: bool,
    pub active: bool,
    /// Times opened.
    pub opened: u64,
    /// Counts its edits. An order remembers the version it paid for, and is not rolled on any
    /// other: it fails and refunds.
    pub version: u32,
    pub bump: u8,
    /// Where a sale of this box sends its money.
    pub shares: Vec<Share>,
    pub entries: Vec<DropEntry>,
}

impl LootBox {
    /// One sale at `now`: what it pays, after any fall, and the price after it.
    pub fn sell(&mut self, now: i64) -> u64 {
        Fall::sell(&mut self.price, &self.rise, &mut self.fall, now)
    }
}

// ---------------------------------------------------------------- orders

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderStatus {
    /// Paid, waiting for the random roll.
    Pending,
    /// Outcome chosen (and, for an item, its serial reserved). Waiting for settle.
    Rolled,
    /// Nothing could be won at roll time, or the box was edited after the purchase. Refundable.
    Failed,
}

/// One purchase from the shop or a box, held until it is settled or refunded. The player pays
/// its rent and gets it back either way.
#[account(discriminator = &[5])]
#[derive(InitSpace)]
pub struct Order {
    pub game: Pubkey,
    pub player: Pubkey,
    pub nonce: u64,
    /// The mint the player paid in.
    pub mint: Pubkey,
    /// The box opened and its version then, or the default key for a shop purchase.
    pub loot_box: Pubkey,
    pub box_version: u32,
    pub status: OrderStatus,
    /// What the order gives, once it is rolled.
    pub outcome: Outcome,
    /// The item's serial number, for an item.
    pub serial: u32,
    /// What the player paid, held in the game's vault until settle or refund.
    pub paid: u64,
    /// The platform's fee and the split, fixed at purchase so later edits don't touch a paid
    /// order. The fee waits in the escrow.
    pub fee: u64,
    #[max_len(MAX_SHARES)]
    pub shares: Vec<Share>,
    /// The slot of the purchase. Refund deadlines count from it.
    pub requested_slot: u64,
    pub bump: u8,
}

impl Order {
    pub const SPACE: usize = 1 + Self::INIT_SPACE;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
        let mut out = Vec::new();
        value.try_serialize(&mut out).unwrap();
        out
    }

    #[test]
    fn every_account_has_its_own_tag_and_none_is_zero() {
        use crate::instructions::{Contest, Entry, Hold, Lottery, Position, Recipe, Schedule, Stake};
        let tags = [
            Platform::DISCRIMINATOR,
            Game::DISCRIMINATOR,
            Item::DISCRIMINATOR,
            LootBox::DISCRIMINATOR,
            Order::DISCRIMINATOR,
            Schedule::DISCRIMINATOR,
            Lottery::DISCRIMINATOR,
            Stake::DISCRIMINATOR,
            Position::DISCRIMINATOR,
            Recipe::DISCRIMINATOR,
            Hold::DISCRIMINATOR,
            Contest::DISCRIMINATOR,
            Entry::DISCRIMINATOR,
        ];
        for (i, a) in tags.iter().enumerate() {
            assert_eq!(a.len(), 1);
            assert_ne!(a[0], 0, "a zeroed account must not read as anything");
            assert!(tags[i + 1..].iter().all(|b| a != b));
        }
    }

    #[test]
    fn sizes_match_what_is_written() {
        let mut g = Game {
            owner: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
            collection: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            bump: 255,
            fees_bump: 254,
            paused: false,
            suspended: true,
            official: None,
        };
        assert_eq!(bytes(&g).len(), Game::space(false));
        assert_eq!(g.space_now(), 166);
        g.official = Some(OfficialToken { mint: Pubkey::new_unique(), venue: Venue::PumpFun });
        assert_eq!(bytes(&g).len(), g.space_now());

        let p = Platform {
            admin: Pubkey::new_unique(),
            partner: Pubkey::new_unique(),
            fees: Fees { player: 1, project: 2 },
            pending: Fees { player: 3, project: 4 },
            pending_at: 3,
            bump: 255,
        };
        assert_eq!(bytes(&p).len(), Platform::SPACE);
        assert_eq!(Platform::SPACE, 106);

        let o = Order {
            game: Pubkey::new_unique(),
            player: Pubkey::new_unique(),
            nonce: 1,
            mint: Pubkey::new_unique(),
            loot_box: Pubkey::new_unique(),
            box_version: 1,
            status: OrderStatus::Rolled,
            outcome: Outcome::Pay { pool: 1, amount: 1 },
            serial: 1,
            paid: 1,
            fee: 1,
            shares: vec![Share { to: To::Holder(Pubkey::new_unique()), bps: 1 }; MAX_SHARES],
            requested_slot: 1,
            bump: 255,
        };
        assert_eq!(bytes(&o).len(), Order::SPACE, "the largest order fills the account exactly");
        assert_eq!(Order::SPACE, 325);
    }

    #[test]
    fn item_view_reads_what_anchor_writes() {
        for (n, kind) in [(0usize, ItemKind::Normal), (11, ItemKind::Collectible), (32, ItemKind::Collectible)] {
            let item = Item {
                game: Pubkey::new_unique(),
                item_id: 77 + n as u32,
                kind,
                rarity: 3,
                soulbound: n == 11,
                burnable: n == 32,
                max_supply: 1_000 + n as u32,
                issued: 7 + n as u32,
                voided: n as u32 / 2,
                price: u64::MAX - n as u64,
                active: n != 0,
                bump: 254,
                rise: (n == 11).then_some(Rise { step: 5, growth_bps: 1_000 }),
                fall: (n == 32).then_some(Fall { step: 1, every: 60, floor: 9, since: 7 }),
                life: (n == 32).then_some(Life { ready_after: 1, lasts: 2, uses: 3, cooldown: 4 }),
                shares: vec![Share { to: To::Burn, bps: 500 }; n % 3],
                name: "n".repeat(n),
                uri: "u".repeat(n * 6),
            };
            let data = bytes(&item);
            let v = ItemView::parse(&data).unwrap();
            assert_eq!(
                (v.game, v.item_id, v.kind, v.max_supply, v.issued, v.voided, v.active),
                (item.game, item.item_id, item.kind, item.max_supply, item.issued, item.voided, item.active)
            );
            assert_eq!(v.available(), item.active && item.has_stock());

            // The counters are where the view says they are.
            let mut bumped = data.clone();
            bumped[ItemView::ISSUED_AT..ItemView::ISSUED_AT + 4].copy_from_slice(&(item.issued + 1).to_le_bytes());
            bumped[ItemView::VOIDED_AT..ItemView::VOIDED_AT + 4].copy_from_slice(&(item.voided + 1).to_le_bytes());
            let again = Item::try_deserialize(&mut bumped.as_slice()).unwrap();
            assert_eq!(
                (again.issued, again.voided, again.price, &again.name),
                (item.issued + 1, item.voided + 1, item.price, &item.name)
            );

            // Another account type, or one cut short, is not an item.
            let mut other = data.clone();
            other[0] = LootBox::DISCRIMINATOR[0];
            assert!(ItemView::parse(&other).is_none());
            assert!(ItemView::parse(&data[..ItemView::FIXED_LEN - 1]).is_none());
        }
    }

    #[test]
    fn a_pending_fee_applies_only_when_due() {
        let (now, later) = (Fees { player: 500, project: 5 }, Fees { player: 800, project: 8 });
        let p = Platform { admin: Pubkey::default(), partner: Pubkey::default(), fees: now, pending: later, pending_at: 1_000, bump: 0 };
        assert_eq!(p.fees(999), now);
        assert_eq!(p.fees(1_000), later);
        assert_eq!(Platform { pending_at: 0, ..p }.fees(i64::MAX), now);
        assert!(now.no_raise_over(&now) && !later.no_raise_over(&now));
        assert!(!Fees { player: 400, project: 6 }.no_raise_over(&now), "a cut of one and a raise of the other is a raise");
    }

    #[test]
    fn a_price_rises_by_its_step_and_its_growth() {
        assert_eq!(Rise::next(&None, 100), 100);
        assert_eq!(Rise::next(&Some(Rise { step: 7, growth_bps: 0 }), 100), 107);
        assert_eq!(Rise::next(&Some(Rise { step: 0, growth_bps: 1_000 }), 100), 110);
        assert_eq!(Rise::next(&Some(Rise { step: 1, growth_bps: 1_000 }), 9), 10, "growth rounds down");
        assert_eq!(Rise::next(&Some(Rise { step: 1, growth_bps: 0 }), u64::MAX), u64::MAX, "it stops where it can go no higher");
    }

    #[test]
    fn a_price_falls_with_time_down_to_its_floor() {
        let fall = Some(Fall { step: 10, every: 60, floor: 30, since: 1_000 });
        assert_eq!(Fall::at(&None, 100, i64::MAX), 100);
        assert_eq!(Fall::at(&fall, 100, 1_000), 100, "it holds until `since`");
        assert_eq!(Fall::at(&fall, 100, 1_059), 100);
        assert_eq!(Fall::at(&fall, 100, 1_060), 90);
        assert_eq!(Fall::at(&fall, 100, 1_000 + 60 * 5), 50);
        assert_eq!(Fall::at(&fall, 100, i64::MAX), 30, "never below the floor");
        assert_eq!(Fall::at(&fall, 20, i64::MAX), 20, "a price under the floor stays");

        // A sale pays the fallen price, rises from it, and starts the fall again.
        let (mut price, mut fall) = (100, fall);
        let rise = Some(Rise { step: 0, growth_bps: 5_000 });
        assert_eq!(Fall::sell(&mut price, &rise, &mut fall, 1_120), 80);
        assert_eq!((price, fall.unwrap().since), (120, 1_120));
        assert_eq!(Fall::at(&fall, price, 1_180), 110);

        // A sale before the start does not move it.
        let (mut price, mut fall) = (100, Some(Fall { step: 10, every: 60, floor: 30, since: 1_000 }));
        assert_eq!(Fall::sell(&mut price, &None, &mut fall, 500), 100);
        assert_eq!(fall.unwrap().since, 1_000);
    }

    #[test]
    fn shares_are_few_and_never_more_than_the_whole() {
        let s = |bps| Share { to: To::Burn, bps };
        assert!(check_shares(&[]).is_ok());
        assert!(check_shares(&[s(2_500); 4]).is_ok());
        assert!(check_shares(&[s(1); 5]).is_err());
        assert!(check_shares(&[s(5_000), s(5_001)]).is_err());
    }
}
