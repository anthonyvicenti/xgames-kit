// The runner skeleton: freezing, the record format, blinding, scoring, and one pass end to end with fake adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, hashContent, checkSet, freezeSet } from '../lib/freeze.mjs';
import { validateRecord, writeRecord, freezeDir, checkDir, runKey } from '../lib/record.mjs';
import { blindIds, shuffle, scrub, bundleFor, leaks } from '../lib/blind.mjs';
import { intentScore, pairedResult, breadthResult, depthResult, checkFoundation } from '../lib/score.mjs';
import { completed } from '../lib/arms.mjs';
import { HERE, cmdPlan, runOne, cmdScore } from '../run.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'xgk-evals-'));
const H = c => c.repeat(64);

function goodRecord(over = {}) {
  return {
    schema: 'xgk-eval-record/1', set: 'paired', setHash: H('a'), case: 'PA01', caseHash: H('b'), arm: 'new', rep: 2,
    runKey: 'PA01-new-r2', pass: '2026-10-20-1', loop: { name: 'xgames-kit', commit: 'abcdef1' },
    model: { base: 'claude-opus-5-5', used: ['claude-opus-5-5'] },
    started: '2026-10-20T10:00:00-07:00', finished: '2026-10-20T11:30:00-07:00',
    outcome: { delivered: true, rescue: false, stopped: null, questions: [], ladder: [], lastWords: '' },
    game: { sha256: H('c'), dir: 'games/x' },
    measures: { completed: { value: true, why: 'played to results' }, multiplayer: { value: true, why: 'both screens' } },
    blindId: 'J2K9QXA', evidence: [],
    ...over,
  };
}

test('canonical JSON and text hashes ignore formatting, not content', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  const a = hashContent('x.json', Buffer.from('{"a": 1,\n "b": 2}\n')), b = hashContent('x.json', Buffer.from('{"b":2,"a":1}'));
  assert.equal(a, b);
  assert.notEqual(a, hashContent('x.json', Buffer.from('{"a":1,"b":3}')));
  assert.equal(hashContent('x.md', Buffer.from('one\r\ntwo\r\n')), hashContent('x.md', Buffer.from('one\ntwo\n')));
});

test('a frozen set refuses a changed file and only grows by new manifests', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'set.json'), JSON.stringify({ set: 'x', frozen: '2026-10-13' }));
  await writeFile(path.join(dir, 'A1.json'), JSON.stringify({ id: 'A1', frozen: '2026-10-13' }));
  const m = await freezeSet(dir, { date: '2026-10-13' });
  assert.deepEqual(Object.keys(m.files).sort(), ['A1.json', 'set.json']);
  assert.equal((await checkSet(dir)).ok, true);
  await assert.rejects(freezeSet(dir, { date: '2026-10-13' }), /nothing new/);
  await writeFile(path.join(dir, 'A2.json'), JSON.stringify({ id: 'A2', frozen: '2026-10-14' }));
  const m2 = await freezeSet(dir, { date: '2026-10-14' });
  assert.deepEqual(Object.keys(m2.files), ['A2.json']);
  await writeFile(path.join(dir, 'A1.json'), JSON.stringify({ id: 'A1', frozen: '2026-10-13', extra: 1 }));
  const s = await checkSet(dir);
  assert.equal(s.ok, false);
  assert.match(s.problems.join('\n'), /A1\.json: changed since it was frozen/);
  await assert.rejects(freezeSet(dir, { date: '2026-10-15' }), /cannot freeze/);
  await rm(dir, { recursive: true });
});

test('a JSON file that says another freeze date is refused', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'A1.json'), JSON.stringify({ id: 'A1', frozen: '2026-10-12' }));
  await assert.rejects(freezeSet(dir, { date: '2026-10-13' }), /says frozen 2026-10-12/);
  await rm(dir, { recursive: true });
});

