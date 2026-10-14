// Scoring: the pass rules of paired/set.json, breadth/set.json and depth/set.json as code. Pure functions over the
// records, the readers' judgements and the scoresheets; they never read a file.
import { rng } from './blind.mjs';

const MARK = { kept: 1, partly: 0.5, lost: 0, 'cannot-tell': 0 };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

/** Intent kept for one run: the sum of the reader's marks over the case's core lines / the number of core lines. */
export function intentScore(ledger, judgement) {
  const core = ledger.filter(l => l.core);
  if (!core.length) throw Error('a ledger needs at least one core line');
  const marks = new Map((judgement?.ledger ?? []).map(m => [m.id, m.mark]));
  let sum = 0;
  for (const l of core) {
    const m = marks.get(l.id);
    if (!(m in MARK)) throw Error(`judgement ${judgement?.blindId ?? '?'} has no valid mark for core line ${l.id}`);
    sum += MARK[m];
  }
  return sum / core.length;
}

/** A judgement whose control is marked present is void: the bundle goes to a fresh reader. */
export const isVoid = j => j?.control?.mark === 'present';

/**
 * The paired gate. cases: {id: case}; records: [record]; judgements: {blindId: judgement}.
 * → {pass, intent: {old, new, wins, losses, ties, pass}, completion: {...}, multiplayer: {...}, perPrompt, missing, blinding}
 */
export function pairedResult({ cases, records, judgements, reps = 3, seed = 1 }) {
  const ids = Object.keys(cases).sort(), missing = [];
  const per = {}, all = { old: [], new: [] }, done = { old: 0, new: 0 }, mp = { old: 0, new: 0 }, guesses = { right: 0, wrong: 0, none: 0 };
  for (const id of ids) {
    per[id] = { old: [], new: [] };
    for (const arm of ['old', 'new']) for (let rep = 1; rep <= reps; rep++) {
      const r = records.find(x => x.case === id && x.arm === arm && x.rep === rep);
      if (!r) { missing.push(`${id}-${arm}-r${rep}: no record`); continue; }
      if (r.measures.completed.value) done[arm]++;
      if (r.measures.multiplayer.value) mp[arm]++;
      // A run that delivered nothing kept nothing; a delivered run needs its reader's marks.
      let score = 0;
      if (r.outcome.delivered) {
        const j = judgements[r.blindId];
        if (!j || isVoid(j)) { missing.push(`${r.runKey}: ${j ? 'judgement void (control present)' : 'no judgement'}`); continue; }
        score = intentScore(cases[id].ledger, j);
        const g = j.armGuess?.guess, truth = arm === 'old' ? 'older' : 'newer';
        if (g === 'older' || g === 'newer') guesses[g === truth ? 'right' : 'wrong']++; else guesses.none++;
      }
      per[id][arm].push(score); all[arm].push(score);
    }
  }
  const perPrompt = ids.map(id => ({ case: id, old: mean(per[id].old), new: mean(per[id].new) }));
  let wins = 0, losses = 0, ties = 0;
  for (const p of perPrompt) { if (p.new > p.old) wins++; else if (p.new < p.old) losses++; else ties++; }
  const intent = { old: mean(all.old), new: mean(all.new), wins, losses, ties };
  intent.pass = missing.length === 0 && intent.new > intent.old && wins > losses;
  const completion = { old: done.old, new: done.new, pass: missing.length === 0 && done.new >= done.old };
  const multiplayer = { old: mp.old, new: mp.new, pass: missing.length === 0 && mp.new >= mp.old };
  const guessed = guesses.right + guesses.wrong;
  return {
    pass: intent.pass && completion.pass && multiplayer.pass,
    complete: missing.length === 0, missing,
    intent, completion, multiplayer, perPrompt,
    interval90: bootstrap(perPrompt, seed),
    blinding: { ...guesses, rightShare: guessed ? guesses.right / guessed : null, weak: guessed > 0 && guesses.right / guessed > 0.75 },
  };
}

/** A bootstrap 90% interval of (new - old) mean intent, resampling prompts. Reported, never part of the gate. */
export function bootstrap(perPrompt, seed = 1, n = 10000) {
  const rows = perPrompt.filter(p => Number.isFinite(p.old) && Number.isFinite(p.new));
  if (!rows.length) return null;
  const r = rng(seed), diffs = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < rows.length; k++) { const p = rows[Math.floor(r() * rows.length)]; s += p.new - p.old; }
    diffs.push(s / rows.length);
  }
  diffs.sort((a, b) => a - b);
  return { low: diffs[Math.floor(0.05 * n)], high: diffs[Math.floor(0.95 * n)] };
}

