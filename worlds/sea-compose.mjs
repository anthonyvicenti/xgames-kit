// The sea-islands world's level composer (looks wave 4, 2026-10-14): the same composition the terrain world takes
// (worlds/terrain/compose.mjs; worlds/compose.mjs the shared framing), on a layout. Pure: create applies it to the
// layout it makes (builder/tools/lib/spec-config.mjs), the browser draws what it says.
//
//   composeSea(layout, compose, sizeOf) → the layout with the main landmark in the play area as ground (its placement
//     carries collider 'mesh': the world builds a collider from the model's own triangles, so players stand on what they
//     see), the set dressing cleared from its footprint, the seats in pairs round it (or before it, for 'behind'), each
//     seat's yaw (layout.spawnYaw: its partner and the landmark in the frame), layout.landmarks for the camera's lean,
//     and layout.composition (the report).
//
// The play island is flat in its middle and walled round its play area: the landmark stands inside the walls. Bridges
// between landmasses are the terrain world's (its islands are open ground); here the play island is the one landmass
// players reach, so a bridge asked for is reported, not built.
import { COMPOSE_DEFAULTS, boxShare, viewOf, framedYaw, leanToward, ndcOf } from './compose.mjs';

const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** A box standing at `at`, size [w, h, d] (scaled by k, turned a quarter turn when `quarter`). */
const boxAt = (at, size, k, quarter = false) => {
  const w = (quarter ? size[2] : size[0]) * k / 2, d = (quarter ? size[0] : size[2]) * k / 2;
  return { min: [at[0] - w, at[1], at[2] - d], max: [at[0] + w, at[1] + size[1] * k, at[2] + d] };
};

export function composeSea(layout, compose, sizeOf) {
  const C = { ...COMPOSE_DEFAULTS, ...(compose ?? {}) }, cam = { ...COMPOSE_DEFAULTS.camera, ...(C.camera ?? {}) };
  const report = { playOn: C.playOn, share: C.share, notes: [] };
  const id = (C.landmarks ?? []).find(x => sizeOf(x));
  if (!id) { report.notes.push('no landmark with a size in the catalog'); return { ...layout, composition: report }; }
  if ((C.bridges ?? []).length) report.notes.push('bridges are the terrain world\'s: the play island is the one landmass players reach here');
  const size = sizeOf(id), [W, D] = layout.size, foot = Math.hypot(size[0], size[2]) / 2;
  const behind = C.playOn === 'behind';
  // the scale and the seats' distance: the share asked, the whole piece in the frame (the camera leaning toward it), the
  // seats inside the play area's walls
  const room = Math.min(W, D) / 2 - 1.5;
  let best = null;
  for (let k = 0.8; k <= 2.61; k += 0.1) {
    if (foot * k > room * (behind ? 0.9 : 0.6)) break;
    const B = boxAt([0, 0, 0], size, k), mid = [0, size[1] * k * 0.5, 0];
    for (let rho = foot * k + 3; rho <= (behind ? D * 0.9 : room) + 1e-6; rho += 1) {
      const v = viewOf({ x: 0, y: 0, z: -rho }, 0, cam);
      v.target = leanToward(v.eye, v.target, [{ centre: mid }], { fov: cam.fov, aspect: cam.aspect });
      if (ndcOf(v, [0, size[1] * k, 0])[1] > 1.02) continue;
      // among equal shares the bigger piece further off (it reads as the place, not as a prop beside the seat)
      const s = boxShare(B, v) * 0.55, err = Math.abs(s - C.share) + (2.6 - k) * 0.01;
      if (!best || err < best.err) best = { k: r2(k), rho: r2(rho), share: r2(s), err };
      break;
    }
  }
  best ??= { k: 1, rho: r2(foot + 3), share: 0 };
  Object.assign(report, { scale: best.k, playDistance: best.rho, plannedShare: best.share });
  const at = behind ? [0, 0, r2(D / 2 - foot * best.k * 0.6)] : [0, 0, 0];
  const box = boxAt(at, size, best.k), footR = foot * best.k;
  const landmark = { id, prop: id, role: 'landmark', at, yaw: 0, scale: [best.k, best.k, best.k], box: { min: box.min.map(r2), max: box.max.map(r2) }, centre: [at[0], r2(size[1] * best.k * 0.5), at[2]], top: r2(size[1] * best.k) };
  // the dressing keeps off its footprint
  const props = (layout.props ?? []).filter(p => Math.hypot((p.at?.[0] ?? 0) - at[0], (p.at?.[2] ?? 0) - at[2]) > footR + 1.2);
  props.push({ prop: id, at, rot: 0, scale: best.k, collider: 'mesh', landmark: true });
  // the seats: pairs round it that see each other past its footprint ('behind': across the near half, facing each other)
  const n = Math.max(2, layout.spawns?.length ?? 8), seats = [];
  const inside = (x, z) => Math.abs(x) < W / 2 - 1.2 && Math.abs(z) < D / 2 - 1.2;
  if (behind) {
    // rows of pairs facing each other across the near half, the landmark ahead of both
    for (let row = 0; seats.length < n && row < n; row++) {
      const z = r2(at[2] - best.rho - row * 3), x = r2(Math.min(W / 2 - 2, 5 + row));
      if (!inside(0, z)) break;
      seats.push({ x: -x, z }, { x, z });
    }
  } else {
    const rho = Math.min(best.rho, room), gap = 2 * Math.acos(clamp((footR + 0.8) / rho, -1, 1));
    // a pair spans less than the angle its line of sight would cut through the footprint, and about 12 m
    const pairs = Math.ceil(n / 2), span = Math.max(0.4, Math.min(gap * 0.9, 12 / rho, (2 * Math.PI / pairs) * 0.6));
    for (let p = 0; p < pairs; p++) {
      const a = (p * 2 * Math.PI) / pairs + 0.3;
      for (const t of [a - span / 2, a + span / 2]) {
        let x = r2(at[0] + Math.sin(t) * rho), z = r2(at[2] + Math.cos(t) * rho);
        // pulled in to stay inside the walls
        for (let q = 0; q < 8 && !inside(x, z); q++) { x = r2(at[0] + (x - at[0]) * 0.9); z = r2(at[2] + (z - at[2]) * 0.9); }
        seats.push({ x, z });
      }
    }
  }
  seats.length = Math.min(seats.length, n);
  const mark = { x: landmark.centre[0], z: landmark.centre[2] };
  const yaws = seats.map((s, i) => { const p = seats[i ^ 1] ?? null; return Math.round(framedYaw(s, p, mark, cam) * 1e4) / 1e4; });
  report.seats = seats.map((s, i) => ({ at: [s.x, 0, s.z], yaw: yaws[i], share: r2(boxShare(landmark.box, viewOf({ x: s.x, y: 0, z: s.z }, yaws[i], cam)) * 0.55) }));
  return { ...layout, props, spawns: seats.map(s => [s.x, 0, s.z]), spawnYaw: yaws, landmarks: [landmark], composition: report };
}
