// games.fun host-join kit: minimal WebRTC SIGNALING server (Node). It only introduces a joiner to a host:
// it maps a 6-character room code to the host and relays offer / answer / ICE candidates. It never sees game
// traffic (that flows host ↔ joiner over the WebRTC data channel), and it forgets a room when the host leaves.
// Two transports on one server, with the same codes, payload checks and limits:
//   WebSocket at /signal     vendored ws 8.21.3 (MIT, vendor/ws/LICENSE, vendor/ATTRIBUTION.md). The kit's default on
//                            localhost / 127.0.0.1.
//   HTTP at /signal/v1       POST {op, ...} with a long-poll, and GET /signal/v1/ice: the protocol in
//                            builder/studio-lib/signal-core.mjs, shared with Studio's play origin (which runs it on
//                            Postgres; here it runs on memoryStore()). The kit (gf-multiplayer 1.3.0+) uses it on every
//                            other host, and here when a page asks for ?signal=http.
// Rooms belong to one transport: a host and its joiners use the same one (the kit's invite links keep ?signal=).
//
//   import { attachSignaling } from './signal-server.mjs';
//   const sig = attachSignaling(httpServer, { path: '/signal' });
//   // first thing in the server's request handler (HTTP signaling):  if (sig.handleHttp(req, res)) return;
//
// WebSocket protocol (JSON text frames):
//   host   → {t:'host'}                          ← {t:'hosted', code}
//   joiner → {t:'join', code}                    ← {t:'joined', peer}      host ← {t:'peer', peer}
//   either → {t:'signal', to?, data}             data = {sdp:{type:'offer'|'answer', sdp}} | {ice: candidate|null}
//            (a joiner's `to` is ignored: joiners can only talk to their host; the host must name a live peer)
//                                                 ← {t:'signal', from, data}
//   joiner closes / {t:'leave'}                  host ← {t:'peer-left', peer}
//   host closes                                  every pending joiner ← {t:'host-left'}; the code is forgotten
//   errors                                       ← {t:'error', code, reason}   codes: no-room, rate, busy, bad, full, taken
// World rooms (gf-multiplayer 1.5.0): one live room per key 'world:<slug>' (signal-core.mjs WORLD_KEY), the same
// semantics as the HTTP transport's:
//   anyone → {t:'find', key}                     ← {t:'found', code, n, max} | {t:'none'}   (a join attempt for the limits)
//   host   → {t:'host', key, max?}               ← {t:'hosted', code} | {t:'error', code:'taken', room, n, max}
//   host   → {t:'seats', n, max}                 the room's seats (find answers with them). Every message from a host
//                                                 counts as a sign of life: a keyed room whose host sent nothing for
//                                                 worldSilentMs (12 s) is not found, and the next claim closes it (its
//                                                 joiners ← host-left, its host's socket is closed). The kit sends seats
//                                                 every 4 s.
// The HTTP protocol carries the same messages as requests and a long-poll (signal-core.mjs, at the top).
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from './vendor/ws/wrapper.mjs';
import { CODE_ALPHABET, SIGNAL_LIMITS, cleanKey, createSignaling, makeCode as coreMakeCode, memoryStore, validSignal } from '../../studio-lib/signal-core.mjs';

export { CODE_ALPHABET, SIGNAL_LIMITS };

/** A room code (signal-core.mjs makeCode), from Node's randomBytes by default. */
export function makeCode(bytes = randomBytes) { return coreMakeCode(bytes); }

