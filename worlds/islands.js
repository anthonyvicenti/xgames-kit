// The sea-islands world's land, sea and clouds (looks wave 2, 2026-10-14): what world.js draws for a layout with
// `islands` (sea.js lays them out). Kit primitives, each a slot:
//   the island tops     the house ground material (world.<t>.ground.color / .color2 / .pattern), a polar grid that
//                       follows the island's outline, its hills and the lip where it rounds over
//   the cliffs          the ground cut open from the lip down to the sea: a strata texture (world.<t>.cliffs.pattern,
//                       the soil's cross-section) over vertex-coloured bands (world.<t>.cliffs.color), with ledges
//   the beaches         a sand collar at the cliff's foot sloping into the water (world.<t>.ground.beach)
//   the sea             one disc of the house water material to the horizon (look.materials.water.*)
//   the clouds          rounded puffs (or flat painted cards) in one instanced mesh, unfogged, drifting slowly
// The terrain stream's destructible ground replaces the tops and cliffs when it lands; it reads the same island list.
import * as THREE from 'three';
import { material } from '../look/materials.js';
import { edgeOf, topOf } from './sea.js';

const TAU = Math.PI * 2;
const NA = 160;                         // segments round an island
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

/**
 * An open sea's water: its own colour to the horizon (a painted sea is blue to the line; fogged it reads as sky) and at
 * a grazing angle (a mirror-smooth sea far off reflects only the pale sky near the horizon). Changes `mat` in place.
 */
export function openSea(mat) {
  mat.fog = false; mat.roughness = 0.45; mat.envMapIntensity = 0.3; mat.needsUpdate = true;
  return mat;
}

/** One island of scenery (no play on it) into `root`: its top, its cliff and its beach. → the meshes */
export function drawIsland(root, isl, seaY, { groundMat, cliffMat, beachMat, strata, tile = 5, segments = 96, slot = null }) {
  const out = [new THREE.Mesh(topGeometry(isl, segments), groundMat), new THREE.Mesh(cliffGeometry(isl, seaY, strata, { tile, segments }), cliffMat)];
  if (isl.beach > 0.2) out.push(new THREE.Mesh(beachGeometry(isl, seaY, segments), beachMat));
  out.forEach((m, i) => { m.name = `${['island', 'cliff', 'beach'][i]}-${isl.id}`; m.receiveShadow = true; if (slot) m.userData.gfSlot = slot; root.add(m); });
  return out;
}

