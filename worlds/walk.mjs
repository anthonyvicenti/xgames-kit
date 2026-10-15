// The walk grid (worlds/placement.js's model, apart so pure code can build one: a terrain's connectors are planned at
// generation over the ground's own distance field, worlds/terrain/connect.mjs). No imports: Node, a worker and every
// game's copy load it the same. See placement.js for the API a world carries; createWalk(source) is that API over any
// source of surfaces (Rapier colliders, boxes, a distance field).

/** A jump's reach from the capsule's numbers, as runtimes/three/profiles/flat-2d/tilemap.js jumpReach. */
export function jumpReach({ gravity = 20, jump = 10.5, fallScale = 1.7, speed = 5.2 } = {}) {
  const up = (jump * jump) / (2 * gravity), tUp = jump / gravity;
  const across = rise => (rise > up ? 0 : speed * (tUp + Math.sqrt((2 * (up - rise)) / (gravity * fallScale))));
  return { up, across, gravity, jump, fallScale, speed };
}
export const REACH_MARGIN = 0.82;
/** A distance in the plane by + * and sqrt only (exact in every engine: a terrain's connectors are planned on every copy
 *  from this grid, so each must reach the same answer; Math.hypot and Math.tan may differ in the last bit). */
export const hyp = (a, b) => Math.sqrt(a * a + b * b);
const q6 = v => Math.round(v * 1e6) / 1e6;

const L = 4;                         // surfaces kept per column (the highest four)
const MAX_COLUMNS = 26000;           // a big world gets a coarser grid, so building it stays a fraction of a second
const F_FIT = 1, F_WET = 2, F_PASS = 4, F_NUDGE = 8, F_THING = 16;   // F_THING: the top of a thing (a prop, a wall), not ground
export const NUDGES = [[0.17, 0], [-0.17, 0], [0, 0.17], [0, -0.17]];   // where a fit is tried off a column's middle
const JUMP_COST = 4;                // metres a jump costs a route over its length (a run-up, the risk of falling short)
export const PROBES = [0.5, 0.7, 1.1, 1.6, 2.2, 3, 4, 5.5];   // heights over a surface a pokes-up probe tries (what a jump must clear)

/** The grid's cell for an area: 0.5 m, or coarser so the grid has at most MAX_COLUMNS columns. */
export function cellFor(area, cell = 0.5) {
  const w = area[2] - area[0], d = area[3] - area[1];
  return Math.max(cell, Math.sqrt((w * d) / MAX_COLUMNS));
}

/**
 * The walk grid over a source. source: {
 *   area() → [x0, z0, x1, z1]          where play can be (a world's play box)
 *   surfaces(x, z) → [{y, ny, fits, pass?}]   the surfaces facing up in the column (ny: the normal's y; pass: a one-way
 *                                       ledge a body jumps up through), any order
 *   water?(x, z) → level | null        the water's surface over the column
 *   seats() → [{x, y, z}]              where players start
 *   roof?(x, y, z) → bool              something over the place within 12 m (a cave's roof): its region is covered
 *   open?(x, y, z) → bool              is the point open air (a drop into a column with something over its landing
 *                                       is only a drop where the body can step over: else the column is a wall there)
 *   zone?(name) → a world zone         {contains(p)} (world.zone)
 *   version?() → any                   changes when the world does (a level, a crater): the grid is built again
 *   numbers                            movement numbers (reach.js movementOf; swim: true lets a body cross water)
 *   cell?                              the grid's cell (0.5)
 * }
 */
