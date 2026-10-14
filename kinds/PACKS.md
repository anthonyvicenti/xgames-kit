# The packs the kinds name

A kind's `packs` list (`kinds/<id>.json`) is what the asset library's resolver ranks first for a game of that kind
(`builder/art/resolve.mjs`), and what create writes into the game's `config/game.json → art.packs`. A mix the creator
asks for is allowed and shown as a finding. Every pack named today is in the library (`library/packs/<id>`, its licence
beside it); `tests/kinds.test.mjs` fails on a name the library lacks. The library's own README says where the bytes
come from.

| Kind | Packs, first to last |
|---|---|
| silly | `gf-beans`, `kenney-platformer-kit`, `kenney-nature-kit`, `kenney-holiday-kit`, `kenney-food-kit`, `kenney-minigolf-kit`, `ofl-fredoka` |
| blocky | `xk-blocky-bodies`, `xk-voxel-blocks`, `kenney-platformer-kit`, `kenney-mini-arena`, `kenney-blocky-characters`, `ofl-lilita-one` |
| lofi | `kenney-furniture-kit`, `kenney-mini-market`, `kenney-car-kit`, `quaternius-ual-bodies`, `ofl-vt323` |
| scenic | `folio-nature`, `kaykit-dungeon-remastered`, `kaykit-adventurers`, `kaykit-skeletons`, `ofl-fredoka` |
| dark | `forge-world`, `forge-props`, `forge-town`, `forge-textures-night`, `forge-fx`, `kaykit-halloween`, `kaykit-skeletons`, `kaykit-adventurers`, `forge-sounds`, `ofl-grenze` |
| calm | `vista-core-world`, `rocketbox-adults`, `vista-sounds`, `ofl-fredoka` |
| pixel | `xk-pixel-folk`, `xk-pixel-town`, `flat-standins-pixel`, `ofl-silkscreen` |
| drawn | `kenney-new-platformer-pack`, `kenney-toon-characters`, `kenney-background-elements-remastered`, `flat-standins-drawn`, `ofl-lilita-one` |

`pixel` dropped the Kenney Tiny packs on 2026-10-13 after the creator's review of its sheet ("The white people look
too simple. Some of these assets look a bit too straightforward."): their folk are single frames that cannot walk, and
their tiles are plain one-tile pieces. The kit draws its own (`runtimes/three/tools/pixel/`, CC0): villagers with six
frames in four facings, soft edges, dressing and set pieces. No permissive animated pack was found that has gf-flat-1's
six frames (idle, walk, walk, air, act, down) in three directions with distinct people: the CC0 ones seen (BitBop's
Tiny Farmer, Sodri's 4-directional walker, Sogomn's animated character) are one person each, a different size, and
walk only; Draconimous's Coopers set is CC-BY 4.0 with 16 px bodies; LPC is CC-BY-SA/GPL. The Tiny packs stay in the
library for anyone who asks for them.

Not named, on purpose: the forge's grim props, hunters and grim skeletons are the owner's paid generations (a game may
use them; the public library does not hold them; the dark sheet's lookdev scene still draws them from the private
packs on a machine that has them). The CC-BY playground props wait for the creator's licence floor.

## Wanted: a hand-drawn pack for `drawn` (for the creator)

`drawn` reads as clean vector cartoon today (Kenney's New Platformer Pack): it should evoke Silksong, Cuphead and Pizza
Tower, which are drawn and painted by hand. No CC0 pack found so far has hand-drawn tiles and characters together.
Candidates, not fetched, not judged on a sheet yet:

| Candidate | What | Licence (as its page states it, 2026-10-13) | Fit |
|---|---|---|---|
| GameArt2D freebies (gameart2d.com/freebies.html) | platformer tilesets (forest, winter, desert, sci-fi, graveyard) and about 14 animated characters (knight, ninja, adventurer girl, zombies, dinosaur…) | CC0 / public domain ("Assets in the Freebies section are licensed under Creative Commons Zero (CC0)", gameart2d.com/license.html) | the closest: soft shaded cartoon with drawn outlines, characters and tiles in one style; still vector, not brush-painted |
| Strawberry Cake Platform Tileset (opengameart.org/content/strawberry-cake-platform-tileset) | a hand-painted platform tileset and accessories | CC0 (the Sympathy logo excepted) | painted by hand, but tiles only: no characters |
| Handpainted Platform Tileset (opengameart.org/content/handpainted-platform-tileset) | painted terrain, objects, a background | CC-BY 3.0 | painted; CC-BY waits for the licence floor decision |

The step after the creator picks one: ingest it as a library pack (`gamesfun art ingest <zip> --pack <id> --style drawn
--texels 128`), name it first in `kinds/drawn.json → packs`, render the drawn sheet again and look.
