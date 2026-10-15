// Places in a terrain world for a camera that must show one kind of view (the look judge's place requests:
// __gfLook.view({ where }) asks ctx.world.lookout(where)). The finders are the outdoor lookouts (../lookouts.mjs) over the
// field's ground height: a flat seat, a sunlit rise, a cliff edge, a beach, an open sea view. Pure.
//
//   placeFor({ field, seaLevel, spawns, clear }, where) → { eye, target, fov, setting, where, score } | null
//   clear(from, dir, max): the world's ray (its colliders: the ground, set pieces, set dressing); a view blocked near the
//   camera is passed over for the next best (lookouts.mjs viewClear)
import { lookout } from '../lookouts.mjs';

export function placeFor({ field, seaLevel = 0, spawns = [], clear = null }, where) {
  const b = field.bounds;
  return lookout({ heightAt: (x, z) => field.heightAt(x, z), seaLevel, bounds: [b.min[0], b.min[2], b.max[0], b.max[2]], seats: spawns.map(s => ({ x: s.x, y: s.y, z: s.z, yaw: s.yaw })), clear }, where);
}
