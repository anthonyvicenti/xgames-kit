// gf-three juice: the feel of a hit, for any game (kit-owned, ctx.juice). Screen shake, hitstop, a brief slow motion on
// a big hit, and a camera that follows a moving thing (a shell in flight, a body thrown across the map). A mechanic or
// rules.js asks for them by size; the player's comfort settings decide how much of it they get.
//
//   ctx.juice.shake(amount, { at, reach })     shake the camera (metres at the strongest); fades with the distance from
//                                               `at` to the camera over `reach` metres
//   ctx.juice.hitstop(seconds)                  freeze time for a moment (real seconds, at most 0.25)
//   ctx.juice.slowmo(seconds, scale = 0.35)     slow time down, easing back (real seconds, at most 1.5)
//   ctx.juice.impact(size, { at, local })       all three sized from one number 0..1 (a blast's force, a hit's damage):
//                                               a small one shakes; a big one also stops time for an instant; a very
//                                               big one near this screen's player (or `local`) slows it down too
//   ctx.juice.follow(point | fn | null, { seconds, distance, height, from })   the camera frames a moving thing: a
//                                               point {x, y, z} or a function returning one (null when it is gone; it may
//                                               carry its own distance and height: a thrown body seen up close); it
//                                               eases there from the player's own view and back when it ends
//   ctx.juice.following                         is the camera following something now
//   ctx.juice.setComfort({ reduceMotion })      the player's setting (the menu's Settings → Reduce motion)
//   ctx.juice.observe()                         { on, reduceMotion, shake, scale, following, counts }
//
// The boot multiplies each frame's time by timeScale(raw) and calls frame(raw) after the camera rig has placed the
// camera and before drawing. config/game.json → juice { on, shake (0..2, a multiplier), hitstop, slowmo, follow }
// (each a boolean, shake a number). Reduce motion (on when the browser says prefers-reduced-motion, unless the player
// turned it off): no shake, no slow motion, hitstops at most 0.04 s, the follow camera moves slower. Cosmetic and per
// copy: nothing goes on the wire (each screen does its own juice for the events it sees).
import * as THREE from 'three';
import { fixedRay } from './util.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const JUICE_DEFAULTS = { on: true, shake: 1, hitstop: true, slowmo: true, follow: true };
const MAX_SHAKE = 0.6, MAX_HITSTOP = 0.25, MAX_SLOWMO = 1.5, CALM_HITSTOP = 0.04;

/** Did the browser ask for less motion? */
export function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * What an impact of size s (0..1) asks for, before the player's comfort: {shake (m), hitstop (s), slowmo (s)}. Pure.
 * near: the impact is on or next to this screen's player (only those slow time).
 */
export function impactPlan(s, { near = false } = {}) {
  const k = clamp(Number(s) || 0, 0, 1);
  return {
    shake: 0.06 + 0.42 * k * k,
    hitstop: k >= 0.35 ? 0.03 + 0.09 * (k - 0.35) / 0.65 : 0,
    slowmo: near && k >= 0.7 ? 0.45 + 0.5 * (k - 0.7) / 0.3 : 0,
  };
}

/** The time scale over a hitstop and a slow motion, given what is left of each (real seconds). Pure. */
export function scaleOf({ stop = 0, slow = 0, slowFor = 0, slowScale = 0.35 } = {}) {
  if (stop > 0) return 0.02;
  if (slow > 0) {
    // the last 40% of a slow motion eases back to full speed
    const back = Math.max(0.05, slowFor * 0.4), t = slow < back ? 1 - slow / back : 0;
    return slowScale + (1 - slowScale) * t * t;
  }
  return 1;
}

