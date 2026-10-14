//! A recipe: a player hands things in and gets things back, with nobody's signature. Three
//! common swords into a rare one. A sword and 100 gold into an upgrade attempt. A fish into
//! coins. A mare and a stud, both kept, and a fee into a foal.
//!
//! What goes in: collectibles that are burned, collectibles that are used and kept, and
//! tokens. What comes out: new collectibles and tokens. Everything a recipe names happens, in
//! one transaction, or none of it does. For an outcome left to chance, a recipe gives a token
//! that a box is priced in (`LootBox::currency`), and the box rolls.
//!
//! A recipe of tokens only is an exchange at a fixed rate, and can be crafted many times at
//! once: 2 gems for 3 points, 500 times.
//!
//! A recipe can ask for a number the game wrote on a collectible (`Need`: a hero of level 10
//! or more), and a new collectible can take attributes from one handed in (`Keep`: a foal
//! with its mother's coat).
//!
//! The player owns what they hand in and signs, so a burned input is burned as its owner would
//! burn it (which a soulbound item never allows: it can be used, never burned).
//!
//! An item's `Life` says when a recipe can take one of it: not before it is ready, not after
//! it has expired, only so many times, only so often. The counts are written on the
//! collectible itself (`asset.rs`).
//!
//! An input is recognised by its name and by the item number written on it, so an item that
//! was given another's name is not taken for it. An item's name cannot change once one is
//! issued.
//!
//! Lines are carried out in order, inputs first: a pool a payment fills can pay an output of
//! the same craft, and a payment to whoever holds a collectible reaches them if it comes before
//! the line that burns that collectible.
//!
//! A recipe mints the game's collectibles and tokens and pays from its pools, so only the
//! owner writes one.
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::{
    asset,
    constants::*,
    core_cpi::{Attribute, Collectible, Core, MPL_CORE_ID},
    error::LootError,
    rail::*,
    receipts::*,
    rent::{load, save},
    state::*,
    tokens::{self, Tokens},
};

/// Where tokens a recipe gives come from.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Origin {
    /// Newly minted. The game must control the mint.
    Issue,
    /// The game's pool with this index.
    Pool(u8),
}

/// One thing a recipe takes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Input {
    /// `count` collectibles of this item, burned.
    Burn { item: u32, count: u8 },
    /// One collectible of this item, kept. It counts one of the uses its `Life` allows; with
    /// no `Life`, the player only has to hold one.
    Use { item: u32 },
    /// One collectible of this item, kept, with its uses counted from zero again: a repair,
    /// a refill.
    Renew { item: u32 },
    /// `amount` of a token, burned or sent where `to` says.
    Pay { mint: Pubkey, amount: u64, to: To },
}

/// One thing a recipe gives.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Output {
    /// One new collectible of this item.
    Item(u32),
    /// `amount` of a token, minted (for a mint the game controls) or paid from a pool.
    Tokens { mint: Pubkey, amount: u64, from: Origin },
    /// A share of what the game's pool with this index holds at that moment, in basis points:
    /// cash in a ticket for a tenth of the jackpot. A recipe that gives one is crafted once at
    /// a time.
    Share { mint: Pubkey, pool: u8, bps: u16 },
}

/// A number a recipe asks of a collectible handed in: the game's authority wrote `key` on it
/// (`set`), and it must be `at_least` this much.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct Need {
    /// Which collectible: the first handed in is 0, in the recipe's order.
    pub place: u8,
    pub key: String,
    pub at_least: u32,
}

/// An attribute a new collectible takes from one handed in.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct Keep {
    pub key: String,
    /// Which collectible handed in it comes from, and which collectible made it goes to: the
    /// first of each is 0.
    pub from: u8,
    pub to: u8,
}

/// At `["recipe", game, id]`.
#[account(discriminator = &[11])]
pub struct Recipe {
    pub game: Pubkey,
    pub id: u32,
    pub bump: u8,
    pub active: bool,
    /// Counts its edits. A player signs the version they saw, and crafts no other.
    pub version: u32,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    pub needs: Vec<Need>,
    pub keeps: Vec<Keep>,
}

/// The most lines a recipe has on each side, and the most needs and keeps.
pub const MAX_LINES: usize = 8;
/// The most collectibles one craft takes: each is an account of the transaction.
pub const MAX_INPUTS: usize = 8;

// ---------------------------------------------------------------- upsert_recipe

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecipeArgs {
    pub active: bool,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    pub needs: Vec<Need>,
    pub keeps: Vec<Keep>,
}

