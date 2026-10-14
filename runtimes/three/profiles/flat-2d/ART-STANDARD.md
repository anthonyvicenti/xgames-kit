# gf-flat-1: the art standard of a flat (2D) game

What a picture must be for the flat profile (`runtimes/three/profiles/flat-2d/`, a game's `gf/three/flat/`) to draw it, and how a sheet is judged. Written for whoever makes the pictures: a person, an art maker, or the kit's own tools. The numbers here are the ones `judge.js` holds; if the two ever disagree, the judge is right and this file has a bug.

Every picture is a **slot**. A game starts with the kit's stand-ins (`builder/tools/lib/standin-assets/flat/<style>/`; the pixel set is drawn by `runtimes/three/tools/pixel/folk.mjs` and `town.mjs`), so a maker replaces files and never adds code.

## 1. Two styles

A game is in one style, chosen in the spec (`look.preset`; each flat look names its style). The style sets the numbers below and how pictures are filtered.

| | `pixel` | `drawn` |
|---|---|---|
| Texels per metre (`ppm`) | **16** | **128** |
| Filtering | nearest, no mipmaps | linear, no mipmaps |
| On screen | one texel is a whole number of screen pixels (the camera snaps its view) | any size |
| Alpha | 0 or 255 only | any (soft edges are fine) |
| Colours | at most 32 in one picture (a warning past that, not an error) | any |
| Outline | 1 texel, dark, around bodies and props (advice) | optional |

All pictures are **PNG, 8-bit RGBA, straight alpha, sRGB**, with a transparent background where the picture has holes. No other format.

One texel density for the whole game: a picture's size in the world is its size in pixels divided by `ppm`. A 16 px pixel tile and a 128 px drawn tile are both 1 m.

## 2. The body sheet

One PNG per character role: `assets/sprites/body-<role>.png` (the slot `character.body.<role>`).

**A grid of square cells. 6 columns, and 1 or 3 rows.** The sheet's shape says which: 6:1 or 6:3 (2:1). Nothing else is read from a side file.

Columns, left to right (the frames):

| # | Frame | Shown when |
|---|---|---|
| 1 | `idle` | standing still |
| 2 | `walk1` | walking: alternates with `walk2` (about 5 steps a second at walking speed) |
| 3 | `walk2` | |
| 4 | `air` | off the ground (a jump, a fall, being thrown) |
| 5 | `act` | a quarter second on any action (a throw, a swing, a grab, a cheer) |
| 6 | `down` | knocked down or out |

Rows (the directions):

| Rows | Names, top to bottom | Used for | How it is turned |
|---|---|---|---|
| 1 | `turn` | side-on games; top-down games seen from straight above | side-on: drawn **facing right**, mirrored to face left. Top-down: drawn **facing the top of the picture**, rotated to the heading |
| 3 | `down`, `side`, `up` | top-down games with a standing figure (the classic adventure view) | never rotated: the row is picked by heading; `side` is drawn **facing right** and mirrored for left |

Cell size:

| | `pixel` | `drawn` |
|---|---|---|
| Cell | **32 × 32** (allowed: 16, 24, 32, 48, 64) | **256 × 256** (allowed: 128 to 512, a multiple of 16) |
| Sheet, 1 row | 192 × 32 | 1536 × 256 |
| Sheet, 3 rows | 192 × 96 | 1536 × 768 |
| Largest file | 2 MB | 2 MB |

**Size in the world.** At the default cell a cell is **2 m square** and the standing figure fills at most **85%** of its height: a 1.7 m body (27 of 32 px; 218 of 256 px). The slot `character.height.<role>` scales the whole cell (cell side = height ÷ 0.85). A figure taller than 85% of the cell is drawn bigger than its capsule and its head goes through platforms.

**Anchor** (where the body's feet or centre is in the cell):

- **Side-on, and every row of a 3-row sheet: bottom centre.** In `idle`, `walk1`, `walk2`, `act` and `down` the lowest opaque texel is in the bottom **1/16** of the cell (the last 2 rows of 32; the last 16 of 256), and the opaque texels' middle is within **1/8** of the cell from the centre column. `air` may leave the ground: its lowest opaque texel is in the bottom 1/4.
- **Top-down, 1 row: the centre.** The opaque texels' middle is within 1/8 of the cell from the cell's centre, on both axes.

**Margins.** `drawn`: 2 transparent px at the left, right and top of every cell (linear filtering reads across a cell's edge). `pixel`: none needed.

**Colour.** The player's seat colour, mixed 30% toward white, goes onto the picture's **light greys** only: a texel takes it by how grey (unsaturated) and how light it is, so a shirt painted in a light grey ramp (`#f2f2f4`, `#d6d6dc`, `#a9a9b6`) takes the colour with its shading kept, and skin, hair, eyes and coloured clothes keep their own. Paint an eye's white a little warm (`#f6eedc`) so it stays white. A role that is not `player` (an enemy, a keeper) is not tinted. (On Godot the seat colour still multiplies the whole picture.)

**What makes a sheet fail the judge** (`error`), each named:

| Rule | Fails when |
|---|---|
| `png` | not an 8-bit RGBA PNG |
| `shape` | width ÷ height is not 6 (1 row) or 2 (3 rows), or the cell is not a whole number of pixels |
| `cell` | the cell size is not one the style allows |
| `empty` | a cell has under 4% opaque texels |
| `anchor` | a frame's feet or centre is off, by the numbers above |
| `overfill` | the `idle` figure is taller than 90% of the cell (bottom-centre anchors) |
| `same` | `walk1` and `walk2` are the same picture, or `idle` and `air` are, or (3 rows) two rows are (under 1% of texels differ) |
| `alpha` | `pixel` only: more than 2% of texels are half-transparent (anti-aliased art saved as pixel art) |
| `margin` | `drawn` only: opaque texels in a cell's 2 px left, right or top margin |

Warnings (never a failure): more than 32 colours in a `pixel` sheet; a figure under 50% of the cell (it will read small); a 3-row sheet in a side-on game (only its `side` row is used).

## 3. Props and markers

One PNG each: `assets/sprites/<name>.png` (the slot `prop.<name>`), a single picture, not a sheet.

| | `pixel` | `drawn` |
|---|---|---|
| Size | 16 × 16 for a thing 1 m across (8 to 128 px a side: a tree, a house) | 128 × 128 for a thing 1 m across (64 to 1024 px a side) |

A part that places the prop gives its size in metres (`fit`: the picture's longer side); without one it is pixels ÷ `ppm`. Anchor: side-on the bottom centre (it stands on the ground); top-down the centre. Seen from above a prop casts a small shadow and stands in the near-over-far order of the bodies. Judge: `png`, `empty` (under 4% opaque), `alpha` (pixel), size in range.

Seen from above everything is drawn **in three-quarter view**: the top of a thing and its front, as if from above and in front, light from the top left. A tree is its crown over its trunk; a house is its roof over its front wall and door.

## 4. The tile set

One PNG per tile kind: `assets/tiles/<kind>.png` (the slot `world.tiles.<kind>`). The kinds are the ones the tile map names (section 5); a stand-in game has `ground`, `wall`, `ledge` and whatever the spec's map adds.

**A tile is a square cell: 16 × 16 (`pixel`) or 128 × 128 (`drawn`), 1 m in the world.** A picture is **1 cell** (1:1) or **2 cells side by side** (2:1): `cap`, `fill`.

- `fill` is drawn in every cell of the kind. It must tile: its left and right columns, and its top and bottom rows, continue each other.
- `cap` (optional) is drawn instead where the cell above is not the same kind: side-on the grass on top of the dirt, top-down the far edge of a wall. It must tile left to right.

Solid kinds are fully opaque. A kind that is not solid, or solid from above only (a ledge), may have transparent texels.

Judge: `png`; `shape` (1:1 or 2:1); `cell` (16 or 128; allowed 8 to 32 `pixel`, 64 to 256 `drawn`); `opaque` (a solid kind has a transparent texel); `seam` (the mean colour step across the wrap of `fill` is more than 3 times the mean step inside the tile: left with right, top with bottom; `cap`, and a ledge: left with right only; a warning in `drawn`, an error in `pixel` only when it is more than 6 times); `alpha` (pixel).

**A piece** is a tile from a tile set that is drawn once where its neighbours meet and never in a run of itself: a path's edge or corner over grass, a wall's end, a roof's eave, a door in a wall, one quarter of a gateway. Its edges continue the tiles beside it, not each other, so `seam` is not judged on it; every other tile rule is (`png`, `shape`, `cell`, `opaque`, `empty`, `alpha`). A piece is only ever declared, never guessed: the asset library records one as a `tile` whose manifest says `use.tile: false` (a tile that does not repeat), and its validator calls `judge('tile', image, { style, piece: true })`. A game's own tile kinds (section 5) are fills and caps, drawn in every cell of their kind, so they are always judged with `seam`.

## 4b. Edges, dressing and set pieces (seen from above)

A top-down map's kind may ask for more than a tile (§5, `kinds`); `drawplan.js` lays it out and both the world and the
look judge's contact sheet draw that plan. Each is an optional slot: a game without the picture draws plain tiles.

| The kind says | The picture (slot, file) | What it is |
|---|---|---|
| `"edges": "blend"` | `world.edges.<kind>`, `assets/tiles/<kind>-edges.png` | **16 cells in a 4 × 4 grid** (64 × 64 pixel, 512 × 512 drawn). Drawn on a second grid whose cells are centred on the map's cell corners: each looks at the four map cells round its corner, top left 1, top right 2, bottom left 4, bottom right 8, and draws cell number (that sum), counted left to right, top to bottom. So a path's border is soft, its corners round, and the border still runs along the cells' own edges. Cell 0 may be empty; cell 15 is the kind's fill (every texel drawn). A pond, a path, tilled soil, cobbles |
| `"edges": "connect"` | `world.edges.<kind>`, `assets/tiles/<kind>-edges.png` | 16 cells in a 4 × 4 grid, one per mix of the same kind beside the cell: north 1, east 2, south 4, west 8. A fence, a low wall, a hedge. Every cell drawn |
| `"dress": 0.2` | `world.dress.<kind>`, `assets/tiles/<kind>-dress.png` | A strip of square cells (1 to 16), each a small thing: a tuft, a flower, a pebble, a crop. That share of the kind's cells (the base's too) get one, picked and shifted a few whole texels by a hash of the cell, so every machine draws the same. Never on a cell beside another kind's soft border (a crop in a blend kind keeps every cell) |
| `"piece": [5, 3]` | `world.tiles.<kind>`, `assets/tiles/<kind>.png` | A set piece: one picture (any size up to 128 px pixel) standing on each footprint of [across, deep] cells, bottom centre on the footprint's near edge. Its cells are its collider when the kind is solid. A house's roof rises over the cells behind its footprint, and a walker there is drawn behind it; a walker in front of its door is drawn in front. A soft shadow lies under it |

Judge: `judge('edges', image, { style, mode })` (`shape` 4 × 4 square cells, `cell` size, `empty`, `opaque` for blend
cell 15) and `judge('dress', image, { style })` (`shape`, `cell`, `empty`); a set piece is judged as a prop.

The shadows (under a body's feet, a prop, a set piece) are the runtime's own: a flat dark ellipse, see-through, hard
edged in pixel art and soft in drawn. They are never painted into a picture.

## 5. The tile map (the file a painter edits)

`config/world.json` → `map`, the slot `world.map` (type `json`, `constraints.editor: "tilemap"`). The kit reads nothing else to build the world's ground, walls, platforms, ledges, colliders, spawns and marks, so a painter that writes this one value needs no kit change. Its full shape and limits are in `tilemap.js` (`FORMAT`, `LIMITS`, `readMap`); the part an artist needs:

```json
{ "format": "gf-tilemap-1", "plane": "side", "tile": 1,
  "kinds": { "ground": { "solid": true }, "brick": { "solid": true }, "ledge": { "solid": "top" } },
  "legend": { ".": null, "#": "ground", "B": "brick", "=": "ledge", "1": "spawn", "o": "mark:coin" },
  "rows": ["................",
           "....==......o...",
           ".1..........==..",
           "################"] }
```

One character is one cell; every row has the same length (8 to 96 cells, 6 to 64 rows, at most 32 kinds); the first row is the top (side-on) or the far side (top-down). A legend entry is `null` (empty), a kind, `"spawn"` (seats take them in reading order), or `"mark:<name>"` (a named place the rules read). A kind's `solid` is `true`, `false` or `"top"` (side-on: a ledge). Top-down maps also have `"base"`: the kind drawn under every cell, and a kind may say `edges`, `dress` or `piece` (§4b). A kind's picture is `assets/tiles/<kind>.png`; a kind the map names with no picture is not drawn and the game says so in the console.

A side-on map is refused by `create` (and by check 17 once it reads the part's `worldReport`) when a ledge or a mark is out of a jump's reach from every spawn: the jump rises 2.76 m and crosses 4.8 m, and a map may ask for 82% of that (2 cells up, 3 across at 1 m tiles).

## 6. How to judge a picture

`judge(kind, image, opts)` in `judge.js` (kind `body`, `prop`, `tile`, `edges` or `dress`) takes decoded RGBA
(`{width, height, data}`), runs in Node and in a page with no dependency, and returns `{ ok, kind, style, cell, rows,
frames, errors: [{rule, frame, message}], warnings }`. `gamesfun art ingest <file> --pack <id> --style pixel|drawn` runs
it on every 2D picture it takes into the library (a picture that fails is never offered to a slot), and the kit's own
pixel tools (`runtimes/three/tools/pixel/folk.mjs`, `town.mjs`) run it before they write a file. A maker should run it
before a picture is kept or paid for.

The judge sees shape, anchor, emptiness and seams. It does **not** see whether the six frames are the same character, whether the walk reads as a walk, or whether a picture is good: that is a look judge's job (a contact sheet of the six frames at 4× beside the idle frame), and no check holds it yet.

## 7. Not in this version

More walk frames, eight directions, per-frame timing, hit boxes per frame, edges and dressing side-on, animated tiles, backdrops with parallax, nine-patch panels. A sheet that needs them does not fit `gf-flat-1`; ask for `gf-flat-2`.
