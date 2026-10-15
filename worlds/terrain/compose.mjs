// gf-three smooth terrain: the level composer (looks wave 4, 2026-10-14). The landmarks are the playfield: you fight on
// the fortress, across the bridge, around the castle. Given the generated land, the set pieces' shapes and a composition
// (a look target's world.composition, written by builder/look/world.mjs terrainParams into terrain.compose), it
//
//   1. stands the main landmark near the middle of the main island, levelled under its footprint and scaled so that,
//      from the play camera at a seat's distance, it fills the share of the frame the target asks (worlds/compose.mjs
//      coverage); the other landmarks crown the other islands;
//   2. spans bridges from the main island to its neighbours, rim to rim at the narrowest place, their ends levelled;
//   3. joins every piece into the field as ground (piece.mjs): standable, carved by the same edits as the land;
//   4. seats the players in pairs on level pads (generate.mjs levelDisc, never cutting into a piece): each pair in sight
//      of each other and of a landmark, at the play distance from it ('around'), on it ('on'), at the two ends of a
//      bridge ('across'), or with it behind the partner ('behind'); each seat's yaw faces its partner, turned so the
//      landmark is in the frame (worlds/compose.mjs framedYaw).
//
//   composeTerrain(field, P, islands, pieces, {own, levelDisc}) → {landmarks, seats, report}
//     P.compose: {landmarks: [id], bridges: [id], playOn, share, verticality, bridgeCount, camera, seats}
//     pieces: {id: {tris: Float32Array (its model's triangles, metres, feet at y = 0)}}
//
// Pure and deterministic over the field and the pieces' triangles (the same on every copy: the host owns no part of it).
import { unionPiece, placeTriangles, boundsOf } from './piece.mjs';
import { COMPOSE_DEFAULTS, coverage, boxShare, viewOf, framedYaw, hfovOf, leanToward, ndcOf } from '../compose.mjs';
import { mulberry32 } from '../voxel/noise.mjs';

