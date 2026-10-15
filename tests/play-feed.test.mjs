// The play feed's pure part (runtimes/three/kit/core/play.js) and the play judge's measured parts (builder/play/measure.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, typeOf, actorsOf, reachOf, objectivesOf, typeOfWord } from '../runtimes/three/kit/core/play.js';
import { measured, wantOf, HARD } from '../builder/play/measure.mjs';
import { createAgent, keysOfRows } from '../builder/play/agent.mjs';
import { countsOf, roundOf } from '../builder/play/session.mjs';

const ev = (t, part, name, who = {}) => ({ k: 'event', part, name, who, t, ph: 'playing' });

test('event types: the manifests\' names, a game\'s own by its words, scores, and what is not counted', () => {
  assert.equal(typeOf(ev(1, 'pickup', 'onCollect')), 'pickup');
  assert.equal(typeOf(ev(1, 'health', 'onHurt')), null);            // every copy's echo of onDamage
  assert.equal(typeOf(ev(1, 'projectile', 'onFire')), 'attempt');
  assert.equal(typeOf(ev(1, 'rules', 'crater-blast')), 'blast');
  assert.equal(typeOf(ev(1, 'rules', 'blast-knock')), 'knockout');   // a knock is said before a blast
  assert.equal(typeOf(ev(1, 'rules', 'whatever')), 'goal');          // a counted event of the game's own counts
  assert.equal(typeOf({ k: 'score', from: 0, to: 1 }), 'score');
  assert.equal(typeOf({ k: 'input', action: 'primary' }), null);
  assert.equal(typeOf(ev(1, 'x', 'onCollect'), { names: { 'x.onCollect': 'goal' } }), 'goal');   // a manifest's own type wins
  assert.equal(typeOfWord('fell-in-water'), 'death');
  assert.deepEqual(actorsOf(ev(1, 'projectile', 'onHit', { shooter: 'p1', target: 'p2' })), { actor: 'p1', target: 'p2' });
  assert.deepEqual(actorsOf(ev(1, 'rules', 'steal', { player: 'p1', target: 'p1' })), { actor: 'p1', target: null });
  assert.deepEqual(actorsOf(ev(1, 'knockback', 'onFling', { from: 'p1', player: 'p2' })), { actor: 'p1', target: 'p2' });
  assert.deepEqual(actorsOf(ev(1, 'hazards', 'onFall', { by: 'p2', player: 'p1' })), { actor: 'p2', target: 'p1' });
  assert.deepEqual(actorsOf(ev(1, 'knockback', 'onFling', { from: 'p1', player: 'p1' })), { actor: 'p1', target: null });
});

test('the tracker: events a minute, dead air, interactions, combos, idle, leads, objectives taken', () => {
  const T = createTracker();
  const players = [{ id: 'p1', score: 0 }, { id: 'b1', bot: true, score: 0 }];
  T.start(1, 10, players);
  // b1 stands still the whole round; p1 walks
  for (let t = 10; t <= 70; t += 0.25) T.sample(t, [{ id: 'p1', x: t, z: 0, score: t > 40 ? 2 : t > 20 ? 1 : 0 }, { id: 'b1', x: 0, z: 0, score: t > 30 ? 1 + (t > 50 ? 2 : 0) : 0 }],
    [{ id: 'pickup:0', kind: 'pickup', x: 30, z: 0, open: t < 30, reach: true }, { id: 'pickup:1', kind: 'pickup', x: 5, z: 50, open: true, reach: false, why: 'no ground under it: it is out at sea' }]);
  T.ingest([ev(12, 'pickup', 'onCollect', { player: 'p1' }), ev(12.5, 'pickup', 'onCollect', { player: 'p1' }), ev(13, 'pickup', 'onCollect', { player: 'p1' })]);
  T.ingest([ev(20, 'projectile', 'onHit', { shooter: 'p1', target: 'b1' }), ev(20.1, 'health', 'onDamage', { from: 'p1', target: 'b1' })]);
  T.ingest([{ ...ev(5, 'pickup', 'onCollect', { player: 'p1' }), ph: 'countdown' }]);   // before the round: not counted
  T.end(70, { winners: ['p1'], reason: 'time', rows: [{ id: 'p1', value: 2 }, { id: 'b1', value: 3 }] });
  const R = T.read().rounds[0];
  assert.equal(R.seconds, 60);
  assert.equal(R.events.byType.pickup, 3);
  assert.equal(R.events.byType.hit, 1, 'the projectile\'s hit and the health\'s damage are one hit');
  assert.equal(R.events.byType.combo, 1);
  assert.equal(R.events.meaningful, 4, 'a combo is not counted as one more thing done');
  assert.equal(R.events.first, 2);
  assert.equal(R.events.longestGap, 50);
  assert.equal(R.interactions.total, 1);
  assert.deepEqual(R.interactions.pairs, { 'p1>b1': 1 });
  assert.ok(R.idle.share.b1 > 0.8 && R.idle.share.p1 < 0.05, JSON.stringify(R.idle));
  assert.ok(R.leads.changes >= 1);
  assert.equal(R.objectives.present, 2);
  assert.equal(R.objectives.takenSpots, 1);
  assert.equal(R.objectives.unreachable, 1);
  assert.deepEqual(R.outcome, { winners: ['p1'], reason: 'time', scores: { p1: 2, b1: 3 }, margin: 1 });
  assert.equal(R.quiet.longest.b1, 50);
});

