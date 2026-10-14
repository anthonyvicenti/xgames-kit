// The full simulation's numbers, in the quick simulation's shape (whole units of each token, per day), and the two
// side by side: each number the quick simulation predicts against what the real program did, with a flag where they
// differ by more than chance and a small tolerance allow.
import { model, toSeconds, weights } from '../model.mjs';
import { round } from '../simulate.mjs';

const DAY = 86_400;
const LAMPORTS = 1e9;
/** Differences under this share of the quick number are not flagged (rounding, timing at the edges of the run). */
export const TOLERANCE = 0.05;

const sum = (maps, key) => maps.reduce((n, m) => n + (m.get(key) ?? 0n), 0n);
const sol = (lamports) => Number(lamports) / LAMPORTS;

/** The run's measurements, as the quick simulation's numbers. */
export function measure(run) {
  const m = model(run.live);
  const D = run.days;
  const tokenOf = (mint) => run.mintToken.get(mint) ?? mint;
  const whole = (mint, units) => Number(units) / 10 ** (run.decimals.get(mint) ?? 0);
  const rows = [...run.ledger.byLabel].filter(([label]) => !label.startsWith('setup'));
  const all = rows.map(([, r]) => r);
  const perDayByToken = (pick) => {
    const out = {};
    for (const r of all)
      for (const [mint, units] of pick(r)) {
        const k = tokenOf(mint);
        out[k] = (out[k] ?? 0) + whole(mint, units) / D;
      }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, round(v)]));
  };
  const byRole = (field, roles) => round(sol(all.reduce((n, r) => n + roles.reduce((x, role) => x + (r[field].get(role) ?? 0n), 0n), 0n)) / D);
  const catIn = (cat) => (r) => [...r.in].filter(([k]) => k.split('|')[0] === cat).map(([k, v]) => [k.split('|')[1], v]);
  const catOut = (cat) => (r) => [...r.out].filter(([k]) => k.split('|')[0] === cat).map(([k, v]) => [k.split('|')[1], v]);

  // Boxes: what came back against what was paid, items at the value the spec gives them.
  const boxes = m.boxes.map((b) => {
    const c = run.counts.get(`box:${b.key}`);
    const r = run.ledger.byLabel.get(`box:${b.key}`);
    const t = m.priceToken(b);
    const mint = t?.wsol ? 'So11111111111111111111111111111111111111112' : t?.mint;
    const paid = r ? whole(mint, r.pay.get(mint) ?? 0n) : 0;
    let back = r ? whole(mint, r.get.get(mint) ?? 0n) : 0;
    for (const [outcome, n] of c?.outcomes ?? []) {
      if (!outcome.startsWith('item:')) continue;
      const it = m.item.get(outcome.slice(5));
      const worth = it?.value !== undefined ? Number(it.value) : Number(it?.price ?? 0);
      back += Number(n) * worth;
    }
    const costs = c?.realCost ?? [];
    const realCostSol = costs.length ? sol(costs.reduce((a, x) => a + x, 0n)) / costs.length : null;
    return {
      key: b.key,
      opens: c?.done ?? 0,
      wanted: c?.wanted ?? 0,
      paid: round(paid),
      back: round(back),
      returnPercent: paid ? round((back / paid) * 100, 4) : null,
      outcomes: Object.fromEntries([...(c?.outcomes ?? [])].map(([k, n]) => [k, Number(n)])),
      ...(t?.wsol && realCostSol !== null ? { realCostSol: round(realCostSol) } : {}),
    };
  });

  // Pools: money in and out a day, where each ended, and the first day it could not pay.
  const pools = m.pools.map((p) => {
    const t = m.tokens.get(p.currency);
    const mint = t?.wsol ? 'So11111111111111111111111111111111111111112' : t?.mint;
    const cat = `pool:${p.key}`;
    const ins = all.flatMap(catIn(cat)).reduce((n, [, v]) => n + v, 0n);
    const outs = all.flatMap(catOut(cat)).reduce((n, [, v]) => n + v, 0n);
    const balances = run.daily.map((d) => whole(mint, BigInt(d.pools[p.key] ?? 0)));
    const seed = Number(p.seed ?? 0);
    // A lottery's pot and a stake's rewards pool empty by design; another pool that empties stops paying.
    const drains = m.lotteries.some((l) => l.pot === p.key) || m.stakes.some((s) => s.rewards === p.key);
    const dry = drains ? -1 : balances.findIndex((b, i) => i > 0 && b <= 0 && (seed > 0 || balances.slice(0, i).some((x) => x > 0)));
    return {
      key: p.key,
      token: p.currency,
      seed,
      inPerDay: round(whole(mint, ins) / D),
      outPerDay: round(whole(mint, outs) / D),
      after: round(balances.at(-1) ?? seed),
      lowest: round(Math.min(...balances)),
      ...(dry >= 0 ? { emptyOnDay: dry } : {}),
      byDay: balances.map((b) => round(b, 6)),
    };
  });

  const lotteries = m.lotteries.map((l) => {
    const draw = run.ledger.byLabel.get(`lottery:${l.key} (draw)`);
    const buy = run.ledger.byLabel.get(`lottery:${l.key}`);
    const pot = m.pool.get(l.pot);
    const potToken = m.tokens.get(pot?.currency);
    const potMint = potToken?.wsol ? 'So11111111111111111111111111111111111111112' : potToken?.mint;
    const ticketToken = m.tokens.get(l.ticketCurrency ?? pot?.currency);
    const ticketMint = ticketToken?.wsol ? 'So11111111111111111111111111111111111111112' : ticketToken?.mint;
    const paidOut = draw ? whole(potMint, draw.get.get(potMint) ?? 0n) : 0;
    const spent = buy ? whole(ticketMint, buy.pay.get(ticketMint) ?? 0n) : 0;
    const rounds = run.counts.get(`lottery:${l.key} (draw)`)?.done ?? 0;
    const tickets = run.counts.get(`lottery:${l.key}`)?.done ?? 0;
    return { key: l.key, tickets, rounds, paidOut: round(paidOut), paidPerRound: rounds ? round(paidOut / rounds) : null, spent: round(spent), ...(l.ticketCurrency ? {} : { returnPercent: spent ? round((paidOut / spent) * 100, 4) : null }) };
  });

  const stakes = m.stakes.map((s) => {
    const pool = m.pool.get(s.rewards);
    const t = m.tokens.get(pool?.currency);
    const mint = t?.wsol ? 'So11111111111111111111111111111111111111112' : t?.mint;
    const credited = all.flatMap(catIn(`rewards:${s.key}`)).reduce((n, [, v]) => n + v, 0n);
    const collected = all.reduce((n, r) => n + (r.rewards.get(mint) ?? 0n), 0n);
    return { key: s.key, rewardsPerDay: round(whole(mint, credited) / D), collectedPerDay: round(whole(mint, collected) / D) };
  });

  // Items valued as the spec values them count in what players got, as the quick simulation counts them.
  const getBack = perDayByToken((r) => r.get);
  const valued = {};
  for (const [label, c] of run.counts) {
    if (label.startsWith('box:')) for (const [outcome, n] of c.outcomes) if (outcome.startsWith('item:')) valued[outcome.slice(5)] = (valued[outcome.slice(5)] ?? 0) + Number(n);
    if (label.startsWith('recipe:')) for (const line of m.recipe.get(label.slice(7))?.out ?? []) if (line.gives === 'item' && m.item.get(line.item)?.value !== undefined) valued[line.item] = (valued[line.item] ?? 0) + c.done;
  }
  for (const [key, n] of Object.entries(valued)) {
    const it = m.item.get(key);
    const worth = it?.value !== undefined ? Number(it.value) : null;
    if (worth !== null) getBack[m.currencyKey] = round((getBack[m.currencyKey] ?? 0) + (n * worth) / D);
  }

  const accounts = {};
  for (const r of all)
    for (const [k, v] of r.in) {
      const [cat, mint] = k.split('|');
      if (cat.startsWith('account:') || cat.startsWith('holder:')) accounts[cat] = round((accounts[cat] ?? 0) + whole(mint, v) / D);
    }
  const treasury = {};
  for (const r of all)
    for (const [k, v] of r.in) {
      const [cat, mint] = k.split('|');
      if (cat === 'treasury') treasury[tokenOf(mint)] = round((treasury[tokenOf(mint)] ?? 0) + whole(mint, v) / D);
    }
  const platformAll = round(sol(all.reduce((n, r) => n + [...r.platform.values()].reduce((a, b) => a + b, 0n), 0n)) / D);

  return {
    days: D,
    players: run.players,
    transactions: run.transactions,
    boxes,
    pools,
    lotteries,
    stakes,
    perDay: {
      players: { pay: perDayByToken((r) => r.pay), getBack, playerFeesSol: byRole('platform', ['player']), oracleFeesSol: byRole('oracle', ['player']), networkFeesSol: byRole('network', ['player']), rentSol: byRole('rent', ['player']) },
      creator: { treasury, oracleFeesSol: byRole('oracle', ['keeper', 'authority']), networkFeesSol: byRole('network', ['keeper', 'authority']) },
      platform: { totalSol: platformAll },
      burned: perDayByToken((r) => r.burned),
      accounts,
    },
    counts: Object.fromEntries([...run.counts].map(([label, c]) => [label, { wanted: c.wanted, done: c.done, ...(c.refused.size ? { refused: Object.fromEntries([...c.refused].map(([k, n]) => [k, Number(n)])) } : {}) }])),
    notPlayed: run.notPlayed,
  };
}

