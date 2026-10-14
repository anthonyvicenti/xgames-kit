// Procedural motion for the body archetypes (CREATURES.md §3): each frame, from what the body is doing (speed, on the
// ground or not, the action word and how far into it), every bone of a worm, blob, quadruped or flyer is posed. No clip
// file: the same words the humanoid clips answer (archetypes.js ACTION_OF) drive it, so a friend's copy, which knows
// only the pose word and the position, moves the body the same way.
//
//   const m = createMotion(std, rig, bind, info);
//   every frame: m.pose(state, dt)        state: { t, speed, grounded, vy, airT, landT, vel: {x, z} (body frame, m/s),
//                                                  action: { action, t, dur } | null, hold: 0..1, aim: -1..1,
//                                                  down: 0..1, tumbling: bool, getup: 0..1 | null }
//
// Bones rest unrotated in the character's axes (the standard), so a rotation here is an angle about the character's
// own X (pitch: + leans forward), Y (yaw: + turns left) and Z (roll: + tips the top to the right side, -X) axes,
// composed down each chain. Positions are offsets in metres in the parent's (character-aligned) frame.
import * as THREE from 'three';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const frac = x => x - Math.floor(x);
/** A beat: rises to 1 at `peak` of the way through, back to 0 at the end (an action's strike). */
const beat = (u, peak) => (u < peak ? smooth(u / peak) : 1 - smooth((u - peak) / (1 - peak)));
/** A wing's stroke: quick down, slow up. */
const stroke = p => Math.sin(TAU * p + 0.55 * Math.sin(TAU * p));
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _m = new THREE.Matrix4();

/** A damped spring, one per axis: x follows a target with overshoot (jiggle). */
function spring(k = 160, c = 10) {
  const s = { x: 0, v: 0, k, c, kick(dv) { s.v += dv; },
    step(target, dt) { const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n; for (let i = 0; i < n; i++) { s.v += (s.k * (target - s.x) - s.c * s.v) * h; s.x += s.v * h; } return s.x; } };
  return s;
}

/**
 * The pose writer: per bone a rotation delta (in the character's axes, composed down the chain), an offset and a
 * scale; apply() turns them into each bone's local transform from its rest one.
 */
function createPoser(rig, bind) {
  const bones = [...rig.bones.entries()].map(([name, bone]) => ({ name, bone, q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1),
    restP: bone.position.clone(), restQ: bone.quaternion.clone(), restS: bone.scale.clone() }));
  const by = new Map(bones.map(b => [b.name, b]));
  return {
    by, bones,
    has: n => by.has(n),
    reset() { for (const b of bones) { b.q.identity(); b.p.set(0, 0, 0); b.s.set(1, 1, 1); } },
    rot(n, axis, angle) { const b = by.get(n); if (b && angle) b.q.premultiply(_q.setFromAxisAngle(axis, angle)); },
    quat(n, q) { const b = by.get(n); if (b) b.q.premultiply(q); },
    move(n, x, y, z) { const b = by.get(n); if (b) { b.p.x += x; b.p.y += y; b.p.z += z; } },
    scale(n, x, y, z) { const b = by.get(n); if (b) { b.s.x *= x; b.s.y *= y; b.s.z *= z; } },
    apply() {
      for (const b of bones) {
        b.bone.position.copy(b.restP).add(b.p);
        b.bone.quaternion.copy(b.restQ).multiply(b.q);
        b.bone.scale.copy(b.restS).multiply(b.s);
      }
    },
  };
}

/**
 * Two-bone reach in the body's frame: turn `upper` and `lower` so the chain's end (`end`) lands on `target` (body frame),
 * the middle joint bending toward `pole` (body frame direction). The bones' current local rotations are the start.
 */
