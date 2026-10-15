// The shared mechanics on forge (components/<id>/impl/forge, loaded by runtimes/forge/kit/mechanics.js): what runs
// without a browser. The two-player evidence is runtimes/forge/tools/fixture.mjs's (runtimes/forge/evidence/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../builder/tools/lib/paths.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { planWaves, tables as waveTables } from '../components/waves/impl/forge/index.js';
import { forgeKitClosure, kitFiles } from '../builder/tools/lib/vendor.mjs';
// the pickup's forge implementation imports the shared placement as a game sees it (gf/three/world/placement.js)
const { placeSpots } = await importLayer(join(REPO, 'components/pickup/impl/forge/index.js'));

const FORGE_IMPLS = ['health', 'loot', 'pickup', 'waves'];

test('the loader: a forge implementation runs, a mechanic without one stays a stand-in, a broken one never stops the boot', async () => {
  const { loadMechanics } = await import('../runtimes/forge/kit/mechanics.js');
  const mods = {
    pickup: { id: 'pickup', create: (ctx, P, K) => ({ seen: P.count, help: typeof K.createMarks, update() { this.ticks = (this.ticks ?? 0) + 1; } }), tables: (t, P) => ({ ...t, touched: P.count }) },
    bad: { id: 'bad', create: () => { throw new Error('boom'); } },
  };
  const load = async id => { if (!mods[id]) throw new Error('not found'); return mods[id]; };
  const mech = await loadMechanics({ mechanics: [{ id: 'pickup', params: { count: 2 } }, { id: 'tag', params: { x: 1 } }, { id: 'bad' }] }, { load });
  assert.deepEqual(mech.tables({ waves: [] }), { waves: [], touched: 2 });
  const ctx = { onFrame: [] };
  const err = console.error; console.error = () => {};
  const list = mech.create(ctx);
  console.error = err;
  assert.deepEqual(list.map(m => [m.id, m.standin]), [['pickup', false], ['tag', true], ['bad', true]]);
  assert.equal(list[0].seen, 2); assert.equal(list[0].help, 'function');
  assert.deepEqual(list[1].params, { x: 1 });
  ctx.onFrame.forEach(fn => fn(1 / 60));
  assert.equal(list[0].ticks, 1, 'an implementation\'s update rides ctx.onFrame');
  assert.deepEqual(mech.observe().map(m => [m.id, m.standin]), [['pickup', false], ['tag', true], ['bad', true]]);
});

test('pickup on forge: spots on open floor every seat reaches, clear of the walls, never on a wall or in a walled-off room', () => {
  const ground = { min: [-21, -1, -21], max: [21, 0, 21] };
  const wall = { min: [2, 0, -1], max: [6, 3, 1] };
  // a closed room in the north-west corner: walls a jump cannot pass
  const room = [{ min: [-9, 0, -9], max: [-3, 3, -8.6] }, { min: [-9, 0, -3.4], max: [-3, 3, -3] }, { min: [-9, 0, -9], max: [-8.6, 3, -3] }, { min: [-3.4, 0, -9], max: [-3, 3, -3] }];
  let q = 7; const rng = () => ((q = (q * 16807) % 2147483647) / 2147483647);
  const world = { size: [24, 24], colliders: [ground, wall, ...room], spawns: [[0, 0.05, 8], [4, 0.05, 8]] };
  const at = placeSpots(6, { world, rng });
  assert.equal(at.length, 6);
  for (const s of at) {
    assert.equal(s.y, 0, 'on the floor');
    assert.ok(!(s.x > wall.min[0] - 0.6 && s.x < wall.max[0] + 0.6 && Math.abs(s.z) < 1.6), `spot ${JSON.stringify(s)} is in the wall`);
    assert.ok(!(s.x > -9 && s.x < -3 && s.z > -9 && s.z < -3), `spot ${JSON.stringify(s)} is in the closed room`);
  }
  assert.ok(new Set(at.map(s => `${s.x},${s.z}`)).size === 6, 'six different places');
});

test('waves on forge: the params make the core\'s plan, and a spec\'s own waves win', () => {
  const plan = planWaves({ startCount: 2, growth: 1, maxWaves: 3, firstDelay: 1, restSeconds: 2, spawnEvery: 0.4, maxAlive: 6 }, ['grunt', 'runner']);
  assert.deepEqual(plan.map(w => w.enemies.reduce((n, g) => n + g.count, 0)), [2, 3, 4]);
  assert.deepEqual(plan[0].enemies, [{ type: 'grunt', count: 2 }]);
  assert.deepEqual(plan[1].enemies.map(g => g.type), ['grunt', 'runner']);
  assert.equal(plan[0].delay, 1); assert.equal(plan[1].delay, 2); assert.equal(plan[2].maxAlive, 6);
  assert.equal(planWaves({ maxWaves: 0 }).length, 10, 'endless on three is ten waves on forge');
  assert.deepEqual(planWaves({ maxWaves: 1, nextWave: 'timer', interval: 12 })[0].next, 'timer');
  const t = waveTables({ enemies: [{ id: 'grunt', archetype: 'chaser' }, { id: 'lord', archetype: 'boss' }] }, { maxWaves: 2 });
  assert.equal(t.waves.length, 2);
  assert.ok(t.waves.every(w => w.enemies.every(g => g.type === 'grunt')), 'the boss row is never in a made wave');
  const own = { waves: [{ id: 'mine', enemies: [{ type: 'grunt', count: 9 }] }] };
  assert.equal(waveTables(own, { maxWaves: 5 }), own);
});

test('the manifests: forge is tested only with a passing two-player fixture record beside it', async () => {
  for (const id of FORGE_IMPLS) {
    const man = JSON.parse(await readFile(join(REPO, 'components', id, 'mechanic.json'), 'utf8'));
    const f = man.impl?.forge;
    assert.ok(f, `${id}: impl.forge`);
    assert.ok(existsSync(join(REPO, f.path)), `${id}: ${f.path}`);
    assert.ok(existsSync(join(REPO, 'components', id, 'impl/forge/fixture/scenario.mjs')), `${id}: a forge fixture`);
    if (!f.state.tested) continue;
    const ev = f.state.evidence?.find(e => /checks\.json$/.test(e.ref ?? '')) ?? null;
    assert.ok(ev, `${id}: tested on forge names its fixture record`);
    const rec = JSON.parse(await readFile(join(REPO, ev.ref), 'utf8'));
    assert.equal(rec.mechanic, id); assert.equal(rec.runtime, 'forge'); assert.equal(rec.pass, true, `${id}: the record passed`);
    assert.ok(rec.checks.length >= 6 && rec.checks.every(c => c.ok));
  }
});

test('vendoring: a forge game carries the forge implementations, a three game never carries another runtime\'s', async () => {
  const closure = await forgeKitClosure('forge');
  for (const id of FORGE_IMPLS) assert.ok(closure.includes(`mechanics/${id}/impl/forge/index.js`), `${id} in the forge closure`);
  assert.ok(closure.includes('mechanics/pickup/logic.js'), 'what an implementation imports comes with it');
  assert.ok(!closure.includes('mechanics/pickup/index.js'), 'never the three module');
  const three = await kitFiles({ runtime: 'three', profile: 'standard-3d', look: true, world: true, character: true, mechanics: ['pickup', 'waves'] });
  assert.ok('mechanics/pickup/index.js' in three);
  assert.ok(!Object.keys(three).some(r => /\/impl\/forge\//.test(r)), 'no forge implementation in a three game');
});
