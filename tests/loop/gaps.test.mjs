// Four gaps Studio's worker found when it ran on the staged loop (2026-10-13), each held here:
//   1. words typed at the lock (with no answers) reach the spec round
//   2. an answer after a failed create goes through create, not straight to a change round
//   3. a migration has a "no": the game keeps its runtime and the person's words amend the ledger
//   4. every hand-over carries its next action as data ({tool, args, returns}) beside the prose
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });

async function handedHost(t, { create = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-gaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const tools = B.tools(G);
  if (create) { const real = tools.create; tools.create = (spec, o) => create(spec, o, real); }
  const L = await openLoop({ registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G) });
  return { L, game };
}
/** ledger → foundation → pitch → the cards with the person. */
async function toCards(L) {
  await L.step({ idea: PROMPT }); await L.step({ ledger: goodLedger() }); await L.step({});
  const r = await L.step({ pitch: CARDS });
  assert.equal(r.about, 'cards');
  return r;
}

test('1. words typed at the lock, with no answers, reach the spec round; a bare pick locks the card as it is', async t => {
  const { L } = await handedHost(t);
  await toCards(L);
  let r = await L.step({ choice: { card: 'a', words: 'make the boss come sooner, after wave two' } });
  assert.equal(r.next, 'spec');
  r = await L.step({});
  assert.equal(r.waiting, 'agent');
  assert.equal(r.kind, 'spec');
  assert.match(r.message, /make the boss come sooner, after wave two/);
  assert.deepEqual(r.action, { tool: 'gamesfun_step_spec', args: { spec: {} }, returns: 'spec' });
  r = await L.step({ spec: SPEC });
  assert.equal(r.next, 'create');
  assert.ok(L.state.answers.includes('make the boss come sooner, after wave two'), 'their words are among the sources a ledger line may quote');
  const { L: L2 } = await handedHost(t);
  await toCards(L2);
  await L2.step({ choice: { card: 'b' } });
  assert.equal((await L2.step({})).next, 'create', 'a bare pick needs no spec round');
});

test('2. an answer given after create failed is made by create, and its round is a build round', async t => {
  let n = 0;
  const { L, game } = await handedHost(t, { create: async (spec, o, real) => (++n === 1 ? { ok: false, why: 'no such world template' } : real(spec, o)) });
  await toCards(L);
  await L.step({ choice: { card: 'a' } }); await L.step({});
  let r = await L.step({});                                     // create fails
  assert.equal(r.next, 'ask');
  r = await L.step({});
  assert.equal(r.about, 'questions');
  assert.equal(r.action.tool, 'gamesfun_step_ledger');
  r = await L.step({ answer: { words: 'try the ruins world instead' } });
  assert.equal(r.next, 'ledger');
  r = await L.step({}); assert.equal(r.kind, 'amend');
  r = await L.step({ ledger: goodLedger() }); assert.equal(r.next, 'foundation');
  r = await L.step({}); assert.equal(r.next, 'spec');
  r = await L.step({}); assert.equal(r.kind, 'spec');
  r = await L.step({ spec: SPEC });
  assert.equal(r.next, 'create', 'the game was never made: create runs');
  r = await L.step({}); assert.equal(r.next, 'build');
  assert.equal(n, 2);
  r = await L.step({});
  assert.equal(r.kind, 'build', 'the round after a fresh make writes the whole game');
  assert.match(r.message, /# Build round/);
  await touch(game, 'rules.js', '// built');
  assert.equal((await L.step({ summary: 's', controls: 'c' })).next, 'fix');
});

test('3. a migration the person declines: the game keeps its runtime and their words amend the ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-gaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const led = goodLedger(), messages = [];
  const big = structuredClone(led);
  Object.assign(big.rows.find(l => l.id === 'view'), { words: 'from behind the player', what: 'Third person, from behind', camera: 'third', needs: [] });
  Object.assign(big.rows.find(l => l.id === 'phone'), { words: 'on my desktop', what: 'It plays on a desktop', devices: ['desktop'] });
  Object.assign(big.rows.find(l => l.id === 'feel'), { words: 'Make it photoreal', what: 'Photoreal', kind: 'calm', graphics: 'photoreal' });
  let amended = 0;
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G),
    agent: async o => {
      messages.push(o);
      if (o.kind === 'ledger') return { ledger: led };
      if (o.kind === 'amend') return { ledger: ++amended === 1 ? big : led };   // the second amendment keeps the runtime
      if (o.kind === 'pitch') return { pitch: CARDS };
      if (o.kind === 'spec') return { spec: SPEC };
      await touch(game, 'rules.js', `// ${o.kind} ${messages.length}`);
      return { summary: 'ok', controls: 'Mouse' };
    },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'ok' }),
    reader: keepAll,
  });
  await L.run({ idea: PROMPT });
  let r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  await L.change('Make it photoreal and play it from behind the player, on my desktop.');
  r = await L.run({});
  assert.equal(r.about, 'migration');
  assert.equal(r.action.tool, 'gamesfun_step_foundation');
  assert.deepEqual(r.action.or, { tool: 'gamesfun_step_foundation', args: { decline: '' } });
  r = await L.run({ decline: 'No, keep it on my phone.' });
  const amend = messages.filter(m => m.kind === 'amend').at(-1);
  assert.match(amend.message, /said no to moving the game from forge to vista \("No, keep it on my phone\."\)/);
  assert.equal(L.state.change.declined[0].to, 'vista');
  assert.equal(r.next, 'done', JSON.stringify(r));
  assert.equal(JSON.parse(L.state.lock.spec.text).runtime, 'forge', 'the game stays on its runtime');
});