function reach(P, bodyNode, upper, lower, end, target, pole) {
  const U = P.by.get(upper)?.bone, L = P.by.get(lower)?.bone, E = P.by.get(end)?.bone;
  if (!U || !L || !E) return;
  bodyNode.updateWorldMatrix(true, false);
  U.updateWorldMatrix(true, true);
  const toBody = _m.copy(bodyNode.matrixWorld).invert();
  const a = U.getWorldPosition(new THREE.Vector3()).applyMatrix4(toBody);
  const b = L.getWorldPosition(new THREE.Vector3()).applyMatrix4(toBody);
  const c = E.getWorldPosition(new THREE.Vector3()).applyMatrix4(toBody);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const t = target.clone().sub(a);
  const d = clamp(t.length(), Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.999);
  t.setLength(d);
  // the knee: along the reach, then out toward the pole by the law of cosines
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const n = t.clone().normalize();
  const side = pole.clone().addScaledVector(n, -pole.dot(n)); if (side.lengthSq() < 1e-8) side.set(0, 0, 1); side.normalize();
  const knee = a.clone().addScaledVector(n, along).addScaledVector(side, out);
  const turn = (bone, from, to, cur) => {
    // world rotation of the body frame, so body-frame directions can be compared with the bone's world rotation
    const bodyQ = bodyNode.getWorldQuaternion(new THREE.Quaternion());
    const fromW = from.clone().applyQuaternion(bodyQ).normalize(), toW = to.clone().applyQuaternion(bodyQ).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(fromW, toW);
    const wq = bone.getWorldQuaternion(new THREE.Quaternion());
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pq.invert().multiply(delta.multiply(wq)));
    bone.updateWorldMatrix(false, true);
  };
  turn(U, b.clone().sub(a), knee.clone().sub(a));
  const b2 = L.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m.copy(bodyNode.matrixWorld).invert());
  const c2 = E.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m);
  turn(L, c2.clone().sub(b2), a.clone().add(t).sub(b2));
}

// ------------------------------------------------------------------ the archetypes

/** How far below the ground the rest skin's lowest point goes when the body turns about its base by lean (X) then
 *  roll (Z) and squashes by k (Y): what to lift it by so it stands on its edge instead of sinking. */
const _e = new THREE.Euler(), _qs = new THREE.Quaternion();
function sinkOf(bind, base, lean, roll, k = 1) {
  const S = bind.sample; if (!S?.length) return 0;
  _qs.setFromEuler(_e.set(lean, 0, -roll, 'ZXY'));
  const side = 1 / Math.sqrt(k);
  let low = 0;
  for (let i = 0; i < S.length; i += 3) {
    _v3.set((S[i] - base.x) * side, (S[i + 1] - base.y) * k, (S[i + 2] - base.z) * side).applyQuaternion(_qs);
    if (_v3.y + base.y < low) low = _v3.y + base.y;
  }
  return -low;
}

