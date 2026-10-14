// Persistent worlds on the play host (worlds/PLAN.md §2, §4; docs/play-origin.md "World saves"): the protocol,
// its limits, validation against the world's config, the snapshot format and an in-memory store. One module for every
// server, so they can't drift: the play origin's routes (lib/world-http.mjs: Postgres rows, snapshots in the bucket),
// the local world server (builder/world-server/serve.mjs: memoryStore() kept on disk by lib/world-files.mjs) and the tests.
// Pure: no Node or DOM imports (Web Crypto, CompressionStream and TextEncoder only), like lib/signal-core.mjs.
//
// A world is one published game's shared block world. The room's host copy pushes the block edits its room accepted;
// every copy loads the world from here: the latest snapshot (immutable) plus the edits after it.
//
//   GET  /world/v1/<slug>             → {v:1, slug, seq, locked, config, snap: {seq, url, cells} | null, edits, more?}
//   GET  /world/v1/<slug>?after=<seq> → {seq, edits, more?} | {reset: {seq}} | {gap: true}
//   GET  /world/v1/<slug>/snap/<seq>  → the gzip snapshot (application/octet-stream, immutable)
//   POST /world/v1/<slug>  {op:'push', after, edits: [[u, x, y, z, v, text?, face?], ...]}
//        → {seq, ok: [[u, seq, text?]], refused: [[u, reason]], edits: [edits by others after `after`], more?, reset?}
//   An edit out is [seq, u, x, y, z, v] or, for a sign, [seq, u, x, y, z, v, text, face]. `text` in `ok` is the sign's
//   text as saved, present only when the word filter changed it.
//   Refusal reasons: bounds, protected, block, tint, text, face, locked, rate (try again later: the edit was valid),
//   reset (the world was restored after `after`: reload it). Errors: 404 {error:'no-world'}, 403 {error:'origin'},
//   413 {error:'too-large'}, 429 {error:'rate', retryAfter} (seconds), 400 {error:'bad', reason}.
//
// An edit's `u` is unique per world: the server keeps the first and answers a repeat with that first edit's seq, so a
// push sent twice is safe. Every edit gets the next world sequence number, in order, under a per-world lock.

import {cleanSignText} from './world-text.mjs';

export const WORLD_LIMITS = Object.freeze({
  pushEdits: 500,               // edits in one push
  pushBytes: 64 * 1024,         // one push's body
  pageEdits: 3000,              // edits in one answer; past that `more: true`, and the client pages with ?after=
  compactEvery: 2000,           // a new snapshot once this many edits follow the last one
  dailyMs: 24 * 60 * 60_000,    // ...and one a day while the world changes
  textChars: 240,               // a sign's text as sent (before the filter keeps 3 lines and 60 characters)
  postsPerNetPerMin: 60,        // per network (keyed hash of the address), a minute
  editsPerNetPerMin: 3000,
  getsPerNetPerMin: 120,
  editsPerWorldPerMin: 6000,    // per world, a minute, whoever sends them
  maxAxis: 1024, maxProtect: 32,
  sweepEveryMs: 30_000,         // old rate counters are deleted at most this often (per server instance)
});

export const EDIT_ID = /^[A-Za-z0-9._-]{1,24}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The shape of a published game's slug (lib/publish.mjs checkSlug, without its reserved words). */
export const isWorldSlug = s => typeof s === 'string' && s.length >= 3 && s.length <= 48 && SLUG.test(s);
export const snapKey = (slug, seq) => `worlds/${slug}/${seq}.gfw`;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const te = new TextEncoder(), td = new TextDecoder('utf-8', {fatal: true});
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function netKey(secret, ip) {
  const text = `world-ip|${ip ?? ''}`;
  if (!secret) return hex(await crypto.subtle.digest('SHA-256', te.encode(text))).slice(0, 24);
  const key = await crypto.subtle.importKey('raw', te.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, te.encode(text))).slice(0, 24);
}

/** Whether `origin` (an Origin header) is the page origin for `host` (a host[:port], no scheme). */
export function sameOrigin(origin, host) {
  if (!origin || !host || origin === 'null') return false;
  try { return new URL(origin).host.toLowerCase() === String(host).trim().toLowerCase(); } catch { return false; }
}

// ---------------- the world's config (config/world.json in the published game, PLAN §4.2) ----------------

/**
 * The parts of config/world.json the server checks edits against, or null when it is not a voxel world (or broken).
 * → {size: [sx, sy, sz], floor, blocks: N, blockIds, tints, signBlock: 1-based id or 0, protect: [{min, max, why}], seed}
 */
