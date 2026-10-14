// The games.fun loot program 0.3 ("Economy for Anything"): addresses, one builder per instruction, the order helpers
// the shop uses (buy, open a box, settle, refund), account readers, receipts and odds. Shared by the dev server and
// the in-game kit, so it is plain ES modules with no Node import and no Solana SDK.
//
// Ported from games.fun launchpad/loot at commit 905eb7e63 (MIT, games.fun's own): client/codec.mjs for the encoding,
// devnet-e2e-0.3.mjs for the accounts each instruction takes (it passed on devnet on 2026-10-11), and the program's
// own source (programs/loot/src) for the accounts that follow an instruction's named ones. Read PROGRAM-0.3.md there
// for what each instruction does and who may sign it.
//
// Conventions:
// - Each `<name>Ix` builds one instruction ({ programId, keys, data }). Parameters are camelCase; arguments that are
//   IDL structs or enums (ItemArgs, BoxArgs, Share, Outcome…) take the IDL's own field names, exactly as the
//   readers return them: { kind: 'Collectible', max_supply: 0, shares: [{ to: { Pool: [0] }, bps: 2000 }] }.
// - Token accounts default to associated token accounts; pass `tokenProgram` (TOKEN_2022_PROGRAM for a Token-2022
//   mint) so they derive right, or pass the account itself.
// - `remaining`: what follows the named accounts, as the instruction says (split targets, box entries, recipe
//   lines), then `extras` (token2022.js: the Memo program and a transfer hook's accounts for a Token-2022 mint).
import { addressBytes } from './base58.js';
import { decodeAccount, decodeBorsh, decodeEvents, encodeBorsh, encodeInstruction } from './borsh.js';
import { concat, randomBytes, readUintLE, uintLE, utf8 } from './bytes.js';
import LOOT_IDL from './loot-idl.js';
import { associatedTokenAddress, pdaOf, TOKEN_PROGRAM } from './pda.js';
import { computeUnitLimit, meta } from './programs.js';
import { sha256 } from './sha256.js';

