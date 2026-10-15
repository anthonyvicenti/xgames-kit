// Places in a voxel world for a camera that must show one setting (builder/look: the look judge compares a cave frame
// with cave references and a daylight frame with daylight ones). The finders are the voxel bench's
// (runtimes/three/tools/voxel-bench/bench.js horizon and cave), made pure over the world's grid, light and terrain so a
// game can ask for them too:
//
//   placeFor(voxel, 'cave' | 'day' | 'night' | 'wide', { from }) → { eye: [x, y, z], target: [x, y, z], fov, setting, score } | null
//
// 'night' is a place outdoors (the time of day is the look's). Nothing found → null (the caller frames around the
// player instead and says so).

/** A grassy rise near `from` (the spawn square) facing the widest open view: the mean open distance over a 60° fan. */
export function dayPlace({ grid, terrain: T, table }, { from = null } = {}) {
  const [sx, , sz] = grid.size;
  const at = from ?? T.plaza?.at ?? [sx / 2, sz / 2];
  const grass = table?.byId?.get?.('grass')?.n ?? null;
  const land = (x, z) => T.heights[z * sx + x];
  const open = (x, y, z, yaw, max = 90) => { for (let d = 2; d < max; d++) { const X = Math.floor(x + Math.sin(yaw) * d), Z = Math.floor(z + Math.cos(yaw) * d); if (X < 0 || Z < 0 || X >= sx || Z >= sz) return max; if (grid.solidAt(X, Math.floor(y), Z)) return d; } return max; };
  const snow = (T.model?.snowline ?? 1e9) - 4;
  let best = null;
  for (let z = 10; z < sz - 10; z += 3) for (let x = 10; x < sx - 10; x += 3) {
    const h = land(x, z), d = Math.hypot(x - at[0], z - at[1]);
    if (d > 60 || h >= snow || (grass !== null && grid.block(x, h - 1, z) !== grass) || grid.top(x, z) > h + 1) continue;
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2;
      let fan = 0;
      for (let f = -3; f <= 3; f++) fan += open(x + 0.5, h + 1.4, z + 0.5, yaw + f * 0.17);
      const score = fan / 7 + (h - (T.water ?? 0)) * 0.6 - d * 0.05;
      if (!best || score > best.score) best = { x, z, h, yaw, score };
    }
  }
  if (!best) return null;
  const eye = [best.x + 0.5, best.h + 1.65, best.z + 0.5];
  return { setting: 'day', eye, target: [eye[0] + Math.sin(best.yaw) * 20, eye[1] - 2, eye[2] + Math.cos(best.yaw) * 20], fov: 70, score: Math.round(best.score * 10) / 10, rise: best };
}

/**
 * A wide view of the land in daylight: from above the best rise (dayPlace), stepped back and up, looking down across the
 * open view, so the land fills the frame below the horizon (the kit's own 'wide' shot frames the whole grid's bounds,
 * which for a voxel world puts the camera far above it, in the haze).
 */
export function widePlace(voxel, opts = {}) {
  const d = dayPlace(voxel, opts);
  if (!d) return null;
  const { grid } = voxel, { x, z, h, yaw } = d.rise;
  const back = 10, up = 14;
  const eye = [x + 0.5 - Math.sin(yaw) * back, h + up, z + 0.5 - Math.cos(yaw) * back];
  // lift out of anything solid (a tree, a hill behind the rise)
  for (let k = 0; k < 20 && grid.solidAt(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2])); k++) eye[1] += 2;
  return { setting: 'day', eye, target: [x + 0.5 + Math.sin(yaw) * 45, h - 4, z + 0.5 + Math.cos(yaw) * 45], fov: 60, score: d.score };
}

/** An open cavern with the most block light and no sky, looking across it toward its light. */
export function cavePlace({ grid, light }) {
  const [sx, sy, sz] = grid.size;
  const L = light.data;
  let best = null;
  for (let y = 4; y < sy - 4; y += 1) for (let z = 6; z < sz - 6; z += 2) for (let x = 6; x < sx - 6; x += 2) {
    const i = grid.index(x, y, z), w = L[i];
    if (grid.data[i] || (w >> 12) > 1) continue;
    const blk = ((w >> 8) & 15) + ((w >> 4) & 15) + (w & 15);
    if (blk < 6) continue;
    let air = 0, sky = 0;
    for (let dy = -1; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { if (!grid.solidAt(x + dx, y + dy, z + dz)) air++; sky += light.at(x + dx * 3, y + dy, z + dz * 3) >> 12; }
    if (sky > 2 || !grid.solidAt(x, y - 1, z)) continue;   // deep in, not at a cave's mouth; standing on a floor
    const warm = (w >> 8) & 15, cool = w & 15;
    const score = air * 1.5 + Math.min(warm, cool) * 4 - Math.max(0, blk - 14) * 3;
    if (!best || score > best.score) best = { x, y, z, score };
  }
  if (!best) return null;
  const e = [best.x + 0.5, best.y + 1.4, best.z + 0.5];
  let yaw = 0, bestL = -1;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2; let sum = 0, open = 0;
    for (let d = 1; d < 24; d++) { const X = Math.floor(e[0] + Math.sin(a) * d), Z = Math.floor(e[2] + Math.cos(a) * d), Y = Math.floor(e[1] - 0.4); if (grid.solidAt(X, Y, Z)) break; open = d; const w = light.at(X, Y, Z); sum += ((w >> 8) & 15) + ((w >> 4) & 15) + (w & 15); }
    const s = open * 6 + sum * 0.5;
    if (s > bestL) { bestL = s; yaw = a; }
  }
  return { setting: 'cave', eye: e, target: [e[0] + Math.sin(yaw) * 10, e[1] - 1.4, e[2] + Math.cos(yaw) * 10], fov: 75, score: best.score };
}

/** The place for a setting, or null. */
export function placeFor(voxel, setting, opts = {}) {
  if (setting === 'cave') return cavePlace(voxel);
  if (setting === 'day' || setting === 'night') { const p = dayPlace(voxel, opts); if (!p) return null; const { rise, ...rest } = p; return { ...rest, setting }; }
  if (setting === 'wide') return widePlace(voxel, opts);
  return null;
}
