// gf-three world layout helpers (track L): pure functions with no three.js and no DOM, shared by world.js (the
// browser) and tools/lib/dressing.mjs (the set-dressing lint, Node). Keep them dependency free.
//   rng(seed)                 the seeded random stream `scatter` uses (mulberry32)
//   expandLayout(cfg)         props + scatter → every placement, deterministic per seed
//   placementYaw(p)           yaw in degrees (rot: deg | [x, y, z] deg)
//   placementScale(p)         [sx, sy, sz]
//   footprint(p, meta, mode)  the ground footprint of a placement: { shape: 'box', cx, cz, hx, hz, yaw } | { shape: 'circle', cx, cz, r },
//                             plus y0 / y1 (base and top, metres). mode 'collider' (physics; null for decor) or 'visual' (catalog size)
export const DEG = Math.PI / 180;

export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Expand `scatter` entries into placements (deterministic per seed). */
export function expandLayout(cfg) {
  const placed = [...(cfg.props ?? [])];
  for (const s of cfg.scatter ?? []) {
    const r = rng(s.seed ?? 1);
    const [x0, z0, x1, z1] = s.area ?? [-(cfg.size?.[0] ?? 20) / 2, -(cfg.size?.[1] ?? 20) / 2, (cfg.size?.[0] ?? 20) / 2, (cfg.size?.[1] ?? 20) / 2];
    let n = 0, tries = 0;
    while (n < (s.count ?? 10) && tries++ < (s.count ?? 10) * 20) {
      const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
      if ((s.clear ?? []).some(([cx, cz, cr]) => (x - cx) ** 2 + (z - cz) ** 2 < cr * cr)) continue;
      const sc = s.scale ? s.scale[0] + r() * (s.scale[1] - s.scale[0]) : 1;
      placed.push({ prop: s.prop, at: [+x.toFixed(2), s.y ?? 0, +z.toFixed(2)], rot: Math.round(r() * 360), scale: +sc.toFixed(2), scattered: true });
      n++;
    }
  }
  return placed;
}

export const placementYaw = (p) => (Array.isArray(p.rot) ? (p.rot[1] ?? 0) : (p.rot ?? 0));
export const placementScale = (p) => (Array.isArray(p.scale) ? [p.scale[0] ?? 1, p.scale[1] ?? 1, p.scale[2] ?? 1] : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1]);

/** Rotate (x, z) by a yaw in degrees, the way three.js turns +z toward +x for a positive yaw about +y. */
export function turn(x, z, yawDeg) {
  const a = yawDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  return [x * c + z * s, -x * s + z * c];
}

/** A catalog entry's collider as a list of simple parts (a doorway is a compound: two posts and a lintel). */
export function colliderParts(meta) {
  const c = meta?.collider;
  if (!c || c === 'none' || !c.shape) return [];
  return c.shape === 'compound' ? (c.parts ?? []).filter(q => q?.shape) : [c];
}

/**
 * The ground footprint of a placement. mode 'collider': the catalog's collider (what physics and the player bump
 * into; null for decor with collider 'none'). mode 'visual': the catalog's size box (what you see). A compound
 * collider (a doorway) gives its size box, with `parts`: the footprint of each part (the opening is between them).
 */
export function footprint(p, meta, mode = 'collider') {
  const [sx, sy, sz] = placementScale(p);
  const yaw = placementYaw(p);
  const at = p.at ?? [0, 0, 0];
  const size = meta?.size ?? [1, 1, 1];
  const y0 = at[1] ?? 0, y1 = y0 + size[1] * sy;
  if (mode === 'visual' || !meta?.collider || meta.collider === 'none' || !meta.collider.shape) {
    if (mode !== 'visual') return null;
    return { shape: 'box', cx: at[0], cz: at[2], hx: size[0] * sx / 2, hz: size[2] * sz / 2, yaw, y0, y1 };
  }
  if (meta.collider.shape === 'compound') {
    const parts = colliderParts(meta).map(c => footprint(p, { ...meta, collider: c }, 'collider')).map((f, i) => {
      const c = colliderParts(meta)[i], cy = (c.offset?.[1] ?? 0) * sy, h = (c.size?.[1] ?? c.height ?? size[1]) * sy;
      return { ...f, y0: y0 + cy - h / 2, y1: y0 + cy + h / 2 };
    });
    return { shape: 'box', cx: at[0], cz: at[2], hx: size[0] * sx / 2, hz: size[2] * sz / 2, yaw, y0, y1, parts };
  }
  const c = meta.collider;
  const off = c.offset ?? [0, 0, 0];
  const [ox, oz] = turn(off[0] * sx, off[2] * sz, yaw);
  const cx = at[0] + ox, cz = at[2] + oz;
  if (c.shape === 'cylinder') return { shape: 'circle', cx, cz, r: c.radius * Math.max(sx, sz), y0, y1 };
  if (c.shape === 'sphere') return { shape: 'circle', cx, cz, r: c.radius * Math.max(sx, sy, sz), y0, y1 };
  const cs = c.size ?? size;
  return { shape: 'box', cx, cz, hx: cs[0] * sx / 2, hz: cs[2] * sz / 2, yaw, y0, y1 };
}

