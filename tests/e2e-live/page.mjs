// Test harness only (the end-to-end proof, tests/e2e-live/README.md): the person's hands on the real studio page.
// One real Chrome (the kit's Playwright, headless, never the person's own Chrome), one visit, a list of steps, a
// screenshot after each, and a line of JSON per step saying what the page showed.
//
//   node tests/e2e-live/page.mjs <studio base url> <shots dir> <step> [<step> …]
//
// Steps (each is one argument):
//   tab:<id>                 open a tab (session, build, …)
//   shot:<name>              screenshot the whole page as <name>.png
//   type:<text>              type the text into the Session tab's box, with real keys, and click "Send to your session"
//   states:<s1,s2,…>:<secs>  watch the newest request's row (the last one) until it has shown these states in this order
//                            (a screenshot at each new state: <prefix>-<state>.png); prints the times
//   permwait:<secs>          wait until a permission card is showing
//   perm:allow|deny:<secs>   wait for a permission card and click its Allow or Deny button
//   remove                   click Remove on the newest request (only a waiting one has the button)
//   rollback:<id>:<secs>     in the Build tab, click "Roll back to this" on the row of that checkpoint and accept
//   wait:<secs>              wait
//   build:<secs>             watch the Build tab's headline for that long, printing each change (a screenshot each)
//   prefix:<name>            the prefix of the screenshots that follow
// Exit code 1 when a step timed out.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../../builder/lib/chrome.mjs';

const [base, shotsDir, ...steps] = process.argv.slice(2);
await mkdir(shotsDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = o => console.log(JSON.stringify(o));
const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
let prefix = 'page', failed = false, n = 0;
const shot = async (name, settle = 400) => { await sleep(settle); const f = `${name}.png`; await page.screenshot({ path: path.join(shotsDir, f) }); return f; };
const tab = async id => { await page.click(`#tabs button[data-id="${id}"]`); await sleep(500); };
const banner = () => page.locator('.panel:not([hidden]) .conn').first().innerText().catch(() => null);
const rows = () => page.evaluate(() => [...document.querySelectorAll('.queue .req')].map(r => ({ state: r.dataset.state, label: r.querySelector('.req-state')?.innerText ?? '', text: r.querySelector('.req-text')?.innerText ?? '' })));
// what the preview's game says about itself (the kit's own test hook), so a change in the game is read from the game
const game = () => { const f = page.frames().find(x => x.parentFrame() === page.mainFrame()); return f ? f.evaluate(() => { const s = window.__game?.snapshot?.(); return s ? { phase: s.phase ?? null, title: document.title, rules: s.config?.rules ?? null } : { title: document.title }; }).catch(() => null) : null; };

try {
  await page.goto(`${base}/studio/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__gamesfunStudioTabs, null, { timeout: 20000 });
  await sleep(1500);
  for (const step of steps) {
    const [kind, ...rest] = step.split(':');
    const arg = rest.join(':');
    if (kind === 'prefix') { prefix = arg; continue; }
    if (kind === 'tab') { await tab(arg); say({ step, banner: await banner() }); continue; }
    if (kind === 'wait') { await sleep(Number(arg) * 1000); continue; }
    if (kind === 'shot') { say({ step, file: await shot(arg), title: await page.locator('#game-title').innerText(), banner: await banner(), game: await game() }); continue; }
    if (kind === 'type') {
      await tab('session');
      await page.click('textarea.ask');
      await page.keyboard.type(arg, { delay: 15 });
      const typed = await shot(`${prefix}-typed`);
      await page.click('button:has-text("Send to your session")');
      say({ step, typed, at: Date.now() });
      continue;
    }
    if (kind === 'states') {
      const want = rest[0].split(','), secs = Number(rest[1] ?? 120), t0 = Date.now(), seen = [];
      let i = 0;
      while (i < want.length && Date.now() - t0 < secs * 1000) {
        const r = (await rows()).at(-1);
        if (r && r.state !== seen.at(-1)?.state) {
          seen.push({ state: r.state, label: r.label.trim(), ms: Date.now() - t0, file: await shot(`${prefix}-${++n}-${r.state}`, 0) });
          if (r.state === want[i]) i++;
        }
        await sleep(40);
      }
      if (i < want.length) failed = true;
      say({ step, ok: i === want.length, seen, banner: await banner(), game: await game() });
      continue;
    }
    if (kind === 'remove') {   // the person takes a waiting request back
      const row = page.locator('.queue .req').last();
      const was = await row.getAttribute('data-state');
      await row.locator('button:has-text("Remove")').click({ timeout: 5000 });
      await sleep(800);
      say({ step, was, rows: await rows(), file: await shot(`${prefix}-removed`) });
      continue;
    }
    if (kind === 'permwait') {   // a permission card is up (nothing is clicked)
      await tab('session');
      try { await page.locator('.perm').first().waitFor({ timeout: Number(arg) * 1000 }); say({ step, ok: true, banner: await banner() }); }
      catch { failed = true; say({ step, ok: false }); }
      continue;
    }
    if (kind === 'perm') {
      const [decision, secs = '120'] = rest;
      await tab('session');
      const card = page.locator('.perm').first();
      try { await card.waitFor({ timeout: Number(secs) * 1000 }); } catch { failed = true; say({ step, ok: false, why: 'no permission card appeared' }); continue; }
      const asked = await card.innerText();
      const before = await shot(`${prefix}-asked`);
      await card.locator(`button:has-text("${decision === 'allow' ? 'Allow' : 'Deny'}")`).click();
      await sleep(1500);
      say({ step, ok: true, asked: asked.replace(/\s+/g, ' ').slice(0, 600), before, after: await shot(`${prefix}-${decision}`), toasts: await page.locator('#toasts').innerText().catch(() => '') });
      continue;
    }
    if (kind === 'rollback') {
      const [id, secs = '20'] = rest;
      await tab('build');
      const state = await (await fetch(`${base}/api/build/state`)).json();
      const c = state.checkpoints.find(x => x.id === id);
      if (!c) { failed = true; say({ step, ok: false, why: `no checkpoint ${id}`, have: state.checkpoints.map(x => x.id) }); continue; }
      const row = page.locator('.row', { hasText: c.label }).first();
      await row.waitFor({ timeout: Number(secs) * 1000 });
      const before = await shot(`${prefix}-before`);
      await row.locator('button:has-text("Roll back to this")').click();   // the confirm is accepted by the dialog handler
      await sleep(2500);
      say({ step, ok: true, label: c.label, before, after: await shot(`${prefix}-after`), toasts: await page.locator('#toasts').innerText().catch(() => ''), game: await game() });
      continue;
    }
    if (kind === 'build') {
      await tab('build');
      const t0 = Date.now(), seen = [];
      while (Date.now() - t0 < Number(arg) * 1000) {
        const head = (await banner())?.replace(/\s+/g, ' ').trim() ?? null;
        if (head && head !== seen.at(-1)?.head) seen.push({ head, ms: Date.now() - t0, file: await shot(`${prefix}-build-${++n}`) });
        await sleep(500);
      }
      say({ step, seen });
      continue;
    }
    throw new Error(`unknown step ${step}`);
  }
} catch (e) { failed = true; say({ error: e.message }); try { await shot(`${prefix}-error`); } catch { /* closed */ } }
finally { if (errors.length) say({ pageErrors: errors.slice(0, 8) }); await browser.close(); }
process.exit(failed ? 1 : 0);
