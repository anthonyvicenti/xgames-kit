// One create path: a game made by `gamesfun create` and one made by builder/lib/create.mjs (what the MCP create tool, the
// examples and the scripts call) are file for file identical, with web3 on (the default) and with GAMESFUN_WEB3=0.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createGame } from '../builder/lib/create.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { tempDir } from './helpers.mjs';

const run = promisify(execFile);

async function tree(dir, base = dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await tree(p, base, out);
    else {
      // the folder's own path may appear in a guide: compare with it masked
      const buf = (await readFile(p)).toString('latin1').split(base).join('<game>');
      out[path.relative(base, p).split(path.sep).join('/')] = createHash('sha256').update(buf).digest('hex');
    }
  }
  return out;
}

for (const [label, off] of [['web3 on (default)', false], ['GAMESFUN_WEB3=0', true]]) {
  test(`gamesfun create and lib/create.mjs make the same game, ${label}`, async () => {
    const t = await tempDir();
    try {
      const env = { ...process.env }; delete env.GAMESFUN_WEB3;
      if (off) env.GAMESFUN_WEB3 = '0';
      const a = path.join(t.dir, 'a', 'game'), b = path.join(t.dir, 'b', 'game');
      await mkdir(path.dirname(a)); await mkdir(path.dirname(b));
      await run(process.execPath, [path.join(KIT_ROOT, 'bin', 'gamesfun.mjs'), 'create', a, '--from', 'soak-squad'], { env, cwd: t.dir, maxBuffer: 1 << 26 });
      await createGame(b, { from: 'soak-squad', env });
      const [ta, tb] = [await tree(a), await tree(b)];
      assert.deepEqual(Object.keys(ta).sort(), Object.keys(tb).sort());
      assert.deepEqual(ta, tb);
      assert.equal(existsSync(path.join(b, 'gf', 'web3')), !off, 'gf/web3/');
      assert.equal(existsSync(path.join(b, 'gamesfun.json')), !off, 'gamesfun.json');
    } finally { await t.cleanup(); }
  });
}
