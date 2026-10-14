# Library stream: requests for the pack and asset schemas

**Status (2026-10-13): all 17 taken in by the contracts' schema revision 2** (`contracts/READY.md`, step 1). `describe`
stays at 200 characters; the full text stays in the pack's `sources.json`. The importer and ingest now write the
fields below into the manifests themselves; this file is kept as the record of why they exist.

From the library stream (staging/library) to the contracts stream (staging/contracts/library/schema). Written while
importing every existing asset of the kit (gf-three, gf-scenic, gf-forge, the stand-ins, the flat sets) into packs.
Each request says what an existing asset needs and what the importer writes until the schema has it.

## Asset manifest

1. **`source` per asset** (object: `page`, `download`, `sha256` of the upstream file, `retrieved`, `modified`).
   Collection packs (Poly Pizza models by different authors, OpenGameArt sounds, Poly Haven textures) pin a source
   per asset, not per pack, and `fetch` can take an unmodified file straight from its download URL only when it knows
   that URL and the upstream hash. Until then: the importer writes `from` as one line ("<page> sha256 <hash>; <what
   was done>") and the per-asset pins stay in the pack's `sources.json` beside pack.json.
2. **`use` fields existing props carry:** `real` ([min, max] metres a real one is, the scale check), `min` (the
   bounds' low corner, for origin "grid" pieces), `parts` (moving nodes: gate doors with their hinge), `grip`
   (position and quaternion on hand_r for held props and weapons), `hands` (1 or 2), `light` (a light point and
   colour on lamps), `tile` (tileable: true) and `tileMetres`, `colorSpace` (srgb or linear: masks and SDFs are
   linear), `plane` (side or top, for a sprite sheet), `style` (pixel or drawn, the flat standard it is judged on),
   `tintMix`. Until then: those that fit nowhere are kept in the pack's `sources.json` per asset under `use`.
3. **`use.origin` values `grid` and `camera`.** KayKit dungeon walls and the forge's code-made walls keep their grid
   origin (centred on the grid line, base at 0, 3 m grid); first-person arms are in camera space. Until then the
   importer writes `feet` for grid pieces and leaves origin out for camera-space arms (the tag `first-person` says it).
4. **`use.sockets` as objects** (name to node, position, quaternion): weapons have `muzzle`, `grip`, `grip_l` with
   positions. The names-only array loses where they are. Until then: names only.
5. **`variants`** ([{ use: "small", sha256, bytes, textureMax }]): the forge ships a "small" copy of 51 models (the
   same model with 128 to 512 px textures, for phones). They are the same asset, not new ones.
6. **Category `viewmodel`** (first-person arms and held-in-view models, camera space, no rig). Until then: `prop`
   with tags `first-person` and `arms`.
7. **`validated[].by` values `clip-check` (a clip file: animations present) and `picture-check` (a texture, card or
   effect: decodes, size, see-through share).** `budget` covers props; nothing covers clips and plain pictures.
   Until then: clips and pictures record `budget` with the check's own name in `report.check`.
8. **`fits.signature` measures the asset, not the pack**, and the pack signature's fields fit it except: see below.
9. `describe` maxLength 200: three generated-body descriptions are longer (up to 420 chars). The importer cuts them
   at a word under 200 and keeps the full text in the pack's sources.json.

## Signature (pack.schema.json `$defs/signature`, shared by assets)

10. **`trianglesPerMetre` defined as sqrt(triangles / surface m²)** (edges a metre: scale-free, so a 5 m tree and a
    0.3 m cup of the same style read the same, and it compares directly with texelsPerMetre). "Per metre of height"
    makes every small prop read dense. The importer writes the sqrt measure.
11. **`palette.families`** ([{ hue: "green", share }]) beside `hues` (hex): the judge compares hue families, the hex
    list is for people. Also `palette.exact` (exact colours in a picture: pixel art keeps to 32) and
    `palette.grey` (the share of grey and near-black or near-white). Until then: `hues` holds the main colours as hex,
    families are not written.
12. **`texturedShare`** (0–1) beside `textured`: Kenney kits use a colour-swatch texture (every triangle's UVs on one
    swatch), which is flat colour in effect; the importer measures texel area and writes `textured: false` for them.
13. **`outline` as { present, how: hull | ink, share }** and **`body` as numbers** ({ headsTall, hipShare,
    shoulderShare, widthShare }) beside the `proportions` sentence. Until then: booleans and a sentence.
14. **`sound`** ({ seconds, peakDbfs, soundMaxLufs }): a sound's signature has nothing to hold today.

## Pack manifest

15. **`source.kind: "collection"`** (assets from many pages, each pinned per asset; see 1).
16. **`source.rebuild`** (one line: the tool and command that rebuilds the baked files from the pinned source), so
    `art fetch` can say how a missing baked file comes back when no mirror has it.
17. **pack id pattern** allows a pack to be named after a source with dots (none needed now; the importer uses dashes).
