// gf-three net: the world store client (research/worlds/PLAN.md §4.3; the server is creator-studio/lib/world-core.mjs
// behind /world/v1 on the play host, or research/worlds/serve.mjs on this machine).
//
// A world is saved on the play host, never on a player's machine: every copy loads it from there (the newest snapshot,
// immutable and cached, plus the edits after it), and the room's host pushes the edits it accepted every couple of
// seconds and when its tab goes away (a keepalive request). The server numbers each edit and drops a repeated edit id
// `u`, so pushing the same edit twice is harmless (a new host after a handoff pushes whatever it is not sure of).
//
//   const store = createWorldStore({ slug });           // slug: the published game's (from /p/<slug>/), else null
//   store.mode            'server' (a published game's world) | 'local' (no slug, or the server has no world: nothing saved)
//   await store.load()    → { seq, cells: [[index, v], ...], signs: Map(index → {text, face}), edits: [[seq, u, x, y, z, v, text?, face?], ...] }
//   store.queue(edits)    host: edits to save ([u, x, y, z, v, text?, face?]); sent by flush()
//   await store.flush()   host: push what is queued → { ok, refused, others, reset }
//   await store.poll()    the edits after the last seq this copy has (anyone's, the operator's) → { edits, reset }
//   store.seq             the last world seq this copy has seen
//   store.unload()        on pagehide: whatever is queued goes out with keepalive
// Edits are PLAN §4.1: [u, x, y, z, v] or, for a sign, [u, x, y, z, v, text, face]; v = block | tint << 8.

export const WORLD_API = '/world/v1/';
const MAX_PUSH = 500;

/** The published game's slug from the page's path (/p/<slug>/...), or null. */
export function slugOfPath(path = globalThis.location?.pathname ?? '') {
  const m = /\/p\/([a-z0-9][a-z0-9-]{1,47})\//.exec(path);
  return m ? m[1] : null;
}

/** Decode a world snapshot (PLAN §4.3; creator-studio/lib/world-core.mjs encodes it): gzip of
 *  "GFW1" | u32 seq | u16 sx sy sz | u32 count | count × (varint delta, varint v) | u32 signBytes | JSON [[index, text, face]...] */
export async function decodeSnapshot(buf, { gunzip = true } = {}) {
  let bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (gunzip) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'GFW1') throw new Error('gf-three world: not a world snapshot');
  let o = 4;
  const seq = dv.getUint32(o, true); o += 4;
  const size = [dv.getUint16(o, true), dv.getUint16(o + 2, true), dv.getUint16(o + 4, true)]; o += 6;
  const count = dv.getUint32(o, true); o += 4;
  const varint = () => { let v = 0, s = 0, b; do { b = bytes[o++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return v; };
  const cells = new Array(count);
  let index = 0;
  for (let k = 0; k < count; k++) { index += varint(); cells[k] = [index, varint()]; }
  const n = dv.getUint32(o, true); o += 4;
  const signs = new Map();
  for (const [i, text, face] of JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + n)) || '[]')) signs.set(i, { text, face });
  return { seq, size, cells, signs };
}

