// runtime godot: the parts that run without a browser or Godot (runtimes/godot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createBridge, fnv } from '../runtimes/godot/kit/bridge.js';
import { worldFor } from '../runtimes/godot/kit/world.js';
import { checkSpec, closure, flatStyleOf, mapOf, sourceOf, DEFAULT_SIDE_MAP } from '../runtimes/godot/tools/create.mjs';
import { logErrors } from '../runtimes/godot/tools/export.mjs';
import { extract, platformKey } from '../runtimes/godot/tools/install.mjs';
import { RUNTIME, SHARED, TOOLCHAIN } from '../runtimes/godot/tools/lib.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

test('bridge: a pull is empty until the kit has something, then carries the latest fields and the queued messages once', () => {
  const win = {};
  const b = createBridge({ read: async () => ({ path: 'x', buf: new ArrayBuffer(0) }), win });
  assert.equal(win.gfGodot, b.api);
  assert.equal(b.api.pull(), '');
  b.set('phase', 'countdown'); b.set('phase', 'playing'); b.send({ k: 'place', x: 1, y: 0 });
  const m = JSON.parse(b.api.pull());
  assert.equal(m.phase, 'playing');
  assert.deepEqual(m.msgs, [{ k: 'place', x: 1, y: 0 }]);
  assert.equal(b.api.pull(), '');
});

test('bridge: a push is the game\'s latest frame; its events are kept until taken', () => {
  const b = createBridge({ read: async () => ({}), win: {} });
  b.api.push(JSON.stringify({ me: { x: 1, y: 2 }, events: [{ n: 'coin', d: { i: 3 } }] }));
  b.api.push(JSON.stringify({ me: { x: 1.5, y: 2 } }));
  assert.equal(b.frames, 2);
  assert.deepEqual(b.latest.me, { x: 1.5, y: 2 });
  assert.deepEqual(b.takeEvents(), [{ n: 'coin', d: { i: 3 } }]);
  assert.deepEqual(b.takeEvents(), []);
  b.api.push('not json');
  assert.equal(b.frames, 2);
});

test('bridge: a file request is read through the kit, answered by a message, then taken once as bytes', async () => {
  const b = createBridge({ read: async id => ({ path: `assets/${id}.png`, buf: new Uint8Array([1, 2, 3]).buffer }), win: {} });
  b.api.file(7, 'body');
  await tick(); await tick();
  const m = JSON.parse(b.api.pull());
  assert.deepEqual(m.msgs, [{ k: 'file', req: 7, ok: true }]);
  assert.deepEqual([...b.api.take(7)], [1, 2, 3]);
  assert.equal(b.api.take(7).length, 0);
  assert.deepEqual(b.handed(), [{ id: 'body', path: 'assets/body.png', bytes: 3, hash: fnv(new Uint8Array([1, 2, 3])) }]);
  const bad = createBridge({ read: async () => { throw new Error('404'); }, win: {} });
  bad.api.file(1, 'nope');
  await tick(); await tick();
  assert.deepEqual(JSON.parse(bad.api.pull()).msgs, [{ k: 'file', req: 1, ok: false }]);
});

test('bridge: sounds go to the kit with their options', () => {
  const heard = [];
  const b = createBridge({ read: async () => ({}), onSound: (id, o) => heard.push([id, o]), win: {} });
  b.api.sound('coin', '{"volume":0.5}'); b.api.sound('jump', '');
  assert.deepEqual(heard, [['coin', { volume: 0.5 }], ['jump', {}]]);
});

test('fnv-1a of nothing and of "a"', () => {
  assert.equal(fnv(new Uint8Array(0)), '811c9dc5');
  assert.equal(fnv(new TextEncoder().encode('a')), 'e40c292c');
});

test('the map: the default stage reads, unused kinds go, spawns stand on the ground and marks are cell centres', async () => {
  const { map, M } = await mapOf({});
  assert.ok(M.ok, M.problems.join('; '));
  assert.deepEqual(Object.keys(map.kinds).sort(), ['brick', 'ground', 'ledge']);
  const W = worldFor(M);
  assert.equal(W.spawns.length, 4);
  for (const s of W.spawns) assert.equal(s.y, 0, 'a spawn on the bottom floor stands at y = 0 (the top of the ground row)');
  assert.equal(W.cols, DEFAULT_SIDE_MAP.rows[0].length);
  const coins = await mapOf({ world: { map: { legend: { o: 'mark:coin' }, rows: ['B......B', 'B......B', 'B......B', 'B..o...B', 'B.1..1.B', '########'] } } });
  assert.ok(coins.M.ok, coins.M.problems.join('; '));
  const c = worldFor(coins.M).marks.coin[0];
  assert.deepEqual(c, { x: -0.5, y: 1.5 });
  const high = await mapOf({ world: { map: { legend: { o: 'mark:coin' }, rows: ['B......B', 'B..o...B', 'B......B', 'B......B', 'B.1..1.B', '########'] } } });
  assert.match(high.M.problems.join(';'), /mark "coin".*more than a jump/, 'a coin no jump reaches is refused');
  assert.equal(coins.map.kinds.ledge, undefined);
});

