// The loop bound to this kit (builder/loop/kit.mjs, builder/mcp/tools/loop.mjs): the real registry, the real create,
// the sealed state and play-test token, the checkpoints; only verify's browser run is stood in (a verdict in verify's
// own format, read through the same reader). No model: the session's rounds are written here.
import { CARD_WORDS, pitchV2 } from './fixtures/registry.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG = await mkdtemp(path.join(os.tmpdir(), 'gf-kit-loop-config-'));
process.env.GAMESFUN_CONFIG_DIR = CONFIG;
process.env.GAMESFUN_WEB3 = '0';
const { kitRegistry, kitTools, verdictOf } = await import('../../builder/loop/kit.mjs');
const { loadSchemas, SCHEMA } = await import('../../registry/schemas.mjs');
const loopMod = await import('../../builder/mcp/tools/loop.mjs');

import { PROMPT, TAG_LEDGER, tagSpec } from './fixtures/tag.mjs';

/** verify's own record (gf-three-verify/1) for a run that passed, or failed one measure of gate C. */
const RAW = fail => ({ schema: 'gf-three-verify/1', pass: !fail, required: [1, 2, 3, 4, 5, 6, 12, 13],
  checks: [[1, 'A'], [2, 'A'], [4, 'A'], [3, 'B'], [9, 'B'], [13, 'C'], [6, 'D'], [12, 'D'], [5, 'E']].map(([n, gate]) => ({ n, gate, name: `measure ${n}`, ok: n === 9 ? null : fail && n === 13 ? false : true, detail: n === 9 ? '--quick' : n === 13 ? 'the tag button does nothing on screen' : '', ...(fail && n === 13 ? { rule: 'every input shows', fix: 'make the tag visible' } : {}) })) });

test('verify\'s verdict is read as written; a whole record goes through verify\'s own verdictOf; nothing written is a fail of B', async () => {
  const { validate } = await loadSchemas();
  const ok = verdictOf(RAW(false), { runtime: 'three', profile: 'standard-3d', loop: 'round' });
  assert.equal(ok.pass, true);
  assert.deepEqual([ok.gates.B.ran, ok.gates.B.passed, ok.gates.B.skipped.map(x => x.measure), ok.gates.B.ok], [[3], [3], [9], true]);
  assert.deepEqual(verdictOf(ok, { outDir: '/x' }), { ...ok, evidence: '/x' }, 'a verdict.json is taken as it is');
  assert.deepEqual(validate(SCHEMA.verdict, ok), []);
  const bad = verdictOf(RAW(true), { runtime: 'three' });
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.failed.map(f => `${f.gate}:${f.measure}`), ['C:13']);
  assert.equal(bad.gates.C.ok, false);
  assert.deepEqual(validate(SCHEMA.verdict, bad), []);
  const none = verdictOf(null, { runtime: 'three', code: 1, stderr: 'Error: boom' });
  assert.equal(none.pass, false);
  assert.match(none.failed[0].detail, /wrote no verdict\.json.*boom/);
});

test('a spec v2 is checked against its schema, the registry and create itself; create reads it', async () => {
  const reg = await kitRegistry();
  const tools = kitTools({ registry: reg });
  assert.deepEqual(await tools.checkSpec(tagSpec()), []);
  const bad = await tools.checkSpec({ ...tagSpec(), runtime: 'nope' });
  assert.ok(bad.some(p => /runtime/.test(p)), bad.join('\n'));
  const old = await tools.checkSpec({ ...tagSpec(), specVersion: 0, engine: 'party' });
  assert.ok(old.some(p => /not a spec v2/.test(p)), 'an older spec is refused, never read');
});

