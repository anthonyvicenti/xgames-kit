// The second reader (an independent judge of "intent kept", advisory, before delivery) and the optional parts
// (an economy and a backend: offered at the pitch, decided by the person, checked after the round, handed over at
// delivery), each in the loop and through the MCP tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf, readerBundle, readReading, readerSays, applyPartAnswers, checkPartsPitch, checkPartsSpec, failingSet, judgePrompt, judgementProblems } from '../../builder/loop/index.mjs';
import { loopTools } from '../../builder/mcp/loop-tools.mjs';
import { decide } from '../../plugin/scripts/guard.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, PROMPT, CARD_WORDS, pitchV2 } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const REPLY = 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.';
const card = (id, spec = SPEC) => ({ ...CARD_WORDS, id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec });
const ECON = { what: 'Players pay 0.01 SOL a run and the last one standing wins the pot.', price: 'about 0.05 SOL' };
const econQ = (def = 'keep') => ({ id: 'money', about: 'economy', text: 'Play for SOL?', options: [{ id: 'keep', label: 'Yes, a pot in SOL' }, { id: 'no-economy', label: 'No economy, just the game' }], default: def });

async function place(t) {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-rp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  return { root, game };
}
/** A runner host: every round answers at once; `pitch`, `reader`, `parts` and `flags` are the test's. */
async function runner(t, { pitch, reader = keepAll, parts = {}, flags = {}, verify = scriptedVerify([]).verify } = {}) {
  const { root, game } = await place(t);
  const B = fakeBindings({ registry: reg, root, verify });
  const G = { game, arg: 'games/g' }, rounds = [];
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G), limits: B.limits, parts, flags,
    agent: async o => {
      rounds.push(o);
      if (o.kind === 'ledger') return { ledger: goodLedger() };
      if (o.kind === 'pitch') return { pitch: pitch ?? pitchV2({ reply: REPLY, cards: [card('a'), card('b')], questions: [] }) };
      if (o.kind === 'ask') return { questions: { message: 'stuck', questions: [] } };
      await touch(game, 'rules.js', `// ${rounds.length}`);
      return { summary: 'ok', controls: 'Mouse' };
    },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'played to the boss' }),
    ...(reader ? { reader } : {}),
  });
  return { L, game, rounds };
}

// ---------------------------------------------------------------- the second reader
test('the reader is given the person\'s words, the lines, the promises with the tester\'s log and the captures; never the spec or how the build meant it', () => {
  const ledger = { rows: [{ id: 'hook', about: 'action', words: 'a grappling hook', what: 'A hook', home: 'build', how: 'a module in src/hook.js', where: 'module', core: true }, { id: 'gone', about: 'thing', words: 'x', what: 'cut', cut: { words: 'x' } }] };
  const S = { prompt: PROMPT, references: [], answers: ['make it grim'], ledger, promises: [{ id: 'build.1', row: 'hook', text: 'Built new: a hook', how: 'src/hook.js' }], playtest: { answers: { 'build.1': { status: 'seen', note: 'pulled me up', evidence: ['runs/a/1.jpg'] } }, summary: 's', feel: [] }, lock: { spec: { text: '{"runtime":"forge"}' } }, delivery: { summary: 'I wrote src/hook.js' } };
  const b = readerBundle(S, { captures: [{ file: '/g/runs/a/1.jpg', what: 'a: hook' }] });
  assert.deepEqual(b.rows, [{ id: 'hook', about: 'action', words: 'a grappling hook', what: 'A hook', core: true }], 'a cut line is not read; a line\'s home and how are not given');
  assert.equal(b.promises[0].tester.status, 'seen');
  assert.ok(!('how' in b.promises[0]));
  assert.doesNotMatch(JSON.stringify(b), /src\/hook\.js|"runtime"|I wrote/);
  assert.deepEqual(b.words.answers, ['make it grim']);
});

