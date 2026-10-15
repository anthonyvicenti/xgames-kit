// The loop as one machine (a runner host, and a host that hands rounds over), and the MCP tools holding its order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { loopTools } from '../../builder/mcp/loop-tools.mjs';
import { fakeBindings, keepAll, scriptedVerify, seenTwo, touch } from './dryrun/fakes.mjs';
import { dryRun } from './dryrun/dry-run.mjs';
import { fakeRegistry, goodLedger, pitchV2, PROMPT, GATE_PLAY } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const SPEC = { specVersion: 2, play: { target: GATE_PLAY }, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const CARDS = pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: ['a', 'b'].map(id => ({ id, title: id, v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: SPEC })), questions: [] });

async function place(t) {
  const root = await mkdtemp(join(tmpdir(), 'gf-loop-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  return { root, game };
}

test('a runner host: the whole loop runs to a delivery, climbing the ladder on its own, with no count of rounds', async t => {
  const { root, game } = await place(t);
  const F = { gate: 'C', measure: 13, detail: 'nothing on touch' };
  const v = scriptedVerify([[F], [F], [F]]);
  const B = fakeBindings({ registry: reg, root, verify: v.verify });
  const G = { game, arg: 'games/g' };
  const rounds = [];
  let n = 0;
  const L = await openLoop({
    registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G), limits: B.limits,
    agent: async o => {
      rounds.push(`${o.kind}${o.area ? `:${o.area}` : ''}${o.strong ? '*' : ''}`);
      if (o.kind === 'ledger') return { ledger: goodLedger() };
      if (o.kind === 'pitch') return { pitch: CARDS };
      if (o.kind === 'ask') return { questions: { message: 'stuck', questions: [] } };
      await touch(game, 'rules.js', `// ${++n}`);
      return { summary: 'ok', controls: 'Mouse' };
    },
    playtester: async o => ({ promises: o.focus.map(seenTwo), summary: 'ok' }),
    reader: keepAll,
  });
  let r = await L.run({ idea: PROMPT });
  assert.equal(r.waiting, 'creator');
  assert.equal(r.about, 'cards');
  r = await L.run({ choice: { card: 'a' } });
  assert.equal(r.next, 'done');
  assert.equal(r.outcome.outcome, 'delivered');
  // verify 1–3 fail the same way: a repair, the stronger model, a feel specialist; the 4th passes
  assert.deepEqual(rounds, ['ledger', 'pitch', 'build', 'repair', 'repair*', 'specialist:feel*']);
  assert.deepEqual(r.outcome.ladder.map(c => c.rung), ['model', 'specialist']);
  assert.equal(r.outcome.ledger.rows.every(l => l.status === 'proven'), true);
});

test('a handed-over host: a step called out of order is refused and names the step; a restart resumes mid-ladder', async t => {
  const { root, game } = await place(t);
  const v = scriptedVerify([[{ gate: 'E', measure: 5 }]]);
  const B = fakeBindings({ registry: reg, root, verify: v.verify });
  const G = { game, arg: 'games/g' };
  const host = () => ({ registry: reg, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G) });
  let L = await openLoop(host());
  assert.equal((await L.step({}, { expect: 'verify' })).refused, 'out-of-order');
  assert.equal((await L.step({})).refused, 'no-idea');
  let r = await L.step({ idea: PROMPT });
  assert.equal(r.waiting, 'agent');
  assert.match(r.message, /# Ledger round/);
  r = await L.step({ ledger: goodLedger() });
  assert.equal(r.next, 'foundation');
  r = await L.step({}); assert.equal(r.next, 'pitch');
  r = await L.step({ pitch: CARDS }); assert.equal(r.about, 'cards');
  r = await L.step({ choice: { card: 'b' } }); assert.equal(r.next, 'spec');
  r = await L.step({}); assert.equal(r.next, 'create');
  r = await L.step({}); assert.equal(r.next, 'design');
  r = await L.step({}); assert.equal(r.next, 'build');
  r = await L.step({}); assert.equal(r.waiting, 'agent');
  await touch(game, 'rules.js', '// built');
  r = await L.step({ summary: 's', controls: 'c' }); assert.equal(r.next, 'fix');
  r = await L.step({}); r = await L.step({}); assert.equal(r.next, 'repair');
  r = await L.step({}); assert.equal(r.waiting, 'agent');
  // the process ends here; a new one reads the state and the round is still handed over
  L = await openLoop(host());
  assert.equal(L.state.step, 'repair');
  assert.equal(L.state.handed.kind, 'repair');
  assert.equal(L.state.ladder.sets.length, 1);
  await touch(game, 'rules.js', '// repaired');
  r = await L.step({ summary: 's2' }); assert.equal(r.next, 'fix');
});

test('the MCP tools refuse a call out of order, and take a report only with the round\'s token', async t => {
  const { root } = await place(t);
  const tools = loopTools(fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify }));
  const T = name => tools.find(x => x.name === name).handler;
  const g = { game: 'games/g' };
  let a = (await T('gamesfun_next')(g)).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_ledger');
  let r = await T('gamesfun_step_verify')(g);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.refused, 'out-of-order');
  assert.equal(r.structuredContent.next, 'gamesfun_step_ledger');
  await T('gamesfun_step_ledger')({ ...g, idea: PROMPT });
  await T('gamesfun_step_ledger')({ ...g, ledger: goodLedger() });
  r = await T('gamesfun_step_create')(g);
  assert.equal(r.structuredContent.next, 'gamesfun_step_foundation');
  await T('gamesfun_step_foundation')(g);
  await T('gamesfun_step_pitch')(g);
  a = (await T('gamesfun_step_spec')({ ...g, pitch: CARDS })).structuredContent;
  assert.equal(a.waitingOn, 'the person');
  r = await T('gamesfun_step_spec')(g);
  assert.equal(r.structuredContent.refused, 'waiting-on-creator');
  await T('gamesfun_step_pitch')({ ...g, choice: { card: 'a' } });
  await T('gamesfun_step_spec')(g);
  a = (await T('gamesfun_step_create')(g)).structuredContent;
  assert.equal(a.round.kind, 'build');
  await touch(join(root, 'games', 'g'), 'rules.js', '// x');
  await T('gamesfun_step_fix')({ ...g, summary: 's', controls: 'c' });
  await T('gamesfun_step_verify')(g);
  a = (await T('gamesfun_step_playtest')(g)).structuredContent;
  const token = /Your report token: (\w+)/.exec(a.round.message)[1];
  const asked = [...a.round.message.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  r = await T('gamesfun_step_playtest')(g);
  assert.equal(r.structuredContent.refused, 'no-report');
  const report = { promises: asked.map(seenTwo) };
  assert.equal((await T('gamesfun_playtest_report')({ ...g, token: 'wrong', report })).structuredContent.refused, 'bad-token');
  assert.equal((await T('gamesfun_playtest_report')({ ...g, token, report: { promises: [] } })).structuredContent.refused, 'bad-report');
  assert.equal((await T('gamesfun_playtest_report')({ ...g, token, report })).structuredContent.ok, true);
  a = (await T('gamesfun_step_playtest')(g)).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_read', 'the second reader comes before delivery');
  assert.equal((await T('gamesfun_step_deliver')(g)).structuredContent.refused, 'out-of-order');
  // the reading: its own token, its own refusals; the session cannot hand one in for the reader
  a = (await T('gamesfun_step_read')(g)).structuredContent;
  assert.equal(a.round.kind, 'read');
  const rtoken = /Your reading token: (\w+)/.exec(a.round.message)[1];
  assert.doesNotMatch(a.round.message, /src\/hook\.js|"runtime"|specVersion/, 'the reader never sees how the build meant to do it, nor the spec');
  const ids = [...a.round.message.split('## The ledger')[1].split('## What the game promises')[0].matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  assert.ok(ids.includes('hook') && ids.length >= 5, ids.join(','));
  assert.equal((await T('gamesfun_step_read')(g)).structuredContent.refused, 'no-reading');
  const reading = { rows: ids.map(id => ({ id, mark: id === 'boss' ? 'lost' : 'kept', why: id === 'boss' ? 'no boss on any capture' : 'shown', evidence: id === 'boss' ? [] : ['x.jpg'] })), findings: ['the gate is small'], summary: 'A gate game.' };
  assert.equal((await T('gamesfun_reader_report')({ ...g, token, reading })).structuredContent.refused, 'bad-token', 'the play-test token is not the reading token');
  assert.equal((await T('gamesfun_reader_report')({ ...g, token: rtoken, reading: { rows: [], summary: '' } })).structuredContent.refused, 'bad-reading');
  assert.equal((await T('gamesfun_reader_report')({ ...g, token: rtoken, reading })).structuredContent.ok, true);
  a = (await T('gamesfun_step_read')(g)).structuredContent;
  assert.equal(a.tool, 'gamesfun_step_deliver');
  a = (await T('gamesfun_step_deliver')(g)).structuredContent;
  assert.equal(a.outcome.outcome, 'delivered', 'the reader is advisory: the outcome is the proof\'s');
  assert.equal(a.outcome.reader.status, 'read');
  assert.equal(a.outcome.reader.marks.lost, 1);
  assert.match(a.outcome.reader.words, /did not find everything kept.*lost, no boss on any capture/);
  assert.equal(a.outcome.ledger.rows.find(r => r.id === 'boss').reader.mark, 'lost');
  assert.equal(a.after.tool, 'gamesfun_change');
});

