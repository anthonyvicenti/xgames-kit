# Runtime godot, verify run 1 (2026-10-13)

Both examples made from their specs (`tools/example.mjs`), then `tools/verify.mjs` under the GPU slot script, in
headless Chrome (Playwright) on Linux with ANGLE on the GL/EGL driver, 1280x720. The minimal example also ran the
shared multiplayer gate (`--mp-gate`, gf/mp 1.7.8's gate.mjs, unchanged): `minimal/mp-gate-1/`, 24 of 24 checks.

| | Every check | Gates (re-judged, see below) |
|---|---|---|
| minimal (Ledge Friends) | 33 of 33 passed | A B C D E F pass; skipped measures each with why |
| coin-hop (showcase candidate) | 34 of 34 passed, with its own two-player coin test | A B C D E F pass |

**Re-judged.** As run, `verdict.as-run.json` failed gates B and F although every check passed: the verdict code put
measure 20 (the menu) in the gate of the leg that ran it (C) instead of its own gate (B), and required measure 35 of a
game with no tests of its own. Both are fixed in `tools/verify.mjs` (`judge`, `gateOfMeasure`), and `verdict.json`
was written again from the same `checks.json` with `verify.mjs <game> --rejudge <run>`; no check was run again.

Not run here, each named in the verdict's `skipped`: 7, 9, 10, 11, 12, 15, 16, 21, 22, 24, 31, 32, 34, 38, 39.
No person has played either game.

**This copy.** Moved into xgames-kit from the staging stream's folder unchanged, except one line: the graphics card's
model in `minimal/mp-gate-1/record.json` → `graphics.renderer` reads "NVIDIA GPU" here (the public tree names no
owner's hardware). The original run's files are the staging stream's record.
