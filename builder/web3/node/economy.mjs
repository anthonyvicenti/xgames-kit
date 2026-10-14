// A game's economy on chain: the setup plan (builder/web3/economy/compile.mjs) turned into real instructions, what has landed
// written back into gamesfun.json, and where the economy stands on chain. Node side; nothing here signs or holds a key.
//
//   planToInstructions(plan, ctx)   each step of an abstract plan → { programId, keys, data } with the kit's builders
//   readEconomy(gameDir)            the game's economy, its old `shop` moved into one on read (migrate.mjs)
//   publishPlan(economy, { now })   only what the chain still needs: diff(what is live, the spec)
//   recordLanded(config, ...)       what one landed transaction means for gamesfun.json
//   economyStatus(gameDir, opts)    every part: on chain or not, and whether it still matches the spec
//
// A plan step names accounts by role ("pda:pool/0", "ata:owner/sol", "new:collection") and writes its arguments in
// plain JSON (u64 as decimal strings, "@mint:points" for an address that exists only after an earlier step,
// { Pool: 3 } for an enum with one field). This file is the one place those become addresses, bigints, bytes and the
// borsh codec's shapes ({ Pool: [3] }, 'Burn').
import { addressBytes, encodeBase58 } from '../gf-web3/chain/base58.js';
import { concat, fromHex, readUintLE, uintLE, utf8 } from '../gf-web3/chain/bytes.js';
import { createCollectionInstruction, MPL_CORE_PROGRAM, parseCoreCollection } from '../gf-web3/chain/core.js';
import { decodeLoot, LOOT_IDL, LOOT_PROGRAM, lootEvents, lootIx, lootPda, VRF_PROGRAM } from '../gf-web3/chain/loot.js';
import { parseMint } from '../gf-web3/chain/mint.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  METAPLEX_METADATA_PROGRAM,
  metadataAddress,
  SYSTEM_PROGRAM,
  SYSVAR_SLOT_HASHES,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from '../gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent, meta, syncNative, transferLamports } from '../gf-web3/chain/programs.js';
import { transferExtras } from '../gf-web3/chain/token2022.js';
import { explorerUrl } from '../gf-web3/network.js';
import { carryIds, diff } from '../economy/compile.mjs';
import { leaveOldProgram, migrateShop } from '../economy/migrate.mjs';
import { fromUnits, model, rent as rentOf, WSOL } from '../economy/model.mjs';
import { setupSteps } from '../economy/steps.mjs';
import { readConfig } from './game.mjs';
import { KIT_ROOT } from './game-dir.mjs';
import { chainContext } from './settings.mjs';

const fail = (message) => {
  throw new Error(message);
};

// ---------------------------------------------------------------- names → addresses

const PROGRAMS = {
  system: SYSTEM_PROGRAM,
  token: TOKEN_PROGRAM,
  'token-2022': TOKEN_2022_PROGRAM,
  'associated-token': ASSOCIATED_TOKEN_PROGRAM,
  'mpl-core': MPL_CORE_PROGRAM,
  'token-metadata': METAPLEX_METADATA_PROGRAM,
  'mpl-token-metadata': METAPLEX_METADATA_PROGRAM,
  vrf: VRF_PROGRAM,
  loot: LOOT_PROGRAM,
};
const isAddress = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const addressOf = (k) => (typeof k === 'string' ? k : k?.address);

/**
 * The address each name in a plan stands for. ctx:
 *   economy     the spec the plan was compiled from (its tokens' mints and programs)
 *   owner       the owner's wallet;  authority: the authority's, when it is another key (default: the spec's)
 *   keys        { 'new:collection': keypair or address, 'new:mint/<token>': … }: the keys made for this setup
 *   collection  the collection's address once it exists (default: keys['new:collection'], then economy.live)
 *   mints       { <token key>: address }: mints the spec does not name yet (a token just launched on the curve)
 */