// ---------- rooms, doors and routes (indoor worlds; kit/world/generate.js writes them) ----------
// A layout may carry rooms: [{ id, kind, label, rect: [x0, z0, x1, z1], main }], doors (between rooms):
// [{ at: [x, y, z], rooms: [a, b], normal: [nx, nz] (from a toward b), width }], and entries (doors to the outside,
// where enemies and visitors come in): [{ name, room, at, normal (outward), width }].

/** The room that holds (x, z), or null (outdoors, or a layout without rooms). */
export function roomAt(cfg, x, z) {
  for (const r of cfg?.rooms ?? []) { const [x0, z0, x1, z1] = r.rect; if (x >= x0 - 1e-6 && x <= x1 + 1e-6 && z >= z0 - 1e-6 && z <= z1 + 1e-6) return r; }
  return null;
}

/** Room ids reachable from `from` through the doors (breadth first), with the door taken into each. → Map id → {prev, door} */
export function roomGraph(cfg, from) {
  const seen = new Map([[from, null]]), queue = [from];
  while (queue.length) {
    const a = queue.shift();
    for (const d of cfg?.doors ?? []) {
      const i = d.rooms.indexOf(a); if (i < 0) continue;
      const b = d.rooms[1 - i]; if (seen.has(b)) continue;
      seen.set(b, { prev: a, door: d }); queue.push(b);
    }
  }
  return seen;
}

/**
 * Where to walk next on the way from `from` to `to` ({x, z} each) through the rooms' doors: the near side of the next
 * door, then a point just past it. null when both are in one room (or there are no rooms): walk straight.
 */
export function createRouter(cfg) {
  const cache = new Map();
  const firstDoor = (a, b) => {
    const key = `${a}|${b}`;
    if (!cache.has(key)) {
      const g = roomGraph(cfg, a);
      let step = g.get(b), door = null;
      while (step && step.prev !== a) step = g.get(step.prev);
      if (step) door = step.door;
      cache.set(key, door);
    }
    return cache.get(key);
  };
  return function via(from, to) {
    const a = roomAt(cfg, from.x, from.z), b = roomAt(cfg, to.x, to.z);
    if (!a || !b || a.id === b.id) return null;
    const d = firstDoor(a.id, b.id);
    if (!d) return null;
    const s = d.rooms[0] === a.id ? 1 : -1;                    // the normal points from rooms[0] to rooms[1]
    const nx = d.normal[0] * s, nz = d.normal[1] * s;
    const near = { x: d.at[0] - nx * 0.7, z: d.at[2] - nz * 0.7 };
    if (Math.hypot(from.x - near.x, from.z - near.z) > 0.6 && ((from.x - d.at[0]) * nx + (from.z - d.at[2]) * nz) < -0.35) return near;
    return { x: d.at[0] + nx * 1.1, z: d.at[2] + nz * 1.1 };
  };
}

/** A point just inside an entry (a door to the outside), spread along its width: where an enemy comes in. */
export function entryPoint(e, r = Math.random, inset = 1.0) {
  const [nx, nz] = e.normal, u = (r() - 0.5) * Math.max(0, (e.width ?? 1.6) - 0.8);
  return { x: e.at[0] - nx * inset - nz * u, z: e.at[2] - nz * inset + nx * u, entry: e.name };
}