export function createWorldStore({ slug = slugOfPath(), fetchFn = globalThis.fetch?.bind(globalThis), base = WORLD_API } = {}) {
  let mode = slug && fetchFn ? 'server' : 'local';
  let seq = 0, config = null, locked = false;
  const queued = [];
  let inFlight = null;
  const url = (q = '') => `${base}${slug}${q}`;
  const stats = { loads: 0, pushes: 0, pushed: 0, refused: 0, polls: 0, errors: 0, lastError: null, lastPushAt: 0, resets: 0 };

  async function getJson(u) {
    const r = await fetchFn(u, { cache: 'no-store', credentials: 'omit' });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) throw new Error(`world ${r.status}`);
    return { status: r.status, body: await r.json() };
  }

  /** The whole saved world: the snapshot's cells and signs, then every edit after it (paged). */
  async function load() {
    stats.loads++;
    if (mode !== 'server') return { seq: 0, cells: [], signs: new Map(), edits: [], mode };
    let res;
    try { res = await getJson(url()); }
    catch (e) { stats.errors++; stats.lastError = String(e.message ?? e); throw e; }
    if (res.status === 404) { mode = 'local'; return { seq: 0, cells: [], signs: new Map(), edits: [], mode, missing: true }; }
    const w = res.body;
    config = w.config ?? null; locked = !!w.locked;
    let cells = [], signs = new Map();
    if (w.snap?.url) {
      const r = await fetchFn(w.snap.url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`world snapshot ${r.status}`);
      ({ cells, signs } = await decodeSnapshot(await r.arrayBuffer()));
    }
    const edits = [...(w.edits ?? [])];
    let last = edits.length ? edits[edits.length - 1][0] : (w.snap?.seq ?? 0), more = !!w.more;
    while (more) {
      const p = await getJson(url(`?after=${last}`));
      const list = p.body?.edits ?? [];
      edits.push(...list);
      if (list.length) last = list[list.length - 1][0];
      more = !!p.body?.more && list.length > 0;
    }
    seq = Math.max(w.seq ?? 0, last);
    return { seq, cells, signs, edits, mode, locked, config };
  }

  function queue(list) { for (const e of list) queued.push(e); }

  /** Push what is queued (at most 500 per request; the rest goes in the next). Edits a failed push carried go back on. */
  async function flush() {
    if (mode !== 'server' || !queued.length || inFlight) return null;
    const batch = queued.splice(0, MAX_PUSH);
    inFlight = (async () => {
      try {
        const r = await fetchFn(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ op: 'push', after: seq, edits: batch }) });
        if (r.status === 429 || r.status >= 500) { queued.unshift(...batch); stats.errors++; stats.lastError = `push ${r.status}`; return { retry: true }; }
        if (!r.ok) { stats.errors++; stats.lastError = `push ${r.status}`; if (r.status === 423) locked = true; return { failed: r.status, refused: batch.map(e => [e[0], r.status === 423 ? 'locked' : 'bad']) }; }
        const b = await r.json();
        stats.pushes++; stats.pushed += b.ok?.length ?? 0; stats.refused += b.refused?.length ?? 0; stats.lastPushAt = Date.now();
        if (b.reset) { stats.resets++; return { reset: b.reset, ok: b.ok ?? [], refused: b.refused ?? [], others: [] }; }
        const others = b.edits ?? [];
        seq = Math.max(seq, b.seq ?? 0, ...((b.ok ?? []).map(o => o[1] ?? 0)), ...others.map(e => e[0]));
        return { ok: b.ok ?? [], refused: b.refused ?? [], others };
      } catch (e) {
        queued.unshift(...batch); stats.errors++; stats.lastError = String(e.message ?? e);
        return { retry: true };
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  /** The edits after the last seq this copy has: what other writers (the operator, an earlier host's late push) saved. */
  async function poll() {
    if (mode !== 'server') return { edits: [] };
    stats.polls++;
    try {
      const r = await getJson(url(`?after=${seq}`));
      if (r.status === 404) return { edits: [] };
      const b = r.body;
      if (b.reset || b.gap) { stats.resets++; return { reset: b.reset ?? { seq: b.seq }, edits: [] }; }
      const edits = b.edits ?? [];
      if (edits.length) seq = Math.max(seq, edits[edits.length - 1][0]);
      seq = Math.max(seq, b.seq ?? 0);
      return { edits };
    } catch (e) { stats.errors++; stats.lastError = String(e.message ?? e); return { edits: [] }; }
  }

  /** The tab is going away: send what is queued with keepalive (a browser allows about 64 KB of it in flight). */
  function unload() {
    if (mode !== 'server' || !queued.length) return false;
    const batch = queued.splice(0, 300);
    try {
      fetchFn(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', keepalive: true, body: JSON.stringify({ op: 'push', after: seq, edits: batch }) }).catch(() => {});
      return true;
    } catch { return false; }
  }

  return {
    get mode() { return mode; }, get slug() { return slug; }, get seq() { return seq; }, set seq(v) { if (Number.isFinite(v)) seq = Math.max(seq, v); },
    get config() { return config; }, get locked() { return locked; }, get queued() { return queued.length; }, get busy() { return !!inFlight; },
    stats, load, queue, flush, poll, unload,
  };
}
