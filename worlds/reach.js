// Reach in 3D, from the character's own movement numbers (open builder wave 10, track H; the places spike's reach.js,
// HANDOFF M4-H). Pure: no three.js, no DOM, no Rapier.
//
// The flat part already does this side-on (kit/flat/tilemap.js reachOf, proved by tools/flat-reach.mjs driving the real
// player). This is the same idea for a 3D world: the MODEL says which places a body can get to and by which jumps, over
// the colliders the world loaders build (colliders.js: one list); tools/places-reach.mjs proves the jumps the model
// needs with the kit's own capsule on the real Rapier. Check 17 reports what the model cannot reach (rule `reach`).
// Ideas from BuildersGate (MIT; src/bgate_core/level/jump.py, traversal.py; read, nothing ported): the level is checked
// against ONE jump, a number that lives with the character, not the level; the arc must be clear for the whole body,
// not only the landing; geometry explains, the driven body decides.
//
//   movementOf(game)                    config/game.json → the numbers (speed, jump, gravity, body, step, ...)
//   reachNumbers(numbers)               → the named quantities a recipe may size things by (jumpUp, jumpAcross, ...)
//   targetsOf(layout)                   → what a player must get to: every spawn, zone and entry (a scenic level's
//                                         spawns, arena and portal); a zone may say {optional: true}
//   reachOf(layout, colliders, numbers) → { ok, problems, found, jumps (the ones the route needs), numbers, stats }
//   refuse(layout, catalog, numbers)    throws a PlaceRefused (code 'unreachable') when a target cannot be reached
//
// The model: a 0.25 m grid of solid spans; a node is a top a body fits on (its height free above, nothing within its
// radius poking up past a step); walking joins neighbours up a step or down any drop; a jump joins a node to one a
// rise up to jumpUp and a gap up to across(rise) away, the whole body clear along the arc. It takes REACH_MARGIN (82%)
// of the jump the physics gives, as the flat part does. Not modelled: slopes (a ramp is walked by its height steps),
// jump pads, moving pieces, doors that open.
import { jumpReach, REACH_MARGIN } from '../flat/tilemap.js';
import { CAPSULE_DEFAULTS } from '../controller/capsule.mjs';
import { turn } from './layout.js';
import { collidersOf } from './colliders.js';

// The highest ledge the floating capsule walks onto without a jump, measured by tools/places-reach.mjs --calibrate
// (0.55 m, 2026-10-11): the model takes 82% of it, as it takes REACH_MARGIN of the jump.
export const STEP = 0.45;
export const MARGIN = REACH_MARGIN;
export const CELL = 0.25;

/** config/game.json (or nothing: the kit's defaults) → the movement numbers the model and the driver use. */
export function movementOf(game = {}) {
  const C = CAPSULE_DEFAULTS, c = game?.controller ?? {};
  const body = 2 * C.capsule.halfHeight + 2 * C.capsule.radius + C.capsule.floatHeight;
  return { speed: c.speed ?? C.move.runSpeed, jump: c.jump ?? C.jump.velocity, gravity: game?.gravity ?? 20, fallScale: C.jump.fallingGravityScale, radius: C.capsule.radius, body: +body.toFixed(3), step: STEP, slopeMaxDeg: C.move.slopeMaxDeg };
}
/** What a recipe may size things by: how high and how far a jump goes, with the margin taken off. */
export function reachNumbers(n) {
  const J = jumpReach({ gravity: n.gravity, jump: n.jump, fallScale: n.fallScale, speed: n.speed });
  return { jumpUp: +(J.up * MARGIN).toFixed(3), jumpAcross: +(J.across(0) * MARGIN).toFixed(3), step: n.step, body: n.body, radius: n.radius };
}

