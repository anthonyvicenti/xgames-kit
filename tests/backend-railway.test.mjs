// `gamesfun backend connect railway`: the sign-in, the deploy and what reaches the game, against a stand-in for
// Railway (tests/stubs/railway-mock.mjs, shaped from Railway's docs). No Railway account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as B from '../builder/lib/backend/index.mjs';
import { PROVIDERS } from '../builder/lib/backend/providers.mjs';
import { connectGame } from '../builder/lib/backend/providers/railway.mjs';
import * as R from '../builder/lib/backend/railway.mjs';
import { getSecret, setSecret } from '../builder/lib/secret-store.mjs';
import { tempDir, tempGame } from './helpers.mjs';
import { freePort, startRailwayMock, untar } from './stubs/railway-mock.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = 'http://127.0.0.1:5180';

async function setup(t, mockOpts = {}) {
  const cfg = await tempDir('gf-railway-cfg-');
  const mock = await startRailwayMock(mockOpts);
  const env = { ...process.env, GAMESFUN_CONFIG_DIR: cfg.dir, GAMESFUN_SECRET_STORE: 'file', GAMESFUN_RAILWAY_BASE: mock.base, GAMESFUN_RAILWAY_CALLBACK_PORT: String(await freePort()), GAMESFUN_NO_OPEN: '1' };
  t.after(async () => { await mock.close(); await cfg.cleanup(); });
  return { env, mock, cfg };
}
// the person's browser: follows /start → Railway's consent (the stand-in approves) → the kit's callback
const browser = url => fetch(url).then(r => r.text());
const allFiles = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath ?? e.path, e.name));

test('the template packs as a .tar.gz the stand-in unpacks byte for byte, without data or .env files', () => {
  const { body, files } = R.packTemplate();
  assert.deepEqual(files, ['.railwayignore', 'LICENSE', 'README.md', 'package.json', 'railway.json', 'server.js']);
  const back = untar(gunzipSync(body));
  assert.deepEqual(back.map(f => f.name), files);
  for (const f of back) assert.ok(f.data.equals(readFileSync(path.join(R.TEMPLATE_DIR, f.name))), f.name);
});

test('the provider fits the shape of every backend provider: listed, a host, no key may ever be in its backend.json', async () => {
  const p = PROVIDERS.get('railway');
  assert.ok(p, 'lib/backend/providers/railway.mjs loads');
  assert.equal(p.kind, 'server');
  assert.equal(p.publicKey('sb_publishable_abc'), false);
  assert.ok(B.listed().some(x => x.id === 'railway' && x.panel === '/studio/tabs/backend/railway.js'));
  assert.deepEqual(B.config.validate({ version: 1, provider: 'railway', url: 'https://gs.up.railway.app', origins: ['https://gs.up.railway.app', 'wss://gs.up.railway.app'] }).provider, 'railway');
  assert.throws(() => B.config.validate({ version: 1, provider: 'railway', url: 'https://gs.up.railway.app', key: 'anything', origins: ['https://gs.up.railway.app'] }), /key/);
});

test('sign-in: its own client by dynamic registration, PKCE S256, the exact 127.0.0.1 callback, no secret; the token in a 0600 file', async t => {
  const { env, mock, cfg } = await setup(t);
  const r = await R.signIn({ env, open: browser });
  assert.equal(r.where.kind, 'file');
  const [client] = [...mock.state.clients.values()];
  assert.deepEqual(client.redirect_uris, [`http://127.0.0.1:${env.GAMESFUN_RAILWAY_CALLBACK_PORT}/callback`]);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.deepEqual(mock.state.tokenRequests, [{ grant: 'authorization_code', basic: false, secret: false }]);
  const tok = R.loadToken({ env });
  assert.ok(tok.access_token && tok.refresh_token, 'offline_access + prompt=consent gave a refresh token');
  const file = allFiles(cfg.dir).find(f => f.endsWith('railway-token.secret'));
  assert.ok(file, 'kept in the config folder, not in a game or the kit');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!file.startsWith(KIT));
  assert.deepEqual(await R.workspaces({ env }), [{ id: 'ws_play', name: 'Play' }]);
  // a second sign-in reuses this machine's client (once the first callback server has closed)
  await new Promise(r => setTimeout(r, 200));
  await R.signIn({ env, open: browser });
  assert.equal(mock.state.clients.size, 1);
});

