// Host-join signaling over HTTP: the protocol, its limits and an in-memory store. One module for both servers, so
// they can't drift: the play origin's routes (lib/signal-http.mjs: POST /signal/v1, GET /signal/v1/ice, Postgres
// store) and the local Node signaling server (builder/multiplayer/p2p/signal-server.mjs: the same HTTP endpoints
// with memoryStore(), beside its WebSocket at /signal). The client is the multiplayer kit's vendor/gf.js
// (gf-multiplayer/1.3.0+), which picks this transport on any non-loopback page.
// Pure module: no Node or DOM imports (Web Crypto and timers only), like lib/play-policy.mjs.
//
// Signaling only introduces a joiner to a host: a 6-character room code, then offer / answer / ICE candidates. Game
// traffic never passes through here (it flows host <-> joiner over a WebRTC data channel). Same semantics as the
// WebSocket server, as request/response:
//
//   POST /signal/v1  {op:'host'}                         -> {t:'hosted', code, peer, token}
//                    {op:'join', code}                   -> {t:'joined', peer, token}         host's queue <- {t:'peer', peer}
//                    {op:'signal', peer, token, to?, data} -> {ok:true}                       data = {sdp:{type,sdp}} | {ice}
//                                                        the other side's queue <- {t:'signal', from, data}
//                                                        (a joiner can only reach its host; the host must name a joiner)
//                    {op:'poll', peer, token, after}     -> {msgs:[...], last}   long-poll: answers at once when something
//                                                        is queued, else waits up to pollWaitMs; `after` acknowledges
//                                                        (deletes) every message up to that sequence number
//                    {op:'leave', peer, token}           -> {ok:true}   joiner: host <- {t:'peer-left', peer};
//                                                        host: every joiner <- {t:'host-left'}, the code is closed
//   errors           {t:'error', code, reason} with a 4xx/5xx status. Codes: no-room, rate, busy, bad, full, taken.
//
// World rooms (gf-multiplayer 1.5.0, worlds/PLAN.md): one live room per key `world:<slug>`, so everyone who
// opens a world lands in the same room with no code to type. A room is LIVE while it is open and its host was seen
// within worldSilentMs (12 s: a host's long-poll asks at least every pollWaitMs).
//                    {op:'find', key}                    -> {t:'found', code, n, max} | {t:'none'}   (counts as a join
//                                                        attempt for the per-network limit)
//                    {op:'host', key, max?}              -> {t:'hosted', code, peer, token} when no live room holds the
//                                                        key, else 409 {t:'error', code:'taken', reason, room, n, max}.
//                                                        The claim is atomic (one store call; Postgres: a partial unique
//                                                        index on the open rooms' key), and a holder silent for 12 s is
//                                                        closed in the same step (its pending joiners <- host-left)
//                    {op:'poll', ..., n?, max?}          a keyed room's host reports its seats (find returns them)
//                    {op:'join', code}                   a keyed room whose host has been silent for 12 s is no-room
//   GET /signal/v1/ice -> {v:1, signal:'http', iceServers}  (public STUN, plus TURN when TURN_URLS is set; Studio
//                                                        asks Cloudflare for short-lived TURN when CF_TURN_* is set)
//
// `token` is a secret per peer: only its SHA-256 is stored. Addresses are kept only as a keyed hash, for the per-network
// limits. Rooms whose host stops asking for 2 h are deleted, messages after 60 s, joiners 60 s after joining (a joiner
// that has its data channel leaves at once). A request whose Origin is not this host is refused.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ2345678';   // 31 letters: no I, O, 0, 1 (runtime/src/index.js)
export const SIGNAL_LIMITS = Object.freeze({
  frameBytes: 16 * 1024,        // a request (or WebSocket frame); an SDP offer is ~1-6 KB, nothing legitimate is bigger
  sdpChars: 12 * 1024,
  ratePerSec: 20, burst: 80,    // per peer (WebSocket: per socket); trickle ICE sends a burst of candidates
  joinsPerSocket: 5,            // WebSocket only: join attempts before the socket is refused
  joinsPerIpPerMin: 30,         // join attempts per network per minute (code guessing)
  findsPerIpPerMin: 300,        // world lookups per network per minute (the world card asks every 10 s while it shows;
                                // phones behind one carrier address share this, so it is far above the join limit)
  socketsPerIp: 20,             // WebSocket: open sockets per address; HTTP: live sessions per network
  maxRooms: 2000,
  pendingPerRoom: 16,           // joiners mid-handshake per room
  joinerIdleMs: 60_000,         // a joiner must finish its handshake within this
  heartbeatMs: 30_000,          // WebSocket only
  // HTTP only (/signal/v1)
  hostsPerIpPerMin: 10,         // rooms opened per network per minute
  hostsPerIpPerHour: 60,        // ...and per hour, every kind of page (a script that claims our own origin gets only this)
  roomIdleMs: 2 * 60 * 60_000,  // a room whose host has not asked for anything in 2 h is deleted
  hostSilentMs: 45_000,         // ...and refuses joiners after 45 s (a host polls at least every pollWaitMs)
  messageTtlMs: 60_000,         // an undelivered message is dropped after a minute
  queuePerPeer: 256,            // undelivered messages per peer
  pollWaitMs: 8_000,            // a long-poll answers within this
  pollEveryMs: 350,             // how often a waiting poll looks for new messages
  pollBatch: 64,                // messages per answer
  sweepEveryMs: 30_000,         // expiry runs at most this often (per server instance)
  // World rooms (keyed, gf-multiplayer 1.5.0)
  worldSilentMs: 12_000,        // a keyed room is live while its host was seen within this
  worldDropGraceMs: 3_000,      // ...or this long after its host's long-poll connection dropped mid-wait (a crashed tab)
  worldMaxSeats: 8,             // the most seats a world room may report
});

