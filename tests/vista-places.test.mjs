// kit/world/places.js (wave 3 track P): a recipe per seed and words, always the same, plain JSON; REFERENCE is the core's
// own island to the last literal; the core builds the same heightmap from REFERENCE as with no recipe at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { placeRecipe, REFERENCE, normalizeWords, seedHash, placeSeats, describePlace, houseRadius, harbourFrame } from '../runtimes/vista/kit/world/places.js';
import { WORLD } from '../runtimes/vista/core/src/world/WorldLayout.js';
import { RIDGES, PLUGS, SEA_STACKS, PATHS } from '../runtimes/vista/core/src/world/terrain/IslandShape.js';
import { referenceLayout, layoutFromRecipe } from '../runtimes/vista/core/src/world/Place.js';
import { TerrainData } from '../runtimes/vista/core/src/world/TerrainData.js';
import { Vector2 } from '../runtimes/vista/core/src/engine/index.js';

const plain = o => JSON.parse(JSON.stringify(o));

test('same seed and words give the same recipe; another seed another one', () => {
  for (const [s, w] of [[1, {}], [7, { size: 'small', village: 'town' }], ['Keys to the Cove', { bay: 'w', reef: 'large' }]]) {
    assert.deepEqual(plain(placeRecipe(s, w)), plain(placeRecipe(s, w)));
  }
  assert.notDeepEqual(plain(placeRecipe(1)).coast, plain(placeRecipe(2)).coast);
  assert.equal(seedHash(5), seedHash(5));
});

test('a recipe is plain JSON (nothing lost in a round trip)', () => {
  const r = placeRecipe(3, { village: 'town' });
  assert.deepEqual(plain(r), r);
});

test('REFERENCE is the core\'s own island, literal for literal', () => {
  const L = referenceLayout();
  assert.deepEqual(REFERENCE.coast, { ...L.coast });
  assert.deepEqual(REFERENCE.massif, L.massif);
  assert.deepEqual(REFERENCE.headlands, L.headlands);
  assert.deepEqual(REFERENCE.beachZone, L.beachZone);
  assert.deepEqual(REFERENCE.valley, L.valley);
  assert.equal(REFERENCE.terrain.seed, L.terrainSeed);
  // the ridges after the core's default crest width (2.5 h + 50)
  assert.deepEqual(layoutFromRecipe(REFERENCE).ridges, RIDGES.map(pl => pl.map(p => p.slice(0, 4))));
  assert.deepEqual(REFERENCE.plugs, PLUGS);
  assert.deepEqual(REFERENCE.stacks, SEA_STACKS);
  assert.deepEqual(REFERENCE.paths, PATHS);
  assert.deepEqual(REFERENCE.beach, { xMin: WORLD.beach.xMin, xMax: WORLD.beach.xMax });
  for (const k of ['x', 'zStart', 'zEnd', 'deckHeight', 'width', 'headWidth', 'headDepth']) assert.equal(REFERENCE.pier[k], WORLD.pier[k], k);
  assert.deepEqual([REFERENCE.boatDock.x, REFERENCE.boatDock.z, REFERENCE.boatDock.heading], [WORLD.boatDock.position.x, WORLD.boatDock.position.z, WORLD.boatDock.heading]);
  assert.deepEqual([...REFERENCE.village.center, REFERENCE.village.radius], [WORLD.village.center.x, WORLD.village.center.z, WORLD.village.radius]);
  assert.deepEqual([...REFERENCE.reef.center, REFERENCE.reef.radius], [WORLD.reef.center.x, WORLD.reef.center.z, WORLD.reef.radius]);
  for (const k of ['spawn', 'start']) assert.deepEqual([REFERENCE[k].x, REFERENCE[k].z, REFERENCE[k].yaw], [WORLD[k].position.x, WORLD[k].position.z, WORLD[k].yaw], k);
  const sw = new Vector2(...REFERENCE.swellDir).normalize();   // as world/Place.js applies it
  assert.deepEqual([sw.x, sw.y], [WORLD.swellDir.x, WORLD.swellDir.y]);
});

