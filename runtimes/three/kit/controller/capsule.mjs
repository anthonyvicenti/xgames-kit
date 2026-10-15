// gf-three controller: the floating-capsule character body, on Rapier.
//
// A plain-JS port of the character logic in pmndrs/ecctrl (MIT, Copyright (c) 2023-2026 Erdong Chen, commit
// e2cab804f9f15661a642e76f52d09f0b2db63f35, src/character/Ecctrl.tsx), by way of games.fun's third-person-adventure
// trial (research/foundations/trials/third-person-adventure/source/src/physics.mjs). See LICENSE-ecctrl and NOTICE-ecctrl
// beside this file.
//
// A dynamic capsule that never touches the ground: a ball shape-cast below it finds the ground and a spring-damper
// impulse holds it `floatHeight` above; movement is an impulse toward the wanted planar velocity (with sideways
// "reject" velocity, slope-following direction and grip from the ground's friction); gravity scale is 0 on the ground,
// 1 rising and `fallingGravityScale` falling; a jump sets the vertical velocity.
// Changes for gf-three: no water, glide or swim (adventure-only); a knock (impulse + a stun during which input is
// ignored and the capsule slides) for party games; a push (a shove with a short slip: input still steers, more weakly,
// and the body is never knocked over: fair play F6, continuous attacks); facing can be held to an aim yaw; yaw convention is three.js
// rotation.y of a +Z-facing model: forward = (sin yaw, 0, cos yaw).
// Pure JS: no three.js, no DOM, so node tests run it against the real Rapier build.
import { CAPSULE_GROUPS, SOLID_QUERY } from '../core/util.js';

export const CAPSULE_DEFAULTS = {
  capsule: { halfHeight: 0.35, radius: 0.3, floatHeight: 0.3 },
  move: { walkSpeed: 2, runSpeed: 5.2, sprintSpeed: 7.8, accDeltaTime: 0.2, decDeltaTime: 0.2, airDragFactor: 0.2, slideGripFactor: 0.5, rejectVelFactor: 1, turnRate: 12, slopeMaxDeg: 50 },
  jump: { velocity: 7.2, fallingGravityScale: 1.7, fallingMaxVel: 24, jumpDuration: 0.1, coyoteTime: 0.12, bufferTime: 0.12 },
  float: { springK: 80, dampingC: 6, rayRadius: 0.15, rayLength: 1.3, forgiveness: 0.28 },
};
export function capsuleConfig(over = {}) {
  const out = {};
  for (const [k, v] of Object.entries(CAPSULE_DEFAULTS)) out[k] = { ...v, ...(over[k] ?? {}) };
  return out;
}

/**
 * input (per physics step): { x, z } wanted planar direction in world space (length <= 1), sprint, walk,
 * jumpPresses (count since the last step), enabled, face (a yaw to turn to when set, e.g. while aiming).
 */
