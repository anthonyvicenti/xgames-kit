// Online play, the dev server's side (builder/server/online.mjs, docs/ONLINE.md): the one line a game page gets, when it gets
// it, the person's switch, the doctor's line, and what the page does when the online host refuses or cannot be reached.
// No browser and no network: the page side runs here against a stand-in window. The real thing, in Chrome with a real
// signaling server on another origin, is tests/online-e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { onlineDoctor, runDoctor } from '../builder/lib/doctor.mjs';
import { GF_MP } from '../builder/lib/paths.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { injectOnline, ONLINE_CLIENT, ONLINE_CLIENT_PATH, ONLINE_LINE, ONLINE_MIN_KIT, onlineAddress, onlineFor, onlineSetting, onlineWords } from '../builder/server/online.mjs';
import { tempGame } from './helpers.mjs';

// the one multiplayer kit this checkout carries (builder/gf-multiplayer; its version is in its kit.json)
const MP = { version: JSON.parse(await readFile(path.join(GF_MP, 'source', 'kit.json'), 'utf8')).version };
/** Put the multiplayer kit into a game, as create does. */
export async function putKit(gameDir) {
  await cp(path.join(GF_MP, 'source'), path.join(gameDir, 'gf', 'mp'), { recursive: true, force: true });
}
const page = async (srv, rel) => (await fetch(new URL(rel, srv.url))).text();

test('the line is the one games.fun asked for, and the switch reads off, an address of your own, or nothing', () => {
  assert.equal(ONLINE_LINE, '<script>window.GF_P2P_CONFIG = Object.assign({ signal: \'online\' }, window.GF_P2P_CONFIG || {});</script>');
  assert.deepEqual(onlineSetting({}), { mode: 'default' });
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.deepEqual(onlineSetting({ GAMESFUN_ONLINE: v }), { mode: 'off' }, v);
  assert.deepEqual(onlineSetting({ GAMESFUN_ONLINE: 'https://play.example/signal/v1/' }), { mode: 'own', address: 'https://play.example/signal/v1' });
  assert.deepEqual(onlineSetting({ GAMESFUN_ONLINE: 'http://127.0.0.1:5352/signal/v1' }), { mode: 'own', address: 'http://127.0.0.1:5352/signal/v1' });
  // the kit's own rule: never plain http to another machine, never anything but /signal/v1
  for (const bad of ['http://play.example/signal/v1', 'https://play.example/', 'https://u:p@play.example/signal/v1', 'https://play.example/signal/v1?x=1', 'maybe']) {
    assert.equal(onlineAddress(bad), null, bad);
    assert.equal(onlineSetting({ GAMESFUN_ONLINE: bad }).mode, 'bad', bad);
  }
});

test('a created game: the multiplayer kit create vendors decides, and the dev server says which it is', async t => {
  const game = await tempGame();
  t.after(game.cleanup);
  const kit = JSON.parse(await readFile(path.join(game.dir, 'gf', 'mp', 'kit.json'), 'utf8')).version;
  assert.equal(kit, MP.version, 'create vendors the one kit this checkout carries');
  const o = await onlineFor(game.dir, {});
  const supported = kit.localeCompare(ONLINE_MIN_KIT, undefined, { numeric: true }) >= 0;
  t.diagnostic(`a created game carries gf-multiplayer ${kit}: ${onlineWords(o)}`);
  if (supported) { assert.equal(o.use, 'online'); assert.match(o.host, /^https:\/\/.+\/signal\/v1$/); }
  else { assert.equal(o.use, 'this-machine'); assert.match(o.why, new RegExp(`multiplayer kit is ${kit.replaceAll('.', '\\.')}; online play needs ${ONLINE_MIN_KIT.replaceAll('.', '\\.')}`)); }
  const srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false, env: {} });
  t.after(() => srv.close());
  for (const rel of ['game/', 'game/gf/mp/']) {
    const html = await page(srv, rel);
    assert.equal(html.includes(ONLINE_LINE), supported, `${rel}: the line is there only when the game's kit knows it`);
    assert.equal(html.includes(ONLINE_CLIENT_PATH), supported);
    assert.match(html, /__gamesfun\/reload\.js/, 'live reload is untouched');
  }
});

