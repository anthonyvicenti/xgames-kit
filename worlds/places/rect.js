// The places vocabulary's words for a flat rectangle (open builder wave 10, track H): the standard-3d profile's outdoor worlds
// (arena, backyard, plaza; kit/world/from-yard.js turns a template into these steps) and any new place on a flat floor.
// Pure: no three.js, no DOM.
//
//   ground      rect (the play area, its ground and invisible walls; the fields a place carries as they are)
//   features    zones, spawns, gates (where the edge opens: the entries enemies and visitors come in by)
//   structures  edge (pieces all round, gaps only at the gates), rows (buildings closing a square), backdrop-ring
//               (things round the edge so the world goes on), climb (columns rising toward a goal, each rise and gap
//               sized by the character's own jump)
//   sizing      stretch (a place dressed by hand at one size made bigger), grow (the new floor dressed with groups)
//   dressing    place (placements as they are, e.g. a template's hand-dressed props)
// Gates name the way in a growing world keeps clear, so a recipe gives `gates` before `stretch` (from-yard.js does).
import { turn } from '../layout.js';
import { val, r2, norm, clone } from './values.js';

const sidesOf = (W, D) => ({ back: { axis: 'x', c: -D / 2, n: [0, -1], L: W }, front: { axis: 'x', c: D / 2, n: [0, 1], L: W }, left: { axis: 'z', c: -W / 2, n: [-1, 0], L: D }, right: { axis: 'z', c: W / 2, n: [1, 0], L: D } });
const gatesOf = (list, sd, width) => (Array.isArray(list) ? list : []).map(g => {
  const s = sd[g.side], u = r2((g.at ?? 0) * s.L / 2), w = g.width ?? width ?? 3;
  return { name: g.name, side: g.side, u, width: w, at: s.axis === 'x' ? [u, 0, s.c] : [s.c, 0, u], normal: s.n };
});
const overlaps = (a, b) => a[2] > b[0] && a[0] < b[2] && a[3] > b[1] && a[1] < b[3];

