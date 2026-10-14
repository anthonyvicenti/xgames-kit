// What the first Studio v3 build through the loop found (games.fun research/foundations/evidence/
// studio-v3-local-build-2026-10-13.json), each held here: the pitch in the pitch v2 shape, the summary in the person's
// terms, no tester-shaped repairs, a talk round handed back with its problems, toolsFor for hosts, a host's failed
// hand-over, and one rule for what a host skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf, pitchShapeProblems, readerBrief, deliverableFiles, isHostSkipped, messages } from '../../builder/loop/index.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate of Ash', hook: 'Hold the gate with friends until the boss comes.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });

async function host(t, { agent, hooks = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gf-studio-findings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' }, rounds = [];
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G), hooks,
    agent: async o => { rounds.push(o); const a = await agent?.(o, rounds); if (a) return a; if (o.kind === 'ledger') return { ledger: goodLedger() }; if (o.kind === 'pitch') return { pitch: CARDS }; await touch(game, 'rules.js', `// ${rounds.length}`); return { summary: 'I added a line that prints the camera distance for the tester.', controls: 'WASD, mouse' }; },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'ok' }),
    reader: keepAll,
  });
  return { L, rounds, game };
}

test('1. the pitch is the pitch v2 shape: every card field, a reply within 400 characters, research and policy; the loop stamps pitchVersion', async t => {
  const old = { reply: 'x'.repeat(1238), cards: [{ id: 'a', title: 'Balloon Rush', take: 'pop', v1: { has: ['balloons'] }, spec: {} }], questions: [] };
  const p = pitchShapeProblems(old);
  for (const want of [/research/, /policy/, /\$\.reply: must NOT have more than 400 characters/, /\(hook\)/, /\(howItPlays\)/, /\(whyFunny\)/, /\(conceptPrompt\)/, /take is not a pitch v2 field/]) assert.ok(p.some(x => want.test(x)), `${want}: ${p.join(' | ')}`);
  assert.deepEqual(pitchShapeProblems(CARDS), []);
  const { L, rounds } = await host(t);
  const r = await L.run({ idea: PROMPT });
  assert.equal(r.about, 'cards');
  assert.equal(r.pitch.pitchVersion, 2);
  const pitchRound = rounds.find(o => o.kind === 'pitch');
  assert.match(pitchRound.message, /hook \(one sentence, at most 200\).*whyFunny.*conceptPrompt/s);
  assert.match(pitchRound.message, /The reply \(at most 400 characters\)/);
  assert.deepEqual(pitchRound.schema.properties.pitch.properties.reply, { type: 'string', maxLength: 400, description: pitchRound.schema.properties.pitch.properties.reply.description }, 'the round answers in the shape');
});

test('2. the summary the person reads first is the game in their terms, from the spec and the ledger, never a round\'s note', async t => {
  const { L } = await host(t);
  await L.run({ idea: PROMPT });
  const r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.match(r.outcome.summary, /^Gate of Ash\. Hold the gate with friends until the boss comes\. What you asked for that works now: players hold a gate against attackers; zombies come in waves; a boss comes at the end; a grappling hook pulls a player onto the walls/);
  assert.doesNotMatch(r.outcome.summary, /camera distance|tester/);
  assert.equal(r.outcome.delivery.summary, r.outcome.summary);
  assert.match(r.outcome.delivery.lastRound, /camera distance for the tester/, 'the round\'s own words are kept, apart');
});

test('3. a repair is for a player, never the tester; the second reader names what looks made for a tester', async t => {
  const m = messages.repairMessage({ round: { kind: 'repair' }, after: 'playtest', playtest: { answers: { 'row.view': { status: 'not-seen', note: 'no camera' } } }, promises: [{ id: 'row.view', text: 'view' }], ladder: null });
  assert.match(m, /Fix it for a player, never for the tester.*a readout of the camera, a debug line/s);
  const b = readerBrief({ bundle: { words: { idea: 'x', references: [], answers: [] }, rows: [], promises: [], tester: null, captures: [] }, reportHow: '' });
  assert.match(b, /anything on screen that looks made for a tester rather than a player/);
});

