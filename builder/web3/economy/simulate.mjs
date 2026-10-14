// The quick simulation: expected values from the spec alone, instant. What each box, ticket and craft is worth
// against its price, the house edge, each pool's money in and out per day and how long it lasts, and who pays what:
// players, the creator, games.fun's fees. Amounts are in whole units of their token. Pure.
//
// It assumes the scenario's counts (`scenario.perDay`, default 100 of each player action a day) arrive evenly,
// odds as written (stock odds start where the table starts), and one ticket per lottery purchase. Shares of a
// pool are worked out continuously, so a pool that pays a share of itself settles at a level instead of emptying.
// It is a guide, not a promise: the full simulation (LiteSVM, later) runs the real program.
import { ESCROW_LAMPORTS, FEES, LAMPORTS_PER_SOL, ORACLE_FEE, RENT_PER_BYTE, SIGNATURE_FEE, destination, model, sharesOf, toBps, toSeconds, toTime, weights } from './model.mjs';

const DAY = 86_400;
const DEFAULT_PER_DAY = 100;
const sol = (lamports) => Number(lamports) / Number(LAMPORTS_PER_SOL);
const PLAYER_FEE = sol(FEES.player);
const PROJECT_FEE = sol(FEES.project);
const NETWORK_FEE = sol(SIGNATURE_FEE);
/** MagicBlock's oracle, per random number: a box's open (the player), a lottery's draw, a `roll` (model.mjs ORACLE_FEE). */
const ORACLE = sol(ORACLE_FEE);
/** A purchase line in a lottery's list: 40 bytes of rent the buyer pays and first place gets (lottery.rs). */
const TICKET_LINE = sol(40n * RENT_PER_BYTE);
/**
 * A collectible's Core account, paid from the order's escrow: its rent (a Core asset of about 190 bytes at 5,080
 * lamports a byte) plus Metaplex Core's creation fee of 0.0015 SOL, which the account keeps. The full simulation
 * measured 0.00309 to 0.00313 SOL across the fixtures (2026-10-12); this was "about 0.004" before.
 */
const COLLECTIBLE_RENT = 0.0031;
/** What a collectible a recipe burns gives back: its rent less one byte's (Core leaves a 1-byte account that keeps
 * the creation fee). 189 bytes × 5,080 lamports, measured by the full simulation. */
const BURN_REFUND = 0.00096;
const num = (v) => (v === undefined || v === null ? 0 : Number(v));
export const round = (x, digits = 9) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : x);

/** Sums { token: amount } maps. */
const add = (into, token, amount) => {
  if (!amount) return;
  into[token] = (into[token] ?? 0) + amount;
};

/** Prices are capped here so a price that compounds without end stays a number. */
const PRICE_CAP = 1e18;

/**
 * What `perDay` sales a day over `days` pay, one every 1/perDay of a day (the first half a gap in), with the part's
 * rise and fall exactly as the program prices them (state.rs `Fall::sell`): each sale pays the price fallen since the
 * later of the fall's start and the last sale, and the price after it is what was paid plus the rise.
 * { count, average, first, last }, in whole units.
 */
export function salePrices(part, perDay, days, fallStartsAfter = 0) {
  const listed = num(part.price);
  const count = Math.round(perDay * days);
  if (!count || (!part.rise && !part.fall)) return { count, average: listed, first: listed, last: listed };
  const gap = DAY / perDay;
  const growth = num(part.rise?.growthPercent) / 100;
  const step = num(part.rise?.step);
  const every = part.fall ? toSeconds(part.fall.every) : 0;
  const floor = num(part.fall?.floor);
  let price = listed;
  let since = fallStartsAfter;
  let total = 0;
  let first;
  let paid = listed;
  for (let k = 0; k < count; k++) {
    const at = (k + 0.5) * gap;
    paid = price;
    if (part.fall && every && at > since && price > floor) paid = Math.max(floor, price - Math.floor((at - since) / every) * num(part.fall.step));
    since = Math.max(since, at);
    first ??= paid;
    total += paid;
    price = Math.min(PRICE_CAP, paid + paid * growth + step);
  }
  return { count, average: total / count, first, last: paid };
}

