// The kit's core runs in a checkout without builder/web3/ (web3 stays on by default: builder/lib/web3-switch.mjs). builder/lib/create.mjs
// imports the in-game web3 kit only when it adds it, so `create` works when that folder is not there. The child
// process below makes every module under builder/web3/ unfindable, as a checkout without the folder would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { tempDir } from './helpers.mjs';

const WEB3 = pathToFileURL(path.join(KIT_ROOT, 'builder', 'web3') + path.sep).href;
const HOOK = `export async function resolve(s, c, next) {
  const r = await next(s, c);
  if (r.url.startsWith(${JSON.stringify(WEB3)})) { const e = new Error('Cannot find module ' + r.url.replace('file://', '')); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; }
  return r;
}`;

test('create makes a game with no web3/ folder in the checkout, web3 on by default', async t => {
  const tmp = await tempDir('gf-noweb3-');
  t.after(tmp.cleanup);
  const dir = path.join(tmp.dir, 'game');
  const script = `
    import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(HOOK)}));
    const { createGame } = await import(${JSON.stringify(pathToFileURL(path.join(KIT_ROOT, 'builder', 'lib', 'create.mjs')).href)});
    let blocked = false;
    try { await import(${JSON.stringify(pathToFileURL(path.join(KIT_ROOT, 'builder', 'web3', 'node', 'install.mjs')).href)}); } catch (e) { blocked = e.code === 'ERR_MODULE_NOT_FOUND'; }
    const r = await createGame(${JSON.stringify(dir)}, { from: 'soak-squad' });
    console.log(JSON.stringify({ ok: r.ok, web3: r.web3, blocked }));`;
  const env = { ...process.env };
  delete env.GAMESFUN_WEB3;          // the default: on
  const c = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: KIT_ROOT, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(c.status, 0, c.stderr);
  const out = JSON.parse(c.stdout.trim().split('\n').at(-1));
  assert.equal(out.blocked, true, 'the web3 modules really are out of reach in the child');
  assert.equal(out.ok, true);
  assert.equal(out.web3, null, 'no web3 kit: the game is made without it');
  assert.ok(existsSync(path.join(dir, 'rules.js')) && existsSync(path.join(dir, 'gf')), 'the game is there');
  assert.equal(existsSync(path.join(dir, 'gf', 'web3')), false);
});
