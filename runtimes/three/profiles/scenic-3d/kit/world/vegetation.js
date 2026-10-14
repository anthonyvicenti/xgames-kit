// gf-scenic vegetation: grass blades in the wind, leaf clusters (trees, bushes, pines) and flowers.
//
//   Ported from brunosimon/folio-2025@41046b5 src/Game/World/Grass.js, Foliage.js, Bushes.js, Trees.js and
//   Flowers.js (MIT, Copyright (c) 2025 Bruno Simon; licence in research/gf-scenic/kit/LICENSE-folio-2025).
//   gf-scenic: placed from the generated layout (config/world.json vegetation) instead of folio's Blender reference
//   files; folio's seeded alea became the world's seeded rng; the grass patch follows the look's view focus and sizes
//   itself to the view; the leaf see-through fade follows the local player instead of the car; pines (cone stacks of
//   leaf clusters) and per-kind leaf colours (world.<t>.foliage.* slots) are new. Every mesh is slot-tagged.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, uniformArray, mix, mod, step, varying, vertexIndex, attribute, modelWorldMatrix,
  cameraPosition, atan, rotateUV, uv, texture, normalWorld, positionWorld, positionLocal, screenUV, screenSize, smoothstep, max,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HouseMaterial, U, windOffset } from '../look/materials.js';
import { rngOf } from './generate.js';

const DEG = Math.PI / 180;

// ---------- grass (folio Grass.js) ----------
export function createGrass(T, C, { subdivisions = 256, height = 0.55, width = 0.1, slot }) {
  const count = subdivisions * subdivisions;
  const size = uniform(40), center = uniform(new THREE.Vector2());
  const bladeWidth = uniform(width), bladeHeight = uniform(height), randomness = uniform(0.6);
  function geometry(sz) {
    const rnd = rngOf(1234);
    const frag = sz / subdivisions;
    const pos = new Float32Array(count * 6), hr = new Float32Array(count * 3);
    for (let ix = 0; ix < subdivisions; ix++) for (let iz = 0; iz < subdivisions; iz++) {
      const i = ix * subdivisions + iz;
      const x = (ix / subdivisions - 0.5) * sz + frag * 0.5 + (rnd() - 0.5) * frag, z = (iz / subdivisions - 0.5) * sz + frag * 0.5 + (rnd() - 0.5) * frag;
      pos.set([x, z, x, z, x, z], i * 6);
      hr[i * 3] = rnd(); hr[i * 3 + 1] = rnd(); hr[i * 3 + 2] = rnd();
    }
    const g = new THREE.BufferGeometry();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 2));
    g.setAttribute('heightRandomness', new THREE.Float32BufferAttribute(hr, 1));
    return g;
  }
  const loopIndex = varying(vertexIndex.toFloat().mod(3));
  const tipness = varying(step(loopIndex, 0.5));
  const bladePosition = varying(vec2());
  const shape = uniformArray([0, 1, 1, 0, -1, 0]);
  const data = T.terrainNode(bladePosition);
  const grassAmount = data.g;
  const hidden = step(data.g.sub(0.35), 0.1);
  const m = new HouseMaterial({
    colorNode: C.colorNode(data, bladePosition), normalNode: vec3(0, 1, 0), shadowNode: tipness.oneMinus().mul(grassAmount).mul(0.85),
    flags: { bounce: false, coreShadows: false },
  }, 'foliage');
  m.positionNode = Fn(() => {
    const position = attribute('position');
    const loop = position.sub(center).toVar();
    const half = size.mul(0.5);
    loop.x.assign(mod(loop.x.add(half), size).sub(half));
    loop.y.assign(mod(loop.y.add(half), size).sub(half));
    const p3 = vec3(loop.x, 0, loop.y).add(vec3(center.x, 0, center.y));
    const world = modelWorldMatrix.mul(vec4(p3, 1));
    bladePosition.assign(world.xz);
    const vary = U.perlin.sample(bladePosition.mul(0.0321)).r.add(0.5);
    const h = bladeHeight.mul(randomness.mul(attribute('heightRandomness')).add(randomness.oneMinus())).mul(vary).mul(grassAmount);
    const s = vec3(shape.element(loopIndex.mul(2)).mul(bladeWidth).mul(grassAmount), shape.element(loopIndex.mul(2).add(1)).mul(h), 0);
    const v = p3.add(s).toVar();
    const toCam = atan(world.z.sub(cameraPosition.z), world.x.sub(cameraPosition.x)).add(-Math.PI * 0.5);
    v.xz.assign(rotateUV(v.xz, toCam, world.xz));
    const wind = windOffset(world.xz).mul(tipness).mul(h).mul(2);
    v.addAssign(vec3(wind.x, 0, wind.y));
    v.y.addAssign(hidden.mul(100));
    return v;
  })();
  let current = 40, geo = geometry(current);
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'grass'; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
  mesh.userData.gfSlot = slot; mesh.userData.gfNoOcclude = true;
  const base = { width, height };
  return {
    mesh,
    /** follow the view: centre on the focus, size the patch to what the camera sees (folio's optimal area) */
    update(focus, viewRadius) {
      const want = Math.min(90, Math.max(28, Math.ceil(viewRadius * 2.2 / 4) * 4));
      if (want !== current) { current = want; geo.dispose(); geo = geometry(current); mesh.geometry = geo; }
      size.value = current; center.value.set(focus.x, focus.z);
      const overflow = Math.max(0, current * current - 1600) / 1600;
      bladeWidth.value = base.width * (1 + overflow * 0.4); bladeHeight.value = base.height * (1 + overflow * 0.25);
    },
    set(v = {}) { if (v.height) base.height = v.height; if (v.width) base.width = v.width; },
  };
}

