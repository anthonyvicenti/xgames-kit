#!/usr/bin/env node
// The local world server: one world game on this machine, served the way the play host serves it (worlds/
// PLAN.md §2), so the game, its friends page and its saves behave as they will once published.
//
//   node builder/world-server/serve.mjs <game-dir> [--port 5812] [--slug <slug>] [--data <dir>] [--memory] [--csp]
//                                             [--host 127.0.0.1] [--frame-ancestor <origin>]...
//
//   /p/<slug>/…               the game's files, at the same paths as the play host (so the kit's slug detection works);
//                             /p/<slug> → 308 to /p/<slug>/, and a folder URL serves its index.html
//   /                         → /p/<slug>/gf/mp/index.html (the world card)
//   /signal/v1, /signal/v1/ice, WebSocket /signal
//                             host-join signaling: builder/multiplayer/p2p/signal-server.mjs attachSignaling, unforked
//   /world/v1/<slug>, /world/v1/<slug>/snap/<seq>
//                             world saves: builder/studio-lib/world-core.mjs, the play host's own protocol and limits
//   /watch/v1, /watch/v1/<id>, WebSocket /watch/v1/<id>
//                             watch then play (watch/PLAN.md): the play host's config answer, and the stream
//                             relay itself (builder/watch/relay/node.mjs, the same rules as the Cloudflare one) on this
//                             server, so a stream and its viewers work on this machine; --no-watch turns streams off
//
// The world's config is <game-dir>/config/world.json (read again when it changes). The world is kept in --data
// (default ~/.cache/gf-worlds/<slug>, builder/studio-lib/world-files.mjs), so a restart keeps it; --memory keeps
// nothing. --csp sends the play origin's headers (builder/studio-lib/play-policy.mjs playHeaders, as /p/ sends them),
// so QA runs under connect-src 'self'; --frame-ancestor adds an origin that may frame it (a stand-in X card page).
// The slug defaults to the folder's name as a link name. Verify and tests start it on any port with
// startWorldServer({dir, port: 0, ...}) → {url, friendsUrl, gameUrl, apiUrl, port, slug, data, worlds, close}.
import { isMain } from '../tools/lib/main.mjs';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {attachSignaling} from '../multiplayer/p2p/signal-server.mjs';
import {createWorlds, isWorldSlug, memoryStore, WORLD_LIMITS} from '../studio-lib/world-core.mjs';
import {fileStore} from '../studio-lib/world-files.mjs';
import {mimeFor, playHeaders, PUBLIC_EMBEDDERS} from '../studio-lib/play-policy.mjs';
import {slugify} from '../studio-lib/publish.mjs';
import {attachWatchRelay} from '../watch/relay/node.mjs';

export const DEFAULT_PORT = 5812;
const FRIENDS_PAGE = 'gf/mp/index.html';

/** The data folder a world uses when --data isn't given. */
export const defaultDataDir = slug => join(homedir(), '.cache', 'gf-worlds', slug);

/**
 * Starts the server. `port` 0 picks a free one. `limits` (tests) overrides world-core's WORLD_LIMITS.
 * @returns {Promise<{url: string, friendsUrl: string, gameUrl: string, apiUrl: string, port: number, slug: string, data: string | null, worlds: any, sig: any, server: import('node:http').Server, close: () => Promise<void>}>}
 */
