// A game the loop never ran on (made with create from a spec or an example, or a composed level) takes a change
// request: its ledger is read from the spec's own words, its spec is the lock, and the request re-enters as a change
// (found by the sunny-pvp proving build, 2026-10-14: the creator's change to a composed level had no way into the loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, PROMPT, GATE_PLAY } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const MADE = { specVersion: 2, prompt: PROMPT, play: { target: GATE_PLAY }, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.',
  round: { winBy: 'the boss falling' }, world: { props: [{ name: 'gate', describe: 'a gate to hold', role: 'held by the players', kind: 'gameplay' }, { name: 'tree', kind: 'scenery' }] }, mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const REQUEST = 'Make the boss come sooner, after wave two.';

test('a game made outside the loop takes a change: ledger from its words, its spec locked, then the change round', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const tools = B.tools(G), made = [];
  const create = tools.create; tools.create = (spec, o) => { made.push(spec); return create(spec, o); };
  const seen = [];
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G),
    agent: async o => {
      seen.push(o);
      if (o.kind === 'ledger' || o.kind === 'amend') return { ledger: goodLedger() };
      if (o.kind === 'spec') return { spec: { ...MADE, title: 'Gate, boss sooner' } };
      if (o.kind === 'pitch') throw new Error('an adopted game is not pitched again');
      await touch(game, 'rules.js', `// ${o.kind} ${seen.length}`);
      return { summary: 'ok', controls: 'Mouse' };
    },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'ok' }),
    reader: keepAll,
  });
  assert.equal((await L.adopt(MADE, REQUEST)).next, 'ledger');
  assert.equal((await L.adopt(MADE, REQUEST)).refused, 'not-new', 'once only');
  const r = await L.run({});
  assert.equal(r.next, 'done', JSON.stringify(r));
  assert.deepEqual(seen.map(o => o.kind).slice(0, 3), ['ledger', 'amend', 'spec']);
  assert.match(seen[0].message, /co-op zombie defence/, 'the first ledger reads the game\'s own words');
  assert.match(seen[0].message, /What it became: Hold it\.[\s\S]*A round is won by the boss falling\.[\s\S]*In the world: a gate to hold \(held by the players\)/, 'and what the game became: its hook, how it is won, its things');
  assert.match(seen[1].message, /boss come sooner/, 'the amendment reads the request');
  assert.equal(seen.find(o => o.kind === 'change' || o.kind === 'build').kind, 'change', 'the round is a change round, not a fresh build');
  assert.match(seen.find(o => o.kind === 'change').message, /boss come sooner/);
  assert.equal(made.length, 0, 'create is not run again: the game stays as it was made');
  assert.equal(L.state.created.adopted, true);
  assert.equal(L.state.foundation.runtime, 'forge');
  assert.equal(JSON.parse(L.state.lock.spec.text).title, 'Gate, boss sooner');
  assert.ok(L.state.history.some(h => h.step === 'adopt'));
});

test('adopt refuses a folder with no spec v2', async t => {
  const L = await openLoop({ registry: reg, game: '/nowhere', tools: {} });
  assert.equal((await L.adopt({ title: 'x' }, REQUEST)).refused, 'no-spec');
});

test('a change to what a player does is designed again: the designer reads the request and the play the game had', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const ASK = 'Players can also shove each other off the walls.';
  const amended = goodLedger();
  amended.rows.push({ id: 'shove', about: 'action', what: 'Players shove each other off the walls', words: 'shove each other off the walls', home: 'exists', by: 'mechanic:shove', core: true });
  const seen = [];
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G),
    agent: async o => {
      seen.push(o);
      if (o.kind === 'ledger') return { ledger: goodLedger() };
      if (o.kind === 'amend') return { ledger: amended };
      if (o.kind === 'spec') return { spec: { ...MADE, mechanics: [...MADE.mechanics, { id: 'shove' }] } };
      if (o.kind === 'design') return { target: { ...GATE_PLAY, mechanics: [...GATE_PLAY.mechanics, { id: 'shove', why: 'the shove' }], touchpoints: [{ how: 'shove a friend off the wall', kind: 'other', often: 'every wave' }] } };
      await touch(game, 'rules.js', `// ${o.kind} ${seen.length}`);
      return { summary: 'ok', controls: 'Mouse' };
    },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'ok' }),
    reader: keepAll,
  });
  await L.adopt(MADE, ASK);
  const r = await L.run({});
  assert.equal(r.next, 'done', JSON.stringify(r));
  assert.equal(L.state.change.class, 'play');
  const d = seen.find(o => o.kind === 'design');
  assert.ok(d, 'the play is designed again');
  assert.match(d.message, /The change they ask for now[\s\S]*shove each other off the walls/);
  assert.match(d.message, /The play as it was designed before this change[\s\S]*co-op wave defence/);
  assert.match(JSON.parse(L.state.lock.spec.text).play.target.touchpoints[0].how, /shove a friend/);
});