export function createCapsule(RAPIER, world, cfg, start, { userData = null } = {}) {
  const C = cfg.capsule, M = cfg.move, J = cfg.jump, F = cfg.float;
  const dt = world.timestep;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z).lockRotations().setCanSleep(false).setCcdEnabled(true).setLinearDamping(0));
  // a PLAYER (RIG.md §6): it meets the world, props and other players, never a ragdoll (its own included)
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(C.halfHeight, C.radius).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0).setDensity(1).setCollisionGroups(CAPSULE_GROUPS), body);
  if (userData) collider.__gf = userData;
  const ball = new RAPIER.Ball(F.rayRadius);
  const floatDist = F.rayRadius + C.floatHeight;
  const feetOffset = C.halfHeight + 2 * F.rayRadius + C.floatHeight;   // body centre -> ground when floating
  const slopeMax = M.slopeMaxDeg * Math.PI / 180;
  const rot0 = { x: 0, y: 0, z: 0, w: 1 }, down = { x: 0, y: -1, z: 0 };
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, down);
  // what the ground probe sees. A part whose ground is not the same for every body at every moment sets it per step
  // (setQuery): a flat game's ledges hold a body coming down and let a rising one through (kit/flat/controller.js).
  let query = SOLID_QUERY;

  const s = {
    onGround: false, wasOnGround: false, falling: false, jumpActive: false, jumpTimer: 0, coyote: 0, buffer: 0,
    facing: start.yaw ?? 0, moving: false, groundDist: 0, groundNormal: [0, 1, 0], slope: 0, standFriction: 0,
    groundY: start.y - feetOffset, heightAboveGround: 0, speed: 0, vy: 0, landSpeed: 0, landed: false, jumped: false,
    jumps: 0, landings: 0, sinceJump: 9, stun: 0, slip: 0, knocks: 0, pushes: 0, vyBeforeLand: 0, stepCount: 0,
  };

  function groundCast(p) {
    const origin = { x: p.x, y: p.y - C.halfHeight, z: p.z };
    const hit = world.castShape(origin, rot0, down, ball, 0, F.rayLength, false, undefined, query, collider, body);
    if (!hit) return null;
    const n = hit.normal1, slope = Math.acos(Math.min(1, Math.max(-1, n.y)));
    if (slope < slopeMax) return { toi: hit.time_of_impact, normal: [n.x, n.y, n.z], slope, friction: hit.collider.friction() };
    ray.origin = origin; ray.dir = down;
    const rh = world.castRayAndGetNormal(ray, F.rayLength + F.rayRadius, false, undefined, query, collider, body);
    if (rh) {
      const sl = Math.acos(Math.min(1, Math.max(-1, rh.normal.y)));
      if (sl < slopeMax) return { toi: rh.timeOfImpact - F.rayRadius, normal: [rh.normal.x, rh.normal.y, rh.normal.z], slope: sl, friction: rh.collider.friction() };
    }
    return { toi: hit.time_of_impact, normal: [n.x, n.y, n.z], slope, friction: hit.collider.friction(), steep: true };
  }
  function probeGroundY(p, maxDown = 60) {
    ray.origin = { x: p.x, y: p.y - C.halfHeight, z: p.z }; ray.dir = down;
    const h = world.castRay(ray, maxDown, true, undefined, query, collider, body);
    return h ? p.y - C.halfHeight - h.timeOfImpact : -Infinity;
  }

  function step(input = {}) {
    s.stepCount++; s.landed = false; s.jumped = false;
    const p = body.translation(), v = body.linvel(), mass = body.mass();
    s.stun = Math.max(0, s.stun - dt); s.slip = Math.max(0, s.slip - dt);
    const en = input.enabled !== false && s.stun <= 0;
    let ix = 0, iz = 0;
    if (en) { ix = input.x ?? 0; iz = input.z ?? 0; const l = Math.hypot(ix, iz); if (l > 1) { ix /= l; iz /= l; } else if (l < 1e-3) ix = iz = 0; }
    const amount = Math.min(1, Math.hypot(ix, iz));
    const hasInput = amount > 0;
    if (hasInput) { ix /= amount; iz /= amount; }
    s.moving = hasInput;
    if (en && input.jumpPresses > 0) s.buffer = J.bufferTime; else s.buffer = Math.max(0, s.buffer - dt);

    // ---- ground (ecctrl floatCharacter) ----
    s.wasOnGround = s.onGround;
    const g = groundCast(p);
    s.onGround = !!g && !g.steep && g.toi < floatDist + F.forgiveness;
    s.sinceJump += dt;
    if (s.sinceJump < 0.3 && v.y > 0.5) s.onGround = false;
    if (g) { s.groundDist = g.toi; s.groundNormal = g.normal; s.slope = g.slope; s.standFriction = s.onGround ? g.friction : 0; }
    else { s.slope = 0; s.standFriction = 0; }
    const gy = probeGroundY(p);
    s.groundY = gy; s.heightAboveGround = (p.y - feetOffset) - gy;

    const grip = Math.min(1, Math.max(0, (s.standFriction + M.slideGripFactor) * 0.5));
    let vx = v.x, vy = v.y, vz = v.z;
    // floating spring (ecctrl applyFloatingForce)
    if (s.onGround) {
      const force = F.springK * (floatDist - s.groundDist) - F.dampingC * vy;
      let imp = force * dt;
      if (s.jumpActive && imp < 0) imp = 0;
      body.applyImpulse({ x: 0, y: imp, z: 0 }, true);
    }
    // friction when idle on the ground (ecctrl applyFriction); a knocked body slides further
    if (!hasInput && s.onGround) {
      const k = mass * grip * Math.min(1, M.decDeltaTime) * (s.stun > 0 ? 0.35 : s.slip > 0 ? 0.3 : 1);
      body.applyImpulse({ x: -vx * k, y: 0, z: -vz * k }, true);
    }
    // jump state + coyote time and the jump buffer
    if (s.jumpActive) { s.jumpTimer += dt; if (s.jumpTimer >= J.jumpDuration) s.jumpActive = false; }
    if (s.onGround) s.coyote = J.coyoteTime; else s.coyote = Math.max(0, s.coyote - dt);
    if (en && s.buffer > 0 && (s.onGround || s.coyote > 0) && !s.jumpActive) {
      body.setLinvel({ x: vx, y: J.velocity, z: vz }, true); vy = J.velocity;
      s.jumpActive = true; s.jumpTimer = 0; s.sinceJump = 0; s.buffer = 0; s.coyote = 0; s.jumped = true; s.jumps++; s.onGround = false;
    }
    s.falling = vy < 0 && !s.onGround;
    // dynamic gravity (ecctrl applyDynamicGravity)
    if (s.falling) body.setGravityScale(Math.abs(vy) > J.fallingMaxVel ? 0 : J.fallingGravityScale, true);
    else body.setGravityScale(s.onGround ? 0 : 1, true);

    if (hasInput) {
      // move (ecctrl moveCharacter): impulse toward the target planar velocity, along the slope
      const maxVel = (input.speed ?? (input.walk ? M.walkSpeed : input.sprint ? M.sprintSpeed : M.runSpeed)) * amount;
      let mx = ix, my = 0, mz = iz;
      if (s.onGround) {
        const a = -Math.asin(Math.max(-1, Math.min(1, s.groundNormal[0] * ix + s.groundNormal[2] * iz)));
        mx = ix * Math.cos(a); my = Math.sin(a); mz = iz * Math.cos(a);
      }
      const along = vx * ix + vz * iz;
      const rejx = s.onGround ? (vx - ix * along) * M.rejectVelFactor : 0, rejz = s.onGround ? (vz - iz * along) * M.rejectVelFactor : 0;
      const mult = mass * Math.min(1, M.accDeltaTime) * (s.onGround ? grip : M.airDragFactor) * (s.slope > slopeMax ? M.airDragFactor : 1) * (s.slip > 0 ? 0.3 : 1);
      body.applyImpulse({ x: (mx * maxVel - vx - rejx) * mult, y: my * maxVel * mult, z: (mz * maxVel - vz - rejz) * mult }, true);
    }
    // facing: toward the aim when one is held, else toward the input
    let want = null;
    if (typeof input.face === 'number' && en) want = input.face;
    else if (hasInput) want = Math.atan2(ix, iz);
    if (want !== null) { const d = ((want - s.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI; s.facing += d * (1 - Math.exp(-dt * M.turnRate)); }
  }

  function post() {
    const p = body.translation(), v = body.linvel();
    s.vy = v.y; s.speed = Math.hypot(v.x, v.z);
    if (s.onGround && !s.wasOnGround) { s.landed = true; s.landings++; s.landSpeed = Math.max(0, -s.vyBeforeLand); }
    s.vyBeforeLand = v.y;
    return p;
  }

  /** A hit: set the velocity (an impulse in m/s, {x, y, z}) and ignore input for `seconds`. */
  function knock(impulse, seconds = 0.6) {
    const v = body.linvel();
    body.setLinvel({ x: v.x + (impulse.x ?? 0), y: Math.max(v.y, 0) + (impulse.y ?? 0), z: v.z + (impulse.z ?? 0) }, true);
    s.stun = Math.max(s.stun, seconds); s.knocks++; s.sinceJump = 0; s.onGround = false;
  }

  /** A shove: add a velocity (m/s, {x, y, z}) and let the body slip for `seconds` (input steers at 30%); no stun. */
  function push(impulse, seconds = 0.3) {
    const v = body.linvel();
    body.setLinvel({ x: v.x + (impulse.x ?? 0), y: v.y + Math.max(0, impulse.y ?? 0), z: v.z + (impulse.z ?? 0) }, true);
    s.slip = Math.max(s.slip, seconds); s.pushes++;
  }

  /** Ride a path someone else simulates (a host-owned flight: the knockback mechanic): the body is put where the path is
   *  (feet {x, y, z}) at its velocity (m/s), input ignored for `stun` seconds. Call it every step while the ride lasts. */
  function ride(feet, vel, stun = 0) {
    body.setTranslation({ x: feet.x, y: feet.y + feetOffset, z: feet.z }, true);
    body.setLinvel({ x: vel.x ?? 0, y: vel.y ?? 0, z: vel.z ?? 0 }, true);
    s.stun = Math.max(s.stun, stun); s.onGround = false; s.sinceJump = 0; s.stepCount++;
  }

  function reset(pos, yaw) {
    body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true); body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    Object.assign(s, { onGround: false, wasOnGround: false, jumpActive: false, coyote: 0, buffer: 0, stun: 0, slip: 0, facing: yaw ?? s.facing });
  }

  return { body, collider, state: s, step, post, knock, push, ride, reset, feetOffset, config: cfg, probeGroundY, setQuery(groups) { query = groups ?? SOLID_QUERY; } };
}
