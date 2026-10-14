// The backend part (builder/lib/backend/, builder/commands/backend.mjs, builder/server/routes/backend.mjs): the secret store, the secret scan,
// backend.json, the row-level-security checker, the provider registry, and the kit's own Supabase sign-in against a
// mock of Supabase's OAuth server and Management API (tests/stubs/supabase-mock.mjs; nothing reaches supabase.com).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BIN, KIT_ROOT } from '../builder/lib/paths.mjs';
import { tempDir } from './helpers.mjs';
import { startSupabaseMock } from './stubs/supabase-mock.mjs';
import { freePort } from './stubs/railway-mock.mjs';

const t0 = await tempDir('gamesfun-backend-');
const CONFIG = path.join(t0.dir, 'config');
process.env.GAMESFUN_CONFIG_DIR = CONFIG;
process.env.GAMESFUN_SECRET_STORE = 'file';
let mock, CB;   // CB: the sign-in callback port, a free one of this run's own (it was a fixed 6062)
const B = await import('../builder/lib/backend/index.mjs');
const S = await import('../builder/lib/backend/supabase.mjs');
const store = await import('../builder/lib/secret-store.mjs');
const rls = await import('../builder/lib/backend/rls.mjs');
const { scanText, scanGame } = await import('../builder/lib/backend/scan.mjs');
const { validate } = await import('../builder/lib/backend/config.mjs');

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = role => `eyJhbGciOiJIUzI1NiJ9.${b64({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role })}.c2lnbmF0dXJlLW5vdC1jaGVja2VkLWhlcmU`;
const SECRET_FIXTURE = ['sb', 'secret', 'Q2h1bmt5U2VjcmV0S2V5MDEyMzQ1'].join('_');   // split so this file never holds the shape

