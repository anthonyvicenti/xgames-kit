// The library as the runtimes read it (builder/art/views.mjs), create's one library step (fill.mjs libraryFill), the
// rebuild line (rebuild.mjs) and the art order's library tier (providers.mjs). Reads the repository's own packs and
// the kit's default set; no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetsIn, bodiesIn, findAsset, licenceOf, localFile, propEntry, propsCatalog, refFile, scopePacks } from '../../builder/art/views.mjs';
import { libraryFill } from '../../builder/art/fill.mjs';
import { rebuildPlan, words } from '../../builder/art/rebuild.mjs';
import { rebuildable } from '../../builder/art/store.mjs';
import { chooseMaker, loadProviders } from '../../builder/art/providers.mjs';
import { forgeLibrarySync } from '../../runtimes/forge/tools/library.mjs';

const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');

test('a bare name resolves in its runtime\'s packs first; a ref anywhere; the bytes are the manifest\'s', () => {
  assert.equal(findAsset('bench', 'three').pack, 'kenney-holiday-kit', 'the three runtime\'s bench is Kenney\'s');
  assert.equal(findAsset('bench', 'scenic').pack, 'folio-nature', 'the scenic profile\'s bench is folio\'s');
  assert.equal(findAsset('library:kit-standins/bench').pack, 'kit-standins');
  assert.equal(findAsset('no-such-thing', 'three'), null);
  const a = findAsset('tree-round', 'three'), f = localFile(a);
  assert.ok(f && existsSync(f), 'the default set has it');
  assert.equal(sha(f), a.sha256);
  assert.equal(refFile('humanoid-clips/gf-humanoid-1'), localFile(findAsset('humanoid-clips/gf-humanoid-1')));
  assert.ok(scopePacks('three').includes('kenney-platformer-kit') && scopePacks('scenic').includes('folio-nature'));
});

test('a prop entry carries what the worlds read: collider, size, light, door, parts, grip, credit', () => {
  const lamp = propEntry(findAsset('ceiling-lamp', 'three'));
  assert.deepEqual(lamp.light, { at: [0, 0.08, 0], radius: 1.2 });
  assert.equal(lamp.collider, 'none');
  assert.equal(propEntry(findAsset('office-wall-doorway', 'three')).collider.shape, 'compound', 'the doorway\'s three boxes (sources.json use)');
  assert.deepEqual(propEntry(findAsset('office-wall-doorway', 'three')).door, { width: 0.86, height: 1.99 });
  assert.equal(propEntry(findAsset('block-slope', 'three')).collider.shape, 'ramp');
  assert.ok(propEntry(findAsset('dungeon-chest', 'scenic')).parts.lid, 'the chest lid by its own name');
  const sword = propEntry(findAsset('kaykit-sword', 'scenic'));
  assert.equal(sword.origin, 'grip'); assert.equal(sword.grip.socket, 'hand_r'); assert.equal(sword.hands, 1);
  const cloud = licenceOf(findAsset('cloud-puffy', 'three'));
  assert.equal(cloud.spdx, 'CC-BY-3.0'); assert.equal(cloud.title, 'Cloud'); assert.match(cloud.licenseUrl, /by\/3\.0/);
  assert.ok(propsCatalog('three').props.length >= 149, 'every three prop');
});

test('bodies: a pack\'s default first, every person on gf-humanoid-1 with the height rig-check measured, every creature on its archetype\'s standard', () => {
  const three = bodiesIn('three');
  assert.equal(three[0].id, 'bean-classic');
  const people = three.filter(b => b.archetype === 'humanoid'), creatures = three.filter(b => b.archetype !== 'humanoid');
  assert.ok(people.length && people.every(b => b.rig === 'gf-humanoid-1' && b.height > 1));
  const rigs = { worm: 'gf-worm-1', blob: 'gf-blob-1', quadruped: 'gf-quadruped-1', flyer: 'gf-flyer-1' };
  assert.ok(creatures.length >= 5 && creatures.every(b => b.rig === rigs[b.archetype] && b.height > 0.1), 'the creature set (CREATURES.md)');
  assert.deepEqual(bodiesIn('three', { archetype: 'flyer' }).map(b => b.id), ['bird-red']);
  assert.equal(bodiesIn('scenic').find(b => b.id === 'kaykit-knight').height, 1.736);
  assert.ok(!three.some(b => b.id === 'quaternius-zombie' && b.judge.ok === false), 'a body its judge fails is never offered');
});