test('a reading marks every line once, with a reason, and evidence for kept or partly', () => {
  const ids = ['a', 'b', 'c'];
  let r = readReading({ rows: [{ id: 'a', mark: 'kept', why: 'shown' }, { id: 'b', mark: 'nope', why: 'x' }, { id: 'z', mark: 'lost', why: 'x' }] }, ids);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /rows\[0\]\.evidence/.test(p)) && r.problems.some(p => /rows\[1\]\.mark/.test(p)) && r.problems.some(p => /"z" is not a line/.test(p)) && r.problems.some(p => /no mark for "c"/.test(p)), r.problems.join('\n'));
  r = readReading({ rows: [{ id: 'a', mark: 'kept', why: 'shown', evidence: ['1.jpg'] }, { id: 'b', mark: 'lost', why: 'no boss' }, { id: 'c', mark: 'cannot-tell', why: 'never reached' }], findings: ['the gate is small'], summary: 'A gate.' }, ids);
  assert.equal(r.ok, true);
  const words = readerSays({ status: 'read', ...r }, { rows: [{ id: 'a', what: 'A', words: 'a' }, { id: 'b', what: 'A boss', words: 'a boss at the end' }, { id: 'c', what: 'C', words: 'c' }] });
  assert.match(words, /A boss \("a boss at the end"\): lost, no boss.*C \("c"\): cannot-tell.*It also noticed: the gate is small/);
});

test('the reader runs before every delivery; what it marks joins the ledger and never changes the outcome\'s name', async t => {
  const lostBoss = async o => ({ rows: o.bundle.rows.map(r => (r.id === 'boss' ? { id: r.id, mark: 'lost', why: 'no capture shows a boss' } : { id: r.id, mark: 'kept', why: 'shown', evidence: ['1.jpg'] })), findings: [], summary: 'A gate game with no boss.' });
  const { L } = await runner(t, { reader: lostBoss });
  await L.run({ idea: PROMPT });
  const r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.equal(r.outcome.outcome, 'delivered', 'advisory: the proof names the outcome');
  assert.equal(r.outcome.reader.status, 'read');
  assert.deepEqual(r.outcome.reader.marks, { kept: 9, partly: 0, lost: 1, 'cannot-tell': 0 });
  assert.ok(r.outcome.reader.intent < 1 && r.outcome.reader.intent > 0.7);
  assert.equal(r.outcome.ledger.rows.find(x => x.id === 'boss').reader.mark, 'lost');
  assert.match(r.outcome.reader.words, /no capture shows a boss/);
  assert.ok(L.state.history.some(h => h.step === 'read'));
});

test('a reader that gives no valid reading twice is said, never waited on; a reader turned off is said too', async t => {
  let n = 0;
  const { L } = await runner(t, { reader: async () => { n++; return { rows: [], summary: '' }; } });
  await L.run({ idea: PROMPT });
  let r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.equal(n, 2);
  assert.equal(r.outcome.reader.status, 'unread');
  assert.match(r.outcome.reader.why, /no valid reading 2 times/);
  assert.equal(r.outcome.outcome, 'delivered');
  const off = await runner(t, { reader: null, flags: { reader: false } });
  await off.L.run({ idea: PROMPT });
  r = await off.L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.equal(r.outcome.reader.status, 'off');
});

test('the evals\' judge: the frozen JUDGE.md is the prompt, {{bundle}} filled in; a judgement is held to its set\'s shape', async () => {
  const { readFile } = await import('node:fs/promises');
  const md = await readFile(new URL('../../evals/paired/JUDGE.md', import.meta.url), 'utf8');
  const p = judgePrompt(md, '/tmp/b/J123');
  assert.match(p, /^You are the second reader for one game/);
  assert.match(p, /The bundle is in `\/tmp\/b\/J123`/);
  assert.doesNotMatch(p, /\{\{bundle\}\}|Frozen 2026-10-13/);
  const ok = { schema: 'xgk-eval-judgement/1', set: 'paired', blindId: 'J1', ledger: [{ id: 'r1', mark: 'kept' }, { id: 'r2', mark: 'partly' }], control: { mark: 'absent' } };
  assert.deepEqual(judgementProblems(ok, { set: 'paired', ids: ['r1', 'r2'], blindId: 'J1' }), []);
  assert.ok(judgementProblems({ ...ok, ledger: [ok.ledger[0]] }, { set: 'paired', ids: ['r1', 'r2'], blindId: 'J1' }).some(x => /no mark for "r2"/.test(x)));
  assert.ok(judgementProblems({ ...ok, set: 'breadth', musts: [{ id: 'm1', mark: 'present' }] }, { set: 'breadth', ids: ['m1'], blindId: 'J1' }).some(x => /outcome/.test(x)));
});

