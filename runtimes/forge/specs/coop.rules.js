// rules.js: THE GAME AGENT'S FILE. Forge Co-op: track S's live co-op sandbox (research/rust-engine/PLAN.md §4 S).
// The kit runs the home menu, the HUD, the round, the first-person walk (the Rust core), live co-op (the host's core
// owns every player, joiners predict their own) and the room; this file only says how a round is scored.
//
// Scoring: every rules.params.metresPerPoint metres a player walks scores them a point, counted by the host from where
// its core has each player (so a joiner scores what the host saw it walk: the proof that the host's core moves them).
// The round ends on its clock. (Kept in runtimes/forge/specs/coop.rules.js and copied in after create.)

const step = ctx => Number(ctx.config.rules?.params?.metresPerPoint) || 3;

export default {
  setup(ctx) {
    ctx.ui.goal?.('Explore the crypt with your friends');
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) { p.score = 0; p.data.walked = 0; p.data.last = null; }
  },
  update(ctx) {
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    for (const p of ctx.players.list()) {
      const at = { x: p.position.x, z: p.position.z }, last = p.data.last;
      p.data.last = at;
      if (!last) continue;
      const d = Math.hypot(at.x - last.x, at.z - last.z);
      if (d > 2) continue;                       // a respawn or a teleport is not a walk
      p.data.walked = (p.data.walked ?? 0) + d;
      p.score = Math.floor(p.data.walked / step(ctx));
    }
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): how far each player has walked, as the host counts it
  observe(ctx) {
    return { walked: Object.fromEntries(ctx.players.list().map(p => [p.id, Math.round((p.data.walked ?? 0) * 100) / 100])) };
  },
};