test('a game on a kit that knows online play: the line goes before the first script of every page; off inserts nothing; your own server is named', async t => {
  if (MP.version.localeCompare(ONLINE_MIN_KIT, undefined, { numeric: true }) < 0) return t.skip('this checkout carries no multiplayer kit with online play');
  const version = MP.version;
  const game = await tempGame();
  t.after(game.cleanup);
  await putKit(game.dir, version);
  const kitHost = JSON.parse(await readFile(path.join(game.dir, 'gf', 'mp', 'p2p.json'), 'utf8')).online;
  assert.match(kitHost, /^https:\/\/[a-z0-9.-]+\/signal\/v1$/, 'the kit names its play host');

  // the default: the kit's own host, the line exactly, before the first <script> of the game page and of the friends page
  let srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false, env: {} });
  try {
    assert.deepEqual(await srv.online(), { use: 'online', host: kitHost, own: false, kit: version, why: 'the multiplayer kit\'s own play host' });
    for (const rel of ['game/', 'game/gf/mp/']) {
      const html = await page(srv, rel), first = html.search(/<script\b/i);
      assert.equal(first, html.indexOf(ONLINE_LINE), `${rel}: the line is the page's first script`);
      assert.equal(html.split(ONLINE_LINE).length, 2, 'once');
      assert.ok(html.indexOf(ONLINE_CLIENT_PATH) > first);
    }
    const js = await fetch(new URL(ONLINE_CLIENT_PATH, srv.url));
    assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/); assert.equal(await js.text(), ONLINE_CLIENT);
    // a file that is not a page is served as it is
    assert.equal(await page(srv, 'game/gf/mp/p2p.json'), await readFile(path.join(game.dir, 'gf', 'mp', 'p2p.json'), 'utf8'));
    assert.match(onlineWords(await srv.online()), /^online through [a-z0-9.-]+: friends on other machines can join; when it refuses or cannot be reached, this machine only\. GAMESFUN_ONLINE=off turns it off$/);
  } finally { await srv.close(); }

  // off: nothing is inserted
  srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false, env: { GAMESFUN_ONLINE: 'off' } });
  try {
    assert.equal((await srv.online()).use, 'this-machine');
    for (const rel of ['game/', 'game/gf/mp/']) { const html = await page(srv, rel); assert.ok(!html.includes('GF_P2P_CONFIG = Object.assign') && !html.includes(ONLINE_CLIENT_PATH), rel); }
    assert.match(onlineWords(await srv.online()), /^this machine only \(GAMESFUN_ONLINE is off\)/);
  } finally { await srv.close(); }

  // a signaling server of the person's own: the same line with its address
  srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false, env: { GAMESFUN_ONLINE: 'http://127.0.0.1:5352/signal/v1' } });
  try {
    const html = await page(srv, 'game/gf/mp/');
    assert.ok(html.includes('<script>window.GF_P2P_CONFIG = Object.assign({ signal: \'online\', online: "http://127.0.0.1:5352/signal/v1" }, window.GF_P2P_CONFIG || {});</script>'));
    assert.equal(html.search(/<script\b/i), html.indexOf('<script>window.GF_P2P_CONFIG'));
  } finally { await srv.close(); }

  // a setting that is neither: nothing is inserted, and the reason is said
  const bad = await onlineFor(game.dir, { GAMESFUN_ONLINE: 'http://elsewhere.example/signal/v1' });
  assert.equal(bad.use, 'this-machine'); assert.match(bad.why, /not off or a signaling address/);
});