export function resolver(ctx) {
  const m = model(ctx.economy ?? {});
  const keys = ctx.keys ?? {};
  const collection = () => ctx.collection ?? addressOf(keys['new:collection']) ?? ctx.economy?.live?.collection ?? fail('The economy has no collection yet: its plan makes one ("new:collection"), pass its key.');
  const game = () => lootPda.game(collection());
  const token = (key) => m.tokens.get(key) ?? fail(`The economy has no token "${key}".`);
  const mint = (key) => {
    const t = token(key);
    const named = ctx.mints?.[key] ?? (t.mint?.startsWith('@') ? addressOf(keys[`new:mint/${key}`]) : t.mint);
    if (!isAddress(named)) fail(t.source === 'curve' ? `${t.symbol} is not launched yet: launch it first (its own approval).` : `The token "${key}" has no mint yet.`);
    return named;
  };
  const tokenProgram = (key) => (token(key).program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
  const wallet = (who) => {
    if (who === 'owner') return ctx.owner ?? fail('Say whose wallet owns the economy (ctx.owner).');
    if (who === 'authority') return ctx.authority ?? (m.authority === 'owner' ? wallet('owner') : m.authority);
    return fail(`No wallet "${who}" at setup.`);
  };
  const id = (rest) => Number(rest.split('/')[1]);
  const pda = (rest) => {
    const [what] = rest.split('/');
    switch (what) {
      case 'game':
        return game();
      case 'platform':
        return lootPda.platform();
      case 'fees':
        return lootPda.fees(game());
      case 'pool':
        return lootPda.pool(game(), id(rest));
      case 'item':
        return lootPda.item(game(), id(rest));
      case 'box':
        return lootPda.box(game(), id(rest));
      case 'recipe':
        return lootPda.recipe(game(), id(rest));
      case 'schedule':
        return lootPda.schedule(game(), id(rest));
      case 'lottery':
        return lootPda.lottery(game(), id(rest));
      case 'stake':
        return lootPda.stake(game(), id(rest));
      case 'staked':
        return lootPda.staked(lootPda.stake(game(), id(rest)));
      case 'rewards':
        return lootPda.rewards(lootPda.stake(game(), id(rest)));
      case 'contest':
        return lootPda.contest(game(), id(rest));
      case 'metadata':
        return metadataAddress(mint(rest.slice('metadata/'.length)));
      default:
        return fail(`Unknown program address "pda:${rest}".`);
    }
  };
  const resolve = (name) => {
    if (typeof name !== 'string') fail(`Not an account name: ${JSON.stringify(name)}`);
    const plain = name.startsWith('@') ? name.slice(1) : name;
    if (isAddress(plain)) return plain;
    const at = plain.indexOf(':');
    const [kind, rest] = at < 0 ? [plain, ''] : [plain.slice(0, at), plain.slice(at + 1)];
    if (kind === 'wallet') return wallet(rest);
    if (kind === 'pda') return pda(rest);
    if (kind === 'mint') return mint(rest);
    if (kind === 'ata') {
      const [who, key] = rest.split('/');
      return associatedTokenAddress(wallet(who), mint(key), tokenProgram(key));
    }
    if (kind === 'new') return addressOf(keys[plain]) ?? fail(`No key was made for "${plain}".`);
    if (kind === 'program') return PROGRAMS[rest] ?? fail(`Unknown program "${rest}".`);
    if (kind === 'sysvar' && rest === 'slot-hashes') return SYSVAR_SLOT_HASHES;
    return fail(`Unknown account name "${name}".`);
  };
  return Object.assign(resolve, { mint, tokenProgram, token, game, collection, model: m });
}

// ---------------------------------------------------------------- plan values → the codec's values

const UNSIGNED_BIG = new Set(['u64', 'u128', 'i64', 'i128']);
const SMALL = new Set(['u8', 'u16', 'u32', 'i8', 'i16', 'i32']);
const TYPES = new Map(LOOT_IDL.types.map((t) => [t.name, t.type]));
const isNamed = (fields) => typeof fields[0] === 'object' && fields[0] !== null && 'name' in fields[0];

/** 32 bytes from hex ("00ff…"), an array of numbers, or bytes. */
function bytesOf(value, length) {
  const bytes = typeof value === 'string' ? fromHex(value) : Uint8Array.from(value ?? []);
  if (length !== undefined && bytes.length !== length) fail(`Expected ${length} bytes, got ${bytes.length}.`);
  return bytes;
}

/**
 * One plan value as the borsh codec takes it, by its IDL type: decimal strings → bigints, names → addresses, hex →
 * bytes, { Variant: {} } → 'Variant', { Pool: 3 } → { Pool: [3] }.
 */
export function toCodec(type, value, resolve) {
  if (typeof type === 'string') {
    if (UNSIGNED_BIG.has(type)) return BigInt(value);
    if (SMALL.has(type)) return Number(value);
    if (type === 'bool') return Boolean(value);
    if (type === 'pubkey') return resolve(value);
    if (type === 'string') return String(value ?? '');
    if (type === 'bytes') return bytesOf(value);
    fail(`Unknown IDL type ${type}`);
  }
  if (type.option) return value === null || value === undefined ? null : toCodec(type.option, value, resolve);
  if (type.vec) return (value ?? []).map((v) => toCodec(type.vec, v, resolve));
  if (type.array) {
    const [inner, length] = type.array;
    if (inner === 'u8') return bytesOf(value, length);
    const list = (value ?? []).map((v) => toCodec(inner, v, resolve));
    while (list.length < length) list.push(toCodec(inner, 0, resolve));
    return list;
  }
  const def = TYPES.get(type.defined.name) ?? fail(`Unknown IDL type ${type.defined.name}`);
  if (def.kind === 'struct') return Object.fromEntries(def.fields.map((f) => [f.name, toCodec(f.type, value?.[f.name], resolve)]));
  const name = typeof value === 'string' ? value : Object.keys(value ?? {})[0];
  const variant = def.variants.find((v) => v.name === name) ?? fail(`${type.defined.name} has no variant ${name}`);
  const fields = variant.fields ?? [];
  if (!fields.length) return name;
  const payload = value[name];
  if (isNamed(fields)) return { [name]: Object.fromEntries(fields.map((f) => [f.name, toCodec(f.type, payload?.[f.name], resolve)])) };
  const list = Array.isArray(payload) ? payload : [payload];
  return { [name]: fields.map((f, i) => toCodec(f, list[i], resolve)) };
}

/** A loot instruction's arguments from a plan step's. */
export function lootArgs(ix, args, resolve) {
  const def = LOOT_IDL.instructions.find((i) => i.name === ix) ?? fail(`Loot 0.3 has no instruction ${ix}`);
  return Object.fromEntries(def.args.map((a) => [a.name, toCodec(a.type, args[a.name], resolve)]));
}

// ---------------------------------------------------------------- other programs' instructions

const SPL = { InitializeMint2: 20, SetAuthority: 6 };
const AUTHORITY_TYPE = { MintTokens: 0, FreezeAccount: 1, AccountOwner: 2, CloseAccount: 3 };
const CREATE_METADATA_V3 = 33;

export const createAccountIx = ({ from, to, lamports, space, owner }) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(from, true, true), meta(to, true, true)],
  data: concat(uintLE(0, 4), uintLE(BigInt(lamports), 8), uintLE(BigInt(space), 8), addressBytes(owner)),
});

