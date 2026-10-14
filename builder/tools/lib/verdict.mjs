// verify's pass rule (CONTRACT §5; builder/GATES.md), on its own so a unit test can hold it
// (gf-three/regressions/verdict-rule).
//
// Verify judges a game by six GATES, each a question about the player's experience. A gate is made of MEASURES (the
// old numbered checks, regrouped, plus the general measures 12, 38 and 39); a measure belongs to exactly one gate, and
// keeps its number, which `verify --check N` takes as an alias and every reader of verdict.json (`checks[].n`) still
// reads. A gate fails when any of its measures fails; the verdict passes when every gate this run requires passes.
//
//   A Integrity        the kit untouched (against the kit's release), every visible thing a slot, every slot's file there
//                      and valid
//   B Health           boots to play with no errors or refusals, at an acceptable frame cost; the kit's own pages work
//   C Cause → effect   every input and every event the kit logs shows on the screen of the player it concerns, soon, and
//                      control comes back within fair.downSeconds
//   D The loop closes  a round can be won or lost, ends and replays, and every score change comes from a counted event
//   E Shared truth     every player sees every other where they are; each player's own values are theirs
//   F Matches the spec the game is what its locked spec says (world, looks, hits per kill, its own tests)
//   J Judges           advisory: they give repair rounds and findings, never a failed verdict (23, the play-tester)
//
// A measure's `run`: 'build' (every verify), 'release' (the kit's own tests: `verify --release`, which regress.mjs
// --corpus passes; a build's verify neither runs nor requires them), 'full' (9, the contact sheet: counts only when it
// ran) or 'advisory' (a judge).
//
// Twice a change to verify broke the old rule while every check still read "ok" (2067b7c37: "exactly 9 core checks"
// after check 11 was wired). The rule names its measures, and adding one means adding it to MEASURES and to the kind's
// list here and a row to CONTRACT §5 (tests/r-regressions.test.mjs compares the two).

/** The six gates, and the judges (advisory). The order is the order verify prints them in. */
export const GATES = [
  { id: 'A', name: 'Integrity', question: 'Is the kit untouched (its hashes are the kit release\'s, never a list inside the game), is every visible thing a slot, and does every file a slot names exist and pass its own validator?' },
  { id: 'B', name: 'Health', question: 'Does it boot to play with no errors or kit refusals, at an acceptable frame cost, and do the kit\'s own pages (menu, wallet, a post, every screen) work?' },
  { id: 'C', name: 'Cause → effect', question: 'Does every input and every event the kit logs (a hit, a kill, a pickup, a spawn, a sound) produce something the player it concerns can see or hear on their own screen, soon, and does control come back within the spec\'s fair.downSeconds?' },
  { id: 'D', name: 'The loop closes', question: 'Can a round be won or lost, does it end and replay, and does every score change come from a counted event in the kit\'s log (never a number that only ticks)?' },
  { id: 'E', name: 'Shared truth', question: 'Does every player see every other player where they really are, and does each player\'s own value (score, colour, loadout, name) belong to that player?' },
  { id: 'F', name: 'Matches the spec', question: 'Is the game what its locked spec and promises say: world size and completeness, a body per role, hits per kill, the game\'s own tests?' },
];
export const JUDGES = { id: 'J', name: 'Judges (advisory)', question: 'What does a judge that looks say? Findings and repair rounds, never a failed verdict.', advisory: true };
export const GATE_IDS = [...GATES.map(g => g.id), JUDGES.id];
export const gateInfo = id => GATES.find(g => g.id === id) ?? (id === JUDGES.id ? JUDGES : null);

/**
 * Every measure verify can record, by its number: which gate it answers, its short name, and when it runs. The runtimes'
 * own measures (26–30 a world's, 32–33 forge's, 36–37 vista's) sit in the gate whose question they answer.
 */
