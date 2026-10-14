// The looks layer's world and camera (looks wave 2): a style target picks and shapes the runtime's world (the closest
// by its world facts; a sea-islands world shaped by relief, cliffs, clouds and dressing), sets the camera rig from the
// frames' horizon and eye height, and sets the place's look values. The sea-islands layout is deterministic, its props
// stand on the ground, its play area is clear, and the set-dressing lint reads its heights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { loadSchemas, SCHEMA } from '../registry/schemas.mjs';
import { rankWorlds, worldPlan, cameraOf, worldLookValues, seaColours, dressingOf, specWithWorld, seaParams, terrainParams as terrainParamsOf } from '../builder/look/world.mjs';
import { applyTarget } from '../builder/look/apply.mjs';
import { readings } from '../builder/look/pitch.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { heightAt, islandOf } from '../worlds/sea.js';

const { validate } = await loadSchemas();
const { generateLayout } = await importLayer(join(KIT_ROOT, 'worlds/generate.js'));
const { collidersOf } = await importLayer(join(KIT_ROOT, 'worlds/colliders.js'));
const RECIPE = JSON.parse(readFileSync(join(KIT_ROOT, 'worlds/templates/sea-islands.json'), 'utf8'));
const PLACE = { runtime: 'three', profile: 'standard-3d' };

/** A target in the shape the judge answers: islands in a sea, or a blocky cave. */
const base = (world, camera = {}) => ({
  schema: 'gf-look-target/1', from: 'refs', confidence: 0.8, reads: ['one', 'two', 'three'],
  palette: { colors: [
    { hex: '#7eaee2', share: 0.3, words: 'light blue', role: 'day sky / sea' }, { hex: '#a1de77', share: 0.2, words: 'green', role: 'grass' },
    { hex: '#5c8970', share: 0.1, words: 'muted green', role: 'grass in shade' }, { hex: '#cb915a', share: 0.1, words: 'orange', role: 'sand / dusk sky' },
    { hex: '#956140', share: 0.1, words: 'brown', role: 'canyon rock' }, { hex: '#594f42', share: 0.1, words: 'dark', role: 'rock shadow / stone' },
  ] },
  lighting: { sky: ['#7eaee2'] }, materials: { texture: 'painted' },
  camera: { view: 'three-quarter', pitch: 15, distance: 'mid', fov: 60, horizon: 0.55, eye: 4, framings: [{ name: 'play', pitch: 15, distance: 8, fov: 60, frame: 'gameplay', height: 4 }, { name: 'scenic', pitch: 25, distance: 30, fov: 60, frame: 'scene', height: 20 }], ...camera },
  world,
});
const ISLANDS = base({ setting: 'islands', also: ['coast', 'ruins'], land: 'islands', horizon: 'sea', water: 'sea', relief: 0.5, sky: { kind: 'cumulus', clouds: 0.45, cloudStyle: 'puff' }, props: { density: 0.5, dressing: ['cartoon pine trees', 'wooden crates', 'cobbled arched bridges'] }, ground: { tile: 4, detail: 'low', crossSection: true }, words: ['small islands in an open sea'] });
const CAVE = { ...base({ setting: 'cave', also: ['hills'], land: 'blocky', horizon: 'walls', water: 'pools', relief: 0.75, ground: { tile: 1, detail: 'mid' } }, { view: 'first-person', fov: 75, horizon: 0.5, eye: 1.6, framings: [{ name: 'play-fp', pitch: 10, distance: 0.5, fov: 75, frame: 'gameplay', height: 1.6 }] }), materials: { texture: 'pixel' } };
const YARD = base({ setting: 'yard', land: 'flat', horizon: 'trees', water: 'none' });

test('the target schema takes the world and the camera facts', () => {
  assert.deepEqual(validate(SCHEMA.lookTarget, ISLANDS), []);
  assert.ok(validate(SCHEMA.lookTarget, base({ setting: 'volcano' })).length, 'a setting outside the list is refused');
});

