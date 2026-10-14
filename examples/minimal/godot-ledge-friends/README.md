# Ledge Friends (example, runtime godot)

The smallest game on runtime godot: create's output from `spec.json`, untouched. A side-on stage (the default
gf-tilemap-1 map), a body from the kit's stand-in pictures, Godot's own 2D physics, and the friends drawn where they
really are. One idea (the GF autoload is the whole API a Godot game needs), one check (two players each see the other).

```bash
npx gamesfun create games/my-godot-game --from godot-ledge-friends   # installs Godot 4.6 the first time
npx gamesfun dev games/my-godot-game                                # re-exports when project/ changes
npx gamesfun verify games/my-godot-game
```

What the game is made of: `project/` (the Godot project: `main.gd` is the game's, `addons/gf/` the kit's), `rules.js`
(the round's rules in JavaScript), and the slots in `assets.json`. See `runtimes/godot/README.md`.
