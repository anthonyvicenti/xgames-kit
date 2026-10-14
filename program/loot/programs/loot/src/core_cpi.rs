//! The four Metaplex Core calls this program makes: mint a collectible into the game's
//! collection, burn one, rewrite one's attributes, and hand one to a new owner. The
//! instructions are written out by hand so the program does not link the `mpl-core` crate
//! (38 KB of the binary, which is rent); the
//! tests below build the same instructions with that crate and compare every byte and account.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

pub const MPL_CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

// Core's instruction numbers.
const UPDATE_PLUGIN_V1: u8 = 6;
const BURN_V1: u8 = 12;
const TRANSFER_V1: u8 = 14;
const CREATE_V2: u8 = 20;
// Core's plugin numbers.
const PLUGIN_PERMANENT_FREEZE_DELEGATE: u8 = 5;
pub const PLUGIN_ATTRIBUTES: u8 = 6;
const PLUGIN_PERMANENT_BURN_DELEGATE: u8 = 8;

/// One line on a collectible: "level" = "7".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Attribute {
    pub key: String,
    pub value: String,
}

/// What a new collectible is minted with.
pub struct Collectible<'a> {
    pub name: &'a str,
    pub uri: &'a str,
    pub item_id: u32,
    pub rarity: u8,
    pub serial: u32,
    /// The unix time it is minted at. A recipe counts an item's age from here.
    pub made: u32,
    /// Frozen for good: it can never be transferred.
    pub soulbound: bool,
    /// Who may burn it later, whoever owns it: the game, for a burnable item.
    pub burner: Option<Pubkey>,
}

impl<'a> Collectible<'a> {
    /// The next one of `item`, with the serial number it was just given.
    pub fn of(item: &'a crate::state::Item, serial: u32, game: Pubkey) -> Result<Self> {
        Ok(Collectible {
            name: &item.name,
            uri: &item.uri,
            item_id: item.item_id,
            rarity: item.rarity,
            serial,
            made: Clock::get()?.unix_timestamp as u32,
            soulbound: item.soulbound,
            burner: item.burnable.then_some(game),
        })
    }
}

/// The accounts every Core call takes.
pub struct Core<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub asset: &'a AccountInfo<'info>,
    pub collection: &'a AccountInfo<'info>,
    /// Who signs. Usually the game, as an update delegate of the collection: the collection's
    /// owner grants that, and can take it back; without it Core refuses the call. In a craft,
    /// the player who owns the asset being burned.
    pub authority: &'a AccountInfo<'info>,
    /// Pays the asset's rent, or gets it back.
    pub payer: &'a AccountInfo<'info>,
    pub system: &'a AccountInfo<'info>,
}

impl<'info> Core<'_, 'info> {
    /// Mints a new asset to `owner`.
    pub fn mint(&self, owner: &AccountInfo<'info>, c: &Collectible, signers: &[&[&[u8]]]) -> Result<()> {
        let ix = Instruction {
            program_id: MPL_CORE_ID,
            accounts: create_metas(self.asset.key(), self.collection.key(), self.authority.key(), self.payer.key(), owner.key(), self.system.key()),
            data: create_data(c),
        };
        let accounts = [self.program, self.asset, self.collection, self.authority, self.payer, owner, self.system];
        Ok(invoke_signed(&ix, &accounts.map(Clone::clone), signers)?)
    }

    /// Burns the asset. Core allows it for the asset's owner, and for the game when it is the
    /// asset's permanent burn delegate.
    pub fn burn(&self, signers: &[&[&[u8]]]) -> Result<()> {
        self.edit(vec![BURN_V1, 0], signers) // 0: no compression proof
    }

    /// Replaces the asset's whole attribute list.
    pub fn set_attributes(&self, attributes: &[Attribute], signers: &[&[&[u8]]]) -> Result<()> {
        self.edit(set_attributes_data(attributes), signers)
    }

    /// Hands the asset to `new_owner`. Core allows it for the asset's owner, and never for a
    /// soulbound one.
    pub fn transfer(&self, new_owner: &AccountInfo<'info>, signers: &[&[&[u8]]]) -> Result<()> {
        let ix = Instruction {
            program_id: MPL_CORE_ID,
            accounts: transfer_metas(self.asset.key(), self.collection.key(), self.payer.key(), self.authority.key(), new_owner.key(), self.system.key()),
            data: vec![TRANSFER_V1, 0], // 0: no compression proof
        };
        let accounts = [self.program, self.asset, self.collection, self.payer, self.authority, new_owner, self.system];
        Ok(invoke_signed(&ix, &accounts.map(Clone::clone), signers)?)
    }

    /// Burn and update take the same accounts.
    fn edit(&self, data: Vec<u8>, signers: &[&[&[u8]]]) -> Result<()> {
        let ix = Instruction {
            program_id: MPL_CORE_ID,
            accounts: edit_metas(self.asset.key(), self.collection.key(), self.payer.key(), self.authority.key(), self.system.key()),
            data,
        };
        let accounts = [self.program, self.asset, self.collection, self.payer, self.authority, self.system];
        Ok(invoke_signed(&ix, &accounts.map(Clone::clone), signers)?)
    }
}

