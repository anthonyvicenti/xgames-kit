# Runtime godot, verify run 2 (2026-10-13, from the xgames-kit layout)

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

**arena-friends-corner-spawns/** is the first 3D run, kept as it failed: gate E, measure 5 (each player saw the other
in 0 samples: the field's spawns were in its corners, about 17 m apart, and the follow camera shows about ten metres).
create now gathers a 3D arena's seats in the middle; the run above is after that fix. Its screenshots other than the
two live ones were left out.

Not run here, each named in the verdict's `skipped` with why: 7, 9, 10, 11, 12, 15, 16, 21, 22, 24, 31, 32, 38, 39
(and 35 for the three examples with no test of their own). Records name no graphics card and no machine path.

Superseded by run 4 (2026-10-13-run4/), the same examples after the core-spec, library and kinds merges.
