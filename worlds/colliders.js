// One collider list (open builder wave 10, track H; the places spike's §6 step 2). Pure: no three.js, no DOM, no
// Rapier of its own. Both 3D profiles' world loaders build their physics from it, and the reach model (reach.js) and the
// tools read the same list, so what a check proves is what a player stands on.
//
//   collidersOf(layout, catalog, opts) → [{prop, tag, shape, position, rotationY, size?, radius?, height?, points?}]
//       a party layout (kit/world/world.js): the ground, every placement's catalog collider, the invisible walls;
//       opts.fit(id): the model's fit to its catalog size (1 for the library's own models)
//       a scenic layout (research/gf-scenic/kit/world/world.js; it has `levels`): each island's top (a convex hull of
//       its outline) and rim walls, or a dungeon's floors and walls; the catalog props and fixtures, the trees, the
//       crystals, the ruin structures; opts.has(id): whether the model loaded (a prop or a broad-leaved tree with no
//       model gets no collider)
//   buildColliders(RAPIER, world, list, materialOf, body?) → the Rapier colliders, each tagged `__gf = {tag}`;
//       materialOf(c) → {friction, groups} (each loader's own); body: the fixed body (else a new one)
//   MATERIALS.party | .scenic → each loader's materialOf
//   dungeonPieces(level) → a dungeon level's floors and wall segments (the scenic loader draws the walls)
//
// shape: box (size: full extents) | ramp (a wedge rising toward its local -z) | cylinder (radius, height; position its
// middle) | sphere (radius) | hull (points: x, y, z, ... in world space). position: the middle; rotationY: degrees
// about +y. prop: a catalog id, or '#ground', '#bounds', '#rim', '#wall', '#pillar', '#tree', '#crystal' for the
// world's own pieces (kit/mechanics/pickup and board read world.shapes in this form). tag: what the Rapier collider
// is tagged (`__gf.tag`): 'ground', 'bounds', 'rim', 'wall', 'pillar', 'crystal', 'tree:<kind>', 'prop:<id>'.
import { expandLayout, colliderParts } from './layout.js';
import { outlineRadius, walkRadius } from './places/shapes.js';
import { GROUPS, groups, WORLD_GROUPS } from '../core/util.js';

const DEG = Math.PI / 180;
// three.js r186's own arithmetic (Quaternion.setFromAxisAngle about +y, Vector3.applyQuaternion, Matrix4.compose and
// applyMatrix4), written out so the list is what the loaders built with three.js, to the last bit
function rotateY(v, angle) {
  const half = angle / 2, s = Math.sin(half), qx = 0 * s, qy = s, qz = 0 * s, qw = Math.cos(half);
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
}
function composeApply(at, deg, scale, v) {
  const half = (deg ?? 0) * DEG / 2, s = Math.sin(half), x = 0 * s, y = s, z = 0 * s, w = Math.cos(half);
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = typeof scale === 'number' ? [scale, scale, scale] : [scale?.[0] ?? 0, scale?.[1] ?? 0, scale?.[2] ?? 0];
  const e = [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, at?.[0] ?? 0, at?.[1] ?? 0, at?.[2] ?? 0, 1];
  const [px, py, pz] = v, k = 1 / (e[3] * px + e[7] * py + e[11] * pz + e[15]);
  return [(e[0] * px + e[4] * py + e[8] * pz + e[12]) * k, (e[1] * px + e[5] * py + e[9] * pz + e[13]) * k, (e[2] * px + e[6] * py + e[10] * pz + e[14]) * k];
}

