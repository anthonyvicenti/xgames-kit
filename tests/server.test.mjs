// The dev server: 127.0.0.1 only, Host and Origin checks (HTTP and the signaling WebSocket), safe static serving,
// live reload, local signaling, and the routes seam with a plug-in route file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refuse } from '../builder/server/security.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { tempDir, tempGame } from './helpers.mjs';

test('refuse(): only this server\'s own Host and Origin', () => {
  const ok = { host: '127.0.0.1:5180' };
  assert.equal(refuse(ok, 5180), null);
  assert.equal(refuse({ host: 'localhost:5180' }, 5180), null);
  assert.equal(refuse({ host: 'LOCALHOST:5180' }, 5180), null);
  assert.equal(refuse({}, 5180).status, 400);
  assert.equal(refuse({ host: 'evil.example:5180' }, 5180).status, 421, 'DNS rebinding');
  assert.equal(refuse({ host: '127.0.0.1:5181' }, 5180).status, 421);
  assert.equal(refuse({ host: '0.0.0.0:5180' }, 5180).status, 421);
  assert.equal(refuse({ ...ok, origin: 'http://127.0.0.1:5180' }, 5180), null);
  assert.equal(refuse({ ...ok, origin: 'http://evil.example' }, 5180).status, 403);
  assert.equal(refuse({ ...ok, origin: 'null' }, 5180).status, 403);
  assert.equal(refuse({ ...ok, origin: 'http://127.0.0.1:5181' }, 5180).status, 403);
  assert.equal(refuse({ ...ok, 'sec-fetch-site': 'cross-site' }, 5180, { api: true }).status, 403);
  assert.equal(refuse({ ...ok, 'sec-fetch-site': 'same-site' }, 5180, { api: true }).status, 403);
  assert.equal(refuse({ ...ok, 'sec-fetch-site': 'same-origin' }, 5180, { api: true }), null);
  assert.equal(refuse({ ...ok, 'sec-fetch-site': 'cross-site' }, 5180), null, 'static files may be embedded');
});

let game, routes, srv;
before(async () => {
  game = await tempGame();
  routes = await tempDir();
  // the seam: a route file another track would add (builder/server/routes/<area>.mjs)
  await writeFile(path.join(routes.dir, 'plugin.mjs'), `
    import { HttpError, readJson } from ${JSON.stringify(new URL('../builder/server/http.mjs', import.meta.url).href)};
    export default function register(router, ctx) {
      router.get('/ctx', () => ({ gameDir: ctx.gameDir, kitRoot: ctx.kitRoot, network: ctx.network, log: typeof ctx.log }));
      router.get('/items/:id', (req, res, params) => ({ id: params.id, q: req.query.get('q') }));
      router.post('/echo', async req => ({ got: await readJson(req) }));
      router.get('/teapot', () => { throw new HttpError(418, 'short and stout'); });
      router.get('/raw', (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('raw'); });
    }`);
  await writeFile(path.join(routes.dir, 'broken.mjs'), 'throw new Error("boom");');
  await writeFile(path.join(routes.dir, 'Bad_Name.mjs'), 'export default () => {};');
  srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, routesDir: routes.dir });
});
after(async () => { await srv?.close(); await game?.cleanup(); await routes?.cleanup(); });

