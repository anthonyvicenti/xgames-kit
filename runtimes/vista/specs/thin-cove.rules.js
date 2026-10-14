// rules.js: THE GAME AGENT'S FILE. Lantern Cove: what makes this game this game, on the vista engine (builder/CONTRACT.md §8 vista).
// Written by create.mjs from the spec. The kit already plays the island (walk, swim, the boat), the fishing (cast, bite,
// the catch, the cooler, the buyer, the shop) from the data tables (config/game.json → vista), the look
// (config/look.json), the HUD, the menu and friends. Tune numbers there.
//
// Hook: Fish off a quiet island pier as the sun goes down, sell what you land, and fill the logbook with friends.
// Rules:
//   Walk out along the pier at sunset, cast from the pier head, the beach or the boat, land fish, sell them at the
//   fish stall and buy better tackle. The evening ends when one of you has landed four different kinds of fish.
// Scoring: +1 for every fish landed
// Win: Land four different kinds of fish before the evening is over.
// Session: at most 900 s · players 1–4, together on one island
// Tuning numbers (config/game.json → rules.params, each a rules.* slot): {"goalSpecies":4}
// Controls (the core's own: WASD walk, mouse look, R the rod, hold and release the left button to cast, E to board,
// take the helm and trade; How to play lists them):
//   primary: cast, strike and reel
//   interact: board the boat, trade at a stall
// Not in v1: a coast of our own (the core's island is the one world); a shared boat ride (each player's boat is their own); a catch journal that lasts between sessions
// The creator will judge: the sunset over the sea looks like a real coast; you can walk the pier, cast and land a fish; friends see each other on the pier
//
// What the rules can use (ctx): ctx.vista.state() → {money, cooler, rod, fight, near, catches, log}; ctx.vista.sell(),
// ctx.vista.buy(id); ctx.vista.look.set({hour, sea, exposure}); ctx.vista.tables (the filled data tables); ctx.me (this
// copy's player: its score is what the results show); ctx.finish(reason) ends the session for everyone with the results.
// Events reach event(ctx, name, d) on the copy where they happened (each player fishes on their own copy):
//   bite, hooked, catch {species, name, kg, cm, value}, lost, sold {sold, money}, bought {id, money}, board, leave.
// Never touch the core (gf/vista/core) or the kit; never draw your own HUD over the kit's.
export default {
  // Once on every copy, after the island, the players and the HUD exist.
  setup(ctx) {},
  // Every copy, when the session starts.
  roundStart(ctx) { for (const p of ctx.players.list()) p.score = 0; },
  // A game event on this copy (see above), or a message another copy sent with ctx.net.send.
  event(ctx, name, d) {
    if (ctx.round.phase !== 'playing') return;
    // score: one point a fish landed (the results show each player's own)
    if (name === 'catch') {
      ctx.me.score += 1;
      // the goal: this many different kinds of fish (rules.params.goalSpecies), then the session ends for everyone
      const goal = Number(ctx.config.rules?.params?.goalSpecies) || 0;
      if (goal > 0 && Object.keys(ctx.vista.state().log ?? {}).length >= goal) ctx.finish('goal');
    }
  },
  // Every frame on every copy.
  update(ctx, dt) {},
  // Host only: is the session over for another reason? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at the end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
