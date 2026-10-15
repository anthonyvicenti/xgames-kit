// World connectors (the gameplay layer, 2026-10-14: "making all area reachable"): the walk grid's regions (the ground the
// seats cannot get to, the traps they cannot leave), the planner that joins each region worth going to with the cheapest
// connector that fits (worlds/connect.mjs), the terrain's connectors made in its distance field (worlds/terrain/connect.mjs),
// launch pads on any world (worlds/pads.js) and the gate's verdict on a world's areas (judgeAreas). No browser: Rapier in
// Node, worlds made of boxes, small generated terrains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { VENDOR } from '../builder/tools/lib/paths.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { createWalk, boxSurfaces } from '../worlds/walk.mjs';
import { worthOf, apartOf, connectorsFor, connectRegions, judgeAreas, reachConfig, CONNECT_DEFAULTS } from '../worlds/connect.mjs';
import { generateTerrain } from '../worlds/terrain/generate.mjs';
import { fieldSource } from '../worlds/terrain/connect.mjs';
import { judgeReach } from '../builder/tools/lib/reach-check.mjs';

const P = await importLayer(join(KIT_ROOT, 'worlds/placement.js'));
const R = (await import(pathToFileURL(join(VENDOR.rapier, 'rapier.mjs')).href)).default;
{ const w = console.warn; console.warn = () => {}; await R.init(); console.warn = w; }

/** A walk over boxes ({min, max}), with water at `sea` and the seats given. */
const boxWalk = (boxes, { seats, sea = null, area = [-30, -20, 30, 20], links = [] }) => createWalk({ area: () => area, surfaces: boxSurfaces({ boxes }), water: sea == null ? undefined : () => sea, seats: () => seats, links: () => links });
const B = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

test('regions: the ground the seats cannot get to, with the way across and why (water, a cliff, a wall), biggest first', () => {
  const w = boxWalk([
    B(-20, -2, -10, -4, 0, 10),          // the seats' island: top at 0
    B(6, -2, -8, 18, 0, 8),              // an island 10 m across the water
    B(-12, 0, 4, -6, 4, 9),              // a plateau 4 m up on the seats' island (a cliff)
    B(-20, -3, -20, 30, -2, 20),         // the sea bed
  ], { seats: [{ x: -14, y: 0, z: -4 }], sea: -0.5 });
  const R0 = w.walk.regions();
  assert.ok(R0.seats.area > 200, JSON.stringify(R0.seats));
  const isle = R0.regions.find(r => r.at[0] > 5), plateau = R0.regions.find(r => r.at[1] > 3);
  assert.ok(isle && plateau, JSON.stringify(R0.regions.map(r => [r.at, r.area])));
  assert.equal(isle.gap.why, 'water');
  assert.ok(Math.abs(isle.gap.across - 10) < 1.5, `across ${isle.gap.across}`);
  assert.equal(plateau.gap.why, 'cliff');
  assert.ok(plateau.gap.rise > 3.5);
  assert.ok(R0.regions[0].places >= R0.regions[1].places, 'biggest first');
});

test('a link (a launch pad) joins a region; a trap is ground the seats drop into and cannot leave', () => {
  const boxes = [B(-20, -2, -10, -4, 0, 10), B(6, -2, -8, 18, 0, 8), B(-20, -3, -20, 30, -2, 20)];
  const links = [];
  const w = boxWalk(boxes, { seats: [{ x: -14, y: 0, z: 0 }], sea: -0.5, links });
  assert.equal(w.reach(0, { x: 12, y: 0, z: 0 }).ok, false);
  links.push({ from: { x: -6, y: 0, z: 0 }, to: { x: 8, y: 0, z: 0 } }, { from: { x: 8, y: 0, z: 0 }, to: { x: -6, y: 0, z: 0 } });
  w.walk.relink();
  assert.equal(w.reach(0, { x: 12, y: 0, z: 0 }).ok, true, 'over the pad');
  // a pit 3 m deep in the seats' ground: walked into (a drop), never out
  const pit = boxWalk([B(-20, -2, -10, -8.1, 0, 10), B(-3.9, -2, -10, 10, 0, 10), B(-8.1, -5, -10, -3.9, -3, 10)], { seats: [{ x: -14, y: 0, z: 0 }] });
  const t = pit.walk.regions().regions.find(r => r.trap);
  assert.ok(t, 'the pit is a trap');
  assert.ok(Math.abs(t.at[1] + 3) < 0.2 && t.gap.out, JSON.stringify(t.gap));
  // the ground past the pit is a jump too far from the seats' side and a climb too high from the pit's floor
  assert.ok(pit.walk.regions().regions.some(r => r.at[0] > 0), 'the ground past the pit is out of reach');
});

