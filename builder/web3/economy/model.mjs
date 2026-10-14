// The economy spec in the program's own terms: amounts in base units, percents in basis points, durations in
// seconds, every reference resolved and every part given its program id. The checker, the simulation, the cost
// and the compiler all read a spec through this. Pure.
import { PROGRAM_ID } from './idl.mjs';

// ---------------------------------------------------------------- the program's numbers
// Each from launchpad/loot (games.fun), program 0.3 as deployed on devnet on 2026-10-11 (source a02c20281).

/** The two flat fees, in lamports (constants.rs PLAYER_FEE_LAMPORTS, PROJECT_FEE_LAMPORTS; PROGRAM-0.3.md "The fee"). */
export const FEES = Object.freeze({ player: 2_000_000n, project: 10_000n });
/**
 * What MagicBlock's VRF oracle queue (Cuj97ggr…, ephemeral-vrf-sdk 0.17.2 consts.rs DEFAULT_QUEUE) takes for each
 * random number asked of it: VRF_LAMPORTS_COST = 500,000 lamports, 0.0005 SOL (magicblock-labs/ephemeral-vrf,
 * api/src/consts.rs; the high-priority queue's 800,000 is not the one loot uses). Paid by whoever asks: the player
 * on `open_box` (order.rs), whoever sends `draw_lottery` (lottery.rs, its `payer`), the authority on `roll`
 * (roll.rs). Measured on devnet on 2026-10-11: 500,000 lamports per open (economy check --devnet,
 * its `oracleFee`).
 */
export const ORACLE_FEE = 500_000n;
/** Put in an order's escrow on every purchase; what the collectible and the fee don't use goes back (constants.rs). */
export const ESCROW_LAMPORTS = 6_000_000n;
/** Rent: (bytes + 128) × 5,080 lamports. Read with `solana rent` on devnet and mainnet-beta on 2026-10-11. */
export const RENT_PER_BYTE = 5_080n;
export const ACCOUNT_OVERHEAD = 128n;
export const rent = (bytes) => (BigInt(bytes) + ACCOUNT_OVERHEAD) * RENT_PER_BYTE;
/** The network's base fee per signature. Priority fees are extra and up to the wallet. */
export const SIGNATURE_FEE = 5_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const WSOL = 'So11111111111111111111111111111111111111112';
export const PROGRAM = PROGRAM_ID;
/** The program's limits (constants.rs, craft.rs, lottery.rs). */
export const LIMITS = Object.freeze({ shares: 4, entries: 8, lines: 8, collectiblesPerCraft: 8, places: 8, nameBytes: 32, uriBytes: 200, keyBytes: 32 });
/** Attribute names the program writes itself, which a recipe cannot copy (craft.rs, asset.rs). */
export const RESERVED_ATTRIBUTES = Object.freeze(['made', 'used', 'used_at', 'item_id', 'rarity', 'serial']);
export const RARITIES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic']);

// ---------------------------------------------------------------- units

/** A refusal raised while reading a value; the checker turns it into a refusal with a code. */
export class SpecError extends Error {
  constructor(code, message, fix) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

/** A plain decimal string for an amount written as a number or text (no exponent). */
export function decimalText(amount) {
  if (typeof amount === 'string') return amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new SpecError('E-AMOUNT', `${amount} is not an amount.`, 'Write a number like 0.1, or text like "0.1".');
  const text = String(amount);
  if (!/e/i.test(text)) return text;
  return amount.toFixed(20).replace(/\.?0+$/, '');
}

/** "0.1" of a currency with 9 decimals → 100000000n. Refuses more decimals than the currency has. */
export function toUnits(amount, decimals) {
  const text = decimalText(amount ?? 0);
  if (!/^\d{1,20}(\.\d+)?$/.test(text)) throw new SpecError('E-AMOUNT', `${text} is not an amount.`, 'Write a number like 0.1, or text like "0.1".');
  const [whole, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals) throw new SpecError('E-AMOUNT', `${text} has more decimals than its currency (${decimals}).`, `Round it to ${decimals} decimals.`);
  const units = BigInt(whole + trimmed.padEnd(decimals, '0'));
  if (units >= 2n ** 64n) throw new SpecError('E-AMOUNT', `${text} is too large for the program.`, 'Use a smaller amount.');
  return units;
}

/** 100000000n with 9 decimals → "0.1". */
export function fromUnits(units, decimals) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** 2.5 (percent) → 250 basis points. Null when it is not a whole number of hundredths. */
export function toBps(percent) {
  const bps = Math.round(Number(percent ?? 0) * 100);
  return Math.abs(bps - Number(percent ?? 0) * 100) < 1e-6 && bps >= 0 && bps <= 10_000 ? bps : null;
}

const UNIT = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
/** "7d" → 604800. A number is seconds already. */
export function toSeconds(duration) {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === 'number') return duration;
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(duration);
  if (!m) throw new SpecError('E-TIME', `${duration} is not a duration.`, 'Write it like "45s", "30m", "6h", "7d" or "2w".');
  return Math.round(Number(m[1]) * UNIT[m[2]]);
}

