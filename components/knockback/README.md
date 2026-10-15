# mechanic: knockback

Physical chaos as a shared part: a blast throws every body near it. A humanoid goes limp on its ragdoll, a creature
tumbles as one body, a loose prop (one of the world's scenery props the spec names) flies; each bounces on landing, rests
a moment and gets up. A body thrown fast bowls over the bodies it passes (chains). Any game picks it through its spec:
`{ "id": "knockback", "params": { "force": 16, "up": 0.8, "props": ["crate"] } }`.

## How a flight is the same on every screen
The host simulates each flight once, against the world's own colliders (a sphere cast per step: gravity, bounces with
`bounce` and `friction`, rest after `settle`, the sea, out of bounds; `logic.js simulateFlight`), and sends the whole path
once (`knockback:fly`: keys in centimetres and milliseconds, about 1–2 KB). Every copy plays that path from when it
arrived: the owner's copy of a player rides it (`controller.carry`), and every copy steers the player's ragdoll or tumble
onto it (`character.steer`), so the limbs flop on their own while the body goes where the host said. Measured over real
WebRTC (`tests/chaos-two-players.mjs`): each screen draws the thrown body about 0.02 m from the path; the two screens
draw it within about 0.1 m of each other at the same moment of the flight; the landing is identical.

## API
- Host: `kb.blast(at, { radius, force, up, falloff, damage, from, source })` → the bodies thrown; `kb.fling(player |
  key, { x, y, z }, { from })`; `kb.lastHitBy(p)` → `{ from, at }` within `creditSeconds`.
- Every copy: `kb.flying(p)`, `kb.pathAt(p)` (QA: the path now and the drawn body), `kb.onBlast`, `kb.onFling`,
  `kb.onLand`, `kb.onSplash`, `kb.onSettle`.
- With the projectile mechanic, a splash (`splashRadius > 0`) throws through here (`fromProjectile`); the projectile's
  hits then only hurt. With the health mechanic, `damage` is passed on (fair play refuses what it refuses: then nothing
  flies). With ctx.juice, each blast and hard landing shakes, stops time an instant, and slows it on a big hit near this
  screen's player (within the player's Reduce motion setting).

## Params
`radius`, `force` (m/s for a body of mass 1 at the centre), `up` (upward tip), `falloff` (smooth, linear, flat),
`damage`, `gravity`, `bounce`, `friction`, `settle`, `chain`, `chainSpeed`, `chainShare`, `masses` (per body kind:
humanoid, blob, worm, quadruped, flyer, prop), `props` (scenery props that are loose), `fromProjectile`,
`creditSeconds`, `juice`, `landFx`, `splashFx` (vfx presets), `sound`, `landSound`, `splashSound`.

## Network ownership
Host owns every flight and who threw whom. Shared state `kb.o`: loose props a blast moved (a late copy places them).
Messages: one `knockback:fly` per thrown body, one `knockback:blast` per blast.

Tests: `tests/knockback.test.mjs` (pure), `tests/chaos-two-players.mjs <game>` (two browsers over WebRTC).