export function worldConfig(raw, limits = WORLD_LIMITS) {
  if (!isObj(raw) || raw.template !== 'voxel' || !isObj(raw.voxel)) return null;
  const vx = raw.voxel;
  const size = vx.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every(n => Number.isInteger(n) && n >= 1 && n <= limits.maxAxis)) return null;
  const floor = vx.floor ?? 0;
  if (!Number.isInteger(floor) || floor < 0 || floor >= size[1]) return null;
  if (!Array.isArray(vx.blocks) || vx.blocks.length < 1 || vx.blocks.length > 255) return null;
  const blockIds = vx.blocks.map(b => (typeof b === 'string' ? b : isObj(b) && typeof b.id === 'string' ? b.id : null));
  if (blockIds.some(id => !id)) return null;
  // the paint colours (voxel.paint, the kit's blocks.mjs) give the tints: 0 is no paint, 1..paint.length a colour
  const tints = vx.tints ?? (Array.isArray(vx.paint) ? vx.paint.length + 1 : 1);
  if (!Number.isInteger(tints) || tints < 1 || tints > 256) return null;
  let signBlock = 0;
  if (vx.signBlock != null) {
    signBlock = typeof vx.signBlock === 'number' ? vx.signBlock : blockIds.indexOf(vx.signBlock) + 1;
    if (!Number.isInteger(signBlock) || signBlock < 1 || signBlock > blockIds.length) return null;
  }
  const protect = [];
  const corner = c => Array.isArray(c) && c.length === 3 && c.every(Number.isInteger);
  for (const p of Array.isArray(vx.protect) ? vx.protect : []) {
    if (!isObj(p) || !corner(p.min) || !corner(p.max)) return null;
    protect.push({min: p.min.map((v, i) => Math.min(v, p.max[i])), max: p.max.map((v, i) => Math.max(v, p.min[i])), why: typeof p.why === 'string' ? p.why.slice(0, 80) : ''});
  }
  if (protect.length > limits.maxProtect) return null;
  return Object.freeze({size: [...size], floor, blocks: blockIds.length, blockIds, tints, signBlock, protect, seed: Number.isInteger(vx.seed) ? vx.seed : null});
}

/** What GET tells every copy about the rules (the game has the full config in its own files). */
export const publicConfig = c => ({size: c.size, floor: c.floor, blocks: c.blocks, tints: c.tints, protect: c.protect, signBlock: c.signBlock});

/**
 * One edit against the config. null when it isn't an edit at all (not an array, or a bad `u`): the whole push is then
 * refused (400). Else {u, reason} for a refusal, or {u, x, y, z, v, text, face, changed} to save. A sign edit
 * (block === signBlock) has a face of 0–5 and a string text, which comes back cleaned (lib/world-text.mjs); every
 * other edit has neither. Air is v = 0: a painted cell of air is refused (tint).
 */
export function checkEdit(cfg, e, limits = WORLD_LIMITS) {
  if (!Array.isArray(e) || e.length < 5 || e.length > 7 || typeof e[0] !== 'string' || !EDIT_ID.test(e[0])) return null;
  const [u, x, y, z, v, text, face] = e;
  const [sx, sy, sz] = cfg.size;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || x < 0 || x >= sx || y < cfg.floor || y >= sy || z < 0 || z >= sz) return {u, reason: 'bounds'};
  if (cfg.protect.some(p => x >= p.min[0] && x <= p.max[0] && y >= p.min[1] && y <= p.max[1] && z >= p.min[2] && z <= p.max[2])) return {u, reason: 'protected'};
  if (!Number.isInteger(v) || v < 0 || v > 65535 || (v & 255) > cfg.blocks) return {u, reason: 'block'};
  const block = v & 255, tint = v >> 8;
  if (tint >= cfg.tints || (block === 0 && tint !== 0)) return {u, reason: 'tint'};
  if (cfg.signBlock && block === cfg.signBlock) {
    if (typeof text !== 'string' || text.length > limits.textChars) return {u, reason: 'text'};
    if (!Number.isInteger(face) || face < 0 || face > 5) return {u, reason: 'face'};
    const clean = cleanSignText(text);
    return {u, x, y, z, v, text: clean.text, face, changed: clean.changed};
  }
  if (text != null) return {u, reason: 'text'};
  if (face != null) return {u, reason: 'face'};
  return {u, x, y, z, v, text: null, face: null, changed: false};
}

// ---------------- world state and snapshots ----------------

