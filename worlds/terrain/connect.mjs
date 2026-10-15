// gf-three smooth terrain: the connectors (the gameplay layer, 2026-10-14; the rule is worlds/connect.mjs). After the
// land is made (and a composed level's landmarks, bridges and seats), every region of ground worth going to that the
// seats cannot get to is joined to them, in the ground's own distance field, so the connector is standable, stops shots,
// is carved by blasts like the rest and travels to every copy with nothing new on the network:
//
//   bridge     the level's bridge model (a composed level's compose.bridges: compose.mjs spanBridge, made ground as its
//              bridges are), else a land bridge of the ground itself: a deck of earth arched over the gap, grass on top
//              and the cliff's strata under it, as the land's own arches look
//   shallows   a sandbar from shore to shore just over the sea (the material paints ground near the sea as sand)
//   ramp       a slope cut into the cliff and built out from its foot, as wide as two players, its sides blended in
//   pad        a level disc at each end; worlds/pads.js stands a launch pad on each that throws a body to the other
//
//   connectTerrain(field, P, opts) → {connectors, kept, left, small, reached(x, y, z), report}
//     opts: {pieces, own, landmarks (composed), seats ([{x, y, z}]; none: the biggest ground), numbers (movement),
//            reach (config/world.json reach), seaLevel, levelDisc, owner (the last piece owner used)}
//
// The regions come from the walk grid (worlds/walk.mjs) over this field (fieldSource): the same model the game's
// placement reads from the colliders built on the same mesh, so a region joined here is reached there. Deterministic:
// + - * / and sqrt on Float32 storage, angles through tables rounded to a millionth (every copy plans the same).
import { createWalk } from '../walk.mjs';
import { reachConfig, connectRegions, arcClearOf, KINDS } from '../connect.mjs';
import { BAND } from './field.mjs';
import { spanBridge, pieceGround } from './compose.mjs';

const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * A walk grid source over a distance field: in each column the surfaces facing up (where the field turns from air above
 * to ground below), how level each is, and whether a body fits on it (the field over it, a body's height, at least its
 * radius from any ground). seats and links are arrays the caller may change (the grid is read again when told).
 */
export function fieldSource(field, { numbers = {}, seaLevel = 0, seats = [], links = [] } = {}) {
  const n = { step: 0.45, body: 1.6, radius: 0.3, ...numbers };
  const { nx, ny, nz, d } = field, h = field.cell, O = field.origin, b = field.bounds;
  const vals = new Float32Array(ny), row = nx * nz;
  // the body's room over a surface, as the colliders' cylinder test reads it (a ceiling about 1.56 m over the feet)
  const clearAt = [n.step + n.radius, (n.step + n.body) / 2, n.body - n.radius];
  const surfaces = (x, z) => {
    const fx = (x - O[0]) / h, fz = (z - O[2]) / h;
    if (!(fx >= 0 && fz >= 0 && fx <= nx - 1 && fz <= nz - 1)) return [];
    const i = Math.min(nx - 2, Math.floor(fx)), k = Math.min(nz - 2, Math.floor(fz)), u = fx - i, w = fz - k;
    for (let j = 0; j < ny; j++) {
      const a = j * row + k * nx + i;
      const c0 = d[a] + (d[a + 1] - d[a]) * u, c1 = d[a + nx] + (d[a + nx + 1] - d[a + nx]) * u;
      vals[j] = c0 + (c1 - c0) * w;
    }
    const at = y => { const f = (y - O[1]) / h; if (f >= ny - 1) return BAND; if (f <= 0) return vals[0]; const j = Math.floor(f), t = f - j; return vals[j] + (vals[j + 1] - vals[j]) * t; };
    const out = [];
    for (let j = ny - 2; j >= 0 && out.length < 6; j--) {
      const lo = vals[j], hi = vals[j + 1];
      if (!(lo < 0 && hi >= 0)) continue;
      const y = O[1] + (j + lo / (lo - hi)) * h;
      const ny_ = field.normal(x, y, z)[1];
      const fits = clearAt.every(q => at(y + q) > n.radius * 0.6);
      out.push(fits ? { y, ny: ny_, fits } : { y, ny: ny_, fits, block: y + n.body + 0.3 });
    }
    return out;
  };
  return {
    area: () => [b.min[0] + h, b.min[2] + h, b.max[0] - h, b.max[2] - h],
    surfaces, water: () => seaLevel, seats: () => seats, links: () => links, numbers: n,
    open: (x, y, z) => field.sample(x, y, z) > 0.15,
    roof: (x, y, z) => { for (let h = 0.6; h <= 12; h += 0.5) if (field.sample(x, y + h, z) < 0) return true; return false; },
  };
}

