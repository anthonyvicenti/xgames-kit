# Coin Hop (example)

A 2D platformer seen from the side: run along a stage of ledges, jump, and grab coins. The level is a tile map written in
the spec (`world.map`), the bodies are drawn pictures (gf-flat-1), and `rules.js` is 20 lines.

```bash
npx gamesfun create games/my-game --from coin-hop
npx gamesfun dev games/my-game
```

What it shows: the three runtime's `flat-2d` profile (the kit on a plane; camera `side`, so the plane is side-on), kind `drawn`, a tile map as a slot (`world.map` in
`config/world.json`; `node builder/tools/flat-map.mjs games/my-game` prints it and checks every ledge and
coin can be reached), and picture bodies with six frames (idle, walk1, walk2, air, act, down).

Provenance: games.fun's flat example Coin Hop, rules unchanged. The spec's
`rules.params.coinPoints` was taken out (2026-10-12): nothing read it, so its slot did nothing. A coin's worth is the
pickup's own `value` slot (`mechanic.pickup.value`).
Same owner as this kit (THIRD_PARTY.md).
