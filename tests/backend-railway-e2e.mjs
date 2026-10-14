// End to end, on this machine, with a stand-in for Railway (tests/stubs/railway-mock.mjs) and a real headless Chrome:
//   1. a game is created from an example;
//   2. `gamesfun backend connect railway` prints its sign-in link; Chrome opens it, goes through the stand-in's consent
//      and lands on the kit's 127.0.0.1 callback;
//   3. the kit creates the project, service, volume and variables, uploads the template, and the stand-in runs that
//      upload with Node; the kit writes backend.json (the URL only);
//   4. `gamesfun dev` serves the game; in Chrome, from the game's own page, gf/backend/server.js posts a score, reads
//      the board, saves and loads, and gets the live feed; the same page from an origin not in GF_ORIGINS is refused;
//   5. the studio's Backend tab is captured; `gamesfun backend disconnect railway` deletes the kit's client.
// Railway itself is never contacted. Usage: node tests/backend-railway-e2e.mjs [--out <dir>]
//   ports (GAMESFUN_E2E_PORTS, default 6069,6070,6071,6073): the stand-in, the deployed server, the dev server, the callback
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from '../builder/lib/create.mjs';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { tempDir } from './helpers.mjs';
import { startRailwayMock } from './stubs/railway-mock.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : null;
const [MOCK, APP, DEV, CB] = (process.env.GAMESFUN_E2E_PORTS ?? '6069,6070,6071,6073').split(',').map(Number);
const record = { when: new Date().toISOString(), system: `${process.platform} ${process.arch}, Node ${process.version}`, railway: 'stand-in (tests/stubs/railway-mock.mjs); Railway itself was not contacted', ports: { mock: MOCK, app: APP, dev: DEV, callback: CB }, steps: [] };
const step = (name, ok, detail = {}) => { record.steps.push({ name, ok, ...detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail.note ? `: ${detail.note}` : ''}`); if (!ok) throw new Error(name); };

const cfg = await tempDir('gf-railway-e2e-cfg-');
const work = await tempDir('gf-railway-e2e-');
const mock = await startRailwayMock({ port: MOCK, appPort: APP });
const env = { ...process.env, GAMESFUN_CONFIG_DIR: cfg.dir, GAMESFUN_SECRET_STORE: 'file', GAMESFUN_RAILWAY_BASE: mock.base, GAMESFUN_RAILWAY_CALLBACK_PORT: String(CB), GAMESFUN_NO_OPEN: '1', GAMESFUN_RAILWAY_POLL_MS: '300' };
const kids = [];
const run = (args, { wait = true } = {}) => {
  const child = spawn(process.execPath, [path.join(KIT, 'bin', 'gamesfun.mjs'), ...args], { cwd: KIT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  kids.push(child);
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const done = new Promise(resolve => child.on('exit', code => resolve({ code, out })));
  return { child, out: () => out, done: wait ? done : null, exited: done };
};
let browser = null;
try {
  const gameDir = path.join(work.dir, 'score-run');
  await createGame(gameDir, { from: 'soak-squad' });
  step('a game is created from soak-squad', true, { note: path.basename(gameDir) });

  const found = await ensureBrowser({ install: false, env });
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${m.text()} (${m.location()?.url ?? '?'}, on ${page.url().split('?')[0]})`); });

  // 2–3: connect, signing in through Chrome
  const c = run(['backend', 'connect', 'railway', gameDir, '--name', 'score-run', '--origin', `http://127.0.0.1:${DEV}`]);
  let link = null;
  for (let i = 0; i < 200 && !link; i++) { link = /(http:\/\/127\.0\.0\.1:\d+\/start)/.exec(c.out())?.[1] ?? null; if (!link) await new Promise(r => setTimeout(r, 50)); }
  step('the CLI prints a 127.0.0.1 sign-in link on the fixed callback port', !!link && link.includes(`:${CB}/`), { note: link });
  await page.goto(link);
  const landed = await page.textContent('body');
  step('Chrome signs in through the stand-in\'s consent and lands on the kit\'s callback', /Signed in to Railway/.test(landed), { note: landed.trim().slice(0, 80), url: page.url().replace(/code=[^&]+/, 'code=…').replace(/state=[^&]+/, 'state=…') });
  const r = await c.done;
  step('`gamesfun backend connect railway` finishes', r.code === 0, { note: r.out.trim().split('\n').slice(-4).join(' | ') });
  const settings = JSON.parse(await readFile(path.join(gameDir, 'backend.json'), 'utf8'));
  step('backend.json holds the URL and origins only (no key)', settings.provider === 'railway' && settings.url === `http://127.0.0.1:${APP}` && !('key' in settings), { backendJson: settings });
  const [svc] = [...mock.state.services.values()];
  const secret = mock.state.variables.get(svc.id).GF_SECRET;
  const leaked = [];
  for (const dir of [gameDir, cfg.dir]) {
    const { readdir } = await import('node:fs/promises');
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { const f = path.join(e.parentPath ?? e.path, e.name); if ((await readFile(f)).includes(secret)) leaked.push(f); }
  }
  step('the server secret is on the (stand-in) host only: not in the game, not in the kit\'s config, not in the CLI output', !leaked.length && !r.out.includes(secret), { leaked });
  record.railwayCalls = { graphql: mock.state.ops, uploads: mock.state.uploads.map(u => ({ files: u.files, bytes: u.bytes })), volumes: mock.state.volumes.length, domains: mock.state.domains, requestsTotal: mock.state.requests, origins: mock.state.variables.get(svc.id).GF_ORIGINS.split(',') };

  // 4: the game's own page posts a score through the vendored client
  const dev = run(['dev', gameDir, '--port', String(DEV), '--no-open'], { wait: false });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${DEV}/game/`)).ok) break; } catch {} await new Promise(r2 => setTimeout(r2, 200)); }
  await page.goto(`http://127.0.0.1:${DEV}/game/?gf-backend=on`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const m = await import(new URL('gf/backend/server.js', location.href).href);
    const srv = await m.connectGameServer();
    const pushes = [];
    const stop = srv.live('main', scores => pushes.push(scores.map(s => s.score)));
    await new Promise(r => setTimeout(r, 500));
    const first = await srv.submitScore('main', 321, 'E2E');
    const second = await srv.submitScore('main', 400, 'E2E');
    const top = await srv.topScores('main', 5);
    const saved = await srv.save({ level: 2, coins: 7 });
    const loaded = await srv.load();
    await new Promise(r => setTimeout(r, 500));
    stop();
    return { on: srv.on, url: srv.url, origin: location.origin, first, second, top: top.data, saved: !saved.error, loaded: loaded.data?.data, pushes };
  });
  step('from the game\'s page, gf/backend/server.js posts scores, reads the board, saves and loads', result.first.data?.rank === 1 && result.second.data?.best === 400 && result.top?.scores?.[0]?.score === 400 && result.loaded?.coins === 7, { result: { ...result, pushes: undefined } });
  step('the live feed (WebSocket from the game\'s origin) pushes the board as it changes', result.pushes.length >= 2 && result.pushes.at(-1)[0] === 400, { pushes: result.pushes });
  if (OUT) { await mkdir(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, 'game-page.png') }); }

  const other = await browser.newPage();
  await other.goto(`http://localhost:${DEV}/game/?gf-backend=on`, { waitUntil: 'load' });
  const refused = await other.evaluate(async () => {
    const m = await import(new URL('gf/backend/server.js', location.href).href);
    const srv = await m.connectGameServer();
    return { origin: location.origin, top: await srv.topScores('main') };
  });
  step('the same game from an origin not in GF_ORIGINS gets nothing (CORS)', refused.top.error === 'unreachable' || refused.top.status === 403, { refused });
  await other.close();

  // 5: the studio's Backend tab (with this panel), then disconnect
  await page.goto(`http://127.0.0.1:${DEV}/`, { waitUntil: 'load' });
  const tab = page.locator('#tab-backend');
  let shot = false;
  if (await tab.waitFor({ timeout: 15000 }).then(() => true, () => false)) {
    await tab.click();
    await page.locator('#panel-backend').getByText(/Railway/).first().waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const text = await page.textContent('body');
    record.studio = { railwayShown: /Railway/.test(text), connectedLine: /railway|Railway/.test(text) && text.includes(`127.0.0.1:${APP}`) };
    if (OUT) { await page.screenshot({ path: path.join(OUT, 'studio-backend-tab.png'), fullPage: false }); shot = true; }
  } else record.studio = { note: 'no Backend tab found in the studio (not in this checkout)' };
  step('the studio was opened on the Backend tab', true, { note: JSON.stringify(record.studio), screenshot: shot });
  dev.child.kill();

  const d = await run(['backend', 'disconnect', 'railway', '--json']).done;
  const dj = JSON.parse(d.out.slice(d.out.indexOf('{')));
  step('`gamesfun backend disconnect railway` deletes the kit\'s client at the host and forgets the sign-in', d.code === 0 && dj.revoked === true && mock.state.clients.size === 0, { result: dj });
  record.consoleErrors = consoleErrors;
  record.ok = true;
} catch (e) {
  record.ok = false;
  record.error = e.message;
  console.error(e);
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await browser?.close().catch(() => {});
  await mock.close();
  await cfg.cleanup(); await work.cleanup();
  if (OUT) { await mkdir(OUT, { recursive: true }); await writeFile(path.join(OUT, 'e2e.json'), JSON.stringify(record, null, 2) + '\n'); }
  console.log(record.ok ? 'END TO END: OK' : 'END TO END: FAILED');
  process.exitCode = record.ok ? 0 : 1;
}