/**
 * The breadth exit. records: [record] (first run, rep 1); judgements: {blindId: judgement}.
 * → {pass, faithfulDelivered, of, rows, missingParts: [{part, archetypes}]}
 */
export function breadthResult({ cases, records, judgements, need = 20 }) {
  const rows = [], missing = [];
  for (const id of Object.keys(cases).sort()) {
    const r = records.find(x => x.case === id && x.rep === 1);
    if (!r) { missing.push(`${id}: no record`); continue; }
    const j = r.outcome.delivered ? judgements[r.blindId] : null;
    if (r.outcome.delivered && (!j || isVoid(j))) { missing.push(`${id}: ${j ? 'judgement void' : 'no judgement'}`); continue; }
    const outcome = r.outcome.delivered ? j.outcome : 'refused';
    if (outcome === 'faithful' && j.musts.some(m => m.mark !== 'present')) throw Error(`${id}: faithful with a must not present`);
    if (outcome === 'something-else' && !(j.missingParts?.length)) throw Error(`${id}: something-else names no missing part`);
    rows.push({ case: id, archetype: cases[id].archetype?.id, outcome, withoutRescue: r.outcome.delivered && !r.outcome.rescue, missingParts: j?.missingParts ?? [], why: outcome === 'refused' ? r.outcome.lastWords : undefined });
  }
  const count = new Map();
  for (const row of rows) for (const part of row.missingParts) count.set(part, [...(count.get(part) ?? []), row.archetype ?? row.case]);
  const missingParts = [...count].map(([part, archetypes]) => ({ part, archetypes })).sort((a, b) => b.archetypes.length - a.archetypes.length || a.part.localeCompare(b.part));
  const faithfulDelivered = rows.filter(r => r.outcome === 'faithful' && r.withoutRescue).length;
  return { pass: missing.length === 0 && faithfulDelivered >= need, complete: missing.length === 0, missing, faithfulDelivered, of: Object.keys(cases).length, need, rows, missingParts };
}

/**
 * One depth slot's blind score. sheets: scoresheets with game opened ('ours' | 'reference') after the session's seal.
 * → {measures: {name: {gap, ours, reference, withinReach}}, withinReach: n, players, knowers}
 */
export function depthResult(sheets, { measures = ['clarity', 'feel', 'look', 'again'], reach = -1, without = false } = {}) {
  const use = without ? sheets.filter(s => !s.knowsReference) : sheets;
  const players = [...new Set(use.map(s => s.player))];
  const out = {};
  for (const m of measures) {
    const gaps = [], ours = [], ref = [];
    for (const p of players) {
      const o = use.find(s => s.player === p && s.game === 'ours'), r = use.find(s => s.player === p && s.game === 'reference');
      if (!o || !r) throw Error(`player ${p} needs one sheet for each game`);
      gaps.push(o.scores[m] - r.scores[m]); ours.push(o.scores[m]); ref.push(r.scores[m]);
    }
    const gap = mean(gaps);
    out[m] = { gap, ours: mean(ours), reference: mean(ref), withinReach: gap >= reach };
  }
  const within = Object.values(out).filter(x => x.withinReach).length;
  return { measures: out, withinReach: within, blindPass: within >= 3, players: players.length, knowers: sheets.filter(s => s.knowsReference).length / 2 };
}

/** A locked spec against a case's foundation: → problems ([] when every answer is accepted). */
export function checkFoundation(spec, foundation) {
  const p = [], at = foundation.at ?? {}, acc = foundation.accept ?? {};
  const get = ptr => ptr.split('/').slice(1).reduce((v, k) => v?.[k], spec);
  for (const [key, allowed] of Object.entries(acc)) {
    const v = get(at[key] ?? `/${key}`);
    if (key === 'profile' && v === undefined) continue; // a runtime without profiles has none to check
    if (!allowed.includes(v)) p.push(`${key} is ${JSON.stringify(v)}; the case accepts ${allowed.join(', ')}`);
  }
  return p;
}
