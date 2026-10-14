// The whole path in a real browser (slow: about 4 minutes an example, needs Chrome or downloads Chromium). Runs when
// GAMESFUN_SMOKE=1, which `npm run test:smoke` sets (scripts/smoke.mjs); `npm test` skips it, and the CI workflow does
// not run it (CI verifies the examples through the CLI under its profile instead). For every example: create from it,
// quick verify through the CLI (it must pass), then the dev server with two pages that must each see the other player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BIN, EXAMPLES, KIT_ROOT } from '../builder/lib/paths.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { tempGame } from './helpers.mjs';
import { twoPlayers } from './two-players.mjs';

const on = process.env.GAMESFUN_SMOKE === '1';
const examples = (await readdir(EXAMPLES, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();

// one test per example (the standard-3d and flat-2d examples on WebGL, the scenic-3d one on WebGPU or WebGL2, the vista
// one on WebGPU only, so it fails on a machine without a hardware WebGPU adapter, and a forge one on WebGPU as its verify
// runs it). The verdict is verdict.json (builder/gates/verdict.schema.json): per gate what ran, passed and was skipped.
for (const id of examples) {
  test(`${id}: create from the example, quick verify passes, and two pages see each other`, { skip: on ? false : 'set GAMESFUN_SMOKE=1 to run (about 4 minutes an example)', timeout: 20 * 60 * 1000 }, async () => {
    const g = await tempGame(id);
    try {
      const code = await new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [BIN, 'verify', g.dir, '--quick'], { cwd: KIT_ROOT, stdio: 'inherit' });
        c.on('error', reject); c.on('close', resolve);
      });
      const runs = (await readdir(path.join(g.dir, 'evidence'))).filter(n => /^verify-\d+$/.test(n)).sort();
      const verdict = JSON.parse(await readFile(path.join(g.dir, 'evidence', runs.at(-1), 'verdict.json'), 'utf8'));
      // example.json → knownFailing: checks a kit fault fails today (the example's README says which and why). The
      // verdict must fail exactly those, so the entry is deleted the day the kit is fixed.
      const known = JSON.parse(await readFile(path.join(EXAMPLES, id, 'example.json'), 'utf8')).knownFailing ?? [];
      assert.equal(verdict.verdictVersion, 1);
      const failed = verdict.failed;
      assert.deepEqual(failed.filter(f => !known.includes(f.measure)).map(f => `${f.gate} ${f.measure}: ${f.detail ?? ''}`), [], 'no measure failed that is not a known kit fault');
      assert.deepEqual(known.filter(n => !failed.some(f => f.measure === n)), [], 'a known failing measure passes now: delete it from example.json → knownFailing');
      assert.equal(verdict.pass, known.length === 0);
      assert.equal(code, known.length ? 1 : 0);

      const srv = await startDevServer({ gameDir: g.dir, port: 0, log: () => {}, watch: false });
      try {
        // a vista game draws only with WebGPU (no WebGL path), and verify runs a forge game on WebGPU (its WebGL2 build is
        // for browsers without one): their two pages open in the kit's WebGPU launch
        const runtime = JSON.parse(await readFile(path.join(EXAMPLES, id, 'spec.json'), 'utf8')).runtime;
        const r = await twoPlayers(srv.url, { seconds: 8, gpu: ['vista', 'forge'].includes(runtime) ? 'webgpu' : null });
        assert.equal(r.ok, true, JSON.stringify(r));
      } finally { await srv.close(); }
    } finally { await g.cleanup(); }
  });
}
