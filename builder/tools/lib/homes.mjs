#!/usr/bin/env node
// Homes: where every rule lives (research/open-builder/HANDOFF.md section 4). One data file, tools/lib/homes.json,
// gives each verify check exactly one home, and each prompt rule of the build brief (builder/loop/brief.mjs RULES) its
// home and what enforces it:
//
//   invariant  true of every game whatever its kind; read by every build
//   part       belongs to one mechanic, world, loop, panel or runtime (homes.json names which); read only by builds
//              whose spec uses that part
//   game       a promise this one game makes; held by that game's own tests
//   nowhere    taste, an accident, or something the kit now prevents; nobody reads it
//
// tests/homes.test.mjs fails when a check or a rule has no home, when a tag names a rule that is gone, when a rule
// names no enforcer (builder/GATES.md: a rule with no enforcer becomes code or is deleted), and when the rules pass
// their budget (five). verify reads each check's `rule` and `fix` from here and prints them with a failing check, so
// the rule reaches the build agent when it applies.
//
//   node builder/tools/lib/homes.mjs            the summary, and every problem (exit 1 when there is one)
//   node builder/tools/lib/homes.mjs --lines    every prompt rule with its hash, its home and its enforcers
//   node builder/tools/lib/homes.mjs --json
//
// A rule is identified by a hash of its own text (sha256 of the trimmed rule, 12 hex characters), so the rule is never
// edited to carry a tag, and a reworded rule is a new rule that needs a home.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from './main.mjs';
import { MEASURES, MEASURES_OF } from './verdict.mjs';

export const HOMES_FILE = fileURLToPath(new URL('./homes.json', import.meta.url));
export const HOMES = ['invariant', 'part', 'game', 'nowhere'];

export const loadHomes = () => JSON.parse(readFileSync(HOMES_FILE, 'utf8'));
let cached = null;
/** A check's entry in homes.json ({name, home, part?, run, rule, fix}), or null. */
export function checkHome(n) { cached ??= loadHomes(); return cached.checks?.[String(n)] ?? null; }

/** Every measure verify can record, in any flow: a round's, a world's, a forge game's and a vista game's, the judges
 *  (none today: the play-tester is not a measure), and 9 (the contact sheet). Each is a measure inside one gate (tools/lib/verdict.mjs MEASURES). */
export const allChecks = () => [...new Set([...Object.values(MEASURES_OF).flat(), 9])].sort((a, b) => a - b);

export const lineHash = text => createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);

/**
 * Hold homes.json against the checks verify requires and the prompt rules as they are now (brief.mjs RULES).
 * → {ok, problems, summary: {checks: {home: count}, rules: {home: count}, budget, ruleCount}, lines}
 */
export function checkHomes(homes, rules, { checks = allChecks() } = {}) {
  const problems = [];
  const count = () => Object.fromEntries(HOMES.map(h => [h, 0]));
  const sum = { checks: count(), rules: count() };
  const tagOk = (t, what) => {
    if (!t) { problems.push(`${what} has no home (add it to tools/lib/homes.json: invariant, part, game or nowhere)`); return false; }
    if (!HOMES.includes(t.home)) { problems.push(`${what}: home "${t.home}" is not one of ${HOMES.join(', ')}`); return false; }
    if (t.home === 'part' && !t.part) { problems.push(`${what}: a part needs to say which part`); return false; }
    return true;
  };
  for (const n of checks) {
    const t = homes.checks?.[String(n)];
    if (!tagOk(t, `check ${n}`)) continue;
    sum.checks[t.home]++;
    for (const k of ['name', 'rule', 'fix']) if (!t[k]) problems.push(`check ${n} has no ${k} (verify prints the rule and the fix with a failing check)`);
    // its gate and its run are verdict.mjs MEASURES' (the pass rule's), never a second opinion
    const m = MEASURES[n];
    if (!m) problems.push(`check ${n} is no measure of tools/lib/verdict.mjs MEASURES`);
    else {
      if (t.gate !== m.gate) problems.push(`check ${n}: gate is "${t.gate}", and tools/lib/verdict.mjs MEASURES says "${m.gate}"`);
      if (n !== 9 && t.run !== m.run) problems.push(`check ${n}: run is "${t.run}", and tools/lib/verdict.mjs MEASURES says "${m.run}"`);
    }
  }
  for (const k of Object.keys(homes.checks ?? {})) if (!checks.includes(Number(k))) problems.push(`homes.json tags check ${k}, which verify does not require`);

  const tags = new Map();
  for (const t of homes.rules?.list ?? []) { if (tags.has(t.hash)) problems.push(`homes.json tags the rule ${t.hash} twice`); tags.set(t.hash, t); }
  const lines = (rules ?? []).map((text, i) => ({ rule: i + 1, hash: lineHash(text), text: String(text).trim() }));
  const rows = lines.map(l => {
    const t = tags.get(l.hash) ?? null, what = `rule ${l.rule} (${l.hash}: "${l.text.slice(0, 70)}…")`;
    if (tagOk(t, what)) {
      sum.rules[t.home]++;
      if (!Array.isArray(t.enforcedBy) || !t.enforcedBy.some(e => String(e ?? '').trim())) problems.push(`${what} names no enforcer: a rule nothing enforces becomes code or is deleted (builder/GATES.md)`);
    }
    return { ...l, home: t?.home ?? null, part: t?.part ?? null, enforcedBy: t?.enforcedBy ?? [] };
  });
  for (const [hash, t] of tags) if (!lines.some(l => l.hash === hash)) problems.push(`homes.json tags a rule that is no longer in ${homes.rules?.source?.split(':')[0] ?? 'builder/loop/brief.mjs RULES'} (${hash}: "${t.starts ?? ''}"): remove the tag, or give the reworded rule its home`);
  const budget = homes.rules?.budget?.rules;
  if (!Number.isInteger(budget)) problems.push('homes.json → rules.budget.rules is missing');
  else if (lines.length > budget) problems.push(`the brief has ${lines.length} prompt rules; the budget is ${budget}. A complaint becomes a regression on a gate or a spec default; a new rule means merging or removing one`);
  return { ok: problems.length === 0, problems, summary: { ...sum, budget, ruleCount: lines.length, checks: sum.checks, checkCount: checks.length }, lines: rows };
}

/** The prompt rules as the build brief carries them now. */
export async function currentRules() { return (await import('../../loop/brief.mjs')).RULES; }

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const homes = loadHomes();
  const r = checkHomes(homes, await currentRules());
  if (a.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    if (a.includes('--lines')) for (const l of r.lines) console.log(`${String(l.rule).padStart(2)} ${l.hash} ${(l.home ?? 'NO HOME').padEnd(9)} ${l.text.slice(0, 80)}\n${l.enforcedBy.map(e => `     enforced by: ${e}`).join('\n')}`);
    const s = r.summary, row = o => HOMES.map(h => `${h} ${o[h]}`).join(' · ');
    console.log(`checks (${s.checkCount}): ${row(s.checks)}`);
    console.log(`prompt rules (${s.ruleCount}): ${row(s.rules)} · budget ${s.ruleCount}/${s.budget}`);
    for (const p of r.problems) console.log(`PROBLEM ${p}`);
    console.log(r.ok ? 'homes: OK' : `homes: ${r.problems.length} problems`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