// ---------- leaf clusters (folio Foliage.js) ----------
let clusterGeo = null;
function clusterGeometry() {
  if (clusterGeo) return clusterGeo;
  const rng = rngOf(0xf011a6e);
  const planes = [];
  for (let i = 0; i < 80; i++) {
    const plane = new THREE.PlaneGeometry(0.8, 0.8);
    const sph = new THREE.Spherical(1 - Math.pow(rng(), 3), Math.PI * 2 * rng(), Math.PI * rng());
    const p = new THREE.Vector3().setFromSpherical(sph);
    plane.rotateZ(rng() * 9999);
    plane.translate(p.x, p.y, p.z);
    const n = p.clone().normalize(), na = new Float32Array(12);
    for (let k = 0; k < 4; k++) { const v = new THREE.Vector3().fromBufferAttribute(plane.attributes.position, k).lerp(n, 0.85); na.set([v.x, v.y, v.z], k * 3); }
    plane.setAttribute('normal', new THREE.BufferAttribute(na, 3));
    planes.push(plane);
  }
  clusterGeo = mergeGeometries(planes);
  return clusterGeo;
}

/**
 * Leaf clusters at the given transforms ([{position, scale}]), facing the camera's usual direction with a random roll
 * (folio), coloured from colorA (shade side) to colorB (sun side), cut out by the leaf texture moving in the wind.
 * seeThrough: fade near the local player's screen position (trees between the camera and the player).
 */
export function createFoliage(refs, { sdf, colors, toward, seeThrough = null, slot, name = 'foliage', seed = 1 }) {
  const rng = rngOf(seed);
  const colorA = uniform(new THREE.Color(colors?.[0] ?? '#3b6a33')), colorB = uniform(new THREE.Color(colors?.[1] ?? '#6e9e40'));
  const threshold = uniform(0.3), shadowOffset = uniform(1);
  const sdfNode = texture(sdf);
  const alphaNode = Fn(() => {
    const ruv = rotateUV(uv(), windOffset(positionLocal.xz).length().mul(2.2), vec2(0.5));
    let a = sdfNode.sample(ruv).r;
    if (seeThrough) {
      const to = screenUV.sub(seeThrough.position).mul(vec2(screenSize.x.div(screenSize.y), 1));
      const fade = smoothstep(seeThrough.min, seeThrough.max, to.length());
      a = a.mul(fade.mul(threshold.oneMinus()).add(threshold));
    }
    return a.sub(threshold);
  })();
  const colorNode = Fn(() => mix(colorA, colorB, normalWorld.dot(U.lightDir).smoothstep(0, 1)))();
  const m = new HouseMaterial({ colorNode, alphaNode, alphaTest: 0, side: THREE.DoubleSide, flags: {} }, 'foliage');
  m.receivedShadowPositionNode = positionWorld.add(U.lightDir.mul(shadowOffset));
  m.maskShadowNode = sdfNode.r.greaterThan(0.5);
  const mesh = new THREE.InstancedMesh(clusterGeometry(), m, Math.max(1, refs.length));
  mesh.count = refs.length;
  const o = new THREE.Object3D();
  refs.forEach((r, i) => {
    const angle = Math.PI * 2 * rng();
    o.up.set(Math.sin(angle), Math.cos(angle), 0);
    o.position.set(0, 0, 0); o.lookAt(toward);
    o.position.copy(r.position); o.scale.setScalar(r.scale);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.gfSlot = slot;
  return { mesh, colorA, colorB, threshold, setColors(c) { colorA.value.set(c[0]); colorB.value.set(c[1]); } };
}

/** The leaf cluster spheres of a folio tree model: its treeLeaves* nodes, in the model's frame. → [{position, scale}] */
export function leafRefs(model) {
  const out = [];
  model.updateMatrixWorld(true);
  model.traverse(o => { if (/^treeLeaves/.test(o.name)) { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); o.matrixWorld.decompose(p, q, s); out.push({ position: p, scale: s.x }); o.visible = false; } });
  return out;
}

/** A pine's leaf clusters: a stack of rings that narrows to the top (in the tree's frame, height h). */
export function pineRefs(h = 7, rng = Math.random) {
  const out = [];
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const y = 1.6 + (t / (tiers - 1)) * (h - 2.2), r = (1 - t / tiers) * 1.55 + 0.25, n = Math.max(1, Math.round(5 - t * 0.7));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + t * 0.7 + rng() * 0.4;
      out.push({ position: new THREE.Vector3(Math.cos(a) * r * (n > 1 ? 0.7 : 0), y + rng() * 0.3, Math.sin(a) * r * (n > 1 ? 0.7 : 0)), scale: (1 - t / tiers) * 0.95 + 0.4 });
    }
  }
  out.push({ position: new THREE.Vector3(0, h - 0.3, 0), scale: 0.42 });
  return out;
}