/**
 * The economy as the run played it: each player action at the rate it achieved (a part the run could not play at 0),
 * each decision at the rate the authority carried it out. The quick simulation of this is what the run is held to.
 */
export function asPlayed(full, economy) {
  const perDay = { ...(economy.scenario?.perDay ?? {}) };
  for (const [label, c] of Object.entries(full.counts)) if (/^(box|item|payment|recipe|lottery|stake|hold|contest):[^ ]+$/.test(label)) perDay[label] = round(c.done / full.days, 6);
  for (const x of full.notPlayed ?? []) perDay[x.label] = 0;
  const decisions = (economy.decisions ?? []).map((d) => (Number(d.perDay) > 0 ? { ...d, perDay: round((full.counts[`decision:${d.key}`]?.done ?? 0) / full.days, 6) } : d));
  return { ...economy, scenario: { ...(economy.scenario ?? {}), days: full.days, perDay }, ...(economy.decisions ? { decisions } : {}) };
}

/** The variance of what one open of a box gives back (prizes in its own token, items at their value). */
function openVariance(m, key, levels = {}) {
  const box = m.box.get(key);
  const w = weights(box);
  const total = w.reduce((a, x) => a + x, 0) || 1;
  const value = (o) => (o.gives === 'pay' ? Number(o.amount) : o.gives === 'item' ? Number(m.item.get(o.item)?.value ?? m.item.get(o.item)?.price ?? 0) : o.gives === 'share' ? (Number(o.percent) / 100) * (levels[o.pool] ?? 0) : 0);
  const mean = (box.outcomes ?? []).reduce((n, o, i) => n + (w[i] / total) * value(o), 0);
  const square = (box.outcomes ?? []).reduce((n, o, i) => n + (w[i] / total) * value(o) ** 2, 0);
  return Math.max(0, square - mean ** 2);
}