export { LOOT_IDL };
export const LOOT_PROGRAM = LOOT_IDL.address;
/** MagicBlock's VRF program and its base-layer oracle queue (the same addresses on devnet and mainnet). */
export const VRF_PROGRAM = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const VRF_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Pubkey::default(): "none" where the program takes an address (a lottery's ticket mint). */
export const NO_ADDRESS = '11111111111111111111111111111111';

const constant = (name) => {
  const value = LOOT_IDL.constants.find((c) => c.name === name)?.value;
  if (value === undefined) throw new Error(`The loot IDL has no constant ${name}`);
  return value;
};
const seed = (name) => Uint8Array.from(JSON.parse(constant(name)));

/** Whole (10,000 basis points): a share of a payment, a pool or a pot. */
export const BPS = 10_000;
/** An order the oracle never rolled may be refunded after this many slots (about 10 minutes). */
export const STALE_SLOTS = BigInt(constant('STALE_SLOTS'));
/** A rolled order nobody settled may be refunded after this many slots (7 days). */
export const ROLLED_REFUND_SLOTS = BigInt(constant('ROLLED_REFUND_SLOTS'));
/** SOL an order holds in its escrow until it ends (the collectible's rent); the player gets back what is left. */
export const ESCROW_LAMPORTS = BigInt(constant('ESCROW_LAMPORTS'));
/** The two flat fees the program starts with (the platform account holds the ones in force: `currentFees`). */
export const PLAYER_FEE_LAMPORTS = BigInt(constant('PLAYER_FEE_LAMPORTS'));
export const PROJECT_FEE_LAMPORTS = BigInt(constant('PROJECT_FEE_LAMPORTS'));

export const ItemKind = Object.freeze({ Normal: 'Normal', Collectible: 'Collectible' });
export const OrderStatus = Object.freeze({ Pending: 'Pending', Rolled: 'Rolled', Failed: 'Failed' });
/** Account type names as the IDL has them (for decodeLoot). */
export const LootAccount = Object.freeze({
  Platform: 'Platform', Game: 'Game', Item: 'Item', Box: 'LootBox', Order: 'Order', Schedule: 'Schedule', Lottery: 'Lottery',
  Stake: 'Stake', Recipe: 'Recipe', Hold: 'Hold', Contest: 'Contest', Entry: 'Entry',
});

// ---------------------------------------------------------------- addresses

const u8 = (n) => Uint8Array.of(n);
const u32 = (n) => uintLE(n, 4);
const u64 = (n) => uintLE(n, 8);
const key = addressBytes;
const find = (...seeds) => pdaOf(seeds, LOOT_PROGRAM);

/** The program's derived addresses. */
export const lootPda = {
  platform: () => find(seed('PLATFORM_SEED')),
  game: (collection) => find(seed('GAME_SEED'), key(collection)),
  /** The game's fee box: every fee its players and keys pay lands here until games.fun's admin collects it. */
  fees: (game) => find(seed('FEES_SEED'), key(game)),
  pool: (game, index) => find(seed('POOL_SEED'), key(game), u8(index)),
  item: (game, itemId) => find(seed('ITEM_SEED'), key(game), u32(itemId)),
  box: (game, boxId) => find(seed('BOX_SEED'), key(game), u32(boxId)),
  order: (game, player, nonce) => find(seed('ORDER_SEED'), key(game), key(player), u64(nonce)),
  escrow: (order) => find(seed('ESCROW_SEED'), key(order)),
  /** A collectible's address includes the slot its order was paid in (Order.requested_slot). */
  asset: (order, slot) => find(seed('ASSET_SEED'), key(order), u64(slot)),
  schedule: (game, id) => find(seed('SCHEDULE_SEED'), key(game), u32(id)),
  lottery: (game, id) => find(seed('LOTTERY_SEED'), key(game), u32(id)),
  stake: (game, id) => find(seed('STAKE_SEED'), key(game), u32(id)),
  staked: (stake) => find(seed('STAKED_SEED'), key(stake)),
  rewards: (stake) => find(seed('REWARDS_SEED'), key(stake)),
  position: (stake, player) => find(seed('POSITION_SEED'), key(stake), key(player)),
  recipe: (game, id) => find(seed('RECIPE_SEED'), key(game), u32(id)),
  hold: (asset) => find(seed('HOLD_SEED'), key(asset)),
  contest: (game, id) => find(seed('CONTEST_SEED'), key(game), u32(id)),
  entry: (contest, player, side) => find(seed('ENTRY_SEED'), key(contest), key(player), u8(side)),
  pot: (contest) => find(seed('POT_SEED'), key(contest)),
  vrfIdentity: () => find(utf8('identity')),
  programData: () => pdaOf([key(LOOT_PROGRAM)], BPF_UPGRADEABLE_LOADER),
};

/**
 * Whether a live game ({ game, collection }) is this program's. One put live on an earlier deploy (0.3 at 88Labq6t…,
 * before the audit of 2026-10-12) is not: its game is that program's address for the collection, not this one's.
 */
export const onThisProgram = (live) => Boolean(live?.game && live.collection) && lootPda.game(live.collection) === live.game;

/** `owner`'s associated token account for `mint` under `tokenProgram` (owner may be a PDA: a game's vault). */
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => associatedTokenAddress(owner, mint, tokenProgram);

// ---------------------------------------------------------------- any instruction

/** Accounts every instruction that names them takes at the same address (the fee box: the game's). */
const DEFAULT_ACCOUNTS = {
  platform: () => lootPda.platform(),
  fees: (given) => given.game && lootPda.fees(given.game),
  program_identity: () => lootPda.vrfIdentity(),
  oracle_queue: () => VRF_QUEUE,
};

/**
 * Any loot instruction from its IDL entry. `accounts` names each account by its IDL name (snake_case); nested groups
 * (an order's `checkout`, a fee's `fee`) are flattened; fixed addresses, the platform, the game's fee box and the
 * oracle fill themselves; an optional account left out is passed as the program's own address (Anchor's "None").
 */
export function lootIx(name, args, accounts = {}, remaining = []) {
  const def = LOOT_IDL.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`Unknown loot instruction ${name}`);
  const keys = [];
  const walk = (list) => {
    for (const a of list) {
      if (a.accounts) {
        walk(a.accounts);
        continue;
      }
      const pubkey = accounts[a.name] ?? a.address ?? DEFAULT_ACCOUNTS[a.name]?.(accounts);
      if (pubkey) keys.push(meta(pubkey, a.signer === true, a.writable === true));
      else if (a.optional) keys.push(meta(LOOT_PROGRAM, false, false));
      else throw new Error(`${name}: missing account ${a.name}`);
    }
  };
  walk(def.accounts);
  return { programId: LOOT_PROGRAM, keys: [...keys, ...remaining], data: encodeInstruction(LOOT_IDL, name, args) };
}

/** 32 bytes the game names a call by (a match id, a payout's reason). Zeros when not given. */
const ref = (reference) => {
  const bytes = reference ? Uint8Array.from(reference) : new Uint8Array(32);
  if (bytes.length !== 32) throw new Error('A reference is 32 bytes.');
  return bytes;
};