test('4. every hand-over carries its next action as data, beside the prose', async t => {
  const { L, game } = await handedHost(t);
  let r = await L.step({ idea: PROMPT });
  assert.deepEqual(r.action, { tool: 'gamesfun_step_ledger', args: { ledger: { rows: [], asks: [] } }, returns: 'ledger' });
  r = await L.step({ ledger: { rows: [] } });                    // not valid: handed back
  assert.equal(r.action.tool, 'gamesfun_step_ledger');
  r = await L.step({ ledger: goodLedger() }); r = await L.step({});
  r = await L.step({});
  assert.equal(r.action.tool, 'gamesfun_step_spec');
  assert.equal(r.action.returns, 'pitch');
  r = await L.step({ pitch: CARDS });
  assert.deepEqual(r.action, { tool: 'gamesfun_step_pitch', args: { choice: { card: '', answers: {}, words: '' } }, returns: 'choice' });
  await L.step({ choice: { card: 'a' } }); await L.step({}); await L.step({});
  r = await L.step({});
  assert.deepEqual(r.action, { tool: 'gamesfun_step_fix', args: { summary: '', controls: '' }, returns: 'summary' });
  await touch(game, 'rules.js', '// built');
  await L.step({ summary: 's', controls: 'c' }); await L.step({}); await L.step({});
  r = await L.step({});
  assert.equal(r.waiting, 'playtest');
  assert.equal(r.action.tool, 'gamesfun_playtest_report');
  assert.equal(r.action.returns, 'report');
});

test('a runner\'s play-tester that gives no valid report twice: what it answered stands, the rest is unreachable, and the ladder goes on', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-gaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  let reports = 0;
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G),
    agent: async o => (o.kind === 'ledger' ? { ledger: goodLedger() } : o.kind === 'pitch' ? { pitch: CARDS } : o.kind === 'ask' ? { questions: { message: 'stuck', questions: [] } } : (await touch(game, 'rules.js', `// ${Math.random()}`), { summary: 's', controls: 'c' })),
    playtester: async o => (++reports <= 2 ? { promises: [seenTwo(o.focus[0])], summary: 'half' } : { promises: o.focus.map(seenTwo), summary: 'all' }),
    reader: keepAll,
  });
  await L.run({ idea: PROMPT });
  const r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done', JSON.stringify(r).slice(0, 400));
  assert.equal(reports, 3, 'one retry, then the half report stood (unreachable for the rest), a repair, and a full report');
  assert.ok(L.state.history.some(h => /no valid report twice/.test(h.why ?? '')));
});

test('no feel named: the kind is one proven on the chosen profile, never one the profile would have to prove', async () => {
  const { chooseFoundation } = await import('../../builder/loop/foundation.mjs');
  const { kitRegistry } = await import('../../builder/loop/kit.mjs');
  const real = await kitRegistry();
  const ledger = { rows: [
    { id: 'acts', about: 'acts', what: 'All at once in one round', words: 'race', acts: 'together-timed', home: 'exists' },
    { id: 'view', about: 'perspective', what: 'A camera that follows', words: 'drive', camera: 'follow', dimension: '3d', home: 'exists' },
    { id: 'friends', about: 'players', what: 'Against each other', words: 'friends', together: 'versus', home: 'exists' },
    { id: 'body', about: 'body', what: 'A car', words: 'cars', body: 'vehicle', home: 'build', how: 'a module in src/car.js', where: 'module' },
    { id: 'track', about: 'thing', what: 'A track', words: 'track', home: 'build', how: 'a module in src/track.js', where: 'module', needs: ['terrain'] },
  ], asks: [] };
  const f = await chooseFoundation(ledger, real);
  assert.equal(`${f.runtime}/${f.profile}`, 'three/scenic-3d');
  const k = (await real.kinds()).find(x => x.id === f.kind);
  assert.ok(k.proven.some(p => p === 'three' || p === 'three/scenic-3d'), `${f.kind} is proven on ${k.proven.join(', ')}`);
  assert.equal(f.kindProof, null);
});

test('found by the real build: a usage limit is waited out and the round run again, never counted as the model\'s answer', async () => {
  const { patient, waitFor, TRANSIENT } = await import('../../builder/loop/claude.mjs');
  assert.ok(TRANSIENT.test('You\'ve hit your session limit · resets 1:30pm (America/Phoenix)'));
  assert.ok(!TRANSIENT.test('the ledger is not valid'));
  const now = new Date(2026, 9, 13, 12, 0, 0);
  assert.equal(Math.floor(waitFor('resets 1:30pm', 0, now) / 60000), 90, 'until the stated reset (and half a minute)');
  assert.equal(waitFor('rate limit', 2, now), 5 * 60000);
  let n = 0;
  const slept = [];
  const run = patient(async () => (++n < 3 ? { ok: false, error: 'API Error: 529 overloaded' } : { ok: true, structured: { ok: 1 } }), { sleep: async ms => { slept.push(ms); }, now: () => now });
  const r = await run({ name: 'ledger' });
  assert.deepEqual(r.structured, { ok: 1 });
  assert.equal(r.tries.length, 2);
  assert.deepEqual(slept, [60000, 120000]);
});

test('found by the real build: "as it is" before anything was made ends the run as not made, not in a verify of nothing', async t => {
  const { L } = await handedHost(t, { create: async () => ({ ok: false, why: 'no' }) });
  await toCards(L);
  await L.step({ choice: { card: 'a' } }); await L.step({}); await L.step({}); await L.step({});
  const r = await L.step({ answer: { deliver: true, words: 'Deliver it as it is.' } });
  assert.equal(r.next, 'done', JSON.stringify(r));
  assert.equal(L.state.status, 'failed');
  assert.equal(L.state.outcome.outcome, 'not-made');
});
