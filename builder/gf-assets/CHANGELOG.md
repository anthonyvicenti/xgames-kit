# gf-assets changelog

- **1.3.0 (2026-10-05):** adds `looks.js` (one off-page canvas per replaceable picture in a 2D canvas game: `look`, `probe`, `draw`, `flash`) and `pictures.js` (replaceable picture files in a game built from page elements: `GfPictures.load`, `url`, `html`). `gf-assets.js` and `code-art.js` are byte-identical to 1.2.1. Recipe: `research/asset-manifest/code-art-2026-10-02/ART_2D_RECIPE.md`.
- **1.2.1 (2026-10-02):** `code-art.js` writes a replacement at every place `drawn.also` lists (one picture kept at several rects of its canvas: a tile on every face of a block). `gf-assets.js` is byte-identical to 1.2.0.
- **1.2.0 (2026-10-02):** adds `code-art.js`, the runtime for pictures a game paints in its own code (manifest v1.5, `drawn` image slots). `gf-assets.js` is byte-identical to 1.1.0.
- **1.1.0 (2026-09-25):** adds `jsonSync`, `exists`, `applyCss`, the `packed` flag and variant sound overrides; the 1.0.0 API is unchanged.
- **1.0.0 (2026-09-25):** `json`, `text`, `bytes`, `url`, `font`, `manifest`, `sounds`; packed-file embedding (`__GF_FILES`) and Studio overrides (`__GF_ASSET_OVERRIDES`).