// ---------------------------------------------------------------- the platform (games.fun's admin only)

/** fees: { player, project } in lamports. Signed by the program's upgrade authority. */
export const initPlatformIx = ({ admin, fees, partner }) =>
  lootIx('init_platform', { fees, partner }, { admin, program_data: lootPda.programData() });
/** A raise of either fee waits 7 days; anything else applies at once. A new admin (`newAdmin`) signs too. */
export const setPlatformIx = ({ admin, fees, newAdmin = admin }) => lootIx('set_platform', { fees }, { admin, next_admin: newAdmin });
/** Takes what the platform record and each game's fee box hold above their rent. `games`: the games to sweep. */
export const collectFeesIx = ({ admin, to, games = [] }) =>
  lootIx('collect_fees', {}, { admin, to }, games.flatMap((game) => [meta(game, false, false), meta(lootPda.fees(game), false, true)]));
/** Stops new purchases and payments in a game; never a settle, refund or unstake. */
export const setSuspendedIx = ({ admin, game, suspended }) => lootIx('set_suspended', { suspended }, { admin, game });

// ---------------------------------------------------------------- a game: its record, pools and catalog (the owner)

/**
 * A game for a Core collection, priced in `mint`, paying sales into `treasury`; `authority` signs payouts. The owner
 * also pays the rent of the game's fee box (`lootPda.fees`, 0.00065 SOL). The treasury can't be the game's vault.
 */
export const createGameIx = ({ owner, authority = owner, collection, mint, treasury }) =>
  lootIx('create_game', { authority }, { owner, game: lootPda.game(collection), collection, mint, treasury });
/**
 * update: { authority, paused }, each null to keep it. `treasury`: the new one, or the current one. `newOwner`: hands
 * the game to that key, which signs too.
 */
export const updateGameIx = ({ owner, game, treasury, update = {}, newOwner }) =>
  lootIx('update_game', { update: { authority: null, paused: null, ...update } }, { owner, game, treasury, new_owner: newOwner });
/** A pool: a token account of `mint` only the game spends from, at index 0–255. */
export const openPoolIx = ({ owner, game, index, mint }) => lootIx('open_pool', { index }, { owner, game, mint, pool: lootPda.pool(game, index) });
/** Closes an empty pool; its rent goes to the owner. */
export const closePoolIx = ({ owner, game, index, mint }) => lootIx('close_pool', { index }, { owner, game, pool: lootPda.pool(game, index), mint });

/** ItemArgs with defaults: a collectible, common, for sale at `price` (0: boxes and recipes only), unlimited, no split. */
export const itemArgs = (args) => ({
  kind: ItemKind.Collectible, rarity: 0, soulbound: false, burnable: false, max_supply: 0, price: 0n,
  rise: null, fall: null, life: null, active: true, shares: [], ...args, price: BigInt(args.price ?? 0n),
});
export const upsertItemIx = ({ owner, game, itemId, args }) =>
  lootIx('upsert_item', { item_id: itemId, args: itemArgs(args) }, { owner, game, item: lootPda.item(game, itemId) });

/** A drop entry: { outcome: { Item: [id] } | { Pay: { pool, amount } } | { Share: { pool, bps } } | 'Burn' | 'Nothing', weight }. */
export const boxArgs = (args) => ({
  currency: null, rise: null, fall: null, stock_odds: false, active: true, shares: [], ...args, price: BigInt(args.price),
});
export const upsertBoxIx = ({ owner, game, boxId, args }) =>
  lootIx('upsert_box', { box_id: boxId, args: boxArgs(args) }, { owner, game, loot_box: lootPda.box(game, boxId) });

/** args: { active, action: { Issue: { mint, pool, amount, halve_every } } | { Burn: { pool, bps } } | { Move: { from, to, bps } }, every, next_at, max_runs }. */
export const upsertScheduleIx = ({ owner, game, id, args }) =>
  lootIx('upsert_schedule', { id, args: { active: true, max_runs: 0, ...args } }, { owner, game, schedule: lootPda.schedule(game, id) });
/** args: { price, pot, cut_bps, places (bps each, up to 8; default one place of 100%), ticket_mint, every, draws_at }. */
export const upsertLotteryIx = ({ owner, game, id, args }) =>
  lootIx('upsert_lottery', { id, args: { cut_bps: 0, places: [BPS], ticket_mint: NO_ADDRESS, ...args } }, { owner, game, lottery: lootPda.lottery(game, id) });
