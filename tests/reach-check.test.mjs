// Gate D, measure 6's reach leg (builder/tools/lib/reach-check.mjs): what it fails and what it only reports. No browser:
// objectives reports as window.__game.objectives() gives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeReach } from '../builder/tools/lib/reach-check.mjs';

const seats = [{ seat: 0, at: [0, 10, 0], ok: true, places: 900, reaches: [1] }, { seat: 1, at: [4, 10, 0], ok: true, places: 900, reaches: [0] }];
const report = (objectives, parts = [{ id: 'pickup', count: objectives.length, asked: objectives.length, shortfall: null }], extra = {}) => ({ placement: true, walk: { cell: 0.5, nodes: 900 }, split: false, seats, parts, objectives, ...extra });
const berry = (id, ok, why = null, more = {}) => ({ kind: 'pickup', id, label: 'berry', x: 3, y: ok ? 10 : 0, z: -2, ok, ...(ok ? {} : { why, ground: -5.8, water: 0, from: [{ seat: 0, ok: false, why }, { seat: 1, ok: false, why }] }), ...more });

test('the creator\'s case: berries at sea level fail, named with where and why', () => {
  const r = judgeReach([report([berry('pickup:0', false, 'in water'), berry('pickup:1', true)])]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /berry pickup:0 at \(3\.0, 0\.0, -2\.0\): in water \(ground -5\.8, water 0\.0\) from every seat/);
});

test('a part that put none of what it was asked for fails, with its reason', () => {
  const r = judgeReach([report([], [{ id: 'pickup', count: 0, asked: 10, shortfall: { asked: 10, placed: 0, why: 'no open ground every seat reaches' } }])]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /pickup was asked for 10 and put 0 in play \(no open ground every seat reaches\)/);
});

test('every objective reachable passes; a thrown prop out of reach is reported, never failed', () => {
  const r = judgeReach([report([berry('pickup:0', true), { kind: 'prop', id: 'o:crate:1', label: 'crate', x: 30, y: -5, z: 0, ok: false, why: 'in water', required: false }])]);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /1 thrown prop .*out of reach \(o:crate:1: in water\): reported, not required/);
});

test('no report at all (a kit copy with no objectives) fails; a game with nothing to reach passes', () => {
  assert.equal(judgeReach([null]).ok, false);
  assert.equal(judgeReach([report([], [])]).ok, true);
});