test('the runtime\'s worlds are ranked by the target\'s place: islands → sea-islands, a blocky cave → voxel, a yard → backyard', () => {
  assert.equal(rankWorlds(ISLANDS, PLACE)[0].id, 'sea-islands');
  assert.equal(rankWorlds(CAVE, PLACE, { loop: 'world' })[0].id, 'voxel');
  // voxel is a world for the world loop only: a round game's blocky target takes the closest of the others
  assert.ok(!rankWorlds(CAVE, PLACE, { loop: 'round' }).some(w => w.id === 'voxel'));
  assert.equal(rankWorlds(YARD, PLACE)[0].id, 'backyard');
  // on the scenic profile the islands are its own
  assert.ok(['island', 'isles'].includes(rankWorlds(ISLANDS, { runtime: 'three', profile: 'scenic-3d' })[0].id));
});

test('a plan shapes a sea-islands world from the target, and a world with no parameters is chosen as it is', () => {
  const art = { ground: { ref: 'pack/meadow-top' }, soil: { ref: 'pack/rock-soil' } };
  const p = worldPlan(ISLANDS, PLACE, { loop: 'round', current: 'backyard', art, dressing: ['tree-pine-cute', 'crate'] });
  assert.equal(p.template, 'sea-islands');
  assert.equal(p.params.relief, 0.5);
  assert.equal(p.params.cloudStyle, 'puff');
  assert.deepEqual(p.params.dressing, ['tree-pine-cute', 'crate']);
  assert.equal(p.params.ground.pattern.file, 'library:pack/meadow-top');
  assert.equal(p.params.ground.pattern.size, 4);
  assert.ok(p.params.ground.pattern.strength < 1, 'a calm ground takes its picture at part strength');
  assert.equal(p.params.cliffs.pattern.file, 'library:pack/rock-soil');
  assert.ok(p.params.cliffs.strata.length >= 2);
  const pushed = seaParams(ISLANDS, { push: 1 });
  assert.ok(pushed.relief > p.params.relief && pushed.clouds > p.params.clouds && pushed.islands > p.params.islands);
  const v = worldPlan(CAVE, PLACE, { loop: 'world', current: 'voxel' });
  assert.equal(v.template, 'voxel'); assert.equal(v.params, null);
  // the spec keeps a voxel world's own params on its own world, and takes a plan's on another
  const spec = { world: { template: 'voxel', params: { terrain: { hills: 1 } } } };
  assert.deepEqual(specWithWorld(spec, v).world.params, { terrain: { hills: 1 } });
  assert.equal(specWithWorld(spec, p).world.template, 'sea-islands');
  assert.equal(specWithWorld({ world: { template: 'backyard' } }, { template: 'voxel', params: null }).world.params, undefined);
});

test('the camera comes from the frames: the horizon gives the pitch, the eye the pivot height, within the rig\'s range', () => {
  const c = cameraOf(ISLANDS, 'third').settings;
  assert.equal(c.fov, 60);
  assert.equal(c.pitchDeg, 6, 'a horizon at 55% is about 3 degrees down: held at the rig\'s 6');
  assert.equal(c.distance, 8);
  assert.ok(Math.abs(c.height - (4 - 8 * Math.sin(6 * Math.PI / 180))) < 0.02);
  // the play framing's fov (60) sets the pitch: tan(p) = 0.3 · 2 · tan(30°), about 19 degrees
  const low = cameraOf(base({}, { horizon: 0.8 }), 'third').settings;
  assert.ok(low.pitchDeg > 18.9 && low.pitchDeg < 19.3, `a horizon at 80% with a 60° fov is about 19° down (${low.pitchDeg})`);
  assert.deepEqual(cameraOf(CAVE, 'first').settings, { fov: 75 });
  const wide = cameraOf(ISLANDS, 'third', { framing: 'scenic' }).settings;
  assert.equal(wide.pitchDeg, 25); assert.equal(wide.distance, 14);
  assert.equal(cameraOf({ reads: [] }, 'third'), null);
});

test('the place\'s look values: an open sea deepened from a sky colour it shares; a pool keeps the look\'s water; block worlds keep their ground', () => {
  const v = worldLookValues(ISLANDS);
  assert.ok(v.materials.water.deep && v.materials.water.shallow);
  assert.equal(v.materials.ground.tile, 8);
  assert.equal(seaColours({ ...CAVE, palette: { colors: [] } }), null);
  assert.equal(worldLookValues(CAVE).materials?.ground, undefined);
});