test('the record format: a complete record passes, each missing piece is named', () => {
  assert.deepEqual(validateRecord(goodRecord()), []);
  const cases = [
    [{ schema: 'x' }, /schema/], [{ arm: 'mid' }, /arm/], [{ runKey: 'PA01-new-r3' }, /runKey/],
    [{ setHash: 'short' }, /setHash/], [{ loop: { name: 'k' } }, /loop/], [{ model: { base: 'm', used: [] } }, /model/],
    [{ started: '2026-10-20 10:00' }, /started/], [{ blindId: 'run-1' }, /blindId/],
    [{ outcome: { delivered: true, rescue: true, stopped: null, questions: [], ladder: [] } }, /rescueNotes/],
    [{ outcome: { delivered: false, rescue: false, stopped: 'error', questions: [], ladder: [] }, game: null }, /lastWords/],
    [{ outcome: { delivered: false, rescue: false, stopped: 'error', questions: [], ladder: [], lastWords: 'x' } }, /game/],
    [{ outcome: { delivered: true, rescue: true, rescueNotes: 'edited rules.js', stopped: null, questions: [], ladder: [] } }, /completed is true only/],
  ];
  for (const [over, re] of cases) assert.match(validateRecord(goodRecord(over)).join('\n'), re, JSON.stringify(over));
});

test('a record is written once and its folder freezes and checks', async () => {
  const dir = await tmp();
  await writeRecord(dir, goodRecord());
  await assert.rejects(writeRecord(dir, goodRecord()), /written once/);
  await assert.rejects(writeRecord(path.join(dir, 'b'), goodRecord({ arm: 'x' })), /incomplete/);
  await freezeDir(dir, { date: '2026-10-20' });
  assert.deepEqual(await checkDir(dir), []);
  await writeFile(path.join(dir, 'late.txt'), 'x');
  assert.match((await checkDir(dir)).join('\n'), /late\.txt: added after the freeze/);
  await rm(dir, { recursive: true });
});

test('completed needs delivery, no rescue and the end of the loop', () => {
  assert.equal(completed({ delivered: false, stopped: 'wall-clock' }, null).value, false);
  assert.equal(completed({ delivered: true, rescue: true, rescueNotes: 'x' }, { reachedEnd: true }).value, false);
  assert.equal(completed({ delivered: true, rescue: false }, { reachedEnd: false, blocker: 'stuck in menu' }).value, false);
  assert.equal(completed({ delivered: true, rescue: false }, { reachedEnd: true }).value, true);
});

test('blind ids are opaque, unique and the same for the same seed', () => {
  const keys = ['PA01-old-r1', 'PA01-new-r1', 'PA02-old-r1', 'PA02-new-r1'];
  const a = blindIds(keys, 42), b = blindIds(keys, 42);
  assert.deepEqual(a, b);
  assert.equal(new Set(Object.values(a)).size, 4);
  for (const id of Object.values(a)) assert.match(id, /^J[0-9A-Z]{6}$/);
  assert.deepEqual(shuffle(keys, 7), shuffle(keys, 7));
  assert.deepEqual([...shuffle(keys, 7)].sort(), [...keys].sort());
});

test('a bundle carries no arm and scrubs arm names from free text, not everyday words', async () => {
  const kase = JSON.parse(await readFile(path.join(HERE, 'paired/cases/PA10.json'), 'utf8'));
  const record = goodRecord({ case: 'PA10', runKey: 'PA10-new-r2' });
  const witness = { captures: [{ file: 'c/0010.png', t: 10, what: 'the car engine roars; the gf-three menu shows', screen: 1 }], probe: { summary: 'both screens show the other car (Claude Opus played)' } };
  const b = bundleFor({ blindId: 'J2K9QXA', kase, delivered: true, witness });
  assert.deepEqual(leaks(b, record), []);
  assert.equal(b.ledger.length, kase.ledger.length);
  assert.match(b.witness.captures[0].what, /engine roars; the \[hidden\] menu/);
  assert.doesNotMatch(JSON.stringify(b), /claude|opus|"arm"|xgames-kit/i);
  assert.match(leaks({ ...b, arm: 'new' }, record).join('\n'), /field arm/);
  assert.match(leaks({ ...b, lastWords: 'built by xgames-kit abcdef1' }, record).join('\n'), /abcdef1/);
  assert.equal(scrub('the Old Loop and the new arm'), 'the [hidden] and the [hidden]');
});