/** args: { active, inputs: [Input], outputs: [Output], needs: [Need], keeps: [Keep] }. */
export const upsertRecipeIx = ({ owner, game, id, args }) =>
  lootIx('upsert_recipe', { id, args: { active: true, needs: [], keeps: [], ...args } }, { owner, game, recipe: lootPda.recipe(game, id) });
/** A stake of `mint` that shares what flows into pool `rewardsPool` (of `rewardsMint`); `lock` in seconds. */
export const openStakeIx = ({ owner, game, id, mint, rewardsMint, rewardsPool, lock = 0n }) => {
  const stake = lootPda.stake(game, id);
  return lootIx('open_stake', { id, rewards_pool: rewardsPool, lock: BigInt(lock) }, {
    owner, game, stake, mint, rewards_mint: rewardsMint, staked_vault: lootPda.staked(stake), rewards_vault: lootPda.rewards(stake),
  });
};

// ---------------------------------------------------------------- in: a player pays

/** Pay `amount` of `mint` to the game, split by `shares` (remaining: their targets, then extras). */
export const payIx = ({ player, game, mint, treasury, amount, shares = [], reference, playerToken, tokenProgram, remaining = [] }) =>
  lootIx('pay', { amount: BigInt(amount), shares, reference: ref(reference) }, { player, game, mint, player_token: playerToken ?? ata(player, mint, tokenProgram), treasury }, remaining);
/** Fund pool `index` (a sponsor, the project). Charged the project fee. */
export const depositIx = ({ depositor, game, index, mint, from, amount, tokenProgram, remaining = [] }) =>
  lootIx('deposit', { index, amount: BigInt(amount) }, { depositor, game, pool: lootPda.pool(game, index), from: from ?? ata(depositor, mint, tokenProgram), mint }, remaining);

/** The accounts both purchases share (the `checkout` group). */
function checkout({ player, game, mint, nonce, playerToken, tokenProgram }) {
  const order = lootPda.order(game, player, nonce);
  return { order, accounts: { player, game, order, escrow: lootPda.escrow(order), mint, player_token: playerToken ?? ata(player, mint, tokenProgram), vault: ata(game, mint, tokenProgram) } };
}

/** Buy one item at its price, no more than `maxPrice` (what the player was shown). Opens an order. */
export const buyItemIx = ({ player, game, mint, itemId, nonce, maxPrice, playerToken, tokenProgram, remaining = [] }) =>
  lootIx('buy_item', { item_id: itemId, nonce: BigInt(nonce), max_price: BigInt(maxPrice) }, {
    item: lootPda.item(game, itemId), ...checkout({ player, game, mint, nonce, playerToken, tokenProgram }).accounts,
  }, remaining);
/** Open a box (remaining: entryAccounts(game, box.entries), then extras). `mint`: the box's currency, else the game's. */
export const openBoxIx = ({ player, game, mint, boxId, nonce, clientSeed, maxPrice, playerToken, tokenProgram, remaining = [] }) =>
  lootIx('open_box', { box_id: boxId, nonce: BigInt(nonce), client_seed: Uint8Array.from(clientSeed), max_price: BigInt(maxPrice) }, {
    loot_box: lootPda.box(game, boxId), ...checkout({ player, game, mint, nonce, playerToken, tokenProgram }).accounts,
  }, remaining);

// ---------------------------------------------------------------- an order ends: settle, settle_prize, refund (anyone)

/** Settle a rolled order whose outcome is an item. A normal item: the game's owner or authority signs. */
export const settleIx = ({ signer, order, player, game, itemId, mint, treasury, collection, slot, tokenProgram, remaining = [] }) =>
  lootIx('settle', {}, {
    signer, order, player, game, item: lootPda.item(game, itemId), escrow: lootPda.escrow(order), mint, vault: ata(game, mint, tokenProgram),
    treasury, collection, asset: lootPda.asset(order, slot),
  }, remaining);
/** Settle any other outcome. A prize (`Pay`) names its pool, the player's token account and the pool's mint. */
export const settlePrizeIx = ({ order, player, game, mint, treasury, tokenProgram, prizePool, prizeTo, prizeMint, remaining = [] }) =>
  lootIx('settle_prize', {}, {
    order, player, game, escrow: lootPda.escrow(order), mint, vault: ata(game, mint, tokenProgram), treasury,
    prize_pool: prizePool, prize_to: prizeTo, prize_mint: prizeMint,
  }, remaining);
