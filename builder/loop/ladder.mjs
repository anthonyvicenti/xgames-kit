// The stop rule and the escalation ladder. A repair loop that repeats itself stops repeating and climbs:
//   model       the rounds from here run on the stronger model
//   specialist  one round per area the stuck set touches (art, sound, netcode, feel, code), each by a specialist brief
//   generate    paid generation for what a generator can make (models, pictures, sounds) in the stuck set
//   ask         questions for the creator; their answer re-enters at the ledger
// Cost never ends a build (the creator, 2026-10-13: "We rather spend $100,000 for a great game than $10 for something
// just ok"). There is no count of rounds: the stop rule ends repetition, and since the failing sets of one game are
// subsets of a finite list of gate measures and promises, a run that keeps finding new sets still ends.
//
// The stop rule, exactly: after a repair round, the result fails on the same set as the result before it, or on a set
// that came earlier in this ladder, or the round changed no file of the game and it still fails.
// Pure: the ladder is plain data kept in the loop's state, so a run picks it up after a restart.
import { RUNGS } from './order.mjs';

export const AREAS = ['art', 'sound', 'netcode', 'feel', 'code'];
/** What a generator can make: the generate rung applies only when the stuck set touches one of these. */
export const GENERATIVE = ['art', 'sound'];
/** A gate's area when the measure does not say its own (the runtime's measures may carry `area`). */
export const GATE_AREA = { A: 'art', B: 'code', C: 'feel', D: 'code', E: 'netcode', F: 'code', J: 'art' };
/** A promise's area when the tester could not see it. */
const PROMISE_AREA = { control: 'feel', loop: 'code', row: 'code', build: 'code' };

export const newLadder = () => ({ schema: 'gf-ladder/1', rung: null, sets: [], climbs: [], queue: [], strong: false });

/**
 * The failing set of one result: every failed gate measure, every refusal of a part's check, and every promise the
 * tester did not see or could not reach. verdict.failed: [{gate, measure, area?}]; parts: [{part, code}]; playtest
 * answers: {status} per promise id. → [{key, area}] sorted by key
 */
export function failingSet({ verdict = null, playtest = null, promises = [], parts = [] } = {}) {
  const items = [];
  for (const f of verdict?.failed ?? []) items.push({ key: `gate ${f.gate}:${f.measure}`, area: f.area ?? GATE_AREA[f.gate] ?? 'code' });
  // a part's check (parts.mjs): the economy checker's refusal codes, the backend check's
  for (const p of parts) items.push({ key: `part ${p.part}:${String(p.code).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40)}`, area: 'code' });
  const answers = playtest?.answers instanceof Map ? [...playtest.answers.entries()] : Object.entries(playtest?.answers ?? {});
  for (const [id, a] of answers) {
    if (a?.status === 'seen') continue;
    const p = promises.find(x => x.id === id);
    items.push({ key: `play ${id}:${a?.status}`, area: p?.area ?? (p?.look ? 'art' : PROMISE_AREA[p?.kind] ?? 'code') });
  }
  const seen = new Set();
  return items.filter(x => !seen.has(x.key) && seen.add(x.key)).sort((a, b) => a.key.localeCompare(b.key));
}
export const setKey = items => items.map(x => x.key).join('\n');

/** → 'repeat' | 'returned' | 'unchanged' | null, for the newest set against those before it. */
export function stopRule(sets, { unchanged = false } = {}) {
  const last = sets.at(-1);
  if (!last || !last.items.length) return null;
  const prev = sets.at(-2);
  if (unchanged && prev?.items.length) return 'unchanged';
  if (prev && prev.key === last.key) return 'repeat';
  if (sets.slice(0, -2).some(s => s.key === last.key)) return 'returned';
  return null;
}

/** The areas of a set, the most-touched first, then in AREAS order. */
export function areasOf(items) {
  const n = new Map();
  for (const x of items) n.set(x.area, (n.get(x.area) ?? 0) + 1);
  return [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || AREAS.indexOf(a) - AREAS.indexOf(b));
}

/**
 * Record one result (after a verify or a play-test that followed a repair round, or the first one). While the rung in
 * force still owes rounds (`queue`), its rounds run first and nothing climbs. → {ladder, stop, climbed: [rungs]}
 */