// ------------------------------------------------------------------------------------------------------------ party
/** A placement's catalog collider part (kit/world/world.js colliderOf before wave 10, unchanged in what it gives). */
function partyCollider(id, c, p, fit) {
  const rot = Array.isArray(p.rot) ? p.rot[1] : (p.rot ?? 0);
  const sc = (Array.isArray(p.scale) ? p.scale : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1]).map(s => s * fit);
  const o = c.offset ?? [0, 0, 0], off = rotateY([o[0] * sc[0], o[1] * sc[1], o[2] * sc[2]], rot * DEG);
  const at = [(p.at?.[0] ?? 0) + off[0], (p.at?.[1] ?? 0) + off[1], (p.at?.[2] ?? 0) + off[2]];
  const base = { prop: id, tag: `prop:${id}`, position: at.map(n => +n.toFixed(3)), rotationY: rot };
  if (c.shape === 'box' || c.shape === 'ramp') return { ...base, shape: c.shape, size: c.size.map((n, i) => +(n * sc[i]).toFixed(3)) };
  if (c.shape === 'cylinder') return { ...base, shape: 'cylinder', radius: c.radius * Math.max(sc[0], sc[2]), height: c.height * sc[1] };
  if (c.shape === 'sphere') return { ...base, shape: 'sphere', radius: c.radius * Math.max(...sc) };
  return { ...base, shape: 'box', size: [1, 1, 1] };
}
function partyColliders(cfg, catalog, { fit = () => 1 } = {}) {
  const byId = new Map((catalog?.props ?? []).map(p => [p.id, p]));
  const size = cfg.size ?? [24, 24];
  const groups = new Map();
  for (const p of expandLayout(cfg)) { if (!groups.has(p.prop)) groups.set(p.prop, []); groups.get(p.prop).push(p); }
  const out = [{ prop: '#ground', tag: 'ground', shape: 'box', size: [size[0] + 40, 1, size[1] + 40], position: [0, -0.5, 0], rotationY: 0 }];
  // a composed level's landmark (worlds/sea-compose.mjs: collider 'mesh') is solid by its model's own triangles, which the
  // world builds when it has the model (kit/world/world.js): no catalog box over it
  for (const [id, list] of groups) { const meta = byId.get(id), f = fit(id) ?? 1; for (const p of list) if (p.collider !== 'mesh') for (const part of colliderParts(meta)) out.push(partyCollider(id, part, p, f)); }
  // a sea-islands world (sea.js): each hill of the play island that reaches the play area is a hull of its dome, so a
  // player walks up what they see (the flat middle is the ground box)
  const main = (cfg.islands ?? []).find(i => i.play);
  for (const h of main?.hills ?? []) {
    const r = h.r, [W, D] = size;
    if (Math.abs(h.at[0]) - r > W / 2 + 1 || Math.abs(h.at[1]) - r > D / 2 + 1) continue;
    const points = [];
    for (let i = 0; i <= 4; i++) for (let j = 0; j < (i ? 12 : 1); j++) {
      const q = i / 4, a = (j / 12) * Math.PI * 2, k = 1 - q * q;
      points.push(+(h.at[0] + Math.cos(a) * q * r).toFixed(3), +(main.at[1] + h.h * k * k).toFixed(3), +(h.at[1] + Math.sin(a) * q * r).toFixed(3));
    }
    for (let j = 0; j < 12; j++) { const a = (j / 12) * Math.PI * 2; points.push(+(h.at[0] + Math.cos(a) * r).toFixed(3), main.at[1] - 0.5, +(h.at[1] + Math.sin(a) * r).toFixed(3)); }
    out.push({ prop: '#ground', tag: 'ground', shape: 'hull', points, position: [0, 0, 0], rotationY: 0 });
  }
  // invisible walls round the play area
  if (cfg.bounds?.walls !== false) {
    const h = cfg.bounds?.height ?? 4, t = 1, [w, d] = size, wall = (sz, position) => ({ prop: '#bounds', tag: 'bounds', shape: 'box', size: sz, position, rotationY: 0 });
    out.push(wall([w + 2 * t, h, t], [0, h / 2, -d / 2 - t / 2]), wall([w + 2 * t, h, t], [0, h / 2, d / 2 + t / 2]), wall([t, h, d], [-w / 2 - t / 2, h / 2, 0]), wall([t, h, d], [w / 2 + t / 2, h / 2, 0]));
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------- scenic
const box = (prop, tag, at, half, deg) => ({ prop, tag, shape: 'box', position: [at[0], at[1], at[2]], size: [half[0] * 2, half[1] * 2, half[2] * 2], rotationY: deg ?? 0 });
/** A cylinder standing on `base` ([x, y, z]: the middle of its foot). */
const standing = (prop, tag, base, r, h) => ({ prop, tag, shape: 'cylinder', position: [base[0], base[1] + h / 2, base[2]], radius: r, height: h, rotationY: 0 });

function islandColliders(lv, out) {
  const [cx, cy, cz] = lv.at;
  // the island's top: a convex hull of its outline (and 0.9 of it 2 m down)
  const N = 64, points = [];
  for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2, r = outlineRadius(lv.shape, a); points.push(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, cx + Math.cos(a) * r * 0.9, cy - 2, cz + Math.sin(a) * r * 0.9); }
  out.push({ prop: '#ground', tag: 'ground', shape: 'hull', points, position: [0, 0, 0], rotationY: 0 });
  // walls just inside its edge, 48 round
  const M = 48;
  for (let i = 0; i < M; i++) {
    const a0 = (i / M) * Math.PI * 2, a1 = ((i + 1) / M) * Math.PI * 2;
    const r0 = walkRadius(lv, a0) + 0.35, r1 = walkRadius(lv, a1) + 0.35;
    const p0 = [cx + Math.cos(a0) * r0, cz + Math.sin(a0) * r0], p1 = [cx + Math.cos(a1) * r1, cz + Math.sin(a1) * r1];
    const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2, len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    out.push(box('#rim', 'rim', [mx, cy + 3, mz], [0.25, 3, len / 2 + 0.15], Math.atan2(p1[0] - p0[0], p1[1] - p0[1]) / DEG));
  }
}
/** A dungeon level's floors (under its rooms and corridors) and, unless its KayKit modules bring their own, its wall
 *  segments [ax, az, bx, bz] (the loader draws them; the list holds their colliders). → {floors: [collider], walls} */
export function dungeonPieces(lv) {
  const out = [];
  if (lv.tiles) {
    // KayKit modules: the walls and doorways bring their own colliders; here the floor under the rooms and corridors
    for (const rm of lv.rooms) { const [x0, z0, x1, z1] = rm.rect; out.push(box('#ground', 'ground', [(x0 + x1) / 2, -0.5, (z0 + z1) / 2], [(x1 - x0) / 2, 0.5, (z1 - z0) / 2], 0)); }
    for (const d of lv.doors ?? []) out.push(box('#ground', 'ground', [(d.from[0] + d.to[0]) / 2, -0.5, (d.from[1] + d.to[1]) / 2], [d.horiz ? Math.abs(d.to[0] - d.from[0]) / 2 : 1.6, 0.5, d.horiz ? 1.6 : Math.abs(d.to[1] - d.from[1]) / 2], 0));
    return { floors: out, walls: [] };
  }
  const walls = [];
  const doorsOf = rm => (lv.doors ?? []).filter(d => d.rooms.includes(rm.id));
  for (const rm of lv.rooms) {
    const [x0, z0, x1, z1] = rm.rect;
    out.push(box('#ground', 'ground', [(x0 + x1) / 2, -0.5, (z0 + z1) / 2], [(x1 - x0) / 2, 0.5, (z1 - z0) / 2], 0));
    for (const [a, b] of [[[x0, z0], [x1, z0]], [[x1, z0], [x1, z1]], [[x1, z1], [x0, z1]], [[x0, z1], [x0, z0]]]) {
      const horiz = a[1] === b[1], gaps = [];   // the doorways on this edge: where a corridor's line crosses it
      for (const d of doorsOf(rm)) {
        if (horiz && d.horiz === false && Math.min(d.from[1], d.to[1]) < a[1] && Math.max(d.from[1], d.to[1]) > a[1]) gaps.push(d.from[0]);
        if (!horiz && d.horiz === true && Math.min(d.from[0], d.to[0]) < a[0] && Math.max(d.from[0], d.to[0]) > a[0]) gaps.push(d.from[1]);
      }
      const lo = horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = horiz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
      let cur = lo;
      for (const g of gaps.sort((p, q) => p - q)) { if (g - 1.3 > cur) walls.push(horiz ? [cur, a[1], g - 1.3, a[1]] : [a[0], cur, a[0], g - 1.3]); cur = g + 1.3; }
      if (hi > cur) walls.push(horiz ? [cur, a[1], hi, a[1]] : [a[0], cur, a[0], hi]);
    }
  }
  // corridors: a floor and two side walls across the gap between the rooms they join
  for (const d of lv.doors ?? []) {
    const ra = lv.rooms.find(r => r.id === d.rooms[0]), rb = lv.rooms.find(r => r.id === d.rooms[1]);
    if (!ra || !rb) continue;
    if (d.horiz) {
      const [l, r] = ra.rect[2] < rb.rect[0] ? [ra.rect[2], rb.rect[0]] : [rb.rect[2], ra.rect[0]], z = d.from[1];
      out.push(box('#ground', 'ground', [(l + r) / 2, -0.5, z], [(r - l) / 2 + 0.3, 0.5, d.width / 2 + 0.3], 0));
      walls.push([l, z - 1.3, r, z - 1.3], [l, z + 1.3, r, z + 1.3]);
    } else {
      const [l, r] = ra.rect[3] < rb.rect[1] ? [ra.rect[3], rb.rect[1]] : [rb.rect[3], ra.rect[1]], x = d.from[0];
      out.push(box('#ground', 'ground', [x, -0.5, (l + r) / 2], [d.width / 2 + 0.3, 0.5, (r - l) / 2 + 0.3], 0));
      walls.push([x - 1.3, l, x - 1.3, r], [x + 1.3, l, x + 1.3, r]);
    }
  }
  return { floors: out, walls };
}
function dungeonColliders(lv, out) {
  const { floors, walls } = dungeonPieces(lv), H = lv.wall?.height ?? 3.2, th = lv.wall?.thickness ?? 0.6;
  out.push(...floors);
  for (const [ax, az, bx, bz] of walls) out.push(box('#wall', 'wall', [(ax + bx) / 2, H / 2, (az + bz) / 2], [(Math.hypot(bx - ax, bz - az) + th) / 2, H / 2, th / 2], -Math.atan2(bz - az, bx - ax) / DEG));
}
function scenicColliders(cfg, catalog, { has = () => true } = {}) {
  const out = [];
  for (const lv of cfg.levels ?? []) {
    if (!lv.box) islandColliders(lv, out);
    else dungeonColliders(lv, out);
  }
  // the catalog props and the wall fixtures (torches, banners)
  const byId = new Map((catalog?.props ?? []).map(p => [p.id, p])), groups = new Map();
  for (const p of [...(cfg.props ?? []), ...(cfg.fixtures ?? [])]) { if (!groups.has(p.prop)) groups.set(p.prop, []); groups.get(p.prop).push(p); }
  for (const [id, list] of groups) {
    if (!has(id)) continue;
    const meta = byId.get(id), col = meta?.collider && meta.collider !== 'none' ? meta.collider : null;
    for (const p of list) {
      const s = p.scale ?? 1;
      for (const c of col ? (col.shape === 'compound' ? col.parts : [col]) : []) {
        const at = composeApply(p.at, p.rot, s, c.offset ?? c.at ?? [0, (c.size?.[1] ?? 1) / 2, 0]);
        if (c.shape === 'cylinder' && c.size) out.push(standing(id, `prop:${id}`, [at[0], at[1] - (c.size[1] * s) / 2, at[2]], (c.size[0] / 2) * s, c.size[1] * s));
        else if (c.size) out.push(box(id, `prop:${id}`, at, [(c.size[0] / 2) * s, (c.size[1] / 2) * s, (c.size[2] / 2) * s], p.rot));
      }
    }
  }
  // trees (a trunk each; a broad-leaved kind only when its model loaded), crystals, the ruins' pillars and wall stubs
  const kinds = new Map();
  for (const t of cfg.vegetation?.trees ?? []) { if (!kinds.has(t.kind)) kinds.set(t.kind, []); kinds.get(t.kind).push(t); }
  for (const [kind, list] of kinds) if (kind === 'pine' || has(`tree-${kind}`)) for (const t of list) out.push(standing('#tree', `tree:${kind}`, t.at, 0.3 * t.scale + 0.1, 4));
  for (const c of cfg.crystals ?? []) out.push(standing('#crystal', 'crystal', c.at, 0.45 * (c.scale ?? 1), 1.4));
  for (const s of cfg.structures ?? []) {
    if (s.kind === 'pillar') out.push(standing('#pillar', 'pillar', s.at, s.radius * 1.1, s.height + 0.3));
    else out.push(box('#wall', 'wall', [s.at[0], s.height / 2, s.at[2]], [s.length / 2, s.height / 2, 0.35], s.rot));
  }
  return out;
}

/** The colliders a layout's loader builds, as plain data: a scenic layout (one with levels) or a party one. */
export function collidersOf(layout, catalog, opts = {}) {
  return Array.isArray(layout?.levels) ? scenicColliders(layout, catalog, opts) : partyColliders(layout, catalog, opts);
}

/** Each 3D profile's physics material for a collider of the list: the party world's ground grips (friction 1), its props
 *  slide a little (0.6); the ground and walls are WORLD, props PROPS (kit/character/RIG.md §6); a scenic world is all
 *  WORLD at 0.9. */
export const MATERIALS = {
  party: c => ({ friction: c.prop === '#ground' ? 1 : 0.6, groups: groups(c.prop.startsWith('#') ? GROUPS.WORLD : GROUPS.PROPS, 0xffff) }),
  scenic: () => ({ friction: 0.9, groups: WORLD_GROUPS }),
};

/** Rapier colliders from the list, on one fixed body (a new one, or the loader's own); each tagged `__gf = {tag}`. */
export function buildColliders(R, W, list, materialOf, body = W.createRigidBody(R.RigidBodyDesc.fixed())) {
  const out = [];
  for (const c of list) {
    let d = null;
    if (c.shape === 'box') d = R.ColliderDesc.cuboid(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2);
    else if (c.shape === 'cylinder') d = R.ColliderDesc.cylinder(c.height / 2, c.radius);
    else if (c.shape === 'sphere') d = R.ColliderDesc.ball(c.radius);
    else if (c.shape === 'ramp') {   // a wedge rising toward -z (Kenney slope blocks); half extents
      const [x, y, z] = c.size.map(n => n / 2);
      d = R.ColliderDesc.convexHull(new Float32Array([-x, -y, -z, x, -y, -z, -x, -y, z, x, -y, z, -x, y, -z, x, y, -z]));
    } else if (c.shape === 'hull') d = R.ColliderDesc.convexHull(new Float32Array(c.points));
    if (!d) continue;
    const half = (c.rotationY ?? 0) * DEG / 2, m = materialOf(c);
    d.setTranslation(...c.position).setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }).setFriction(m.friction).setCollisionGroups(m.groups);
    const col = W.createCollider(d, body);
    col.__gf = { tag: c.tag };
    out.push(col);
  }
  return out;
}