/** Refund to the order's player: a failed roll from the next slot, an unrolled one after STALE_SLOTS, an unsettled one after 7 days. */
export const refundIx = ({ signer, order, player, game, mint, tokenProgram, remaining = [] }) =>
  lootIx('refund', {}, {
    signer, order, player, game, escrow: lootPda.escrow(order), mint, vault: ata(game, mint, tokenProgram), player_token: ata(player, mint, tokenProgram),
  }, remaining);

// ---------------------------------------------------------------- out and make (the game's authority)

export const payoutIx = ({ authority, game, index, mint, to, amount, reference, remaining = [] }) =>
  lootIx('payout', { index, amount: BigInt(amount), reference: ref(reference) }, { authority, game, pool: lootPda.pool(game, index), to, mint }, remaining);
export const burnIx = ({ authority, game, index, mint, amount, reference }) =>
  lootIx('burn', { index, amount: BigInt(amount), reference: ref(reference) }, { authority, game, pool: lootPda.pool(game, index), mint });
/** Mint `amount` of a mint the game controls into the token account `to`. */
export const issueIx = ({ authority, game, mint, to, amount, reference }) =>
  lootIx('issue', { amount: BigInt(amount), reference: ref(reference) }, { authority, game, mint, to });
/** Make one of `itemId` for `owner`; `asset` is a fresh key that signs. */
export const makeIx = ({ authority, game, itemId, collection, asset, owner, reference }) =>
  lootIx('make', { reference: ref(reference) }, { authority, game, item: lootPda.item(game, itemId), collection, asset, owner });
/** Burn a burnable collectible of the game's. */
export const unmakeIx = ({ authority, game, asset, collection, reference }) => lootIx('unmake', { reference: ref(reference) }, { authority, game, asset, collection });
/** Write attributes on a collectible: [{ key, value }]. */
export const setIx = ({ authority, game, asset, collection, attributes, reference }) =>
  lootIx('set', { attributes, reference: ref(reference) }, { authority, game, asset, collection });
/** A labelled random number from the oracle for any rule of the game's (the Rolled receipt carries it). */
export const rollIx = ({ authority, game, reference }) => lootIx('roll', { reference: ref(reference) }, { authority, game });

// ---------------------------------------------------------------- the mechanics, sent by players or anyone

/** remaining by action: Issue/Burn → the mint, the pool; Move → the pool it leaves, the pool it enters, their mint, extras. */
export const runScheduleIx = ({ game, id, remaining = [] }) => lootIx('run_schedule', {}, { game, schedule: lootPda.schedule(game, id) }, remaining);

/** `mint`: the lottery's ticket mint when it has one, else the game's. `pot`: the pot pool's index. */
export const buyTicketsIx = ({ player, game, id, pot, mint, treasury, count, maxPrice, playerToken, tokenProgram, remaining = [] }) =>
  lootIx('buy_tickets', { count: BigInt(count), max_price: BigInt(maxPrice) }, {
    player, game, lottery: lootPda.lottery(game, id), player_token: playerToken ?? ata(player, mint, tokenProgram), pot: lootPda.pool(game, pot), treasury, mint,
  }, remaining);
export const drawLotteryIx = ({ payer, game, id }) => lootIx('draw_lottery', {}, { payer, lottery: lootPda.lottery(game, id) });
/** Pay place `place` (0 is first) to the token account `to` of its winner; `firstPlace`: first place's wallet. */
export const payLotteryIx = ({ game, id, place, firstPlace, pot, to, mint, remaining = [] }) =>
  lootIx('pay_lottery', { place }, { game, lottery: lootPda.lottery(game, id), first_place: firstPlace, pot: lootPda.pool(game, pot), to, mint }, remaining);

/** The accounts stake and unstake share. */
function staking({ player, game, id, mint, rewardsMint, rewardsPool, playerTokens, playerRewards, tokenProgram, rewardsTokenProgram = tokenProgram }) {
  const stake = lootPda.stake(game, id);
  return {
    player, game, stake, position: lootPda.position(stake, player), staked_vault: lootPda.staked(stake), rewards_vault: lootPda.rewards(stake),
    rewards_pool: lootPda.pool(game, rewardsPool), player_tokens: playerTokens ?? ata(player, mint, tokenProgram),
    player_rewards: playerRewards ?? ata(player, rewardsMint, rewardsTokenProgram), mint, rewards_mint: rewardsMint,
  };
}
export const stakeIx = ({ amount, remaining = [], ...s }) => lootIx('stake', { amount: BigInt(amount) }, staking(s), remaining);
/** unstake(0) only collects rewards. `forfeit`: leave without the rewards (when the rewards can't be paid, say a frozen vault). */
export const unstakeIx = ({ amount, forfeit = false, remaining = [], ...s }) =>
  lootIx('unstake', { amount: BigInt(amount), forfeit }, staking(s), remaining);

