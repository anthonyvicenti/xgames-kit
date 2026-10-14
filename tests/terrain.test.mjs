// The terrain world's pure parts (worlds/terrain) and the carve mechanic's (components/carve/logic.js): the field and its
// edits, the generators (deterministic, the box sealed, spawns on open ground), the mesher (watertight seams between
// chunks, faces turned out, an edit re-meshing only the chunks it touched to the same result as meshing again), a ray
// on the field meeting the mesh, and the edit feed a copy that is not the host keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TerrainField, CHUNK, BAND, editOf, isEdit } from '../worlds/terrain/field.mjs';
import { generateTerrain, paramsOf, spawnsOn, floatingOf, seatSpawns, inSight, GENERATOR } from '../worlds/terrain/generate.mjs';
import { meshChunk, origOf } from '../worlds/terrain/mesh.mjs';
import { craterRadius, createFeed, chunksOf } from '../components/carve/logic.js';

const hashOf = f => { const d = new Uint32Array(f.d.buffer); let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
const small = (over = {}) => generateTerrain({ seed: 7, size: [48, 24, 40], islands: { count: 1, radius: [14, 14] }, ...over });
const every = f => { const out = []; for (let y = 0; y < f.cy; y++) for (let z = 0; z < f.cz; z++) for (let x = 0; x < f.cx; x++) out.push([x, y, z]); return out; };

test('the default world config is the generator\'s shape, and the generator has a version', () => {
  const D = JSON.parse(readFileSync(new URL('../worlds/terrain/default.json', import.meta.url), 'utf8'));
  assert.equal(D.template, 'terrain');
  assert.equal(D.terrain.generator, GENERATOR);
  const P = paramsOf(D.terrain);
  for (const k of ['seed', 'shape', 'size', 'cell', 'land', 'islands', 'cliffs']) assert.ok(k in P, k);
  assert.ok(D.materials.top.from.startsWith('library:') && D.materials.soil.from.startsWith('library:'));
});

test('an edit is whole centimetres, and a malformed one is refused', () => {
  assert.deepEqual(editOf('carve', { x: 1.234, y: -0.5, z: 2 }, 2.5), [0, 123, -50, 200, 250]);
  assert.deepEqual(editOf('add', { x: 0, y: 0, z: 0 }, 1), [1, 0, 0, 0, 100]);
  assert.equal(editOf('carve', { x: 0, y: 0, z: 0 }, 0), null);
  assert.equal(editOf('blast', { x: 0, y: 0, z: 0 }, 1), null);
  assert.ok(isEdit([0, 1, 2, 3, 4]));
  for (const bad of [null, [0, 1, 2, 3], [2, 0, 0, 0, 1], [0, 0.5, 0, 0, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 99999], ['0', 0, 0, 0, 1]]) assert.ok(!isEdit(bad), JSON.stringify(bad));
});

test('the same seed makes the same ground; another seed another; the box is sealed', () => {
  const a = small(), b = small(), c = small({ seed: 8 });
  assert.equal(hashOf(a.field), hashOf(b.field));
  assert.notEqual(hashOf(a.field), hashOf(c.field));
  const f = a.field;
  for (const [i, j, k] of [[0, 5, 5], [f.nx - 1, 5, 5], [5, 0, 5], [5, f.ny - 1, 5], [5, 5, 0], [5, 5, f.nz - 1]]) assert.equal(f.at(i, j, k), BAND);
  assert.equal(floatingOf(f).samples, 0, 'no ground floats free of the land');
  // land in the middle, sea at the edge
  assert.ok(f.heightAt(0, 0) > 5, `the island's middle stands ${f.heightAt(0, 0)} m`);
  assert.equal(f.heightAt(f.bounds.min[0] + 1, 0), null, 'open water at the edge');
  const cl = generateTerrain({ seed: 3, shape: 'cliffs', size: [48, 30, 48] }).field;
  assert.ok(cl.heightAt(0, 10) > 3 && cl.heightAt(0, -22) === null, 'a cliff shore: land on its side (z+), sea on the other');
});

test('edits replayed in order give the same field on any copy; a carve lowers the ground under it', () => {
  const edits = [editOf('carve', { x: 0, y: 10, z: 0 }, 3), editOf('carve', { x: 1.5, y: 9, z: 0.5 }, 2.2), editOf('add', { x: -4, y: 12, z: 2 }, 1.5), editOf('carve', { x: 3, y: 11, z: -2 }, 4)];
  const a = small().field, b = small().field;
  for (const e of edits) { a.apply(e); b.apply(e); }
  assert.equal(hashOf(a), hashOf(b));
  const c = small().field; c.apply(edits[1]); c.apply(edits[0]); c.apply(edits[2]); c.apply(edits[3]);
  assert.equal(hashOf(c), hashOf(a), 'carves and adds that do not overlap one another commute');
  const g = small().field, y0 = g.heightAt(0, 0);
  const box = g.apply(editOf('carve', { x: 0, y: y0, z: 0 }, 2.5));
  assert.ok(box, 'a carve on the ground changes it');
  assert.ok(g.heightAt(0, 0) < y0 - 2, `the ground under the blast went down (${y0.toFixed(2)} → ${g.heightAt(0, 0).toFixed(2)})`);
  assert.equal(g.apply(editOf('carve', { x: 0, y: 30, z: 0 }, 1)), null, 'a carve in the open air changes nothing');
  assert.ok(g.solid(0, y0 - 3, 0) && !g.solid(0, y0 - 1, 0));
});

test('meshing: faces turn out, chunks meet with no gap, an edit re-meshes only what it touched', () => {
  const { field: f, info } = small(), orig = origOf(f);
  let out = 0, inn = 0;
  const all = new Map();
  for (const c of every(f)) {
    const r = meshChunk(f, ...c, { top: info.top, orig });
    all.set(c.join(), r);
    const P = r.position, N = r.normal, I = r.index;
    for (let q = 0; q < I.length; q += 3) {
      const a = I[q] * 3, b = I[q + 1] * 3, d = I[q + 2] * 3;
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      (n[0] * (N[a] + N[b] + N[d]) + n[1] * (N[a + 1] + N[b + 1] + N[d + 1]) + n[2] * (N[a + 2] + N[b + 2] + N[d + 2]) > 0 ? out++ : inn++);
    }
  }
  assert.ok(out > 1000 && inn / (out + inn) < 0.01, `${out} faces out, ${inn} in`);
  // watertight: every edge of the whole surface is shared by an even number of triangles, two or (where two sheets of
  // ground touch at one edge, a saddle surface nets leaves as it is) four: no edge is open, chunk seams included
  const key = (P, i) => `${P[i * 3].toFixed(4)},${P[i * 3 + 1].toFixed(4)},${P[i * 3 + 2].toFixed(4)}`;
  const edges = new Map();
  for (const r of all.values()) for (let q = 0; q < r.index.length; q += 3) for (let e = 0; e < 3; e++) {
    const a = key(r.position, r.index[q + e]), b = key(r.position, r.index[q + (e + 1) % 3]);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  const open = [...edges.values()].filter(n => n % 2).length, four = [...edges.values()].filter(n => n === 4).length;
  assert.equal(open, 0, `${open} of ${edges.size} edges are open (one or three triangles)`);
  assert.ok(four < edges.size * 0.002, `${four} saddle edges`);
  // an edit: the chunks it names re-meshed equal the whole surface meshed again; the others did not change
  const e = editOf('carve', { x: 2, y: f.heightAt(2, 1), z: 1 }, 3);
  const touched = new Set(f.chunksOf(f.apply(e)).map(c => c.join()));
  assert.ok(touched.size > 0 && touched.size < all.size);
  for (const c of every(f)) {
    const r = meshChunk(f, ...c, { top: info.top, orig }), was = all.get(c.join());
    const same = r.index.length === was.index.length && r.position.every((v, i) => v === was.position[i]);
    if (!touched.has(c.join())) assert.ok(same, `chunk ${c} changed but the edit did not name it`);
  }
  // the crater shows soil: some vertex there is inside the ground as it was made
  let cut = 0;
  for (const c of touched) { const r = meshChunk(f, ...c.split(',').map(Number), { top: info.top, orig }); for (let i = 1; i < r.ter.length; i += 2) if (r.ter[i] > 0.5) cut++; }
  assert.ok(cut > 10, `${cut} vertices on cut faces`);
});

test('a ray on the field meets the mesh where it is drawn, within a few centimetres', () => {
  const { field: f } = small();
  for (const [x, z] of [[0, 0], [3, -2], [-5, 4], [6, 6]]) {
    const h = f.raycast([x, 40, z], [0, -1, 0], 80);
    assert.ok(h, `a ray down at ${x}, ${z} meets the ground`);
    assert.ok(Math.abs(h.point[1] - f.heightAt(x, z)) < 0.05, `ray ${h.point[1].toFixed(3)} vs height ${f.heightAt(x, z).toFixed(3)}`);
    assert.ok(h.normal[1] > 0.3, 'the ground faces up');
  }
  assert.equal(f.raycast([0, 40, 0], [0, 1, 0], 50), null, 'up into the sky meets nothing');
  // against the mesh: the ray's point lies within a cell of a mesh vertex
  const r = meshChunk(f, Math.floor((0 - f.origin[0]) / f.cell / CHUNK), Math.floor((f.heightAt(0, 0) - f.origin[1]) / f.cell / CHUNK), Math.floor((0 - f.origin[2]) / f.cell / CHUNK));
  const p = f.raycast([0, 40, 0], [0, -1, 0], 80).point;
  let best = Infinity;
  for (let i = 0; i < r.position.length; i += 3) best = Math.min(best, Math.hypot(r.position[i] - p[0], r.position[i + 1] - p[1], r.position[i + 2] - p[2]));
  assert.ok(best < f.cell, `nearest mesh vertex ${best.toFixed(3)} m from the ray's point`);
});

test('spawns stand on open, flat-enough land above the sea, spread apart, the same every time', () => {
  const { field: f } = generateTerrain({ seed: 5 });
  const s = spawnsOn(f, 8, 5), again = spawnsOn(f, 8, 5);
  assert.deepEqual(s, again);
  assert.equal(s.length, 8);
  for (const p of s) { assert.ok(p.y > 1, `above the sea: ${p.y}`); assert.ok(!f.solid(p.x, p.y + 1, p.z), 'open air above'); }
  let near = Infinity;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) near = Math.min(near, Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z));
  assert.ok(near > 6, `the closest two are ${near.toFixed(1)} m apart`);
  // seats in pairs that see each other, facing each other
  const seats = seatSpawns(f, spawnsOn(f, 16, 5), { count: 8 });
  assert.equal(seats.length, 8);
  for (const [a, b] of [[0, 1], [2, 3]]) {
    assert.ok(inSight(f, seats[a], seats[b]), `seat ${a} sees seat ${b}`);
    const yaw = Math.atan2(seats[b].x - seats[a].x, seats[b].z - seats[a].z);
    assert.ok(Math.abs(Math.atan2(Math.sin(seats[a].yaw - yaw), Math.cos(seats[a].yaw - yaw))) < 1e-9, `seat ${a} faces seat ${b}`);
  }
});