const optionalAddress = (a) => (a ? concat(Uint8Array.of(1), addressBytes(a)) : Uint8Array.of(0));

export const initializeMint2Ix = ({ mint, decimals, mintAuthority, freezeAuthority = null, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(mint, false, true)],
  data: concat(Uint8Array.of(SPL.InitializeMint2, decimals), addressBytes(mintAuthority), optionalAddress(freezeAuthority)),
});

export const setAuthorityIx = ({ account, current, type = 'MintTokens', newAuthority, tokenProgram = TOKEN_PROGRAM }) => ({
  programId: tokenProgram,
  keys: [meta(account, false, true), meta(current, true, false)],
  data: concat(Uint8Array.of(SPL.SetAuthority, AUTHORITY_TYPE[type] ?? fail(`Unknown authority type ${type}`)), optionalAddress(newAuthority)),
});

const borshText = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));

/** Metaplex token metadata (CreateMetadataAccountV3): a name, ticker and link wallets show for a mint. */
export const createMetadataIx = ({ metadata, mint, mintAuthority, payer, updateAuthority, name, symbol, uri = '', sellerFeeBps = 0, isMutable = true }) => ({
  programId: METAPLEX_METADATA_PROGRAM,
  keys: [meta(metadata, false, true), meta(mint, false, false), meta(mintAuthority, true, false), meta(payer, true, true), meta(updateAuthority, true, false), meta(SYSTEM_PROGRAM, false, false)],
  data: concat(
    Uint8Array.of(CREATE_METADATA_V3),
    borshText(name),
    borshText(symbol),
    borshText(uri),
    uintLE(sellerFeeBps, 2),
    Uint8Array.of(0, 0, 0), // creators, collection, uses: none
    Uint8Array.of(isMutable ? 1 : 0),
    Uint8Array.of(0), // collection details: none
  ),
});