test('injectOnline: before the first script, once, and a page with no script is left alone', () => {
  const o = { use: 'online', host: 'https://play.example/signal/v1', own: false };
  const html = '<!doctype html><html><head><title>x</title>\n<script type="importmap">{}</script><script src="a.js"></script></head><body></body></html>';
  const out = injectOnline(Buffer.from(html), o).toString('utf8');
  assert.equal(out.indexOf(ONLINE_LINE), html.indexOf('<script type="importmap">'), 'before the import map too: the kit reads the setting when it loads');
  assert.equal(injectOnline(Buffer.from(out), o).toString('utf8'), out, 'not twice');
  assert.equal(injectOnline(Buffer.from('<p>no script</p>'), o).toString('utf8'), '<p>no script</p>');
  assert.equal(injectOnline(Buffer.from(html), { use: 'this-machine' }).toString('utf8'), html);
});

// ---- the page side, against a stand-in window ------------------------------------------------------------------------
const HOST = 'https://play.example/signal/v1';
function standIn(answer) {
  const calls = [], said = [], nodes = [];
  const el = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; }, remove() {}, get text() { return this.children.map(c => c.textContent ?? '').join(''); } });
  const body = el();
  const window = {
    GAMESFUN_ONLINE_HOST: HOST,
    fetch: async (input, init) => { calls.push({ url: String(input), init }); return answer(String(input), init); },
  };
  const document = { body, getElementById: id => nodes.find(n => n.id === id) ?? null, createElement: () => { const n = el(); nodes.push(n); return n; }, addEventListener() {} };
  vm.runInNewContext(ONLINE_CLIENT, { window, document, console: { info: m => said.push(m) }, location: { href: 'http://127.0.0.1:5180/game/gf/mp/?join=ABCDEF' }, URL, TypeError, JSON, String });
  return { window, calls, said, notice: () => nodes.find(n => n.id === 'gamesfun-online-notice') ?? null, links: () => nodes.filter(n => n.href) };
}
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, clone() { return { json: async () => body }; }, json: async () => body });

test('the page: a host that answers is used as it is, and requests that are not the host\'s are not touched', async () => {
  const p = standIn(url => res(200, url.endsWith('/ice') ? { v: 1, signal: 'http', iceServers: [] } : { t: 'hosted', code: 'ABCDEF' }));
  const r = await p.window.fetch(`${HOST}/ice`, { cache: 'no-store' });
  assert.equal(r.status, 200);
  await p.window.fetch(HOST, { method: 'POST', body: '{"op":"host"}' });
  await p.window.fetch('http://127.0.0.1:5180/game/gf/mp/p2p.json');
  assert.equal(p.window.GAMESFUN_ONLINE.use, 'online'); assert.equal(p.window.GAMESFUN_ONLINE.refused, null);
  assert.equal(p.notice(), null, 'nothing is shown when online play works');
  assert.equal(p.calls.length, 3, 'it makes no request of its own');
});

test('the page: the host refuses this page (the switch is off): the kit is told "not reachable", so it plays on this machine, and the notice carries the host\'s words', async () => {
  const words = 'Online play for games run from other sites is off for now. Play in two tabs on this machine, or host your own signaling.';
  const p = standIn(() => res(403, { t: 'error', code: 'off', reason: words }));
  await assert.rejects(() => p.window.fetch(`${HOST}/ice`), /the online host refused this page/, 'the kit\'s probe fails, which is its own path to this machine\'s signaling');
  assert.equal(p.window.GAMESFUN_ONLINE.use, 'this-machine'); assert.equal(p.window.GAMESFUN_ONLINE.refused, words);
  assert.equal(p.notice().text, `Online play is not available from this page: ${words} Friends can still join on this machine: open the invite link in another tab or window here. Close`);
  assert.match(p.said[0], /^gamesfun dev: Online play is not available from this page/);
  assert.equal(p.links().length, 0, 'nothing to click: the page is already on this machine');
});

