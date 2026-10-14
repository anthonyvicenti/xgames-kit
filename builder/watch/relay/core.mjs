// games.fun watch relay: the channel rules as pure logic (MIT). No I/O of its own: the host (node.mjs, or the
// Cloudflare Durable Object in cloudflare/channel.mjs) injects sockets, the clock, one wake-up timer and storage, so both
// behave the same. Contract: watch/PLAN.md §3.2. The relay reads only a frame's `k` and its size; it forwards
// the streamer's text as it came and never looks inside key frames or deltas.
//
// A connection (`conn`) is the host's wrapper of one WebSocket, stable for that socket:
//   { state: {role: 'pub' | 'viewer', authed?, t0?, gone?}, send(text), close(code, reason), buffered?(), persist?() }
// `state` is plain JSON (the Durable Object keeps it in the socket's attachment and persist() writes it back).
// io: { sockets(role) → conns, schedule(atMs | null) } (one wake-up; the host calls channel.tick() when it fires).
// storage: { load() → record | null, save(record | null) } (synchronous).
//
// A few thousand viewers (2026-10-12; the creator: "How hard is it to scale this up to at least a few thousand?"): on
// Cloudflare a channel's viewers are spread over repeaters (Repeater below, one Durable Object each, at most
// `shardViewers` viewers), and each repeater is one 'relay' connection of the channel. The channel sends a relay what it
// sends a viewer; a relay says how many it serves ({k:'count', n}) and the channel counts them in. Node serves viewers
// directly (one process, a few hundred at most). Voice (the same day: "add in an audio stream from a mic for the stream
// watchers"): the streamer's `a` frames, compressed audio, fanned out as they come, never cached, within a byte budget.

export const WATCH_PATH = '/watch/v1/';
export const ID_RE = /^[a-z0-9]{12}$/;
export const LIMITS = {
  helloMs: 5000, graceMs: 10000, expiryMs: 30 * 86400e3, maxViewers: 200, slowBytes: 1 << 20, countMs: 1000,
  // one network (2026-10-12): phones on one carrier share an address, so the cap is wide (it was 8) and joins are paced
  // instead: at most `ipJoinBurst` new viewers at once from one address, then `ipJoinRate` a second
  maxPerIp: 32, ipJoinBurst: 40, ipJoinRate: 1,
  rate: 40, burst: 80, maxFrame: 65536, cacheFrames: 120, cacheBytes: 512 * 1024,
  // voice: bytes a second of `a` frames, and the burst; past it a frame is dropped (the stream goes on)
  // (Opus at 24 kbit/s measured 4.4 KB/s in `a` frames, 2026-10-12)
  aRate: 8000, aBurst: 16000,
  // repeaters: the most viewers one serves, and how long it keeps its line to the channel after its last viewer
  shardViewers: 250, lingerMs: 30000,
  sizes: { hello: 4096, key: 65536, d: 16384, meta: 2048, bye: 1024, a: 4096 },
};
// Close codes (PLAN §3.2). 4000 (bad, binary or late hello) and 1009 (frame too big) are ours: the plan names no code for them.
export const CLOSE = { readOnly: 1008, tooBig: 1009, hello: 4000, key: 4003, rate: 4008, replaced: 4009, slow: 4010, full: 4029 };

