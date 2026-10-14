# mechanic: projectile

Discrete shots (a thrown ball, a dart) and a continuous stream (water gun, hose, paint, spray) with an arc, hit callbacks, knockback and splash.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "projectile", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`kind` (`discrete`|`continuous`), `prop`, `color`, `size`, `speed`, `arc`, `gravity`, `lifetime`, `cooldown`, `maxActive`, `damage`, `knockback`, `knockUp`, `knockSeconds`, `splashRadius`, `bounces`, `friendlyFire`, and the `stream*` set (`streamSpeed`, `streamGravity`, `streamReach`, `streamWidth`, `streamRate`, `streamSpread`, `streamDamage`, `streamKnock`, `streamHitInterval`, `streamTank`), and `muzzle`: where shots and the stream leave the body, `chest` (the default: 1.2 m up, 0.5 m ahead; a throw, a water gun, a hose) or `hips` (the character's hip height, `character.hipHeight`, 0.3 m ahead; **a pee stream**). Schema and defaults: `index.js` `params`.

## Slots
`mechanic.projectile.color` (the colour of the ball primitive, the drops and the stream; tags the visible meshes; a player look, `scope: "player"`, CONTRACT §6e: each shooter's balls, drops, stream and splashes are drawn in that player's own loadout colour when they have one, on every copy, and `lookOf(p)` reports what this copy draws), `.speed`, `.knockback` ... one value slot per tunable (kebab-case ids, e.g. `.stream-speed`). A shot is drawn with the model slot `prop.<params.prop>` when the game has that prop (the spec's gameplay prop), else a coloured ball. With the real look the drops use its `liquid` material.

**The stream** is drawn as one liquid arc: the look's `createStream` (a tapered tube on the ballistic arc in the house `liquid` material, droplets peeling off it and a splash where it lands), one per streaming player, tinted by `.color`, its thickness from `.stream-width`. The front leaves the nozzle at the stream's speed; on release the tail keeps flying along the same arc and drains into where it was going. Each copy ends the drawn arc where it meets a body it draws (cosmetic; the host's hit test decides hits) or the world, and splashes there once the front arrives; that body makes its hurt face (`character.express('hurt')`, RIG.md §3) while the stream is on it, and a body a shot hits winces for 0.7 s. Finer spray drops ride along it. Without a look module (stand-in, Node) the drops alone are the stream. Nothing new goes on the wire.

## Aim (CONTRACT §6d, kit/core/aim.js)
`fire(p)` and `stream(p, on)` with no direction go to the player's crosshair point (`aimTarget(p)`): the shot or stream
leaves the muzzle on the low arc that lands there at this mechanic's speed and gravity (a stream within `streamReach`; a
thrown shot's centre aims `size` above it so the ball touches down on it), or lands as far toward it as it can. Every
copy draws the same arc from position + aim + `aimDist` (the pose's `ad`). Bots, the top camera and `fire(p, dir)` with
a direction keep the old way: along the aim, with the `arc` lob. `landing(p)` says where a player's shots land (QA:
verify check 13). The instance has `aimed: true`, so the kit shows the crosshair.

## Fair play (CONTRACT §6c, kit/core/fair.js; on by default)
- A hit on a player who can't be hit does nothing, with no damage, push or knock. That is a player who is down, out or protected, a hit in the start grace, or a bot's hit on a human another bot is fighting.
- `onHit` never hears of such a hit; `onBlocked` does, with `why`. Every `onHit` carries `counted: true`, so rules that score there can't farm a helpless player.
- Stream ticks push (`health.damage(…, {push: true})`, or `p.push`) and never knock over. Discrete hits and splashes knock, for `fair.downSeconds` in all.

## Network ownership and message rates
**Host owns** every discrete shot (position, hits, splash, end) and every stream hit. **A player's copy owns** its own aim, its trigger and its tank. Shots travel in `ctx.shared` key `prj`: `l` = `[id, x, y, z, vx, vy, vz, seat]` per shot (about 45 B; `maxActive` caps it at 20 = 0.9 KB, default 12 = 0.55 KB). Other copies integrate the arc locally between snapshots (no per-frame position traffic). Events: `projectile:fire` (player copy -> host, once per throw, at most 1/cooldown per player, about 2/s), `projectile:fx` (host -> all, once per hit or wall touch, burst of at most about 4/s). A stream sends nothing of its own: the owner sets `poseExtra.st` (rides the 15/s pose), bots' streams are listed in `prj.st`; every copy draws the same path from position + aim, the host does the hit tests. Peak: about 2 events/s per firing player + 4 fx/s from the host, well under 60/s.

**Bodies** are every player where this copy has them: the players it owns (the host's own player and every bot) and the friends it draws from their poses. (Until the wave-1 polish track the filter was `drawn` alone, which K1 sets on friends only: shots and streams passed through the host's own player and every bot. The 2-player fixture only ever threw at a joiner; `tests/p-projectile-game.mjs` throws at a stationary bot in a game made from the real dev spec.)

**Rapier** is read through `kit/core/util.js` `physicsOf(ctx)`: `ctx.physics` may be K1's bare `World` (+ `ctx.RAPIER`) or `{ RAPIER, world }`.

## Netcode traps (PLAN 2.6)
Sweep: a shot is tested between where it and each body were last frame and are now (relative-motion sweep, `sweepHit`), against three spheres per body; speed is capped at 45 m/s; hits are tested against where the body is drawn, so what you see is what hits. Remote reactions are edges: the burst and the sound fire from the one `fx` event, never from a per-frame check. Nothing here pauses for hit-pause.

## Methods for rules.js
- `fire(player, dir?, {speed, tag, meta})` -> bool. `prj.fire(ctx.me)` (aims along the player's aim). `tag` rides to the host (`h.projectile.tag`).
- `stream(player, on)` every frame for an owned player: `prj.stream(ctx.me, ctx.me.actions.primary.down)`.
- `streaming(player)`, `tankOf(player)` 0..1, `pathEnd(player)`, `landing(player)`, `active()`.
- Host: `onHit(fn)` `{kind: 'discrete'|'stream'|'splash', shooter, target|null, point, dir, damage, counted: true, projectile}` (counted hits only); `onBlocked(fn)` `{…, why}`; `onEnd(fn)`; `onSurface(fn)` (the world was hit: paint listens); `addTargets(provider)` (waves registers enemies); every copy: `onFire(fn)`.

Example: `prj.onHit(h => { if (h.target && h.kind === 'discrete') h.shooter.score += 1; });` and `if (me.actions.primary.pressed) prj.fire(me);`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-projectile.test.mjs`. Owned targets, both physics shapes, walls and the liquid arc: `research/gf-three/tests/p-mechanics.test.mjs`. In a real created game: `node research/gf-three/tests/p-projectile-game.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs projectile` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: a throw hits the other, the burst appears at the same point on both screens, the target is knocked over and loses hit points on both copies; a held stream is visible on the other copy, ends in the same place, damages the target, stops everywhere.