/**
 * Craft recipe `id` at `version`, `times` over. remaining, each line in the recipe's order, inputs first:
 * Burn → the item, then each collectible handed in; Use and Renew → the item, then the collectible;
 * Pay → the mint (writable), the player's token account, then what its `to` needs; Item → the item, then a new key
 * the player made for the collectible (it signs); Tokens → the mint, the pool when they come from one, then the
 * player's token account; Share → the mint, the pool, then the player's token account. Then extras.
 */
export const craftIx = ({ player, game, id, collection, version, times = 1n, remaining = [] }) =>
  lootIx('craft', { version, times: BigInt(times) }, { player, game, recipe: lootPda.recipe(game, id), collection }, remaining);

/** Hand a collectible to the game for `seconds`; meanwhile the authority may award it. */
export const holdIx = ({ player, game, asset, collection, seconds, reference }) =>
  lootIx('hold', { seconds: BigInt(seconds), reference: ref(reference) }, { player, game, hold: lootPda.hold(asset), asset, collection });
/** The authority sends a held collectible to `to` (back to `player` early, or to whoever won it). */
export const awardIx = ({ signer, game, asset, player, to, collection, reference }) =>
  lootIx('award', { reference: ref(reference) }, { signer, game, hold: lootPda.hold(asset), asset, player, to, collection });
/** Anyone, once the hold is over: the collectible goes home to `player`. */
export const takeBackIx = ({ signer, game, asset, player, collection }) =>
  lootIx('take_back', {}, { signer, game, hold: lootPda.hold(asset), asset, player, collection });

/** args: { sides, closes_at, result_by, shares }. */
export const openContestIx = ({ authority, game, id, mint, args }) => {
  const contest = lootPda.contest(game, id);
  return lootIx('open_contest', { id, args: { shares: [], ...args } }, { authority, game, contest, mint, pot: lootPda.pot(contest) });
};
/** The hash of a contest's terms that every entry signs (Contest.terms holds it too). */
export const contestTerms = (mint, args) => sha256(concat(key(mint), encodeBorsh(LOOT_IDL, { defined: { name: 'ContestArgs' } }, { shares: [], ...args })));
export const enterIx = ({ player, game, id, side, amount, terms, mint, playerToken, tokenProgram, remaining = [] }) => {
  const contest = lootPda.contest(game, id);
  return lootIx('enter', { side, amount: BigInt(amount), terms: Uint8Array.from(terms) }, {
    player, game, contest, entry: lootPda.entry(contest, player, side), pot: lootPda.pot(contest), player_token: playerToken ?? ata(player, mint, tokenProgram), mint,
  }, remaining);
};
/** remaining: the targets of the contest's shares, then extras. */
export const decideIx = ({ authority, game, id, side, mint, reference, remaining = [] }) => {
  const contest = lootPda.contest(game, id);
  return lootIx('decide', { side, reference: ref(reference) }, { authority, game, contest, mint, pot: lootPda.pot(contest) }, remaining);
};
export const callOffIx = ({ signer, game, id }) => lootIx('call_off', {}, { signer, game, contest: lootPda.contest(game, id) });
export const claimIx = ({ game, id, player, side, to, mint, tokenProgram, remaining = [] }) => {
  const contest = lootPda.contest(game, id);
  return lootIx('claim', {}, { game, contest, entry: lootPda.entry(contest, player, side), player, pot: lootPda.pot(contest), to: to ?? ata(player, mint, tokenProgram), mint }, remaining);
};
/** `opener`: the authority that opened it, who gets the rent back. */
export const closeContestIx = ({ game, id, opener, mint }) => {
  const contest = lootPda.contest(game, id);
  return lootIx('close_contest', {}, { game, contest, opener, mint, pot: lootPda.pot(contest) });
};

// ---------------------------------------------------------------- the registry (official tokens; unchanged from 0.2)

/** venue: 'Meteora' (venueA the pool, venueB its config) or 'PumpFun' (its bonding curve and sharing config). */
export const attachTokenIx = ({ owner, launcher, game, venue, mint, venueA, venueB }) =>
  lootIx('attach_token', { venue, mint }, { owner, launcher, game, venue_a: venueA, venue_b: venueB });
