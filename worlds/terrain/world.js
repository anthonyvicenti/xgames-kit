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
//   onEdit(fn)            fn({edit, op: 'carve' | 'add', at: {x, y, z}, r, normal}) after each edit (VFX, sounds, rules)
//   debris(at, r, opts)   throw lumps of ground (cosmetic; apply does it for a carve unless cfg.debris is false)
//   reset()               the ground as it was made (a new round); → a promise when every chunk is meshed again
//   sample(x, y, z), normal(x, y, z), solid(x, y, z), heightAt(x, z), surface(from, dir, max)  the field itself
//   ready()               a promise for the meshes in flight; stats() → {chunks, triangles, edits, remeshMs (an edit to
//                         its meshes in place), applyMs (the field, main thread), swapMs (a chunk's mesh and collider), ...}
// world.seaLevel          the sea's height (shots end on it: the projectile mechanic's floor is y = 0)
//
// Generator version terrain.generator (1): the same seed and version give the same ground forever; edits replay on it.
import * as THREE from 'three';
import { CHUNK, editOf, isEdit } from './field.mjs';
import { generateTerrain, paramsOf, spawnsOn, seatSpawns } from './generate.mjs';
import { meshChunk, origOf } from './mesh.mjs';
import { createTerrainMaterial, MATERIAL_DEFAULTS } from './material.js';
import { createDebris } from './debris.js';
import { material } from '../../look/materials.js';
import { WORLD_GROUPS } from '../../core/util.js';
import { addScenery, propSlots } from '../scenery.js';
import { openSea } from '../islands.js';
import { placeFor } from './places.mjs';