/** One island's top: rings from its middle out to its edge, at the ground's height (hills, the lip). */
export function topGeometry(isl, segments) {
  const NR = isl.play ? 30 : 14, pos = [], idx = [];
  const [cx, , cz] = isl.at;
  pos.push(cx, topOf(isl, cx, cz), cz);
  for (let i = 1; i <= NR; i++) {
    const f = 1 - (1 - i / NR) ** 1.6;                              // denser toward the edge, where the lip curves
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * TAU, r = edgeOf(isl, a) * f;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      pos.push(x, topOf(isl, x, z), z);
    }
  }
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 1; i < NR; i++) for (let j = 0; j < segments; j++) {
    const a = 1 + (i - 1) * segments + j, b = 1 + (i - 1) * segments + ((j + 1) % segments), c = a + segments, d = b + segments;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/**
 * One island's cliff: from its top's edge down to the sea (and a little under it), each ring a little further out or in
 * (a ledge per terrace, a rough face), with strata bands in vertex colour and a texture's uv in metres.
 */
export function cliffGeometry(isl, seaY, strata, { tile = 4, segments = NA } = {}) {
  const [cx, , cz] = isl.at;
  const edgeY = j => { const a = (j / segments) * TAU, r = edgeOf(isl, a); return topOf(isl, cx + Math.cos(a) * r, cz + Math.sin(a) * r); };
  const top = Array.from({ length: segments }, (_, j) => edgeY(j));
  const foot = seaY + (isl.beach > 0 ? 0.35 : -0.4);
  // the profile: [t from top (0) to foot (1), how far out (m)]; a terrace is a step in, then a short slope out
  const prof = [[0, 0], [0.04, 0.12]];
  const nT = Math.max(0, Math.round(isl.terraces ?? 0));
  for (let k = 1; k <= nT; k++) { const t = k / (nT + 1); prof.push([t - 0.06, 0.3], [t - 0.02, -0.55], [t + 0.02, -0.6], [t + 0.07, 0.05]); }
  prof.push([0.9, 0.35], [1, 0.55]);
  const rows = [...prof, [1.25, 0.2], [1.6, -1.5]];                // under the foot: into the sea
  const pos = [], col = [], uv = [], idx = [];
  const bands = strata.map(h => new THREE.Color(h));
  const cOf = y => { const k = ((Math.floor((y - seaY) / 0.9) % bands.length) + bands.length) % bands.length; return bands[k]; };
  for (const [ri, [t, out]] of rows.entries()) {
    let arc = 0, px = null, pz = null;
    for (let j = 0; j <= segments; j++) {
      const jj = j % segments, a = (j / segments) * TAU, y0 = top[jj];
      const y = t <= 1 ? y0 + (foot - y0) * t : foot + (seaY - 3 - foot) * (t - 1) / 0.6;
      const rough = (hash(jj * 0.37, ri) - 0.5) * 0.45 * (t > 0.03 && t < 1 ? 1 : 0.3);
      const r = edgeOf(isl, a) + out + rough;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (px !== null) arc += Math.hypot(x - px, z - pz);
      px = x; pz = z;
      pos.push(x, y, z);
      const c = cOf(y).clone().multiplyScalar(0.9 + hash(jj, ri * 3.1) * 0.2);
      if (t >= 1) c.multiplyScalar(0.7);                            // under the foot: wet and dark
      col.push(c.r, c.g, c.b);
      uv.push(arc / tile, y / tile);
    }
  }
  const W = segments + 1;
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < segments; j++) {
    const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** A beach: a sand collar from the cliff's foot out `width` metres, sloping under the water. */
export function beachGeometry(isl, seaY, segments = NA) {
  const [cx, , cz] = isl.at, pos = [], idx = [];
  const rings = [[0.3, 0.35], [0.6, 0.3], [1, 0.12], [1.35, -0.6]];  // [fraction of the width out, height over the sea]
  for (const [f, h] of rings) for (let j = 0; j < segments; j++) {
    const a = (j / segments) * TAU, r = edgeOf(isl, a) + 0.4 + isl.beach * f * (0.75 + 0.5 * hash(j * 0.21, 7));
    pos.push(cx + Math.cos(a) * r, seaY + h, cz + Math.sin(a) * r);
  }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < segments; j++) {
    const a = i * segments + j, b = i * segments + ((j + 1) % segments), c = a + segments, d = b + segments;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** The clouds: every puff of every cloud as one instanced mesh. Cards are puffs flattened toward the middle. */
export function cloudMesh(clouds, { color = '#f4f7ff', style = 'puff' } = {}) {
  const puffs = [];
  for (const c of clouds) {
    let s = c.seed;
    const R = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const toward = Math.atan2(-c.at[2], -c.at[0]);
    for (let k = 0; k < c.puffs; k++) {
      const u = (k / Math.max(1, c.puffs - 1)) - 0.5, mid = 1 - Math.abs(u) * 1.2;
      const r = c.size * (0.22 + 0.2 * mid + R() * 0.12);
      const along = u * c.size * 1.3, up = (R() * 0.35 + mid * 0.25) * c.size * 0.5, deep = (R() - 0.5) * c.size * 0.35;
      // laid out across the line of sight from the middle of the world, so each reads as a wide mass
      const ax = -Math.sin(toward), az = Math.cos(toward);
      puffs.push({ x: c.at[0] + ax * along + Math.cos(toward) * deep, y: c.at[1] + up, z: c.at[2] + az * along + Math.sin(toward) * deep, r, flat: c.flat, toward });
    }
  }
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const mat = material('prop', { color, emissive: color, emissiveIntensity: 0.38, roughness: 1 });
  mat.fog = false;
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, puffs.length));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  puffs.forEach((pf, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -pf.toward);
    sc.set(style === 'card' ? pf.r * 0.25 : pf.r, pf.r * pf.flat * 1.4, pf.r);
    m.compose(p.set(pf.x, pf.y, pf.z), q, sc); mesh.setMatrixAt(i, m);
  });
  mesh.count = puffs.length;
  mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
  mesh.name = 'clouds';
  return mesh;
}

