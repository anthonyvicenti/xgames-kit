// src/track.js: Island Circuit's road. A closed loop round the island, its shape from config/game.json → rules.params
// (trackRadius, trackWave, trackLobes, trackWidth, trackStart, gates), the race gates along it, the starting grid
// behind the line, cones on both edges, and the edges themselves: a car that reaches one is pushed back onto the road.
//
//   trackShape(params)   pure (Node and the browser): {points, length, width, at(s), nearest(x, z), gates(), grid(n), path()}
//   createTrack(ctx)     in the game: the shape, the cones (slot prop.cone) and contain(body, car, dt) for the cars
//
// The world draws the road itself: config/world.json → levels[0].paths holds this loop (its stone path, no grass on it;
// drawn 1.4 m wider than trackWidth, since the paving fades out before a path's edge, so the cones stand on stone),
// the race's gates are config/game.json → mechanics[race].params.checkpoints and the grid is the world's spawns, all
// written from this same shape (the race reads its gates before rules.setup runs). setup() says so on the console when
// they have drifted apart after a tuning change.

export const TRACK_DEFAULTS = { trackRadius: 10.5, trackWave: 1.5, trackLobes: 3, trackWidth: 7, trackStart: 0, gates: 8, coneSpacing: 4, edgeBounce: 0.35, edgeSteer: 4 };
const SAMPLES = 360;
const r2 = v => Math.round(v * 100) / 100;

/** The loop: travel goes the way the angle grows (from +x toward +z). s is the distance along it from the start line. */
export function trackShape(params = {}) {
  const P = { ...TRACK_DEFAULTS, ...params };
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = P.trackStart + (i / SAMPLES) * Math.PI * 2;
    const r = P.trackRadius + P.trackWave * Math.cos(P.trackLobes * t);
    pts.push({ x: r * Math.cos(t), z: r * Math.sin(t) });
  }
  const cum = [0];
  for (let i = 0; i < SAMPLES; i++) { const a = pts[i], b = pts[(i + 1) % SAMPLES]; cum.push(cum[i] + Math.hypot(b.x - a.x, b.z - a.z)); }
  const length = cum[SAMPLES], width = P.trackWidth;
  const wrap = s => ((s % length) + length) % length;

  /** The point at s: {x, z, tx, tz (unit tangent), nx, nz (unit normal, left of travel), yaw (three.js, forward = (sin, cos))} */
  function at(s) {
    s = wrap(s);
    let lo = 0, hi = SAMPLES - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; }
    const a = pts[lo], b = pts[(lo + 1) % SAMPLES], seg = cum[lo + 1] - cum[lo] || 1, u = (s - cum[lo]) / seg;
    const tx = (b.x - a.x) / seg, tz = (b.z - a.z) / seg;
    return { s, x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx, tz, nx: tz, nz: -tx, yaw: Math.atan2(tx, tz) };
  }
  /** The nearest point of the centre line to (x, z): its s, the tangent, and lat (signed metres off the centre line, + to the left). */
  function nearest(x, z) {
    let best = Infinity, bi = 0, bu = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const a = pts[i], b = pts[(i + 1) % SAMPLES], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const qx = a.x + dx * u - x, qz = a.z + dz * u - z, d2 = qx * qx + qz * qz;
      if (d2 < best) { best = d2; bi = i; bu = u; }
    }
    const p = at(cum[bi] + (cum[bi + 1] - cum[bi]) * bu);
    return { ...p, lat: (x - p.x) * p.nx + (z - p.z) * p.nz, dist: Math.sqrt(best) };
  }
  /** The race's gates, [[x, z], …]: evenly along the loop, the last one on the start and finish line. */
  const gates = (n = P.gates) => Array.from({ length: n }, (_, i) => { const p = at(((i + 1) / n) * length); return [r2(p.x), r2(p.z)]; });
  /** The starting grid behind the line, two by two: [{x, z, yaw}]. */
  const grid = n => Array.from({ length: n }, (_, j) => {
    const row = Math.floor(j / 2), side = j % 2 ? -1 : 1, p = at(-(3.5 + row * 3.4)), lat = side * width * 0.2;
    return { x: r2(p.x + p.nx * lat), z: r2(p.z + p.nz * lat), yaw: p.yaw };
  });
  /** The centre line as the world's path polyline, closed: [[x, z], …]. */
  const path = (step = 6) => { const n = Math.max(12, Math.round(SAMPLES / step)); const out = []; for (let i = 0; i <= n; i++) { const p = pts[(i * Math.round(SAMPLES / n)) % SAMPLES]; out.push([r2(p.x), r2(p.z)]); } out[out.length - 1] = out[0].slice(); return out; };
  return { params: P, points: pts, length, width, at, nearest, gates, grid, path, wrap };
}

