# Three Harbours (example, vista runtime: island hopping)

Sail a small boat between three islands with 1–3 friends, landing a fish at every harbour. Each island is the game's
own, generated from a seed and a few words in `spec.json` → `world.islands`:

| Island | Words | What you see |
|---|---|---|
| Fern Key | medium, one summit, a rugged coast, jungle, white sand, a pastel hamlet, a large reef, morning | a dark green jungle island with a long timber pier over turquoise shallows |
| Table Rock | large, a table mountain, scrub on limestone, golden sand, a river mouth, a terracotta town, golden hour | a flat-topped dry island, a stone jetty, the sea running up a river behind the beach |
| Ember Reach | small, a volcano with a rock spire, dark sand on basalt, sheer cliffs, a dock, no village, overcast | a black-sand volcano under a grey sky, nobody living there |

```bash
npx gamesfun create games/my-voyage --from isle-hop
npx gamesfun dev games/my-voyage
```

How a trip works: take the helm (E aboard the boat), sail out past the reef toward the island you see on the horizon.
Past the island's reach the screen eases out, the next island is built (about 5 s on a desktop graphics card) and
everyone arrives aboard the boat at its dock. The host's copy decides a trip; a friend who sails out asks the host.
`rules.js` gates a trip with `canHop` (here: land a fish at this harbour first) and scores the voyage.

**Vista plays on a desktop only** (WebGPU on a desktop graphics card; see the Lantern Cove example's README for what it
needs). Each island's words are slots (`world.island.<n>.seed`, `.words`, `.name`): change a seed and the island is
another one with the same character.

**Checks.** Gate F's islands leg (measure 17) checks that the game is the spec's three islands, built from their own
seeds and words, and never the core's reference island; `runtimes/vista/tools/hop-friends.mjs <game dir>` plays two
players hopping together over real WebRTC. Results are in `example.json`.

Provenance: our own example and names (no upstream game). The runtime's core is Tidewater by DRG Software Solutions LLC
(MIT), credited in `gf/vista/core/ATTRIBUTION.md` in every game (THIRD_PARTY.md).
