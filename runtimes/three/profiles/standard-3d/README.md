# The standard-3d profile

The three runtime's default profile: the kit in `runtimes/three/kit/` itself (WebGL, the look presets, the follow,
third-person and first-person cameras, the Rapier capsule controller), with the mechanics (`components/`), the loops
(`loops/`), the world (`worlds/`) and the menu and HUD (`builder/ui/`) it assembles into a game's `gf/three/`. This
folder holds no code of its own: the profile is the kit, and the other two profiles are what differs from it.

- `../flat-2d/`: 2D games seen from above or from the side (`"profile": "flat-2d"`), inside a game's `gf/three/flat/`.
- `../scenic-3d/`: the scenic look and generated islands and dungeons on WebGPU (`"profile": "scenic-3d"`), a game's
  `gf/scenic/` beside its `gf/three/`.

A profile is chosen by hard limits (devices, graphics, camera, what must be built), never by taste; spec v2 names it.
Where everything is: [docs/LAYOUT.md](../../../../docs/LAYOUT.md).