function blobMotion(P, info, bind) {
  const base = bind.pos.get('Body') ?? new THREE.Vector3();
  const h = info.height, depth = info.depth, width = info.width;
  const top = { x: spring(150, 8), z: spring(150, 8), y: spring(220, 9) };
  let phase = 0, moveW = 0, airW = 0, last = { x: 0, z: 0 }, acc = { x: 0, z: 0 }, hitKicked = null, hitSide = 1;
  const feet = ['LeftFoot', 'RightFoot'].filter(P.has), hands = ['LeftHand', 'RightHand'].filter(P.has);
  // a limb moves by its own size (a nub a few centimetres across must not be thrown a quarter of the body's height)
  const ext = n => Math.max(0.02 * h, Math.min(0.25 * h, bind.extent?.get(n) ?? 0.08 * h));
  return (s, dt) => {
    // movement weights, eased so starts and stops never pop
    moveW += (clamp(s.speed / (0.6 * h + 0.3), 0, 1) * (s.grounded ? 1 : 0) - moveW) * Math.min(1, dt * 8);
    airW += ((s.grounded ? 0 : 1) - airW) * Math.min(1, dt * 10);
    const f = clamp(1.8 + 1.0 * s.speed / Math.max(0.3, h), 1.8, 4.2);
    phase += dt * (moveW > 0.02 ? f : 0);
    // the body's acceleration (body frame) drives the top's lag
    if (dt > 0) { acc.x += (((s.vel?.x ?? 0) - last.x) / dt - acc.x) * Math.min(1, dt * 12); acc.z += (((s.vel?.z ?? 0) - last.z) / dt - acc.z) * Math.min(1, dt * 12); }
    last = { x: s.vel?.x ?? 0, z: s.vel?.z ?? 0 };

    let k = 1 + 0.025 * Math.sin(s.t * TAU / 2.3);          // breathing
    let lift = 0, lean = 0, roll = 0, spin = 0, fwd = 0;
    // a waddling hop: one hop a step, the body rolling onto the stepping side
    const hop = Math.abs(Math.sin(Math.PI * phase));
    lift += moveW * h * (0.05 + 0.035 * clamp(s.speed / (3 * h), 0, 1)) * hop;
    k += moveW * (0.06 * hop * hop - 0.16 * Math.pow(Math.abs(Math.cos(Math.PI * phase)), 8));
    lean += moveW * clamp(0.06 + 0.05 * s.speed, 0, 0.28);
    roll += moveW * 0.12 * Math.sin(Math.PI * phase);
    // up and down: stretched rising, a little round falling, squashed and wobbling on landing
    if (airW > 0.01) k += airW * (s.vy > 0 ? 0.05 + 0.09 * Math.exp(-s.airT * 6) : -0.02);
    k -= 0.26 * Math.exp(-s.landT * 9) * Math.cos(s.landT * 17) * (s.landT < 0.6 ? 1 : 0);
    const a = s.action, u = a ? clamp(a.t / a.dur, 0, 1) : 0;
    let handUp = 0, handFwd = 0, handOut = 0;
    if (a?.action === 'act') {
      // wind up (squash back), then a lunge (stretch forward), then back
      const wind = smooth(u / 0.35) * (1 - smooth((u - 0.35) / 0.12)), strike = beat(u, 0.5);
      lean += -0.32 * wind + 0.62 * strike; k += -0.12 * wind + 0.16 * strike; fwd += h * (-0.05 * wind + 0.2 * strike);
      handFwd += 0.25 * h * strike; handUp += 0.12 * h * strike;
    }
    if (a?.action === 'hit') {
      if (hitKicked !== a) { hitKicked = a; hitSide = -hitSide; top.z.kick(-3.5); top.x.kick(2.2 * hitSide); top.y.kick(-3); }
      const e = Math.exp(-a.t * 7);
      k -= 0.14 * e * Math.cos(a.t * 22); fwd -= 0.06 * h * e; lean -= 0.18 * e;
      handOut += 0.06 * h * e; handUp += 0.08 * h * e;
    }
    if (a?.action === 'celebrate') {
      const ph = a.t * 2.4, bounce = Math.abs(Math.sin(Math.PI * ph)), w = 1 - smooth((u - 0.85) / 0.15);
      lift += w * 0.16 * h * bounce; k += w * (0.08 * bounce - 0.14 * Math.pow(Math.abs(Math.cos(Math.PI * ph)), 8));
      spin += w * TAU * smooth(clamp(u / 0.85, 0, 1));
      handUp += w * 0.3 * h; handOut += w * 0.05 * h * (1 + Math.sin(a.t * 14));
    }
    if (s.hold > 0) { handFwd += s.hold * 0.14 * h; handUp += s.hold * 0.12 * h; lean += s.hold * 0.04 * (s.aim ?? 0); }
    if (airW > 0.01) { handUp += airW * (s.vy > 0 ? 0.18 : 0.1) * h; }

    // down: limp and a little flat; when no physics tumbles it, it rolls onto its back by itself
    const d = s.down ?? 0;
    k = k * (1 - d) + (0.86 + 0.03 * Math.sin(s.t * 3)) * d;
    lean *= 1 - d; roll *= 1 - d; lift *= 1 - d; fwd *= 1 - d;
    if (d > 0 && !s.tumbling) lean += -1.42 * d;      // rolls onto its back (sinkOf below lifts it onto its back)
    if (s.getup != null) { const g = s.getup; k += 0.18 * Math.sin(Math.PI * g); lift += 0.12 * h * Math.sin(Math.PI * g); }

    // leaning or rolling about the base would push an edge into the ground: rise by exactly that much
    if (!s.tumbling) lift += sinkOf(bind, base, lean, roll, k);
    // the top's lag: springs toward the opposite of the body's acceleration, plus any kick
    const jx = top.x.step(clamp(acc.x * 0.012, -0.3, 0.3) * (1 - d), dt), jz = top.z.step(clamp(-acc.z * 0.012, -0.3, 0.3) * (1 - d), dt);
    const jy = top.y.step(0, dt);

    k = clamp(k + jy * 0.05, 0.55, 1.5);
    const side = 1 / Math.sqrt(k);
    P.scale('Body', side, k, side);
    P.move('Body', 0, lift, fwd);
    P.rot('Body', X, lean); P.rot('Body', Z, -roll); P.rot('Body', Y, spin);
    // the top wobbles mostly by sliding over the bottom and a little by tipping: a fat body bent hard at one joint
    // pinches its far side (the creature judge's squeeze limit)
    const tip = 0.55 * clamp(h / Math.max(width, depth, 1e-3), 0.3, 1);      // a wide, flat body tips less
    P.rot('Top', X, tip * jz + 0.04 * Math.sin(s.t * 1.7) * (1 - moveW)); P.rot('Top', Z, -tip * jx);
    P.move('Top', -0.12 * h * jx * (1 - d), 0, 0.12 * h * jz * (1 - d));
    if (P.has('Head')) { P.rot('Head', Y, 0.25 * Math.sin(s.t * 0.6) * (1 - moveW) * (1 - d)); }
    // feet: alternate steps under the hops, dangling in the air
    for (const n of feet) {
      const sgn = n.startsWith('Left') ? 1 : -1, e = ext(n);
      const step = moveW * 0.55 * e * Math.sin(Math.PI * phase) * sgn;
      const up = moveW * 0.35 * e * Math.max(0, Math.sin(Math.PI * phase) * sgn);
      P.move(n, 0, up - airW * 0.15 * e, step);
      P.rot(n, X, -moveW * 0.35 * Math.sin(Math.PI * phase) * sgn + airW * 0.3 + d * 0.5);
    }
    // hands: they swing and wave by turning about their own joint, and move a little (their size, at most)
    const hu = clamp(handUp / (0.3 * h), 0, 1), hf = clamp(handFwd / (0.25 * h), 0, 1), ho = clamp(handOut / (0.06 * h), 0, 1.5);
    for (const n of hands) {
      const sgn = n.startsWith('Left') ? 1 : -1, e = ext(n);
      const swing = -moveW * 0.35 * Math.sin(Math.PI * phase) * sgn;
      P.rot(n, X, swing + 0.6 * hf);
      P.rot(n, Z, sgn * (0.6 * hu + 0.2 * ho + 0.05 * Math.sin(s.t * 2.2)));
      P.move(n, sgn * 0.15 * e * ho, 0.2 * e * hu, 0.25 * e * hf);
    }
    return { lift };
  };
}

