// A promise about friends is proven only with two player-driven seats (the creator, 2026-10-08: a friends round has no
// bots and needs two players), checked against the play-tester's own run record; and a round removes the files it
// made (gamesfun_remove), never what create made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf, promisesOf, readReport, settlePromises, twoSeats, composeBrief } from '../../builder/loop/index.mjs';
import { removeMade } from '../../builder/loop/kit.mjs';
import { checkpointStore } from '../../builder/lib/checkpoint.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch, TWO_SEATS } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT, GATE_PLAY } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, play: { target: GATE_PLAY }, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });
/** The same run with a bot on the host's screen: a friends round has none. */
const WITH_BOTS = { ...TWO_SEATS, friend: false, steps: TWO_SEATS.steps.filter(s => s.who !== 'friend').map(s => (s.do === 'snap' ? { ...s, state: { players: [{ name: 'You', you: true, bot: false }, { name: 'Pip', bot: true }] } } : s)) };

test('the players line, and a build line serving it, are friends promises; a solo game has none', () => {
  const ledger = goodLedger();
  let list = promisesOf({ spec: SPEC, ledger });
  assert.deepEqual(list.filter(p => p.friends).map(p => p.id), ['row.friends']);
  list = promisesOf({ spec: { ...SPEC, build: [...SPEC.build, { what: 'a ready check for both players', how: 'a module in src/ready.js', where: 'module', row: 'friends' }] }, ledger });
  assert.deepEqual(list.filter(p => p.friends).map(p => p.id), ['row.friends', 'build.2']);
  ledger.rows.find(r => r.id === 'friends').together = 'solo';
  assert.equal(promisesOf({ spec: SPEC, ledger }).some(p => p.friends), false);
});

test('two player-driven seats, read from the run\'s own record: a friends run, each player acting and captured, no bot', () => {
  assert.deepEqual(twoSeats(TWO_SEATS), { ok: true, why: 'two players in one game, each acting, each screen captured, no bot' });
  assert.match(twoSeats(WITH_BOTS).why, /not a friends run/);
  assert.match(twoSeats({ ...TWO_SEATS, steps: TWO_SEATS.steps.filter(s => !(s.who === 'friend' && s.do === 'move')) }).why, /the friend did nothing/);
  assert.match(twoSeats({ ...TWO_SEATS, steps: TWO_SEATS.steps.filter(s => !(s.who === 'friend' && s.do === 'snap')) }).why, /no capture of the friend's screen/);
  assert.match(twoSeats({ ...TWO_SEATS, steps: [...TWO_SEATS.steps, { do: 'snap', state: { players: [{ name: 'Pip', bot: true }] } }] }).why, /a screen showed a bot/);
  assert.match(twoSeats(null).why, /no record/);
  // a report names what each screen showed for a two-player promise it saw
  const r = readReport({ promises: [{ id: 'row.friends', status: 'seen', evidence: ['runs/two/1.jpg'] }] }, ['row.friends'], { friends: ['row.friends'] });
  assert.match(r.problems[0], /two-player promise: say what each screen showed/);
  // seen with bots is untested, never proven
  const p = { id: 'row.friends', kind: 'row', row: 'friends', friends: true, proofs: ['play'] };
  assert.equal(settlePromises([p], { playtest: { answers: { 'row.friends': { status: 'seen', two: false, twoWhy: 'bots: a screen showed a bot' } } } })[0].status, 'untested');
  assert.equal(settlePromises([p], { playtest: { answers: { 'row.friends': { status: 'seen', two: true } } } })[0].status, 'proven');
});

async function runWith(t, testerRun) {
  const root = await mkdtemp(join(tmpdir(), 'gf-friends-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' }, tools = B.tools(G), reports = [], briefs = [];
  tools.playRun = async (g, name) => (name === 'two' ? TWO_SEATS : name === 'bots' ? WITH_BOTS : null);
  let readerSaw = null;
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G),
    agent: async o => (o.kind === 'ledger' ? { ledger: goodLedger() } : o.kind === 'pitch' ? { pitch: CARDS } : (await touch(game, 'rules.js', `// ${o.kind}`), { summary: 's', controls: 'c' })),
    playtester: async o => { briefs.push(o.message); const run = testerRun(reports.length); reports.push(run); return { promises: o.focus.map(id => ({ ...seenTwo(id), evidence: [`runs/${run}/${id}.jpg`] })), summary: run }; },
    reader: async o => { readerSaw = o.message; return keepAll(o); },
  });
  await L.run({ idea: PROMPT });
  const r = await L.run({ choice: { card: 'a' } });
  return { r, L, reports, briefs, readerSaw };
}

