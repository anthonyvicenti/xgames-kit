// gf-humanoid-1 ragdoll on Rapier (RIG.md §6). Built from the character's current pose when it is knocked, it drives
// the bones from 11 bodies until the character gets up, then it is removed.
//
// Bodies are created with identity rotation (the capsule's direction lives in the collider), so a joint axis is the
// same vector in both bodies' frames and a hinge's angle starts at 0 in the pose it was knocked in.
// Collision groups (RIG.md §6): parts are in group RAGDOLL and collide with WORLD and PROPS only, so a ragdoll never
// fights its own parts or another player's capsule.
import * as THREE from 'three';

export const GROUPS = { WORLD: 0x0001, PLAYERS: 0x0002, PROPS: 0x0004, RAGDOLL: 0x0008 };
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

const _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (R, v) => new R.Vector3(v.x, v.y, v.z);
/** The fastest a ragdoll part may leave (m/s): a knock is a shove, never a launch, whatever a caller passes. */
export const MAX_LAUNCH = 30;

// A ball joint with no limits lets a head or a spine turn all the way round (a head spun 180° shows as a head torn off
// the body, because the skin between the bones stretches). Rapier's JS API only has setLimits on revolute and
// prismatic joints; a spherical joint takes per-axis angular limits through its raw set (RawJointAxis AngX, AngY, AngZ
// = 3, 4, 5 in rapier3d-compat 0.19.2, the kit's pin). Limits are relative to the pose the part was knocked in.
const ANG_AXES = [3, 4, 5];
function limitSwing(joint, lim) {
  const raw = joint.rawSet;
  if (!(lim > 0) || typeof raw?.jointSetLimits !== 'function') return false;
  for (const ax of ANG_AXES) raw.jointSetLimits(joint.handle, ax, -lim, lim);
  return true;
}

/**
 * parts: [{ name, bone, end: () => Vector3 world, radius, parent, hinge: 'elbow'|'knee'|null, ball: bool,
 *          swing: radians each way a ball joint may turn from the knocked pose (0 or missing: free) }]
 * opts: { velocity: Vector3 world m/s (capped at MAX_LAUNCH), forward: Vector3 world (the character's facing), density, filter }
 */
