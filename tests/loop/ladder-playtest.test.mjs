// The stop rule, the ladder, and the play-tester's report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingSet, focusOf, ladderRecordOf, newLadder, nextRound, observe, readReport, resetLadder, sayKeyOf, stopRule } from '../../builder/loop/index.mjs';

const F = (gate, measure, area) => ({ gate, measure, ...(area ? { area } : {}) });
const set = (...f) => failingSet({ verdict: { failed: f } });
const C13 = set(F('C', '13')), E5 = set(F('E', '5')), A19 = set(F('A', '19', 'art'));

function walk(results) {
  let L = newLadder();
  const log = [];
  for (const [items, opts = {}] of results) {
    const o = observe(L, items, { after: 'verify', ...opts });
    L = o.ladder;
    const n = nextRound(L);
    L = n.ladder;
    log.push({ stop: o.stop, climbed: o.climbed, round: n.round });
  }
  return { L, log };
}

test('the same set twice climbs to the stronger model; an earlier set back climbs to specialists, one per area', () => {
  const { L, log } = walk([[C13], [C13], [E5], [C13]]);
  assert.equal(log[0].round.kind, 'repair');
  assert.equal(log[0].round.strong, false);
  assert.deepEqual([log[1].stop, log[1].climbed, log[1].round.strong], ['repeat', ['model'], true]);
  assert.equal(log[2].stop, null);
  assert.equal(log[2].round.strong, true);              // the model rung holds for every round after it
  assert.deepEqual([log[3].stop, log[3].climbed, log[3].round.kind, log[3].round.area], ['returned', ['specialist'], 'specialist', 'feel']);
  assert.equal(L.rung, 'specialist');
});

test('a specialist rung owes one round per area before the rule can climb again', () => {
  const mixed = set(F('A', '19', 'art'), F('E', '5'));
  const { log } = walk([[mixed], [mixed], [mixed], [mixed], [mixed]]);
  // repeat → model; repeat → specialist (art, netcode); the netcode round runs even though the set repeats; then generate
  assert.deepEqual(log.map(l => l.round.kind), ['repair', 'repair', 'specialist', 'specialist', 'generate']);
  assert.deepEqual([log[2].round.area, log[3].round.area], ['art', 'netcode']);
  assert.deepEqual(log[4].round.areas, ['art']);
});

test('generate is skipped when nothing a generator can make is stuck; the top rung asks', () => {
  const { L, log } = walk([[E5], [E5], [E5], [E5]]);
  assert.deepEqual(log.at(-1).climbed, ['generate (skipped)', 'ask']);
  assert.equal(log.at(-1).round.kind, 'ask');
  assert.match(L.climbs.find(c => c.rung === 'generate').skipped, /nothing in the stuck set/);
});

test('a round that changed nothing and still fails climbs at once', () => {
  assert.equal(stopRule([{ key: 'a', items: [1] }, { key: 'b', items: [1] }], { unchanged: true }), 'unchanged');
  const { log } = walk([[C13], [E5, { unchanged: true }]]);
  assert.deepEqual(log[1].climbed, ['model']);
});

test('there is no count of rounds: new sets keep plain repairs going; the ladder is plain data a restart reads back', () => {
  const sets = Array.from({ length: 12 }, (_, i) => set(F('F', String(i))));
  const { L, log } = walk(sets.map(s => [s]));
  assert.ok(log.every(l => l.round.kind === 'repair' && !l.climbed.length));
  assert.deepEqual(JSON.parse(JSON.stringify(L)), L);
  assert.equal(resetLadder({ ...L, strong: true }).strong, true);
});

test('play-test items: not seen and unreachable fail; areas come from the promise', () => {
  const items = failingSet({ playtest: { answers: { 'build.1': { status: 'not-seen' }, 'control.hook': { status: 'unreachable' }, 'row.a': { status: 'seen' } } }, promises: [{ id: 'build.1', kind: 'build' }, { id: 'control.hook', kind: 'control' }] });
  assert.deepEqual(items.map(i => `${i.key}/${i.area}`), ['play build.1:not-seen/code', 'play control.hook:unreachable/feel']);
});

test('the progress keys are Studio\'s LADDER_SAY keys; the ladder record is what Studio\'s ladderRecord takes', () => {
  const L = { climbs: [{ rung: 'model' }] };
  assert.equal(sayKeyOf({ kind: 'repair', strong: true }, { ladder: L }), 'rescuing');
  assert.equal(sayKeyOf({ kind: 'repair', strong: false }, { after: 'playtest' }), 'playRepairing');
  assert.equal(sayKeyOf({ kind: 'specialist', area: 'art' }), 'specialist');
  assert.equal(sayKeyOf({ kind: 'generate' }), 'generating');
  const r = ladderRecordOf({ rounds: [{ kind: 'build' }, { kind: 'repair' }, { kind: 'repair', strong: true }, { kind: 'specialist' }, { kind: 'generate' }], ladder: { climbs: [{ rung: 'ask', reason: 'repeat' }] }, ladders: [] });
  assert.deepEqual(r, { repairs: 2, rescues: 1, rescueModel: 'strong', specialist: 1, generated: 1, asked: true, stop: 'repeat' });
});

test('a report answers every promise asked as seen (with evidence), not-seen or unreachable (with a note)', () => {
  const asked = ['a', 'b', 'c'];
  let r = readReport({ promises: [{ id: 'a', status: 'seen', evidence: ['x.jpg'] }, { id: 'b', status: 'seen' }, { id: 'z', status: 'seen', evidence: ['y'] }] }, asked);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /"seen" needs what you saw/.test(p)));
  assert.ok(r.problems.some(p => /"z" was not asked/.test(p)));
  assert.ok(r.problems.some(p => /no answer for "c"/.test(p)));
  r = readReport({ promises: [{ id: 'a', status: 'seen', evidence: ['x'] }, { id: 'b', status: 'unreachable', note: 'got to wave 2' }, { id: 'c', status: 'not-seen', note: 'nothing' }] }, asked);
  assert.equal(r.ok, true);
  const promises = [{ id: 'a', kind: 'row' }, { id: 'b', kind: 'build' }, { id: 'c', kind: 'row' }, { id: 'd', kind: 'row' }];
  assert.deepEqual(focusOf(promises, { answers: r.answers }), ['b', 'c', 'd']);   // a re-test: what failed, every build line, what was never asked
});
