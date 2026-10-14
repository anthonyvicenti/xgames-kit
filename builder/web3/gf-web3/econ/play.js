// The player's side of a game's economy: one call per thing a player signs (buy, openBox, pay, craft, buyTickets,
// stake, unstake, hold, enter, claim), each named by the part's key in the game's gamesfun.json economy section,
// never by an address; plus reads (pools, a box's odds, a lottery, a stake position, a contest, the player's own
// receipts) and `act(id)`, which performs any action of playerActions() from its id alone.
//
// Each call reads what it needs from the chain, resolves every account the loot program 0.3 asks for (split targets,
// a holder's token account, a recipe's lines, a Token-2022 mint's Memo program and transfer-hook accounts), checks
// the player can pay before the wallet opens, guards the price (`maxPrice`: the spec's price, or the price the player
// was shown when it rises), and says what went wrong in a player's words. Used through gf-web3's `economy` object:
//
//   await gfWeb3.economy.openBox('flip');              // pay and roll, then claim the prize: two approvals
//   await gfWeb3.economy.buyTickets('weekly', { count: 3 });
//   await gfWeb3.economy.act('stake:backers:stake');   // what a menu button does
//   const state = await gfWeb3.economy.state();        // what the page sends the game
import { encodeBase58 } from '../chain/base58.js';
import { randomBytes } from '../chain/bytes.js';
import { MPL_CORE_PROGRAM, ownedAssetFilters, parseCoreAsset } from '../chain/core.js';
import {
  ata,
  boxOdds as oddsOf,
  buyItemIxs,
  buyTicketsIx,
  claimIx,
  craftIx,
  currentFees,
  decodeLoot,
  decodePosition,
  drawLotteryIx,
  enterIx,
  ESCROW_LAMPORTS,
  holdIx,
  LOOT_PROGRAM,
  LootAccount,
  lootEvents,
  lootPda,
  lotteryLines,
  NO_ADDRESS,
  OrderStatus,
  openBoxIxs,
  payIx,
  payLotteryIx,
  priceAt,
  refundable,
  refundOrderIx,
  settleOrderIxs,
  shareAccounts,
  soldOut,
  stakeIx,
  takeBackIx,
  unstakeIx,
} from '../chain/loot.js';
import { NATIVE_MINT } from '../chain/pda.js';
import { closeTokenAccount, computeUnitLimit, createAssociatedTokenAccountIdempotent, meta, withSolWrap } from '../chain/programs.js';
import { transferExtras } from '../chain/token2022.js';
import { economyState, parseActionId, playerActions } from './actions.js';
import { collectiblesFrom, freshSigner, lifeAllows, lotteryWinners, mintDecimals, pendingRewards, readTokenAccount, ticketsOf } from './chain.js';
import { destination, fromUnits, inWords, readEconomy, toSeconds, toUnits } from './spec.js';

const CRAFT_UNITS = 400_000;
/** Account tags (the IDL's one-byte discriminators). */
const TAG = { Order: 5, Hold: 12 };
const ROLL_POLLS = 90;
/** Rent per byte of a new account, with its 128-byte overhead (builder/web3/economy/model.mjs, read on devnet 2026-10-11). */
const rent = (bytes) => BigInt(bytes + 128) * 5_080n;
const RENT = { ata: rent(165), line: 40n * 5_080n, position: rent(98), entry: rent(75), hold: rent(138), asset: rent(400) };

/** The program's refusals, in a player's words. */
const PLAIN = {
  PriceAboveMax: 'The price went up since you looked. Look again and confirm the new price.',
  SoldOut: 'Sold out.',
  NotForSale: 'That is not on offer right now.',
  Paused: 'The game has paused its economy for now.',
  Suspended: 'This game’s economy is suspended by games.fun.',
  SalesClosed: 'Ticket sales are closed for this round.',
  StillLocked: 'Your stake is still locked.',
  MoreThanStaked: 'That is more than you have staked.',
  RecipeChanged: 'The recipe changed since you looked. Look again.',
  NotReady: 'Not ready yet: it is too new, or it was used too recently.',
  Expired: 'It has expired.',
  UsedUp: 'It has no uses left.',
  NeedNotMet: 'What you handed in is not strong enough for this recipe yet.',
  Held: 'The game is holding that one.',
  ContestNotOpen: 'Entries are closed.',
  ContestOpen: 'There is no result yet.',
  TermsChanged: 'This contest changed since you looked. Look again.',
  StillHeld: 'Its time with the game is not up yet.',
  NotDue: 'It is not due yet.',
  PlacePaid: 'That place was paid already.',
  OnceAtATime: 'This recipe is made one at a time.',
};

/** An error with the player's words; `cause` keeps the network's own. */
const said = (message, cause) => Object.assign(new Error(message), cause ? { cause, logs: cause.logs } : {});

/** The program's refusal, if it is one we know, else the network's own message. */
export function plainError(error) {
  const code = /\((\w+)\)\s*$/.exec(error?.message ?? '')?.[1] ?? Object.keys(PLAIN).find((k) => error?.message?.includes(k));
  if (code && PLAIN[code]) return said(PLAIN[code], error);
  if (/insufficient (funds|lamports)/i.test(error?.message ?? '')) return said('Not enough SOL in your wallet for this and its network fee.', error);
  return error;
}

/** Shares as the program takes them: [{ to: { Pool: [i] } | { Account: [a] } | { Holder: [a] } | 'Burn', bps }]. */
export function sharesFor(split, e) {
  return (split ?? []).map((s) => {
    const d = destination(s.to);
    const bps = Math.round(Number(s.percent) * 100);
    if (d.kind === 'burn') return { to: 'Burn', bps };
    if (d.kind === 'pool') return { to: { Pool: [e.part('pool', d.key)?.index ?? 0] }, bps };
    if (d.kind === 'account') return { to: { Account: [d.key] }, bps };
    return { to: { Holder: [d.key] }, bps };
  });
}

/** One entry per address, writable if any wants it writable. */
function merge(metas) {
  const out = new Map();
  for (const m of metas) out.set(m.pubkey, out.has(m.pubkey) ? { ...m, isWritable: m.isWritable || out.get(m.pubkey).isWritable } : m);
  return [...out.values()];
}

/**
 * The economy calls on top of a kit instance. `kit`: { ready, connect, address, rpc, send(player, instructions,
 * signers), mock, emit, say, rollPollMs, now }.
 */
