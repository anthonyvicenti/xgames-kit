// The economy section of a game's gamesfun.json, read the way the in-game kit needs it: each part by its key, with
// the program id it has on chain, its token, and amounts in base units. Plain ES module with no Node import, so it
// runs in the game page (gf-web3 is copied whole into a game at gf/web3/, without the rest of builder/web3/economy).
//
// The ids are given exactly as builder/web3/economy/model.mjs gives them (the setup plan uses that): a part that has an
// `id` (`index` for a pool) keeps it; the others get the next free one in list order, pools from 0, the rest from 1.
// Contests and holds have no id field in the spec; contests are numbered the same way, holds need none.
//
// Live addresses come from `economy.live` ({ game, collection, treasury, authority }) and each token's `mint`,
// written when the economy goes live. An economy put live on an earlier deploy of the program reads as not live.
import { onThisProgram } from '../chain/loot.js';

export const WSOL = 'So11111111111111111111111111111111111111112';

const UNIT = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** "7d" → 604800; a number is seconds already. */
export function toSeconds(duration) {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === 'number') return duration;
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(duration);
  if (!m) throw new Error(`${duration} is not a duration.`);
  return Math.round(Number(m[1]) * UNIT[m[2]]);
}

/** A plain decimal text for an amount written as a number or text. */
function decimalText(amount) {
  if (typeof amount === 'string') return amount.trim();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error(`${amount} is not an amount.`);
  const text = String(amount);
  return /e/i.test(text) ? amount.toFixed(20).replace(/\.?0+$/, '') : text;
}

/** 0.1 of a token with 9 decimals → 100000000n. */
export function toUnits(amount, decimals) {
  const text = decimalText(amount ?? 0);
  if (!/^\d{1,20}(\.\d+)?$/.test(text)) throw new Error(`${text} is not an amount.`);
  const [whole, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals) throw new Error(`${text} has more decimals than its token (${decimals}).`);
  return BigInt(whole + trimmed.padEnd(decimals, '0'));
}

/** 100000000n with 9 decimals → "0.1". */
export function fromUnits(units, decimals) {
  const value = BigInt(units);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Gives every part without one the next free id (the same rule as model.mjs). */
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

function tokenOf(t) {
  if (t.source === 'sol') return { ...t, symbol: t.symbol ?? 'SOL', name: t.name ?? 'SOL', decimals: 9, program: 'spl-token', mint: WSOL, wsol: true };
  const decimals = t.decimals ?? (t.source === 'curve' ? 6 : t.source === 'game' ? 0 : 9);
  const mint = typeof t.mint === 'string' && !t.mint.startsWith('@') ? t.mint : null;
  return { ...t, symbol: t.symbol ?? t.key.toUpperCase().slice(0, 10), name: t.name ?? t.symbol ?? t.key, decimals, program: t.program ?? 'spl-token', mint, wsol: mint === WSOL };
}

/** "pool:house" → { kind: 'pool', key: 'house' }; "burn" → { kind: 'burn' }. */
export function destination(to) {
  if (to === 'burn') return { kind: 'burn' };
  const [kind, ...rest] = String(to).split(':');
  return { kind, key: rest.join(':') };
}

/**
 * The economy section, read: { name, live, game, collection, currency, tokens, items, pools, boxes, payments,
 * recipes, lotteries, stakes, contests, holds, part(kind, key), token(key), priceToken(part), money(units, token) }.
 * Throws a plain error when there is no economy.
 */
export function readEconomy(economy) {
  if (!economy || typeof economy !== 'object') throw new Error('This game has no economy yet.');
  const tokens = new Map((economy.tokens ?? []).map((t) => [t.key, tokenOf(t)]));
  const currencyKey = economy.currency ?? (tokens.size === 1 ? [...tokens.keys()][0] : undefined);
  const live = onThisProgram(economy.live) ? economy.live : {};
  const e = {
    name: economy.name ?? 'Game',
    live,
    collection: live.collection ?? null,
    game: live.game ?? null,
    treasury: live.treasury ?? null,
    currencyKey,
    tokens,
    items: assignIds(economy.items ?? [], 'id', 1),
    pools: assignIds(economy.pools ?? [], 'index', 0),
    boxes: assignIds(economy.boxes ?? [], 'id', 1),
    payments: economy.payments ?? [],
    recipes: assignIds(economy.recipes ?? [], 'id', 1),
    schedules: assignIds(economy.schedules ?? [], 'id', 1),
    lotteries: assignIds(economy.lotteries ?? [], 'id', 1),
    stakes: assignIds(economy.stakes ?? [], 'id', 1),
    contests: assignIds(economy.contests ?? [], 'id', 1),
    holds: economy.holds ?? [],
  };
  const lists = { item: e.items, pool: e.pools, box: e.boxes, payment: e.payments, recipe: e.recipes, schedule: e.schedules, lottery: e.lotteries, stake: e.stakes, contest: e.contests, hold: e.holds };
  e.part = (kind, key) => lists[kind]?.find((p) => p.key === key) ?? null;
  e.token = (key) => tokens.get(key ?? currencyKey) ?? null;
  e.currency = e.token(currencyKey);
  e.priceToken = (part) => e.token(part?.currency ?? currencyKey);
  e.poolToken = (key) => e.token(e.part('pool', key)?.currency);
  e.itemById = (id) => e.items.find((i) => i.id === id) ?? null;
  e.poolByIndex = (index) => e.pools.find((p) => p.index === index) ?? null;
  /** "0.1 SOL" for an amount in base units of `token`. */
  e.money = (units, token) => `${fromUnits(units, token?.decimals ?? 0)} ${token?.symbol ?? ''}`.trim();
  return e;
}

/** "in 2 days", "in 3 hours", "in 40 minutes", "now" for a number of seconds ahead. */
export function inWords(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s <= 0 ? 'now' : `in ${s} second${s === 1 ? '' : 's'}`;
  const [n, unit] = s >= 172_800 ? [Math.round(s / 86_400), 'day'] : s >= 7_200 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 60), 'minute'];
  return `in ${n} ${unit}${n === 1 ? '' : 's'}`;
}