export const cellIndex = (size, x, y, z) => (y * size[2] + z) * size[0] + x;
export const cellXYZ = (size, i) => [i % size[0], Math.floor(i / (size[0] * size[2])), Math.floor(i / size[0]) % size[2]];
const inSize = (size, x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < size[0] && y < size[1] && z < size[2];

/** The folded state of a world: the last v of every cell ever edited, and the signs still standing. */
export const emptyState = size => ({size: [...size], cells: new Map(), signs: new Map()});

/** Applies one saved edit ({x, y, z, v, text, face}): a cell that is no longer a sign loses its sign. */
export function applyEdit(state, r) {
  if (!inSize(state.size, r.x, r.y, r.z)) return;
  const i = cellIndex(state.size, r.x, r.y, r.z);
  state.cells.set(i, r.v);
  if (r.text != null) state.signs.set(i, [r.text, r.face]); else state.signs.delete(i);
}

/** Loads a decoded snapshot into `state` (re-indexed when the world's size changed since). */
export function applySnapshot(state, snap) {
  const same = snap.size.every((n, k) => n === state.size[k]);
  const at = i => { if (same) return i; const [x, y, z] = cellXYZ(snap.size, i); return inSize(state.size, x, y, z) ? cellIndex(state.size, x, y, z) : -1; };
  for (let k = 0; k < snap.index.length; k++) { const i = at(snap.index[k]); if (i >= 0) state.cells.set(i, snap.value[k]); }
  for (const [index, text, face] of snap.signs) { const i = at(index); if (i >= 0) state.signs.set(i, [text, face]); }
  return state;
}

async function through(stream, bytes) {
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes).then(() => writer.close());
  writing.catch(() => {});   // a failure shows on the reading side
  const reader = stream.readable.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    parts.push(value); n += value.byteLength;
  }
  await writing;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
const MAGIC = [0x47, 0x46, 0x57, 0x31];   // "GFW1"

/**
 * A snapshot: gzip of (little-endian)
 *   "GFW1" | u32 seq | u16 sx | u16 sy | u16 sz | u32 count | count × (varint delta, varint v) | u32 signBytes | utf8 JSON
 * Indices (y*sz + z)*sx + x ascend; delta is the first index, then index − previous; varints are unsigned LEB128.
 * The JSON is [[index, text, face], ...], ascending. → Promise<Uint8Array>
 */
export async function encodeSnapshot({seq, size, cells, signs}) {
  const keys = [...cells.keys()].sort((a, b) => a - b);
  const signList = [...signs.entries()].filter(([i]) => cells.has(i)).sort((a, b) => a[0] - b[0]).map(([i, [text, face]]) => [i, text, face]);
  const json = signList.length ? te.encode(JSON.stringify(signList)) : new Uint8Array(0);
  const buf = new Uint8Array(18 + keys.length * 8 + 4 + json.length);
  const dv = new DataView(buf.buffer);
  buf.set(MAGIC, 0);
  dv.setUint32(4, seq, true); dv.setUint16(8, size[0], true); dv.setUint16(10, size[1], true); dv.setUint16(12, size[2], true);
  dv.setUint32(14, keys.length, true);
  let at = 18, prev = 0;
  const varint = n => { while (n > 127) { buf[at++] = (n & 127) | 128; n = Math.floor(n / 128); } buf[at++] = n; };
  for (let k = 0; k < keys.length; k++) { varint(k ? keys[k] - prev : keys[k]); varint(cells.get(keys[k])); prev = keys[k]; }
  dv.setUint32(at, json.length, true); at += 4;
  buf.set(json, at); at += json.length;
  return through(new CompressionStream('gzip'), buf.subarray(0, at));
}

/** → Promise<{seq, size, index: Uint32Array, value: Uint16Array, signs: [[index, text, face], ...]}>. Throws on anything else. */
export async function decodeSnapshot(gz) {
  let b;
  try { b = await through(new DecompressionStream('gzip'), gz instanceof Uint8Array ? gz : new Uint8Array(gz)); } catch { throw new Error('not a world snapshot (gzip)'); }
  const bad = why => { throw new Error(`not a world snapshot (${why})`); };
  if (b.length < 22 || MAGIC.some((m, i) => b[i] !== m)) bad('magic');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const seq = dv.getUint32(4, true), size = [dv.getUint16(8, true), dv.getUint16(10, true), dv.getUint16(12, true)], count = dv.getUint32(14, true);
  const total = size[0] * size[1] * size[2];
  if (!total || count > total || count > b.length) bad('count');
  const index = new Uint32Array(count), value = new Uint16Array(count);
  let at = 18;
  const varint = () => {
    let n = 0, mul = 1;
    for (let i = 0; i < 5; i++) {
      if (at >= b.length) bad('truncated');
      const byte = b[at++];
      n += (byte & 127) * mul;
      if (byte < 128) return n;
      mul *= 128;
    }
    return bad('varint');
  };
  let prev = 0;
  for (let k = 0; k < count; k++) {
    const d = varint(), i = k ? prev + d : d;
    if (i >= total || (k && d === 0)) bad('index');
    const v = varint();
    if (v > 65535) bad('value');
    index[k] = i; value[k] = v; prev = i;
  }
  if (at + 4 > b.length) bad('truncated');
  const signBytes = dv.getUint32(at, true); at += 4;
  if (at + signBytes !== b.length) bad('length');
  let signs = [];
  if (signBytes) {
    try { signs = JSON.parse(td.decode(b.subarray(at, at + signBytes))); } catch { bad('signs'); }
    if (!Array.isArray(signs) || !signs.every(s => Array.isArray(s) && s.length === 3 && Number.isInteger(s[0]) && s[0] >= 0 && s[0] < total && typeof s[1] === 'string' && Number.isInteger(s[2]))) bad('signs');
  }
  return {seq, size, index, value, signs};
}

