// What a player can do in a game's economy, as the list of buttons a game shows, and the state the page sends the
// game. Pure: no chain, no wallet, no Node import, so the game page, the studio and the agent tools all read the same
// list (builder/web3/economy/actions.mjs re-exports these two for the tools).
//
// An action is everything the page needs to perform it from its `id` alone with the economy spec: the page hands the
// id to gf-web3 (`gfWeb3.economy.act(id, answers)`), which reads the rest from the spec and the chain. An action that
// takes a number (a ticket count, an amount to stake) carries `asks`, with a default the page may use as is or ask
// the player to change.
import { destination, fromUnits, inWords, readEconomy, toSeconds, toUnits } from './spec.js';

/** Where a game shows an action: the main menu, the pause menu, the results screen, or a HUD button. */
export const PLACES = Object.freeze(['menu', 'pause', 'results', 'hud']);
const WHERE = { buy: 'menu', openBox: 'menu', pay: 'menu', craft: 'menu', buyTickets: 'menu', stake: 'menu', unstake: 'menu', hold: 'menu', enter: 'menu', claim: 'results' };

const money = (amount, token) => ({ amount: String(amount), currency: token?.symbol ?? '?' });
const words = (amount, token) => `${amount} ${token?.symbol ?? ''}`.trim();
const pct = (n) => `${Number(n)}%`;
const UNITS = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week' };
/** "7d" → "7 days"; seconds → "90 seconds". */
const span = (d) => {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(String(d ?? ''));
  if (!m) return `${toSeconds(d ?? 0)} seconds`;
  return `${m[1]} ${UNITS[m[2]]}${m[1] === '1' ? '' : 's'}`;
};
/** Where a recipe's payment goes, in words. */
const payTo = (to) => {
  const d = destination(to ?? '');
  if (d.kind === 'burn') return ' (burned)';
  if (d.kind === 'pool') return ` (into ${d.key})`;
  if (d.kind === 'holder') return ' (to the holder of a collectible)';
  if (d.kind === 'account') return ' (to a partner)';
  return '';
};

/** The chance of each outcome in percent, from `chance` or from `weight`. */
function chances(outcomes) {
  if (outcomes.every((o) => o.chance !== undefined)) return outcomes.map((o) => Number(o.chance));
  const total = outcomes.reduce((n, o) => n + (o.weight ?? 0), 0) || 1;
  return outcomes.map((o) => Math.round(((o.weight ?? 0) * 10_000) / total) / 100);
}

function outcomeWords(o, e, box) {
  if (o.gives === 'item') return e.part('item', o.item)?.name ?? o.item;
  if (o.gives === 'pay') return `win ${words(o.amount, e.poolToken(o.pool))}`;
  if (o.gives === 'share') return `win ${pct(o.percent)} of ${o.pool}`;
  if (o.gives === 'burn') return `your ${e.priceToken(box)?.symbol ?? 'payment'} is burned`;
  return 'nothing';
}

function lineIn(l, e) {
  if (l.takes === 'burn') return `${l.count ?? 1} ${e.part('item', l.item)?.name ?? l.item}`;
  if (l.takes === 'use') return `a ${e.part('item', l.item)?.name ?? l.item} (kept)`;
  if (l.takes === 'renew') return `a ${e.part('item', l.item)?.name ?? l.item} (kept, its uses start again)`;
  return `${words(l.amount, e.token(l.currency))}${payTo(l.to)}`;
}

function lineOut(l, e) {
  if (l.gives === 'item') return `1 ${e.part('item', l.item)?.name ?? l.item}`;
  if (l.gives === 'share') return `${pct(l.percent)} of ${l.pool}`;
  return words(l.amount, e.token(l.currency));
}

/** A recipe's price: what its pay lines cost, when they are all in one currency. */
function recipePrice(r, e) {
  const pays = (r.in ?? []).filter((l) => l.takes === 'pay');
  if (!pays.length) return undefined;
  const key = pays[0].currency ?? e.currencyKey;
  if (!pays.every((l) => (l.currency ?? e.currencyKey) === key)) return undefined;
  const t = e.token(key);
  const units = pays.reduce((n, l) => n + toUnits(l.amount, t.decimals), 0n);
  return money(fromUnits(units, t.decimals), t);
}

