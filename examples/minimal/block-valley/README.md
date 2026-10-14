# Block Valley (example)

A block world everyone shares, in the blocky kind: generated land with plains, forests, birch woods, taiga, snow,
desert and mountains, caves lit by glowcaps and amber crystals, lakes and the sea, and the same land going on past the
edge into the haze. Players place, break and paint blocks, light caves with lanterns, put up signs and set off boom
blocks; the host puts every edit in order and the play host keeps them.

```bash
npx gamesfun create games/my-world --from block-valley
npx gamesfun dev games/my-world
```

What it shows: the world loop on the voxel world (`worlds/voxel`: sunlight and coloured block light that spread
through the cells, smooth per-vertex light and ambient occlusion, meshing on workers, the kit's own pixel faces from the
asset library pack `xk-voxel-blocks`), the blocky kind's world preset (`runtimes/three/worlds/blocky-land.json`) and
the build mechanic. `rules.js` is empty: the kit runs it all.

Provenance: written for this kit (2026-10-13), after games.fun's Blockhaven. Same owner as this kit (THIRD_PARTY.md).