export const recheckTokenIx = ({ game, venueA, venueB }) => lootIx('recheck_token', {}, { game, venue_a: venueA, venue_b: venueB });

// ---------------------------------------------------------------- what follows the named accounts

/** The accounts a split's shares name, in order: a pool, an account, or a collectible and its holder's token account. */
export function shareAccounts(game, shares, holderAccount = {}) {
  return shares.flatMap(({ to }) => {
    if (to === 'Burn') return [];
    if (to.Pool) return [meta(lootPda.pool(game, to.Pool[0]), false, true)];
    if (to.Account) return [meta(to.Account[0], false, true)];
    const asset = to.Holder[0];
    if (!holderAccount[asset]) throw new Error(`A share pays the holder of ${asset}: pass their token account.`);
    return [meta(asset, false, false), meta(holderAccount[asset], false, true)];
  });
}

/** The accounts a box's entries need, in entry order: an item's account, a prize's pool. */
export function entryAccounts(game, entries) {
  return entries.flatMap(({ outcome }) => {
    if (outcome.Item) return [meta(lootPda.item(game, outcome.Item[0]), false, true)];
    if (outcome.Pay || outcome.Share) return [meta(lootPda.pool(game, (outcome.Pay ?? outcome.Share).pool), false, true)];
    return [];
  });
}

// ---------------------------------------------------------------- an order, start to end (the shop uses these)

const ORDER_UNITS = 400_000;

/** A fresh order nonce: a random u64. */
export const newNonce = () => readUintLE(randomBytes(8), 0, 8);

/**
 * A shop purchase: { instructions, order, nonce }. The collectible's address depends on the slot the purchase lands
 * in, so it is settled in a transaction after this one (settleOrderIxs).
 */
export function buyItemIxs({ player, game, mint, itemId, maxPrice, nonce = newNonce(), tokenProgram, extras = [] }) {
  const ix = buyItemIx({ player, game, mint, itemId, nonce, maxPrice, tokenProgram, remaining: extras });
  return { instructions: [computeUnitLimit(ORDER_UNITS), ix], order: lootPda.order(game, player, nonce), nonce };
}

/** Open a box: { instructions, order, nonce }. `box` is the decoded LootBox. MagicBlock's oracle rolls it a moment later. */
export function openBoxIxs({ player, game, mint, boxId, box, maxPrice = box.price, nonce = newNonce(), clientSeed = randomBytes(32), tokenProgram, extras = [] }) {
  const remaining = [...entryAccounts(game, box.entries), ...extras];
  const ix = openBoxIx({ player, game, mint, boxId, nonce, clientSeed, maxPrice, tokenProgram, remaining });
  return { instructions: [computeUnitLimit(ORDER_UNITS), ix], order: lootPda.order(game, player, nonce), nonce };
}

/**
 * End a rolled order: settle for an item, settle_prize for anything else. `orderAccount` and `gameAccount` are
 * decoded; `holderAccount` maps a Holder share's collectible to its holder's token account; a prize needs `prizeTo`
 * (the player's token account of the pool's mint) and `prizeMint`.
 */
export function settleOrderIxs({ signer, order, orderAccount: o, gameAccount: g, tokenProgram, holderAccount, prizeTo, prizeMint, extras = [] }) {
  const remaining = [...shareAccounts(o.game, o.shares, holderAccount), ...extras];
  const common = { signer, order, player: o.player, game: o.game, mint: o.mint, treasury: g.treasury, tokenProgram, remaining };
  const ix = o.outcome?.Item
    ? settleIx({ ...common, itemId: o.outcome.Item[0], collection: g.collection, slot: o.requested_slot })
    : settlePrizeIx({ ...common, ...(o.outcome?.Pay ? { prizePool: lootPda.pool(o.game, o.outcome.Pay.pool), prizeTo, prizeMint } : {}) });
  return [computeUnitLimit(ORDER_UNITS), ix];
}

/** Refund an order. A rolled one names its item, whose serial is taken back (or voided, when it is not the last). */
export function refundOrderIx({ signer, order, orderAccount: o, tokenProgram, extras = [] }) {
  const item = o.status === OrderStatus.Rolled && o.outcome?.Item ? [meta(lootPda.item(o.game, o.outcome.Item[0]), false, true)] : [];
  return refundIx({ signer, order, player: o.player, game: o.game, mint: o.mint, tokenProgram, remaining: [...item, ...extras] });
}

