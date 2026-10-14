// verify check 35: the game's own tests (open builder track M2-D; home "game" in tools/lib/homes.json).
//
// A game promises things that are its own: its core loop, how its score moves, what each mechanic is in this game, the
// hook on its title card, the creator's accept items, what it builds new (spec.build) (tools/lib/promises.mjs: every promise whose kind is not "kit" or
// "control"; those two are held by the numbered checks). No numbered check can know them. So the game carries its own
// tests, written by whoever builds it, and verify runs them all as one check. A broken promise fails that game's own
// test, with the promise's words in the detail, and no new numbered check is needed per promise.
//
// A test is one JSON file in <game>/tests/, named <anything>.test.json:
//
//   { "promise": "score",                       the promise's id in promises.json (tools/promises.mjs <game> lists them)
//     "why": "a drink in the tank scores",      one line: what a player would see (optional)
//     "steps": [ … ] }                          a play script (tools/lib/play-script.mjs) with at least one "expect"
//
// How a test runs: on a page of its own, alone, on stepped time when the game's kit offers it (kit/core/step.js): real
// keys, clicks and mouse moves, and every wait, hold and "step" in the game's own seconds without waiting for them, so
// a test of a 60 s round takes a second or two and gives the same answer on a slow machine. A game on an older kit
// runs the same steps on the wall clock. A test fails when a step cannot run, an "expect" does not hold, or the page
// logs an error.
//
// The check passes when every test passes. A game with no tests passes with nothing to run, and the verdict lists the
// game's own promises that no test names (`untested`); `requireTests` makes that list a failure (verify --own-tests
// require), for whoever builds games to turn on once every build writes its tests.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript, judgeExpect } from './play-script.mjs';
import { prepareStepped, stepUrl, clockFor, mouseTaken } from './stepped.mjs';
import { turnBy } from './lock.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const TESTS_DIR = 'tests';
export const TEST_SUFFIX = '.test.json';
export const TEST_LIMITS = { tests: 40, seconds: 300 };
/** The kinds of promise that are a game's own (the rest are the kit's, held by numbered checks). */
export const OWN_KINDS = ['loop', 'score', 'mechanic', 'hook', 'accept', 'build'];
export const ownPromises = list => (list?.promises ?? []).filter(p => OWN_KINDS.includes(p.kind));

/**
 * Read and check every test of a game, with no browser. promises: the game's promise list (promisesFor), or null when
 * it could not be derived (then ids are not held to it).
 * → {tests: [{file, promise, text, why, steps, seconds}], problems: [file: what is wrong], untested: [{id, text}]}
 */
export async function loadGameTests(dir, { promises = null } = {}) {
  const root = join(dir, TESTS_DIR), tests = [], problems = [];
  const names = existsSync(root) ? (await readdir(root)).filter(n => n.endsWith(TEST_SUFFIX)).sort() : [];
  if (names.length > TEST_LIMITS.tests) problems.push(`${TESTS_DIR}/ holds ${names.length} tests; at most ${TEST_LIMITS.tests}`);
  const own = promises ? ownPromises(promises) : null, known = promises ? new Map((promises.promises ?? []).map(p => [p.id, p])) : null;
  for (const name of names.slice(0, TEST_LIMITS.tests)) {
    const file = `${TESTS_DIR}/${name}`, bad = m => problems.push(`${file}: ${m}`);
    let t;
    try { t = JSON.parse(await readFile(join(root, name), 'utf8')); } catch (e) { bad(`not JSON (${e.message})`); continue; }
    if (!t || typeof t !== 'object' || Array.isArray(t)) { bad('a test is an object {promise, steps}'); continue; }
    if (typeof t.promise !== 'string' || !t.promise.trim()) { bad('"promise" must be the id of a promise in promises.json (tools/promises.mjs <game> lists them)'); continue; }
    const p = known?.get(t.promise) ?? null;
    if (known && !p) { bad(`"promise": "${t.promise}" is not one of this game's promises (${[...known.keys()].filter(id => !id.startsWith('kit.')).join(', ') || 'none'})`); continue; }
    let parsed;
    try { parsed = parseScript(t.steps); } catch (e) { bad(`its steps do not parse: ${e.message.split('\n').slice(0, 3).join('; ')}`); continue; }
    if (!parsed.steps.some(s => s.do === 'expect')) { bad('no "expect" step: a test that expects nothing proves nothing'); continue; }
    if (parsed.steps.some(s => ['tap', 'drag', 'again', 'shot'].includes(s.do) || s.touch)) { bad('a game\'s test uses start, hold, press, move, look, wait, step, until, snap, click and expect (no touch, shot or again)'); continue; }
    if (parsed.seconds > TEST_LIMITS.seconds) { bad(`asks for ${parsed.seconds} s of play; at most ${TEST_LIMITS.seconds}`); continue; }
    tests.push({ file, promise: t.promise, text: p?.text ?? null, why: typeof t.why === 'string' ? t.why.slice(0, 200) : null, steps: parsed.steps, seconds: parsed.seconds });
  }
  const named = new Set(tests.map(t => t.promise));
  const untested = (own ?? []).filter(p => !named.has(p.id)).map(p => ({ id: p.id, text: p.text }));
  return { tests, problems, untested };
}

