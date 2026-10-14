// The look in the loop (builder/look): when a build round passes every functional measure and only the look (measure 23,
// gate F) fails, the loop runs the tuning loop's cheap levers before any look repair, verifies again, and a repair that
// still follows carries what the levers could not reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { fakeBindings, scriptedVerify } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT } from './fixtures/registry.mjs';

const reg = fakeRegistry();
// the cards of tests/loop/gaps.test.mjs
const SPEC = { specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });
const LOOK = [{ gate: 'F', measure: 23, detail: '41/100 like its look target: sky too desaturated', rule: 'r', fix: 'f' }];

async function toVerify(t, { script, tune }) {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-look-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const sv = scriptedVerify(script);
  const B = fakeBindings({ registry: reg, root, verify: sv.verify });
  const G = { game, arg: 'games/g' };
  const tools = { ...B.tools(G), tuneLook: tune };
  const L = await openLoop({ registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G), flags: { reader: false } });
  await L.step({ idea: PROMPT }); await L.step({ ledger: goodLedger() }); await L.step({});
  assert.equal((await L.step({ pitch: CARDS })).about, 'cards');
  let r = await L.step({ choice: { card: 'b' } });
  for (let i = 0; i < 6 && r.waiting !== 'agent'; i++) r = await L.step({});
  assert.equal(r.kind, 'build');
  r = await L.step({ summary: 'the gate holds', controls: 'WASD, mouse' });
  for (let i = 0; i < 4 && L.state.step !== 'verify'; i++) r = await L.step({});
  return { L, game, sv };
}

test('only the look failed: the levers are tuned, verify runs again, and the game goes on without a repair round', async t => {
  let tuned = 0;
  const { L, game, sv } = await toVerify(t, { script: [LOOK, 'pass'], tune: async g => { tuned++; await writeFile(join(g, 'config-look-tuned.json'), '{}'); return { score: { before: 41, after: 63, bar: 60 }, wrote: true, ladder: { needed: false, art: [] } }; } });
  let r = await L.step({});
  assert.equal(r.next, 'verify', r.why);
  assert.match(r.why, /levers were tuned \(41 → 63/);
  r = await L.step({});
  assert.equal(r.next, 'playtest');
  assert.equal(tuned, 1); assert.equal(sv.calls.length, 2);
  assert.deepEqual(L.state.tune.wrote, true);
  void game;
});

test('the levers plateau below the bar: the repair round\'s brief carries what only new art can reach; tuned once a version', async t => {
  let tuned = 0;
  const tune = async () => { tuned++; return { score: { before: 41, after: 47, bar: 60 }, wrote: false, ladder: { needed: true, art: [{ framing: 'hero', part: 'characters', line: 'no big googly eyes; the reference\'s creatures have them' }], leversLeft: [] } }; };
  const { L } = await toVerify(t, { script: [LOOK, LOOK], tune });
  let r = await L.step({});
  assert.equal(r.next, 'repair');
  r = await L.step({});
  assert.equal(r.waiting, 'agent');
  assert.match(r.message, /proposed .*41 → 47 .*a suggestion, not applied/);
  assert.match(r.message, /hero, characters: no big googly eyes/);
  assert.equal(tuned, 1);
});

test('the kit host runs the tune as a suggestion: no --write, the proposed values and sheet beside the game', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../../builder/loop/kit.mjs', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('async tuneLook('), src.indexOf('hash: game =>'));
  assert.ok(!/'--write'/.test(call), 'tuneLook never writes into the game');
  assert.match(call, /wrote: false, suggestion:/);
});

test('a functional failure beside the look goes to repair as before: the levers wait for the functional gates', async t => {
  let tuned = 0;
  const { L } = await toVerify(t, { script: [[...LOOK, { gate: 'C', measure: 13, detail: 'A does nothing', rule: 'r', fix: 'f' }]], tune: async () => { tuned++; return { wrote: true }; } });
  const r = await L.step({});
  assert.equal(r.next, 'repair');
  assert.equal(tuned, 0);
});