// ---------------------------------------------------------------- the bytes

fn put_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s);
}

/// Decimal digits of `n`, without the formatting machinery.
pub fn digits(mut n: u32, buf: &mut [u8; 10]) -> &[u8] {
    let mut at = buf.len();
    loop {
        at -= 1;
        buf[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return &buf[at..];
        }
    }
}

/// `CreateV2`: the asset is named "<item name> #<serial>" and carries the item id, rarity,
/// serial and the time it was made as attributes.
pub fn create_data(c: &Collectible) -> Vec<u8> {
    let mut buf = [0u8; 10];
    let mut d = Vec::with_capacity(200 + c.name.len() + c.uri.len());
    d.push(CREATE_V2);
    d.push(0); // stored in the account itself
    let serial = digits(c.serial, &mut buf);
    d.extend_from_slice(&((c.name.len() + 2 + serial.len()) as u32).to_le_bytes());
    d.extend_from_slice(c.name.as_bytes());
    d.extend_from_slice(b" #");
    d.extend_from_slice(serial);
    put_str(&mut d, c.uri.as_bytes());

    d.push(1); // plugins: some
    d.extend_from_slice(&(1 + c.soulbound as u32 + c.burner.is_some() as u32).to_le_bytes());
    d.push(PLUGIN_ATTRIBUTES);
    d.extend_from_slice(&4u32.to_le_bytes());
    for (key, value) in [("item_id", c.item_id), ("rarity", c.rarity as u32), ("serial", c.serial), (crate::asset::MADE, c.made)] {
        put_str(&mut d, key.as_bytes());
        let mut buf = [0u8; 10];
        put_str(&mut d, digits(value, &mut buf));
    }
    d.push(0); // managed by: the default, the collection's update authority
    if c.soulbound {
        d.push(PLUGIN_PERMANENT_FREEZE_DELEGATE);
        d.push(1); // frozen
        d.push(0); // managed by: the default
    }
    if let Some(burner) = c.burner {
        d.push(PLUGIN_PERMANENT_BURN_DELEGATE);
        d.push(1); // managed by: some
        d.push(3); // an address
        d.extend_from_slice(burner.as_ref());
    }
    d.push(0); // external plugins: none
    d
}

/// `UpdatePluginV1` with the attributes plugin.
pub fn set_attributes_data(attributes: &[Attribute]) -> Vec<u8> {
    let mut d = vec![UPDATE_PLUGIN_V1, PLUGIN_ATTRIBUTES];
    d.extend_from_slice(&(attributes.len() as u32).to_le_bytes());
    for a in attributes {
        put_str(&mut d, a.key.as_bytes());
        put_str(&mut d, a.value.as_bytes());
    }
    d
}

/// The accounts `CreateV2` takes, in its order. Core reads its own program id as "not given".
pub fn create_metas(asset: Pubkey, collection: Pubkey, authority: Pubkey, payer: Pubkey, owner: Pubkey, system: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(asset, true),
        AccountMeta::new(collection, false),
        AccountMeta::new_readonly(authority, true),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(owner, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // update authority: the collection's
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper
    ]
}

/// The accounts `BurnV1` and `UpdatePluginV1` take.
pub fn edit_metas(asset: Pubkey, collection: Pubkey, payer: Pubkey, authority: Pubkey, system: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(asset, false),
        AccountMeta::new(collection, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(authority, true),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper
    ]
}

