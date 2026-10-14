// The game server template (builder/templates/backends/railway-node/server.js): what a game may do, and what it may not.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { issueToken, playerOf, settings, start } from '../builder/templates/backends/railway-node/server.js';
import { tempDir } from './helpers.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../builder/templates/backends/railway-node');
const GAME = 'http://127.0.0.1:5180', OTHER = 'https://evil.example';
const SECRET = 'x'.repeat(40);

async function server(t, extra = {}) {
  const d = await tempDir('gf-server-');
  const s = await start({ PORT: '0', GF_HOST: '127.0.0.1', GF_SECRET: SECRET, GF_ORIGINS: `${GAME},https://games-fun-play.vercel.app`, GF_DATA_DIR: d.dir, ...extra }, { log: () => {} });
  t.after(async () => { await s.close(); await d.cleanup(); });
  return { ...s, data: d.dir };
}
const call = (s, method, p, { body, token, origin = GAME } = {}) => fetch(`${s.url}${p}`, {
  method, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));

test('the template is complete: MIT licence, no dependencies, Railway config with a health check', () => {
  const pkg = JSON.parse(readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.match(readFileSync(path.join(DIR, 'LICENSE'), 'utf8'), /^MIT License/);
  const rw = JSON.parse(readFileSync(path.join(DIR, 'railway.json'), 'utf8'));
  assert.equal(rw.deploy.healthcheckPath, '/health');
  assert.ok(existsSync(path.join(DIR, 'README.md')));
});

test('settings: exact origins only, a short secret is refused, a missing one is made for the run', () => {
  assert.throws(() => settings({ GF_ORIGINS: 'https://*.example.com' }), /exact origin/);
  assert.throws(() => settings({ GF_ORIGINS: 'https://a.example/path' }), /exact origin/);
  assert.throws(() => settings({ GF_SECRET: 'short' }), /32 characters/);
  const s = settings({ GF_ORIGINS: 'https://a.example, http://127.0.0.1:5180' });
  assert.deepEqual(s.origins, ['https://a.example', 'http://127.0.0.1:5180']);
  assert.equal(s.secretMade, true);
  assert.equal(settings({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }).dataDir, path.resolve('/data'));
});

test('player tokens: signed by the server secret, refused when forged or signed by another secret', () => {
  const id = '6f1d2c1e-7f2a-4a59-9f4e-2b7f8e0c1a11';
  const tok = issueToken(SECRET, id);
  assert.equal(playerOf(SECRET, `Bearer ${tok}`), id);
  assert.equal(playerOf('y'.repeat(40), `Bearer ${tok}`), null);
  assert.equal(playerOf(SECRET, `Bearer ${id}.${'A'.repeat(43)}`), null);
  assert.equal(playerOf(SECRET, 'Bearer nonsense'), null);
  assert.equal(playerOf(SECRET, undefined), null);
});

test('health, CORS for the game\'s exact origin, and refusal of any other web page', async t => {
  const s = await server(t);
  const h = await call(s, 'GET', '/health', { origin: null });
  assert.deepEqual(h.json, { ok: true, version: '1.0.0' });
  const pre = await call(s, 'OPTIONS', '/v1/players');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), GAME);
  const bad = await call(s, 'POST', '/v1/players', { origin: OTHER });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const sub = await call(s, 'GET', '/v1/scores/main', { origin: 'http://127.0.0.1:51800' });
  assert.equal(sub.status, 403, 'a different port is a different origin');
});

