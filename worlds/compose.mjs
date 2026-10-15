// Level composition (looks wave 4, 2026-10-14): the landmarks ARE the playfield. A look target says what the play happens
// on (look.target world.composition: the main landmarks, whether play is on them, around them, across bridges between
// landmasses or with them behind the action, how much of a gameplay frame they take, how vertical play is), and a world
// that composes (worlds/terrain/compose.mjs: the terrain world; worlds/sea-compose.mjs: sea-islands) places the set
// pieces as ground, bridges between its landmasses, and the seats with sight of each other and of a landmark. This file
// is the pure part every composer, the camera rig and the look judge's sheet share: where the play camera stands, how
// much of its frame a piece takes, which way a seat faces so its partner and the landmark are both in view, and how
// the camera leans toward a landmark that is in view.
//
//   COMPOSE_DEFAULTS                                  what a composition asks when the target leaves a part out
//   viewOf(seat, yaw, camera)                         → {eye, target, fov, aspect}: the third-person play camera there
//   coverage(tris, view, {cols, rows})                → share of the frame the triangles cover (their silhouette)
//   boxShare(box, view)                               → share of the frame a box's projection covers (a quick bound)
//   framedYaw(seat, partner, mark, camera)            → the seat's yaw: toward the partner, turned so the mark is in frame
//   inView(view, point, margin)                       → is the point inside the frame
//   leanToward(eye, target, marks, opts)              → the camera's look point leaned toward a landmark in view
//
// Yaw convention (the kit's): forward = (sin yaw, 0, cos yaw).

export const COMPOSE_DEFAULTS = {
  playOn: 'around',     // on | around | across | behind | open
  share: 0.22,          // the share of a gameplay frame the main landmark's silhouette takes at play distance
  verticality: 0.5,     // 0 flat play … 1 towers, ledges and drops
  bridges: 1,           // bridges between landmasses (a level that has them)
  camera: { distance: 5.2, height: 1.7, pitchDeg: 16, fov: 60, aspect: 16 / 9 },
};
/** How far the camera leans toward a landmark in view: a share of the angle, at most `max` degrees. */
export const LEAN = { bias: 0.22, max: 8, cone: 1.15 };

const DEG = Math.PI / 180;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/** The horizontal field of view (radians) of a camera with a vertical `fov` (degrees) and an aspect. */
export const hfovOf = (fov = 60, aspect = 16 / 9) => 2 * Math.atan(Math.tan(fov * DEG / 2) * aspect);

/** The third-person play camera behind a seat facing `yaw` (the rig's numbers): → {eye, target, fov, aspect}. */
export function viewOf(seat, yaw, camera = {}) {
  const C = { ...COMPOSE_DEFAULTS.camera, ...camera }, p = (C.pitchDeg ?? 16) * DEG;
  const pivot = [seat.x, seat.y + C.height, seat.z], f = [Math.sin(yaw), Math.cos(yaw)];
  const eye = [pivot[0] - f[0] * Math.cos(p) * C.distance, pivot[1] + Math.sin(p) * C.distance, pivot[2] - f[1] * Math.cos(p) * C.distance];
  return { eye, target: pivot, fov: C.fov, aspect: C.aspect ?? 16 / 9 };
}