/** In the game: the shape from rules.params, the cones on its edges, and the edges' push. */
export function createTrack(ctx) {
  const shape = trackShape(ctx.config?.rules?.params ?? {});
  const P = shape.params;
  const root = new ctx.THREE.Group(); root.name = 'island-circuit-track'; ctx.scene.add(root);
  const down = { x: 0, y: -1, z: 0 };
  const groundY = (x, z) => { try { const h = ctx.world?.raycast?.({ x, y: 25, z }, down, 60); const y = h?.point?.y; return Number.isFinite(y) && y > -3 && y < 6 ? y : 0; } catch { return 0; } };

  // the gates the race judges and the world's road came from this shape; say so when a tuning change left them behind
  const race = ctx.mechanics?.get?.('race');
  const want = shape.gates(), have = (race?.checkpoints ?? []).map(c => [c.x, c.z]);
  if (have.length && (have.length !== want.length || have.some((c, i) => Math.hypot(c[0] - want[i][0], c[1] - want[i][1]) > 0.5)))
    console.warn('Island Circuit: the race gates in config/game.json no longer follow the track in rules.params; write them again from src/track.js (trackShape(params).gates())');

  /** The cones down both edges (the prop.cone slot), on the ground. */
  async function dress() {
    if (!ctx.assets?.has?.('prop.cone')) return;
    const n = Math.max(8, Math.round(shape.length / Math.max(1.5, P.coneSpacing)));
    for (let i = 0; i < n; i++) {
      const p = shape.at((i / n) * shape.length);
      for (const side of [1, -1]) {
        const x = p.x + p.nx * side * (shape.width / 2 + 0.25), z = p.z + p.nz * side * (shape.width / 2 + 0.25);
        const cone = await ctx.assets.model('prop.cone');
        cone.position.set(x, groundY(x, z), z);
        root.add(cone);
      }
    }
  }

  /**
   * A car at an edge: the part of its velocity that leaves the road is taken away (and a little bounced back), its speed
   * scrubs, and one that is well off the road (a knock, a shove) is pulled back on. Runs in the car's physics step.
   */
  function contain(body, car, dt) {
    const t = body.translation(), n = shape.nearest(t.x, t.z), lim = shape.width / 2 - 1.1, over = Math.abs(n.lat) - lim;
    if (over <= 0) return false;
    const sx = Math.sign(n.lat) * n.nx, sz = Math.sign(n.lat) * n.nz, v = body.linvel(), out = v.x * sx + v.z * sz;
    let vx = v.x, vz = v.z;
    if (out > 0) { vx -= sx * out * (1 + P.edgeBounce); vz -= sz * out * (1 + P.edgeBounce); }
    if (over > 0.3) { const back = Math.min(6, over * 6); vx -= sx * back; vz -= sz * back; }
    body.setLinvel({ x: vx, y: v.y, z: vz }, true);
    // the edge is a wall: a car never ends up more than a little past it (a shove, a knock, a fast corner)
    if (over > 0.8) body.setTranslation({ x: t.x - sx * (over - 0.8), y: t.y, z: t.z - sz * (over - 0.8) }, true);
    if (car) {
      car.v *= Math.max(0, 1 - 0.8 * dt);
      // the edge turns the car's nose back along the road (whichever way along it is nearer), so it slides on, never stalls
      const along = Math.abs(Math.atan2(Math.sin(car.h - n.yaw), Math.cos(car.h - n.yaw))) < Math.PI / 2 ? n.yaw : n.yaw + Math.PI;
      const d = Math.atan2(Math.sin(along - car.h), Math.cos(along - car.h));
      car.h += d * Math.min(1, P.edgeSteer * dt);
    }
    return true;
  }

  return { shape, root, dress, contain, nearest: shape.nearest, at: shape.at };
}