// ---------------- the protocol ----------------

const ok = (body, extra) => ({status: 200, body, ...extra});
const fail = (status, error, more = {}) => ({status, body: {error, ...more}});
const editOut = r => (r.text != null ? [r.seq, r.u, r.x, r.y, r.z, r.v, r.text, r.face] : [r.seq, r.u, r.x, r.y, r.z, r.v]);
const minute = t => Math.floor(t / 60_000);
const retryAfter = t => Math.max(1, Math.ceil((60_000 - (t % 60_000)) / 1000));

/**
 * The world protocol over a store (memoryStore() here, pgStore() in lib/world-http.mjs).
 *   readConfig(slug) → Promise<{versionId, config} | null>   `config` is config/world.json parsed (any JSON): the
 *                      currently published version's. null when the slug isn't a published game.
 *   secret           keys the network hash (Studio: PLAY_SECRET); checkOrigin: POSTs must come from the play origin
 *   now, limits      injectable for tests;   snapUrl(slug, seq) → the URL a client fetches a snapshot from
 * → {get, push, snapshot, maintain, admin, stats, store, limits}. Each request method answers {status, body, later?}:
 * `later` (when set) is maintenance (a snapshot) that must not delay the answer: Next's after(), or run it once sent.
 */
export function createWorlds({store, readConfig, secret = '', now = () => Date.now(), limits = WORLD_LIMITS, checkOrigin = true,
  snapUrl = (slug, seq) => `/world/v1/${slug}/snap/${seq}`} = {}) {
  if (!store || typeof readConfig !== 'function') throw new Error('createWorlds needs a store and readConfig');
  const L = limits;
  const stats = {gets: 0, pushes: 0, saved: 0, refused: 0, snapshots: 0, rejected: 0};
  const configs = new Map();       // versionId → normalized config | null
  const busy = new Map();          // slug → a running maintenance
  let lastSweep = 0;

  async function configFor(slug) {
    if (!isWorldSlug(slug)) return null;
    const found = await readConfig(slug);
    if (!found) return null;
    if (!configs.has(found.versionId)) {
      if (configs.size > 256) configs.clear();
      configs.set(found.versionId, worldConfig(found.config, L));
    }
    const config = configs.get(found.versionId);
    return config ? {versionId: found.versionId, config} : null;
  }

  async function worldFor(slug, versionId, t) {
    let w = await store.world(slug);
    if (!w) w = await store.createWorld(slug, {versionId, t});
    else if (w.versionId !== versionId) { await store.setVersion(slug, versionId, t); w = {...w, versionId}; }
    return w;
  }

  async function limited(key, t, n, max) {
    if (t - lastSweep >= L.sweepEveryMs) {
      lastSweep = t;
      store.sweepHits(minute(t) - 1).catch(() => { lastSweep = 0; });
    }
    const count = await store.hit(key, minute(t), n);
    return {count, over: count > max, allowed: Math.max(0, Math.min(n, max - (count - n)))};
  }

  const due = (w, t) => {
    const pending = w.seq - w.snapSeq;
    if (pending >= L.compactEvery) return 'compact';
    if (pending > 0 && t - (w.snapAt ?? w.created) >= L.dailyMs) return 'daily';
    return null;
  };
  const laterFor = (slug, w, t) => (due(w, t) ? () => maintain(slug) : null);

  async function page(slug, after, w) {
    const rows = await store.edits(slug, after, L.pageEdits + 1, w.seq);
    const more = rows.length > L.pageEdits;
    return {edits: (more ? rows.slice(0, L.pageEdits) : rows).map(editOut), more};
  }

  /** GET /world/v1/<slug>[?after=<seq>]. `after` is the query value (a string) or null; `net` the client's address. */
  async function get(slug, {after = null, net = ''} = {}) {
    stats.gets++;
    const t = now();
    if (!isWorldSlug(slug)) return fail(404, 'no-world');
    let from = null;
    if (after != null && after !== '') {
      if (!/^\d{1,15}$/.test(String(after))) return fail(400, 'bad', {reason: 'after must be a sequence number'});
      from = Number(after);
    }
    if ((await limited(`get|${await netKey(secret, net)}`, t, 1, L.getsPerNetPerMin)).over) { stats.rejected++; return fail(429, 'rate', {retryAfter: retryAfter(t)}); }
    const found = await configFor(slug);
    if (!found) return fail(404, 'no-world');
    const w = await worldFor(slug, found.versionId, t);
    const later = laterFor(slug, w, t);
    if (from != null) {
      if (w.resetSeq > from) return ok({reset: {seq: w.resetSeq}}, {later});
      if (from > w.seq) return ok({gap: true}, {later});
      const p = await page(slug, from, w);
      return ok({seq: w.seq, edits: p.edits, ...(p.more ? {more: true} : {})}, {later});
    }
    const p = await page(slug, w.snapSeq, w);
    return ok({v: 1, slug, seq: w.seq, locked: !!w.locked, config: publicConfig(found.config),
      snap: w.snapSeq > 0 ? {seq: w.snapSeq, url: snapUrl(slug, w.snapSeq), cells: w.snapCells} : null,
      edits: p.edits, ...(p.more ? {more: true} : {})}, {later});
  }

  /** POST /world/v1/<slug>. `body` is the raw request text; `origin` its Origin header; `host` this server's own host. */
  async function push(slug, body, {net = '', origin = null, host = ''} = {}) {
    stats.pushes++;
    const t = now();
    if (checkOrigin && !sameOrigin(origin, host)) { stats.rejected++; return fail(403, 'origin'); }
    if (typeof body !== 'string' || !body) return fail(400, 'bad', {reason: 'no request body'});
    if (body.length > L.pushBytes) return fail(413, 'too-large');
    let m;
    try { m = JSON.parse(body); } catch { return fail(400, 'bad', {reason: 'not JSON'}); }
    if (!isObj(m) || m.op !== 'push') return fail(400, 'bad', {reason: "op must be 'push'"});
    if (!Number.isSafeInteger(m.after) || m.after < 0) return fail(400, 'bad', {reason: 'after must be a sequence number'});
    if (!Array.isArray(m.edits)) return fail(400, 'bad', {reason: 'edits must be a list'});
    if (m.edits.length > L.pushEdits) return fail(413, 'too-large', {reason: `at most ${L.pushEdits} edits a push`});
    if (!m.edits.every(e => Array.isArray(e) && e.length >= 5 && e.length <= 7 && typeof e[0] === 'string' && EDIT_ID.test(e[0])))
      return fail(400, 'bad', {reason: 'an edit is [u, x, y, z, v, text?, face?] with u of 1–24 characters [A-Za-z0-9._-]'});
    if (!isWorldSlug(slug)) return fail(404, 'no-world');
    const key = await netKey(secret, net);
    if ((await limited(`post|${key}`, t, 1, L.postsPerNetPerMin)).over) { stats.rejected++; return fail(429, 'rate', {retryAfter: retryAfter(t)}); }
    const found = await configFor(slug);
    if (!found) return fail(404, 'no-world');
    let w = await worldFor(slug, found.versionId, t);

    const accepted = [], refused = [], fresh = [];
    const seen = new Map();                                        // u → its result in this push (the first edit with that u)
    const sent = new Map();                                        // u → the text it was sent with
    const known = await store.lookup(slug, [...new Set(m.edits.map(e => e[0]))]);
    for (const e of m.edits) {
      const u = e[0];
      if (seen.has(u)) continue;
      sent.set(u, e[5]);
      if (known.has(u)) { seen.set(u, {dup: known.get(u)}); continue; }
      const c = checkEdit(found.config, e, L);
      if (c.reason) { seen.set(u, {reason: c.reason}); continue; }
      seen.set(u, {fresh: c}); fresh.push(c);
    }
    const reset = w.resetSeq > m.after ? w.resetSeq : 0;
    let saveable = fresh;
    const refuse = (list, reason) => { for (const c of list) seen.set(c.u, {reason}); };
    if (reset) { refuse(fresh, 'reset'); saveable = []; }
    else if (w.locked) { refuse(fresh, 'locked'); saveable = []; }
    else if (fresh.length) {
      // The network's budget first; the world is charged only for what the network may send, so one network over its
      // limit doesn't use up everyone else's minute.
      const byNet = (await limited(`edits|${key}`, t, fresh.length, L.editsPerNetPerMin)).allowed;
      const n = byNet ? (await limited(`world|${slug}`, t, byNet, L.editsPerWorldPerMin)).allowed : 0;
      refuse(fresh.slice(n), 'rate'); saveable = fresh.slice(0, n);
    }
    let head = w.seq, crossed = reset;
    if (saveable.length) {
      const r = await store.append(slug, saveable, {after: m.after, t, net: key});
      head = r.seq;
      if (r.reset) { crossed = r.reset; refuse(saveable, 'reset'); }
      else if (r.locked) refuse(saveable, 'locked');
      else { for (const row of r.rows) seen.set(row.u, {saved: row}); stats.saved += r.rows.length; }
      w = {...w, seq: head};
    }
    for (const [u, s] of seen) {
      if (s.reason) { refused.push([u, s.reason]); continue; }
      const row = s.dup ?? s.saved;
      // The text as saved, when it isn't what was sent (the filter changed it, or a repeat carried other text).
      accepted.push(row.text != null && row.text !== sent.get(u) ? [u, row.seq, row.text] : [u, row.seq]);
    }
    stats.refused += refused.length;
    const out = {seq: head, ok: accepted, refused};
    if (crossed) return ok({...out, edits: [], reset: {seq: crossed}});
    const rows = await store.edits(slug, m.after, L.pageEdits + 1, head);
    const others = rows.slice(0, L.pageEdits).filter(r => !seen.has(r.u)).map(editOut);
    return ok({...out, edits: others, ...(rows.length > L.pageEdits ? {more: true} : {})}, {later: laterFor(slug, w, t)});
  }

  /** GET /world/v1/<slug>/snap/<seq> → {status, bytes} or {status, body}. */
  async function snapshot(slug, seq, {net = ''} = {}) {
    const t = now();
    if (!isWorldSlug(slug) || !/^\d{1,15}$/.test(String(seq))) return fail(404, 'no-snapshot');
    if ((await limited(`get|${await netKey(secret, net)}`, t, 1, L.getsPerNetPerMin)).over) return fail(429, 'rate', {retryAfter: retryAfter(t)});
    if (!(await configFor(slug))) return fail(404, 'no-world');
    const row = await store.snapshot(slug, Number(seq));
    const bytes = row && await store.snapshotBytes(row.key);
    if (!bytes) return fail(404, 'no-snapshot');
    return {status: 200, bytes};
  }

  /** The folded state of a world at `upTo` (default: now): the last snapshot, then the edits after it. */
  async function stateOf(slug, w, size, upTo = w.seq) {
    const state = emptyState(size);
    let from = 0;
    if (w.snapSeq > 0 && w.snapKey) {
      const bytes = await store.snapshotBytes(w.snapKey);
      if (!bytes) throw new Error(`world ${slug}: snapshot ${w.snapKey} is missing`);
      const snap = await decodeSnapshot(bytes);
      applySnapshot(state, snap);
      from = snap.seq;
    }
    for (;;) {
      const rows = await store.edits(slug, from, 5000, upTo);
      for (const r of rows) applyEdit(state, r);
      if (rows.length < 5000) break;
      from = rows[rows.length - 1].seq;
    }
    return state;
  }

  async function sizeFor(slug, w) {
    const found = await configFor(slug);
    if (found) return found.config.size;
    if (w.snapSeq > 0 && w.snapKey) { const bytes = await store.snapshotBytes(w.snapKey); if (bytes) return (await decodeSnapshot(bytes)).size; }
    throw new Error(`world ${slug}: no config and no snapshot to read its size from`);
  }

  /**
   * Takes a snapshot when one is due: `compactEvery` edits after the last one, or a day since it while the world
   * changed. Never on a request's critical path (see `later`). One at a time per world in this process; two processes
   * racing write the same state under the same key, and the database keeps the first row.
   */
  function maintain(slug, {force = null} = {}) {
    if (busy.has(slug)) return busy.get(slug);
    const run = (async () => {
      const w = await store.world(slug);
      if (!w) return null;
      const t = now();
      const kind = force ?? due(w, t);
      if (!kind || w.seq === w.snapSeq) return null;
      const size = await sizeFor(slug, w);
      const state = await stateOf(slug, w, size);
      const bytes = await encodeSnapshot({seq: w.seq, size, cells: state.cells, signs: state.signs});
      await store.putSnapshot(slug, {seq: w.seq, key: snapKey(slug, w.seq), bytes, cells: state.cells.size, kind, t});
      stats.snapshots++;
      return {seq: w.seq, kind, cells: state.cells.size, bytes: bytes.length};
    })().finally(() => busy.delete(slug));
    busy.set(slug, run);
    return run;
  }

  // ---- operator commands (scripts/world-admin.mjs) ----
  const must = async slug => { const w = await store.world(slug); if (!w) throw new Error(`no world called ${slug}`); return w; };
  const signList = (state) => [...state.signs.entries()].sort((a, b) => a[0] - b[0]).map(([i, [text, face]]) => [...cellXYZ(state.size, i), text, face]);
  const admin = {
    list: () => store.list(),
    async show(slug) {
      const w = await must(slug);
      return {...w, ...(await store.counts(slug)), pending: w.seq - w.snapSeq};
    },
    async snapshots(slug) { await must(slug); return store.snapshots(slug); },
    async state(slug) { const w = await must(slug); return stateOf(slug, w, await sizeFor(slug, w)); },
    async signs(slug) { return signList(await admin.state(slug)); },
    /**
     * A new snapshot of snapshot `snapSeq`'s state at the next seq (kind 'reset'): copies that cross it reload.
     * Snapshot 0 is the world before any edit (as the game generates it): a wipe.
     */
    async restore(slug, snapSeq) {
      const w = await must(slug);
      let state;
      if (Number(snapSeq) === 0) state = emptyState(await sizeFor(slug, w));
      else {
        const row = await store.snapshot(slug, Number(snapSeq));
        if (!row) throw new Error(`world ${slug} has no snapshot ${snapSeq}`);
        const bytes = await store.snapshotBytes(row.key);
        if (!bytes) throw new Error(`world ${slug}: snapshot ${row.key} is missing from the bucket`);
        const snap = await decodeSnapshot(bytes);
        state = applySnapshot(emptyState(snap.size), snap);
      }
      const seq = await store.reset(slug, async next => ({key: snapKey(slug, next), cells: state.cells.size,
        bytes: await encodeSnapshot({seq: next, size: state.size, cells: state.cells, signs: state.signs})}), now());
      return {seq, from: Number(snapSeq), cells: state.cells.size};
    },
    async lock(slug, on) { await must(slug); await store.setLocked(slug, !!on, now()); return {slug, locked: !!on}; },
    /** Blanks a sign's text: an edit by the operator (u = op.<n>), saved even when the world is locked. */
    async clearSign(slug, x, y, z) {
      const w = await must(slug);
      const size = await sizeFor(slug, w), state = await stateOf(slug, w, size);
      const i = inSize(size, x, y, z) ? cellIndex(size, x, y, z) : -1;
      const sign = i >= 0 && state.signs.get(i);
      if (!sign) throw new Error(`no sign at ${x} ${y} ${z} in ${slug}`);
      const t = now();
      const r = await store.append(slug, [{u: `op.${t.toString(36)}`, x, y, z, v: state.cells.get(i), text: '', face: sign[1]}], {after: w.seq, t, net: 'operator', force: true});
      return {seq: r.rows[0].seq, u: r.rows[0].u, was: sign[0]};
    },
    /** Everything about a world as JSON: its row, snapshots, every edit, and the current cells and signs. */
    async export(slug) {
      const w = await must(slug);
      const size = await sizeFor(slug, w), state = await stateOf(slug, w, size);
      const edits = [];
      for (let from = 0; ;) { const rows = await store.edits(slug, from, 5000, w.seq); edits.push(...rows.map(r => ({...r}))); if (rows.length < 5000) break; from = rows[rows.length - 1].seq; }
      return {v: 1, slug, exported: now(), world: w, size, snapshots: await store.snapshots(slug), edits,
        cells: [...state.cells.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => [...cellXYZ(size, i), v]), signs: signList(state)};
    },
  };

  return {get, push, snapshot, maintain, admin, stats: () => ({...stats}), store, limits: L};
}

