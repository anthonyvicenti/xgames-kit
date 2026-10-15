# Tower Isles (example)

An artillery party round on a composed level (looks wave 4): the terrain world's islands with their landmarks as the
playfield. A ruined tower stands on the middle island with a level plaza round it, a gatehouse crowns the next island,
and a wooden bridge spans the gap between them. All three are ground: players stand on them and walk the bridge, shots
end on them, and a bomb that hits the tower bites a crater out of it on every screen (the carve mechanic's edit log,
the host owns it). The seats come in pairs that see each other and the tower, each facing its partner with the tower
in view, and the camera leans toward the tower when it is in view.

```bash
npx gamesfun create games/my-towers --from tower-isles
npx gamesfun dev games/my-towers
```

What it shows: `world.params.compose` (worlds/terrain/compose.mjs: the landmarks and bridges made ground by
worlds/terrain/piece.mjs, the seats placed round them), the clipped landmark models (worlds/terrain/world.js), the
camera's lean (worlds/compose.mjs `leanToward`, kit/controller/camera-rig.js). The pieces are the library's: the ruined
tower and the gatehouse from `forge-world` (CC0, this kit's own), the bridge from `folio-nature` (MIT, Bruno Simon).
`rules.js` is Crater Isles' (knocks and splashes score).

Provenance: written for this kit (2026-10-14). Same owner as this kit (THIRD_PARTY.md).
