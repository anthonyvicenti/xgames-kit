# The grim theme's fonts

Two font files for the "grim" UI theme (`builder/ui/theme.js`), copied by `create` into a forge game as `assets/fonts/` (slots `ui.font.display` and `ui.font.text`), each with its licence text beside it. Both are subsets we made, so they carry their own family names.

| File | Family name inside | Made from | Licence |
|---|---|---|---|
| `grim-display.woff2` (24,932 bytes, sha256 `e2a19e1a98fc…`) | GF Grim Display | Grenze Gotisch, `ofl/grenzegotisch/GrenzeGotisch[wght].ttf` in google/fonts at commit `c1eda9233c33ad7775b27efd794f931095cf6133` (sha256 `701b299d8dc0…`); upstream https://github.com/Omnibus-Type/Grenze-Gotisch | SIL OFL 1.1, Copyright 2020 The Grenze Gotisch Project Authors: `LICENSE-grim-display.txt` |
| `grim-text.woff2` (22,508 bytes, sha256 `95c6c401d967…`) | GF Grim Text | Grenze, `ofl/grenze/Grenze[wght].ttf` in google/fonts at commit `87340cbb0ba6cbfc3f6817ad53bd16a37884e0ed` (sha256 `04afa4836bcd…`); upstream https://github.com/Omnibus-Type/Grenze | SIL OFL 1.1, Copyright 2019 The Grenze Project Authors: `LICENSE-grim-text.txt` |

Neither upstream declares a Reserved Font Name.

**What changed** (`subset.py`, fonttools 4.66.1 with brotli): the weight axis cut to the range the theme uses (display 500 to 800, text 400 to 800); glyphs cut to Basic Latin, Latin-1 and a few marks (dashes, quotes, the ellipsis, the bullet, the minus, infinity, Œ œ ı); lining figures made the default (tabular in the text face, so a counter does not jump; CSS's `font` shorthand resets `font-variant-numeric`, so the default is what a HUD shows); kerning, ligatures and the four figure features kept; the source's hinting tables kept (without them FreeType spaced small text unevenly in our headless Chrome); saved as WOFF2; the name table renamed. Running it twice on the same sources gives the same bytes.

A game that replaces a font slot keeps working: the theme asks for the family by the slot's own name, and falls back to a system serif while a file loads or when one is missing.
