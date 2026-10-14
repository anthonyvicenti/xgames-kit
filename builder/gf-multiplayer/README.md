# gf-multiplayer 1.7.8: spectator lobby status

This frozen kit is immutable. It is based on 1.7.7 and is adopted only for the forge zombie game; the default remains 1.7.6.

The stream metadata now distinguishes the waiting room from results when the streamer opens it. `net.watch` exposes the room phase and round so the game can keep its overhead camera between games and switch to first person during play. The viewer bar says that the streamer is in the lobby, preparing the next game, or starting the next game. The waiting status wraps at narrow widths. Active play keeps the existing name and viewer count.

Changes from 1.7.7: `party.js`, `party.css`, the `net.js` API comment, and the checksums in `kit.json`.

Zombie Town also receives the companion change from `research/gf-three/kit/core/boot-forge.js`: a moving overhead view in its initial lobby and between games, combat overlays and first-person weapons hidden during that view, and first person restored when the streamed round is playing. Other game files are retained from the published version.

Regression: `node --test research/gf-forge/tools/zombie-watch-rounds.test.mjs`. It verifies lobby motion and status at desktop and phone widths, results, first-person play after the cart, replay, a waiting-room restart, and reloading the viewer.
