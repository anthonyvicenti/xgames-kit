// Lantern Cove: fish off an island pier at sunset; the evening ends when one of you has landed four kinds of fish.
// The vista engine's core already is most of the game: it plays the island (walk, swim, the boat) and the fishing (cast,
// bite, the catch, the cooler, the fish stall, the tackle hut) from the data tables in spec.json → vista, and draws the
// sky, the sea and the light from config/look.json. So this file holds only the score and the goal.
// Events reach event() on the copy where they happened (each player fishes on their own copy):
//   bite, hooked, catch {species, name, kg, cm, value}, lost, sold {sold, money}, bought {id, money}, board, leave.
// ctx.vista.state() → {money, cooler, rod, fight, near, catches, log}; ctx.finish(reason) ends the session for everyone.
// Adapted from games.fun's vista development spec (runtimes/vista/specs/thin-cove.spec.json; THIRD_PARTY.md).
let goal = 0;   // how many different kinds of fish end the evening (rules.params.goalSpecies, the rules.goalSpecies slot)

export default {
  setup(ctx) { goal = Number(ctx.config.rules?.params?.goalSpecies) || 0; },
  roundStart(ctx) { for (const p of ctx.players.list()) p.score = 0; },
  event(ctx, name) {
    if (ctx.round.phase !== 'playing' || name !== 'catch') return;
    ctx.me.score += 1;   // one point a fish landed: the results show each player their own
    if (goal > 0 && Object.keys(ctx.vista.state().log ?? {}).length >= goal) ctx.finish('goal');
  },
  update() {},
  check() { return null; },   // the clock (round.seconds) or the goal above ends the evening
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
};