/** "publish", "publish+7d" or a date → Unix seconds, counted from `now` (Unix seconds) for the first two. */
export function toTime(time, now) {
  if (!time || time === 'publish') return now;
  const m = /^publish\+(.+)$/.exec(time);
  if (m) return now + toSeconds(m[1]);
  const at = Date.parse(time);
  if (!Number.isFinite(at)) throw new SpecError('E-TIME', `${time} is not a time.`, 'Write "publish", "publish+7d" or a date like "2026-11-01T18:00:00Z".');
  return Math.floor(at / 1000);
}

export const rarityNumber = (rarity) => (typeof rarity === 'number' ? rarity : Math.max(0, RARITIES.indexOf(rarity ?? 'Common')));
export const utf8Bytes = (s) => new TextEncoder().encode(s ?? '').length;
export const isAddress = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// ---------------------------------------------------------------- the model

/** The spec's lists, in the order the program sees them, with the kind each part is. */
export const KINDS = Object.freeze({
  tokens: 'token',
  items: 'item',
  pools: 'pool',
  boxes: 'box',
  payments: 'payment',
  recipes: 'recipe',
  schedules: 'schedule',
  lotteries: 'lottery',
  stakes: 'stake',
  contests: 'contest',
  holds: 'hold',
  decisions: 'decision',
});

/** Gives every part without one the next free program id (pools from 0, the rest from 1). */
function assignIds(list, field, first) {
  const used = new Set(list.map((x) => x[field]).filter((v) => Number.isInteger(v)));
  let next = first;
  return list.map((x) => {
    if (Number.isInteger(x[field])) return x;
    while (used.has(next)) next += 1;
    used.add(next);
    return { ...x, [field]: next };
  });
}

/** What a token is on chain: its mint (or "@mint:<key>" until it exists), program, decimals, and who can mint it. */
function tokenOf(t) {
  if (t.source === 'sol') return { ...t, name: t.name ?? 'SOL', symbol: t.symbol ?? 'SOL', decimals: 9, program: 'spl-token', mint: WSOL, wsol: true, gameMints: false };
  const decimals = t.decimals ?? (t.source === 'curve' ? 6 : t.source === 'game' ? 0 : undefined);
  return {
    ...t,
    symbol: t.symbol ?? t.key.toUpperCase().slice(0, 10),
    name: t.name ?? t.symbol ?? t.key,
    decimals,
    program: t.program ?? 'spl-token',
    mint: t.mint ?? `@mint:${t.key}`,
    wsol: t.mint === WSOL,
    gameMints: t.source === 'game' || t.powers?.mintAuthority === 'game',
  };
}

/**
 * The spec with references resolved and ids given. Unknown references stay as they are (the checker reports
 * them); call `check` first when it matters.
 */
export function model(economy, { now = 0 } = {}) {
  const e = economy ?? {};
  const tokens = new Map((e.tokens ?? []).map((t) => [t.key, tokenOf(t)]));
  const currencyKey = e.currency ?? (tokens.size === 1 ? [...tokens.keys()][0] : undefined);
  const currency = tokens.get(currencyKey);
  const pools = assignIds(e.pools ?? [], 'index', 0);
  const m = {
    now,
    name: e.name ?? 'Game',
    authority: e.keys?.authority ?? 'owner',
    tokens,
    currencyKey,
    currency,
    collection: { name: e.collection?.name ?? (e.name ?? 'Game').slice(0, 32), royaltyPercent: e.collection?.royaltyPercent ?? 5, uri: e.collection?.uri ?? '', ...e.collection },
    items: assignIds(e.items ?? [], 'id', 1),
    pools,
    boxes: assignIds(e.boxes ?? [], 'id', 1),
    payments: e.payments ?? [],
    recipes: assignIds(e.recipes ?? [], 'id', 1),
    schedules: assignIds(e.schedules ?? [], 'id', 1),
    lotteries: assignIds(e.lotteries ?? [], 'id', 1),
    stakes: assignIds(e.stakes ?? [], 'id', 1),
    contests: assignIds(e.contests ?? [], 'id', 1),
    holds: e.holds ?? [],
    decisions: e.decisions ?? [],
    scenario: e.scenario ?? {},
    live: e.live ?? {},
  };
  const index = (list) => new Map(list.map((x) => [x.key, x]));
  m.item = index(m.items);
  m.pool = index(m.pools);
  m.box = index(m.boxes);
  m.recipe = index(m.recipes);
  m.stake = index(m.stakes);
  m.lottery = index(m.lotteries);
  m.contest = index(m.contests);
  m.hold = index(m.holds);
  /** The token a pool holds. */
  m.poolToken = (key) => tokens.get(m.pool.get(key)?.currency);
  /** The token a part is priced in (its own `currency`, else the game's). */
  m.priceToken = (part) => tokens.get(part?.currency ?? currencyKey);
  return m;
}

