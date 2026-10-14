// Publishing to games.fun from the kit (builder/lib/publish/, builder/lib/credentials.mjs, commands login/logout/publish): what may be
// published (the same cases games.fun's own scan runs: tests/fixtures/publish-scan-cases.json), the file tree, where
// the sign-in is kept, the check gate, and the sign-in flow against a stand-in games.fun. The whole path against a real
// local Studio is tests/publish-e2e.mjs (not part of `npm test`: it needs a games.fun checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { tempDir } from './helpers.mjs';
import { scanFile, backendOrigin, secretsMessage } from '../builder/lib/publish/scan.mjs';
import { buildTree, KIT_LOCK, canonical, sha256 } from '../builder/lib/publish/tree.mjs';
import { configDir, saveSecret, loadSecret, deleteSecret, listEntries, credentialsFile } from '../builder/lib/credentials.mjs';
import { gate, readGate } from '../builder/lib/publish/gate.mjs';
import { login, logout, savedLogin, studioOrigin, challengeFor } from '../builder/lib/publish/client.mjs';
import { preflight, publishGame } from '../builder/lib/publish/index.mjs';
import { openCommand } from '../builder/lib/open.mjs';

const CASES = JSON.parse(readFileSync(new URL('./fixtures/publish-scan-cases.json', import.meta.url), 'utf8'));
const b64u = s => Buffer.from(s).toString('base64url');
const jwt = role => `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iss: 'supabase', ref: 'abcdefgh', ...(role === null ? {} : { role }), iat: 1700000000, exp: 2000000000 }))}.${b64u('signature-bytes-for-a-test-only-0123456789')}`;
const join = parts => parts.map(p => (typeof p === 'string' ? p : jwt(p.jwt))).join('');

test('scan: the cases games.fun runs too (anon and publishable keys pass; service-role, secret keys, tokens, key files refuse)', () => {
  for (const c of CASES.cases) assert.equal(scanFile(c.path, new TextEncoder().encode(join(c.text))).length > 0, c.refused, c.name);
  for (const o of CASES.origins) { let got = null; try { got = backendOrigin(o.value); } catch {} assert.equal(got, o.ok, o.value); }
  assert.match(secretsMessage([{ path: 'a.js', line: 3, kind: 'x' }]), /a\.js:3 \(x\)/);
});

async function fakeGame(root, extra = {}) {
  const dir = path.join(root, 'game');
  const files = {
    'index.html': '<!doctype html><script src="main.js"></script>', 'main.js': 'console.log(1)', 'assets.json': '{}', 'gf-three.json': JSON.stringify({ kit: { version: '0.1.0', runtime: 'three', profile: 'standard-3d' } }),
    'spec.json': JSON.stringify({ title: 'Coin Hop', prompt: 'hop for coins with friends', hook: 'Hop!', mechanics: [{ id: 'collect', as: 'coins' }] }),
    'evidence/verify-1/verdict.json': '{}', '.gitignore': 'node_modules/', '.gamesfun/publish.json': '{}', 'node_modules/x/index.js': '', 'gf/mp/index.html': '<!doctype html>', ...extra,
  };
  for (const [p, t] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, p)), { recursive: true }); await writeFile(path.join(dir, p), t); }
  return dir;
}