const DEG = Math.PI / 180;
const r2 = v => Math.round(v * 100) / 100;
const q6 = v => Math.round(v * 1e6) / 1e6;
// sines and cosines rounded to a millionth, so every copy samples the same places (the last bit of Math.sin differs
// between engines; these tables never do)
const RING12 = Array.from({ length: 12 }, (_, k) => [q6(Math.cos(k * 30 * Math.PI / 180)), q6(Math.sin(k * 30 * Math.PI / 180))]);
const FAN = Array.from({ length: 13 }, (_, k) => [q6(Math.cos((k - 6) * 5 * Math.PI / 180)), q6(Math.sin((k - 6) * 5 * Math.PI / 180))]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const BRIDGE = /bridge/;

/** A piece's facts in its own frame: size, footprint radius, long axis (bridges). */
export function pieceFacts(tris) {
  const B = boundsOf(tris);
  return { bounds: B, size: B.size, foot: Math.hypot(B.size[0], B.size[2]) / 2, long: B.size[0] >= B.size[2] ? 0 : 2 };
}

/** The ground's top under (x, z) and whether it is a piece's (own: the owner mask). */
function topOf(field, own, x, z) {
  const y = field.heightAt(x, z);
  if (y == null) return { y: null, owner: 0 };
  if (!own) return { y, owner: 0 };
  const h = field.cell, i = Math.round((x - field.origin[0]) / h), k = Math.round((z - field.origin[2]) / h), j = Math.floor((y - 0.1 - field.origin[1]) / h);
  const a = (j * field.nz + k) * field.nx + i;
  return { y, owner: a >= 0 && a < own.length ? own[a] : 0 };
}

/** Can an eye at p see the point q (nothing of the field in between)? Optionally: the first thing hit is inside `box`. */
function sees(field, p, q, box = null) {
  const a = [p.x, p.y + 1.5, p.z], dir = [q[0] - a[0], q[1] - a[1], q[2] - a[2]], d = Math.hypot(...dir);
  const hit = field.raycast(a, dir, d);
  if (!hit || hit.distance > d - 0.6) return true;
  if (!box) return false;
  const [x, y, z] = hit.point, m = 0.6;
  return x > box.min[0] - m && x < box.max[0] + m && y > box.min[1] - m && y < box.max[1] + m && z > box.min[2] - m && z < box.max[2] + m;
}

/** Seat to seat: eye to chest, both ways. */
const mutual = (field, a, b) => sees(field, a, [b.x, b.y + 1, b.z]) && sees(field, b, [a.x, a.y + 1, a.z]);

/**
 * Where a footprint of radius r stands best near (cx, cz), within `within` metres: the place whose ground under the
 * footprint is highest above the sea and most level. → {x, z, y (the footprint's middle height), spread} | null
 */
function siteNear(field, cx, cz, r, within, seaLevel) {
  let best = null;
  const step = Math.max(1, within / 5);
  for (let dz = -within; dz <= within + 1e-6; dz += step) for (let dx = -within; dx <= within + 1e-6; dx += step) {
    if (Math.hypot(dx, dz) > within) continue;
    const x = cx + dx, z = cz + dz, hs = [];
    for (const [c, s] of RING12) for (const q of [0.45, 0.9]) { const y = field.heightAt(x + c * r * q, z + s * r * q); hs.push(y == null ? -99 : y); }
    const c = field.heightAt(x, z); if (c == null) continue;
    hs.push(c); hs.sort((p, q) => p - q);
    if (hs[0] < seaLevel + 1) continue;
    const mid = hs[Math.floor(hs.length / 2)], spread = hs[hs.length - 1] - hs[0];
    const score = spread + Math.hypot(dx, dz) * 0.15 - mid * 0.05;
    if (!best || score < best.score) best = { x: r2(x), z: r2(z), y: r2(mid), spread, score };
  }
  return best;
}

/**
 * Rim points of an island toward a direction (ux, uz: a unit vector), in a fan of ±30 degrees: the last high-enough
 * ground walking out from its middle.
 */
function rimToward(field, isl, ux, uz, seaLevel, minH) {
  const out = [];
  for (const [fc, fs] of FAN) {
    const c = ux * fc - uz * fs, s = ux * fs + uz * fc;
    let last = null;
    for (let d = 2; d < isl.r * 1.8; d += 0.5) {
      const x = r2(isl.x + c * d), z = r2(isl.z + s * d), y = field.heightAt(x, z);
      if (y != null && y > seaLevel + minH) last = { x, z, y: r2(y) };
      else if (last) break;
    }
    if (last) out.push(last);
  }
  return out;
}

/**
 * The land's masses: columns of ground higher than the sea by 1.5 m on a 2 m grid, joined where they touch (4-way).
 * → [{x, z, r (the radius of a disc of its area), area, axis: [ax, az] (its long direction), cells}] biggest first
 */
export function landMasses(field, seaLevel = 0, step = 2) {
  const b = field.bounds, nx = Math.floor((b.max[0] - b.min[0]) / step), nz = Math.floor((b.max[2] - b.min[2]) / step);
  const land = new Uint8Array(nx * nz), id = new Int32Array(nx * nz).fill(-1), out = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { const y = field.heightAt(b.min[0] + (i + 0.5) * step, b.min[2] + (k + 0.5) * step); if (y != null && y > seaLevel + 1.5) land[k * nx + i] = 1; }
  for (let a = 0; a < land.length; a++) {
    if (!land[a] || id[a] >= 0) continue;
    const n = out.length, stack = [a], cells = []; id[a] = n;
    while (stack.length) {
      const c = stack.pop(), i = c % nx, k = (c - i) / nx; cells.push(c);
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue; const q = kk * nx + ii; if (land[q] && id[q] < 0) { id[q] = n; stack.push(q); } }
    }
    let sx = 0, sz = 0;
    const pts = cells.map(c => { const i = c % nx, k = (c - i) / nx; const x = b.min[0] + (i + 0.5) * step, z = b.min[2] + (k + 0.5) * step; sx += x; sz += z; return [x, z]; });
    const x = sx / pts.length, z = sz / pts.length;
    // the long direction: the larger eigenvector of the cells' spread
    let xx = 0, zz = 0, xz = 0; for (const [px, pz] of pts) { xx += (px - x) ** 2; zz += (pz - z) ** 2; xz += (px - x) * (pz - z); }
    const ang = 0.5 * Math.atan2(2 * xz, xx - zz), area = pts.length * step * step;
    out.push({ x: r2(x), z: r2(z), r: r2(Math.sqrt(area / Math.PI)), area, axis: [q6(Math.cos(ang)), q6(Math.sin(ang))], cells: pts.length });
  }
  return out.filter(m => m.area >= 60).sort((p, q) => q.area - p.area);
}