test('the page: the host cannot be reached (no network, or an answer this page may not read): said, and the kit falls back by itself', async () => {
  const p = standIn(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(() => p.window.fetch(`${HOST}/ice`), /Failed to fetch/);
  assert.equal(p.window.GAMESFUN_ONLINE.use, 'this-machine'); assert.equal(p.window.GAMESFUN_ONLINE.refused, 'unreachable');
  assert.match(p.notice().text, /^Online play could not be reached \(play\.example did not answer this page\)\. Friends can still join on this machine/);
});

test('the page: a room the host refuses later (a limit) keeps the host\'s words and offers this machine', async () => {
  const p = standIn(url => (url.endsWith('/ice') ? res(200, { v: 1, signal: 'http', iceServers: [] }) : res(429, { t: 'error', code: 'limited', reason: 'too many rooms from this network: try again in 21 minutes' })));
  await p.window.fetch(`${HOST}/ice`);
  const r = await p.window.fetch(HOST, { method: 'POST', body: JSON.stringify({ op: 'host' }) });
  assert.equal(r.status, 429, 'the kit still reads the refusal and shows it');
  assert.match(p.notice().text, /^The online host refused: Too many rooms from this network: try again in 21 minutes\. Play on this machine instead/);
  const link = p.links()[0];
  assert.equal(link.href, 'http://127.0.0.1:5180/game/gf/mp/?signal=ws', 'this machine\'s signaling, and no room code of the host that refused');
  // an answer that is not about opening or joining a room (a poll that ended) shows nothing
  const q = standIn(url => (url.endsWith('/ice') ? res(200, { v: 1, signal: 'http', iceServers: [] }) : res(404, { t: 'error', code: 'no-room', reason: 'not in a room' })));
  await q.window.fetch(HOST, { method: 'POST', body: JSON.stringify({ op: 'poll' }) });
  assert.equal(q.notice(), null);
});

// ---- doctor ----------------------------------------------------------------------------------------------------------
test('doctor says which it will be: online (the host\'s name) or this machine only, and why', async () => {
  const hostOf = () => 'https://games-fun-play.vercel.app/signal/v1';
  const on = onlineDoctor({ env: {}, kits: { version: '1.6.4', path: 'a/1.6.4' }, hostOf });
  assert.match(on.detail, /^online through games-fun-play\.vercel\.app: a game served by dev opens its rooms there/);
  assert.match(onlineDoctor({ env: { GAMESFUN_ONLINE: 'off' }, kits: { version: '1.6.4', path: 'a' }, hostOf }).detail, /^this machine only: GAMESFUN_ONLINE is off/);
  const own = onlineDoctor({ env: { GAMESFUN_ONLINE: 'https://mine.example/signal/v1' }, kits: { version: '1.6.4', path: 'a' }, hostOf });
  assert.match(own.detail, /^online through mine\.example \(your own signaling server, GAMESFUN_ONLINE\)/);
  const bad = onlineDoctor({ env: { GAMESFUN_ONLINE: 'sometimes' }, kits: { version: '1.6.4', path: 'a' }, hostOf });
  assert.equal(bad.status, 'warn'); assert.match(bad.fix.win32, /GAMESFUN_ONLINE/);
  assert.match(onlineDoctor({ env: {}, kits: { version: '1.6.3', path: 'a' }, hostOf: () => null }).detail, /^this machine only: the multiplayer kit here is 1\.6\.3/);
  // the real kit (builder/gf-multiplayer): one line, never a fail, and it agrees with what a created game gets
  const real = onlineDoctor({ env: {} });
  assert.equal(real.id, 'online'); assert.notEqual(real.status, 'fail');
  assert.equal(/^online through/.test(real.detail), MP.version.localeCompare(ONLINE_MIN_KIT, undefined, { numeric: true }) >= 0);
  const r = await runDoctor({ graphics: false, probes: { deps: () => true, kits: true, git: 'git', chrome: null, playwright: { installed: false }, ports: [[5180, true]], writable: { games: null, state: null }, detected: [], bridge: { id: 'bridge', label: 'Studio', status: 'ok', detail: '', fix: null }, art: { id: 'art', label: 'Art', status: 'ok', detail: '', fix: null } } });
  assert.equal(r.items.filter(i => i.id === 'online').length, 1);
});
