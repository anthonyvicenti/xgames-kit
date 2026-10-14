// The art order's connection step for generated art (builder/art/generate.mjs), with a mocked maker: no key, no call,
// no credits. The made file goes through ingest into the game's private pack and the slot is filled from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateSlot, gamePack } from '../../builder/art/generate.mjs';
import { loadLibrary } from '../../builder/art/library.mjs';
import { findAsset, localFile } from '../../builder/art/views.mjs';
import { squarePng, tempLibrary } from './helpers.mjs';

const crate = localFile(findAsset('kenney-platformer-kit/crate'));
const fakeRenderer = { model: async () => ({ png: squarePng(64).png, measures: { triangles: 12, size: [1, 1, 1], textures: [], materials: 1, colours: [], area: 6, texturedArea: 0, texels: 0 } }) };

async function game(root) {
  const dir = path.join(root, 'games', 'crate-race');
  await mkdir(path.join(dir, 'assets/models'), { recursive: true });
  await copyFile(crate, path.join(dir, 'assets/models/token.glb'));
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify({ schema: 'gf-assets/1', slots: [
    { id: 'prop.token', type: 'model', label: 'Token', source: { file: 'assets/models/token.glb' }, constraints: { size: [1.6, 1.6, 1.6] } },
    { id: 'look.sky', type: 'image', source: { file: 'assets/textures/sky.png' } },
  ] }));
  return dir;
}

test('generate: no yes, no call; with yes the made model enters the game\'s private pack and fills the slot', async () => {
  const t = await tempLibrary();
  try {
    const dir = await game(t.root);
    const calls = [];
    const made = path.join(t.root, 'made.glb');
    const meshy = {
      name: 'Meshy (mock)', kinds: ['body', 'prop'], licence: { spdx: 'LicenseRef-Meshy-Paid', author: 'Meshy AI, generated on the creator\'s paid account', url: 'https://www.meshy.ai' }, licenceText: 'test',
      async plan({ words, size }) { calls.push(['plan', words, size]); return { estimate: 36, plan: ['text-to-image', 'image-to-3d'] }; },
      async make({ words, out }) { calls.push(['make', words]); await copyFile(crate, made); return { file: made, credits: 36, tasks: { to3d: { id: 'task-1' } } }; },
    };
    const dry = await generateSlot({ game: dir, slot: 'prop.token', words: 'a giant gold coin', makers: { meshy }, config: t.config });
    assert.equal(dry.paid, false); assert.equal(dry.plan.estimate, 36);
    assert.deepEqual(calls, [['plan', 'a giant gold coin', 1.6]]);
    const r = await generateSlot({ game: dir, slot: 'prop.token', words: 'a giant gold coin', yes: true, makers: { meshy }, config: t.config, renderer: fakeRenderer });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.credits, 36);
    const pack = loadLibrary(t.config).find(p => p.pack.id === gamePack(dir));
    assert.ok(pack, 'the game\'s pack');
    assert.equal(pack.pack.visibility, 'private');
    assert.equal(pack.pack.licence.spdx, 'LicenseRef-Meshy-Paid');
    assert.ok(pack.dir.startsWith(t.config.privatePacks), 'kept in the private packs folder, never the repository');
    assert.equal(pack.assets.length, 1);
    assert.ok(readFileSync(path.join(dir, 'assets/models/token.glb')).length > 0);
    assert.equal(r.ref, `${pack.pack.id}/${pack.assets[0].id}`);
    // a picture slot: Meshy makes models only, and says so without a call
    const pic = await generateSlot({ game: dir, slot: 'look.sky', words: 'a sunset sky', yes: true, makers: { meshy }, config: t.config });
    assert.equal(pic.ok, false); assert.match(pic.problems[0], /makes body and prop models/);
    assert.equal(calls.filter(c => c[0] === 'make').length, 1);
  } finally { await t.cleanup(); }
});