export const MEASURES = {
  1: { gate: 'A', name: 'manifests', run: 'build' },
  2: { gate: 'A', name: 'kit copies unedited', run: 'build' },
  4: { gate: 'A', name: 'slot coverage 100%', run: 'build' },
  8: { gate: 'A', name: 'swap proof', run: 'release' },
  18: { gate: 'A', name: 'sounds listed', run: 'build' },
  19: { gate: 'A', name: 'bodies hold their shape', run: 'build' },
  3: { gate: 'B', name: 'boots to play with no console errors', run: 'build' },
  9: { gate: 'B', name: 'contact sheet and perf', run: 'full' },
  20: { gate: 'B', name: 'the menu works', run: 'release' },
  22: { gate: 'B', name: 'the wallet in the menu', run: 'release' },
  24: { gate: 'B', name: 'plays inside a post', run: 'release' },
  31: { gate: 'B', name: 'sharp on every screen', run: 'release' },
  32: { gate: 'B', name: 'no WebGPU: the open-in-your-browser screen', run: 'build' },
  33: { gate: 'B', name: 'a lost GPU device is recovered', run: 'build' },
  36: { gate: 'B', name: 'the sea is drawn and moving', run: 'build' },
  7: { gate: 'C', name: 'audio gate (heard, not too loud)', run: 'release' },
  10: { gate: 'C', name: 'fair play: control comes back', run: 'build' },
  13: { gate: 'C', name: 'controls work', run: 'build' },
  15: { gate: 'C', name: 'the loop is alive', run: 'build' },
  16: { gate: 'C', name: 'hits read', run: 'build' },
  21: { gate: 'C', name: 'the HUD shows your state', run: 'release' },
  30: { gate: 'C', name: 'phones', run: 'build' },
  38: { gate: 'C', name: 'every event answered', run: 'build' },
  6: { gate: 'D', name: 'a round reaches results and replays', run: 'build' },
  12: { gate: 'D', name: 'scores come from counted events', run: 'build' },
  26: { gate: 'D', name: 'the world persists', run: 'build' },
  5: { gate: 'E', name: 'two-player live gate', run: 'build' },
  25: { gate: 'E', name: 'playing with friends', run: 'build' },
  27: { gate: 'E', name: 'the host leaves and the world is kept', run: 'build' },
  28: { gate: 'E', name: 'the spawn square holds', run: 'build' },
  29: { gate: 'E', name: 'sign words are filtered', run: 'build' },
  34: { gate: 'E', name: 'watch then play', run: 'release' },
  11: { gate: 'F', name: 'set dressing', run: 'build' },
  14: { gate: 'F', name: 'looks honoured', run: 'build' },
  17: { gate: 'F', name: 'the world is complete', run: 'build' },
  35: { gate: 'F', name: 'the game\'s own tests', run: 'build' },
  37: { gate: 'F', name: 'the look is the config\'s', run: 'build' },
  39: { gate: 'F', name: 'hits per kill as the spec says', run: 'build' },
  23: { gate: 'J', name: 'looks like the references', run: 'advisory' },
};
export const gateOf = n => MEASURES[n]?.gate ?? null;
export const isAdvisory = n => MEASURES[n]?.run === 'advisory';

/** The measures each kind of game records (9 aside, which counts only when it ran). */
export const MEASURES_OF = {
  // a round game (party, scenic, flat): 38 (every event answered) and 39 (hits per kill as the spec says) since the gates
  round: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 34, 35, 38, 39],
  // a world (CONTRACT §9, tools/verify-world.mjs): no rounds, so 6, 10, 12, 15, 16, 17 and 23 have a world's equivalents
  // instead (26 persists, 27 the host leaves, 28 the spawn square holds, 29 sign words, 30 phones)
  world: [1, 2, 3, 4, 5, 7, 8, 11, 13, 14, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 34],
  // the forge runtime (runtimes/CONTRACT.md §7, tools/verify-forge.mjs): every round measure through the observation
  // (12, 35, 38 and 39 since the runtimes stream, 2026-10-13: the core's events in the kit's event log, stepped time,
  // forge's hits per kill), and forge's own 32 (one core, two builds; no WebGPU) and 33 (a lost GPU device is recovered)
  forge: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35, 38, 39],
  // the vista runtime (CONTRACT §8 vista, tools/verify-vista.mjs): what applies today, and vista's own 32, 36 and 37;
  // 31 too (its vista leg: one page at pixel ratio 2), which a vista build runs (releaseOnlyFor); everything else is
  // NOT_YET_VISTA with its reason
  // (4, 12, 35 and 38 since the runtimes stream, 2026-10-13: the core's files are slots and what it draws is tagged by
  // the module that added it; the game's events in the kit's event log; stepped time; 34 since godot-phone gave vista
  // Go live and voice through gf/mp, 2026-10-13)
  vista: [1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 17, 18, 20, 21, 23, 25, 31, 32, 34, 35, 36, 37, 38],
};

