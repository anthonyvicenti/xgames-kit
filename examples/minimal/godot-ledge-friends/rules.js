// rules.js: THE GAME AGENT'S FILE. Ledge Friends on runtime godot. The kit runs the round, the clock, the friends
// and the results; the Godot project (project/main.gd) runs the stage and the players. What happens in the game reaches
// here as rules.event(ctx, name, data, 'godot') (GF.event in GDScript), on the copy where it happened; the host owns
// the scores and ctx.shared, which the game reads as GF.shared.
export default {
  setup(ctx) {},
  event(ctx, name, data, from) {},
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