/**
 * A chasm across a landmass (a level that asks for bridges on one piece of land: a canyon split by a gorge): the ground
 * in a slab `width` m wide, `at` m along the mass's long direction from its middle, made air down to the sea's floor,
 * with rounded lips. Only + - * / on the field, so every copy cuts the same chasm.
 */
export function cutChasm(field, mass, { at = 0, width = 6 } = {}) {
  const { nx, ny, nz, d, cell: h, origin: O } = field, [ax, az] = mass.axis, half = width / 2;
  const cx = mass.x + ax * at, cz = mass.z + az * at;
  for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) {
    const x = O[0] + i * h, z = O[2] + k * h, s = (x - cx) * ax + (z - cz) * az;
    const out = half - (s < 0 ? -s : s);
    if (out < -3) continue;
    for (let j = 1; j < ny - 1; j++) {
      const a = (j * nz + k) * nx + i;
      const v = out > 4 ? 4 : out;
      if (v > d[a]) d[a] = Math.fround(v);
    }
  }
  return { at: [r2(cx), r2(cz)], width };
}

/**
 * A bridge piece from rim a to rim b ({x, y, z} each; d: the gap across): scaled and stretched along its length to reach
 * both rims, its ends on level ground (the rims levelled to the deck's foot a little way in, the higher one cut down and
 * ramped in, never filled), its long axis along the gap. → a landmark {id, prop, role: 'bridge', at, yaw, scale, tris,
 * facts, ends, gap} (not yet made ground) or {note} when the piece cannot reach. Used by the composer and by the
 * connectors (worlds/terrain/connect.mjs).
 */
export function spanBridge(field, pair, piece, { id, prop, own = null, levelDisc }) {
  const F = pieceFacts(piece.tris);
  const L0 = F.size[F.long], need = pair.d + 3.2;
  const k = r2(clamp(need / L0, 0.9, 1.5)), stretch = r2(clamp(need / (L0 * k), 1, 2.2));
  if (L0 * k * stretch < pair.d + 1) return { note: `the gap (${r2(pair.d)} m) is longer than ${prop} reaches` };
  const y = Math.min(pair.a.y, pair.b.y), dx = pair.b.x - pair.a.x, dz = pair.b.z - pair.a.z, len = Math.hypot(dx, dz);
  // its ends on level ground: the rims levelled to the deck's foot, a little way in from each edge
  const inA = { x: r2(pair.a.x - dx / len * 1.2), z: r2(pair.a.z - dz / len * 1.2) }, inB = { x: r2(pair.b.x + dx / len * 1.2), z: r2(pair.b.z + dz / len * 1.2) };
  // the higher rim is cut down to the deck's foot, ramped in over the blend (a step of a few metres at most)
  const ramp = 3 + Math.abs(pair.a.y - pair.b.y);
  levelDisc(field, { x: inA.x, y, z: inA.z }, 2.2, pair.a.y > y + 0.5 ? ramp : 3.5, own, { cutOnly: true });
  levelDisc(field, { x: inB.x, y, z: inB.z }, 2.2, pair.b.y > y + 0.5 ? ramp : 3.5, own, { cutOnly: true });
  // the model's long axis along the gap: +x turns to (cos yaw, −sin yaw), +z to (sin yaw, cos yaw)
  const yaw = Math.round((F.long === 0 ? Math.atan2(-dz, dx) : Math.atan2(dx, dz)) / DEG * 10) / 10;
  const scale = F.long === 0 ? [r2(k * stretch), k, k] : [k, k, r2(k * stretch)];
  const at = [r2((pair.a.x + pair.b.x) / 2), r2(y - 0.15), r2((pair.a.z + pair.b.z) / 2)];
  const tris = placeTriangles(piece.tris, { at, yaw, scale });
  return { id, prop, role: 'bridge', at, yaw, scale, tris, facts: F, ends: [[r2(inA.x), r2(y), r2(inA.z)], [r2(inB.x), r2(y), r2(inB.z)]], gap: r2(pair.d) };
}

