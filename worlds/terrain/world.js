// gf-three smooth terrain (worlds/terrain; a game's gf/three/world/terrain/): rounded ground that explosions carve.
// config/world.json → { template: 'terrain', terrain: {generator params}, materials: {...}, sea: {...}, spawns: n }
// (default.json is the shape; create writes it from the spec's world.params).
//
//   loadWorld(ctx, cfg)   generates the field (generate.mjs: islands in a sea, or a cliff shore; deterministic from the
//                         seed), meshes it on a worker (mesh-worker.js, surface nets in 8 m chunks), paints it with the
//                         top surface and the soil's cross-section (material.js), lays the sea, and gives every chunk a
//                         Rapier trimesh collider built from the same mesh (so bodies, shots and the camera meet exactly
//                         what is drawn). → ctx.world with the kit's world API (spawn, zone, bounds, raycast, update) plus
//                         world.terrain (below)
//   slotsFor(cfg)         the world's slots: the top and soil pictures, the land's shape, the sea level
//
// world.terrain:
//   apply(edit, {quiet})  apply one edit [op, x, y, z, r] (field.mjs EDIT; centimetres) on this copy: field, mesh,
//                         collider, the debris (none when quiet) and the edit listeners. → true when it changed the
//                         ground. editOf(op, {x, y, z}, r) makes one from metres. Who may edit
//                         and how edits travel is the carve mechanic's (components/carve): the host decides, every copy applies
//   carve(at, r) / add(at, r)   the same from metres ({x, y, z}); → the edit applied, or null
//   edits                 every edit that changed the ground since it was made (or reset), in order
//   onEdit(fn)            fn({edit, op: 'carve' | 'add' | 'settle', at: {x, y, z}, r, normal, fell}) after each edit
//                         (VFX, sounds, rules); a settle's fell is what dropped (field.mjs settled) or null
//   debris(at, r, opts)   throw lumps of ground (cosmetic; apply does it for a carve unless cfg.debris is false)
//   reset()               the ground as it was made (a new round); → a promise when every chunk is meshed again
//   sample(x, y, z), normal(x, y, z), solid(x, y, z), heightAt(x, z), surface(from, dir, max)  the field itself
//   ready()               a promise for the meshes in flight; stats() → {chunks, triangles, edits, remeshMs (an edit to
//                         its meshes in place), applyMs (the field, main thread), swapMs (a chunk's mesh and collider), ...}
// world.seaLevel          the sea's height (shots end on it: the projectile mechanic's floor is y = 0)
// world.groundAt / waterAt / isWalkable / reach / place / route / walk   ../placement.js over the chunks' colliders and the
//                         scenery's (where things may be put, what every seat reaches; the sea is water)
//
// A composed level (terrain.compose: worlds/terrain/compose.mjs, looks wave 4): the set pieces' models are loaded first,
// their triangles made ground with the land (piece.mjs), and each model is drawn where it stands, clipped where blasts
// took its ground (a small 3D picture of what the field lost round it, updated on every edit), while the field draws the
// cut faces. world.landmarks lists them for the camera (it leans toward one in view) and the look judge's sheet.
//
// Generator version terrain.generator (1): the same seed and version give the same ground forever; edits replay on it.
import * as THREE from 'three';
import { CHUNK, editOf, isEdit } from './field.mjs';
import { generateTerrain, paramsOf, spawnsOn, seatSpawns } from './generate.mjs';
import { meshChunk, origOf } from './mesh.mjs';
import { createTerrainMaterial, MATERIAL_DEFAULTS } from './material.js';
import { createDebris } from './debris.js';
import { material, adoptMaterials } from '../../look/materials.js';
import { WORLD_GROUPS } from '../../core/util.js';
import { addScenery, propSlots } from '../scenery.js';
import { openSea } from '../islands.js';
import { placeFor } from './places.mjs';
import { trianglesOf, joinTriangles } from './piece.mjs';
import { leanToward } from '../compose.mjs';
import { placeOnColliders, movementOf } from '../placement.js';
import { addPads } from '../pads.js';
import { reachConfig } from '../connect.mjs';

export const templates = ['terrain'];

/** Points every `step` m along a connector from its first end to its last ([[x, y, z], …] → [[x, z], …]). */
const alongOf = (ends, step) => {
  if (ends.length < 2) return ends.map(e => [e[0], e[2]]);
  const [a, b] = [ends[0], ends[ends.length - 1]], d = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(1, Math.ceil(d / step));
  return Array.from({ length: n + 1 }, (_, k) => [a[0] + (b[0] - a[0]) * k / n, a[2] + (b[2] - a[2]) * k / n]);
};