test('the core builds the same heightmap from REFERENCE as from no recipe', () => {
  const hash = td => createHash('sha256').update(Buffer.from(td.heights.buffer)).update(Buffer.from(td.sand.buffer)).update(Buffer.from(td.rock.buffer)).digest('hex');
  const a = new TerrainData();
  const L = layoutFromRecipe(REFERENCE);
  const b = new TerrainData(L.terrainSeed, L);
  assert.equal(hash(b), hash(a));
});

test('the words shape the place', () => {
  const R = () => 0.5; R.pick = a => a[0];
  assert.deepEqual(normalizeWords({ size: 'SMALL', bay: 'W', reef: 'none' }, R).size, 'small');
  const small = placeRecipe(4, { size: 'small' }), large = placeRecipe(4, { size: 'large' });
  assert.ok(small.coast.body[2] < large.coast.body[2] && small.coast.body[3] < large.coast.body[3]);
  const none = placeRecipe(5, { village: 'none', reef: 'none' });
  assert.equal(none.village.plan.houses.length, 0);
  assert.equal(none.village.plan.huts.length, 0);
  assert.equal(none.reef.radius, 0);
  const town = placeRecipe(5, { village: 'town' }), hamlet = placeRecipe(5, { village: 'hamlet' });
  assert.ok(town.village.plan.houses.length > hamlet.village.plan.houses.length);
  // the bay's bearing puts the harbour on that side of the island: the pier points that way (north is -z, east +x)
  for (const [bay, dir] of [['w', [-1, 0]], ['s', [0, 1]], ['e', [1, 0]], ['n', [0, -1]]]) {
    const r = placeRecipe(6, { bay }), h = r.harbour.heading;
    assert.ok(Math.sin(h) * dir[0] + Math.cos(h) * dir[1] > 0.5, `${bay}: heading ${h}`);
    assert.equal(r.sunTurn, 0);
  }
  for (const k of ['pier', 'dock', 'jetty']) assert.equal(placeRecipe(7, { pier: k }).pier.kind, k);
  assert.deepEqual(placeRecipe(8, { sand: 'dark' }).nature.sand, [0.2, 0.19, 0.19]);
  assert.ok(placeRecipe(9, { water: 'deep' }).nature.shelf > 1 && placeRecipe(9, { water: 'flat' }).nature.shelf < 1);
  assert.ok(placeRecipe(8, { plants: 'lush' }).plants > 1 && placeRecipe(8, { plants: 'sparse' }).plants < 1);
  for (const h of town.village.plan.houses) assert.ok(houseRadius(h) > 3);
  assert.match(describePlace(town), /town/);
});

test('seats follow the place\'s start and pier', () => {
  const r = placeRecipe(9);
  const s = placeSeats(r);
  assert.equal(s.pier[0].x, r.start.x);
  const F = harbourFrame(r), [, lz] = F.tl(s['pier-head'][0].x, s['pier-head'][0].z);
  assert.ok(Math.abs(lz - (r.pier.zEnd - r.pier.headDepth / 2)) < 2.5);
  assert.equal(s.boat.length, 4);
});