test('a spec is refused in words only when it cannot boot here', () => {
  const ok = { specVersion: 2, runtime: 'godot', profile: '2d', camera: 'side', title: 'A', multiplayer: { mode: 'live' }, world: { template: 'stage' } };
  assert.deepEqual(checkSpec(ok), []);
  assert.deepEqual(checkSpec({ ...ok, loop: 'turns' }), [], 'a loop godot lacks is built on the closest one, never refused');
  assert.match(checkSpec({ ...ok, specVersion: 1 })[0], /spec v2 only/);
  assert.match(checkSpec({ ...ok, runtime: 'three' })[0], /runtime is "three"/);
  assert.match(checkSpec({ ...ok, profile: '3d' })[0], /profile "3d"/);
  assert.match(checkSpec({ ...ok, camera: 'top' })[0], /camera "top"/);
  assert.match(checkSpec({ ...ok, multiplayer: { mode: 'room' } })[0], /room is not wired/);
  assert.match(checkSpec({ ...ok, title: undefined })[0], /title/);
});

test('the page side\'s closure: every file it reaches has a source, and nothing three.js comes with it', async () => {
  const files = await closure();
  assert.ok(files.includes('gf/godot/boot.js') && files.includes('gf/three/net/session.js') && files.includes('gf/mp/net.js'));
  for (const f of files) assert.ok(existsSync(sourceOf(f)), `${f} → ${sourceOf(f)}`);
  assert.ok(!files.some(f => f.startsWith('vendor/') || /three\.module|rapier/.test(f)), 'no three.js or Rapier in a Godot game');
  assert.equal(sourceOf('gf/godot/boot.js'), join(RUNTIME, 'kit', 'boot.js'));
  assert.equal(sourceOf('gf/gf-assets.js'), SHARED.assets);
  assert.equal(sourceOf('elsewhere.js'), null);
});

test('export: the log\'s script errors, once each with a count; editor noise left out', () => {
  const log = ['SCRIPT ERROR: Invalid call.', '          at: _physics_process (res://main.gd:91)', 'SCRIPT ERROR: Invalid call.', '          at: _physics_process (res://main.gd:91)', 'ERROR: Condition "!FileAccess::exists(p)" is true.', 'all fine'].join('\n');
  assert.deepEqual(logErrors(log), ['SCRIPT ERROR: Invalid call. at: _physics_process (res://main.gd:91) (2 times)']);
  assert.deepEqual(logErrors('ERROR: Parameter "material" is null.\n   at: material_get_instance_shader_parameters (servers/rendering/dummy/storage/material_storage.cpp:265)'), [], 'the headless dummy renderer\'s noise is not the game\'s');
});

test('install: an entry comes out of a zip, stored or deflated', () => {
  const zip = (name, data, method) => {
    const body = method === 8 ? deflateRawSync(data) : data, n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
    const head = Buffer.concat([local, n, body]), dir = Buffer.concat([cd, n]);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(head.length, 16);
    return Buffer.concat([head, dir, end]);
  };
  const data = Buffer.from('godot '.repeat(50));
  assert.deepEqual(extract(zip('templates/web_nothreads_release.zip', data, 8), 'templates/web_nothreads_release.zip'), data);
  assert.deepEqual(extract(zip('Godot_v4.6-stable_linux.x86_64', data, 0), 'Godot_v4.6-stable_linux.x86_64'), data);
  assert.throws(() => extract(zip('a', data, 0), 'b'), /not in the archive/);
});