// ---------- flowers (folio Flowers.js) ----------
export function createFlowers(spots, { colors, slot, seed = 3 }) {
  const rng = rngOf(seed);
  const planes = [];
  for (let i = 0; i < 8; i++) {
    const plane = new THREE.PlaneGeometry(0.08, 0.08);
    const sph = new THREE.Spherical(1, Math.PI * 0.2 * rng(), Math.PI * 2 * rng());
    const dir = new THREE.Vector3().setFromSpherical(sph);
    const p = dir.clone().setLength(1 + (rng() - 0.5) * 0.5); p.y -= 0.75;
    const mx = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)).setPosition(p);
    mx.scale(new THREE.Vector3().setScalar(1 + (rng() - 0.5)));
    plane.applyMatrix4(mx);
    planes.push(plane);
  }
  const geo = mergeGeometries(planes); geo.deleteAttribute('uv');
  const mats = (colors?.length ? colors : ['#ffffff']).map(c => {
    const m = new HouseMaterial({ color: c, side: THREE.DoubleSide, flags: { bounce: false } }, 'foliage');
    m.receivedShadowPositionNode = positionWorld.add(U.lightDir.mul(0.25));
    const wind = windOffset(positionLocal.xz);
    m.positionNode = positionLocal.add(vec3(wind.x, 0, wind.y).mul(positionLocal.y.clamp(0, 1)));
    return m;
  });
  const groups = mats.map(() => []);
  const o = new THREE.Object3D();
  for (const s of spots) {
    const n = 3 + Math.floor(rng() * 8);
    for (let j = 0; j < n; j++) {
      o.rotation.set(0, Math.PI * 2 * rng(), 0);
      o.position.set(s[0] + (rng() - 0.5) * 2.4, s[1] + 0.4, s[2] + (rng() - 0.5) * 2.4);
      o.scale.setScalar((0.6 + rng() * 0.4) * (s[3] ?? 1) * 0.55);
      o.updateMatrix();
      groups[Math.floor(rng() * mats.length)].push(o.matrix.clone());
    }
  }
  return mats.map((m, k) => {
    const mesh = new THREE.InstancedMesh(geo, m, Math.max(1, groups[k].length));
    mesh.count = groups[k].length;
    groups[k].forEach((mx, i) => mesh.setMatrixAt(i, mx));
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    mesh.name = `flowers-${k}`; mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.userData.gfSlot = slot;
    return mesh;
  });
}

/** The direction toward the follow camera (folio's view spherical offset): yaw and pitch from config/game.json. */
export function towardCamera(ctx) {
  const f = ctx.config?.controller?.camera?.follow ?? ctx.config?.controller?.camera ?? {};
  const yaw = (f.yawDeg ?? 45) * DEG, pitch = (f.pitchDeg ?? 41) * DEG;
  return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
}
