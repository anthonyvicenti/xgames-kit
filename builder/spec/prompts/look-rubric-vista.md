# The look review: vista (gf-vista)

The vista engine's house look is **golden-hour**: a physical sky and sun over a simulated ocean, volumetric cumulus, a tropical island with a long wooden pier, seen in first person. The game's own look is `config/look.json` (`preset`, `hour`, `sea`, `exposure`, `clouds`), and the creator's images, when there are any, win over it. Capture what a player sees (`node {{KIT_TOOLS}}/play.mjs game --steps '[{"do":"start"},{"do":"wait","seconds":1,"shot":"first-look"},{"do":"look","dx":650},{"do":"wait","seconds":1,"shot":"turned"}]' --out scratch/look-1`) and answer each question with yes or no and one line of why. Fix every "no" in `config/look.json` (`look.*` slots); the world and the core are not yours to change.

1. **Does the first look read?** At the start the player sees the sea, the sky and where they are (the pier head, the beach), not a wall of sand or the sky alone.
2. **Is the light the spec's?** The hour and the sky match the title and the hook (a sunset game shows a low gold sun, a night game the moon and lamps), and the exposure leaves the deck, the water and the clouds legible on a laptop screen at half brightness.
3. **Is the sea alive?** Waves move and glint; the sea state fits the mood (calm for a quiet evening, a storm swell only when the game is about weather). Verify check 36 measures it moving.
4. **Do the clouds sit right?** Cloud cover neither empties the sky nor closes it for no reason (`clouds` near 0.5 for fair weather).
5. **Do friends stand out?** A friend in their colour reads against the deck and the sea at 6 m, with their name above them.
6. **Does it match the creator's images** (only when the job has a look target)? Light, palette, sky and mood; check 23 scores it.
7. **Are the words our own?** No name of another game, person or place on screen: the title, the stalls, the species and the gear are this game's words.