test('the plugin\'s guard: the reader reads only the screenshots and its own folder, and only it hands in a reading', () => {
  const g = '/k/games/g', L = `${g}/.gf-loop`;
  const read = (agent, file) => decide({ tool_name: 'Read', tool_input: { file_path: file }, agent_type: agent, cwd: g });
  assert.equal(read('reader', `${L}/job/playtest/runs/one/1.png`), null);
  assert.equal(read('reader', `${L}/job/reader/READING.md`), null);
  assert.match(read('reader', `${g}/rules.js`), /second reader/);
  assert.match(read('reader', `${L}/headless/rounds/05-build.jsonl`), /second reader/, 'never the build\'s transcript');
  assert.match(read('reader', `${L}/job/playtest/PLAYTEST.md`) ?? '', /second reader/);
  assert.match(decide({ tool_name: 'mcp__gamesfun__gamesfun_reader_report', tool_input: {}, agent_type: 'playtester' }), /Only the reader/);
  assert.equal(decide({ tool_name: 'mcp__gamesfun__gamesfun_reader_report', tool_input: {}, agent_type: 'reader' }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${L}/job/reader/out/reading.json` }, agent_type: 'reader', cwd: g }), null);
  assert.match(decide({ tool_name: 'Write', tool_input: { file_path: `${L}/job/reader/out/reading.json` }, cwd: g }), /build loop's own/);
});

// ---------------------------------------------------------------- the parts
test('decide: an economy is offered and asked about, never forced; the person\'s own words keep it with no question', () => {
  const words = 'giant four in a row with friends';
  // offered with a question: fine; card 1 follows the question's default
  let p = pitchV2({ reply: REPLY, cards: [card('a', { ...SPEC, economy: { in: 'gamesfun.json' } }), card('b')], questions: [econQ('keep')], offers: { economy: ECON } });
  assert.deepEqual(checkPartsPitch(p, { on: ['economy', 'backend'], words }), []);
  assert.ok(checkPartsPitch({ ...p, questions: [econQ('no-economy')] }, { on: ['economy'], words }).some(x => /leaves it out by default/.test(x)));
  // offered with no question and no words of theirs: refused (never forced)
  assert.ok(checkPartsPitch({ ...p, questions: [] }, { on: ['economy'], words }).some(x => /offered as a question/.test(x)));
  // a question with no way out
  assert.ok(checkPartsPitch({ ...p, questions: [{ ...econQ(), options: [{ id: 'keep', label: 'Yes' }, { id: 'more', label: 'Yes, bigger' }] }] }, { on: ['economy'], words }).some(x => /leaves it out/.test(x)));
  // their words ask for it: offered with from, no question; card 1 keeps it
  const said = 'four in a row for SOL with my wallet';
  assert.ok(checkPartsPitch(pitchV2({ reply: REPLY, cards: [card('a'), card('b')], questions: [] }), { on: ['economy'], words: said }).some(x => /ask for an economy \("SOL"\)/.test(x)), 'nothing they asked for is left out');
  assert.deepEqual(checkPartsPitch({ ...p, questions: [], offers: { economy: { ...ECON, from: 'for SOL' } } }, { on: ['economy'], words: said }), []);
  // web3 off: an economy anywhere is refused, with the reason
  assert.ok(checkPartsPitch(p, { on: ['backend'], words }).some(x => /web3 is off here/.test(x)));
  assert.ok(checkPartsSpec({ ...SPEC, economy: { in: 'gamesfun.json' } }, { on: ['backend'] }).some(x => /web3 is off/.test(x)));
  assert.ok(checkPartsSpec({ ...SPEC, economy: { in: 'gamesfun.json', copy: 1 } }, { on: ['economy'] }).some(x => /reference, never a copy/.test(x)));
});

test('decide: the person\'s answer keeps or drops a part by code, and a backend their words need is offered', () => {
  const pitch = { offers: { economy: ECON, backend: { kind: 'database', needs: ['leaderboard'] } }, questions: [econQ('keep'), { id: 'scores', about: 'backend', text: 'A leaderboard for everyone?', options: [{ id: 'yes', label: 'Yes, everyone' }, { id: 'no', label: 'No backend, play in the browser' }], default: 'no' }] };
  let r = applyPartAnswers(SPEC, pitch, {});
  assert.deepEqual(r.spec.economy, { in: 'gamesfun.json' });
  assert.equal(r.spec.backend, undefined);
  assert.deepEqual(r.decided, { economy: { kept: true, by: 'the default', option: 'Yes, a pot in SOL' }, backend: { kept: false, by: 'the default', option: 'No backend, play in the browser' } });
  r = applyPartAnswers(r.spec, pitch, { economy: 'no-economy', scores: 'yes' });
  assert.equal(r.spec.economy, undefined);
  assert.deepEqual(r.spec.backend, { kind: 'database', needs: ['leaderboard'] });
  assert.ok(checkPartsPitch({ cards: [card('a')], questions: [] }, { on: ['backend'], words: 'race with a global leaderboard' }).some(x => /ask for a backend \("global leaderboard"\)/.test(x)));
});

test('check and publish: a kept economy is checked after the round, a refusal repaired like a gate, and delivery hands over the approval link without waiting', async t => {
  let checks = 0, published = 0;
  const economy = {
    check: async () => (++checks === 1 ? { ok: false, problems: [{ code: 'E-POOL-DRY', message: 'the pot can run dry', fix: 'seed the pool' }] } : { ok: true, problems: [], warnings: ['chance pays tokens'] }),
    publish: async () => { published++; return { ok: true, approve: { link: 'http://127.0.0.1:5199/studio/#economy?flow=economy', step: 'Open the link and press "Put it live".' }, cost: { totalSol: 0.05 } }; },
    status: async () => ({ live: false }),
  };
  const backend = { check: async () => ({ ok: true, problems: [] }), status: async () => ({ connected: false }) };
  const pitch = pitchV2({ reply: REPLY, cards: [card('a', { ...SPEC, economy: { in: 'gamesfun.json' } }), card('b')], questions: [econQ('keep')], offers: { economy: ECON } });
  const { L, rounds } = await runner(t, { pitch, parts: { economy, backend } });
  let r = await L.run({ idea: PROMPT });
  assert.equal(r.about, 'cards');
  assert.match(rounds.find(o => o.kind === 'pitch').message, /An economy.*web3 is on here/s, 'the pitch round says how to offer it');
  r = await L.run({ choice: { card: 'a', answers: { economy: 'keep' } } });
  assert.equal(r.next, 'done', JSON.stringify(r).slice(0, 300));
  assert.match(rounds.find(o => o.kind === 'build').message, /## The economy \(the person kept it\)/);
  const repair = rounds.find(o => o.kind === 'repair');
  assert.match(repair.message, /the economy check, E-POOL-DRY: the pot can run dry\n  fix: seed the pool/);
  assert.equal(checks, 2);
  assert.ok(L.state.ladder.sets.some(s => s.key === 'part economy:E-POOL-DRY'));
  assert.equal(r.outcome.economy.state, 'waiting-for-approval');
  assert.match(r.outcome.economy.words, /waits for your approval: Open the link/);
  assert.equal(published, 1);
  assert.equal(r.outcome.backend, undefined, 'no backend was kept');
  assert.deepEqual(L.state.parts.economy.kept, true);
  assert.equal(L.state.parts.economy.by, 'their answer');
});

test('the parts\' failing items fit the ladder\'s schema; a kept backend is checked and handed over unconnected', async t => {
  const { loadSchemas, SCHEMA } = await import('../../registry/schemas.mjs');
  const { validate } = await loadSchemas();
  const items = failingSet({ parts: [{ part: 'backend', code: 'B-RLS' }, { part: 'economy', code: 'E SHOP!' }] });
  assert.deepEqual(items.map(i => i.key), ['part backend:B-RLS', 'part economy:E-SHOP-']);
  assert.deepEqual(validate(SCHEMA.ladder, { schema: 'gf-ladder/1', rung: null, sets: [{ key: 'x', items, after: 'backend' }], climbs: [], queue: [], strong: false }), []);
  const backend = { check: async () => ({ ok: true, problems: [] }), status: async () => ({ connected: false }) };
  const pitch = pitchV2({ reply: REPLY, cards: [card('a', { ...SPEC, backend: { kind: 'database', needs: ['leaderboard'] } }), card('b')], questions: [], offers: { backend: { kind: 'database', needs: ['leaderboard'], from: 'my friends' } } });
  const { L } = await runner(t, { pitch, parts: { backend } });
  await L.run({ idea: PROMPT });
  const r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.equal(r.outcome.backend.state, 'not-connected');
  assert.match(r.outcome.backend.words, /plays in the browser with no database connected: the leaderboard says it needs your database.*npx gamesfun backend connect supabase/);
  assert.ok(L.state.history.some(h => h.step === 'backend'));
});

test('the MCP tools hold the parts\' order: after the round, the economy check, then verify', async t => {
  const { root } = await place(t);
  let n = 0;
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const tools = loopTools({ ...B, parts: () => ({ economy: { check: async () => (++n === 1 ? { ok: false, problems: [{ code: 'E-NONE', message: 'no economy yet', fix: 'economy_save' }] } : { ok: true, problems: [] }), publish: async () => ({ ok: true, approve: { link: null } }) } }) });
  const T = name => tools.find(x => x.name === name).handler;
  const g = { game: 'games/g' };
  await T('gamesfun_step_ledger')({ ...g, idea: PROMPT });
  await T('gamesfun_step_ledger')({ ...g, ledger: goodLedger() });
  await T('gamesfun_step_foundation')(g);
  await T('gamesfun_step_pitch')(g);
  let a = (await T('gamesfun_step_spec')({ ...g, pitch: pitchV2({ reply: REPLY, cards: [card('a', { ...SPEC, economy: { in: 'gamesfun.json' } }), card('b')], questions: [econQ()], offers: { economy: ECON } }) })).structuredContent;
  assert.equal(a.waitingOn, 'the person', JSON.stringify(a.problems));
  await T('gamesfun_step_pitch')({ ...g, choice: { card: 'a', answers: { money: 'keep' } } });
  await T('gamesfun_step_spec')(g);
  await T('gamesfun_step_create')(g);
  await touch(join(root, 'games', 'g'), 'rules.js', '// x');
  a = (await T('gamesfun_step_fix')({ ...g, summary: 's', controls: 'c' })).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_economy');
  assert.equal((await T('gamesfun_step_verify')(g)).structuredContent.refused, 'out-of-order');
  a = (await T('gamesfun_step_economy')(g)).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_repair');
  a = (await T('gamesfun_step_repair')(g)).structuredContent;
  assert.match(a.round.message, /E-NONE: no economy yet/);
  await touch(join(root, 'games', 'g'), 'gamesfun.json', '{"economy":{}}');
  a = (await T('gamesfun_step_fix')({ ...g, summary: 's', controls: 'c' })).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_economy');
  a = (await T('gamesfun_step_economy')(g)).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_verify');
});