test('tree: evidence/, hidden files and node_modules are left out; .env refuses; the two records are added with a fixed lock', async () => {
  const t = await tempDir();
  try {
    const dir = await fakeGame(t.dir, { 'config/.env.local': 'A=1' });
    const b = await buildTree(dir);
    const paths = b.tree.files.map(f => f.path);
    assert.deepEqual(paths, ['adaptation-plan.json', 'assets.json', 'foundation.lock.json', 'gf-three.json', 'gf/mp/index.html', 'index.html', 'main.js', 'spec.json']);
    assert.deepEqual(b.added, ['foundation.lock.json', 'adaptation-plan.json']);
    assert.deepEqual(b.refused.map(r => r.path), ['config/.env.local']);
    assert.ok(b.skipped.includes('.gitignore') && b.skipped.includes('.gamesfun/') && b.skipped.includes('evidence/') && b.skipped.includes('node_modules/'));
    const lock = JSON.parse(String(await b.sources.get(b.tree.files.find(f => f.path === 'foundation.lock.json').sha256).data));
    assert.deepEqual(lock, KIT_LOCK, 'the same lock every time, so an update keeps it');
    const again = await buildTree(dir);
    assert.equal(again.fingerprint, b.fingerprint);
    await writeFile(path.join(dir, 'main.js'), 'console.log(2)');
    assert.notEqual((await buildTree(dir)).fingerprint, b.fingerprint);
    await writeFile(path.join(dir, 'evidence', 'verify-1', 'verdict.json'), '{"x":1}');
    assert.equal((await buildTree(dir)).fingerprint, (await buildTree(dir)).fingerprint, 'evidence does not change what is published');
    assert.equal(sha256(canonical({ b: 1, a: 2 })), sha256('{"a":2,"b":1}'));
  } finally { await t.cleanup(); }
});