/** A minimal game folder (what resolveGame and addKitIgnores need). */
async function fakeGame(name = 'g') {
  const dir = path.join(t0.dir, 'games', `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>g</title>');
  await writeFile(path.join(dir, 'gf-three.json'), '{}');
  await writeFile(path.join(dir, 'assets.json'), JSON.stringify({ version: 1, slots: [], ignore: [] }, null, 2) + '\n');
  await writeFile(path.join(dir, 'rules.js'), 'export default {};\n');
  return dir;
}
const envWith = extra => ({ ...process.env, ...extra });

before(async () => { mock = await startSupabaseMock({ readyAfter: 2 }); CB = await freePort(); });
after(async () => { await mock?.close(); await t0.cleanup(); });

// ---------------------------------------------------------------- the secret store
test('the file store keeps a secret in a 0600 file under the config folder, and forgets it', async () => {
  const where = store.setSecret('test-one', 'value-1');
  assert.equal(where.kind, 'file');
  assert.equal(store.getSecret('test-one'), 'value-1');
  const files = await readdir(path.join(CONFIG, 'secrets'));
  assert.ok(files.includes('test-one.secret'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(CONFIG, 'secrets', 'test-one.secret'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(CONFIG, 'secrets'))).mode & 0o777, 0o700);
  }
  assert.equal(store.deleteSecret('test-one'), true);
  assert.equal(store.getSecret('test-one'), null);
  assert.throws(() => store.setSecret('../escape', 'x'), /bad secret name/);
});

test('the config folder is per system', () => {
  assert.match(store.configDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, home: 'C:\\Users\\a' }), /AppData.Roaming.gamesfun$/);
  assert.equal(store.configDir({ platform: 'darwin', env: {}, home: '/Users/a' }), path.join('/Users/a', 'Library', 'Application Support', 'gamesfun'));
  assert.equal(store.configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, home: '/home/a' }), path.join('/x', 'gamesfun'));
});

// ---------------------------------------------------------------- the secret scan
test('the scan names Supabase secrets and passes the public keys', () => {
  const kinds = text => scanText('f.js', text).map(h => h.kind);
  assert.deepEqual(kinds(`const k = "${JWT('anon')}"; const p = "sb_publishable_AbCdEfGhIjKlMnOp";`), []);
  assert.match(kinds(`x = "${JWT('service_role')}"`).join(), /service-role/);
  assert.match(kinds(`x = "${JWT('authenticated')}"`).join(), /not the public anon key/);
  assert.match(kinds(`x = "${SECRET_FIXTURE}"`).join(), /sb_secret_/);
  assert.match(kinds(`x = "${'sbp_' + '0123456789abcdef'.repeat(2)}"`).join(), /sbp_/);
  assert.match(kinds(['postgres://postgres', 'hunter2pass@db.abc.supabase.co:5432/postgres'].join(':')).join(), /connection string/);
});

test('scanGame flags a .env file and a service-role key, and passes a clean game', async () => {
  const dir = await fakeGame('scan');
  assert.equal((await scanGame(dir)).ok, true);
  await writeFile(path.join(dir, '.env'), 'X=1\n');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'db.js'), `export const key = "${JWT('service_role')}";\n`);
  const s = await scanGame(dir);
  assert.equal(s.ok, false);
  assert.deepEqual(s.hits.map(h => h.file).sort(), ['.env', 'src/db.js']);
});

// ---------------------------------------------------------------- backend.json
test('backend.json takes only public values and exact origins', () => {
  const good = { version: 1, provider: 'supabase', url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_publishable_AbCdEfGhIjKlMnOp', origins: ['https://abcdefghijklmnopqrst.supabase.co', 'wss://abcdefghijklmnopqrst.supabase.co'] };
  assert.equal(validate(good).players, 'anonymous');
  assert.throws(() => validate({ ...good, key: JWT('service_role') }), /not a key Supabase designed to be public/);
  assert.throws(() => validate({ ...good, key: SECRET_FIXTURE }), /never/);
  assert.throws(() => validate({ ...good, origins: ['https://*.supabase.co'] }), /wildcard/);
  assert.throws(() => validate({ ...good, url: 'http://example.com' }), /not an origin/);
  assert.throws(() => validate({ ...good, provider: 'nope' }), /provider must be one of/);
  assert.throws(() => validate({ ...good, extra: 1 }), /unknown fields/);
  assert.equal(validate({ ...good, url: 'http://127.0.0.1:6060', origins: ['http://127.0.0.1:6060'] }).url, 'http://127.0.0.1:6060');
});

// ---------------------------------------------------------------- row-level security
const examples = path.join(KIT_ROOT, 'skills', 'gamesfun-backend', 'references');
test('the skill\'s examples pass the checker', async () => {
  const files = await Promise.all(['high-scores.sql', 'saved-progress.sql'].map(async f => ({ file: f, sql: await readFile(path.join(examples, f), 'utf8') })));
  const v = rls.judge(rls.analyse(files), { used: ['high_scores', 'progress'] });
  assert.equal(v.ok, true, v.refused.join('\n'));
  assert.deepEqual(v.warned, []);
  assert.deepEqual(v.tables.map(t => [t.name, t.rls, t.policies]), [['high_scores', true, 2], ['progress', true, 3]]);
});

test('the checker refuses what would open the database', () => {
  const j = (sql, used = []) => rls.judge(rls.analyse([{ file: 'm.sql', sql }]), { used });
  assert.match(j('create table scores (id int);').refused.join(), /public\.scores .* no row-level security/);
  assert.match(j('create table "Public"."X" (id int);').refused.join(), /^$/, 'a table outside public is not exposed');
  assert.match(j('create table s (id int); alter table s enable row level security; alter table s disable row level security;').refused.join(), /turns row-level security off|no row-level security/);
  assert.match(j('create view v as select 1;').refused.join(), /security_invoker/);
  assert.equal(j('create view v with (security_invoker = true) as select 1;').ok, true);
  assert.match(j('create materialized view mv as select 1;').refused.join(), /materialized/);
  assert.match(j('', ['scores']).refused.join(), /reads table "scores"/);
  assert.match(j("create function public.f() returns int language sql security definer as $$ select 1 $$;").refused.join(), /security definer/);
  assert.equal(j("create function public.f() returns int language sql security definer set search_path = '' as $$ select 1 $$;").ok, true);
  const w = j('create table s (id int); alter table s enable row level security; create policy p on s for update to anon using (true);');
  assert.equal(w.ok, true);
  assert.match(w.warned.join(), /every player change every row/);
  assert.match(j('create table s (id int); alter table s enable row level security;').warned.join(), /no policy/);
  // comments, strings and function bodies never count as statements
  assert.equal(j("-- create table hidden (id int);\n/* create table hidden2 (id int); */ select 'create table x (id int);'; create function public.g() returns void language plpgsql security invoker as $fn$ begin create table inside (id int); end $fn$;").ok, true);
});

test('the live check reads Postgres\' own view', () => {
  const v = rls.judgeLive([{ name: 'high_scores', kind: 'r', rls: true, policies: 2 }, { name: 'open_table', kind: 'r', rls: false, policies: 0 }, { name: 'v', kind: 'v', invoker: false }], { used: ['high_scores', 'gone'] });
  assert.equal(v.ok, false);
  assert.equal(v.refused.length, 3);
});

// ---------------------------------------------------------------- the provider registry
test('every provider file has the shape lib/backend/providers.mjs names', async () => {
  const { PROVIDERS } = await import('../builder/lib/backend/providers.mjs');
  assert.ok(PROVIDERS.has('supabase'));
  for (const p of PROVIDERS.values()) {
    for (const k of ['id', 'label', 'kind', 'about']) assert.equal(typeof p[k], 'string', `${p.id}.${k}`);
    for (const k of ['publicKey', 'settings', 'status', 'disconnect', 'agentSteps']) assert.equal(typeof p[k], 'function', `${p.id}.${k}`);
    assert.ok(['database', 'server'].includes(p.kind));
    if (p.panel) await stat(path.join(KIT_ROOT, 'builder', ...p.panel.replace(/^\//, '').split('/')));   // the studio is served from builder/studio
    const a = p.agentSteps();
    assert.ok(Array.isArray(a.steps) && a.steps.length && typeof a.request('g') === 'string');
  }
});

// ---------------------------------------------------------------- use: the agent's way writes only public values
test('use writes backend.json and the client, and refuses a secret key or a dirty game', async () => {
  const dir = await fakeGame('use');
  const url = 'https://abcdefghijklmnopqrst.supabase.co';
  await assert.rejects(B.use(dir, { url, key: JWT('service_role') }), /not public/);
  const r = await B.use(dir, { url, key: 'sb_publishable_AbCdEfGhIjKlMnOp' });
  assert.deepEqual(r.settings.origins, [url, 'wss://abcdefghijklmnopqrst.supabase.co']);
  assert.equal(r.settings.project.ref, 'abcdefghijklmnopqrst');
  await stat(path.join(dir, 'gf', 'backend', 'index.js'));
  const assets = JSON.parse(await readFile(path.join(dir, 'assets.json'), 'utf8'));
  assert.ok(assets.ignore.some(e => e.path === 'backend.json') && assets.ignore.some(e => e.path === 'supabase/**'));
  await writeFile(path.join(dir, 'leak.js'), `const k = "${SECRET_FIXTURE}";\n`);
  await assert.rejects(B.use(dir, { url, key: 'sb_publishable_AbCdEfGhIjKlMnOp' }), /never be in a game/);
});

// ---------------------------------------------------------------- the kit's own sign-in, against the mock
const mockEnv = extra => ({ ...process.env, GAMESFUN_SUPABASE_API: mock.url, GAMESFUN_BACKEND_CALLBACK_PORT: String(CB), GAMESFUN_BACKEND_CALLBACK_HOST: '127.0.0.1', ...extra });
/** The person's browser: open the localhost start link and follow the redirects to the callback. */
const browser = async url => { const r = await fetch(url); return { status: r.status, text: await r.text() }; };

test('OAuth with the person\'s own app: PKCE, a checked state, the token kept outside the game, a project created and connected', async () => {
  const env = mockEnv();
  S.saveOwnApp(mock.state.clientId, mock.state.clientSecret, { env });
  let page;
  const r = await S.signIn({ env, open: async url => { assert.equal(url, `http://127.0.0.1:${CB}/start`); page = await browser(url); } });
  assert.match(page.text, /Connected/);
  assert.equal(r.token.kind, 'oauth');
  const saved = JSON.parse(store.getSecret('backend-supabase', { env }));
  assert.match(saved.access_token, /^sbp_oauth_/);

  const dir = await fakeGame('oauth');
  const c = await B.connectWithKit(dir, { create: { name: 'my-game', org: 'acme-games', region: 'eu-central-1' }, anonymous: true }, { env, everyMs: 5 });
  assert.equal(c.created, true);
  assert.equal(c.settings.keyKind, 'publishable');
  assert.match(c.settings.key, /^sb_publishable_/);
  assert.equal(c.dbPass, mock.state.lastDbPass);
  assert.equal(S.dbPassword(c.project.ref, { env }), c.dbPass);
  assert.deepEqual(mock.state.authConfig.get(c.project.ref), { external_anonymous_users_enabled: true });
  // nothing secret reached the game; the kit never asked for revealed keys
  const all = (await readFile(path.join(dir, 'backend.json'), 'utf8')) + JSON.stringify(await scanGame(dir));
  assert.ok(!all.includes(c.dbPass) && !all.includes('service_role') && !all.includes('sb_secret'));
  assert.equal((await scanGame(dir)).ok, true);
  assert.ok(!mock.state.requests.some(q => /reveal=true/.test(q.query)));
  assert.ok(mock.state.requests.some(q => q.path.endsWith('/health')), 'polled the project\'s health before writing');

  // the live check goes through the read-only query
  mock.state.liveRows = [{ name: 'high_scores', kind: 'r', rls: false, policies: 0 }];
  const live = await B.checkLive(dir, { env });
  assert.equal(live.ok, false);
  assert.equal(mock.state.queries.at(-1).readOnly, true);
  mock.state.liveRows = null;

  // an expired token is refreshed with the refresh token
  store.setSecret('backend-supabase', JSON.stringify({ ...saved, expires_at: Date.now() - 1000 }), { env });
  const t = await S.token({ env });
  assert.notEqual(t.access_token, saved.access_token);

  // disconnect revokes at Supabase and forgets it here
  const d = await S.disconnect({ env, forgetApp: true });
  assert.deepEqual([d.removed, d.revoked], [true, true]);
  assert.equal(S.loadToken({ env }), null);
  assert.equal(S.app({ env }), null);
});