/** The measures of a release run that must pass: the kind's list less the advisory judges. A build's: less RELEASE_ONLY. */
const strict = list => list.filter(n => !isAdvisory(n));
/** Every measure a round game's release run requires (regress.mjs --corpus; verify --release). */
export const REQUIRED = strict(MEASURES_OF.round);
export const REQUIRED_WORLD = strict(MEASURES_OF.world);
export const REQUIRED_FORGE = strict(MEASURES_OF.forge);
export const REQUIRED_VISTA = strict(MEASURES_OF.vista);

/**
 * The kit's own tests (GATES.md): no rules.js or config a build agent writes can fail them short of sabotaging a
 * kit-owned page (research/game-templates/ai-studios-2026-10-10/findings/verify-our-numbers.md, claim 2; the creator's
 * question 18, 2026-10-11; the gates decision, 2026-10-12): 7 the bus loudness, 8 the swap proof, 20–22 the menu, HUD and
 * wallet, 24 a post, 31 sharp screens, 34 watch then play. They run per release (verify --release, which regress.mjs
 * --corpus passes), and a build's own verify neither runs nor requires them. Their home in tools/lib/homes.json has run
 * "release". 2 and 25 stay in every build: a game can fail both.
 */
export const RELEASE_ONLY = Object.keys(MEASURES).map(Number).filter(n => MEASURES[n].run === 'release').sort((a, b) => a - b);

/** What cannot apply to a forge game yet, and why: recorded "not yet for forge" (ok: null), never counted as passed. */
export const NOT_YET_FORGE = {
  mechanics: 'this mechanic has no forge implementation yet (components/<id>/impl/forge); its params stay in config/game.json for the rules',
};

/** What cannot apply to a vista game yet, and why: n → [name, why]. Recorded "not yet for vista" (ok: null). */
export const NOT_YET_VISTA = {
  7: ['audio gate v4', 'the core\'s soundscape now plays through gf-audio\'s sfx bus (gf/vista/kit/audio.js, core patch #2) and passed the gate in its sandbox (tools/fish-loop.mjs), but verify\'s gate run is not wired for vista yet'],
  8: ['swap proof', 'the core\'s files are slots now (kit/core-files.js), but the swap leg (a stall prop\'s picture replaced through the overrides, on screen) is not written for vista yet; check 37 swaps a look value'],
  9: ['contact sheet and perf', 'the capture tool (lookdev/capture.mjs) drives three.js scenes; a vista capture with frame times per tier is PLAN wave 5'],
  10: ['fair play', 'nothing in a vista game can knock or hurt a player'],
  11: ['set dressing', 'each island\'s props are its place\'s own (its words lay out the village, the harbour and the beach); nothing is placed from spec.world.props'],
  16: ['hits read', 'nothing is hit in a vista game'],
  19: ['bodies hold their shape', 'the friends\' bodies are library bodies the model judge already passed; the core\'s own skinning was held to rig.js by tools/humanoid-fixture.mjs in wave 1, not by verify yet'],
  22: ['the wallet in the menu', 'a player\'s loadout (an item\'s colour on their body) is not drawn on vista bodies yet'],
  24: ['plays inside a post', 'a vista game is never offered for a post on X (WebGPU only, desktop)'],
  33: ['a lost device is recovered', 'the vista core does not recover from a lost GPU device yet'],
  39: ['hits per kill as the spec says', 'nothing is hit in a vista game'],
};

const LISTS = { round: REQUIRED, world: REQUIRED_WORLD, forge: REQUIRED_FORGE, vista: REQUIRED_VISTA };
/** RELEASE_ONLY for a kind of game. A vista build runs measure 31 too: one page at pixel ratio 2, and the creator's
 *  complaint (2026-10-12: a vista game drawn at a quarter of the screen's pixels looked "much much worse"). */
export const releaseOnlyFor = kind => (kind === 'vista' ? RELEASE_ONLY.filter(n => n !== 31) : RELEASE_ONLY);
/** The measures a verify of this kind of game must run and pass: a build's (the list less its release-only) or a release's. */
export function requiredFor(kind = 'round', { release = false } = {}) {
  const all = LISTS[kind] ?? REQUIRED;
  return release ? all : all.filter(n => !releaseOnlyFor(kind).includes(n));
}
/** Every measure this kind of game records in this run: the required ones, the judges, and 9 (counts when it ran). */
export function measuresFor(kind = 'round', { release = false } = {}) {
  const all = MEASURES_OF[kind] ?? MEASURES_OF.round;
  return [...new Set([...all.filter(n => release || !releaseOnlyFor(kind).includes(n)), ...(kind === 'vista' ? [] : [9])])].sort((a, b) => a - b);
}
/** Is measure n run in this verify? Every measure in a release run; in a build's run all but the kind's release-only. */
export const runsHere = (n, { release = false, kind = 'round' } = {}) => release || !releaseOnlyFor(kind).includes(n);
/** The measures of one gate this run makes (`verify --gate C`; with --release its kit tests too). */
export function gateMeasures(kind, gate, { release = false } = {}) {
  return measuresFor(kind, { release }).filter(n => gateOf(n) === gate && (kind !== 'vista' || !(n in NOT_YET_VISTA)) && (kind !== 'forge' || !(n in NOT_YET_FORGE)));
}

