// games.fun watch relay for Node (MIT): the channel rules of core.mjs on real WebSockets, attachable to any http.Server
// (builder/world-server/serve.mjs mounts it) or run on its own. Same rules as the Cloudflare Durable Object in cloudflare/.
// Uses the repo's vendored ws 8.21.3 (MIT, builder/multiplayer/p2p/vendor/ws/LICENSE).
//
//   import { attachWatchRelay } from './node.mjs';
//   const relay = attachWatchRelay(httpServer, { path: '/watch/v1/', origins: ['https://games-fun-play.vercel.app'] });
//   // first thing in the server's request handler:  if (relay.handleHttp(req, res)) return;
//
//   node builder/watch/relay/node.mjs --port 5831 [--host 127.0.0.1] [--data watch.json] [--origins a,b] [--max-viewers 200] [--max-per-ip 8]
//
// Protocol: watch/PLAN.md §3.2. Keys (as sha256) and meta live in memory; with `data` they are also written to
// that JSON file (a streamer's link then survives a restart). Cached key frames and deltas are never written.
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from '../../multiplayer/p2p/vendor/ws/wrapper.mjs';
import { Channel, LIMITS, WATCH_PATH, httpAnswer, originOk, parseOrigins, route } from './core.mjs';

const MAX_TIMER = 2 ** 31 - 1;