test('credentials: the config folder per system; a file only the person can read; never in the game', async () => {
  assert.equal(configDir({ env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\a' }), path.join('C:\\Users\\a\\AppData\\Roaming', 'gamesfun'));
  assert.equal(configDir({ env: {}, platform: 'darwin', home: '/Users/a' }), path.join('/Users/a', 'Library', 'Application Support', 'gamesfun'));
  assert.equal(configDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', home: '/home/a' }), path.join('/x', 'gamesfun'));
  assert.equal(configDir({ env: {}, platform: 'linux', home: '/home/a' }), path.join('/home/a', '.config', 'gamesfun'));
  const t = await tempDir();
  try {
    const env = { GAMESFUN_CONFIG_DIR: t.dir, GAMESFUN_CREDENTIALS: 'file' };
    const r = await saveSecret('games.fun https://x.test', 'gfk_secret', { email: 'a@b.c' }, { env });
    assert.equal(r.store, 'file');
    if (process.platform !== 'win32') assert.equal((await stat(credentialsFile({ env }))).mode & 0o777, 0o600);
    assert.equal((await loadSecret('games.fun https://x.test', { env })).secret, 'gfk_secret');
    assert.deepEqual(Object.keys((await listEntries({ env }))['games.fun https://x.test']).includes('secret'), false, 'the listing never shows a secret');
    assert.equal(await deleteSecret('games.fun https://x.test', { env }), true);
    assert.equal(await loadSecret('games.fun https://x.test', { env }), null);
  } finally { await t.cleanup(); }
});

test('gate: a pass is kept for exactly these files; a change runs verify again; a verify that writes nothing is not a pass', async () => {
  const t = await tempDir();
  try {
    const dir = await fakeGame(t.dir);
    let runs = 0, n = 1;
    const verify = async (d, { pass = true } = {}) => {
      runs++; n++;
      await mkdir(path.join(d, 'evidence', `verify-${n}`), { recursive: true });
      await writeFile(path.join(d, 'evidence', `verify-${n}`, 'record.json'), JSON.stringify({ pass, quick: true, checks: [{ n: 1, name: 'one', ok: true }, { n: 13, name: 'controls', ok: pass }] }));
    };
    const first = await gate(dir, { verify });
    assert.equal(first.report.pass, true); assert.equal(runs, 1);
    assert.equal((await readGate(dir)).fingerprint, first.fingerprint);
    const second = await gate(dir, { verify });
    assert.equal(second.reused, true); assert.equal(runs, 1, 'unchanged files: verify is not run again');
    await writeFile(path.join(dir, 'main.js'), 'changed');
    const third = await gate(dir, { verify: d => verify(d, { pass: false }) });
    assert.equal(third.report.pass, false); assert.deepEqual(third.report.failed, [{ n: 13, name: 'controls' }]);
    await writeFile(path.join(dir, 'main.js'), 'changed again');
    const crashed = await gate(dir, { verify: async () => {} });
    assert.equal(crashed.report.pass, false, 'an older verdict is not a result for new files');
    const edits = await gate(dir, { verify: async d => { await verify(d); await writeFile(path.join(d, 'main.js'), 'edited during verify'); } });
    assert.equal(edits.changedDuring, true); assert.equal(edits.report.pass, false);
    assert.equal((await gate(dir, { run: false })).report.pass, false);
  } finally { await t.cleanup(); }
});

test('open: an https page only when asked (games.fun\'s sign-in); never anything else', () => {
  assert.throws(() => openCommand('https://games.example/kit/connect?a=1', { chrome: null, platform: 'linux' }));
  assert.deepEqual(openCommand('https://games.example/kit/connect?a=1', { chrome: null, platform: 'linux', web: true }), { cmd: 'xdg-open', args: ['https://games.example/kit/connect?a=1'] });
  assert.throws(() => openCommand('file:///etc/passwd', { chrome: null, web: true }));
  assert.throws(() => openCommand('javascript:alert(1)', { chrome: null, web: true }));
  assert.equal(studioOrigin({}), 'https://agentgames.fun');
  assert.equal(studioOrigin({ GAMESFUN_STUDIO: 'http://localhost:6055/' }), 'http://localhost:6055');
  assert.throws(() => studioOrigin({ GAMESFUN_STUDIO: 'http://evil.example' }));
});

/** A stand-in games.fun: the token exchange and logout, and the publish calls, in memory. */
async function standIn() {
  const state = { codes: new Map(), tokens: new Set(), blobs: new Set(), published: null, calls: [] };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null, send = (s, v) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const auth = (req.headers.authorization ?? '').slice(7);
    state.calls.push(`${req.method} ${req.url}`);
    if (req.url === '/api/kit/token' && req.method === 'POST') {
      const want = state.codes.get(json.code);
      if (!want || want !== challengeFor(json.verifier)) return send(400, { error: 'That sign-in code is not valid.' });
      state.tokens.add('gfk_' + 'a'.repeat(43));
      return send(200, { token: 'gfk_' + 'a'.repeat(43), tokenId: 't1', email: 'alice@example.com', device: 'test', expiresAt: Date.now() + 1e9 });
    }
    if (!state.tokens.has(auth)) return send(401, { error: 'Sign in first: npx gamesfun login' });
    if (req.url === '/api/kit/token' && req.method === 'DELETE') { state.tokens.delete(auth); return send(200, { revoked: true }); }
    if (req.url === '/api/kit/me') return send(200, { email: 'alice@example.com', limits: { files: 3000, totalBytes: 1e8, fileBytes: 32 * 1048576 } });
    if (req.url === '/api/kit/publish') { state.tree = json.tree; state.verify = json.verify; return send(200, { id: 'p1', projectId: 'g1', missing: json.tree.files.map(f => f.sha256).filter(s => !state.blobs.has(s)), newBytes: 10, draft: !json.verify.pass }); }
    const m = /^\/api\/kit\/publish\/p1\/blobs\/([0-9a-f]{64})$/.exec(req.url);
    if (m) { if (json.content == null) return send(200, { upload: null }); if (sha256(Buffer.from(json.content, 'base64')) !== m[1]) return send(400, { error: 'bad' }); state.blobs.add(m[1]); return send(200, { stored: true }); }
    if (req.url === '/api/kit/publish/p1') return send(200, { projectId: 'g1', version: { id: 'v', number: ++state.version || (state.version = 1) }, draft: !state.verify.pass, published: state.verify.pass ? { published: true, slug: 'coin-hop', url: `http://x/play/coin-hop`, gameUrl: 'http://x/p/coin-hop/', friendsUrl: null } : null, studioUrl: 'http://x/studio?game=g1', backend: [] });
    send(404, { error: 'no' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('sign in, publish (only new files), update at the same link, log out: against a stand-in games.fun', async () => {
  const t = await tempDir(), g = await standIn();
  try {
    const env = { GAMESFUN_CONFIG_DIR: path.join(t.dir, 'config'), GAMESFUN_CREDENTIALS: 'file' };
    // The "browser": approves at once, as the person would, by calling the kit's loopback callback with a code.
    const browser = async url => {
      const u = new URL(url);
      assert.equal(u.pathname, '/kit/connect');
      const code = 'c'.repeat(43);
      g.state.codes.set(code, u.searchParams.get('challenge'));
      const back = await fetch(`http://127.0.0.1:${u.searchParams.get('port')}/callback?code=${code}&state=${u.searchParams.get('state')}`);
      assert.match(await back.text(), /signed in/);
    };
    const r = await login({ origin: g.origin, open: browser, env });
    assert.equal(r.email, 'alice@example.com'); assert.equal(r.store, 'file');
    assert.ok(!(await readFile(credentialsFile({ env }), 'utf8')).includes('"verifier"'));
    const dir = await fakeGame(t.dir);
    const pass = async d => { await mkdir(path.join(d, 'evidence', 'verify-9'), { recursive: true }); await writeFile(path.join(d, 'evidence', 'verify-9', 'record.json'), JSON.stringify({ pass: true, quick: true, checks: [{ n: 1, name: 'one', ok: true }] })); };
    const one = await publishGame(dir, { origin: g.origin, env, verify: pass });
    assert.equal(one.url, 'http://x/play/coin-hop'); assert.equal(one.uploaded, 8);
    assert.equal(JSON.parse(await readFile(path.join(dir, '.gamesfun', 'publish.json'), 'utf8'))[g.origin].projectId, 'g1');
    assert.ok(JSON.parse(await readFile(path.join(dir, 'assets.json'), 'utf8')).ignore.some(i => i.path === '.gamesfun/**'), 'verify check 1 never counts the kit\'s own .gamesfun/ record');
    await writeFile(path.join(dir, 'main.js'), 'console.log("v2")');
    await mkdir(path.join(dir, 'evidence', 'verify-10'), { recursive: true });
    const two = await publishGame(dir, { origin: g.origin, env, verify: async d => { await writeFile(path.join(d, 'evidence', 'verify-10', 'record.json'), JSON.stringify({ pass: true, quick: true, checks: [{ n: 1, name: 'one', ok: true }] })); } });
    assert.equal(two.uploaded, 1, 'only the changed file goes up');
    assert.equal(two.version.number, 2);
    assert.ok(g.state.calls.filter(c => c === 'POST /api/kit/publish').length === 2);
    await writeFile(path.join(dir, 'rules.js'), `const k = "${jwt('service_role')}";`);
    await assert.rejects(publishGame(dir, { origin: g.origin, env, verify: pass }), /service-role key/);
    assert.equal((await preflight(dir, { origin: g.origin })).hits.length, 1);
    const out = await logout(g.origin, { env });
    assert.deepEqual(out, { revoked: true, forgot: true });
    assert.equal(await savedLogin(g.origin, { env }), null);
    await assert.rejects(publishGame(dir, { origin: g.origin, env }), /Not signed in/);
  } finally { await g.close(); await t.cleanup(); }
});

test('sign in: a cancel in the browser, and a callback from somewhere else, do not sign in', async () => {
  const g = await standIn(), t = await tempDir();
  try {
    const env = { GAMESFUN_CONFIG_DIR: t.dir, GAMESFUN_CREDENTIALS: 'file' };
    await assert.rejects(login({ origin: g.origin, env, open: async url => {
      const u = new URL(url), port = u.searchParams.get('port');
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`)).status, 400, 'a callback without the right state is ignored');
      await fetch(`http://127.0.0.1:${port}/callback?error=denied&state=${u.searchParams.get('state')}`);
    } }), /cancelled/);
    assert.equal(await savedLogin(g.origin, { env }), null);
  } finally { await g.close(); await t.cleanup(); }
});

test('sign in: a games.fun without the kit routes (not deployed yet) is said at once, not after a wait', async () => {
  const server = createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const t = await tempDir();
  try {
    let opened = false;
    await assert.rejects(login({ origin: `http://127.0.0.1:${server.address().port}`, env: { GAMESFUN_CONFIG_DIR: t.dir, GAMESFUN_CREDENTIALS: 'file' }, open: () => { opened = true; } }), /does not offer publishing from the kit yet/);
    assert.equal(opened, false);
  } finally { await new Promise(r => server.close(r)); await t.cleanup(); }
});