test('seen with bots: the play-test is asked again once for the friends promise; seen with two players it is proven', async t => {
  const { r, reports, briefs, readerSaw } = await runWith(t, n => (n === 0 ? 'bots' : 'two'));
  assert.equal(r.next, 'done');
  assert.deepEqual(reports, ['bots', 'two']);
  assert.match(briefs[0], /`row\.friends` \(two players\)/);
  assert.match(briefs[0], /\{"do":"start","friend":true\}/);
  assert.deepEqual(briefs[1].match(/^- `[^`]+`/gm), ['- `row.friends`', '- `build.1`', '- `play.1`', '- `play.2`', '- `play.3`'], 'the second round asks the friends promise again (and, as every re-test, the build lines and the lines of play)');
  assert.equal(r.outcome.outcome, 'delivered');
  assert.equal(r.outcome.ledger.rows.find(x => x.id === 'friends').status, 'proven');
  assert.equal(r.outcome.promiseLedger.promises.find(p => p.id === 'row.friends').by.find(b => b.proof === 'play').seats, 'two players');
  assert.match(readerSaw, /seats: two players, each driven by the tester \(checked against the run\)\n  the host's screen: the friend is beside me/, 'the second reader sees the two screens');
});

test('never with two players: the friends line stays untested, and the delivery says so', async t => {
  const { r, reports, L } = await runWith(t, () => 'bots');
  assert.equal(r.next, 'done');
  assert.equal(reports.length, 2, 'asked once more, then no further');
  assert.equal(r.outcome.outcome, 'delivered-with-issues');
  const friends = r.outcome.promiseLedger.promises.find(p => p.id === 'row.friends');
  assert.equal(friends.status, 'untested');
  assert.match(friends.by.find(b => b.proof === 'play').note, /seen without two players: bots: the run was not a friends run/);
  assert.equal(r.outcome.ledger.rows.find(x => x.id === 'friends').status, 'untested');
  assert.match(r.outcome.notYet, /not checked by anything yet: Friends play together/);
  assert.ok(L.state.history.some(h => /still not seen with two players/.test(h.why ?? '')));
});

test('a round removes the files it made, never what create made, the loop\'s folder or a link', async t => {
  const game = await mkdtemp(join(tmpdir(), 'gf-remove-'));
  t.after(() => rm(game, { recursive: true, force: true }));
  await mkdir(join(game, 'src'), { recursive: true });
  await writeFile(join(game, 'rules.js'), '// create made it');
  await checkpointStore(game).keep('created');
  await writeFile(join(game, 'rules.js.new'), 'x');
  await writeFile(join(game, 'src', 'old.js'), '// a round made it');
  await mkdir(join(game, '.gf-loop'), { recursive: true });
  await writeFile(join(game, '.gf-loop', 'note.txt'), 'x');
  await symlink(join(game, 'rules.js'), join(game, 'link.js'));
  const r = await removeMade(game, ['rules.js.new', 'src/old.js', 'rules.js', '../elsewhere.js', '.gf-loop/note.txt', 'nope.js', 'link.js', 'src']);
  assert.deepEqual(r.removed, ['rules.js.new', 'src/old.js']);
  assert.deepEqual(Object.fromEntries(r.refused.map(x => [x.path, x.why.split(' ')[0]])), { 'rules.js': 'create', '../elsewhere.js': 'outside', '.gf-loop/note.txt': 'the', 'nope.js': 'no', 'link.js': 'a', src: 'only' });
  assert.ok(existsSync(join(game, 'rules.js')) && !existsSync(join(game, 'rules.js.new')));
  const brief = composeBrief({ spec: SPEC, ledger: goodLedger(), promises: [], manifests: { runtime: null, loop: null, mechanics: [], kind: null, packs: [] } });
  assert.match(brief, /Remove what you made and no longer need .* with `gamesfun_remove`/);
});
