// Block Valley: a block world everyone shares. The kit runs all of it: the land (worlds/voxel: biomes, caves, light),
// the build mechanic (place, break, paint, signs, boom blocks; the host puts every edit in order and the play host
// keeps them), the players and the world card. This file adds nothing yet: a world game's own rules go here.
export default {
  setup() {},
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