test('set dressing words find library props by their head noun; words with none are said', async () => {
  const props = [{ id: 'tree-pine-cute', tags: ['tree'] }, { id: 'crate', tags: ['box'] }, { id: 'tree-puffy', tags: [] }, { id: 'cloud-puffy', tags: ['cloud'] }, { id: 'flag', tags: [] }];
  const d = await dressingOf(['cartoon pine trees', 'wooden crates', 'cobbled arched bridges', 'flags', 'puffy clouds'], { props });
  assert.deepEqual(d.ids, ['tree-pine-cute', 'crate', 'flag']);
  assert.deepEqual(d.missing, ['cobbled arched bridges', 'puffy clouds']);
});

test('create\'s seam sets the camera rig from the target after the kind, and says when the place reads as another world', () => {
  const C = { look: { preset: 'jelly-pastel', time: 'day' }, game: { camera: 'third', controller: { camera: { third: { distance: 7.5, height: 3.2, fov: 55, sensitivity: 0.0026 } } } } };
  const spec = { runtime: 'three', profile: 'standard-3d', loop: 'round', world: { template: 'backyard' }, look: { target: ISLANDS } };
  const { notes } = applyTarget(C, spec, { place: PLACE });
  assert.equal(C.game.controller.camera.third.fov, 60);
  assert.equal(C.game.controller.camera.third.sensitivity, 0.0026, 'what the target does not say stays');
  assert.ok(C.look.materials.water.deep);
  assert.ok(notes.some(n => /reads as sea-islands/.test(n)));
});

test('the pitch\'s readings differ in place and camera: the pushed one lower and closer with more land, the third the wide view', () => {
  const [a, b, c] = readings(ISLANDS);
  assert.deepEqual(a.world, { rank: 0, push: 0 });
  assert.equal(b.world.push, 1);
  assert.ok(b.target.camera.eye < a.target.camera.eye);
  assert.equal(c.world.next, true);
  assert.equal(c.target.camera.framings[0].name, 'scenic');
  assert.equal(c.target.camera.horizon, null);
});