// ---------------------------------------------------------------- a step → an instruction

/** The leaf name of a flattened IDL account ("fee.platform" → "platform"), as lootIx looks accounts up. */
const leaf = (name) => name.split('.').at(-1);

/** The transfers a deposit makes, for a Token-2022 mint's extras (a hook may need to know them). */
async function depositExtras(step, accounts, args, resolve, ctx) {
  const key = step.accounts.mint.slice('mint:'.length);
  if (resolve.token(key).program !== 'token-2022') return [];
  if (!ctx.rpc) fail(`${step.id}: a Token-2022 deposit needs the mint's extras; pass ctx.rpc.`);
  return transferExtras(ctx.rpc, accounts.mint, [{ source: accounts.from, destination: accounts.pool, authority: accounts.depositor, amount: args.amount }]);
}

/** One plan step as one instruction. Async only for what the chain must say (rent, a Token-2022 mint's extras). */
export async function stepInstruction(step, ctx, resolve = resolver(ctx)) {
  const a = Object.fromEntries(Object.entries(step.accounts ?? {}).map(([k, v]) => [k, resolve(v)]));
  const args = step.args ?? {};
  if (step.program === 'loot') {
    const named = Object.fromEntries(Object.entries(a).map(([k, v]) => [leaf(k), v]));
    const codec = lootArgs(step.ix, args, resolve);
    const remaining = step.ix === 'deposit' ? await depositExtras(step, a, codec, resolve, ctx) : [];
    return lootIx(step.ix, codec, named, remaining);
  }
  switch (`${step.program}.${step.ix}`) {
    case 'system.create_account': {
      const lamports = /^\d+$/.test(String(args.lamports)) ? BigInt(args.lamports) : ctx.rent ? BigInt(await ctx.rent(args.space)) : rentOf(args.space);
      return createAccountIx({ from: a.from, to: a.to, lamports, space: args.space, owner: resolve(args.owner) });
    }
    case 'system.transfer':
      return transferLamports(a.from, a.to, BigInt(args.lamports));
    case 'spl-token.initialize_mint2':
      return initializeMint2Ix({ mint: a.mint, decimals: args.decimals, mintAuthority: resolve(args.mint_authority), freezeAuthority: args.freeze_authority ? resolve(args.freeze_authority) : null });
    case 'spl-token.set_authority':
      return setAuthorityIx({ account: a.mint ?? a.account, current: a.current_authority, type: args.authority_type, newAuthority: args.new_authority ? resolve(args.new_authority) : null });
    case 'spl-token.sync_native':
      return syncNative(a.account);
    case 'associated-token.create_idempotent': {
      const ix = createAssociatedTokenAccountIdempotent(a.payer, a.wallet, a.mint, a.token_program);
      if (ix.keys[1].pubkey !== a.account) fail(`${step.id}: the account ${a.account} is not ${a.wallet}'s token account for ${a.mint}.`);
      return ix;
    }
    case 'mpl-core.create_collection_v2': {
      const ix = createCollectionInstruction({ collection: a.collection, creator: a.update_authority, name: args.name, uri: args.uri ?? '', royaltyBps: args.royalty_bps });
      if (args.update_delegate && resolve(args.update_delegate) !== lootPda.game(a.collection)) fail(`${step.id}: the collection's delegate must be its game.`);
      return ix;
    }
    case 'mpl-token-metadata.create_metadata_account_v3':
      return createMetadataIx({ metadata: a.metadata, mint: a.mint, mintAuthority: a.mint_authority, payer: a.payer, updateAuthority: a.update_authority, name: args.name, symbol: args.symbol, uri: args.uri, sellerFeeBps: args.seller_fee_basis_points ?? 0, isMutable: args.is_mutable !== false });
    case 'launch.launch_on_curve':
      return fail(`${step.id}: a token launched on the curve has its own approval (the token launch), not a setup step.`);
    default:
      return fail(`${step.id}: no builder for ${step.program}.${step.ix}.`);
  }
}

