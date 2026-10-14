// The places vocabulary's shapes (open builder wave 10, track H): an island's outline, the distance to it, a rounded
// square, a path. Pure: no three.js, no DOM. Moved here unchanged from research/gf-scenic/kit/world/generate.js, which
// re-exports them, so the scenic world's generator, terrain and loader, the vocabulary's island words, the one collider
// list and the reach model all measure an island the same way.
//
//   outlineRadius(shape, a)   an island's outline radius at angle a: a superellipse {radius, n, rot, wobble}
//   islandSdf(level, x, z)    signed distance to a level's outline (negative inside)
//   roundRectSdf(rr, x, z)    distance outside a rounded rectangle {at: [x, z], half: [hx, hz], corner}
//   polylineDistance(pts, x, z)
//   walkRadius(level, a)      the walkable radius (inside the rim), playHalf(level) the play box that fits inside it
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A level's outline radius at angle a (radians; 0 = +x, π/2 = +z): a superellipse with a seeded wobble. */
export function outlineRadius(shape, a) {
  const n = shape.n ?? 5, R = shape.radius;
  const c = Math.abs(Math.cos(a - (shape.rot ?? 0))), s = Math.abs(Math.sin(a - (shape.rot ?? 0)));
  const base = R * Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
  let w = 0;
  for (const [k, amp, ph] of shape.wobble ?? []) w += amp * Math.sin(k * a + ph);
  return base * (1 + w);
}
/** Signed distance (m, approximate) from (x, z) to a level's outline: negative inside. */
export function islandSdf(level, x, z) {
  const [cx, , cz] = level.at;
  const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
  return d - outlineRadius(level.shape, Math.atan2(dz, dx));
}
/** Distance outside a rounded rectangle {at:[x,z], half:[hx,hz], corner} (negative inside). */
export function roundRectSdf(rr, x, z) {
  const qx = Math.abs(x - rr.at[0]) - rr.half[0] + rr.corner, qz = Math.abs(z - rr.at[1]) - rr.half[1] + rr.corner;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - rr.corner;
}
/** Distance from (x, z) to a polyline [[x, z], ...]. */
export function polylineDistance(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return best;
}
/** The walkable radius at angle a (inside the rim) and the play box half-size that fits inside it. */
export function walkRadius(level, a) { return outlineRadius(level.shape, a) - (level.rimInset ?? 1.2); }
export function playHalf(level) {
  let h = Infinity;
  for (let i = 0; i < 360; i++) { const a = (i / 360) * Math.PI * 2; h = Math.min(h, walkRadius(level, a) * Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)))); }
  return Math.max(4, h - 0.4);
}
