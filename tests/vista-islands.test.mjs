// Track H (island hopping): the pure parts of kit/islands.js and kit/config.js's per-place seats.
//   node --test tests/vista-islands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIslands, chart, islandExtent, silhouetteGeometry, LEG, MAX_ISLANDS } from '../runtimes/vista/kit/islands.js';
import { seatsOf, worldConfig, placeOf, islandRecipes, PLACES } from '../runtimes/vista/kit/config.js';
import { placeRecipe, REFERENCE } from '../runtimes/vista/kit/world/places.js';

const LIST = [
  { name: 'Saffron Cove', seed: 116, words: { vegetation: 'scrub', sand: 'golden', pier: 'dock' } },
  { name: 'Ember Key', seed: 114, words: { shape: 'twin', sand: 'dark' } },
  { name: 'Three Gulls', seed: 117, words: { size: 'small', islets: '3' } },
];

test('islands: names and recipes from seeds, recipes or { name, recipe }; at most five', () => {
  const r = placeRecipe(5, {});
  const a = normalizeIslands([...LIST, r, { name: 'Ref', recipe: REFERENCE }, { seed: 9 }]);
  assert.equal(a.length, MAX_ISLANDS);
  assert.equal(a[0].name, 'Saffron Cove');
  assert.equal(a[0].recipe.seed, 116);
  assert.equal(a[3].recipe, r);
  assert.equal(a[4].recipe, REFERENCE);
  assert.throws(() => normalizeIslands([{ name: 'nothing' }]));
});

test('chart: island k + 1 lies a leg out of island k\'s harbour, and no two islands are close', () => {
  const isl = normalizeIslands(LIST);
  const P = chart(isl);
  assert.deepEqual(P[0], [0, 0]);
  const b = isl[0].recipe.facing * Math.PI / 180;
  assert.ok(Math.abs(P[1][0] - Math.sin(b) * LEG) < 1e-6 && Math.abs(P[1][1] + Math.cos(b) * LEG) < 1e-6, 'the first leg follows island 1\'s bay');
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) assert.ok(Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]) >= LEG * 0.8 - 1e-6);
  assert.deepEqual(chart(isl), P, 'deterministic');
});

test('extent: the island\'s middle is its coast body; the box holds every massif ellipse', () => {
  const r = placeRecipe(117, { size: 'small', islets: '3' }), e = islandExtent(r);
  assert.equal(e.cx, r.coast.body[0]);
  for (const [cx, cz, rx, rz] of r.massif) assert.ok(cx - rx >= e.box[0] - 1e-9 && cx + rx <= e.box[1] + 1e-9 && cz - rz >= e.box[2] - 1e-9 && cz + rz <= e.box[3] + 1e-9);
});

test('silhouette: a low-poly mesh of the recipe\'s own heights, land above the sea', () => {
  const r = placeRecipe(114, { shape: 'twin' });
  const g = silhouetteGeometry(r, 48);
  const pos = g.attributes.position.array;
  let top = -Infinity;
  for (let i = 1; i < pos.length; i += 3) top = Math.max(top, pos[i]);
  assert.ok(top > 20, `the peaks rise (${top.toFixed(1)} m)`);
  assert.ok(g.index.count > 300 && g.index.count < 48 * 48 * 6, `${g.index.count / 3} triangles`);
  assert.equal(g.attributes.color.itemSize, 4);
});

test('seats: every place its own (placeSeats + the beach), never the reference island\'s', () => {
  const a = seatsOf(placeRecipe(116, LIST[0].words)), b = seatsOf(placeRecipe(117, LIST[2].words));
  for (const k of ['pier', 'pier-head', 'beach', 'boat']) {
    assert.equal(a[k].length, 4, k);
    assert.notDeepEqual(a[k][0], b[k][0], k);
    assert.notDeepEqual({ x: a[k][0].x, z: a[k][0].z }, { x: PLACES[k].seats[0].x, z: PLACES[k].seats[0].z }, k);
  }
});

test('world config: islands with their own seats; the start places are island 1\'s; placeOf reads the island', () => {
  const w = worldConfig({}, { islands: LIST });
  assert.equal(w.islands.length, 3);
  assert.deepEqual(w.places.pier.seats, w.islands[0].places.pier.seats);
  assert.deepEqual(placeOf(w, 'boat', 1, 2), w.islands[2].places.boat.seats[1]);
  assert.deepEqual(placeOf(w, 'pier', 0), w.islands[0].places.pier.seats[0]);
  const rs = islandRecipes(w);
  assert.deepEqual(rs.map(x => x.name), LIST.map(x => x.name));
  assert.deepEqual(rs[1].recipe, placeRecipe(114, LIST[1].words), 'the recipe again from its seed and words');
  const one = worldConfig({ title: 'A', prompt: 'p' });
  assert.equal(one.islands.length, 1, 'no islands asked: one island of the game\'s own');
  assert.notDeepEqual(one.islands[0].seed, worldConfig({ title: 'B', prompt: 'p' }).islands[0].seed, 'two games, two places');
});
