# gf-audio 1.5.0 (frozen)

This is the shared browser audio kit for games.fun games. Plain ES modules plus one classic script, no build step for games, no dependencies. This directory is immutable.

**Changes from 1.4.0 (2026-10-02, from the private-template test):** all additive. `meter.mjs`, `zzfx.mjs`, the presets and every bus level are identical to 1.4.0, so a game on 1.4.0 sounds the same on 1.5.0.
- **`code-sounds.js`: sounds a game makes with its own Web Audio code.** About 233 of the 310 scraped templates build their sounds with `createOscillator` and noise buffers, so Studio's Sound tab was empty for them. A classic script, loaded first in `index.html` (`<script src="audio/code-sounds.js"></script>`):
  - It watches the nodes the game creates. Nodes made in one task (a key handler, an animation frame) form a burst, and each node is matched to a sound in `assets.json` by where in the game's code it was made: `code.sig`, call-stack patterns of `file:line:col` frames, innermost first.
  - While a sound's `src` is still its own recording (`{file: code.preview}`), the game plays its own synth and nothing changes.
  - Any other `src` is the creator's replacement: a preset, ZzFX numbers, layers, a file or a slice. The game's nodes for that event still run (its timers and `onended` callbacks behave), but their way out goes into a muted sink. The replacement plays in the game's own `AudioContext`, into the node the event was going to connect to, so the game's own volume, mute and pause apply. It is matched to the original's loudness (`code.level`), then the sound's `gainDb`, pitch, jitter, cooldown and voices apply as in `audio.js`. A sound with `loop` (music, ambience) plays its replacement as one loop while the game keeps making the sound, and fades it out when the game stops.
  - Unmatched nodes, sounds with `editable: false`, everything before `assets.json` has loaded, and `OfflineAudioContext` rendering play exactly as before.
  - It reads the manifest the way gf-assets does: `__GF_FILES['assets.json']` when packed, else `assets.json` next to the page (the play origin merges a Studio draft's sounds into it), plus `__GF_ASSET_OVERRIDES.sounds` and the active variant's sounds. Studio's live edits arrive as `gf-audio:set` and `gf-audio:update` messages from the parent frame.
  - Patterns are positions in the game's files, so swaps work where the files are served as written: the play origin, the showcase, any static server. The packed inline page bundles and inlines scripts, so there the game plays its own sounds (a script that ends with `//# sourceURL=<its path>` keeps its positions).
  - `window.__GF_CODE_SOUNDS.stats` counts matched events, replacements played and events left to the game, per sound.
  - It is built by `research/audio/build-code-sounds.mjs` from `code-sounds.src.js`, with `zzfx.mjs`, `sounds.mjs` and `meter.mjs` inlined unchanged (a classic script can't import, and the packed page can't load modules by URL), plus the presets' ZzFX numbers. The packer keeps it as it is (its header is the kit's).
- **`validateManifest` checks sounds built in code:** `code` (`sig`, `preview`, `from`, `level`, `heardDb`, `period`), `editable`, `readonlyReason` and `bake`. `codeState(def)` says `'own'`, `'replaced'` or null. A view-only sound can't be replaced. A manifest with no code sounds validates exactly as in 1.4.0.
- **`audio.js` doesn't decode code sounds' recordings.** They're Studio's previews; `code-sounds.js` plays those sounds. `KIT_VERSION` is `'1.5.0'`.
- **Not in this version:** swaps in the packed inline page (its bundled scripts move every frame), HTML `<audio>` sounds, AudioWorklet synths (listed view only), and fitting ZzFX numbers to a captured sound.

**Capture tool:** `research/audio/capture-code-sounds.mjs <play-dir> [--write]` loads a game in Chrome, plays it, records each sound, picks labels and patterns, checks the swaps, and with `--write` writes the previews, the `sounds` entries, this script and its tag. See `research/audio/GUIDE.md` §7 and `creator-studio/docs/asset-manifest.md`, "v1.4: sounds built in code".

**Earlier versions:** 1.4.0 added audio sprites (`{file, start, end}`); 1.3.0 `busInput`, scheduled starts and optional sounds; 1.2.0 retuning and layers; 1.1.0 master bus 0 dB. Their READMEs say more.

Full builder guide: `research/audio/GUIDE.md`.

**Install into a game:**

```bash
node research/audio/vendor.mjs <game>/source      # → <game>/source/audio/ (+ a starter sounds.json); now includes code-sounds.js
node research/audio/capture-code-sounds.mjs <game>/source --write   # a game with its own Web Audio synth: list its sounds
```

**Pure helpers** (no DOM or Node imports; they run in Studio, the worker and QA): `zzfx.mjs` (`buildSamples`), `meter.mjs` (`measure`, `MIX_TARGETS`), `sounds.mjs` (`validateManifest`, `resolveManifest`, `mixLayers`, `codeState`).

**Verified (2026-10-02):** `node --test research/audio/tests/*.test.mjs` passes, including in Chrome (`tests/code-sounds-chrome.test.mjs`):
- On our own fixture game (`tests/fixtures/code-sounds-game`, CC0: a shared `tone()` helper, a forEach chord, two helpers in one sound, a class method, a step sequencer, an inline-script sound, its own master gain at 0.5), the capture finds all 7 sounds with their names, keeps a jump and a coin made in one frame apart, and every clean clip matches the game's output tap (envelope correlation 1.0, -6 dB through the master, 0 dB for the sound the page sends straight to the speakers).
- With the jump replaced by the `coin` preset, all 3 jumps played the preset (`stats.swapped`), at the jump's loudness (-32.6 and -32.8 LUFS in the output in two runs, against -32.5 for the jump) and at the preset's pitch (1,317 Hz in the output against 1,223 Hz for the preset and 663 Hz for the jump). The coin still played its own sound. Back on `{file: code.preview}`, all 3 jumps played their own sound again.
- A gf-audio game with no code sounds plays the same with the shim loaded: the same plays, the same output energy (to 0.2 dB), and no events matched.
- The 1.4.0 results still hold.

**Not verified:** no person has listened to a captured sound or a replacement. `SHA256SUMS` pins the source files.
