// gf-vista's watch then play (gf-multiplayer 1.6.0+, runtimes/CONTRACT.md §4 "Watch, voice"): a page opened as a
// stream's viewer (net.watching) is a copy with no player of its own that looks out of the streamer's eyes. No core
// change: the core's own free camera (core/src/player/FlyCamera.js, the F key's debug camera) is the viewer's eye, held
// still (fly.enabled false: nothing of the viewer's moves it) and placed each frame, before the core's frame, where the
// streamer's camera was. Every vista copy sends the camera its core drew with its pose (players.js `cam`); gf/mp
// interpolates it with the rest of the pose, 130 ms behind. When the streamer is at the helm their boat comes along: the
// viewer's own boat (nobody drives it on a viewer's copy) is held on its mooring lines where the streamer's boat is,
// the way the core's own bench holds it out in open water (core/src/core/Bench.js).
//
//   const cam = createWatchCamera(app, players, { follow: () => net.watch?.follow?.id ?? null, overview })
//   every frame on a viewer, before app.frame(dt): cam.frame()
//   cam.target   whom the camera has (an id), or null while the streamer is not drawn (the overview)
//   cam.camera   'first' (the streamer's eyes) or 'overview'
//
// Nothing here imports the core: tests drive it with a stand-in app (tests/vista-watch.test.mjs).

/** The eye height of the core's walker and swimmer (core/src/player/Player.js EYE, SWIM_EYE), for a pose sent without
 *  its camera. */
export const EYE = 1.62, SWIM_EYE = 0.162;

/** What a stream's viewer keeps of the shared HUD (direct children of #gf-ui), as boot.js keeps: names, the clock, the
 *  scores, banners and the goal. Never a player's own card, menu, prompts or vista's own HUD (money, rod, cooler). */
export const WATCH_KEEPS = ['.gf-plates', '.gf-bars', '.gf-fsbtn', '.gf-top', '.gf-scores', '.gf-banner', '.gf-goal'];
export const watchCss = () => `#gf-ui.gf-watching > ${WATCH_KEEPS.map(s => `:not(${s})`).join('')}{display:none !important}`;

const r3 = v => Math.round(v * 1000) / 1000;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/** The camera a core drew, as a pose carries it: {x, y, z, yaw, pitch} (yaw 0 looks down −z, as the core's walker). */
export function cameraPose(cam) {
  const e = cam.matrixWorld.elements;   // column 2 is +Z; the camera looks down −Z
  const fx = -e[8], fy = -e[9], fz = -e[10];
  return { x: r3(cam.position.x), y: r3(cam.position.y), z: r3(cam.position.z), yaw: r3(Math.atan2(-fx, -fz)), pitch: r3(Math.asin(Math.max(-1, Math.min(1, fy)))) };
}

/** A pose (net.peers() state) → the camera to look through: the one sent, else the walker's eyes from the feet. */
export function viewOf(s) {
  if (!s || !Number.isFinite(s.x)) return null;
  const c = s.cam;
  const v = c && [c.x, c.y, c.z, c.yaw, c.pitch].every(Number.isFinite)
    ? { x: c.x, y: c.y, z: c.z, yaw: wrap(c.yaw), pitch: c.pitch }
    : { x: s.x, y: (s.y ?? 0) + (s.mode === 'swim' ? SWIM_EYE : EYE), z: s.z, yaw: wrap(s.yaw ?? 0), pitch: Number.isFinite(s.pitch) ? s.pitch : 0 };
  if (s.b && [s.b.x, s.b.y, s.b.z, s.b.yaw].every(Number.isFinite)) v.boat = { x: s.b.x, y: s.b.y, z: s.b.z, yaw: s.b.yaw };
  return v;
}

/** The viewer's own boat where the streamer's is: on its mooring lines there, still, facing their way. */
export function holdBoat(app, b) {
  const bc = app.boatCtl;
  if (!bc?.position || !bc.quaternion) return false;
  const V = bc.position.constructor;
  bc.position.set(b.x, b.y, b.z);
  bc.quaternion.setFromAxisAngle(new V(0, 1, 0), b.yaw);
  bc.velocity?.set?.(0, 0, 0); bc.angular?.set?.(0, 0, 0);
  bc.moored = true; bc.driven = false;
  bc.mooring?.anchor?.set?.(b.x, b.y, b.z);
  if (bc.mooring) bc.mooring.heading = b.yaw;
  bc.apply?.();
  return true;
}

/**
 * The viewer's camera. follow() → the streamer's id (net.watch.follow.id); overview {x, y, z, yaw, pitch}: where the
 * camera waits while the streamer is not drawn (before the round, between rounds, a stream tuning in).
 */
export function createWatchCamera(app, players, { follow = () => null, overview }) {
  const V = app.camera.position.constructor;
  const at = new V();
  const state = { target: null, camera: 'overview' };
  function frame() {
    if (!app.freeCam) app.setFreeCam(true);
    app.fly.enabled = false;
    app.fly.velocity?.set?.(0, 0, 0);
    const id = follow(), v = id ? players.view(id) : null;
    const p = v ?? overview;
    state.target = v ? id : null; state.camera = v ? 'first' : 'overview';
    at.set(p.x, p.y, p.z);
    app.fly.setPose(at, p.yaw, p.pitch);
    if (v?.boat) holdBoat(app, v.boat);
  }
  return { frame, get target() { return state.target; }, get camera() { return state.camera; } };
}
