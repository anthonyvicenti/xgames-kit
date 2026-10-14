// The four contact-sheet cameras (PLAN §2.5): hero close-up, four players, wide, action; plus 'top', a plan view for
// judging a layout (not on the contact sheet).
// frameShot(name, camera, { subjects, bounds, focus, raycast, occluders }) places a PerspectiveCamera from generic
// inputs, so the same shots work on the lookdev bench and in any kit game (capture.mjs calls window.__gfLook.shot(name)).
//   subjects:  [{ position: Vector3 (feet), yaw: radians (facing; 0 = +Z), height: metres, down?: bool }]  (players, first = "me")
//   bounds:    THREE.Box3 of the play space
//   raycast:   (from, dir, max) → { distance } | null against colliders (world.raycast)
//   occluders: (from, to) → { distance } | null, the first visible world mesh on the segment (capture-api builds it
//              from ctx.world.root). With it, no camera starts inside or behind a prop: each shot tries other angles
//              around its subject until the line of sight is clear, and the hero picks the angle with the most open
//              background. A subject lying down (ragdoll) is never the hero when someone is standing.
import * as THREE from 'three';

export const SHOTS = ['hero', 'four', 'wide', 'action'];   // the contact sheet's cameras
export const EXTRA_SHOTS = ['top'];                         // frameShot also takes these (capture.mjs --shots top)
const v = () => new THREE.Vector3();
const NEAR_CLEAR = 0.45;   // metres of free space the camera keeps in front of it

// is the camera at `pos` looking at `target` clear? (nothing between them, nothing hugging the lens)
function clearView(pos, target, occluders) {
  if (!occluders) return true;
  const hit = occluders(target, pos);
  return !hit || hit.distance > target.distanceTo(pos) - NEAR_CLEAR;
}
// how open is the background behind the target, seen from pos (metres to the first world mesh beyond it, capped)
function backgroundDepth(pos, target, occluders, cap = 40) {
  if (!occluders) return cap;
  const dir = target.clone().sub(pos).normalize();
  const from = target.clone().addScaledVector(dir, 0.6);
  const hit = occluders(from, from.clone().addScaledVector(dir, cap));
  return hit ? hit.distance : cap;
}
// a collider ray (world.raycast(from, dir, max)) as an occluder hit on the segment from → to
function hitOf(raycast, from, to) {
  const dir = to.clone().sub(from), len = dir.length();
  if (len < 1e-4) return null;
  const h = raycast(from, dir.normalize(), len);
  return h ? { distance: h.distance } : null;
}
// the first other player (a 0.5 m sphere around their middle) on the segment from → to, as an occluder hit
function subjectHit(from, to, others, h) {
  const seg = to.clone().sub(from), len = seg.length(); if (len < 1e-4) return null;
  const dir = seg.divideScalar(len);
  let best = null;
  for (const s of others) {
    const c = s.position.clone().add(v().set(0, h(s) * (s.down ? 0.2 : 0.5), 0));
    const t = c.clone().sub(from).dot(dir);
    if (t < 0.3 || t > len) continue;
    const dist = c.distanceTo(from.clone().addScaledVector(dir, t));
    if (dist < 0.55 && (!best || t < best.distance)) best = { distance: t };
  }
  return best;
}
// try the camera at azimuth offsets around the target (same distance and height), first clear one wins;
// `score(pos)` (higher is better) picks among the clear ones when given
function orbitClear(pos, target, occluders, { steps = [0, -20, 20, -40, 40, -60, 60, -90, 90, -120, 120, 180], score = null, bounds = null } = {}) {
  if (!occluders) return pos;
  const off = pos.clone().sub(target);
  let best = null, bestScore = -Infinity;
  for (const deg of steps) {
    const p = target.clone().add(off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg)));
    const q = bounds ? keepInside(p, target, bounds) : p;
    if (!clearView(q, target, occluders)) continue;
    if (!score) return q;
    const s = score(q, deg);
    if (s > bestScore) { best = q; bestScore = s; }
  }
  if (best) return best;
  // nothing clear all round: move in front of whatever blocks the original line
  const hit = occluders(target, pos);
  return hit ? target.clone().add(off.setLength(Math.max(1.2, hit.distance - NEAR_CLEAR))) : pos;
}

// distance that fits a sphere of radius r in both the vertical and horizontal field of view
function fitDistance(r, cam) {
  const vf = THREE.MathUtils.degToRad(cam.fov) / 2;
  const hf = Math.atan(Math.tan(vf) * cam.aspect);
  return r / Math.sin(Math.min(vf, hf));
}