test('a refused consent is a plain error, and nothing is saved', async t => {
  const { env } = await setup(t, { deny: true });
  await assert.rejects(R.signIn({ env, open: browser }), /Railway did not connect: The user denied access/);
  assert.equal(R.loadToken({ env }), null);
});

test('an expired access token is refreshed once, and the rotated refresh token is saved at once', async t => {
  const { env, mock } = await setup(t);
  await R.signIn({ env, open: browser });
  const before = R.loadToken({ env });
  setSecret('railway-token', JSON.stringify({ ...before, expires_at: Date.now() - 1000 }), { env });
  assert.equal((await R.workspaces({ env })).length, 1);
  const after = R.loadToken({ env });
  assert.notEqual(after.refresh_token, before.refresh_token);
  assert.ok(after.expires_at > Date.now());
  await R.workspaces({ env });
  assert.deepEqual(mock.state.tokenRequests.map(x => x.grant), ['authorization_code', 'refresh_token'], 'no second refresh, so the old one is never reused');
});

test('connect: project, service, volume, variables, upload, domain; the game gets only the public URL', async t => {
  const { env, mock, cfg } = await setup(t);
  const g = await tempGame();
  t.after(g.cleanup);
  await R.signIn({ env, open: browser });
  const steps = [];
  const r = await connectGame(g.dir, { workspaceId: 'ws_play', workspaceName: 'Play', name: 'soak-test' }, { env, origins: R.gameOrigins(), onStep: s => steps.push(s), waitEveryMs: 200 });
  const [svc] = [...mock.state.services.values()];
  const url = `http://127.0.0.1:${svc.appPort}`;
  const settings = JSON.parse(readFileSync(path.join(g.dir, 'backend.json'), 'utf8'));
  assert.deepEqual(settings, { version: 1, provider: 'railway', url, project: { ref: r.project.id, name: 'soak-test', region: null, organization: 'Play' }, origins: [url, url.replace('http', 'ws')], players: 'anonymous' });
  assert.equal(r.volume, true);
  assert.deepEqual(mock.state.volumes, [{ projectId: r.project.id, environmentId: [...mock.state.projects.values()][0].env.id, serviceId: svc.id, mountPath: '/data' }]);
  assert.deepEqual(mock.state.uploads[0].files, ['.railwayignore', 'LICENSE', 'README.md', 'package.json', 'railway.json', 'server.js']);
  assert.deepEqual(mock.state.domains, [{ serviceId: svc.id, domain: `127.0.0.1:${svc.appPort}`, targetPort: 8080 }]);

  // the server's variables: its secret and the exact origins are on "Railway", and the secret is nowhere else
  const vars = mock.state.variables.get(svc.id);
  assert.match(vars.GF_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(vars.GF_ORIGINS.split(',').includes('https://games-fun-play.vercel.app') && vars.GF_ORIGINS.split(',').includes(DEV));
  assert.equal(vars.GF_DATA_DIR, '/data');
  for (const f of [...allFiles(g.dir), ...allFiles(cfg.dir)]) assert.ok(!readFileSync(f).includes(vars.GF_SECRET), `the server secret leaked into ${f}`);
  assert.ok(!steps.join('\n').includes(vars.GF_SECRET));
  const tok = R.loadToken({ env });
  for (const f of allFiles(g.dir)) assert.ok(!readFileSync(f).includes(tok.access_token), `the Railway token leaked into ${f}`);

  // the kit's checks pass, the client is in the game, and the deployed template answers the game's origin
  const c = await B.check(g.dir);
  assert.ok(c.ok, JSON.stringify(c));
  assert.ok(readdirSync(path.join(g.dir, 'gf', 'backend')).includes('server.js'));
  const p = await (await fetch(`${url}/v1/players`, { method: 'POST', headers: { origin: DEV } })).json();
  const s = await fetch(`${url}/v1/scores/main`, { method: 'POST', headers: { origin: DEV, authorization: `Bearer ${p.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ score: 9, name: 'Test' }) });
  assert.deepEqual(await s.json(), { best: 9, rank: 1 });
  assert.equal((await fetch(`${url}/v1/players`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  // within a free plan's 100 API requests an hour, with room to spare
  assert.ok(mock.state.ops.length <= 20, `${mock.state.ops.length} GraphQL calls`);

  // again into the same project: no second service, a new secret
  await connectGame(g.dir, { projectId: r.project.id }, { env, origins: R.gameOrigins(), waitEveryMs: 200 });
  assert.equal(mock.state.services.size, 1);
  assert.notEqual(mock.state.variables.get(svc.id).GF_SECRET, vars.GF_SECRET);
});

test('refusals: a game holding a secret is refused before anything is made at Railway; a client secret or a foreign endpoint is refused', async t => {
  const { env, mock } = await setup(t);
  const g = await tempGame();
  t.after(g.cleanup);
  await R.signIn({ env, open: browser });
  const ops = mock.state.ops.length;
  writeFileSync(path.join(g.dir, '.env'), 'GF_SECRET=x\n');
  await assert.rejects(connectGame(g.dir, { workspaceId: 'ws_play', name: 'x' }, { env }), e => e.code === 'SECRET');
  assert.equal(mock.state.ops.length, ops, 'no Railway call was made');
  assert.equal(mock.state.projects.size, 0);

  const fake = body => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const disco = { authorization_endpoint: 'https://evil.example/oauth/auth', token_endpoint: `${mock.base}/oauth/token`, registration_endpoint: `${mock.base}/oauth/register`, code_challenge_methods_supported: ['S256'] };
  await assert.rejects(R.discover({ env, fetchImpl: fake(disco) }), /not on/);
  const env2 = { ...env, GAMESFUN_RAILWAY_CALLBACK_PORT: String(await freePort()) };
  const reg = async () => new Response(JSON.stringify({ client_id: 'c', client_secret: 's' }), { status: 201 });
  await assert.rejects(R.ensureClient({ env: env2, fetchImpl: reg, endpoints: { register: `${mock.base}/oauth/register` } }), /refuses it/);
  assert.throws(() => R.base({ GAMESFUN_RAILWAY_BASE: 'http://example.com' }), /https/);
});

test('disconnect: deletes the kit\'s client at Railway (every token ends) and forgets the sign-in', async t => {
  const { env, mock, cfg } = await setup(t);
  await R.signIn({ env, open: browser });
  const access = R.loadToken({ env }).access_token;
  const r = await R.disconnect({ env });
  assert.equal(r.removed, true);
  assert.equal(r.revoked, true);
  assert.equal(mock.state.clients.size, 0);
  assert.ok(mock.state.access.get(access).revoked);
  assert.equal(getSecret('railway-token', { env }), null);
  assert.equal(getSecret('railway-client', { env }), null);
  assert.deepEqual(allFiles(cfg.dir).filter(f => /railway/.test(f)), []);
  await assert.rejects(R.workspaces({ env }), e => e.code === 'NO_TOKEN');
  assert.deepEqual(R.status({ env }), { signedIn: null, client: null });
});

test('the CLI: gamesfun backend connect railway signs in through the printed link and connects the game', async t => {
  const { env, mock } = await setup(t);
  const g = await tempGame();
  t.after(g.cleanup);
  const child = spawn(process.execPath, [path.join(KIT, 'bin', 'gamesfun.mjs'), 'backend', 'connect', 'railway', g.dir, '--name', 'cli-test'], { env: { ...env, GAMESFUN_RAILWAY_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const opened = new Promise(resolve => child.stdout.on('data', d => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/start)/.exec(out); if (m) resolve(m[1]); }));
  child.stderr.on('data', d => { out += d; });
  const code = new Promise(resolve => child.on('exit', resolve));
  await browser(await opened);
  assert.equal(await code, 0, out);
  assert.match(out, /Connected .* to its own server: http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(JSON.parse(readFileSync(path.join(g.dir, 'backend.json'), 'utf8')).provider, 'railway');
  assert.equal(mock.state.projects.size, 1);
});
