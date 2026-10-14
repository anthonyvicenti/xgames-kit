// A game's own server: leaderboards, saves and a live score feed for one games.fun game (gamesfun-kit, MIT).
// One file, no dependencies, Node 22 or newer. `gamesfun backend connect railway` deploys it to the person's own
// Railway account; it runs the same anywhere Node runs (`node server.js`), so a deploy button on another host works too.
//
// What a game may do (only from the origins in GF_ORIGINS, exactly; no wildcard):
//   GET  /health                          → { ok, version }                        (anyone; the host's health check)
//   POST /v1/players                      → { id, token }                          a new anonymous player
//   GET  /v1/scores/<board>?limit=10      → { board, scores: [{ name, score, at }] }
//   POST /v1/scores/<board>  { score, name? }   Bearer <player token>  → { best, rank }   keeps each player's best
//   GET  /v1/saves/me                     Bearer <player token>  → { data, updatedAt }
//   PUT  /v1/saves/me        { data }     Bearer <player token>  → { updatedAt }    (at most GF_MAX_SAVE_BYTES)
//   WS   /v1/live?board=<board>           pushes { type: 'scores', board, scores } when the board changes
//
// The one secret, GF_SECRET, never leaves this server: it signs each player's token (HMAC-SHA256), so a write needs a
// token this server issued, and a player can only change their own save. The game holds only its player's token.
// What this does not stop: anyone can ask for a new player and post a score from a script (CORS stops other web
// pages, not programs). Scores are bounded (GF_MAX_SCORE) and rate-limited; a game that needs cheat-proof scores
// must have the server play the round, which this template does not.
//
// Variables (the kit sets them on Railway; all optional when you run it yourself):
//   PORT                  the port to listen on (Railway sets it)                                   default 8080
//   GF_SECRET             signs player tokens; 32+ characters. Without it a random one is made at start and every
//                         player token dies at restart (fine on your own machine, wrong on a host)
//   GF_ORIGINS            the game's exact origins, comma-separated (https://games-fun-play.vercel.app,http://127.0.0.1:5180)
//   GF_DATA_DIR           where scores and saves are kept (a volume on a host); default RAILWAY_VOLUME_MOUNT_PATH,
//                         else ./data. Without a volume, a host's disk is wiped at each deploy
//   GF_MAX_SCORE          the largest score accepted (absolute value)                               default 1000000000
//   GF_MAX_SAVE_BYTES     the largest save                                                          default 65536
//   GF_TRUST_PROXY        1 when a proxy in front sets X-Forwarded-For (Railway does; the kit sets it)
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
const BOARD = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_BOARDS = 50, MAX_ROWS = 1000, MAX_BODY = 256 * 1024, MAX_SOCKETS = 500, MAX_FRAME = 4096;

/** The settings from the environment, checked. → { port, secret, secretMade, origins, dataDir, maxScore, maxSave, trustProxy } */
export function settings(env = process.env) {
  const origins = String(env.GF_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(o => {
    let u; try { u = new URL(o); } catch { throw new Error(`GF_ORIGINS: ${JSON.stringify(o)} is not an origin`); }
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== o.replace(/\/+$/, '').toLowerCase() || o.includes('*')) throw new Error(`GF_ORIGINS: ${JSON.stringify(o)} must be an exact origin like https://example.com (no path, no wildcard)`);
    return u.origin;
  });
  const secret = env.GF_SECRET ?? '';
  if (secret && secret.length < 32) throw new Error('GF_SECRET must be at least 32 characters');
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    port: env.PORT === '0' ? 0 : num(env.PORT, 8080),            // 0: any free port (tests)
    secret: secret || randomBytes(32).toString('base64url'),
    secretMade: !secret,
    origins: [...new Set(origins)],
    dataDir: path.resolve(env.GF_DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || 'data'),
    maxScore: num(env.GF_MAX_SCORE, 1e9),
    maxSave: num(env.GF_MAX_SAVE_BYTES, 65536),
    trustProxy: env.GF_TRUST_PROXY === '1',
  };
}

// ------------------------------------------------------------------ the store: one JSON file, written atomically
function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gf-server.json');
  let db = { boards: {}, saves: {} };
  try { const v = JSON.parse(readFileSync(file, 'utf8')); if (v && typeof v === 'object') db = { boards: v.boards ?? {}, saves: v.saves ?? {} }; } catch {}
  let timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, file);
  };
  return { db, file, dirty() { if (!timer) timer = setTimeout(flush, 300); }, flush };
}

