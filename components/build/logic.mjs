// mechanic: build. The pure part: edits, the checks every copy and the host make, the rate limit, the host's log of
// the room's edits and what has been saved, the crater a boom block leaves. No three.js, no DOM (Node tests import it:
// research/gf-three/tests/w-build.test.mjs).
//
// An edit is the world store's (research/worlds/PLAN.md §4.1): [u, x, y, z, v] or [u, x, y, z, v, text, face],
// v = block | tint << 8. `u` is the author copy's cid, a dot and a counter, so the server and every copy can tell an
// edit they already have.

export const MAX_TEXT = 60, MAX_LINES = 3;

/** A new edit id: cid + '.' + a counter in base 36 (at most 24 characters, PLAN §4.1). */
export function editId(cid, n) { return `${String(cid).slice(0, 12)}.${n.toString(36)}`; }
export const isEdit = e => Array.isArray(e) && typeof e[0] === 'string' && e[0].length <= 24 && [1, 2, 3, 4].every(i => Number.isInteger(e[i]));

/** Clean a sign's words for display and saving: at most 3 lines and 60 characters, no control characters. The word
 *  filter (kit/net/world-text.js, the play host's own) runs after this. */
export function tidyText(t) {
  const s = String(t ?? '').normalize('NFKC').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ');
  const lines = s.split('\n').map(l => l.trim()).slice(0, MAX_LINES);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  let out = lines.join('\n');
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT).trimEnd();
  return out;
}

/**
 * Can this edit be made? The same checks on the author's copy (to say no at once) and on the host's (the one that
 * counts). world: {size, floor, protect, table (blocks.mjs), signN, get(x, y, z)}. → null when fine, else a reason:
 * 'bounds' | 'floor' | 'protected' | 'block' | 'tint' | 'unbreakable' | 'same' | 'text' | 'face' | 'occupied'.
 */
export function check(world, e, { occupied = null } = {}) {
  if (!isEdit(e)) return 'bad';
  const [, x, y, z, v] = e;
  const [sx, sy, sz] = world.size;
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 'bounds';
  if (y < (world.floor ?? 1)) return 'floor';
  if ((world.protect ?? []).some(b => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2])) return 'protected';
  const block = v & 255, tint = v >> 8;
  const T = world.table;
  if (block > T.list.length) return 'block';
  if (tint > (T.paint?.length ?? 0)) return 'tint';
  const was = world.get(x, y, z), wasBlock = was & 255;
  if (block) {
    const b = T.list[block - 1], wb = wasBlock ? T.list[wasBlock - 1] : null;
    // placing on air (or over a plant), painting what is there, or writing on a sign that is there
    const fresh = !wasBlock || (wb.kind === 'plant' && wasBlock !== block);
    if (!fresh && wasBlock !== block) return 'same';          // a cell holds one block: break it first
    if (fresh && !b.place) return 'block';                    // natural blocks (bedrock) are never placed
    if (!fresh && block !== world.signN) {
      if (v === was) return 'same';
      if (!paintable(b)) return 'tint';
    }
    if (block === world.signN) {
      if (typeof e[5] !== 'string') return 'text';
      if (![0, 1, 4, 5].includes(e[6])) return 'face';
    }
    if (fresh && occupied?.(x, y, z) && b.solid) return 'occupied';
  } else {
    if (!wasBlock) return 'same';
    if (!T.list[wasBlock - 1].break) return 'unbreakable';
  }
  return null;
}
export const paintable = b => !!b && ['solid', 'cutout', 'glass', 'glow'].includes(b.kind) && !b.boom;

/** A token bucket per player: `rate` a second, up to `burst` at once. take(id, now) → true when allowed. */
export function createLimiter({ rate = 8, burst = 20 } = {}) {
  const b = new Map();
  return {
    take(id, now, n = 1) {
      const s = b.get(id) ?? { t: now, tokens: burst };
      s.tokens = Math.min(burst, s.tokens + (now - s.t) * rate); s.t = now;
      b.set(id, s);
      if (s.tokens < n) return false;
      s.tokens -= n; return true;
    },
    forget(id) { b.delete(id); },
  };
}

