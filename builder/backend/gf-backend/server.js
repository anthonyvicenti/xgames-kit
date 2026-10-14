// gf-backend/server.js: a game's calls to its own game server (the kit's template, builder/templates/backends/railway-node/;
// gamesfun-kit, MIT). The kit copies it into a game at gf/backend/ with index.js; never edit the copy.
//
//   import { connectGameServer } from './gf/backend/server.js';
//   const srv = await connectGameServer();            // null when the game has no server in backend.json
//   await srv.submitScore('main', 120, 'Ann');         // { data: { best, rank }, error }
//   const { data } = await srv.topScores('main', 10);  // { data: { board, scores: [{ name, score, at }] }, error }
//   await srv.save({ level: 3 }); const { data: s } = await srv.load();
//   const stop = srv.live('main', scores => draw(scores));   // pushed when the board changes; stop() closes it
//
// The same rules as index.js: every call resolves to { data, error } and never throws, the game plays on when the
// server is away, and automated browsers (verify, play-testers) never touch the person's real server unless the page
// says ?gf-backend=on. The player's token (from the server, signed by its secret) is kept in this browser only.
import { backendOn, connectBackend } from './index.js';

const TIMEOUT_MS = 8000;
const store = {
  get(k) { try { return JSON.parse(globalThis.localStorage?.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch {} },
};
const warned = new Set();
const warn = (kind, msg) => { if (!warned.has(kind)) { warned.add(kind); console.warn(`gf-backend/server: ${msg}`); } };
const off = async () => ({ data: null, error: 'off', status: 0 });
const offServer = () => ({ on: false, url: null, player: null, submitScore: off, topScores: off, save: off, load: off, live: () => () => {} });

async function call(url, init) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { ...init, signal: ctl?.signal, cache: 'no-store', credentials: 'omit' });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) { const why = data?.error ?? String(res.status); warn(`fail:${res.status}`, `${init?.method ?? 'GET'} ${new URL(url).pathname} failed (${res.status}): ${why}`); return { data: null, error: why, status: res.status }; }
    return { data, error: null, status: res.status };
  } catch (e) {
    warn('unreachable', `the game server could not be reached (${e?.name === 'AbortError' ? 'timed out' : 'offline or blocked'}); the game plays on without it.`);
    return { data: null, error: 'unreachable', status: 0 };
  } finally { if (t) clearTimeout(t); }
}

/** The game's own server, from backend.json; null when it has none; an "off" server in automated browsers. */
export async function connectGameServer(opts = {}) {
  if (!backendOn()) return offServer();
  const b = await connectBackend(opts);
  if (!b) return null;
  if (!b.on) return offServer();
  if (b.provider === 'supabase' || !b.url) return null;          // a database, not a game server
  const base = String(b.url).replace(/\/+$/, '');
  const KEY = `gf-server:${base}`;
  let player = store.get(KEY);
  const srv = { on: true, url: base, get player() { return player ? { id: player.id } : null; } };

  async function token() {
    if (player?.token) return player.token;
    const r = await call(`${base}/v1/players`, { method: 'POST' });
    if (!r.data?.token) return null;
    player = { id: r.data.id, token: r.data.token };
    store.set(KEY, player);
    return player.token;
  }
  async function authed(method, p, body) {
    let t = await token();
    if (!t) return { data: null, error: 'no player', status: 0 };
    const send = () => call(`${base}${p}`, { method, headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let r = await send();
    if (r.status === 401) { player = null; t = await token(); if (t) r = await send(); }   // the server's secret changed: a new player
    return r;
  }
  const board = b => encodeURIComponent(String(b ?? 'main'));

  srv.submitScore = (b, score, name) => authed('POST', `/v1/scores/${board(b)}`, { score, ...(name != null ? { name: String(name) } : {}) });
  srv.topScores = (b, limit = 10) => call(`${base}/v1/scores/${board(b)}?limit=${Number(limit) || 10}`, { method: 'GET' });
  srv.save = data => authed('PUT', '/v1/saves/me', { data });
  srv.load = () => authed('GET', '/v1/saves/me');
  srv.live = (b, onScores) => {
    if (typeof WebSocket !== 'function') return () => {};
    let ws = null, stopped = false, wait = 1000, timer = null;
    const open = () => {
      if (stopped) return;
      try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/live?board=${board(b)}`); } catch { return; }
      ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.type === 'scores') { wait = 1000; onScores?.(m.scores, m.board); } } catch {} };
      ws.onclose = () => { if (!stopped) { timer = setTimeout(open, wait); wait = Math.min(wait * 2, 30000); } };
      ws.onerror = () => {};
    };
    open();
    return () => { stopped = true; clearTimeout(timer); try { ws?.close(); } catch {} };
  };
  return srv;
}
