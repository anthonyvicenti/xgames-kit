# Market Day (example)

A town square seen from above, in the pixel kind: walk around the houses, the well and the pond and grab more coins
than your friends. The town is a tile map written in the spec (`world.map`), drawn in the kind's own art.

```bash
npx gamesfun create games/my-game --from market-day
npx gamesfun dev games/my-game
```

What it shows: the three runtime's `flat-2d` profile seen from above (camera `top`), kind `pixel`, and what a top-down
map can ask for (`runtimes/three/profiles/flat-2d/drawplan.js`): soft path, soil, cobble and pond borders (`"edges":
"blend"`), a fence that joins itself (`"edges": "connect"`), flowers and tufts in the grass and crops in the soil
(`"dress"`), and set pieces (`"piece"`: two houses, trees, a well, barrels, a lamp) that a walker passes behind or in
front of. The bodies are the kind's villagers (gf-flat-1, six frames in four facings); the player's light grey shirt
takes each seat's colour. Every picture is a slot.

Provenance: written for xgames-kit (2026-10-13); the town is `runtimes/three/worlds/pixel-town.json` with spawns and
coin marks added. All art is the kit's own (CC0, `runtimes/three/tools/pixel/`).