export function simulate(economy, { now = 0 } = {}) {
  const m = model(economy, { now });
  const game = m.currencyKey;
  const days = m.scenario.days ?? 30;
  const perDay = (kind, key) => num(m.scenario.perDay?.[`${kind}:${key}`] ?? DEFAULT_PER_DAY);
  const symbol = (key) => m.tokens.get(key)?.symbol ?? key;

  // Per pool: fixed money in and out per day, and a rate per day for what takes a share of what it holds.
  const pools = new Map(m.pools.map((p) => [p.key, { key: p.key, currency: p.currency, seed: num(p.seed), in: [], out: [], rate: [], variance: 0 }]));
  const flowIn = (pool, by, amount) => amount && pools.get(pool)?.in.push({ by, perDay: amount });
  const flowOut = (pool, by, amount) => amount && pools.get(pool)?.out.push({ by, perDay: amount });
  const rateOut = (pool, by, perDayShare, to) => perDayShare && pools.get(pool)?.rate.push({ by, perDay: perDayShare, ...(to ? { to } : {}) });

  const players = { pay: {}, get: {}, fees: 0, network: 0, rent: 0, oracle: 0 };
  const creator = { treasury: {}, fees: 0, network: 0, oracle: 0 };
  const burned = {};
  const accounts = {};
  const platform = { player: 0, project: 0 };
  const notes = [];
  /** Prizes that are a share of a pool: counted for players once each pool's level is known. */
  const sharePrizes = [];
  /** Shares of a pool that are burned (a schedule, a decision): counted once each pool's level is known. */
  const shareBurns = [];
  /** Seconds from going live to a fall's start. */
  const fallStart = (part) => (part.fall?.start && part.fall.start !== 'publish' ? Math.max(0, toTime(part.fall.start, now) - now) : 0);
  /** What a rising or falling price really comes to, in words. */
  const priceNote = (part, sold) => {
    if (!part.rise && !part.fall) return;
    const said = `“${part.name}”’s price ${part.rise && part.fall ? 'rises with each sale and falls with time' : part.rise ? 'rises with each sale' : 'falls with time and starts again after each sale'}: over the scenario’s ${sold.count} sales it averages ${round(sold.average, 6)} (the first ${round(sold.first, 6)}, the last ${round(sold.last, 6)}), and the money below counts that.`;
    notes.push(sold.last >= 10 * num(part.price) ? `${said} It ends ${sold.last >= PRICE_CAP ? 'beyond any price' : `${round(sold.last / num(part.price), 1)} times`} where it started: players stop buying long before that. A smaller growth keeps it in reach.` : said);
  };

  /** Where `amount` of `token` goes under `split`, per day: pools, burns, accounts, the treasury. */
  const carryOut = (split, token, amount, by) => {
    let left = amount;
    for (const s of sharesOf(split)) {
      const part = (amount * (s.bps ?? 0)) / 10_000;
      left -= part;
      if (s.kind === 'pool') flowIn(s.key, by, part);
      else if (s.kind === 'burn') add(burned, token, part);
      else add(accounts, `${s.kind}:${s.key}`, part);
    }
    add(creator.treasury, token, left);
  };
  const playerAction = (count, signatures = 1) => {
    players.fees += count * PLAYER_FEE;
    platform.player += count * PLAYER_FEE;
    players.network += count * signatures * NETWORK_FEE;
  };

  // ---- boxes
  const boxes = m.boxes.map((b) => {
    const token = b.currency ?? game;
    const opens = perDay('box', b.key);
    // A price that rises or falls is counted at what the scenario's opens really pay, on average.
    const sold = salePrices(b, opens, days, fallStart(b));
    const price = sold.average;
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    let value = 0;
    let burnChance = 0;
    const unpriced = [];
    const other = {};
    const outcomes = (b.outcomes ?? []).map((o, i) => {
      const p = w[i] / total;
      const row = { gives: o.gives, chance: round(p * 100, 6) };
      if (o.gives === 'pay') {
        const prizeToken = m.pool.get(o.pool)?.currency;
        Object.assign(row, { pool: o.pool, amount: num(o.amount), token: prizeToken });
        if (prizeToken === token) value += p * num(o.amount);
        else add(other, prizeToken, p * num(o.amount));
        flowOut(o.pool, `box:${b.key}`, opens * p * num(o.amount));
      } else if (o.gives === 'share') {
        const bps = toBps(o.percent) ?? 0;
        const prizeToken = m.pool.get(o.pool)?.currency;
        Object.assign(row, { pool: o.pool, percent: o.percent, token: prizeToken });
        rateOut(o.pool, `box:${b.key}`, opens * p * (bps / 10_000));
        sharePrizes.push({ pool: o.pool, rate: opens * p * (bps / 10_000), box: b.key, perOpen: p * (bps / 10_000) });
        row.shareOfPool = true;
      } else if (o.gives === 'item') {
        const it = m.item.get(o.item);
        const worth = it?.value !== undefined ? num(it.value) : num(it?.price) > 0 ? num(it.price) : null;
        Object.assign(row, { item: o.item, worth });
        if (worth === null) unpriced.push(o.item);
        else if ((b.currency ?? game) === game) value += p * worth;
        else add(other, game, p * worth);
      } else if (o.gives === 'burn') burnChance += p;
      return row;
    });
    const shares = outcomes.filter((o) => o.shareOfPool);
    // How much the prizes swing from day to day, per pool: opens × (E[prize²] − E[prize]²).
    for (const key of new Set(outcomes.filter((o) => o.gives === 'pay').map((o) => o.pool))) {
      const rows = outcomes.filter((o) => o.gives === 'pay' && o.pool === key);
      const mean = rows.reduce((n, o) => n + (o.chance / 100) * o.amount, 0);
      const square = rows.reduce((n, o) => n + (o.chance / 100) * o.amount ** 2, 0);
      if (pools.has(key)) pools.get(key).variance += opens * (square - mean ** 2);
    }
    // Money: the payment is split unless the roll burns it all.
    carryOut(b.split, token, opens * price * (1 - burnChance), `box:${b.key}`);
    add(burned, token, opens * price * burnChance);
    add(players.pay, token, opens * price);
    add(players.get, token, opens * value);
    for (const [t, v] of Object.entries(other)) add(players.get, t, opens * v);
    // Two signatures: the open, then the claim (settle), both from the player's wallet as gf-web3's openBox does
    // (the full simulation measured it: before 2026-10-12 this counted the settle as the creator's).
    playerAction(opens, 2);
    players.oracle += opens * ORACLE;
    const collectibles = outcomes.filter((o) => o.gives === 'item').reduce((n, o) => n + o.chance / 100, 0);
    players.rent += opens * collectibles * COLLECTIBLE_RENT;
    const known = !unpriced.length && !shares.length && !Object.keys(other).length;
    // What one open really takes from the player's wallet: the price, games.fun's fee, the oracle's and the network's.
    const isSol = Boolean(m.tokens.get(token)?.wsol);
    const extrasSol = PLAYER_FEE + ORACLE + 2 * NETWORK_FEE;
    const realCost = { price: round(price), token, playerFeeSol: PLAYER_FEE, oracleSol: ORACLE, networkSol: round(2 * NETWORK_FEE), extrasSol: round(extrasSol), ...(isSol ? { totalSol: round(price + extrasSol) } : {}) };
    priceNote(b, sold);
    return {
      key: b.key,
      name: b.name,
      price: num(b.price),
      ...(price !== num(b.price) ? { averagePrice: round(price) } : {}),
      token,
      opensPerDay: opens,
      outcomes,
      expectedBack: round(value),
      returnPercent: price && (value > 0 || !Object.keys(other).length) ? round((value / price) * 100, 4) : null,
      houseEdgePercent: known && price ? round((1 - value / price) * 100, 4) : null,
      alsoPays: other,
      unpriced,
      playerFee: PLAYER_FEE,
      oracleFee: ORACLE,
      realCost,
      ...(isSol && known && price ? { returnOfRealCostPercent: round((value / (price + extrasSol)) * 100, 4) } : {}),
    };
  });

  // ---- items sold in the shop
  const items = m.items
    .filter((it) => num(it.price) > 0)
    .map((it) => {
      const sales = perDay('item', it.key);
      const sold = salePrices(it, sales, days, fallStart(it));
      const price = sold.average;
      priceNote(it, sold);
      carryOut(it.split, game, sales * price, `item:${it.key}`);
      add(players.pay, game, sales * price);
      // A collectible is paid, then claimed: two signatures from the player (gf-web3's buy). A normal item is
      // settled by the game once its backend delivered it: the second signature is the game's.
      const collectible = (it.kind ?? 'collectible') === 'collectible';
      playerAction(sales, collectible ? 2 : 1);
      if (collectible) players.rent += sales * COLLECTIBLE_RENT;
      else creator.network += sales * NETWORK_FEE;
      const listed = num(it.price);
      const rises = it.rise ? listed * (num(it.rise.growthPercent) / 100) + num(it.rise.step) : 0;
      return { key: it.key, name: it.name, price: listed, ...(price !== listed ? { averagePrice: round(price) } : {}), token: game, salesPerDay: sales, ...(rises ? { nextPrice: round(listed + rises) } : {}), ...(it.supply ? { soldOutInDays: round(it.supply / (sales || Infinity), 2) } : {}) };
    });

  // ---- payments
  const payments = m.payments.map((p) => {
    const token = p.currency ?? game;
    const count = perDay('payment', p.key);
    carryOut(p.split, token, count * num(p.amount), `payment:${p.key}`);
    add(players.pay, token, count * num(p.amount));
    playerAction(count);
    return { key: p.key, name: p.name, amount: num(p.amount), token, perDay: count };
  });

  // ---- recipes
  const recipes = m.recipes.map((r) => {
    const crafts = perDay('recipe', r.key);
    const takes = [];
    const gives = [];
    for (const line of r.in ?? []) {
      if (line.takes === 'burn') players.rent -= crafts * (line.count ?? 1) * BURN_REFUND;
      if (line.takes !== 'pay') {
        takes.push(`${line.takes === 'burn' ? `${line.count ?? 1} × ` : ''}${line.item}${line.takes === 'burn' ? ' (burned)' : line.takes === 'renew' ? ' (renewed)' : ' (kept)'}`);
        continue;
      }
      const token = line.currency ?? game;
      takes.push(`${num(line.amount)} ${symbol(token)}`);
      add(players.pay, token, crafts * num(line.amount));
      const d = destination(line.to);
      if (d.kind === 'pool') flowIn(d.key, `recipe:${r.key}`, crafts * num(line.amount));
      else if (d.kind === 'burn') add(burned, token, crafts * num(line.amount));
      else add(accounts, `${d.kind}:${d.key}`, crafts * num(line.amount));
    }
    for (const line of r.out ?? []) {
      if (line.gives === 'item') {
        gives.push(line.item);
        players.rent += crafts * COLLECTIBLE_RENT;
        const worth = m.item.get(line.item)?.value;
        if (worth !== undefined) add(players.get, game, crafts * num(worth));
      } else if (line.gives === 'tokens') {
        const token = line.currency ?? game;
        gives.push(`${num(line.amount)} ${symbol(token)}`);
        add(players.get, token, crafts * num(line.amount));
        if (line.from?.startsWith('pool:')) flowOut(line.from.slice(5), `recipe:${r.key}`, crafts * num(line.amount));
      } else if (line.gives === 'share') {
        gives.push(`${line.percent}% of ${line.pool}`);
        rateOut(line.pool, `recipe:${r.key}`, crafts * ((toBps(line.percent) ?? 0) / 10_000));
        sharePrizes.push({ pool: line.pool, rate: crafts * ((toBps(line.percent) ?? 0) / 10_000) });
      }
    }
    const signatures = 1 + (r.out ?? []).filter((l) => l.gives === 'item').length;
    playerAction(crafts, signatures);
    return { key: r.key, name: r.name, craftsPerDay: crafts, takes, gives };
  });

  // ---- schedules
  const schedules = m.schedules
    .filter((s) => s.active !== false)
    .map((s) => {
      const every = toSeconds(s.every) || DAY;
      const runs = DAY / every;
      creator.network += runs * NETWORK_FEE; // run_schedule is free of the program's fee; whoever sends it pays the network
      if (s.does === 'issue') {
        const amount = num(s.amount);
        flowIn(s.pool, `schedule:${s.key}`, runs * amount);
        const halving = s.halveEvery ? `, halving every ${s.halveEvery} runs (every ${round((s.halveEvery * every) / DAY, 2)} days)` : '';
        const totalEver = s.halveEvery ? amount * s.halveEvery * 2 : s.maxRuns ? amount * s.maxRuns : Infinity;
        return { key: s.key, does: 'issue', perDay: round(runs * amount), token: m.pool.get(s.pool)?.currency, says: `mints ${round(runs * amount)} ${symbol(m.pool.get(s.pool)?.currency)} a day into ${s.pool}${halving}`, mintsInAll: Number.isFinite(totalEver) ? round(totalEver) : null };
      }
      const share = (toBps(s.percent) ?? 0) / 10_000;
      if (s.does === 'burn') {
        rateOut(s.pool, `schedule:${s.key}`, runs * share);
        shareBurns.push({ pool: s.pool, rate: runs * share });
      }
      else rateOut(s.from, `schedule:${s.key}`, runs * share, s.to);
      return { key: s.key, does: s.does, percentPerDay: round(runs * s.percent, 6), says: `${s.does === 'burn' ? 'burns' : `moves to ${s.to}`} ${s.percent}% of ${s.does === 'burn' ? s.pool : s.from} every ${round(every / 3600, 3)} h` };
    });

  // ---- stakes: everything that arrives in the rewards pool goes to stakers
  // ---- lotteries: in steady state each round pays out what came in (what the places leave rolls over)
  const lotteries = m.lotteries.map((l) => {
    const tickets = perDay('lottery', l.key);
    const every = toSeconds(l.every) || DAY;
    const perRound = (tickets * every) / DAY;
    const pot = m.pool.get(l.pot);
    const potToken = pot?.currency;
    const ticketToken = l.ticketCurrency ?? potToken;
    const price = num(l.price);
    const cut = (toBps(l.cutPercent) ?? 0) / 10_000;
    add(players.pay, ticketToken, tickets * price);
    if (l.ticketCurrency) add(burned, ticketToken, tickets * price);
    else {
      flowIn(l.pot, `lottery:${l.key}`, tickets * price * (1 - cut));
      add(creator.treasury, potToken, tickets * price * cut);
    }
    playerAction(tickets);
    players.rent += tickets * TICKET_LINE;
    const places = (l.places ?? [100]).map(Number);
    creator.network += ((1 + places.length) * NETWORK_FEE * DAY) / every; // the draw and each place's payment
    creator.oracle += (ORACLE * DAY) / every; // the draw asks the oracle; whoever sends it (the game's keeper) pays
    return { key: l.key, name: l.name, price, token: ticketToken, potToken, ticketsPerDay: tickets, ticketsPerRound: round(perRound, 4), roundDays: round(every / DAY, 4), places, cutPercent: num(l.cutPercent) };
  });

  // ---- decisions with a known rate
  for (const d of m.decisions) {
    const rate = num(d.perDay);
    if (!rate) continue;
    creator.fees += rate * PROJECT_FEE;
    platform.project += rate * PROJECT_FEE;
    creator.network += rate * NETWORK_FEE;
    if (d.does === 'roll') creator.oracle += rate * ORACLE;
    if ((d.does === 'payout' || d.does === 'burn') && d.pool) {
      if (d.percent !== undefined) {
        rateOut(d.pool, `decision:${d.key}`, rate * ((toBps(d.percent) ?? 0) / 10_000));
        if (d.does === 'payout') sharePrizes.push({ pool: d.pool, rate: rate * ((toBps(d.percent) ?? 0) / 10_000) });
        else shareBurns.push({ pool: d.pool, rate: rate * ((toBps(d.percent) ?? 0) / 10_000) });
      }
      else flowOut(d.pool, `decision:${d.key}`, rate * num(d.amount));
      const token = m.pool.get(d.pool)?.currency;
      if (d.does === 'payout' && d.amount !== undefined) add(players.get, token, rate * num(d.amount));
      if (d.does === 'burn' && d.amount !== undefined) add(burned, token, rate * num(d.amount));
    }
  }
  const contests = m.contests.map((c) => {
    const rake = sharesOf(c.split).reduce((n, s) => n + (s.bps ?? 0), 0) / 100;
    const opened = c.every ? DAY / toSeconds(c.every) : 0;
    creator.fees += opened * 2 * PROJECT_FEE; // opened and decided
    platform.project += opened * 2 * PROJECT_FEE;
    return { key: c.key, name: c.name, sides: c.sides, rakePercent: rake, winnersSharePercent: 100 - rake, says: `the winning side shares ${100 - rake}% of the pot, by what each put in` };
  });
  for (const s of m.stakes) playerAction(perDay('stake', s.key));
  for (const h of m.holds) playerAction(perDay('hold', h.key));
  for (const c of m.contests) playerAction(perDay('contest', c.key));

  // ---- the pools over time
  const settle = (p) => {
    const fixedIn = p.in.reduce((n, f) => n + f.perDay, 0);
    const fixedOut = p.out.reduce((n, f) => n + f.perDay, 0);
    const rate = p.rate.reduce((n, f) => n + f.perDay, 0);
    return { fixedIn, fixedOut, rate };
  };
  // A move schedule's share enters its target pool: iterate twice so the target sees its source's level.
  const levels = new Map();
  for (let pass = 0; pass < 3; pass += 1)
    for (const p of pools.values()) {
      const moved = [...pools.values()].flatMap((q) => q.rate.filter((r) => r.to === p.key).map((r) => r.perDay * (levels.get(q.key) ?? q.seed)));
      const { fixedIn, fixedOut, rate } = settle(p);
      const inflow = fixedIn + moved.reduce((a, b) => a + b, 0);
      const net = inflow - fixedOut;
      const steady = rate > 0 ? net / rate : null;
      levels.set(p.key, steady !== null && steady > 0 ? steady : p.seed);
      p.inflow = inflow;
    }

  const stakeRows = m.stakes.map((s) => {
    const pool = pools.get(s.rewards);
    const rewards = pool ? pool.inflow : 0;
    if (pool) pool.out.push({ by: `stake:${s.key}`, perDay: Math.max(0, rewards - pool.out.reduce((n, f) => n + f.perDay, 0)) });
    const staked = num(m.scenario.staked?.[s.key]);
    const sameToken = pool?.currency === s.stakes;
    return {
      key: s.key,
      name: s.name,
      stakes: s.stakes,
      rewardsToken: pool?.currency,
      rewardsPerDay: round(rewards),
      ...(staked ? { staked, perThousandStakedPerDay: round((rewards / staked) * 1000) } : {}),
      ...(staked && sameToken ? { yearlyPercent: round(((rewards * 365) / staked) * 100, 4) } : {}),
    };
  });
  for (const row of stakeRows) add(players.get, row.rewardsToken, row.rewardsPerDay);

  // Lotteries pay what came in, once the pot is in its steady state.
  for (const l of lotteries) {
    const pool = pools.get(m.lottery.get(l.key).pot);
    const inflow = pool ? pool.inflow : 0;
    const placesTotal = l.places.reduce((a, b) => a + b, 0) / 100;
    pool?.out.push({ by: `lottery:${l.key}`, perDay: inflow });
    const potBeforeDraw = placesTotal ? (inflow * l.roundDays) / placesTotal : 0;
    l.potBeforeDraw = round(potBeforeDraw);
    l.paidPerRound = round(inflow * l.roundDays);
    l.prizes = l.places.map((pct) => round((potBeforeDraw * pct) / 100));
    l.expectedPerTicket = l.ticketsPerRound ? round((inflow * l.roundDays) / l.ticketsPerRound) : null;
    l.returnPercent = l.ticketsPerRound && l.price && l.token === l.potToken ? round(((inflow * l.roundDays) / l.ticketsPerRound / l.price) * 100, 4) : null;
    add(players.get, l.potToken, inflow);
  }

  const poolRows = [...pools.values()].map((p) => {
    const { fixedOut, rate } = settle(p);
    const inflow = p.inflow ?? 0;
    const net = inflow - fixedOut;
    const row = {
      key: p.key,
      token: p.currency,
      seed: p.seed,
      inPerDay: round(inflow),
      outPerDay: round(fixedOut + rate * (levels.get(p.key) ?? p.seed)),
      ins: p.in.map((f) => ({ by: f.by, perDay: round(f.perDay) })),
      outs: [...p.out.map((f) => ({ by: f.by, perDay: round(f.perDay) })), ...p.rate.map((f) => ({ by: f.by, percentPerDay: round(f.perDay * 100, 6) }))],
    };
    if (rate > 0 && Math.abs(net) < 1e-12) {
      // Only a share goes out: it shrinks by that share for ever, and never quite empties.
      row.after = round(p.seed * Math.exp(-rate * days));
      row.halfLifeDays = round(Math.log(2) / rate, 2);
      row.lasts = 'shrinks';
    } else if (rate > 0) {
      const steady = net / rate;
      if (steady > 0) {
        row.settlesAt = round(steady);
        row.after = round(steady + (p.seed - steady) * Math.exp(-rate * days));
        row.lasts = 'settles';
      } else {
        // B(t) = B* + (B0 − B*)e^(−rt) reaches 0 at t = ln((B0 − B*) / −B*) / r
        const t = p.seed > 0 ? Math.log((p.seed - steady) / -steady) / rate : 0;
        row.lastsDays = round(t, 2);
        row.after = 0;
        row.lasts = 'runs dry';
      }
    } else if (net < -1e-12) {
      row.lastsDays = round(p.seed / -net, 2);
      row.after = round(Math.max(0, p.seed + net * days));
      row.lasts = 'runs dry';
    } else {
      row.after = round(p.seed + net * days);
      row.lasts = net > 1e-12 ? 'grows' : 'holds';
    }
    if (p.variance > 0) {
      row.swingPerDay = round(Math.sqrt(p.variance), 6);
      const weekly = Math.sqrt(p.variance * 7);
      if (row.lasts !== 'runs dry' && p.seed < 3 * weekly)
        notes.push(`The pool “${p.key}” pays even on average, but luck moves it by about ±${round(row.swingPerDay, 4)} ${symbol(p.currency)} a day (±${round(weekly, 4)} a week), against a seed of ${p.seed}. When it cannot pay a prize, the program skips that prize and the roll lands on another outcome, so a bad week turns wins into losses until it refills. A seed of about ${round(3 * weekly, 2)} (three times a week’s swing) rides out almost any week.`);
    }
    if (row.lasts === 'runs dry') notes.push(`The pool “${p.key}” pays out more than comes in: it lasts about ${row.lastsDays} days from its seed of ${p.seed} ${symbol(p.currency)}.`);
    return row;
  });

  for (const prize of sharePrizes) {
    const row = poolRows.find((r) => r.key === prize.pool);
    const level = row ? (row.settlesAt ?? row.seed) : 0;
    add(players.get, row?.token, prize.rate * level);
    const box = prize.box && boxes.find((b) => b.key === prize.box);
    if (box) add(box.alsoPays, row?.token, round(prize.perOpen * level));
  }
  // A share burned is burned at the pool's level, as a share prize is paid (found by the full simulation: a burn
  // schedule's tokens were missing from what is burned a day).
  for (const b of shareBurns) {
    const row = poolRows.find((r) => r.key === b.pool);
    add(burned, row?.token, b.rate * (row ? (row.settlesAt ?? row.seed) : 0));
  }
  for (const t of m.tokens.values())
    if (t.powers?.transferFeePercent > 0) notes.push(`${t.symbol} keeps ${t.powers.transferFeePercent}% of every transfer: pools, prizes, stakes and the treasury receive that much less than shown here.`);

  const totals = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, round(v)]));
  return {
    scenario: { days, perDay: m.scenario.perDay ?? {}, defaultPerDay: DEFAULT_PER_DAY },
    boxes,
    items,
    payments,
    recipes,
    schedules,
    lotteries,
    stakes: stakeRows,
    contests,
    pools: poolRows,
    perDay: {
      players: { pay: totals(players.pay), getBack: totals(players.get), playerFeesSol: round(players.fees), oracleFeesSol: round(players.oracle), networkFeesSol: round(players.network), rentSol: round(players.rent) },
      creator: { treasury: totals(creator.treasury), projectFeesSol: round(creator.fees), oracleFeesSol: round(creator.oracle), networkFeesSol: round(creator.network) },
      oracle: { totalSol: round(players.oracle + creator.oracle) },
      platform: { playerFeesSol: round(platform.player), projectFeesSol: round(platform.project), totalSol: round(platform.player + platform.project) },
      burned: totals(burned),
      accounts: totals(accounts),
    },
    fees: { playerSol: PLAYER_FEE, projectSol: PROJECT_FEE, oracleSol: ORACLE, networkPerSignatureSol: NETWORK_FEE, escrowSol: sol(ESCROW_LAMPORTS), ticketLineRentSol: round(TICKET_LINE), collectibleRentSol: COLLECTIBLE_RENT, burnRefundSol: BURN_REFUND },
    notes,
  };
}