test('4. a runner\'s talk round handed back gets its problems and its own last answer, and answers in the registry\'s words', async t => {
  const bad = goodLedger();
  bad.rows.find(r => r.id === 'waves').home = { exists: true, by: 'mechanic:waves' };
  const { L, rounds } = await host(t, { agent: (o, rs) => (o.kind === 'ledger' && rs.filter(x => x.kind === 'ledger').length === 1 ? { ledger: bad } : null) });
  const r = await L.run({ idea: PROMPT });
  assert.equal(r.about, 'cards');
  const ledgerRounds = rounds.filter(o => o.kind === 'ledger');
  assert.equal(ledgerRounds.length, 2, 'one bad ledger, one fixed: no blind retries');
  assert.equal(ledgerRounds[1].again, true);
  assert.match(ledgerRounds[1].message, /Your last ledger is not valid yet:\n- \$\.rows\[1\]\.home: .*a word, not an object/);
  assert.match(ledgerRounds[1].message, /Here it is: change only what the problems name[\s\S]*"exists": true/);
  const row = ledgerRounds[0].schema.properties.ledger.properties.rows.items.properties;
  assert.deepEqual(row.home, { enum: ['exists', 'build', 'probe'] });
  assert.ok(row.camera.enum.includes('first') && row.together.enum.includes('coop') && row.acts.enum.includes('levels-in-order'));
});

test('5. a host that runs rounds itself gets the same tools per round: toolsFor', async () => {
  const { toolsFor } = await import('../../builder/loop/headless.mjs');
  const t = toolsFor('ledger', { game: '/g', playtest: '/g/p', kitRoot: '/k' });
  assert.equal(t.cwd, '/k');
  assert.ok(t.disallowed.includes('Agent') && t.disallowed.includes('Read(//k/evals/**)'));
  assert.ok(toolsFor('build', { game: '/g', playtest: '/g/p', kitRoot: '/k' }).allowed.includes('mcp__gamesfun__gamesfun_remove'));
});

test('6. a host whose hand-over fails keeps the run at deliver; the next deliver hands it over again', async t => {
  let tries = 0;
  const { L } = await host(t, { hooks: { deliver: async () => (++tries === 1 ? { ok: false, why: 'the upload to the play host failed (503)' } : { ok: true }) } });
  await L.run({ idea: PROMPT });
  let r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.refused, 'delivery-failed');
  assert.equal(L.state.status, 'building');
  assert.equal(L.state.step, 'deliver');
  assert.match(L.state.outcome.handOver.why, /503/);
  r = await L.run({});
  assert.equal(r.next, 'done');
  assert.equal(L.state.status, 'delivered');
  assert.equal(tries, 2);
  const thrown = await host(t, { hooks: { deliver: async () => { throw new Error('network down'); } } });
  await thrown.L.run({ idea: PROMPT });
  assert.equal((await thrown.L.run({ choice: { card: 'a' } })).refused, 'delivery-failed');
  assert.notEqual(thrown.L.state.status, 'delivered');
});

test('7. one rule for what a host skips: the loop\'s folder, verify\'s evidence, node_modules and every dot name', async t => {
  const g = await mkdtemp(join(tmpdir(), 'gf-host-skip-'));
  t.after(() => rm(g, { recursive: true, force: true }));
  for (const f of ['index.html', 'rules.js', 'src/board.js', '.gitignore', '.gf-loop/state.json', 'evidence/verify-1/verdict.json', 'node_modules/x/i.js', 'assets/.DS_Store']) { await mkdir(join(g, f, '..'), { recursive: true }); await writeFile(join(g, f), 'x'); }
  assert.deepEqual(await deliverableFiles(g), ['index.html', 'rules.js', 'src/board.js']);
  assert.equal(isHostSkipped('src/evidence/a.png'), false, 'only the top evidence folder is verify\'s');
});

test('found by the PA11 runs: the pitch round is told the worlds of its runtime and profile', async () => {
  const { kitRegistry } = await import('../../builder/loop/kit.mjs');
  const { pitchMessage } = messages;
  const real = await kitRegistry();
  const rt = real.catalog.runtimes.find(r => r.id === 'three');
  const worlds = rt.worlds.filter(w => !w.profiles || w.profiles.includes('standard-3d')).map(w => ({ id: w.id, describe: w.describe ?? '' }));
  const m = pitchMessage({ ledger: goodLedger(), foundation: { runtime: 'three', profile: 'standard-3d', loop: 'turns', kind: 'silly', why: { runtime: 'r', loop: 'l', kind: 'k' }, said: [] }, worlds });
  assert.match(m, /The worlds a spec on three\/standard-3d may name in `world.template`: `arena`.*`plaza`/);
  assert.doesNotMatch(m.match(/The worlds a spec on .*/)[0], /`field`/);
});
