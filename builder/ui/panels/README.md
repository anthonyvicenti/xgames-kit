# Panels (open builder M4-D)

Choice cards, a shop, an inventory (a hotbar or a grid), a dialogue and a text field, as one module. The interface, the pause and multiplayer rules, the slots and the refusals are in `CONTRACT.md` §6j; this is the map of the folder.

| File | What |
|---|---|
| `logic.js` | Pure (Node imports it): the kinds, the default words, `problems()` (what a call is refused for, with the fix named), the key and text rules, the dialogue's state machine |
| `panels.js` | `createPanels(ctx, ui)`: the DOM. `ctx.ui.panels` is this. A panel shows and returns a choice; it holds no game logic |
| `css.js` | The one stylesheet (the game's own `--gf-panel`, `--gf-accent`, `--gf-text`), phone width first |

Callers: `kit/mechanics/panels` (the part a game declares: words and pictures as slots, then `panels.shop(...)` in `rules.js`), `kit/mechanics/loot` (upgrade cards, a bottom `choice`), `kit/mechanics/build` (its hotbar is an `inventory` bar, its sign editor an `input`). `kit/mechanics/station`'s screen is a texture on a prop in the world, not an overlay, so it is not a caller.

Tests: `research/gf-three/tests/m4d-panels.test.mjs` (a page of stand-in `ctx` and `ui` in `tests/fixtures/panels-harness/`, real input at 1280 and 390 wide). A change here changes a fingerprinted file: the parent re-records the regressions.
