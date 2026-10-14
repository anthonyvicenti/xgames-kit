# Runtime godot: licences

| What | Where | Licence | Pinned |
|---|---|---|---|
| Godot Engine 4.6.stable (the editor, run headless to import and export) | installed by `tools/install.mjs` outside the repository | MIT | `toolchain.json` → `platforms.linux-x64.editor` (archive and binary sha256) |
| Godot web export template, single-threaded release (`godot.js`, `godot.wasm`) | installed by `tools/install.mjs`; copied into every game as `build/game.js`, `build/game.wasm` | MIT, with the engine's third-party components under their own permissive licences | `toolchain.json` → `template.fileSha256`; verify holds each game's copy to these bytes |
| `kit/` (the page side, vendored into a game as `gf/godot/`) | this folder | MIT (the xgames kit) | `releases/<version>.json` |
| `addon/` (the GF autoload and its 2D parts, vendored into a game's project as `addons/gf/`) | this folder | MIT (the xgames kit) | `releases/<version>.json` |
| `templates/2d-side/` (the starter project create writes) | this folder | MIT (the xgames kit); the game owns what it changes | |

Godot Engine: Copyright (c) 2014-present Godot Engine contributors; Copyright (c) 2007-2014 Juan Linietsky, Ariel
Manzur. Full text: https://github.com/godotengine/godot/blob/4.6-stable/LICENSE.txt. Third-party notices:
https://github.com/godotengine/godot/blob/4.6-stable/COPYRIGHT.txt. Every game carries a short notice in
`gf/godot/LICENSES.md` (written by create).

No art or sound ships in this folder. The examples use the kit's own stand-in pictures (gf-flat-1, CC0-1.0) and
gf-audio's synthesised presets.
