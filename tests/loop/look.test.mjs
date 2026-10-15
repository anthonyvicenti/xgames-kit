// The look step (builder/look): after create and before the build round. A host with look tools reads the style
// target (the measured half by the kit, the judged half by a round), draws 2–3 options, waits for the person's pick,
// writes it into the game and carries it into the build brief; headless, the judge's best (else the first) is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { defaultAnswers } from '../../builder/loop/headless.mjs';
import { lookLines } from '../../builder/loop/brief.mjs';
import { actionOf } from '../../builder/loop/order.mjs';
import { fakeBindings, scriptedVerify } from './dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT, GATE_PLAY } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, play: { target: GATE_PLAY }, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });
const JUDGED = { lighting: { key: '#fff2d8', time: 'day' }, materials: { shading: 'soft-toon' }, shapes: { language: ['rounded'] }, camera: { view: 'three-quarter' }, reads: ['a bright sky', 'chunky land', 'big eyes'], avoid: [], outline: { level: 'low' } };
const TARGET = { schema: 'gf-look-target/1', from: 'refs', confidence: 0.8, reads: JUDGED.reads, lighting: JUDGED.lighting, materials: JUDGED.materials, palette: { colors: [{ hex: '#7eaee2', share: 0.5, role: 'sky' }] } };

async function lookHost(t, { options = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-look-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const calls = { applied: [], finished: [] };
  const tools = {
    ...B.tools(G),
    lookTarget: async () => ({ pending: { message: 'read the frames: /refs/a.jpg', schema: { type: 'object' }, dirs: ['/refs'], base: { measured: null, frames: [] } } }),
    finishTarget: async (base, judged) => { calls.finished.push(judged); return { ok: true, target: TARGET }; },
    lookOptions: async () => options ?? [
      { id: 'faithful', title: 'As the references read', reading: 'as measured', values: { sky: { top: '#7eaee2' } }, levers: ['sky'], sheet: '/s/a.png', tiles: {}, ok: true, score: null },
      { id: 'pushed', title: 'Pushed', reading: 'louder', values: { sky: { top: '#5e8ee2' } }, levers: ['sky'], sheet: '/s/b.png', tiles: {}, ok: true, score: null },
    ],
    applyLook: async (g, o) => { calls.applied.push(o.id); return { ok: true }; },
  };
  const L = await openLoop({ registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G) });
  return { L, calls };
}
async function toCreate(L) {
  await L.step({ idea: PROMPT }); await L.step({ ledger: goodLedger() }); await L.step({});
  await L.step({ pitch: CARDS }); await L.step({ choice: { card: 'a' } }); await L.step({});
  return L.step({});   // create
}

test('the look step: a round reads the frames, the options wait for the person, the pick goes into the game and the brief', async t => {
  const { L, calls } = await lookHost(t);
  let r = await toCreate(L);
  assert.equal(r.next, 'look', 'after create, the look comes before the build');
  r = await L.step({});
  assert.equal(r.waiting, 'agent');
  assert.equal(r.kind, 'look');
  assert.match(r.message, /read the frames/);
  assert.deepEqual(r.dirs, ['/refs'], 'the round is told where the frames are');
  assert.deepEqual(r.action, { tool: 'gamesfun_step_look', args: { judged: {} }, returns: 'judged' });
  r = await L.step({ judged: JUDGED });
  assert.deepEqual(calls.finished, [JUDGED]);
  assert.equal(r.waiting, 'creator');
  assert.equal(r.about, 'looks');
  assert.deepEqual(r.looks.map(o => o.id), ['faithful', 'pushed']);
  assert.equal(r.action.tool, 'gamesfun_step_look');
  assert.equal(L.state.status, 'waiting-on-creator');
  r = await L.step({});
  assert.equal(r.about, 'looks', 'no pick: still with the person');
  r = await L.step({ pick: { option: 'nope' } });
  assert.equal(r.refused, 'no-such-look');
  r = await L.step({ pick: { option: 'pushed', words: 'louder is better' } });
  assert.equal(r.next, 'design', 'the look, then the play, before the build');
  assert.deepEqual(calls.applied, ['pushed']);
  assert.equal(L.state.look.pick.by, 'person');
  assert.ok(L.state.answers.includes('louder is better'));
  r = await L.step({});
  assert.equal(r.next, 'build', 'the spec carries its play: no designer round');
  r = await L.step({});
  assert.equal(r.kind, 'build');
  assert.match(r.message, /## The look \(chosen before this round\)/);
  assert.match(r.message, /The person picked "Pushed" \(louder\): "louder is better"/);
  assert.match(r.message, /- a bright sky/);
});

test('a spec that carries its target needs no reading round; options that cannot be drawn go on to the build, said', async t => {
  const { L } = await lookHost(t, { options: [{ ok: false, skipped: 'forge looks are its own presets; not mapped yet' }] });
  await L.step({ idea: PROMPT }); await L.step({ ledger: goodLedger() }); await L.step({});
  await L.step({ pitch: CARDS }); await L.step({ choice: { card: 'a' } });
  // the person's spec already holds a target
  L.state.candidate.spec = { ...SPEC, look: { target: TARGET } };
  await L.step({}); await L.step({});
  const r = await L.step({});
  assert.equal(r.next, 'design');
  assert.match(r.why, /could not be drawn \(forge looks are its own presets; not mapped yet\)/);
  assert.deepEqual(L.state.look.target, TARGET);
});

test('a host with no look tools goes from create to the play, then the build round', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-look-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g'); await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const L = await openLoop({ registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools({ game, arg: 'games/g' }), versions: B.versions({ game, arg: 'games/g' }) });
  const r = await toCreate(L);
  assert.equal(r.next, 'design');
  assert.equal((await L.step({})).next, 'build');
});

test('headless, the judge\'s best look is taken, else the first; the brief\'s look lines never name more than the target holds', () => {
  const answer = defaultAnswers();
  assert.deepEqual(answer({ about: 'looks', looks: [{ id: 'a', score: null }, { id: 'b', score: null }] }), { pick: { option: 'a', by: 'judge' } });
  assert.deepEqual(answer({ about: 'looks', looks: [{ id: 'a', score: 40 }, { id: 'b', score: 71 }, { id: 'c', score: 55 }] }), { pick: { option: 'b', by: 'judge' } });
  assert.deepEqual(actionOf({ waiting: 'creator', about: 'looks' }), { tool: 'gamesfun_step_look', args: { pick: { option: '', words: '' } }, returns: 'pick' });
  assert.deepEqual(lookLines(null), []);
  const lines = lookLines({ target: TARGET }).join('\n');
  assert.match(lines, /palette: #7eaee2 sky/);
  assert.match(lines, /never the reference's characters, names, logos or art/);
});