/** Straight-line helpers in the plane: along (0 … len) and across (signed) a segment from a to b. */
function frame(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.sqrt(dx * dx + dz * dz) || 1e-6, ux = dx / len, uz = dz / len;
  return { len, ux, uz, along: (x, z) => (x - a.x) * ux + (z - a.z) * uz, across: (x, z) => -(x - a.x) * uz + (z - a.z) * ux };
}

/**
 * Lay a strip of ground along a → b in the field: inside `width` the ground's top becomes `top(t)` (t: 0 at a, 1 at b),
 * blended into what is there over `blend` m at the sides and ends; `fill` builds under it, `cut` clears air over it
 * (both: a ramp cut into a cliff and built out from its foot), `under(t)` (metres) leaves the strip that thick and
 * air below (a bridge's deck over a gap). Never touches a piece's samples (own). → the changed box [x0, z0, x1, z1]
 */
export function layStrip(field, a, b, { width = 3, blend = 1.5, top, fill = true, cut = true, under = null, own = null, ends = 1.2 }) {
  const { nx, ny, nz, d } = field, h = field.cell, O = field.origin, F = frame(a, b), half = width / 2, reach = half + blend;
  const ys = [top(0), top(0.5), top(1)], ylo = Math.min(...ys) - (under ? 12 : 8), yhi = Math.max(...ys) + 6;
  const x0 = Math.min(a.x, b.x) - reach - ends, x1 = Math.max(a.x, b.x) + reach + ends, z0 = Math.min(a.z, b.z) - reach - ends, z1 = Math.max(a.z, b.z) + reach + ends;
  const i0 = Math.max(1, Math.floor((x0 - O[0]) / h)), i1 = Math.min(nx - 2, Math.ceil((x1 - O[0]) / h));
  const k0 = Math.max(1, Math.floor((z0 - O[2]) / h)), k1 = Math.min(nz - 2, Math.ceil((z1 - O[2]) / h));
  const j0 = Math.max(1, Math.floor((ylo - O[1]) / h)), j1 = Math.min(ny - 2, Math.ceil((yhi - O[1]) / h));
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
    const x = O[0] + i * h, z = O[2] + k * h, s = F.along(x, z), q = Math.abs(F.across(x, z));
    if (q >= reach || s < -ends || s > F.len + ends) continue;
    const t = clamp(s / F.len, 0, 1);
    // the weight: 1 on the strip, falling to 0 over the blend at its sides and over `ends` past each end
    const side = q <= half ? 1 : 1 - (q - half) / blend, end = s < 0 ? 1 + s / ends : s > F.len ? 1 - (s - F.len) / ends : 1;
    const wgt = smooth(Math.min(side, end));
    if (wgt <= 0) continue;
    const yt = top(t), thick = under ? under(t) : null;
    for (let j = j0; j <= j1; j++) {
      const y = O[1] + j * h, a_ = (j * nz + k) * nx + i;
      if (own && own[a_]) continue;
      // the strip: the plane's distance above its top; with a thickness, ground only between the top and its underside
      let v = y - yt;
      if (thick != null) v = Math.max(v, (yt - thick) - y);
      v = clamp(v, -BAND, BAND);
      const cur = d[a_];
      if (v < cur ? !fill : !cut) continue;
      // a deck over a gap is ground added (never cuts the land it meets); a ramp is the plane both ways
      if (thick != null && v > cur) continue;
      d[a_] = Math.fround(cur + (v - cur) * wgt);
    }
  }
  return [x0, z0, x1, z1];
}

