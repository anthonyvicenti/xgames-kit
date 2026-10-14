// Three Harbours: sail between three islands with friends and land a fish at each harbour. The vista runtime plays the
// islands (each generated from its seed and words in spec.json → world.islands), the boat, the fishing and the trip
// between islands (take the helm, sail out past the reef toward an island on the horizon: the screen eases out and you
// arrive aboard at its dock, friends with you). This file holds the score, the harbours landed at and the gate a trip
// asks: a fish landed at this harbour first.
// Events reach event() on the copy where they happened: catch {species, name, kg, cm, value}, hop-start {from, to},
// hop-done {from, to, name, ms}, and the others (bite, hooked, lost, sold, bought, board, leave).
// ctx.vista.game.island() → the island's index; ctx.shared holds what every copy sees (the host writes it).
let need = 3;   // harbours to land a fish at (rules.params.harbours, the rules.harbours slot)
const landedHere = new Set();   // islands this copy's player has landed a fish at

export default {
  setup(ctx) { need = Number(ctx.config.rules?.params?.harbours) || 3; },
  roundStart(ctx) { for (const p of ctx.players.list()) p.score = 0; landedHere.clear(); },
  event(ctx, name) {
    if (ctx.round.phase !== 'playing' || name !== 'catch') return;
    const at = ctx.vista.game.island();
    ctx.me.score += landedHere.has(at) ? 1 : 4;   // a fish, and the first one at a harbour counts three more
    landedHere.add(at);
    if (landedHere.size >= need) ctx.finish('voyage');
  },
  // a trip leaves only once this player has landed a fish here (a friend's ask reaches the host already checked)
  canHop(ctx, to, info) {
    if (info?.by && info.by !== 'me') return true;
    return landedHere.has(ctx.vista.game.island()) ? true : 'Land a fish here before you sail on';
  },
  update() {},
  check() { return null; },
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
};