export function createRagdoll(RAPIER, world, parts, { velocity = new THREE.Vector3(), forward = new THREE.Vector3(0, 0, 1), density = 950, filter = GROUPS.WORLD | GROUPS.PROPS } = {}) {
  const made = new Map();
  velocity = new THREE.Vector3(velocity.x || 0, velocity.y || 0, velocity.z || 0);
  if (!Number.isFinite(velocity.lengthSq())) velocity.set(0, 0, 0);
  velocity.clampLength(0, MAX_LAUNCH);
  const cg = groups(GROUPS.RAGDOLL, filter);
  for (const pt of parts) {
    const a = pt.bone.getWorldPosition(new THREE.Vector3());
    const b = pt.end();
    const len = Math.max(1e-3, a.distanceTo(b));
    const center = pt.ball ? b.clone().add(a).multiplyScalar(0.5) : a.clone().add(b).multiplyScalar(0.5);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(center.x, center.y, center.z)
      .setLinearDamping(0.25).setAngularDamping(pt.parent ? 2.2 : 1.2).setCcdEnabled(pt.radius < 0.08));
    let cd;
    if (pt.ball) cd = RAPIER.ColliderDesc.ball(Math.max(pt.radius, len * 0.5));
    else {
      const half = Math.max(0.005, len / 2 - pt.radius * 0.6);
      _q.setFromUnitVectors(UP, _b.copy(b).sub(a).normalize());
      cd = RAPIER.ColliderDesc.capsule(half, pt.radius).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
    cd.setDensity(density).setFriction(0.9).setRestitution(0.05).setCollisionGroups(cg).setSolverGroups(cg);
    world.createCollider(cd, body);
    // the upper body and the limbs leave a little faster than the hips, so the body tumbles instead of flying stiff
    const k = { pelvis: 1, torso: 1.12, head: 1.18 }[pt.name] ?? (/arm/.test(pt.name) ? 1.22 : /thigh|shin/.test(pt.name) ? 0.82 : 1);
    body.setLinvel({ x: velocity.x * k, y: velocity.y * (k > 1 ? 1.05 : 0.95), z: velocity.z * k }, true);
    made.set(pt.name, { pt, body, a, b, center, worldRot0: pt.bone.getWorldQuaternion(new THREE.Quaternion()) });
  }
  // joints at each part's root joint
  const joints = [];
  for (const m of made.values()) {
    const par = m.pt.parent && made.get(m.pt.parent);
    if (!par) continue;
    const anchor = m.a;
    const a1 = anchor.clone().sub(par.center), a2 = anchor.clone().sub(m.center);
    let jd;
    if (m.pt.hinge) {
      const u = par.b.clone().sub(par.a).normalize(), l = m.b.clone().sub(m.a).normalize();
      const flex0 = Math.acos(THREE.MathUtils.clamp(u.dot(l), -1, 1));
      let axis = new THREE.Vector3().crossVectors(u, l);
      if (flex0 < 0.12 || axis.lengthSq() < 1e-6) axis = m.pt.hinge === 'knee' ? new THREE.Vector3().crossVectors(forward, u) : new THREE.Vector3().crossVectors(u, forward);
      axis.normalize();
      jd = RAPIER.JointData.revolute(v3(RAPIER, a1), v3(RAPIER, a2), v3(RAPIER, axis));
      const j = world.createImpulseJoint(jd, par.body, m.body, true);
      j.setLimits(-flex0 - 0.05, 2.5 - flex0);
      j.setContactsEnabled(false);
      joints.push(j);
    } else {
      jd = RAPIER.JointData.spherical(v3(RAPIER, a1), v3(RAPIER, a2));
      const j = world.createImpulseJoint(jd, par.body, m.body, true);
      j.setContactsEnabled(false);
      limitSwing(j, m.pt.swing);
      joints.push(j);
    }
  }
  const pelvis = made.get('pelvis');
  const hipsOffset0 = pelvis ? pelvis.pt.bone.getWorldPosition(new THREE.Vector3()).sub(pelvis.center) : null;

  const rd = {
    parts: made,
    /** Copy the bodies onto the bones (parents first). */
    update() {
      for (const m of made.values()) {
        const r = m.body.rotation(), t = m.body.translation();
        const rq = _rq.set(r.x, r.y, r.z, r.w);
        _q.copy(rq).multiply(m.worldRot0);
        const bone = m.pt.bone, parent = bone.parent;
        parent.updateWorldMatrix(true, false);
        const pq = parent.getWorldQuaternion(new THREE.Quaternion());
        bone.quaternion.copy(pq.invert().multiply(_q));
        if (m === pelvis) {
          _p.copy(hipsOffset0).applyQuaternion(rq).add(_b.set(t.x, t.y, t.z));
          bone.position.copy(parent.worldToLocal(_p));
        }
        bone.updateMatrixWorld(true);
      }
    },
    /** Fastest part speed, m/s. */
    speed() { let s = 0; for (const m of made.values()) { const v = m.body.linvel(); s = Math.max(s, Math.hypot(v.x, v.y, v.z)); } return s; },
    /** Where a part is: { position, quaternion } in world space. */
    pose(name) { const m = made.get(name); if (!m) return null; const t = m.body.translation(), r = m.body.rotation(); return { position: new THREE.Vector3(t.x, t.y, t.z), quaternion: new THREE.Quaternion(r.x, r.y, r.z, r.w) }; },
    /** Push every part (world m/s). */
    push(v) { for (const m of made.values()) { const c = m.body.linvel(); m.body.setLinvel({ x: c.x + v.x, y: c.y + v.y, z: c.z + v.z }, true); } },
    dispose() { for (const m of made.values()) world.removeRigidBody(m.body); made.clear(); },
  };
  return rd;
}