export function observe(ladder, items, { after, at = null, unchanged = false, round = null } = {}) {
  const L = structuredClone(ladder ?? newLadder());
  if (!items.length) { L.sets.push({ key: '', items: [], after, at, round }); return { ladder: L, stop: null, climbed: [] }; }
  L.sets.push({ key: setKey(items), items, after, at, round, ...(unchanged ? { unchanged: true } : {}) });
  const stop = L.queue.length ? null : stopRule(L.sets, { unchanged });
  if (!stop) return { ladder: L, stop: null, climbed: [] };
  const before = L.climbs.length;
  climb(L, items, stop, at);
  return { ladder: L, stop, climbed: L.climbs.slice(before).map(c => (c.skipped ? `${c.rung} (skipped)` : c.rung)) };
}

/** Climb one rung (two when the generate rung has nothing to make). Mutates and returns the ladder. */
export function climb(L, items, reason, at = null) {
  for (;;) {
    const next = RUNGS[RUNGS.indexOf(L.rung) + 1] ?? 'ask';
    L.rung = next;
    const areas = areasOf(items);
    if (next === 'model') { L.strong = true; L.queue = [{ kind: 'repair', strong: true }]; }
    if (next === 'specialist') L.queue = areas.map(area => ({ kind: 'specialist', area }));
    if (next === 'generate') {
      const make = areas.filter(a => GENERATIVE.includes(a));
      if (!make.length) { L.climbs.push({ rung: next, reason, set: setKey(items), at, skipped: `nothing in the stuck set is ${GENERATIVE.join(' or ')} a generator can make` }); continue; }
      L.queue = [{ kind: 'generate', areas: make }];
    }
    if (next === 'ask') L.queue = [{ kind: 'ask' }];
    L.climbs.push({ rung: next, reason, set: setKey(items), at, ...(next === 'specialist' ? { areas } : {}) });
    return L;
  }
}

/** The next round the ladder gives, taken off its queue: {kind: 'repair' | 'specialist' | 'generate' | 'ask', strong, area?, areas?}. */
export function nextRound(ladder) {
  const L = structuredClone(ladder ?? newLadder());
  const r = L.queue.shift() ?? { kind: 'repair' };
  return { ladder: L, round: { ...r, strong: !!(r.strong || L.strong || r.kind !== 'repair') } };
}

/**
 * Studio's progress keys (creator-studio/lib/ladder.mjs LADDER_SAY): the key a round is announced with, so Studio reads
 * the rung back from its timeline. A host passes `say(key, detail)`; detail is the structured equivalent.
 */
export const SAY = { build: 'building', repair: 'repairing', playRepair: 'playRepairing', model: 'rescuing', specialist: 'specialist', generate: 'generating', ask: 'asking' };
export function sayKeyOf(round, { after = 'verify', ladder = null } = {}) {
  if (round.kind === 'specialist') return SAY.specialist;
  if (round.kind === 'generate') return SAY.generate;
  if (round.kind === 'ask') return SAY.ask;
  if (round.strong && ladder?.climbs?.some(c => c.rung === 'model')) return SAY.model;
  return after === 'playtest' ? SAY.playRepair : SAY.repair;
}

/**
 * The numbers Studio's ladderRecord takes (creator-studio/lib/ladder.mjs), from the loop's state: rounds per rung,
 * whether the person was asked, and why the repair loop last stopped repeating itself.
 */
export function ladderRecordOf(S) {
  const rounds = S.rounds ?? [], climbs = [...(S.ladders ?? []), S.ladder].filter(Boolean).flatMap(l => l.climbs);
  return {
    repairs: rounds.filter(r => r.kind === 'repair').length,
    rescues: rounds.filter(r => r.kind === 'repair' && r.strong).length,
    rescueModel: rounds.some(r => r.strong) ? (S.models?.strong ?? 'strong') : null,
    specialist: rounds.filter(r => r.kind === 'specialist').length,
    generated: rounds.filter(r => r.kind === 'generate').length,
    asked: climbs.some(c => c.rung === 'ask' && !c.skipped),
    stop: climbs.at(-1)?.reason ?? null,
  };
}

/** The creator answered: the ladder starts again on the new plan, with its history kept. Stays on the stronger model. */
export const resetLadder = L => ({ ...newLadder(), strong: !!L?.strong });