test('the forge casts by its own names from the library: files, licences, small variants and play data', () => {
  const L = forgeLibrarySync();
  const wall = L.forgeFile('ruins/wall.glb');
  assert.ok(existsSync(wall));
  assert.equal(L.forgeLicences['ruins/wall.glb'].spdx, 'CC0-1.0');
  assert.ok(L.forgeCatalog.roles['ruins.wall'], 'the roles');
  assert.ok(L.forgeCatalog.sections.world['world/flagstone-a.glb'].textureFiles, 'the play data the generators read');
  assert.ok(L.props.some(p => p.id === 'dungeon-wall'), 'the scenic pieces the crypt room takes');
  assert.throws(() => L.forgeFile('ruins/no-such.glb'), /names no library asset/);
});

test('create\'s library step fills a missing file slot by name, then by need; an optional one only by name', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lib-fill-'));
  try {
    const slots = [
      { id: 'look.textures.noise', type: 'image', optional: true, source: { file: 'assets/textures/ground-noise.png' } },
      { id: 'prop.barrel', type: 'model', label: 'Barrel', description: 'a wooden barrel', source: { file: 'assets/models/barrel.glb' } },
      { id: 'character.hat.player', type: 'model', optional: true, source: { file: 'assets/models/hat-player.glb' } },
      { id: 'prop.given', type: 'model', source: { file: 'assets/models/given.glb' } },
    ];
    await mkdir(path.join(dir, 'assets/models'), { recursive: true });
    await writeFile(path.join(dir, 'assets/models/given.glb'), 'mine');
    const wrote = [], record = { kit: { engine: 'party' } };
    const A = { manifest: { slots } };
    let assembled = 0;
    const out = await libraryFill(dir, A, { spec: {}, record, put: async (rel, buf) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), buf); wrote.push(rel); }, rewrite: async () => {}, assemble: async () => { assembled++; return 'again'; } });
    assert.equal(out, 'again'); assert.equal(assembled, 1);
    assert.deepEqual(wrote.sort(), ['assets/models/barrel.glb', 'assets/textures/ground-noise.png']);
    assert.equal(await readFile(path.join(dir, 'assets/models/given.glb'), 'utf8'), 'mine', 'a provided file is left alone');
    assert.ok(record.worldArt.some(r => r.file === 'assets/textures/ground-noise.png' && /kit-textures\/noise-soft/.test(r.what)));
    assert.ok(record.worldArt.some(r => r.file === 'assets/models/barrel.glb' && /barrel/.test(r.what)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a rebuild line is an art ingest command of the pinned zip; only such a pack rebuilds by itself', () => {
  assert.deepEqual(words(`art ingest k.zip --include 'Tiles/*.png' --style pixel (a note)`), ['art', 'ingest', 'k.zip', '--include', 'Tiles/*.png', '--style', 'pixel']);
  const pack = JSON.parse(readFileSync(new URL('../../library/packs/kenney-tiny-town/pack.json', import.meta.url), 'utf8'));
  assert.ok(rebuildable(pack));
  const p = rebuildPlan(pack);
  assert.equal(p.file, 'kenney_tiny-town.zip');
  assert.deepEqual(p.opts.include, ['Tiles/*.png']);
  assert.equal(p.opts.pack, 'kenney-tiny-town'); assert.equal(p.opts.texelsPerMetre, 16);
  assert.ok(!rebuildable(JSON.parse(readFileSync(new URL('../../library/packs/kenney-nature-kit/pack.json', import.meta.url), 'utf8'))), 'a pack baked by an old tool comes from the default set or a mirror');
});

test('the art order: the person\'s file, then the library, then a connection, a session, the stand-ins', () => {
  const data = loadProviders();
  assert.deepEqual(data.order, ['provided', 'library', 'connection', 'session', 'stand-in']);
  const pick = { ref: 'kenney-platformer-kit/barrel', describe: 'a cartoon wooden barrel', licence: { spdx: 'CC0-1.0' } };
  assert.equal(chooseMaker({ kind: 'model', library: pick, env: {}, data }).maker.id, 'library');
  assert.equal(chooseMaker({ kind: 'model', library: pick, provided: true, env: {}, data }).maker.id, 'provided');
  const fresh = chooseMaker({ kind: 'model', library: false, env: { MESHY_API_KEY: 'x' }, data });
  assert.equal(fresh.maker.id, 'meshy');
  assert.match(fresh.passedOver.find(p => p.id === 'library').why, /new one/);
});