// A world room's key: world:<published slug> (lowercase letters, digits, dashes; at most 48 after the colon, like a
// slug), or world:local-<hex> for a page that is not under /p/<slug>/ (the kit hashes the game's path).
export const WORLD_KEY = /^world:(?:[a-z0-9][a-z0-9-]{0,47}|local-[0-9a-f]{6,64})$/;
export const cleanKey = v => (typeof v === 'string' && v.length <= 80 && WORLD_KEY.test(v) ? v : null);
const seatCount = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export const PUBLIC_STUN = Object.freeze([Object.freeze({ urls: 'stun:stun.l.google.com:19302' })]);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const te = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async text => hex(await crypto.subtle.digest('SHA-256', te.encode(text)));
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, te.encode(text)));
}

/** A room code: 6 characters from CODE_ALPHABET, by rejection sampling (no modulo bias). `bytes(n)` gives n random bytes. */
export function makeCode(bytes = randomBytes) {
  let out = '';
  while (out.length < 6) {
    for (const b of bytes(12)) if (b < 248 && out.length < 6) out += CODE_ALPHABET[b % 31];
  }
  return out;
}
export const cleanCode = v => (typeof v === 'string' ? v.slice(0, 16).toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

/** Signal data is exactly {sdp:{type:'offer'|'answer', sdp}} or {ice: candidate|null}; anything else is refused. */
export function validSignal(d) {
  if (!isObj(d)) return false;
  const keys = Object.keys(d);
  if (keys.length !== 1) return false;
  if (keys[0] === 'sdp') {
    const s = d.sdp;
    return isObj(s) && (s.type === 'offer' || s.type === 'answer') && typeof s.sdp === 'string' && s.sdp.length <= SIGNAL_LIMITS.sdpChars
      && Object.keys(s).every(k => k === 'type' || k === 'sdp');
  }
  if (keys[0] === 'ice') {
    const c = d.ice;
    if (c === null) return true;
    return isObj(c) && (c.candidate === undefined || typeof c.candidate === 'string') && JSON.stringify(c).length <= 1024;
  }
  return false;
}

/**
 * The ICE servers a page should use: public STUN, plus a TURN relay when TURN_URLS is set (comma-separated turn: or
 * turns: URLs, with TURN_USERNAME and TURN_CREDENTIAL). These credentials are readable by every player: use
 * short-lived ones (a TURN service's API, or coturn's REST secret) before relying on a paid relay.
 */
export function iceServersFromEnv(env = {}) {
  const out = PUBLIC_STUN.map(s => ({ ...s }));
  const urls = String(env.TURN_URLS ?? '').split(',').map(s => s.trim()).filter(u => /^turns?:/i.test(u) && u.length <= 300).slice(0, 8);
  if (urls.length) {
    const turn = { urls };
    if (env.TURN_USERNAME) turn.username = String(env.TURN_USERNAME);
    if (env.TURN_CREDENTIAL) turn.credential = String(env.TURN_CREDENTIAL);
    out.push(turn);
  }
  return out;
}

/**
 * Cloudflare Realtime TURN with short-lived credentials, when CF_TURN_KEY_ID and CF_TURN_API_TOKEN are set (the TURN
 * key from the Cloudflare dashboard, Realtime → TURN Server; the token never leaves the server). Asks Cloudflare for
 * ICE servers valid CF_TURN_TTL_S seconds (default 12 h) and hands the same answer to every page for up to an hour,
 * so each one a page gets has 11 h or more left. Drops the port 53 URLs (browsers block them; Cloudflare's docs).
 * → iceServers, or null when it isn't configured or Cloudflare doesn't answer within 2.5 s (the caller falls back to
 * iceServersFromEnv: a page must get its answer well inside the kit's 4 s probe).
 */
const CF_TURN_REUSE_MS = 3_600_000, CF_TURN_TIMEOUT_MS = 2_500;
const cfTurnCache = new Map();   // key (id|ttl) -> {until, iceServers}: published games and outside games hold their own
/** `ttlS` overrides CF_TURN_TTL_S (outside games ask for a shorter life); `outside` uses CF_TURN_KEY_ID_OUTSIDE and
 *  CF_TURN_API_TOKEN_OUTSIDE when both are set, a separate Cloudflare TURN key whose spend is its own and which can be
 *  deleted to cut outside games' relay off at once, else the same key as published games. */
export async function cloudflareTurnIce(env = {}, { fetchImpl = globalThis.fetch, now = Date.now(), ttlS = null, outside = false } = {}) {
  const own = outside && String(env.CF_TURN_KEY_ID_OUTSIDE ?? '').trim() && String(env.CF_TURN_API_TOKEN_OUTSIDE ?? '').trim();
  const id = String(own ? env.CF_TURN_KEY_ID_OUTSIDE : env.CF_TURN_KEY_ID ?? '').trim(), token = String(own ? env.CF_TURN_API_TOKEN_OUTSIDE : env.CF_TURN_API_TOKEN ?? '').trim();
  if (!id || !token || typeof fetchImpl !== 'function') return null;
  const ttl = Math.min(Math.max(Number(ttlS) || Number(env.CF_TURN_TTL_S) || 43_200, 7_200), 172_800);
  const key = `${id}|${ttl}`;
  const hit = cfTurnCache.get(key);
  if (hit && now < hit.until) return hit.iceServers;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), CF_TURN_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl }), signal: ctl.signal });
    if (!r.ok) throw new Error(`cloudflare turn ${r.status}`);
    const j = await r.json();
    const iceServers = (Array.isArray(j?.iceServers) ? j.iceServers : []).map(s => {
      if (!isObj(s)) return null;
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && /^(stun|turns?):/i.test(u) && !/:53(\?|$)/.test(u));
      if (!urls.length) return null;
      const o = { urls };
      if (typeof s.username === 'string') o.username = s.username;
      if (typeof s.credential === 'string') o.credential = s.credential;
      return o;
    }).filter(Boolean).slice(0, 8);
    if (!iceServers.some(s => s.urls.some(u => /^turns?:/i.test(u)) && s.username && s.credential)) throw new Error('cloudflare turn: no relay in the answer');
    cfTurnCache.set(key, { until: now + Math.min(CF_TURN_REUSE_MS, ttl * 500), iceServers });
    return iceServers;
  } catch (error) {
    console.error('turn credentials failed', error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error).slice(0, 120));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
