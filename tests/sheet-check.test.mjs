// verify measure 9 (builder/tools/lib/sheet-check.mjs): the verdict reads what a frame asks of the GPU and the frame
// rate against the calibration page beside it, never a flat frame rate a busy machine fails on any game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { judgeSheet, SHEET_LIMITS, CALIBRATE } from '../builder/tools/lib/sheet-check.mjs';

const hi = (o = {}) => ({ quality: 'high', fps: 60, cal: 60, ratio: 1, calls: 200, triangles: 3e5, ...o });
const lo = (o = {}) => ({ quality: 'low', fps: 58, cal: 60, ratio: 0.97, calls: 180, triangles: 2.6e5, ...o });
const m = (perf, extra = {}) => ({ problems: [], coverage: [{ size: '1920x1080', untagged: [] }], perf, shots: 8, ...extra });

test('a game that keeps up with the calibration page passes, however slow both are', () => {
  assert.equal(judgeSheet(m([hi(), lo()])).ok, true);
  // a busy machine: both pages at 34 fps; the old flat 58 fps would have failed this game
  assert.equal(judgeSheet(m([hi({ fps: 34, cal: 35, ratio: 34 / 35 }), lo({ fps: 22, cal: 33, ratio: 22 / 33 })])).ok, true);
});

test('a game that falls behind the calibration page, or asks too much of a frame, fails and says why', () => {
  const slow = judgeSheet(m([hi({ fps: 30, cal: 60, ratio: 0.5 }), lo()]));
  assert.equal(slow.ok, false); assert.match(slow.fails.join(' '), /30 fps on the high tier against 60 fps/);
  const heavy = judgeSheet(m([hi({ calls: SHEET_LIMITS.CALLS + 1 })]));
  assert.equal(heavy.ok, false); assert.match(heavy.fails.join(' '), /draw calls/);
  assert.equal(judgeSheet(m([hi({ triangles: 5e6 })])).ok, false);
  assert.equal(judgeSheet(m([hi(), lo({ ratio: 0.3, fps: 18 })])).ok, false);
});

test('no shots, untagged meshes or a problem on the page fail', () => {
  assert.equal(judgeSheet(m([hi()], { shots: 0 })).ok, false);
  assert.equal(judgeSheet(m([hi()], { coverage: [{ size: '390x844', untagged: [{ path: 'scene/cone' }] }] })).ok, false);
  assert.equal(judgeSheet(m([hi()], { problems: ['console errors at 1920x1080: boom'] })).ok, false);
});

test('the tool ships beside verify, and its calibration page measures as the game\'s look does', () => {
  assert.ok(existsSync(new URL('../builder/tools/lib/sheet-check.mjs', import.meta.url)));
  assert.match(CALIBRATE, /window\.__cal = \{ perf:/);
  assert.match(CALIBRATE, /requestAnimationFrame/);
});
