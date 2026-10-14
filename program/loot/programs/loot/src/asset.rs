//! Reading a collectible. A Metaplex Core asset is an account of Core's, so this program reads
//! its bytes by hand: who holds it, which item it is one of, and the numbers written on it.
//!
//! An asset starts: a tag (1), its owner, its update authority (a tag, then an address unless
//! the tag is 0), its name, its URI, and an optional sequence number. Its plugins follow: a
//! header (tag 3) that points at a registry (tag 4), which lists where each plugin is.
//!
//! This program writes numbers of its own on a collectible, as attributes: which item it is
//! (`item_id`, `rarity`, `serial`), `made` (the unix time it was minted), and for one a recipe
//! uses without burning it, `used` (how many times) and `used_at` (when last). The authority's
//! `set` never changes which item a collectible is, and keeps the other three unless it names
//! them.
use anchor_lang::prelude::*;

use crate::core_cpi::{digits, Attribute, MPL_CORE_ID, PLUGIN_ATTRIBUTES};

pub const ITEM_ID: &str = "item_id";
pub const MADE: &str = "made";
pub const USED: &str = "used";
pub const USED_AT: &str = "used_at";

/// Bytes read front to back. Every read is `None` past the end.
struct Bytes<'a>(&'a [u8]);

impl<'a> Bytes<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u32(&mut self) -> Option<usize> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?) as usize)
    }
    fn u64(&mut self) -> Option<usize> {
        usize::try_from(u64::from_le_bytes(self.take(8)?.try_into().ok()?)).ok()
    }
    /// A string: its length, then its bytes.
    fn str(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()?;
        self.take(n)
    }
}

/// The start of an asset: who holds it, the collection it is in, and its name. `rest` is
/// what follows the name.
struct Head<'a> {
    owner: Pubkey,
    collection: Option<Pubkey>,
    name: &'a [u8],
    rest: Bytes<'a>,
}

fn head(data: &[u8]) -> Option<Head<'_>> {
    let mut b = Bytes(data);
    if b.u8()? != 1 {
        return None;
    }
    let owner = Pubkey::try_from(b.take(32)?).ok()?;
    let collection = match b.u8()? {
        0 => None,
        2 => Some(Pubkey::try_from(b.take(32)?).ok()?),
        _ => {
            b.take(32)?;
            None
        }
    };
    let name = b.str()?;
    Some(Head { owner, collection, name, rest: b })
}

/// Who holds this collectible, or `None` when the account is not a Core asset (it was burned,
/// or it never was one).
pub fn holder(asset: &AccountInfo) -> Option<Pubkey> {
    if *asset.owner != MPL_CORE_ID {
        return None;
    }
    Some(head(&asset.try_borrow_data().ok()?)?.owner)
}

/// Whether `asset` is a collectible of the item called `item_name`, in `collection`, held by
/// `owner`. This program names every collectible "<item name> #<serial>".
pub fn is_one_of(asset: &AccountInfo, item_name: &str, owner: &Pubkey, collection: &Pubkey) -> bool {
    if *asset.owner != MPL_CORE_ID {
        return false;
    }
    let Ok(data) = asset.try_borrow_data() else { return false };
    let Some(head) = head(&data) else { return false };
    let serial = head.name.strip_prefix(item_name.as_bytes()).and_then(|rest| rest.strip_prefix(b" #"));
    head.owner == *owner
        && head.collection == Some(*collection)
        && serial.is_some_and(|digits| !digits.is_empty() && digits.iter().all(u8::is_ascii_digit))
}

/// Where each plugin of an asset or a collection is, by its Core plugin number. `b` is at
/// the plugin header: the header says where the registry is, the registry where the plugins
/// are. An account with nothing after its own fields has no plugins.
fn plugins(data: &[u8], mut b: Bytes) -> Option<Vec<(u8, usize)>> {
    if b.0.is_empty() {
        return Some(vec![]);
    }
    if b.u8()? != 3 {
        return None;
    }
    let mut registry = Bytes(data.get(b.u64()?..)?);
    if registry.u8()? != 4 {
        return None;
    }
    (0..registry.u32()?)
        .map(|_| {
            let plugin = registry.u8()?;
            if registry.u8()? == 3 {
                registry.take(32)?; // managed by an address
            }
            Some((plugin, registry.u64()?))
        })
        .collect()
}

