# Runtime godot, verify run 5 (2026-10-13: the phone layout)

Every Godot example made again with the CLI (`npx gamesfun create games/godot-<id> --from godot-<id>`), then
`npx gamesfun verify games/godot-<id> --release --out <here>/<id>` under the GPU slot script, as run 4 was, with the
phone layout of `kit/touch.js` and the phone leg that now runs held upright (390x844) and sideways (844x390).

| example | checks | shared mp gate | verdict |
|---|---|---|---|
| meadow-walk (2D seen from above, no actions) | 68 of 68 | 24 of 24 | A B C D E F pass |
| ledge-friends (2D side-on, jump) | 70 of 70 | 24 of 24 | A B C D E F pass |
| arena-friends (3D, jump) | 72 of 72 | 24 of 24 | A B C D E F pass |
| coin-hop (showcase candidate, jump) | 72 of 72 | 24 of 24 | A B C D E F pass |

**What changed on a phone** (`phone-before/` is run 4's layout, captured the same way at both sizes before the change;
`<id>/phone-playing.png` and `<id>/phone-landscape-playing.png` are after):

- before: no movement control in sight (the shared stick only shows while a finger holds it); Jump, Action and Use on
  every game, a walker seen from above included; the player card a wide panel over the play area under the clock
  (upright) or on the stick's corner (sideways); on coin-hop and arena-friends upright, the goal line ran under the
  four-player scoreboard (`phone-before/*-rects.json`).
- after: a resting stick ring at the lower left in the shared stick's look (with a faint dark edge so it reads on a
  pale ground); only the buttons the game's controls name (meadow-walk: none; the others: Jump); the player card a slim
  pill in the top row beside the clock; the goal line in the space the scoreboard leaves.

The phone leg checks it: `phone-hud-fits` (every HUD box and touch control on the screen, none over another),
`phone-controls-match` (the stick in sight before a touch, the buttons exactly the game's actions), the stick moving the
player and Jump jumping, at both sizes.

**Emulated, not real.** Chrome at 390x844 and 844x390 CSS px, device scale 3, `isMobile`, `hasTouch`, an Android user
agent. No real phone, no Safari: WebKit still cannot start on this machine (each `checks.json` says so under `notRun`).
Nobody has played these on a phone.

One more run happened before this one: an earlier pass of the same four with the stick ring still without its edge.
Three passed; coin-hop failed once, and its record was cleared before it was read, so why it failed is not known. The
run here, with the final code, passed all four.
