// The economy evals (builder/web3/economy/evals): twenty frozen prompts, a reference spec that passes each (the fixtures among
// them pass their own case), checks that tell the references apart, and the scorer on a folder and from a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CASES, holds, matches, referenceOf, scoreAll, scoreSpec, valuesAt } from '../builder/web3/economy/evals/score.mjs';
import { ROOT, fixtureNames, NOW } from './economy/helpers.mjs';
import { tempDir } from './helpers.mjs';

const run = promisify(execFile);
const SCORE = path.join(ROOT, 'builder/web3/economy/evals/score.mjs');

test('twenty frozen prompts, each one sentence with checks a script scores', () => {
  assert.equal(CASES.length, 20);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 20);
  for (const c of CASES) {
    assert.match(c.id, /^e\d\d-[a-z0-9-]+$/);
    assert.ok(!c.prompt.includes('\n') && c.prompt.length < 260, c.id);
    assert.ok(['Alone', 'Key'].includes(c.fit), c.id);
    assert.ok(c.checks.length >= 3, c.id);
    for (const k of c.checks) assert.ok(k.says && (k.some || k.none || k.warns || k.feeds), `${c.id}: ${JSON.stringify(k)}`);
  }
  // the kinds the plan names are all there
  const all = CASES.map((c) => c.prompt).join(' ');
  for (const w of [/coin-flip arena/, /shop/, /lottery/, /stake/, /merge/, /soulbound/, /duel/, /Token-2022/, /pump\.fun/]) assert.match(all, w);
  assert.ok(CASES.filter((c) => c.fit === 'Key').length >= 3, 'some need the authority');
});

test('each fixture behind an eval prompt passes its own checks, and so does every reference', () => {
  const fixtures = new Set(fixtureNames());
  const fromFixtures = CASES.filter((c) => c.reference.startsWith('fixtures/'));
  assert.ok(fromFixtures.length >= 10);
  for (const c of fromFixtures) assert.ok(fixtures.has(path.basename(c.reference, '.json')), c.reference);
  for (const c of CASES) {
    const r = scoreSpec(c, referenceOf(c), { now: NOW });
    assert.equal(r.pass, true, `${c.id}: ${r.checks.filter((x) => !x.ok).map((x) => `${x.says} (${x.why})`).join('; ')}`);
    assert.equal(r.total, c.checks.length + 4);
  }
  assert.equal(scoreAll({ references: true, now: NOW }).passed, 20);
});

test('the checks tell the references apart', () => {
  for (const c of CASES) {
    const passers = CASES.filter((o) => scoreSpec(c, referenceOf(o), { now: NOW }).pass).map((o) => o.id);
    assert.ok(passers.includes(c.id), c.id);
    assert.ok(passers.length <= 2, `${c.id} is passed by ${passers.join(', ')}`);
  }
});

test('a folder of produced specs: by file, by game folder, missing, refused and wrong', async (t) => {
  const d = await tempDir('gf-econ-evals-');
  t.after(d.cleanup);
  const id = (n) => CASES[n].id;
  await writeFile(path.join(d.dir, `${id(0)}.json`), JSON.stringify(referenceOf(CASES[0])));
  await mkdir(path.join(d.dir, id(2)));
  await writeFile(path.join(d.dir, id(2), 'gamesfun.json'), JSON.stringify({ version: 1, network: 'devnet', economy: referenceOf(CASES[2]) }));
  const twoPlaces = referenceOf(CASES[0]);
  twoPlaces.lotteries[0].places = [60, 40];
  await writeFile(path.join(d.dir, `${id(0)}.json`), JSON.stringify(twoPlaces));
  const refused = referenceOf(CASES[3]);
  refused.lotteries[0].pot = 'nowhere';
  await writeFile(path.join(d.dir, `${id(3)}.json`), JSON.stringify(refused));
  const r = scoreAll({ dir: d.dir, now: NOW });
  const get = (n) => r.results.find((x) => x.id === id(n));
  assert.equal(r.passed, 1);
  assert.equal(get(2).pass, true, 'a game folder’s gamesfun.json is read');
  assert.equal(get(0).pass, false);
  assert.deepEqual(get(0).checks.filter((k) => !k.ok).map((k) => k.says), ['a weekly lottery with three places']);
  assert.equal(get(3).checks.find((k) => k.says === 'it checks with no refusals').ok, false);
  assert.match(get(3).checks.find((k) => k.says === 'it checks with no refusals').why, /E-REF/);
  assert.equal(get(5).checks[0].why, `no ${id(5)}.json`);
});

test('paths and matchers', () => {
  const box = { price: '0.1', outcomes: [{ gives: 'pay', chance: 50 }, { gives: 'nothing', chance: 50 }], split: [{ to: 'pool:a', percent: 3 }, { to: 'burn', percent: 2 }], every: '7d' };
  assert.deepEqual(valuesAt(box, 'outcomes[].gives'), ['pay', 'nothing']);
  assert.deepEqual(valuesAt(box, 'outcomes.length'), [2]);
  assert.equal(matches(valuesAt(box, 'price'), 0.1), true, 'a decimal string is a number');
  assert.equal(matches(valuesAt(box, 'every'), { duration: '1w' }), true);
  assert.equal(matches(valuesAt(box, 'every'), 604800), true);
  assert.equal(matches(valuesAt(box, 'every'), { min: '6d', max: '8d' }), true);
  assert.equal(matches(valuesAt(box, 'split[].percent'), { $sum: { min: 4.5, max: 5.5 } }), true);
  assert.equal(matches(valuesAt(box, 'missing'), { exists: false }), true);
  assert.equal(holds(box, { 'outcomes[]': { gives: 'pay', chance: { min: 40 } } }), true);
  assert.equal(holds(box, { 'outcomes[]': { gives: 'nothing', chance: { max: 40 } } }), false, 'one element must hold the whole nested where');
  assert.equal(holds(box, { $any: [{ price: 1 }, { 'split[].to': { match: '^pool:' } }] }), true);
  assert.equal(holds(box, { $all: [{ price: 0.1 }, { 'outcomes[].gives': { in: ['burn'] } }] }), false);
  assert.equal(holds({ in: [{ takes: 'burn', count: 2 }] }, { 'in[]': { takes: 'burn', count: 2 } }), true, 'a field called count is a field');
});

test('score.mjs from a terminal', async () => {
  const { stdout } = await run(process.execPath, [SCORE, '--references']);
  assert.match(stdout, /20 of 20 pass\./);
  await assert.rejects(() => run(process.execPath, [SCORE, '--references', '--min', '21']), (e) => e.code === 1);
  const one = JSON.parse((await run(process.execPath, [SCORE, '--references', '--case', 'e16-plinko', '--json'])).stdout);
  assert.equal(one.of, 1);
  assert.equal(one.results[0].pass, true);
  await assert.rejects(() => run(process.execPath, [SCORE]), (e) => e.code === 2 && /Usage/.test(e.stderr));
});
