// A game records the gf-web3 version it carries (gf/web3/version.js), so a later create can say what it brought.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gfWeb3VersionIn, installGfWeb3 } from '../builder/web3/node/install.mjs';
import { VERSION } from '../builder/web3/gf-web3/version.js';

test('install records the version a game had and the one it now carries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gf-web3-install-'));
  try {
    assert.equal(await gfWeb3VersionIn(dir), null, 'a game with no gf/web3 carries none');
    await mkdir(path.join(dir, 'gf', 'web3'), { recursive: true });
    await writeFile(path.join(dir, 'gf', 'web3', 'version.js'), "export const VERSION = '1.0.0';\n");
    const r = await installGfWeb3(dir);
    assert.equal(r.previous, '1.0.0');
    assert.equal(r.version, VERSION);
    assert.equal(await gfWeb3VersionIn(dir), VERSION, 'the game now records the version it took');
    assert.equal((await installGfWeb3(dir)).previous, VERSION, 'a second install finds itself current');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