export function createWalk(source) {
  const n = { step: 0.45, slopeMaxDeg: 50, body: 1.6, radius: 0.3, speed: 5.2, jump: 7.2, gravity: 20, fallScale: 1.7, ...(source.numbers ?? {}) };
  const J = jumpReach({ gravity: n.gravity, jump: n.jump, fallScale: n.fallScale, speed: n.speed });
  const up = J.up * REACH_MARGIN, across = rise => J.across(Math.max(rise, -8)) * REACH_MARGIN;
  // a slope the body walks up: 10° under what the capsule stands on (its margin, as a jump's REACH_MARGIN)
  const walkDeg = Math.max(15, n.slopeMaxDeg - 10);
  const tanSlope = q6(Math.tan((walkDeg * Math.PI) / 180)), minNy = q6(Math.cos((walkDeg * Math.PI) / 180));
  let G = null, builtFor, dirty = [], fields = new Map(), seatSets = null, buildMs = 0, builds = 0;
  const stamp = () => JSON.stringify([source.version?.() ?? 0, source.area()]);

  // ---------------------------------------------------------------------------------------------- columns
  function sampleColumn(g, ci) {
    const i = ci % g.nx, j = Math.floor(ci / g.nx), x = g.x0 + (i + 0.5) * g.cell, z = g.z0 + (j + 0.5) * g.cell;
    const list = (source.surfaces(x, z) ?? []).filter(s => Number.isFinite(s.y)).sort((a, b) => b.y - a.y).slice(0, L);
    const w = source.water?.(x, z);
    g.cnt[ci] = list.length;
    for (let k = 0; k < L; k++) {
      const s = list[k], id = ci * L + k;
      if (!s) { g.y[id] = -Infinity; g.ny[id] = 0; g.fl[id] = 0; g.ob[id] = -Infinity; continue; }
      g.y[id] = s.y; g.ny[id] = s.ny ?? 1; g.ob[id] = Math.max(s.y, s.block ?? s.y);
      g.fl[id] = (s.fits ? F_FIT : 0) | (w != null && s.y < w - 0.05 ? F_WET : 0) | (s.pass ? F_PASS : 0) | (s.nudged ? F_NUDGE : 0) | (s.thing ? F_THING : 0);
    }
  }
  function build() {
    const t0 = performance.now();
    const area = source.area(), cell = cellFor(area, source.cell ?? 0.5);
    const nx = Math.max(1, Math.ceil((area[2] - area[0]) / cell)), nz = Math.max(1, Math.ceil((area[3] - area[1]) / cell));
    const same = G && G.nx === nx && G.nz === nz && G.x0 === area[0] && G.z0 === area[1] && G.cell === cell;
    const g = same ? G : { x0: area[0], z0: area[1], x1: area[2], z1: area[3], cell, nx, nz, cnt: new Uint8Array(nx * nz), y: new Float32Array(nx * nz * L), ny: new Float32Array(nx * nz * L), fl: new Uint8Array(nx * nz * L), ob: new Float32Array(nx * nz * L) };
    // a world that changed in places (a crater) samples only the columns there again
    if (same && dirty.length && !dirty.includes(null)) {
      for (const b of dirty) {
        const i0 = Math.max(0, Math.floor((b[0] - g.x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b[2] - g.x0) / cell));
        const j0 = Math.max(0, Math.floor((b[1] - g.z0) / cell)), j1 = Math.min(nz - 1, Math.floor((b[3] - g.z0) / cell));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) sampleColumn(g, j * nx + i);
      }
    } else for (let ci = 0; ci < nx * nz; ci++) sampleColumn(g, ci);
    dirty = [];
    edges(g);
    G = g; builtFor = stamp(); fields = new Map(); seatSets = null;
    buildMs = Math.round(performance.now() - t0); builds++;
    return g;
  }
  const grid = () => {
    const s = stamp();
    if (!G || s !== builtFor || dirty.length) build();
    // a world whose colliders are not in its queries yet (before the physics' first step) has no surfaces: try again
    // on the next call rather than keep an empty grid
    if (!G.nodes) builtFor = undefined;
    return G;
  };

  // ---------------------------------------------------------------------------------------------- edges
  const usable = (g, id) => (g.fl[id] & F_FIT) && (n.swim || !(g.fl[id] & F_WET)) && g.ny[id] >= minNy * 0.98;
  const xOf = (g, ci) => g.x0 + ((ci % g.nx) + 0.5) * g.cell, zOf = (g, ci) => g.z0 + (Math.floor(ci / g.nx) + 0.5) * g.cell;
  /** The surface a body walking from height y lands on in column ci: the highest one at most `climb` above y. */
  function landing(g, ci, y, climb) {
    for (let k = 0; k < g.cnt[ci]; k++) { const id = ci * L + k; if (g.y[id] <= y + climb + 1e-6) return id; }
    return -1;
  }
  /** The highest solid thing in a column that is not a one-way ledge (what a jump's arc must clear): a surface's top,
   *  or what pokes up beside it (a thin wall between two columns) */
  function solidTop(g, ci) { let t = -Infinity; for (let k = 0; k < g.cnt[ci]; k++) { const id = ci * L + k; if (!(g.fl[id] & F_PASS)) t = Math.max(t, g.ob[id]); } return t; }
  function edges(g) {
    const { nx, nz, cell } = g, N = nx * nz * L;
    const out = Array.from({ length: N }, () => null);
    const add = (a, b, jump) => { (out[a] ??= []).push(jump ? -(b + 1) : b); };
    const edge = new Uint8Array(N);
    let nodes = 0;
    for (let ci = 0; ci < nx * nz; ci++) {
      const i = ci % nx, j = Math.floor(ci / nx);
      for (let k = 0; k < g.cnt[ci]; k++) {
        const a = ci * L + k; if (!usable(g, a)) continue;
        nodes++;
        const ya = g.y[a];
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const I = i + di, Jj = j + dj;
          if (I < 0 || Jj < 0 || I >= nx || Jj >= nz) { edge[a] = 1; continue; }
          const cj = Jj * nx + I, d = hyp(di, dj) * cell;
          const b = landing(g, cj, ya, Math.max(n.step, d * tanSlope));
          if (b < 0 || !usable(g, b)) { edge[a] = 1; continue; }
          // a diagonal past a corner: both sides must be open
          if (di && dj) { const s1 = landing(g, j * nx + I, ya, n.step + d * tanSlope), s2 = landing(g, Jj * nx + i, ya, n.step + d * tanSlope); if (s1 < 0 || s2 < 0 || !usable(g, s1) || !usable(g, s2)) continue; }
          // a place the body fits only off its column's middle (a corridor one tile wide): the step must be clear
          if (((g.fl[a] | g.fl[b]) & F_NUDGE) && source.clear && !source.clear(xOf(g, ci), ya, zOf(g, ci), xOf(g, cj), g.y[b], zOf(g, cj))) { edge[a] = 1; continue; }
          if (ya - g.y[b] > n.step) {
            edge[a] = 1;                                        // a drop: also a place to jump from
            // down to a surface under something (a cave's floor under the cliff, the ground under a castle): only where
            // the body can step over at its own height (else it is a wall, not a drop)
            if (b !== cj * L && source.open && !source.open(xOf(g, cj), ya + n.body * 0.5, zOf(g, cj))) continue;
          }
          add(a, b, false);
        }
      }
    }
    // jumps: from an edge to another edge or open ground beyond a gap, up to the jump's rise, the arc clear
    const R = Math.ceil(across(-8) / cell) + 1;
    for (let ci = 0; ci < nx * nz; ci++) {
      const i = ci % nx, j = Math.floor(ci / nx);
      for (let k = 0; k < g.cnt[ci]; k++) {
        const a = ci * L + k; if (!edge[a] || !usable(g, a)) continue;
        const ya = g.y[a];
        for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
          if (!di && !dj) continue;
          const I = i + di, Jj = j + dj; if (I < 0 || Jj < 0 || I >= nx || Jj >= nz) continue;
          const cj = Jj * nx + I, d = hyp(di, dj) * cell, near = Math.abs(di) <= 1 && Math.abs(dj) <= 1;
          for (let kk = 0; kk < g.cnt[cj]; kk++) {
            const b = cj * L + kk;
            // overhead (higher than the jump goes): passed under; the first surface at or under the jump's top is the one
            // the body meets, so a surface under it (a cave's floor under the cliff's top) is never landed on through it
            if (g.y[b] - ya > up + 0.05) continue;
            if (!usable(g, b)) break;
            const rise = g.y[b] - ya;
            if (near && rise <= Math.max(n.step, d * tanSlope)) break;   // next door and not above a step: a walk
            // a hop straight up onto the next column: a ledge on level ground (a crate, a kerb), never a scramble up a
            // hillside's terraces, which a body running at them meets as a wall
            if (near && (g.ny[a] < 0.95 || g.ny[b] < 0.95)) break;
            // any jump up: from level ground onto level ground (a run-up on a steep slope is not a jump, and a body
            // lands on a ledge, not on a hillside)
            if (rise > n.step && (g.ny[a] < 0.9 || g.ny[b] < 0.9)) break;
            if (rise > up || d > across(rise)) break;
            if (!arcClear(g, i, j, I, Jj, ya, g.y[b])) break;
            add(a, b, true);
            break;                                              // the highest surface there it can land on
          }
        }
      }
    }
    // links: ways across the walk itself does not make (a launch pad's fling, a ladder: worlds/connect.mjs), each from a
    // place to a place, travelled as a jump is (source.links() → [{from: {x, y, z}, to: {x, y, z}}])
    for (const k of source.links?.() ?? []) {
      const a = snap(g, k.from, 1.2, 1.5), b = snap(g, k.to, 1.2, 1.5);
      if (a >= 0 && b >= 0 && a !== b) add(a, b, true);
    }
    // compact: CSR, and the reverse for routing (a field from the goal)
    const off = new Int32Array(N + 1); for (let a = 0; a < N; a++) off[a + 1] = off[a] + (out[a]?.length ?? 0);
    const to = new Int32Array(off[N]); for (let a = 0; a < N; a++) if (out[a]) to.set(out[a], off[a]);
    const roff = new Int32Array(N + 1); for (let e = 0; e < to.length; e++) roff[(to[e] < 0 ? -to[e] - 1 : to[e]) + 1]++;
    for (let a = 0; a < N; a++) roff[a + 1] += roff[a];
    const rfrom = new Int32Array(to.length), fill = roff.slice(0, N);
    for (let a = 0; a < N; a++) for (let e = off[a]; e < off[a + 1]; e++) { const b = to[e] < 0 ? -to[e] - 1 : to[e]; rfrom[fill[b]++] = to[e] < 0 ? -(a + 1) : a; }
    Object.assign(g, { off, to, roff, rfrom, nodes, edge });
  }
  function arcClear(g, i, j, I, Jj, ya, yb) {
    const steps = Math.max(Math.abs(I - i), Math.abs(Jj - j));
    const hump = Math.max(0.25, up - Math.max(0, yb - ya)) * 0.9;
    for (let s = 1; s < steps; s++) {
      const f = s / steps, ci = Math.round(j + (Jj - j) * f) * g.nx + Math.round(i + (I - i) * f);
      const arc = ya + (yb - ya) * f + 4 * f * (1 - f) * hump;
      if (solidTop(g, ci) > arc - 0.05) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------- searches
  /** Breadth first from `starts` over the edges (forward), or toward a goal (reverse) → Int32 steps (-1: not reached). */
  function flood(g, starts, reverse = false) {
    const N = g.cnt.length * L, dist = new Int32Array(N).fill(-1), q = new Int32Array(N);
    let h = 0, t = 0;
    for (const s of starts) if (s >= 0 && dist[s] < 0) { dist[s] = 0; q[t++] = s; }
    const off = reverse ? g.roff : g.off, nb = reverse ? g.rfrom : g.to;
    while (h < t) { const a = q[h++]; for (let e = off[a]; e < off[a + 1]; e++) { const b = nb[e] < 0 ? -nb[e] - 1 : nb[e]; if (dist[b] < 0) { dist[b] = dist[a] + 1; q[t++] = b; } } }
    return dist;
  }
  const cellOf = (g, x, z) => { const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((z - g.z0) / g.cell); return i < 0 || j < 0 || i >= g.nx || j >= g.nz ? -1 : j * g.nx + i; };
  /** The usable surface nearest a point (its column first, then the columns round it within `r` metres): a body there. */
  function snap(g, p, r = 0.8, dy = 1.2) {
    let best = -1, bd = Infinity;
    const R = Math.ceil(r / g.cell), i0 = Math.floor((p.x - g.x0) / g.cell), j0 = Math.floor((p.z - g.z0) / g.cell);
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
      const ci = j * g.nx + i, h = hyp(xOf(g, ci) - p.x, zOf(g, ci) - p.z); if (h > r + g.cell * 0.71) continue;
      for (let k = 0; k < g.cnt[ci]; k++) {
        const id = ci * L + k; if (!usable(g, id)) continue;
        const v = Number.isFinite(p.y) ? g.y[id] - p.y : 0;
        if (v > dy || v < -dy - 1.5) continue;
        const score = h + Math.abs(v) * 0.5;
        if (score < bd) { bd = score; best = id; }
      }
    }
    return best;
  }
  /** Which places every seat reaches (a place a seat cannot reach is no place for an objective). */
  function seatReach(g) {
    if (seatSets) return seatSets;
    const seats = (source.seats?.() ?? []).map(s => ({ x: s.x ?? s[0], y: s.y ?? s[1], z: s.z ?? s[2] }));
    const per = seats.map(s => { const a = snap(g, s, 1.0, 1.5); return { seat: s, node: a, dist: a >= 0 ? flood(g, [a]) : null }; });
    const all = new Uint8Array(g.cnt.length * L), any = new Uint8Array(g.cnt.length * L);
    const ok = per.filter(p => p.dist);
    for (let id = 0; id < all.length; id++) { all[id] = ok.length && ok.every(p => p.dist[id] >= 0) ? 1 : 0; any[id] = ok.some(p => p.dist[id] >= 0) ? 1 : 0; }
    // split: some seat cannot get to another's start (players on islands with no way across: an artillery duel, a team
    // each on its own ground). Then what every seat reaches may be nothing, and a place is fair when some seat reaches it
    const split = ok.some(p => ok.some(o => o !== p && o.node >= 0 && p.dist[o.node] < 0));
    seatSets = { per, all, any, split };
    return seatSets;
  }
  /** The cost of the way to `goal` from every place (Dijkstra over the reverse edges): metres walked, a climb, and a
   *  jump's run-up, so a walk on flat ground is always taken over a hop that saves a step. */
  function costTo(g, goal) {
    // Float64: a Float32 field rounds a stored cost up past the same sum made again, and the search never settles
    const N = g.cnt.length * L, cost = new Float64Array(N).fill(Infinity), heap = [];
    const push = (c, id) => { heap.push([c, id]); let i = heap.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (heap[pa][0] <= heap[i][0]) break; [heap[pa], heap[i]] = [heap[i], heap[pa]]; i = pa; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    cost[goal] = 0; push(0, goal);
    while (heap.length) {
      const [c, b] = pop(); if (c > cost[b]) continue;
      const pb = pos(g, b);
      for (let e = g.roff[b]; e < g.roff[b + 1]; e++) {
        const jump = g.rfrom[e] < 0, a = jump ? -g.rfrom[e] - 1 : g.rfrom[e], pa = pos(g, a);
        const step = hyp(pa.x - pb.x, pa.z - pb.z) + Math.max(0, pb.y - pa.y) * 0.5 + (jump ? JUMP_COST : 0);
        if (c + step < cost[a]) { cost[a] = c + step; push(cost[a], a); }
      }
    }
    return cost;
  }
  function towardField(g, goal) {
    const key = goal;
    if (fields.has(key)) { const f = fields.get(key); fields.delete(key); fields.set(key, f); return f; }
    const f = costTo(g, goal);
    fields.set(key, f); if (fields.size > 24) fields.delete(fields.keys().next().value);
    return f;
  }

  // ---------------------------------------------------------------------------------------------- the API
  const pos = (g, id) => { const ci = Math.floor(id / L); return { x: xOf(g, ci), y: g.y[id], z: zOf(g, ci) }; };
  const zoneTest = (o) => {
    if (!o) return null;
    if (typeof o === 'string') { const zn = source.zone?.(o); return zn ? p => zn.contains(p) : () => false; }
    const at = o.at ?? o, ax = at.x ?? at[0], az = at.z ?? at[at.length - 1];
    if (o.size && (o.shape === 'box' || o.size.length > 1)) { const hx = o.size[0] / 2, hz = (o.size[2] ?? o.size[1] ?? o.size[0]) / 2; return p => Math.abs(p.x - ax) <= hx && Math.abs(p.z - az) <= hz; }
    const r = o.r ?? o.radius ?? o.size?.[0] ?? 2; return p => hyp(p.x - ax, p.z - az) <= r;
  };

  /** Why a body cannot be at p, read from the ground there (null when it could stand there). */
  function whyAt(g, p) {
    if (p.x < g.x0 || p.z < g.z0 || p.x > g.x1 || p.z > g.z1) return 'outside the world';
    const ci = cellOf(g, p.x, p.z), w = source.water?.(p.x, p.z) ?? null;
    if (ci < 0 || !g.cnt[ci]) return w != null ? 'in water' : 'over the void';
    let below = -1; for (let k = 0; k < g.cnt[ci]; k++) { const id = ci * L + k; if (g.y[id] <= p.y + 0.6) { below = id; break; } }
    if (below < 0) return 'under the ground';
    const top = g.y[ci * L];
    if (p.y < top - 0.6 && below !== ci * L) return 'under the ground';
    if (w != null && g.y[below] < w - 0.05 && !n.swim) return 'in water';
    if (p.y - g.y[below] > up + n.body) return 'floating';
    if (!(g.fl[below] & F_FIT) || g.ny[below] < minNy * 0.98) return 'inside something solid';
    return null;
  }
  const api = {
    numbers: { ...n, jumpUp: +up.toFixed(3), jumpAcross: +across(0).toFixed(3) },
    groundAt(x, z, below = Infinity) {
      const list = source.surfaces(x, z) ?? []; let best = null;
      for (const s of list) if (s.y <= below + n.step && (best === null || s.y > best)) best = s.y;
      return best;
    },
    waterAt: (x, z) => source.water?.(x, z) ?? null,
    isWalkable(x, z, y = Infinity) {
      const g = grid(), ci = cellOf(g, x, z); if (ci < 0) return false;
      for (let k = 0; k < g.cnt[ci]; k++) { const id = ci * L + k; if (g.y[id] <= y + n.step) return !!usable(g, id); }
      return false;
    },
    /** Can a body get from `from` (a point or a seat's index) to `to`? → {ok, why, at, ground, water} */
    reach(from, to, { radius = 1.0 } = {}) {
      const g = grid();
      const P = { x: to.x ?? to[0], y: to.y ?? to[1] ?? Infinity, z: to.z ?? to[2] };
      const ground = api.groundAt(P.x, P.z, Number.isFinite(P.y) ? P.y + 0.6 : Infinity), water = api.waterAt(P.x, P.z);
      const res = (ok, why) => ({ ok, why, at: [+P.x.toFixed(2), Number.isFinite(P.y) ? +P.y.toFixed(2) : null, +P.z.toFixed(2)], ground: ground == null ? null : +ground.toFixed(2), water: water == null ? null : +water.toFixed(2) });
      let dist;
      if (typeof from === 'number') { const s = seatReach(g).per[from]; if (!s?.dist) return res(false, 'the start has no ground'); dist = s.dist; }
      else { const a = snap(g, { x: from.x ?? from[0], y: from.y ?? from[1], z: from.z ?? from[2] }, 1.0, 1.5); if (a < 0) return res(false, 'the start has no ground'); dist = flood(g, [a]); }
      const near = nodesNear(g, P, radius);
      if (near.some(id => dist[id] >= 0)) return res(true, null);
      return res(false, whyAt(g, P) ?? (near.length ? 'walled off' : 'floating'));
    },
    /** n points on dry ground every seat reaches, clear and spread out (see the file's head). */
    place(kind, count, opts = {}) {
      const g = grid(), rng = opts.rng ?? Math.random, R0 = seatReach(g);
      // on every seat's ground; where the seats' ground is split and they share none, on any seat's (spread over all)
      let all = R0.split && !R0.all.some(v => v) ? R0.any : R0.all;
      // from: the places one body gets to from where it stands (a bot's next place to wander to), not the seats'
      if (opts.from) { const a = snap(g, { x: opts.from.x, y: opts.from.y, z: opts.from.z }, 1.0, 1.5); const d = a >= 0 ? flood(g, [a]) : null; all = d ? Uint8Array.from(d, v => (v >= 0 ? 1 : 0)) : new Uint8Array(all.length); }
      const clear = opts.clear ?? 0.6, away = opts.away ?? 1.5, inZone = zoneTest(opts.zone), near = opts.near ? zoneTest(opts.near) : null;
      const seats = seatReach(g).per.map(s => s.seat), exclude = opts.exclude ?? [];
      const R = Math.ceil(clear / g.cell), cand = [];
      for (let id = 0; id < all.length; id++) {
        if (!all[id] || !usable(g, id)) continue;
        const p = pos(g, id);
        if (inZone && !inZone(p)) continue;
        if (near && !near(p)) continue;
        if (seats.some(s => hyp(s.x - p.x, s.z - p.z) < away)) continue;
        if (exclude.some(e => hyp((e.x ?? e[0]) - p.x, (e.z ?? e[2]) - p.z) < (e.r ?? 1))) continue;
        if (!openRound(g, id, R)) continue;
        cand.push(id);
      }
      const out = [], gap = opts.gap ?? 0;
      if (!cand.length) return Object.assign(out, { asked: count, why: inZone ? 'no open ground every seat reaches in that zone' : 'no open ground every seat reaches' });
      // prefer: the places nearest a point first (a station "in the middle"), each `gap` from the last
      if (opts.prefer) {
        const px = opts.prefer.x ?? opts.prefer[0], pz = opts.prefer.z ?? opts.prefer[opts.prefer.length - 1];
        const by = cand.map(id => [id, pos(g, id)]).sort((a, b) => hyp(a[1].x - px, a[1].z - pz) - hyp(b[1].x - px, b[1].z - pz));
        for (const [, p] of by) { if (out.length >= count) break; if (out.every(q => hyp(q.x - p.x, q.z - p.z) >= gap)) out.push({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }); }
        return Object.assign(out, { asked: count, kind });
      }
      // spread: Mitchell's best candidate (of a few random tries, the one farthest from those already chosen)
      // spread from the seats in play as well (players do not start on top of what they are to go for; the seats are the
      // game's, players.max of them, so a level's spare seats do not push everything to its far edge)
      const taken = [...seats.map(q => ({ x: q.x, z: q.z })), ...exclude.map(e => ({ x: e.x ?? e[0], z: e.z ?? e[2] }))];
      const placedOnly = [];
      for (let c = 0; c < count; c++) {
        let best = -1, bd = -1;
        for (let t = 0; t < 32; t++) {
          const id = cand[Math.floor(rng() * cand.length) % cand.length], p = pos(g, id);
          const dPlaced = placedOnly.reduce((m, q) => Math.min(m, hyp(q.x - p.x, q.z - p.z)), Infinity);
          if (dPlaced < gap) continue;
          const d = taken.reduce((m, q) => Math.min(m, hyp(q.x - p.x, q.z - p.z)), Infinity);
          if (d > bd) { bd = d; best = id; }
        }
        // the random tries all fell too near the others: the farthest of every place that keeps the gap, if any does
        if (best < 0) for (const id of cand) {
          const p = pos(g, id);
          if (placedOnly.some(q => hyp(q.x - p.x, q.z - p.z) < gap)) continue;
          const d = taken.reduce((m, q) => Math.min(m, hyp(q.x - p.x, q.z - p.z)), Infinity);
          if (d > bd) { bd = d; best = id; }
        }
        if (best < 0) break;
        const p = pos(g, best), q = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
        out.push(q); taken.push(q); placedOnly.push(q);
      }
      return Object.assign(out, { asked: count, kind });
    },
    /** The next point toward `to` from `from` ({x, y, z, jump}) or null (straight on, or no way). */
    route(from, to) {
      const g = grid();
      const a = snap(g, from, 1.0, 1.5), goal = snap(g, { x: to.x, y: to.y ?? Infinity, z: to.z }, 1.2, Number.isFinite(to.y) ? 1.5 : 50);
      if (a < 0 || goal < 0 || a === goal) return null;
      const f = towardField(g, goal);
      if (!Number.isFinite(f[a])) return null;
      // walk the field down a few places, so the step is smooth; a jump on the way is said
      // (a jump is said only when it is the very next step: until then the way leads to its take-off; beside a drop the
      // way goes place by place)
      let cur = a, jump = false;
      for (let s = 0; s < 4 && f[cur] > 0; s++) {
        // the edge that is on the cheapest way: its own cost plus the cost from where it lands
        let next = -1, nd = Infinity, j = false;
        const pc = pos(g, cur);
        for (let e = g.off[cur]; e < g.off[cur + 1]; e++) {
          const jump = g.to[e] < 0, b = jump ? -g.to[e] - 1 : g.to[e]; if (!Number.isFinite(f[b])) continue;
          const pb = pos(g, b), c = f[b] + hyp(pb.x - pc.x, pb.z - pc.z) + Math.max(0, pb.y - pc.y) * 0.5 + (jump ? JUMP_COST : 0);
          if (c < nd - 1e-6) { nd = c; next = b; j = jump; }
        }
        if (next < 0 || (j && s > 0)) break;
        cur = next; if (j) { jump = true; break; }
        if (g.edge[cur]) break;                       // by a drop or a wall: step to it exactly, never cut the corner
      }
      if (cur === a) return null;
      const p = pos(g, cur);
      return { x: p.x, y: p.y, z: p.z, ...(jump ? { jump: true } : {}) };
    },
    walk: {
      get numbers() { return api.numbers; },
      stats() { const g = G; return g ? { cell: +g.cell.toFixed(3), columns: g.nx * g.nz, nodes: g.nodes, edges: g.to.length, buildMs, builds, jumpUp: +up.toFixed(2), jumpAcross: +across(0).toFixed(2) } : { builds }; },
      /** Is the grid built with ground in it (a world's colliders are in its queries after the physics' first step)? */
      ready() { const g = grid(); return g.nodes > 0; },
      /** The world changed: everywhere, or in a box [x0, z0, x1, z1] (a crater). The grid is built again when asked. */
      invalidate(box = null) { dirty.push(box); },
      /** The seats or the links changed (the ground did not): who reaches what is worked out again. */
      relink() { if (G) { edges(G); fields = new Map(); seatSets = null; } },
      /** Seats: where each starts and whether it stands on usable ground. */
      /** Is the seats' ground split (some seat cannot get to another's start)? */
      split() { return seatReach(grid()).split; },
      seats() {
        const g = grid(), { per } = seatReach(g);
        // each seat: where it starts, whether it stands on usable ground, how many places it gets to, and which other
        // seats it gets to (seats that cannot get to each other split the ground objectives may go on)
        return per.map((s, i) => ({ seat: i, at: [s.seat.x, s.seat.y, s.seat.z].map(v => +(+v).toFixed(2)), ok: !!s.dist,
          ...(s.dist ? { places: s.dist.reduce((n, d) => n + (d >= 0 ? 1 : 0), 0), reaches: per.map((o, j) => (o.node >= 0 && s.dist[o.node] >= 0 ? j : -1)).filter(j => j >= 0 && j !== i) } : { why: whyAt(g, s.seat) ?? 'no room to stand' }) }));
      },
      /**
       * Objectives against every seat: list [{kind, id, label?, x, y, z, radius?}] → [{...it, ok, from: [{seat, ok, why}], why}]
       * (an objective every seat can get to is ok; else `why` says what is wrong where it is).
       */
      audit(list) {
        const g = grid(), { per, split } = seatReach(g);
        return list.map(o => {
          const P = { x: o.x, y: o.y, z: o.z }, near = nodesNear(g, P, o.radius ?? 1.0);
          const from = per.map((s, i) => { const ok = !!s.dist && near.some(id => s.dist[id] >= 0); return { seat: i, ok, ...(ok ? {} : { why: s.dist ? (whyAt(g, P) ?? (near.length ? 'walled off' : 'floating')) : 'the start has no ground' }) }; });
          // where the seats' ground is split (seatReach), a thing some seat reaches is fair; else every seat must
          const bad = split ? (from.some(f => f.ok) ? null : from[0]) : from.find(f => !f.ok);
          return { ...o, ok: !bad, from, ...(bad ? { why: bad.why, ground: api.groundAt(o.x, o.z, o.y + 0.6), water: api.waterAt(o.x, o.z) } : {}) };
        });
      },
      /**
       * The ground the seats cannot get to, in regions (places joined by walking, a drop or a jump either way), each
       * with what stands on it and why there is no way to it. things: [{kind, id, x, y, z, r?, box?}] (landmarks, objectives,
       * set dressing: what the world holds that a player may want to go to) are given to the region under them.
       * → {seats: {places, area}, regions: [{id, places, area, at: [x, y, z], box: [x0, z0, x1, z1], y: [min, max],
       *     things: [...], gap: {from: [x, y, z], to: [x, y, z], across, rise, why}}]} biggest first.
       * why: 'water' (sea or a lake between) | 'void' (nothing under the way across) | 'cliff' (higher than a jump) |
       * 'wall' (something solid in the way) | 'too far' (a jump short). A region with trap: true is ground the seats get to
       * (a drop) with no way back to them: its gap is the way out (to ground that leads back).
       */
      regions({ things = [], minPlaces = 1, rims = false, backdrop = [] } = {}) {
        const g = grid(), { any, per } = seatReach(g), N = any.length, area1 = g.cell * g.cell;
        // the places from which a seat's start can be got back to (a pit a body drops into and cannot climb out of, a
        // ledge reached by a one-way drop: reached, and a trap)
        // (back to the seat that gets furthest: a seat in a pocket of its own is then a trap with a seat in it)
        const anchor = per.filter(p => p.node >= 0 && p.dist).map(p => [p, p.dist.reduce((n, d) => n + (d >= 0 ? 1 : 0), 0)]).sort((a, b) => b[1] - a[1])[0]?.[0];
        const back = anchor ? flood(g, [anchor.node], true) : new Int32Array(N).fill(-1);
        // regions: places that get to each other (strongly connected over walking, drops and jumps), so a way to any place
        // of a region is a way to all of it (a mesa's top and the flank below it it only drops to are two regions)
        const dec = v => (v < 0 ? -v - 1 : v);
        const groups = inSet => {
          const state = new Uint8Array(N), order = new Int32Array(N), stack = new Int32Array(N), next = new Int32Array(N);
          let on = 0;
          for (let s = 0; s < N; s++) {
            if (state[s] || !inSet(s)) continue;
            let sp = 0; stack[sp++] = s; state[s] = 1; next[s] = g.off[s];
            while (sp) {
              const a = stack[sp - 1];
              if (next[a] < g.off[a + 1]) { const b = dec(g.to[next[a]++]); if (!state[b] && inSet(b)) { state[b] = 1; next[b] = g.off[b]; stack[sp++] = b; } }
              else { sp--; order[on++] = a; }
            }
          }
          const comp = new Int32Array(N).fill(-1), out = [], q = new Int32Array(N);
          for (let k = on - 1; k >= 0; k--) {
            const s = order[k]; if (comp[s] >= 0) continue;
            const id = out.length; let h = 0, t = 0; q[t++] = s; comp[s] = id;
            while (h < t) { const a = q[h++]; for (let e = g.roff[a]; e < g.roff[a + 1]; e++) { const b = dec(g.rfrom[e]); if (comp[b] < 0 && inSet(b)) { comp[b] = id; q[t++] = b; } } }
            out.push(Array.from(q.subarray(0, t)));
          }
          return out;
        };
        const list = groups(id => !any[id] && usable(g, id));
        const traps = anchor ? groups(id => any[id] && back[id] < 0 && usable(g, id)) : [];
        const seatPlaces = any.reduce((n, v) => n + v, 0);
        // the rim of the seats' ground (places by a drop or a wall, or the grid's edge): where a way across starts
        const rimOf = ids => ids.filter(id => g.edge[id]);
        const seatRim = rimOf(Array.from({ length: N }, (_, i) => i).filter(i => any[i]));
        // the rim of the ground a body gets back to the seats from (a trap's way out ends there)
        const backRim = traps.length ? rimOf(Array.from({ length: N }, (_, i) => i).filter(i => any[i] && back[i] >= 0)) : [];
        // which region each place is in (a region's core: its places with the region's ground two cells all round them,
        // so a ribbon of beach under a cliff has none and a plateau has plenty)
        const all = [...list.map(ids => [ids, false]), ...traps.map(ids => [ids, true])];
        const regionOf = new Int32Array(N).fill(-1);
        all.forEach(([ids], k) => { for (const id of ids) regionOf[id] = k; });
        const coreOf = (ids, k) => {
          let n = 0;
          for (const id of ids) {
            const ci = Math.floor(id / L), i = ci % g.nx, j = Math.floor(ci / g.nx);
            let ok = true;
            for (let dj = -2; dj <= 2 && ok; dj++) for (let di = -2; di <= 2 && ok; di++) {
              const I = i + di, J = j + dj; if (I < 0 || J < 0 || I >= g.nx || J >= g.nz) { ok = false; break; }
              const c = J * g.nx + I; let has = false;
              for (let kk = 0; kk < g.cnt[c]; kk++) if (regionOf[c * L + kk] === k) { has = true; break; }
              if (!has) ok = false;
            }
            if (ok) n++;
          }
          return n;
        };
        const out = all.map(([ids, trap], k) => [ids, trap, k]).filter(([ids]) => ids.length >= minPlaces).map(([ids, trap, k0], k) => {
          let sx = 0, sy = 0, sz = 0, y0 = Infinity, y1 = -Infinity, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
          for (const id of ids) { const p = pos(g, id); sx += p.x; sy += p.y; sz += p.z; y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); }
          const n = ids.length, r = { id: k + 1, places: n, area: +(n * area1).toFixed(1), at: [sx / n, sy / n, sz / n].map(v => +v.toFixed(2)), box: [x0, z0, x1, z1].map(v => +v.toFixed(2)), y: [+y0.toFixed(2), +y1.toFixed(2)], things: [] };
          r.core = +(coreOf(ids, k0) * area1).toFixed(1);
          // under something (a cave, a tunnel inside the land, the ground under a castle): the share of its places with a
          // surface over them in the same column
          // (a surface over it in the grid, or solid ground over it a few metres up: a collider the column's ray met only
          // once leaves the roof out of the grid, so the source's own open-air test is asked too)
          const under = id => { if (id % L > 0) return true; if (!source.roof) return false; const p = pos(g, id); return source.roof(p.x, p.y, p.z); };
          r.covered = +(sample(ids, 120).filter(under).length / Math.min(ids.length, sample(ids, 120).length)).toFixed(2);
          // its places, sampled (a builder that fills a cave closes these)
          if (rims) r.places = sample(ids, 1500).map(id => { const p = pos(g, id); return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]; });
          // mostly the tops of things (a wall, a stall, a crate), not ground: no place to go for its own sake
          if (ids.filter(id => g.fl[id] & F_THING).length > n / 2) r.on = 'things';
          const rim = rimOf(ids).length ? rimOf(ids) : ids;
          // a trap: the seats get there (a drop), there is no way back; its gap is the way out, up to ground that leads back
          if (trap) r.trap = true;
          r.gap = gapTo(g, rim, trap ? backRim : seatRim);
          if (trap && r.gap) r.gap.out = true;          // its rise is the trap's below the way out: the climb is −rise
          r.start = [pos(g, ids[0])].map(p => [p.x, p.y, p.z].map(v => +v.toFixed(2)))[0];
          // its rim, as places with how level each is (a connector's ends are chosen from them)
          if (rims) r.rim = sample(rim, 400).map(id => { const p = pos(g, id); return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +g.ny[id].toFixed(3)]; });
          r.nodes = ids;
          return r;
        });
        // what stands on each region: a thing whose foot is on (or within its r of) one of the region's places
        const regionAt = new Map(); for (const r of out) for (const id of r.nodes) regionAt.set(id, r);
        for (const t of things) {
          // a thing with a box (a bridge's deck, a landmark's walls) holds the regions with a place inside its box
          if (t.box) {
            const [bx0, by0, bz0, bx1, by1, bz1] = t.box;
            for (const r of out) {
              const n = r.nodes.filter(id => { const p = pos(g, id); return p.x >= bx0 && p.x <= bx1 && p.z >= bz0 && p.z <= bz1 && p.y >= by0 && p.y <= by1 + 0.5; }).length;
              // share: how much of the region is inside the box (a bridge's deck alone, or an island the deck leads to)
              if (n) r.things.push({ kind: t.kind, id: t.id, at: [t.x, t.y, t.z].map(v => +(+v).toFixed(2)), share: +(n / r.nodes.length).toFixed(2) });
            }
            continue;
          }
          const near = nodesNear(g, { x: t.x, y: t.y, z: t.z }, t.r ?? 1.0);
          const hit = near.map(id => regionAt.get(id)).find(Boolean);
          if (hit) hit.things.push({ kind: t.kind, id: t.id, at: [t.x, t.y, t.z].map(v => +(+v).toFixed(2)) });
        }
        for (const r of out) delete r.nodes;
        const rimPts = l => sample(l, 1500).map(id => { const p = pos(g, id); return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +g.ny[id].toFixed(3)]; });
        const seats = { places: seatPlaces, area: +(seatPlaces * area1).toFixed(1), ...(rims ? { rim: rimPts(seatRim), ...(traps.length ? { back: rimPts(backRim) } : {}) } : {}) };
        // scenery out at sea that is not ground (a backdrop island: drawn, no colliders): how much open water lies between
        // it and the nearest place the seats get to (backdrop: [{id, at: [x, z], r}])
        const far = backdrop.map(b => {
          let near = Infinity; for (const id of seatRim) { const p = pos(g, id); near = Math.min(near, hyp(p.x - b.at[0], p.z - b.at[b.at.length - 1])); }
          return { id: b.id, at: b.at, r: b.r, water: +(near - b.r).toFixed(1) };
        });
        return { cell: +g.cell.toFixed(3), seats, regions: out.sort((a, b) => b.places - a.places).map((r, i) => ({ ...r, id: i + 1 })), ...(backdrop.length ? { backdrop: far } : {}) };
      },
      /** The grid itself (tests, the gate's evidence). */
      grid,
    },
  };
  /**
   * The nearest way across from a region's rim to the seats' rim: where it starts and ends, how far across, how high,
   * and why a body cannot make it (what is under the straight line between: water, nothing, a wall, or only height).
   */
  /** At most m of a list, evenly through it. */
  function sample(l, m) { return l.length <= m ? l : l.filter((_, i) => i % Math.ceil(l.length / m) === 0); }
  function gapTo(g, from, to) {
    if (!to.length || !from.length) return null;
    // the pair whose cost (across, plus three times what a climb asks over a jump) is least; on a big rim a sample
    const A = sample(from, 600).map(id => [id, pos(g, id)]), B = sample(to, 1500).map(id => [id, pos(g, id)]);
    let best = null;
    for (const [ia, a] of A) for (const [ib, b] of B) {
      const d = hyp(a.x - b.x, a.z - b.z), rise = a.y - b.y, c = d + Math.max(0, rise - up) * 3;
      if (!best || c < best.c) best = { c, ia, ib, a, b, d, rise };
    }
    const { a, b, d, rise } = best;
    // walk the line from the seats' side: what is under it
    const steps = Math.max(1, Math.ceil(d / (g.cell * 0.7)));
    let water = 0, voids = 0, wall = false;
    for (let s = 1; s < steps; s++) {
      const f = s / steps, x = b.x + (a.x - b.x) * f, z = b.z + (a.z - b.z) * f, ci = cellOf(g, x, z);
      if (ci < 0 || !g.cnt[ci]) { if ((source.water?.(x, z) ?? null) != null) water++; else voids++; continue; }
      const top = ci * L, lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      if (g.fl[top] & F_WET) water++;
      else if (solidTop(g, ci) > hi + n.body * 0.6) wall = true;
      else if (g.y[top] < lo - Math.max(2, n.body)) voids++;
    }
    const why = water ? 'water' : voids ? 'void' : rise > up ? 'cliff' : wall ? 'wall' : 'too far';
    const P3 = p => [p.x, p.y, p.z].map(v => +v.toFixed(2));
    return { from: P3(b), to: P3(a), across: +d.toFixed(2), rise: +rise.toFixed(2), why };
  }
  /** Usable places within `r` of P that a body standing there could touch P from (feet a little under it, or over). */
  function nodesNear(g, P, r) {
    const out = [], R = Math.ceil(r / g.cell), i0 = Math.floor((P.x - g.x0) / g.cell), j0 = Math.floor((P.z - g.z0) / g.cell);
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
      const ci = j * g.nx + i; if (hyp(xOf(g, ci) - P.x, zOf(g, ci) - P.z) > r + g.cell * 0.5) continue;
      for (let k = 0; k < g.cnt[ci]; k++) { const id = ci * L + k; if (!usable(g, id)) continue; const v = Number.isFinite(P.y) ? P.y - g.y[id] : 0; if (v >= -0.6 && v <= n.body + 0.3) out.push(id); }
    }
    return out;
  }
  /** Open ground round a place: every column within R cells has a usable surface no more than a step (or the walkable
   *  slope's rise over the distance: a hillside is open ground) above or below it. */
  function openRound(g, id, R) {
    const ci = Math.floor(id / L), i0 = ci % g.nx, j0 = Math.floor(ci / g.nx), y = g.y[id];
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return false;
      const c = j * g.nx + i, rise = Math.max(n.step, hyp(di, dj) * g.cell * tanSlope); let ok = false;
      for (let k = 0; k < g.cnt[c]; k++) { const b = c * L + k; if (Math.abs(g.y[b] - y) <= rise && usable(g, b)) { ok = true; break; } if (g.y[b] > y + rise && g.y[b] < y + n.body) break; }
      if (!ok) return false;
    }
    return true;
  }
  return api;
}