/** The default amount a contest entry offers: 0.01 SOL, or 1 of any other token. */
const entryDefault = (t) => (t?.wsol ? '0.01' : '1');

/**
 * The list of buttons a game would show: [{ id, part, kind, label, price?, says, where, asks? }].
 * - `kind`: buy | openBox | pay | craft | buyTickets | stake | unstake | hold | enter | claim
 * - `price`: { amount (whole units, text), currency (symbol) }, when the action has one fixed price; the kit shows it
 *   beside the label, so `says` never repeats it
 * - `where`: menu | pause | results | hud (the spec has no field for it: claim goes to results, the rest to menu)
 * - `asks`: { count | amount: { default, min?, says } }: a number the page may ask the player for; the default works
 */
export function playerActions(economy) {
  const e = readEconomy(economy);
  const out = [];
  const add = (a) => out.push({ where: WHERE[a.kind], ...a });

  for (const it of e.items) {
    if (!(Number(it.price ?? 0) > 0) || it.active === false) continue;
    const t = e.currency;
    const normal = it.kind === 'normal';
    const moves = it.rise ? ' The price rises with each sale.' : it.fall ? ' The price falls until someone buys.' : '';
    add({ id: `item:${it.key}:buy`, part: `item:${it.key}`, kind: 'buy', label: `Buy ${it.name}`, price: money(it.price, t), says: `${normal ? 'The game delivers it.' : 'It is yours, in your wallet.'}${moves}` });
  }
  for (const b of e.boxes) {
    if (b.active === false) continue;
    const t = e.priceToken(b);
    const odds = chances(b.outcomes ?? []);
    const table = (b.outcomes ?? []).map((o, i) => `${odds[i]}% ${outcomeWords(o, e, b)}`).join(', ');
    add({ id: `box:${b.key}:open`, part: `box:${b.key}`, kind: 'openBox', label: b.name, price: money(b.price, t), says: `${table}.${b.rise ? ' The price rises with each one.' : ''}` });
  }
  for (const p of e.payments) {
    const t = e.token(p.currency);
    add({ id: `payment:${p.key}:pay`, part: `payment:${p.key}`, kind: 'pay', label: p.name, price: money(p.amount, t), says: `Pays for ${p.name}.` });
  }
  for (const r of e.recipes) {
    if (r.active === false) continue;
    const gives = (r.out ?? []).map((l) => lineOut(l, e)).join(' and ') || 'nothing back';
    add({ id: `recipe:${r.key}:craft`, part: `recipe:${r.key}`, kind: 'craft', label: r.name, price: recipePrice(r, e), says: `Hand in ${(r.in ?? []).map((l) => lineIn(l, e)).join(', ')}; get ${gives}.` });
  }
  for (const l of e.lotteries) {
    const t = l.ticketCurrency ? e.token(l.ticketCurrency) : e.poolToken(l.pot);
    const places = (l.places ?? [100]).map(pct).join(' / ');
    add({
      id: `lottery:${l.key}:tickets`, part: `lottery:${l.key}`, kind: 'buyTickets', label: `Tickets: ${l.name}`, price: money(l.price, t),
      says: `Drawn every ${span(l.every)}; the pot is paid ${places}.${l.ticketCurrency ? ' Tickets are burned.' : ''}`,
      asks: { count: { default: 1, min: 1, says: 'How many tickets?' } },
    });
    add({ id: `lottery:${l.key}:claim`, part: `lottery:${l.key}`, kind: 'claim', label: `Draw and pay: ${l.name}`, says: 'Start the draw when it is due, then pay every winner. Free apart from network fees.' });
  }
  for (const s of e.stakes) {
    const staked = e.token(s.stakes);
    const rewards = e.poolToken(s.rewards);
    const lock = s.lock ? ` Locked for ${span(s.lock)} after each stake.` : '';
    add({ id: `stake:${s.key}:stake`, part: `stake:${s.key}`, kind: 'stake', label: `Stake ${staked?.symbol}`, says: `Lock ${staked?.symbol} in “${s.name}” and earn ${rewards?.symbol}.${lock}`, asks: { amount: { default: 'all', says: `How much ${staked?.symbol} to stake? (all: everything you hold)` } } });
    add({ id: `stake:${s.key}:unstake`, part: `stake:${s.key}`, kind: 'unstake', label: `Unstake ${staked?.symbol}`, says: `Take your ${staked?.symbol} out of “${s.name}”, with what it earned.`, asks: { amount: { default: 'all', says: `How much ${staked?.symbol} to take out? (all: your whole stake)` } } });
    add({ id: `stake:${s.key}:claim`, part: `stake:${s.key}`, kind: 'claim', label: `Collect ${rewards?.symbol}`, says: `Collect what “${s.name}” earned; your stake stays in.` });
  }
  for (const c of e.contests) {
    const t = e.token(c.currency);
    for (let side = 0; side < c.sides; side++) {
      const name = c.sideNames?.[side] ?? `Side ${side + 1}`;
      add({ id: `contest:${c.key}:enter:${side}`, part: `contest:${c.key}`, kind: 'enter', label: `Back ${name}`, says: `Put ${t?.symbol} on ${name} in “${c.name}”. If ${name} wins, the pot is shared by what each backer put in.`, asks: { amount: { default: entryDefault(t), min: 0, says: `How much ${t?.symbol} on ${name}?` } } });
    }
    add({ id: `contest:${c.key}:claim`, part: `contest:${c.key}`, kind: 'claim', label: `Collect: ${c.name}`, says: `Collect your winnings from “${c.name}”, or your money back if it was called off.` });
  }
  for (const h of e.holds) {
    const item = e.part('item', h.item);
    add({ id: `hold:${h.key}:hold`, part: `hold:${h.key}`, kind: 'hold', label: `${h.name}: send a ${item?.name ?? h.item}`, says: `Hand a ${item?.name ?? h.item} to the game for up to ${span(h.for ?? '0s')}. The game decides where it goes; if it does not, it comes back to you.` });
    add({ id: `hold:${h.key}:claim`, part: `hold:${h.key}`, kind: 'claim', label: `${h.name}: bring it home`, says: `Bring back a ${item?.name ?? h.item} whose time with the game is up.` });
  }
  return out;
}

