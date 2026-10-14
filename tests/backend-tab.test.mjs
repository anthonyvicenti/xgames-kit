// The studio's Backend tab in Chrome on core's dev server: with no backend it is one quiet line and one button; the
// Supabase panel; pasting a secret key is refused; pasting the URL and publishable key connects; removing it goes
// back to none. Nothing reaches Supabase (no session, no sign-in). BACKEND_SHOTS=<dir> saves a screenshot per state.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from '../builder/lib/chrome.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { tempDir, tempGame } from './helpers.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE_ROLE = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: 'service_role' })}.c2lnbmF0dXJlLW5vdC1jaGVja2VkLWhlcmU`;
const URL_ = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY = 'sb_publishable_AbCdEfGhIjKlMnOpQrSt';

describe('studio Backend tab in Chrome', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, server, game, page, cfg;
  const shots = process.env.BACKEND_SHOTS ? path.resolve(process.env.BACKEND_SHOTS) : null;
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false }); };
  const panel = () => page.locator('.panel:not([hidden])').filter({ hasText: /backend|Supabase/i }).last();

  before(async () => {
    const found = findChrome();
    for (const o of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch {} }
    if (!browser) return;
    cfg = await tempDir('gamesfun-backend-tab-');
    process.env.GAMESFUN_CONFIG_DIR = cfg.dir;
    process.env.GAMESFUN_SECRET_STORE = 'file';
    game = await tempGame('soak-squad');
    server = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('dialog', d => d.accept());
    await page.goto(`${server.url}studio/`);
  });
  after(async () => { await browser?.close(); await server?.close(); await game?.cleanup(); await cfg?.cleanup(); });

  it('is a Launch tool of the layout: after Publish, before Economy (Economy stays last)', async t => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Backend' }).waitFor();
    const tabs = await page.locator('#tabs [role="tab"]').evaluateAll(bs => bs.map(b => ({ id: b.dataset.id, group: b.dataset.group })));
    const at = id => tabs.findIndex(x => x.id === id);
    assert.equal(tabs.find(x => x.id === 'backend')?.group, 'Launch', JSON.stringify(tabs));
    assert.ok(at('publish') < at('backend') && at('backend') < at('economy'), JSON.stringify(tabs));
    assert.equal(tabs.at(-1).id, 'economy');
    assert.equal(await page.locator('#tabs [data-id="backend"] svg.ico path').count(), 3, 'its own icon');
  });

  it('with no backend: one quiet line and one button', async t => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Backend' }).click();
    const add = page.getByRole('button', { name: 'Add a backend (optional)' });
    await add.waitFor();
    const text = await panel().innerText();
    assert.match(text, /no backend, and that is fine/);
    assert.ok(!/Connect Supabase|publishable/i.test(text), text);
    await shot('1-none');
  });

  it('choosing Supabase shows its panel: the one button (tests/backend-one-button-chrome.test.mjs), and the agent\'s way under "Other ways"', async t => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('button', { name: 'Add a backend (optional)' }).click();
    await shot('2-choose');
    await page.getByRole('button', { name: 'Use Supabase' }).click();
    // the one button is there; it is not pressed here (this test has no stand-in for games.fun or Supabase)
    await page.getByRole('button', { name: 'Connect Supabase' }).waitFor();
    // not pressed either: with no session it adds Supabase's MCP server to this machine's real agents
    await page.getByText('Other ways to connect').click();
    await page.getByRole('button', { name: 'Connect through your agent' }).waitFor();
    await shot('3-supabase');
  });

  it('a secret key is refused; the URL and publishable key connect; removing goes back to none', async t => {
    if (!browser) return t.skip('no browser');
    if (!(await page.getByText('Paste the URL and publishable key yourself').isVisible())) await page.getByText('Other ways to connect').click();
    await page.getByText('Paste the URL and publishable key yourself').click();
    await page.getByLabel('Project URL').fill(URL_);
    await page.getByLabel('Publishable key').fill(SERVICE_ROLE);
    await page.getByRole('button', { name: 'Use these' }).click();
    await page.getByText(/not public/).waitFor();
    await assert.rejects(stat(path.join(game.dir, 'backend.json')));
    await page.getByLabel('Publishable key').fill(KEY);
    await page.getByRole('button', { name: 'Use these' }).click();
    await page.getByText(/Supabase:/).first().waitFor();
    await page.getByText(/No secrets in the game/).waitFor();
    const written = JSON.parse(await readFile(path.join(game.dir, 'backend.json'), 'utf8'));
    assert.equal(written.key, KEY);
    // a table is asked for in the conversation's box, with the backend as its chip
    await page.getByRole('button', { name: 'Ask my session for a table' }).click();
    await page.locator('.chat-context-label', { hasText: 'Backend' }).waitFor();
    await shot('4-connected');
    if (shots) {
      await page.setViewportSize({ width: 390, height: 844 });
      await panel().scrollIntoViewIfNeeded();
      await shot('5-connected-phone');
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.getByRole('button', { name: 'Remove the backend from this game' }).click();
    await page.getByRole('button', { name: 'Add a backend (optional)' }).waitFor();
    await assert.rejects(stat(path.join(game.dir, 'backend.json')));
  });
});