/**
 * The sea-islands land, sea and clouds into `root`. groundMat: the island tops' house ground material (made by
 * world.js with the layout's ground colours and pattern); cliffTexture: the strata picture (a texture slot), or null.
 * → {ground (the play island's top, named 'ground'), meshes, update(dt)}
 */
export function drawIslands(root, cfg, { groundMat, cliffTexture = null, template }) {
  const seaY = cfg.sea?.level ?? -4, C = cfg.cliffs ?? {};
  const strata = C.strata?.length ? C.strata : [C.color ?? '#c8925a'];
  const tile = C.pattern?.size ?? 5;
  const cliffMat = material('prop', { color: cliffTexture ? '#ffffff' : '#ffffff', map: cliffTexture, vertexColors: true, roughness: 0.95 });
  const beachMat = material('ground', { color: cfg.ground?.beach ?? '#ecd193', color2: cfg.ground?.beach2 ?? cfg.ground?.beach ?? '#e2c483' });
  const meshes = [];
  let ground = null;
  for (const isl of cfg.islands ?? []) {
    const top = new THREE.Mesh(topGeometry(isl, isl.play ? NA : 96), groundMat);
    top.name = isl.play ? 'ground' : `island-${isl.id}`; top.receiveShadow = true; top.castShadow = !isl.play;
    top.userData.gfSlot = `world.${template}.ground.color`;
    const cliff = new THREE.Mesh(cliffGeometry(isl, seaY, strata, { tile, segments: isl.play ? NA : 96 }), cliffMat);
    cliff.name = `cliff-${isl.id}`; cliff.receiveShadow = true; cliff.castShadow = isl.play;
    cliff.userData.gfSlot = `world.${template}.cliffs.${cliffTexture ? 'pattern' : 'color'}`;
    root.add(top, cliff); meshes.push(top, cliff);
    if (isl.beach > 0.2) {
      const beach = new THREE.Mesh(beachGeometry(isl, seaY, isl.play ? NA : 96), beachMat);
      beach.name = `beach-${isl.id}`; beach.receiveShadow = true;
      beach.userData.gfSlot = `world.${template}.ground.beach`;
      root.add(beach); meshes.push(beach);
    }
    if (isl.play) ground = top;
  }
  const seaGeo = new THREE.CircleGeometry(cfg.sea?.radius ?? 900, 96);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, openSea(material('water', {})));
  sea.name = 'sea'; sea.position.y = seaY; sea.receiveShadow = true;
  sea.userData.gfSlot = 'look.materials.water.deep';
  root.add(sea); meshes.push(sea);
  const list = cfg.sky?.clouds?.list ?? [];
  let clouds = null;
  if (list.length && cfg.sky.clouds.style !== 'none') {
    clouds = cloudMesh(list, { color: cfg.sky.clouds.color, style: cfg.sky.clouds.style });
    clouds.userData.gfSlot = `world.${template}.clouds.color`;
    root.add(clouds); meshes.push(clouds);
  }
  return {
    ground, meshes,
    // the clouds turn slowly round the middle (a still frame between steps stays still: dt is the game's)
    update(dt) { if (clouds) clouds.rotation.y += dt * 0.004; },
  };
}
