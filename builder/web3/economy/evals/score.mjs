#!/usr/bin/env node
// Scores economy specs against the frozen eval prompts in cases.json. Pure apart from reading files; no model call.
//
//   node builder/web3/economy/evals/score.mjs <folder> [--json] [--min 15] [--case e01-coin-flip-arena]
//   node builder/web3/economy/evals/score.mjs --references        (scores each case's own reference spec)
//
// <folder> holds one spec per case, named <id>.json (the economy section, or a whole gamesfun.json), or a game folder
// <id>/gamesfun.json. A case passes when its spec is valid, checks with no refusals, simulates and costs, and every
// one of its own checks holds. A check reads one of these lists:
//
//   tokens items pools boxes payments recipes schedules lotteries stakes contests holds decisions   the spec's parts
//   currency      the game's currency, as one token (source, program, mint, decimals, symbol, venue, powers)
//   warnings      the checker's warnings ({ code, where, message })
//   play          what runs while the game plays ({ part, ix, signer, says }, builder/web3/economy/steps.mjs playSteps)
//   actions       what each action costs whoever signs it (builder/web3/economy/cost.mjs actionCosts)
//   sim.boxes sim.items sim.recipes sim.lotteries sim.stakes sim.pools sim.schedules sim.payments sim.contests
//                 the quick simulation's rows (builder/web3/economy/simulate.mjs)
//
// Parts carry what they point at: `$token` (what an item, box, payment, contest or pool is priced or held in),
// `$stakes` and `$rewards` on a stake, `$pot` and `$ticket` on a lottery, `$pool` on a schedule or a decision.
//
// The checks:
//   { "some": <list>, "where": {...}, "atLeast": n }   at least n (1) entries match
//   { "none": <list>, "where": {...} }                 no entry matches
//   { "warns": "W-CODE" }                               the checker raises that warning
//   { "feeds": { "from": [lists], "into": "stake" | "lottery" | "pool", "percent": {...} } }
//        a part of `from` sends money into a stake's rewards pool, a lottery's pot or any pool: a split's share, a
//        recipe's payment, a schedule that issues or moves, a lottery's own tickets. `percent` matches a share's.
//
// `where` maps a path to a matcher. A path is dot-separated; `x[]` steps into each element of the list x; `.length`
// is a list's length. A path gives every value it reaches, and a matcher holds when any of them matches:
//   a plain value      equal (numbers as numbers, "7d" and 604800 as the same duration)
//   { "min", "max" }   a number in range (durations compare as seconds)
//   { "duration": "7d" } or { "duration": { "min": "6d", "max": "8d" } }
//   { "in": [...] }  { "not": v }  { "match": "regex" }  { "exists": true | false }
//   { "$sum": {...} }  the sum of every value reached; { "$count": {...} } how many values were reached
//   any other object   a `where` of its own, held by one element ("outcomes[]": { "gives": "pay", "chance": ... })
// `$all` and `$any` in a `where` take a list of wheres.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../check.mjs';
import { cost } from '../cost.mjs';
import { KINDS, destination, model, sharesOf, toSeconds } from '../model.mjs';
import { simulate } from '../simulate.mjs';
import { playSteps } from '../steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ECONOMY_DIR = path.resolve(HERE, '..');
export const CASES = JSON.parse(readFileSync(path.join(HERE, 'cases.json'), 'utf8')).cases;

/** A case's reference spec. */
export const referenceOf = (c) => JSON.parse(readFileSync(path.join(ECONOMY_DIR, c.reference), 'utf8'));

// ---------------------------------------------------------------- paths and matchers

/** Every value `pathText` reaches in `value`. */
export function valuesAt(value, pathText) {
  let at = [value];
  for (const seg of String(pathText).split('.')) {
    const many = seg.endsWith('[]');
    const name = many ? seg.slice(0, -2) : seg;
    const next = [];
    for (const v of at) {
      if (v === null || v === undefined) continue;
      if (name === 'length' && Array.isArray(v)) { next.push(v.length); continue; }
      const x = v[name];
      if (x === undefined) continue;
      if (many) { if (Array.isArray(x)) next.push(...x); } else next.push(x);
    }
    at = next;
  }
  return at;
}

