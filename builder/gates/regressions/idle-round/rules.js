// rules.js: THE GAME AGENT'S FILE. Critter Lob: what makes this game this game (builder/CONTRACT.md §3).
// Written by create.mjs as a stub from the spec; the kit already runs the home menu, the HUD, players, bots, the round and replay (CONTRACT §6g).
//
// Hook: Round little critters on a sunny lawn: lob seeds to bowl your friends over, and grab the berries before they do.
// Rules:
//   Hop about the lawn and grab berries: each one is a point, and the critter who takes it does a little
//   celebration. Lob a seed at a friend to bowl them over: they tumble, roll and pop back up a moment later. Most
//   berries when the time runs out wins.
// Scoring: +1 per berry
// Win: most berries when time is up
// Round: 90 s · players 1–3, bots fill empty seats
// Tuning numbers (config/game.json → rules.params, each a rules.* slot): {"cheerSeconds":1.2}
// Mechanics (ctx.mechanics.get(id); params in config/game.json → mechanics; what each offers is in setup() below):
//   projectile — "seeds lobbed at friends" {"kind":"discrete","color":"#ffb020","size":0.24,"speed":13,"arc":0.35,"muzzle":"hips","fireAnim":"throw","knockback":5,"knockUp":3.5,"knockSeconds":1.4,"cooldown":0.7}
//   pickup — "berries to collect" {"prop":"berry","effect":"score","value":1,"respawnSeconds":5}
//   health {"hp":0,"ragdollOnHit":true,"getUpSeconds":1.4}
// Controls (ctx.me.actions.<name>.pressed / .down):
//   primary: lob a seed
//   interact: grab a berry
//   jump: hop
// Not in v1: teams; more critters to choose from; more maps
// The creator will judge: friends see each other as different critters; a seed bowls a friend over and they get back up; berries score and the taker celebrates

export default {
  // Once on every copy, after the world, players and mechanics exist: register shared state, UI, listeners.
  setup(ctx) {
    // Each mechanic below offers these callbacks. Every handler is empty: write the ones this game needs and delete the
    // rest. "host" handlers run on the host's copy only (it owns the shared world); never change scores elsewhere.
    // ---- projectile — "seeds lobbed at friends": Discrete and continuous streams, arcs, hits, splash
    //   Nothing fires by itself: rules.js calls prj.fire(p) on a press, or prj.stream(p, down) every frame for a stream, for the player and for each bot.
    //   Shots land on the crosshair point. With the health mechanic a hit damages and knocks; waves and the boss register themselves as targets.
    //   Score in onHit (host): it hears counted hits only, so a helpless player is never farmed.
    //   state: window.__game.snapshot().shared.prj (what a test reads; the rules read it through prj's own methods) → l: [[id, x, y, z, vx, vy, vz, seat]] shots in flight; st: bots that are streaming
    //   worked: update(ctx) { if (ctx.me.actions.primary.pressed) prj.fire(ctx.me); }   // continuous: prj.stream(ctx.me, ctx.me.actions.primary.down)
    //   trap: prj.stream(p, on) is called every frame for an owned player, with on false too: a stream nobody turns off keeps running
    //   trap: a bot fires only when the rules make it: in bot(ctx, p) use ctx.bots.attack(p, target)
    const prj = ctx.mechanics.get('projectile');
    prj?.onHit?.(function onProjectileHit(e) {});   // host: a hit that counted (fair play let it through) · e = { kind: 'discrete' | 'stream' | 'splash', shooter, target | null, point, dir, damage, counted, projectile }
    prj?.onBlocked?.(function onProjectileBlocked(e) {});   // host: fair play refused a hit · e = { kind, shooter, target, why, projectile }
    prj?.onEnd?.(function onProjectileEnd(e) {});   // host: a shot ended (hit, wall, lifetime) · e = { projectile: { id, tag, meta }, shooter, reason, point }
    prj?.onSurface?.(function onProjectileSurface(e) {});   // host: the world was hit (paint listens) · e = { kind: 'discrete' | 'stream', shooter, point, normal, projectile }
    prj?.onFire?.(function onProjectileFire(e) {});   // every copy: a shot left a muzzle · e = { shooter, projectile, point }

    // ---- pickup — "berries to collect": Consumables that refill or modify a player's meters; respawn
    //   A spot is taken by walking into it or by a press of interact within reach; it comes back after respawnSeconds.
    //   effect says what a collect does by itself: auto (hand a carried item when the game has carry, else +value score), heal, score, carry, or none (your onCollect alone).
    //   Name the pickup's prop in the spec (a prop whose role says players pick it up): without one it is a stand-in gem, which the set-dressing lint fails.
    //   state: window.__game.snapshot().shared.pk (what a test reads; the rules read it through pk's own methods) → p: [[x, y, z, state]] per spot: state 1 = out, 0 = taken and waiting to come back
    //   worked: pk.onCollect(({ player }) => { player.data.ammo = (player.data.ammo ?? 0) + 5; });
    //   trap: with effect "score" (or auto without carry) a collect already adds value to the score: adding it again in onCollect counts it twice
    //   trap: bots take pickups only when the rules send them: in bot(ctx, p) use p.bot.seek(pk.nearest(p.position))
    const pk = ctx.mechanics.get('pickup');
    pk?.onCollect?.(function onPickupCollect(e) {});   // host: a player took a spot · e = { player, index, effect, value, point, how: 'touch' | 'press' | 'rules' }

    // ---- health: Health, knockback, ragdoll and get-up, respawn
    //   The kit's HUD already shows the local player's hit points, knocked-down state and protection: never draw them in rules.js.
    //   Projectile, melee, waves and the boss call hp.damage themselves; rules.js calls it only for its own hazards.
    //   hp 0 means no hit points: a hit only knocks over. respawnSeconds 0 means out for the round.
    //   state: window.__game.snapshot().shared.hp (what a test reads; the rules read it through hp's own methods) → h: { playerId: hit points }
    //   worked: hp.onDamage(d => { if (d.from && d.knocked) d.from.score += 1; });
    //   trap: hp.damage returns false and onDamage stays silent when fair play refuses the hit (the target is down or protected, or the round has just begun): do not score outside onDamage
    //   trap: a hit that repeats every frame (a hazard, contact) passes { push: true }, so it shoves and never knocks over
    const hp = ctx.mechanics.get('health');
    hp?.onDamage?.(function onHealthDamage(e) {});   // host: a hit that counted (fair play let it through) · e = { target, from, amount, hp, lethal, knocked, source }
    hp?.onDown?.(function onHealthDown(e) {});   // host: a player ran out of hit points · e = { target, from }
    hp?.onRespawn?.(function onHealthRespawn(e) {});   // host: a player came back · e = { player }
    hp?.onHurt?.(function onHealthHurt(e) {});   // every copy: a player's hit points changed · e = { player, hp, delta }
  },
  // Every copy, when the round starts (the same moment for everyone).
  roundStart(ctx) {},
  // Every frame on every copy. Keep host-only logic under `if (ctx.host)`.
  update(ctx, dt) {},
  // A gameplay event from another copy (ctx.net.send(name, data, to) on their side).
  event(ctx, name, data, from) {},
  // Host only: is the round over? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at round end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