/** The simulation in plain words. */
export function explain(sim, economy) {
  const m = model(economy);
  const sym = (key) => m.tokens.get(key)?.symbol ?? key;
  const lines = [];
  const n = (x) => (Number.isFinite(x) ? String(round(x, 6)) : String(x));
  lines.push(`Assuming ${Object.entries(sim.scenario.perDay).map(([k, v]) => `${v} × ${k}`).join(', ') || 'nothing in particular'} a day (anything not named: ${sim.scenario.defaultPerDay} a day), over ${sim.scenario.days} days.`);
  for (const b of sim.boxes) {
    const edge = b.houseEdgePercent !== null ? `; the house keeps ${n(b.houseEdgePercent)}% of each price` : '';
    const also = Object.entries(b.alsoPays).map(([t, v]) => `${n(v)} ${sym(t)}`);
    const back = b.returnPercent !== null ? `${n(b.expectedBack)} ${sym(b.token)} on average (${n(b.returnPercent)}%)${also.length ? ` and ${also.join(', ')}` : ''}` : `${also.join(', ') || 'nothing'} on average`;
    const all = b.realCost?.totalSol !== undefined ? `; ${n(b.realCost.totalSol)} SOL in all with the network fee` : `; ${n(b.realCost?.extrasSol)} SOL on top with the network fee`;
    lines.push(`Box “${b.name}”: costs ${n(b.price)} ${sym(b.token)} (+${n(b.playerFee)} SOL player fee, +${n(b.oracleFee)} SOL to MagicBlock’s oracle for the roll${all}), gives back ${back}${edge}.`);
    for (const o of b.outcomes) lines.push(`  ${n(o.chance)}%: ${o.gives === 'pay' ? `${n(o.amount)} ${sym(o.token)} from ${o.pool}` : o.gives === 'share' ? `${o.percent}% of ${o.pool}` : o.gives === 'item' ? `${o.item}${o.worth !== null ? ` (worth ${n(o.worth)})` : ' (no value given)'}` : o.gives}`);
    if (b.unpriced.length) lines.push(`  Give ${b.unpriced.join(', ')} a "value" to count them in the return.`);
  }
  for (const l of sim.lotteries)
    lines.push(`Lottery “${l.name}”: ${n(l.ticketsPerRound)} tickets a round of ${n(l.roundDays)} days; the pot reaches about ${n(l.potBeforeDraw)} ${sym(l.potToken)} and pays ${l.prizes.map(n).join(' / ')}; a ${n(l.price)} ${sym(l.token)} ticket is worth ${n(l.expectedPerTicket)} ${sym(l.potToken)} on average${l.returnPercent !== null ? ` (${n(l.returnPercent)}%)` : ''}.`);
  for (const s of sim.stakes)
    lines.push(`Stake “${s.name}”: ${n(s.rewardsPerDay)} ${sym(s.rewardsToken)} a day to everyone staked${s.perThousandStakedPerDay !== undefined ? `, ${n(s.perThousandStakedPerDay)} a day for each 1,000 ${sym(s.stakes)} staked` : ''}${s.yearlyPercent !== undefined ? ` (${n(s.yearlyPercent)}% a year)` : ''}.`);
  for (const r of sim.recipes) lines.push(`Recipe “${r.name}”: ${r.takes.join(' + ') || 'nothing'} → ${r.gives.join(' + ') || 'nothing'}, ${n(r.craftsPerDay)} a day.`);
  for (const s of sim.schedules) lines.push(`Schedule “${s.key}”: ${s.says}.`);
  for (const c of sim.contests) lines.push(`Contest “${c.name}”: ${c.says}.`);
  for (const p of sim.pools) {
    const fate =
      p.lasts === 'runs dry' ? `runs dry in about ${n(p.lastsDays)} days`
      : p.lasts === 'settles' ? `settles at about ${n(p.settlesAt)}`
      : p.lasts === 'shrinks' ? `shrinks to about ${n(p.after)} after ${sim.scenario.days} days (half gone every ${n(p.halfLifeDays)} days)`
      : p.lasts === 'grows' ? `grows to about ${n(p.after)} after ${sim.scenario.days} days`
      : 'holds steady';
    lines.push(`Pool “${p.key}”: ${n(p.inPerDay)} ${sym(p.token)} in and ${n(p.outPerDay)} out a day from a seed of ${n(p.seed)}; it ${fate}.`);
  }
  const d = sim.perDay;
  const list = (map) => Object.entries(map).map(([k, v]) => `${n(v)} ${sym(k)}`).join(', ') || 'nothing';
  lines.push(`Each day players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average (items at the value you gave them), plus ${n(d.players.playerFeesSol)} SOL in player fees, ${n(d.players.oracleFeesSol)} SOL to MagicBlock’s oracle and ${n(d.players.networkFeesSol)} SOL in network fees.`);
    if (d.creator.oracleFeesSol) {
      const what = [sim.lotteries.length ? 'lottery draws' : null, m.decisions.some((x) => x.does === 'roll' && Number(x.perDay) > 0) ? 'the authority’s rolls' : null].filter(Boolean).join(' and ');
      lines.push(`The oracle also takes about ${n(d.creator.oracleFeesSol)} SOL a day for ${what}, from whoever sends them (the game’s keeper or the authority).`);
    }
  lines.push(`The treasury gets ${list(d.creator.treasury)} a day; burned: ${list(d.burned)}. games.fun’s fees: ${n(d.platform.totalSol)} SOL a day.`);
  for (const note of sim.notes) lines.push(note);
  return lines.join('\n');
}