test('OAuth through games.fun\'s exchange (the broker holds the secret, the kit never does)', async () => {
  const env = mockEnv({ GAMESFUN_SUPABASE_CLIENT_ID: mock.state.clientId, GAMESFUN_SUPABASE_BROKER: `${mock.url}/broker` });
  assert.equal(S.app({ env }).via, 'broker');
  await S.signIn({ env, open: browser });
  const dir = await fakeGame('broker');
  const existing = mock.state.projects[0].ref;
  const c = await B.connectWithKit(dir, { project: existing }, { env, everyMs: 5 });
  assert.equal(c.created, false);
  assert.equal(c.settings.project.ref, existing);
  assert.equal((await S.disconnect({ env })).revoked, true);
});

test('a refused consent, a wrong state and a busy port are said plainly', async () => {
  const env = mockEnv();
  S.saveOwnApp(mock.state.clientId, mock.state.clientSecret, { env });
  mock.state.deny = true;
  await assert.rejects(S.signIn({ env, open: browser }), /did not connect: The user denied access/);
  mock.state.deny = false;
  await assert.rejects(S.signIn({ env, timeoutMs: 400, open: async url => { const r = await fetch(url.replace('/start', '/callback?code=x&state=forged')); assert.equal(r.status, 400); } }), /not finished/);
  const http = await import('node:http');
  const busy = http.createServer().listen(CB, '127.0.0.1');
  await new Promise(r => busy.once('listening', r));
  await assert.rejects(S.signIn({ env, open: browser }), new RegExp(`no free port for the sign-in callback \\(tried ${CB}\\)`));
  await new Promise(r => busy.close(r));
  await S.disconnect({ env, forgetApp: true });
});