export const resetCloudflareTurnCache = () => { cfTurnCache.clear(); };

/** Whether `origin` (an Origin header) is the page origin for `host` (a host[:port], no scheme). */
export function sameOrigin(origin, host) {
  if (!origin || !host || origin === 'null') return false;
  try { return new URL(origin).host.toLowerCase() === String(host).trim().toLowerCase(); } catch { return false; }
}

// ---- Games served from somewhere else (a person's own machine, their own site) -------------------------------------
// A page whose Origin is not this host is an "outside" game. It is answered only when the play host's switch
// (PLAY_OUTSIDE=on) is on, and under budgets of its own: per address and per origin by the hour and the minute, and
// totals per day for the whole host. An Origin is set by the browser and can't be forged by a page, but a script can
// send any header, so nothing here trusts it: a script claiming OUR origin gets the per-address limits every request has
// (hostsPerIpPerMin, hostsPerIpPerHour, socketsPerIp), and one claiming nothing is refused (POST) or gets STUN (GET).
// Counters are the same signal_hits rows as the per-minute ones: `win` is the minute the window ends, so the existing
// expiry sweep deletes them with no migration.
export const OUTSIDE_DEFAULTS = Object.freeze({
  roomsPerIpHour: 12,           // rooms one network opens for outside games per hour
  roomsPerOriginHour: 120,      // ...and one outside origin (a site or a localhost port) in all
  joinsPerOriginMin: 90,        // join attempts per outside origin per minute
  findsPerOriginMin: 1200,      // world lookups per outside origin per minute
  roomsPerDay: 1500,            // all outside games together
  liveRooms: 150,               // outside rooms open at once (a host seen in the last hostSilentMs)
  relayPerIpDay: 40,            // relay credentials handed to one network per day (a 4-player session asks 4 times)
  relayPerOriginDay: 400,
  relayPerDay: 600,             // ...to all outside games together; past it a page gets STUN only
  relayTtlS: 7_200,             // outside relay credentials live 2 h (Cloudflare's minimum clamp here; published games get 12 h)
});
const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hostList = v => new Set(String(v ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9.\-:[\]]{1,100}$/.test(x)));
/** The play host's settings for outside games, from its environment: PLAY_OUTSIDE (on | off; unset is off), the numbers
 *  PLAY_OUTSIDE_ROOMS_PER_IP_HOUR, _ROOMS_PER_ORIGIN_HOUR, _JOINS_PER_ORIGIN_MIN, _FINDS_PER_ORIGIN_MIN, _ROOMS_PER_DAY,
 *  _LIVE_ROOMS, _RELAY_PER_IP_DAY, _RELAY_PER_ORIGIN_DAY, _RELAY_PER_DAY, _RELAY_TTL_S, PLAY_OUTSIDE_BLOCK (hosts to
 *  refuse), PLAY_OUTSIDE_ALLOW (only these hosts) and PLAY_OUTSIDE_HELP_URL (the self-host guide, named in refusals). */