/** A view's basis: forward, right and up unit vectors. */
function basis(view) {
  const f = norm(sub(view.target, view.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  return { f, r, u, tv: Math.tan(view.fov * DEG / 2), th: Math.tan(view.fov * DEG / 2) * (view.aspect ?? 16 / 9) };
}
/** A point in the view's normalised frame: [x, y] in −1…1 across it, and its depth (≤ 0: behind the camera). */
function project(B, eye, p) {
  const d = sub(p, eye), z = dot(d, B.f);
  return [dot(d, B.r) / (Math.max(z, 1e-3) * B.th), dot(d, B.u) / (Math.max(z, 1e-3) * B.tv), z];
}

/** A point in the frame: [x, y] from −1 to 1 across it (y up), and its depth in front of the camera (≤ 0: behind). */
export function ndcOf(view, point) { return project(basis(view), view.eye, point); }

/** Is the point inside the frame (by `margin`, a share of the half frame)? */
export function inView(view, point, margin = 0) {
  const B = basis(view), [x, y, z] = project(B, view.eye, point);
  return z > 0.1 && Math.abs(x) <= 1 - margin && Math.abs(y) <= 1 - margin;
}

/** The share of the frame a box's projected outline covers (a bound on its silhouette; corners behind the camera clip). */
export function boxShare(box, view) {
  const B = basis(view);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, front = 0;
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? box.max[0] : box.min[0], c & 2 ? box.max[1] : box.min[1], c & 4 ? box.max[2] : box.min[2]];
    const [x, y, z] = project(B, view.eye, p);
    if (z <= 0.1) continue;
    front++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (!front) return 0;
  const w = Math.max(0, Math.min(1, x1) - Math.max(-1, x0)), h = Math.max(0, Math.min(1, y1) - Math.max(-1, y0));
  return (w * h) / 4;
}

/**
 * The share of the frame the triangles cover: each triangle's projection filled into a coarse grid (cols × rows cells
 * of the frame), what is behind the camera left out. Nothing in front of the piece is counted (a hill in the way): the
 * composers check sight separately.
 */
export function coverage(tris, view, { cols = 64, rows = 36 } = {}) {
  const B = basis(view), grid = new Uint8Array(cols * rows), e = view.eye;
  const P = new Float64Array(6);
  for (let o = 0; o < tris.length; o += 9) {
    let behind = false;
    for (let v = 0; v < 3; v++) {
      const [x, y, z] = project(B, e, [tris[o + v * 3], tris[o + v * 3 + 1], tris[o + v * 3 + 2]]);
      if (z <= 0.1) { behind = true; break; }
      P[v * 2] = (x + 1) / 2 * cols; P[v * 2 + 1] = (1 - y) / 2 * rows;
    }
    if (behind) continue;
    const xs = [P[0], P[2], P[4]], ys = [P[1], P[3], P[5]];
    const c0 = Math.max(0, Math.floor(Math.min(...xs))), c1 = Math.min(cols - 1, Math.floor(Math.max(...xs)));
    const r0 = Math.max(0, Math.floor(Math.min(...ys))), r1 = Math.min(rows - 1, Math.floor(Math.max(...ys)));
    if (c0 > c1 || r0 > r1) continue;
    const area = (P[2] - P[0]) * (P[5] - P[1]) - (P[4] - P[0]) * (P[3] - P[1]);
    if (area === 0) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (grid[r * cols + c]) continue;
      const px = c + 0.5, py = r + 0.5;
      const w0 = (P[2] - P[0]) * (py - P[1]) - (P[3] - P[1]) * (px - P[0]);
      const w1 = (P[4] - P[2]) * (py - P[3]) - (P[5] - P[3]) * (px - P[2]);
      const w2 = (P[0] - P[4]) * (py - P[5]) - (P[1] - P[5]) * (px - P[4]);
      // a triangle smaller than a cell still marks the cell it sits in
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0) || (c0 === c1 && r0 === r1)) grid[r * cols + c] = 1;
    }
  }
  let n = 0; for (const g of grid) n += g;
  return n / grid.length;
}

/**
 * A seat's yaw: toward its partner (the action in the middle of the frame), turned toward the landmark so it is in the
 * frame too; when they cannot both be in view the partner wins and the turn goes as far as keeps them. mark: {x, z}
 * (its middle); partner may be null (then toward the mark). → radians
 */
export function framedYaw(seat, partner, mark, camera = {}) {
  const C = { ...COMPOSE_DEFAULTS.camera, ...camera };
  const toP = partner ? Math.atan2(partner.x - seat.x, partner.z - seat.z) : null;
  const toM = mark ? Math.atan2(mark.x - seat.x, mark.z - seat.z) : null;
  if (toP == null) return toM ?? 0;
  if (toM == null) return toP;
  const half = hfovOf(C.fov, C.aspect) / 2, usable = Math.max(0.1, half - 12 * DEG), diff = wrap(toM - toP);
  // the partner a little off the middle toward one side, the landmark toward the other: both inside the usable frame
  const turnBy = Math.max(-usable * 0.6, Math.min(usable * 0.6, diff * 0.55));
  return wrap(toP + turnBy);
}

/**
 * The camera's look point leaned toward a landmark in view: when a landmark's middle is within `cone` × the half frame
 * of where the camera looks, the look direction turns toward it by `bias` of the angle, at most `max` degrees. The
 * player's own yaw and pitch are untouched (this is an offset), so they can still turn the camera anywhere.
 * marks: [{centre: [x, y, z]}]; → [x, y, z] (the look point at the same distance)
 */
export function leanToward(eye, target, marks, { fov = 60, aspect = 16 / 9, bias = LEAN.bias, max = LEAN.max, cone = LEAN.cone } = {}) {
  if (!marks?.length || !(bias > 0)) return target;
  const d0 = sub(target, eye), len = Math.hypot(...d0);
  if (!(len > 1e-6)) return target;
  const f = d0.map(v => v / len), half = hfovOf(fov, aspect) / 2;
  let best = null, bestAng = Infinity;
  for (const m of marks) {
    const c = m.centre ?? m.at; if (!c) continue;
    const u = norm(sub(c, eye)), ang = Math.acos(Math.max(-1, Math.min(1, dot(f, u))));
    if (ang < half * cone && ang < bestAng) { best = u; bestAng = ang; }
  }
  if (!best || bestAng < 1e-4) return target;
  const turn = Math.min(bestAng * bias, max * DEG), t = turn / bestAng;
  const dir = norm([f[0] + (best[0] - f[0]) * t, f[1] + (best[1] - f[1]) * t, f[2] + (best[2] - f[2]) * t]);
  return [eye[0] + dir[0] * len, eye[1] + dir[1] * len, eye[2] + dir[2] * len];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