test('with no OAuth app set up, the kit points to the agent\'s way and the token', async () => {
  const env = mockEnv();
  await S.disconnect({ env, forgetApp: true });
  await assert.rejects(S.signIn({ env }), /The usual way needs none: npx gamesfun backend connect supabase/);
});

test('a pasted personal access token is checked, kept, used and forgotten', async () => {
  const env = mockEnv();
  const pat = 'sbp_' + 'a1'.repeat(20);
  await assert.rejects(S.savePat(pat, { env }), /401/);
  mock.state.pats.add(pat);
  await S.savePat(pat, { env });
  const orgs = await S.organizations({ env });
  assert.equal(orgs[0].slug, 'acme-games');
  const d = await S.disconnect({ env });
  assert.match(d.note, /stays valid at Supabase/);
});

test('a paused project is said plainly', async () => {
  const env = mockEnv();
  const pat = 'sbp_' + 'b2'.repeat(20);
  mock.state.pats.add(pat);
  await S.savePat(pat, { env });
  const p = mock.state.addProject('sleepy', 'us-east-1', 'INACTIVE');
  await assert.rejects(S.waitReady(p.ref, { env, everyMs: 5 }), /paused .* Restore/);
  await S.disconnect({ env });
});

// ---------------------------------------------------------------- the command
const cli = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: KIT_ROOT, env: envWith({ GAMESFUN_NO_UPDATE_CHECK: '1', ...opts.env }), input: opts.input });

