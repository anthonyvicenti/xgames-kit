// gf-three feel: local-only juice shared by the action mechanics (melee, waves' enemy types, boss): screen shake, a
// pose freeze for hit-stop, and spark bursts. Nothing here touches shared state, physics or the net: a live round never
// pauses (CONTRACT §3, PLAN §2.6 "hit-pause never pauses the net pump"); hit-stop freezes only what this copy draws
// (the attacker's own swing timeline and the poses of the bodies involved), for a few hundredths of a second.
//
//   const feel = feelOf(ctx);            // one per game (ctx.feel), made on first use
//   feel.shake(0.4)                      // trauma 0..1; the camera turns a little and settles (this copy only)
//   feel.freeze(character, 0.06)         // hold this body's bones where they are for 60 ms (this copy only)
//   feel.sparks({x, y, z}, {count, color, speed, size, dir})   // a burst of short-lived sparks (a kit primitive)
//   (the kit's frame calls feel.update(dt) through ctx.onFrame: after every mechanic and the rules, before the render)
import * as THREE from 'three';

const N = 160;

export function feelOf(ctx) {
  if (ctx.feel) return ctx.feel;
  let trauma = 0, t = 0;
  const frozen = new Map();          // character → {until, quats: [[bone, Quaternion]], hips}
  // sparks: one instanced mesh per colour (a kit primitive whose colour is a slot: the caller names it)
  const pools = new Map();
  const geo = new THREE.OctahedronGeometry(1, 0);
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1), U = new THREE.Vector3();
  let seed = 9; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);    // cosmetic only
  function poolOf(color, slot) {
    const key = `${color}|${slot}`;
    let p = pools.get(key); if (p) return p;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false; mesh.name = 'gf-feel-sparks'; mesh.renderOrder = 5;
    if (slot && ctx.assets?.tag) ctx.assets.tag(mesh, slot); else mesh.userData.gfExempt = 'feel sparks without a slot';
    S.setScalar(0); M4.compose(P.set(0, -60, 0), Q, S); for (let i = 0; i < N; i++) mesh.setMatrixAt(i, M4);
    ctx.scene.add(mesh);
    p = { mesh, i: 0, parts: Array.from({ length: N }, () => ({ life: 1, max: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0.05 })) };
    pools.set(key, p); return p;
  }
  const api = {
    shake(a = 0.3) { trauma = Math.min(1, trauma + Math.max(0, a)); },
    get trauma() { return trauma; },
    /** Hold a character's bones (its pose) for `secs` on this copy: hit-stop. */
    freeze(character, secs = 0.06) {
      if (!character?.bones || secs <= 0) return;
      const f = frozen.get(character);
      if (f) { f.until = Math.max(f.until, t + secs); return; }
      const quats = [];
      for (const b of character.bones.values()) if (b?.quaternion) quats.push([b, b.quaternion.clone()]);
      const hips = character.bones.get?.('Hips');
      frozen.set(character, { until: t + secs, quats, hips: hips ? [hips, hips.position.clone()] : null });
    },
    isFrozen: character => frozen.has(character),
    sparks(at, { count = 10, color = '#fff2c4', slot = null, speed = 6, size = 0.07, life = 0.24, dir = null, up = 0.6, spread = 1 } = {}) {
      const p = poolOf(color, slot);
      for (let k = 0; k < count; k++) {
        const q = p.parts[p.i]; p.i = (p.i + 1) % N;
        let a = rnd() * Math.PI * 2;
        if (dir) a = Math.atan2(dir.x, dir.z) + (rnd() - 0.5) * Math.PI * spread;
        const sp = speed * (0.45 + rnd() * 0.75);
        Object.assign(q, { life: 0, max: life * (0.6 + rnd() * 0.7), x: at.x, y: at.y ?? 1, z: at.z, vx: Math.sin(a) * sp, vy: (rnd() * 1.2 - 0.2 + up) * sp * 0.5, vz: Math.cos(a) * sp, s: size * (0.6 + rnd() * 0.8) });
      }
    },
    /** Once a frame, from ctx.onFrame. */
    update(dt) {
      t += dt;
      // hit-stop: put the frozen bones back where they were
      for (const [c, f] of frozen) {
        if (t >= f.until || !c.object3d?.parent) { frozen.delete(c); continue; }
        for (const [b, q] of f.quats) b.quaternion.copy(q);
        if (f.hips) f.hips[0].position.copy(f.hips[1]);
      }
      // screen shake: the camera turns a little (this copy's camera only; the aim was taken before)
      if (trauma > 0.001 && ctx.camera) {
        const k = trauma * trauma, amp = 0.012 * k;
        ctx.camera.rotateX(Math.sin(t * 61.3) * amp); ctx.camera.rotateY(Math.sin(t * 47.9 + 1.7) * amp); ctx.camera.rotateZ(Math.sin(t * 53.1 + 0.4) * amp * 0.6);
        ctx.camera.updateMatrixWorld();
        trauma = Math.max(0, trauma - dt * 2.6);
      }
      for (const p of pools.values()) {
        for (let i = 0; i < N; i++) {
          const q = p.parts[i];
          if (q.life >= q.max) { S.setScalar(0); M4.compose(P.set(0, -60, 0), Q, S); p.mesh.setMatrixAt(i, M4); continue; }
          q.life += dt; q.vy -= 14 * dt; q.vx *= 0.92; q.vz *= 0.92; q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
          const k = 1 - q.life / q.max;
          S.set(q.s * k, q.s * k, q.s * k * 2.4); U.set(q.vx, q.vy, q.vz); if (U.lengthSq() > 1e-8) Q.setFromUnitVectors(Z, U.normalize());
          M4.compose(P.set(q.x, Math.max(0.02, q.y), q.z), Q, S); p.mesh.setMatrixAt(i, M4);
        }
        Q.identity();
        p.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    reset() { trauma = 0; frozen.clear(); for (const p of pools.values()) for (const q of p.parts) q.life = q.max = 0; },
  };
  ctx.feel = api;
  (ctx.onFrame ??= []).push(dt => api.update(dt));
  return api;
}
