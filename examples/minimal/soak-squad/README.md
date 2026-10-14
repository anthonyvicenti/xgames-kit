# Soak Squad (example)

A backyard water fight for 1–8 players (bots fill empty seats). Grab a bucket to fill your tank, hold fire to spray:
the lawn you soak turns your colour and counts as your turf, and soaking a friend knocks them about and steals some
of their points. Most points when the bell rings wins.

```bash
npx gamesfun create games/my-game --from soak-squad
npx gamesfun dev games/my-game
```

What it shows:
- **Mechanics, not hand-written physics.** `projectile` (a continuous stream that lands under the crosshair), `pickup`
  (buckets taken with E), `paint` (turf from the stream) and `health` (soaked players are pushed about), all configured
  from `spec.json`. `rules.js` is about 80 lines: only what makes this game this game.
- **Host-owned state.** The host scores once a second from paint coverage; a bucket taken by a player another copy
  simulates is an event sent to that copy (an edge, never per frame).
- **Fair play.** Steals count only in `projectile.onHit` (refused hits never arrive), and bots pick targets with
  `ctx.bots.target` / `ctx.bots.attack`.
- **Every number is a slot.** `tankSeconds`, `bucketFill`, `stealPoints` and `stealCooldown` are `rules.*` slots
  (`config/game.json` → `rules.params`): `npx gamesfun slots set rules.tank-seconds 10` changes the tank, no code.

Provenance: adapted from "Bladder Brawl", a game games.fun's Studio v2 built and delivered (2026-10-07); re-themed as a
water fight, with its tuning numbers moved into rules params. Same owner as this kit (THIRD_PARTY.md).
