// The doctor's graphics probe retries with hardware GL flags on Linux; the probe is stubbed, nothing launches a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hardwareGlEnv, NVIDIA_EGL, probeWithRetry, savedGpuEnv } from '../builder/lib/gpu-env.mjs';
import { runDoctor } from '../builder/lib/doctor.mjs';
import { tempDir } from './helpers.mjs';

const soft = { ok: true, webgl: true, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' };
const card = { ok: true, webgl: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)', webgpu: false };
// a stub that answers by whether the flags are in the env it was given
const stub = (calls = []) => async env => { calls.push(env); return /use-gl=angle/.test(env.CHROME_ARGS ?? '') ? card : soft; };

test('linux: software on the plain probe, then the card with the EGL flags', async () => {
  const calls = [];
  const r = await probeWithRetry(stub(calls), { platform: 'linux', env: {}, exists: p => p === NVIDIA_EGL });
  assert.equal(calls.length, 2);
  assert.match(r.renderer, /GTX 1080/);
  assert.equal(r.retried, true);
  assert.equal(r.viaFlags.CHROME_ARGS, '--use-gl=angle --use-angle=gl-egl');
  assert.equal(r.viaFlags.__EGL_VENDOR_LIBRARY_FILENAMES, NVIDIA_EGL);
});

test('linux: no NVIDIA vendor file, no vendor variable; still software after the retry stays software', async () => {
  assert.equal(hardwareGlEnv({ platform: 'linux', env: {}, exists: () => false }).__EGL_VENDOR_LIBRARY_FILENAMES, undefined);
  const calls = [];
  const r = await probeWithRetry(async env => { calls.push(env); return soft; }, { platform: 'linux', env: {}, exists: () => false });
  assert.equal(calls.length, 2);
  assert.equal(r.viaFlags, null);
  assert.match(r.renderer, /SwiftShader/);
});

test('no retry on Windows and macOS, on hardware, or when the person chose a GL backend', async () => {
  for (const platform of ['win32', 'darwin']) {
    const calls = [];
    await probeWithRetry(async e => { calls.push(e); return soft; }, { platform, env: {} });
    assert.equal(calls.length, 1, platform);
  }
  const calls = [];
  await probeWithRetry(async e => { calls.push(e); return card; }, { platform: 'linux', env: {} });
  assert.equal(calls.length, 1);
  await probeWithRetry(async e => { calls.push(e); return soft; }, { platform: 'linux', env: { CHROME_ARGS: '--use-angle=vulkan' } });
  assert.equal(calls.length, 2, 'one probe only for the person-chosen backend');
});

test('their own CHROME_ARGS are kept and ours added', () => {
  assert.equal(hardwareGlEnv({ platform: 'linux', env: { CHROME_ARGS: '--foo' }, exists: () => false }).CHROME_ARGS, '--foo --use-gl=angle --use-angle=gl-egl');
});

test('doctor: found with the flags is ok; still software warns honestly and points to chrome://gpu', async () => {
  const base = { deps: () => true, kits: true, git: 'git', chrome: { path: '/c', kind: 'chrome', source: 'installed' }, ports: [[5180, true]], writable: { games: null, state: null }, detected: [], registered: async () => true, eglExists: () => false };
  const ok = await runDoctor({ platform: 'linux', env: {}, probes: { ...base, gpu: stub() }, data: { agents: [] } });
  const g = ok.items.find(i => i.id === 'graphics');
  assert.equal(g.status, 'ok');
  assert.match(g.detail, /GTX 1080/);
  const bad = await runDoctor({ platform: 'linux', env: {}, probes: { ...base, gpu: async () => soft }, data: { agents: [] } });
  const w = bad.items.find(i => i.id === 'graphics');
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /chrome:\/\/gpu/);
  assert.match(w.detail, /may still use it/);
});

test('saved flags reach tools on Linux only, and never override the person\'s backend', async () => {
  const { dir, cleanup } = await tempDir();
  const file = path.join(dir, 'gpu-env.json');
  await writeFile(file, JSON.stringify({ CHROME_ARGS: '--use-gl=angle --use-angle=gl-egl', __EGL_VENDOR_LIBRARY_FILENAMES: NVIDIA_EGL }));
  assert.deepEqual(savedGpuEnv({ env: {}, platform: 'linux', file }), { CHROME_ARGS: '--use-gl=angle --use-angle=gl-egl', __EGL_VENDOR_LIBRARY_FILENAMES: NVIDIA_EGL });
  assert.deepEqual(savedGpuEnv({ env: {}, platform: 'win32', file }), {});
  assert.deepEqual(savedGpuEnv({ env: { CHROME_ARGS: '--use-angle=vulkan' }, platform: 'linux', file }), {});
  assert.deepEqual(savedGpuEnv({ env: {}, platform: 'linux', file: path.join(dir, 'none.json') }), {});
  await cleanup();
});
