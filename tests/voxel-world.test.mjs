// The voxel world's pure parts (worlds/voxel): the block table's light and tints, the light flood (sun and coloured
// block light, and an edit's relight against a full one), the mesher (faces, smooth light, AO, the edge culled against
// the land beyond) and the land (deterministic, one generator, seams that agree between grids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VoxelGrid } from '../worlds/voxel/grid.mjs';
import { blockTable, emitOf } from '../worlds/voxel/blocks.mjs';
import { VoxelLight, sunOf, rOf, gOf, bOf } from '../worlds/voxel/light.mjs';
import { meshChunk } from '../worlds/voxel/mesh.mjs';
import { generateTerrain, terrainModel, fillRegion, landOutside, GENERATOR } from '../worlds/voxel/terrain.mjs';

const V = JSON.parse(readFileSync(new URL('../worlds/voxel/default.json', import.meta.url), 'utf8'));
const table = blockTable(V);
const n = id => table.byId.get(id).n;
const grid = (size = [16, 16, 16]) => new VoxelGrid({ size, info: table.info, tints: table.tints });

test('a block\'s light, filter and tint come from its entry', () => {
  assert.equal(emitOf(false), 0);
  const e = emitOf({ color: '#7fe8ff', level: 13 });
  assert.ok(bOf(e) === 13 && gOf(e) > rOf(e), 'the colour sets each channel, the brightest at the level');
  assert.equal(emitOf(true) >> 8, 15, 'a plain lamp is warm and full');
  const I = table.info[n('leaves')];
  assert.equal(I.filter, 1); assert.equal(I.tint, 'foliage');
  assert.ok(table.info[n('lamp')].emit > 0 && table.info[n('crystal')].emit > 0);
  assert.throws(() => blockTable({ ...V, blocks: [{ id: 'x', tex: 'stone', tint: 'sky' }] }), /unknown tint/);
});

test('sunlight falls full to the ground, fades under a roof, and a lamp lights the dark in its own colour', () => {
  const g = grid();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) g.put(x, 0, z, n('stone'));
  for (let x = 2; x < 10; x++) for (let z = 2; z < 10; z++) g.put(x, 6, z, n('stone'));   // a roof
  const L = new VoxelLight(g); L.computeAll();
  assert.equal(sunOf(L.at(12, 1, 12)), 15, 'open sky reaches the floor at full strength');
  assert.equal(sunOf(L.at(5, 3, 5)), 15 - 4, 'under the roof the light is what spreads in from its edge, one less a step');
  assert.ok(sunOf(L.at(5, 1, 5)) < sunOf(L.at(9, 1, 9)), 'darker toward the middle');
  g.put(5, 1, 5, n('crystal')); L.computeAll();
  const w = L.at(5, 2, 5);
  assert.ok(rOf(w) >= 8 && rOf(w) > bOf(w), 'the amber crystal lights its neighbour warm');
});

test('an edit relights only what it must, and gives the same light as lighting everything again', () => {
  const g = grid([48, 24, 48]);
  const T = generateTerrain(g, table, { ...V.terrain, seed: 5, water: 6, ground: 9, hills: 4, mountains: 0, plaza: { at: [24, 24], half: 3 } });
  assert.ok(T.heights.length === 48 * 48);
  const L = new VoxelLight(g); L.computeAll();
  const edits = [[20, 12, 20, n('stone')], [21, 12, 20, n('stone')], [22, 12, 20, n('lamp')], [10, 3, 10, 0], [30, 11, 30, n('leaves')], [24, 8, 24, 0]];
  for (const [x, y, z, v] of edits) { g.set(x, y, z, v); L.touch(x, z); }
  const changed = L.flush();
  assert.ok(changed.size > 0 && changed.size < g.cx * g.cy * g.cz, 'some chunks, not all');
  const fresh = new VoxelLight(g); fresh.computeAll();
  assert.deepEqual(Buffer.from(L.data.buffer), Buffer.from(fresh.data.buffer));
});

