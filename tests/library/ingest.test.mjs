// art ingest on pictures (no browser needed for PNG): a folder, a zip and a URL; dedupe by sha256; quarantine without a
// licence record; the flat judge on a pixel tile; manifests that pass the contract's schemas when they are here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { globRe, ingest } from '../../builder/art/ingest.mjs';
import { loadLibrary } from '../../builder/art/library.mjs';
import { schemas } from '../../builder/art/manifest.mjs';
import { inStore } from '../../builder/art/store.mjs';
import { squarePng, tempLibrary } from './helpers.mjs';
import { blank, encodePng } from '../../builder/art/png.mjs';

/** A 16 px pixel tile that repeats cleanly: a checker of two greens. */
function pixelTile() {
  const pic = blank(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4, on = ((x >> 2) + (y >> 2)) % 2; pic.data[i] = 60; pic.data[i + 1] = on ? 170 : 140; pic.data[i + 2] = 70; pic.data[i + 3] = 255; }
  return encodePng(pic);
}

async function sourceFolder(root) {
  const src = path.join(root, 'src');
  await mkdir(path.join(src, 'Tiles'), { recursive: true });
  await mkdir(path.join(src, 'Props'), { recursive: true });
  await writeFile(path.join(src, 'Tiles', 'tile_grass.png'), pixelTile());
  await writeFile(path.join(src, 'Props', 'red_gem.png'), squarePng(16, [220, 40, 60], { outline: [30, 20, 30] }).png);
  await writeFile(path.join(src, 'Props', 'blue_gem.png'), squarePng(16, [40, 90, 220], { outline: [30, 20, 30] }).png);
  await writeFile(path.join(src, 'Preview.png'), squarePng(64, [10, 10, 10]).png);
  await writeFile(path.join(src, 'License.txt'), 'CC0');
  return src;
}

const LIC = { licence: { spdx: 'CC0-1.0', author: 'A test author', url: 'https://example.com/pack' }, newPack: { title: 'Test pixel pack', owner: 'third-party', source: { kind: 'collection', page: 'https://example.com/pack' } } };

test('globs: ** any depth, * one segment', () => {
  assert.ok(globRe('Tiles/*.png').test('Tiles/tile_0001.png'));
  assert.ok(!globRe('Tiles/*.png').test('Tiles/sub/tile.png'));
  assert.ok(globRe('**/*.png').test('a/b/c.png'));
  assert.ok(globRe('Sprites/*/Double/*.png').test('Sprites/Tiles/Double/block.png'));
});

test('ingest a folder into a new pack: manifests, previews, the store, the flat judge, then nothing twice', async () => {
  const t = await tempLibrary();
  try {
    const src = await sourceFolder(t.root);
    const r = await ingest(src, { config: t.config, pack: 'test-pixel', ...LIC, include: ['Tiles/*.png', 'Props/*.png'], style: 'pixel', texelsPerMetre: 16 });
    assert.equal(r.added.length, 3, JSON.stringify(r));
    assert.deepEqual(r.quarantined, []);
    const lib = loadLibrary(t.config);
    const p = lib.find(x => x.pack.id === 'test-pixel');
    assert.equal(p.pack.assets, 3);
    assert.equal(p.pack.licence.file, 'library/packs/test-pixel/LICENSE.txt');
    const tile = p.assets.find(a => a.id === 'tile-grass');
    assert.equal(tile.category, 'tile');
    assert.equal(tile.use.style, 'pixel');
    assert.equal(tile.validated[0].by, 'flat-judge');
    assert.equal(tile.fits.signature.palette.exact, 2);
    const gem = p.assets.find(a => a.id === 'red-gem');
    assert.equal(gem.category, 'picture');
    assert.equal(gem.fits.signature.outline.present, true, 'a dark one-pixel outline reads as ink');
    for (const a of p.assets) {
      assert.ok(inStore(t.config.store, a.sha256), `${a.id} in the store`);
      assert.ok(existsSync(path.join(p.dir, a.preview)), `${a.id} has a preview`);
    }
    assert.ok(readFileSync(path.join(p.dir, 'LICENSE.txt'), 'utf8').includes('CC0-1.0'));
    const S = schemas();
    if (S) {
      assert.deepEqual(S.validatePack(p.pack), []);
      for (const a of p.assets) assert.deepEqual(S.validateAsset(a), [], a.id);
    }
    const again = await ingest(src, { config: t.config, pack: 'test-pixel', include: ['Tiles/*.png', 'Props/*.png'], style: 'pixel' });
    assert.equal(again.added.length, 0);
    assert.equal(again.duplicates.length, 3, 'the same files are found by sha256');
  } finally { await t.cleanup(); }
});

