// The forge runtime's part of the observation (runtimes/forge/kit/observe.js) and its own judge for measure 39
// (runtimes/forge/tools/measures.mjs), with no browser: the core's events reach the kit's event log as part `forge`,
// naming the players they concern; the aim ray finds what the crosshair is on; hits per kill as the spec says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgePart, frameMeter, aimOf, RULES } from '../runtimes/forge/kit/observe.js';
import { judgeHitsPerKill, hitsAsked, tableHits } from '../runtimes/forge/tools/measures.mjs';
import { createEventLog } from '../runtimes/three/kit/core/events.js';
import { MEASURES_OF, NOT_YET_FORGE, requiredFor } from '../builder/tools/lib/verdict.mjs';

/** A fake core host: on(kind, fn) and emit(kind, event). */
function fakeHost() {
  const ls = new Map();
  return { on: (k, fn) => { ls.set(k, [...(ls.get(k) ?? []), fn]); return () => {}; }, emit: (k, e) => { for (const fn of ls.get(k) ?? []) fn({ kind: k, ...e }); } };
}
const player = (id, x = 0) => ({ id, score: 0, position: { x, y: 0, z: 0 } });

test('the core\'s hits, kills and rule events that name a player reach the kit\'s event log as part forge', () => {
  const host = fakeHost(), p1 = player('p1', 1), p2 = player('p2', 2), byNid = new Map([[1, p1], [2, p2]]);
  const part = forgePart(host, { playerOf: n => byNid.get(n) ?? null });
  const ctx = { time: { now: 3 }, round: { phase: 'playing' }, onFrame: [], players: { list: () => [p1, p2] }, me: p1 };
  const log = createEventLog(ctx, { list: [part], modules: new Map([['forge', { manifest: part.manifest }]]) });
  host.emit('hit', { attacker: 1, target: 77, point: [1, 1, 2] });     // a player hits an enemy
  host.emit('kill', { attacker: 1, target: 77, point: [1, 1, 2] });
  host.emit('hit', { attacker: 77, target: 2, point: [2, 1, 0] });     // an enemy hits the other player
  host.emit('hit', { attacker: 77, target: 78, point: [0, 0, 0] });    // nobody's: not logged
  host.emit('rule', { name: 'enemy-down', entity: 77, a: 0, b: 10, c: 1, d: 1 });   // the killer in d
  host.emit('rule', { name: 'coin', entity: 2, a: 1, b: 0, c: 0, d: 0 });          // the taker in entity
  host.emit('rule', { name: 'wave-start', entity: 0, a: 1, b: 3, c: 0, d: 0 });    // names nobody: not logged
  const ev = log.read().entries.filter(e => e.k === 'event');
  assert.deepEqual(ev.map(e => `${e.part}.${e.name}`), ['forge.onHit', 'forge.onKill', 'forge.onHit', 'forge.enemy-down', 'forge.coin']);
  assert.deepEqual(ev[0].who, { from: 'p1' });
  assert.deepEqual(ev[2].who, { target: 'p2' });
  assert.deepEqual(ev[3].who, { player: 'p1' });
  assert.deepEqual(ev[4].who, { player: 'p2' });
  assert.deepEqual(ev[0].at, { x: 1, y: 1, z: 2 });
  assert.ok(RULES.includes('enemy-down') && RULES.includes('coin'));
});

test('the aim ray: an enemy in front, a wall behind it, the ground, nothing', () => {
  const eye = [0, 1.7, 0], dir = [0, 0, -1];
  const enemies = [{ net: 9, at: [0, 0, -5], dead: false }, { net: 8, at: [0, 0, -3], dead: true }];
  const colliders = [{ min: [-2, 0, -12], max: [2, 4, -10] }];
  const a = aimOf(eye, dir, { enemies, colliders });
  assert.equal(a.hit, 'enemy'); assert.equal(a.net, 9); assert.ok(Math.abs(a.dist - 4.55) < 0.01, `${a.dist}`);
  assert.equal(aimOf(eye, dir, { colliders }).hit, 'world');
  const down = aimOf(eye, [0, -0.5, -0.866], {});
  assert.equal(down.hit, 'ground'); assert.ok(Math.abs(down.point.y) < 0.01);
  const sky = aimOf(eye, [0, 1, 0], {});
  assert.equal(sky.hit, null); assert.equal(sky.dist, 60);
});

test('the frame meter: frames a second and the median frame time', () => {
  const m = frameMeter();
  assert.deepEqual(m.observe(), { fps: null, frameMs: null });
  for (let i = 0; i < 30; i++) m.frame(1 / 60);
  const o = m.observe();
  assert.equal(o.fps, 60); assert.equal(o.frameMs, 16.7);
});

test('measure 39 on forge: the spec\'s ask, the tables\' arithmetic and the measured kills', () => {
  const game = { forge: { weapons: [{ id: 'pistol', damage: 10 }, { id: 'blade', damage: 40 }], enemies: [{ id: 'grunt', archetype: 'chaser', health: 30 }, { id: 'lord', archetype: 'boss', health: 900 }] } };
  const holdable = [{ row: 0, id: 'pistol', name: 'Pistol' }, { row: 1, id: 'blade', name: 'Blade' }];
  assert.deepEqual(hitsAsked({}), { want: 2, why: 'the spec does not set hitsPerKill: the default, 2' });
  assert.equal(hitsAsked({ tables: { oneHitKills: true } }).want, 1);
  assert.deepEqual(tableHits(game, holdable).map(t => t.hits), [3, 1]);
  const r = judgeHitsPerKill({ game, spec: {}, holdable, measured: { rows: [{ id: 'pistol', name: 'Pistol', kills: [3, 3, 4] }] } });
  assert.equal(r.ok, false); assert.match(r.detail, /Blade does 40 a hit against the weakest enemy's 30 hit points, 1 hit a kill/);
  const ok = judgeHitsPerKill({ game, spec: { tables: { oneHitKills: true } }, holdable, measured: null });
  assert.equal(ok.ok, true, ok.detail);
  const measured = judgeHitsPerKill({ game: { forge: { ...game.forge, weapons: [game.forge.weapons[0]] } }, spec: {}, holdable: [holdable[0]], measured: { rows: [{ id: 'pistol', name: 'Pistol', kills: [1, 1, 2] }] } });
  assert.equal(measured.ok, false); assert.match(measured.detail, /median 1/);
  assert.equal(judgeHitsPerKill({ game: { forge: {} }, spec: {} }).ok, true);
});

test('forge records 12, 35, 38 and 39 and has nothing "not yet" but the mechanics', () => {
  for (const n of [12, 35, 38, 39]) assert.ok(MEASURES_OF.forge.includes(n), `measure ${n}`);
  for (const n of [12, 35, 38, 39]) assert.ok(requiredFor('forge').includes(n), `required ${n}`);
  assert.deepEqual(Object.keys(NOT_YET_FORGE), ['mechanics']);
});
