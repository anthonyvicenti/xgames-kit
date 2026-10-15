// Level composition (looks wave 4): set pieces made ground (worlds/terrain/piece.mjs), the composer that stands them as
// the playfield and seats the players round them (worlds/terrain/compose.mjs), the framing maths every composer, the
// camera rig and the look judge's sheet share (worlds/compose.mjs). No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TerrainField, BAND } from '../worlds/terrain/field.mjs';
import { unionPiece, placeTriangles, boundsOf, turn } from '../worlds/terrain/piece.mjs';
import { generateTerrain } from '../worlds/terrain/generate.mjs';
import { landMasses } from '../worlds/terrain/compose.mjs';
import { meshChunk, origOf } from '../worlds/terrain/mesh.mjs';
import { coverage, framedYaw, leanToward, viewOf, hfovOf, ndcOf, inView } from '../worlds/compose.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';

/** A box's 12 triangles (a closed mesh), feet at y = y0. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return Float32Array.from(f.flatMap(t => t.flatMap(i => v[i])));
}
const join3 = (...l) => { const o = new Float32Array(l.reduce((a, t) => a + t.length, 0)); let n = 0; for (const t of l) { o.set(t, n); n += t.length; } return o; };
// a "castle": a keep with two towers; a "bridge": a deck 0.12 m thick (thinner than the field's cell) with two rails
const CASTLE = join3(box([-3, 0, -1.5], [3, 4, 1.5]), box([-4, 0, -1.5], [-2, 7, 0.5]), box([2, 0, -1.5], [4, 6, 0.5]));
const BRIDGE = join3(box([-4, 0.6, -1], [4, 0.72, 1]), box([-4, 0.72, -1], [4, 1.5, -0.9]), box([-4, 0.72, 0.9], [4, 1.5, 1]));
const PIECES = { castle: { tris: CASTLE }, bridge: { tris: BRIDGE } };
const hash = f => { const d = new Uint32Array(f.d.buffer); let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
const COMPOSE = { landmarks: ['castle'], bridges: ['bridge'], playOn: 'around', share: 0.25, bridgeCount: 1, camera: { distance: 5.2, height: 1.7, pitchDeg: 16, fov: 60 }, seats: 8 };
const P = { seed: 4242, shape: 'islands', size: [112, 44, 80], islands: { count: 3 }, land: { height: 11, hills: 3 } };

test('a closed mesh joins the field as ground: inside solid, outside air, its samples owned, the same every time', () => {
  const make = () => {
    const f = new TerrainField({ size: [41, 41, 41], cell: 0.5, origin: [-10, -10, -10] }), own = new Uint8Array(f.d.length);
    const r = unionPiece(f, placeTriangles(CASTLE, { at: [0, -2, 0], yaw: 30, scale: 1.2 }), { owner: 3, own });
    return { f, own, r };
  };
  const { f, own, r } = make();
  assert.ok(r.samples > 100, `${r.samples} samples made ground`);
  assert.ok(f.sample(0, 0, 0) < 0, 'inside the keep is ground');
  assert.ok(f.sample(0, 9, 0) > 0 && f.sample(9, 0, 0) > 0, 'above and beside it is air');
  const a = (j, k, i) => (j * f.nz + k) * f.nx + i;
  assert.equal(own[a(20, 20, 20)], 3, 'the middle sample is the piece\'s');
  assert.equal(own[a(38, 20, 20)], 0, 'the air above is no one\'s');
  assert.equal(hash(make().f), hash(f), 'the same triangles make the same field');
  // a yaw's turn is rounded, so the triangles are placed the same on any engine
  const { c, s } = turn(30); assert.equal(c, Math.round(Math.cos(Math.PI / 6) * 1e6) / 1e6); assert.equal(s, 0.5);
});

test('a deck thinner than the cell is still walkable ground (the shell)', () => {
  const f = new TerrainField({ size: [41, 21, 21], cell: 0.5, origin: [-10, -5, -5] });
  unionPiece(f, placeTriangles(BRIDGE, { at: [0, 0, 0] }), { own: new Uint8Array(f.d.length), shell: 0.35 });
  const y = f.heightAt(0, 0);
  assert.ok(y != null && Math.abs(y - 0.72) < 0.6, `the deck is found to stand on at ${y}`);
  assert.ok(f.sample(0, 0.1, 0) > 0, 'under the deck is air (it is a bridge, not a wall)');
});

test('the mesher marks a piece\'s surface as the piece\'s, the land\'s as the land\'s', () => {
  const f = new TerrainField({ size: [33, 33, 33], cell: 0.5, origin: [-8, -8, -8] }), own = new Uint8Array(f.d.length);
  // a slab of land under a piece
  for (let j = 0; j < f.ny; j++) for (let k = 0; k < f.nz; k++) for (let i = 0; i < f.nx; i++) f.d[(j * f.nz + k) * f.nx + i] = Math.fround(Math.max(-BAND, Math.min(BAND, (f.origin[1] + j * 0.5) - (-2))));
  f.sealEdges();
  unionPiece(f, placeTriangles(CASTLE, { at: [0, -2.2, 0] }), { owner: 1, own });
  const all = []; for (let y = 0; y < f.cy; y++) for (let z = 0; z < f.cz; z++) for (let x = 0; x < f.cx; x++) all.push(meshChunk(f, x, y, z, { orig: origOf(f), own }));
  let piece = 0, land = 0;
  for (const m of all) for (let v = 0; v < m.own.length; v++) { if (m.own[v] > 0) { piece++; assert.ok(m.position[v * 3 + 1] > -2.5, 'a piece vertex stands on the land, not under it'); } else land++; }
  assert.ok(piece > 50 && land > 50, `${piece} piece vertices, ${land} land vertices`);
});

test('the composer stands the landmark on land, bridges two masses, and seats pairs in sight of each other and of it', () => {
  const g = generateTerrain({ ...P, compose: COMPOSE }, { pieces: PIECES }), I = g.info;
  assert.ok(I.landmarks?.length >= 2, 'a landmark and a bridge');
  const castle = I.landmarks.find(l => l.role === 'landmark'), bridge = I.landmarks.find(l => l.role === 'bridge');
  assert.ok(castle.samples > 100, 'the castle is ground');
  assert.ok(castle.at[1] > 1, 'it stands above the sea');
  if (bridge) {
    // its deck joins two different landmasses: walking its length never meets the sea
    const [a, b] = bridge.ends;
    assert.ok(I.compose.masses.length >= 2, 'two masses or more before the bridge joined them');
    for (let t = 0; t <= 1; t += 0.1) { const y = g.field.heightAt(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t); assert.ok(y != null && y > 0.5, `the way across is ground at ${t.toFixed(1)} (${y})`); }
  } else assert.ok(I.compose.notes.some(n => /bridge/.test(n)), 'a bridge left out says why');
  assert.equal(I.pads.length, 8, 'eight seats');
  for (const [i, s] of I.pads.entries()) {
    assert.ok(Number.isFinite(s.yaw), `seat ${i} faces somewhere`);
    assert.ok(s.y > 1, `seat ${i} stands above the sea`);
  }
  const seen = I.compose.seats.filter(s => s.seesPartner && s.seesMark).length;
  assert.ok(seen >= 6, `${seen} of 8 seats see their partner and a landmark`);
  // each seat's camera has its landmark in the frame
  const inFrame = I.pads.filter(s => { const m = I.landmarks.find(l => l.id === s.mark); return m && inView(viewOf(s, s.yaw, COMPOSE.camera), m.centre, -0.1); }).length;
  assert.ok(inFrame >= 6, `${inFrame} of 8 seats' cameras frame their landmark`);
  // the seats round the main landmark come first
  assert.equal(I.pads[0].mark, castle.id);
});

test('composition is deterministic, and a world without one is the ground it always was', () => {
  const a = generateTerrain({ ...P, compose: COMPOSE }, { pieces: PIECES }), b = generateTerrain({ ...P, compose: COMPOSE }, { pieces: PIECES });
  assert.equal(hash(a.field), hash(b.field));
  assert.deepEqual(a.info.pads, b.info.pads);
  const plain = generateTerrain(P), withPieces = generateTerrain(P, { pieces: PIECES });
  assert.equal(hash(plain.field), hash(withPieces.field), 'pieces without a composition change nothing');
  assert.equal(plain.info.landmarks, undefined);
  // no pieces' shapes (a tool that cannot load them): the composition is skipped, never half-made
  assert.equal(hash(generateTerrain({ ...P, compose: COMPOSE }).field), hash(generateTerrain({ ...P }).field));
});

test('a single landmass that asks for a bridge gets a chasm to span', () => {
  const g = generateTerrain({ seed: 7, shape: 'cliffs', size: [112, 44, 80], land: { height: 10 }, compose: { ...COMPOSE } }, { pieces: PIECES });
  assert.ok(g.info.compose.chasm, 'a chasm was cut');
  assert.ok(g.info.compose.masses.length >= 2, 'the land was two masses (before the bridge joined them)');
  assert.ok(landMasses(g.field, 0).length < g.info.compose.masses.length, 'the bridge joins them as one walkable mass');
  assert.ok(g.info.landmarks.some(l => l.role === 'bridge'), 'a bridge spans it');
});

test('framing: the coverage of a piece grows as it comes closer; a seat turns to keep its partner and the landmark in view', () => {
  const tris = placeTriangles(CASTLE, { at: [0, 0, 0] });
  const near = coverage(tris, viewOf({ x: 0, y: 0, z: -8 }, 0, {})), far = coverage(tris, viewOf({ x: 0, y: 0, z: -30 }, 0, {}));
  assert.ok(near > far && far > 0, `near ${near}, far ${far}`);
  const seat = { x: 0, z: 0 }, partner = { x: 0, z: 15 }, mark = { x: 9, z: 10 };
  const yaw = framedYaw(seat, partner, mark, {}), half = hfovOf(60, 16 / 9) / 2;
  const off = p => Math.abs(Math.atan2(Math.sin(Math.atan2(p.x - seat.x, p.z - seat.z) - yaw), Math.cos(Math.atan2(p.x - seat.x, p.z - seat.z) - yaw)));
  assert.ok(off(partner) < half && off(mark) < half, `partner ${off(partner).toFixed(2)}, mark ${off(mark).toFixed(2)} inside ${half.toFixed(2)}`);
});

test('the camera leans toward a landmark in view, at most its cap, and not at all toward one out of view', () => {
  const eye = [0, 2, -5], target = [0, 1.7, 0];
  const turned = (p) => Math.acos(((p[0] - eye[0]) * (target[0] - eye[0]) + (p[1] - eye[1]) * (target[1] - eye[1]) + (p[2] - eye[2]) * (target[2] - eye[2])) / (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) * Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]))) * 180 / Math.PI;
  const p = leanToward(eye, target, [{ centre: [8, 6, 10] }], { fov: 60, aspect: 16 / 9 });
  assert.ok(turned(p) > 1 && turned(p) <= 8.01, `leaned ${turned(p).toFixed(2)} degrees`);
  assert.ok(p[0] > 0 && p[1] > target[1], 'toward the landmark');
  assert.deepEqual(leanToward(eye, target, [{ centre: [0, 2, -30] }], {}), target, 'behind the camera: no lean');
  assert.deepEqual(leanToward(eye, target, [], {}), target);
  // the point the lean gives is still in front of the camera, near the middle of the frame
  const [x, y, z] = ndcOf({ eye, target, fov: 60, aspect: 16 / 9 }, p);
  assert.ok(z > 0 && Math.abs(x) < 0.4 && Math.abs(y) < 0.4);
});

test('the rig leans toward world.landmarks through its frame option, and leaves the yaw the player turned', async () => {
  const { createCameraRig } = await importLayer(join(KIT_ROOT, 'runtimes/three/kit/controller/camera-rig.js'));
  const T = await import('three');
  const plain = new T.PerspectiveCamera(60, 16 / 9, 0.1, 500), leaning = new T.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  const a = createCameraRig({ camera: plain, mode: 'third', yaw: 0 }), b = createCameraRig({ camera: leaning, mode: 'third', yaw: 0, frame: () => ({ marks: [{ centre: [6, 5, 12] }], lean: leanToward }) });
  for (let i = 0; i < 90; i++) { a.update(1 / 60, { x: 0, y: 0, z: 0 }); b.update(1 / 60, { x: 0, y: 0, z: 0 }); }
  const fa = new T.Vector3(), fb = new T.Vector3(); plain.getWorldDirection(fa); leaning.getWorldDirection(fb);
  const deg = fa.angleTo(fb) * 180 / Math.PI;
  assert.ok(deg > 1 && deg < 8.5, `leaned ${deg.toFixed(2)} degrees`);
  assert.equal(b.yaw, 0, 'the player\'s yaw is unchanged');
});

test('sea-islands: the landmark stands in the play area as ground (its own triangles), the seats in pairs round it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { seaLayout } = await import('../worlds/sea.js');
  const { composeSea } = await import('../worlds/sea-compose.mjs');
  const { collidersOf } = await import('../worlds/colliders.js');
  const tpl = JSON.parse(await readFile(join(KIT_ROOT, 'worlds/templates/sea-islands.json'), 'utf8'));
  const L = seaLayout(tpl, { size: 'medium', seed: 5 });
  const c = composeSea(L, { landmarks: ['castle'], playOn: 'around', share: 0.3 }, id => (id === 'castle' ? [7.4, 8, 3.3] : null));
  const mark = c.props.find(p => p.landmark);
  assert.equal(mark.collider, 'mesh', 'solid by its own triangles');
  assert.equal(c.landmarks[0].prop, 'castle');
  assert.equal(c.spawns.length, L.spawns.length);
  assert.equal(c.spawnYaw.length, c.spawns.length);
  const [W, D] = c.size, foot = Math.hypot(7.4, 3.3) / 2 * c.landmarks[0].scale[0];
  for (const [x, , z] of c.spawns) {
    assert.ok(Math.abs(x) < W / 2 && Math.abs(z) < D / 2, 'inside the walls');
    assert.ok(Math.hypot(x, z) > foot, 'off its footprint');
  }
  // seat pairs see each other past the footprint (the line between them misses it)
  for (let i = 0; i + 1 < c.spawns.length; i += 2) {
    const [a, , b] = c.spawns[i], [p, , q] = c.spawns[i + 1], dx = p - a, dz = q - b, t = Math.max(0, Math.min(1, -(a * dx + b * dz) / (dx * dx + dz * dz)));
    assert.ok(Math.hypot(a + dx * t, b + dz * t) > foot * 0.9, `pair ${i / 2} sees past it`);
  }
  // no dressing on its footprint, and no catalog box over it (the world builds its trimesh)
  assert.ok(c.props.filter(p => !p.landmark).every(p => Math.hypot(p.at[0], p.at[2]) > foot + 1));
  const cat = { props: [{ id: 'castle', size: [7.4, 8, 3.3], collider: { shape: 'box', size: [7, 8, 3], offset: [0, 4, 0] } }] };
  assert.ok(!collidersOf({ ...c, props: [mark] }, cat).some(x => x.prop === 'castle'));
  // a layout with no composition is untouched
  assert.deepEqual(seaLayout(tpl, { size: 'medium', seed: 5 }), L);
});

test('a place request passes over a view blocked near the camera (a landmark\'s wall in front of it)', async () => {
  const { lookout, viewClear } = await import('../worlds/lookouts.mjs');
  const flat = () => 2;
  // a wall 4 m in front of the first seat, which faces the second; the other seats look away from it
  const wall = { x0: -3, x1: 3, z: 4 };
  const clear = (from, dir, max) => { if (dir[2] <= 1e-6) return null; const t = (wall.z - from[2]) / dir[2], x = from[0] + dir[0] * t; return t > 0 && t < max && x > wall.x0 && x < wall.x1 ? t : null; };
  const seats = [{ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 12 }, { x: 20, y: 2, z: 0 }, { x: 26, y: 2, z: 0 }];
  const open = lookout({ heightAt: flat, bounds: [-40, -40, 40, 40], seats }, 'seat');
  assert.deepEqual([open.eye[0], open.eye[2]], [0, 0], 'without a ray the flattest first seat');
  const v = lookout({ heightAt: flat, bounds: [-40, -40, 40, 40], seats, clear }, 'seat');
  assert.ok(viewClear(clear, v.eye, v.target), 'the chosen view is open');
  assert.notDeepEqual([v.eye[0], v.eye[2]], [0, 0], 'the walled seat was passed over');
  assert.ok(!v.blocked);
  assert.equal(viewClear(clear, [0, 3.6, 0], [0, 2.4, 12]), false, 'the wall\'s view is blocked');
  assert.equal(viewClear(null, [0, 3.6, 0], [0, 2.4, 12]), true, 'no ray: nothing is known to block');
});

test('set dressing never stands a landmark between a seat\'s camera and the play', async () => {
  const { placeProps } = await importLayer(join(KIT_ROOT, 'worlds/scenery.js'));
  // a seat facing +z: its camera stands behind it at -z, the play ahead; one site right in its corridor, one beside
  const seats = [{ x: 0, z: 0, yaw: 0 }];
  const sites = [{ x: 0, y: 1, z: 8, r: 4 }, { x: 25, y: 1, z: 0, r: 4 }];
  const out = placeProps({ props: ['castle'], density: 0 }, { groundAt: () => 1, bounds: [-40, -40, 40, 40], seats, sites, sizeOf: () => [6, 8, 4] });
  const castles = out.filter(p => p.prop === 'castle');
  assert.ok(castles.length >= 1);
  assert.ok(castles.every(p => Math.abs(p.at[0]) > 5), `no castle in the corridor (${castles.map(p => p.at.join(',')).join(' ')})`);
});