test('the wider words: coast, coves, a river mouth, cliffs, archipelago, table mountain, volcano', async () => {
  const { WORDS, knownWord, placeLook, placeKey, REFERENCE_KEY } = await import('../runtimes/vista/kit/world/places.js');
  assert.equal(knownWord('shape', 'Mesa'), 'plateau');
  assert.equal(knownWord('river', 'estuary'), 'yes');
  assert.equal(knownWord('weather', 'nonsense'), null);
  assert.equal(placeRecipe(21, { coast: 'coves', bays: '3' }).coast.coves.length, 3);
  assert.equal(placeRecipe(21, { coast: 'smooth', bays: '0' }).coast.coves, undefined);
  assert.ok(placeRecipe(21, { coast: 'rugged' }).coast.warp > placeRecipe(21, { coast: 'smooth' }).coast.warp);
  // a river mouth: carved into the heightmap below the sea, from the coast inland
  const rv = placeRecipe(22, { river: 'yes', size: 'large', shape: 'single' });
  if (rv.words.river === 'yes') {
    assert.equal(rv.rivers.length, 1);
    const p = TerrainData.probe(layoutFromRecipe(rv)), mid = rv.rivers[0].pts[Math.floor(rv.rivers[0].pts.length / 2)];
    assert.ok(p.heightFn(mid[0], mid[1]).h < 0, 'the sea runs up the river');
  }
  assert.equal(placeRecipe(22, { river: 'none' }).rivers.length, 0);
  assert.ok(placeRecipe(23, { shape: 'archipelago' }).coast.lobes.length >= 5, 'a small island among bigger islets');
  const table = placeRecipe(24, { shape: 'plateau', peaks: 'high' });
  assert.ok(table.tableTop > 30 && table.plugs.length === 0);
  const peak = (r) => { const p = TerrainData.probe(layoutFromRecipe(r)); let m = 0; for (let z = -850; z < 300; z += 16) for (let x = -600; x < 600; x += 16) m = Math.max(m, p.heightFn(x, z).h); return m; };
  assert.ok(peak(table) < table.tableTop + 12, 'the top is flat at its height');
  assert.ok(placeRecipe(25, { shape: 'volcano', peaks: 'high' }).plugs.some(p => p[2] > 30), 'a volcano has its rock spire');
  for (const s of [26, 27, 28]) assert.ok(placeRecipe(s, { shape: 'single' }).plugs.every(p => p[2] < 30), 'one summit never carries the reference\'s spire');
  assert.equal(placeRecipe(29, { cliffs: 'none', shape: 'single' }).cliffs.length, 0);
  // time and weather are the look's, never the ground's
  const night = placeRecipe(30, { time: 'night', weather: 'storm' }), plain = placeRecipe(30, {});
  assert.deepEqual(night.coast, plain.coast);
  assert.deepEqual(placeLook(night), { sea: 'storm', clouds: 0.85, veil: 1, haze: 3.6, hour: 21.5, exposure: 0.5 });
  assert.equal(placeLook(plain), null);
  // a key per place; the reference island's is its own
  assert.notEqual(placeKey(plain), REFERENCE_KEY);
  assert.notEqual(placeKey(placeRecipe(31)), placeKey(plain));
  assert.equal(placeKey(null), REFERENCE_KEY);
  for (const k of Object.keys(WORDS)) assert.ok(WORDS[k].length >= 2, k);
});

test('every vista spec gets its own islands; unknown words are refused, never dropped', async () => {
  const C = await import('../runtimes/vista/kit/config.js');
  const a = C.worldConfig({ title: 'One', prompt: 'x' }), b = C.worldConfig({ title: 'Two', prompt: 'x' });
  assert.equal(a.template, 'islands');
  assert.notEqual(a.islands[0].seed, b.islands[0].seed);
  const two = C.specIslands({ world: { template: 'islands', seed: 100, islands: [{ name: 'A', words: { size: 'small' } }, { name: 'B' }] } });
  assert.deepEqual(two.map(i => i.seed), [100, 8019]);
  assert.throws(() => C.specIslands({ world: { islands: [{ words: { colour: 'red' } }] } }), /not a place word/);
  assert.throws(() => C.specIslands({ world: { islands: [{ words: { shape: 'donut' } }] } }), /is not one of/);
  assert.throws(() => C.specIslands({ world: { islands: [] } }), /1 to 5/);
  const look = C.lookConfig({ look: { preset: 'clear-morning' }, world: { islands: [{ seed: 5, words: { time: 'night' } }] } });
  assert.equal(look.hour, 21.5);
  assert.deepEqual(C.islandLook({ islands: [{ seed: 5, words: { weather: 'overcast' } }] }, 0).sea, 'choppy');
  const slots = C.worldSlots(a).map(s => s.id);
  assert.ok(['world.island.1.name', 'world.island.1.seed', 'world.island.1.words'].every(id => slots.includes(id)));
});
