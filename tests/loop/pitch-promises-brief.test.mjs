// The pitch never narrows; the build lines become promises; the brief is one page from the chosen manifests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_MAX, checkChangeSpec, checkPitch, checkSpec, chooseFoundation, composeBrief, ledgerVerdict, manifestsOf, promisesOf, settlePromises, outcomeOf } from '../../builder/loop/index.mjs';
import { CARD_WORDS, fakeRegistry, goodLedger, pitchV2 } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const ledger = goodLedger();
const spec = () => ({ specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate of Ash', hook: 'Hold the gate.',
  mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse', hook: 'E' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] });
const card = (id, s = spec()) => ({ ...CARD_WORDS, id, title: `Card ${id}`, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: s });
const REPLY = 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.';

test('cards that keep every line pass', async () => {
  const f = await chooseFoundation(ledger, reg);
  assert.deepEqual(await checkPitch(pitchV2({ reply: REPLY, cards: [card('a'), card('b')], questions: [] }), { ledger, foundation: f, registry: reg }), []);
});

test('a pitch that narrows is refused: a dropped build line, a "not yet" the person never cut, kit words in the reply', async () => {
  const f = await chooseFoundation(ledger, reg);
  const s = { ...spec(), build: [], notInV1: ['the grappling hook'] };
  const p = await checkPitch(pitchV2({ reply: 'Not in this kit yet: the hook.', cards: [{ ...card('a', s), v1: { has: ['waves at the gate'], build: [], notYet: ['the grappling hook'] } }, card('b')] }), { ledger, foundation: f, registry: reg });
  assert.ok(p.some(x => /line "hook" .* is built for this game/.test(x)));
  assert.ok(p.some(x => /notInV1\[0\]: .* is not a line the person cut/.test(x)));
  assert.ok(p.some(x => /v1\.notYet/.test(x)));
  assert.ok(p.some(x => /\$\.reply: it says "Not in this kit yet"/.test(x)));
});

test('the runtime and the loop are the foundation\'s; a card may not ask what the ledger did not', async () => {
  const f = await chooseFoundation(ledger, reg);
  const p = await checkPitch(pitchV2({ reply: REPLY, cards: [card('a', { ...spec(), runtime: 'three', profile: 'standard-3d' }), card('b')], questions: [{ about: 'feel' }] }), { ledger, foundation: f, registry: reg });
  assert.ok(p.some(x => /spec\.runtime: "forge"/.test(x)));
  assert.ok(p.some(x => /questions\[0\]: the pitch asks only the ledger's questions/.test(x)));
});

test('a kind not proven on the runtime needs its proof as a build line', async () => {
  const f = await chooseFoundation(ledger, reg);
  const p = await checkSpec({ ...spec(), kind: 'calm' }, { ledger, foundation: f, registry: reg });
  assert.ok(p.some(x => /calm look is not proven on forge/.test(x)));
  assert.deepEqual(await checkSpec({ ...spec(), kind: 'calm', build: [...spec().build, { what: 'the calm look on forge', how: 'a module in src/look.js', where: 'module', kind: 'calm' }] }, { ledger, foundation: f, registry: reg }), []);
});

test('every "the build writes it" line is a core promise only the tester\'s eyes prove', () => {
  const list = promisesOf({ spec: spec(), ledger });
  const b = list.find(p => p.id === 'build.1');
  assert.deepEqual([b.kind, b.row, b.core, b.confirm, b.proofs], ['build', 'hook', true, true, ['play']]);
  const gates = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map(g => [g, { gate: g, ran: [1], passed: [1], skipped: [], ok: true }]));
  // not asked: untested, even with every gate green
  let s = settlePromises(list, { verdict: { gates }, playtest: { answers: {} } });
  assert.equal(s.find(p => p.id === 'build.1').status, 'untested');
  s = settlePromises(list, { verdict: { gates }, playtest: { answers: { 'build.1': { status: 'unreachable', note: 'never got a hook' }, 'row.boss': { status: 'seen' } } } });
  assert.equal(s.find(p => p.id === 'build.1').status, 'unreachable');
  const lv = ledgerVerdict(ledger, s);
  assert.equal(lv.rows.find(l => l.id === 'hook').status, 'failed');
  assert.equal(lv.rows.find(l => l.id === 'boss').status, 'proven');
  assert.equal(outcomeOf({ verdictOk: true, ledger: lv }), 'delivered-with-issues');
});

test('a look change holds play', () => {
  assert.ok(checkChangeSpec('look', spec(), { ...spec(), kind: 'lofi', mechanics: [{ id: 'waves' }] }).some(p => /never changes play/.test(p)));
  assert.deepEqual(checkChangeSpec('look', spec(), { ...spec(), kind: 'lofi' }), []);
  assert.ok(checkChangeSpec('play', spec(), { ...spec(), runtime: 'three' }).some(p => /migration/.test(p)));
});

test('the brief is one page from the chosen manifests only, and carries every build promise', async () => {
  const s = spec();
  const brief = composeBrief({ spec: s, ledger, promises: promisesOf({ spec: s, ledger }), manifests: await manifestsOf(s, reg) });
  assert.ok(brief.length <= BRIEF_MAX);
  for (const m of ['MARK-RUNTIME-FORGE', 'MARK-LOOP-RUN', 'MARK-MECH-WAVES', 'MARK-MECH-BOSS', 'MARK-KIND-DARK']) assert.match(brief, new RegExp(m));
  for (const m of ['MARK-MECH-TAG', 'MARK-RUNTIME-THREE', 'MARK-RUNTIME-VISTA', 'MARK-KIND-SILLY', 'MARK-LOOP-ROUND']) assert.doesNotMatch(brief, new RegExp(m));
  assert.match(brief, /`build\.1`: a grappling hook .* as a module of the game's own under src\//);
  assert.match(brief, /verify skips: C: 38/);
  assert.match(brief, /"hold the gate"/);
});

test('a brief over a page loses part notes, never the person\'s words or the build list', async () => {
  const s = spec();
  const m = await manifestsOf(s, reg);
  m.mechanics = m.mechanics.map(x => ({ ...x, note: Array.from({ length: 80 }, (_, i) => `note ${i} of ${x.id}: ${'x'.repeat(60)}`) }));
  const brief = composeBrief({ spec: s, ledger, promises: promisesOf({ spec: s, ledger }), manifests: m });
  assert.ok(brief.length <= BRIEF_MAX, `${brief.length}`);
  assert.match(brief, /`build\.1`/);
  assert.match(brief, /"a boss at the end"/);
});
