// The whole publish path against a real, local games.fun Studio (never production): sign in from the kit in a browser,
// publish a game made from an example (its real verify --quick gates it), open its link and play it, update it to a
// second version at the same link, and sign out. Screenshots and a report go to --out.
//
//   GAMESFUN_STUDIO=http://localhost:6055 node tests/publish-e2e.mjs --out <dir> [--example coin-hop] [--keep <dir>]
//
// The Studio must run with dev sign-in on (games.fun's scripts/local-dev.sh, or the same env on another port) and its
// migrations applied (0018_kit_publish). The sign-in is kept in a throwaway config folder, never the person's own.
// On Linux run it under the graphics card (games.fun .claude/scripts/gpu-run.sh): verify needs WebGL.
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../builder/lib/create.mjs';
import { launchChrome } from '../builder/qa/browser.mjs';
import { login, logout, savedLogin, studioOrigin } from '../builder/lib/publish/client.mjs';
import { publishGame, preflight } from '../builder/lib/publish/index.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, example: { type: 'string', default: 'coin-hop' }, keep: { type: 'string' } } });
if (!values.out) { console.error('usage: GAMESFUN_STUDIO=http://localhost:6055 node tests/publish-e2e.mjs --out <dir> [--example coin-hop]'); process.exit(2); }
const origin = studioOrigin();
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { console.error(`Refusing: GAMESFUN_STUDIO must be a local Studio (got ${origin}). This test never runs against production.`); process.exit(2); }
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const work = values.keep ? path.resolve(values.keep) : await mkdtemp(path.join(os.tmpdir(), 'gamesfun-publish-e2e-'));
const env = { ...process.env, GAMESFUN_CONFIG_DIR: path.join(work, 'config'), GAMESFUN_CREDENTIALS: 'file' };
const report = { studio: origin, example: values.example, work, started: new Date().toISOString(), steps: [] };
const step = (name, data = {}) => { const s = { name, at: new Date().toISOString(), ...data }; report.steps.push(s); console.log(`- ${name}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`); return s; };
const save = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const b64u = s => Buffer.from(s).toString('base64url');
const anonKey = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ iss: 'supabase', ref: 'e2etestproject00', role: 'anon', iat: 1760000000, exp: 2075000000 }))}.${b64u('e2e-test-signature-not-a-real-key-000000')}`;

const browser = await launchChrome({ gpu: 'webgl' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const shot = async name => { const file = path.join(out, `${String(report.steps.length).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: file }); return path.basename(file); };
try {
  // 1. A game from the example, with a backend declared (a stand-in Supabase project) so its CSP can be checked.
  const dir = path.join(work, 'game');
  await createGame(dir, { from: values.example });
  // backend.json is what gamesfun backend connect writes; a stand-in project, public values only.
  await writeFile(path.join(dir, 'backend.json'), JSON.stringify({ version: 1, provider: 'supabase', url: 'https://e2etestproject00.supabase.co', key: anonKey, keyKind: 'anon', origins: ['https://e2etestproject00.supabase.co', 'wss://e2etestproject00.supabase.co'], players: 'anonymous' }, null, 2) + '\n');
  // The kit's manifest ignore list (builder/lib/manifest-ignore.json) names backend.json; the game's own assets.json says it too,
  // so a game made by an older kit also passes verify check 1 (which would count backend.json as an asset with no slot).
  const manifestFile = path.join(dir, 'assets.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (!(manifest.ignore ?? []).some(i => i.path === 'backend.json')) {
    manifest.ignore = [...(manifest.ignore ?? []), { path: 'backend.json', reason: 'the game\'s public backend settings (gamesfun backend), not a game asset' }];
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  }
  const pre = await preflight(dir, { origin });
  step('created', { dir, files: pre.built.tree.files.length, mb: +(pre.built.bytes / 1048576).toFixed(1), refused: pre.problems, secrets: pre.secrets, backend: pre.backend });

  // 2. Sign in: the kit opens games.fun; the "person" signs in (dev sign-in on a local Studio) and approves.
  const signed = await login({ origin, env, log: m => console.log(m), open: async url => {
    await page.goto(url);
    if (new URL(page.url()).pathname === '/signin') {
      step('sign-in page', { shot: await shot('signin') });
      await page.fill('#dev-email', 'kit-e2e@example.com');
      await page.getByRole('button', { name: 'Sign in locally' }).click();
      await page.waitForURL(u => new URL(u).pathname === '/kit/connect');
    }
    await page.getByTestId('kit-approve').waitFor();
    step('approve page', { shot: await shot('approve') });
    await page.getByTestId('kit-approve').click();
    await page.waitForURL(u => new URL(u).hostname === '127.0.0.1');
    await page.getByText('The kit is signed in').waitFor();
    step('callback page', { shot: await shot('callback') });
  } });
  step('signed in', { email: signed.email, store: signed.store, expiresAt: new Date(signed.expiresAt).toISOString() });
  await save();

  // 3. Publish: verify --quick runs (the gate), only new files go up, a link comes back.
  const t0 = Date.now();
  const first = await publishGame(dir, { origin, env, progress: l => console.log(`  ${l}`) });
  step('published v1', { seconds: Math.round((Date.now() - t0) / 1000), url: first.url, gameUrl: first.gameUrl, friendsUrl: first.friendsUrl, version: first.version, draft: first.draft, verify: first.verify, uploaded: first.uploaded, alreadyThere: first.alreadyThere, backend: first.backend });
  await save();
  if (!first.url) throw new Error(`v1 was not published: ${first.publishError ?? 'its checks did not pass'} ${JSON.stringify(first.verify.failed)}`);

  // 4. The game's own CSP names its backend, and nothing else new.
  const head = await fetch(first.gameUrl);
  step('game CSP', { status: head.status, csp: head.headers.get('content-security-policy') });

  // 5. Open the link signed out (a fresh context: a friend who got the link), and play.
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  friend.on('pageerror', e => errors.push(String(e.message)));
  friend.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // What one cold play of the link costs the play host: requests and bytes from it (the cost table's input).
  const load = { requests: 0, bytes: 0, playHostRequests: 0, playHostBytes: 0 };
  friend.on('requestfinished', async r => { try { const z = await r.sizes(); load.requests++; load.bytes += z.responseBodySize; if (new URL(r.url()).hostname.startsWith('play.')) { load.playHostRequests++; load.playHostBytes += z.responseBodySize; } } catch {} });
  await friend.goto(first.url);
  await friend.waitForTimeout(4000);
  const fshot = async name => { const file = path.join(out, `${String(report.steps.length).padStart(2, '0')}-${name}.png`); await friend.screenshot({ path: file }); return path.basename(file); };
  step('link opened (signed out)', { url: friend.url(), title: await friend.title(), shot: await fshot('link'), coldLoad: { ...load } });
  const frame = friend.frameLocator('iframe').first();
  const play = frame.getByRole('button', { name: /^Play$/ }).first();
  if (await play.count().catch(() => 0)) { await play.click(); await friend.waitForTimeout(1500); }
  await friend.locator('iframe').first().click({ position: { x: 640, y: 400 } }).catch(() => {});
  for (const k of ['KeyD', 'KeyD', 'Space', 'KeyD', 'Space', 'KeyD', 'KeyE']) { await friend.keyboard.down(k); await friend.waitForTimeout(350); await friend.keyboard.up(k); }
  step('played', { shot: await fshot('play'), consoleErrors: errors.slice(0, 10) });
  await save();

  // 6. Update: a change to the game, published again: version 2 at the same link, only the changed file uploaded.
  const gameCfgFile = path.join(dir, 'config', 'game.json');
  const gameCfg = JSON.parse(await readFile(gameCfgFile, 'utf8'));
  gameCfg.text = { ...(gameCfg.text ?? {}), goal: 'Version 2: grab every coin (published from the kit)' };
  await writeFile(gameCfgFile, JSON.stringify(gameCfg, null, 2) + '\n');
  const t1 = Date.now();
  const second = await publishGame(dir, { origin, env, progress: l => console.log(`  ${l}`) });
  step('published v2', { seconds: Math.round((Date.now() - t1) / 1000), url: second.url, version: second.version, sameLink: second.url === first.url, uploaded: second.uploaded, alreadyThere: second.alreadyThere, verify: second.verify });
  if (!second.url) throw new Error(`v2 was not published: ${second.publishError ?? 'its checks did not pass'} ${JSON.stringify(second.verify.failed)}`);
  const served = await (await fetch(new URL('config/game.json', second.gameUrl))).json();
  step('v2 served at the same link', { goal: served.text?.goal });
  await friend.goto(second.url); await friend.waitForTimeout(4000);
  step('link after update', { shot: await fshot('link-v2') });

  // 7. Sign out: the token is revoked, and publishing is refused until the next sign-in.
  const bye = await logout(origin, { env });
  step('signed out', { ...bye, stillSaved: Boolean(await savedLogin(origin, { env })) });
  report.ok = true;
} catch (e) {
  report.ok = false; report.error = e.message;
  step('failed', { error: e.message, shot: await shot('failed').catch(() => null) });
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await save();
  await browser.close();
}