test('intent kept: core lines only, partly is half, cannot-tell is nothing', () => {
  const ledger = [{ id: 'r1', core: true }, { id: 'r2', core: true }, { id: 'r3', core: true }, { id: 'r4', core: false }];
  const j = { ledger: [{ id: 'r1', mark: 'kept' }, { id: 'r2', mark: 'partly' }, { id: 'r3', mark: 'cannot-tell' }, { id: 'r4', mark: 'lost' }] };
  assert.equal(intentScore(ledger, j), 0.5);
  assert.throws(() => intentScore(ledger, { ledger: [{ id: 'r1', mark: 'kept' }] }), /no valid mark for core line r2/);
});

/** Records and judgements for a two-prompt paired pass where new scores `n` and old `o` on every core line. */
function pairedFixture({ o, n, newDone = 2, oldDone = 2, reps = 1 }) {
  const ledger = [{ id: 'r1', core: true }, { id: 'r2', core: true }];
  const cases = { PA01: { id: 'PA01', ledger }, PA02: { id: 'PA02', ledger } };
  const records = [], judgements = {};
  let i = 0;
  for (const id of ['PA01', 'PA02']) for (const arm of ['old', 'new']) for (let rep = 1; rep <= reps; rep++) {
    const blindId = `J00000${i++}`;
    const done = arm === 'new' ? newDone-- > 0 : oldDone-- > 0;
    records.push({ case: id, arm, rep, runKey: runKey(id, arm, rep), blindId, outcome: { delivered: true }, measures: { completed: { value: done }, multiplayer: { value: true } } });
    const mark = (arm === 'new' ? n : o)[id];
    judgements[blindId] = { blindId, ledger: ledger.map(l => ({ id: l.id, mark })), control: { mark: 'absent' }, armGuess: { guess: 'cannot-tell' } };
  }
  return { cases, records, judgements, reps };
}

test('the paired gate: intent must improve on the mean and on prompts; completion and multiplayer not lower', () => {
  const up = pairedResult(pairedFixture({ o: { PA01: 'partly', PA02: 'partly' }, n: { PA01: 'kept', PA02: 'partly' } }));
  assert.equal(up.pass, true);
  assert.deepEqual([up.intent.wins, up.intent.losses, up.intent.ties], [1, 0, 1]);
  const split = pairedResult(pairedFixture({ o: { PA01: 'partly', PA02: 'kept' }, n: { PA01: 'kept', PA02: 'partly' } }));
  assert.equal(split.intent.pass, false, 'equal means and one win one loss is not an improvement');
  const fewer = pairedResult(pairedFixture({ o: { PA01: 'lost', PA02: 'lost' }, n: { PA01: 'kept', PA02: 'kept' }, newDone: 1 }));
  assert.equal(fewer.intent.pass, true);
  assert.equal(fewer.completion.pass, false);
  assert.equal(fewer.pass, false);
  const gap = pairedFixture({ o: { PA01: 'lost', PA02: 'lost' }, n: { PA01: 'kept', PA02: 'kept' } });
  delete gap.judgements[gap.records[3].blindId];
  const r = pairedResult(gap);
  assert.equal(r.complete, false);
  assert.equal(r.pass, false);
  assert.match(r.missing.join('\n'), /no judgement/);
});

