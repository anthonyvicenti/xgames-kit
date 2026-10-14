// gf-scenic weather: rain and snow (folio's rain lines), and lightning (a strike arc and a flash of the whole scene).
//
//   Ported from brunosimon/folio-2025@41046b5 src/Game/World/RainLines.js, src/Game/World/Lightnings.js (the arc) and
//   src/Game/Geometries/LineGeometry.js (MIT, Copyright (c) 2025 Bruno Simon; licence in
//   research/gf-scenic/kit/LICENSE-folio-2025). gf-scenic: weather amounts are look slots (weather.rain, .snow,
//   .lightning) instead of folio's drifting weather model; snow is the rain lines short and slow (folio's own
//   rain-to-snow blend); a strike lands at a seeded random spot round the focus, the flash lifts U.flash; the strike
//   anticipation and explosion particles are left out. Every mesh is tagged with its look slot.
import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, vec2, vec3, vec4, mod, step, fract, float, min, mix, cross, floor, positionGeometry, modelWorldMatrix, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, vertexIndex, luminance, materialColor } from 'three/tsl';
import { U } from './materials.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = x => Math.max(0, Math.min(1, x));
const remapClamp = (v, a, b, c, d) => lerp(c, d, clamp01((v - a) / (b - a)));

function rainGeometry(count, rnd) {
  const pos = new Float32Array(count * 12), off = new Float32Array(count * 8), rand = new Float32Array(count * 4), idx = new Uint32Array(count * 6);
  for (let l = 0; l < count; l++) {
    const x = rnd(), z = rnd(), r = rnd();
    for (let v = 0; v < 4; v++) {
      const k = l * 4 + v;
      pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
      off[k * 2] = v === 0 || v === 1 ? 1 : 0; off[k * 2 + 1] = v === 0 || v === 3 ? 1 : 0;
      rand[k] = r;
    }
    idx.set([l * 4, l * 4 + 3, l * 4 + 2, l * 4 + 2, l * 4 + 1, l * 4], l * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('rainOffset', new THREE.Float32BufferAttribute(off, 2));
  g.setAttribute('rainSeed', new THREE.Float32BufferAttribute(rand, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(count * 12).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function lineGeometry(points) {
  const n = points.length, pos = new Float32Array(n * 6), dir = new Float32Array(n * 6), ratio = new Float32Array(n * 2), idx = new Uint16Array((n - 1) * 6);
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[Math.min(i + 1, n - 1)], d = q.clone().sub(p).normalize();
    pos.set([p.x, p.y, p.z, p.x, p.y, p.z], i * 6); dir.set([d.x, d.y, d.z, d.x, d.y, d.z], i * 6);
    ratio[i * 2] = ratio[i * 2 + 1] = i / (n - 1);
    if (i < n - 1) idx.set([i * 2 + 2, i * 2, i * 2 + 1, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('direction', new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute('ratio', new THREE.Float32BufferAttribute(ratio, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** → { group, update(dt, focus, values), strike(at) } */
export function createWeather(scene, { rng = Math.random, count = 4096 } = {}) {
  const group = new THREE.Group(); group.name = 'gf-scenic-weather';
  scene.add(group);

  // ---- rain and snow lines ----
  const R = { thickness: uniform(0.015), elevation: uniform(18), incline: uniform(0.2), size: uniform(44), center: uniform(new THREE.Vector2()), length: uniform(2), localTime: uniform(0), visible: uniform(0), base: uniform(-0.3) };
  // unlit, tinted by the sun so the lines sit in the light of the look; double-sided (folio's camera looks the other
  // way round its island, so these quads face away from the follow camera)
  const rainMat = new THREE.MeshBasicNodeMaterial({ transparent: true, color: '#cfe4ff', opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  rainMat.colorNode = materialColor.mul(U.lightColor.mul(U.lightIntensity).add(U.flash).max(0.35));
  rainMat.userData.gfNoHouse = true;
  rainMat.positionNode = Fn(() => {
    const p = attribute('position').toVar(), offset = attribute('rainOffset'), random = attribute('rainSeed');
    const tangent = vec2(0.707, -0.707);
    p.xz.mulAssign(R.size);
    p.xz.subAssign(R.center);
    const half = R.size.mul(0.5);
    p.x.assign(mod(p.x.add(half), R.size).sub(half));
    p.z.assign(mod(p.z.add(half), R.size).sub(half));
    p.xz.addAssign(R.center);
    p.xz.addAssign(tangent.mul(offset.x.mul(R.thickness)));
    const progress = R.localTime.add(random).mod(1);
    p.y.assign(R.elevation.add(R.length));
    p.y.subAssign(R.length.mul(offset.y.oneMinus()));
    p.y.subAssign(progress.mul(R.elevation.add(R.length)));
    p.y.assign(p.y.clamp(R.base, R.elevation));
    p.y.addAssign(step(R.visible, fract(random.mul(99))).mul(999));
    p.xz.addAssign(tangent.mul(p.y.mul(R.incline).mul(-1)));
    return p;
  })();
  const rain = new THREE.Mesh(rainGeometry(count, rng), rainMat);
  rain.name = 'rain'; rain.frustumCulled = false; rain.renderOrder = 1; rain.castShadow = false; rain.receiveShadow = false;
  rain.userData.gfSlot = 'look.weather.rain';
  group.add(rain);
  let speed = 0.25;

  // ---- lightning: a strike arc that thins and drifts out, and a flash ----
  const L = { start: uniform(-99), now: uniform(0), duration: 1.4, colorA: uniform(new THREE.Color('#ff9a5c')), colorB: uniform(new THREE.Color('#8fb0ff')), intensity: uniform(4), thickness: uniform(0.14) };
  const pts = []; for (let i = 0; i < 15; i++) pts.push(new THREE.Vector3((rng() - 0.5), i * (22 / 14), (rng() - 0.5)));
  const arcMat = new THREE.MeshBasicNodeMaterial({ transparent: true });
  arcMat.userData.gfGlow = true;
  const mixed = mix(L.colorA, L.colorB, attribute('ratio'));
  arcMat.colorNode = vec4(mixed.div(luminance(mixed)).mul(L.intensity), 1);
  arcMat.fog = false;
  arcMat.vertexNode = Fn(() => {
    const ratio = attribute('ratio');
    const tipness = step(ratio, 0.01);
    const t = min(L.now.sub(L.start).div(L.duration), 1);
    const p = positionGeometry.toVar();
    p.xz.mulAssign(t.oneMinus().pow(5).oneMinus().mul(tipness.oneMinus()).add(1));
    const world = modelWorldMatrix.mul(vec4(p, 1));
    const toCam = world.xyz.sub(cameraPosition).normalize();
    const next = modelWorldMatrix.mul(vec4(positionGeometry.add(attribute('direction')), 1));
    const tangent = cross(next.xyz.sub(world.xyz).normalize(), toCam).normalize();
    const thick = R.thickness.mul(0).add(L.thickness).mul(ratio.mul(10).min(1)).mul(t.oneMinus());
    const side = floor(vertexIndex.toFloat().mul(3).sub(2).div(3).mod(2)).sub(0.5);
    world.addAssign(vec4(tangent.mul(side.mul(thick)), 0));
    return cameraProjectionMatrix.mul(cameraViewMatrix.mul(world));
  })();
  const arc = new THREE.Mesh(lineGeometry(pts), arcMat);
  arc.name = 'lightning'; arc.frustumCulled = false; arc.visible = false; arc.renderOrder = 2;
  arc.userData.gfSlot = 'look.weather.lightning';
  group.add(arc);
  let clock = 0, nextStrike = 4 + rng() * 6, flash = 0;

  function strike(at) {
    arc.position.set(at.x, at.y ?? 0, at.z);
    arc.rotation.y = rng() * Math.PI * 2;
    L.start.value = clock; arc.visible = true; flash = 1;
  }

  return {
    group, strike, rain, R,
    update(dt, focus, values) {
      clock += dt; L.now.value = clock;
      const w = values.weather ?? {};
      const rainV = clamp01(w.rain ?? 0), snowV = clamp01(w.snow ?? 0), lightV = clamp01(w.lightning ?? 0);
      const wet = Math.max(rainV, snowV), snowRatio = snowV > 0 ? 1 - Math.pow(1 - snowV / Math.max(wet, 1e-3), 4) : 0;
      R.visible.value = Math.pow(wet, 2);
      R.length.value = lerp(remapClamp(rainV, 0, 1, 0.8, 2.2), 0.09, snowRatio);
      R.thickness.value = lerp(0.022, 0.09, snowRatio);
      rainMat.opacity = lerp(0.5, 0.85, snowRatio);
      speed = lerp(remapClamp(rainV, 0, 1, 0.2, 0.4), 0.05, snowRatio);
      R.incline.value = remapClamp((values.wind?.strength ?? 0.4), 0, 1, 0.1, 0.4);
      rainMat.color.set(snowRatio > 0.5 ? '#ffffff' : '#cfe4ff');
      rain.visible = R.visible.value > 1e-5;
      if (rain.visible) { R.center.value.set(focus.x, focus.z); R.base.value = (focus.y ?? 0) - 0.3; R.localTime.value += dt * speed; }
      // lightning: a strike every few seconds at the strength's rate, somewhere round the focus
      if (lightV > 0) {
        nextStrike -= dt * lightV;
        if (nextStrike <= 0) { nextStrike = 3 + rng() * 7; const a = rng() * Math.PI * 2, d = 10 + rng() * 22; strike({ x: focus.x + Math.cos(a) * d, y: (focus.y ?? 0) - 2, z: focus.z + Math.sin(a) * d }); }
      }
      if (arc.visible && clock - L.start.value > L.duration) arc.visible = false;
      flash = Math.max(0, flash - dt * 3.5);
      U.flash.value = flash * flash * 0.9 * lightV;
    },
    dispose() { scene.remove(group); rain.geometry.dispose(); arc.geometry.dispose(); },
  };
}
