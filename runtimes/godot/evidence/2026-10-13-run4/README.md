# Runtime godot, verify run 4 (2026-10-13, the final run: xgames-kit main with spec v2, the asset library and the kinds)

Every Godot example made with the CLI (`npx gamesfun create games/godot-<id> --from godot-<id>`), then
`npx gamesfun verify games/godot-<id> --release --out <here>/<id>` under the GPU slot script: the six gates with the
measures this runtime supplies, the shared multiplayer gate (gf/mp 1.7.8's gate.mjs, unchanged), a phone emulated in
Chrome, and Playwright's Firefox and WebKit. Headless Chrome (Playwright) on Linux, ANGLE on the GL/EGL driver,
1280x720 unless said.

| example | checks | shared mp gate | verdict |
|---|---|---|---|
| ledge-friends (2D side-on) | 62 of 62 | 24 of 24 | A B C D E F pass |
| meadow-walk (2D seen from above) | 61 of 61 | 24 of 24 | A B C D E F pass |
| arena-friends (3D, gf-humanoid-1 bodies) | 63 of 63 | 24 of 24 | A B C D E F pass |
| coin-hop (showcase candidate, its own two-player test) | 64 of 64 | 24 of 24 | A B C D E F pass |

What ran beyond run 1: bots alone (seated, moving, still under the pause menu, in the results), the kit's panels
(a choice opened through the bridge as `GF.panel` opens it: covers the game, holds input, the answer reaches Godot),
watch then play (Go live from the game's pause menu; a viewer follows the streamer) with the shared voice steps
unchanged (Chrome's fake microphone: the viewer hears the streamer), the phone leg and Firefox.

**Emulated, not real.** The phone is Chrome at 390x844 CSS px, device scale 3, `isMobile`, `hasTouch`, an Android user
agent: the menu fits, a tap plays, the kit's touch stick moves the player and its Jump button jumps. Firefox is
Playwright's build 155.0, headless, on the machine's GPU. **WebKit did not run**: it could not start on this machine (a
missing system library, libavif16, which needs root to install); each `checks.json` records it under `notRun`, never as
passed. No real phone, no Safari, and nobody has played any of these games.

**Since run 2** (same examples, all passing there too): rebased onto core-spec (spec v2; verify also writes
record.json for the studio), every file slot filled from the asset library (flat-standins-*, gf-beans, humanoid-clips;
each pick's licence in ATTRIBUTION.md), and the kinds merged (a pixel game's side-on stage now takes the kind's own sky,
#8fd3ff). Run 2 (2026-10-13-run2/) is kept with the first 3D run's failure (friends spawned out of each other's view).

Not run here, each named in the verdict's `skipped` with why: 7, 9, 10, 11, 12, 15, 16, 21, 22, 24, 31, 32, 38, 39
(and 35 for the three examples with no test of their own). Records name no graphics card and no machine path.