// raycast(from, dir, max) -> { distance } | null: when given (world.raycast), a camera that a wall or building would
// block is pulled in front of it, or lifted, so the subjects stay in view.
function unblock(pos, target, raycast, minDist = 2.2) {
  if (!raycast) return pos;
  const tryPos = (p) => {
    const dir = p.clone().sub(target); const len = dir.length(); dir.normalize();
    const hit = raycast(target.clone().addScaledVector(dir, 0.6), dir, len - 0.6);
    return hit ? { ok: false, d: hit.distance + 0.6, dir, len } : { ok: true };
  };
  let r = tryPos(pos);
  if (r.ok) return pos;
  if (r.d - 0.5 > minDist + 1.5) return target.clone().addScaledVector(r.dir, r.d - 0.5);
  // lift the camera in 10 degree steps around the target, keeping the distance
  const off = pos.clone().sub(target), dist = off.length(), flat = Math.hypot(off.x, off.z), az = Math.atan2(off.x, off.z);
  for (let el = Math.atan2(off.y, flat) + 0.17; el < 1.4; el += 0.17) {
    const p = target.clone().add(v().set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist));
    r = tryPos(p);
    if (r.ok) return p;
    if (r.d - 0.5 > minDist + 1.5) return target.clone().addScaledVector(r.dir, r.d - 0.5);
  }
  return pos;
}

// vertical fov (degrees) that fits a sphere of radius r at distance d, in both directions
function fitFov(r, d, aspect, max = 72) {
  const a = Math.asin(Math.min(0.999, r / d));
  const vf = aspect >= 1 ? a : Math.atan(Math.tan(a) / aspect);
  return Math.min(max, THREE.MathUtils.radToDeg(vf * 2));
}
// keep the camera inside the play area (plus a margin): beyond it are the backdrop buildings, walls and hedges
function keepInside(pos, target, bounds, margin = 1.2) {
  if (!bounds) return pos;
  const lo = bounds.min, hi = bounds.max, dir = pos.clone().sub(target);
  let t = 1;
  for (const k of ['x', 'z']) {
    if (pos[k] > hi[k] - margin && dir[k] > 0) t = Math.min(t, (hi[k] - margin - target[k]) / dir[k]);
    if (pos[k] < lo[k] + margin && dir[k] < 0) t = Math.min(t, (lo[k] + margin - target[k]) / dir[k]);
  }
  return t < 1 ? target.clone().addScaledVector(dir, Math.max(t, 0.25)) : pos;
}