/** Whether an order can be refunded at `slot`, and why not. */
export function refundable(o, slot) {
  const wait = { [OrderStatus.Failed]: 0n, [OrderStatus.Pending]: STALE_SLOTS }[o.status] ?? ROLLED_REFUND_SLOTS;
  const at = BigInt(o.requested_slot) + wait + 1n;
  return BigInt(slot) >= at ? { ok: true } : { ok: false, atSlot: at };
}

// ---------------------------------------------------------------- reading

/** A loot account's fields, decoded (u64/i64 fields are bigints). */
export const decodeLoot = (name, data) => decodeAccount(LOOT_IDL, name, data);

/** A stake position (not in the IDL: tag 10, then stake, player, bump, amount, since, paid_per_token). */
export function decodePosition(data) {
  if (data[0] !== 10 || data.length < 98) throw new Error('Not a Position account');
  const [stake, player] = [decodeBorsh(LOOT_IDL, 'pubkey', data, 1)[0], decodeBorsh(LOOT_IDL, 'pubkey', data, 33)[0]];
  return { stake, player, bump: data[65], amount: readUintLE(data, 66, 8), since: decodeBorsh(LOOT_IDL, 'i64', data, 74)[0], paid_per_token: readUintLE(data, 82, 16) };
}

/** A lottery's purchase lines for its round, after the record: [{ buyer, end }] (tickets below `end` are the buyer's). */
export function lotteryLines(data) {
  const record = 1 + encodeBorsh(LOOT_IDL, { defined: { name: 'Lottery' } }, decodeLoot(LootAccount.Lottery, data)).length;
  const lines = Math.floor((data.length - record) / 40);
  const start = record;
  return Array.from({ length: lines }, (_, i) => ({ buyer: decodeBorsh(LOOT_IDL, 'pubkey', data, start + i * 40)[0], end: readUintLE(data, start + i * 40 + 32, 8) }));
}

/** The fees in force at `nowSeconds`: { player, project } in lamports. */
export function currentFees(platform, nowSeconds = Math.floor(Date.now() / 1000)) {
  const at = BigInt(platform.pending_at);
  return at !== 0n && BigInt(nowSeconds) >= at ? platform.pending : platform.fees;
}

/** The receipts in a transaction's logs: [{ name, data }]. */
export const lootEvents = (logs) => decodeEvents(LOOT_IDL, logs);

/** What an item or box costs at `nowSeconds`, after any fall (Fall::at). */
export function priceAt(account, nowSeconds = Math.floor(Date.now() / 1000)) {
  const price = BigInt(account.price);
  const f = account.fall;
  const now = BigInt(nowSeconds);
  if (!f || now <= BigInt(f.since) || price <= BigInt(f.floor) || !f.every) return price;
  const steps = (now - BigInt(f.since)) / BigInt(f.every);
  const fallen = price - steps * BigInt(f.step);
  return fallen > BigInt(f.floor) ? fallen : BigInt(f.floor);
}

/** How many of an item are out: serials issued less those voided by a refund. `max_supply` caps this, not the serial. */
export const itemOut = (item) => item.issued - item.voided;
/** No more of an item can be sold or won (max_supply 0: no limit). */
export const soldOut = (item) => item.max_supply !== 0 && itemOut(item) >= item.max_supply;

/** `amount * bps / 10,000`, rounded down. */
export const shareOf = (amount, bps) => (BigInt(amount) * BigInt(bps)) / BigInt(BPS);

/**
 * A box's odds exactly as the program rolls them (pick.rs): an item counts while it is active and in stock (scaled by
 * the stock left when the box has `stock_odds`), a prize while its pool holds it. `items`: { id: decoded Item },
 * `pools`: { index: what the pool holds }. Returns the entries with `chance`.
 */
export function boxOdds(box, { items = {}, pools = {} } = {}) {
  const rows = box.entries.map((e) => {
    const { outcome } = e;
    let weight = e.weight;
    let available = true;
    if (outcome.Item) {
      const it = items[outcome.Item[0]];
      available = Boolean(it) && it.active && !soldOut(it);
      if (it && box.stock_odds && it.max_supply) weight = Math.ceil((e.weight * (it.max_supply - itemOut(it))) / it.max_supply);
    } else if (outcome.Pay) available = BigInt(pools[outcome.Pay.pool] ?? 0n) >= BigInt(outcome.Pay.amount);
    else if (outcome.Share) available = shareOf(pools[outcome.Share.pool] ?? 0n, outcome.Share.bps) > 0n;
    return { ...e, weight, available };
  });
  const total = rows.reduce((n, r) => n + (r.available ? r.weight : 0), 0);
  return rows.map((r) => ({ ...r, chance: total && r.available ? r.weight / total : 0 }));
}