test('the bound tools: the real registry, create and checkpoints, the sealed token; a round, a repair, a delivery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-kit-loop-'));
  t.after(async () => { loopMod.seams.tools = null; await rm(root, { recursive: true, force: true }); await rm(CONFIG, { recursive: true, force: true }); });
  const game = path.join(root, 'yard-tag');
  let verifies = 0;
  // the real tools, with verify's browser run stood in by its record (one fail, then passes)
  const reg = await kitRegistry();
  loopMod.seams.tools = () => ({ ...kitTools({ registry: reg }), verify: async () => verdictOf(RAW(++verifies === 1), { runtime: 'three' }) });
  const by = Object.fromEntries(loopMod.tools.map(x => [x.name, x]));
  const ctx = { log: () => {}, progress: () => {} };
  const call = async (name, args = {}) => { const r = await by[name].handler({ game, ...args }, ctx); if (!r?.content) return r; const v = JSON.parse(r.content[0].text); if (r.isError) v.isError = true; return v; };

  let a = await call('gamesfun_next');
  assert.equal(a.tool, 'gamesfun_step_ledger');
  a = await call('gamesfun_step_create');
  assert.equal(a.refused, 'out-of-order');
  a = await call('gamesfun_step_ledger', { idea: PROMPT });
  assert.equal(a.round.kind, 'ledger');
  assert.match(a.round.message, /together-timed/, 'the ledger round carries the registry\'s words');
  a = await call('gamesfun_step_ledger', { ledger: TAG_LEDGER });
  assert.equal(a.step, 'foundation', JSON.stringify(a.problems));
  a = await call('gamesfun_step_foundation');
  assert.equal(a.step, 'pitch');
  a = await call('gamesfun_step_pitch');
  assert.equal(a.round.kind, 'pitch');
  assert.match(a.round.message, /three\/standard-3d/);
  const card = (id, title) => ({ ...CARD_WORDS, id, title, v1: { has: ['a tag round'], build: ['a backyard with cover to run around'], notYet: [] }, spec: tagSpec(title) });
  a = await call('gamesfun_step_spec', { pitch: pitchV2({ reply: 'Card 1 is a tag round in a backyard. A backyard with cover to run around is built new for this game, which makes the build take a little longer.', cards: [card('a', 'Yard Tag'), card('b', 'Fence Tag')], questions: [] }) });
  assert.equal(a.waitingOn, 'the person', JSON.stringify(a.problems));
  a = await call('gamesfun_step_pitch', { choice: { card: 'a' } });
  assert.equal(a.tool, 'gamesfun_step_spec');
  a = await call('gamesfun_step_spec');
  assert.equal(a.step, 'create', JSON.stringify(a));
  a = await call('gamesfun_step_create');
  assert.equal(a.step, 'build', JSON.stringify(a.problems ?? a.why));
  assert.equal(a.round.kind, 'build');
  assert.ok(existsSync(path.join(game, 'rules.js')) && existsSync(path.join(game, 'assets.json')), 'the real create made the game');
  assert.match(a.round.message, /## The five rules/);
  assert.match(a.round.message, /Mechanic: tag/);
  assert.match(a.round.message, /the preset on three\/standard-3d: look `jelly-pastel`/, 'the chosen kind\'s preset is in the brief');
  assert.ok(a.round.message.length < 10000);
  assert.ok((await call('gamesfun_next')).checkpoints.some(c => c.name === 'created') && (await call('gamesfun_next')).checkpoints.some(c => c.name === 'round-1'), 'checkpoints before the round');
  // a hand-edited state file is put back from the seal
  const stateFile = path.join(game, '.gf-loop', 'state.json');
  const before = await readFile(stateFile, 'utf8');
  await writeFile(stateFile, before.replace('"step": "build"', '"step": "deliver"'));
  a = await call('gamesfun_next');
  assert.equal(a.step, 'build', 'the sealed state stands');
  // the round: rules.js written, then fix → verify (fails C:13) → repair → fix → verify (passes)
  await writeFile(path.join(game, 'rules.js'), (await readFile(path.join(game, 'rules.js'), 'utf8')) + '\n// round 1\n');
  a = await call('gamesfun_step_fix', { summary: 'Tag your friends.', controls: 'WASD, click to tag' });
  assert.equal(a.step, 'verify');
  a = await call('gamesfun_step_verify');
  assert.equal(a.step, 'repair');
  a = await call('gamesfun_step_repair');
  assert.equal(a.round.kind, 'repair');
  assert.match(a.round.message, /gate C, 13: the tag button does nothing/);
  await writeFile(path.join(game, 'rules.js'), (await readFile(path.join(game, 'rules.js'), 'utf8')) + '\n// round 2\n');
  a = await call('gamesfun_step_fix', { summary: 'Tag shows now.', controls: 'WASD, click to tag' });
  a = await call('gamesfun_step_verify');
  assert.equal(a.step, 'playtest');
  // the play-test: the token is in the round's message; a report without it is refused
  a = await call('gamesfun_step_playtest');
  const token = /Your report token: (\S+)/.exec(a.round.message)[1];
  const asked = [...a.round.message.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  assert.ok(asked.includes('build.1') && asked.includes('row.tag') && asked.includes('loop.closes'), asked.join(','));
  // the friends promise rests on a two-player run: its record is where gamesfun_play writes it
  const { TWO_SEATS } = await import('./dryrun/fakes.mjs');
  await mkdir(path.join(game, '.gf-loop', 'job', 'playtest', 'runs', 'r'), { recursive: true });
  await writeFile(path.join(game, '.gf-loop', 'job', 'playtest', 'runs', 'r', 'play.json'), JSON.stringify(TWO_SEATS));
  const report = { promises: asked.map(id => ({ id, status: 'seen', evidence: [`runs/r/${id}.jpg`], screens: { host: 'my friend tags me', friend: 'I tag the host' } })), feel: ['fun'], summary: 'played a round' };
  assert.equal((await call('gamesfun_playtest_report', { token: 'pt_nope', report })).refused, 'bad-token');
  assert.equal((await call('gamesfun_playtest_report', { token, report })).ok, true);
  assert.equal((await call('gamesfun_playtest_report', { token, report })).refused, 'bad-token', 'one report per token');
  a = await call('gamesfun_step_playtest');
  assert.equal(a.step, 'read', JSON.stringify(a));
  // the second reader: its own sealed token; the play-tester's screenshots are its captures
  a = await call('gamesfun_step_read');
  const rtoken = /Your reading token: (\S+)/.exec(a.round.message)[1];
  const ids = [...a.round.message.split('## The ledger')[1].split('## What the game promises')[0].matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  const reading = { rows: ids.map(id => ({ id, mark: 'kept', why: 'shown', evidence: ['runs/r/a.jpg'] })), findings: [], summary: 'A tag game.' };
  assert.equal((await call('gamesfun_reader_report', { token, reading })).refused, 'bad-token');
  assert.equal((await call('gamesfun_reader_report', { token: rtoken, reading })).ok, true);
  a = await call('gamesfun_step_read');
  assert.equal(a.step, 'deliver', JSON.stringify(a));
  a = await call('gamesfun_step_deliver');
  assert.equal(a.outcome.reader.status, 'read');
  assert.equal(a.step, 'done');
  assert.equal(a.outcome.outcome, 'delivered');
  assert.deepEqual(a.outcome.ledger.failed, []);
  assert.equal(a.outcome.ladderRecord.repairs, 1);
  // rollback restores a checkpoint byte for byte
  a = await call('gamesfun_rollback', { checkpoint: 'created' });
  assert.equal(a.restored, 'created');
  assert.doesNotMatch(await readFile(path.join(game, 'rules.js'), 'utf8'), /round 1/);
});