export function outsideFromEnv(env = {}) {
  const D = OUTSIDE_DEFAULTS, n = (name, key) => clampInt(env[`PLAY_OUTSIDE_${name}`], 1, 1_000_000, D[key]);
  const allow = hostList(env.PLAY_OUTSIDE_ALLOW), help = String(env.PLAY_OUTSIDE_HELP_URL ?? '').trim();
  return {
    mode: String(env.PLAY_OUTSIDE ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off',
    roomsPerIpHour: n('ROOMS_PER_IP_HOUR', 'roomsPerIpHour'), roomsPerOriginHour: n('ROOMS_PER_ORIGIN_HOUR', 'roomsPerOriginHour'),
    joinsPerOriginMin: n('JOINS_PER_ORIGIN_MIN', 'joinsPerOriginMin'), findsPerOriginMin: n('FINDS_PER_ORIGIN_MIN', 'findsPerOriginMin'),
    roomsPerDay: n('ROOMS_PER_DAY', 'roomsPerDay'), liveRooms: n('LIVE_ROOMS', 'liveRooms'),
    relayPerIpDay: n('RELAY_PER_IP_DAY', 'relayPerIpDay'), relayPerOriginDay: n('RELAY_PER_ORIGIN_DAY', 'relayPerOriginDay'),
    relayPerDay: n('RELAY_PER_DAY', 'relayPerDay'), relayTtlS: clampInt(env.PLAY_OUTSIDE_RELAY_TTL_S, 7_200, 172_800, D.relayTtlS),
    block: hostList(env.PLAY_OUTSIDE_BLOCK), allow: allow.size ? allow : null, help: /^https?:\/\/\S{1,200}$/.test(help) ? help : '',
  };
}
/** → {origin, host, hostname} for an http(s) Origin header (a page's own origin: scheme, host and port), else null ('null'
 *  from a sandboxed frame or a file, anything with a path or credentials). */
export function outsideOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 200 || origin === 'null') return null;
  try {
    const u = new URL(origin);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin || u.username || u.password) return null;
    return { origin: u.origin, host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase() };
  } catch { return null; }
}
/** CORS headers for an answer to a page on another origin: that origin only, and no cookies (the kit sends none). */
export function corsHeaders(origin) {
  const o = outsideOrigin(origin);
  return o ? { 'access-control-allow-origin': o.origin, vary: 'Origin', 'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {};
}
const hourEnd = t => (Math.floor(t / 3_600_000) + 1) * 60, dayEnd = t => (Math.floor(t / 86_400_000) + 1) * 1440;   // the minute a window ends
const leftMs = (end, t) => Math.max(1000, end * 60_000 - t);
const waitWords = ms => { const m = Math.ceil(ms / 60_000); return m <= 1 ? 'a minute' : m < 120 ? `${m} minutes` : `${Math.ceil(m / 60)} hours`; };

const STATUS = { bad: 400, off: 403, 'no-room': 404, full: 409, taken: 409, rate: 429, busy: 503 };
const fail = (code, reason, status = STATUS[code] ?? 400, extra = null) => ({ status, body: { t: 'error', code, reason, ...extra } });
const limited = (reason, ms) => fail('rate', reason, 429, { retryAfter: Math.ceil(ms / 1000) });
const ok = body => ({ status: 200, body });
const wait = (ms, signal) => new Promise(res => {
  if (signal?.aborted) return res();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); res(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

/**
 * The HTTP signaling protocol over a store (memoryStore() here, pgStore() in lib/signal-http.mjs).
 *   secret       keys the address hash (Studio: PLAY_SECRET; the Node server: random per process)
 *   now, sleep   injectable for tests
 * → { request({origin, host, ip, body, signal}) → {status, body}, ice({origin, host, env}) → {status, body}, stats() }
 * `host` is this server's own host (Studio: PLAY_HOST; Node: the Host header); `body` is the raw request text.
 */
export function createSignaling({ store, secret = '', now = () => Date.now(), sleep = wait, limits = SIGNAL_LIMITS, checkOrigin = true, outside = null } = {}) {
  if (!store) throw new Error('createSignaling needs a store');
  const L = limits;
  const stats = { requests: 0, rooms: 0, joins: 0, relayed: 0, polls: 0, rejected: 0, worldRooms: 0, finds: 0, rateLimited: 0, outsideRefused: 0, outsideOff: 0 };
  let lastSweep = 0;
  const no = (...a) => { stats.rejected++; if (a[0] === 'rate') stats.rateLimited++; return fail(...a); };
  const ipHash = ip => (secret ? hmacHex(secret, `signal-ip|${ip ?? ''}`) : sha256Hex(`signal-ip|${ip ?? ''}`)).then(h => h.slice(0, 24));
  // An outside game's address key starts with "o" (the hash is hex, so no other key does): the store can count outside
  // hosts by prefix with no new column. Its budgets are therefore separate from the same address on our own pages.
  const ipKey = async (ip, isOutside = false) => (isOutside ? 'o' : '') + (await ipHash(ip));
  const minute = t => Math.floor(t / 60_000);
  const newSession = async () => { const token = base64url(randomBytes(18)); return { peer: base64url(randomBytes(6)), token, tokenHash: await sha256Hex(token) }; };

  async function sweep(t) {
    if (t - lastSweep < L.sweepEveryMs) return;
    lastSweep = t;
    try {
      await store.sweep({ messagesBefore: t - L.messageTtlMs, joinersBefore: t - L.joinerIdleMs, closedBefore: t - L.messageTtlMs,
        idleBefore: t - L.roomIdleMs, hitsBefore: minute(t) - 1 });
    } catch { /* expiry is best effort; the next request tries again */ lastSweep = 0; }
  }

  async function openRoom(ip, t, m = {}) {
    // A world room: the key is checked before anything is counted, so a malformed key costs nothing.
    const key = m.key === undefined ? null : cleanKey(m.key);
    if (m.key !== undefined && !key) return no('bad', 'key must be world:<slug> (lowercase letters, digits and dashes)');
    if ((await store.hit(`host|${ip}`, minute(t))) > L.hostsPerIpPerMin) return no('rate', 'too many rooms opened from this network, try again in a minute');
    if ((await store.ipPeers(ip, t - L.joinerIdleMs)) >= L.socketsPerIp) return no('rate', 'too many signaling sessions from this network');
    if ((await store.hit(`host-h|${ip}`, hourEnd(t))) > L.hostsPerIpPerHour) return limited('too many rooms from this network this hour: try again in ' + waitWords(leftMs(hourEnd(t), t)), leftMs(hourEnd(t), t));
    // Rooms whose host went quiet (hostSilentMs: it polls at least every 8 s) refuse joiners already, so they don't count
    // against the cap: a script that opens rooms and walks away can't fill the 2,000 for two hours.
    if ((await store.openRooms(t - L.hostSilentMs)) >= L.maxRooms) return no('busy', 'signaling is full, try again soon');
    if (key) return claimKey(key, ip, t, seatCount(m.max, 1, L.worldMaxSeats) ?? L.worldMaxSeats);
    for (let i = 0; i < 8; i++) {
      const code = makeCode(), s = await newSession();
      const made = await store.createRoom({ code, host: s.peer, created: t },
        { id: s.peer, room: code, role: 'host', token: s.tokenHash, ip, created: t, seen: t, tokens: L.burst, last: t });
      if (made) { stats.rooms++; return ok({ t: 'hosted', code, peer: s.peer, token: s.token }); }
    }
    return no('busy', 'could not find a free room code, try again');
  }

  // Claim a world key in one store call, so two visitors can never both host it. A holder whose host went quiet
  // (worldSilentMs) is closed in the same call, and its pending joiners hear host-left.
  async function claimKey(key, ip, t, max) {
    for (let i = 0; i < 8; i++) {
      const code = makeCode(), s = await newSession();
      const r = await store.claimKey({ code, host: s.peer, created: t, key, n: 1, max },
        { id: s.peer, room: code, role: 'host', token: s.tokenHash, ip, created: t, seen: t, tokens: L.burst, last: t }, t - L.worldSilentMs, t);
      for (const stale of r.closed ?? []) for (const id of await store.joiners(stale, t - L.joinerIdleMs)) await store.push(id, JSON.stringify({ t: 'host-left' }), t, L.queuePerPeer);
      if (r.made) { stats.rooms++; stats.worldRooms++; return ok({ t: 'hosted', code, peer: s.peer, token: s.token }); }
      if (r.holder) {
        stats.rejected++;
        return { status: STATUS.taken, body: { t: 'error', code: 'taken', reason: 'someone already hosts this world', room: r.holder.code, n: r.holder.n ?? 1, max: r.holder.max ?? L.worldMaxSeats } };
      }
      // neither: a room code or peer id that already existed; try again with new ones
    }
    return no('busy', 'could not find a free room code, try again');
  }

  async function findRoom(m, ip, t) {
    const key = cleanKey(m.key);
    if (!key) return no('bad', 'key must be world:<slug> (lowercase letters, digits and dashes)');
    // a lookup is a read (it opens nothing and can't guess a code): its own, larger budget per network
    if ((await store.hit(`find|${ip}`, minute(t))) > L.findsPerIpPerMin) return no('rate', 'too many world lookups');
    stats.finds++;
    const r = await store.findKey(key, t - L.worldSilentMs);
    return ok(r ? { t: 'found', code: r.code, n: r.n ?? 1, max: r.max ?? L.worldMaxSeats } : { t: 'none' });
  }

  async function joinRoom(m, ip, t) {
    if ((await store.hit(`join|${ip}`, minute(t))) > L.joinsPerIpPerMin) return no('rate', 'too many join attempts');
    const code = cleanCode(m.code);
    const room = code.length === 6 ? await store.room(code) : null;
    if (!room || room.closed != null || room.seen < t - (room.key ? L.worldSilentMs : L.hostSilentMs)) return no('no-room', 'no game with that code (the host may have left)');
    if ((await store.ipPeers(ip, t - L.joinerIdleMs)) >= L.socketsPerIp) return no('rate', 'too many signaling sessions from this network');
    if ((await store.joiners(code, t - L.joinerIdleMs)).length >= L.pendingPerRoom) return no('busy', 'too many players joining at once, try again');
    for (let i = 0; i < 4; i++) {
      const s = await newSession();
      if (!(await store.addPeer({ id: s.peer, room: code, role: 'joiner', token: s.tokenHash, ip, created: t, seen: t, tokens: L.burst, last: t }))) continue;
      await store.push(room.host, JSON.stringify({ t: 'peer', peer: s.peer }), t, L.queuePerPeer);
      stats.joins++;
      return ok({ t: 'joined', peer: s.peer, token: s.token });
    }
    return no('no-room', 'no game with that code (the host may have left)');
  }

  // A peer id and its token. A session that ended, expired or never was is 'no-room', like a WebSocket that is not in a room.
  async function session(m) {
    if (typeof m.peer !== 'string' || m.peer.length > 32 || typeof m.token !== 'string' || m.token.length > 64) return null;
    const me = await store.peer(m.peer);
    if (!me || me.token !== (await sha256Hex(m.token))) return null;
    return me;
  }

  async function deliver(to, msg, t) {
    const seq = await store.push(to, JSON.stringify(msg), t, L.queuePerPeer);
    if (seq == null) return no('full', 'the other player is not reading its signaling messages');
    stats.relayed++;
    return ok({ ok: true });
  }

  async function poll(me, m, t, signal) {
    stats.polls++;
    // A world room's host reports its seats on its polls; written only when they changed.
    if (me.role === 'host' && me.roomKey) {
      const n = seatCount(m.n, 0, 16), max = seatCount(m.max, 1, L.worldMaxSeats);
      if (n !== null && max !== null && (n !== me.roomN || max !== me.roomMax)) await store.setSeats(me.room, n, max);
    }
    const after = Number.isSafeInteger(m.after) && m.after > 0 ? m.after : 0;
    if (after) await store.ack(me.id, after);
    const until = t + L.pollWaitMs;
    for (;;) {
      // A poll whose client went away answers nothing: its messages stay queued (only the next poll's `after`
      // acknowledges them, so nothing is lost), and a world host gone mid-wait is noted below.
      if (signal?.aborted) break;
      const rows = await store.read(me.id, after, now() - L.messageTtlMs, L.pollBatch);
      if (rows.length) {
        const msgs = [];
        for (const r of rows) { try { msgs.push(JSON.parse(r.body)); } catch { /* never written by anything else */ } }
        return ok({ msgs, last: rows[rows.length - 1].seq });
      }
      if (now() + L.pollEveryMs >= until) return ok({ msgs: [], last: after });
      await sleep(L.pollEveryMs, signal);
    }
    if (me.role === 'host' && me.roomKey) {
      // A world host's poll was cut off mid-wait: its tab crashed or its network dropped (a live host polls again at
      // once). The room counts as quiet worldDropGraceMs from now unless the host comes back, so its guests can
      // re-form sooner than worldSilentMs. Only while this is the host's latest poll: a newer one means it is back.
      await store.quiet?.(me.room, now() - L.worldSilentMs + L.worldDropGraceMs, me.id, t);
    }
    return ok({ msgs: [], last: after });
  }

  async function leave(me, t) {
    if (me.role === 'host') {
      for (const id of await store.joiners(me.room, t - L.joinerIdleMs)) await store.push(id, JSON.stringify({ t: 'host-left' }), t, L.queuePerPeer);
      await store.closeRoom(me.room, t);
    } else {
      await store.dropPeer(me.id);
      if (me.roomClosed == null) await store.push(me.roomHost, JSON.stringify({ t: 'peer-left', peer: me.id }), t, L.queuePerPeer);
    }
    return ok({ ok: true });
  }

  // The words a player reads when outside games are not answered. `help` is the self-host guide's address, when set.
  const offReason = cfg => 'Online play for games run from other sites is off for now. Play in two tabs on this machine, or host your own signaling' + (cfg.help ? ` (${cfg.help}).` : '.');

  // The outside game's gate: the switch, the block and allow lists, then the budgets of this operation (address first,
  // then origin, then the whole host), each checked only once the one before it passed so a refused caller can't spend
  // the shared budgets. → a failure answer, or null.
  async function outsideGate(op, o, cfg, ip, t) {
    if (cfg.mode !== 'on' || cfg.block.has(o.host) || cfg.block.has(o.hostname) || (cfg.allow && !cfg.allow.has(o.host) && !cfg.allow.has(o.hostname))) {
      stats.outsideOff++;
      return no('off', offReason(cfg));
    }
    const oh = (await sha256Hex(`signal-origin|${o.origin}`)).slice(0, 16);
    if (op === 'host') {
      const ik = await ipKey(ip, true);
      if ((await store.hit(`o-host-ip|${ik}`, hourEnd(t))) > cfg.roomsPerIpHour) { stats.outsideRefused++; return limited('too many rooms from this network: try again in ' + waitWords(leftMs(hourEnd(t), t)), leftMs(hourEnd(t), t)); }
      if ((await store.hit(`o-host-org|${oh}`, hourEnd(t))) > cfg.roomsPerOriginHour) { stats.outsideRefused++; return limited('this game has opened too many rooms this hour: try again in ' + waitWords(leftMs(hourEnd(t), t)), leftMs(hourEnd(t), t)); }
      if ((await store.hit('o-host-all', dayEnd(t))) > cfg.roomsPerDay) { stats.outsideRefused++; return limited('online play is at its daily limit for games run from other sites: try again in ' + waitWords(leftMs(dayEnd(t), t)), leftMs(dayEnd(t), t)); }
      if ((await store.liveHosts('o', t - L.hostSilentMs)) >= cfg.liveRooms) { stats.outsideRefused++; return no('busy', 'online play is full right now for games run from other sites: try again in a few minutes'); }
    } else if (op === 'join' || op === 'find') {
      const per = op === 'join' ? cfg.joinsPerOriginMin : cfg.findsPerOriginMin;
      if ((await store.hit(`o-${op}-org|${oh}`, minute(t))) > per) { stats.outsideRefused++; return limited('too many players are joining this game: try again in a minute', 60_000); }
    }
    return null;
  }

  async function request({ origin = null, host = '', ip = '', body = '', signal = null, outside: outsideArg = undefined } = {}) {
    stats.requests++;
    const cfg = outsideArg !== undefined ? outsideArg : (typeof outside === 'function' ? outside() : outside);
    let o = null;   // set when this page is an outside game
    if (checkOrigin && !sameOrigin(origin, host)) {
      if (!cfg) return no('bad', 'signaling answers only pages on its own origin', 403);
      o = outsideOrigin(origin);
      if (!o) return no('bad', 'signaling cannot tell which site this game is served from (it needs an http or https page)', 403);
    }
    if (typeof body !== 'string' || !body) return no('bad', 'no request body');
    if (body.length > L.frameBytes) return no('bad', 'request too large', 413);
    let m; try { m = JSON.parse(body); } catch { return no('bad', 'not JSON'); }
    if (!isObj(m)) return no('bad', 'not an object');
    const t = now();
    await sweep(t);
    if (o && (m.op === 'host' || m.op === 'join' || m.op === 'find')) { const r = await outsideGate(m.op, o, cfg, ip, t); if (r) return r; }
    if (m.op === 'host') return openRoom(await ipKey(ip, !!o), t, m);
    if (m.op === 'join') return joinRoom(m, await ipKey(ip, !!o), t);
    if (m.op === 'find') return findRoom(m, await ipKey(ip, !!o), t);
    if (m.op !== 'signal' && m.op !== 'poll' && m.op !== 'leave') return no('bad', 'unknown op (signaling carries no game traffic)');
    const me = await session(m);
    if (!me) return no('no-room', 'not in a room (the session ended or expired)');
    // Token bucket per peer, as per WebSocket: ratePerSec, burst. Every request counts, polls included.
    const tokens = Math.min(L.burst, me.tokens + ((t - me.last) / 1000) * L.ratePerSec);
    await store.touch(me.id, { tokens: Math.max(0, tokens - 1), last: t, seen: t, ...(m.op === 'poll' ? { polled: t } : {}) }, me.role === 'host' ? me.room : null, t);
    if (tokens < 1) return no('rate', 'too many messages');
    if (m.op === 'poll') return poll(me, m, t, signal);
    if (m.op === 'leave') return leave(me, t);
    if (!validSignal(m.data)) return no('bad', 'signal data must be {sdp:{type,sdp}} or {ice}');
    if (me.roomClosed != null) return no('no-room', 'the host left');
    if (me.role === 'host') {
      const target = typeof m.to === 'string' && m.to.length <= 32 ? await store.peer(m.to) : null;
      // A joiner leaves signaling the moment its data channel opens, while the host is still sending the candidates it
      // gathers late (reflexive and relay ones arrive after the channel is up). Those are not an error: answer ok and say
      // the peer is gone, so a page's console and the logs stay clean. A peer that exists but is not this room's joiner
      // is still refused. (gf-multiplayer 1.6.4 also stops sending them.)
      if (!target && typeof m.to === 'string' && m.to.length <= 32) return ok({ ok: true, gone: true });
      if (!target || target.room !== me.room || target.role !== 'joiner') return no('bad', 'no such peer');
      return deliver(target.id, { t: 'signal', from: 'host', data: m.data }, t);
    }
    return deliver(me.roomHost, { t: 'signal', from: me.id, data: m.data }, t);   // a joiner's `to` is ignored
  }

  /** GET /signal/v1/ice. A same-origin GET carries no Origin header; one from elsewhere is refused. */
  function ice({ origin = null, host = '', env = {} } = {}) {
    if (checkOrigin && origin && !sameOrigin(origin, host)) return fail('bad', 'signaling answers only pages on its own origin', 403);
    return ok({ v: 1, signal: 'http', iceServers: iceServersFromEnv(env) });
  }

  /** GET /signal/v1/ice from a page on another origin. The relay credentials are the costly part, so they are counted per
   *  address and per origin per day and for the host as a whole per day; past a budget the page gets STUN only (still a
   *  working answer: most pairs connect without a relay). → {status, body, mint}; `mint` says the caller may add relay
   *  credentials (valid cfg.relayTtlS) to body.iceServers. `hasRelay`: whether this host has a relay configured at all. */
  async function iceOutside({ origin = null, host = '', ip = '', env = {}, outside: outsideArg = undefined, hasRelay = false } = {}) {
    const cfg = outsideArg !== undefined ? outsideArg : (typeof outside === 'function' ? outside() : outside);
    if (!cfg) return { ...fail('bad', 'signaling answers only pages on its own origin', 403), mint: false };
    const o = outsideOrigin(origin);
    if (!o) return { ...fail('bad', 'signaling cannot tell which site this game is served from (it needs an http or https page)', 403), mint: false };
    if (cfg.mode !== 'on' || cfg.block.has(o.host) || cfg.block.has(o.hostname) || (cfg.allow && !cfg.allow.has(o.host) && !cfg.allow.has(o.hostname))) {
      stats.outsideOff++;
      return { ...fail('off', offReason(cfg)), mint: false };
    }
    const t = now(), body = { v: 1, signal: 'http', iceServers: PUBLIC_STUN.map(s => ({ ...s })) };
    if (!hasRelay) return { status: 200, body, mint: false };
    const ik = await ipKey(ip, true), oh = (await sha256Hex(`signal-origin|${o.origin}`)).slice(0, 16), end = dayEnd(t);
    const over = (await store.hit(`o-relay-ip|${ik}`, end)) > cfg.relayPerIpDay || (await store.hit(`o-relay-org|${oh}`, end)) > cfg.relayPerOriginDay
      || (await store.hit('o-relay-all', end)) > cfg.relayPerDay;
    if (over) { stats.outsideRefused++; body.relay = 'limited'; return { status: 200, body, mint: false }; }
    body.relay = 'on';
    return { status: 200, body, mint: true, ttlS: cfg.relayTtlS };
  }

  return { request, ice, iceOutside, stats: () => ({ ...stats }), store, limits: L };
}

/**
 * The store for one Node process (the local signaling server and the tests). Same contract as pgStore():
 *   createRoom(room, hostPeer) → bool       room(code) → {code, host, created, seen, closed, key} | null
 *   peer(id) → {id, room, role, token, ip, created, seen, tokens, last, roomHost, roomClosed, roomSeen, roomKey, roomN,
 *              roomMax} | null
 *   claimKey(room {code, host, created, key, n, max}, hostPeer, staleBefore, t) → {made, holder: {code, n, max} | null,
 *              closed: [codes]}   ATOMIC: closes the open rooms with this key whose host was last seen before
 *              staleBefore, then creates the room only when no open room holds the key (made), else names the holder
 *   findKey(key, since) → {code, n, max} | null      the open room holding the key whose host was seen since `since`
 *   setSeats(code, n, max)
 *   quiet(code, seen, hostId, pollStart)   sets the room's seen back to `seen` unless its host started a poll after
 *              pollStart (touch records a poll's start as the peer's `polled`)
 *   addPeer(peer) → bool (false when the room is gone or closed)   touch(id, {tokens, last, seen}, hostRoom|null, t)
 *   ipPeers(ip, since) → n live sessions      joiners(code, since) → [peer ids]     openRooms(since) → n
 *   liveHosts(prefix, since) → n hosts whose address key starts with `prefix` and who were seen since (outside games: "o")
 *   push(id, body, t, max) → seq | null       ack(id, after)       read(id, after, since, max) → [{seq, body}]
 *   dropPeer(id)    closeRoom(code, t)    hit(key, window) → count    sweep({...before})
 */
export function memoryStore() {
  const rooms = new Map(), peers = new Map(), queues = new Map(), hits = new Map();
  let seq = 0;
  const view = p => { const r = rooms.get(p.room); return { ...p, roomHost: r?.host ?? null, roomClosed: r ? r.closed : null, roomSeen: r?.seen ?? 0, roomKey: r?.key ?? null, roomN: r?.n ?? null, roomMax: r?.max ?? null }; };
  const drop = id => { peers.delete(id); queues.delete(id); };
  return {
    kind: 'memory',
    async openRooms(since) { let n = 0; for (const r of rooms.values()) if (r.closed == null && r.seen >= since) n++; return n; },
    async createRoom(room, host) {
      if (rooms.has(room.code) || peers.has(host.id)) return false;
      rooms.set(room.code, { code: room.code, host: room.host, created: room.created, seen: room.created, closed: null, key: null, n: null, max: null });
      peers.set(host.id, { ...host });
      return true;
    },
    // No await inside: the stale close, the check and the insert happen in one turn of the event loop.
    async claimKey(room, host, staleBefore, t) {
      const closed = [];
      let holder = null;
      for (const r of rooms.values()) {
        if (r.key !== room.key || r.closed != null) continue;
        if (r.seen < staleBefore) { r.closed = t; drop(r.host); closed.push(r.code); }
        else holder = r;
      }
      if (holder) return { made: false, holder: { code: holder.code, n: holder.n, max: holder.max }, closed };
      if (rooms.has(room.code) || peers.has(host.id)) return { made: false, holder: null, closed };
      rooms.set(room.code, { code: room.code, host: room.host, created: room.created, seen: room.created, closed: null, key: room.key, n: room.n ?? 1, max: room.max ?? null });
      peers.set(host.id, { ...host });
      return { made: true, holder: null, closed };
    },
    async findKey(key, since) { for (const r of rooms.values()) if (r.key === key && r.closed == null && r.seen >= since) return { code: r.code, n: r.n, max: r.max }; return null; },
    async setSeats(code, n, max) { const r = rooms.get(code); if (r) { r.n = n; r.max = max; } },
    async quiet(code, seen, hostId, pollStart) { const r = rooms.get(code), h = peers.get(hostId); if (r && h && (h.polled ?? 0) <= pollStart && r.seen > seen) r.seen = seen; },
    async room(code) { const r = rooms.get(code); return r ? { ...r } : null; },
    async peer(id) { const p = peers.get(id); return p && rooms.has(p.room) ? view(p) : null; },
    async addPeer(p) { const r = rooms.get(p.room); if (!r || r.closed != null || peers.has(p.id)) return false; peers.set(p.id, { ...p }); return true; },
    async touch(id, fields, hostRoom, t) { const p = peers.get(id); if (p) Object.assign(p, fields); const r = hostRoom && rooms.get(hostRoom); if (r) r.seen = t; },
    async ipPeers(ip, since) { let n = 0; for (const p of peers.values()) if (p.ip === ip && p.seen >= since) n++; return n; },
    async liveHosts(prefix, since) { let n = 0; for (const p of peers.values()) if (p.role === 'host' && p.ip.startsWith(prefix) && p.seen >= since) n++; return n; },
    async joiners(code, since) { return [...peers.values()].filter(p => p.room === code && p.role === 'joiner' && p.created >= since).map(p => p.id); },
    async push(id, body, created, max) {
      if (!peers.has(id)) return null;
      const q = queues.get(id) ?? [];
      if (q.length >= max) return null;
      q.push({ seq: ++seq, body, created }); queues.set(id, q);
      return seq;
    },
    async ack(id, after) { const q = queues.get(id); if (!q) return; const keep = q.filter(m => m.seq > after); if (keep.length) queues.set(id, keep); else queues.delete(id); },
    async read(id, after, since, max) { return (queues.get(id) ?? []).filter(m => m.seq > after && m.created >= since).slice(0, max).map(m => ({ seq: m.seq, body: m.body })); },
    async dropPeer(id) { drop(id); },
    async closeRoom(code, t) { const r = rooms.get(code); if (!r) return; if (r.closed == null) r.closed = t; drop(r.host); },
    async hit(key, win) { const k = `${key}|${win}`, n = (hits.get(k) ?? 0) + 1; hits.set(k, n); return n; },
    async sweep({ messagesBefore, joinersBefore, closedBefore, idleBefore, hitsBefore }) {
      for (const [id, q] of queues) { const keep = q.filter(m => m.created >= messagesBefore); if (keep.length) queues.set(id, keep); else queues.delete(id); }
      for (const p of [...peers.values()]) if (p.role === 'joiner' && p.created < joinersBefore) drop(p.id);
      for (const r of [...rooms.values()]) {
        if ((r.closed != null && r.closed < closedBefore) || r.seen < idleBefore) {
          rooms.delete(r.code);
          for (const p of [...peers.values()]) if (p.room === r.code) drop(p.id);
        }
      }
      for (const k of [...hits.keys()]) if (Number(k.slice(k.lastIndexOf('|') + 1)) < hitsBefore) hits.delete(k);
    },
    size: () => ({ rooms: rooms.size, peers: peers.size, messages: [...queues.values()].reduce((n, q) => n + q.length, 0), hits: hits.size }),
  };
}
