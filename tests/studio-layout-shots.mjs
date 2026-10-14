// Pictures of the studio page showing the creation loop, for a person to look at: the same two games as
// tests/studio-layout.test.mjs (one being made with the cards waiting, one delivered), at 1280x800 and 3840x2160, with
// the loop panel as it opens and with every section open, plus a phone. Checks nothing; prints what it measured.
// Run through the graphics-card gate:  gpu-run.sh node tests/studio-layout-shots.mjs <out dir>
// Writes <out>/<size>-<NN>-<view>.png and <out>/shots.json.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { layoutWorld, measure, SIZES } from './stubs/studio-layout.mjs';

const out = path.resolve(process.argv[2] ?? 'layout-shots');
await mkdir(out, { recursive: true });
const world = await layoutWorld();
const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
const shots = [];
try {
  for (const [size, w, h] of [...SIZES, ['phone', 390, 844]]) {
    let n = 0;
    const shot = async (p, view, full = false) => {
      const file = `${size}-${String(++n).padStart(2, '0')}-${view}.png`;
      await p.screenshot({ path: path.join(out, file), fullPage: full });
      const m = await measure(p);
      shots.push({ file, size, view, sideways: m.sideways, overflow: m.sections.filter(s => s.overflow).map(s => s.id), stages: m.stages, current: m.current, panelIn: m.panelIn });
      console.log(`${file}\t${m.sideways ? 'SIDEWAYS' : 'ok'}\t${m.panelIn ?? '-'}\t${m.sections.filter(s => s.overflow).map(s => `OVERFLOW ${s.id}`).join(' ')}`);
    };
    for (const [name, sel] of [['gate-making', '#product-empty [data-part=loop-panel]'], ['gate-delivered', '#chat [data-part=loop-panel]']]) {
      await world.open(name);
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      await p.goto(`${world.base}/studio/`);
      await p.waitForSelector(sel, { timeout: 60000 });
      await p.waitForTimeout(name === 'gate-delivered' ? 6000 : 1500);
      await shot(p, `${name}`, size === 'phone');
      for (const s of await p.$$('details.loop-sec:not([open]) > summary')) await s.click();
      await p.waitForTimeout(500);
      // the panel scrolled into view, every section open
      await p.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);
      await shot(p, `${name}-open`, size === 'phone');
      await ctx.close();
    }
  }
  await writeFile(path.join(out, 'shots.json'), JSON.stringify({ at: new Date().toISOString(), shots }, null, 1) + '\n');
} finally {
  await browser.close();
  await world.close();
}