/**
 * Every transaction of a plan as instructions:
 *   { before, transactions: [{ signer, signers: [addresses], newKeys: [names], steps: [step ids], says, instructions }] }
 * `before` is the plan's own (a curve launch, run by the token launch). See `resolver` for ctx; ctx.rpc and
 * ctx.rent(bytes) answer what only the chain knows (a Token-2022 mint's extras, rent), else model.mjs's rent.
 */
export async function planToInstructions(plan, ctx) {
  if (!plan?.ok) fail(`There is no plan to build: ${(plan?.refusals ?? []).map((r) => r.message).join(' ') || 'compile the economy first.'}`);
  const resolve = resolver(ctx);
  const transactions = [];
  for (const tx of plan.transactions) {
    const instructions = [];
    for (const step of tx.steps) instructions.push(await stepInstruction(step, ctx, resolve));
    const newKeys = tx.signers.filter((s) => s.startsWith('new:'));
    transactions.push({ signer: tx.signer, signers: tx.signers.map(resolve), newKeys, steps: tx.steps.map((s) => s.id), stepList: tx.steps, says: tx.says, instructions });
  }
  return { before: plan.before ?? [], transactions };
}

// ---------------------------------------------------------------- the spec, what is live, and what landed

/**
 * A game's economy from its gamesfun.json. A game that still has a `shop` (and no economy) gets it moved into one on
 * read, exactly as `gamesfun economy migrate --write` writes it: { config, economy, migrated, notes }.
 */
export async function readEconomy(gameDir) {
  const raw = await readConfig(gameDir);
  if (!raw.economy && raw.shop) {
    const moved = migrateShop(raw);
    return { config: moved.config, economy: moved.config.economy, migrated: true, notes: moved.notes };
  }
  const notes = leaveOldProgram(raw.economy);
  return { config: raw, economy: raw.economy ?? null, migrated: notes.length > 0, notes };
}

/** The spec without what going live wrote into it. */
export function specOf(economy) {
  const { live, previous, ...spec } = economy ?? {};
  return spec;
}

/** When the economy went live (Unix seconds): "publish" in the spec means this moment, so it never moves. */
export const publishedAt = (economy, fallback = Math.floor(Date.now() / 1000)) => (economy?.live?.at ? Math.floor(Date.parse(economy.live.at) / 1000) : fallback);

/**
 * What going live still needs: diff(what is on chain, the spec). `old` is what landed (live.published), `next` the
 * spec with every part's program id, `plan` the compiler's.
 */
export function publishPlan(economy, { now = publishedAt(economy), network = 'devnet' } = {}) {
  const live = economy?.live ?? {};
  const spec = { ...specOf(economy), ...(live.game ? { live: { game: live.game, collection: live.collection } } : {}) };
  const old = live.game ? { ...(live.published ?? {}), live: { game: live.game } } : null;
  const plan = diff(old, spec, { now, network });
  return { old, next: carryIds(old, spec), plan, now };
}

const LISTED = { item: 'items', box: 'boxes', recipe: 'recipes', schedule: 'schedules', lottery: 'lotteries', stake: 'stakes', pool: 'pools' };
const TOP = ['version', 'network', 'name', 'currency', 'keys', 'collection'];
const MAX_RECORDED = 60;

/**
 * gamesfun.json after one transaction landed: each of its steps' parts gets its program id in the spec and a copy in
 * `live.published` (what diff compares against next time), new mints are written into their tokens, the game's
 * addresses into `live`, and the signature into `live.transactions`. Pure: returns the changed config.
 *   landed: { signature, steps: [plan step], next (publishPlan's), owner, collection, treasury, authority,
 *             mints: { <token key>: address } (tokens this setup made), at (ISO time) }
 */