/** "box:flip:open" → { kind: 'box', key: 'flip', verb: 'open', side? }. */
export function parseActionId(id) {
  const [kind, key, verb, side] = String(id ?? '').split(':');
  if (!kind || !key || !verb) throw new Error(`${id} is not an economy action.`);
  return { kind, key, verb, ...(side !== undefined ? { side: Number(side) } : {}) };
}

const big = (v) => BigInt(v ?? 0);

/**
 * The state the page sends the game, from what gf-web3's `economy.reads()` returned (pure, so a page can also build
 * it from its own reads). `reads`:
 *   { now, balances: { tokenKey: units }, pools: { poolKey: units },
 *     lotteries: { key: { price, pot, status: 'Open'|'Drawing'|'Drawn', drawsAt, sold, round, mine, places, winners, paid } },
 *     stakes: { key: { staked, pending, since, lock } },
 *     contests: { key: { open, verdict: 'Open'|'Won'|'Off', winner, closesAt, resultBy, sides: [units], mine: [{ side, amount }] } },
 *     holds: { key: [{ asset, freeAt }] } }
 * (units: base units, as a bigint or decimal text; times: Unix seconds).
 * Returns:
 *   { player, live, balances: { tokenKey: { amount, symbol } }, pools: { poolKey: { amount, symbol } },
 *     tickets: { key: { mine, sold, pot, status, drawsAt, nextDraw } },
 *     stakes: { key: { staked, pending, locked, unlocksAt } },
 *     contests: { key: { open, sides: [{ name, total }], mine: [{ side, name, amount }], verdict, winner } },
 *     holds: { key: [{ asset, freeAt, over }] },
 *     claimable: [{ id, part, says }] }
 * Amounts are text with their symbol ("0.1 SOL"); `claimable` lists the claim actions the player can take now.
 */