test('a lone block meshes to six lit faces; the grid\'s edge is culled against the land beyond it', () => {
  const g = grid();
  g.put(8, 8, 8, n('stone'));
  const L = new VoxelLight(g); L.computeAll();
  const r = meshChunk(g, L, 0, 0, 0);
  assert.equal(r.solid.count, 24); assert.equal(r.solid.index.length, 36);
  assert.ok([...r.solid.light].filter((_, i) => i % 4 === 0).every(s => s > 200), 'every corner sees the sky');
  // a floor at the edge: with nothing past the edge its side faces are drawn; with land past it they are not
  const e = grid();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) e.put(x, 0, z, n('stone'));
  const El = new VoxelLight(e); El.computeAll();
  const open = meshChunk(e, El, 0, 0, 0).solid.count;
  e.outside = (x, y) => (y < 1 ? n('stone') : 0);
  const culled = meshChunk(e, El, 0, 0, 0).solid.count;
  assert.equal(open - culled, 16 * 4 * 4, 'the four edge walls (16 faces each, 4 vertices a face) go');
});

test('ambient occlusion and smooth light darken an inside corner', () => {
  const g = grid();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) g.put(x, 0, z, n('stone'));
  g.put(5, 1, 5, n('stone'));
  const L = new VoxelLight(g); L.computeAll();
  const r = meshChunk(g, L, 0, 0, 0).solid;
  // the floor's top corners touching the block are shaded below an open one
  const shades = [];
  for (let i = 0; i < r.count; i++) if (r.normal[i * 3 + 1] > 0 && r.position[i * 3 + 1] === 1) shades.push([r.position[i * 3], r.position[i * 3 + 2], r.color[i * 3]]);
  const at = (x, z) => Math.min(...shades.filter(s => s[0] === x && s[1] === z).map(s => s[2]));
  assert.ok(at(5, 5) < at(12, 12), 'the corner by the block is darker');
});

test('the land is the same for the same seed, and one generator only', () => {
  const hashOf = seed => { const g = grid([64, 48, 64]); generateTerrain(g, table, { ...V.terrain, seed, plaza: { at: [32, 32], half: 4 } }); return createHash('sha256').update(g.data).digest('hex'); };
  assert.equal(hashOf(11), hashOf(11));
  assert.notEqual(hashOf(11), hashOf(12));
  assert.throws(() => terrainModel(table, { ...V.terrain, generator: 1 }, [64, 48, 64]), /never upgraded/);
  assert.equal(GENERATOR, 2);
});

test('two grids that overlap agree on every cell they share (the scenery meets the play area without a seam)', () => {
  const size = [64, 64, 64], cfg = { ...V.terrain, seed: 21, plaza: { at: [500, 500], half: 3 } };
  const model = terrainModel(table, cfg, size);
  const a = grid(size), b = grid(size);
  fillRegion(a, model, 0, 0); fillRegion(b, model, 32, 16);
  let diff = 0;
  for (let y = 0; y < 64; y++) for (let z = 16; z < 64; z++) for (let x = 32; x < 64; x++) if (a.get(x, y, z) !== b.get(x - 32, y, z - 16)) diff++;
  assert.equal(diff, 0);
  const out = landOutside(model, 0, 0);
  assert.equal(out(-1, 0, 5), model.B.stone); assert.equal(out(-1, 63, 5), 0);
});

test('the spawn square is level, paved and clear, and every spawn stands on it', () => {
  const g = grid([96, 64, 96]);
  const T = generateTerrain(g, table, { ...V.terrain, seed: 3, plaza: { at: [48, 48], half: 6, floor: 'cobble', edge: 'stone-brick' } });
  for (const s of T.spawns) {
    const x = Math.floor(s.x), z = Math.floor(s.z);
    assert.ok(g.solidAt(x, s.y - 1, z), 'ground under the spawn');
    assert.ok(!g.solidAt(x, s.y, z) && !g.solidAt(x, s.y + 1, z), 'room to stand');
  }
  assert.equal(g.block(48, T.plaza.y - 1, 48), n('cobble'));
});
