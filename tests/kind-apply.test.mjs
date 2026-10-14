// Applying a kind in create (kinds/apply.mjs, the one seam in builder/tools/create.mjs): the kind's look values win over
// the preset's time block, its world values and camera numbers reach the config, sound trims never touch a sound the
// spec described, the HUD and the packs are written, and the spec's own look always wins over the kind's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKind, readKind, over } from '../kinds/apply.mjs';

const lofi = readKind('lofi');
const config = () => ({
  look: { preset: 'toon-lowpoly', time: 'night', renderer: { exposure: 1 }, times: { night: { renderer: { exposure: 1.1 }, fog: { far: 140 } } } },
  world: { template: 'office', ceiling: { height: 3.9, color: '#f6f3ee', glow: 0.4 } },
  game: { camera: 'first', controller: { camera: { first: { fov: 72, sensitivity: 0.0024 } } } },
  sounds: { version: 1, sounds: { jump: { label: 'Jump', src: { preset: 'jump' } }, hit: { label: 'Hit', src: { preset: 'hit-soft' } } } },
  assets: [], notes: [],
});
const spec = (extra = {}) => ({ kind: 'lofi', camera: 'first', world: { template: 'office' }, sounds: [{ id: 'hit', describe: 'a wet slap' }], ...extra });
const place = { runtime: 'three', profile: 'standard-3d' };

test('the kind\'s look values reach config/look.json and win over the time of day', async () => {
  const C = config();
  const { notes } = await applyKind(C, spec(), { place });
  assert.equal(C.look.renderer.exposure, lofi.look.three.values.renderer.exposure);
  assert.equal(C.look.times.night.renderer.exposure, lofi.look.three.values.renderer.exposure, 'the night block no longer shadows the kind');
  assert.equal(C.look.times.night.fog.far, lofi.look.three.values.fog.far);
  assert.ok(C.look.post.lofi, 'the lofi pass is on');
  assert.match(notes[0], /^kind lofi: look values/);
});

test('world values, camera numbers, sound trims, the HUD and the packs', async () => {
  const C = config();
  await applyKind(C, spec(), { place });
  assert.equal(C.world.ceiling.color, lofi.world.three.values.ceiling.color);
  assert.equal(C.world.ceiling.height, 3.9, 'the template\'s own values stay');
  assert.equal(C.game.controller.camera.first.fov, lofi.camera.three.fov);
  assert.equal(C.game.controller.camera.first.sensitivity, 0.0024);
  assert.equal(C.sounds.sounds.jump.pitch, lofi.audio.sounds.jump.pitch);
  assert.equal(C.sounds.sounds.hit.pitch, undefined, 'a sound the spec described is the spec\'s');
  assert.equal(C.game.ui.accent, lofi.hud.accent);
  assert.equal(C.game.ui.style.font, lofi.hud.font);
  assert.deepEqual(C.game.art.packs, lofi.packs);
});

test('the spec\'s own look wins; a camera rig the kind does not default to keeps its numbers', async () => {
  const C = config();
  await applyKind(C, spec({ look: { preset: 'jelly-pastel' }, camera: 'third' }), { place });
  assert.equal(C.look.renderer.exposure, 1);
  assert.equal(C.game.controller.camera.first.fov, 72);
});

test('no kind, or a kind with no preset, changes nothing', async () => {
  const C = config(), before = structuredClone(C);
  assert.deepEqual((await applyKind(C, { camera: 'first' }, { place })).notes, []);
  assert.match((await applyKind(C, { kind: 'nope' }, { place })).notes[0], /no preset/);
  assert.deepEqual(C, before);
});

test('over() merges objects deep and replaces the rest', () => {
  assert.deepEqual(over({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, e: 2 }), { a: { b: 1, c: [2] }, d: 1, e: 2 });
});

test('a kind\'s world preset (blocky\'s land) goes over the voxel world when the game\'s world is the kind\'s', async () => {
  const C = { world: { template: 'voxel', voxel: { size: [192, 96, 192], terrain: { kind: 'island', seed: 3 }, textures: { dirt: 'library:xk-voxel-blocks/dirt' } } }, game: { controller: { camera: {} } }, sounds: { sounds: {} }, assets: [], notes: [] };
  await applyKind(C, { kind: 'blocky', camera: 'third', world: { template: 'voxel' } }, { place: { runtime: 'three', profile: 'standard-3d' } });
  assert.equal(C.world.voxel.terrain.kind, 'land');
  assert.equal(C.world.voxel.terrain.seed, 3, 'the game\'s own seed stays (the preset names none)');
  assert.deepEqual(C.world.voxel.size, [192, 96, 192], 'the preset leaves the size (and so the protected spawn square) alone');
  assert.equal(C.world.voxel.textures.dirt, 'library:xk-voxel-blocks/dirt', 'what the preset leaves stays');
  assert.equal(C.world.voxel.faces.filter, 'pixel');
});