/** @returns {{handleHttp(req, res): boolean, close(): void, stats(): object}} */
export function attachWatchRelay(server, options = {}) {
  const env = options.env ?? process.env;
  const opt = { path: WATCH_PATH, log: () => {}, now: Date.now, ...options };
  if (!opt.path.endsWith('/')) opt.path += '/';
  const origins = parseOrigins(options.origins ?? env.WATCH_ORIGINS);
  const limits = { ...(opt.limits ?? {}) };
  const maxViewers = Number(opt.maxViewers ?? env.WATCH_MAX_VIEWERS);
  if (maxViewers > 0) limits.maxViewers = maxViewers;
  const maxPerIp = Number(opt.maxPerIp ?? env.WATCH_MAX_PER_IP);
  if (maxPerIp >= 0 && (opt.maxPerIp != null || env.WATCH_MAX_PER_IP)) limits.maxPerIp = maxPerIp;     // 0: no per-address cap
  if (opt.graceMs != null) limits.graceMs = opt.graceMs;
  if (opt.helloMs != null) limits.helloMs = opt.helloMs;

  // Records (hash, meta, times) per channel id: memory, plus the JSON file when `data` is given.
  let db = {};
  if (opt.data) try { db = JSON.parse(fs.readFileSync(opt.data, 'utf8')); } catch {}
  let writing = null;
  const persist = () => {
    if (!opt.data || writing) return;
    writing = setTimeout(() => {
      writing = null;
      try { fs.writeFileSync(`${opt.data}.tmp`, JSON.stringify(db)); fs.renameSync(`${opt.data}.tmp`, opt.data); } catch (e) { opt.log(`watch: cannot write ${opt.data}: ${e.message}`); }
    }, 200);
    writing.unref();
  };

  const channels = new Map();                       // id → {core, conns: Set, timer}
  const stats = { connections: 0, frames: 0, refused: 0 };
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrame });

  function open(id) {
    let c = channels.get(id);
    if (c) return c;
    c = { conns: new Set(), timer: null };
    c.core = new Channel({
      id, now: opt.now, limits,
      storage: { load: () => db[id] ?? null, save: r => { if (r) db[id] = r; else delete db[id]; persist(); } },
      io: {
        sockets: role => [...c.conns].filter(x => x.state.role === role),
        schedule(at) {
          clearTimeout(c.timer); c.timer = null;
          if (at != null) { c.timer = setTimeout(() => c.core.tick(), Math.min(MAX_TIMER, Math.max(0, at - opt.now()))); c.timer.unref(); }
        },
      },
    });
    channels.set(id, c);
    c.core.reconcile(); c.core.wake();                  // a record that was live when the process stopped starts its grace
    return c;
  }
  const peek = id => channels.get(id) ?? (db[id] ? open(id) : null);

  function onUpgrade(req, socket, head) {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return; }
    const r = route(url.pathname, opt.path);
    if (!r) return;                                                   // not ours
    const refuse = (code, why) => { stats.refused++; socket.write(`HTTP/1.1 ${code} ${why}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); socket.destroy(); };
    if (!originOk(req.headers.origin, origins)) return refuse(403, 'Forbidden');
    if (!r.id) return refuse(r.bad ? 400 : 404, r.bad ? 'Bad Request' : 'Not Found');
    const role = url.searchParams.get('role') === 'pub' ? 'pub' : 'viewer';
    wss.handleUpgrade(req, socket, head, ws => {
      const ch = open(r.id);
      const conn = {
        state: { role, ip: req.socket.remoteAddress ?? null },
        send: s => { if (ws.readyState === 1) ws.send(s); },
        close: (code, reason) => ws.close(code, reason),
        buffered: () => ws.bufferedAmount,
      };
      ch.conns.add(conn); stats.connections++;
      ws.on('message', (data, isBinary) => { stats.frames++; ch.core.message(conn, isBinary ? null : data.toString('utf8')); });
      const gone = () => { if (!ch.conns.delete(conn)) return; ch.core.closed(conn); };
      ws.on('close', gone); ws.on('error', () => { gone(); ws.terminate(); });
      ch.core.connect(conn);
    });
  }
  server.on('upgrade', onUpgrade);

  function handleHttp(req, res) {
    let pathname; try { pathname = new URL(req.url, 'http://x').pathname; } catch { return false; }
    const r = route(pathname, opt.path);
    if (!r) return false;
    const a = httpAnswer(req.method, r, () => (peek(r.id)?.core.info() ?? { v: 1, id: r.id, live: false, viewers: 0, meta: null, since: null }));
    res.writeHead(a.status, a.headers);
    res.end(a.body && req.method !== 'HEAD' ? JSON.stringify(a.body) : undefined);
    return true;
  }

  // Hourly: forget channels unused for 30 days; drop idle ones from memory (their records stay in db).
  const sweep = setInterval(() => {
    for (const [id, c] of channels) {
      c.core.expireIfOld();
      if (!c.conns.size && !c.core.rec.live) { clearTimeout(c.timer); channels.delete(id); }
    }
    for (const [id, r] of Object.entries(db)) if (!r.live && r.lastLive && opt.now() - r.lastLive >= (limits.expiryMs ?? LIMITS.expiryMs)) delete db[id];
    persist();
  }, 3600e3);
  sweep.unref();

  return {
    handleHttp,
    stats() {
      let live = 0, viewers = 0;
      for (const c of channels.values()) { if (c.core.rec.live) live++; viewers += c.core.viewers().length; }
      return { ...stats, channels: channels.size, known: Object.keys(db).length, live, viewers, sockets: wss.clients.size };
    },
    close() {
      clearInterval(sweep);
      for (const c of channels.values()) clearTimeout(c.timer);
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (writing) { clearTimeout(writing); writing = null; if (opt.data) try { fs.writeFileSync(opt.data, JSON.stringify(db)); } catch {} }
    },
  };
}

// CLI: a standalone relay.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const port = Number(arg('port', 5831)), host = arg('host', '127.0.0.1');
  const server = http.createServer();
  const relay = attachWatchRelay(server, { origins: arg('origins'), maxViewers: arg('max-viewers'), maxPerIp: arg('max-per-ip'), data: arg('data'), log: console.log });
  server.on('request', (req, res) => { if (!relay.handleHttp(req, res)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); } });
  server.listen(port, host, () => console.log(`watch relay on http://${host}:${port}${WATCH_PATH} (ws://${host}:${port}${WATCH_PATH}<id>)`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { relay.close(); server.close(); process.exit(0); });
}