export function frameShot(name, cam, { subjects = [], bounds, focus, raycast, occluders } = {}) {
  const box = bounds ?? new THREE.Box3(v().set(-10, 0, -10), v().set(10, 3, 10));
  const center = focus?.clone?.() ?? box.getCenter(v());
  const portrait = cam.aspect < 1;
  // the hero is the first subject standing up (a knocked-down player makes a portrait of the floor)
  const standing = subjects.filter(s => !s.down);
  const s0 = standing[0] ?? subjects[0], s1 = subjects.find(s => s !== s0 && !s.down) ?? subjects.find(s => s !== s0);
  const h = (s) => s?.height ?? 1.7;
  const facing = (s) => v().set(Math.sin(s?.yaw ?? 0), 0, Math.cos(s?.yaw ?? 0));
  let pos, target;
  if (name === 'hero' && s0) {
    // head and shoulders plus some body: a sphere of ~0.55 x height around the upper body, whatever the body's size;
    // a hero lying down (everyone is down) is framed whole, at body height, from a little above
    const f = facing(s0);
    const side = v().crossVectors(f, v().set(0, 1, 0)).normalize();
    target = s0.position.clone().add(v().set(0, h(s0) * (s0.down ? 0.25 : 0.66), 0));
    const r = h(s0) * (s0.down ? 0.75 : 0.55);
    cam.fov = portrait ? 40 : 30;
    const d = fitDistance(r, cam);
    pos = target.clone().addScaledVector(f.clone().addScaledVector(side, 0.42).normalize(), d).add(v().set(0, h(s0) * (s0.down ? 0.9 : 0.08), 0));
    // other players count as occluders here: nobody's back fills the portrait
    const others = subjects.filter(s => s !== s0);
    const occ = occluders && ((from, to) => occluders(from, to) ?? subjectHit(from, to, others, h));
    // keep the face toward the camera (within ±60° of the facing) and prefer an open background over a wall
    pos = orbitClear(pos, target, occ, { steps: [0, -20, 20, -40, 40, -60, 60, -90, 90], bounds: box,
      score: (p, deg) => Math.min(backgroundDepth(p, target, occluders), 25) - Math.abs(deg) * 0.05 - Math.max(0, d - p.distanceTo(target)) * 4 });
    const inside = keepInside(pos, target, box);
    if (inside !== pos) pos = inside;
    if (Math.abs(pos.distanceTo(target) - d) > 0.05) cam.fov = fitFov(r, pos.distanceTo(target), cam.aspect);
  } else if (name === 'top') {
    // a plan view: straight down on the play area (a hair of tilt keeps lookAt stable), fitted to the bounds
    cam.fov = 40;
    const size = box.getSize(v());
    const half = Math.max(size.x / 2 / Math.max(cam.aspect, 1e-3), size.z / 2) * 1.08;
    target = center.clone(); target.y = 0;
    pos = target.clone().add(v().set(0, half / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), 0.01));
  } else if (name === 'four' && subjects.length) {
    cam.fov = portrait ? 50 : 38;
    const group = subjects.slice(0, 4);
    const c = group.reduce((a, s) => a.add(s.position), v()).multiplyScalar(1 / group.length);
    let r = 0; for (const s of group) r = Math.max(r, s.position.distanceTo(c));
    r += 1.1;
    const f = group.reduce((a, s) => a.add(facing(s)), v());
    if (f.lengthSq() < 1e-4) f.set(0, 0, 1);
    f.normalize();
    target = c.clone().add(v().set(0, 0.95, 0));
    const d = fitDistance(r, cam) * 1.02;
    const el = THREE.MathUtils.degToRad(16);
    const side = v().crossVectors(f, v().set(0, 1, 0)).normalize();
    pos = target.clone().addScaledVector(f.clone().addScaledVector(side, 0.25).normalize(), d * Math.cos(el)).add(v().set(0, d * Math.sin(el), 0));
    const inside = keepInside(pos, target, box);
    if (inside !== pos) { pos = inside; cam.fov = fitFov(r * 1.02, pos.distanceTo(target), cam.aspect); }
  } else if (name === 'action' && s0 && s1) {
    cam.fov = portrait ? 60 : 48;
    const toward = s1.position.clone().sub(s0.position); toward.y = 0;
    const dist = Math.max(toward.length(), 0.5); toward.normalize();
    const side = v().crossVectors(toward, v().set(0, 1, 0)).normalize();
    target = s0.position.clone().addScaledVector(toward, dist * 0.5).add(v().set(0, h(s1) * 0.55, 0));
    pos = s0.position.clone().addScaledVector(toward, portrait ? -2.8 : -2.2).addScaledVector(side, portrait ? 1.2 : 2.7).add(v().set(0, Math.max(1.3, h(s0) * 1.05), 0));
  } else {   // wide (also the fallback)
    cam.fov = portrait ? 55 : 40;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius * (portrait ? 0.62 : 0.8), 4);
    target = center.clone(); target.y = Math.min(box.min.y + 0.5, center.y);
    const d = fitDistance(r, cam);
    const el = THREE.MathUtils.degToRad(portrait ? 48 : 36), az = THREE.MathUtils.degToRad(28);
    pos = target.clone().add(v().set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d));
  }
  if (name === 'action') pos = keepInside(pos, target, box);
  if (name !== 'wide' && name !== 'top') {
    const meant = pos.clone();
    pos = unblock(pos, target, raycast);
    // pulled far in by a wall behind it: turn around the target at the intended distance instead, when that is clear
    if (occluders && pos.distanceTo(target) < meant.distanceTo(target) * 0.7) {
      const turned = orbitClear(meant, target, (from, to) => occluders(from, to) ?? (raycast ? hitOf(raycast, from, to) : null), { bounds: box });
      if (turned.distanceTo(target) > pos.distanceTo(target) + 0.3) pos = turned;
    }
    // colliders are simpler than what is drawn (a tree's collider is its trunk): check the meshes themselves too, and
    // (hero, action) the players who are not in the shot, so nobody's back fills the lens
    const framed = name === 'hero' ? [s0] : name === 'action' ? [s0, s1] : subjects;
    const others = subjects.filter(s => !framed.includes(s));
    const occ = occluders && (others.length ? (from, to) => occluders(from, to) ?? subjectHit(from, to, others, h) : occluders);
    if (!clearView(pos, target, occ)) pos = orbitClear(pos, target, occ, { bounds: box });
  }
  cam.position.copy(pos);
  cam.lookAt(target);
  cam.near = 0.1;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return { position: pos, target };
}