// ------------------------------------------------------------------------------------------------------- the grid
/** The (x, z) convex hull of a hull collider's points, counter-clockwise. */
function hull2(points) {
  const P = [];
  for (let i = 0; i < points.length; i += 3) P.push([points[i], points[i + 2]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...P].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}
const insideConvex = (poly, x, z) => poly.every((a, i) => { const b = poly[(i + 1) % poly.length]; return (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });

/** Solid spans per cell: for every cell of the area, the [bottom, top] intervals of what stands there, merged. */
function spansOf(colliders, area) {
  const [x0, z0, x1, z1] = area, nx = Math.ceil((x1 - x0) / CELL), nz = Math.ceil((z1 - z0) / CELL);
  const cells = Array.from({ length: nx * nz }, () => []);
  const cx = i => x0 + (i + 0.5) * CELL, cz = j => z0 + (j + 0.5) * CELL;
  const each = (bx0, bz0, bx1, bz1, f) => {
    const i0 = Math.max(0, Math.floor((bx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((bx1 - x0) / CELL));
    const j0 = Math.max(0, Math.floor((bz0 - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((bz1 - z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const s = f(cx(i), cz(j)); if (s) cells[j * nx + i].push(s); }
  };
  for (const c of colliders) {
    const [ax, ay, az] = c.position ?? [0, 0, 0];
    if (c.shape === 'hull') {
      const poly = hull2(c.points), ys = c.points.filter((_, k) => k % 3 === 1), lo = Math.min(...ys), top = Math.max(...ys);
      each(Math.min(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1])), Math.max(...poly.map(p => p[0])), Math.max(...poly.map(p => p[1])), (x, z) => (insideConvex(poly, x, z) ? [lo, top] : null));
    } else if (c.shape === 'box' || c.shape === 'ramp') {
      const [w, h, d] = c.size, r = Math.hypot(w, d) / 2;
      each(ax - r, az - r, ax + r, az + r, (x, z) => {
        const [lx, lz] = turn(x - ax, z - az, -(c.rotationY ?? 0));
        if (Math.abs(lx) > w / 2 || Math.abs(lz) > d / 2) return null;
        if (c.shape === 'box') return [ay - h / 2, ay + h / 2];
        return [ay - h / 2, ay - h / 2 + ((d / 2 - lz) / d) * h];   // a wedge rising toward -z
      });
    } else if (c.shape === 'cylinder' || c.shape === 'sphere') {
      const r = c.radius, h = c.shape === 'sphere' ? 2 * r : c.height;
      each(ax - r, az - r, ax + r, az + r, (x, z) => (Math.hypot(x - ax, z - az) <= r ? [ay - h / 2, ay + h / 2] : null));
    }
  }
  for (const list of cells) {
    list.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < list.length - 1;) { if (list[k + 1][0] <= list[k][1] + 0.05) { list[k][1] = Math.max(list[k][1], list[k + 1][1]); list.splice(k + 1, 1); } else k++; }
  }
  return { cells, nx, nz, x0, z0, cx, cz, at: (x, z) => { const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; } };
}

/** The play area a layout's reach is judged over: the rectangle (party) or each island's box (scenic), with a margin. */
function areaOf(layout) {
  if (Array.isArray(layout.levels)) {
    let a = [Infinity, Infinity, -Infinity, -Infinity];
    for (const L of layout.levels) {
      const b = L.box ?? (() => { const r = L.radius * 1.3 + 1; return [L.at[0] - r, L.at[2] - r, L.at[0] + r, L.at[2] + r]; })();
      a = [Math.min(a[0], b[0] - 1), Math.min(a[1], b[1] - 1), Math.max(a[2], b[2] + 1), Math.max(a[3], b[3] + 1)];
    }
    return a;
  }
  const [W, D] = layout.size ?? [24, 24];
  return [-W / 2 - 0.5, -D / 2 - 0.5, W / 2 + 0.5, D / 2 + 0.5];
}

// ------------------------------------------------------------------------------------------------------- targets
/** What a player must be able to get to, read from the layout itself (no new field). */
export function targetsOf(layout) {
  const out = [], spawn = (p, name, first) => out.push({ name, kind: 'spawn', first, at: p, test: (x, y, z) => Math.hypot(x - p[0], z - p[2]) <= 0.4 && Math.abs(y - (p[1] ?? 0)) <= 0.6 });
  const zone = (z, name) => {
    if (z.optional) return;
    if ((z.shape ?? 'circle') === 'circle') { const r = z.size[0]; out.push({ name, kind: 'zone', at: z.at, test: (x, y, zz) => Math.hypot(x - z.at[0], zz - z.at[2]) <= r && Math.abs(y - z.at[1]) <= 1.0 }); }
    else { const [w, h, d] = z.size; out.push({ name, kind: 'zone', at: z.at, test: (x, y, zz) => Math.abs(x - z.at[0]) <= w / 2 && Math.abs(zz - z.at[2]) <= d / 2 && y >= z.at[1] - h / 2 - 0.2 && y <= z.at[1] + h / 2 }); }
  };
  if (Array.isArray(layout.levels)) {
    for (const L of layout.levels) {
      (L.spawns ?? []).forEach((p, i) => spawn(p, `${L.id} spawn ${i + 1}`, i === 0));   // a portal carries players: each level starts at its own first spawn
      for (const n of ['arena', 'portal']) if (L.zones?.[n]) zone(L.zones[n], `${L.id} ${n}`);
    }
    return out;
  }
  (layout.spawns ?? []).forEach((p, i) => spawn(p, `spawn ${i + 1}`, i === 0));
  for (const [n, z] of Object.entries(layout.zones ?? {})) zone(z, `zone ${n}`);
  for (const e of layout.entries ?? []) { const p = [e.at[0] - e.normal[0] * 1.2, 0, e.at[2] - e.normal[1] * 1.2]; out.push({ name: `entry ${e.name}`, kind: 'entry', at: p, test: (x, y, z) => Math.hypot(x - p[0], z - p[2]) <= 1.0 && Math.abs(y) <= 0.6 }); }
  return out;
}

// ------------------------------------------------------------------------------------------------------- reach
/** The model. → { ok, problems: [{code, target, kind, at, from?, to?, rise?, gap?, message}], found, jumps, numbers, stats } */
export function reachOf(layout, colliders, numbers) {
  const n = numbers, J = jumpReach({ gravity: n.gravity, jump: n.jump, fallScale: n.fallScale, speed: n.speed });
  const up = J.up * MARGIN, across = rise => J.across(Math.max(rise, -6)) * MARGIN, step = n.step, body = n.body;
  const G = spansOf(colliders, areaOf(layout)), { cells, nx, nz } = G;
  // nodes: per cell, the tops with room for the body above
  const nodeTop = [], nodeCell = [], byCell = cells.map(() => []);
  const blocked = (ci, y) => cells[ci].some(([a, b]) => b > y + step + 0.01 && a < y + body - 0.01);
  for (let ci = 0; ci < cells.length; ci++) {
    const list = cells[ci];
    for (let k = 0; k < list.length; k++) {
      const y = list[k][1], above = list[k + 1]?.[0] ?? Infinity;
      if (above - y < body) continue;
      byCell[ci].push(nodeTop.length); nodeTop.push(y); nodeCell.push(ci);
    }
  }
  // the body's radius: nothing in the eight cells round may poke into it above a step
  const i_ = ci => ci % nx, j_ = ci => Math.floor(ci / nx);
  const around = ci => { const out = [], i = i_(ci), j = j_(ci); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < nz) out.push(b * nx + a); } return out; };
  const fits = nodeTop.map((y, k) => around(nodeCell[k]).every(c => !blocked(c, y)));
  const landOn = (ci, y) => { let best = -1; for (const k of byCell[ci]) if (fits[k] && nodeTop[k] <= y + step + 1e-6 && (best < 0 || nodeTop[k] > nodeTop[best])) best = k; return best; };
  // breadth first from the first spawn (of each level): walk, then jumps from the edges of what is reached
  const targets = targetsOf(layout), spawns = targets.filter(t => t.kind === 'spawn');
  const prev = new Int32Array(nodeTop.length).fill(-2), how = new Uint8Array(nodeTop.length);   // how: 0 start, 1 walk, 2 jump
  const queue = []; let head = 0;   // breadth first: a queue read from its head
  const startOf = p => { const ci = G.at(p[0], p[2]); return ci < 0 ? -1 : landOn(ci, (p[1] ?? 0) + 0.2); };
  for (const s of spawns.filter(t => t.first).map(t => startOf(t.at))) if (s >= 0 && prev[s] === -2) { prev[s] = -1; queue.push(s); }
  const walk = () => { while (head < queue.length) { const k = queue[head++]; for (const c of around(nodeCell[k])) { if (blocked(c, nodeTop[k])) continue; const m = landOn(c, nodeTop[k]); if (m >= 0 && prev[m] === -2) { prev[m] = k; how[m] = 1; queue.push(m); } } } };
  walk();
  const R = Math.ceil(across(-6) / CELL) + 1, BUCKET = 8;
  const arcClear = (a, b) => {
    const ya = nodeTop[a], yb = nodeTop[b], ax = G.cx(i_(nodeCell[a])), az = G.cz(j_(nodeCell[a])), bx = G.cx(i_(nodeCell[b])), bz = G.cz(j_(nodeCell[b]));
    const d = Math.hypot(bx - ax, bz - az), samples = Math.max(2, Math.ceil(d / (CELL * 0.5))), tUp = n.jump / n.gravity;
    for (let s = 1; s < samples; s++) {
      const f = s / samples, t = (f * d) / n.speed;
      const y = t <= tUp ? ya + n.jump * t - (n.gravity * t * t) / 2 : ya + J.up - (n.gravity * n.fallScale * (t - tUp) ** 2) / 2;
      if (y < Math.min(ya, yb) - 0.05) return false;
      const ci = G.at(ax + (bx - ax) * f, az + (bz - az) * f);
      if (ci < 0 || cells[ci].some(([lo, hi]) => hi > Math.max(y, Math.min(ya, yb)) + 0.02 && lo < y + body - 0.05)) return false;
    }
    return true;
  };
  // each place is tried as a take-off once: a jump depends only on the two places, so one tried before cannot reach
  // anything new later
  const tried = new Uint8Array(nodeTop.length);
  for (let round = 0; round < 40; round++) {
    const reachedNow = []; let top = -Infinity;
    for (let k = 0; k < nodeTop.length; k++) if (prev[k] !== -2) { top = Math.max(top, nodeTop[k]); if (!tried[k]) { reachedNow.push(k); tried[k] = 1; } }
    // where a jump may land: the places a body fits on, not reached yet, no higher than a jump from the highest reached
    // one, in buckets of BUCKET cells
    const open = new Map();
    for (let k = 0; k < nodeTop.length; k++) if (prev[k] === -2 && fits[k] && nodeTop[k] <= top + up + 1e-9) { const key = Math.floor(j_(nodeCell[k]) / BUCKET) * 65536 + Math.floor(i_(nodeCell[k]) / BUCKET); if (!open.has(key)) open.set(key, []); open.get(key).push(k); }
    let added = 0;
    for (const a of reachedNow) {
      // a take-off is at an edge: some neighbour cannot be walked onto at this height
      const ci = nodeCell[a];
      if (around(ci).every(c => { const m = landOn(c, nodeTop[a]); return m >= 0 && Math.abs(nodeTop[m] - nodeTop[a]) <= step && !blocked(c, nodeTop[a]); })) continue;
      // the places not yet reached within a running jump of it (a square of R cells each way), nearest rows first, as a
      // scan of that square would meet them
      const i = i_(ci), j = j_(ci), hits = [];
      for (let bj = Math.floor((j - R) / BUCKET); bj <= Math.floor((j + R) / BUCKET); bj++) for (let bi = Math.floor((i - R) / BUCKET); bi <= Math.floor((i + R) / BUCKET); bi++) {
        for (const b of open.get(bj * 65536 + bi) ?? []) {
          const di = i_(nodeCell[b]) - i, dj = j_(nodeCell[b]) - j;
          if (Math.abs(di) > R || Math.abs(dj) > R || prev[b] !== -2) continue;
          const rise = nodeTop[b] - nodeTop[a];
          if (rise > up || Math.hypot(di, dj) * CELL > across(rise) + CELL * 0.5) continue;
          hits.push(b);
        }
      }
      hits.sort((p, q) => p - q);
      for (const b of hits) { if (!arcClear(a, b)) continue; prev[b] = a; how[b] = 2; queue.push(b); added++; }
    }
    walk();
    if (!added) break;
  }
  // the targets: each needs a reached node that passes its test
  const reached = []; for (let k = 0; k < nodeTop.length; k++) if (prev[k] !== -2) reached.push(k);
  const pos = k => [G.cx(i_(nodeCell[k])), nodeTop[k], G.cz(j_(nodeCell[k]))];
  const jumpCount = new Map(), jumpsTo = k => { if (jumpCount.has(k)) return jumpCount.get(k); let c = 0; for (let q = k; prev[q] >= 0; q = prev[q]) if (how[q] === 2) c++; jumpCount.set(k, c); return c; };
  const problems = [], needed = new Map(), found = [];
  for (const t of targets) {
    // of the places in the target, the one the fewest jumps get to (a walk beats a jump that also gets there)
    let hit;
    for (const k of reached) { const [x, y, z] = pos(k); if (t.test(x, y, z) && (hit === undefined || jumpsTo(k) < jumpsTo(hit))) hit = k; }
    if (hit === undefined) {
      // explain: the best take-off for the place in the target: the reached place that asks the smallest rise among
      // those within a running jump (or else the nearest), with how far up and across
      const any = nodeTop.map((y, k) => k).filter(k => { const [x, y, z] = pos(k); return fits[k] && t.test(x, y, z); });
      let best = null;
      for (const b of any) for (const k of reached) {
        const pa = pos(k), pb = pos(b), d = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]), rise = pb[1] - pa[1], score = d <= across(0) * 1.5 ? rise : 100 + d;
        if (!best || score < best.score) best = { score, from: pa, to: pb, d, rise };
      }
      const say = best ? `the nearest way up asks a rise of ${best.rise.toFixed(2)} m over ${best.d.toFixed(1)} m (from ${best.from.map(v => v.toFixed(1)).join(', ')})` : 'there is nowhere to stand in it';
      problems.push({ code: 'unreachable', target: t.name, kind: t.kind, at: t.at, ...(best ? { from: best.from.map(v => +v.toFixed(2)), to: best.to.map(v => +v.toFixed(2)), rise: +best.rise.toFixed(2), gap: +best.d.toFixed(2) } : {}),
        message: `${t.name} cannot be reached from the first spawn: ${say}; a jump rises ${up.toFixed(2)} m and crosses ${across(0).toFixed(2)} m` });
      continue;
    }
    found.push({ target: t.name, at: pos(hit).map(v => +v.toFixed(2)) });
    for (let k = hit; prev[k] >= 0; k = prev[k]) if (how[k] === 2) needed.set(k, { from: pos(prev[k]).map(v => +v.toFixed(2)), to: pos(k).map(v => +v.toFixed(2)), rise: +(nodeTop[k] - nodeTop[prev[k]]).toFixed(2), gap: +(Math.hypot(pos(k)[0] - pos(prev[k])[0], pos(k)[2] - pos(prev[k])[2])).toFixed(2), for: t.name });
  }
  return {
    ok: problems.length === 0, problems, found, jumps: [...needed.values()],
    numbers: { up: +up.toFixed(3), across: +across(0).toFixed(3), step, body, margin: MARGIN },
    stats: { cells: nx * nz, nodes: nodeTop.length, reached: reached.length, targets: targets.length },
  };
}

export class PlaceRefused extends Error { constructor(problems) { super(`the place cannot be played: ${problems.map(p => p.message).join('; ')}`); this.code = 'unreachable'; this.problems = problems; } }
/** Refuse a layout a player cannot cross. → the report when it can be crossed. */
export function refuse(layout, catalog, numbers) {
  const r = reachOf(layout, collidersOf(layout, catalog), numbers);
  if (!r.ok) throw new PlaceRefused(r.problems);
  return r;
}
