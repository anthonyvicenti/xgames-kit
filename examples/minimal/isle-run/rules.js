// Isle Run: knights clear three floating isles of skeletons and beat the Bone Sorcerer.
// The scenic engine's action mechanics already are the game: `waves` sends the skeletons and scores each kill, `melee`
// is the sword, `levels` opens a portal when an isle is clear, `boss` is the last fight and `loot` drops coins, potions
// and upgrade cards. So this file holds only what the spec's mechanics do not say: the results card, best score first.
// Adapted from games.fun's scenic sandbox spec (runtimes/three/profiles/scenic-3d/specs/sandbox.spec.json; THIRD_PARTY.md).
export default {
  setup() {},
  roundStart() {},
  update() {},
  event() {},
  check() { return null; },   // the levels mechanic ends the run: the boss beaten, or everyone down at once
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
};
