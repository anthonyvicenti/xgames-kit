// The three runtime's look at a pixel ratio other than 1 (gf/three/look/post.js). N8AO draws the scene itself; sized
// again at CSS pixels after the composer had sized it at the drawing buffer, it drew a shrunken second copy of the frame
// in the lower left whenever the ratio was under 1: the lofi kind's low-resolution picture, and any game the resolution
// governor turned down (kit/core/boot.js). The frame at each ratio is held to the frame at ratio 1 in the lower left,
// where the copy landed (a plain floor there in the reference). With the copy the cells there are 0.15 apart; without
// it, under 0.02.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startServer } from '../builder/look-judge/lib/server.mjs';
import { findChrome } from '../builder/lib/chrome.mjs';
import { VENDOR, repoFileOf, REPO } from '../builder/tools/lib/paths.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}
const chrome = findChrome();

test('the look keeps one whole picture at pixel ratios 1/2, 3/4 and 2', { skip: !(chromium && chrome) && 'no Chrome or playwright-core', timeout: 180000 }, async () => {
  const server = await startServer({
    '/kit/': rel => repoFileOf(`gf/three/${rel}`), '/vendor/three/': VENDOR.threeBuild, '/vendor/postprocessing/': VENDOR.postprocessing,
    '/vendor/n8ao/': VENDOR.n8ao, '/': join(REPO, 'tests/fixtures/look-post'),
  });
  // WebGL on the CPU (SwiftShader): no graphics card slot needed, and the copy shows there too
  const browser = await chromium.launch({ executablePath: chrome.path, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const grid = async ratio => {
      await page.goto(`${server.url}/index.html?ratio=${ratio}`);
      await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
      return page.evaluate(() => window.grid());
    };
    const ref = await grid(1);
    for (const ratio of [0.5, 0.75, 2]) {
      const g = await grid(ratio);
      let worst = { d: 0 };
      for (let y = 5; y < 9; y++) for (let x = 0; x < 8; x++) {
        const d = Math.abs(g[y][x] - ref[y][x]);
        if (d > worst.d) worst = { d, x, y };
      }
      assert.ok(worst.d < 0.06, `ratio ${ratio}: the lower left differs from the ratio-1 frame by ${worst.d.toFixed(3)} at cell (${worst.x}, ${worst.y}) (a second copy of the frame?)`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