// ---------------- the in-memory store ----------------

/**
 * The store for one Node process (the local world server and the tests). Same contract as pgStore() in world-http.mjs:
 *   world(slug) → {slug, seq, snapSeq, snapKey, snapCells, snapAt, locked, resetSeq, versionId, created, updated} | null
 *   createWorld(slug, {versionId, t}) → that row (the existing one when it is already there)   setVersion(slug, id, t)
 *   lookup(slug, us) → Map u → {u, seq, text}
 *   append(slug, edits, {after, t, net, force}) → {seq, rows: [{u, seq, text}]} | {seq, reset} | {seq, locked}
 *       under the world's lock: refuses everything (reset) when the world was restored after `after`, or (locked) when
 *       it is locked, unless `force` (the operator). An edit whose u is already saved keeps its first seq.
 *   edits(slug, after, limit, upTo) → [{seq, u, x, y, z, v, text, face, net, at}] with after < seq <= upTo, ascending
 *   snapshot(slug, seq) → {seq, key, cells, bytes, kind, at} | null      snapshots(slug) → those rows, ascending
 *   snapshotBytes(key) → Uint8Array | null    putSnapshot(slug, {seq, key, bytes, cells, kind, t})  (moves snap_* forward)
 *   reset(slug, build(nextSeq) → {key, bytes, cells}, t) → the reset's seq      setLocked(slug, on, t)
 *   hit(key, window, n) → the count after adding n     sweepHits(beforeWindow)     list()     counts(slug) → {edits, snapshots}
 * `persist` (lib/world-files.mjs) is told about every change, after it is made; `load` is what it read back.
 */