/** A check that counts for the verdict: not the contact sheet (9: only when it ran), not a judge, not "not yet". */
const counts = c => c.n !== 9 && !isAdvisory(c.n) && !c.notYet;

/**
 * The pass rule. checks: [{n, ok}] as verify records them (ok true | false | null for skipped). → true when every
 * required measure ran and passed, no other counted measure failed or was skipped, and 9 (the contact sheet) did not
 * fail: it counts only when it ran (--quick skips it, which is ok: null). A judge (23) never fails the verdict, and a
 * "not yet for <runtime>" measure (ok: null, notYet) never counts as passed or failed.
 */
export function passes(checks, required = REQUIRED) {
  const core = checks.filter(counts);
  return required.every(n => core.some(c => c.n === n && c.ok === true)) && core.every(c => c.ok === true) && checks.filter(c => c.n === 9).every(c => c.ok !== false);
}
/** The forge and vista pass rules are the same rule (a not-yet measure is ok: null with `notYet`, never counted). */
export const passesForge = (checks, required = REQUIRED_FORGE) => passes(checks, required);
export const passesVista = (checks, required = REQUIRED_VISTA) => passes(checks, required);

/**
 * The verdict by gate: for each gate (and the judges) that this run touched, whether it passed, which of its measures
 * ran, and the failing ones. A gate passes when every measure of it this run requires passed and none failed (9 counts
 * only when it ran; the judges never fail). → [{gate, name, question, ok, advisory?, required: [n], measures: [{n, name,
 * ok, run}], failed: [n], missing: [n]}]
 */
export function gateVerdicts(checks, required = REQUIRED) {
  const out = [];
  for (const g of [...GATES, JUDGES]) {
    const mine = checks.filter(c => gateOf(c.n) === g.id);
    const req = required.filter(n => gateOf(n) === g.id);
    if (!mine.length && !req.length) continue;
    const failed = mine.filter(c => c.ok === false).map(c => c.n);
    const missing = req.filter(n => !mine.some(c => c.n === n && c.ok === true) && !failed.includes(n));
    const skipped = mine.filter(c => c.ok === null && counts(c)).map(c => c.n);
    const ok = g.advisory ? !failed.length : !failed.length && !missing.length && !skipped.filter(n => req.includes(n)).length;
    out.push({ gate: g.id, name: g.name, question: g.question, ok, ...(g.advisory ? { advisory: true } : {}), required: req,
      measures: mine.map(c => ({ n: c.n, name: c.name, ok: c.ok, run: MEASURES[c.n]?.run ?? 'build', ...(c.notYet ? { notYet: true } : {}) })), failed, missing });
  }
  // a measure no gate claims (a number verify does not know) fails as it always did: it shows as its own row
  const stray = checks.filter(c => !gateOf(c.n));
  if (stray.length) out.push({ gate: '?', name: 'measures no gate claims', question: 'a check verify does not know', ok: stray.every(c => c.ok !== false), required: [], measures: stray.map(c => ({ n: c.n, name: c.name, ok: c.ok })), failed: stray.filter(c => c.ok === false).map(c => c.n), missing: [] });
  return out;
}

/**
 * One gate's words as one line: each failing measure as "[n name] detail" (what a regression's details match), or with
 * `all` every measure of the gate (a warning lives in a passing measure's detail).
 */
export function gateDetail(gate, checks, { all = false } = {}) {
  return checks.filter(c => gateOf(c.n) === gate && (all || c.ok === false)).map(c => `[${c.n} ${c.name}] ${c.detail ?? ''}`).join(' | ');
}

/**
 * Stamp a verdict: each check its gate, the gate verdicts, the required list and the pass. `list` is a --check or
 * --gate run (it passes when each measure asked for passed: 9 may be skipped). Shared by every kind's flow.
 */