/** Chance alone: three standard errors of a box's average return over `opens`, in percent of its price. */
const boxNoise = (m, b, levels, price = Number(m.box.get(b.key).price)) => (b.opens ? (3 * Math.sqrt(openVariance(m, b.key, levels) / b.opens) * 100) / (price || 1) : 0);

/**
 * The quick simulation's own path over the run: its per-day flows are those of the level a pool settles at, but a pool
 * that pays a share of itself takes days to get there (B(t) = B* + (B0 − B*)e^(−rt)). Over D days its average level
 * is B* + (B0 − B*)(1 − e^(−rD))/(rD), and so are what it pays out by share and what it moves into another pool.
 * Returns pool key → { in, out } averaged over the run.
 */
export function quickOverRun(quick, m, D) {
  const rows = new Map(quick.pools.map((p) => [p.key, p]));
  const shape = (p) => {
    const rate = (p.outs ?? []).filter((o) => o.percentPerDay !== undefined).reduce((n, o) => n + o.percentPerDay / 100, 0);
    const fixedOut = (p.outs ?? []).filter((o) => o.perDay !== undefined).reduce((n, o) => n + o.perDay, 0);
    const steady = p.settlesAt ?? (p.lasts === 'shrinks' ? 0 : null);
    if (!rate || steady === null) return { rate, fixedOut, level: null, steady };
    const level = steady + ((p.seed - steady) * (1 - Math.exp(-rate * D))) / (rate * D);
    return { rate, fixedOut, level, steady };
  };
  const out = new Map();
  for (const p of rows.values()) {
    const fixedIn = (p.ins ?? []).reduce((n, f) => n + f.perDay, 0);
    let moved = p.inPerDay - fixedIn;
    // What another pool moves in follows that pool's level, not its settled one.
    for (const sch of m.schedules.filter((x) => x.does === 'move' && x.to === p.key && x.active !== false)) {
      const src = rows.get(sch.from);
      const sh = src ? shape(src) : null;
      if (sh?.level !== null && sh?.steady) moved *= sh.level / sh.steady;
    }
    const inAvg = fixedIn + moved;
    const sh = shape(p);
    const drains = (p.outs ?? []).some((o) => /^(stake|lottery):/.test(o.by ?? ''));
    const outAvg = drains ? sh.fixedOut - (p.inPerDay - inAvg) : sh.level !== null ? sh.fixedOut + sh.rate * sh.level : p.outPerDay;
    out.set(p.key, { in: inAvg, out: outAvg });
  }
  return out;
}

