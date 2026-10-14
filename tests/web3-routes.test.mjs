// The web3 routes' security boundary (builder/web3/node/http.mjs, builder/web3/node/api.mjs): loopback only, Host and Origin
// checks, JSON only, no CORS, size limits, pictures only from inside the game, and secrets never written to a game.
// Written red-first: each case below failed against the handlers before their guard existed.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { symlink, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { guard, HttpError } from '../builder/web3/node/http.mjs';
import { serializeConfig } from '../builder/web3/gf-web3/config.js';
import { fakeChain } from './web3/fake-chain.mjs';
import { makeGame, post, request, serve } from './web3/helpers.mjs';

let game;
let server;
let chain;
before(async () => {
  game = await makeGame();
  chain = fakeChain();
  server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
});
after(() => server.close());

describe('who may call the web3 routes', () => {
  it('answers the studio page itself', async () => {
    const r = await request(server.port, { path: '/api/web3/state?chain=0' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.game.title, 'Bean Brawl');
    const p = await post(server.port, '/item/save', { name: 'Golden Hat', picture: 'assets/hat.png' });
    assert.equal(p.status, 200, p.text);
  });

  const refusals = [
    ['a foreign Host (DNS rebinding)', { path: '/api/web3/state', headers: { host: 'evil.example:80' } }, 403],
    ['a loopback Host on another port', { path: '/api/web3/state', headers: { host: 'localhost:1' } }, 403],
    ['a GET from another origin', { path: '/api/web3/state', headers: { origin: 'https://evil.example' } }, 403],
    ['a cross-site fetch', { path: '/api/web3/state', headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['a POST with no Origin', { method: 'POST', path: '/api/web3/item/save', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }, 403],
    ['a POST from another origin', { method: 'POST', path: '/api/web3/item/save', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"name":"x"}' }, 403],
    ['a form-encoded POST (a CORS-simple request)', { method: 'POST', path: '/api/web3/item/save', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}', ownOrigin: true }, 415],
    ['an OPTIONS preflight', { method: 'OPTIONS', path: '/api/web3/item/save' }, 405],
    ['a PUT', { method: 'PUT', path: '/api/web3/item/save', ownOrigin: true }, 405],
  ];
  for (const [label, options, status] of refusals) {
    it(`refuses ${label}`, async () => {
      const headers = { ...(options.ownOrigin ? { origin: `http://127.0.0.1:${server.port}` } : {}), ...(options.headers ?? {}) };
      const r = await request(server.port, { ...options, headers });
      assert.equal(r.status, status, r.text);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    });
  }

  it('refuses a connection that did not arrive on loopback', () => {
    const fake = (localAddress) => ({ method: 'GET', headers: { host: '127.0.0.1:5000' }, socket: { localAddress, localPort: 5000 } });
    assert.throws(() => guard(fake('192.168.1.20')), (e) => e instanceof HttpError && e.status === 403);
    assert.doesNotThrow(() => guard(fake('127.0.0.1')));
    assert.doesNotThrow(() => guard({ ...fake('::1'), headers: { host: '[::1]:5000' } }));
  });

  it('never sends CORS headers, even on success', async () => {
    const r = await request(server.port, { path: '/api/web3/state?chain=0' });
    assert.equal(Object.keys(r.headers).some((h) => h.startsWith('access-control-')), false);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
});

describe('bodies', () => {
  it('refuses an oversized body by its declared length and by what actually arrives', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(70_000) });
    const declared = await post(server.port, '/item/save', big);
    assert.equal(declared.status, 413);
    const streamed = await request(server.port, {
      method: 'POST',
      path: '/api/web3/item/save',
      headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      chunks: Array.from({ length: 20 }, () => 'x'.repeat(8192)),
    });
    assert.equal(streamed.status, 413);
  });
  it('refuses a body that is not a JSON object', async () => {
    assert.equal((await post(server.port, '/item/save', '[1,2]')).status, 400);
    assert.equal((await post(server.port, '/item/save', '{nope')).status, 400);
  });
});

describe('pictures come only from inside the game, and only as pictures', () => {
  it('serves a real picture with nosniff and a sandbox CSP', async () => {
    const r = await request(server.port, { path: '/api/web3/picture?path=assets/hat.png' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.match(r.headers['content-security-policy'], /sandbox/);
  });
  const bad = [
    ['a parent path', '../../../etc/passwd'],
    ['an encoded parent path', '..%2F..%2Fetc%2Fpasswd'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows drive path', 'C:/Windows/win.ini'],
    ['a file that does not exist', 'assets/none.png'],
  ];
  for (const [label, p] of bad) {
    it(`refuses ${label}`, async () => {
      const r = await request(server.port, { path: `/api/web3/picture?path=${p}` });
      assert.equal(r.status, 400, r.text);
    });
  }
  it('refuses a link that leads outside the game, an SVG, and a .png that is not a PNG', async () => {
    await writeFile(path.join(game.root, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
    let linked = true;
    try {
      await symlink(path.join(game.root, 'secret.png'), path.join(game.gameDir, 'assets', 'escape.png'));
    } catch {
      linked = false; // Windows without the symlink privilege: nothing to test
    }
    if (linked) assert.equal((await request(server.port, { path: '/api/web3/picture?path=assets/escape.png' })).status, 400);
    await writeFile(path.join(game.gameDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal((await request(server.port, { path: '/api/web3/picture?path=assets/logo.svg' })).status, 400);
    await writeFile(path.join(game.gameDir, 'assets', 'fake.png'), '<html><script>alert(1)</script></html>');
    assert.equal((await request(server.port, { path: '/api/web3/picture?path=assets/fake.png' })).status, 400);
    assert.equal((await post(server.port, '/item/save', { name: 'Fake', picture: 'assets/fake.png' })).status, 400);
  });
});

describe('secrets never go into a game', () => {
  it('refuses keys, keyed RPC URLs and keypair bytes in any field', async () => {
    const attempts = [
      { name: 'Hat', description: 'my api_key: 1234' },
      { name: 'Hat', description: 'rpc https://devnet.helius-rpc.com/?api-key=abcd' },
      { name: 'Hat', description: `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]` },
      { name: '4Z7cXSyeFR8wNGMVXUE1TwtKn5D5Vu7FzEv69dokLv7KrQk7h6pu4LF8ZRR9yQBhc7uSM6RJTBhwxQXcLAF9U7uN' },
      { name: 'Hat', look: { files: { 'character.hat.player': 'https://cdn.example/hat.glb?token=abc' } } },
    ];
    for (const body of attempts) {
      const r = await post(server.port, '/item/save', { picture: 'assets/hat.png', ...body });
      const saved = await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8');
      assert.ok(r.status === 400 || !/api_key|helius|token=|4Z7cXSy/.test(saved), `${JSON.stringify(body)} → ${r.status} ${r.text}`);
      assert.doesNotMatch(saved, /api_key|helius-rpc|token=abc|4Z7cXSyeFR8wNG/);
    }
    // Written directly (not through a route), a secret is dropped by the schema rather than saved.
    assert.doesNotMatch(serializeConfig({ version: 1, network: 'devnet', creator: 'apikey=x', shop: { name: 'S', description: 'apikey=x', items: [], boxes: [] } }), /apikey/);
  });
  it('refuses a gamesfun.json for another network instead of reinterpreting it', async () => {
    const other = await makeGame({ config: { version: 1, network: 'mainnet-beta' } });
    const s = await serve({ gameDir: other.gameDir, kitRoot: other.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    try {
      const r = await request(s.port, { path: '/api/web3/state?chain=0' });
      assert.equal(r.status, 500);
      assert.match(r.json.error, /devnet only/);
    } finally {
      await s.close();
    }
  });
});

describe('agent requests', () => {
  it('cannot name a file outside the request folder', async () => {
    assert.equal((await post(server.port, '/request/dismiss', { id: '../../gamesfun' })).status, 404);
    assert.equal((await post(server.port, '/flow/start', { requestId: '../x', wallet: 'x' })).status, 404);
  });
});