export function recordLanded(config, { signature, steps, next, owner, collection, treasury, authority, mints = {}, at }) {
  const c = structuredClone(config);
  const economy = c.economy;
  leaveOldProgram(economy);
  const live = (economy.live ??= {});
  const published = (live.published ??= {});
  for (const k of TOP) if (next[k] !== undefined) published[k] = structuredClone(next[k]);
  const ids = new Set(steps.map((s) => s.id));
  const nextOf = (list, key) => (next[list] ?? []).find((x) => x.key === key);
  const put = (list, part) => {
    published[list] = [...(published[list] ?? []).filter((x) => x.key !== part.key), structuredClone(part)];
  };
  const giveId = (list, part) => {
    const field = list === 'pools' ? 'index' : 'id';
    const mine = (economy[list] ?? []).find((x) => x.key === part.key);
    if (mine && mine[field] === undefined) mine[field] = part[field];
  };
  // Tokens the game made: their mint is real now, in the spec and in what is published.
  for (const [key, address] of Object.entries(mints)) {
    if (![...ids].some((id) => id === `token:${key}`)) continue;
    const t = (economy.tokens ?? []).find((x) => x.key === key);
    if (t) t.mint = address;
  }
  // Every token that exists (SOL, a mint by address, one the game made and that landed); not one still to be made.
  published.tokens = (economy.tokens ?? []).filter((t) => !((t.source === 'game' || t.source === 'curve') && !t.mint)).map((t) => structuredClone(t));
  for (const step of steps) {
    const [kind, ...rest] = step.id.split(':');
    const key = rest.join(':');
    if (step.id === 'collection') live.collection = collection;
    else if (step.id === 'game' && step.ix === 'create_game') {
      Object.assign(live, { program: LOOT_PROGRAM, game: lootPda.game(collection), collection, treasury, authority, at: live.at ?? at });
      c.creator ??= owner;
    } else if (step.id === 'game' && step.ix === 'update_game') published.keys = structuredClone(next.keys ?? {});
    else if (kind === 'seed') {
      const pool = (published.pools ?? []).find((p) => p.key === key);
      const want = nextOf('pools', key);
      if (pool && want) pool.seed = want.seed;
    } else if (kind === 'pool' && step.ix === 'close_pool') published.pools = (published.pools ?? []).filter((p) => p.key !== key);
    else if (kind === 'pool') {
      const part = nextOf('pools', key);
      if (part) {
        put('pools', { ...part, seed: (published.pools ?? []).find((p) => p.key === key)?.seed ?? 0 });
        giveId('pools', part);
      }
    } else if (LISTED[kind]) {
      const list = LISTED[kind];
      const part = nextOf(list, key) ?? (published[list] ?? []).find((x) => x.key === key);
      if (!part) continue;
      // A part removed from the spec stays in what is published, switched off, so its number is never reused.
      const removed = !nextOf(list, key);
      put(list, removed ? { ...part, active: false } : part);
      if (!removed) giveId(list, part);
    }
  }
  for (const k of Object.keys(live)) if (live[k] === undefined) delete live[k];
  live.transactions = [...(live.transactions ?? []), { signature, parts: [...ids] }].slice(-MAX_RECORDED);
  return c;
}

// ---------------------------------------------------------------- where it stands on chain

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Array.from(x) : x)));
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));
/** The fields of `want` that `have` matches, apart from `skip` (what the program moves on its own as the game runs). */
const matches = (have, want, skip = []) => Object.keys(want).filter((k) => !skip.includes(k)).every((k) => same(have[k], want[k]));