export function economyPlay(kit) {
  const mints = new Map();
  const mockReads = { balances: {}, pools: {}, lotteries: {}, stakes: {}, contests: {}, holds: {} };
  const now = () => kit.now?.() ?? Math.floor(Date.now() / 1000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function spec() {
    const config = await kit.ready();
    if (!config.economy) throw said('This game has no economy.');
    return readEconomy(config.economy);
  }

  /** The economy as it is live: the spec, the game's address, its Game and Platform accounts. */
  async function live() {
    const e = await spec();
    const game = e.game ?? (e.collection ? lootPda.game(e.collection) : null);
    if (!game) throw said(`${e.name} is not on sale yet: its economy is not live.`);
    const [g, p] = await kit.rpc().accounts([game, lootPda.platform()]);
    if (!g || !p) throw said(`${e.name} is not on sale yet: its economy is not live.`);
    const gameAccount = decodeLoot(LootAccount.Game, g.data);
    if (gameAccount.paused) throw said(PLAIN.Paused);
    const platform = decodeLoot(LootAccount.Platform, p.data);
    return { e, game, gameAccount, platform, fee: BigInt(currentFees(platform).player) };
  }

  /** A mint's token program and decimals. */
  async function mintInfo(mint) {
    if (!mints.has(mint)) {
      const [a] = await kit.rpc().accounts([mint]);
      if (!a) throw said(`There is no token ${mint} on this network.`);
      mints.set(mint, { program: a.owner, decimals: mintDecimals(a.data) });
    }
    return mints.get(mint);
  }

  const symbolOf = (e, mint) => [...e.tokens.values()].find((t) => t.mint === mint)?.symbol ?? (mint === NATIVE_MINT ? 'SOL' : 'tokens');

  /** The player holds `units` of `mint` and `lamports` of SOL for the fee and new accounts; else says how much more. */
  async function canPay(e, player, mint, units, lamports, decimals) {
    const client = kit.rpc();
    const sol = await client.balance(player);
    const sym = symbolOf(e, mint);
    if (mint === NATIVE_MINT) {
      const need = BigInt(units) + lamports;
      if (sol < need) throw said(`You need ${fromUnits(need - sol, 9)} SOL more.`);
      return;
    }
    const { program } = await mintInfo(mint);
    const have = await client.tokenBalance(ata(player, mint, program));
    if (have < BigInt(units)) throw said(`You need ${fromUnits(BigInt(units) - have, decimals ?? (await mintInfo(mint)).decimals)} ${sym} more.`);
    if (sol < lamports) throw said(`You need ${fromUnits(lamports - sol, 9)} SOL more for the fee.`);
  }

  /** The most the player agrees to pay: what they passed, else the spec's price (the price now, when it rises). */
  function guard(e, part, token, current, maxPrice) {
    const cap = maxPrice !== undefined ? toUnits(maxPrice, token.decimals) : part.rise ? current : toUnits(part.price, token.decimals);
    if (current > cap) throw said(`The price of ${part.name} is now ${e.money(current, token)} (you agreed to at most ${e.money(cap, token)}). Look again and confirm.`);
    return cap;
  }

  /** Extras for the transfers of several mints, merged. */
  async function extrasFor(byMint) {
    const all = [];
    for (const [mint, transfers] of byMint) all.push(...(await transferExtras(kit.rpc(), mint, transfers)));
    return merge(all);
  }

  /** Send, with the program's refusals in plain words. */
  async function send(player, instructions, signers = []) {
    try {
      return await kit.send(player, instructions, signers);
    } catch (error) {
      throw plainError(error);
    }
  }

  async function readOrder(order) {
    const [a] = await kit.rpc().accounts([order]);
    return a ? decodeLoot(LootAccount.Order, a.data) : null;
  }

  /** The player's collectibles in this game's collection. */
  async function collectibles(e, player) {
    if (!e.collection) return [];
    return collectiblesFrom(await kit.rpc().programAccounts(MPL_CORE_PROGRAM, ownedAssetFilters(player, e.collection)));
  }

  /** A Holder share's token account: the account of whoever holds the collectible now (any account when nobody does). */
  async function holderAccounts(shares, mint, program, game) {
    const out = {};
    for (const s of shares) {
      const asset = s.to?.Holder?.[0];
      if (!asset) continue;
      const [a] = await kit.rpc().accounts([asset]);
      const owner = a ? parseCoreAsset(a.data).owner : null;
      out[asset] = owner && owner !== game ? ata(owner, mint, program) : asset;
    }
    return out;
  }

  /** The second approval of a purchase: mint the item, or pay the prize, from a rolled order. */
  async function settle(e, player, order, o, gameAccount) {
    const { program } = await mintInfo(o.mint);
    const vault = ata(o.game, o.mint, program);
    const holderAccount = await holderAccounts(o.shares, o.mint, program, o.game);
    const targets = shareAccounts(o.game, o.shares, holderAccount).filter((m) => m.isWritable).map((m) => m.pubkey);
    const byMint = new Map([[o.mint, [gameAccount.treasury, ...targets].map((destination) => ({ source: vault, destination, authority: o.game, amount: o.paid }))]]);
    const prize = o.outcome?.Pay ?? o.outcome?.Share;
    const before = [];
    const after = [];
    let prizeTo;
    let prizeMint;
    if (prize) {
      const pool = lootPda.pool(o.game, prize.pool);
      const [p] = await kit.rpc().accounts([pool]);
      prizeMint = readTokenAccount(p?.data)?.mint;
      if (!prizeMint) throw said('The prize pool is gone. Your payment comes back after 7 days (finish the order then).');
      const prizeProgram = (await mintInfo(prizeMint)).program;
      prizeTo = ata(player, prizeMint, prizeProgram);
      before.push(createAssociatedTokenAccountIdempotent(player, player, prizeMint, prizeProgram));
      if (prizeMint === NATIVE_MINT) after.push(closeTokenAccount(prizeTo, player, player));
      byMint.set(prizeMint, [...(byMint.get(prizeMint) ?? []), { source: pool, destination: prizeTo, authority: o.game, amount: BigInt(prize.amount ?? 0) }]);
    }
    const extras = await extrasFor(byMint);
    const [budget, ix] = settleOrderIxs({ signer: player, order, orderAccount: o, gameAccount, tokenProgram: program, holderAccount, prizeTo, prizeMint, extras });
    return send(player, [budget, ...before, ix, ...after]);
  }

  async function refund(player, order, o) {
    const { program } = await mintInfo(o.mint);
    const extras = await transferExtras(kit.rpc(), o.mint, [{ source: ata(o.game, o.mint, program), destination: ata(o.player, o.mint, program), authority: o.game, amount: o.paid }]);
    const instructions = [refundOrderIx({ signer: player, order, orderAccount: o, tokenProgram: program, extras })];
    if (o.mint === NATIVE_MINT) instructions.push(closeTokenAccount(ata(player, NATIVE_MINT), player, player));
    return send(player, instructions);
  }

  /** What a rolled order gave, in words. */
  function outcomeOf(e, o, order) {
    if (o.outcome?.Item) {
      const id = o.outcome.Item[0];
      const item = e.itemById(id);
      return { kind: 'item', item: item?.key ?? null, name: item?.name ?? `Item ${id}`, asset: lootPda.asset(order, o.requested_slot), serial: o.serial, says: `You got ${item?.name ?? `item ${id}`}!` };
    }
    const prize = o.outcome?.Pay ?? o.outcome?.Share;
    if (prize) {
      const pool = e.poolByIndex(prize.pool);
      const t = e.poolToken(pool?.key);
      const amount = e.money(BigInt(prize.amount ?? 0), t);
      return { kind: 'prize', pool: pool?.key ?? null, units: String(prize.amount ?? 0), amount, says: `You won ${amount}!` };
    }
    if (o.outcome === 'Burn') return { kind: 'burn', says: 'Burned: nothing this time.' };
    return { kind: 'nothing', says: 'Nothing this time.' };
  }

  const mock = (part, says, extra = {}) => ({ part, mock: true, signatures: [], says, ...extra });
  const find = (e, kind, key) => e.part(kind, key) ?? (() => {
    throw said(`There is no ${kind} “${key}” in ${e.name}’s economy.`);
  })();

  // ------------------------------------------------------------ the calls a player signs

  /** Buy an item: pay (one approval), then claim the collectible (a second). A normal item is delivered by the game. */
  async function buy(key, { maxPrice } = {}) {
    const e = await spec();
    const item = find(e, 'item', key);
    if (!(Number(item.price ?? 0) > 0)) throw said(`${item.name} is not sold directly.`);
    const player = await kit.connect();
    if (kit.mock()) return mock(`item:${key}`, `Pretend: you bought ${item.name}.`, { outcome: { kind: 'item', item: key, name: item.name } });
    const { game, gameAccount, fee } = await live();
    kit.say('Getting it ready…');
    const [a] = await kit.rpc().accounts([lootPda.item(game, item.id)]);
    const onChain = a ? decodeLoot(LootAccount.Item, a.data) : null;
    if (!onChain?.active) throw said(`${item.name} is not on sale right now.`);
    if (soldOut(onChain)) throw said(`${item.name} is sold out.`);
    const mint = gameAccount.mint;
    const { program, decimals } = await mintInfo(mint);
    const token = { ...e.currency, decimals, symbol: symbolOf(e, mint) };
    const price = priceAt(onChain, now());
    const maxPriceUnits = guard(e, item, token, price, maxPrice);
    await canPay(e, player, mint, price, ESCROW_LAMPORTS + fee, decimals);
    const extras = await transferExtras(kit.rpc(), mint, [{ source: ata(player, mint, program), destination: ata(game, mint, program), authority: player, amount: price }]);
    const sale = buyItemIxs({ player, game, mint, itemId: item.id, maxPrice: maxPriceUnits, tokenProgram: program, extras });
    kit.say('Approve the purchase in your wallet…');
    const paid = await send(player, withSolWrap(player, mint, price, sale.instructions));
    const o = await readOrder(sale.order);
    if (!o) throw said('That order is gone: it was settled or refunded.');
    if (onChain.kind === 'Normal' || onChain.kind?.Normal) return { part: `item:${key}`, order: sale.order, signatures: [paid], waiting: true, says: `Paid. The game delivers ${item.name}.` };
    kit.say('Approve claiming it in your wallet…');
    const claimed = await settle(e, player, sale.order, o, gameAccount);
    const outcome = outcomeOf(e, o, sale.order);
    kit.emit('items', outcome);
    kit.say('');
    return { part: `item:${key}`, order: sale.order, asset: outcome.asset, outcome, signatures: [paid, claimed], says: `${item.name} is yours.` };
  }

  /** Open a box: pay and roll (one approval), wait for the oracle, then claim what it rolled (a second). */
  async function openBox(key, { maxPrice } = {}) {
    const e = await spec();
    const box = find(e, 'box', key);
    const player = await kit.connect();
    if (kit.mock()) return mock(`box:${key}`, `Pretend: you opened ${box.name}.`, { outcome: { kind: 'nothing', says: 'Nothing this time.' } });
    const { game, gameAccount, fee } = await live();
    kit.say('Getting the box ready…');
    const [a] = await kit.rpc().accounts([lootPda.box(game, box.id)]);
    const onChain = a ? decodeLoot(LootAccount.Box, a.data) : null;
    if (!onChain?.active) throw said(`${box.name} is not open right now.`);
    const mint = onChain.currency ?? gameAccount.mint;
    const { program, decimals } = await mintInfo(mint);
    const token = { decimals, symbol: symbolOf(e, mint) };
    const price = priceAt(onChain, now());
    const maxPriceUnits = guard(e, box, token, price, maxPrice);
    await canPay(e, player, mint, price, ESCROW_LAMPORTS + fee, decimals);
    const extras = await transferExtras(kit.rpc(), mint, [{ source: ata(player, mint, program), destination: ata(game, mint, program), authority: player, amount: price }]);
    const open = openBoxIxs({ player, game, mint, boxId: box.id, box: onChain, maxPrice: maxPriceUnits, tokenProgram: program, extras });
    kit.say('Approve opening it in your wallet…');
    const opened = await send(player, withSolWrap(player, mint, price, open.instructions));
    kit.say('Rolling…');
    let o = null;
    for (let poll = 0; poll < ROLL_POLLS; poll++) {
      o = await readOrder(open.order);
      if (!o || o.status !== OrderStatus.Pending) break;
      await sleep(kit.rollPollMs ?? 1000);
    }
    if (!o) throw said('That order is gone: it was settled or refunded.');
    if (o.status === OrderStatus.Pending) throw said('The box was opened but the roll has not arrived yet. Claim it in a minute.');
    if (o.status === OrderStatus.Failed) {
      kit.say('Nothing left to win: approve the refund in your wallet…');
      await refund(player, open.order, o);
      throw said('Nothing in the box could be won just now (sold out, or a prize pool ran dry). Your payment was refunded.');
    }
    const outcome = outcomeOf(e, o, open.order);
    kit.say(`${outcome.says} Approve claiming it in your wallet…`);
    const claimed = await settle(e, player, open.order, o, gameAccount);
    if (outcome.kind === 'item') kit.emit('items', outcome);
    kit.say('');
    return { part: `box:${key}`, order: open.order, outcome, signatures: [opened, claimed], says: outcome.says };
  }

  /** Pay a payment (an entry, an attempt). `reference`: 32 bytes the game names it by (random when left out). */
  async function pay(key, { reference } = {}) {
    const e = await spec();
    const p = find(e, 'payment', key);
    const player = await kit.connect();
    const ref = reference ? Uint8Array.from(reference) : randomBytes(32);
    if (kit.mock()) return mock(`payment:${key}`, `Pretend: you paid for ${p.name}.`, { reference: Array.from(ref) });
    const { game, gameAccount, fee } = await live();
    const t = e.token(p.currency);
    const mint = t?.mint ?? gameAccount.mint;
    const { program, decimals } = await mintInfo(mint);
    const amount = toUnits(p.amount, decimals);
    const shares = sharesFor(p.split, e);
    const holderAccount = await holderAccounts(shares, mint, program, game);
    const targets = shareAccounts(game, shares, holderAccount);
    await canPay(e, player, mint, amount, fee, decimals);
    const source = ata(player, mint, program);
    const extras = await transferExtras(kit.rpc(), mint, [gameAccount.treasury, ...targets.filter((m) => m.isWritable).map((m) => m.pubkey)].map((destination) => ({ source, destination, authority: player, amount })));
    const ix = payIx({ player, game, mint, treasury: gameAccount.treasury, amount, shares, reference: ref, tokenProgram: program, remaining: [...targets, ...extras] });
    kit.say('Approve the payment in your wallet…');
    const signature = await send(player, withSolWrap(player, mint, amount, [ix]));
    return { part: `payment:${key}`, reference: Array.from(ref), signatures: [signature], says: `Paid ${e.money(amount, { decimals, symbol: symbolOf(e, mint) })} for ${p.name}.` };
  }

  /** Craft a recipe `times` over (once for any recipe with a collectible in it). One approval. */
  async function craft(key, { times = 1 } = {}) {
    const e = await spec();
    const r = find(e, 'recipe', key);
    const player = await kit.connect();
    if (kit.mock()) return mock(`recipe:${key}`, `Pretend: you made ${r.name}.`);
    const { game, fee } = await live();
    const [a] = await kit.rpc().accounts([lootPda.recipe(game, r.id)]);
    const recipe = a ? decodeLoot(LootAccount.Recipe, a.data) : null;
    if (!recipe?.active) throw said(`${r.name} cannot be made right now.`);
    const ids = [...new Set([...recipe.inputs, ...recipe.outputs].map((l) => l.Burn?.item ?? l.Use?.item ?? l.Renew?.item ?? l.Item?.[0]).filter((id) => id !== undefined))];
    const itemAccounts = await kit.rpc().accounts(ids.map((id) => lootPda.item(game, id)));
    const items = Object.fromEntries(ids.map((id, i) => [id, itemAccounts[i] ? decodeLoot(LootAccount.Item, itemAccounts[i].data) : null]));
    const owned = recipe.inputs.some((l) => l.Burn || l.Use || l.Renew) ? await collectibles(e, player) : [];
    const at = now();
    const taken = new Set();
    const nameOf = (id) => items[id]?.name ?? e.itemById(id)?.name ?? `item ${id}`;
    const pick = (id, use) => {
      const mine = owned.filter((c) => c.itemId === id && !taken.has(c.asset));
      if (!mine.length) return { error: `You need ${use === 'count' ? 'more' : 'a'} ${nameOf(id)}.` };
      const checks = mine.map((c) => ({ c, life: lifeAllows(c, items[id], at, { use: use === 'use' }) }));
      const ok = checks.find((x) => x.life.ok);
      if (ok) return { asset: ok.c.asset };
      const why = checks[0].life;
      if (why.why === 'resting') return { error: `Your ${nameOf(id)} is resting: ready again ${inWords(why.at - at)}.` };
      if (why.why === 'not ready') return { error: `Your ${nameOf(id)} is not ready yet: ready ${inWords(why.at - at)}.` };
      if (why.why === 'used up') return { error: `Your ${nameOf(id)} has no uses left.` };
      return { error: `Your ${nameOf(id)} has expired.` };
    };
    const remaining = [];
    const before = [];
    const after = [];
    const signers = [];
    const pays = new Map();
    const transfers = new Map();
    const addTransfer = (mint, t) => transfers.set(mint, [...(transfers.get(mint) ?? []), t]);
    const n = BigInt(times);
    for (const line of recipe.inputs) {
      if (line.Burn || line.Use || line.Renew) {
        const { item, count = 1 } = line.Burn ?? line.Use ?? line.Renew;
        remaining.push(meta(lootPda.item(game, item), false, false));
        for (let i = 0; i < count; i++) {
          const got = pick(item, line.Use ? 'use' : line.Burn && count > 1 ? 'count' : 'one');
          if (got.error) throw said(got.error);
          taken.add(got.asset);
          remaining.push(meta(got.asset, false, true));
        }
        continue;
      }
      const { mint, amount, to } = line.Pay;
      const { program } = await mintInfo(mint);
      const from = ata(player, mint, program);
      remaining.push(meta(mint, false, true), meta(from, false, true));
      const holderAccount = await holderAccounts([{ to }], mint, program, game);
      const targets = to === 'Burn' ? [] : shareAccounts(game, [{ to }], holderAccount);
      remaining.push(...targets);
      pays.set(mint, (pays.get(mint) ?? 0n) + BigInt(amount) * n);
      for (const m of targets.filter((x) => x.isWritable)) addTransfer(mint, { source: from, destination: m.pubkey, authority: player, amount: BigInt(amount) * n });
    }
    let made = 0;
    for (const line of recipe.outputs) {
      if (line.Item) {
        const id = line.Item[0];
        const item = items[id];
        if (item && soldOut(item)) throw said(`${nameOf(id)} is sold out.`);
        const signer = await freshSigner();
        signers.push(signer);
        remaining.push(meta(lootPda.item(game, id), false, true), meta(signer.address, true, true));
        made++;
        continue;
      }
      const { mint, from } = line.Tokens ?? line.Share;
      const { program } = await mintInfo(mint);
      const to = ata(player, mint, program);
      const pool = line.Share ? line.Share.pool : from?.Pool?.[0];
      remaining.push(meta(mint, false, Boolean(line.Tokens && from === 'Issue')));
      if (pool !== undefined) remaining.push(meta(lootPda.pool(game, pool), false, true));
      remaining.push(meta(to, false, true));
      before.push(createAssociatedTokenAccountIdempotent(player, player, mint, program));
      if (mint === NATIVE_MINT) after.push(closeTokenAccount(to, player, player));
      if (pool !== undefined) addTransfer(mint, { source: lootPda.pool(game, pool), destination: to, authority: game, amount: BigInt(line.Tokens?.amount ?? 0) * n });
    }
    for (const [mint, units] of pays) await canPay(e, player, mint, units, fee + BigInt(made) * RENT.asset);
    if (!pays.size) await canPay(e, player, NATIVE_MINT, 0n, fee + BigInt(made) * RENT.asset);
    for (const mint of pays.keys()) if (!transfers.has(mint)) transfers.set(mint, []);
    const extras = await extrasFor(transfers);
    const ix = craftIx({ player, game, id: r.id, collection: e.collection, version: recipe.version, times: n, remaining: [...remaining, ...extras] });
    let instructions = [computeUnitLimit(CRAFT_UNITS), ...before, ix, ...after];
    const sol = pays.get(NATIVE_MINT);
    if (sol) instructions = withSolWrap(player, NATIVE_MINT, sol, instructions);
    kit.say(`Approve making ${r.name} in your wallet…`);
    const signature = await send(player, instructions, signers);
    const outcome = { kind: 'crafted', made: signers.map((s) => s.address), used: [...taken] };
    if (made) kit.emit('items', outcome);
    return { part: `recipe:${key}`, outcome, signatures: [signature], says: `Made: ${r.name}.` };
  }

  /** The lottery's account and its list of purchases. */
  async function readLottery(game, l) {
    const [a] = await kit.rpc().accounts([lootPda.lottery(game, l.id)]);
    if (!a) throw said(`The lottery “${l.name}” is not running.`);
    return { lottery: decodeLoot(LootAccount.Lottery, a.data), lines: lotteryLines(a.data) };
  }

  /** The mint a lottery's tickets are bought in: its ticket mint, else its pot's. */
  async function ticketMint(game, lottery) {
    if (lottery.ticket_mint !== NO_ADDRESS) return lottery.ticket_mint;
    const [p] = await kit.rpc().accounts([lootPda.pool(game, lottery.pot)]);
    const mint = readTokenAccount(p?.data)?.mint;
    if (!mint) throw said('This lottery’s pot is not open.');
    return mint;
  }

  /** Buy `count` tickets. One approval. */
  async function buyTickets(key, { count = 1, maxPrice } = {}) {
    const e = await spec();
    const l = find(e, 'lottery', key);
    const player = await kit.connect();
    if (!(Number(count) >= 1)) throw said('Buy at least one ticket.');
    if (kit.mock()) {
      const r = (mockReads.lotteries[key] ??= { price: '0', pot: '0', status: 'Open', drawsAt: now() + toSeconds(l.every), sold: 0, round: 0, mine: 0, places: [], winners: [], paid: 0 });
      r.mine += Number(count);
      r.sold += Number(count);
      return mock(`lottery:${key}`, `Pretend: you have ${r.mine} ticket${r.mine === 1 ? '' : 's'} in “${l.name}”.`, { tickets: r.mine });
    }
    const { game, gameAccount, fee } = await live();
    const { lottery, lines } = await readLottery(game, l);
    const t = now();
    if (lottery.status !== 'Open') throw said(`The draw of “${l.name}” is under way; tickets go on sale again once the winners are paid.`);
    if (t >= Number(lottery.draws_at)) throw said(`This round of “${l.name}” closed; the draw is due now. Start the draw, then buy for the next round.`);
    const mint = await ticketMint(game, lottery);
    const { program, decimals } = await mintInfo(mint);
    const token = { decimals, symbol: symbolOf(e, mint) };
    const cap = maxPrice !== undefined ? toUnits(maxPrice, decimals) : toUnits(l.price, decimals);
    if (BigInt(lottery.price) > cap) throw said(`A ticket now costs ${e.money(BigInt(lottery.price), token)} (you agreed to at most ${e.money(cap, token)}). Look again and confirm.`);
    const cost = BigInt(lottery.price) * BigInt(count);
    await canPay(e, player, mint, cost, fee + RENT.line, decimals);
    const source = ata(player, mint, program);
    const pot = lootPda.pool(game, lottery.pot);
    const extras = await transferExtras(kit.rpc(), mint, [gameAccount.treasury, pot].map((destination) => ({ source, destination, authority: player, amount: cost })));
    const ix = buyTicketsIx({ player, game, id: l.id, pot: lottery.pot, mint, treasury: gameAccount.treasury, count, maxPrice: cap, tokenProgram: program, remaining: extras });
    kit.say('Approve the tickets in your wallet…');
    const signature = await send(player, withSolWrap(player, mint, cost, [ix]));
    const mine = Number(ticketsOf(lines, player)) + Number(count);
    return { part: `lottery:${key}`, tickets: mine, signatures: [signature], says: `You have ${mine} ticket${mine === 1 ? '' : 's'} in “${l.name}”; the draw is ${inWords(Number(lottery.draws_at) - t)}.` };
  }

  /** A stake's account, the player's position and what the rewards pool holds. */
  async function readStake(game, s, player) {
    const stakeAddress = lootPda.stake(game, s.id);
    const [a, p] = await kit.rpc().accounts([stakeAddress, lootPda.position(stakeAddress, player)]);
    if (!a) throw said(`The stake “${s.name}” is not open.`);
    const stake = decodeLoot(LootAccount.Stake, a.data);
    const [pool] = await kit.rpc().accounts([lootPda.pool(game, stake.rewards_pool)]);
    const poolHolds = readTokenAccount(pool?.data)?.mint === stake.rewards_mint ? readTokenAccount(pool.data).amount : 0n;
    return { stake, position: p ? decodePosition(p.data) : null, poolHolds };
  }

  /** Stake or unstake: the same accounts. `forfeit` (unstake): leave without the rewards, when they can't be paid. */
  async function staking(key, verb, amount, forfeit = false) {
    const e = await spec();
    const s = find(e, 'stake', key);
    const player = await kit.connect();
    const sym = e.token(s.stakes)?.symbol ?? '';
    if (kit.mock()) {
      const r = (mockReads.stakes[key] ??= { staked: 0n, pending: 0n, since: now(), lock: toSeconds(s.lock) });
      const units = amount === 'all' || amount === undefined ? (verb === 'stake' ? 100n : r.staked) : BigInt(Math.round(Number(amount)));
      r.staked = verb === 'stake' ? r.staked + units : r.staked - (units > r.staked ? r.staked : units);
      return mock(`stake:${key}`, `Pretend: you ${verb}d ${units} ${sym}.`);
    }
    const { game, fee } = await live();
    const { stake, position } = await readStake(game, s, player);
    const [m, rm] = [await mintInfo(stake.mint), await mintInfo(stake.rewards_mint)];
    const token = { decimals: m.decimals, symbol: symbolOf(e, stake.mint) };
    const staked = BigInt(position?.amount ?? 0);
    let units;
    if (verb === 'stake') {
      if (amount === 'all' || amount === undefined) {
        if (stake.mint === NATIVE_MINT) throw said('Say how much SOL to stake.');
        units = await kit.rpc().tokenBalance(ata(player, stake.mint, m.program));
        if (!units) throw said(`You have no ${token.symbol} to stake.`);
      } else units = toUnits(amount, m.decimals);
      if (!units) throw said('Stake more than nothing.');
      await canPay(e, player, stake.mint, units, fee + (position ? 0n : RENT.position) + RENT.ata, m.decimals);
    } else {
      units = amount === 'all' || amount === undefined ? staked : toUnits(amount, m.decimals);
      if (!position) throw said(`You have nothing staked in “${s.name}”.`);
      if (units > staked) throw said(`You have only ${e.money(staked, token)} staked.`);
      const unlocks = Number(position.since) + Number(stake.lock);
      if (units > 0n && now() < unlocks) throw said(`Your stake in “${s.name}” is locked until ${new Date(unlocks * 1000).toUTCString()} (${inWords(unlocks - now())}). You can still collect what it earned.`);
      await canPay(e, player, NATIVE_MINT, 0n, fee);
    }
    const stakeAddress = lootPda.stake(game, s.id);
    const [vault, rewardsVault, pool, mine, mineRewards] = [lootPda.staked(stakeAddress), lootPda.rewards(stakeAddress), lootPda.pool(game, stake.rewards_pool), ata(player, stake.mint, m.program), ata(player, stake.rewards_mint, rm.program)];
    const byMint = new Map();
    const add = (mint, t) => byMint.set(mint, [...(byMint.get(mint) ?? []), t]);
    add(stake.mint, verb === 'stake' ? { source: mine, destination: vault, authority: player, amount: units } : { source: vault, destination: mine, authority: game, amount: units });
    add(stake.rewards_mint, { source: pool, destination: rewardsVault, authority: game, amount: 0n });
    add(stake.rewards_mint, { source: rewardsVault, destination: mineRewards, authority: game, amount: 0n });
    const extras = await extrasFor(byMint);
    const args = { player, game, id: s.id, mint: stake.mint, rewardsMint: stake.rewards_mint, rewardsPool: stake.rewards_pool, tokenProgram: m.program, rewardsTokenProgram: rm.program, amount: units, forfeit, remaining: extras };
    const before = [createAssociatedTokenAccountIdempotent(player, player, stake.rewards_mint, rm.program)];
    if (verb !== 'stake') before.push(createAssociatedTokenAccountIdempotent(player, player, stake.mint, m.program));
    let instructions = [...before, verb === 'stake' ? stakeIx(args) : unstakeIx(args)];
    if (verb === 'stake' && stake.mint === NATIVE_MINT) instructions = withSolWrap(player, NATIVE_MINT, units, instructions);
    else if (stake.mint === NATIVE_MINT || stake.rewards_mint === NATIVE_MINT) instructions.push(closeTokenAccount(ata(player, NATIVE_MINT), player, player));
    kit.say(`Approve ${verb === 'stake' ? 'staking' : units ? 'unstaking' : 'collecting'} in your wallet…`);
    const signature = await send(player, instructions);
    const says = verb === 'stake' ? `Staked ${e.money(units, token)} in “${s.name}”.` : units ? `Took ${e.money(units, token)} out of “${s.name}”, ${forfeit ? 'without what it earned' : 'with what it earned'}.` : `Collected what “${s.name}” earned.`;
    return { part: `stake:${key}`, units: String(units), signatures: [signature], says };
  }
  const stake = (key, { amount = 'all' } = {}) => staking(key, 'stake', amount);
  const unstake = (key, { amount = 'all', forfeit = false } = {}) => staking(key, 'unstake', amount, forfeit);

  /** Hand one of the hold's item to the game for the spec's time. One approval. `asset`: which one (else the first). */
  async function hold(key, { asset } = {}) {
    const e = await spec();
    const h = find(e, 'hold', key);
    const item = find(e, 'item', h.item);
    const player = await kit.connect();
    if (kit.mock()) {
      (mockReads.holds[key] ??= []).push({ asset: `mock-held-${mockReads.holds[key].length + 1}`, freeAt: now() + toSeconds(h.for) });
      return mock(`hold:${key}`, `Pretend: your ${item.name} went on ${h.name}.`);
    }
    const { game, fee } = await live();
    const mine = (await collectibles(e, player)).filter((c) => c.itemId === item.id && !c.frozen && (!asset || c.asset === asset));
    if (!mine.length) throw said(`You have no ${item.name} to send.`);
    await canPay(e, player, NATIVE_MINT, 0n, fee + RENT.hold);
    const seconds = toSeconds(h.for);
    kit.say(`Approve sending your ${item.name} in your wallet…`);
    const signature = await send(player, [holdIx({ player, game, asset: mine[0].asset, collection: e.collection, seconds: BigInt(seconds) })]);
    return { part: `hold:${key}`, asset: mine[0].asset, freeAt: now() + seconds, signatures: [signature], says: `Your ${item.name} is with the game; it comes home ${inWords(seconds)} at the latest.` };
  }

  /** A contest's account, or null when none is open at its id. */
  async function readContest(game, c) {
    const [a] = await kit.rpc().accounts([lootPda.contest(game, c.id)]);
    return a ? decodeLoot(LootAccount.Contest, a.data) : null;
  }

  /** Put `amount` on `side` (its number or its name). One approval. */
  async function enter(key, { side = 0, amount } = {}) {
    const e = await spec();
    const c = find(e, 'contest', key);
    const player = await kit.connect();
    const index = typeof side === 'number' ? side : /^\d+$/.test(String(side)) ? Number(side) : (c.sideNames ?? []).findIndex((n) => n.toLowerCase() === String(side).toLowerCase());
    if (!(index >= 0 && index < c.sides)) throw said(`“${c.name}” has no side ${side}.`);
    const t = e.token(c.currency);
    const value = amount ?? (t?.wsol ? '0.01' : '1');
    const sideName = c.sideNames?.[index] ?? `side ${index + 1}`;
    if (kit.mock()) {
      const r = (mockReads.contests[key] ??= { open: true, verdict: 'Open', winner: 0, closesAt: now() + toSeconds(c.entriesClose ?? '1h'), resultBy: now() + toSeconds(c.resultDue ?? '1h'), sides: Array(c.sides).fill('0'), mine: [] });
      r.mine.push({ side: index, amount: String(value) });
      return mock(`contest:${key}`, `Pretend: you backed ${sideName}.`);
    }
    const { game, fee } = await live();
    const contest = await readContest(game, c);
    if (!contest) throw said(`There is no “${c.name}” open right now.`);
    if (contest.verdict !== 'Open' || now() >= Number(contest.closes_at)) throw said(`Entries for “${c.name}” closed${contest.verdict === 'Open' ? `; the result is due ${inWords(Number(contest.result_by) - now())}` : ''}.`);
    const { program, decimals } = await mintInfo(contest.mint);
    const units = toUnits(value, decimals);
    if (!units) throw said('Put more than nothing on a side.');
    await canPay(e, player, contest.mint, units, fee + RENT.entry, decimals);
    const source = ata(player, contest.mint, program);
    const extras = await transferExtras(kit.rpc(), contest.mint, [{ source, destination: lootPda.pot(lootPda.contest(game, c.id)), authority: player, amount: units }]);
    const ix = enterIx({ player, game, id: c.id, side: index, amount: units, terms: contest.terms, mint: contest.mint, tokenProgram: program, remaining: extras });
    kit.say(`Approve backing ${sideName} in your wallet…`);
    const signature = await send(player, withSolWrap(player, contest.mint, units, [ix]));
    return { part: `contest:${key}`, side: index, units: String(units), signatures: [signature], says: `You put ${e.money(units, { decimals, symbol: symbolOf(e, contest.mint) })} on ${sideName}.` };
  }

  /** The player's entries in a contest: [{ side, amount, address }]. */
  async function entriesOf(game, c, player) {
    const contest = lootPda.contest(game, c.id);
    const addresses = Array.from({ length: c.sides }, (_, side) => lootPda.entry(contest, player, side));
    const found = await kit.rpc().accounts(addresses);
    return found.flatMap((a, side) => (a ? [{ side, address: addresses[side], amount: decodeLoot(LootAccount.Entry, a.data).amount }] : []));
  }

  /** Wait until a lottery's draw is in (the oracle answers within seconds on devnet), or give up. */
  async function waitForDraw(game, l) {
    let read = await readLottery(game, l);
    for (let poll = 0; poll < ROLL_POLLS && read.lottery.status === 'Drawing'; poll++) {
      await sleep(kit.rollPollMs ?? 1000);
      read = await readLottery(game, l);
    }
    return read;
  }

  /** Lottery: start the draw when due, then pay every place (anyone may; free apart from network fees). */
  async function claimLottery(e, l, player) {
    const { game } = await live();
    let { lottery, lines } = await readLottery(game, l);
    const signatures = [];
    if (lottery.status === 'Open') {
      const wait = Number(lottery.draws_at) - now();
      if (wait > 0) throw said(`The next draw of “${l.name}” is ${inWords(wait)}.`);
      kit.say('Approve starting the draw in your wallet…');
      signatures.push(await send(player, [drawLotteryIx({ payer: player, game, id: l.id })]));
      if (!lottery.sold) return { part: `lottery:${l.key}`, signatures, winners: [], says: `Nobody bought a ticket this round of “${l.name}”; the next draw is ${inWords(Number(lottery.draws_at) + toSeconds(l.every) - now())}.` };
      kit.say('Drawing…');
      ({ lottery, lines } = await waitForDraw(game, l));
    } else if (lottery.status === 'Drawing') ({ lottery, lines } = await waitForDraw(game, l));
    if (lottery.status !== 'Drawn') throw said('The draw has not come back from the oracle yet. Try again in a minute.');
    const winners = lotteryWinners(lottery, lines);
    const mint = readTokenAccount((await kit.rpc().accounts([lootPda.pool(game, lottery.pot)]))[0]?.data)?.mint;
    if (!mint) throw said('This lottery’s pot is not open.');
    const { program } = await mintInfo(mint);
    const pot = lootPda.pool(game, lottery.pot);
    const unpaid = winners.map((winner, place) => ({ winner, place })).filter(({ place }) => !(lottery.paid & (1 << place)));
    const paidOut = [];
    for (let i = 0; i < unpaid.length; i += 4) {
      const group = unpaid.slice(i, i + 4);
      const instructions = [];
      for (const { winner, place } of group) {
        const to = ata(winner, mint, program);
        const extras = await transferExtras(kit.rpc(), mint, [{ source: pot, destination: to, authority: game, amount: 0n }]);
        instructions.push(createAssociatedTokenAccountIdempotent(player, winner, mint, program));
        instructions.push(payLotteryIx({ game, id: l.id, place, firstPlace: lottery.winner, pot: lottery.pot, to, mint, remaining: extras }));
        paidOut.push({ place: place + 1, winner });
      }
      if (mint === NATIVE_MINT && group.some((g) => g.winner === player)) instructions.push(closeTokenAccount(ata(player, NATIVE_MINT), player, player));
      kit.say('Approve paying the winners in your wallet…');
      signatures.push(await send(player, instructions));
    }
    const mine = paidOut.filter((w) => w.winner === player).map((w) => w.place);
    return { part: `lottery:${l.key}`, signatures, winners: paidOut, says: mine.length ? `You won place ${mine.join(' and ')} in “${l.name}”!` : `“${l.name}” was drawn and its winners paid.` };
  }

  /** Contest: collect every entry of the player's (winnings, money back, or the entry's rent). */
  async function claimContest(e, c, player) {
    const { game } = await live();
    const contest = await readContest(game, c);
    if (!contest) throw said(`There is nothing to collect from “${c.name}”.`);
    if (contest.verdict === 'Open') throw said(`“${c.name}” has no result yet; it is due ${inWords(Number(contest.result_by) - now())}.`);
    const entries = await entriesOf(game, c, player);
    if (!entries.length) throw said(`You have nothing to collect from “${c.name}”.`);
    const { program } = await mintInfo(contest.mint);
    const to = ata(player, contest.mint, program);
    const pot = lootPda.pot(lootPda.contest(game, c.id));
    const extras = await transferExtras(kit.rpc(), contest.mint, [{ source: pot, destination: to, authority: game, amount: 0n }]);
    const instructions = [createAssociatedTokenAccountIdempotent(player, player, contest.mint, program), ...entries.map((x) => claimIx({ game, id: c.id, player, side: x.side, mint: contest.mint, tokenProgram: program, remaining: extras }))];
    if (contest.mint === NATIVE_MINT) instructions.push(closeTokenAccount(to, player, player));
    kit.say('Approve collecting in your wallet…');
    const signature = await send(player, instructions);
    const won = contest.verdict === 'Won' && entries.some((x) => x.side === contest.winner);
    return { part: `contest:${c.key}`, signatures: [signature], says: contest.verdict === 'Off' ? `“${c.name}” was called off: your money is back.` : won ? `You won “${c.name}”: your share is in your wallet.` : `Your side lost “${c.name}”.` };
  }

  /** The holds of the player's collectibles in this game: [{ hold, asset, freeAt }]. */
  async function holdsOf(game, player) {
    const found = await kit.rpc().programAccounts(LOOT_PROGRAM, [
      { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(TAG.Hold)) } },
      { memcmp: { offset: 1, bytes: game } },
      { memcmp: { offset: 65, bytes: player } },
    ]);
    return found.map(({ pubkey, account }) => {
      const h = decodeLoot(LootAccount.Hold, account.data);
      return { hold: pubkey, asset: h.asset, freeAt: Number(h.free_at) };
    });
  }

  /** Hold: bring home every collectible of the player's whose time with the game is up. */
  async function claimHold(e, h, player) {
    const { game } = await live();
    const item = e.part('item', h.item);
    const holds = await holdsOf(game, player);
    const assets = await kit.rpc().accounts(holds.map((x) => x.asset));
    const ours = holds.filter((x, i) => assets[i] && collectiblesFrom([{ pubkey: x.asset, account: assets[i] }])[0]?.itemId === item?.id);
    const over = ours.filter((x) => x.freeAt <= now());
    if (!over.length) throw said(ours.length ? `Your ${item?.name ?? h.item} comes home ${inWords(Math.min(...ours.map((x) => x.freeAt)) - now())}.` : `Nothing of yours is on ${h.name}.`);
    kit.say('Approve bringing it home in your wallet…');
    const signature = await send(player, over.map((x) => takeBackIx({ signer: player, game, asset: x.asset, player, collection: e.collection })));
    return { part: `hold:${h.key}`, assets: over.map((x) => x.asset), signatures: [signature], says: `Your ${item?.name ?? h.item} is home.` };
  }

  /** Box or item: finish the player's orders that were paid and not claimed (a declined claim, a slow roll). */
  async function claimOrders(e, player) {
    const { game, gameAccount } = await live();
    const found = await kit.rpc().programAccounts(LOOT_PROGRAM, [
      { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(TAG.Order)) } },
      { memcmp: { offset: 1, bytes: game } },
      { memcmp: { offset: 33, bytes: player } },
    ]);
    const signatures = [];
    for (const { pubkey, account } of found) {
      const o = decodeLoot(LootAccount.Order, account.data);
      if (o.status === OrderStatus.Rolled) signatures.push(await settle(e, player, pubkey, o, gameAccount));
      else if (o.status === OrderStatus.Failed) signatures.push(await refund(player, pubkey, o));
    }
    if (!signatures.length) throw said('Nothing to claim.');
    return { signatures, says: 'Claimed.' };
  }

  /** Finish one order: claim it when it was rolled, refund it when it failed or waited too long. */
  async function finish(order) {
    const e = await spec();
    const player = await kit.connect();
    const { gameAccount } = await live();
    const o = await readOrder(order);
    if (!o) throw said('That order is gone: it was settled or refunded.');
    if (o.status === OrderStatus.Rolled) {
      const signature = await settle(e, player, order, o, gameAccount);
      return { settled: true, outcome: outcomeOf(e, o, order), signatures: [signature] };
    }
    const when = refundable(o, await kit.rpc().call('getSlot', [{ commitment: 'confirmed' }]));
    if (!when.ok) throw said(`This order can be refunded from slot ${when.atSlot} on (about ${inWords(Number(when.atSlot - BigInt(await kit.rpc().call('getSlot', [{ commitment: 'confirmed' }]))) * 0.4)}).`);
    return { refunded: true, signatures: [await refund(player, order, o)] };
  }

  /**
   * Collect what is the player's: a lottery's prize (drawing it first when due), a stake's rewards, a contest's
   * winnings or refund, a held collectible whose time is up, or an unclaimed box or purchase. `key`: the part
   * ("contest:duel") or an action id ("contest:duel:claim"), or a bare key when only one part has it.
   */
  async function claim(key) {
    const e = await spec();
    const [kind, k] = String(key).includes(':') ? String(key).split(':') : [['lottery', 'stake', 'contest', 'hold', 'box', 'item'].find((x) => e.part(x, key)), key];
    if (!kind || !e.part(kind, k)) throw said(`There is nothing called “${key}” to collect from in ${e.name}’s economy.`);
    const player = await kit.connect();
    if (kit.mock()) return mock(`${kind}:${k}`, 'Pretend: collected.');
    if (kind === 'lottery') return claimLottery(e, e.part(kind, k), player);
    if (kind === 'stake') return { ...(await staking(k, 'unstake', 0)), part: `stake:${k}` };
    if (kind === 'contest') return claimContest(e, e.part(kind, k), player);
    if (kind === 'hold') return claimHold(e, e.part(kind, k), player);
    return claimOrders(e, player);
  }

  // ------------------------------------------------------------ reads

  /** Each pool: [{ key, index, address, mint, units, amount }]. */
  async function pools() {
    const e = await spec();
    if (kit.mock()) return e.pools.map((p) => ({ key: p.key, index: p.index, address: null, mint: null, units: '0', amount: e.money(0n, e.poolToken(p.key)) }));
    const { game } = await live();
    const addresses = e.pools.map((p) => lootPda.pool(game, p.index));
    const found = await kit.rpc().accounts(addresses);
    return e.pools.map((p, i) => {
      const t = readTokenAccount(found[i]?.data);
      return { key: p.key, index: p.index, address: addresses[i], mint: t?.mint ?? null, units: String(t?.amount ?? 0n), amount: e.money(t?.amount ?? 0n, e.poolToken(p.key)), open: Boolean(t) };
    });
  }

  /** A box's odds as the program rolls them now (sold-out items and dry prizes skipped): [{ gives, label, chance, available }]. */
  async function boxOdds(key) {
    const e = await spec();
    const b = find(e, 'box', key);
    if (kit.mock()) return (b.outcomes ?? []).map((o) => ({ gives: o.gives, label: o.item ?? o.gives, chance: (o.chance ?? 0) / 100, available: true }));
    const { game } = await live();
    const [a] = await kit.rpc().accounts([lootPda.box(game, b.id)]);
    if (!a) throw said(`${b.name} is not open.`);
    const box = decodeLoot(LootAccount.Box, a.data);
    const itemIds = box.entries.flatMap((x) => (x.outcome.Item ? [x.outcome.Item[0]] : []));
    const poolIds = [...new Set(box.entries.flatMap((x) => (x.outcome.Pay || x.outcome.Share ? [(x.outcome.Pay ?? x.outcome.Share).pool] : [])))];
    const found = await kit.rpc().accounts([...itemIds.map((id) => lootPda.item(game, id)), ...poolIds.map((i) => lootPda.pool(game, i))]);
    const items = Object.fromEntries(itemIds.map((id, i) => [id, found[i] ? decodeLoot(LootAccount.Item, found[i].data) : null]));
    const pools = Object.fromEntries(poolIds.map((index, i) => [index, readTokenAccount(found[itemIds.length + i]?.data)?.amount ?? 0n]));
    return oddsOf(box, { items, pools }).map((row) => {
      const o = row.outcome;
      const label = o.Item ? (e.itemById(o.Item[0])?.name ?? `Item ${o.Item[0]}`) : o.Pay ? `${e.money(BigInt(o.Pay.amount), e.poolToken(e.poolByIndex(o.Pay.pool)?.key))}` : o.Share ? `${o.Share.bps / 100}% of ${e.poolByIndex(o.Share.pool)?.key}` : String(o).toLowerCase();
      return { gives: o.Item ? 'item' : o.Pay ? 'pay' : o.Share ? 'share' : String(o).toLowerCase(), label, chance: row.chance, available: row.available };
    });
  }

  /** A lottery now: { status, round, price, pot, drawsAt, nextDraw, sold, mine, places, winners, paid }. */
  async function lottery(key) {
    const e = await spec();
    const l = find(e, 'lottery', key);
    if (kit.mock()) return { ...(mockReads.lotteries[key] ?? { status: 'Open', sold: 0, mine: 0 }) };
    const { game } = await live();
    const { lottery: x, lines } = await readLottery(game, l);
    const [pot] = await kit.rpc().accounts([lootPda.pool(game, x.pot)]);
    const potUnits = readTokenAccount(pot?.data)?.amount ?? 0n;
    const player = kit.address();
    const potToken = e.poolToken(l.pot);
    return {
      status: x.status, round: x.round, price: String(x.price), pot: String(potUnits), potText: e.money(potUnits, potToken), drawsAt: Number(x.draws_at),
      nextDraw: inWords(Number(x.draws_at) - now()), sold: Number(x.sold), mine: player ? Number(ticketsOf(lines, player)) : 0,
      places: x.places.filter(Boolean), winners: lotteryWinners(x, lines), paid: x.paid,
    };
  }

  /** The player's position in a stake: { staked, pending, since, lock, unlocksAt } (base units as text). */
  async function stakePosition(key) {
    const e = await spec();
    const s = find(e, 'stake', key);
    if (kit.mock()) {
      const r = mockReads.stakes[key] ?? { staked: 0n, pending: 0n, since: 0, lock: toSeconds(s.lock) };
      return { staked: String(r.staked), pending: String(r.pending), since: r.since, lock: r.lock, unlocksAt: r.since + r.lock };
    }
    const player = kit.address();
    const { game } = await live();
    if (!player) return { staked: '0', pending: '0', since: 0, lock: toSeconds(s.lock), unlocksAt: 0 };
    const { stake, position, poolHolds } = await readStake(game, s, player);
    const since = Number(position?.since ?? 0);
    return { staked: String(position?.amount ?? 0n), pending: String(pendingRewards(stake, position, poolHolds)), since, lock: Number(stake.lock), unlocksAt: since + Number(stake.lock), total: String(stake.total) };
  }

  /** A contest now: { open, verdict, winner, closesAt, resultBy, sides: [units], pot, mine: [{ side, amount }] }, or { open: false } when none is open. */
  async function contest(key) {
    const e = await spec();
    const c = find(e, 'contest', key);
    if (kit.mock()) return { ...(mockReads.contests[key] ?? { open: false, sides: [], mine: [] }) };
    const { game } = await live();
    const x = await readContest(game, c);
    if (!x) return { open: false, verdict: 'none', sides: [], mine: [] };
    const player = kit.address();
    const mine = player ? (await entriesOf(game, c, player)).map((m) => ({ side: m.side, amount: String(m.amount) })) : [];
    const [pot] = await kit.rpc().accounts([lootPda.pot(lootPda.contest(game, c.id))]);
    return {
      open: x.verdict === 'Open' && now() < Number(x.closes_at), verdict: x.verdict, winner: x.winner, closesAt: Number(x.closes_at), resultBy: Number(x.result_by),
      sides: x.sides.map(String), pot: String(readTokenAccount(pot?.data)?.amount ?? 0n), mine,
    };
  }

  /** The player's own receipts in this game, newest first: [{ signature, name, data, at }] (the last `limit` transactions). */
  async function receipts({ limit = 20 } = {}) {
    const player = kit.address();
    if (kit.mock() || !player) return [];
    const { game } = await live();
    const sigs = await kit.rpc().call('getSignaturesForAddress', [player, { limit, commitment: 'confirmed' }]);
    const out = [];
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await kit.rpc().call('getTransaction', [s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      for (const ev of lootEvents(tx?.meta?.logMessages ?? [])) if (ev.data?.game === game) out.push({ signature: s.signature, name: ev.name, data: ev.data, at: s.blockTime ?? null });
    }
    return out;
  }

  /** Everything economyState needs, read in one go (see actions.js economyState for the shape). */
  async function reads() {
    const e = await spec();
    if (kit.mock()) return { now: now(), ...mockReads };
    const player = kit.address();
    const { game, gameAccount } = await live();
    const out = { now: now(), balances: {}, pools: {}, lotteries: {}, stakes: {}, contests: {}, holds: {} };
    for (const p of await pools()) out.pools[p.key] = p.units;
    if (player) {
      for (const t of e.tokens.values()) {
        const mint = t.mint ?? (t.key === e.currencyKey ? gameAccount.mint : null);
        if (!mint) continue;
        out.balances[t.key] = mint === NATIVE_MINT ? String(await kit.rpc().balance(player)) : String(await kit.rpc().tokenBalance(ata(player, mint, (await mintInfo(mint)).program)));
      }
    }
    for (const l of e.lotteries) out.lotteries[l.key] = await lottery(l.key).catch(() => undefined);
    for (const s of e.stakes) if (player) out.stakes[s.key] = await stakePosition(s.key).catch(() => undefined);
    for (const c of e.contests) out.contests[c.key] = await contest(c.key).catch(() => undefined);
    if (player && e.holds.length) {
      const holds = await holdsOf(game, player);
      const assets = await kit.rpc().accounts(holds.map((x) => x.asset));
      for (const h of e.holds) {
        const id = e.part('item', h.item)?.id;
        out.holds[h.key] = holds.filter((x, i) => assets[i] && collectiblesFrom([{ pubkey: x.asset, account: assets[i] }])[0]?.itemId === id).map((x) => ({ asset: x.asset, freeAt: x.freeAt }));
      }
    }
    return out;
  }

  /** What the page sends the game (economyState's shape). */
  async function state() {
    const config = await kit.ready();
    if (!config.economy) return null;
    return economyState(config.economy, await reads(), kit.address());
  }

  /** The buttons a game would show (playerActions). */
  async function actions() {
    const config = await kit.ready();
    return config.economy ? playerActions(config.economy) : [];
  }

  /**
   * Perform an action from its id (an entry of actions()), with the player's answers to its `asks`
   * ({ count }, { amount }); the defaults hold when they are left out.
   */
  async function act(id, answers = {}) {
    const { kind, key, verb, side } = parseActionId(id);
    const run = {
      'item:buy': () => buy(key, answers),
      'box:open': () => openBox(key, answers),
      'payment:pay': () => pay(key, answers),
      'recipe:craft': () => craft(key, answers),
      'lottery:tickets': () => buyTickets(key, answers),
      'stake:stake': () => stake(key, answers),
      'stake:unstake': () => unstake(key, answers),
      'contest:enter': () => enter(key, { ...answers, side }),
      'hold:hold': () => hold(key, answers),
    }[`${kind}:${verb}`];
    if (verb === 'claim') return claim(`${kind}:${key}`);
    if (!run) throw said(`${id} is not an economy action.`);
    return run();
  }

  return { buy, openBox, finish, pay, craft, buyTickets, stake, unstake, hold, enter, claim, act, actions, state, reads, pools, boxOdds, lottery, stakePosition, contest, receipts };
}

