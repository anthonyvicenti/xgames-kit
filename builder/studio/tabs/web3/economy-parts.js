// What the Economy tab knows about an economy spec (builder/web3/economy/README.md), with no DOM: the kinds of parts and
// their plain names, a new part of each kind with sensible numbers, removing one, which part a checker note is
// about, the money flow as a graph, and that graph laid out for a given width. Pure, so tests import it in Node.

/** The spec's lists, in the order the tab shows them. `day` is the scenario's name for "how many a day". */
export const SECTIONS = [
  { section: 'tokens', kind: 'token', one: 'token', many: 'Money', add: 'a token' },
  { section: 'pools', kind: 'pool', one: 'pool', many: 'Pools', add: 'a pool' },
  { section: 'items', kind: 'item', one: 'item', many: 'Items for sale', add: 'an item', day: 'item' },
  { section: 'boxes', kind: 'box', one: 'box', many: 'Boxes', add: 'a box (a paid roll)', day: 'box' },
  { section: 'payments', kind: 'payment', one: 'payment', many: 'Payments', add: 'a payment (an entry fee)', day: 'payment' },
  { section: 'recipes', kind: 'recipe', one: 'recipe', many: 'Recipes', add: 'a recipe (merge, salvage, claim)', day: 'recipe' },
  { section: 'lotteries', kind: 'lottery', one: 'lottery', many: 'Lotteries', add: 'a lottery', day: 'lottery' },
  { section: 'stakes', kind: 'stake', one: 'stake', many: 'Stakes', add: 'a stake', day: 'stake' },
  { section: 'contests', kind: 'contest', one: 'contest', many: 'Contests', add: 'a contest (bet on a side)', day: 'contest' },
  { section: 'holds', kind: 'hold', one: 'hold', many: 'Holds', add: 'a hold (send a collectible away)', day: 'hold' },
  { section: 'schedules', kind: 'schedule', one: 'timer', many: 'Timers', add: 'a timer (mint, burn or move)' },
  { section: 'decisions', kind: 'decision', one: 'rule', many: 'Rules only the game knows', add: 'a rule only the game knows' },
];
export const sectionOf = (section) => SECTIONS.find((s) => s.section === section);
export const partId = (section, key) => `${section}:${key}`;

const PROGRAM_ID = { items: 'id', boxes: 'id', recipes: 'id', schedules: 'id', lotteries: 'id', stakes: 'id', pools: 'index' };
/** True once the part has a program id: it is (or was) live, so its key stays and some fields are fixed. */
export const isLivePart = (section, part) => Number.isInteger(part?.[PROGRAM_ID[section]]);

// ---------------------------------------------------------------- numbers as the creator types them

/** "0.1" → 0.1; "0.10000000000000000001" stays text (exact); anything else stays as typed, for the checker to name. */
export function parseAmount(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return String(Number(s)) === s.replace(/^0+(?=\d)/, '') && Number.isFinite(Number(s)) ? Number(s) : s;
  return s;
}
export function parseNumber(text) {
  const s = String(text ?? '').trim().replace(',', '.').replace(/%$/, '');
  if (s === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}
export function parseWhole(text) {
  const s = String(text ?? '').trim();
  if (s === '') return undefined;
  return /^\d+$/.test(s) ? Number(s) : s;
}
/** "7d", "45s", or seconds. */
export function parseDuration(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === '') return undefined;
  return /^\d+$/.test(s) ? Number(s) : s;
}
/** "50, 30, 20" → [50, 30, 20]. */
export const parseNumberList = (text) => String(text ?? '').split(/[,;/\s]+/).filter(Boolean).map((x) => parseNumber(x));
export const parseWordList = (text) => String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** A short number for a picture: 0.176, 38.5, 1,000. */
export function fmt(n) {
  if (typeof n === 'string') return n;
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  const digits = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * An amount for people (a balance, a pool, a prize): at most four decimals, rounded half up, trailing zeros
 * dropped, thousands grouped, and never 0 for an amount that is not: "0.368812502" → "0.3688", "0.000001" →
 * "<0.0001", "1234.5" → "1,234.5". Takes a number or exact decimal text (no float error on text). The one
 * formatter for amounts the Economy tab and the host bridge (builder/studio/host-bridge.js) show; fmt() stays for the
 * spec's own numbers (a 0.00001 SOL fee is exact there).
 */
export function amountText(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? (Math.abs(value) < 1e21 ? value.toFixed(12) : String(value)) : '–') : String(value).trim();
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === '' && !m[3])) return text;
  const [, sign, whole = '', fraction = ''] = m;
  const kept = BigInt((whole || '0') + fraction.padEnd(4, '0').slice(0, 4)) + (fraction[4] >= '5' ? 1n : 0n);
  const nonZero = /[1-9]/.test(whole + fraction);
  const minus = sign === '-' && nonZero ? '-' : '';
  if (kept === 0n) return nonZero ? `${minus}<0.0001` : '0';
  const digits = kept.toString().padStart(5, '0');
  const int = digits.slice(0, -4).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits.slice(-4).replace(/0+$/, '');
  return `${minus}${int}${frac ? `.${frac}` : ''}`;
}

