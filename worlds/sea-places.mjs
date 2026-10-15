// Places in a sea-islands world (sea.js) for a camera that must show one kind of view (the look judge's place requests:
// __gfLook.view({ where }) asks ctx.world.lookout(where)): the outdoor lookouts (lookouts.mjs) over the layout's ground
// height, within the play island and its shore. Pure.
//
//   placeFor(layout, where, { clear }) → { eye, target, fov, setting, where, score } | null (clear: the world's ray,
//   lookouts.mjs viewClear: a view blocked near the camera is passed over)
import { lookout } from './lookouts.mjs';
import { heightAt, edgeOf } from './sea.js';

export function placeFor(layout, where, { clear = null } = {}) {
  if (where === 'beach') return beachPlace(layout);
  const main = (layout.islands ?? []).find(i => i.play) ?? layout.islands?.[0];
  const R = (main?.shape?.radius ?? 30) * 1.4;
  const c = main?.at ?? [0, 0, 0];
  return lookout({ heightAt: (x, z) => heightAt(layout, x, z), seaLevel: layout.sea?.level ?? 0, bounds: [c[0] - R, c[2] - R, c[0] + R, c[2] + R], seats: (layout.spawns ?? []).map(s => ({ x: s[0], y: s[1], z: s[2] })), clear }, where);
}

/** The play island's beach (the sand collar islands.js draws at the cliff's foot, outside the land's height): on the
 *  sand where the shore is lowest, looking along it toward the land. */
function beachPlace(layout) {
  const isl = (layout.islands ?? []).find(i => i.play);
  if (!isl || !(isl.beach > 0.2)) return null;
  const sea = layout.sea?.level ?? 0, a = isl.falls?.[0]?.a ?? 0, R = edgeOf(isl, a) + 0.4 + isl.beach * 0.5;
  const eye = [isl.at[0] + Math.cos(a) * R, sea + 0.3 + 1.6, isl.at[2] + Math.sin(a) * R];
  // along the shore, turned in toward the land
  const along = a + Math.PI / 2, dir = [Math.cos(along) * 0.8 - Math.cos(a) * 0.6, Math.sin(along) * 0.8 - Math.sin(a) * 0.6];
  const r2 = v => Math.round(v * 100) / 100;
  return { where: 'beach', setting: 'day', eye: eye.map(r2), target: [r2(eye[0] + dir[0] * 20), r2(eye[1] + 0.5), r2(eye[2] + dir[1] * 20)], fov: 60, score: r2(isl.beach) };
}
