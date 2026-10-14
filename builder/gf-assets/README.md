# gf-assets 1.3.0 (frozen)

The games.fun asset runtime. Contract: `creator-studio/docs/asset-manifest.md`. This directory is immutable; the next change is a new version.

**Changes from 1.2.1 (2026-10-05, replaceable pictures in the 2D games):** additive. Two new files; nothing a game already vendors changes.

| File | In 1.3.0 | Vendored to |
|---|---|---|
| `gf-assets.js` | byte-identical to 1.2.1 (and 1.1.0; its `VERSION` export still says `'1.1.0'`) | `<game>/gf/gf-assets.js` |
| `code-art.js` | byte-identical to 1.2.1 (its first line still says `gf-assets/1.2.1`; `capture-code-art.mjs --write` installs this same file from 1.2.1) | `<game>/gf/code-art.js`, by the capture |
| `looks.js` | **new** | `<game>/gf/looks.js` |
| `pictures.js` | **new** | `<game>/gf/pictures.js` |

Why: 40 of the 63 public 2D games had no picture a creator could replace (the creator: "lets get at least the 2D games with some editable assets", `research/foundations/evidence/2d-editable-art-request-2026-10-05.json`). The recipe that uses these two files is `research/asset-manifest/code-art-2026-10-02/ART_2D_RECIPE.md`.

## The rule: a vendored copy is never edited

Copy a file byte for byte and check its hash against `SHA256SUMS`:

```bash
KIT=research/foundations/kits/gf-assets/1.3.0
cp $KIT/source/looks.js <game>/gf/looks.js          # or pictures.js
node research/foundations/kits/gf-assets/drift-check.mjs <game>     # every gf/ file and the version it matches; exit 1: a copy matches no version
```

For `looks.js` this is more than tidiness: the line of `looks.js` that copies a look into its canvas is part of **every** drawn slot's identity (`drawn.sig`, for example `["gf/looks.js:45:54", "src/render.js:268:17"]`). A game whose copy differs by one line has slots the shim no longer finds. A fix or a feature is a new kit version, and each game that moves to it captures again (`enrich.mjs <dir> --write art`).

## `looks.js`: one canvas per replaceable picture (2D canvas games)

A classic script (also importable for its side effect: `import '../gf/looks.js'`). It sets `globalThis.GfLooks` once; a second copy on the page keeps the first.

- `look(box, paint, scale = 4)` → a look `{c, box, scale, replaced, tints}`. `box` is `[left, top, width, height]` in the game's own units around the point the thing is drawn at; `paint(g)` draws it at `(0, 0)` with the game's own code; `scale` is canvas pixels per unit. It paints on a scratch canvas that is on the page and copies the result into the look's own off-page canvas with one `putImageData`, so the capture sees one picture per look. Both canvases are software ones (`willReadFrequently`).
- `probe(looks)` → how many are replaced. Reads every look once (`drawImage` into a 1×1 canvas). `code-art.js` writes a creator's picture into a look at its first read; `probe` sets `replaced` on the looks it wrote into. Takes a look, a list, or an object of them nested up to four deep; with no argument, every look made. Call it once, after the last `look()`.
- `draw(g, L, x = 0, y = 0, s = 1)`: draws the look where the code would draw the thing (its point at `x, y`, scaled by `s`), with high-quality smoothing, and puts the context's smoothing back.
- `flash(L, colour = '#ffffff')` → a look holding the picture's shape in one colour, for a hit flash. Cached per colour.
- `made`: every look, in the order made (`looks-check.mjs` reads it). `version`: `'1.0.0'` (the helper's own, not the kit's).

Make one look per line of code, named by a property (`hero.heroPunching = look(…)`): the capture labels the slot from the property and groups it by the object, and the line is the look's identity. With nothing replaced, `replaced` is false everywhere and the game must draw exactly as before: a look nobody replaced is never drawn.

## `pictures.js`: replaceable picture files (games built from page elements)

A classic script (also importable for its side effect). It sets `globalThis.GfPictures`.

- `GfPictures.load(gf, tablePath = 'art/pictures.json')` → a promise of the pictures object. `gf` is the game's `gf-assets.js` module: the table is read with `gf.json`, each file once with `gf.bytes`, and a replaced file's URL comes from `gf.url`, so a served folder, a packed game and Studio's preview all work. The table is `{"version": 1, "pictures": {"<key>": {"file": "art/pictures/x.svg", "own": "<sha256 of the bake>"}}}` (`research/asset-manifest/bake-pictures.mjs` writes it).
- `pictures.url(key)` → the file's URL when its bytes are **not** the bake (a creator's picture), else `null`.
- `pictures.html(key, {cls = 'gf-picture', fit = 'contain' | 'cover', alt = ''})` → an `<img>` that fills its box, or `null`.
- `pictures.keys`, `pictures.replaced`: every key in the table; the keys whose file is no longer the bake.
- `GfPictures.sha256(bytes)`: SHA-256 of a `Uint8Array`, as hex (written out because `crypto.subtle` is missing in a sandboxed frame). `version`: `'1.0.0'`.

A key that is not in the table, a file that cannot be read and a missing table all mean "not replaced": the game builds the element in code. "Own" is "the file still equals the bake", not "the file equals what the code draws now", so a palette slot that changes the game's drawing stays alive.

## Verified (2026-10-05)

- Three games vendor these exact files and pass the full coverage check against commit f4111685 with play unchanged: `trials/brawler` (9 pictures), `trials/breakout` (11) and `trials/visual-novel` (16). Their `evidence/art-2d-2026-10-05/verdict.json` hold the verdicts; `drift-check.mjs` lists each copy as 1.3.0.
- `node --test research/asset-manifest/tests/art-2d.test.mjs` (this kit's hashes, `pictures.js` own or replaced, `looks.js` loading) and `tests/art-2d.browser.mjs` (Chrome: looks in a real page; a page element shot, listed and replaced).

**Not verified:** no person has replaced one of these pictures in Studio; no game served from a built folder has been through the recipe; a Studio save in another format through `source.pathRef` was not exercised. The Studio worker (`research/foundations/studio-worker/lib/job.mjs`) still hands builders 1.2.1: a builder revising one of these games must keep `gf/looks.js` or `gf/pictures.js` as they are.

**History:** the two helpers were written as `research/asset-manifest/templates/gf-looks.js` and `gf-pictures.js` during the pilot; those files are gone and this kit is the only source. The three pilot games' import comments and their evidence notes still name the old path.

`SHA256SUMS` pins the source files. Changes per version: `CHANGELOG.md`.