/** Every long decimal in a sentence for people ("Player won 0.368812502 SOL" → "Player won 0.3688 SOL"); shorter ones stay. */
export const roundAmounts = (text) => String(text ?? '').replace(/(?<![\w.])\d[\d,]*\.\d{5,}(?![\w.])/g, (n) => amountText(n.replace(/,/g, '')));

// ---------------------------------------------------------------- tokens and names

export function tokenOf(spec, key) {
  return (spec.tokens ?? []).find((t) => t.key === (key ?? spec.currency));
}
export function symbolOf(spec, key) {
  const t = tokenOf(spec, key);
  if (!t) return String(key ?? spec.currency ?? 'SOL').toUpperCase();
  if (t.source === 'sol') return 'SOL';
  return t.symbol ?? t.key.toUpperCase().slice(0, 10);
}
export const nameOf = (part) => part?.name ?? part?.key ?? '';

/** A key not yet used in `section`: "pot", "pot-2", … */
export function freeKey(spec, section, base) {
  const taken = new Set((spec[section] ?? []).map((p) => p.key));
  let clean = String(base ?? 'part').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  if (!/^[a-z]/.test(clean)) clean = `p-${clean}`.replace(/-$/, '');
  let key = clean;
  for (let n = 2; taken.has(key); n += 1) key = `${clean}-${n}`;
  return key;
}

