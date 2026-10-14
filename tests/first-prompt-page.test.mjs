// The page says the session's real state, before and after the first idea is sent, in real Chrome on the dev server,
// with the session played by the real routes (no model): no session; the idea sent with none (nothing is being made);
// a terminal listener open; the idea handed to it and the session building with the kit's terminal commands; a request
// the session was reminded of once and still did not act on (stalled: the hook is quiet, the page says so); done.
// FIRST_PROMPT_SHOTS=<dir> saves a screenshot of each state.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from '../builder/lib/chrome.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { bridgeFor } from '../builder/server/routes/session.mjs';
import { tempDir } from './helpers.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}

describe('the first prompt: what the page says about the session', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, root, server, live;
  const shots = process.env.FIRST_PROMPT_SHOTS ? path.resolve(process.env.FIRST_PROMPT_SHOTS) : null;
  before(async () => {
    const found = findChrome();
    for (const o of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch {} }
    root = await tempDir('gamesfun-first-');
    await mkdir(path.join(root.dir, 'games'), { recursive: true });
    server = await startDevServer({ gamesRoot: path.join(root.dir, 'games'), port: 0, log: () => {}, watch: false });
    live = bridgeFor(server.url);
    if (shots) await mkdir(shots, { recursive: true });
  });
  after(async () => { await browser?.close(); await live?.close(); await server?.close(); await root?.cleanup(); });

  const api = async (method, p, body) => {
    const r = await fetch(new URL(`/api/session/${p}`, server.url), { method, headers: { 'x-gamesfun-token': live.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  /** The terminal listener, as `gamesfun session wait` holds it. → { lines, close } */
  async function listener(id) {
    const ac = new AbortController();
    const res = await fetch(new URL(`/api/session/wait?form=listener&session=${id}&agent=claude-code&cwd=${encodeURIComponent(root.dir)}`, server.url), { headers: { 'x-gamesfun-token': live.token }, signal: ac.signal });
    const l = { lines: [], close: () => ac.abort() };
    (async () => { try { let buf = ''; for await (const c of res.body) { buf += Buffer.from(c).toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const x = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (x) l.lines.push(JSON.parse(x)); } } } catch {} })();
    return l;
  }
  const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
  const snap = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const text = (page, sel) => page.locator(sel).first().textContent();

  it('none → sent with none → listening → handed and building with the terminal → done; and a stalled request', async t => {
    if (!browser) return t.skip('no browser');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}studio/`);
    // 1. nobody listens: the start page says so, and the one step needs no reload
    await page.waitForFunction(() => document.querySelector('[data-part="session"]')?.dataset.state === 'none');
    const none = await text(page, '[data-part="session"]');
    assert.match(none, /No session is listening yet/);
    assert.match(none, /session wait/);
    assert.doesNotMatch(none, /reload-plugins and say hi/);
    await snap(page, '1-start-no-session');

    // 2. the idea sent with nobody listening: saved, nothing is being made, and the page says what is left
    await page.locator('#start-input').fill('Make a game where users can dance by pressing the X key at the perfect time.');
    await page.locator('#start-go').click();
    await page.waitForFunction(() => document.documentElement.dataset.view === 'making');
    await page.waitForFunction(() => document.querySelector('#product-empty h2')?.textContent === 'Waiting for your session');
    assert.match(await text(page, '#product-empty p'), /nothing is being made yet/);
    await page.waitForFunction(() => document.querySelector('.conn[data-state="none"]'));
    assert.match(await text(page, '.conn[data-state="none"] strong'), /Nothing is being made yet: no session is listening/);
    const q0 = await api('GET', 'queue');
    assert.equal(q0.requests[0].state, 'waiting');
    await snap(page, '2-idea-sent-no-session');

    // 3. the session's listener opens: the waiting idea is handed at once; the session holds it, so it is working
    const l = await listener('S-term');
    await until(() => l.lines.length);
    assert.equal(l.lines[0].requests[0].text.startsWith('Make a game where users can dance'), true);
    await api('POST', 'cli/tool-start', { session: 'S-term', agent: 'claude-code', tool: 'gamesfun_step_pitch', input: { game: 'games/x' } });
    await page.waitForFunction(() => document.querySelector('#product-empty h2')?.textContent === 'Making your game', null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.conn[data-state="working"]'));
    assert.match(await text(page, '[data-part="tools"]'), /terminal commands/);
    assert.match(await text(page, '.req-state'), /Your session is on it/);
    await snap(page, '3-handed-building-with-terminal');

    // 4. done: the session reports with a note; the page shows it, and says the session is not listening any more
    const rid = (await api('GET', 'queue')).requests[0].id;
    await api('POST', `request/${rid}/done`, { note: 'Made Dance Off: press X on the beat, the longer you dance the more tokens you get.' });
    await page.waitForFunction(() => /Done/.test(document.querySelector('[data-request]')?.textContent ?? ''));
    await page.waitForFunction(() => document.querySelector('.conn[data-state="idle"]'));
    assert.match(await text(page, '.conn[data-state="idle"] .small'), /not listening right now/);
    assert.match(await page.locator('#chat').textContent(), /Made Dance Off/);
    await page.waitForFunction(() => document.querySelector('#product-empty h2')?.textContent === 'Waiting for your session', null, { timeout: 60000 });
    await snap(page, '4-done-not-listening');

    // 5. listening again
    const l2 = await listener('S-term');
    await page.waitForFunction(() => !document.querySelector('.conn[data-state="idle"]'), null, { timeout: 60000 });
    await snap(page, '5-listening-again');
    l2.close(); l.close();

    // 6. a session with the plugin is handed a change, reminded once, still does nothing: stalled, and the hook is quiet
    const hook = (ev, extra = {}) => api('POST', `hook/${ev}`, { session_id: 'S-plug', cwd: root.dir, hook_event_name: ev, permission_mode: 'default', ...extra });
    await hook('SessionStart', { source: 'startup' });
    const r = await api('POST', 'request', { text: 'make the beat faster', session: 'S-plug' });
    await api('GET', 'requests?session=S-plug');
    assert.equal((await hook('Stop'))?.decision, 'block');
    assert.equal((await hook('Stop'))?.decision, undefined);
    assert.equal((await hook('Stop'))?.decision, undefined, 'no re-send loop');
    await page.waitForFunction(id => /Waiting for your session/.test(document.querySelector(`[data-request="${id}"]`)?.textContent ?? ''), r.id, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.conn[data-state="stalled"]'));
    assert.match(await text(page, '.conn[data-state="stalled"] .small'), /Type go in its terminal/);
    await page.waitForFunction(() => document.querySelector('#product-empty h2')?.textContent === 'Waiting for your session' && /has not started on it/.test(document.querySelector('#product-empty p')?.textContent ?? ''), null, { timeout: 60000 });
    await snap(page, '6-stalled-hook-quiet');
    await page.close();
  });
});