function http(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path: pathname, method, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('binds 127.0.0.1 and serves the game, the studio and the redirects', async () => {
  assert.equal(srv.url, `http://127.0.0.1:${srv.port}/`);
  const g = await http('/game/');
  assert.equal(g.status, 200);
  assert.match(g.text, /<script type="importmap">/);
  assert.match(g.text, /__gamesfun\/reload\.js/, 'live reload injected into game pages');
  assert.equal((await http('/game/gf/mp/')).status, 200);
  assert.equal((await http('/studio/')).status, 200);
  assert.equal((await http('/')).headers.location, '/studio/');
  assert.equal((await http('/game/gf')).headers.location, '/game/gf/');
  assert.equal(g.headers['x-frame-options'], 'SAMEORIGIN');
});

test('refuses foreign Host and Origin on HTTP', async () => {
  assert.equal((await http('/game/', { headers: { host: `evil.example:${srv.port}` } })).status, 421);
  assert.equal((await http('/api/game/info', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await http('/api/game/slots/value', { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await http('/signal/v1', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{"op":"host"}' })).status, 403);
});

test('never serves outside the game, dotfiles or Windows device names', async () => {
  for (const p of ['/game/..%2fpackage.json', '/game/..%5cpackage.json', '/game/.gitignore', '/game/con', '/game/index.html.', '/game/C:%5cWindows']) {
    const r = await http(p);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.text.includes('"xgames-kit"'), `${p} leaked package.json`);
  }
});

test('local signaling: HTTP /signal/v1 and the WebSocket /signal (same Host/Origin rules)', async () => {
  const ice = await http('/signal/v1/ice');
  assert.equal(ice.status, 200);
  assert.equal(JSON.parse(ice.text).signal, 'http');
  const hosted = await http('/signal/v1', { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` }, body: '{"op":"host"}' });
  assert.equal(hosted.status, 200);
  assert.match(JSON.parse(hosted.text).code, /^[A-Z2-9]{6}$/);
  // a WebSocket from this origin opens a room; one from another origin is refused before the handshake
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/signal`);
  const msg = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'host' }));
    ws.onmessage = e => resolve(JSON.parse(e.data));
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  ws.close();
  assert.equal(msg.t, 'hosted');
  const bad = await new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port: srv.port, path: '/signal', headers: { host: `127.0.0.1:${srv.port}`, origin: 'http://evil.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', r => resolve(r.statusCode));
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve('closed'));
    req.end();
  });
  assert.notEqual(bad, 101);
});

test('the routes seam: a plug-in route file mounts under /api/<area> with the documented ctx', async () => {
  const ctx = JSON.parse((await http('/api/plugin/ctx')).text);
  assert.deepEqual(ctx, { gameDir: game.dir, kitRoot: KIT_ROOT, network: 'devnet', log: 'function' });
  assert.deepEqual(JSON.parse((await http('/api/plugin/items/a%20b?q=1')).text), { id: 'a b', q: '1' });
  assert.deepEqual(JSON.parse((await http('/api/plugin/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' })).text), { got: { x: 1 } });
  const tea = await http('/api/plugin/teapot');
  assert.equal(tea.status, 418);
  assert.equal(JSON.parse(tea.text).error, 'short and stout');
  assert.equal((await http('/api/plugin/raw')).text, 'raw');
  assert.equal((await http('/api/plugin/echo')).status, 405);
  assert.equal((await http('/api/nothing/here')).status, 404);
  const areas = srv.router.areas();
  assert.equal(areas.find(a => a.area === 'broken').ok, false, 'a route file that throws is reported, not fatal');
  assert.equal(areas.find(a => a.file === 'Bad_Name.mjs').ok, false);
});

test('the core routes: game info, slots read and write, verify state, studio tabs', async () => {
  const s2 = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false });
  try {
    const call = (p, opts = {}) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s2.port, path: p, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${s2.port}`, 'content-type': 'application/json' } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null })); });
      req.on('error', reject); if (opts.body) req.write(JSON.stringify(opts.body)); req.end();
    });
    const info = await call('/api/game/info');
    assert.equal(info.json.title, 'Soak Squad');
    assert.equal(info.json.friendsUrl, '/game/gf/mp/');
    const slots = await call('/api/game/slots');
    assert.ok(slots.json.slots.length >= 20 && slots.json.slots.length <= 40);
    const set = await call('/api/game/slots/value', { method: 'POST', body: { id: 'round.seconds', value: 95 } });
    assert.equal(set.json.after, 95);
    assert.equal((await call('/api/game/slots/value', { method: 'POST', body: { id: 'round.seconds', value: 5 } })).status, 400);
    assert.equal((await call('/api/game/verify')).json.running, false);
    const tabs = (await call('/api/studio/tabs')).json.map(t => t.file);
    for (const f of ['assets.js', 'verify.js', 'friends.js']) assert.ok(tabs.includes(f));
    assert.match((await call('/api/dev/status')).json.url, /^http:\/\/127\.0\.0\.1:/);
  } finally { await s2.close(); }
});

test('live reload: a saved game file reaches open pages as a "game" event', async () => {
  const got = new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path: '/__gamesfun/events', headers: { host: `127.0.0.1:${srv.port}` } }, res => {
      res.on('data', d => { if (String(d).includes('event: game') && String(d).includes('rules.js')) { resolve(String(d)); req.destroy(); } });
    });
    req.on('error', () => {});
    setTimeout(() => reject(new Error('no reload event within 30 s')), 30000);
    req.end();
  });
  await new Promise(r => setTimeout(r, 200));
  await mkdir(path.join(game.dir, 'config'), { recursive: true });
  await writeFile(path.join(game.dir, 'rules.js'), (await import('node:fs')).readFileSync(path.join(game.dir, 'rules.js'), 'utf8') + '\n// touched\n');
  assert.match(await got, /rules\.js/);
});
