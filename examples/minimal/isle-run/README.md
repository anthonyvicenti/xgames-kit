# Isle Run (example, three/scenic-3d)

A co-op action run for 1–4 players (bots fill empty seats) on the three runtime's scenic-3d profile: knights fight skeleton warriors,
archers and brutes across three floating isles joined by portals, then face the Bone Sorcerer.

```bash
npx gamesfun create games/my-game --from isle-run
npx gamesfun dev games/my-game
```

What it shows:
- **`"runtime": "three", "profile": "scenic-3d"`, loop `run`, kind `scenic` in the spec.** The scenic look and a generated world (`isles`, one island per level), the
  `follow` camera, and the scenic library's KayKit bodies, weapons and dungeon props (CC0). It draws with WebGPU; in a
  Chrome without a WebGPU adapter it runs on WebGL2 inside the same renderer.
- **A game that is all mechanics.** `melee` (sword combos, a heavy strike, a dodge roll), `waves` with three enemy
  types, `health`, `levels` (a portal opens when an isle is clear), `boss` and `loot`, every one configured in
  `spec.json`. `rules.js` is fifteen lines: only the results card. Start here when your idea is "an action game with
  levels and a boss", and add to `rules.js` what the mechanics do not say.
- **Every model and number is a slot.** The four bodies, each weapon, the boss's name and health, the wave sizes:
  `npx gamesfun slots list games/my-game --all`.

**Checks.** A fresh create passes `verify --quick` and `verify --quick --release`, checks 24 (plays inside a post) and
34 (watch then play) included: games.fun fixed the `follow` camera's two faults. With `"camera": "third"` or `"orbit"` the same spec has failed checks 13 and 16 (a melee swing does not go
where those cameras aim), so the profile's own camera stays.

Provenance: games.fun's scenic sandbox spec (`runtimes/three/profiles/scenic-3d/specs/sandbox.spec.json`), with the prompt
reworded. Same owner as this kit (THIRD_PARTY.md).
