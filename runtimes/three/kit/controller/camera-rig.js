// gf-three controller: camera rigs. 'third' (an orbit behind the shoulder, pulled in front of walls), 'first' (at the
// eyes), 'top' (a fixed high angle that follows) and 'follow' (CONTRACT §8: the three-quarter diorama camera of the
// scenic-3d profile, after folio-2025's View.js: a long lens at a fixed angle, smoothed, the wheel zooms, and the aim is the
// point under the mouse cursor, which stays free). Look input comes from kit/core/input.js (mouse with pointer lock
// or drag, touch on the right half); this file adds no listeners.
//
// The third-person rig started from games.fun's third-person-adventure trial (src/camera-rig.js, authored for it;
// ecctrl uses drei CameraControls, which was not ported): pivot smoothing, a Rapier sphere cast from the pivot that
// pulls the camera in front of walls (fast in, slow out). Yaw convention: forward = (sin yaw, 0, cos yaw).
import * as THREE from 'three';
import { SOLID_QUERY } from '../core/util.js';

// third: over the right shoulder. The middle of the screen (the crosshair) sits at head height, `shoulder` metres right
// of the player, so the player's own body never covers it and a shot or stream that lands there is in plain view
// (until 2026-10-07 it was 0.45 m at chest height: the crosshair sat on the body and the stream landed behind it).
export const RIG_DEFAULTS = {
  third: { distance: 5.2, minDistance: 1.6, height: 1.7, shoulder: 0.85, pitchDeg: 16, minPitchDeg: -30, maxPitchDeg: 65, fov: 60, collisionRadius: 0.22, sensitivity: 0.0026 },
  first: { height: 1.55, pitchDeg: 0, minPitchDeg: -75, maxPitchDeg: 75, fov: 72, sensitivity: 0.0024 },
  top: { distance: 15, height: 0.8, pitchDeg: 58, fov: 50, yawDeg: 0, sensitivity: 0 },
  // folio-2025 View.js: fov 25, theta 45; pulled back and up from its 15-30 m at 41 degrees (2026-10-08, after verify
  // check 23 judged the arena-filling view unlike the creator's diorama pictures): the island, its edge and the void read
  follow: { distance: 34, minDistance: 20, maxDistance: 46, height: 0.9, pitchDeg: 48, fov: 25, yawDeg: 45, sensitivity: 0, smooth: 7, zoomStep: 0.08 },
  // orbit (CONTRACT §9, worlds): third person behind the player with the mouse free. A drag turns it (the input's
  // 'drag' cursor mode), the wheel zooms, and the aim is the point under the cursor, so a builder clicks the block
  // face they see. Works the same in a post's frame that refuses the pointer lock (CONTRACT §6d C5). collisionMin: how
  // close a wall may pull it (the wheel stops at minDistance); in a crater or a one-block room it comes right up to the
  // player's head rather than sitting inside the ground (play-test 2026-10-09: the screen showed only grass)
  orbit: { distance: 8, minDistance: 2.6, maxDistance: 20, collisionMin: 0.35, height: 1.45, pitchDeg: 26, minPitchDeg: -25, maxPitchDeg: 82, fov: 55, collisionRadius: 0.22, sensitivity: 0.0052, zoomStep: 0.11 },
};
const DEG = Math.PI / 180;

/**
 * How far from the player the crosshair rests on flat ground when the camera is left alone: the ray from the camera
 * through the pivot (`height` above the feet, pitched down `pitchDeg`) meets the ground `height / tan(pitch)` past the
 * pivot. Pure, so create reads it from a game's own camera config (a mechanic's derived defaults: the projectile's
 * stream reaches it). → metres, or null for a rig with no crosshair at rest (first person looks at the horizon; top and
 * follow aim at the cursor).
 */
export function restAimDistance(mode = 'third', settings = {}) {
  if (mode !== 'third' && mode !== 'orbit') return null;
  const C = { ...RIG_DEFAULTS[mode], ...settings }, pitch = (C.pitchDeg ?? 0) * DEG;
  return pitch > 0.01 && C.height > 0 ? C.height / Math.tan(pitch) : null;
}