export function stampVerdict(rec, { kind = 'round', release = false, list = null } = {}) {
  for (const c of rec.checks) { const g = gateOf(c.n); if (g) c.gate = g; }
  rec.checks.sort((a, b) => (typeof a.n === 'number' ? a.n : 99) - (typeof b.n === 'number' ? b.n : 99));
  rec.required = requiredFor(kind, { release });
  if (list) {
    const asked = [].concat(list);
    rec.pass = asked.every(n => rec.checks.some(c => c.n === n && (c.ok === true || (n === 9 && c.ok === null) || (c.notYet && c.ok === null) || (isAdvisory(n) && c.ok !== undefined)))) && rec.checks.every(c => c.ok !== false || isAdvisory(c.n));
    rec.gates = gateVerdicts(rec.checks, rec.required.filter(n => asked.includes(n)));
  } else {
    rec.pass = passes(rec.checks, rec.required);
    rec.gates = gateVerdicts(rec.checks, rec.required);
  }
  return rec;
}

/**
 * A profiled run (verify --profile <file>, e.g. a CI runner with no graphics card) skips measures by number and reason.
 * It can be green for what it ran and is never a pass: `passes` stays false while a required measure is skipped.
 * → true when every required measure that was not skipped by the profile ran and passed, and nothing failed.
 */
export function profilePasses(checks, required = REQUIRED) {
  const core = checks.filter(counts);
  const skipped = new Set(core.filter(c => c.ok === null && c.skippedBy === 'profile').map(c => c.n));
  return required.every(n => skipped.has(n) || core.some(c => c.n === n && c.ok === true))
    && core.every(c => c.ok === true || skipped.has(c.n)) && checks.filter(c => c.n === 9).every(c => c.ok !== false);
}

/**
 * The shape of a profile file (verify --profile): {name, environment?: {VAR: value}, skip: [{check, reason, legs?}],
 * run?: [n…] (for the reader; must not name a skipped check)}. `legs: "lobby"` is for check 5 alone: the gate's lobby
 * legs still run. → the problems (empty: the profile is well formed)
 */
export function checkProfile(p) {
  const out = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['a profile is a JSON object'];
  if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.name)) out.push('name must be a short lower-case id (ci-software)');
  if (p.environment !== undefined && (typeof p.environment !== 'object' || p.environment === null || Array.isArray(p.environment) || Object.values(p.environment).some(v => !['string', 'number'].includes(typeof v)))) out.push('environment must map variable names to strings');
  if (!Array.isArray(p.skip)) return [...out, 'skip must be a list of {check, reason}'];
  const seen = new Set();
  for (const s of p.skip) {
    if (!Number.isInteger(s?.check) || s.check < 1) { out.push(`skip: ${JSON.stringify(s)} has no check number`); continue; }
    if (seen.has(s.check)) out.push(`skip names check ${s.check} twice`);
    seen.add(s.check);
    if (typeof s.reason !== 'string' || s.reason.trim().length < 8) out.push(`skip ${s.check} needs its reason (a skipped check is recorded with it)`);
    if (s.legs !== undefined && !(s.check === 5 && s.legs === 'lobby')) out.push(`skip ${s.check}: legs can only be "lobby", on check 5`);
  }
  for (const n of Array.isArray(p.run) ? p.run : []) if (seen.has(n)) out.push(`check ${n} is in run and in skip`);
  return out;
}

// ---- the verdict file (builder/gates/verdict.schema.json; runtimes/CONTRACT.md §7) ----------------------------------
// verify keeps its whole record (every measure with its detail, rule and fix, the timing, the shots, the notes) in
// record.json, and writes the verdict every reader of a gate reads, the same on every runtime, in verdict.json: per gate
// what ran, what passed and what was skipped with why, so "passes gate C on vista" never implies a round game's
// coverage. A skipped measure is never counted as passed; one this run required makes its gate fail.

/** Every measure the record names that a gate claims (an advisory judge aside): its number is an integer. */
const measured = rec => (rec.checks ?? []).filter(c => Number.isInteger(c.n) && gateOf(c.n) && gateOf(c.n) !== 'J');
const clip = (s, n) => (s == null ? undefined : String(s).slice(0, n));

/**
 * The verdict of a verify record (verdictVersion 1). `rec` is what verify returns: checks [{n, ok, detail, rule, fix,
 * notYet, reason}], required, pass, place {runtime, profile}, specLoop (the spec's loop), specSha, release, renderer, chrome, seconds. `skips`: what
 * the runtime's manifest says it does not measure ([{measure, why}], registry runtimes/<id>/runtime.json →
 * measures.skipped), listed in the gates this run judged. → the verdict object
 */