/// Every attribute written on an asset, in order. `None` when it has no attribute list.
pub fn attributes(data: &[u8]) -> Option<Vec<Attribute>> {
    let mut b = head(data)?.rest;
    b.str()?; // its URI
    if b.u8()? == 1 {
        b.take(8)?; // its sequence number
    }
    let (_, at) = plugins(data, b)?.into_iter().find(|(plugin, _)| *plugin == PLUGIN_ATTRIBUTES)?;
    let mut list = Bytes(data.get(at..)?);
    if list.u8()? != PLUGIN_ATTRIBUTES {
        return None;
    }
    let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).ok();
    (0..list.u32()?).map(|_| Some(Attribute { key: text(list.str()?)?, value: text(list.str()?)? })).collect()
}

/// The Core plugin numbers a collection carries. A collection starts: a tag (5), its update
/// authority, its name, its URI, and two counts; its plugins follow as an asset's do. `None`
/// when the bytes are not a collection this program can read.
pub fn collection_plugins(data: &[u8]) -> Option<Vec<u8>> {
    let mut b = Bytes(data);
    if b.u8()? != 5 {
        return None;
    }
    b.take(32)?;
    b.str()?;
    b.str()?;
    b.take(8)?; // how many were minted, and how many exist
    Some(plugins(data, b)?.into_iter().map(|(plugin, _)| plugin).collect())
}

/// The number written under `key`. 0 when there is none, or it is not a number.
pub fn number(attributes: &[Attribute], key: &str) -> u32 {
    let Some(a) = attributes.iter().find(|a| a.key == key) else { return 0 };
    let mut n = 0u32;
    for digit in a.value.bytes() {
        let next = digit.is_ascii_digit().then(|| n.checked_mul(10)?.checked_add((digit - b'0') as u32)).flatten();
        let Some(next) = next else { return 0 };
        n = next;
    }
    n
}

/// Writes `value` under `key`, in place or at the end.
pub fn put(attributes: &mut Vec<Attribute>, key: &str, value: u32) {
    let mut buf = [0u8; 10];
    let value = String::from_utf8_lossy(digits(value, &mut buf)).into_owned();
    match attributes.iter_mut().find(|a| a.key == key) {
        Some(a) => a.value = value,
        None => attributes.push(Attribute { key: key.to_string(), value }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(key: &str, value: &str) -> Attribute {
        Attribute { key: key.into(), value: value.into() }
    }

    #[test]
    fn numbers_are_read_and_written_by_key() {
        let mut list = vec![attr("level", "7"), attr("made", "1700000000"), attr("name", "Bo"), attr("big", "4294967296")];
        assert_eq!(number(&list, "level"), 7);
        assert_eq!(number(&list, "made"), 1_700_000_000);
        assert_eq!(number(&list, "name"), 0, "not a number");
        assert_eq!(number(&list, "big"), 0, "too large to be one of ours");
        assert_eq!(number(&list, "missing"), 0);

        put(&mut list, "level", 8);
        put(&mut list, "used", u32::MAX);
        assert_eq!((number(&list, "level"), number(&list, "used"), list.len()), (8, u32::MAX, 5));
        assert_eq!(list[4], attr("used", "4294967295"));
    }

    #[test]
    fn bytes_that_are_not_an_asset_read_as_nothing() {
        assert!(head(&[]).is_none());
        assert!(head(&[5; 200]).is_none());
        assert!(attributes(&[1; 40]).is_none());
        let mut cut = vec![1u8];
        cut.extend_from_slice(&[7; 32]);
        cut.push(0);
        cut.extend_from_slice(&900u32.to_le_bytes()); // a name longer than the account
        assert!(head(&cut).is_none());
    }
}