test('a sea-islands layout: the same every time, its play area flat and clear, its props on the ground, its hills walkable', () => {
  const recipe = { ...RECIPE, params: { ...RECIPE.params, dressing: ['tree-pine-cute', 'crate', 'rock-large'] } };
  const a = generateLayout(recipe, { size: 'medium', seed: 7 }), b = generateLayout(recipe, { size: 'medium', seed: 7 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.size, [40, 32]);
  assert.equal(a.islands.filter(i => i.play).length, 1);
  assert.equal(a.islands.length, 1 + RECIPE.params.islands);
  assert.equal(heightAt(a, 0, 0), 0);
  assert.equal(islandOf(a, 2000, 0), null, 'far out is the sea');
  for (const p of a.props) assert.ok(Math.abs(p.at[1] - heightAt(a, p.at[0], p.at[2])) < 0.011, `${p.prop} stands on the ground`);
  for (const s of a.spawns) assert.ok(a.props.every(p => Math.hypot(p.at[0] - s[0], p.at[2] - s[2]) > 1.3), 'every spawn has clear floor');
  assert.ok(a.sky.clouds.list.length > 0);
  const none = generateLayout({ ...recipe, params: { ...recipe.params, clouds: 0.5, cloudStyle: 'none' } }, { size: 'small', seed: 7 });
  assert.equal(none.sky.clouds.list.length, 0);
  // the hills that reach the play area are colliders (hulls of their domes)
  const hulls = collidersOf(a, { props: [] }).filter(c => c.shape === 'hull');
  assert.ok(hulls.length >= 0 && hulls.every(h => h.points.length % 3 === 0));
});

test('the set-dressing lint reads a sea-islands world\'s heights: no errors (no prop floats or sinks on its hills and islands)', async () => {
  const { lintDressing, loadSubject } = await import('../builder/tools/lib/dressing.mjs');
  const report = lintDressing(await loadSubject('sea-islands:medium'));
  const bad = (report.problems ?? report).filter(p => p.severity === 'error');
  assert.deepEqual(bad.map(p => p.message), []);
});

test('a breaking ground ranks the terrain world first; it is shaped from the target with its scenery', async () => {
  const T = { ...ISLANDS, world: { ...ISLANDS.world, destructible: true } };
  assert.equal(rankWorlds(T, PLACE)[0].id, 'terrain');
  assert.equal(rankWorlds(ISLANDS, PLACE)[0].id, 'sea-islands', 'ground that does not break keeps the lighter world');
  const art = { ground: { ref: 'pack/meadow-top' }, soil: { ref: 'pack/rock-soil' } };
  const p = worldPlan(T, PLACE, { art, dressing: ['tree-pine-cute', 'flag'] }).params;
  assert.equal(p.shape, 'islands');
  assert.equal(p.materials.top.from, 'library:pack/meadow-top');
  assert.equal(p.materials.cliff.from, 'library:pack/rock-soil');
  assert.equal(p.sea.size, 1800);
  assert.deepEqual(p.scenery.props, ['tree-pine-cute', 'flag']);
  assert.ok(p.scenery.clouds > 0 && p.scenery.islands > 0 && p.scenery.cloudStyle === 'puff');
  assert.equal(worldPlan({ ...T, world: { ...T.world, setting: 'coast', land: 'cliffs' } }, PLACE).params.shape, 'cliffs');
  // a sea horizon keeps its haze light: the fog reaches further than the look's own
  assert.ok(worldLookValues({ ...ISLANDS, lighting: { fog: { density: 0.15 } } }).fog.far > 300);
  assert.equal(worldLookValues(CAVE).fog, undefined);
});

test('scenery props stand on firm ground above the sea, clear of the seats, the same every time', async () => {
  const { placeProps } = await importLayer(join(KIT_ROOT, 'worlds/scenery.js'));
  // a round island 20 m across, 3 m high, a steep edge
  const groundAt = (x, z) => { const d = Math.hypot(x, z); return d < 10 ? 3 : d < 11 ? 3 - (d - 10) * 6 : null; };
  const opts = { groundAt, seaLevel: 0, bounds: [-15, -15, 15, 15], seats: [{ x: 0, z: 0 }], seed: 4 };
  const a = placeProps({ props: ['tree-pine-cute', 'rock-large'], density: 0.6 }, opts);
  assert.deepEqual(a, placeProps({ props: ['tree-pine-cute', 'rock-large'], density: 0.6 }, opts));
  assert.ok(a.length >= 3);
  for (const p of a) {
    assert.ok(Math.hypot(p.at[0], p.at[2]) < 10, 'on the firm top, not the edge');
    assert.ok(Math.hypot(p.at[0], p.at[2]) > 2.2, 'clear of the seat');
  }
  assert.deepEqual(placeProps({ props: [] }, opts), []);
});

test('terrain seats stand on level pads when the target asks; a world without pads is the ground it always was', async () => {
  const { generateTerrain } = await import('../worlds/terrain/generate.mjs');
  const P = { seed: 197669776, shape: 'islands', land: { height: 11, hills: 4, cliff: 0.7 }, islands: { count: 3 } };
  const plain = generateTerrain(P), again = generateTerrain({ ...P, pads: { count: 0 } });
  assert.deepEqual(plain.info.pads, []);
  assert.ok(plain.field.d.every((v, i) => v === again.field.d[i]), 'no pads: the same field');
  const g = generateTerrain({ ...P, pads: { count: 8 } }), f = g.field;
  assert.equal(g.info.pads.length, 8);
  for (const p of g.info.pads) for (let a = 0; a < 12; a++) for (const r of [1.5, 2.8]) {
    const y = f.heightAt(p.x + Math.cos(a * 0.52) * r, p.z + Math.sin(a * 0.52) * r);
    assert.ok(Math.abs(y - p.y) < 0.15, `level within ${r} m of a seat (${(y - p.y).toFixed(2)})`);
  }
  assert.equal(terrainParamsOf(ISLANDS).pads.count, 8);
});

test('the camera never rolls: whatever the ground under the player, its horizon stays level', async () => {
  const THREE = await import('three');
  const { createCameraRig } = await importLayer(join(KIT_ROOT, 'runtimes/three/kit/controller/camera-rig.js'));
  for (const mode of ['third', 'orbit', 'follow', 'top']) {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    const rig = createCameraRig({ camera, mode, settings: { pitchDeg: 12 } });
    for (let k = 0; k < 60; k++) rig.update(1 / 60, { x: k * 0.3, y: Math.sin(k * 0.2) * 3 + k * 0.4, z: k * 0.1 });
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    assert.ok(Math.abs(right.y) < 1e-6, `${mode}: the camera's right is level (${right.y})`);
  }
});

test('a target with looks gives each its own values; a game starts in one and the runtime lays a level over its look', async () => {
  const { targetOfLook, levelValues } = await import('../builder/look/looks.mjs');
  const T = { ...ISLANDS, looks: [
    { id: 'day-isles', name: 'day isles', frames: ['a'.repeat(64)], share: 0.6, lighting: { sky: ['#7eaee2'] } },
    { id: 'dusk-fort', name: 'dusk fort', frames: ['b'.repeat(64)], share: 0.4, lighting: { sky: ['#6952bd'], time: 'dusk' }, world: { setting: 'ruins' } },
  ] };
  const dusk = targetOfLook(T, 'dusk-fort');
  assert.equal(dusk.lighting.sky[0], '#6952bd'); assert.equal(dusk.world.setting, 'ruins'); assert.equal(dusk.world.horizon, 'sea');
  assert.equal(dusk.level.id, 'dusk-fort'); assert.equal(dusk.looks, undefined);
  assert.deepEqual(validate(SCHEMA.lookTarget, dusk), []);
  assert.deepEqual(validate(SCHEMA.lookTarget, T), []);
  const lv = levelValues(T, t => ({ sky: { top: t.lighting.sky[0] } }));
  assert.equal(lv.level, 'day-isles');
  assert.equal(lv.levels['dusk-fort'].sky.top, '#6952bd');
  assert.equal(levelValues(ISLANDS, () => ({})), null);
  // the runtime: a level over the look and its time blocks; an unknown level is none
  const { levelPreset } = await importLayer(join(KIT_ROOT, 'runtimes/three/kit/look/look.js'));
  const base = { sky: { top: '#111111', horizon: '#222222' }, times: { day: { sky: { top: '#333333' } } }, levels: lv.levels };
  const p = levelPreset(base, 'dusk-fort');
  assert.equal(p.sky.top, '#6952bd'); assert.equal(p.sky.horizon, '#222222'); assert.equal(p.times.day.sky.top, '#6952bd');
  assert.equal(levelPreset(base, 'nope'), null);
});

test('set dressing that does not fit the look is not placed: it goes to the art ladder; big pieces stand back from the seats', async () => {
  const props = [{ id: 'tower', tags: ['building'], fit: 0.52 }, { id: 'tree-pine', tags: ['tree'], fit: 0.8 }, { id: 'tree-oak', tags: ['tree'], fit: 0.58 }];
  const d = await dressingOf(['onion-dome towers', 'palm trees'], { props });
  assert.deepEqual(d.ids, ['tree-pine'], 'the better-fitting tree, never the off-style tower');
  assert.deepEqual(d.offStyle.map(o => o.id), ['tower']);
  const { placeProps } = await importLayer(join(KIT_ROOT, 'worlds/scenery.js'));
  const groundAt = (x, z) => (Math.hypot(x, z) < 40 ? 2 : null);
  const out = placeProps({ props: ['tower', 'crate'], density: 1 }, { groundAt, bounds: [-30, -30, 30, 30], seats: [{ x: 0, z: 0 }], seed: 2, sizeOf: id => (id === 'tower' ? [6, 14, 7] : [0.9, 0.9, 0.9]) });
  for (const p of out.filter(p => p.prop === 'tower')) assert.ok(Math.hypot(p.at[0], p.at[2]) >= 10, 'a tower stands 10 m or more from a seat');
  assert.ok(out.some(p => p.prop === 'crate' && Math.hypot(p.at[0], p.at[2]) < 10));
});

test('target cameras name their kind of place, and the sea-islands and terrain worlds answer with one', async () => {
  const { wherePlaces } = await import('../builder/look/looks.mjs');
  const fr = wherePlaces([{ name: 'play', frame: 'gameplay', pitch: 10, distance: 8, fov: 60 }, { name: 'wide', frame: 'scene', pitch: 25, distance: 30, fov: 60 }, { name: 'map', frame: 'terrain', pitch: 65, distance: 60, fov: 55 }, { name: 'own', frame: 'scene', where: 'cliff-edge', pitch: 20, distance: 10, fov: 60 }], { horizon: 'sea' });
  assert.deepEqual(fr.map(f => f.where ?? null), ['seat', 'sea-view', null, 'cliff-edge']);
  assert.deepEqual(validate(SCHEMA.lookTarget, { ...ISLANDS, camera: { ...ISLANDS.camera, framings: fr } }), []);
  const { placeFor: seaPlace } = await import('../worlds/sea-places.mjs');
  const layout = generateLayout(RECIPE, { size: 'medium', seed: 5 });
  for (const w of ['seat', 'day', 'cliff-edge', 'beach', 'sea-view']) {
    const p = seaPlace(layout, w);
    assert.ok(p && p.eye.length === 3 && p.target.length === 3, `sea-islands: a ${w} place`);
    if (w !== 'beach') assert.ok(p.eye[1] > (heightAt(layout, p.eye[0], p.eye[2]) ?? -99), `${w}: the eye is above the ground`);
  }
  assert.equal(seaPlace(layout, 'cave'), null, 'no cave in an island world: the caller frames the player');
  const { generateTerrain, seatSpawns } = await import('../worlds/terrain/generate.mjs');
  const { placeFor } = await import('../worlds/terrain/places.mjs');
  const g = generateTerrain({ seed: 197669776, shape: 'islands', land: { height: 11, hills: 4 }, islands: { count: 3 }, pads: { count: 8 } });
  const spawns = seatSpawns(g.field, g.info.pads, { count: 8 });
  for (const w of ['seat', 'day', 'cliff-edge', 'sea-view']) assert.ok(placeFor({ field: g.field, spawns }, w), `terrain: a ${w} place`);
  // a seat place stands on the flattest seat, at eye height
  const seat = placeFor({ field: g.field, spawns }, 'seat');
  assert.ok(Math.abs(seat.eye[1] - 1.6 - g.field.heightAt(seat.eye[0], seat.eye[2])) < 0.2);
});

test('each look takes the ground its frames name: lit grass, else sand, else the whole set\'s', async () => {
  const { groundFor } = await import('../builder/look/pitch.mjs');
  const art = { grounds: [
    { id: 'meadow-top', hues: ['#5aa53a'] }, { id: 'grass-top', hues: ['#6be26b'] }, { id: 'sand-top', hues: ['#e2b06a'] }, { id: 'rock-top', hues: ['#6f8a9e'] },
  ] };
  const look = colors => ({ level: { id: 'x', frames: ['a'.repeat(64)] }, palette: { colors }, regions: { ground: { colors: [{ hex: '#6f8a9e', share: 1 }] } } });
  assert.equal(groundFor(art, look([{ hex: '#67775d', share: 0.3, role: 'shaded grass' }, { hex: '#6be26b', share: 0.1, role: 'grass' }])).id, 'grass-top');
  assert.equal(groundFor(art, look([{ hex: '#ca8c52', share: 0.2, role: 'sand / sandstone' }])).id, 'sand-top');
  assert.equal(groundFor(art, look([{ hex: '#496185', share: 0.2, role: 'castle stone' }])).id, 'meadow-top', 'naming neither: the whole set\'s ground, never the sea-tinted band');
  assert.equal(groundFor(art, ISLANDS).id, 'meadow-top');
});

test('set pieces are landmarks: a few of each, on a level footprint over land, never as many as the small props', async () => {
  const { placeProps } = await importLayer(join(KIT_ROOT, 'worlds/scenery.js'));
  // a wide island 50 m across, flat on its west half and stepped on its east half
  const groundAt = (x, z) => (Math.hypot(x, z) > 25 ? null : x < 0 ? 3 : 3 + Math.floor(x / 2) * 1.5);
  const sizes = { castle: [6, 8, 5], mesa: [8, 9, 8], crate: [0.9, 0.9, 0.9], 'tree-palm': [2, 5, 2] };
  const out = placeProps({ props: ['castle', 'mesa', 'crate', 'tree-palm'], density: 1 }, { groundAt, bounds: [-25, -25, 25, 25], seats: [{ x: -15, z: 0 }], seed: 3, sizeOf: id => sizes[id] });
  const n = id => out.filter(p => p.prop === id).length;
  assert.ok(n('crate') > n('castle') && n('crate') > n('mesa'), `crates ${n('crate')}, castles ${n('castle')}, mesas ${n('mesa')}`);
  assert.ok(n('castle') >= 1 && n('castle') <= 2);
  for (const p of out.filter(p => ['castle', 'mesa'].includes(p.prop))) assert.ok(p.at[0] < 0 + sizes[p.prop][0] * 0.55, `${p.prop} at x ${p.at[0]} stands on the level half`);
  assert.deepEqual(out, placeProps({ props: ['castle', 'mesa', 'crate', 'tree-palm'], density: 1 }, { groundAt, bounds: [-25, -25, 25, 25], seats: [{ x: -15, z: 0 }], seed: 3, sizeOf: id => sizes[id] }));
});

test('set dressing: a look\'s own pack is searched first, and its pieces (judged against the look\'s anchor) are not held to the scene floor', async () => {
  const props = [{ id: 'tree-palm', tags: ['tree'], fit: 0.7 }, { id: 'curly-palm-tree', tags: ['palm'], fit: 0.5, own: true }, { id: 'tower-b', tags: ['tower'], fit: 0.44 }];
  const d = await dressingOf(['curly palm tree', 'onion-dome tower'], { props });
  assert.deepEqual(d.ids, ['curly-palm-tree']);
  assert.deepEqual(d.offStyle.map(o => o.id), ['tower-b']);
});

test('landmark sites: the terrain levels them away from the seats, and the scenery stands the look\'s set pieces there', async () => {
  const { generateTerrain } = await import('../worlds/terrain/generate.mjs');
  const P = { seed: 197669776, shape: 'islands', land: { height: 11, hills: 4, cliff: 0.7 }, islands: { count: 3 }, pads: { count: 8 }, sites: { count: 3 } };
  const g = generateTerrain(P);
  assert.ok(g.info.sites.length >= 2, `${g.info.sites.length} sites`);
  for (const s of g.info.sites) {
    assert.ok(g.info.pads.every(p => Math.hypot(p.x - s.x, p.z - s.z) >= 10), 'a site stands back from every seat pad');
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) assert.ok(Math.abs(g.field.heightAt(s.x + dx, s.z + dz) - s.y) < 0.6, 'a site is level');
  }
  // a world without sites is the ground it always was
  const plain = generateTerrain({ ...P, sites: { count: 0 } });
  assert.deepEqual(plain.info.sites, []);
  assert.deepEqual(plain.info.pads, g.info.pads);
  const { placeProps } = await importLayer(join(KIT_ROOT, 'worlds/scenery.js'));
  const sizes = { castle: [6, 8, 5], crate: [0.9, 0.9, 0.9], 'palm-tree': [3.6, 5, 3.6] };
  const out = placeProps({ props: ['castle', 'crate', 'palm-tree'], density: 0.6 }, { groundAt: (x, z) => g.field.heightAt(x, z), bounds: [-50, -35, 50, 35], seats: g.info.pads, sites: g.info.sites, seed: 5, sizeOf: id => sizes[id] });
  const castles = out.filter(p => p.prop === 'castle');
  assert.equal(castles.length, g.info.sites.length, 'one landmark a site, none elsewhere');
  for (const c of castles) assert.ok(g.info.sites.some(s => Math.hypot(s.x - c.at[0], s.z - c.at[2]) < 0.01));
  assert.ok(out.some(p => p.prop === 'palm-tree'), 'a tree is never a landmark');
});