/** The pairs of rim places (seats' side a, region's side b) a connector of this kind spans, best first (at most 24, apart). */
function pairsFor(kind, region, seatsRim, { sea = 0, limits }) {
  const A = seatsRim ?? [], B = region.rim ?? [], all = [];
  for (const p of A) for (const q of B) {
    const dx = q[0] - p[0], dz = q[2] - p[2], dd = Math.sqrt(dx * dx + dz * dz), dy = q[1] - p[1];
    let c;
    if (kind === 'bridge') { if (p[3] < 0.85 || q[3] < 0.85 || dd < 2 || dd > limits.bridgeMax || Math.abs(dy) > Math.max(2.5, dd * 0.3)) continue; c = dd + Math.abs(dy) * 2; }
    else if (kind === 'shallows') { if (p[1] - sea > limits.sandbarHigh || q[1] - sea > limits.sandbarHigh || p[3] < 0.7 || q[3] < 0.7) continue; c = dd + Math.abs(dy); }
    else if (kind === 'ramp') { if (dd > limits.rampAcross || Math.abs(dy) > limits.rampRise) continue; c = dd + Math.abs(dy) * 0.5; }
    else if (kind === 'pad') { if (p[3] < 0.9 || q[3] < 0.9 || dd > limits.padMax || dy > limits.padRise) continue; c = dd + Math.max(0, dy) * 1.5; }
    else continue;
    all.push({ c, a: { x: p[0], y: p[1], z: p[2] }, b: { x: q[0], y: q[1], z: q[2] }, d: dd });
  }
  // the best first, each at least 3 m from those kept before it (another try is another place, not the same one moved)
  const out = [];
  for (const c of all.sort((u, v) => u.c - v.c)) {
    if (out.length >= 24) break;
    const mx = (c.a.x + c.b.x) / 2, mz = (c.a.z + c.b.z) / 2;
    if (out.every(o => { const dx = (o.a.x + o.b.x) / 2 - mx, dz = (o.a.z + o.b.z) / 2 - mz; return dx * dx + dz * dz >= 9; })) out.push(c);
  }
  return out;
}

/**
 * An earthen approach onto a deck from its end E ({x, y, z}: the rim it stands on), u the way into the deck: where the
 * deck's walking top two metres in stands higher than a step over the rim, a slope of fill rises to it (about 23°).
 */
function approach(field, E, u, own) {
  const into = 2;
  let hd = -Infinity;
  for (const q of [1.6, 2, 2.4]) { const y = field.heightAt(E.x + u.x * q, E.z + u.z * q, E.y + 5); if (y != null) hd = Math.max(hd, y); }
  const rise = hd - E.y;
  if (!(rise > 0.35) || rise > 3.5) return null;
  const len = rise / 0.42 + 1;
  const a = { x: E.x - u.x * len, z: E.z - u.z * len }, b = { x: E.x + u.x * into, z: E.z + u.z * into };
  return layStrip(field, a, b, { width: 2.6, blend: 1.4, top: t => E.y + (hd - 0.02 - E.y) * t, cut: false, own, ends: 0.6 });
}

/** Is the straight way from a to b at height y (+ a body) free of the field (no hill or wall in between)? */
function clearWay(field, a, b, y, body = 1.6) {
  const F = frame(a, b), steps = Math.max(2, Math.ceil(F.len / (field.cell * 1.5)));
  for (let s = 2; s < steps - 1; s++) { const t = s / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t; if (field.sample(x, y + body * 0.6, z) < 0.15) return false; }
  return true;
}