export function economyState(economy, reads = {}, player = null) {
  const e = readEconomy(economy);
  const now = reads.now ?? Math.floor(Date.now() / 1000);
  const state = { player, live: Boolean(e.game || e.collection), balances: {}, pools: {}, tickets: {}, stakes: {}, contests: {}, holds: {}, claimable: [] };
  const claim = (id, part, says) => state.claimable.push({ id, part, says });

  for (const [key, units] of Object.entries(reads.balances ?? {})) {
    const t = e.token(key);
    if (t) state.balances[key] = { amount: e.money(big(units), t), symbol: t.symbol };
  }
  for (const [key, units] of Object.entries(reads.pools ?? {})) {
    const t = e.poolToken(key);
    if (t) state.pools[key] = { amount: e.money(big(units), t), symbol: t.symbol };
  }
  for (const l of e.lotteries) {
    const r = reads.lotteries?.[l.key];
    if (!r) continue;
    const potToken = e.poolToken(l.pot);
    const status = String(r.status ?? 'Open').toLowerCase();
    const due = status === 'open' && now >= Number(r.drawsAt);
    state.tickets[l.key] = {
      mine: Number(r.mine ?? 0), sold: Number(r.sold ?? 0), pot: e.money(big(r.pot), potToken), status, drawsAt: Number(r.drawsAt),
      nextDraw: due ? 'due now' : status === 'open' ? inWords(Number(r.drawsAt) - now) : 'drawing',
    };
    const won = (r.winners ?? []).map((w, place) => ({ w, place })).filter(({ w, place }) => w === player && !(Number(r.paid ?? 0) & (1 << place)));
    if (won.length) claim(`lottery:${l.key}:claim`, `lottery:${l.key}`, `You won place ${won.map((x) => x.place + 1).join(' and ')} in “${l.name}”: collect it.`);
    else if (Number(r.mine ?? 0) > 0 && due && Number(r.sold ?? 0) > 0) claim(`lottery:${l.key}:claim`, `lottery:${l.key}`, `The draw of “${l.name}” is due: start it.`);
  }
  for (const s of e.stakes) {
    const r = reads.stakes?.[s.key];
    if (!r) continue;
    const staked = e.token(s.stakes);
    const rewards = e.poolToken(s.rewards);
    const unlocksAt = Number(r.since ?? 0) + Number(r.lock ?? toSeconds(s.lock));
    state.stakes[s.key] = { staked: e.money(big(r.staked), staked), pending: e.money(big(r.pending), rewards), locked: big(r.staked) > 0n && now < unlocksAt, unlocksAt };
    if (big(r.pending) > 0n) claim(`stake:${s.key}:claim`, `stake:${s.key}`, `Collect ${e.money(big(r.pending), rewards)} from “${s.name}”.`);
  }
  for (const c of e.contests) {
    const r = reads.contests?.[c.key];
    if (!r) continue;
    const t = e.token(c.currency);
    const name = (side) => c.sideNames?.[side] ?? `Side ${side + 1}`;
    const mine = (r.mine ?? []).map((m) => ({ side: m.side, name: name(m.side), amount: e.money(big(m.amount), t) }));
    state.contests[c.key] = {
      open: Boolean(r.open) && r.verdict === 'Open' && now < Number(r.closesAt), sides: (r.sides ?? []).map((total, side) => ({ name: name(side), total: e.money(big(total), t) })),
      mine, verdict: String(r.verdict ?? 'none').toLowerCase(), winner: r.verdict === 'Won' ? name(r.winner) : null,
    };
    const owed = (r.mine ?? []).filter((m) => r.verdict === 'Off' || (r.verdict === 'Won' && m.side === r.winner));
    if (owed.length) claim(`contest:${c.key}:claim`, `contest:${c.key}`, r.verdict === 'Off' ? `“${c.name}” was called off: take your money back.` : `${name(r.winner)} won “${c.name}”: collect your share.`);
  }
  for (const h of e.holds) {
    const list = reads.holds?.[h.key];
    if (!list) continue;
    state.holds[h.key] = list.map((x) => ({ asset: x.asset, freeAt: Number(x.freeAt), over: now >= Number(x.freeAt) }));
    if (state.holds[h.key].some((x) => x.over)) claim(`hold:${h.key}:claim`, `hold:${h.key}`, `A ${e.part('item', h.item)?.name ?? h.item} is back from ${h.name}: bring it home.`);
  }
  return state;
}