export function verdictOf(rec, { skips = [] } = {}) {
  const required = new Set(rec.required ?? []), checks = measured(rec), gates = {};
  const asked = rec.only ? new Set([].concat(rec.only)) : null;
  for (const g of GATES) {
    const mine = checks.filter(c => gateOf(c.n) === g.id);
    const req = [...required].filter(n => gateOf(n) === g.id && (!asked || asked.has(n)));
    const ran = mine.filter(c => c.ok !== null).map(c => c.n);
    const passed = mine.filter(c => c.ok === true).map(c => c.n);
    const skipped = mine.filter(c => c.ok === null).map(c => ({ measure: c.n, why: clip(c.notYet ?? c.reason ?? c.detail, 400) || 'not run in this verify', ...(req.includes(c.n) ? { required: true } : {}) }));
    for (const n of req) if (!mine.some(c => c.n === n)) skipped.push({ measure: n, why: 'not run in this verify', required: true });
    if (!ran.length && !skipped.length && !req.length) continue;
    for (const s of skips) if (gateOf(s.measure) === g.id && !mine.some(c => c.n === s.measure) && !skipped.some(x => x.measure === s.measure)) skipped.push({ measure: s.measure, why: clip(s.why, 400) });
    const failed = mine.filter(c => c.ok === false).map(c => ({ measure: c.n, ...(c.detail ? { detail: clip(c.detail, 1000) } : {}), ...(c.rule ? { rule: clip(c.rule, 400) } : {}), ...(c.fix ? { fix: clip(c.fix, 400) } : {}) }));
    gates[g.id] = { gate: g.id, name: g.name, ran: [...new Set(ran)], passed: [...new Set(passed)], skipped: skipped.sort((a, b) => a.measure - b.measure), failed, ok: !failed.length && !skipped.some(s => s.required) };
  }
  const judges = (rec.checks ?? []).filter(c => isAdvisory(c.n) && c.ok === false).slice(0, 8).map(c => ({ measure: c.n, finding: clip(c.detail || c.name, 600) }));
  const api = /webgpu/.test(rec.renderer ?? '') ? 'webgpu' : /webgl/.test(rec.renderer ?? '') ? 'webgl2' : null;
  const environment = { ...(rec.chrome ? { browser: clip(rec.chrome, 120) } : {}), ...(rec.renderer ? { gpu: clip(rec.renderer, 120) } : {}), ...(api ? { api } : {}), ...(rec.profile?.name ? { profile: clip(rec.profile.name, 60) } : {}) };
  return {
    verdictVersion: 1,
    ...(rec.game ? { game: clip(rec.game, 200) } : {}),
    runtime: rec.place?.runtime ?? 'three', ...(rec.place?.profile ? { profile: rec.place.profile } : {}),
    ...(typeof rec.specLoop === 'string' ? { loop: rec.specLoop } : {}),
    run: rec.release ? 'release' : 'build',
    ...(rec.specSha ? { spec: rec.specSha } : {}),
    ...(Object.keys(environment).length ? { environment } : {}),
    gates: Object.keys(gates).length ? gates : { A: { gate: 'A', name: GATES[0].name, ran: [], passed: [], skipped: [{ measure: 1, why: 'nothing was measured', required: true }], failed: [], ok: false } },
    ...(judges.length ? { judges } : {}),
    pass: !!rec.pass,
    ...(Number.isFinite(rec.seconds) ? { seconds: rec.seconds } : {}),
    failed: Object.values(gates).flatMap(g => g.failed.map(f => ({ gate: g.gate, ...f }))),
  };
}

/** What a runtime (and profile) says it does not measure: its registry manifest's measures.skipped. → [{measure, why}] */
export async function runtimeSkips(place) {
  try {
    const { readCatalog } = await import('./spec.mjs');
    const rt = (await readCatalog()).runtimes.find(r => r.id === place?.runtime);
    return (rt?.measures?.skipped ?? []).filter(s => Number.isInteger(s.measure)).map(s => ({ measure: s.measure, why: s.why }));
  } catch { return []; }
}

/** Write a verify run's two files: record.json (the whole record) and verdict.json (verdictOf). → the verdict */
export async function writeVerdict(outDir, rec) {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const verdict = verdictOf(rec, { skips: await runtimeSkips(rec.place) });
  await writeFile(join(outDir, 'record.json'), JSON.stringify(rec, null, 2) + '\n');
  await writeFile(join(outDir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  rec.verdict = verdict;
  return verdict;
}