/**
 * The host's log of the room's accepted edits: each entry {r (the room's order, 1, 2, ...), e (the edit), g (the
 * world seq the store gave it, or null until saved)}. seen(u) answers whether an edit id was already taken (so a
 * guest's tail after a handoff, or a push repeated, is never taken twice).
 */
export function createRoomLog({ keepSeen = 60000 } = {}) {
  const entries = [];
  const byU = new Map();
  let savedThrough = 0;      // every entry with r <= savedThrough has its g
  return {
    get entries() { return entries; },
    get length() { return entries.length; },
    get savedThrough() { return savedThrough; },
    seen: u => byU.has(u),
    /** The entry of edit u ({r, e, g}), or null. */
    get: u => byU.get(u) ?? null,
    add(e) { const r = entries.length + 1, x = { r, e, g: null }; entries.push(x); byU.set(e[0], x); if (byU.size > keepSeen) byU.delete(byU.keys().next().value); return x; },
    /** The store saved edit u as world seq g. */
    saved(u, g) { const x = byU.get(u); if (x && x.g === null) x.g = g; while (savedThrough < entries.length && entries[savedThrough].g !== null) savedThrough++; },
    /** Edits not saved yet, in order. */
    unsaved: () => entries.slice(savedThrough).filter(x => x.g === null).map(x => x.e),
    /** What a copy that has the world up to seq g lacks: {base, list}. Entries saved at or below g are already in its
     *  world; they lead the log (saves go in order), so `base` is the last of them and `list` every entry after it. */
    since(g) {
      let base = 0;
      for (const x of entries) { if (x.g !== null && x.g <= g) base = x.r; else break; }
      return { base, list: entries.slice(base) };
    },
    reset() { entries.length = 0; byU.clear(); savedThrough = 0; },
  };
}

/**
 * A copy's view of the room's order: the room entries it has applied, in order (entries can arrive out of order
 * across a bulk catch-up and live edits). ingest([[r, ...edit]]) → the entries that follow on from `applied`, in order.
 */
export function createFeed() {
  let applied = 0;
  const waiting = new Map();
  return {
    get applied() { return applied; },
    ingest(list) {
      for (const x of list) if (Array.isArray(x) && Number.isInteger(x[0]) && x[0] > applied) waiting.set(x[0], x);
      const out = [];
      while (waiting.has(applied + 1)) { out.push(waiting.get(applied + 1)); waiting.delete(applied + 1); applied++; }
      return out;
    },
    /** The room's entries up to k are already in this copy's world (its load from the play host had them): carry on
     *  after k. → the waiting entries that now follow on, in order. */
    skipTo(k) {
      if (Number.isInteger(k) && k > applied) applied = k;
      for (const key of [...waiting.keys()]) if (key <= applied) waiting.delete(key);
      const out = [];
      while (waiting.has(applied + 1)) { out.push(waiting.get(applied + 1)); waiting.delete(applied + 1); applied++; }
      return out;
    },
    get gap() { return waiting.size > 0; },
    reset() { applied = 0; waiting.clear(); },
  };
}

/**
 * The cells a boom at (x, y, z) clears: inside radius r (a ball, slightly ragged), never the floor, a protected box or
 * an unbreakable block. → [[x, y, z], ...] nearest first, at most `max`.
 */
export function craterCells(world, at, r = 2.6, { max = 140, rnd = Math.random } = {}) {
  const out = [];
  const R = Math.ceil(r);
  const [cx, cy, cz] = at;
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
    const d = Math.hypot(dx, dy * 1.15, dz);
    if (d > r + (rnd() - 0.5) * 0.7) continue;
    const x = cx + dx, y = cy + dy, z = cz + dz;
    const v = world.get(x, y, z), b = v & 255;
    if (!b) continue;
    const e = ['', x, y, z, 0];
    if (check(world, e)) continue;
    out.push([x, y, z, d]);
  }
  out.sort((a, b) => a[3] - b[3]);
  return out.slice(0, max).map(c => c.slice(0, 3));
}

/** The horizontal face (0, 1, 4, 5: −x, +x, −z, +z) that points from a cell toward a point (the player). */
export function faceToward(cell, p) {
  const dx = p.x - (cell[0] + 0.5), dz = p.z - (cell[2] + 0.5);
  return Math.abs(dx) > Math.abs(dz) ? (dx < 0 ? 0 : 1) : (dz < 0 ? 4 : 5);
}
