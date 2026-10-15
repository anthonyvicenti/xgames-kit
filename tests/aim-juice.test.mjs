// The aim mechanic's pure parts (components/aim/logic.js) and the kit's juice (runtimes/three/kit/core/juice.js): the
// launch, wind and charge, the predicted path, a bot's solved shot landing on its target with the wind in it, weapons as
// data; the juice's sizes from one number, the time scale over a hitstop and a slow motion, and the comfort setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchDir, shellStep, predictPath, chargeAt, windFor, windAlong, solveShot, weaponsOf } from '../components/aim/logic.js';
import { fileURLToPath } from 'node:url';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
// the juice imports three as a game's page does: through the kit's import hook
const { createJuice, impactPlan, scaleOf } = await importLayer(fileURLToPath(new URL('../runtimes/three/kit/core/juice.js', import.meta.url)));

const fly = (o, sol, { speed, gravity, wind }) => {
  const d = launchDir(sol.yaw, sol.elevation), s = speed * sol.power, b = { x: o.x, y: o.y, z: o.z, vx: d[0] * s, vy: d[1] * s, vz: d[2] * s };
  for (let t = 0; t < 10; t += 1 / 120) { const py = b.y; shellStep(b, 1 / 120, gravity, wind); if (b.vy < 0 && b.y <= 0 && py > 0) return b; }
  return null;
};

test('a launch goes the way it faces, at the elevation asked; the wind pushes a shell sideways', () => {
  const d = launchDir(0, 45);
  assert.ok(Math.abs(d[0]) < 1e-9 && Math.abs(d[1] - d[2]) < 1e-9 && Math.abs(Math.hypot(...d) - 1) < 1e-9);
  const a = { x: 0, y: 0, z: 0, vx: 0, vy: 10, vz: 10 }, b = { ...a };
  for (let i = 0; i < 60; i++) { shellStep(a, 1 / 60, 18, null); shellStep(b, 1 / 60, 18, { x: 4, z: 0 }); }
  assert.ok(Math.abs(a.x) < 1e-9 && b.x > 1.5, `the wind moved it ${b.x.toFixed(2)} m in a second`);
  assert.equal(windAlong({ x: 0, z: 5 }, 0, 5), 1, 'at your back');
  assert.equal(windAlong({ x: 0, z: -5 }, 0, 5), -1, 'in your face');
});

test('the charge fills, holds or swings; a round\'s wind is seeded and never above its max', () => {
  assert.equal(chargeAt(0, 1.4, 'clamp', 0.1), 0.1);
  assert.equal(chargeAt(5, 1.4, 'clamp', 0.1), 1);
  assert.ok(chargeAt(2.1, 1.4, 'swing', 0) < 0.6, 'a swing comes back down');
  let seed = 3; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 50; i++) { const w = windFor(rng, 6); assert.ok(Math.hypot(w.x, w.z) <= 6 + 1e-9); }
  seed = 3; const a = windFor(rng, 6); seed = 3; assert.deepEqual(windFor(rng, 6), a, 'the same seed, the same wind');
  assert.deepEqual(windFor(rng, 0), { x: 0, z: 0 });
});

test('the preview stops where the world is; a bot\'s solved shot lands on its target with the wind in it', () => {
  const ground = (a, b) => (b.y <= 0 && a.y > 0 ? { t: a.y / (a.y - b.y) } : null);
  const p = predictPath({ x: 0, y: 1, z: 0 }, [0, 8, 10], { gravity: 18, hit: ground });
  assert.ok(p.hit && Math.abs(p.end.y) < 1e-6 && p.end.z > 5, `lands at z ${p.end.z.toFixed(2)}`);
  for (const wind of [null, { x: 3, z: -2 }]) {
    const o = { x: 0, y: 1.2, z: 0 }, to = { x: 12, y: 0, z: 18 };
    const sol = solveShot(o, to, { speed: 30, gravity: 18, wind });
    const b = fly(o, sol, { speed: 30, gravity: 18, wind });
    assert.ok(b && Math.hypot(b.x - to.x, b.z - to.z) < 0.8, `lands ${b ? Math.hypot(b.x - to.x, b.z - to.z).toFixed(2) : '-'} m from the target (wind ${JSON.stringify(wind)})`);
    assert.ok(sol.power > 0 && sol.power <= 1);
  }
});

test('weapons are data: fields filled and held in range, bad entries left out', () => {
  const w = weaponsOf([{ id: 'rocket', speed: 999, radius: -2 }, { id: 'rocket' }, { label: 'no id' }, { id: 'BAD ID' }, { id: 'nade', fuse: 3, bounces: 4 }]);
  assert.deepEqual(w.map(x => x.id), ['rocket', 'nade']);
  assert.equal(w[0].speed, 60); assert.equal(w[0].radius, 0); assert.equal(w[0].ammo, -1);
  assert.equal(w[1].fuse, 3); assert.equal(w[1].bounces, 4);
});

test('juice: sizes from one number, the time scale over a hitstop and a slow motion, Reduce motion', () => {
  const small = impactPlan(0.1), big = impactPlan(1, { near: true }), far = impactPlan(1);
  assert.ok(small.shake < big.shake && small.hitstop === 0 && small.slowmo === 0);
  assert.ok(big.hitstop > 0 && big.slowmo > 0 && far.slowmo === 0, 'only a big hit near this screen\'s player slows time');
  assert.equal(scaleOf({ stop: 0.05 }), 0.02);
  assert.ok(scaleOf({ slow: 0.5, slowFor: 0.5, slowScale: 0.3 }) === 0.3 && scaleOf({ slow: 0.01, slowFor: 0.5, slowScale: 0.3 }) > 0.9);
  const ctx = { camera: null, me: { position: { x: 0, y: 0, z: 0 } } };
  const J = createJuice(ctx);
  J.setComfort({ reduceMotion: false });
  J.impact(1, { at: { x: 0, y: 0, z: 0 } });
  assert.ok(J.timeScale(0.016) < 0.1, 'a hitstop first');
  let t = 0; while (J.timeScale(0.016) < 0.1 && t < 1) t += 0.016;
  assert.ok(J.scale < 1, 'then the slow motion');
  for (let i = 0; i < 200; i++) J.timeScale(0.016);
  assert.equal(J.scale, 1, 'and back to full speed');
  const C = createJuice(ctx);
  C.setComfort({ reduceMotion: true });
  C.impact(1, { at: { x: 0, y: 0, z: 0 } });
  assert.ok(C.observe().reduceMotion && C.observe().shake === 0, 'no shake with Reduce motion');
  let stopped = 0, slowed = false; for (let i = 0; i < 60; i++) { const k = C.timeScale(0.016); if (k < 0.1) stopped += 0.016; else if (k < 1) slowed = true; }
  assert.ok(stopped <= 0.05, `a hitstop of at most 0.04 s (${stopped.toFixed(3)})`);
  assert.ok(!slowed && C.scale === 1, 'no slow motion');
  const off = createJuice(ctx, { on: false }); off.impact(1); assert.equal(off.timeScale(0.016), 1);
});
