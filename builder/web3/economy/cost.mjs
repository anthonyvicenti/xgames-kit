// What an economy costs: going live (each account's rent, the program's fees, network fees, the seeds), and each
// action while it runs, for whoever signs it. In SOL unless a seed is in another token. Pure.
//
// Rent is (bytes + 128) × 5,080 lamports (model.mjs); the loot program's own accounts are sized byte for byte from
// its IDL, others (a Core collection, a token's name record) roughly, and marked so.
import { compile } from './compile.mjs';
import { ESCROW_LAMPORTS, FEES, LAMPORTS_PER_SOL, ORACLE_FEE, SIGNATURE_FEE, model, rent } from './model.mjs';
import { round } from './simulate.mjs';

const sol = (lamports) => round(Number(lamports) / Number(LAMPORTS_PER_SOL));
/** Loot instructions that charge the project fee (PROGRAM-0.3.md "The fee"). */
const PROJECT_FEE_IX = new Set(['deposit', 'payout', 'burn', 'issue', 'make', 'unmake', 'set', 'roll', 'award', 'open_contest', 'decide']);
/** Sizes of the accounts players and the authority open while the game runs (the program's state; stake.rs Position). */
const PLAY_ACCOUNTS = { Order: 325, Position: 98, Hold: 138, Entry: 75, TicketLine: 40 };

/** Setup cost from a compiled plan (compile.mjs). */
export function setupCost(plan, economy) {
  const m = model(economy);
  const accounts = [...plan.before, ...plan.transactions.flatMap((t) => t.steps)].flatMap((s) => s.creates ?? []).map((c) => ({ ...c, lamports: rent(c.bytes).toString(), sol: sol(rent(c.bytes)) }));
  const rentLamports = accounts.reduce((n, a) => n + BigInt(a.lamports), 0n);
  const charged = plan.transactions.flatMap((t) => t.steps).filter((s) => s.program === 'loot' && PROJECT_FEE_IX.has(s.ix));
  const feeLamports = BigInt(charged.length) * FEES.project;
  const networkLamports = plan.transactions.reduce((n, t) => n + BigInt(t.signers.length) * SIGNATURE_FEE, 0n);
  const seeds = {};
  let seedLamports = 0n;
  for (const p of m.pools) {
    if (!(Number(p.seed ?? 0) > 0)) continue;
    const t = m.tokens.get(p.currency);
    seeds[t.symbol] = round((seeds[t.symbol] ?? 0) + Number(p.seed));
    if (t.wsol) seedLamports += BigInt(Math.round(Number(p.seed) * 1e9));
  }
  const total = rentLamports + feeLamports + networkLamports + seedLamports;
  const notes = [];
  if (plan.before.length) notes.push(`${plan.before.map((s) => s.says).join(' ')} Its cost is the token launch’s own and is not counted here.`);
  if (accounts.some((a) => a.approx)) notes.push('Accounts marked “about” belong to other programs (Metaplex) and are sized roughly.');
  notes.push('The network fee is 5,000 lamports a signature; a wallet may add a priority fee of its own.');
  return {
    accounts,
    rentSol: sol(rentLamports),
    programFeesSol: sol(feeLamports),
    networkFeesSol: sol(networkLamports),
    seeds,
    totalSol: sol(total),
    transactions: plan.transactions.length,
    approvals: Math.max(1, Math.ceil(plan.transactions.filter((t) => t.signer === 'owner').length / 12)) + plan.transactions.some((t) => t.signer === 'authority'),
    notes,
  };
}

/**
 * What each action costs whoever signs it while the economy runs: games.fun's fee, the network's, and for anything
 * that asks MagicBlock's oracle for a random number (a box's open, a lottery's draw, the authority's `roll`) the
 * oracle's own 0.0005 SOL (`oracleSol`, model.mjs ORACLE_FEE).
 */
