# Ruin Hold (example, forge runtime)

A first-person co-op hold for 1–4 players on the forge runtime (the Rust core on wgpu; `"runtime": "forge"`, kind `dark`): two waves of skeletons rise
from the graves of a moonlit ruin, the second led by their captain. Shoot, cut and dodge; with friends, a fallen
hunter is raised by a friend holding E beside them.

```bash
npx gamesfun create games/my-game --from ruin-hold
npx gamesfun dev games/my-game
```

What it shows:
- **The forge runtime's whole surface in one small game.** The spec's `tables` say what the weapons, enemies and
  waves are; the core simulates them (the first-person controller, the weapons' feel, the wave director, the enemies'
  AI, down and revive, live co-op where the host's core owns the world). `rules.js` says only what a hold is: what
  scores, how it is won and lost, the health a cleared wave gives back.
- **Free stand-in art.** Every model is a CC0 stand-in from the forge library (KayKit skeletons, adventurers and
  graveyard pieces, Quaternius weapons; `runtimes/forge/tools/stand-ins.mjs`), named in the game's ATTRIBUTION.md.
  Every model, texture and table value is a slot: `npx gamesfun slots list games/my-game --all`.
- **The game's own test.** `files/tests/the-dead-rise.test.json` holds the core loop to what a player sees (the
  director runs, the dead rise, more keep coming); verify runs it on stepped time (measure 35).

Limits, said plainly: first person only; WebGPU where the browser has it, else the WebGL2 build; co-op only (players
cannot hurt each other); no rewards between waves (the forge kit has a card table and a shop: see
`runtimes/forge/specs/vigil.spec.json`).

Provenance: written for this kit from the forge runtime's development specs (`runtimes/forge/specs/`), same owner.
