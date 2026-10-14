// gf-scenic world (CONTRACT §4.3 and §8): generated islands, isles, ruins and dungeons, drawn with folio-2025's terrain,
// grass, leaves, flowers and water (terrain.js, vegetation.js; MIT, brunosimon/folio-2025@41046b5, licence in
// research/gf-scenic/kit/LICENSE-folio-2025) and folio's props (research/gf-scenic/library/folio, MIT).
//
//   const world = await loadWorld(ctx, assets.config('world'));
//   world.spawn(i) → {x, y, z, yaw}   world.zone(name) → {shape, at, size, contains(p), random(rng)}
//   world.props → Map(id → [{prop, at, rot, scale, matrix, meshes, instance}])   world.raycast(from, dir, max)
//   world.bounds (THREE.Box3: the current level's play box), world.half, world.root, world.update(dt)
//   world.levels [{index, id, at, radius, half, last, spawns, zones}], world.level, world.setLevel(i) (CONTRACT §8)
//   world.entry(rng) a point at the edge of the current level's play box (where the waves mechanic brings enemies in)
//   world.via(from, to) the next point toward another room through its doorway (dungeon), else null
//   templates, worldConfig(spec, opts) (create, in Node), slotsFor(worldJson, catalog, licences), slots
//
// A scenic game sees gf-three's shared core as ../../three/ (gf/scenic beside gf/three; CONTRACT §8).
// Every visible mesh carries a gfSlot: world.<template>.* value slots for the generated ground, rock, water, leaves
// and flowers, prop.<id> for each model, look.glow.* for the crystals.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { collidersOf, buildColliders, dungeonPieces, MATERIALS } from '../../three/world/colliders.js';
import { HouseMaterial, U, adoptMaterials } from '../look/materials.js';
import { createTerrainData, terrainColors, floorMaterial, runeNode, topGeometry, boxTopGeometry, cliffGeometry, rockMaterial, waterSurfaceMaterial, fallGeometry, fallMaterial } from './terrain.js';
import { createGrass, createFoliage, createFlowers, leafRefs, pineRefs, towardCamera } from './vegetation.js';
import { outlineRadius, rngOf, roundRectSdf } from './generate.js';
export { templates, templateInfo, worldConfig, SIZE_RADIUS, generate, terrainData, levelCount, palettes } from './generate.js';

const FILE = 'config/world.json';
const DEG = Math.PI / 180;

