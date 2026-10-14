# vista: the runtime for calm places

For calm games where the place is the point: a physical sky and light, a simulated ocean, clouds, and islands of each
game's own (WebGPU only, desktop). The core is Tidewater at 4811ba48 (MIT), vendored; the golden reference for its look
is the frozen eval case T7.

```
core/      Tidewater's engine, vendored (UPSTREAM.json, LICENSE, ATTRIBUTION.md, CREDITS.md, PATCHES.md: 8 patches)
kit/       host.js (boots the core; ui: false builds none of its DOM; place: the island to build), gpu.js, look.js (six
           presets; hour, sea, exposure, clouds, veil), observe.js, config.js (the islands from the spec, the looks, the
           slots), world/places.js (placeRecipe(seed, words): a place of its own; REFERENCE, the core's island, frozen
           for regressions and T7; placeLook, placeKey, builtPlace), islands.js (the chart, far silhouettes, the trip
           between islands), tables/, game.js (the core's fishing and the trip under our names), audio.js + sounds.json,
           bodies.json, humanoid.js + humanoid-rig.js, players.js, coverage.js, core-files.js, meshopt.js
hud/       vista's HUD parts (money, cooler, rod, bite, tension, catch card, stall panels, the islands block)
specs/     thin-cove.spec.json (the system proof)
sandbox/   core-view/ (the core alone: ?seed=N&words=k:v,… a generated place, ?place=reference, ?bench, ?look={…})
tools/     places-gallery (24 places × five fixed shots), place-check (24 checks per recipe against its heightmap, and
           --timings), frame-cost (the core's bench at 3840x2160 per place), hop-memory (rebuilds back and forth: GPU
           memory, heap, rebuild time), hop-friends (two players hopping on a created game), capture, img, serve,
           core-files
```

## Run

```bash
node runtimes/vista/tools/place-check.mjs --seeds 1-50 --sets all          # recipes against their heightmaps (no GPU)
gpu-run.sh node runtimes/vista/tools/places-gallery.mjs --out <dir>        # the gallery (WebGPU, desktop)
gpu-run.sh node runtimes/vista/tools/frame-cost.mjs --out <dir>            # frame cost at 3840x2160
gpu-run.sh node runtimes/vista/tools/hop-memory.mjs --out <dir>            # island rebuilds: memory and time
gpu-run.sh node runtimes/vista/tools/hop-friends.mjs <game dir>            # two players hopping (a game from isle-hop)
```

`gpu-run.sh` is the machine's GPU queue; headless WebGPU runs chrome-headless-shell on Vulkan (builder/qa/browser.mjs).

## Places

Every vista game is on islands of its own: `world.islands` in the spec (1 to 5, each `{name, seed, words}`), or one
island seeded from the game's title and prompt. The words (kit/world/places.js WORDS, with aliases): size, shape
(single, twin, ridge, cliffs, atoll, archipelago, plateau, volcano), islets, coast (smooth, rugged, coves), bays, river,
cliffs, bay (a side or degrees), beach, pier (pier, dock, jetty), village (none, hamlet, town), houses, reef, water,
sand, rock, vegetation, plants, time, weather. Every shape is the core's own generators fed new inputs (its terrain
shader, erosion, sand, reef, plants, village kit, debris, breakers and shore waves); time and weather change only the
look. Gate F's measure 17 fails a game on the reference island or with fewer islands than its spec.

## Status

- Wave 0 (2026-10-12): the reference build on 5960, the reference pack (`research/super-scenic/reference/`), T7.
- Wave 1 (2026-10-12, done; record `research/super-scenic/evidence/wave1-2026-10-12.json`): the core vendored with
  one patch, frame comparison 34/34 bit-identical; look slots (hour, sea, exposure) swapped live; the core's minimum
  WebGPU limits and the kit's screen below them; gf-humanoid-1 bodies skinned by the core within 0.28 mm of rig.js;
  two players over gf/mp who see each other (14/14; the shared gate 23/24, soft on-screen check only). Not done: the
  low-tier frame times (no low-tier device here), the friend's boat (wave 4), swim and upper-body clips.
- Thin end-to-end wave (2026-10-12, `research/super-scenic/THIN_E2E.md`): `spec.engine: "vista"` through create, the
  shared boot (menu, HUD, session), verify (`tools/verify-vista.mjs`: 16 required checks, 10 "not yet for vista"), the
  catalog and the pitch, closed behind `GF_VISTA_OPEN=1`. Tracks G (the core's fishing under our names, audio on
  gf-audio, HUD; fish-loop 21/21), C (six Rocketbox bodies) and S (the system) merged. Lantern Cove verify 16/16.
  T7 ran twice through the whole loop (`research/super-scenic/evidence/t7-run1-…`, `t7-run2-…`): both delivered with
  an honest "Not yet the game you asked for"; run 2 in 26.7 min (run 1: 44.7); seven system fixes came from them.

- Places and island hopping (2026-10-13, xgames-kit stream vista-places; ported from games.fun's tracks P and H):
  core patches 6 to 8, spec v2 `world.islands`, gate F's islands leg (measure 17) with its regressions, the gallery,
  the isle-hop example.

## Make a vista game

```bash
npx gamesfun create games/my-cove --from lantern-cove      # or --from isle-hop (three islands)
npx gamesfun verify games/my-cove                         # under the machine's GPU queue (WebGPU, desktop)
npx gamesfun dev games/my-cove
```