const DURATION = /^\d+(\.\d+)?(s|m|h|d|w)$/;
const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const asSeconds = (v) => {
  try {
    return typeof v === 'number' || (typeof v === 'string' && DURATION.test(v)) ? toSeconds(v) : null;
  } catch {
    return null;
  }
};
function same(a, b) {
  if (a === b) return true;
  if ([a, b].some((x) => typeof x === 'string' && DURATION.test(x))) return asSeconds(a) !== null && asSeconds(a) === asSeconds(b);
  const x = asNumber(a), y = asNumber(b);
  return x !== null && y !== null && x === y;
}
const OPS = new Set(['min', 'max', 'in', 'not', 'match', 'exists', 'duration', '$sum', '$count', 'equals']);
const isOps = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).some((k) => OPS.has(k));

function inRange(v, { min, max }) {
  const durations = [min, max].some((b) => typeof b === 'string' && DURATION.test(b));
  const n = durations ? asSeconds(v) : asNumber(v);
  if (n === null) return false;
  const lo = min === undefined ? null : durations ? asSeconds(min) : Number(min);
  const hi = max === undefined ? null : durations ? asSeconds(max) : Number(max);
  return (lo === null || n >= lo - 1e-9) && (hi === null || n <= hi + 1e-9);
}

/** Does one value meet a matcher of operators? */
function one(v, m) {
  if ('equals' in m && !same(v, m.equals)) return false;
  if (('min' in m || 'max' in m) && !inRange(v, m)) return false;
  if ('in' in m && !m.in.some((x) => same(v, x))) return false;
  if ('not' in m && same(v, m.not)) return false;
  if ('match' in m && !new RegExp(m.match).test(String(v))) return false;
  if ('duration' in m) {
    const d = m.duration;
    if (d && typeof d === 'object') { if (!inRange(asSeconds(v) ?? NaN, { min: d.min !== undefined ? asSeconds(d.min) : undefined, max: d.max !== undefined ? asSeconds(d.max) : undefined })) return false; }
    else if (asSeconds(v) === null || asSeconds(v) !== asSeconds(d)) return false;
  }
  return true;
}

/** Does a list of values meet a matcher? */
export function matches(values, m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return values.some((v) => same(v, m));
  if (!isOps(m)) return values.some((v) => v && typeof v === 'object' && holds(v, m));
  if ('exists' in m && (values.length > 0) !== Boolean(m.exists)) return false;
  if ('$count' in m && !matches([values.length], m.$count)) return false;
  if ('$sum' in m && !matches([values.reduce((s, v) => s + (asNumber(v) ?? 0), 0)], m.$sum)) return false;
  const rest = Object.fromEntries(Object.entries(m).filter(([k]) => !['exists', '$count', '$sum'].includes(k)));
  if (!Object.keys(rest).length) return true;
  return values.some((v) => one(v, rest));
}