export function connectTerrain(field, P, opts = {}) {
  const { pieces = null, own = null, landmarks = [], numbers = {}, seaLevel = 0, levelDisc } = opts;
  const R = reachConfig(opts.reach ?? P.reach ?? {});
  const bridgeIds = (P.compose?.bridges ?? []).filter(id => pieces?.[id]?.tris?.length);
  const links = [], seats = [];
  let count = 0;
  let owner = opts.owner ?? landmarks.reduce((m, L) => Math.max(m, L.owner ?? 0), 0);
  const src = fieldSource(field, { numbers, seaLevel, seats, links });
  const walk = createWalk(src);
  const report = { notes: [] };
  // the seats: the first is the root; the others are things on the ground (a seat on ground of its own is a region
  // worth joining, unless the game keeps the seats apart)
  const given = (opts.seats ?? []).map(s => ({ x: s.x ?? s[0], y: s.y ?? s[1], z: s.z ?? s[2] }));
  const things = () => [
    ...given.slice(1).map((s, i) => ({ kind: 'seat', id: i + 2, x: s.x, y: s.y, z: s.z, r: 1 })),
    ...landmarks.filter(L => L.box && L.role === 'bridge').map(L => ({ kind: 'bridge', id: L.id, x: (L.box.min[0] + L.box.max[0]) / 2, y: L.box.min[1], z: (L.box.min[2] + L.box.max[2]) / 2, box: [L.box.min[0], L.box.min[1], L.box.min[2], L.box.max[0], L.box.max[1], L.box.max[2]] })),
    ...landmarks.filter(L => L.box && L.role !== 'bridge').map(L => ({ kind: 'landmark', id: L.id, x: (L.box.min[0] + L.box.max[0]) / 2, y: L.box.min[1] + 0.3, z: (L.box.min[2] + L.box.max[2]) / 2, r: Math.sqrt((L.box.max[0] - L.box.min[0]) ** 2 + (L.box.max[2] - L.box.min[2]) ** 2) / 2 + 1.5 })),
  ];
  if (given.length) seats.push(given[0]);
  else {
    // no seats given (they are chosen on the joined ground afterwards): the biggest ground is the root
    const all = walk.walk.regions();
    const big = all.regions[0];
    if (!big) return { connectors: [], kept: [], left: [], small: 0, reached: () => false, report: { ...report, notes: ['no ground'] }, links };
    seats.push({ x: big.start[0], y: big.start[1], z: big.start[2] });
    report.root = big.start;
    walk.walk.relink();
  }
  const changed = box => walk.walk.invalidate(box);
  // the composer's own bridges get the same earthen approaches (a deck that rises steeply from its feet is a wall to a
  // body walking up to it)
  if (R.connect) for (const m of landmarks) if (m.role === 'bridge' && m.ends?.length === 2) {
    const [A0, B0] = m.ends, F = frame({ x: A0[0], z: A0[2] }, { x: B0[0], z: B0[2] });
    approach(field, { x: A0[0], y: A0[1], z: A0[2] }, { x: F.ux, z: F.uz }, own);
    approach(field, { x: B0[0], y: B0[1], z: B0[2] }, { x: -F.ux, z: -F.uz }, own);
  }
  const levelOf = (p, r = 1.6) => { levelDisc(field, { x: p.x, y: p.y, z: p.z }, r, 1.6, own); changed([p.x - r - 2, p.z - r - 2, p.x + r + 2, p.z + r + 2]); };

  const build = (kind, region, A, attempt = 0) => {
    const limits = R;
    if (kind === 'bridge') {
      const pair = pairsFor('bridge', region, (region.trap ? A.seats.back : A.seats.rim), { sea: seaLevel, limits }).filter(p => clearWay(field, p.a, p.b, Math.max(p.a.y, p.b.y)))[attempt];
      if (!pair) return null;
      if (bridgeIds.length) {
        // the level's own bridge model, as the composer spans its bridges
        const id = bridgeIds[count % bridgeIds.length];
        const m = spanBridge(field, pair, pieces[id], { id: `${id}#c${++count}`, prop: id, own, levelDisc }), F = frame(pair.a, pair.b);
        if (m.note) { report.notes.push(m.note); return null; }
        pieceGround(field, m, ++owner, own);
        // a model's deck may rise steeply from its feet (an arched bridge's end steps): an earthen approach at each end
        // from the rim up onto the deck, built round the piece, never into it
        for (const [k, E] of m.ends.entries()) approach(field, { x: E[0], y: E[1], z: E[2] }, k ? { x: -F.ux, z: -F.uz } : { x: F.ux, z: F.uz }, own);
        changed([m.box.min[0] - 8, m.box.min[2] - 8, m.box.max[0] + 8, m.box.max[2] + 8]);
        landmarks.push(m);
        return { at: m.at, ends: m.ends, gap: m.gap, piece: id, landmark: m.id, box: m.box };
      }
      // a land bridge: an arched deck of the ground itself, its ends levelled on the rims
      const y0 = pair.a.y, y1 = pair.b.y, span = pair.d, rise = Math.min(1.2, span * 0.06);
      const ext = 1.6, F = frame(pair.a, pair.b);
      const a = { x: pair.a.x - F.ux * ext, z: pair.a.z - F.uz * ext }, b = { x: pair.b.x + F.ux * ext, z: pair.b.z + F.uz * ext };
      const top = t => y0 + (y1 - y0) * t + rise * 4 * t * (1 - t) - 0.05;
      const box = layStrip(field, a, b, { width: 3.4, blend: 0.9, top, under: t => 1.1 + 3.2 * (1 - 4 * t * (1 - t)) ** 2, own, ends: 0.8 });
      changed([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
      return { at: [r2((pair.a.x + pair.b.x) / 2), r2(top(0.5)), r2((pair.a.z + pair.b.z) / 2)], ends: [[r2(pair.a.x), r2(y0), r2(pair.a.z)], [r2(pair.b.x), r2(y1), r2(pair.b.z)]], gap: r2(span), box: { min: [box[0], Math.min(y0, y1) - 4, box[1]], max: [box[2], Math.max(y0, y1) + rise, box[3]] } };
    }
    if (kind === 'shallows') {
      const pair = pairsFor('shallows', region, (region.trap ? A.seats.back : A.seats.rim), { sea: seaLevel, limits }).filter(p => clearWay(field, p.a, p.b, seaLevel + 0.4))[attempt];
      if (!pair) return null;
      const F = frame(pair.a, pair.b), ext = 2;
      const a = { x: pair.a.x - F.ux * ext, z: pair.a.z - F.uz * ext }, b = { x: pair.b.x + F.ux * ext, z: pair.b.z + F.uz * ext };
      const low = seaLevel + 0.35, ya = pair.a.y - 0.05, yb = pair.b.y - 0.05;
      const top = t => Math.max(low, ya + (yb - ya) * t - 1.4 * 4 * t * (1 - t));
      const box = layStrip(field, a, b, { width: 4.2, blend: 2.6, top, cut: false, own, ends: 2 });
      changed([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
      return { at: [r2((pair.a.x + pair.b.x) / 2), r2(low), r2((pair.a.z + pair.b.z) / 2)], ends: [[r2(pair.a.x), r2(pair.a.y), r2(pair.a.z)], [r2(pair.b.x), r2(pair.b.y), r2(pair.b.z)]], gap: r2(pair.d), box: { min: [box[0], seaLevel - 2, box[1]], max: [box[2], Math.max(ya, yb), box[3]] } };
    }
    if (kind === 'ramp') {
      // the ways tried, in turn: straight from the seats' side at the region's (half built out from the cliff's foot,
      // half cut in); then along the cliff face either way (a path cut into the cliff's side, for a foot too narrow to
      // build out on); then the same for the next best pairs of rim places
      const mode = attempt % 3, which = Math.floor(attempt / 3);
      const alt = which ? pairsFor('ramp', region, (region.trap ? A.seats.back : A.seats.rim), { sea: seaLevel, limits })[which - 1] : null;
      const g = which ? (alt ? { from: [alt.a.x, alt.a.y, alt.a.z], to: [alt.b.x, alt.b.y, alt.b.z], across: alt.d } : null) : region.gap;
      if (!g) return null;
      // lo: the lower end, hi: the higher (a trap's way out climbs from the trap; a region up a cliff from the seats)
      let lo = { x: g.from[0], y: g.from[1], z: g.from[2] }, hi = { x: g.to[0], y: g.to[1], z: g.to[2] };
      if (lo.y > hi.y) [lo, hi] = [hi, lo];
      const rise = hi.y - lo.y;
      // the cliff's way: from the lower place at the higher one, or, where the two are one above the other, the face's own
      let ux = hi.x - lo.x, uz = hi.z - lo.z, l = Math.sqrt(ux * ux + uz * uz);
      if (l < 0.8) { const nrm = field.normal(lo.x, (lo.y + hi.y) / 2, lo.z); ux = -nrm[0]; uz = -nrm[2]; l = Math.sqrt(ux * ux + uz * uz); }
      if (l < 1e-3) return null;
      ux /= l; uz /= l;
      // no steeper than 26° (a walk the capsule takes with room to spare), and over the whole gap with a little to spare
      const run = Math.max(rise / 0.48 + 2, (g.across ?? 0) + 3);
      let a, b;
      if (mode === 0) { const mid = { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 }; a = { x: mid.x - ux * run / 2, z: mid.z - uz * run / 2 }; b = { x: mid.x + ux * run / 2, z: mid.z + uz * run / 2 }; }
      else {
        // along the face: its top end at the higher rim, the strip's middle on the rim's line (half cut into the high
        // ground, half built out over the low)
        if (rise < 1.2) return null;
        const s = mode === 1 ? 1 : -1, tx = -uz * s, tz = ux * s;
        b = { x: hi.x - ux * 0.4 + tx * 1.2, z: hi.z - uz * 0.4 + tz * 1.2 }; a = { x: b.x - tx * run, z: b.z - tz * run };
      }
      const ya = field.heightAt(a.x, a.z, lo.y + 1.5);
      if (ya == null || ya < seaLevel + 0.4 || Math.abs(ya - lo.y) > 2.5) { if (!attempt) report.notes.push(`no ground at a ramp's foot near (${r2(a.x)}, ${r2(a.z)})`); return { none: true }; }
      const yb = mode === 0 ? field.heightAt(b.x, b.z, hi.y + 1.5) : hi.y;
      if (yb == null || yb < seaLevel + 0.4 || Math.abs(yb - hi.y) > 2.5) return { none: true };
      const top = t => ya + (yb - ya) * t;
      const box = layStrip(field, a, b, { width: 2.8, blend: 1.4, top, own, ends: 1.4 });
      changed([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
      return { at: [r2((a.x + b.x) / 2), r2((ya + yb) / 2), r2((a.z + b.z) / 2)], ends: [[r2(a.x), r2(ya), r2(a.z)], [r2(b.x), r2(yb), r2(b.z)]], rise: r2(yb - ya), run: r2(run), along: mode !== 0, box: { min: [box[0], Math.min(ya, yb) - 1, box[1]], max: [box[2], Math.max(ya, yb) + 1, box[3]] } };
    }
    if (kind === 'fill') {
      // a cave nothing leads out of: the ground made solid over its floor, a body's height and more (hidden under the
      // land, so nothing a player sees changes but that its mouth is closed)
      if (attempt || !region.places?.length) return null;
      const { nx, ny, nz, d } = field, h = field.cell, O = field.origin, rad = 0.9;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, y, z] of region.places) {
        const i0 = Math.max(1, Math.floor((x - rad - O[0]) / h)), i1 = Math.min(nx - 2, Math.ceil((x + rad - O[0]) / h));
        const k0 = Math.max(1, Math.floor((z - rad - O[2]) / h)), k1 = Math.min(nz - 2, Math.ceil((z + rad - O[2]) / h));
        const j0 = Math.max(1, Math.floor((y - 0.6 - O[1]) / h)), j1 = Math.min(ny - 2, Math.ceil((y + 4.2 - O[1]) / h));
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const a = (j * nz + k) * nx + i; if (own && own[a]) continue;
          if (d[a] > -0.4) d[a] = Math.fround(-0.4);
        }
        x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
      }
      changed([x0 - 2, z0 - 2, x1 + 2, z1 + 2]);
      return { at: region.at, ends: [], filled: region.places.length, box: { min: [x0, region.y[0], z0], max: [x1, region.y[1] + 2.6, z1] } };
    }
    if (kind === 'pad') {
      // each pad a little way in from its rim, on ground level enough to stand a pad (the first pair that has both)
      // never on a landmark or a bridge (a pad sits on open ground of its own, clear of their footprints)
      const onPiece = p => landmarks.some(L => L.box && p.x > L.box.min[0] - 1.6 && p.x < L.box.max[0] + 1.6 && p.z > L.box.min[2] - 1.6 && p.z < L.box.max[2] + 1.6);
      const level = (p, y0) => { if (onPiece(p)) return null; const y = field.heightAt(p.x, p.z, y0 + 1.5); if (y == null || y < seaLevel + 0.6 || Math.abs(y - y0) > 1.2) return null; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = field.heightAt(p.x + dx, p.z + dz, y + 1.5); if (q == null || Math.abs(q - y) > 0.5) return null; } return r2(y); };
      let pa = null, pb = null, pair = null, skip = attempt;
      const solid = (x, y, z) => field.sample(x, y, z) < 0.7;
      for (const c of pairsFor('pad', region, (region.trap ? A.seats.back : A.seats.rim), { sea: seaLevel, limits })) {
        // across the gap, or, where its two sides are one above the other (a cliff), from the near side into the region
        const F = c.d >= 1.5 ? frame(c.a, c.b) : frame(c.a, { x: region.at[0], z: region.at[2] });
        for (const inset of [2.2, 3.2, 1.6, 1.1]) {
          const a = { x: r2(c.a.x - F.ux * inset), z: r2(c.a.z - F.uz * inset) }, b = { x: r2(c.b.x + F.ux * inset), z: r2(c.b.z + F.uz * inset) };
          a.y = level(a, c.a.y); b.y = level(b, c.b.y);
          // the throw's arc in the open air both ways (never through a landmark's wall or a hill)
          if (a.y != null && b.y != null && arcClearOf(a, b, solid) && arcClearOf(b, a, solid)) { if (skip-- > 0) break; pa = a; pb = b; pair = c; break; }
        }
        if (pair) break;
      }
      if (!pair) return null;
      levelOf(pa); levelOf(pb);
      links.push({ from: pa, to: pb }, { from: pb, to: pa });
      walk.walk.relink();
      return { at: [r2((pa.x + pb.x) / 2), r2(Math.max(pa.y, pb.y)), r2((pa.z + pb.z) / 2)], ends: [[pa.x, pa.y, pa.z], [pb.x, pb.y, pb.z]], gap: r2(pair.d), pads: [[pa.x, pa.y, pa.z], [pb.x, pb.y, pb.z]], box: { min: [Math.min(pa.x, pb.x) - 2, Math.min(pa.y, pb.y), Math.min(pa.z, pb.z) - 2], max: [Math.max(pa.x, pb.x) + 2, Math.max(pa.y, pb.y) + 1, Math.max(pa.z, pb.z) + 2] } };
    }
    return null;
  };

  // before each try: the ground, the piece mask, the links and the pieces as they are (a try that does not join the
  // region is taken away again)
  let mark = null;
  const world = {
    analyse: () => walk.walk.regions({ things: things(), rims: true }),
    build,
    joined: (r, kind) => kind === 'fill' ? !walk.isWalkable(r.start[0], r.start[2], r.start[1] + 0.1) : (walk.reach({ x: r.start[0], y: r.start[1] + 0.1, z: r.start[2] }, seats[0], { radius: 1.2 }).ok && (r.trap || walk.reach(0, { x: r.start[0], y: r.start[1], z: r.start[2] }, { radius: 0.8 }).ok)),
    mark: () => { mark = { d: field.d.slice(), own: own ? own.slice() : null, links: links.length, landmarks: landmarks.length, owner, count }; },
    undo: () => {
      if (!mark) return;
      field.d.set(mark.d); if (own) own.set(mark.own);
      links.length = mark.links; landmarks.length = mark.landmarks; owner = mark.owner; count = mark.count;
      walk.walk.invalidate(null); mark = null;
    },
  };
  // planned generously (two thirds of the size the gate holds a region to: the grid here is the field's, the gate's the
  // colliders', and a region near the line must not fall between them), judged strictly at play
  const res = connectRegions(world, { ...R, minArea: R.minArea * 0.66, minCore: R.minCore * 0.5, minCave: R.minCave * 0.5, can: [...KINDS, 'fill'], numbers: walk.numbers, sea: seaLevel });
  const final = res.analysis;
  report.regions = final.regions.length; report.seatsArea = final.seats.area; report.walk = walk.walk.stats();
  // where the seats get to now (seats chosen afterwards and set dressing stand only there)
  // (both ways: a place the seats drop to and cannot leave is no place for a seat or set dressing)
  const reached = (x, y, z) => walk.reach(0, { x, y, z }, { radius: 1.2 }).ok && walk.reach({ x, y: y + 0.1, z }, seats[0], { radius: 1.2 }).ok;
  report.tries = res.tries;
  return { connectors: res.made.map(({ box, ...c }) => ({ ...c, box })), kept: res.kept, left: res.left, small: res.small, reached, report, links, owner };
}
