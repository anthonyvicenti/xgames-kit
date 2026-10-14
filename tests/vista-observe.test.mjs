// The vista runtime's part of the observation, with no browser: the core's public files as slots (kit/core-files.js,
// kit/config.js coreSlots), what each core module draws (kit/coverage.js), the game's events in the kit's event log
// (kit/observe.js vistaPart), the aim over the island and the sea, and the measures vista records now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CORE_FILES } from '../runtimes/vista/kit/core-files.js';
import { coreSlots, slotsFor, CORE_PUBLIC } from '../runtimes/vista/kit/config.js';
import { tagOf, coverage, stampAdds } from '../runtimes/vista/kit/coverage.js';
import { vistaPart, aimOf, EVENTS } from '../runtimes/vista/kit/observe.js';
import { createEventLog } from '../runtimes/three/kit/core/events.js';
import { requiredFor, NOT_YET_VISTA } from '../builder/tools/lib/verdict.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('kit/core-files.js is the core\'s public files', async () => {
  await promisify(execFile)(process.execPath, [`${ROOT}runtimes/vista/tools/core-files.mjs`, '--check']);
  assert.ok(CORE_FILES.length > 50);
  assert.ok(CORE_FILES.some(f => f.slot === 'core.props.props' && f.type === 'data'), 'the stall props are read from props.json (and props.bin)');
});

test('every core file is a slot of its own, read from gf/vista/core/public', () => {
  const s = coreSlots();
  assert.equal(s.length, CORE_FILES.length);
  assert.equal(new Set(s.map(x => x.id)).size, s.length, 'ids are unique');
  for (const x of s) { assert.ok(x.source.file.startsWith(CORE_PUBLIC)); assert.equal(x.tier, 'advanced'); }
  assert.ok(slotsFor({}).some(x => x.id === 'core.whale.humpback'));
});

test('what each core module adds is tagged with its slot, the sea with look.sea, and the rest is code-made', () => {
  assert.equal(tagOf({ name: 'debris-scan-lod0' }, ['world/Debris.js'])['slots'][0], 'core.debris.dead-quiver-branch-01');
  assert.deepEqual(tagOf({ name: '' }, ['engine/loaders/GLTF.js', 'game/FishStand.js']).slots, ['core.characters.joe']);
  assert.deepEqual(tagOf({ name: '' }, ['engine/loaders/GLTF.js', 'game/Chandlery.js']).slots, ['core.characters.marta']);
  assert.deepEqual(tagOf({ name: '' }, ['engine/render/Skinning.js', 'game/FishStand.js']).slots, ['core.characters.joe']);
  assert.equal(tagOf({ name: 'FishStandStall' }, ['game/FishStand.js']).slots[0], 'core.props.props');
  assert.deepEqual(tagOf({ name: 'ocean' }, ['App.js']).slots, ['look.sea']);
  assert.deepEqual(tagOf({ name: 'whale' }, ['world/marine/Whale.js']).slots.slice(0, 1), ['core.whale.humpback']);
  assert.equal(tagOf({ name: 'rock' }, ['world/Rocks.js']).exempt, 'code-made by the core (world/Rocks.js)');
  assert.deepEqual(tagOf({ name: '?' }, []), { slots: [], exempt: null });
});

test('stampAdds records the modules on the stack, and coverage counts tagged, code-made and untagged', () => {
  class O { constructor(name, mesh = false) { this.name = name; this.userData = {}; this.children = []; this.visible = true; this.parent = null; if (mesh) { this.isMesh = true; this.material = {}; this.geometry = {}; } }
    add(...c) { for (const x of c) { x.parent = this; this.children.push(x); } return this; }
    traverseVisible(fn) { if (!this.visible) return; fn(this); for (const c of this.children) c.traverseVisible(fn); } }
  stampAdds(O);
  const scene = new O('scene'), body = new O('friend'), m = new O('body-mesh', true), stray = new O('stray', true);
  body.userData.gfSlot = 'character.body.player'; body.add(m); scene.add(body);
  scene.add(stray);
  assert.deepEqual(stray.userData.gfFrom, [], 'no core module on this stack');
  const sea = new O('ocean', true); sea.userData.gfFrom = ['App.js']; scene.add(sea);
  const rock = new O('rock', true); rock.userData.gfFrom = ['world/Rocks.js']; scene.add(rock);
  const c = coverage(scene, { has: id => id !== 'look.sea' });
  assert.equal(c.meshes, 4); assert.equal(c.tagged, 2); assert.equal(c.exempt, 1); assert.equal(c.untagged.length, 1);
  assert.deepEqual(c.unknownSlots, ['look.sea']);
  assert.deepEqual(c.exemptBy, { 'code-made by the core (world/Rocks.js)': 1 });
});

test('the game\'s events reach the kit\'s event log as part vista, naming this copy\'s player', () => {
  const ls = new Map(), vgame = { on: (n, fn) => ls.set(n, fn) };
  const me = { id: 'p1', score: 0, position: { x: 1, y: 0, z: 2 } };
  const ctx = { time: { now: 4 }, round: { phase: 'playing' }, onFrame: [], players: { list: () => [me] }, me };
  const part = vistaPart(vgame, ctx);
  const log = createEventLog(ctx, { list: [part], modules: new Map([['vista', { manifest: part.manifest }]]) });
  ls.get('catch')({ species: 'snapper' }); ls.get('sold')({ total: 5 });
  const ev = log.read().entries.filter(e => e.k === 'event');
  assert.deepEqual(ev.map(e => `${e.part}.${e.name}`), ['vista.catch', 'vista.sold']);
  assert.deepEqual(ev[0].who, { player: 'p1' });
  assert.deepEqual(EVENTS.length, 8);
});

test('the aim over the island: the ground, the sea, the sky', () => {
  const ground = (x, z) => (x < 10 ? 2 : -5);
  assert.equal(aimOf(ground, [0, 4, 0], [0, -1, 0]).hit, 'ground');
  assert.equal(aimOf(ground, [20, 4, 0], [0, -1, 0]).hit, 'water');
  assert.equal(aimOf(ground, [0, 4, 0], [0, 1, 0]).hit, null);
});

test('vista records 4, 12, 35 and 38 now; what stays not yet says why', () => {
  for (const n of [4, 12, 35, 38]) { assert.ok(requiredFor('vista').includes(n), `required ${n}`); assert.ok(!(n in NOT_YET_VISTA)); }
  for (const [n, [, why]] of Object.entries(NOT_YET_VISTA)) assert.ok(why.length > 20, `${n} has its reason`);
});
