// The full simulation: the real loot program 0.3 in LiteSVM, with synthetic players doing the scenario's actions
// through the in-game kit's own calls for D days, and its numbers beside the quick simulation's.
//
//   const r = await simulateFull(economy, { players: 20, days: 7 });
//   r.mode       'full', or 'quick' when the full one could not run (r.why says why: offline with an empty cache,
//                no LiteSVM for this system, ...); then r.quick is all there is
//   r.full       what the program did, in the quick simulation's shape (report.mjs measure)
//   r.quick      the quick simulation at the rates the run achieved (r.rates), over the same days
//   r.compare    the two side by side, each row flagged when the difference is beyond chance and TOLERANCE
//   r.notes      what the run used (which program bytes, LiteSVM, the oracle) and what it could not play
//
// Needs devnet once (the programs and a few accounts, then cached; cache.mjs) and LiteSVM (installed into the cache on
// first use). Nothing is signed with a real key and nothing is sent to any network.
import { simulate } from '../simulate.mjs';
import { model } from '../model.mjs';
import { specOf } from '../../node/economy.mjs';
import { cacheDir, devnetAccounts, loadLiteSVM, simBinaries } from './cache.mjs';
import { asPlayed, compare, measure, TOLERANCE } from './report.mjs';
import { externalAddresses, runFull } from './run.mjs';

const ORACLE_NOTE =
  'MagicBlock’s oracle cannot run locally: each random number was answered at once by the loot program’s own callback, signed by the VRF identity it checks, with randomness from the run’s seed (the program’s own LiteSVM tests do the same). Its fee was charged by the real VRF program as on devnet.';

/** Everything the full simulation needs, or why it cannot have it: { ok, LiteSVM, bins, externals, notes } | { ok: false, why }. */
export async function prepareFull(economy, { dir = cacheDir(), offline = false, install = true, program, log = () => {} } = {}) {
  try {
    const { LiteSVM, Rent, from } = await loadLiteSVM({ dir, install: install && !offline, log });
    const bins = await simBinaries({ dir, offline, program });
    const externals = await devnetAccounts(externalAddresses(economy), { dir, offline });
    return { ok: true, LiteSVM, Rent, bins, externals, notes: [`LiteSVM from ${from}.`, ...bins.notes] };
  } catch (error) {
    return { ok: false, why: error.message };
  }
}

/** The quick simulation of `economy` over `days` at these rates a day. */
const quickAt = (economy, { days, perDay, now }) => simulate({ ...economy, scenario: { ...(economy.scenario ?? {}), days, ...(perDay ? { perDay } : {}) } }, { now });

export async function simulateFull(economy, { players = 20, days, seed = 'gamesfun', tolerance = TOLERANCE, dir, offline = false, install = true, program, log = () => {}, now = Math.floor(Date.now() / 1000), prepared } = {}) {
  const spec = specOf(economy);
  const D = Number(days ?? model(spec).scenario.days ?? 30);
  const ready = prepared ?? (await prepareFull(spec, { dir, offline, install, program, log }));
  if (!ready.ok) {
    return { mode: 'quick', why: `The full simulation could not run: ${ready.why} This is the quick simulation alone.`, quick: quickAt(spec, { days: D, now }), notes: [] };
  }
  const started = Date.now();
  const run = await runFull(spec, { LiteSVM: ready.LiteSVM, Rent: ready.Rent, bins: ready.bins, externals: ready.externals, players, days: D, seed, start: now, log });
  const full = measure(run);
  const played = asPlayed(full, spec);
  const rates = played.scenario.perDay;
  const quick = simulate(played, { now });
  const rows = compare(quick, full, run.live, { tolerance });
  const short = Object.entries(full.counts).filter(([, c]) => c.wanted && c.done < c.wanted);
  const notes = [
    ...ready.notes,
    ORACLE_NOTE,
    `${players} players over ${D} days, seed "${seed}": ${full.transactions} transactions in ${((Date.now() - started) / 1000).toFixed(1)} s. The quick simulation beside it is run at the rates the players achieved.`,
    ...short.map(([label, c]) => `${label}: ${c.done} of the ${c.wanted} the scenario asks for happened${c.refused ? ` (refused: ${Object.entries(c.refused).map(([why, n]) => `${n} × ${why}`).join('; ')})` : ''}.`),
    ...full.notPlayed.map((x) => `${x.label} was not played: ${x.why}.`),
  ];
  return { mode: 'full', days: D, players, seed, rates, full, quick, compare: rows, flagged: rows.filter((r) => r.flag), notes };
}

/** The comparison in plain words. */
export function explainFull(result) {
  if (result.mode !== 'full') return result.why;
  const lines = [`Full simulation: the real loot program in LiteSVM, ${result.players} players, ${result.days} days.`];
  const width = Math.max(...result.compare.map((r) => r.what.length), 10);
  lines.push(`${'what'.padEnd(width)}  ${'quick'.padStart(14)}  ${'full'.padStart(14)}  difference`);
  for (const r of result.compare) lines.push(`${r.what.padEnd(width)}  ${String(r.quick).padStart(14)}  ${String(r.full).padStart(14)}  ${r.difference}${r.unit ? ` ${r.unit}` : ''}${r.flag ? '  <- differs' : ''}`);
  lines.push(result.flagged.length ? `${result.flagged.length} number(s) differ by more than chance and ${TOLERANCE * 100}% allow.` : `Every number agrees within chance and ${TOLERANCE * 100}%.`);
  for (const r of result.flagged) if (r.why) lines.push(`  ${r.what}: ${r.why}.`);
  for (const p of result.full.pools) if (p.emptyOnDay !== undefined) lines.push(`Pool “${p.key}” was empty at the end of day ${p.emptyOnDay}.`);
  for (const n of result.notes) lines.push(n);
  return lines.join('\n');
}
