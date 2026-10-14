// An arcing liquid stream (hoses, paint, sprays, water guns): a tapered tube along a ballistic arc, plus droplets
// that peel off along it and splash where it lands. Geometry is a kit primitive; its look is the house 'liquid'
// material (look.materials.liquid.*) and the tint is a slot the caller passes (e.g. mechanic.projectile.color).
//
//   const s = createStream({ tint: '#7fdcff', width: 0.07 });
//   scene.add(s.object3d);
//   s.aim(from, to, { apex: 1.2 })          // or s.fire(origin, velocity, { gravity, ground })
//   s.update(dt)                             // every frame
import * as THREE from 'three';
import { material, setTint } from './materials.js';

export function createStream(opts = {}) {
  const segs = opts.segments ?? 40, radial = opts.radial ?? 10, nDrops = opts.droplets ?? 28;
  let width = opts.width ?? 0.07;
  const dropScale = opts.dropScale ?? 1.8;
  const mat = opts.material ?? material('liquid', { tint: opts.tint ?? '#8fe3ff' });
  const geo = new THREE.BufferGeometry();
  const vcount = (segs + 1) * radial;
  const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3), uv = new Float32Array(vcount * 2);
  const idx = [];
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * radial + j, b = i * radial + (j + 1) % radial, c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
    idx.push(a, c, b, b, c, d);
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  const tube = new THREE.Mesh(geo, mat);
  tube.frustumCulled = false; tube.castShadow = true; tube.receiveShadow = false;
  tube.userData.gfSlot = opts.slot ?? 'look.materials.liquid.core';
  const dropGeo = new THREE.IcosahedronGeometry(1, 1);
  const drops = new THREE.InstancedMesh(dropGeo, mat, nDrops);
  drops.frustumCulled = false; drops.castShadow = true;
  drops.userData.gfSlot = opts.slot ?? 'look.materials.liquid.core';
  const group = new THREE.Group();
  group.name = 'gf-stream';
  group.add(tube, drops);

  const state = { origin: new THREE.Vector3(), vel: new THREE.Vector3(1, 1, 0), g: 9.8, T: 1, t: 0, ground: 0, on: true };
  const dropState = Array.from({ length: nDrops }, (_, i) => ({ life: -i / nDrops, p: new THREE.Vector3(), v: new THREE.Vector3(), s: 1 }));
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const at = (t, out) => out.copy(state.origin).addScaledVector(state.vel, t).add(new THREE.Vector3(0, -0.5 * state.g * t * t, 0));
  const tangentAt = (t, out) => out.copy(state.vel).add(new THREE.Vector3(0, -state.g * t, 0)).normalize();

  /** Shoot from origin with an initial velocity; the arc ends where it reaches `ground` (y) or after maxTime. */
  function fire(origin, velocity, o = {}) {
    state.origin.copy(origin); state.vel.copy(velocity); state.g = o.gravity ?? 9.8; state.ground = o.ground ?? 0;
    // time to reach the ground plane
    const a = -0.5 * state.g, b = velocity.y, c = origin.y - state.ground;
    const disc = b * b - 4 * a * c;
    state.T = Math.min(o.maxTime ?? 3, disc > 0 ? (-b - Math.sqrt(disc)) / (2 * a) : 1);
    state.on = true;
  }
  /** Arc from `from` to `to` peaking `apex` metres above the higher end. */
  function aim(from, to, o = {}) {
    const g = o.gravity ?? 9.8, apex = o.apex ?? 1;
    const top = Math.max(from.y, to.y) + apex;
    const vy = Math.sqrt(2 * g * (top - from.y));
    const tUp = vy / g, tDown = Math.sqrt(2 * Math.max(top - to.y, 1e-3) / g);
    const T = tUp + tDown;
    const vel = new THREE.Vector3((to.x - from.x) / T, vy, (to.z - from.z) / T);
    fire(from, vel, { gravity: g, ground: to.y - 0.0001, maxTime: T });
    state.T = T;
  }

  function rebuild() {
    let k = 0;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs, t = u * state.T;
      at(t, P); tangentAt(t, T);
      N.crossVectors(T, up); if (N.lengthSq() < 1e-6) N.set(1, 0, 0); N.normalize();
      B.crossVectors(N, T).normalize();
      const wob = 1 + 0.18 * Math.sin(u * 23 - state.t * 17) + 0.1 * Math.sin(u * 51 + state.t * 9);
      const taper = Math.min(1, u * 10 + 0.35) * (1 - 0.35 * u);
      const r = width * wob * taper;
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nx = N.x * ca + B.x * sa, ny = N.y * ca + B.y * sa, nz = N.z * ca + B.z * sa;
        pos[k * 3] = P.x + nx * r; pos[k * 3 + 1] = P.y + ny * r; pos[k * 3 + 2] = P.z + nz * r;
        nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
        uv[k * 2] = u * state.T * 6; uv[k * 2 + 1] = j / radial;
        k++;
      }
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true; geo.attributes.uv.needsUpdate = true;
  }

  function updateDrops(dt) {
    const end = at(state.T, new THREE.Vector3());
    for (let i = 0; i < nDrops; i++) {
      const d = dropState[i];
      d.life += dt * 1.6;
      if (d.life >= 1 || d.life < 0 && d.life + dt * 1.6 >= 0) {
        // respawn: a third peel off the arc, the rest splash at the impact point
        d.life = d.life >= 1 ? 0 : d.life;
        const splash = rnd() < 0.65;
        if (splash) {
          d.p.copy(end); const ang = rnd() * Math.PI * 2, sp = 0.8 + rnd() * 1.8;
          d.v.set(Math.cos(ang) * sp, 1.2 + rnd() * 2.2, Math.sin(ang) * sp);
          d.s = width * dropScale * (0.45 + rnd() * 0.6);
        } else {
          const t = rnd() * state.T; at(t, d.p); tangentAt(t, d.v).multiplyScalar(2 + rnd() * 2);
          d.v.x += (rnd() - 0.5) * 1.2; d.v.z += (rnd() - 0.5) * 1.2; d.s = width * dropScale * (0.3 + rnd() * 0.4);
        }
      }
      if (d.life >= 0) { d.v.y -= state.g * dt; d.p.addScaledVector(d.v, dt); if (d.p.y < state.ground) { d.p.y = state.ground; d.v.multiplyScalar(0.3); } }
      const vis = state.on && d.life >= 0;
      const sc = vis ? d.s * (1 - d.life * 0.7) : 0;
      S.set(sc, sc * 1.15, sc);
      M.compose(d.p, Q, S);
      drops.setMatrixAt(i, M);
    }
    drops.instanceMatrix.needsUpdate = true;
  }

  return {
    object3d: group, material: mat, fire, aim,
    update(dt) { state.t += dt; tube.visible = state.on; if (state.on) rebuild(); updateDrops(dt); },
    get end() { return at(state.T, new THREE.Vector3()); },
    get on() { return state.on; }, set on(v) { state.on = !!v; },
    set width(w) { width = w; }, get width() { return width; },
    setTint(c) { setTint(mat, c); },
    dispose() { geo.dispose(); dropGeo.dispose(); },
  };
}