/**
 * A promise list with what the game's own tests prove: a promise a test names gains the proof 'verify:35'. The one
 * place that does it; promisesFor (tools/lib/promises.mjs) calls it when the game has a tests/ folder, so every
 * caller of the promise list sees the proof. `list` is promisesFor's list before the tests are read.
 */
export async function withTestProofs(dir, list) {
  const { tests } = await loadGameTests(dir, { promises: list });
  const named = new Set(tests.map(t => t.promise));
  return { ...list, promises: list.promises.map(p => (named.has(p.id) && !p.proofs.includes('verify:35') ? { ...p, proofs: [...p.proofs, 'verify:35'] } : p)) };
}

/** The game's promise list with what its own tests prove (promisesFor does this itself now; kept for its callers). */
export async function promisesWithTests(dir) {
  return (await import('./promises.mjs')).promisesFor(dir);
}

const SNAP = () => { try { return JSON.parse(JSON.stringify(window.__game?.snapshot?.() ?? null)); } catch { return null; } };

/** Run one test on its own page. → {file, promise, ok, clock, seconds (wall), played (game s), failed: [lines], expects: [{ok, line}]} */
export async function runGameTest(test, { newPage, url, stepped = true }) {
  const t0 = Date.now();
  const start = test.steps[0];
  const T = await newPage(`own test ${test.file}`, start.round ? { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: start.round }] } } : {});
  const p = T.page, failed = [], expects = [];
  const vp = p.viewportSize() ?? { width: 1280, height: 720 }, cursor = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
  const snap = () => p.evaluate(SNAP).catch(() => null);
  const down = k => (k === 'Mouse' ? p.mouse.down({ button: 'left' }) : k === 'MouseRight' ? p.mouse.down({ button: 'right' }) : p.keyboard.down(k));
  const up = k => (k === 'Mouse' ? p.mouse.up({ button: 'left' }) : k === 'MouseRight' ? p.mouse.up({ button: 'right' }) : p.keyboard.up(k));
  let clock = null, played = 0;
  const snaps = new Map();
  try {
    if (stepped) await prepareStepped(p);
    const q = new URLSearchParams({ seed: String(start.seed), bots: String(start.bots), ...(start.quality ? { quality: start.quality } : {}) });
    await p.goto(stepped ? stepUrl(`${url}?${q}`) : `${url}?${q}`, { waitUntil: 'load', timeout: 90000 });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    clock = await clockFor(p, { real: !stepped });
    const b = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (b) await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); else await p.keyboard.press('Enter');
    await clock.until(async () => (await p.evaluate(() => window.__game?.phase ?? null)) === 'playing', 20000, 'the round to start', 120);
    await p.mouse.move(cursor.x, cursor.y); await p.mouse.click(cursor.x, cursor.y); await mouseTaken(p); await clock.wait(250);
    snaps.set('start', await snap());
    const t1 = clock.now();
    for (const [i, st] of test.steps.entries()) {
      if (i === 0) continue;
      const at = `step ${i + 1} (${st.do})`;
      try {
        switch (st.do) {
          case 'hold': case 'move': {
            for (const k of st.keys) await down(k);
            try {
              if (st.look) { const n = 6; for (let j = 0; j < n; j++) { await turnBy(p, cursor, st.look.dx / n, st.look.dy / n); await clock.wait(st.seconds * 1000 / n); } }
              else await clock.wait(st.seconds * 1000);
            } finally { for (const k of [...st.keys].reverse()) await up(k).catch(() => {}); }
            break;
          }
          case 'press': for (let k = 0; k < st.times; k++) { await down(st.key); await clock.wait(90); await up(st.key); await clock.wait(60); } break;
          case 'look': await turnBy(p, cursor, st.dx, st.dy); await clock.wait(250); break;
          case 'wait': case 'step': await clock.wait(st.seconds * 1000); break;
          case 'until': await clock.until(async () => (await p.evaluate(() => window.__game?.phase ?? null)) === st.phase, st.timeout * 1000, `the game to reach ${st.phase}`, 200); break;
          case 'snap': snaps.set(st.name, await snap()); break;
          case 'click': await p.mouse.click(st.x, st.y, { button: st.button }); Object.assign(cursor, { x: st.x, y: st.y }); await clock.wait(60); break;
          case 'expect': {
            const base = snaps.get(st.since ?? 'start') ?? null;
            const j = st.since && !snaps.has(st.since) ? { ok: false, line: `${st.path} ${st.op} since ${st.since}: there is no snap named "${st.since}" before this step` } : judgeExpect(st, await snap(), base);
            expects.push({ step: i + 1, ok: j.ok, line: j.line });
            if (!j.ok) failed.push(`${at}: ${j.line}`);
            break;
          }
          default: throw new Error(`"${st.do}" is not a step of a game's own test`);
        }
      } catch (e) { failed.push(`${at}: could not run: ${e.message.split('\n')[0]}`); break; }
    }
    played = Math.round((clock.now() - t1) / 100) / 10;
  } catch (e) {
    failed.push(`the test's page stopped: ${e.message.split('\n')[0]}`);
  } finally {
    const errors = [...new Set(T.errors)];
    await T.ctx.close().catch(() => {});
    if (errors.length) failed.push(`console errors on the test's page: ${errors.slice(0, 2).join(' | ')}`);
  }
  return { file: test.file, promise: test.promise, text: test.text, why: test.why, ok: failed.length === 0, clock: clock?.stepped ? 'stepped' : 'wall', seconds: Math.round((Date.now() - t0) / 100) / 10, played, failed, expects };
}