test('reach: the ground under a spot, the sea, inside the ground, a jump above it, and the world\'s own answer', () => {
  const terrain = h => ({ terrain: { heightAt: () => h }, seaLevel: 0 });
  assert.equal(reachOf(terrain(3), { x: 0, y: 3, z: 0 }).reach, true);
  assert.match(reachOf(terrain(12), { x: 0, y: 0, z: 0 }).why, /inside the ground \(12 m/);
  assert.match(reachOf(terrain(-4), { x: 0, y: 0, z: 0 }).why, /in the sea/);
  assert.match(reachOf({ terrain: { heightAt: () => null }, seaLevel: 0 }, { x: 0, y: 0, z: 0 }).why, /out at sea/);
  assert.match(reachOf(terrain(0), { x: 0, y: 5, z: 0 }).why, /above the ground/);
  assert.equal(reachOf({ reach: () => ({ ok: false, why: 'behind a wall' }), terrain: { heightAt: () => 0 } }, { x: 0, y: 0, z: 0 }).why, 'behind a wall');
  assert.equal(reachOf({}, { x: 0, y: 0, z: 0 }).reach, null);
  const yard = { bounds: { min: { x: -20, y: 0, z: -16 }, max: { x: 20, y: 4, z: 16 } }, terrain: { heightAt: () => 0 } };
  assert.match(reachOf(yard, { x: 27, y: 0, z: 0 }).why, /outside the play area/);
  assert.equal(reachOf(yard, { x: 19, y: 0, z: 0 }).reach, true);
  const objs = objectivesOf([{ id: 'pickup', objectives: () => [{ id: 'a', x: 1, z: 2, open: false }] }, { id: 'station', interactables: () => [{ kind: 'station', x: 3, z: 4, reach: 2 }] }, { id: 'x', standin: true, objectives: () => [{ x: 0, z: 0 }] }]);
  assert.deepEqual(objs.map(o => [o.id, o.open, o.near]), [['a', false, 1], ['station:1', true, 2]]);
});

const round = (o = {}) => ({ seconds: 90, players: 3, bots: 2, done: true, outcome: { scores: { p1: 0, b1: 0 } }, events: { meaningful: 0, perMinute: 0, first: null, longestGap: 90, byType: {}, byName: {} }, interactions: { perMinute: 0 }, idle: { share: { p1: 0.1, b1: 0.5 } }, quiet: { longest: { p1: 90, b1: 90 } }, leads: { changes: 0 }, objectives: { present: 10, takenSpots: 0 }, ...o });

test('measured: the creator\'s case (every berry at sea or underground, nothing happens) is hard, twice over', () => {
  const objectives = Array.from({ length: 10 }, (_, i) => ({ id: `pickup:${i}`, kind: 'pickup', reach: false, why: i < 7 ? 'no ground under it: it is out at sea' : 'inside the ground (11 m under its surface)', taken: 0, closest: 9 }));
  const m = measured({ rounds: [{ round: round() }, { round: round() }], objectives, spec: { loop: 'round', multiplayer: { together: 'versus' } } });
  assert.deepEqual(m.hard.map(h => h.part).sort(), ['deadAir', 'objective']);
  assert.match(m.hard.find(h => h.part === 'objective').line, /no objective can be reached: all 10 \(pickup\)/);
  assert.match(m.findings.find(f => f.part === 'objective').line, /7 out in the sea, 3 inside the ground/);
  assert.ok(m.score < 10, String(m.score));
});

test('measured: most objectives out of reach is hard even when a few in the shallows were taken (Sunny Castle)', () => {
  const objectives = Array.from({ length: 10 }, (_, i) => ({ id: `pickup:${i}`, kind: 'pickup', reach: i < 2 ? true : false, why: 'no ground under it: it is out at sea', taken: i < 2 ? 1 : 0, closest: 3 }));
  const r = round({ events: { meaningful: 3, perMinute: 2, first: 5, longestGap: 25, byType: { pickup: 3 }, byName: {} }, objectives: { present: 10, takenSpots: 2 } });
  const m = measured({ rounds: [{ round: r }], objectives, spec: { loop: 'round' } });
  assert.deepEqual(m.hard.map(h => h.line), ['most objectives cannot be reached: 8 of 10 (pickup) are out of a player\'s reach (80%)']);
  assert.match(m.findings.find(f => f.part === 'pace').line, /the round loop's default is 6/);
});

test('measured: objectives behind a fence the ground probe calls reachable are out of reach when nobody gets near and the player gave up', () => {
  const objectives = Array.from({ length: 6 }, (_, i) => ({ id: `p2:pickup:${i}`, kind: 'pickup', reach: true, taken: 0, closest: 9 }));
  const agents = [{ tried: objectives.slice(0, 4).map(o => ({ id: o.id, gaveUp: true, why: 'no closer than 9 m in 9 s of trying' })) }];
  const r = round({ events: { meaningful: 20, perMinute: 13, first: 2, longestGap: 12, byType: { hit: 20 }, byName: {} }, objectives: { present: 6, takenSpots: 0 } });
  const m = measured({ rounds: [{ round: r }, { round: r }], objectives, agents, spec: { loop: 'round' } });
  assert.ok(m.hard.some(h => /most objectives cannot be reached: 4 of 6/.test(h.line)), JSON.stringify(m.hard));
  assert.ok(m.findings.some(f => /4 that nobody got within 3 m of/.test(f.line)));
});

test('measured: a game that plays well scores high with no hard finding; an idle game is hard on dead air alone', () => {
  const good = round({ events: { meaningful: 90, perMinute: 60, first: 1, longestGap: 6, byType: { pickup: 80, hit: 10 }, byName: {} }, interactions: { perMinute: 3 }, idle: { share: { p1: 0.02, b1: 0.2 } }, quiet: { longest: { p1: 8, b1: 12 } }, leads: { changes: 3 }, objectives: { present: 10, takenSpots: 10 }, outcome: { scores: { p1: 30, b1: 25 } } });
  const objectives = Array.from({ length: 10 }, (_, i) => ({ id: `pickup:${i}`, kind: 'pickup', reach: true, taken: 5, closest: 0.2 }));
  const m = measured({ rounds: [{ round: good }, { round: good }], objectives, spec: { loop: 'round', multiplayer: { together: 'versus' } } });
  assert.equal(m.hard.length, 0, JSON.stringify(m.hard));
  assert.ok(m.score >= 90, String(m.score));
  const idle = round({ events: { meaningful: 4, perMinute: 2.7, first: 2, longestGap: 70, byType: { pickup: 4 }, byName: {} }, objectives: { present: 4, takenSpots: 4 } });
  const m2 = measured({ rounds: [{ round: idle }, { round: idle }], objectives: objectives.slice(0, 4), spec: { loop: 'round' } });
  assert.deepEqual(m2.hard.map(h => h.part), ['deadAir']);
  assert.match(m2.hard[0].line, new RegExp(`nothing meaningful happened for 70 s at a stretch in 2 of 2 rounds \\(the line is ${HARD.deadAir} s\\)`));
});

test('the target\'s pacing over the loop\'s defaults, and its own events marked not meaningful', () => {
  assert.equal(wantOf(null, { loop: 'turns' }).idleMax, 60);
  const target = { pacing: { firstAction: 4, eventsPerMinute: 12, idleMax: 20, roundSeconds: 90, comeback: 0.4 }, touchpoints: [{ kind: 'knock' }], events: [{ name: 'taunt', meaningful: false }], objective: { things: [{ what: 'berry', placed: 'ground', count: 10 }] } };
  const w = wantOf(target, { loop: 'round' });
  assert.deepEqual([w.firstAction, w.eventsPerMinute, w.idleMax, w.interactionsPerMinute, w.things.length], [4, 12, 20, 1, 1]);
  // a game with no objective while its target places berries on the ground: hard
  const r = round({ events: { meaningful: 60, perMinute: 40, first: 1, longestGap: 5, byType: {}, byName: { 'rules.taunt': 30 } }, objectives: { present: 0 } });
  const m = measured({ rounds: [{ round: r }], objectives: [], target, spec: {} });
  assert.match(m.hard[0].line, /places 10 berry/);
  assert.equal(m.numbers.eventsPerMinute, 20, 'the 30 taunts are taken out');
  const seated = measured({ rounds: [{ round: round({ idle: { share: { p1: 0.9, b1: 0.9 } }, events: { meaningful: 10, perMinute: 6, first: 3, longestGap: 20, byType: { move: 10 }, byName: {} }, objectives: { present: 0 } }) }], spec: { loop: 'turns' } });
  assert.equal(seated.parts.idle, undefined, 'a turns game sits');
  const blasts = measured({ rounds: [{ round: round({ events: { meaningful: 40, perMinute: 30, first: 2, longestGap: 6, byType: { blast: 30, death: 10 }, byName: {} }, objectives: { present: 0 } }) }], spec: { loop: 'turns', multiplayer: { together: 'turns' } } });
  assert.match(blasts.findings.find(f => f.part === 'interaction').line, /players never touch each other/);
});

test('the scripted player goes for the nearest objective, gives up on one it cannot get closer to, and aims at a rival', () => {
  const a = createAgent({ controls: { primary: 'lob', interact: 'grab' }, rng: () => 0.9 });
  const cam = { dir: [0, -0.3, -1], yaw: 0 };       // looking toward −z: W goes −z
  let act = a.decide({ phase: 'playing', t: 0, me: { x: 0, z: 0 }, players: [], cam, objectives: [{ id: 'o', x: 0, z: -10 }, { id: 'far', x: 30, z: 0 }] });
  assert.deepEqual(act.hold, ['KeyW']);
  for (let t = 0.25; t < 12; t += 0.25) act = a.decide({ phase: 'playing', t, me: { x: 0, z: 0 }, players: [], cam, objectives: [{ id: 'o', x: 0, z: -10 }] });
  const tried = a.report().tried.find(x => x.id === 'o');
  assert.equal(tried.gaveUp, true);
  assert.match(tried.why, /no closer than 10 m/);
  act = a.decide({ phase: 'playing', t: 13, me: { x: 0, z: 0 }, players: [{ id: 'b1', x: 0, z: -6 }], cam, objectives: [] });
  assert.equal(act.fire, true, 'a rival straight ahead');
  assert.deepEqual(countsOf({}, { players: { min: 1, max: 3 } }), [2, 3]);
  assert.deepEqual(countsOf({}, { players: { min: 2, max: 8 } }), [2, 4]);
  assert.equal(roundOf({ round: { seconds: 300 } }).seconds, 120);
  assert.deepEqual(countsOf({ players: { bots: false } }, { players: { min: 1, max: 4 } }), [1]);
  assert.deepEqual(keysOfRows([['R', 'rod'], ['Click', 'cast'], ['E / F', 'board'], ['A D / ← →', 'steer']]), ['KeyR', 'Mouse', 'KeyE', 'KeyF']);
});