/** "Bean Brawl" → BEAN; one short word → its letters; else initials (the Token tab's rule). */
export function tickerOf(title) {
  const words = String(title ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const first = (words[0] ?? '').slice(0, 8);
  return first.length >= 2 ? first : words.map((w) => w[0]).join('').slice(0, 8) || 'GAME';
}

// ---------------------------------------------------------------- adding and removing parts

const push = (spec, section, part) => {
  // a second "Weekly draw" is "Weekly draw 2", so the cards and the picture tell them apart
  const names = new Set((spec[section] ?? []).map((p) => p.name));
  if (part.name && names.has(part.name)) for (let n = 2; ; n += 1) if (!names.has(`${part.name} ${n}`)) { part.name = `${part.name} ${n}`; break; }
  spec[section] = [...(spec[section] ?? []), part];
  return { section, key: part.key };
};
const gameCurrency = (spec) => spec.currency ?? spec.tokens?.[0]?.key ?? 'sol';
/** Pools a stake or a lottery already owns (a stake takes all of its pool; a lottery's pot should be its own). */
const ownedPools = (spec) => new Set([...(spec.stakes ?? []).map((s) => s.rewards), ...(spec.lotteries ?? []).map((l) => l.pot)]);
function sharedPool(spec, base, seed) {
  const owned = ownedPools(spec);
  const free = (spec.pools ?? []).find((p) => !owned.has(p.key) && p.currency === gameCurrency(spec));
  if (free) return free.key;
  return push(spec, 'pools', { key: freeKey(spec, 'pools', base), currency: gameCurrency(spec), seed, about: 'Pays the prizes.' }).key;
}
const ownPool = (spec, base, about) => push(spec, 'pools', { key: freeKey(spec, 'pools', base), currency: gameCurrency(spec), seed: 0, about }).key;
function anyItem(spec, title) {
  if (spec.items?.length) return spec.items[0].key;
  return addPart(spec, 'item', { title }).key;
}

/**
 * Adds a part of `kind` with numbers that pass the checker on their own, plus whatever it needs (a lottery gets a pot
 * of its own, a box a prize pool, a recipe an item). opts: { title, variant } (a token's variant: curve | existing |
 * game). Returns { section, key } of the part asked for.
 */
export function addPart(spec, kind, { title = '', variant = 'curve' } = {}) {
  const cur = gameCurrency(spec);
  const sym = symbolOf(spec, cur);
  const small = sym === 'SOL' ? 1 : 100;   // prices that look sane in SOL and in a token
  switch (kind) {
    case 'token': {
      if (variant === 'existing') return push(spec, 'tokens', { key: freeKey(spec, 'tokens', 'coin'), source: 'existing' });
      if (variant === 'game') return push(spec, 'tokens', { key: freeKey(spec, 'tokens', 'points'), source: 'game', name: 'Points', symbol: 'PTS', decimals: 0 });
      const symbol = tickerOf(title);
      return push(spec, 'tokens', { key: freeKey(spec, 'tokens', symbol), source: 'curve', name: String(title || symbol).slice(0, 32), symbol, decimals: 6, venue: 'games.fun' });
    }
    case 'pool':
      return push(spec, 'pools', { key: freeKey(spec, 'pools', 'prizes'), currency: cur, seed: 0, about: '' });
    case 'item':
      if (!spec.collection) spec.collection = { name: String(spec.name || title || 'Collectibles').slice(0, 32) };
      return push(spec, 'items', { key: freeKey(spec, 'items', 'new-item'), name: 'New item', kind: 'collectible', rarity: 'Common', price: 0.05 * small });
    case 'box': {
      const pool = sharedPool(spec, 'prizes', 1 * small);
      return push(spec, 'boxes', {
        key: freeKey(spec, 'boxes', 'box'), name: 'Mystery box', price: 0.1 * small,
        split: [{ to: `pool:${pool}`, percent: 90 }],
        outcomes: [{ gives: 'pay', chance: 40, pool, amount: 0.2 * small }, { gives: 'nothing', chance: 60 }],
      });
    }
    case 'payment':
      return push(spec, 'payments', { key: freeKey(spec, 'payments', 'entry'), name: 'Entry fee', amount: 0.01 * small });
    case 'recipe': {
      const item = anyItem(spec, title);
      return push(spec, 'recipes', { key: freeKey(spec, 'recipes', 'merge'), name: 'Merge two into one', in: [{ takes: 'burn', item, count: 2 }], out: [{ gives: 'item', item }] });
    }
    case 'lottery': {
      const pot = ownPool(spec, 'pot', 'The lottery’s pot: every ticket goes in, the places share it.');
      return push(spec, 'lotteries', { key: freeKey(spec, 'lotteries', 'weekly'), name: 'Weekly draw', pot, price: 0.01 * small, places: [50, 30, 20], every: '7d', firstDraw: 'publish+7d' });
    }
    case 'stake': {
      const token = (spec.tokens ?? []).find((t) => t.source !== 'sol')?.key ?? cur;
      const rewards = ownPool(spec, 'stakers', 'What stakers share: a share of every sale lands here.');
      // something must fill it: 2% of the first sale with room for a share (one in the game's currency), else a seed
      const sale = [...(spec.boxes ?? []), ...(spec.payments ?? []), ...(spec.items ?? []).filter((i) => Number(i.price) > 0)].find((p) => {
        const used = (p.split ?? []).reduce((n, s) => n + (Number(s.percent) || 0), 0);
        return (p.currency ?? cur) === cur && (p.split ?? []).length < 4 && used <= 98;
      });
      if (sale) sale.split = [...(sale.split ?? []), { to: `pool:${rewards}`, percent: 2 }];
      else spec.pools.find((p) => p.key === rewards).seed = 1 * small;
      return push(spec, 'stakes', { key: freeKey(spec, 'stakes', 'stake'), name: 'Stake and earn', stakes: token, rewards, lock: '1d' });
    }
    case 'contest':
      return push(spec, 'contests', { key: freeKey(spec, 'contests', 'duel'), name: 'Duel', currency: cur, sides: 2, sideNames: ['Red', 'Blue'], entriesClose: '10m', resultDue: '1h', every: '1h', split: [], decidedBy: 'The game says which side won.' });
    case 'hold': {
      const item = anyItem(spec, title);
      return push(spec, 'holds', { key: freeKey(spec, 'holds', 'quest'), name: 'Send on a quest', item, for: '1d', decidedBy: 'The game says where it goes when the quest ends.' });
    }
    case 'schedule': {
      const pools = (spec.pools ?? []).filter((p) => p.currency === cur);
      const from = pools[0]?.key ?? push(spec, 'pools', { key: freeKey(spec, 'pools', 'reserve'), currency: cur, seed: 1 * small, about: 'Fills the prizes a little every day.' }).key;
      const to = pools.find((p) => p.key !== from)?.key ?? push(spec, 'pools', { key: freeKey(spec, 'pools', 'prizes'), currency: cur, seed: 0, about: '' }).key;
      return push(spec, 'schedules', { key: freeKey(spec, 'schedules', 'drip'), name: 'Daily drip', does: 'move', from, to, percent: 5, every: '1d', start: 'publish' });
    }
    case 'decision': {
      const pool = sharedPool(spec, 'prizes', 1 * small);
      return push(spec, 'decisions', { key: freeKey(spec, 'decisions', 'reward'), when: 'A player clears the last level', does: 'payout', pool, amount: 0.1 * small, perDay: 5 });
    }
    default:
      throw new Error(`No part of kind ${kind}.`);
  }
}

/** Removes a part and its line in the scenario. Other parts that named it get checker notes, each with its fix. */
export function removePart(spec, section, key) {
  spec[section] = (spec[section] ?? []).filter((p) => p.key !== key);
  if (!spec[section].length) delete spec[section];
  const day = sectionOf(section)?.day;
  if (day && spec.scenario?.perDay) delete spec.scenario.perDay[`${day}:${key}`];
  if (section === 'tokens' && spec.currency === key) spec.currency = spec.tokens?.[0]?.key;
}

// ---------------------------------------------------------------- checker notes → the part they are about

/** "economy.boxes.flip.price" or "economy.boxes[0].price" → { section, key, field }. Null for the whole economy. */
export function partOfWhere(spec, where) {
  const m = /^economy\.([a-z]+)(?:\[(\d+)\]|\.([a-z][a-z0-9-]*))?(?:\.(.*))?$/.exec(String(where ?? ''));
  if (!m || !sectionOf(m[1])) return null;
  const list = spec[m[1]] ?? [];
  const part = m[2] !== undefined ? list[Number(m[2])] : list.find((p) => p.key === m[3]);
  if (!part) return null;
  return { section: m[1], key: part.key, field: m[4] ?? '' };
}

/** { byPart: Map(partId → [note]), general: [note] }; a note is { level: 'refusal' | 'warning', code, message, fix, field }. */
export function notesByPart(spec, verdict) {
  const byPart = new Map();
  const general = [];
  const add = (level) => (n) => {
    const at = partOfWhere(spec, n.where);
    const note = { level, code: n.code, message: n.message, fix: n.fix, field: at?.field ?? '', where: n.where };
    if (!at) general.push(note);
    else {
      const id = partId(at.section, at.key);
      byPart.set(id, [...(byPart.get(id) ?? []), note]);
    }
  };
  (verdict?.refusals ?? []).forEach(add('refusal'));
  (verdict?.warnings ?? []).forEach(add('warning'));
  return { byPart, general };
}

// ---------------------------------------------------------------- the money flow as a graph

const LAYER_CAPTIONS = ['Players', 'Pay into', 'Pools hold', 'Paid out to'];
export { LAYER_CAPTIONS };

/**
 * Nodes: { id, layer: 0..3, kind, label, sub, part: { section, key } | null }. Edges: { from, to, label, kind:
 * 'pay' | 'payout' | 'burn' | 'treasury' | 'lock' | 'item' | 'move' }. Layer 0 is the players, 1 what they pay into,
 * 2 the pools, 3 where money ends up.
 */
export function flowGraph(spec) {
  const nodes = new Map();
  const edges = [];
  const node = (id, layer, kind, label, sub = '', part = null) => {
    if (!nodes.has(id)) nodes.set(id, { id, layer, kind, label, sub, part });
    return id;
  };
  const edge = (from, to, label, kind) => {
    const same = edges.find((e) => e.from === from && e.to === to && e.kind === kind);
    if (same) {
      if (label && !same.label.split(' · ').includes(label)) same.label = `${same.label} · ${label}`;
    } else edges.push({ from, to, label: label ?? '', kind });
  };
  const sym = (key) => symbolOf(spec, key);
  const pools = new Set((spec.pools ?? []).map((p) => p.key));
  const sinks = {
    winners: () => node('winners', 3, 'winners', 'Winners', 'paid from the pools'),
    treasury: () => node('treasury', 3, 'treasury', 'Your treasury', 'what the shares leave'),
    burn: () => node('burn', 3, 'burn', 'Burned', 'gone for good'),
    accounts: () => node('accounts', 3, 'account', 'Partner accounts', 'a share to a wallet'),
    holders: () => node('holders', 3, 'account', 'Collectible holders', 'whoever holds it'),
    collectibles: () => node('collectibles', 3, 'item', 'Collectibles', 'minted to the player'),
  };
  /** Where a share goes, as a node id. */
  const dest = (to) => {
    const s = String(to ?? '');
    if (s === 'burn') return sinks.burn();
    if (s.startsWith('pool:')) return pools.has(s.slice(5)) ? partId('pools', s.slice(5)) : null;
    if (s.startsWith('account:')) return sinks.accounts();
    if (s.startsWith('holder:')) return sinks.holders();
    return null;
  };
  const players = node('players', 0, 'players', 'Players', 'pay, play and win');
  for (const p of spec.pools ?? []) node(partId('pools', p.key), 2, 'pool', nameOf(p), p.seed ? `seed ${fmt(Number(p.seed))} ${sym(p.currency)}` : sym(p.currency), { section: 'pools', key: p.key });

  /** Paid in: the shares, and what they leave to the treasury. */
  const paidIn = (from, split, { all = false } = {}) => {
    let left = 100;
    for (const s of split ?? []) {
      const to = dest(s.to);
      const pct = Number(s.percent) || 0;
      left -= pct;
      if (to) edge(from, to, `${fmt(pct)}%`, s.to === 'burn' ? 'burn' : 'pay');
    }
    if (left > 0.0001 && !all) edge(from, sinks.treasury(), `${fmt(left)}%`, 'treasury');
  };

  for (const it of spec.items ?? []) {
    if (!(Number(it.price) > 0)) continue;
    const id = node(partId('items', it.key), 1, 'item', nameOf(it), `${fmt(Number(it.price))} ${sym(spec.currency)}`, { section: 'items', key: it.key });
    edge(players, id, `${fmt(Number(it.price))}`, 'pay');
    paidIn(id, it.split);
    edge(id, sinks.collectibles(), 'the item', 'item');
  }
  for (const b of spec.boxes ?? []) {
    const id = node(partId('boxes', b.key), 1, 'box', nameOf(b), `${fmt(Number(b.price))} ${sym(b.currency)} a roll`, { section: 'boxes', key: b.key });
    edge(players, id, `${fmt(Number(b.price))}`, 'pay');
    paidIn(id, b.split);
    const total = (b.outcomes ?? []).reduce((n, o) => n + (Number(o.chance ?? o.weight) || 0), 0) || 1;
    for (const o of b.outcomes ?? []) {
      const odds = `${fmt(((Number(o.chance ?? o.weight) || 0) / total) * 100)}%`;
      if ((o.gives === 'pay' || o.gives === 'share') && pools.has(o.pool)) edge(partId('pools', o.pool), sinks.winners(), o.gives === 'pay' ? `${odds}: ${fmt(Number(o.amount))}` : `${odds}: ${fmt(Number(o.percent))}% of it`, 'payout');
      else if (o.gives === 'item') edge(id, sinks.collectibles(), odds, 'item');
      else if (o.gives === 'burn') edge(id, sinks.burn(), odds, 'burn');
    }
  }
  for (const p of spec.payments ?? []) {
    const id = node(partId('payments', p.key), 1, 'payment', nameOf(p), `${fmt(Number(p.amount))} ${sym(p.currency)}`, { section: 'payments', key: p.key });
    edge(players, id, `${fmt(Number(p.amount))}`, 'pay');
    paidIn(id, p.split);
  }
  for (const r of spec.recipes ?? []) {
    const id = node(partId('recipes', r.key), 1, 'recipe', nameOf(r), `${(r.in ?? []).length} in, ${(r.out ?? []).length} out`, { section: 'recipes', key: r.key });
    edge(players, id, (r.in ?? []).some((l) => l.takes === 'pay') ? 'pays' : 'hands in', (r.in ?? []).some((l) => l.takes === 'pay') ? 'pay' : 'lock');
    for (const l of r.in ?? []) {
      if (l.takes === 'pay') {
        const to = dest(l.to) ?? sinks.treasury();
        edge(id, to, `${fmt(Number(l.amount))} ${sym(l.currency)}`, l.to === 'burn' ? 'burn' : to === 'treasury' ? 'treasury' : 'pay');
      } else if (l.takes === 'burn') edge(id, sinks.burn(), `${l.count ?? 1} ${l.item}`, 'burn');
    }
    for (const o of r.out ?? []) {
      if (o.gives === 'item') edge(id, sinks.collectibles(), o.item, 'item');
      else if (o.gives === 'share' && pools.has(o.pool)) edge(partId('pools', o.pool), sinks.winners(), `${fmt(Number(o.percent))}% of it`, 'payout');
      else if (o.gives === 'tokens' && String(o.from).startsWith('pool:') && pools.has(o.from.slice(5))) edge(partId('pools', o.from.slice(5)), sinks.winners(), `${fmt(Number(o.amount))} ${sym(o.currency)}`, 'payout');
      else if (o.gives === 'tokens') edge(id, sinks.winners(), `${fmt(Number(o.amount))} ${sym(o.currency)} minted`, 'payout');
    }
  }
  for (const l of spec.lotteries ?? []) {
    const potSym = sym((spec.pools ?? []).find((p) => p.key === l.pot)?.currency);
    const id = node(partId('lotteries', l.key), 1, 'lottery', nameOf(l), `${fmt(Number(l.price))} ${l.ticketCurrency ? sym(l.ticketCurrency) : potSym} a ticket`, { section: 'lotteries', key: l.key });
    edge(players, id, 'tickets', 'pay');
    if (l.ticketCurrency) edge(id, sinks.burn(), 'tickets burned', 'burn');
    else {
      const cut = Number(l.cutPercent) || 0;
      if (pools.has(l.pot)) edge(id, partId('pools', l.pot), `${fmt(100 - cut)}%`, 'pay');
      if (cut > 0) edge(id, sinks.treasury(), `${fmt(cut)}%`, 'treasury');
    }
    const places = (l.places?.length ? l.places : [100]).map((x) => fmt(Number(x))).join('/');
    const n = (l.places ?? [100]).length;
    const win = node(`places:${l.key}`, 3, 'places', n === 1 ? 'Draw winner' : `${n} draw winners`, `${nameOf(l)}, every ${l.every}`, { section: 'lotteries', key: l.key });
    if (pools.has(l.pot)) edge(partId('pools', l.pot), win, `${places}%`, 'payout');
  }
  for (const s of spec.stakes ?? []) {
    const id = node(partId('stakes', s.key), 1, 'stake', nameOf(s), `locks ${sym(s.stakes)}`, { section: 'stakes', key: s.key });
    edge(players, id, `lock ${sym(s.stakes)}`, 'lock');
    const win = node(`stakers:${s.key}`, 3, 'stakers', 'Stakers', `of ${nameOf(s)}`, { section: 'stakes', key: s.key });
    if (pools.has(s.rewards)) edge(partId('pools', s.rewards), win, 'all of it', 'payout');
  }
  for (const c of spec.contests ?? []) {
    const id = node(partId('contests', c.key), 1, 'contest', nameOf(c), `${c.sides} sides`, { section: 'contests', key: c.key });
    edge(players, id, 'back a side', 'pay');
    paidIn(id, c.split, { all: true });
    const rake = (c.split ?? []).reduce((n, s) => n + (Number(s.percent) || 0), 0);
    edge(id, node(`contest-win:${c.key}`, 3, 'winners', `${nameOf(c)} winners`, 'the winning side', { section: 'contests', key: c.key }), `${fmt(100 - rake)}%`, 'payout');
  }
  for (const hd of spec.holds ?? []) {
    const id = node(partId('holds', hd.key), 1, 'hold', nameOf(hd), `hands in ${hd.item}`, { section: 'holds', key: hd.key });
    edge(players, id, 'a collectible', 'lock');
  }
  for (const sc of spec.schedules ?? []) {
    const every = `every ${sc.every}`;
    if (sc.does === 'issue' && pools.has(sc.pool)) {
      const id = node(partId('schedules', sc.key), 1, 'schedule', nameOf(sc), `mints ${every}`, { section: 'schedules', key: sc.key });
      edge(id, partId('pools', sc.pool), `${fmt(Number(sc.amount))} ${sym(sc.currency)}`, 'pay');
    } else if (sc.does === 'burn' && pools.has(sc.pool)) edge(partId('pools', sc.pool), sinks.burn(), `${fmt(Number(sc.percent))}% ${every}`, 'burn');
    else if (sc.does === 'move' && pools.has(sc.from) && pools.has(sc.to)) edge(partId('pools', sc.from), partId('pools', sc.to), `${fmt(Number(sc.percent))}% ${every}`, 'move');
  }
  for (const d of spec.decisions ?? []) {
    if (!pools.has(d.pool)) continue;
    if (d.does === 'payout') edge(partId('pools', d.pool), sinks.winners(), d.percent !== undefined ? `${fmt(Number(d.percent))}% by rule` : `${fmt(Number(d.amount))} by rule`, 'payout');
    if (d.does === 'burn') edge(partId('pools', d.pool), sinks.burn(), 'by rule', 'burn');
  }
  return { nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------- the graph laid out

const PAD = 8;
const GAP_X = 10;
const ROW_GAP = 10;
const NODE_H = 44;
const CAPTION_H = 18;
const LAYER_GAP = 44;
const labelWidth = (text) => Math.ceil(String(text).length * 6.1) + 12;

/** A cubic Bézier's point at t. */
const bezier = (p0, p1, p2, p3, t) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;

/**
 * Positions for `flowGraph(spec)` in a picture `width` wide: layers top to bottom, each wrapping into rows, nodes
 * ordered to keep lines short. → { width, height, captions: [{ text, y }], nodes: [{ ...node, x, y, w, h }],
 * edges: [{ ...edge, d, lx, ly, lw }] }. Labels that do not fit side by side stack, and their gap grows to hold them.
 */
export function layoutFlow(graph, width) {
  let gaps = [LAYER_GAP, LAYER_GAP, LAYER_GAP, LAYER_GAP];
  for (let round = 0; round < 3; round += 1) {
    const out = place(graph, width, gaps);
    if (out.needs.every((n, i) => n <= gaps[i])) return out.layout;
    gaps = gaps.map((g, i) => Math.max(g, out.needs[i]));
  }
  return place(graph, width, gaps).layout;
}

const LABEL_ROW = 20;

function place(graph, width, gaps) {
  const W = Math.max(280, Math.floor(width));
  const minW = W < 480 ? 92 : 150;
  const placed = new Map();
  const captions = [];
  const layerBottom = [];
  const sourcesOf = (id) => graph.edges.filter((e) => e.to === id).map((e) => placed.get(e.from)).filter(Boolean);
  let y = PAD;
  let lastGap = 0;
  for (let layer = 0; layer < 4; layer += 1) {
    let list = graph.nodes.filter((n) => n.layer === layer);
    if (!list.length) {
      layerBottom[layer] = y - lastGap;
      continue;
    }
    if (layer >= 2) {
      // under the middle of what feeds them; ones nothing feeds keep their order at the end
      const centre = (n) => {
        const s = sourcesOf(n.id);
        return s.length ? s.reduce((a, p) => a + p.x + p.w / 2, 0) / s.length : Infinity;
      };
      list = list.map((n, i) => ({ n, c: centre(n), i })).sort((a, b) => a.c - b.c || a.i - b.i).map((x) => x.n);
    }
    captions.push({ text: LAYER_CAPTIONS[layer], y: y + 12 });
    y += CAPTION_H;
    const perRow = layer === 0 ? 1 : Math.max(1, Math.min(list.length, Math.floor((W - 2 * PAD + GAP_X) / (minW + GAP_X))));
    const w = layer === 0 ? Math.min(W - 2 * PAD, 240) : Math.min(200, Math.floor((W - 2 * PAD - (perRow - 1) * GAP_X) / perRow));
    for (let i = 0; i < list.length; i += perRow) {
      const row = list.slice(i, i + perRow);
      const rowW = row.length * w + (row.length - 1) * GAP_X;
      let x = Math.round((W - rowW) / 2);
      for (const n of row) {
        placed.set(n.id, { ...n, x, y, w, h: NODE_H });
        x += w + GAP_X;
      }
      y += NODE_H + ROW_GAP;
    }
    y -= ROW_GAP;
    layerBottom[layer] = y;
    lastGap = gaps[layer];
    y += lastGap;
  }
  let height = y - lastGap + PAD + 20;

  // ports: each node's lines leave and arrive spread across its edge, in the order of the other end
  const outs = new Map();
  const ins = new Map();
  for (const e of graph.edges) {
    if (!placed.has(e.from) || !placed.has(e.to)) continue;
    outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
    ins.set(e.to, [...(ins.get(e.to) ?? []), e]);
  }
  const port = (map, id, e, other) => {
    const list = (map.get(id) ?? []).slice().sort((a, b) => {
      const pa = placed.get(a[other]);
      const pb = placed.get(b[other]);
      return pa.x + pa.w / 2 - (pb.x + pb.w / 2);
    });
    const n = placed.get(id);
    return n.x + (n.w * (list.indexOf(e) + 1)) / (list.length + 1);
  };
  const edges = [];
  for (const e of graph.edges) {
    const s = placed.get(e.from);
    const t = placed.get(e.to);
    if (!s || !t) continue;
    const sx = port(outs, e.from, e, 'to');
    const tx = port(ins, e.to, e, 'from');
    let d;
    let lx;
    let ly;
    let band;
    if (t.layer === s.layer) {
      // a move between pools: a loop under the row
      const sy = s.y + s.h;
      const ty = t.y + t.h;
      const dip = Math.max(sy, ty) + 30;
      d = `M${sx},${sy} C${sx},${dip} ${tx},${dip} ${tx},${ty}`;
      lx = (sx + tx) / 2;
      ly = dip - 6;
      band = `loop:${Math.round(ly)}`;
    } else {
      const sy = s.y + s.h;
      const ty = t.y;
      const dy = Math.max(22, (ty - sy) / 2);
      d = `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
      // the label sits in the gap under the source's layer, where nothing else is drawn
      const want = layerBottom[s.layer] + gaps[s.layer] / 2;
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 24; k += 1) {
        const mid = (lo + hi) / 2;
        if (bezier(sy, sy + dy, ty - dy, ty, mid) < want) lo = mid;
        else hi = mid;
      }
      lx = bezier(sx, sx, tx, tx, lo);
      ly = want;
      band = s.layer;
    }
    edges.push({ ...e, d, lx, ly, lw: e.label ? labelWidth(e.label) : 0, band });
  }
  // labels in one band never overlap: each takes the first row where it fits, as near its line as it can
  const needs = gaps.slice();
  const bands = new Map();
  for (const e of edges.filter((x) => x.label)) bands.set(e.band, [...(bands.get(e.band) ?? []), e]);
  for (const [band, list] of bands) {
    list.sort((a, b) => a.lx - b.lx);
    const rows = [];
    for (const e of list) {
      const x = Math.min(Math.max(e.lx, PAD + e.lw / 2), W - PAD - e.lw / 2);
      let r = rows.findIndex((right) => x - e.lw / 2 >= right + 4 || right + 4 + e.lw <= W - PAD);
      if (r < 0) r = rows.push(-Infinity) - 1;
      e.lx = Math.max(x, rows[r] + 4 + e.lw / 2);
      rows[r] = e.lx + e.lw / 2;
      e.row = r;
    }
    for (const e of list) e.ly += (e.row - (rows.length - 1) / 2) * LABEL_ROW;
    if (typeof band === 'number') needs[band] = Math.max(gaps[band], rows.length * LABEL_ROW + 24);
    else height = Math.max(height, list[0].ly + (rows.length - 1) * LABEL_ROW + 16);
  }
  for (const e of edges) {
    delete e.band;
    delete e.row;
  }
  return { needs, layout: { width: W, height, captions, nodes: [...placed.values()], edges } };
}