/** What each kind of account must match, and which of its fields move on their own. */
const COMPARE = {
  upsert_item: { type: 'Item', args: (s) => s.args.args, skip: (want) => (want.rise ? ['price'] : []) },
  upsert_box: { type: 'LootBox', args: (s) => s.args.args, skip: (want) => (want.rise ? ['price'] : []) },
  upsert_recipe: { type: 'Recipe', args: (s) => s.args.args, skip: () => [] },
  upsert_schedule: { type: 'Schedule', args: (s) => s.args.args, skip: (want, have) => (have.runs ? ['next_at', 'action'] : []) },
  upsert_lottery: { type: 'Lottery', args: (s) => s.args.args, skip: (want, have) => (have.round ? ['draws_at'] : []) },
  open_stake: { type: 'Stake', args: (s, r) => ({ rewards_pool: Number(s.args.rewards_pool), lock: BigInt(s.args.lock), mint: r(s.accounts.mint), rewards_mint: r(s.accounts.rewards_mint) }), skip: () => [] },
  create_game: { type: 'Game', args: (s, r) => ({ owner: r(s.accounts.owner), authority: r(s.args.authority), collection: r(s.accounts.collection), mint: r(s.accounts.mint), treasury: r(s.accounts.treasury) }), skip: () => [] },
};
const ACCOUNT_OF = { upsert_item: 'item', upsert_box: 'loot_box', upsert_recipe: 'recipe', upsert_schedule: 'schedule', upsert_lottery: 'lottery', open_stake: 'stake', create_game: 'game', open_pool: 'pool' };
const ARG_TYPE = { Item: 'ItemArgs', LootBox: 'BoxArgs', Recipe: 'RecipeArgs', Schedule: 'ScheduleArgs', Lottery: 'LotteryArgs' };
const PART_KIND = { item: 'item', box: 'box', recipe: 'recipe', schedule: 'schedule', lottery: 'lottery', stake: 'stake', pool: 'pool', game: 'game', collection: 'collection', token: 'token' };

/**
 * Where a game's economy stands on chain:
 *   { live, program, game, collection, explorer, parts: [{ part, key, onChain, address, differs }],
 *     pools: [{ index, key, mint, balance, amount, symbol }], receipts: [{ signature, slot, at, ok, events, explorer }] }
 * A part `differs` when it is on chain but not as the spec says (a price changed and not published yet). Fields the
 * program moves on its own while the game runs (a rising price, a schedule's next run, a lottery's next draw) are not
 * compared. opts: { rpc, network } (as the routes' env), or { kitRoot, env, fetchImpl? } (an agent tool's: the RPC is
 * picked as the dev server picks it), and `receipts` (how many recent transactions to read, default 5).
 */