/** "pool:house" → { kind: 'pool', key: 'house' }; "burn" → { kind: 'burn' }. */
export function destination(to) {
  if (to === 'burn') return { kind: 'burn' };
  const [kind, ...rest] = String(to).split(':');
  return { kind, key: rest.join(':') };
}

/** The share with its basis points, or null bps when the percent is not whole hundredths. */
export const sharesOf = (split) => (split ?? []).map((s) => ({ ...destination(s.to), to: s.to, percent: s.percent, bps: toBps(s.percent) }));

/** The program's `To` enum for a destination, with pool indexes resolved. */
export function toEnum(to, m) {
  const d = destination(to);
  if (d.kind === 'burn') return { Burn: {} };
  if (d.kind === 'pool') return { Pool: m.pool.get(d.key)?.index ?? 0 };
  if (d.kind === 'account') return { Account: d.key };
  return { Holder: d.key };
}

/** A box's outcomes with their program weights: chances become whole weights (hundredths of a basis point). */
export function weights(box) {
  const outcomes = box.outcomes ?? [];
  if (outcomes.every((o) => Number.isInteger(o.weight))) return outcomes.map((o) => o.weight);
  const raw = outcomes.map((o) => Math.round((o.chance ?? 0) * 10_000));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = raw.reduce((a, b) => gcd(a, b), 0) || 1;
  return raw.map((w) => w / g);
}

/** Every place the spec names a pool as somewhere money leaves from, with what takes it. */
export function poolTakers(m) {
  const takers = [];
  const add = (pool, by, how) => pool && takers.push({ pool, by, how });
  for (const b of m.boxes) for (const o of b.outcomes ?? []) if (o.gives === 'pay' || o.gives === 'share') add(o.pool, `box:${b.key}`, o.gives === 'pay' ? 'pays prizes' : 'pays a share as a prize');
  for (const r of m.recipes)
    for (const o of r.out ?? []) {
      if (o.gives === 'tokens' && o.from?.startsWith('pool:')) add(o.from.slice(5), `recipe:${r.key}`, 'pays crafts');
      if (o.gives === 'share') add(o.pool, `recipe:${r.key}`, 'pays a share to crafts');
    }
  for (const s of m.schedules) {
    if (s.does === 'burn') add(s.pool, `schedule:${s.key}`, 'burns a share');
    if (s.does === 'move') add(s.from, `schedule:${s.key}`, 'moves a share out');
  }
  for (const l of m.lotteries) add(l.pot, `lottery:${l.key}`, 'pays the winners');
  for (const s of m.stakes) add(s.rewards, `stake:${s.key}`, 'takes everything into its rewards');
  for (const d of m.decisions) if (d.does === 'payout' || d.does === 'burn') add(d.pool, `decision:${d.key}`, d.does === 'payout' ? 'pays out on the authority’s word' : 'burns on the authority’s word');
  return takers;
}

/** Every place the spec sends money into a pool. */
export function poolFillers(m) {
  const fillers = [];
  const add = (pool, by, how) => pool && fillers.push({ pool, by, how });
  const fromSplit = (split, by) => sharesOf(split).forEach((s) => s.kind === 'pool' && add(s.key, by, `${s.percent}% of each payment`));
  for (const p of m.pools) if (p.seed !== undefined && Number(p.seed) > 0) add(p.key, `pool:${p.key}`, 'the creator’s seed');
  for (const i of m.items) fromSplit(i.split, `item:${i.key}`);
  for (const b of m.boxes) fromSplit(b.split, `box:${b.key}`);
  for (const p of m.payments) fromSplit(p.split, `payment:${p.key}`);
  for (const r of m.recipes) for (const i of r.in ?? []) if (i.takes === 'pay' && destination(i.to).kind === 'pool') add(destination(i.to).key, `recipe:${r.key}`, 'a craft pays in');
  for (const s of m.schedules) {
    if (s.does === 'issue') add(s.pool, `schedule:${s.key}`, 'mints into it');
    if (s.does === 'move') add(s.to, `schedule:${s.key}`, 'moves a share in');
  }
  for (const l of m.lotteries) if (!l.ticketCurrency) add(l.pot, `lottery:${l.key}`, 'ticket money');
  for (const c of m.contests) fromSplit(c.split, `contest:${c.key}`);
  return fillers;
}
