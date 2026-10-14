// Studio's worker runs the kit from a read-only release snapshot (files 0444). A game made from it must still be its
// owner's: every file user-writable, so a later `create` refreshes it and the folder can be deleted
// (builder/lib/writable.mjs). Here the kit is copied, made read-only, and a game is created, refreshed and deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { CHAR_DEPS, ensureCharDeps } from '../builder/lib/char-deps.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { makeWritable } from '../builder/lib/writable.mjs';
import { tempDir } from './helpers.mjs';

const SKIP = new Set(['.git', 'node_modules', 'games', 'evidence']);

async function readOnly(p) {
  const s = await stat(p);
  if (s.isDirectory()) { for (const e of await readdir(p)) if (e !== 'node_modules') await readOnly(path.join(p, e)); await chmod(p, 0o555); }
  else await chmod(p, 0o444);
}

async function notWritable(dir, root = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), m = (await stat(p)).mode;
    if (e.isDirectory()) { if ((m & 0o700) !== 0o700) out.push(`${path.relative(root, p)}/ ${(m & 0o777).toString(8)}`); await notWritable(p, root, out); }
    else if (e.isFile() && !(m & 0o200)) out.push(`${path.relative(root, p)} ${(m & 0o777).toString(8)}`);
  }
  return out;
}

test('a game created from a read-only kit is writable, refreshes and deletes', { skip: process.platform === 'win32' && 'POSIX file modes' }, async t => {
  const tmp = await tempDir('gf-rokit-');
  const kit = path.join(tmp.dir, 'kit');
  t.after(async () => { await makeWritable(tmp.dir).catch(() => {}); await tmp.cleanup(); });
  await cp(KIT_ROOT, kit, { recursive: true, filter: src => !SKIP.has(path.basename(src)) });
  // a release snapshot carries its packages installed: the kit's own, and the 3D tools' (installed here once if missing)
  ensureCharDeps();
  await symlink(path.join(KIT_ROOT, 'node_modules'), path.join(kit, 'node_modules'));
  await symlink(path.join(CHAR_DEPS, 'node_modules'), path.join(kit, path.relative(KIT_ROOT, CHAR_DEPS), 'node_modules'));
  await readOnly(kit);
  const probe = path.join(kit, 'builder', 'lib', 'create.mjs');
  assert.equal((await stat(probe)).mode & 0o222, 0, 'the kit copy really is read-only');

  const game = path.join(tmp.dir, 'game');
  const env = { ...process.env };
  delete env.GAMESFUN_WEB3;      // the default: on, so gf/web3/ (the folder Studio could not delete) is copied too
  const create = () => spawnSync(process.execPath, [path.join(kit, 'bin', 'gamesfun.mjs'), 'create', game, '--from', 'table-four'], { cwd: tmp.dir, env, encoding: 'utf8', timeout: 240000 });

  const made = create();
  assert.equal(made.status, 0, made.stderr || made.stdout);
  assert.ok(existsSync(path.join(game, 'gf', 'web3')), 'gf/web3/ came from the read-only kit');
  assert.deepEqual(await notWritable(game), [], 'every file and folder in the game is writable by its owner');

  const again = create();
  assert.equal(again.status, 0, `a second create refreshes the game: ${again.stderr || again.stdout}`);
  assert.deepEqual(await notWritable(game), []);

  await rm(game, { recursive: true });
  assert.equal(existsSync(game), false, 'the game folder deletes');
});
