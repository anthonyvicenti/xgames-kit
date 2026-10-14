// The gates' regressions (builder/gates/regressions, builder/gates/regress.mjs): each one is well formed, and the last
// green run on the GPU (regress.mjs --record) was made on the gates as they are now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { listRegressions, problemsOf, fingerprint, LAST_GREEN, judge } from '../builder/gates/regress.mjs';
import { GATE_IDS } from '../builder/tools/lib/verdict.mjs';
import { keysOf, ownControls, judgeTurn, judgeStop, speedAlong } from '../builder/tools/lib/controls-check.mjs';

test('every regression names its base, a gate, the measure inside it, why, and what it must print', async () => {
  const list = await listRegressions();
  assert.ok(list.length >= 3);
  for (const r of list) {
    assert.deepEqual(problemsOf(r), [], r.id);
    for (const g of r.mustFail ?? r.mustPass) assert.ok(GATE_IDS.includes(g), `${r.id}: gate ${g}`);
    for (const from of Object.values(r.files ?? {})) assert.ok(existsSync(`${r.dir}/${from}`), `${r.id}: ${from}`);
  }
  // every broken example has a control on the same base that passes the same measure
  for (const r of list.filter(x => x.mustFail)) assert.ok(list.some(c => c.mustPass && c.base === r.base && c.measure === r.measure), `${r.id}: no control on ${r.base} for measure ${r.measure}`);
});

test('the last green run was made on these gates (else: node builder/gates/regress.mjs --record, on the GPU)', async () => {
  assert.ok(existsSync(LAST_GREEN), 'no regressions/last-green.json');
  const last = JSON.parse(await readFile(LAST_GREEN, 'utf8'));
  const now = await fingerprint();
  const changed = Object.keys({ ...now.files, ...last.files }).filter(f => now.files[f] !== last.files[f]);
  assert.deepEqual(changed, [], `changed since the last green run (${last.date}): ${changed.join(', ')}`);
  assert.equal(last.ok, true);
  const ids = (await listRegressions()).map(r => r.id).sort();
  assert.deepEqual(last.results.map(r => r.id).sort(), ids);
});

test('judge: a broken example passes only when its gate fails for the reason it names', () => {
  const r = { mustFail: ['C'], measure: 13, detail: 'slid sideways' };
  const rec = (ok, detail) => ({ checks: [{ n: 13, gate: 'C', ok, detail }] });
  assert.equal(judge(r, rec(false, 'A D: the path turned 45° at once and then ran straight: the player slid sideways')).ok, true);
  assert.equal(judge(r, rec(false, 'the controls page stopped: no lobby in 90 s')).ok, false);
  assert.equal(judge(r, rec(true, 'ok')).ok, false);
  assert.equal(judge({ mustPass: ['C'], measure: 13 }, rec(true, 'ok')).ok, true);
});

test('a row\'s keys are read as a player reads them', () => {
  const k = l => keysOf(l).keys.map(x => x.key ?? `mouse:${x.mouse ?? 'wheel'}`);
  assert.deepEqual(k('A D / ← →'), ['KeyA', 'KeyD']);
  assert.deepEqual(k('W or ↑'), ['KeyW']);
  assert.deepEqual(k('Shift'), ['ShiftLeft']);
  assert.deepEqual(k('1-4'), ['Digit1']);
  assert.deepEqual(k('Right click'), ['mouse:right']);
  assert.deepEqual(k('Mouse'), ['mouse:move']);
  assert.deepEqual(k('Arrow keys'), ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
  assert.deepEqual(keysOf('the pedal').keys, []);
});

test('a named control the kit does not show is unshown; the kit\'s words and the game\'s rows are not', () => {
  const { rows, unshown } = ownControls({ primary: 'fire', move: 'drive', aim: '', steer: 'A/D: steer', more: [['A D', 'steer', '', 'turn'], ['R', 'reload']] });
  assert.deepEqual(unshown, ['steer']);
  assert.deepEqual(rows.map(r => [r.keys, r.does]), [['A D', 'turn'], ['R', null]]);
});

// a track: points every 100 ms along a path given by heading(t) (radians, three.js: forward = (sin, cos)) at `speed` m/s
const trackOf = (n, heading, speed = 8, from = { x: 0, z: 0, t: 0 }) => {
  const out = []; let { x, z } = from;
  for (let i = 0; i < n; i++) { const h = heading(i); x += Math.sin(h) * speed * 0.1; z += Math.cos(h) * speed * 0.1; out.push({ t: from.t + (i + 1) * 100, x, z }); }
  return out;
};

test('turn: a car that turns while the key is held passes; a strafe (a fixed slant at once) fails', () => {
  const pre = trackOf(12, () => 0);
  const car = trackOf(12, i => 0.15 * (i + 1), 8, pre.at(-1));          // 8.6° each 100 ms, all through the hold
  const strafe = trackOf(12, () => Math.PI / 4, 8, pre.at(-1));         // 45° at once, then straight
  const c = judgeTurn(pre, car), s = judgeTurn(pre, strafe);
  assert.equal(c.ok, true, c.why);
  assert.equal(s.ok, false, s.why);
  assert.match(s.why, /slid sideways/);
  assert.equal(judgeTurn(pre, trackOf(12, () => 0, 0.01, pre.at(-1))).ok, false);   // not moving: no turn to see
});

test('stop: slower than coasting, or backwards, passes; as fast as coasting fails', () => {
  assert.equal(judgeStop({ v0: 10, coast: 7, brake: 2 }).ok, true);
  assert.equal(judgeStop({ v0: 5, coast: 0, brake: -4 }).ok, true);       // a walker: S walks backwards
  assert.equal(judgeStop({ v0: 10, coast: 7, brake: 6.9 }).ok, false);
  assert.equal(judgeStop({ v0: 0, coast: 0, brake: 0 }).ok, false);
  const t = trackOf(10, () => 0, 5);
  assert.ok(Math.abs(speedAlong(t, [0, 1]) - 5) < 0.01);
});