// ---------- slots ----------
const COLOR_SLOTS = [
  [['ground', 'grass'], 'Grass colour', true], [['ground', 'grass2'], 'Grass colour, sunny patches', false], [['ground', 'dirt'], 'Earth colour', false],
  [['ground', 'path'], 'Path colour', false], [['ground', 'slabLow'], 'Paving, dark stones', false], [['ground', 'slabHigh'], 'Paving, light stones', true],
  [['ground', 'cliff'], 'Cliff rock colour', true], [['ground', 'cliff2'], 'Cliff rock, deep colour', false], [['ground', 'moss'], 'Moss colour', true],
  [['water', 'color'], 'Water colour', true], [['water', 'bed'], 'Deep water colour', false], [['water', 'foam'], 'Shore foam colour', false], [['water', 'fall'], 'Waterfall colour', true],
  [['water', 'sea'], 'Sea colour', true], [['stone'], 'Ruin stone colour', true], [['wood'], 'Pine trunk colour', false],
];
/** Slots for config/world.json (and the prop catalog, config/props.json): colours, leaves, flowers, textures, models. */
export function slotsFor(cfg = {}, catalog = null, licences = null) {
  const T = cfg.template ?? 'isles', out = [];
  const at = path => path.reduce((o, k) => o?.[k], cfg);
  const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  for (const [path, label, main] of COLOR_SLOTS) if (typeof at(path) === 'string') out.push({ id: `world.${T}.${path.map(kebab).join('.')}`, label, group: 'world', type: 'color', facet: 'look', tier: main ? 'main' : 'advanced', rank: main ? 70 : 10, source: { file: FILE, pointer: '/' + path.join('/') } });
  for (const [k, v] of Object.entries(cfg.foliage ?? {})) if (Array.isArray(v)) out.push({ id: `world.${T}.foliage.${k}`, label: `Leaves: ${k} (shade, sun)`, group: 'world', type: 'colors', facet: 'look', tier: k === 'oak' || k === 'pine' ? 'main' : 'advanced', rank: 60, source: { file: FILE, pointer: `/foliage/${k}` }, constraints: { min: 2, max: 2 } });
  if (Array.isArray(cfg.flowers)) out.push({ id: `world.${T}.flowers`, label: 'Flower colours', group: 'world', type: 'colors', facet: 'look', tier: 'advanced', rank: 30, source: { file: FILE, pointer: '/flowers' }, constraints: { min: 1, max: 6 } });
  for (const k of ['density', 'height', 'width']) if (typeof cfg.grass?.[k] === 'number') out.push({ id: `world.${T}.grass.${k}`, label: `Grass ${k}`, group: 'world', type: 'number', facet: 'look', tier: k === 'height' ? 'main' : 'advanced', rank: 20, source: { file: FILE, pointer: `/grass/${k}` }, constraints: { min: 0, max: k === 'height' ? 2 : 1 } });
  if (typeof cfg.runes === 'boolean') out.push({ id: `world.${T}.runes`, label: 'Glowing rune lines on the plaza', group: 'world', type: 'boolean', facet: 'look', tier: 'advanced', rank: 25, source: { file: FILE, pointer: '/runes' } });
  if (typeof cfg.water?.depth === 'number') out.push({ id: `world.${T}.water.depth`, label: 'Water depth (m)', group: 'world', type: 'number', facet: 'look', tier: 'advanced', rank: 5, source: { file: FILE, pointer: '/water/depth' }, constraints: { min: 0, max: 3 } });
  const folio = { spdx: 'MIT', author: 'Bruno Simon (folio-2025)', url: 'https://github.com/brunosimon/folio-2025/blob/41046b57eeed8d156d9c3fd7fa259900baef7816/license.md' };
  if (cfg.ground?.slabs?.file) out.push({ id: `world.${T}.ground.slabs`, label: 'Paving pattern', group: 'world', type: 'image', facet: 'look', tier: 'advanced', rank: 25, source: { file: cfg.ground.slabs.file }, constraints: { tile: true, colorSpace: 'linear', formats: ['png', 'jpg', 'webp'], tileMetres: cfg.ground.slabs.size ?? 5.7 }, license: folio, description: 'A seamless greyscale stone pattern (light stones, dark joints) mixed between the two paving colours.' });
  if (cfg.foliage?.texture) out.push({ id: `world.${T}.foliage.texture`, label: 'Leaf shape', group: 'world', type: 'image', facet: 'look', tier: 'advanced', rank: 5, source: { file: cfg.foliage.texture }, constraints: { colorSpace: 'linear', formats: ['png'] }, license: folio, description: 'A white-on-black distance field of one leaf (folio-2025): the leaf clusters cut their shape from it.' });
  out.push({ id: `world.${T}.layout`, label: 'Levels and their layout', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', rank: 5, source: { file: FILE, pointer: '/levels' }, description: 'Each level: where it is, its island shape, plaza, paths, water, spawns and zones (arena, portal)' });
  out.push({ id: `world.${T}.props`, label: 'Placed props', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', rank: 5, source: { file: FILE, pointer: '/props' } });
  if (cfg.fixtures?.length) out.push({ id: `world.${T}.fixtures`, label: 'Wall fixtures (torches, banners)', group: 'world', type: 'json', facet: 'look', tier: 'advanced', rank: 5, source: { file: FILE, pointer: '/fixtures' } });
  out.push({ id: `world.${T}.vegetation`, label: 'Trees, bushes and flowers', group: 'world', type: 'json', facet: 'look', tier: 'advanced', rank: 5, source: { file: FILE, pointer: '/vegetation' } });
  const lic = licences ?? null;
  for (const p of catalog?.props ?? []) out.push({
    id: `prop.${p.id}`, label: p.describe ? p.describe.replace(/^an? /, '').replace(/^./, c => c.toUpperCase()) : p.id, group: 'props', type: 'model', facet: 'look', tier: 'advanced', rank: 12,
    source: { file: `assets/models/${p.id}.glb` }, constraints: { scale: 1, ...(p.size ? { size: p.size } : {}) },
    description: `A scenic prop. Metres, Y up, base at y=0, centred${/^tree-/.test(p.id) ? '; meshes named treeLeaves* become leaf clusters' : ''}.`,
    generate: { prompt: p.describe ?? p.id, style: 'stylised low-poly, soft painterly colours, game-ready' },
    license: p.license ?? folio,
  });
  return out;
}
export const slots = slotsFor({ template: 'isles', ground: { grass: '#3f6b33', cliff: '#575064', moss: '#4f7f38' }, water: { color: '#2b7d99', fall: '#a5ecff' }, foliage: { oak: ['#3b6a33', '#6e9e40'] } });

// ---------- helpers ----------
const v3 = a => new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);
function matrixOf(at, rotDeg = 0, scale = 1) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rotDeg ?? 0) * DEG);
  const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : v3(scale);
  return new THREE.Matrix4().compose(v3(at), q, s);
}

async function catalogOf(ctx) {
  try { const c = ctx.assets.config('props'); if (c?.props) return c; } catch { /* none */ }
  return { props: [] };
}

