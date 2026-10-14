# Notes for the vista core (what the runtime contract still wants from it)

The vista core is vendored and pinned file by file (`UPSTREAM.json`); the kit never edits it. What bringing vista onto
the runtime contract found the core does not do for us, and what the kit does in its place. Each item says which core
file it concerns.

## Watch then play (2026-10-13)

Go live and voice chat work without a core change. A stream's viewer looks out of the streamer's eyes: every vista
copy sends the camera its core drew with its pose (`kit/players.js`, `cam`), and on the viewer's copy the core's own
free camera (`core/src/player/FlyCamera.js`, the F key's debug camera), held still, is placed there before each frame
(`kit/watch.js`). The streamer's body is hidden on the viewer's screen; when they are at the helm the viewer's own boat
is held on its mooring lines where theirs is, the way `core/src/core/Bench.js` holds it out at sea. The shared measure
34 passes on Lantern Cove (42 of 42 steps, run by hand: verify-vista does not run it yet).

What a viewer does not see or hear, and why:

1. **The streamer's rod, line, float and catch.** The core draws one rod, the local player's:
   `core/src/game/FishingRod.js` is built once by `core/src/game/Game.js` with the app's camera and simulates its own
   cast, line and float from local input. A viewer's copy has its own rod (put away), so the stream shows the
   streamer's view with empty hands and no line in the water. Two ways to get it:
   - in the kit, no core change: send the rod's state with the pose (state, the float's position, the wind-up, the
     fight's tension and distance) and drive the viewer's own rod into it each frame (`rod.setState`, `rod.bobber`, the
     fight object `update(dt, { fight })` reads). It works only because the viewer's camera is the streamer's eye (the
     rod is held relative to the camera). It is fragile: it pokes the rod's internals, and the line's sag and the cast's
     flight are simulated, not posed.
   - in the core (wanted): a rod that can be posed from outside, `FishingRod.pose({ state, bobber, power, fight })`, and
     a rod that can be built for a body instead of a camera (`new FishingRod({ scene, holder })`, where `holder` gives
     the hand's transform), so co-op friends and viewers both see each other's rods, lines and floats.
2. **The streamer's fishing sounds** (the reel, the splash, the take): they play from the local rod and the local game
   (`core/src/game/Game.js`, `core/src/audio`). A viewer hears the island around the streamer's eye (the soundscape
   follows the camera), not the streamer's fishing. Wanted with item 1: the rod's sounds from a posed rod.
3. **The streamer's catch card and the fish on the line.** `core/src/game/CatchDisplay.js` hangs the landed fish from the
   local rod. Comes with item 1.

## Co-op (found on the way, not watch-specific)

4. **A friend's boat.** The core has one boat (`core/src/player/BoatController.js`, the app's `boatCtl`). A friend at
   the helm is drawn standing at the boat's pose with no boat under them on everyone else's copy. A viewer gets the
   boat (above) only because nobody drives the viewer's own. Wanted: a boat model the kit can add and pose for each
   friend (`core/src/world/boat` builds the model; a posed copy with no physics would do).
5. **A friend's rod.** Item 1, for co-op players: friends fish with empty hands on each other's screens.
