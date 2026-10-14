// Watch then play on the vista runtime, with no browser (runtimes/vista/kit/watch.js): the camera a pose carries, the
// view a viewer looks through (sent, or the walker's eyes from the feet), the viewer's camera placed with the core's own
// free camera and held still, the streamer's boat brought along, and the boot offering Go live and voice chat.
// The whole flow in a WebGPU Chrome is the shared measure 34 (builder/tools/lib/friends-watch-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cameraPose, viewOf, holdBoat, createWatchCamera, watchCss, WATCH_KEEPS, EYE, SWIM_EYE } from '../runtimes/vista/kit/watch.js';

const ROOT = new URL('..', import.meta.url).pathname;

class Vec { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Quat { setFromAxisAngle(axis, a) { this.axis = [axis.x, axis.y, axis.z]; this.angle = a; return this; } }
/** A camera as the core leaves it after a frame: rotation (pitch, yaw, 0, 'YXZ'), so it looks along
 *  (−sin yaw cos pitch, sin pitch, −cos yaw cos pitch) and its matrix's third column is the opposite. */
function camera(x, y, z, yaw, pitch) {
  const e = new Array(16).fill(0);
  e[8] = Math.sin(yaw) * Math.cos(pitch); e[9] = -Math.sin(pitch); e[10] = Math.cos(yaw) * Math.cos(pitch);
  return { position: new Vec(x, y, z), matrixWorld: { elements: e } };
}
function fakeApp() {
  const app = {
    camera: camera(0, 0, 0, 0, 0), freeCam: false, toggled: 0,
    setFreeCam(on) { this.freeCam = on; this.toggled++; },
    fly: { enabled: true, velocity: new Vec(1, 2, 3), setPose(p, yaw, pitch) { this.pose = { x: p.x, y: p.y, z: p.z, yaw, pitch }; } },
    boatCtl: { position: new Vec(64.5, 0, 36), quaternion: new Quat(), velocity: new Vec(3, 0, 1), angular: new Vec(0, 1, 0), moored: false, driven: true, mooring: { anchor: new Vec(), heading: 0 }, applied: 0, apply() { this.applied++; } },
  };
  return app;
}

test('a pose carries the camera the core drew: its eye, yaw and pitch', () => {
  const c = cameraPose(camera(55.2, 1.64, -75.5, 0.7, -0.2));
  assert.deepEqual(c, { x: 55.2, y: 1.64, z: -75.5, yaw: 0.7, pitch: -0.2 });
  assert.equal(cameraPose(camera(0, 0, 0, Math.PI - 0.1, 0.3)).yaw, Math.round((Math.PI - 0.1) * 1000) / 1000);
});

test('a viewer looks through the camera sent, else the walker\'s or swimmer\'s eyes over the feet', () => {
  assert.deepEqual(viewOf({ x: 1, y: 2, z: 3, yaw: 0.4, pitch: 0.1, cam: { x: 1, y: 3.6, z: 3, yaw: 0.5, pitch: -0.1 } }), { x: 1, y: 3.6, z: 3, yaw: 0.5, pitch: -0.1 });
  assert.deepEqual(viewOf({ x: 1, y: 2, z: 3, yaw: 0.4, pitch: 0.1, mode: 'walk' }), { x: 1, y: 2 + EYE, z: 3, yaw: 0.4, pitch: 0.1 });
  assert.equal(viewOf({ x: 1, y: -0.5, z: 3, yaw: 0, mode: 'swim' }).y, -0.5 + SWIM_EYE);
  assert.equal(viewOf({ x: 1, y: 2, z: 3, yaw: 7 }).yaw.toFixed(3), Math.atan2(Math.sin(7), Math.cos(7)).toFixed(3));
  assert.equal(viewOf({ x: 1, y: 2, z: 3, cam: { x: 1, y: NaN, z: 3, yaw: 0, pitch: 0 } }).y, 2 + EYE, 'a broken camera falls back to the eyes');
  assert.deepEqual(viewOf({ x: 1, y: 2, z: 3, yaw: 0, b: { x: 70, y: 0.1, z: 40, yaw: 1.2 } }).boat, { x: 70, y: 0.1, z: 40, yaw: 1.2 });
  assert.equal(viewOf(null), null);
  assert.equal(viewOf({ y: 1 }), null);
});

test('the viewer\'s camera: the core\'s free camera, held still, on the streamer\'s eyes; the overview until they are drawn', () => {
  const app = fakeApp();
  const views = { p2: null };
  const overview = { x: 24, y: 4.5, z: -46, yaw: 2.6, pitch: -0.08 };
  const cam = createWatchCamera(app, { view: id => views[id] }, { follow: () => 'p2', overview });
  cam.frame();
  assert.equal(app.freeCam, true);
  assert.equal(app.fly.enabled, false, 'nothing of the viewer\'s moves it');
  assert.deepEqual([app.fly.velocity.x, app.fly.velocity.y, app.fly.velocity.z], [0, 0, 0]);
  assert.deepEqual(app.fly.pose, overview);
  assert.equal(cam.target, null); assert.equal(cam.camera, 'overview');
  views.p2 = { x: 55, y: 1.6, z: -75, yaw: 0.3, pitch: -0.1 };
  cam.frame();
  assert.deepEqual(app.fly.pose, views.p2);
  assert.equal(cam.target, 'p2'); assert.equal(cam.camera, 'first');
  assert.equal(app.toggled, 1, 'the free camera is turned on once');
  assert.equal(app.boatCtl.applied, 0, 'the boat stays put while the streamer is ashore');
});

test('the streamer at the helm: the viewer\'s own boat is held on its mooring lines where theirs is', () => {
  const app = fakeApp();
  const cam = createWatchCamera(app, { view: () => ({ x: 80, y: 2.4, z: 60, yaw: 1, pitch: 0, boat: { x: 81, y: 0.2, z: 61, yaw: 1.1 } }) }, { follow: () => 'p2', overview: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 } });
  cam.frame();
  const b = app.boatCtl;
  assert.deepEqual([b.position.x, b.position.y, b.position.z], [81, 0.2, 61]);
  assert.deepEqual(b.quaternion.axis, [0, 1, 0]); assert.equal(b.quaternion.angle, 1.1);
  assert.deepEqual([b.velocity.x, b.velocity.z, b.angular.y], [0, 0, 0]);
  assert.equal(b.moored, true); assert.equal(b.driven, false);
  assert.deepEqual([b.mooring.anchor.x, b.mooring.anchor.z, b.mooring.heading], [81, 61, 1.1]);
  assert.equal(b.applied, 1);
  assert.equal(holdBoat({}, { x: 0, y: 0, z: 0, yaw: 0 }), false, 'no boat, nothing held');
});

