# mechanic: aim

A ballistic aim any game can use. This screen's player holds primary to charge the power and lets go to fire; the view's
pitch sets the elevation (`angleLift` degrees above where the view looks); the wind (per turn, round or shot, at most
`wind` m/s² sideways) pushes every shell and shows on the HUD's wind strip; a trajectory preview (`preview`: full,
short, none) shows where the shot goes at the power being charged; the angle and power dials are on the kit HUD;
weapons are data (`weapons`: speed, gravity, wind, fuse and bounces, blast radius, force, damage, crater, ammo, colour)
on the HUD's weapon wheel (secondary opens it; the number keys pick).

A shell is the host's (a player's copy sends its aim, power and weapon). Where it goes off: the knockback mechanic throws
whoever is near, the carve mechanic bites a crater (`carveScale` per metre of blast), the effect style draws the blast
(plus `explodeFx`), ctx.juice shakes; in the water, `splashFx`.

In a `turns` game the part joins the flow (`ctx.turns.drive`): only the current player aims (`holdOthers`: the others
hold still), the camera follows the shot on every screen (`follow`; then the blast, then the body it threw farthest), and
the turn passes once everything has come to rest for `settleSeconds`. In a real-time game each player fires on
`cooldown`.

Bots: `rules.bot` calls `aim.bot(p)`: it solves the shot with the wind (`logic.js solveShot`), misses by `botError`,
charges in plain view and fires.

API: `fire(p, {power, yaw, elevation, weapon})`, `bot(p)`, `weapons()`, `select(p, id)`, `weaponOf(p)`, `wind`,
`setWind(w)` (host), `mayFire(p)`, `onFire`, `onExplode` (host), `onTurnDone` (host).

Network: shared `aim` {w: wind, s: shells in flight, n: fired, x: gone off, a: ammunition}; messages `aim:fire` (to the
host) and `aim:x` (a blast, to everyone).

Tests: `tests/aim-juice.test.mjs` (pure), `tests/chaos-two-players.mjs <game>` (turns over WebRTC, real input).