function wormMotion(P, info, bind, bodyNode) {
  const segs = info.segs, chain = [...segs, 'Head'], n = segs.length, h = info.height, L = info.length;
  // each segment's own bend axes: side to side (perpendicular to the segment and to X) and fore-aft (X)
  const dir = chain.map((name, i) => {
    const a = bind.pos.get(name), b = bind.pos.get(chain[i + 1] ?? name);
    const d = (i < chain.length - 1 ? b.clone().sub(a) : bind.pos.get(name).clone().sub(bind.pos.get(chain[i - 1]))).normalize();
    const lat = new THREE.Vector3().crossVectors(X, d); if (lat.lengthSq() < 1e-6) lat.copy(Y);
    return { d, lat: lat.normalize() };
  });
  const head = { a: spring(120, 9), b: spring(120, 9) };
  let phase = 0, moveW = 0, airW = 0, hitKicked = null;
  const up = info.upright;
  return (s, dt) => {
    moveW += (clamp(s.speed / (0.25 * L + 0.2), 0, 1) * (s.grounded ? 1 : 0) - moveW) * Math.min(1, dt * 6);
    airW += ((s.grounded ? 0 : 1) - airW) * Math.min(1, dt * 10);
    // the wave travels a wavelength each cycle; a cycle covers about a body length's worth of ground
    const f = up ? clamp(1.6 + 0.9 * s.speed / Math.max(0.3, h), 1.6, 4) : clamp(0.7 + 0.8 * s.speed / Math.max(0.2, L), 0.7, 3.2);
    phase += dt * (moveW > 0.02 ? f : 0.25);
    const a = s.action, u = a ? clamp(a.t / a.dur, 0, 1) : 0, d = s.down ?? 0;
    let lift = 0, spin = 0, rootPitch = 0, rootRoll = 0;
    const lat = new Array(chain.length).fill(0), pit = new Array(chain.length).fill(0), str = new Array(chain.length).fill(1);
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      // idle: a slow sway and breathing
      lat[i] += (1 - moveW) * 0.05 * Math.sin(s.t * 1.3 - t * 3);
      pit[i] += (1 - moveW) * (up ? 0.035 : 0.02) * Math.sin(s.t * 1.7 + t * 2);
      str[i] *= 1 + 0.03 * Math.sin(s.t * 2.4 - t * 3);
      if (up) {
        // standing up: an inching bounce, the wave running up the body, the whole worm leaning into the move
        pit[i] += moveW * 0.2 / Math.sqrt(n) * Math.sin(TAU * phase - t * 2.6);
        lat[i] += moveW * 0.07 * Math.sin(Math.PI * phase - t * 1.5);
        if (i === 0) str[i] *= 1 - moveW * 0.16 * Math.pow(Math.abs(Math.cos(Math.PI * phase)), 6);
      } else {
        // lying down: side to side, a wave from the head back to the tail
        lat[i] += moveW * 0.7 / Math.sqrt(n) * Math.sin(TAU * phase + t * TAU * 0.9);
        str[i] *= 1 + moveW * 0.05 * Math.sin(TAU * phase + t * 4);
      }
      // in the air: straight and stretched rising, curling falling
      lat[i] *= 1 - airW * 0.8; pit[i] = pit[i] * (1 - airW) + airW * (s.vy > 0 ? -0.02 : 0.08);
      str[i] *= 1 + airW * (s.vy > 0 ? 0.08 : 0);
      if (a?.action === 'act') {
        // rear back, then strike forward: more toward the head
        const wind = smooth(u / 0.4) * (1 - smooth((u - 0.4) / 0.1)), strike = beat(u, 0.55);
        // standing: back then over; lying: the front rears up, then lunges (straightens) at the target
        pit[i] += (t * t) * (up ? (-0.5 * wind + 0.8 * strike) : (-0.9 * wind - 0.25 * strike)) * (3 / n);
        if (!up) str[i] *= 1 + 0.12 * strike * t;
      }
      if (a?.action === 'hit') {
        const e = Math.exp(-a.t * 5);
        lat[i] += 0.28 * e * Math.sin(a.t * 18 - (1 - t) * 4) * (3 / n);
        str[i] *= 1 - 0.1 * e * Math.cos(a.t * 20);
      }
      if (a?.action === 'celebrate') {
        const w = 1 - smooth((u - 0.85) / 0.15);
        lat[i] += w * 0.5 / Math.sqrt(n) * Math.sin(a.t * 16 + t * 5);
        if (up) pit[i] += w * -0.06;
      }
      // down: a gentle curl on the ground
      lat[i] = lat[i] * (1 - d) + d * 0.12 * (3 / n);
      pit[i] *= 1 - d;
      // lying down, a bend may only lift the body: a downward one would push the rest of it into the ground
      if (!up) pit[i] = Math.min(0, pit[i]);
    }
    if (a?.action === 'celebrate') { const w = 1 - smooth((u - 0.85) / 0.15); spin += w * TAU * smooth(clamp(u / 0.85, 0, 1)); lift += w * 0.1 * h * Math.abs(Math.sin(a.t * 7)); }
    if (up) { lift += moveW * 0.045 * h * Math.abs(Math.sin(Math.PI * phase)); rootPitch += moveW * clamp(0.05 + 0.04 * s.speed, 0, 0.25); }
    if (d > 0 && !s.tumbling) {
      // fall over: a standing worm onto its front, a lying one onto its side
      if (up) { rootPitch = rootPitch * (1 - d) + 1.45 * d; lift += 0.5 * info.width * d; }
      else { rootRoll += 1.3 * d; lift += 0.5 * info.width * d; }
    }
    if (s.getup != null) lift += 0.1 * h * Math.sin(Math.PI * s.getup);
    P.move('Root', 0, lift, 0);
    P.rot('Root', X, rootPitch); P.rot('Root', Z, rootRoll); P.rot('Root', Y, spin);
    for (let i = 0; i < n; i++) {
      const name = chain[i], dd = dir[i];
      P.rot(name, dd.lat, lat[i]); P.rot(name, X, pit[i]);
      // stretch along the segment's own direction (a non-uniform scale on its local axes, which rest as the body's)
      const st = str[i], sx = 1 + (st - 1) * Math.abs(dd.d.x), sy = 1 + (st - 1) * Math.abs(dd.d.y), sz = 1 + (st - 1) * Math.abs(dd.d.z);
      const thin = 1 / Math.sqrt(Math.max(0.5, st));
      P.scale(name, sx * (Math.abs(dd.d.x) > 0.7 ? 1 : thin), sy * (Math.abs(dd.d.y) > 0.7 ? 1 : thin), sz * (Math.abs(dd.d.z) > 0.7 ? 1 : thin));
    }
    // the head keeps looking ahead: it takes back most of the side-to-side bend below it, and lags a little
    let sumLat = 0; for (let i = 0; i < n; i++) sumLat += lat[i];
    const hy = head.a.step(-sumLat * 0.75 * (1 - d), dt), hp = head.b.step(a?.action === 'act' ? -0.2 * beat(u, 0.55) : 0.05 * Math.sin(s.t * 0.9), dt);
    P.rot('Head', dir[n - 1].lat, hy); P.rot('Head', X, hp);
    P.rot('Head', Y, (1 - moveW) * (1 - d) * 0.3 * Math.sin(s.t * 0.55));
    if (P.has('Jaw')) P.rot('Jaw', X, a?.action === 'act' ? -0.5 * beat(u, 0.5) : a?.action === 'celebrate' ? -0.3 : 0);
    return { lift };
  };
}