export function attachSignaling(httpServer, options = {}) {
  const opt = { path: '/signal', checkOrigin: true, log: () => {}, env: process.env, ...options };
  const clock = typeof opt.now === 'function' ? opt.now : Date.now;   // the WebSocket transport's clock (tests move it)
  const httpPath = opt.httpPath ?? `${opt.path}/v1`;
  const rooms = new Map();          // code → {host: ws, peers: Map(peerId → ws), key, n, max, seen}
  const keys = new Map();           // world key → code (kit 1.5.0)
  const ipSockets = new Map();      // ip → count
  const ipJoins = new Map();        // ip → [timestamps]
  const stats = { rooms: 0, joins: 0, relayed: 0, rejected: 0, worldRooms: 0, finds: 0, rateLimited: 0 };
  const wss = new WebSocketServer({ noServer: true, maxPayload: SIGNAL_LIMITS.frameBytes });
  // HTTP signaling: the shared protocol on an in-memory store. Closing the server ends every waiting long-poll.
  const http = createSignaling({ store: memoryStore(), secret: randomBytes(32).toString('hex'), checkOrigin: opt.checkOrigin });
  const closing = new AbortController();

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== opt.path) return;
    if (opt.checkOrigin && req.headers.origin) {
      let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
      if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    }
    const ip = req.socket.remoteAddress || '?';
    if ((ipSockets.get(ip) ?? 0) >= SIGNAL_LIMITS.socketsPerIp) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, ip));
  }
  httpServer.on('upgrade', onUpgrade);

  // POST <httpPath> and GET <httpPath>/ice. Returns false for any other path, so the caller serves it.
  function handleHttp(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return false; }
    if (pathname !== httpPath && pathname !== `${httpPath}/ice`) return false;
    const reply = (status, body, extra = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    if (pathname.endsWith('/ice')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { reply(405, { t: 'error', code: 'bad', reason: 'GET only' }, { allow: 'GET' }); return true; }
      const r = http.ice({ origin: req.headers.origin ?? null, host: req.headers.host, env: opt.env });
      reply(r.status, r.body);
      return true;
    }
    if (req.method !== 'POST') { reply(405, { t: 'error', code: 'bad', reason: 'POST {op, ...} here' }, { allow: 'POST' }); return true; }
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > SIGNAL_LIMITS.frameBytes) { over = true; reply(413, { t: 'error', code: 'bad', reason: 'request too large' }); req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => {
      if (over) return;
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      try {
        const r = await http.request({ origin: req.headers.origin ?? null, host: req.headers.host, ip: req.socket.remoteAddress || '?',
          body: Buffer.concat(chunks).toString('utf8'), signal: AbortSignal.any([gone.signal, closing.signal]) });
        reply(r.status, r.body);
      } catch (e) { opt.log(`http signaling error: ${e.message}`); reply(503, { t: 'error', code: 'busy', reason: 'signaling failed, try again' }); }
    });
    req.on('error', () => {});
    return true;
  }

  function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
  function err(ws, code, reason) { stats.rejected++; send(ws, { t: 'error', code, reason }); }

  // World rooms: the live room holding a key (its host spoke within worldSilentMs), else null.
  function liveKeyRoom(key, now) {
    const code = keys.get(key), room = code && rooms.get(code);
    if (!room) { keys.delete(key); return null; }
    return now - room.seen < SIGNAL_LIMITS.worldSilentMs ? { code, room } : null;
  }
  // A keyed room whose host went quiet, closed by the next claim: its joiners hear host-left, and its host's socket is
  // told and closed (a host that wakes up learns it no longer holds the world, and the kit steps down).
  function closeQuietRoom(code, room) {
    rooms.delete(code);
    if (keys.get(room.key) === code) keys.delete(room.key);
    for (const p of room.peers.values()) { send(p, { t: 'host-left' }); try { p.close(1000, 'host left'); } catch {} }
    send(room.host, { t: 'error', code: 'no-room', reason: 'another copy hosts this world now' });
    try { room.host.close(1000, 'replaced'); } catch {}
    opt.log(`room ${code} closed (its host was quiet; ${room.key} taken over)`);
  }

  function onConnection(ws, ip) {
    ipSockets.set(ip, (ipSockets.get(ip) ?? 0) + 1);
    const me = { role: null, code: null, peer: null, tokens: SIGNAL_LIMITS.burst, last: clock(), joins: 0, alive: true };
    const idle = setTimeout(() => { if (me.role !== 'host') ws.close(1000, 'signaling idle'); }, SIGNAL_LIMITS.joinerIdleMs);
    ws.on('pong', () => { me.alive = true; });

    ws.on('message', (raw, isBinary) => {
      const now = clock();
      me.tokens = Math.min(SIGNAL_LIMITS.burst, me.tokens + ((now - me.last) / 1000) * SIGNAL_LIMITS.ratePerSec); me.last = now;
      if (me.tokens < 1) { err(ws, 'rate', 'too many messages'); return; }
      me.tokens -= 1;
      if (isBinary) return err(ws, 'bad', 'text frames only');
      let m; try { m = JSON.parse(raw.toString()); } catch { return err(ws, 'bad', 'not JSON'); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return err(ws, 'bad', 'not an object');
      if (me.role === 'host') { const r = rooms.get(me.code); if (r && r.host === ws) r.seen = now; }   // a host's sign of life
      // A join attempt (a join, or a world find): per socket and per network per minute.
      const attempt = () => {
        me.joins++;
        const list = (ipJoins.get(ip) ?? []).filter(t => now - t < 60_000); list.push(now); ipJoins.set(ip, list);
        if (me.joins > SIGNAL_LIMITS.joinsPerSocket || list.length > SIGNAL_LIMITS.joinsPerIpPerMin) { stats.rateLimited++; err(ws, 'rate', 'too many join attempts'); ws.close(1008, 'join rate'); return false; }
        return true;
      };

      if (m.t === 'host') {
        if (me.role) return err(ws, 'bad', 'already in a room');
        if (rooms.size >= SIGNAL_LIMITS.maxRooms) return err(ws, 'busy', 'signaling is full, try again soon');
        const key = m.key === undefined ? null : cleanKey(m.key);
        if (m.key !== undefined && !key) return err(ws, 'bad', 'key must be world:<slug> (lowercase letters, digits and dashes)');
        if (key) {
          const live = liveKeyRoom(key, now);
          if (live) { stats.rejected++; return send(ws, { t: 'error', code: 'taken', reason: 'someone already hosts this world', room: live.code, n: live.room.n ?? 1, max: live.room.max ?? SIGNAL_LIMITS.worldMaxSeats }); }
          const quiet = keys.get(key);
          if (quiet && rooms.has(quiet)) closeQuietRoom(quiet, rooms.get(quiet));
        }
        let code; do { code = makeCode(); } while (rooms.has(code));
        const max = Number.isInteger(m.max) && m.max >= 1 && m.max <= SIGNAL_LIMITS.worldMaxSeats ? m.max : SIGNAL_LIMITS.worldMaxSeats;
        rooms.set(code, key ? { host: ws, peers: new Map(), key, n: 1, max, seen: now } : { host: ws, peers: new Map() });
        if (key) { keys.set(key, code); stats.worldRooms++; }
        me.role = 'host'; me.code = code; stats.rooms++;
        clearTimeout(idle);
        opt.log(`room ${code} hosted${key ? ` for ${key}` : ''}`);
        return send(ws, { t: 'hosted', code });
      }
      if (m.t === 'find') {
        if (me.role) return err(ws, 'bad', 'already in a room');
        const key = cleanKey(m.key);
        if (!key) return err(ws, 'bad', 'key must be world:<slug> (lowercase letters, digits and dashes)');
        if (!attempt()) return;
        stats.finds++;
        const live = liveKeyRoom(key, now);
        return send(ws, live ? { t: 'found', code: live.code, n: live.room.n ?? 1, max: live.room.max ?? SIGNAL_LIMITS.worldMaxSeats } : { t: 'none' });
      }
      if (m.t === 'seats') {
        const r = me.role === 'host' && rooms.get(me.code);
        if (!r || r.host !== ws || !r.key) return err(ws, 'bad', 'only a world room\'s host reports seats');
        if (Number.isInteger(m.n) && m.n >= 0 && m.n <= 16 && Number.isInteger(m.max) && m.max >= 1 && m.max <= SIGNAL_LIMITS.worldMaxSeats) { r.n = m.n; r.max = m.max; }
        return;
      }
      if (m.t === 'join') {
        if (me.role) return err(ws, 'bad', 'already in a room');
        if (!attempt()) return;
        const code = typeof m.code === 'string' ? m.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        const room = rooms.get(code);
        if (!room || (room.key && now - room.seen >= SIGNAL_LIMITS.worldSilentMs)) return err(ws, 'no-room', 'no game with that code (the host may have left)');
        if (room.peers.size >= SIGNAL_LIMITS.pendingPerRoom) return err(ws, 'busy', 'too many players joining at once, try again');
        const peer = randomBytes(6).toString('base64url');
        room.peers.set(peer, ws);
        me.role = 'joiner'; me.code = code; me.peer = peer; stats.joins++;
        send(ws, { t: 'joined', peer });
        return send(room.host, { t: 'peer', peer });
      }
      if (m.t === 'signal') {
        const room = me.code && rooms.get(me.code);
        if (!room) return err(ws, 'no-room', 'not in a room');
        if (!validSignal(m.data)) return err(ws, 'bad', 'signal data must be {sdp:{type,sdp}} or {ice}');
        if (me.role === 'host') {
          const target = typeof m.to === 'string' && room.peers.get(m.to);
          if (!target) return err(ws, 'bad', 'no such peer');
          stats.relayed++;
          return send(target, { t: 'signal', from: 'host', data: m.data });
        }
        stats.relayed++;
        return send(room.host, { t: 'signal', from: me.peer, data: m.data });
      }
      if (m.t === 'leave') return ws.close(1000, 'left');
      return err(ws, 'bad', 'unknown message type (signaling carries no game traffic)');
    });

    ws.on('close', () => {
      clearTimeout(idle);
      ipSockets.set(ip, Math.max(0, (ipSockets.get(ip) ?? 1) - 1));
      if (!ipSockets.get(ip)) ipSockets.delete(ip);
      const room = me.code && rooms.get(me.code);
      if (!room) return;
      if (me.role === 'host' && room.host === ws) {
        rooms.delete(me.code);                              // forget the room at once
        if (room.key && keys.get(room.key) === me.code) keys.delete(room.key);   // a world's key is free at once
        for (const p of room.peers.values()) { send(p, { t: 'host-left' }); try { p.close(1000, 'host left'); } catch {} }
        opt.log(`room ${me.code} closed (host left)`);
      } else if (me.role === 'joiner' && room.peers.get(me.peer) === ws) {
        room.peers.delete(me.peer);
        send(room.host, { t: 'peer-left', peer: me.peer });
      }
    });
    ws.on('error', () => {});
  }

  const beat = setInterval(() => {
    for (const ws of wss.clients) { if (ws.__dead) { ws.terminate(); continue; } ws.__dead = true; try { ws.ping(); } catch {} ws.once('pong', () => { ws.__dead = false; }); }
  }, SIGNAL_LIMITS.heartbeatMs);
  beat.unref?.();

  return {
    // sockets: open WebSockets; http*: the HTTP transport (requests of any kind, rooms opened, open sessions)
    stats: () => { const h = http.stats(), size = http.store.size(); return { ...stats, openRooms: rooms.size, sockets: wss.clients.size, httpRequests: h.requests, httpRooms: h.rooms, httpJoins: h.joins, httpRelayed: h.relayed, httpSessions: size.peers,
      httpFinds: h.finds, httpWorldRooms: h.worldRooms, httpRejected: h.rejected, httpRateLimited: h.rateLimited }; },
    hasRoom: code => rooms.has(code),
    worldRoom: key => { const c = keys.get(key); return c && rooms.has(c) ? c : null; },     // the code holding a world key (WebSocket)
    hasHttpRoom: async code => { const r = await http.store.room(code); return !!r && r.closed == null; },
    handleHttp,
    http,
    close() { closing.abort(); clearInterval(beat); httpServer.off('upgrade', onUpgrade); for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
