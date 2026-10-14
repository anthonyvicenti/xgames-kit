# Lantern Cove (example, vista runtime)

A calm fishing evening for 1–4 friends on an island of the game's own: walk out along the pier at sunset, cast, land fish, sell them at
the fish stall and buy better tackle. The evening ends when one of you has landed four different kinds of fish, or when
the clock runs out.

```bash
npx gamesfun create games/my-game --from lantern-cove
npx gamesfun dev games/my-game
```

**Before you start: vista plays on a desktop only.** It is open to pitches (its registry manifest says so;
`npx gamesfun catalog runtimes` shows its device limits). What it needs:
- **WebGPU on a desktop graphics card.** The runtime has no WebGL path: in a browser without WebGPU the game shows the
  kit's "open in a browser with WebGPU" screen. It also needs an adapter with at least 31 sampled and 5 storage
  textures per shader stage (`gf/vista/kit/gpu.js`, `MIN_LIMITS`); a card below that gets the same screen. Never for a
  phone or for a post on X.
- **About 62 MB per game.** `create` copies the runtime's core into `gf/vista/core/` (about 53 MB: its code, sounds,
  models and textures).
- **A first visit of about 10 s** while the core compiles its shaders.

What it shows:
- **`"runtime": "vista"` in the spec (no profile), kind `calm`.** A physical sky and light over a simulated ocean with
  clouds, seen in first person, on an island of the game's own: `world.islands` gives it a seed and a few words (a
  medium island with twin peaks, a coast cut by coves, a river mouth, golden sand, a timber hamlet, seen at sunset), and
  the vista runtime generates it with the core's own terrain, plants, village kit and shore (`gf/vista/kit/world/places.js`;
  `npx gamesfun catalog runtimes` lists every word). Another seed or another word is another island; gate F fails a
  game that comes up on the core's reference island instead. `look.preset` picks one of six looks; the hour, the sea
  state, the exposure and the clouds are each a slot, and an island's `time` and `weather` words set them. The clouds
  are the core's own (`core/src/sky/Clouds.js`, MIT): this kit leaves out the volumetric sky-pro-webgpu clouds (their
  notice names a separate licence).
- **A game with no mechanic modules.** The core plays the walking, swimming, the boat and the fishing from the data
  tables in `spec.json` → `vista` (the species, the gear, the two vendors, the money, where you start); create refuses
  what the core cannot do. `rules.js` keeps only the score and the goal (`rules.goalSpecies`, a slot).
- **Friends on the same island.** Each friend is a gf-humanoid-1 body (six Microsoft Rocketbox people, MIT) in their own
  colour; each player fishes on their own copy and keeps their own score. A player in a room can Go live from the
  menu: anyone with the link watches through their eyes, then joins (voice chat from the menu where Studio's page is
  above the game).

**Checks.** A fresh create passes a build `verify` (all six gates) on a machine with WebGPU (see `example.json`),
including gate F's islands leg: the game is built on its own island from its seed and words, never the reference
island. Twelve measures are skipped for vista, each with its reason in `verdict.json` (such as the audio gate run and a
viewer's copy) and never counted as passed. CI does not run it: GitHub's runners have no WebGPU adapter (docs/CI.md).

Provenance: games.fun's vista development spec (`runtimes/vista/specs/thin-cove.spec.json`), with the prompt
reworded; our own design and names. The runtime's core is Tidewater by DRG Software Solutions LLC (MIT), credited in
`gf/vista/core/ATTRIBUTION.md` in every game (THIRD_PARTY.md).