const te = new TextEncoder();
const byteLength = s => te.encode(s).length;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- HTTP helpers shared by the Node server and the Worker -------------------------------------------------------
export function parseOrigins(s) {
  const list = (Array.isArray(s) ? s : String(s ?? '').split(',')).map(x => String(x).trim()).filter(Boolean);
  return list.length ? list : null;                      // null = allow all (local use)
}
export const originOk = (origin, list) => !origin || !list || list.includes(origin);
/** pathname → null (not ours) | {health: true} | {id} | {bad: true}. `base` is the mount path with a trailing slash. */
export function route(pathname, base = WATCH_PATH) {
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  if (rest === 'health') return { health: true };
  return ID_RE.test(rest) ? { id: rest } : { bad: true };
}
export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
/** The HTTP answer for a routed request: {status, headers, body (object | null)}. `info()` gives the channel's presence. */
export function httpAnswer(method, r, info) {
  if (method === 'OPTIONS') return { status: 204, headers: { ...JSON_HEADERS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' }, body: null };
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { ...JSON_HEADERS, allow: 'GET, HEAD, OPTIONS' }, body: { error: 'GET only' } };
  if (r.bad) return { status: 400, headers: JSON_HEADERS, body: { error: 'bad id: 12 characters a-z0-9' } };
  return { status: 200, headers: JSON_HEADERS, body: r.health ? { ok: true } : info() };
}

// ---- the channel ---------------------------------------------------------------------------------------------------
export class Channel {
  constructor({ id, io, storage = null, now = Date.now, limits = {} }) {
    Object.assign(this, { id, io, store: storage, now });
    this.lim = { ...LIMITS, ...limits, sizes: { ...LIMITS.sizes, ...limits.sizes } };
    this.rec = { hash: null, meta: null, live: false, since: null, lastLive: null, graceUntil: null, ...(storage?.load() ?? {}) };
    this.cache = { key: null, d: [], bytes: 0, stale: true };      // lost on hibernation: viewers then wait for the next key frame
    this.count = { at: 0, dirty: false, last: -1 };
    this.buckets = new WeakMap(); this.chain = new WeakMap(); this.voice = new WeakMap();
  }

  // -- views
  viewers() { return this.io.sockets('viewer').filter(c => !c.state.gone); }
  relays() { return this.io.sockets('relay').filter(c => !c.state.gone); }
  /** Everyone watching: this channel's own viewers and every repeater's. */
  total() { let n = this.viewers().length; for (const r of this.relays()) n += Math.max(0, Math.min(this.lim.shardViewers, r.state.n | 0)); return n; }
  pubs() { return this.io.sockets('pub').filter(c => !c.state.gone); }
  activePub() { return this.pubs().find(c => c.state.authed) ?? null; }
  info() {
    this.reconcile();
    const r = this.rec;
    return { v: 1, id: this.id, live: r.live, viewers: this.total(), meta: r.meta ?? null, since: r.live ? r.since : null };
  }
  /** True when nothing is left to remember (no key bound, not live): the host may drop the channel. */
  forgotten() { return !this.rec.hash && !this.rec.live; }

  // -- helpers
  save() { this.store?.save(this.rec); }
  put(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch {} }
  fail(conn, code, closeCode) { this.put(conn, { k: 'error', code }); try { conn.close(closeCode, code); } catch {} conn.state.gone = true; }
  fanout(text) {
    let slow = false;
    for (const v of this.viewers()) {
      if ((v.buffered?.() ?? 0) > this.lim.slowBytes) { try { v.close(CLOSE.slow, 'slow'); } catch {} v.state.gone = true; slow = true; continue; }
      try { v.send(text); } catch {}
    }
    for (const r of this.relays()) try { r.send(text); } catch {}
    if (slow) this.markCount();
  }
  state(extra) { return { k: 'state', live: this.rec.live, meta: this.rec.meta ?? null, viewers: this.total(), since: this.rec.live ? this.rec.since : null, ...extra }; }
  /** A new viewer from this address may join now (the join pace, per address; lost on hibernation, which is fine). */
  paced(ip) {
    if (!ip) return true;
    const t = this.now(), m = this.joins ??= new Map();
    let b = m.get(ip); if (!b) m.set(ip, b = { n: this.lim.ipJoinBurst, at: t });
    b.n = Math.min(this.lim.ipJoinBurst, b.n + (t - b.at) * this.lim.ipJoinRate / 1000); b.at = t;
    if (m.size > 5000) for (const [k, v] of m) if (v.n >= this.lim.ipJoinBurst) m.delete(k);
    if (b.n < 1) return false;
    b.n -= 1; return true;
  }
  resetCache() { this.cache = { key: null, d: [], bytes: 0, stale: true }; }
  /** A live channel whose streamer socket is gone with no grace running (the object restarted): start the grace. */
  reconcile() {
    const r = this.rec;
    if (r.live && !r.graceUntil && !this.activePub()) { r.graceUntil = this.now() + this.lim.graceMs; this.save(); }
  }
  forget() { this.rec = { hash: null, meta: null, live: false, since: null, lastLive: null, graceUntil: null }; this.resetCache(); this.store?.save(null); }

  // -- connection lifecycle
  connect(conn) {
    const s = conn.state;
    if (s.role === 'pub') { s.t0 = this.now(); s.authed = false; conn.persist?.(); this.wake(); return; }
    this.expireIfOld();
    if (s.role === 'relay') {                     // a repeater: what a viewer gets, and its count comes in its own frames
      s.n = 0; conn.persist?.();
      this.put(conn, this.state());
      const c = this.cache;
      if (this.rec.live && c.key && !c.stale) { conn.send(c.key); for (const d of c.d) conn.send(d); }
      return;
    }
    const others = this.viewers().filter(c => c !== conn).length;
    if (others >= this.lim.maxViewers) { this.put(conn, this.state({ full: true, viewers: others })); try { conn.close(CLOSE.full, 'full'); } catch {} s.gone = true; return; }
    // one network can't fill the audience (play-test 1, 2026-10-09: 199 scripted sockets read as "200 watching" and
    // turned real people away): at most maxPerIp viewers of a channel from one address
    if (s.ip && ((this.lim.maxPerIp > 0 && this.viewers().filter(c => c !== conn && c.state.ip === s.ip).length >= this.lim.maxPerIp) || !this.paced(s.ip))) {
      this.put(conn, this.state({ full: true, viewers: others, why: 'network' })); try { conn.close(CLOSE.full, 'full'); } catch {} s.gone = true; return;
    }
    this.put(conn, this.state());
    const c = this.cache;
    if (this.rec.live && c.key && !c.stale) { conn.send(c.key); for (const d of c.d) conn.send(d); }
    this.markCount();
  }
  closed(conn) {
    const was = conn.state.gone; conn.state.gone = true;
    if (conn.state.role === 'viewer' || conn.state.role === 'relay') { if (!was) this.markCount(); return; }
    this.chain.delete(conn);
    if (conn.state.authed && this.rec.live && !this.activePub()) { this.rec.graceUntil = this.now() + this.lim.graceMs; this.save(); this.wake(); }
  }

  // -- messages. `text` is the frame, or null for a binary one. Returns a promise only while a hello is being checked.
  message(conn, text) {
    const s = conn.state;
    if (s.gone) return;
    if (text === 'ping') { try { conn.send('pong'); } catch {} return; }
    if (s.role === 'relay') {                     // a repeater says how many it serves; nothing else
      let f = null; try { f = JSON.parse(text); } catch {}
      if (isObj(f) && f.k === 'count' && Number.isInteger(f.n) && f.n >= 0) { s.n = Math.min(this.lim.shardViewers, f.n); conn.persist?.(); this.markCount(); }
      return;
    }
    if (s.role === 'viewer') { try { conn.close(CLOSE.readOnly, 'read-only'); } catch {} s.gone = true; this.markCount(); return; }
    const queued = this.chain.get(conn);
    if (queued) { const q = queued.then(() => this.pubFrame(conn, text)).catch(() => {}); this.chain.set(conn, q); return q; }
    const r = this.pubFrame(conn, text);
    if (r?.then) { const q = r.catch(() => {}).then(() => { if (this.chain.get(conn) === q) this.chain.delete(conn); }); this.chain.set(conn, q); return q; }
  }

  pubFrame(conn, text) {
    const s = conn.state, t = this.now();
    let b = this.buckets.get(conn); if (!b) this.buckets.set(conn, b = { n: this.lim.burst, at: t });
    b.n = Math.min(this.lim.burst, b.n + (t - b.at) * this.lim.rate / 1000); b.at = t;
    if (b.n < 1) return this.fail(conn, 'rate', CLOSE.rate);
    b.n -= 1;
    if (text === null) return this.fail(conn, 'text', CLOSE.hello);
    const size = byteLength(text);
    if (size > this.lim.maxFrame) return this.fail(conn, 'size', CLOSE.tooBig);
    let f = null; try { f = JSON.parse(text); } catch {}
    const k = isObj(f) ? f.k : null;
    if (!s.authed) return k === 'hello' && size <= this.lim.sizes.hello ? this.hello(conn, f) : this.fail(conn, 'hello', CLOSE.hello);
    const max = this.lim.sizes[k];
    if (max === undefined || k === 'hello') return;                                  // unknown k: ignored
    if (size > max) return this.fail(conn, 'size', CLOSE.tooBig);
    if (!this.rec.live) return;
    const c = this.cache;
    switch (k) {
      case 'key': this.cache = { key: text, d: [], bytes: 0, stale: false }; this.fanout(text); break;
      case 'd':
        if (!c.stale) {
          c.d.push(text); c.bytes += size;
          if (c.d.length > this.lim.cacheFrames || c.bytes > this.lim.cacheBytes) { c.d = []; c.bytes = 0; c.stale = true; }
        }
        this.fanout(text); break;
      case 'meta':
        if (!isObj(f.meta)) return;
        this.rec.meta = f.meta; this.rec.lastLive = t; this.save(); this.fanout(text); break;
      case 'bye': this.end('bye'); try { conn.close(1000, 'bye'); } catch {} break;
      case 'a': {                                   // voice: as it comes, within the byte budget; never cached
        let a = this.voice.get(conn); if (!a) this.voice.set(conn, a = { n: this.lim.aBurst, at: t });
        a.n = Math.min(this.lim.aBurst, a.n + (t - a.at) * this.lim.aRate / 1000); a.at = t;
        if (a.n < size) { this.dropped = (this.dropped ?? 0) + 1; return; }
        a.n -= size; this.fanout(text); break;
      }
    }
  }

  async hello(conn, f) {
    if (f.v !== 1 || typeof f.key !== 'string' || f.key.length < 16 || f.key.length > 128) return this.fail(conn, 'hello', CLOSE.hello);
    const hash = await sha256hex(f.key);
    if (conn.state.gone) return;
    this.expireIfOld();
    const r = this.rec, t = this.now();
    if (r.hash && r.hash !== hash) return this.fail(conn, 'key', CLOSE.key);
    r.hash = hash;
    for (const o of this.pubs()) if (o !== conn && o.state.authed) {                  // the right key replaces the old streamer
      o.state.authed = false; o.persist?.(); this.put(o, { k: 'error', code: 'replaced' }); try { o.close(CLOSE.replaced, 'replaced'); } catch {}
    }
    conn.state.authed = true; conn.persist?.();
    const before = JSON.stringify(r.meta), wasLive = r.live;
    if (isObj(f.meta) && byteLength(JSON.stringify(f.meta)) <= this.lim.sizes.meta) r.meta = f.meta;
    r.graceUntil = null; r.lastLive = t;
    if (!wasLive) { r.live = true; r.since = t; this.resetCache(); }
    this.save();
    this.count.last = this.total();
    this.put(conn, { k: 'ok', viewers: this.count.last });
    if (!wasLive) this.fanout(JSON.stringify(this.state()));
    else if (JSON.stringify(r.meta) !== before) this.fanout(JSON.stringify({ k: 'meta', meta: r.meta }));
    this.wake();
  }

  end(why) {
    const r = this.rec;
    if (!r.live) return;
    r.live = false; r.since = null; r.graceUntil = null; r.lastLive = this.now(); this.save();
    this.resetCache();
    this.fanout(JSON.stringify({ k: 'end', why }));
    this.wake();
  }

  // -- viewer counts: at most once a second, to the streamer and the viewers
  markCount() { this.count.dirty = true; if (this.now() - this.count.at >= this.lim.countMs) this.flushCount(); else this.wake(); }
  flushCount() {
    const c = this.count, n = this.total();
    c.dirty = false; c.at = this.now();
    if (n === c.last) return;
    c.last = n;
    if (!this.rec.live) return;
    const text = JSON.stringify({ k: 'viewers', n });
    const p = this.activePub(); if (p) try { p.send(text); } catch {}
    this.fanout(text);
  }

  // -- time: one wake-up at the earliest deadline; the host calls tick() when it fires
  expireIfOld() {
    const r = this.rec;
    if (!r.live && r.lastLive && this.now() - r.lastLive >= this.lim.expiryMs) this.forget();
  }
  tick() {
    const t = this.now();
    for (const p of this.pubs()) if (!p.state.authed && p.state.t0 + this.lim.helloMs <= t) this.fail(p, 'hello', CLOSE.hello);
    this.reconcile();
    if (this.rec.graceUntil && t >= this.rec.graceUntil) this.end('lost');
    if (this.count.dirty && t - this.count.at >= this.lim.countMs) this.flushCount();
    this.expireIfOld();
    this.wake();
  }
  wake() {
    const r = this.rec, due = [];
    for (const p of this.pubs()) if (!p.state.authed) due.push(p.state.t0 + this.lim.helloMs);
    if (r.graceUntil) due.push(r.graceUntil);
    if (this.count.dirty) due.push(this.count.at + this.lim.countMs);
    if (!r.live && r.lastLive) due.push(r.lastLive + this.lim.expiryMs);
    this.io.schedule(due.length ? Math.min(...due) : null);
  }
}

// ---- a repeater (Cloudflare: one Durable Object of a channel's viewers) ---------------------------------------------
// It holds up to `shardViewers` viewers and one line to the channel (`io.up`: the host opens it as a 'relay' socket of
// the channel). Everything the channel sends comes down that line and goes to every viewer as it came; the repeater
// keeps what a newcomer needs (the stream's state, the key frame and the deltas after it) and says how many it serves,
// at most once a second. With no viewers for `lingerMs` it lets the line go. Viewers here follow the channel's rules:
// read-only, `ping` answered, the per-address cap and pace.
//   io: { sockets('viewer') → conns, schedule(atMs | null), up: { open(), close(), send(text) → bool, isOpen() → bool } }
export class Repeater {
  constructor({ id, shard = 0, io, now = Date.now, limits = {} }) {
    Object.assign(this, { id, shard, io, now });
    this.lim = { ...LIMITS, ...limits, sizes: { ...LIMITS.sizes, ...limits.sizes } };
    this.st = { live: false, meta: null, since: null, total: 0, got: false };
    this.cache = { key: null, d: [], bytes: 0, stale: true };
    this.count = { at: 0, dirty: false, last: -1 };
    this.emptyAt = null; this.upTries = 0; this.upRetryAt = null;
  }
  viewers() { return this.io.sockets('viewer').filter(c => !c.state.gone); }
  /** Room for one more (the Worker tries the next repeater when this one is full). */
  hasRoom() { return this.viewers().length < this.lim.shardViewers; }
  put(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch {} }
  state(extra) { return { k: 'state', live: this.st.live, meta: this.st.meta, viewers: Math.max(this.st.total, this.viewers().length), since: this.st.live ? this.st.since : null, ...extra }; }
  paced(ip) { return Channel.prototype.paced.call(this, ip); }
  fanout(text) {
    let slow = false;
    for (const v of this.viewers()) {
      if ((v.buffered?.() ?? 0) > this.lim.slowBytes) { try { v.close(CLOSE.slow, 'slow'); } catch {} v.state.gone = true; slow = true; continue; }
      try { v.send(text); } catch {}
    }
    if (slow) this.markCount();
  }

  connect(conn) {
    const s = conn.state, others = this.viewers().filter(c => c !== conn).length;
    const refuse = why => { this.put(conn, this.state({ full: true, ...(why ? { why } : {}) })); try { conn.close(CLOSE.full, 'full'); } catch {} s.gone = true; };
    if (others >= this.lim.shardViewers) return refuse(null);
    if (s.ip && ((this.lim.maxPerIp > 0 && this.viewers().filter(c => c !== conn && c.state.ip === s.ip).length >= this.lim.maxPerIp) || !this.paced(s.ip))) return refuse('network');
    this.emptyAt = null;
    // a line opened now brings the channel's state and cache to every viewer here, this one too
    if (!this.io.up.isOpen()) { this.openUp(); return this.markCount(); }
    if (this.st.got) this.put(conn, this.state());           // else the channel's first state reaches everyone at once
    const c = this.cache;
    if (this.st.live && c.key && !c.stale) { conn.send(c.key); for (const d of c.d) conn.send(d); }
    this.markCount();
  }
  closed(conn) {
    const was = conn.state.gone; conn.state.gone = true;
    if (!was) this.markCount();
    if (!this.viewers().length) { this.emptyAt = this.now(); this.wake(); }
  }
  message(conn, text) {
    const s = conn.state;
    if (s.gone) return;
    if (text === 'ping') { try { conn.send('pong'); } catch {} return; }
    try { conn.close(CLOSE.readOnly, 'read-only'); } catch {} s.gone = true; this.markCount();
  }

  // -- the line to the channel
  openUp() { this.upRetryAt = null; try { this.io.up.open(); } catch { this.upClosed(); } }
  upOpened() { this.upTries = 0; this.count.last = -1; this.count.at = 0; this.markCount(); }
  upMessage(text) {
    if (typeof text !== 'string') return;
    if (text === 'pong') return;
    let f = null; try { f = JSON.parse(text); } catch {}
    const k = isObj(f) ? f.k : null, st = this.st;
    if (k === 'state') {
      const wasLive = st.live;
      st.got = true; st.live = !!f.live; st.meta = isObj(f.meta) ? f.meta : null; st.since = typeof f.since === 'number' ? f.since : null;
      st.total = Math.max(0, f.viewers | 0);
      if (!st.live || !wasLive) this.cache = { key: null, d: [], bytes: 0, stale: true };
      // each viewer gets the stream's state with the stream's own count
      return this.fanout(JSON.stringify(this.state()));
    }
    if (k === 'key') this.cache = { key: text, d: [], bytes: 0, stale: false };
    else if (k === 'd') {
      const c = this.cache;
      if (!c.stale) { c.d.push(text); c.bytes += text.length; if (c.d.length > this.lim.cacheFrames || c.bytes > this.lim.cacheBytes) { c.d = []; c.bytes = 0; c.stale = true; } }
    } else if (k === 'meta') { if (isObj(f.meta)) st.meta = f.meta; }
    else if (k === 'viewers') st.total = Math.max(0, f.n | 0);
    else if (k === 'end') { st.live = false; st.since = null; this.cache = { key: null, d: [], bytes: 0, stale: true }; }
    this.fanout(text);
  }
  upClosed() {
    this.st.got = false;
    if (!this.viewers().length) return;
    // the channel restarted (a deploy) or the line broke: back in a moment; viewers keep their sockets meanwhile
    this.upRetryAt = this.now() + Math.min(8000, 250 * 2 ** Math.min(5, this.upTries++));
    this.wake();
  }

  markCount() { this.count.dirty = true; if (this.now() - this.count.at >= this.lim.countMs) this.flushCount(); else this.wake(); }
  flushCount() {
    const c = this.count, n = this.viewers().length;
    if (n === c.last) { c.dirty = false; return; }
    if (!this.io.up.send(JSON.stringify({ k: 'count', n }))) { c.dirty = true; return; }     // the line is still opening: upOpened sends it
    c.dirty = false; c.at = this.now(); c.last = n;
  }
  tick() {
    const t = this.now();
    if (this.count.dirty && t - this.count.at >= this.lim.countMs) this.flushCount();
    if (this.emptyAt != null && !this.viewers().length && t - this.emptyAt >= this.lim.lingerMs) { this.emptyAt = null; this.st.got = false; try { this.io.up.close(); } catch {} }
    if (this.upRetryAt != null && t >= this.upRetryAt && this.viewers().length && !this.io.up.isOpen()) this.openUp();
    this.wake();
  }
  wake() {
    const due = [];
    if (this.count.dirty) due.push(Math.max(this.count.at + this.lim.countMs, this.now() + 200));    // never a busy loop while the line is down
    if (this.emptyAt != null) due.push(this.emptyAt + this.lim.lingerMs);
    if (this.upRetryAt != null) due.push(this.upRetryAt);
    this.io.schedule(due.length ? Math.min(...due) : null);
  }
}

/** Which repeater a viewer starts at: by its address (one network's viewers share a repeater, so its cap holds), or at
 *  random (a load test from one machine). → 0..shards-1 */
export function shardFor(ip, shards, by = 'ip') {
  if (shards <= 1) return 0;
  if (by === 'random' || !ip) return Math.floor(Math.random() * shards);
  let h = 2166136261;
  for (let i = 0; i < ip.length; i++) { h ^= ip.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % shards;
}