test('gamesfun backend: the agent\'s way (--agent; the one button is the default: tests/backend-one-button.test.mjs), use, check, and the exit codes', async () => {
  const steps = JSON.parse(cli(['backend', 'connect', 'supabase', '--agent', '--json']).stdout);
  assert.equal(steps.way, 'mcp');
  assert.equal(steps.url, 'https://mcp.supabase.com/mcp');
  const dir = await fakeGame('cli');
  let r = cli(['backend', 'check', dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /none \(this game has no backend\)/);
  r = cli(['backend', 'use', 'supabase', dir, '--url', 'https://abcdefghijklmnopqrst.supabase.co', '--key', JWT('service_role')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not public/);
  r = cli(['backend', 'use', 'supabase', dir, '--url', 'https://abcdefghijklmnopqrst.supabase.co', '--key', 'sb_publishable_AbCdEfGhIjKlMnOp']);
  assert.equal(r.status, 0, r.stderr);
  await writeFile(path.join(dir, 'rules.js'), "export default { results(ctx) { ctx.db.from('high_scores'); } };\n");
  r = cli(['backend', 'check', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /reads table "high_scores"/);
  await mkdir(path.join(dir, 'supabase', 'migrations'), { recursive: true });
  await writeFile(path.join(dir, 'supabase', 'migrations', '20261012000000_high_scores.sql'), await readFile(path.join(examples, 'high-scores.sql'), 'utf8'));
  r = cli(['backend', 'check', dir]);
  assert.equal(r.status, 0, r.stdout);
  r = cli(['backend', 'check', dir, '--rows', '-'], { input: JSON.stringify([{ name: 'high_scores', kind: 'r', rls: false, policies: 0 }]) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the project itself: REFUSED/);
  r = cli(['backend', 'password', 'abcdefghijklmnopqrst']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only in your own terminal/);
});