export function createJuice(ctx, cfg = {}) {
  const C = { ...JUICE_DEFAULTS, ...(cfg ?? {}) };
  const comfort = { reduceMotion: prefersReducedMotion() };
  let trauma = 0, stop = 0, slow = 0, slowFor = 0, slowScale = 0.35, t = 0;
  const counts = { shakes: 0, hitstops: 0, slowmos: 0, follows: 0, impacts: 0 };
  // the follow camera: what it looks at, its own smoothed place, and how far it has taken over from the rig (0..1)
  let fol = null, w = 0;
  const camPos = new THREE.Vector3(), camAim = new THREE.Vector3(), want = new THREE.Vector3(), wantAim = new THREE.Vector3();
  const rigPos = new THREE.Vector3(), rigAim = new THREE.Vector3(), fwd = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const on = () => C.on !== false;
  const point = f => { try { const p = typeof f === 'function' ? f() : f; return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null; } catch { return null; } };

  // the follow camera's place for a thing at q: candidate views round it (the kept one first), the first one with open air
  // between it and the thing and the ground below it; with none clear, the preferred one pulled in front of what is in the way
  const SWING = [0, 0.8, -0.8, 1.6, -1.6, 2.6, -2.6, Math.PI], cand = new THREE.Vector3(), axisY = new THREE.Vector3(0, 1, 0), d3 = new THREE.Vector3();
  function placeAt(q, dist, hgt, swing, lift) { d3.copy(fol.dir).applyAxisAngle(axisY, swing); return cand.set(q.x, q.y, q.z).addScaledVector(d3, -dist).setY(q.y + hgt * lift); }
  function clear(q, p) {
    const g = ctx.world?.groundAt?.(p.x, p.z);
    if (Number.isFinite(g) && p.y < g + 1.2) return false;
    const dx = p.x - q.x, dy = p.y - (q.y + 0.6), dz = p.z - q.z, dl = Math.hypot(dx, dy, dz);
    const hit = dl > 0.3 ? fixedRay(ctx, { x: q.x, y: q.y + 0.6, z: q.z }, { x: dx, y: dy, z: dz }, dl) : null;
    return hit === null;
  }
  function view(q, dist, hgt) {
    const tries = [[fol.swing ?? 0, fol.lift ?? 1], ...SWING.flatMap(sw => [[sw, 1], [sw, 1.8]])];
    for (const [sw, lift] of tries) { const p = placeAt(q, dist, hgt, sw, lift); if (clear(q, p)) { fol.swing = sw; fol.lift = lift; return p.clone(); } }
    // nothing clear: the preferred view, pulled in front of what is in the way, over the ground
    const p = placeAt(q, dist, hgt, 0, 1.8), dx = p.x - q.x, dy = p.y - (q.y + 0.6), dz = p.z - q.z, dl = Math.hypot(dx, dy, dz);
    const hit = fixedRay(ctx, { x: q.x, y: q.y + 0.6, z: q.z }, { x: dx, y: dy, z: dz }, dl);
    if (hit !== null) { const k = Math.max(1.2, hit - 0.6) / dl; p.set(q.x + dx * k, q.y + 0.6 + dy * k, q.z + dz * k); }
    return p.clone();
  }

  const api = {
    get on() { return on(); },
    get reduceMotion() { return comfort.reduceMotion; },
    /** reduceMotion: true, false, or null (what the browser says: prefers-reduced-motion). */
    setComfort(o = {}) { if (typeof o.reduceMotion === 'boolean') comfort.reduceMotion = o.reduceMotion; else if (o.reduceMotion === null) comfort.reduceMotion = prefersReducedMotion(); },
    shake(amount, { at = null, reach = 30 } = {}) {
      if (!on() || comfort.reduceMotion || !(amount > 0) || C.shake === false) return;
      let k = 1;
      const cam = ctx.camera?.position;
      if (at && cam) k = clamp(1 - Math.hypot(cam.x - at.x, cam.y - at.y, cam.z - at.z) / Math.max(1, reach), 0, 1);
      if (k <= 0) return;
      trauma = clamp(trauma + amount * k * (Number(C.shake) || 1) / MAX_SHAKE, 0, 1);
      counts.shakes++;
    },
    hitstop(seconds) {
      if (!on() || C.hitstop === false || !(seconds > 0)) return;
      stop = Math.max(stop, Math.min(comfort.reduceMotion ? CALM_HITSTOP : MAX_HITSTOP, seconds));
      counts.hitstops++;
    },
    slowmo(seconds, scale = 0.35) {
      if (!on() || C.slowmo === false || comfort.reduceMotion || !(seconds > 0)) return;
      const s = Math.min(MAX_SLOWMO, seconds);
      if (s > slow) { slow = slowFor = s; slowScale = clamp(scale, 0.1, 1); }
      counts.slowmos++;
    },
    impact(size, { at = null, local = false, reach = null } = {}) {
      if (!on()) return null;
      const me = ctx.me?.position, near = local || (!!at && !!me && Math.hypot(me.x - at.x, me.y - at.y, me.z - at.z) < 6);
      const plan = impactPlan(size, { near });
      api.shake(plan.shake, { at, reach: reach ?? 18 + 30 * clamp(size, 0, 1) });
      if (plan.hitstop) api.hitstop(plan.hitstop);
      if (plan.slowmo) api.slowmo(plan.slowmo);
      counts.impacts++;
      return plan;
    },
    follow(target, { seconds = 6, distance = 13, height = 6, from = null } = {}) {
      if (!target || C.follow === false || !on()) { if (fol) fol.until = 0; return; }
      const cam = ctx.camera;
      // look the way the player looked (or from `from` toward the thing): the view turns as little as it can
      const p = point(target);
      if (from && p) fwd.set(p.x - from.x, 0, p.z - from.z); else if (cam) { cam.getWorldDirection(fwd); fwd.y = 0; } else fwd.set(0, 0, 1);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
      const keep = fol && w > 0;
      fol = { target, until: t + Math.min(30, seconds), distance, height, dir: fwd.clone(), last: p };
      if (!keep && cam) { camPos.copy(cam.position); cam.getWorldDirection(camAim).multiplyScalar(10).add(cam.position); }
      counts.follows++;
    },
    get following() { return !!fol && w > 0.01; },
    /** The boot, before anything moves this frame: the real frame time → the scale for the game's time. */
    timeScale(raw) {
      const dt = Math.max(0, Math.min(0.25, raw || 0));
      if (stop > 0) { stop = Math.max(0, stop - dt); return scaleOf({ stop: stop + 1e-9 }); }
      if (slow > 0) { slow = Math.max(0, slow - dt); return scaleOf({ slow, slowFor, slowScale }); }
      return 1;
    },
    get scale() { return scaleOf({ stop, slow, slowFor, slowScale }); },
    /** The boot, after the camera rig placed the camera and before drawing (real seconds). */
    frame(raw) {
      const dt = Math.max(0, Math.min(0.1, raw || 0)), cam = ctx.camera;
      t += dt;
      if (!cam) return;
      // follow: ease in while the thing is there and its time has not run out, ease out after
      const p = fol ? point(fol.target) : null;
      const active = !!fol && t < fol.until && !!p;
      if (p) fol.last = p;
      w = clamp(w + dt / (active ? (comfort.reduceMotion ? 0.7 : 0.35) : 0.5) * (active ? 1 : -1), 0, 1);
      if (fol && !active && w <= 0) fol = null;
      if (fol && w > 0) {
        const q = p ?? fol.last;
        // the thing may ask to be seen closer or farther ({x, y, z, distance, height}: a thrown body up close)
        const dist = Number.isFinite(q.distance) ? q.distance : fol.distance, hgt = Number.isFinite(q.height) ? q.height : fol.height;
        // a clear view of it: the way the player looked first, else swung round or raised (never inside the ground,
        // behind a cliff or under an overhang); the view it found is kept while it stays clear, so the camera never flicks
        const pick = view(q, dist, hgt);
        want.copy(pick);
        wantAim.set(q.x, q.y + 0.6, q.z);
        const k = 1 - Math.exp(-dt * (comfort.reduceMotion ? 3 : 6));
        camPos.lerp(want, k); camAim.lerp(wantAim, k);
        // blend from where the rig put the camera this frame
        rigPos.copy(cam.position); cam.getWorldDirection(rigAim).multiplyScalar(10).add(rigPos);
        const e = w * w * (3 - 2 * w);
        qa.copy(cam.quaternion);
        m4.lookAt(camPos, camAim, cam.up); qb.setFromRotationMatrix(m4);
        cam.position.lerpVectors(rigPos, camPos, e);
        cam.quaternion.slerpQuaternions(qa, qb, e);
      } else if (fol === null) { camPos.copy(cam.position); }
      // shake: trauma squared, smooth noise, fading
      if (trauma > 0) {
        const a = trauma * trauma * MAX_SHAKE;
        const n = (o, f) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.31 + o * 1.7) * 0.4;
        cam.position.x += a * n(1.3, 37); cam.position.y += a * n(4.1, 41) * 0.8; cam.position.z += a * n(7.7, 33);
        cam.rotateZ(a * 0.05 * n(2.9, 29));
        trauma = Math.max(0, trauma - dt * 1.6);
      }
      cam.updateMatrixWorld();
    },
    observe: () => ({ on: on(), reduceMotion: comfort.reduceMotion, shake: Math.round(trauma * 100) / 100, scale: Math.round(api.scale * 100) / 100, following: api.following, counts: { ...counts } }),
  };
  return api;
}