test('the toolchain record pins what install and export use', () => {
  assert.equal(TOOLCHAIN.version, '4.6.stable');
  assert.match(TOOLCHAIN.template.fileSha256, /^[0-9a-f]{64}$/);
  assert.match(TOOLCHAIN.platforms['linux-x64'].editor.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(platformKey('linux', 'x64'), 'linux-x64');
  assert.equal(platformKey('darwin', 'arm64'), 'macos-arm64');
});

test('the addon: the autoload and its three parts are in the template project', async () => {
  for (const f of ['gf.gd', 'gf_flat_body.gd', 'gf_tilemap_2d.gd', 'gf_friends_2d.gd']) assert.ok(existsSync(join(RUNTIME, 'addon', f)), f);
  const { readFile } = await import('node:fs/promises');
  const godot = await readFile(join(RUNTIME, 'templates', '2d-side', 'project.godot'), 'utf8');
  assert.match(godot, /GF="\*res:\/\/addons\/gf\/gf\.gd"/);
  assert.match(godot, /renderer\/rendering_method="gl_compatibility"/);
  assert.match(godot, /driver\/driver="Dummy"/);
  const preset = await readFile(join(RUNTIME, 'toolchain', 'export_presets.cfg'), 'utf8');
  assert.match(preset, /variant\/thread_support=false/);
  void pathToFileURL;
});

test('the create adapter (runtimes/CONTRACT.md §2): a spec object → {files, slots, record}', async () => {
  const { default: create } = await import('../runtimes/godot/create.mjs');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const out = await mkdtemp(join(tmpdir(), 'godot-create-'));
  try {
    const spec = JSON.parse(await readFile(new URL('../examples/minimal/godot-ledge-friends/spec.json', import.meta.url), 'utf8'));
    const r = await create({ spec, out: join(out, 'g'), exportNow: false });
    assert.equal(r.record.runtime.id, 'godot');
    assert.ok(r.slots.some(s => s.id === 'character.body.player') && r.slots.some(s => s.id === 'world.map'));
    assert.ok(r.files['gf/godot/boot.js'] && r.files['project/addons/gf/gf.gd'] && r.files['gf/godot/GODOT-LICENSE.txt']);
    await assert.rejects(create({ spec: { ...spec, camera: 'top' }, out: join(out, 'h'), exportNow: false }), /camera "top"/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('evidence names no hardware: a graphics card\'s model in a renderer string becomes its maker\'s "GPU"', async () => {
  const { scrubText } = await import('../runtimes/godot/tools/verify.mjs');
  const card = ['GeForce', 'RTX', '4080'].join(' ');
  assert.equal(scrubText(`"ANGLE (NVIDIA Corporation, NVIDIA ${card}/PCIe/SSE2, OpenGL ES 3.2)"`), '"ANGLE (NVIDIA Corporation, NVIDIA GPU/PCIe/SSE2, OpenGL ES 3.2)"');
  assert.equal(scrubText('webgl2, headless Chrome 148'), 'webgl2, headless Chrome 148');
});

test('the CLI seam: a godot spec and a godot game are told apart from every other; gates name the browser legs they need', async () => {
  const { isGodotSpec, isGodotGame, legsFor } = await import('../runtimes/godot/gamesfun.mjs');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const d = await mkdtemp(join(tmpdir(), 'godot-seam-'));
  try {
    await writeFile(join(d, 'a.json'), JSON.stringify({ specVersion: 2, runtime: 'godot' }));
    await writeFile(join(d, 'b.json'), JSON.stringify({ specVersion: 2, runtime: 'three' }));
    assert.equal(await isGodotSpec(join(d, 'a.json')), true);
    assert.equal(await isGodotSpec(join(d, 'b.json')), false);
    assert.equal(isGodotGame(d), false);
    await writeFile(join(d, 'xgames.json'), JSON.stringify({ runtime: { id: 'godot' } }));
    assert.equal(isGodotGame(d), true);
    assert.deepEqual(legsFor('E'), ['live', 'watch']);
    assert.ok(legsFor(null).includes('boot'));
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('the HUD\'s help line and the menu\'s controls on a side camera: no "mouse aim" unless the game aims; the game\'s own words win', async () => {
  const { importLayer } = await import('../builder/tools/lib/kit-import.mjs');
  const { helpLine } = await importLayer(join(RUNTIME, '..', '..', 'builder', 'ui', 'ui.js'));
  const { controlRows } = await importLayer(join(RUNTIME, '..', '..', 'builder', 'ui', 'menu.js'));
  assert.equal(helpLine({ jump: 'jump' }, 'side'), 'A/D move · Space: jump · Esc: menu');
  assert.equal(helpLine({ primary: 'throw' }, 'side'), 'A/D move · mouse aim · click / F: throw · Esc: menu');
  assert.equal(helpLine({ move: 'arrows or WASD move', aim: '' }, 'top'), 'arrows or WASD move · Esc: menu');
  assert.equal(helpLine({}, 'third'), 'WASD move · mouse look · Esc: menu');
  assert.equal(helpLine({}, 'top'), 'WASD move · Esc: menu');
  const rows = controlRows({ jump: 'jump' }, { camera: 'side' }).map(r => r[0]);
  assert.ok(!rows.includes('Mouse') && !rows.includes('Shift') && rows.includes('A D'), rows.join(', '));
  assert.ok(controlRows({ primary: 'throw' }, { camera: 'side' }).some(r => r[0] === 'Mouse'));
});

test('the top-down starter: camera "top" makes a field seen from above, its map walkable from the first spawn, y north', async () => {
  const spec = { specVersion: 2, runtime: 'godot', profile: '2d', camera: 'top', title: 'Field', multiplayer: { mode: 'live' }, world: { template: 'field' } };
  assert.deepEqual(checkSpec(spec), []);
  assert.match(checkSpec({ ...spec, world: { template: 'stage' } })[0], /world "stage"/);
  const a = await mapOf(spec), b = await mapOf(spec);
  assert.ok(a.M.ok, a.M.problems.join('; '));
  assert.equal(a.map.plane, 'top');
  assert.equal(a.map.base, 'grass');
  assert.deepEqual(a.map.rows, b.map.rows, 'one spec, one map');
  const W = worldFor(a.M);
  const s = a.M.spawns[0], z = a.M.centre(s.c, s.r).z;
  assert.equal(W.spawns[0].y, -z, 'seen from above, y is north (the map\'s -z)');
  const { walkReach } = await import('../runtimes/godot/kit/world.js');
  const walled = await mapOf({ ...spec, world: { template: 'field', map: { rows: ['########', '#1.#...#', '#..#.o.#', '#..#...#', '#..#..1#', '########'], legend: { o: 'mark:gem' } } } });
  assert.ok(!walled.M.ok);
  assert.match(walled.M.problems.join(';'), /walled off|cannot be walked to/);
  void walkReach;
});

test('the 3D profile: camera "follow" (or profile 3d alone) is the arena starter; its retarget holds rig.js\'s swing map', async () => {
  const { starterOf, STARTERS } = await import('../runtimes/godot/tools/create.mjs');
  const spec = { specVersion: 2, runtime: 'godot', profile: '3d', title: 'Arena', multiplayer: { mode: 'live' } };
  assert.equal(starterOf(spec), STARTERS.follow);
  assert.deepEqual(checkSpec({ ...spec, camera: 'follow', world: { template: 'arena' } }), []);
  assert.match(checkSpec({ ...spec, camera: 'side' })[0], /profile "3d"/);
  assert.match(checkSpec({ ...spec, camera: 'first' })[0], /camera "first"/);
  const { readFile } = await import('node:fs/promises');
  const gd = await readFile(join(RUNTIME, 'addon', 'gf_rig_3d.gd'), 'utf8');
  const { importLayer } = await import('../builder/tools/lib/kit-import.mjs');
  const rig = await importLayer(join(RUNTIME, '..', 'three', 'kit', 'character', 'rig.js'));
  for (const [bone, child] of Object.entries(rig.SWING)) assert.ok(gd.includes(`"${bone}": "${child}"`), `gf_rig_3d.gd SWING carries ${bone} → ${child}`);
  for (const n of rig.REQUIRED) assert.ok(gd.includes(`"${n}"`), `gf_rig_3d.gd REQUIRED carries ${n}`);
});

test('a 3D arena with no map of its own starts its seats together in the middle, each on a cell a body can stand on', async () => {
  const { gatherSpawns } = await import('../runtimes/godot/tools/create.mjs');
  const { M } = await mapOf({ specVersion: 2, runtime: 'godot', profile: '3d', camera: 'follow', title: 'Arena Friends', players: { max: 4 } });
  assert.ok(M.ok, M.problems.join('; '));
  assert.equal(M.spawns.length, 4);
  for (const a of M.spawns) for (const b of M.spawns) assert.ok(Math.hypot(a.c - b.c, a.r - b.r) <= 7, 'every seat within a few metres of every other');
  const rows = gatherSpawns(['########', '#1....1#', '#......#', '#..##..#', '#......#', '#1....1#', '#......#', '########'], { '.': null, '#': 'wall', 1: 'spawn' }, { wall: { solid: true } }, 2);
  assert.equal(rows.join('').split('1').length - 1, 2);
});

test('phone: only the actions a game has get a touch button, and the layout measure finds boxes off the screen or over each other', async () => {
  const { touchActions, buttonSpots } = await import('../runtimes/godot/kit/touch.js');
  const { phoneFit, boxesOverlap } = await import('../runtimes/godot/tools/measure.mjs');
  assert.deepEqual(touchActions({}), [], 'a walker seen from above: the stick alone');
  assert.deepEqual(touchActions({ jump: 'jump' }), ['jump']);
  assert.deepEqual(touchActions({ jump: 'jump', primary: 'throw', interact: '', secondary: 'block' }), ['jump', 'primary'], 'an empty word is no action; GF\'s pad has no secondary');
  assert.deepEqual(Object.keys(buttonSpots(['jump', 'primary'])), ['jump', 'primary']);
  assert.match(buttonSpots(['jump'])['jump'], /right:22px;bottom:22px/);
  assert.equal(boxesOverlap([0, 0, 10, 10], [10, 0, 20, 10]), false, 'touching is not overlapping');
  assert.equal(boxesOverlap([0, 0, 10, 10], [5, 5, 20, 20]), true);
  const fit = phoneFit([{ name: 'goal', r: [80, 50, 320, 73] }, { name: 'scores', r: [300, 8, 382, 92] }, { name: 'stick', r: [24, 700, 144, 820] }, { name: 'Jump', r: [302, 756, 368, 900] }], 390, 844);
  assert.deepEqual(fit.overlaps, [['goal', 'scores']]);
  assert.deepEqual(fit.off, ['Jump']);
});

test('seen from above the field is three\'s draw plan, packed for the bridge; a picture\'s size comes from its PNG header', async () => {
  const { planFor, pngSize } = await import('../runtimes/godot/kit/world.js');
  const { readMap, KINDS, LEGENDS } = await import('../runtimes/three/profiles/flat-2d/tilemap.js');
  const { drawPlan } = await import('../runtimes/three/profiles/flat-2d/drawplan.js');
  const head = new Uint8Array(24); head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); head.set([0, 0, 0, 64], 16); head.set([0, 0, 0, 48], 20);
  assert.deepEqual(pngSize(head), [64, 48]);
  assert.equal(pngSize(new Uint8Array([1, 2, 3])), null);
  const map = { format: 'gf-tilemap-1', plane: 'top', tile: 1, base: 'grass', kinds: { ...KINDS.top, house: { solid: true, piece: [3, 2] } }, legend: { ...LEGENDS.top, H: 'house' },
    rows: ['##############', '#..HHH.......#', '#..HHH.......#', '#.,,,,,......#', '#.1..1.......#', '#............#', '#............#', '#............#', '##############'] };
  const M = readMap(map);
  assert.ok(M.ok, M.problems?.join('; '));
  const art = { tiles: new Set(['grass', 'path', 'wall', 'house']), edges: new Set(['path', 'wall']), dress: new Set(['grass']), sizes: { 'world.tiles.house': [48, 48], 'world.dress.grass': [64, 16] }, ppm: 16 };
  const P = planFor(M, drawPlan, art);
  assert.ok(P.slots.includes('world.tiles.grass') && P.slots.includes('world.edges.path') && P.slots.includes('world.edges.wall') && P.slots.includes('world.dress.grass'));
  const layers = new Set(P.items.map(i => i[9]));
  for (const l of [0, 2, 3, 3.5, 4, 5]) assert.ok(layers.has(l), `layer ${l} is drawn`);
  const pieces = P.items.filter(i => i[9] === 5);
  assert.equal(pieces.length, 1, 'one house on its 3 x 2 footprint');
  assert.equal(pieces[0][10], 2.5, 'it stands on its near edge (row 2, the bottom of the footprint)');
  assert.ok(P.items.some(i => i[0] === -1), 'a shadow under it');
  assert.deepEqual(P.items.map(i => i[9]), [...P.items.map(i => i[9])].sort((a, b) => a - b), 'drawn in layer order');
});

test('the 2D style is the kind look\'s own, never the kind\'s name', async () => {
  const { readFile } = await import('node:fs/promises');
  const look = async id => { const k = JSON.parse(await readFile(join(SHARED.kinds, `${id}.json`), 'utf8')); return k.look.godot ?? k.look.three; };
  assert.equal(flatStyleOf(await look('pixel')), 'pixel');
  assert.equal(flatStyleOf(await look('drawn')), 'drawn');
  assert.equal(flatStyleOf({ style: 'drawn', preset: 'storybook-day' }), 'drawn', 'a new kind with a drawn look is drawn, whatever its id');
  assert.equal(flatStyleOf(await look('silly')), 'pixel', 'a 3D look names no 2D style');
  assert.equal(flatStyleOf(null), 'pixel');
});