function quadrupedMotion(P, info, bind, bodyNode) {
  const legs = info.legs, Lh = Math.max(0.05, info.legLength), names = Object.keys(legs);
  const offsets = { walk: { BackLeft: 0, FrontLeft: 0.25, BackRight: 0.5, FrontRight: 0.75 }, trot: { BackLeft: 0, FrontRight: 0, BackRight: 0.5, FrontLeft: 0.5 }, gallop: { BackLeft: 0, BackRight: 0.1, FrontLeft: 0.5, FrontRight: 0.6 } };
  const cur = { ...offsets.walk };
  let phase = 0, moveW = 0, airW = 0, duty = 0.62, hitKicked = null;
  const tail = ['Tail0', 'Tail1', 'Tail2'].filter(P.has);
  const ears = { l: spring(200, 8), r: spring(200, 8) };
  const target = new THREE.Vector3(), pole = new THREE.Vector3();
  return (s, dt) => {
    moveW += (clamp(s.speed / (0.4 * Lh + 0.15), 0, 1) * (s.grounded ? 1 : 0) - moveW) * Math.min(1, dt * 7);
    airW += ((s.grounded ? 0 : 1) - airW) * Math.min(1, dt * 10);
    const rel = s.speed / Lh;                                        // leg lengths a second
    const gait = rel < 2.2 ? 'walk' : rel < 5.5 ? 'trot' : 'gallop';
    const want = offsets[gait], wantDuty = gait === 'walk' ? 0.62 : gait === 'trot' ? 0.5 : 0.4;
    // slide each leg's place in the cycle toward the gait's, so a change of gait never snaps a foot
    for (const k of Object.keys(cur)) { let dd = want[k] - cur[k]; dd -= Math.round(dd); cur[k] = frac(cur[k] + dd * Math.min(1, dt * 4)); }
    duty += (wantDuty - duty) * Math.min(1, dt * 4);
    const f = clamp(0.9 + 0.32 * rel, 0.9, 3.4);
    phase += dt * (moveW > 0.02 ? f : 0);
    // stance length: the foot slides back at the ground speed while it is down
    const stride = Math.min(1.3 * Lh, s.speed * duty / f) * moveW;
    const lift = Math.min(0.32 * Lh, 0.12 * Lh + 0.03 * s.speed) * moveW;
    const a = s.action, u = a ? clamp(a.t / a.dur, 0, 1) : 0, d = s.down ?? 0;

    // the body: a bob twice a cycle, a rock at the gallop, leaning into the move, nose up when rising
    let bodyY = -0.03 * Lh * moveW * Math.cos(2 * TAU * phase), pitch = 0, roll = 0, chestZ = 0, crouch = 0, rear = 0, spin = 0, lift2 = 0;
    if (gait === 'gallop') pitch += 0.09 * moveW * Math.sin(TAU * phase);
    pitch += airW * clamp(-s.vy * 0.04, -0.3, 0.3);
    crouch += 0.18 * Lh * Math.exp(-s.landT * 8) * (s.landT < 0.6 ? 1 : 0);
    let headPitch = 0, headYaw = (1 - moveW) * 0.35 * Math.sin(s.t * 0.5), jaw = 0, tailAmp = 0.18 + 0.2 * moveW, tailRate = 3 + 4 * moveW;
    if (a?.action === 'act') {
      const wind = smooth(u / 0.35) * (1 - smooth((u - 0.35) / 0.12)), strike = beat(u, 0.5);
      crouch += 0.12 * Lh * wind; chestZ += 0.18 * Lh * strike; headPitch += -0.25 * wind + 0.45 * strike; jaw = 0.5 * strike;
    }
    if (a?.action === 'hit') {
      if (hitKicked !== a) { hitKicked = a; ears.l.kick(-8); ears.r.kick(8); }
      const e = Math.exp(-a.t * 6);
      roll += 0.22 * e * Math.sin(a.t * 20); chestZ -= 0.08 * Lh * e; headPitch -= 0.3 * e;
    }
    if (a?.action === 'celebrate') {
      const w = 1 - smooth((u - 0.85) / 0.15);
      rear += w * 0.62; tailAmp += w * 0.5; tailRate += w * 9; headPitch -= w * 0.25; jaw += w * 0.25 * (0.5 + 0.5 * Math.sin(a.t * 10));
      lift2 += w * 0.06 * Lh * Math.abs(Math.sin(a.t * 6)); spin += w * TAU * 0.5 * Math.sin(Math.PI * clamp(u / 0.85, 0, 1)) ;
    }
    if (s.hold > 0) headPitch -= 0.2 * s.hold;
    bodyY -= crouch; bodyY += lift2;
    bodyY *= 1 - d; pitch *= 1 - d; chestZ *= 1 - d;
    let rootRoll = 0, rootY = 0;
    if (d > 0 && !s.tumbling) { rootRoll = 1.35 * d; rootY = 0.5 * info.width * d; }
    if (s.getup != null) rootY += 0.08 * Lh * Math.sin(Math.PI * s.getup);

    P.move('Root', 0, rootY, 0); P.rot('Root', Z, rootRoll); P.rot('Root', Y, spin);
    P.move('Hips', 0, bodyY, 0); P.rot('Hips', X, pitch * 0.5 - rear); P.rot('Hips', Z, roll * 0.5);
    P.move('Chest', 0, 0, chestZ);
    if (P.has('Spine')) P.rot('Spine', X, pitch * 0.25);
    P.rot('Chest', X, pitch * 0.25); P.rot('Chest', Z, roll * 0.5);
    // the head stays level against the body's pitch, and looks about when still
    const neck = P.has('Neck') ? 'Neck' : 'Head';
    P.rot(neck, X, -(pitch - rear) * 0.6 + headPitch * 0.5 + 0.04 * moveW * Math.sin(2 * TAU * phase + 1));
    P.rot('Head', X, headPitch * 0.5); P.rot('Head', Y, headYaw * (1 - d));
    if (P.has('Jaw')) P.rot('Jaw', X, jaw);
    for (const [i, t] of tail.entries()) P.rot(t, Y, tailAmp * Math.sin(s.t * tailRate - i * 0.7) * (1 - d * 0.8));
    if (tail.length) P.rot(tail[0], X, -0.25 * moveW - 0.3 * d);
    if (P.has('LeftEar')) P.rot('LeftEar', Z, ears.l.step(-0.1 * moveW, dt));
    if (P.has('RightEar')) P.rot('RightEar', Z, ears.r.step(0.1 * moveW, dt));
    P.apply();

    // the legs: each foot planted while down (sliding back under the body), stepping through the air while up
    for (const k of names) {
      const leg = legs[k], off = cur[k] ?? 0, uu = frac(phase + off);
      let z = 0, y = 0;
      if (uu < duty) z = stride / 2 - stride * (uu / duty);
      else { const v = (uu - duty) / (1 - duty); z = -stride / 2 + stride * smooth(v); y = lift * Math.sin(Math.PI * v); }
      if (airW > 0.01) { z += airW * (leg.front ? 0.22 : -0.2) * Lh; y += airW * 0.14 * Lh; }
      if (rear > 0 && leg.front) { y += rear * 0.45 * Lh + 0.12 * Lh * rear * Math.max(0, Math.sin(s.t * 9 + (leg.side > 0 ? 0 : Math.PI))); z += rear * 0.1 * Lh; }
      if (a?.action === 'act' && leg.front) { const strike = beat(u, 0.5); y += 0.1 * Lh * strike; z += 0.12 * Lh * strike; }
      // a foot stays under its hip on the ground: the body's bob is taken up by the knee
      target.set(leg.foot.x, leg.foot.y + y + (s.grounded ? 0 : 0), leg.foot.z + z);
      if (d > 0) target.lerp(new THREE.Vector3(leg.foot.x + leg.side * 0.1 * Lh, leg.foot.y + 0.15 * Lh, leg.foot.z), d);
      // the middle joint bends forward on a front leg and back on a hind leg
      pole.set(0, 0, leg.front ? 1 : -1);
      reach(P, bodyNode, k + 'UpLeg', k + 'Leg', k + 'Foot', target, pole);
    }
    return { lift: rootY };
  };
}