/** Does `entry` meet every condition of `where`? */
export function holds(entry, where = {}) {
  for (const [k, m] of Object.entries(where)) {
    if (k === '$all') { if (!m.every((w) => holds(entry, w))) return false; continue; }
    if (k === '$any') { if (!m.some((w) => holds(entry, w))) return false; continue; }
    if (!matches(valuesAt(entry, k), m)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- what a check reads

/** The lists a check reads, for a spec that checks clean. */
export function views(spec, { now, verdict } = {}) {
  const m = model(spec, { now });
  const pool = (key) => (m.pool.has(key) ? { ...m.pool.get(key), $token: m.poolToken(key) } : undefined);
  const tok = (key) => m.tokens.get(key);
  const extra = {
    items: (x) => ({ $token: m.priceToken(x) }),
    boxes: (x) => ({ $token: m.priceToken(x) }),
    payments: (x) => ({ $token: m.priceToken(x) }),
    contests: (x) => ({ $token: m.priceToken(x) }),
    pools: (x) => ({ $token: m.poolToken(x.key) }),
    stakes: (x) => ({ $stakes: tok(x.stakes), $rewards: pool(x.rewards) }),
    lotteries: (x) => ({ $pot: pool(x.pot), $ticket: tok(x.ticketCurrency ?? m.pool.get(x.pot)?.currency) }),
    schedules: (x) => ({ $pool: pool(x.pool ?? x.to), $token: tok(x.currency) ?? m.poolToken(x.pool ?? x.from) }),
    decisions: (x) => ({ $pool: pool(x.pool) }),
  };
  const lists = {};
  for (const list of Object.keys(KINDS)) lists[list] = (list === 'tokens' ? [...m.tokens.values()] : spec[list] ?? []).map((x) => ({ ...x, ...(extra[list]?.(x) ?? {}) }));
  lists.currency = m.currency ? [m.currency] : [];
  lists.warnings = (verdict ?? check(spec, { now })).warnings;
  lists.play = playSteps(spec);
  const sim = simulate(spec, { now });
  for (const k of ['boxes', 'items', 'payments', 'recipes', 'schedules', 'lotteries', 'stakes', 'contests', 'pools']) lists[`sim.${k}`] = sim[k] ?? [];
  const c = cost(spec, { now });
  lists.actions = c.ok ? c.actions : [];
  return { lists, model: m, sim, cost: c };
}

/** Every flow of money into a pool: { from, part, pool, percent? }. */
export function flows(spec) {
  const out = [];
  const shares = (from, part, split) => {
    for (const s of sharesOf(split)) if (s.kind === 'pool') out.push({ from, part: part.key, pool: s.key, percent: s.percent });
  };
  for (const list of ['items', 'boxes', 'payments', 'contests']) for (const x of spec[list] ?? []) shares(list, x, x.split);
  for (const r of spec.recipes ?? [])
    for (const line of r.in ?? []) {
      const d = line.takes === 'pay' && line.to ? destination(line.to) : null;
      if (d?.kind === 'pool') out.push({ from: 'recipes', part: r.key, pool: d.key });
    }
  for (const s of spec.schedules ?? []) {
    if (s.does === 'issue' && s.pool) out.push({ from: 'schedules', part: s.key, pool: s.pool });
    if (s.does === 'move' && s.to) out.push({ from: 'schedules', part: s.key, pool: s.to, percent: s.percent });
  }
  for (const l of spec.lotteries ?? []) if (!l.ticketCurrency) out.push({ from: 'lotteries', part: l.key, pool: l.pot, percent: 100 - Number(l.cutPercent ?? 0) });
  return out;
}

function feeds(spec, { from = [], into = 'pool', percent, where } = {}) {
  const targets =
    into === 'stake' ? (spec.stakes ?? []).map((s) => ({ pool: s.rewards, part: s }))
    : into === 'lottery' ? (spec.lotteries ?? []).map((l) => ({ pool: l.pot, part: l }))
    : (spec.pools ?? []).map((p) => ({ pool: p.key, part: p }));
  const wanted = new Set(targets.filter((t) => !where || holds(t.part, where)).map((t) => t.pool));
  return flows(spec).some((f) => (!from.length || from.includes(f.from)) && wanted.has(f.pool) && (!percent || (f.percent !== undefined && matches([f.percent], percent))));
}

// ---------------------------------------------------------------- scoring

const say = (ok, says, why) => ({ ok, says, ...(ok || !why ? {} : { why }) });

/** One spec against one case. → { id, pass, passed, total, checks: [{ ok, says, why? }] } */
export function scoreSpec(c, input, { now = Math.floor(Date.now() / 1000) } = {}) {
  const spec = input?.economy ?? input;
  const results = [];
  if (!spec || typeof spec !== 'object') {
    results.push(say(false, 'a spec', 'no spec was given'));
    return { id: c.id, pass: false, passed: 0, total: c.checks.length + 4, checks: results };
  }
  const verdict = check(spec, { now });
  const schema = verdict.refusals.filter((r) => r.code === 'E-SCHEMA');
  results.push(say(!schema.length, 'the spec is valid', schema.map((r) => r.message).slice(0, 3).join(' ')));
  results.push(say(verdict.ok, 'it checks with no refusals', verdict.refusals.map((r) => `${r.code} ${r.where}`).slice(0, 4).join('; ')));
  if (!verdict.ok) {
    for (const k of c.checks) results.push(say(false, k.says, 'not scored: the spec has refusals'));
    results.splice(2, 0, say(false, 'it simulates', 'not run: the spec has refusals'), say(false, 'it costs', 'not run: the spec has refusals'));
    return finish(c, results);
  }
  let v;
  try {
    v = views(spec, { now, verdict });
    results.push(say(true, 'it simulates'));
  } catch (e) {
    results.push(say(false, 'it simulates', e.message), say(false, 'it costs', 'not run'));
    for (const k of c.checks) results.push(say(false, k.says, 'not scored: the simulation failed'));
    return finish(c, results);
  }
  results.push(say(v.cost.ok, 'it costs', v.cost.ok ? '' : (v.cost.refusals ?? []).map((r) => r.code).join(', ')));
  for (const k of c.checks) results.push(runCheck(k, spec, v.lists));
  return finish(c, results);
}

function finish(c, results) {
  const passed = results.filter((r) => r.ok).length;
  return { id: c.id, pass: passed === results.length, passed, total: results.length, checks: results };
}

/** One check. → { ok, says, why? } */
export function runCheck(k, spec, lists) {
  if (k.some) {
    const list = lists[k.some];
    if (!list) return say(false, k.says, `unknown list ${k.some}`);
    const n = list.filter((x) => holds(x, k.where)).length;
    const want = k.atLeast ?? 1;
    return say(n >= want, k.says, `${n} of ${k.some} match${want > 1 ? `, ${want} wanted` : ''}`);
  }
  if (k.none) {
    const list = lists[k.none];
    if (!list) return say(false, k.says, `unknown list ${k.none}`);
    const n = list.filter((x) => holds(x, k.where)).length;
    return say(n === 0, k.says, `${n} of ${k.none} match`);
  }
  if (k.warns) return say(lists.warnings.some((w) => w.code === k.warns), k.says, `the checker does not raise ${k.warns}`);
  if (k.feeds) return say(feeds(spec, k.feeds), k.says, `nothing from ${(k.feeds.from ?? []).join(' or ') || 'any part'} flows into a${k.feeds.into === 'pool' ? '' : k.feeds.into === 'stake' ? ' stake’s rewards' : ' lottery’s pot'} pool${k.feeds.percent ? ' at that share' : ''}`);
  return say(false, k.says, 'a check needs some, none, warns or feeds');
}

/** A produced spec for a case in `dir`, or null. */
export function specIn(dir, id) {
  for (const p of [path.join(dir, `${id}.json`), path.join(dir, id, 'gamesfun.json')]) if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return null;
}

/** Scores a folder (or, with `references`, each case's reference). */
export function scoreAll({ dir = null, references = false, only = null, now } = {}) {
  const results = [];
  for (const c of CASES) {
    if (only && c.id !== only) continue;
    let spec = null;
    try {
      spec = references ? referenceOf(c) : specIn(dir, c.id);
    } catch (e) {
      results.push({ id: c.id, pass: false, passed: 0, total: c.checks.length + 4, checks: [say(false, 'a spec', `could not read it: ${e.message}`)] });
      continue;
    }
    results.push(spec ? scoreSpec(c, spec, { now }) : { id: c.id, pass: false, passed: 0, total: c.checks.length + 4, checks: [say(false, 'a spec', `no ${c.id}.json`)] });
  }
  return { passed: results.filter((r) => r.pass).length, of: results.length, results };
}

// ---------------------------------------------------------------- the command

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = args.find((a, i) => !a.startsWith('--') && !['--min', '--case'].includes(args[i - 1]));
  if (!dir && !flag('--references')) {
    console.error('Usage: node web3/economy/evals/score.mjs <folder> [--json] [--min 15] [--case <id>]\n       node web3/economy/evals/score.mjs --references');
    process.exit(2);
  }
  const r = scoreAll({ dir: dir ? path.resolve(dir) : null, references: flag('--references'), only: value('--case') });
  if (flag('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.results) {
      console.log(`${x.pass ? 'PASS' : 'FAIL'} ${x.id} (${x.passed}/${x.total})`);
      for (const k of x.checks) if (!k.ok) console.log(`     ✗ ${k.says}${k.why ? `: ${k.why}` : ''}`);
    }
    console.log(`\n${r.passed} of ${r.of} pass.`);
  }
  const min = value('--min');
  process.exit(min !== undefined && r.passed < Number(min) ? 1 : 0);
}