// ---------- loadWorld ----------
export async function loadWorld(ctx, cfg = {}) {
  const { scene, assets } = ctx;
  const W = ctx.physics, RAPIER = ctx.RAPIER;
  const T = cfg.template ?? 'isles';
  const slot = (...p) => `world.${T}.${p.join('.')}`;
  const root = new THREE.Group(); root.name = `gf-scenic-world-${T}`; scene.add(root);
  const fixed = W.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const colliders = [];
  // the colliders are built at the end, from one list (kit/world/colliders.js, open builder wave 10): the islands' tops
  // and rims, the dungeons' floors and walls, the props whose models loaded, trees, crystals, the ruins' structures
  const loaded = new Set();
  const tex = async (id, linear = false) => { try { const t = await assets.texture(id); if (t && linear) { t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; } return t; } catch (e) { console.warn(`gf-scenic world: ${id}: ${e.message}`); return null; } };
  const look = ctx.look ?? null;
  const rngW = rngOf((cfg.seed ?? 1) ^ 0x5eed);
  const lamps = [];
  const toward = towardCamera(ctx);
  const levelCfgs = cfg.levels?.length ? cfg.levels : [];
  // the local player's place on screen: tree leaves between the camera and them fade (folio's see-through)
  const seeThroughU = { position: uniform(new THREE.Vector2(-9, -9)), min: uniform(0.1), max: uniform(0.4) };

  // ---- terrain data, colours, textures ----
  const TD = createTerrainData(cfg);
  const C = terrainColors(cfg);
  const [slabs, sdf] = await Promise.all([cfg.ground?.slabs?.file ? tex(slot('ground', 'slabs'), true) : null, cfg.foliage?.texture ? tex(slot('foliage', 'texture'), true) : null]);
  if (sdf) { sdf.wrapS = sdf.wrapT = THREE.ClampToEdgeWrapping; }
  const floorMat = floorMaterial(TD, C, slabs, cfg.water?.depth ?? 0.45, cfg.runes ? runeNode(levelCfgs, true) : null);
  const rockMat = rockMaterial();
  const rockColors = { cliff: cfg.ground?.cliff ?? '#575064', cliff2: cfg.ground?.cliff2 ?? '#3c3647', moss: cfg.ground?.moss ?? '#4f7f38' };
  look?.setBounce?.(cfg.ground?.grass ?? '#4f7d3e');

  // ---- each level: its top, its rock, its water and falls (its ground and rim colliders come from the list) ----
  const waterMat = waterSurfaceMaterial(TD, C);
  for (const lv of levelCfgs) {
    const [cx, cy, cz] = lv.at;
    const isl = !lv.box;
    if (!lv.tiles) {
      const top = new THREE.Mesh(isl ? topGeometry(lv) : boxTopGeometry(lv), floorMat);
      top.name = `ground-${lv.id}`; top.position.set(cx, cy, cz); top.receiveShadow = true;
      top.userData.gfSlot = slot('ground', 'grass');
      root.add(top);
    }
    const shape = isl ? lv.shape : { radius: Math.hypot(lv.box[2] - lv.box[0], lv.box[3] - lv.box[1]) / 2 * 0.74, n: 8, rot: 0, wobble: [] };
    const cliff = new THREE.Mesh(cliffGeometry(shape, { depth: lv.cliff?.depth ?? 16, seed: (cfg.seed ?? 1) + lv.at[0] * 7, kind: lv.cliff?.kind ?? 'float', colors: rockColors, cap: !isl, capColor: isl ? null : rockColors.cliff2 }), rockMat);
    cliff.name = `cliff-${lv.id}`; cliff.position.set(cx, cy - (isl ? 0.02 : 0.06), cz); cliff.castShadow = true; cliff.receiveShadow = true;
    cliff.userData.gfSlot = slot('ground', 'cliff');
    root.add(cliff);
    // water over the ponds and streams (the floor carries its colour; this draws the shore and the ripples)
    for (const w of lv.water ?? []) {
      const pts = [w.pond.at, ...w.stream.points];
      const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]), pad = w.pond.radius + 2;
      const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ).rotateX(-Math.PI / 2), waterMat);
      plane.position.set((minX + maxX) / 2, cy - 0.04, (minZ + maxZ) / 2); plane.renderOrder = 1; plane.receiveShadow = true;
      plane.name = `water-${lv.id}`; plane.userData.gfSlot = slot('water', 'color'); plane.userData.gfNoOcclude = true;
      root.add(plane);
    }
    for (const f of lv.falls ?? []) {
      const fall = new THREE.Mesh(fallGeometry(f), fallMaterial(cfg.water?.fall ?? '#a5ecff'));
      fall.position.set(f.at[0], f.at[1], f.at[2]); fall.renderOrder = 2; fall.name = `waterfall-${lv.id}`;
      fall.userData.gfSlot = slot('water', 'fall'); fall.userData.gfNoOcclude = true;
      root.add(fall);
      lamps.push({ position: new THREE.Vector3(f.at[0], f.at[1] + 0.3, f.at[2]), color: cfg.water?.fall ?? '#a5ecff', radius: 0.55, intensity: 0.6 });
    }
    if (!isl) buildDungeon(lv);
  }
  // the sea round an island (the island template)
  if (cfg.water?.sea && !cfg.void) {
    const sea = new THREE.Mesh(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2), new HouseMaterial({ color: cfg.water.sea, flags: { coreShadows: false, bounce: false } }, 'water'));
    sea.position.y = cfg.water.seaLevel ?? -0.55; sea.receiveShadow = true; sea.name = 'sea';
    sea.userData.gfSlot = slot('water', 'sea'); sea.userData.gfNoOcclude = true;
    root.add(sea);
  }

  // ---- dungeon rooms: walls with doorways and the corridors' sides (their colliders and the floors' come from the list) ----
  function buildDungeon(lv) {
    if (lv.tiles) return;   // KayKit modules bring their own walls
    const { walls } = dungeonPieces(lv);
    const H = lv.wall?.height ?? 3.2, th = lv.wall?.thickness ?? 0.6;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new HouseMaterial({ color: cfg.stone ?? '#6d6679', flatShading: true }, 'prop');
    const mesh = new THREE.InstancedMesh(geo, mat, walls.length);
    // a diorama cutaway: walls on the camera's side of their room (the follow camera looks along +x+z) stand low
    const camSide = ([ax, az, bx, bz]) => {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const rm = lv.rooms.find(r => mx >= r.rect[0] - 0.5 && mx <= r.rect[2] + 0.5 && mz >= r.rect[1] - 0.5 && mz <= r.rect[3] + 0.5);
      if (!rm) return false;
      return (az === bz && Math.abs(az - rm.rect[1]) < 0.3) || (ax === bx && Math.abs(ax - rm.rect[0]) < 0.3);
    };
    walls.forEach((w, i) => {
      const [ax, az, bx, bz] = w;
      const len = Math.hypot(bx - ax, bz - az) + th, yaw = Math.atan2(bz - az, bx - ax), h = camSide(w) ? Math.min(H, 0.9) : H;
      mesh.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, 0, (az + bz) / 2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), new THREE.Vector3(len, h, th)));
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = `walls-${lv.id}`;
    mesh.userData.gfSlot = slot('stone');
    root.add(mesh);
  }

  // ---- grass ----
  const grassDensity = Math.max(0, Math.min(1, (cfg.grass?.density ?? 1) * (look?.tier?.grassDensity ?? 1)));
  const grass = grassDensity > 0.05 && levelCfgs.some(l => !l.box) ? createGrass(TD, C, { subdivisions: Math.round(256 * Math.sqrt(grassDensity)), height: cfg.grass?.height ?? 0.55, width: cfg.grass?.width ?? 0.1, slot: slot('ground', 'grass') }) : null;
  if (grass) root.add(grass.mesh);

  // ---- the prop catalog: models, instanced per part, colliders, light points ----
  const catalog = await catalogOf(ctx);
  const byId = new Map(catalog.props.map(p => [p.id, p]));
  const models = new Map();
  const modelOf = async id => {
    if (!models.has(id)) models.set(id, (async () => { try { return await assets.model(`prop.${id}`); } catch (e) { console.warn(`gf-scenic world: prop.${id}: ${e.message}`); return null; } })());
    return models.get(id);
  };
  const propsMap = new Map();
  function instance(model, mats, id, opts = {}) {
    adoptMaterials(model, 'prop');
    model.updateMatrixWorld(true);
    const parts = [];
    model.traverse(o => { if (o.isMesh && o.visible !== false && !(opts.skip?.(o))) parts.push(o); });
    const meshes = [];
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, mats.length);
      mats.forEach((m, k) => im.setMatrixAt(k, m.clone().multiply(part.matrixWorld)));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
      im.castShadow = !part.material?.userData?.gfGlow; im.receiveShadow = true;
      im.name = `prop:${id}`; im.userData.gfSlot = `prop.${id}`; im.userData.gfProp = id;
      root.add(im); meshes.push(im);
    }
    return meshes;
  }
  const groups = new Map();
  // props stand on the ground; fixtures hang on a wall (torches, banners): drawn the same way
  for (const p of [...(cfg.props ?? []), ...(cfg.fixtures ?? [])]) { if (!groups.has(p.prop)) groups.set(p.prop, []); groups.get(p.prop).push(p); }
  await Promise.all([...groups.entries()].map(async ([id, list]) => {
    const meta = byId.get(id), model = await modelOf(id);
    if (!model) return;
    loaded.add(id);
    const mats = list.map(p => matrixOf(p.at, p.rot, (p.scale ?? 1)));
    // a part on a hinge (KayKit's doorway door, chest lid): open it when the layout says so
    if (list.some(p => p.open)) for (const part of Object.values(meta?.parts ?? {})) {
      const node = model.getObjectByName(part.node);
      if (!node) continue;
      const h = new THREE.Vector3(...part.hinge), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...part.axis).normalize(), (part.open ?? 90) * DEG);
      node.updateMatrix();
      node.matrix.premultiply(new THREE.Matrix4().makeTranslation(-h.x, -h.y, -h.z)).premultiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).premultiply(new THREE.Matrix4().makeTranslation(h.x, h.y, h.z));
      node.matrix.decompose(node.position, node.quaternion, node.scale);
    }
    const meshes = instance(model, mats, id);
    propsMap.set(id, list.map((p, k) => ({ ...p, matrix: mats[k], meshes, instance: k })));
    list.forEach((p, k) => {
      if (meta?.light) lamps.push({ position: new THREE.Vector3(...meta.light.at).applyMatrix4(mats[k]), color: meta.light.color ?? 'lantern', radius: meta.light.radius ?? 1, intensity: 1 });
    });
  }));

  // ---- trees: folio's tree bodies, their leaf spheres turned into leaf clusters; pines are stacked clusters ----
  const foliage = [];
  const treeGroups = new Map();
  for (const t of cfg.vegetation?.trees ?? []) { if (!treeGroups.has(t.kind)) treeGroups.set(t.kind, []); treeGroups.get(t.kind).push(t); }
  const trunkGeo = new THREE.CylinderGeometry(0.09, 0.26, 8, 6, 1).translate(0, 4, 0);
  const trunkMat = new HouseMaterial({ color: cfg.wood ?? '#5e4334', flatShading: true }, 'prop');
  const pineTrunks = mats => {
    const im = new THREE.InstancedMesh(trunkGeo, trunkMat, mats.length);
    mats.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = true; im.receiveShadow = true;
    im.name = 'pine-trunks'; im.userData.gfSlot = slot('wood');
    root.add(im);
  };
  await Promise.all([...treeGroups.entries()].map(async ([kind, list]) => {
    const id = `tree-${kind}`;
    const model = kind === 'pine' ? null : await modelOf(id);
    if (!model && kind !== 'pine') return;
    if (model) loaded.add(id);
    const refs = kind === 'pine' ? null : leafRefs(model);
    const mats = list.map(t => matrixOf(t.at, t.rot, kind === 'pine' ? [t.scale, t.scale * 0.9, t.scale] : t.scale));
    if (kind === 'pine') pineTrunks(mats);
    else instance(model, mats, id, { skip: o => /^treeLeaves/.test(o.name) });
    const leaves = [];
    const rr = rngOf((cfg.seed ?? 1) + kind.length * 101);
    list.forEach((t, k) => {
      const local = kind === 'pine' ? pineRefs(8.5, rr) : refs.length ? refs : [];
      for (const r of local) leaves.push({ position: r.position.clone().applyMatrix4(mats[k]), scale: r.scale * (kind === 'pine' ? t.scale * 0.95 : t.scale) * 1.05 });
    });
    if (leaves.length && sdf) {
      const f = createFoliage(leaves, { sdf, colors: cfg.foliage?.[kind] ?? cfg.foliage?.oak, toward, seeThrough: seeThroughU, slot: slot('foliage', kind), name: `leaves-${kind}`, seed: kind.length * 17 });
      root.add(f.mesh); foliage.push(f);
    }
  }));
  // bushes
  if (sdf && cfg.vegetation?.bushes?.length) {
    const f = createFoliage(cfg.vegetation.bushes.map(b => ({ position: new THREE.Vector3(b[0], b[1], b[2]), scale: b[3] })), { sdf, colors: cfg.foliage?.bush ?? cfg.foliage?.oak, toward, slot: slot('foliage', 'bush'), name: 'bushes', seed: 77 });
    root.add(f.mesh); foliage.push(f);
  }
  // flowers
  if (cfg.vegetation?.flowers?.length) for (const m of createFlowers(cfg.vegetation.flowers, { colors: cfg.flowers, slot: slot('flowers') })) root.add(m);

  // ---- crystals: glowing shard clusters (kit primitives whose colour is the look's glow slot) ----
  const glow = look?.values?.glow ?? { crystal: '#a07cff', rune: '#62ffa6', intensity: 2.2 };
  const shard = new THREE.OctahedronGeometry(0.5, 0).scale(0.42, 1.6, 0.42).translate(0, 0.62, 0);
  const crystalMats = {};
  const crystalMat = role => crystalMats[role] ??= (() => { const c = glow[role] ?? '#a07cff'; const m = new HouseMaterial({ color: c, emissive: c, emissiveIntensity: (glow.intensity ?? 2) * 0.32, flatShading: true }, 'prop'); m.userData.glowRole = role; return m; })();
  const shards = { crystal: [], rune: [] };
  const addCluster = (at, scale, role, seed) => {
    const r = rngOf(seed), n = 3 + Math.floor(r() * 3), base = new THREE.Vector3(...at);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = k ? 0.25 + r() * 0.35 : 0, tilt = k ? 0.25 + r() * 0.35 : 0.05;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * tilt, r() * Math.PI, -Math.cos(a) * tilt));
      const s = scale * (k ? 0.45 + r() * 0.4 : 1);
      shards[role].push(new THREE.Matrix4().compose(base.clone().add(new THREE.Vector3(Math.cos(a) * d * scale, 0, Math.sin(a) * d * scale)), q, new THREE.Vector3(s, s, s)));
    }
    lamps.push({ position: base.clone().add(new THREE.Vector3(0, 0.9 * scale, 0)), color: role, radius: 0.75 * scale + 0.2, intensity: 1.1 });
  };
  for (const c of cfg.crystals ?? []) { addCluster(c.at, c.scale ?? 1, c.glow === 'rune' ? 'rune' : 'crystal', Math.round((c.at[0] + 31) * (c.at[2] + 17) * 13)); }

  // ---- islets and loose rocks floating round the islands ----
  for (const isl of cfg.islets ?? []) {
    const shape = { radius: isl.radius, n: 2.6, rot: 0, wobble: [[3, 0.08, isl.seed % 6], [5, 0.05, (isl.seed >> 3) % 6]] };
    const m = new THREE.Mesh(cliffGeometry(shape, { depth: isl.depth, seed: isl.seed, kind: 'float', colors: rockColors, segments: 24, rows: 6, cap: true }), rockMat);
    m.position.set(...isl.at); m.castShadow = true; m.receiveShadow = true; m.name = 'islet';
    m.userData.gfSlot = slot('ground', 'cliff');
    root.add(m);
    if (isl.crystal) addCluster([isl.at[0], isl.at[1], isl.at[2]], Math.min(1.2, isl.radius * 0.55), isl.crystal, isl.seed);
  }
  // islet trees join their kind's instancing in a second pass (kept simple: a lone pine or oak per islet)
  const isletTrees = (cfg.islets ?? []).filter(i => i.tree);
  if (isletTrees.length && sdf) {
    const mats = isletTrees.map(i => matrixOf([i.at[0], i.at[1] + 0.25, i.at[2]], i.seed % 360, [0.5, 0.45, 0.5]));
    pineTrunks(mats);
    const leaves = [], rr = rngOf(4242);
    isletTrees.forEach((i, k) => { for (const r of pineRefs(8.5, rr)) leaves.push({ position: r.position.clone().applyMatrix4(mats[k]), scale: r.scale * 0.5 }); });
    const f = createFoliage(leaves, { sdf, colors: cfg.foliage?.pine, toward, slot: slot('foliage', 'pine'), name: 'leaves-islets', seed: 99 });
    root.add(f.mesh); foliage.push(f);
  }
  if (sdf && cfg.islets?.length) {
    const rr = rngOf(5151), bush = [];
    for (const i of cfg.islets) { const n = 1 + Math.floor(rr() * 3); for (let k = 0; k < n; k++) { const a = rr() * Math.PI * 2, d = i.radius * (0.45 + rr() * 0.4); bush.push({ position: new THREE.Vector3(i.at[0] + Math.cos(a) * d, i.at[1] + 0.35, i.at[2] + Math.sin(a) * d), scale: 0.6 + rr() * 0.5 }); } }
    const f = createFoliage(bush, { sdf, colors: cfg.foliage?.bush ?? cfg.foliage?.oak, toward, slot: slot('foliage', 'bush'), name: 'bushes-islets', seed: 61 });
    root.add(f.mesh); foliage.push(f);
  }
  for (const role of ['crystal', 'rune']) {
    if (!shards[role].length) continue;
    const im = new THREE.InstancedMesh(shard, crystalMat(role), shards[role].length);
    shards[role].forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
    im.castShadow = true; im.receiveShadow = true; im.name = `crystals-${role}`;
    im.userData.gfSlot = `look.glow.${role}`;
    root.add(im);
  }
  const boulder = new THREE.DodecahedronGeometry(1, 0);
  {
    const pos = boulder.attributes.position, col = [], cr = new THREE.Color(rockColors.cliff), cd = new THREE.Color(rockColors.cliff2), cm = new THREE.Color(rockColors.moss), cc = new THREE.Color();
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); cc.copy(cr).lerp(cd, y < 0 ? 0.6 : 0.15); if (y > 0.55) cc.lerp(cm, 0.65); col.push(cc.r, cc.g, cc.b); }
    boulder.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  const rim = [];
  for (const lv of levelCfgs) {
    if (lv.box) continue;
    const rr = rngOf((cfg.seed ?? 1) + Math.round(lv.at[0] * 13 + lv.at[2] * 7));
    const [cx, cy, cz] = lv.at;
    let a = 0;
    while (a < Math.PI * 2) {
      const r = outlineRadius(lv.shape, a), big = rr() < 0.18, s = big ? 1.3 + rr() * 0.9 : 0.45 + rr() * 0.75;
      if (rr() < 0.82) rim.push(new THREE.Matrix4().compose(new THREE.Vector3(cx + Math.cos(a) * (r - 0.25 - s * 0.2), cy - 0.25 + s * 0.15, cz + Math.sin(a) * (r - 0.25 - s * 0.2)), new THREE.Quaternion().setFromEuler(new THREE.Euler(rr() * 0.6, rr() * 6.28, rr() * 0.6)), new THREE.Vector3(s * (1 + rr() * 0.5), s * (0.6 + rr() * 0.3), s * (1 + rr() * 0.5))));
      a += (1.4 + rr() * 1.6) / Math.max(4, r);
    }
  }
  if (rim.length) {
    const im = new THREE.InstancedMesh(boulder, rockMat, rim.length);
    rim.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = true; im.receiveShadow = true; im.name = 'rim-rocks';
    im.userData.gfSlot = slot('ground', 'cliff');
    root.add(im);
  }
  if (cfg.floaters?.length) {
    const g = boulder;
    const im = new THREE.InstancedMesh(g, rockMat, cfg.floaters.length);
    cfg.floaters.forEach((f, k) => im.setMatrixAt(k, new THREE.Matrix4().compose(v3(f.at), new THREE.Quaternion().setFromEuler(new THREE.Euler(f.rot * DEG * 0.3, f.rot * DEG, 0)), new THREE.Vector3(f.scale, f.scale * 1.3, f.scale))));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = true; im.receiveShadow = true; im.name = 'floating-rocks';
    im.userData.gfSlot = slot('ground', 'cliff');
    root.add(im);
  }

  // ---- ruins: broken pillars and wall stubs (kit primitives in the ruin stone colour) ----
  if (cfg.structures?.length) {
    const stone = new HouseMaterial({ color: cfg.stone ?? '#6d6679', flatShading: true }, 'prop');
    for (const s of cfg.structures) {
      let geo;
      if (s.kind === 'pillar') {
        const shaft = new THREE.CylinderGeometry(s.radius * 0.86, s.radius, s.height, 8, 3).translate(0, s.height / 2 + 0.3, 0);
        const plinth = new THREE.BoxGeometry(s.radius * 2.6, 0.3, s.radius * 2.6).translate(0, 0.15, 0);
        geo = new THREE.Group(); geo.add(new THREE.Mesh(shaft, stone), new THREE.Mesh(plinth, stone));
      } else {
        geo = new THREE.Group(); geo.add(new THREE.Mesh(new THREE.BoxGeometry(s.length, s.height, 0.7).translate(0, s.height / 2, 0), stone));
      }
      geo.position.set(...s.at); geo.rotation.y = (s.rot ?? 0) * DEG; geo.name = s.kind;
      geo.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.gfSlot = slot('stone'); } });
      root.add(geo);
    }
  }
  // ---- physics: the one collider list, on the world's fixed body ----
  colliders.push(...buildColliders(RAPIER, W, collidersOf(cfg, catalog, { has: id => loaded.has(id) }), MATERIALS.scenic, fixed));
  look?.setLamps?.(lamps);

  // ---- spawns, zones, levels (CONTRACT §8) ----
  const facing = (x, z, cx = 0, cz = 0) => Math.atan2(cx - x, cz - z);
  const zoneOf = (name, z) => {
    const at = z.at ?? [0, 0, 0], sz = [].concat(z.size ?? 2);
    return {
      name, shape: z.shape ?? 'circle', at, size: sz,
      contains: p => (z.shape === 'box' ? Math.abs(p.x - at[0]) <= sz[0] / 2 && Math.abs(p.z - at[2]) <= (sz[2] ?? sz[0]) / 2 : Math.hypot(p.x - at[0], p.z - at[2]) <= sz[0]),
      random: rng => { if (z.shape === 'box') return { x: at[0] + (rng() - 0.5) * sz[0], y: at[1], z: at[2] + (rng() - 0.5) * (sz[2] ?? sz[0]) }; const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * sz[0]; return { x: at[0] + Math.cos(a) * r, y: at[1], z: at[2] + Math.sin(a) * r }; },
    };
  };
  const zones = {};
  for (const [name, z] of Object.entries(cfg.zones ?? {})) zones[name] = zoneOf(name, z);
  const levels = levelCfgs.map((lv, i) => {
    const [cx, , cz] = lv.at;
    return {
      index: i, id: lv.id, at: lv.at, radius: lv.radius, half: lv.half, last: !!lv.last,
      spawns: (lv.spawns ?? [[cx, 0, cz]]).map(([x, y, z]) => ({ x, y, z, yaw: facing(x, z, cx, cz) })),
      zones: Object.fromEntries(Object.entries(lv.zones ?? {}).map(([n, z]) => [n, zoneOf(n, z)])),
      rooms: lv.rooms ?? null,
    };
  });
  const spawns = (cfg.spawns ?? levels[0]?.spawns.map(s => [s.x, s.y, s.z]) ?? [[0, 0, 0]]).map(([x, y, z]) => ({ x, y, z, yaw: facing(x, z, levelCfgs[0]?.at[0] ?? 0, levelCfgs[0]?.at[2] ?? 0) }));
  let level = 0;
  const bounds = new THREE.Box3();
  const setBounds = () => {
    const lv = levelCfgs[level];
    if (!lv) { bounds.set(new THREE.Vector3(-15, 0, -15), new THREE.Vector3(15, 6, 15)); bounds.half = 15; return; }
    if (lv.box) bounds.set(new THREE.Vector3(lv.box[0] + 0.8, 0, lv.box[1] + 0.8), new THREE.Vector3(lv.box[2] - 0.8, 6, lv.box[3] - 0.8));
    else bounds.set(new THREE.Vector3(lv.at[0] - lv.half, 0, lv.at[2] - lv.half), new THREE.Vector3(lv.at[0] + lv.half, 6, lv.at[2] + lv.half));
    bounds.half = lv.half;
  };
  setBounds();

  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const isWorld = c => c.parent()?.handle === fixed.handle;
  const sp = new THREE.Vector3();
  const world = {
    template: T, kind: cfg.kind ?? T, root, group: root, colliders, props: propsMap, spawns, zones, levels, bounds,
    get half() { return bounds.half; }, get radius() { return levelCfgs[level]?.radius ?? 15; },
    spawn: i => { const s = levels[level]?.spawns?.length ? levels[level].spawns : spawns; return s[((i % s.length) + s.length) % s.length]; },
    zone: name => levels[level]?.zones?.[name] ?? zones[name] ?? null,
    get level() { return level; },
    /** Make level i the current one (spawns, zones, bounds follow it). → the level */
    setLevel(i) { level = Math.max(0, Math.min(levels.length - 1, i | 0)); setBounds(); return levels[level]; },
    /** A point just inside the current level's play box edge (enemies come in from the island's edge). */
    entry(rng) {
      const b = bounds, side = Math.floor(rng() * 4), u = rng();
      const x = side < 2 ? b.min.x + 1 + u * (b.max.x - b.min.x - 2) : side === 2 ? b.min.x + 1 : b.max.x - 1;
      const z = side >= 2 ? b.min.z + 1 + u * (b.max.z - b.min.z - 2) : side === 0 ? b.min.z + 1 : b.max.z - 1;
      return { x, y: 0, z };
    },
    /** dungeon rooms: the doorway to head for when the goal is in another room, else null */
    via(from, to) {
      const lv = levelCfgs[level]; if (!lv?.rooms) return null;
      const roomAt = p => lv.rooms.find(r => p.x >= r.rect[0] && p.x <= r.rect[2] && p.z >= r.rect[1] && p.z <= r.rect[3]) ?? null;
      const a = roomAt(from), b = roomAt(to);
      if (!a || !b || a === b) return null;
      const d = (lv.doors ?? []).find(x => x.rooms.includes(a.id) && x.rooms.includes(b.id)) ?? (lv.doors ?? []).find(x => x.rooms.includes(a.id));
      if (!d) return null;
      const other = d.rooms[0] === a.id ? d.to : d.from;
      return { x: other[0], y: 0, z: other[1] };
    },
    raycast(from, dir, max = 100) {
      ray.origin = { x: from.x, y: from.y, z: from.z }; ray.dir = { x: dir.x, y: dir.y, z: dir.z };
      const hit = W.castRayAndGetNormal(ray, max, true, undefined, undefined, undefined, undefined, isWorld);
      if (!hit) return null;
      const t = hit.timeOfImpact ?? hit.toi;
      return { point: { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t }, distance: t, normal: hit.normal, collider: hit.collider };
    },
    update() {
      const f = look?.focus;
      if (grass && f) grass.update(f, look.viewRadius ?? 20);
      if (seeThroughU) {
        const me = ctx.me?.position, cam = look?.activeCamera ?? ctx.camera;
        // only for the game's own camera (a contact-sheet shot or a close-up keeps every leaf)
        if (me && cam && cam === ctx.camera && ctx.round?.phase !== 'lobby') {
          sp.set(me.x, me.y + 1, me.z).project(cam);
          seeThroughU.position.value.set(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
          const dist = cam.position.distanceTo(sp.set(me.x, me.y + 1, me.z));
          seeThroughU.min.value = 2.2 / dist; seeThroughU.max.value = 8 / dist;
        } else { seeThroughU.position.value.set(-9, -9); }
      }
    },
  };
  return world;
}
