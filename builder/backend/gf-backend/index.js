// gf-backend: a game's small client for its own Supabase project (gamesfun-kit, MIT). The kit copies this folder
// into a game at gf/backend/ when a backend is connected (`npx gamesfun backend use|connect`); never edit the copy.
//
//   import { connectBackend } from './gf/backend/index.js';
//   const db = await connectBackend();                 // null when the game has no backend.json
//   await db.signIn();                                 // this player's own id (anonymous sign-in), kept per browser
//   await db.from('high_scores').insert({ score: 12 });
//   const { data } = await db.from('high_scores').select('name,score', { order: 'score.desc', limit: 10 });
//   await db.from('progress').upsert({ player_id: db.user.id, level: 3 }, { onConflict: 'player_id' });
//
// A server provider (the person's own server, kind "server"): db.get('/scores'), db.post('/match', {...}),
// db.socketUrl('/room'): plain calls to the URL in backend.json.
//
// What it talks to: only the project in backend.json (its REST, auth and functions URLs), with the project's
// publishable key, which is public by design: the database's row-level security decides what a player may do.
// Every call resolves to { data, error } and never throws, and nothing it does is a console error: a game keeps
// playing when its database is away (offline, paused, refused by the page's content-security policy).
//
// Automated browsers (verify, `gamesfun play`, play-testers: navigator.webdriver) never touch the person's real
// database: there the client answers { data: null, error: 'off' } unless the page says ?gf-backend=on or sets
// globalThis.__GF_BACKEND = 'on' first. ?gf-backend=off or __GF_BACKEND = 'off' turns it off anywhere, and so does
// the kit's backdrop view (?gf-backdrop=1, where nothing is saved).
//
// Live play between friends stays on gf/mp (WebRTC): a database is for accounts, saves, scores and lobbies, not poses.
export const VERSION = '1.0.0';
const TIMEOUT_MS = 8000;

const params = () => { try { return new URLSearchParams(globalThis.location?.search ?? ''); } catch { return new URLSearchParams(); } };
/** Is the backend on for this page? (see above) */
export function backendOn() {
  const p = params(), g = globalThis.__GF_BACKEND;
  if (g === 'off' || p.get('gf-backend') === 'off' || p.get('gf-backdrop') === '1') return false;
  if (g === 'on' || p.get('gf-backend') === 'on') return true;
  return !globalThis.navigator?.webdriver;
}

const warned = new Set();
const warn = (kind, msg) => { if (!warned.has(kind)) { warned.add(kind); console.warn(`gf-backend: ${msg}`); } };
const store = {
  get(k) { try { return JSON.parse(globalThis.localStorage?.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { v == null ? globalThis.localStorage?.removeItem(k) : globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch {} },
};

/** A publishable key is not a token; the legacy anon key is a JWT and doubles as one. */
const isJwt = k => typeof k === 'string' && k.split('.').length === 3;
const SECRETISH = /^sb_secret_|^sbp_/;
function publicKeyOnly(key) {
  if (typeof key !== 'string') return null;
  if (SECRETISH.test(key)) return null;
  if (isJwt(key)) { try { const p = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return p.role === 'anon' ? key : null; } catch { return null; } }
  return /^sb_publishable_/.test(key) ? key : null;
}

async function call(url, init, label) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { ...init, signal: ctl?.signal, cache: 'no-store', credentials: 'omit' });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const why = (data && (data.message || data.msg || data.error_description || data.error)) || `${res.status}`;
      if (res.status === 401 || res.status === 403) warn(`denied:${label}`, `${label} was refused (${res.status}): ${why}. Row-level security decides what a player may do.`);
      else if (res.status === 540 || res.status === 503) warn('paused', 'the database is not answering (a free Supabase project pauses after a week without use: restore it in the Supabase dashboard).');
      else warn(`fail:${label}`, `${label} failed (${res.status}): ${why}`);
      return { data: null, error: String(why), status: res.status };
    }
    return { data, error: null, status: res.status };
  } catch (e) {
    warn('unreachable', `the database could not be reached (${e?.name === 'AbortError' ? 'timed out' : 'offline or blocked'}); the game plays on without it.`);
    return { data: null, error: 'unreachable', status: 0 };
  } finally { if (t) clearTimeout(t); }
}

function filters(q, { eq, gt, gte, lt, lte, neq, order, limit, offset } = {}) {
  const add = (op, obj) => { for (const [k, v] of Object.entries(obj ?? {})) q.append(k, `${op}.${v}`); };
  add('eq', eq); add('gt', gt); add('gte', gte); add('lt', lt); add('lte', lte); add('neq', neq);
  if (order) q.set('order', order);
  if (Number.isInteger(limit)) q.set('limit', String(limit));
  if (Number.isInteger(offset)) q.set('offset', String(offset));
  return q;
}
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The game's backend, or null when it has none (no backend.json, or a provider this client does not speak). */
export async function connectBackend({ configUrl = new URL('../../backend.json', import.meta.url).href } = {}) {
  if (!backendOn()) return offClient();
  let cfg = null;
  try { const r = await fetch(configUrl, { cache: 'no-store' }); if (r.ok) cfg = await r.json(); } catch {}
  if (!cfg) return null;
  if (cfg.provider !== 'supabase') return hostClient(cfg);
  const key = publicKeyOnly(cfg.key);
  if (!key) { warn('key', 'backend.json carries no public key (only a publishable or anon key may be in a game); the backend is off'); return offClient(); }
  return supabaseClient(String(cfg.url).replace(/\/+$/, ''), key, cfg.players ?? 'anonymous');
}

