# gf-vista core: attribution

The core is **Tidewater** by DRG Software Solutions LLC (Dan Greenheck), https://github.com/dgreenheck/tidewater,
commit `4811ba48d795197de5621985f404e765c0b7c0ef`, released under the **MIT licence** (`LICENSE` beside this file).
gf-vista vendors it as its renderer and world (research/super-scenic/PLAN.md, route A). Our changes are marked
`gf-vista:` in the code and listed in `PATCHES.md`. Upstream's own credits are kept unchanged in `CREDITS.md`.

Kit code and delivered games use generic names: nothing a player sees is called Tidewater, and no game uses its
people or places. The code keeps this attribution.

| What | Where | Licence | Source |
|---|---|---|---|
| Engine, ocean, sky, post, fx, materials, world, player, game, UI, audio code | `src/` | MIT | Tidewater @ 4811ba48 |
| Volumetric cumulus (ray march, density, weather, temporal reconstruction) | `src/sky/SkyProClouds.js` | from the author's `sky-pro-webgpu`, as the file's header says; the creator ruled them safe to use on 2026-10-12 | the same author |
| Cloud noise volumes | `public/clouds/*.bin` | as above (`public/clouds/LICENSING.md`) | sky-pro-webgpu |
| SMAA area and search tables | `public/textures/smaa/` | MIT | three.js (SMAA by Jorge Jimenez et al.) |
| 42 field recordings (Ogg Opus) | `public/audio/` | CC0 1.0 | Freesound; each file's author and link in `public/audio/CREDITS.md` |
| Scanned beach debris (4 models + maps) | `public/models/debris/` | CC0 1.0 | Poly Haven (`public/models/debris/CREDITS.md`) |
| Stall props and planks, iron, timber textures | `public/models/props/` | CC0 1.0 | Poly Haven (`public/models/props/CREDITS.md`) |
| Two characters (Rocketbox avatars) | `public/models/characters/*.glb` | MIT | Microsoft Rocketbox (`public/models/characters/LICENSE-Rocketbox.md`) |
| Humpback whale (mesh, albedo, height) | `public/models/whale/` | MIT (the author's own procedural model) | Tidewater |

Not vendored: upstream's key art (`public/ui/keyart*.jpg`, the game's own branding) and its Google Fonts link (the UI
falls back to system fonts).
