// Gate D's play leg in the loop: a play failure carries area 'play', its repeat goes to a game designer's round on
// the stronger model, and the repair brief carries the play judge's findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failingSet, observe, nextRound, newLadder } from '../../builder/loop/ladder.mjs';
import { repairMessage, playJudgeLines } from '../../builder/loop/messages.mjs';
import { verdictOf } from '../../builder/tools/lib/verdict.mjs';

const verdict = { failed: [{ gate: 'D', measure: 6, area: 'play', detail: 'does not play: fail: 8/100; most objectives cannot be reached' }] };
const pj = { verdict: 'fail', score: 8, bar: 50, advisory: true, hard: [{ part: 'objective', line: 'most objectives cannot be reached: 29 of 30 (pickup) are out of a player\'s reach (97%)', hard: true }],
  findings: [{ part: 'pace', line: '0.7 meaningful events a minute', source: 'measured' }, { part: 'clarity', line: 'no berries in sight', source: 'judged' }], change: ['put the berries on the island tops'], clips: ['/x/clip-1.jpg'] };

test("a play failure repeated climbs straight to a game designer's round on the stronger model", () => {
  const items = failingSet({ verdict });
  assert.deepEqual(items, [{ key: 'gate D:6', area: 'play' }]);
  let L = newLadder();
  L = observe(L, items, { after: 'verify' }).ladder;
  const o = observe(L, items, { after: 'verify' });
  assert.equal(o.stop, 'repeat');
  assert.deepEqual(o.climbed, ['model']);
  const { round } = nextRound(o.ladder);
  assert.deepEqual([round.kind, round.area, round.strong], ['specialist', 'play', true]);
  const msg = repairMessage({ round, after: 'verify', verify: verdict, playtest: null, promises: [], ladder: o.ladder, playJudge: pj });
  assert.match(msg, /# Specialist round: play/);
  assert.match(msg, /the game as a game: the objective/);
  assert.match(msg, /What makes it not a game yet \(fix these first\):\n- most objectives cannot be reached/);
  assert.match(msg, /watched, clarity: no berries in sight/);
  assert.match(msg, /put the berries on the island tops/);
});

test('the play lines only when measure 6 failed; a check\'s area reaches the verdict', () => {
  assert.deepEqual(playJudgeLines(pj, { failed: [{ gate: 'C', measure: 13 }] }), []);
  const v = verdictOf({ checks: [{ n: 6, ok: false, detail: 'does not play', area: 'play' }, { n: 12, ok: true }], required: [6, 12], pass: false });
  assert.deepEqual(v.failed, [{ gate: 'D', measure: 6, area: 'play', detail: 'does not play' }]);
});
