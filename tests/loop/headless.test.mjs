// `gamesfun build`, headless, on the real registry and the real create, with `claude -p` stood in by a script
// (tests/loop/fake-claude.mjs) and verify's browser run by its record: every round is a session with the tools its
// kind names, the person's moves come from the answers hook, and the result has the eval runner's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT } from './fixtures/tag.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.GAMESFUN_WEB3 = '0';
const { buildHeadless, defaultAnswers } = await import('../../builder/loop/headless.mjs');
const { kitRegistry, kitTools, verdictOf } = await import('../../builder/loop/kit.mjs');

const raw = fail => ({ pass: !fail, required: [3, 13], checks: [{ n: 3, gate: 'B', name: 'boots', ok: true }, { n: 13, gate: 'C', name: 'controls', ok: !fail, detail: fail ? 'the tag press shows nothing' : '' }] });

test('gamesfun build: the whole loop headless, one session per round, the result in the eval runner\'s shape', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-headless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls.jsonl');
  Object.assign(process.env, { GAMESFUN_CLAUDE: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_SCRIPT: path.join(HERE, 'fixtures', 'fake-session.mjs'), FAKE_CLAUDE_LOG: log });
  const reg = await kitRegistry();
  let n = 0;
  const game = path.join(root, 'yard-tag');
  const r = await buildHeadless({ prompt: PROMPT, game, log: () => {}, kit: { registry: reg, tools: { ...kitTools({ registry: reg }), verify: async () => verdictOf(raw(++n === 1), { runtime: 'three' }) } } });
  assert.equal(r.delivered, true, JSON.stringify(r).slice(0, 800));
  assert.equal(r.outcome.outcome, 'delivered');
  for (const k of ['rescue', 'stopped', 'lastWords', 'game', 'questions', 'ladder', 'models', 'tokens', 'minutes', 'usd']) assert.ok(k in r, k);
  assert.equal(r.rescue, false);
  assert.equal(r.game.dir, game);
  assert.match(r.game.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.questions.length, 1, 'the cards went to the answers hook');
  assert.equal(r.questions[0].answered.choice.card, 'a');
  assert.ok(r.models.includes('fake-opus') && r.models.includes('fake-sonnet'), r.models.join(','));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls.map(c => c.kind), ['ledger', 'pitch', 'build', 'build', 'playtest', 'read']);
  const arg = (c, flag) => c.args[c.args.indexOf(flag) + 1];
  // a talk round reads the kit and writes nothing; the build round works in the game; the tester sees only its folder
  assert.equal(calls[0].cwd, path.resolve(HERE, '../..'));
  const section = (c, flag) => { const i = c.args.indexOf(flag); const j = c.args.findIndex((a, k) => k > i && a.startsWith('--')); return c.args.slice(i + 1, j < 0 ? undefined : j); };
  assert.ok(section(calls[0], '--allowedTools').includes('Read') && !section(calls[0], '--allowedTools').includes('Edit') && section(calls[0], '--disallowedTools').includes('Edit'));
  assert.equal(calls[2].cwd, game);
  assert.ok(section(calls[2], '--allowedTools').includes('Edit') && section(calls[2], '--allowedTools').includes('mcp__gamesfun__gamesfun_verify'));
  assert.ok(section(calls[2], '--allowedTools').includes('mcp__gamesfun__gamesfun_remove'), 'a build round can remove the files it made');
  assert.ok(section(calls[2], '--disallowedTools').includes('mcp__gamesfun__gamesfun_step_fix'), 'the loop tools are denied to a round');
  assert.ok(calls[4].args.some(a => /^Read\(\/\/.*playtest\/\*\*\)$/.test(a)), 'the tester reads only its own folder');
  assert.equal(arg(calls[4], '--model'), 'sonnet');
  assert.equal(arg(calls[0], '--permission-mode'), 'dontAsk');
  assert.deepEqual(JSON.parse(arg(calls[0], '--json-schema')).properties.ledger.properties.rows.items.properties.home, { enum: ['exists', 'build', 'probe'] }, 'the ledger round answers with a home that is a word');
  const kitRoot = path.resolve(HERE, '../..');
  for (const c of [calls[0], calls[2]]) assert.ok(section(c, '--disallowedTools').includes(`Read(/${kitRoot}/evals/**)`), 'no round reads the frozen evals (their answer key)');
  for (const c of calls) assert.ok(section(c, '--disallowedTools').includes('Agent') && section(c, '--disallowedTools').includes('Task'), `the ${c.kind} round starts no subagent`);
  assert.ok(calls.every(c => c.args.includes('--strict-mcp-config') && arg(c, '--setting-sources') === 'project,local'));
  const rec = JSON.parse(await readFile(r.record, 'utf8'));
  assert.equal(rec.schema, 'gf-headless/1');
  assert.equal(rec.rounds.length, 6);
  // the second reader: its own session that reads only the play-tester's runs and its own folder, and plays itself
  const rd = calls[5];
  assert.ok(section(rd, '--allowedTools').some(a => /^Read\(\/\/.*playtest\/runs\/\*\*\)$/.test(a)) && section(rd, '--allowedTools').includes('mcp__gamesfun__gamesfun_play'), section(rd, '--allowedTools').join(' '));
  assert.ok(section(rd, '--disallowedTools').includes('Edit') && section(rd, '--disallowedTools').includes('Bash'));
  assert.equal(r.outcome.reader.status, 'read');
  assert.equal(rec.reading.status, 'read');
  assert.ok(rec.rounds.every(x => x.transcript && existsSync(path.join(game, x.transcript))));
  assert.equal(rec.ledger.rows.length, 6);
  assert.ok(rec.promises.some(p => p.id === 'build.1'));
  assert.equal(r.outcome.ladderRecord.repairs, 1);
});

test('the default answers: card 1 with every default, a yes to a migration, the game as it is after two asks', () => {
  const a = defaultAnswers();
  assert.deepEqual(a({ about: 'cards', pitch: { cards: [{ id: 'x' }, { id: 'y' }], questions: [{ about: 'players', default: 'coop' }] } }), { choice: { card: 'x', answers: { players: 'coop' } } });
  assert.deepEqual(a({ about: 'migration' }), { approve: 'Yes, move it.' });
  assert.deepEqual(defaultAnswers({ migration: 'decline' })({ about: 'migration' }), { decline: 'No, keep it where it is.' });
  const q = { message: 'stuck', questions: [{ id: 'go', default: 'keep', options: [{ id: 'keep', label: 'Keep trying' }, { id: 'as-is', label: 'Deliver it as it is' }] }] };
  assert.deepEqual(a({ about: 'questions', questions: q, asked: 1 }), { answer: { words: 'Keep trying' } });
  assert.deepEqual(a({ about: 'questions', questions: q, asked: 3 }), { answer: { deliver: true, words: 'Deliver it as it is.' } });
});

test('a stopped build starts no new round', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-headless-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ac = new AbortController();
  let n = 0;
  const runner = async () => { n++; ac.abort('stopped by the person'); return { ok: false, error: 'claude exited (null) without a result', structured: null, models: [], tokens: {}, usd: 0, ms: 1 }; };
  const reg = await kitRegistry();
  const r = await buildHeadless({ prompt: PROMPT, game: path.join(root, 'g'), runner, signal: ac.signal, log: () => {}, kit: { registry: reg, tools: kitTools({ registry: reg }) } });
  assert.equal(n, 1, 'the round after the stop never started');
  assert.equal(r.delivered, false);
  assert.equal(r.stopped, 'wall-clock');
});
