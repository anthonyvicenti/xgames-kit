# Crater Isles (example)

An artillery party round on the terrain world: three grassy islands in a sea, cliffs that show the soil, and bombs that
carve round craters wherever they land, the same on every screen. Knock friends with blasts, knock them into the sea for
more.

```bash
npx gamesfun create games/my-isles --from crater-isles
npx gamesfun dev games/my-isles
```

What it shows: the terrain world (`worlds/terrain`: smooth ground on a signed-distance field, surface-nets meshes on a
worker, the top and soil pictures from the kit's pack `xk-terrain`), the carve mechanic (every projectile splash carves;
the host keeps the ground the same everywhere, a late joiner is sent the craters), the projectile mechanic's lobbed
bombs. `rules.js` scores knocks and splashes.

Provenance: written for this kit (2026-10-14). Same owner as this kit (THIRD_PARTY.md).