test('the dry run: every rung climbed, the answer re-enters at the ledger, a look change holds play, a migration waits for a yes', async () => {
  const r = await dryRun({ quiet: true, write: false });
  assert.deepEqual(r.climbs, ['model', 'specialist', 'generate', 'ask']);
  assert.deepEqual(r.climbs2, ['model', 'specialist', 'generate (skipped)', 'ask']);
  assert.deepEqual(r.resumed, { step: 'repair', round: 'specialist', area: 'feel', rung: 'specialist' });
  assert.equal(r.lookRefused, true);
  assert.equal(r.migration.to, 'vista');
  assert.deepEqual(r.deliveries.map(d => d.outcome), ['delivered-with-issues', 'delivered-with-issues', 'delivered']);
  const first = Object.fromEntries(r.deliveries[0].ledger.map(l => [l.id, l.status]));
  assert.equal(first.boss, 'failed');
  assert.equal(first.phone, 'untested');
  assert.equal(first.hook, 'proven');
  assert.ok(r.brief.hasChosen && !r.brief.hasUnchosen);
  assert.ok(r.said.includes('specialist:feel') && r.said.includes('generating') && r.said.includes('asking') && r.said.includes('rescuing'));
  assert.ok(r.calls.every(c => !c.refused || ['out-of-order'].indexOf(c.refused) < 0));
});

test('the build-loop skill is generated from the order and the tools, and matches', async () => {
  const { readFile } = await import('node:fs/promises');
  const { buildLoopSkill, INSTRUCTIONS } = await import('../../scripts/gen-loop.mjs');
  assert.equal(await readFile(new URL('../../skills/build-loop/SKILL.md', import.meta.url), 'utf8'), buildLoopSkill());
  assert.match(INSTRUCTIONS, /gamesfun_step_ledger → gamesfun_step_foundation → gamesfun_step_pitch/);
});