export async function economyStatus(gameDir, opts = {}) {
  let { rpc, network } = opts;
  if (!rpc) {
    // An agent tool's call: { kitRoot, env, fetchImpl? } picks the RPC the way the dev server does.
    const chain = await chainContext(opts.kitRoot ?? KIT_ROOT, { env: opts.env ?? process.env, fetchImpl: opts.fetchImpl });
    ({ rpc, network } = chain);
  }
  const { economy } = await readEconomy(gameDir);
  if (!economy) return { live: false, program: LOOT_PROGRAM, game: null, collection: null, parts: [], pools: [], receipts: [], note: 'This game has no economy yet.' };
  const live = economy.live ?? {};
  const now = publishedAt(economy);
  const spec = { ...specOf(economy), ...(live.game ? { live: { game: live.game, collection: live.collection } } : {}) };
  const next = carryIds(live.game ? { ...(live.published ?? {}), live: { game: live.game } } : null, spec);
  const m = model(next, { now });
  if (!live.game || !live.collection) {
    const parts = [...m.pools.map((p) => ['pool', p.key]), ...m.items.map((x) => ['item', x.key]), ...m.boxes.map((x) => ['box', x.key]), ...m.recipes.map((x) => ['recipe', x.key]), ...m.schedules.map((x) => ['schedule', x.key]), ...m.lotteries.map((x) => ['lottery', x.key]), ...m.stakes.map((x) => ['stake', x.key])];
    return { live: false, program: LOOT_PROGRAM, game: null, collection: null, parts: [['game', 'game'], ...parts].map(([part, key]) => ({ part, key, onChain: false, address: null, differs: false })), pools: [], receipts: [] };
  }
  const gameAccount = await rpc.account(live.game);
  const g = gameAccount?.owner === LOOT_PROGRAM ? decodeLoot('Game', gameAccount.data) : null;
  const owner = g?.owner ?? opts.owner;
  const ctx = { economy: next, owner, collection: live.collection, keys: { 'new:collection': live.collection } };
  const resolve = resolver(ctx);
  // Every setup step of the whole spec, as if nothing were live yet: each says what its account must hold.
  const steps = setupSteps({ ...next, live: {} }, { now }).filter((s) => ACCOUNT_OF[s.ix] || s.id === 'collection' || (s.id.startsWith('token:') && s.ix === 'set_authority'));
  const rows = steps.map((s) => {
    const kind = s.id.split(':')[0];
    let address;
    try {
      address = s.id === 'collection' ? live.collection : s.id.startsWith('token:') ? resolve(s.accounts.mint) : resolve(s.accounts[ACCOUNT_OF[s.ix]]);
    } catch {
      address = null;
    }
    return { step: s, part: PART_KIND[kind] ?? kind, key: s.id.includes(':') ? s.id.split(':').slice(1).join(':') : s.id, address };
  });
  // Tokens the game made: their mint, whose minting is the game's.
  for (const t of m.tokens.values()) if (t.source === 'game' && isAddress(t.mint)) rows.push({ step: { id: `token:${t.key}`, ix: 'set_authority' }, part: 'token', key: t.key, address: t.mint });
  const accounts = await rpc.accounts(rows.map((r) => r.address).filter(Boolean));
  const byAddress = new Map(rows.map((r) => r.address).filter(Boolean).map((a, i) => [a, accounts[i]]));
  const parts = rows.map(({ step, part, key, address }) => {
    const account = address ? byAddress.get(address) : null;
    let onChain = Boolean(account);
    let differs = false;
    try {
      if (step.id === 'collection') {
        onChain = account?.owner === MPL_CORE_PROGRAM;
        if (onChain) differs = parseCoreCollection(account.data).updateAuthority !== owner;
      } else if (step.id.startsWith('token:')) {
        const info = account ? parseMint(address, account.owner, account.data) : null;
        onChain = Boolean(info);
        if (onChain) differs = info.mintAuthority !== lootPda.game(live.collection);
      } else if (step.ix === 'open_pool') {
        onChain = Boolean(account) && (account.owner === TOKEN_PROGRAM || account.owner === TOKEN_2022_PROGRAM);
        if (onChain) differs = account.data.length < 64 || encodeBase58(account.data.subarray(0, 32)) !== resolve(step.accounts.mint);
      } else if (account?.owner === LOOT_PROGRAM) {
        const c = COMPARE[step.ix];
        const have = decodeLoot(c.type, account.data);
        const raw = c.args(step, resolve);
        const want = ARG_TYPE[c.type] ? toCodec({ defined: { name: ARG_TYPE[c.type] } }, raw, resolve) : raw;
        if (c.type === 'Lottery') want.places = [...want.places, ...Array(8 - want.places.length).fill(0)];
        differs = !matches(have, want, c.skip(want, have));
      } else onChain = false;
    } catch {
      differs = true;
    }
    return { part, key, onChain, address, differs: onChain && differs };
  });
  const pools = [];
  const poolAddresses = m.pools.map((p) => lootPda.pool(live.game, p.index));
  const poolAccounts = poolAddresses.length ? await rpc.accounts(poolAddresses) : [];
  m.pools.forEach((p, i) => {
    const t = m.tokens.get(p.currency);
    const a = poolAccounts[i];
    const balance = a && a.data.length >= 72 ? readUintLE(a.data, 64, 8) : null;
    pools.push({ index: p.index, key: p.key, address: poolAddresses[i], mint: t?.mint ?? null, symbol: t?.symbol, balance: balance === null ? null : balance.toString(), amount: balance === null ? null : fromUnits(balance, t?.decimals ?? 0) });
  });
  const receipts = [];
  const want = opts.receipts ?? 5;
  if (want > 0) {
    const recent = await rpc.call('getSignaturesForAddress', [live.game, { limit: want, commitment: 'confirmed' }]).catch(() => []);
    for (const r of recent) {
      const t = await rpc.call('getTransaction', [r.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
      receipts.push({ signature: r.signature, slot: r.slot, at: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null, ok: !r.err, events: lootEvents(t?.meta?.logMessages ?? []).map((e) => e.name), explorer: network ? explorerUrl(network, 'tx', r.signature) : null });
    }
  }
  return {
    live: Boolean(g),
    program: LOOT_PROGRAM,
    game: live.game,
    collection: live.collection,
    owner: owner ?? null,
    explorer: network ? explorerUrl(network, 'address', live.game) : null,
    parts: [{ part: 'game', key: 'game', onChain: Boolean(g), address: live.game, differs: Boolean(g) && parts.find((p) => p.part === 'game')?.differs === true }, ...parts.filter((p) => p.part !== 'game')],
    pools,
    receipts,
  };
}

export { WSOL };