test('the breadth exit counts faithful and delivered without rescue, and ranks missing parts', () => {
  const cases = {}, records = [], judgements = {};
  for (let i = 1; i <= 25; i++) {
    const id = `B${String(i).padStart(2, '0')}`, blindId = `JB${String(i).padStart(5, '0')}`;
    cases[id] = { id, archetype: { id: `a${i}` } };
    const faithful = i <= 20, rescued = i === 20;
    records.push({ case: id, rep: 1, blindId, outcome: { delivered: i !== 25, rescue: rescued, lastWords: 'stopped at questions' } });
    if (i !== 25) judgements[blindId] = faithful
      ? { blindId, outcome: 'faithful', musts: [{ id: 'm', mark: 'present' }], control: { mark: 'absent' } }
      : { blindId, outcome: 'something-else', musts: [{ id: 'm', mark: 'absent' }], missingParts: i % 2 ? ['body: a kart'] : ['loop: saved', 'body: a kart'], control: { mark: 'absent' } };
  }
  const r = breadthResult({ cases, records, judgements });
  assert.equal(r.faithfulDelivered, 19, 'B20 was rescued');
  assert.equal(r.pass, false);
  assert.deepEqual(r.missingParts[0], { part: 'body: a kart', archetypes: ['a21', 'a22', 'a23', 'a24'] });
  assert.equal(r.rows.find(x => x.case === 'B25').outcome, 'refused');
  judgements.JB00021.musts = [{ id: 'm', mark: 'present' }]; judgements.JB00021.outcome = 'faithful';
  judgements.JB00021.missingParts = [];
  records[19].outcome.rescue = false;
  assert.equal(breadthResult({ cases, records, judgements }).pass, true);
  judgements.JB00022.missingParts = [];
  assert.throws(() => breadthResult({ cases, records, judgements }), /names no missing part/);
});

test('the depth blind score: mean paired gap of at least -1 on 3 of 4 measures', () => {
  const sheet = (player, game, s, knows = false) => ({ player, game, knowsReference: knows, scores: { clarity: s[0], feel: s[1], look: s[2], again: s[3] } });
  const sheets = [];
  for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) { sheets.push(sheet(p, 'reference', [6, 6, 7, 6], p === 'P6')); sheets.push(sheet(p, 'ours', [6, 5, 5, 5], p === 'P6')); }
  const r = depthResult(sheets);
  assert.deepEqual(Object.fromEntries(Object.entries(r.measures).map(([k, v]) => [k, v.withinReach])), { clarity: true, feel: true, look: false, again: true });
  assert.equal(r.blindPass, true);
  assert.equal(r.knowers, 1);
  assert.equal(depthResult(sheets, { without: true }).players, 5);
});

test('the foundation check reads the locked spec through the case\'s pointers', () => {
  const f = { at: { runtime: '/runtime', profile: '/profile', loop: '/loop', kind: '/kind' }, accept: { runtime: ['forge', 'three'], profile: ['standard-3d'], loop: ['run'], kind: ['dark', 'lofi'] } };
  assert.deepEqual(checkFoundation({ runtime: 'forge', loop: 'run', kind: 'dark' }, f), []);
  assert.match(checkFoundation({ runtime: 'three', profile: 'flat-2d', loop: 'run', kind: 'silly' }, f).join('\n'), /profile is "flat-2d".*\n.*kind is "silly"/);
});