export async function startWorldServer({dir, port = DEFAULT_PORT, host = '127.0.0.1', slug = null, data = null, memory = false, csp = false,
  frameAncestors = [], limits = WORLD_LIMITS, watch = true, studio = null, log = () => {}} = {}) {
  if (!dir) throw new Error('startWorldServer needs the game folder (dir)');
  const base = resolve(dir);
  const name = slug ?? slugify(basename(base));
  if (!isWorldSlug(name)) throw new Error(`"${name}" is not a link name (3-48 lowercase letters or digits, single dashes): pass --slug`);
  const dataDir = memory ? null : resolve(data ?? defaultDataDir(name));
  const store = memory ? memoryStore() : fileStore(dataDir);

  // config/world.json, read again whenever its modification time changes (the version id is that time).
  const configPath = join(base, 'config', 'world.json');
  let cached = null;
  async function readConfig(asked) {
    if (asked !== name) return null;
    let info;
    try { info = await stat(configPath); } catch { return null; }
    const versionId = `local:${Math.round(info.mtimeMs)}`;
    if (cached?.versionId !== versionId) {
      let config = null;
      try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { log(`config/world.json: ${error.message}`); }
      cached = {versionId, config};
    }
    return cached.config ? cached : null;
  }
  const worlds = createWorlds({store, readConfig, secret: 'local', limits});
  const embedders = [...PUBLIC_EMBEDDERS, ...frameAncestors];

  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra});
    res.end(JSON.stringify(body));
  };
  const runLater = r => { if (r.later) r.later().catch(error => log(`world snapshot failed: ${error.message}`)); };
  const readBody = req => new Promise(done => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > limits.pushBytes) { over = true; done(null); req.resume(); return; } chunks.push(c); });
    req.on('end', () => { if (!over) done(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => done(null));
  });

  async function world(req, res, url, m) {
    const [, slugAsked, seq] = m;
    const net = req.socket.remoteAddress || '?';
    if (seq != null) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {error: 'bad', reason: 'GET only'}, {allow: 'GET'});
      const r = await worlds.snapshot(slugAsked, seq, {net});
      if (!r.bytes) return json(res, r.status, r.body);
      res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(r.bytes.byteLength), 'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin'});
      return res.end(req.method === 'HEAD' ? undefined : Buffer.from(r.bytes));
    }
    if (req.method === 'GET') {
      const r = await worlds.get(slugAsked, {after: url.searchParams.get('after'), net});
      json(res, r.status, r.body, r.status === 429 ? {'retry-after': String(r.body.retryAfter)} : {});
      return runLater(r);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, {error: 'too-large', reason: `at most ${limits.pushBytes} bytes a push`});
      const r = await worlds.push(slugAsked, body, {net, origin: req.headers.origin ?? null, host: req.headers.host ?? ''});
      json(res, r.status, r.body, r.status === 429 ? {'retry-after': String(r.body.retryAfter)} : {});
      return runLater(r);
    }
    return json(res, 405, {error: 'bad', reason: 'GET or POST'}, {allow: 'GET, POST'});
  }

  async function file(req, res, url) {
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, {...(csp ? playHeaders({studioOrigin: null, mime: type, embedders, connect: relayOrigin ? [relayOrigin] : []}) : {'content-type': type, 'x-content-type-options': 'nosniff'}), 'cache-control': 'no-store', ...extra});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    const prefix = `/p/${name}`;
    if (url.pathname === prefix) { res.writeHead(308, {location: `${prefix}/${url.search}`, 'cache-control': 'no-store'}); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice(prefix.length + 1)); } catch { return send(400, 'bad path'); }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const path = resolve(base, rel);
    if (!path.startsWith(base + sep)) return send(404, 'not found');
    try {
      const info = await stat(path);
      if (info.isDirectory()) { res.writeHead(308, {location: `${url.pathname}/${url.search}`, 'cache-control': 'no-store'}); return res.end(); }
      return send(200, await readFile(path), mimeFor(path));
    } catch { return send(404, 'not found'); }
  }

  const server = createServer(async (req, res) => {
    try {
      if (sig.handleHttp(req, res)) return;                     // POST /signal/v1, GET /signal/v1/ice
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/watch/v1') return json(res, 200, {v: 1, relay: relay ? `ws://${req.headers.host}/watch/v1/` : null, studio: studio ?? null});   // studio: a check's stand-in Studio origin (gf-multiplayer 1.7.2 voice chat)
      if (relay?.handleHttp(req, res)) return;                  // GET /watch/v1/<id> (a stream's state), /watch/v1/health
      if (url.pathname === '/') { res.writeHead(302, {location: `/p/${name}/${FRIENDS_PAGE}`, 'cache-control': 'no-store'}); return res.end(); }
      const m = /^\/world\/v1\/([^/]+)(?:\/snap\/([^/]+))?$/.exec(url.pathname);
      if (m) return await world(req, res, url, m);
      if (url.pathname === `/p/${name}` || url.pathname.startsWith(`/p/${name}/`)) return await file(req, res, url);
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end('not found');
    } catch (error) {
      log(`error: ${error.message}`);
      if (!res.headersSent) json(res, 503, {error: 'unavailable', reason: 'try again'});
      else res.end();
    }
  });
  const sig = attachSignaling(server, {path: '/signal', log});
  const relay = watch ? attachWatchRelay(server, {path: '/watch/v1/', log}) : null;
  let relayOrigin = null;
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, ok); });
  const at = server.address().port, origin = `http://${host}:${at}`;
  if (relay) relayOrigin = `ws://${host}:${at}`;
  return {
    url: `${origin}/`, friendsUrl: `${origin}/p/${name}/${FRIENDS_PAGE}`, gameUrl: `${origin}/p/${name}/`, apiUrl: `${origin}/world/v1/${name}`,
    port: at, slug: name, data: dataDir, worlds, sig, relay, server,
    close: () => new Promise(done => { sig.close(); relay?.close(); server.close(() => { store.close?.(); done(); }); server.closeAllConnections?.(); }),
  };
}

const USAGE = 'usage: serve.mjs <game-dir> [--port 5812] [--slug <slug>] [--data <dir>] [--memory] [--csp] [--no-watch] [--host 127.0.0.1] [--frame-ancestor <origin>]';
if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const valued = new Set(['--port', '--slug', '--data', '--host', '--frame-ancestor']);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dir = a.find((x, i) => !x.startsWith('--') && !valued.has(a[i - 1]));
  if (!dir || a.includes('--help')) { console.error(USAGE); process.exit(dir ? 0 : 2); }
  try {
    const s = await startWorldServer({dir, port: Number(opt('--port', DEFAULT_PORT)), host: opt('--host', '127.0.0.1'), slug: opt('--slug', null),
      data: opt('--data', null), memory: a.includes('--memory'), csp: a.includes('--csp'), watch: !a.includes('--no-watch'),
      frameAncestors: a.flatMap((x, i) => (x === '--frame-ancestor' && a[i + 1] ? [a[i + 1]] : [])), log: line => console.log(line)});
    console.log(`world     ${s.friendsUrl}   (the world card; ${s.url} redirects here)`);
    console.log(`game      ${s.gameUrl}`);
    console.log(`saves     ${s.apiUrl}`);
    console.log(`signaling ${s.url}signal/v1 (HTTP), ws://${new URL(s.url).host}/signal`);
    if (s.relay) console.log(`streams   ws://${new URL(s.url).host}/watch/v1/<id>   (watch then play; a viewer opens ${s.friendsUrl}?watch=<id>)`);
    console.log(`data      ${s.data ?? 'memory: nothing is kept'}${a.includes('--csp') ? '   headers: the play origin\'s (--csp)' : ''}`);
    const stop = () => { s.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
