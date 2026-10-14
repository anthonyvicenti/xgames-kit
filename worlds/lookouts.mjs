// Camera places in an outdoor world that has a ground height (the terrain world's field, the sea-islands layout), for a
// camera that must show one kind of view (builder/look: the look judge holds each frame to references of the same kind;
// a target camera's framing names it in `where`). Pure: only the world's height function and its numbers.
//
//   lookout({ heightAt, seaLevel, bounds, seats }, where) → { eye: [x, y, z], target: [x, y, z], fov, setting, where, score } | null
//
//   seat       where a player stands in play: the flattest seat, at eye height, looking at the nearest other seat
//   day        a sunlit rise near the seats facing the widest open view (the voxel world's 'day', for any land)
//   night      the same place (the time of day is the look's)
//   cliff-edge the land's edge where it drops to the sea, looking out over the drop
//   beach      just above the sea, looking along the land
//   sea-view   a high point looking out over the most open sea
// Anything else (a cave in a world with none) → null: the caller frames around the player and says so.
export const WHERES = ['seat', 'day', 'night', 'cliff-edge', 'beach', 'sea-view'];

const TAU = Math.PI * 2;
const r2 = v => Math.round(v * 100) / 100;

/** How far one sees from (x, y, z) toward yaw over the ground before the land rises into the line (m, up to max). */
function openTo(heightAt, x, y, z, yaw, max = 160) {
  for (let d = 2; d < max; d += 2) {
    const h = heightAt(x + Math.sin(yaw) * d, z + Math.cos(yaw) * d);
    if (h != null && h > y - d * 0.02) return d;
  }
  return max;
}
/** The share of a fan toward yaw whose line meets open sea (no land under it) within `far` m. */
function seaShare(heightAt, x, z, yaw, far = 120) {
  let sea = 0, n = 0;
  for (let f = -3; f <= 3; f++) for (let d = 20; d <= far; d += 20) { n++; if (heightAt(x + Math.sin(yaw + f * 0.15) * d, z + Math.cos(yaw + f * 0.15) * d) == null) sea++; }
  return sea / n;
}
const look = (eye, yaw, drop, dist = 30) => [r2(eye[0] + Math.sin(yaw) * dist), r2(eye[1] - drop), r2(eye[2] + Math.cos(yaw) * dist)];

export function lookout({ heightAt, seaLevel = 0, bounds, seats = [] }, where) {
  const H = (x, z) => { const h = heightAt(x, z); return h == null || h < seaLevel ? null : h; };
  const [x0, z0, x1, z1] = bounds ?? [-50, -50, 50, 50];
  const flatness = (x, z, y, r = 2.5) => { let m = 0; for (let a = 0; a < 8; a++) { const h = H(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r); m = Math.max(m, h == null ? 9 : Math.abs(h - y)); } return m; };
  const grid = (step, fn) => { for (let z = z0 + step; z < z1 - step; z += step) for (let x = x0 + step; x < x1 - step; x += step) { const y = H(x, z); if (y != null) fn(x, z, y); } };
  if (where === 'seat') {
    const list = seats.length ? seats : [];
    if (!list.length) return null;
    const best = list.reduce((a, s) => (flatness(s.x, s.z, s.y) < flatness(a.x, a.z, a.y) ? s : a));
    const other = list.filter(s => s !== best).sort((a, b) => Math.hypot(a.x - best.x, a.z - best.z) - Math.hypot(b.x - best.x, b.z - best.z))[0];
    const yaw = other ? Math.atan2(other.x - best.x, other.z - best.z) : best.yaw ?? 0;
    const eye = [r2(best.x), r2(best.y + 1.6), r2(best.z)];
    return { where, setting: 'day', eye, target: look(eye, yaw, 1.2, 12), fov: 60, score: r2(-flatness(best.x, best.z, best.y)) };
  }
  if (where === 'day' || where === 'night' || where === 'sea-view') {
    const mid = seats.length ? [seats.reduce((a, s) => a + s.x, 0) / seats.length, seats.reduce((a, s) => a + s.z, 0) / seats.length] : [(x0 + x1) / 2, (z0 + z1) / 2];
    let best = null;
    grid(3, (x, z, y) => {
      if (flatness(x, z, y, 1.5) > 0.8) return;
      for (let k = 0; k < 12; k++) {
        const yaw = (k / 12) * TAU;
        const open = openTo(H, x, y + 1.6, z, yaw), sea = where === 'sea-view' ? seaShare(H, x, z, yaw) : 0;
        const score = (where === 'sea-view' ? sea * 100 + y * 0.8 : open / 4 + (y - seaLevel) * 0.6) - Math.hypot(x - mid[0], z - mid[1]) * 0.05;
        if (!best || score > best.score) best = { x, z, y, yaw, score };
      }
    });
    if (!best) return null;
    const eye = [r2(best.x), r2(best.y + 1.7), r2(best.z)];
    return { where, setting: where === 'night' ? 'night' : 'day', eye, target: look(eye, best.yaw, where === 'sea-view' ? 4 : 2, 30), fov: where === 'sea-view' ? 60 : 65, score: r2(best.score) };
  }
  if (where === 'cliff-edge') {
    // land within 3 m of a drop of 2 m or more toward the sea: stand back from the lip, look out and down over it
    let best = null;
    grid(2, (x, z, y) => {
      if (flatness(x, z, y, 1) > 0.6) return;
      for (let k = 0; k < 12; k++) {
        const yaw = (k / 12) * TAU, ahead = heightAt(x + Math.sin(yaw) * 4, z + Math.cos(yaw) * 4);
        const drop = y - (ahead == null ? seaLevel : Math.max(ahead, seaLevel));
        if (drop < 2) continue;
        const score = drop + seaShare(H, x, z, yaw) * 6;
        if (!best || score > best.score) best = { x, z, y, yaw, score, drop };
      }
    });
    if (!best) return null;
    const eye = [r2(best.x - Math.sin(best.yaw) * 3), r2(best.y + 2.2), r2(best.z - Math.cos(best.yaw) * 3)];
    return { where, setting: 'day', eye, target: look(eye, best.yaw, best.drop * 0.6 + 2, 20), fov: 60, score: r2(best.score) };
  }
  if (where === 'beach') {
    // just above the sea (0.2–1.5 m), the land rising behind: stand there and look along the shore toward the land
    let best = null;
    grid(2, (x, z, y) => {
      const above = y - seaLevel;
      if (above < 0.2 || above > 1.5 || flatness(x, z, y, 1.2) > 1.1) return;
      for (let k = 0; k < 12; k++) {
        const yaw = (k / 12) * TAU, back = H(x + Math.sin(yaw) * 8, z + Math.cos(yaw) * 8);
        if (back == null) continue;
        const score = (back - y) + (1.5 - above);
        if (!best || score > best.score) best = { x, z, y, yaw, score };
      }
    });
    if (!best) return null;
    const eye = [r2(best.x), r2(best.y + 1.6), r2(best.z)];
    return { where, setting: 'day', eye, target: look(eye, best.yaw, -1, 20), fov: 60, score: r2(best.score) };
  }
  return null;
}