export const RECT_STEPS = {
  // ---------------- ground ----------------
  /** A flat rectangle: its size by class; `copy` holds the fields the place carries as they are (a template's label,
   *  words, ground, bounds, bench, gates), or `ground`, `bounds` and `bench` are given here. */
  rect(P, s) {
    const [W, D] = val(P, s.size);
    Object.assign(P.vars, { W, D });
    P.out = clone(s.copy ?? { template: P.recipe.place });
    if (s.ground) P.out.ground = clone(s.ground);
    if (s.bounds || !s.copy) P.out.bounds = clone(s.bounds ?? { walls: true, height: 4 });
    if (s.bench) P.out.bench = clone(s.bench);
    Object.assign(P.out, { kind: 'outdoor', sizeClass: P.size, size: [W, D], props: [], scatter: [], spawns: [], zones: {}, entries: [] });
    P.sides = sidesOf(W, D);
  },
  // ---------------- features ----------------
  zones(P, s) { Object.assign(P.out.zones, clone(s.zones ?? {})); },
  /** Spawns at given points, or round a ring (n points, radii taken in turn). */
  spawns(P, s) {
    if (s.at) { P.out.spawns = clone(s.at); return; }
    const { n, r, phase = 0 } = s.rings;
    P.out.spawns = Array.from({ length: n }, (_, k) => { const a = (k / n) * Math.PI * 2 + phase, rr = r[k % r.length]; return [r2(Math.sin(a) * rr), 0, r2(Math.cos(a) * rr)]; });
  },
  /** Where the rectangle's edge opens: each gate is an entry (where enemies and visitors come in) and a zone. `gates`
   *  may be per size; `width` is the default opening. */
  gates(P, s) {
    const out = P.out;
    P.gateSpec = { byClass: s.gates ?? {}, width: s.width };
    P.gates = gatesOf(val(P, s.gates), P.sides, s.width);
    P.inGate = (side, u, half) => P.gates.some(g => g.side === side && Math.abs(g.u - u) < g.width / 2 + half - 1e-6);
    out.entries = P.gates.map(g => ({ name: g.name, at: g.at, normal: g.normal, width: g.width }));
    P.gateZones = new Set();
    for (const g of P.gates) if (out.zones[g.name] === undefined || out.zones[g.name] === null) { out.zones[g.name] = { shape: 'circle', at: [r2(g.at[0] - g.normal[0] * 2), 0, r2(g.at[2] - g.normal[1] * 2)], size: [1.2] }; P.gateZones.add(g.name); }
  },
  // ---------------- dressing ----------------
  /** Placements as they are (a template's hand-dressed props), in order; `without` leaves out the props a size lays
   *  its own way (a row of houses), per size. */
  place(P, s) {
    const skip = new Set(val(P, s.without ?? []) ?? []);
    for (const p of s.list ?? []) if (!skip.has(p.prop)) P.out.props.push({ ...clone(p) });
  },
  // ---------------- sizing ----------------
  /**
   * A place dressed by hand at one size (`from`) made bigger. What stands near an old edge moves out with it (things
   * within 1.5 m of each other move together, by their middle); areas along an edge stretch; the scatter's area and the
   * far ground follow; things in the middle keep their place. A thing growing brings into a gate's way in (its opening
   * and 0.6 m a side, 3 m inward) steps aside along the edge, nearer side first, to where it touches nothing; with no
   * room either side it is left out, so a gate stays a way in (the places spike, wave 10). `footprints`: m per prop.
   */
  stretch(P, s) {
    const [W0, D0] = s.from, { W, D } = P.vars, dx = (W - W0) / 2, dz = (D - D0) / 2, band = s.band ?? 4, out = P.out;
    P.vars.W0 = W0; P.vars.D0 = D0;
    const move = (x, z) => [dx && Math.abs(x) > W0 / 2 - band ? x + Math.sign(x) * dx : x, dz && Math.abs(z) > D0 / 2 - band ? z + Math.sign(z) * dz : z];
    // the zones: an area along an edge stretches with it; a point moves (and is rounded to the centimetre at any size)
    const fixed = P.gateZones ?? new Set();
    out.zones = Object.fromEntries(Object.entries(out.zones).map(([n, z]) => {
      if (fixed.has(n)) return [n, z];                             // a gate's own zone is where the gate is now
      if (z.shape === 'box' && (dx || dz)) { const [cx, , cz] = z.at, [w, h, d] = z.size, [ax, az] = move(cx - w / 2, cz - d / 2), [bx, bz] = move(cx + w / 2, cz + d / 2); return [n, { ...z, at: [r2((ax + bx) / 2), z.at[1], r2((az + bz) / 2)], size: [r2(bx - ax), h, r2(bz - az)] }]; }
      const [x, zz] = move(z.at[0], z.at[2]); return [n, { ...z, at: [r2(x), z.at[1], r2(zz)] }];
    }));
    if (!dx && !dz) return;
    const kept = out.props, parent = kept.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const ground = kept.map(p => (p.at?.[1] ?? 0) <= 12);
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
      if (!ground[i] || !ground[j]) continue;
      if (Math.hypot(kept[i].at[0] - kept[j].at[0], kept[i].at[2] - kept[j].at[2]) <= 1.5) parent[find(i)] = find(j);
    }
    // the gates' ways in, at this size and in the hand layout (the small world's own gates keep what stands by them)
    const gates = P.gates ?? [], sides = P.sides, sides0 = sidesOf(W0, D0);
    const handGates = P.gateSpec ? gatesOf(val({ ...P, size: 'small' }, P.gateSpec.byClass), sides0, P.gateSpec.width) : [];
    const laneOf = (box, list, sd) => list.find(g => {
      const q = sd[g.side], along = q.axis === 'x' ? [box[0], box[2]] : [box[1], box[3]];
      const inward = q.axis === 'x' ? (q.c < 0 ? [box[1] - q.c, box[3] - q.c] : [q.c - box[3], q.c - box[1]]) : (q.c < 0 ? [box[0] - q.c, box[2] - q.c] : [q.c - box[2], q.c - box[0]]);
      return along[1] > g.u - g.width / 2 - 0.6 && along[0] < g.u + g.width / 2 + 0.6 && inward[1] > 0 && inward[0] < 3;
    });
    const fpAt = (p, sx = 0, sz = 0) => { const f = s.footprints?.[p.prop] ?? [1.2, 1.2]; return [p.at[0] + sx - f[0] / 2, p.at[2] + sz - f[1] / 2, p.at[0] + sx + f[0] / 2, p.at[2] + sz + f[1] / 2]; };
    const boxOf = (list, sx = 0, sz = 0) => list.map(p => fpAt(p, sx, sz)).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const shiftOf = new Map(), membersOf = new Map();
    for (let i = 0; i < kept.length; i++) {
      const r = find(i); if (shiftOf.has(r)) continue;
      const members = kept.filter((_, k) => find(k) === r);
      const cx = members.reduce((n, p) => n + p.at[0], 0) / members.length, cz = members.reduce((n, p) => n + p.at[2], 0) / members.length;
      const [mx, mz] = move(cx, cz);
      shiftOf.set(r, [mx - cx, mz - cz]);
      if (ground[i]) membersOf.set(r, members);
    }
    for (const [r, members] of membersOf) {
      const [sx, sz] = shiftOf.get(r);
      if (!sx && !sz) continue;
      const g = laneOf(boxOf(members, sx, sz), gates, sides);
      if (!g || laneOf(boxOf(members), handGates, sides0)) continue;
      const b = boxOf(members, sx, sz), axisX = sides[g.side].axis === 'x';
      const [lo, hi] = axisX ? [b[0], b[2]] : [b[1], b[3]], mid = (lo + hi) / 2, half = (hi - lo) / 2;
      const others = [...membersOf].filter(([k]) => k !== r && shiftOf.get(k)).map(([k, m]) => boxOf(m, ...shiftOf.get(k)));
      const first = mid >= g.u ? 1 : -1;
      let best = null;
      for (let step = 0; step <= 6 && !best; step++) for (const k of [first, -first]) {
        const to = g.u + k * (g.width / 2 + 0.6 + half + 0.05 + step * 0.5);
        const t = axisX ? [sx + to - mid, sz] : [sx, sz + to - mid], nb = boxOf(members, ...t);
        if (!others.some(o => overlaps(nb, o)) && !laneOf(nb, gates, sides)) { best = t; break; }
      }
      shiftOf.set(r, best);
    }
    out.props = kept.map((p, i) => {
      if (!ground[i]) return { ...p };
      const shift = shiftOf.get(find(i));
      if (!shift) return null;                                   // no room beside the gate it would stand in
      return { ...p, at: [r2(p.at[0] + shift[0]), p.at[1] ?? 0, r2(p.at[2] + shift[1])] };
    }).filter(Boolean);
    out.scatter = out.scatter.map(q => { const [a, b] = move(q.area[0], q.area[1]), [c, d] = move(q.area[2], q.area[3]); return { ...q, area: [r2(a), r2(b), r2(c), r2(d)], clear: (q.clear ?? []).map(([x, z, r]) => [...move(x, z).map(r2), r]) }; });
    if (out.ground?.outerSize) out.ground = { ...out.ground, outerSize: out.ground.outerSize + Math.max(dx, dz) * 2 };
  },
  // ---------------- structures ----------------
  /** Pieces all round the rectangle, gaps only at the gates (given here, or by a gates step before). */
  edge(P, s) {
    if (s.gates || !P.gates) RECT_STEPS.gates(P, s);
    const { W, D } = P.vars, out = P.out, gates = P.gates, inGate = P.inGate;
    for (const [name, sd] of Object.entries(P.sides)) {
      const count = Math.max(1, Math.round(sd.L / s.length)), step = sd.L / count, scale = r2(step / s.length);
      const rot = (sd.axis === 'x' ? 0 : 90) + (s.faceIn && (name === 'front' || name === 'right') ? 180 : 0) + (s.turn ?? 0);
      for (let i = 0; i < count; i++) {
        const u = -sd.L / 2 + step * (i + 0.5);
        if (inGate(name, u, step / 2)) continue;
        const at = sd.axis === 'x' ? [u, 0, sd.c + (s.inset ?? 0) * -sd.n[1]] : [sd.c + (s.inset ?? 0) * -sd.n[0], 0, u];
        const sc = s.stretch === false ? (s.scale ?? 1) : [r2(scale * (s.scale ?? 1)), s.scale ?? 1, s.scale ?? 1];
        out.props.push({ prop: s.piece, at: at.map(r2), rot: norm(rot), scale: sc });
      }
    }
    if (s.corner) for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) out.props.push({ prop: s.corner, at: [r2(x), 0, r2(z)], rot: 0, scale: s.cornerScale ?? s.scale ?? 1 });
    if (s.gatePosts) for (const g of gates) for (const k of [-1, 1]) {
      const sd = P.sides[g.side], u = g.u + k * (g.width / 2 + (s.postHalf ?? 0.6));
      out.props.push({ prop: s.gatePosts, at: (sd.axis === 'x' ? [u, 0, sd.c] : [sd.c, 0, u]).map(r2), rot: 0, scale: s.cornerScale ?? s.scale ?? 1 });
    }
  },
  /** Rows of buildings along every side, fronts to the middle, broken only at the gates (a square closed by houses).
   *  A row fills the stretch up to the next gate with a building that fits there; it carries on past the gate only when
   *  none does (the places spike found rows that skipped to the gate and left 3-8 m of the edge open). */
  rows(P, s) {
    const { W, D } = P.vars, out = P.out, sizes = s.sizes ?? {}, R = P.R, gates = P.gates ?? [];
    P.outside ??= [];
    const pick = list => list[Math.floor(R() * list.length)], [s0, s1] = s.spacing ?? [0.4, 1.6];
    for (const [name, sd] of Object.entries(P.sides)) {
      // the rows on the back and front run on past the corners; the side rows stop at them, so the corners never overlap
      const over = sd.axis === 'x' ? (s.overhang ?? 4) : 0;
      let at = -sd.L / 2 - over;
      const end = sd.L / 2 + over;
      for (let guard = 0; guard < 40 && at < end - 3; guard++) {
        const g = gates.filter(q => q.side === name && q.u + q.width / 2 + 0.2 > at).sort((a, b) => a.u - b.u)[0];
        const stop = g ? g.u - g.width / 2 - 0.2 : Infinity;
        if (g && at >= stop) { at = g.u + g.width / 2 + 0.2; continue; }
        const fits = s.buildings.filter(id => at + (sizes[id]?.[0] ?? 8) <= Math.min(end + 0.5, stop));
        if (!fits.length) { if (g && stop < end) { at = g.u + g.width / 2 + 0.2; continue; } break; }
        const id = pick(fits), [w, d] = sizes[id] ?? [8, 8], u = at + w / 2;
        const pos = sd.axis === 'x' ? [u, 0, Math.sign(sd.c) * (D / 2 + d / 2 + (s.gap ?? 0.5))] : [Math.sign(sd.c) * (W / 2 + d / 2 + (s.gap ?? 0.5)), 0, u];
        const rot = name === 'back' ? 0 : name === 'front' ? 180 : name === 'left' ? 90 : 270;   // fronts to the square
        out.props.push({ prop: id, at: pos.map(r2), rot, scale: 1 });
        const ext = sd.axis === 'x' ? [w, d] : [d, w];
        P.outside.push([pos[0] - ext[0] / 2, pos[2] - ext[1] / 2, pos[0] + ext[0] / 2, pos[2] + ext[1] / 2]);
        at += w + s0 + R() * (s1 - s0);
      }
    }
  },
  /** A ring of things round the rectangle's edge, so the world goes on past it; never over what already stands outside
   *  (one list, kept across rings), never in front of a gate. */
  'backdrop-ring'(P, s) {
    const { W, D } = P.vars, out = P.out, sizes = s.sizes ?? {}, R = P.R, gates = P.gates ?? [];
    P.outside ??= [];
    if (!P.outsideSeen) {                                        // what already stands outside (houses, the old trees)
      P.outsideSeen = true;
      for (const p of out.props) {
        if (Math.abs(p.at[0]) <= W / 2 + 0.5 && Math.abs(p.at[2]) <= D / 2 + 0.5) continue;
        const sz = sizes[p.prop] ?? [2, 2];
        P.outside.push([p.at[0] - sz[0] / 2, p.at[2] - sz[1] / 2, p.at[0] + sz[0] / 2, p.at[2] + sz[1] / 2]);
      }
    }
    const outside = P.outside, pick = list => list[Math.floor(R() * list.length)], [d0, d1] = s.distance ?? [5, 12];
    for (const sd of Object.values(P.sides)) {
      for (let u = -sd.L / 2 - d0; u <= sd.L / 2 + d0; u += s.spacing ?? 6) {
        const d = d0 + R() * (d1 - d0), j = (R() - 0.5) * (s.jitter ?? 2);
        const pos = sd.axis === 'x' ? [u + j, 0, Math.sign(sd.c) * (D / 2 + d)] : [Math.sign(sd.c) * (W / 2 + d), 0, u + j];
        const id = pick(s.props), [w, dd] = sizes[id] ?? [2, 2];
        const q = [pos[0] - w / 2 - 0.5, pos[2] - dd / 2 - 0.5, pos[0] + w / 2 + 0.5, pos[2] + dd / 2 + 0.5];
        if (outside.some(r => q[2] > r[0] && q[0] < r[2] && q[3] > r[1] && q[1] < r[3])) continue;
        if (gates.some(g => Math.hypot(g.at[0] - pos[0], g.at[2] - pos[2]) < g.width + 2)) continue;   // keep the way in clear
        outside.push(q);
        out.props.push({ prop: id, at: pos.map(r2), rot: Math.floor(R() * 360), scale: 1 });
      }
    }
  },
  /** The new floor a bigger size added (the band along the old edges), dressed with groups; each may name a zone. */
  grow(P, s) {
    const { W, D } = P.vars, W0 = P.vars.W0 ?? W, D0 = P.vars.D0 ?? D, band = s.band ?? 4, out = P.out, R = P.R, gates = P.gates ?? [];
    const occupied = [], fpOf = p => { const f = s.footprints?.[p.prop] ?? [1.2, 1.2]; return [p.at[0] - f[0] / 2, p.at[2] - f[1] / 2, p.at[0] + f[0] / 2, p.at[2] + f[1] / 2]; };
    for (const p of out.props) if (Math.abs(p.at[0]) < W / 2 + 1 && Math.abs(p.at[2]) < D / 2 + 1 && (p.at[1] ?? 0) < 12) occupied.push(fpOf(p));
    for (const q of out.spawns) occupied.push([q[0] - 1.6, q[2] - 1.6, q[0] + 1.6, q[2] + 1.6]);
    for (const z of Object.values(out.zones)) if (z.shape === 'circle') occupied.push([z.at[0] - z.size[0] - 0.8, z.at[2] - z.size[0] - 0.8, z.at[0] + z.size[0] + 0.8, z.at[2] + z.size[0] + 0.8]);
    for (const g of gates) occupied.push([g.at[0] - g.width / 2 - 1.5 - Math.abs(g.normal[0]) * 3, g.at[2] - g.width / 2 - 1.5 - Math.abs(g.normal[1]) * 3, g.at[0] + g.width / 2 + 1.5 + Math.abs(g.normal[0]) * 3, g.at[2] + g.width / 2 + 1.5 + Math.abs(g.normal[1]) * 3]);
    const free = q => occupied.every(r => q[2] <= r[0] || q[0] >= r[2] || q[3] <= r[1] || q[1] >= r[3]);
    const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    for (const f of val(P, s.per) ?? []) {
      const g = s.groups?.[f.group]; if (!g) continue;
      let n = 0; const want = f.count ?? 1, m = f.margin ?? 2.5, spotsHere = [];
      for (let x = -W / 2 + m; x <= W / 2 - m; x += 1) for (let z = -D / 2 + m; z <= D / 2 - m; z += 1) {
        const inBand = Math.abs(x) > W0 / 2 - band || Math.abs(z) > D0 / 2 - band, nearEdge = Math.min(W / 2 - Math.abs(x), D / 2 - Math.abs(z)) < (f.edge ?? 99);
        if ((f.where === 'band' ? inBand : true) && nearEdge) spotsHere.push([x, z]);
      }
      for (const [x, z] of shuffle(spotsHere)) {
        if (n >= want) break;
        // facing: toward the middle (seats and stalls look inward), or its back to the nearest edge
        const yaw = f.face === 'none' ? 0 : f.face === 'edge' ? (Math.abs(x) / W > Math.abs(z) / D ? (x < 0 ? 90 : 270) : (z < 0 ? 0 : 180)) : norm(Math.round(Math.atan2(-x, -z) * 180 / Math.PI / 15) * 15);
        // a group turned off the axes takes the square round it
        const ext = norm(yaw) % 90 !== 0 ? [Math.max(...g.size), Math.max(...g.size)] : norm(yaw) % 180 === 0 ? g.size : [g.size[1], g.size[0]];
        const gap = f.gap ?? 1, q = [x - ext[0] / 2 - gap, z - ext[1] / 2 - gap, x + ext[0] / 2 + gap, z + ext[1] / 2 + gap];
        if (!free(q)) continue;
        occupied.push(q); n++;
        for (const it of g.props) { const [lx, lz] = turn(it.at[0], it.at[2], yaw); out.props.push({ prop: it.prop, at: [r2(x + lx), r2(it.at[1] ?? 0), r2(z + lz)], rot: norm((it.rot ?? 0) + yaw), scale: it.scale ?? 1 }); }
        if (f.zone) out.zones[n > 1 ? `${f.zone}-${n}` : f.zone] = { shape: 'box', at: [r2(x), 0, r2(z)], size: [r2(ext[0] + 1), 3, r2(ext[1] + 1)] };
      }
    }
  },
  /**
   * Columns that climb from a start toward a goal, each one rise higher than the last and one gap further round, the
   * rise and the gap sized from the character's own jump (jumpUp, jumpAcross: kit/world/reach.js reachNumbers). A
   * climb asked to rise more than the jump is refused here, at the call; reach.js still proves the whole place.
   *   { piece, footprint (m), height (m, one piece), start (degrees round the middle), turn (1 | -1), radius, count,
   *     rise, gap, goal: {base, baseHeight, prop, scale, zone, zoneRadius, at} }
   * Each column is whole pieces stacked (the lowest sunk into the ground when the top is not a whole number of them).
   */
  climb(P, s) {
    const rise = val(P, s.rise), gap = val(P, s.gap), r = val(P, s.radius), out = P.out, foot = s.footprint, H = s.height;
    if (!(rise > 0)) throw new Error(`places: climb: the rise is ${rise} m (the character's jump, ${P.vars.jumpUp} m, is shorter than one ${s.piece} of ${H} m)`);
    if (P.vars.jumpUp !== undefined && rise > P.vars.jumpUp + 1e-9) throw new Error(`places: climb: a rise of ${rise} m is more than the character's jump (${P.vars.jumpUp} m)`);
    const column = (prop, x, z, top, h) => { for (let y = top - h; y > -h + 1e-6; y -= h) out.props.push({ prop, at: [x, r2(Math.max(0, y)), z], rot: 0, scale: 1 }); };
    let top = 0, a = (s.start ?? 0) * Math.PI / 180;
    for (let i = 0; i < s.count; i++) {
      top = r2(top + rise);
      const x = r2(Math.sin(a) * r), z = r2(Math.cos(a) * r);
      column(s.piece, x, z, top, H);
      a += ((foot + gap) / r) * (s.turn ?? 1);   // the next column: one footprint and one gap further round
    }
    if (!s.goal) return;
    // the goal stands on a wider column in the middle, one rise above the last step
    const summit = r2(top + rise), g = s.goal, [gx, gz] = g.at ?? [0, 0];
    column(g.base, gx, gz, summit, g.baseHeight);
    if (g.prop) out.props.push({ prop: g.prop, at: [gx, summit, gz], rot: 0, scale: g.scale ?? 1 });
    out.zones[g.zone] = { shape: 'circle', at: [gx, summit, gz], size: [g.zoneRadius ?? 1.5] };
  },
};
