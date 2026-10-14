# The voxel world (`worlds/voxel`, a game's `gf/three/world/voxel/`)

A block world players change together and the play host keeps (CONTRACT §9). `config/world.json` →
`{ template: 'voxel', voxel: {...} }`; `create` writes it from `default.json`, the spec's `world.params` and the kind's
world preset (blocky: `runtimes/three/worlds/blocky-land.json`).

| File | What it does |
|---|---|
| `world.js` | `loadWorld(ctx, cfg)`: generates the land, lays the saved world over it, lights it, meshes it on workers, draws the land past the edge as scenery, one Rapier voxel collider; `world.voxel` (apply, pick, lightAt, remeshNow, store, …) |
| `terrain.mjs` | the land (generator 2): biomes by temperature and rainfall (plains, forest, birch, taiga, snowy, desert, mountains), hills, ridged mountains, beaches, lakes and the sea as water cells, caves (noise tunnels and caverns, never by open water), ores, amber crystals and glowcaps, oak, birch and spruce trees, cactus, grass, ferns and flowers, the spawn square. Deterministic from the seed; `fillRegion` fills any grid by its world origin, so the scenery meets the play area with no seam |
| `light.mjs` | sunlight (full straight down through clear cells, one less a step sideways) and coloured block light (lamps, lanterns, crystals, glowcaps), four 4-bit channels a cell; an edit relights a box round it and marks only the chunks whose light changed |
| `mesh.mjs` | one 16³ chunk → typed buffers per kind (solid, cutout, glass, glow, plant, liquid): culled faces, AO, smooth light (the mean of the open cells round each corner), the biome's grass and leaf colour, paint; the grid's edge culled against the land beyond |
| `mesh-worker.js` | the first mesh of the play grid, and the scenery strips made and lit start to finish, off the main thread |
| `grid.mjs`, `blocks.mjs`, `noise.mjs`, `signs.js` | the cells, the block table (light, filter, tint, kinds), seeded noise, signs |

**Block faces.** `voxel.faces: { size: 32, filter: 'pixel' }` draws every face as crisp pixels (the kit's own pack
`xk-voxel-blocks`, made by `runtimes/three/tools/voxel-faces.mjs`, CC0); `filter: 'smooth'` filters painted faces at
512 (256 on low). On a solid face, half-transparent texels take the biome's grass colour (the grass top and lip); a
cutout or plant face takes its block's `tint` everywhere.

**Light.** `voxel.light: { cave, block, spread, caveLight, haze, caveFog }`: how much of the sky's light reaches where
no sun does, how bright block light is and how widely it spreads (block light 0-1 is raised to `spread`: lower is wider
and softer), a cool even glow where no sky reaches (`caveLight: { color, strength }`, so cave walls keep their shape in
the dark, as eyes adjust in Minecraft), where the scenery past the edge fades into the look's fog, and the fog's colour
underground. The sun and sky of the look (time of day included) are scaled by each vertex's sunlight, so caves are dark
at noon and lanterns light them; block light adds its colour, so a cave has pools of amber (crystals, shards) and teal
(glowcaps) over the cool glow. Light colours mix per channel by the brightest (as DVE does), so the amber is kept
yellow and the glowcaps teal: an orange and a blue would meet as magenta. What gives off light also glows
(`voxel.glow`), enough for the look's bloom. When the camera has no sky above it the fog turns to `caveFog` and comes
nearer.

**Bodies in the light.** `world.lightAt(x, y, z)` → `{ sky, ambient, block: [r, g, b] }` is the light a body takes at a
point (blended over the eight cells round it). Any world may offer it: `kit/character/character.js` reads it every frame
and sets each body's own world-light uniforms (`kit/look/materials.js` `setWorldLight`), so players go dark in a cave
and take a lamp's colour beside it. A world without `lightAt` changes nothing.

**In the hand.** `world.voxel.heldMesh({ block } | { tool: 'pick' })` makes what a player holds, with the blocks'
materials; `mesh.userData.relight(x, y, z)` lights it where it is. The build mechanic shows it in first person (the
hotbar's block, painted while painting, a pick while breaking), bobbing as the player walks and swinging on a click.

**Speed.** 192 × 96 × 192 cells: about 0.15 s to generate, 0.1 s to light, the meshes on up to four workers; only
cells with an open side go into the collider; chunks past the view distance (200 cells high, 110 low) are hidden;
shadows follow the camera in 8-cell steps. Frame cost is measured with `runtimes/three/tools/voxel-shots.mjs --perf`.

**Multiplayer.** Unchanged from Blockhaven: the build mechanic (`components/build`) sends every edit to the host, the
host orders them and the play host saves them; every copy applies the same edits, so light and meshes follow on
every screen.

**Water is still (not built yet).** Breaking a bank does not let water flow. Flowing water is not cheap here, for one
reason: the play host saves only the edits players make, and a reloaded or late copy lays the saved cells straight into
the grid without running `apply`. Water that spreads by itself would make cells no edit names, so a fresh copy would
see dry ground where the others see water. Doing it right means one of: (1) the host runs the flow and sends the water
it makes as ordinary edits (the store keeps them; costs edit traffic and store space, about a cell an edit); (2) every
copy floods deterministically inside `apply` and again after `loadSaved`, from the same cells in the same order (no
traffic, but a flow rule that is the same on every machine, and a replay of the whole flood at every load); (3) water as
a rule-run simulation on the host with its own snapshot in the store. (1) is the smallest change; water levels would
live in the cell's tint bits (unused for water), a level per spread step up to 7, as Minecraft keeps them.

**Credits.** `LICENSE-three-voxel` (the three.js voxel example, BSD-3-Clause) and `LICENSE-dve` (Divine Voxel Engine,
MIT: the light flood, smooth light and terrain ideas) travel with the code.
