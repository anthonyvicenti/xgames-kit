# Runtime godot, verify run 6 (2026-10-13: the pixel kind's new art)

The same four examples as run 5, made again on xgames-kit main 197a093's pixel art (merged into this branch), then
`npx gamesfun verify games/godot-<id> --release --out <here>/<id>` under the GPU slot script.

| example | checks | shared mp gate | verdict |
|---|---|---|---|
| meadow-walk (2D seen from above) | 68 of 68 | 24 of 24 | A B C D E F pass |
| ledge-friends (2D side-on) | 70 of 70 | 24 of 24 | A B C D E F pass |
| arena-friends (3D) | 72 of 72 | 24 of 24 | A B C D E F pass |
| coin-hop (showcase candidate) | 72 of 72 | 24 of 24 | A B C D E F pass |

**What changed.** A body's seat colour goes onto its light greys only (the shirt; skin and hair keep their colours),
as three's flat-2d does (`addon/gf_flat_body.gd`, a canvas shader). Seen from above the field is three's draw plan
(`gf/three/flat/drawplan.js`): soft path and pond edges, the walls joined, tufts and flowers on the grass, and set pieces
(houses, trees) standing in a y-sorted parent with the bodies, each with a shadow (`addon/gf_tilemap_2d.gd`); a body
seen from above casts a small shadow. meadow-walk shows the field; `village-walk-scratch/` is a scratch spec (not an
example) with houses, a shop, trees and a pond, made with the CLI and passing a build verify (`verdict.json`), to show the
set pieces and the near-over-far order.

The phone leg's picture swap (measure 8) used to ask that no red at all show where the player stands before the swap;
with skin and hair no longer tinted a few reddish texels are the picture's own, so it now asks for the replaced red
picture to show at least eight times as much red (`tools/measure.mjs`). The first try of this run stopped on that
check (coin-hop's record was cleared and the run made again).

Emulated, not real: no real phone, no Safari (WebKit cannot start on this machine). Nobody has played these.