test('no licence record: every file goes to quarantine and none to the index', async () => {
  const t = await tempLibrary();
  try {
    const src = await sourceFolder(t.root);
    const r = await ingest(src, { config: t.config, pack: 'nobody-knows', include: ['Props/*.png'] });
    assert.equal(r.added.length, 0);
    assert.equal(r.quarantined.length, 2);
    assert.equal(loadLibrary(t.config).length, 0);
    const q = readdirSync(t.config.quarantine);
    assert.equal(q.length, 2);
    assert.match(readFileSync(path.join(t.config.quarantine, q[0], 'record.json'), 'utf8'), /no licence record/);
    // a licence the policy does not take is refused before anything is written
    await assert.rejects(ingest(src, { config: t.config, pack: 'nc-pack', licence: { spdx: 'CC-BY-NC-4.0' }, include: ['Props/*.png'] }), /outside the policy/);
  } finally { await t.cleanup(); }
});

test('a zip and a URL: unpacked and downloaded, then the same pipeline', { skip: spawnSync('zip', ['-v']).status !== 0 && 'no zip command' }, async () => {
  const t = await tempLibrary();
  const server = http.createServer((req, res) => {
    const f = path.join(t.root, req.url.slice(1));
    if (!existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.end(readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const src = await sourceFolder(t.root);
    spawnSync('zip', ['-q', '-r', path.join(t.root, 'pack.zip'), '.'], { cwd: src });
    const z = await ingest(path.join(t.root, 'pack.zip'), { config: t.config, pack: 'zip-pack', ...LIC, include: ['Props/*.png'] });
    assert.equal(z.added.length, 2, JSON.stringify(z));
    const url = `http://127.0.0.1:${server.address().port}/src/Tiles/tile_grass.png`;
    const u = await ingest(url, { config: t.config, pack: 'zip-pack', style: 'pixel' });
    assert.equal(u.added.length, 1, JSON.stringify(u));
    const a = loadLibrary(t.config).find(p => p.pack.id === 'zip-pack').assets.find(x => x.id === 'tile-grass');
    assert.equal(a.source.download, url);
  } finally { server.close(); await t.cleanup(); }
});

test('a GLB is optimized (meshopt) and its outside texture files are packed in; its category is guessed from its parts', async () => {
  const { Document, NodeIO } = (await import('../../builder/art/deps.mjs')).gltfCore;
  const { optimizeGlb, glbHasExternal, packGlb } = await import('../../builder/art/optimize.mjs');
  const { guessCategory } = await import('../../builder/art/ingest.mjs');
  const t = await tempLibrary();
  try {
    const doc = new Document(), buf = doc.createBuffer();
    const pos = doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]));
    const idx = doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(new Uint16Array([0, 1, 2, 2, 1, 3]));
    const tex = doc.createTexture('t').setImage(squarePng(16).png).setMimeType('image/png').setURI('tex.png');
    const mat = doc.createMaterial('m').setBaseColorTexture(tex);
    const mesh = doc.createMesh('quad').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(mat));
    doc.createScene().addChild(doc.createNode('quad').setMesh(mesh));
    const io = new NodeIO();
    const file = path.join(t.root, 'quad.glb');
    // a GLB that names its texture as a file beside it (as Kenney's character GLBs do)
    const { json, resources } = await io.writeJSON(doc, { basename: 'quad' });
    const bin = Buffer.from(resources['quad.bin']);
    delete json.buffers[0].uri;
    await writeFile(path.join(t.root, 'tex.png'), Buffer.from(resources['tex.png']));
    let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
    const pad = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
    const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + pad.length, 8);
    const ch = (b, t) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(t, 4); return Buffer.concat([h, b]); };
    await writeFile(file, Buffer.concat([head, ch(js, 'JSON'), ch(pad, 'BIN\0')]));
    const { readFile } = await import('node:fs/promises');
    let bytes = await readFile(file);
    assert.equal(glbHasExternal(bytes), true);
    bytes = await packGlb(file);
    assert.equal(glbHasExternal(bytes), false);
    const o = await optimizeGlb(bytes);
    assert.ok(o.did.includes('meshopt compression'));
    const len = o.bytes.readUInt32LE(12), j = JSON.parse(o.bytes.toString('utf8', 20, 20 + len));
    assert.ok(j.extensionsUsed.includes('EXT_meshopt_compression'));
    assert.equal(await guessCategory({ format: 'glb', dimension: '3d' }, 'quad.glb', o.bytes), 'prop');
  } finally { await t.cleanup(); }
});