/** A server of the person's own (a server provider: Railway and the like): plain calls to its public URL. CORS is the
 *  server's job; the page's content-security policy allows exactly the origins in backend.json. */
function hostClient(cfg) {
  let base;
  try { base = new URL(cfg.url); } catch { warn('url', 'backend.json has no valid url'); return offClient(); }
  const at = p => new URL(String(p).replace(/^\/+/, ''), base.href.endsWith('/') ? base.href : `${base.href}/`).href;
  const json = (method, p, body) => call(at(p), { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, `${method} ${p}`);
  return {
    on: true, provider: cfg.provider, url: base.origin, user: null,
    signIn: async () => null, signOut: async () => {},
    /** GET/POST/PUT/DELETE a path of the server; resolves to { data, error, status }. */
    get: p => json('GET', p), post: (p, b = {}) => json('POST', p, b), put: (p, b = {}) => json('PUT', p, b), del: p => json('DELETE', p),
    /** The server's WebSocket origin (wss://), for a game that keeps a socket open. */
    socketUrl: (p = '') => at(p).replace(/^http/, 'ws'),
    from: () => { throw new Error(`gf-backend: ${cfg.provider} is a server, not a database: use get/post`); },
    rpc: async () => ({ data: null, error: 'not a database', status: 0 }), invoke: async () => ({ data: null, error: 'not a database', status: 0 }),
  };
}

function offClient() {
  const off = async () => ({ data: null, error: 'off', status: 0 });
  const table = () => ({ select: off, insert: off, upsert: off, update: off, delete: off });
  return { on: false, user: null, signIn: async () => null, signOut: async () => {}, from: table, rpc: off, invoke: off };
}

function supabaseClient(url, key, players) {
  const SESSION = `gf-backend:${url}`;
  let session = store.get(SESSION);
  const db = { on: true, url, user: session?.user ? { id: session.user.id } : null };

  const headers = (extra = {}) => {
    const h = { apikey: key, 'content-type': 'application/json', ...extra };
    const bearer = session?.access_token ?? (isJwt(key) ? key : null);
    if (bearer) h.authorization = `Bearer ${bearer}`;
    return h;
  };
  const keep = s => {
    session = s && s.access_token ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600), user: { id: s.user?.id } } : null;
    db.user = session?.user?.id ? { id: session.user.id } : null;
    store.set(SESSION, session);
  };
  async function fresh() {
    if (!session) return;
    if (session.expires_at - 60 > Date.now() / 1000) return;
    const r = await call(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) }, 'refreshing the sign-in');
    keep(r.error ? null : r.data);
  }

  /** This player's id: an anonymous sign-in on first use, kept in this browser. → { id } or null */
  db.signIn = async () => {
    if (players !== 'anonymous') return null;
    await fresh();
    if (session) return db.user;
    const r = await call(`${url}/auth/v1/signup`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: '{}' }, 'signing in');
    if (r.error) { if (/anonymous/i.test(r.error)) warn('anon', 'anonymous sign-ins are off on this project: npx gamesfun backend connect supabase --players anonymous, or turn them on in the Supabase dashboard'); return null; }
    keep(r.data);
    return db.user;
  };
  db.signOut = async () => { keep(null); };

  db.from = table => {
    if (!TABLE.test(table)) throw new Error(`gf-backend: bad table name ${table}`);
    const base = `${url}/rest/v1/${table}`;
    const go = async (method, q, body, prefer, label) => {
      await fresh();
      const qs = q.toString();
      return call(`${base}${qs ? `?${qs}` : ''}`, { method, headers: headers(prefer ? { prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) }, `${label} ${table}`);
    };
    return {
      select: (columns = '*', o = {}) => go('GET', filters(new URLSearchParams({ select: columns }), o), undefined, null, 'reading'),
      insert: (rows, o = {}) => go('POST', new URLSearchParams(o.select ? { select: o.select } : {}), rows, 'return=representation', 'adding to'),
      upsert: (rows, o = {}) => go('POST', new URLSearchParams(o.onConflict ? { on_conflict: o.onConflict } : {}), rows, 'resolution=merge-duplicates,return=representation', 'saving to'),
      update: (patch, o = {}) => go('PATCH', filters(new URLSearchParams(), o), patch, 'return=representation', 'changing'),
      delete: (o = {}) => go('DELETE', filters(new URLSearchParams(), o), undefined, 'return=representation', 'removing from'),
    };
  };
  /** A Postgres function (create it security invoker, or definer with auth.uid() checked inside). */
  db.rpc = async (fn, args = {}) => { if (!TABLE.test(fn)) throw new Error(`gf-backend: bad function name ${fn}`); await fresh(); return call(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) }, `calling ${fn}`); };
  /** An edge function, with the player's sign-in (server logic and the secrets it needs stay on the server). */
  db.invoke = async (name, body = {}) => { if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name)) throw new Error(`gf-backend: bad function name ${name}`); await fresh(); return call(`${url}/functions/v1/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, `calling ${name}`); };
  return db;
}
