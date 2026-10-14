# scenic-3d: the three runtime's scenic profile

The three runtime's profile for stylised scenic 3D on WebGPU (built as gf-scenic, the second games.fun engine, before the
runtime, profile and kind split of 2026-10-13): the scenic look, generated islands, ruins and dungeons. A spec chooses it
with `"runtime": "three", "profile": "scenic-3d"`; how a game feels is its kind (scenic, dark, …), not this profile. The plan is **[PLAN.md](PLAN.md)**, and the contract is `builder/CONTRACT.md` §8 (engines).

**One system.** A scenic-3d game is made by the same `create`, played through the same boot, judged by the same `verify` and delivered by the same Studio worker as a party game. Only its look, its world and its usual camera differ:

| | |
|---|---|
| Spec | `"runtime": "three"`, `"profile": "scenic-3d"`, `"camera": "follow"`, `world.template` island \| isles \| ruins \| dungeon, `look.preset` dusk-isle \| night-ruins \| golden-meadow \| storm-coast \| clear-day |
| In the game | `gf/scenic/` (this folder's `kit/`) beside `gf/three/`; three.js 0.186.0's WebGPU build |
| Make one | `node builder/tools/create.mjs runtimes/three/profiles/scenic-3d/specs/seam.spec.json <out>` |
| Play it | `node builder/tools/serve.mjs <out> --port 5801` (WebGPU Chrome; `?renderer=webgl` forces WebGL2) |
| Judge it | `node builder/tools/verify.mjs <out>` |

## Layout and owners (wave 1; each track writes only its own folders)

```
gf-scenic/
├── PLAN.md, README.md        parent
├── specs/                    parent: seam.spec.json (the wave-0 seam check), the sandbox spec
├── kit/                      vendored into a scenic game as gf/scenic/ (never edited there)
│   ├── LICENSE-folio-2025    MIT, Bruno Simon: beside every ported file
│   ├── look/                 L: renderer, house materials, light, sky, fog, weather, post, presets, capture API
│   └── world/                L: generate.js (pure: worldConfig, levels), world.js (loadWorld), terrain, water, vegetation
├── library/                  C: scenic bodies and props (KayKit CC0, folio-2025 MIT nature), LICENSES.json
├── lookdev/                  L: the look bench (5802): contact sheets per preset and template
└── tools/                    L: world*.mjs; C: art-*.mjs; lib/vendor/three: three 0.186.0's TSL addons (npm tarball)
```

Mechanics are in the shared library, `components/` (track M: `melee`, `levels`, `boss`, `loot`; enemy types in `waves`).

## Status

| Item | State |
|---|---|
| Wave 0 (seam) | 2026-10-08: a scenic spec is created, boots on WebGPU through gf-three's boot, check 2 holds `gf/scenic` |
| Track L: look and world | 2026-10-08, merged: the folio-2025 look (house TSL material, coloured shade, fog and void, sky and stars, wind, rain, snow and lightning, bloom, cheap DOF), five presets, the generated island, isles, ruins and dungeon (terrain data, grass, leaves, flowers, water, falls, cliffs, crystals, runes, lanterns, KayKit pieces), the lookdev bench (`lookdev/`, 5802), 60 fps high; evidence `evidence/L-2026-10-08/` |
| Track C: characters and art | 2026-10-08, merged: 9 KayKit bodies (knight, barbarian, mage, rogues, 4 skeletons), 9 melee clips in gf-humanoid-1, 22 weapons and shields, 53 dungeon pieces (`library/`, CC0); the model judge judges the clips a role plays; evidence `evidence/C-2026-10-08/`. The KayKit Forest pack needs a human download |
| Track M: mechanics | 2026-10-08, merged: `melee`, enemy types in `waves`, `levels`, `boss`, `loot` (gf-three's shared library); checks 13, 15, 16 understand them; a run played to a win and a loss; evidence `evidence/M-2026-10-08/` |
| Track S: system | 2026-10-08, merged: the pitch picks the engine and writes the named games' signature table, the checker enforces the faithful card and honest card words, the images reach the build, verify check 23 (looks like the references), the delivery leads with a play-test failure, verify and play run scenic games on WebGPU, the bank search, eval T4; evidence `evidence/S-2026-10-08/` |
| Wave 2: the sandbox | `specs/sandbox.spec.json` ("Isle Run": knights against skeletons over three small floating isles joined by portals, the Bone Sorcerer last), made by `create` alone. Awaiting the creator's play |