export function slotsFor(cfg, catalog = null, licences = null) {
  const M = cfg.materials ?? {};
  const out = [];
  const pic = (layer, label, words, rank) => {
    const L = M[layer] ?? {};
    if (!L.file) return;
    out.push({
      id: `world.terrain.${layer}`, label, group: 'world', type: 'image', facet: 'look', tier: 'main', rank,
      source: { file: L.file }, constraints: { colorSpace: 'srgb', formats: ['png', 'jpg', 'webp'], square: true, tile: true },
      description: `${words} A seamless square picture drawn every ${L.size ?? MATERIAL_DEFAULTS[layer].size} m (it repeats: its edges must meet).`,
      generate: { prompt: `a seamless square stylised ${words.toLowerCase()}`, style: 'painted cartoon texture, flat even light, no perspective, tileable' },
    });
  };
  pic('top', 'Ground top', 'The ground\'s top surface (grass, sand, candy...), seen from above.', 20);
  pic('soil', 'Ground soil', 'The ground cut open: a cross-section of soil in level layers with stones and roots in it, seen from the side.', 21);
  pic('cliff', 'Cliff faces', 'The land\'s own cliffs and tunnel walls: rock in level strata, seen from the side (what a blast cuts shows the soil).', 22);
  out.push(
    { id: 'world.terrain.shape', label: 'Land shape', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/terrain' }, description: 'The generated land: shape (islands or cliffs), seed, size, how high, how steep, overhangs and tunnels. Changing it changes the ground every edit is made on.' },
    { id: 'world.terrain.paint', label: 'Ground paint', group: 'world', type: 'json', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/materials' }, description: 'How the ground is painted: picture sizes, colours, the grass lip down the cliffs, the soil\'s layers, the ink line, sand by the sea.' },
    { id: 'world.terrain.sea', label: 'Sea', group: 'world', type: 'json', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/sea' }, description: 'The sea round the land: its level and how far it reaches.' },
  );
  // the scenery a look target asks for (worlds/scenery.js): its clouds and islands, and its props' models
  if (cfg.scenery) out.push({ id: 'world.terrain.scenery', label: 'Scenery', group: 'world', type: 'json', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/scenery' }, description: 'Round the land: cloud cover and style, islands out at sea, and the set dressing that stands on the ground (a blast takes what it undercuts).' });
  // a composed level's landmarks and bridges (worlds/terrain/compose.mjs): their models are the playfield's ground
  const pieces = composeIds(cfg);
  if (pieces.length) out.push({ id: 'world.terrain.compose', label: 'Level layout', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/terrain/compose' }, description: 'What the play happens on: the landmarks and bridges made part of the ground (players stand on them, blasts carve them), how play meets them (on, around, across, behind), how much of the view they fill, and the seats round them.' });
  const props = [...new Set([...(cfg.scenery?.props ?? []), ...pieces])];
  if (props.length) out.push(...propSlots({ props }, catalog, licences, { group: 'props' }).map(sl => (pieces.includes(sl.id.slice(5)) ? { ...sl, tier: 'main', description: `${sl.description} A landmark of the playfield: its shape is ground (a new model changes what players stand on).` } : sl)));
  return out;
}

/** A composed level's set piece ids (terrain.compose landmarks and bridges). */
export const composeIds = cfg => { const C = cfg?.terrain?.compose; return C ? [...new Set([...(C.landmarks ?? []), ...(C.bridges ?? [])])] : []; };

/** A model's triangles (metres, its own frame): every mesh's positions through its matrix, as piece.mjs takes them. */
function modelTriangles(model) {
  model.updateMatrixWorld(true);
  const list = [];
  model.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry, a = g.attributes.position, flat = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) { flat[i * 3] = a.getX(i); flat[i * 3 + 1] = a.getY(i); flat[i * 3 + 2] = a.getZ(i); }
    list.push(trianglesOf(flat, g.index ? g.index.array : null, o.matrixWorld.elements));
  });
  return joinTriangles(list);
}

/** A model's colour on average (its pictures' and its materials'), for the cut faces of a piece made from it. */
function averageColour(model) {
  const sum = new THREE.Color(0, 0, 0); let n = 0;
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  model.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      const c = (m.color ?? new THREE.Color(1, 1, 1)).clone();
      const img = m.map?.image;
      if (img && cv) {
        try {
          cv.width = cv.height = 8; const g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 8, 8); const d = g.getImageData(0, 0, 8, 8).data;
          let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
          c.multiply(new THREE.Color().setRGB(r / 64 / 255, gg / 64 / 255, b / 64 / 255, THREE.SRGBColorSpace));
        } catch { /* a picture the canvas cannot read: its material's colour */ }
      }
      sum.add(c); n++;
    }
  });
  return n ? sum.multiplyScalar(0.8 / n) : new THREE.Color('#9a8f80');
}