/** A placed piece (a landmark or a bridge: {tris, role}) made ground in the field under `owner`: its box, centre, top. */
export function pieceGround(field, m, owner, own) {
  const u = unionPiece(field, m.tris, { owner, own, shell: m.role === 'bridge' ? field.cell * 0.7 : null });
  const B = boundsOf(m.tris);
  m.owner = owner; m.samples = u.samples;
  m.box = { min: B.min.map(r2), max: B.max.map(r2) };
  m.centre = [r2((B.min[0] + B.max[0]) / 2), r2(B.min[1] + (B.max[1] - B.min[1]) * 0.5), r2((B.min[2] + B.max[2]) / 2)];
  m.top = r2(B.max[1]);
  return m;
}

/**
 * Compose the level into the field. P: the generator's params (P.compose the composition, P.seed, P.cell); islands:
 * generate.mjs islandsOf; pieces: {id: {tris}}; own: the owner mask (Uint8Array, the field's length) to fill;
 * levelDisc(field, p, radius, blend, own): generate.mjs's. → {landmarks, seats, report}
 */
export function composeTerrain(field, P, islands, pieces, { own, levelDisc, seaLevel = 0 } = {}) {
  const C = { ...COMPOSE_DEFAULTS, ...(P.compose ?? {}) }, cam = { ...COMPOSE_DEFAULTS.camera, ...(C.camera ?? {}) };
  // the pieces are lists of ids (the defaults' `bridges` is a count: a composition that names no bridge has none)
  C.landmarks = Array.isArray(C.landmarks) ? C.landmarks : [];
  C.bridges = Array.isArray(C.bridges) ? C.bridges : [];
  const R = mulberry32(((P.seed ?? 1) * 40503 + 77) >>> 0);
  const report = { playOn: C.playOn, share: C.share, notes: [] };
  const has = id => pieces?.[id]?.tris?.length;
  const marks = (C.landmarks ?? []).filter(has), bridgeIds = (C.bridges ?? []).filter(has);
  for (const id of [...(C.landmarks ?? []), ...(C.bridges ?? [])]) if (!has(id)) report.notes.push(`no shape for ${id}: left out`);
  const landmarks = [];
  let owner = 0;
  // the landmasses as the ground has them (islands, or a shore: one mass); a level that wants bridges on one mass gets a
  // chasm cut across it, off the main landmark's side, as wide as its bridge spans
  let masses = landMasses(field, seaLevel);
  if (masses.length === 1 && bridgeIds.length && (C.bridgeCount ?? 1) > 0) {
    const m0 = masses[0], F = pieceFacts(pieces[bridgeIds[0]].tris), Fm = marks.length ? pieceFacts(pieces[marks[0]].tris) : null;
    const width = r2(clamp(F.size[F.long] * 1.15 - 2.5, 4, 10)), at = r2(clamp((Fm ? Fm.foot * 1.6 : 0) + width / 2 + 8, 8, m0.r * 0.9));
    const cut = cutChasm(field, m0, { at, width });
    report.chasm = cut;
    masses = landMasses(field, seaLevel);
  }
  // the main mass: a big one near the middle (islands: the middle island; a shore: the bigger side of a chasm)
  const big = masses.length ? masses[0].area : 0;
  const isles = masses.filter(m => m.area >= big * 0.3).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || b.area - a.area);
  const main = report.chasm ? masses[0] : isles[0];
  if (!main) return { landmarks, seats: [], report: { ...report, notes: [...report.notes, 'no land above the sea'] } };
  const others = masses.filter(m => m !== main).sort((a, b) => Math.hypot(a.x - main.x, a.z - main.z) - Math.hypot(b.x - main.x, b.z - main.z));
  report.masses = masses.map(m => ({ at: [m.x, m.z], r: m.r }));

  // ---- 1. the main landmark: its scale from the frame share at the play distance --------------------------------
  const place = (id, isl, { k, role = 'landmark', near = 0.3, plaza = 0 }) => {
    const F = pieceFacts(pieces[id].tris);
    const site = siteNear(field, isl.x, isl.z, F.foot * k * 0.85 + plaza * 0.5, isl.r * near, seaLevel);
    if (!site) { report.notes.push(`no level ground for ${id} on the island at ${r2(isl.x)}, ${r2(isl.z)}`); return null; }
    // its front faces the main island's middle (the other islands' pieces) or a seeded quarter turn (the main one)
    const yaw = isl === main ? Math.floor(R() * 4) * 90 : Math.round(Math.atan2(main.x - site.x, main.z - site.z) / DEG);
    // its footprint level, and round it a plaza at its foot to fight on (play on or around it)
    levelDisc(field, { x: site.x, y: site.y, z: site.z }, F.foot * k * 0.9 + plaza, 2.5, own);
    const at = [r2(site.x), r2(site.y - 0.2), r2(site.z)];
    const tris = placeTriangles(pieces[id].tris, { at, yaw, scale: k });
    return { id, prop: id, role, at, yaw, scale: [k, k, k], tris, facts: F };
  };
  const shareAt = (id, k, rho) => {
    // the piece seen straight on from a seat rho metres from its middle (on flat ground at its base), the camera leaning
    // toward it as the rig does; its top must be in the frame (a castle reads by its roofs) → the share, or −1
    const tris = placeTriangles(pieces[id].tris, { at: [0, 0, 0], yaw: 0, scale: k }), B = boundsOf(tris);
    const v = viewOf({ x: 0, y: 0, z: -rho }, 0, cam), mid = [(B.min[0] + B.max[0]) / 2, B.max[1] * 0.5, (B.min[2] + B.max[2]) / 2];
    v.target = leanToward(v.eye, v.target, [{ centre: mid }], { fov: cam.fov, aspect: cam.aspect });
    if (ndcOf(v, [mid[0], B.max[1], mid[2]])[1] > 1.02) return -1;
    return coverage(tris, v);
  };
  let mainMark = null;
  if (marks.length) {
    const id = marks[0], F = pieceFacts(pieces[id].tris);
    // the play distance: seats stand round it on the island, a few metres off its walls
    let best = null;
    // the box's roof: a piece taller than the room over the island is drawn whole but only part of it would be ground
    const roof = field.bounds.max[1] - 1.5 - (field.heightAt(main.x, main.z) ?? 0);
    // the scale and the seats' distance together: the share the target asks, the whole piece in view; nearer seats first
    for (let k = 0.8; k <= 2.61; k += 0.1) {
      if (F.foot * k > main.r * 0.62 || F.size[1] * k > roof) break;
      for (let rho = clamp(F.foot * k + 4, 6, 24); rho <= Math.max(F.foot * k + 4, main.r * 1.1) + 1e-6; rho += 1.5) {
        const s = shareAt(id, k, rho);
        if (s < 0) continue;
        // among equal shares the bigger piece further off (it reads as the place, not as a prop beside the seat)
        const err = Math.abs(s - C.share) + (2.6 - k) * 0.01;
        if (!best || err < best.err) best = { k: r2(k), rho: r2(rho), share: r2(s), err };
        break;
      }
    }
    best ??= { k: 0.8, rho: F.foot + 4, share: r2(shareAt(id, 0.8, F.foot + 4)) };
    report.scale = best.k; report.playDistance = best.rho; report.plannedShare = best.share;
    // a plaza at its foot out to the seats' ring (play on or around it); a backdrop keeps the land as it is
    const plaza = C.playOn === 'around' || C.playOn === 'on' ? clamp(best.rho - F.foot * best.k * 0.9 + 2, 4.5, 12) : 1.5;
    mainMark = place(id, main, { k: best.k, near: C.playOn === 'behind' ? 0.45 : 0.3, plaza });
    if (mainMark) landmarks.push(mainMark);
    // the others crown the other islands (a fortress across the water, a ruin on the next isle)
    marks.slice(1).forEach((mid, n) => {
      const isl = others[n]; if (!isl) { report.notes.push(`${mid}: no island left for it`); return; }
      const Fm = pieceFacts(pieces[mid].tris), k = r2(clamp(best.k * 0.9, 0.8, (isl.r * 0.55) / Fm.foot));
      const m = place(mid, isl, { k, plaza: 2.5 }); if (m) landmarks.push(m);
    });
  }

  // ---- 2. bridges from the main island to its nearest neighbours ------------------------------------------------
  const nB = Math.min(C.bridgeCount ?? C.bridgesCount ?? (bridgeIds.length ? 1 : 0), others.length, bridgeIds.length ? 9 : 0);
  for (let n = 0; n < nB; n++) {
    const isl = others[n], id = bridgeIds[n % bridgeIds.length];
    const gx = isl.x - main.x, gz = isl.z - main.z, gl = Math.sqrt(gx * gx + gz * gz) || 1;
    const A = rimToward(field, main, gx / gl, gz / gl, seaLevel, 1.5), B = rimToward(field, isl, -gx / gl, -gz / gl, seaLevel, 1.5);
    let pair = null;
    for (const a of A) for (const b of B) {
      const d = Math.hypot(a.x - b.x, a.z - b.z), dy = Math.abs(a.y - b.y);
      if (dy > 6) continue;
      const score = d + dy * 2;
      if (!pair || score < pair.score) pair = { a, b, d, score };
    }
    if (!pair) { report.notes.push(`bridge ${n + 1}: no rims level enough to join`); continue; }
    const m = spanBridge(field, pair, pieces[id], { id: `${id}#${n + 1}`, prop: id, own, levelDisc });
    if (m.note) { report.notes.push(`bridge ${n + 1}: ${m.note}`); continue; }
    landmarks.push(m);
  }

  // ---- 3. every piece made ground ------------------------------------------------------------------------------
  for (const m of landmarks) pieceGround(field, m, ++owner, own);

  // ---- 4. the seats ---------------------------------------------------------------------------------------------
  const seats = seatPairs(field, P, landmarks, { C, cam, own, levelDisc, seaLevel, main, report });
  report.seats = seats.map(s => ({ at: [s.x, s.y, s.z], yaw: r2(s.yaw), mark: s.mark ?? null, seesPartner: s.seesPartner, seesMark: s.seesMark, share: s.share }));
  return { landmarks: landmarks.map(({ tris, facts, ...m }) => m), seats, report, tris: new Map(landmarks.map(m => [m.owner, m.tris])) };
}