test('a viewer keeps what everyone sees of the HUD, never a player\'s own', () => {
  for (const k of ['.gf-plates', '.gf-top', '.gf-scores', '.gf-fsbtn']) assert.ok(WATCH_KEEPS.includes(k), k);
  assert.match(watchCss(), /^#gf-ui\.gf-watching > :not\(\.gf-plates\)/);
  assert.doesNotMatch(watchCss(), /gf-vista-hud|gf-hud\b/);
});

test('the vista boot offers Go live and voice chat in a room, and the viewer looks through the streamer\'s eyes', async () => {
  const boot = await readFile(`${ROOT}runtimes/three/kit/core/boot-vista.js`, 'utf8');
  for (const s of ['goLive:', 'showLive:', 'voice: () => net.live?.voice', 'voiceOpen:', 'voiceClose:', 'net.live?.onChange', 'createWatchCamera(', 'watchCam.frame()', 'plates: friends.plates(']) assert.ok(boot.includes(s), s);
  assert.doesNotMatch(boot, /live: \(\) => null/);
  const players = await readFile(`${ROOT}runtimes/vista/kit/players.js`, 'utf8');
  assert.match(players, /out\.cam = cameraPose\(cam\)/);
  const rt = JSON.parse(await readFile(`${ROOT}runtimes/vista/runtime.json`, 'utf8'));
  assert.equal(rt.limits.watch, true);
  assert.equal(rt.limits.voice, true);
});