impl Recipe {
    /// How many collectibles it takes, and how many it makes.
    pub fn collectibles(inputs: &[Input], outputs: &[Output]) -> (usize, usize) {
        let taken = inputs.iter().map(|input| match *input {
            Input::Burn { count, .. } => count as usize,
            Input::Use { .. } | Input::Renew { .. } => 1,
            Input::Pay { .. } => 0,
        });
        (taken.sum(), outputs.iter().filter(|output| matches!(output, Output::Item(_))).count())
    }

    /// Crafted once at a time: it takes or makes a collectible, or gives a share of a pool.
    pub fn once_at_a_time(&self) -> bool {
        Recipe::collectibles(&self.inputs, &self.outputs) != (0, 0)
            || self.outputs.iter().any(|output| matches!(output, Output::Share { .. }))
    }
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct UpsertRecipe<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ LootError::NotOwner
    )]
    pub game: Account<'info, Game>,
    /// CHECK: the recipe's address. Read and written by hand because its size changes.
    #[account(mut, seeds = [RECIPE_SEED, game.key().as_ref(), &id.to_le_bytes()], bump)]
    pub recipe: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_upsert_recipe(ctx: Context<UpsertRecipe>, id: u32, args: RecipeArgs) -> Result<()> {
    let a = &ctx.accounts;
    let (taken, made) = Recipe::collectibles(&args.inputs, &args.outputs);
    let nothing = args.inputs.iter().any(|input| matches!(input, Input::Burn { count: 0, .. } | Input::Pay { amount: 0, .. }))
        || args.outputs.iter().any(|output| matches!(output, Output::Tokens { amount: 0, .. } | Output::Share { bps: 0, .. }));
    let too_much = args.outputs.iter().any(|output| matches!(output, Output::Share { bps, .. } if *bps as u64 > BPS));
    // A key is a name the game chose. The program's own numbers and labels are not carried over.
    let own = [asset::MADE, asset::USED, asset::USED_AT, asset::ITEM_ID, "rarity", "serial"];
    let twice = |i: usize, keep: &Keep| args.keeps[..i].iter().any(|k| (k.key.as_str(), k.to) == (keep.key.as_str(), keep.to));
    let key_ok = |key: &String| !key.is_empty() && key.len() <= MAX_NAME_LEN;
    require!(
        args.inputs.len() <= MAX_LINES
            && args.outputs.len() <= MAX_LINES
            && args.inputs.len() + args.outputs.len() > 0
            && taken <= MAX_INPUTS
            && !nothing
            && !too_much
            && args.needs.len() <= MAX_LINES
            && args.keeps.len() <= MAX_LINES
            && args.needs.iter().all(|need| (need.place as usize) < taken && key_ok(&need.key))
            && args.keeps.iter().enumerate().all(|(i, keep)| {
                (keep.from as usize) < taken && (keep.to as usize) < made && key_ok(&keep.key) && !own.contains(&keep.key.as_str()) && !twice(i, keep)
            }),
        LootError::BadRecipe
    );

    let old = load::<Recipe>(&a.recipe)?;
    let recipe = Recipe {
        game: a.game.key(),
        id,
        bump: ctx.bumps.recipe,
        active: args.active,
        version: old.map_or(0, |old| old.version + 1),
        inputs: args.inputs,
        outputs: args.outputs,
        needs: args.needs,
        keeps: args.keeps,
    };
    let game = a.game.key();
    let seeds: &[&[u8]] = &[RECIPE_SEED, game.as_ref(), &id.to_le_bytes(), &[recipe.bump]];
    save(&a.recipe, &recipe, seeds, &a.owner, &a.system_program)
}

// ---------------------------------------------------------------- craft

#[derive(Accounts)]
pub struct Craft<'info> {
    /// Owns what is handed in, pays the rent of what is made and gets the rent of what is burned.
    #[account(mut)]
    pub player: Signer<'info>,
    pub game: Account<'info, Game>,
    #[account(has_one = game, constraint = recipe.active @ LootError::NotForSale)]
    pub recipe: Account<'info, Recipe>,
    /// CHECK: the game's Core collection, by address.
    #[account(mut, address = game.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022, by address. Every call goes to the program that owns its mint.
    #[account(address = crate::tokens::TOKEN_2022_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub fee: Fee<'info>,
    // Then the accounts of each line, inputs first, in the recipe's order:
    //   Burn    the item, then each collectible handed in
    //   Use     the item, then the collectible (the same for Renew)
    //   Pay     the mint (writable), the player's token account, then what `to` needs (`rail::deliver`)
    //   Item    the item, then a new key the player made for the collectible (it signs)
    //   Tokens  the mint, the pool when they come from one, then the player's token account
    //   Share   the mint, the pool, then the player's token account
}