/**
 * The seats in pairs (0 and 1, 2 and 3, …): candidates on level, open ground (or a piece's flat top for 'on'), scored by
 * the composition; pairs that see each other and a landmark, each partner's yaw framing both; pads levelled under the
 * seats on the land (never cutting into a piece). → [{x, y, z, yaw, mark, seesPartner, seesMark, share}]
 */
function seatPairs(field, P, landmarks, { C, cam, own, levelDisc, seaLevel, main, report }) {
  const n = Math.max(2, C.seats ?? 8), b = field.bounds, h = field.cell;
  const marks = landmarks.filter(m => m.role === 'landmark'), bridges = landmarks.filter(m => m.role === 'bridge');
  const lead = marks[0] ?? bridges[0] ?? null;
  const want = report.playDistance ?? 10;
  // ---- candidates: level, open, above the sea; on land (or on a piece's top for 'on'), clear of the pieces' walls ----
  const cand = [];
  const step = 1.5;
  for (let z = b.min[2] + 3; z <= b.max[2] - 3; z += step) for (let x = b.min[0] + 3; x <= b.max[0] - 3; x += step) {
    const { y, owner } = topOf(field, own, x, z);
    if (y == null || y < seaLevel + 1.2) continue;
    const onPiece = owner > 0;
    if (onPiece && C.playOn !== 'on') continue;
    let ok = true;
    for (const [ox, oz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1], [0.8, 0.8], [-0.8, -0.8]]) { const q = field.heightAt(x + ox, z + oz); if (q == null || Math.abs(q - y) > (onPiece ? 0.35 : 0.8)) { ok = false; break; } }
    if (!ok || field.sample(x, y + 2.4, z) < 0.3) continue;
    // a seat on the land keeps off the pieces' feet (its pad never reaches them)
    if (!onPiece && landmarks.some(m => x > m.box.min[0] - 3 && x < m.box.max[0] + 3 && z > m.box.min[2] - 3 && z < m.box.max[2] + 3)) continue;
    cand.push({ x: r2(x), y: r2(y), z: r2(z), onPiece });
  }
  // each candidate's landmark: the nearest one it sees
  for (const c of cand) {
    let best = null;
    for (const m of [...marks, ...bridges]) {
      const d = Math.hypot(m.centre[0] - c.x, m.centre[2] - c.z);
      if (d > 40) continue;
      if (!(sees(field, c, m.centre, m.box) || sees(field, c, [m.centre[0], m.top - 0.5, m.centre[2]], m.box))) continue;
      if (!best || d < best.d) best = { m, d };
    }
    c.mark = best?.m ?? null; c.markD = best?.d ?? null;
    // the composition's wish for this candidate (lower is better)
    let s = c.mark ? 0 : 30;
    if (c.mark) {
      // nearer than the play distance costs twice as much as further (too near, its top leaves the frame)
      const off = c.markD < want ? (want - c.markD) * 2 : c.markD - want;
      if (C.playOn === 'on') s += c.onPiece ? 0 : 12 + off * 0.5;
      else if (C.playOn === 'across') { const end = bridges.flatMap(m => m.ends ?? []).reduce((a, e) => Math.min(a, Math.hypot(e[0] - c.x, e[2] - c.z)), Infinity); s += Math.min(20, end === Infinity ? 20 : Math.max(0, end - 3) * 0.8) + off * 0.2; }
      else if (C.playOn === 'behind') s += Math.abs(c.markD - want * 1.4) * 0.6;
      else s += off * 0.6;
    }
    c.score = s;
  }
  cand.sort((p, q) => p.score - q.score || p.x - q.x || p.z - q.z);
  const pool = cand.slice(0, 90), out = [], used = [];
  const free = c => used.every(u => Math.hypot(u.x - c.x, u.z - c.z) >= 5);
  const half = hfovOf(cam.fov, cam.aspect) / 2;
  const frames = (a, bb, m) => {
    // from a facing b, can the landmark be turned into the frame?
    if (!m) return false;
    const toP = Math.atan2(bb.x - a.x, bb.z - a.z), toM = Math.atan2(m.centre[0] - a.x, m.centre[2] - a.z);
    return Math.abs(Math.atan2(Math.sin(toM - toP), Math.cos(toM - toP))) < half * 1.35;
  };
  // nothing of the field (a landmark's wall, the land) between a seat's camera and the play: from the camera's eye to
  // its pivot over the seat, and on to the partner
  const camClear = (p, q, mk) => {
    const v = viewOf(p, framedYaw(p, q, mk ? { x: mk.centre[0], z: mk.centre[2] } : null, cam), cam);
    const ray = (from, to) => { const dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], d = Math.hypot(...dir); const hit = field.raycast(from, dir, d); return !hit || hit.distance > d - 0.3; };
    return ray(v.eye, v.target) && ray(v.eye, [q.x, q.y + 1, q.z]);
  };
  while (out.length + 1 < n) {
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i]; if (!free(a)) continue;
      for (let j = i + 1; j < pool.length; j++) {
        const c = pool[j]; if (!free(c)) continue;
        const d = Math.hypot(a.x - c.x, a.z - c.z);
        if (d < 9 || d > 34) continue;
        const m = a.mark ?? c.mark;
        let s = a.score + c.score + Math.abs(d - 18) * 0.3;
        if (!frames(a, c, a.mark ?? m) || !frames(c, a, c.mark ?? m)) s += 8;
        // how much of each one's frame its landmark takes, facing the partner as the seat will (a box's outline, about
        // twice a piece's silhouette)
        for (const [p, q] of [[a, c], [c, a]]) { const mk = p.mark ?? m; if (mk) s += Math.abs(boxShare(mk.box, viewOf(p, framedYaw(p, q, { x: mk.centre[0], z: mk.centre[2] }, cam), cam)) * 0.5 - C.share) * 25; }
        if (C.playOn === 'across' && bridges.length && sideOf(a, bridges) === sideOf(c, bridges)) s += 6;
        if (best && s >= best.s) continue;
        if (!mutual(field, a, c) || !camClear(a, c, a.mark ?? m) || !camClear(c, a, c.mark ?? m)) continue;
        best = { a, c, s };
      }
    }
    if (!best) break;
    out.push(best.a, best.c); used.push(best.a, best.c);
  }
  // a seat left over (or no pairs at all): the best single places left, facing their landmark
  for (const c of pool) { if (out.length >= n) break; if (free(c)) { out.push(c); used.push(c); } }
  if (out.length < n) report.notes.push(`${out.length} of ${n} seats found on level open ground`);
  // ---- pads under the seats on the land; yaws ----
  for (const s of out) if (!s.onPiece) levelDisc(field, { x: s.x, y: s.y, z: s.z }, 1.8, 2, own);
  const seated = out.map((s, i) => {
    const partner = out[i ^ 1] && (i ^ 1) < out.length ? out[i ^ 1] : null;
    const m = s.mark ?? lead, yaw = framedYaw(s, partner, m ? { x: m.centre[0], z: m.centre[2] } : null, cam);
    const y = r2((field.heightAt(s.x, s.z) ?? s.y) + 0.05);
    const share = m ? r2(coverage(m.tris ?? [], viewOf({ x: s.x, y, z: s.z }, yaw, cam))) : 0;
    return { x: s.x, y, z: s.z, yaw: Math.round(yaw * 1e4) / 1e4, mark: m?.id ?? null, seesPartner: partner ? mutual(field, s, partner) : null, seesMark: !!s.mark, share, onPiece: s.onPiece };
  });
  // the pairs round the main landmark first (the first seats are the first players'), the most of it in view first
  const pairs = [];
  for (let i = 0; i < seated.length; i += 2) pairs.push(seated.slice(i, i + 2));
  const rank = p => (p.some(s => s.mark === lead?.id) ? 0 : 1) * 10 - p.reduce((a, s) => a + s.share, 0) / p.length;
  return pairs.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).flatMap(x => x.p);
}

/** Which end of the nearest bridge a place is on (−1 or 1), or 0 with no bridge near. */
function sideOf(c, bridges) {
  let best = null;
  for (const m of bridges) for (const [k, e] of (m.ends ?? []).entries()) { const d = Math.hypot(e[0] - c.x, e[2] - c.z); if (!best || d < best.d) best = { d, side: k ? 1 : -1 }; }
  return best && best.d < 20 ? best.side : 0;
}