export const templates = ['terrain'];

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
  if (cfg.scenery) out.push({ id: 'world.terrain.scenery', label: 'Scenery', group: 'world', type: 'json', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/scenery' }, description: 'Round the land: cloud cover and style, islands out at sea, and the set dressing that stands on the ground (a blast takes what it undercuts).' }, ...propSlots(cfg.scenery, catalog, licences));
  return out;
}

/** Start the mesh worker, or null where there is none (Node, an old browser): the meshes are then made here. */
function startWorker() {
  try { if (typeof Worker === 'undefined') return null; return new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' }); }
  catch (e) { console.warn(`gf-three terrain: no mesh worker (${e.message}); meshing on the main thread`); return null; }
}

export async function loadWorld(ctx, cfg) {
  const t0 = performance.now();
  const P = paramsOf(cfg.terrain ?? {});
  const gen = generateTerrain(P);
  const field = gen.field, top = gen.info.top;
  const genMs = Math.round(performance.now() - t0);
  const seaLevel = cfg.sea?.level ?? 0;
  const quality = ctx.quality?.name ?? ctx.quality ?? 'high';
  const root = new THREE.Group(); root.name = 'gf-terrain-world';
  ctx.scene?.add(root);

  // ---- the ground's paint: the house ground material, the top and soil pictures from their slots ----
  const M = { ...MATERIAL_DEFAULTS, ...(cfg.materials ?? {}) };
  if (M.cliff && !M.cliff.file && !M.cliff.color) M.cliff = null;
  const paint = createTerrainMaterial(M);
  const slotHas = id => { try { return !!ctx.assets?.has?.(id); } catch { return false; } };
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
    }
    if (!res.index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(res.normal, 3));
    g.setAttribute('aTer', new THREE.BufferAttribute(res.ter, 2));
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
      for (const c of all) takeChunk(c, meshChunk(field, c[0], c[1], c[2], { top, orig }));
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
    worker.postMessage({ type: 'init', meta: { size: field.size, cell: field.cell, origin: field.origin }, data: copy, top: top.slice() }, [copy.buffer]);
  }
  const everyChunk = () => { const out = []; for (let y = 0; y < field.cy; y++) for (let z = 0; z < field.cz; z++) for (let x = 0; x < field.cx; x++) out.push([x, y, z]); return out; };
  await run({ type: 'mesh' }, everyChunk());
  stats.swapMax = 0;                    // from here on: what an edit costs

  // ---- debris, edits ----
  const debrisOn = cfg.debris !== false;
  const debris = debrisOn ? createDebris(ctx, field, { color: M.soil?.color, top: M.top?.color, slot: slotHas('world.terrain.soil') ? 'world.terrain.soil' : 'world.terrain.shape', quality }) : null;
  if (debris) root.add(debris.mesh);
  const edits = [], listeners = [];
  const toMetres = e => ({ op: e[0] === 0 ? 'carve' : 'add', at: { x: e[1] / 100, y: e[2] / 100, z: e[3] / 100 }, r: e[4] / 100 });
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
    for (const fn of listeners.slice()) try { fn({ edit: e.slice(), ...m, normal }); } catch (err) { console.error(err); }
    return true;
  }
  async function reset() {
    const fresh = generateTerrain(P).field;
    field.d.set(fresh.d);
    edits.length = 0; stats.edits = 0;
    if (worker) return run({ type: 'reset', data: fresh.d });
    return run({ type: 'mesh' }, everyChunk());
  }

  // ---- the play area, spawns, zones ----
  const b = field.bounds;
  let peak = seaLevel; for (const t of top) if (t > peak) peak = t;
  const box = new THREE.Box3(new THREE.Vector3(b.min[0], seaLevel, b.min[2]), new THREE.Vector3(b.max[0], peak + 6, b.max[2]));
  box.half = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
  if (ctx.look?.fitShadows) ctx.look.fitShadows(new THREE.Box3(new THREE.Vector3(b.min[0], P.floor, b.min[2]), new THREE.Vector3(b.max[0], peak + 2, b.max[2])));
  ctx.look?.setLamps?.([]);
  const given = Array.isArray(cfg.spawns) ? cfg.spawns.map(s => ({ x: s[0], y: s[1], z: s[2] })) : null;
  const nSpawns = Number.isInteger(cfg.spawns) ? cfg.spawns : 8;
  // the level pads the generator cut (params pads.count) are the seats' places when it cut them
  const spawnList = given ?? (gen.info.pads?.length ? gen.info.pads : spawnsOn(field, nSpawns * 2, P.seed));
  if (!spawnList.length) spawnList.push({ x: 0, y: Math.max(seaLevel, field.heightAt(0, 0) ?? 0) + 0.05, z: 0 });
  const mid = gen.info.islands.length ? gen.info.islands.reduce((a, i) => (Math.hypot(i.x, i.z) < Math.hypot(a.x, a.z) ? i : a)) : { x: 0, z: 0, r: 10 };
  // seats in pairs that see each other, each facing its partner (friends in sight from the first second)
  const spawns = seatSpawns(field, spawnList, { count: given ? spawnList.length : nSpawns }).map(s => { const p = new THREE.Vector3(s.x, s.y, s.z); p.yaw = s.yaw; return p; });
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
    physics: body ? { world: phys, RAPIER, body } : null,
    track: { add: c => { liveColliders.push(c); colliderSet.add(c); }, remove: c => { colliderSet.delete(c); const i = liveColliders.indexOf(c); if (i >= 0) liveColliders.splice(i, 1); } },
  }) : null;

  const world = {
    template: 'terrain', layout: cfg, root, group: root, bounds: box, kind: 'outdoor', sizeClass: null, ceiling: null,
    rooms: [], doors: [], entries: [], lampPoints: [], props: scenery?.props ?? new Map(), catalog: { props: [] },
    seaLevel,
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
    place: where => placeFor({ field, seaLevel, spawns }, where),
    /** Where a body standing at (x, z) has its feet: the ground's top there, or the sea. */
    groundAt(x, z) { const y = field.heightAt(x, z); return y == null || y < seaLevel ? seaLevel : y; },
    update(dt) { debris?.update(dt); scenery?.update(dt); },
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
  ctx.world = world;
  return world;
}
