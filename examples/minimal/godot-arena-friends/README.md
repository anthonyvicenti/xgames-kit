# Arena Friends (example, runtime godot, profile 3d)

The 3D starter on runtime godot: create's output from `spec.json` (profile `3d`, camera `follow`, world `arena`),
untouched. The arena is the field generator's map seen from above, built in 3D (the base kind is the ground, walls
stand 2 m, water is a basin you cannot walk into), every surface a tile picture slot. The body is the asset library's
gf-humanoid-1 jelly bean (`gf-beans/bean-classic`) (`character.body.player`, a GLB slot read at run time), played with the kit's shared clip file
through the standard's retarget (`addons/gf/gf_rig_3d.gd`, the same scheme as three's `rig.js`). Alone, bots fill the
empty seats; with friends, each sees the others where they really are.

```bash
npx gamesfun create games/my-arena --from godot-arena-friends   # installs Godot, and the 3D tools' packages, the first time
npx gamesfun verify games/my-arena
```
