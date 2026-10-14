#!/usr/bin/env node
// npm run test:smoke: the smoke tests (tests/smoke.test.mjs), with GAMESFUN_SMOKE=1 set here so they run instead of
// skipping. A Node script rather than `GAMESFUN_SMOKE=1 node …` in package.json, which Windows' shell cannot read.
// Slow (about 4 minutes an example) and needs Chrome or Edge, or downloads Chromium once. Extra arguments go to node --test.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const c = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), path.join('tests', 'smoke.test.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, GAMESFUN_SMOKE: '1' }, windowsHide: true });
c.on('close', code => { process.exitCode = code ?? 1; });
