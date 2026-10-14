// Every studio tab at three screen sizes, on dev servers that are already running (`npx gamesfun dev <game> --port N`),
// in real Chrome. The design pass's proof: what each tab looks like, and whether a phone scrolls sideways.
// Run through the graphics-card gate (the preview is the game, which needs WebGL):
//   gpu-run.sh node tests/studio-design-shots.mjs <out dir> <name>=<studio url> [<name>=<studio url> …]
// Writes <out>/<size>/<name>-<NN>-<tab>.jpg, <out>/shots.json (each shot, its page width, sideways scroll, page
// errors) and <out>/contact-<size>.jpg (every shot of one size on one sheet).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBrowser } from '../builder/lib/chrome.mjs';

const [outArg, ...games] = process.argv.slice(2);
if (!outArg || !games.length) { console.error('usage: studio-design-shots.mjs <out dir> <name>=<studio url> …'); process.exit(2); }
const out = path.resolve(outArg);
const ALL_SIZES = [['4k', 3840, 2160], ['laptop', 1440, 900], ['phone', 390, 844]];
// SHOT_SIZES=laptop,phone and SHOT_TABS=items,map narrow a run while you work; a proof run sets neither
const SIZES = ALL_SIZES.filter(([n]) => !process.env.SHOT_SIZES || process.env.SHOT_SIZES.split(',').includes(n));
const onlyTabs = process.env.SHOT_TABS ? new Set(process.env.SHOT_TABS.split(',')) : null;
const scheme = process.env.SHOT_SCHEME || 'light';          // the OS setting the page sees (the creator's desktop is light)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
const shots = [];
try {
  for (const [size, w, h] of SIZES) {
    await mkdir(path.join(out, size), { recursive: true });
    for (const g of games) {
      const [name, url] = g.split(/=(.*)/s);
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: scheme });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      if (process.env.SHOT_THEME) await p.addInitScript(t => { try { localStorage.setItem('gamesfun.theme', t); } catch {} }, process.env.SHOT_THEME);
      await p.goto(url, { waitUntil: 'load' });
      await p.waitForSelector('#tabs [role=tab]', { timeout: 20000 });
      await sleep(5000);                                        // the game in the preview loads its models
      const tabs = await p.$$eval('#tabs [role=tab]', els => els.map(e => ({ id: e.dataset.id, label: e.textContent.trim() })));
      let n = 0;
      for (const t of tabs) {
        n++;
        if (onlyTabs && !onlyTabs.has(t.id)) continue;
        errors.length = 0;
        await p.click(`#tabs [role=tab][data-id="${t.id}"]`);
        await sleep(1800);
        const file = path.join(size, `${name}-${String(n).padStart(2, '0')}-${t.id}.jpg`);
        const width = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        await p.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 86, fullPage: size === 'phone' });
        shots.push({ file, size, game: name, tab: t.id, label: t.label, scrollWidth: width[0], innerWidth: width[1], sideways: width[0] > width[1], errors: [...errors] });
        console.log(`${file}\t${width[0] > width[1] ? `SIDEWAYS ${width[0]} > ${width[1]}` : 'ok'}${errors.length ? `\terrors: ${errors.join(' | ')}` : ''}`);
      }
      await ctx.close();
    }
  }
  await writeFile(path.join(out, 'shots.json'), JSON.stringify({ scheme, at: new Date().toISOString(), shots }, null, 1));
  // the contact sheets: one per size, every game's tabs in a row
  for (const [size] of SIZES) {
    const list = shots.filter(s => s.size === size);
    const cols = Math.min(5, Math.max(1, ...games.map(g => list.filter(s => s.game === g.split('=')[0]).length)));
    const cell = size === 'phone' ? 220 : 520;
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0a0c16;color:#f4f4f5;font:13px Arial,sans-serif;padding:12px}
      .g{display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:10px;margin-bottom:18px}figure{margin:0}img{width:${cell}px;display:block;border:1px solid #343b50;${size === 'phone' ? 'max-height:900px;object-fit:cover;object-position:top' : ''}}
      figcaption{padding:4px 0}h2{font-size:15px;margin:4px 0 8px}</style><h1 style="font-size:18px">${size} · ${new Date().toISOString().slice(0, 10)}</h1>
      ${games.map(g => { const name = g.split('=')[0]; return `<h2>${name}</h2><div class="g">${list.filter(s => s.game === name).map(s => `<figure><img src="${pathToFileURL(path.join(out, s.file)).href}"><figcaption>${s.label}${s.sideways ? ' · SIDEWAYS' : ''}</figcaption></figure>`).join('')}</div>`; }).join('')}`;
    const f = path.join(out, `contact-${size}.html`);
    await writeFile(f, html);
    const p = await browser.newPage({ viewport: { width: cols * (cell + 10) + 24, height: 800 } });
    await p.goto(pathToFileURL(f).href); await sleep(800);
    await p.screenshot({ path: path.join(out, `contact-${size}.jpg`), type: 'jpeg', quality: 85, fullPage: true });
    await p.close();
  }
  const sideways = shots.filter(s => s.sideways), errs = shots.filter(s => s.errors.length);
  console.log(`${shots.length} shots; sideways scroll: ${sideways.length ? sideways.map(s => s.file).join(', ') : 'none'}; page errors: ${errs.length}`);
} finally { await browser.close(); }
