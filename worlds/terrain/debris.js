// gf-three smooth terrain: debris. Chunky lumps of the ground thrown out of a crater, falling and bouncing on the field
// (never through it), then shrinking away. Cosmetic and per copy (a seeded stream of its own: never the game's), one
// InstancedMesh in the soil's colour, tagged with the soil's slot. Dust and flashes are the vfx module's (the carve
// mechanic's `dustFx`, `blastFx`); this is the part of an explosion only the ground knows the colour of.
import * as THREE from 'three';
import { material } from '../../look/materials.js';

const CAP = { high: 220, low: 80 };

export function createDebris(ctx, field, { color = '#8a5a36', top = '#7cc444', slot = 'world.terrain.soil', quality = 'high' } = {}) {
  const cap = CAP[quality] ?? CAP.high;
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const mat = material('prop', { color: '#ffffff' });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.name = 'terrain-debris';
  mesh.userData.gfSlot = slot;
  const soil = new THREE.Color(color), grass = new THREE.Color(top), C = new THREE.Color();
  const live = [];
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();

  /** Throw lumps out of a crater at `at` ({x, y, z}) of radius r; `normal` is the way out of the ground ([x, y, z]). */
  function burst(at, r, { normal = [0, 1, 0], count = null } = {}) {
    const n = Math.min(cap, count ?? Math.round(Math.max(6, Math.min(26, r * 7))));
    for (let i = 0; i < n; i++) {
      if (live.length >= cap) live.shift();
      const a = rnd() * Math.PI * 2, s = 3 + rnd() * 6 * Math.min(2, r / 1.5), up = 4 + rnd() * 7;
      const v = [Math.cos(a) * s + normal[0] * up, up * (0.6 + normal[1] * 0.6), Math.sin(a) * s + normal[2] * up];
      live.push({
        p: [at.x + (rnd() - 0.5) * r * 0.6, at.y + rnd() * r * 0.3, at.z + (rnd() - 0.5) * r * 0.6], v,
        rot: [rnd() * 6, rnd() * 6, rnd() * 6], spin: [(rnd() - 0.5) * 12, (rnd() - 0.5) * 12, (rnd() - 0.5) * 12],
        size: (0.18 + rnd() * 0.32) * Math.min(1.6, 0.6 + r * 0.25), age: 0, life: 1.8 + rnd() * 1.4,
        tint: rnd() < 0.18 ? 1 : 0, shade: 0.75 + rnd() * 0.35,
      });
    }
  }
  function update(dt) {
    let k = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      b.age += dt;
      if (b.age > b.life) { live.splice(i, 1); continue; }
      b.v[1] -= 18 * dt;
      const nx = b.p[0] + b.v[0] * dt, ny = b.p[1] + b.v[1] * dt, nz = b.p[2] + b.v[2] * dt;
      if (field.sample(nx, ny - b.size * 0.5, nz) < 0) {
        // a bounce off the ground: back out along the field's normal, slowed
        const n = field.normal(nx, ny, nz), dot = b.v[0] * n[0] + b.v[1] * n[1] + b.v[2] * n[2];
        if (dot < 0) { b.v[0] -= 1.5 * dot * n[0]; b.v[1] -= 1.5 * dot * n[1]; b.v[2] -= 1.5 * dot * n[2]; }
        b.v[0] *= 0.55; b.v[1] *= 0.45; b.v[2] *= 0.55; b.spin = b.spin.map(s => s * 0.6);
      } else { b.p[0] = nx; b.p[1] = ny; b.p[2] = nz; }
      if (b.p[1] < -0.3) b.age = Math.max(b.age, b.life - 0.2);          // into the sea: gone soon
      for (let a = 0; a < 3; a++) b.rot[a] += b.spin[a] * dt;
    }
    for (const b of live) {
      const fade = Math.min(1, (b.life - b.age) / 0.4);
      Q.setFromEuler(E.set(b.rot[0], b.rot[1], b.rot[2]));
      M.compose(P.set(b.p[0], b.p[1], b.p[2]), Q, S.setScalar(b.size * fade));
      mesh.setMatrixAt(k, M);
      mesh.setColorAt(k, C.copy(b.tint ? grass : soil).multiplyScalar(b.shade));
      k++;
    }
    mesh.count = k;
    if (k) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
  }
  return { mesh, burst, update, get count() { return live.length; }, setColors(s, t) { if (s) soil.set(s); if (t) grass.set(t); } };
}
