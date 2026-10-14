// The loop adapters: the new arm is `gamesfun build` (pinned to this repository's commit), the old arm needs its pinned
// checkout, and a case's answers become the loop's answers hook. (A whole run is tests/loop/headless.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOPS, NotWired, answersFor, OLD_PROMPT } from '../lib/arms.mjs';

test('the new arm pins this repository\'s commit; the old arm says what it needs when its checkout is not there', () => {
  assert.match(LOOPS.new.pin().commit, /^[0-9a-f]{40}$/);
  const was = process.env.XGK_OLD_LOOP_DIR;
  delete process.env.XGK_OLD_LOOP_DIR;
  try { assert.throws(() => LOOPS.old.pin(), NotWired); } finally { if (was) process.env.XGK_OLD_LOOP_DIR = was; }
  assert.match(OLD_PROMPT('a racing game', '/x/games/pa10'), /gamesfun_next first[\s\S]*concept 1/);
});

test('a case\'s answers are the loop\'s answers hook: accept takes every default; the runner\'s own answer wins', async () => {
  const a = await answersFor({ inputs: { answers: { default: 'accept' } } });
  assert.deepEqual(a({ about: 'cards', pitch: { cards: [{ id: 'c1' }, { id: 'c2' }], questions: [] } }), { choice: { card: 'c1', answers: {} } });
  const b = await answersFor({ inputs: { answers: { card: 'c2', words: 'the second one, longer rounds' } } });
  assert.deepEqual(b({ about: 'cards', pitch: { cards: [{ id: 'c1' }, { id: 'c2' }] } }).choice, { card: 'c2', answers: {}, words: 'the second one, longer rounds' });
  const c = await answersFor({ answer: q => ({ seen: q.about }), inputs: {} });
  assert.deepEqual(await c({ about: 'questions' }), { seen: 'questions' });
});
