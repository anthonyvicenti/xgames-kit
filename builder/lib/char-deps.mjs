// gf-three's 3D tools (rig-check, meshy-*, optimize) need npm packages of their own (gltf-transform, meshoptimizer,
// sharp), pinned in builder/tools/lib/char-deps/package.json and loaded from the node_modules beside it.
// They are installed there on first use (git-ignored; the snapshot itself is never changed).
//
// Several processes ask at once (node --test runs test files side by side; verify, create and the art tools each ask),
// so the install is one at a time and whole or not at all: the first asker takes a lock folder, installs into a
// folder of its own and moves the finished node_modules into place with one rename; the others wait for it. Before
// that (2026-10-13), two askers each ran `npm ci` in the same folder: one deleted what the other was writing
// (ENOTEMPTY), a third saw a half-written node_modules and failed on a missing package, and on a fresh checkout under
// load npm test lost 26 to 121 tests to it, all passing on a re-run once the install had finished.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GF3_TOOLS } from './paths.mjs';

export const CHAR_DEPS = path.join(GF3_TOOLS, 'lib', 'char-deps');
const DONE = '.gamesfun-installed';                 // written into node_modules last, so it means the install finished
const LOCK = path.join(CHAR_DEPS, '.installing');
const WAIT_MS = 15 * 60000, STALE_MS = 20 * 60000;
// what an install from before this file's lock left (no DONE mark): complete when every package the tools load is there
const NEEDS = ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer', 'sharp', 'three'];

/** npm's own CLI script, run with this Node (no shell: npm.cmd can't be spawned directly on Windows). */
export function npmCli() {
  const cands = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return cands.find(p => p && /npm-cli\.js$/.test(p) && existsSync(p)) ?? null;
}

/** Is the install there and whole? (`dir`: the char-deps folder; a test's own copy) */
export function charDepsReady(dir = CHAR_DEPS) {
  const nm = path.join(dir, 'node_modules');
  if (!existsSync(nm)) return false;
  return existsSync(path.join(nm, DONE)) || NEEDS.every(n => existsSync(path.join(nm, n, 'package.json')));
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const age = p => { try { return Date.now() - statSync(p).mtimeMs; } catch { return 0; } };

/** Take the lock folder (mkdir is atomic), or wait while another process installs. → true when this process holds it */
function lockOrWait(dir, lock) {
  const t0 = Date.now();
  for (;;) {
    if (charDepsReady(dir)) return false;
    try { mkdirSync(lock); return true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (age(lock) > STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }   // a process that died mid-install
    if (Date.now() - t0 > WAIT_MS) throw new Error(`waited ${Math.round(WAIT_MS / 60000)} minutes for another process to install the 3D tools' packages in ${dir}; if none is running, delete ${lock}`);
    pause(400);
  }
}

export function ensureCharDeps({ log = m => console.error(m), dir = CHAR_DEPS, install = null } = {}) {
  if (charDepsReady(dir)) return;
  const lock = dir === CHAR_DEPS ? LOCK : path.join(dir, '.installing');
  if (!lockOrWait(dir, lock)) return;
  try {
    if (charDepsReady(dir)) return;
    const cli = npmCli();
    if (!cli && !install) throw new Error(`the 3D tools need their npm packages. Run: npm ci --prefix "${dir}"`);
    log('gamesfun: installing the 3D tools\' packages once (gltf-transform, meshoptimizer, sharp)…');
    // installed in a folder of this process's own, then moved into place whole
    const stage = path.join(dir, `.stage-${process.pid}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) if (existsSync(path.join(dir, f))) copyFileSync(path.join(dir, f), path.join(stage, f));
    const status = install ? install(stage) : spawnSync(process.execPath, [cli, 'ci', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', windowsHide: true }).status;
    if (status !== 0) { rmSync(stage, { recursive: true, force: true }); throw new Error(`npm ci in ${dir} failed (exit ${status})`); }
    writeFileSync(path.join(stage, 'node_modules', DONE), `${new Date().toISOString()}\n`);
    rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });   // a half-written one from an older kit
    renameSync(path.join(stage, 'node_modules'), path.join(dir, 'node_modules'));
    rmSync(stage, { recursive: true, force: true });
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