type Accounts<'a, 'info> = std::slice::Iter<'a, AccountInfo<'info>>;

fn next<'a, 'info>(accounts: &mut Accounts<'a, 'info>) -> Result<&'a AccountInfo<'info>> {
    Ok(accounts.next().ok_or(LootError::ItemMismatch)?)
}

/// The next account, which must be the game's item `id`.
fn next_item<'a, 'info>(accounts: &mut Accounts<'a, 'info>, game: &Pubkey, id: u32) -> Result<(&'a AccountInfo<'info>, Item)> {
    let account = next(accounts)?;
    let item = load::<Item>(account)?.filter(|item| item.game == *game && item.item_id == id);
    Ok((account, item.ok_or(LootError::ItemMismatch)?))
}

impl<'info> Craft<'info> {
    fn core<'a>(&'a self, asset: &'a AccountInfo<'info>, authority: &'a AccountInfo<'info>) -> Core<'a, 'info> {
        Core {
            program: &self.mpl_core_program,
            asset,
            collection: &self.collection,
            authority,
            payer: &self.player,
            system: &self.fee.system_program,
        }
    }

    /// Checks that `asset` is one of `item`, that the player holds it, and that it is ready
    /// and has not expired. Returns what is written on it.
    fn take(&self, asset: &AccountInfo, item: &Item, now: i64) -> Result<Vec<Attribute>> {
        require!(
            asset::is_one_of(asset, &item.name, &self.player.key(), &self.game.collection),
            LootError::ItemMismatch
        );
        let written = asset::attributes(&asset.try_borrow_data()?).unwrap_or_default();
        // By its number too: another item of the game can be given the same name.
        let id = written.iter().find(|a| a.key == asset::ITEM_ID).map(|_| asset::number(&written, asset::ITEM_ID));
        require!(id == Some(item.item_id), LootError::ItemMismatch);
        if let Some(life) = item.life {
            let age = now.saturating_sub(asset::number(&written, asset::MADE) as i64);
            require!(age >= life.ready_after as i64, LootError::NotReady);
            require!(life.lasts == 0 || age < life.lasts as i64, LootError::Expired);
        }
        Ok(written)
    }
}

