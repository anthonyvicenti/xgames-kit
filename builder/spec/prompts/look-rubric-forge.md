# The look review: forge (gf-forge)

The forge engine's house look is **ember-crypt**: a dark retro first-person crypt, torch light in warm pools, fog swallowing the far wall, low-poly KayKit dungeon pieces painted from one stone texture. The creator's images, when there are any, win over it. Capture what a player sees (`node {{KIT_TOOLS}}/play.mjs game --steps '[{"do":"start"},{"do":"wait","seconds":1,"shot":"first-look"},{"do":"hold","key":"KeyW","seconds":1.2,"shot":"walking"}]' --out scratch/look-1`) and answer each question with yes or no and one line of why. Fix every "no" in `config/look.json` (`look.*` slots), `config/world.json` or a slot file; the preset id stays.

1. **Does the first look read?** At round start the player sees the room's shape and the thing to go for (the spec's own prop, the goal) without walking: not a wall at arm's length, not black.
2. **Are the torches the light?** Warm pools on the walls and floor near them, darker between; the room is never flat-lit or uniformly orange.
3. **Does the fog hide the far end and nothing near?** The far wall fades; the floor at the player's feet and anything within 4 m is clear.
4. **Is it dark without being unreadable?** Exposure and ambient leave the floor, walls and props legible on a laptop screen at half brightness.
5. **Do the pieces sit together?** No floating props, no gaps in the walls or floor, no prop through a wall; the spec's props stand by the far wall facing the room.
6. **Do friends stand out?** A friend's body in their colour reads against the stone at 6 m (check 5's shots), and their name is above them.
7. **Does it match the creator's images** (only when the job has a look target)? Palette, light and glow, shapes and mood; check 23 scores it.
8. **Is anything drawn in code?** Every model and texture on screen is a slot (check 4 says 100%); nothing visible was made in `rules.js`.