test('one pass end to end with fake adapters: plan, run, bundle, record, score', async () => {
  const root = await tmp();
  await cp(path.join(HERE, 'paired'), path.join(root, 'paired'), { recursive: true });
  const pins = { old: { name: 'old-loop', commit: '1111111' }, new: { name: 'new-loop', commit: '2222222' } };
  const plan = await cmdPlan('paired', { seed: 5, date: '2026-10-20', root, pins });
  assert.equal(plan.order.length, 72);
  assert.equal(plan.audit.length, 10);
  assert.equal(Object.keys(plan.cases).length, 12);
  const priv = await tmp();
  // PA04 and PA08 carry private images: a run of either stops before the loop when they are missing.
  const pa04 = plan.order.find(k => k.startsWith('PA04-'));
  await assert.rejects(runOne({ root, name: 'paired', pass: plan.pass, key: pa04, model: 'test-model-7', privateDir: priv }), /not in XGK_EVAL_PRIVATE/);
  const fake = arm => ({ async run({ inputs }) {
    return { delivered: arm === 'new' || !inputs.prompt.includes('racing'), stopped: null, lastWords: 'the old loop could not build a car', game: { sha256: H('d'), dir: 'g' }, models: ['test-model-7'], questions: [], ladder: [] };
  } });
  const adapters = { loops: { old: fake('old'), new: fake('new') },
    witness: { async play() { return { log: 'played; the xgames-kit menu showed', captures: [{ file: 'c/1.png', t: 1, what: 'race start', screen: 1 }], reachedEnd: true }; } },
    probe: { async twoPlayer() { return { value: true, why: 'both screens', summary: 'each sees the other' }; } } };
  const keys = plan.order.filter(k => /^PA1[012]-/.test(k));
  for (const key of keys) assert.deepEqual(await runOne({ root, name: 'paired', pass: plan.pass, key, model: 'test-model-7', adapters, privateDir: priv }), { recorded: key });
  assert.deepEqual(await runOne({ root, name: 'paired', pass: plan.pass, key: keys[0], model: 'test-model-7', adapters, privateDir: priv }), { skipped: keys[0] });
  const passDir = path.join(root, 'records', 'paired', plan.pass);
  for (const key of keys) {
    const rec = JSON.parse(await readFile(path.join(passDir, 'runs', key, 'record.json'), 'utf8'));
    assert.deepEqual(validateRecord(rec), [], key);
    assert.deepEqual(await checkDir(path.join(passDir, 'runs', key)), [], key);
  }
  const old10 = JSON.parse(await readFile(path.join(passDir, 'runs', 'PA10-old-r1', 'record.json'), 'utf8'));
  assert.equal(old10.outcome.delivered, false);
  assert.equal(old10.measures.completed.value, false);
  const bundles = await readdir(path.join(passDir, 'blind'));
  assert.equal(bundles.length, keys.length);
  const w = await readFile(path.join(passDir, 'blind', bundles.find(b => b === old10.blindId) ?? bundles[0], 'bundle.json'), 'utf8');
  assert.doesNotMatch(w, /old-loop|new-loop|1111111|"arm"/);
  const score = await cmdScore('paired', { pass: plan.pass, root });
  assert.equal(score.complete, false, 'nine prompts have no runs and no run has a judgement yet');
  await rm(root, { recursive: true }); await rm(priv, { recursive: true });
});

test('judge: one fresh session per bundle, given the frozen JUDGE.md and a copy of that bundle only; a void judgement goes to a fresh reader', async () => {
  const { cmdJudge } = await import('../run.mjs');
  const root = await tmp();
  await cp(path.join(HERE, 'paired'), path.join(root, 'paired'), { recursive: true });
  const bundle = path.join(root, 'records', 'paired', '2026-10-20-1', 'blind', 'J000001');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({ schema: 'xgk-eval-bundle/1', blindId: 'J000001', set: 'paired', prompt: 'giant four in a row with friends', ledger: [{ id: 'r1', core: true }, { id: 'r2', core: true }], control: { text: 'fishing' }, delivered: true }));
  await writeFile(path.join(bundle, 'witness.md'), 'played');
  const calls = [];
  let n = 0;
  const runner = async o => {
    calls.push(o);
    const present = ++n === 1;
    return { structured: { schema: 'xgk-eval-judgement/1', set: 'paired', blindId: 'J000001', ledger: [{ id: 'r1', mark: 'kept', why: 'x' }, { id: 'r2', mark: 'partly', why: 'y' }], policy: [], control: { mark: present ? 'present' : 'absent', why: 'z' }, summary: 's', armGuess: { guess: 'cannot-tell', why: '-' } }, models: ['m'] };
  };
  const done = await cmdJudge('paired', { pass: '2026-10-20-1', root, runner, model: 'm' });
  assert.deepEqual(done.map(d => d.file), ['judgements/J000001.json', 'judgements/J000001.2.json']);
  assert.equal(done[0].void, true);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.prompt, /^You are the second reader for one game/);
    assert.ok(c.prompt.includes(`The bundle is in \`${c.cwd}\``), 'the prompt names the copy it works in');
    assert.ok(!c.cwd.startsWith(root), 'the session works in a copy of the bundle, outside the records');
    assert.deepEqual(c.allowed, [`Read(/${c.cwd}/**)`, 'Glob', 'Grep']);
  }
  // judged once: a second call judges nothing; the score takes the fresh reader's judgement over the void one
  assert.deepEqual(await cmdJudge('paired', { pass: '2026-10-20-1', root, runner, model: 'm' }), []);
  await rm(root, { recursive: true, force: true });
});