// ------------------------------------------------------------------ player tokens: <id>.<hmac>
const sign = (secret, id) => createHmac('sha256', secret).update(`player:${id}`).digest('base64url');
export const issueToken = (secret, id) => `${id}.${sign(secret, id)}`;
export function playerOf(secret, header) {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(header ?? ''));
  if (!m) return null;
  const want = Buffer.from(sign(secret, m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}

// ------------------------------------------------------------------ rate limits: a fixed window per key
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    if (hits.size > 50000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return ++h.n <= max;
  };
}

const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || 'player';

/** Start the server. → { server, url, port, close(), store } */
export async function start(env = process.env, { log = (...a) => console.log(...a) } = {}) {
  const cfg = settings(env);
  if (cfg.secretMade) log('gf-server: no GF_SECRET set; made one for this run (player tokens end when it stops)');
  if (!cfg.origins.length) log('gf-server: no GF_ORIGINS set; no web page may call this server');
  const store = openStore(cfg.dataDir);
  const { db } = store;
  const newPlayers = limiter(30, 60 * 60 * 1000), writes = limiter(60, 60 * 1000), sockets = new Map();

  const top = (board, limit = 10) => (db.boards[board] ?? []).slice(0, Math.max(1, Math.min(100, limit))).map(r => ({ name: r.name, score: r.score, at: r.at }));
  const corsFor = origin => (origin && cfg.origins.includes(origin) ? origin : null);
  const ipOf = req => (cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

  function send(res, status, body, origin) {
    const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' };
    if (origin) Object.assign(h, { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-max-age': '600' });
    res.writeHead(status, h);
    res.end(body === null ? '' : JSON.stringify(body));
  }

  const readJson = req => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('not JSON'), { status: 400 })); } });
    req.on('error', reject);
  });

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    // a browser on any other site is refused outright; programs (no Origin) are not stopped by CORS anyway
    if (origin !== undefined && !corsFor(origin) && u.pathname !== '/health') return send(res, 403, { error: 'this origin may not use this server' });
    const allow = corsFor(origin);
    if (req.method === 'OPTIONS') return send(res, 204, null, allow);
    if (u.pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION }, allow);

    if (u.pathname === '/v1/players' && req.method === 'POST') {
      if (!newPlayers(ipOf(req))) return send(res, 429, { error: 'too many new players from here; try later' }, allow);
      const id = randomUUID();
      return send(res, 201, { id, token: issueToken(cfg.secret, id) }, allow);
    }

    const sm = /^\/v1\/scores\/([^/]+)$/.exec(u.pathname);
    if (sm) {
      const board = decodeURIComponent(sm[1]);
      if (!BOARD.test(board)) return send(res, 400, { error: 'a board name is 1–32 of a-z 0-9 _ -' }, allow);
      if (req.method === 'GET') return send(res, 200, { board, scores: top(board, Number(u.searchParams.get('limit') ?? 10)) }, allow);
      if (req.method === 'POST') {
        const who = playerOf(cfg.secret, req.headers.authorization);
        if (!who) return send(res, 401, { error: 'a player token is needed (POST /v1/players)' }, allow);
        if (!writes(who)) return send(res, 429, { error: 'too many writes; slow down' }, allow);
        const b = await readJson(req);
        const score = Number(b.score);
        if (!Number.isFinite(score) || Math.abs(score) > cfg.maxScore) return send(res, 400, { error: `score must be a number within ±${cfg.maxScore}` }, allow);
        if (!db.boards[board] && Object.keys(db.boards).length >= MAX_BOARDS) return send(res, 400, { error: `at most ${MAX_BOARDS} boards` }, allow);
        const rows = db.boards[board] ??= [];
        const mine = rows.find(r => r.player === who);
        const name = cleanName(b.name);
        if (mine) { mine.name = name; if (score > mine.score) { mine.score = score; mine.at = new Date().toISOString(); } }
        else rows.push({ player: who, name, score, at: new Date().toISOString() });
        rows.sort((a, c) => c.score - a.score || a.at.localeCompare(c.at));
        rows.length = Math.min(rows.length, MAX_ROWS);
        const at = rows.findIndex(r => r.player === who);
        store.dirty();
        broadcast(board);
        return send(res, 200, { best: at >= 0 ? rows[at].score : score, rank: at >= 0 ? at + 1 : null }, allow);
      }
      return send(res, 405, { error: 'GET or POST' }, allow);
    }

    if (u.pathname === '/v1/saves/me') {
      const who = playerOf(cfg.secret, req.headers.authorization);
      if (!who) return send(res, 401, { error: 'a player token is needed (POST /v1/players)' }, allow);
      if (req.method === 'GET') { const s = db.saves[who]; return send(res, 200, { data: s?.data ?? null, updatedAt: s?.updatedAt ?? null }, allow); }
      if (req.method === 'PUT') {
        if (!writes(who)) return send(res, 429, { error: 'too many writes; slow down' }, allow);
        const b = await readJson(req);
        const text = JSON.stringify(b.data ?? null);
        if (Buffer.byteLength(text) > cfg.maxSave) return send(res, 413, { error: `a save is at most ${cfg.maxSave} bytes` }, allow);
        db.saves[who] = { data: JSON.parse(text), updatedAt: new Date().toISOString() };
        store.dirty();
        return send(res, 200, { updatedAt: db.saves[who].updatedAt }, allow);
      }
      return send(res, 405, { error: 'GET or PUT' }, allow);
    }
    return send(res, 404, { error: 'not here' }, allow);
  }

  // ---------------------------------------------------------------- WebSocket (RFC 6455): server → game pushes only
  const frame = (op, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const head = data.length < 126 ? Buffer.from([0x80 | op, data.length])
      : data.length < 65536 ? Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 255])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(data.length), 2); return b; })();
    return Buffer.concat([head, data]);
  };
  function broadcast(board) {
    const msg = frame(1, JSON.stringify({ type: 'scores', board, scores: top(board) }));
    for (const [sock, s] of sockets) if (s.board === board) sock.write(msg);
  }
  function upgrade(req, sock) {
    const refuse = (code, why) => { sock.end(`HTTP/1.1 ${code} ${why}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/v1/live') return refuse(404, 'Not Found');
    if (!corsFor(req.headers.origin)) return refuse(403, 'Forbidden');
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['sec-websocket-version'] !== '13' || !/websocket/i.test(req.headers.upgrade ?? '')) return refuse(400, 'Bad Request');
    const board = u.searchParams.get('board') ?? 'main';
    if (!BOARD.test(board)) return refuse(400, 'Bad Request');
    if (sockets.size >= MAX_SOCKETS) return refuse(503, 'Service Unavailable');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);
    const s = { board, buf: Buffer.alloc(0), alive: true };
    sockets.set(sock, s);
    const drop = () => { sockets.delete(sock); sock.destroy(); };
    sock.on('data', chunk => {
      s.buf = Buffer.concat([s.buf, chunk]);
      while (s.buf.length >= 2) {
        const op = s.buf[0] & 0x0f, masked = s.buf[1] & 0x80;
        let len = s.buf[1] & 0x7f, off = 2;
        if (len === 126) { if (s.buf.length < 4) return; len = s.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) return drop();                     // nothing a game sends is that big
        if (!masked || len > MAX_FRAME) return drop();           // RFC 6455 §5.1: a client always masks
        if (s.buf.length < off + 4 + len) return;
        const mask = s.buf.subarray(off, off + 4), data = Buffer.from(s.buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        s.buf = s.buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(frame(8, Buffer.alloc(0))); sockets.delete(sock); return; }
        if (op === 9) sock.write(frame(10, data));
        else if (op === 10) s.alive = true;
        else if (op === 1 && data.toString('utf8') === '{"type":"ping"}') sock.write(frame(1, '{"type":"pong"}'));
      }
    });
    sock.on('error', drop);
    sock.on('close', () => sockets.delete(sock));
    sock.write(frame(1, JSON.stringify({ type: 'scores', board, scores: top(board) })));
  }
  const beat = setInterval(() => {
    for (const [sock, s] of sockets) { if (!s.alive) { sockets.delete(sock); sock.destroy(); continue; } s.alive = false; sock.write(frame(9, Buffer.alloc(0))); }
  }, 30000);
  beat.unref();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'server error' }, corsFor(req.headers.origin)); if (!e.status) log(`gf-server: ${e.stack ?? e}`); });
  });
  server.on('upgrade', upgrade);
  server.headersTimeout = 15000; server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, env.GF_HOST || undefined, resolve); });
  const port = server.address().port;
  log(`gf-server ${VERSION} on port ${port}; origins: ${cfg.origins.join(', ') || 'none'}; data in ${store.file}`);
  const close = () => new Promise(resolve => {
    clearInterval(beat);
    for (const sock of sockets.keys()) sock.destroy();
    sockets.clear();
    try { store.flush(); } catch (e) { log(`gf-server: could not write ${store.file}: ${e.message}`); }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return { server, port, url: `http://127.0.0.1:${port}`, close, store };
}

// `node server.js` runs it; importing it (tests) does not
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then(s => {
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, e => { console.error(`gf-server did not start: ${e.message}`); process.exit(1); });
}