/// Crafts recipe `version`, `times` over: takes every input and gives every output. A recipe
/// that takes or makes a collectible is crafted once at a time.
pub fn handle_craft<'info>(ctx: Context<'info, Craft<'info>>, version: u32, times: u64) -> Result<()> {
    let a = &ctx.accounts;
    let recipe = &a.recipe;
    a.game.open_for_money()?;
    require!(recipe.version == version, LootError::RecipeChanged);
    require!(times > 0, LootError::ZeroAmount);
    require!(times == 1 || !recipe.once_at_a_time(), LootError::OnceAtATime);
    let many = |amount: u64| amount.checked_mul(times).ok_or(LootError::Overflow);
    a.fee.charge_player(&a.game, &a.player)?;

    let now = Clock::get()?.unix_timestamp;
    let game = a.game.key();
    let game_account = a.game.to_account_info();
    let game_signer: &[&[u8]] = &[GAME_SEED, a.game.collection.as_ref(), &[a.game.bump]];
    let accounts = &mut ctx.remaining_accounts.iter();
    let tokens = Tokens { token: &a.token_program, token_2022: &a.token_2022_program, hook: ctx.remaining_accounts };
    let (mut burned, mut used, mut made) = (vec![], vec![], vec![]);
    // Every collectible handed in, in order, with what was written on it. One collectible
    // fills one place: a foal has two parents, and a tool is not also fuel.
    let mut places: Vec<(Pubkey, Vec<Attribute>)> = vec![];
    let mut hand_in = |asset: &AccountInfo, item: &Item| -> Result<Vec<Attribute>> {
        let written = a.take(asset, item, now)?;
        require!(places.iter().all(|(taken, _)| taken != asset.key), LootError::ItemMismatch);
        for need in recipe.needs.iter().filter(|need| need.place as usize == places.len()) {
            require!(asset::number(&written, &need.key) >= need.at_least, LootError::NeedNotMet);
        }
        places.push((asset.key(), written.clone()));
        Ok(written)
    };

    for input in &recipe.inputs {
        match *input {
            Input::Burn { item, count } => {
                let (_, item) = next_item(accounts, &game, item)?;
                for _ in 0..count {
                    let asset = next(accounts)?;
                    hand_in(asset, &item)?;
                    a.core(asset, &a.player).burn(&[])?;
                    burned.push(asset.key());
                }
            }
            Input::Use { item } => {
                let (_, item) = next_item(accounts, &game, item)?;
                let asset = next(accounts)?;
                let mut written = hand_in(asset, &item)?;
                used.push(asset.key());
                if let Some(life) = item.life.filter(|life| life.uses > 0 || life.cooldown > 0) {
                    let times_used = asset::number(&written, asset::USED);
                    let since = now.saturating_sub(asset::number(&written, asset::USED_AT) as i64);
                    require!(life.uses == 0 || times_used < life.uses, LootError::UsedUp);
                    // Counted from its last use even after a `Renew`: a repair is not a turn.
                    let ever = written.iter().any(|a| a.key == asset::USED_AT);
                    require!(!ever || since >= life.cooldown as i64, LootError::NotReady);
                    asset::put(&mut written, asset::USED, times_used.saturating_add(1));
                    asset::put(&mut written, asset::USED_AT, now as u32);
                    a.core(asset, &game_account).set_attributes(&written, &[game_signer])?;
                }
            }
            Input::Renew { item } => {
                let (_, item) = next_item(accounts, &game, item)?;
                let asset = next(accounts)?;
                let mut written = hand_in(asset, &item)?;
                used.push(asset.key());
                asset::put(&mut written, asset::USED, 0);
                a.core(asset, &game_account).set_attributes(&written, &[game_signer])?;
            }
            Input::Pay { mint, amount, to } => {
                let (mint_account, from) = (next(accounts)?, next(accounts)?);
                require_keys_eq!(mint_account.key(), mint, LootError::WrongMint);
                require_keys_eq!(tokens::holding(from)?.mint, mint, LootError::WrongMint);
                let payment = Payment {
                    game,
                    tokens: &tokens,
                    mint: mint_account,
                    from,
                    owner: &a.player,
                    signer: &[],
                    treasury: from, // unused: nothing is left over here
                };
                deliver(&payment, to, many(amount)?, accounts)?;
            }
        }
    }

    for output in &recipe.outputs {
        match *output {
            Output::Item(id) => {
                let (account, item) = next_item(accounts, &game, id)?;
                let asset = next(accounts)?;
                require!(item.kind == ItemKind::Collectible, LootError::NotCollectible);
                require!(item.active, LootError::NotForSale);
                require!(item.has_stock(), LootError::SoldOut);
                let serial = ItemView::read(account)?.issue(account)?;
                a.core(asset, &game_account).mint(&a.player, &Collectible::of(&item, serial, game)?, &[game_signer])?;

                // What it takes from the collectibles handed in, when they have it.
                let mut written = asset::attributes(&asset.try_borrow_data()?).unwrap_or_default();
                let before = written.len();
                for keep in recipe.keeps.iter().filter(|keep| keep.to as usize == made.len()) {
                    let from = &places[keep.from as usize].1;
                    written.extend(from.iter().filter(|a| a.key == keep.key).cloned());
                }
                if written.len() > before {
                    a.core(asset, &game_account).set_attributes(&written, &[game_signer])?;
                }
                made.push(asset.key());
            }
            Output::Tokens { mint, amount, from } => {
                let mint_account = next(accounts)?;
                require_keys_eq!(mint_account.key(), mint, LootError::WrongMint);
                match from {
                    Origin::Issue => tokens.mint(&a.game, mint_account, next(accounts)?, many(amount)?)?,
                    Origin::Pool(index) => {
                        let pool = next(accounts)?;
                        require_keys_eq!(pool.key(), pool_address(&game, index), LootError::WrongPool);
                        require_keys_eq!(tokens::holding(pool)?.mint, mint, LootError::WrongPool);
                        tokens.send(&a.game, mint_account, pool, next(accounts)?, many(amount)?)?
                    }
                }
            }
            Output::Share { mint, pool: index, bps } => {
                let mint_account = next(accounts)?;
                require_keys_eq!(mint_account.key(), mint, LootError::WrongMint);
                let pool = next(accounts)?;
                require_keys_eq!(pool.key(), pool_address(&game, index), LootError::WrongPool);
                let holds = tokens::holding(pool)?;
                require_keys_eq!(holds.mint, mint, LootError::WrongPool);
                let amount = crate::pick::share(holds.amount, bps).ok_or(LootError::Overflow)?;
                let to = next(accounts)?;
                if amount > 0 {
                    tokens.send(&a.game, mint_account, pool, to, amount)?;
                }
            }
        }
    }

    emit!(Crafted { game, id: recipe.id, version, player: a.player.key(), times, burned, used, made });
    Ok(())
}
