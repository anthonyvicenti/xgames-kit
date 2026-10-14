// A param whose default follows the game's own config (rules audit, 2026-10-14). soak-squad's spec once set the
// stream's reach to 12 m by hand so measure 13 passed under the silly kind's high camera; now the projectile derives it
// from the camera (components/projectile derive, kit/controller/camera-rig.js restAimDistance), and the spec's own
// value always wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from '../builder/tools/create.mjs';
import { REPO } from '../builder/tools/lib/paths.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { tempDir } from './helpers.mjs';

test('the crosshair\'s rest distance comes from the rig\'s own numbers', async () => {
  const { restAimDistance } = await importLayer('runtimes/three/kit/controller/camera-rig.js');
  assert.ok(Math.abs(restAimDistance('third', { height: 3.2 }) - 3.2 / Math.tan(16 * Math.PI / 180)) < 1e-9);
  assert.ok(restAimDistance('third', {}) < 9, 'the default rig rests within the default reach');
  assert.equal(restAimDistance('first', {}), null);
  assert.equal(restAimDistance('top', {}), null);
});

test('a stream reaches where the game\'s camera rests; the spec\'s own reach wins', async () => {
  const tmp = await tempDir();
  try {
    const spec = JSON.parse(await readFile(path.join(REPO, 'examples/minimal/soak-squad/spec.json'), 'utf8'));
    assert.equal(spec.mechanics.find(m => m.id === 'projectile').params.streamReach, undefined, 'the example no longer tunes it by hand');
    const a = path.join(tmp.dir, 'a');
    const r = await create(path.join(REPO, 'examples/minimal/soak-squad/spec.json'), a);
    assert.equal(r.ok, true, (r.problems ?? []).join('; '));
    const game = JSON.parse(await readFile(path.join(a, 'config/game.json'), 'utf8'));
    const reach = game.mechanics.find(m => m.id === 'projectile').params.streamReach;
    const cam = game.controller.camera.third, rest = cam.height / Math.tan((cam.pitchDeg ?? 16) * Math.PI / 180);
    assert.ok(reach >= rest, `the stream (${reach} m) reaches the crosshair at rest (${rest.toFixed(1)} m)`);
    assert.ok(r.notes.some(n => /mechanic projectile: streamReach \d+, from the game's own config/.test(n)));
    const own = path.join(tmp.dir, 'own.json');
    spec.mechanics.find(m => m.id === 'projectile').params.streamReach = 7;
    await writeFile(own, JSON.stringify(spec));
    const b = path.join(tmp.dir, 'b');
    assert.equal((await create(own, b)).ok, true);
    const g2 = JSON.parse(await readFile(path.join(b, 'config/game.json'), 'utf8'));
    assert.equal(g2.mechanics.find(m => m.id === 'projectile').params.streamReach, 7);
  } finally { await tmp.cleanup(); }
});

test('fair play\'s pages play on to the game\'s own round while nothing has scored, capped', async () => {
  const { playOnFor, PLAY_ON_MAX_SECONDS } = await import('../builder/tools/lib/fair-check.mjs');
  assert.equal(playOnFor({ round: { seconds: 300 } }, 42), PLAY_ON_MAX_SECONDS, 'a long round: up to the cap');
  assert.equal(playOnFor({ round: { seconds: 90 } }, 42), 90, 'the game\'s own round');
  assert.equal(playOnFor({ round: { seconds: 20 } }, 42), 42, 'never shorter than the check\'s own play');
  assert.equal(playOnFor(null, 42), 42);
});

test('a score the game\'s own end of round leaves on its results counts as held, a flicker does not', async () => {
  const { measure } = await import('../builder/tools/lib/fair-check.mjs');
  const P = (score, phase = 'playing') => ({ phase, players: [{ id: 'a', local: true, alive: true, control: true, score }, { id: 'b', bot: true, alive: true, control: true, score: 0 }] });
  const at = (s, wall) => ({ ...s, t: wall, wall });
  const race = [...Array.from({ length: 280 }, (_, i) => at(P(0), i / 10)), at(P(3, 'results'), 28.1)];
  assert.equal(measure(race).scoreMoved, true, 'won at the line: the results hold it');
  const flicker = [...Array.from({ length: 50 }, (_, i) => at(P(i === 20 ? 2 : 0), i / 10))];
  assert.equal(measure(flicker).scoreMoved, false);
});
