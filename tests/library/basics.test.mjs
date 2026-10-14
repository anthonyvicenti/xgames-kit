// detect, policy, signature, store: the small parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect } from '../../builder/art/detect.mjs';
import { licenceClass, loadPolicy, usable } from '../../builder/art/policy.mjs';
import { familyOf, hsl, packSignature, paletteOf, pictureSignature } from '../../builder/art/signature.mjs';
import { fetchAsset, put, sha256, storePath } from '../../builder/art/store.mjs';
import { LIBRARY_ROOT } from '../../builder/art/config.mjs';
import { squarePng } from './helpers.mjs';

const policy = loadPolicy(path.join(LIBRARY_ROOT, 'policy.json'));

test('detect reads the format from the bytes, not the name', () => {
  assert.equal(detect(Buffer.from('glTF\x02\x00\x00\x00')).format, 'glb');
  assert.equal(detect(squarePng().png).format, 'png');
  assert.equal(detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).format, 'jpg');
  assert.equal(detect(Buffer.from('OggS\0\x02rest')).dimension, 'audio');
  assert.equal(detect(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).format, 'webp');
  assert.equal(detect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).format, 'svg');
  assert.equal(detect(Buffer.from('just text')), null);
});

test('policy: own, CC0 and MIT first; CC-BY needs its credit; a paid maker needs a key and a yes; the rest is refused', () => {
  assert.equal(licenceClass(policy, 'CC0-1.0').rank, 0);
  assert.equal(licenceClass(policy, 'MIT').duty, 'notice');
  assert.equal(licenceClass(policy, 'OFL-1.1').name, 'permissive');
  assert.equal(licenceClass(policy, 'CC-BY-3.0').rank, 1);
  assert.equal(licenceClass(policy, 'LicenseRef-Meshy-Paid').name, 'paid-maker');
  assert.equal(licenceClass(policy, 'CC-BY-NC-4.0'), null);
  assert.equal(usable(policy, { spdx: 'CC-BY-4.0' }).ok, false, 'no credit line: refused');
  assert.equal(usable(policy, { spdx: 'CC-BY-4.0', credit: '"X" by Y, CC BY 4.0' }).ok, true);
  assert.equal(usable(policy, { spdx: 'LicenseRef-Meshy-Paid' }).ok, false);
  assert.equal(usable(policy, { spdx: 'LicenseRef-Meshy-Paid' }, { paid: { yes: true, keys: [] } }).ok, false, 'a yes without the key');
  assert.equal(usable(policy, { spdx: 'LicenseRef-Meshy-Paid' }, { paid: { yes: true, keys: ['meshy'] } }).ok, true);
  assert.equal(usable(policy, { spdx: 'GPL-3.0-only' }).ok, false);
  // the floor is data: taking CC-BY out of `allow` refuses it with no code change
  const strict = { ...policy, allow: policy.allow.filter(c => c !== 'attribution') };
  assert.match(usable(strict, { spdx: 'CC-BY-3.0', credit: 'x' }).why, /outside the policy's floor/);
});

test('signature: palette size, families, exact colours, ink outline', () => {
  assert.equal(familyOf(...hsl(200, 40, 40)), 'red');
  assert.equal(familyOf(...hsl(40, 160, 60)), 'green');
  assert.equal(familyOf(...hsl(120, 120, 120)), 'grey');
  assert.equal(familyOf(...hsl(90, 50, 20)), 'brown');
  const p = paletteOf([[0xff0000, 3], [0x00ff00, 1]]);
  assert.equal(p.size, 2);
  assert.deepEqual(p.families.map(f => f.hue), ['red', 'green']);
  const plain = pictureSignature(squarePng(32, [220, 60, 60]).pic, { texelsPerMetre: 16 });
  assert.equal(plain.palette.exact, 1);
  assert.equal(plain.outline.present, false);
  assert.equal(plain.texelsPerMetre, 16);
  const inked = pictureSignature(squarePng(32, [220, 60, 60], { outline: [20, 20, 30] }).pic);
  assert.equal(inked.outline.present, true);
  assert.equal(inked.outline.how, 'ink');
  const ps = packSignature([{ signature: plain }, { signature: inked }]);
  assert.equal(ps.assets, 2);
  assert.equal(ps.outlineShare, 0.5);
});

test('store: content-addressed put, then fetch from the store, a mirror folder, or the source when unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'art-store-'));
  try {
    const bytes = Buffer.from('a file');
    const r = await put(path.join(root, 'store'), bytes);
    assert.equal(r.sha256, sha256(bytes));
    assert.equal(readFileSync(storePath(path.join(root, 'store'), r.sha256), 'utf8'), 'a file');
    assert.equal((await put(path.join(root, 'store'), bytes)).added, false);
    // a second machine: empty store, a mirror folder that has it
    const mirror = path.join(root, 'mirror');
    await put(mirror, Buffer.from('mirrored'));
    const config = { store: path.join(root, 'store2'), mirrors: [mirror] };
    const m = await fetchAsset(config, { pack: 'p', id: 'a', sha256: sha256(Buffer.from('mirrored')) });
    assert.equal(m.from, mirror);
    // the pack's pinned source, only when the asset is that file unchanged
    const src = Buffer.from('upstream');
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => src });
    const s = await fetchAsset({ store: path.join(root, 'store3'), mirrors: [] }, { pack: 'p', id: 'b', sha256: sha256(src), source: { download: 'https://example.com/b.ogg', sha256: sha256(src) } }, null, { fetchImpl });
    assert.equal(s.from, 'https://example.com/b.ogg');
    // a baked file with no mirror says how it comes back
    await assert.rejects(fetchAsset({ store: path.join(root, 'store4'), mirrors: [] }, { pack: 'p', id: 'c', sha256: sha256(Buffer.from('baked')) }, { source: { rebuild: 'the bake tool' } }), /rebuilt from the pack's pinned source by: the bake tool/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
