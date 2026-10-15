# mechanic: hazards

The ways a body leaves the play for a moment: into the water (the world's sea or `waterAt`), out past the world's edge
or below its floor, and hard landings that hurt (`fallDamage` per m/s over `fallSafe`, through the health mechanic). The
host decides; every copy shows the splash and holds the body under the surface; after `respawnSeconds` the player comes
back on dry ground every seat can reach (the world's placement API, `world.place('respawn', …)`, when the world has it;
else their own seat while its ground is still above the water), protected for `protectSeconds`.

```js
const hz = ctx.mechanics.get('hazards');
hz.onFall(e => { if (ctx.host && e.by && e.by !== e.player) e.by.score += 3; });   // {player, cause, by, at}
```

With the knockback mechanic, `by` is whoever threw the player last (within its creditSeconds), and a thrown body's hard
landings hurt through the same fall damage.

API: `onFall` (host), `onBack` (every copy), `onHurt` (host), `isOut(p)`, `takeOut(p, cause)` (host: a game's own
hazard), `spotFor(p)`. Params: `water`, `waterDepth`, `out`, `outMargin`, `floor`, `respawnSeconds`, `protectSeconds`,
`fallDamage`, `fallSafe`, `splashFx`, `splashSound`, `fallSound`, `backSound`, `toast`, `textWater`, `textOut`.

Network: the host sends `hazards:out` and `hazards:back`; a player's copy sends `hazards:land` for its own hard landing.