/// The accounts `TransferV1` takes.
pub fn transfer_metas(asset: Pubkey, collection: Pubkey, payer: Pubkey, authority: Pubkey, new_owner: Pubkey, system: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(asset, false),
        AccountMeta::new_readonly(collection, false),
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(authority, true),
        AccountMeta::new_readonly(new_owner, false),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // log wrapper
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use mpl_core::instructions::{BurnV1Builder, CreateV2Builder, TransferV1Builder, UpdatePluginV1Builder};
    use mpl_core::types::{Attribute as CoreAttribute, Attributes, PermanentBurnDelegate, PermanentFreezeDelegate, Plugin, PluginAuthority, PluginAuthorityPair};

    /// The same mint, built by the mpl-core crate itself.
    fn reference(c: &Collectible, keys: &[Pubkey; 6]) -> Instruction {
        let mut plugins = vec![PluginAuthorityPair {
            plugin: Plugin::Attributes(Attributes {
                attribute_list: vec![
                    CoreAttribute { key: "item_id".into(), value: c.item_id.to_string() },
                    CoreAttribute { key: "rarity".into(), value: c.rarity.to_string() },
                    CoreAttribute { key: "serial".into(), value: c.serial.to_string() },
                    CoreAttribute { key: "made".into(), value: c.made.to_string() },
                ],
            }),
            authority: None,
        }];
        if c.soulbound {
            plugins.push(PluginAuthorityPair {
                plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }),
                authority: None,
            });
        }
        if let Some(address) = c.burner {
            plugins.push(PluginAuthorityPair {
                plugin: Plugin::PermanentBurnDelegate(PermanentBurnDelegate {}),
                authority: Some(PluginAuthority::Address { address }),
            });
        }
        let name = format!("{} #{}", c.name, c.serial);
        CreateV2Builder::new()
            .asset(keys[0])
            .collection(Some(keys[1]))
            .authority(Some(keys[2]))
            .payer(keys[3])
            .owner(Some(keys[4]))
            .system_program(keys[5])
            .name(name.chars().take(64).collect())
            .uri(c.uri.to_string())
            .plugins(plugins)
            .instruction()
    }

    #[test]
    fn create_v2_is_byte_for_byte_what_the_mpl_core_crate_builds() {
        assert_eq!(MPL_CORE_ID, mpl_core::ID);
        let keys: [Pubkey; 6] = std::array::from_fn(|_| Pubkey::new_unique());
        let long_name = "N".repeat(32);
        let long_uri = "u".repeat(200);
        let cases = [
            ("Gecko Crown", "https://example.invalid/gecko-crown.json", 1, 3, 1, false),
            ("Founder Badge", "https://example.invalid/badge.json", 3, 0, 42, true),
            ("", "", 0, 0, 0, false),
            (long_name.as_str(), long_uri.as_str(), u32::MAX, u8::MAX, u32::MAX, true),
            ("Ünïcödé ✦", "ipfs://x", 4_000_000_000, 9, 1_000_000_007, false),
        ];
        for (i, (name, uri, item_id, rarity, serial, soulbound)) in cases.into_iter().enumerate() {
            let burner = (i % 2 == 1).then(|| keys[2]);
            let c = Collectible { name, uri, item_id, rarity, serial, made: 1_700_000_000 + i as u32, soulbound, burner };
            let want = reference(&c, &keys);
            assert_eq!(create_data(&c), want.data, "{name}");
            assert_eq!(
                create_metas(keys[0], keys[1], keys[2], keys[3], keys[4], keys[5]),
                want.accounts
            );
            assert_eq!(want.program_id, MPL_CORE_ID);
        }
        // The longest name an item can have stays under Core's 64 characters with any serial.
        assert!(32 + 2 + 10 <= 64);
    }

    #[test]
    fn burn_and_set_attributes_are_what_the_mpl_core_crate_builds() {
        let [asset, collection, payer, authority, system]: [Pubkey; 5] = std::array::from_fn(|_| Pubkey::new_unique());
        let metas = edit_metas(asset, collection, payer, authority, system);

        let burn = BurnV1Builder::new()
            .asset(asset)
            .collection(Some(collection))
            .payer(payer)
            .authority(Some(authority))
            .system_program(Some(system))
            .instruction();
        assert_eq!((burn.data, burn.accounts), (vec![BURN_V1, 0], metas.clone()));

        let new_owner = Pubkey::new_unique();
        let transfer = TransferV1Builder::new()
            .asset(asset)
            .collection(Some(collection))
            .payer(payer)
            .authority(Some(authority))
            .new_owner(new_owner)
            .system_program(Some(system))
            .instruction();
        assert_eq!(
            (transfer.data, transfer.accounts),
            (vec![TRANSFER_V1, 0], transfer_metas(asset, collection, payer, authority, new_owner, system))
        );

        let list = vec![
            Attribute { key: "level".into(), value: "7".into() },
            Attribute { key: "".into(), value: "Ünïcödé ✦".into() },
        ];
        for attributes in [vec![], list] {
            let update = UpdatePluginV1Builder::new()
                .asset(asset)
                .collection(Some(collection))
                .payer(payer)
                .authority(Some(authority))
                .system_program(system)
                .plugin(Plugin::Attributes(Attributes {
                    attribute_list: attributes
                        .iter()
                        .map(|a| CoreAttribute { key: a.key.clone(), value: a.value.clone() })
                        .collect(),
                }))
                .instruction();
            assert_eq!((update.data, update.accounts), (set_attributes_data(&attributes), metas.clone()));
        }
    }

    #[test]
    fn digits_of_every_width() {
        for n in [0u32, 1, 9, 10, 99, 100, 12_345, 999_999_999, 1_000_000_000, u32::MAX] {
            let mut buf = [0u8; 10];
            assert_eq!(digits(n, &mut buf), n.to_string().as_bytes());
        }
    }
}