test('scores: a token is needed, each player keeps their best, the board is ordered, bad scores are refused', async t => {
  const s = await server(t);
  const a = (await call(s, 'POST', '/v1/players')).json, b = (await call(s, 'POST', '/v1/players')).json;
  assert.match(a.token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await call(s, 'POST', '/v1/scores/main', { body: { score: 5 } })).status, 401);
  assert.equal((await call(s, 'POST', '/v1/scores/main', { body: { score: 5 }, token: `${a.id}.${'A'.repeat(43)}` })).status, 401);
  assert.deepEqual((await call(s, 'POST', '/v1/scores/main', { body: { score: 120, name: 'Ann' }, token: a.token })).json, { best: 120, rank: 1 });
  assert.deepEqual((await call(s, 'POST', '/v1/scores/main', { body: { score: 80, name: 'Ann' }, token: a.token })).json, { best: 120, rank: 1 });
  assert.deepEqual((await call(s, 'POST', '/v1/scores/main', { body: { score: 200, name: '<b>Bo</b>' }, token: b.token })).json, { best: 200, rank: 1 });
  const board = (await call(s, 'GET', '/v1/scores/main?limit=5')).json;
  assert.deepEqual(board.scores.map(r => [r.name, r.score]), [['bBo/b', 200], ['Ann', 120]]);
  assert.ok(!JSON.stringify(board).includes(a.id), 'player ids stay on the server');
  assert.equal((await call(s, 'POST', '/v1/scores/main', { body: { score: 'NaN' }, token: a.token })).status, 400);
  assert.equal((await call(s, 'POST', '/v1/scores/main', { body: { score: 1e12 }, token: a.token })).status, 400);
  assert.equal((await call(s, 'GET', '/v1/scores/Bad%20Board')).status, 400);
});

test('saves: each player reads and writes only their own, with a size limit; data survives a restart', async t => {
  const d = await tempDir('gf-server-');
  const env = { PORT: '0', GF_HOST: '127.0.0.1', GF_SECRET: SECRET, GF_ORIGINS: GAME, GF_DATA_DIR: d.dir, GF_MAX_SAVE_BYTES: '200' };
  let s = await start(env, { log: () => {} });
  const a = (await call(s, 'POST', '/v1/players')).json, b = (await call(s, 'POST', '/v1/players')).json;
  assert.equal((await call(s, 'PUT', '/v1/saves/me', { body: { data: { level: 3 } }, token: a.token })).status, 200);
  assert.deepEqual((await call(s, 'GET', '/v1/saves/me', { token: a.token })).json.data, { level: 3 });
  assert.equal((await call(s, 'GET', '/v1/saves/me', { token: b.token })).json.data, null);
  assert.equal((await call(s, 'PUT', '/v1/saves/me', { body: { data: 'x'.repeat(300) }, token: a.token })).status, 413);
  await call(s, 'POST', '/v1/scores/main', { body: { score: 7 }, token: a.token });
  await s.close();
  s = await start(env, { log: () => {} });
  t.after(async () => { await s.close(); await d.cleanup(); });
  assert.deepEqual((await call(s, 'GET', '/v1/saves/me', { token: a.token })).json.data, { level: 3 }, 'the same secret still accepts the token');
  assert.equal((await call(s, 'GET', '/v1/scores/main')).json.scores[0].score, 7);
});

test('the live feed: WebSocket from the game\'s origin gets the board and each change; another origin is refused', async t => {
  const s = await server(t);
  const ws = new WebSocket(`${s.url.replace('http', 'ws')}/v1/live?board=main`, { headers: { origin: GAME } });
  const msgs = [];
  const next = () => new Promise((resolve, reject) => { const t0 = setTimeout(() => reject(new Error('no message')), 3000); ws.addEventListener('message', e => { clearTimeout(t0); msgs.push(JSON.parse(e.data)); resolve(msgs.at(-1)); }, { once: true }); });
  const first = await next();
  assert.deepEqual(first, { type: 'scores', board: 'main', scores: [] });
  const p = (await call(s, 'POST', '/v1/players')).json;
  const pushed = next();
  await call(s, 'POST', '/v1/scores/main', { body: { score: 42, name: 'Cy' }, token: p.token });
  assert.deepEqual((await pushed).scores.map(r => r.score), [42]);
  ws.send('{"type":"ping"}');
  assert.deepEqual(await next(), { type: 'pong' });
  ws.close();

  const refused = await new Promise(resolve => {
    const w = new WebSocket(`${s.url.replace('http', 'ws')}/v1/live?board=main`, { headers: { origin: OTHER } });
    w.addEventListener('open', () => resolve('opened'));
    w.addEventListener('error', () => resolve('refused'));
  });
  assert.equal(refused, 'refused');
});