export function actionCosts(economy) {
  const m = model(economy);
  const rows = [];
  const row = (part, action, who, fee, deposits = [], extra, oracle = 0n) => rows.push({ part, action, who, feeSol: sol(fee), ...(oracle ? { oracleSol: sol(oracle) } : {}), networkSol: sol(SIGNATURE_FEE), deposits, ...(extra ? { note: extra } : {}) });
  const back = (what, lamports, when) => ({ what, sol: sol(lamports), back: when });
  const order = [back('the order', rent(PLAY_ACCOUNTS.Order), 'at settle or refund'), back('the escrow', ESCROW_LAMPORTS, 'at settle, less a collectible’s rent (about 0.004 SOL) when it gives one')];
  for (const it of m.items) if (Number(it.price ?? 0) > 0) row(`item:${it.key}`, `buy “${it.name}”`, 'player', FEES.player, order);
  for (const b of m.boxes) row(`box:${b.key}`, `open “${b.name}”`, 'player', FEES.player, order, 'The first buyer in each currency also opens the game’s vault for it (about 0.0015 SOL, kept).', ORACLE_FEE);
  for (const p of m.payments) row(`payment:${p.key}`, `pay “${p.name}”`, 'player', FEES.player);
  for (const r of m.recipes) {
    const made = (r.out ?? []).filter((l) => l.gives === 'item').length;
    row(`recipe:${r.key}`, `craft “${r.name}”`, 'player', FEES.player, made ? [back(`${made} new collectible${made > 1 ? 's' : ''}`, 4_000_000n * BigInt(made), 'never: it is the collectible’s own rent (about 0.004 SOL each)')] : []);
  }
  for (const l of m.lotteries) row(`lottery:${l.key}`, `buy tickets for “${l.name}”`, 'player', FEES.player, [back('a line in the ticket list', BigInt(PLAY_ACCOUNTS.TicketLine) * 5_080n, 'no: it goes to first place when the round ends')]);
  for (const s of m.stakes) {
    row(`stake:${s.key}`, `stake in “${s.name}”`, 'player', FEES.player, [back('the position', rent(PLAY_ACCOUNTS.Position), 'when they unstake everything')]);
    row(`stake:${s.key}`, `unstake from “${s.name}”`, 'player', FEES.player);
  }
  for (const h of m.holds) row(`hold:${h.key}`, `hand in for “${h.name}”`, 'player', FEES.player, [back('the hold', rent(PLAY_ACCOUNTS.Hold), 'when it ends')]);
  for (const c of m.contests) {
    row(`contest:${c.key}`, `back a side in “${c.name}”`, 'player', FEES.player, [back('the entry', rent(PLAY_ACCOUNTS.Entry), 'at claim')]);
    row(`contest:${c.key}`, `open “${c.name}”`, 'authority', FEES.project, [back('the contest and its pot', rent(1 + 32 + 4 + 1 + 32 + 32 + 8 + 8 + 32 + 1 + 1 + 4 + 8 + 8 + 4 + 4 + 8 * c.sides) + rent(165), 'when it closes')]);
    row(`contest:${c.key}`, `decide “${c.name}”`, 'authority', FEES.project);
  }
  for (const d of m.decisions) row(`decision:${d.key}`, d.when, 'authority', FEES.project, [], d.does === 'roll' ? 'The roll asks MagicBlock’s oracle, which takes its own fee from the authority.' : undefined, d.does === 'roll' ? ORACLE_FEE : 0n);
  if (m.boxes.length || m.items.length) row('orders', 'settle an order', 'anyone (the game’s keeper, or the player)', 0n);
  if (m.schedules.length) row('schedules', 'run a schedule when it is due', 'anyone', 0n);
  if (m.lotteries.length) {
    row('lotteries', 'ask for a draw', 'anyone (the game’s keeper, or a player)', 0n, [], 'The draw asks MagicBlock’s oracle for the winning numbers; the oracle takes its fee from whoever sends the draw.', ORACLE_FEE);
    row('lotteries', 'pay a place', 'anyone', 0n);
  }
  return rows;
}

/** Setup and play costs for a spec, or its refusals. */
export function cost(economy, { now = Math.floor(Date.now() / 1000), network = 'devnet' } = {}) {
  const plan = compile(economy, { now, network });
  if (!plan.ok) return plan;
  return { ok: true, setup: setupCost(plan, economy), actions: actionCosts(economy), fees: { playerSol: sol(FEES.player), projectSol: sol(FEES.project), oracleSol: sol(ORACLE_FEE) } };
}

/** The cost in plain words. */
export function explainCost(c) {
  const s = c.setup;
  const lines = [`Going live takes ${s.transactions} transaction${s.transactions === 1 ? '' : 's'} (${s.approvals} wallet approval${s.approvals === 1 ? '' : 's'}) and about ${s.totalSol} SOL:`];
  lines.push(`  rent ${s.rentSol} SOL for ${s.accounts.length} accounts; program fees ${s.programFeesSol} SOL; network fees ${s.networkFeesSol} SOL${Object.keys(s.seeds).length ? `; seeds ${Object.entries(s.seeds).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`);
  for (const a of s.accounts) lines.push(`  ${a.approx ? 'about ' : ''}${a.sol} SOL: ${a.what} (${a.bytes} bytes)`);
  lines.push('While it runs:');
  for (const r of c.actions) {
    const deposits = r.deposits.map((d) => `${d.sol} SOL for ${d.what} (back: ${d.back})`).join('; ');
    lines.push(`  ${r.action} (${r.who}): ${r.feeSol ? `${r.feeSol} SOL fee + ` : ''}${r.oracleSol ? `${r.oracleSol} SOL to the oracle + ` : ''}${r.networkSol} SOL network${deposits ? `; ${deposits}` : ''}${r.note ? `. ${r.note}` : ''}`);
  }
  for (const n of s.notes) lines.push(n);
  return lines.join('\n');
}