/** Start the mesh worker, or null where there is none (Node, an old browser): the meshes are then made here. */
function startWorker() {
  try { if (typeof Worker === 'undefined') return null; return new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { console.warn(`gf-three terrain: no mesh worker (${e.message}); meshing on the main thread`); return null; }
}

export async function loadWorld(ctx, cfg) {
  const t0 = performance.now();
  const P = paramsOf(cfg.terrain ?? {});
  const slotHas = id => { try { return !!ctx.assets?.has?.(id); } catch { return false; } };
  // a composed level: its set pieces' models first (their triangles become ground with the land)
  const pieceModels = new Map();
  let pieces = null;
  if (P.compose) {
    pieces = {};
    await Promise.all(composeIds(cfg).map(async id => {
      if (!slotHas(`prop.${id}`)) { console.warn(`gf-three terrain: the level's piece ${id} has no model slot; left out`); return; }
      try { const m = await ctx.assets.model(`prop.${id}`); pieceModels.set(id, m); pieces[id] = { tris: modelTriangles(m) }; }
      catch (e) { console.warn(`gf-three terrain: prop.${id}: ${e.message}; left out of the level`); }
    }));
  }
  // seats the config gives by hand (else the composer's pairs, the generator's pads, or places found after)
  const given = Array.isArray(cfg.spawns) ? cfg.spawns.map(s => ({ x: s[0], y: s[1], z: s[2] })) : null;
  // the connectors join every region worth going to (worlds/terrain/connect.mjs), planned with this game's own jump
  const gen = generateTerrain(P, { pieces, numbers: movementOf(ctx.config ?? {}), seats: given, players: ctx.config?.players?.max ?? 0, reach: cfg.reach });
  const field = gen.field, top = gen.info.top;
  // the ground as it was made (a new round's reset, a composed level's pieces' clipping): with its connectors
  const made = field.d.slice();
  for (const n of gen.info.compose?.notes ?? []) console.warn(`gf-three terrain compose: ${n}`);
  const genMs = Math.round(performance.now() - t0);
  const seaLevel = cfg.sea?.level ?? 0;
  const quality = ctx.quality?.name ?? ctx.quality ?? 'high';
  const root = new THREE.Group(); root.name = 'gf-terrain-world';
  ctx.scene?.add(root);

  // ---- the ground's paint: the house ground material, the top and soil pictures from their slots ----
  const M = { ...MATERIAL_DEFAULTS, ...(cfg.materials ?? {}) };
  if (M.cliff && !M.cliff.file && !M.cliff.color) M.cliff = null;
  const paint = createTerrainMaterial(M);
  await Promise.all(['top', 'soil', 'cliff'].map(async layer => {
    const id = `world.terrain.${layer}`;
    if (!slotHas(id)) return;
    try { paint.setTexture(layer, await ctx.assets.texture(id)); } catch (e) { console.warn(`gf-three terrain: ${id}: ${e.message}; drawn in its colour`); }
  }));
  const groundSlot = slotHas('world.terrain.top') ? 'world.terrain.top' : 'world.terrain.shape';

  // ---- the sea ----
  const seaSize = cfg.sea?.size ?? 700;
  const seaGeo = new THREE.PlaneGeometry(seaSize, seaSize, 1, 1); seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, material('water', { color: '#3b8fd8', transparent: true, opacity: 0.94 }));
  sea.name = 'sea'; sea.position.y = seaLevel; sea.receiveShadow = true; sea.renderOrder = 2;
  sea.userData.gfSlot = 'world.terrain.sea';
  // an open sea to the horizon when a look's scenery asks for one (worlds/islands.js openSea)
  if (cfg.scenery) openSea(sea.material);
  root.add(sea);

  // ---- physics: one fixed body, a trimesh collider per chunk ----
  const phys = ctx.physics?.createRigidBody ? ctx.physics : ctx.physics?.world;
  const RAPIER = ctx.RAPIER ?? ctx.physics?.RAPIER ?? null;
  const body = phys && RAPIER ? phys.createRigidBody(RAPIER.RigidBodyDesc.fixed()) : null;
  const triFlags = RAPIER?.TriMeshFlags?.FIX_INTERNAL_EDGES;
  const liveColliders = [], colliderSet = new Set();

  // ---- chunks: a mesh and a collider each, swapped whole when an edit re-meshes it ----
  const chunks = new Map();     // 'x,y,z' → { mesh, collider, tris }
  const remeshed = { on: null };  // a chunk's mesh and collider swapped in: the placement grid reads it again (set below)
  const stats = { chunks: 0, triangles: 0, edits: 0, remeshMs: 0, remeshMax: 0, applyMs: 0, applyMax: 0, swapMs: 0, swapMax: 0, jobs: 0, genMs, meshMs: 0, worker: false };
  function takeChunk(c, res) {
    const t0 = performance.now();
    swapChunk(c, res);
    const ms = performance.now() - t0;
    stats.swapMs = Math.round(ms * 100) / 100; stats.swapMax = Math.max(stats.swapMax, stats.swapMs);
  }
  function swapChunk(c, res) {
    const key = c.join(','), had = chunks.get(key);
    if (had) {
      root.remove(had.mesh); had.mesh.geometry.dispose();
      if (had.collider) { phys.removeCollider(had.collider, false); colliderSet.delete(had.collider); liveColliders.splice(liveColliders.indexOf(had.collider), 1); }
      stats.triangles -= had.tris; stats.chunks--;
      chunks.delete(key);
      const ob = had.mesh.geometry.boundingBox; if (ob) remeshed.on?.([ob.min.x - 1, ob.min.z - 1, ob.max.x + 1, ob.max.z + 1]);
    }
    if (!res.index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(res.normal, 3));
    g.setAttribute('aTer', new THREE.BufferAttribute(res.ter, 2));
    g.setAttribute('aOwn', new THREE.BufferAttribute(res.own ?? new Float32Array(res.position.length / 3), 1));
    g.setIndex(new THREE.BufferAttribute(res.index, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, paint.material);
    mesh.name = `terrain:${key}`; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.gfSlot = groundSlot;
    root.add(mesh);
    let collider = null;
    if (body) {
      const idx = res.index instanceof Uint32Array ? res.index : Uint32Array.from(res.index);
      const desc = triFlags !== undefined ? RAPIER.ColliderDesc.trimesh(res.position, idx, triFlags) : RAPIER.ColliderDesc.trimesh(res.position, idx);
      desc.setCollisionGroups(WORLD_GROUPS).setFriction(0.9);
      collider = phys.createCollider(desc, body);
      liveColliders.push(collider); colliderSet.add(collider);
    }
    const tris = res.index.length / 3;
    chunks.set(key, { mesh, collider, tris });
    const bb = g.boundingBox; remeshed.on?.([bb.min.x - 1, bb.min.z - 1, bb.max.x + 1, bb.max.z + 1]);
    stats.triangles += tris; stats.chunks++;
  }

  // ---- meshing: on the worker when there is one ----
  const worker = startWorker();
  // the main thread's own meshing (no worker) tells cut faces from the made ground by this copy of it
  const orig = worker ? null : origOf(field);
  const jobs = new Map();               // job → { done(), started }
  let jobN = 0;
  function run(msg, list = null) {
    const job = ++jobN, started = performance.now();
    stats.jobs++;
    return new Promise((done, fail) => {
      if (worker) { jobs.set(job, { done, fail, started, msg }); worker.postMessage({ ...msg, job }); return; }
      // no worker: here, now (the edits were applied to the main field already; the main field is the only one)
      const all = list ?? [];
      for (const c of all) takeChunk(c, meshChunk(field, c[0], c[1], c[2], { top, orig, own: gen.info.own ?? null }));
      finish(started, msg); done();
    });
  }
  function finish(started, msg) {
    const ms = performance.now() - started;
    if (msg.type === 'edit') { stats.remeshMs = Math.round(ms * 10) / 10; stats.remeshMax = Math.max(stats.remeshMax, stats.remeshMs); }
    else stats.meshMs = Math.round(ms);
  }
  if (worker) {
    stats.worker = true;
    worker.onmessage = ({ data: m }) => {
      const j = jobs.get(m.job);
      if (m.type === 'chunk') takeChunk(m.chunk, m.res);
      else if (m.type === 'done' && j) { jobs.delete(m.job); finish(j.started, j.msg); j.done(); }
      else if (m.type === 'error') { console.error(`gf-three terrain worker: ${m.error}`); if (j) { jobs.delete(m.job); j.fail(new Error(m.error)); } }
    };
    worker.onerror = e => console.error(`gf-three terrain worker: ${e.message}`);
    const copy = field.d.slice();
    worker.postMessage({ type: 'init', meta: { size: field.size, cell: field.cell, origin: field.origin }, data: copy, top: top.slice(), own: gen.info.own ?? null }, [copy.buffer]);
  }
  const everyChunk = () => { const out = []; for (let y = 0; y < field.cy; y++) for (let z = 0; z < field.cz; z++) for (let x = 0; x < field.cx; x++) out.push([x, y, z]); return out; };
  await run({ type: 'mesh' }, everyChunk());
  stats.swapMax = 0;                    // from here on: what an edit costs

  // ---- debris, edits ----
  const debrisOn = cfg.debris !== false;
  const debris = debrisOn ? createDebris(ctx, field, { color: M.soil?.color, top: M.top?.color, slot: slotHas('world.terrain.soil') ? 'world.terrain.soil' : 'world.terrain.shape', quality }) : null;
  if (debris) root.add(debris.mesh);
  const edits = [], listeners = [];
  const OPS = ['carve', 'add', 'settle'];
  const toMetres = e => ({ op: OPS[e[0]], at: { x: e[1] / 100, y: e[2] / 100, z: e[3] / 100 }, r: e[4] / 100 });
  function apply(e, { quiet = false } = {}) {
    if (!isEdit(e)) return false;
    const ta = performance.now();
    const box = field.apply(e);
    stats.applyMs = Math.round((performance.now() - ta) * 100) / 100; stats.applyMax = Math.max(stats.applyMax, stats.applyMs);
    if (!box) return false;
    edits.push(e.slice()); stats.edits = edits.length;
    const touched = field.chunksOf(box);
    run(worker ? { type: 'edit', edits: [e] } : { type: 'edit' }, touched).catch(err => console.error(err));
    const m = toMetres(e), normal = field.normal(m.at.x, m.at.y + m.r * 0.5, m.at.z);
    if (m.op === 'carve' && debris && !quiet) debris.burst(m.at, m.r, { normal });
    // a settle: the ground that let go crumbles where it was (cosmetic lumps falling from its samples)
    const fell = m.op === 'settle' ? field.settled : null;
    if (fell && debris && !quiet) debris.crumble(fell.points, { size: field.cell });
    for (const fn of listeners.slice()) try { fn({ edit: e.slice(), ...m, normal, fell }); } catch (err) { console.error(err); }
    return true;
  }
  async function reset() {
    // a composed level keeps the ground it made (its pieces' shapes are the models', loaded once)
    const fresh = { d: made.slice() };
    field.d.set(fresh.d);
    edits.length = 0; stats.edits = 0;
    landmarks?.refresh();
    if (worker) return run({ type: 'reset', data: fresh.d });
    return run({ type: 'mesh' }, everyChunk());
  }

  // ---- a composed level's pieces: their models where they stand, clipped where blasts took their ground ----
  const landmarks = gen.info.landmarks?.length ? drawPieces(root, field, made, gen.info.landmarks, pieceModels, paint) : null;
  if (landmarks) listeners.push(e => landmarks.edited(e));

  // ---- the play area, spawns, zones ----
  const b = field.bounds;
  let peak = seaLevel; for (const t of top) if (t > peak) peak = t;
  for (const L of gen.info.landmarks ?? []) peak = Math.max(peak, L.top);
  const box = new THREE.Box3(new THREE.Vector3(b.min[0], seaLevel, b.min[2]), new THREE.Vector3(b.max[0], peak + 6, b.max[2]));
  box.half = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
  if (ctx.look?.fitShadows) ctx.look.fitShadows(new THREE.Box3(new THREE.Vector3(b.min[0], P.floor, b.min[2]), new THREE.Vector3(b.max[0], peak + 2, b.max[2])));
  ctx.look?.setLamps?.([]);
  const nSpawns = Number.isInteger(cfg.spawns) ? cfg.spawns : 8;
  // the level pads the generator cut (params pads.count) are the seats' places when it cut them; else standing places
  // on the joined ground (the connectors' reach: never a pocket nobody else can get to)
  const reached = gen.info.reached ?? null;
  // (the generator's pads too: a pad on ground the connectors could not join is left out while enough others remain)
  const onJoined = (l, need) => {
    if (!reached) return l;
    const ok = l.filter(p => reached(p.x, p.y, p.z));
    // too few: standing places found on the joined ground make up the rest
    for (const p of ok.length < need ? spawnsOn(field, need * 4, P.seed) : []) { if (ok.length >= need) break; if (reached(p.x, p.y, p.z) && ok.every(q => Math.hypot(q.x - p.x, q.z - p.z) > 4)) ok.push(p); }
    return ok.length >= need ? ok : l;
  };
  const spawnList = given ?? (gen.info.pads?.length ? onJoined(gen.info.pads, Math.min(gen.info.pads.length, ctx.config?.players?.max ?? 2)) : onJoined(spawnsOn(field, nSpawns * 2, P.seed), 1));
  if (!spawnList.length) spawnList.push({ x: 0, y: Math.max(seaLevel, field.heightAt(0, 0) ?? 0) + 0.05, z: 0 });
  const mid = gen.info.islands.length ? gen.info.islands.reduce((a, i) => (Math.hypot(i.x, i.z) < Math.hypot(a.x, a.z) ? i : a)) : { x: 0, z: 0, r: 10 };
  // seats in pairs that see each other, each facing its partner (friends in sight from the first second); a composed
  // level's seats come paired and turned already (each partner and a landmark in the frame: compose.mjs)
  const composedSeats = !given && gen.info.landmarks && gen.info.pads?.length ? gen.info.pads.slice(0, nSpawns) : null;
  const spawns = (composedSeats ?? seatSpawns(field, spawnList, { count: given ? spawnList.length : nSpawns })).map(s => { const p = new THREE.Vector3(s.x, s.y, s.z); p.yaw = s.yaw; return p; });
  const zoneOf = (name, at, r) => ({
    name, shape: 'circle', at, size: [r],
    contains: p => (p.x - at.x) ** 2 + (p.z - at.z) ** 2 <= r * r,
    random(rr = Math.random) { const a = rr() * Math.PI * 2, d = Math.sqrt(rr()) * r; const x = at.x + Math.cos(a) * d, z = at.z + Math.sin(a) * d; return new THREE.Vector3(x, (field.heightAt(x, z) ?? seaLevel) + 0.05, z); },
  });
  const zones = { centre: zoneOf('centre', new THREE.Vector3(mid.x, field.heightAt(mid.x, mid.z) ?? seaLevel, mid.z), Math.max(4, (mid.r ?? 10) * 0.6)) };
  gen.info.islands.forEach((i, k) => { zones[`island-${k + 1}`] = zoneOf(`island-${k + 1}`, new THREE.Vector3(i.x, field.heightAt(i.x, i.z) ?? seaLevel, i.z), i.r * 0.8); });

  // the scenery round the land (worlds/scenery.js): clouds, islands out at sea, set dressing on the surface
  // (its props are solid on the world's body: tracked with the chunks' colliders, so raycasts and isWorld see them)
  const scenery = cfg.scenery ? await addScenery(ctx, root, cfg, {
    groundAt: (x, z) => field.heightAt(x, z), seaLevel, bounds: [b.min[0], b.min[2], b.max[0], b.max[2]], seats: spawns, sites: gen.info.sites ?? [], onEdit: fn => listeners.push(fn), seed: P.seed,
    // set dressing keeps off a composed level's pieces (never a crate on a castle's roof)
    // and off the place behind each composed seat where its camera stands (the first view is never a tree trunk)
    keepOut: [...(gen.info.landmarks ?? []).map(L => ({ x: (L.box.min[0] + L.box.max[0]) / 2, z: (L.box.min[2] + L.box.max[2]) / 2, r: Math.hypot(L.box.max[0] - L.box.min[0], L.box.max[2] - L.box.min[2]) / 2 + 1 })),
      // and off the connectors' ends and decks (a ruin never blocks a bridge or a ramp)
      ...(gen.info.connect?.list ?? []).flatMap(c => alongOf(c.ends ?? [], 2).map(([x, z]) => ({ x, z, r: 3 }))),
      ...(composedSeats ?? []).flatMap(s => [2.5, 5].map(d => ({ x: s.x - Math.sin(s.yaw) * d, z: s.z - Math.cos(s.yaw) * d, r: 2.4 })))],
    reachable: reached,
    physics: body ? { world: phys, RAPIER, body } : null,
    track: { add: c => { liveColliders.push(c); colliderSet.add(c); }, remove: c => { colliderSet.delete(c); const i = liveColliders.indexOf(c); if (i >= 0) liveColliders.splice(i, 1); } },
  }) : null;

  // launch pads (the connectors that throw a body across a gap no bridge fits: worlds/pads.js), in the look's colours
  const padPairs = (gen.info.connect?.list ?? []).filter(c => c.kind === 'pad' && c.pads?.length === 2).flatMap((c, k) => [{ id: `pad-${k + 1}a`, from: c.pads[0], to: c.pads[1] }, { id: `pad-${k + 1}b`, from: c.pads[1], to: c.pads[0] }]);
  const lookValues = ctx.look?.values ?? {};
  const pads = addPads(ctx, root, padPairs, { color: lookValues.palette?.accent ?? '#ff5fa2', base: M.cliff?.color ?? M.soil?.color ?? '#a89e5f', paint: g => adoptMaterials(g, 'prop'), slot: groundSlot });
  const R = reachConfig(cfg.reach);

  // the world's own ray for the place finders: a view blocked right in front of the camera (a set piece's wall, a tree)
  // (ground under the view is not in the way: a hit on a surface that faces up is passed)
  const rayClear = (from, dir, max) => { const h = world.raycast(new THREE.Vector3(...from), new THREE.Vector3(...dir), max); return h && !(h.normal && Math.abs(h.normal.y) > 0.7) ? h.distance : null; };
  const world = {
    template: 'terrain', layout: cfg, root, group: root, bounds: box, kind: 'outdoor', sizeClass: null, ceiling: null,
    rooms: [], doors: [], entries: [], lampPoints: [], props: scenery?.props ?? new Map(), catalog: { props: [] },
    seaLevel,
    /** A composed level's landmarks and bridges: {id, prop, role, centre, box, top} (the camera leans toward one in view). */
    landmarks: (gen.info.landmarks ?? []).map(({ id, prop, role, centre, box, top: t, at, yaw, scale }) => ({ id, prop, role, centre, box, top: t, at, yaw, scale })),
    /** How the camera leans toward a landmark in view (worlds/compose.mjs; the rig calls it). */
    lean: leanToward,
    /** The composer's report (where the seats stand, what each sees, the frame share planned). */
    composition: gen.info.compose ?? null,
    /** How many of each landmark's made ground samples blasts have taken ({id: n}), or null with none. */
    landmarkLoss: () => landmarks?.lost() ?? null,
    roomAt: () => null, via: () => null, entry: () => null,
    shapes: [{ kind: 'terrain', shape: 'trimesh', chunks: CHUNK, cell: field.cell, bounds: b }],
    colliders: body ? liveColliders : [],
    isWorld: c => colliderSet.has(c),
    spawn(i = 0) { const s = spawns[((i % spawns.length) + spawns.length) % spawns.length]; const p = s.clone(); p.yaw = s.yaw; return p; },
    spawns,
    zone(name) { return zones[name] ?? null; },
    zones,
    raycast(from, dir, max = 100) {
      const d = dir.clone().normalize();
      if (phys && RAPIER) {
        const hit = phys.castRayAndGetNormal(new RAPIER.Ray(from, d), max, true, undefined, undefined, undefined, undefined, c => colliderSet.has(c));
        if (!hit) return null;
        const t = hit.timeOfImpact ?? hit.toi;
        return { distance: t, point: new THREE.Vector3().copy(from).addScaledVector(d, t), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), collider: hit.collider };
      }
      const h = field.raycast([from.x, from.y, from.z], [d.x, d.y, d.z], max);
      return h ? { distance: h.distance, point: new THREE.Vector3(...h.point), normal: new THREE.Vector3(...h.normal) } : null;
    },
    /** A camera place that shows one kind of view (places.mjs: seat, day, cliff-edge, beach, sea-view) or null. */
    lookout: where => placeFor({ field, seaLevel, spawns, clear: rayClear }, where),
    update(dt) { debris?.update(dt); scenery?.update(dt); pads.update(dt); },
    /**
     * Close a cave nothing leads out of (the walk grid read from the colliders found one the generator's field did not:
     * worlds/pads.js joinWithPads): ground added over its places, made part of the ground as made (a new round keeps it),
     * on every copy alike before play (each copy reads the same colliders). places: [[x, y, z]] → the edits applied
     */
    close(places) {
      const done = new Set(), list = [];
      for (const [x, y, z] of places) {
        const k = `${Math.round(x)},${Math.round(y)},${Math.round(z)}`; if (done.has(k)) continue; done.add(k);
        // up to the cave's roof (a fill only to a body's height would leave a new floor under the same roof)
        for (const up of [0.8, 2.2, 3.6]) { const e = editOf('add', { x: Math.round(x), y: Math.round(y) + up, z: Math.round(z) }, 1.3); if (e && apply(e, { quiet: true })) list.push(e); }
      }
      // part of the ground as made, not of the round's edits (a reset keeps it; a late joiner closes it itself)
      made.set(field.d); edits.length = 0; stats.edits = 0;
      return list;
    },
    /** The connectors that join its areas (worlds/connect.mjs), the regions kept apart and why, the islands out at sea. */
    connectors: { list: gen.info.connect?.list ?? [], kept: gen.info.connect?.kept ?? [], left: gen.info.connect?.left ?? [], apart: R.apart, connect: R.connect, backdrop: scenery?.backdrop ?? [], pads: pads.observe },
    dispose() {
      worker?.terminate();
      for (const c of chunks.values()) { c.mesh.geometry.dispose(); if (c.collider) phys.removeCollider(c.collider, false); }
      chunks.clear(); ctx.scene?.remove(root); seaGeo.dispose(); debris?.mesh.dispose();
      if (body) phys.removeRigidBody(body);
    },
    terrain: {
      field, params: P, info: gen.info, edits,
      apply, editOf,
      carve: (at, r) => { const e = editOf('carve', at, r); return e && apply(e) ? e : null; },
      add: (at, r) => { const e = editOf('add', at, r); return e && apply(e) ? e : null; },
      /** Ground within r of `at` that no longer holds on to the rest falls (edit op 2, field.mjs settle). → the edit or null */
      settle: (at, r) => { const e = editOf('settle', at, r); return e && apply(e) ? e : null; },
      onEdit(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      debris: (at, r, opts) => debris?.burst(at, r, opts),
      reset,
      sample: (x, y, z) => field.sample(x, y, z),
      normal: (x, y, z) => field.normal(x, y, z),
      solid: (x, y, z) => field.solid(x, y, z),
      heightAt: (x, z) => field.heightAt(x, z),
      surface: (from, dir, max) => field.raycast(from, dir, max),
      ready: () => Promise.all([...jobs.values()].map(j => new Promise(ok => { const d = j.done; j.done = () => { d(); ok(); }; }))),
      stats: () => ({ ...stats, debris: debris?.count ?? 0, pending: jobs.size }),
    },
  };
  // where things may be put and what a seat can get to (../placement.js: groundAt, waterAt, isWalkable, reach, place,
  // route), from the very colliders bodies stand on; the sea is water, and a chunk the worker meshed again (a crater)
  // is read again where it changed
  placeOnColliders(world, ctx, { water: () => seaLevel, solid: c => colliderSet.has(c), links: pads.links });
  remeshed.on = box => world.walk?.invalidate(box);
  ctx.world = world;
  return world;
}

/**
 * A composed level's pieces drawn: each model where the composer stood it, in the house prop material, clipped by a
 * small 3D picture of the ground the field lost round it since it was made (a blast's crater: the field draws the cut
 * faces there, in the piece's inside colour). → {meshes, edited(e), refresh(), cut(owner) → the share of its samples lost}
 */
function drawPieces(root, field, made, list, models, paint) {
  const h = field.cell, O = field.origin, { nx, ny, nz } = field, DEG = Math.PI / 180, items = [];
  for (const L of list) {
    const src = models.get(L.prop); if (!src) continue;
    const obj = src.clone(true);
    obj.position.set(...L.at); obj.rotation.y = (L.yaw ?? 0) * DEG; obj.scale.set(...L.scale);
    obj.name = `landmark:${L.id}`;
    adoptMaterials(obj, 'prop');
    paint.setBuilt?.(L.owner, averageColour(src));
    // the samples round it: its box and two cells over
    const i0 = Math.max(0, Math.floor((L.box.min[0] - O[0]) / h) - 2), i1 = Math.min(nx - 1, Math.ceil((L.box.max[0] - O[0]) / h) + 2);
    const j0 = Math.max(0, Math.floor((L.box.min[1] - O[1]) / h) - 2), j1 = Math.min(ny - 1, Math.ceil((L.box.max[1] - O[1]) / h) + 2);
    const k0 = Math.max(0, Math.floor((L.box.min[2] - O[2]) / h) - 2), k1 = Math.min(nz - 1, Math.ceil((L.box.max[2] - O[2]) / h) + 2);
    const ni = i1 - i0 + 1, nj = j1 - j0 + 1, nk = k1 - k0 + 1;
    const data = new Uint8Array(ni * nj * nk);
    const tex = new THREE.Data3DTexture(data, ni, nj, nk);
    tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1; tex.needsUpdate = true;
    // texel (i, j, k) sits on sample (i0 + i, j0 + j, k0 + k): the picture spans half a cell past the outer samples
    const u = { uGfCut: { value: tex }, uGfCutMin: { value: new THREE.Vector3(O[0] + (i0 - 0.5) * h, O[1] + (j0 - 0.5) * h, O[2] + (k0 - 0.5) * h) }, uGfCutSize: { value: new THREE.Vector3(ni * h, nj * h, nk * h) }, uGfCutT: { value: 0.05 / CUT_RANGE } };
    const clipped = new Map();
    obj.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.userData.gfSlot = `prop.${L.prop}`; o.userData.gfLandmark = L.id;
      const one = m => {
        if (!m) return m;
        if (clipped.has(m)) return clipped.get(m);
        const c = m.clone(), prev = c.onBeforeCompile;
        c.onBeforeCompile = (sh, r) => {
          prev?.call(c, sh, r);
          Object.assign(sh.uniforms, u);
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGfCutW;')
            .replace('#include <project_vertex>', '#include <project_vertex>\n\tvGfCutW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGfCutW;\nuniform highp sampler3D uGfCut; uniform vec3 uGfCutMin; uniform vec3 uGfCutSize; uniform float uGfCutT;')
            .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n\t{ vec3 q = ( vGfCutW - uGfCutMin ) / uGfCutSize; if ( all( greaterThan( q, vec3( 0.0 ) ) ) && all( lessThan( q, vec3( 1.0 ) ) ) && texture( uGfCut, q ).r > uGfCutT ) discard; }');
        };
        const key = c.customProgramCacheKey?.() ?? '';
        c.customProgramCacheKey = () => `${key}|gf-cut`;
        clipped.set(m, c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
    root.add(obj);
    items.push({ L, obj, tex, data, i0, j0, k0, ni, nj, nk, lost: 0 });
  }
  // what the field lost round a piece since it was made, in metres (0 … CUT_RANGE) → its picture
  const fill = it => {
    const { data, i0, j0, k0, ni, nj, nk } = it, d = field.d;
    let lost = 0;
    for (let k = 0; k < nk; k++) for (let j = 0; j < nj; j++) {
      let g = ((j0 + j) * nz + (k0 + k)) * nx + i0, t = (k * nj + j) * ni;
      for (let i = 0; i < ni; i++, g++, t++) {
        const v = d[g] - made[g];
        data[t] = v <= 0 ? 0 : v >= CUT_RANGE ? 255 : Math.round(v / CUT_RANGE * 255);
        if (made[g] < 0 && d[g] >= 0) lost++;
      }
    }
    it.lost = lost; it.tex.needsUpdate = true;
  };
  for (const it of items) fill(it);
  return {
    meshes: items.map(it => it.obj),
    edited(e) {
      for (const it of items) {
        const b = it.L.box, r = e.r + h * 2;
        if (e.at.x + r < b.min[0] || e.at.x - r > b.max[0] || e.at.y + r < b.min[1] || e.at.y - r > b.max[1] || e.at.z + r < b.min[2] || e.at.z - r > b.max[2]) continue;
        fill(it);
      }
    },
    refresh() { for (const it of items) fill(it); },
    /** How many of a piece's made ground samples are gone (a landmark carved on every screen alike). */
    lost: () => Object.fromEntries(items.map(it => [it.L.id, it.lost])),
  };
}
/** Metres of lost ground a clip picture holds (its 255). */
const CUT_RANGE = 2;

