// The one button in Chrome (headless), on the kit's dev server, against stand-ins only: Supabase
// (tests/stubs/supabase-mock.mjs), games.fun's exchange route (tests/stubs/gamesfun-route-mock.mjs), Railway
// (tests/stubs/railway-mock.mjs) and Claude Code and Codex (tests/stubs/fake-agents.mjs, on a PATH and HOME of their own:
// this machine's agents are never found). The page opens the sign-in in a new tab, as for a person; the stand-in's
// consent approves at once, or refuses, or the tab is stopped. ONE_BUTTON_SHOTS=<dir> saves each step and error at
// 1440×900 and 390×844.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { findChrome } from '../builder/lib/chrome.mjs';
import { tempDir, tempGame } from './helpers.mjs';
import { fakeAgents } from './stubs/fake-agents.mjs';
import { startGamesfunRoute } from './stubs/gamesfun-route-mock.mjs';
import { freePort, startRailwayMock } from './stubs/railway-mock.mjs';

// how long a step may take to show on a loaded machine: each wait is for a state, never a measured time
const WAIT = 60000;
import { startSupabaseMock } from './stubs/supabase-mock.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}

describe('the Backend tab\'s one button in Chrome', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, context, page, server, game, cfg, supa, route, railway, agents, store, PORT, RPORT;
  const shots = process.env.ONE_BUTTON_SHOTS ? path.resolve(process.env.ONE_BUTTON_SHOTS) : null;
  const seen = [];
  const panel = () => page.locator('#panel-backend');
  const shot = async name => {
    seen.push(name);
    if (!shots) return;
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shots, `${name}-1440.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const target = panel().locator('.flow-question:not([hidden]), [data-testid=flow-error], [data-testid=flow-connected], ol.flow-steps:not([hidden]), .flow-go').first();
    if (await target.count()) await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: path.join(shots, `${name}-390.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), `${name}: no sideways scroll at 390`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  };
  const resetSupabase = list => {
    supa.state.projects.length = 0; supa.state.tables.clear(); supa.state.freeLimit = false; supa.state.deny = false; supa.state.migrationFail = null; supa.state.readyAfter = 2;
    return list.map(([n, r, s]) => supa.state.addProject(n, r ?? 'eu-central-1', s));
  };
  const signOut = () => store.deleteSecret('backend-supabase');
  const backToNone = async () => {
    for (const f of ['backend.json', 'gf/backend', 'supabase', '.mcp.json', '.gamesfun/agents-supabase.json']) await rm(path.join(game.dir, f), { recursive: true, force: true });
    await page.goto(`${server.url}studio/?r=${Date.now()}#backend`);
    await panel().getByRole('button', { name: 'Add a backend (optional)' }).waitFor();
  };
  const choose = async id => {
    await panel().getByRole('button', { name: 'Add a backend (optional)' }).click();
    await panel().getByRole('button', { name: `Use ${id}` }).click();
  };
  const question = kind => panel().locator(`.flow-question[data-kind=${kind}]:not([hidden])`);
  const connectedView = () => panel().getByRole('heading', { name: 'Your agents' });

  before(async () => {
    const found = findChrome();
    for (const o of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch {} }
    if (!browser) return;
    cfg = await tempDir('gf-one-button-chrome-');
    agents = await fakeAgents(path.join(cfg.dir, 'agents'));
    supa = await startSupabaseMock({ readyAfter: 2 });
    PORT = await freePort(); RPORT = await freePort();
    route = await startGamesfunRoute({ supabase: supa, callbackPort: PORT });
    railway = await startRailwayMock({});
    // the dev server runs here: its flows read these (no real Supabase, games.fun, Railway or agent is reachable)
    Object.assign(process.env, agents.env, {
      GAMESFUN_CONFIG_DIR: path.join(cfg.dir, 'config'), GAMESFUN_SECRET_STORE: 'file', GAMESFUN_SUPABASE_API: supa.url,
      GAMESFUN_STUDIO_URL: route.url, GAMESFUN_BACKEND_CALLBACK_PORT: String(PORT), GAMESFUN_SUPABASE_POLL_MS: '300',
      GAMESFUN_RAILWAY_BASE: railway.base, GAMESFUN_RAILWAY_CALLBACK_PORT: String(RPORT), GAMESFUN_RAILWAY_POLL_MS: '900', GAMESFUN_NO_OPEN: '1',
    });
    for (const k of ['GAMESFUN_BACKEND_CALLBACK_HOST', 'GAMESFUN_SUPABASE_BROKER', 'GAMESFUN_SUPABASE_CLIENT_ID', 'GAMESFUN_STUDIO']) delete process.env[k];
    store = await import('../builder/lib/secret-store.mjs');
    const { startDevServer } = await import('../builder/server/index.mjs');
    game = await tempGame('soak-squad');
    server = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // the sign-in tabs: each one follows the stand-in's consent back to the kit's callback, then closes
    page = await context.newPage();
    context.on('page', p => { if (p !== page) p.waitForURL(/\/callback\?/, { timeout: 60000 }).then(() => p.waitForTimeout(300)).catch(() => {}).then(() => p.close()).catch(() => {}); });
    page.on('dialog', d => d.accept());
    await page.goto(`${server.url}studio/?r=${Date.now()}#backend`);
  });
  // DEBUG_SHOTS=<dir>: the page after each test, whatever happened
  let nth = 0;
  afterEach(async () => { if (process.env.DEBUG_SHOTS && page) await page.screenshot({ path: path.join(process.env.DEBUG_SHOTS, `after-${++nth}.png`) }).catch(() => {}); });
  after(async () => {
    await browser?.close(); await server?.close(); await route?.close(); await supa?.close(); await railway?.close();
    await game?.cleanup(); await cfg?.cleanup();
  });

  it('Publish has the primary action beside the preview\'s bar; no backend is one quiet line', async t => {
    if (!browser) return t.skip('no browser');
    const act = page.locator('#product-actions [data-action=publish]');
    await act.waitFor();
    assert.equal((await act.innerText()).trim(), 'Publish');
    await panel().getByRole('button', { name: 'Add a backend (optional)' }).waitFor();
    await shot('00-no-backend');
    await act.click();
    await page.locator('#panel-publish:not([hidden])').waitFor();
    await page.goto(`${server.url}studio/?r=${Date.now()}#backend`);
  });

  it('no project: Connect Supabase → sign in → Make one → the clock → Connected, in both agents; Remove undoes it', async t => {
    if (!browser) return t.skip('no browser');
    resetSupabase([]);
    // the project stays "coming up" until the clock has been seen running, then is let through: what the test sees
    // never depends on how fast a loaded machine polls or draws (it used to be 20 polls, 6 s, against a 5 s wait)
    supa.state.readyAfter = Infinity;
    await choose('Supabase');
    assert.ok(await panel().getByRole('checkbox', { name: 'Add Supabase to my agents' }).isChecked(), 'ticked by default');
    await shot('01-supabase-panel');
    await panel().getByRole('button', { name: 'Connect Supabase' }).click();
    await question('create').waitFor({ timeout: WAIT });
    assert.match(await question('create').innerText(), /You have no Supabase project yet/);
    assert.equal(await panel().getByLabel('Region').inputValue(), 'group:emea');
    await shot('02-make-a-project');
    await panel().getByRole('button', { name: 'Make it' }).click();
    await panel().locator('li[data-step=ready][data-state=doing]').waitFor({ timeout: WAIT });
    await page.waitForFunction(() => /^0:0[1-9]$/.test(document.querySelector('#panel-backend li[data-step=ready] .clock')?.textContent ?? ''), null, { timeout: WAIT });
    await shot('03-waiting-with-clock');
    supa.state.readyAfter = 0;
    await connectedView().waitFor({ timeout: WAIT });
    await panel().locator('[data-testid=flow-connected]').waitFor();
    const text = await panel().innerText();
    assert.match(text, /Connected\.\s+.*\(games\.fun\)/);
    assert.match(text, /Open it in the Supabase dashboard/);
    assert.match(text, /Claude Code: Supabase's MCP server for this project, in .*\.mcp\.json \(project scope\)/);
    assert.match(text, /Codex: Supabase's MCP server for this project, in .*config\.toml \(user scope\)/);
    const cfgJson = JSON.parse(await readFile(path.join(game.dir, 'backend.json'), 'utf8'));
    assert.match(cfgJson.key, /^sb_publishable_/);
    assert.equal(JSON.parse(await readFile(path.join(game.dir, '.mcp.json'), 'utf8')).mcpServers.supabase.url, `https://mcp.supabase.com/mcp?project_ref=${cfgJson.project.ref}`);
    await shot('04-connected');
    await panel().getByRole('button', { name: 'Remove from my agents' }).click();
    await panel().getByText(/Claude Code: removed/).waitFor({ timeout: WAIT });
    await assert.rejects(stat(path.join(game.dir, '.mcp.json')));
    assert.doesNotMatch(await readFile(path.join(agents.codexHome, 'config.toml'), 'utf8'), /supabase/);
    await shot('05-removed-from-agents');
    await backToNone();
  });

  it('several projects: the picker; a paused one: Restore', async t => {
    if (!browser) return t.skip('no browser');
    await backToNone();
    const [, , sleepy] = resetSupabase([['alpha'], ['beta'], ['sleepy', 'us-east-1', 'INACTIVE']]);
    await choose('Supabase');
    await panel().getByRole('button', { name: 'Connect Supabase' }).click();
    await question('project').waitFor({ timeout: WAIT });
    assert.match(await panel().locator('li[data-step=sign-in]').innerText(), /Using your saved Supabase sign-in/);
    await shot('06-pick-a-project');
    await question('project').locator('.row', { hasText: 'sleepy' }).getByRole('button', { name: 'Restore and use' }).click();
    await question('paused').waitFor();
    assert.match(await question('paused').innerText(), /sleepy is paused \(free projects pause after a week with no use\)\. Restore it\?/);
    await shot('07-paused-restore');
    await question('paused').getByRole('button', { name: 'Restore it' }).click();
    await connectedView().waitFor({ timeout: WAIT });
    assert.equal(JSON.parse(await readFile(path.join(game.dir, 'backend.json'), 'utf8')).project.ref, sleepy.ref);
    await backToNone();
  });

  it('a full free plan: use an existing project, or the links', async t => {
    if (!browser) return t.skip('no browser');
    await backToNone();
    const [alpha] = resetSupabase([['alpha'], ['beta']]);
    await choose('Supabase');
    await panel().getByRole('checkbox', { name: 'Add Supabase to my agents' }).uncheck();
    await panel().getByRole('button', { name: 'Connect Supabase' }).click();
    await question('project').waitFor({ timeout: WAIT });
    await panel().getByRole('button', { name: 'Make a new project for this game' }).click();
    await question('full').waitFor();
    assert.match(await question('full').innerText(), /already has 2 active projects/);
    assert.equal(await question('full').getByRole('link', { name: 'Upgrade the organization' }).getAttribute('href'), 'https://supabase.com/dashboard/org/acme-games/billing');
    await shot('08-free-plan-full');
    await question('full').locator('.row', { hasText: 'alpha' }).getByRole('button', { name: 'Use' }).click();
    await connectedView().waitFor({ timeout: WAIT });
    assert.equal(JSON.parse(await readFile(path.join(game.dir, 'backend.json'), 'utf8')).project.ref, alpha.ref);
    assert.match(await panel().innerText(), /Add Supabase to my agents/, 'unticked: nothing added, the button offers it');
    await backToNone();
  });

  it('errors, each in words with the next step: not set up (→ the agent way), refused, stopped, port busy, offline, a refused table', async t => {
    if (!browser) return t.skip('no browser');
    await backToNone();
    resetSupabase([['alpha']]);
    signOut();
    const err = () => panel().locator('[data-testid=flow-error]');
    const connect = async () => { await panel().getByRole('button', { name: 'Connect Supabase' }).click(); };
    await choose('Supabase');
    // games.fun's route is not set up: the agent's way, one button, in the same panel
    route.state.mode = 'off';
    await connect();
    await err().waitFor({ timeout: WAIT });
    assert.match(await err().innerText(), /Not connected\.\s+One-button Supabase is not set up on .* yet\. You can connect through your agent instead/);
    await shot('09-not-set-up');
    await panel().getByRole('button', { name: 'Connect through your agent' }).first().click();
    await panel().getByText(/Claude Code: added\./).waitFor();
    await shot('10-through-your-agent');
    route.state.mode = 'ready';
    // the person refuses on Supabase's page
    supa.state.deny = true;
    await panel().getByRole('button', { name: 'Try again' }).click();
    await err().filter({ hasText: 'didn\'t allow' }).waitFor({ timeout: WAIT });
    assert.match(await err().innerText(), /You didn't allow games\.fun to reach your Supabase account\. Nothing was changed\./);
    await shot('11-consent-refused');
    supa.state.deny = false;
    // the sign-in tab never comes back: the question stays open; Cancel stops it
    await context.route(`http://127.0.0.1:${PORT}/start`, r => r.abort());
    await panel().getByRole('button', { name: 'Try again' }).click();
    await question('signing-in').waitFor({ timeout: WAIT });
    assert.match(await question('signing-in').innerText(), /Sign in to Supabase in the tab that opened/);
    await shot('12-signing-in');
    await question('signing-in').getByRole('button', { name: 'Cancel' }).click();
    await err().filter({ hasText: 'You stopped the sign-in' }).waitFor({ timeout: WAIT });
    await shot('13-stopped');
    // "Try localhost instead": a new tab with the other loopback name
    await panel().getByRole('button', { name: 'Try again' }).click();
    await question('signing-in').waitFor({ timeout: WAIT });
    await question('signing-in').getByRole('button', { name: 'Try localhost instead' }).click();
    await connectedView().waitFor({ timeout: WAIT });
    await context.unroute(`http://127.0.0.1:${PORT}/start`);
    await backToNone();
    signOut();
    // the port is taken
    await choose('Supabase');
    const busy = http.createServer().listen(PORT, '127.0.0.1');
    await new Promise(r => busy.once('listening', r));
    await connect();
    await err().waitFor({ timeout: WAIT });
    assert.match(await err().innerText(), new RegExp(`Something on this computer is using port ${PORT}\\. Close it and press Connect again\\.`));
    await shot('14-port-busy');
    await new Promise(r => busy.close(r));
    // games.fun cannot be reached
    process.env.GAMESFUN_STUDIO_URL = 'http://127.0.0.1:9';
    await panel().getByRole('button', { name: 'Try again' }).click();
    await err().filter({ hasText: 'Could not reach' }).waitFor({ timeout: WAIT });
    assert.match(await err().innerText(), /Could not reach 127\.0\.0\.1:9\. Check your internet connection, then press Connect again\./);
    await shot('15-offline');
    process.env.GAMESFUN_STUDIO_URL = route.url;
    // Supabase refuses a table (a new project: one that has the table already would not be sent it again)
    resetSupabase([['gamma']]);
    supa.state.migrationFail = 'ERROR:  42601: syntax error at or near "tabel"';
    await panel().getByRole('button', { name: 'Try again' }).click();
    await err().filter({ hasText: 'Supabase refused' }).waitFor({ timeout: WAIT });
    assert.match(await err().innerText(), /Supabase refused supabase\/migrations\/\d+_high_scores\.sql: ERROR: +42601/);
    assert.equal(await panel().locator('li[data-step=tables][data-state=failed]').count(), 1);
    await shot('16-table-refused');
    supa.state.migrationFail = null;
    await backToNone();
  });

  it('Railway: Connect Railway → sign in → the deploy\'s steps → Connected (the URL only)', async t => {
    if (!browser) return t.skip('no browser');
    await backToNone();
    await choose('Railway');
    await shot('17-railway-panel');
    await panel().getByRole('button', { name: 'Connect Railway' }).click();
    // the stand-in deploys in a moment: the deploy's own step is shot when it is caught under way
    const doing = panel().locator('li[data-step=deploy][data-state=doing]');
    await Promise.race([doing.waitFor({ timeout: WAIT }), panel().locator('[data-testid=flow-connected]').waitFor({ timeout: WAIT })]);
    if (await doing.count()) await shot('18-railway-deploying');
    await panel().locator('[data-testid=flow-connected]').filter({ hasText: /The game's server is up at/ }).waitFor({ timeout: WAIT });
    const s = JSON.parse(await readFile(path.join(game.dir, 'backend.json'), 'utf8'));
    assert.equal(s.provider, 'railway');
    assert.ok(!('key' in s));
    await shot('19-railway-connected');
  });
});
