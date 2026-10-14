// The 3D tools' packages install once, whole, however many processes ask at the same moment (builder/lib/char-deps.mjs).
// Before the lock, test files and verify runs that started together each ran `npm ci` in one folder: under load npm test
// lost 26 to 121 tests to the race on a fresh checkout, every one passing on the re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { charDepsReady, ensureCharDeps } from '../builder/lib/char-deps.mjs';

const LIB = new URL('../builder/lib/char-deps.mjs', import.meta.url).href;
const NEEDS = ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer', 'sharp', 'three'];

/** A child that asks for the install in `dir`; its stand-in install takes `ms`, writes the packages one by one, and logs. */
function asker(dir, ms) {
  const script = `
    import { ensureCharDeps, charDepsReady } from ${JSON.stringify(LIB)};
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    ensureCharDeps({ dir: ${JSON.stringify(dir)}, log: () => {}, install: stage => {
      appendFileSync(${JSON.stringify(join(dir, 'installs.log'))}, process.pid + '\\n');
      for (const n of ${JSON.stringify(NEEDS)}) { mkdirSync(join(stage, 'node_modules', n), { recursive: true }); pause(${ms} / 6); writeFileSync(join(stage, 'node_modules', n, 'package.json'), '{}'); }
      return 0;
    } });
    process.stdout.write(charDepsReady(${JSON.stringify(dir)}) ? 'ready' : 'missing');`;
  return new Promise(ok => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', code => ok({ code, out, err }));
  });
}

test('six processes asking at once: one installs, the others wait, and every one finds the whole install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'char-deps-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"x","private":true}');
    const runs = await Promise.all(Array.from({ length: 6 }, () => asker(dir, 900)));
    for (const r of runs) assert.equal(r.code, 0, r.err);
    assert.deepEqual(runs.map(r => r.out), Array(6).fill('ready'));
    const installs = (await readFile(join(dir, 'installs.log'), 'utf8')).trim().split('\n');
    assert.equal(installs.length, 1, `installed ${installs.length} times`);
    assert.ok(!existsSync(join(dir, '.installing')), 'the lock is let go');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a half-written node_modules from before the lock is replaced, not trusted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'char-deps-'));
  try {
    await writeFile(join(dir, 'package.json'), '{}');
    await mkdir(join(dir, 'node_modules', 'three'), { recursive: true });   // what an interrupted npm ci left
    assert.equal(charDepsReady(dir), false);
    let n = 0;
    ensureCharDeps({ dir, log: () => {}, install: stage => { n++; for (const p of NEEDS) { const d = join(stage, 'node_modules', p); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'package.json'), '{}'); } return 0; } });
    assert.equal(n, 1);
    assert.equal(charDepsReady(dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed install leaves nothing behind and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'char-deps-'));
  try {
    await writeFile(join(dir, 'package.json'), '{}');
    assert.throws(() => ensureCharDeps({ dir, log: () => {}, install: () => 1 }), /npm ci in .* failed \(exit 1\)/);
    assert.equal(existsSync(join(dir, 'node_modules')), false);
    assert.equal(existsSync(join(dir, '.installing')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