export function createCameraRig({ camera, mode = 'third', physics = null, exclude = null, settings = {}, yaw = 0, pointer = null, wheel = null, free = null }) {
  const C = { ...RIG_DEFAULTS[mode] ?? RIG_DEFAULTS.third, ...settings };
  const fixed = mode === 'top' || mode === 'follow';
  const st = { mode, yaw: fixed ? (C.yawDeg ?? 0) * DEG : yaw, pitch: C.pitchDeg * DEG, current: C.distance ?? 0, zoom: C.distance ?? 0, pivot: new THREE.Vector3(), first: true, collided: false };
  camera.fov = C.fov; camera.updateProjectionMatrix();
  const ball = physics ? new physics.RAPIER.Ball(C.collisionRadius ?? 0.2) : null;
  const rot0 = { x: 0, y: 0, z: 0, w: 1 };
  const target = new THREE.Vector3(), dir = new THREE.Vector3(), pivot = new THREE.Vector3(), aim = new THREE.Vector3(0, 0, 1), fwd = new THREE.Vector3(0, 0, 1);
  const cursorDir = new THREE.Vector3(), ndc = new THREE.Vector3();

  if (mode === 'orbit') st.zoom = C.distance;
  function look(dx, dy) {
    if (fixed || !C.sensitivity) return;
    st.yaw -= dx * C.sensitivity;
    st.pitch = Math.max(C.minPitchDeg * DEG, Math.min(C.maxPitchDeg * DEG, st.pitch + dy * C.sensitivity));
  }

  /** feet: the followed player's feet {x, y, z}; onGround smooths vertical motion. */
  function update(dt, feet, { onGround = true } = {}) {
    target.set(feet.x, feet.y + C.height, feet.z);
    if (st.first) { st.pivot.copy(target); st.first = false; }
    if (mode === 'follow') {
      // the wheel zooms between minDistance and maxDistance; the pivot follows smoothly (folio's focus point)
      const w = wheel?.() ?? 0;
      if (w) st.zoom = Math.max(C.minDistance, Math.min(C.maxDistance, st.zoom * (1 - w * C.zoomStep)));
      const k = 1 - Math.exp(-dt * C.smooth);
      st.pivot.lerp(target, k);
      st.current += (st.zoom - st.current) * k;
      const cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
      dir.set(-Math.sin(st.yaw) * cp, sp, -Math.cos(st.yaw) * cp).normalize();
      camera.position.copy(st.pivot).addScaledVector(dir, st.current);
      camera.lookAt(st.pivot.x, st.pivot.y, st.pivot.z);
      camera.updateMatrixWorld();
      camera.getWorldDirection(fwd);
      aim.set(Math.sin(st.yaw), 0, Math.cos(st.yaw));
      return;
    }
    const kh = 1 - Math.exp(-dt * 18), kv = 1 - Math.exp(-dt * (onGround ? 10 : 5));
    st.pivot.x += (target.x - st.pivot.x) * kh; st.pivot.z += (target.z - st.pivot.z) * kh; st.pivot.y += (target.y - st.pivot.y) * kv;
    const cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
    if (mode === 'first') {
      // the eyes stay under a ceiling: the body (1.4 m) jumps into a two-block room's roof with its eyes (1.55 m) above
      // the body's top, so a ball cast up from the chest keeps them below anything solid
      let eye = feet.y + C.height;
      if (physics && ball) {
        const from = { x: feet.x, y: feet.y + 0.9, z: feet.z };
        const hit = physics.world.castShape(from, rot0, { x: 0, y: 1, z: 0 }, ball, 0, Math.max(0, C.height - 0.9), true, undefined, SOLID_QUERY, exclude ?? undefined);
        if (hit) eye = Math.min(eye, from.y + Math.max(0, hit.time_of_impact - 0.02));
      }
      camera.position.set(feet.x, eye, feet.z);
      aim.set(Math.sin(st.yaw) * cp, -sp, Math.cos(st.yaw) * cp).normalize();
      camera.lookAt(camera.position.x + aim.x, camera.position.y + aim.y, camera.position.z + aim.z);
      fwd.copy(aim);
      return;
    }
    // the camera sits behind the pivot: opposite the look direction, raised by the pitch
    dir.set(-Math.sin(st.yaw) * cp, sp, -Math.cos(st.yaw) * cp).normalize();
    pivot.copy(st.pivot);
    if (mode === 'third' && C.shoulder) { pivot.x += -Math.cos(st.yaw) * C.shoulder * Math.min(1, st.current / C.distance); pivot.z += Math.sin(st.yaw) * C.shoulder * Math.min(1, st.current / C.distance); }
    if (mode === 'orbit') { const w = wheel?.() ?? 0; if (w) st.zoom = Math.max(C.minDistance, Math.min(C.maxDistance, st.zoom * (1 - w * C.zoomStep))); }
    let allowed = mode === 'orbit' ? st.zoom : C.distance;
    if (physics && (mode === 'third' || mode === 'orbit')) {
      const hit = physics.world.castShape({ x: pivot.x, y: pivot.y, z: pivot.z }, rot0, { x: dir.x, y: dir.y, z: dir.z }, ball, 0, allowed, true, undefined, SOLID_QUERY, exclude ?? undefined);
      st.collided = !!hit;
      if (hit) allowed = Math.max(C.collisionMin ?? C.minDistance, hit.time_of_impact - 0.05);
    }
    st.current = allowed < st.current ? allowed : st.current + (allowed - st.current) * (1 - Math.exp(-dt * 2.5));
    camera.position.copy(pivot).addScaledVector(dir, st.current);
    if (camera.position.y < feet.y + 0.3) camera.position.y = feet.y + 0.3;
    camera.lookAt(pivot.x, pivot.y, pivot.z);
    // where the player aims: through the middle of the screen (third), or the way the camera faces on the ground (top)
    camera.getWorldDirection(fwd);
    if (mode === 'top') aim.set(Math.sin(st.yaw), 0, Math.cos(st.yaw));
    else aim.copy(fwd);
  }

  return {
    state: st, settings: C, look, update,
    /** The camera's heading: movement input is relative to it. */
    get yaw() { return st.yaw; },
    set yaw(v) { st.yaw = v; },
    /** A normalised aim direction (THREE.Vector3, reused): the camera's forward (third, first), the heading (top). */
    aim: () => aim,
    /** The crosshair ray: from the camera through the middle of the screen ({from, dir}, reused vectors); null for 'top'
     *  (no crosshair). 'follow' and 'orbit': through the mouse cursor (fromCamera: the whole ray counts, kit/core/aim.js),
     *  or null while the cursor is off the canvas. 'first' in a world: through the cursor or the last tap while `free()`
     *  (the frame refused the lock, or touch; the middle until the pointer is on the canvas), else the middle. The
     *  controller casts it into the world for the aim point. */
    ray: () => {
      if (mode === 'top') return null;
      const p = pointer?.(), viaPointer = mode === 'follow' || mode === 'orbit' || (mode === 'first' && !!free?.() && !!p?.inside);
      if (viaPointer) {
        if (!p?.inside) return null;
        ndc.set(p.x, p.y, 0.5).unproject(camera);
        cursorDir.copy(ndc).sub(camera.position).normalize();
        return { from: camera.position, dir: cursorDir, fromCamera: true };
      }
      return { from: camera.position, dir: fwd };
    },
    /** The view's pitch (radians, + looks down) and whether the aim goes through the pointer, for the observation. */
    get pitch() { return st.pitch; },
    aimsAtPointer: () => mode === 'follow' || mode === 'orbit' || (mode === 'first' && !!free?.()),
    reset(yawValue) { if (!fixed) st.yaw = yawValue ?? st.yaw; st.pitch = C.pitchDeg * DEG; st.current = st.zoom = C.distance ?? 0; st.first = true; },
    /** The camera distance now (orbit: the zoom, before walls pull it in). */
    get zoom() { return st.zoom; },
  };
}