test('worth: what stands on a region, or room to play; the top of a thing, a bridge\'s deck and a ribbon of ground are not places', () => {
  const r = (o = {}) => ({ area: 10, core: 0, things: [], at: [0, 0, 0], box: [-2, -2, 2, 2], ...o });
  assert.match(worthOf(r({ things: [{ kind: 'objective', id: 'pickup:3' }] })), /objective pickup:3/);
  assert.match(worthOf(r({ things: [{ kind: 'landmark', id: 'gatehouse' }] })), /landmark gatehouse/);
  assert.match(worthOf(r({ things: [{ kind: 'prop', id: 'ruin' }, { kind: 'prop', id: 'palm' }] })), /set dressing \(2/);
  assert.equal(worthOf(r({ things: [{ kind: 'prop', id: 'crate' }] })), null, 'one crate is not a place');
  assert.match(worthOf(r({ area: 120, core: 40 })), /120 m² of ground/);
  assert.equal(worthOf(r({ area: 120, core: 2 })), null, 'a ribbon of beach under a cliff');
  assert.equal(worthOf(r({ area: 300, core: 100, on: 'things' })), null, 'the tops of walls');
  assert.equal(worthOf(r({ area: 40, core: 10, things: [{ kind: 'bridge', id: 'bridge#1', share: 0.9 }] })), null, 'a deck');
  assert.match(worthOf(r({ area: 400, core: 100, things: [{ kind: 'bridge', id: 'bridge#1', share: 0.1 }] })), /400 m²/, 'an island a deck leads to');
  assert.match(worthOf(r({ things: [{ kind: 'seat', id: 3 }] })), /seat 3/);
  // apart: by a thing's id, by a place, and the seats
  const isle = r({ things: [{ kind: 'landmark', id: 'gatehouse' }, { kind: 'seat', id: 2 }], box: [10, -5, 20, 5] });
  assert.equal(apartOf(isle, [{ what: 'gatehouse', why: 'a backdrop to aim at' }]).why, 'a backdrop to aim at');
  assert.ok(apartOf(isle, [{ what: [15, 0], why: 'the far island' }]));
  assert.ok(apartOf(isle, [{ what: 'seats', why: 'an artillery duel across the water' }]), 'a region with a seat is apart when the seats are');
  assert.equal(apartOf(r(), [{ what: 'seats', why: 'duel' }]), null);
});

test('the connector for a gap: the cheapest that fits, among those the world can build', () => {
  const n = { jumpUp: 1.06 };
  const kinds = g => connectorsFor(g, { numbers: n, sea: 0 }).map(c => c.kind);
  assert.deepEqual(kinds({ from: [0, 0.6, 0], to: [12, 0.9, 0], across: 12, rise: 0.3, why: 'water' }), ['shallows', 'bridge', 'pad'], 'low shores: a sandbar first');
  assert.deepEqual(kinds({ from: [0, 8, 0], to: [14, 7.7, 0], across: 14, rise: -0.3, why: 'water' }), ['bridge', 'pad'], 'cliffs over water: a bridge');
  assert.deepEqual(kinds({ from: [0, 8, 0], to: [1.5, 12, 0], across: 1.5, rise: 4, why: 'cliff' }), ['ramp', 'pad'], 'a cliff: a ramp');
  assert.deepEqual(kinds({ from: [0, 8, 0], to: [40, 12, 0], across: 40, rise: 4, why: 'water' }), ['pad'], 'far: only a pad throws that far');
  assert.deepEqual(kinds({ from: [0, 8, 0], to: [70, 9, 0], across: 70, rise: 1, why: 'water' }), [], 'too far for any');
  // a trap's gap is the way out: its rise is the trap's below it, the climb is the other way
  assert.deepEqual(kinds({ from: [0, 8, 0], to: [1, 3, 0], across: 1, rise: -5, why: 'too far', out: true }), ['ramp', 'pad']);
  assert.deepEqual(connectorsFor({ from: [0, 8, 0], to: [14, 7.7, 0], across: 14, rise: -0.3, why: 'water' }, { kinds: ['ramp', 'pad'], numbers: n }).map(c => c.kind), ['pad'], 'the look allows no bridge');
  assert.equal(reachConfig({ connect: false }).connect, false);
  assert.deepEqual(reachConfig({ kinds: ['bridge', 'ladder'] }).kinds, ['bridge'], 'kinds no world builds are dropped');
});

test('the planner joins regions nearest first, takes back a connector that does not join, and keeps the apart', () => {
  // a world of three regions in a line; "building" a connector to one joins it (so its next analysis drops it)
  let joined = new Set(), log = [];
  const reg = (id, x, area) => ({ id, at: [x, 0, 0], area, core: 50, box: [x - 5, -5, x + 5, 5], things: [], gap: { from: [0, 0, 0], to: [x, 0, 0], across: x - 4, rise: 0, why: 'water' } });
  const all = [reg('near', 12, 100), reg('far', 30, 100), reg('kept', 20, 100)];
  all[2].things.push({ kind: 'landmark', id: 'tower' });
  const world = {
    analyse: () => ({ regions: all.filter(r => !joined.has(r.id)), seats: {} }),
    build: (kind, r) => { log.push(`${kind}:${r.id}`); if (kind === 'bridge' && r.id === 'far') return { at: r.at, ends: [] }; if (kind === 'pad') { joined.add(r.id); return { at: r.at, ends: [] }; } if (kind === 'bridge') { joined.add(r.id); return { at: r.at, ends: [] }; } return null; },
    joined: r => joined.has(r.id),
  };
  const res = connectRegions(world, { numbers: { jumpUp: 1 }, apart: [{ what: 'tower', why: 'the tower is the horizon' }] });
  assert.deepEqual(res.made.map(c => [c.kind, c.for.at[0]]), [['bridge', 12], ['pad', 30]], JSON.stringify(log));
  assert.ok(res.tries.some(t => t.kind === 'bridge' && t.result.startsWith('built, did not join')), 'the far bridge did not join: taken away, a pad instead');
  assert.equal(res.kept.length, 1); assert.equal(res.kept[0].why, 'the tower is the horizon');
  assert.equal(res.left.length, 0);
});

test('the gate\'s verdict on a world\'s areas: names each region, where and why; reads apart reasons, backdrop and a part\'s own way', () => {
  const region = { at: [-39.1, 9.7, -1.2], area: 472, core: 120, box: [-52, -15, -27, 13], y: [1, 16], things: [{ kind: 'prop', id: 'castle-wall-ruin' }, { kind: 'prop', id: 'palm' }], gap: { from: [-13.4, 8, 2.6], to: [-27.5, 7.5, 3.2], across: 14.1, rise: -0.5, why: 'water' } };
  const base = { placement: true, regions: [region], numbers: { jumpUp: 1.06 }, connectors: [], apart: [], backdrop: [] };
  let j = judgeAreas(base);
  assert.equal(j.ok, false);
  assert.match(j.problems[0], /^an area at \(-39\.1, 9\.7, -1\.2\) \(set dressing \(2: castle-wall-ruin, palm\), 472 m²\) cannot be reached: 14\.1 m of water from the seats' ground/);
  j = judgeAreas({ ...base, regions: [{ ...region, gap: { ...region.gap, why: 'cliff', rise: 4.2, across: 1 } }] });
  assert.match(j.problems[0], /a cliff 4\.2 m high \(a jump climbs 1\.1 m\)/);
  j = judgeAreas({ ...base, apart: [{ what: [-40, 0], why: 'the far island is the other team\'s' }] });
  assert.equal(j.ok, true); assert.match(j.kept[0], /kept apart: the far island is the other team's/);
  assert.equal(judgeAreas({ ...base, apart: [{ what: [-40, 0], why: '' }] }).ok, false, 'apart with no reason');
  assert.equal(judgeAreas({ ...base, regions: [], backdrop: [{ id: 'isle-2', at: [70, 10], r: 20, water: 12 }] }).ok, false, 'a backdrop island a swim away');
  assert.equal(judgeAreas({ ...base, regions: [], backdrop: [{ id: 'isle-2', at: [140, 10], r: 20, water: 80 }] }).ok, true);
  j = judgeAreas({ ...base, ways: [{ part: 'build', how: 'players place and break blocks' }] });
  assert.equal(j.ok, true); assert.match(j.kept[0], /1 area the walk cannot get to: build: players place and break blocks/);
  assert.match(judgeAreas({ ...base, regions: [{ ...region, trap: true, gap: { ...region.gap, why: 'cliff', rise: -5, out: true } }] }).problems[0], /is a trap: players get in and cannot get back to the seats \(a cliff 5\.0 m high/);
  const cave = judgeAreas({ ...base, regions: [{ ...region, trap: true, covered: 0.9, gap: { ...region.gap, why: 'cliff', rise: -5, out: true } }] });
  assert.equal(cave.ok, true); assert.match(cave.kept[0], /1 cave the walk reads as a trap, reported/);
  assert.equal(judgeAreas({ ...base, split: true, seatsReach: [{ seat: 0, reaches: [] }, { seat: 1, reaches: [] }] }).problems.length, 2, 'seats apart with nothing saying so');
  // the reach leg reads it from the start of play (judgeReach): one more problem in measure 6
  const objectives = { placement: true, walk: { cell: 0.5, nodes: 100 }, seats: [], parts: [], objectives: [], areas: base };
  const leg = judgeReach([objectives]);
  assert.equal(leg.ok, false); assert.match(leg.detail, /1 reach problem: an area at \(-39\.1/);
  assert.equal(judgeReach([{ ...objectives, areas: { ...base, regions: [] } }]).ok, true);
});

test('a terrain world joins its islands in its own ground: deterministic, every region worth going to reached, apart kept, off when asked', () => {
  const T = { seed: 7, shape: 'islands', size: [96, 34, 60], islands: { count: 3, radius: [11, 14] }, land: { height: 9, hills: 2 } };
  const a = generateTerrain(T), b = generateTerrain(T);
  const C = a.info.connect;
  assert.ok(C.list.length >= 2, JSON.stringify(C.list.map(c => [c.kind, c.why])));
  assert.equal(C.left.length, 0, JSON.stringify(C.left));
  const hash = f => { const d = new Uint32Array(f.d.buffer); let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
  assert.equal(hash(a.field), hash(b.field), 'every copy makes the same connectors');
  // read again over the finished ground: the islands are one region with the seats'
  const src = fieldSource(a.field, { seats: [{ x: C.report.root[0], y: C.report.root[1], z: C.report.root[2] }], links: C.links, seaLevel: 0 });
  const left = createWalk(src).walk.regions().regions.filter(r => worthOf(r));
  assert.equal(left.length, 0, JSON.stringify(left.map(r => [r.at, r.area, r.gap])));
  // off: none made; apart: the far island kept
  assert.equal(generateTerrain(T, { reach: { connect: false } }).info.connect, undefined);
  const far = C.list.at(-1).for.at;
  const kept = generateTerrain(T, { reach: { apart: [{ what: [far[0], far[2]], why: 'the far island is a target to aim at' }] } }).info.connect;
  assert.equal(kept.kept.length, 1); assert.equal(kept.kept[0].why, 'the far island is a target to aim at');
  assert.equal(kept.list.length, C.list.length - 1);
});

test('launch pads on any world: a box world\'s island joined at play, the pads drawn, a body thrown along the arc', async () => {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  W.createCollider(R.ColliderDesc.cuboid(8, 0.5, 8).setTranslation(-10, -0.5, 0), body);    // the seats' island
  W.createCollider(R.ColliderDesc.cuboid(6, 0.5, 6).setTranslation(12, -0.5, 0), body);     // an island 8 m off
  W.step();
  const scene = { add() {}, children: [] };
  const world = { bounds: { min: { x: -20, y: -3, z: -10 }, max: { x: 20, y: 6, z: 10 } }, spawns: [{ x: -12, y: 0, z: 0 }], zone: () => null, layout: {}, root: { add() {} } };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {}, scene }, { water: () => -0.2 });
  assert.equal(world.reach(0, { x: 12, y: 0, z: 0 }).ok, false, 'before play: out of reach');
  assert.equal(world.walk.ready(), true);
  assert.ok(world.connectors?.list?.some(c => c.kind === 'pad' && c.runtime), JSON.stringify(world.joined));
  assert.equal(world.reach(0, { x: 12, y: 0, z: 0 }).ok, true, 'after: over the pads');
  // the arc lands on the far pad
  const { padArc } = await importLayer(join(KIT_ROOT, 'worlds/pads.js'));
  const arc = padArc({ x: -4, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
  const end = arc.at(arc.T);
  assert.ok(Math.abs(end.x - 8) < 1e-6 && Math.abs(end.y) < 1e-6 && end.done, JSON.stringify(end));
  assert.ok(arc.apex > 2, 'over the rims it crosses');
  void CONNECT_DEFAULTS;
});