function flyerMotion(P, info, bind) {
  const h = info.height, hasLegs = info.legs;
  let wingPh = 0, flyW = hasLegs ? 0 : 1, airW = 0, moveW = 0, phase = 0, hitKicked = null;
  const ruffle = spring(260, 7);
  return (s, dt) => {
    airW += ((s.grounded ? 0 : 1) - airW) * Math.min(1, dt * 10);
    moveW += (clamp(s.speed / (0.8 * h + 0.3), 0, 1) - moveW) * Math.min(1, dt * 6);
    const a = s.action, u = a ? clamp(a.t / a.dur, 0, 1) : 0, d = s.down ?? 0;
    const celebrate = a?.action === 'celebrate' ? 1 - smooth((u - 0.85) / 0.15) : 0;
    // flying: in the air, moving fast, celebrating, or always for a body with no legs (a bat, a bee)
    const wantFly = hasLegs ? Math.max(airW, smooth((s.speed - 1.0 * h - 0.6) / 1.2), celebrate) : 1;
    flyW += (wantFly * (1 - d) - flyW) * Math.min(1, dt * 6);
    const rising = !s.grounded && s.vy > 0, gliding = !s.grounded && s.vy <= 0;
    const rate = celebrate ? 7 : rising ? 5.5 : gliding ? 1.2 : 3.6 + 1.2 * moveW;
    const amp = celebrate ? 1.0 : rising ? 1.0 : gliding ? 0.25 : 0.85;
    wingPh += dt * rate * flyW + dt * 0.4 * (1 - flyW);
    phase += dt * (s.grounded && moveW > 0.02 ? 3.2 : 0);
    const st = stroke(wingPh), st2 = stroke(wingPh - 0.12), st3 = stroke(wingPh - 0.24);
    // the body: hovering lifts it off the ground; it rises on each downstroke; leans into the move
    let hover = flyW * (s.grounded ? 0.28 * h : 0) + celebrate * 0.3 * h, bob = flyW * 0.05 * h * -st;
    let pitch = clamp(0.3 * s.speed / (s.speed + 2), 0, 0.3) * flyW + (gliding ? 0.15 : 0);
    let hop = (1 - flyW) * moveW * 0.08 * h * Math.abs(Math.sin(Math.PI * phase));
    let roll = 0, spin = celebrate * TAU * smooth(clamp(u / 0.85, 0, 1)), headPitch = 0, headFwd = 0, sweep = 0;
    if (a?.action === 'act') { const strike = beat(u, 0.45); headPitch += 0.6 * strike; headFwd += 0.15 * h * strike; sweep += -0.5 * strike; pitch += 0.25 * strike; }
    if (a?.action === 'hit') { if (hitKicked !== a) { hitKicked = a; ruffle.kick(14); } }
    const rf = ruffle.step(0, dt);
    roll += rf * 0.08;
    // folded: the wings swept back along the body and lowered; flying: open, beating
    const fold = 1 - flyW;
    const flap = amp * flyW, d1 = flap * st + 0.15 * rf, d2 = 0.5 * flap * st2, d3 = 0.4 * flap * st3;
    let rootRoll = 0, rootY = 0;
    if (d > 0 && !s.tumbling) { rootRoll = 1.3 * d; rootY = 0.4 * info.width * d * 0.5; }
    hover *= 1 - d; bob *= 1 - d; hop *= 1 - d; pitch *= 1 - d;
    P.move('Root', 0, rootY, 0); P.rot('Root', Z, rootRoll); P.rot('Root', Y, spin);
    P.move('Body', 0, hover + bob + hop, 0); P.rot('Body', X, pitch); P.rot('Body', Z, roll);
    P.rot('Head', X, -pitch * 0.7 + headPitch + (1 - flyW) * 0.08 * Math.sin(s.t * 1.1)); P.move('Head', 0, 0, headFwd);
    P.rot('Head', Y, (1 - moveW) * (1 - d) * 0.4 * Math.sin(s.t * 0.7));
    for (const [side, sg] of [['Left', 1], ['Right', -1]]) {
      // up is a roll about Z (+ for the left wing on +X), back is a turn about Y
      P.rot(side + 'Wing1', Y, sg * (fold * 0.75 + sweep)); P.rot(side + 'Wing1', Z, sg * (d1 - fold * 0.45 + d * (sg > 0 ? 0.6 : -0.4)));
      P.rot(side + 'Wing2', Y, sg * fold * 0.6); P.rot(side + 'Wing2', Z, sg * (d2 - fold * 0.25));
      if (P.has(side + 'Wing3')) { P.rot(side + 'Wing3', Y, sg * fold * 0.5); P.rot(side + 'Wing3', Z, sg * d3); }
      // legs tuck back when flying, reach forward to hold, splay when down
      if (P.has(side + 'Leg')) P.rot(side + 'Leg', X, 0.9 * flyW - 0.5 * (s.hold ?? 0) + 0.4 * d + (1 - flyW) * moveW * 0.35 * Math.sin(Math.PI * phase) * sg);
    }
    if (P.has('Tail')) { P.rot('Tail', X, -0.25 * flyW * st - 0.1 * (gliding ? 1 : 0)); P.rot('Tail', Y, 0.1 * Math.sin(s.t * 2)); }
    return { lift: hover + hop };
  };
}

const MOTIONS = { blob: blobMotion, worm: wormMotion, quadruped: quadrupedMotion, flyer: flyerMotion };

/** A body's motion. bodyNode: the node the bind pose was measured in (gf_body), for the legs' reach. */
export function createMotion(std, rig, bind, info, { bodyNode = null } = {}) {
  const P = createPoser(rig, bind);
  const step = MOTIONS[std.archetype](P, info, bind, bodyNode);
  return {
    poser: P,
    /** Pose every bone for this frame. → { lift } (how far the body is off the ground, m, body frame) */
    pose(state, dt) {
      P.reset();
      // a quadruped places its own bones before its legs reach (the reach reads where the hips are)
      const r = step(state, dt) ?? {};
      if (std.archetype !== 'quadruped') P.apply();
      return r;
    },
  };
}