/**
 * The two simulations side by side: [{ what, quick, full, difference, flag, why }]. `noise` is how far chance alone
 * moves a number over this run (when it can be worked out); a number is flagged when the difference is beyond both
 * the noise and TOLERANCE of the quick number.
 */
export function compare(quick, full, economy, { tolerance = TOLERANCE } = {}) {
  const m = model(economy);
  const levels = Object.fromEntries(quick.pools.map((p) => [p.key, p.settlesAt ?? p.seed]));
  const rows = [];
  const line = (what, q, f, { noise = 0, unit = '', why = '' } = {}) => {
    if (q === null || q === undefined || f === null || f === undefined) return;
    const difference = round(f - q, 6);
    const allowed = Math.max(noise, Math.abs(q) * tolerance, 1e-9);
    const flag = Math.abs(difference) > allowed;
    rows.push({ what, quick: round(q, 6), full: round(f, 6), difference, unit, ...(noise ? { noise: round(noise, 6) } : {}), flag, ...(why ? { why } : {}) });
  };
  for (const b of full.boxes) {
    const qb = quick.boxes.find((x) => x.key === b.key);
    if (!qb) continue;
    line(`box ${b.key}: return to players`, qb.returnPercent, b.returnPercent, { noise: boxNoise(m, b, levels, qb.averagePrice ?? qb.price), unit: '%' });
    if (b.realCostSol !== undefined && qb.realCost?.totalSol !== undefined) line(`box ${b.key}: what one open takes from the wallet`, qb.realCost.totalSol, b.realCostSol, { unit: 'SOL' });
  }
  // A box's share of a pool is rare and large: its swing counts too (the quick simulation's swing is fixed prizes').
  const shareVariance = {};
  for (const b of m.boxes) {
    const w = weights(b);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    const opens = (full.counts[`box:${b.key}`]?.done ?? 0) / full.days;
    (b.outcomes ?? []).forEach((o, i) => {
      if (o.gives === 'share') shareVariance[o.pool] = (shareVariance[o.pool] ?? 0) + opens * (w[i] / total) * ((Number(o.percent) / 100) * (levels[o.pool] ?? 0)) ** 2;
    });
  }
  const swing = (p) => (3 * Math.sqrt((p?.swingPerDay ?? 0) ** 2 + (shareVariance[p?.key] ?? 0))) / Math.sqrt(full.days);
  // Timing: a lottery's pot fills for a whole round before a draw empties it, and a stake's rewards pool keeps what
  // arrived since the last stake or unstake. The quick simulation spreads both evenly.
  const roundDays = (key) => {
    const l = m.lotteries.find((x) => x.pot === key);
    return l ? (toSeconds(l.every) || DAY) / DAY : 0;
  };
  const stakeOf = (key) => m.stakes.find((s) => s.rewards === key);
  let lumpy = 0;
  const path = quickOverRun(quick, m, full.days);
  const pathNote = (q, expected) => (Math.abs(expected - q) > Math.abs(q) * 0.01 + 1e-9 ? `the quick simulation’s own path over ${full.days} days; ${round(q, 6)} a day is where it settles` : '');
  const rewardsShift = {};
  for (const p of full.pools) {
    const qp = quick.pools.find((x) => x.key === p.key);
    if (!qp) continue;
    const exp = path.get(p.key) ?? { in: qp.inPerDay, out: qp.outPerDay };
    let timing = 0;
    let why = '';
    if (roundDays(p.key)) {
      timing = qp.inPerDay * roundDays(p.key);
      why = `a lottery pot fills for a round (${round(roundDays(p.key), 3)} days) before its draw pays it out; the quick simulation counts it paid as it comes in`;
      lumpy += timing;
    } else if (stakeOf(p.key)) {
      const actions = (full.counts[`stake:${stakeOf(p.key).key}`]?.done ?? 0) / full.days;
      // A schedule fills it a run at a time; a run that lands at the very end has nobody staking after it.
      const run = Math.max(0, ...m.schedules.filter((x) => (x.to ?? x.pool) === p.key).map((x) => (toSeconds(x.every) || DAY) / DAY));
      timing = Math.max(qp.inPerDay / Math.max(1, actions), qp.inPerDay * run);
      why = 'a stake’s rewards pool keeps what arrived since the last stake or unstake';
    }
    const stake = stakeOf(p.key);
    if (stake) rewardsShift[stake.key] = exp.in - qp.inPerDay;
    line(`pool ${p.key}: in per day`, exp.in, p.inPerDay, { noise: swing(qp), unit: p.token, why: pathNote(qp.inPerDay, exp.in) });
    line(`pool ${p.key}: out per day`, exp.out, p.outPerDay, { noise: swing(qp) + timing / full.days, unit: p.token, why: [why, pathNote(qp.outPerDay, exp.out)].filter(Boolean).join('; ') });
    line(`pool ${p.key}: after ${full.days} days`, qp.after, p.after, { noise: swing(qp) * full.days + timing, unit: p.token, why });
  }
  for (const l of full.lotteries) {
    const ql = quick.lotteries.find((x) => x.key === l.key);
    if (!ql || !l.rounds) continue;
    line(`lottery ${l.key}: paid per round`, ql.paidPerRound, l.paidPerRound, { unit: ql.potToken });
  }
  for (const s of full.stakes) {
    const qs = quick.stakes.find((x) => x.key === s.key);
    if (!qs) continue;
    const expected = qs.rewardsPerDay + (rewardsShift[s.key] ?? 0);
    const actions = (full.counts[`stake:${s.key}`]?.done ?? 0) / full.days;
    line(`stake ${s.key}: rewards per day`, expected, s.rewardsPerDay, { unit: qs.rewardsToken, noise: expected / Math.max(1, actions * full.days), why: [pathNote(qs.rewardsPerDay, expected), 'rewards are credited when someone stakes or unstakes'].filter(Boolean).join('; ') });
  }
  const qd = quick.perDay;
  const fd = full.perDay;
  const tokens = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  // Chance in what players get back a day: three standard errors of the boxes' prizes, averaged over the run.
  const boxSwing = (3 * Math.sqrt(full.boxes.reduce((n, b) => n + b.opens * openVariance(m, b.key, levels), 0))) / full.days;
  for (const t of tokens(qd.players.pay, fd.players.pay)) line(`players pay a day (${t})`, qd.players.pay[t] ?? 0, fd.players.pay[t] ?? 0, { unit: t });
  const shiftBy = {};
  for (const st of m.stakes) {
    const t = m.pool.get(st.rewards)?.currency;
    if (t) shiftBy[t] = (shiftBy[t] ?? 0) + (rewardsShift[st.key] ?? 0);
  }
  for (const t of tokens(qd.players.getBack, fd.players.getBack)) line(`players get back a day (${t})`, (qd.players.getBack[t] ?? 0) + (shiftBy[t] ?? 0), fd.players.getBack[t] ?? 0, { unit: t, noise: boxSwing + lumpy / full.days, ...(lumpy ? { why: 'lottery prizes arrive a round at a time' } : {}) });
  line('player fees a day', qd.players.playerFeesSol, fd.players.playerFeesSol, { unit: 'SOL' });
  line('players’ oracle fees a day', qd.players.oracleFeesSol, fd.players.oracleFeesSol, { unit: 'SOL' });
  line('players’ network fees a day', qd.players.networkFeesSol, fd.players.networkFeesSol, { unit: 'SOL' });
  // How many collectibles boxes roll is chance too.
  const rolled = full.boxes.reduce((n, b) => {
    const box = m.box.get(b.key);
    const w = weights(box);
    const total = w.reduce((a, x) => a + x, 0) || 1;
    const p = (box.outcomes ?? []).reduce((x, o, i) => x + (o.gives === 'item' ? w[i] / total : 0), 0);
    return n + b.opens * p * (1 - p);
  }, 0);
  line('players’ rent a day', qd.players.rentSol, fd.players.rentSol, { unit: 'SOL', noise: (3 * Math.sqrt(rolled) * (quick.fees?.collectibleRentSol ?? 0)) / full.days, why: 'measured: what each account really took, net of what came back; the quick simulation counts 0.0031 SOL a collectible and 0.00096 back for each one burned' });
  for (const t of tokens(qd.creator.treasury, fd.creator.treasury)) line(`treasury a day (${t})`, qd.creator.treasury[t] ?? 0, fd.creator.treasury[t] ?? 0, { unit: t });
  const draws = m.lotteries.reduce((n, l) => n + DAY / (toSeconds(l.every) || DAY), 0);
  line('the keeper’s oracle fees a day', qd.creator.oracleFeesSol, fd.creator.oracleFeesSol, { unit: 'SOL', noise: draws ? qd.creator.oracleFeesSol / Math.max(1, draws * full.days) : 0, ...(draws ? { why: 'one draw more or less inside the run' } : {}) });
  line('games.fun’s fees a day', qd.platform.totalSol, fd.platform.totalSol, { unit: 'SOL' });
  for (const t of tokens(qd.burned, fd.burned)) line(`burned a day (${t})`, qd.burned[t] ?? 0, fd.burned[t] ?? 0, { unit: t });
  for (const a of tokens(qd.accounts, fd.accounts)) line(`to ${a} a day`, qd.accounts[a] ?? 0, fd.accounts[a] ?? 0);
  return rows;
}

export { DAY };