export function memoryStore({load = null, persist = null} = {}) {
  const worlds = new Map(), edits = new Map(), byU = new Map(), snaps = new Map(), objects = new Map(), hits = new Map(), locks = new Map();
  const view = w => ({...w});
  const listOf = slug => { let l = edits.get(slug); if (!l) { edits.set(slug, l = []); byU.set(slug, new Map()); } return l; };
  for (const w of load?.worlds ?? []) worlds.set(w.slug, {...w});
  for (const r of load?.edits ?? []) { listOf(r.slug).push(r); byU.get(r.slug).set(r.u, r); }
  for (const l of edits.values()) l.sort((a, b) => a.seq - b.seq);
  for (const s of load?.snapshots ?? []) { if (!snaps.has(s.slug)) snaps.set(s.slug, new Map()); snaps.get(s.slug).set(s.seq, {...s}); }
  for (const [key, bytes] of load?.objects ?? []) objects.set(key, bytes);
  const snapAt = (slug, seq) => snaps.get(slug)?.get(seq)?.at ?? null;
  const exclusive = (slug, fn) => {
    const prev = locks.get(slug) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(slug, run.catch(() => {}));
    return run;
  };
  const firstAfter = (list, after) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].seq <= after) lo = mid + 1; else hi = mid; } return lo; };
  const touched = w => persist?.world?.(view(w));
  const putObject = (key, bytes) => { objects.set(key, bytes.slice()); persist?.object?.(key, bytes); };
  const addSnap = (slug, row) => { if (!snaps.has(slug)) snaps.set(slug, new Map()); if (snaps.get(slug).has(row.seq)) return false; snaps.get(slug).set(row.seq, row); persist?.snapshot?.(slug, {...row}); return true; };
  return {
    kind: 'memory',
    async world(slug) { const w = worlds.get(slug); return w ? {...view(w), snapAt: snapAt(slug, w.snapSeq)} : null; },
    async createWorld(slug, {versionId = null, t}) {
      if (!worlds.has(slug)) { const w = {slug, seq: 0, snapSeq: 0, snapKey: null, snapCells: 0, locked: false, resetSeq: 0, versionId, created: t, updated: t}; worlds.set(slug, w); touched(w); }
      return this.world(slug);
    },
    async setVersion(slug, versionId, t) { const w = worlds.get(slug); if (w) { w.versionId = versionId; w.updated = t; touched(w); } },
    async lookup(slug, us) { const m = byU.get(slug), out = new Map(); for (const u of us) { const r = m?.get(u); if (r) out.set(u, {u, seq: r.seq, text: r.text}); } return out; },
    append(slug, list, {after, t, net, force = false}) {
      return exclusive(slug, async () => {
        const w = worlds.get(slug);
        if (!w) throw new Error(`no world ${slug}`);
        if (!force && w.resetSeq > after) return {seq: w.seq, reset: w.resetSeq};
        if (!force && w.locked) return {seq: w.seq, locked: true};
        const all = listOf(slug), m = byU.get(slug), rows = [], added = [];
        for (const e of list) {
          const had = m.get(e.u);
          if (had) { rows.push({u: e.u, seq: had.seq, text: had.text}); continue; }
          const r = {slug, seq: ++w.seq, u: e.u, x: e.x, y: e.y, z: e.z, v: e.v, text: e.text ?? null, face: e.face ?? null, net, at: t};
          all.push(r); m.set(r.u, r); added.push(r);
          rows.push({u: r.u, seq: r.seq, text: r.text});
        }
        if (added.length) { w.updated = t; persist?.edits?.(slug, added.map(r => ({...r}))); touched(w); }
        return {seq: w.seq, rows};
      });
    },
    async edits(slug, after, limit, upTo = Infinity) {
      const list = edits.get(slug) ?? [], out = [];
      for (let i = firstAfter(list, after); i < list.length && out.length < limit && list[i].seq <= upTo; i++) out.push({...list[i]});
      return out;
    },
    async snapshot(slug, seq) { const s = snaps.get(slug)?.get(seq); return s ? {...s} : null; },
    async snapshots(slug) { return [...(snaps.get(slug)?.values() ?? [])].sort((a, b) => a.seq - b.seq).map(s => ({...s})); },
    async snapshotBytes(key) { const b = objects.get(key); return b ? b.slice() : null; },
    async putSnapshot(slug, {seq, key, bytes, cells, kind, t}) {
      putObject(key, bytes);
      addSnap(slug, {slug, seq, key, cells, bytes: bytes.length, kind, at: t});
      const w = worlds.get(slug);
      if (w && seq > w.snapSeq) { Object.assign(w, {snapSeq: seq, snapKey: key, snapCells: cells, updated: t}); touched(w); }
    },
    reset(slug, build, t) {
      return exclusive(slug, async () => {
        const w = worlds.get(slug);
        if (!w) throw new Error(`no world ${slug}`);
        const seq = w.seq + 1, {key, bytes, cells} = await build(seq);
        putObject(key, bytes);
        addSnap(slug, {slug, seq, key, cells, bytes: bytes.length, kind: 'reset', at: t});
        Object.assign(w, {seq, snapSeq: seq, snapKey: key, snapCells: cells, resetSeq: seq, updated: t});
        touched(w);
        return seq;
      });
    },
    async setLocked(slug, on, t) { const w = worlds.get(slug); if (w) { w.locked = !!on; w.updated = t; touched(w); } },
    async hit(key, win, n = 1) { const k = `${key}|${win}`, c = (hits.get(k) ?? 0) + n; hits.set(k, c); return c; },
    async sweepHits(before) { for (const k of [...hits.keys()]) if (Number(k.slice(k.lastIndexOf('|') + 1)) < before) hits.delete(k); },
    async list() { return [...worlds.values()].sort((a, b) => b.updated - a.updated).map(w => ({...view(w), snapAt: snapAt(w.slug, w.snapSeq)})); },
    async counts(slug) { return {edits: edits.get(slug)?.length ?? 0, snapshots: snaps.get(slug)?.size ?? 0}; },
    size: () => ({worlds: worlds.size, edits: [...edits.values()].reduce((n, l) => n + l.length, 0), snapshots: [...snaps.values()].reduce((n, m) => n + m.size, 0), hits: hits.size}),
  };
}