/**
 * A source over axis-aligned boxes ({min: [x, y, z], max: [x, y, z]}; the forge runtime's world: its ground is a box
 * too): the surfaces in a column are the tops of the boxes over it; a body fits on one when no box pokes into its
 * height within its radius. Pure: no physics. numbers: the movement numbers (step, body, radius).
 */
export function boxSurfaces({ boxes = [], numbers = {} }) {
  const n = { step: 0.45, body: 1.6, radius: 0.3, ...numbers }, r = n.radius * 0.9;
  const list = boxes.filter(b => Array.isArray(b?.min) && Array.isArray(b?.max));
  const over = (b, x, z, pad = 0) => x >= b.min[0] - pad && x <= b.max[0] + pad && z >= b.min[2] - pad && z <= b.max[2] + pad;
  const surfaces = (x, z) => list.filter(b => over(b, x, z)).map(b => {
    const y = b.max[1], poking = list.filter(o => o !== b && over(o, x, z, r) && o.max[1] > y + n.step && o.min[1] < y + n.body);
    return poking.length ? { y, ny: 1, fits: false, block: Math.max(...poking.map(o => o.max[1])) } : { y, ny: 1, fits: true };
  });
  // open air: inside no box (createWalk's source.open)
  surfaces.open = (x, y, z) => !list.some(b => over(b, x, z) && y > b.min[1] && y < b.max[1]);
  return surfaces;
}