test('carve: crater size from the blast, the feed of a copy that is not the host, logs in pieces', () => {
  assert.equal(craterRadius({ scale: 1.1 }, 2), 2.2);
  assert.equal(craterRadius({ radius: 3 }, 1), 3);
  assert.equal(craterRadius({}, 0), 0);
  assert.equal(craterRadius({ maxRadius: 4 }, 9), 4);
  assert.equal(craterRadius({ minRadius: 1 }, 0.2), 1);
  const f = createFeed(), e = [0, 0, 0, 0, 100];
  assert.equal(f.take(0, 0, e), 'apply');
  assert.equal(f.take(0, 0, e), 'old');
  assert.equal(f.take(0, 2, e), 'gap');
  assert.equal(f.next, 1);
  assert.deepEqual(f.takeLog(0, 0, [e, e, e]), [e, e], 'a log from 0: the two it lacked');
  assert.equal(f.next, 3);
  assert.equal(f.take(1, 0, e), 'apply'); assert.ok(f.fresh, 'a new round starts the feed again');
  const log = Array.from({ length: 300 }, (_, i) => [0, i * 100, 1000, -i * 50, 250]);
  const parts = chunksOf(log, 10, 1000);
  assert.ok(parts.length > 3);
  assert.equal(parts[0][0], 10);
  assert.deepEqual(parts.flatMap(p => p[1]), log);
  let n = 10; for (const [from, l] of parts) { assert.equal(from, n); n += l.length; }
});

test('a field made from another\'s values is the same field (what the worker is sent)', () => {
  const { field: a } = small();
  const b = new TerrainField({ size: a.size, cell: a.cell, origin: a.origin, data: a.d.slice() });
  assert.equal(hashOf(a), hashOf(b));
  assert.equal(a.sample(1.3, 9.7, -2.1), b.sample(1.3, 9.7, -2.1));
});