/**
 * Check 35. dir: the game; newPage(label, {overrides}) → {ctx, page, errors} and url: verify's own, or null when the
 * run has no browser (then only the files are judged). promises: the game's list (promisesFor), or null.
 * → {ok, detail, warnings, record}
 */
export async function checkGameTests({ dir, newPage = null, url = null, promises = null, requireTests = false, stepped = true, log = () => {} }) {
  const L = await loadGameTests(dir, { promises });
  const results = [];
  if (newPage && url) for (const t of L.tests) { const r = await runGameTest(t, { newPage, url, stepped }); log(`  own test ${t.file}: ${r.ok ? 'ok' : 'FAIL'}${r.ok ? '' : ` ${r.failed[0]}`}`); results.push(r); }
  const broken = results.filter(r => !r.ok);
  const fails = [...L.problems.map(p => `a test that cannot run: ${p}`), ...broken.map(r => `${r.file} (promise ${r.promise}${r.text ? `: "${r.text.slice(0, 140)}"` : ''}): ${r.failed.slice(0, 3).join('; ')}`)];
  if (requireTests && L.untested.length) fails.push(`${L.untested.length} of this game's own promises have no test in ${TESTS_DIR}/: ${L.untested.map(p => p.id).join(', ')}`);
  const ok = fails.length === 0;
  const ran = results.length;
  const detail = ok
    ? (ran ? `${ran} test${ran === 1 ? '' : 's'} of the game's own promises passed (${results.map(r => r.promise).join(', ')}) in ${Math.round(results.reduce((n, r) => n + r.seconds, 0) * 10) / 10} s for ${Math.round(results.reduce((n, r) => n + r.played, 0))} s of play` : `no tests: the game has no ${TESTS_DIR}/*${TEST_SUFFIX}`) + (L.untested.length ? `; ${L.untested.length} own promise${L.untested.length === 1 ? '' : 's'} with no test (${L.untested.map(p => p.id).join(', ')})` : '')
    : `${fails.join(' | ')}. Each test is the game's own promise in steps: fix the game so the promise holds (rules.js, config/game.json), or, when the promise itself changed, the test with it`;
  const warnings = !requireTests && L.untested.length && L.tests.length ? [`own promises with no test: ${L.untested.map(p => p.id).join(', ')}`] : [];
  return { ok, detail, warnings, record: { tests: results, problems: L.problems, untested: L.untested, required: !!requireTests, ran, passed: ran - broken.length } };
}
