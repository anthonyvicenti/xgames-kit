// The studio's Publish tab against a local games.fun Studio (never production): open the tab signed out, sign in with
// its button (games.fun opens in a new tab; the "person" signs in there and allows the kit), then press Publish, and
// screenshot each step. The sign-in is kept in a throwaway config folder.
//
//   GAMESFUN_STUDIO=http://localhost:6055 node tests/publish-tab-shots.mjs <game dir> --out <dir> [--port 6052]
import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchChrome } from '../builder/qa/browser.mjs';
import { BIN } from '../builder/lib/paths.mjs';
import { studioOrigin } from '../builder/lib/publish/client.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, port: { type: 'string', default: '6052' } } });
const origin = studioOrigin();
if (!positionals[0] || !values.out || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { console.error('usage: GAMESFUN_STUDIO=http://localhost:<port> node tests/publish-tab-shots.mjs <game dir> --out <dir>'); process.exit(2); }
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const config = await mkdtemp(path.join(os.tmpdir(), 'gamesfun-tab-config-'));
const env = { ...process.env, GAMESFUN_CONFIG_DIR: config, GAMESFUN_CREDENTIALS: 'file', GAMESFUN_NO_OPEN: '1' };
const dev = spawn(process.execPath, [BIN, 'dev', path.resolve(positionals[0]), '--port', values.port, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
dev.stdout.on('data', d => process.stdout.write(`[dev] ${d}`)); dev.stderr.on('data', d => process.stdout.write(`[dev] ${d}`));
const base = `http://127.0.0.1:${values.port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/dev/status`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

const report = { studio: origin, steps: [] };
const browser = await launchChrome({ gpu: 'webgl' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
let n = 0;
const shot = async (p, name) => { const file = `${String(++n).padStart(2, '0')}-${name}.png`; await p.screenshot({ path: path.join(out, file) }); report.steps.push({ name, file }); console.log(`- ${name}`); };
try {
  await page.goto(`${base}/studio/`);
  await page.locator('#tab-publish').click();
  await page.locator('#panel-publish .conn').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, 'tab-signed-out');
  const popup = context.waitForEvent('page');
  await page.locator('#panel-publish button', { hasText: 'Sign in to games.fun' }).click();
  const gf = await popup;
  await gf.waitForURL(u => new URL(u).pathname === '/signin' || new URL(u).pathname === '/kit/connect');
  if (new URL(gf.url()).pathname === '/signin') { await gf.fill('#dev-email', 'kit-e2e@example.com'); await gf.getByRole('button', { name: 'Sign in locally' }).click(); }
  await gf.getByTestId('kit-approve').waitFor();
  await shot(gf, 'games-fun-approve');
  await gf.getByTestId('kit-approve').click();
  await gf.getByText('The kit is signed in').waitFor();
  await gf.close();
  await page.locator('#panel-publish .conn', { hasText: 'Signed in' }).waitFor({ timeout: 20000 });
  await shot(page, 'tab-signed-in');
  await page.locator('#panel-publish [data-testid="publish-run"]').click();
  await page.locator('#panel-publish [data-testid="publish-result"]').first().waitFor({ timeout: 10 * 60 * 1000 });
  await page.waitForTimeout(500);
  await shot(page, 'tab-published');
  report.result = await (await fetch(`${base}/api/publish/status`)).json().then(s => ({ known: s.known, result: s.run.result && { url: s.run.result.url, version: s.run.result.version, uploaded: s.run.result.uploaded, alreadyThere: s.run.result.alreadyThere, draft: s.run.result.draft }, error: s.run.error }));
  await page.request.post(`${base}/api/publish/logout`, { headers: { origin: base } }).catch(() => {});
  report.ok = true;
} catch (e) {
  report.ok = false; report.error = e.message; await shot(page, 'failed').catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  dev.kill();
}
